const SAFE_TOKEN_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:@-]*$/;
const EVENT_TYPES = new Set([
  "task.artifact_available",
  "task.progress",
  "task.result_available",
  "task.state_changed",
]);
const TASK_STATUSES = new Set([
  "blocked",
  "canceled",
  "completed",
  "failed",
  "lost",
  "queued",
  "rejected",
  "running",
  "timed_out",
  "waiting",
]);
const TERMINAL_STATUSES = new Set(["blocked", "canceled", "completed", "failed", "lost", "rejected", "timed_out"]);
const PROGRESS_STAGES = new Set(["admission", "provider", "queue", "result", "skill", "tool"]);
const PROGRESS_STATUSES = new Set(["blocked", "completed", "running", "waiting"]);
const PRESENTATION_CODES = new Set([
  "c002_backfill",
  "admission_completed",
  "legacy_terminal_imported",
  "provider_completed",
  "provider_started",
  "queue_wait_reason_changed",
  "queue_waiting",
  "result_recorded",
  "skill_blocked",
  "skill_completed",
  "skill_started",
  "task_canceled",
  "task_ready",
  "task_submitted",
  "tool_blocked",
  "tool_completed",
  "tool_target_rejected",
  "tool_started",
  "worker_claimed",
  "worker_lease_expired_requeued",
  "worker_recovery_budget_exhausted",
  "worker_settled",
  "worker_waiting",
]);
const WAIT_REASON_CODES = new Set([
  "actor_capacity",
  "awaiting_worker",
  "employee_capacity",
  "employee_fifo",
  "global_capacity",
  "pending_file_intake",
  "pending_invocation_check",
  "pending_remote_resource",
  "prerequisite_pending",
]);

const STATUS_PRESENTATION = Object.freeze({
  blocked: ["任务受阻", "blocked"],
  canceled: ["任务已停止", "blocked"],
  completed: ["任务已完成", "done"],
  failed: ["任务失败", "blocked"],
  lost: ["任务执行中断", "blocked"],
  queued: ["任务排队中", "running"],
  rejected: ["任务未被接收", "blocked"],
  running: ["任务运行中", "running"],
  timed_out: ["任务已超时", "blocked"],
  waiting: ["任务等待中", "running"],
});

const CODE_LABELS = Object.freeze({
  c002_backfill: "任务历史状态已恢复",
  admission_completed: "运行门禁已通过",
  legacy_terminal_imported: "历史终态已登记",
  provider_completed: "模型响应已完成",
  provider_started: "模型响应已开始",
  queue_wait_reason_changed: "等待条件已更新",
  queue_waiting: "正在等待运行资源",
  result_recorded: "结果已安全保存",
  skill_blocked: "Skill 执行受阻",
  skill_completed: "Skill 执行完成",
  skill_started: "Skill 开始执行",
  task_canceled: "任务停止已生效",
  task_ready: "任务已具备运行条件",
  task_submitted: "任务已提交",
  tool_blocked: "Tool 调用被运行门禁阻断",
  tool_completed: "Tool 调用完成",
  tool_target_rejected: "目标系统未接受 Tool 操作",
  tool_started: "Tool 开始受控调用",
  worker_claimed: "运行资源已就绪",
  worker_lease_expired_requeued: "任务已重新排队",
  worker_recovery_budget_exhausted: "任务恢复次数已用尽",
  worker_settled: "任务状态已收口",
  worker_waiting: "运行资源正在等待条件",
});

const STAGE_LABELS = Object.freeze({
  admission: "运行门禁",
  provider: "模型响应",
  queue: "运行队列",
  result: "结果保存",
  skill: "Skill 执行",
  tool: "Tool 调用",
});

export function normalizeDesktopTaskEvent(value, { expectedTaskId = "", expectedSeq = null } = {}) {
  if (!isPlainObject(value) || value.contractVersion !== "task-event.v1") return null;
  if (!hasOnlyFields(value, ["contractVersion", "taskId", "seq", "taskRevision", "eventType", "occurredAt", "data"])) return null;
  const taskId = safeToken(value.taskId, 128);
  const seq = safeInteger(value.seq);
  const taskRevision = safeInteger(value.taskRevision);
  const occurredAt = safeTimestamp(value.occurredAt);
  const eventType = EVENT_TYPES.has(value.eventType) ? value.eventType : "";
  if (!taskId || seq < 1 || taskRevision < 0 || !occurredAt || !eventType) return null;
  if (expectedTaskId && taskId !== expectedTaskId) return null;
  if (expectedSeq !== null && seq !== expectedSeq) return null;
  const data = normalizeEventData(eventType, value.data);
  if (!data) return null;
  return Object.freeze({
    contractVersion: "task-event.v1",
    taskId,
    seq,
    taskRevision,
    eventType,
    occurredAt,
    data,
  });
}

export function appendDesktopTaskEvent(events = [], event = null) {
  const current = Array.isArray(events) ? events : [];
  const normalized = normalizeDesktopTaskEvent(event);
  if (!normalized) return current;
  const existing = current.find((item) => item.taskId === normalized.taskId && item.seq === normalized.seq);
  if (existing) return current;
  return [...current, normalized].sort((left, right) => left.seq - right.seq);
}

