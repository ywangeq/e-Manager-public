import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { DatabaseSync } from "node:sqlite";
import { closeSqliteDatabase, initializeSqliteDatabase } from "../sqlite-lifecycle.mjs";

const EXECUTION_ADMISSION_CONTRACT_VERSION = "execution-admission.v1";
const REFERENCE_EXECUTION_ADMISSION_CONTRACT_VERSION = "execution-admission.v2";
const EXECUTION_ADMISSION_REPOSITORY_CONTRACT_VERSION = "execution-admission-repository.v1";
const DEFAULT_MAX_TTL_MS = 24 * 60 * 60 * 1000;
const TOP_LEVEL_FIELDS = new Set([
  "actorLocator",
  "channelId",
  "contractVersion",
  "createdAt",
  "employeeVersion",
  "expiresAt",
  "permissionDigest",
  "routeBinding",
  "taskId",
]);
const REFERENCE_TOP_LEVEL_FIELDS = new Set([...TOP_LEVEL_FIELDS].filter(field => field !== "routeBinding").concat("taskBinding"));
const TASK_BINDING_FIELDS = new Set(["tenantScope", "actorIssuer", "actorSubjectDigest", "employeeId", "sourceSystemId", "taskType", "submissionScope", "idempotencyKey", "inputDigest", "executionInputRef"]);
const ACTOR_LOCATOR_FIELDS = new Set(["conversationId", "conversationType", "identitySource", "subjectId", "subjectIdType"]);
const ROUTE_BINDING_FIELDS = new Set([
  "actorIssuer",
  "actorSubjectDigest",
  "employeeId",
  "entryId",
  "routeDigest",
  "sessionId",
  "tenantScope",
]);
const FORBIDDEN_FIELD_PATTERN = /(?:authorization|bearer|cookie|credential|message|password|path|prompt|provider|raw|secret|tool|token)/i;
const SECRET_VALUE_PATTERN = /^(?:bearer[\s._:-]*|sk-|rk-|xox[baprs]-|gh[pousr]_|glpat-|ya29\.|eyJ)[A-Za-z0-9._~+\/-]{8,}$/i;
const HOST_PATH_PATTERN = /^(?:\/|~[\\/]|[A-Za-z]:[\\/]|\\\\)/;

function createSqliteExecutionAdmissionRepository({
  databasePath,
  encryptionKey,
  maxTtlMs = DEFAULT_MAX_TTL_MS,
} = {}) {
  const safeDatabasePath = requiredDatabasePath(databasePath);
  const key = normalizedEncryptionKey(encryptionKey);
  const safeMaxTtlMs = positiveSafeInteger(maxTtlMs, "maxTtlMs");
  if (safeDatabasePath !== ":memory:") fs.mkdirSync(path.dirname(safeDatabasePath), { recursive: true });
  const database = new DatabaseSync(safeDatabasePath);
  initializeSqliteDatabase(database, initializeDatabase);

  function saveOrGet(value, { now = new Date() } = {}) {
    const nowIso = normalizedNow(now);
    const admission = normalizeExecutionAdmission(value, { maxTtlMs: safeMaxTtlMs, now: nowIso });
    database.exec("BEGIN IMMEDIATE");
    try {
      const existingRow = readRow(admission.taskId);
      if (existingRow) {
        const existing = decryptStoredAdmission(existingRow, key, safeMaxTtlMs);
        if (!isDeepStrictEqual(existing, admission)) {
          throw admissionError(
            "execution_admission_idempotency_conflict",
            "taskId already has a different immutable execution admission",
          );
        }
        database.exec("COMMIT");
        return Object.freeze({ admission: deepFreeze(structuredClone(existing)), created: false });
      }
      database.prepare(`
        INSERT INTO execution_admissions (task_id, expires_at, admission_ciphertext)
        VALUES (?, ?, ?)
      `).run(
        admission.taskId,
        admission.expiresAt,
        encryptJson(admission, key, admissionAad(admission.taskId)),
      );
      database.exec("COMMIT");
      return Object.freeze({ admission: deepFreeze(structuredClone(admission)), created: true });
    } catch (error) {
      rollbackIfActive(database);
      throw error;
    }
  }

  function get(taskId, { now = new Date() } = {}) {
    const safeTaskId = requiredToken(taskId, "taskId", 128);
    const nowIso = normalizedNow(now);
    const row = readRow(safeTaskId);
    if (!row) return null;
    if (row.expires_at <= nowIso) {
      database.prepare("DELETE FROM execution_admissions WHERE task_id = ?").run(safeTaskId);
      return null;
    }
    const admission = decryptStoredAdmission(row, key, safeMaxTtlMs);
    if (admission.expiresAt <= nowIso) {
      database.prepare("DELETE FROM execution_admissions WHERE task_id = ?").run(safeTaskId);
      return null;
    }
    return deepFreeze(structuredClone(admission));
  }

  function deleteAdmission(taskId) {
    const safeTaskId = requiredToken(taskId, "taskId", 128);
    return database.prepare("DELETE FROM execution_admissions WHERE task_id = ?").run(safeTaskId).changes > 0;
  }

  function purgeExpired({ now = new Date() } = {}) {
    return database.prepare("DELETE FROM execution_admissions WHERE expires_at <= ?")
      .run(normalizedNow(now)).changes;
  }

  function readRow(taskId) {
    return database.prepare(`
      SELECT task_id, expires_at, admission_ciphertext
      FROM execution_admissions
      WHERE task_id = ?
    `).get(taskId);
  }

  return Object.freeze({
    adapterKind: "sqlite_encrypted_durable",
    close: () => closeSqliteDatabase(database),
    contractVersion: EXECUTION_ADMISSION_REPOSITORY_CONTRACT_VERSION,
    delete: deleteAdmission,
    deploymentScope: "single_center",
    distributedCoordination: false,
    get,
    purgeExpired,
    saveOrGet,
  });
}

