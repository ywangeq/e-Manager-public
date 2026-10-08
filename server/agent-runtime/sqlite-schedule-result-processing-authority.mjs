import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { isDeepStrictEqual } from "node:util";
import { normalizeScheduleResultContract } from "./schedule-result-contract.mjs";
import {
  createScheduleResultProcessingAuthority,
  normalizeScheduleResultAlertContract,
  normalizeScheduleResultProcessingAuthority,
  normalizeScheduleResultRetentionDefinition,
} from "./schedule-result-processing-contract.mjs";

const PUBLISH_FIELDS = new Set(["alertContract", "resultContract", "retentionDefinition", "tenantScope"]);
const RESOLVE_FIELDS = new Set(["processingAuthorityDigest", "tenantScope"]);
const DEFINITION_FIELDS = Object.freeze({
  result: new Set(["resultContractDigest", "tenantScope"]),
  alert: new Set(["alertContractDigest", "tenantScope"]),
  retention: new Set(["retentionDefinitionDigest", "tenantScope"]),
});
const TOKEN = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,159}$/;
const EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const SECRET = /^(?:bearer\s+|sk-|rk-|xox[baprs]-|gh[pousr]_|glpat-|ya29\.|eyJ)/i;
const DIGEST = /^[a-f0-9]{64}$/;

const SCHEMA_TABLE = `CREATE TABLE schedule_result_processing_schema (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  version INTEGER NOT NULL CHECK (version = 1)
)`;
const RESULT_TABLE = `CREATE TABLE schedule_result_contract_definitions (
  tenant_scope TEXT NOT NULL,
  contract_digest TEXT NOT NULL,
  logical_id TEXT NOT NULL,
  logical_version INTEGER NOT NULL CHECK (logical_version > 0),
  body_json TEXT NOT NULL,
  integrity_hmac TEXT NOT NULL,
  published_at TEXT NOT NULL,
  PRIMARY KEY (tenant_scope, contract_digest),
  UNIQUE (tenant_scope, logical_id, logical_version)
)`;
const ALERT_TABLE = `CREATE TABLE schedule_result_alert_contract_definitions (
  tenant_scope TEXT NOT NULL,
  contract_digest TEXT NOT NULL,
  logical_id TEXT NOT NULL,
  logical_version INTEGER NOT NULL CHECK (logical_version > 0),
  body_json TEXT NOT NULL,
  integrity_hmac TEXT NOT NULL,
  published_at TEXT NOT NULL,
  PRIMARY KEY (tenant_scope, contract_digest),
  UNIQUE (tenant_scope, logical_id, logical_version)
)`;
const RETENTION_TABLE = `CREATE TABLE schedule_result_retention_definitions (
  tenant_scope TEXT NOT NULL,
  definition_digest TEXT NOT NULL,
  logical_id TEXT NOT NULL,
  logical_version INTEGER NOT NULL CHECK (logical_version > 0),
  body_json TEXT NOT NULL,
  integrity_hmac TEXT NOT NULL,
  published_at TEXT NOT NULL,
  PRIMARY KEY (tenant_scope, definition_digest),
  UNIQUE (tenant_scope, logical_id, logical_version)
)`;
const AUTHORITY_TABLE = `CREATE TABLE schedule_result_processing_authorities (
  tenant_scope TEXT NOT NULL,
  processing_authority_digest TEXT NOT NULL,
  result_contract_digest TEXT NOT NULL,
  alert_contract_digest TEXT NOT NULL,
  retention_definition_digest TEXT NOT NULL,
  body_json TEXT NOT NULL,
  integrity_hmac TEXT NOT NULL,
  published_at TEXT NOT NULL,
  PRIMARY KEY (tenant_scope, processing_authority_digest),
  UNIQUE (tenant_scope, result_contract_digest, alert_contract_digest, retention_definition_digest),
  FOREIGN KEY (tenant_scope, result_contract_digest)
    REFERENCES schedule_result_contract_definitions (tenant_scope, contract_digest) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_scope, alert_contract_digest)
    REFERENCES schedule_result_alert_contract_definitions (tenant_scope, contract_digest) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_scope, retention_definition_digest)
    REFERENCES schedule_result_retention_definitions (tenant_scope, definition_digest) ON DELETE RESTRICT
)`;
const SCHEMA_SQL = `${SCHEMA_TABLE};
INSERT INTO schedule_result_processing_schema VALUES (1, 1);
${RESULT_TABLE};
${ALERT_TABLE};
${RETENTION_TABLE};
${AUTHORITY_TABLE};`;
const TABLE_SQL = new Map([
  ["schedule_result_alert_contract_definitions", ALERT_TABLE],
  ["schedule_result_contract_definitions", RESULT_TABLE],
  ["schedule_result_processing_authorities", AUTHORITY_TABLE],
  ["schedule_result_processing_schema", SCHEMA_TABLE],
  ["schedule_result_retention_definitions", RETENTION_TABLE],
]);

