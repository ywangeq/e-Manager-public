import { normalizeAgentExecutionBudget } from "./agent-execution-budget.mjs";
import { normalizedOutputFormat } from "./agent-output-format.mjs";
import crypto from "node:crypto";
import {
  EXECUTION_TASK_CONTRACT_VERSION,
  executionTaskError,
  normalizeExecutionTaskSubmission,
} from "./runtime-task-contract-v1.mjs";
import { SESSION_ROUTE_CONTRACT } from "./session-route.mjs";
import { TRANSCRIPT_ENTRY_CONTRACT } from "./session-foundation-repository.mjs";
import {
  DEFAULT_PROVIDER_TIMEOUT_POLICY,
  normalizeProviderTimeoutPolicy,
} from "./provider-timeout-policy.mjs";

const PROJECTOR_CONTRACT_VERSION = "execution-task-submission-projector.v1";
const INPUT_REFERENCE_CONTRACT_VERSION = "execution-task-input-reference.v1";
const REQUEST_ID_MAX_LENGTH = 1024;
const ALLOWED_INPUT_FIELDS = new Set([
  "employeeVersion",
  "materialBindingDigest",
  "materialBindingsDigest",
  "requestId",
  "route",
  "sessionId",
  "sourceSystemId",
  "taskType",
  "transcriptEntry",
]);
const ALLOWED_ROUTE_FIELDS = new Set([
  "accountId",
  "actorIssuer",
  "actorSubjectDigest",
  "centerInstanceId",
  "channelId",
  "contractVersion",
  "conversationDigest",
  "conversationType",
  "employeeId",
  "integrityMac",
  "routeDigest",
  "routeRef",
  "tenantScope",
  "threadDigest",
]);
const ALLOWED_TRANSCRIPT_ENTRY_FIELDS = new Set([
  "contractVersion",
  "createdAt",
  "entryId",
  "idempotencyKey",
  "message",
  "seq",
  "sessionId",
  "type",
]);
const EMAIL_VALUE_PATTERN = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const HOST_PATH_PATTERN = /^(?:\/|~[\\/]|[A-Za-z]:[\\/]|\\\\)/;
const SECRET_VALUE_PATTERN = /^(?:bearer[\s._:-]*|sk-|rk-|xox[baprs]-|gh[pousr]_|glpat-|ya29\.|eyJ)[A-Za-z0-9._~+\/-]{8,}$/i;

function createRuntimeTaskSubmissionProjector({ defaultProviderTimeoutPolicy = DEFAULT_PROVIDER_TIMEOUT_POLICY, verifyRoute } = {}) {
  if (typeof verifyRoute !== "function") {
    throw submissionProjectorError(
      "execution_task_route_verifier_required",
      "runtime task submission projector requires verifyRoute",
    );
  }

  function project(value = {}, { providerTimeoutPolicy = defaultProviderTimeoutPolicy } = {}) {
    requirePlainObject(value, "execution_task_submission_projection_invalid", "submission projection input must be an object");
    rejectUnknownFields(value, ALLOWED_INPUT_FIELDS, "submission projection input");

    const route = requireVerifiedRoute(value.route, verifyRoute);
    const sessionId = requiredOpaqueText(value.sessionId, "sessionId", 160);
    const transcriptEntry = requireUserTranscriptEntry(value.transcriptEntry, sessionId);
    const timeoutPolicy = normalizeProviderTimeoutPolicy(providerTimeoutPolicy);
    const requestId = requiredOpaqueText(value.requestId, "requestId", REQUEST_ID_MAX_LENGTH);
    const employeeVersion = requiredOpaqueText(value.employeeVersion, "employeeVersion", 80);
    const sourceSystemId = requiredOpaqueText(value.sourceSystemId, "sourceSystemId", 120);
    const taskType = requiredOpaqueText(value.taskType, "taskType", 120);
    const materialBindingDigest = optionalSha256Digest(value.materialBindingDigest, "materialBindingDigest");
    const materialBindingsDigest = optionalSha256Digest(value.materialBindingsDigest, "materialBindingsDigest");
    if (materialBindingDigest && materialBindingsDigest) {
      throw submissionProjectorError(
        "execution_task_submission_reference_invalid",
        "submission projection accepts one material binding reference form",
      );
    }
    const requestDigest = digestCanonical([
      PROJECTOR_CONTRACT_VERSION,
      "request",
      route.routeDigest,
      requestId,
    ]);
    const taskId = `task_${requestDigest}`;

    return normalizeExecutionTaskSubmission({
      taskId,
      tenantScope: route.tenantScope,
      actorIssuer: route.actorIssuer,
      actorSubjectDigest: route.actorSubjectDigest,
      employeeId: route.employeeId,
      employeeVersion,
      sessionId,
      sourceSystemId,
      channelId: route.channelId,
      taskType,
      submissionScope: `route:${route.routeDigest}`,
      idempotencyKey: `request:${requestDigest}`,
      inputDigest: digestCanonical([
        INPUT_REFERENCE_CONTRACT_VERSION,
        route.routeDigest,
        sessionId,
        transcriptEntry.entryId,
        transcriptEntry.seq,
        transcriptEntry.idempotencyKey,
        requestDigest,
        employeeVersion,
        sourceSystemId,
        taskType,
        timeoutPolicy.policyVersion,
        timeoutPolicy.connectMs,
        timeoutPolicy.firstSemanticOutputMs,
        timeoutPolicy.streamIdleMs,
        timeoutPolicy.requestTotalMs,
        timeoutPolicy.taskExecutionTotalMs,
        ...(materialBindingDigest ? ["task-material-binding.v1", materialBindingDigest] : []),
        ...(materialBindingsDigest ? ["task-material-binding-set.v1", materialBindingsDigest] : []),
      ]),
      executionInputRef: {
        kind: "transcript_entry",
        refId: transcriptEntry.entryId,
      },
      createdAt: transcriptEntry.createdAt,
      availableAt: transcriptEntry.createdAt,
      providerTimeoutPolicy: timeoutPolicy,
    });
  }

  return Object.freeze({
    contractVersion: PROJECTOR_CONTRACT_VERSION,
    executionTaskContractVersion: EXECUTION_TASK_CONTRACT_VERSION,
    project,
  });
}

