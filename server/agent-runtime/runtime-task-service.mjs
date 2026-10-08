import crypto from "node:crypto";
import { settleRuntimeTaskFromAgentTurn } from "./runtime-task-lifecycle.mjs";
import { markRuntimeTaskFeedbackReceived } from "./runtime-task-feedback.mjs";

const RUNTIME_TASK_CONTRACT_VERSION = "digital-employee-runtime-task.v2";
const CANCELABLE_STATUSES = new Set([
  "queued",
  "received",
  "running",
  "retrying",
  "pending_file_intake",
  "pending_remote_resource",
  "pending_invocation_check",
]);
const TERMINAL_STATUSES = new Set(["completed", "failed", "blocked", "canceled", "queue_full", "timeout"]);

function createRuntimeTaskService({
  nextRecordId = (prefix = "RUNTASK") => `${prefix}-${Date.now()}-${crypto.randomBytes(4).toString("hex")}`,
  now = () => new Date().toISOString(),
  qualityEventStore = null,
  store = null,
} = {}) {
  function listTasks(employeeId = "", { actor = null, includeAll = true } = {}) {
    const target = cleanId(employeeId);
    if (!target || typeof store?.readRuntimeTasks !== "function") return [];
    const tasks = store.readRuntimeTasks().filter((task) => cleanId(task.employeeId) === target);
    if (includeAll) return tasks;
    const targetActorKey = actorDigest(actor || {});
    return tasks.filter((task) => cleanId(task.submittedBy?.id) === cleanId(targetActorKey));
  }

  function findTask(employeeId = "", taskId = "") {
    const targetTaskId = cleanId(taskId);
    return listTasks(employeeId).find((task) => cleanId(task.id) === targetTaskId) || null;
  }

  function createConversationTask({
    channelId = "management_console",
    employee = {},
    model = "",
    session = {},
    turnDecision = {},
  } = {}) {
    if (typeof store?.saveRuntimeTask !== "function" || !cleanId(employee.id)) return null;
    const timestamp = now();
    return store.saveRuntimeTask({
      id: nextRecordId("RUNTASK"),
      contractVersion: RUNTIME_TASK_CONTRACT_VERSION,
      employeeId: cleanId(employee.id),
      employeeName: cleanText(employee.name || employee.displayName),
      employeeVersion: cleanText(employee.version),
      sourceSystemId: channelId === "desktop" ? "desktop-device-channel" : "digital-workforce-management",
      taskType: "digital_employee_chat",
      taskTitle: `${cleanText(employee.name || employee.displayName || "数字员工")}对话`,
      problemSummary: "已接收一次数字员工任务；用户原话和回复正文不进入任务台账。",
      queueLane: "center_agent_runtime",
      turnIntent: cleanId(turnDecision.turnIntent || "conversation"),
      responsePolicy: sanitizeResponsePolicy(turnDecision.responsePolicy),
      runtimeAdapter: cleanId(employee.runtimeBinding?.runtimeAdapter || "responses_api"),
      status: turnDecision.runtimeEligible === false ? "blocked" : "running",
      invocationCheck: sanitizeInvocationCheck(turnDecision.invocationCheck),
      trigger: {
        channel: cleanId(channelId),
        receiveMode: "authenticated_chat",
        eventType: "task_request",
        routeKey: actorDigest(session),
        receivedAt: timestamp,
      },
      submittedBy: safeActor(session),
      submittedAt: timestamp,
      startedAt: turnDecision.runtimeEligible === false ? "" : timestamp,
      updatedAt: timestamp,
      nextGate: turnDecision.runtimeEligible === false
        ? cleanText(turnDecision.invocationCheck?.nextGate || "本次任务未通过运行门禁。")
        : "数字员工已领取任务，正在中心公共 Runtime 中处理。",
      execution: {
        mode: "center_managed_employee_runtime",
        status: turnDecision.runtimeEligible === false ? "blocked" : "running",
        model: cleanText(model),
        startedAt: turnDecision.runtimeEligible === false ? "" : timestamp,
      },
      warnings: ["任务台账不保存用户原话、回复正文、raw prompt、模型 trace、Tool 凭证或执行 payload。"],
    });
  }

  function settleConversationTask(task, agentTurn) {
    if (!task) return task;
    const current = findTask(task.employeeId, task.id) || task;
    if (TERMINAL_STATUSES.has(cleanId(current.status))) return current;
    return settleRuntimeTaskFromAgentTurn({ store, task: current, agentTurn, now: now() });
  }

  function failConversationTask(task, reasonCode = "runtime_failed") {
    if (!task || typeof store?.saveRuntimeTask !== "function") return task;
    const current = findTask(task.employeeId, task.id) || task;
    if (TERMINAL_STATUSES.has(cleanId(current.status))) return current;
    const timestamp = now();
    return store.saveRuntimeTask({
      ...current,
      status: "failed",
      failedAt: current.failedAt || timestamp,
      updatedAt: timestamp,
      nextGate: "中心 Runtime 未完成本次任务；请检查安全错误分类和运行配置。",
      invocationCheck: {
        ...(current.invocationCheck || {}),
        reason: cleanId(reasonCode),
      },
      execution: {
        ...(current.execution || {}),
        status: "failed",
        failedAt: current.execution?.failedAt || timestamp,
        resultSummary: "中心 Runtime 未完成本次任务。",
      },
    });
  }

  function isCancellationRequested(task = null) {
    return Boolean(task?.id && findTask(task.employeeId, task.id)?.status === "canceled");
  }

  function isTaskOwnedBy(task = null, actor = {}) {
    return Boolean(task?.id) && cleanId(task.submittedBy?.id) === cleanId(actorDigest(actor));
  }

  function cancelTask({ actor = {}, employeeId = "", reasonCode = "operator_requested", taskId = "" } = {}) {
    const task = findTask(employeeId, taskId);
    if (!task) return failure(404, "runtime_task_not_found", "未找到该数字员工任务。");
    if (task.status === "canceled") return success("runtime_task_already_canceled", task, "任务已经取消。");
    if (!CANCELABLE_STATUSES.has(cleanId(task.status))) {
      return failure(409, "runtime_task_not_cancelable", "只有排队、等待或运行中的任务可以取消。", task);
    }
    const timestamp = now();
    const normalizedReason = ["operator_requested", "stale_task", "wrong_input", "resource_reclaimed"].includes(cleanId(reasonCode))
      ? cleanId(reasonCode)
      : "operator_requested";
    const canceledTask = store.saveRuntimeTask({
      ...task,
      status: "canceled",
      canceledAt: timestamp,
      canceledBy: safeActor(actor),
      updatedAt: timestamp,
      nextGate: "任务已取消；如需继续，请重新提交任务。",
      closure: { ...(task.closure || {}), status: "canceled", reason: normalizedReason, updatedAt: timestamp },
      execution: {
        ...(task.execution || {}),
        status: "canceled",
        canceledAt: timestamp,
        resultSummary: "管理员已取消任务，运行器将在最近的安全边界停止。",
        nextGate: "停止后不会继续调用模型或 Tool；如需继续，请重新提交任务。",
      },
    });
    return success("runtime_task_canceled", canceledTask, "任务已取消，运行器将在最近的安全边界停止。");
  }

  function submitFeedback({ actor = {}, employee = {}, rating = "", reasonCode = "", sourceChannel = "management_console", taskId = "" } = {}) {
    const task = findTask(employee.id, taskId);
    if (!task) return failure(404, "runtime_task_not_found", "未找到该数字员工任务。");
    if (task.status !== "completed") {
      return failure(409, "runtime_task_feedback_not_ready", "只有已完成的任务可以记录回答质量反馈。", task);
    }
    const normalizedRating = cleanId(rating);
    if (!new Set(["helpful", "not_helpful"]).has(normalizedRating)) {
      return failure(422, "invalid_runtime_task_feedback_rating", "反馈只能是 helpful 或 not_helpful。", task);
    }
    const timestamp = now();
    const operatorIdDigest = actorDigest(actor);
    const answerId = cleanId(task.feedback?.answerId) || `ans-${digest(task.id).slice(0, 16)}`;
    const duplicate = typeof store?.readCardFeedback === "function"
      ? store.readCardFeedback().find((item) => cleanId(item.answerId) === cleanId(answerId) && cleanId(item.operatorIdDigest) === cleanId(operatorIdDigest))
      : null;
    if (duplicate) return { ...success("runtime_task_feedback_duplicate", task, "已收到这条任务的反馈。"), feedback: duplicate };

    const qualityEvent = normalizedRating === "not_helpful"
      ? saveFeedbackQualityEvent({ actor, answerId, employee, reasonCode, task, timestamp })
      : null;
    const feedback = {
      id: `FDBK-${digest(`${answerId}:${operatorIdDigest}`).slice(0, 20).toUpperCase()}`,
      contractVersion: "runtime-task-feedback.v1",
      answerId,
      rating: normalizedRating,
      employeeId: cleanId(employee.id),
      employeeVersion: cleanText(employee.version),
      promptVersion: cleanText(employee.promptVersion),
      taskId: task.id,
      requestId: cleanId(task.feedback?.requestId || task.capabilityRequestId),
      skillId: cleanId(task.feedback?.skillId || task.selectedSkillIds?.[0]),
      operatorIdDigest,
      idempotencyKey: digest(`${answerId}:${operatorIdDigest}`),
      sourceChannel: cleanId(sourceChannel || "management_console"),
      reasonCode: ["not_resolved", "missing_context", "needs_human_review", "other"].includes(cleanId(reasonCode)) ? cleanId(reasonCode) : "",
      qualityEventId: qualityEvent?.id || "",
      qualityStatus: normalizedRating === "not_helpful"
        ? qualityEvent ? "pending_quality_review" : "quality_store_unavailable"
        : "quality_ok",
      receivedAt: timestamp,
      updatedAt: timestamp,
    };
    const savedFeedback = typeof store?.saveCardFeedback === "function" ? store.saveCardFeedback(feedback) : feedback;
    const updatedTask = markRuntimeTaskFeedbackReceived({
      store,
      feedback: savedFeedback,
      qualityStatus: savedFeedback.qualityStatus,
      qualityEventId: savedFeedback.qualityEventId,
      sourceChannel: cleanId(sourceChannel || "management_console"),
      feedbackContractVersion: "runtime-task-feedback.v1",
      policyId: cleanId(task.feedbackPolicy?.policyId || "runtime_feedback_auto_archive_6h"),
      autoArchiveAfterHours: Number(task.feedbackPolicy?.autoArchiveAfterHours || 6),
      now: timestamp,
    }) || task;
    return {
      ...success(normalizedRating === "not_helpful" ? "runtime_task_feedback_issue_recorded" : "runtime_task_feedback_ok_recorded", updatedTask, normalizedRating === "not_helpful" ? "已记录问题反馈，并进入质量复盘。" : "已记录质量 OK。"),
      feedback: savedFeedback,
      qualityEvent,
    };
  }

  function saveFeedbackQualityEvent({ actor, answerId, employee, reasonCode, task, timestamp }) {
    if (typeof qualityEventStore?.saveQualityEvent !== "function") return null;
    try {
      return qualityEventStore.saveQualityEvent({
        id: nextRecordId("QEFDBK"),
        sourceSystemId: cleanId(task.sourceSystemId || "digital-workforce-management"),
        sourceEventId: `runtime-task-feedback:${task.id}:${actorDigest(actor)}`,
        eventType: "badcase_summary",
        occurredAt: timestamp,
        reportedAt: timestamp,
        departmentId: cleanId(employee.ownerDepartmentId || employee.departmentId),
        businessDomain: cleanText(employee.businessDomain || employee.domain),
        executionMode: "platform_hosted",
        platformPolicyId: "INVOKE-DIGITAL-EMPLOYEE-RUNTIME-001",
        entityType: "数字员工",
        entityId: cleanId(employee.id),
        entityVersion: cleanText(employee.version),
        capabilityVersion: cleanText(task.selectedSkillIds?.[0]),
        promptVersion: cleanText(employee.promptVersion),
        severity: "P2",
        status: "待平台质量复盘",
        errorDomain: "user_feedback",
        errorCode: "RUNTIME_TASK_ANSWER_NOT_HELPFUL",
        rootCauseCategory: "pending_analysis",
        resolutionAction: "pending_review",
        expectedSummary: "用户期望数字员工任务回答或分析证据能够解决当前问题。",
        actualSummary: "用户在任务监控中标记为存在问题。",
        evidenceSummary: `任务 ${task.id} / 回答 ${answerId} 收到负向质量反馈；仅保留任务、回答和脱敏操作者关联键。`,
        evalCandidate: true,
        reviewGate: "质量治理确认根因、修复动作和回归候选后入库。",
        warnings: ["未保存 Channel 原话、回答原文、raw prompt、模型 trace 或执行 payload。"],
        tags: ["runtime-task-feedback", "management-console-feedback", cleanId(reasonCode) || "no-reason-code"],
        updatedAt: timestamp,
      });
    } catch {
      return null;
    }
  }

  return {
    cancelTask,
    createConversationTask,
    failConversationTask,
    findTask,
    isCancellationRequested,
    isTaskOwnedBy,
    listTasks,
    settleConversationTask,
    submitFeedback,
  };
}

