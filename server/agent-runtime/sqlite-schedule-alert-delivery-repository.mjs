import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

const CONTRACT_VERSION = "schedule-alert-delivery-repository.v1";
const DELIVERY_VERSION = "schedule-alert-delivery.v1";
const SCHEMA_VERSION = 1;
const CHANNEL_CLASSES = new Set(["enterprise_notification"]);
const UNKNOWN_CODES = new Set([
  "schedule_alert_delivery_authority_changed_after_dispatch",
  "schedule_alert_delivery_response_unknown",
  "schedule_alert_delivery_timeout_unknown",
  "schedule_alert_delivery_transport_unknown",
]);
const BINDING_FIELDS = new Set([
  "activationSnapshotDigest", "activationVersion", "alertId", "deliveryAuthorityValidUntil",
  "canonicalTaskId", "channelAuthorityDigest", "channelClass", "deliveryTargetEvidenceDigest",
  "employeeId", "planDigest", "presentationEvidenceDigest", "recipientAuthorityDigest",
  "recipientGeneration", "recipientPrincipalDigest", "recipientResolutionDigest", "releaseId", "resultId", "runId",
  "scheduleId", "tenantScope",
]);
const IDENTITY_FIELDS = new Set(["deliveryId", "tenantScope"]);
const ALERT_IDENTITY_FIELDS = new Set(["alertId", "tenantScope"]);
const BEGIN_FIELDS = new Set(["deliveryId", "expectedRecordVersion", "tenantScope"]);
const SENT_FIELDS = new Set([
  "deliveryId", "expectedRecordVersion", "remoteDeliveryEvidenceDigest", "tenantScope",
]);
const UNKNOWN_FIELDS = new Set([
  "deliveryId", "expectedRecordVersion", "safeFailureCode", "tenantScope",
]);
const TOKEN = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,239}$/;
const DIGEST = /^[a-f0-9]{64}$/;

const SCHEMA_SQL = `CREATE TABLE schedule_alert_delivery_schema (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  schema_version INTEGER NOT NULL CHECK (schema_version = 1)
)`;
const DELIVERY_SQL = `CREATE TABLE schedule_alert_deliveries (
  tenant_scope TEXT NOT NULL,
  delivery_id TEXT NOT NULL,
  delivery_request_id TEXT NOT NULL,
  release_id TEXT NOT NULL,
  alert_id TEXT NOT NULL,
  result_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  canonical_task_id TEXT NOT NULL,
  employee_id TEXT NOT NULL,
  schedule_id TEXT NOT NULL,
  activation_version INTEGER NOT NULL CHECK (activation_version > 0),
  activation_snapshot_digest TEXT NOT NULL,
  plan_digest TEXT NOT NULL,
  recipient_authority_digest TEXT NOT NULL,
  recipient_principal_digest TEXT NOT NULL,
  recipient_generation INTEGER NOT NULL CHECK (recipient_generation > 0),
  recipient_resolution_digest TEXT NOT NULL,
  channel_class TEXT NOT NULL CHECK (channel_class = 'enterprise_notification'),
  channel_authority_digest TEXT NOT NULL,
  delivery_target_evidence_digest TEXT NOT NULL,
  presentation_evidence_digest TEXT NOT NULL,
  delivery_authority_valid_until TEXT NOT NULL,
  delivery_state TEXT NOT NULL CHECK (
    delivery_state IN ('prepared','dispatch_prepared','sent','unknown')
  ),
  record_version INTEGER NOT NULL CHECK (record_version > 0),
  delivery_attempts INTEGER NOT NULL CHECK (delivery_attempts IN (0,1)),
  prepared_at TEXT NOT NULL,
  dispatch_prepared_at TEXT,
  terminal_at TEXT,
  remote_delivery_evidence_digest TEXT,
  safe_failure_code TEXT,
  integrity_hmac_digest TEXT NOT NULL,
  PRIMARY KEY (tenant_scope, delivery_id),
  UNIQUE (tenant_scope, delivery_request_id),
  UNIQUE (tenant_scope, release_id),
  UNIQUE (tenant_scope, alert_id),
  CHECK (
    (delivery_state = 'prepared' AND delivery_attempts = 0 AND dispatch_prepared_at IS NULL
      AND terminal_at IS NULL AND remote_delivery_evidence_digest IS NULL
      AND safe_failure_code IS NULL)
    OR
    (delivery_state = 'dispatch_prepared' AND delivery_attempts = 1
      AND dispatch_prepared_at IS NOT NULL AND terminal_at IS NULL
      AND remote_delivery_evidence_digest IS NULL AND safe_failure_code IS NULL)
    OR
    (delivery_state = 'sent' AND delivery_attempts = 1 AND dispatch_prepared_at IS NOT NULL
      AND terminal_at IS NOT NULL AND remote_delivery_evidence_digest IS NOT NULL
      AND safe_failure_code IS NULL)
    OR
    (delivery_state = 'unknown' AND delivery_attempts = 1 AND dispatch_prepared_at IS NOT NULL
      AND terminal_at IS NOT NULL AND remote_delivery_evidence_digest IS NULL
      AND safe_failure_code IS NOT NULL)
  )
)`;
const INCOMPLETE_INDEX_SQL = `CREATE INDEX schedule_alert_delivery_incomplete_idx
  ON schedule_alert_deliveries (tenant_scope, delivery_state, prepared_at, delivery_id)`;

