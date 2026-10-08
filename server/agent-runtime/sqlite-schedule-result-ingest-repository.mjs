import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { isDeepStrictEqual } from "node:util";

const BINDING_VERSION = "schedule-result-ingest-binding.v1";
const EVIDENCE_VERSION = "schedule-result-ingest-evidence.v1";
const INTERNAL_VERSION = "schedule-result-ingest-internal-envelope.v1";
const MAX_ENVELOPE_BYTES = 64 * 1024;
const MAX_JSON_NODES = 4096;
const MAX_JSON_DEPTH = 16;
const DIGEST = /^[a-f0-9]{64}$/;
const TOKEN = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,159}$/;
const SECRET = /^(?:bearer\s+|sk-|rk-|xox[baprs]-|gh[pousr]_|glpat-|ya29\.|eyJ)/i;
const BINDING_FIELDS = new Set([
  "activationSnapshotDigest", "activationSnapshotId", "activationVersion", "alertContractDigest",
  "canonicalTaskId", "contractVersion", "employeeId", "resultContractDigest", "runId", "scheduleId",
  "scheduledFor", "tenantScope", "triggerId",
]);
const RECORD_FIELDS = new Set([
  "binding", "envelope", "providerAttemptEvidenceDigest", "providerResponseRef",
]);
const READ_FIELDS = new Set(["expectedBinding", "providerAttemptEvidenceDigest", "runId", "tenantScope"]);

const SCHEMA_TABLE_SQL = `CREATE TABLE schedule_result_ingest_schema (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  version INTEGER NOT NULL CHECK (version = 1)
)`;
const INGEST_TABLE_SQL = `CREATE TABLE schedule_result_ingests (
  tenant_scope TEXT NOT NULL,
  ingest_id TEXT NOT NULL,
  employee_id TEXT NOT NULL,
  schedule_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  canonical_task_id TEXT NOT NULL,
  trigger_id TEXT NOT NULL,
  scheduled_for TEXT NOT NULL,
  activation_version INTEGER NOT NULL CHECK (activation_version > 0),
  activation_snapshot_id TEXT NOT NULL,
  activation_snapshot_digest TEXT NOT NULL,
  result_contract_digest TEXT NOT NULL,
  alert_contract_digest TEXT NOT NULL,
  provider_attempt_evidence_digest TEXT NOT NULL,
  provider_response_ref_hmac TEXT NOT NULL,
  content_hmac_digest TEXT NOT NULL,
  evidence_digest TEXT NOT NULL,
  ciphertext TEXT NOT NULL,
  encryption_key_id TEXT NOT NULL,
  encryption_algorithm TEXT NOT NULL CHECK (encryption_algorithm = 'aes-256-gcm'),
  ingest_state TEXT NOT NULL CHECK (ingest_state = 'envelope_sealed'),
  sealed_at TEXT NOT NULL,
  PRIMARY KEY (tenant_scope, ingest_id),
  UNIQUE (tenant_scope, run_id),
  UNIQUE (tenant_scope, canonical_task_id),
  UNIQUE (tenant_scope, provider_response_ref_hmac)
)`;
const SCHEMA_SQL = `${SCHEMA_TABLE_SQL};
INSERT INTO schedule_result_ingest_schema VALUES (1, 1);
${INGEST_TABLE_SQL};`;

