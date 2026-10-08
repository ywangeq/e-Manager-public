import crypto from "node:crypto";
import { normalizeScheduleResultContract } from "./schedule-result-contract.mjs";
import { normalizeScheduleResultAlertContract } from "./schedule-result-processing-contract.mjs";

const CONTRACT_VERSION = "schedule-alert-delivery-service.v1";
const RESULT_VERSION = "schedule-alert-delivery-service-result.v1";
const RECONCILE_VERSION = "schedule-alert-delivery-reconcile-result.v1";
const PRESENTATION_VERSION = "schedule-alert-safe-presentation.v1";
const CAPABILITY_VERSION = "schedule-enterprise-alert-delivery-capability.v1";
const REMOTE_RESULT_VERSION = "schedule-enterprise-alert-delivery-result.v1";
const REQUEST_FIELDS = new Set(["alertId", "runId", "tenantScope"]);
const OPTION_FIELDS = new Set(["signal"]);
const RECONCILE_FIELDS = new Set(["limit", "tenantScope"]);
const CAPABILITY_FIELDS = new Set([
  "authorityValidUntil", "channelAuthorityDigest", "channelClass", "contractVersion",
  "deliver", "deliveryMode", "deliveryTargetEvidenceDigest", "recipientGeneration",
  "recipientPrincipalDigest", "recipientResolutionDigest", "requestIdentityMode", "retryMode",
]);
const REMOTE_RESULT_FIELDS = new Set([
  "contractVersion", "deliveryRequestId", "remoteDeliveryEvidenceDigest", "state",
]);
const RECIPIENT_FIELDS = new Set([
  "authorityValidUntil", "contractVersion", "recipientAuthorityDigest", "recipientGeneration",
  "recipientPrincipalDigest", "recipientRole", "resolutionDigest",
]);
const SAFE_SUMMARY_FIELDS = new Set([
  "contractVersion", "outcomeCode", "resultContractId", "resultContractVersion", "resultType",
  "schemaVersion", "severityCode", "summaryCode",
]);
const TOKEN = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,239}$/;
const DIGEST = /^[a-f0-9]{64}$/;

