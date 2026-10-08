import crypto from "node:crypto";
import { EXECUTION_TASK_TERMINAL_STATUSES } from "./runtime-task-contract-v1.mjs";
import { scheduleTriggerSlotDigest } from "./schedule-trigger-service.mjs";

const TERMINAL_TASK_STATUSES = new Set(EXECUTION_TASK_TERMINAL_STATUSES);
const DISPATCHER_CONTRACT_VERSION = "schedule-cancellation-dispatcher.v1";

function createScheduleCancellationDispatcher({
  controlRepository,
  executionTaskRepository,
  tenantScope,
  workerPump = null,
  now = () => new Date(),
} = {}) {
  assertDependencies({ controlRepository, executionTaskRepository });
  const safeTenantScope = token(tenantScope, "tenantScope");

  function runOnce({ limit = 100 } = {}) {
    const safeLimit = boundedInteger(limit, 1, 500, "limit");
    const summary = {
      dispatchExamined: 0,
      dispatched: 0,
      reconciled: 0,
      reconcileRequired: 0,
      deferred: 0,
      conflicts: 0,
    };
    const pending = controlRepository.listCancelOutbox({
      tenantScope: safeTenantScope,
      state: "pending",
      reconcileState: "pending",
      limit: safeLimit,
    });
    for (const outbox of pending) {
      summary.dispatchExamined += 1;
      try {
        const intent = requireBoundIntent(outbox);
        const canceled = executionTaskRepository.cancelScheduledTaskOrFence({
          expectedIdentity: expectedTaskIdentity(intent),
          stopGeneration: outbox.emergencyStopVersion,
          now: now(),
        });
        if (canceled.task?.status === "canceled") workerPump?.abortTask?.(canceled.task.taskId);
        const evidence = cancellationEvidence({ canceled, intent, outbox });
        controlRepository.recordCancelDispatch({
          tenantScope: safeTenantScope,
          cancelId: outbox.cancelId,
          runId: outbox.runId,
          emergencyStopVersion: outbox.emergencyStopVersion,
          expectedOutboxVersion: outbox.outboxVersion,
          canonicalTaskRevision: evidence.taskRevision,
          canonicalTaskStatus: evidence.taskStatus,
          effectState: evidence.effectState,
          effectEvidenceDigest: evidence.effectEvidenceDigest,
          dispatchedAt: now(),
        });
        summary.dispatched += 1;
      } catch (error) {
        classifyFailure(summary, error);
      }
    }

    const dispatched = controlRepository.listCancelOutbox({
      tenantScope: safeTenantScope,
      state: "dispatched",
      reconcileState: "pending",
      limit: safeLimit,
    });
    for (const outbox of dispatched) {
      try {
        const intent = requireBoundIntent(outbox);
        const execution = controlRepository.getRunExecution(outbox.runId, {
          tenantScope: safeTenantScope,
        });
        const result = controlRepository.observeCancellationOutcome({
          tenantScope: safeTenantScope,
          cancelId: outbox.cancelId,
          runId: outbox.runId,
          emergencyStopVersion: outbox.emergencyStopVersion,
          expectedOutboxVersion: outbox.outboxVersion,
          expectedIntentVersion: intent.intentVersion,
          expectedExecutionVersion: execution?.executionVersion || null,
          canonicalTaskRevision: outbox.canonicalTaskRevision,
          canonicalTaskStatus: outbox.canonicalTaskStatus,
          effectState: outbox.effectState,
          effectEvidenceDigest: outbox.effectEvidenceDigest,
          reconciledAt: now(),
        });
        if (result.outbox.reconcileState === "settled") summary.reconciled += 1;
        else summary.reconcileRequired += 1;
      } catch (error) {
        classifyFailure(summary, error);
      }
    }
    return deepFreeze({ contractVersion: DISPATCHER_CONTRACT_VERSION, ...summary });
  }

  function requireBoundIntent(outbox) {
    if (outbox.tenantScope !== safeTenantScope) throw dispatcherError("schedule_cancel_tenant_mismatch");
    const intent = controlRepository.getIntent(outbox.runId, { tenantScope: safeTenantScope });
    if (!intent || intent.employeeId !== outbox.employeeId || intent.scheduleId !== outbox.scheduleId ||
      intent.activationVersion !== outbox.activationVersion ||
      intent.expectedTriggerId !== outbox.expectedTriggerId ||
      (intent.executionTaskId || intent.expectedExecutionTaskId) !== outbox.executionTaskId) {
      throw dispatcherError("schedule_cancel_intent_binding_mismatch");
    }
    const slotDigest = scheduleTriggerSlotDigest({
      tenantScope: intent.tenantScope,
      employeeId: intent.employeeId,
      scheduleId: intent.scheduleId,
      scheduledFor: intent.scheduledFor,
    });
    if (intent.runId !== `schedule_run_${slotDigest}` ||
      intent.expectedTriggerId !== `schedule_trigger_${slotDigest}` ||
      intent.expectedExecutionTaskId !== `task_${slotDigest}`) {
      throw dispatcherError("schedule_cancel_slot_identity_mismatch");
    }
    return intent;
  }

  function expectedTaskIdentity(intent) {
    const slotDigest = intent.runId.slice("schedule_run_".length);
    return Object.freeze({
      tenantScope: intent.tenantScope,
      taskId: intent.expectedExecutionTaskId,
      employeeId: intent.employeeId,
      sourceSystemId: "digital-workforce-scheduler",
      channelId: "schedule",
      taskType: "scheduled_employee_task",
      submissionScope: `schedule:${digestCanonical([intent.tenantScope, intent.employeeId, intent.scheduleId])}`,
      idempotencyKey: `scheduled-for:${slotDigest}`,
      executionInputRef: Object.freeze({ kind: "artifact_ref", refId: intent.expectedTriggerId }),
    });
  }

  function cancellationEvidence({ canceled, intent, outbox }) {
    if (!canceled.task) {
      if (canceled.outcome !== "fenced") throw dispatcherError("schedule_cancel_task_unavailable");
      return Object.freeze({
        taskRevision: 0,
        taskStatus: "pre_canceled",
        effectState: "safe_terminal",
        effectEvidenceDigest: digestCanonical([
          "schedule-pre-cancel-evidence.v1",
          intent.tenantScope,
          intent.expectedExecutionTaskId,
          outbox.emergencyStopVersion,
        ]),
      });
    }
    if (!TERMINAL_TASK_STATUSES.has(canceled.task.status)) {
      throw dispatcherError("schedule_cancel_task_not_terminal");
    }
    const receipts = executionTaskRepository.summarizeOperationReceipts({
      tenantScope: safeTenantScope,
      taskId: canceled.task.taskId,
    });
    if (!receipts) throw dispatcherError("schedule_cancel_effect_evidence_unavailable");
    return Object.freeze({
      taskRevision: canceled.task.revision,
      taskStatus: canceled.task.status,
      effectState: receipts.effectState === "settled" ? "safe_terminal" : "reconcile_required",
      effectEvidenceDigest: receipts.evidenceDigest,
    });
  }

  return Object.freeze({ contractVersion: DISPATCHER_CONTRACT_VERSION, runOnce });
}

