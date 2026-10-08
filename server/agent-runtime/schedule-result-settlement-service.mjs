import crypto from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import {
  parseScheduleResult,
  projectScheduleResultSafeSummary,
} from "./schedule-result-contract.mjs";
import { projectScheduleRunTerminalEvidence } from "./sqlite-schedule-control-repository.mjs";

const REQUEST_FIELDS = new Set(["canonicalTaskId", "runId", "tenantScope"]);
const PROVIDER_EVIDENCE_FIELDS = new Set([
  "canonicalTaskId", "contractVersion", "ingestEvidenceDigest", "ingestRef",
  "providerAttemptEvidenceDigest", "runId", "state", "tenantScope",
]);
const ALERT_PLAN_FIELDS = new Set([
  "alertContractDigest", "contractVersion", "mode", "planDigest", "policyVersion", "recipients",
]);
const ALERT_RECIPIENT_FIELDS = new Set([
  "generation", "recipientPrincipalDigest", "recipientRole", "ruleId",
]);
const DETERMINISTIC_PARSE_FAILURE_CODES = new Set([
  "schedule_result_contract_binding_mismatch", "schedule_result_envelope_invalid",
  "schedule_result_outcome_unknown", "schedule_result_payload_invalid",
  "schedule_result_payload_too_large", "schedule_result_schema_version_mismatch",
  "schedule_result_type_mismatch",
]);
const ALERT_PLAN_FAILURE_CODES = new Set([
  "schedule_result_alert_contract_binding_mismatch", "schedule_result_alert_plan_contract_mismatch",
  "schedule_result_alert_plan_digest_mismatch", "schedule_result_alert_plan_invalid",
]);
const TOKEN = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,159}$/;
const DIGEST = /^[a-f0-9]{64}$/;

