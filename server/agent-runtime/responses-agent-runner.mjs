import { normalizeAgentExecutionBudget } from "./agent-execution-budget.mjs";
import crypto from "node:crypto";
import {
  agentCompletionFeedback,
  missingAgentCompletionEvidence,
  normalizeAgentCompletionContract,
} from "./agent-completion-contract.mjs";
import {
  DEFAULT_PROVIDER_DIAGNOSTIC,
  createProviderRuntimeError,
  normalizeProviderRuntimeDiagnostic,
  normalizeProviderRuntimeError,
} from "./provider-errors.mjs";
import { createProviderRequestQueue } from "./provider-request-queue.mjs";
import {
  normalizeProviderRetryPolicy,
  runProviderRequestWithRetry,
} from "./provider-request-retry.mjs";
import { createProviderTimeoutController } from "./provider-timeout-controller.mjs";
import { DEFAULT_PROVIDER_TIMEOUT_POLICY, normalizeProviderTimeoutPolicy } from "./provider-timeout-policy.mjs";
import { normalizeScheduleResultContract } from "./schedule-result-contract.mjs";
import { normalizeScheduleTaskExecutionDefinition } from "./schedule-task-execution-definition.mjs";
import {
  AGENT_RUNTIME_EVIDENCE_CONTRACT_VERSION,
  MAX_RUNTIME_REQUEST_METRICS,
} from "./runtime-task-evidence-contract-v1.mjs";
import { MAX_RUNTIME_SAFE_ACTIVITIES } from "./runtime-safe-activity-contract-v1.mjs";
import { createRuntimeSafeActivityProjector } from "./runtime-safe-activity-projector.mjs";
import { executeRuntimeToolActivity } from "./runtime-tool-activity-executor.mjs";
import {
  appendRuntimeToolEfficiencyCall,
  emptyRuntimeToolEfficiencySource,
} from "./runtime-tool-efficiency-contract-v1.mjs";

const DEFAULT_AGENT_LOOP_POLICY = {
  maxDurationMs: 30 * 60 * 1000,
  maxTotalTokens: 0,
  repeatedToolThreshold: 3,
};
const PROVIDER_ONLY_PROBE_TEXT = "PROVIDER_ROUTE_OK";
const STRUCTURED_RESULT_REQUEST_VERSION = "schedule-structured-provider-request.v1";
const STRUCTURED_RESULT_RESPONSE_VERSION = "schedule-structured-provider-response.v1";
const STRUCTURED_RESULT_REQUEST_FIELDS = new Set([
  "contractVersion", "inputSnapshot", "providerRequestId", "resultContract", "taskDefinition",
]);
const INPUT_SNAPSHOT_FIELDS = new Set(["contractVersion", "items", "snapshotContractVersion"]);
const STRUCTURED_RESULT_MAX_RESPONSE_BYTES = 64 * 1024;
const STRUCTURED_RESULT_MAX_JSON_DEPTH = 16;
const STRUCTURED_RESULT_MAX_JSON_NODES = 8192;
const STRUCTURED_RESULT_TOKEN = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,179}$/;
const EMPTY_TOOL_EXECUTOR = Object.freeze({
  availableAgentContent: () => [],
  completionEvidence: () => [],
  completionEvidenceCapabilities: () => [],
  toolDefinitions: () => [],
  toolExecutionPolicy: () => ({ toolChoice: "auto" }),
});

