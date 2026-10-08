import crypto from "node:crypto";

const CONTRACT_VERSION = "hr-training-callback-effect.v1";
const SAFE_RECEIPT_VERSION = "hr-training-callback-safe-receipt.v1";
const CONTENT_EVALUATION_CALLBACK_STATUSES = new Set([
  "CONTENT_EVALUATION_COMPLETED",
  "CONTENT_EVALUATION_FAILED",
]);
const INPUT_FIELDS = new Set([
  "authorizationDigest",
  "authorizeCurrentOperation",
  "body",
  "input",
  "operationReceiptContext",
  "signal",
  "task",
  "triggerEvent",
]);
const RECEIPT_CONTEXT_FIELDS = new Set(["repositoryContext"]);
const REPOSITORY_CONTEXT_FIELDS = new Set([
  "fencingToken",
  "leaseId",
  "taskId",
  "tenantScope",
  "workerIdDigest",
]);
const OUTCOME_STATUSES = new Set(["definitive_failed", "succeeded", "unknown"]);
const SAFE_TOKEN = /^[A-Za-z0-9][A-Za-z0-9._:@-]*$/;
const SAFE_CODE = /^[a-z][a-z0-9_]{1,119}$/;
const DIGEST = /^[a-f0-9]{64}$/;
const CONTENT_EVALUATION_RESULT_VERSION = "hr-training.content-evaluation-result.v1";
const FOLLOWUP_ANSWER_EVALUATION_RESULT_V1 = "hr-training.followup-answer-evaluation-result.v1";
const FOLLOWUP_ANSWER_EVALUATION_RESULT_V2 = "hr-training.followup-answer-evaluation-result.v2";
const FOLLOWUP_ANSWER_EVALUATION_RESULT_V3 = "hr-training.followup-answer-evaluation-result.v3";
const FOLLOWUP_ROUND_EVALUATION_RESULT_VERSION = "hr-training.followup-round-evaluation-result.v1";
const AGGREGATE_FEEDBACK_RESULT_VERSION = "hr-training.aggregate-feedback-result.v1";

