function cleanShortText(value = "") {
  return String(value || "").replace(/\s+/g, " ").trim().slice(0, 240);
}

function resolveFeedbackConfig({
  task = {},
  sourceChannel = "",
  feedbackContractVersion = "",
  policyId = "",
  autoArchiveAfterHours = null,
} = {}) {
  const taskPolicy = task.feedbackPolicy || task.feedbackConfig || {};
  const archiveHours = firstPositiveNumber(
    autoArchiveAfterHours,
    taskPolicy.autoArchiveAfterHours,
    task.feedback?.autoArchiveAfterHours,
  );
  return {
    sourceChannel: cleanShortText(sourceChannel || taskPolicy.sourceChannel || task.feedback?.sourceChannel),
    feedbackContractVersion: cleanShortText(
      feedbackContractVersion || taskPolicy.contractVersion || task.feedback?.contractVersion,
    ),
    policyId: cleanShortText(policyId || taskPolicy.policyId || task.closure?.policyId),
    autoArchiveAfterHours: archiveHours,
    autoArchiveAfterMs: archiveHours > 0 ? archiveHours * 60 * 60 * 1000 : 0,
  };
}

function markRuntimeTaskFeedbackDelivery({
  store,
  task = null,
  reply = null,
  feedbackEnabled = false,
  sourceChannel = "",
  feedbackContractVersion = "",
  policyId = "",
  autoArchiveAfterHours = null,
  now = new Date().toISOString(),
} = {}) {
  if (!store || typeof store.saveRuntimeTask !== "function" || !task?.id || !reply) return task;
  const config = resolveFeedbackConfig({
    task,
    sourceChannel,
    feedbackContractVersion,
    policyId,
    autoArchiveAfterHours,
  });
  const status = cleanShortText(task.status);
  const feedbackDelivery = feedbackEnabled &&
    Boolean(config.feedbackContractVersion) &&
    reply.feedbackContractVersion === config.feedbackContractVersion;
  const delivered = feedbackDelivery && isFeedbackReplyDelivered(reply);
  if (!delivered && status !== "completed") return task;

  if (delivered) {
    const archiveDueAt = task.feedback?.archiveDueAt || (
      config.autoArchiveAfterMs > 0 ? addMsIso(now, config.autoArchiveAfterMs) : ""
    );
    return store.saveRuntimeTask({
      ...task,
      feedback: {
        ...(task.feedback || {}),
        contractVersion: config.feedbackContractVersion,
        sourceChannel: config.sourceChannel,
        availability: "available",
        status: "awaiting_user_feedback",
        answerId: cleanShortText(reply.answerId),
        requestId: cleanShortText(reply.requestId),
        skillId: cleanShortText(reply.skillId),
        deliveredAt: task.feedback?.deliveredAt || now,
        archiveDueAt,
        autoArchiveAfterHours: config.autoArchiveAfterHours || undefined,
        updatedAt: now,
      },
      closure: status === "completed" ? {
        ...(task.closure || {}),
        status: "pending_user_feedback",
        reason: "awaiting_user_feedback",
        policyId: config.policyId,
        updatedAt: now,
      } : task.closure,
      nextGate: status === "completed"
        ? feedbackWaitMessage(config.autoArchiveAfterHours)
        : task.nextGate,
      updatedAt: now,
    });
  }

  return store.saveRuntimeTask({
    ...task,
    feedback: {
      ...(task.feedback || {}),
      contractVersion: config.feedbackContractVersion,
      sourceChannel: config.sourceChannel,
      availability: "unavailable",
      status: feedbackEnabled ? "feedback_card_not_delivered" : "feedback_not_open",
      reason: cleanShortText(reply.status || (feedbackEnabled ? "reply_delivery_failed" : "card_feedback_subscription_missing")),
      updatedAt: now,
    },
    closure: {
      ...(task.closure || {}),
      status: "archive_ready",
      reason: feedbackEnabled ? "feedback_card_not_delivered" : "feedback_not_open",
      policyId: config.policyId,
      updatedAt: now,
    },
    nextGate: feedbackEnabled
      ? "质量反馈入口未成功发送，本次可归档；请检查消息 API 或交互组件权限。"
      : "未开通回答质量反馈，本次可归档。",
    updatedAt: now,
  });
}

