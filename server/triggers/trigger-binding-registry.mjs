const TRIGGER_BINDING_CONTRACT_VERSION = "trigger-binding.v1";
const TRIGGER_BINDING_REGISTRY_CONTRACT_VERSION = "trigger-binding-registry.v1";

const TRIGGER_BINDING_ERROR_CODES = Object.freeze({
  CONTRACT_VERSION_INVALID: "trigger_binding_contract_version_invalid",
  DUPLICATE_ID: "trigger_binding_duplicate_id",
  ENABLED_INVALID: "trigger_binding_enabled_invalid",
  ENV_NAME_INVALID: "trigger_binding_env_name_invalid",
  FIELD_NOT_ALLOWED: "trigger_binding_field_not_allowed",
  REFERENCE_INVALID: "trigger_binding_reference_invalid",
  REGISTRY_CONFIG_INVALID: "trigger_binding_registry_config_invalid",
  RESOLUTION_FIELD_NOT_ALLOWED: "trigger_binding_resolution_field_not_allowed",
  REVIEW_STATUS_INVALID: "trigger_binding_review_status_invalid",
  SENSITIVE_FIELD_FORBIDDEN: "trigger_binding_sensitive_field_forbidden",
  SENSITIVE_VALUE_FORBIDDEN: "trigger_binding_sensitive_value_forbidden",
  VALUE_INVALID: "trigger_binding_value_invalid",
});

const TRIGGER_BINDING_REVIEW_STATUSES = Object.freeze([
  "approved",
  "pending_review",
  "rejected",
]);
const REVIEW_STATUS_SET = new Set(TRIGGER_BINDING_REVIEW_STATUSES);
const BINDING_FIELDS = new Set([
  "bindingId",
  "bindingVersion",
  "contractVersion",
  "enabled",
  "eventType",
  "reviewStatus",
  "secretEnvName",
  "sourceAdapterId",
  "sourceSystemId",
  "targetEmployeeId",
  "taskDefinitionId",
]);
const RESOLUTION_FIELDS = new Set([
  "bindingId",
  "eventType",
  "sourceAdapterId",
  "sourceSystemId",
]);
const SENSITIVE_FIELD_PATTERN = /(?:authorization|bearer|body|credential|message|password|path|prompt|raw|secretvalue|text|token|tool)/i;
const SAFE_OPAQUE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:@-]*$/;
const ENV_NAME_PATTERN = /^[A-Z][A-Z0-9_]{0,127}$/;
const EMAIL_VALUE_PATTERN = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const PHONE_VALUE_PATTERN = /^(?:\+?86[- ]?)?1[3-9]\d{9}$/;
const NATIONAL_ID_VALUE_PATTERN = /^\d{17}[\dXx]$/;
const HOST_PATH_VALUE_PATTERN = /^(?:\/|~[\\/]|[A-Za-z]:[\\/]|\\\\)|[\\/]/;
const SECRET_VALUE_PATTERN = /^(?:bearer[\s._:-]*|sk-|rk-|xox[baprs]-|gh[pousr]_|glpat-|ya29\.|eyJ)[A-Za-z0-9._~+/=-]{8,}$/i;

class TriggerBindingRegistryError extends Error {
  constructor(code, message = code, field = null) {
    super(message);
    this.name = "TriggerBindingRegistryError";
    this.code = code;
    this.field = field;
  }
}

function createTriggerBindingRegistry({ bindings } = {}) {
  if (!Array.isArray(bindings)) {
    throw triggerBindingError(
      TRIGGER_BINDING_ERROR_CODES.REGISTRY_CONFIG_INVALID,
      "server-owned trigger bindings must be an array",
      "bindings",
    );
  }
  const bindingsById = new Map();
  for (const value of bindings) {
    const binding = normalizeServerTriggerBinding(value);
    if (bindingsById.has(binding.bindingId)) {
      throw triggerBindingError(
        TRIGGER_BINDING_ERROR_CODES.DUPLICATE_ID,
        "bindingId must be unique",
        "bindingId",
      );
    }
    bindingsById.set(binding.bindingId, binding);
  }

  function resolve(value) {
    requirePlainObject(value, "binding resolution");
    requireExactFields(value, RESOLUTION_FIELDS, "binding resolution", {
      fieldCode: TRIGGER_BINDING_ERROR_CODES.RESOLUTION_FIELD_NOT_ALLOWED,
    });
    const lookup = {
      bindingId: requiredOpaqueId(value.bindingId, "bindingId", 160),
      sourceAdapterId: requiredOpaqueId(value.sourceAdapterId, "sourceAdapterId", 120),
      sourceSystemId: requiredOpaqueId(value.sourceSystemId, "sourceSystemId", 120),
      eventType: requiredOpaqueId(value.eventType, "eventType", 120),
    };
    const binding = bindingsById.get(lookup.bindingId);
    if (!binding || binding.enabled !== true || binding.reviewStatus !== "approved") return null;
    if (binding.sourceAdapterId !== lookup.sourceAdapterId ||
      binding.sourceSystemId !== lookup.sourceSystemId ||
      binding.eventType !== lookup.eventType) return null;
    return binding;
  }

  function get(bindingId) {
    const normalizedId = requiredOpaqueId(bindingId, "bindingId", 160);
    const binding = bindingsById.get(normalizedId);
    return binding?.enabled === true && binding.reviewStatus === "approved" ? binding : null;
  }

  return Object.freeze({
    contractVersion: TRIGGER_BINDING_REGISTRY_CONTRACT_VERSION,
    get,
    resolve,
  });
}

