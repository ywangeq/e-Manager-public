import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { HR_TRAINING_AGGREGATE_FEEDBACK_RESULT_VERSION } from "./aggregate-feedback-output-policy.mjs";

const RECORD_VERSION = "hr-training-aggregate-feedback-result-record.v1";
const EVIDENCE_VERSION = "hr-training-aggregate-feedback-result-evidence.v1";
const REPOSITORY_VERSION = "hr-training-aggregate-feedback-result-repository.v1";
const TOKEN = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,239}$/;
const DIGEST = /^[a-f0-9]{64}$/;

function createSqliteHrTrainingAggregateFeedbackResultRepository({ databasePath, encryptionKey, integrityHmacKey, now = () => new Date() } = {}) {
  const destination = requiredDatabasePath(databasePath);
  const encryption = exactKey(encryptionKey);
  const integrity = exactKey(integrityHmacKey);
  if (encryption.equals(integrity)) throw repositoryError("hr_training_aggregate_feedback_result_key_separation_required");
  if (destination !== ":memory:") fs.mkdirSync(path.dirname(destination), { recursive: true });
  const database = new DatabaseSync(destination);
  database.exec(`
    PRAGMA busy_timeout = 5000;
    CREATE TABLE IF NOT EXISTS hr_training_aggregate_feedback_results (
      tenant_scope TEXT NOT NULL, trigger_event_id TEXT NOT NULL, task_id TEXT NOT NULL,
      ciphertext TEXT NOT NULL, payload_digest TEXT NOT NULL, evidence_digest TEXT NOT NULL,
      sealed_at TEXT NOT NULL, PRIMARY KEY (tenant_scope, trigger_event_id, task_id)
    );
  `);
  const getInternal = (value) => {
    const identity = normalizeIdentity(value);
    const row = read(identity);
    return row ? decryptRow(row, identity) : null;
  };
  const saveOrGet = (value) => {
    const identity = normalizeIdentity(value);
    const result = normalizeResult(value.result);
    database.exec("BEGIN IMMEDIATE");
    try {
      const existing = read(identity);
      if (existing) {
        const stored = decryptRow(existing, identity);
        if (canonicalJson(stored.result) !== canonicalJson(result)) throw repositoryError("hr_training_aggregate_feedback_result_idempotency_conflict");
        database.exec("COMMIT");
        return Object.freeze({ created: false, evidence: stored.evidence, result: stored.result });
      }
      const sealedAt = trustedNow(now);
      const payload = canonicalJson(result);
      const payloadDigest = hmac(integrity, "payload", [identity, payload]);
      const evidenceDigest = hmac(integrity, "evidence", [identity, payloadDigest, sealedAt]);
      const ciphertext = encrypt(encryption, payload, canonicalJson({ ...identity, payloadDigest, evidenceDigest, sealedAt }));
      database.prepare(`INSERT INTO hr_training_aggregate_feedback_results
        (tenant_scope, trigger_event_id, task_id, ciphertext, payload_digest, evidence_digest, sealed_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)`)
        .run(identity.tenantScope, identity.triggerEventId, identity.taskId, ciphertext, payloadDigest, evidenceDigest, sealedAt);
      const stored = decryptRow(read(identity), identity);
      database.exec("COMMIT");
      return Object.freeze({ created: true, evidence: stored.evidence, result: stored.result });
    } catch (error) {
      if (database.isTransaction) database.exec("ROLLBACK");
      throw error;
    }
  };
  const read = (identity) => database.prepare(`SELECT * FROM hr_training_aggregate_feedback_results
    WHERE tenant_scope = ? AND trigger_event_id = ? AND task_id = ?`).get(identity.tenantScope, identity.triggerEventId, identity.taskId) || null;
  const decryptRow = (row, identity) => {
    if (!DIGEST.test(row.payload_digest) || !DIGEST.test(row.evidence_digest) || !requiredTimestamp(row.sealed_at)) throw repositoryError("hr_training_aggregate_feedback_result_integrity_invalid");
    const expectedEvidence = hmac(integrity, "evidence", [identity, row.payload_digest, row.sealed_at]);
    if (!sameDigest(row.evidence_digest, expectedEvidence)) throw repositoryError("hr_training_aggregate_feedback_result_integrity_invalid");
    let result;
    try { result = normalizeResult(JSON.parse(decrypt(encryption, row.ciphertext, canonicalJson({ ...identity, payloadDigest: row.payload_digest, evidenceDigest: row.evidence_digest, sealedAt: row.sealed_at })))); } catch { throw repositoryError("hr_training_aggregate_feedback_result_decryption_failed"); }
    if (!sameDigest(row.payload_digest, hmac(integrity, "payload", [identity, canonicalJson(result)]))) throw repositoryError("hr_training_aggregate_feedback_result_integrity_invalid");
    return Object.freeze({ result, evidence: Object.freeze({ contractVersion: EVIDENCE_VERSION, ...identity, evidenceDigest: row.evidence_digest, resultKind: result.resultKind, sealedAt: row.sealed_at }) });
  };
  return Object.freeze({ adapterKind: "sqlite_encrypted_hr_training_aggregate_feedback_result", close: () => database.close(), contractVersion: REPOSITORY_VERSION, deploymentScope: "single_center", distributedCoordination: false, getInternal, saveOrGet, schemaVersion: 1 });
}

