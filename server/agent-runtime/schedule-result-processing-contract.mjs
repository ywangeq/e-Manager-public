import crypto from "node:crypto";
import { normalizeScheduleResultContract } from "./schedule-result-contract.mjs";

const ALERT_VERSION = "schedule-result-alert-contract.v1";
const ALERT_V2_VERSION = "schedule-result-alert-contract.v2";
const RETENTION_VERSION = "schedule-result-retention-definition.v1";
const AUTHORITY_VERSION = "schedule-result-processing-authority.v1";
const BINDING_VERSION = "schedule-result-processing-binding.v1";
const ALERT_BODY_FIELDS = new Set([
  "alertContractId", "alertContractVersion", "contractVersion", "mode", "policyVersion", "rules",
]);
const ALERT_V2_BODY_FIELDS = new Set([...ALERT_BODY_FIELDS, "deliveryPolicy"]);
const ALERT_FIELDS = new Set([...ALERT_BODY_FIELDS, "alertContractDigest"]);
const ALERT_V2_FIELDS = new Set([...ALERT_V2_BODY_FIELDS, "alertContractDigest"]);
const RULE_FIELDS = new Set(["maxRecipients", "outcomeCodes", "recipientRole", "ruleId"]);
const DELIVERY_POLICY_FIELDS = new Set([
  "channelClass", "deliveryMode", "maxRenderedBytes", "presentationMode", "redactionMode",
  "releaseRule", "unknownOutcomeRule",
]);
const RETENTION_BODY_FIELDS = new Set([
  "contractVersion", "payloadRetentionSeconds", "retentionDefinitionId", "retentionDefinitionVersion",
]);
const RETENTION_FIELDS = new Set([...RETENTION_BODY_FIELDS, "retentionDefinitionDigest"]);
const AUTHORITY_FIELDS = new Set([
  "alertContractDigest", "contractVersion", "processingAuthorityDigest", "resultContractDigest",
  "retentionDefinitionDigest",
]);
const COMPOSE_FIELDS = new Set(["alertContract", "resultContract", "retentionDefinition"]);
const PROCESSING_COMPONENT_FIELDS = new Set([
  "alertContractDigest", "resultContractDigest", "retentionDefinitionDigest",
]);
const BINDING_FIELDS = new Set([
  ...PROCESSING_COMPONENT_FIELDS, "contractVersion", "processingAuthorityDigest",
]);
const TOKEN = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,159}$/;
const EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const SECRET = /^(?:bearer\s+|sk-|rk-|xox[baprs]-|gh[pousr]_|glpat-|ya29\.|eyJ)/i;
const DIGEST = /^[a-f0-9]{64}$/;
const MAX_RULES = 32;
const MAX_OUTCOMES_PER_RULE = 100;
const MAX_RECIPIENTS_PER_RULE = 32;
const MAX_RENDERED_BYTES = 16 * 1024;
const MAX_RETENTION_SECONDS = 365 * 24 * 60 * 60;
const RECIPIENT_ROLES = new Set(["business_owner"]);
const CHANNEL_CLASSES = new Set(["enterprise_notification"]);

export function createScheduleResultAlertContract(value = {}) {
  exactObject(value, alertFields(value?.contractVersion, false),
    "schedule_result_alert_contract_fields_invalid");
  const body = normalizeAlertBody(value);
  return deepFreeze({ ...body, alertContractDigest: digestCanonical(body) });
}

export function normalizeScheduleResultAlertContract(value = {}) {
  exactObject(value, alertFields(value?.contractVersion, true),
    "schedule_result_alert_contract_fields_invalid");
  const { alertContractDigest, ...candidate } = value;
  const body = normalizeAlertBody(candidate);
  const expected = digestCanonical(body);
  if (digest(alertContractDigest) !== expected) throw failure("schedule_result_alert_contract_digest_mismatch");
  return deepFreeze({ ...body, alertContractDigest: expected });
}

export function createScheduleResultRetentionDefinition(value = {}) {
  exactObject(value, RETENTION_BODY_FIELDS, "schedule_result_retention_definition_fields_invalid");
  const body = normalizeRetentionBody(value);
  return deepFreeze({ ...body, retentionDefinitionDigest: digestCanonical(body) });
}

export function normalizeScheduleResultRetentionDefinition(value = {}) {
  exactObject(value, RETENTION_FIELDS, "schedule_result_retention_definition_fields_invalid");
  const { retentionDefinitionDigest, ...candidate } = value;
  const body = normalizeRetentionBody(candidate);
  const expected = digestCanonical(body);
  if (digest(retentionDefinitionDigest) !== expected) {
    throw failure("schedule_result_retention_definition_digest_mismatch");
  }
  return deepFreeze({ ...body, retentionDefinitionDigest: expected });
}

export function createScheduleResultProcessingBinding(value = {}) {
  exactObject(value, PROCESSING_COMPONENT_FIELDS, "schedule_result_processing_binding_fields_invalid");
  const components = normalizeProcessingComponents(value);
  const processingAuthorityDigest = digestCanonical({ contractVersion: AUTHORITY_VERSION, ...components });
  return deepFreeze({ contractVersion: BINDING_VERSION, ...components, processingAuthorityDigest });
}

