import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  SESSION_FOUNDATION_STORE_CONTRACT,
  emptySessionFoundationRouteState,
  normalizeSessionFoundationRouteState,
} from "./session-foundation-store.mjs";

const SQLITE_SESSION_FOUNDATION_SCHEMA_VERSION = 3;
const ENCRYPTION_KEY_BYTES = 32;

function createSqliteSessionFoundationPersistence({ databasePath, encryptionKey } = {}) {
  const safeDatabasePath = requiredDatabasePath(databasePath);
  const key = normalizedEncryptionKey(encryptionKey);
  if (safeDatabasePath !== ":memory:") fs.mkdirSync(path.dirname(safeDatabasePath), { recursive: true });
  const database = new DatabaseSync(safeDatabasePath);
  try { initializeDatabase(database); } catch (error) {
    try { database.close(); } catch {}
    throw error;
  }

  function readRouteState(routeDigest) {
    const emptyState = emptySessionFoundationRouteState(routeDigest);
    const row = database.prepare(`
      SELECT revision, state_ciphertext
      FROM session_foundation_route_states
      WHERE route_digest = ?
    `).get(emptyState.routeDigest);
    if (!row) return emptyState;
    const state = normalizeSessionFoundationRouteState(
      decryptJson(row.state_ciphertext, key, routeStateAad(emptyState.routeDigest)),
      emptyState.routeDigest,
    );
    if (state.revision !== row.revision) throw new TypeError("session foundation SQLite revision integrity mismatch");
    return state;
  }

  function compareAndSwapRouteState(routeDigest, expectedRevision, nextState) {
    const emptyState = emptySessionFoundationRouteState(routeDigest);
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) return false;
    if (expectedRevision === Number.MAX_SAFE_INTEGER) {
      throw new TypeError("session foundation route state revision is exhausted");
    }
    const normalized = normalizeSessionFoundationRouteState(nextState, emptyState.routeDigest);
    if (normalized.revision !== expectedRevision) {
      throw new TypeError("session foundation route state revision must match expectedRevision");
    }
    const nextRevision = expectedRevision + 1;
    const storedState = { ...normalized, revision: nextRevision };
    const sessionIds = validatedSessionIds(storedState);

    database.exec("BEGIN IMMEDIATE");
    try {
      const current = database.prepare(`
        SELECT revision
        FROM session_foundation_route_states
        WHERE route_digest = ?
      `).get(emptyState.routeDigest);
      const currentRevision = current?.revision ?? 0;
      if (currentRevision !== expectedRevision) {
        database.exec("ROLLBACK");
        return false;
      }
      database.prepare(`
        INSERT INTO session_foundation_route_states (
          route_digest, revision, state_ciphertext, updated_at
        ) VALUES (?, ?, ?, ?)
        ON CONFLICT(route_digest) DO UPDATE SET
          revision = excluded.revision,
          state_ciphertext = excluded.state_ciphertext,
          updated_at = excluded.updated_at
      `).run(
        emptyState.routeDigest,
        nextRevision,
        encryptJson(storedState, key, routeStateAad(emptyState.routeDigest)),
        new Date().toISOString(),
      );
      const indexedSessions = database.prepare(`
        SELECT session_id
        FROM session_foundation_session_index
        WHERE route_digest = ?
      `).all(emptyState.routeDigest).map((item) => item.session_id);
      const nextSessionIds = new Set(sessionIds);
      const deleteSessionIndex = database.prepare(`
        DELETE FROM session_foundation_session_index
        WHERE session_id = ? AND route_digest = ?
      `);
      for (const sessionId of indexedSessions) {
        if (!nextSessionIds.has(sessionId)) deleteSessionIndex.run(sessionId, emptyState.routeDigest);
      }
      const insertSessionIndex = database.prepare(`
        INSERT INTO session_foundation_session_index (session_id, route_digest)
        VALUES (?, ?)
      `);
      const readSessionIndex = database.prepare(`
        SELECT route_digest
        FROM session_foundation_session_index
        WHERE session_id = ?
      `);
      for (const sessionId of sessionIds) {
        const indexed = readSessionIndex.get(sessionId);
        if (indexed && indexed.route_digest !== emptyState.routeDigest) {
          throw new TypeError("session foundation SQLite sessionId belongs to another route");
        }
        if (!indexed) insertSessionIndex.run(sessionId, emptyState.routeDigest);
      }
      database.exec("COMMIT");
      return true;
    } catch (error) {
      rollbackIfActive(database);
      throw error;
    }
  }

  function readSessionState(sessionId) {
    const safeSessionId = requiredText(sessionId, "sessionId");
    const index = database.prepare(`
      SELECT route_digest
      FROM session_foundation_session_index
      WHERE session_id = ?
    `).get(safeSessionId);
    if (!index) return null;
    const state = readRouteState(index.route_digest);
    const sessionRow = state.sessionRows[safeSessionId];
    if (!sessionRow) throw new TypeError("session foundation SQLite session index integrity mismatch");
    return structuredClone({
      routeDigest: state.routeDigest,
      routeRevision: state.revision,
      sessionRow,
      transcriptEntries: state.transcriptEntries[safeSessionId] || [],
    });
  }

  function readCheckpoint(sessionId) {
    const safeSessionId = requiredText(sessionId, "checkpoint sessionId");
    const row = database.prepare(`
      SELECT checkpoint_ciphertext
      FROM session_foundation_compaction_checkpoints
      WHERE session_id = ?
    `).get(safeSessionId);
    if (!row) return null;
    return decryptJson(row.checkpoint_ciphertext, key, checkpointAad(safeSessionId));
  }

  function compareAndSwapCheckpoint(sessionId, expectedRevision, nextCheckpoint) {
    const safeSessionId = requiredText(sessionId, "checkpoint sessionId");
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) return false;
    const checkpoint = normalizeCheckpoint(nextCheckpoint, safeSessionId, expectedRevision + 1);
    database.exec("BEGIN IMMEDIATE");
    try {
      const sessionIndex = database.prepare(`
        SELECT route_digest
        FROM session_foundation_session_index
        WHERE session_id = ?
      `).get(safeSessionId);
      if (!sessionIndex) throw new TypeError("compaction checkpoint session does not exist");
      if (checkpoint.routeDigest !== sessionIndex.route_digest) {
        throw new TypeError("compaction checkpoint routeDigest mismatch");
      }
      const current = database.prepare(`
        SELECT revision
        FROM session_foundation_compaction_checkpoints
        WHERE session_id = ?
      `).get(safeSessionId);
      if ((current?.revision ?? 0) !== expectedRevision) {
        database.exec("ROLLBACK");
        return false;
      }
      database.prepare(`
        INSERT INTO session_foundation_compaction_checkpoints (
          session_id, route_digest, revision, checkpoint_ciphertext, updated_at
        ) VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(session_id) DO UPDATE SET
          route_digest = excluded.route_digest,
          revision = excluded.revision,
          checkpoint_ciphertext = excluded.checkpoint_ciphertext,
          updated_at = excluded.updated_at
      `).run(
        safeSessionId,
        checkpoint.routeDigest,
        checkpoint.revision,
        encryptJson(checkpoint, key, checkpointAad(safeSessionId)),
        new Date().toISOString(),
      );
      database.exec("COMMIT");
      return true;
    } catch (error) {
      rollbackIfActive(database);
      throw error;
    }
  }

  function deleteCheckpoint(sessionId) {
    const safeSessionId = requiredText(sessionId, "checkpoint sessionId");
    return database.prepare(`
      DELETE FROM session_foundation_compaction_checkpoints
      WHERE session_id = ?
    `).run(safeSessionId).changes > 0;
  }

  // Immutable execution instructions share Session's encryption and retention boundary,
  // but never enter the conversation transcript or compaction context.
  const instructionStore = Object.freeze({
    digest: content => crypto.createHmac("sha256", key).update("execution-instruction.v1\0").update(content).digest("hex"),
    read({refId, sessionId, routeDigest}) {
      const row = database.prepare("SELECT content_ciphertext FROM session_execution_instructions WHERE ref_id=? AND session_id=? AND route_digest=?").get(refId,sessionId,routeDigest);
      return row ? decryptJson(row.content_ciphertext,key,`execution-instruction.v1:${refId}:${sessionId}:${routeDigest}`) : null;
    },
    save({refId, sessionId, routeDigest, content}) {
      if (!/^[a-zA-Z0-9_:-]{1,160}$/.test(refId) || typeof content !== "string" || !content.trim() || content.length > 8000) throw new TypeError("execution instruction invalid");
      const session = readSessionState(sessionId);
      if (!session || session.routeDigest !== routeDigest) throw new TypeError("execution instruction session mismatch");
      database.prepare("INSERT INTO session_execution_instructions(ref_id,session_id,route_digest,content_ciphertext) VALUES(?,?,?,?) ON CONFLICT(ref_id) DO NOTHING")
        .run(refId,sessionId,routeDigest,encryptJson(content,key,`execution-instruction.v1:${refId}:${sessionId}:${routeDigest}`));
      if (this.read({refId,sessionId,routeDigest}) !== content) throw Object.assign(new Error("personal_automation_idempotency_conflict"),{code:"personal_automation_idempotency_conflict"});
      return {refId,digest:this.digest(content)};
    },
  });

  const foundationStore = Object.freeze({
    adapterKind: "sqlite_durable",
    compareAndSwapRouteState,
    contractVersion: SESSION_FOUNDATION_STORE_CONTRACT,
    deploymentScope: "single_center",
    distributedCoordination: false,
    productionReady: true,
    readRouteState,
    readSessionState,
  });
  const checkpointStore = Object.freeze({
    adapterKind: "sqlite_durable",
    compareAndSwapCheckpoint,
    contractVersion: "compaction-checkpoint-store.v1",
    deleteCheckpoint,
    deploymentScope: "single_center",
    productionReady: true,
    readCheckpoint,
  });
  return {
    checkpointStore,
    instructionStore,
    close: () => database.close(),
    foundationStore,
    schemaVersion: SQLITE_SESSION_FOUNDATION_SCHEMA_VERSION,
  };
}

