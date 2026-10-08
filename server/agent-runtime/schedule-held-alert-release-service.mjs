import crypto from "node:crypto";

const CONTRACT_VERSION = "schedule-held-alert-release-service.v1";
const REQUEST_FIELDS = new Set(["alertId", "runId", "tenantScope"]);
const RECIPIENT_FIELDS = new Set([
  "authorityValidUntil", "contractVersion", "recipientAuthorityDigest", "recipientGeneration",
  "recipientPrincipalDigest", "recipientRole", "resolutionDigest",
]);
const TOKEN = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,239}$/;
const DIGEST = /^[a-f0-9]{64}$/;

function createScheduleHeldAlertReleaseService({
  controlRepository,
  executionTaskRepository,
  now = () => new Date(),
  releaseRepository,
  resolveCurrentBusinessOwnerRecipient,
  resultRepository,
} = {}) {
  requireMethods(controlRepository, "controlRepository", [
    "getIntent", "getRunExecution", "getRunResultReceipt", "resolveActiveActivationSnapshot",
  ]);
  requireMethods(executionTaskRepository, "executionTaskRepository", ["get"]);
  requireMethods(resultRepository, "resultRepository", [
    "getInternalProcessingOutcomeEvidence", "getResultSafeProjection", "listHeldAlerts",
  ]);
  requireMethods(releaseRepository, "releaseRepository", ["authorizeOrGet"]);
  if (typeof now !== "function") throw new TypeError("Schedule held alert release requires a clock");
  if (typeof resolveCurrentBusinessOwnerRecipient !== "function") {
    throw new TypeError("Schedule held alert release requires current recipient authority");
  }

  async function authorizeHeldAlert(value = {}) {
    const request = normalizeRequest(value);
    const processing = resultRepository.getInternalProcessingOutcomeEvidence({
      tenantScope: request.tenantScope,
      runId: request.runId,
    });
    const binding = requireParsedProcessing(request, processing);
    const held = requireHeldAlert(resultRepository, request, processing);
    const intent = controlRepository.getIntent(request.runId, { tenantScope: request.tenantScope });
    const execution = controlRepository.getRunExecution(request.runId, {
      tenantScope: request.tenantScope,
    });
    const receipt = controlRepository.getRunResultReceipt(request.runId, {
      tenantScope: request.tenantScope,
    });
    const task = executionTaskRepository.get(binding.canonicalTaskId, {
      tenantScope: request.tenantScope,
    });
    requireTerminalConvergence(binding, intent, execution, receipt, task, processing);
    await requireCurrentActivation(controlRepository, binding, intent);
    const recipient = await currentRecipient(resolveCurrentBusinessOwnerRecipient, binding, now);
    if (recipient.recipientPrincipalDigest !== held.recipientPrincipalDigest ||
      recipient.recipientGeneration !== held.generation || held.recipientRole !== "business_owner") {
      throw serviceError("schedule_alert_release_recipient_stale");
    }
    const result = resultRepository.getResultSafeProjection({
      tenantScope: request.tenantScope,
      runId: request.runId,
    });
    if (result?.contractVersion !== "schedule-result-safe-projection.v1" ||
      result.state !== "sealed_pending_task" || result.alerts !== "held") {
      throw serviceError("schedule_alert_release_result_not_releasable");
    }
    await requireCurrentActivation(controlRepository, binding, intent);
    const finalRecipient = await currentRecipient(resolveCurrentBusinessOwnerRecipient, binding, now);
    if (finalRecipient.resolutionDigest !== recipient.resolutionDigest ||
      finalRecipient.recipientPrincipalDigest !== held.recipientPrincipalDigest ||
      finalRecipient.recipientGeneration !== held.generation) {
      throw serviceError("schedule_alert_release_recipient_stale");
    }
    return releaseRepository.authorizeOrGet({
      activationSnapshotDigest: binding.activationSnapshotDigest,
      activationVersion: binding.activationVersion,
      alertId: held.alertId,
      canonicalTaskId: binding.canonicalTaskId,
      employeeId: binding.employeeId,
      planDigest: held.planDigest,
      processingEvidenceDigest: processing.outcome.processingEvidenceDigest,
      recipientAuthorityDigest: finalRecipient.recipientAuthorityDigest,
      recipientAuthorityValidUntil: finalRecipient.authorityValidUntil,
      recipientGeneration: held.generation,
      recipientPrincipalDigest: held.recipientPrincipalDigest,
      recipientResolutionDigest: finalRecipient.resolutionDigest,
      resultEvidenceDigest: processing.outcome.resultEvidenceDigest,
      resultId: held.resultId,
      resultReceiptDigest: execution.resultReceiptDigest,
      ruleId: held.ruleId,
      runId: request.runId,
      scheduleId: binding.scheduleId,
      tenantScope: request.tenantScope,
      terminalEvidenceDigest: execution.canonicalTerminalEvidenceDigest,
    });
  }

  return Object.freeze({ authorizeHeldAlert, contractVersion: CONTRACT_VERSION });
}

