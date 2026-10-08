import crypto from "node:crypto";

const CONTRACT_VERSION = "schedule-task-source-binding.v1";
const CATALOG_VERSION = "versioned-schedule-task-source-binding-catalog.v1";
const RESOLUTION_VERSION = "schedule-task-source-binding-resolution.v1";
const BINDING_FIELDS = new Set([
  "contractVersion",
  "publishedAt",
  "resourceKind",
  "selectionMode",
  "snapshotContractVersion",
  "sourceAdapterId",
  "sourceBindingId",
  "sourceBindingVersion",
  "sourceSystemId",
  "taskDefinitionId",
  "taskDefinitionVersion",
]);
const EXACT_REQUEST_FIELDS = new Set([
  "sourceAdapterId",
  "sourceBindingDigest",
  "taskDefinitionId",
  "taskDefinitionVersion",
  "tenantScope",
]);
const VERSION_REQUEST_FIELDS = new Set([
  "sourceBindingId",
  "sourceBindingVersion",
  "tenantScope",
]);
const TOKEN = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,159}$/;
const DIGEST = /^[a-f0-9]{64}$/;

function createVersionedScheduleTaskSourceBindingCatalog({
  bindings = [],
  stableIntegrityHmacKey,
  tenantScope,
} = {}) {
  if (!Array.isArray(bindings)) throw sourceError("schedule_task_source_binding_catalog_invalid");
  const configuredTenant = token(tenantScope, "tenantScope");
  const integrityKey = exactKey(stableIntegrityHmacKey);
  const byVersion = new Map();
  const byDigest = new Map();
  for (const value of bindings) {
    const binding = normalizeScheduleTaskSourceBinding(value);
    const sourceBindingDigest = bindingDigest(integrityKey, configuredTenant, binding);
    const versionKey = logicalKey(binding.sourceBindingId, binding.sourceBindingVersion);
    if (byVersion.has(versionKey) || byDigest.has(sourceBindingDigest)) {
      throw sourceError("schedule_task_source_binding_catalog_duplicate");
    }
    const resolution = deepFreeze({
      contractVersion: RESOLUTION_VERSION,
      sourceBindingDigest,
      binding,
      payloadBoundary: "internal_only",
    });
    byVersion.set(versionKey, resolution);
    byDigest.set(sourceBindingDigest, resolution);
  }

  function resolveVersion(value = {}) {
    exactObject(value, VERSION_REQUEST_FIELDS, "schedule_task_source_binding_request_invalid");
    const requestTenant = token(value.tenantScope, "tenantScope");
    const sourceBindingId = token(value.sourceBindingId, "sourceBindingId");
    const sourceBindingVersion = positiveInteger(value.sourceBindingVersion, "sourceBindingVersion");
    if (requestTenant !== configuredTenant) return null;
    return byVersion.get(logicalKey(sourceBindingId, sourceBindingVersion)) || null;
  }

  function resolveExact(value = {}) {
    exactObject(value, EXACT_REQUEST_FIELDS, "schedule_task_source_binding_request_invalid");
    const requestTenant = token(value.tenantScope, "tenantScope");
    const sourceBindingDigest = digest(value.sourceBindingDigest, "sourceBindingDigest");
    const sourceAdapterId = token(value.sourceAdapterId, "sourceAdapterId");
    const taskDefinitionId = token(value.taskDefinitionId, "taskDefinitionId");
    const taskDefinitionVersion = positiveInteger(value.taskDefinitionVersion, "taskDefinitionVersion");
    if (requestTenant !== configuredTenant) return null;
    const resolution = byDigest.get(sourceBindingDigest) || null;
    if (!resolution) return null;
    if (resolution.binding.sourceAdapterId !== sourceAdapterId ||
      resolution.binding.taskDefinitionId !== taskDefinitionId ||
      resolution.binding.taskDefinitionVersion !== taskDefinitionVersion) {
      throw sourceError("schedule_task_source_binding_mismatch");
    }
    return resolution;
  }

  return Object.freeze({
    contractVersion: CATALOG_VERSION,
    resolveExact,
    resolveVersion,
  });
}

