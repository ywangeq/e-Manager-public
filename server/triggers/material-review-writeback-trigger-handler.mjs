const HANDLER_CONTRACT_VERSION = "trigger-executor-handler.v1";
const EXECUTION_CONTRACT_VERSION = "trigger-handler-execution.v1";
const SKILL_RESULT_CONTRACT_VERSION = "trigger-material-review-skill-result.v1";
const REVIEW_RESULT_CONTRACT_VERSION = "trigger-review-result.v1";
const REVIEW_RESULT_EVIDENCE_CONTRACT_VERSION = "trigger-review-result-evidence.v1";

const EXECUTION_FIELDS = new Set([
  "context",
  "contractVersion",
  "isCancellationRequested",
  "operationReceiptContext",
  "signal",
  "task",
]);
const RESOLUTION_FIELDS = new Set(["materialBinding", "writebackBinding"]);
const SKILL_RESULT_FIELDS = new Set(["contractVersion", "result", "safeResultCode", "status"]);
const RESULT_EVIDENCE_FIELDS = new Set([
  "contractVersion",
  "evidenceDigest",
  "reviewResultId",
  "sealedAt",
  "taskId",
  "tenantScope",
  "triggerEventId",
]);
const OPERATION_RECEIPT_CONTEXT_FIELDS = new Set(["repositoryContext"]);
const OPERATION_RECEIPT_REPOSITORY_CONTEXT_FIELDS = new Set([
  "fencingToken",
  "leaseId",
  "taskId",
  "tenantScope",
  "workerIdDigest",
]);
const SKILL_STATUSES = new Set(["blocked", "completed", "failed"]);
const SAFE_CODE = /^[a-z][a-z0-9_]{1,119}$/;
const DIGEST = /^[a-f0-9]{64}$/;

