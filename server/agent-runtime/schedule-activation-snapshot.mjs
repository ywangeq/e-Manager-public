import crypto from "node:crypto";
import { calculateLatestDueTime } from "./schedule-due-time-calculator.mjs";
import { normalizeProviderTimeoutPolicy } from "./provider-timeout-policy.mjs";
import {
  GOVERNED_SCHEDULE_CONTRACT_VERSION,
  normalizeGovernedSchedule,
} from "./schedule-trigger-service.mjs";
import { normalizeScheduleBusinessOwnerAcceptanceProofV2 } from "./schedule-business-owner-acceptance.mjs";
import { normalizeScheduleResultProcessingBinding } from "./schedule-result-processing-contract.mjs";

const SCHEDULE_ACTIVATION_SNAPSHOT_CONTRACT_VERSION = "schedule-activation-snapshot.v1";
const SCHEDULE_ACTIVATION_SNAPSHOT_CONTRACT_VERSION_V2 = "schedule-activation-snapshot.v2";
const SCHEDULE_ACTIVATION_SNAPSHOT_CONTRACT_VERSION_V3 = "schedule-activation-snapshot.v3";
const TASK_MODEL_BINDING_CONTRACT_VERSION = "digital-employee-task-model-binding.v1";
const SNAPSHOT_BODY_FIELDS = new Set([
  "activationVersion",
  "actor",
  "alertContractDigest",
  "approval",
  "contractVersion",
  "createdAt",
  "cron",
  "employeeId",
  "employeeVersion",
  "executionContractDigest",
  "maxConcurrentRuns",
  "missedSlotPolicy",
  "overlapWindowMinutes",
  "owner",
  "providerTimeoutPolicy",
  "providerTrial",
  "registrationVersion",
  "resultContractDigest",
  "scheduleId",
  "schedulePolicyDigest",
  "scheduleScope",
  "scheduleVersion",
  "snapshotVersion",
  "taskDefinitionId",
  "taskModelBinding",
  "tenantScope",
  "timeoutSeconds",
  "timezone",
  "writebackContractDigest",
]);
const SNAPSHOT_FIELDS = new Set([...SNAPSHOT_BODY_FIELDS, "snapshotDigest"]);
const SNAPSHOT_BODY_FIELDS_V2 = new Set([
  ...SNAPSHOT_BODY_FIELDS, "processingAuthorityDigest", "retentionDefinitionDigest",
]);
const SNAPSHOT_FIELDS_V2 = new Set([...SNAPSHOT_BODY_FIELDS_V2, "snapshotDigest"]);
const SNAPSHOT_BODY_FIELDS_V3 = new Set([
  ...[...SNAPSHOT_BODY_FIELDS].filter((field) => !["approval", "providerTrial", "alertContractDigest", "writebackContractDigest"].includes(field)),
  "executionMode", "taskDefinitionVersion", "skillPolicyDigest", "toolPolicyDigest", "modelSelection",
]);
const SNAPSHOT_FIELDS_V3 = new Set([...SNAPSHOT_BODY_FIELDS_V3, "snapshotDigest"]);
const ACTOR_FIELDS = new Set(["authorizationDigest", "issuer", "permissionDigest", "subjectDigest"]);
const OWNER_FIELDS = new Set(["principalId", "principalType"]);
const MODEL_BINDING_FIELDS = new Set([
  "assignmentAppliedVersion",
  "assignmentId",
  "assignmentSetDigest",
  "bindingDigest",
  "bindingVersion",
  "contractVersion",
  "model",
  "modelId",
  "modelLevelId",
  "provider",
  "providerName",
  "providerRouteId",
  "requiredCapabilityProfileVersion",
  "status",
  "taskId",
]);
const APPROVAL_FIELDS = new Set([
  "alertContractDigest",
  "approvalId",
  "approvalPolicyDigest",
  "approvalRevision",
  "approvedAt",
  "approverPrincipalId",
  "decision",
  "employeeVersion",
  "executionContractDigest",
  "readinessDigest",
  "registrationVersion",
  "resultContractDigest",
  "schedulePolicyDigest",
  "scheduleVersion",
  "taskBindingDigest",
  "validUntil",
  "writebackContractDigest",
]);
const PROVIDER_TRIAL_FIELDS = new Set([
  "attemptSequence",
  "canonicalTaskId",
  "canonicalTaskRevision",
  "canonicalTaskStatus",
  "dryRunId",
  "dryRunVersion",
  "employeeVersion",
  "evidenceDigest",
  "executionContractDigest",
  "outcome",
  "passedAt",
  "registrationVersion",
  "schedulePolicyDigest",
  "scheduleVersion",
  "taskBindingDigest",
]);
const TOKEN_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,159}$/;
const EMAIL_PATTERN = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const SECRET_PATTERN = /^(?:bearer\s+|sk-[a-z0-9_-]{8,}|rk-[a-z0-9_-]{8,}|xox[baprs]-|gh[pousr]_|glpat-|ya29\.|eyJ[A-Za-z0-9_-]{8,})/i;

