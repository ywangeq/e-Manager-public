import crypto from "node:crypto";
import {
  normalizeExecutionTaskSubmission,
} from "./runtime-task-contract-v1.mjs";
import { normalizeProviderTimeoutPolicy } from "./provider-timeout-policy.mjs";

const GOVERNED_SCHEDULE_CONTRACT_VERSION = "governed-schedule.v2";
const SCHEDULE_SLOT_VERIFICATION_CONTRACT_VERSION = "schedule-slot-verification.v1";
const SCHEDULE_TRIGGER_CONTRACT_VERSION = "schedule-trigger.v3";
const SCHEDULE_TRIGGER_SERVICE_CONTRACT_VERSION = "schedule-trigger-service.v3";
const SCHEDULE_FIELDS = new Set([
  "runConfigurationDigest",
  "actorIssuer",
  "actorSubjectDigest",
  "authorizationDigest",
  "contractVersion",
  "employeeId",
  "employeeVersion",
  "enabled",
  "executionContractDigest",
  "permissionDigest",
  "providerTimeoutPolicy",
  "reviewStatus",
  "scheduleId",
  "schedulePolicyDigest",
  "scheduleVersion",
  "taskDefinitionId",
  "tenantScope",
]);
const FORBIDDEN_FIELD_PATTERN = /(?:authorization|bearer|body|comment|contract|credential|message|password|path|prompt|raw|secret|text|tool|token)/i;
const EMAIL_VALUE_PATTERN = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const SECRET_VALUE_PATTERN = /^(?:bearer[\s._:-]*|sk-|rk-|xox[baprs]-|gh[pousr]_|glpat-|ya29\.|eyJ)[A-Za-z0-9._~+\/-]{8,}$/i;

function createScheduleTriggerService({
  executionTaskRepository,
  scheduleTriggerRepository,
  verifyScheduledFor,
  workerPump = null,
} = {}) {
  assertDependencies({ executionTaskRepository, scheduleTriggerRepository, verifyScheduledFor });

  function submit({ schedule, scheduledFor, manualRequestDigest } = {}) {
    const asset = normalizeGovernedSchedule(schedule);
    const slot = requiredTimestamp(scheduledFor, "scheduledFor");
    let slotVerification;
    try {
      slotVerification = normalizeScheduleSlotVerification(
        verifyScheduledFor({ schedule: asset, scheduledFor: slot, ...(manualRequestDigest !== undefined ? { manualRequestDigest } : {}) }),
      );
    } catch {
      throw scheduleTriggerError("schedule_trigger_slot_verification_failed");
    }
    if (slotVerification.schedulePolicyDigest !== asset.schedulePolicyDigest) {
      throw scheduleTriggerError("schedule_trigger_schedule_policy_changed");
    }
    if (slotVerification.due !== true) {
      throw scheduleTriggerError("schedule_trigger_slot_not_due");
    }
    const projection = projectScheduleTrigger({ schedule: asset, scheduledFor: slot, manualRequestDigest });
    const triggerResult = scheduleTriggerRepository.saveOrGet(projection.trigger);
    const taskResult = executionTaskRepository.submitOrGet(projection.submission);
    if (taskResult.task.taskId !== projection.trigger.executionTaskId) {
      throw scheduleTriggerError("schedule_trigger_task_binding_mismatch");
    }
    if (taskResult.created) workerPump?.wake?.();
    return Object.freeze({
      created: taskResult.created,
      task: taskResult.task,
      trigger: triggerResult.trigger,
      triggerCreated: triggerResult.created,
    });
  }

  return Object.freeze({
    contractVersion: SCHEDULE_TRIGGER_SERVICE_CONTRACT_VERSION,
    submit,
  });
}

