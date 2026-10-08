import crypto from "node:crypto";
import { normalizeTriggerEvent } from "./trigger-event-contract-v1.mjs";
import { normalizeTriggerWritebackBinding } from "./trigger-writeback-binding-registry.mjs";

const CONTRACT_VERSION = "trigger-review-writeback-effect.v1";
const SAFE_RECEIPT_VERSION = "trigger-review-writeback-safe-receipt.v1";
const REVIEW_RESULT_EVIDENCE_VERSION = "trigger-review-result-evidence.v1";
const INPUT_FIELDS = new Set([
  "adapterIdentity",
  "authorizeCurrentOperation",
  "effect",
  "evidence",
  "operationReceiptContext",
  "recover",
  "reviewComment",
  "signal",
  "task",
  "triggerEvent",
  "writebackBinding",
]);
const ADAPTER_IDENTITY_FIELDS = new Set(["actionCode", "adapterId", "authorizationDigest"]);
const EVIDENCE_FIELDS = new Set([
  "contractVersion",
  "evidenceDigest",
  "reviewResultId",
  "sealedAt",
  "taskId",
  "tenantScope",
  "triggerEventId",
]);
const RECEIPT_CONTEXT_FIELDS = new Set(["repositoryContext"]);
const REPOSITORY_CONTEXT_FIELDS = new Set([
  "fencingToken",
  "leaseId",
  "taskId",
  "tenantScope",
  "workerIdDigest",
]);
const STORED_TRIGGER_EVENT_FIELDS = new Set([
  "bindingId",
  "event",
  "executionSnapshot",
  "externalEventId",
  "tenantScope",
  "triggerEventId",
]);
const EFFECT_RESULT_FIELDS = new Set(["safeResultCode", "status"]);
const OUTCOME_STATUSES = new Set(["definitive_failed", "succeeded", "unknown"]);
const SAFE_TOKEN = /^[A-Za-z0-9][A-Za-z0-9._:@-]*$/;
const SAFE_CODE = /^[a-z][a-z0-9_]{1,119}$/;
const DIGEST = /^[a-f0-9]{64}$/;

function createTriggerReviewWritebackEffect({ idempotentEffectService, operationReceiptProjector } = {}) {
  if (typeof idempotentEffectService?.execute !== "function") {
    throw new TypeError("trigger review writeback requires idempotentEffectService.execute");
  }
  if (typeof operationReceiptProjector?.project !== "function") {
    throw new TypeError("trigger review writeback requires operationReceiptProjector.project");
  }

  async function execute(value = {}) {
    const input = normalizeInput(value);
    const receiptRequest = operationReceiptProjector.project({
      tenantScope: input.task.tenantScope,
      taskId: input.task.taskId,
      toolCallId: deriveToolCallId(input),
      effectKind: "external_write",
      adapterId: input.adapterIdentity.adapterId,
      actionCode: input.adapterIdentity.actionCode,
      authorizationDigest: input.adapterIdentity.authorizationDigest,
      recoveryMode: "status_query",
      operation: projectSealedOperation(input),
      targetScope: projectSealedTargetScope(input),
    });

    return idempotentEffectService.execute({
      request: receiptRequest,
      repositoryContext: input.operationReceiptContext.repositoryContext,
      authorizeCurrentOperation: input.authorizeCurrentOperation,
      recover: async ({ request, receipt }) => {
        const result = normalizeEffectResult(await input.recover(Object.freeze({
          adapterIdentity: input.adapterIdentity,
          evidence: input.evidence,
          receipt,
          receiptRequest: request,
          reviewComment: input.reviewComment,
          signal: input.signal,
          task: input.task,
          triggerEvent: input.triggerEvent,
          writebackBinding: input.writebackBinding,
        })));
        return Object.freeze({
          status: result.status,
          safeResultCode: result.safeResultCode,
          receiptPayload: result.status === "unknown" ? null : Object.freeze({
            contractVersion: SAFE_RECEIPT_VERSION,
            evidenceDigest: input.evidence.evidenceDigest,
          }),
        });
      },
      effect: async ({ request }) => {
        const result = normalizeEffectResult(await input.effect(Object.freeze({
          adapterIdentity: input.adapterIdentity,
          evidence: input.evidence,
          receiptRequest: request,
          reviewComment: input.reviewComment,
          signal: input.signal,
          task: input.task,
          triggerEvent: input.triggerEvent,
          writebackBinding: input.writebackBinding,
        })));
        return Object.freeze({
          status: result.status,
          safeResultCode: result.safeResultCode,
          receiptPayload: result.status === "unknown" ? null : Object.freeze({
            contractVersion: SAFE_RECEIPT_VERSION,
            evidenceDigest: input.evidence.evidenceDigest,
          }),
        });
      },
    });
  }

  return Object.freeze({ contractVersion: CONTRACT_VERSION, execute });
}

