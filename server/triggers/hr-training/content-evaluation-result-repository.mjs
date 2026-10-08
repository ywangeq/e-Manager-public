import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { DatabaseSync } from "node:sqlite";
import { HR_TRAINING_CONTENT_EVALUATION_RESULT_VERSION } from "./content-evaluation-output-policy.mjs";

const RECORD_VERSION = "hr-training-content-evaluation-result-record.v1";
const EVIDENCE_VERSION = "hr-training-content-evaluation-result-evidence.v1";
const REPOSITORY_VERSION = "hr-training-content-evaluation-result-repository.v1";
const ENCRYPTION_ALGORITHM = "aes-256-gcm";
const RECORD_FIELDS = new Set(["contractVersion", "result", "taskId", "tenantScope", "triggerEventId"]);
const READ_FIELDS = new Set(["taskId", "tenantScope", "triggerEventId"]);
const FORBIDDEN_RESULT_FIELD = /(?:auth|bearer|callback|credential|password|raw|secret|token|tool|trace|url)/i;
const SECRET_VALUE = /(?:bearer\s+|sk-|rk-|xox[baprs]-|gh[pousr]_|glpat-|ya29\.|eyJ)[A-Za-z0-9._~+/=-]{8,}|-----BEGIN [A-Z ]*PRIVATE KEY-----|https?:\/\/\S+/i;
const TOKEN = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,239}$/;
const DIGEST = /^[a-f0-9]{64}$/;
const MAX_RESULT_BYTES = 512 * 1024;
const MAX_STRING_BYTES = 16 * 1024;