function projectScheduleTrigger({ schedule, scheduledFor, manualRequestDigest } = {}) {
  const asset = normalizeGovernedSchedule(schedule);
  const slot = requiredTimestamp(scheduledFor, "scheduledFor");
  const slotDigest = scheduleTriggerSlotDigest({
    tenantScope: asset.tenantScope,
    employeeId: asset.employeeId,
    scheduleId: asset.scheduleId,
    scheduledFor: slot, manualRequestDigest,
  });
  const triggerId = `schedule_trigger_${slotDigest}`;
  const executionTaskId = `task_${slotDigest}`;
  const trigger = deepFreeze({
    contractVersion: SCHEDULE_TRIGGER_CONTRACT_VERSION,
    triggerId,
    tenantScope: asset.tenantScope,
    scheduleId: asset.scheduleId,
    scheduleVersion: asset.scheduleVersion,
    scheduledFor: slot,
    actorIssuer: asset.actorIssuer,
    actorSubjectDigest: asset.actorSubjectDigest,
    authorizationDigest: asset.authorizationDigest,
    employeeId: asset.employeeId,
    employeeVersion: asset.employeeVersion,
    taskDefinitionId: asset.taskDefinitionId,
    executionContractDigest: asset.executionContractDigest,
    permissionDigest: asset.permissionDigest,
    schedulePolicyDigest: asset.schedulePolicyDigest,
    executionTaskId,
    ...(manualRequestDigest !== undefined ? { manualRequestDigest: requiredDigest(manualRequestDigest, "manualRequestDigest") } : {}),
    ...(asset.runConfigurationDigest ? { runConfigurationDigest: asset.runConfigurationDigest } : {}),
  });
  const triggerDigest = scheduleTriggerDigest(trigger);
  const submission = normalizeExecutionTaskSubmission({
    taskId: executionTaskId,
    tenantScope: asset.tenantScope,
    actorIssuer: asset.actorIssuer,
    actorSubjectDigest: asset.actorSubjectDigest,
    employeeId: asset.employeeId,
    employeeVersion: asset.employeeVersion,
    sourceSystemId: "digital-workforce-scheduler",
    channelId: "schedule",
    taskType: "scheduled_employee_task",
    submissionScope: `schedule:${digestCanonical([asset.tenantScope, asset.employeeId, asset.scheduleId])}`,
    idempotencyKey: `scheduled-for:${slotDigest}`,
    inputDigest: triggerDigest,
    executionInputRef: { kind: "artifact_ref", refId: triggerId },
    providerTimeoutPolicy: asset.providerTimeoutPolicy,
    createdAt: slot,
    availableAt: slot,
  }, { now: new Date(slot) });
  return deepFreeze({ submission, trigger });
}

function normalizeGovernedSchedule(value) {
  requirePlainObject(value, "governed schedule");
  const unknown = Object.keys(value).find((field) => !SCHEDULE_FIELDS.has(field));
  if (unknown) {
    const code = FORBIDDEN_FIELD_PATTERN.test(unknown)
      ? "schedule_trigger_sensitive_field_forbidden"
      : "schedule_trigger_unknown_field";
    throw scheduleTriggerError(code);
  }
  if (value.contractVersion !== GOVERNED_SCHEDULE_CONTRACT_VERSION) {
    throw scheduleTriggerError("schedule_trigger_schedule_contract_invalid");
  }
  if (value.enabled !== true || value.reviewStatus !== "approved") {
    throw scheduleTriggerError("schedule_trigger_schedule_not_approved");
  }
  return deepFreeze({
    contractVersion: GOVERNED_SCHEDULE_CONTRACT_VERSION,
    tenantScope: requiredToken(value.tenantScope, "tenantScope", 160),
    scheduleId: requiredToken(value.scheduleId, "scheduleId", 160),
    scheduleVersion: requiredToken(value.scheduleVersion, "scheduleVersion", 80),
    taskDefinitionId: requiredToken(value.taskDefinitionId, "taskDefinitionId", 160),
    actorIssuer: requiredToken(value.actorIssuer, "actorIssuer", 160),
    actorSubjectDigest: requiredDigest(value.actorSubjectDigest, "actorSubjectDigest"),
    authorizationDigest: requiredDigest(value.authorizationDigest, "authorizationDigest"),
    employeeId: requiredToken(value.employeeId, "employeeId", 160),
    employeeVersion: requiredToken(value.employeeVersion, "employeeVersion", 80),
    executionContractDigest: requiredDigest(value.executionContractDigest, "executionContractDigest"),
    permissionDigest: requiredDigest(value.permissionDigest, "permissionDigest"),
    schedulePolicyDigest: requiredDigest(value.schedulePolicyDigest, "schedulePolicyDigest"),
    enabled: true,
    reviewStatus: "approved",
    providerTimeoutPolicy: normalizeProviderTimeoutPolicy(value.providerTimeoutPolicy),
    ...(value.runConfigurationDigest !== undefined ? { runConfigurationDigest: requiredDigest(value.runConfigurationDigest, "runConfigurationDigest") } : {}),
  });
}

