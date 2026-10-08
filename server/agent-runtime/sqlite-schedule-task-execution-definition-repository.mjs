import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { isDeepStrictEqual } from "node:util";
import {
  normalizeScheduleTaskExecutionDefinition,
  projectScheduleTaskExecutionDefinitionSafe,
} from "./schedule-task-execution-definition.mjs";

const PUBLISH_FIELDS = new Set(["definition", "tenantScope"]);
const READ_FIELDS = new Set(["executionContractDigest", "taskDefinitionId", "tenantScope"]);
const VERSION_READ_FIELDS = new Set(["taskDefinitionId", "taskDefinitionVersion", "tenantScope"]);
const TOKEN = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,159}$/;
const DIGEST = /^[a-f0-9]{64}$/;
const SCHEMA_TABLE_SQL = `CREATE TABLE schedule_task_execution_definition_schema (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  version INTEGER NOT NULL CHECK (version = 1)
)`;
const DEFINITION_TABLE_SQL = `CREATE TABLE schedule_task_execution_definitions (
  tenant_scope TEXT NOT NULL,
  task_definition_id TEXT NOT NULL,
  task_definition_version INTEGER NOT NULL CHECK (task_definition_version > 0),
  execution_contract_digest TEXT NOT NULL,
  ciphertext TEXT NOT NULL,
  encryption_key_id TEXT NOT NULL,
  encryption_algorithm TEXT NOT NULL CHECK (encryption_algorithm = 'aes-256-gcm'),
  published_at TEXT NOT NULL,
  PRIMARY KEY (tenant_scope, execution_contract_digest),
  UNIQUE (tenant_scope, task_definition_id, task_definition_version)
)`;
const SCHEMA_SQL = `${SCHEMA_TABLE_SQL};
INSERT INTO schedule_task_execution_definition_schema VALUES (1, 1);
${DEFINITION_TABLE_SQL};`;