function createScheduleActivationSnapshot(value = {}) {
  exactObject(value, SNAPSHOT_BODY_FIELDS, "schedule_activation_snapshot_fields_invalid");
  const body = normalizeSnapshotBody(value);
  return deepFreeze({ ...body, snapshotDigest: digestCanonical(body) });
}

function normalizeScheduleActivationSnapshot(value = {}) {
  exactObject(value, SNAPSHOT_FIELDS, "schedule_activation_snapshot_fields_invalid");
  const { snapshotDigest, ...candidate } = value;
  const body = normalizeSnapshotBody(candidate);
  const expectedDigest = digestCanonical(body);
  if (requiredDigest(snapshotDigest, "snapshotDigest") !== expectedDigest) {
    throw snapshotError("schedule_activation_snapshot_digest_mismatch");
  }
  return deepFreeze({ ...body, snapshotDigest: expectedDigest });
}

function projectGovernedScheduleFromActivationSnapshot(value) {
  const snapshot = normalizeScheduleActivationSnapshot(value);
  return projectNormalizedSnapshot(snapshot);
}

function createScheduleActivationSnapshotV2(value = {}) {
  exactObject(value, SNAPSHOT_BODY_FIELDS_V2, "schedule_activation_snapshot_v2_fields_invalid");
  const body = normalizeSnapshotBodyV2(value);
  return deepFreeze({ ...body, snapshotDigest: digestCanonical(body) });
}

function normalizeScheduleActivationSnapshotV2(value = {}) {
  exactObject(value, SNAPSHOT_FIELDS_V2, "schedule_activation_snapshot_v2_fields_invalid");
  const { snapshotDigest, ...candidate } = value;
  const body = normalizeSnapshotBodyV2(candidate);
  const expectedDigest = digestCanonical(body);
  if (requiredDigest(snapshotDigest, "snapshotDigest") !== expectedDigest) {
    throw snapshotError("schedule_activation_snapshot_v2_digest_mismatch");
  }
  return deepFreeze({ ...body, snapshotDigest: expectedDigest });
}

function projectGovernedScheduleFromActivationSnapshotV2(value) {
  const snapshot = normalizeScheduleActivationSnapshotV2(value);
  return projectNormalizedSnapshot(snapshot);
}