function normalizeScheduleTrigger(value) {
  requirePlainObject(value, "schedule trigger");
  const fields = [
    "manualRequestDigest",
    "runConfigurationDigest",
    "actorIssuer",
    "actorSubjectDigest",
    "authorizationDigest",
    "contractVersion",
    "employeeId",
    "employeeVersion",
    "executionContractDigest",
    "executionTaskId",
    "permissionDigest",
    "scheduleId",
    "schedulePolicyDigest",
    "scheduleVersion",
    "scheduledFor",
    "taskDefinitionId",
    "tenantScope",
    "triggerId",
  ];
  const unknown = Object.keys(value).find((field) => !fields.includes(field));
  if (unknown) throw scheduleTriggerError("schedule_trigger_unknown_field");
  if (value.contractVersion !== SCHEDULE_TRIGGER_CONTRACT_VERSION) {
    throw scheduleTriggerError("schedule_trigger_contract_invalid");
  }
  return deepFreeze({
    contractVersion: SCHEDULE_TRIGGER_CONTRACT_VERSION,
    triggerId: requiredToken(value.triggerId, "triggerId", 160),
    tenantScope: requiredToken(value.tenantScope, "tenantScope", 160),
    scheduleId: requiredToken(value.scheduleId, "scheduleId", 160),
    scheduleVersion: requiredToken(value.scheduleVersion, "scheduleVersion", 80),
    scheduledFor: requiredTimestamp(value.scheduledFor, "scheduledFor"),
    actorIssuer: requiredToken(value.actorIssuer, "actorIssuer", 160),
    actorSubjectDigest: requiredDigest(value.actorSubjectDigest, "actorSubjectDigest"),
    authorizationDigest: requiredDigest(value.authorizationDigest, "authorizationDigest"),
    employeeId: requiredToken(value.employeeId, "employeeId", 160),
    employeeVersion: requiredToken(value.employeeVersion, "employeeVersion", 80),
    taskDefinitionId: requiredToken(value.taskDefinitionId, "taskDefinitionId", 160),
    executionContractDigest: requiredDigest(value.executionContractDigest, "executionContractDigest"),
    permissionDigest: requiredDigest(value.permissionDigest, "permissionDigest"),
    schedulePolicyDigest: requiredDigest(value.schedulePolicyDigest, "schedulePolicyDigest"),
    executionTaskId: requiredToken(value.executionTaskId, "executionTaskId", 128),
    ...(value.manualRequestDigest !== undefined ? { manualRequestDigest: requiredDigest(value.manualRequestDigest, "manualRequestDigest") } : {}),
    ...(value.runConfigurationDigest !== undefined ? { runConfigurationDigest: requiredDigest(value.runConfigurationDigest, "runConfigurationDigest") } : {}),
  });
}

