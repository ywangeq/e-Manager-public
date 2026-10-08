import crypto from "node:crypto";

const SCHEDULE_RESULT_CONTRACT_VERSION = "schedule-result-contract.v1";
const SCHEDULE_STRUCTURED_RESULT_VERSION = "schedule-structured-result.v1";
const SCHEDULE_PARSED_RESULT_VERSION = "schedule-parsed-result.v1";
const SCHEDULE_RESULT_SAFE_SUMMARY_VERSION = "schedule-result-safe-summary.v1";
const CONTRACT_BODY_FIELDS = new Set([
  "contractVersion",
  "envelopeVersion",
  "outcomeRules",
  "payloadSchema",
  "resultContractId",
  "resultContractVersion",
  "resultType",
  "schemaVersion",
]);
const CONTRACT_FIELDS = new Set([...CONTRACT_BODY_FIELDS, "contractDigest"]);
const ENVELOPE_FIELDS = new Set([
  "contractVersion",
  "outcomeCode",
  "payload",
  "resultContractDigest",
  "resultContractId",
  "resultContractVersion",
  "resultType",
  "schemaVersion",
]);
const PARSED_RESULT_FIELDS = new Set([
  "contractVersion",
  "payload",
  "payloadBoundary",
  "resultContractDigest",
  "resultContractId",
  "resultContractVersion",
  "resultType",
  "safeSummary",
  "schemaVersion",
]);
const SAFE_SUMMARY_FIELDS = new Set(["outcomeCode", "severityCode", "summaryCode"]);
const OUTCOME_RULE_FIELDS = new Set(["outcomeCode", "severityCode", "summaryCode"]);
const SCHEMA_FIELDS = Object.freeze({
  array: new Set(["items", "maxItems", "minItems", "type"]),
  boolean: new Set(["type"]),
  integer: new Set(["maximum", "minimum", "type"]),
  number: new Set(["maximum", "minimum", "type"]),
  object: new Set(["additionalProperties", "properties", "required", "type"]),
  string: new Set(["enum", "maxLength", "minLength", "type"]),
});
const SCHEMA_TYPES = new Set(Object.keys(SCHEMA_FIELDS));
const SEVERITY_CODES = new Set(["info", "low", "medium", "high", "critical"]);
const TOKEN_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,159}$/;
const PROPERTY_PATTERN = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;
const SENSITIVE_PROPERTY_PATTERN = /(?:prompt|credential|secret|token|header|endpoint|raw_?output|raw_?prompt|password|api_?key)/i;
const MAX_SCHEMA_DEPTH = 8;
const MAX_SCHEMA_PROPERTIES = 128;
const MAX_ARRAY_ITEMS = 1_000;
const MAX_STRING_LENGTH = 4_000;
const MAX_ENUM_VALUES = 100;
const MAX_OUTCOME_RULES = 100;
const MAX_RESULT_BYTES = 64 * 1024;
const EMAIL_PATTERN = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const SECRET_PATTERN = /^(?:bearer\s+|sk-[a-z0-9_-]{8,}|rk-[a-z0-9_-]{8,}|xox[baprs]-|gh[pousr]_|glpat-|ya29\.|eyJ[A-Za-z0-9_-]{8,})/i;

function createScheduleResultContract(value = {}) {
  exactObject(value, CONTRACT_BODY_FIELDS, "schedule_result_contract_fields_invalid");
  const body = normalizeContractBody(value);
  return deepFreeze({ ...body, contractDigest: digestCanonical(body) });
}

function normalizeScheduleResultContract(value = {}) {
  exactObject(value, CONTRACT_FIELDS, "schedule_result_contract_fields_invalid");
  const { contractDigest, ...candidate } = value;
  const body = normalizeContractBody(candidate);
  const expectedDigest = digestCanonical(body);
  if (!/^[a-f0-9]{64}$/.test(String(contractDigest || ""))) {
    throw resultContractError("schedule_result_contract_digest_invalid");
  }
  if (contractDigest !== expectedDigest) throw resultContractError("schedule_result_contract_digest_mismatch");
  return deepFreeze({ ...body, contractDigest: expectedDigest });
}

function compileScheduleResultContract(value) {
  const contract = normalizeScheduleResultContract(value);
  const outcomeRules = new Map(contract.outcomeRules.map((rule) => [rule.outcomeCode, rule]));
  return Object.freeze({
    contract,
    parse: (candidate) => parseWithCompiledContract(contract, outcomeRules, candidate),
  });
}

