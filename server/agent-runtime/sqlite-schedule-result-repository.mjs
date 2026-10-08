import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { isDeepStrictEqual } from "node:util";
import {
  normalizeScheduleResultContract,
  parseScheduleResult,
  projectScheduleResultSafeSummary,
} from "./schedule-result-contract.mjs";
import {
  createScheduleResultProcessingBinding,
  normalizeScheduleResultAlertContract,
  normalizeScheduleResultProcessingAuthority,
  normalizeScheduleResultRetentionDefinition,
} from "./schedule-result-processing-contract.mjs";

const BINDING_VERSION = "schedule-result-binding.v1";
const PROCESSING_BINDING_VERSION = "schedule-result-processing-outcome-binding.v1";
const PROCESSING_EVIDENCE_VERSION = "schedule-result-processing-outcome-evidence.v1";
const ALERT_PLAN_VERSION = "schedule-result-alert-plan.v1";
const RETENTION_VERSION = "schedule-result-retention-policy.v1";
const DIGEST = /^[a-f0-9]{64}$/;
const TOKEN = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,159}$/;
const SECRET = /^(?:bearer\s+|sk-|rk-|xox[baprs]-|gh[pousr]_|glpat-|ya29\.|eyJ)/i;
const BINDING_FIELDS = new Set([
  "activationSnapshotDigest", "activationSnapshotId", "activationVersion", "canonicalTaskId",
  "contractVersion", "employeeId", "resultContractDigest", "alertContractDigest", "runId", "scheduleId", "scheduledFor",
  "tenantScope", "triggerId",
]);
const PROCESSING_REQUEST_FIELDS = new Set(["alertPlan", "binding", "envelope", "processingResolution"]);
const PROCESSING_RESOLUTION_FIELDS = new Set([
  "alertContract", "authority", "contractVersion", "resultContract", "retentionDefinition",
]);
const PROCESSING_BINDING_FIELDS = new Set([
  "activationSnapshotDigest", "activationSnapshotId", "activationVersion", "alertContractDigest",
  "canonicalTaskId", "contractVersion", "employeeId", "ingestEvidenceDigest", "ingestRef",
  "processingAuthorityDigest", "providerAttemptEvidenceDigest", "resultContractDigest",
  "retentionDefinitionDigest", "runId", "runLeaseBindingDigest", "scheduleId", "scheduledFor",
  "tenantScope", "triggerId",
]);
const PROCESSING_READ_FIELDS = new Set(["expectedBinding", "runId", "tenantScope"]);
const PROCESSING_INTERNAL_READ_FIELDS = new Set(["runId", "tenantScope"]);
const UNKNOWN_REQUEST_FIELDS = new Set(["binding", "safeFailureCode"]);
const INTERNAL_EVIDENCE_FIELDS = new Set(["expectedBinding", "runId", "tenantScope"]);
const ALERT_FIELDS = new Set([
  "alertContractDigest", "contractVersion", "mode", "planDigest", "policyVersion", "recipients",
]);
const RECIPIENT_FIELDS = new Set(["generation", "recipientPrincipalDigest", "recipientRole", "ruleId"]);
const DETERMINISTIC_PARSE_FAILURE_CODES = new Set([
  "schedule_result_contract_binding_mismatch", "schedule_result_envelope_invalid",
  "schedule_result_outcome_unknown", "schedule_result_payload_invalid",
  "schedule_result_payload_too_large", "schedule_result_schema_version_mismatch",
  "schedule_result_type_mismatch",
]);
const PROCESSING_UNKNOWN_CODES = new Set([
  "schedule_result_ingest_integrity_invalid", "schedule_result_ingest_unavailable",
  "schedule_result_processing_authority_unavailable", "schedule_result_processing_integrity_invalid",
  "schedule_result_processing_state_uncertain", "schedule_result_provider_effect_unknown",
]);

const SCHEMA_V1_TABLE_SQL = `CREATE TABLE schedule_result_schema (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  version INTEGER NOT NULL CHECK (version = 1)
)`;
const SCHEMA_V2_TABLE_SQL = `CREATE TABLE schedule_result_schema (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  version INTEGER NOT NULL CHECK (version = 2)
)`;
const RESULTS_TABLE_SQL = `CREATE TABLE schedule_results (
  tenant_scope TEXT NOT NULL,
  result_id TEXT NOT NULL,
  employee_id TEXT NOT NULL,
  schedule_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  canonical_task_id TEXT NOT NULL,
  trigger_id TEXT NOT NULL,
  scheduled_for TEXT NOT NULL,
  activation_version INTEGER NOT NULL CHECK (activation_version > 0),
  activation_snapshot_id TEXT NOT NULL,
  activation_snapshot_digest TEXT NOT NULL,
  result_contract_id TEXT NOT NULL,
  result_contract_version INTEGER NOT NULL CHECK (result_contract_version > 0),
  result_contract_digest TEXT NOT NULL,
  result_type TEXT NOT NULL,
  schema_version TEXT NOT NULL,
  content_hmac_digest TEXT NOT NULL,
  ciphertext TEXT NOT NULL,
  encryption_key_id TEXT NOT NULL,
  encryption_algorithm TEXT NOT NULL CHECK (encryption_algorithm = 'aes-256-gcm'),
  safe_outcome_code TEXT NOT NULL,
  safe_severity_code TEXT NOT NULL,
  safe_summary_code TEXT NOT NULL,
  safe_summary_digest TEXT NOT NULL,
  alert_contract_digest TEXT NOT NULL,
  alert_policy_version TEXT NOT NULL,
  alert_plan_digest TEXT NOT NULL,
  alert_mode TEXT NOT NULL CHECK (alert_mode IN ('required', 'not_required')),
  retention_policy_version TEXT NOT NULL,
  retention_policy_digest TEXT NOT NULL,
  payload_retain_until TEXT NOT NULL,
  sealed_at TEXT NOT NULL,
  PRIMARY KEY (tenant_scope, result_id),
  UNIQUE (tenant_scope, run_id),
  UNIQUE (tenant_scope, canonical_task_id)
)`;
const ALERT_TABLE_SQL = `CREATE TABLE schedule_result_alert_outbox (
  tenant_scope TEXT NOT NULL,
  alert_id TEXT NOT NULL,
  result_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  alert_contract_digest TEXT NOT NULL,
  policy_version TEXT NOT NULL,
  plan_digest TEXT NOT NULL,
  rule_id TEXT NOT NULL,
  recipient_role TEXT NOT NULL,
  recipient_principal_digest TEXT NOT NULL,
  generation INTEGER NOT NULL CHECK (generation > 0),
  alert_state TEXT NOT NULL CHECK (alert_state = 'held'),
  created_at TEXT NOT NULL,
  PRIMARY KEY (tenant_scope, alert_id),
  UNIQUE (tenant_scope, result_id, rule_id, recipient_principal_digest, generation),
  FOREIGN KEY (tenant_scope, result_id) REFERENCES schedule_results (tenant_scope, result_id) ON DELETE RESTRICT
)`;
const ALERT_INDEX_SQL = `CREATE INDEX schedule_result_alert_held_idx
  ON schedule_result_alert_outbox (tenant_scope, result_id, alert_id) WHERE alert_state = 'held'`;
