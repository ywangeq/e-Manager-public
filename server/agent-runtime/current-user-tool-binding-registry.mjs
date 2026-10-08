const REGISTRY_CONTRACT_VERSION = "current-user-tool-credential-binding-registry.v1";
const BINDING_CONTRACT_VERSION = "current-user-tool-credential-binding.v1";
const CREDENTIAL_MODE = "center_current_user_lease";
const TOKEN = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,239}$/;

function createCurrentUserToolCredentialBindingRegistry({ bindings = [] } = {}) {
  const bindingByToolId = new Map();
  for (const value of Array.isArray(bindings) ? bindings : []) {
    const binding = normalizeBinding(value);
    if (bindingByToolId.has(binding.toolId)) throw new TypeError("current_user_tool_credential_binding_duplicate");
    bindingByToolId.set(binding.toolId, binding);
  }
  return Object.freeze({
    contractVersion: REGISTRY_CONTRACT_VERSION,
    bindingFor: (toolId) => bindingByToolId.get(cleanToken(toolId)) || null,
    bindings: () => [...bindingByToolId.values()],
  });
}

function normalizeBinding(value = {}) {
  if (!plainObject(value) || value.contractVersion !== BINDING_CONTRACT_VERSION || value.credentialMode !== CREDENTIAL_MODE) {
    throw new TypeError("current_user_tool_credential_binding_invalid");
  }
  const maxLeaseDurationMs = Number(value.maxLeaseDurationMs);
  if (!Number.isSafeInteger(maxLeaseDurationMs) || maxLeaseDurationMs < 30_000 || maxLeaseDurationMs > 15 * 60_000) {
    throw new TypeError("current_user_tool_credential_binding_invalid");
  }
  return Object.freeze({
    contractVersion: BINDING_CONTRACT_VERSION,
    bindingId: requiredToken(value.bindingId),
    bindingVersion: requiredToken(value.bindingVersion),
    credentialMode: CREDENTIAL_MODE,
    issuerAdapterId: requiredToken(value.issuerAdapterId),
    audience: requiredToken(value.audience),
    maxLeaseDurationMs,
    scopeSource: value.scopeSource === "managed_openapi_operation" ? value.scopeSource : invalidBinding(),
    status: value.status === "active" ? "active" : invalidBinding(),
    toolId: requiredToken(value.toolId),
  });
}

function requiredToken(value) {
  const token = cleanToken(value);
  if (!TOKEN.test(token)) throw new TypeError("current_user_tool_credential_binding_invalid");
  return token;
}

function cleanToken(value) {
  return String(value || "").trim();
}

function invalidBinding() {
  throw new TypeError("current_user_tool_credential_binding_invalid");
}

function plainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value) &&
    [Object.prototype, null].includes(Object.getPrototypeOf(value));
}

export {
  BINDING_CONTRACT_VERSION,
  CREDENTIAL_MODE,
  REGISTRY_CONTRACT_VERSION,
  createCurrentUserToolCredentialBindingRegistry,
};
