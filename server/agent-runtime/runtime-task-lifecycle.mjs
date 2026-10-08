function cleanText(value) {
  return String(value || "").replace(/\s+/g, " ").trim().slice(0, 800);
}

function cleanShortText(value) {
  return String(value || "").replace(/\s+/g, " ").trim().slice(0, 240);
}

const AUTO_START_STATUSES = new Set([
  "queued",
  "received",
  "pending_file_intake",
  "pending_remote_resource",
  "retrying",
]);
const TERMINAL_STATUSES = new Set(["completed", "failed", "blocked", "canceled", "queue_full", "timeout"]);

function claimRuntimeTaskForExecution({
  store,
  task = null,
  now = new Date().toISOString(),
  executionMode = "controlled_runtime",
} = {}) {
  if (!store || typeof store.saveRuntimeTask !== "function" || !canAutoStartTask(task)) return task;
  return store.saveRuntimeTask({
    ...task,
    status: "running",
    startedAt: task.startedAt || now,
    updatedAt: now,
    nextGate: "数字员工已领取任务，正在按已启用的受控运行器处理。",
    execution: {
      ...(task.execution || {}),
      mode: cleanShortText(executionMode),
      status: "running",
      startedAt: task.execution?.startedAt || task.startedAt || now,
      nextGate: "按任务类型进入资料接入、挂载 Skill 或 AI agent 分流。",
    },
  });
}

function settleRuntimeTaskFromMaterialIntake({
  store,
  task = null,
  resourceSetup = {},
  now = new Date().toISOString(),
} = {}) {
  if (!store || typeof store.saveRuntimeTask !== "function" || !task) return task;
  if (TERMINAL_STATUSES.has(cleanShortText(task.status))) return task;
  if (!hasMaterialTask(task)) return task;

  const outcome = materialTaskOutcome(task, resourceSetup);
  return store.saveRuntimeTask({
    ...task,
    status: outcome.status,
    updatedAt: now,
    completedAt: outcome.status === "completed" ? (task.completedAt || now) : task.completedAt,
    failedAt: outcome.status === "failed" ? (task.failedAt || now) : task.failedAt,
    nextGate: outcome.nextGate,
    execution: {
      ...(task.execution || {}),
      status: outcome.executionStatus,
      completedAt: outcome.status === "completed" ? (task.execution?.completedAt || now) : task.execution?.completedAt,
      failedAt: outcome.status === "failed" ? (task.execution?.failedAt || now) : task.execution?.failedAt,
      nextGate: outcome.nextGate,
      resultSummary: outcome.resultSummary,
    },
  });
}

