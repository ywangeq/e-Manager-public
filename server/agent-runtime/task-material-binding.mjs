import crypto from "node:crypto";

const TASK_MATERIAL_BINDING_CONTRACT_VERSION = "task-material-binding.v1";
const TASK_MATERIAL_BINDING_DESCRIPTOR_VERSION = "task-material-binding-descriptor.v1";
const TASK_MATERIAL_BINDING_SET_CONTRACT_VERSION = "task-material-binding-set.v1";
const DEVICE_WORKSPACE_INPUT_ADAPTER_ID = "device-workspace-input.v1";
const DEVICE_WORKSPACE_INPUT_PAYLOAD_VERSION = "device-workspace-input-material-payload.v1";
const SOURCE_KINDS = new Set(["channel_resource", "device_workspace_input", "predecessor_task_input", "reusable_artifact_grant"]);
const SAFE_TOKEN_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:@-]*$/;
const DIGEST_PATTERN = /^[a-f0-9]{64}$/;
const HOST_PATH_PATTERN = /^(?:\/|~[\\/]|[A-Za-z]:[\\/]|\\\\)/;
const SECRET_VALUE_PATTERN = /^(?:bearer[\s._:-]*|sk-|rk-|xox[baprs]-|gh[pousr]_|glpat-|ya29\.|eyJ)[A-Za-z0-9._~+\/-]{8,}$/i;
const FORBIDDEN_PAYLOAD_FIELD_PATTERN = /(?:authorization|base64|bearer|cookie|credential|password|prompt|raw|secret|token|url)/i;
const MAX_PAYLOAD_BYTES = 64 * 1024;
const PREDECESSOR_TASK_INPUT_ADAPTER_ID = "task-input-fork.v1";

// Desktop attaches an empty workspace descriptor even for text-only messages.
// It contains no reusable material; nonempty selections still need their own grant.
function taskMaterialBindingsRequireSourceAccess(bindings = []) {
  const emptyWorkspaceDigest = digestCanonical({ contractVersion: "device-sandbox-task-input-digest.v1", inputs: [] });
  return bindings.some(binding => binding.sourceKind !== "device_workspace_input" ||
    binding.adapterId !== DEVICE_WORKSPACE_INPUT_ADAPTER_ID ||
    binding.payload?.workspaceInputDigest !== emptyWorkspaceDigest);
}

function createPredecessorTaskMaterialBindingDescriptor({ sourceBinding } = {}) {
  const source = normalizeTaskMaterialBinding(sourceBinding);
  return normalizeTaskMaterialBindingDescriptor({
    contractVersion: TASK_MATERIAL_BINDING_DESCRIPTOR_VERSION,
    sourceKind: "predecessor_task_input",
    adapterId: PREDECESSOR_TASK_INPUT_ADAPTER_ID,
    sourceIdentityDigest: digestCanonical([
      PREDECESSOR_TASK_INPUT_ADAPTER_ID,
      source.taskId,
      source.bindingDigest,
    ]),
    sourceTaskId: source.taskId,
    sourceBindingDigest: source.bindingDigest,
    expiresAt: source.expiresAt,
  });
}

function createDeviceWorkspaceInputMaterialBindingDescriptor({ expiresAt, selectionRef, workspaceInputDigest } = {}) {
  const payload = normalizeDeviceWorkspaceInputPayload({
    contractVersion: DEVICE_WORKSPACE_INPUT_PAYLOAD_VERSION,
    selectionRef,
    workspaceInputDigest,
  });
  return normalizeTaskMaterialBindingDescriptor({
    contractVersion: TASK_MATERIAL_BINDING_DESCRIPTOR_VERSION,
    sourceKind: "device_workspace_input",
    adapterId: DEVICE_WORKSPACE_INPUT_ADAPTER_ID,
    sourceIdentityDigest: digestCanonical([
      DEVICE_WORKSPACE_INPUT_ADAPTER_ID,
      payload.selectionRef,
      payload.workspaceInputDigest,
    ]),
    expiresAt,
    payload,
  });
}

