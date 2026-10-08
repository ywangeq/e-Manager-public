const DEFAULT_MAX_PARALLEL_WORKERS = 1;
const DEFAULT_TASK_BUFFER_QUEUE_SIZE = 0;
const DEFAULT_TASK_BUFFER_MINUTES = 240;

const RUNNING_STATUSES = new Set(["running"]);
const WAITING_STATUSES = new Set([
  "pending_invocation_check",
  "pending_file_intake",
  "pending_remote_resource",
  "queued",
  "received",
  "retrying",
]);
const CAPACITY_WAITING_STATUSES = new Set([
  "pending_invocation_check",
  "pending_remote_resource",
  "queued",
  "received",
  "retrying",
]);
const ACCEPTED_STATUSES = new Set([...RUNNING_STATUSES, ...WAITING_STATUSES]);

function runtimeQueuePolicyForEmployee(employee = {}) {
  const binding = {
    ...(employee.modelBinding || {}),
    ...(employee.runtimeBinding || {}),
  };
  const maxParallelWorkers = positiveInteger(
    binding.maxParallelWorkers ?? binding.reservedWorkerSlots,
    DEFAULT_MAX_PARALLEL_WORKERS,
  );
  const taskBufferQueueSize = positiveInteger(
    binding.taskBufferQueueSize ?? binding.maxBufferedTasks ?? binding.bufferQueueSize,
    DEFAULT_TASK_BUFFER_QUEUE_SIZE,
    0,
  );
  const taskBufferMinutes = positiveInteger(
    binding.taskBufferMinutes ?? binding.taskTimeoutMinutes,
    DEFAULT_TASK_BUFFER_MINUTES,
  );
  return {
    maxParallelWorkers,
    taskBufferQueueSize,
    taskBufferMinutes,
    totalTaskCapacity: maxParallelWorkers + taskBufferQueueSize,
  };
}

function prepareRuntimeTaskAdmission({ store, employee = {}, now = new Date().toISOString() } = {}) {
  const expired = expireRuntimeQueueTasks({ store, employee, now });
  const queueState = summarizeRuntimeTaskCapacity(expired.tasks, expired.policy);
  if (queueState.acceptedTaskCount >= expired.policy.totalTaskCapacity) {
    const message = taskQueueFullNoticeText(expired.policy, queueState);
    return {
      accepted: false,
      reason: "runtime_queue_full",
      message,
      nextGate: message,
      policy: expired.policy,
      queueState,
      expiredTasks: expired.expiredTasks,
    };
  }
  return {
    accepted: true,
    reason: "runtime_queue_has_capacity",
    message: "任务已接收，将按并行 worker 和队列容量自动处理。",
    nextGate: "任务已接收，将按并行 worker 和队列容量自动处理。",
    policy: expired.policy,
    queueState,
    expiredTasks: expired.expiredTasks,
  };
}

function expireRuntimeQueueTasks({ store, employee = {}, tasks = null } = {}) {
  const policy = runtimeQueuePolicyForEmployee(employee);
  const employeeId = cleanId(employee.id);
  const scopedTasks = (items = []) => employeeId
    ? items.filter((task) => cleanId(task.employeeId) === employeeId)
    : items;
  const sourceTasks = scopedTasks(Array.isArray(tasks)
    ? tasks
    : typeof store?.readRuntimeTasks === "function" ? store.readRuntimeTasks() : []);
  return { tasks: sourceTasks, expiredTasks: [], policy };
}

function summarizeRuntimeTaskCapacity(tasks = [], policy = {}) {
  const queuePolicy = policy.totalTaskCapacity ? policy : runtimeQueuePolicyForEmployee();
  const runningTaskCount = tasks.filter((task) => RUNNING_STATUSES.has(String(task.status || ""))).length;
  const waitingTaskCount = tasks.filter(isRuntimeTaskCapacityConsuming).length;
  const acceptedTaskCount = runningTaskCount + waitingTaskCount;
  return {
    maxParallelWorkers: queuePolicy.maxParallelWorkers,
    taskBufferQueueSize: queuePolicy.taskBufferQueueSize,
    taskBufferMinutes: queuePolicy.taskBufferMinutes,
    totalTaskCapacity: queuePolicy.totalTaskCapacity,
    runningTaskCount,
    waitingTaskCount,
    acceptedTaskCount,
    availableTaskSlots: Math.max(0, queuePolicy.totalTaskCapacity - acceptedTaskCount),
  };
}

function isRuntimeTaskAccepted(task = {}) {
  return ACCEPTED_STATUSES.has(String(task.status || ""));
}

function isRuntimeTaskWaiting(task = {}) {
  return WAITING_STATUSES.has(String(task.status || ""));
}

function isRuntimeTaskCapacityConsuming(task = {}) {
  return CAPACITY_WAITING_STATUSES.has(String(task.status || ""));
}

function taskQueueFullNoticeText(policy = {}, queueState = {}) {
  const safePolicy = policy.totalTaskCapacity ? policy : runtimeQueuePolicyForEmployee();
  const retryAfterMinutes = Math.min(30, Math.max(5, positiveInteger(safePolicy.taskBufferMinutes, 30)));
  return `当前模型处理繁忙，请约 ${retryAfterMinutes} 分钟后再试。`;
}

function taskTimeoutNoticeText(policy = {}) {
  const safePolicy = policy.totalTaskCapacity ? policy : runtimeQueuePolicyForEmployee();
  return `任务排队已超过 ${safePolicy.taskBufferMinutes} 分钟；任务仍保留在队列中，会在 Worker 空出后继续启动。你可以继续等待，或联系管理员调整 Lane 并发 / 最大排队数。`;
}

function positiveInteger(value, fallback, minimum = 1) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(minimum, Math.floor(number));
}

function cleanId(value = "") {
  return String(value || "").trim();
}

export {
  expireRuntimeQueueTasks,
  isRuntimeTaskAccepted,
  isRuntimeTaskWaiting,
  prepareRuntimeTaskAdmission,
  runtimeQueuePolicyForEmployee,
  summarizeRuntimeTaskCapacity,
  taskQueueFullNoticeText,
  taskTimeoutNoticeText,
};
