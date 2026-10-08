import crypto from "node:crypto";
import { AGENT_COMPLETION_CONTRACT_VERSION } from "../../agent-runtime/agent-completion-contract.mjs";
import {
  HR_TRAINING_FOLLOWUP_ANSWER_EVALUATION_PROMPT_VERSION,
  HR_TRAINING_FOLLOWUP_ANSWER_EVALUATION_RESULT_VERSION,
  normalizeFollowupAnswerEvaluationContext,
  projectFollowupAnswerPromptContext,
} from "./followup-answer-evaluation-output-policy.mjs";
import { assertFullPromptCoverage } from "./locked-material-coverage.mjs";
import {
  HR_TRAINING_FOLLOWUP_ANSWER_EVALUATION_RESULT_RECORD_VERSION,
} from "./followup-answer-evaluation-result-repository.mjs";
import { defaultEvaluationContextFetcher } from "./content-evaluation-trigger-handler.mjs";

const HANDLER_CONTRACT_VERSION = "trigger-executor-handler.v1";
const EXECUTION_CONTRACT_VERSION = "trigger-handler-execution.v1";
const TASK_DEFINITION_ID = "hr-training-followup-answer-evaluation-v1";
const HANDLER_VERSION = "hr-training-followup-answer-evaluation-handler-v4";
const CAPABILITY = "hr_training.followup_answer_evaluate.v1";
const SAFE_CODE = /^[a-z][a-z0-9_]{1,119}$/;
const DIGEST = /^[a-f0-9]{64}$/;
const EXECUTION_FIELDS = new Set([
  "context",
  "contractVersion",
  "isCancellationRequested",
  "operationReceiptContext",
  "signal",
  "task",
]);

