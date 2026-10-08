const SCHEDULE_CANCELLATION_COORDINATOR_CONTRACT_VERSION =
  "schedule-cancellation-coordinator.v1";

function createScheduleCancellationCoordinator({
  dispatcher,
  batchLimit = 100,
  maxImmediateBatches = 8,
  pollIntervalMs = 1_000,
  retryInitialMs = 100,
  retryMaxMs = 30_000,
  now = () => Date.now(),
  setTimeoutFn = (callback, delayMs) => setTimeout(callback, delayMs),
  clearTimeoutFn = (timer) => clearTimeout(timer),
} = {}) {
  if (typeof dispatcher?.runOnce !== "function") {
    throw new TypeError("schedule cancellation coordinator requires dispatcher.runOnce");
  }
  if (typeof now !== "function") throw new TypeError("schedule cancellation coordinator requires now");
  if (typeof setTimeoutFn !== "function") {
    throw new TypeError("schedule cancellation coordinator requires setTimeoutFn");
  }
  if (typeof clearTimeoutFn !== "function") {
    throw new TypeError("schedule cancellation coordinator requires clearTimeoutFn");
  }

  const safeBatchLimit = boundedInteger(batchLimit, 1, 500, "batchLimit");
  const safeMaxImmediateBatches = boundedInteger(maxImmediateBatches, 1, 100, "maxImmediateBatches");
  const safePollIntervalMs = boundedInteger(pollIntervalMs, 1, 86_400_000, "pollIntervalMs");
  const safeRetryInitialMs = boundedInteger(retryInitialMs, 1, 86_400_000, "retryInitialMs");
  const safeRetryMaxMs = boundedInteger(retryMaxMs, safeRetryInitialMs, 86_400_000, "retryMaxMs");

  let started = false;
  let closing = false;
  let closed = false;
  let inFlight = null;
  let shutdownDrainPromise = null;
  let shutdownDraining = false;
  let closePromise = null;
  let wakePending = false;
  let retryAttempt = 0;
  let retryPending = false;
  let retryDueAt = null;
  let timerHandle = null;
  let timerDueAt = null;
  let timerKind = null;
  let timerScheduled = false;
  let timerGeneration = 0;

  function start() {
    if (closed || closing) throw coordinatorError("schedule_cancellation_coordinator_closed");
    if (started) return inFlight || Promise.resolve();
    started = true;
    return beginDrain();
  }

  function wake() {
    if (!started || closing || closed || shutdownDraining) return false;
    wakePending = true;
    if (!inFlight) {
      if (retryPending) scheduleRetry();
      else scheduleDrain(0, "wake");
    }
    return true;
  }

  function beginDrain() {
    if (!started || closing || closed || shutdownDraining) return Promise.resolve();
    if (inFlight) return inFlight;
    clearScheduledTimer();

    const cycle = drainCycle();
    inFlight = cycle.then(
      (outcome) => finishDrain(cycle, outcome),
      () => {
        retryAttempt += 1;
        return finishDrain(cycle, { retry: true });
      },
    ).catch(() => {});
    return inFlight;
  }

  async function drainCycle() {
    for (let batch = 0; batch < safeMaxImmediateBatches; batch += 1) {
      wakePending = false;
      let summary;
      try {
        summary = normalizeDispatcherSummary(await dispatcher.runOnce({ limit: safeBatchLimit }));
      } catch {
        retryAttempt += 1;
        return { retry: true };
      }

      if (summary.deferred > 0 || summary.conflicts > 0) {
        retryAttempt += 1;
        return { retry: true };
      }
      retryAttempt = 0;

      const progressed = summary.dispatched > 0 || summary.reconciled > 0;
      if (!progressed && !wakePending) return { retry: false };
    }
    return { retry: false };
  }

  function finishDrain(cycle, outcome) {
    if (inFlight && cycle) inFlight = null;
    if (closing || closed || !started || shutdownDraining) return;
    if (outcome.retry) {
      scheduleRetry();
      return;
    }
    retryPending = false;
    retryDueAt = null;
    scheduleDrain(wakePending ? 0 : safePollIntervalMs, wakePending ? "wake" : "poll");
  }

  function scheduleRetry() {
    if (!started || closing || closed) return false;
    retryPending = true;
    let current;
    try {
      current = nowMilliseconds(now);
    } catch {
      return false;
    }
    if (retryDueAt === null) {
      retryDueAt = current + retryDelayMs(retryAttempt, safeRetryInitialMs, safeRetryMaxMs);
    }
    return scheduleTimer("retry", retryDueAt, current);
  }

  function scheduleDrain(delayMs, kind) {
    if (!started || closing || closed) return;
    let current;
    try {
      current = nowMilliseconds(now);
    } catch {
      return false;
    }
    return scheduleTimer(kind, current + delayMs, current);
  }

  function scheduleTimer(kind, dueAt, current) {
    if (!started || closing || closed) return false;
    if (timerScheduled && timerKind === "retry" && kind !== "retry") return true;
    if (timerScheduled && timerDueAt <= dueAt) return true;
    clearScheduledTimer();
    const generation = timerGeneration + 1;
    timerGeneration = generation;
    timerDueAt = dueAt;
    timerKind = kind;
    timerScheduled = true;
    try {
      const handle = setTimeoutFn(() => {
        if (!timerScheduled || timerGeneration !== generation) return;
        const firedKind = timerKind;
        resetScheduledTimer();
        if (firedKind === "retry") {
          retryPending = false;
          retryDueAt = null;
        }
        void beginDrain().catch(() => {});
      }, Math.max(0, dueAt - current));
      if (timerScheduled && timerGeneration === generation) timerHandle = handle;
      try {
        handle?.unref?.();
      } catch {
        // Timer ownership remains with the injected scheduler.
      }
      return true;
    } catch {
      if (timerGeneration === generation) resetScheduledTimer();
      return false;
    }
  }

  function clearScheduledTimer() {
    if (!timerScheduled) return;
    const handle = timerHandle;
    timerGeneration += 1;
    resetScheduledTimer();
    try {
      clearTimeoutFn(handle);
    } catch {
      // A stale callback is fenced by timerGeneration.
    }
  }

  function resetScheduledTimer() {
    timerHandle = null;
    timerDueAt = null;
    timerKind = null;
    timerScheduled = false;
  }

  function drainForShutdown() {
    if (closed || closing) throw coordinatorError("schedule_cancellation_coordinator_closed");
    if (!started) return Promise.resolve(Object.freeze({ retryRequired: false }));
    if (shutdownDrainPromise) return shutdownDrainPromise;
    shutdownDraining = true;
    wakePending = false;
    retryPending = false;
    retryDueAt = null;
    clearScheduledTimer();
    shutdownDrainPromise = (async () => {
      const active = inFlight;
      if (active) await active;
      clearScheduledTimer();
      const cycle = drainCycle();
      inFlight = cycle.catch(() => ({ retry: true }));
      const outcome = await inFlight;
      return Object.freeze({ retryRequired: Boolean(outcome.retry) });
    })().finally(() => {
      inFlight = null;
      clearScheduledTimer();
      shutdownDraining = false;
      shutdownDrainPromise = null;
    });
    return shutdownDrainPromise;
  }

  function close() {
    if (closePromise) return closePromise;
    closing = true;
    started = false;
    wakePending = false;
    retryPending = false;
    retryDueAt = null;
    const active = shutdownDrainPromise || inFlight;
    closePromise = (async () => {
      try {
        if (active) await active;
      } catch {
        // Drain failures are retriable only while the coordinator is open.
      } finally {
        inFlight = null;
        closed = true;
        closing = false;
      }
    })();
    clearScheduledTimer();
    return closePromise;
  }

  return Object.freeze({
    contractVersion: SCHEDULE_CANCELLATION_COORDINATOR_CONTRACT_VERSION,
    start,
    wake,
    drainForShutdown,
    close,
  });
}