function parseScheduleResult(contract, candidate) {
  return compileScheduleResultContract(contract).parse(candidate);
}

function projectScheduleResultSafeSummary(contractValue, value) {
  const contract = normalizeScheduleResultContract(contractValue);
  exactObject(value, PARSED_RESULT_FIELDS, "schedule_parsed_result_invalid");
  exactObject(value.safeSummary, SAFE_SUMMARY_FIELDS, "schedule_parsed_result_invalid");
  if (value.contractVersion !== SCHEDULE_PARSED_RESULT_VERSION || value.payloadBoundary !== "internal_only") {
    throw resultContractError("schedule_parsed_result_invalid");
  }
  const outcomeRule = contract.outcomeRules.find((rule) => rule.outcomeCode === value.safeSummary.outcomeCode);
  if (value.resultContractId !== contract.resultContractId ||
    value.resultContractVersion !== contract.resultContractVersion ||
    value.resultContractDigest !== contract.contractDigest ||
    value.resultType !== contract.resultType || value.schemaVersion !== contract.schemaVersion ||
    !outcomeRule || outcomeRule.severityCode !== value.safeSummary.severityCode ||
    outcomeRule.summaryCode !== value.safeSummary.summaryCode) {
    throw resultContractError("schedule_parsed_result_binding_mismatch");
  }
  return deepFreeze({
    contractVersion: SCHEDULE_RESULT_SAFE_SUMMARY_VERSION,
    resultContractId: contract.resultContractId,
    resultContractVersion: contract.resultContractVersion,
    resultContractDigest: contract.contractDigest,
    resultType: contract.resultType,
    schemaVersion: contract.schemaVersion,
    outcomeCode: outcomeRule.outcomeCode,
    severityCode: outcomeRule.severityCode,
    summaryCode: outcomeRule.summaryCode,
  });
}

function normalizeContractBody(value) {
  if (value.contractVersion !== SCHEDULE_RESULT_CONTRACT_VERSION ||
    value.envelopeVersion !== SCHEDULE_STRUCTURED_RESULT_VERSION) {
    throw resultContractError("schedule_result_contract_version_invalid");
  }
  const budget = { properties: 0 };
  return deepFreeze({
    contractVersion: SCHEDULE_RESULT_CONTRACT_VERSION,
    resultContractId: token(value.resultContractId),
    resultContractVersion: positiveInteger(value.resultContractVersion),
    envelopeVersion: SCHEDULE_STRUCTURED_RESULT_VERSION,
    resultType: token(value.resultType),
    schemaVersion: token(value.schemaVersion),
    payloadSchema: normalizeSchema(value.payloadSchema, { budget, depth: 1 }),
    outcomeRules: normalizeOutcomeRules(value.outcomeRules),
  });
}

function normalizeOutcomeRules(value) {
  if (!Array.isArray(value) || value.length < 1 || value.length > MAX_OUTCOME_RULES) {
    throw resultContractError("schedule_result_contract_outcome_rules_invalid");
  }
  const seen = new Set();
  const rules = value.map((rule) => {
    exactObject(rule, OUTCOME_RULE_FIELDS, "schedule_result_contract_outcome_rules_invalid");
    const outcomeCode = token(rule.outcomeCode);
    if (seen.has(outcomeCode) || !SEVERITY_CODES.has(rule.severityCode)) {
      throw resultContractError("schedule_result_contract_outcome_rules_invalid");
    }
    seen.add(outcomeCode);
    return {
      outcomeCode,
      severityCode: rule.severityCode,
      summaryCode: token(rule.summaryCode),
    };
  });
  return rules.sort((left, right) => left.outcomeCode.localeCompare(right.outcomeCode));
}

function normalizeSchema(value, { budget, depth }) {
  if (depth > MAX_SCHEMA_DEPTH || !plainObject(value) || !SCHEMA_TYPES.has(value.type)) {
    throw resultContractError("schedule_result_contract_schema_invalid");
  }
  const fields = value.type === "string" && value.enum === undefined
    ? new Set(["maxLength", "minLength", "type"])
    : SCHEMA_FIELDS[value.type];
  exactObject(value, fields, "schedule_result_contract_schema_invalid");
  if (value.type === "object") return normalizeObjectSchema(value, { budget, depth });
  if (value.type === "array") return normalizeArraySchema(value, { budget, depth });
  if (value.type === "string") return normalizeStringSchema(value);
  if (value.type === "integer" || value.type === "number") return normalizeNumberSchema(value);
  return Object.freeze({ type: "boolean" });
}