export function normalizeScheduleResultProcessingBinding(value = {}) {
  exactObject(value, BINDING_FIELDS, "schedule_result_processing_binding_fields_invalid");
  if (value.contractVersion !== BINDING_VERSION) throw failure("schedule_result_processing_binding_version_invalid");
  const expected = createScheduleResultProcessingBinding({
    resultContractDigest: value.resultContractDigest,
    alertContractDigest: value.alertContractDigest,
    retentionDefinitionDigest: value.retentionDefinitionDigest,
  });
  if (digest(value.processingAuthorityDigest) !== expected.processingAuthorityDigest) {
    throw failure("schedule_result_processing_binding_digest_mismatch");
  }
  return expected;
}

export function createScheduleResultProcessingAuthority(value = {}) {
  exactObject(value, COMPOSE_FIELDS, "schedule_result_processing_authority_input_invalid");
  const resultContract = normalizeScheduleResultContract(value.resultContract);
  const alertContract = normalizeScheduleResultAlertContract(value.alertContract);
  const retentionDefinition = normalizeScheduleResultRetentionDefinition(value.retentionDefinition);
  requireAlertOutcomes(resultContract, alertContract);
  const body = authorityBody(resultContract, alertContract, retentionDefinition);
  return deepFreeze({ ...body, processingAuthorityDigest: digestCanonical(body) });
}

export function normalizeScheduleResultProcessingAuthority(value = {}, definitions = {}) {
  exactObject(value, AUTHORITY_FIELDS, "schedule_result_processing_authority_fields_invalid");
  exactObject(definitions, COMPOSE_FIELDS, "schedule_result_processing_authority_definitions_invalid");
  const resultContract = normalizeScheduleResultContract(definitions.resultContract);
  const alertContract = normalizeScheduleResultAlertContract(definitions.alertContract);
  const retentionDefinition = normalizeScheduleResultRetentionDefinition(definitions.retentionDefinition);
  requireAlertOutcomes(resultContract, alertContract);
  const expectedBody = authorityBody(resultContract, alertContract, retentionDefinition);
  const candidate = {
    contractVersion: value.contractVersion,
    resultContractDigest: digest(value.resultContractDigest),
    alertContractDigest: digest(value.alertContractDigest),
    retentionDefinitionDigest: digest(value.retentionDefinitionDigest),
  };
  if (!isDeepEqual(candidate, expectedBody) || digest(value.processingAuthorityDigest) !== digestCanonical(expectedBody)) {
    throw failure("schedule_result_processing_authority_digest_mismatch");
  }
  return deepFreeze({ ...expectedBody, processingAuthorityDigest: digestCanonical(expectedBody) });
}

function normalizeAlertBody(value) {
  const contractVersion = alertVersion(value.contractVersion);
  if (!Array.isArray(value.rules) || value.rules.length > MAX_RULES ||
    !new Set(["required", "not_required"]).has(value.mode)) {
    throw failure("schedule_result_alert_contract_rules_invalid");
  }
  const rules = value.rules.map((rule) => {
    exactObject(rule, RULE_FIELDS, "schedule_result_alert_contract_rule_invalid");
    if (!Array.isArray(rule.outcomeCodes) || rule.outcomeCodes.length < 1 ||
      rule.outcomeCodes.length > MAX_OUTCOMES_PER_RULE) {
      throw failure("schedule_result_alert_contract_rule_invalid");
    }
    const outcomeCodes = rule.outcomeCodes.map(token).sort();
    if (new Set(outcomeCodes).size !== outcomeCodes.length) {
      throw failure("schedule_result_alert_contract_rule_invalid");
    }
    if (!Number.isSafeInteger(rule.maxRecipients) || rule.maxRecipients < 1 ||
      rule.maxRecipients > MAX_RECIPIENTS_PER_RULE || !RECIPIENT_ROLES.has(rule.recipientRole)) {
      throw failure("schedule_result_alert_contract_rule_invalid");
    }
    return deepFreeze({
      ruleId: token(rule.ruleId),
      outcomeCodes,
      recipientRole: rule.recipientRole,
      maxRecipients: rule.maxRecipients,
    });
  }).sort((left, right) => left.ruleId.localeCompare(right.ruleId));
  if ((value.mode === "required") !== (rules.length > 0) ||
    new Set(rules.map((rule) => rule.ruleId)).size !== rules.length ||
    rules.reduce((sum, rule) => sum + rule.maxRecipients, 0) > MAX_RECIPIENTS_PER_RULE) {
    throw failure("schedule_result_alert_contract_rules_invalid");
  }
  const body = {
    contractVersion,
    alertContractId: token(value.alertContractId),
    alertContractVersion: positiveInteger(value.alertContractVersion),
    policyVersion: token(value.policyVersion),
    mode: value.mode,
    rules,
  };
  if (contractVersion === ALERT_V2_VERSION) {
    body.deliveryPolicy = normalizeDeliveryPolicy(value.deliveryPolicy, value.mode);
  }
  return deepFreeze(body);
}