function createSqliteScheduleAlertDeliveryRepository({
  databasePath = ":memory:",
  now = () => new Date(),
  stableIntegrityHmacKey,
} = {}) {
  const dbPath = normalizeDatabasePath(databasePath);
  const hmacKey = exactKey(stableIntegrityHmacKey);
  if (typeof now !== "function") throw new TypeError("Schedule alert delivery clock is required");
  if (dbPath !== ":memory:") fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const database = new DatabaseSync(dbPath);
  try {
    configure(database);
    initialize(database);
    validateSchema(database);
  } catch (error) {
    database.close();
    throw error;
  }

  function prepareOrGet(value = {}) {
    const binding = normalizeBinding(value);
    const identity = deliveryIdentity(binding);
    return transaction(database, () => {
      const existing = readCandidateRows(database, binding, identity);
      if (existing.length > 1) throw failure("schedule_alert_delivery_integrity_invalid");
      if (existing.length === 1) {
        const delivery = authenticate(existing[0], hmacKey);
        if (canonicalJson(delivery.binding) !== canonicalJson(binding)) {
          throw failure("schedule_alert_delivery_conflict");
        }
        return deepFreeze({ created: false, delivery });
      }
      const preparedAt = trustedTimestamp(now);
      if (Date.parse(binding.deliveryAuthorityValidUntil) <= Date.parse(preparedAt)) {
        throw failure("schedule_alert_delivery_authority_expired");
      }
      const delivery = buildDelivery({
        binding,
        ...identity,
        deliveryState: "prepared",
        dispatchPreparedAt: null,
        preparedAt,
        deliveryAttempts: 0,
        recordVersion: 1,
        remoteDeliveryEvidenceDigest: null,
        safeFailureCode: null,
        terminalAt: null,
      }, hmacKey);
      insertDelivery(database, delivery);
      return deepFreeze({
        created: true,
        delivery: authenticate(readRow(database, binding.tenantScope, delivery.deliveryId), hmacKey),
      });
    });
  }

  function beginDeliveryAttempt(value = {}) {
    exactObject(value, BEGIN_FIELDS, "schedule_alert_delivery_begin_invalid");
    const tenantScope = token(value.tenantScope);
    const deliveryId = token(value.deliveryId);
    const expectedRecordVersion = positiveInteger(value.expectedRecordVersion);
    return transaction(database, () => {
      const current = authenticateRequired(database, hmacKey, tenantScope, deliveryId);
      if (current.deliveryState !== "prepared") {
        return deepFreeze({ delivery: current, started: false });
      }
      if (current.recordVersion !== expectedRecordVersion) {
        throw failure("schedule_alert_delivery_fenced");
      }
      const dispatchPreparedAt = trustedTimestamp(now);
      if (dispatchPreparedAt < current.preparedAt) {
        throw failure("schedule_alert_delivery_clock_invalid");
      }
      if (Date.parse(current.binding.deliveryAuthorityValidUntil) <= Date.parse(dispatchPreparedAt)) {
        throw failure("schedule_alert_delivery_authority_expired");
      }
      const next = buildDelivery({
        ...stateFromDelivery(current),
        deliveryState: "dispatch_prepared",
        dispatchPreparedAt,
        deliveryAttempts: 1,
        recordVersion: current.recordVersion + 1,
      }, hmacKey);
      updateDelivery(database, next, current.recordVersion);
      return deepFreeze({
        delivery: authenticateRequired(database, hmacKey, tenantScope, deliveryId),
        started: true,
      });
    });
  }

  function commitSent(value = {}) {
    exactObject(value, SENT_FIELDS, "schedule_alert_delivery_sent_invalid");
    return commitTerminal({
      deliveryId: token(value.deliveryId),
      expectedRecordVersion: positiveInteger(value.expectedRecordVersion),
      outcome: "sent",
      remoteDeliveryEvidenceDigest: digest(value.remoteDeliveryEvidenceDigest),
      safeFailureCode: null,
      tenantScope: token(value.tenantScope),
    });
  }

  function markUnknown(value = {}) {
    exactObject(value, UNKNOWN_FIELDS, "schedule_alert_delivery_unknown_invalid");
    const safeFailureCode = token(value.safeFailureCode);
    if (!UNKNOWN_CODES.has(safeFailureCode)) {
      throw failure("schedule_alert_delivery_failure_code_invalid");
    }
    return commitTerminal({
      deliveryId: token(value.deliveryId),
      expectedRecordVersion: positiveInteger(value.expectedRecordVersion),
      outcome: "unknown",
      remoteDeliveryEvidenceDigest: null,
      safeFailureCode,
      tenantScope: token(value.tenantScope),
    });
  }

  function commitTerminal(candidate) {
    return transaction(database, () => {
      const current = authenticateRequired(
        database, hmacKey, candidate.tenantScope, candidate.deliveryId,
      );
      if (current.deliveryState === "sent" || current.deliveryState === "unknown") {
        if (current.deliveryState !== candidate.outcome ||
          current.remoteDeliveryEvidenceDigest !== candidate.remoteDeliveryEvidenceDigest ||
          current.safeFailureCode !== candidate.safeFailureCode) {
          throw failure("schedule_alert_delivery_outcome_conflict");
        }
        return deepFreeze({ committed: false, delivery: current });
      }
      if (current.deliveryState !== "dispatch_prepared" ||
        current.recordVersion !== candidate.expectedRecordVersion) {
        throw failure("schedule_alert_delivery_fenced");
      }
      const terminalAt = trustedTimestamp(now);
      if (terminalAt < current.dispatchPreparedAt) {
        throw failure("schedule_alert_delivery_clock_invalid");
      }
      const next = buildDelivery({
        ...stateFromDelivery(current),
        deliveryState: candidate.outcome,
        recordVersion: current.recordVersion + 1,
        remoteDeliveryEvidenceDigest: candidate.remoteDeliveryEvidenceDigest,
        safeFailureCode: candidate.safeFailureCode,
        terminalAt,
      }, hmacKey);
      updateDelivery(database, next, current.recordVersion);
      return deepFreeze({
        committed: true,
        delivery: authenticateRequired(
          database, hmacKey, candidate.tenantScope, candidate.deliveryId,
        ),
      });
    });
  }

  function get(value = {}) {
    exactObject(value, IDENTITY_FIELDS, "schedule_alert_delivery_read_invalid");
    const row = readRow(database, token(value.tenantScope), token(value.deliveryId));
    return row ? authenticate(row, hmacKey) : null;
  }

  function getByAlert(value = {}) {
    exactObject(value, ALERT_IDENTITY_FIELDS, "schedule_alert_delivery_read_invalid");
    const row = database.prepare(`SELECT * FROM schedule_alert_deliveries
      WHERE tenant_scope=? AND alert_id=?`).get(
      token(value.tenantScope), token(value.alertId),
    );
    return row ? authenticate(row, hmacKey) : null;
  }

  function listIncomplete({ tenantScope, limit = 100 } = {}) {
    const tenant = token(tenantScope);
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200) {
      throw failure("schedule_alert_delivery_limit_invalid");
    }
    return database.prepare(`SELECT * FROM schedule_alert_deliveries
      WHERE tenant_scope=? AND delivery_state!='sent'
      ORDER BY prepared_at,delivery_id LIMIT ?`).all(tenant, limit)
      .map((row) => authenticate(row, hmacKey));
  }

  return Object.freeze({
    beginDeliveryAttempt,
    close: () => database.close(),
    commitSent,
    contractVersion: CONTRACT_VERSION,
    get,
    getByAlert,
    listIncomplete,
    markUnknown,
    prepareOrGet,
  });
}