function normalizeInput(value) {
  requireExactObject(value, INPUT_FIELDS, "trigger_review_writeback_input_invalid");
  const task = requireTask(value.task);
  const evidence = normalizeEvidence(value.evidence, task);
  const triggerEvent = normalizeStoredTriggerEvent(value.triggerEvent, task, evidence);
  const writebackBinding = normalizeTriggerWritebackBinding(value.writebackBinding);
  if (writebackBinding.enabled !== true || writebackBinding.reviewStatus !== "approved") {
    throw writebackError("trigger_review_writeback_binding_unavailable");
  }
  if (writebackBinding.sourceObjectApiName !== triggerEvent.event.subject.objectApiName ||
    writebackBinding.sourceSystemId !== task.sourceSystemId ||
    writebackBinding.sourceSystemId !== triggerEvent.executionSnapshot.sourceSystemId ||
    writebackBinding.taskDefinitionId !== triggerEvent.executionSnapshot.taskDefinitionId) {
    throw writebackError("trigger_review_writeback_binding_mismatch");
  }
  const adapterIdentity = normalizeAdapterIdentity(value.adapterIdentity);
  const operationReceiptContext = normalizeOperationReceiptContext(value.operationReceiptContext, task);
  if (typeof value.authorizeCurrentOperation !== "function") {
    throw writebackError("trigger_review_writeback_authorizer_required");
  }
  if (typeof value.effect !== "function") {
    throw writebackError("trigger_review_writeback_effect_required");
  }
  if (typeof value.recover !== "function") {
    throw writebackError("trigger_review_writeback_recovery_required");
  }
  if (value.signal !== null && !isAbortSignal(value.signal)) {
    throw writebackError("trigger_review_writeback_signal_invalid");
  }
  const reviewComment = normalizeReviewComment(value.reviewComment, writebackBinding.maxCommentChars);
  return Object.freeze({
    adapterIdentity,
    authorizeCurrentOperation: value.authorizeCurrentOperation,
    effect: value.effect,
    evidence,
    operationReceiptContext,
    recover: value.recover,
    reviewComment,
    signal: value.signal,
    task,
    triggerEvent,
    writebackBinding,
  });
}

function requireTask(value) {
  requirePlainObject(value, "trigger_review_writeback_task_invalid");
  if (value.channelId !== "trigger" || value.taskType !== "triggered_employee_task") {
    throw writebackError("trigger_review_writeback_task_invalid");
  }
  return Object.freeze({
    ...value,
    tenantScope: requiredToken(value.tenantScope, 160),
    taskId: requiredToken(value.taskId, 128),
    sourceSystemId: requiredToken(value.sourceSystemId, 160),
  });
}

function normalizeEvidence(value, task) {
  requireExactObject(value, EVIDENCE_FIELDS, "trigger_review_writeback_evidence_invalid");
  if (value.contractVersion !== REVIEW_RESULT_EVIDENCE_VERSION ||
    value.tenantScope !== task.tenantScope || value.taskId !== task.taskId) {
    throw writebackError("trigger_review_writeback_evidence_mismatch");
  }
  return Object.freeze({
    contractVersion: REVIEW_RESULT_EVIDENCE_VERSION,
    tenantScope: value.tenantScope,
    triggerEventId: requiredToken(value.triggerEventId, 240),
    taskId: value.taskId,
    reviewResultId: requiredToken(value.reviewResultId, 240),
    evidenceDigest: requiredDigest(value.evidenceDigest),
    sealedAt: requiredTimestamp(value.sealedAt),
  });
}

function normalizeStoredTriggerEvent(value, task, evidence) {
  requireExactObject(value, STORED_TRIGGER_EVENT_FIELDS, "trigger_review_writeback_event_invalid");
  const event = normalizeTriggerEvent(value.event);
  if (value.tenantScope !== task.tenantScope || value.triggerEventId !== evidence.triggerEventId ||
    value.externalEventId !== event.eventId) {
    throw writebackError("trigger_review_writeback_event_mismatch");
  }
  requirePlainObject(value.executionSnapshot, "trigger_review_writeback_event_invalid");
  if (value.executionSnapshot.bindingId !== value.bindingId) {
    throw writebackError("trigger_review_writeback_event_invalid");
  }
  return Object.freeze({
    bindingId: requiredToken(value.bindingId, 160),
    event,
    executionSnapshot: value.executionSnapshot,
    externalEventId: event.eventId,
    tenantScope: value.tenantScope,
    triggerEventId: value.triggerEventId,
  });
}

function normalizeAdapterIdentity(value) {
  requireExactObject(value, ADAPTER_IDENTITY_FIELDS, "trigger_review_writeback_adapter_identity_invalid");
  return Object.freeze({
    adapterId: requiredToken(value.adapterId, 160),
    actionCode: requiredToken(value.actionCode, 160),
    authorizationDigest: requiredDigest(value.authorizationDigest),
  });
}

