import crypto from "node:crypto";
import { AGENT_COMPLETION_CONTRACT_VERSION } from "../../agent-runtime/agent-completion-contract.mjs";
import { defaultEvaluationContextFetcher } from "./content-evaluation-trigger-handler.mjs";
import {
  HR_TRAINING_AGGREGATE_FEEDBACK_PROMPT_VERSION,
  HR_TRAINING_AGGREGATE_FEEDBACK_RESULT_VERSION,
  normalizeAggregateFeedbackContext,
  projectAggregateFeedbackPromptContext,
} from "./aggregate-feedback-output-policy.mjs";
import { assertFullPromptCoverage } from "./locked-material-coverage.mjs";

const CAPABILITY = "hr_training.aggregate_feedback.v1";
const TASK_DEFINITION_ID = "hr-training-aggregate-feedback-v1";
const HANDLER_VERSION = "hr-training-aggregate-feedback-handler-v1";
const SAFE_CODE = /^[a-z][a-z0-9_]{1,119}$/;

function createHrTrainingAggregateFeedbackTriggerHandler({
  agentExecutionService, callbackAuthorizationDigest, callbackEffect, currentCallbackAuthorization,
  enabled, evaluationContextFetcher = defaultEvaluationContextFetcher, fetchImpl = globalThis.fetch,
  handlerVersion = HANDLER_VERSION, inputRepository, outputPolicy, providerLeaseResolver,
  resultRepository, reviewStatus, scheduleRetry, evaluationSkillContextResolver,
  taskDefinitionId = TASK_DEFINITION_ID,
} = {}) {
  for (const [value, method] of [[agentExecutionService, "buildPrompt"], [agentExecutionService, "execute"], [callbackEffect, "execute"], [inputRepository, "getInternal"], [outputPolicy, "normalizeResult"], [outputPolicy, "outputFormat"], [resultRepository, "getInternal"], [resultRepository, "saveOrGet"], [evaluationSkillContextResolver, "resolve"]]) {
    if (typeof value?.[method] !== "function") throw new TypeError(`HR Training aggregate feedback handler requires ${method}`);
  }
  for (const value of [callbackAuthorizationDigest, currentCallbackAuthorization, evaluationContextFetcher, providerLeaseResolver, scheduleRetry]) {
    if (typeof value !== "function") throw new TypeError("HR Training aggregate feedback handler dependency invalid");
  }
  if (typeof fetchImpl !== "function" || typeof enabled !== "boolean" || !["approved", "pending_review", "rejected"].includes(reviewStatus)) throw new TypeError("HR Training aggregate feedback handler governance invalid");
  const definitionId = requiredToken(taskDefinitionId);
  const version = requiredToken(handlerVersion);

  async function execute(request) {
    try {
      assertRequest(request, definitionId, version);
      if (canceled(request)) return canceledSettlement();
      const input = inputRepository.getInternal({ tenantScope: request.task.tenantScope, runInputId: request.context.triggerEvent.event.subject.objectId });
      if (!input || input.capability !== CAPABILITY || input.tenantScope !== request.task.tenantScope) throw new Error("input");
      const identity = { tenantScope: request.task.tenantScope, triggerEventId: request.context.triggerEvent.triggerEventId, taskId: request.task.taskId };
      const stored = resultRepository.getInternal(identity);
      if (stored) return deliver({ body: stored.result, input, request, terminalEvidenceDigest: stored.evidence.evidenceDigest });
      let rawContext;
      try {
        rawContext = await evaluationContextFetcher({ apiKey: process.env.HR_TRAINING_SERVICE_API_KEY, contextUrl: input.contextUrl, fetchImpl, signal: request.signal });
      } catch (error) {
        if (safeCode(error, "hr_training_aggregate_feedback_context_fetch_failed") === "hr_training_evaluation_context_not_ready") return waitForContext(request);
        return failWithCallback({ code: "EVALUATION_CONTEXT_FETCH_FAILED", input, request });
      }
      const expected = { sessionId: input.sessionId, meetingRecordId: input.meetingRecordId };
      let context;
      try { context = normalizeAggregateFeedbackContext(rawContext, expected); } catch { return failWithCallback({ code: "EVALUATION_CONTEXT_INVALID", input, request }); }
      if (canceled(request)) return canceledSettlement();
      const lease = await providerLeaseResolver({ employee: request.context.employee, runtimeTask: request.task });
      if (!lease) return blockedSettlement("hr_training_aggregate_feedback_provider_unavailable");
      const dependencyContext = evaluationSkillContextResolver.resolve({ capability: CAPABILITY, employee: request.context.employee, task: request.task, taskDefinition: request.context.taskDefinition, triggerEvent: request.context.triggerEvent });
      let candidate;
      const candidateEvaluator = ({ text }) => {
        try {
          candidate = outputPolicy.normalizeResult({ context, expected, modelName: modelName(lease), text });
          return Object.freeze({ status: "accepted", value: candidate });
        } catch (error) { return Object.freeze({ status: "repairable", code: safeCode(error, "hr_training_aggregate_feedback_model_output_invalid"), issues: outputPolicy.candidateIssues({ context, expected, text }) }); }
      };
      const prompt = agentExecutionService.buildPrompt({
        candidateEvaluator,
        completionContract: { contractVersion: AGENT_COMPLETION_CONTRACT_VERSION, maxCandidateRepairRounds: 1, maxEvidenceContinuationRounds: 0, requiredEvidence: [] },
        conversationHistory: [], dependencyContext, employeeIdentity: employeeIdentity(request.context.employee, request.task), lease,
        maxOutputTokens: outputPolicy.maxOutputTokens || 1800,
        outputFormat: outputPolicy.outputFormat({ context, expected, taskDefinition: request.context.taskDefinition }), references: [],
        runtimeContext: { currentTurn: { text: buildPrompt({ context, expected }) } },
        safeContext: { contractVersion: "hr-training-trigger-safe-context.v1", dependencyContext, trigger: { sourceSystemId: "hr-train", capability: CAPABILITY, taskDefinitionId: definitionId, bindingId: request.context.binding.bindingId } },
        stream: false, toolExecutor: null,
      });
      assertFullPromptCoverage({ codePrefix: "hr_training_aggregate_feedback_context", lease, prompt });
      const agentResult = await agentExecutionService.execute({ lease, prompt, runtimeTask: request.task, signal: request.signal, toolExecutor: null });
      if (agentResult?.partial || agentResult?.reason === "agent_turn_canceled") return agentResult?.reason === "agent_turn_canceled" ? canceledSettlement() : failedSettlement("hr_training_aggregate_feedback_partial_result");
      const result = agentResult?.completionOutcome?.contractVersion === HR_TRAINING_AGGREGATE_FEEDBACK_RESULT_VERSION
        ? agentResult.completionOutcome : outputPolicy.normalizeResult({ context, expected, modelName: modelName(lease), text: agentResult?.text });
      const saved = resultRepository.saveOrGet({ ...identity, result });
      return deliver({ body: saved.result, input, request, terminalEvidenceDigest: saved.evidence.evidenceDigest });
    } catch (error) {
      return failedSettlement(safeCode(error, "hr_training_aggregate_feedback_failed"));
    }
  }

  async function deliver({ body, input, request, terminalEvidenceDigest }) {
    try {
      const callbackBody = Object.freeze({ ...body, runId: request.task.taskId });
      const authorizationDigest = callbackAuthorizationDigest({ input, triggerEvent: request.context.triggerEvent });
      const outcome = await callbackEffect.execute({ authorizationDigest, authorizeCurrentOperation: (receiptRequest) => currentCallbackAuthorization({ authorizationDigest: receiptRequest.authorizationDigest, input, triggerEvent: request.context.triggerEvent }), body: callbackBody, input, operationReceiptContext: request.operationReceiptContext, signal: request.signal, task: request.task, triggerEvent: request.context.triggerEvent });
      if (outcome?.status === "succeeded" && outcome.receipt?.status === "succeeded") return completedSettlement(terminalEvidenceDigest);
      return outcome?.status === "unknown" ? blockedSettlement("hr_training_callback_outcome_unknown") : failedSettlement(outcome?.receipt?.safeResultCode || "hr_training_callback_failed");
    } catch (error) { return failedSettlement(safeCode(error, "hr_training_callback_failed")); }
  }

  async function failWithCallback({ code, input, request }) {
    return deliver({ body: Object.freeze({ contractVersion: HR_TRAINING_AGGREGATE_FEEDBACK_RESULT_VERSION, resultKind: "FINAL_SUGGESTION_SUMMARY", sessionId: input.sessionId, meetingRecordId: input.meetingRecordId, status: "FAILED", errorCode: code, message: "The final suggestion summary could not be generated from the verified evaluation context.", modelName: "", promptVersion: HR_TRAINING_AGGREGATE_FEEDBACK_PROMPT_VERSION }), input, request, terminalEvidenceDigest: null });
  }
  function waitForContext(request) { try { scheduleRetry({ delayMs: 30_000, task: request.task }); return Object.freeze({ status: "waiting", waitReasonCode: "hr_training_evaluation_context_not_ready", lastErrorCode: "hr_training_evaluation_context_not_ready", resultSummary: "hr_training_evaluation_context_not_ready", terminalEvidenceDigest: null }); } catch { return blockedSettlement("hr_training_evaluation_context_retry_unavailable"); } }
  return Object.freeze({ contractVersion: "trigger-executor-handler.v1", taskDefinitionId: definitionId, handlerVersion: version, enabled, reviewStatus, execute });
}

