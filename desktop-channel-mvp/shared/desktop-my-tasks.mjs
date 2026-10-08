import { normalizeDesktopTaskActivitySnapshot } from "./desktop-task-activity.mjs";
import { normalizeDesktopTaskProvenance } from "./desktop-task-provenance.mjs";
import {
  desktopTaskOutputManifest,
  desktopTaskTimelineView,
  normalizeDesktopTaskEvent,
} from "./desktop-task-timeline.mjs";

const PAGE_FIELDS = new Set(["ok", "contractVersion", "privacyBoundary", "queues", "tasks"]);
const TASK_FIELDS = new Set([
  "id", "contractVersion", "revision", "employeeId", "employeeName", "employeeVersion", "sourceSystemId",
  "taskType", "taskTitle", "problemSummary", "queueLane", "status", "statusLabel",
  "waitReasonCode", "submittedBy", "submittedAt", "queuedAt", "startedAt", "completedAt",
  "failedAt", "canceledAt", "updatedAt", "nextGate", "feedback", "trigger", "execution",
  "warnings", "queue",
]);
const QUEUE_FIELDS = new Set([
  "contractVersion", "employee", "runningTaskIds", "queuedTaskIds", "revision",
  "reorderable", "reorderReason",
]);
const TASK_QUEUE_FIELDS = new Set(["contractVersion", "lane", "position", "revision", "reorderable"]);
const EMPLOYEE_FIELDS = new Set(["id", "name", "version"]);
const FEEDBACK_FIELDS = new Set([
  "contractVersion", "sourceChannel", "availability", "status", "rating", "qualityEventId",
  "diagnosticChainVersion", "receivedAt", "updatedAt",
]);
const FEEDBACK_RATINGS = new Set(["helpful", "not_helpful"]);
const FEEDBACK_REASON_CODES = new Set(["not_resolved", "missing_context", "needs_human_review", "other"]);
const FEEDBACK_STATUSES = new Set(["quality_ok", "pending_quality_review", "quality_store_unavailable"]);
const FEEDBACK_CONTRACTS = new Set(["runtime-task-feedback.v1", "feishu-answer-feedback.v1"]);
const STATUSES = new Set([
  "blocked", "canceled", "completed", "failed", "lost", "pending_file_intake",
  "pending_invocation_check", "pending_remote_resource", "queued", "rejected", "running",
  "timeout", "waiting",
]);
const ACTIVE_STATUSES = new Set([
  "pending_file_intake",
  "pending_invocation_check",
  "pending_remote_resource",
  "running",
  "waiting",
]);

export function isDesktopMyTaskActiveStatus(status) {
  return ACTIVE_STATUSES.has(status);
}

export function isDesktopMyTaskCancelableStatus(status) {
  return status === "queued" || isDesktopMyTaskActiveStatus(status);
}