function createMaterialReviewWritebackTriggerHandler({
  acquireWorkspace,
  composeReviewComment,
  enabled,
  handlerVersion,
  resolveMaterialBinding,
  resultRepository,
  reviewStatus,
  runSkill,
  taskDefinitionId,
  writebackEffect,
} = {}) {
  requireFunction(resolveMaterialBinding, "resolveMaterialBinding");
  requireFunction(acquireWorkspace, "acquireWorkspace");
  requireFunction(runSkill, "runSkill");
  requireFunction(composeReviewComment, "composeReviewComment");
  requireFunction(resultRepository?.getInternal, "resultRepository.getInternal");
  requireFunction(resultRepository?.saveOrGet, "resultRepository.saveOrGet");
  requireFunction(writebackEffect, "writebackEffect");
  if (typeof enabled !== "boolean") throw new TypeError("material review handler requires enabled");
  if (!["approved", "pending_review", "rejected"].includes(reviewStatus)) {
    throw new TypeError("material review handler requires a governed reviewStatus");
  }

  async function execute(value) {
    let request;
    try {
      request = normalizeExecution(value);
    } catch {
      return blockedSettlement("trigger_material_review_context_invalid");
    }
    if (canceled(request)) return canceledSettlement();

    let bindings;
    try {
      bindings = normalizeBindingResolution(await resolveMaterialBinding(Object.freeze({
        binding: request.context.binding,
        employee: request.context.employee,
        task: request.task,
        triggerEvent: request.context.triggerEvent,
      })));
    } catch {
      return blockedSettlement("trigger_material_binding_resolution_failed");
    }
    if (canceled(request)) return canceledSettlement();

    let existingResult;
    try {
      existingResult = await resultRepository.getInternal({
        tenantScope: request.task.tenantScope,
        triggerEventId: requiredToken(request.context.triggerEvent.triggerEventId, 240),
        taskId: request.task.taskId,
      });
    } catch {
      return failedSettlement("trigger_review_result_persistence_failed");
    }
    if (existingResult) {
      const resumed = normalizeStoredResult(
        existingResult,
        request,
        bindings.writebackBinding.maxCommentChars,
      );
      if (canceled(request)) return canceledSettlement();
      return writePersistedResult({
        bindings,
        request,
        resultEvidence: resumed.evidence,
        reviewComment: resumed.reviewComment,
        writebackEffect,
      });
    }

    let workspace;
    try {
      workspace = requireWorkspace(await acquireWorkspace(Object.freeze({
        materialBinding: bindings.materialBinding,
        signal: request.signal,
        task: request.task,
        triggerEvent: request.context.triggerEvent,
      })), "trigger material workspace");
    } catch (error) {
      return failedSettlement(safeMaterialAcquisitionCode(error));
    }
    try {
      if (canceled(request)) return canceledSettlement();

      let skillResult;
      try {
        skillResult = normalizeSkillResult(await runSkill(Object.freeze({
          employee: request.context.employee,
          materialBinding: bindings.materialBinding,
          signal: request.signal,
          task: request.task,
          triggerEvent: request.context.triggerEvent,
          workspace,
        })));
      } catch {
        return failedSettlement("trigger_material_review_skill_contract_invalid");
      }
      if (canceled(request)) return canceledSettlement();
      if (skillResult.status !== "completed") {
        return skillResult.status === "blocked"
          ? blockedSettlement(skillResult.safeResultCode)
          : failedSettlement(skillResult.safeResultCode);
      }

      let reviewComment;
      try {
        reviewComment = normalizeReviewComment(await composeReviewComment(Object.freeze({
          employee: request.context.employee,
          result: skillResult.result,
          signal: request.signal,
          task: request.task,
          triggerEvent: request.context.triggerEvent,
          workspace,
          writebackBinding: bindings.writebackBinding,
        })), bindings.writebackBinding.maxCommentChars);
      } catch {
        return failedSettlement("trigger_review_comment_invalid");
      }
      if (canceled(request)) return canceledSettlement();

      let resultEvidence;
      try {
        const stored = await resultRepository.saveOrGet(Object.freeze({
          contractVersion: REVIEW_RESULT_CONTRACT_VERSION,
          tenantScope: request.task.tenantScope,
          triggerEventId: requiredToken(request.context.triggerEvent.triggerEventId, 240),
          taskId: request.task.taskId,
          result: skillResult.result,
          reviewComment,
        }));
        resultEvidence = normalizeResultEvidence(stored?.evidence, request);
      } catch {
        return failedSettlement("trigger_review_result_persistence_failed");
      }
      if (canceled(request)) return canceledSettlement();

      return writePersistedResult({
        bindings,
        request,
        resultEvidence,
        reviewComment,
        writebackEffect,
      });
    } finally {
      await cleanupWorkspace(workspace);
    }
  }

  return Object.freeze({
    contractVersion: HANDLER_CONTRACT_VERSION,
    taskDefinitionId: requiredToken(taskDefinitionId, 160),
    handlerVersion: requiredToken(handlerVersion, 80),
    enabled,
    reviewStatus,
    execute,
  });
}

async function writePersistedResult({ bindings, request, resultEvidence, reviewComment,
  writebackEffect }) {
  let writeback;
  try {
    writeback = normalizeWritebackResult(await writebackEffect(Object.freeze({
      evidence: resultEvidence,
      operationReceiptContext: request.operationReceiptContext,
      reviewComment,
      signal: request.signal,
      task: request.task,
      triggerEvent: request.context.triggerEvent,
      writebackBinding: bindings.writebackBinding,
    })));
  } catch {
    return blockedSettlement("trigger_review_writeback_outcome_unknown");
  }
  if (writeback.status === "unknown") {
    return blockedSettlement("trigger_review_writeback_outcome_unknown");
  }
  if (writeback.status === "definitive_failed") {
    return failedSettlement(writeback.safeResultCode);
  }
  return completedSettlement(resultEvidence.evidenceDigest);
}

