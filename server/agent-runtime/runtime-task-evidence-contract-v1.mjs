import {
  MAX_RUNTIME_SAFE_ACTIVITIES,
  normalizeRuntimeSafeActivitySnapshot,
} from "./runtime-safe-activity-contract-v1.mjs";
import {
  DEFAULT_PROVIDER_DIAGNOSTIC,
  normalizeProviderRuntimeDiagnostic,
} from "./provider-errors.mjs";

const AGENT_RUNTIME_EVIDENCE_CONTRACT_VERSION = "agent-runtime-evidence.v1";
const MAX_RUNTIME_REQUEST_METRICS = 32;
const LEGACY_EVIDENCE_FIELDS = new Set([
  "adapter",
  "blockedReason",
  "contractVersion",
  "model",
  "provider",
  "providerDiagnostic",
  "realModelRequested",
  "reasoningEffort",
  "requestCount",
  "status",
  "toolCallCount",
  "toolCalls",
  "usage",
  "requestMetrics",
]);
const SAFE_ACTIVITY_EVIDENCE_FIELDS = new Set([
  "activitySnapshot",
  "adapter",
  "blockedReason",
  "contractVersion",
  "model",
  "provider",
  "providerDiagnostic",
  "realModelRequested",
  "reasoningEffort",
  "requestCount",
  "status",
  "toolCallCount",
  "usage",
  "requestMetrics",
]);
const TOOL_CALL_FIELDS = new Set(["name", "sequence", "skillId", "status"]);
const USAGE_FIELDS = new Set(["inputTokens", "outputTokens", "totalTokens"]);
const REQUEST_METRIC_FIELDS = new Set([
  "sequence",
  "status",
  "inputItemCount",
  "inputCharacterCount",
  "inputTokens",
  "cachedInputTokens",
  "outputTokens",
  "totalTokens",
  "durationMs",
]);
const REQUEST_METRIC_STATUSES = new Set(["received", "failed"]);
const EVIDENCE_STATUSES = new Set([
  "model_request_started",
  "model_response_received",
  "model_request_failed",
  "tool_call_started",
  "tool_call_completed",
]);
const TOOL_STATUSES = new Set([
  "blocked",
  "completed",
  "failed",
  "rejected",
  "running",
  "target_rejected",
]);
const SAFE_TOKEN = /^[A-Za-z0-9][A-Za-z0-9._:@/-]*$/;

function normalizeAgentRuntimeEvidence(value, { expectedTaskId = "" } = {}) {
  const source = withDefaultProviderDiagnostic(value);
  const safeActivityFormat = Boolean(source && typeof source === "object" &&
    Object.hasOwn(source, "activitySnapshot"));
  exactObject(
    source,
    safeActivityFormat ? SAFE_ACTIVITY_EVIDENCE_FIELDS : LEGACY_EVIDENCE_FIELDS,
    "runtime_evidence_invalid",
    { optionalFields: new Set(["requestMetrics"]) },
  );
  if (source.contractVersion !== AGENT_RUNTIME_EVIDENCE_CONTRACT_VERSION) {
    throw evidenceError("runtime_evidence_contract_invalid");
  }
  const requestCount = boundedInteger(source.requestCount, "requestCount", 0, 10_000);
  const toolCallCount = boundedInteger(
    source.toolCallCount,
    "toolCallCount",
    0,
    safeActivityFormat ? MAX_RUNTIME_SAFE_ACTIVITIES : 10_000,
  );
  if (source.realModelRequested !== true || requestCount < 1) {
    throw evidenceError("runtime_evidence_request_invalid");
  }
  const activitySnapshot = safeActivityFormat
    ? normalizeRuntimeSafeActivitySnapshot(source.activitySnapshot, { expectedTaskId })
    : null;
  if (activitySnapshot && (activitySnapshot.activities.length > toolCallCount ||
    (activitySnapshot.activities.length > 0 &&
      activitySnapshot.activities.at(-1)?.sequence > toolCallCount))) {
    throw evidenceError("runtime_evidence_activity_count_invalid");
  }
  const toolCalls = safeActivityFormat ? null : normalizeToolCalls(source.toolCalls, toolCallCount);
  return deepFreeze({
    contractVersion: AGENT_RUNTIME_EVIDENCE_CONTRACT_VERSION,
    status: enumToken(source.status, EVIDENCE_STATUSES, "status"),
    realModelRequested: true,
    provider: optionalToken(source.provider, "provider", 120),
    model: requiredToken(source.model, "model", 160),
    reasoningEffort: requiredToken(source.reasoningEffort, "reasoningEffort", 80),
    adapter: requiredToken(source.adapter, "adapter", 120),
    requestCount,
    toolCallCount,
    ...(activitySnapshot ? { activitySnapshot } : { toolCalls }),
    usage: normalizeUsage(source.usage),
    ...(Object.hasOwn(source, "requestMetrics")
      ? { requestMetrics: normalizeRequestMetrics(source.requestMetrics) }
      : {}),
    blockedReason: optionalToken(source.blockedReason, "blockedReason", 120),
    providerDiagnostic: normalizeProviderRuntimeDiagnostic(source.providerDiagnostic, {
      fallbackCategory: "none",
      fallbackReasonCode: "none",
      retryable: false,
    }),
  });
}