function settleRuntimeTaskFromAgentTurn({
  store,
  task = null,
  agentTurn = null,
  now = new Date().toISOString(),
} = {}) {
  if (!store || typeof store.saveRuntimeTask !== "function" || !task) return task;
  const currentStatus = cleanShortText(task.status);
  if (TERMINAL_STATUSES.has(currentStatus) && currentStatus !== "completed") return task;

  const agentOk = Boolean(agentTurn?.ok);
  const agentReason = cleanShortText(agentTurn?.reason);
  const agentStatus = cleanShortText(agentTurn?.status);
  const agentDidFail = !agentOk && (
    agentStatus === "agent_runtime_failed" ||
    agentStatus === "agent_partial_ready" ||
    agentReason.startsWith("model_") ||
    agentReason.startsWith("agent_")
  );
  const modelInputReady = (task.materialProcessing || []).some((item) => cleanShortText(item.status) === "temporary_model_input_ready");
  if (hasMaterialTask(task) && !modelInputReady && (currentStatus !== "completed" || agentOk) && !agentDidFail) return task;
  const nextStatus = agentOk
    ? "completed"
    : agentReason === "agent_turn_canceled"
      ? "canceled"
      : agentTurn?.status === "agent_partial_ready"
        ? "blocked"
        : "failed";
  const nextGate = agentOk
    ? "AI agent 已完成本次任务分流；如需要文件、训练或远程执行，将在后续任务中继续走资料和运行器门禁。"
    : cleanText(agentTurn?.text || "AI agent runtime 未完成本次任务处理，请检查运行器配置。");
  const agentRuntime = agentTurn?.safeSummary?.agentRuntime;
  const hasAgentRuntimeEvidence = Boolean(
    agentRuntime && typeof agentRuntime === "object" && Object.keys(agentRuntime).length,
  );
  return store.saveRuntimeTask({
    ...task,
    status: nextStatus,
    completedAt: agentOk ? (task.completedAt || now) : "",
    failedAt: nextStatus === "failed" ? (task.failedAt || now) : task.failedAt,
    canceledAt: nextStatus === "canceled" ? (task.canceledAt || now) : task.canceledAt,
    updatedAt: now,
    nextGate,
    execution: {
      ...(task.execution || {}),
      status: nextStatus,
      completedAt: agentOk ? (task.execution?.completedAt || now) : "",
      failedAt: nextStatus === "failed" ? (task.execution?.failedAt || now) : task.execution?.failedAt,
      canceledAt: nextStatus === "canceled" ? (task.execution?.canceledAt || now) : task.execution?.canceledAt,
      nextGate,
      resultSummary: agentOk
        ? "AI agent 已完成安全上下文内的任务分流与回复。"
        : nextStatus === "canceled"
          ? "管理员已取消任务。"
          : nextStatus === "blocked"
            ? "AI agent 已保留阶段性证据，等待继续处理或人工复核。"
            : "AI agent runtime 未完成。",
      ...(hasAgentRuntimeEvidence ? { agentRuntime } : {}),
    },
  });
}

function autoStartRuntimeTask({
  store,
  task = null,
  now = new Date().toISOString(),
  executionMode = "controlled_runtime",
} = {}) {
  const claimed = claimRuntimeTaskForExecution({
    store,
    task,
    now,
    executionMode,
  });
  if (!claimed || hasMaterialTask(claimed)) return settleRuntimeTaskFromMaterialIntake({ store, task: claimed, now });
  const nextGate = executionMode === "management_console_controlled_runtime"
    ? "控制台任务已启动并完成安全分流；如需文件、训练或远程执行，请补充可访问资料后创建资料分析任务。"
    : "任务已启动并完成安全分流；如需文件、训练或远程执行，请补充可访问资料后创建资料分析任务。";
  return store.saveRuntimeTask({
    ...claimed,
    status: "completed",
    completedAt: claimed.completedAt || now,
    updatedAt: now,
    nextGate,
    execution: {
      ...(claimed.execution || {}),
      status: "completed",
      completedAt: claimed.execution?.completedAt || now,
      resultSummary: executionMode === "management_console_controlled_runtime"
        ? "控制台任务已完成安全接收和分流。"
        : "任务已完成安全接收和分流。",
      nextGate,
    },
  });
}

function autoStartManualRuntimeTask(args = {}) {
  return autoStartRuntimeTask({
    ...args,
    executionMode: "management_console_controlled_runtime",
  });
}

function canAutoStartTask(task = null) {
  const status = cleanShortText(task?.status);
  return Boolean(task?.id) && AUTO_START_STATUSES.has(status);
}

function hasMaterialTask(task = {}) {
  return task.taskType === "package_intake_analysis" || Boolean(task.materialRefs?.length);
}