function normalizeIdentity(value = {}) { return Object.freeze({ tenantScope: token(value.tenantScope), triggerEventId: token(value.triggerEventId), taskId: token(value.taskId) }); }
function normalizeResult(value) {
  if (!value || typeof value !== "object" || Array.isArray(value) || value.contractVersion !== HR_TRAINING_AGGREGATE_FEEDBACK_RESULT_VERSION || value.resultKind !== "FINAL_SUGGESTION_SUMMARY" || value.status !== "SUCCEEDED" || !Array.isArray(value.mainSuggestions)) throw repositoryError("hr_training_aggregate_feedback_result_invalid");
  const encoded = canonicalJson(value);
  if (Buffer.byteLength(encoded, "utf8") > 64 * 1024 || /(?:bearer\s+|https?:\/\/|-----BEGIN [A-Z ]*PRIVATE KEY-----)/i.test(encoded)) throw repositoryError("hr_training_aggregate_feedback_result_sensitive_value_forbidden");
  return deepFreeze(JSON.parse(encoded));
}
function token(value) { const text = String(value || "").trim(); if (!TOKEN.test(text)) throw repositoryError("hr_training_aggregate_feedback_result_reference_invalid"); return text; }
function requiredDatabasePath(value) { const text = String(value || "").trim(); if (text === ":memory:") return text; if (!path.isAbsolute(text)) throw new TypeError("HR Training aggregate feedback result databasePath must be absolute or :memory:"); return path.normalize(text); }
function exactKey(value) { const key = Buffer.isBuffer(value) ? Buffer.from(value) : Buffer.from(value || []); if (key.length !== 32) throw repositoryError("hr_training_aggregate_feedback_result_key_invalid"); return key; }
function trustedNow(now) { const date = now(); const value = date instanceof Date ? date : new Date(date); if (!Number.isFinite(value.getTime())) throw repositoryError("hr_training_aggregate_feedback_result_clock_invalid"); return value.toISOString(); }
function requiredTimestamp(value) { const date = new Date(value); return typeof value === "string" && Number.isFinite(date.getTime()) && date.toISOString() === value; }
function hmac(key, domain, parts) { return crypto.createHmac("sha256", key).update(canonicalJson([domain, ...parts])).digest("hex"); }
function encrypt(key, plaintext, aad) { const iv = crypto.randomBytes(12); const cipher = crypto.createCipheriv("aes-256-gcm", key, iv); cipher.setAAD(Buffer.from(aad)); const body = Buffer.concat([cipher.update(plaintext), cipher.final()]); return [iv, cipher.getAuthTag(), body].map((item) => item.toString("base64")).join("."); }
function decrypt(key, encrypted, aad) { const [iv, tag, body] = String(encrypted).split(".").map((item) => Buffer.from(item, "base64")); const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv); decipher.setAAD(Buffer.from(aad)); decipher.setAuthTag(tag); return Buffer.concat([decipher.update(body), decipher.final()]).toString("utf8"); }
function sameDigest(left, right) { return DIGEST.test(left) && DIGEST.test(right) && crypto.timingSafeEqual(Buffer.from(left, "hex"), Buffer.from(right, "hex")); }
function canonicalJson(value) { if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`; if (value && typeof value === "object") return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`; return JSON.stringify(value); }
function deepFreeze(value) { if (!value || typeof value !== "object" || Object.isFrozen(value)) return value; Object.freeze(value); Object.values(value).forEach(deepFreeze); return value; }
function repositoryError(code) { const error = new Error(code); error.code = code; return error; }

export { EVIDENCE_VERSION as HR_TRAINING_AGGREGATE_FEEDBACK_RESULT_EVIDENCE_VERSION, RECORD_VERSION as HR_TRAINING_AGGREGATE_FEEDBACK_RESULT_RECORD_VERSION, createSqliteHrTrainingAggregateFeedbackResultRepository };