const PROCESSING_OUTCOME_TABLE_SQL = `CREATE TABLE schedule_result_processing_outcomes (
  tenant_scope TEXT NOT NULL,
  outcome_id TEXT NOT NULL,
  employee_id TEXT NOT NULL,
  schedule_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  canonical_task_id TEXT NOT NULL,
  trigger_id TEXT NOT NULL,
  scheduled_for TEXT NOT NULL,
  activation_version INTEGER NOT NULL CHECK (activation_version > 0),
  activation_snapshot_id TEXT NOT NULL,
  activation_snapshot_digest TEXT NOT NULL,
  processing_authority_digest TEXT NOT NULL,
  result_contract_digest TEXT NOT NULL,
  alert_contract_digest TEXT NOT NULL,
  retention_definition_digest TEXT NOT NULL,
  ingest_ref TEXT NOT NULL,
  ingest_evidence_digest TEXT NOT NULL,
  provider_attempt_evidence_digest TEXT NOT NULL,
  run_lease_binding_digest TEXT NOT NULL,
  processing_outcome TEXT NOT NULL CHECK (processing_outcome IN ('parsed_result', 'parse_failed', 'unknown')),
  result_id TEXT,
  result_evidence_digest TEXT,
  safe_failure_code TEXT,
  processing_evidence_digest TEXT NOT NULL,
  integrity_hmac_digest TEXT NOT NULL,
  processed_at TEXT NOT NULL,
  PRIMARY KEY (tenant_scope, outcome_id),
  UNIQUE (tenant_scope, run_id),
  UNIQUE (tenant_scope, canonical_task_id),
  UNIQUE (tenant_scope, ingest_ref),
  CHECK (
    (processing_outcome = 'parsed_result' AND result_id IS NOT NULL AND result_evidence_digest IS NOT NULL AND safe_failure_code IS NULL)
    OR (processing_outcome IN ('parse_failed', 'unknown') AND result_id IS NULL AND result_evidence_digest IS NULL AND safe_failure_code IS NOT NULL)
  ),
  FOREIGN KEY (tenant_scope, result_id) REFERENCES schedule_results (tenant_scope, result_id) ON DELETE RESTRICT
)`;
const SCHEMA_V2_SQL = `${SCHEMA_V2_TABLE_SQL};
INSERT INTO schedule_result_schema VALUES (1, 2);
${RESULTS_TABLE_SQL};
${ALERT_TABLE_SQL};
${ALERT_INDEX_SQL};
${PROCESSING_OUTCOME_TABLE_SQL};`;