function createResponsesAgentRunner({
  buildPartialText = () => "The Agent run stopped at its configured governance boundary.",
  formatOutput = (value) => String(value || "").trim(),
  isTaskCancellationRequested = () => false,
  loopPolicy,
  now = () => Date.now(),
  projectToolArguments = () => ({}),
  providerAdapterRegistry,
  providerRequestQueue = createProviderRequestQueue(),
  providerTimeoutControllerFactory = createProviderTimeoutController,
  recordRuntimeEvidence = null,
  recordRuntimeEfficiency = null,
  retryPolicy,
  sleep,
} = {}) {
  if (!providerAdapterRegistry) throw new Error("responses agent runner requires a provider adapter registry");
  if (recordRuntimeEvidence !== null && typeof recordRuntimeEvidence !== "function") {
    throw new TypeError("responses agent runner runtime evidence recorder is invalid");
  }
  if (recordRuntimeEfficiency !== null && typeof recordRuntimeEfficiency !== "function") {
    throw new TypeError("responses agent runner runtime efficiency recorder is invalid");
  }
  const effectiveLoopPolicy = normalizeAgentLoopPolicy(loopPolicy);
  const effectiveRetryPolicy = normalizeProviderRetryPolicy(retryPolicy);

  async function run({ candidateEvaluator = null, completionContract = null, lease = {}, onTextDelta = null,
    onToolActivity = () => {}, operationReceiptContext = null, persistRuntimeEvidence = true, prompt = {},
    runtimeTask = null, signal = null, toolExecutor = null, toolParameterContinuation = null, executionBudget = null } = {}) {
    if (candidateEvaluator !== null && typeof candidateEvaluator !== "function") {
      throw runnerError("agent_completion_evaluator_invalid");
    }
    const budget = normalizeAgentExecutionBudget(executionBudget);
    const runLoopPolicy = budget ? { ...effectiveLoopPolicy, maxTotalTokens: Math.min(budget.maxTotalTokens, effectiveLoopPolicy.maxTotalTokens || Infinity) } : effectiveLoopPolicy;
    const normalizedCompletionContract = normalizeAgentCompletionContract(completionContract);
    const startedAtMs = now();
    const hasTools = Boolean(toolExecutor?.toolDefinitions?.().length);
    const hasCompletionBoundary = Boolean(candidateEvaluator) ||
      normalizedCompletionContract.requiredEvidence.length > 0;
    const runtimeEvidenceState = createRuntimeEvidenceState({
      adapter: hasTools || hasCompletionBoundary ? "responses_api_tool_loop" : "responses_api_stream",
      lease,
      persistenceEnabled: persistRuntimeEvidence !== false,
      prompt,
      runtimeTask,
    });
    const initialStopReason = agentStopReason({
      isTaskCancellationRequested,
      loopPolicy: runLoopPolicy,
      now,
      runtimeTask,
      signal,
      startedAtMs,
    });
    let modelRun;
    try {
      if (initialStopReason) {
        modelRun = boundedAgentRunResult({ reason: initialStopReason });
      } else {
        assertCompletionEvidenceReachable(
          normalizedCompletionContract,
          toolExecutor || EMPTY_TOOL_EXECUTOR,
        );
        modelRun = hasTools || hasCompletionBoundary || Boolean(budget)
          ? await runResponsesToolLoop({ candidateEvaluator, completionContract: normalizedCompletionContract,
            lease, onToolActivity, operationReceiptContext, prompt, runtimeEvidenceState, runtimeTask, runLoopPolicy, hasTurnBudget: Boolean(budget),
            signal, startedAtMs, toolExecutor: toolExecutor || EMPTY_TOOL_EXECUTOR, toolParameterContinuation })
          : await runStreamingResponse({ lease, onTextDelta, prompt, runtimeEvidenceState, runtimeTask, signal });
      }
    } catch (error) {
      const reasonCode = typeof signal?.reason?.code === "string"
        ? signal.reason.code
        : signal?.aborted && signal?.reason?.name === "AbortError"
          ? "agent_turn_canceled"
          : error?.code;
      if (reasonCode !== "agent_turn_canceled" && reasonCode !== "execution_task_ownership_lost") throw error;
      modelRun = boundedAgentRunResult({ reason: "agent_turn_canceled" });
    }
    const finalStopReason = agentStopReason({
      isTaskCancellationRequested,
      loopPolicy: runLoopPolicy,
      now,
      runtimeTask,
      signal,
      startedAtMs,
    });
    if (finalStopReason === "agent_turn_canceled") {
      modelRun = boundedAgentRunResult({ reason: finalStopReason, ...modelRun.agentRuntime });
    }
    return modelRun;
  }

  async function runProviderOnly({ lease = {}, runtimeTask = null, signal = null } = {}) {
    if (!lease.model || !lease.providerRouteId) throw createProviderRuntimeError("model_request_invalid");
    const initialStop = providerOnlyStopError({ isTaskCancellationRequested, now, runtimeTask, signal });
    if (initialStop) throw initialStop;
    let providerAttempts = 0;
    const payload = await runProviderRequest(lease, async ({ attempt, signal: attemptSignal, timeoutController }) => {
      providerAttempts = Math.max(providerAttempts, attempt);
      const response = await providerAdapterRegistry.requestPayload({
        lease,
        body: {
          model: lease.model,
          input: [{ role: "user", content: `Return exactly: ${PROVIDER_ONLY_PROBE_TEXT}` }],
          max_output_tokens: 32,
          parallel_tool_calls: false,
          store: false,
          stream: true,
          tool_choice: "none",
          tools: [],
        },
        canonicalContent: [],
        signal: attemptSignal,
        timeoutController,
      });
      if (timeoutController.snapshot?.().phase === "connecting") timeoutController.markConnected?.();
      timeoutController.markSemanticOutput?.();
      if (!providerOnlyPayloadIsSafe(response, lease.model)) throw createProviderRuntimeError("model_response_contract_invalid");
      return response;
    }, { runtimeTask, signal });
    const finalStop = providerOnlyStopError({ isTaskCancellationRequested, now, runtimeTask, signal });
    if (finalStop) throw finalStop;
    return deepFreeze({
      status: "provider_only_response_received",
      providerAttempts,
      usage: sanitizeUsage(payload.usage),
      safetyEvidence: {
        businessPayloadAttempts: 0,
        outputPersisted: false,
        skillAttempts: 0,
        toolAttempts: 0,
        writebackAttempts: 0,
      },
    });
  }

  async function runStructuredResultOnly({ lease = {}, request = {}, runtimeTask = null,
    signal = null } = {}) {
    if (!lease.model || !lease.providerRouteId) throw createProviderRuntimeError("model_request_invalid");
    const normalized = normalizeStructuredResultRequest(request);
    const initialStop = providerOnlyStopError({ isTaskCancellationRequested, now, runtimeTask, signal });
    if (initialStop) throw initialStop;
    const singleAttemptLease = { ...lease, fallbackRouteId: "", retryCount: 0 };
    const payload = await runProviderRequest(singleAttemptLease, async ({ signal: attemptSignal,
      timeoutController }) => {
      const response = await providerAdapterRegistry.requestPayload({
        lease: singleAttemptLease,
        body: structuredResultBody(singleAttemptLease.model, normalized),
        canonicalContent: [],
        signal: attemptSignal,
        timeoutController,
      });
      if (timeoutController.snapshot?.().phase === "connecting") timeoutController.markConnected?.();
      if (!response || !Array.isArray(response.output)) {
        throw createProviderRuntimeError("model_response_contract_invalid");
      }
      timeoutController.markSemanticOutput?.();
      return response;
    }, { runtimeTask, signal });
    const finalStop = providerOnlyStopError({ isTaskCancellationRequested, now, runtimeTask, signal });
    if (finalStop) throw finalStop;
    const text = readResponsesOutputText(payload).trim();
    if (Buffer.byteLength(text, "utf8") > STRUCTURED_RESULT_MAX_RESPONSE_BYTES) {
      throw createProviderRuntimeError("model_response_contract_invalid");
    }
    return deepFreeze({
      contractVersion: STRUCTURED_RESULT_RESPONSE_VERSION,
      envelope: structuredResultCandidate(text),
      payloadBoundary: "internal_only",
      providerRequestId: normalized.providerRequestId,
      providerResponseRef: providerResponseRef(payload.id, normalized.providerRequestId),
      usage: sanitizeUsage(payload.usage),
    });
  }

  async function runResponsesToolLoop({ candidateEvaluator, completionContract, lease, onToolActivity,
    operationReceiptContext, prompt, runtimeEvidenceState, runtimeTask, signal, startedAtMs, toolExecutor,
    toolParameterContinuation, runLoopPolicy, hasTurnBudget }) {
    let input = prompt.input.slice();
    let candidateRepairRounds = 0;
    let evidenceContinuationRounds = 0;
    const initialMissingEvidence = missingAgentCompletionEvidence(
      completionContract,
      toolExecutor.completionEvidence?.() || [],
    );
    let completionToolAllowlist = initialMissingEvidence.length
      ? completionToolPolicyForEvidence(toolExecutor, initialMissingEvidence)
      : null;
    let completionToolsDisabled = false;
    let toolCallCount = runtimeEvidenceState.toolCallCount;
    let totalUsage = { ...runtimeEvidenceState.usage };
    let ephemeralEfficiencySource = emptyRuntimeToolEfficiencySource({
      taskId: runtimeEvidenceState.taskId,
      repeatThreshold: runLoopPolicy.repeatedToolThreshold,
    });
    const ephemeralEfficiencyKey = crypto.randomBytes(32);
    let visionInputCount = 0;
    let fileInputCount = 0;
    const toolCalls = [];
    while (true) {
      const beforeRequestReason = agentStopReason({
        isTaskCancellationRequested,
        loopPolicy: runLoopPolicy,
        now,
        runtimeTask,
        signal,
        startedAtMs,
        totalUsage,
      });
      if (beforeRequestReason) {
        return boundedAgentRunResult({
          reason: beforeRequestReason,
          requestCount: runtimeEvidenceState.requestCount,
          toolCallCount,
          toolCalls,
          usage: totalUsage,
          fileInputCount,
          visionInputCount,
        });
      }
      const canonicalContent = completionToolsDisabled
        ? []
        : toolExecutor.availableAgentContent?.() || [];
      if (!completionToolsDisabled) {
        visionInputCount = canonicalContent.filter((item) => item?.type === "image").length;
        fileInputCount = canonicalContent.filter((item) => item?.type === "file").length;
      }
      const toolPolicy = toolExecutor.toolExecutionPolicy?.() || {};
      const declaredTools = toolExecutor.toolDefinitions?.() || [];
      const requestTools = completionToolsDisabled
        ? []
        : completionToolAllowlist
          ? declaredTools.filter((definition) => completionToolAllowlist.has(definition.name))
          : declaredTools;
      const payload = await fetchResponsesPayload(
        lease,
        responseRequestForAgentLoop({
          input,
          prompt: hasTurnBudget ? { ...prompt,
            max_output_tokens: Math.min(prompt.max_output_tokens || runLoopPolicy.maxTotalTokens, Math.max(1, runLoopPolicy.maxTotalTokens - Number(totalUsage.totalTokens || 0))) } : prompt,
          toolChoice: completionToolsDisabled || !requestTools.length
            ? "none"
            : completionToolAllowlist
              ? "required"
              : toolPolicy.toolChoice,
          tools: requestTools,
        }),
        {
          canonicalContent,
          runtimeEvidenceState,
          runtimeTask,
          signal,
          requestContext: { input },
        },
      );
      if (hasTurnBudget && (!Number.isSafeInteger(payload.usage?.total_tokens) || payload.usage.total_tokens < 0)) {
        throw runnerError("agent_token_usage_unavailable");
      }
      totalUsage = addUsage(totalUsage, sanitizeUsage(payload.usage));
      runtimeEvidenceState.usage = totalUsage;
      await persistRuntimeEvidence(runtimeEvidenceState, "model_response_received", runtimeTask);
      const calls = payload.output.filter((item) => item?.type === "function_call");
      const reportedBudgetStop = hasTurnBudget ? agentStopReason({ isTaskCancellationRequested, loopPolicy: runLoopPolicy, now, runtimeTask, signal, startedAtMs, totalUsage }) : "";
      // An exact-limit final answer is valid, but no further Tool or request is.
      if (reportedBudgetStop && (reportedBudgetStop !== "agent_run_token_budget_reached" || calls.length || totalUsage.totalTokens > runLoopPolicy.maxTotalTokens)) {
        return boundedAgentRunResult({ reason: reportedBudgetStop, requestCount: runtimeEvidenceState.requestCount, toolCallCount, toolCalls, usage: totalUsage, fileInputCount, visionInputCount });
      }
      if (!calls.length) {
        const text = formatOutput(readResponsesOutputText(payload));
        if (!text) throw new Error("agent_runtime_empty_reply");
        const candidateEvaluation = await evaluateCompletionCandidate(candidateEvaluator, text);
        const missingEvidence = missingAgentCompletionEvidence(
          completionContract,
          toolExecutor.completionEvidence?.() || [],
        );
        if (candidateEvaluation.status === "accepted" && !missingEvidence.length) {
          return {
            text,
            ...(candidateEvaluation.value === undefined
              ? {}
              : { completionOutcome: candidateEvaluation.value }),
            agentRuntime: {
              adapter: "responses_api_tool_loop",
              realModelRequested: true,
              status: "model_response_received",
              requestCount: runtimeEvidenceState.requestCount,
              toolCallCount,
              toolCalls,
              fileInputCount,
              visionInputCount,
              usage: totalUsage,
            },
          };
        }
        if (candidateEvaluation.status === "terminal") {
          throw runnerError(candidateEvaluation.code);
        }
        const evidenceRequired = missingEvidence.length > 0;
        const roundsUsed = evidenceRequired ? evidenceContinuationRounds : candidateRepairRounds;
        const roundLimit = evidenceRequired
          ? completionContract.maxEvidenceContinuationRounds
          : completionContract.maxCandidateRepairRounds;
        if (roundsUsed >= roundLimit) {
          throw runnerError(evidenceRequired
            ? "agent_completion_evidence_missing"
            : candidateEvaluation.code, {
            completionCandidateIssues: candidateEvaluation.issues,
          });
        }
        if (evidenceRequired) evidenceContinuationRounds += 1;
        else candidateRepairRounds += 1;
        completionToolsDisabled = !evidenceRequired;
        completionToolAllowlist = evidenceRequired
          ? completionToolPolicyForEvidence(toolExecutor, missingEvidence)
          : null;
        input.push(...payload.output, {
          role: "user",
          content: completionFeedbackText(agentCompletionFeedback({
            code: evidenceRequired ? "required_evidence_missing" : candidateEvaluation.code,
            issues: candidateEvaluation.issues,
            missingEvidence,
            remainingRoundsAfterCurrent: roundLimit - roundsUsed - 1,
          }), { toolsDisabled: completionToolsDisabled }),
        });
        continue;
      }

      completionToolsDisabled = false;

      const afterRequestReason = agentStopReason({
        isTaskCancellationRequested,
        loopPolicy: runLoopPolicy,
        now,
        runtimeTask,
        signal,
        startedAtMs,
        totalUsage,
      });
      if (afterRequestReason) {
        return boundedAgentRunResult({
          reason: afterRequestReason,
          requestCount: runtimeEvidenceState.requestCount,
          toolCallCount,
          toolCalls,
          usage: totalUsage,
          fileInputCount,
          visionInputCount,
        });
      }

      input.push(...payload.output);
      for (const call of calls) {
        if (signal?.aborted) {
          return boundedAgentRunResult({ reason: "agent_turn_canceled", requestCount: runtimeEvidenceState.requestCount, toolCallCount, toolCalls, usage: totalUsage, fileInputCount, visionInputCount });
        }
        if (toolCallCount >= MAX_RUNTIME_SAFE_ACTIVITIES) {
          return boundedAgentRunResult({
            reason: "agent_tool_activity_limit_reached",
            requestCount: runtimeEvidenceState.requestCount,
            toolCallCount,
            toolCalls,
            usage: totalUsage,
            fileInputCount,
            visionInputCount,
          });
        }
        const argumentsValue = parseToolArguments(call.arguments);
        assertCompletionToolCallAllowed(completionToolAllowlist, call.name, argumentsValue);
        toolCallCount += 1;
        runtimeEvidenceState.toolCallCount = toolCallCount;
        const activityExecution = await executeRuntimeToolActivity({
          activitySnapshot: runtimeEvidenceState.activitySnapshot,
          onActivity: onToolActivity,
          operationReceiptContext,
          persistEfficiency: async ({ activity, executorRetryCount, repeatThreshold, result, toolCall }) => {
            if (recordRuntimeEfficiency && runtimeTask && runtimeEvidenceState.persistenceEnabled) {
              return persistRuntimeEfficiency(runtimeTask, {
                type: "tool_call_terminal",
                repeatThreshold,
                activity,
                executorRetryCount,
                result,
                toolCall,
              });
            }
            const applied = appendRuntimeToolEfficiencyCall(ephemeralEfficiencySource, {
              activity,
              executorRetryCount,
              fingerprintKey: ephemeralEfficiencyKey,
              result,
              toolCall,
            });
            ephemeralEfficiencySource = applied.source;
            return applied;
          },
          persistActivity: async ({ activitySnapshot, phase }) => {
            runtimeEvidenceState.activitySnapshot = activitySnapshot;
            await persistRuntimeEvidence(
              runtimeEvidenceState,
              phase === "started" ? "tool_call_started" : "tool_call_completed",
              runtimeTask,
            );
          },
          runtimeTask: runtimeTask || { taskId: runtimeEvidenceState.taskId },
          signal,
          toolCall: {
            name: call.name,
            arguments: argumentsValue,
            callId: cleanId(call.call_id),
          },
          toolExecutor,
          repeatThreshold: runLoopPolicy.repeatedToolThreshold,
        });
        runtimeEvidenceState.activitySnapshot = activityExecution.activitySnapshot;
        const result = suppressRepeatedSourceParameterCard({
          argumentsValue,
          continuation: toolParameterContinuation,
          result: activityExecution.result,
        });
        const agentResult = toolExecutor.agentResultFor?.(result) || result;
        toolCalls.push({
          callId: cleanId(call.call_id),
          name: cleanId(call.name),
          arguments: projectToolArguments(argumentsValue),
          result,
          status: cleanId(result.status),
          skillId: cleanId(result.skillId),
        });
        input.push({
          type: "function_call_output",
          call_id: cleanId(call.call_id),
          output: JSON.stringify(agentResult),
        });
        const terminalToolTurn = terminalToolTurnPresentation(result);
        if (terminalToolTurn) {
          return completedToolTurnResult({
            ...terminalToolTurn,
            requestCount: runtimeEvidenceState.requestCount,
            toolCallCount,
            toolCalls,
            usage: totalUsage,
            fileInputCount,
            visionInputCount,
          });
        }
        const afterToolReason = result?.error === "external_effect_unknown"
          ? "external_effect_unknown"
          : result?.error === "tool_not_allowed"
            ? "agent_tool_not_allowed"
          : activityExecution.efficiency?.analysis?.breakerTriggered === true
            ? "agent_tool_loop_no_progress"
            : agentStopReason({
              isTaskCancellationRequested,
              loopPolicy: runLoopPolicy,
              now,
              runtimeTask,
              signal,
              startedAtMs,
              totalUsage,
              });
        if (afterToolReason) {
          if (["agent_tool_loop_no_progress", "agent_tool_not_allowed"].includes(afterToolReason)) {
            runtimeEvidenceState.blockedReason = afterToolReason;
            await persistRuntimeEvidence(runtimeEvidenceState, afterToolReason, runtimeTask);
          }
          return boundedAgentRunResult({
            reason: afterToolReason,
            requestCount: runtimeEvidenceState.requestCount,
            toolCallCount,
            toolCalls,
            usage: totalUsage,
            fileInputCount,
            visionInputCount,
          });
        }
      }
      if (completionToolAllowlist && !missingAgentCompletionEvidence(
        completionContract,
        toolExecutor.completionEvidence?.() || [],
      ).length) {
        completionToolAllowlist = null;
      }
    }
  }

  async function fetchResponsesPayload(lease, body, {
    canonicalContent = [], runtimeEvidenceState = null, runtimeTask = null, signal = null,
    requestContext = null,
  } = {}) {
    return runProviderRequest(lease, async ({ signal: attemptSignal, timeoutController }) => {
      const payload = await providerAdapterRegistry.requestPayload({ lease, body, canonicalContent, signal: attemptSignal, timeoutController });
      if (!payload || !Array.isArray(payload.output)) {
        throw createProviderRuntimeError("model_response_contract_invalid");
      }
      return payload;
    }, { runtimeEvidenceState, runtimeTask, signal, requestContext: requestContext || { input: body.input } });
  }

  async function runStreamingResponse({ lease, onTextDelta = null, prompt, runtimeEvidenceState, runtimeTask = null, signal = null }) {
    const result = await runProviderRequest(lease, async ({ signal: attemptSignal, timeoutController }) => {
      if (typeof providerAdapterRegistry.requestPayload === "function") {
        const payload = await providerAdapterRegistry.requestPayload({ lease, body: prompt, onTextDelta, signal: attemptSignal, timeoutController });
        if (!payload || !Array.isArray(payload.output)) {
          throw createProviderRuntimeError("model_response_contract_invalid");
        }
        return {
          text: readResponsesOutputText(payload),
          usage: sanitizeUsage(payload.usage),
        };
      }
      return {
        text: await providerAdapterRegistry.requestText({ lease, body: prompt, onTextDelta, signal: attemptSignal, timeoutController }),
        usage: {},
      };
    }, { runtimeEvidenceState, runtimeTask, signal, requestContext: { input: prompt.input } });
    runtimeEvidenceState.usage = result.usage;
    await persistRuntimeEvidence(runtimeEvidenceState, "model_response_received", runtimeTask);
    const text = formatOutput(result.text);
    if (!text) throw new Error("agent_runtime_empty_reply");
    return {
      text,
      agentRuntime: {
        adapter: "responses_api_stream",
        realModelRequested: true,
        status: "model_response_received",
        requestCount: runtimeEvidenceState.requestCount,
        toolCallCount: 0,
        toolCalls: [],
        usage: result.usage,
      },
    };
  }

  async function runProviderRequest(lease, operation, {
    runtimeEvidenceState = null, runtimeTask = null, signal = null, requestContext = null,
  } = {}) {
    const timeoutPolicy = normalizeProviderTimeoutPolicy(
      runtimeTask?.providerTimeoutPolicy || lease.timeoutPolicy || DEFAULT_PROVIDER_TIMEOUT_POLICY,
    );
    const taskDeadlineAtMs = runtimeTask?.executionDeadlineAt ? Date.parse(runtimeTask.executionDeadlineAt) : null;
    return runProviderRequestWithRetry({
      operation: ({ attempt }) => providerRequestQueue.run(lease.providerRouteId, async () => {
        const requestStartedAt = Date.now();
        if (runtimeEvidenceState) {
          runtimeEvidenceState.requestCount += 1;
          runtimeEvidenceState.blockedReason = "";
          runtimeEvidenceState.providerDiagnostic = DEFAULT_PROVIDER_DIAGNOSTIC;
          await persistRuntimeEvidence(runtimeEvidenceState, "model_request_started", runtimeTask);
        }
        const timeoutController = providerTimeoutControllerFactory({
          parentSignal: signal,
          policy: timeoutPolicy,
          taskDeadlineAtMs: Number.isFinite(taskDeadlineAtMs) ? taskDeadlineAtMs : null,
        });
        try {
          timeoutController.throwIfAborted();
          const result = await operation({ attempt, signal: timeoutController.signal, timeoutController });
          timeoutController.complete();
          if (runtimeEvidenceState) {
            appendRuntimeRequestMetric(runtimeEvidenceState, {
              requestContext,
              result,
              status: "received",
              sequence: runtimeEvidenceState.requestCount,
              durationMs: Date.now() - requestStartedAt,
            });
          }
          return result;
        } catch (error) {
          const snapshot = timeoutController.snapshot();
          const effectiveError = timeoutController.signal.aborted
            ? timeoutController.signal.reason || error
            : error;
          const attemptError = normalizeProviderRuntimeError(providerAttemptError(effectiveError, snapshot.semanticOutputObserved));
          if (snapshot.semanticOutputObserved) attemptError.retryable = false;
          attemptError.providerDiagnostic = { ...attemptError.providerDiagnostic, retryable: attemptError.retryable === true };
          if (runtimeEvidenceState) {
            appendRuntimeRequestMetric(runtimeEvidenceState, {
              requestContext,
              status: "failed",
              sequence: runtimeEvidenceState.requestCount,
              durationMs: Date.now() - requestStartedAt,
            });
            runtimeEvidenceState.blockedReason = safeRuntimeEvidenceReason(attemptError);
            runtimeEvidenceState.providerDiagnostic = safeRuntimeProviderDiagnostic(attemptError, {
              phase: "request",
              attempt,
              durationMs: Date.now() - requestStartedAt,
            });
            await persistRuntimeEvidence(runtimeEvidenceState, "model_request_failed", runtimeTask);
          }
          throw attemptError;
        } finally {
          timeoutController.dispose();
        }
      }, { signal }),
      retryCount: lease.retryCount,
      retryPolicy: effectiveRetryPolicy,
      signal,
      ...(recordRuntimeEfficiency && runtimeTask && runtimeEvidenceState?.persistenceEnabled !== false ? {
        onRetry: () => persistRuntimeEfficiency(runtimeTask, {
          type: "provider_retry",
          repeatThreshold: effectiveLoopPolicy.repeatedToolThreshold,
        }),
      } : {}),
      ...(sleep ? { sleep } : {}),
    });
  }

  async function persistRuntimeEfficiency(runtimeTask, mutation) {
    if (!recordRuntimeEfficiency || !runtimeTask) return null;
    return recordRuntimeEfficiency({ runtimeTask, mutation });
  }

  async function persistRuntimeEvidence(state, status, runtimeTask) {
    if (!recordRuntimeEvidence || state?.persistenceEnabled === false) return null;
    return recordRuntimeEvidence({
      runtimeTask,
      evidence: {
        contractVersion: AGENT_RUNTIME_EVIDENCE_CONTRACT_VERSION,
        status,
        realModelRequested: true,
        provider: state.provider,
        model: state.model,
        reasoningEffort: state.reasoningEffort,
        adapter: state.adapter,
        requestCount: state.requestCount,
        toolCallCount: state.toolCallCount,
        activitySnapshot: state.activitySnapshot,
        usage: {
          inputTokens: safeOptionalUsage(state.usage.inputTokens),
          outputTokens: safeOptionalUsage(state.usage.outputTokens),
          totalTokens: safeOptionalUsage(state.usage.totalTokens),
        },
        requestMetrics: state.requestMetrics || [],
        blockedReason: state.blockedReason,
        providerDiagnostic: state.providerDiagnostic || DEFAULT_PROVIDER_DIAGNOSTIC,
      },
    });
  }

  function boundedAgentRunResult({
    reason = "agent_run_budget_reached",
    requestCount = 0,
    toolCallCount = 0,
    toolCalls = [],
    usage = {},
    fileInputCount = 0,
    visionInputCount = 0,
  } = {}) {
    return {
      partial: true,
      reason,
      text: formatOutput(buildPartialText({ reason, toolCallCount })),
      agentRuntime: {
        adapter: "responses_api_tool_loop",
        realModelRequested: requestCount > 0,
        status: reason,
        blockedReason: reason,
        requestCount,
        toolCallCount,
        toolCalls,
        fileInputCount,
        visionInputCount,
        usage,
      },
    };
  }

  function completedToolTurnResult({
    reason,
    text,
    requestCount = 0,
    toolCallCount = 0,
    toolCalls = [],
    usage = {},
    fileInputCount = 0,
    visionInputCount = 0,
  } = {}) {
    return {
      reason,
      text: formatOutput(text),
      agentRuntime: {
        adapter: "responses_api_tool_loop",
        realModelRequested: requestCount > 0,
        status: reason,
        blockedReason: reason === "tool_target_rejected" ? reason : "",
        requestCount,
        toolCallCount,
        toolCalls,
        fileInputCount,
        visionInputCount,
        usage,
      },
    };
  }

  return { run, runProviderOnly, runStructuredResultOnly };
}

