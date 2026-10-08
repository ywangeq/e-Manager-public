import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const STORE_VERSION = "digital-employee-runtime-events.v1";
const CONTRACT_VERSION = "digital-employee-runtime-event.v1";
const MAX_EVENTS = 10000;
const WINDOW_WEEKS = 13;
const ALLOWED_EVENT_TYPES = new Set(["task_call"]);
const ALLOWED_OUTCOMES = new Set(["completed", "blocked", "failed"]);

export function createDigitalEmployeeRuntimeEventStore({
  executionTaskRepository = null,
  projectRoot = process.cwd(),
  storePath,
  tenantScope = "",
  hashSalt = "digital-workforce-mvp-runtime-events",
  redactError = (error) => String(error?.message || error),
  resolveEmployeeIdentity = defaultEmployeeIdentity,
} = {}) {
  function canonicalEmployeeId(value = "") {
    const identity = resolveEmployeeIdentity(value);
    const canonical = cleanStableId(identity?.canonicalEmployeeId);
    return canonical || cleanStableId(value);
  }

  function recordTaskCallEvent(input = {}, session = null) {
    const event = sanitizeRuntimeEvent({
      ...input,
      employeeId: canonicalEmployeeId(input.employeeId),
      eventType: "task_call",
    }, session);
    if (!event) return null;
    const store = readStore();
    store.events.push(event);
    store.events = store.events.slice(-MAX_EVENTS);
    store.updatedAt = event.occurredAt;
    writeStore(store);
    return event;
  }

  function buildEmployeeRuntimeUsage(employeeId, options = {}) {
    const canonicalId = canonicalEmployeeId(employeeId);
    const events = employeeCompletedEvents(readStore().events, canonicalId, options);
    const eventUsage = buildRuntimeUsage(events, options);
    const canonicalUsage = canonicalUsageByEmployee().get(canonicalId);
    return canonicalUsage ? applyCanonicalUsage(eventUsage, canonicalUsage) : eventUsage;
  }

  function withRuntimeUsage(employees = [], options = {}) {
    const store = readStore();
    const eventsByEmployee = groupCompletedEventsByEmployee(store.events, options);
    const canonicalByEmployee = canonicalUsageByEmployee();
    return employees.map((employee) => {
      const events = eventsByEmployee.get(cleanStableId(employee.id)) || [];
      const eventUsage = buildRuntimeUsage(events, options);
      const canonicalUsage = canonicalByEmployee.get(cleanStableId(employee.id));
      if (!events.length && !canonicalUsage) return employee;
      const compatibleUsage = mergeRuntimeUsage(employee.runtimeUsage, eventUsage);
      const runtimeUsage = canonicalUsage
        ? applyCanonicalUsage(compatibleUsage, canonicalUsage)
        : compatibleUsage;
      const runtimeEvidence = mergeRuntimeEvidence(employee.runtimeEvidence, runtimeUsage, eventUsage, employee.id);
      return {
        ...employee,
        runtimeEvidence: canonicalUsage
          ? { ...runtimeEvidence, usageCountSource: "canonical_execution_task" }
          : runtimeEvidence,
        runtimeUsage,
      };
    });
  }

  function canonicalUsageByEmployee(employeeId = null) {
    if (!tenantScope || typeof executionTaskRepository?.summarizeUsageByEmployee !== "function") return new Map();
    try {
      const requestedCanonicalId = employeeId ? canonicalEmployeeId(employeeId) : "";
      const grouped = new Map();
      for (const summary of executionTaskRepository.summarizeUsageByEmployee({ tenantScope })) {
        const canonicalId = canonicalEmployeeId(summary.employeeId);
        if (requestedCanonicalId && canonicalId !== requestedCanonicalId) continue;
        const existing = grouped.get(canonicalId) || {
          employeeId: canonicalId,
          totalTasks: 0,
          completedTasks: 0,
          triggerCompletedTasks: 0,
          nonTriggerCompletedTasks: 0,
          updatedAt: "",
        };
        grouped.set(canonicalId, {
          ...existing,
          totalTasks: existing.totalTasks + summary.totalTasks,
          completedTasks: existing.completedTasks + summary.completedTasks,
          triggerCompletedTasks: existing.triggerCompletedTasks + summary.triggerCompletedTasks,
          nonTriggerCompletedTasks: existing.nonTriggerCompletedTasks + summary.nonTriggerCompletedTasks,
          updatedAt: latestTextTime(existing.updatedAt, summary.updatedAt),
        });
      }
      return grouped;
    } catch (error) {
      console.warn("[digital-employee-runtime-events] canonical usage unavailable:", redactError(error));
      return new Map();
    }
  }

  function readEvents() {
    return readStore().events;
  }

  function listEmployeeRuntimeTasks(employeeId, options = {}) {
    const targetEmployeeId = canonicalEmployeeId(employeeId);
    const limit = Math.min(500, Math.max(1, Number(options.limit) || 200));
    if (!targetEmployeeId) return [];
    return readStore().events
      .filter((event) => cleanStableId(event.employeeId) === targetEmployeeId)
      .sort((left, right) => String(right.occurredAt).localeCompare(String(left.occurredAt)))
      .slice(0, limit)
      .map(projectRuntimeTask);
  }

  function readStore() {
    try {
      if (!storePath || !fs.existsSync(storePath)) return emptyStore();
      const raw = fs.readFileSync(storePath, "utf8");
      if (!raw.trim()) return emptyStore();
      const parsed = JSON.parse(raw);
      return {
        version: STORE_VERSION,
        createdAt: cleanShortText(parsed.createdAt),
        updatedAt: cleanShortText(parsed.updatedAt),
        events: Array.isArray(parsed.events)
          ? parsed.events.map(sanitizeStoredEvent).filter(Boolean).map((event) => ({
              ...event,
              employeeId: canonicalEmployeeId(event.employeeId),
            })).slice(-MAX_EVENTS)
          : [],
      };
    } catch (error) {
      console.warn("[digital-employee-runtime-events] failed to read store:", redactError(error));
      return emptyStore();
    }
  }

  function writeStore(store) {
    if (!storePath) return;
    try {
      fs.mkdirSync(path.dirname(storePath), { recursive: true });
      fs.writeFileSync(storePath, `${JSON.stringify(store, null, 2)}\n`, "utf8");
    } catch (error) {
      console.warn("[digital-employee-runtime-events] failed to write store:", redactError(error));
    }
  }

  function emptyStore() {
    const now = new Date().toISOString();
    return { version: STORE_VERSION, createdAt: now, updatedAt: "", events: [] };
  }

  function sanitizeRuntimeEvent(input = {}, session = null) {
    const employeeId = cleanStableId(input.employeeId);
    if (!employeeId) return null;
    const eventType = cleanShortText(input.eventType || "task_call");
    const outcome = normalizeOutcome(input.outcome || input.status || "completed");
    if (!ALLOWED_EVENT_TYPES.has(eventType) || !ALLOWED_OUTCOMES.has(outcome)) return null;
    const occurredAt = normalizeTime(input.occurredAt) || new Date().toISOString();
    return {
      id: cleanStableId(input.id) || `DERT-${Date.now()}-${crypto.randomBytes(4).toString("hex")}`,
      contractVersion: CONTRACT_VERSION,
      employeeId,
      employeeName: cleanShortText(input.employeeName),
      eventType,
      outcome,
      taskType: cleanShortText(input.taskType || "runtime_task"),
      sourceSystemId: cleanStableId(input.sourceSystemId || "digital-workforce-management"),
      channelId: cleanStableId(input.channelId || input.channel || "management_console"),
      entrypoint: cleanStableId(input.entrypoint || input.runtimeEntrypoint || ""),
      occurredAt,
      actorKey: actorHash(session, input),
      actorDepartmentId: cleanStableId(session?.departmentId || input.actorDepartmentId || ""),
      actorRole: cleanShortText(session?.role || input.actorRole || ""),
      model: cleanShortText(input.model),
      reasoningEffort: cleanStableId(input.reasoningEffort),
      runtimeAdapter: cleanStableId(input.runtimeAdapter),
      reasonCode: cleanStableId(input.reasonCode),
    };
  }

  function sanitizeStoredEvent(event = {}) {
    const employeeId = cleanStableId(event.employeeId);
    const eventType = cleanShortText(event.eventType);
    const outcome = normalizeOutcome(event.outcome);
    const occurredAt = normalizeTime(event.occurredAt);
    if (!employeeId || !occurredAt || !ALLOWED_EVENT_TYPES.has(eventType) || !ALLOWED_OUTCOMES.has(outcome)) return null;
    return {
      id: cleanStableId(event.id || `${employeeId}-${occurredAt}`),
      contractVersion: CONTRACT_VERSION,
      employeeId,
      employeeName: cleanShortText(event.employeeName),
      eventType,
      outcome,
      taskType: cleanShortText(event.taskType || "runtime_task"),
      sourceSystemId: cleanStableId(event.sourceSystemId || "digital-workforce-management"),
      channelId: cleanStableId(event.channelId || "management_console"),
      entrypoint: cleanStableId(event.entrypoint),
      occurredAt,
      actorKey: cleanStableId(event.actorKey),
      actorDepartmentId: cleanStableId(event.actorDepartmentId),
      actorRole: cleanShortText(event.actorRole),
      model: cleanShortText(event.model),
      reasoningEffort: cleanStableId(event.reasoningEffort),
      runtimeAdapter: cleanStableId(event.runtimeAdapter),
      reasonCode: cleanStableId(event.reasonCode),
    };
  }

  function actorHash(session = null, input = {}) {
    const raw = cleanShortText(
      session?.employeeId ||
      session?.feishuUserId ||
      session?.employeeNo ||
      session?.email ||
      input.actorId ||
      input.actorKey ||
      input.sourceActorId
    );
    if (!raw) return "";
    return crypto.createHash("sha256").update(`${hashSalt}:${raw}`).digest("hex").slice(0, 16);
  }

  function coveragePath() {
    return storePath ? path.relative(projectRoot, storePath) : "";
  }

  return {
    buildEmployeeRuntimeUsage,
    coveragePath,
    listEmployeeRuntimeTasks,
    readEvents,
    recordTaskCallEvent,
    withRuntimeUsage,
  };
}