export function createScheduleResultSettlementService({
  controlRepository,
  resultRepository,
  resultIngestRepository,
  resolveProcessingAuthority,
  resolveProviderAttemptEvidence,
  resolveAlertPlan,
  now,
} = {}) {
  requireMethods(controlRepository, "controlRepository", [
    "adoptRunResultReceiptForReconciliation", "getActivationSnapshot", "getIntent",
    "getRunExecution", "getRunResultReceipt", "recordRunResultReceipt",
  ]);
  requireMethods(resultRepository, "resultRepository", [
    "getInternalProcessingOutcomeEvidence", "getResultSafeProjection", "listHeldAlerts",
    "processEnvelopeAndHoldAlerts", "recordProcessingUnknown",
  ]);
  requireMethods(resultIngestRepository, "resultIngestRepository", ["readInternalEnvelope"]);
  for (const [name, dependency] of [
    ["resolveProcessingAuthority", resolveProcessingAuthority],
    ["resolveProviderAttemptEvidence", resolveProviderAttemptEvidence],
    ["resolveAlertPlan", resolveAlertPlan],
    ["now", now],
  ]) {
    if (typeof dependency !== "function") throw new TypeError(`${name} must be a function`);
  }

  async function prepareCanonicalSettlement(value = {}) {
    exactObject(value, REQUEST_FIELDS, "schedule_result_settlement_request_invalid");
    const request = {
      tenantScope: token(value.tenantScope, "tenantScope"),
      runId: token(value.runId, "runId"),
      canonicalTaskId: token(value.canonicalTaskId, "canonicalTaskId"),
    };
    const intent = controlRepository.getIntent(request.runId, { tenantScope: request.tenantScope });
    const execution = controlRepository.getRunExecution(request.runId, { tenantScope: request.tenantScope });
    requireCurrentRun(request, intent, execution);
    const existingReceipt = controlRepository.getRunResultReceipt(request.runId, {
      tenantScope: request.tenantScope,
    });
    if (existingReceipt) return settlementFromReceipt(existingReceipt);
    if (execution.executionState !== "active" || !execution.leaseId || !execution.ownerDigest ||
      !execution.taskLeaseId || !execution.taskOwnerDigest) {
      throw serviceError("schedule_result_settlement_run_not_current");
    }

    const snapshot = controlRepository.getActivationSnapshot(intent.activationSnapshotId, {
      tenantScope: request.tenantScope,
    });
    requireSnapshot(intent, snapshot);
    const providerAttempt = normalizeProviderAttemptEvidence(await resolveProviderAttemptEvidence({
      tenantScope: request.tenantScope,
      runId: request.runId,
      canonicalTaskId: request.canonicalTaskId,
    }), request);
    const ingestBinding = createIngestBinding(intent, snapshot);
    const ingest = resultIngestRepository.readInternalEnvelope({
      tenantScope: request.tenantScope,
      runId: request.runId,
      expectedBinding: ingestBinding,
      providerAttemptEvidenceDigest: providerAttempt.providerAttemptEvidenceDigest,
    });
    if (!ingest) throw serviceError("schedule_result_ingest_unavailable");
    requireIngestEvidence(ingest, providerAttempt);
    const processingBinding = createProcessingBinding({
      execution,
      ingest,
      intent,
      providerAttempt,
      snapshot,
    });

    let internalOutcome = resultRepository.getInternalProcessingOutcomeEvidence({
      tenantScope: request.tenantScope,
      runId: request.runId,
    });
    if (internalOutcome) requireInternalOutcome(internalOutcome, processingBinding);
    if (!internalOutcome) {
      await persistProcessingOutcome({
        employeeId: intent.employeeId,
        ingest,
        processingBinding,
        request,
      });
      internalOutcome = resultRepository.getInternalProcessingOutcomeEvidence({
        tenantScope: request.tenantScope,
        runId: request.runId,
      });
      requireInternalOutcome(internalOutcome, processingBinding);
    }

    const governanceCurrent = await revalidateProcessingGovernance({
      internalOutcome,
      request,
    });
    const receiptEffectState = internalOutcome.outcome.state === "unknown" || !governanceCurrent
      ? "reconcile_required"
      : "settled";
    const recordedAt = trustedTimestamp(now());
    if (internalOutcome.outcome.processedAt > recordedAt) {
      throw serviceError("schedule_result_settlement_clock_invalid");
    }
    const receiptRequest = {
      tenantScope: request.tenantScope,
      runId: request.runId,
      executionTaskId: request.canonicalTaskId,
      expectedIntentVersion: intent.intentVersion,
      expectedExecutionVersion: execution.executionVersion,
      leaseId: execution.leaseId,
      ownerDigest: execution.ownerDigest,
      fencingToken: execution.fencingToken,
      taskLeaseId: execution.taskLeaseId,
      taskOwnerDigest: execution.taskOwnerDigest,
      taskFencingToken: execution.taskFencingToken,
      activationSnapshotId: intent.activationSnapshotId,
      activationSnapshotDigest: intent.activationSnapshotDigest,
      operationReceiptEvidenceDigest: internalOutcome.outcome.processingEvidenceDigest,
      receiptEffectState,
      outcome: internalOutcome.outcome.state,
      resultEvidenceDigest: internalOutcome.outcome.resultEvidenceDigest,
      recordedAt,
    };
    let recorded;
    try {
      recorded = controlRepository.recordRunResultReceipt(receiptRequest);
    } catch (error) {
      if (error?.code !== "schedule_control_run_result_receipt_fenced") throw error;
      recorded = controlRepository.adoptRunResultReceiptForReconciliation({
        tenantScope: request.tenantScope,
        runId: request.runId,
        expectedIntentVersion: intent.intentVersion,
        expectedExecutionVersion: execution.executionVersion,
      });
    }
    return settlementFromReceipt(recorded.receipt);
  }

  async function persistProcessingOutcome({ employeeId, ingest, processingBinding, request }) {
    let resolution;
    try {
      resolution = await resolveProcessingAuthority({
        tenantScope: request.tenantScope,
        processingAuthorityDigest: processingBinding.processingAuthorityDigest,
      });
    } catch {
      return resultRepository.recordProcessingUnknown({
        binding: processingBinding,
        safeFailureCode: "schedule_result_processing_integrity_invalid",
      });
    }
    if (!resolution || !processingResolutionMatches(resolution, processingBinding)) {
      return resultRepository.recordProcessingUnknown({
        binding: processingBinding,
        safeFailureCode: "schedule_result_processing_authority_unavailable",
      });
    }
    let parsed;
    try {
      parsed = parseScheduleResult(resolution.resultContract, ingest.envelope);
    } catch (error) {
      if (!DETERMINISTIC_PARSE_FAILURE_CODES.has(error?.code)) {
        return resultRepository.recordProcessingUnknown({
          binding: processingBinding,
          safeFailureCode: "schedule_result_processing_state_uncertain",
        });
      }
      return resultRepository.processEnvelopeAndHoldAlerts({
        binding: processingBinding,
        envelope: ingest.envelope,
        processingResolution: resolution,
        alertPlan: notRequiredAlertPlan(resolution.alertContract),
      });
    }
    const safeSummary = projectScheduleResultSafeSummary(resolution.resultContract, parsed);
    let alertPlan;
    try {
      alertPlan = normalizeAlertPlan(await resolveAlertPlan({
        tenantScope: request.tenantScope,
        employeeId,
        alertContract: resolution.alertContract,
        safeSummary,
      }));
    } catch {
      return resultRepository.recordProcessingUnknown({
        binding: processingBinding,
        safeFailureCode: "schedule_result_processing_state_uncertain",
      });
    }
    try {
      return resultRepository.processEnvelopeAndHoldAlerts({
        binding: processingBinding,
        envelope: ingest.envelope,
        processingResolution: resolution,
        alertPlan,
      });
    } catch (error) {
      if (!ALERT_PLAN_FAILURE_CODES.has(error?.code)) throw error;
      return resultRepository.recordProcessingUnknown({
        binding: processingBinding,
        safeFailureCode: "schedule_result_processing_state_uncertain",
      });
    }
  }

  async function revalidateProcessingGovernance({ internalOutcome, request }) {
    if (internalOutcome.outcome.state === "unknown") return false;
    let resolution;
    try {
      resolution = await resolveProcessingAuthority({
        tenantScope: request.tenantScope,
        processingAuthorityDigest: internalOutcome.binding.processingAuthorityDigest,
      });
    } catch {
      return false;
    }
    if (!resolution || !processingResolutionMatches(resolution, internalOutcome.binding)) return false;
    if (internalOutcome.outcome.state === "parse_failed") return true;
    const result = resultRepository.getResultSafeProjection({
      tenantScope: request.tenantScope,
      runId: request.runId,
    });
    if (!result?.safeSummary) return false;
    let currentPlan;
    try {
      currentPlan = await resolveAlertPlan({
        tenantScope: request.tenantScope,
        employeeId: internalOutcome.binding.employeeId,
        alertContract: resolution.alertContract,
        safeSummary: result.safeSummary,
      });
      currentPlan = normalizeAlertPlan(currentPlan);
    } catch {
      return false;
    }
    const held = resultRepository.listHeldAlerts({
      tenantScope: request.tenantScope,
      runId: request.runId,
      limit: 33,
    });
    if (currentPlan.mode === "not_required") return held.length === 0;
    return held.length === currentPlan.recipients.length && held.length > 0 &&
      held.every((item) => item.planDigest === currentPlan.planDigest);
  }

  return Object.freeze({
    contractVersion: "schedule-result-settlement-service.v1",
    prepareCanonicalSettlement,
  });
}

