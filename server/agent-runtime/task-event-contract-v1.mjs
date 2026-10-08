import {
  executionTaskError,
  normalizedExecutionTaskNow,
  requiredExecutionTaskToken,
} from "./runtime-task-contract-v1.mjs";

export const TASK_EVENT_CONTRACT_VERSION = "task-event.v1";

export const TASK_EVENT_TYPES = Object.freeze([
  "task.artifact_available",
  "task.progress",
  "task.result_available",
  "task.state_changed",
]);

const EVENT_TYPES = new Set(TASK_EVENT_TYPES);
const TASK_STATUSES = new Set([
  "blocked",
  "canceled",
  "completed",
  "failed",
  "lost",
  "queued",
  "rejected",
  "running",
  "timed_out",
  "waiting",
]);
const PROGRESS_STAGES = new Set(["admission", "provider", "queue", "result", "skill", "tool"]);
const PROGRESS_STATUSES = new Set(["blocked", "completed", "running", "waiting"]);
const PRESENTATION_CODES = new Set([
  "c002_backfill",
  "admission_completed",
  "legacy_terminal_imported",
  "provider_completed",
  "provider_started",
  "queue_wait_reason_changed",
  "queue_waiting",
  "result_recorded",
  "skill_blocked",
  "skill_completed",
  "skill_started",
  "task_canceled",
  "task_ready",
  "task_submitted",
  "tool_blocked",
  "tool_completed",
  "tool_target_rejected",
  "tool_started",
  "worker_claimed",
  "worker_lease_expired_requeued",
  "worker_recovery_budget_exhausted",
  "worker_settled",
  "worker_waiting",
]);
const SAFE_WAIT_REASON_CODES = new Set([
  "actor_capacity",
  "awaiting_worker",
  "employee_capacity",
  "employee_fifo",
  "global_capacity",
  "pending_file_intake",
  "pending_invocation_check",
  "pending_remote_resource",
  "prerequisite_pending",
]);
const SAFE_ERROR_CODES = new Set([
  "agent_turn_blocked",
  "agent_tool_not_allowed",
  "agent_turn_canceled",
  "credential_reentry_required",
  "current_actor_revalidation_failed",
  "employee_not_available",
  "employee_version_changed",
  "execution_admission_invalid",
  "execution_admission_missing",
  "execution_input_reference_invalid",
  "execution_task_blocked",
  "execution_task_handler_unavailable",
  "execution_task_session_superseded",
  "external_effect_unknown",
  "feishu_invocation_not_allowed",
  "feishu_registration_unavailable",
  "material_execution_deferred_c004",
  "material_recovery_unavailable",
  "operator_requested",
  "provider_connect_timeout",
  "provider_first_semantic_output_timeout",
  "provider_request_total_timeout",
  "provider_stream_idle_timeout",
  "runtime_resource_pending",
  "submitter_requested",
  "tool_execution_deferred_c004",
  "task_execution_timeout",
  "worker_execution_failed",
  "worker_lease_expired_requeued",
  "worker_recovery_budget_exhausted",
]);

export function normalizeTaskEventAppend(value, { now = new Date() } = {}) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw taskEventError("task_event_append_invalid", "task event append must be an object");
  }
  assertOnlyFields(value, ["tenantScope", "taskId", "eventType", "data", "occurredAt"]);
  const eventType = requiredExecutionTaskToken(value.eventType, "eventType", 40);
  if (!EVENT_TYPES.has(eventType)) throw taskEventError("task_event_type_invalid", "task event type is invalid");
  return Object.freeze({
    tenantScope: requiredExecutionTaskToken(value.tenantScope, "tenantScope", 160),
    taskId: requiredExecutionTaskToken(value.taskId, "taskId", 128),
    eventType,
    data: normalizeEventData(eventType, value.data),
    occurredAt: normalizedExecutionTaskNow(value.occurredAt || now),
  });
}