function normalizeDispatcherSummary(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw coordinatorError("schedule_cancellation_dispatcher_summary_invalid");
  }
  return Object.freeze({
    dispatched: nonNegativeInteger(value.dispatched, "dispatched"),
    reconciled: nonNegativeInteger(value.reconciled, "reconciled"),
    reconcileRequired: nonNegativeInteger(value.reconcileRequired, "reconcileRequired"),
    deferred: nonNegativeInteger(value.deferred, "deferred"),
    conflicts: nonNegativeInteger(value.conflicts, "conflicts"),
  });
}

function retryDelayMs(attempt, initialMs, maximumMs) {
  const exponent = Math.max(0, Math.min(30, attempt - 1));
  return Math.min(maximumMs, initialMs * (2 ** exponent));
}

function nowMilliseconds(now) {
  const value = now();
  const milliseconds = value instanceof Date ? value.getTime() : Number(value);
  if (!Number.isFinite(milliseconds)) throw coordinatorError("schedule_cancellation_coordinator_now_invalid");
  return milliseconds;
}

function boundedInteger(value, min, max, field) {
  if (!Number.isInteger(value) || value < min || value > max) {
    throw coordinatorError(`schedule_cancellation_coordinator_${field}_invalid`);
  }
  return value;
}

function nonNegativeInteger(value, field) {
  if (!Number.isInteger(value) || value < 0) {
    throw coordinatorError(`schedule_cancellation_coordinator_${field}_invalid`);
  }
  return value;
}

function coordinatorError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

export { createScheduleCancellationCoordinator };
