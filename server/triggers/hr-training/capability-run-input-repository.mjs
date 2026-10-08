import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { DatabaseSync } from "node:sqlite";

const CONTRACT_VERSION = "hr-training-capability-run-input.v1";
const REPOSITORY_VERSION = "hr-training-capability-run-input-repository.v1";
const ENCRYPTION_ALGORITHM = "aes-256-gcm";
const INPUT_FIELDS = new Set([
  "callbackUrl",
  "capability",
  "contextUrl",
  "contractVersion",
  "idempotencyKey",
  "meetingRecordId",
  "sessionId",
  "tenantScope",
]);
const READ_FIELDS = new Set(["runInputId", "tenantScope"]);
const TASK_BINDING_FIELDS = new Set(["runInputId", "taskId", "tenantScope", "triggerEventId"]);
const TASK_LOOKUP_FIELDS = new Set(["taskId", "tenantScope"]);
const TOKEN = /^[A-Za-z0-9][A-Za-z0-9._:@:-]{0,239}$/;
const DIGEST = /^[a-f0-9]{64}$/;
const SECRET_VALUE = /(?:bearer\s+|sk-|rk-|xox[baprs]-|gh[pousr]_|glpat-|ya29\.|eyJ)[A-Za-z0-9._~+/=-]{8,}|-----BEGIN [A-Z ]*PRIVATE KEY-----/i;
const CREDENTIAL_QUERY_KEY = /(?:^|[-_])(api[-_]?key|access[-_]?token|authorization|bearer|credential|password|secret|token)(?:$|[-_])/i;
const MAX_URL_CHARS = 4096;

