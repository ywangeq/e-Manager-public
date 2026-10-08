import crypto from "node:crypto";

const CONTRACT_VERSION = "department-task-health-inspection.v1";
const DEFINITION_VERSION = "department-task-health-inspection-definition.v1";
const MAX_TASK_REFS_PER_CATEGORY = 20;
const TOKEN = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,159}$/;
const ELIGIBLE_LIFECYCLE_STATUSES = new Set(["在线", "试运行"]);
const KNOWN_LIFECYCLE_STATUSES = new Set(["在线", "试运行", "待人员审批", "停用"]);
const ACTIVE_STATUSES = new Set(["queued", "running", "waiting"]);
const HEALTH_ATTENTION_STATUSES = new Set(["failed", "lost", "timed_out"]);
const SOURCE_STATES = new Set(["available", "partial_read", "unavailable"]);
const EVIDENCE_STATES = new Set(["available", "missing"]);

export function createDepartmentTaskHealthInspectionDefinition() {
  return deepFreeze({
    contractVersion: DEFINITION_VERSION,
    enabled: false,
    operatorEmployeeId: "workforce-admin",
    cohortRule: "employee.level=业务级 AND employee.status IN (在线,试运行)",
    sourceAuthority: "canonical_runtime_task_safe_projection",
    executionMode: "fixture_only",
    clock: "none",
    providerAccess: "none",
    toolAccess: "none",
    writeback: "none",
    externalNotification: "none",
    targetTaskMutation: "none",
  });
}

export function inspectDepartmentTaskHealth(value = {}) {
  exactObject(value, new Set([
    "directory", "directoryState", "observedAt", "overduePolicy", "sourceAsOf", "sourceState",
    "taskReferenceHmacKey", "tasks", "windowEnd", "windowStart",
  ]), "department_task_health_request_invalid");
  const observedAt = timestamp(value.observedAt, "observedAt");
  const windowStart = timestamp(value.windowStart, "windowStart");
  const windowEnd = timestamp(value.windowEnd, "windowEnd");
  if (Date.parse(windowStart) > Date.parse(windowEnd) || Date.parse(windowEnd) > Date.parse(observedAt)) {
    throw inspectionError("department_task_health_window_invalid");
  }
  const directoryState = enumValue(value.directoryState, SOURCE_STATES, "directoryState");
  const sourceState = enumValue(value.sourceState, SOURCE_STATES, "sourceState");
  const sourceAsOf = timestamp(value.sourceAsOf, "sourceAsOf");
  const referenceKey = hmacKey(value.taskReferenceHmacKey);
  const definition = createDepartmentTaskHealthInspectionDefinition();

  if (directoryState === "unavailable") {
    return result({
      definition,
      observedAt,
      sourceAsOf,
      sourceState,
      windowEnd,
      windowStart,
      scanState: "blocked",
      conclusionCode: "directory_unavailable",
      coverage: emptyCoverage(),
      counts: emptyCounts(),
      categories: [],
      dataState: "no_data",
    });
  }

  const cohort = freezeCohort(value.directory);
  const tasks = normalizeTasks(value.tasks, cohort.included);
  const overduePolicy = normalizeOverduePolicy(value.overduePolicy);
  const evaluation = evaluateTasks({
    observedAt,
    overduePolicy,
    referenceKey,
    tasks,
  });
  const categories = [...cohort.categories, ...evaluation.categories];
  const hasUnknown = directoryState === "partial_read" || sourceState !== "available" ||
    cohort.coverage.unknown > 0 || evaluation.unknownCount > 0;
  const dataState = evaluation.counts.total === 0 ? "no_data" : "has_data";
  const hasAttention = evaluation.counts.failed > 0 || evaluation.counts.lost > 0 ||
    evaluation.counts.timedOut > 0 || evaluation.counts.pendingQualityReview > 0 ||
    evaluation.counts.blocked > 0 || evaluation.counts.rejected > 0 || evaluation.counts.overdueActive > 0;
  const scanState = hasUnknown || dataState === "no_data"
    ? "unknown"
    : hasAttention ? "attention" : "healthy";
  const conclusionCode = scanState === "healthy" ? "no_attention_signal"
    : scanState === "attention" ? "attention_required"
      : dataState === "no_data" ? "no_data" : "evidence_incomplete";

  return result({
    definition,
    observedAt,
    sourceAsOf,
    sourceState,
    windowEnd,
    windowStart,
    scanState,
    conclusionCode,
    coverage: cohort.coverage,
    counts: evaluation.counts,
    categories,
    dataState,
  });
}