function terminalToolTurnPresentation(result = {}) {
  if (result?.authorizationAction?.contractVersion === "current-user-tool-authorization-action.v1") {
    return {
      reason: "tool_authorization_required",
      text: "请先在授权卡中完成飞书个人授权，然后重新发送刚才的请求。",
    };
  }
  if (result?.parameterCard?.contractVersion === "tool-parameter-card.v2") {
    return {
      reason: "tool_parameter_card_ready",
      text: "请在参数卡中确认本次任务参数。",
    };
  }
  if (result?.confirmationRequest?.contractVersion === "tool-call-confirmation.v1") {
    return {
      reason: "tool_confirmation_card_ready",
      text: "请在确认卡中审核本次准确 Tool 操作。",
    };
  }
  if (result?.turnDisposition === "tool_parameter_card_unavailable") {
    return {
      reason: "tool_parameter_card_unavailable",
      text: result.message || "当前需要结构化参数卡，但卡片暂时无法生成。请稍后重试或联系管理员修复 Tool 合同。",
    };
  }
  if (result?.turnDisposition === "target_rejected") {
    return {
      reason: "tool_target_rejected",
      text: "目标系统未接受本次操作。请检查目标系统的权限、参数或业务前置条件后重试。",
    };
  }
  return null;
}

function suppressRepeatedSourceParameterCard({ argumentsValue = {}, continuation = null, result = {} } = {}) {
  const submittedSource = continuation?.inputSource;
  const repeatedSource = result?.parameterCard?.inputSource;
  if (continuation?.toolId !== "runtime-structured-input" ||
    result?.parameterCard?.toolId !== "runtime-structured-input" ||
    !continuation.schemaDigest || continuation.schemaDigest !== result.parameterCard.schemaDigest ||
    !sameParameterCardInputSource(submittedSource, repeatedSource) ||
    String(argumentsValue?.operationId || "").trim() !== submittedSource.operationId) {
    return result;
  }
  const { parameterCard: _parameterCard, ...rest } = result;
  return {
    ...rest,
    selectionContinuation: {
      contractVersion: "tool-parameter-selection-reused.v1",
      status: "already_submitted",
      inputSource: structuredClone(submittedSource),
      instruction: "The user already submitted this selection. Continue with the selected arguments from the current turn context.",
    },
  };
}