function createSqliteHrTrainingCapabilityRunInputRepository({
  databasePath,
  encryptionKey,
  encryptionKeyId = "hr-training-capability-run-input-key-v1",
  indexHmacKey,
  integrityHmacKey,
  now = () => new Date(),
} = {}) {
  const safeDatabasePath = requiredDatabasePath(databasePath);
  const safeEncryptionKey = exactKey(encryptionKey, "encryptionKey");
  const safeIndexKey = exactKey(indexHmacKey, "indexHmacKey");
  const safeIntegrityKey = exactKey(integrityHmacKey, "integrityHmacKey");
  if (safeEncryptionKey.equals(safeIndexKey) || safeEncryptionKey.equals(safeIntegrityKey) ||
    safeIndexKey.equals(safeIntegrityKey)) {
    throw repositoryError("hr_training_capability_input_key_separation_required");
  }
  const safeEncryptionKeyId = requiredToken(encryptionKeyId, "encryptionKeyId", 120);
  if (typeof now !== "function") throw repositoryError("hr_training_capability_input_clock_invalid");
  if (safeDatabasePath !== ":memory:") fs.mkdirSync(path.dirname(safeDatabasePath), { recursive: true });
  const database = new DatabaseSync(safeDatabasePath);
  try {
    initializeDatabase(database);
  } catch (error) {
    database.close();
    throw error;
  }

  function saveOrGet(value) {
    const normalized = normalizeInput(value);
    const identity = identityOf(normalized);
    const runInputId = deriveRunInputId(safeIndexKey, identity);
    const idempotencyDigest = keyedDigest(safeIndexKey, "hr-training-capability-input-idempotency.v1", [
      identity.tenantScope,
      identity.capability,
      identity.idempotencyKey,
    ]);
    const contextUrlDigest = keyedDigest(safeIndexKey, "hr-training-capability-input-context-url.v1", [
      normalized.contextUrl,
    ]);
    const callbackUrlDigest = keyedDigest(safeIndexKey, "hr-training-capability-input-callback-url.v1", [
      normalized.callbackUrl,
    ]);
    const payloadJson = canonicalJson(normalized);
    const payloadHmacDigest = keyedDigest(safeIntegrityKey, "hr-training-capability-input-payload.v1", [
      payloadJson,
    ]);
    database.exec("BEGIN IMMEDIATE");
    try {
      const existingRow = readByIdentity(identity, idempotencyDigest);
      if (existingRow) {
        const existing = authenticateRow(existingRow);
        if (!isDeepStrictEqual(inputFromInternal(existing), normalized)) {
          throw repositoryError("hr_training_capability_input_idempotency_conflict");
        }
        database.exec("COMMIT");
        return Object.freeze({ created: false, input: existing });
      }
      const createdAt = trustedNow(now);
      const evaluationRef = `HRT-${runInputId.slice(-10).toUpperCase()}`;
      const aad = authenticatedMetadata({
        callbackUrlDigest,
        capability: normalized.capability,
        contextUrlDigest,
        createdAt,
        encryptionKeyId: safeEncryptionKeyId,
        idempotencyDigest,
        payloadHmacDigest,
        runInputId,
        tenantScope: normalized.tenantScope,
      });
      const ciphertext = encrypt(safeEncryptionKey, payloadJson, canonicalJson(aad));
      database.prepare(`
        INSERT INTO hr_training_capability_run_inputs (
          tenant_scope, capability, idempotency_digest, run_input_id, contract_version,
          session_id, meeting_record_id, evaluation_ref, context_origin, callback_origin,
          context_url_digest, callback_url_digest, payload_hmac_digest, encryption_key_id,
          encryption_algorithm, ciphertext, created_at, task_id, trigger_event_id
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL)
      `).run(
        normalized.tenantScope,
        normalized.capability,
        idempotencyDigest,
        runInputId,
        CONTRACT_VERSION,
        normalized.sessionId,
        normalized.meetingRecordId,
        evaluationRef,
        originOf(normalized.contextUrl),
        originOf(normalized.callbackUrl),
        contextUrlDigest,
        callbackUrlDigest,
        payloadHmacDigest,
        safeEncryptionKeyId,
        ENCRYPTION_ALGORITHM,
        ciphertext,
        createdAt,
      );
      const stored = authenticateRow(readByRunInputId(normalized.tenantScope, runInputId));
      database.exec("COMMIT");
      return Object.freeze({ created: true, input: stored });
    } catch (error) {
      rollbackIfActive(database);
      throw error;
    }
  }

  function bindTask(value = {}) {
    requireExactObject(value, TASK_BINDING_FIELDS, "hr_training_capability_input_task_binding_invalid");
    const tenantScope = requiredToken(value.tenantScope, "tenantScope", 160);
    const runInputId = requiredToken(value.runInputId, "runInputId", 160);
    const taskId = requiredToken(value.taskId, "taskId", 128);
    const triggerEventId = requiredToken(value.triggerEventId, "triggerEventId", 240);
    database.exec("BEGIN IMMEDIATE");
    try {
      const existing = readByRunInputId(tenantScope, runInputId);
      if (!existing) throw repositoryError("hr_training_capability_input_not_found");
      if ((existing.taskId && existing.taskId !== taskId) ||
        (existing.triggerEventId && existing.triggerEventId !== triggerEventId)) {
        throw repositoryError("hr_training_capability_input_task_conflict");
      }
      database.prepare(`
        UPDATE hr_training_capability_run_inputs
        SET task_id = ?, trigger_event_id = ?
        WHERE tenant_scope = ? AND run_input_id = ?
      `).run(taskId, triggerEventId, tenantScope, runInputId);
      const stored = authenticateRow(readByRunInputId(tenantScope, runInputId));
      database.exec("COMMIT");
      return Object.freeze({ input: stored });
    } catch (error) {
      rollbackIfActive(database);
      throw error;
    }
  }

  function getInternal(value = {}) {
    requireExactObject(value, READ_FIELDS, "hr_training_capability_input_read_invalid");
    const tenantScope = requiredToken(value.tenantScope, "tenantScope", 160);
    const runInputId = requiredToken(value.runInputId, "runInputId", 160);
    const row = readByRunInputId(tenantScope, runInputId);
    return row ? authenticateRow(row) : null;
  }

  function getSafeByTask(value = {}) {
    requireExactObject(value, TASK_LOOKUP_FIELDS, "hr_training_capability_input_task_lookup_invalid");
    const tenantScope = requiredToken(value.tenantScope, "tenantScope", 160);
    const taskId = requiredToken(value.taskId, "taskId", 128);
    const row = database.prepare(`
      SELECT *
      FROM hr_training_capability_run_inputs
      WHERE tenant_scope = ? AND task_id = ?
      ORDER BY created_at DESC
      LIMIT 1
    `).get(tenantScope, taskId);
    return row ? safeProjection(authenticateRow(row)) : null;
  }

  function readByIdentity(identity, idempotencyDigest) {
    return database.prepare(`
      SELECT *
      FROM hr_training_capability_run_inputs
      WHERE tenant_scope = ? AND capability = ? AND idempotency_digest = ?
    `).get(identity.tenantScope, identity.capability, idempotencyDigest) || null;
  }

  function readByRunInputId(tenantScope, runInputId) {
    return database.prepare(`
      SELECT *
      FROM hr_training_capability_run_inputs
      WHERE tenant_scope = ? AND run_input_id = ?
    `).get(tenantScope, runInputId) || null;
  }

  function authenticateRow(row) {
    const envelope = {
      callbackUrlDigest: requiredDigest(row.callback_url_digest),
      capability: requiredToken(row.capability, "capability", 120),
      contextUrlDigest: requiredDigest(row.context_url_digest),
      createdAt: requiredTimestamp(row.created_at),
      encryptionKeyId: requiredToken(row.encryption_key_id, "encryptionKeyId", 120),
      idempotencyDigest: requiredDigest(row.idempotency_digest),
      payloadHmacDigest: requiredDigest(row.payload_hmac_digest),
      runInputId: requiredToken(row.run_input_id, "runInputId", 160),
      tenantScope: requiredToken(row.tenant_scope, "tenantScope", 160),
    };
    if (row.contract_version !== CONTRACT_VERSION ||
      row.encryption_algorithm !== ENCRYPTION_ALGORITHM ||
      row.encryption_key_id !== safeEncryptionKeyId ||
      envelope.runInputId !== deriveRunInputId(safeIndexKey, {
        tenantScope: envelope.tenantScope,
        capability: envelope.capability,
        idempotencyKeyDigest: envelope.idempotencyDigest,
      })) {
      throw repositoryError("hr_training_capability_input_integrity_invalid");
    }
    let parsed;
    try {
      parsed = JSON.parse(decrypt(safeEncryptionKey, row.ciphertext, canonicalJson(authenticatedMetadata(envelope))));
    } catch (error) {
      if (error?.code) throw error;
      throw repositoryError("hr_training_capability_input_payload_invalid");
    }
    const normalized = normalizeInput(parsed);
    if (normalized.tenantScope !== envelope.tenantScope ||
      normalized.capability !== envelope.capability ||
      keyedDigest(safeIndexKey, "hr-training-capability-input-idempotency.v1", [
        normalized.tenantScope,
        normalized.capability,
        normalized.idempotencyKey,
      ]) !== envelope.idempotencyDigest ||
      keyedDigest(safeIndexKey, "hr-training-capability-input-context-url.v1", [
        normalized.contextUrl,
      ]) !== envelope.contextUrlDigest ||
      keyedDigest(safeIndexKey, "hr-training-capability-input-callback-url.v1", [
        normalized.callbackUrl,
      ]) !== envelope.callbackUrlDigest ||
      keyedDigest(safeIntegrityKey, "hr-training-capability-input-payload.v1", [
        canonicalJson(normalized),
      ]) !== envelope.payloadHmacDigest) {
      throw repositoryError("hr_training_capability_input_integrity_invalid");
    }
    return deepFreeze({
      ...normalized,
      runInputId: envelope.runInputId,
      evaluationRef: requiredSafeRef(row.evaluation_ref),
      contextOrigin: requiredOrigin(row.context_origin),
      callbackOrigin: requiredOrigin(row.callback_origin),
      contextUrlDigest: envelope.contextUrlDigest,
      callbackUrlDigest: envelope.callbackUrlDigest,
      payloadHmacDigest: envelope.payloadHmacDigest,
      createdAt: envelope.createdAt,
      taskId: row.task_id ? requiredToken(row.task_id, "taskId", 128) : null,
      triggerEventId: row.trigger_event_id ? requiredToken(row.trigger_event_id, "triggerEventId", 240) : null,
    });
  }

  return Object.freeze({
    adapterKind: "sqlite_encrypted_hr_training_capability_run_input",
    bindTask,
    close: () => database.close(),
    contractVersion: REPOSITORY_VERSION,
    deploymentScope: "single_center",
    distributedCoordination: false,
    getInternal,
    getSafeByTask,
    saveOrGet,
    schemaVersion: 1,
  });
}

