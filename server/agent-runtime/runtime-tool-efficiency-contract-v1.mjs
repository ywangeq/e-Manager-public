import crypto from "node:crypto";
import {
  MAX_RUNTIME_SAFE_ACTIVITIES,
  normalizeRuntimeSafeActivitySnapshot,
} from "./runtime-safe-activity-contract-v1.mjs";

const RUNTIME_TOOL_EFFICIENCY_SOURCE_CONTRACT_VERSION = "runtime-tool-efficiency-source.v1";
const RUNTIME_TOOL_EFFICIENCY_CONTRACT_VERSION = "runtime-tool-efficiency.v1";
const SAFE_TOKEN = /^[A-Za-z0-9][A-Za-z0-9._:@-]*$/;
const TERMINAL_ACTIVITY_STATUSES = new Set(["blocked", "completed", "failed", "rejected", "target_rejected"]);
const TASK_TERMINAL_STATUSES = new Set([
  "blocked",
  "canceled",
  "completed",
  "failed",
  "lost",
  "rejected",
  "timed_out",
]);
const MAX_CANONICAL_INPUT_BYTES = 4 * 1024 * 1024;
const MAX_CANONICAL_INPUT_DEPTH = 24;
const MAX_CANONICAL_INPUT_NODES = 50_000;

function emptyRuntimeToolEfficiencySource({ taskId, repeatThreshold = 3 } = {}) {
  return normalizeRuntimeToolEfficiencySource({
    contractVersion: RUNTIME_TOOL_EFFICIENCY_SOURCE_CONTRACT_VERSION,
    taskId,
    repeatThreshold,
    providerRetryCount: 0,
    calls: [],
    breaker: {
      status: "not_triggered",
      reasonCode: "none",
      activityId: "",
      sequence: 0,
    },
  });
}

function normalizeRuntimeToolEfficiencySource(value, { expectedTaskId = "" } = {}) {
  exactObject(value, new Set([
    "breaker", "calls", "contractVersion", "providerRetryCount", "repeatThreshold", "taskId",
  ]), "runtime_tool_efficiency_source_invalid");
  if (value.contractVersion !== RUNTIME_TOOL_EFFICIENCY_SOURCE_CONTRACT_VERSION) {
    throw efficiencyError("runtime_tool_efficiency_source_contract_invalid");
  }
  const taskId = requiredToken(value.taskId, "taskId", 128);
  if (expectedTaskId && taskId !== expectedTaskId) {
    throw efficiencyError("runtime_tool_efficiency_task_identity_conflict");
  }
  const repeatThreshold = boundedInteger(value.repeatThreshold, "repeatThreshold", 2, 20);
  const providerRetryCount = boundedInteger(value.providerRetryCount, "providerRetryCount", 0, 10_000);
  if (!Array.isArray(value.calls) || value.calls.length > MAX_RUNTIME_SAFE_ACTIVITIES) {
    throw efficiencyError("runtime_tool_efficiency_calls_invalid");
  }
  let previousSequence = 0;
  const calls = value.calls.map((item) => {
    exactObject(item, new Set([
      "activityId", "classificationStatus", "executorRetryCount", "fingerprint", "sequence",
    ]), "runtime_tool_efficiency_call_invalid");
    const sequence = boundedInteger(item.sequence, "sequence", 1, 10_000);
    if (sequence <= previousSequence) throw efficiencyError("runtime_tool_efficiency_sequence_conflict");
    previousSequence = sequence;
    const classificationStatus = enumToken(
      item.classificationStatus,
      new Set(["classified", "unknown"]),
      "classificationStatus",
    );
    const fingerprint = String(item.fingerprint || "");
    if ((classificationStatus === "classified" && !/^hmac-sha256:[a-f0-9]{64}$/.test(fingerprint)) ||
      (classificationStatus === "unknown" && fingerprint !== "")) {
      throw efficiencyError("runtime_tool_efficiency_fingerprint_invalid");
    }
    return deepFreeze({
      activityId: requiredToken(item.activityId, "activityId", 80),
      sequence,
      classificationStatus,
      fingerprint,
      executorRetryCount: boundedInteger(item.executorRetryCount, "executorRetryCount", 0, 10_000),
    });
  });
  const breaker = normalizeBreaker(value.breaker);
  assertBreakerConsistency({ breaker, calls, repeatThreshold });
  return deepFreeze({
    contractVersion: RUNTIME_TOOL_EFFICIENCY_SOURCE_CONTRACT_VERSION,
    taskId,
    repeatThreshold,
    providerRetryCount,
    calls,
    breaker,
  });
}