function sameParameterCardInputSource(left = null, right = null) {
  return left?.contractVersion === "tool-parameter-input-source.v1" &&
    right?.contractVersion === "tool-parameter-input-source.v1" &&
    typeof left.toolId === "string" && left.toolId && left.toolId === right.toolId &&
    typeof left.operationId === "string" && left.operationId && left.operationId === right.operationId;
}

function normalizeStructuredResultRequest(value) {
  exactStructuredObject(value, STRUCTURED_RESULT_REQUEST_FIELDS, "model_request_invalid");
  if (value.contractVersion !== STRUCTURED_RESULT_REQUEST_VERSION) {
    throw createProviderRuntimeError("model_request_invalid");
  }
  const taskDefinition = normalizeScheduleTaskExecutionDefinition(value.taskDefinition);
  const resultContract = normalizeScheduleResultContract(value.resultContract);
  if (taskDefinition.executionMode !== "single_provider_structured_result" ||
    taskDefinition.resultContractDigest !== resultContract.contractDigest ||
    taskDefinition.providerRequestPolicy.responseMode !== "structured_result" ||
    taskDefinition.providerRequestPolicy.store !== false ||
    taskDefinition.providerRequestPolicy.toolAccess !== "none" ||
    taskDefinition.providerRequestPolicy.writeback !== "none") {
    throw createProviderRuntimeError("model_request_invalid");
  }
  const inputSnapshot = normalizeStructuredInputSnapshot(value.inputSnapshot, taskDefinition);
  const providerRequestId = structuredToken(value.providerRequestId);
  const requestBytes = Buffer.byteLength(JSON.stringify({
    inputSnapshot,
    resultContract,
    systemInstruction: taskDefinition.systemInstruction,
    taskInstruction: taskDefinition.taskInstruction,
  }), "utf8");
  if (requestBytes > taskDefinition.providerRequestPolicy.maxInputBytes) {
    throw createProviderRuntimeError("model_request_invalid");
  }
  return deepFreeze({ inputSnapshot, providerRequestId, resultContract, taskDefinition });
}

