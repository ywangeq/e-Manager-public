const CONTRACT_VERSION = "schedule-task-input-snapshot-purge-coordinator.v1";
const LIST_VERSION = "schedule-task-input-snapshot-purge-candidate-list.v1";
const TOKEN = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,159}$/;

function createScheduleTaskInputSnapshotPurgeCoordinator({
  inputSnapshotRepository,
  purgeService,
  tenantScopes,
  batchLimit = 100,
  pollIntervalMs = 300_000,
  setTimeoutFn = (callback, delayMs) => setTimeout(callback, delayMs),
  clearTimeoutFn = (timer) => clearTimeout(timer),
} = {}) {
  if (typeof inputSnapshotRepository?.listPurgeCandidates !== "function") {
    throw new TypeError("Schedule input purge coordinator requires candidate discovery");
  }
  if (typeof purgeService?.purge !== "function") {
    throw new TypeError("Schedule input purge coordinator requires purgeService.purge");
  }
  if (typeof setTimeoutFn !== "function" || typeof clearTimeoutFn !== "function") {
    throw new TypeError("Schedule input purge coordinator requires timer hooks");
  }
  const tenants = normalizeTenantScopes(tenantScopes);
  const limit = boundedInteger(batchLimit, 1, 500, "batch_limit");
  const pollMs = boundedInteger(pollIntervalMs, 1_000, 86_400_000, "poll_interval");

  let started = false;
  let closing = false;
  let closed = false;
  let inFlight = null;
  let closePromise = null;
  let wakePending = false;
  let timerHandle = null;
  let timerGeneration = 0;
  let lastSummary = emptySummary();

  function start() {
    if (closing || closed) throw coordinatorError("schedule_task_input_purge_coordinator_closed");
    if (started) return inFlight || Promise.resolve(lastSummary);
    started = true;
    return beginPass();
  }

  function wake() {
    if (!started || closing || closed) return false;
    wakePending = true;
    if (!inFlight) schedulePass(0);
    return true;
  }

  function beginPass() {
    if (!started || closing || closed) return Promise.resolve(lastSummary);
    if (inFlight) return inFlight;
    clearScheduledTimer();
    wakePending = false;
    const pass = runPass();
    inFlight = pass.then((summary) => {
      lastSummary = summary;
      return summary;
    }, () => {
      lastSummary = failureSummary();
      return lastSummary;
    }).finally(() => {
      inFlight = null;
      if (!started || closing || closed) return;
      const immediate = wakePending || lastSummary.backlogPossible;
      schedulePass(immediate ? 0 : pollMs);
    });
    return inFlight;
  }

  async function runPass() {
    const summary = {
      examinedTenants: tenants.length,
      failedTenants: 0,
      candidates: 0,
      purged: 0,
      alreadyPurged: 0,
      deferred: 0,
      backlogPossible: false,
    };
    for (const tenantScope of tenants) {
      let discovered;
      try {
        discovered = normalizeCandidateList(inputSnapshotRepository.listPurgeCandidates({
          tenantScope,
          limit,
        }), tenantScope, limit);
      } catch {
        summary.failedTenants += 1;
        continue;
      }
      let tenantDeferred = 0;
      for (const candidate of discovered.candidates) {
        summary.candidates += 1;
        try {
          const result = await purgeService.purge({ tenantScope, runId: candidate.runId });
          if (result?.outcome === "purged") summary.purged += 1;
          else if (result?.outcome === "already_purged") summary.alreadyPurged += 1;
          else {
            summary.deferred += 1;
            tenantDeferred += 1;
          }
        } catch {
          summary.deferred += 1;
          tenantDeferred += 1;
        }
      }
      if (discovered.candidates.length === limit && tenantDeferred === 0) {
        summary.backlogPossible = true;
      }
    }
    return freezeSummary(summary);
  }

  function schedulePass(delayMs) {
    if (!started || closing || closed) return false;
    clearScheduledTimer();
    const generation = timerGeneration + 1;
    timerGeneration = generation;
    try {
      const handle = setTimeoutFn(() => {
        if (timerGeneration !== generation || timerHandle === null) return;
        timerHandle = null;
        void beginPass().catch(() => {});
      }, delayMs);
      if (timerGeneration === generation) timerHandle = handle;
      try { handle?.unref?.(); } catch { /* timer remains owned by the injected scheduler */ }
      return true;
    } catch {
      if (timerGeneration === generation) timerHandle = null;
      return false;
    }
  }

  function clearScheduledTimer() {
    if (timerHandle === null) return;
    const handle = timerHandle;
    timerGeneration += 1;
    timerHandle = null;
    try { clearTimeoutFn(handle); } catch { /* generation fences stale callbacks */ }
  }

  function close() {
    if (closePromise) return closePromise;
    closing = true;
    started = false;
    wakePending = false;
    clearScheduledTimer();
    const active = inFlight;
    closePromise = (async () => {
      try { if (active) await active; } catch { /* a future poll may retry only while open */ }
      finally {
        inFlight = null;
        closed = true;
        closing = false;
      }
    })();
    return closePromise;
  }

  return Object.freeze({ contractVersion: CONTRACT_VERSION, start, wake, close });
}

