import { isDesktopTaskTerminalStatus } from "../../shared/desktop-task-timeline.mjs";
import { isDesktopMyTaskCancelableStatus } from "../../shared/desktop-my-tasks.mjs";

export const ASSISTANT_EMPLOYEE_ID = "enterprise-ai-copilot";

export function requireDesktopConversationHistoryApi(desktopApi) {
  if (!desktopApi) return null;
  if (typeof desktopApi.getConversationHistory !== "function") {
    const error = new Error("desktop_channel_contract_mismatch:getConversationHistory");
    error.code = "desktop_channel_contract_mismatch";
    throw error;
  }
  if (typeof desktopApi.getToolParameterCards !== "function") {
    const error = new Error("desktop_channel_contract_mismatch:getToolParameterCards");
    error.code = "desktop_channel_contract_mismatch";
    throw error;
  }
  if (typeof desktopApi.getArtifactDelivery !== "function" || typeof desktopApi.deliverArtifact !== "function") {
    const error = new Error("desktop_channel_contract_mismatch:artifactDelivery");
    error.code = "desktop_channel_contract_mismatch";
    throw error;
  }
  if (typeof desktopApi.saveReusableArtifact !== "function" || typeof desktopApi.listReusableArtifacts !== "function") {
    const error = new Error("desktop_channel_contract_mismatch:reusableArtifacts");
    error.code = "desktop_channel_contract_mismatch";
    throw error;
  }
  if (typeof desktopApi.followAssistantTask !== "function") {
    const error = new Error("desktop_channel_contract_mismatch:followAssistantTask");
    error.code = "desktop_channel_contract_mismatch";
    throw error;
  }
  if (typeof desktopApi.cancelAssistantTask !== "function") {
    const error = new Error("desktop_channel_contract_mismatch:cancelAssistantTask");
    error.code = "desktop_channel_contract_mismatch";
    throw error;
  }
  return desktopApi;
}

export function updateEmployeeConversation(conversations = {}, employeeId = "", updater, initialMessages = []) {
  if (!employeeId) return conversations;
  const currentMessages = Array.isArray(conversations[employeeId]) ? conversations[employeeId] : initialMessages;
  const nextMessages = typeof updater === "function" ? updater(currentMessages) : updater;
  if (!Array.isArray(nextMessages)) return conversations;
  return { ...conversations, [employeeId]: nextMessages };
}

export function mergeConversationHistory(historyMessages = [], currentMessages = []) {
  const history = Array.isArray(historyMessages) ? historyMessages : [];
  const current = Array.isArray(currentMessages) ? currentMessages : [];
  const mergedHistory = history.map((message) => ({ ...message }));
  const matchedHistoryIndexes = new Set();
  const unmatchedTaskPresentations = [];
  for (let currentIndex = current.length - 1; currentIndex >= 0; currentIndex -= 1) {
    const message = current[currentIndex];
    if (!hasTaskPresentation(message)) continue;
    const historyIndex = findHistoryTaskPresentationTarget(mergedHistory, message, matchedHistoryIndexes);
    if (historyIndex >= 0) {
      matchedHistoryIndexes.add(historyIndex);
      mergedHistory[historyIndex] = { ...mergedHistory[historyIndex], ...taskPresentationFields(message) };
    } else if (taskPresentationIsTerminal(message)) {
      unmatchedTaskPresentations.unshift(message);
    }
  }
  const historyTaskIds = new Set(mergedHistory.map((message) => String(message?.taskId || "")).filter(Boolean));
  const unmatchedPresentationIds = new Set(unmatchedTaskPresentations.map((message) => String(message?.id || "")).filter(Boolean));
  const localTerminalMessages = current.filter((message) => (
    (message?.localNotice === true && !unmatchedPresentationIds.has(String(message?.id || ""))) ||
    (message?.role === "assistant" && ["canceled", "error"].includes(message?.status) &&
      !unmatchedPresentationIds.has(String(message?.id || "")) &&
      (!message?.taskId || !historyTaskIds.has(String(message.taskId))))
  ));
  const historyIds = new Set(mergedHistory.map((message) => String(message?.id || "")).filter(Boolean));
  return sortConversationMessages([
    ...mergedHistory,
    ...unmatchedTaskPresentations.filter((message) => !historyIds.has(String(message?.id || ""))),
    ...localTerminalMessages.filter((message) => !historyIds.has(String(message?.id || ""))),
  ]);
}