function createHrTrainingFollowupAnswerEvaluationTriggerHandler({
  agentExecutionService,
  callbackAuthorizationDigest,
  callbackEffect,
  currentCallbackAuthorization,
  enabled,
  evaluationContextFetcher = defaultEvaluationContextFetcher,
  fetchImpl = globalThis.fetch,
  handlerVersion = HANDLER_VERSION,
  inputRepository,
  outputPolicy,
  providerLeaseResolver,
  resultRepository,
  reviewStatus,
  scheduleRetry,
  evaluationSkillContextResolver,
  taskDefinitionId = TASK_DEFINITION_ID,
} = {}) {
  requireMethod(agentExecutionService, "buildPrompt");
  requireMethod(agentExecutionService, "execute");
  requireFunction(callbackAuthorizationDigest, "callbackAuthorizationDigest");
  requireMethod(callbackEffect, "execute");
  requireFunction(currentCallbackAuthorization, "currentCallbackAuthorization");
  requireFunction(evaluationContextFetcher, "evaluationContextFetcher");
  if (typeof fetchImpl !== "function") throw new TypeError("HR Training followup answer handler requires fetch");
  requireMethod(inputRepository, "getInternal");
  requireMethod(outputPolicy, "normalizeResult");
  requireMethod(outputPolicy, "outputFormat");
  requireMethod(evaluationSkillContextResolver, "resolve");
  requireFunction(providerLeaseResolver, "providerLeaseResolver");
  requireMethod(resultRepository, "getInternal");
  requireMethod(resultRepository, "saveOrGet");
  requireFunction(scheduleRetry, "scheduleRetry");
  if (typeof enabled !== "boolean" ||
    !["approved", "pending_review", "rejected"].includes(reviewStatus)) {
    throw new TypeError("HR Training followup answer handler governance invalid");
  }
  const exactTaskDefinitionId = requiredToken(taskDefinitionId, 160);
  const exactHandlerVersion = requiredToken(handlerVersion, 80);

  async function execute(value) {
    let request;
    try {
      request = normalizeExecution(value);
      if (request.context.taskDefinition.taskDefinitionId !== exactTaskDefinitionId ||
        request.context.taskDefinition.handlerVersion !== exactHandlerVersion ||
        request.context.triggerEvent.event.eventType !== CAPABILITY) {
        throw new TypeError("HR Training followup answer Trigger task mismatch");
      }
    } catch {
      return blockedSettlement("hr_training_followup_answer_context_invalid");
    }
    if (canceled(request)) return canceledSettlement();

    let input;
    try {
      input = inputRepository.getInternal({
        tenantScope: request.task.tenantScope,
        runInputId: request.context.triggerEvent.event.subject.objectId,
      });
      if (!input || input.tenantScope !== request.task.tenantScope ||
        input.runInputId !== request.context.triggerEvent.event.subject.objectId ||
        input.capability !== CAPABILITY) {
        throw new Error("input mismatch");
      }
    } catch {
      return failedSettlement("hr_training_followup_answer_input_unavailable");
    }

    let existing;
    try {
      existing = resultRepository.getInternal(resultIdentity(request));
    } catch {
      return failedSettlement("hr_training_followup_answer_result_persistence_failed");
    }
    if (existing) {
      return deliverCallback({
        body: existing.result,
        input,
        request,
        terminalEvidenceDigest: existing.evidenceDigest,
        terminalStatus: existing.result.status === "SUCCEEDED" ? "completed" : "failed",
      });
    }

    let rawContext;
    let contextIdentity = fallbackIdentity();
    try {
      rawContext = await evaluationContextFetcher({
        apiKey: process.env.HR_TRAINING_SERVICE_API_KEY,
        contextUrl: input.contextUrl,
        fetchImpl,
        signal: request.signal,
      });
      contextIdentity = extractContextIdentity(rawContext);
    } catch (error) {
      const code = safeExecutionCode(error, "hr_training_followup_answer_context_fetch_failed");
      if (code === "hr_training_evaluation_context_not_ready") {
        return waitForEvaluationContext({ error, request, scheduleRetry });
      }
      return failWithCallback({
        errorCode: publicErrorCode(code),
        input,
        message: publicMessage(code),
        request,
        ...contextIdentity,
      });
    }

    let context;
    const expected = {
      meetingRecordId: input.meetingRecordId,
      sessionId: input.sessionId,
      ...contextIdentity,
    };
    try {
      context = normalizeFollowupAnswerEvaluationContext(rawContext, expected);
    } catch (error) {
      const code = safeExecutionCode(error, "hr_training_followup_answer_context_invalid");
      return failWithCallback({
        errorCode: publicErrorCode(code),
        input,
        message: publicMessage(code),
        request,
        ...contextIdentity,
      });
    }
    if (canceled(request)) return canceledSettlement();

    let result;
    let lease;
    try {
      lease = await providerLeaseResolver({
        employee: request.context.employee,
        runtimeTask: request.task,
      });
      if (!lease) return blockedSettlement("hr_training_followup_answer_provider_unavailable");
      const candidateEvaluator = ({ text }) => {
        try {
          return Object.freeze({
            status: "accepted",
            value: outputPolicy.normalizeResult({
              context,
              expected,
              modelName: modelNameFromLease(lease),
              text,
            }),
          });
        } catch (error) {
          return Object.freeze({
            status: "repairable",
            code: safeExecutionCode(error, "hr_training_followup_answer_model_output_invalid"),
            issues: typeof outputPolicy.candidateIssues === "function"
              ? outputPolicy.candidateIssues({ context, expected, text })
              : [],
          });
        }
      };
      const dependencyContext = evaluationSkillContextResolver.resolve({
        capability: CAPABILITY,
        employee: request.context.employee,
        task: request.task,
        taskDefinition: request.context.taskDefinition,
        triggerEvent: request.context.triggerEvent,
      });
      const prompt = agentExecutionService.buildPrompt({
        candidateEvaluator,
        completionContract: {
          contractVersion: AGENT_COMPLETION_CONTRACT_VERSION,
          maxCandidateRepairRounds: 1,
          maxEvidenceContinuationRounds: 0,
          requiredEvidence: [],
        },
        conversationHistory: [],
        dependencyContext,
        employeeIdentity: employeeIdentity(request.context.employee, request.task),
        lease,
        maxOutputTokens: outputPolicy.maxOutputTokens || 1800,
        outputFormat: outputPolicy.outputFormat({
          context,
          expected,
          taskDefinition: request.context.taskDefinition,
        }),
        references: [],
        runtimeContext: {
          currentTurn: {
            text: buildEvaluationPrompt({
              context,
              expected,
            }),
          },
        },
        safeContext: {
          contractVersion: "hr-training-trigger-safe-context.v1",
          dependencyContext,
          trigger: {
            sourceSystemId: "hr-train",
            capability: CAPABILITY,
            taskDefinitionId: request.context.taskDefinition.taskDefinitionId,
            bindingId: request.context.binding.bindingId,
          },
        },
        stream: false,
        toolExecutor: null,
      });
      assertFullPromptCoverage({
        codePrefix: "hr_training_followup_answer_context",
        lease,
        prompt,
      });
      const agentResult = await agentExecutionService.execute({
        lease,
        prompt,
        runtimeTask: request.task,
        signal: request.signal,
        toolExecutor: null,
      });
      if (agentResult?.partial === true || agentResult?.reason === "agent_turn_canceled") {
        return agentResult?.reason === "agent_turn_canceled"
          ? canceledSettlement()
          : failedSettlement("hr_training_followup_answer_partial_result");
      }
      result = agentResult?.completionOutcome?.contractVersion === HR_TRAINING_FOLLOWUP_ANSWER_EVALUATION_RESULT_VERSION
        ? agentResult.completionOutcome
        : outputPolicy.normalizeResult({
          context,
          expected,
          modelName: modelNameFromLease(lease),
          text: agentResult?.text,
        });
    } catch (error) {
      const code = safeExecutionCode(error, "hr_training_followup_answer_model_output_invalid");
      const candidateIssues = candidateIssuesFromError(error);
      return failWithCallback({
        answerId: expected.answerId,
        errorCode: publicErrorCode(code, candidateIssues),
        input,
        message: publicMessage(publicErrorCode(code, candidateIssues)),
        modelName: modelNameFromLease(lease),
        questionId: expected.questionId,
        request,
      });
    }
    if (canceled(request)) return canceledSettlement();

    let stored;
    try {
      stored = resultRepository.saveOrGet({
        contractVersion: HR_TRAINING_FOLLOWUP_ANSWER_EVALUATION_RESULT_RECORD_VERSION,
        ...resultIdentity(request),
        result,
      });
    } catch {
      return failedSettlement("hr_training_followup_answer_result_persistence_failed");
    }
    return deliverCallback({
      body: stored.result,
      input,
      request,
      terminalEvidenceDigest: stored.evidence.evidenceDigest,
      terminalStatus: "completed",
    });
  }

  async function deliverCallback({ body, input, request, terminalEvidenceDigest = null, terminalStatus }) {
    let writeback;
    try {
      const callbackBody = Object.freeze({
        ...body,
        // The canonical Center task id is the run id HR Train expects in its callback envelope.
        runId: request.task.taskId,
      });
      const authorizationDigest = callbackAuthorizationDigest({
        input,
        triggerEvent: request.context.triggerEvent,
      });
      writeback = await callbackEffect.execute({
        authorizationDigest,
        authorizeCurrentOperation: (receiptRequest) => currentCallbackAuthorization({
          authorizationDigest: receiptRequest.authorizationDigest,
          input,
          triggerEvent: request.context.triggerEvent,
        }),
        body: callbackBody,
        input,
        operationReceiptContext: request.operationReceiptContext,
        signal: request.signal,
        task: request.task,
        triggerEvent: request.context.triggerEvent,
      });
    } catch (error) {
      return failedSettlement(safeExecutionCode(error, "hr_training_callback_failed"));
    }
    if (!writeback || !["succeeded", "definitive_failed", "unknown"].includes(writeback.status) ||
      writeback.receipt?.status !== writeback.status ||
      !SAFE_CODE.test(String(writeback.receipt?.safeResultCode || ""))) {
      return blockedSettlement("hr_training_callback_outcome_unknown");
    }
    if (writeback.status === "unknown") return blockedSettlement("hr_training_callback_outcome_unknown");
    if (writeback.status === "definitive_failed") {
      return failedSettlement(writeback.receipt.safeResultCode);
    }
    if (terminalStatus === "failed") {
      return failedSettlement(String(body.errorCode || "HR_TRAINING_FOLLOWUP_ANSWER_FAILED").toLowerCase());
    }
    return completedSettlement(terminalEvidenceDigest || digestCanonical(body));
  }

  async function failWithCallback({ answerId = "unknown", errorCode, input, message, modelName = "",
    questionId = "unknown", request }) {
    const body = failureCallbackBody({
      answerId,
      errorCode,
      input,
      message,
      modelName,
      questionId,
    });
    return deliverCallback({
      body,
      input,
      request,
      terminalStatus: "failed",
    });
  }

  return Object.freeze({
    contractVersion: HANDLER_CONTRACT_VERSION,
    taskDefinitionId: exactTaskDefinitionId,
    handlerVersion: exactHandlerVersion,
    enabled,
    reviewStatus,
    execute,
  });
}