function fingerprintRuntimeToolPattern({ activity, fingerprintKey, result, taskId, toolCall } = {}) {
  const safeTaskId = requiredToken(taskId, "taskId", 128);
  if (!Buffer.isBuffer(fingerprintKey) || fingerprintKey.length < 32) {
    throw efficiencyError("runtime_tool_efficiency_fingerprint_key_invalid");
  }
  if (!activity || result === undefined ||
    activity.kind === "tool" && activity.subjectId === "declared-tool") {
    return deepFreeze({ classificationStatus: "unknown", fingerprint: "" });
  }
  try {
    const canonical = canonicalJson({
      arguments: toolCall?.arguments ?? null,
      result: result ?? null,
      toolName: String(toolCall?.name || ""),
    });
    const fingerprint = crypto.createHmac("sha256", fingerprintKey)
      .update(`${RUNTIME_TOOL_EFFICIENCY_SOURCE_CONTRACT_VERSION}\0${safeTaskId}\0`, "utf8")
      .update(canonical, "utf8")
      .digest("hex");
    return deepFreeze({ classificationStatus: "classified", fingerprint: `hmac-sha256:${fingerprint}` });
  } catch (error) {
    if (error?.code !== "runtime_tool_efficiency_pattern_unavailable") throw error;
    return deepFreeze({ classificationStatus: "unknown", fingerprint: "" });
  }
}

function appendRuntimeToolEfficiencyCall(sourceValue, {
  activity,
  executorRetryCount = 0,
  fingerprintKey,
  result,
  toolCall,
} = {}) {
  const source = normalizeRuntimeToolEfficiencySource(sourceValue);
  const snapshot = normalizeRuntimeSafeActivitySnapshot({
    contractVersion: "runtime-safe-activity-snapshot.v1",
    taskId: source.taskId,
    activities: [activity],
  }, { expectedTaskId: source.taskId });
  const terminalActivity = snapshot.activities[0];
  if (!TERMINAL_ACTIVITY_STATUSES.has(terminalActivity.status)) {
    throw efficiencyError("runtime_tool_efficiency_activity_not_terminal");
  }
  const existing = source.calls.find((item) => item.activityId === terminalActivity.activityId);
  const classification = fingerprintRuntimeToolPattern({
    activity: terminalActivity,
    fingerprintKey,
    result,
    taskId: source.taskId,
    toolCall,
  });
  const nextCall = {
    activityId: terminalActivity.activityId,
    sequence: terminalActivity.sequence,
    classificationStatus: classification.classificationStatus,
    fingerprint: classification.fingerprint,
    executorRetryCount: boundedInteger(executorRetryCount, "executorRetryCount", 0, 10_000),
  };
  if (existing) {
    if (JSON.stringify(existing) !== JSON.stringify(nextCall)) {
      throw efficiencyError("runtime_tool_efficiency_call_conflict");
    }
    return deepFreeze({ source, analysis: analyzeRuntimeToolEfficiencySource(source) });
  }
  if (source.breaker.status === "triggered" ||
    terminalActivity.sequence !== (source.calls.at(-1)?.sequence || 0) + 1) {
    throw efficiencyError("runtime_tool_efficiency_progress_conflict");
  }
  const calls = [...source.calls, nextCall];
  const tailCount = classifiedTailCount(calls);
  const breakerTriggered = tailCount >= source.repeatThreshold;
  const nextSource = normalizeRuntimeToolEfficiencySource({
    ...source,
    calls,
    breaker: breakerTriggered
      ? {
        status: "triggered",
        reasonCode: "consecutive_exact_repeat_threshold",
        activityId: terminalActivity.activityId,
        sequence: terminalActivity.sequence,
      }
      : source.breaker,
  });
  return deepFreeze({ source: nextSource, analysis: analyzeRuntimeToolEfficiencySource(nextSource) });
}