export function createSqliteScheduleResultIngestRepository({
  databasePath, encryptionKeys, currentEncryptionKeyId, stableEnvelopeHmacKey, now = () => new Date(),
} = {}) {
  const dbPath = normalizeDatabasePath(databasePath);
  if (dbPath !== ":memory:") fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const keyring = normalizeKeyring(encryptionKeys);
  const currentKeyId = safeToken(currentEncryptionKeyId, "currentEncryptionKeyId");
  if (!keyring.has(currentKeyId)) throw failure("schedule_result_ingest_current_key_unavailable");
  // This stable authority key backs durable content and uniqueness indexes. Encryption keys rotate independently.
  const hmacKey = exactKey(stableEnvelopeHmacKey, "stableEnvelopeHmacKey");
  if (typeof now !== "function") throw failure("schedule_result_ingest_clock_invalid");
  const database = new DatabaseSync(dbPath);
  try { initialize(database); } catch (error) { database.close(); throw error; }

  function recordEnvelope(value = {}) {
    exactObject(value, RECORD_FIELDS, "schedule_result_ingest_record_request_invalid");
    const binding = normalizeBinding(value.binding);
    const providerAttemptEvidenceDigest = digest(value.providerAttemptEvidenceDigest);
    const providerResponseRef = safeToken(value.providerResponseRef, "providerResponseRef");
    const envelope = normalizeEnvelope(value.envelope);
    const envelopeJson = canonicalJson(envelope);
    const sealedAt = trustedNow(now);
    const candidate = buildCandidate({
      binding, envelope, envelopeJson, providerAttemptEvidenceDigest, providerResponseRef, hmacKey,
    });
    const plaintext = canonicalJson({ envelope, providerResponseRef });
    const aad = buildAad(candidate, currentKeyId, sealedAt);
    const ciphertext = encrypt(keyring.get(currentKeyId), plaintext, aad);

    return transaction(database, () => {
      const existing = readRow(database, binding.tenantScope, binding.runId);
      if (existing) {
        const authenticated = authenticateRow(existing, keyring, hmacKey);
        requireSame(authenticated, candidate);
        return Object.freeze({ created: false, evidence: projectEvidence(existing) });
      }
      const taskConflict = database.prepare(
        "SELECT 1 FROM schedule_result_ingests WHERE tenant_scope=? AND canonical_task_id=?",
      ).get(binding.tenantScope, binding.canonicalTaskId);
      if (taskConflict) throw failure("schedule_result_ingest_task_conflict");
      const refConflict = database.prepare(
        "SELECT 1 FROM schedule_result_ingests WHERE tenant_scope=? AND provider_response_ref_hmac=?",
      ).get(binding.tenantScope, candidate.providerResponseRefHmac);
      if (refConflict) throw failure("schedule_result_ingest_response_ref_conflict");
      database.prepare(`INSERT INTO schedule_result_ingests (
        tenant_scope,ingest_id,employee_id,schedule_id,run_id,canonical_task_id,trigger_id,scheduled_for,
        activation_version,activation_snapshot_id,activation_snapshot_digest,result_contract_digest,
        alert_contract_digest,provider_attempt_evidence_digest,provider_response_ref_hmac,
        content_hmac_digest,evidence_digest,ciphertext,encryption_key_id,
        encryption_algorithm,ingest_state,sealed_at
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'aes-256-gcm','envelope_sealed',?)`).run(
        binding.tenantScope, candidate.ingestId, binding.employeeId, binding.scheduleId, binding.runId,
        binding.canonicalTaskId, binding.triggerId, binding.scheduledFor, binding.activationVersion,
        binding.activationSnapshotId, binding.activationSnapshotDigest, binding.resultContractDigest,
        binding.alertContractDigest, providerAttemptEvidenceDigest, candidate.providerResponseRefHmac,
        candidate.contentHmacDigest, candidate.evidenceDigest, ciphertext, currentKeyId, sealedAt,
      );
      const stored = readRow(database, binding.tenantScope, binding.runId);
      authenticateRow(stored, keyring, hmacKey);
      return Object.freeze({ created: true, evidence: projectEvidence(stored) });
    });
  }

  function getEvidence(value = {}) {
    const request = normalizeReadRequest(value);
    const row = readRow(database, request.tenantScope, request.runId);
    if (!row) return null;
    const authenticated = authenticateRow(row, keyring, hmacKey);
    requireReadIdentity(authenticated, request);
    return projectEvidence(row);
  }

  function readInternalEnvelope(value = {}) {
    const request = normalizeReadRequest(value);
    const row = readRow(database, request.tenantScope, request.runId);
    if (!row) return null;
    const authenticated = authenticateRow(row, keyring, hmacKey);
    requireReadIdentity(authenticated, request);
    return deepFreeze({
      contractVersion: INTERNAL_VERSION,
      envelope: authenticated.envelope,
      evidence: projectEvidence(row),
      payloadBoundary: "internal_only",
      providerResponseRef: authenticated.providerResponseRef,
    });
  }

  return Object.freeze({ close: () => database.close(), getEvidence, readInternalEnvelope, recordEnvelope });
}