function normalizeStoredResult(value, request, maxCommentChars) {
  requirePlainObject(value, "stored trigger review result");
  const evidence = normalizeResultEvidence({
    contractVersion: value.contractVersion === REVIEW_RESULT_CONTRACT_VERSION
      ? REVIEW_RESULT_EVIDENCE_CONTRACT_VERSION
      : value.contractVersion,
    tenantScope: value.tenantScope,
    triggerEventId: value.triggerEventId,
    taskId: value.taskId,
    reviewResultId: value.reviewResultId,
    evidenceDigest: value.evidenceDigest,
    sealedAt: value.sealedAt,
  }, request);
  return Object.freeze({
    evidence,
    reviewComment: normalizeReviewComment(value.reviewComment, maxCommentChars),
  });
}

function normalizeExecution(value) {
  requireExactObject(value, EXECUTION_FIELDS, "trigger material review execution");
  if (value.contractVersion !== EXECUTION_CONTRACT_VERSION ||
    typeof value.isCancellationRequested !== "function" || !isAbortSignal(value.signal)) {
    throw new TypeError("trigger material review execution contract invalid");
  }
  requirePlainObject(value.context, "trigger material review context");
  requirePlainObject(value.context.binding, "trigger binding");
  requirePlainObject(value.context.employee, "trigger employee");
  requirePlainObject(value.context.triggerEvent, "trigger event");
  requirePlainObject(value.task, "trigger task");
  const tenantScope = requiredToken(value.task.tenantScope, 160);
  const taskId = requiredToken(value.task.taskId, 128);
  requireExactObject(value.operationReceiptContext, OPERATION_RECEIPT_CONTEXT_FIELDS,
    "operation receipt context");
  const repositoryContext = value.operationReceiptContext.repositoryContext;
  requireExactObject(repositoryContext, OPERATION_RECEIPT_REPOSITORY_CONTEXT_FIELDS,
    "operation receipt repository context");
  if (repositoryContext.tenantScope !== tenantScope || repositoryContext.taskId !== taskId ||
    !DIGEST.test(String(repositoryContext.workerIdDigest || "")) ||
    !Number.isSafeInteger(repositoryContext.fencingToken) || repositoryContext.fencingToken <= 0) {
    throw new TypeError("operation receipt repository context identity invalid");
  }
  requiredToken(repositoryContext.leaseId, 128);
  return value;
}

function normalizeBindingResolution(value) {
  requireExactObject(value, RESOLUTION_FIELDS, "trigger material binding resolution");
  requirePlainObject(value.materialBinding, "trigger material binding");
  requirePlainObject(value.writebackBinding, "trigger writeback binding");
  if (!Number.isInteger(value.writebackBinding.maxCommentChars) ||
    value.writebackBinding.maxCommentChars < 1 || value.writebackBinding.maxCommentChars > 20_000) {
    throw new TypeError("trigger writeback comment limit invalid");
  }
  return Object.freeze({
    materialBinding: value.materialBinding,
    writebackBinding: value.writebackBinding,
  });
}

function normalizeSkillResult(value) {
  requireExactObject(value, SKILL_RESULT_FIELDS, "trigger material review Skill result");
  if (value.contractVersion !== SKILL_RESULT_CONTRACT_VERSION || !SKILL_STATUSES.has(value.status)) {
    throw new TypeError("trigger material review Skill result contract invalid");
  }
  const safeResultCode = requiredSafeCode(value.safeResultCode);
  if (value.status === "completed") {
    requirePlainObject(value.result, "trigger material review Skill safe result");
    requiredToken(value.result.contractVersion, 160);
  } else if (value.result !== null) {
    throw new TypeError("non-completed Trigger Skill result must not contain result data");
  }
  return Object.freeze({
    contractVersion: SKILL_RESULT_CONTRACT_VERSION,
    status: value.status,
    safeResultCode,
    result: value.result,
  });
}

function normalizeReviewComment(value, maximum) {
  if (typeof value !== "string" || value !== value.trim() || !value || value.length > maximum ||
    /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/.test(value)) {
    throw new TypeError("trigger review comment invalid");
  }
  return value;
}