function normalizeExecutionAdmission(value, { maxTtlMs = DEFAULT_MAX_TTL_MS, now = null } = {}) {
  requirePlainObject(value, "execution admission");
  const referenceTask = value.contractVersion === REFERENCE_EXECUTION_ADMISSION_CONTRACT_VERSION;
  rejectForbiddenOrUnknownFields(value, referenceTask ? REFERENCE_TOP_LEVEL_FIELDS : TOP_LEVEL_FIELDS, "execution admission");
  if (!referenceTask && value.contractVersion !== EXECUTION_ADMISSION_CONTRACT_VERSION) {
    throw admissionError("execution_admission_contract_invalid", "execution admission contractVersion is invalid");
  }
  const createdAt = requiredTimestamp(value.createdAt, "createdAt");
  const expiresAt = requiredTimestamp(value.expiresAt, "expiresAt");
  if (Date.parse(expiresAt) <= Date.parse(createdAt)) {
    throw admissionError("execution_admission_ttl_invalid", "execution admission expiresAt must be after createdAt");
  }
  if (Date.parse(expiresAt) - Date.parse(createdAt) > positiveSafeInteger(maxTtlMs, "maxTtlMs")) {
    throw admissionError("execution_admission_ttl_invalid", "execution admission TTL exceeds the configured maximum");
  }
  if (now !== null && expiresAt <= normalizedNow(now)) {
    throw admissionError("execution_admission_expired", "execution admission is already expired");
  }
  return deepFreeze({
    contractVersion: value.contractVersion,
    taskId: requiredToken(value.taskId, "taskId", 128),
    actorLocator: normalizeActorLocator(value.actorLocator),
    ...(referenceTask ? { taskBinding: normalizeTaskBinding(value.taskBinding) } : { routeBinding: normalizeRouteBinding(value.routeBinding) }),
    employeeVersion: requiredToken(value.employeeVersion, "employeeVersion", 80),
    channelId: requiredToken(value.channelId, "channelId", 120),
    permissionDigest: requiredDigest(value.permissionDigest, "permissionDigest"),
    createdAt,
    expiresAt,
  });
}

function normalizeActorLocator(value) {
  requirePlainObject(value, "actorLocator");
  rejectForbiddenOrUnknownFields(value, ACTOR_LOCATOR_FIELDS, "actorLocator");
  const normalized = {
    identitySource: requiredToken(value.identitySource, "actorLocator.identitySource", 120),
    subjectId: requiredActorIdentifier(value.subjectId, "actorLocator.subjectId", 240),
    subjectIdType: requiredToken(value.subjectIdType, "actorLocator.subjectIdType", 80),
  };
  if (value.conversationId !== undefined) {
    normalized.conversationId = requiredActorIdentifier(value.conversationId, "actorLocator.conversationId", 240);
  }
  if (value.conversationType !== undefined) {
    normalized.conversationType = requiredToken(value.conversationType, "actorLocator.conversationType", 80);
  }
  return deepFreeze(normalized);
}