function normalizeOperationReceiptContext(value, task) {
  requireExactObject(value, RECEIPT_CONTEXT_FIELDS, "trigger_review_writeback_receipt_context_invalid");
  requireExactObject(value.repositoryContext, REPOSITORY_CONTEXT_FIELDS,
    "trigger_review_writeback_receipt_context_invalid");
  const context = value.repositoryContext;
  if (context.tenantScope !== task.tenantScope || context.taskId !== task.taskId ||
    !Number.isSafeInteger(context.fencingToken) || context.fencingToken <= 0) {
    throw writebackError("trigger_review_writeback_receipt_context_mismatch");
  }
  return Object.freeze({ repositoryContext: Object.freeze({
    tenantScope: context.tenantScope,
    taskId: context.taskId,
    leaseId: requiredToken(context.leaseId, 128),
    workerIdDigest: requiredDigest(context.workerIdDigest),
    fencingToken: context.fencingToken,
  }) });
}

function projectSealedOperation(input) {
  const snapshot = input.triggerEvent.executionSnapshot;
  return {
    contractVersion: CONTRACT_VERSION,
    adapterIdentity: input.adapterIdentity,
    evidence: {
      contractVersion: input.evidence.contractVersion,
      evidenceDigest: input.evidence.evidenceDigest,
      reviewResultId: input.evidence.reviewResultId,
      sealedAt: input.evidence.sealedAt,
    },
    trigger: {
      triggerEventId: input.triggerEvent.triggerEventId,
      externalEventId: input.triggerEvent.externalEventId,
      eventType: input.triggerEvent.event.eventType,
      occurredAt: input.triggerEvent.event.occurredAt,
      bindingId: input.triggerEvent.bindingId,
      bindingVersion: snapshot.bindingVersion,
    },
    writebackBinding: input.writebackBinding,
  };
}

function projectSealedTargetScope(input) {
  const subject = input.triggerEvent.event.subject;
  return {
    tenantScope: input.task.tenantScope,
    sourceSystemId: input.writebackBinding.sourceSystemId,
    sourceTenantId: input.triggerEvent.event.sourceTenantId,
    objectApiName: subject.objectApiName,
    objectId: subject.objectId,
    approvalInstanceId: subject.approvalInstanceId,
    nodeApiName: subject.nodeApiName,
  };
}

function deriveToolCallId(input) {
  const digest = crypto.createHash("sha256").update(JSON.stringify([
    CONTRACT_VERSION,
    input.task.tenantScope,
    input.task.taskId,
    input.triggerEvent.triggerEventId,
  ])).digest("hex");
  return `trigger_review_writeback_${digest}`;
}

function normalizeEffectResult(value) {
  requireExactObject(value, EFFECT_RESULT_FIELDS, "trigger_review_writeback_effect_result_invalid");
  if (!OUTCOME_STATUSES.has(value.status) || !SAFE_CODE.test(String(value.safeResultCode || ""))) {
    throw writebackError("trigger_review_writeback_effect_result_invalid");
  }
  return Object.freeze({ status: value.status, safeResultCode: value.safeResultCode });
}

function normalizeReviewComment(value, maximum) {
  if (typeof value !== "string" || value !== value.trim() || !value || value.length > maximum ||
    /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/.test(value)) {
    throw writebackError("trigger_review_writeback_comment_invalid");
  }
  return value;
}

function requireExactObject(value, fields, code) {
  requirePlainObject(value, code);
  if (Object.keys(value).length !== fields.size || Object.keys(value).some((field) => !fields.has(field)) ||
    [...fields].some((field) => !Object.hasOwn(value, field))) {
    throw writebackError(code);
  }
}

function requirePlainObject(value, code) {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(value))) {
    throw writebackError(code);
  }
}

function requiredToken(value, maximum) {
  if (typeof value !== "string" || value !== value.trim() || !value || value.length > maximum ||
    !SAFE_TOKEN.test(value)) {
    throw writebackError("trigger_review_writeback_reference_invalid");
  }
  return value;
}

function requiredDigest(value) {
  const digest = String(value || "").trim().toLowerCase();
  if (!DIGEST.test(digest)) throw writebackError("trigger_review_writeback_digest_invalid");
  return digest;
}

function requiredTimestamp(value) {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value)) ||
    new Date(value).toISOString() !== value) {
    throw writebackError("trigger_review_writeback_timestamp_invalid");
  }
  return value;
}

function isAbortSignal(value) {
  return value && typeof value.aborted === "boolean" &&
    typeof value.addEventListener === "function" && typeof value.removeEventListener === "function";
}

function writebackError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

export {
  CONTRACT_VERSION as TRIGGER_REVIEW_WRITEBACK_EFFECT_CONTRACT_VERSION,
  SAFE_RECEIPT_VERSION as TRIGGER_REVIEW_WRITEBACK_SAFE_RECEIPT_CONTRACT_VERSION,
  createTriggerReviewWritebackEffect,
};