function normalizeStructuredInputSnapshot(value, taskDefinition) {
  exactStructuredObject(value, INPUT_SNAPSHOT_FIELDS, "model_request_invalid");
  if (value.contractVersion !== "schedule-task-input-snapshot.v1" ||
    typeof value.snapshotContractVersion !== "string" || !value.snapshotContractVersion.trim() ||
    !Array.isArray(value.items) || value.items.length > taskDefinition.inputContract.maxItems) {
    throw createProviderRuntimeError("model_request_invalid");
  }
  const budget = { nodes: 0 };
  const normalized = normalizeStructuredJson(value, 0, budget);
  if (Buffer.byteLength(JSON.stringify(normalized), "utf8") > taskDefinition.inputContract.maxPayloadBytes) {
    throw createProviderRuntimeError("model_request_invalid");
  }
  return deepFreeze(normalized);
}

function normalizeStructuredJson(value, depth, budget) {
  budget.nodes += 1;
  if (budget.nodes > STRUCTURED_RESULT_MAX_JSON_NODES || depth > STRUCTURED_RESULT_MAX_JSON_DEPTH) {
    throw createProviderRuntimeError("model_request_invalid");
  }
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw createProviderRuntimeError("model_request_invalid");
    return Object.is(value, -0) ? 0 : value;
  }
  if (Array.isArray(value)) return value.map((item) => normalizeStructuredJson(item, depth + 1, budget));
  if (!value || typeof value !== "object" || Object.getPrototypeOf(value) !== Object.prototype) {
    throw createProviderRuntimeError("model_request_invalid");
  }
  const result = {};
  for (const key of Object.keys(value).sort()) {
    Object.defineProperty(result, key, {
      enumerable: true,
      value: normalizeStructuredJson(value[key], depth + 1, budget),
    });
  }
  return result;
}