function freezeCohort(value) {
  if (!Array.isArray(value)) throw inspectionError("department_task_health_directory_invalid");
  const included = new Map();
  const categories = [];
  let excluded = 0;
  let unknown = 0;
  for (const item of value) {
    const employee = normalizeDirectoryEmployee(item);
    if (employee.level !== "业务级") {
      excluded += 1;
      continue;
    }
    if (!KNOWN_LIFECYCLE_STATUSES.has(employee.status) || !employee.version || !employee.ownerDepartmentId) {
      unknown += 1;
      categories.push(category("cohort_unknown", [], 1));
      continue;
    }
    if (!ELIGIBLE_LIFECYCLE_STATUSES.has(employee.status)) {
      excluded += 1;
      continue;
    }
    if (included.has(employee.employeeId)) throw inspectionError("department_task_health_directory_duplicate");
    included.set(employee.employeeId, employee);
  }
  return {
    included,
    categories,
    coverage: deepFreeze({
      cohortTotal: value.length,
      excluded,
      included: included.size,
      unknown,
    }),
  };
}

function normalizeDirectoryEmployee(value) {
  exactObject(value, new Set(["employeeId", "level", "ownerDepartmentId", "status", "version"]),
    "department_task_health_directory_invalid");
  const level = String(value.level || "").trim();
  if (!["业务级", "系统级"].includes(level)) {
    throw inspectionError("department_task_health_directory_invalid");
  }
  return {
    employeeId: token(value.employeeId, "employeeId"),
    level,
    ownerDepartmentId: optionalToken(value.ownerDepartmentId, "ownerDepartmentId"),
    status: String(value.status || "").trim(),
    version: optionalToken(value.version, "version"),
  };
}

function normalizeTasks(value, cohort) {
  if (!Array.isArray(value)) throw inspectionError("department_task_health_tasks_invalid");
  return value.map((item) => {
    exactObject(item, new Set([
      "activeSince", "employeeId", "employeeVersion", "evidenceState", "feedbackStatus", "status", "taskId",
    ]), "department_task_health_task_invalid");
    const employeeId = token(item.employeeId, "employeeId");
    const employeeVersion = token(item.employeeVersion, "employeeVersion");
    const activeSince = item.activeSince === null ? null : timestamp(item.activeSince, "activeSince");
    const status = String(item.status || "").trim();
    const feedbackStatus = item.feedbackStatus === null ? null : String(item.feedbackStatus || "").trim();
    const cohortEmployee = cohort.get(employeeId) || null;
    return deepFreeze({
      activeSince,
      cohortEmployee,
      employeeId,
      employeeVersion,
      evidenceState: enumValue(item.evidenceState, EVIDENCE_STATES, "evidenceState"),
      feedbackStatus,
      status,
      taskId: token(item.taskId, "taskId"),
    });
  });
}

function normalizeOverduePolicy(value) {
  if (value === null) return null;
  exactObject(value, new Set(["maxActiveAgeSeconds", "policyId", "policyVersion"]),
    "department_task_health_overdue_policy_invalid");
  return deepFreeze({
    maxActiveAgeSeconds: boundedInteger(value.maxActiveAgeSeconds, 1, 31 * 24 * 60 * 60,
      "maxActiveAgeSeconds"),
    policyId: token(value.policyId, "policyId"),
    policyVersion: token(value.policyVersion, "policyVersion"),
  });
}

function evaluateTasks({ observedAt, overduePolicy, referenceKey, tasks }) {
  const counts = emptyCounts();
  const categoryRefs = new Map();
  let unknownCount = 0;
  let oldestActiveAgeSeconds = null;
  for (const task of tasks) {
    counts.total += 1;
    if (!task.cohortEmployee || task.cohortEmployee.version !== task.employeeVersion) {
      unknownCount += 1;
      addReference(categoryRefs, "task_cohort_drift", task.taskId, referenceKey);
      continue;
    }
    if (task.evidenceState === "missing") {
      unknownCount += 1;
      addReference(categoryRefs, "runtime_evidence_missing", task.taskId, referenceKey);
    }
    if (task.feedbackStatus && task.feedbackStatus !== "pending_quality_review") {
      unknownCount += 1;
      addReference(categoryRefs, "quality_projection_unknown", task.taskId, referenceKey);
    }
    if (task.feedbackStatus === "pending_quality_review") {
      counts.pendingQualityReview += 1;
      addReference(categoryRefs, "pending_quality_review", task.taskId, referenceKey);
    }
    if (HEALTH_ATTENTION_STATUSES.has(task.status)) {
      if (task.status === "failed") counts.failed += 1;
      if (task.status === "lost") counts.lost += 1;
      if (task.status === "timed_out") counts.timedOut += 1;
      addReference(categoryRefs, "execution_attention", task.taskId, referenceKey);
      continue;
    }
    if (task.status === "completed") {
      counts.completed += 1;
      continue;
    }
    if (task.status === "blocked" || task.status === "rejected") {
      counts[task.status] += 1;
      addReference(categoryRefs, "governance_or_authorization_blocked", task.taskId, referenceKey);
      continue;
    }
    if (task.status === "canceled") {
      counts.canceled += 1;
      continue;
    }
    if (ACTIVE_STATUSES.has(task.status)) {
      counts.active += 1;
      if (!task.activeSince) {
        unknownCount += 1;
        addReference(categoryRefs, "active_age_missing", task.taskId, referenceKey);
        continue;
      }
      const ageSeconds = Math.max(0, Math.floor((Date.parse(observedAt) - Date.parse(task.activeSince)) / 1000));
      oldestActiveAgeSeconds = oldestActiveAgeSeconds === null
        ? ageSeconds : Math.max(oldestActiveAgeSeconds, ageSeconds);
      if (!overduePolicy) {
        unknownCount += 1;
        addReference(categoryRefs, "overdue_policy_missing", task.taskId, referenceKey);
      } else if (ageSeconds > overduePolicy.maxActiveAgeSeconds) {
        counts.overdueActive += 1;
        addReference(categoryRefs, "overdue_active", task.taskId, referenceKey);
      }
      continue;
    }
    unknownCount += 1;
    addReference(categoryRefs, "task_status_unknown", task.taskId, referenceKey);
  }
  counts.oldestActiveAgeSeconds = oldestActiveAgeSeconds;
  return {
    categories: [...categoryRefs.entries()].sort(([left], [right]) => left.localeCompare(right))
      .map(([categoryCode, taskRefs]) => category(categoryCode, taskRefs)),
    counts: deepFreeze(counts),
    unknownCount,
  };
}

