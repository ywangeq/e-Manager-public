import {
  SOURCE_SYSTEM_ID,
  cleanShortText,
  digestValue,
  inferRuntimeTaskType,
  maskIdentifier,
  sanitizeMaterialRefs,
} from "../../feishu-integration-support.mjs";
import { RUNTIME_TASK_CONTRACT_VERSION } from "../../agent-runtime/runtime-task-service.mjs";

function saveRuntimeTaskFromFeishuEvent({
  store,
  employee = {},
  nextRecordId = (prefix = "ALGTASK") => `${prefix}-${Date.now()}`,
  connection = {},
  conversationKey = "",
  eventType = "",
  materialMessage = null,
  materialMessages = [],
  messageEvent = {},
  materialIntakeStatusByDigest = {},
  materialToolResults = [],
  queueAdmission = { accepted: true },
  receiveMode = "",
  resourceSetup = {},
  submittedBy = {},
  turnDecision = {},
  now = new Date().toISOString(),
} = {}) {
  if (!store || typeof store.saveRuntimeTask !== "function") return null;
  const employeeId = cleanShortText(employee.id);
  if (!employeeId) throw new Error("feishu runtime intake requires employee.id");
  const employeeName = cleanShortText(employee.name || "数字员工");
  const message = messageEvent.message || {};
  const materialSourceMessages = Array.isArray(materialMessages) && materialMessages.length
    ? materialMessages
    : materialMessage && typeof materialMessage === "object"
      ? [materialMessage]
      : [message];
  const sender = messageEvent.sender || {};
  const messageId = cleanShortText(message.message_id);
  const chatId = cleanShortText(message.chat_id);
  const messageType = cleanShortText(message.message_type);
  const senderId = cleanShortText(
    sender.sender_id?.open_id ||
    sender.sender_id?.user_id ||
    sender.sender_id?.union_id
  );
  const materialRefs = materialSourceMessages.flatMap(extractMaterialRefsFromFeishuMessage).map((materialRef) => ({
    ...materialRef,
    intakeStatus: materialIntakeStatusByDigest[materialRef.refDigest] || materialRef.intakeStatus,
  }));
  const binding = connection.workerBinding || {};
  const taskType = inferRuntimeTaskType({
    messageType: cleanShortText(materialSourceMessages.find((item) => item.message_type)?.message_type) || messageType,
    materialRefs,
  });
  const invocationAllowed = turnDecision.invocationCheck?.status === "allowed";
  const queueAccepted = queueAdmission?.accepted !== false;
  const accepted = invocationAllowed && queueAccepted;
  const taskTitle = !invocationAllowed
    ? `飞书${employeeName}任务未通过运行准入`
    : !queueAccepted
    ? `飞书${employeeName}任务未接收`
    : taskType === "package_intake_analysis" ? "飞书文件包待接入分析" : `飞书${employeeName}任务`;
  const nextGate = !invocationAllowed
    ? turnDecision.invocationCheck?.nextGate || "本次任务未通过运行准入。"
    : !queueAccepted
    ? queueAdmission.nextGate || queueAdmission.message || "任务队列已满，请稍后再提交。"
    : resourceSetup.ready === false
      ? resourceSetup.nextGate
      : "任务已接收，将按运行资源队列自动处理。";

  return store.saveRuntimeTask({
    id: nextRecordId("FSTASK"),
    contractVersion: RUNTIME_TASK_CONTRACT_VERSION,
    employeeId,
    employeeName,
    sourceSystemId: SOURCE_SYSTEM_ID,
    applicationId: binding.applicationId || connection.applicationId,
    capabilityRequestId: binding.capabilityRequestId || connection.capabilityRequestId,
    correlationId: cleanShortText(turnDecision.turn?.correlationId),
    turnIntent: cleanShortText(turnDecision.turnIntent),
    responsePolicy: sanitizeResponsePolicy(turnDecision.responsePolicy),
    runtimeAdapter: cleanShortText(turnDecision.runtimeAdapter),
    taskType,
    taskTitle,
    problemSummary: !invocationAllowed
      ? "飞书任务未通过运行准入；用户原话未保存。"
      : !queueAccepted
      ? "任务队列已满，系统未接收执行；用户原话未保存。"
      : taskType === "package_intake_analysis"
      ? "飞书消息包含文件或资料，等待文件资料服务准备。"
      : `飞书消息已交给${employeeName}；用户原话未保存。`,
    status: !invocationAllowed ? "blocked" : !queueAccepted ? "queue_full" : resourceSetup.ready === false ? "pending_remote_resource" : "queued",
    queueLane: `feishu_${employeeId}_intake`,
    queuePolicy: queueAdmission.policy || {},
    queueStateAtAdmission: queueAdmission.queueState || {},
    invocationCheck: !invocationAllowed ? sanitizeInvocationCheck(turnDecision.invocationCheck) : !queueAccepted ? {
      status: "rejected",
      outcome: "queue_capacity_full",
      reason: "runtime_queue_full",
      nextGate,
    } : sanitizeInvocationCheck(turnDecision.invocationCheck),
    trigger: {
      channel: "feishu",
      receiveMode,
      eventType,
      messageType,
      messageId: maskIdentifier(messageId),
      chatId: maskIdentifier(chatId),
      senderId: maskIdentifier(senderId),
      chatType: cleanShortText(connection.allowedChatRefs?.find((item) => item.feishuIdDigest === digestValue(chatId))?.type),
      routeKey: digestValue(conversationKey || `${chatId}:${senderId}`),
      receivedAt: now,
    },
    selectedSkillIds: turnDecision.dependencyContext?.skillScope?.callableSkillIds || [],
    materialRefs,
    materialProcessing: materialToolResults.map(sanitizeMaterialToolResult).filter(Boolean),
    requiredResourceIds: Array.isArray(resourceSetup.requiredResourceIds) ? resourceSetup.requiredResourceIds : [],
    nextGate,
    submittedBy,
    submittedAt: now,
    queuedAt: accepted ? now : "",
    updatedAt: now,
    warnings: [
      "任务记录只保存安全摘要，不保存用户原话、raw prompt、模型 trace、执行 payload 或客户原始数据。",
      "飞书文件引用仅保留脱敏摘要；下载、解压、对象存储和远程执行由已启用的运行器自动处理。",
    ],
  });
}