export function createSqliteScheduleResultRepository({
  databasePath, encryptionKeys, currentEncryptionKeyId, payloadHmacKey, maxPayloadRetentionMs,
  now = () => new Date(),
} = {}) {
  const dbPath = normalizeDatabasePath(databasePath);
  if (dbPath !== ":memory:") fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const keyring = normalizeKeyring(encryptionKeys);
  const currentKeyId = safeToken(currentEncryptionKeyId, "currentEncryptionKeyId");
  if (!keyring.has(currentKeyId)) throw failure("schedule_result_current_key_unavailable");
  const hmacKey = exactKey(payloadHmacKey, "payloadHmacKey");
  const maxRetentionMs = boundedRetention(maxPayloadRetentionMs);
  if (typeof now !== "function") throw failure("schedule_result_clock_invalid");
  const database = new DatabaseSync(dbPath);
  try { initialize(database); } catch (error) { database.close(); throw error; }

  function processEnvelopeAndHoldAlerts(value = {}) {
    exactObject(value, PROCESSING_REQUEST_FIELDS, "schedule_result_processing_request_invalid");
    const binding = normalizeProcessingBinding(value.binding);
    const resolution = normalizeProcessingResolution(value.processingResolution);
    requireProcessingResolution(binding, resolution);
    const alertPlan = normalizeAlertPlan(value.alertPlan);
    if (binding.alertContractDigest !== alertPlan.alertContractDigest) {
      throw failure("schedule_result_alert_contract_binding_mismatch");
    }
    const existingOutcomeRow = readProcessingOutcomeRow(database, binding.tenantScope, binding.runId);
    const existingOutcome = existingOutcomeRow
      ? authenticateProcessingOutcome(existingOutcomeRow, binding)
      : null;
    const processedAt = existingOutcome
      ? existingOutcome.processedAt
      : trustedNow(now);
    const retention = deriveRetentionPlan(resolution.retentionDefinition, processedAt);
    if (Date.parse(retention.payloadRetainUntil) - Date.parse(processedAt) > maxRetentionMs) {
      throw failure("schedule_result_retention_invalid");
    }
    let parsed;
    try {
      parsed = parseScheduleResult(resolution.resultContract, value.envelope);
    } catch (error) {
      if (!DETERMINISTIC_PARSE_FAILURE_CODES.has(error?.code)) throw error;
      if (alertPlan.mode !== "not_required") throw failure("schedule_result_parse_failure_alert_plan_invalid");
      return transaction(database, () => writeProcessingOutcome({
        binding,
        outcome: "parse_failed",
        processedAt,
        resultEvidenceDigest: null,
        resultId: null,
        safeFailureCode: error.code,
      }));
    }
    const safeSummary = projectScheduleResultSafeSummary(resolution.resultContract, parsed);
    if (existingOutcome && existingOutcome.state !== "parsed_result") {
      throw failure("schedule_result_processing_outcome_conflict");
    }
    requireAlertPlanForOutcome(alertPlan, resolution.alertContract, safeSummary.outcomeCode);
    const resultBinding = resultBindingFromProcessing(binding);
    const resultCandidate = buildParsedResultCandidate({
      alertPlan,
      binding: resultBinding,
      contract: resolution.resultContract,
      parsed,
      retention,
      safeSummary,
      sealedAt: processedAt,
    });
    return transaction(database, () => {
      const resultWrite = writeParsedResult(resultCandidate);
      const resultEvidence = internalResultEvidence(
        readRow(database, binding.tenantScope, binding.runId),
        resultBinding,
      );
      const outcomeWrite = writeProcessingOutcome({
        binding,
        outcome: "parsed_result",
        processedAt,
        resultEvidenceDigest: resultEvidence.resultEvidenceDigest,
        resultId: resultCandidate.resultId,
        safeFailureCode: null,
      });
      return deepFreeze({
        created: resultWrite.created || outcomeWrite.created,
        outcome: outcomeWrite.outcome,
        result: resultWrite.result,
      });
    });
  }

  function recordProcessingUnknown(value = {}) {
    exactObject(value, UNKNOWN_REQUEST_FIELDS, "schedule_result_processing_unknown_request_invalid");
    const binding = normalizeProcessingBinding(value.binding);
    const safeFailureCode = safeFailureCodeValue(value.safeFailureCode, PROCESSING_UNKNOWN_CODES);
    const processedAt = trustedNow(now);
    return transaction(database, () => writeProcessingOutcome({
      binding,
      outcome: "unknown",
      processedAt,
      resultEvidenceDigest: null,
      resultId: null,
      safeFailureCode,
    }));
  }

  function getProcessingOutcome(value = {}) {
    exactObject(value, PROCESSING_READ_FIELDS, "schedule_result_processing_read_request_invalid");
    const tenantScope = safeToken(value.tenantScope, "tenantScope");
    const runId = safeToken(value.runId, "runId");
    const binding = normalizeProcessingBinding(value.expectedBinding);
    if (binding.tenantScope !== tenantScope || binding.runId !== runId) {
      throw failure("schedule_result_processing_binding_mismatch");
    }
    const row = readProcessingOutcomeRow(database, tenantScope, runId);
    if (!row) return null;
    return authenticateProcessingOutcome(row, binding);
  }

  function getInternalProcessingOutcomeEvidence(value = {}) {
    exactObject(value, PROCESSING_INTERNAL_READ_FIELDS, "schedule_result_processing_read_request_invalid");
    const tenantScope = safeToken(value.tenantScope, "tenantScope");
    const runId = safeToken(value.runId, "runId");
    const row = readProcessingOutcomeRow(database, tenantScope, runId);
    if (!row) return null;
    const binding = processingBindingFromRow(row);
    return deepFreeze({
      contractVersion: "schedule-result-processing-outcome-internal-evidence.v1",
      binding,
      evidenceBoundary: "internal_only",
      outcome: authenticateProcessingOutcome(row, binding),
    });
  }

  function writeParsedResult(candidate) {
    const { alertPlan, binding, ciphertext, contentHmacDigest, contract, resultId, retention,
      safeSummary, safeSummaryDigest, sealedAt } = candidate;
    const existing = readRow(database, binding.tenantScope, binding.runId);
    if (existing) {
      requireSame(existing, candidate);
      return Object.freeze({ created: false, result: verifyRow(existing) });
    }
    if (database.prepare("SELECT 1 FROM schedule_results WHERE tenant_scope=? AND canonical_task_id=?")
      .get(binding.tenantScope, binding.canonicalTaskId)) {
      throw failure("schedule_result_task_conflict");
    }
    database.prepare(`INSERT INTO schedule_results (
      tenant_scope,result_id,employee_id,schedule_id,run_id,canonical_task_id,trigger_id,scheduled_for,
      activation_version,activation_snapshot_id,activation_snapshot_digest,result_contract_id,
      result_contract_version,result_contract_digest,result_type,schema_version,content_hmac_digest,
      ciphertext,encryption_key_id,encryption_algorithm,safe_outcome_code,safe_severity_code,
      safe_summary_code,safe_summary_digest,alert_contract_digest,alert_policy_version,alert_plan_digest,
      alert_mode,retention_policy_version,retention_policy_digest,payload_retain_until,sealed_at
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'aes-256-gcm',?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      binding.tenantScope, resultId, binding.employeeId, binding.scheduleId, binding.runId,
      binding.canonicalTaskId, binding.triggerId, binding.scheduledFor, binding.activationVersion,
      binding.activationSnapshotId, binding.activationSnapshotDigest, contract.resultContractId,
      contract.resultContractVersion, contract.contractDigest, contract.resultType, contract.schemaVersion,
      contentHmacDigest, ciphertext, currentKeyId, safeSummary.outcomeCode, safeSummary.severityCode,
      safeSummary.summaryCode, safeSummaryDigest, alertPlan.alertContractDigest, alertPlan.policyVersion,
      alertPlan.planDigest, alertPlan.mode, retention.policyVersion, retention.policyDigest,
      retention.payloadRetainUntil, sealedAt,
    );
    for (const recipient of alertPlan.recipients) {
      const alertId = deterministicId("schedule_result_alert", [
        binding.tenantScope, resultId, alertPlan.planDigest, recipient.ruleId,
        recipient.recipientPrincipalDigest, recipient.generation,
      ]);
      database.prepare(`INSERT INTO schedule_result_alert_outbox (
        tenant_scope,alert_id,result_id,run_id,alert_contract_digest,policy_version,plan_digest,
        rule_id,recipient_role,recipient_principal_digest,generation,alert_state,created_at
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,'held',?)`).run(
        binding.tenantScope, alertId, resultId, binding.runId, alertPlan.alertContractDigest,
        alertPlan.policyVersion, alertPlan.planDigest, recipient.ruleId, recipient.recipientRole,
        recipient.recipientPrincipalDigest, recipient.generation, sealedAt,
      );
    }
    return Object.freeze({ created: true, result: verifyRow(readRow(database, binding.tenantScope, binding.runId)) });
  }

  function writeProcessingOutcome(value) {
    const candidate = buildProcessingOutcomeCandidate(value, hmacKey);
    const existing = readProcessingOutcomeRow(database, candidate.binding.tenantScope, candidate.binding.runId);
    if (existing) {
      const outcome = authenticateProcessingOutcome(existing, candidate.binding);
      if (outcome.processingEvidenceDigest !== candidate.processingEvidenceDigest) {
        throw failure("schedule_result_processing_outcome_conflict");
      }
      return Object.freeze({ created: false, outcome });
    }
    requireNoProcessingIdentityConflict(database, candidate.binding);
    if (candidate.outcome !== "parsed_result" && readRow(
      database, candidate.binding.tenantScope, candidate.binding.runId,
    )) throw failure("schedule_result_processing_outcome_conflict");
    database.prepare(`INSERT INTO schedule_result_processing_outcomes (
      tenant_scope,outcome_id,employee_id,schedule_id,run_id,canonical_task_id,trigger_id,scheduled_for,
      activation_version,activation_snapshot_id,activation_snapshot_digest,processing_authority_digest,
      result_contract_digest,alert_contract_digest,retention_definition_digest,ingest_ref,
      ingest_evidence_digest,provider_attempt_evidence_digest,run_lease_binding_digest,
      processing_outcome,result_id,result_evidence_digest,safe_failure_code,processing_evidence_digest,
      integrity_hmac_digest,processed_at
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      candidate.binding.tenantScope, candidate.outcomeId, candidate.binding.employeeId,
      candidate.binding.scheduleId, candidate.binding.runId, candidate.binding.canonicalTaskId,
      candidate.binding.triggerId, candidate.binding.scheduledFor, candidate.binding.activationVersion,
      candidate.binding.activationSnapshotId, candidate.binding.activationSnapshotDigest,
      candidate.binding.processingAuthorityDigest, candidate.binding.resultContractDigest,
      candidate.binding.alertContractDigest, candidate.binding.retentionDefinitionDigest,
      candidate.binding.ingestRef, candidate.binding.ingestEvidenceDigest,
      candidate.binding.providerAttemptEvidenceDigest, candidate.binding.runLeaseBindingDigest,
      candidate.outcome, candidate.resultId, candidate.resultEvidenceDigest, candidate.safeFailureCode,
      candidate.processingEvidenceDigest, candidate.integrityHmacDigest, candidate.processedAt,
    );
    return Object.freeze({
      created: true,
      outcome: authenticateProcessingOutcome(
        readProcessingOutcomeRow(database, candidate.binding.tenantScope, candidate.binding.runId),
        candidate.binding,
      ),
    });
  }

  function buildParsedResultCandidate({ alertPlan, binding, contract, parsed, retention, safeSummary, sealedAt }) {
    const resultId = deterministicId("schedule_result", [binding]);
    const payloadJson = canonicalJson(parsed.payload);
    const contentHmacDigest = keyedDigest(hmacKey, "schedule-result-payload.v1", [
      binding.tenantScope, binding.runId, resultId, payloadJson,
    ]);
    const safeSummaryDigest = digestCanonical(safeSummary);
    const aad = canonicalJson({
      contractVersion: "schedule-result-ciphertext.v1", binding, resultId,
      resultContractId: contract.resultContractId,
      resultContractVersion: contract.resultContractVersion,
      resultContractDigest: contract.contractDigest,
      resultType: contract.resultType, schemaVersion: contract.schemaVersion,
      contentHmacDigest, safeSummaryDigest, encryptionKeyId: currentKeyId,
      encryptionAlgorithm: "aes-256-gcm", sealedAt,
      retentionPolicyVersion: retention.policyVersion,
      retentionPolicyDigest: retention.policyDigest,
      payloadRetainUntil: retention.payloadRetainUntil,
      alertPlanDigest: alertPlan.planDigest,
    });
    return {
      alertPlan,
      binding,
      ciphertext: encrypt(keyring.get(currentKeyId), payloadJson, aad),
      contentHmacDigest,
      contract,
      resultId,
      retention,
      safeSummary,
      safeSummaryDigest,
      sealedAt,
    };
  }

  function internalResultEvidence(row, binding) {
    requireBinding(row, binding);
    verifyHeldAlerts(database, row);
    const verified = authenticate(row, binding);
    const resultEvidenceDigest = digestCanonical({
      contractVersion: "schedule-result-record-evidence-binding.v1",
      binding,
      resultContract: {
        resultContractId: row.result_contract_id,
        resultContractVersion: row.result_contract_version,
        resultContractDigest: row.result_contract_digest,
        resultType: row.result_type,
        schemaVersion: row.schema_version,
      },
      contentHmacDigest: row.content_hmac_digest,
      safeSummaryDigest: row.safe_summary_digest,
      alertPlanDigest: row.alert_plan_digest,
      retentionPolicyDigest: row.retention_policy_digest,
    });
    return deepFreeze({
      contractVersion: "schedule-result-record-evidence.v1",
      resultEvidenceDigest,
      state: "sealed_pending_task",
      safeSummary: verified.projection.safeSummary,
      alerts: verified.projection.alerts,
      sealedAt: row.sealed_at,
    });
  }

  function authenticateProcessingOutcome(row, expectedBinding) {
    const binding = processingBindingFromRow(row);
    if (!isDeepStrictEqual(binding, expectedBinding)) {
      throw failure("schedule_result_processing_binding_mismatch");
    }
    const candidate = buildProcessingOutcomeCandidate({
      binding,
      outcome: row.processing_outcome,
      processedAt: row.processed_at,
      resultEvidenceDigest: row.result_evidence_digest,
      resultId: row.result_id,
      safeFailureCode: row.safe_failure_code,
    }, hmacKey);
    if (candidate.outcomeId !== row.outcome_id ||
      candidate.processingEvidenceDigest !== row.processing_evidence_digest ||
      !safeEqualDigest(candidate.integrityHmacDigest, row.integrity_hmac_digest)) {
      throw failure("schedule_result_processing_outcome_integrity_invalid");
    }
    if (candidate.outcome === "parsed_result") {
      const resultRow = readRow(database, binding.tenantScope, binding.runId);
      if (!resultRow || resultRow.result_id !== candidate.resultId) {
        throw failure("schedule_result_processing_outcome_integrity_invalid");
      }
      const evidence = internalResultEvidence(resultRow, resultBindingFromProcessing(binding));
      if (evidence.resultEvidenceDigest !== candidate.resultEvidenceDigest) {
        throw failure("schedule_result_processing_outcome_integrity_invalid");
      }
    } else if (readRow(database, binding.tenantScope, binding.runId)) {
      throw failure("schedule_result_processing_outcome_integrity_invalid");
    }
    return projectProcessingOutcome(candidate);
  }

  function getResultSafeProjection({ tenantScope, runId } = {}) {
    const row = readRow(database, safeToken(tenantScope, "tenantScope"), safeToken(runId, "runId"));
    return row ? verifyRow(row) : null;
  }

  function readInternalPayload({ tenantScope, runId, expectedBinding } = {}) {
    const row = readRow(database, safeToken(tenantScope, "tenantScope"), safeToken(runId, "runId"));
    if (!row) return null;
    const binding = normalizeBinding(expectedBinding);
    requireBinding(row, binding);
    verifyHeldAlerts(database, row);
    const verified = authenticate(row, binding);
    if (trustedNow(now) >= row.payload_retain_until) throw failure("schedule_result_payload_expired");
    return deepFreeze({ payload: verified.payload, payloadBoundary: "internal_only", result: verified.projection });
  }

  function getInternalResultEvidence(value = {}) {
    exactObject(value, INTERNAL_EVIDENCE_FIELDS, "schedule_result_evidence_request_invalid");
    const tenantScope = safeToken(value.tenantScope, "tenantScope");
    const runId = safeToken(value.runId, "runId");
    const row = readRow(database, tenantScope, runId);
    if (!row) return null;
    const binding = normalizeBinding(value.expectedBinding);
    return internalResultEvidence(row, binding);
  }

  function listHeldAlerts({ tenantScope, runId = null, limit = 100 } = {}) {
    const tenant = safeToken(tenantScope, "tenantScope");
    const safeRunId = runId === null ? null : safeToken(runId, "runId");
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200) throw failure("schedule_result_limit_invalid");
    const results = database.prepare(`SELECT * FROM schedule_results
      WHERE tenant_scope=? AND (? IS NULL OR run_id=?) ORDER BY sealed_at,result_id LIMIT 201`)
      .all(tenant, safeRunId, safeRunId);
    if (results.length > 200) throw failure("schedule_result_scan_bound_exceeded");
    const alerts = results.flatMap((row) => {
      verifyRow(row);
      return alertRows(database, row.tenant_scope, row.result_id);
    }).sort((left, right) => left.created_at.localeCompare(right.created_at) || left.alert_id.localeCompare(right.alert_id));
    return alerts.slice(0, limit).map((row) => deepFreeze({
        contractVersion: "schedule-result-held-alert.v1", alertId: row.alert_id,
        resultId: row.result_id, runId: row.run_id, alertContractDigest: row.alert_contract_digest,
        policyVersion: row.policy_version, planDigest: row.plan_digest, ruleId: row.rule_id,
        recipientRole: row.recipient_role, recipientPrincipalDigest: row.recipient_principal_digest,
        generation: row.generation, state: "held", createdAt: row.created_at,
      }));
  }

  function verifyRow(row) {
    const binding = bindingFromRow(row);
    verifyHeldAlerts(database, row);
    return authenticate(row, binding).projection;
  }

  function authenticate(row, binding) {
    const projection = safeProjection(row);
    const key = keyring.get(row.encryption_key_id);
    if (!key) throw failure("schedule_result_encryption_key_unavailable");
    const payload = JSON.parse(decrypt(key, row.ciphertext, aadFromRow(row, binding)));
    const actual = keyedDigest(hmacKey, "schedule-result-payload.v1", [
      binding.tenantScope, binding.runId, row.result_id, canonicalJson(payload),
    ]);
    if (actual !== row.content_hmac_digest) throw failure("schedule_result_integrity_invalid");
    return { payload, projection };
  }

  return Object.freeze({
    contractVersion: "schedule-result-repository.v2", close: () => database.close(),
    getInternalProcessingOutcomeEvidence, getInternalResultEvidence, getProcessingOutcome,
    getResultSafeProjection, listHeldAlerts,
    processEnvelopeAndHoldAlerts, readInternalPayload, recordProcessingUnknown,
  });
}