function initializeDatabase(database) {
  const exists = database.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='session_foundation_schema'").get();
  const previous = exists ? database.prepare("SELECT version FROM session_foundation_schema WHERE singleton=1").get()?.version : null;
  if (exists && ![1,2,3].includes(previous)) {
    database.close();
    throw new TypeError("session foundation SQLite schema version is unsupported");
  }
  if (previous === 3) {
    const columns = database.prepare("PRAGMA table_info(session_execution_instructions)").all().map(c => c.name);
    const foreignKeys = database.prepare("PRAGMA foreign_key_list(session_execution_instructions)").all();
    if (columns.join(",") !== "ref_id,session_id,route_digest,content_ciphertext" || foreignKeys.length !== 2 || foreignKeys.some(k => k.on_delete !== "CASCADE") ||
      !foreignKeys.some(k => k.from === "session_id" && k.table === "session_foundation_session_index" && k.to === "session_id") ||
      !foreignKeys.some(k => k.from === "route_digest" && k.table === "session_foundation_route_states" && k.to === "route_digest")) {
      database.close();
      throw new TypeError("session instruction schema is invalid");
    }
  }
  database.exec(`
    PRAGMA foreign_keys = ON;
    PRAGMA busy_timeout = 5000;
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = FULL;
    BEGIN IMMEDIATE;
    CREATE TABLE IF NOT EXISTS session_foundation_schema (
      singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
      version INTEGER NOT NULL
    );
    INSERT INTO session_foundation_schema (singleton, version)
    VALUES (1, ${SQLITE_SESSION_FOUNDATION_SCHEMA_VERSION})
    ON CONFLICT(singleton) DO NOTHING;
    CREATE TABLE IF NOT EXISTS session_foundation_route_states (
      route_digest TEXT PRIMARY KEY,
      revision INTEGER NOT NULL CHECK (revision >= 0),
      state_ciphertext TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS session_foundation_session_index (
      session_id TEXT PRIMARY KEY,
      route_digest TEXT NOT NULL REFERENCES session_foundation_route_states(route_digest) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS session_foundation_session_route_idx
      ON session_foundation_session_index(route_digest);
    CREATE TABLE IF NOT EXISTS session_foundation_compaction_checkpoints (
      session_id TEXT PRIMARY KEY REFERENCES session_foundation_session_index(session_id) ON DELETE CASCADE,
      route_digest TEXT NOT NULL REFERENCES session_foundation_route_states(route_digest) ON DELETE CASCADE,
      revision INTEGER NOT NULL CHECK (revision > 0),
      checkpoint_ciphertext TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS session_execution_instructions (
      ref_id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL REFERENCES session_foundation_session_index(session_id) ON DELETE CASCADE,
      route_digest TEXT NOT NULL REFERENCES session_foundation_route_states(route_digest) ON DELETE CASCADE,
      content_ciphertext TEXT NOT NULL
    );
    UPDATE session_foundation_schema
    SET version = ${SQLITE_SESSION_FOUNDATION_SCHEMA_VERSION}
    WHERE singleton = 1 AND version IN (1, 2);
    COMMIT;
  `);
  const schema = database.prepare("SELECT version FROM session_foundation_schema WHERE singleton = 1").get();
  if (schema?.version !== SQLITE_SESSION_FOUNDATION_SCHEMA_VERSION) {
    database.close();
    throw new TypeError("session foundation SQLite schema version is unsupported");
  }
}