function createSqliteHrTrainingContentEvaluationResultRepository({
  databasePath,
  encryptionKey,
  encryptionKeyId = "hr-training-content-evaluation-result-key-v1",
  integrityHmacKey,
  now = () => new Date(),
} = {}) {
  const safeDatabasePath = requiredDatabasePath(databasePath);
  const safeEncryptionKey = exactKey(encryptionKey, "encryptionKey");
  const safeIntegrityKey = exactKey(integrityHmacKey, "integrityHmacKey");
  if (safeEncryptionKey.equals(safeIntegrityKey)) {
    throw repositoryError("hr_training_content_result_key_separation_required");
  }
  const safeEncryptionKeyId = requiredToken(encryptionKeyId, "encryptionKeyId", 120);
  if (typeof now !== "function") throw repositoryError("hr_training_content_result_clock_invalid");
  if (safeDatabasePath !== ":memory:") fs.mkdirSync(path.dirname(safeDatabasePath), { recursive: true });
  const database = new DatabaseSync(safeDatabasePath);
  try {
    initializeDatabase(database);
  } catch (error) {
    database.close();
    throw error;
  }

  function saveOrGet(value) {
    const normalized = normalizeRecord(value);
    const identity = identityOf(normalized);
    const payloadJson = canonicalJson(normalized);
    database.exec("BEGIN IMMEDIATE");
    try {
      const existingRow = readRow(identity);
      if (existingRow) {
        const existing = authenticateRow(existingRow);
        if (!isDeepStrictEqual(recordFromInternal(existing), normalized)) {
          throw repositoryError("hr_training_content_result_idempotency_conflict");
        }
        database.exec("COMMIT");
        return Object.freeze({ created: false, evidence: safeEvidence(existing), result: existing.result });
      }
      const sealedAt = trustedNow(now);
      const resultId = `hr_training_content_result_${keyedDigest(
        safeIntegrityKey,
        "hr-training-content-result-id.v1",
        [identity],
      )}`;
      const payloadHmacDigest = keyedDigest(
        safeIntegrityKey,
        "hr-training-content-result-payload.v1",
        [payloadJson],
      );
      const evidenceDigest = keyedDigest(
        safeIntegrityKey,
        "hr-training-content-result-evidence.v1",
        [identity, resultId, payloadHmacDigest, safeEncryptionKeyId, sealedAt],
      );
      const aad = authenticatedMetadata({
        ...identity,
        contractVersion: normalized.contractVersion,
        encryptionKeyId: safeEncryptionKeyId,
        evidenceDigest,
        payloadHmacDigest,
        resultId,
        sealedAt,
      });
      const ciphertext = encrypt(safeEncryptionKey, payloadJson, canonicalJson(aad));
      database.prepare(`
        INSERT INTO hr_training_content_evaluation_results (
          tenant_scope, trigger_event_id, task_id, result_id, contract_version,
          payload_hmac_digest, evidence_hmac_digest, encryption_key_id,
          encryption_algorithm, ciphertext, status, question_count, sealed_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'aes-256-gcm', ?, ?, ?, ?)
      `).run(
        identity.tenantScope,
        identity.triggerEventId,
        identity.taskId,
        resultId,
        RECORD_VERSION,
        payloadHmacDigest,
        evidenceDigest,
        safeEncryptionKeyId,
        ciphertext,
        normalized.result.status,
        Array.isArray(normalized.result.questions) ? normalized.result.questions.length : 0,
        sealedAt,
      );
      const stored = authenticateRow(readRow(identity));
      database.exec("COMMIT");
      return Object.freeze({ created: true, evidence: safeEvidence(stored), result: stored.result });
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
      FROM hr_training_content_evaluation_results
      WHERE tenant_scope = ? AND trigger_event_id = ? AND task_id = ?
    `).get(identity.tenantScope, identity.triggerEventId, identity.taskId) || null;
  }

  function authenticateRow(row) {
    const identity = normalizeReadIdentity({
      tenantScope: row.tenant_scope,
      triggerEventId: row.trigger_event_id,
      taskId: row.task_id,
    });
    const resultId = requiredToken(row.result_id, "resultId", 240);
    const payloadHmacDigest = requiredDigest(row.payload_hmac_digest);
    const evidenceDigest = requiredDigest(row.evidence_hmac_digest);
    const sealedAt = requiredTimestamp(row.sealed_at);
    if (row.contract_version !== RECORD_VERSION ||
      row.encryption_algorithm !== ENCRYPTION_ALGORITHM ||
      row.encryption_key_id !== safeEncryptionKeyId ||
      resultId !== `hr_training_content_result_${keyedDigest(
        safeIntegrityKey,
        "hr-training-content-result-id.v1",
        [identity],
      )}`) {
      throw repositoryError("hr_training_content_result_integrity_invalid");
    }
    const expectedEvidenceDigest = keyedDigest(
      safeIntegrityKey,
      "hr-training-content-result-evidence.v1",
      [identity, resultId, payloadHmacDigest, safeEncryptionKeyId, sealedAt],
    );
    if (!sameDigest(evidenceDigest, expectedEvidenceDigest)) {
      throw repositoryError("hr_training_content_result_integrity_invalid");
    }
    const aad = authenticatedMetadata({
      ...identity,
      contractVersion: row.contract_version,
      encryptionKeyId: row.encryption_key_id,
      evidenceDigest,
      payloadHmacDigest,
      resultId,
      sealedAt,
    });
    let parsed;
    try {
      parsed = JSON.parse(decrypt(safeEncryptionKey, row.ciphertext, canonicalJson(aad)));
    } catch (error) {
      if (error?.code) throw error;
      throw repositoryError("hr_training_content_result_payload_invalid");
    }
    const normalized = normalizeRecord(parsed);
    if (!isDeepStrictEqual(identityOf(normalized), identity) ||
      keyedDigest(safeIntegrityKey, "hr-training-content-result-payload.v1", [
        canonicalJson(normalized),
      ]) !== payloadHmacDigest) {
      throw repositoryError("hr_training_content_result_integrity_invalid");
    }
    return deepFreeze({
      ...normalized,
      evidenceDigest,
      resultId,
      sealedAt,
    });
  }

  return Object.freeze({
    adapterKind: "sqlite_encrypted_hr_training_content_evaluation_result",
    close: () => database.close(),
    contractVersion: REPOSITORY_VERSION,
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
    CREATE TABLE IF NOT EXISTS hr_training_content_evaluation_result_schema (
      singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
      version INTEGER NOT NULL CHECK (version = 1)
    );
    INSERT INTO hr_training_content_evaluation_result_schema (singleton, version)
    VALUES (1, 1)
    ON CONFLICT(singleton) DO NOTHING;
    CREATE TABLE IF NOT EXISTS hr_training_content_evaluation_results (
      tenant_scope TEXT NOT NULL,
      trigger_event_id TEXT NOT NULL,
      task_id TEXT NOT NULL,
      result_id TEXT NOT NULL,
      contract_version TEXT NOT NULL,
      payload_hmac_digest TEXT NOT NULL,
      evidence_hmac_digest TEXT NOT NULL,
      encryption_key_id TEXT NOT NULL,
      encryption_algorithm TEXT NOT NULL CHECK (encryption_algorithm = 'aes-256-gcm'),
      ciphertext TEXT NOT NULL,
      status TEXT NOT NULL,
      question_count INTEGER NOT NULL,
      sealed_at TEXT NOT NULL,
      PRIMARY KEY (tenant_scope, trigger_event_id, task_id),
      UNIQUE (tenant_scope, result_id)
    );
  `);
  const schema = database.prepare(
    "SELECT version FROM hr_training_content_evaluation_result_schema WHERE singleton = 1",
  ).get();
  if (schema?.version !== 1) {
    throw new TypeError("unsupported HR Training content result SQLite schema version");
  }
  const columns = database.prepare("PRAGMA table_info(hr_training_content_evaluation_results)").all()
    .map((column) => column.name);
  const expected = [
    "tenant_scope",
    "trigger_event_id",
    "task_id",
    "result_id",
    "contract_version",
    "payload_hmac_digest",
    "evidence_hmac_digest",
    "encryption_key_id",
    "encryption_algorithm",
    "ciphertext",
    "status",
    "question_count",
    "sealed_at",
  ];
  if (!isDeepStrictEqual(columns, expected)) {
    throw new TypeError("invalid HR Training content result SQLite schema v1");
  }
}

function normalizeRecord(value) {
  requireExactObject(value, RECORD_FIELDS, "hr_training_content_result_record_invalid");
  if (value.contractVersion !== RECORD_VERSION) {
    throw repositoryError("hr_training_content_result_contract_invalid");
  }
  const result = normalizeResult(value.result);
  const normalized = {
    contractVersion: RECORD_VERSION,
    tenantScope: requiredToken(value.tenantScope, "tenantScope", 160),
    triggerEventId: requiredToken(value.triggerEventId, "triggerEventId", 240),
    taskId: requiredToken(value.taskId, "taskId", 128),
    result,
  };
  if (Buffer.byteLength(canonicalJson(normalized), "utf8") > MAX_RESULT_BYTES) {
    throw repositoryError("hr_training_content_result_payload_too_large");
  }
  return deepFreeze(normalized);
}

function normalizeReadIdentity(value) {
  requireExactObject(value, READ_FIELDS, "hr_training_content_result_read_invalid");
  return Object.freeze({
    tenantScope: requiredToken(value.tenantScope, "tenantScope", 160),
    triggerEventId: requiredToken(value.triggerEventId, "triggerEventId", 240),
    taskId: requiredToken(value.taskId, "taskId", 128),
  });
}

function normalizeResult(value) {
  if (!isPlainObject(value) || value.contractVersion !== HR_TRAINING_CONTENT_EVALUATION_RESULT_VERSION) {
    throw repositoryError("hr_training_content_result_invalid");
  }
  const normalized = normalizeJsonValue(value, 0);
  if (Buffer.byteLength(canonicalJson(normalized), "utf8") > MAX_RESULT_BYTES) {
    throw repositoryError("hr_training_content_result_payload_too_large");
  }
  return normalized;
}

function normalizeJsonValue(value, depth) {
  if (depth > 16) throw repositoryError("hr_training_content_result_invalid");
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    if (Buffer.byteLength(value, "utf8") > MAX_STRING_BYTES || SECRET_VALUE.test(value)) {
      throw repositoryError("hr_training_content_result_sensitive_value_forbidden");
    }
    return value;
  }
  if (Array.isArray(value)) {
    if (value.length > 1000) throw repositoryError("hr_training_content_result_invalid");
    return Object.freeze(value.map((item) => normalizeJsonValue(item, depth + 1)));
  }
  if (!isPlainObject(value) || Object.keys(value).length > 240) {
    throw repositoryError("hr_training_content_result_invalid");
  }
  return Object.freeze(Object.fromEntries(Object.keys(value).sort().map((key) => {
    if (!key || key.length > 120 || forbiddenResultField(key)) {
      throw repositoryError("hr_training_content_result_sensitive_field_forbidden");
    }
    return [key, normalizeJsonValue(value[key], depth + 1)];
  })));
}