function initializeDatabase(database) {
  database.exec(`
    PRAGMA busy_timeout = 5000;
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = FULL;
    CREATE TABLE IF NOT EXISTS hr_training_capability_run_input_schema (
      singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
      version INTEGER NOT NULL CHECK (version = 1)
    );
    INSERT INTO hr_training_capability_run_input_schema (singleton, version)
    VALUES (1, 1)
    ON CONFLICT(singleton) DO NOTHING;
    CREATE TABLE IF NOT EXISTS hr_training_capability_run_inputs (
      tenant_scope TEXT NOT NULL,
      capability TEXT NOT NULL,
      idempotency_digest TEXT NOT NULL,
      run_input_id TEXT NOT NULL,
      contract_version TEXT NOT NULL,
      session_id TEXT NOT NULL,
      meeting_record_id TEXT NOT NULL,
      evaluation_ref TEXT NOT NULL,
      context_origin TEXT NOT NULL,
      callback_origin TEXT NOT NULL,
      context_url_digest TEXT NOT NULL,
      callback_url_digest TEXT NOT NULL,
      payload_hmac_digest TEXT NOT NULL,
      encryption_key_id TEXT NOT NULL,
      encryption_algorithm TEXT NOT NULL CHECK (encryption_algorithm = 'aes-256-gcm'),
      ciphertext TEXT NOT NULL,
      created_at TEXT NOT NULL,
      task_id TEXT,
      trigger_event_id TEXT,
      PRIMARY KEY (tenant_scope, capability, idempotency_digest),
      UNIQUE (tenant_scope, run_input_id),
      UNIQUE (tenant_scope, task_id)
    );
    CREATE INDEX IF NOT EXISTS hr_training_capability_run_inputs_task_idx
      ON hr_training_capability_run_inputs (tenant_scope, task_id);
  `);
  const schema = database.prepare(
    "SELECT version FROM hr_training_capability_run_input_schema WHERE singleton = 1",
  ).get();
  if (schema?.version !== 1) throw new TypeError("unsupported HR Training capability input SQLite schema version");
  const columns = database.prepare("PRAGMA table_info(hr_training_capability_run_inputs)").all()
    .map((column) => column.name);
  const expected = [
    "tenant_scope",
    "capability",
    "idempotency_digest",
    "run_input_id",
    "contract_version",
    "session_id",
    "meeting_record_id",
    "evaluation_ref",
    "context_origin",
    "callback_origin",
    "context_url_digest",
    "callback_url_digest",
    "payload_hmac_digest",
    "encryption_key_id",
    "encryption_algorithm",
    "ciphertext",
    "created_at",
    "task_id",
    "trigger_event_id",
  ];
  if (!isDeepStrictEqual(columns, expected)) {
    throw new TypeError("invalid HR Training capability input SQLite schema v1");
  }
}