export function createSqliteScheduleTaskExecutionDefinitionRepository({
  databasePath,
  encryptionKeys,
  currentEncryptionKeyId,
  stableIntegrityHmacKey,
  now = () => new Date(),
} = {}) {
  const dbPath = normalizeDatabasePath(databasePath);
  if (dbPath !== ":memory:") fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const keyring = normalizeKeyring(encryptionKeys);
  const currentKeyId = token(currentEncryptionKeyId, "currentEncryptionKeyId");
  if (!keyring.has(currentKeyId)) throw repositoryError("schedule_task_definition_current_key_unavailable");
  // This stable key owns the content address. Rotate encryption keys independently; changing this key
  // requires an explicit schema migration because activated snapshots retain the old digest.
  const integrityKey = exactKey(stableIntegrityHmacKey, "stableIntegrityHmacKey");
  if (typeof now !== "function") throw repositoryError("schedule_task_definition_clock_invalid");
  const database = new DatabaseSync(dbPath);
  try { initialize(database); } catch (error) { database.close(); throw error; }

  function publish(value = {}) {
    exactObject(value, PUBLISH_FIELDS, "schedule_task_definition_publish_request_invalid");
    const tenantScope = token(value.tenantScope, "tenantScope");
    const definition = normalizeScheduleTaskExecutionDefinition(value.definition);
    const executionContractDigest = definitionDigest(integrityKey, tenantScope, definition);
    const publishedAt = trustedNow(now);
    const candidate = { definition, executionContractDigest, publishedAt, tenantScope };
    const aad = buildAad(candidate, currentKeyId);
    const ciphertext = encrypt(keyring.get(currentKeyId), canonicalJson(definition), aad);

    return transaction(database, () => {
      const existing = readLogicalRow(
        database,
        tenantScope,
        definition.taskDefinitionId,
        definition.taskDefinitionVersion,
      );
      if (existing) {
        const authenticated = authenticateRow(existing, keyring, integrityKey);
        if (!isDeepStrictEqual(authenticated.definition, definition) ||
          authenticated.executionContractDigest !== executionContractDigest) {
          throw repositoryError("schedule_task_definition_version_conflict");
        }
        return Object.freeze({ created: false, definition: projectSafe(existing, authenticated.definition) });
      }
      const digestConflict = readDigestRow(database, tenantScope, executionContractDigest);
      if (digestConflict) {
        authenticateRow(digestConflict, keyring, integrityKey);
        throw repositoryError("schedule_task_definition_digest_conflict");
      }
      database.prepare(`INSERT INTO schedule_task_execution_definitions (
        tenant_scope, task_definition_id, task_definition_version, execution_contract_digest,
        ciphertext, encryption_key_id, encryption_algorithm, published_at
      ) VALUES (?, ?, ?, ?, ?, ?, 'aes-256-gcm', ?)`
      ).run(
        tenantScope,
        definition.taskDefinitionId,
        definition.taskDefinitionVersion,
        executionContractDigest,
        ciphertext,
        currentKeyId,
        publishedAt,
      );
      const row = readDigestRow(database, tenantScope, executionContractDigest);
      const authenticated = authenticateRow(row, keyring, integrityKey);
      return Object.freeze({ created: true, definition: projectSafe(row, authenticated.definition) });
    });
  }

  // Configuration publication is inert until a separately authorized registry
  // write binds it. Failed registry writes must not poison the next version.
  function publishNext({ tenantScope: value, definition: input } = {}) {
    const tenantScope = token(value, "tenantScope");
    const taskDefinitionId = token(input?.taskDefinitionId, "taskDefinitionId");
    const latest = database.prepare(`SELECT * FROM schedule_task_execution_definitions
      WHERE tenant_scope = ? AND task_definition_id = ? ORDER BY task_definition_version DESC LIMIT 1`)
      .get(tenantScope, taskDefinitionId);
    if (latest) {
      const authenticated = authenticateRow(latest, keyring, integrityKey);
      const candidate = normalizeScheduleTaskExecutionDefinition({ ...input, taskDefinitionVersion: latest.task_definition_version });
      if (isDeepStrictEqual(authenticated.definition, candidate)) {
        return Object.freeze({ created: false, definition: projectSafe(latest, authenticated.definition) });
      }
    }
    return publish({ tenantScope, definition: { ...input, taskDefinitionVersion: Number(latest?.task_definition_version || 0) + 1 } });
  }

  function resolveExact(value = {}) {
    const request = normalizeReadRequest(value);
    const row = readDigestRow(database, request.tenantScope, request.executionContractDigest);
    if (!row) return null;
    const authenticated = authenticateRow(row, keyring, integrityKey);
    if (authenticated.definition.taskDefinitionId !== request.taskDefinitionId) {
      throw repositoryError("schedule_task_definition_binding_mismatch");
    }
    return projectResolution(row, authenticated);
  }

  function resolveVersion(value = {}) {
    const request = normalizeVersionReadRequest(value);
    const row = readLogicalRow(
      database,
      request.tenantScope,
      request.taskDefinitionId,
      request.taskDefinitionVersion,
    );
    if (!row) return null;
    const authenticated = authenticateRow(row, keyring, integrityKey);
    return projectResolution(row, authenticated);
  }

  function getSafe(value = {}) {
    const resolved = resolveExact(value);
    if (!resolved) return null;
    return projectScheduleTaskExecutionDefinitionSafe({
      definition: resolved.definition,
      executionContractDigest: resolved.executionContractDigest,
      publishedAt: resolved.publishedAt,
    });
  }

  return Object.freeze({
    close: () => database.close(),
    contractVersion: "schedule-task-execution-definition-repository.v1",
    getSafe,
    publish,
    publishNext,
    resolveExact,
    resolveVersion,
  });
}

function normalizeVersionReadRequest(value) {
  exactObject(value, VERSION_READ_FIELDS, "schedule_task_definition_version_read_request_invalid");
  return {
    tenantScope: token(value.tenantScope, "tenantScope"),
    taskDefinitionId: token(value.taskDefinitionId, "taskDefinitionId"),
    taskDefinitionVersion: positiveInteger(value.taskDefinitionVersion, "taskDefinitionVersion"),
  };
}

function normalizeReadRequest(value) {
  exactObject(value, READ_FIELDS, "schedule_task_definition_read_request_invalid");
  return {
    tenantScope: token(value.tenantScope, "tenantScope"),
    taskDefinitionId: token(value.taskDefinitionId, "taskDefinitionId"),
    executionContractDigest: digest(value.executionContractDigest),
  };
}

function projectSafe(row, definition) {
  return projectScheduleTaskExecutionDefinitionSafe({
    definition,
    executionContractDigest: row.execution_contract_digest,
    publishedAt: row.published_at,
  });
}

function projectResolution(row, authenticated) {
  return deepFreeze({
    contractVersion: "schedule-task-execution-definition-resolution.v1",
    executionContractDigest: authenticated.executionContractDigest,
    definition: authenticated.definition,
    payloadBoundary: "internal_only",
    publishedAt: row.published_at,
  });
}