function buildEvaluationPrompt({ context, expected }) {
  return [
    "评估输出必须使用以下 sessionId/meetingRecordId/questionId/answerId：",
    JSON.stringify(expected),
    "本能力只输出当前题的即时反馈，不输出 questionScore 或任何正式分。学员主反馈字段语义固定：strengths=优势，gaps=不足，suggestions=改进建议；materialGrounding 仅作资料校验依据，不作为主反馈标题。",
    "",
    "HR Training followupAnswerEvaluationContext（不得回显 URL、Prompt 或系统字段；只评当前题）：",
    JSON.stringify(projectFollowupAnswerPromptContext(context)),
  ].join("\n");
}

function employeeIdentity(employee = {}, task = {}) {
  return Object.freeze({
    id: task.employeeId || cleanId(employee.id),
    name: cleanText(employee.name),
    status: cleanId(employee.status),
    version: task.employeeVersion || cleanId(employee.version),
    businessDomain: cleanId(employee.businessDomain),
    departmentId: cleanId(employee.departmentId),
    ownerDepartmentId: cleanId(employee.ownerDepartmentId),
    ownerUserId: cleanId(employee.ownerUserId),
    permissionScope: Array.isArray(employee.permissionScope) ? employee.permissionScope.map(cleanId).filter(Boolean) : [],
    title: cleanText(employee.title),
    objective: cleanText(employee.objective),
  });
}

