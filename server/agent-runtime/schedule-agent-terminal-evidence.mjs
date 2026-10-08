import { assertScheduleTaskTriggerMatch } from "./schedule-task-input-resolver.mjs";
import crypto from "node:crypto";

const TERMINAL_STATUSES = new Set(["blocked", "canceled", "completed", "failed", "lost", "rejected", "timed_out"]);

// Reads the canonical task and its existing operation receipts. Schedule owns no
// duplicate result/receipt store for an Agent run.
export function createScheduleAgentTerminalEvidenceResolver({ executionTaskRepository, scheduleTriggerRepository } = {}) {
  if (typeof executionTaskRepository?.get !== "function" ||
    typeof executionTaskRepository?.summarizeOperationReceipts !== "function" || typeof scheduleTriggerRepository?.get !== "function") {
    throw new TypeError("Schedule Agent terminal evidence requires the canonical task repository");
  }
  return ({ tenantScope, taskId, employeeId, activationSnapshotDigest, runConfigurationDigest }) => {
    const task = executionTaskRepository.get(taskId, { tenantScope });
    if (!task || task.tenantScope !== tenantScope || task.taskId !== taskId || task.employeeId !== employeeId ||
      task.sourceSystemId !== "digital-workforce-scheduler" || task.channelId !== "schedule" || task.taskType !== "scheduled_employee_task") {
      throw evidenceError();
    }
    const trigger = scheduleTriggerRepository.get(task.executionInputRef?.refId, { tenantScope });
    try { assertScheduleTaskTriggerMatch(task, trigger); } catch { throw evidenceError(); }
    if (trigger.runConfigurationDigest !== runConfigurationDigest) throw evidenceError();
    const receiptSummary = executionTaskRepository.summarizeOperationReceipts({ tenantScope, taskId });
    return projectScheduleAgentTerminalEvidence({ task, receiptSummary, activationSnapshotDigest, runConfigurationDigest });
  };
}

export function projectScheduleAgentTerminalEvidence({ task, receiptSummary, activationSnapshotDigest, runConfigurationDigest } = {}) {
  const digestPattern = /^[a-f0-9]{64}$/;
  const counts = ["total", "prepared", "succeeded", "definitiveFailed", "unknown"];
  if (!task || !TERMINAL_STATUSES.has(task.status) || !Number.isSafeInteger(task.revision) || task.revision < 1 ||
    ![task.taskId, task.tenantScope, task.employeeId].every((value) => typeof value === "string" && value.length > 0 && value.length <= 160) ||
    !digestPattern.test(activationSnapshotDigest || "") || (runConfigurationDigest !== undefined && !digestPattern.test(runConfigurationDigest)) || !receiptSummary ||
    !digestPattern.test(receiptSummary.evidenceDigest || "") ||
    !counts.every((key) => Number.isSafeInteger(receiptSummary[key]) && receiptSummary[key] >= 0) ||
    receiptSummary.total !== receiptSummary.prepared + receiptSummary.succeeded + receiptSummary.definitiveFailed + receiptSummary.unknown) {
    throw evidenceError();
  }
  const effectState = receiptSummary.prepared > 0 || receiptSummary.unknown > 0 ? "reconcile_required" : "settled";
  if (receiptSummary.effectState !== effectState) throw evidenceError();
  const body = {
    contractVersion: runConfigurationDigest ? "schedule-agent-terminal-evidence.v2" : "schedule-agent-terminal-evidence.v1",
    ...(runConfigurationDigest ? { runConfigurationDigest } : {}),
    tenantScope: task.tenantScope, taskId: task.taskId, employeeId: task.employeeId,
    activationSnapshotDigest, taskRevision: task.revision, taskStatus: task.status,
    effectState, operationCount: receiptSummary.total, operationReceiptEvidenceDigest: receiptSummary.evidenceDigest,
  };
  return Object.freeze({ ...body, terminalEvidenceDigest: crypto.createHash("sha256").update(JSON.stringify(body)).digest("hex") });
}

function evidenceError() {
  const error = new Error("schedule_agent_terminal_evidence_unavailable");
  error.code = error.message;
  return error;
}