function findHistoryTaskPresentationTarget(history, message, matchedIndexes) {
  const taskId = String(message?.taskId || "");
  const content = String(message?.content || "");
  for (let index = history.length - 1; index >= 0; index -= 1) {
    if (matchedIndexes.has(index) || history[index]?.role !== "assistant") continue;
    if (taskId && String(history[index]?.taskId || "") === taskId) return index;
    if (content && String(history[index]?.content || "") === content) return index;
  }
  return -1;
}

function hasTaskPresentation(message) {
  return message?.role === "assistant" && (message.taskEvents?.length > 0 || message.toolParameterCards?.length > 0 || message.toolConfirmations?.length > 0);
}

function taskPresentationFields(message) {
  return {
    taskId: String(message?.taskId || ""),
    ...(message.taskEvents ? { taskEvents: message.taskEvents } : {}),
    ...(message.toolParameterCards ? { toolParameterCards: message.toolParameterCards } : {}),
    ...(message.toolConfirmations ? { toolConfirmations: message.toolConfirmations } : {}),
    ...(message?.taskActivitySnapshot ? { taskActivitySnapshot: message.taskActivitySnapshot } : {}),
    ...(message?.taskProvenanceSnapshot ? { taskProvenanceSnapshot: message.taskProvenanceSnapshot } : {}),
    ...(message?.taskConnectionState ? { taskConnectionState: message.taskConnectionState } : {}),
    ...(message?.canonicalTaskStatus ? { canonicalTaskStatus: message.canonicalTaskStatus } : {}),
  };
}

function taskPresentationIsTerminal(message) {
  if (isDesktopTaskTerminalStatus(message?.canonicalTaskStatus)) return true;
  const stateEvent = [...(message.taskEvents || [])].reverse().find((event) => event?.eventType === "task.state_changed");
  return isDesktopTaskTerminalStatus(stateEvent?.data?.status) || (message.status === "done" && (message.toolParameterCards?.length > 0 || message.toolConfirmations?.length > 0));
}

export function mergeRecoveredToolParameterCards(messages = [], cards = [], { now = Date.now() } = {}) {
  const activeCards = Array.isArray(cards) ? cards : [];
  const activeIds = new Set(activeCards.map((card) => String(card?.id || "")).filter(Boolean));
  const activeById = new Map(activeCards.map(card => [String(card?.id || ""), card]));
  const current = (Array.isArray(messages) ? messages : []).map((message) => ({
    ...message,
    ...(Array.isArray(message?.toolParameterCards) ? {
      toolParameterCards: message.toolParameterCards.map((card) => (
        activeById.has(String(card?.id || ""))
          ? { ...activeById.get(card.id), ...(card.schemaDigest === activeById.get(card.id).schemaDigest && card.draftArguments ? { draftArguments: card.draftArguments } : {}) }
          : ["draft", "submitting", "submission_unknown"].includes(card?.status) && !activeIds.has(String(card?.id || "")) && Date.parse(String(card?.expiresAt || "")) > now
          ? { ...card, status: "superseded" }
          : card
      )),
    } : {}),
  }));
  const existingIds = new Set(current.flatMap((message) => (
    Array.isArray(message?.toolParameterCards) ? message.toolParameterCards : []
  )).map((card) => String(card?.id || "")).filter(Boolean));
  const recoveredMessages = activeCards.flatMap((card) => {
    const cardId = String(card?.id || "");
    const createdAt = validIsoTimestamp(card?.createdAt);
    const expiresAt = Date.parse(String(card?.expiresAt || ""));
    if (!cardId || existingIds.has(cardId) || !createdAt || !Number.isFinite(expiresAt) || expiresAt <= now) return [];
    existingIds.add(cardId);
    return [{
      id: `recovered-tool-parameter-${cardId}`,
      role: "assistant",
      content: "",
      cardRecovery: true,
      createdAt,
      localNotice: true,
      status: "done",
      toolParameterCards: [card],
    }];
  });
  return recoveredMessages.length ? sortConversationMessages([...current, ...recoveredMessages]) : current;
}