function projectNormalizedSnapshot(snapshot) {
  return normalizeGovernedSchedule({
    contractVersion: GOVERNED_SCHEDULE_CONTRACT_VERSION,
    tenantScope: snapshot.tenantScope,
    scheduleId: snapshot.scheduleId,
    scheduleVersion: snapshot.scheduleVersion,
    taskDefinitionId: snapshot.taskDefinitionId,
    actorIssuer: snapshot.actor.issuer,
    actorSubjectDigest: snapshot.actor.subjectDigest,
    authorizationDigest: snapshot.actor.authorizationDigest,
    employeeId: snapshot.employeeId,
    employeeVersion: snapshot.employeeVersion,
    executionContractDigest: snapshot.executionContractDigest,
    permissionDigest: snapshot.actor.permissionDigest,
    schedulePolicyDigest: snapshot.schedulePolicyDigest,
    enabled: true,
    reviewStatus: "approved",
    providerTimeoutPolicy: snapshot.providerTimeoutPolicy,
  });
}

// Standard Agent activation records current authority and immutable dependencies.
// It does not synthesize provider trials or domain-specific acceptance proofs.
function createScheduleActivationSnapshotV3(value = {}) {
  exactObject(value, value.modelSelection === undefined ? new Set([...SNAPSHOT_BODY_FIELDS_V3].filter(field => field !== "modelSelection")) : SNAPSHOT_BODY_FIELDS_V3, "schedule_activation_snapshot_v3_fields_invalid");
  const body = normalizeSnapshotBodyV3(value);
  return deepFreeze({ ...body, snapshotDigest: digestCanonical(body) });
}

function normalizeScheduleActivationSnapshotV3(value = {}) {
  exactObject(value, value.modelSelection === undefined ? new Set([...SNAPSHOT_FIELDS_V3].filter(field => field !== "modelSelection")) : SNAPSHOT_FIELDS_V3, "schedule_activation_snapshot_v3_fields_invalid");
  const { snapshotDigest, ...candidate } = value;
  const body = normalizeSnapshotBodyV3(candidate);
  if (requiredDigest(snapshotDigest, "snapshotDigest") !== digestCanonical(body)) {
    throw snapshotError("schedule_activation_snapshot_v3_digest_mismatch");
  }
  return deepFreeze({ ...body, snapshotDigest });
}

function normalizeSnapshotBodyV3(value) {
  if (value.contractVersion !== SCHEDULE_ACTIVATION_SNAPSHOT_CONTRACT_VERSION_V3) {
    throw snapshotError("schedule_activation_snapshot_v3_contract_invalid");
  }
  return deepFreeze({
    ...normalizeSnapshotCore(value),
    executionMode: exactValue(value.executionMode, "shared_agent_runtime", "schedule_activation_snapshot_v3_mode_invalid"),
    taskDefinitionVersion: positiveInteger(value.taskDefinitionVersion, "taskDefinitionVersion"),
    skillPolicyDigest: requiredDigest(value.skillPolicyDigest, "skillPolicyDigest"),
    toolPolicyDigest: requiredDigest(value.toolPolicyDigest, "toolPolicyDigest"),
  });
}

// Runnable profiles only: historical v1 remains readable through its explicit API.
function normalizeRunnableScheduleActivationSnapshot(value = {}) {
  if (value.contractVersion === SCHEDULE_ACTIVATION_SNAPSHOT_CONTRACT_VERSION_V3) {
    return normalizeScheduleActivationSnapshotV3(value);
  }
  return normalizeScheduleActivationSnapshotV2(value);
}

function projectRunnableGovernedScheduleFromActivationSnapshot(value) {
  return projectNormalizedSnapshot(normalizeRunnableScheduleActivationSnapshot(value));
}

function normalizeSnapshotBody(value) {
  if (value.contractVersion !== SCHEDULE_ACTIVATION_SNAPSHOT_CONTRACT_VERSION) {
    throw snapshotError("schedule_activation_snapshot_contract_invalid");
  }
  const common = normalizeSnapshotCore(value);
  const body = {
    ...common,
    approval: normalizeApproval(value.approval, common.createdAt),
    providerTrial: normalizeProviderTrial(value.providerTrial, common.createdAt),
    alertContractDigest: requiredDigest(value.alertContractDigest, "alertContractDigest"),
    writebackContractDigest: requiredDigest(value.writebackContractDigest, "writebackContractDigest"),
  };
  requireInternalBindings(body);
  return deepFreeze(body);
}

