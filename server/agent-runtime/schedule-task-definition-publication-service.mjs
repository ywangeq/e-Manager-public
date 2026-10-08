import { isDeepStrictEqual } from "node:util";
import {
  normalizeScheduleTaskDefinitionPublicationReview,
  scheduleTaskDefinitionPublicationError,
} from "./schedule-task-definition-publication.mjs";
import { createScheduleResultProcessingBinding } from "./schedule-result-processing-contract.mjs";
import { projectScheduleTaskExecutionDefinitionSafe } from "./schedule-task-execution-definition.mjs";

const CONTRACT_VERSION = "schedule-task-definition-publication-service.v1";
const RESULT_VERSION = "schedule-task-definition-publication-result.v1";
const REQUEST_FIELDS = new Set([
  "expectedReviewDigest",
  "taskDefinitionId",
  "taskDefinitionVersion",
  "tenantScope",
]);
const TOKEN = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,159}$/;
const DIGEST = /^[a-f0-9]{64}$/;

function createScheduleTaskDefinitionPublicationService({
  processingAuthorityRepository,
  resolveApprovedReview,
  serverClock,
  stableReviewHmacKey,
  taskDefinitionRepository,
} = {}) {
  if (typeof processingAuthorityRepository?.publishBundle !== "function" ||
    typeof processingAuthorityRepository?.resolveProcessingAuthority !== "function") {
    throw new TypeError("Schedule task definition publication requires the processing authority repository");
  }
  if (typeof taskDefinitionRepository?.publish !== "function" ||
    typeof taskDefinitionRepository?.resolveVersion !== "function") {
    throw new TypeError("Schedule task definition publication requires the task definition repository");
  }
  if (typeof resolveApprovedReview !== "function") {
    throw new TypeError("Schedule task definition publication requires the approved review resolver");
  }
  if (typeof serverClock !== "function") {
    throw new TypeError("Schedule task definition publication requires a server clock");
  }
  const reviewHmacKey = Buffer.isBuffer(stableReviewHmacKey)
    ? Buffer.from(stableReviewHmacKey)
    : Buffer.from(stableReviewHmacKey || []);
  if (reviewHmacKey.length !== 32) {
    throw new TypeError("Schedule task definition publication requires a stable review HMAC key");
  }

  async function publish(value = {}) {
    const request = normalizeRequest(value);
    let resolved;
    try {
      resolved = await resolveApprovedReview({
        tenantScope: request.tenantScope,
        taskDefinitionId: request.taskDefinitionId,
        taskDefinitionVersion: request.taskDefinitionVersion,
      });
    } catch {
      throw scheduleTaskDefinitionPublicationError("schedule_task_definition_review_unavailable");
    }
    if (!resolved) {
      throw scheduleTaskDefinitionPublicationError("schedule_task_definition_review_not_approved");
    }
    let review;
    try {
      review = normalizeScheduleTaskDefinitionPublicationReview(resolved, {
        stableReviewHmacKey: reviewHmacKey,
      });
    } catch (error) {
      if (String(error?.code || "").startsWith("schedule_task_definition_review_")) throw error;
      throw scheduleTaskDefinitionPublicationError("schedule_task_definition_review_invalid");
    }
    requireReviewIdentity(review, request);
    const expectedProcessingBinding = createScheduleResultProcessingBinding({
      resultContractDigest: review.resultContract.contractDigest,
      alertContractDigest: review.alertContract.alertContractDigest,
      retentionDefinitionDigest: review.retentionDefinition.retentionDefinitionDigest,
    });
    const existingDefinition = taskDefinitionRepository.resolveVersion({
      tenantScope: request.tenantScope,
      taskDefinitionId: request.taskDefinitionId,
      taskDefinitionVersion: request.taskDefinitionVersion,
    });
    const existingProcessing = processingAuthorityRepository.resolveProcessingAuthority({
      tenantScope: request.tenantScope,
      processingAuthorityDigest: expectedProcessingBinding.processingAuthorityDigest,
    });
    if (existingDefinition) requireExactStoredDefinition(existingDefinition, review);
    if (existingProcessing) requireExactStoredProcessing(existingProcessing, expectedProcessingBinding);
    if (existingDefinition && existingProcessing) {
      return publicationResult({
        created: false,
        definitionResolution: existingDefinition,
        processingBinding: expectedProcessingBinding,
        review,
      });
    }
    requireCurrentReview(review, request, trustedTimestamp(serverClock));

    const processing = processingAuthorityRepository.publishBundle({
      tenantScope: request.tenantScope,
      resultContract: review.resultContract,
      alertContract: review.alertContract,
      retentionDefinition: review.retentionDefinition,
    });
    const processingBinding = requireExactStoredProcessing(processing?.resolution, expectedProcessingBinding);
    // The processing bundle is inert by itself. Recheck the approval immediately before the
    // task row becomes registerable so an expired review cannot cross the two-database boundary.
    requireCurrentReview(review, request, trustedTimestamp(serverClock));
    const definition = taskDefinitionRepository.publish({
      tenantScope: request.tenantScope,
      definition: review.taskDefinition,
    });
    return publicationResult({
      created: Boolean(processing.created || definition.created),
      definitionSafe: definition.definition,
      processingBinding,
      review,
    });
  }

  return Object.freeze({ contractVersion: CONTRACT_VERSION, publish });
}

