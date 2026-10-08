import crypto from "node:crypto";

const RUNTIME_SAFE_ACTIVITY_CONTRACT_VERSION = "runtime-safe-activity.v1";
const RUNTIME_SAFE_ACTIVITY_SNAPSHOT_CONTRACT_VERSION = "runtime-safe-activity-snapshot.v1";
const MAX_RUNTIME_SAFE_ACTIVITIES = 50;
const SAFE_TOKEN = /^[A-Za-z0-9][A-Za-z0-9._:@-]*$/;
const TERMINAL_STATUSES = new Set(["blocked", "completed", "failed", "rejected", "target_rejected"]);
const ACTIVITY_STATUSES = new Set(["started", ...TERMINAL_STATUSES]);
const ACTION_PRESENTATION = Object.freeze({
  "enterprise.describe": "读取企业操作定义",
  "enterprise.invoke": "调用企业 Tool",
  "enterprise.search": "查询可用企业操作",
  "group.artifact.list": "读取组内产出清单",
  "group.artifact.read": "读取组内已发布产出",
  "group.input.read": "读取已授权输入产物",
  "material.prepare": "准备本轮材料",
  "runner.execute": "执行受管运行操作",
  "skill.run": "执行已挂载 Skill",
  "skill.document.instructions": "读取技能使用说明",
  "skill.document.metadata": "读取技能配置",
  "skill.document.reference": "读取技能参考资料",
  "skill.document.continue": "继续读取技能文档",
  "tool.execute": "执行已声明 Tool",
  "workspace.compress": "压缩任务输出",
  "workspace.copy": "复制工作区文件",
  "workspace.delete": "移除工作区内容",
  "workspace.extract": "解压工作区归档",
  "workspace.inspect_file": "检查工作区文件",
  "workspace.inspect_image": "检查工作区图片",
  "workspace.list": "读取文件清单",
  "workspace.mkdir": "创建工作区目录",
  "workspace.output": "生成任务输出",
  "workspace.read_text": "读取工作区文本",
  "workspace.replace": "更新工作区文件",
  "workspace.report_bundle": "生成报告包",
  "workspace.visual_evidence": "整理视觉证据",
  "workspace.write": "写入工作区文件",
});

function normalizeRuntimeSafeActivitySnapshot(value, { expectedTaskId = "" } = {}) {
  exactObject(value, new Set(["activities", "contractVersion", "taskId"]), "runtime_safe_activity_snapshot_invalid");
  if (value.contractVersion !== RUNTIME_SAFE_ACTIVITY_SNAPSHOT_CONTRACT_VERSION) {
    throw activityError("runtime_safe_activity_snapshot_contract_invalid");
  }
  const taskId = requiredToken(value.taskId, "taskId", 128);
  if (expectedTaskId && taskId !== expectedTaskId) {
    throw activityError("runtime_safe_activity_task_identity_conflict");
  }
  if (!Array.isArray(value.activities) || value.activities.length > MAX_RUNTIME_SAFE_ACTIVITIES) {
    throw activityError("runtime_safe_activity_snapshot_invalid");
  }
  let previousSequence = 0;
  const activities = value.activities.map((item) => {
    const activity = normalizeRuntimeSafeActivity(item, { taskId });
    if (activity.sequence <= previousSequence) {
      throw activityError("runtime_safe_activity_sequence_invalid");
    }
    previousSequence = activity.sequence;
    return activity;
  });
  return deepFreeze({
    contractVersion: RUNTIME_SAFE_ACTIVITY_SNAPSHOT_CONTRACT_VERSION,
    taskId,
    activities,
  });
}

function normalizeRuntimeSafeActivity(value, { taskId = "" } = {}) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw activityError("runtime_safe_activity_invalid");
  }
  const allowedFields = new Set([
    "actionCode", "activityId", "displayName", "kind", "operationCode", "sequence", "status", "subjectId",
  ]);
  const requiredFields = ["actionCode", "activityId", "displayName", "kind", "sequence", "status", "subjectId"];
  if (Object.keys(value).some((field) => !allowedFields.has(field)) ||
    requiredFields.some((field) => !Object.hasOwn(value, field))) {
    throw activityError("runtime_safe_activity_invalid");
  }
  const sequence = boundedInteger(value.sequence, "sequence", 1, 10_000);
  const safeTaskId = requiredToken(taskId, "taskId", 128);
  const activityId = requiredToken(value.activityId, "activityId", 80);
  if (activityId !== canonicalRuntimeSafeActivityId(safeTaskId, sequence)) {
    throw activityError("runtime_safe_activity_identity_invalid");
  }
  const kind = enumToken(value.kind, new Set(["skill", "tool"]), "kind");
  const subjectId = requiredToken(value.subjectId, "subjectId", 160);
  const actionCode = requiredToken(value.actionCode, "actionCode", 80);
  const expectedDisplayName = ACTION_PRESENTATION[actionCode];
  const displayName = safeLabel(value.displayName, "displayName", 120);
  if (!expectedDisplayName || displayName !== expectedDisplayName) {
    throw activityError("runtime_safe_activity_presentation_invalid");
  }
  if ((kind === "skill") !== (actionCode === "skill.run") ||
    (actionCode === "tool.execute" && subjectId !== "declared-tool") ||
    (actionCode === "runner.execute" && subjectId !== "managed-runner")) {
    throw activityError("runtime_safe_activity_kind_invalid");
  }
  const operationCode = optionalToken(value.operationCode, "operationCode", 160);
  return deepFreeze({
    activityId,
    sequence,
    kind,
    subjectId,
    displayName,
    actionCode,
    ...(operationCode ? { operationCode } : {}),
    status: enumToken(value.status, ACTIVITY_STATUSES, "status"),
  });
}