function normalizeInput(value) {
  requireExactObject(value, INPUT_FIELDS, "hr_training_capability_input_invalid");
  if (value.contractVersion !== CONTRACT_VERSION) {
    throw repositoryError("hr_training_capability_input_contract_invalid");
  }
  const contextUrl = requiredHttpUrl(value.contextUrl, "contextUrl", { forbidCredentialParams: true });
  const callbackUrl = requiredHttpUrl(value.callbackUrl, "callbackUrl", { scanSecretValue: false });
  return Object.freeze({
    contractVersion: CONTRACT_VERSION,
    tenantScope: requiredToken(value.tenantScope, "tenantScope", 160),
    capability: requiredToken(value.capability, "capability", 120),
    idempotencyKey: requiredToken(value.idempotencyKey, "idempotencyKey", 240),
    sessionId: requiredToken(value.sessionId, "sessionId", 160),
    meetingRecordId: requiredToken(value.meetingRecordId, "meetingRecordId", 160),
    contextUrl,
    callbackUrl,
  });
}

function identityOf(value) {
  return Object.freeze({
    tenantScope: value.tenantScope,
    capability: value.capability,
    idempotencyKey: value.idempotencyKey,
  });
}

function inputFromInternal(value) {
  return deepFreeze({
    contractVersion: CONTRACT_VERSION,
    tenantScope: value.tenantScope,
    capability: value.capability,
    idempotencyKey: value.idempotencyKey,
    sessionId: value.sessionId,
    meetingRecordId: value.meetingRecordId,
    contextUrl: value.contextUrl,
    callbackUrl: value.callbackUrl,
  });
}

function safeProjection(value) {
  return Object.freeze({
    contractVersion: "hr-training-capability-run-input-safe.v1",
    tenantScope: value.tenantScope,
    capability: value.capability,
    evaluationRef: value.evaluationRef,
    sessionRef: safeOpaqueRef("session", value.sessionId),
    meetingRecordRef: safeOpaqueRef("meeting", value.meetingRecordId),
    contextOrigin: value.contextOrigin,
    callbackOrigin: value.callbackOrigin,
    contextUrlDigest: value.contextUrlDigest,
    callbackUrlDigest: value.callbackUrlDigest,
    createdAt: value.createdAt,
    taskId: value.taskId,
    triggerEventId: value.triggerEventId,
  });
}

function safeOpaqueRef(prefix, value) {
  return `${prefix}:${crypto.createHash("sha256")
    .update(String(value || ""), "utf8")
    .digest("hex")
    .slice(0, 12)}`;
}

function deriveRunInputId(key, identity) {
  const idempotencyDigest = identity.idempotencyKeyDigest || keyedDigest(
    key,
    "hr-training-capability-input-idempotency.v1",
    [identity.tenantScope, identity.capability, identity.idempotencyKey],
  );
  return `hrtrain_run_${keyedDigest(key, "hr-training-capability-input-id.v1", [
    identity.tenantScope,
    identity.capability,
    idempotencyDigest,
  ])}`;
}