function requireCurrentRun(request, intent, execution) {
  const current = intent?.tenantScope === request.tenantScope && intent.runId === request.runId &&
    intent.intentState === "submitted" && intent.executionTaskId === request.canonicalTaskId &&
    execution?.tenantScope === request.tenantScope && execution.runId === request.runId &&
    execution.executionTaskId === request.canonicalTaskId && execution.executionPhase === "effect_dispatch_prepared" &&
    execution.resultReceiptRequirement === "required";
  if (!current) throw serviceError("schedule_result_settlement_run_not_current");
}

function requireSnapshot(intent, snapshot) {
  const current = snapshot?.contractVersion === "schedule-activation-snapshot.v2" &&
    snapshot.snapshotDigest === intent.activationSnapshotDigest &&
    `schedule_activation_snapshot_${snapshot.snapshotDigest}` === intent.activationSnapshotId &&
    snapshot.tenantScope === intent.tenantScope && snapshot.employeeId === intent.employeeId &&
    snapshot.scheduleId === intent.scheduleId && snapshot.activationVersion === intent.activationVersion;
  if (!current) throw serviceError("schedule_result_settlement_snapshot_mismatch");
}

function createIngestBinding(intent, snapshot) {
  return {
    contractVersion: "schedule-result-ingest-binding.v1",
    tenantScope: intent.tenantScope,
    employeeId: intent.employeeId,
    scheduleId: intent.scheduleId,
    runId: intent.runId,
    canonicalTaskId: intent.executionTaskId,
    triggerId: intent.expectedTriggerId,
    scheduledFor: intent.scheduledFor,
    activationVersion: intent.activationVersion,
    activationSnapshotId: intent.activationSnapshotId,
    activationSnapshotDigest: intent.activationSnapshotDigest,
    resultContractDigest: snapshot.resultContractDigest,
    alertContractDigest: snapshot.alertContractDigest,
  };
}

