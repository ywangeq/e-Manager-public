import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { closeSqliteDatabase, initializeSqliteDatabase } from "../sqlite-lifecycle.mjs";

const CONTRACT_VERSION = "runtime-task-actor-display-snapshot.v1";

export function createRuntimeTaskActorDisplaySnapshotRepository({ databasePath, encryptionKey } = {}) {
  const safeDatabasePath = requiredDatabasePath(databasePath);
  const key = normalizedEncryptionKey(encryptionKey);
  if (safeDatabasePath !== ":memory:") fs.mkdirSync(path.dirname(safeDatabasePath), { recursive: true });
  const database = new DatabaseSync(safeDatabasePath);
  initializeSqliteDatabase(database, db => db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = FULL;
    CREATE TABLE IF NOT EXISTS runtime_task_actor_display_snapshots (
      cache_key TEXT PRIMARY KEY,
      snapshot_ciphertext TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `));

  function get({ actorLocator, employeeId } = {}) {
    const cacheKey = snapshotKey({ actorLocator, employeeId, key });
    if (!cacheKey) return null;
    const row = database.prepare(`
      SELECT snapshot_ciphertext
      FROM runtime_task_actor_display_snapshots
      WHERE cache_key = ?
    `).get(cacheKey);
    return row ? decryptSnapshot(row.snapshot_ciphertext, cacheKey, key) : null;
  }

  function save({ actorLocator, displayName, employeeId, source = "" } = {}) {
    const cacheKey = snapshotKey({ actorLocator, employeeId, key });
    const snapshot = normalizeSnapshot({ displayName, source });
    if (!cacheKey || !snapshot) return false;
    const now = new Date().toISOString();
    database.prepare(`
      INSERT INTO runtime_task_actor_display_snapshots (cache_key, snapshot_ciphertext, created_at, updated_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(cache_key) DO UPDATE SET
        snapshot_ciphertext = excluded.snapshot_ciphertext,
        updated_at = excluded.updated_at
    `).run(cacheKey, encryptSnapshot(snapshot, cacheKey, key), now, now);
    return true;
  }

  return Object.freeze({
    adapterKind: "sqlite_encrypted_display_cache",
    close: () => closeSqliteDatabase(database),
    contractVersion: CONTRACT_VERSION,
    get,
    save,
  });
}

function snapshotKey({ actorLocator = null, employeeId = "", key } = {}) {
  const values = [
    employeeId,
    actorLocator?.identitySource,
    actorLocator?.subjectIdType,
    actorLocator?.subjectId,
  ].map((value) => String(value || "").trim());
  if (!values.every(Boolean)) return "";
  return crypto.createHmac("sha256", key).update(values.join("\0"), "utf8").digest("hex");
}

function normalizeSnapshot({ displayName, source } = {}) {
  const safeDisplayName = boundedText(displayName, 160);
  if (!safeDisplayName) return null;
  return Object.freeze({
    contractVersion: CONTRACT_VERSION,
    displayName: safeDisplayName,
    source: boundedText(source, 120),
  });
}

function encryptSnapshot(snapshot, cacheKey, key) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(Buffer.from(cacheKey, "utf8"));
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(snapshot), "utf8"), cipher.final()]);
  return JSON.stringify({ alg: "aes-256-gcm", data: ciphertext.toString("base64"), iv: iv.toString("base64"), tag: cipher.getAuthTag().toString("base64") });
}

function decryptSnapshot(value, cacheKey, key) {
  try {
    const envelope = JSON.parse(value);
    if (envelope?.alg !== "aes-256-gcm" || !envelope.data || !envelope.iv || !envelope.tag) return null;
    const decipher = crypto.createDecipheriv("aes-256-gcm", key, Buffer.from(envelope.iv, "base64"));
    decipher.setAAD(Buffer.from(cacheKey, "utf8"));
    decipher.setAuthTag(Buffer.from(envelope.tag, "base64"));
    const plaintext = Buffer.concat([decipher.update(Buffer.from(envelope.data, "base64")), decipher.final()]).toString("utf8");
    const snapshot = JSON.parse(plaintext);
    return snapshot?.contractVersion === CONTRACT_VERSION ? normalizeSnapshot(snapshot) : null;
  } catch {
    return null;
  }
}

function boundedText(value, maximum) {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  return text && text.length <= maximum && !/[\u0000-\u001F\u007F]/.test(text) ? text : "";
}

function normalizedEncryptionKey(value) {
  if (!Buffer.isBuffer(value) || value.length !== 32) throw new TypeError("runtime task actor display snapshot repository requires a 32-byte encryption key");
  return value;
}

function requiredDatabasePath(value) {
  const databasePath = String(value || "").trim();
  if (!databasePath || (databasePath !== ":memory:" && !path.isAbsolute(databasePath))) {
    throw new TypeError("runtime task actor display snapshot repository requires an absolute databasePath");
  }
  return path.normalize(databasePath);
}