function createScheduleAlertDeliveryService({
  controlRepository,
  deliveryRepository,
  now = () => new Date(),
  processingAuthorityRepository,
  releaseRepository,
  resolveCurrentBusinessOwnerRecipient,
  resolveCurrentDeliveryCapability,
  responseUnknownAfterMs = 5 * 60 * 1000,
  resultRepository,
} = {}) {
  requireMethods(controlRepository, "controlRepository", ["resolveActiveActivationSnapshot"]);
  requireMethods(deliveryRepository, "deliveryRepository", [
    "beginDeliveryAttempt", "commitSent", "get", "getByAlert", "listIncomplete",
    "markUnknown", "prepareOrGet",
  ]);
  requireMethods(processingAuthorityRepository, "processingAuthorityRepository", [
    "resolveProcessingAuthority",
  ]);
  requireMethods(releaseRepository, "releaseRepository", ["get"]);
  requireMethods(resultRepository, "resultRepository", ["getResultSafeProjection", "listHeldAlerts"]);
  if (typeof resolveCurrentBusinessOwnerRecipient !== "function" ||
    typeof resolveCurrentDeliveryCapability !== "function" || typeof now !== "function") {
    throw new TypeError("Schedule alert delivery dependencies are required");
  }
  if (!Number.isSafeInteger(responseUnknownAfterMs) || responseUnknownAfterMs < 1_000 ||
    responseUnknownAfterMs > 60 * 60 * 1000) {
    throw new TypeError("Schedule alert delivery response timeout is invalid");
  }
  const activeDeliveryIds = new Set();

  async function deliverHeldAlert(value = {}, options = {}) {
    const request = normalizeRequest(value);
    const signal = normalizeOptions(options);
    const existing = readExistingDelivery(deliveryRepository, request);
    if (existing && existing.deliveryState !== "prepared") return projectDelivery(existing);
    if (signal?.aborted) throw serviceError("schedule_alert_delivery_canceled");

    const first = await resolveContext(request);
    const prepared = deliveryRepository.prepareOrGet(first.binding).delivery;
    if (prepared.deliveryState !== "prepared") return projectDelivery(prepared);
    if (signal?.aborted) throw serviceError("schedule_alert_delivery_canceled");

    const current = await resolveContext(request);
    if (canonicalJson(current.binding) !== canonicalJson(first.binding) ||
      canonicalJson(current.presentation) !== canonicalJson(first.presentation)) {
      throw serviceError("schedule_alert_delivery_authority_stale");
    }
    if (signal?.aborted) throw serviceError("schedule_alert_delivery_canceled");

    const begun = deliveryRepository.beginDeliveryAttempt({
      deliveryId: prepared.deliveryId,
      expectedRecordVersion: prepared.recordVersion,
      tenantScope: request.tenantScope,
    });
    if (!begun.started) return projectDelivery(begun.delivery);
    const delivery = begun.delivery;
    activeDeliveryIds.add(delivery.deliveryId);
    try {
      if (signal?.aborted) {
        return markUnknown(delivery, "schedule_alert_delivery_response_unknown");
      }
      let remote;
      try {
        remote = await current.capability.deliver({
          contractVersion: "schedule-enterprise-alert-delivery-request.v1",
          deliveryRequestId: delivery.deliveryRequestId,
          presentation: current.presentation,
        }, { signal });
      } catch {
        return markUnknown(delivery, signal?.aborted
          ? "schedule_alert_delivery_timeout_unknown"
          : "schedule_alert_delivery_transport_unknown");
      }
      let remoteEvidence;
      try {
        remoteEvidence = normalizeRemoteResult(remote, delivery.deliveryRequestId);
      } catch {
        return markUnknown(delivery, "schedule_alert_delivery_response_unknown");
      }
      return commitSent(delivery, remoteEvidence.remoteDeliveryEvidenceDigest);
    } finally {
      activeDeliveryIds.delete(delivery.deliveryId);
    }
  }

  function reconcileOnce(value = {}) {
    exactObject(value, RECONCILE_FIELDS, "schedule_alert_delivery_reconcile_request_invalid");
    const tenantScope = token(value.tenantScope);
    const limit = boundedInteger(value.limit, 1, 200);
    const checkedAt = trustedNow(now);
    const rows = deliveryRepository.listIncomplete({ tenantScope, limit });
    const counts = { inspected: rows.length, inFlight: 0, prepared: 0, transitioned: 0, unknown: 0 };
    for (const row of rows) {
      if (row.deliveryState === "prepared") {
        counts.prepared += 1;
        continue;
      }
      if (row.deliveryState === "unknown") {
        counts.unknown += 1;
        continue;
      }
      if (row.deliveryState !== "dispatch_prepared" || activeDeliveryIds.has(row.deliveryId) ||
        checkedAt.getTime() - Date.parse(row.dispatchPreparedAt) < responseUnknownAfterMs) {
        counts.inFlight += 1;
        continue;
      }
      const result = markUnknown(row, "schedule_alert_delivery_response_unknown");
      counts.transitioned += result.state === "unknown" ? 1 : 0;
      counts.unknown += result.state === "unknown" ? 1 : 0;
    }
    return deepFreeze({ contractVersion: RECONCILE_VERSION, counts });
  }

  async function resolveContext(request) {
    const release = requireRelease(readRelease(releaseRepository, request), request);
    const result = requireResult(readResult(resultRepository, request));
    const held = requireHeldAlert(readHeldAlerts(resultRepository, request), release, request);
    const active = await resolveActive(controlRepository, release.binding);
    if (active.snapshot.alertContractDigest !== held.alertContractDigest) {
      throw serviceError("schedule_alert_delivery_governance_not_current");
    }
    const processing = resolveProcessing(
      processingAuthorityRepository, request.tenantScope, active.snapshot,
    );
    requireResultContract(processing, active.snapshot, result.safeSummary);
    const alertContract = requireAlertContract(processing, active.snapshot, held, result.safeSummary);
    const recipient = await currentRecipient(
      resolveCurrentBusinessOwnerRecipient, release, held, now,
    );
    const capability = await currentCapability(
      resolveCurrentDeliveryCapability, release.binding, recipient, alertContract, now,
    );
    const presentation = createPresentation(alertContract, result.safeSummary);
    return deepFreeze({
      binding: {
        activationSnapshotDigest: release.binding.activationSnapshotDigest,
        activationVersion: release.binding.activationVersion,
        alertId: request.alertId,
        deliveryAuthorityValidUntil: earliestTimestamp([
          release.binding.recipientAuthorityValidUntil,
          recipient.authorityValidUntil,
          capability.authorityValidUntil,
        ]),
        canonicalTaskId: release.binding.canonicalTaskId,
        channelAuthorityDigest: capability.channelAuthorityDigest,
        channelClass: capability.channelClass,
        deliveryTargetEvidenceDigest: capability.deliveryTargetEvidenceDigest,
        employeeId: release.binding.employeeId,
        planDigest: release.binding.planDigest,
        presentationEvidenceDigest: digestCanonical(presentation),
        recipientAuthorityDigest: recipient.recipientAuthorityDigest,
        recipientGeneration: recipient.recipientGeneration,
        recipientPrincipalDigest: recipient.recipientPrincipalDigest,
        recipientResolutionDigest: recipient.resolutionDigest,
        releaseId: release.releaseId,
        resultId: release.binding.resultId,
        runId: request.runId,
        scheduleId: release.binding.scheduleId,
        tenantScope: request.tenantScope,
      },
      capability,
      presentation,
    });
  }

  function markUnknown(delivery, safeFailureCode) {
    try {
      return projectDelivery(deliveryRepository.markUnknown({
        deliveryId: delivery.deliveryId,
        expectedRecordVersion: delivery.recordVersion,
        safeFailureCode,
        tenantScope: delivery.binding.tenantScope,
      }).delivery);
    } catch {
      const current = deliveryRepository.get({
        deliveryId: delivery.deliveryId,
        tenantScope: delivery.binding.tenantScope,
      });
      if (current?.deliveryState === "sent" || current?.deliveryState === "unknown") {
        return projectDelivery(current);
      }
      throw serviceError("schedule_alert_delivery_evidence_unavailable");
    }
  }

  function commitSent(delivery, remoteDeliveryEvidenceDigest) {
    try {
      return projectDelivery(deliveryRepository.commitSent({
        deliveryId: delivery.deliveryId,
        expectedRecordVersion: delivery.recordVersion,
        remoteDeliveryEvidenceDigest,
        tenantScope: delivery.binding.tenantScope,
      }).delivery);
    } catch {
      const current = deliveryRepository.get({
        deliveryId: delivery.deliveryId,
        tenantScope: delivery.binding.tenantScope,
      });
      if (current?.deliveryState === "sent" || current?.deliveryState === "unknown") {
        return projectDelivery(current);
      }
      throw serviceError("schedule_alert_delivery_evidence_unavailable");
    }
  }

  return Object.freeze({ contractVersion: CONTRACT_VERSION, deliverHeldAlert, reconcileOnce });
}

