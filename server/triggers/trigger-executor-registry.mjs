const TRIGGER_EXECUTOR_HANDLER_CONTRACT_VERSION = "trigger-executor-handler.v1";
const TRIGGER_EXECUTOR_REGISTRY_CONTRACT_VERSION = "trigger-executor-registry.v1";

const HANDLER_FIELDS = new Set([
  "contractVersion",
  "enabled",
  "execute",
  "handlerVersion",
  "reviewStatus",
  "taskDefinitionId",
]);
const RESOLUTION_FIELDS = new Set(["handlerVersion", "taskDefinitionId"]);
const REVIEW_STATUSES = new Set(["approved", "pending_review", "rejected"]);
const TOKEN_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:@-]*$/;

function createTriggerExecutorRegistry({ handlers } = {}) {
  if (!Array.isArray(handlers)) throw registryError("trigger_executor_registry_config_invalid");
  const byDefinitionAndHandlerVersion = new Map();
  for (const value of handlers) {
    const handler = normalizeTriggerExecutorHandler(value);
    const key = resolutionKey(handler);
    if (byDefinitionAndHandlerVersion.has(key)) {
      throw registryError("trigger_executor_handler_duplicate");
    }
    byDefinitionAndHandlerVersion.set(key, handler);
  }

  function resolve(value) {
    requirePlainObject(value, "trigger executor resolution");
    requireExactFields(value, RESOLUTION_FIELDS, "trigger executor resolution");
    const taskDefinitionId = requiredToken(value.taskDefinitionId, 160);
    const handlerVersion = requiredToken(value.handlerVersion, 80);
    const handler = byDefinitionAndHandlerVersion.get(resolutionKey({ taskDefinitionId, handlerVersion }));
    return handler?.enabled === true && handler.reviewStatus === "approved" ? handler : null;
  }

  return Object.freeze({
    contractVersion: TRIGGER_EXECUTOR_REGISTRY_CONTRACT_VERSION,
    resolve,
  });
}

function resolutionKey(value) {
  return JSON.stringify([value.taskDefinitionId, value.handlerVersion]);
}

function normalizeTriggerExecutorHandler(value) {
  requirePlainObject(value, "trigger executor handler");
  requireExactFields(value, HANDLER_FIELDS, "trigger executor handler");
  if (value.contractVersion !== TRIGGER_EXECUTOR_HANDLER_CONTRACT_VERSION) {
    throw registryError("trigger_executor_handler_contract_invalid");
  }
  if (typeof value.enabled !== "boolean") {
    throw registryError("trigger_executor_handler_enabled_invalid");
  }
  if (!REVIEW_STATUSES.has(value.reviewStatus)) {
    throw registryError("trigger_executor_handler_review_status_invalid");
  }
  if (typeof value.execute !== "function") {
    throw registryError("trigger_executor_handler_execute_invalid");
  }
  return Object.freeze({
    contractVersion: TRIGGER_EXECUTOR_HANDLER_CONTRACT_VERSION,
    taskDefinitionId: requiredToken(value.taskDefinitionId, 160),
    handlerVersion: requiredToken(value.handlerVersion, 80),
    enabled: value.enabled,
    reviewStatus: value.reviewStatus,
    execute: value.execute,
  });
}

function requirePlainObject(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(value))) {
    throw registryError("trigger_executor_value_invalid", `${label} must be a plain object`);
  }
}

function requireExactFields(value, fields, label) {
  if (Object.keys(value).length !== fields.size ||
    Object.keys(value).some((field) => !fields.has(field)) ||
    [...fields].some((field) => !Object.hasOwn(value, field))) {
    throw registryError("trigger_executor_fields_invalid", `${label} fields are invalid`);
  }
}

function requiredToken(value, maxLength) {
  if (typeof value !== "string" || value !== value.trim() || !value ||
    value.length > maxLength || !TOKEN_PATTERN.test(value)) {
    throw registryError("trigger_executor_reference_invalid");
  }
  return value;
}

function registryError(code, message = code) {
  const error = new Error(message);
  error.code = code;
  return error;
}

export {
  TRIGGER_EXECUTOR_HANDLER_CONTRACT_VERSION,
  TRIGGER_EXECUTOR_REGISTRY_CONTRACT_VERSION,
  createTriggerExecutorRegistry,
  normalizeTriggerExecutorHandler,
};
