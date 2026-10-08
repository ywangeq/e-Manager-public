import crypto from "node:crypto";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

const CONTRACT_VERSION = "schedule-alert-release-repository.v1";
const EVIDENCE_VERSION = "schedule-alert-release-authorization.v1";
const SCHEMA_VERSION = 1;
const CANDIDATE_FIELDS = new Set([
  "activationSnapshotDigest", "activationVersion", "alertId", "canonicalTaskId",
  "employeeId", "planDigest", "processingEvidenceDigest", "recipientGeneration",
  "recipientAuthorityDigest", "recipientAuthorityValidUntil", "recipientPrincipalDigest",
  "recipientResolutionDigest", "resultEvidenceDigest",
  "resultId", "resultReceiptDigest", "ruleId", "runId", "scheduleId",
  "tenantScope", "terminalEvidenceDigest",
]);
const READ_FIELDS = new Set(["alertId", "tenantScope"]);
const TOKEN = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,239}$/;
const DIGEST = /^[a-f0-9]{64}$/;
const SCHEMA_SQL = `CREATE TABLE schedule_alert_release_schema (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  schema_version INTEGER NOT NULL CHECK (schema_version = 1)
)`;
const RELEASE_SQL = `CREATE TABLE schedule_alert_releases (
  tenant_scope TEXT NOT NULL,
  release_id TEXT NOT NULL,
  alert_id TEXT NOT NULL,
  result_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  canonical_task_id TEXT NOT NULL,
  employee_id TEXT NOT NULL,
  schedule_id TEXT NOT NULL,
  activation_version INTEGER NOT NULL CHECK (activation_version > 0),
  activation_snapshot_digest TEXT NOT NULL,
  result_receipt_digest TEXT NOT NULL,
  terminal_evidence_digest TEXT NOT NULL,
  processing_evidence_digest TEXT NOT NULL,
  result_evidence_digest TEXT NOT NULL,
  plan_digest TEXT NOT NULL,
  rule_id TEXT NOT NULL,
  recipient_authority_digest TEXT NOT NULL,
  recipient_authority_valid_until TEXT NOT NULL,
  recipient_principal_digest TEXT NOT NULL,
  recipient_generation INTEGER NOT NULL CHECK (recipient_generation > 0),
  recipient_resolution_digest TEXT NOT NULL,
  authorized_at TEXT NOT NULL,
  integrity_hmac_digest TEXT NOT NULL,
  PRIMARY KEY (tenant_scope, release_id),
  UNIQUE (tenant_scope, alert_id),
  UNIQUE (tenant_scope, result_id, rule_id, recipient_principal_digest, recipient_generation)
)`;
const RUN_INDEX_SQL = `CREATE INDEX schedule_alert_release_run_idx
  ON schedule_alert_releases (tenant_scope, run_id, authorized_at, release_id)`;