function buildCandidate({
  binding, envelope, envelopeJson, providerAttemptEvidenceDigest, providerResponseRef, hmacKey,
}) {
  const providerResponseRefHmac = keyedDigest(hmacKey, "schedule-result-ingest-response-ref.v1", [
    binding.tenantScope, providerResponseRef,
  ]);
  const contentHmacDigest = keyedDigest(hmacKey, "schedule-result-ingest-content.v1", [
    binding, providerAttemptEvidenceDigest, providerResponseRef, envelopeJson,
  ]);
  const ingestId = deterministicId("schedule_result_ingest", [
    binding, providerAttemptEvidenceDigest, providerResponseRefHmac, contentHmacDigest,
  ]);
  const evidenceDigest = digestCanonical({
    contractVersion: "schedule-result-ingest-evidence-binding.v1", binding, contentHmacDigest,
    ingestId, providerAttemptEvidenceDigest, providerResponseRefHmac,
  });
  return {
    binding, contentHmacDigest, envelope, evidenceDigest, ingestId, providerAttemptEvidenceDigest,
    providerResponseRef, providerResponseRefHmac,
  };
}

function buildAad(candidate, encryptionKeyId, sealedAt) {
  return canonicalJson({
    contractVersion: "schedule-result-ingest-ciphertext.v1",
    binding: candidate.binding,
    contentHmacDigest: candidate.contentHmacDigest,
    encryptionAlgorithm: "aes-256-gcm",
    encryptionKeyId,
    evidenceDigest: candidate.evidenceDigest,
    ingestId: candidate.ingestId,
    providerAttemptEvidenceDigest: candidate.providerAttemptEvidenceDigest,
    providerResponseRefHmac: candidate.providerResponseRefHmac,
    sealedAt,
  });
}

function authenticateRow(row, keyring, hmacKey) {
  validateStoredRow(row);
  const binding = bindingFromRow(row);
  const key = keyring.get(row.encryption_key_id);
  if (!key) throw failure("schedule_result_ingest_encryption_key_unavailable");
  const storedCandidate = {
    binding,
    contentHmacDigest: row.content_hmac_digest,
    evidenceDigest: row.evidence_digest,
    ingestId: row.ingest_id,
    providerAttemptEvidenceDigest: row.provider_attempt_evidence_digest,
    providerResponseRefHmac: row.provider_response_ref_hmac,
  };
  const plaintext = decrypt(key, row.ciphertext, buildAad(
    storedCandidate, row.encryption_key_id, row.sealed_at,
  ));
  let decoded;
  try { decoded = JSON.parse(plaintext); } catch { throw failure("schedule_result_ingest_plaintext_invalid"); }
  if (!isPlainObject(decoded) || !Object.hasOwn(decoded, "envelope") ||
    !Object.hasOwn(decoded, "providerResponseRef") || Object.keys(decoded).length !== 2) {
    throw failure("schedule_result_ingest_plaintext_invalid");
  }
  const envelope = normalizeEnvelope(decoded.envelope);
  const providerResponseRef = safeToken(decoded.providerResponseRef, "providerResponseRef");
  const derived = buildCandidate({
    binding, envelope, envelopeJson: canonicalJson(envelope),
    providerAttemptEvidenceDigest: row.provider_attempt_evidence_digest,
    providerResponseRef, hmacKey,
  });
  for (const field of [
    "contentHmacDigest", "evidenceDigest", "ingestId", "providerResponseRefHmac",
  ]) {
    if (derived[field] !== storedCandidate[field]) throw failure("schedule_result_ingest_integrity_invalid");
  }
  return derived;
}

