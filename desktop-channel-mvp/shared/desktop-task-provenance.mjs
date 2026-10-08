const SAFE_TOKEN = /^[A-Za-z0-9][A-Za-z0-9._:@/-]*$/;
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/u;
const HOST_PATH = /^(?:\/|~[\\/]|[A-Za-z]:[\\/]|\\\\)/;
const SECRET_PREFIX = /^(?:bearer[\s._:-]*|sk-|rk-|xox[baprs]-|gh[pousr]_|glpat-|ya29\.)/i;
const DESKTOP_TASK_PROVENANCE_CONTRACT = "desktop-task-provenance.v1";
const SOURCE_CONTRACT = "runtime-safe-provenance.v1";
const EXECUTION_MODES = new Set(["deterministic_harness", "guidance", "tool_workflow"]);
const EXECUTION_STATUSES = new Set([
  "blocked", "completed", "failed", "rejected", "running", "target_rejected",
]);

export function projectDesktopTaskProvenance(page = {}, { expectedTaskId = "" } = {}) {
  const task = page?.task;
  const taskId = safeToken(task?.id, 128);
  const source = task?.execution?.skillProvenance;
  if (!taskId || (expectedTaskId && taskId !== expectedTaskId) || !plainObject(source) ||
    source.contractVersion !== SOURCE_CONTRACT || source.taskId !== taskId ||
    !exactFields(source, ["contractVersion", "taskId", "employeeProfile", "callableSkills", "executedSkills"])) {
    return null;
  }
  const employeeProfile = projectEmployeeProfile(source.employeeProfile);
  const callableSkills = Array.isArray(source.callableSkills)
    ? source.callableSkills.map(projectCallableSkill).filter(Boolean)
    : [];
  const executedSkills = Array.isArray(source.executedSkills)
    ? source.executedSkills.map(projectExecutedSkill).filter(Boolean)
    : [];
  if (!employeeProfile || callableSkills.length !== source.callableSkills?.length ||
    executedSkills.length !== source.executedSkills?.length) return null;
  return normalizeDesktopTaskProvenance({
    contractVersion: DESKTOP_TASK_PROVENANCE_CONTRACT,
    sourceContractVersion: SOURCE_CONTRACT,
    taskId,
    updatedAt: task.updatedAt,
    employeeProfile,
    callableSkills,
    executedSkills,
  }, { expectedTaskId });
}

export function normalizeDesktopTaskProvenance(value = {}, { expectedTaskId = "" } = {}) {
  if (!plainObject(value) || value.contractVersion !== DESKTOP_TASK_PROVENANCE_CONTRACT ||
    value.sourceContractVersion !== SOURCE_CONTRACT ||
    !exactFields(value, [
      "contractVersion", "sourceContractVersion", "taskId", "updatedAt",
      "employeeProfile", "callableSkills", "executedSkills",
    ])) return null;
  const taskId = safeToken(value.taskId, 128);
  const updatedAt = safeTimestamp(value.updatedAt);
  const employeeProfile = normalizeEmployeeProfile(value.employeeProfile);
  if (!taskId || (expectedTaskId && taskId !== expectedTaskId) || !updatedAt || !employeeProfile ||
    !Array.isArray(value.callableSkills) || value.callableSkills.length > 50 ||
    !Array.isArray(value.executedSkills) || value.executedSkills.length > 50) return null;
  const callableSkills = value.callableSkills.map(normalizeCallableSkill).filter(Boolean);
  const executedSkills = value.executedSkills.map(normalizeExecutedSkill).filter(Boolean);
  if (callableSkills.length !== value.callableSkills.length ||
    executedSkills.length !== value.executedSkills.length) return null;
  const callableById = new Map(callableSkills.map((skill) => [skill.subjectId, skill]));
  if (callableById.size !== callableSkills.length) return null;
  let previousSequence = 0;
  const activityIds = new Set();
  for (const executed of executedSkills) {
    const callable = callableById.get(executed.subjectId);
    if (!callable || callable.executionMode !== "deterministic_harness" ||
      callable.sourceVersion !== executed.sourceVersion || executed.sequence <= previousSequence ||
      activityIds.has(executed.activityId)) return null;
    previousSequence = executed.sequence;
    activityIds.add(executed.activityId);
  }
  return deepFreeze({
    contractVersion: DESKTOP_TASK_PROVENANCE_CONTRACT,
    sourceContractVersion: SOURCE_CONTRACT,
    taskId,
    updatedAt,
    employeeProfile,
    callableSkills,
    executedSkills,
  });
}

export function desktopTaskProvenanceSummary(value = null) {
  const snapshot = normalizeDesktopTaskProvenance(value);
  if (!snapshot) return "暂无来源证据";
  return [
    "1 项职业设定",
    snapshot.callableSkills.length ? `${snapshot.callableSkills.length} 个可调用 Skill` : "",
    snapshot.executedSkills.length ? `${snapshot.executedSkills.length} 次实际执行` : "",
  ].filter(Boolean).join(" · ");
}

