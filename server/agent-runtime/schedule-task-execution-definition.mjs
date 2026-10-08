import crypto from "node:crypto";
import {
  normalizeScheduleTaskInputRetentionDefinition,
} from "./schedule-task-input-retention-contract.mjs";

const CONTRACT_VERSION_V1 = "schedule-task-execution-definition.v1";
const CONTRACT_VERSION_V2 = "schedule-task-execution-definition.v2";
const CONTRACT_VERSION_V3 = "schedule-task-execution-definition.v3";
const INPUT_CONTRACT_VERSION_V3 = "schedule-task-input-contract.v3";
const INPUT_CONTRACT_VERSION_V1 = "schedule-task-input-contract.v1";
const INPUT_CONTRACT_VERSION_V2 = "schedule-task-input-contract.v2";
const PROVIDER_POLICY_VERSION = "schedule-task-provider-request-policy.v1";
const DEFINITION_FIELDS = new Set([
  "contractVersion", "executionMode", "inputContract", "providerRequestPolicy",
  "resultContractDigest", "systemInstruction", "taskDefinitionId", "taskDefinitionVersion",
  "taskInstruction",
]);
const AGENT_DEFINITION_FIELDS = new Set([
  "contractVersion", "executionMode", "inputContract", "resultContractDigest",
  "skillPolicyRef", "toolPolicyRef", "taskDefinitionId", "taskDefinitionVersion", "taskInstruction",
]);
const INPUT_CONTRACT_FIELDS = new Set([
  "contractVersion", "inputContractId", "inputContractVersion", "maxItems",
  "maxPayloadBytes", "retrievalMode", "sourceAdapterId", "sourceBindingDigest",
]);
const INPUT_CONTRACT_V2_FIELDS = new Set([...INPUT_CONTRACT_FIELDS, "retentionDefinition"]);
const PROVIDER_POLICY_FIELDS = new Set([
  "contractVersion", "maxInputBytes", "maxOutputTokens", "responseMode", "store",
  "toolAccess", "writeback",
]);
const TOKEN = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,159}$/;
const DIGEST = /^[a-f0-9]{64}$/;

export function normalizeScheduleTaskExecutionDefinition(value = {}) {
  if (value?.contractVersion === CONTRACT_VERSION_V3) return normalizeScheduleAgentTaskDefinition(value);
  exactObject(value, DEFINITION_FIELDS, "schedule_task_execution_definition_invalid");
  if (![CONTRACT_VERSION_V1, CONTRACT_VERSION_V2].includes(value.contractVersion)) {
    throw definitionError("schedule_task_execution_definition_contract_invalid");
  }
  const providerRequestPolicy = normalizeProviderRequestPolicy(value.providerRequestPolicy);
  const executionMode = token(value.executionMode, "executionMode");
  if (executionMode !== "single_provider_structured_result") {
    throw definitionError("schedule_task_execution_mode_invalid");
  }
  const inputContract = normalizeScheduleTaskInputContract(value.inputContract);
  if ((value.contractVersion === CONTRACT_VERSION_V1 &&
      inputContract.contractVersion !== INPUT_CONTRACT_VERSION_V1) ||
    (value.contractVersion === CONTRACT_VERSION_V2 &&
      inputContract.contractVersion !== INPUT_CONTRACT_VERSION_V2)) {
    throw definitionError("schedule_task_execution_definition_contract_invalid");
  }
  return deepFreeze({
    contractVersion: value.contractVersion,
    taskDefinitionId: token(value.taskDefinitionId, "taskDefinitionId"),
    taskDefinitionVersion: positiveInteger(value.taskDefinitionVersion, "taskDefinitionVersion"),
    executionMode,
    systemInstruction: boundedText(value.systemInstruction, "systemInstruction", 8 * 1024),
    taskInstruction: boundedText(value.taskInstruction, "taskInstruction", 16 * 1024),
    inputContract,
    resultContractDigest: digest(value.resultContractDigest, "resultContractDigest"),
    providerRequestPolicy,
  });
}

// This profile declares immutable inputs, not execution permission. Activation and every
// Runtime Tool call must independently resolve and authorize the referenced policies.
export function normalizeScheduleAgentTaskDefinition(value = {}) {
  exactObject(value, AGENT_DEFINITION_FIELDS, "schedule_task_execution_definition_invalid");
  if (value.contractVersion !== CONTRACT_VERSION_V3 || value.executionMode !== "shared_agent_runtime") {
    throw definitionError("schedule_task_execution_definition_contract_invalid");
  }
  const inputContract = normalizeScheduleTaskInputContract(value.inputContract);
  if (inputContract.contractVersion !== INPUT_CONTRACT_VERSION_V3) {
    throw definitionError("schedule_task_agent_input_contract_invalid");
  }
  return deepFreeze({
    contractVersion: CONTRACT_VERSION_V3,
    taskDefinitionId: token(value.taskDefinitionId, "taskDefinitionId"),
    taskDefinitionVersion: positiveInteger(value.taskDefinitionVersion, "taskDefinitionVersion"),
    executionMode: "shared_agent_runtime",
    taskInstruction: boundedText(value.taskInstruction, "taskInstruction", 16 * 1024),
    inputContract,
    skillPolicyRef: policyReference(value.skillPolicyRef, "skill-policy"),
    toolPolicyRef: policyReference(value.toolPolicyRef, "tool-policy"),
    resultContractDigest: digest(value.resultContractDigest, "resultContractDigest"),
  });
}