function incrementRuntimeToolEfficiencyProviderRetry(sourceValue) {
  const source = normalizeRuntimeToolEfficiencySource(sourceValue);
  if (source.breaker.status === "triggered") {
    throw efficiencyError("runtime_tool_efficiency_progress_conflict");
  }
  return normalizeRuntimeToolEfficiencySource({
    ...source,
    providerRetryCount: boundedInteger(
      source.providerRetryCount + 1,
      "providerRetryCount",
      0,
      10_000,
    ),
  });
}

function analyzeRuntimeToolEfficiencySource(sourceValue) {
  const source = normalizeRuntimeToolEfficiencySource(sourceValue);
  let currentRun = [];
  let longestRun = [];
  const lastSeen = new Map();
  const redundancyCandidates = [];
  for (let index = 0; index < source.calls.length; index += 1) {
    const call = source.calls[index];
    if (call.classificationStatus !== "classified") {
      currentRun = [];
      continue;
    }
    const previous = source.calls[index - 1];
    currentRun = previous?.classificationStatus === "classified" && previous.fingerprint === call.fingerprint
      ? [...currentRun, call]
      : [call];
    if (currentRun.length > longestRun.length) longestRun = currentRun;
    const earlierIndex = lastSeen.get(call.fingerprint);
    if (earlierIndex !== undefined && earlierIndex !== index - 1) {
      redundancyCandidates.push({
        reasonCode: "non_consecutive_exact_pattern",
        activityRefs: [source.calls[earlierIndex], call].map(activityRef),
      });
    }
    lastSeen.set(call.fingerprint, index);
  }
  return deepFreeze({
    consecutiveExactCount: classifiedTailCount(source.calls),
    longestRun,
    redundancyCandidates,
    breakerTriggered: source.breaker.status === "triggered",
  });
}

function projectRuntimeToolEfficiency({ activitySnapshot, sourceSnapshot = null, task = {} } = {}) {
  let activities;
  try {
    activities = normalizeRuntimeSafeActivitySnapshot(activitySnapshot, {
      expectedTaskId: task?.taskId || sourceSnapshot?.taskId || "",
    });
  } catch {
    return null;
  }
  const callCounts = groupedActivityCounts(activities.activities);
  if (!sourceSnapshot) {
    return normalizeRuntimeToolEfficiency({
      contractVersion: RUNTIME_TOOL_EFFICIENCY_CONTRACT_VERSION,
      taskId: activities.taskId,
      evidenceStatus: "activity_only",
      totalCallCount: activities.activities.length,
      callCounts,
      retries: { provider: null, executor: null },
      consecutiveExactRepeats: {
        status: "unknown", longestRunCount: null, threshold: null, activityRefs: [],
      },
      redundancyCandidates: [],
      circuitBreaker: {
        status: "unknown", reasonCode: "unknown", terminationStatus: "unknown", activityRef: null,
      },
    });
  }
  let source;
  try {
    source = normalizeRuntimeToolEfficiencySource(sourceSnapshot, { expectedTaskId: activities.taskId });
    assertSourceMatchesActivities(source, activities.activities);
  } catch {
    return null;
  }
  const analysis = analyzeRuntimeToolEfficiencySource(source);
  const hasUnknown = source.calls.some((call) => call.classificationStatus === "unknown");
  const terminationStatus = breakerTerminationStatus(source, task);
  if (!terminationStatus) return null;
  return normalizeRuntimeToolEfficiency({
    contractVersion: RUNTIME_TOOL_EFFICIENCY_CONTRACT_VERSION,
    taskId: activities.taskId,
    evidenceStatus: hasUnknown ? "partial" : "complete",
    totalCallCount: activities.activities.length,
    callCounts,
    retries: {
      provider: source.providerRetryCount,
      executor: source.calls.reduce((total, call) => total + call.executorRetryCount, 0),
    },
    consecutiveExactRepeats: {
      status: hasUnknown ? "unknown" : analysis.longestRun.length > 1 ? "detected" : "not_detected",
      longestRunCount: hasUnknown ? null : analysis.longestRun.length,
      threshold: source.repeatThreshold,
      activityRefs: hasUnknown ? [] : analysis.longestRun.map(activityRef),
    },
    redundancyCandidates: analysis.redundancyCandidates,
    circuitBreaker: source.breaker.status === "triggered"
      ? {
        status: "triggered",
        reasonCode: "consecutive_exact_repeat_threshold",
        terminationStatus,
        activityRef: { activityId: source.breaker.activityId, sequence: source.breaker.sequence },
      }
      : {
        status: "not_triggered",
        reasonCode: "none",
        terminationStatus: "not_applicable",
        activityRef: null,
      },
  });
}