function failureCallbackBody({ answerId, errorCode, input, message, modelName, questionId }) {
  return Object.freeze({
    contractVersion: HR_TRAINING_FOLLOWUP_ANSWER_EVALUATION_RESULT_VERSION,
    sessionId: input.sessionId,
    meetingRecordId: input.meetingRecordId,
    questionId: safeResultId(questionId),
    answerId: safeResultId(answerId),
    status: "FAILED",
    errorCode,
    message,
    modelName: String(modelName || "").trim().slice(0, 120),
    promptVersion: HR_TRAINING_FOLLOWUP_ANSWER_EVALUATION_PROMPT_VERSION,
  });
}

function extractContextIdentity(value) {
  const context = isPlainObject(value?.data) ? value.data
    : isPlainObject(value?.context) ? value.context
      : value;
  if (!isPlainObject(context)) return fallbackIdentity();
  const followupAnswer = isPlainObject(context.followupAnswer) ? context.followupAnswer : {};
  const question = context.currentQuestion || context.question || context.followupQuestion || followupAnswer;
  const answer = context.currentAnswer || context.answer || context.followupAnswer || {};
  return Object.freeze({
    questionId: safeResultId(question.questionId || question.id),
    answerId: safeResultId(answer.answerId || answer.id),
  });
}

function fallbackIdentity() {
  return Object.freeze({ questionId: "unknown", answerId: "unknown" });
}

function safeResultId(value) {
  const text = String(value || "").trim();
  return /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,159}$/.test(text) ? text : "unknown";
}

function normalizeExecution(value) {
  requireExactObject(value, EXECUTION_FIELDS, "HR Training followup answer Trigger execution");
  if (value.contractVersion !== EXECUTION_CONTRACT_VERSION ||
    typeof value.isCancellationRequested !== "function" || !isAbortSignal(value.signal) ||
    !isPlainObject(value.context) || !isPlainObject(value.context.binding) ||
    !isPlainObject(value.context.employee) || !isPlainObject(value.context.taskDefinition) ||
    !isPlainObject(value.context.triggerEvent) || !isPlainObject(value.task)) {
    throw new TypeError("HR Training followup answer Trigger execution invalid");
  }
  const repository = value.operationReceiptContext?.repositoryContext;
  if (!isPlainObject(repository) || repository.taskId !== value.task.taskId ||
    repository.tenantScope !== value.task.tenantScope || !DIGEST.test(repository.workerIdDigest) ||
    !Number.isSafeInteger(repository.fencingToken) || repository.fencingToken <= 0) {
    throw new TypeError("HR Training followup answer Trigger receipt context invalid");
  }
  requiredToken(repository.leaseId, 128);
  return value;
}

function resultIdentity(request) {
  return Object.freeze({
    tenantScope: requiredToken(request.task.tenantScope, 160),
    triggerEventId: requiredToken(request.context.triggerEvent.triggerEventId, 240),
    taskId: requiredToken(request.task.taskId, 128),
  });
}