function createSqliteScheduleAlertReleaseRepository({
  databasePath = ":memory:",
  now = () => new Date(),
  stableIntegrityHmacKey,
} = {}) {
  if (typeof now !== "function") throw new TypeError("Schedule alert release clock is required");
  const hmacKey = exactKey(stableIntegrityHmacKey);
  if (databasePath !== ":memory:") mkdirSync(path.dirname(databasePath), { recursive: true });
  const database = new DatabaseSync(databasePath);
  configure(database);
  initialize(database);
  validateSchema(database);

  function authorizeOrGet(value = {}) {
    const candidate = normalizeCandidate(value);
    database.exec("BEGIN IMMEDIATE");
    try {
      const existing = readRow(database, candidate.tenantScope, candidate.alertId);
      if (existing) {
        const authorization = authenticate(existing, hmacKey);
        if (canonicalJson(authorization.binding) !== canonicalJson(candidate)) {
          throw failure("schedule_alert_release_conflict");
        }
        database.exec("COMMIT");
        return Object.freeze({ authorization, created: false });
      }
      const authorizedAt = trustedTimestamp(now);
      if (Date.parse(candidate.recipientAuthorityValidUntil) <= Date.parse(authorizedAt)) {
        throw failure("schedule_alert_release_recipient_authority_expired");
      }
      const authorization = buildAuthorization(candidate, authorizedAt, hmacKey);
      database.prepare(`INSERT INTO schedule_alert_releases (
        tenant_scope,release_id,alert_id,result_id,run_id,canonical_task_id,employee_id,
        schedule_id,activation_version,activation_snapshot_digest,result_receipt_digest,
        terminal_evidence_digest,processing_evidence_digest,result_evidence_digest,plan_digest,
        rule_id,recipient_authority_digest,recipient_authority_valid_until,
        recipient_principal_digest,recipient_generation,recipient_resolution_digest,
        authorized_at,integrity_hmac_digest
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
        candidate.tenantScope, authorization.releaseId, candidate.alertId, candidate.resultId,
        candidate.runId, candidate.canonicalTaskId, candidate.employeeId, candidate.scheduleId,
        candidate.activationVersion, candidate.activationSnapshotDigest,
        candidate.resultReceiptDigest, candidate.terminalEvidenceDigest,
        candidate.processingEvidenceDigest, candidate.resultEvidenceDigest, candidate.planDigest,
        candidate.ruleId, candidate.recipientAuthorityDigest,
        candidate.recipientAuthorityValidUntil, candidate.recipientPrincipalDigest,
        candidate.recipientGeneration,
        candidate.recipientResolutionDigest, authorizedAt, authorization.integrityHmacDigest,
      );
      const stored = authenticate(readRow(database, candidate.tenantScope, candidate.alertId), hmacKey);
      database.exec("COMMIT");
      return Object.freeze({ authorization: stored, created: true });
    } catch (error) {
      try { database.exec("ROLLBACK"); } catch {}
      throw error;
    }
  }

  function get(value = {}) {
    exactObject(value, READ_FIELDS, "schedule_alert_release_read_invalid");
    const row = readRow(database, token(value.tenantScope), token(value.alertId));
    return row ? authenticate(row, hmacKey) : null;
  }

  function listAuthorized({ tenantScope, runId = null, limit = 100 } = {}) {
    const tenant = token(tenantScope);
    const safeRunId = runId === null ? null : token(runId);
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200) {
      throw failure("schedule_alert_release_limit_invalid");
    }
    return database.prepare(`SELECT * FROM schedule_alert_releases
      WHERE tenant_scope=? AND (? IS NULL OR run_id=?)
      ORDER BY authorized_at,release_id LIMIT ?`).all(tenant, safeRunId, safeRunId, limit)
      .map((row) => authenticate(row, hmacKey));
  }

  return Object.freeze({
    authorizeOrGet,
    close: () => database.close(),
    contractVersion: CONTRACT_VERSION,
    get,
    listAuthorized,
  });
}

function normalizeCandidate(value) {
  exactObject(value, CANDIDATE_FIELDS, "schedule_alert_release_candidate_invalid");
  return deepFreeze({
    activationSnapshotDigest: digest(value.activationSnapshotDigest),
    activationVersion: positiveInteger(value.activationVersion),
    alertId: token(value.alertId),
    canonicalTaskId: token(value.canonicalTaskId),
    employeeId: token(value.employeeId),
    planDigest: digest(value.planDigest),
    processingEvidenceDigest: digest(value.processingEvidenceDigest),
    recipientAuthorityDigest: digest(value.recipientAuthorityDigest),
    recipientAuthorityValidUntil: timestamp(value.recipientAuthorityValidUntil),
    recipientGeneration: positiveInteger(value.recipientGeneration),
    recipientPrincipalDigest: digest(value.recipientPrincipalDigest),
    recipientResolutionDigest: digest(value.recipientResolutionDigest),
    resultEvidenceDigest: digest(value.resultEvidenceDigest),
    resultId: token(value.resultId),
    resultReceiptDigest: digest(value.resultReceiptDigest),
    ruleId: token(value.ruleId),
    runId: token(value.runId),
    scheduleId: token(value.scheduleId),
    tenantScope: token(value.tenantScope),
    terminalEvidenceDigest: digest(value.terminalEvidenceDigest),
  });
}

function buildAuthorization(binding, authorizedAt, hmacKey) {
  const body = { binding, contractVersion: EVIDENCE_VERSION };
  const releaseId = `schedule_alert_release_${sha256(canonicalJson(body))}`;
  const integrityHmacDigest = keyedDigest(hmacKey, {
    authorizedAt,
    body,
    releaseId,
  });
  return deepFreeze({
    ...body,
    authorizedAt,
    integrityHmacDigest,
    releaseId,
    state: "authorized",
  });
}

function authenticate(row, hmacKey) {
  if (!row) throw failure("schedule_alert_release_integrity_invalid");
  const binding = normalizeCandidate({
    activationSnapshotDigest: row.activation_snapshot_digest,
    activationVersion: row.activation_version,
    alertId: row.alert_id,
    canonicalTaskId: row.canonical_task_id,
    employeeId: row.employee_id,
    planDigest: row.plan_digest,
    processingEvidenceDigest: row.processing_evidence_digest,
    recipientAuthorityDigest: row.recipient_authority_digest,
    recipientAuthorityValidUntil: row.recipient_authority_valid_until,
    recipientGeneration: row.recipient_generation,
    recipientPrincipalDigest: row.recipient_principal_digest,
    recipientResolutionDigest: row.recipient_resolution_digest,
    resultEvidenceDigest: row.result_evidence_digest,
    resultId: row.result_id,
    resultReceiptDigest: row.result_receipt_digest,
    ruleId: row.rule_id,
    runId: row.run_id,
    scheduleId: row.schedule_id,
    tenantScope: row.tenant_scope,
    terminalEvidenceDigest: row.terminal_evidence_digest,
  });
  const candidate = buildAuthorization(binding, timestamp(row.authorized_at), hmacKey);
  if (candidate.releaseId !== row.release_id ||
    !safeEqual(candidate.integrityHmacDigest, row.integrity_hmac_digest)) {
    throw failure("schedule_alert_release_integrity_invalid");
  }
  return candidate;
}

function readRow(database, tenantScope, alertId) {
  return database.prepare(`SELECT * FROM schedule_alert_releases
    WHERE tenant_scope=? AND alert_id=?`).get(tenantScope, alertId) || null;
}

function configure(database) {
  database.exec("PRAGMA foreign_keys=ON");
  database.exec("PRAGMA busy_timeout=5000");
  database.exec("PRAGMA synchronous=FULL");
  if (database.prepare("PRAGMA database_list").all()[0]?.file) database.exec("PRAGMA journal_mode=WAL");
}

function initialize(database) {
  const objects = userObjects(database);
  if (objects.length > 0) return;
  database.exec("BEGIN IMMEDIATE");
  try {
    database.exec(SCHEMA_SQL);
    database.exec(RELEASE_SQL);
    database.exec(RUN_INDEX_SQL);
    database.prepare("INSERT INTO schedule_alert_release_schema (singleton,schema_version) VALUES (1,?)")
      .run(SCHEMA_VERSION);
    database.exec("COMMIT");
  } catch (error) {
    try { database.exec("ROLLBACK"); } catch {}
    throw error;
  }
}

function validateSchema(database) {
  const objects = userObjects(database);
  const expected = new Map([
    ["index:schedule_alert_release_run_idx", RUN_INDEX_SQL],
    ["table:schedule_alert_release_schema", SCHEMA_SQL],
    ["table:schedule_alert_releases", RELEASE_SQL],
  ]);
  if (objects.length !== expected.size || objects.some((row) =>
    normalizeSql(row.sql) !== normalizeSql(expected.get(`${row.type}:${row.name}`)))) {
    throw failure("schedule_alert_release_schema_invalid");
  }
  const versions = database.prepare("SELECT * FROM schedule_alert_release_schema").all();
  if (versions.length !== 1 || versions[0].singleton !== 1 ||
    versions[0].schema_version !== SCHEMA_VERSION) {
    throw failure("schedule_alert_release_schema_invalid");
  }
}

function userObjects(database) {
  return database.prepare(`SELECT type,name,sql FROM sqlite_master
    WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name`).all();
}

function exactObject(value, fields, code) {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype ||
    Object.keys(value).length !== fields.size ||
    Object.keys(value).some((field) => !fields.has(field))) throw failure(code);
}

function token(value) {
  const result = String(value || "").trim();
  if (!TOKEN.test(result) || /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(result)) {
    throw failure("schedule_alert_release_reference_invalid");
  }
  return result;
}

function digest(value) {
  const result = String(value || "").trim().toLowerCase();
  if (!DIGEST.test(result)) throw failure("schedule_alert_release_digest_invalid");
  return result;
}

function positiveInteger(value) {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw failure("schedule_alert_release_number_invalid");
  }
  return value;
}

function timestamp(value) {
  const result = String(value || "").trim();
  const parsed = new Date(result);
  if (!result || !Number.isFinite(parsed.getTime()) || parsed.toISOString() !== result) {
    throw failure("schedule_alert_release_timestamp_invalid");
  }
  return result;
}

function trustedTimestamp(now) {
  let value;
  try { value = now(); } catch { throw failure("schedule_alert_release_clock_invalid"); }
  return timestamp(value instanceof Date ? value.toISOString() : value);
}

function exactKey(value) {
  const key = Buffer.isBuffer(value) ? Buffer.from(value) : Buffer.from(value || []);
  if (key.length !== 32) throw new TypeError("Schedule alert release HMAC key must be 32 bytes");
  return key;
}

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function keyedDigest(key, value) {
  return crypto.createHmac("sha256", key).update(canonicalJson(value)).digest("hex");
}

function safeEqual(left, right) {
  const a = Buffer.from(String(left || ""));
  const b = Buffer.from(String(right || ""));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) =>
      `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  const result = JSON.stringify(Object.is(value, -0) ? 0 : value);
  if (result === undefined) throw failure("schedule_alert_release_value_invalid");
  return result;
}

function normalizeSql(value) {
  return String(value || "").replace(/\s+/g, " ").trim().toLowerCase();
}

function deepFreeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    Object.values(value).forEach(deepFreeze);
  }
  return value;
}

function failure(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

export {
  CONTRACT_VERSION as SCHEDULE_ALERT_RELEASE_REPOSITORY_CONTRACT_VERSION,
  createSqliteScheduleAlertReleaseRepository,
};
