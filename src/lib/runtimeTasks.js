export const RUNTIME_EVIDENCE_NOT_PROJECTED = Object.freeze({
  status: "模型调用证据未投影至任务台账",
  request: "任务台账未提供模型请求证据；无法据此判断是否调用",
  model: "任务台账未提供模型与等级",
  adapter: "任务台账未提供 Runtime Adapter",
  tool: "任务台账未提供模型 Tool 调用证据；无法据此判断是否调用",
  usage: "任务台账未提供 token 用量；不代表用量为 0",
  blocked: "模型调用证据未投影；请以执行摘要和任务状态判断失败阶段",
});

export function runtimeModelEvidenceCopy({
  executionStatus = "",
  hasEvidence = false,
  hasModelEvidence = false,
  processingRecorded = false,
  realModelRequested,
  requestCount = null,
  status = "",
} = {}) {
  const requested = realModelRequested === true;
  const explicitlyNotRequested = realModelRequested === false &&
    ["mock_no_model_request", "blocked_before_model_request"].includes(status);
  let statusLabel = RUNTIME_EVIDENCE_NOT_PROJECTED.status;
  if (!hasEvidence) statusLabel = "未记录执行证据";
  else if (requested) statusLabel = "真实模型请求已记录";
  else if (explicitlyNotRequested && status === "mock_no_model_request") statusLabel = "Mock：明确未发起真实模型请求";
  else if (explicitlyNotRequested) statusLabel = "模型前阻断：明确未发起模型请求";
  else if (processingRecorded) statusLabel = "已记录工具/Skill 分析；模型调用证据未投影";
  else if (executionStatus === "completed") statusLabel = "已记录执行摘要；模型调用证据未投影";

  const requestLabel = !hasModelEvidence
    ? RUNTIME_EVIDENCE_NOT_PROJECTED.request
    : requested
      ? `已请求模型${Number.isFinite(requestCount) ? ` ${requestCount} 次` : ""}`
      : explicitlyNotRequested
        ? statusLabel
        : "模型请求证据不完整；无法确认是否调用";
  return { requestLabel, statusLabel };
}

export function sortRuntimeTasksLatestFirst(tasks = []) {
  return (Array.isArray(tasks) ? tasks : [])
    .slice()
    .sort((left, right) => {
      const timestampOrder = runtimeTaskTimestamp(right).localeCompare(runtimeTaskTimestamp(left));
      if (timestampOrder) return timestampOrder;
      return String(right.id || "").localeCompare(String(left.id || ""));
    });
}
function runtimeTaskTimestamp(task = {}) {
  return String(task.updatedAt || task.submittedAt || task.trigger?.receivedAt || "");
}