export function normalizeDesktopMyTasksPage(value) {
  requireObject(value, "desktop_my_tasks_page_invalid");
  requireKnownFields(value, PAGE_FIELDS, "desktop_my_tasks_page_field_unsupported");
  if (value.ok !== true || value.contractVersion !== "current-user-runtime-tasks.v1") {
    throw taskPageError("desktop_my_tasks_contract_unsupported");
  }
  const queues = requiredArray(value.queues, 100, "desktop_my_tasks_queues_invalid")
    .map(normalizeQueue);
  const queueByEmployee = new Map(queues.map((queue) => [queue.employee.id, queue]));
  if (queueByEmployee.size !== queues.length) throw taskPageError("desktop_my_tasks_employee_duplicate");
  const tasks = requiredArray(value.tasks, 500, "desktop_my_tasks_tasks_invalid")
    .map((task) => normalizeTask(task, queueByEmployee));
  if (new Set(tasks.map((task) => task.id)).size !== tasks.length) {
    throw taskPageError("desktop_my_tasks_task_duplicate");
  }
  for (const queue of queues) {
    const laneTasks = tasks.filter((task) => task.employeeId === queue.employee.id);
    const runningTaskIds = laneTasks.filter((task) => isDesktopMyTaskActiveStatus(task.status)).map((task) => task.id);
    const queuedTasks = laneTasks.filter((task) => task.status === "queued")
      .sort((left, right) => left.queue.position - right.queue.position);
    const queuedTaskIds = queuedTasks.map((task) => task.id);
    const exactRunning = sameArray(queue.runningTaskIds, runningTaskIds);
    const exactQueued = sameArray(queue.queuedTaskIds, queuedTaskIds) && queuedTasks.every((task, index) =>
      task.queue.position === index + 1
    );
    const expectedReorderable = queue.reorderReason === "ready" && queuedTasks.length >= 2 && queuedTasks.length <= 100;
    const taskFlagsValid = laneTasks.every((task) => task.status === "queued"
      ? task.queue.reorderable === expectedReorderable
      : task.queue.position === null && task.queue.reorderable === false);
    if (!exactRunning || !exactQueued || !taskFlagsValid || queue.reorderable !== expectedReorderable) {
      throw taskPageError("desktop_my_tasks_queue_task_mismatch");
    }
  }
  return Object.freeze({
    contractVersion: value.contractVersion,
    queues: Object.freeze(queues),
    tasks: Object.freeze(tasks),
    privacyBoundary: cleanText(value.privacyBoundary, 400),
  });
}

function sameArray(left, right) {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

export function desktopMyTasksReorderRequest({ employeeId, expectedRevision, orderedTaskIds } = {}) {
  const ids = requiredArray(orderedTaskIds, 100, "desktop_my_tasks_reorder_invalid")
    .map((taskId) => cleanId(taskId, "desktop_my_tasks_task_id_invalid"));
  if (ids.length < 2 || new Set(ids).size !== ids.length) {
    throw taskPageError("desktop_my_tasks_reorder_invalid");
  }
  return Object.freeze({
    contractVersion: "current-user-runtime-task-queue-reorder.v1",
    employeeId: cleanId(employeeId, "desktop_my_tasks_employee_id_invalid"),
    expectedRevision: cleanRevision(expectedRevision),
    orderedTaskIds: Object.freeze(ids),
  });
}

export function desktopMyTaskReference(value = {}) {
  return Object.freeze({
    employeeId: cleanId(value.employeeId, "desktop_my_tasks_employee_id_invalid"),
    taskId: cleanId(value.taskId, "desktop_my_tasks_task_id_invalid"),
  });
}

export function desktopMyTaskFeedbackRequest(value = {}) {
  const reference = desktopMyTaskReference(value);
  const rating = String(value.rating || "").trim();
  const reasonCode = String(value.reasonCode || "").trim();
  const idempotencyKey = String(value.idempotencyKey || "").trim();
  if (!FEEDBACK_RATINGS.has(rating)) throw taskPageError("desktop_my_task_feedback_rating_invalid");
  if ((rating === "helpful" && reasonCode) ||
    (rating === "not_helpful" && !FEEDBACK_REASON_CODES.has(reasonCode))) {
    throw taskPageError("desktop_my_task_feedback_reason_invalid");
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9._:@-]{0,127}$/.test(idempotencyKey)) {
    throw taskPageError("desktop_my_task_feedback_idempotency_key_invalid");
  }
  return Object.freeze({
    ...reference,
    expectedRevision: cleanTaskRevision(value.expectedRevision),
    idempotencyKey,
    rating,
    reasonCode,
    channelId: "desktop",
  });
}

