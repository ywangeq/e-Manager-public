import crypto from "node:crypto";
import { normalizeScheduleResultContract } from "./schedule-result-contract.mjs";
import {
  createScheduleResultProcessingAuthority,
  normalizeScheduleResultAlertContract,
  normalizeScheduleResultRetentionDefinition,
} from "./schedule-result-processing-contract.mjs";
import { normalizeScheduleTaskExecutionDefinitionV2 } from "./schedule-task-execution-definition.mjs";

const CONTRACT_VERSION = "schedule-task-definition-publication-review.v2";
const PAYLOAD_BOUNDARY = "internal_only";
const BODY_FIELDS = new Set([
  "alertContract",
  "contractVersion",
  "payloadBoundary",
  "resultContract",
  "retentionDefinition",
  "reviewAuthorityDigest",
  "reviewedAt",
  "taskDefinition",
  "tenantScope",
  "validUntil",
]);
const REVIEW_FIELDS = new Set([...BODY_FIELDS, "reviewDigest"]);
const TOKEN = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,159}$/;
const DIGEST = /^[a-f0-9]{64}$/;

function createScheduleTaskDefinitionPublicationReview(value = {}, { stableReviewHmacKey } = {}) {
  exactObject(value, BODY_FIELDS);
  const body = normalizeBody(value);
  return deepFreeze({ ...body, reviewDigest: reviewHmac(stableReviewHmacKey, body) });
}

function normalizeScheduleTaskDefinitionPublicationReview(value = {}, { stableReviewHmacKey } = {}) {
  exactObject(value, REVIEW_FIELDS);
  const { reviewDigest, ...candidate } = value;
  const body = normalizeBody(candidate);
  const expectedDigest = reviewHmac(stableReviewHmacKey, body);
  if (digest(reviewDigest, "reviewDigest") !== expectedDigest) {
    throw publicationError("schedule_task_definition_review_digest_mismatch");
  }
  return deepFreeze({ ...body, reviewDigest: expectedDigest });
}

function normalizeBody(value) {
  if (value.contractVersion !== CONTRACT_VERSION || value.payloadBoundary !== PAYLOAD_BOUNDARY) {
    throw publicationError("schedule_task_definition_review_contract_invalid");
  }
  const tenantScope = token(value.tenantScope, "tenantScope");
  const taskDefinition = normalizeScheduleTaskExecutionDefinitionV2(value.taskDefinition);
  const resultContract = normalizeScheduleResultContract(value.resultContract);
  const alertContract = normalizeScheduleResultAlertContract(value.alertContract);
  const retentionDefinition = normalizeScheduleResultRetentionDefinition(value.retentionDefinition);
  const processingAuthority = createScheduleResultProcessingAuthority({
    resultContract,
    alertContract,
    retentionDefinition,
  });
  if (taskDefinition.resultContractDigest !== processingAuthority.resultContractDigest) {
    throw publicationError("schedule_task_definition_review_processing_mismatch");
  }
  const reviewedAt = timestamp(value.reviewedAt, "reviewedAt");
  const validUntil = timestamp(value.validUntil, "validUntil");
  if (validUntil <= reviewedAt) {
    throw publicationError("schedule_task_definition_review_validity_invalid");
  }
  return deepFreeze({
    contractVersion: CONTRACT_VERSION,
    payloadBoundary: PAYLOAD_BOUNDARY,
    tenantScope,
    taskDefinition,
    resultContract,
    alertContract,
    retentionDefinition,
    reviewAuthorityDigest: digest(value.reviewAuthorityDigest, "reviewAuthorityDigest"),
    reviewedAt,
    validUntil,
  });
}

function exactObject(value, fields) {
  if (!plainObject(value)) throw publicationError("schedule_task_definition_review_fields_invalid");
  const keys = Object.keys(value);
  if (keys.length !== fields.size || keys.some((key) => !fields.has(key))) {
    throw publicationError("schedule_task_definition_review_fields_invalid");
  }
}

function plainObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function token(value, field) {
  const result = String(value || "").trim();
  if (!TOKEN.test(result) || /@[^/]+\.[A-Za-z]{2,}$/.test(result)) {
    throw publicationError("schedule_task_definition_review_reference_invalid", field);
  }
  return result;
}

function digest(value, field) {
  const result = String(value || "").trim().toLowerCase();
  if (!DIGEST.test(result)) {
    throw publicationError("schedule_task_definition_review_digest_invalid", field);
  }
  return result;
}

function timestamp(value, field) {
  const result = String(value || "").trim();
  const parsed = new Date(result);
  if (!result || !Number.isFinite(parsed.getTime()) || parsed.toISOString() !== result) {
    throw publicationError("schedule_task_definition_review_timestamp_invalid", field);
  }
  return result;
}

function reviewHmac(value, body) {
  const key = Buffer.isBuffer(value) ? Buffer.from(value) : Buffer.from(value || []);
  if (key.length !== 32) {
    throw publicationError("schedule_task_definition_review_hmac_key_invalid");
  }
  return crypto.createHmac("sha256", key).update(JSON.stringify(sortCanonical({
    contractVersion: "schedule-task-definition-publication-review-digest.v2",
    body,
  }))).digest("hex");
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

function publicationError(code, detail = "") {
  const error = new Error(detail ? `${code}: ${detail}` : code);
  error.code = code;
  return error;
}

export {
  CONTRACT_VERSION as SCHEDULE_TASK_DEFINITION_PUBLICATION_REVIEW_CONTRACT_VERSION,
  createScheduleTaskDefinitionPublicationReview,
  normalizeScheduleTaskDefinitionPublicationReview,
  publicationError as scheduleTaskDefinitionPublicationError,
};