function requireVerifiedRoute(route, verifyRoute) {
  requirePlainObject(route, "execution_task_route_invalid", "submission route must be a session-route.v1 object");
  rejectUnknownFields(route, ALLOWED_ROUTE_FIELDS, "submission route");
  if (route.contractVersion !== SESSION_ROUTE_CONTRACT || verifyRoute(route) !== true) {
    throw submissionProjectorError(
      "execution_task_route_invalid",
      "submission route must be verified by the Session Foundation route authority",
    );
  }
  for (const field of ["tenantScope", "actorIssuer", "actorSubjectDigest", "employeeId", "channelId"]) {
    rejectSensitiveIdentifier(route[field], `route.${field}`);
  }
  return route;
}

function requireUserTranscriptEntry(entry, sessionId) {
  requirePlainObject(
    entry,
    "execution_task_transcript_entry_invalid",
    "execution task input must be a persisted transcript-entry.v1",
  );
  rejectUnknownFields(entry, ALLOWED_TRANSCRIPT_ENTRY_FIELDS, "submission transcript entry");
  if (entry.contractVersion !== TRANSCRIPT_ENTRY_CONTRACT || entry.sessionId !== sessionId ||
    entry.type !== "message" || entry.message?.role !== "user") {
    throw submissionProjectorError(
      "execution_task_transcript_entry_invalid",
      "execution task input must reference a user message in the supplied session",
    );
  }
  rejectUnknownFields(entry.message, new Set(["content", "role", "outputFormat", "executionBudget"]), "submission transcript message");
  normalizeAgentExecutionBudget(entry.message.executionBudget);
  if (entry.message.outputFormat != null) normalizedOutputFormat(entry.message.outputFormat);
  requiredOpaqueText(entry.entryId, "transcriptEntry.entryId", 240);
  requiredOpaqueText(entry.idempotencyKey, "transcriptEntry.idempotencyKey", 240);
  if (!Number.isSafeInteger(entry.seq) || entry.seq < 1) {
    throw submissionProjectorError(
      "execution_task_transcript_entry_invalid",
      "transcriptEntry.seq must be a positive integer",
    );
  }
  const createdAt = new Date(entry.createdAt);
  if (!Number.isFinite(createdAt.getTime())) {
    throw submissionProjectorError(
      "execution_task_transcript_entry_invalid",
      "transcriptEntry.createdAt must be an ISO timestamp",
    );
  }
  if (typeof entry.message.content !== "string" || !entry.message.content.trim()) {
    throw submissionProjectorError(
      "execution_task_transcript_entry_invalid",
      "transcriptEntry must contain the persisted user message",
    );
  }
  return entry;
}

function rejectUnknownFields(value, allowedFields, label) {
  requirePlainObject(value, "execution_task_unsafe_submission_field", `${label} must be an object`);
  const unknownFields = Object.keys(value).filter((field) => !allowedFields.has(field));
  if (unknownFields.length) {
    throw submissionProjectorError(
      "execution_task_unsafe_submission_field",
      `${label} contains unsupported field: ${unknownFields[0]}`,
    );
  }
}

function requiredOpaqueText(value, field, maxLength) {
  const text = String(value ?? "").trim();
  if (!text || text.length > maxLength || /[\u0000-\u001f\u007f]/.test(text)) {
    throw submissionProjectorError(
      "execution_task_submission_reference_invalid",
      `${field} must be a bounded opaque reference`,
    );
  }
  rejectSensitiveIdentifier(text, field);
  return text;
}

function optionalSha256Digest(value, field) {
  if (value === undefined || value === null || value === "") return null;
  const digest = String(value).trim().toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(digest)) {
    throw submissionProjectorError(
      "execution_task_submission_reference_invalid",
      `${field} must be a SHA-256 digest`,
    );
  }
  return digest;
}

function rejectSensitiveIdentifier(value, field) {
  const text = String(value ?? "").trim();
  if (EMAIL_VALUE_PATTERN.test(text) || HOST_PATH_PATTERN.test(text) || SECRET_VALUE_PATTERN.test(text)) {
    throw submissionProjectorError(
      "execution_task_sensitive_submission_value",
      `${field} must be an opaque identifier, not an email, credential, or host path`,
    );
  }
}

function requirePlainObject(value, code, message) {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
    (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)) {
    throw submissionProjectorError(code, message);
  }
}

function digestCanonical(parts) {
  return crypto.createHash("sha256").update(JSON.stringify(parts)).digest("hex");
}

function submissionProjectorError(code, message) {
  const error = executionTaskError(code, message);
  error.code = code;
  return error;
}

export {
  INPUT_REFERENCE_CONTRACT_VERSION,
  PROJECTOR_CONTRACT_VERSION,
  createRuntimeTaskSubmissionProjector,
};