function normalizeBinding(value) {
  exactObject(value, BINDING_FIELDS, "schedule_result_binding_invalid");
  if (value.contractVersion !== BINDING_VERSION) throw failure("schedule_result_binding_invalid");
  return deepFreeze({
    contractVersion: BINDING_VERSION, tenantScope: safeToken(value.tenantScope),
    employeeId: safeToken(value.employeeId), scheduleId: safeToken(value.scheduleId),
    runId: safeToken(value.runId), canonicalTaskId: safeToken(value.canonicalTaskId),
    triggerId: safeToken(value.triggerId), scheduledFor: timestamp(value.scheduledFor),
    activationVersion: positiveInteger(value.activationVersion),
    activationSnapshotId: safeToken(value.activationSnapshotId),
    activationSnapshotDigest: digest(value.activationSnapshotDigest),
    resultContractDigest: digest(value.resultContractDigest),
    alertContractDigest: digest(value.alertContractDigest),
  });
}

function normalizeProcessingBinding(value) {
  exactObject(value, PROCESSING_BINDING_FIELDS, "schedule_result_processing_binding_invalid");
  if (value.contractVersion !== PROCESSING_BINDING_VERSION) {
    throw failure("schedule_result_processing_binding_invalid");
  }
  const processing = createScheduleResultProcessingBinding({
    resultContractDigest: value.resultContractDigest,
    alertContractDigest: value.alertContractDigest,
    retentionDefinitionDigest: value.retentionDefinitionDigest,
  });
  if (processing.processingAuthorityDigest !== digest(value.processingAuthorityDigest)) {
    throw failure("schedule_result_processing_binding_mismatch");
  }
  return deepFreeze({
    contractVersion: PROCESSING_BINDING_VERSION,
    tenantScope: safeToken(value.tenantScope, "tenantScope"),
    employeeId: safeToken(value.employeeId, "employeeId"),
    scheduleId: safeToken(value.scheduleId, "scheduleId"),
    runId: safeToken(value.runId, "runId"),
    canonicalTaskId: safeToken(value.canonicalTaskId, "canonicalTaskId"),
    triggerId: safeToken(value.triggerId, "triggerId"),
    scheduledFor: timestamp(value.scheduledFor),
    activationVersion: positiveInteger(value.activationVersion),
    activationSnapshotId: safeToken(value.activationSnapshotId, "activationSnapshotId"),
    activationSnapshotDigest: digest(value.activationSnapshotDigest),
    processingAuthorityDigest: processing.processingAuthorityDigest,
    resultContractDigest: processing.resultContractDigest,
    alertContractDigest: processing.alertContractDigest,
    retentionDefinitionDigest: processing.retentionDefinitionDigest,
    ingestRef: safeToken(value.ingestRef, "ingestRef"),
    ingestEvidenceDigest: digest(value.ingestEvidenceDigest),
    providerAttemptEvidenceDigest: digest(value.providerAttemptEvidenceDigest),
    runLeaseBindingDigest: digest(value.runLeaseBindingDigest),
  });
}