function normalizeTaskMaterialBindingDescriptor(value) {
  requirePlainObject(value, "task material binding descriptor");
  rejectUnknownFields(value, new Set([
    "adapterId",
    "contractVersion",
    "expiresAt",
    "payload",
    "sourceBindingDigest",
    "sourceIdentityDigest",
    "sourceKind",
    "sourceTaskId",
  ]), "task material binding descriptor");
  if (value.contractVersion !== TASK_MATERIAL_BINDING_DESCRIPTOR_VERSION) {
    throw bindingError("task_material_binding_descriptor_contract_invalid");
  }
  const sourceKind = requiredToken(value.sourceKind, "sourceKind", 80);
  if (!SOURCE_KINDS.has(sourceKind)) throw bindingError("task_material_binding_source_kind_invalid");
  const normalized = {
    contractVersion: TASK_MATERIAL_BINDING_DESCRIPTOR_VERSION,
    sourceKind,
    adapterId: requiredToken(value.adapterId, "adapterId", 120),
    sourceIdentityDigest: requiredDigest(value.sourceIdentityDigest, "sourceIdentityDigest"),
    expiresAt: requiredTimestamp(value.expiresAt, "expiresAt"),
  };
  if (sourceKind === "device_workspace_input" && normalized.adapterId !== DEVICE_WORKSPACE_INPUT_ADAPTER_ID) {
    throw bindingError("task_material_binding_device_workspace_adapter_invalid");
  }
  if (sourceKind === "channel_resource" || sourceKind === "reusable_artifact_grant" || sourceKind === "device_workspace_input") {
    if (value.sourceTaskId || value.sourceBindingDigest) {
      throw bindingError("task_material_binding_descriptor_invalid");
    }
    normalized.payload = sourceKind === "device_workspace_input"
      ? normalizeDeviceWorkspaceInputPayload(value.payload)
      : normalizeEncryptedPayload(value.payload);
  } else {
    if (value.payload !== undefined && value.payload !== null) {
      throw bindingError("task_material_binding_descriptor_invalid");
    }
    normalized.sourceTaskId = requiredToken(value.sourceTaskId, "sourceTaskId", 128);
    normalized.sourceBindingDigest = requiredDigest(value.sourceBindingDigest, "sourceBindingDigest");
  }
  return deepFreeze(normalized);
}

function taskMaterialBindingDescriptorDigest(value) {
  return digestCanonical(normalizeTaskMaterialBindingDescriptor(value));
}

function taskMaterialBindingSetDescriptorDigest(values = []) {
  const descriptors = normalizeMaterialBindingDescriptors(values);
  return digestCanonical({
    contractVersion: TASK_MATERIAL_BINDING_SET_CONTRACT_VERSION,
    descriptorDigests: descriptors.map((descriptor) => taskMaterialBindingDescriptorDigest(descriptor)),
  });
}

function createTaskMaterialBindingSet({ descriptors = [], routeDigest, submission, transcriptEntryId } = {}) {
  const normalizedDescriptors = normalizeMaterialBindingDescriptors(descriptors);
  const bindings = normalizedDescriptors.map((descriptor) => createTaskMaterialBinding({
    descriptor,
    routeDigest,
    submission,
    transcriptEntryId,
  }));
  return normalizeTaskMaterialBindingSet({
    bindings,
    bindingSetDigest: taskMaterialBindingSetDigest(bindings),
    contractVersion: TASK_MATERIAL_BINDING_SET_CONTRACT_VERSION,
  });
}

function normalizeTaskMaterialBindingSet(value) {
  requirePlainObject(value, "task material binding set");
  rejectUnknownFields(value, new Set(["bindings", "bindingSetDigest", "contractVersion"]), "task material binding set");
  if (value.contractVersion !== TASK_MATERIAL_BINDING_SET_CONTRACT_VERSION || !Array.isArray(value.bindings) || !value.bindings.length || value.bindings.length > 64) {
    throw bindingError("task_material_binding_set_invalid");
  }
  const bindings = value.bindings.map(normalizeTaskMaterialBinding).sort(compareBinding);
  const first = bindings[0];
  if (bindings.some((binding) => !sameBindingScope(binding, first))) throw bindingError("task_material_binding_set_scope_mismatch");
  if (new Set(bindings.map((binding) => binding.descriptorDigest)).size !== bindings.length) {
    throw bindingError("task_material_binding_set_duplicate");
  }
  const bindingSetDigest = taskMaterialBindingSetDigest(bindings);
  if (requiredDigest(value.bindingSetDigest, "bindingSetDigest") !== bindingSetDigest) {
    throw bindingError("task_material_binding_set_digest_mismatch");
  }
  return deepFreeze({
    bindingSetDigest,
    bindings,
    contractVersion: TASK_MATERIAL_BINDING_SET_CONTRACT_VERSION,
  });
}