function normalizeSnapshotCore(value) {
  const createdAt = canonicalTimestamp(value.createdAt, "createdAt");
  const timezone = canonicalTimezone(value.timezone);
  const cron = basicCron(value.cron, timezone);
  const body = {
    contractVersion: value.contractVersion,
    ...(value.contractVersion === SCHEDULE_ACTIVATION_SNAPSHOT_CONTRACT_VERSION_V3 && value.modelSelection !== undefined
      ? { modelSelection: normalizeAgentModelSelection(value.modelSelection) } : {}),
    snapshotVersion: positiveInteger(value.snapshotVersion, "snapshotVersion"),
    activationVersion: positiveInteger(value.activationVersion, "activationVersion"),
    registrationVersion: positiveInteger(value.registrationVersion, "registrationVersion"),
    tenantScope: token(value.tenantScope, "tenantScope"),
    employeeId: token(value.employeeId, "employeeId"),
    employeeVersion: token(value.employeeVersion, "employeeVersion"),
    scheduleId: token(value.scheduleId, "scheduleId"),
    scheduleVersion: token(value.scheduleVersion, "scheduleVersion"),
    taskDefinitionId: token(value.taskDefinitionId, "taskDefinitionId"),
    cron,
    timezone,
    missedSlotPolicy: exactValue(value.missedSlotPolicy, "latest_only", "schedule_activation_snapshot_missed_slot_policy_invalid"),
    timeoutSeconds: boundedInteger(value.timeoutSeconds, 1, 86_400, "timeoutSeconds"),
    maxConcurrentRuns: boundedInteger(value.maxConcurrentRuns, 1, 100, "maxConcurrentRuns"),
    overlapWindowMinutes: boundedInteger(value.overlapWindowMinutes, 0, 1_440, "overlapWindowMinutes"),
    scheduleScope: enumValue(value.scheduleScope, ["department", "system"], "schedule_activation_snapshot_scope_invalid"),
    owner: normalizeOwner(value.owner),
    actor: normalizeActor(value.actor),
    schedulePolicyDigest: requiredDigest(value.schedulePolicyDigest, "schedulePolicyDigest"),
    executionContractDigest: requiredDigest(value.executionContractDigest, "executionContractDigest"),
    providerTimeoutPolicy: normalizeTimeoutPolicy(value.providerTimeoutPolicy),
    taskModelBinding: normalizeTaskModelBinding(value.taskModelBinding),
    resultContractDigest: requiredDigest(value.resultContractDigest, "resultContractDigest"),
    createdAt,
  };
  requireCommonBindings(body);
  return body;
}