function normalizeRequest(value) {
  exactObject(value, REQUEST_FIELDS);
  return Object.freeze({
    tenantScope: token(value.tenantScope, "tenantScope"),
    taskDefinitionId: token(value.taskDefinitionId, "taskDefinitionId"),
    taskDefinitionVersion: positiveInteger(value.taskDefinitionVersion, "taskDefinitionVersion"),
    expectedReviewDigest: digest(value.expectedReviewDigest, "expectedReviewDigest"),
  });
}

function requireReviewIdentity(review, request) {
  if (review.tenantScope !== request.tenantScope ||
    review.taskDefinition.taskDefinitionId !== request.taskDefinitionId ||
    review.taskDefinition.taskDefinitionVersion !== request.taskDefinitionVersion ||
    review.reviewDigest !== request.expectedReviewDigest) {
    throw scheduleTaskDefinitionPublicationError("schedule_task_definition_review_stale");
  }
}

function requireCurrentReview(review, request, evaluatedAt) {
  requireReviewIdentity(review, request);
  if (review.reviewedAt > evaluatedAt) {
    throw scheduleTaskDefinitionPublicationError("schedule_task_definition_review_not_effective");
  }
  if (review.validUntil <= evaluatedAt) {
    throw scheduleTaskDefinitionPublicationError("schedule_task_definition_review_expired");
  }
}

function requireExactStoredDefinition(resolution, review) {
  if (resolution?.contractVersion !== "schedule-task-execution-definition-resolution.v1" ||
    resolution.payloadBoundary !== "internal_only" ||
    !isDeepStrictEqual(resolution.definition, review.taskDefinition)) {
    throw scheduleTaskDefinitionPublicationError("schedule_task_definition_publication_definition_conflict");
  }
  return resolution;
}

function requireExactStoredProcessing(resolution, expectedBinding) {
  let binding;
  try {
    binding = createScheduleResultProcessingBinding({
      resultContractDigest: resolution?.authority?.resultContractDigest,
      alertContractDigest: resolution?.authority?.alertContractDigest,
      retentionDefinitionDigest: resolution?.authority?.retentionDefinitionDigest,
    });
  } catch {
    throw scheduleTaskDefinitionPublicationError("schedule_task_definition_publication_processing_invalid");
  }
  if (resolution.contractVersion !== "schedule-result-processing-resolution.v1" ||
    binding.processingAuthorityDigest !== resolution.authority?.processingAuthorityDigest ||
    !isDeepStrictEqual(binding, expectedBinding)) {
    throw scheduleTaskDefinitionPublicationError("schedule_task_definition_publication_processing_invalid");
  }
  return binding;
}

function publicationResult({ created, definitionResolution = null, definitionSafe = null, processingBinding, review }) {
  const safeDefinition = definitionSafe || projectScheduleTaskExecutionDefinitionSafe({
    definition: definitionResolution.definition,
    executionContractDigest: definitionResolution.executionContractDigest,
    publishedAt: definitionResolution.publishedAt,
  });
  return deepFreeze({
    contractVersion: RESULT_VERSION,
    created: Boolean(created),
    review: {
      contractVersion: "schedule-task-definition-publication-review-safe.v2",
      reviewDigest: review.reviewDigest,
      reviewedAt: review.reviewedAt,
      validUntil: review.validUntil,
    },
    taskDefinition: safeDefinition,
    processingAuthority: processingBinding,
  });
}

function exactObject(value, fields) {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype) {
    throw scheduleTaskDefinitionPublicationError("schedule_task_definition_publication_request_invalid");
  }
  const keys = Object.keys(value);
  if (keys.length !== fields.size || keys.some((key) => !fields.has(key))) {
    throw scheduleTaskDefinitionPublicationError("schedule_task_definition_publication_request_invalid");
  }
}

function token(value, field) {
  const result = String(value || "").trim();
  if (!TOKEN.test(result) || /@[^/]+\.[A-Za-z]{2,}$/.test(result)) {
    throw scheduleTaskDefinitionPublicationError("schedule_task_definition_publication_reference_invalid", field);
  }
  return result;
}

function digest(value, field) {
  const result = String(value || "").trim().toLowerCase();
  if (!DIGEST.test(result)) {
    throw scheduleTaskDefinitionPublicationError("schedule_task_definition_publication_digest_invalid", field);
  }
  return result;
}

function positiveInteger(value, field) {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw scheduleTaskDefinitionPublicationError("schedule_task_definition_publication_number_invalid", field);
  }
  return value;
}

function trustedTimestamp(serverClock) {
  let value;
  try {
    value = serverClock();
    const result = value instanceof Date ? value.toISOString() : String(value || "").trim();
    if (new Date(result).toISOString() !== result) throw new Error();
    return result;
  } catch {
    throw scheduleTaskDefinitionPublicationError("schedule_task_definition_publication_clock_invalid");
  }
}

function deepFreeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    Object.values(value).forEach(deepFreeze);
  }
  return value;
}

export {
  CONTRACT_VERSION as SCHEDULE_TASK_DEFINITION_PUBLICATION_SERVICE_CONTRACT_VERSION,
  createScheduleTaskDefinitionPublicationService,
};