function normalizeObjectSchema(value, { budget, depth }) {
  if (value.additionalProperties !== false || !plainObject(value.properties) || !Array.isArray(value.required)) {
    throw resultContractError("schedule_result_contract_schema_invalid");
  }
  const propertyNames = Object.keys(value.properties).sort();
  if (propertyNames.length < 1 || propertyNames.some((name) => !safePropertyName(name))) {
    throw resultContractError("schedule_result_contract_schema_invalid");
  }
  budget.properties += propertyNames.length;
  if (budget.properties > MAX_SCHEMA_PROPERTIES) throw resultContractError("schedule_result_contract_schema_invalid");
  const required = [...value.required];
  if (required.some((name) => typeof name !== "string" || !propertyNames.includes(name)) ||
    new Set(required).size !== required.length) {
    throw resultContractError("schedule_result_contract_schema_invalid");
  }
  const properties = Object.fromEntries(propertyNames.map((name) => [
    name,
    normalizeSchema(value.properties[name], { budget, depth: depth + 1 }),
  ]));
  return deepFreeze({
    type: "object",
    properties,
    required: required.sort(),
    additionalProperties: false,
  });
}

function normalizeArraySchema(value, { budget, depth }) {
  const minItems = boundedInteger(value.minItems, 0, MAX_ARRAY_ITEMS);
  const maxItems = boundedInteger(value.maxItems, 0, MAX_ARRAY_ITEMS);
  if (minItems > maxItems) throw resultContractError("schedule_result_contract_schema_invalid");
  return deepFreeze({
    type: "array",
    items: normalizeSchema(value.items, { budget, depth: depth + 1 }),
    minItems,
    maxItems,
  });
}

function normalizeStringSchema(value) {
  const minLength = boundedInteger(value.minLength, 0, MAX_STRING_LENGTH);
  const maxLength = boundedInteger(value.maxLength, 1, MAX_STRING_LENGTH);
  if (minLength > maxLength) throw resultContractError("schedule_result_contract_schema_invalid");
  const normalized = { type: "string", minLength, maxLength };
  if (value.enum !== undefined) {
    if (!Array.isArray(value.enum) || value.enum.length < 1 || value.enum.length > MAX_ENUM_VALUES ||
      value.enum.some((item) => typeof item !== "string" || item.length < minLength || item.length > maxLength || !safeCode(item)) ||
      new Set(value.enum).size !== value.enum.length) {
      throw resultContractError("schedule_result_contract_schema_invalid");
    }
    normalized.enum = [...value.enum].sort();
  }
  return deepFreeze(normalized);
}

function normalizeNumberSchema(value) {
  const minimum = finiteNumber(value.minimum);
  const maximum = finiteNumber(value.maximum);
  if (minimum > maximum || (value.type === "integer" && (!Number.isSafeInteger(minimum) || !Number.isSafeInteger(maximum)))) {
    throw resultContractError("schedule_result_contract_schema_invalid");
  }
  return Object.freeze({ type: value.type, minimum, maximum });
}

function parseWithCompiledContract(contract, outcomeRules, candidate) {
  exactObject(candidate, ENVELOPE_FIELDS, "schedule_result_envelope_invalid");
  if (candidate.contractVersion !== SCHEDULE_STRUCTURED_RESULT_VERSION) {
    throw resultContractError("schedule_result_envelope_invalid");
  }
  if (candidate.resultContractId !== contract.resultContractId ||
    candidate.resultContractVersion !== contract.resultContractVersion ||
    candidate.resultContractDigest !== contract.contractDigest) {
    throw resultContractError("schedule_result_contract_binding_mismatch");
  }
  if (candidate.resultType !== contract.resultType) throw resultContractError("schedule_result_type_mismatch");
  if (candidate.schemaVersion !== contract.schemaVersion) throw resultContractError("schedule_result_schema_version_mismatch");
  const rule = outcomeRules.get(candidate.outcomeCode);
  if (!rule) throw resultContractError("schedule_result_outcome_unknown");
  assertPayloadSize(candidate.payload);
  const payload = validatePayload(contract.payloadSchema, candidate.payload, 1);
  return deepFreeze({
    contractVersion: SCHEDULE_PARSED_RESULT_VERSION,
    resultContractId: contract.resultContractId,
    resultContractVersion: contract.resultContractVersion,
    resultContractDigest: contract.contractDigest,
    resultType: contract.resultType,
    schemaVersion: contract.schemaVersion,
    safeSummary: {
      outcomeCode: rule.outcomeCode,
      severityCode: rule.severityCode,
      summaryCode: rule.summaryCode,
    },
    payloadBoundary: "internal_only",
    payload,
  });
}