function readExistingDelivery(repository, request) {
  try {
    const value = repository.getByAlert({ alertId: request.alertId, tenantScope: request.tenantScope });
    if (value && (value.binding.runId !== request.runId || value.binding.alertId !== request.alertId)) {
      throw serviceError("schedule_alert_delivery_identity_conflict");
    }
    return value;
  } catch (error) {
    if (error?.code === "schedule_alert_delivery_identity_conflict") throw error;
    throw serviceError("schedule_alert_delivery_evidence_unavailable");
  }
}

function readRelease(repository, request) {
  try { return repository.get({ alertId: request.alertId, tenantScope: request.tenantScope }); }
  catch { throw serviceError("schedule_alert_delivery_release_unavailable"); }
}

function requireRelease(value, request) {
  const valid = value?.contractVersion === "schedule-alert-release-authorization.v1" &&
    value.state === "authorized" && value.binding?.tenantScope === request.tenantScope &&
    value.binding.alertId === request.alertId && value.binding.runId === request.runId &&
    value.releaseId && value.binding.recipientAuthorityValidUntil;
  if (!valid) throw serviceError("schedule_alert_delivery_release_not_current");
  return value;
}

function readResult(repository, request) {
  try { return repository.getResultSafeProjection(request); }
  catch { throw serviceError("schedule_alert_delivery_result_unavailable"); }
}

