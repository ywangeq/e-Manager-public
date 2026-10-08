import { AGENT_COMPLETION_CONTRACT_VERSION } from "../../agent-runtime/agent-completion-contract.mjs";
import { defaultEvaluationContextFetcher } from "./content-evaluation-trigger-handler.mjs";
import {
  HR_TRAINING_FOLLOWUP_ROUND_EVALUATION_PROMPT_VERSION,
  HR_TRAINING_FOLLOWUP_ROUND_EVALUATION_RESULT_VERSION,
  normalizeFollowupRoundEvaluationContext,
  projectFollowupRoundContextMetadata,
  projectFollowupRoundPromptContext,
} from "./followup-round-evaluation-output-policy.mjs";
import { assertFullPromptCoverage } from "./locked-material-coverage.mjs";

const CAPABILITY = "hr_training.followup_round_evaluate.v1";
const TASK_DEFINITION_ID = "hr-training-followup-round-evaluation-v1";
const HANDLER_VERSION = "hr-training-followup-round-evaluation-handler-v4";
const SAFE_CODE = /^[a-z][a-z0-9_]{1,119}$/;

function createHrTrainingFollowupRoundEvaluationTriggerHandler({
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
  for (const [value, method] of [
    [agentExecutionService, "buildPrompt"], [agentExecutionService, "execute"],
    [callbackEffect, "execute"], [inputRepository, "getInternal"],
    [outputPolicy, "normalizeResult"], [outputPolicy, "outputFormat"],
    [resultRepository, "getInternal"], [resultRepository, "saveOrGet"],
    [evaluationSkillContextResolver, "resolve"],
  ]) {
    if (typeof value?.[method] !== "function") {
      throw new TypeError(`HR Training followup round handler requires ${method}`);
    }
  }
  for (const value of [
    callbackAuthorizationDigest, currentCallbackAuthorization, evaluationContextFetcher,
    providerLeaseResolver, scheduleRetry,
  ]) {
    if (typeof value !== "function") throw new TypeError("HR Training followup round handler dependency invalid");
  }
  if (typeof fetchImpl !== "function" || typeof enabled !== "boolean" ||
    !["approved", "pending_review", "rejected"].includes(reviewStatus)) {
    throw new TypeError("HR Training followup round handler governance invalid");
  }
  const definitionId = requiredToken(taskDefinitionId);
  const version = requiredToken(handlerVersion);

  async function execute(request) {
    let input = null;
    try {
      assertRequest(request, definitionId, version);
      if (canceled(request)) return canceledSettlement();
      input = inputRepository.getInternal({
        tenantScope: request.task.tenantScope,
        runInputId: request.context.triggerEvent.event.subject.objectId,
      });
      if (!input || input.capability !== CAPABILITY || input.tenantScope !== request.task.tenantScope) {
        throw new Error("input");
      }
      const identity = {
        tenantScope: request.task.tenantScope,
        triggerEventId: request.context.triggerEvent.triggerEventId,
        taskId: request.task.taskId,
      };
      const stored = resultRepository.getInternal(identity);
      if (stored) {
        return deliver({ body: stored.result, input, request, terminalEvidenceDigest: stored.evidence.evidenceDigest });
      }
      let rawContext;
      try {
        rawContext = await evaluationContextFetcher({
          apiKey: process.env.HR_TRAINING_SERVICE_API_KEY,
          contextUrl: input.contextUrl,
          fetchImpl,
          signal: request.signal,
        });
      } catch (error) {
        if (safeCode(error, "hr_training_followup_round_context_fetch_failed") === "hr_training_evaluation_context_not_ready") {
          return waitForContext(request);
        }
        return failWithCallback({ code: "EVALUATION_CONTEXT_FETCH_FAILED", input, request });
      }
      const expected = { sessionId: input.sessionId, meetingRecordId: input.meetingRecordId };
      let context;
      try {
        context = normalizeFollowupRoundEvaluationContext(rawContext, expected);
      } catch (error) {
        return failWithCallback({
          code: safeCode(error, "hr_training_followup_round_context_invalid") ===
            "hr_training_followup_round_context_incomplete"
            ? "EVALUATION_CONTEXT_INCOMPLETE"
            : "EVALUATION_CONTEXT_INVALID",
          input,
          request,
        });
      }
      if (canceled(request)) return canceledSettlement();
      const lease = await providerLeaseResolver({ employee: request.context.employee, runtimeTask: request.task });
      if (!lease) return blockedSettlement("hr_training_followup_round_provider_unavailable");
      const dependencyContext = evaluationSkillContextResolver.resolve({
        capability: CAPABILITY,
        employee: request.context.employee,
        task: request.task,
        taskDefinition: request.context.taskDefinition,
        triggerEvent: request.context.triggerEvent,
      });
      let candidate;
      const candidateEvaluator = ({ text }) => {
        try {
          candidate = outputPolicy.normalizeResult({ context, expected, modelName: modelName(lease), text });
          return Object.freeze({ status: "accepted", value: candidate });
        } catch (error) {
          return Object.freeze({
            status: "repairable",
            code: safeCode(error, "hr_training_followup_round_model_output_invalid"),
            issues: outputPolicy.candidateIssues({ context, expected, text }),
          });
        }
      };
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
        maxOutputTokens: outputPolicy.maxOutputTokens || 2400,
        outputFormat: outputPolicy.outputFormat({
          context, expected, taskDefinition: request.context.taskDefinition,
        }),
        references: [],
        runtimeContext: {
          currentTurn: {
            text: buildPrompt({ context, expected }),
          },
        },
        safeContext: {
          contractVersion: "hr-training-trigger-safe-context.v1",
          dependencyContext,
          trigger: {
            sourceSystemId: "hr-train",
            capability: CAPABILITY,
            taskDefinitionId: definitionId,
            bindingId: request.context.binding.bindingId,
            followupRoundContextProjection: {
              contractVersion: "hr-training-followup-round-context-projection.v1",
              handlerVersion: version,
              skillPolicyRef: request.context.taskDefinition.skillPolicyRef,
              outputPolicyRef: request.context.taskDefinition.outputPolicyRef,
              ...projectFollowupRoundContextMetadata(context),
            },
          },
        },
        stream: false,
        toolExecutor: null,
      });
      assertFullPromptCoverage({ codePrefix: "hr_training_followup_round_context", lease, prompt });
      const agentResult = await agentExecutionService.execute({
        lease, prompt, runtimeTask: request.task, signal: request.signal, toolExecutor: null,
      });
      if (agentResult?.partial || agentResult?.reason === "agent_turn_canceled") {
        return agentResult?.reason === "agent_turn_canceled"
          ? canceledSettlement()
          : failWithCallback({ code: "EVALUATION_RUNTIME_EXECUTION_FAILED", input, request });
      }
      const result = outputPolicy.normalizeResult({
        context,
        expected,
        modelName: modelName(lease),
        text: agentResult?.completionOutcome?.contractVersion ===
          HR_TRAINING_FOLLOWUP_ROUND_EVALUATION_RESULT_VERSION
          ? agentResult.completionOutcome
          : agentResult?.text,
      });
      const saved = resultRepository.saveOrGet({ ...identity, result });
      return deliver({
        body: saved.result,
        input,
        request,
        terminalEvidenceDigest: saved.evidence.evidenceDigest,
      });
    } catch (error) {
      const code = failureCode(error);
      return input && !canceled(request)
        ? failWithCallback({ code: publicFailureCode(code), input, request })
        : failedSettlement(code);
    }
  }

  async function deliver({ body, input, request, terminalEvidenceDigest }) {
    try {
      const callbackBody = Object.freeze({ ...body, runId: request.task.taskId });
      const authorizationDigest = callbackAuthorizationDigest({
        input, triggerEvent: request.context.triggerEvent,
      });
      const outcome = await callbackEffect.execute({
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
      if (outcome?.status === "succeeded" && outcome.receipt?.status === "succeeded") {
        return completedSettlement(terminalEvidenceDigest);
      }
      return outcome?.status === "unknown"
        ? blockedSettlement("hr_training_callback_outcome_unknown")
        : failedSettlement(outcome?.receipt?.safeResultCode || "hr_training_callback_failed");
    } catch (error) {
      return failedSettlement(safeCode(error, "hr_training_callback_failed"));
    }
  }

  async function failWithCallback({ code, input, request }) {
    return deliver({
      body: Object.freeze({
        contractVersion: HR_TRAINING_FOLLOWUP_ROUND_EVALUATION_RESULT_VERSION,
        resultKind: "FOLLOWUP_ROUND_SCORE",
        sessionId: input.sessionId,
        meetingRecordId: input.meetingRecordId,
        status: "FAILED",
        errorCode: code,
        message: "The complete follow-up round could not be scored from the verified evaluation context.",
        modelName: "",
        promptVersion: HR_TRAINING_FOLLOWUP_ROUND_EVALUATION_PROMPT_VERSION,
      }),
      input,
      request,
      terminalEvidenceDigest: null,
    });
  }

  function waitForContext(request) {
    try {
      scheduleRetry({ delayMs: 30_000, task: request.task });
      return Object.freeze({
        status: "waiting",
        waitReasonCode: "hr_training_evaluation_context_not_ready",
        lastErrorCode: "hr_training_evaluation_context_not_ready",
        resultSummary: "hr_training_evaluation_context_not_ready",
        terminalEvidenceDigest: null,
      });
    } catch {
      return blockedSettlement("hr_training_evaluation_context_retry_unavailable");
    }
  }

  return Object.freeze({
    contractVersion: "trigger-executor-handler.v1",
    taskDefinitionId: definitionId,
    handlerVersion: version,
    enabled,
    reviewStatus,
    execute,
  });
}

function buildPrompt({ context, expected }) {
  return [
    "result identity:",
    JSON.stringify(expected),
    "round completeness assertion:",
    JSON.stringify(projectFollowupRoundContextMetadata(context)),
    "safe followup round context:",
    JSON.stringify(projectFollowupRoundPromptContext(context)),
  ].join("\n");
}
function assertRequest(value, taskDefinitionId, handlerVersion) { if (!value || value.contractVersion !== "trigger-handler-execution.v1" || !value.signal || value.context?.taskDefinition?.taskDefinitionId !== taskDefinitionId || value.context.taskDefinition.handlerVersion !== handlerVersion || value.context?.triggerEvent?.event?.eventType !== CAPABILITY) throw new Error("hr_training_followup_round_context_invalid"); }
function employeeIdentity(employee = {}, task = {}) { return Object.freeze({ id: String(task.employeeId || employee.id || "").slice(0, 160), name: String(employee.name || "").slice(0, 240), version: String(task.employeeVersion || employee.version || "").slice(0, 160), permissionScope: Array.isArray(employee.permissionScope) ? employee.permissionScope.map((item) => String(item).slice(0, 160)) : [] }); }
function canceled(request) { return request.signal.aborted || request.isCancellationRequested?.() === true; }
function modelName(lease) { return String(lease?.model || lease?.modelId || "").slice(0, 120); }
function completedSettlement(terminalEvidenceDigest) { return Object.freeze({ status: "completed", resultSummary: "hr_training_followup_round_callback_delivered", terminalEvidenceDigest }); }
function failedSettlement(code) { return Object.freeze({ status: "failed", lastErrorCode: safeCode({ code }, "hr_training_followup_round_failed"), resultSummary: safeCode({ code }, "hr_training_followup_round_failed"), terminalEvidenceDigest: null }); }
function blockedSettlement(code) { return Object.freeze({ status: "blocked", lastErrorCode: safeCode({ code }, "hr_training_followup_round_blocked"), resultSummary: safeCode({ code }, "hr_training_followup_round_blocked"), terminalEvidenceDigest: null }); }
function canceledSettlement() { return Object.freeze({ status: "canceled", resultSummary: "agent_turn_canceled", terminalEvidenceDigest: null }); }
function safeCode(error, fallback) { return SAFE_CODE.test(String(error?.code || "")) ? error.code : fallback; }
function failureCode(error) {
  const code = safeCode(error, "hr_training_followup_round_failed");
  const diagnostic = error?.providerDiagnostic;
  if (code === "model_request_invalid" && diagnostic?.category === "http_error" &&
    diagnostic?.retryable !== true && Number.isInteger(diagnostic?.httpStatus) &&
    diagnostic.httpStatus >= 400 && diagnostic.httpStatus < 500) {
    return "hr_training_followup_round_provider_request_rejected";
  }
  return code;
}
function publicFailureCode(code) {
  if (code === "hr_training_followup_round_context_inconsistent") {
    return "EVALUATION_CONTEXT_INCONSISTENT";
  }
  return code.includes("context")
    ? "EVALUATION_CONTEXT_INVALID"
    : "EVALUATION_RUNTIME_EXECUTION_FAILED";
}
function requiredToken(value) { const text = String(value || "").trim(); if (!text || text.length > 160 || /[\s\u0000-\u001f\u007f]/.test(text)) throw new TypeError("HR Training followup round token invalid"); return text; }

export {
  CAPABILITY as HR_TRAINING_FOLLOWUP_ROUND_EVALUATION_CAPABILITY,
  HANDLER_VERSION as HR_TRAINING_FOLLOWUP_ROUND_EVALUATION_HANDLER_VERSION,
  TASK_DEFINITION_ID as HR_TRAINING_FOLLOWUP_ROUND_EVALUATION_TASK_DEFINITION_ID,
  createHrTrainingFollowupRoundEvaluationTriggerHandler,
};