function normalizeSnapshotBodyV2(value) {
  if (value.contractVersion !== SCHEDULE_ACTIVATION_SNAPSHOT_CONTRACT_VERSION_V2) {
    throw snapshotError("schedule_activation_snapshot_v2_contract_invalid");
  }
  let approval;
  let processing;
  try {
    approval = normalizeScheduleBusinessOwnerAcceptanceProofV2(value.approval);
    processing = normalizeScheduleResultProcessingBinding({
      contractVersion: "schedule-result-processing-binding.v1",
      resultContractDigest: value.resultContractDigest,
      alertContractDigest: value.alertContractDigest,
      retentionDefinitionDigest: value.retentionDefinitionDigest,
      processingAuthorityDigest: value.processingAuthorityDigest,
    });
  } catch {
    throw snapshotError("schedule_activation_snapshot_v2_processing_binding_invalid");
  }
  const { processingAuthorityDigest: _processing, retentionDefinitionDigest: _retention, ...legacyValue } = value;
  const legacyApproval = {
    approvalId: approval.approvalId,
    approvalRevision: approval.approvalRevision,
    decision: approval.decision,
    approverPrincipalId: approval.approverPrincipalId,
    approvalPolicyDigest: approval.approvalPolicyDigest,
    readinessDigest: approval.readinessDigest,
    registrationVersion: approval.registrationVersion,
    scheduleVersion: approval.scheduleVersion,
    employeeVersion: approval.employeeVersion,
    schedulePolicyDigest: approval.schedulePolicyDigest,
    executionContractDigest: approval.executionContractDigest,
    taskBindingDigest: approval.taskBindingDigest,
    resultContractDigest: approval.resultContractDigest,
    alertContractDigest: approval.alertContractDigest,
    writebackContractDigest: approval.writebackContractDigest,
    approvedAt: approval.approvedAt,
    validUntil: approval.validUntil,
  };
  const legacy = normalizeSnapshotBody({
    ...legacyValue,
    contractVersion: SCHEDULE_ACTIVATION_SNAPSHOT_CONTRACT_VERSION,
    approval: legacyApproval,
  });
  if (approval.resultContractDigest !== processing.resultContractDigest ||
    approval.alertContractDigest !== processing.alertContractDigest ||
    approval.retentionDefinitionDigest !== processing.retentionDefinitionDigest ||
    approval.processingAuthorityDigest !== processing.processingAuthorityDigest) {
    throw snapshotError("schedule_activation_snapshot_v2_approval_binding_mismatch");
  }
  return deepFreeze({
    ...legacy,
    contractVersion: SCHEDULE_ACTIVATION_SNAPSHOT_CONTRACT_VERSION_V2,
    approval,
    retentionDefinitionDigest: processing.retentionDefinitionDigest,
    processingAuthorityDigest: processing.processingAuthorityDigest,
  });
}

function normalizeOwner(value) {
  exactObject(value, OWNER_FIELDS, "schedule_activation_snapshot_owner_invalid");
  return deepFreeze({
    principalType: enumValue(
      value.principalType,
      ["department", "digital_employee"],
      "schedule_activation_snapshot_owner_invalid",
    ),
    principalId: token(value.principalId, "owner.principalId"),
  });
}

function normalizeActor(value) {
  exactObject(value, ACTOR_FIELDS, "schedule_activation_snapshot_actor_invalid");
  return deepFreeze({
    issuer: token(value.issuer, "actor.issuer"),
    subjectDigest: requiredDigest(value.subjectDigest, "actor.subjectDigest"),
    authorizationDigest: requiredDigest(value.authorizationDigest, "actor.authorizationDigest"),
    permissionDigest: requiredDigest(value.permissionDigest, "actor.permissionDigest"),
  });
}

function normalizeTaskModelBinding(value) {
  exactObject(value, MODEL_BINDING_FIELDS, "schedule_activation_snapshot_model_binding_invalid");
  if (value.contractVersion !== TASK_MODEL_BINDING_CONTRACT_VERSION || value.status !== "applied") {
    throw snapshotError("schedule_activation_snapshot_model_binding_invalid");
  }
  return deepFreeze({
    contractVersion: TASK_MODEL_BINDING_CONTRACT_VERSION,
    taskId: token(value.taskId, "taskModelBinding.taskId"),
    assignmentId: token(value.assignmentId, "taskModelBinding.assignmentId"),
    assignmentAppliedVersion: nonNegativeInteger(value.assignmentAppliedVersion, "taskModelBinding.assignmentAppliedVersion"),
    assignmentSetDigest: requiredDigest(value.assignmentSetDigest, "taskModelBinding.assignmentSetDigest"),
    bindingVersion: token(value.bindingVersion, "taskModelBinding.bindingVersion"),
    status: "applied",
    modelId: token(value.modelId, "taskModelBinding.modelId"),
    provider: token(value.provider, "taskModelBinding.provider"),
    providerName: safeText(value.providerName, "taskModelBinding.providerName", 120),
    model: safeText(value.model, "taskModelBinding.model", 120),
    modelLevelId: token(value.modelLevelId, "taskModelBinding.modelLevelId"),
    providerRouteId: token(value.providerRouteId, "taskModelBinding.providerRouteId"),
    requiredCapabilityProfileVersion: token(
      value.requiredCapabilityProfileVersion,
      "taskModelBinding.requiredCapabilityProfileVersion",
    ),
    bindingDigest: requiredDigest(value.bindingDigest, "taskModelBinding.bindingDigest"),
  });
}