export function normalizeDesktopMyTaskFeedback(value) {
  if (value === null || value === undefined) return null;
  requireObject(value, "desktop_my_task_feedback_invalid");
  requireKnownFields(value, FEEDBACK_FIELDS, "desktop_my_task_feedback_field_unsupported");
  if (!FEEDBACK_CONTRACTS.has(value.contractVersion) || value.availability !== "available" ||
    !FEEDBACK_STATUSES.has(value.status) || !FEEDBACK_RATINGS.has(value.rating)) {
    throw taskPageError("desktop_my_task_feedback_contract_invalid");
  }
  const sourceChannel = cleanCode(value.sourceChannel, "desktop_my_task_feedback_channel_invalid");
  const qualityEventId = cleanOptionalId(value.qualityEventId, "desktop_my_task_feedback_quality_event_invalid");
  const diagnosticChainVersion = cleanText(value.diagnosticChainVersion, 80);
  if (value.rating === "helpful" && value.status !== "quality_ok") {
    throw taskPageError("desktop_my_task_feedback_positive_state_invalid");
  }
  if (value.rating === "not_helpful" && !["pending_quality_review", "quality_store_unavailable"].includes(value.status)) {
    throw taskPageError("desktop_my_task_feedback_negative_state_invalid");
  }
  return Object.freeze({
    contractVersion: value.contractVersion,
    sourceChannel,
    availability: value.availability,
    status: value.status,
    rating: value.rating,
    qualityEventId,
    diagnosticChainVersion,
    receivedAt: cleanTimestamp(value.receivedAt),
    updatedAt: cleanTimestamp(value.updatedAt),
  });
}

export function normalizeDesktopMyTaskFeedbackReceipt(value, request = {}) {
  requireObject(value, "desktop_my_task_feedback_receipt_invalid");
  if (value.ok !== true || value.contractVersion !== "digital-employee-runtime-task.v2") {
    throw taskPageError("desktop_my_task_feedback_receipt_contract_invalid");
  }
  const normalizedRequest = desktopMyTaskFeedbackRequest(request);
  requireObject(value.task, "desktop_my_task_feedback_receipt_task_invalid");
  if (cleanId(value.task.id, "desktop_my_tasks_task_id_invalid") !== normalizedRequest.taskId ||
    cleanId(value.task.employeeId, "desktop_my_tasks_employee_id_invalid") !== normalizedRequest.employeeId ||
    cleanTaskRevision(value.task.revision) !== normalizedRequest.expectedRevision) {
    throw taskPageError("desktop_my_task_feedback_receipt_identity_mismatch");
  }
  const feedback = normalizeDesktopMyTaskFeedback(value.task.feedback);
  if (!feedback || feedback.rating !== normalizedRequest.rating) {
    throw taskPageError("desktop_my_task_feedback_receipt_rating_mismatch");
  }
  if (feedback.contractVersion !== "runtime-task-feedback.v1" ||
    (feedback.rating === "helpful" && (feedback.qualityEventId || feedback.diagnosticChainVersion)) ||
    (feedback.rating === "not_helpful" && (feedback.status !== "pending_quality_review" || !feedback.qualityEventId ||
      feedback.diagnosticChainVersion !== "runtime-task-feedback-diagnostic-chain.v1"))) {
    throw taskPageError("desktop_my_task_feedback_receipt_quality_boundary_invalid");
  }
  return Object.freeze({
    employeeId: normalizedRequest.employeeId,
    taskId: normalizedRequest.taskId,
    revision: normalizedRequest.expectedRevision,
    feedback,
  });
}

export function desktopMyTaskFollowRequest(task = {}, detail = null) {
  if (!isDesktopMyTaskActiveStatus(task.status)) return null;
  const reference = desktopMyTaskReference({ employeeId: task.employeeId, taskId: task.id });
  const afterSeq = cleanSequence(detail?.lastSeq || 0);
  return Object.freeze({
    ...reference,
    afterSeq,
    purpose: "my_tasks",
    streamId: `my-task:${reference.taskId}`,
  });
}