function normalizeScheduleSlotVerification(value) {
  requirePlainObject(value, "schedule slot verification");
  const fields = ["contractVersion", "due", "schedulePolicyDigest"];
  const keys = Object.keys(value);
  if (keys.length !== fields.length || keys.some((field) => !fields.includes(field)) ||
    value.contractVersion !== SCHEDULE_SLOT_VERIFICATION_CONTRACT_VERSION ||
    typeof value.due !== "boolean") {
    throw scheduleTriggerError("schedule_trigger_slot_verification_invalid");
  }
  return Object.freeze({
    contractVersion: SCHEDULE_SLOT_VERIFICATION_CONTRACT_VERSION,
    due: value.due,
    schedulePolicyDigest: requiredDigest(value.schedulePolicyDigest, "schedulePolicyDigest"),
  });
}

function assertDependencies({ executionTaskRepository, scheduleTriggerRepository, verifyScheduledFor }) {
  if (typeof executionTaskRepository?.submitOrGet !== "function") {
    throw new TypeError("schedule trigger service requires executionTaskRepository.submitOrGet");
  }
  if (typeof scheduleTriggerRepository?.saveOrGet !== "function") {
    throw new TypeError("schedule trigger service requires scheduleTriggerRepository.saveOrGet");
  }
  if (typeof verifyScheduledFor !== "function") {
    throw new TypeError("schedule trigger service requires verifyScheduledFor");
  }
}

function requirePlainObject(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw scheduleTriggerError("schedule_trigger_invalid", `${label} must be an object`);
  }
}

function requiredToken(value, field, maxLength) {
  const text = String(value || "").trim();
  if (!text || text.length > maxLength || !/^[A-Za-z0-9][A-Za-z0-9._:@-]*$/.test(text)) {
    throw scheduleTriggerError("schedule_trigger_reference_invalid", `${field} must be a bounded opaque identifier`);
  }
  if (EMAIL_VALUE_PATTERN.test(text) || SECRET_VALUE_PATTERN.test(text)) {
    throw scheduleTriggerError("schedule_trigger_sensitive_value_forbidden", `${field} must not contain PII or a credential`);
  }
  return text;
}

function requiredDigest(value, field) {
  const text = String(value || "").trim().toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(text)) {
    throw scheduleTriggerError("schedule_trigger_digest_invalid", `${field} must be a SHA-256 digest`);
  }
  return text;
}

function requiredTimestamp(value, field) {
  const timestamp = new Date(value);
  if (!value || !Number.isFinite(timestamp.getTime())) {
    throw scheduleTriggerError("schedule_trigger_timestamp_invalid", `${field} must be an ISO timestamp`);
  }
  return timestamp.toISOString();
}

function digestCanonical(parts) {
  return crypto.createHash("sha256").update(JSON.stringify(parts)).digest("hex");
}

function scheduleTriggerDigest(value) {
  const trigger = normalizeScheduleTrigger(value);
  return digestCanonical(Object.values(trigger));
}

function scheduleTriggerSlotDigest({ tenantScope, employeeId, scheduleId, scheduledFor, manualRequestDigest } = {}) {
  return digestCanonical([
    SCHEDULE_TRIGGER_CONTRACT_VERSION,
    requiredToken(tenantScope, "tenantScope", 160),
    requiredToken(employeeId, "employeeId", 160),
    requiredToken(scheduleId, "scheduleId", 160),
    ...(manualRequestDigest !== undefined ? ["manual", requiredDigest(manualRequestDigest, "manualRequestDigest")] : [requiredTimestamp(scheduledFor, "scheduledFor")]),
  ]);
}

function scheduleTriggerError(code, message = code) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function deepFreeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const item of Object.values(value)) deepFreeze(item);
  }
  return value;
}

export {
  GOVERNED_SCHEDULE_CONTRACT_VERSION,
  SCHEDULE_SLOT_VERIFICATION_CONTRACT_VERSION,
  SCHEDULE_TRIGGER_CONTRACT_VERSION,
  SCHEDULE_TRIGGER_SERVICE_CONTRACT_VERSION,
  createScheduleTriggerService,
  normalizeGovernedSchedule,
  normalizeScheduleTrigger,
  projectScheduleTrigger,
  scheduleTriggerDigest,
  scheduleTriggerSlotDigest,
};