function createProcessingBinding({ execution, ingest, intent, providerAttempt, snapshot }) {
  return {
    contractVersion: "schedule-result-processing-outcome-binding.v1",
    tenantScope: intent.tenantScope,
    employeeId: intent.employeeId,
    scheduleId: intent.scheduleId,
    runId: intent.runId,
    canonicalTaskId: intent.executionTaskId,
    triggerId: intent.expectedTriggerId,
    scheduledFor: intent.scheduledFor,
    activationVersion: intent.activationVersion,
    activationSnapshotId: intent.activationSnapshotId,
    activationSnapshotDigest: intent.activationSnapshotDigest,
    processingAuthorityDigest: snapshot.processingAuthorityDigest,
    resultContractDigest: snapshot.resultContractDigest,
    alertContractDigest: snapshot.alertContractDigest,
    retentionDefinitionDigest: snapshot.retentionDefinitionDigest,
    ingestRef: ingest.evidence.ingestRef,
    ingestEvidenceDigest: ingest.evidence.evidenceDigest,
    providerAttemptEvidenceDigest: providerAttempt.providerAttemptEvidenceDigest,
    runLeaseBindingDigest: digestOrdered({
      contractVersion: "schedule-run-dual-lease-binding.v1",
      leaseId: execution.leaseId,
      ownerDigest: execution.ownerDigest,
      fencingToken: execution.fencingToken,
      taskLeaseId: execution.taskLeaseId,
      taskOwnerDigest: execution.taskOwnerDigest,
      taskFencingToken: execution.taskFencingToken,
    }),
  };
}

function normalizeProviderAttemptEvidence(value, request) {
  exactObject(value, PROVIDER_EVIDENCE_FIELDS, "schedule_result_provider_attempt_evidence_invalid");
  const normalized = {
    contractVersion: value.contractVersion,
    tenantScope: token(value.tenantScope, "providerAttempt.tenantScope"),
    runId: token(value.runId, "providerAttempt.runId"),
    canonicalTaskId: token(value.canonicalTaskId, "providerAttempt.canonicalTaskId"),
    providerAttemptEvidenceDigest: digest(value.providerAttemptEvidenceDigest),
    ingestRef: token(value.ingestRef, "providerAttempt.ingestRef"),
    ingestEvidenceDigest: digest(value.ingestEvidenceDigest),
    state: value.state,
  };
  if (normalized.contractVersion !== "schedule-provider-attempt-evidence.v1" ||
    normalized.state !== "response_recorded" || normalized.tenantScope !== request.tenantScope ||
    normalized.runId !== request.runId || normalized.canonicalTaskId !== request.canonicalTaskId) {
    throw serviceError("schedule_result_provider_attempt_evidence_invalid");
  }
  return Object.freeze(normalized);
}

function requireIngestEvidence(value, providerAttempt) {
  const valid = value?.contractVersion === "schedule-result-ingest-internal-envelope.v1" &&
    value.payloadBoundary === "internal_only" && value.envelope && value.evidence?.state === "envelope_sealed" &&
    value.evidence.contractVersion === "schedule-result-ingest-evidence.v1" &&
    value.evidence.ingestRef === providerAttempt.ingestRef &&
    value.evidence.evidenceDigest === providerAttempt.ingestEvidenceDigest;
  if (!valid) throw serviceError("schedule_result_ingest_invalid");
}

function requireInternalOutcome(value, expectedBinding) {
  const valid = value?.contractVersion === "schedule-result-processing-outcome-internal-evidence.v1" &&
    value.evidenceBoundary === "internal_only" && isDeepStrictEqual(value.binding, expectedBinding) &&
    value.outcome?.contractVersion === "schedule-result-processing-outcome-evidence.v1";
  if (!valid) throw serviceError("schedule_result_processing_outcome_mismatch");
}

function processingResolutionMatches(resolution, binding) {
  return resolution?.contractVersion === "schedule-result-processing-resolution.v1" &&
    resolution.authority?.processingAuthorityDigest === binding.processingAuthorityDigest &&
    resolution.resultContract?.contractDigest === binding.resultContractDigest &&
    resolution.alertContract?.alertContractDigest === binding.alertContractDigest &&
    resolution.retentionDefinition?.retentionDefinitionDigest === binding.retentionDefinitionDigest;
}