function normalizeRouteBinding(value) {
  requirePlainObject(value, "routeBinding");
  rejectForbiddenOrUnknownFields(value, ROUTE_BINDING_FIELDS, "routeBinding");
  return deepFreeze({
    tenantScope: requiredToken(value.tenantScope, "routeBinding.tenantScope", 160),
    routeDigest: requiredDigest(value.routeDigest, "routeBinding.routeDigest"),
    actorIssuer: requiredToken(value.actorIssuer, "routeBinding.actorIssuer", 120),
    actorSubjectDigest: requiredDigest(value.actorSubjectDigest, "routeBinding.actorSubjectDigest"),
    employeeId: requiredToken(value.employeeId, "routeBinding.employeeId", 160),
    sessionId: requiredToken(value.sessionId, "routeBinding.sessionId", 160),
    entryId: requiredToken(value.entryId, "routeBinding.entryId", 240),
  });
}

// Reference tasks share the encrypted admission authority without borrowing a
// transcript session. v1 routeBinding remains strict and unchanged.
function normalizeTaskBinding(value) {
  requirePlainObject(value, "taskBinding");
  rejectForbiddenOrUnknownFields(value, TASK_BINDING_FIELDS, "taskBinding");
  requirePlainObject(value.executionInputRef, "executionInputRef");
  rejectForbiddenOrUnknownFields(value.executionInputRef, new Set(["kind", "refId"]), "executionInputRef");
  if (!["artifact_ref", "transcript_entry"].includes(value.executionInputRef.kind)) {
    throw admissionError("execution_admission_reference_invalid", "execution input kind invalid");
  }
  return deepFreeze({
    tenantScope: requiredToken(value.tenantScope, "taskBinding.tenantScope", 160),
    actorIssuer: requiredToken(value.actorIssuer, "taskBinding.actorIssuer", 160),
    actorSubjectDigest: requiredDigest(value.actorSubjectDigest, "taskBinding.actorSubjectDigest"),
    employeeId: requiredToken(value.employeeId, "taskBinding.employeeId", 160),
    sourceSystemId: requiredToken(value.sourceSystemId, "taskBinding.sourceSystemId", 120),
    taskType: requiredToken(value.taskType, "taskBinding.taskType", 120),
    submissionScope: requiredToken(value.submissionScope, "taskBinding.submissionScope", 240),
    idempotencyKey: requiredToken(value.idempotencyKey, "taskBinding.idempotencyKey", 240),
    inputDigest: requiredDigest(value.inputDigest, "taskBinding.inputDigest"),
    executionInputRef: {
      kind: value.executionInputRef.kind,
      refId: requiredToken(value.executionInputRef.refId, "executionInputRef.refId", 240),
    },
  });
}

function initializeDatabase(database) {
  database.exec(`
    PRAGMA foreign_keys = ON;
    PRAGMA busy_timeout = 5000;
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = FULL;
    CREATE TABLE IF NOT EXISTS execution_admission_schema (
      singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
      version INTEGER NOT NULL
    );
    INSERT INTO execution_admission_schema (singleton, version)
    VALUES (1, 1)
    ON CONFLICT(singleton) DO NOTHING;
    CREATE TABLE IF NOT EXISTS execution_admissions (
      task_id TEXT PRIMARY KEY,
      expires_at TEXT NOT NULL,
      admission_ciphertext TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS execution_admissions_expires_at_idx
      ON execution_admissions (expires_at);
  `);
  const schema = database.prepare("SELECT version FROM execution_admission_schema WHERE singleton = 1").get();
  if (schema?.version !== 1) throw new TypeError("unsupported execution admission SQLite schema version");
}

function encryptJson(value, key, aad) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(Buffer.from(aad, "utf8"));
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(value), "utf8"), cipher.final()]);
  return JSON.stringify({
    alg: "aes-256-gcm",
    iv: iv.toString("base64"),
    tag: cipher.getAuthTag().toString("base64"),
    data: ciphertext.toString("base64"),
  });
}

function decryptStoredAdmission(row, key, maxTtlMs) {
  try {
    const envelope = JSON.parse(row.admission_ciphertext);
    if (envelope?.alg !== "aes-256-gcm" || !envelope.iv || !envelope.tag || !envelope.data) {
      throw new TypeError("invalid encrypted admission envelope");
    }
    const decipher = crypto.createDecipheriv("aes-256-gcm", key, Buffer.from(envelope.iv, "base64"));
    decipher.setAAD(Buffer.from(admissionAad(row.task_id), "utf8"));
    decipher.setAuthTag(Buffer.from(envelope.tag, "base64"));
    const plaintext = Buffer.concat([
      decipher.update(Buffer.from(envelope.data, "base64")),
      decipher.final(),
    ]).toString("utf8");
    const admission = normalizeExecutionAdmission(JSON.parse(plaintext), { maxTtlMs });
    if (admission.taskId !== row.task_id || admission.expiresAt !== row.expires_at) {
      throw new TypeError("execution admission row binding mismatch");
    }
    return admission;
  } catch (error) {
    if (error?.code?.startsWith?.("execution_admission_")) throw error;
    throw admissionError("execution_admission_decryption_failed", "execution admission ciphertext could not be authenticated");
  }
}

