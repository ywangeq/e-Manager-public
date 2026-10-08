import crypto from "node:crypto";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { publishTaskOutputArtifacts } from "./task-artifact-publication.mjs";
import { DIGITAL_EMPLOYEE_AGENT_EXECUTION_SERVICE_VERSION } from "./digital-employee-agent-execution-service.mjs";

export const SCHEDULE_RUN_AGENT_ADAPTER_CONTRACT_VERSION = "schedule-run-agent-adapter.v1";

// Schedule supplies immutable input and lifecycle ownership. The platform's shared
// service remains the only Agent/Skill/Tool execution plane.
export function createScheduleRunAgentAdapter({ agentExecutionService, resolveContext, settleResult } = {}) {
  if (agentExecutionService?.contractVersion !== DIGITAL_EMPLOYEE_AGENT_EXECUTION_SERVICE_VERSION ||
    typeof agentExecutionService.buildPrompt !== "function" || typeof agentExecutionService.execute !== "function" ||
    typeof resolveContext !== "function" || typeof settleResult !== "function") {
    throw new TypeError("Schedule Agent adapter requires the shared execution service and governed context/result boundaries");
  }
  return Object.freeze({
    contractVersion: SCHEDULE_RUN_AGENT_ADAPTER_CONTRACT_VERSION,
    adapterKind: "shared_agent_runtime",
    async execute({ ownership, snapshot, trigger, runConfiguration }) {
      const context = await resolveContext({ task: ownership.task, snapshot, trigger, signal: ownership.signal, ownership, runConfiguration });
      if (!context || context.dependencyContext?.employee?.id !== ownership.task.employeeId ||
        context.dependencyContext?.employee?.version !== ownership.task.employeeVersion ||
        context.employeeIdentity?.id !== ownership.task.employeeId) {
        throw new Error("schedule_agent_context_identity_mismatch");
      }
      if (ownership.signal?.aborted || ownership.isCancellationRequested?.()) {
        return { settlement: { status: "blocked", lastErrorCode: "schedule_agent_canceled_before_execution", resultSummary: "定时任务在执行前已停止。" } };
      }
      const prompt = agentExecutionService.buildPrompt({ ...context, conversationHistory: [], stream: false });
      const result = await agentExecutionService.execute({
        lease: context.lease, prompt, toolExecutor: context.toolExecutor,
        runtimeTask: ownership.task, signal: ownership.signal,
        operationReceiptContext: context.operationReceiptContext || null,
        onToolActivity: context.onToolActivity || null,
      });
      return settleResult({ task: ownership.task, result, snapshot, signal: ownership.signal, ownership });
    },
  });
}

// The full response is a task-owned deliverable. Canonical task/control summaries
// contain fixed safe text only, never the model response or business payload.
export function createScheduleAgentResultSettler({ workspaceManager, taskArtifactService,
  now = () => new Date(), maxSummaryBytes = 64 * 1024 } = {}) {
  if (typeof workspaceManager?.workspaceForTask !== "function" ||
    typeof taskArtifactService?.publishOutputArtifact !== "function" || typeof now !== "function" ||
    !Number.isSafeInteger(maxSummaryBytes) || maxSummaryBytes < 1 || maxSummaryBytes > 1024 * 1024) {
    throw new TypeError("Schedule Agent result requires governed workspace/artifact services and bounded output");
  }
  return async function settle({ task, result, signal, ownership }) {
    if (signal?.aborted || ownership?.isCancellationRequested?.() || result?.reason === "agent_turn_canceled") {
      return { settlement: { status: "canceled", lastErrorCode: "schedule_agent_canceled", resultSummary: "定时任务已取消。" } };
    }
    if (result?.partial) {
      return { settlement: { status: "blocked", lastErrorCode: "schedule_agent_partial_result", resultSummary: "定时任务输出未完成，需核对执行记录。" } };
    }
    if (typeof result?.text !== "string" || !result.text.trim() || Buffer.byteLength(result.text, "utf8") > maxSummaryBytes) {
      return { settlement: { status: "failed", lastErrorCode: "schedule_agent_result_invalid", resultSummary: "定时任务未生成有效总结。" } };
    }
    const authority = ownership?.artifactPublicationAuthority;
    if (!task || task.taskId !== ownership?.task?.taskId || task.tenantScope !== ownership?.task?.tenantScope ||
      authority?.taskId !== task.taskId || authority?.tenantScope !== task.tenantScope ||
      typeof ownership?.refreshCurrentLease !== "function") {
      const error = new Error("artifact_publication_unavailable");
      error.code = "artifact_publication_unavailable";
      throw error;
    }
    ownership.refreshCurrentLease();
    const workspace = await workspaceManager.workspaceForTask(task.taskId, { create: true });
    await writeFile(path.join(workspace.outputRoot, "schedule-summary.md"), result.text,
      { encoding: "utf8", flag: "wx", mode: 0o600 });
    const publications = await publishTaskOutputArtifacts({
      artifacts: [{ relativePath: "schedule-summary.md" }], executionOwnership: ownership, taskArtifactService, now,
    });
    if (publications.length !== 1 || !publications[0]?.artifact) {
      const error = new Error("artifact_publication_unavailable");
      error.code = "artifact_publication_unavailable";
      throw error;
    }
    return { settlement: { status: "completed", resultSummary: "定时任务总结已生成，请查看任务产物。",
      terminalEvidenceDigest: crypto.createHash("sha256").update(JSON.stringify(publications[0].artifact)).digest("hex") } };
  };
}