export function createSqliteScheduleResultProcessingAuthority({
  databasePath, stableIntegrityHmacKey, now = () => new Date(),
} = {}) {
  const dbPath = normalizeDatabasePath(databasePath);
  if (dbPath !== ":memory:") fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const hmacKey = exactKey(stableIntegrityHmacKey);
  if (typeof now !== "function") throw failure("schedule_result_processing_clock_invalid");
  const database = new DatabaseSync(dbPath);
  try { initialize(database); } catch (error) { database.close(); throw error; }

  function publishBundle(value = {}) {
    exactObject(value, PUBLISH_FIELDS, "schedule_result_processing_publish_invalid");
    const tenantScope = safeToken(value.tenantScope);
    const resultContract = normalizeScheduleResultContract(value.resultContract);
    const alertContract = normalizeScheduleResultAlertContract(value.alertContract);
    const retentionDefinition = normalizeScheduleResultRetentionDefinition(value.retentionDefinition);
    const authority = createScheduleResultProcessingAuthority({ resultContract, alertContract, retentionDefinition });
    const publishedAt = trustedNow(now);
    return transaction(database, () => {
      const existingAuthority = database.prepare(`SELECT 1 FROM schedule_result_processing_authorities
        WHERE tenant_scope=? AND processing_authority_digest=?`).get(
        tenantScope, authority.processingAuthorityDigest,
      );
      if (existingAuthority) {
        const resolution = resolveStored(database, hmacKey, tenantScope, authority.processingAuthorityDigest);
        if (canonicalJson(resolution.resultContract) !== canonicalJson(resultContract) ||
          canonicalJson(resolution.alertContract) !== canonicalJson(alertContract) ||
          canonicalJson(resolution.retentionDefinition) !== canonicalJson(retentionDefinition)) {
          throw failure("schedule_result_processing_authority_conflict");
        }
        return deepFreeze({ created: false, resolution });
      }
      let created = false;
      created = putDefinition(database, hmacKey, "result", tenantScope, resultContract, publishedAt) || created;
      created = putDefinition(database, hmacKey, "alert", tenantScope, alertContract, publishedAt) || created;
      created = putDefinition(database, hmacKey, "retention", tenantScope, retentionDefinition, publishedAt) || created;
      created = putAuthority(database, hmacKey, tenantScope, authority, publishedAt) || created;
      return deepFreeze({ created, resolution: resolveStored(database, hmacKey, tenantScope, authority.processingAuthorityDigest) });
    });
  }

  function resolveProcessingAuthority(value = {}) {
    exactObject(value, RESOLVE_FIELDS, "schedule_result_processing_resolve_invalid");
    return resolveStored(database, hmacKey, safeToken(value.tenantScope), digest(value.processingAuthorityDigest));
  }

  function resolveResultContract(value = {}) {
    exactObject(value, DEFINITION_FIELDS.result, "schedule_result_processing_resolve_invalid");
    return readDefinition(database, hmacKey, "result", safeToken(value.tenantScope), digest(value.resultContractDigest));
  }

  function resolveAlertContract(value = {}) {
    exactObject(value, DEFINITION_FIELDS.alert, "schedule_result_processing_resolve_invalid");
    return readDefinition(database, hmacKey, "alert", safeToken(value.tenantScope), digest(value.alertContractDigest));
  }

  function resolveRetentionDefinition(value = {}) {
    exactObject(value, DEFINITION_FIELDS.retention, "schedule_result_processing_resolve_invalid");
    return readDefinition(database, hmacKey, "retention", safeToken(value.tenantScope), digest(value.retentionDefinitionDigest));
  }

  return Object.freeze({
    close: () => database.close(),
    publishBundle,
    resolveAlertContract,
    resolveProcessingAuthority,
    resolveResultContract,
    resolveRetentionDefinition,
  });
}