function defaultEmployeeIdentity(employeeId = "") {
  const canonicalEmployeeId = cleanStableId(employeeId);
  return canonicalEmployeeId ? { canonicalEmployeeId, readEmployeeIds: [canonicalEmployeeId] } : null;
}

function projectRuntimeTask(event = {}) {
  const completed = event.outcome === "completed";
  const failed = event.outcome === "failed";
  const channelLabel = event.channelId === "desktop" ? "桌面端" : event.channelId === "management_console" ? "管理台" : event.channelId || "受控入口";
  const resultSummary = completed
    ? `${channelLabel}数字员工回合已完成。`
    : failed
      ? `${channelLabel}数字员工回合未完成，等待复盘。`
      : `${channelLabel}数字员工回合在模型调用前被阻断。`;
  return {
    id: event.id,
    contractVersion: "digital-employee-runtime-task.v1",
    employeeId: event.employeeId,
    employeeName: event.employeeName,
    taskTitle: `${event.employeeName || "数字员工"}对话`,
    taskType: event.taskType || "digital_employee_chat",
    problemSummary: "已记录一次数字员工调用；用户原话和回复正文未保存。",
    turnIntent: "conversation",
    responsePolicy: { id: "session-agent-loop.v2", mode: "runtime" },
    status: event.outcome,
    statusLabel: completed ? "已完成" : failed ? "失败" : "未执行",
    submittedAt: event.occurredAt,
    updatedAt: event.occurredAt,
    trigger: {
      channel: event.channelId,
      receivedAt: event.occurredAt,
      receiveMode: event.entrypoint,
    },
    submittedBy: { name: "姓名待解析" },
    runtimeAdapter: event.runtimeAdapter,
    invocationCheck: event.reasonCode ? { reason: event.reasonCode, nextGate: runtimeTaskNextGate(event) } : {},
    execution: {
      status: event.outcome,
      resultSummary,
      agentRuntime: {
        adapter: event.runtimeAdapter,
        mode: "managed_digital_employee_chat",
        model: event.model,
        reasoningEffort: event.reasoningEffort,
        realModelRequested: Boolean(event.model) && event.reasonCode !== "provider_connection_lease_missing",
        requestCount: event.model ? 1 : 0,
        status: completed ? "model_response_completed" : failed ? "model_request_failed" : "blocked_before_model_request",
        toolCallCount: 0,
        blockedReason: event.reasonCode,
      },
    },
    nextGate: runtimeTaskNextGate(event),
  };
}

