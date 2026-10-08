const CONTRACT_VERSIONS = new Set(["trigger-writeback-binding.v1", "trigger-writeback-binding.v2"]);
const REGISTRY_VERSION = "trigger-writeback-binding-registry.v1";
const BINDING_V1_FIELDS = new Set([
  "bindingVersion",
  "commentFieldApiName",
  "contractVersion",
  "enabled",
  "maxCommentChars",
  "receiptFieldApiName",
  "recordReadMode",
  "reviewStatus",
  "sourceObjectApiName",
  "sourceSystemId",
  "taskDefinitionId",
  "triggerWorkflow",
  "updateMode",
  "writebackBindingId",
]);
const BINDING_V2_FIELDS = new Set([...BINDING_V1_FIELDS, "objectLockPolicy"]);
const RESOLUTION_FIELDS = new Set([
  "sourceObjectApiName",
  "sourceSystemId",
  "taskDefinitionId",
]);
const REFERENCE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:@-]{0,159}$/;
const FIELD_PATTERN = /^[A-Za-z_][A-Za-z0-9_]{0,159}$/;
const WRITEBACK_MODES = new Map([
  ["custom_find_one_by_id", "custom_object_update_by_id"],
  ["preset_get_by_id", "preset_object_update_by_id"],
]);

function createTriggerWritebackBindingRegistry({ bindings } = {}) {
  if (!Array.isArray(bindings)) throw bindingError("trigger_writeback_binding_registry_invalid");
  const byResolutionKey = new Map();
  for (const value of bindings) {
    const binding = normalizeTriggerWritebackBinding(value);
    const key = resolutionKey(binding);
    if (byResolutionKey.has(key)) throw bindingError("trigger_writeback_binding_duplicate");
    byResolutionKey.set(key, binding);
  }

  function resolve(value) {
    exactObject(value, RESOLUTION_FIELDS, "trigger_writeback_binding_resolution_invalid");
    const lookup = {
      sourceObjectApiName: reference(value.sourceObjectApiName),
      sourceSystemId: reference(value.sourceSystemId),
      taskDefinitionId: reference(value.taskDefinitionId),
    };
    const binding = byResolutionKey.get(resolutionKey(lookup));
    return binding?.enabled === true && binding.reviewStatus === "approved" ? binding : null;
  }

  return Object.freeze({ contractVersion: REGISTRY_VERSION, resolve });
}

function normalizeTriggerWritebackBinding(value) {
  if (!CONTRACT_VERSIONS.has(value?.contractVersion)) {
    throw bindingError("trigger_writeback_binding_contract_invalid");
  }
  exactObject(value, value.contractVersion === "trigger-writeback-binding.v2"
    ? BINDING_V2_FIELDS
    : BINDING_V1_FIELDS, "trigger_writeback_binding_invalid");
  if (WRITEBACK_MODES.get(value.recordReadMode) !== value.updateMode) {
    throw bindingError("trigger_writeback_binding_mode_invalid");
  }
  if (value.triggerWorkflow !== false) {
    throw bindingError("trigger_writeback_workflow_must_be_disabled");
  }
  const objectLockPolicy = value.contractVersion === "trigger-writeback-binding.v2"
    ? value.objectLockPolicy
    : "none";
  if (!["none", "unlock_current_then_relock"].includes(objectLockPolicy) ||
    (objectLockPolicy === "unlock_current_then_relock" &&
      (value.recordReadMode !== "preset_get_by_id" ||
        value.updateMode !== "preset_object_update_by_id"))) {
    throw bindingError("trigger_writeback_object_lock_policy_invalid");
  }
  if (value.reviewStatus !== "approved" && value.reviewStatus !== "pending_review" &&
    value.reviewStatus !== "rejected") {
    throw bindingError("trigger_writeback_binding_review_status_invalid");
  }
  if (typeof value.enabled !== "boolean") throw bindingError("trigger_writeback_binding_enabled_invalid");
  if (!Number.isInteger(value.maxCommentChars) || value.maxCommentChars < 500 ||
    value.maxCommentChars > 20_000) {
    throw bindingError("trigger_writeback_comment_limit_invalid");
  }
  const commentFieldApiName = fieldName(value.commentFieldApiName);
  const receiptFieldApiName = fieldName(value.receiptFieldApiName);
  if (commentFieldApiName === receiptFieldApiName) {
    throw bindingError("trigger_writeback_fields_must_be_distinct");
  }
  return Object.freeze({
    contractVersion: value.contractVersion,
    writebackBindingId: reference(value.writebackBindingId),
    bindingVersion: reference(value.bindingVersion),
    sourceSystemId: reference(value.sourceSystemId),
    sourceObjectApiName: reference(value.sourceObjectApiName),
    taskDefinitionId: reference(value.taskDefinitionId),
    recordReadMode: value.recordReadMode,
    updateMode: value.updateMode,
    commentFieldApiName,
    receiptFieldApiName,
    maxCommentChars: value.maxCommentChars,
    triggerWorkflow: false,
    ...(value.contractVersion === "trigger-writeback-binding.v2" ? { objectLockPolicy } : {}),
    enabled: value.enabled,
    reviewStatus: value.reviewStatus,
  });
}

function resolutionKey(value) {
  return JSON.stringify([value.sourceSystemId, value.sourceObjectApiName, value.taskDefinitionId]);
}

function triggerWritebackPolicyRef(value) {
  const binding = normalizeTriggerWritebackBinding(value);
  return `writeback-policy:${binding.writebackBindingId}@${binding.bindingVersion}`;
}

function exactObject(value, fields, code) {
  if (!isPlainObject(value) || Object.keys(value).length !== fields.size ||
    Object.keys(value).some((field) => !fields.has(field)) ||
    [...fields].some((field) => !Object.hasOwn(value, field))) {
    throw bindingError(code);
  }
}

function reference(value) {
  const text = String(value || "").trim();
  if (!REFERENCE_PATTERN.test(text)) throw bindingError("trigger_writeback_binding_reference_invalid");
  return text;
}

function fieldName(value) {
  if (typeof value !== "string" || !FIELD_PATTERN.test(value)) {
    throw bindingError("trigger_writeback_field_invalid");
  }
  return value;
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value) &&
    [Object.prototype, null].includes(Object.getPrototypeOf(value));
}

function bindingError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

export {
  triggerWritebackPolicyRef,
  CONTRACT_VERSIONS as TRIGGER_WRITEBACK_BINDING_CONTRACT_VERSIONS,
  REGISTRY_VERSION as TRIGGER_WRITEBACK_BINDING_REGISTRY_VERSION,
  createTriggerWritebackBindingRegistry,
  normalizeTriggerWritebackBinding,
};