function normalizeRuntimeToolEfficiency(value, { expectedTaskId = "" } = {}) {
  exactObject(value, new Set([
    "callCounts", "circuitBreaker", "consecutiveExactRepeats", "contractVersion", "evidenceStatus",
    "redundancyCandidates", "retries", "taskId", "totalCallCount",
  ]), "runtime_tool_efficiency_invalid");
  if (value.contractVersion !== RUNTIME_TOOL_EFFICIENCY_CONTRACT_VERSION) {
    throw efficiencyError("runtime_tool_efficiency_contract_invalid");
  }
  const taskId = requiredToken(value.taskId, "taskId", 128);
  if (expectedTaskId && taskId !== expectedTaskId) {
    throw efficiencyError("runtime_tool_efficiency_task_identity_conflict");
  }
  const evidenceStatus = enumToken(value.evidenceStatus, new Set(["activity_only", "complete", "partial"]), "evidenceStatus");
  if (!Array.isArray(value.callCounts) || value.callCounts.length > MAX_RUNTIME_SAFE_ACTIVITIES) {
    throw efficiencyError("runtime_tool_efficiency_counts_invalid");
  }
  const callCounts = value.callCounts.map((item) => {
    exactObject(item, new Set(["actionCode", "count", "displayName", "kind", "subjectId"]), "runtime_tool_efficiency_count_invalid");
    return deepFreeze({
      kind: enumToken(item.kind, new Set(["skill", "tool"]), "kind"),
      subjectId: requiredToken(item.subjectId, "subjectId", 160),
      displayName: safeLabel(item.displayName, "displayName", 120),
      actionCode: requiredToken(item.actionCode, "actionCode", 80),
      count: boundedInteger(item.count, "count", 1, MAX_RUNTIME_SAFE_ACTIVITIES),
    });
  });
  exactObject(value.retries, new Set(["executor", "provider"]), "runtime_tool_efficiency_retries_invalid");
  const retries = deepFreeze({
    provider: nullableInteger(value.retries.provider, "provider", 0, 10_000),
    executor: nullableInteger(value.retries.executor, "executor", 0, 10_000),
  });
  exactObject(value.consecutiveExactRepeats, new Set([
    "activityRefs", "longestRunCount", "status", "threshold",
  ]), "runtime_tool_efficiency_repeat_invalid");
  const repeatStatus = enumToken(
    value.consecutiveExactRepeats.status,
    new Set(["detected", "not_detected", "unknown"]),
    "status",
  );
  const repeatRefs = normalizeActivityRefs(value.consecutiveExactRepeats.activityRefs);
  const consecutiveExactRepeats = deepFreeze({
    status: repeatStatus,
    longestRunCount: nullableInteger(value.consecutiveExactRepeats.longestRunCount, "longestRunCount", 0, MAX_RUNTIME_SAFE_ACTIVITIES),
    threshold: nullableInteger(value.consecutiveExactRepeats.threshold, "threshold", 2, 20),
    activityRefs: repeatRefs,
  });
  if (repeatStatus === "unknown" &&
    (consecutiveExactRepeats.longestRunCount !== null || consecutiveExactRepeats.activityRefs.length > 0)) {
    throw efficiencyError("runtime_tool_efficiency_repeat_conflict");
  }
  if (!Array.isArray(value.redundancyCandidates) ||
    value.redundancyCandidates.length > MAX_RUNTIME_SAFE_ACTIVITIES) {
    throw efficiencyError("runtime_tool_efficiency_redundancy_invalid");
  }
  const redundancyCandidates = value.redundancyCandidates.map((candidate) => {
    exactObject(candidate, new Set(["activityRefs", "reasonCode"]), "runtime_tool_efficiency_redundancy_invalid");
    const activityRefs = normalizeActivityRefs(candidate.activityRefs);
    if (activityRefs.length !== 2) throw efficiencyError("runtime_tool_efficiency_redundancy_invalid");
    return deepFreeze({ reasonCode: enumToken(candidate.reasonCode, new Set(["non_consecutive_exact_pattern"]), "reasonCode"), activityRefs });
  });
  exactObject(value.circuitBreaker, new Set([
    "activityRef", "reasonCode", "status", "terminationStatus",
  ]), "runtime_tool_efficiency_breaker_invalid");
  const breakerStatus = enumToken(value.circuitBreaker.status, new Set(["not_triggered", "triggered", "unknown"]), "status");
  const circuitBreaker = deepFreeze({
    status: breakerStatus,
    reasonCode: enumToken(value.circuitBreaker.reasonCode, new Set([
      "consecutive_exact_repeat_threshold", "none", "unknown",
    ]), "reasonCode"),
    terminationStatus: enumToken(value.circuitBreaker.terminationStatus, new Set([
      "blocked", "not_applicable", "pending_task_settlement", "unknown",
    ]), "terminationStatus"),
    activityRef: value.circuitBreaker.activityRef === null
      ? null
      : normalizeActivityRefs([value.circuitBreaker.activityRef])[0],
  });
  assertPublicBreakerConsistency(circuitBreaker);
  const totalCallCount = boundedInteger(value.totalCallCount, "totalCallCount", 0, MAX_RUNTIME_SAFE_ACTIVITIES);
  if (callCounts.reduce((total, item) => total + item.count, 0) !== totalCallCount ||
    (evidenceStatus === "activity_only" && (retries.provider !== null || retries.executor !== null))) {
    throw efficiencyError("runtime_tool_efficiency_count_conflict");
  }
  return deepFreeze({
    contractVersion: RUNTIME_TOOL_EFFICIENCY_CONTRACT_VERSION,
    taskId,
    evidenceStatus,
    totalCallCount,
    callCounts,
    retries,
    consecutiveExactRepeats,
    redundancyCandidates,
    circuitBreaker,
  });
}