function runtimeTaskNextGate(event = {}) {
  if (event.outcome === "completed") return "本轮已完成；如需执行外部动作，下一轮仍需独立 Tool 授权。";
  if (event.reasonCode === "provider_connection_lease_missing") return "请检查该员工的 Provider Route、Credential 和运行租约。";
  if (event.outcome === "failed") return "请检查安全错误分类和 Provider/Runtime 状态，必要时转入 badcase。";
  return "请补齐员工状态、调用权限或运行配置后重试。";
}

function groupCompletedEventsByEmployee(events = [], options = {}) {
  const grouped = new Map();
  for (const event of events) {
    if (!isIncludedCompletedEvent(event, options)) continue;
    const employeeId = cleanStableId(event.employeeId);
    if (!grouped.has(employeeId)) grouped.set(employeeId, []);
    grouped.get(employeeId).push(event);
  }
  return grouped;
}

function employeeCompletedEvents(events = [], employeeId = "", options = {}) {
  const targetEmployeeId = cleanStableId(employeeId);
  if (!targetEmployeeId) return [];
  return events.filter((event) => cleanStableId(event.employeeId) === targetEmployeeId && isIncludedCompletedEvent(event, options));
}

function isIncludedCompletedEvent(event = {}, options = {}) {
  if (event.eventType !== "task_call" || event.outcome !== "completed") return false;
  const occurredAt = new Date(event.occurredAt);
  if (Number.isNaN(occurredAt.getTime())) return false;
  const now = options.now instanceof Date ? options.now : new Date();
  const startDate = startOfDay(addDays(now, -(WINDOW_WEEKS * 7 - 1)));
  return occurredAt >= startDate && occurredAt <= addDays(now, 1);
}

