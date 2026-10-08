import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { translateLegacyAlgorithmState } from "./channels/feishu/legacy-algorithm-state-compat.mjs";
import {
  LEGACY_ALGORITHM_EMPLOYEE_ID,
  canonicalDigitalEmployeeId,
} from "../src/data/digitalEmployeeIdentity.js";
import {
  inferMaterialRefType,
  inferRuntimeTaskType,
  sanitizeMaterialRefs,
  sanitizeRuntimeMaterialProcessing,
  sanitizeRuntimeQueuePolicy,
  sanitizeRuntimeQueueState,
  sanitizeRuntimeResponsePolicy,
  sanitizeRuntimeTaskClosure,
  sanitizeRuntimeTaskExecution,
  sanitizeRuntimeTaskFeedback,
  sanitizeTaskTrigger,
} from "./feishu-runtime-task-sanitizers.mjs";
import {
  ALGORITHM_RUNTIME_RESOURCE_DEFS,
  BUSINESS_DOMAIN,
  CHANNEL_INTENT_OPTIONS,
  CONNECTION_AUTOMATION_STEPS,
  CONNECTION_MODE_OPTIONS,
  CONNECTION_REQUIRED_FIELDS,
  CONTRACT_VERSION,
  CONVERSATION_GATEWAY_BOUNDARY,
  DEFAULT_CAPABILITIES,
  DEFAULT_CONNECTION_MODE,
  DEFAULT_RESOURCE_MONITOR_STATUS,
  DEFAULT_RUNTIME_TASK_STATUS,
  DEPARTMENT_ID,
  EMPLOYEE_ID,
  FEISHU_EVENT_CALLBACK_PATH,
  LEGACY_FEISHU_EVENT_CALLBACK_PATH,
  FEISHU_MESSAGE_REACTION_URL,
  FEISHU_REPLY_MESSAGE_URL,
  FEISHU_TENANT_TOKEN_URL,
  FORBIDDEN_MESSAGE_FIELDS,
  HIGH_RISK_ACTIONS,
  MATERIAL_MESSAGE_TYPES,
  MESSAGE_DELIVERY_OPTIONS,
  POST_APPROVAL_CHANNEL_ACTIONS,
  ROOT_SKILL_ID,
  RUNTIME_TASK_CONTRACT_VERSION,
  SAFE_SUMMARY,
  SOURCE_SYSTEM_ID,
  SOURCE_SYSTEM_NAME,
} from "./channels/feishu/integration-contract.mjs";
import {
  buildAdminConnectionDiagnostics,
  connectionForSession,
  nextAdminConnectionGate,
  nextConnectionGate,
  nextUserConnectionGate,
  normalizeConnectionMode,
  sanitizeAllowedChatRefs,
  sanitizeConnection,
  sanitizeConnectionTestResult,
  sanitizeDelivery,
  sanitizeEventSubscription,
  sanitizeEventSummary,
  sanitizeInvocationCheck,
  sanitizeTokenCheck,
  sanitizeWorkerBinding,
} from "./channels/feishu/connection-projection.mjs";
import {
  actorDigest,
  actorDisplay,
  actorSummary,
  chinaDate,
  cleanShortText,
  cleanText,
  defaultCleanList,
  defaultCleanText,
  digestValue,
  feishuWebhookUrl,
  hasPlatformGovernance,
  hasUnsafeText,
  inferFeishuChatRefType,
  isHttpsUrl,
  isLocalCallbackUrl,
  isPersonalScope,
  maskIdentifier,
  normalizeAllowedChatRefs,
  parseAllowedChatRef,
  sanitizeActor,
  uniqueList,
} from "./channels/feishu/integration-values.mjs";

function buildFeishuMessagePreview({ employee, requestId, status, sceneType, requestScope, channelIntent = null, requestedGroupNames = [], selectedSkills = [], highRisk }) {
  const title = highRisk ? "这个动作不在自动处理范围内" : "已收到算法问题申请";
  const statusText = {
    pending_review: "等待平台门禁和研发负责人确认",
    dry_run_passed: "消息 dry-run 通过",
    human_review_required: "运行受限",
    blocked: "已阻断",
  }[status] || status;
  const skillNames = uniqueList((selectedSkills || []).map((skill) => cleanShortText(skill.name || skill.id))).slice(0, 8);
  const channelIntentLabel = channelIntentLabelText(channelIntent);
  const groupNames = defaultCleanList(requestedGroupNames).slice(0, 8);
  const text = [
    title,
    "",
    `系统已自动选择：${employee.name}`,
    `申请编号：${requestId}`,
    `申请范围：${requestScope || "本人先试用"}`,
    channelIntentLabel ? `对话场景：${channelIntentLabel}` : "",
    groupNames.length ? `希望开通飞书群：${groupNames.join(" / ")}` : "",
    skillNames.length ? `启用功能：${skillNames.join(" / ")}` : "",
    `系统归档场景：${sceneType}`,
    `当前状态：${statusText}`,
    highRisk
      ? "原因：涉及远程写操作、代码提交、发布或客户承诺。系统已生成安全申请，不会自动执行。"
      : "你可以继续补材料，或查看申请状态。",
  ].filter(Boolean).join("\n");

  return {
    type: "text",
    title,
    text,
    safeFields: ["employeeName", "requestId", "requestScope", "channelIntent", "requestedGroupNames", "selectedSkills", "sceneType", "status", "nextGate"],
    forbiddenFields: FORBIDDEN_MESSAGE_FIELDS,
    messageContractOk: true,
  };
}