function classifyFailure(summary, error) {
  const code = String(error?.code || "");
  if (code.endsWith("_conflict") || code.includes("version_conflict")) summary.conflicts += 1;
  else summary.deferred += 1;
}

function assertDependencies({ controlRepository, executionTaskRepository }) {
  for (const method of [
    "getIntent",
    "getRunExecution",
    "listCancelOutbox",
    "observeCancellationOutcome",
    "recordCancelDispatch",
  ]) {
    if (typeof controlRepository?.[method] !== "function") {
      throw new TypeError(`Schedule cancellation dispatcher requires controlRepository.${method}`);
    }
  }
  for (const method of ["cancelScheduledTaskOrFence", "summarizeOperationReceipts"]) {
    if (typeof executionTaskRepository?.[method] !== "function") {
      throw new TypeError(`Schedule cancellation dispatcher requires executionTaskRepository.${method}`);
    }
  }
}

function boundedInteger(value, min, max, field) {
  if (!Number.isInteger(value) || value < min || value > max) throw dispatcherError(`schedule_cancel_${field}_invalid`);
  return value;
}

function token(value, field) {
  const text = String(value || "").trim();
  if (!text || text.length > 240 || !/^[A-Za-z0-9][A-Za-z0-9._:@-]*$/.test(text)) {
    throw dispatcherError(`schedule_cancel_${field}_invalid`);
  }
  return text;
}

function digestCanonical(value) {
  return crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function dispatcherError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const item of Object.values(value)) deepFreeze(item);
  return value;
}

export { createScheduleCancellationDispatcher };
