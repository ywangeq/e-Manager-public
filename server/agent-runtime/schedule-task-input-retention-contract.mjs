import crypto from "node:crypto";

const CONTRACT_VERSION = "schedule-task-input-retention-definition.v1";
const FIELDS = new Set([
  "contractVersion",
  "purgeGate",
  "purgeMode",
  "retentionDefinitionId",
  "retentionDefinitionVersion",
  "snapshotRetentionSeconds",
]);
const TOKEN = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,159}$/;

function normalizeScheduleTaskInputRetentionDefinition(value = {}) {
  exactObject(value);
  const normalized = {
    contractVersion: value.contractVersion,
    retentionDefinitionId: token(value.retentionDefinitionId),
    retentionDefinitionVersion: positiveInteger(value.retentionDefinitionVersion),
    snapshotRetentionSeconds: boundedInteger(value.snapshotRetentionSeconds, 60, 365 * 24 * 60 * 60),
    purgeGate: value.purgeGate,
    purgeMode: value.purgeMode,
  };
  if (normalized.contractVersion !== CONTRACT_VERSION ||
    normalized.purgeGate !== "canonical_terminal_and_control_converged" ||
    normalized.purgeMode !== "delete_encrypted_snapshot") {
    throw retentionError("schedule_task_input_retention_definition_invalid");
  }
  return deepFreeze(normalized);
}

function scheduleTaskInputRetentionDefinitionDigest(value = {}) {
  const normalized = normalizeScheduleTaskInputRetentionDefinition(value);
  return crypto.createHash("sha256").update(canonicalJson({
    contractVersion: "schedule-task-input-retention-definition-digest.v1",
    retentionDefinition: normalized,
  })).digest("hex");
}

function exactObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype) {
    throw retentionError("schedule_task_input_retention_definition_invalid");
  }
  const keys = Object.keys(value);
  if (keys.length !== FIELDS.size || keys.some((key) => !FIELDS.has(key))) {
    throw retentionError("schedule_task_input_retention_definition_invalid");
  }
}

function token(value) {
  const result = String(value || "").trim();
  if (!TOKEN.test(result) || /@[^/]+\.[A-Za-z]{2,}$/.test(result)) {
    throw retentionError("schedule_task_input_retention_reference_invalid");
  }
  return result;
}

function positiveInteger(value) {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw retentionError("schedule_task_input_retention_number_invalid");
  }
  return value;
}

function boundedInteger(value, minimum, maximum) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw retentionError("schedule_task_input_retention_number_invalid");
  }
  return value;
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) =>
      `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  const result = JSON.stringify(Object.is(value, -0) ? 0 : value);
  if (result === undefined) throw retentionError("schedule_task_input_retention_value_invalid");
  return result;
}

function deepFreeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    Object.values(value).forEach(deepFreeze);
  }
  return value;
}

function retentionError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

export {
  CONTRACT_VERSION as SCHEDULE_TASK_INPUT_RETENTION_DEFINITION_CONTRACT_VERSION,
  normalizeScheduleTaskInputRetentionDefinition,
  scheduleTaskInputRetentionDefinitionDigest,
};
