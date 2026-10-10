import { normalizeProviderTimeoutPolicy, providerTimeoutPolicyForRoute } from "./provider-timeout-policy.mjs";

export function normalizeRouteExecutionLimits(input, route) {
  const fields = ["modelRequestSeconds", "toolCallSeconds", "modelRetryCount", "taskBudgetSeconds"];
  if (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input).length !== fields.length || fields.some(key => !Number.isSafeInteger(input[key])) || Object.keys(input).some(key => !fields.includes(key))) throw new TypeError("route_execution_limits_invalid");
  const { modelRequestSeconds, toolCallSeconds, modelRetryCount, taskBudgetSeconds } = input;
  if (modelRequestSeconds < 1 || modelRequestSeconds > 14400 || toolCallSeconds < 1 || toolCallSeconds > 172800 || modelRetryCount < 0 || modelRetryCount > 5 || taskBudgetSeconds < Math.max(modelRequestSeconds, toolCallSeconds) || taskBudgetSeconds > 172800) throw new TypeError("route_execution_limits_invalid");
  const base = providerTimeoutPolicyForRoute(route);
  const requestTotalMs = modelRequestSeconds * 1000;
  return {
    timeoutPolicy: normalizeProviderTimeoutPolicy({ ...base, policyVersion: "provider-timeout-managed-v1", requestTotalMs, taskExecutionTotalMs: taskBudgetSeconds * 1000,
      connectMs: Math.min(base.connectMs, requestTotalMs), firstSemanticOutputMs: Math.min(base.firstSemanticOutputMs, requestTotalMs), streamIdleMs: Math.min(base.streamIdleMs, requestTotalMs) }),
    toolExecutionTimeoutMs: toolCallSeconds * 1000, retryCount: modelRetryCount,
  };
}