function normalizeServerTriggerBinding(value) {
  requirePlainObject(value, "server trigger binding");
  requireExactFields(value, BINDING_FIELDS, "server trigger binding");
  if (value.contractVersion !== TRIGGER_BINDING_CONTRACT_VERSION) {
    throw triggerBindingError(
      TRIGGER_BINDING_ERROR_CODES.CONTRACT_VERSION_INVALID,
      `contractVersion must equal ${TRIGGER_BINDING_CONTRACT_VERSION}`,
      "contractVersion",
    );
  }
  if (typeof value.enabled !== "boolean") {
    throw triggerBindingError(
      TRIGGER_BINDING_ERROR_CODES.ENABLED_INVALID,
      "enabled must be a boolean",
      "enabled",
    );
  }
  if (!REVIEW_STATUS_SET.has(value.reviewStatus)) {
    throw triggerBindingError(
      TRIGGER_BINDING_ERROR_CODES.REVIEW_STATUS_INVALID,
      "reviewStatus is invalid",
      "reviewStatus",
    );
  }
  if (typeof value.secretEnvName !== "string" || !ENV_NAME_PATTERN.test(value.secretEnvName)) {
    throw triggerBindingError(
      TRIGGER_BINDING_ERROR_CODES.ENV_NAME_INVALID,
      "secretEnvName must name a server environment variable",
      "secretEnvName",
    );
  }

  return Object.freeze({
    contractVersion: TRIGGER_BINDING_CONTRACT_VERSION,
    bindingId: requiredOpaqueId(value.bindingId, "bindingId", 160),
    bindingVersion: requiredOpaqueId(value.bindingVersion, "bindingVersion", 80),
    sourceAdapterId: requiredOpaqueId(value.sourceAdapterId, "sourceAdapterId", 120),
    sourceSystemId: requiredOpaqueId(value.sourceSystemId, "sourceSystemId", 120),
    eventType: requiredOpaqueId(value.eventType, "eventType", 120),
    targetEmployeeId: requiredOpaqueId(value.targetEmployeeId, "targetEmployeeId", 160),
    taskDefinitionId: requiredOpaqueId(value.taskDefinitionId, "taskDefinitionId", 160),
    secretEnvName: value.secretEnvName,
    enabled: value.enabled,
    reviewStatus: value.reviewStatus,
  });
}

function requireExactFields(value, allowedFields, label, {
  fieldCode = TRIGGER_BINDING_ERROR_CODES.FIELD_NOT_ALLOWED,
} = {}) {
  for (const field of Object.keys(value)) {
    if (!allowedFields.has(field)) {
      const code = SENSITIVE_FIELD_PATTERN.test(field)
        ? TRIGGER_BINDING_ERROR_CODES.SENSITIVE_FIELD_FORBIDDEN
        : fieldCode;
      throw triggerBindingError(code, `${label} contains an unsupported field`, field);
    }
  }
  const missing = [...allowedFields].find((field) => !Object.hasOwn(value, field));
  if (missing) {
    throw triggerBindingError(
      TRIGGER_BINDING_ERROR_CODES.VALUE_INVALID,
      `${label} is missing a required field`,
      missing,
    );
  }
}

function requiredOpaqueId(value, field, maxLength) {
  if (typeof value !== "string" || value !== value.trim() || !value || value.length > maxLength) {
    throw triggerBindingError(
      TRIGGER_BINDING_ERROR_CODES.REFERENCE_INVALID,
      `${field} must be a bounded opaque identifier`,
      field,
    );
  }
  rejectSensitiveValue(value, field);
  if (!SAFE_OPAQUE_ID_PATTERN.test(value)) {
    throw triggerBindingError(
      TRIGGER_BINDING_ERROR_CODES.REFERENCE_INVALID,
      `${field} must be a bounded opaque identifier`,
      field,
    );
  }
  return value;
}

function rejectSensitiveValue(value, field) {
  if (EMAIL_VALUE_PATTERN.test(value) || PHONE_VALUE_PATTERN.test(value) ||
    NATIONAL_ID_VALUE_PATTERN.test(value) || HOST_PATH_VALUE_PATTERN.test(value) ||
    SECRET_VALUE_PATTERN.test(value)) {
    throw triggerBindingError(
      TRIGGER_BINDING_ERROR_CODES.SENSITIVE_VALUE_FORBIDDEN,
      `${field} must be an opaque identifier, not PII, a credential, or a path`,
      field,
    );
  }
}

function requirePlainObject(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(value))) {
    throw triggerBindingError(
      TRIGGER_BINDING_ERROR_CODES.VALUE_INVALID,
      `${label} must be a plain object`,
    );
  }
}

function triggerBindingError(code, message, field = null) {
  return new TriggerBindingRegistryError(code, message, field);
}

export {
  TRIGGER_BINDING_CONTRACT_VERSION,
  TRIGGER_BINDING_ERROR_CODES,
  TRIGGER_BINDING_REGISTRY_CONTRACT_VERSION,
  TRIGGER_BINDING_REVIEW_STATUSES,
  TriggerBindingRegistryError,
  createTriggerBindingRegistry,
  normalizeServerTriggerBinding,
};
