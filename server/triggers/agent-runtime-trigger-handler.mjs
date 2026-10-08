import crypto from "node:crypto";

const HANDLER_CONTRACT_VERSION = "trigger-executor-handler.v1";
const EXECUTION_CONTRACT_VERSION = "trigger-handler-execution.v1";
const RESULT_CONTRACT_VERSION = "trigger-review-result.v1";
const RESULT_EVIDENCE_CONTRACT_VERSION = "trigger-review-result-evidence.v1";
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

function createAgentRuntimeTriggerHandler({
  agentExecutionService,
  buildExecutionResources,
  enabled,
  handlerVersion,
  outputPolicy,
  providerLeaseResolver,
  resolveWritebackBinding,
  resultRepository,
  reviewStatus,
  taskDefinitionId,
  writebackEffect,
} = {}) {
  requireMethod(agentExecutionService, "buildPrompt");
  requireMethod(agentExecutionService, "execute");
  requireFunction(buildExecutionResources, "buildExecutionResources");
  requireFunction(providerLeaseResolver, "providerLeaseResolver");
  requireFunction(resolveWritebackBinding, "resolveWritebackBinding");
  requireMethod(resultRepository, "getInternal");
  requireMethod(resultRepository, "saveOrGet");
  requireFunction(writebackEffect, "writebackEffect");
  requireMethod(outputPolicy, "outputFormat");
  requireMethod(outputPolicy, "instructions");
  requireMethod(outputPolicy, "normalizeResult");
  requireMethod(outputPolicy, "normalizeStoredResult");
  if (typeof enabled !== "boolean" ||
    !["approved", "pending_review", "rejected"].includes(reviewStatus)) {
    throw new TypeError("Agent Runtime Trigger handler governance invalid");
  }
  const exactTaskDefinitionId = requiredToken(taskDefinitionId, 160);
  const exactHandlerVersion = requiredToken(handlerVersion, 80);

  async function execute(value) {
    let request;
    try {
      request = normalizeExecution(value);
      if (request.context.taskDefinition.taskDefinitionId !== exactTaskDefinitionId ||
        request.context.taskDefinition.handlerVersion !== exactHandlerVersion) {
        throw new TypeError("Agent Runtime Trigger task definition mismatch");
      }
    } catch {
      return blockedSettlement("trigger_agent_runtime_context_invalid");
    }
    if (canceled(request)) return canceledSettlement();

    let writebackBinding;
    try {
      writebackBinding = await resolveWritebackBinding(Object.freeze({
        binding: request.context.binding,
        employee: request.context.employee,
        task: request.task,
        taskDefinition: request.context.taskDefinition,
        triggerEvent: request.context.triggerEvent,
      }));
      if (!isPlainObject(writebackBinding) ||
        !Number.isInteger(writebackBinding.maxCommentChars) ||
        writebackBinding.maxCommentChars < 1 || writebackBinding.maxCommentChars > 20_000) {
        throw new TypeError("writeback binding invalid");
      }
    } catch {
      return blockedSettlement("trigger_review_writeback_binding_unavailable");
    }

    let existing;
    try {
      existing = await resultRepository.getInternal(resultIdentity(request));
    } catch {
      return failedSettlement("trigger_review_result_persistence_failed");
    }
    if (existing) {
      let resumed;
      try {
        resumed = normalizeStoredResult(
          existing,
          request,
          writebackBinding,
          outputPolicy,
        );
      } catch {
        return failedSettlement("trigger_review_result_persistence_failed");
      }
      if (canceled(request)) return canceledSettlement();
      return writePersistedResult({
        evidence: resumed.evidence,
        outcomeStatus: resumed.outcomeStatus,
        request,
        reviewComment: resumed.reviewComment,
        writebackBinding,
        writebackEffect,
      });
    }

    let resources;
    try {
      resources = normalizeExecutionResources(await buildExecutionResources(Object.freeze({
        binding: request.context.binding,
        employee: request.context.employee,
        signal: request.signal,
        task: request.task,
        taskDefinition: request.context.taskDefinition,
        triggerEvent: request.context.triggerEvent,
      })));
    } catch (error) {
      return failedSettlement(safeExecutionCode(error, "trigger_agent_runtime_resources_failed"));
    }

    try {
      if (canceled(request)) return canceledSettlement();
      const lease = await providerLeaseResolver({
        employee: request.context.employee,
        runtimeTask: request.task,
      });
      if (!lease) return blockedSettlement("trigger_review_provider_unavailable");
      let prompt;
      try {
        const candidateEvaluator = ({ text }) => evaluatePolicyCandidate({
          maxCommentChars: writebackBinding.maxCommentChars,
          outputPolicy,
          text,
        });
        prompt = agentExecutionService.buildPrompt({
          candidateEvaluator,
          completionContract: outputPolicy.completionContract?.({
            taskDefinition: request.context.taskDefinition,
          }),
          conversationHistory: [],
          dependencyContext: resources.dependencyContext,
          employeeIdentity: resources.employeeIdentity,
          lease,
          maxOutputTokens: outputPolicy.maxOutputTokens,
          outputFormat: outputPolicy.outputFormat({
            taskDefinition: request.context.taskDefinition,
            writebackBinding,
          }),
          references: resources.references,
          runtimeContext: {
            currentTurn: {
              text: outputPolicy.instructions({
                taskDefinition: request.context.taskDefinition,
                triggerEvent: request.context.triggerEvent,
              }),
            },
          },
          safeContext: resources.safeContext,
          stream: false,
          toolExecutor: resources.toolExecutor,
        });
      } catch {
        return failedSettlement("trigger_agent_runtime_prompt_invalid");
      }
      let agentResult;
      try {
        agentResult = await agentExecutionService.execute({
          lease,
          prompt,
          runtimeTask: request.task,
          signal: request.signal,
          toolExecutor: resources.toolExecutor,
        });
      } catch (error) {
        return failedSettlement(safeExecutionCode(error, "trigger_agent_runtime_execution_failed"));
      }
      if (agentResult?.partial === true || agentResult?.reason === "agent_turn_canceled") {
        return agentResult?.reason === "agent_turn_canceled"
          ? canceledSettlement()
          : failedSettlement(partialResultCode(agentResult));
      }
      let outcome;
      try {
        outcome = normalizePolicyOutcome(
          agentResult?.completionOutcome ?? outputPolicy.normalizeResult({
            maxCommentChars: writebackBinding.maxCommentChars,
            text: agentResult?.text,
          }),
          writebackBinding.maxCommentChars,
        );
      } catch (error) {
        return failedSettlement(safeExecutionCode(error, "trigger_agent_review_output_invalid"));
      }
      if (canceled(request)) return canceledSettlement();
      let evidence;
      try {
        const stored = await resultRepository.saveOrGet(Object.freeze({
          contractVersion: RESULT_CONTRACT_VERSION,
          ...resultIdentity(request),
          result: Object.freeze({
            ...outcome.result,
            executionPolicyDigest: executionPolicyDigest(request, writebackBinding),
          }),
          reviewComment: outcome.reviewComment,
        }));
        evidence = normalizeResultEvidence(stored?.evidence, request);
      } catch {
        return failedSettlement("trigger_review_result_persistence_failed");
      }
      if (canceled(request)) return canceledSettlement();
      return writePersistedResult({
        evidence,
        outcomeStatus: outcome.result.status,
        request,
        reviewComment: outcome.reviewComment,
        writebackBinding,
        writebackEffect,
      });
    } finally {
      try {
        await resources.cleanup();
      } catch {
        const error = new Error("trigger_agent_runtime_cleanup_failed");
        error.code = "trigger_agent_runtime_cleanup_failed";
        throw error;
      }
    }
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

async function writePersistedResult({ evidence, outcomeStatus, request, reviewComment, writebackBinding,
  writebackEffect }) {
  let writeback;
  try {
    writeback = await writebackEffect(Object.freeze({
      evidence,
      operationReceiptContext: request.operationReceiptContext,
      reviewComment,
      signal: request.signal,
      task: request.task,
      triggerEvent: request.context.triggerEvent,
      writebackBinding,
    }));
  } catch (error) {
    return failedSettlement(safeExecutionCode(error, "trigger_review_writeback_failed"));
  }
  if (!isPlainObject(writeback) ||
    !["succeeded", "definitive_failed", "unknown"].includes(writeback.status) ||
    writeback.receipt?.status !== writeback.status ||
    !SAFE_CODE.test(String(writeback.receipt?.safeResultCode || ""))) {
    return blockedSettlement("trigger_review_writeback_outcome_unknown");
  }
  if (writeback.status === "unknown") {
    return blockedSettlement("trigger_review_writeback_outcome_unknown");
  }
  if (writeback.status === "definitive_failed") {
    return failedSettlement(writeback.receipt.safeResultCode);
  }
  if (writeback.receipt.payload?.contractVersion !== "trigger-review-writeback-safe-receipt.v1" ||
    writeback.receipt.payload?.evidenceDigest !== evidence.evidenceDigest ||
    Object.keys(writeback.receipt.payload).length !== 2) {
    return blockedSettlement("trigger_review_writeback_outcome_unknown");
  }
  return completedSettlement(evidence.evidenceDigest, outcomeStatus);
}

function normalizeExecutionResources(value) {
  if (!isPlainObject(value) || typeof value.cleanup !== "function" ||
    typeof value.toolExecutor?.toolDefinitions !== "function" ||
    value.dependencyContext?.contractVersion !== "digital-employee-runtime-dependency-context.v2" ||
    !isPlainObject(value.employeeIdentity) || !isPlainObject(value.safeContext) ||
    !Array.isArray(value.references)) {
    throw new TypeError("Agent Runtime Trigger resources invalid");
  }
  return value;
}

function normalizePolicyOutcome(value, maximum) {
  if (!isPlainObject(value) || !isPlainObject(value.result) ||
    typeof value.result.contractVersion !== "string" ||
    !SAFE_CODE.test(value.result.contractVersion.replace(/[.-]/g, "_")) ||
    typeof value.reviewComment !== "string" || value.reviewComment !== value.reviewComment.trim() ||
    !value.reviewComment || value.reviewComment.length > maximum ||
    /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/.test(value.reviewComment)) {
    throw new TypeError("Agent Runtime Trigger policy outcome invalid");
  }
  return Object.freeze({ result: value.result, reviewComment: value.reviewComment });
}

function evaluatePolicyCandidate({ maxCommentChars, outputPolicy, text }) {
  try {
    return Object.freeze({
      status: "accepted",
      value: normalizePolicyOutcome(outputPolicy.normalizeResult({ maxCommentChars, text }), maxCommentChars),
    });
  } catch (error) {
    const code = safeExecutionCode(error, "trigger_agent_review_output_invalid");
    return Object.freeze({
      status: code === "trigger_agent_review_output_invalid" ? "repairable" : "terminal",
      code,
      ...(typeof outputPolicy.candidateIssues === "function"
        ? { issues: outputPolicy.candidateIssues({ maxCommentChars, text }) }
        : {}),
    });
  }
}

function normalizeExecution(value) {
  requireExactObject(value, EXECUTION_FIELDS, "Agent Runtime Trigger execution");
  if (value.contractVersion !== EXECUTION_CONTRACT_VERSION ||
    typeof value.isCancellationRequested !== "function" || !isAbortSignal(value.signal) ||
    !isPlainObject(value.context) || !isPlainObject(value.context.binding) ||
    !isPlainObject(value.context.employee) || !isPlainObject(value.context.taskDefinition) ||
    !isPlainObject(value.context.triggerEvent) || !isPlainObject(value.task)) {
    throw new TypeError("Agent Runtime Trigger execution invalid");
  }
  const repository = value.operationReceiptContext?.repositoryContext;
  if (!isPlainObject(repository) || repository.taskId !== value.task.taskId ||
    repository.tenantScope !== value.task.tenantScope || !DIGEST.test(repository.workerIdDigest) ||
    !Number.isSafeInteger(repository.fencingToken) || repository.fencingToken <= 0) {
    throw new TypeError("Agent Runtime Trigger receipt context invalid");
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

function normalizeStoredResult(value, request, writebackBinding, outputPolicy) {
  const maximum = writebackBinding.maxCommentChars;
  if (!isPlainObject(value) || typeof value.reviewComment !== "string" ||
    value.reviewComment !== value.reviewComment.trim() || !value.reviewComment ||
    value.reviewComment.length > maximum) {
    throw new TypeError("stored Agent Runtime Trigger result invalid");
  }
  if (value.result?.executionPolicyDigest !== executionPolicyDigest(request, writebackBinding)) {
    throw new TypeError("stored Agent Runtime Trigger policy attestation invalid");
  }
  const normalizedResult = outputPolicy.normalizeStoredResult({
    result: value.result,
    taskDefinition: request.context.taskDefinition,
  });
  return Object.freeze({
    reviewComment: value.reviewComment,
    outcomeStatus: requiredToken(normalizedResult.status, 80),
    evidence: normalizeResultEvidence({
      contractVersion: RESULT_EVIDENCE_CONTRACT_VERSION,
      tenantScope: value.tenantScope,
      triggerEventId: value.triggerEventId,
      taskId: value.taskId,
      reviewResultId: value.reviewResultId,
      evidenceDigest: value.evidenceDigest,
      sealedAt: value.sealedAt,
    }, request),
  });
}

function executionPolicyDigest(request, writebackBinding) {
  const snapshot = request.context.triggerEvent?.executionSnapshot || {};
  const subject = request.context.triggerEvent?.event?.subject || {};
  return crypto.createHash("sha256").update(JSON.stringify([
    "trigger-agent-execution-policy-attestation.v1",
    snapshot.bindingId,
    snapshot.bindingVersion,
    snapshot.taskDefinitionId,
    snapshot.taskDefinitionVersion,
    snapshot.handlerVersion,
    snapshot.skillPolicyRef,
    snapshot.toolPolicyRef,
    snapshot.outputPolicyRef,
    snapshot.writebackPolicyRef,
    subject.objectApiName,
    subject.objectId,
    writebackBinding.writebackBindingId,
    writebackBinding.bindingVersion,
  ])).digest("hex");
}

function normalizeResultEvidence(value, request) {
  if (!isPlainObject(value) || value.contractVersion !== RESULT_EVIDENCE_CONTRACT_VERSION ||
    value.tenantScope !== request.task.tenantScope || value.taskId !== request.task.taskId ||
    value.triggerEventId !== request.context.triggerEvent.triggerEventId ||
    !DIGEST.test(String(value.evidenceDigest || "")) ||
    typeof value.sealedAt !== "string" || !Number.isFinite(Date.parse(value.sealedAt))) {
    throw new TypeError("Agent Runtime Trigger result evidence invalid");
  }
  requiredToken(value.reviewResultId, 240);
  return Object.freeze({ ...value });
}

function canceled(request) {
  if (request.signal.aborted) return true;
  try {
    return request.isCancellationRequested() !== false;
  } catch {
    return true;
  }
}

function canceledSettlement() {
  return blockedSettlement("agent_turn_canceled");
}

function blockedSettlement(code) {
  return settlement("blocked", code, code, null);
}

function failedSettlement(code) {
  return settlement("failed", code, "trigger_agent_runtime_review_failed", null);
}

function partialResultCode(agentResult = {}) {
  return agentResult?.reason === "agent_tool_not_allowed"
    ? "agent_tool_not_allowed"
    : "trigger_agent_runtime_partial_result";
}

function completedSettlement(evidenceDigest, outcomeStatus) {
  return settlement(
    "completed",
    null,
    outcomeStatus === "insufficient_material"
      ? "trigger_agent_runtime_insufficient_material_completed"
      : "trigger_agent_runtime_review_completed",
    evidenceDigest,
  );
}

function settlement(status, lastErrorCode, resultSummary, terminalEvidenceDigest) {
  return Object.freeze({ status, lastErrorCode, resultSummary, terminalEvidenceDigest });
}

function safeExecutionCode(error, fallback) {
  const code = String(error?.code || "");
  return SAFE_CODE.test(code) ? code : fallback;
}

function requiredToken(value, maximum) {
  if (typeof value !== "string" || value !== value.trim() || !value || value.length > maximum ||
    !/^[A-Za-z0-9][A-Za-z0-9._:@/-]*$/.test(value)) {
    throw new TypeError("Agent Runtime Trigger reference invalid");
  }
  return value;
}

function requireMethod(value, method) {
  if (typeof value?.[method] !== "function") {
    throw new TypeError(`Agent Runtime Trigger requires ${method}`);
  }
}

function requireFunction(value, name) {
  if (typeof value !== "function") throw new TypeError(`Agent Runtime Trigger requires ${name}`);
}

function requireExactObject(value, fields, label) {
  if (!isPlainObject(value) || Object.keys(value).length !== fields.size ||
    Object.keys(value).some((field) => !fields.has(field)) ||
    [...fields].some((field) => !Object.hasOwn(value, field))) {
    throw new TypeError(`${label} fields invalid`);
  }
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value) &&
    [Object.prototype, null].includes(Object.getPrototypeOf(value));
}

function isAbortSignal(value) {
  return Boolean(value) && typeof value.aborted === "boolean" &&
    typeof value.addEventListener === "function";
}

export { createAgentRuntimeTriggerHandler };