function assertSourceMatchesActivities(source, activities) {
  const terminal = activities.filter((activity) => TERMINAL_ACTIVITY_STATUSES.has(activity.status));
  if (terminal.length !== source.calls.length) {
    throw efficiencyError("runtime_tool_efficiency_activity_count_conflict");
  }
  source.calls.forEach((call, index) => {
    if (terminal[index]?.activityId !== call.activityId || terminal[index]?.sequence !== call.sequence) {
      throw efficiencyError("runtime_tool_efficiency_activity_identity_conflict");
    }
  });
}

function breakerTerminationStatus(source, task) {
  if (source.breaker.status !== "triggered") return "not_applicable";
  const taskStatus = String(task?.status || "").trim();
  if (!TASK_TERMINAL_STATUSES.has(taskStatus)) return "pending_task_settlement";
  return taskStatus === "blocked" && task?.lastErrorCode === "agent_tool_loop_no_progress" ? "blocked" : "";
}

function groupedActivityCounts(activities) {
  const groups = new Map();
  for (const activity of activities) {
    const key = [activity.kind, activity.subjectId, activity.displayName, activity.actionCode].join("\0");
    const current = groups.get(key);
    if (current) current.count += 1;
    else groups.set(key, {
      kind: activity.kind,
      subjectId: activity.subjectId,
      displayName: activity.displayName,
      actionCode: activity.actionCode,
      count: 1,
    });
  }
  return [...groups.values()];
}