function channelIntentLabelText(channelIntent = null) {
  const intents = Array.isArray(channelIntent) ? channelIntent : [channelIntent];
  return uniqueList(intents.map((intent) =>
    cleanShortText(intent?.label || intent?.value || intent)
  )).join(" / ");
}

function isPendingStatus(status = "") {
  const text = cleanShortText(status);
  if (/approved|rejected|canceled|cancelled|已通过|通过|已退回|退回|拒绝|已撤销|撤销/i.test(text)) return false;
  return /pending|待|评审|审核|review/i.test(text);
}

function isCancelableApplicationStatus(status = "") {
  const text = cleanShortText(status);
  if (!text) return false;
  if (/rejected|canceled|cancelled|已退回|退回|拒绝|已撤销|撤销/i.test(text)) return false;
  return /pending|待|评审|审核|review|approved|已通过|通过/i.test(text);
}

function summarizeRequestedSkill(skill = {}) {
  return {
    id: cleanShortText(skill.id),
    skillApiId: cleanShortText(skill.skillApiId || skill.id),
    sourceSkillId: cleanShortText(skill.sourceSkillId),
    name: cleanShortText(skill.name || skill.id),
    status: cleanShortText(skill.status),
    risk: cleanShortText(skill.risk),
    reviewGate: cleanText(skill.reviewGate),
    capabilities: defaultCleanList(skill.capabilities).slice(0, 4),
  };
}

function sanitizeRequestedSkills(skills = []) {
  return (Array.isArray(skills) ? skills : []).slice(0, 20).map(summarizeRequestedSkill);
}