function requireSame(existing, candidate) {
  const comparable = [
    "binding", "contentHmacDigest", "envelope", "evidenceDigest", "ingestId",
    "providerAttemptEvidenceDigest", "providerResponseRef", "providerResponseRefHmac",
  ];
  if (comparable.some((field) => !isDeepStrictEqual(existing[field], candidate[field]))) {
    throw failure("schedule_result_ingest_conflict");
  }
}

function requireReadIdentity(authenticated, request) {
  if (!isDeepStrictEqual(authenticated.binding, request.expectedBinding) ||
    authenticated.providerAttemptEvidenceDigest !== request.providerAttemptEvidenceDigest) {
    throw failure("schedule_result_ingest_binding_mismatch");
  }
}

function projectEvidence(row) {
  return deepFreeze({
    contractVersion: EVIDENCE_VERSION,
    evidenceDigest: row.evidence_digest,
    ingestRef: row.ingest_id,
    sealedAt: row.sealed_at,
    state: "envelope_sealed",
  });
}

function normalizeReadRequest(value) {
  exactObject(value, READ_FIELDS, "schedule_result_ingest_read_request_invalid");
  const tenantScope = safeToken(value.tenantScope, "tenantScope");
  const runId = safeToken(value.runId, "runId");
  const expectedBinding = normalizeBinding(value.expectedBinding);
  if (tenantScope !== expectedBinding.tenantScope || runId !== expectedBinding.runId) {
    throw failure("schedule_result_ingest_binding_mismatch");
  }
  return { expectedBinding, providerAttemptEvidenceDigest: digest(value.providerAttemptEvidenceDigest), runId, tenantScope };
}

function normalizeBinding(value) {
  exactObject(value, BINDING_FIELDS, "schedule_result_ingest_binding_invalid");
  if (value.contractVersion !== BINDING_VERSION) throw failure("schedule_result_ingest_binding_version_invalid");
  return deepFreeze({
    activationSnapshotDigest: digest(value.activationSnapshotDigest),
    activationSnapshotId: safeToken(value.activationSnapshotId, "activationSnapshotId"),
    activationVersion: positiveInteger(value.activationVersion),
    alertContractDigest: digest(value.alertContractDigest),
    canonicalTaskId: safeToken(value.canonicalTaskId, "canonicalTaskId"),
    contractVersion: BINDING_VERSION,
    employeeId: safeToken(value.employeeId, "employeeId"),
    resultContractDigest: digest(value.resultContractDigest),
    runId: safeToken(value.runId, "runId"),
    scheduleId: safeToken(value.scheduleId, "scheduleId"),
    scheduledFor: timestamp(value.scheduledFor),
    tenantScope: safeToken(value.tenantScope, "tenantScope"),
    triggerId: safeToken(value.triggerId, "triggerId"),
  });
}

function bindingFromRow(row) {
  return normalizeBinding({
    activationSnapshotDigest: row.activation_snapshot_digest,
    activationSnapshotId: row.activation_snapshot_id,
    activationVersion: row.activation_version,
    alertContractDigest: row.alert_contract_digest,
    canonicalTaskId: row.canonical_task_id,
    contractVersion: BINDING_VERSION,
    employeeId: row.employee_id,
    resultContractDigest: row.result_contract_digest,
    runId: row.run_id,
    scheduleId: row.schedule_id,
    scheduledFor: row.scheduled_for,
    tenantScope: row.tenant_scope,
    triggerId: row.trigger_id,
  });
}