const DEFINITIONS = Object.freeze({
  result: {
    table: "schedule_result_contract_definitions", digestColumn: "contract_digest",
    digestField: "contractDigest", idField: "resultContractId", versionField: "resultContractVersion",
    authorityColumn: "result_contract_digest", normalize: normalizeScheduleResultContract,
  },
  alert: {
    table: "schedule_result_alert_contract_definitions", digestColumn: "contract_digest",
    digestField: "alertContractDigest", idField: "alertContractId", versionField: "alertContractVersion",
    authorityColumn: "alert_contract_digest", normalize: normalizeScheduleResultAlertContract,
  },
  retention: {
    table: "schedule_result_retention_definitions", digestColumn: "definition_digest",
    digestField: "retentionDefinitionDigest", idField: "retentionDefinitionId",
    versionField: "retentionDefinitionVersion", authorityColumn: "retention_definition_digest",
    normalize: normalizeScheduleResultRetentionDefinition,
  },
});

function putDefinition(database, hmacKey, kind, tenantScope, value, publishedAt) {
  const definition = DEFINITIONS[kind];
  const definitionDigest = value[definition.digestField];
  const existing = database.prepare(
    `SELECT * FROM ${definition.table} WHERE tenant_scope=? AND ${definition.digestColumn}=?`,
  ).get(tenantScope, definitionDigest);
  if (existing) {
    const stored = authenticateDefinition(existing, hmacKey, kind);
    if (canonicalJson(stored) !== canonicalJson(value)) throw failure("schedule_result_processing_definition_conflict");
    return false;
  }
  const orphanedReference = database.prepare(`SELECT 1 FROM schedule_result_processing_authorities
    WHERE tenant_scope=? AND ${definition.authorityColumn}=?`).get(tenantScope, definitionDigest);
  if (orphanedReference) throw failure("schedule_result_processing_corrupt");
  const logical = database.prepare(
    `SELECT * FROM ${definition.table} WHERE tenant_scope=? AND logical_id=? AND logical_version=?`,
  ).get(tenantScope, value[definition.idField], value[definition.versionField]);
  if (logical) {
    authenticateDefinition(logical, hmacKey, kind);
    throw failure("schedule_result_processing_logical_version_conflict");
  }
  const bodyJson = canonicalJson(value);
  const integrityHmac = rowHmac(hmacKey, kind, [
    tenantScope, definitionDigest, value[definition.idField], value[definition.versionField], bodyJson, publishedAt,
  ]);
  database.prepare(`INSERT INTO ${definition.table} (
    tenant_scope,${definition.digestColumn},logical_id,logical_version,body_json,integrity_hmac,published_at
  ) VALUES (?,?,?,?,?,?,?)`).run(
    tenantScope, definitionDigest, value[definition.idField], value[definition.versionField],
    bodyJson, integrityHmac, publishedAt,
  );
  return true;
}

function putAuthority(database, hmacKey, tenantScope, authority, publishedAt) {
  const existing = database.prepare(`SELECT * FROM schedule_result_processing_authorities
    WHERE tenant_scope=? AND processing_authority_digest=?`).get(tenantScope, authority.processingAuthorityDigest);
  if (existing) {
    const stored = authenticateAuthority(existing, hmacKey);
    if (!isDeepStrictEqual(stored, authority)) throw failure("schedule_result_processing_authority_conflict");
    return false;
  }
  const bodyJson = canonicalJson(authority);
  const integrityHmac = rowHmac(hmacKey, "authority", [
    tenantScope, authority.processingAuthorityDigest, authority.resultContractDigest,
    authority.alertContractDigest, authority.retentionDefinitionDigest, bodyJson, publishedAt,
  ]);
  database.prepare(`INSERT INTO schedule_result_processing_authorities (
    tenant_scope,processing_authority_digest,result_contract_digest,alert_contract_digest,
    retention_definition_digest,body_json,integrity_hmac,published_at
  ) VALUES (?,?,?,?,?,?,?,?)`).run(
    tenantScope, authority.processingAuthorityDigest, authority.resultContractDigest,
    authority.alertContractDigest, authority.retentionDefinitionDigest, bodyJson, integrityHmac, publishedAt,
  );
  return true;
}