function authenticatedMetadata(value) {
  return Object.freeze({
    callbackUrlDigest: value.callbackUrlDigest,
    capability: value.capability,
    contextUrlDigest: value.contextUrlDigest,
    createdAt: value.createdAt,
    encryptionAlgorithm: ENCRYPTION_ALGORITHM,
    encryptionKeyId: value.encryptionKeyId,
    idempotencyDigest: value.idempotencyDigest,
    payloadHmacDigest: value.payloadHmacDigest,
    runInputId: value.runInputId,
    tenantScope: value.tenantScope,
  });
}

function requiredHttpUrl(value, field, { forbidCredentialParams = false, scanSecretValue = true } = {}) {
  if (typeof value !== "string" || value !== value.trim() || !value ||
    value.length > MAX_URL_CHARS || (scanSecretValue && SECRET_VALUE.test(value))) {
    throw repositoryError(`hr_training_capability_input_${field}_invalid`);
  }
  let url;
  try {
    url = new URL(value);
  } catch {
    throw repositoryError(`hr_training_capability_input_${field}_invalid`);
  }
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.hash) {
    throw repositoryError(`hr_training_capability_input_${field}_invalid`);
  }
  if (forbidCredentialParams) {
    for (const key of url.searchParams.keys()) {
      if (CREDENTIAL_QUERY_KEY.test(key)) {
        throw repositoryError("hr_training_capability_input_context_url_contains_credential");
      }
    }
  }
  return url.toString();
}

function originOf(value) {
  return new URL(value).origin;
}

function requiredOrigin(value) {
  if (typeof value !== "string" || value !== value.trim() || value.length > 240) {
    throw repositoryError("hr_training_capability_input_integrity_invalid");
  }
  const url = new URL(value);
  if (url.origin !== value) throw repositoryError("hr_training_capability_input_integrity_invalid");
  return value;
}

function requiredSafeRef(value) {
  if (typeof value !== "string" || !/^HRT-[A-F0-9]{10}$/.test(value)) {
    throw repositoryError("hr_training_capability_input_integrity_invalid");
  }
  return value;
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
      throw new Error("invalid encrypted input envelope");
    }
    const decipher = crypto.createDecipheriv(ENCRYPTION_ALGORITHM, key, parts[0]);
    decipher.setAAD(Buffer.from(aad, "utf8"));
    decipher.setAuthTag(parts[1]);
    return Buffer.concat([decipher.update(parts[2]), decipher.final()]).toString("utf8");
  } catch {
    throw repositoryError("hr_training_capability_input_decryption_failed");
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
  if (json === undefined) throw repositoryError("hr_training_capability_input_json_invalid");
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

function requiredToken(value, field, maximum) {
  if (typeof value !== "string" || value !== value.trim() || !value ||
    value.length > maximum || !TOKEN.test(value) || SECRET_VALUE.test(value)) {
    throw repositoryError("hr_training_capability_input_reference_invalid", field);
  }
  return value;
}

function requiredDigest(value) {
  const digest = String(value || "").trim().toLowerCase();
  if (!DIGEST.test(digest)) throw repositoryError("hr_training_capability_input_integrity_invalid");
  return digest;
}

function requiredTimestamp(value) {
  if (typeof value !== "string") throw repositoryError("hr_training_capability_input_integrity_invalid");
  const timestamp = new Date(value);
  if (!Number.isFinite(timestamp.getTime()) || timestamp.toISOString() !== value) {
    throw repositoryError("hr_training_capability_input_integrity_invalid");
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
    throw repositoryError("hr_training_capability_input_clock_invalid");
  }
}

function exactKey(value, field) {
  const key = Buffer.isBuffer(value) ? Buffer.from(value) : Buffer.from(value || []);
  if (key.length !== 32) throw repositoryError("hr_training_capability_input_key_invalid", field);
  return key;
}

function requiredDatabasePath(value) {
  const text = String(value || "").trim();
  if (text === ":memory:") return text;
  if (!text || !path.isAbsolute(text)) {
    throw new TypeError("HR Training capability input databasePath must be absolute or :memory:");
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
  CONTRACT_VERSION as HR_TRAINING_CAPABILITY_RUN_INPUT_CONTRACT_VERSION,
  REPOSITORY_VERSION as HR_TRAINING_CAPABILITY_RUN_INPUT_REPOSITORY_VERSION,
  createSqliteHrTrainingCapabilityRunInputRepository,
};
