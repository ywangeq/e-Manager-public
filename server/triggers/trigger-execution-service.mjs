import { normalizeExecutionTaskSettlement } from "../agent-runtime/runtime-task-contract-v1.mjs";
import { normalizeTriggerTaskDefinition } from "./trigger-task-definition-registry.mjs";

const TRIGGER_EXECUTION_SERVICE_CONTRACT_VERSION = "trigger-execution-service.v1";
const TRIGGER_HANDLER_EXECUTION_CONTRACT_VERSION = "trigger-handler-execution.v1";
const EXECUTION_FIELDS = new Set(["context", "ownership", "task"]);
const CONTEXT_FIELDS = new Set(["binding", "employee", "taskDefinition", "triggerEvent"]);
const WAITING_SETTLEMENT_FIELDS = new Set([
  "lastErrorCode",
  "resultSummary",
  "status",
  "terminalEvidenceDigest",
  "waitReasonCode",
]);
const SAFE_CODE_PATTERN = /^[a-z][a-z0-9_]{1,119}$/;
const DIGEST_PATTERN = /^[a-f0-9]{64}$/;

function createTriggerExecutionService({ executorRegistry } = {}) {
  if (typeof executorRegistry?.resolve !== "function") {
    throw new TypeError("trigger execution service requires executorRegistry.resolve");
  }

  async function execute(value = {}) {
    let invocation;
    try {
      invocation = normalizeInvocation(value);
    } catch {
      return serviceResult(blockedSettlement(
        "trigger_execution_context_invalid",
        "trigger_execution_context_invalid",
      ));
    }
    const { context, ownership, task } = invocation;
    if (cancellationRequested(ownership)) {
      return serviceResult(canceledSettlement());
    }
    let operationReceiptContext;
    try {
      operationReceiptContext = projectOperationReceiptContext({ ownership, task });
    } catch {
      return serviceResult(blockedSettlement(
        "trigger_execution_context_invalid",
        "trigger_execution_context_invalid",
      ));
    }

    let handler;
    try {
      handler = executorRegistry.resolve({
        taskDefinitionId: context.taskDefinition.taskDefinitionId,
        handlerVersion: context.taskDefinition.handlerVersion,
      });
    } catch {
      return serviceResult(blockedSettlement(
        "trigger_execution_registry_unavailable",
        "trigger_execution_registry_unavailable",
      ));
    }
    if (!handler) {
      return serviceResult(blockedSettlement(
        "trigger_execution_handler_unavailable",
        "trigger_execution_handler_unavailable",
      ));
    }

    let result;
    try {
      result = await handler.execute(Object.freeze({
        contractVersion: TRIGGER_HANDLER_EXECUTION_CONTRACT_VERSION,
        context,
        isCancellationRequested: () => cancellationRequested(ownership),
        operationReceiptContext,
        signal: ownership.signal,
        task,
      }));
    } catch (error) {
      if (cancellationRequested(ownership)) return serviceResult(canceledSettlement());
      return serviceResult(failedSettlement(safeHandlerErrorCode(error)));
    }
    if (cancellationRequested(ownership)) return serviceResult(canceledSettlement());

    try {
      return serviceResult(normalizeTriggerHandlerSettlement(result));
    } catch {
      return serviceResult(failedSettlement("trigger_handler_settlement_invalid"));
    }
  }

  return Object.freeze({
    contractVersion: TRIGGER_EXECUTION_SERVICE_CONTRACT_VERSION,
    execute,
  });
}

function projectOperationReceiptContext({ ownership, task }) {
  const lease = ownership?.lease;
  if (!lease || typeof lease !== "object" || Array.isArray(lease)) {
    throw new TypeError("trigger execution lease unavailable");
  }
  const workerIdDigest = String(lease.workerIdDigest || "").trim().toLowerCase();
  if (!DIGEST_PATTERN.test(workerIdDigest)) {
    throw new TypeError("trigger execution worker digest invalid");
  }
  if (!Number.isSafeInteger(lease.fencingToken) || lease.fencingToken <= 0) {
    throw new TypeError("trigger execution fencing token invalid");
  }
  return Object.freeze({
    repositoryContext: Object.freeze({
      tenantScope: requiredToken(task.tenantScope, 160),
      taskId: requiredToken(task.taskId, 128),
      leaseId: requiredToken(lease.leaseId, 128),
      workerIdDigest,
      fencingToken: lease.fencingToken,
    }),
  });
}

function normalizeInvocation(value) {
  requirePlainObject(value);
  requireExactFields(value, EXECUTION_FIELDS);
  requirePlainObject(value.context);
  requireExactFields(value.context, CONTEXT_FIELDS);
  requirePlainObject(value.context.binding);
  requiredToken(value.context.binding.taskDefinitionId, 160);
  requirePlainObject(value.context.employee);
  const taskDefinition = normalizeTriggerTaskDefinition(value.context.taskDefinition);
  if (taskDefinition.taskDefinitionId !== value.context.binding.taskDefinitionId) {
    throw new TypeError("trigger execution task definition binding mismatch");
  }
  requirePlainObject(value.context.triggerEvent);
  requirePlainObject(value.task);
  if (value.task.channelId !== "trigger" || value.task.taskType !== "triggered_employee_task") {
    throw new TypeError("trigger execution task contract invalid");
  }
  requiredToken(value.task.taskId, 128);
  if (!value.ownership || typeof value.ownership !== "object") {
    throw new TypeError("trigger execution ownership invalid");
  }
  if (typeof value.ownership.isCancellationRequested !== "function") {
    throw new TypeError("trigger execution cancellation authority unavailable");
  }
  if (!isAbortSignal(value.ownership.signal)) {
    throw new TypeError("trigger execution signal unavailable");
  }
  return value;
}