// Called only after tenant-scoped immutable repository resolution. This validates
// input provenance, not activation, current dependency authority or Tool access.
export function requireScheduleTaskInputAuthority(taskResolution, {
  tenantScope, resolveSourceBinding,
} = {}) {
  if (!taskResolution) return null;
  const definition = normalizeScheduleTaskExecutionDefinition(taskResolution.definition);
  if (definition.contractVersion === CONTRACT_VERSION_V3) return taskResolution;
  if (typeof resolveSourceBinding !== "function") {
    throw definitionError("schedule_task_source_binding_resolver_required");
  }
  const sourceResolution = resolveSourceBinding({
    tenantScope,
    sourceAdapterId: definition.inputContract.sourceAdapterId,
    sourceBindingDigest: definition.inputContract.sourceBindingDigest,
    taskDefinitionId: definition.taskDefinitionId,
    taskDefinitionVersion: definition.taskDefinitionVersion,
  });
  if (!sourceResolution) return null;
  const sourcePublishedAt = Date.parse(sourceResolution.binding?.publishedAt);
  const definitionPublishedAt = Date.parse(taskResolution.publishedAt);
  if (!Number.isFinite(sourcePublishedAt) || !Number.isFinite(definitionPublishedAt) ||
    sourcePublishedAt > definitionPublishedAt) {
    throw definitionError("schedule_task_source_binding_publication_order_invalid");
  }
  return taskResolution;
}

export function normalizeScheduleTaskExecutionDefinitionV2(value = {}) {
  const definition = normalizeScheduleTaskExecutionDefinition(value);
  if (definition.contractVersion !== CONTRACT_VERSION_V2 ||
    definition.inputContract.contractVersion !== INPUT_CONTRACT_VERSION_V2) {
    throw definitionError("schedule_task_execution_definition_retention_required");
  }
  return definition;
}

export function projectScheduleTaskExecutionDefinitionSafe({
  definition,
  executionContractDigest,
  publishedAt,
} = {}) {
  const normalized = normalizeScheduleTaskExecutionDefinition(definition);
  return deepFreeze({
    contractVersion: "schedule-task-execution-definition-safe.v1",
    taskDefinitionId: normalized.taskDefinitionId,
    taskDefinitionVersion: normalized.taskDefinitionVersion,
    executionMode: normalized.executionMode,
    inputContractDigest: scheduleTaskInputContractDigest(normalized.inputContract),
    resultContractDigest: normalized.resultContractDigest,
    executionContractDigest: digest(executionContractDigest, "executionContractDigest"),
    publishedAt: timestamp(publishedAt, "publishedAt"),
  });
}

export function normalizeScheduleTaskInputContract(value = {}) {
  const version = value?.contractVersion;
  if (version === INPUT_CONTRACT_VERSION_V3) {
    exactObject(value, new Set(["contractVersion", "retrievalMode"]), "schedule_task_input_contract_invalid");
    if (value.retrievalMode !== "schedule_context") throw definitionError("schedule_task_input_contract_invalid");
    // Scheduled time and timezone come from the authenticated activation/run, never a
    // personal conversation or a caller-selected business-material acquisition adapter.
    return deepFreeze({ contractVersion: version, retrievalMode: "schedule_context" });
  }
  const fields = version === INPUT_CONTRACT_VERSION_V2
    ? INPUT_CONTRACT_V2_FIELDS
    : INPUT_CONTRACT_FIELDS;
  exactObject(value, fields, "schedule_task_input_contract_invalid");
  const retrievalMode = token(value.retrievalMode, "retrievalMode");
  if (![INPUT_CONTRACT_VERSION_V1, INPUT_CONTRACT_VERSION_V2].includes(version) ||
    retrievalMode !== "snapshot_at_execution") {
    throw definitionError("schedule_task_input_contract_invalid");
  }
  const normalized = {
    contractVersion: version,
    inputContractId: token(value.inputContractId, "inputContractId"),
    inputContractVersion: positiveInteger(value.inputContractVersion, "inputContractVersion"),
    sourceAdapterId: token(value.sourceAdapterId, "sourceAdapterId"),
    sourceBindingDigest: digest(value.sourceBindingDigest, "sourceBindingDigest"),
    retrievalMode,
    maxItems: boundedInteger(value.maxItems, 1, 1000, "maxItems"),
    maxPayloadBytes: boundedInteger(value.maxPayloadBytes, 1, 1024 * 1024, "maxPayloadBytes"),
  };
  if (version === INPUT_CONTRACT_VERSION_V2) {
    normalized.retentionDefinition = normalizeScheduleTaskInputRetentionDefinition(
      value.retentionDefinition,
    );
  }
  return deepFreeze(normalized);
}