function normalizeResultEvidence(value, request) {
  requireExactObject(value, RESULT_EVIDENCE_FIELDS, "trigger review result evidence");
  if (value.contractVersion !== REVIEW_RESULT_EVIDENCE_CONTRACT_VERSION ||
    value.tenantScope !== request.task.tenantScope || value.taskId !== request.task.taskId ||
    value.triggerEventId !== request.context.triggerEvent.triggerEventId) {
    throw new TypeError("trigger review result evidence identity invalid");
  }
  requiredToken(value.reviewResultId, 240);
  if (!DIGEST.test(String(value.evidenceDigest || ""))) {
    throw new TypeError("trigger review result evidence digest invalid");
  }
  if (typeof value.sealedAt !== "string" || !Number.isFinite(Date.parse(value.sealedAt)) ||
    new Date(value.sealedAt).toISOString() !== value.sealedAt) {
    throw new TypeError("trigger review result evidence timestamp invalid");
  }
  return Object.freeze({
    contractVersion: REVIEW_RESULT_EVIDENCE_CONTRACT_VERSION,
    tenantScope: value.tenantScope,
    triggerEventId: value.triggerEventId,
    taskId: value.taskId,
    reviewResultId: value.reviewResultId,
    evidenceDigest: value.evidenceDigest,
    sealedAt: value.sealedAt,
  });
}

function normalizeWritebackResult(value) {
  requirePlainObject(value, "trigger review writeback result");
  if (!["succeeded", "definitive_failed", "unknown"].includes(value.status)) {
    throw new TypeError("trigger review writeback result invalid");
  }
  const safeResultCode = requiredSafeCode(value.receipt?.safeResultCode);
  if (value.status !== value.receipt?.status) {
    throw new TypeError("trigger review writeback receipt state invalid");
  }
  return Object.freeze({ status: value.status, safeResultCode });
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
  return settlement("failed", code, "trigger_material_review_failed", null);
}

function safeMaterialAcquisitionCode(error) {
  const code = String(error?.code || "");
  return /^(?:crm_material|trigger_attachment|trigger_material)_[a-z0-9_]{1,100}$/.test(code)
    ? code
    : "trigger_material_acquisition_failed";
}

function completedSettlement(evidenceDigest) {
  return settlement("completed", null, "trigger_material_review_completed", evidenceDigest);
}

function settlement(status, lastErrorCode, resultSummary, terminalEvidenceDigest) {
  return Object.freeze({ status, lastErrorCode, resultSummary, terminalEvidenceDigest });
}

function requiredSafeCode(value) {
  const code = String(value || "");
  if (!SAFE_CODE.test(code)) throw new TypeError("safe result code invalid");
  return code;
}

function requiredToken(value, maximum) {
  if (typeof value !== "string" || value !== value.trim() || !value || value.length > maximum ||
    !/^[A-Za-z0-9][A-Za-z0-9._:@/-]*$/.test(value)) {
    throw new TypeError("bounded opaque reference invalid");
  }
  return value;
}

function requireFunction(value, name) {
  if (typeof value !== "function") throw new TypeError(`material review handler requires ${name}`);
}

function requireWorkspace(value) {
  requirePlainObject(value, "trigger material workspace");
  if (typeof value.cleanup !== "function") {
    throw new TypeError("trigger material workspace cleanup unavailable");
  }
  return value;
}

async function cleanupWorkspace(workspace) {
  try {
    await workspace.cleanup();
  } catch {
    // Temporary material cleanup is best-effort after the task outcome has been safely determined.
  }
}

function requirePlainObject(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(value))) {
    throw new TypeError(`${label} must be a plain object`);
  }
}

function requireExactObject(value, fields, label) {
  requirePlainObject(value, label);
  if (Object.keys(value).length !== fields.size || Object.keys(value).some((field) => !fields.has(field)) ||
    [...fields].some((field) => !Object.hasOwn(value, field))) {
    throw new TypeError(`${label} fields invalid`);
  }
}

function isAbortSignal(value) {
  return Boolean(value) && typeof value === "object" && typeof value.aborted === "boolean" &&
    typeof value.addEventListener === "function";
}

export {
  SKILL_RESULT_CONTRACT_VERSION as TRIGGER_MATERIAL_REVIEW_SKILL_RESULT_CONTRACT_VERSION,
  createMaterialReviewWritebackTriggerHandler,
};