function normalizeEnvelope(value) {
  const budget = { nodes: 0 };
  const normalized = normalizeJsonValue(value, 0, budget);
  if (!isPlainObject(normalized)) throw failure("schedule_result_ingest_envelope_invalid");
  const serialized = canonicalJson(normalized);
  if (Buffer.byteLength(serialized, "utf8") > MAX_ENVELOPE_BYTES) {
    throw failure("schedule_result_ingest_envelope_too_large");
  }
  return deepFreeze(normalized);
}

function normalizeJsonValue(value, depth, budget) {
  budget.nodes += 1;
  if (budget.nodes > MAX_JSON_NODES || depth > MAX_JSON_DEPTH) {
    throw failure("schedule_result_ingest_envelope_invalid");
  }
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw failure("schedule_result_ingest_envelope_invalid");
    return Object.is(value, -0) ? 0 : value;
  }
  if (Array.isArray(value)) return value.map((item) => normalizeJsonValue(item, depth + 1, budget));
  if (!isPlainObject(value)) throw failure("schedule_result_ingest_envelope_invalid");
  const result = {};
  for (const key of Object.keys(value).sort()) {
    if (typeof value[key] === "undefined" || typeof value[key] === "function" || typeof value[key] === "symbol") {
      throw failure("schedule_result_ingest_envelope_invalid");
    }
    Object.defineProperty(result, key, {
      configurable: false,
      enumerable: true,
      value: normalizeJsonValue(value[key], depth + 1, budget),
      writable: false,
    });
  }
  return result;
}

function readRow(database, tenantScope, runId) {
  return database.prepare(
    "SELECT * FROM schedule_result_ingests WHERE tenant_scope=? AND run_id=?",
  ).get(tenantScope, runId) || null;
}

function validateStoredRow(row) {
  if (!row || row.encryption_algorithm !== "aes-256-gcm" || row.ingest_state !== "envelope_sealed") {
    throw failure("schedule_result_ingest_integrity_invalid");
  }
  digest(row.provider_attempt_evidence_digest);
  digest(row.provider_response_ref_hmac);
  digest(row.content_hmac_digest);
  digest(row.evidence_digest);
  timestamp(row.sealed_at);
}

function initialize(database) {
  database.exec("PRAGMA busy_timeout = 5000; PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL; PRAGMA foreign_keys = ON");
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
  if (objects.some((item) => item.type === "trigger")) throw invalidSchema();
  if (objects.some((item) => item.type !== "table")) throw invalidSchema();
  const tables = objects.filter((item) => item.type === "table");
  if (!isDeepStrictEqual(tables.map((item) => item.name), [
    "schedule_result_ingest_schema", "schedule_result_ingests",
  ])) throw invalidSchema();
  const schemaRow = database.prepare("SELECT singleton,version FROM schedule_result_ingest_schema").all();
  if (schemaRow.length !== 1 || schemaRow[0].singleton !== 1 || schemaRow[0].version !== 1) {
    throw invalidSchema();
  }
  const expectedSql = new Map([
    ["schedule_result_ingest_schema", normalizeSql(SCHEMA_TABLE_SQL)],
    ["schedule_result_ingests", normalizeSql(INGEST_TABLE_SQL)],
  ]);
  for (const table of tables) {
    if (normalizeSql(table.sql) !== expectedSql.get(table.name)) throw invalidSchema();
  }
  requireIndexes(database, "schedule_result_ingest_schema", []);
  requireIndexes(database, "schedule_result_ingests", [
    ["pk", 1, ["tenant_scope", "ingest_id"], false],
    ["u", 1, ["tenant_scope", "run_id"], false],
    ["u", 1, ["tenant_scope", "canonical_task_id"], false],
    ["u", 1, ["tenant_scope", "provider_response_ref_hmac"], false],
  ]);
}

function requireIndexes(database, table, expected) {
  const actual = database.prepare(`PRAGMA index_list(${table})`).all().map((item) => [
    item.origin, item.unique,
    database.prepare(`PRAGMA index_info(${item.name})`).all().sort((a, b) => a.seqno - b.seqno).map((part) => part.name),
    item.partial === 1,
  ]);
  const sort = (items) => items.toSorted((a, b) => canonicalJson(a).localeCompare(canonicalJson(b)));
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
  } catch { throw failure("schedule_result_ingest_decryption_failed"); }
}