function authenticateRow(row, keyring, integrityKey) {
  validateStoredRow(row);
  const key = keyring.get(row.encryption_key_id);
  if (!key) throw repositoryError("schedule_task_definition_encryption_key_unavailable");
  const plaintext = decrypt(key, row.ciphertext, buildAad({
    tenantScope: row.tenant_scope,
    definition: {
      taskDefinitionId: row.task_definition_id,
      taskDefinitionVersion: row.task_definition_version,
    },
    executionContractDigest: row.execution_contract_digest,
    publishedAt: row.published_at,
  }, row.encryption_key_id));
  let decoded;
  try { decoded = JSON.parse(plaintext); } catch {
    throw repositoryError("schedule_task_definition_plaintext_invalid");
  }
  let definition;
  try { definition = normalizeScheduleTaskExecutionDefinition(decoded); } catch {
    throw repositoryError("schedule_task_definition_integrity_invalid");
  }
  const expectedDigest = definitionDigest(integrityKey, row.tenant_scope, definition);
  if (definition.taskDefinitionId !== row.task_definition_id ||
    definition.taskDefinitionVersion !== row.task_definition_version ||
    expectedDigest !== row.execution_contract_digest) {
    throw repositoryError("schedule_task_definition_integrity_invalid");
  }
  return { definition, executionContractDigest: expectedDigest };
}

function buildAad(candidate, encryptionKeyId) {
  return canonicalJson({
    contractVersion: "schedule-task-execution-definition-ciphertext.v1",
    tenantScope: candidate.tenantScope,
    taskDefinitionId: candidate.definition.taskDefinitionId,
    taskDefinitionVersion: candidate.definition.taskDefinitionVersion,
    executionContractDigest: candidate.executionContractDigest,
    encryptionAlgorithm: "aes-256-gcm",
    encryptionKeyId,
    publishedAt: candidate.publishedAt,
  });
}

function definitionDigest(key, tenantScope, definition) {
  return keyedDigest(key, "schedule-task-execution-definition-authority.v1", [tenantScope, definition]);
}

function readLogicalRow(database, tenantScope, taskDefinitionId, taskDefinitionVersion) {
  return database.prepare(`SELECT * FROM schedule_task_execution_definitions
    WHERE tenant_scope=? AND task_definition_id=? AND task_definition_version=?`
  ).get(tenantScope, taskDefinitionId, taskDefinitionVersion) || null;
}

function readDigestRow(database, tenantScope, executionContractDigest) {
  return database.prepare(`SELECT * FROM schedule_task_execution_definitions
    WHERE tenant_scope=? AND execution_contract_digest=?`
  ).get(tenantScope, executionContractDigest) || null;
}

function validateStoredRow(row) {
  if (!row || row.encryption_algorithm !== "aes-256-gcm") {
    throw repositoryError("schedule_task_definition_integrity_invalid");
  }
  token(row.tenant_scope, "tenantScope");
  token(row.task_definition_id, "taskDefinitionId");
  positiveInteger(row.task_definition_version, "taskDefinitionVersion");
  digest(row.execution_contract_digest);
  timestamp(row.published_at);
}

function initialize(database) {
  database.exec("PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON");
  const tables = database.prepare(
    "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
  ).all().map((row) => row.name);
  if (tables.length === 0) transaction(database, () => database.exec(SCHEMA_SQL));
  validateSchema(database);
}

function validateSchema(database) {
  const objects = database.prepare(
    "SELECT type,name,tbl_name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name",
  ).all();
  if (objects.some((item) => item.type !== "table")) throw invalidSchema();
  const tables = objects.filter((item) => item.type === "table");
  if (!isDeepStrictEqual(tables.map((item) => item.name), [
    "schedule_task_execution_definition_schema", "schedule_task_execution_definitions",
  ])) throw invalidSchema();
  const schemaRows = database.prepare(
    "SELECT singleton,version FROM schedule_task_execution_definition_schema",
  ).all();
  if (schemaRows.length !== 1 || schemaRows[0].singleton !== 1 || schemaRows[0].version !== 1) {
    throw invalidSchema();
  }
  const expectedSql = new Map([
    ["schedule_task_execution_definition_schema", normalizeSql(SCHEMA_TABLE_SQL)],
    ["schedule_task_execution_definitions", normalizeSql(DEFINITION_TABLE_SQL)],
  ]);
  for (const table of tables) {
    if (normalizeSql(table.sql) !== expectedSql.get(table.name)) throw invalidSchema();
  }
  requireIndexes(database, "schedule_task_execution_definition_schema", []);
  requireIndexes(database, "schedule_task_execution_definitions", [
    ["pk", 1, ["tenant_scope", "execution_contract_digest"], false],
    ["u", 1, ["tenant_scope", "task_definition_id", "task_definition_version"], false],
  ]);
}