function result({
  categories, conclusionCode, counts, coverage, dataState, definition, observedAt, scanState,
  sourceAsOf, sourceState, windowEnd, windowStart,
}) {
  return deepFreeze({
    contractVersion: CONTRACT_VERSION,
    categories: categories.map((item) => category(item.categoryCode, item.taskRefs, item.count)),
    conclusionCode,
    counts,
    coverage,
    dataState,
    definition,
    observedAt,
    scanState,
    sourceAsOf,
    sourceState,
    windowEnd,
    windowStart,
  });
}

function emptyCounts() {
  return {
    active: 0,
    blocked: 0,
    canceled: 0,
    completed: 0,
    failed: 0,
    lost: 0,
    oldestActiveAgeSeconds: null,
    overdueActive: 0,
    pendingQualityReview: 0,
    rejected: 0,
    timedOut: 0,
    total: 0,
  };
}

function emptyCoverage() {
  return deepFreeze({ cohortTotal: 0, excluded: 0, included: 0, unknown: 0 });
}

function category(categoryCode, taskRefs, count = taskRefs.length) {
  return deepFreeze({
    categoryCode,
    count,
    taskRefs: [...new Set(taskRefs)].sort().slice(0, MAX_TASK_REFS_PER_CATEGORY),
  });
}

function addReference(categories, categoryCode, taskId, key) {
  const reference = crypto.createHmac("sha256", key)
    .update(`department-task-health-reference.v1\0${taskId}`).digest("hex").slice(0, 24);
  const refs = categories.get(categoryCode) || [];
  refs.push(reference);
  categories.set(categoryCode, refs);
}

function exactObject(value, fields, code) {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
    (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)) {
    throw inspectionError(code);
  }
  const keys = Object.keys(value);
  if (keys.length !== fields.size || keys.some((key) => !fields.has(key))) {
    throw inspectionError(code);
  }
}

function enumValue(value, values, field) {
  const result = String(value || "").trim();
  if (!values.has(result)) throw inspectionError("department_task_health_enum_invalid", field);
  return result;
}

function token(value, field) {
  const result = String(value || "").trim();
  if (!TOKEN.test(result) || /@[^/]+\.[A-Za-z]{2,}$/.test(result)) {
    throw inspectionError("department_task_health_token_invalid", field);
  }
  return result;
}

function optionalToken(value, field) {
  if (value === null || value === undefined || value === "") return null;
  return token(value, field);
}

function timestamp(value, field) {
  const result = String(value || "").trim();
  const parsed = new Date(result);
  if (!result || !Number.isFinite(parsed.getTime()) || parsed.toISOString() !== result) {
    throw inspectionError("department_task_health_timestamp_invalid", field);
  }
  return result;
}

function boundedInteger(value, minimum, maximum, field) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw inspectionError("department_task_health_number_invalid", field);
  }
  return value;
}

function hmacKey(value) {
  const key = Buffer.isBuffer(value) ? Buffer.from(value) : Buffer.from(value || []);
  if (key.length !== 32) throw inspectionError("department_task_health_reference_key_invalid");
  return key;
}

function deepFreeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    Object.values(value).forEach(deepFreeze);
  }
  return value;
}

function inspectionError(code, detail = "") {
  const error = new Error(detail ? `${code}: ${detail}` : code);
  error.code = code;
  return error;
}

export {
  CONTRACT_VERSION as DEPARTMENT_TASK_HEALTH_INSPECTION_CONTRACT_VERSION,
  DEFINITION_VERSION as DEPARTMENT_TASK_HEALTH_INSPECTION_DEFINITION_CONTRACT_VERSION,
  inspectionError as departmentTaskHealthInspectionError,
};
