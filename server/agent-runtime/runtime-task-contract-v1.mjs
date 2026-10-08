import crypto from "node:crypto";
import {
  DEFAULT_PROVIDER_TIMEOUT_POLICY,
  normalizeProviderTimeoutPolicy,
} from "./provider-timeout-policy.mjs";

export const EXECUTION_TASK_CONTRACT_VERSION = "execution-task.v1";
export const EXECUTION_TASK_REPOSITORY_CONTRACT_VERSION = "execution-task-repository.v1";

export const EXECUTION_TASK_TERMINAL_STATUSES = Object.freeze([
  "blocked",
  "canceled",
  "completed",
  "failed",
  "lost",
  "rejected",
  "timed_out",
]);

const EXECUTION_INPUT_KINDS = new Set(["artifact_ref", "transcript_entry"]);
const SETTLEMENT_STATUSES = new Set(["blocked", "completed", "failed", "timed_out"]);
const SETTLEMENT_FIELDS = new Set(["lastErrorCode", "resultSummary", "status", "terminalEvidenceDigest"]);
const SAFE_TOKEN_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:@-]*$/;
const DIGEST_PATTERN = /^[a-f0-9]{64}$/;

export function normalizeExecutionTaskSubmission(value, { now = new Date() } = {}) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw executionTaskError("execution_task_submission_invalid", "execution task submission must be an object");
  }
  const createdAt = optionalIsoTimestamp(value.createdAt, "createdAt") || normalizedNow(now);
  const availableAt = optionalIsoTimestamp(value.availableAt, "availableAt") || createdAt;
  const taskId = optionalToken(value.taskId, "taskId", 128) || `task_${crypto.randomUUID()}`;
  const executionInputRef = normalizeExecutionInputRef(value.executionInputRef);
  const providerTimeoutPolicy = normalizeProviderTimeoutPolicy(value.providerTimeoutPolicy || DEFAULT_PROVIDER_TIMEOUT_POLICY);
  return Object.freeze({
    taskId,
    contractVersion: EXECUTION_TASK_CONTRACT_VERSION,
    tenantScope: requiredToken(value.tenantScope, "tenantScope", 160),
    actorIssuer: requiredToken(value.actorIssuer, "actorIssuer", 160),
    actorSubjectDigest: requiredDigest(value.actorSubjectDigest, "actorSubjectDigest"),
    employeeId: requiredToken(value.employeeId, "employeeId", 160),
    employeeVersion: optionalToken(value.employeeVersion, "employeeVersion", 80),
    sessionId: optionalToken(value.sessionId, "sessionId", 160),
    sourceSystemId: requiredToken(value.sourceSystemId, "sourceSystemId", 120),
    channelId: requiredToken(value.channelId, "channelId", 120),
    taskType: requiredToken(value.taskType, "taskType", 120),
    submissionScope: requiredToken(value.submissionScope, "submissionScope", 240),
    idempotencyKey: requiredToken(value.idempotencyKey, "idempotencyKey", 240),
    inputDigest: requiredDigest(value.inputDigest, "inputDigest"),
    executionInputRef,
    workspaceRef: `task:${taskId}`,
    priority: boundedInteger(value.priority, "priority", { defaultValue: 0, min: 0, max: 0 }),
    maxRecoveries: boundedInteger(value.maxRecoveries, "maxRecoveries", {
      defaultValue: 2,
      min: 0,
      max: 20,
    }),
    providerTimeoutPolicy,
    availableAt,
    createdAt,
  });
}

