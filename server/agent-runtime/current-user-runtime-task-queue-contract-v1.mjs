import crypto from "node:crypto";

const CURRENT_USER_RUNTIME_TASKS_CONTRACT_VERSION = "current-user-runtime-tasks.v1";
const CURRENT_USER_RUNTIME_TASK_QUEUE_CONTRACT_VERSION = "current-user-runtime-task-queue.v1";
const CURRENT_USER_RUNTIME_TASK_QUEUE_REORDER_CONTRACT_VERSION =
  "current-user-runtime-task-queue-reorder.v1";
const REORDER_FIELDS = new Set([
  "contractVersion",
  "employeeId",
  "expectedRevision",
  "orderedTaskIds",
]);
const ACTIVE_STATUSES = new Set([
  "pending_file_intake",
  "pending_invocation_check",
  "pending_remote_resource",
  "running",
  "waiting",
]);

function normalizeRuntimeTaskQueueReorderRequest(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw queueError("runtime_task_queue_request_invalid");
  }
  if (Object.keys(value).some((field) => !REORDER_FIELDS.has(field))) {
    throw queueError("runtime_task_queue_request_field_unsupported");
  }
  if (value.contractVersion !== CURRENT_USER_RUNTIME_TASK_QUEUE_REORDER_CONTRACT_VERSION) {
    throw queueError("runtime_task_queue_contract_unsupported");
  }
  const employeeId = requiredToken(value.employeeId, "employee_id", 160);
  const expectedRevision = String(value.expectedRevision || "").trim();
  if (!/^[a-f0-9]{64}$/.test(expectedRevision)) {
    throw queueError("runtime_task_queue_revision_invalid");
  }
  if (!Array.isArray(value.orderedTaskIds) || value.orderedTaskIds.length < 2 ||
    value.orderedTaskIds.length > 100) {
    throw queueError("runtime_task_queue_order_invalid");
  }
  const orderedTaskIds = value.orderedTaskIds.map((taskId) => requiredToken(taskId, "task_id", 128));
  if (new Set(orderedTaskIds).size !== orderedTaskIds.length) {
    throw queueError("runtime_task_queue_order_duplicate");
  }
  return Object.freeze({
    contractVersion: CURRENT_USER_RUNTIME_TASK_QUEUE_REORDER_CONTRACT_VERSION,
    employeeId,
    expectedRevision,
    orderedTaskIds: Object.freeze(orderedTaskIds),
  });
}

function projectCurrentUserRuntimeTaskPage({
  tasks = [],
  employeeDirectory = [],
  projectTask,
  queueSnapshotComplete = true,
  excludedTaskTypes = [],
} = {}) {
  if (!Array.isArray(tasks) || !Array.isArray(employeeDirectory) || typeof projectTask !== "function") {
    throw new TypeError("current-user runtime task page dependencies are invalid");
  }
  const employeeById = new Map(employeeDirectory.map((employee) => {
    const id = requiredToken(employee?.id, "employee_id", 160);
    return [id, Object.freeze({
      id,
      name: requiredDisplayName(employee?.name || employee?.displayName || id),
      version: optionalToken(employee?.version, 80),
    })];
  }));
  const tasksByEmployee = new Map();
  const excluded = new Set(normalizeExcludedTaskTypes(excludedTaskTypes));
  for (const task of tasks) {
    const employee = employeeById.get(String(task?.employeeId || ""));
    if (!employee) throw queueError("runtime_task_queue_employee_mismatch");
    if (!Number.isSafeInteger(task?.queueOrder) || task.queueOrder <= 0 ||
      !Number.isSafeInteger(task?.revision) || task.revision <= 0) {
      throw queueError("runtime_task_queue_authority_invalid");
    }
    const laneTasks = tasksByEmployee.get(employee.id) || [];
    laneTasks.push(task);
    tasksByEmployee.set(employee.id, laneTasks);
  }

  const queues = [];
  const projectedTasks = [];
  for (const employee of employeeById.values()) {
    const laneTasks = tasksByEmployee.get(employee.id) || [];
    if (!laneTasks.length) continue;
    const running = laneTasks.filter((task) => ACTIVE_STATUSES.has(task.status))
      .sort(compareTaskAuthority);
    const queued = laneTasks.filter((task) => task.status === "queued")
      .sort(compareTaskAuthority);
    const settled = laneTasks.filter((task) => task.status !== "queued" && !ACTIVE_STATUSES.has(task.status))
      .sort((left, right) => compareText(right.updatedAt, left.updatedAt) || compareTaskAuthority(left, right));
    const revision = currentUserQueueRevision(queued);
    const visible = (task) => !excluded.has(task.taskType);
    const visibleQueued = queued.filter(visible);
    const visibleRunning = running.filter(visible);
    const visibleSettled = settled.filter(visible);
    if (!visibleQueued.length && !visibleRunning.length && !visibleSettled.length) continue;
    // Keep physical CAS authority, but v1 positions index the visible task ids.
    const completeLane = queueSnapshotComplete && visibleQueued.length === queued.length;
    const reorderable = completeLane && queued.length > 1 && queued.length <= 100;
    const reorderReason = !completeLane
      ? "snapshot_incomplete"
      : queued.length > 100
        ? "lane_too_large"
        : queued.length > 1 ? "ready" : "insufficient_tasks";
    const positionByTaskId = new Map(visibleQueued.map((task, index) => [task.taskId, index + 1]));
    queues.push(Object.freeze({
      contractVersion: CURRENT_USER_RUNTIME_TASK_QUEUE_CONTRACT_VERSION,
      employee,
      runningTaskIds: Object.freeze(visibleRunning.map((task) => task.taskId)),
      queuedTaskIds: Object.freeze(visibleQueued.map((task) => task.taskId)),
      revision,
      reorderable,
      reorderReason,
    }));
    for (const task of [...visibleRunning, ...visibleQueued, ...visibleSettled]) {
      const projected = projectTask(task, employee);
      projectedTasks.push(Object.freeze({
        ...projected,
        queue: Object.freeze({
          contractVersion: CURRENT_USER_RUNTIME_TASK_QUEUE_CONTRACT_VERSION,
          lane: "employee",
          position: positionByTaskId.get(task.taskId) || null,
          revision,
          reorderable: task.status === "queued" && reorderable,
        }),
      }));
    }
  }
  return Object.freeze({
    contractVersion: CURRENT_USER_RUNTIME_TASKS_CONTRACT_VERSION,
    queues: Object.freeze(queues),
    tasks: Object.freeze(projectedTasks),
    privacyBoundary: "仅返回当前用户 canonical 任务、安全状态、员工归属和 bounded 队列引用；不返回原始输入、输出、Prompt、Tool payload、路径、命令、凭据或异常。",
  });
}