function requireResult(value) {
  if (value?.contractVersion !== "schedule-result-safe-projection.v1" ||
    value.state !== "sealed_pending_task" || value.alerts !== "held") {
    throw serviceError("schedule_alert_delivery_result_not_releasable");
  }
  exactObject(value.safeSummary, SAFE_SUMMARY_FIELDS, "schedule_alert_delivery_summary_invalid");
  const safeSummary = {
    contractVersion: value.safeSummary.contractVersion,
    outcomeCode: token(value.safeSummary.outcomeCode),
    resultContractId: token(value.safeSummary.resultContractId),
    resultContractVersion: positiveInteger(value.safeSummary.resultContractVersion),
    resultType: token(value.safeSummary.resultType),
    schemaVersion: token(value.safeSummary.schemaVersion),
    severityCode: token(value.safeSummary.severityCode),
    summaryCode: token(value.safeSummary.summaryCode),
  };
  if (safeSummary.contractVersion !== "schedule-result-safe-summary.v1") {
    throw serviceError("schedule_alert_delivery_summary_invalid");
  }
  return deepFreeze({ safeSummary: deepFreeze(safeSummary) });
}

function readHeldAlerts(repository, request) {
  try { return repository.listHeldAlerts({ tenantScope: request.tenantScope, runId: request.runId, limit: 33 }); }
  catch { throw serviceError("schedule_alert_delivery_held_alert_unavailable"); }
}

function requireHeldAlert(values, release, request) {
  if (!Array.isArray(values) || values.length > 32) {
    throw serviceError("schedule_alert_delivery_held_alert_invalid");
  }
  const held = values.find((item) => item.alertId === request.alertId);
  const binding = release.binding;
  const valid = held?.contractVersion === "schedule-result-held-alert.v1" && held.state === "held" &&
    held.runId === request.runId && held.resultId === binding.resultId && held.planDigest === binding.planDigest &&
    held.ruleId === binding.ruleId && held.recipientRole === "business_owner" &&
    held.recipientPrincipalDigest === binding.recipientPrincipalDigest &&
    held.generation === binding.recipientGeneration;
  if (!valid) throw serviceError("schedule_alert_delivery_held_alert_invalid");
  return held;
}

async function resolveActive(repository, binding) {
  const activationSnapshotId = `schedule_activation_snapshot_${binding.activationSnapshotDigest}`;
  let value;
  try {
    value = await repository.resolveActiveActivationSnapshot({
      activationSnapshotDigest: binding.activationSnapshotDigest,
      activationSnapshotId,
      activationVersion: binding.activationVersion,
      employeeId: binding.employeeId,
      scheduleId: binding.scheduleId,
      tenantScope: binding.tenantScope,
    });
  } catch { throw serviceError("schedule_alert_delivery_governance_not_current"); }
  const snapshot = value?.snapshot;
  if (snapshot?.contractVersion !== "schedule-activation-snapshot.v2" ||
    snapshot.snapshotDigest !== binding.activationSnapshotDigest ||
    snapshot.activationVersion !== binding.activationVersion || snapshot.employeeId !== binding.employeeId ||
    snapshot.scheduleId !== binding.scheduleId || snapshot.tenantScope !== binding.tenantScope) {
    throw serviceError("schedule_alert_delivery_governance_not_current");
  }
  return value;
}