function forbiddenResultField(key) {
  if (key === "promptVersion") return false;
  return FORBIDDEN_RESULT_FIELD.test(key);
}

function identityOf(value) {
  return Object.freeze({
    tenantScope: value.tenantScope,
    triggerEventId: value.triggerEventId,
    taskId: value.taskId,
  });
}

function recordFromInternal(value) {
  return deepFreeze({
    contractVersion: RECORD_VERSION,
    tenantScope: value.tenantScope,
    triggerEventId: value.triggerEventId,
    taskId: value.taskId,
    result: value.result,
  });
}

function safeEvidence(value) {
  return Object.freeze({
    contractVersion: EVIDENCE_VERSION,
    tenantScope: value.tenantScope,
    triggerEventId: value.triggerEventId,
    taskId: value.taskId,
    resultId: value.resultId,
    evidenceDigest: value.evidenceDigest,
    status: value.result.status,
    questionCount: Array.isArray(value.result.questions) ? value.result.questions.length : 0,
    sealedAt: value.sealedAt,
  });
}

function authenticatedMetadata(value) {
  return Object.freeze({
    contractVersion: value.contractVersion,
    tenantScope: value.tenantScope,
    triggerEventId: value.triggerEventId,
    taskId: value.taskId,
    resultId: value.resultId,
    payloadHmacDigest: value.payloadHmacDigest,
    evidenceDigest: value.evidenceDigest,
    encryptionKeyId: value.encryptionKeyId,
    encryptionAlgorithm: ENCRYPTION_ALGORITHM,
    sealedAt: value.sealedAt,
  });
}