function normalizeKeyring(value) {
  const entries = value instanceof Map ? [...value] : Object.entries(value || {});
  if (!entries.length || entries.length > 32) throw failure("schedule_result_ingest_keyring_invalid");
  return new Map(entries.map(([id, key]) => [safeToken(id, "encryptionKeyId"), exactKey(key, "encryptionKey")]));
}

function exactKey(value, field) {
  const key = Buffer.isBuffer(value) ? Buffer.from(value) : Buffer.from(value || []);
  if (key.length !== 32) throw failure("schedule_result_ingest_key_invalid", field);
  return key;
}

function normalizeDatabasePath(value) {
  const result = String(value || "").trim();
  if (result === ":memory:") return result;
  if (!result || !path.isAbsolute(result)) throw new TypeError("schedule result ingest databasePath must be absolute or :memory:");
  return path.normalize(result);
}

function transaction(database, run) {
  database.exec("BEGIN IMMEDIATE");
  try { const value = run(); database.exec("COMMIT"); return value; }
  catch (error) { if (database.isTransaction) database.exec("ROLLBACK"); throw error; }
}

function exactObject(value, fields, code) {
  if (!isPlainObject(value) || Object.keys(value).some((key) => !fields.has(key)) ||
    [...fields].some((key) => !Object.hasOwn(value, key))) throw failure(code);
}

function safeToken(value, field = "token") {
  const result = String(value || "").trim();
  if (!TOKEN.test(result) || /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(result) || SECRET.test(result)) {
    throw failure("schedule_result_ingest_token_invalid", field);
  }
  return result;
}

function digest(value) {
  const result = String(value || "").trim().toLowerCase();
  if (!DIGEST.test(result)) throw failure("schedule_result_ingest_digest_invalid");
  return result;
}

function timestamp(value) {
  const input = value instanceof Date ? value.toISOString() : String(value || "").trim();
  const parsed = new Date(input);
  if (!input || !Number.isFinite(parsed.getTime()) || parsed.toISOString() !== input) {
    throw failure("schedule_result_ingest_timestamp_invalid");
  }
  return input;
}

function positiveInteger(value) {
  if (!Number.isSafeInteger(value) || value < 1) throw failure("schedule_result_ingest_integer_invalid");
  return value;
}

function trustedNow(now) {
  try { return timestamp(now()); }
  catch (error) { if (error?.code) throw error; throw failure("schedule_result_ingest_clock_invalid"); }
}

function deterministicId(prefix, parts) { return `${prefix}_${digestCanonical(parts)}`; }
function digestCanonical(value) { return crypto.createHash("sha256").update(canonicalJson(value)).digest("hex"); }
function keyedDigest(key, domain, parts) {
  return crypto.createHmac("sha256", key).update(canonicalJson([domain, ...parts])).digest("hex");
}
function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  const serialized = JSON.stringify(value);
  if (serialized === undefined) throw failure("schedule_result_ingest_value_invalid");
  return serialized;
}
function normalizeSql(value) { return String(value || "").replace(/\s+/g, " ").trim(); }
function isPlainObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  Object.freeze(value);
  Object.values(value).forEach(deepFreeze);
  return value;
}
function invalidSchema() { return new TypeError("invalid schedule result ingest SQLite schema v1"); }
function failure(code, detail = "") {
  const error = new Error(detail ? `${code}: ${detail}` : code);
  error.code = code;
  return error;
}

export {
  BINDING_VERSION as SCHEDULE_RESULT_INGEST_BINDING_CONTRACT_VERSION,
  EVIDENCE_VERSION as SCHEDULE_RESULT_INGEST_EVIDENCE_CONTRACT_VERSION,
};