function normalizeDeliveryPolicy(value, mode) {
  if (mode === "not_required") {
    if (value !== null) throw failure("schedule_result_alert_delivery_policy_invalid");
    return null;
  }
  exactObject(value, DELIVERY_POLICY_FIELDS, "schedule_result_alert_delivery_policy_invalid");
  if (!CHANNEL_CLASSES.has(value.channelClass) || value.deliveryMode !== "one_attempt" ||
    !Number.isSafeInteger(value.maxRenderedBytes) || value.maxRenderedBytes < 256 ||
    value.maxRenderedBytes > MAX_RENDERED_BYTES ||
    value.presentationMode !== "safe_summary_codes" || value.redactionMode !== "safe_summary_only" ||
    value.releaseRule !== "current_governance_and_recipient" ||
    value.unknownOutcomeRule !== "reconcile_required") {
    throw failure("schedule_result_alert_delivery_policy_invalid");
  }
  return deepFreeze({
    channelClass: value.channelClass,
    deliveryMode: value.deliveryMode,
    maxRenderedBytes: value.maxRenderedBytes,
    presentationMode: value.presentationMode,
    redactionMode: value.redactionMode,
    releaseRule: value.releaseRule,
    unknownOutcomeRule: value.unknownOutcomeRule,
  });
}

function alertFields(version, withDigest) {
  if (version === ALERT_VERSION) return withDigest ? ALERT_FIELDS : ALERT_BODY_FIELDS;
  if (version === ALERT_V2_VERSION) return withDigest ? ALERT_V2_FIELDS : ALERT_V2_BODY_FIELDS;
  throw failure("schedule_result_alert_contract_version_invalid");
}

function alertVersion(value) {
  if (value !== ALERT_VERSION && value !== ALERT_V2_VERSION) {
    throw failure("schedule_result_alert_contract_version_invalid");
  }
  return value;
}

function normalizeRetentionBody(value) {
  if (value.contractVersion !== RETENTION_VERSION) {
    throw failure("schedule_result_retention_definition_version_invalid");
  }
  return deepFreeze({
    contractVersion: RETENTION_VERSION,
    retentionDefinitionId: token(value.retentionDefinitionId),
    retentionDefinitionVersion: positiveInteger(value.retentionDefinitionVersion),
    payloadRetentionSeconds: boundedInteger(value.payloadRetentionSeconds, 1, MAX_RETENTION_SECONDS),
  });
}

function authorityBody(resultContract, alertContract, retentionDefinition) {
  return deepFreeze({
    contractVersion: AUTHORITY_VERSION,
    resultContractDigest: resultContract.contractDigest,
    alertContractDigest: alertContract.alertContractDigest,
    retentionDefinitionDigest: retentionDefinition.retentionDefinitionDigest,
  });
}

function normalizeProcessingComponents(value) {
  return {
    resultContractDigest: digest(value.resultContractDigest),
    alertContractDigest: digest(value.alertContractDigest),
    retentionDefinitionDigest: digest(value.retentionDefinitionDigest),
  };
}

function requireAlertOutcomes(resultContract, alertContract) {
  const outcomes = new Set(resultContract.outcomeRules.map((rule) => rule.outcomeCode));
  if (alertContract.rules.some((rule) => rule.outcomeCodes.some((code) => !outcomes.has(code)))) {
    throw failure("schedule_result_alert_contract_outcome_mismatch");
  }
}

function exactObject(value, fields, code) {
  if (!plainObject(value)) throw failure(code);
  const keys = Object.keys(value);
  if (keys.length !== fields.size || keys.some((key) => !fields.has(key))) throw failure(code);
}
function plainObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
function token(value) {
  const result = String(value || "").trim();
  if (!TOKEN.test(result) || EMAIL.test(result) || SECRET.test(result)) {
    throw failure("schedule_result_processing_reference_invalid");
  }
  return result;
}
function digest(value) {
  const result = String(value || "").trim().toLowerCase();
  if (!DIGEST.test(result)) throw failure("schedule_result_processing_digest_invalid");
  return result;
}
function positiveInteger(value) { return boundedInteger(value, 1, Number.MAX_SAFE_INTEGER); }
function boundedInteger(value, minimum, maximum) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw failure("schedule_result_processing_integer_invalid");
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
function isDeepEqual(left, right) { return JSON.stringify(sortCanonical(left)) === JSON.stringify(sortCanonical(right)); }
function deepFreeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    Object.values(value).forEach(deepFreeze);
  }
  return value;
}
function failure(code) { const error = new Error(code); error.code = code; return error; }

export {
  ALERT_VERSION as SCHEDULE_RESULT_ALERT_CONTRACT_VERSION,
  ALERT_V2_VERSION as SCHEDULE_RESULT_ALERT_CONTRACT_V2_VERSION,
  AUTHORITY_VERSION as SCHEDULE_RESULT_PROCESSING_AUTHORITY_VERSION,
  BINDING_VERSION as SCHEDULE_RESULT_PROCESSING_BINDING_VERSION,
  RETENTION_VERSION as SCHEDULE_RESULT_RETENTION_DEFINITION_VERSION,
};