function normalizeApproval(value, createdAt) {
  exactObject(value, APPROVAL_FIELDS, "schedule_activation_snapshot_approval_invalid");
  const approvedAt = canonicalTimestamp(value.approvedAt, "approval.approvedAt");
  const validUntil = value.validUntil === null ? null : canonicalTimestamp(value.validUntil, "approval.validUntil");
  if (approvedAt > createdAt || (validUntil !== null && validUntil <= createdAt)) {
    throw snapshotError("schedule_activation_snapshot_approval_time_invalid");
  }
  return deepFreeze({
    approvalId: token(value.approvalId, "approval.approvalId"),
    approvalRevision: positiveInteger(value.approvalRevision, "approval.approvalRevision"),
    decision: exactValue(value.decision, "approved", "schedule_activation_snapshot_approval_invalid"),
    approverPrincipalId: token(value.approverPrincipalId, "approval.approverPrincipalId"),
    approvalPolicyDigest: requiredDigest(value.approvalPolicyDigest, "approval.approvalPolicyDigest"),
    readinessDigest: requiredDigest(value.readinessDigest, "approval.readinessDigest"),
    registrationVersion: positiveInteger(value.registrationVersion, "approval.registrationVersion"),
    scheduleVersion: token(value.scheduleVersion, "approval.scheduleVersion"),
    employeeVersion: token(value.employeeVersion, "approval.employeeVersion"),
    schedulePolicyDigest: requiredDigest(value.schedulePolicyDigest, "approval.schedulePolicyDigest"),
    executionContractDigest: requiredDigest(value.executionContractDigest, "approval.executionContractDigest"),
    taskBindingDigest: requiredDigest(value.taskBindingDigest, "approval.taskBindingDigest"),
    resultContractDigest: requiredDigest(value.resultContractDigest, "approval.resultContractDigest"),
    alertContractDigest: requiredDigest(value.alertContractDigest, "approval.alertContractDigest"),
    writebackContractDigest: requiredDigest(value.writebackContractDigest, "approval.writebackContractDigest"),
    approvedAt,
    validUntil,
  });
}

function normalizeProviderTrial(value, createdAt) {
  exactObject(value, PROVIDER_TRIAL_FIELDS, "schedule_activation_snapshot_provider_trial_invalid");
  const passedAt = canonicalTimestamp(value.passedAt, "providerTrial.passedAt");
  if (passedAt > createdAt) throw snapshotError("schedule_activation_snapshot_provider_trial_time_invalid");
  return deepFreeze({
    dryRunId: token(value.dryRunId, "providerTrial.dryRunId"),
    attemptSequence: positiveInteger(value.attemptSequence, "providerTrial.attemptSequence"),
    dryRunVersion: positiveInteger(value.dryRunVersion, "providerTrial.dryRunVersion"),
    registrationVersion: positiveInteger(value.registrationVersion, "providerTrial.registrationVersion"),
    scheduleVersion: token(value.scheduleVersion, "providerTrial.scheduleVersion"),
    employeeVersion: token(value.employeeVersion, "providerTrial.employeeVersion"),
    schedulePolicyDigest: requiredDigest(value.schedulePolicyDigest, "providerTrial.schedulePolicyDigest"),
    executionContractDigest: requiredDigest(value.executionContractDigest, "providerTrial.executionContractDigest"),
    taskBindingDigest: requiredDigest(value.taskBindingDigest, "providerTrial.taskBindingDigest"),
    outcome: exactValue(value.outcome, "passed", "schedule_activation_snapshot_provider_trial_invalid"),
    evidenceDigest: requiredDigest(value.evidenceDigest, "providerTrial.evidenceDigest"),
    canonicalTaskId: token(value.canonicalTaskId, "providerTrial.canonicalTaskId"),
    canonicalTaskRevision: positiveInteger(value.canonicalTaskRevision, "providerTrial.canonicalTaskRevision"),
    canonicalTaskStatus: exactValue(
      value.canonicalTaskStatus,
      "completed",
      "schedule_activation_snapshot_provider_trial_invalid",
    ),
    passedAt,
  });
}