export function desktopTaskTimelineView(events = [], { connectionState = "", now = Date.now() } = {}) {
  const ordered = (Array.isArray(events) ? events : [])
    .map((event) => normalizeDesktopTaskEvent(event))
    .filter(Boolean)
    .sort((left, right) => left.seq - right.seq);
  const latestState = [...ordered].reverse().find((event) => event.eventType === "task.state_changed") || null;
  const status = latestState?.data.status || "";
  const [statusLabel, tone] = STATUS_PRESENTATION[status] || [connectionLabel(connectionState), "running"];
  const firstTimestamp = ordered.length ? Date.parse(ordered[0].occurredAt) : NaN;
  const terminalEvent = latestState && TERMINAL_STATUSES.has(status) ? latestState : null;
  const terminalTimestamp = terminalEvent ? Date.parse(terminalEvent.occurredAt) : NaN;
  const effectiveEnd = Number.isFinite(terminalTimestamp) ? terminalTimestamp : Number(now);
  const durationMs = Number.isFinite(firstTimestamp) ? Math.max(0, effectiveEnd - firstTimestamp) : 0;
  const latest = ordered[ordered.length - 1] || null;
  const phaseLabel = latest ? desktopTaskEventPresentation(latest).label : "正在连接任务进度";
  return Object.freeze({
    connectionLabel: connectionLabel(connectionState),
    durationMs,
    events: ordered,
    lastSeq: latest?.seq || 0,
    phaseLabel,
    status,
    statusLabel,
    terminal: Boolean(terminalEvent),
    tone,
  });
}

export function desktopTaskOutputManifest(events = [], { employeeId = "", result = null } = {}) {
  const task = desktopTaskTimelineView(events);
  const taskId = task.events[0]?.taskId || "";
  if (!taskId) return null;
  const resultAvailable = task.status === "completed" &&
    (Boolean(result?.text) || task.events.some((event) => event.eventType === "task.result_available"));
  const artifacts = task.events
    .filter((event) => event.eventType === "task.artifact_available")
    .map((event) => {
      const gate = desktopArtifactDeliveryGate(event, task.events);
      return Object.freeze({
        ...(employeeId ? { employeeId: safeToken(employeeId, 160) } : {}),
        taskId,
        artifactId: event.data.artifactId,
        deliveryStatus: gate?.status || "waiting_for_task_completion",
      });
    });
  return Object.freeze({
    contractVersion: "task-output-manifest.v1",
    taskId,
    taskStatus: task.status,
    terminal: task.terminal,
    result: Object.freeze({
      kind: "conversation_history",
      available: resultAvailable,
    }),
    artifactCount: artifacts.length,
    availableArtifactCount: artifacts.filter((artifact) => artifact.deliveryStatus === "available").length,
    artifacts: Object.freeze(artifacts),
    summaryLabel: desktopTaskOutputManifestSummary({
      artifactCount: artifacts.length,
      resultAvailable,
    }),
  });
}

export function desktopTaskTimelineItems(events = []) {
  const ordered = (Array.isArray(events) ? events : [])
    .map((event) => normalizeDesktopTaskEvent(event))
    .filter(Boolean)
    .sort((left, right) => left.seq - right.seq);
  const items = [];
  let progressEvents = [];
  let segmentNumber = 0;
  const flushProgress = () => {
    if (!progressEvents.length) return;
    if (progressEvents.length === 1) {
      items.push(Object.freeze({ kind: "event", event: progressEvents[0] }));
    } else {
      segmentNumber += 1;
      const stageCounts = progressEvents.reduce((counts, event) => ({
        ...counts,
        [event.data.stage]: (counts[event.data.stage] || 0) + 1,
      }), {});
      const detailLabels = ["tool", "skill"]
        .filter((stage) => stageCounts[stage])
        .map((stage) => `${stage === "tool" ? "Tool" : "Skill"} ${stageCounts[stage]} 条`);
      items.push(Object.freeze({
        kind: "progress_batch",
        events: Object.freeze([...progressEvents]),
        key: `${progressEvents[0].taskId}:${progressEvents[0].seq}-${progressEvents.at(-1).seq}`,
        label: `执行片段 ${segmentNumber} · ${progressEvents.length} 条记录${detailLabels.length ? ` · ${detailLabels.join(" · ")}` : ""}`,
        seqStart: progressEvents[0].seq,
        seqEnd: progressEvents.at(-1).seq,
      }));
    }
    progressEvents = [];
  };
  for (const event of ordered) {
    if (event.eventType === "task.progress") {
      if (event.data.code === "provider_started" && progressEvents.length) flushProgress();
      progressEvents.push(event);
      continue;
    }
    flushProgress();
    items.push(Object.freeze({ kind: "event", event }));
  }
  flushProgress();
  return Object.freeze(items);
}