function validatedSessionIds(state) {
  const sessionIds = Object.keys(state.sessionRows).map((value) => requiredText(value, "sessionId"));
  for (const [sessionId, row] of Object.entries(state.sessionRows)) {
    if (row?.sessionId !== sessionId || row?.routeDigest !== state.routeDigest) {
      throw new TypeError("session foundation route state contains a mismatched session row");
    }
  }
  for (const [sessionId, entries] of Object.entries(state.transcriptEntries)) {
    if (!Object.hasOwn(state.sessionRows, sessionId) || !Array.isArray(entries)) {
      throw new TypeError("session foundation route state contains invalid transcript entries");
    }
  }
  return sessionIds;
}

function normalizeCheckpoint(value, sessionId, expectedRevision) {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
    value.contractVersion !== "compaction-checkpoint.v1") {
    throw new TypeError("compaction checkpoint contract is invalid");
  }
  if (value.sessionId !== sessionId || value.revision !== expectedRevision ||
    !/^[a-f0-9]{64}$/.test(String(value.routeDigest || ""))) {
    throw new TypeError("compaction checkpoint identity or revision is invalid");
  }
  return structuredClone(value);
}

function encryptJson(value, key, aad) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(Buffer.from(aad, "utf8"));
  const data = Buffer.concat([cipher.update(JSON.stringify(value), "utf8"), cipher.final()]);
  return JSON.stringify({
    alg: "aes-256-gcm",
    iv: iv.toString("base64"),
    tag: cipher.getAuthTag().toString("base64"),
    data: data.toString("base64"),
  });
}

