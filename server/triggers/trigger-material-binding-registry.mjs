const CONTRACT_VERSION = "trigger-material-binding.v2";
const REGISTRY_VERSION = "trigger-material-binding-registry.v2";
const BINDING_FIELDS = new Set([
  "allowedExtensions",
  "attachmentFields",
  "bindingVersion",
  "contractVersion",
  "enabled",
  "fieldProjection",
  "materialBindingId",
  "maxAttachmentBytes",
  "maxAttachmentCount",
  "recordReadMode",
  "reviewStatus",
  "sourceObjectApiName",
  "sourceSystemId",
  "taskDefinitionId",
]);
const RESOLUTION_FIELDS = new Set([
  "sourceObjectApiName",
  "sourceSystemId",
  "taskDefinitionId",
]);
const REFERENCE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:@-]{0,159}$/;
const FIELD_PATTERN = /^[A-Za-z_][A-Za-z0-9_]{0,159}$/;
const EXTENSION_PATTERN = /^[a-z0-9]{1,12}$/;

function createTriggerMaterialBindingRegistry({ bindings } = {}) {
  if (!Array.isArray(bindings)) throw bindingError("trigger_material_binding_registry_invalid");
  const byResolutionKey = new Map();
  for (const value of bindings) {
    const binding = normalizeTriggerMaterialBinding(value);
    const key = resolutionKey(binding);
    if (byResolutionKey.has(key)) throw bindingError("trigger_material_binding_duplicate");
    byResolutionKey.set(key, binding);
  }

  function resolve(value) {
    exactObject(value, RESOLUTION_FIELDS, "trigger_material_binding_resolution_invalid");
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

function normalizeTriggerMaterialBinding(value) {
  exactObject(value, BINDING_FIELDS, "trigger_material_binding_invalid");
  if (value.contractVersion !== CONTRACT_VERSION) {
    throw bindingError("trigger_material_binding_contract_invalid");
  }
  if (value.recordReadMode !== "custom_find_one_by_id") {
    throw bindingError("trigger_material_binding_read_mode_invalid");
  }
  if (value.reviewStatus !== "approved" && value.reviewStatus !== "pending_review" &&
    value.reviewStatus !== "rejected") {
    throw bindingError("trigger_material_binding_review_status_invalid");
  }
  if (typeof value.enabled !== "boolean") throw bindingError("trigger_material_binding_enabled_invalid");
  const fieldProjection = fieldList(value.fieldProjection, "trigger_material_binding_fields_invalid");
  const attachmentFields = fieldList(value.attachmentFields,
    "trigger_material_binding_attachments_invalid", { allowEmpty: true });
  if (!fieldProjection.includes("_id") ||
    attachmentFields.some((field) => !fieldProjection.includes(field))) {
    throw bindingError("trigger_material_binding_attachments_invalid");
  }
  const allowedExtensions = extensionList(value.allowedExtensions, { allowEmpty: true });
  const maxAttachmentCount = boundedInteger(value.maxAttachmentCount, 0, 20,
    "trigger_material_binding_attachment_count_invalid");
  if ((attachmentFields.length === 0 && (allowedExtensions.length !== 0 || maxAttachmentCount !== 0)) ||
    (attachmentFields.length > 0 && (allowedExtensions.length === 0 || maxAttachmentCount === 0))) {
    throw bindingError("trigger_material_binding_attachments_invalid");
  }
  const maxAttachmentBytes = boundedInteger(value.maxAttachmentBytes, 1, 50 * 1024 * 1024,
    "trigger_material_binding_attachment_bytes_invalid");
  return Object.freeze({
    contractVersion: CONTRACT_VERSION,
    materialBindingId: reference(value.materialBindingId),
    bindingVersion: reference(value.bindingVersion),
    sourceSystemId: reference(value.sourceSystemId),
    sourceObjectApiName: reference(value.sourceObjectApiName),
    taskDefinitionId: reference(value.taskDefinitionId),
    recordReadMode: value.recordReadMode,
    fieldProjection,
    attachmentFields,
    allowedExtensions,
    maxAttachmentCount,
    maxAttachmentBytes,
    enabled: value.enabled,
    reviewStatus: value.reviewStatus,
  });
}

function resolutionKey(value) {
  return JSON.stringify([value.sourceSystemId, value.sourceObjectApiName, value.taskDefinitionId]);
}

function exactObject(value, fields, code) {
  if (!isPlainObject(value) || Object.keys(value).length !== fields.size ||
    Object.keys(value).some((field) => !fields.has(field)) ||
    [...fields].some((field) => !Object.hasOwn(value, field))) {
    throw bindingError(code);
  }
}

function fieldList(value, code, { allowEmpty = false } = {}) {
  if (!Array.isArray(value) || (!allowEmpty && !value.length) || value.length > 40 ||
    value.some((field) => typeof field !== "string" || !FIELD_PATTERN.test(field)) ||
    new Set(value).size !== value.length) {
    throw bindingError(code);
  }
  return Object.freeze([...value]);
}

function extensionList(value, { allowEmpty = false } = {}) {
  if (!Array.isArray(value) || (!allowEmpty && !value.length) || value.length > 20 ||
    value.some((extension) => typeof extension !== "string" ||
      extension !== extension.toLowerCase() || !EXTENSION_PATTERN.test(extension)) ||
    new Set(value).size !== value.length) {
    throw bindingError("trigger_material_binding_extensions_invalid");
  }
  return Object.freeze([...value]);
}

function boundedInteger(value, minimum, maximum, code) {
  if (!Number.isInteger(value) || value < minimum || value > maximum) throw bindingError(code);
  return value;
}

function reference(value) {
  const text = String(value || "").trim();
  if (!REFERENCE_PATTERN.test(text)) throw bindingError("trigger_material_binding_reference_invalid");
  return text;
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
  CONTRACT_VERSION as TRIGGER_MATERIAL_BINDING_CONTRACT_VERSION,
  REGISTRY_VERSION as TRIGGER_MATERIAL_BINDING_REGISTRY_VERSION,
  createTriggerMaterialBindingRegistry,
  normalizeTriggerMaterialBinding,
};