export function scheduleTaskInputContractDigest(value = {}) {
  const normalized = normalizeScheduleTaskInputContract(value);
  return crypto.createHash("sha256").update(canonicalJson({
    contractVersion: "schedule-task-input-contract-digest.v1",
    inputContract: normalized,
  })).digest("hex");
}

function normalizeProviderRequestPolicy(value) {
  exactObject(value, PROVIDER_POLICY_FIELDS, "schedule_task_provider_policy_invalid");
  const normalized = {
    contractVersion: value.contractVersion,
    maxInputBytes: boundedInteger(value.maxInputBytes, 1, 1024 * 1024, "maxInputBytes"),
    maxOutputTokens: boundedInteger(value.maxOutputTokens, 16, 16_384, "maxOutputTokens"),
    responseMode: value.responseMode,
    store: value.store,
    toolAccess: value.toolAccess,
    writeback: value.writeback,
  };
  if (normalized.contractVersion !== PROVIDER_POLICY_VERSION ||
    normalized.responseMode !== "structured_result" || normalized.store !== false ||
    normalized.toolAccess !== "none" || normalized.writeback !== "none") {
    throw definitionError("schedule_task_provider_policy_invalid");
  }
  return deepFreeze(normalized);
}

function policyReference(value, prefix) {
  if (typeof value !== "string" || value.length > 240 ||
    !new RegExp(`^${prefix}:[A-Za-z0-9][A-Za-z0-9._:-]{0,119}@[A-Za-z0-9][A-Za-z0-9._:-]{0,79}$`).test(value)) {
    throw definitionError("schedule_task_agent_policy_reference_invalid");
  }
  return value;
}

function exactObject(value, fields, code) {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype) {
    throw definitionError(code);
  }
  const keys = Object.keys(value);
  if (keys.length !== fields.size || keys.some((key) => !fields.has(key))) {
    throw definitionError(code);
  }
}

function token(value, field) {
  const result = String(value || "").trim();
  if (!TOKEN.test(result) || /@[^/]+\.[A-Za-z]{2,}$/.test(result)) {
    throw definitionError("schedule_task_execution_token_invalid", field);
  }
  return result;
}

function boundedText(value, field, maxBytes) {
  const result = typeof value === "string" ? value.trim() : "";
  if (!result || result.includes("\0") || Buffer.byteLength(result, "utf8") > maxBytes) {
    throw definitionError("schedule_task_execution_text_invalid", field);
  }
  return result;
}

function digest(value, field) {
  const result = String(value || "").trim().toLowerCase();
  if (!DIGEST.test(result)) throw definitionError("schedule_task_execution_digest_invalid", field);
  return result;
}

function positiveInteger(value, field) {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw definitionError("schedule_task_execution_number_invalid", field);
  }
  return value;
}

function boundedInteger(value, minimum, maximum, field) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw definitionError("schedule_task_execution_number_invalid", field);
  }
  return value;
}

function timestamp(value, field) {
  const result = String(value || "").trim();
  const parsed = new Date(result);
  if (!result || !Number.isFinite(parsed.getTime()) || parsed.toISOString() !== result) {
    throw definitionError("schedule_task_execution_timestamp_invalid", field);
  }
  return result;
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) =>
      `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  const result = JSON.stringify(value);
  if (result === undefined) throw definitionError("schedule_task_execution_value_invalid");
  return result;
}

function deepFreeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    Object.values(value).forEach(deepFreeze);
  }
  return value;
}

function definitionError(code, detail = "") {
  const error = new Error(detail ? `${code}: ${detail}` : code);
  error.code = code;
  return error;
}

export {
  CONTRACT_VERSION_V1 as SCHEDULE_TASK_EXECUTION_DEFINITION_CONTRACT_VERSION,
  CONTRACT_VERSION_V2 as SCHEDULE_TASK_EXECUTION_DEFINITION_V2_CONTRACT_VERSION,
  CONTRACT_VERSION_V3 as SCHEDULE_TASK_EXECUTION_DEFINITION_V3_CONTRACT_VERSION,
  INPUT_CONTRACT_VERSION_V3 as SCHEDULE_TASK_INPUT_CONTRACT_V3_VERSION,
  INPUT_CONTRACT_VERSION_V1 as SCHEDULE_TASK_INPUT_CONTRACT_VERSION,
  INPUT_CONTRACT_VERSION_V2 as SCHEDULE_TASK_INPUT_CONTRACT_V2_VERSION,
  PROVIDER_POLICY_VERSION as SCHEDULE_TASK_PROVIDER_REQUEST_POLICY_CONTRACT_VERSION,
  definitionError as scheduleTaskExecutionDefinitionError,
};