function assertRuntimeSafeActivitySnapshotProgress(existingValue, nextValue) {
  const existing = normalizeRuntimeSafeActivitySnapshot(existingValue);
  const next = normalizeRuntimeSafeActivitySnapshot(nextValue, { expectedTaskId: existing.taskId });
  if (next.activities.length < existing.activities.length) {
    throw activityError("runtime_safe_activity_progress_conflict");
  }
  let lifecycleChanged = false;
  existing.activities.forEach((previous, index) => {
    const current = next.activities[index];
    if (!current || ["activityId", "sequence", "kind", "subjectId", "displayName", "actionCode"]
      .some((field) => previous[field] !== current[field])) {
      throw activityError("runtime_safe_activity_identity_conflict");
    }
    if (previous.status !== "started" && previous.status !== current.status) {
      throw activityError("runtime_safe_activity_status_conflict");
    }
    if (previous.status === "started" &&
      current.status !== "started" && !TERMINAL_STATUSES.has(current.status)) {
      throw activityError("runtime_safe_activity_status_conflict");
    }
    if (previous.operationCode && previous.operationCode !== current.operationCode) {
      throw activityError("runtime_safe_activity_operation_conflict");
    }
    if (!previous.operationCode && current.operationCode && current.status !== "completed") {
      throw activityError("runtime_safe_activity_operation_conflict");
    }
    if (previous.status !== current.status || previous.operationCode !== current.operationCode) {
      lifecycleChanged = true;
    }
  });
  if (next.activities.length > existing.activities.length &&
    (next.activities.length !== existing.activities.length + 1 ||
      next.activities.at(-1)?.status !== "started" || lifecycleChanged)) {
    throw activityError("runtime_safe_activity_progress_conflict");
  }
}

function canonicalRuntimeSafeActivityId(taskId, sequence) {
  const safeTaskId = requiredToken(taskId, "taskId", 128);
  const safeSequence = boundedInteger(sequence, "sequence", 1, 10_000);
  return `activity_${crypto.createHash("sha256")
    .update(`${RUNTIME_SAFE_ACTIVITY_CONTRACT_VERSION}\0${safeTaskId}\0${safeSequence}`, "utf8")
    .digest("hex").slice(0, 40)}`;
}

function runtimeSafeActivityDisplayName(actionCode) {
  return ACTION_PRESENTATION[String(actionCode || "").trim()] || "";
}

function exactObject(value, fields, code) {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
    Object.keys(value).length !== fields.size ||
    Object.keys(value).some((field) => !fields.has(field)) ||
    [...fields].some((field) => !Object.hasOwn(value, field))) {
    throw activityError(code);
  }
}

function requiredToken(value, field, maxLength) {
  const token = String(value || "").trim();
  if (!token || token.length > maxLength || !SAFE_TOKEN.test(token)) {
    throw activityError("runtime_safe_activity_token_invalid", field);
  }
  return token;
}

function optionalToken(value, field, maxLength) {
  if (value === undefined || value === null || value === "") return "";
  return requiredToken(value, field, maxLength);
}

function safeLabel(value, field, maxLength) {
  const label = String(value || "").replace(/\s+/g, " ").trim();
  if (!label || label.length > maxLength || /[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/u.test(label)) {
    throw activityError("runtime_safe_activity_label_invalid", field);
  }
  return label;
}

function enumToken(value, allowed, field) {
  const token = requiredToken(value, field, 120);
  if (!allowed.has(token)) throw activityError("runtime_safe_activity_enum_invalid", field);
  return token;
}

function boundedInteger(value, field, minimum, maximum) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < minimum || number > maximum) {
    throw activityError("runtime_safe_activity_integer_invalid", field);
  }
  return number;
}

function deepFreeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    Object.values(value).forEach(deepFreeze);
  }
  return value;
}

function activityError(code, field = "") {
  const error = new Error(field ? `${code}:${field}` : code);
  error.code = code;
  return error;
}

export {
  ACTION_PRESENTATION as RUNTIME_SAFE_ACTIVITY_ACTION_PRESENTATION,
  ACTIVITY_STATUSES as RUNTIME_SAFE_ACTIVITY_STATUSES,
  MAX_RUNTIME_SAFE_ACTIVITIES,
  RUNTIME_SAFE_ACTIVITY_CONTRACT_VERSION,
  RUNTIME_SAFE_ACTIVITY_SNAPSHOT_CONTRACT_VERSION,
  assertRuntimeSafeActivitySnapshotProgress,
  canonicalRuntimeSafeActivityId,
  normalizeRuntimeSafeActivity,
  normalizeRuntimeSafeActivitySnapshot,
  runtimeSafeActivityDisplayName,
};