function requireCommonBindings(body) {
  const policyDigest = crypto.createHash("sha256").update(JSON.stringify({
    ...(body.modelSelection ? { modelSelection: body.modelSelection } : {}),
    maxConcurrentRuns: body.maxConcurrentRuns,
    missedSlotPolicy: body.missedSlotPolicy,
    overlapWindowMinutes: body.overlapWindowMinutes,
    scheduleScope: body.scheduleScope,
    ownerPrincipalType: body.owner.principalType,
    ownerPrincipalId: body.owner.principalId,
    schedule: body.cron,
    timeoutSeconds: body.timeoutSeconds,
    timezone: body.timezone,
  })).digest("hex");
  if (body.schedulePolicyDigest !== policyDigest) {
    throw snapshotError("schedule_activation_snapshot_policy_digest_mismatch");
  }
  if (body.taskModelBinding.taskId !== body.taskDefinitionId) {
    throw snapshotError("schedule_activation_snapshot_task_binding_mismatch");
  }
}

function requireInternalBindings(body) {
  const trial = body.providerTrial;
  const trialMatches = trial.registrationVersion === body.registrationVersion &&
    trial.scheduleVersion === body.scheduleVersion && trial.employeeVersion === body.employeeVersion &&
    trial.schedulePolicyDigest === body.schedulePolicyDigest &&
    trial.executionContractDigest === body.executionContractDigest &&
    trial.taskBindingDigest === body.taskModelBinding.bindingDigest;
  if (!trialMatches) throw snapshotError("schedule_activation_snapshot_provider_trial_binding_mismatch");
  const approval = body.approval;
  const approvalMatches = approval.registrationVersion === body.registrationVersion &&
    approval.scheduleVersion === body.scheduleVersion && approval.employeeVersion === body.employeeVersion &&
    approval.schedulePolicyDigest === body.schedulePolicyDigest &&
    approval.executionContractDigest === body.executionContractDigest &&
    approval.taskBindingDigest === body.taskModelBinding.bindingDigest &&
    approval.resultContractDigest === body.resultContractDigest &&
    approval.alertContractDigest === body.alertContractDigest &&
    approval.writebackContractDigest === body.writebackContractDigest;
  if (!approvalMatches) throw snapshotError("schedule_activation_snapshot_approval_binding_mismatch");
}

function normalizeTimeoutPolicy(value) {
  try {
    return normalizeProviderTimeoutPolicy(value);
  } catch {
    throw snapshotError("schedule_activation_snapshot_timeout_policy_invalid");
  }
}

function basicCron(value, timezone) {
  const cron = safeText(value, "cron", 120);
  try {
    calculateLatestDueTime({
      cronExpression: cron,
      timezone,
      afterExclusive: "2026-01-01T00:00:00.000Z",
      throughInclusive: "2026-01-01T00:00:00.000Z",
    });
  } catch {
    throw snapshotError("schedule_activation_snapshot_cron_invalid");
  }
  return cron;
}

function canonicalTimezone(value) {
  const timezone = safeText(value, "timezone", 120);
  try {
    return new Intl.DateTimeFormat("en-US", { timeZone: timezone }).resolvedOptions().timeZone;
  } catch {
    throw snapshotError("schedule_activation_snapshot_timezone_invalid");
  }
}