function normalizeBreaker(value) {
  exactObject(value, new Set(["activityId", "reasonCode", "sequence", "status"]), "runtime_tool_efficiency_breaker_invalid");
  const status = enumToken(value.status, new Set(["not_triggered", "triggered"]), "status");
  const reasonCode = enumToken(value.reasonCode, new Set(["consecutive_exact_repeat_threshold", "none"]), "reasonCode");
  const activityId = String(value.activityId || "");
  const sequence = boundedInteger(value.sequence, "sequence", 0, 10_000);
  if ((status === "not_triggered" && (reasonCode !== "none" || activityId || sequence !== 0)) ||
    (status === "triggered" && (reasonCode !== "consecutive_exact_repeat_threshold" ||
      !SAFE_TOKEN.test(activityId) || sequence < 1))) {
    throw efficiencyError("runtime_tool_efficiency_breaker_conflict");
  }
  return deepFreeze({ status, reasonCode, activityId, sequence });
}

function assertBreakerConsistency({ breaker, calls, repeatThreshold }) {
  let firstThresholdCall = null;
  let currentCount = 0;
  let previousFingerprint = "";
  for (const call of calls) {
    if (call.classificationStatus === "classified" && call.fingerprint === previousFingerprint) currentCount += 1;
    else currentCount = call.classificationStatus === "classified" ? 1 : 0;
    previousFingerprint = call.classificationStatus === "classified" ? call.fingerprint : "";
    if (!firstThresholdCall && currentCount >= repeatThreshold) firstThresholdCall = call;
  }
  if ((!firstThresholdCall && breaker.status === "triggered") ||
    (firstThresholdCall && (breaker.status !== "triggered" ||
      breaker.activityId !== firstThresholdCall.activityId || breaker.sequence !== firstThresholdCall.sequence ||
      calls.at(-1)?.activityId !== firstThresholdCall.activityId))) {
    throw efficiencyError("runtime_tool_efficiency_breaker_conflict");
  }
}

function assertPublicBreakerConsistency(breaker) {
  const expected = breaker.status === "triggered"
    ? breaker.reasonCode === "consecutive_exact_repeat_threshold" && breaker.activityRef &&
      ["blocked", "pending_task_settlement"].includes(breaker.terminationStatus)
    : breaker.status === "not_triggered"
      ? breaker.reasonCode === "none" && breaker.activityRef === null && breaker.terminationStatus === "not_applicable"
      : breaker.reasonCode === "unknown" && breaker.activityRef === null && breaker.terminationStatus === "unknown";
  if (!expected) throw efficiencyError("runtime_tool_efficiency_breaker_conflict");
}

function classifiedTailCount(calls) {
  const tail = calls.at(-1);
  if (!tail || tail.classificationStatus !== "classified") return 0;
  let count = 0;
  for (let index = calls.length - 1; index >= 0; index -= 1) {
    if (calls[index].classificationStatus !== "classified" || calls[index].fingerprint !== tail.fingerprint) break;
    count += 1;
  }
  return count;
}

function activityRef(value) {
  return deepFreeze({ activityId: value.activityId, sequence: value.sequence });
}

function normalizeActivityRefs(value) {
  if (!Array.isArray(value) || value.length > MAX_RUNTIME_SAFE_ACTIVITIES) {
    throw efficiencyError("runtime_tool_efficiency_activity_refs_invalid");
  }
  return value.map((ref) => {
    exactObject(ref, new Set(["activityId", "sequence"]), "runtime_tool_efficiency_activity_ref_invalid");
    return deepFreeze({
      activityId: requiredToken(ref.activityId, "activityId", 80),
      sequence: boundedInteger(ref.sequence, "sequence", 1, 10_000),
    });
  });
}