export function desktopSkillExecutionModeLabel(mode = "") {
  return {
    deterministic_harness: "确定性执行",
    guidance: "指导上下文",
    tool_workflow: "Tool 工作流",
  }[mode] || "来源未知";
}

export function desktopProvenanceExecutionStatusLabel(status = "") {
  return {
    blocked: "已阻塞",
    completed: "已完成",
    failed: "失败",
    rejected: "已拒绝",
    running: "正在执行",
    target_rejected: "目标拒绝",
  }[status] || "状态未知";
}

function projectEmployeeProfile(value) {
  if (!plainObject(value) || !exactFields(value, [
    "fact", "subjectId", "displayName", "sourceVersion", "promptScope", "promptVersion", "promptHash",
  ]) || value.fact !== "applied") return null;
  return {
    fact: "applied",
    subjectId: value.subjectId,
    displayName: value.displayName,
    sourceVersion: value.sourceVersion,
    promptVersion: value.promptVersion,
  };
}

function projectCallableSkill(value) {
  if (!plainObject(value) || !exactFields(value, [
    "fact", "subjectId", "displayName", "sourceVersion", "executionMode",
  ]) || value.fact !== "callable") return null;
  return { ...value };
}

function projectExecutedSkill(value) {
  if (!plainObject(value) || !exactFields(value, [
    "fact", "activityId", "sequence", "subjectId", "displayName", "sourceVersion", "status",
  ]) || value.fact !== "executed") return null;
  return { ...value, status: value.status === "started" ? "running" : value.status };
}

function normalizeEmployeeProfile(value) {
  if (!plainObject(value) || !exactFields(value, [
    "fact", "subjectId", "displayName", "sourceVersion", "promptVersion",
  ]) || value.fact !== "applied") return null;
  const subjectId = safeToken(value.subjectId, 160);
  const displayName = safeLabel(value.displayName, 160);
  const sourceVersion = safeToken(value.sourceVersion, 120);
  const promptVersion = safeToken(value.promptVersion, 160);
  return subjectId && displayName && sourceVersion && promptVersion
    ? Object.freeze({ fact: "applied", subjectId, displayName, sourceVersion, promptVersion })
    : null;
}

function normalizeCallableSkill(value) {
  if (!plainObject(value) || !exactFields(value, [
    "fact", "subjectId", "displayName", "sourceVersion", "executionMode",
  ]) || value.fact !== "callable" || !EXECUTION_MODES.has(value.executionMode)) return null;
  const subjectId = safeToken(value.subjectId, 160);
  const displayName = safeLabel(value.displayName, 160);
  const sourceVersion = safeToken(value.sourceVersion, 120);
  return subjectId && displayName && sourceVersion ? Object.freeze({
    fact: "callable",
    subjectId,
    displayName,
    sourceVersion,
    executionMode: value.executionMode,
  }) : null;
}

function normalizeExecutedSkill(value) {
  if (!plainObject(value) || !exactFields(value, [
    "fact", "activityId", "sequence", "subjectId", "displayName", "sourceVersion", "status",
  ]) || value.fact !== "executed" || !EXECUTION_STATUSES.has(value.status)) return null;
  const activityId = safeToken(value.activityId, 200);
  const sequence = safeInteger(value.sequence, 1, 10_000);
  const subjectId = safeToken(value.subjectId, 160);
  const displayName = safeLabel(value.displayName, 160);
  const sourceVersion = safeToken(value.sourceVersion, 120);
  return activityId && sequence && subjectId && displayName && sourceVersion ? Object.freeze({
    fact: "executed",
    activityId,
    sequence,
    subjectId,
    displayName,
    sourceVersion,
    status: value.status,
  }) : null;
}

function safeToken(value, maxLength) {
  const token = String(value || "").trim();
  return token && token.length <= maxLength && SAFE_TOKEN.test(token) &&
    !HOST_PATH.test(token) && !SECRET_PREFIX.test(token) ? token : "";
}

function safeLabel(value, maxLength) {
  const label = String(value || "").replace(/\s+/g, " ").trim();
  return label && label.length <= maxLength && !CONTROL_CHARACTERS.test(label) &&
    !HOST_PATH.test(label) && !SECRET_PREFIX.test(label) ? label : "";
}

function safeInteger(value, minimum, maximum) {
  return Number.isSafeInteger(value) && value >= minimum && value <= maximum ? value : 0;
}

function safeTimestamp(value) {
  const timestamp = Date.parse(String(value || ""));
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : "";
}

function exactFields(value, allowed) {
  return Object.keys(value).length === allowed.length &&
    Object.keys(value).every((field) => allowed.includes(field));
}

function plainObject(value) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function deepFreeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    Object.values(value).forEach(deepFreeze);
  }
  return value;
}

export { DESKTOP_TASK_PROVENANCE_CONTRACT };