function materialTaskOutcome(task = {}, resourceSetup = {}) {
  const materialStatuses = (task.materialRefs || []).map((item) => cleanShortText(item.intakeStatus));
  const processing = Array.isArray(task.materialProcessing) ? task.materialProcessing : [];
  const processingStatuses = processing.map((item) => cleanShortText(item.status));
  const completedSkill = processing.find((item) => item.skillId && isCompletedProcessingStatus(item.status));
  const failedProcessing = processing.find((item) => isFailedProcessingStatus(item.status));
  const modelInputReady = processingStatuses.includes("temporary_model_input_ready");

  if (completedSkill) {
    return {
      status: "completed",
      executionStatus: "completed",
      resultSummary: cleanText(completedSkill.summary || "挂载 Skill 已完成资料分析。"),
      nextGate: cleanText(completedSkill.nextGate || "输出已生成安全摘要，等待 owner 复核或下一步业务处理。"),
    };
  }
  if ([...materialStatuses, ...processingStatuses].includes("download_too_large")) {
    return {
      status: "pending_file_intake",
      executionStatus: "waiting_for_material",
      resultSummary: "渠道附件超过 100 MB 消息资源下载上限，未进入数字员工工作区。",
      nextGate: "请拆分为每个不超过 90 MB 的独立 ZIP，或提供已登记 Remote/集群资源与只读路径，或对象存储 Dataset/Branch/版本；资源绑定和读取授权仍需核验。",
    };
  }
  if (materialStatuses.some(isFileIntakeBlockedStatus)) {
    return {
      status: "pending_file_intake",
      executionStatus: "waiting_for_material",
      resultSummary: "任务已启动，但文件读取还未完成。",
      nextGate: "请补齐渠道文件读取权限、重新上传文件，或提供可访问的 evidenceRef / 对象存储路径。",
    };
  }
  if (failedProcessing) {
    return {
      status: "failed",
      executionStatus: "failed",
      resultSummary: cleanText(failedProcessing.summary || "文件资料接入处理失败。"),
      nextGate: cleanText(failedProcessing.nextGate || "检查文件完整性、大小限制和输入契约后重新提交。"),
    };
  }
  if (modelInputReady) {
    return {
      status: "running",
      executionStatus: "running",
      resultSummary: "附件已作为原生输入进入 Agent 模型回合。",
      nextGate: "等待模型基于本轮真实附件完成理解与回复。",
    };
  }
  if (processingStatuses.includes("temporary_material_ready")) {
    if (resourceSetup?.ready === false) {
      return {
        status: "pending_remote_resource",
        executionStatus: "waiting_for_resource",
        resultSummary: "文件资料已进入临时工作区，等待运行资源。",
        nextGate: cleanText(resourceSetup.nextGate || "请补齐运行资源后继续处理。"),
      };
    }
    return {
      status: "blocked",
      executionStatus: "blocked",
      resultSummary: "文件资料已准备，但没有可执行的挂载 Skill harness 产出结果。",
      nextGate: "请确认该数字员工已挂载可处理该资料契约的 Skill harness。",
    };
  }
  if (resourceSetup?.ready === false) {
    return {
      status: "pending_remote_resource",
      executionStatus: "waiting_for_resource",
      resultSummary: "任务已启动，等待运行资源就绪。",
      nextGate: cleanText(resourceSetup.nextGate || "请补齐运行资源后继续处理。"),
    };
  }
  return {
    status: "pending_file_intake",
    executionStatus: "waiting_for_material",
    resultSummary: "任务已启动，等待文件资料进入受控接入流程。",
    nextGate: "请上传可读取的文件资料，或提供可访问的 evidenceRef / 对象存储路径。",
  };
}

function isCompletedProcessingStatus(status = "") {
  const text = cleanShortText(status);
  return text === "skill_harness_completed" || /_completed$/.test(text);
}

function isFailedProcessingStatus(status = "") {
  return /failed|rejected|timed_out|limit_exceeded|unsupported|missing|unavailable/.test(cleanShortText(status));
}

function isFileIntakeBlockedStatus(status = "") {
  return /metadata_only|download_.*missing|download_.*unavailable|download_.*failed|download_request_failed/.test(cleanShortText(status));
}

export {
  autoStartManualRuntimeTask,
  autoStartRuntimeTask,
  claimRuntimeTaskForExecution,
  settleRuntimeTaskFromAgentTurn,
  settleRuntimeTaskFromMaterialIntake,
};