function normalizeTriggerHandlerSettlement(value) {
  if (value?.status === "waiting") return normalizeWaitingSettlement(value);
  const settlement = normalizeExecutionTaskSettlement(value);
  if (settlement.lastErrorCode !== null && !SAFE_CODE_PATTERN.test(settlement.lastErrorCode)) {
    throw new TypeError("trigger handler lastErrorCode must be an audit-safe code");
  }
  if (settlement.resultSummary !== null && !SAFE_CODE_PATTERN.test(settlement.resultSummary)) {
    throw new TypeError("trigger handler resultSummary must be an audit-safe code");
  }
  if (settlement.status === "completed" && settlement.lastErrorCode !== null) {
    throw new TypeError("completed trigger settlement cannot contain lastErrorCode");
  }
  if (settlement.status === "completed" &&
    !DIGEST_PATTERN.test(String(settlement.terminalEvidenceDigest || ""))) {
    throw new TypeError("completed trigger settlement requires durable result evidence");
  }
  if (settlement.status !== "completed" && settlement.lastErrorCode === null) {
    throw new TypeError("non-completed trigger settlement requires lastErrorCode");
  }
  return settlement;
}

function normalizeWaitingSettlement(value) {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
    Object.keys(value).some((field) => !WAITING_SETTLEMENT_FIELDS.has(field))) {
    throw new TypeError("trigger handler waiting settlement is invalid");
  }
  const waitReasonCode = safeCode(value.waitReasonCode, "waitReasonCode");
  const lastErrorCode = safeCode(value.lastErrorCode, "lastErrorCode");
  const resultSummary = safeCode(value.resultSummary, "resultSummary");
  if (value.terminalEvidenceDigest !== undefined && value.terminalEvidenceDigest !== null &&
    value.terminalEvidenceDigest !== "") {
    throw new TypeError("waiting trigger settlement cannot contain terminal evidence");
  }
  return Object.freeze({
    status: "waiting",
    waitReasonCode,
    lastErrorCode,
    resultSummary,
    terminalEvidenceDigest: null,
  });
}

function safeCode(value, field) {
  const code = String(value || "").trim();
  if (!SAFE_CODE_PATTERN.test(code)) throw new TypeError(`trigger handler ${field} must be an audit-safe code`);
  return code;
}

function cancellationRequested(ownership) {
  if (ownership.signal.aborted) return true;
  try {
    return ownership.isCancellationRequested() !== false;
  } catch {
    return true;
  }
}

function isAbortSignal(value) {
  return Boolean(value) && typeof value === "object" && typeof value.aborted === "boolean" &&
    typeof value.addEventListener === "function";
}

function serviceResult(settlement) {
  return Object.freeze({ settlement });
}

function canceledSettlement() {
  return blockedSettlement("agent_turn_canceled", "trigger_execution_canceled");
}

function blockedSettlement(lastErrorCode, resultSummary) {
  return normalizeTriggerHandlerSettlement({
    status: "blocked",
    lastErrorCode,
    resultSummary,
    terminalEvidenceDigest: null,
  });
}

function failedSettlement(lastErrorCode) {
  return normalizeTriggerHandlerSettlement({
    status: "failed",
    lastErrorCode,
    resultSummary: "trigger_execution_failed",
    terminalEvidenceDigest: null,
  });
}

function safeHandlerErrorCode(error) {
  const code = String(error?.code || "");
  return SAFE_CODE_PATTERN.test(code) ? code : "trigger_handler_execution_failed";
}

function requirePlainObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(value))) {
    throw new TypeError("trigger execution value must be a plain object");
  }
}

function requireExactFields(value, fields) {
  if (Object.keys(value).length !== fields.size ||
    Object.keys(value).some((field) => !fields.has(field)) ||
    [...fields].some((field) => !Object.hasOwn(value, field))) {
    throw new TypeError("trigger execution fields are invalid");
  }
}

function requiredToken(value, maxLength) {
  if (typeof value !== "string" || value !== value.trim() || !value ||
    value.length > maxLength || !/^[A-Za-z0-9][A-Za-z0-9._:@-]*$/.test(value)) {
    throw new TypeError("trigger execution reference is invalid");
  }
  return value;
}

export {
  TRIGGER_EXECUTION_SERVICE_CONTRACT_VERSION,
  TRIGGER_HANDLER_EXECUTION_CONTRACT_VERSION,
  createTriggerExecutionService,
  normalizeTriggerHandlerSettlement,
};