function buildPrompt({ context, expected }) { return ["仅输出高影响且不重复的最终建议方向，最多 5 条，不得为了数量补充泛化句。每条必须含一个改进方向和 1–4 个本轮可执行行动（准备、练习或表达步骤）。不得输出任何分数、原始上下文、提示词、URL、材料原文、题目原文或回答原文。", "result identity:", JSON.stringify(expected), "safe aggregate context:", JSON.stringify(projectAggregateFeedbackPromptContext(context))].join("\n"); }
function assertRequest(value, taskDefinitionId, handlerVersion) { if (!value || value.contractVersion !== "trigger-handler-execution.v1" || !value.signal || value.context?.taskDefinition?.taskDefinitionId !== taskDefinitionId || value.context.taskDefinition.handlerVersion !== handlerVersion || value.context?.triggerEvent?.event?.eventType !== CAPABILITY) throw new Error("hr_training_aggregate_feedback_context_invalid"); }
function employeeIdentity(employee = {}, task = {}) { return Object.freeze({ id: String(task.employeeId || employee.id || "").slice(0, 160), name: String(employee.name || "").slice(0, 240), version: String(task.employeeVersion || employee.version || "").slice(0, 160), permissionScope: Array.isArray(employee.permissionScope) ? employee.permissionScope.map((item) => String(item).slice(0, 160)) : [] }); }
function canceled(request) { return request.signal.aborted || request.isCancellationRequested?.() === true; }
function modelName(lease) { return String(lease?.model || lease?.modelId || "").slice(0, 120); }
function completedSettlement(terminalEvidenceDigest) { return Object.freeze({ status: "completed", resultSummary: "hr_training_aggregate_feedback_callback_delivered", terminalEvidenceDigest }); }
function failedSettlement(code) { return Object.freeze({ status: "failed", lastErrorCode: safeCode({ code }, "hr_training_aggregate_feedback_failed"), resultSummary: safeCode({ code }, "hr_training_aggregate_feedback_failed"), terminalEvidenceDigest: null }); }
function blockedSettlement(code) { return Object.freeze({ status: "blocked", lastErrorCode: safeCode({ code }, "hr_training_aggregate_feedback_blocked"), resultSummary: safeCode({ code }, "hr_training_aggregate_feedback_blocked"), terminalEvidenceDigest: null }); }
function canceledSettlement() { return Object.freeze({ status: "canceled", resultSummary: "agent_turn_canceled", terminalEvidenceDigest: null }); }
function safeCode(error, fallback) { return SAFE_CODE.test(String(error?.code || "")) ? error.code : fallback; }
function requiredToken(value) { const text = String(value || "").trim(); if (!text || text.length > 160 || /[\s\u0000-\u001f\u007f]/.test(text)) throw new TypeError("HR Training aggregate feedback token invalid"); return text; }

export { CAPABILITY as HR_TRAINING_AGGREGATE_FEEDBACK_CAPABILITY, HANDLER_VERSION as HR_TRAINING_AGGREGATE_FEEDBACK_HANDLER_VERSION, TASK_DEFINITION_ID as HR_TRAINING_AGGREGATE_FEEDBACK_TASK_DEFINITION_ID, createHrTrainingAggregateFeedbackTriggerHandler };