function requireParsedProcessing(request, value) {
  const valid = value?.contractVersion ===
    "schedule-result-processing-outcome-internal-evidence.v1" &&
    value.evidenceBoundary === "internal_only" &&
    value.binding?.contractVersion === "schedule-result-processing-outcome-binding.v1" &&
    value.outcome?.contractVersion === "schedule-result-processing-outcome-evidence.v1" &&
    value.outcome.state === "parsed_result" && value.outcome.safeFailureCode === null &&
    value.outcome.resultEvidenceDigest && value.outcome.processingEvidenceDigest &&
    value.binding?.tenantScope === request.tenantScope && value.binding.runId === request.runId;
  if (!valid) throw serviceError("schedule_alert_release_processing_not_releasable");
  return value.binding;
}

function requireHeldAlert(resultRepository, request, processing) {
  const held = resultRepository.listHeldAlerts({
    tenantScope: request.tenantScope,
    runId: request.runId,
    limit: 33,
  });
  if (!Array.isArray(held) || held.length > 32) {
    throw serviceError("schedule_alert_release_held_alert_invalid");
  }
  const alert = held.find((item) => item.alertId === request.alertId);
  const valid = alert?.contractVersion === "schedule-result-held-alert.v1" &&
    alert.runId === request.runId && alert.state === "held" &&
    alert.alertContractDigest === processing.binding.alertContractDigest &&
    alert.resultId === processing.outcome.resultId &&
    alert.recipientRole === "business_owner";
  if (!valid) throw serviceError("schedule_alert_release_held_alert_invalid");
  return alert;
}

function requireTerminalConvergence(binding, intent, execution, receipt, task, processing) {
  const valid = intent?.tenantScope === binding.tenantScope && intent.runId === binding.runId &&
    intent.employeeId === binding.employeeId && intent.scheduleId === binding.scheduleId &&
    intent.activationVersion === binding.activationVersion &&
    intent.activationSnapshotDigest === binding.activationSnapshotDigest &&
    intent.executionTaskId === binding.canonicalTaskId && intent.intentState === "terminal_observed" &&
    intent.observedTaskStatus === "completed" &&
    execution?.tenantScope === binding.tenantScope && execution.runId === binding.runId &&
    execution.employeeId === binding.employeeId && execution.scheduleId === binding.scheduleId &&
    execution.executionTaskId === binding.canonicalTaskId &&
    execution.activationVersion === binding.activationVersion &&
    execution.executionState === "released" &&
    execution.executionPhase === "effect_dispatch_prepared" && execution.effectState === "settled" &&
    execution.canonicalTaskStatus === "completed" && execution.resultReceiptDigest &&
    execution.canonicalTerminalEvidenceDigest &&
    receipt?.contractVersion === "schedule-run-result-receipt.v1" &&
    receipt.tenantScope === binding.tenantScope && receipt.runId === binding.runId &&
    receipt.employeeId === binding.employeeId && receipt.scheduleId === binding.scheduleId &&
    receipt.executionTaskId === binding.canonicalTaskId &&
    receipt.activationSnapshotId === binding.activationSnapshotId &&
    receipt.activationSnapshotDigest === binding.activationSnapshotDigest &&
    receipt.outcome === "parsed_result" && receipt.receiptEffectState === "settled" &&
    receipt.resultReceiptDigest === execution.resultReceiptDigest &&
    receipt.operationReceiptEvidenceDigest === processing.outcome.processingEvidenceDigest &&
    receipt.resultEvidenceDigest === processing.outcome.resultEvidenceDigest &&
    task?.tenantScope === binding.tenantScope && task.taskId === binding.canonicalTaskId &&
    task.status === "completed" && task.taskRevision === execution.canonicalTaskRevision &&
    task.terminalEvidenceDigest === execution.canonicalTerminalEvidenceDigest &&
    processing.outcome.resultEvidenceDigest;
  if (!valid) throw serviceError("schedule_alert_release_terminal_not_converged");
}

