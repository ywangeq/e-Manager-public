import crypto from "node:crypto";
import { createScheduleResultContract } from "./schedule-result-contract.mjs";
import {
  createScheduleResultAlertContract,
  createScheduleResultRetentionDefinition,
} from "./schedule-result-processing-contract.mjs";
import {
  createScheduleTaskDefinitionPublicationReview,
  scheduleTaskDefinitionPublicationError,
} from "./schedule-task-definition-publication.mjs";
import { normalizeScheduleTaskExecutionDefinitionV2 } from "./schedule-task-execution-definition.mjs";
import {
  normalizeScheduleTaskSourceBinding,
  SCHEDULE_TASK_SOURCE_BINDING_RESOLUTION_CONTRACT_VERSION,
} from "./versioned-schedule-task-source-binding-catalog.mjs";

const CONTRACT_VERSION = "versioned-schedule-task-review-catalog.v1";
const MANIFEST_VERSION = "versioned-schedule-task-review-manifest.v2";
const IDENTITY_VERSION = "versioned-schedule-task-review-identity.v1";
const MANIFEST_FIELDS = new Set([
  "alertContract",
  "approvalState",
  "contractVersion",
  "resultContract",
  "retentionDefinition",
  "reviewAuthorityId",
  "reviewedAt",
  "taskDefinition",
  "validUntil",
]);
const TASK_DRAFT_FIELDS = new Set([
  "contractVersion",
  "executionMode",
  "inputContract",
  "providerRequestPolicy",
  "systemInstruction",
  "taskDefinitionId",
  "taskDefinitionVersion",
  "taskInstruction",
]);
const INPUT_DRAFT_FIELDS = new Set([
  "contractVersion",
  "inputContractId",
  "inputContractVersion",
  "maxItems",
  "maxPayloadBytes",
  "retentionDefinition",
  "retrievalMode",
  "sourceAdapterId",
  "sourceBindingId",
  "sourceBindingVersion",
]);
const REQUEST_FIELDS = new Set(["taskDefinitionId", "taskDefinitionVersion", "tenantScope"]);
const TOKEN = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,159}$/;
const DIGEST = /^[a-f0-9]{64}$/;

function createVersionedScheduleTaskReviewCatalog({
  manifests = [],
  resolveSourceBindingVersion,
  stableReviewHmacKey,
  tenantScope,
} = {}) {
  const configuredTenant = token(tenantScope, "tenantScope");
  const reviewHmacKey = exactKey(stableReviewHmacKey);
  if (!Array.isArray(manifests)) {
    throw scheduleTaskDefinitionPublicationError("schedule_task_review_catalog_manifest_invalid");
  }
  if (typeof resolveSourceBindingVersion !== "function") {
    throw scheduleTaskDefinitionPublicationError("schedule_task_review_catalog_source_binding_resolver_invalid");
  }
  const reviews = new Map();
  for (const manifest of manifests) {
    const review = reviewFromManifest(
      manifest,
      configuredTenant,
      reviewHmacKey,
      resolveSourceBindingVersion,
    );
    const key = logicalKey(review.taskDefinition.taskDefinitionId, review.taskDefinition.taskDefinitionVersion);
    if (reviews.has(key)) {
      throw scheduleTaskDefinitionPublicationError("schedule_task_review_catalog_duplicate");
    }
    reviews.set(key, review);
  }

  function listApprovedReviewIdentities() {
    return deepFreeze([...reviews.values()].map((review) => ({
      contractVersion: IDENTITY_VERSION,
      tenantScope: configuredTenant,
      taskDefinitionId: review.taskDefinition.taskDefinitionId,
      taskDefinitionVersion: review.taskDefinition.taskDefinitionVersion,
      expectedReviewDigest: review.reviewDigest,
    })).sort((left, right) => logicalKey(
      left.taskDefinitionId,
      left.taskDefinitionVersion,
    ).localeCompare(logicalKey(right.taskDefinitionId, right.taskDefinitionVersion))));
  }

  function resolveApprovedReview(value = {}) {
    exactObject(value, REQUEST_FIELDS, "schedule_task_review_catalog_request_invalid");
    const requestTenant = token(value.tenantScope, "tenantScope");
    const taskDefinitionId = token(value.taskDefinitionId, "taskDefinitionId");
    const taskDefinitionVersion = positiveInteger(value.taskDefinitionVersion, "taskDefinitionVersion");
    if (requestTenant !== configuredTenant) return null;
    return reviews.get(logicalKey(taskDefinitionId, taskDefinitionVersion)) || null;
  }

  return Object.freeze({
    contractVersion: CONTRACT_VERSION,
    listApprovedReviewIdentities,
    resolveApprovedReview,
  });
}

