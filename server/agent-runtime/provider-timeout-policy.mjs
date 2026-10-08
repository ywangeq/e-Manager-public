const PROVIDER_TIMEOUT_POLICY_CONTRACT_VERSION = "provider-timeout-policy.v1";
const POLICY_FIELDS = new Set([
  "connectMs",
  "contractVersion",
  "firstSemanticOutputMs",
  "policyVersion",
  "requestTotalMs",
  "streamIdleMs",
  "taskExecutionTotalMs",
]);
const POLICY_VERSION_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:@-]*$/;
const LIMITS = Object.freeze({
  connectMs: 10 * 60 * 1000,
  firstSemanticOutputMs: 2 * 60 * 60 * 1000,
  streamIdleMs: 2 * 60 * 60 * 1000,
  requestTotalMs: 4 * 60 * 60 * 1000,
  taskExecutionTotalMs: 48 * 60 * 60 * 1000,
});
const DEFAULT_PROVIDER_TIMEOUT_POLICY = Object.freeze({
  contractVersion: PROVIDER_TIMEOUT_POLICY_CONTRACT_VERSION,
  policyVersion: "provider-timeout-default-v2",
  connectMs: 120_000,
  firstSemanticOutputMs: 120_000,
  streamIdleMs: 120_000,
  requestTotalMs: 5 * 60_000,
  taskExecutionTotalMs: 30 * 60_000,
});

function normalizeProviderTimeoutPolicy(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw providerTimeoutPolicyError("provider_timeout_policy_invalid", "provider timeout policy must be an object");
  }
  const unexpectedFields = Object.keys(value).filter((field) => !POLICY_FIELDS.has(field));
  if (unexpectedFields.length) {
    throw providerTimeoutPolicyError("provider_timeout_policy_field_unknown", "provider timeout policy contains unknown fields");
  }
  if (value.contractVersion !== PROVIDER_TIMEOUT_POLICY_CONTRACT_VERSION) {
    throw providerTimeoutPolicyError("provider_timeout_policy_contract_invalid", "provider timeout policy contractVersion is invalid");
  }
  const policyVersion = requiredPolicyVersion(value.policyVersion);
  const normalized = {
    contractVersion: PROVIDER_TIMEOUT_POLICY_CONTRACT_VERSION,
    policyVersion,
    connectMs: requiredDuration(value.connectMs, "connectMs"),
    firstSemanticOutputMs: requiredDuration(value.firstSemanticOutputMs, "firstSemanticOutputMs"),
    streamIdleMs: requiredDuration(value.streamIdleMs, "streamIdleMs"),
    requestTotalMs: requiredDuration(value.requestTotalMs, "requestTotalMs"),
    taskExecutionTotalMs: requiredDuration(value.taskExecutionTotalMs, "taskExecutionTotalMs"),
  };
  for (const field of ["connectMs", "firstSemanticOutputMs", "streamIdleMs"]) {
    if (normalized[field] > normalized.requestTotalMs) {
      throw providerTimeoutPolicyError("provider_timeout_policy_order_invalid", `${field} cannot exceed requestTotalMs`);
    }
  }
  if (normalized.requestTotalMs > normalized.taskExecutionTotalMs) {
    throw providerTimeoutPolicyError("provider_timeout_policy_order_invalid", "requestTotalMs cannot exceed taskExecutionTotalMs");
  }
  return Object.freeze(normalized);
}

function requiredPolicyVersion(value) {
  const normalized = String(value || "").trim();
  if (!normalized || normalized.length > 120 || !POLICY_VERSION_PATTERN.test(normalized)) {
    throw providerTimeoutPolicyError("provider_timeout_policy_version_invalid", "provider timeout policyVersion must be a bounded opaque identifier");
  }
  return normalized;
}

function requiredDuration(value, field) {
  const duration = Number(value);
  if (!Number.isSafeInteger(duration) || duration < 1 || duration > LIMITS[field]) {
    throw providerTimeoutPolicyError("provider_timeout_policy_duration_invalid", `${field} must be a bounded positive integer`);
  }
  return duration;
}

function providerTimeoutPolicyError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function providerTimeoutPolicyForRoute(route = {}) {
  if (route?.timeoutPolicy) return normalizeProviderTimeoutPolicy(route.timeoutPolicy);
  const legacyTimeoutMs = Number(route?.timeoutMs);
  if (!Number.isSafeInteger(legacyTimeoutMs) || legacyTimeoutMs < 1) return DEFAULT_PROVIDER_TIMEOUT_POLICY;
  const requestTotalMs = Math.min(LIMITS.requestTotalMs, legacyTimeoutMs);
  return normalizeProviderTimeoutPolicy({
    ...DEFAULT_PROVIDER_TIMEOUT_POLICY,
    policyVersion: "provider-timeout-legacy-route-v1",
    connectMs: Math.min(DEFAULT_PROVIDER_TIMEOUT_POLICY.connectMs, requestTotalMs),
    firstSemanticOutputMs: Math.min(DEFAULT_PROVIDER_TIMEOUT_POLICY.firstSemanticOutputMs, requestTotalMs),
    streamIdleMs: Math.min(DEFAULT_PROVIDER_TIMEOUT_POLICY.streamIdleMs, requestTotalMs),
    requestTotalMs,
  });
}

// A server-owned caller may narrow, but never enlarge, the governed policy.
// The resulting snapshot uses the existing canonical task deadline authority.
function constrainProviderTimeoutPolicy(policy, taskExecutionMaxMs = null) {
  const normalized = normalizeProviderTimeoutPolicy(policy);
  if (taskExecutionMaxMs == null) return normalized;
  if (!Number.isSafeInteger(taskExecutionMaxMs) || taskExecutionMaxMs < 1 || taskExecutionMaxMs > LIMITS.taskExecutionTotalMs) {
    throw providerTimeoutPolicyError("provider_timeout_task_cap_invalid", "task execution cap must be a bounded positive integer");
  }
  const taskExecutionTotalMs = Math.min(normalized.taskExecutionTotalMs, taskExecutionMaxMs);
  const requestTotalMs = Math.min(normalized.requestTotalMs, taskExecutionTotalMs);
  return normalizeProviderTimeoutPolicy({ ...normalized, taskExecutionTotalMs, requestTotalMs,
    connectMs: Math.min(normalized.connectMs, requestTotalMs),
    firstSemanticOutputMs: Math.min(normalized.firstSemanticOutputMs, requestTotalMs),
    streamIdleMs: Math.min(normalized.streamIdleMs, requestTotalMs),
  });
}

export {
  DEFAULT_PROVIDER_TIMEOUT_POLICY,
  constrainProviderTimeoutPolicy,
  PROVIDER_TIMEOUT_POLICY_CONTRACT_VERSION,
  normalizeProviderTimeoutPolicy,
  providerTimeoutPolicyForRoute,
};