export function mergeRecoveredToolConfirmations(messages = [], confirmations = [], {now = Date.now()} = {}) {
  const pending = confirmations.filter(card => card?.contractVersion === "tool-call-confirmation.v1" && card.status === "pending" && Date.parse(card.expiresAt) > now);
  const byId = new Map(pending.map(card => [card.id,card]));
  const seen = new Set();
  const current = messages.map(message => ({...message,...(Array.isArray(message.toolConfirmations) ? {
    toolConfirmations:message.toolConfirmations.map(card => {
      seen.add(card.id);
      return byId.get(card.id) || (card.status === "pending" ? {...card,status:"superseded"} : card);
    }),
  } : {})}));
  const recovered = pending.filter(card => !seen.has(card.id)).map(card => ({id:`recovered-confirmation-${card.id}`,role:"assistant",content:"",localNotice:true,
    cardRecovery:true,status:"done",createdAt:card.issuedAt,toolConfirmations:[card]}));
  return sortConversationMessages([...current,...recovered]);
}

export function employeeRuntimeState(employee = {}) {
  if (employee.access?.callable === false) return { label: "未上线", tone: "muted" };
  const evidence = employee.runtimeEvidence || {};
  const statuses = [evidence.healthStatus, evidence.modelStatus, evidence.runtimeStatus];
  const passed = statuses.some((value) => ["passed", "healthy", "agent_reply_sent", "completed"].includes(value));
  const failed = statuses.some((value) => ["failed", "blocked", "offline", "send_failed"].includes(value));
  if (failed) return { label: "运行受限", tone: "danger" };
  if (passed) return { label: "可对话", tone: "good" };
  return { label: "可对话", tone: "warn" };
}

export function desktopUpdatePresentation(update = {}) {
  if (update.status === "installing") {
    return { active: true, phase: "installing", label: "正在安装", percent: 100 };
  }
  if (update.status !== "downloading") {
    return { active: false, phase: "idle", label: "", percent: 0 };
  }
  const percent = Number(update.downloadPercent);
  return {
    active: true,
    phase: "downloading",
    label: "正在更新",
    percent: Number.isFinite(percent) ? Math.min(100, Math.max(0, Math.round(percent))) : 0,
  };
}

export function desktopUnsignedUpdateAction(update = {}) {
  if (!update.canDownload) return "";
  if (update.status === "downloaded") return "open";
  if (["available", "mandatory_pending", "deferred", "downloading"].includes(update.status)) return "download";
  return "";
}

export function desktopUpdateStateTitle(state = {}) {
  const update = state.update || {};
  const signal = state.signal || {};
  if (["available", "mandatory_pending", "deferred"].includes(update.status) && update.targetVersion) {
    return `桌面版 ${update.targetVersion} ${update.mandatory ? "待处理" : "可更新"}；点击重新检查`;
  }
  if (update.status === "up_to_date") return `桌面版 ${update.currentVersion || "当前版本"} 已是最新；点击重新检查`;
  if (update.status === "checking") return "正在检查桌面版更新";
  if (signal.status === "connected") return "更新推送已连接；点击手动检查";
  if (update.status === "disabled") return "桌面更新策略尚未启用";
  return "更新服务暂不可用；点击重试";
}