function normalizeExcludedTaskTypes(value) {
  if (!Array.isArray(value) || value.length > 20) throw queueError("runtime_task_queue_type_filter_invalid");
  return Array.from(new Set(value.map(type => requiredToken(type, "task_type", 120))));
}

function currentUserQueueRevision(tasks) {
  const canonical = tasks.map((task) => [
    requiredToken(task.taskId, "task_id", 128),
    requiredToken(task.status, "task_status", 40),
    positiveInteger(task.revision, "task_revision"),
  ]);
  return crypto.createHash("sha256")
    .update(JSON.stringify([CURRENT_USER_RUNTIME_TASK_QUEUE_CONTRACT_VERSION, canonical]))
    .digest("hex");
}

function compareTaskAuthority(left, right) {
  return left.queueOrder - right.queueOrder || compareText(left.taskId, right.taskId);
}

function compareText(left, right) {
  return String(left || "").localeCompare(String(right || ""));
}

function requiredToken(value, field, maxLength) {
  const normalized = String(value || "").trim();
  if (!normalized || normalized.length > maxLength || /[\r\n\0]/.test(normalized)) {
    throw queueError(`runtime_task_queue_${field}_invalid`);
  }
  return normalized;
}

function optionalToken(value, maxLength) {
  const normalized = String(value || "").trim();
  if (!normalized) return "";
  if (normalized.length > maxLength || /[\r\n\0]/.test(normalized)) {
    throw queueError("runtime_task_queue_employee_version_invalid");
  }
  return normalized;
}

function requiredDisplayName(value) {
  const normalized = String(value || "").trim();
  if (!normalized || normalized.length > 120 || /[\r\n\0]/.test(normalized)) {
    throw queueError("runtime_task_queue_employee_name_invalid");
  }
  return normalized;
}

function positiveInteger(value, field) {
  if (!Number.isSafeInteger(value) || value <= 0) throw queueError(`runtime_task_queue_${field}_invalid`);
  return value;
}

function queueError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

export {
  CURRENT_USER_RUNTIME_TASK_QUEUE_CONTRACT_VERSION,
  CURRENT_USER_RUNTIME_TASK_QUEUE_REORDER_CONTRACT_VERSION,
  CURRENT_USER_RUNTIME_TASKS_CONTRACT_VERSION,
  currentUserQueueRevision,
  normalizeExcludedTaskTypes,
  normalizeRuntimeTaskQueueReorderRequest,
  projectCurrentUserRuntimeTaskPage,
};