function success(status, task, message) {
  return { ok: true, statusCode: 200, status, task, message };
}

function failure(statusCode, error, message, task = null) {
  return { ok: false, statusCode, error, message, ...(task ? { task } : {}) };
}

function sanitizeResponsePolicy(policy = {}) {
  return {
    id: cleanId(policy.id),
    mode: cleanId(policy.mode),
    allowTask: Boolean(policy.allowTask),
    allowModel: Boolean(policy.allowModel),
    capabilityDisclosure: cleanId(policy.capabilityDisclosure),
  };
}

function sanitizeInvocationCheck(check = {}) {
  return {
    status: cleanId(check.status),
    outcome: cleanId(check.outcome),
    reason: cleanId(check.reason),
    nextGate: cleanText(check.nextGate),
  };
}

function safeActor(actor = {}) {
  return {
    id: actorDigest(actor),
    role: cleanId(actor.role || "member"),
    identitySource: cleanId(actor.identitySource),
  };
}

function actorDigest(actor = {}) {
  return digest(cleanText(actor.id || actor.employeeId || actor.employeeNo || actor.email || actor.name || "anonymous")).slice(0, 20);
}

function digest(value = "") {
  return crypto.createHash("sha256").update(String(value)).digest("hex");
}

function cleanId(value = "") {
  return String(value || "").trim().toLowerCase().replace(/[^a-z0-9._:-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 240);
}

function cleanText(value = "") {
  return String(value || "").replace(/[\u0000-\u001f]/g, " ").replace(/\s+/g, " ").trim().slice(0, 1200);
}

export { CANCELABLE_STATUSES, RUNTIME_TASK_CONTRACT_VERSION, createRuntimeTaskService };