export function normalizeExecutionTaskSettlement(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw executionTaskError("execution_task_settlement_invalid", "execution task settlement must be an object");
  }
  if (Object.keys(value).some((field) => !SETTLEMENT_FIELDS.has(field))) {
    throw executionTaskError("execution_task_settlement_invalid", "execution task settlement contains unsupported fields");
  }
  const status = requiredToken(value.status, "status", 40);
  if (!SETTLEMENT_STATUSES.has(status)) {
    throw executionTaskError(
      "execution_task_settlement_status_invalid",
      "execution task settlement status must be completed, failed, blocked, or timed_out",
    );
  }
  return Object.freeze({
    status,
    lastErrorCode: optionalToken(value.lastErrorCode, "lastErrorCode", 120),
    resultSummary: optionalSafeSummary(value.resultSummary),
    terminalEvidenceDigest: optionalDigest(value.terminalEvidenceDigest, "terminalEvidenceDigest"),
  });
}

export function executionTaskError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

export function requiredExecutionTaskDigest(value, fieldName) {
  return requiredDigest(value, fieldName);
}

export function requiredExecutionTaskToken(value, fieldName, maxLength = 240) {
  return requiredToken(value, fieldName, maxLength);
}

export function normalizedExecutionTaskNow(value) {
  return normalizedNow(value);
}

function normalizeExecutionInputRef(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw executionTaskError(
      "execution_task_input_ref_invalid",
      "executionInputRef must identify a governed transcript entry or artifact reference",
    );
  }
  const kind = requiredToken(value.kind, "executionInputRef.kind", 40);
  if (!EXECUTION_INPUT_KINDS.has(kind)) {
    throw executionTaskError(
      "execution_task_input_ref_kind_invalid",
      "executionInputRef.kind must be transcript_entry or artifact_ref",
    );
  }
  return Object.freeze({
    kind,
    refId: requiredToken(value.refId, "executionInputRef.refId", 240),
  });
}

function requiredDigest(value, fieldName) {
  const digest = String(value || "").trim().toLowerCase();
  if (!DIGEST_PATTERN.test(digest)) {
    throw executionTaskError("execution_task_digest_invalid", `${fieldName} must be a sha256 hex digest`);
  }
  return digest;
}

function optionalDigest(value, fieldName) {
  if (value === undefined || value === null || value === "") return null;
  return requiredDigest(value, fieldName);
}

function requiredToken(value, fieldName, maxLength) {
  const token = String(value || "").trim();
  if (!token || token.length > maxLength || !SAFE_TOKEN_PATTERN.test(token)) {
    throw executionTaskError(
      "execution_task_token_invalid",
      `${fieldName} must be a bounded opaque identifier`,
    );
  }
  return token;
}

function optionalToken(value, fieldName, maxLength) {
  if (value === undefined || value === null || value === "") return null;
  return requiredToken(value, fieldName, maxLength);
}

function optionalSafeSummary(value) {
  if (value === undefined || value === null || value === "") return null;
  const summary = String(value).trim();
  if (!summary || summary.length > 500 || /[\r\n\0]/.test(summary)) {
    throw executionTaskError(
      "execution_task_result_summary_invalid",
      "resultSummary must be a single-line audit-safe summary no longer than 500 characters",
    );
  }
  return summary;
}

function optionalIsoTimestamp(value, fieldName) {
  if (value === undefined || value === null || value === "") return null;
  const timestamp = new Date(value);
  if (!Number.isFinite(timestamp.getTime())) {
    throw executionTaskError("execution_task_timestamp_invalid", `${fieldName} must be an ISO timestamp`);
  }
  return timestamp.toISOString();
}

function normalizedNow(value) {
  const timestamp = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(timestamp.getTime())) {
    throw executionTaskError("execution_task_now_invalid", "execution task clock returned an invalid timestamp");
  }
  return timestamp.toISOString();
}

function boundedInteger(value, fieldName, { defaultValue, min, max }) {
  const normalized = value === undefined || value === null ? defaultValue : Number(value);
  if (!Number.isSafeInteger(normalized) || normalized < min || normalized > max) {
    throw executionTaskError(
      "execution_task_integer_invalid",
      `${fieldName} must be an integer between ${min} and ${max}`,
    );
  }
  return normalized;
}