export function normalizeDesktopMyTaskEventPage(value, {
  afterSeq = 0,
  employeeId = "",
  taskId = "",
} = {}) {
  requireObject(value, "desktop_my_task_detail_page_invalid");
  if (value.ok !== true || value.contractVersion !== "digital-employee-task-events.v1") {
    throw taskPageError("desktop_my_task_detail_contract_unsupported");
  }
  const reference = desktopMyTaskReference({ employeeId, taskId });
  const cursor = cleanSequence(afterSeq);
  requireObject(value.task, "desktop_my_task_detail_task_invalid");
  if (cleanId(value.task.id, "desktop_my_tasks_task_id_invalid") !== reference.taskId) {
    throw taskPageError("desktop_my_task_detail_identity_mismatch");
  }
  const events = requiredArray(value.events, 500, "desktop_my_task_detail_events_invalid")
    .map((event) => normalizeDesktopTaskEvent(event, { expectedTaskId: reference.taskId }));
  if (events.some((event) => !event)) throw taskPageError("desktop_my_task_detail_event_invalid");
  for (let index = 0; index < events.length; index += 1) {
    if (events[index].seq !== cursor + index + 1) {
      throw taskPageError("desktop_my_task_detail_sequence_gap");
    }
  }
  const nextAfterSeq = cleanSequence(value.nextAfterSeq);
  const latestSeq = cleanSequence(value.latestSeq);
  const expectedNext = events.at(-1)?.seq || cursor;
  if (value.resetRequired === true || nextAfterSeq !== expectedNext || latestSeq < nextAfterSeq ||
    value.hasMore !== (nextAfterSeq < latestSeq) ||
    typeof value.hasMore !== "boolean" || typeof value.terminal !== "boolean") {
    throw taskPageError("desktop_my_task_detail_cursor_invalid");
  }
  const artifacts = events.filter((event) => event.eventType === "task.artifact_available")
    .map((event) => Object.freeze({
      employeeId: reference.employeeId,
      taskId: reference.taskId,
      artifactId: event.data.artifactId,
    }));
  return Object.freeze({
    contractVersion: "desktop-my-task-event-page.v1",
    ...reference,
    events: Object.freeze(events),
    artifacts: Object.freeze(artifacts),
    resultAvailable: events.some((event) => event.eventType === "task.result_available"),
    taskStatus: cleanTaskStatus(value.task.status),
    lastSeq: nextAfterSeq,
    latestSeq,
    terminal: value.terminal,
    hasMore: value.hasMore,
  });
}

export function normalizeDesktopMyTaskResult(value, { employeeId = "", taskId = "" } = {}) {
  requireObject(value, "desktop_my_task_result_invalid");
  const reference = desktopMyTaskReference({ employeeId, taskId });
  if (value.ok !== true || value.contractVersion !== "digital-employee-task-result.v1" ||
    value.employeeId !== reference.employeeId || value.taskId !== reference.taskId) {
    throw taskPageError("desktop_my_task_result_identity_mismatch");
  }
  requireObject(value.result, "desktop_my_task_result_invalid");
  if (value.result.role !== "assistant") throw taskPageError("desktop_my_task_result_role_invalid");
  return Object.freeze({
    text: cleanResultText(value.result.text),
    createdAt: cleanTimestamp(value.result.createdAt),
  });
}

