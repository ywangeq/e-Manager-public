import { normalizeCapability } from "./context-engine.mjs";
import { aiModelCatalog } from "../../src/data/catalog/shared.js";
import { providerTimeoutPolicyForRoute } from "./provider-timeout-policy.mjs";

const DEFAULT_OPENAI_BASE_URL = "https://api.openai.com/v1";

function resolveManagedProviderLease({
  employee = {},
  environment = process.env,
  providerBinding = null,
  providerCredential = {},
  providerCredentialSecret = null,
  providerRoute = {},
} = {}) {
  const bindingWasProvided = providerBinding !== null && providerBinding !== undefined;
  if (bindingWasProvided && (!providerBinding || typeof providerBinding !== "object" || Array.isArray(providerBinding))) return null;
  const hasExplicitBinding = bindingWasProvided;
  if (hasExplicitBinding && !isCanonicalTaskProviderBinding(providerBinding)) return null;
  const preferredRouteId = hasExplicitBinding
    ? first(providerBinding.providerRouteId)
    : first(
      employee.modelBinding?.providerRouteId,
      employee.runtimeBinding?.providerRouteId,
      employee.runtimeBinding?.preferredProviderRouteId,
      employee.modelBinding?.preferredProviderRouteId,
      providerRoute.id,
    );
  if (!preferredRouteId || providerRoute.id !== preferredRouteId) return null;
  const routeHealth = String(providerRoute.health || "").toLowerCase();
  if (providerRoute.enabled === false || ["disabled", "retired"].includes(routeHealth) || (hasExplicitBinding && routeHealth === "planned")) return null;
  if (!providerRoute.credentialId || providerCredential.id !== providerRoute.credentialId) return null;
  const requiredCapabilityProfileVersion = hasExplicitBinding
    ? first(providerBinding.requiredCapabilityProfileVersion)
    : first(employee.modelBinding?.requiredCapabilityProfileVersion);
  if (hasExplicitBinding && (!first(providerBinding.model) || !first(providerBinding.modelId) || !first(providerBinding.modelLevelId) ||
    !first(providerBinding.provider) || !requiredCapabilityProfileVersion || providerBinding.provider !== providerRoute.provider ||
    providerCredential.provider !== providerRoute.provider ||
    first(providerRoute.fallbackRouteId))) return null;
  if (requiredCapabilityProfileVersion && providerRoute.capabilityProfileVersion !== requiredCapabilityProfileVersion) return null;
  const protocol = {
    apiProtocol: first(providerRoute.apiProtocol),
    authMode: first(providerRoute.authMode),
    upstreamDialect: first(providerRoute.upstreamDialect),
    compat: { ...(providerRoute.compat || {}) },
  };
  if (!protocol.apiProtocol || !protocol.authMode || !protocol.upstreamDialect) return null;
  const routeEnvKey = envName(providerRoute.id);
  const credentialEnvKey = envName(providerCredential.id);
  const authSecret = providerCredentialSecret?.authSecret || environment[`AI_PROVIDER_CREDENTIAL_${credentialEnvKey}`] || "";
  const configuredBaseUrl =
    environment[`AI_PROVIDER_BASE_URL_${routeEnvKey}`] ||
    providerCredentialSecret?.legacyBaseUrl ||
    "";
  const baseUrl = configuredBaseUrl || (protocol.upstreamDialect === "openai_public" ? DEFAULT_OPENAI_BASE_URL : "");
  if (!authSecret || !baseUrl) return null;
  const contextCapability = resolveContextCapability({ employee, environment, providerBinding, providerRoute });
  return {
    ...protocol,
    authSecret,
    baseUrl: String(baseUrl).replace(/\/+$/, ""),
    providerRouteId: preferredRouteId,
    providerCredentialId: providerCredential.id,
    workerPoolId: first(providerRoute.workerPoolId),
    provider: providerRoute.provider || providerCredential.provider || "",
    capabilityProfileVersion: first(providerRoute.capabilityProfileVersion),
    ...(contextCapability ? { contextCapability } : {}),
    timeoutPolicy: providerTimeoutPolicyForRoute(providerRoute),
    timeoutMs: positiveNumber(providerRoute.timeoutMs),
    retryCount: nonNegativeNumber(providerRoute.retryCount),
    toolExecutionTimeoutMs: positiveNumber(providerRoute.toolExecutionTimeoutMs) || 300_000,
    fallbackRouteId: first(providerRoute.fallbackRouteId),
    ...(hasExplicitBinding ? {
      model: first(providerBinding.model),
      modelId: first(providerBinding.modelId),
      modelLevelId: first(providerBinding.modelLevelId),
      reasoningEffort: first(providerBinding.modelLevelId),
    } : {}),
  };
}

function isCanonicalTaskProviderBinding(value = {}) {
  return value.contractVersion === "digital-employee-task-model-binding.v1" &&
    value.status === "applied" &&
    Number.isSafeInteger(value.assignmentAppliedVersion) && value.assignmentAppliedVersion >= 0 &&
    Boolean(first(value.taskId, value.assignmentId, value.bindingVersion, value.model, value.modelId, value.modelLevelId,
      value.provider, value.providerRouteId, value.requiredCapabilityProfileVersion)) &&
    [value.assignmentSetDigest, value.bindingDigest].every((digest) => /^[a-f0-9]{64}$/.test(String(digest || "").trim().toLowerCase())) &&
    ["taskId", "assignmentId", "bindingVersion", "model", "modelId", "modelLevelId", "provider", "providerRouteId", "requiredCapabilityProfileVersion"]
      .every((field) => Boolean(first(value[field])));
}

function resolveContextCapability({ employee = {}, environment = {}, providerBinding = null, providerRoute = {} } = {}) {
  const model = first(providerBinding?.model, employee.modelBinding?.model, employee.runtimeBinding?.model);
  const environmentName = providerContextCapabilityEnvironmentName(providerRoute.id, model);
  const environmentValue = environmentName ? environment[environmentName] : "";
  // Exact provider/model identity only: do not borrow another model's capacity.
  // Existing deployment/route overrides remain authoritative for proxy limits.
  const catalogModel = aiModelCatalog.find((item) =>
    item.provider === providerRoute.provider && item.model === model);
  let configured = providerRoute.contextCapabilities?.[model] ?? providerRoute.contextCapability ??
    catalogModel?.contextCapability ?? null;
  if (environmentValue) {
    try {
      configured = JSON.parse(environmentValue);
    } catch {
      throw new Error("provider_context_capability_invalid");
    }
  }
  return configured ? normalizeCapability(configured) : null;
}

function first(...values) {
  return values.map((value) => String(value || "").trim()).find(Boolean) || "";
}

function envName(value) {
  return String(value || "").replace(/[^A-Za-z0-9]+/g, "_").replace(/^_+|_+$/g, "").toUpperCase();
}

function providerContextCapabilityEnvironmentName(providerRouteId, model) {
  const routeEnvKey = envName(providerRouteId);
  const modelEnvKey = envName(model);
  return routeEnvKey && modelEnvKey
    ? `AI_PROVIDER_CONTEXT_CAPABILITY_${routeEnvKey}_${modelEnvKey}`
    : "";
}

function positiveNumber(...values) {
  const value = values.map(Number).find((item) => Number.isFinite(item) && item > 0);
  return value || 0;
}

function nonNegativeNumber(...values) {
  const value = values.map(Number).find((item) => Number.isFinite(item) && item >= 0);
  return Number.isFinite(value) ? value : undefined;
}

export {
  providerContextCapabilityEnvironmentName,
  resolveContextCapability,
  resolveManagedProviderLease,
};