function requireIndexes(database, table, expected) {
  const actual = database.prepare(`PRAGMA index_list(${table})`).all().map((item) => [
    item.origin,
    item.unique,
    database.prepare(`PRAGMA index_info(${item.name})`).all()
      .sort((left, right) => left.seqno - right.seqno).map((part) => part.name),
    item.partial === 1,
  ]);
  const sort = (items) => items.toSorted((left, right) => canonicalJson(left).localeCompare(canonicalJson(right)));
  if (!isDeepStrictEqual(sort(actual), sort(expected))) throw invalidSchema();
}

function encrypt(key, plaintext, aad) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(Buffer.from(aad));
  const body = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return [iv, cipher.getAuthTag(), body].map((part) => part.toString("base64")).join(".");
}

function decrypt(key, value, aad) {
  try {
    const encoded = String(value).split(".");
    if (encoded.length !== 3 || encoded.some((part) => !/^[A-Za-z0-9+/]+={0,2}$/.test(part))) throw new Error();
    const [iv, tag, body] = encoded.map((part) => Buffer.from(part, "base64"));
    if (iv.length !== 12 || tag.length !== 16 || body.length === 0) throw new Error();
    const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
    decipher.setAAD(Buffer.from(aad));
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(body), decipher.final()]).toString("utf8");
  } catch {
    throw repositoryError("schedule_task_definition_decryption_failed");
  }
}

function normalizeKeyring(value) {
  const entries = value instanceof Map ? [...value] : Object.entries(value || {});
  if (!entries.length || entries.length > 32) throw repositoryError("schedule_task_definition_keyring_invalid");
  return new Map(entries.map(([id, key]) => [token(id, "encryptionKeyId"), exactKey(key, "encryptionKey")]));
}

function exactKey(value, field) {
  const key = Buffer.isBuffer(value) ? Buffer.from(value) : Buffer.from(value || []);
  if (key.length !== 32) throw repositoryError("schedule_task_definition_key_invalid", field);
  return key;
}

function normalizeDatabasePath(value) {
  const result = String(value || "").trim();
  if (result === ":memory:") return result;
  if (!result || !path.isAbsolute(result)) {
    throw new TypeError("schedule task definition databasePath must be absolute or :memory:");
  }
  return path.normalize(result);
}

function normalizeSql(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function transaction(database, run) {
  database.exec("BEGIN IMMEDIATE");
  try {
    const result = run();
    database.exec("COMMIT");
    return result;
  } catch (error) {
    if (database.isTransaction) database.exec("ROLLBACK");
    throw error;
  }
}

function exactObject(value, fields, code) {
  if (!isPlainObject(value) || Object.keys(value).some((key) => !fields.has(key)) ||
    [...fields].some((key) => !Object.hasOwn(value, key))) {
    throw repositoryError(code);
  }
}

function token(value, field = "token") {
  const result = String(value || "").trim();
  if (!TOKEN.test(result) || /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(result)) {
    throw repositoryError("schedule_task_definition_token_invalid", field);
  }
  return result;
}

function digest(value) {
  const result = String(value || "").trim().toLowerCase();
  if (!DIGEST.test(result)) throw repositoryError("schedule_task_definition_digest_invalid");
  return result;
}

function positiveInteger(value, field) {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw repositoryError("schedule_task_definition_number_invalid", field);
  }
  return value;
}

function trustedNow(now) {
  try { return timestamp(now()); } catch (error) {
    if (error?.code) throw error;
    throw repositoryError("schedule_task_definition_clock_invalid");
  }
}

function timestamp(value) {
  const input = value instanceof Date ? value.toISOString() : String(value || "").trim();
  const parsed = new Date(input);
  if (!input || !Number.isFinite(parsed.getTime()) || parsed.toISOString() !== input) {
    throw repositoryError("schedule_task_definition_timestamp_invalid");
  }
  return input;
}

function keyedDigest(key, domain, parts) {
  return crypto.createHmac("sha256", key).update(canonicalJson([domain, ...parts])).digest("hex");
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) =>
      `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  const serialized = JSON.stringify(value);
  if (serialized === undefined) throw repositoryError("schedule_task_definition_value_invalid");
  return serialized;
}

function isPlainObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function deepFreeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    Object.values(value).forEach(deepFreeze);
  }
  return value;
}

function invalidSchema() {
  return new TypeError("invalid schedule task execution definition SQLite schema v1");
}

function repositoryError(code, detail = "") {
  const error = new Error(detail ? `${code}: ${detail}` : code);
  error.code = code;
  return error;
}