function reviewFromManifest(value, tenantScope, reviewHmacKey, resolveSourceBindingVersion) {
  exactObject(value, MANIFEST_FIELDS, "schedule_task_review_catalog_manifest_invalid");
  if (value.contractVersion !== MANIFEST_VERSION || value.approvalState !== "approved") {
    throw scheduleTaskDefinitionPublicationError("schedule_task_review_catalog_manifest_invalid");
  }
  exactObject(value.taskDefinition, TASK_DRAFT_FIELDS, "schedule_task_review_catalog_manifest_invalid");
  exactObject(value.taskDefinition.inputContract, INPUT_DRAFT_FIELDS,
    "schedule_task_review_catalog_manifest_invalid");
  const resultContract = createScheduleResultContract(value.resultContract);
  const alertContract = createScheduleResultAlertContract(value.alertContract);
  const retentionDefinition = createScheduleResultRetentionDefinition(value.retentionDefinition);
  const inputDraft = value.taskDefinition.inputContract;
  const sourceResolution = resolveSourceBindingVersion({
    tenantScope,
    sourceBindingId: token(inputDraft.sourceBindingId, "sourceBindingId"),
    sourceBindingVersion: positiveInteger(inputDraft.sourceBindingVersion, "sourceBindingVersion"),
  });
  const sourceBinding = requireExactSourceBindingResolution(sourceResolution, {
    sourceAdapterId: token(inputDraft.sourceAdapterId, "sourceAdapterId"),
    sourceBindingId: inputDraft.sourceBindingId,
    sourceBindingVersion: inputDraft.sourceBindingVersion,
    taskDefinitionId: token(value.taskDefinition.taskDefinitionId, "taskDefinitionId"),
    taskDefinitionVersion: positiveInteger(
      value.taskDefinition.taskDefinitionVersion,
      "taskDefinitionVersion",
    ),
  });
  if (new Date(sourceBinding.publishedAt).getTime() > new Date(value.reviewedAt).getTime()) {
    throw scheduleTaskDefinitionPublicationError("schedule_task_review_catalog_source_binding_future");
  }
  const taskDefinition = normalizeScheduleTaskExecutionDefinitionV2({
    ...value.taskDefinition,
    inputContract: {
      contractVersion: inputDraft.contractVersion,
      inputContractId: inputDraft.inputContractId,
      inputContractVersion: inputDraft.inputContractVersion,
      sourceAdapterId: inputDraft.sourceAdapterId,
      sourceBindingDigest: sourceResolution.sourceBindingDigest,
      retrievalMode: inputDraft.retrievalMode,
      maxItems: inputDraft.maxItems,
      maxPayloadBytes: inputDraft.maxPayloadBytes,
      retentionDefinition: inputDraft.retentionDefinition,
    },
    resultContractDigest: resultContract.contractDigest,
  });
  const reviewAuthorityId = token(value.reviewAuthorityId, "reviewAuthorityId");
  const reviewAuthorityDigest = crypto.createHmac("sha256", reviewHmacKey)
    .update(JSON.stringify([
      "versioned-schedule-task-review-authority.v1",
      tenantScope,
      reviewAuthorityId,
    ])).digest("hex");
  return createScheduleTaskDefinitionPublicationReview({
    contractVersion: "schedule-task-definition-publication-review.v2",
    payloadBoundary: "internal_only",
    tenantScope,
    taskDefinition,
    resultContract,
    alertContract,
    retentionDefinition,
    reviewAuthorityDigest,
    reviewedAt: value.reviewedAt,
    validUntil: value.validUntil,
  }, { stableReviewHmacKey: reviewHmacKey });
}

function requireExactSourceBindingResolution(value, expected) {
  if (!plainObject(value) ||
    value.contractVersion !== SCHEDULE_TASK_SOURCE_BINDING_RESOLUTION_CONTRACT_VERSION ||
    value.payloadBoundary !== "internal_only" ||
    !DIGEST.test(String(value.sourceBindingDigest || ""))) {
    throw scheduleTaskDefinitionPublicationError("schedule_task_review_catalog_source_binding_unavailable");
  }
  const binding = normalizeScheduleTaskSourceBinding(value.binding);
  if (binding.sourceBindingId !== expected.sourceBindingId ||
    binding.sourceBindingVersion !== expected.sourceBindingVersion ||
    binding.sourceAdapterId !== expected.sourceAdapterId ||
    binding.taskDefinitionId !== expected.taskDefinitionId ||
    binding.taskDefinitionVersion !== expected.taskDefinitionVersion) {
    throw scheduleTaskDefinitionPublicationError("schedule_task_review_catalog_source_binding_mismatch");
  }
  return binding;
}

function logicalKey(taskDefinitionId, taskDefinitionVersion) {
  return `${taskDefinitionId}\0${String(taskDefinitionVersion).padStart(16, "0")}`;
}

function exactObject(value, fields, code) {
  if (!plainObject(value)) throw scheduleTaskDefinitionPublicationError(code);
  const keys = Object.keys(value);
  if (keys.length !== fields.size || keys.some((key) => !fields.has(key))) {
    throw scheduleTaskDefinitionPublicationError(code);
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
    throw scheduleTaskDefinitionPublicationError("schedule_task_review_catalog_reference_invalid", field);
  }
  return result;
}

function positiveInteger(value, field) {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw scheduleTaskDefinitionPublicationError("schedule_task_review_catalog_number_invalid", field);
  }
  return value;
}

function exactKey(value) {
  const key = Buffer.isBuffer(value) ? Buffer.from(value) : Buffer.from(value || []);
  if (key.length !== 32) {
    throw scheduleTaskDefinitionPublicationError("schedule_task_review_catalog_hmac_key_invalid");
  }
  return key;
}

function deepFreeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    Object.values(value).forEach(deepFreeze);
  }
  return value;
}

export {
  CONTRACT_VERSION as VERSIONED_SCHEDULE_TASK_REVIEW_CATALOG_CONTRACT_VERSION,
  MANIFEST_VERSION as VERSIONED_SCHEDULE_TASK_REVIEW_MANIFEST_CONTRACT_VERSION,
  createVersionedScheduleTaskReviewCatalog,
};