function waitForEvaluationContext({ error, request, scheduleRetry }) {
  try {
    scheduleRetry({
      delayMs: clampRetryDelay(error?.retryAfterMs),
      task: request.task,
    });
  } catch {
    return blockedSettlement("hr_training_evaluation_context_retry_unavailable");
  }
  return Object.freeze({
    status: "waiting",
    waitReasonCode: "hr_training_evaluation_context_not_ready",
    lastErrorCode: "hr_training_evaluation_context_not_ready",
    resultSummary: "hr_training_evaluation_context_not_ready",
    terminalEvidenceDigest: null,
  });
}

function clampRetryDelay(value) {
  const delay = Number(value);
  if (!Number.isFinite(delay)) return 30_000;
  return Math.max(5_000, Math.min(300_000, Math.round(delay)));
}

function modelNameFromLease(lease) {
  return String(lease?.model || lease?.modelId || "").trim().slice(0, 120);
}

function publicErrorCode(code, candidateIssues = []) {
  const issues = new Set([String(code || "").trim(), ...(Array.isArray(candidateIssues) ? candidateIssues : [])]);
  if (issues.has("invalid_json")) return "MODEL_OUTPUT_JSON_INVALID";
  if (issues.has("forbidden_result_field") || issues.has("hr_training_followup_answer_forbidden_result_field")) {
    return "MODEL_OUTPUT_FORBIDDEN_FIELD";
  }
  if (issues.has("hr_training_followup_answer_material_grounding_invalid")) {
    return "MODEL_OUTPUT_MATERIAL_GROUNDING_INVALID";
  }
  if (issues.has("hr_training_followup_answer_feedback_invalid") ||
    issues.has("hr_training_followup_answer_string_list_invalid")) {
    return "MODEL_OUTPUT_FEEDBACK_INVALID";
  }
  if (issues.has("hr_training_followup_answer_text_invalid")) return "MODEL_OUTPUT_TEXT_INVALID";
  return ({
    hr_training_api_key_unconfigured: "HR_TRAINING_SERVICE_API_KEY_UNCONFIGURED",
    hr_training_evaluation_context_not_ready: "EVALUATION_CONTEXT_NOT_READY",
    hr_training_followup_answer_context_attempt_mismatch: "EVALUATION_CONTEXT_INVALID",
    hr_training_followup_answer_context_contract_invalid: "EVALUATION_CONTEXT_INVALID",
    hr_training_followup_answer_context_fetch_failed: "EVALUATION_CONTEXT_FETCH_FAILED",
    hr_training_followup_answer_context_identity_mismatch: "EVALUATION_CONTEXT_INVALID",
    hr_training_followup_answer_context_invalid: "EVALUATION_CONTEXT_INVALID",
    hr_training_followup_answer_context_material_missing: "EVALUATION_CONTEXT_INVALID",
    hr_training_followup_answer_context_material_content_missing: "EVALUATION_CONTEXT_COVERAGE_INSUFFICIENT",
    hr_training_followup_answer_context_material_coverage_incomplete: "EVALUATION_CONTEXT_COVERAGE_INSUFFICIENT",
    hr_training_followup_answer_context_provider_context_capability_unavailable: "EVALUATION_CONTEXT_CAPABILITY_UNAVAILABLE",
    hr_training_followup_answer_context_provider_context_coverage_insufficient: "EVALUATION_CONTEXT_COVERAGE_INSUFFICIENT",
    hr_training_followup_answer_context_qa_policy_missing: "EVALUATION_CONTEXT_INVALID",
    hr_training_followup_answer_context_rubric_missing: "EVALUATION_CONTEXT_INVALID",
    hr_training_followup_answer_context_session_mismatch: "EVALUATION_CONTEXT_INVALID",
    hr_training_followup_answer_model_output_invalid: "MODEL_OUTPUT_INVALID",
  })[code] || (code.includes("context") ? "EVALUATION_CONTEXT_INVALID" : "MODEL_OUTPUT_INVALID");
}

function candidateIssuesFromError(error) {
  return Object.freeze([...(Array.isArray(error?.completionCandidateIssues)
    ? error.completionCandidateIssues
    : [])]
    .map((issue) => String(issue || "").trim())
    .filter((issue) => SAFE_CODE.test(issue))
    .slice(0, 8));
}