async function requireCurrentActivation(controlRepository, binding, intent) {
  let value;
  try {
    value = await controlRepository.resolveActiveActivationSnapshot({
      activationSnapshotDigest: binding.activationSnapshotDigest,
      activationSnapshotId: binding.activationSnapshotId,
      activationVersion: binding.activationVersion,
      employeeId: binding.employeeId,
      scheduleId: binding.scheduleId,
      tenantScope: binding.tenantScope,
    });
  } catch {
    throw serviceError("schedule_alert_release_governance_not_current");
  }
  const snapshot = value?.snapshot;
  if (!snapshot || snapshot.contractVersion !== "schedule-activation-snapshot.v2" ||
    snapshot.snapshotDigest !== binding.activationSnapshotDigest ||
    `schedule_activation_snapshot_${snapshot.snapshotDigest}` !== binding.activationSnapshotId ||
    snapshot.tenantScope !== binding.tenantScope ||
    snapshot.activationVersion !== binding.activationVersion ||
    snapshot.employeeId !== binding.employeeId || snapshot.scheduleId !== binding.scheduleId ||
    snapshot.processingAuthorityDigest !== binding.processingAuthorityDigest ||
    snapshot.resultContractDigest !== binding.resultContractDigest ||
    snapshot.alertContractDigest !== binding.alertContractDigest ||
    snapshot.retentionDefinitionDigest !== binding.retentionDefinitionDigest ||
    intent.activationSnapshotId !== binding.activationSnapshotId) {
    throw serviceError("schedule_alert_release_governance_not_current");
  }
}

async function currentRecipient(resolver, binding, now) {
  let value;
  try {
    value = await resolver({
      targetId: binding.employeeId,
      targetType: "digital_employee",
      tenantScope: binding.tenantScope,
    });
  } catch {
    throw serviceError("schedule_alert_release_recipient_unavailable");
  }
  exactObject(value, RECIPIENT_FIELDS, "schedule_alert_release_recipient_invalid");
  const body = {
    authorityValidUntil: timestamp(value.authorityValidUntil),
    contractVersion: value.contractVersion,
    recipientAuthorityDigest: digest(value.recipientAuthorityDigest),
    recipientGeneration: positiveInteger(value.recipientGeneration),
    recipientPrincipalDigest: digest(value.recipientPrincipalDigest),
    recipientRole: value.recipientRole,
  };
  if (body.contractVersion !== "enterprise-business-owner-recipient-resolution.v1" ||
    body.recipientRole !== "business_owner" ||
    digest(value.resolutionDigest) !== digestCanonical(body) ||
    Date.parse(body.authorityValidUntil) <= trustedNow(now).getTime()) {
    throw serviceError("schedule_alert_release_recipient_invalid");
  }
  return Object.freeze({ ...body, resolutionDigest: value.resolutionDigest });
}

function normalizeRequest(value) {
  exactObject(value, REQUEST_FIELDS, "schedule_alert_release_request_invalid");
  return Object.freeze({
    alertId: token(value.alertId),
    runId: token(value.runId),
    tenantScope: token(value.tenantScope),
  });
}

function requireMethods(value, name, methods) {
  for (const method of methods) {
    if (typeof value?.[method] !== "function") throw new TypeError(`${name}.${method} must be a function`);
  }
}

function exactObject(value, fields, code) {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype ||
    Object.keys(value).length !== fields.size ||
    Object.keys(value).some((field) => !fields.has(field))) throw serviceError(code);
}

function token(value) {
  const result = String(value || "").trim();
  if (!TOKEN.test(result) || /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(result)) {
    throw serviceError("schedule_alert_release_reference_invalid");
  }
  return result;
}

function digest(value) {
  const result = String(value || "").trim().toLowerCase();
  if (!DIGEST.test(result)) throw serviceError("schedule_alert_release_digest_invalid");
  return result;
}

function positiveInteger(value) {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw serviceError("schedule_alert_release_generation_invalid");
  }
  return value;
}

function timestamp(value) {
  const result = String(value || "").trim();
  const parsed = new Date(result);
  if (!result || !Number.isFinite(parsed.getTime()) || parsed.toISOString() !== result) {
    throw serviceError("schedule_alert_release_timestamp_invalid");
  }
  return result;
}

function trustedNow(now) {
  let value;
  try { value = now(); } catch { throw serviceError("schedule_alert_release_clock_invalid"); }
  const result = value instanceof Date ? new Date(value.getTime()) : new Date(value);
  if (!Number.isFinite(result.getTime())) throw serviceError("schedule_alert_release_clock_invalid");
  return result;
}

function digestCanonical(value) {
  return crypto.createHash("sha256").update(canonicalJson(value)).digest("hex");
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) =>
      `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  const result = JSON.stringify(Object.is(value, -0) ? 0 : value);
  if (result === undefined) throw serviceError("schedule_alert_release_value_invalid");
  return result;
}

function serviceError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

export {
  CONTRACT_VERSION as SCHEDULE_HELD_ALERT_RELEASE_SERVICE_CONTRACT_VERSION,
  createScheduleHeldAlertReleaseService,
};
