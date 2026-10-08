import crypto from "node:crypto";
import { normalizeScheduleResultAlertContract } from "./schedule-result-processing-contract.mjs";

const CONTRACT_VERSION = "schedule-business-owner-alert-plan-resolver.v1";
const PLAN_VERSION = "schedule-result-alert-plan.v1";
const RECIPIENT_VERSION = "enterprise-business-owner-recipient-resolution.v1";
const REQUEST_FIELDS = new Set(["alertContract", "employeeId", "safeSummary", "tenantScope"]);
const SUMMARY_FIELDS = new Set(["outcomeCode", "severityCode", "summaryCode"]);
const RECIPIENT_FIELDS = new Set([
  "authorityValidUntil", "contractVersion", "recipientAuthorityDigest", "recipientGeneration",
  "recipientPrincipalDigest", "recipientRole", "resolutionDigest",
]);
const TOKEN = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,159}$/;
const DIGEST = /^[a-f0-9]{64}$/;

function createScheduleBusinessOwnerAlertPlanResolver({
  resolveCurrentBusinessOwnerRecipient,
} = {}) {
  if (typeof resolveCurrentBusinessOwnerRecipient !== "function") {
    throw new TypeError("Schedule Business Owner alert plan requires current recipient authority");
  }

  async function resolveAlertPlan(value = {}) {
    exactObject(value, REQUEST_FIELDS, "schedule_business_owner_alert_plan_request_invalid");
    const tenantScope = token(value.tenantScope);
    const employeeId = token(value.employeeId);
    const alertContract = normalizeScheduleResultAlertContract(value.alertContract);
    const safeSummary = normalizeSafeSummary(value.safeSummary);
    const matchingRules = alertContract.rules.filter((rule) =>
      rule.outcomeCodes.includes(safeSummary.outcomeCode));
    if (alertContract.mode === "not_required" || matchingRules.length === 0) {
      return createPlan(alertContract, []);
    }
    const recipient = normalizeRecipient(await resolveCurrentBusinessOwnerRecipient({
      tenantScope,
      targetId: employeeId,
      targetType: "digital_employee",
    }));
    return createPlan(alertContract, matchingRules.map((rule) => ({
      generation: recipient.recipientGeneration,
      recipientPrincipalDigest: recipient.recipientPrincipalDigest,
      recipientRole: "business_owner",
      ruleId: rule.ruleId,
    })));
  }

  return Object.freeze({ contractVersion: CONTRACT_VERSION, resolveAlertPlan });
}

function createPlan(alertContract, recipients) {
  const body = {
    alertContractDigest: alertContract.alertContractDigest,
    contractVersion: PLAN_VERSION,
    mode: recipients.length > 0 ? "required" : "not_required",
    policyVersion: alertContract.policyVersion,
    recipients: recipients.toSorted((left, right) => canonicalJson(left).localeCompare(canonicalJson(right))),
  };
  return deepFreeze({ ...body, planDigest: digestCanonical(body) });
}

function normalizeSafeSummary(value) {
  exactObject(value, SUMMARY_FIELDS, "schedule_business_owner_alert_plan_summary_invalid");
  return Object.freeze({
    outcomeCode: token(value.outcomeCode),
    severityCode: token(value.severityCode),
    summaryCode: token(value.summaryCode),
  });
}

function normalizeRecipient(value) {
  exactObject(value, RECIPIENT_FIELDS, "schedule_business_owner_alert_plan_recipient_invalid");
  const body = {
    authorityValidUntil: timestamp(value.authorityValidUntil),
    contractVersion: value.contractVersion,
    recipientAuthorityDigest: digest(value.recipientAuthorityDigest),
    recipientGeneration: positiveInteger(value.recipientGeneration),
    recipientPrincipalDigest: digest(value.recipientPrincipalDigest),
    recipientRole: value.recipientRole,
  };
  const valid = body.contractVersion === RECIPIENT_VERSION &&
    body.recipientRole === "business_owner" &&
    digest(value.resolutionDigest) === digestCanonical(body);
  if (!valid) throw resolverError("schedule_business_owner_alert_plan_recipient_invalid");
  return Object.freeze(body);
}

function exactObject(value, fields, code) {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype ||
    Object.keys(value).length !== fields.size ||
    Object.keys(value).some((field) => !fields.has(field))) throw resolverError(code);
}

function token(value) {
  const result = String(value || "").trim();
  if (!TOKEN.test(result) || /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(result)) {
    throw resolverError("schedule_business_owner_alert_plan_reference_invalid");
  }
  return result;
}

function digest(value) {
  const result = String(value || "").trim().toLowerCase();
  if (!DIGEST.test(result)) throw resolverError("schedule_business_owner_alert_plan_digest_invalid");
  return result;
}

function positiveInteger(value) {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw resolverError("schedule_business_owner_alert_plan_generation_invalid");
  }
  return value;
}

function timestamp(value) {
  const result = String(value || "").trim();
  const parsed = new Date(result);
  if (!result || !Number.isFinite(parsed.getTime()) || parsed.toISOString() !== result) {
    throw resolverError("schedule_business_owner_alert_plan_timestamp_invalid");
  }
  return result;
}

function digestCanonical(value) {
  return crypto.createHash("sha256").update(canonicalJson(value)).digest("hex");
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) =>
      `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  const result = JSON.stringify(Object.is(value, -0) ? 0 : value);
  if (result === undefined) throw resolverError("schedule_business_owner_alert_plan_value_invalid");
  return result;
}

function deepFreeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    Object.values(value).forEach(deepFreeze);
  }
  return value;
}

function resolverError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

export {
  CONTRACT_VERSION as SCHEDULE_BUSINESS_OWNER_ALERT_PLAN_RESOLVER_CONTRACT_VERSION,
  createScheduleBusinessOwnerAlertPlanResolver,
};