function exactObject(value, fields, code) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw snapshotError(code);
  const keys = Object.keys(value);
  if (keys.length !== fields.size || keys.some((field) => !fields.has(field))) throw snapshotError(code);
}

function token(value, field) {
  const result = String(value || "").trim();
  if (!TOKEN_PATTERN.test(result) || EMAIL_PATTERN.test(result) || SECRET_PATTERN.test(result)) {
    throw snapshotError("schedule_activation_snapshot_reference_invalid", field);
  }
  return result;
}

function safeText(value, field, limit) {
  const result = String(value || "").replace(/[\u0000-\u001f\u007f]/g, " ").trim();
  if (!result || result.length > limit || SECRET_PATTERN.test(result)) {
    throw snapshotError("schedule_activation_snapshot_sensitive_value_forbidden", field);
  }
  return result;
}

function requiredDigest(value, field) {
  const result = String(value || "").trim().toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(result)) throw snapshotError("schedule_activation_snapshot_digest_invalid", field);
  return result;
}

function canonicalTimestamp(value, field) {
  const input = value instanceof Date ? value.toISOString() : String(value || "").trim();
  const date = new Date(input);
  if (!input || !Number.isFinite(date.getTime()) || date.toISOString() !== input) {
    throw snapshotError("schedule_activation_snapshot_timestamp_invalid", field);
  }
  return input;
}

function positiveInteger(value, field) {
  return boundedInteger(value, 1, Number.MAX_SAFE_INTEGER, field);
}

function nonNegativeInteger(value, field) {
  return boundedInteger(value, 0, Number.MAX_SAFE_INTEGER, field);
}

function boundedInteger(value, minimum, maximum, field) {
  const result = Number(value);
  if (!Number.isSafeInteger(result) || result < minimum || result > maximum) {
    throw snapshotError("schedule_activation_snapshot_number_invalid", field);
  }
  return result;
}

function enumValue(value, allowed, code) {
  if (!allowed.includes(value)) throw snapshotError(code);
  return value;
}

function exactValue(value, expected, code) {
  if (value !== expected) throw snapshotError(code);
  return expected;
}

function digestCanonical(value) {
  return crypto.createHash("sha256").update(JSON.stringify(sortCanonical(value))).digest("hex");
}

function sortCanonical(value) {
  if (Array.isArray(value)) return value.map(sortCanonical);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, sortCanonical(value[key])]));
}

function deepFreeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    Object.values(value).forEach(deepFreeze);
  }
  return value;
}

function snapshotError(code, detail = "") {
  const error = new Error(detail ? `${code}: ${detail}` : code);
  error.code = code;
  return error;
}

export {
  SCHEDULE_ACTIVATION_SNAPSHOT_CONTRACT_VERSION_V3,
  createScheduleActivationSnapshotV3,
  normalizeScheduleActivationSnapshotV3,
  normalizeRunnableScheduleActivationSnapshot,
  projectRunnableGovernedScheduleFromActivationSnapshot,
  SCHEDULE_ACTIVATION_SNAPSHOT_CONTRACT_VERSION,
  SCHEDULE_ACTIVATION_SNAPSHOT_CONTRACT_VERSION_V2,
  createScheduleActivationSnapshot,
  createScheduleActivationSnapshotV2,
  normalizeScheduleActivationSnapshot,
  normalizeScheduleActivationSnapshotV2,
  projectGovernedScheduleFromActivationSnapshot,
  projectGovernedScheduleFromActivationSnapshotV2,
};

export function normalizeAgentModelSelection(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw snapshotError("governed_schedule_model_selection_invalid");
  if (value.mode === "employee_primary" && Object.keys(value).length === 1) return { mode: "employee_primary" };
  if (value.mode === "assignment" && Object.keys(value).sort().join(",") === "assignmentId,mode") {
    return { mode: "assignment", assignmentId: token(value.assignmentId, "assignmentId") };
  }
  throw snapshotError("governed_schedule_model_selection_invalid");
}