function markRuntimeTaskFeedbackReceived({
  store,
  feedback = {},
  qualityStatus = "",
  qualityEventId = "",
  sourceChannel = "",
  feedbackContractVersion = "",
  policyId = "",
  autoArchiveAfterHours = null,
  now = new Date().toISOString(),
} = {}) {
  if (!store || typeof store.saveRuntimeTask !== "function" || typeof store.readRuntimeTasks !== "function") return null;
  const taskId = cleanShortText(feedback.taskId);
  if (!taskId) return null;
  const task = store.readRuntimeTasks().find((item) => item.id === taskId);
  if (!task) return null;
  const config = resolveFeedbackConfig({
    task,
    sourceChannel,
    feedbackContractVersion,
    policyId,
    autoArchiveAfterHours,
  });
  const rating = cleanShortText(feedback.rating).toLowerCase();
  const negative = rating === "not_helpful";
  const feedbackStatus = negative ? "pending_quality_review" : "quality_ok";
  const dueAt = task.feedback?.archiveDueAt || "";
  const lateFeedback = task.feedback?.status === "auto_archived_no_feedback" || isAfter(now, dueAt);

  return store.saveRuntimeTask({
    ...task,
    feedback: {
      ...(task.feedback || {}),
      contractVersion: config.feedbackContractVersion,
      sourceChannel: config.sourceChannel,
      availability: "available",
      status: feedbackStatus,
      rating,
      answerId: cleanShortText(feedback.answerId || task.feedback?.answerId),
      requestId: cleanShortText(feedback.requestId || task.feedback?.requestId),
      skillId: cleanShortText(feedback.skillId || task.feedback?.skillId),
      qualityStatus: cleanShortText(qualityStatus || feedback.qualityStatus || feedbackStatus),
      qualityEventId: cleanShortText(qualityEventId || feedback.qualityEventId),
      receivedAt: cleanShortText(feedback.receivedAt || now),
      late: Boolean(lateFeedback),
      updatedAt: now,
    },
    closure: {
      ...(task.closure || {}),
      status: negative ? "quality_review" : "confirmed",
      reason: negative ? "user_reported_issue" : "user_confirmed_quality",
      policyId: config.policyId,
      updatedAt: now,
    },
    nextGate: negative
      ? "用户反馈存在问题，已进入质量复盘。"
      : "用户已确认质量 OK，可归档。",
    updatedAt: now,
  });
}

function refreshRuntimeTaskFeedbackArchives({
  store,
  tasks = [],
  sourceChannel = "",
  feedbackContractVersion = "",
  policyId = "",
  autoArchiveAfterHours = null,
  now = new Date().toISOString(),
} = {}) {
  if (!store || typeof store.saveRuntimeTask !== "function") return tasks;
  let changed = false;
  tasks.forEach((task) => {
    const nextTask = archiveRuntimeTaskFeedbackIfDue({
      store,
      task,
      sourceChannel,
      feedbackContractVersion,
      policyId,
      autoArchiveAfterHours,
      now,
    });
    if (nextTask !== task) changed = true;
  });
  return changed && typeof store.readRuntimeTasks === "function" ? store.readRuntimeTasks() : tasks;
}