function notRequiredAlertPlan(alertContract) {
  const body = {
    contractVersion: "schedule-result-alert-plan.v1",
    alertContractDigest: digest(alertContract.alertContractDigest),
    policyVersion: token(alertContract.policyVersion, "alertContract.policyVersion"),
    mode: "not_required",
    recipients: [],
  };
  return Object.freeze({ ...body, planDigest: digestCanonical(body) });
}

function normalizeAlertPlan(value) {
  exactObject(value, ALERT_PLAN_FIELDS, "schedule_result_alert_plan_invalid");
  if (!Array.isArray(value.recipients)) {
    throw serviceError("schedule_result_alert_plan_invalid");
  }
  const body = {
    contractVersion: value.contractVersion,
    alertContractDigest: digest(value.alertContractDigest),
    policyVersion: token(value.policyVersion, "alertPlan.policyVersion"),
    mode: value.mode,
    recipients: value.recipients.map((item) => {
      exactObject(item, ALERT_RECIPIENT_FIELDS, "schedule_result_alert_plan_invalid");
      return {
        ruleId: token(item.ruleId, "alertPlan.ruleId"),
        recipientRole: token(item.recipientRole, "alertPlan.recipientRole"),
        recipientPrincipalDigest: digest(item.recipientPrincipalDigest),
        generation: positiveInteger(item.generation, "alertPlan.generation"),
      };
    }).sort((left, right) => canonicalJson(left).localeCompare(canonicalJson(right))),
  };
  const valid = body.contractVersion === "schedule-result-alert-plan.v1" &&
    new Set(["required", "not_required"]).has(body.mode) &&
    (body.mode === "required") === (body.recipients.length > 0) &&
    digest(value.planDigest) === digestCanonical(body);
  if (!valid) throw serviceError("schedule_result_alert_plan_invalid");
  return Object.freeze({ ...body, planDigest: value.planDigest });
}

function settlementFromReceipt(receipt) {
  const status = receipt.receiptEffectState === "reconcile_required"
    ? "blocked"
    : receipt.outcome === "parsed_result"
      ? "completed"
      : "failed";
  const terminal = projectScheduleRunTerminalEvidence({ receipt, canonicalTaskStatus: status });
  return Object.freeze({
    settlement: Object.freeze({
      status,
      lastErrorCode: status === "completed"
        ? null
        : status === "failed"
          ? "schedule_result_contract_rejected"
          : "schedule_result_reconciliation_required",
      resultSummary: status === "completed"
        ? "Structured Schedule result sealed; alerts remain held."
        : status === "failed"
          ? "Structured Schedule result rejected by the frozen result contract."
          : "Schedule result requires reconciliation before terminal release.",
      terminalEvidenceDigest: terminal.terminalEvidenceDigest,
    }),
  });
}

function requireMethods(value, name, methods) {
  if (!value || methods.some((method) => typeof value[method] !== "function")) {
    throw new TypeError(`${name} is invalid`);
  }
}

function exactObject(value, fields, code) {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
    !new Set([Object.prototype, null]).has(Object.getPrototypeOf(value))) throw serviceError(code);
  const keys = Object.keys(value);
  if (keys.length !== fields.size || keys.some((key) => !fields.has(key))) throw serviceError(code);
}

function token(value, field) {
  const result = String(value || "").trim();
  if (!TOKEN.test(result)) throw serviceError("schedule_result_settlement_reference_invalid", field);
  return result;
}

function digest(value) {
  const result = String(value || "").trim().toLowerCase();
  if (!DIGEST.test(result)) throw serviceError("schedule_result_settlement_digest_invalid");
  return result;
}

function positiveInteger(value, field) {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw serviceError("schedule_result_settlement_number_invalid", field);
  }
  return value;
}

function trustedTimestamp(value) {
  const input = value instanceof Date ? value.toISOString() : String(value || "").trim();
  const parsed = new Date(input);
  if (!input || !Number.isFinite(parsed.getTime()) || parsed.toISOString() !== input) {
    throw serviceError("schedule_result_settlement_clock_invalid");
  }
  return input;
}

function digestOrdered(value) {
  return crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function digestCanonical(value) {
  return crypto.createHash("sha256").update(canonicalJson(value)).digest("hex");
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function serviceError(code, detail = "") {
  const error = new Error(detail ? `${code}: ${detail}` : code);
  error.code = code;
  return error;
}