function rejectForbiddenOrUnknownFields(value, allowedFields, label) {
  const fields = Object.keys(value);
  const forbidden = fields.find((field) => FORBIDDEN_FIELD_PATTERN.test(field));
  if (forbidden) {
    throw admissionError("execution_admission_sensitive_field_forbidden", `${label} contains forbidden field: ${forbidden}`);
  }
  const unknown = fields.find((field) => !allowedFields.has(field));
  if (unknown) {
    throw admissionError("execution_admission_unknown_field", `${label} contains unsupported field: ${unknown}`);
  }
}

function requiredActorIdentifier(value, field, maxLength) {
  const text = String(value ?? "").trim();
  if (!text || text.length > maxLength || !/^[A-Za-z0-9][A-Za-z0-9@._:+-]*$/.test(text)) {
    throw admissionError("execution_admission_actor_locator_invalid", `${field} must be a bounded actor identifier`);
  }
  rejectSensitiveValue(text, field);
  return text;
}

function requiredToken(value, field, maxLength) {
  const text = String(value ?? "").trim();
  if (!text || text.length > maxLength || !/^[A-Za-z0-9][A-Za-z0-9._:@-]*$/.test(text)) {
    throw admissionError("execution_admission_reference_invalid", `${field} must be a bounded opaque reference`);
  }
  rejectSensitiveValue(text, field);
  return text;
}

function requiredDigest(value, field) {
  const text = String(value ?? "").trim().toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(text)) {
    throw admissionError("execution_admission_digest_invalid", `${field} must be a SHA-256 digest`);
  }
  return text;
}

function rejectSensitiveValue(value, field) {
  if (HOST_PATH_PATTERN.test(value) || SECRET_VALUE_PATTERN.test(value)) {
    throw admissionError("execution_admission_sensitive_value_forbidden", `${field} contains a credential or host path`);
  }
}

function requiredTimestamp(value, field) {
  const timestamp = new Date(value);
  if (!value || !Number.isFinite(timestamp.getTime())) {
    throw admissionError("execution_admission_timestamp_invalid", `${field} must be an ISO timestamp`);
  }
  return timestamp.toISOString();
}

function normalizedNow(value) {
  const timestamp = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(timestamp.getTime())) throw new TypeError("execution admission clock is invalid");
  return timestamp.toISOString();
}

function normalizedEncryptionKey(value) {
  const key = Buffer.isBuffer(value) ? Buffer.from(value) : value instanceof Uint8Array ? Buffer.from(value) : null;
  if (!key || key.length !== 32) throw new TypeError("execution admission encryptionKey must contain exactly 32 bytes");
  return key;
}

function requiredDatabasePath(value) {
  const text = String(value || "").trim();
  if (text === ":memory:") return text;
  if (!text || !path.isAbsolute(text)) throw new TypeError("execution admission databasePath must be absolute or :memory:");
  return path.normalize(text);
}

function positiveSafeInteger(value, field) {
  if (!Number.isSafeInteger(value) || value <= 0) throw new TypeError(`${field} must be a positive safe integer`);
  return value;
}

function requirePlainObject(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
    (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)) {
    throw admissionError("execution_admission_contract_invalid", `${label} must be an object`);
  }
}

function admissionAad(taskId) {
  return `${EXECUTION_ADMISSION_CONTRACT_VERSION}\0${taskId}`;
}

function admissionError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function rollbackIfActive(database) {
  if (database.isTransaction) database.exec("ROLLBACK");
}

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  Object.values(value).forEach(deepFreeze);
  return Object.freeze(value);
}

export {
  DEFAULT_MAX_TTL_MS,
  EXECUTION_ADMISSION_CONTRACT_VERSION,
  REFERENCE_EXECUTION_ADMISSION_CONTRACT_VERSION,
  EXECUTION_ADMISSION_REPOSITORY_CONTRACT_VERSION,
  createSqliteExecutionAdmissionRepository,
  normalizeExecutionAdmission,
};