function buildRuntimeUsage(events = [], options = {}) {
  const sortedEvents = [...events].sort((left, right) => String(right.occurredAt).localeCompare(String(left.occurredAt)));
  const dates = sortedEvents.map((event) => event.occurredAt).filter(Boolean);
  const desktopEvents = sortedEvents.filter(isDesktopEvent);
  const companionDays = new Set(dates.map((value) => value.slice(0, 10)).filter(Boolean)).size || undefined;
  const conversationEvents = sortedEvents.filter(isConversationEvent);
  return {
    source: "digital_employee_task_events",
    sourceLabel: "任务调用事件",
    windowLabel: "近 12 周",
    companionDays,
    recentMessages: conversationEvents.length || undefined,
    completedTasks: sortedEvents.length || undefined,
    taskCallEvents: sortedEvents.length,
    desktopUserCount: desktopEvents.every((event) => event.actorKey)
      ? new Set(desktopEvents.map((event) => event.actorKey)).size
      : undefined,
    updatedAt: dates[0] || "",
    dailyActivity: activityGridFromEvents(sortedEvents, options.now instanceof Date ? options.now : new Date()),
    privacyBoundary: "Only task-call metadata is counted. Raw prompts, replies, model traces, execution payloads, customer data, credentials, and employee PII are not stored.",
  };
}