function normalizeMaterialBindingDescriptors(values = []) {
  if (!Array.isArray(values) || !values.length || values.length > 64) throw bindingError("task_material_binding_set_invalid");
  const descriptors = values.map(normalizeTaskMaterialBindingDescriptor).sort((left, right) => (
    taskMaterialBindingDescriptorDigest(left).localeCompare(taskMaterialBindingDescriptorDigest(right))
  ));
  if (new Set(descriptors.map((descriptor) => taskMaterialBindingDescriptorDigest(descriptor))).size !== descriptors.length) {
    throw bindingError("task_material_binding_set_duplicate");
  }
  return descriptors;
}

function taskMaterialBindingSetDigest(bindings = []) {
  return digestCanonical({
    bindingDigests: bindings.map((binding) => binding.bindingDigest),
    contractVersion: TASK_MATERIAL_BINDING_SET_CONTRACT_VERSION,
  });
}

function compareBinding(left, right) {
  return left.descriptorDigest.localeCompare(right.descriptorDigest);
}

function sameBindingScope(left, right) {
  return ["taskId", "tenantScope", "actorIssuer", "actorSubjectDigest", "employeeId", "employeeVersion", "sessionId", "channelId", "routeDigest", "transcriptEntryId", "createdAt"].every((field) => left[field] === right[field]);
}

function createTaskMaterialBinding({ descriptor, routeDigest, submission, transcriptEntryId } = {}) {
  const normalizedDescriptor = normalizeTaskMaterialBindingDescriptor(descriptor);
  const descriptorFields = { ...normalizedDescriptor };
  delete descriptorFields.contractVersion;
  if (!submission || typeof submission !== "object" || Array.isArray(submission)) {
    throw bindingError("task_material_binding_submission_invalid");
  }
  const createdAt = requiredTimestamp(submission.createdAt, "createdAt");
  if (normalizedDescriptor.expiresAt <= createdAt) throw bindingError("task_material_binding_expired");
  const binding = {
    contractVersion: TASK_MATERIAL_BINDING_CONTRACT_VERSION,
    taskId: requiredToken(submission.taskId, "taskId", 128),
    tenantScope: requiredToken(submission.tenantScope, "tenantScope", 160),
    actorIssuer: requiredToken(submission.actorIssuer, "actorIssuer", 160),
    actorSubjectDigest: requiredDigest(submission.actorSubjectDigest, "actorSubjectDigest"),
    employeeId: requiredToken(submission.employeeId, "employeeId", 160),
    employeeVersion: requiredToken(submission.employeeVersion, "employeeVersion", 80),
    // Group child tasks intentionally have no chat session. Keep the
    // canonical task's null session boundary instead of inventing a
    // transcript/session identity solely to satisfy material binding.
    sessionId: optionalToken(submission.sessionId, "sessionId", 160),
    channelId: requiredToken(submission.channelId, "channelId", 120),
    routeDigest: requiredDigest(routeDigest, "routeDigest"),
    transcriptEntryId: optionalToken(transcriptEntryId, "transcriptEntryId", 240),
    descriptorDigest: taskMaterialBindingDescriptorDigest(normalizedDescriptor),
    ...descriptorFields,
    createdAt,
  };
  if (binding.sessionId === null && !binding.taskId.startsWith("group_task_")) {
    throw bindingError("task_material_binding_session_required");
  }
  binding.bindingDigest = digestCanonical(binding);
  return deepFreeze(binding);
}

