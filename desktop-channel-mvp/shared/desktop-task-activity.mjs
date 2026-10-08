const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:@-]*$/;
const ACTIVITY_STATUSES = new Set(["blocked", "completed", "failed", "rejected", "running", "target_rejected"]);
const DESKTOP_ACTIVITY_SNAPSHOT_CONTRACT = "desktop-task-activity-snapshot.v2";

export function projectDesktopTaskActivitySnapshot(page = {}, { expectedTaskId = "" } = {}) {
  const task = page?.task;
  const taskId = safeId(task?.id, 128);
  const evidence = task?.execution?.agentRuntime;
  const source = evidence?.activitySnapshot;
  if (!taskId || (expectedTaskId && taskId !== expectedTaskId) ||
    evidence?.contractVersion !== "agent-runtime-safe-evidence.v1" ||
    !plainObject(source) || source.contractVersion !== "runtime-safe-activity-snapshot.v1" ||
    source.taskId !== taskId || !onlyFields(source, ["contractVersion", "taskId", "activities"]) ||
    !Array.isArray(source.activities) || source.activities.length > 50) return null;
  const activities = source.activities.map(projectServerActivity).filter(Boolean);
  if (activities.length !== source.activities.length) return null;
  return normalizeDesktopTaskActivitySnapshot({
    contractVersion: DESKTOP_ACTIVITY_SNAPSHOT_CONTRACT,
    taskId,
    updatedAt: evidence.updatedAt,
    activities,
  }, { expectedTaskId });
}

export function normalizeDesktopTaskActivitySnapshot(value = {}, { expectedTaskId = "" } = {}) {
  if (!plainObject(value) || value.contractVersion !== DESKTOP_ACTIVITY_SNAPSHOT_CONTRACT) return null;
  if (!onlyFields(value, ["contractVersion", "taskId", "updatedAt", "activities"])) return null;
  const taskId = safeId(value.taskId, 128);
  const updatedAt = safeTimestamp(value.updatedAt);
  if (!taskId || (expectedTaskId && taskId !== expectedTaskId) || !updatedAt || !Array.isArray(value.activities) || value.activities.length > 50) return null;
  let previousSequence = 0;
  const activities = [];
  for (const item of value.activities) {
    if (!plainObject(item) || !onlyFields(item, ["activityId", "sequence", "kind", "subjectId", "displayName", "actionCode", "operationCode", "status"])) return null;
    const activityId = safeId(item.activityId, 80);
    const sequence = safeInteger(item.sequence);
    const kind = ["skill", "tool"].includes(item.kind) ? item.kind : "";
    const subjectId = safeId(item.subjectId, 160);
    const displayName = safeLabel(item.displayName, 120);
    const actionCode = safeId(item.actionCode, 80);
    const operationCode = item.operationCode === undefined ? "" : safeId(item.operationCode, 160);
    if (!activityId || sequence <= previousSequence || !kind || !subjectId || !displayName || !actionCode ||
      (item.operationCode !== undefined && !operationCode) || !ACTIVITY_STATUSES.has(item.status)) return null;
    previousSequence = sequence;
    activities.push(Object.freeze({
      activityId,
      sequence,
      kind,
      subjectId,
      displayName,
      actionCode,
      ...(operationCode ? { operationCode } : {}),
      status: item.status,
    }));
  }
  return Object.freeze({
    contractVersion: DESKTOP_ACTIVITY_SNAPSHOT_CONTRACT,
    taskId,
    updatedAt,
    activities: Object.freeze(activities),
  });
}

export function desktopTaskActivitySummary(snapshot = null) {
  const normalized = normalizeDesktopTaskActivitySnapshot(snapshot);
  if (!normalized?.activities.length) return "尚无 Tool / Skill 活动";
  const groups = desktopTaskActivityGroups(normalized);
  const toolTypes = groups.filter((item) => item.kind === "tool").length;
  const skillTypes = groups.filter((item) => item.kind === "skill").length;
  return [
    `${normalized.activities.length} 次调用`,
    toolTypes ? `${toolTypes} 类 Tool` : "",
    skillTypes ? `${skillTypes} 类 Skill` : "",
  ].filter(Boolean).join(" · ");
}

export function desktopTaskActivityGroups(snapshot = null) {
  const normalized = normalizeDesktopTaskActivitySnapshot(snapshot);
  if (!normalized?.activities.length) return Object.freeze([]);
  const grouped = new Map();
  for (const activity of normalized.activities) {
    const key = `${activity.kind}:${activity.subjectId}:${activity.actionCode}`;
    const current = grouped.get(key);
    if (current) {
      current.count += 1;
      current.statuses.add(activity.status);
      continue;
    }
    grouped.set(key, {
      actionCode: activity.actionCode,
      count: 1,
      displayName: activity.displayName,
      kind: activity.kind,
      statuses: new Set([activity.status]),
      subjectId: activity.subjectId,
    });
  }
  return Object.freeze([...grouped.values()].map((group) => Object.freeze({
    actionCode: group.actionCode,
    count: group.count,
    displayName: group.displayName,
    kind: group.kind,
    status: groupedActivityStatus(group.statuses),
    subjectId: group.subjectId,
  })));
}

export function desktopTaskActivityStatusLabel(status = "") {
  return {
    blocked: "已阻塞",
    completed: "已完成",
    failed: "失败",
    rejected: "已拒绝",
    running: "正在执行",
    target_rejected: "目标拒绝",
  }[status] || "状态未知";
}

function projectServerActivity(value) {
  if (!plainObject(value) || !onlyFields(value, ["activityId", "sequence", "kind", "subjectId", "displayName", "actionCode", "operationCode", "status"])) return null;
  const activityId = safeId(value.activityId, 80);
  const sequence = safeInteger(value.sequence);
  const kind = ["skill", "tool"].includes(value.kind) ? value.kind : "";
  const subjectId = safeId(value.subjectId, 160);
  const displayName = safeLabel(value.displayName, 120);
  const actionCode = safeId(value.actionCode, 80);
  const operationCode = value.operationCode === undefined ? "" : safeId(value.operationCode, 160);
  const status = value.status === "started" ? "running" : value.status;
  if (!activityId || sequence < 1 || !kind || !subjectId || !displayName || !actionCode ||
    (value.operationCode !== undefined && !operationCode) || !ACTIVITY_STATUSES.has(status)) return null;
  return {
    activityId,
    sequence,
    kind,
    subjectId,
    displayName,
    actionCode,
    ...(operationCode ? { operationCode } : {}),
    status,
  };
}

function groupedActivityStatus(statuses) {
  return ["running", "blocked", "failed", "rejected", "target_rejected", "completed"]
    .find((status) => statuses.has(status)) || "completed";
}

function safeId(value, maxLength) {
  const id = String(value || "").trim();
  return id && id.length <= maxLength && SAFE_ID.test(id) ? id : "";
}

function safeLabel(value, maxLength) {
  const label = String(value || "").replace(/\s+/g, " ").trim();
  return label && label.length <= maxLength && !/[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/u.test(label) ? label : "";
}

function safeInteger(value) {
  const number = Number(value);
  return Number.isSafeInteger(number) && number >= 0 ? number : -1;
}

function safeTimestamp(value) {
  const timestamp = Date.parse(String(value || ""));
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : "";
}

function onlyFields(value, allowed) {
  const fields = new Set(allowed);
  return Object.keys(value).every((field) => fields.has(field));
}

function plainObject(value) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

export { DESKTOP_ACTIVITY_SNAPSHOT_CONTRACT };