function createHrTrainingCallbackEffect({
  apiKey,
  fetchImpl = globalThis.fetch,
  idempotentEffectService,
  operationReceiptProjector,
} = {}) {
  if (typeof idempotentEffectService?.execute !== "function") {
    throw new TypeError("HR Training callback effect requires idempotentEffectService.execute");
  }
  if (typeof operationReceiptProjector?.project !== "function") {
    throw new TypeError("HR Training callback effect requires operationReceiptProjector.project");
  }
  if (typeof fetchImpl !== "function") {
    throw new TypeError("HR Training callback effect requires fetch");
  }
  const serviceApiKey = requiredApiKey(apiKey);

  async function execute(value = {}) {
    const input = normalizeInput(value);
    const bodyDigest = digestCanonical(input.body);
    const receiptRequest = operationReceiptProjector.project({
      tenantScope: input.task.tenantScope,
      taskId: input.task.taskId,
      toolCallId: deriveToolCallId(input),
      effectKind: "external_write",
      adapterId: "hr-training-callback.v1",
      actionCode: callbackActionCode(input.input.capability, input.body.status),
      authorizationDigest: input.authorizationDigest,
      recoveryMode: "none",
      operation: {
        contractVersion: CONTRACT_VERSION,
        capability: input.input.capability,
        bodyDigest,
        status: input.body.status,
        promptVersion: input.body.promptVersion,
        triggerEventId: input.triggerEvent.triggerEventId,
      },
      targetScope: {
        tenantScope: input.task.tenantScope,
        sourceSystemId: "hr-train",
        capability: input.input.capability,
        callbackOrigin: input.input.callbackOrigin,
        callbackUrlDigest: input.input.callbackUrlDigest,
      },
    });

    return idempotentEffectService.execute({
      request: receiptRequest,
      repositoryContext: input.operationReceiptContext.repositoryContext,
      authorizeCurrentOperation: input.authorizeCurrentOperation,
      effect: async () => {
        const response = await fetchImpl(input.input.callbackUrl, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${serviceApiKey}`,
            "Content-Type": "application/json",
            "X-Capability": input.input.capability,
            "X-Idempotency-Key": callbackIdempotencyKey(input),
            "X-Run-Id": input.body.runId || input.task.taskId,
          },
          body: JSON.stringify(input.body),
          signal: input.signal || undefined,
        });
        const outcome = input.input.capability === "hr_training.content_evaluate.v1"
          ? await classifyContentEvaluationResponse(response, input.body.status)
          : classifyResponse(response);
        return Object.freeze({
          status: outcome.status,
          safeResultCode: outcome.safeResultCode,
          receiptPayload: outcome.status === "unknown" ? null : Object.freeze({
            contractVersion: SAFE_RECEIPT_VERSION,
            bodyDigest,
            status: input.body.status,
            ...outcome.receiptConfirmation,
          }),
        });
      },
    });
  }

  return Object.freeze({ contractVersion: CONTRACT_VERSION, execute });
}

function requiredApiKey(value) {
  if (typeof value !== "string" || value !== value.trim() || !value || value.length > 4096 || /[\r\n]/.test(value)) {
    throw new TypeError("HR Training callback effect requires service API key");
  }
  return value;
}

function normalizeInput(value) {
  requireExactObject(value, INPUT_FIELDS, "hr_training_callback_input_invalid");
  const task = normalizeTask(value.task);
  const input = normalizeRunInput(value.input);
  const body = normalizeCallbackBody(value.body, input);
  const triggerEvent = normalizeTriggerEvent(value.triggerEvent, task);
  const operationReceiptContext = normalizeReceiptContext(value.operationReceiptContext, task);
  const authorizationDigest = requiredDigest(value.authorizationDigest);
  if (typeof value.authorizeCurrentOperation !== "function") {
    throw effectError("hr_training_callback_authorizer_required");
  }
  if (value.signal !== null && value.signal !== undefined && !isAbortSignal(value.signal)) {
    throw effectError("hr_training_callback_signal_invalid");
  }
  return Object.freeze({
    authorizationDigest,
    authorizeCurrentOperation: value.authorizeCurrentOperation,
    body,
    input,
    operationReceiptContext,
    signal: value.signal || null,
    task,
    triggerEvent,
  });
}

function normalizeTask(value) {
  requirePlainObject(value, "hr_training_callback_task_invalid");
  if (value.channelId !== "trigger" || value.taskType !== "triggered_employee_task") {
    throw effectError("hr_training_callback_task_invalid");
  }
  return Object.freeze({
    ...value,
    tenantScope: requiredToken(value.tenantScope, "tenantScope", 160),
    taskId: requiredToken(value.taskId, "taskId", 128),
    sourceSystemId: requiredToken(value.sourceSystemId, "sourceSystemId", 120),
  });
}

function normalizeRunInput(value) {
  requirePlainObject(value, "hr_training_callback_run_input_invalid");
  return Object.freeze({
    callbackOrigin: requiredOrigin(value.callbackOrigin),
    callbackUrl: requiredCallbackUrl(value.callbackUrl),
    callbackUrlDigest: requiredDigest(value.callbackUrlDigest),
    capability: requiredToken(value.capability, "capability", 120),
    idempotencyKey: requiredToken(value.idempotencyKey, "idempotencyKey", 240),
    meetingRecordId: requiredToken(value.meetingRecordId, "meetingRecordId", 160),
    runInputId: requiredToken(value.runInputId, "runInputId", 160),
    sessionId: requiredToken(value.sessionId, "sessionId", 160),
    tenantScope: requiredToken(value.tenantScope, "tenantScope", 160),
  });
}

function normalizeCallbackBody(value, input) {
  requirePlainObject(value, "hr_training_callback_body_invalid");
  if (!["FAILED", "SUCCEEDED"].includes(value.status) ||
    value.sessionId !== input.sessionId || value.meetingRecordId !== input.meetingRecordId ||
    typeof value.promptVersion !== "string" || !value.promptVersion.trim()) {
    throw effectError("hr_training_callback_body_invalid");
  }
  if (value.contractVersion === CONTENT_EVALUATION_RESULT_VERSION) {
    return normalizeContentEvaluationCallbackBody(value);
  }
  if ([FOLLOWUP_ANSWER_EVALUATION_RESULT_V1, FOLLOWUP_ANSWER_EVALUATION_RESULT_V2, FOLLOWUP_ANSWER_EVALUATION_RESULT_V3].includes(value.contractVersion)) {
    return normalizeFollowupAnswerEvaluationCallbackBody(value);
  }
  if (value.contractVersion === FOLLOWUP_ROUND_EVALUATION_RESULT_VERSION) {
    return normalizeFollowupRoundEvaluationCallbackBody(value);
  }
  if (value.contractVersion === AGGREGATE_FEEDBACK_RESULT_VERSION) {
    return normalizeAggregateFeedbackCallbackBody(value);
  }
  throw effectError("hr_training_callback_body_invalid");
}

function normalizeAggregateFeedbackCallbackBody(value) {
  if (typeof value.runId !== "string" || !value.runId.trim() || value.resultKind !== "FINAL_SUGGESTION_SUMMARY") {
    throw effectError("hr_training_callback_body_invalid");
  }
  if (value.status === "FAILED") {
    requireExactObject(value, new Set([
      "contractVersion", "errorCode", "meetingRecordId", "message", "modelName", "promptVersion",
      "resultKind", "runId", "sessionId", "status",
    ]), "hr_training_callback_body_invalid");
    if (!/^[A-Z][A-Z0-9_]{1,119}$/.test(String(value.errorCode || "")) || !safeMessage(value.message) || typeof value.modelName !== "string") {
      throw effectError("hr_training_callback_body_invalid");
    }
  } else if (value.status === "SUCCEEDED") {
    requireExactObject(value, new Set([
      "contractVersion", "mainSuggestions", "meetingRecordId", "modelName", "promptVersion",
      "resultKind", "runId", "sessionId", "status",
    ]), "hr_training_callback_body_invalid");
    normalizeAggregateSuggestions(value.mainSuggestions);
  } else {
    throw effectError("hr_training_callback_body_invalid");
  }
  return deepFreeze(JSON.parse(JSON.stringify(value)));
}

function normalizeAggregateSuggestions(value) {
  if (!Array.isArray(value) || value.length < 1 || value.length > 5) throw effectError("hr_training_callback_body_invalid");
  for (const item of value) {
    requireExactObject(item, new Set(["actionPlan", "direction", "evidenceRefs", "scope"]), "hr_training_callback_body_invalid");
    if (typeof item.direction !== "string" || !safeMessage(item.direction) || !Array.isArray(item.actionPlan) || item.actionPlan.length < 1 || item.actionPlan.length > 4 || item.actionPlan.some((action) => !safeMessage(action)) || !["CONTENT", "FOLLOWUP", "CROSS_ROUND"].includes(item.scope) || !Array.isArray(item.evidenceRefs) || item.evidenceRefs.length < 1 || item.evidenceRefs.length > 4) {
      throw effectError("hr_training_callback_body_invalid");
    }
    for (const evidence of item.evidenceRefs) {
      requireExactObject(evidence, new Set(["questionId", "type"]), "hr_training_callback_body_invalid");
      if (!["CONTENT", "FOLLOWUP"].includes(evidence.type) ||
        (evidence.type === "CONTENT" && evidence.questionId !== null) ||
        (evidence.type === "FOLLOWUP" && (typeof evidence.questionId !== "string" || !SAFE_TOKEN.test(evidence.questionId)))) {
        throw effectError("hr_training_callback_body_invalid");
      }
    }
  }
}

function normalizeContentEvaluationCallbackBody(value) {
  if (typeof value.runId !== "string" || !value.runId.trim()) {
    throw effectError("hr_training_callback_body_invalid");
  }
  if (value.status === "FAILED") {
    const fields = new Set([
      "contractVersion",
      "errorCode",
      "meetingRecordId",
      "message",
      "modelName",
      "promptVersion",
      "runId",
      "sessionId",
      "status",
    ]);
    requireExactObject(value, fields, "hr_training_callback_body_invalid");
    if (!/^[A-Z][A-Z0-9_]{1,119}$/.test(String(value.errorCode || "")) ||
      !safeMessage(value.message) || typeof value.modelName !== "string") {
      throw effectError("hr_training_callback_body_invalid");
    }
  }
  if (value.status === "SUCCEEDED") {
    const fields = new Set([
      "contentScore",
      "contractVersion",
      "feedback",
      "meetingRecordId",
      "modelName",
      "promptVersion",
      "questions",
      "runId",
      "sessionId",
      "status",
    ]);
    requireExactObject(value, fields, "hr_training_callback_body_invalid");
  }
  return deepFreeze(JSON.parse(JSON.stringify(value)));
}

function normalizeFollowupAnswerEvaluationCallbackBody(value) {
  if (typeof value.runId !== "string" || !value.runId.trim()) {
    throw effectError("hr_training_callback_body_invalid");
  }
  if (typeof value.questionId !== "string" || !value.questionId.trim() ||
    typeof value.answerId !== "string" || !value.answerId.trim()) {
    throw effectError("hr_training_callback_body_invalid");
  }
  if (value.status === "FAILED") {
    const fields = new Set([
      "answerId",
      "contractVersion",
      "errorCode",
      "meetingRecordId",
      "message",
      "modelName",
      "promptVersion",
      "questionId",
      "runId",
      "sessionId",
      "status",
    ]);
    requireExactObject(value, fields, "hr_training_callback_body_invalid");
    if (!/^[A-Z][A-Z0-9_]{1,119}$/.test(String(value.errorCode || "")) ||
      !safeMessage(value.message) || typeof value.modelName !== "string") {
      throw effectError("hr_training_callback_body_invalid");
    }
  }
  if (value.status === "SUCCEEDED") {
    const fields = new Set([
      "answerId",
      "contractVersion",
      "feedback",
      "meetingRecordId",
      "modelName",
      "promptVersion",
      "questionId",
      "runId",
      "sessionId",
      "status",
    ]);
    if (value.contractVersion !== FOLLOWUP_ANSWER_EVALUATION_RESULT_V3) fields.add("questionScore");
    requireExactObject(value, fields, "hr_training_callback_body_invalid");
  }
  return deepFreeze(JSON.parse(JSON.stringify(value)));
}

function normalizeFollowupRoundEvaluationCallbackBody(value) {
  if (typeof value.runId !== "string" || !value.runId.trim() || value.resultKind !== "FOLLOWUP_ROUND_SCORE") {
    throw effectError("hr_training_callback_body_invalid");
  }
  if (value.status === "FAILED") {
    requireExactObject(value, new Set([
      "contractVersion", "errorCode", "meetingRecordId", "message", "modelName", "promptVersion",
      "resultKind", "runId", "sessionId", "status",
    ]), "hr_training_callback_body_invalid");
    if (!/^[A-Z][A-Z0-9_]{1,119}$/.test(String(value.errorCode || "")) ||
      !safeMessage(value.message) || typeof value.modelName !== "string") {
      throw effectError("hr_training_callback_body_invalid");
    }
  } else if (value.status === "SUCCEEDED") {
    requireExactObject(value, new Set([
      "contractVersion", "dimensionScores", "feedback", "meetingRecordId", "modelName", "promptVersion",
      "qaScore", "resultKind", "runId", "sessionId", "status",
    ]), "hr_training_callback_body_invalid");
    if (!Array.isArray(value.dimensionScores) || value.dimensionScores.length !== 4 ||
      !isPlainObject(value.qaScore) || !isPlainObject(value.feedback)) {
      throw effectError("hr_training_callback_body_invalid");
    }
  } else {
    throw effectError("hr_training_callback_body_invalid");
  }
  return deepFreeze(JSON.parse(JSON.stringify(value)));
}

function normalizeTriggerEvent(value, task) {
  requirePlainObject(value, "hr_training_callback_trigger_event_invalid");
  if (value.tenantScope !== task.tenantScope || value.executionSnapshot?.sourceSystemId !== "hr-train") {
    throw effectError("hr_training_callback_trigger_event_mismatch");
  }
  return Object.freeze({
    triggerEventId: requiredToken(value.triggerEventId, "triggerEventId", 240),
    executionSnapshot: value.executionSnapshot,
  });
}

function normalizeReceiptContext(value, task) {
  requireExactObject(value, RECEIPT_CONTEXT_FIELDS, "hr_training_callback_receipt_context_invalid");
  requireExactObject(value.repositoryContext, REPOSITORY_CONTEXT_FIELDS,
    "hr_training_callback_receipt_context_invalid");
  const context = value.repositoryContext;
  if (context.tenantScope !== task.tenantScope || context.taskId !== task.taskId ||
    !Number.isSafeInteger(context.fencingToken) || context.fencingToken <= 0) {
    throw effectError("hr_training_callback_receipt_context_mismatch");
  }
  return Object.freeze({ repositoryContext: Object.freeze({
    tenantScope: context.tenantScope,
    taskId: context.taskId,
    leaseId: requiredToken(context.leaseId, "leaseId", 128),
    workerIdDigest: requiredDigest(context.workerIdDigest),
    fencingToken: context.fencingToken,
  }) });
}

function classifyResponse(response) {
  const statusCode = Number(response?.status);
  if (statusCode >= 200 && statusCode <= 299) {
    return Object.freeze({ status: "succeeded", safeResultCode: "hr_training_callback_succeeded" });
  }
  if ([408, 425, 429].includes(statusCode) || statusCode >= 500 || !Number.isFinite(statusCode)) {
    return Object.freeze({ status: "unknown", safeResultCode: "hr_training_callback_retryable_failure" });
  }
  return Object.freeze({ status: "definitive_failed", safeResultCode: "hr_training_callback_rejected" });
}

async function classifyContentEvaluationResponse(response, callbackStatus) {
  const statusCode = Number(response?.status);
  if (statusCode < 200 || statusCode > 299) return classifyResponse(response);
  const confirmation = await readContentEvaluationConfirmation(response);
  if (!confirmation) {
    return Object.freeze({
      status: "unknown",
      safeResultCode: "hr_training_callback_receipt_unverifiable",
    });
  }
  if (confirmation.ignored) {
    return Object.freeze({
      status: "definitive_failed",
      safeResultCode: "hr_training_callback_ignored",
      receiptConfirmation: confirmation,
    });
  }
  if (confirmation.responseStatus !== expectedContentEvaluationStatus(callbackStatus)) {
    return Object.freeze({
      status: "unknown",
      safeResultCode: "hr_training_callback_receipt_unverifiable",
    });
  }
  return Object.freeze({
    status: "succeeded",
    safeResultCode: "hr_training_callback_accepted",
    receiptConfirmation: confirmation,
  });
}

async function readContentEvaluationConfirmation(response) {
  let value;
  try {
    value = await response?.json?.();
  } catch {
    return null;
  }
  const data = value?.data;
  if (!isPlainObject(data) || !CONTENT_EVALUATION_CALLBACK_STATUSES.has(data.status) ||
    (data.ignored !== undefined && typeof data.ignored !== "boolean") ||
    !Number.isSafeInteger(data.triggerAttempt) || data.triggerAttempt < 1) {
    return null;
  }
  return Object.freeze({
    ignored: data.ignored === true,
    responseStatus: data.status,
    triggerAttempt: data.triggerAttempt,
  });
}

function expectedContentEvaluationStatus(callbackStatus) {
  return callbackStatus === "SUCCEEDED"
    ? "CONTENT_EVALUATION_COMPLETED"
    : "CONTENT_EVALUATION_FAILED";
}

function callbackIdempotencyKey(input) {
  return input.input.idempotencyKey;
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype;
}

function callbackActionCode(capability, status) {
  if (capability === "hr_training.aggregate_feedback.v1") {
    return status === "SUCCEEDED"
      ? "deliver_aggregate_feedback_result"
      : "deliver_aggregate_feedback_failure";
  }
  if (capability === "hr_training.followup_answer_evaluate.v1") {
    return status === "SUCCEEDED"
      ? "deliver_followup_answer_evaluation_result"
      : "deliver_followup_answer_evaluation_failure";
  }
  if (capability === "hr_training.followup_round_evaluate.v1") {
    return status === "SUCCEEDED"
      ? "deliver_followup_round_evaluation_result"
      : "deliver_followup_round_evaluation_failure";
  }
  return status === "SUCCEEDED"
    ? "deliver_content_evaluation_result"
    : "deliver_content_evaluation_failure";
}

function deriveToolCallId(input) {
  const digest = crypto.createHash("sha256").update(JSON.stringify([
    CONTRACT_VERSION,
    input.task.tenantScope,
    input.task.taskId,
    input.triggerEvent.triggerEventId,
    input.body.status,
  ])).digest("hex");
  return `hr_training_callback_${digest.slice(0, 64)}`;
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
  const json = JSON.stringify(value);
  if (json === undefined) throw effectError("hr_training_callback_json_invalid");
  return json;
}

function safeMessage(value) {
  return typeof value === "string" && value === value.trim() && Boolean(value) &&
    value.length <= 500 && !/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/.test(value) &&
    !/(?:bearer\s+|sk-|rk-|xox[baprs]-|gh[pousr]_|glpat-|ya29\.|https?:\/\/)/i.test(value);
}

function requiredCallbackUrl(value) {
  if (typeof value !== "string" || value !== value.trim() || !value || value.length > 4096) {
    throw effectError("hr_training_callback_url_invalid");
  }
  const url = new URL(value);
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.hash) {
    throw effectError("hr_training_callback_url_invalid");
  }
  return url.toString();
}

function requiredOrigin(value) {
  if (typeof value !== "string" || value !== value.trim() || value.length > 240) {
    throw effectError("hr_training_callback_origin_invalid");
  }
  const url = new URL(value);
  if (url.origin !== value) throw effectError("hr_training_callback_origin_invalid");
  return value;
}

function requireExactObject(value, fields, code) {
  requirePlainObject(value, code);
  if (Object.keys(value).length !== fields.size || Object.keys(value).some((field) => !fields.has(field)) ||
    [...fields].some((field) => !Object.hasOwn(value, field))) {
    throw effectError(code);
  }
}

function requirePlainObject(value, code) {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(value))) {
    throw effectError(code);
  }
}

function requiredToken(value, field, maximum) {
  if (typeof value !== "string" || value !== value.trim() || !value ||
    value.length > maximum || !SAFE_TOKEN.test(value)) {
    throw effectError("hr_training_callback_reference_invalid", field);
  }
  return value;
}

function requiredDigest(value) {
  const digest = String(value || "").trim().toLowerCase();
  if (!DIGEST.test(digest)) throw effectError("hr_training_callback_digest_invalid");
  return digest;
}

function isAbortSignal(value) {
  return value && typeof value.aborted === "boolean" &&
    typeof value.addEventListener === "function";
}

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  Object.freeze(value);
  Object.values(value).forEach(deepFreeze);
  return value;
}

function effectError(code, message = code) {
  const error = new Error(message);
  error.code = SAFE_CODE.test(code) ? code : "hr_training_callback_failed";
  return error;
}

export {
  CONTRACT_VERSION as HR_TRAINING_CALLBACK_EFFECT_VERSION,
  SAFE_RECEIPT_VERSION as HR_TRAINING_CALLBACK_SAFE_RECEIPT_VERSION,
  createHrTrainingCallbackEffect,
};