function normalizeTaskMaterialBinding(value) {
  requirePlainObject(value, "task material binding");
  rejectUnknownFields(value, new Set([
    "actorIssuer",
    "actorSubjectDigest",
    "adapterId",
    "bindingDigest",
    "channelId",
    "contractVersion",
    "createdAt",
    "descriptorDigest",
    "employeeId",
    "employeeVersion",
    "expiresAt",
    "payload",
    "routeDigest",
    "sessionId",
    "sourceBindingDigest",
    "sourceIdentityDigest",
    "sourceKind",
    "sourceTaskId",
    "taskId",
    "tenantScope",
    "transcriptEntryId",
  ]), "task material binding");
  if (value.contractVersion !== TASK_MATERIAL_BINDING_CONTRACT_VERSION) {
    throw bindingError("task_material_binding_contract_invalid");
  }
  const descriptor = normalizeTaskMaterialBindingDescriptor({
    contractVersion: TASK_MATERIAL_BINDING_DESCRIPTOR_VERSION,
    sourceKind: value.sourceKind,
    adapterId: value.adapterId,
    sourceIdentityDigest: value.sourceIdentityDigest,
    expiresAt: value.expiresAt,
    ...(value.sourceKind === "channel_resource" || value.sourceKind === "reusable_artifact_grant" || value.sourceKind === "device_workspace_input"
      ? { payload: value.payload }
      : { sourceTaskId: value.sourceTaskId, sourceBindingDigest: value.sourceBindingDigest }),
  });
  const descriptorFields = { ...descriptor };
  delete descriptorFields.contractVersion;
  const normalized = {
    contractVersion: TASK_MATERIAL_BINDING_CONTRACT_VERSION,
    taskId: requiredToken(value.taskId, "taskId", 128),
    tenantScope: requiredToken(value.tenantScope, "tenantScope", 160),
    actorIssuer: requiredToken(value.actorIssuer, "actorIssuer", 160),
    actorSubjectDigest: requiredDigest(value.actorSubjectDigest, "actorSubjectDigest"),
    employeeId: requiredToken(value.employeeId, "employeeId", 160),
    employeeVersion: requiredToken(value.employeeVersion, "employeeVersion", 80),
    sessionId: optionalToken(value.sessionId, "sessionId", 160),
    channelId: requiredToken(value.channelId, "channelId", 120),
    routeDigest: requiredDigest(value.routeDigest, "routeDigest"),
    transcriptEntryId: optionalToken(value.transcriptEntryId, "transcriptEntryId", 240),
    descriptorDigest: requiredDigest(value.descriptorDigest, "descriptorDigest"),
    ...descriptorFields,
    createdAt: requiredTimestamp(value.createdAt, "createdAt"),
  };
  if (normalized.sessionId === null && !normalized.taskId.startsWith("group_task_")) {
    throw bindingError("task_material_binding_session_required");
  }
  if (normalized.expiresAt <= normalized.createdAt) throw bindingError("task_material_binding_expired");
  if (normalized.descriptorDigest !== taskMaterialBindingDescriptorDigest(descriptor)) {
    throw bindingError("task_material_binding_descriptor_digest_mismatch");
  }
  const expectedBindingDigest = digestCanonical(normalized);
  if (requiredDigest(value.bindingDigest, "bindingDigest") !== expectedBindingDigest) {
    throw bindingError("task_material_binding_digest_mismatch");
  }
  return deepFreeze({ ...normalized, bindingDigest: expectedBindingDigest });
}

function normalizeDeviceWorkspaceInputPayload(value) {
  requirePlainObject(value, "device workspace input material payload");
  rejectUnknownFields(value, new Set(["contractVersion", "selectionRef", "workspaceInputDigest"]), "device workspace input material payload");
  if (value.contractVersion !== DEVICE_WORKSPACE_INPUT_PAYLOAD_VERSION) {
    throw bindingError("task_material_binding_device_workspace_payload_invalid");
  }
  return deepFreeze({
    contractVersion: DEVICE_WORKSPACE_INPUT_PAYLOAD_VERSION,
    selectionRef: requiredToken(value.selectionRef, "selectionRef", 160),
    workspaceInputDigest: requiredDigest(value.workspaceInputDigest, "workspaceInputDigest"),
  });
}