function validatePayload(schema, value, depth) {
  if (depth > MAX_SCHEMA_DEPTH) throw resultContractError("schedule_result_payload_invalid");
  if (schema.type === "object") {
    if (!plainObject(value)) throw resultContractError("schedule_result_payload_invalid");
    const keys = Object.keys(value);
    const propertyNames = Object.keys(schema.properties);
    if (keys.some((key) => !Object.hasOwn(schema.properties, key)) ||
      schema.required.some((key) => !Object.hasOwn(value, key))) {
      throw resultContractError("schedule_result_payload_invalid");
    }
    return Object.fromEntries(keys.sort().map((key) => [key, validatePayload(schema.properties[key], value[key], depth + 1)]));
  }
  if (schema.type === "array") {
    if (!Array.isArray(value) || value.length < schema.minItems || value.length > schema.maxItems) {
      throw resultContractError("schedule_result_payload_invalid");
    }
    return value.map((item) => validatePayload(schema.items, item, depth + 1));
  }
  if (schema.type === "string") {
    if (typeof value !== "string" || value.length < schema.minLength || value.length > schema.maxLength ||
      (schema.enum && !schema.enum.includes(value))) {
      throw resultContractError("schedule_result_payload_invalid");
    }
    return value;
  }
  if (schema.type === "integer") {
    if (!Number.isSafeInteger(value) || value < schema.minimum || value > schema.maximum) {
      throw resultContractError("schedule_result_payload_invalid");
    }
    return value;
  }
  if (schema.type === "number") {
    if (typeof value !== "number" || !Number.isFinite(value) || value < schema.minimum || value > schema.maximum) {
      throw resultContractError("schedule_result_payload_invalid");
    }
    return value;
  }
  if (typeof value !== "boolean") throw resultContractError("schedule_result_payload_invalid");
  return value;
}

function assertPayloadSize(value) {
  let serialized;
  try {
    serialized = JSON.stringify(value);
  } catch {
    throw resultContractError("schedule_result_payload_invalid");
  }
  if (typeof serialized !== "string" || Buffer.byteLength(serialized, "utf8") > MAX_RESULT_BYTES) {
    throw resultContractError("schedule_result_payload_too_large");
  }
}

function exactObject(value, fields, code) {
  if (!plainObject(value)) throw resultContractError(code);
  const keys = Object.keys(value);
  if (keys.length !== fields.size || keys.some((field) => !fields.has(field))) throw resultContractError(code);
}

function plainObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function token(value) {
  const normalized = String(value || "").trim();
  if (!safeCode(normalized)) throw resultContractError("schedule_result_contract_reference_invalid");
  return normalized;
}

function safeCode(value) {
  return TOKEN_PATTERN.test(value) && !EMAIL_PATTERN.test(value) && !SECRET_PATTERN.test(value);
}

function safePropertyName(value) {
  return PROPERTY_PATTERN.test(value) && !SENSITIVE_PROPERTY_PATTERN.test(value);
}

function positiveInteger(value) {
  const normalized = Number(value);
  if (!Number.isSafeInteger(normalized) || normalized < 1) {
    throw resultContractError("schedule_result_contract_version_number_invalid");
  }
  return normalized;
}

function boundedInteger(value, minimum, maximum) {
  const normalized = Number(value);
  if (!Number.isSafeInteger(normalized) || normalized < minimum || normalized > maximum) {
    throw resultContractError("schedule_result_contract_schema_invalid");
  }
  return normalized;
}

function finiteNumber(value) {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw resultContractError("schedule_result_contract_schema_invalid");
  }
  return value;
}

function digestCanonical(value) {
  return crypto.createHash("sha256").update(JSON.stringify(sortCanonical(value))).digest("hex");
}

function sortCanonical(value) {
  if (Array.isArray(value)) return value.map(sortCanonical);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, sortCanonical(value[key])]));
}

function deepFreeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    Object.values(value).forEach(deepFreeze);
  }
  return value;
}

function resultContractError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

export {
  SCHEDULE_PARSED_RESULT_VERSION,
  SCHEDULE_RESULT_CONTRACT_VERSION,
  SCHEDULE_RESULT_SAFE_SUMMARY_VERSION,
  SCHEDULE_STRUCTURED_RESULT_VERSION,
  compileScheduleResultContract,
  createScheduleResultContract,
  normalizeScheduleResultContract,
  parseScheduleResult,
  projectScheduleResultSafeSummary,
};