function normalizeScheduleTaskSourceBinding(value = {}) {
  exactObject(value, BINDING_FIELDS, "schedule_task_source_binding_invalid");
  if (value.contractVersion !== CONTRACT_VERSION ||
    value.selectionMode !== "current_authorized_scope") {
    throw sourceError("schedule_task_source_binding_invalid");
  }
  return deepFreeze({
    contractVersion: CONTRACT_VERSION,
    sourceBindingId: token(value.sourceBindingId, "sourceBindingId"),
    sourceBindingVersion: positiveInteger(value.sourceBindingVersion, "sourceBindingVersion"),
    sourceAdapterId: token(value.sourceAdapterId, "sourceAdapterId"),
    sourceSystemId: token(value.sourceSystemId, "sourceSystemId"),
    taskDefinitionId: token(value.taskDefinitionId, "taskDefinitionId"),
    taskDefinitionVersion: positiveInteger(value.taskDefinitionVersion, "taskDefinitionVersion"),
    resourceKind: token(value.resourceKind, "resourceKind"),
    selectionMode: "current_authorized_scope",
    snapshotContractVersion: token(value.snapshotContractVersion, "snapshotContractVersion"),
    publishedAt: timestamp(value.publishedAt, "publishedAt"),
  });
}

function bindingDigest(key, tenantScope, binding) {
  return crypto.createHmac("sha256", key).update(JSON.stringify(sortCanonical({
    contractVersion: "schedule-task-source-binding-digest.v1",
    tenantScope,
    binding,
  }))).digest("hex");
}

function logicalKey(sourceBindingId, sourceBindingVersion) {
  return `${sourceBindingId}\0${String(sourceBindingVersion).padStart(16, "0")}`;
}

function exactObject(value, fields, code) {
  if (!plainObject(value)) throw sourceError(code);
  const keys = Object.keys(value);
  if (keys.length !== fields.size || keys.some((key) => !fields.has(key))) throw sourceError(code);
}

function plainObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function token(value, field) {
  const result = String(value || "").trim();
  if (!TOKEN.test(result) || /@[^/]+\.[A-Za-z]{2,}$/.test(result)) {
    throw sourceError("schedule_task_source_binding_reference_invalid", field);
  }
  return result;
}

function digest(value, field) {
  const result = String(value || "").trim().toLowerCase();
  if (!DIGEST.test(result)) throw sourceError("schedule_task_source_binding_digest_invalid", field);
  return result;
}

function positiveInteger(value, field) {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw sourceError("schedule_task_source_binding_number_invalid", field);
  }
  return value;
}

function timestamp(value, field) {
  const result = String(value || "").trim();
  const parsed = new Date(result);
  if (!result || !Number.isFinite(parsed.getTime()) || parsed.toISOString() !== result) {
    throw sourceError("schedule_task_source_binding_timestamp_invalid", field);
  }
  return result;
}

function exactKey(value) {
  const key = Buffer.isBuffer(value) ? Buffer.from(value) : Buffer.from(value || []);
  if (key.length !== 32) throw sourceError("schedule_task_source_binding_hmac_key_invalid");
  return key;
}

function sortCanonical(value) {
  if (Array.isArray(value)) return value.map(sortCanonical);
  if (!value || typeof value !== "object") return Object.is(value, -0) ? 0 : value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, sortCanonical(value[key])]));
}

function deepFreeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    Object.values(value).forEach(deepFreeze);
  }
  return value;
}

function sourceError(code, detail = "") {
  const error = new Error(detail ? `${code}: ${detail}` : code);
  error.code = code;
  return error;
}

export {
  CATALOG_VERSION as VERSIONED_SCHEDULE_TASK_SOURCE_BINDING_CATALOG_CONTRACT_VERSION,
  CONTRACT_VERSION as SCHEDULE_TASK_SOURCE_BINDING_CONTRACT_VERSION,
  RESOLUTION_VERSION as SCHEDULE_TASK_SOURCE_BINDING_RESOLUTION_CONTRACT_VERSION,
  createVersionedScheduleTaskSourceBindingCatalog,
  normalizeScheduleTaskSourceBinding,
};