export function desktopConversationHistoryReady({ authenticated, bootstrapRevision, employeeId, sending }) {
  return authenticated === true
    && Number(bootstrapRevision) > 0
    && Boolean(String(employeeId || "").trim())
    && sending !== true;
}

export function shouldRecoverConversationTask(message = null, task = null) {
  const messageTaskId = String(message?.taskId || "");
  return Boolean(
    message?.role === "assistant" &&
    messageTaskId &&
    !message?.taskEvents?.length &&
    String(task?.id || "") === messageTaskId &&
    isDesktopMyTaskCancelableStatus(task?.status),
  );
}

export function dataflowCredentialPresentation(tool = null, state = {}) {
  const visible = tool?.id === "dataflow-rest-api" && tool?.credentialMode === "device_session_refresh";
  if (!visible) return { visible: false, ready: false, message: "", actionLabel: "" };
  const ready = state.status === "ready";
  if (ready) {
    return {
      visible: true,
      ready: true,
      message: "企业登录已连接 · 自动续期",
      actionLabel: "退出",
    };
  }
  if (state.configured === false || state.status === "not_configured") {
    return {
      visible: true,
      ready: false,
      message: "企业登录自动续期 · 当前环境尚未配置",
      actionLabel: "连接 DataFlow",
    };
  }
  if (state.transportReady === false) {
    return {
      visible: true,
      ready: false,
      message: "企业登录自动续期 · 中心安全连接暂不可用",
      actionLabel: "连接 DataFlow",
    };
  }
  return {
    visible: true,
    ready: false,
    message: "企业登录自动续期 · 需要连接 DataFlow",
    actionLabel: "连接 DataFlow",
  };
}

export function manualCredentialToolFor(tools = []) {
  if (!Array.isArray(tools)) return null;
  return tools.find((tool) => (
    tool?.temporaryCredentialRequired === true && tool?.credentialMode === "current_user_bearer"
  )) || null;
}

export function nextCollapsedPetEmployeeId({
  authenticated = false,
  currentPetEmployeeId = "",
  employees = [],
  hasRegisteredCharacter = () => true,
  selectedEmployeeId = "",
} = {}) {
  if (!authenticated || !Array.isArray(employees)) return "";
  const employeeById = new Map(employees.map((employee) => [employee?.id, employee]));
  const selectedEmployee = employeeById.get(selectedEmployeeId);
  if (collapsedPetEmployeeEligible(selectedEmployee, hasRegisteredCharacter)) return selectedEmployee.id;
  const currentPetEmployee = employeeById.get(currentPetEmployeeId);
  if (collapsedPetEmployeeEligible(currentPetEmployee, hasRegisteredCharacter)) return currentPetEmployee.id;
  return "";
}

export function describeEmployeeCatalogChanges(previousEmployees = [], nextEmployees = []) {
  if (!previousEmployees.length) return "员工列表已更新";
  const previousById = new Map(previousEmployees.map((employee) => [employee.id, employee]));
  const newlyAvailable = nextEmployees.filter((employee) => (
    employee.access?.selectable === true && previousById.get(employee.id)?.access?.selectable !== true
  ));
  if (newlyAvailable.length) return `新增 ${newlyAvailable.length} 位可用数字员工`;

  const nextIds = new Set(nextEmployees.map((employee) => employee.id));
  const changedCount = nextEmployees.filter((employee) => (
    catalogEmployeeSignature(previousById.get(employee.id)) !== catalogEmployeeSignature(employee)
  )).length + previousEmployees.filter((employee) => !nextIds.has(employee.id)).length;
  return changedCount ? `${changedCount} 位数字员工状态已更新` : "已是最新";
}