function resolveProcessing(repository, tenantScope, snapshot) {
  let value;
  try {
    value = repository.resolveProcessingAuthority({
      processingAuthorityDigest: snapshot.processingAuthorityDigest,
      tenantScope,
    });
  } catch { throw serviceError("schedule_alert_delivery_processing_unavailable"); }
  const valid = value?.contractVersion === "schedule-result-processing-resolution.v1" &&
    value.authority?.processingAuthorityDigest === snapshot.processingAuthorityDigest &&
    value.authority.alertContractDigest === snapshot.alertContractDigest &&
    value.authority.resultContractDigest === snapshot.resultContractDigest &&
    value.authority.retentionDefinitionDigest === snapshot.retentionDefinitionDigest;
  if (!valid) throw serviceError("schedule_alert_delivery_processing_invalid");
  return value;
}

function requireAlertContract(processing, snapshot, held, safeSummary) {
  let alertContract;
  try { alertContract = normalizeScheduleResultAlertContract(processing.alertContract); }
  catch { throw serviceError("schedule_alert_delivery_contract_invalid"); }
  if (alertContract.contractVersion !== "schedule-result-alert-contract.v2" ||
    alertContract.alertContractDigest !== snapshot.alertContractDigest ||
    alertContract.alertContractDigest !== held.alertContractDigest || alertContract.mode !== "required" ||
    !alertContract.deliveryPolicy) {
    throw serviceError("schedule_alert_delivery_contract_invalid");
  }
  const rule = alertContract.rules.find((item) => item.ruleId === held.ruleId);
  if (!rule || !rule.outcomeCodes.includes(safeSummary.outcomeCode) ||
    rule.recipientRole !== "business_owner") {
    throw serviceError("schedule_alert_delivery_contract_invalid");
  }
  return alertContract;
}

function requireResultContract(processing, snapshot, safeSummary) {
  let resultContract;
  try { resultContract = normalizeScheduleResultContract(processing.resultContract); }
  catch { throw serviceError("schedule_alert_delivery_contract_invalid"); }
  const outcomeRule = resultContract.outcomeRules.find(
    (rule) => rule.outcomeCode === safeSummary.outcomeCode,
  );
  const valid = resultContract.contractDigest === snapshot.resultContractDigest &&
    resultContract.resultContractId === safeSummary.resultContractId &&
    resultContract.resultContractVersion === safeSummary.resultContractVersion &&
    resultContract.resultType === safeSummary.resultType &&
    resultContract.schemaVersion === safeSummary.schemaVersion &&
    outcomeRule?.severityCode === safeSummary.severityCode &&
    outcomeRule?.summaryCode === safeSummary.summaryCode;
  if (!valid) throw serviceError("schedule_alert_delivery_contract_invalid");
  return resultContract;
}