function structuredResultBody(model, request) {
  const envelopeSchema = {
    type: "object",
    properties: {
      contractVersion: stringEnum(["schedule-structured-result.v1"]),
      outcomeCode: stringEnum(request.resultContract.outcomeRules.map((rule) => rule.outcomeCode)),
      payload: request.resultContract.payloadSchema,
      resultContractDigest: stringEnum([request.resultContract.contractDigest]),
      resultContractId: stringEnum([request.resultContract.resultContractId]),
      resultContractVersion: { type: "integer", enum: [request.resultContract.resultContractVersion] },
      resultType: stringEnum([request.resultContract.resultType]),
      schemaVersion: stringEnum([request.resultContract.schemaVersion]),
    },
    required: [
      "contractVersion", "outcomeCode", "payload", "resultContractDigest", "resultContractId",
      "resultContractVersion", "resultType", "schemaVersion",
    ],
    additionalProperties: false,
  };
  const userInput = JSON.stringify({
    instruction: request.taskDefinition.taskInstruction,
    inputSnapshot: request.inputSnapshot,
    requiredEnvelopeSchema: envelopeSchema,
  });
  return {
    model,
    instructions: request.taskDefinition.systemInstruction,
    input: [{ role: "user", content: userInput }],
    max_output_tokens: request.taskDefinition.providerRequestPolicy.maxOutputTokens,
    parallel_tool_calls: false,
    store: false,
    stream: true,
    text: {
      format: {
        type: "json_schema",
        name: "schedule_structured_result",
        strict: true,
        schema: envelopeSchema,
      },
    },
    tool_choice: "none",
    tools: [],
  };
}

function structuredResultCandidate(text) {
  if (!text) return deepFreeze({
    contractVersion: "schedule-provider-unparsed-response.v1",
    failureCode: "empty_output",
  });
  try {
    const parsed = JSON.parse(text);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed) &&
      Object.getPrototypeOf(parsed) === Object.prototype) {
      return deepFreeze(normalizeStructuredJson(parsed, 0, { nodes: 0 }));
    }
  } catch {
    // Preserve the known response only inside the encrypted ingest boundary.
  }
  return deepFreeze({
    contractVersion: "schedule-provider-unparsed-response.v1",
    rawText: text,
  });
}

function providerResponseRef(value, fallback) {
  const candidate = String(value || "").trim();
  if (STRUCTURED_RESULT_TOKEN.test(candidate) && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(candidate)) {
    return candidate;
  }
  return fallback;
}

function structuredToken(value) {
  const result = String(value || "").trim();
  if (!STRUCTURED_RESULT_TOKEN.test(result) || /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(result)) {
    throw createProviderRuntimeError("model_request_invalid");
  }
  return result;
}

function stringEnum(values) {
  return { type: "string", enum: [...values] };
}

function exactStructuredObject(value, fields, code) {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype) throw createProviderRuntimeError(code);
  const keys = Object.keys(value);
  if (keys.length !== fields.size || keys.some((key) => !fields.has(key))) {
    throw createProviderRuntimeError(code);
  }
}

function providerOnlyPayloadIsSafe(payload, requestedModel) {
  if (!payload || payload.model !== requestedModel || !Array.isArray(payload.output) || payload.output.length !== 1) return false;
  if (payload.output.some((item) => item?.type !== "message")) return false;
  if (payload.output.some((item) => item?.role !== "assistant")) return false;
  const content = payload.output.flatMap((item) => Array.isArray(item?.content) ? item.content : []);
  if (!content.length || content.some((item) => item?.type !== "output_text")) return false;
  return readResponsesOutputText(payload).trim() === PROVIDER_ONLY_PROBE_TEXT;
}