function archiveRuntimeTaskFeedbackIfDue({
  store,
  task = null,
  sourceChannel = "",
  feedbackContractVersion = "",
  policyId = "",
  autoArchiveAfterHours = null,
  now = new Date().toISOString(),
} = {}) {
  if (!store || typeof store.saveRuntimeTask !== "function" || !task?.id) return task;
  if (cleanShortText(task.status) !== "completed") return task;
  if (cleanShortText(task.feedback?.status) !== "awaiting_user_feedback") return task;
  const config = resolveFeedbackConfig({
    task,
    sourceChannel,
    feedbackContractVersion,
    policyId,
    autoArchiveAfterHours,
  });
  const dueAt = task.feedback?.archiveDueAt || (
    config.autoArchiveAfterMs > 0
      ? addMsIso(task.feedback?.deliveredAt || task.completedAt || task.updatedAt, config.autoArchiveAfterMs)
      : ""
  );
  if (!isAfter(now, dueAt)) return task;
  return store.saveRuntimeTask({
    ...task,
    feedback: {
      ...(task.feedback || {}),
      contractVersion: config.feedbackContractVersion,
      sourceChannel: config.sourceChannel,
      availability: "available",
      status: "auto_archived_no_feedback",
      reason: "user_no_feedback",
      archiveDueAt: dueAt,
      archivedAt: now,
      autoArchiveAfterHours: config.autoArchiveAfterHours || undefined,
      updatedAt: now,
    },
    closure: {
      ...(task.closure || {}),
      status: "archived",
      reason: "user_no_feedback",
      policyId: config.policyId,
      archivedAt: now,
      updatedAt: now,
    },
    nextGate: feedbackArchiveMessage(config.autoArchiveAfterHours),
    updatedAt: now,
  });
}

function isRuntimeTaskFeedbackArchivePending(task = {}) {
  return cleanShortText(task.status) === "completed" &&
    cleanShortText(task.feedback?.status) === "awaiting_user_feedback" &&
    Boolean(task.feedback?.archiveDueAt || task.feedback?.deliveredAt || task.completedAt || task.updatedAt);
}

function runtimeTaskFeedbackArchiveDelay(task = {}, nowMs = Date.now(), options = {}) {
  const config = resolveFeedbackConfig({ task, ...options });
  const dueAt = task.feedback?.archiveDueAt || (
    config.autoArchiveAfterMs > 0
      ? addMsIso(task.feedback?.deliveredAt || task.completedAt || task.updatedAt, config.autoArchiveAfterMs)
      : ""
  );
  const dueAtMs = Date.parse(dueAt);
  if (!Number.isFinite(dueAtMs)) return null;
  return Math.max(0, dueAtMs - nowMs);
}

function isFeedbackReplyDelivered(reply = {}) {
  const status = cleanShortText(reply.status);
  return reply.sent === true || status === "agent_feedback_reply_sent" || status === "send_skipped_for_local_test";
}

function firstPositiveNumber(...values) {
  for (const value of values) {
    const number = Number(value);
    if (Number.isFinite(number) && number > 0) return number;
  }
  return 0;
}

function feedbackWaitMessage(hours) {
  return hours > 0
    ? `已发送质量反馈入口，等待用户 ${hours} 小时内反馈；超时会自动归档并标记用户未反馈。`
    : "已发送质量反馈入口，等待用户反馈。";
}

function feedbackArchiveMessage(hours) {
  return hours > 0
    ? `超过 ${hours} 小时未收到用户反馈，系统已自动归档并标记用户未反馈。`
    : "在配置期限内未收到用户反馈，系统已自动归档并标记用户未反馈。";
}

function addMsIso(value = "", ms = 0) {
  const time = Date.parse(value);
  if (!Number.isFinite(time)) return "";
  return new Date(time + ms).toISOString();
}

function isAfter(now = "", dueAt = "") {
  const nowMs = Date.parse(now);
  const dueAtMs = Date.parse(dueAt);
  return Number.isFinite(nowMs) && Number.isFinite(dueAtMs) && nowMs >= dueAtMs;
}

export {
  archiveRuntimeTaskFeedbackIfDue,
  isRuntimeTaskFeedbackArchivePending,
  markRuntimeTaskFeedbackDelivery,
  markRuntimeTaskFeedbackReceived,
  refreshRuntimeTaskFeedbackArchives,
  runtimeTaskFeedbackArchiveDelay,
};