function normalizeProcessingResolution(value) {
  exactObject(value, PROCESSING_RESOLUTION_FIELDS, "schedule_result_processing_resolution_invalid");
  if (value.contractVersion !== "schedule-result-processing-resolution.v1") {
    throw failure("schedule_result_processing_resolution_invalid");
  }
  const resultContract = normalizeScheduleResultContract(value.resultContract);
  const alertContract = normalizeScheduleResultAlertContract(value.alertContract);
  const retentionDefinition = normalizeScheduleResultRetentionDefinition(value.retentionDefinition);
  const authority = normalizeScheduleResultProcessingAuthority(value.authority, {
    resultContract, alertContract, retentionDefinition,
  });
  return deepFreeze({
    contractVersion: "schedule-result-processing-resolution.v1",
    authority,
    resultContract,
    alertContract,
    retentionDefinition,
  });
}

function requireProcessingResolution(binding, resolution) {
  if (binding.processingAuthorityDigest !== resolution.authority.processingAuthorityDigest ||
    binding.resultContractDigest !== resolution.resultContract.contractDigest ||
    binding.alertContractDigest !== resolution.alertContract.alertContractDigest ||
    binding.retentionDefinitionDigest !== resolution.retentionDefinition.retentionDefinitionDigest) {
    throw failure("schedule_result_processing_resolution_mismatch");
  }
}

function resultBindingFromProcessing(binding) {
  return normalizeBinding({
    contractVersion: BINDING_VERSION,
    tenantScope: binding.tenantScope,
    employeeId: binding.employeeId,
    scheduleId: binding.scheduleId,
    runId: binding.runId,
    canonicalTaskId: binding.canonicalTaskId,
    triggerId: binding.triggerId,
    scheduledFor: binding.scheduledFor,
    activationVersion: binding.activationVersion,
    activationSnapshotId: binding.activationSnapshotId,
    activationSnapshotDigest: binding.activationSnapshotDigest,
    resultContractDigest: binding.resultContractDigest,
    alertContractDigest: binding.alertContractDigest,
  });
}

function deriveRetentionPlan(definition, processedAt) {
  const payloadRetainUntil = new Date(
    Date.parse(processedAt) + definition.payloadRetentionSeconds * 1_000,
  ).toISOString();
  const body = {
    contractVersion: RETENTION_VERSION,
    policyVersion: safeToken(
      `${definition.retentionDefinitionId}.v${definition.retentionDefinitionVersion}`,
      "policyVersion",
    ),
    payloadRetainUntil,
  };
  return deepFreeze({ ...body, policyDigest: digestCanonical(body) });
}

function requireAlertPlanForOutcome(plan, contract, outcomeCode) {
  if (plan.alertContractDigest !== contract.alertContractDigest || plan.policyVersion !== contract.policyVersion) {
    throw failure("schedule_result_alert_plan_contract_mismatch");
  }
  const applicable = contract.rules.filter((rule) => rule.outcomeCodes.includes(outcomeCode));
  const byRule = new Map(applicable.map((rule) => [rule.ruleId, rule]));
  const counts = new Map();
  for (const recipient of plan.recipients) {
    const rule = byRule.get(recipient.ruleId);
    if (!rule || recipient.recipientRole !== rule.recipientRole) {
      throw failure("schedule_result_alert_plan_contract_mismatch");
    }
    counts.set(rule.ruleId, (counts.get(rule.ruleId) || 0) + 1);
  }
  const validCounts = applicable.every((rule) => {
    const count = counts.get(rule.ruleId) || 0;
    return count >= 1 && count <= rule.maxRecipients;
  });
  if (!validCounts || counts.size !== applicable.length ||
    (plan.mode === "required") !== (applicable.length > 0)) {
    throw failure("schedule_result_alert_plan_contract_mismatch");
  }
}

function buildProcessingOutcomeCandidate({
  binding, outcome, processedAt, resultEvidenceDigest, resultId, safeFailureCode,
}, hmacKey) {
  const normalizedBinding = normalizeProcessingBinding(binding);
  if (!new Set(["parsed_result", "parse_failed", "unknown"]).has(outcome)) {
    throw failure("schedule_result_processing_outcome_invalid");
  }
  const normalizedResultId = resultId === null ? null : safeToken(resultId, "resultId");
  const normalizedResultEvidence = resultEvidenceDigest === null ? null : digest(resultEvidenceDigest);
  const normalizedFailureCode = safeFailureCode === null
    ? null
    : safeFailureCodeValue(
      safeFailureCode,
      outcome === "parse_failed" ? DETERMINISTIC_PARSE_FAILURE_CODES : PROCESSING_UNKNOWN_CODES,
    );
  const valid = outcome === "parsed_result"
    ? normalizedResultId !== null && normalizedResultEvidence !== null && normalizedFailureCode === null
    : normalizedResultId === null && normalizedResultEvidence === null && normalizedFailureCode !== null;
  if (!valid) throw failure("schedule_result_processing_outcome_invalid");
  const outcomeId = deterministicId("schedule_result_processing_outcome", [normalizedBinding]);
  const body = {
    contractVersion: "schedule-result-processing-outcome.v1",
    outcomeVersion: 1,
    binding: normalizedBinding,
    outcome,
    resultId: normalizedResultId,
    resultEvidenceDigest: normalizedResultEvidence,
    safeFailureCode: normalizedFailureCode,
  };
  const processingEvidenceDigest = digestCanonical(body);
  const safeProcessedAt = timestamp(processedAt);
  const integrityHmacDigest = keyedDigest(hmacKey, "schedule-result-processing-outcome-row.v1", [
    outcomeId, processingEvidenceDigest, safeProcessedAt,
  ]);
  return deepFreeze({
    ...body,
    outcomeId,
    processingEvidenceDigest,
    integrityHmacDigest,
    processedAt: safeProcessedAt,
  });
}

function processingBindingFromRow(row) {
  if (!row) throw failure("schedule_result_processing_outcome_integrity_invalid");
  return normalizeProcessingBinding({
    contractVersion: PROCESSING_BINDING_VERSION,
    tenantScope: row.tenant_scope,
    employeeId: row.employee_id,
    scheduleId: row.schedule_id,
    runId: row.run_id,
    canonicalTaskId: row.canonical_task_id,
    triggerId: row.trigger_id,
    scheduledFor: row.scheduled_for,
    activationVersion: row.activation_version,
    activationSnapshotId: row.activation_snapshot_id,
    activationSnapshotDigest: row.activation_snapshot_digest,
    processingAuthorityDigest: row.processing_authority_digest,
    resultContractDigest: row.result_contract_digest,
    alertContractDigest: row.alert_contract_digest,
    retentionDefinitionDigest: row.retention_definition_digest,
    ingestRef: row.ingest_ref,
    ingestEvidenceDigest: row.ingest_evidence_digest,
    providerAttemptEvidenceDigest: row.provider_attempt_evidence_digest,
    runLeaseBindingDigest: row.run_lease_binding_digest,
  });
}