export function parseSseBody(body) {
  const result = {
    text: "",
    error: "",
    errorCode: "",
    taskId: "",
    taskStatus: "",
    toolConfirmations: [],
    toolParameterCards: [],
  };
  const blocks = String(body || "").replace(/\r\n/g, "\n").split("\n\n");
  for (const block of blocks) {
    let eventName = "message";
    const dataLines = [];
    for (const line of block.split("\n")) {
      if (line.startsWith("event:")) eventName = line.slice(6).trim();
      if (line.startsWith("data:")) dataLines.push(line.slice(5).trim());
    }
    if (!dataLines.length) continue;
    let data;
    try {
      data = JSON.parse(dataLines.join("\n"));
    } catch {
      continue;
    }
    if (eventName === "delta") result.text += data.text || "";
    if (eventName === "meta") {
      result.taskId = cleanRuntimeTaskId(data.taskId) || result.taskId;
      result.taskStatus = cleanRuntimeTaskStatus(data.taskStatus) || result.taskStatus;
    }
    if (eventName === "error") {
      result.errorCode = cleanRuntimeErrorCode(data.code) || "runtime_task_failed";
      result.error = data.message || desktopRuntimeTaskErrorMessage(result.errorCode);
    }
    if (eventName === "done") {
      result.taskId = cleanRuntimeTaskId(data.runtimeTask?.id) || result.taskId;
      result.taskStatus = cleanRuntimeTaskStatus(data.runtimeTask?.status) || result.taskStatus;
    }
    if (eventName === "done" && Array.isArray(data.toolConfirmations)) {
      result.toolConfirmations = data.toolConfirmations.filter((item) => (
        item?.contractVersion === "tool-call-confirmation.v1" && typeof item.id === "string" && item.id
      )).slice(0, 8);
    }
    if (eventName === "done" && Array.isArray(data.toolParameterCards)) {
      result.toolParameterCards = data.toolParameterCards.filter((item) => (
        item?.contractVersion === "tool-parameter-card.v2" && typeof item.id === "string" && item.id
      )).slice(0, 4);
    }
  }
  return result;
}

export function desktopRuntimeTaskErrorMessage(code = "") {
  if (code === "model_provider_unavailable") return "模型服务暂时不可用，本次任务未完成。";
  if (code === "model_rate_limited") return "模型服务当前繁忙，本次任务未完成。";
  if (code === "provider_connect_timeout") return "模型服务连接超时，请稍后重试。";
  if (["provider_first_semantic_output_timeout", "provider_request_total_timeout", "runtime_task_timed_out"].includes(code)) {
    return "模型服务响应超时，请稍后重试。";
  }
  if (code === "provider_stream_idle_timeout") return "模型回复中断，请重新发送。";
  if (["current_actor_revalidation_failed", "execution_task_identity_revalidation_failed"].includes(code)) {
    return "企业身份暂时无法重新确认，请刷新登录状态后重试。";
  }
  return "任务执行失败，请稍后重试。";
}