function mergeRuntimeUsage(existing = null, eventUsage = {}) {
  if (!existing || typeof existing !== "object") return eventUsage;
  const recentMessages = addOptionalNumbers(existing.recentMessages ?? existing.messages ?? existing.messageCount, eventUsage.recentMessages);
  const completedTasks = addOptionalNumbers(existing.completedTasks ?? existing.tasks ?? existing.taskCount, eventUsage.completedTasks);
  return {
    ...existing,
    source: "merged_runtime_usage",
    sourceLabel: existing.sourceLabel && eventUsage.sourceLabel
      ? `${existing.sourceLabel} + ${eventUsage.sourceLabel}`
      : existing.sourceLabel || eventUsage.sourceLabel,
    windowLabel: existing.windowLabel || eventUsage.windowLabel,
    companionDays: Math.max(numberOrZero(existing.companionDays), numberOrZero(eventUsage.companionDays)) || undefined,
    recentMessages,
    completedTasks,
    taskCallEvents: addOptionalNumbers(existing.taskCallEvents, eventUsage.taskCallEvents),
    desktopUserCount: eventUsage.desktopUserCount,
    updatedAt: latestTextTime(existing.updatedAt || existing.lastUpdatedAt, eventUsage.updatedAt),
    dailyActivity: mergeDailyActivity(existing.dailyActivity || existing.activityGrid || existing.activityHeatmap || existing.heatmap, eventUsage.dailyActivity),
    privacyBoundary: eventUsage.privacyBoundary || existing.privacyBoundary,
  };
}

function applyCanonicalUsage(compatibleUsage = {}, canonicalUsage = {}) {
  return {
    ...compatibleUsage,
    source: "canonical_execution_task",
    sourceLabel: compatibleUsage.taskCallEvents
      ? "Canonical execution-task + 任务调用活动"
      : "Canonical execution-task",
    completedTasks: canonicalUsage.completedTasks,
    triggerCompletedTasks: canonicalUsage.triggerCompletedTasks,
    nonTriggerCompletedTasks: canonicalUsage.nonTriggerCompletedTasks,
    totalTasks: canonicalUsage.totalTasks,
    canonicalTaskCount: canonicalUsage.totalTasks,
    updatedAt: latestTextTime(compatibleUsage.updatedAt, canonicalUsage.updatedAt),
    countsBoundary: "Completed and total task counts come from the canonical execution-task repository. Legacy task-call events are activity-only compatibility data and are never added to canonical counts.",
  };
}

function mergeRuntimeEvidence(existing = null, runtimeUsage = {}, eventUsage = {}, employeeId = "") {
  const base = existing && typeof existing === "object" ? existing : {};
  return {
    ...base,
    employeeId: base.employeeId || cleanStableId(employeeId),
    statusSource: base.statusSource || "task_call_event",
    healthStatus: base.healthStatus || "passed",
    modelStatus: base.modelStatus || "passed",
    runtimeStatus: base.runtimeStatus || "task_call_completed",
    evidenceType: base.evidenceType || "runtime_task_call",
    evidenceLabel: base.evidenceLabel || "已记录数字员工任务调用事件",
    testedAt: base.testedAt || eventUsage.updatedAt || "",
    lastSuccessfulConversationAt: base.lastSuccessfulConversationAt || eventUsage.updatedAt || "",
    runtimeUsage,
  };
}

function isConversationEvent(event = {}) {
  const text = `${event.taskType || ""} ${event.channelId || ""} ${event.entrypoint || ""}`.toLowerCase();
  return /chat|conversation|message|feishu|management_console/.test(text);
}

function activityGridFromEvents(events = [], now = new Date()) {
  const latestWeekIndex = WINDOW_WEEKS - 1;
  const values = new Map();
  for (const event of events) {
    const date = new Date(event.occurredAt);
    if (Number.isNaN(date.getTime())) continue;
    const diffDays = Math.floor((startOfDay(now).getTime() - startOfDay(date).getTime()) / 86_400_000);
    if (diffDays < 0 || diffDays >= WINDOW_WEEKS * 7) continue;
    const dayIndex = date.getDay();
    const weekIndex = latestWeekIndex - Math.floor(diffDays / 7);
    const key = `${dayIndex}:${weekIndex}`;
    const current = values.get(key) || { dayIndex, weekIndex, count: 0, desktopCount: 0, nonDesktopCount: 0 };
    current.count += 1;
    if (isDesktopEvent(event)) current.desktopCount += 1;
    else current.nonDesktopCount += 1;
    values.set(key, current);
  }
  return [...values.values()].map(withActivitySource);
}