function normalizeBinding(value) {
  exactObject(value, BINDING_FIELDS, "schedule_alert_delivery_binding_invalid");
  const channelClass = token(value.channelClass);
  if (!CHANNEL_CLASSES.has(channelClass)) {
    throw failure("schedule_alert_delivery_channel_class_invalid");
  }
  return deepFreeze({
    activationSnapshotDigest: digest(value.activationSnapshotDigest),
    activationVersion: positiveInteger(value.activationVersion),
    alertId: token(value.alertId),
    deliveryAuthorityValidUntil: timestamp(value.deliveryAuthorityValidUntil),
    canonicalTaskId: token(value.canonicalTaskId),
    channelAuthorityDigest: digest(value.channelAuthorityDigest),
    channelClass,
    deliveryTargetEvidenceDigest: digest(value.deliveryTargetEvidenceDigest),
    employeeId: token(value.employeeId),
    planDigest: digest(value.planDigest),
    presentationEvidenceDigest: digest(value.presentationEvidenceDigest),
    recipientAuthorityDigest: digest(value.recipientAuthorityDigest),
    recipientGeneration: positiveInteger(value.recipientGeneration),
    recipientPrincipalDigest: digest(value.recipientPrincipalDigest),
    recipientResolutionDigest: digest(value.recipientResolutionDigest),
    releaseId: token(value.releaseId),
    resultId: token(value.resultId),
    runId: token(value.runId),
    scheduleId: token(value.scheduleId),
    tenantScope: token(value.tenantScope),
  });
}

