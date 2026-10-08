import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { DatabaseSync } from "node:sqlite";

const TRIGGER_REVIEW_RESULT_CONTRACT_VERSION = "trigger-review-result.v1";
const TRIGGER_REVIEW_RESULT_EVIDENCE_CONTRACT_VERSION = "trigger-review-result-evidence.v1";
const TRIGGER_REVIEW_RESULT_REPOSITORY_CONTRACT_VERSION = "trigger-review-result-repository.v1";
const RESULT_FIELDS = new Set([
  "contractVersion",
  "reviewComment",
  "result",
  "taskId",
  "tenantScope",
  "triggerEventId",
]);
const READ_FIELDS = new Set(["taskId", "tenantScope", "triggerEventId"]);
const FORBIDDEN_RESULT_FIELD = /(?:auth|bearer|credential|message|model|password|prompt|raw|reasoning|secret|token|tool|trace)/i;
const SECRET_VALUE = /(?:bearer\s+|sk-|rk-|xox[baprs]-|gh[pousr]_|glpat-|ya29\.|eyJ)[A-Za-z0-9._~+\/-]{8,}|-----BEGIN [A-Z ]*PRIVATE KEY-----/i;
const TOKEN = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,239}$/;
const DIGEST = /^[a-f0-9]{64}$/;
const MAX_RESULT_BYTES = 256 * 1024;
const MAX_COMMENT_BYTES = 32 * 1024;