function mergeDailyActivity(left = [], right = []) {
  const values = new Map();
  for (const item of [...normalizeActivityItems(left), ...normalizeActivityItems(right)]) {
    const key = `${item.dayIndex}:${item.weekIndex}`;
    values.set(key, {
      dayIndex: item.dayIndex,
      weekIndex: item.weekIndex,
      count: (values.get(key)?.count || 0) + item.count,
      desktopCount: (values.get(key)?.desktopCount || 0) + item.desktopCount,
      nonDesktopCount: (values.get(key)?.nonDesktopCount || 0) + item.nonDesktopCount,
      unknownCount: (values.get(key)?.unknownCount || 0) + item.unknownCount,
    });
  }
  return [...values.values()].map(withActivitySource);
}

function normalizeActivityItems(value = []) {
  if (!Array.isArray(value)) return [];
  if (Array.isArray(value[0])) {
    return value.flatMap((row, dayIndex) =>
      Array.isArray(row)
        ? row.map((count, weekIndex) => normalizeActivityItem({ dayIndex, weekIndex, count })).filter((item) => item.count > 0)
        : []
    );
  }
  return value.map((item) => normalizeActivityItem(item)).filter((item) =>
    Number.isInteger(item.dayIndex) &&
    Number.isInteger(item.weekIndex) &&
    item.dayIndex >= 0 &&
    item.dayIndex <= 6 &&
    item.weekIndex >= 0 &&
    item.weekIndex < WINDOW_WEEKS &&
    item.count > 0
  );
}

function normalizeActivityItem(item = {}) {
  const count = numberOrZero(item.count ?? item.level ?? item.value);
  const channelId = cleanStableId(item.channelId).toLowerCase();
  const source = cleanStableId(item.source || item.channelGroup).toLowerCase();
  let desktopCount = numberOrZero(item.desktopCount);
  let nonDesktopCount = numberOrZero(item.nonDesktopCount);
  if (!desktopCount && !nonDesktopCount) {
    if (channelId === "desktop" || source === "desktop") desktopCount = count;
    else if (channelId || ["non_desktop", "non-desktop", "web", "management_console"].includes(source)) nonDesktopCount = count;
    if (source === "mixed") {
      desktopCount = count;
      nonDesktopCount = count;
    }
  }
  return {
    dayIndex: Number(item.dayIndex ?? item.dayOfWeek ?? item.weekday),
    weekIndex: Number(item.weekIndex ?? item.week),
    count,
    desktopCount,
    nonDesktopCount,
    unknownCount: Math.max(0, count - desktopCount - nonDesktopCount),
  };
}

function withActivitySource(item = {}) {
  const source = item.desktopCount > 0 && item.nonDesktopCount > 0
    ? "mixed"
    : item.desktopCount > 0 && !item.unknownCount
      ? "desktop"
      : item.nonDesktopCount > 0 && !item.unknownCount
        ? "non_desktop"
        : "unknown";
  return { ...item, source };
}

function isDesktopEvent(event = {}) {
  return cleanStableId(event.channelId).toLowerCase() === "desktop";
}

function addOptionalNumbers(left, right) {
  const leftNumber = explicitNumber(left);
  const rightNumber = explicitNumber(right);
  const total = numberOrZero(leftNumber) + numberOrZero(rightNumber);
  return leftNumber === null && rightNumber === null ? undefined : total;
}

function explicitNumber(value) {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function numberOrZero(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function latestTextTime(left = "", right = "") {
  return String(right || "") > String(left || "") ? String(right || "") : String(left || "");
}

function normalizeOutcome(value) {
  const outcome = cleanShortText(value || "completed").toLowerCase();
  if (["success", "succeeded", "done", "ok", "passed"].includes(outcome)) return "completed";
  if (["error", "failure"].includes(outcome)) return "failed";
  return ALLOWED_OUTCOMES.has(outcome) ? outcome : "completed";
}

function normalizeTime(value) {
  const text = cleanShortText(value);
  if (!text) return "";
  const date = new Date(text);
  return Number.isNaN(date.getTime()) ? "" : date.toISOString();
}

function cleanShortText(value) {
  return String(value || "").replace(/\s+/g, " ").trim().slice(0, 160);
}

function cleanStableId(value) {
  return cleanShortText(value).replace(/[^A-Za-z0-9_.:@/-]/g, "-").slice(0, 120);
}

function startOfDay(date) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

function addDays(date, days) {
  const next = new Date(date);
  next.setDate(next.getDate() + days);
  return next;
}