function deliveryIdentity(binding) {
  const body = { binding, contractVersion: DELIVERY_VERSION };
  const identityDigest = sha256(canonicalJson(body));
  return Object.freeze({
    deliveryId: `schedule_alert_delivery_${identityDigest}`,
    deliveryRequestId: `schedule_alert_delivery_request_${identityDigest}`,
  });
}

function buildDelivery(value, hmacKey) {
  const body = {
    binding: value.binding,
    contractVersion: DELIVERY_VERSION,
    deliveryId: value.deliveryId,
    deliveryRequestId: value.deliveryRequestId,
    deliveryState: value.deliveryState,
    dispatchPreparedAt: value.dispatchPreparedAt,
    preparedAt: value.preparedAt,
    deliveryAttempts: value.deliveryAttempts,
    recordVersion: value.recordVersion,
    remoteDeliveryEvidenceDigest: value.remoteDeliveryEvidenceDigest,
    safeFailureCode: value.safeFailureCode,
    terminalAt: value.terminalAt,
  };
  return deepFreeze({
    ...body,
    integrityHmacDigest: keyedDigest(hmacKey, body),
  });
}

function stateFromDelivery(delivery) {
  return {
    binding: delivery.binding,
    deliveryId: delivery.deliveryId,
    deliveryRequestId: delivery.deliveryRequestId,
    dispatchPreparedAt: delivery.dispatchPreparedAt,
    preparedAt: delivery.preparedAt,
    deliveryAttempts: delivery.deliveryAttempts,
    recordVersion: delivery.recordVersion,
    remoteDeliveryEvidenceDigest: delivery.remoteDeliveryEvidenceDigest,
    safeFailureCode: delivery.safeFailureCode,
    terminalAt: delivery.terminalAt,
  };
}