function normalizeCandidateList(value, tenantScope, limit) {
  if (!isPlainObject(value) || !hasExactKeys(value, ["candidates", "checkedAt", "contractVersion"]) ||
    value.contractVersion !== LIST_VERSION ||
    !Array.isArray(value.candidates) || value.candidates.length > limit) {
    throw coordinatorError("schedule_task_input_purge_candidate_list_invalid");
  }
  timestamp(value.checkedAt);
  const candidates = value.candidates.map((candidate) => {
    if (!isPlainObject(candidate) || Object.keys(candidate).length !== 1 ||
      !Object.hasOwn(candidate, "runId")) {
      throw coordinatorError("schedule_task_input_purge_candidate_list_invalid");
    }
    return Object.freeze({ runId: token(candidate.runId) });
  });
  if (new Set(candidates.map((candidate) => candidate.runId)).size !== candidates.length ||
    token(tenantScope) !== tenantScope) {
    throw coordinatorError("schedule_task_input_purge_candidate_list_invalid");
  }
  return Object.freeze({ candidates });
}

function normalizeTenantScopes(value) {
  if (!Array.isArray(value) || value.length < 1 || value.length > 32) {
    throw coordinatorError("schedule_task_input_purge_tenants_invalid");
  }
  const tenants = value.map(token);
  if (new Set(tenants).size !== tenants.length) {
    throw coordinatorError("schedule_task_input_purge_tenants_invalid");
  }
  return Object.freeze([...tenants].sort());
}

function token(value) {
  const result = String(value || "").trim();
  if (!TOKEN.test(result) || /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(result)) {
    throw coordinatorError("schedule_task_input_purge_reference_invalid");
  }
  return result;
}

function timestamp(value) {
  const result = String(value || "").trim();
  const parsed = new Date(result);
  if (!result || !Number.isFinite(parsed.getTime()) || parsed.toISOString() !== result) {
    throw coordinatorError("schedule_task_input_purge_timestamp_invalid");
  }
  return result;
}

function boundedInteger(value, minimum, maximum, field) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw coordinatorError(`schedule_task_input_purge_${field}_invalid`);
  }
  return value;
}

function emptySummary() {
  return freezeSummary({
    examinedTenants: 0,
    failedTenants: 0,
    candidates: 0,
    purged: 0,
    alreadyPurged: 0,
    deferred: 0,
    backlogPossible: false,
  });
}

function failureSummary() {
  return freezeSummary({
    examinedTenants: 0,
    failedTenants: 1,
    candidates: 0,
    purged: 0,
    alreadyPurged: 0,
    deferred: 0,
    backlogPossible: false,
  });
}

function freezeSummary(summary) {
  return Object.freeze({ contractVersion: CONTRACT_VERSION, ...summary });
}

function isPlainObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function hasExactKeys(value, expected) {
  const keys = Object.keys(value).sort();
  return keys.length === expected.length && keys.every((key, index) => key === expected[index]);
}

function coordinatorError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

export {
  CONTRACT_VERSION as SCHEDULE_TASK_INPUT_SNAPSHOT_PURGE_COORDINATOR_CONTRACT_VERSION,
  createScheduleTaskInputSnapshotPurgeCoordinator,
};