function sanitizeResponsePolicy(policy = {}) {
  return {
    id: cleanShortText(policy.id),
    mode: cleanShortText(policy.mode),
    allowTask: Boolean(policy.allowTask),
    allowModel: Boolean(policy.allowModel),
    capabilityDisclosure: cleanShortText(policy.capabilityDisclosure),
  };
}

function sanitizeInvocationCheck(check = {}) {
  return {
    status: cleanShortText(check.status),
    outcome: cleanShortText(check.outcome),
    reason: cleanShortText(check.reason),
    nextGate: cleanShortText(check.nextGate),
  };
}

function sanitizeMaterialToolResult(result = {}) {
  if (!result || typeof result !== "object") return null;
  return {
    toolId: cleanShortText(result.toolId),
    skillId: cleanShortText(result.skillId),
    status: cleanShortText(result.status),
    summary: cleanShortText(result.summary),
    groundTruthSource: cleanShortText(result.groundTruthSource),
    dataset: {
      fileCount: Number(result.dataset?.fileCount) || 0,
      imageCount: Number(result.dataset?.imageCount) || 0,
      annotationCount: Number(result.dataset?.annotationCount) || 0,
      labeledAnnotationCount: Number(result.dataset?.labeledAnnotationCount) || 0,
      listRowCount: Number(result.dataset?.listRowCount) || 0,
    },
    labels: Array.isArray(result.labels)
      ? result.labels.slice(0, 20).map((item) => ({
        label: cleanShortText(item.label),
        count: Number(item.count) || 0,
        fileCount: Number(item.fileCount) || 0,
      }))
      : [],
    riskCounts: Object.fromEntries(Object.entries(result.riskCounts || {})
      .slice(0, 16)
      .map(([key, value]) => [cleanShortText(key), Number(value) || 0])
      .filter(([key]) => key)),
    risks: Array.isArray(result.risks) ? result.risks.slice(0, 8).map(cleanShortText).filter(Boolean) : [],
    visualReview: {
      status: cleanShortText(result.visualReview?.status),
      sampleCount: Number(result.visualReview?.sampleCount) || 0,
      labels: Array.isArray(result.visualReview?.labels) ? result.visualReview.labels.slice(0, 24).map(cleanShortText).filter(Boolean) : [],
      seed: Number(result.visualReview?.seed) || 0,
    },
    nextGate: cleanShortText(result.nextGate),
  };
}

function extractMaterialRefsFromFeishuMessage(message = {}) {
  const messageType = cleanShortText(message.message_type);
  const content = parseMessageContent(message.content);
  const refs = extractFeishuMessageResources(message).map((resource) => ({
    type: messageType || resource.keyType,
    name: resource.name,
    ref: resource.fileKey,
    mimeType: resource.mimeType,
    sizeLabel: resource.sizeLabel,
    source: "feishu_event",
    intakeStatus: "metadata_only",
  }));
  if (!refs.length && ["file", "folder", "image", "media", "audio"].includes(messageType)) {
    refs.push({
      type: messageType,
      name: content.file_name || content.name || `${messageType} message`,
      source: "feishu_event",
      intakeStatus: "metadata_only",
    });
  }
  return sanitizeMaterialRefs(refs);
}

function extractFeishuMessageResources(message = {}) {
  const messageType = cleanShortText(message.message_type);
  const content = parseMessageContent(message.content);
  const resources = [];
  collectMessageResources(content, { messageType }, resources);
  const seen = new Set();
  return resources.filter((resource) => {
    if (!resource.fileKey || seen.has(`${resource.keyType}:${resource.fileKey}`)) return false;
    seen.add(`${resource.keyType}:${resource.fileKey}`);
    return true;
  });
}

function collectMessageResources(value, inherited = {}, resources = []) {
  if (!value) return resources;
  if (Array.isArray(value)) {
    value.forEach((item) => collectMessageResources(item, inherited, resources));
    return resources;
  }
  if (typeof value !== "object") return resources;
  const context = {
    messageType: inherited.messageType,
    name: cleanShortText(value.file_name || value.fileName || value.name || value.title || inherited.name || "file"),
    mimeType: cleanShortText(value.mime_type || value.mimeType || inherited.mimeType),
    sizeLabel: cleanShortText(value.size || inherited.sizeLabel),
  };
  for (const [keyType, fileKey] of [
    ["fileKey", value.file_key || value.fileKey],
    ["imageKey", value.image_key || value.imageKey],
    ["mediaKey", value.media_key || value.mediaKey],
  ]) {
    const normalizedKey = cleanShortText(fileKey);
    if (normalizedKey) resources.push({ keyType, fileKey: normalizedKey, ...context });
  }
  Object.values(value).forEach((child) => {
    if (child && typeof child === "object") collectMessageResources(child, context, resources);
  });
  return resources;
}

function parseMessageContent(content = "") {
  if (!content || typeof content !== "string") return {};
  try {
    const parsed = JSON.parse(content);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

export {
  extractFeishuMessageResources,
  extractMaterialRefsFromFeishuMessage,
  saveRuntimeTaskFromFeishuEvent,
};
