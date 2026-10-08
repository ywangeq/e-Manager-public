import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { closeSqliteDatabase, initializeSqliteDatabase } from "../sqlite-lifecycle.mjs";
import { acceptedConfirmationMatches } from "./tool-call-confirmation-acceptance.mjs";

function createSqliteToolCallConfirmationRepository({ databasePath, encryptionKey, now = () => Date.now() } = {}) {
  const file = requiredDatabasePath(databasePath);
  const key = exactKey(encryptionKey);
  if (file !== ":memory:") fs.mkdirSync(path.dirname(file), { recursive: true });
  const database = new DatabaseSync(file);
  initializeSqliteDatabase(database, initialize);

  function saveOrGet(record = {}) {
    const normalized = normalizeRecord(record);
    database.exec("BEGIN IMMEDIATE");
    try {
      pruneExpired(now());
      const existing = database.prepare("SELECT * FROM tool_call_confirmations WHERE fingerprint = ?").get(normalized.fingerprint);
      if (existing) {
        database.exec("COMMIT");
        return open(existing, key);
      }
      database.prepare(`INSERT INTO tool_call_confirmations
        (confirmation_id, fingerprint, context_binding, call_digest, expires_at_ms, ciphertext)
        VALUES (?, ?, ?, ?, ?, ?)`)
        .run(normalized.id, normalized.fingerprint, normalized.contextBinding, normalized.callDigest,
          normalized.expiresAtMs, seal(normalized, key, normalized.id));
      database.exec("COMMIT");
      return structuredClone(normalized);
    } catch (error) {
      rollback(database);
      throw error;
    }
  }

  function get(id = "") {
    const safeId = requiredText(id, "id");
    const row = database.prepare("SELECT * FROM tool_call_confirmations WHERE confirmation_id = ? AND expires_at_ms > ?")
      .get(safeId, now());
    return row ? open(row, key) : null;
  }

  function consume({ id = "", contextBinding = "", callDigest = "", executionInputBinding = "", taskId = "" } = {}) {
    const safeId = requiredText(id, "id");
    database.exec("BEGIN IMMEDIATE");
    try {
      const row = database.prepare("SELECT * FROM tool_call_confirmations WHERE confirmation_id = ?").get(safeId);
      if (!row || row.expires_at_ms <= now() || row.context_binding !== contextBinding || row.call_digest !== callDigest) {
        database.exec("COMMIT");
        return null;
      }
      const record = open(row, key);
      if (record.acceptance && !acceptedConfirmationMatches(record, { contextBinding, executionInputBinding, taskId })) {
        database.exec("COMMIT");
        return null;
      }
      database.prepare("DELETE FROM tool_call_confirmations WHERE confirmation_id = ?").run(safeId);
      database.exec("COMMIT");
      return record;
    } catch (error) {
      rollback(database);
      throw error;
    }
  }

  function listPending(contextBinding = "") {
    const binding = requiredText(contextBinding, "contextBinding");
    return database.prepare(`SELECT * FROM tool_call_confirmations
      WHERE context_binding = ? AND expires_at_ms > ? ORDER BY expires_at_ms ASC LIMIT 100`)
      .all(binding, now()).map((row) => open(row, key));
  }

  function accept({ id, contextBinding, requestBinding, acceptedAtMs, executeBeforeMs } = {}) {
    requiredText(requestBinding, "requestBinding");
    if (!Number.isSafeInteger(acceptedAtMs) || !Number.isSafeInteger(executeBeforeMs) || executeBeforeMs <= acceptedAtMs) throw new TypeError("invalid confirmation acceptance deadline");
    database.exec("BEGIN IMMEDIATE");
    try {
      const record = get(id);
      if (!record || record.contextBinding !== contextBinding) {
        database.exec("COMMIT");
        return null;
      }
      if (record.acceptance) {
        database.exec("COMMIT");
        return record.acceptance.requestBinding === requestBinding ? record : null;
      }
      if (record.expiresAtMs <= now() || record.executionInputBinding) {
        database.exec("COMMIT");
        return null;
      }
      record.acceptance = { requestBinding, acceptedAtMs, executeBeforeMs };
      // Older services must reject this internal record even before the original card expires.
      // Its public request keeps that original deadline; the accepted branch owns retention.
      record.expiresAtMs = 0;
      database.prepare("UPDATE tool_call_confirmations SET expires_at_ms = ?, ciphertext = ? WHERE confirmation_id = ?")
        .run(executeBeforeMs, seal(record, key, record.id), record.id);
      database.exec("COMMIT");
      return record;
    } catch (error) {
      rollback(database);
      throw error;
    }
  }

  function bindExecutionInput({ id, contextBinding, executionInputBinding, requestBinding = "" } = {}) {
    requiredText(executionInputBinding, "executionInputBinding");
    database.exec("BEGIN IMMEDIATE");
    try {
      const record = get(id);
      if (!record || record.contextBinding !== contextBinding || (record.acceptance && record.acceptance.requestBinding !== requestBinding) ||
        (record.executionInputBinding && record.executionInputBinding !== executionInputBinding)) {
        database.exec("COMMIT");
        return false;
      }
      record.executionInputBinding = executionInputBinding;
      database.prepare("UPDATE tool_call_confirmations SET ciphertext = ? WHERE confirmation_id = ?")
        .run(seal(record, key, record.id), record.id);
      database.exec("COMMIT");
      return true;
    } catch (error) {
      rollback(database);
      throw error;
    }
  }

  function bindExecutionTask({ id, contextBinding, executionInputBinding, taskId } = {}) {
    requiredText(taskId, "taskId");
    database.exec("BEGIN IMMEDIATE");
    try {
      const record = get(id);
      if (!record?.acceptance || record.contextBinding !== contextBinding || record.executionInputBinding !== executionInputBinding
        || (record.acceptance.taskId && record.acceptance.taskId !== taskId)) {
        database.exec("COMMIT");
        return false;
      }
      record.acceptance.taskId = taskId;
      database.prepare("UPDATE tool_call_confirmations SET ciphertext = ? WHERE confirmation_id = ?").run(seal(record, key, record.id), record.id);
      database.exec("COMMIT");
      return true;
    } catch (error) {
      rollback(database);
      throw error;
    }
  }

  function pruneExpired(at = now()) {
    return database.prepare("DELETE FROM tool_call_confirmations WHERE expires_at_ms <= ?").run(at).changes;
  }

  return Object.freeze({ accept, bindExecutionInput, bindExecutionTask, close: () => closeSqliteDatabase(database), consume, get, listPending, pruneExpired, saveOrGet });
}