function createSqliteTriggerReviewResultRepository({
  databasePath,
  encryptionKey,
  encryptionKeyId = "trigger-review-result-key-v1",
  integrityHmacKey,
  now = () => new Date(),
} = {}) {
  const safeDatabasePath = requiredDatabasePath(databasePath);
  const safeEncryptionKey = exactKey(encryptionKey, "encryptionKey");
  const safeIntegrityKey = exactKey(integrityHmacKey, "integrityHmacKey");
  if (safeEncryptionKey.equals(safeIntegrityKey)) {
    throw repositoryError("trigger_review_result_key_separation_required");
  }
  const safeEncryptionKeyId = requiredToken(encryptionKeyId);
  if (typeof now !== "function") throw repositoryError("trigger_review_result_clock_invalid");
  if (safeDatabasePath !== ":memory:") fs.mkdirSync(path.dirname(safeDatabasePath), { recursive: true });
  const database = new DatabaseSync(safeDatabasePath);
  try {
    initializeDatabase(database);
  } catch (error) {
    database.close();
    throw error;
  }

  function saveOrGet(value) {
    const normalized = normalizeTriggerReviewResult(value);
    const payloadJson = canonicalJson(normalized);
    const identity = identityOf(normalized);
    database.exec("BEGIN IMMEDIATE");
    try {
      const existingRow = readRow(identity);
      if (existingRow) {
        const existing = authenticateRow(existingRow);
        if (!isDeepStrictEqual(inputFromInternal(existing), normalized)) {
          throw repositoryError("trigger_review_result_idempotency_conflict");
        }
        database.exec("COMMIT");
        return Object.freeze({ created: false, evidence: safeEvidence(existing) });
      }

      const sealedAt = trustedNow(now);
      const reviewResultId = `trigger_review_result_${keyedDigest(
        safeIntegrityKey,
        "trigger-review-result-id.v1",
        [identity],
      )}`;
      const payloadHmacDigest = keyedDigest(
        safeIntegrityKey,
        "trigger-review-result-payload.v1",
        [payloadJson],
      );
      const evidenceDigest = keyedDigest(
        safeIntegrityKey,
        "trigger-review-result-evidence.v1",
        [identity, reviewResultId, payloadHmacDigest, safeEncryptionKeyId, sealedAt],
      );
      const aad = authenticatedMetadata({
        ...identity,
        contractVersion: normalized.contractVersion,
        evidenceDigest,
        encryptionKeyId: safeEncryptionKeyId,
        payloadHmacDigest,
        reviewResultId,
        sealedAt,
      });
      const ciphertext = encrypt(safeEncryptionKey, payloadJson, canonicalJson(aad));
      database.prepare(`
        INSERT INTO trigger_review_results (
          tenant_scope, trigger_event_id, task_id, review_result_id, contract_version,
          payload_hmac_digest, evidence_hmac_digest, encryption_key_id,
          encryption_algorithm, ciphertext, sealed_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'aes-256-gcm', ?, ?)
      `).run(
        identity.tenantScope,
        identity.triggerEventId,
        identity.taskId,
        reviewResultId,
        normalized.contractVersion,
        payloadHmacDigest,
        evidenceDigest,
        safeEncryptionKeyId,
        ciphertext,
        sealedAt,
      );
      const stored = authenticateRow(readRow(identity));
      database.exec("COMMIT");
      return Object.freeze({ created: true, evidence: safeEvidence(stored) });
    } catch (error) {
      rollbackIfActive(database);
      throw error;
    }
  }

  function getInternal(value) {
    const identity = normalizeReadIdentity(value);
    const row = readRow(identity);
    return row ? authenticateRow(row) : null;
  }

  function readRow(identity) {
    return database.prepare(`
      SELECT *
      FROM trigger_review_results
      WHERE tenant_scope = ? AND trigger_event_id = ? AND task_id = ?
    `).get(identity.tenantScope, identity.triggerEventId, identity.taskId) || null;
  }

  function authenticateRow(row) {
    const identity = normalizeReadIdentity({
      tenantScope: row.tenant_scope,
      triggerEventId: row.trigger_event_id,
      taskId: row.task_id,
    });
    const reviewResultId = requiredToken(row.review_result_id);
    const payloadHmacDigest = requiredDigest(row.payload_hmac_digest);
    const evidenceDigest = requiredDigest(row.evidence_hmac_digest);
    const sealedAt = requiredTimestamp(row.sealed_at);
    if (row.contract_version !== TRIGGER_REVIEW_RESULT_CONTRACT_VERSION ||
      row.encryption_algorithm !== "aes-256-gcm" || row.encryption_key_id !== safeEncryptionKeyId ||
      reviewResultId !== `trigger_review_result_${keyedDigest(
        safeIntegrityKey,
        "trigger-review-result-id.v1",
        [identity],
      )}`) {
      throw repositoryError("trigger_review_result_integrity_invalid");
    }
    const expectedEvidenceDigest = keyedDigest(
      safeIntegrityKey,
      "trigger-review-result-evidence.v1",
      [identity, reviewResultId, payloadHmacDigest, safeEncryptionKeyId, sealedAt],
    );
    if (!sameDigest(evidenceDigest, expectedEvidenceDigest)) {
      throw repositoryError("trigger_review_result_integrity_invalid");
    }
    const aad = authenticatedMetadata({
      ...identity,
      contractVersion: row.contract_version,
      evidenceDigest,
      encryptionKeyId: row.encryption_key_id,
      payloadHmacDigest,
      reviewResultId,
      sealedAt,
    });
    let parsed;
    try {
      parsed = JSON.parse(decrypt(safeEncryptionKey, row.ciphertext, canonicalJson(aad)));
    } catch (error) {
      if (error?.code) throw error;
      throw repositoryError("trigger_review_result_payload_invalid");
    }
    const normalized = normalizeTriggerReviewResult(parsed);
    if (!isDeepStrictEqual(identityOf(normalized), identity)) {
      throw repositoryError("trigger_review_result_integrity_invalid");
    }
    const expectedPayloadDigest = keyedDigest(
      safeIntegrityKey,
      "trigger-review-result-payload.v1",
      [canonicalJson(normalized)],
    );
    if (!sameDigest(payloadHmacDigest, expectedPayloadDigest)) {
      throw repositoryError("trigger_review_result_integrity_invalid");
    }
    return deepFreeze({
      ...normalized,
      evidenceDigest,
      reviewResultId,
      sealedAt,
    });
  }

  return Object.freeze({
    adapterKind: "sqlite_encrypted_trigger_review_result",
    close: () => database.close(),
    contractVersion: TRIGGER_REVIEW_RESULT_REPOSITORY_CONTRACT_VERSION,
    deploymentScope: "single_center",
    distributedCoordination: false,
    getInternal,
    saveOrGet,
    schemaVersion: 1,
  });
}

function initializeDatabase(database) {
  database.exec(`
    PRAGMA busy_timeout = 5000;
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = FULL;
    CREATE TABLE IF NOT EXISTS trigger_review_result_schema (
      singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
      version INTEGER NOT NULL CHECK (version = 1)
    );
    INSERT INTO trigger_review_result_schema (singleton, version)
    VALUES (1, 1)
    ON CONFLICT(singleton) DO NOTHING;
    CREATE TABLE IF NOT EXISTS trigger_review_results (
      tenant_scope TEXT NOT NULL,
      trigger_event_id TEXT NOT NULL,
      task_id TEXT NOT NULL,
      review_result_id TEXT NOT NULL,
      contract_version TEXT NOT NULL,
      payload_hmac_digest TEXT NOT NULL,
      evidence_hmac_digest TEXT NOT NULL,
      encryption_key_id TEXT NOT NULL,
      encryption_algorithm TEXT NOT NULL CHECK (encryption_algorithm = 'aes-256-gcm'),
      ciphertext TEXT NOT NULL,
      sealed_at TEXT NOT NULL,
      PRIMARY KEY (tenant_scope, trigger_event_id, task_id),
      UNIQUE (tenant_scope, review_result_id)
    );
  `);
  const schema = database.prepare(
    "SELECT version FROM trigger_review_result_schema WHERE singleton = 1",
  ).get();
  if (schema?.version !== 1) throw new TypeError("unsupported trigger review result SQLite schema version");
  const columns = database.prepare("PRAGMA table_info(trigger_review_results)").all()
    .map((column) => column.name);
  const expected = [
    "tenant_scope",
    "trigger_event_id",
    "task_id",
    "review_result_id",
    "contract_version",
    "payload_hmac_digest",
    "evidence_hmac_digest",
    "encryption_key_id",
    "encryption_algorithm",
    "ciphertext",
    "sealed_at",
  ];
  if (!isDeepStrictEqual(columns, expected)) {
    throw new TypeError("invalid trigger review result SQLite schema v1");
  }
}

