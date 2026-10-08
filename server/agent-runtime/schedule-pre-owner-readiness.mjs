import crypto from "node:crypto";
import { normalizeProviderTimeoutPolicy } from "./provider-timeout-policy.mjs";
import { createScheduleResultProcessingBinding } from "./schedule-result-processing-contract.mjs";

const SCHEDULE_PRE_OWNER_READINESS_INPUT_CONTRACT_VERSION = "schedule-pre-owner-readiness-input.v1";
const SCHEDULE_PRE_OWNER_READINESS_EVIDENCE_CONTRACT_VERSION = "schedule-pre-owner-readiness-evidence.v1";
const SCHEDULE_PRE_OWNER_READINESS_CONTRACT_VERSION = "schedule-pre-owner-readiness.v1";
const INPUT_FIELDS = new Set([
  "alertContractDigest",
  "contractVersion",
  "employeeId",
  "employeeVersion",
  "evaluatedAt",
  "executionContractDigest",
  "processingAuthorityDigest",
  "providerTimeoutPolicy",
  "providerTrialEvidenceDigest",
  "registrationVersion",
  "resultContractDigest",
  "retentionDefinitionDigest",
  "scheduleId",
  "schedulePolicyDigest",
  "scheduleVersion",
  "taskBindingDigest",
  "taskDefinitionId",
  "tenantScope",
  "writebackContractDigest",
]);
const TOKEN = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,239}$/;
const DIGEST = /^[a-f0-9]{64}$/;

function createSchedulePreOwnerReadinessEvidence(value = {}) {
  exactObject(value, INPUT_FIELDS);
  if (value.contractVersion !== SCHEDULE_PRE_OWNER_READINESS_INPUT_CONTRACT_VERSION) {
    throw readinessError("schedule_pre_owner_readiness_input_invalid");
  }
  const processing = createScheduleResultProcessingBinding({
    resultContractDigest: digest(value.resultContractDigest),
    alertContractDigest: digest(value.alertContractDigest),
    retentionDefinitionDigest: digest(value.retentionDefinitionDigest),
  });
  if (processing.processingAuthorityDigest !== digest(value.processingAuthorityDigest)) {
    throw readinessError("schedule_pre_owner_readiness_processing_mismatch");
  }
  const body = {
    contractVersion: SCHEDULE_PRE_OWNER_READINESS_CONTRACT_VERSION,
    tenantScope: token(value.tenantScope),
    employeeId: token(value.employeeId),
    employeeVersion: token(value.employeeVersion),
    scheduleId: token(value.scheduleId),
    scheduleVersion: token(value.scheduleVersion),
    registrationVersion: positiveInteger(value.registrationVersion),
    taskDefinitionId: token(value.taskDefinitionId),
    schedulePolicyDigest: digest(value.schedulePolicyDigest),
    executionContractDigest: digest(value.executionContractDigest),
    taskBindingDigest: digest(value.taskBindingDigest),
    providerTrialEvidenceDigest: digest(value.providerTrialEvidenceDigest),
    providerTimeoutPolicy: normalizeProviderTimeoutPolicy(value.providerTimeoutPolicy),
    resultContractDigest: processing.resultContractDigest,
    alertContractDigest: processing.alertContractDigest,
    retentionDefinitionDigest: processing.retentionDefinitionDigest,
    processingAuthorityDigest: processing.processingAuthorityDigest,
    writebackContractDigest: digest(value.writebackContractDigest),
  };
  return deepFreeze({
    contractVersion: SCHEDULE_PRE_OWNER_READINESS_EVIDENCE_CONTRACT_VERSION,
    state: "passed",
    registrationVersion: body.registrationVersion,
    taskBindingDigest: body.taskBindingDigest,
    providerTrialEvidenceDigest: body.providerTrialEvidenceDigest,
    processingAuthorityDigest: body.processingAuthorityDigest,
    evaluatedAt: timestamp(value.evaluatedAt),
    readinessVersion: body.registrationVersion,
    readinessDigest: crypto.createHash("sha256").update(JSON.stringify(body)).digest("hex"),
  });
}

function exactObject(value, fields) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw readinessError("schedule_pre_owner_readiness_input_invalid");
  }
  const keys = Object.keys(value);
  if (keys.length !== fields.size || keys.some((key) => !fields.has(key))) {
    throw readinessError("schedule_pre_owner_readiness_input_invalid");
  }
}

function token(value) {
  const result = String(value || "").trim();
  if (!TOKEN.test(result)) throw readinessError("schedule_pre_owner_readiness_token_invalid");
  return result;
}

function digest(value) {
  const result = String(value || "").trim().toLowerCase();
  if (!DIGEST.test(result)) throw readinessError("schedule_pre_owner_readiness_digest_invalid");
  return result;
}

function positiveInteger(value) {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw readinessError("schedule_pre_owner_readiness_number_invalid");
  }
  return value;
}

function timestamp(value) {
  const result = String(value || "").trim();
  const parsed = new Date(result);
  if (!result || !Number.isFinite(parsed.getTime()) || parsed.toISOString() !== result) {
    throw readinessError("schedule_pre_owner_readiness_timestamp_invalid");
  }
  return result;
}

function readinessError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

function deepFreeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    Object.values(value).forEach(deepFreeze);
  }
  return value;
}

export {
  SCHEDULE_PRE_OWNER_READINESS_CONTRACT_VERSION,
  SCHEDULE_PRE_OWNER_READINESS_EVIDENCE_CONTRACT_VERSION,
  SCHEDULE_PRE_OWNER_READINESS_INPUT_CONTRACT_VERSION,
  createSchedulePreOwnerReadinessEvidence,
};