function normalizeRequestMetrics(value) {
  if (!Array.isArray(value) || value.length > MAX_RUNTIME_REQUEST_METRICS) {
    throw evidenceError("runtime_evidence_request_metrics_invalid");
  }
  let previousSequence = 0;
  return value.map((item) => {
    exactObject(item, REQUEST_METRIC_FIELDS, "runtime_evidence_request_metric_invalid");
    const sequence = boundedInteger(item.sequence, "sequence", 1, 10_000);
    if (sequence <= previousSequence) {
      throw evidenceError("runtime_evidence_request_metric_sequence_invalid");
    }
    previousSequence = sequence;
    return Object.freeze({
      sequence,
      status: enumToken(item.status, REQUEST_METRIC_STATUSES, "request metric status"),
      inputItemCount: boundedInteger(item.inputItemCount, "inputItemCount", 0, 10_000),
      inputCharacterCount: boundedInteger(item.inputCharacterCount, "inputCharacterCount", 0, 2_000_000),
      inputTokens: optionalInteger(item.inputTokens, "inputTokens"),
      cachedInputTokens: optionalInteger(item.cachedInputTokens, "cachedInputTokens"),
      outputTokens: optionalInteger(item.outputTokens, "outputTokens"),
      totalTokens: optionalInteger(item.totalTokens, "totalTokens"),
      durationMs: boundedInteger(item.durationMs, "durationMs", 0, 24 * 60 * 60 * 1000),
    });
  });
}

function withDefaultProviderDiagnostic(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  if (Object.hasOwn(value, "providerDiagnostic")) return value;
  return { ...value, providerDiagnostic: DEFAULT_PROVIDER_DIAGNOSTIC };
}

function normalizeToolCalls(value, toolCallCount) {
  if (!Array.isArray(value) || value.length > 50 || value.length > toolCallCount) {
    throw evidenceError("runtime_evidence_tool_calls_invalid");
  }
  let previousSequence = 0;
  return value.map((item) => {
    exactObject(item, TOOL_CALL_FIELDS, "runtime_evidence_tool_call_invalid");
    const sequence = boundedInteger(item.sequence, "sequence", 1, 10_000);
    if (sequence <= previousSequence) throw evidenceError("runtime_evidence_tool_sequence_invalid");
    previousSequence = sequence;
    return Object.freeze({
      sequence,
      name: requiredToken(item.name, "name", 160),
      skillId: optionalToken(item.skillId, "skillId", 160),
      status: enumToken(item.status, TOOL_STATUSES, "tool status"),
    });
  });
}

function normalizeUsage(value) {
  exactObject(value, USAGE_FIELDS, "runtime_evidence_usage_invalid");
  return Object.freeze({
    inputTokens: optionalInteger(value.inputTokens, "inputTokens"),
    outputTokens: optionalInteger(value.outputTokens, "outputTokens"),
    totalTokens: optionalInteger(value.totalTokens, "totalTokens"),
  });
}

function exactObject(value, fields, code, { optionalFields = new Set() } = {}) {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
    Object.keys(value).some((field) => !fields.has(field)) ||
    [...fields].some((field) => !optionalFields.has(field) && !Object.hasOwn(value, field)) ||
    Object.keys(value).length < fields.size - optionalFields.size ||
    Object.keys(value).length > fields.size) {
    throw evidenceError(code);
  }
}

function requiredToken(value, field, maxLength) {
  const token = String(value || "").trim();
  if (!token || token.length > maxLength || !SAFE_TOKEN.test(token)) {
    throw evidenceError("runtime_evidence_token_invalid", field);
  }
  return token;
}

function optionalToken(value, field, maxLength) {
  if (value === undefined || value === null || value === "") return "";
  return requiredToken(value, field, maxLength);
}

function enumToken(value, allowed, field) {
  const token = requiredToken(value, field, 120);
  if (!allowed.has(token)) throw evidenceError("runtime_evidence_status_invalid", field);
  return token;
}

function boundedInteger(value, field, minimum, maximum) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < minimum || number > maximum) {
    throw evidenceError("runtime_evidence_integer_invalid", field);
  }
  return number;
}

function optionalInteger(value, field) {
  if (value === undefined || value === null) return null;
  return boundedInteger(value, field, 0, Number.MAX_SAFE_INTEGER);
}

function deepFreeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    Object.values(value).forEach(deepFreeze);
  }
  return value;
}

function evidenceError(code, field = "") {
  const error = new Error(field ? `${code}:${field}` : code);
  error.code = code;
  return error;
}

export {
  AGENT_RUNTIME_EVIDENCE_CONTRACT_VERSION,
  MAX_RUNTIME_REQUEST_METRICS,
  normalizeAgentRuntimeEvidence,
};