function projectProcessingOutcome(candidate) {
  return deepFreeze({
    contractVersion: PROCESSING_EVIDENCE_VERSION,
    state: candidate.outcome,
    processingEvidenceDigest: candidate.processingEvidenceDigest,
    resultEvidenceDigest: candidate.resultEvidenceDigest,
    safeFailureCode: candidate.safeFailureCode,
    processedAt: candidate.processedAt,
  });
}

function requireNoProcessingIdentityConflict(database, binding) {
  const conflict = database.prepare(`SELECT 1 FROM schedule_result_processing_outcomes
    WHERE tenant_scope=? AND (canonical_task_id=? OR ingest_ref=?)`).get(
    binding.tenantScope, binding.canonicalTaskId, binding.ingestRef,
  );
  if (conflict) throw failure("schedule_result_processing_outcome_conflict");
}

function safeFailureCodeValue(value, allowed) {
  const result = safeToken(value, "safeFailureCode");
  if (!allowed.has(result)) throw failure("schedule_result_processing_failure_code_invalid");
  return result;
}

function safeEqualDigest(left, right) {
  const leftBuffer = Buffer.from(String(left || ""));
  const rightBuffer = Buffer.from(String(right || ""));
  return leftBuffer.length === rightBuffer.length && crypto.timingSafeEqual(leftBuffer, rightBuffer);
}

function normalizeAlertPlan(value) {
  exactObject(value, ALERT_FIELDS, "schedule_result_alert_plan_invalid");
  if (value.contractVersion !== ALERT_PLAN_VERSION || !Array.isArray(value.recipients) || value.recipients.length > 32) {
    throw failure("schedule_result_alert_plan_invalid");
  }
  const mode = value.mode;
  const recipients = value.recipients.map((item) => {
    exactObject(item, RECIPIENT_FIELDS, "schedule_result_alert_plan_invalid");
    return { ruleId: safeToken(item.ruleId), recipientRole: safeToken(item.recipientRole),
      recipientPrincipalDigest: digest(item.recipientPrincipalDigest), generation: positiveInteger(item.generation) };
  }).sort((a, b) => canonicalJson(a).localeCompare(canonicalJson(b)));
  if (!new Set(["required", "not_required"]).has(mode) || (mode === "required") !== (recipients.length > 0)) {
    throw failure("schedule_result_alert_plan_invalid");
  }
  const identities = recipients.map((item) => canonicalJson([item.ruleId, item.recipientPrincipalDigest, item.generation]));
  if (new Set(identities).size !== identities.length) throw failure("schedule_result_alert_plan_invalid");
  const body = { contractVersion: ALERT_PLAN_VERSION, alertContractDigest: digest(value.alertContractDigest),
    policyVersion: safeToken(value.policyVersion), mode, recipients };
  if (digest(value.planDigest) !== digestCanonical(body)) throw failure("schedule_result_alert_plan_digest_mismatch");
  return deepFreeze({ ...body, planDigest: value.planDigest });
}

function safeProjection(row) {
  const binding = bindingFromRow(row);
  const expectedId = deterministicId("schedule_result", [binding]);
  const authenticatedSummary = { contractVersion: "schedule-result-safe-summary.v1",
    resultContractId: row.result_contract_id, resultContractVersion: row.result_contract_version,
    resultContractDigest: row.result_contract_digest, resultType: row.result_type,
    schemaVersion: row.schema_version, outcomeCode: row.safe_outcome_code,
    severityCode: row.safe_severity_code, summaryCode: row.safe_summary_code };
  if (expectedId !== row.result_id || digestCanonical(authenticatedSummary) !== row.safe_summary_digest) {
    throw failure("schedule_result_integrity_invalid");
  }
  const safeSummary = {
    contractVersion: authenticatedSummary.contractVersion,
    resultContractId: authenticatedSummary.resultContractId,
    resultContractVersion: authenticatedSummary.resultContractVersion,
    resultType: authenticatedSummary.resultType,
    schemaVersion: authenticatedSummary.schemaVersion,
    outcomeCode: authenticatedSummary.outcomeCode,
    severityCode: authenticatedSummary.severityCode,
    summaryCode: authenticatedSummary.summaryCode,
  };
  return deepFreeze({ contractVersion: "schedule-result-safe-projection.v1", safeSummary,
    state: "sealed_pending_task",
    alerts: row.alert_mode === "required" ? "held" : "not_required", payloadPersisted: true,
    payloadRetainUntil: row.payload_retain_until, sealedAt: row.sealed_at });
}

function requireSame(row, candidate) {
  requireBinding(row, candidate.binding);
  if (row.result_id !== candidate.resultId || row.result_contract_id !== candidate.contract.resultContractId ||
    row.result_contract_version !== candidate.contract.resultContractVersion ||
    row.result_type !== candidate.contract.resultType || row.schema_version !== candidate.contract.schemaVersion ||
    row.content_hmac_digest !== candidate.contentHmacDigest || row.safe_summary_digest !== candidate.safeSummaryDigest ||
    row.alert_plan_digest !== candidate.alertPlan.planDigest || row.retention_policy_digest !== candidate.retention.policyDigest) {
    throw failure("schedule_result_idempotency_conflict");
  }
}

function requireBinding(row, binding) {
  if (!isDeepStrictEqual(bindingFromRow(row), binding)) throw failure("schedule_result_binding_mismatch");
}

function bindingFromRow(row) {
  return deepFreeze({ contractVersion: BINDING_VERSION, tenantScope: row.tenant_scope,
    employeeId: row.employee_id, scheduleId: row.schedule_id, runId: row.run_id,
    canonicalTaskId: row.canonical_task_id, triggerId: row.trigger_id, scheduledFor: row.scheduled_for,
    activationVersion: row.activation_version, activationSnapshotId: row.activation_snapshot_id,
    activationSnapshotDigest: row.activation_snapshot_digest, resultContractDigest: row.result_contract_digest,
    alertContractDigest: row.alert_contract_digest });
}

function alertRows(database, tenantScope, resultId) {
  return database.prepare(`SELECT * FROM schedule_result_alert_outbox
    WHERE tenant_scope=? AND result_id=? ORDER BY rule_id,recipient_principal_digest,generation`)
    .all(tenantScope, resultId);
}

function verifyHeldAlerts(database, row) {
  const alerts = alertRows(database, row.tenant_scope, row.result_id);
  if ((row.alert_mode === "required") !== (alerts.length > 0) || alerts.length > 32) {
    throw failure("schedule_result_alert_set_invalid");
  }
  const recipients = alerts.map((alert) => {
    const expectedId = deterministicId("schedule_result_alert", [
      row.tenant_scope, row.result_id, row.alert_plan_digest, alert.rule_id,
      alert.recipient_principal_digest, alert.generation,
    ]);
    if (alert.alert_id !== expectedId || alert.run_id !== row.run_id ||
      alert.alert_contract_digest !== row.alert_contract_digest ||
      alert.policy_version !== row.alert_policy_version || alert.plan_digest !== row.alert_plan_digest ||
      alert.alert_state !== "held" || alert.created_at !== row.sealed_at) {
      throw failure("schedule_result_alert_set_invalid");
    }
    return { ruleId: alert.rule_id, recipientRole: alert.recipient_role,
      recipientPrincipalDigest: alert.recipient_principal_digest, generation: alert.generation };
  }).sort((a, b) => canonicalJson(a).localeCompare(canonicalJson(b)));
  const body = { contractVersion: ALERT_PLAN_VERSION, alertContractDigest: row.alert_contract_digest,
    policyVersion: row.alert_policy_version, mode: row.alert_mode, recipients };
  if (digestCanonical(body) !== row.alert_plan_digest) throw failure("schedule_result_alert_set_invalid");
}

