import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { DatabaseSync } from "node:sqlite";

const REPOSITORY_CONTRACT_VERSION = "trigger-business-locator-repository.v2";
const MATCH_CONTRACT_VERSION = "trigger-business-locator-match.v1";
const DISPLAY_CONTRACT_VERSION = "trigger-business-locator-display.v1";
const LOCATOR_TYPE = "contract_number";
const ENCRYPTION_ALGORITHM = "aes-256-gcm";
const TOKEN = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,239}$/;
const DIGEST = /^[a-f0-9]{64}$/;

function createSqliteTriggerBusinessLocatorRepository({
  databasePath,
  encryptionKey,
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
    throw repositoryError("trigger_business_locator_key_separation_required");
  }
  if (typeof now !== "function") throw repositoryError("trigger_business_locator_clock_invalid");
  if (safeDatabasePath !== ":memory:") fs.mkdirSync(path.dirname(safeDatabasePath), { recursive: true });
  const database = new DatabaseSync(safeDatabasePath);
  try {
    initializeDatabase(database);
  } catch (error) {
    database.close();
    throw error;
  }

  function record(value) {
    const normalized = normalizeRecord(value);
    const locatorDigest = locatorIndexDigest(safeIndexKey, normalized);
    const subjectDigest = subjectEvidenceDigest(safeIntegrityKey, normalized);
    const identity = identityOf(normalized);
    database.exec("BEGIN IMMEDIATE");
    try {
      const existingRow = readIdentityRow(identity);
      if (existingRow) {
        const existing = authenticateRow(existingRow);
        if (existing.locatorDigest !== locatorDigest || existing.subjectDigest !== subjectDigest ||
          existing.sourceSystemId !== normalized.sourceSystemId) {
          throw repositoryError("trigger_business_locator_idempotency_conflict");
        }
        database.exec("COMMIT");
        return Object.freeze({ created: false, match: safeMatch(existing) });
      }

      const observedAt = trustedNow(now);
      const locatorCiphertext = encryptLocatorValue(safeEncryptionKey, normalized.locatorValue,
        locatorEncryptionAad({
          ...identity,
          locatorDigest,
          observedAt,
          sourceSystemId: normalized.sourceSystemId,
          subjectDigest,
        }));
      const rowHmacDigest = rowIntegrityDigest(safeIntegrityKey, {
        ...identity,
        encryptionAlgorithm: ENCRYPTION_ALGORITHM,
        locatorCiphertext,
        locatorDigest,
        observedAt,
        sourceSystemId: normalized.sourceSystemId,
        subjectDigest,
      });
      database.prepare(`
        INSERT INTO trigger_business_locators (
          tenant_scope, locator_type, locator_digest, locator_ciphertext, encryption_algorithm,
          trigger_event_id, task_id, source_system_id, subject_hmac_digest, row_hmac_digest, observed_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        identity.tenantScope,
        identity.locatorType,
        locatorDigest,
        locatorCiphertext,
        ENCRYPTION_ALGORITHM,
        identity.triggerEventId,
        identity.taskId,
        normalized.sourceSystemId,
        subjectDigest,
        rowHmacDigest,
        observedAt,
      );
      const stored = authenticateRow(readIdentityRow(identity));
      database.exec("COMMIT");
      return Object.freeze({ created: true, match: safeMatch(stored) });
    } catch (error) {
      rollbackIfActive(database);
      throw error;
    }
  }

  function locateExact({ tenantScope, locatorType, locatorValue, limit = 20 } = {}) {
    const normalized = normalizeLookup({ tenantScope, locatorType, locatorValue, limit });
    const locatorDigest = locatorIndexDigest(safeIndexKey, normalized);
    return Object.freeze(database.prepare(`
      SELECT *
      FROM trigger_business_locators
      WHERE tenant_scope = ? AND locator_type = ? AND locator_digest = ?
      ORDER BY observed_at DESC, trigger_event_id DESC
      LIMIT ?
    `).all(
      normalized.tenantScope,
      normalized.locatorType,
      locatorDigest,
      normalized.limit,
    ).map((row) => safeMatch(authenticateRow(row))));
  }

  function getByTask({ tenantScope, taskId } = {}) {
    const normalized = normalizeTaskLookup({ tenantScope, taskId });
    const row = database.prepare(`
      SELECT *
      FROM trigger_business_locators
      WHERE tenant_scope = ? AND task_id = ?
      ORDER BY observed_at DESC, trigger_event_id DESC
      LIMIT 1
    `).get(normalized.tenantScope, normalized.taskId);
    return row ? displayMatch(authenticateRow(row)) : null;
  }

  function readIdentityRow(identity) {
    return database.prepare(`
      SELECT *
      FROM trigger_business_locators
      WHERE tenant_scope = ? AND locator_type = ? AND trigger_event_id = ? AND task_id = ?
    `).get(identity.tenantScope, identity.locatorType, identity.triggerEventId, identity.taskId) || null;
  }

  function authenticateRow(row) {
    const value = {
      tenantScope: requiredToken(row.tenant_scope),
      locatorType: requiredLocatorType(row.locator_type),
      locatorDigest: requiredDigest(row.locator_digest),
      locatorCiphertext: requiredCiphertext(row.locator_ciphertext),
      encryptionAlgorithm: requiredEncryptionAlgorithm(row.encryption_algorithm),
      triggerEventId: requiredToken(row.trigger_event_id),
      taskId: requiredToken(row.task_id),
      sourceSystemId: requiredToken(row.source_system_id),
      subjectDigest: requiredDigest(row.subject_hmac_digest),
      observedAt: requiredTimestamp(row.observed_at),
    };
    const expected = rowIntegrityDigest(safeIntegrityKey, value);
    if (!sameDigest(requiredDigest(row.row_hmac_digest), expected)) {
      throw repositoryError("trigger_business_locator_integrity_invalid");
    }
    const locatorValue = decryptLocatorValue(safeEncryptionKey, value.locatorCiphertext,
      locatorEncryptionAad(value));
    return Object.freeze({ ...value, locatorValue: requiredLocatorValue(locatorValue) });
  }

  return Object.freeze({
    adapterKind: "sqlite_encrypted_hmac_trigger_business_locator",
    close: () => database.close(),
    contractVersion: REPOSITORY_CONTRACT_VERSION,
    deploymentScope: "single_center",
    distributedCoordination: false,
    getByTask,
    locateExact,
    record,
    schemaVersion: 2,
  });
}

function initializeDatabase(database) {
  database.exec(`
    PRAGMA busy_timeout = 5000;
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = FULL;
    CREATE TABLE IF NOT EXISTS trigger_business_locator_schema (
      singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
      version INTEGER NOT NULL CHECK (version = 2)
    );
    INSERT INTO trigger_business_locator_schema (singleton, version)
    VALUES (1, 2)
    ON CONFLICT(singleton) DO NOTHING;
    CREATE TABLE IF NOT EXISTS trigger_business_locators (
      tenant_scope TEXT NOT NULL,
      locator_type TEXT NOT NULL CHECK (locator_type = 'contract_number'),
      locator_digest TEXT NOT NULL,
      locator_ciphertext TEXT NOT NULL,
      encryption_algorithm TEXT NOT NULL CHECK (encryption_algorithm = 'aes-256-gcm'),
      trigger_event_id TEXT NOT NULL,
      task_id TEXT NOT NULL,
      source_system_id TEXT NOT NULL,
      subject_hmac_digest TEXT NOT NULL,
      row_hmac_digest TEXT NOT NULL,
      observed_at TEXT NOT NULL,
      PRIMARY KEY (tenant_scope, locator_type, trigger_event_id, task_id)
    );
    CREATE INDEX IF NOT EXISTS trigger_business_locators_exact_lookup_idx
      ON trigger_business_locators (tenant_scope, locator_type, locator_digest, observed_at DESC);
  `);
  const schema = database.prepare(
    "SELECT version FROM trigger_business_locator_schema WHERE singleton = 1",
  ).get();
  if (schema?.version !== 2) throw new TypeError("unsupported Trigger business locator SQLite schema version");
  const columns = database.prepare("PRAGMA table_info(trigger_business_locators)").all()
    .map((column) => column.name);
  const expected = [
    "tenant_scope",
    "locator_type",
    "locator_digest",
    "locator_ciphertext",
    "encryption_algorithm",
    "trigger_event_id",
    "task_id",
    "source_system_id",
    "subject_hmac_digest",
    "row_hmac_digest",
    "observed_at",
  ];
  if (!isDeepStrictEqual(columns, expected)) {
    throw new TypeError("invalid Trigger business locator SQLite schema v2");
  }
}

function normalizeRecord(value) {
  requireExactObject(value, new Set([
    "locatorType",
    "locatorValue",
    "sourceSystemId",
    "subject",
    "taskId",
    "tenantScope",
    "triggerEventId",
  ]));
  requireExactObject(value.subject, new Set(["objectApiName", "objectId"]));
  return Object.freeze({
    tenantScope: requiredToken(value.tenantScope),
    locatorType: requiredLocatorType(value.locatorType),
    locatorValue: requiredLocatorValue(value.locatorValue),
    triggerEventId: requiredToken(value.triggerEventId),
    taskId: requiredToken(value.taskId),
    sourceSystemId: requiredToken(value.sourceSystemId),
    subject: Object.freeze({
      objectApiName: requiredToken(value.subject.objectApiName),
      objectId: requiredToken(value.subject.objectId),
    }),
  });
}

function normalizeLookup(value) {
  requireExactObject(value, new Set(["limit", "locatorType", "locatorValue", "tenantScope"]));
  if (!Number.isInteger(value.limit) || value.limit < 1 || value.limit > 100) {
    throw repositoryError("trigger_business_locator_limit_invalid");
  }
  return Object.freeze({
    tenantScope: requiredToken(value.tenantScope),
    locatorType: requiredLocatorType(value.locatorType),
    locatorValue: requiredLocatorValue(value.locatorValue),
    limit: value.limit,
  });
}

function normalizeTaskLookup(value) {
  requireExactObject(value, new Set(["taskId", "tenantScope"]));
  return Object.freeze({
    tenantScope: requiredToken(value.tenantScope),
    taskId: requiredToken(value.taskId),
  });
}

function identityOf(value) {
  return Object.freeze({
    tenantScope: value.tenantScope,
    locatorType: value.locatorType,
    triggerEventId: value.triggerEventId,
    taskId: value.taskId,
  });
}

function locatorIndexDigest(key, value) {
  return keyedDigest(key, "trigger-business-locator-index.v1", [
    value.tenantScope,
    value.locatorType,
    value.locatorValue,
  ]);
}

function subjectEvidenceDigest(key, value) {
  return keyedDigest(key, "trigger-business-locator-subject.v1", [
    value.tenantScope,
    value.triggerEventId,
    value.taskId,
    value.sourceSystemId,
    value.subject.objectApiName,
    value.subject.objectId,
  ]);
}

function rowIntegrityDigest(key, value) {
  return keyedDigest(key, "trigger-business-locator-row.v2", [
    value.tenantScope,
    value.locatorType,
    value.locatorDigest,
    value.locatorCiphertext,
    value.encryptionAlgorithm,
    value.triggerEventId,
    value.taskId,
    value.sourceSystemId,
    value.subjectDigest,
    value.observedAt,
  ]);
}

function locatorEncryptionAad(value) {
  return JSON.stringify(["trigger-business-locator-encryption.v1", [
    value.tenantScope,
    value.locatorType,
    value.locatorDigest,
    value.triggerEventId,
    value.taskId,
    value.sourceSystemId,
    value.subjectDigest,
    value.observedAt,
  ]]);
}

function safeMatch(value) {
  return Object.freeze({
    contractVersion: MATCH_CONTRACT_VERSION,
    tenantScope: value.tenantScope,
    locatorType: value.locatorType,
    triggerEventId: value.triggerEventId,
    taskId: value.taskId,
    sourceSystemId: value.sourceSystemId,
    observedAt: value.observedAt,
  });
}

function displayMatch(value) {
  return Object.freeze({
    contractVersion: DISPLAY_CONTRACT_VERSION,
    contractNumber: value.locatorValue,
    locatorType: value.locatorType,
    observedAt: value.observedAt,
    sourceSystemId: value.sourceSystemId,
    taskId: value.taskId,
    tenantScope: value.tenantScope,
    triggerEventId: value.triggerEventId,
  });
}

function encryptLocatorValue(key, plaintext, aad) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(ENCRYPTION_ALGORITHM, key, iv);
  cipher.setAAD(Buffer.from(aad, "utf8"));
  const body = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return [iv, cipher.getAuthTag(), body].map((part) => part.toString("base64")).join(".");
}

function decryptLocatorValue(key, envelope, aad) {
  try {
    const parts = envelope.split(".").map((part) => Buffer.from(part, "base64"));
    if (parts.length !== 3 || parts[0].length !== 12 || parts[1].length !== 16 || !parts[2].length) {
      throw new Error("invalid encrypted locator envelope");
    }
    const decipher = crypto.createDecipheriv(ENCRYPTION_ALGORITHM, key, parts[0]);
    decipher.setAAD(Buffer.from(aad, "utf8"));
    decipher.setAuthTag(parts[1]);
    return Buffer.concat([decipher.update(parts[2]), decipher.final()]).toString("utf8");
  } catch {
    throw repositoryError("trigger_business_locator_decryption_failed");
  }
}

function requiredDatabasePath(value) {
  if (value === ":memory:") return value;
  if (typeof value !== "string" || !path.isAbsolute(value)) {
    throw repositoryError("trigger_business_locator_database_path_invalid");
  }
  return path.normalize(value);
}

function exactKey(value, field) {
  if (!Buffer.isBuffer(value) || value.length !== 32) {
    throw repositoryError("trigger_business_locator_key_invalid", `${field} must be a 32-byte Buffer`);
  }
  return Buffer.from(value);
}

function requiredLocatorType(value) {
  if (value !== LOCATOR_TYPE) throw repositoryError("trigger_business_locator_type_invalid");
  return value;
}

function requiredLocatorValue(value) {
  if (typeof value !== "string" || value !== value.trim() || !value || value.length > 200 ||
    /[\u0000-\u001F\u007F]/.test(value)) {
    throw repositoryError("trigger_business_locator_value_invalid");
  }
  return value.normalize("NFC");
}

function requiredToken(value) {
  if (typeof value !== "string" || !TOKEN.test(value)) {
    throw repositoryError("trigger_business_locator_reference_invalid");
  }
  return value;
}

function requiredDigest(value) {
  if (typeof value !== "string" || !DIGEST.test(value)) {
    throw repositoryError("trigger_business_locator_integrity_invalid");
  }
  return value;
}

function requiredCiphertext(value) {
  if (typeof value !== "string" || value.length < 8 || value.length > 2_048 ||
    !/^[A-Za-z0-9+/=]+\.[A-Za-z0-9+/=]+\.[A-Za-z0-9+/=]+$/.test(value)) {
    throw repositoryError("trigger_business_locator_integrity_invalid");
  }
  return value;
}

function requiredEncryptionAlgorithm(value) {
  if (value !== ENCRYPTION_ALGORITHM) {
    throw repositoryError("trigger_business_locator_integrity_invalid");
  }
  return value;
}

function requiredTimestamp(value) {
  if (typeof value !== "string") throw repositoryError("trigger_business_locator_integrity_invalid");
  const timestamp = new Date(value);
  if (!Number.isFinite(timestamp.getTime()) || timestamp.toISOString() !== value) {
    throw repositoryError("trigger_business_locator_integrity_invalid");
  }
  return value;
}

function trustedNow(now) {
  const value = now();
  const timestamp = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(timestamp.getTime())) throw repositoryError("trigger_business_locator_clock_invalid");
  return timestamp.toISOString();
}

function requireExactObject(value, fields) {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(value)) ||
    Object.keys(value).length !== fields.size || Object.keys(value).some((field) => !fields.has(field))) {
    throw repositoryError("trigger_business_locator_value_invalid");
  }
}

function keyedDigest(key, domain, value) {
  return crypto.createHmac("sha256", key).update(JSON.stringify([domain, value])).digest("hex");
}

function sameDigest(left, right) {
  return crypto.timingSafeEqual(Buffer.from(left, "hex"), Buffer.from(right, "hex"));
}

function rollbackIfActive(database) {
  if (database.isTransaction) database.exec("ROLLBACK");
}

function repositoryError(code, message = code) {
  const error = new Error(message);
  error.code = code;
  return error;
}

export {
  DISPLAY_CONTRACT_VERSION,
  MATCH_CONTRACT_VERSION,
  REPOSITORY_CONTRACT_VERSION,
  createSqliteTriggerBusinessLocatorRepository,
};