function insertDelivery(database, delivery) {
  const binding = delivery.binding;
  database.prepare(`INSERT INTO schedule_alert_deliveries (
    tenant_scope,delivery_id,delivery_request_id,release_id,alert_id,result_id,run_id,
    canonical_task_id,employee_id,schedule_id,activation_version,activation_snapshot_digest,
    plan_digest,recipient_authority_digest,recipient_principal_digest,recipient_generation,recipient_resolution_digest,
    channel_class,channel_authority_digest,delivery_target_evidence_digest,
    presentation_evidence_digest,delivery_authority_valid_until,delivery_state,record_version,
    delivery_attempts,prepared_at,dispatch_prepared_at,terminal_at,
    remote_delivery_evidence_digest,safe_failure_code,integrity_hmac_digest
  ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    binding.tenantScope, delivery.deliveryId, delivery.deliveryRequestId, binding.releaseId,
    binding.alertId, binding.resultId, binding.runId, binding.canonicalTaskId, binding.employeeId,
    binding.scheduleId, binding.activationVersion, binding.activationSnapshotDigest,
    binding.planDigest, binding.recipientAuthorityDigest, binding.recipientPrincipalDigest,
    binding.recipientGeneration,
    binding.recipientResolutionDigest, binding.channelClass, binding.channelAuthorityDigest,
    binding.deliveryTargetEvidenceDigest, binding.presentationEvidenceDigest,
    binding.deliveryAuthorityValidUntil, delivery.deliveryState, delivery.recordVersion,
    delivery.deliveryAttempts, delivery.preparedAt, delivery.dispatchPreparedAt,
    delivery.terminalAt, delivery.remoteDeliveryEvidenceDigest, delivery.safeFailureCode,
    delivery.integrityHmacDigest,
  );
}

function updateDelivery(database, delivery, expectedRecordVersion) {
  const result = database.prepare(`UPDATE schedule_alert_deliveries SET
    delivery_state=?,record_version=?,delivery_attempts=?,dispatch_prepared_at=?,terminal_at=?,
    remote_delivery_evidence_digest=?,safe_failure_code=?,integrity_hmac_digest=?
    WHERE tenant_scope=? AND delivery_id=? AND record_version=?`).run(
    delivery.deliveryState, delivery.recordVersion, delivery.deliveryAttempts,
    delivery.dispatchPreparedAt, delivery.terminalAt, delivery.remoteDeliveryEvidenceDigest,
    delivery.safeFailureCode, delivery.integrityHmacDigest, delivery.binding.tenantScope,
    delivery.deliveryId, expectedRecordVersion,
  );
  if (result.changes !== 1) throw failure("schedule_alert_delivery_fenced");
}

function authenticateRequired(database, hmacKey, tenantScope, deliveryId) {
  const row = readRow(database, tenantScope, deliveryId);
  if (!row) throw failure("schedule_alert_delivery_not_found");
  return authenticate(row, hmacKey);
}

function authenticate(row, hmacKey) {
  let delivery;
  try {
    const binding = normalizeBinding({
      activationSnapshotDigest: row.activation_snapshot_digest,
      activationVersion: row.activation_version,
      alertId: row.alert_id,
      deliveryAuthorityValidUntil: row.delivery_authority_valid_until,
      canonicalTaskId: row.canonical_task_id,
      channelAuthorityDigest: row.channel_authority_digest,
      channelClass: row.channel_class,
      deliveryTargetEvidenceDigest: row.delivery_target_evidence_digest,
      employeeId: row.employee_id,
      planDigest: row.plan_digest,
      presentationEvidenceDigest: row.presentation_evidence_digest,
      recipientAuthorityDigest: row.recipient_authority_digest,
      recipientGeneration: row.recipient_generation,
      recipientPrincipalDigest: row.recipient_principal_digest,
      recipientResolutionDigest: row.recipient_resolution_digest,
      releaseId: row.release_id,
      resultId: row.result_id,
      runId: row.run_id,
      scheduleId: row.schedule_id,
      tenantScope: row.tenant_scope,
    });
    const identity = deliveryIdentity(binding);
    delivery = buildDelivery({
      binding,
      ...identity,
      deliveryState: enumValue(row.delivery_state, new Set([
        "prepared", "dispatch_prepared", "sent", "unknown",
      ])),
      dispatchPreparedAt: nullableTimestamp(row.dispatch_prepared_at),
      preparedAt: timestamp(row.prepared_at),
      deliveryAttempts: boundedInteger(row.delivery_attempts, 0, 1),
      recordVersion: positiveInteger(row.record_version),
      remoteDeliveryEvidenceDigest: nullableDigest(row.remote_delivery_evidence_digest),
      safeFailureCode: nullableToken(row.safe_failure_code),
      terminalAt: nullableTimestamp(row.terminal_at),
    }, hmacKey);
    if (identity.deliveryId !== row.delivery_id ||
      identity.deliveryRequestId !== row.delivery_request_id ||
      !safeEqual(delivery.integrityHmacDigest, row.integrity_hmac_digest)) {
      throw failure("schedule_alert_delivery_integrity_invalid");
    }
  } catch (error) {
    if (error?.code === "schedule_alert_delivery_integrity_invalid") throw error;
    throw failure("schedule_alert_delivery_integrity_invalid");
  }
  return delivery;
}

function readCandidateRows(database, binding, identity) {
  return database.prepare(`SELECT * FROM schedule_alert_deliveries
    WHERE tenant_scope=? AND (
      delivery_id=? OR delivery_request_id=? OR release_id=? OR alert_id=?
    )`).all(
    binding.tenantScope,
    identity.deliveryId,
    identity.deliveryRequestId,
    binding.releaseId,
    binding.alertId,
  );
}

function readRow(database, tenantScope, deliveryId) {
  return database.prepare(`SELECT * FROM schedule_alert_deliveries
    WHERE tenant_scope=? AND delivery_id=?`).get(tenantScope, deliveryId) || null;
}

function configure(database) {
  database.exec("PRAGMA foreign_keys=ON");
  database.exec("PRAGMA busy_timeout=5000");
  database.exec("PRAGMA synchronous=FULL");
  if (database.prepare("PRAGMA database_list").all()[0]?.file) {
    database.exec("PRAGMA journal_mode=WAL");
  }
}

function initialize(database) {
  if (userObjects(database).length > 0) return;
  transaction(database, () => {
    database.exec(SCHEMA_SQL);
    database.exec(DELIVERY_SQL);
    database.exec(INCOMPLETE_INDEX_SQL);
    database.prepare(`INSERT INTO schedule_alert_delivery_schema
      (singleton,schema_version) VALUES (1,?)`).run(SCHEMA_VERSION);
  });
}

function validateSchema(database) {
  const expected = new Map([
    ["index:schedule_alert_delivery_incomplete_idx", INCOMPLETE_INDEX_SQL],
    ["table:schedule_alert_deliveries", DELIVERY_SQL],
    ["table:schedule_alert_delivery_schema", SCHEMA_SQL],
  ]);
  const actual = userObjects(database);
  if (actual.length !== expected.size || actual.some((item) =>
    normalizeSql(item.sql) !== normalizeSql(expected.get(`${item.type}:${item.name}`)))) {
    throw failure("schedule_alert_delivery_schema_invalid");
  }
  const rows = database.prepare("SELECT * FROM schedule_alert_delivery_schema").all();
  if (rows.length !== 1 || rows[0].singleton !== 1 ||
    rows[0].schema_version !== SCHEMA_VERSION) {
    throw failure("schedule_alert_delivery_schema_invalid");
  }
}

function userObjects(database) {
  return database.prepare(`SELECT type,name,sql FROM sqlite_master
    WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name`).all();
}

function transaction(database, run) {
  database.exec("BEGIN IMMEDIATE");
  try {
    const value = run();
    database.exec("COMMIT");
    return value;
  } catch (error) {
    if (database.isTransaction) database.exec("ROLLBACK");
    throw error;
  }
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
    throw failure("schedule_alert_delivery_reference_invalid");
  }
  return result;
}

function digest(value) {
  const result = String(value || "").trim().toLowerCase();
  if (!DIGEST.test(result)) throw failure("schedule_alert_delivery_digest_invalid");
  return result;
}

function nullableDigest(value) { return value === null ? null : digest(value); }
function nullableToken(value) { return value === null ? null : token(value); }
function positiveInteger(value) { return boundedInteger(value, 1, Number.MAX_SAFE_INTEGER); }
function boundedInteger(value, minimum, maximum) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw failure("schedule_alert_delivery_number_invalid");
  }
  return value;
}

function timestamp(value) {
  const result = String(value || "").trim();
  const parsed = new Date(result);
  if (!result || !Number.isFinite(parsed.getTime()) || parsed.toISOString() !== result) {
    throw failure("schedule_alert_delivery_timestamp_invalid");
  }
  return result;
}

function nullableTimestamp(value) { return value === null ? null : timestamp(value); }
function trustedTimestamp(now) {
  let value;
  try { value = now(); } catch { throw failure("schedule_alert_delivery_clock_invalid"); }
  return timestamp(value instanceof Date ? value.toISOString() : value);
}

function enumValue(value, allowed) {
  if (!allowed.has(value)) throw failure("schedule_alert_delivery_state_invalid");
  return value;
}

function normalizeDatabasePath(value) {
  const result = String(value || "").trim();
  if (result === ":memory:") return result;
  if (!result || !path.isAbsolute(result)) {
    throw new TypeError("Schedule alert delivery databasePath must be absolute or :memory:");
  }
  return path.normalize(result);
}

function exactKey(value) {
  const key = Buffer.isBuffer(value) ? Buffer.from(value) : Buffer.from(value || []);
  if (key.length !== 32) throw new TypeError("Schedule alert delivery HMAC key must be 32 bytes");
  return key;
}

function sha256(value) { return crypto.createHash("sha256").update(value).digest("hex"); }
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
  if (result === undefined) throw failure("schedule_alert_delivery_value_invalid");
  return result;
}
function normalizeSql(value) { return String(value || "").replace(/\s+/g, " ").trim().toLowerCase(); }
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
  CONTRACT_VERSION as SCHEDULE_ALERT_DELIVERY_REPOSITORY_CONTRACT_VERSION,
  createSqliteScheduleAlertDeliveryRepository,
};