function normalizeTriggerReviewResult(value) {
  requireExactObject(value, RESULT_FIELDS, "trigger_review_result_value_invalid");
  if (value.contractVersion !== TRIGGER_REVIEW_RESULT_CONTRACT_VERSION) {
    throw repositoryError("trigger_review_result_contract_invalid");
  }
  const result = normalizeResult(value.result);
  const reviewComment = requiredReviewComment(value.reviewComment);
  const normalized = {
    contractVersion: TRIGGER_REVIEW_RESULT_CONTRACT_VERSION,
    tenantScope: requiredToken(value.tenantScope),
    triggerEventId: requiredToken(value.triggerEventId),
    taskId: requiredToken(value.taskId),
    result,
    reviewComment,
  };
  if (Buffer.byteLength(canonicalJson(normalized), "utf8") > MAX_RESULT_BYTES + MAX_COMMENT_BYTES) {
    throw repositoryError("trigger_review_result_payload_too_large");
  }
  return deepFreeze(normalized);
}

function normalizeReadIdentity(value) {
  requireExactObject(value, READ_FIELDS, "trigger_review_result_read_invalid");
  return Object.freeze({
    tenantScope: requiredToken(value.tenantScope),
    triggerEventId: requiredToken(value.triggerEventId),
    taskId: requiredToken(value.taskId),
  });
}

function normalizeResult(value) {
  if (!isPlainObject(value) || typeof value.contractVersion !== "string") {
    throw repositoryError("trigger_review_result_result_invalid");
  }
  const normalized = normalizeJsonValue(value, 0, "result");
  requiredToken(normalized.contractVersion);
  if (Buffer.byteLength(canonicalJson(normalized), "utf8") > MAX_RESULT_BYTES) {
    throw repositoryError("trigger_review_result_payload_too_large");
  }
  return normalized;
}

function normalizeJsonValue(value, depth, field) {
  if (depth > 12) throw repositoryError("trigger_review_result_result_invalid");
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    if (Buffer.byteLength(value, "utf8") > MAX_COMMENT_BYTES || SECRET_VALUE.test(value)) {
      throw repositoryError("trigger_review_result_sensitive_value_forbidden");
    }
    return value;
  }
  if (Array.isArray(value)) {
    if (value.length > 500) throw repositoryError("trigger_review_result_result_invalid");
    return value.map((item, index) => normalizeJsonValue(item, depth + 1, `${field}.${index}`));
  }
  if (!isPlainObject(value) || Object.keys(value).length > 200) {
    throw repositoryError("trigger_review_result_result_invalid");
  }
  return Object.freeze(Object.fromEntries(Object.keys(value).sort().map((key) => {
    if (!key || key.length > 120 || FORBIDDEN_RESULT_FIELD.test(key)) {
      throw repositoryError("trigger_review_result_sensitive_field_forbidden");
    }
    return [key, normalizeJsonValue(value[key], depth + 1, `${field}.${key}`)];
  })));
}

function requiredReviewComment(value) {
  if (typeof value !== "string" || value !== value.trim() || !value || value.includes("\0") ||
    Buffer.byteLength(value, "utf8") > MAX_COMMENT_BYTES) {
    throw repositoryError("trigger_review_result_comment_invalid");
  }
  if (SECRET_VALUE.test(value)) {
    throw repositoryError("trigger_review_result_sensitive_value_forbidden");
  }
  return value;
}

function identityOf(value) {
  return Object.freeze({
    tenantScope: value.tenantScope,
    triggerEventId: value.triggerEventId,
    taskId: value.taskId,
  });
}

function inputFromInternal(value) {
  return deepFreeze({
    contractVersion: value.contractVersion,
    tenantScope: value.tenantScope,
    triggerEventId: value.triggerEventId,
    taskId: value.taskId,
    result: value.result,
    reviewComment: value.reviewComment,
  });
}

function safeEvidence(value) {
  return Object.freeze({
    contractVersion: TRIGGER_REVIEW_RESULT_EVIDENCE_CONTRACT_VERSION,
    tenantScope: value.tenantScope,
    triggerEventId: value.triggerEventId,
    taskId: value.taskId,
    reviewResultId: value.reviewResultId,
    evidenceDigest: value.evidenceDigest,
    sealedAt: value.sealedAt,
  });
}