function resolveStored(database, hmacKey, tenantScope, authorityDigest) {
  const row = database.prepare(`SELECT * FROM schedule_result_processing_authorities
    WHERE tenant_scope=? AND processing_authority_digest=?`).get(tenantScope, authorityDigest);
  if (!row) return null;
  const storedAuthority = authenticateAuthority(row, hmacKey);
  const resultContract = readDefinition(database, hmacKey, "result", tenantScope, row.result_contract_digest);
  const alertContract = readDefinition(database, hmacKey, "alert", tenantScope, row.alert_contract_digest);
  const retentionDefinition = readDefinition(database, hmacKey, "retention", tenantScope, row.retention_definition_digest);
  if (!resultContract || !alertContract || !retentionDefinition) throw failure("schedule_result_processing_corrupt");
  const authority = normalizeScheduleResultProcessingAuthority(storedAuthority, {
    resultContract, alertContract, retentionDefinition,
  });
  return deepFreeze({
    contractVersion: "schedule-result-processing-resolution.v1",
    authority, resultContract, alertContract, retentionDefinition,
  });
}

function readDefinition(database, hmacKey, kind, tenantScope, definitionDigest) {
  const definition = DEFINITIONS[kind];
  const row = database.prepare(
    `SELECT * FROM ${definition.table} WHERE tenant_scope=? AND ${definition.digestColumn}=?`,
  ).get(tenantScope, definitionDigest);
  return row ? authenticateDefinition(row, hmacKey, kind) : null;
}

function authenticateDefinition(row, hmacKey, kind) {
  const definition = DEFINITIONS[kind];
  const expectedHmac = rowHmac(hmacKey, kind, [
    row.tenant_scope, row[definition.digestColumn], row.logical_id, row.logical_version,
    row.body_json, row.published_at,
  ]);
  if (!safeEqual(row.integrity_hmac, expectedHmac)) throw failure("schedule_result_processing_integrity_invalid");
  let parsed;
  try { parsed = JSON.parse(row.body_json); } catch { throw failure("schedule_result_processing_integrity_invalid"); }
  const normalized = definition.normalize(parsed);
  if (normalized[definition.digestField] !== row[definition.digestColumn] ||
    normalized[definition.idField] !== row.logical_id ||
    normalized[definition.versionField] !== row.logical_version || canonicalJson(normalized) !== row.body_json) {
    throw failure("schedule_result_processing_integrity_invalid");
  }
  return normalized;
}

function authenticateAuthority(row, hmacKey) {
  const expectedHmac = rowHmac(hmacKey, "authority", [
    row.tenant_scope, row.processing_authority_digest, row.result_contract_digest,
    row.alert_contract_digest, row.retention_definition_digest, row.body_json, row.published_at,
  ]);
  if (!safeEqual(row.integrity_hmac, expectedHmac)) throw failure("schedule_result_processing_integrity_invalid");
  let parsed;
  try { parsed = JSON.parse(row.body_json); } catch { throw failure("schedule_result_processing_integrity_invalid"); }
  if (parsed.processingAuthorityDigest !== row.processing_authority_digest ||
    parsed.resultContractDigest !== row.result_contract_digest ||
    parsed.alertContractDigest !== row.alert_contract_digest ||
    parsed.retentionDefinitionDigest !== row.retention_definition_digest ||
    canonicalJson(parsed) !== row.body_json) throw failure("schedule_result_processing_integrity_invalid");
  return parsed;
}

function initialize(database) {
  database.exec("PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON");
  const objects = userObjects(database);
  if (objects.length === 0) transaction(database, () => database.exec(SCHEMA_SQL));
  validateSchema(database);
}