async function currentRecipient(resolver, release, held, now) {
  let value;
  try {
    value = await resolver({
      targetId: release.binding.employeeId,
      targetType: "digital_employee",
      tenantScope: release.binding.tenantScope,
    });
  } catch { throw serviceError("schedule_alert_delivery_recipient_unavailable"); }
  exactObject(value, RECIPIENT_FIELDS, "schedule_alert_delivery_recipient_invalid");
  const body = {
    authorityValidUntil: timestamp(value.authorityValidUntil),
    contractVersion: value.contractVersion,
    recipientAuthorityDigest: digest(value.recipientAuthorityDigest),
    recipientGeneration: positiveInteger(value.recipientGeneration),
    recipientPrincipalDigest: digest(value.recipientPrincipalDigest),
    recipientRole: value.recipientRole,
  };
  const valid = body.contractVersion === "enterprise-business-owner-recipient-resolution.v1" &&
    body.recipientRole === "business_owner" && digest(value.resolutionDigest) === digestCanonical(body) &&
    body.recipientAuthorityDigest === release.binding.recipientAuthorityDigest &&
    body.recipientPrincipalDigest === release.binding.recipientPrincipalDigest &&
    body.recipientPrincipalDigest === held.recipientPrincipalDigest &&
    body.recipientGeneration === release.binding.recipientGeneration &&
    body.recipientGeneration === held.generation &&
    value.resolutionDigest === release.binding.recipientResolutionDigest &&
    body.authorityValidUntil === release.binding.recipientAuthorityValidUntil &&
    Date.parse(body.authorityValidUntil) > trustedNow(now).getTime();
  if (!valid) throw serviceError("schedule_alert_delivery_recipient_stale");
  return deepFreeze({ ...body, resolutionDigest: value.resolutionDigest });
}

async function currentCapability(resolver, binding, recipient, alertContract, now) {
  let value;
  try {
    value = await resolver({
      alertContractDigest: alertContract.alertContractDigest,
      channelClass: alertContract.deliveryPolicy.channelClass,
      employeeId: binding.employeeId,
      recipientGeneration: recipient.recipientGeneration,
      recipientPrincipalDigest: recipient.recipientPrincipalDigest,
      recipientResolutionDigest: recipient.resolutionDigest,
      scheduleId: binding.scheduleId,
      tenantScope: binding.tenantScope,
    });
  } catch { throw serviceError("schedule_alert_delivery_capability_unavailable"); }
  exactObject(value, CAPABILITY_FIELDS, "schedule_alert_delivery_capability_invalid");
  const valid = value.contractVersion === CAPABILITY_VERSION &&
    value.channelClass === alertContract.deliveryPolicy.channelClass &&
    value.deliveryMode === alertContract.deliveryPolicy.deliveryMode &&
    value.requestIdentityMode === "platform_stable_request_id" && value.retryMode === "none" &&
    digest(value.channelAuthorityDigest) && digest(value.deliveryTargetEvidenceDigest) &&
    value.recipientPrincipalDigest === recipient.recipientPrincipalDigest &&
    value.recipientGeneration === recipient.recipientGeneration &&
    value.recipientResolutionDigest === recipient.resolutionDigest &&
    typeof value.deliver === "function" && Date.parse(timestamp(value.authorityValidUntil)) > trustedNow(now).getTime();
  if (!valid) throw serviceError("schedule_alert_delivery_capability_invalid");
  return Object.freeze({
    authorityValidUntil: value.authorityValidUntil,
    channelAuthorityDigest: value.channelAuthorityDigest,
    channelClass: value.channelClass,
    contractVersion: value.contractVersion,
    deliver: value.deliver,
    deliveryMode: value.deliveryMode,
    deliveryTargetEvidenceDigest: value.deliveryTargetEvidenceDigest,
    recipientGeneration: value.recipientGeneration,
    recipientPrincipalDigest: value.recipientPrincipalDigest,
    recipientResolutionDigest: value.recipientResolutionDigest,
    requestIdentityMode: value.requestIdentityMode,
    retryMode: value.retryMode,
  });
}

function createPresentation(alertContract, safeSummary) {
  const presentation = deepFreeze({
    alertContractDigest: alertContract.alertContractDigest,
    contractVersion: PRESENTATION_VERSION,
    outcomeCode: safeSummary.outcomeCode,
    severityCode: safeSummary.severityCode,
    summaryCode: safeSummary.summaryCode,
  });
  if (Buffer.byteLength(canonicalJson(presentation), "utf8") >
    alertContract.deliveryPolicy.maxRenderedBytes) {
    throw serviceError("schedule_alert_delivery_presentation_too_large");
  }
  return presentation;
}