function authenticatedMetadata(value) {
  return Object.freeze({
    contractVersion: value.contractVersion,
    tenantScope: value.tenantScope,
    triggerEventId: value.triggerEventId,
    taskId: value.taskId,
    reviewResultId: value.reviewResultId,
    payloadHmacDigest: value.payloadHmacDigest,
    evidenceDigest: value.evidenceDigest,
    encryptionKeyId: value.encryptionKeyId,
    encryptionAlgorithm: "aes-256-gcm",
    sealedAt: value.sealedAt,
  });
}

function encrypt(key, plaintext, aad) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(Buffer.from(aad, "utf8"));
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return [iv, cipher.getAuthTag(), ciphertext]
    .map((part) => part.toString("base64"))
    .join(".");
}

function decrypt(key, envelope, aad) {
  try {
    const parts = String(envelope || "").split(".").map((part) => Buffer.from(part, "base64"));
    if (parts.length !== 3 || parts[0].length !== 12 || parts[1].length !== 16 || !parts[2].length) {
      throw new Error("invalid ciphertext");
    }
    const decipher = crypto.createDecipheriv("aes-256-gcm", key, parts[0]);
    decipher.setAAD(Buffer.from(aad, "utf8"));
    decipher.setAuthTag(parts[1]);
    return Buffer.concat([decipher.update(parts[2]), decipher.final()]).toString("utf8");
  } catch {
    throw repositoryError("trigger_review_result_decryption_failed");
  }
}

function keyedDigest(key, domain, parts) {
  return crypto.createHmac("sha256", key)
    .update(canonicalJson([domain, ...parts]), "utf8")
    .digest("hex");
}

function sameDigest(left, right) {
  if (!DIGEST.test(left) || !DIGEST.test(right)) return false;
  return crypto.timingSafeEqual(Buffer.from(left, "hex"), Buffer.from(right, "hex"));
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) =>
      `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  const json = JSON.stringify(value);
  if (json === undefined) throw repositoryError("trigger_review_result_result_invalid");
  return json;
}

function requireExactObject(value, fields, code) {
  if (!isPlainObject(value) || Object.keys(value).length !== fields.size ||
    Object.keys(value).some((field) => !fields.has(field)) ||
    [...fields].some((field) => !Object.hasOwn(value, field))) {
    throw repositoryError(code);
  }
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value) &&
    [Object.prototype, null].includes(Object.getPrototypeOf(value));
}

function requiredToken(value) {
  if (typeof value !== "string" || value !== value.trim() || !TOKEN.test(value)) {
    throw repositoryError("trigger_review_result_reference_invalid");
  }
  return value;
}

function requiredDigest(value) {
  const digest = String(value || "").trim().toLowerCase();
  if (!DIGEST.test(digest)) throw repositoryError("trigger_review_result_integrity_invalid");
  return digest;
}

function requiredTimestamp(value) {
  if (typeof value !== "string") throw repositoryError("trigger_review_result_integrity_invalid");
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString() !== value) {
    throw repositoryError("trigger_review_result_integrity_invalid");
  }
  return value;
}

function trustedNow(now) {
  try {
    const value = now();
    const date = value instanceof Date ? value : new Date(value);
    if (!Number.isFinite(date.getTime())) throw new Error("invalid clock");
    return date.toISOString();
  } catch {
    throw repositoryError("trigger_review_result_clock_invalid");
  }
}

function exactKey(value, field) {
  const key = Buffer.isBuffer(value) ? Buffer.from(value) : Buffer.from(value || []);
  if (key.length !== 32) throw repositoryError("trigger_review_result_key_invalid", field);
  return key;
}

function requiredDatabasePath(value) {
  const text = String(value || "").trim();
  if (text === ":memory:") return text;
  if (!text || !path.isAbsolute(text)) {
    throw new TypeError("trigger review result databasePath must be absolute or :memory:");
  }
  return path.normalize(text);
}

function rollbackIfActive(database) {
  if (database.isTransaction) database.exec("ROLLBACK");
}

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  Object.freeze(value);
  Object.values(value).forEach(deepFreeze);
  return value;
}

function repositoryError(code, message = code) {
  const error = new Error(message);
  error.code = code;
  return error;
}

export {
  TRIGGER_REVIEW_RESULT_CONTRACT_VERSION,
  TRIGGER_REVIEW_RESULT_EVIDENCE_CONTRACT_VERSION,
  TRIGGER_REVIEW_RESULT_REPOSITORY_CONTRACT_VERSION,
  createSqliteTriggerReviewResultRepository,
  normalizeTriggerReviewResult,
};