function validateSchema(database) {
  const objects = userObjects(database);
  if (objects.some((item) => item.type !== "table") ||
    !isDeepStrictEqual(objects.map((item) => item.name), [...TABLE_SQL.keys()].sort())) throw invalidSchema();
  const version = database.prepare("SELECT singleton,version FROM schedule_result_processing_schema").all();
  if (version.length !== 1 || version[0].singleton !== 1 || version[0].version !== 1) throw invalidSchema();
  for (const item of objects) {
    if (normalizeSql(item.sql) !== normalizeSql(TABLE_SQL.get(item.name))) throw invalidSchema();
  }
  const expectedForeignKeys = [
    ["schedule_result_alert_contract_definitions", "tenant_scope", "tenant_scope", "RESTRICT"],
    ["schedule_result_alert_contract_definitions", "alert_contract_digest", "contract_digest", "RESTRICT"],
    ["schedule_result_contract_definitions", "tenant_scope", "tenant_scope", "RESTRICT"],
    ["schedule_result_contract_definitions", "result_contract_digest", "contract_digest", "RESTRICT"],
    ["schedule_result_retention_definitions", "tenant_scope", "tenant_scope", "RESTRICT"],
    ["schedule_result_retention_definitions", "retention_definition_digest", "definition_digest", "RESTRICT"],
  ];
  const actualForeignKeys = database.prepare("PRAGMA foreign_key_list(schedule_result_processing_authorities)").all()
    .map((item) => [item.table, item.from, item.to, item.on_delete])
    .sort((left, right) => canonicalJson(left).localeCompare(canonicalJson(right)));
  if (!isDeepStrictEqual(actualForeignKeys, expectedForeignKeys.toSorted(
    (left, right) => canonicalJson(left).localeCompare(canonicalJson(right)),
  ))) throw invalidSchema();
}

function userObjects(database) {
  return database.prepare(`SELECT type,name,sql FROM sqlite_master
    WHERE name NOT LIKE 'sqlite_%' ORDER BY name`).all();
}
function transaction(database, run) {
  database.exec("BEGIN IMMEDIATE");
  try { const result = run(); database.exec("COMMIT"); return result; }
  catch (error) { if (database.isTransaction) database.exec("ROLLBACK"); throw error; }
}
function exactObject(value, fields, code) {
  if (!plainObject(value)) throw failure(code);
  const keys = Object.keys(value);
  if (keys.length !== fields.size || keys.some((key) => !fields.has(key))) throw failure(code);
}
function plainObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
function safeToken(value) {
  const result = String(value || "").trim();
  if (!TOKEN.test(result) || EMAIL.test(result) || SECRET.test(result)) {
    throw failure("schedule_result_processing_reference_invalid");
  }
  return result;
}
function digest(value) {
  const result = String(value || "").trim().toLowerCase();
  if (!DIGEST.test(result)) throw failure("schedule_result_processing_digest_invalid");
  return result;
}
function exactKey(value) {
  const key = Buffer.isBuffer(value) ? Buffer.from(value) : Buffer.from(value || []);
  if (key.length !== 32) throw failure("schedule_result_processing_hmac_key_invalid");
  return key;
}
function rowHmac(key, kind, fields) {
  return crypto.createHmac("sha256", key)
    .update(canonicalJson(["schedule-result-processing-row.v1", kind, ...fields])).digest("hex");
}
function safeEqual(left, right) {
  const leftBuffer = Buffer.from(String(left || ""));
  const rightBuffer = Buffer.from(String(right || ""));
  return leftBuffer.length === rightBuffer.length && crypto.timingSafeEqual(leftBuffer, rightBuffer);
}
function canonicalJson(value) { return JSON.stringify(sortCanonical(value)); }
function sortCanonical(value) {
  if (Array.isArray(value)) return value.map(sortCanonical);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, sortCanonical(value[key])]));
}
function trustedNow(now) {
  try {
    const value = now();
    const timestamp = value instanceof Date ? value.toISOString() : String(value || "").trim();
    if (new Date(timestamp).toISOString() !== timestamp) throw new Error();
    return timestamp;
  } catch { throw failure("schedule_result_processing_clock_invalid"); }
}
function normalizeDatabasePath(value) {
  const result = String(value || "").trim();
  if (result === ":memory:") return result;
  if (!result || !path.isAbsolute(result)) throw new TypeError("processing authority databasePath must be absolute or :memory:");
  return path.normalize(result);
}
function normalizeSql(value) { return String(value || "").replace(/\s+/g, " ").trim(); }
function deepFreeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value); Object.values(value).forEach(deepFreeze);
  }
  return value;
}
function invalidSchema() { return new TypeError("invalid schedule result processing SQLite schema v1"); }
function failure(code) { const error = new Error(code); error.code = code; return error; }