function normalizeRemoteResult(value, deliveryRequestId) {
  exactObject(value, REMOTE_RESULT_FIELDS, "schedule_alert_delivery_remote_result_invalid");
  if (value.contractVersion !== REMOTE_RESULT_VERSION || value.state !== "sent" ||
    value.deliveryRequestId !== deliveryRequestId) {
    throw serviceError("schedule_alert_delivery_remote_result_invalid");
  }
  return deepFreeze({ ...value, remoteDeliveryEvidenceDigest: digest(value.remoteDeliveryEvidenceDigest) });
}

function projectDelivery(value) {
  const state = value.deliveryState === "dispatch_prepared" ? "in_flight" : value.deliveryState;
  return deepFreeze({
    contractVersion: RESULT_VERSION,
    deliveryAttempts: value.deliveryAttempts,
    reconcileRequired: state === "unknown",
    state,
  });
}

function normalizeRequest(value) {
  exactObject(value, REQUEST_FIELDS, "schedule_alert_delivery_request_invalid");
  return Object.freeze({
    alertId: token(value.alertId),
    runId: token(value.runId),
    tenantScope: token(value.tenantScope),
  });
}

function normalizeOptions(value) {
  if (value && typeof value === "object" && !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype && Object.keys(value).length === 0) return null;
  exactObject(value, OPTION_FIELDS, "schedule_alert_delivery_options_invalid");
  const signal = value.signal;
  if (signal !== null && (typeof signal !== "object" || typeof signal.aborted !== "boolean" ||
    typeof signal.addEventListener !== "function")) {
    throw serviceError("schedule_alert_delivery_signal_invalid");
  }
  return signal;
}

function requireMethods(value, name, methods) {
  for (const method of methods) {
    if (typeof value?.[method] !== "function") throw new TypeError(`${name}.${method} must be a function`);
  }
}

function exactObject(value, fields, code) {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype || Object.keys(value).length !== fields.size ||
    Object.keys(value).some((field) => !fields.has(field))) throw serviceError(code);
}

function token(value) {
  const result = String(value || "").trim();
  if (!TOKEN.test(result) || /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(result)) {
    throw serviceError("schedule_alert_delivery_reference_invalid");
  }
  return result;
}

function digest(value) {
  const result = String(value || "").trim().toLowerCase();
  if (!DIGEST.test(result)) throw serviceError("schedule_alert_delivery_digest_invalid");
  return result;
}

function positiveInteger(value) { return boundedInteger(value, 1, Number.MAX_SAFE_INTEGER); }
function boundedInteger(value, minimum, maximum) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw serviceError("schedule_alert_delivery_number_invalid");
  }
  return value;
}

function timestamp(value) {
  const result = String(value || "").trim();
  const parsed = new Date(result);
  if (!result || !Number.isFinite(parsed.getTime()) || parsed.toISOString() !== result) {
    throw serviceError("schedule_alert_delivery_timestamp_invalid");
  }
  return result;
}

function trustedNow(now) {
  let value;
  try { value = now(); } catch { throw serviceError("schedule_alert_delivery_clock_invalid"); }
  const result = value instanceof Date ? new Date(value.getTime()) : new Date(value);
  if (!Number.isFinite(result.getTime())) throw serviceError("schedule_alert_delivery_clock_invalid");
  return result;
}

function earliestTimestamp(values) {
  return values.map(timestamp).toSorted((left, right) => Date.parse(left) - Date.parse(right))[0];
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
  if (result === undefined) throw serviceError("schedule_alert_delivery_value_invalid");
  return result;
}

function deepFreeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value) && typeof value !== "function") {
    Object.freeze(value);
    Object.values(value).forEach(deepFreeze);
  }
  return value;
}

function serviceError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

export {
  CONTRACT_VERSION as SCHEDULE_ALERT_DELIVERY_SERVICE_CONTRACT_VERSION,
  createScheduleAlertDeliveryService,
};