function aadFromRow(row, binding) {
  return canonicalJson({ contractVersion: "schedule-result-ciphertext.v1", binding, resultId: row.result_id,
    resultContractId: row.result_contract_id, resultContractVersion: row.result_contract_version,
    resultContractDigest: row.result_contract_digest, resultType: row.result_type, schemaVersion: row.schema_version,
    contentHmacDigest: row.content_hmac_digest, safeSummaryDigest: row.safe_summary_digest,
    encryptionKeyId: row.encryption_key_id, encryptionAlgorithm: row.encryption_algorithm, sealedAt: row.sealed_at,
    retentionPolicyVersion: row.retention_policy_version, retentionPolicyDigest: row.retention_policy_digest,
    payloadRetainUntil: row.payload_retain_until, alertPlanDigest: row.alert_plan_digest });
}

function initialize(database) {
  database.exec("PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL");
  const tables = tableNames(database);
  if (tables.length === 0) transaction(database, () => database.exec(SCHEMA_V2_SQL));
  const schemaRows = database.prepare("SELECT singleton,version FROM schedule_result_schema").all();
  if (schemaRows.length !== 1 || schemaRows[0].singleton !== 1) throw invalidSchema();
  if (schemaRows[0].version === 1) {
    validateSchema(database, 1);
    transaction(database, () => {
      database.exec(`${PROCESSING_OUTCOME_TABLE_SQL};`);
      database.exec("DROP TABLE schedule_result_schema");
      database.exec(`${SCHEMA_V2_TABLE_SQL}; INSERT INTO schedule_result_schema VALUES (1, 2);`);
    });
  }
  validateSchema(database, 2);
}

function validateSchema(database, version) {
  if (database.prepare("SELECT count(*) AS count FROM sqlite_master WHERE type IN ('trigger','view')").get().count !== 0) {
    throw invalidSchema();
  }
  const expectedTables = version === 1
    ? ["schedule_result_alert_outbox", "schedule_result_schema", "schedule_results"]
    : ["schedule_result_alert_outbox", "schedule_result_processing_outcomes", "schedule_result_schema", "schedule_results"];
  if (!isDeepStrictEqual(tableNames(database), expectedTables) ||
    database.prepare("SELECT count(*) AS count FROM schedule_result_schema").get()?.count !== 1 ||
    database.prepare("SELECT version FROM schedule_result_schema WHERE singleton=1").get()?.version !== version) {
    throw invalidSchema();
  }
  requireColumns(database, "schedule_result_schema", [["singleton","INTEGER",0,1],["version","INTEGER",1,0]]);
  requireColumns(database, "schedule_results", [
    ["tenant_scope","TEXT",1,1],["result_id","TEXT",1,2],["employee_id","TEXT",1,0],
    ["schedule_id","TEXT",1,0],["run_id","TEXT",1,0],["canonical_task_id","TEXT",1,0],
    ["trigger_id","TEXT",1,0],["scheduled_for","TEXT",1,0],["activation_version","INTEGER",1,0],
    ["activation_snapshot_id","TEXT",1,0],["activation_snapshot_digest","TEXT",1,0],
    ["result_contract_id","TEXT",1,0],["result_contract_version","INTEGER",1,0],
    ["result_contract_digest","TEXT",1,0],["result_type","TEXT",1,0],["schema_version","TEXT",1,0],
    ["content_hmac_digest","TEXT",1,0],["ciphertext","TEXT",1,0],["encryption_key_id","TEXT",1,0],
    ["encryption_algorithm","TEXT",1,0],["safe_outcome_code","TEXT",1,0],["safe_severity_code","TEXT",1,0],
    ["safe_summary_code","TEXT",1,0],["safe_summary_digest","TEXT",1,0],["alert_contract_digest","TEXT",1,0],
    ["alert_policy_version","TEXT",1,0],["alert_plan_digest","TEXT",1,0],["alert_mode","TEXT",1,0],
    ["retention_policy_version","TEXT",1,0],["retention_policy_digest","TEXT",1,0],
    ["payload_retain_until","TEXT",1,0],["sealed_at","TEXT",1,0],
  ]);
  requireColumns(database, "schedule_result_alert_outbox", [
    ["tenant_scope","TEXT",1,1],["alert_id","TEXT",1,2],["result_id","TEXT",1,0],["run_id","TEXT",1,0],
    ["alert_contract_digest","TEXT",1,0],["policy_version","TEXT",1,0],["plan_digest","TEXT",1,0],
    ["rule_id","TEXT",1,0],["recipient_role","TEXT",1,0],["recipient_principal_digest","TEXT",1,0],
    ["generation","INTEGER",1,0],["alert_state","TEXT",1,0],["created_at","TEXT",1,0],
  ]);
  if (version === 2) {
    requireColumns(database, "schedule_result_processing_outcomes", [
      ["tenant_scope","TEXT",1,1],["outcome_id","TEXT",1,2],["employee_id","TEXT",1,0],
      ["schedule_id","TEXT",1,0],["run_id","TEXT",1,0],["canonical_task_id","TEXT",1,0],
      ["trigger_id","TEXT",1,0],["scheduled_for","TEXT",1,0],["activation_version","INTEGER",1,0],
      ["activation_snapshot_id","TEXT",1,0],["activation_snapshot_digest","TEXT",1,0],
      ["processing_authority_digest","TEXT",1,0],["result_contract_digest","TEXT",1,0],
      ["alert_contract_digest","TEXT",1,0],["retention_definition_digest","TEXT",1,0],
      ["ingest_ref","TEXT",1,0],["ingest_evidence_digest","TEXT",1,0],
      ["provider_attempt_evidence_digest","TEXT",1,0],["run_lease_binding_digest","TEXT",1,0],
      ["processing_outcome","TEXT",1,0],["result_id","TEXT",0,0],["result_evidence_digest","TEXT",0,0],
      ["safe_failure_code","TEXT",0,0],["processing_evidence_digest","TEXT",1,0],
      ["integrity_hmac_digest","TEXT",1,0],["processed_at","TEXT",1,0],
    ]);
  }
  requireIndexes(database, "schedule_results", [
    ["pk",1,["tenant_scope","result_id"],false,null],["u",1,["tenant_scope","run_id"],false,null],
    ["u",1,["tenant_scope","canonical_task_id"],false,null],
  ]);
  requireIndexes(database, "schedule_result_alert_outbox", [
    ["pk",1,["tenant_scope","alert_id"],false,null],
    ["u",1,["tenant_scope","result_id","rule_id","recipient_principal_digest","generation"],false,null],
    ["c",0,["tenant_scope","result_id","alert_id"],true,"schedule_result_alert_held_idx"],
  ]);
  if (version === 2) {
    requireIndexes(database, "schedule_result_processing_outcomes", [
      ["pk",1,["tenant_scope","outcome_id"],false,null],
      ["u",1,["tenant_scope","run_id"],false,null],
      ["u",1,["tenant_scope","canonical_task_id"],false,null],
      ["u",1,["tenant_scope","ingest_ref"],false,null],
    ]);
  }
  const sql = database.prepare("SELECT sql FROM sqlite_master WHERE type='index' AND name='schedule_result_alert_held_idx'").get()?.sql;
  if (!/WHERE\s+alert_state\s*=\s*'held'\s*$/i.test(String(sql || ""))) throw invalidSchema();
  const expectedSql = new Map([
    ["schedule_result_schema", version === 1 ? SCHEMA_V1_TABLE_SQL : SCHEMA_V2_TABLE_SQL],
    ["schedule_results", RESULTS_TABLE_SQL],
    ["schedule_result_alert_outbox", ALERT_TABLE_SQL],
  ]);
  if (version === 2) expectedSql.set("schedule_result_processing_outcomes", PROCESSING_OUTCOME_TABLE_SQL);
  for (const table of expectedTables) {
    const actual = database.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name=?").get(table)?.sql;
    if (normalizeSql(actual) !== normalizeSql(expectedSql.get(table))) throw invalidSchema();
  }
  const foreignKeys = database.prepare("PRAGMA foreign_key_list(schedule_result_alert_outbox)").all()
    .sort((a, b) => a.seq - b.seq).map((item) => [item.table,item.from,item.to,item.on_update,item.on_delete,item.match]);
  if (!isDeepStrictEqual(foreignKeys, [
    ["schedule_results","tenant_scope","tenant_scope","NO ACTION","RESTRICT","NONE"],
    ["schedule_results","result_id","result_id","NO ACTION","RESTRICT","NONE"],
  ])) throw invalidSchema();
  if (version === 2) {
    const outcomeForeignKeys = database.prepare("PRAGMA foreign_key_list(schedule_result_processing_outcomes)").all()
      .sort((a, b) => a.seq - b.seq)
      .map((item) => [item.table,item.from,item.to,item.on_update,item.on_delete,item.match]);
    if (!isDeepStrictEqual(outcomeForeignKeys, [
      ["schedule_results","tenant_scope","tenant_scope","NO ACTION","RESTRICT","NONE"],
      ["schedule_results","result_id","result_id","NO ACTION","RESTRICT","NONE"],
    ])) throw invalidSchema();
  }
}