export function desktopRuntimeTaskFailure({ code = "", status = "", taskId = "" } = {}) {
  const safeCode = cleanRuntimeErrorCode(code) || statusFailureCode(status);
  const safeStatus = cleanRuntimeTaskStatus(status);
  const definitions = {
    model_provider_unavailable: {
      title: "模型服务暂时不可用",
      message: "本次任务已经结束，请稍后重新发起任务。",
      retryable: true,
    },
    model_rate_limited: {
      title: "模型服务当前繁忙",
      message: "当前模型请求较多，请稍后重新发起任务。",
      retryable: true,
    },
    provider_connect_timeout: {
      title: "连接模型服务超时",
      message: "未获得模型连接，请检查公司网络后重新发起任务。",
      retryable: true,
    },
    provider_first_semantic_output_timeout: {
      title: "模型响应超时",
      message: "任务未获得有效输出，请稍后重新发起任务。",
      retryable: true,
    },
    provider_request_total_timeout: {
      title: "模型响应超时",
      message: "模型请求超过最长等待时间，请稍后重新发起任务。",
      retryable: true,
    },
    provider_stream_idle_timeout: {
      title: "模型回复中断",
      message: "回复传输长时间没有更新，请重新发起任务。",
      retryable: true,
    },
    execution_task_identity_revalidation_failed: {
      title: "企业身份需要重新确认",
      message: "任务恢复时无法重新确认当前身份，请刷新登录状态后重试。",
      retryable: false,
    },
    current_actor_revalidation_failed: {
      title: "企业身份需要重新确认",
      message: "当前登录状态无法通过校验，请重新登录后再发起任务。",
      retryable: false,
    },
    runtime_task_blocked: {
      title: "任务被运行门禁阻断",
      message: "当前任务未通过安全或运行条件，请根据管理端状态处理。",
      retryable: false,
    },
    runtime_task_canceled: {
      title: "任务已停止",
      message: "停止请求已由中心任务状态确认，本任务不会继续产生结果。",
      retryable: false,
    },
    runtime_task_timed_out: {
      title: "任务执行超时",
      message: "任务已到达最长执行时间，请稍后重新发起任务。",
      retryable: true,
    },
  };
  const definition = definitions[safeCode] || {
    title: safeStatus === "timed_out" ? "任务执行超时" : "任务未完成",
    message: desktopRuntimeTaskErrorMessage(safeCode),
    retryable: false,
  };
  return Object.freeze({
    contractVersion: "desktop-task-failure.v1",
    code: safeCode,
    message: definition.message,
    retryable: definition.retryable,
    status: safeStatus || "failed",
    taskId: cleanRuntimeTaskId(taskId),
    title: definition.title,
  });
}

export function cleanDisplayText(value) {
  return String(value || "").replace(/[_-]+/g, " ").slice(0, 180);
}

function catalogEmployeeSignature(employee = {}) {
  return JSON.stringify([
    employee.id || "",
    employee.version || "",
    employee.status || "",
    employee.access?.entitled === true,
    employee.access?.requestable === true,
    employee.access?.selectable === true,
    employee.access?.reasonCode || "",
    employee.character?.assetRevision || "",
  ]);
}

function collapsedPetEmployeeEligible(employee = null, hasRegisteredCharacter = () => true) {
  return Boolean(
    employee?.id &&
    employee.access?.selectable === true &&
    employee.access?.callable === true &&
    hasRegisteredCharacter(employee),
  );
}

function cleanRuntimeErrorCode(value) {
  const code = String(value || "").trim();
  return /^[a-z0-9._:-]{1,120}$/.test(code) ? code : "";
}

function cleanRuntimeTaskId(value) {
  const taskId = String(value || "").trim();
  return /^[a-zA-Z0-9_.:-]{1,128}$/.test(taskId) ? taskId : "";
}

function cleanRuntimeTaskStatus(value) {
  const status = String(value || "").trim();
  return ["blocked", "canceled", "completed", "failed", "lost", "queued", "rejected", "running", "submitted", "timed_out", "waiting"].includes(status)
    ? status
    : "";
}

function statusFailureCode(status) {
  return {
    blocked: "runtime_task_blocked",
    canceled: "runtime_task_canceled",
    failed: "runtime_task_failed",
    lost: "runtime_task_lost",
    rejected: "runtime_task_rejected",
    timed_out: "runtime_task_timed_out",
  }[cleanRuntimeTaskStatus(status)] || "runtime_task_failed";
}

function sortConversationMessages(messages = []) {
  return messages.map((message, index) => ({ message, index })).sort((left, right) => {
    const leftTime = Date.parse(String(left.message?.createdAt || ""));
    const rightTime = Date.parse(String(right.message?.createdAt || ""));
    const safeLeftTime = Number.isFinite(leftTime) ? leftTime : Number.POSITIVE_INFINITY;
    const safeRightTime = Number.isFinite(rightTime) ? rightTime : Number.POSITIVE_INFINITY;
    return safeLeftTime - safeRightTime || left.index - right.index;
  }).map(({ message }) => message);
}

function validIsoTimestamp(value) {
  const time = Date.parse(String(value || ""));
  return Number.isFinite(time) ? new Date(time).toISOString() : "";
}