export function normalizeTaskEventAfterSeq(value) {
  const sequence = value === undefined || value === null || value === "" ? 0 : Number(value);
  if (!Number.isSafeInteger(sequence) || sequence < 0) {
    throw taskEventError("task_event_after_seq_invalid", "afterSeq must be a non-negative safe integer");
  }
  return sequence;
}

export function taskEventError(code, message) {
  return executionTaskError(code, message);
}

function normalizeEventData(eventType, value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw taskEventError("task_event_data_invalid", "task event data must be an object");
  }
  if (eventType === "task.state_changed") {
    assertOnlyFields(value, ["status", "waitReasonCode", "lastErrorCode", "attemptCount", "recoveryCount", "code"]);
    const status = requiredExecutionTaskToken(value.status, "data.status", 40);
    if (!TASK_STATUSES.has(status)) throw taskEventError("task_event_status_invalid", "task event status is invalid");
    return Object.freeze({
      status,
      waitReasonCode: safeWaitReasonCode(value.waitReasonCode, status),
      lastErrorCode: safeErrorCode(value.lastErrorCode, status),
      attemptCount: boundedInteger(value.attemptCount, "data.attemptCount"),
      recoveryCount: boundedInteger(value.recoveryCount, "data.recoveryCount"),
      code: presentationCode(value.code),
    });
  }
  if (eventType === "task.progress") {
    assertOnlyFields(value, ["stage", "status", "code"]);
    const stage = requiredExecutionTaskToken(value.stage, "data.stage", 40);
    const status = requiredExecutionTaskToken(value.status, "data.status", 40);
    if (!PROGRESS_STAGES.has(stage) || !PROGRESS_STATUSES.has(status)) {
      throw taskEventError("task_event_progress_invalid", "task progress stage or status is invalid");
    }
    return Object.freeze({ stage, status, code: presentationCode(value.code, { required: true }) });
  }
  if (eventType === "task.artifact_available") {
    assertOnlyFields(value, ["artifactId"]);
    return Object.freeze({ artifactId: requiredExecutionTaskToken(value.artifactId, "data.artifactId", 160) });
  }
  assertOnlyFields(value, ["resultKind"]);
  if (value.resultKind !== "conversation_history") {
    throw taskEventError("task_event_result_kind_invalid", "task result event must reference conversation history");
  }
  return Object.freeze({ resultKind: "conversation_history" });
}

function assertOnlyFields(value, allowed) {
  const allowedFields = new Set(allowed);
  if (Object.keys(value).some((field) => !allowedFields.has(field))) {
    throw taskEventError("task_event_field_not_allowed", "task event contains an undeclared field");
  }
}

function boundedInteger(value, fieldName) {
  const number = Number(value ?? 0);
  if (!Number.isSafeInteger(number) || number < 0) {
    throw taskEventError("task_event_integer_invalid", `${fieldName} must be a non-negative safe integer`);
  }
  return number;
}

function optionalToken(value, fieldName, maxLength) {
  if (value === undefined || value === null || value === "") return null;
  return requiredExecutionTaskToken(value, fieldName, maxLength);
}

function presentationCode(value, { required = false } = {}) {
  const code = optionalToken(value, "data.code", 120);
  if (!code && !required) return null;
  if (!code || !PRESENTATION_CODES.has(code)) {
    throw taskEventError("task_event_presentation_code_invalid", "task event presentation code is invalid");
  }
  return code;
}

function safeWaitReasonCode(value, status) {
  const code = optionalToken(value, "data.waitReasonCode", 120);
  if (!code) return null;
  if (SAFE_WAIT_REASON_CODES.has(code)) return code;
  return status === "queued" ? "awaiting_worker" : "prerequisite_pending";
}

function safeErrorCode(value, status) {
  const code = optionalToken(value, "data.lastErrorCode", 120);
  if (!code) return null;
  if (SAFE_ERROR_CODES.has(code)) return code;
  return `runtime_task_${status}`;
}