function tableNames(db) { return db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map((r) => r.name); }
function readRow(db, tenant, runId) { return db.prepare("SELECT * FROM schedule_results WHERE tenant_scope=? AND run_id=?").get(tenant, runId) || null; }
function readProcessingOutcomeRow(db, tenant, runId) {
  return db.prepare("SELECT * FROM schedule_result_processing_outcomes WHERE tenant_scope=? AND run_id=?")
    .get(tenant, runId) || null;
}
function requireColumns(db, table, expected) {
  const actual = db.prepare(`PRAGMA table_info(${table})`).all().map((c) => [c.name,String(c.type).toUpperCase(),c.notnull,c.pk]);
  if (!isDeepStrictEqual(actual, expected)) throw invalidSchema();
}
function requireIndexes(db, table, expected) {
  const actual = db.prepare(`PRAGMA index_list(${table})`).all().map((i) => [i.origin,i.unique,
    db.prepare(`PRAGMA index_info(${i.name})`).all().sort((a,b) => a.seqno-b.seqno).map((x) => x.name),
    i.partial === 1, i.origin === "c" ? i.name : null]);
  const sort = (items) => items.toSorted((a,b) => canonicalJson(a).localeCompare(canonicalJson(b)));
  if (!isDeepStrictEqual(sort(actual), sort(expected))) throw invalidSchema();
}
function normalizeSql(value) { return String(value || "").replace(/\s+/g," ").replace(/;$/," ").trim(); }

function encrypt(key, plaintext, aad) {
  const iv = crypto.randomBytes(12); const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(Buffer.from(aad)); const body = Buffer.concat([cipher.update(plaintext,"utf8"),cipher.final()]);
  return [iv,cipher.getAuthTag(),body].map((part) => part.toString("base64")).join(".");
}
function decrypt(key, envelope, aad) {
  try {
    const parts = String(envelope).split(".").map((part) => Buffer.from(part,"base64"));
    if (parts.length !== 3 || parts[0].length !== 12 || parts[1].length !== 16 || parts[2].length === 0) throw new Error();
    const decipher = crypto.createDecipheriv("aes-256-gcm",key,parts[0]);
    decipher.setAAD(Buffer.from(aad)); decipher.setAuthTag(parts[1]);
    return Buffer.concat([decipher.update(parts[2]),decipher.final()]).toString("utf8");
  } catch { throw failure("schedule_result_decryption_failed"); }
}
function normalizeKeyring(value) {
  const entries = value instanceof Map ? [...value] : Object.entries(value || {});
  if (!entries.length || entries.length > 32) throw failure("schedule_result_keyring_invalid");
  return new Map(entries.map(([id,key]) => [safeToken(id),exactKey(key,"encryptionKey")]));
}
function exactKey(value, field) { const key = Buffer.isBuffer(value) ? Buffer.from(value) : Buffer.from(value || []); if (key.length !== 32) throw failure("schedule_result_key_invalid",field); return key; }
function normalizeDatabasePath(value) { const result=String(value||"").trim(); if(result===":memory:") return result; if(!result||!path.isAbsolute(result)) throw new TypeError("schedule result databasePath must be absolute or :memory:"); return path.normalize(result); }
function transaction(db, run) { db.exec("BEGIN IMMEDIATE"); try { const value=run(); db.exec("COMMIT"); return value; } catch(error) { if(db.isTransaction) db.exec("ROLLBACK"); throw error; } }
function trustedNow(now) { try { return timestamp(now()); } catch(error) { if(error?.code) throw error; throw failure("schedule_result_clock_invalid"); } }
function exactObject(value, fields, code) { if(!value||typeof value!=="object"||Array.isArray(value)||Object.keys(value).some((k)=>!fields.has(k))||[...fields].some((k)=>!Object.hasOwn(value,k))) throw failure(code); }
function safeToken(value, field="token") { const result=String(value||"").trim(); if(!TOKEN.test(result)||/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(result)||SECRET.test(result)) throw failure("schedule_result_token_invalid",field); return result; }
function digest(value) { const result=String(value||"").trim().toLowerCase(); if(!DIGEST.test(result)) throw failure("schedule_result_digest_invalid"); return result; }
function timestamp(value) { const input=value instanceof Date?value.toISOString():String(value||"").trim(); const parsed=new Date(input); if(!input||!Number.isFinite(parsed.getTime())||parsed.toISOString()!==input) throw failure("schedule_result_timestamp_invalid"); return input; }
function positiveInteger(value) { if(!Number.isSafeInteger(value)||value<1) throw failure("schedule_result_integer_invalid"); return value; }
function boundedRetention(value) { const max=365*24*60*60*1000; if(!Number.isSafeInteger(value)||value<1||value>max) throw failure("schedule_result_retention_bound_invalid"); return value; }
function deterministicId(prefix, parts) { return `${prefix}_${digestCanonical(parts)}`; }
function digestCanonical(value) { return crypto.createHash("sha256").update(canonicalJson(value)).digest("hex"); }
function keyedDigest(key, domain, parts) { return crypto.createHmac("sha256",key).update(canonicalJson([domain,...parts])).digest("hex"); }
function canonicalJson(value) { if(Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`; if(value&&typeof value==="object") return `{${Object.keys(value).sort().map((k)=>`${JSON.stringify(k)}:${canonicalJson(value[k])}`).join(",")}}`; const json=JSON.stringify(value); if(json===undefined) throw failure("schedule_result_value_invalid"); return json; }
function deepFreeze(value) { if(!value||typeof value!=="object"||Object.isFrozen(value)) return value; Object.freeze(value); Object.values(value).forEach(deepFreeze); return value; }
function invalidSchema() { return new TypeError("invalid schedule result SQLite schema v2"); }
function failure(code, detail="") { const error=new Error(detail?`${code}: ${detail}`:code); error.code=code; return error; }

export {
  ALERT_PLAN_VERSION as SCHEDULE_RESULT_ALERT_PLAN_CONTRACT_VERSION,
  BINDING_VERSION as SCHEDULE_RESULT_BINDING_CONTRACT_VERSION,
  PROCESSING_BINDING_VERSION as SCHEDULE_RESULT_PROCESSING_OUTCOME_BINDING_CONTRACT_VERSION,
  PROCESSING_EVIDENCE_VERSION as SCHEDULE_RESULT_PROCESSING_OUTCOME_EVIDENCE_CONTRACT_VERSION,
  RETENTION_VERSION as SCHEDULE_RESULT_RETENTION_CONTRACT_VERSION,
  digestCanonical as scheduleResultCanonicalDigest,
};