function providerOnlyStopError({ isTaskCancellationRequested, now, runtimeTask, signal }) {
  if (signal?.aborted) return signal.reason || runnerError("agent_turn_canceled");
  const deadlineAtMs = Date.parse(runtimeTask?.executionDeadlineAt || "");
  if (Number.isFinite(deadlineAtMs) && deadlineAtMs <= now()) return runnerError("task_execution_timeout");
  if (!runtimeTask?.id) return null;
  try {
    return isTaskCancellationRequested(runtimeTask) ? runnerError("agent_turn_canceled") : null;
  } catch {
    return runnerError("execution_task_cancellation_state_unavailable");
  }
}

function runnerError(code, { completionCandidateIssues = [] } = {}) {
  const error = new Error(code);
  error.code = code;
  const safeIssues = [...new Set((Array.isArray(completionCandidateIssues) ? completionCandidateIssues : [])
    .map((value) => safeCompletionCode({ code: value }, ""))
    .filter(Boolean))].slice(0, 8);
  if (safeIssues.length) error.completionCandidateIssues = Object.freeze(safeIssues);
  return error;
}

function responseRequestForAgentLoop({ input = [], prompt = {}, toolChoice = "auto", tools = [] } = {}) {
  return {
    ...prompt,
    input,
    stream: true,
    tools,
    tool_choice: toolChoice === "required" ? "required" : toolChoice === "none" ? "none" : "auto",
    parallel_tool_calls: false,
  };
}

async function evaluateCompletionCandidate(candidateEvaluator, text) {
  if (!candidateEvaluator) return { status: "accepted", value: undefined };
  let result;
  try {
    result = await candidateEvaluator({ text });
  } catch (error) {
    throw runnerError(safeCompletionCode(error, "agent_completion_evaluator_failed"));
  }
  if (!result || typeof result !== "object" || Array.isArray(result) ||
    !["accepted", "repairable", "terminal"].includes(result.status)) {
    throw runnerError("agent_completion_evaluator_invalid");
  }
  if (result.status === "accepted") return { status: "accepted", value: result.value };
  const code = safeCompletionCode({ code: result.code }, "agent_completion_candidate_invalid");
  const issues = [...new Set((Array.isArray(result.issues) ? result.issues : [])
    .map((issue) => safeCompletionCode({ code: issue }, ""))
    .filter(Boolean))].slice(0, 8);
  return { status: result.status, code, issues };
}

function assertCompletionEvidenceReachable(contract, toolExecutor) {
  const missingEvidence = missingAgentCompletionEvidence(
    contract,
    toolExecutor.completionEvidence?.() || [],
  );
  if (!missingEvidence.length) return;
  const available = new Set((toolExecutor.completionEvidenceCapabilities?.() || [])
    .map((capability) => String(capability?.contractId || "").trim())
    .filter(Boolean));
  if (missingEvidence.some((contractId) => !available.has(contractId))) {
    throw runnerError("agent_completion_evidence_unavailable");
  }
}

function completionToolPolicyForEvidence(toolExecutor, missingEvidence) {
  const required = new Set(missingEvidence);
  const policy = new Map();
  for (const capability of toolExecutor.completionEvidenceCapabilities?.() || []) {
    if (!required.has(capability?.contractId)) continue;
    for (const toolName of capability.allowedToolNames || []) {
      const normalized = cleanId(toolName);
      if (!normalized) continue;
      const current = policy.get(normalized) || { fixedArguments: [], unrestricted: false };
      if (normalized === cleanId(capability.toolName)) {
        const fixedArguments = completionFixedArguments(capability.fixedArguments);
        if (fixedArguments) current.fixedArguments.push(fixedArguments);
      } else {
        current.unrestricted = true;
      }
      policy.set(normalized, current);
    }
  }
  if (!policy.size) throw runnerError("agent_completion_evidence_unavailable");
  return policy;
}

function assertCompletionToolCallAllowed(policy, toolName, argumentsValue) {
  if (!policy) return;
  const rule = policy.get(cleanId(toolName));
  if (!rule) throw runnerError("agent_completion_tool_not_allowed");
  if (rule.unrestricted) return;
  if (!rule.fixedArguments.length || !rule.fixedArguments.some((expected) =>
    Object.entries(expected).every(([key, value]) => argumentsValue?.[key] === value))) {
    throw runnerError("agent_completion_tool_arguments_not_allowed");
  }
}

function completionFixedArguments(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const entries = Object.entries(value).filter(([key, item]) =>
    /^[A-Za-z][A-Za-z0-9_]{0,79}$/.test(key) && typeof item === "string" && item.length <= 240);
  return entries.length ? Object.freeze(Object.fromEntries(entries)) : null;
}

function completionFeedbackText(feedback, { toolsDisabled = false } = {}) {
  return [
    "<agent_completion_feedback>",
    JSON.stringify(feedback),
    "</agent_completion_feedback>",
    toolsDisabled
      ? "The candidate output did not satisfy its completion contract. Correct only the final output using existing evidence; Tools are disabled for this bounded correction round."
      : "The candidate output is missing required completion evidence. Continue within the original task and current governed capabilities; do not repeat completed external effects or reads unless necessary.",
  ].join("\n");
}

function safeCompletionCode(error, fallback) {
  const code = String(error?.code || "").trim();
  return /^[a-z][a-z0-9_]{1,119}$/.test(code) ? code : fallback;
}

function readResponsesOutputText(payload = {}) {
  if (typeof payload.output_text === "string") return payload.output_text;
  return (payload.output || []).flatMap((item) => {
    if (item?.type !== "message") return [];
    return (item.content || []).map((content) => content?.text || content?.value || "");
  }).filter(Boolean).join("\n");
}

function appendRuntimeRequestMetric(state, {
  requestContext = null,
  result = null,
  status = "received",
  sequence = 0,
  durationMs = 0,
} = {}) {
  if (!state || !Number.isSafeInteger(sequence) || sequence < 1) return;
  const input = requestContext?.input;
  const inputItemCount = Array.isArray(input) ? input.length : (input == null ? 0 : 1);
  const inputCharacterCount = boundedInputCharacterCount(input);
  const usage = sanitizeUsage(result?.usage);
  const cachedInputTokens = Number(
    result?.usage?.input_tokens_details?.cached_tokens ?? result?.usage?.cached_input_tokens,
  );
  const metric = {
    sequence,
    status,
    inputItemCount,
    inputCharacterCount,
    inputTokens: usage.inputTokens ?? null,
    cachedInputTokens: Number.isFinite(cachedInputTokens) ? cachedInputTokens : null,
    outputTokens: usage.outputTokens ?? null,
    totalTokens: usage.totalTokens ?? null,
    durationMs: Math.max(0, Math.min(24 * 60 * 60 * 1000, Math.floor(Number(durationMs) || 0))),
  };
  state.requestMetrics = [...(state.requestMetrics || []), metric].slice(-MAX_RUNTIME_REQUEST_METRICS);
}

function boundedInputCharacterCount(input) {
  if (input == null) return 0;
  let serialized;
  try {
    serialized = typeof input === "string" ? input : JSON.stringify(input);
  } catch {
    serialized = "";
  }
  return Math.min(2_000_000, String(serialized || "").length);
}