function normalizeEncryptedPayload(value) {
  requirePlainObject(value, "task material binding payload");
  validatePayloadValue(value, 0);
  if (Buffer.byteLength(JSON.stringify(value), "utf8") > MAX_PAYLOAD_BYTES) {
    throw bindingError("task_material_binding_payload_too_large");
  }
  return structuredClone(value);
}

function validatePayloadValue(value, depth) {
  if (depth > 6) throw bindingError("task_material_binding_payload_invalid");
  if (value === null || typeof value === "boolean") return;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw bindingError("task_material_binding_payload_invalid");
    return;
  }
  if (typeof value === "string") {
    if (value.length > 2048 || /[\0\r\n]/.test(value) || HOST_PATH_PATTERN.test(value) || SECRET_VALUE_PATTERN.test(value)) {
      throw bindingError("task_material_binding_payload_sensitive");
    }
    return;
  }
  if (Array.isArray(value)) {
    if (value.length > 64) throw bindingError("task_material_binding_payload_invalid");
    value.forEach((item) => validatePayloadValue(item, depth + 1));
    return;
  }
  requirePlainObject(value, "task material binding payload value");
  const entries = Object.entries(value);
  if (entries.length > 64) throw bindingError("task_material_binding_payload_invalid");
  for (const [key, item] of entries) {
    if (!/^[A-Za-z][A-Za-z0-9]{0,79}$/.test(key) || FORBIDDEN_PAYLOAD_FIELD_PATTERN.test(key)) {
      throw bindingError("task_material_binding_payload_field_forbidden");
    }
    validatePayloadValue(item, depth + 1);
  }
}

function rejectUnknownFields(value, allowed, label) {
  const unknown = Object.keys(value).find((field) => !allowed.has(field));
  if (unknown) throw bindingError("task_material_binding_unknown_field", `${label} contains unsupported field: ${unknown}`);
}

function requirePlainObject(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
    (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)) {
    throw bindingError("task_material_binding_invalid", `${label} must be a plain object`);
  }
}

function requiredToken(value, field, maxLength) {
  const text = String(value || "").trim();
  if (!text || text.length > maxLength || !SAFE_TOKEN_PATTERN.test(text)) {
    throw bindingError("task_material_binding_reference_invalid", `${field} must be a bounded opaque reference`);
  }
  return text;
}

function optionalToken(value, field, maxLength) {
  if (value === undefined || value === null || value === "") return null;
  return requiredToken(value, field, maxLength);
}

function requiredDigest(value, field) {
  const text = String(value || "").trim().toLowerCase();
  if (!DIGEST_PATTERN.test(text)) throw bindingError("task_material_binding_digest_invalid", `${field} must be a SHA-256 digest`);
  return text;
}

function requiredTimestamp(value, field) {
  const timestamp = new Date(value);
  if (!value || !Number.isFinite(timestamp.getTime())) {
    throw bindingError("task_material_binding_timestamp_invalid", `${field} must be an ISO timestamp`);
  }
  return timestamp.toISOString();
}

function digestCanonical(value) {
  return crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  Object.values(value).forEach(deepFreeze);
  return Object.freeze(value);
}

function bindingError(code, message = code) {
  const error = new Error(message);
  error.code = code;
  return error;
}

export {
  taskMaterialBindingsRequireSourceAccess,
  DEVICE_WORKSPACE_INPUT_ADAPTER_ID,
  DEVICE_WORKSPACE_INPUT_PAYLOAD_VERSION,
  PREDECESSOR_TASK_INPUT_ADAPTER_ID,
  TASK_MATERIAL_BINDING_CONTRACT_VERSION,
  TASK_MATERIAL_BINDING_DESCRIPTOR_VERSION,
  TASK_MATERIAL_BINDING_SET_CONTRACT_VERSION,
  createTaskMaterialBinding,
  createTaskMaterialBindingSet,
  createDeviceWorkspaceInputMaterialBindingDescriptor,
  createPredecessorTaskMaterialBindingDescriptor,
  normalizeMaterialBindingDescriptors,
  normalizeTaskMaterialBinding,
  normalizeTaskMaterialBindingSet,
  normalizeTaskMaterialBindingDescriptor,
  taskMaterialBindingDescriptorDigest,
  taskMaterialBindingSetDescriptorDigest,
};
