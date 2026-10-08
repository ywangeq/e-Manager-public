const CONTRACT_VERSION = "artifact-retention-cleanup-coordinator.v1";

export function createArtifactRetentionCleanupCoordinator({
  artifactService,
  batchLimit = 100,
  pollIntervalMs = 15 * 60 * 1_000,
  clock = () => new Date(),
  setTimeoutFn = (callback, delayMs) => setTimeout(callback, delayMs),
  clearTimeoutFn = (timer) => clearTimeout(timer),
} = {}) {
  if (typeof artifactService?.cleanupExpiredArtifacts !== "function") {
    throw new TypeError("Artifact retention cleanup coordinator requires the canonical Artifact service");
  }
  if (typeof clock !== "function" || typeof setTimeoutFn !== "function" || typeof clearTimeoutFn !== "function") {
    throw new TypeError("Artifact retention cleanup coordinator requires clock and timer hooks");
  }
  const limit = boundedInteger(batchLimit, 1, 500, "batch_limit");
  const pollMs = boundedInteger(pollIntervalMs, 1_000, 86_400_000, "poll_interval");
  let started = false;
  let closing = false;
  let closed = false;
  let inFlight = null;
  let timer = null;
  let timerGeneration = 0;
  let closePromise = null;
  let wakePending = false;
  let firstPass = true;
  let lastSummary = emptySummary();

  function start() {
    if (closing || closed) throw coordinatorError("artifact_cleanup_coordinator_closed");
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
    const reasonCode = firstPass ? "startup_recovery" : "scheduled_ttl";
    firstPass = false;
    inFlight = Promise.resolve().then(() => artifactService.cleanupExpiredArtifacts({
      now: clock(),
      limit,
      reasonCode,
    })).then((summary) => {
      lastSummary = normalizeSummary(summary);
      return lastSummary;
    }, () => {
      lastSummary = failureSummary(reasonCode);
      return lastSummary;
    }).finally(() => {
      inFlight = null;
      if (!started || closing || closed) return;
      const backlogPossible = lastSummary.complete && (
        lastSummary.authorities.artifactsRetired === limit ||
        lastSummary.authorities.grantsDeleted === limit ||
        lastSummary.objects.examined === limit
      );
      schedulePass(wakePending || backlogPossible ? 0 : pollMs);
    });
    return inFlight;
  }

  function schedulePass(delayMs) {
    if (!started || closing || closed) return false;
    clearScheduledTimer();
    const generation = timerGeneration + 1;
    timerGeneration = generation;
    try {
      const handle = setTimeoutFn(() => {
        if (timerGeneration !== generation || timer === null) return;
        timer = null;
        void beginPass().catch(() => {});
      }, delayMs);
      if (timerGeneration === generation) timer = handle;
      try { handle?.unref?.(); } catch { /* injected timer ownership is authoritative */ }
      return true;
    } catch {
      if (timerGeneration === generation) timer = null;
      return false;
    }
  }

  function clearScheduledTimer() {
    if (timer === null) return;
    const handle = timer;
    timerGeneration += 1;
    timer = null;
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
      try { if (active) await active; } catch { /* the safe summary already records this pass */ }
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

function normalizeSummary(value) {
  if (!value || value.contractVersion !== "artifact-retention-cleanup.v1" ||
    typeof value.complete !== "boolean" || !value.authorities || !value.objects) {
    throw coordinatorError("artifact_cleanup_summary_invalid");
  }
  return value;
}

function emptySummary() {
  return Object.freeze({
    contractVersion: "artifact-retention-cleanup.v1",
    status: "not_started",
    complete: true,
    reasonCode: "startup_recovery",
    authorities: Object.freeze({ artifactsRetired: 0, grantsDeleted: 0, integrityBlocked: 0 }),
    objects: Object.freeze({ alreadyClean: 0, deferred: 0, deleted: 0, examined: 0, failedSafe: 0 }),
  });
}

function failureSummary(reasonCode) {
  return Object.freeze({
    contractVersion: "artifact-retention-cleanup.v1",
    status: "coordinator_failed_safe",
    complete: false,
    reasonCode,
    authorities: Object.freeze({ artifactsRetired: 0, grantsDeleted: 0, integrityBlocked: 0 }),
    objects: Object.freeze({ alreadyClean: 0, deferred: 0, deleted: 0, examined: 0, failedSafe: 0 }),
  });
}

function boundedInteger(value, minimum, maximum, field) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw coordinatorError(`artifact_cleanup_${field}_invalid`);
  }
  return value;
}

function coordinatorError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}