export function projectDesktopMyTaskDetail({ employeeId, taskId, events = [], result = null, activitySnapshot = null, provenanceSnapshot = null } = {}) {
  const reference = desktopMyTaskReference({ employeeId, taskId });
  const normalizedEvents = requiredArray(events, 10_000, "desktop_my_task_detail_events_invalid")
    .map((event) => normalizeDesktopTaskEvent(event, { expectedTaskId: reference.taskId }));
  if (normalizedEvents.some((event) => !event)) throw taskPageError("desktop_my_task_detail_event_invalid");
  const timeline = desktopTaskTimelineView(normalizedEvents);
  const artifacts = normalizedEvents.filter((event) => event.eventType === "task.artifact_available")
    .map((event) => Object.freeze({ ...reference, artifactId: event.data.artifactId }));
  const outputManifest = desktopTaskOutputManifest(normalizedEvents, {
    employeeId: reference.employeeId,
    result,
  });
  return Object.freeze({
    contractVersion: "desktop-my-task-detail.v1",
    ...reference,
    status: timeline.status,
    lastSeq: timeline.lastSeq,
    events: Object.freeze(normalizedEvents),
    result,
    activitySnapshot: normalizeDesktopTaskActivitySnapshot(activitySnapshot, { expectedTaskId: reference.taskId }),
    provenanceSnapshot: normalizeDesktopTaskProvenance(provenanceSnapshot, { expectedTaskId: reference.taskId }),
    artifacts: Object.freeze(artifacts),
    outputManifest,
    privacyBoundary: "仅展示 canonical 安全事件、调用与 Skill 来源投影、最终用户可见结果和 Artifact 授权引用；不展示 Prompt、推理、Tool payload、命令、路径、凭据或原始异常。",
  });
}

function normalizeQueue(value) {
  requireObject(value, "desktop_my_tasks_queue_invalid");
  requireKnownFields(value, QUEUE_FIELDS, "desktop_my_tasks_queue_field_unsupported");
  if (value.contractVersion !== "current-user-runtime-task-queue.v1") {
    throw taskPageError("desktop_my_tasks_queue_contract_unsupported");
  }
  requireObject(value.employee, "desktop_my_tasks_employee_invalid");
  requireKnownFields(value.employee, EMPLOYEE_FIELDS, "desktop_my_tasks_employee_field_unsupported");
  const employee = Object.freeze({
    id: cleanId(value.employee.id, "desktop_my_tasks_employee_id_invalid"),
    name: cleanText(value.employee.name, 120, true),
    version: cleanText(value.employee.version, 80),
  });
  const runningTaskIds = requiredArray(value.runningTaskIds, 50, "desktop_my_tasks_running_invalid")
    .map((taskId) => cleanId(taskId, "desktop_my_tasks_task_id_invalid"));
  const queuedTaskIds = requiredArray(value.queuedTaskIds, 500, "desktop_my_tasks_queued_invalid")
    .map((taskId) => cleanId(taskId, "desktop_my_tasks_task_id_invalid"));
  if (new Set([...runningTaskIds, ...queuedTaskIds]).size !== runningTaskIds.length + queuedTaskIds.length) {
    throw taskPageError("desktop_my_tasks_queue_task_duplicate");
  }
  return Object.freeze({
    contractVersion: value.contractVersion,
    employee,
    runningTaskIds: Object.freeze(runningTaskIds),
    queuedTaskIds: Object.freeze(queuedTaskIds),
    revision: cleanRevision(value.revision),
    reorderable: value.reorderable === true,
    reorderReason: cleanCode(value.reorderReason, "desktop_my_tasks_reorder_reason_invalid"),
  });
}