function initialize(database) {
  database.exec(`
    PRAGMA busy_timeout = 5000;
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = FULL;
    CREATE TABLE IF NOT EXISTS tool_call_confirmations (
      confirmation_id TEXT PRIMARY KEY,
      fingerprint TEXT NOT NULL UNIQUE,
      context_binding TEXT NOT NULL,
      call_digest TEXT NOT NULL,
      expires_at_ms INTEGER NOT NULL,
      ciphertext TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS tool_call_confirmations_context_idx
      ON tool_call_confirmations (context_binding, expires_at_ms);
  `);
}

function normalizeRecord(value = {}) {
  const record = structuredClone(value);
  for (const field of ["id", "fingerprint", "contextBinding", "callDigest"]) requiredText(record[field], field);
  if (!Number.isSafeInteger(record.expiresAtMs) || record.expiresAtMs <= 0 || !record.request || !record.toolCall) {
    throw new TypeError("tool confirmation record is invalid");
  }
  return record;
}

function seal(value, key, authenticatedData) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(Buffer.from(authenticatedData));
  const data = Buffer.concat([cipher.update(JSON.stringify(value), "utf8"), cipher.final()]);
  return JSON.stringify({ alg: "aes-256-gcm", iv: iv.toString("base64"), tag: cipher.getAuthTag().toString("base64"), data: data.toString("base64") });
}

function open(row, key) {
  try {
    const envelope = JSON.parse(row.ciphertext);
    const decipher = crypto.createDecipheriv("aes-256-gcm", key, Buffer.from(envelope.iv, "base64"));
    decipher.setAAD(Buffer.from(row.confirmation_id));
    decipher.setAuthTag(Buffer.from(envelope.tag, "base64"));
    const record = JSON.parse(Buffer.concat([decipher.update(Buffer.from(envelope.data, "base64")), decipher.final()]).toString("utf8"));
    if (record.id !== row.confirmation_id || record.fingerprint !== row.fingerprint || record.contextBinding !== row.context_binding
      || record.callDigest !== row.call_digest || (record.acceptance?.executeBeforeMs ?? record.expiresAtMs) !== row.expires_at_ms) throw new Error("invalid confirmation index");
    return record;
  } catch {
    throw new Error("tool_confirmation_record_invalid");
  }
}

function exactKey(value) {
  if (!Buffer.isBuffer(value) || value.length !== 32) throw new TypeError("tool confirmation encryptionKey must be 32 bytes");
  return value;
}

function requiredDatabasePath(value) {
  const text = requiredText(value, "databasePath");
  if (text !== ":memory:" && !path.isAbsolute(text)) throw new TypeError("tool confirmation databasePath must be absolute");
  return text;
}

function requiredText(value, label) {
  const text = String(value || "").trim();
  if (!text) throw new TypeError(`tool confirmation ${label} is required`);
  return text;
}

function rollback(database) {
  try { database.exec("ROLLBACK"); } catch {}
}

export { createSqliteToolCallConfirmationRepository };
