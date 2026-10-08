const TRIGGER_TASK_DEFINITION_CONTRACT_VERSION = "trigger-task-definition.v2";
const TRIGGER_TASK_DEFINITION_REGISTRY_CONTRACT_VERSION = "trigger-task-definition-registry.v1";
const DEFINITION_FIELDS = new Set([
  "contractVersion",
  "enabled",
  "handlerVersion",
  "outputPolicyRef",
  "reviewStatus",
  "skillPolicyRef",
  "taskDefinitionId",
  "taskDefinitionVersion",
  "toolPolicyRef",
  "writebackPolicyRef",
]);
const RESOLUTION_FIELDS = new Set([
  "handlerVersion",
  "taskDefinitionId",
  "taskDefinitionVersion",
]);
const REVIEW_STATUSES = new Set(["approved", "pending_review", "rejected"]);
const TOKEN_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:@-]*$/;

function createTriggerTaskDefinitionRegistry({ definitions, getDefinitions = null } = {}) {
  if (!Array.isArray(definitions) || (getDefinitions !== null && typeof getDefinitions !== "function")) {
    throw definitionError("trigger_task_definition_registry_invalid");
  }

  function currentDefinitions() {
    const values = getDefinitions ? getDefinitions() : definitions;
    if (!Array.isArray(values)) throw definitionError("trigger_task_definition_registry_invalid");
    const byId = new Map();
    for (const value of values) {
      const definition = normalizeTriggerTaskDefinition(value);
      if (byId.has(definition.taskDefinitionId)) {
        throw definitionError("trigger_task_definition_duplicate");
      }
      byId.set(definition.taskDefinitionId, definition);
    }
    return byId;
  }
  currentDefinitions();

  function get(taskDefinitionId) {
    const definition = currentDefinitions().get(requiredToken(taskDefinitionId, 160));
    return isRunnable(definition) ? definition : null;
  }

  function resolve(value) {
    requireExactObject(value, RESOLUTION_FIELDS, "trigger task definition resolution");
    const lookup = {
      taskDefinitionId: requiredToken(value.taskDefinitionId, 160),
      taskDefinitionVersion: requiredToken(value.taskDefinitionVersion, 80),
      handlerVersion: requiredToken(value.handlerVersion, 80),
    };
    const definition = get(lookup.taskDefinitionId);
    if (!definition || definition.taskDefinitionVersion !== lookup.taskDefinitionVersion ||
      definition.handlerVersion !== lookup.handlerVersion) {
      return null;
    }
    return definition;
  }

  return Object.freeze({
    contractVersion: TRIGGER_TASK_DEFINITION_REGISTRY_CONTRACT_VERSION,
    get,
    resolve,
  });
}

function normalizeTriggerTaskDefinition(value) {
  requireExactObject(value, DEFINITION_FIELDS, "trigger task definition");
  if (value.contractVersion !== TRIGGER_TASK_DEFINITION_CONTRACT_VERSION) {
    throw definitionError("trigger_task_definition_contract_invalid");
  }
  if (typeof value.enabled !== "boolean") {
    throw definitionError("trigger_task_definition_enabled_invalid");
  }
  if (!REVIEW_STATUSES.has(value.reviewStatus)) {
    throw definitionError("trigger_task_definition_review_status_invalid");
  }
  return Object.freeze({
    contractVersion: TRIGGER_TASK_DEFINITION_CONTRACT_VERSION,
    taskDefinitionId: requiredToken(value.taskDefinitionId, 160),
    taskDefinitionVersion: requiredToken(value.taskDefinitionVersion, 80),
    handlerVersion: requiredToken(value.handlerVersion, 80),
    skillPolicyRef: requiredToken(value.skillPolicyRef, 240),
    toolPolicyRef: requiredToken(value.toolPolicyRef, 240),
    outputPolicyRef: requiredToken(value.outputPolicyRef, 240),
    writebackPolicyRef: requiredToken(value.writebackPolicyRef, 240),
    enabled: value.enabled,
    reviewStatus: value.reviewStatus,
  });
}

function isRunnable(definition) {
  return definition?.enabled === true && definition.reviewStatus === "approved";
}

function requireExactObject(value, fields, label) {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(value))) {
    throw definitionError("trigger_task_definition_value_invalid", `${label} must be a plain object`);
  }
  if (Object.keys(value).length !== fields.size || Object.keys(value).some((field) => !fields.has(field)) ||
    [...fields].some((field) => !Object.hasOwn(value, field))) {
    throw definitionError("trigger_task_definition_fields_invalid", `${label} fields are invalid`);
  }
}

function requiredToken(value, maximum) {
  if (typeof value !== "string" || value !== value.trim() || !value || value.length > maximum ||
    !TOKEN_PATTERN.test(value)) {
    throw definitionError("trigger_task_definition_reference_invalid");
  }
  return value;
}

function definitionError(code, message = code) {
  const error = new Error(message);
  error.code = code;
  return error;
}

export {
  TRIGGER_TASK_DEFINITION_CONTRACT_VERSION,
  TRIGGER_TASK_DEFINITION_REGISTRY_CONTRACT_VERSION,
  createTriggerTaskDefinitionRegistry,
  normalizeTriggerTaskDefinition,
};