function normalizeTask(value, queueByEmployee) {
  requireObject(value, "desktop_my_tasks_task_invalid");
  requireKnownFields(value, TASK_FIELDS, "desktop_my_tasks_task_field_unsupported");
  if (value.contractVersion !== "digital-employee-runtime-task.v2" || !STATUSES.has(value.status)) {
    throw taskPageError("desktop_my_tasks_task_contract_invalid");
  }
  const employeeId = cleanId(value.employeeId, "desktop_my_tasks_employee_id_invalid");
  const queue = queueByEmployee.get(employeeId);
  if (!queue) throw taskPageError("desktop_my_tasks_task_employee_mismatch");
  requireObject(value.queue, "desktop_my_tasks_task_queue_invalid");
  requireKnownFields(value.queue, TASK_QUEUE_FIELDS, "desktop_my_tasks_task_queue_field_unsupported");
  if (value.queue.contractVersion !== "current-user-runtime-task-queue.v1" ||
    value.queue.lane !== "employee" || value.queue.revision !== queue.revision) {
    throw taskPageError("desktop_my_tasks_task_queue_mismatch");
  }
  const position = value.queue.position === null ? null : Number(value.queue.position);
  if (position !== null && (!Number.isSafeInteger(position) || position <= 0)) {
    throw taskPageError("desktop_my_tasks_task_position_invalid");
  }
  return Object.freeze({
    id: cleanId(value.id, "desktop_my_tasks_task_id_invalid"),
    revision: cleanTaskRevision(value.revision),
    employeeId,
    employeeName: cleanText(value.employeeName || queue.employee.name, 120, true),
    taskTitle: cleanText(value.taskTitle, 500),
    sourceSystemId: cleanOptionalId(value.sourceSystemId, "desktop_my_tasks_source_system_id_invalid"),
    taskType: cleanOptionalId(value.taskType, "desktop_my_tasks_task_type_invalid"),
    status: value.status,
    statusLabel: cleanText(value.statusLabel, 40, true),
    feedback: normalizeDesktopMyTaskFeedback(value.feedback),
    nextGate: cleanText(value.nextGate, 240),
    submittedAt: cleanTimestamp(value.submittedAt),
    startedAt: cleanTimestamp(value.startedAt),
    finishedAt: cleanTimestamp(value.completedAt || value.failedAt || value.canceledAt),
    updatedAt: cleanTimestamp(value.updatedAt),
    queue: Object.freeze({
      position,
      revision: queue.revision,
      reorderable: value.queue.reorderable === true && queue.reorderable,
    }),
  });
}

function requireKnownFields(value, allowed, code) {
  if (Object.keys(value).some((field) => !allowed.has(field))) throw taskPageError(code);
}

function requireObject(value, code) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw taskPageError(code);
}

function requiredArray(value, max, code) {
  if (!Array.isArray(value) || value.length > max) throw taskPageError(code);
  return value;
}

function cleanId(value, code) {
  const text = String(value || "").trim();
  if (!/^[a-zA-Z0-9_.:-]{1,160}$/.test(text)) throw taskPageError(code);
  return text;
}

function cleanOptionalId(value, code) {
  const text = String(value || "").trim();
  return text ? cleanId(text, code) : "";
}

function cleanRevision(value) {
  const text = String(value || "").trim();
  if (!/^[a-f0-9]{64}$/.test(text)) throw taskPageError("desktop_my_tasks_revision_invalid");
  return text;
}

function cleanTaskRevision(value) {
  const revision = Number(value);
  if (!Number.isSafeInteger(revision) || revision <= 0) {
    throw taskPageError("desktop_my_tasks_task_revision_invalid");
  }
  return revision;
}

function cleanCode(value, code) {
  const text = String(value || "").trim();
  if (!/^[a-z0-9_]{1,80}$/.test(text)) throw taskPageError(code);
  return text;
}

function cleanText(value, maxLength, required = false) {
  const text = String(value || "").replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim();
  if ((required && !text) || text.length > maxLength) throw taskPageError("desktop_my_tasks_text_invalid");
  return text;
}

function cleanTimestamp(value) {
  const text = String(value || "").trim();
  if (!text) return "";
  if (!Number.isFinite(Date.parse(text)) || text.length > 40) throw taskPageError("desktop_my_tasks_timestamp_invalid");
  return text;
}

function cleanSequence(value) {
  const sequence = Number(value);
  if (!Number.isSafeInteger(sequence) || sequence < 0) {
    throw taskPageError("desktop_my_task_detail_sequence_invalid");
  }
  return sequence;
}

function cleanTaskStatus(value) {
  const status = String(value || "").trim();
  if (![...STATUSES, "timed_out"].includes(status)) {
    throw taskPageError("desktop_my_task_detail_status_invalid");
  }
  return status;
}

function cleanResultText(value) {
  const text = String(value || "").replace(/\r\n?/g, "\n")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "").trim();
  if (!text || text.length > 200_000) throw taskPageError("desktop_my_task_result_text_invalid");
  return text;
}

function taskPageError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}