function createFeishuIntegrationStore({ storePath }) {
  const secretKeys = createLocalSecretKeys(storePath);
  const secretKey = secretKeys[0];
  let runtimeTaskWriterFrozen = false;

  function readStore() {
    let data;
    try {
      if (!storePath || !fs.existsSync(storePath)) return emptyStore();
      data = JSON.parse(fs.readFileSync(storePath, "utf8"));
      if (!data || typeof data !== "object") return emptyStore();
    } catch {
      return emptyStore();
    }
    const migrated = translateLegacyAlgorithmState(data);
    return {
      version: "feishu-employee-integrations.v2",
      applications: migrated.applications,
      messageTests: migrated.messageTests,
      cardFeedback: migrated.cardFeedback,
      runtimeTasks: migrated.runtimeTasks,
      resourceMonitors: migrated.resourceMonitors,
      connection: {},
      secretVault: {},
      connections: migrated.connections,
      secretVaults: migrated.secretVaults,
      updatedAt: migrated.updatedAt || "",
    };
  }

  function writeStore(store) {
    if (!storePath) return;
    fs.mkdirSync(path.dirname(storePath), { recursive: true });
    const temporaryPath = `${storePath}.${process.pid}.${crypto.randomUUID()}.tmp`;
    fs.writeFileSync(temporaryPath, `${JSON.stringify(store, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    fs.renameSync(temporaryPath, storePath);
  }

  function saveApplication(application = {}) {
    const store = readStore();
    const next = sanitizeApplication(application);
    requireScopedEmployeeId(next.targetEmployeeId);
    if (!next.id) return next;
    store.applications[next.id] = next;
    store.updatedAt = new Date().toISOString();
    writeStore(store);
    return next;
  }

  function saveMessageTest(messageTest = {}) {
    const store = readStore();
    const next = sanitizeMessageTest(messageTest);
    requireScopedEmployeeId(next.employeeId);
    if (!next.id) return next;
    store.messageTests[next.id] = next;
    store.updatedAt = new Date().toISOString();
    writeStore(store);
    return next;
  }

  function saveCardFeedback(feedback = {}) {
    const store = readStore();
    const next = sanitizeCardFeedback(feedback);
    requireScopedEmployeeId(next.employeeId);
    if (!next.id) return next;
    store.cardFeedback[next.id] = next;
    store.updatedAt = new Date().toISOString();
    writeStore(store);
    return next;
  }

  function saveRuntimeTask(runtimeTask = {}) {
    if (runtimeTaskWriterFrozen) {
      const error = new Error("legacy runtime task writer is frozen; execution-task.v1 is authoritative");
      error.code = "legacy_runtime_task_writer_frozen";
      throw error;
    }
    const store = readStore();
    const next = sanitizeRuntimeTask(runtimeTask);
    requireScopedEmployeeId(next.employeeId);
    if (!next.id) return next;
    store.runtimeTasks[next.id] = next;
    store.updatedAt = new Date().toISOString();
    writeStore(store);
    return next;
  }

  function saveResourceMonitor(resourceMonitor = {}) {
    const store = readStore();
    const employeeId = requireScopedEmployeeId(resourceMonitor.employeeId);
    const next = sanitizeResourceMonitor({ ...resourceMonitor, employeeId });
    if (!next.id) return next;
    store.resourceMonitors[`${employeeId}:${next.id}`] = next;
    store.updatedAt = new Date().toISOString();
    writeStore(store);
    return next;
  }

  function saveConnection(connection = {}, scopedEmployeeId = connection.employeeId) {
    const store = readStore();
    const employeeId = requireScopedEmployeeId(scopedEmployeeId, { write: true });
    const storedConnection = store.connections?.[employeeId] || {};
    const storedVault = store.secretVaults?.[employeeId] || {};
    const currentConnection = sanitizeConnection({ ...(storedConnection || {}), employeeId });
    const allowedChatRefs = normalizeAllowedChatRefs(connection.allowedChatRefs || connection.allowedChatNames || currentConnection.allowedChatRefs || currentConnection.allowedChatNames);
    const secrets = {
      appId: cleanShortText(connection.appId),
      appSecret: String(connection.appSecret || ""),
      verificationToken: String(connection.verificationToken || ""),
      encryptKey: String(connection.encryptKey || ""),
      allowedChatRefs: allowedChatRefs.some((item) => item.feishuId) ? JSON.stringify(allowedChatRefs) : "",
    };
    const nextVault = { ...(storedVault || {}) };
    Object.entries(secrets).forEach(([key, value]) => {
      if (value) nextVault[key] = encryptVaultValue(value, secretKey);
    });
    const next = sanitizeConnection({
      ...currentConnection,
      ...connection,
      employeeId,
      allowedChatRefs,
      allowedChatNames: allowedChatRefs.length
        ? allowedChatRefs.map((item) => item.name || item.feishuId).filter(Boolean)
        : connection.allowedChatNames,
      appIdMasked: maskIdentifier(secrets.appId || readSecretFromVault(nextVault, "appId")),
      appIdDigest: digestValue(secrets.appId || readSecretFromVault(nextVault, "appId")),
    });
    store.connections[employeeId] = next;
    store.secretVaults[employeeId] = nextVault;
    store.updatedAt = new Date().toISOString();
    writeStore(store);
    return next;
  }

  function readConnection(scopedEmployeeId) {
    const employeeId = requireScopedEmployeeId(scopedEmployeeId);
    const store = readStore();
    return sanitizeConnection({
      ...(store.connections?.[employeeId] || {}),
      employeeId,
    });
  }

  function readConnections() {
    const store = readStore();
    const connections = { ...(store.connections || {}) };
    return Object.fromEntries(Object.entries(connections).map(([employeeId, connection]) => [
      employeeId,
      sanitizeConnection({ ...connection, employeeId }),
    ]));
  }

  function readSecret(key, scopedEmployeeId) {
    const employeeId = requireScopedEmployeeId(scopedEmployeeId);
    const store = readStore();
    const vault = store.secretVaults?.[employeeId] || {};
    return readSecretFromVault(vault, key);
  }

  function requireScopedEmployeeId(value = "", { write = false } = {}) {
    const requestedEmployeeId = cleanShortText(value);
    if (write && requestedEmployeeId === LEGACY_ALGORITHM_EMPLOYEE_ID) {
      throw new Error("digital_employee_identity_alias_read_only");
    }
    const employeeId = canonicalDigitalEmployeeId(requestedEmployeeId) || requestedEmployeeId;
    if (!employeeId) throw new Error("feishu integration store employeeId required");
    return employeeId;
  }

  function readApplications() {
    return Object.values(readStore().applications || {}).map(sanitizeApplication).sort(sortUpdatedDesc);
  }

  function readMessageTests() {
    return Object.values(readStore().messageTests || {}).map(sanitizeMessageTest).sort(sortUpdatedDesc);
  }

  function readCardFeedback() {
    return Object.values(readStore().cardFeedback || {}).map(sanitizeCardFeedback).sort(sortUpdatedDesc);
  }

  function readRuntimeTasks() {
    return Object.values(readStore().runtimeTasks || {}).map(sanitizeRuntimeTask).sort(sortUpdatedDesc);
  }

  function freezeRuntimeTaskWriter() {
    runtimeTaskWriterFrozen = true;
    return Object.freeze({ authority: "execution-task.v1", writerFrozen: true });
  }

  function readResourceMonitors(scopedEmployeeId) {
    const employeeId = requireScopedEmployeeId(scopedEmployeeId);
    return Object.values(readStore().resourceMonitors || {})
      .filter((resource) => resource.employeeId === employeeId)
      .map(sanitizeResourceMonitor)
      .sort(sortUpdatedDesc);
  }

  function readSecretFromVault(vault = {}, key = "") {
    const encrypted = vault[key];
    return encrypted ? decryptWithSecretKeys(encrypted, secretKeys) : "";
  }

  return {
    freezeRuntimeTaskWriter,
    readApplications,
    readCardFeedback,
    readConnection,
    readConnections,
    readMessageTests,
    readResourceMonitors,
    readRuntimeTasks,
    readSecret,
    saveApplication,
    saveCardFeedback,
    saveConnection,
    saveMessageTest,
    saveResourceMonitor,
    saveRuntimeTask,
  };
}

function sanitizeApplication(application = {}) {
  return {
    id: cleanShortText(application.id),
    sourceSystemId: cleanShortText(application.sourceSystemId || SOURCE_SYSTEM_ID),
    sourceRequestId: cleanShortText(application.sourceRequestId),
    capabilityRequestId: cleanShortText(application.capabilityRequestId),
    targetEmployeeId: cleanShortText(application.targetEmployeeId),
    targetEmployeeName: cleanShortText(application.targetEmployeeName),
    targetSkillId: cleanShortText(application.targetSkillId || ROOT_SKILL_ID),
    departmentId: cleanShortText(application.departmentId),
    businessDomain: cleanShortText(application.businessDomain),
    sceneType: cleanShortText(application.sceneType),
    requestScope: cleanShortText(application.requestScope),
    requestScopeType: cleanShortText(application.requestScopeType),
    channelIntent: cleanShortText(application.channelIntent),
    channelIntentLabel: cleanShortText(application.channelIntentLabel),
    channelIntentIds: defaultCleanList(application.channelIntentIds),
    channelIntentLabels: defaultCleanList(application.channelIntentLabels),
    requestedGroupNames: defaultCleanList(application.requestedGroupNames).slice(0, 8),
    targetUserId: cleanShortText(application.targetUserId),
    targetUserName: cleanShortText(application.targetUserName),
    targetDepartmentId: cleanShortText(application.targetDepartmentId),
    targetDepartmentName: cleanShortText(application.targetDepartmentName),
    problemSummary: cleanText(application.problemSummary),
    evidenceRefs: defaultCleanList(application.evidenceRefs),
    selectedSkillIds: defaultCleanList(application.selectedSkillIds),
    selectedSkills: sanitizeRequestedSkills(application.selectedSkills),
    skillScopeMode: cleanShortText(application.skillScopeMode),
    writebackIntent: Boolean(application.writebackIntent),
    expectedOutput: cleanText(application.expectedOutput),
    status: cleanShortText(application.status || "待平台评审"),
    reviewDecision: sanitizeApplicationReviewDecision(application.reviewDecision),
    cancellationReason: cleanText(application.cancellationReason),
    canceledAt: cleanShortText(application.canceledAt),
    canceledBy: sanitizeActor(application.canceledBy),
    submittedBy: sanitizeActor(application.submittedBy),
    submittedAt: cleanShortText(application.submittedAt),
    updatedAt: cleanShortText(application.updatedAt),
  };
}

function sanitizeApplicationReviewDecision(decision = null) {
  if (!decision || typeof decision !== "object") return null;
  return {
    decision: cleanShortText(decision.decision),
    status: cleanShortText(decision.status),
    summary: cleanText(decision.summary),
    nextGate: cleanText(decision.nextGate),
    decidedAt: cleanShortText(decision.decidedAt),
    decidedBy: sanitizeActor(decision.decidedBy),
  };
}

function sanitizeMessageTest(messageTest = {}) {
  return {
    id: cleanShortText(messageTest.id),
    contractVersion: cleanShortText(messageTest.contractVersion || CONTRACT_VERSION),
    employeeId: cleanShortText(messageTest.employeeId),
    employeeName: cleanShortText(messageTest.employeeName),
    sourceSystemId: cleanShortText(messageTest.sourceSystemId || SOURCE_SYSTEM_ID),
    sceneType: cleanShortText(messageTest.sceneType),
    requestScope: cleanShortText(messageTest.requestScope),
    requestScopeType: cleanShortText(messageTest.requestScopeType),
    channelIntent: cleanShortText(messageTest.channelIntent),
    channelIntentLabel: cleanShortText(messageTest.channelIntentLabel),
    channelIntentIds: defaultCleanList(messageTest.channelIntentIds),
    channelIntentLabels: defaultCleanList(messageTest.channelIntentLabels),
    requestedGroupNames: defaultCleanList(messageTest.requestedGroupNames).slice(0, 8),
    selectedSkillIds: defaultCleanList(messageTest.selectedSkillIds),
    selectedSkills: sanitizeRequestedSkills(messageTest.selectedSkills),
    sourceMessageIdDigest: cleanShortText(messageTest.sourceMessageIdDigest),
    sourceMessageIdMasked: cleanShortText(messageTest.sourceMessageIdMasked),
    sourceChatIdMasked: cleanShortText(messageTest.sourceChatIdMasked),
    sourceSenderIdMasked: cleanShortText(messageTest.sourceSenderIdMasked),
    turnIntent: cleanShortText(messageTest.turnIntent),
    responsePolicy: sanitizeRuntimeResponsePolicy(messageTest.responsePolicy),
    runtimeAdapter: cleanShortText(messageTest.runtimeAdapter),
    status: cleanShortText(messageTest.status),
    messageContractOk: Boolean(messageTest.messageContractOk),
    delivery: sanitizeDelivery(messageTest.delivery),
    invocationCheck: sanitizeInvocationCheck(messageTest.invocationCheck),
    submittedBy: sanitizeActor(messageTest.submittedBy),
    submittedAt: cleanShortText(messageTest.submittedAt),
    updatedAt: cleanShortText(messageTest.updatedAt),
    warnings: defaultCleanList(messageTest.warnings),
  };
}

function sanitizeCardFeedback(feedback = {}) {
  const rating = cleanShortText(feedback.rating).toLowerCase();
  return {
    id: cleanShortText(feedback.id),
    contractVersion: cleanShortText(feedback.contractVersion || "feishu-answer-feedback.v1"),
    answerId: cleanShortText(feedback.answerId),
    rating: ["helpful", "not_helpful"].includes(rating) ? rating : "",
    employeeId: cleanShortText(feedback.employeeId),
    employeeVersion: cleanShortText(feedback.employeeVersion),
    promptVersion: cleanShortText(feedback.promptVersion),
    taskId: cleanShortText(feedback.taskId),
    taskRevision: Number.isSafeInteger(Number(feedback.taskRevision)) && Number(feedback.taskRevision) > 0
      ? Number(feedback.taskRevision)
      : null,
    requestId: cleanShortText(feedback.requestId),
    skillId: cleanShortText(feedback.skillId),
    sourceMessageIdDigest: cleanShortText(feedback.sourceMessageIdDigest),
    sourceChatIdDigest: cleanShortText(feedback.sourceChatIdDigest),
    operatorIdDigest: cleanShortText(feedback.operatorIdDigest),
    callbackEventIdDigest: cleanShortText(feedback.callbackEventIdDigest),
    idempotencyKey: cleanShortText(feedback.idempotencyKey),
    sourceChannel: cleanShortText(feedback.sourceChannel || "feishu_app_bot"),
    reasonCode: cleanShortText(feedback.reasonCode),
    qualityEventId: cleanShortText(feedback.qualityEventId),
    diagnosticChainVersion: cleanShortText(feedback.diagnosticChainVersion),
    qualityStatus: cleanShortText(feedback.qualityStatus),
    receivedAt: cleanShortText(feedback.receivedAt),
    updatedAt: cleanShortText(feedback.updatedAt || feedback.receivedAt),
  };
}

function sanitizeRuntimeTask(task = {}) {
  const materialRefs = sanitizeMaterialRefs(task.materialRefs || task.attachments || task.fileRefs);
  const queuePosition = Number(task.queuePosition);
  const priority = Number(task.priority);
  return {
    id: cleanShortText(task.id),
    contractVersion: cleanShortText(task.contractVersion || RUNTIME_TASK_CONTRACT_VERSION),
    employeeId: cleanShortText(task.employeeId),
    employeeName: cleanShortText(task.employeeName || "数字员工"),
    employeeVersion: cleanShortText(task.employeeVersion),
    sourceSystemId: cleanShortText(task.sourceSystemId || SOURCE_SYSTEM_ID),
    applicationId: cleanShortText(task.applicationId),
    capabilityRequestId: cleanShortText(task.capabilityRequestId),
    correlationId: cleanShortText(task.correlationId),
    turnIntent: cleanShortText(task.turnIntent),
    responsePolicy: sanitizeRuntimeResponsePolicy(task.responsePolicy),
    runtimeAdapter: cleanShortText(task.runtimeAdapter),
    taskType: cleanShortText(task.taskType || inferRuntimeTaskType({ messageType: task.messageType, materialRefs })),
    taskTitle: cleanShortText(task.taskTitle || task.title || "飞书数字员工任务"),
    problemSummary: cleanText(task.problemSummary),
    status: cleanShortText(task.status || DEFAULT_RUNTIME_TASK_STATUS),
    statusLabel: runtimeTaskStatusLabel(task.status || DEFAULT_RUNTIME_TASK_STATUS),
    queueLane: cleanShortText(task.queueLane || (task.employeeId ? `feishu_${task.employeeId}_intake` : "")),
    queuePosition: Number.isFinite(queuePosition) ? queuePosition : undefined,
    priority: Number.isFinite(priority) ? priority : undefined,
    queuePolicy: sanitizeRuntimeQueuePolicy(task.queuePolicy),
    queueStateAtAdmission: sanitizeRuntimeQueueState(task.queueStateAtAdmission),
    invocationCheck: sanitizeInvocationCheck(task.invocationCheck),
    trigger: sanitizeTaskTrigger(task.trigger),
    contextBoundary: cleanText(task.contextBoundary || "上下文按 taskId/chat/thread/requester 拆分；只保存安全摘要和 evidenceRef。"),
    selectedSkillIds: defaultCleanList(task.selectedSkillIds),
    selectedSkills: sanitizeRequestedSkills(task.selectedSkills),
    materialRefs,
    materialProcessing: sanitizeRuntimeMaterialProcessing(task.materialProcessing),
    evidenceRefs: defaultCleanList(task.evidenceRefs),
    requiredResourceIds: defaultCleanList(task.requiredResourceIds),
    nextGate: cleanText(task.nextGate || "任务已接收，将按运行资源队列自动处理。"),
    feedback: sanitizeRuntimeTaskFeedback(task.feedback),
    closure: sanitizeRuntimeTaskClosure(task.closure),
    submittedBy: sanitizeActor(task.submittedBy),
    submittedAt: cleanShortText(task.submittedAt),
    queuedAt: cleanShortText(task.queuedAt || task.submittedAt),
    startedAt: cleanShortText(task.startedAt),
    completedAt: cleanShortText(task.completedAt),
    failedAt: cleanShortText(task.failedAt),
    canceledAt: cleanShortText(task.canceledAt),
    canceledBy: sanitizeActor(task.canceledBy),
    timeoutAt: cleanShortText(task.timeoutAt),
    execution: sanitizeRuntimeTaskExecution(task.execution),
    updatedAt: cleanShortText(task.updatedAt || task.submittedAt),
    warnings: defaultCleanList(task.warnings),
  };
}

function sanitizeResourceMonitor(resource = {}) {
  const capacity = resource.capacity && typeof resource.capacity === "object" ? resource.capacity : {};
  return {
    id: cleanShortText(resource.id),
    employeeId: cleanShortText(resource.employeeId),
    name: cleanShortText(resource.name || resource.id),
    kind: cleanShortText(resource.kind || "remote_runtime"),
    status: cleanShortText(resource.status || DEFAULT_RESOURCE_MONITOR_STATUS),
    statusLabel: cleanShortText(resource.statusLabel || resourceStatusLabel(resource.status || DEFAULT_RESOURCE_MONITOR_STATUS)),
    ownerDepartmentId: cleanShortText(resource.ownerDepartmentId),
    boundary: cleanText(resource.boundary || "仅记录资源摘要、容量和门禁；不保存凭证、远程日志或客户数据。"),
    capacity: {
      total: cleanShortText(capacity.total),
      available: cleanShortText(capacity.available),
      queueDepth: cleanShortText(capacity.queueDepth),
      updatedAt: cleanShortText(capacity.updatedAt),
    },
    health: {
      status: cleanShortText(resource.health?.status || resource.healthStatus || resource.status || DEFAULT_RESOURCE_MONITOR_STATUS),
      message: cleanText(resource.health?.message || resource.healthMessage),
      checkedAt: cleanShortText(resource.health?.checkedAt || resource.checkedAt),
    },
    nextGate: cleanText(resource.nextGate || "由研发负责人确认 remote/集群、工作目录、环境、DVC/对象存储和删除权限后接入。"),
    updatedAt: cleanShortText(resource.updatedAt),
  };
}

function algorithmRuntimeResourceSetup(resourceMonitors = []) {
  const savedById = new Map((Array.isArray(resourceMonitors) ? resourceMonitors : []).map((resource) => {
    const safeResource = sanitizeResourceMonitor(resource);
    return [safeResource.id, safeResource];
  }));
  const missingResources = ALGORITHM_RUNTIME_RESOURCE_DEFS
    .map((resource) => sanitizeResourceMonitor({
      ...resource,
      ...(savedById.get(resource.id) || {}),
    }))
    .filter((resource) => resource.status !== "ready")
    .map((resource) => ({
      id: resource.id,
      name: resource.name,
      kind: resource.kind,
      status: resource.status,
      statusLabel: resource.statusLabel,
      nextGate: resource.nextGate,
    }));
  return {
    ready: missingResources.length === 0,
    status: missingResources.length ? "setup_required" : "ready",
    statusLabel: missingResources.length ? "等待运行资源" : "运行资源就绪",
    missingResourceIds: missingResources.map((resource) => resource.id),
    missingResourceNames: missingResources.map((resource) => resource.name),
    missingResources,
    nextGate: missingResources.length
      ? `需要先配置：${missingResources.map((resource) => resource.name).join("、")}。`
      : "运行资源摘要已就绪，任务会按资源队列自动处理。",
  };
}

function runtimeTaskStatusLabel(status = "") {
  const text = cleanShortText(status);
  if (text === "queued") return "排队中";
  if (text === "running") return "运行中";
  if (text === "blocked" || text === "human_review_required") return "运行受限";
  if (text === "completed") return "已完成";
  if (text === "failed") return "失败";
  if (text === "canceled") return "已撤销";
  if (text === "queue_full") return "队列已满";
  if (text === "timeout") return "已超时";
  if (text === "pending_remote_resource") return "待资源";
  if (text === "pending_file_intake") return "待文件接入";
  if (text === "pending_invocation_check" || text === "received") return "已接收";
  return "已接收";
}

function resourceStatusLabel(status = "") {
  const text = cleanShortText(status);
  if (text === "ready") return "可用";
  if (text === "degraded") return "降级";
  if (text === "blocked") return "阻断";
  if (text === "pending_review") return "待审核";
  return "待配置";
}

function emptyStore() {
  return {
    version: "feishu-employee-integrations.v2",
    applications: {},
    messageTests: {},
    cardFeedback: {},
    runtimeTasks: {},
    resourceMonitors: {},
    connection: {},
    secretVault: {},
    connections: {},
    secretVaults: {},
    updatedAt: "",
  };
}

function sortUpdatedDesc(left, right) {
  return String(right.updatedAt || right.submittedAt || "").localeCompare(String(left.updatedAt || left.submittedAt || ""));
}

function storePersistenceNote() {
  return {
    kind: "mvp-file-store",
    productionReady: false,
    path: "data/local/feishu-integration-state.json",
    note: "保存飞书接入与任务安全摘要；生产需替换为受 RBAC/KMS/保留策略管理的正式存储与审计。会话 transcript 仅由 Session Foundation 保存。",
  };
}

function createLocalSecretKey(storePath = "") {
  return createLocalSecretKeys(storePath)[0];
}

function createLocalSecretKeys(storePath = "") {
  const explicit = process.env.FEISHU_INTEGRATION_SECRET_KEY || process.env.FEISHU_ALGORITHM_SECRET_KEY || "";
  if (explicit) return [crypto.createHash("sha256").update(explicit).digest()];
  if (!storePath) return [crypto.randomBytes(32)];
  const keyPath = process.env.FEISHU_INTEGRATION_SECRET_KEY_PATH || path.join(path.dirname(storePath), ".feishu-integration-secret-key");
  try {
    if (fs.existsSync(keyPath)) {
      const rawMaterial = fs.readFileSync(keyPath, "utf8");
      const normalizedMaterial = rawMaterial.trim();
      const candidates = [
        crypto.createHash("sha256").update(normalizedMaterial).digest(),
        crypto.createHash("sha256").update(rawMaterial).digest(),
      ];
      return candidates.filter((candidate, index) =>
        candidates.findIndex((item) => item.equals(candidate)) === index
      );
    }
    fs.mkdirSync(path.dirname(keyPath), { recursive: true });
    const material = crypto.randomBytes(32).toString("base64");
    fs.writeFileSync(keyPath, `${material}\n`, { encoding: "utf8", mode: 0o600 });
    return [crypto.createHash("sha256").update(material).digest()];
  } catch {
    return [crypto.randomBytes(32)];
  }
}

function decryptWithSecretKeys(encrypted = {}, keys = []) {
  for (const key of keys) {
    const value = decryptVaultValue(encrypted, key);
    if (value) return value;
  }
  return "";
}

function encryptVaultValue(value = "", key) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const encrypted = Buffer.concat([cipher.update(String(value), "utf8"), cipher.final()]);
  return {
    alg: "aes-256-gcm",
    iv: iv.toString("base64"),
    tag: cipher.getAuthTag().toString("base64"),
    data: encrypted.toString("base64"),
  };
}

function decryptVaultValue(encrypted = {}, key) {
  try {
    if (!encrypted?.data || encrypted.alg !== "aes-256-gcm") return "";
    const decipher = crypto.createDecipheriv("aes-256-gcm", key, Buffer.from(encrypted.iv, "base64"));
    decipher.setAuthTag(Buffer.from(encrypted.tag, "base64"));
    return Buffer.concat([
      decipher.update(Buffer.from(encrypted.data, "base64")),
      decipher.final(),
    ]).toString("utf8");
  } catch {
    return "";
  }
}

function decryptFeishuEventPayload(encrypted = "", encryptKey = "") {
  const key = crypto.createHash("sha256").update(encryptKey).digest();
  const decipher = crypto.createDecipheriv("aes-256-cbc", key, key.subarray(0, 16));
  decipher.setAutoPadding(true);
  return Buffer.concat([
    decipher.update(Buffer.from(encrypted, "base64")),
    decipher.final(),
  ]).toString("utf8");
}

export {
  CONTRACT_VERSION,
  SOURCE_SYSTEM_ID,
  SOURCE_SYSTEM_NAME,
  EMPLOYEE_ID,
  ROOT_SKILL_ID,
  BUSINESS_DOMAIN,
  DEPARTMENT_ID,
  SAFE_SUMMARY,
  DEFAULT_CAPABILITIES,
  FORBIDDEN_MESSAGE_FIELDS,
  HIGH_RISK_ACTIONS,
  POST_APPROVAL_CHANNEL_ACTIONS,
  CHANNEL_INTENT_OPTIONS,
  MESSAGE_DELIVERY_OPTIONS,
  CONVERSATION_GATEWAY_BOUNDARY,
  FEISHU_TENANT_TOKEN_URL,
  FEISHU_REPLY_MESSAGE_URL,
  FEISHU_MESSAGE_REACTION_URL,
  FEISHU_EVENT_CALLBACK_PATH,
  LEGACY_FEISHU_EVENT_CALLBACK_PATH,
  DEFAULT_CONNECTION_MODE,
  CONNECTION_MODE_OPTIONS,
  CONNECTION_REQUIRED_FIELDS,
  CONNECTION_AUTOMATION_STEPS,
  RUNTIME_TASK_CONTRACT_VERSION,
  DEFAULT_RUNTIME_TASK_STATUS,
  DEFAULT_RESOURCE_MONITOR_STATUS,
  ALGORITHM_RUNTIME_RESOURCE_DEFS,
  MATERIAL_MESSAGE_TYPES,
  buildFeishuMessagePreview,
  channelIntentLabelText,
  isPendingStatus,
  isCancelableApplicationStatus,
  summarizeRequestedSkill,
  sanitizeRequestedSkills,
  createFeishuIntegrationStore,
  sanitizeApplication,
  sanitizeApplicationReviewDecision,
  sanitizeCardFeedback,
  sanitizeMessageTest,
  sanitizeRuntimeTask,
  sanitizeTaskTrigger,
  sanitizeMaterialRefs,
  sanitizeResourceMonitor,
  algorithmRuntimeResourceSetup,
  runtimeTaskStatusLabel,
  resourceStatusLabel,
  inferRuntimeTaskType,
  inferMaterialRefType,
  sanitizeConnection,
  connectionForSession,
  sanitizeTokenCheck,
  sanitizeEventSubscription,
  sanitizeAllowedChatRefs,
  sanitizeEventSummary,
  sanitizeDelivery,
  sanitizeWorkerBinding,
  sanitizeConnectionTestResult,
  sanitizeInvocationCheck,
  emptyStore,
  sortUpdatedDesc,
  storePersistenceNote,
  createLocalSecretKey,
  createLocalSecretKeys,
  encryptVaultValue,
  decryptVaultValue,
  decryptFeishuEventPayload,
  nextConnectionGate,
  nextUserConnectionGate,
  buildAdminConnectionDiagnostics,
  nextAdminConnectionGate,
  actorSummary,
  sanitizeActor,
  actorDisplay,
  actorDigest,
  chinaDate,
  hasPlatformGovernance,
  isHttpsUrl,
  isLocalCallbackUrl,
  normalizeConnectionMode,
  normalizeAllowedChatRefs,
  parseAllowedChatRef,
  inferFeishuChatRefType,
  maskIdentifier,
  digestValue,
  isPersonalScope,
  feishuWebhookUrl,
  hasUnsafeText,
  cleanText,
  cleanShortText,
  defaultCleanText,
  defaultCleanList,
  uniqueList,
};