function parseToolArguments(value = "") {
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function sanitizeUsage(usage = {}) {
  if (!usage || typeof usage !== "object") return {};
  const inputTokens = Number(usage.input_tokens ?? usage.prompt_tokens);
  const outputTokens = Number(usage.output_tokens ?? usage.completion_tokens);
  const totalTokens = Number(usage.total_tokens);
  return {
    inputTokens: Number.isFinite(inputTokens) ? inputTokens : undefined,
    outputTokens: Number.isFinite(outputTokens) ? outputTokens : undefined,
    totalTokens: Number.isFinite(totalTokens) ? totalTokens : undefined,
  };
}

function addUsage(total = {}, next = {}) {
  const inputTokens = Number(total.inputTokens || 0) + Number(next.inputTokens || 0);
  const outputTokens = Number(total.outputTokens || 0) + Number(next.outputTokens || 0);
  const explicitTotal = Number(total.totalTokens || 0) + Number(next.totalTokens || 0);
  return {
    inputTokens,
    outputTokens,
    totalTokens: explicitTotal || inputTokens + outputTokens,
  };
}

function agentStopReason({
  isTaskCancellationRequested = () => false,
  loopPolicy = DEFAULT_AGENT_LOOP_POLICY,
  now = () => Date.now(),
  runtimeTask = null,
  signal = null,
  startedAtMs = now(),
  totalUsage = {},
} = {}) {
  if (signal?.aborted && !isTimeoutReason(signal.reason?.code)) return "agent_turn_canceled";
  if (runtimeTask?.id) {
    try {
      if (isTaskCancellationRequested(runtimeTask)) return "agent_turn_canceled";
    } catch {
      // A transient store read failure must not invent a cancellation.
    }
  }
  if (!runtimeTask?.executionDeadlineAt && loopPolicy.maxDurationMs > 0 && now() - startedAtMs >= loopPolicy.maxDurationMs) {
    return "agent_run_time_budget_reached";
  }
  if (loopPolicy.maxTotalTokens > 0 && Number(totalUsage.totalTokens || 0) >= loopPolicy.maxTotalTokens) {
    return "agent_run_token_budget_reached";
  }
  return "";
}

function deepFreeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    Object.values(value).forEach(deepFreeze);
  }
  return value;
}

function providerAttemptError(value, semanticOutputObserved) {
  const source = value instanceof Error ? value : new Error("model_request_failed");
  const error = Object.isExtensible(source) ? source : Object.assign(new Error(source.message), {
    code: source.code,
    isExternalAbort: source.isExternalAbort,
    isModelRuntimeError: source.isModelRuntimeError,
    isProviderTimeout: source.isProviderTimeout,
    retryable: source.retryable,
    retryAfterMs: source.retryAfterMs,
    timeoutStage: source.timeoutStage,
  });
  error.providerSemanticOutputObserved = semanticOutputObserved === true;
  return error;
}

function isTimeoutReason(value) {
  return [
    "provider_connect_timeout",
    "provider_first_semantic_output_timeout",
    "provider_request_total_timeout",
    "provider_stream_idle_timeout",
    "task_execution_timeout",
  ].includes(String(value || ""));
}

function normalizeAgentLoopPolicy(input = {}) {
  return {
    maxDurationMs: clampInteger(input?.maxDurationMs, DEFAULT_AGENT_LOOP_POLICY.maxDurationMs, 0, 48 * 60 * 60 * 1000),
    maxTotalTokens: clampInteger(input?.maxTotalTokens, DEFAULT_AGENT_LOOP_POLICY.maxTotalTokens, 0, 5_000_000),
    repeatedToolThreshold: clampInteger(input?.repeatedToolThreshold, DEFAULT_AGENT_LOOP_POLICY.repeatedToolThreshold, 2, 20),
  };
}

function clampInteger(value, fallback, minimum, maximum) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(minimum, Math.min(maximum, Math.floor(number)));
}

function createRuntimeEvidenceState({ adapter, lease = {}, persistenceEnabled = true, prompt = {}, runtimeTask = null } = {}) {
  const taskId = cleanId(runtimeTask?.taskId || runtimeTask?.id) || `ephemeral-${crypto.randomUUID()}`;
  const existing = runtimeTask?.runtimeEvidence || null;
  const projector = createRuntimeSafeActivityProjector({ taskId });
  const sourceSnapshot = runtimeTask?.activitySnapshot || existing?.activitySnapshot || null;
  const activitySnapshot = sourceSnapshot
    ? projector.snapshot(sourceSnapshot.activities)
    : projector.snapshot([]);
  if (existing && Number(existing.toolCallCount || 0) !== activitySnapshot.activities.length) {
    throw runnerError("runtime_safe_activity_history_incomplete");
  }
  return {
    taskId,
    adapter: cleanId(adapter),
    provider: cleanId(lease.provider),
    model: cleanId(prompt.model || lease.model),
    reasoningEffort: cleanId(prompt.reasoning?.effort || lease.reasoningEffort),
    requestCount: Number(existing?.requestCount || 0),
    toolCallCount: activitySnapshot.activities.length,
    activitySnapshot,
    usage: existing?.usage || {},
    requestMetrics: Array.isArray(existing?.requestMetrics) ? existing.requestMetrics.slice(-MAX_RUNTIME_REQUEST_METRICS) : [],
    blockedReason: "",
    providerDiagnostic: existing?.providerDiagnostic || DEFAULT_PROVIDER_DIAGNOSTIC,
    persistenceEnabled,
  };
}

function safeRuntimeEvidenceReason(error) {
  const code = String(error?.code || error?.name || "").trim();
  return new Set([
    "agent_turn_blocked",
    "agent_turn_canceled",
    "execution_task_ownership_lost",
    "model_rate_limited",
    "model_provider_rate_limited",
    "model_provider_unavailable",
    "model_request_failed",
    "model_request_invalid",
    "model_response_contract_invalid",
    "provider_adapter_not_registered",
    "provider_connect_timeout",
    "provider_first_semantic_output_timeout",
    "provider_request_total_timeout",
    "provider_stream_idle_timeout",
    "task_execution_timeout",
  ]).has(code) ? code : "model_request_failed";
}

function safeRuntimeProviderDiagnostic(error, context = {}) {
  return normalizeProviderRuntimeDiagnostic(error?.providerDiagnostic, {
    fallbackCategory: error?.isProviderTimeout ? "provider_timeout" : "provider_runtime_error",
    fallbackReasonCode: safeRuntimeEvidenceReason(error),
    retryable: error?.retryable === true,
    ...context,
  });
}

function safeOptionalUsage(value) {
  const number = Number(value);
  return Number.isSafeInteger(number) && number >= 0 ? number : null;
}

function cleanId(value = "") {
  return String(value || "").trim().slice(0, 160);
}

function cleanText(value = "") {
  return String(value || "").trim().slice(0, 4_000);
}

export {
  DEFAULT_AGENT_LOOP_POLICY,
  createResponsesAgentRunner,
  normalizeAgentLoopPolicy,
};
