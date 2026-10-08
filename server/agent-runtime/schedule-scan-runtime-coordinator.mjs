const SCHEDULE_SCAN_RUNTIME_COORDINATOR_CONTRACT_VERSION =
  "schedule-scan-runtime-coordinator.v1";
const TOKEN = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,159}$/;

function createScheduleScanRuntimeCoordinator({
  runExecutionLifecycle,
  scannerCoordinator,
  tenantScopes,
  batchLimit = 100,
  now = () => new Date(),
  queueMicrotaskFn = (callback) => queueMicrotask(callback),
} = {}) {
  if (typeof runExecutionLifecycle?.reconcileOnce !== "function") {
    throw new TypeError("schedule scan runtime requires runExecutionLifecycle.reconcileOnce");
  }
  if (typeof scannerCoordinator?.runOnce !== "function") {
    throw new TypeError("schedule scan runtime requires scannerCoordinator.runOnce");
  }
  if (typeof now !== "function") throw new TypeError("schedule scan runtime requires now");
  if (typeof queueMicrotaskFn !== "function") {
    throw new TypeError("schedule scan runtime requires queueMicrotaskFn");
  }
  const tenants = normalizeTenantScopes(tenantScopes);
  const limit = boundedInteger(batchLimit, 1, 500, "batchLimit");

  let started = false;
  let closing = false;
  let closed = false;
  let inFlight = null;
  let closePromise = null;
  let wakePending = false;
  let wakeScheduled = false;
  let lastSummary = emptySummary();

  function start() {
    if (closing || closed) throw runtimeError("schedule_scan_runtime_closed");
    if (started) return inFlight || Promise.resolve(lastSummary);
    started = true;
    return beginPass();
  }

  function wake() {
    if (!started || closing || closed) return false;
    wakePending = true;
    if (!inFlight) schedulePass();
    return true;
  }

  function beginPass() {
    if (!started || closing || closed) return Promise.resolve(lastSummary);
    if (inFlight) return inFlight;
    wakePending = false;
    const pass = runPass();
    inFlight = pass.then((summary) => {
      lastSummary = summary;
      return summary;
    }).finally(() => {
      inFlight = null;
      if (wakePending && !closing && !closed) schedulePass();
    });
    return inFlight;
  }

  async function runPass() {
    const summary = {
      examinedTenants: tenants.length,
      reconciledTenants: 0,
      scannedTenants: 0,
      failedTenants: 0,
    };
    for (const tenantScope of tenants) {
      try {
        await runExecutionLifecycle.reconcileOnce({ tenantScope, limit });
        summary.reconciledTenants += 1;
        await scannerCoordinator.runOnce({
          tenantScope,
          now: canonicalTimestamp(now()),
          limit,
        });
        summary.scannedTenants += 1;
      } catch {
        summary.failedTenants += 1;
      }
    }
    return freezeSummary(summary);
  }

  function schedulePass() {
    if (wakeScheduled || inFlight || closing || closed || !started) return;
    wakeScheduled = true;
    try {
      queueMicrotaskFn(() => {
        wakeScheduled = false;
        if (closing || closed || !started) return;
        void beginPass().catch(() => {});
      });
    } catch {
      wakeScheduled = false;
    }
  }

  function close() {
    if (closePromise) return closePromise;
    closing = true;
    started = false;
    wakePending = false;
    const active = inFlight;
    closePromise = (async () => {
      try {
        if (active) await active;
      } catch {
        // A failed pass has no durable authority outside its one-shot dependencies.
      } finally {
        inFlight = null;
        closed = true;
        closing = false;
      }
    })();
    return closePromise;
  }

  return Object.freeze({
    contractVersion: SCHEDULE_SCAN_RUNTIME_COORDINATOR_CONTRACT_VERSION,
    start,
    wake,
    close,
  });
}

function normalizeTenantScopes(value) {
  if (!Array.isArray(value) || value.length < 1 || value.length > 32) {
    throw runtimeError("schedule_scan_runtime_tenants_invalid");
  }
  const scopes = value.map((item) => token(item));
  if (new Set(scopes).size !== scopes.length) {
    throw runtimeError("schedule_scan_runtime_tenants_invalid");
  }
  return Object.freeze([...scopes].sort());
}

function token(value) {
  const result = String(value || "").trim();
  if (!TOKEN.test(result) || /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(result)) {
    throw runtimeError("schedule_scan_runtime_tenants_invalid");
  }
  return result;
}

function canonicalTimestamp(value) {
  const input = value instanceof Date ? value.toISOString() : String(value || "").trim();
  const timestamp = new Date(input);
  if (!input || !Number.isFinite(timestamp.getTime()) || timestamp.toISOString() !== input) {
    throw runtimeError("schedule_scan_runtime_clock_invalid");
  }
  return input;
}

function boundedInteger(value, minimum, maximum, field) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw runtimeError(`schedule_scan_runtime_${field}_invalid`);
  }
  return value;
}

function emptySummary() {
  return freezeSummary({
    examinedTenants: 0,
    reconciledTenants: 0,
    scannedTenants: 0,
    failedTenants: 0,
  });
}

function freezeSummary(summary) {
  return Object.freeze({
    contractVersion: SCHEDULE_SCAN_RUNTIME_COORDINATOR_CONTRACT_VERSION,
    ...summary,
  });
}

function runtimeError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

export {
  SCHEDULE_SCAN_RUNTIME_COORDINATOR_CONTRACT_VERSION,
  createScheduleScanRuntimeCoordinator,
};
