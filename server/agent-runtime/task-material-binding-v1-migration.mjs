import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { DatabaseSync } from "node:sqlite";
import { normalizeTaskMaterialBinding } from "./task-material-binding.mjs";

const V1_COLUMNS = Object.freeze([
  "task_id", "tenant_scope", "actor_issuer", "actor_subject_digest", "employee_id", "session_id", "channel_id",
  "adapter_id", "source_kind", "source_identity_digest", "created_at", "expires_at", "binding_digest", "binding_ciphertext",
]);

function migrateTaskMaterialBindingDatabaseV1ToV2({ backupPath, databasePath, encryptionKey } = {}) {
  const safeDatabasePath = requiredAbsolutePath(databasePath, "databasePath");
  const safeBackupPath = requiredAbsolutePath(backupPath, "backupPath");
  const key = normalizedEncryptionKey(encryptionKey);
  if (safeDatabasePath === safeBackupPath) throw new TypeError("backupPath must differ from databasePath");
  if (!fs.existsSync(safeDatabasePath)) throw new TypeError("task material binding database does not exist");
  if (fs.existsSync(safeBackupPath)) throw new TypeError("task material binding backup already exists");
  fs.mkdirSync(path.dirname(safeBackupPath), { recursive: true });
  const database = new DatabaseSync(safeDatabasePath);
  try {
    const version = readSchemaVersion(database);
    if (version !== 1) throw new TypeError(`task material binding migration requires schema v1; received v${version ?? "unknown"}`);
    assertV1Columns(database);
    createConsistentBackup(database, safeBackupPath);
    const bindings = database.prepare("SELECT * FROM task_material_bindings ORDER BY task_id ASC").all().map((row) => decryptV1Row(row, key));
    database.exec("BEGIN IMMEDIATE");
    try {
      database.exec(`
        CREATE TABLE task_material_bindings_v2 (
          task_id TEXT NOT NULL, descriptor_digest TEXT NOT NULL, tenant_scope TEXT NOT NULL,
          actor_issuer TEXT NOT NULL, actor_subject_digest TEXT NOT NULL, employee_id TEXT NOT NULL,
          session_id TEXT NOT NULL, channel_id TEXT NOT NULL, adapter_id TEXT NOT NULL, source_kind TEXT NOT NULL,
          source_identity_digest TEXT NOT NULL, created_at TEXT NOT NULL, expires_at TEXT NOT NULL,
          binding_digest TEXT NOT NULL, binding_ciphertext TEXT NOT NULL,
          PRIMARY KEY (task_id, descriptor_digest)
        );
      `);
      const insert = database.prepare(`
        INSERT INTO task_material_bindings_v2 (
          task_id, descriptor_digest, tenant_scope, actor_issuer, actor_subject_digest, employee_id,
          session_id, channel_id, adapter_id, source_kind, source_identity_digest,
          created_at, expires_at, binding_digest, binding_ciphertext
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      bindings.forEach((binding) => insert.run(
        binding.taskId, binding.descriptorDigest, binding.tenantScope, binding.actorIssuer, binding.actorSubjectDigest,
        binding.employeeId, binding.sessionId, binding.channelId, binding.adapterId, binding.sourceKind,
        binding.sourceIdentityDigest, binding.createdAt, binding.expiresAt, binding.bindingDigest,
        encryptJson(binding, key, v2Aad(binding)),
      ));
      const migratedRows = database.prepare("SELECT * FROM task_material_bindings_v2 ORDER BY task_id ASC, descriptor_digest ASC").all();
      if (migratedRows.length !== bindings.length || migratedRows.some((row, index) => !isDeepStrictEqual(decryptV2Row(row, key), bindings[index]))) {
        throw new TypeError("task material binding migration verification failed");
      }
      database.exec(`
        DROP INDEX IF EXISTS task_material_bindings_channel_source_idx;
        DROP INDEX IF EXISTS task_material_bindings_owner_idx;
        DROP INDEX IF EXISTS task_material_bindings_expiry_idx;
        DROP TABLE task_material_bindings;
        ALTER TABLE task_material_bindings_v2 RENAME TO task_material_bindings;
        UPDATE task_material_binding_schema SET version = 2 WHERE singleton = 1;
        CREATE UNIQUE INDEX task_material_bindings_channel_source_idx
          ON task_material_bindings (tenant_scope, adapter_id, source_identity_digest) WHERE source_kind = 'channel_resource';
        CREATE INDEX task_material_bindings_owner_idx
          ON task_material_bindings (tenant_scope, actor_issuer, actor_subject_digest, employee_id, session_id, channel_id, created_at DESC);
        CREATE INDEX task_material_bindings_expiry_idx ON task_material_bindings (expires_at);
      `);
      database.exec("COMMIT");
    } catch (error) {
      rollbackIfActive(database);
      throw error;
    }
    return Object.freeze({ backupCreated: true, migratedRecordCount: bindings.length, schemaVersion: 2 });
  } finally {
    database.close();
  }
}

function readSchemaVersion(database) {
  try { return database.prepare("SELECT version FROM task_material_binding_schema WHERE singleton = 1").get()?.version ?? null; } catch { return null; }
}

function assertV1Columns(database) {
  const columns = database.prepare("PRAGMA table_info(task_material_bindings)").all().map((column) => column.name);
  if (columns.length !== V1_COLUMNS.length || V1_COLUMNS.some((column) => !columns.includes(column))) {
    throw new TypeError("task material binding v1 table shape is unsupported");
  }
}

function createConsistentBackup(database, backupPath) {
  database.exec(`VACUUM INTO ${sqlString(backupPath)}`);
  const backup = new DatabaseSync(backupPath, { readOnly: true });
  try {
    if (readSchemaVersion(backup) !== 1) throw new TypeError("task material binding backup verification failed");
  } finally { backup.close(); }
}

function decryptV1Row(row, key) {
  const binding = decryptJson(row.binding_ciphertext, key, `task-material-binding.v1:${row.task_id}:${row.binding_digest}`);
  const normalized = normalizeTaskMaterialBinding(binding);
  assertRowMatchesBinding(row, normalized);
  return normalized;
}

function decryptV2Row(row, key) {
  const binding = decryptJson(row.binding_ciphertext, key, `task-material-binding-set.v1:${row.task_id}:${row.descriptor_digest}:${row.binding_digest}`);
  const normalized = normalizeTaskMaterialBinding(binding);
  if (normalized.descriptorDigest !== row.descriptor_digest) throw new TypeError("task material binding v2 descriptor mismatch");
  assertRowMatchesBinding(row, normalized);
  return normalized;
}

function assertRowMatchesBinding(row, binding) {
  const fields = Object.freeze({
    task_id: "taskId", tenant_scope: "tenantScope", actor_issuer: "actorIssuer", actor_subject_digest: "actorSubjectDigest",
    employee_id: "employeeId", session_id: "sessionId", channel_id: "channelId", adapter_id: "adapterId",
    source_kind: "sourceKind", source_identity_digest: "sourceIdentityDigest", created_at: "createdAt", expires_at: "expiresAt", binding_digest: "bindingDigest",
  });
  if (Object.entries(fields).some(([column, field]) => row[column] !== binding[field])) {
    throw new TypeError("task material binding encrypted and indexed fields differ");
  }
}

function encryptJson(value, key, aad) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(Buffer.from(aad, "utf8"));
  const data = Buffer.concat([cipher.update(JSON.stringify(value), "utf8"), cipher.final()]);
  return JSON.stringify({ alg: "aes-256-gcm", iv: iv.toString("base64"), tag: cipher.getAuthTag().toString("base64"), data: data.toString("base64") });
}

function decryptJson(value, key, aad) {
  try {
    const envelope = JSON.parse(value);
    if (envelope?.alg !== "aes-256-gcm" || !envelope.iv || !envelope.tag || !envelope.data) throw new TypeError("invalid binding envelope");
    const decipher = crypto.createDecipheriv("aes-256-gcm", key, Buffer.from(envelope.iv, "base64"));
    decipher.setAAD(Buffer.from(aad, "utf8"));
    decipher.setAuthTag(Buffer.from(envelope.tag, "base64"));
    return JSON.parse(Buffer.concat([decipher.update(Buffer.from(envelope.data, "base64")), decipher.final()]).toString("utf8"));
  } catch { throw new TypeError("task material binding decryption failed"); }
}

function v2Aad(binding) { return `task-material-binding-set.v1:${binding.taskId}:${binding.descriptorDigest}:${binding.bindingDigest}`; }

function normalizedEncryptionKey(value) {
  const key = Buffer.isBuffer(value) ? Buffer.from(value) : value instanceof Uint8Array ? Buffer.from(value) : null;
  if (!key || key.length !== 32) throw new TypeError("task material binding encryptionKey must contain exactly 32 bytes");
  return key;
}

function requiredAbsolutePath(value, label) {
  const candidate = String(value || "").trim();
  if (!candidate || !path.isAbsolute(candidate)) throw new TypeError(`${label} must be an absolute path`);
  return path.normalize(candidate);
}

function sqlString(value) { return `'${String(value).replaceAll("'", "''")}'`; }
function rollbackIfActive(database) { try { database.exec("ROLLBACK"); } catch {} }

export { migrateTaskMaterialBindingDatabaseV1ToV2 };