function decryptJson(value, key, aad) {
  try {
    const encrypted = JSON.parse(String(value || ""));
    if (encrypted.alg !== "aes-256-gcm") throw new Error("unsupported cipher");
    const decipher = crypto.createDecipheriv("aes-256-gcm", key, Buffer.from(encrypted.iv, "base64"));
    decipher.setAAD(Buffer.from(aad, "utf8"));
    decipher.setAuthTag(Buffer.from(encrypted.tag, "base64"));
    return JSON.parse(Buffer.concat([
      decipher.update(Buffer.from(encrypted.data, "base64")),
      decipher.final(),
    ]).toString("utf8"));
  } catch {
    throw new TypeError("session foundation SQLite ciphertext integrity check failed");
  }
}

function routeStateAad(routeDigest) {
  return `session-foundation-route-state.v1\0${routeDigest}`;
}

function checkpointAad(sessionId) {
  return `compaction-checkpoint.v1\0${sessionId}`;
}

function normalizedEncryptionKey(value) {
  if (!Buffer.isBuffer(value)) throw new TypeError("session foundation encryptionKey must be a Buffer");
  if (value.length !== ENCRYPTION_KEY_BYTES) {
    throw new TypeError(`session foundation encryptionKey must be exactly ${ENCRYPTION_KEY_BYTES} bytes`);
  }
  return Buffer.from(value);
}

function requiredDatabasePath(value) {
  const databasePath = String(value || "").trim();
  if (!databasePath) throw new TypeError("session foundation SQLite databasePath is required");
  return databasePath;
}

function requiredText(value, field) {
  const text = String(value ?? "").trim();
  if (!text || /[\u0000-\u001f\u007f]/.test(text)) throw new TypeError(`session foundation requires ${field}`);
  return text;
}

function rollbackIfActive(database) {
  try {
    database.exec("ROLLBACK");
  } catch {
    // The failing statement may already have ended the transaction.
  }
}

export {
  SQLITE_SESSION_FOUNDATION_SCHEMA_VERSION,
  createSqliteSessionFoundationPersistence,
};