function canonicalJson(value) {
  let nodes = 0;
  const seen = new Set();
  function visit(item, depth) {
    nodes += 1;
    if (nodes > MAX_CANONICAL_INPUT_NODES || depth > MAX_CANONICAL_INPUT_DEPTH) {
      throw efficiencyError("runtime_tool_efficiency_pattern_unavailable");
    }
    if (item === null || typeof item === "string" || typeof item === "boolean") return item;
    if (typeof item === "number") {
      if (!Number.isFinite(item)) throw efficiencyError("runtime_tool_efficiency_pattern_unavailable");
      return item;
    }
    if (Array.isArray(item)) {
      if (seen.has(item)) throw efficiencyError("runtime_tool_efficiency_pattern_unavailable");
      seen.add(item);
      const result = item.map((entry) => visit(entry, depth + 1));
      seen.delete(item);
      return result;
    }
    if (typeof item === "object" && Object.getPrototypeOf(item) === Object.prototype) {
      if (seen.has(item)) throw efficiencyError("runtime_tool_efficiency_pattern_unavailable");
      seen.add(item);
      const result = {};
      for (const key of Object.keys(item).sort()) {
        if (item[key] === undefined || typeof item[key] === "function" || typeof item[key] === "symbol") {
          throw efficiencyError("runtime_tool_efficiency_pattern_unavailable");
        }
        result[key] = visit(item[key], depth + 1);
      }
      seen.delete(item);
      return result;
    }
    throw efficiencyError("runtime_tool_efficiency_pattern_unavailable");
  }
  const output = JSON.stringify(visit(value, 0));
  if (Buffer.byteLength(output, "utf8") > MAX_CANONICAL_INPUT_BYTES) {
    throw efficiencyError("runtime_tool_efficiency_pattern_unavailable");
  }
  return output;
}

function exactObject(value, fields, code) {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
    Object.keys(value).length !== fields.size || Object.keys(value).some((field) => !fields.has(field)) ||
    [...fields].some((field) => !Object.hasOwn(value, field))) {
    throw efficiencyError(code);
  }
}

function requiredToken(value, field, maxLength) {
  const token = String(value || "").trim();
  if (!token || token.length > maxLength || !SAFE_TOKEN.test(token)) {
    throw efficiencyError("runtime_tool_efficiency_token_invalid", field);
  }
  return token;
}

function enumToken(value, allowed, field) {
  const token = requiredToken(value, field, 120);
  if (!allowed.has(token)) throw efficiencyError("runtime_tool_efficiency_enum_invalid", field);
  return token;
}

function boundedInteger(value, field, minimum, maximum) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < minimum || number > maximum) {
    throw efficiencyError("runtime_tool_efficiency_integer_invalid", field);
  }
  return number;
}

function nullableInteger(value, field, minimum, maximum) {
  return value === null ? null : boundedInteger(value, field, minimum, maximum);
}

function safeLabel(value, field, maxLength) {
  const label = String(value || "").replace(/\s+/g, " ").trim();
  if (!label || label.length > maxLength || /[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/u.test(label)) {
    throw efficiencyError("runtime_tool_efficiency_label_invalid", field);
  }
  return label;
}

function deepFreeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    Object.values(value).forEach(deepFreeze);
  }
  return value;
}

function efficiencyError(code, field = "") {
  const error = new Error(field ? `${code}:${field}` : code);
  error.code = code;
  return error;
}

export {
  RUNTIME_TOOL_EFFICIENCY_CONTRACT_VERSION,
  RUNTIME_TOOL_EFFICIENCY_SOURCE_CONTRACT_VERSION,
  analyzeRuntimeToolEfficiencySource,
  appendRuntimeToolEfficiencyCall,
  emptyRuntimeToolEfficiencySource,
  fingerprintRuntimeToolPattern,
  incrementRuntimeToolEfficiencyProviderRetry,
  normalizeRuntimeToolEfficiency,
  normalizeRuntimeToolEfficiencySource,
  projectRuntimeToolEfficiency,
};