function encrypt(key, plaintext, aad) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(ENCRYPTION_ALGORITHM, key, iv);
  cipher.setAAD(Buffer.from(aad, "utf8"));
  const body = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return [iv, cipher.getAuthTag(), body].map((part) => part.toString("base64")).join(".");
}

function decrypt(key, envelope, aad) {
  try {
    const parts = String(envelope || "").split(".").map((part) => Buffer.from(part, "base64"));
    if (parts.length !== 3 || parts[0].length !== 12 || parts[1].length !== 16 || !parts[2].length) {
      throw new Error("invalid encrypted result envelope");
    }
    const decipher = crypto.createDecipheriv(ENCRYPTION_ALGORITHM, key, parts[0]);
    decipher.setAAD(Buffer.from(aad, "utf8"));
    decipher.setAuthTag(parts[1]);
    return Buffer.concat([decipher.update(parts[2]), decipher.final()]).toString("utf8");
  } catch {
    throw repositoryError("hr_training_content_result_decryption_failed");
  }
}

function keyedDigest(key, domain, parts) {
  return crypto.createHmac("sha256", key)
    .update(canonicalJson([domain, ...parts]), "utf8")
    .digest("hex");
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) =>
      `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  const json = JSON.stringify(value);
  if (json === undefined) throw repositoryError("hr_training_content_result_json_invalid");
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

function requiredToken(value, field, maxLength) {
  if (typeof value !== "string" || value !== value.trim() || !value ||
    value.length > maxLength || !TOKEN.test(value) || SECRET_VALUE.test(value)) {
    throw repositoryError("hr_training_content_result_reference_invalid", field);
  }
  return value;
}

function requiredDigest(value) {
  const digest = String(value || "").trim().toLowerCase();
  if (!DIGEST.test(digest)) throw repositoryError("hr_training_content_result_integrity_invalid");
  return digest;
}

function requiredTimestamp(value) {
  if (typeof value !== "string") throw repositoryError("hr_training_content_result_integrity_invalid");
  const timestamp = new Date(value);
  if (!Number.isFinite(timestamp.getTime()) || timestamp.toISOString() !== value) {
    throw repositoryError("hr_training_content_result_integrity_invalid");
  }
  return value;
}

function trustedNow(now) {
  try {
    const value = now();
    const timestamp = value instanceof Date ? value : new Date(value);
    if (!Number.isFinite(timestamp.getTime())) throw new Error("invalid clock");
    return timestamp.toISOString();
  } catch {
    throw repositoryError("hr_training_content_result_clock_invalid");
  }
}

function exactKey(value, field) {
  const key = Buffer.isBuffer(value) ? Buffer.from(value) : Buffer.from(value || []);
  if (key.length !== 32) throw repositoryError("hr_training_content_result_key_invalid", field);
  return key;
}

function sameDigest(left, right) {
  if (!DIGEST.test(left) || !DIGEST.test(right)) return false;
  return crypto.timingSafeEqual(Buffer.from(left, "hex"), Buffer.from(right, "hex"));
}

function requiredDatabasePath(value) {
  const text = String(value || "").trim();
  if (text === ":memory:") return text;
  if (!text || !path.isAbsolute(text)) {
    throw new TypeError("HR Training content result databasePath must be absolute or :memory:");
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
  EVIDENCE_VERSION as HR_TRAINING_CONTENT_EVALUATION_RESULT_EVIDENCE_VERSION,
  RECORD_VERSION as HR_TRAINING_CONTENT_EVALUATION_RESULT_RECORD_VERSION,
  REPOSITORY_VERSION as HR_TRAINING_CONTENT_EVALUATION_RESULT_REPOSITORY_VERSION,
  createSqliteHrTrainingContentEvaluationResultRepository,
};