function publicMessage(code) {
  return ({
    hr_training_api_key_unconfigured: "Center HR Training service credential is not configured.",
    hr_training_evaluation_context_not_ready: "HR Train answer evaluation context is not ready.",
    hr_training_followup_answer_context_fetch_failed: "Center could not fetch the HR Train answer evaluation context.",
    hr_training_followup_answer_context_material_content_missing: "Locked course material content is missing, so complete coverage cannot be confirmed.",
    hr_training_followup_answer_context_material_coverage_incomplete: "Locked course material does not prove complete coverage, so this answer was not evaluated.",
    hr_training_followup_answer_context_provider_context_capability_unavailable: "The current model has no declared context capacity, so complete material coverage cannot be confirmed.",
    hr_training_followup_answer_context_provider_context_coverage_insufficient: "The current model context is insufficient to cover the complete locked course material, so this answer was not evaluated.",
    hr_training_followup_answer_model_output_invalid: "The model output did not match the HR Training follow-up answer evaluation contract.",
    MODEL_OUTPUT_FEEDBACK_INVALID: "The model feedback structure did not match the HR Training follow-up answer evaluation contract.",
    MODEL_OUTPUT_FORBIDDEN_FIELD: "The model output contained a field that is not allowed for follow-up feedback.",
    MODEL_OUTPUT_JSON_INVALID: "The model output was not valid structured JSON.",
    MODEL_OUTPUT_MATERIAL_GROUNDING_INVALID: "The model material-grounding structure did not match the follow-up feedback contract.",
    MODEL_OUTPUT_TEXT_INVALID: "The model feedback text did not meet the safe follow-up feedback contract.",
  })[code] || (code.includes("context")
    ? "HR Train answer evaluation context is invalid."
    : "The follow-up answer evaluation could not be completed.");
}

function canceled(request) {
  return request.signal.aborted || request.isCancellationRequested?.() === true;
}

function completedSettlement(terminalEvidenceDigest) {
  return Object.freeze({
    status: "completed",
    resultSummary: "hr_training_followup_answer_evaluation_callback_delivered",
    terminalEvidenceDigest,
  });
}

function failedSettlement(code) {
  return Object.freeze({
    status: "failed",
    lastErrorCode: safeExecutionCode({ code }, "hr_training_followup_answer_failed"),
    resultSummary: safeExecutionCode({ code }, "hr_training_followup_answer_failed"),
    terminalEvidenceDigest: null,
  });
}

function blockedSettlement(code) {
  return Object.freeze({
    status: "blocked",
    lastErrorCode: safeExecutionCode({ code }, "hr_training_followup_answer_blocked"),
    resultSummary: safeExecutionCode({ code }, "hr_training_followup_answer_blocked"),
    terminalEvidenceDigest: null,
  });
}

function canceledSettlement() {
  return Object.freeze({
    status: "canceled",
    resultSummary: "agent_turn_canceled",
    terminalEvidenceDigest: null,
  });
}

function digestCanonical(value) {
  return crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function cleanId(value) {
  return String(value || "").trim().slice(0, 160);
}

function cleanText(value) {
  return String(value || "").trim().slice(0, 240);
}

function requiredToken(value, maximum) {
  const text = String(value || "").trim();
  if (!text || text.length > maximum || /[\s\u0000-\u001f\u007f]/.test(text)) {
    throw new TypeError("HR Training followup answer token invalid");
  }
  return text;
}

function safeExecutionCode(error, fallback) {
  const code = String(error?.code || "");
  return SAFE_CODE.test(code) ? code : fallback;
}

function requireMethod(value, method) {
  if (typeof value?.[method] !== "function") {
    throw new TypeError(`HR Training followup answer handler requires ${method}`);
  }
}

function requireFunction(value, name) {
  if (typeof value !== "function") throw new TypeError(`HR Training followup answer handler requires ${name}`);
}

function requireExactObject(value, fields, label) {
  if (!isPlainObject(value) || Object.keys(value).length !== fields.size ||
    Object.keys(value).some((field) => !fields.has(field)) ||
    [...fields].some((field) => !Object.hasOwn(value, field))) {
    throw new TypeError(`${label} invalid`);
  }
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value) &&
    [Object.prototype, null].includes(Object.getPrototypeOf(value));
}

function isAbortSignal(value) {
  return value && typeof value.aborted === "boolean" &&
    typeof value.addEventListener === "function";
}

export {
  CAPABILITY as HR_TRAINING_FOLLOWUP_ANSWER_EVALUATION_CAPABILITY,
  HANDLER_VERSION as HR_TRAINING_FOLLOWUP_ANSWER_EVALUATION_HANDLER_VERSION,
  TASK_DEFINITION_ID as HR_TRAINING_FOLLOWUP_ANSWER_EVALUATION_TASK_DEFINITION_ID,
  createHrTrainingFollowupAnswerEvaluationTriggerHandler,
};