export function desktopTaskEventPresentation(event = {}) {
  if (event.eventType === "task.result_available") {
    return Object.freeze({ kind: "result", label: "结果已安全保存", status: "completed" });
  }
  if (event.eventType === "task.artifact_available") {
    return Object.freeze({ kind: "artifact", label: "产物已登记", status: "completed" });
  }
  if (event.eventType === "task.progress") {
    const stage = event.data?.stage || "";
    return Object.freeze({
      kind: stage,
      label: CODE_LABELS[event.data?.code] || `${STAGE_LABELS[stage] || "任务阶段"}${progressStatusSuffix(event.data?.status)}`,
      status: event.data?.status || "waiting",
    });
  }
  const status = event.data?.status || "";
  return Object.freeze({
    kind: "state",
    label: CODE_LABELS[event.data?.code] || STATUS_PRESENTATION[status]?.[0] || "任务状态已更新",
    status,
  });
}

export function isDesktopTaskTerminalStatus(status = "") {
  return TERMINAL_STATUSES.has(status);
}

export function desktopArtifactDeliveryGate(event = null, events = []) {
  const artifactEvent = normalizeDesktopTaskEvent(event);
  if (!artifactEvent || artifactEvent.eventType !== "task.artifact_available") return null;
  const task = desktopTaskTimelineView(events);
  const ready = task.status === "completed";
  return Object.freeze({
    artifactId: artifactEvent.data.artifactId,
    taskId: artifactEvent.taskId,
    ready,
    status: ready ? "available" : task.terminal ? "task_not_completed" : "waiting_for_task_completion",
  });
}

function normalizeEventData(eventType, value) {
  if (!isPlainObject(value)) return null;
  if (eventType === "task.state_changed") {
    if (!hasOnlyFields(value, ["status", "waitReasonCode", "lastErrorCode", "attemptCount", "recoveryCount", "code"])) return null;
    if (!TASK_STATUSES.has(value.status)) return null;
    const waitReasonCode = optionalEnum(value.waitReasonCode, WAIT_REASON_CODES);
    const lastErrorCode = optionalSafeToken(value.lastErrorCode, 120);
    const code = optionalEnum(value.code, PRESENTATION_CODES);
    const attemptCount = safeInteger(value.attemptCount ?? 0);
    const recoveryCount = safeInteger(value.recoveryCount ?? 0);
    if (waitReasonCode === undefined || lastErrorCode === undefined || code === undefined || attemptCount < 0 || recoveryCount < 0) return null;
    return Object.freeze({ status: value.status, waitReasonCode, lastErrorCode, attemptCount, recoveryCount, code });
  }
  if (eventType === "task.progress") {
    if (!hasOnlyFields(value, ["stage", "status", "code"])) return null;
    if (!PROGRESS_STAGES.has(value.stage) || !PROGRESS_STATUSES.has(value.status) || !PRESENTATION_CODES.has(value.code)) return null;
    return Object.freeze({ stage: value.stage, status: value.status, code: value.code });
  }
  if (eventType === "task.artifact_available") {
    if (!hasOnlyFields(value, ["artifactId"])) return null;
    const artifactId = safeToken(value.artifactId, 160);
    return artifactId ? Object.freeze({ artifactId }) : null;
  }
  if (!hasOnlyFields(value, ["resultKind"]) || value.resultKind !== "conversation_history") return null;
  return Object.freeze({ resultKind: "conversation_history" });
}

function desktopTaskOutputManifestSummary({ artifactCount = 0, resultAvailable = false } = {}) {
  const count = Number(artifactCount || 0);
  if (count > 0) return `${count} 个交付物${resultAvailable ? " · 结果可查看" : "已登记"}`;
  return resultAvailable ? "结果可查看" : "暂无文件交付";
}

function connectionLabel(value) {
  return {
    connected: "任务进度已同步",
    connecting: "正在连接任务进度",
    reconnecting: "正在续接任务进度，后台任务仍在执行",
  }[value] || "等待任务状态";
}

function progressStatusSuffix(value) {
  return {
    blocked: "受阻",
    completed: "已完成",
    running: "进行中",
    waiting: "等待中",
  }[value] || "已更新";
}

function optionalEnum(value, allowed) {
  if (value === undefined || value === null || value === "") return null;
  return allowed.has(value) ? value : undefined;
}

function optionalSafeToken(value, maxLength) {
  if (value === undefined || value === null || value === "") return null;
  return safeToken(value, maxLength) || undefined;
}

function safeToken(value, maxLength) {
  const token = String(value || "").trim();
  return token && token.length <= maxLength && SAFE_TOKEN_PATTERN.test(token) ? token : "";
}

function safeInteger(value) {
  const number = Number(value);
  return Number.isSafeInteger(number) && number >= 0 ? number : -1;
}

function safeTimestamp(value) {
  const timestamp = Date.parse(String(value || ""));
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : "";
}

function hasOnlyFields(value, allowed) {
  const fields = new Set(allowed);
  return Object.keys(value).every((field) => fields.has(field));
}

function isPlainObject(value) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}
