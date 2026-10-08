import { normalizeProviderTimeoutPolicy } from "./provider-timeout-policy.mjs";

const PROVIDER_TIMEOUT_CODES = Object.freeze({
  connect: "provider_connect_timeout",
  firstSemanticOutput: "provider_first_semantic_output_timeout",
  requestTotal: "provider_request_total_timeout",
  streamIdle: "provider_stream_idle_timeout",
  taskExecutionTotal: "task_execution_timeout",
});
const SAFE_REASON_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:@-]*$/;

function createProviderTimeoutController({
  now = () => Date.now(),
  parentSignal = null,
  policy: policyInput,
  scheduler = defaultScheduler(),
  taskDeadlineAtMs = null,
} = {}) {
  const policy = normalizeProviderTimeoutPolicy(policyInput);
  assertClock(now);
  assertScheduler(scheduler);
  const startedAtMs = clockValue(now);
  const effectiveTaskDeadlineAtMs = taskDeadlineAtMs === null || taskDeadlineAtMs === undefined
    ? startedAtMs + policy.taskExecutionTotalMs
    : absoluteDeadline(taskDeadlineAtMs);
  const requestDeadlineAtMs = startedAtMs + policy.requestTotalMs;
  const abortController = new AbortController();
  let phase = "connecting";
  let phaseDeadlineAtMs = startedAtMs + policy.connectMs;
  let timer = null;
  let connectedAtMs = null;
  let firstSemanticOutputAtMs = null;
  let lastProviderStreamActivityAtMs = null;
  let semanticOutputObserved = false;
  let providerStreamActivityObserved = false;
  let terminalReason = null;

  const parentAbort = () => abortWith(externalAbortReason(parentSignal?.reason));
  parentSignal?.addEventListener?.("abort", parentAbort, { once: true });
  if (parentSignal?.aborted) parentAbort();
  else armTimer();

  function markConnected() {
    requireActivePhase("connecting", "provider_timeout_connect_phase_invalid");
    connectedAtMs = clockValue(now);
    phase = "awaiting_first_output";
    phaseDeadlineAtMs = connectedAtMs + policy.firstSemanticOutputMs;
    armTimer();
    return snapshot();
  }

  function markProviderStreamActivity() {
    requireActivePhase(["awaiting_first_output", "streaming"], "provider_timeout_stream_phase_invalid");
    const observedAtMs = clockValue(now);
    providerStreamActivityObserved = true;
    lastProviderStreamActivityAtMs = observedAtMs;
    if (phase === "streaming") phaseDeadlineAtMs = observedAtMs + policy.streamIdleMs;
    armTimer();
    return snapshot();
  }

  function markSemanticOutput() {
    requireActivePhase(["awaiting_first_output", "streaming"], "provider_timeout_output_phase_invalid");
    const observedAtMs = clockValue(now);
    semanticOutputObserved = true;
    providerStreamActivityObserved = true;
    firstSemanticOutputAtMs ??= observedAtMs;
    lastProviderStreamActivityAtMs = observedAtMs;
    phase = "streaming";
    phaseDeadlineAtMs = observedAtMs + policy.streamIdleMs;
    armTimer();
    return snapshot();
  }

  function complete() {
    if (["completed", "disposed"].includes(phase)) return snapshot();
    if (phase === "aborted") throw terminalReason;
    phase = "completed";
    phaseDeadlineAtMs = null;
    cleanup();
    return snapshot();
  }

  function dispose() {
    if (["aborted", "completed", "disposed"].includes(phase)) return snapshot();
    phase = "disposed";
    phaseDeadlineAtMs = null;
    cleanup();
    return snapshot();
  }

  function throwIfAborted() {
    if (abortController.signal.aborted) throw terminalReason || abortController.signal.reason;
  }

  function snapshot() {
    return Object.freeze({
      phase,
      policyVersion: policy.policyVersion,
      startedAtMs,
      requestDeadlineAtMs,
      taskDeadlineAtMs: effectiveTaskDeadlineAtMs,
      connectedAtMs,
      firstSemanticOutputAtMs,
      lastProviderStreamActivityAtMs,
      semanticOutputObserved,
      providerStreamActivityObserved,
      terminalReasonCode: terminalReason?.code || "",
      timeoutStage: terminalReason?.timeoutStage || "",
    });
  }

  function requireActivePhase(expected, code) {
    throwIfAborted();
    if (["completed", "disposed"].includes(phase)) throw controllerError("provider_timeout_controller_completed", "provider timeout controller is already completed");
    const allowed = Array.isArray(expected) ? expected : [expected];
    if (!allowed.includes(phase)) throw controllerError(code, "provider timeout controller phase transition is invalid");
  }

  function armTimer() {
    if (timer !== null) scheduler.clearTimeout(timer);
    timer = null;
    if (["aborted", "completed", "disposed"].includes(phase)) return;
    const currentMs = clockValue(now);
    const deadline = nextDeadline();
    if (deadline.atMs <= currentMs) {
      expireAt(currentMs);
      return;
    }
    timer = scheduler.setTimeout(() => {
      timer = null;
      if (parentSignal?.aborted) return parentAbort();
      expireAt(clockValue(now));
    }, deadline.atMs - currentMs);
  }

  function nextDeadline() {
    const deadlines = activeDeadlines();
    return deadlines.reduce((earliest, candidate) => candidate.atMs < earliest.atMs ? candidate : earliest);
  }

  function expireAt(currentMs) {
    if (["aborted", "completed", "disposed"].includes(phase)) return;
    if (parentSignal?.aborted) return parentAbort();
    const expired = activeDeadlines().filter((deadline) => deadline.atMs <= currentMs);
    if (!expired.length) return armTimer();
    const selected = expired.sort((left, right) => left.atMs - right.atMs || left.priority - right.priority)[0];
    abortWith(timeoutReason(selected.stage));
  }

  function activeDeadlines() {
    const phaseStage = phase === "connecting"
      ? "connect"
      : phase === "awaiting_first_output"
        ? "firstSemanticOutput"
        : "streamIdle";
    return [
      { stage: "taskExecutionTotal", atMs: effectiveTaskDeadlineAtMs, priority: 0 },
      { stage: "requestTotal", atMs: requestDeadlineAtMs, priority: 1 },
      { stage: phaseStage, atMs: phaseDeadlineAtMs, priority: 2 },
    ];
  }

  function abortWith(reason) {
    if (["aborted", "completed", "disposed"].includes(phase)) return false;
    terminalReason = reason;
    phase = "aborted";
    phaseDeadlineAtMs = null;
    cleanup();
    abortController.abort(reason);
    return true;
  }

  function cleanup() {
    if (timer !== null) scheduler.clearTimeout(timer);
    timer = null;
    parentSignal?.removeEventListener?.("abort", parentAbort);
  }

  return Object.freeze({
    complete,
    dispose,
    markConnected,
    markProviderStreamActivity,
    markSemanticOutput,
    signal: abortController.signal,
    snapshot,
    throwIfAborted,
  });
}

function timeoutReason(stage) {
  const code = PROVIDER_TIMEOUT_CODES[stage];
  const error = controllerError(code, code);
  error.isProviderTimeout = true;
  error.timeoutStage = stage;
  return error;
}

function externalAbortReason(reason) {
  const code = safeReasonCode(reason?.code || (reason?.name === "AbortError" ? "agent_turn_canceled" : "provider_operation_aborted"));
  const error = controllerError(code, code);
  error.isExternalAbort = true;
  return error;
}

function safeReasonCode(value) {
  const code = String(value || "provider_operation_aborted").trim().slice(0, 120);
  return SAFE_REASON_PATTERN.test(code) ? code : "provider_operation_aborted";
}

function absoluteDeadline(value) {
  const deadline = Number(value);
  if (!Number.isSafeInteger(deadline) || deadline < 0) {
    throw controllerError("provider_timeout_task_deadline_invalid", "taskDeadlineAtMs must be a non-negative safe integer");
  }
  return deadline;
}

function assertClock(now) {
  if (typeof now !== "function") throw controllerError("provider_timeout_clock_invalid", "provider timeout clock must be a function");
}

function clockValue(now) {
  const value = Number(now());
  if (!Number.isSafeInteger(value) || value < 0) {
    throw controllerError("provider_timeout_clock_invalid", "provider timeout clock must return a non-negative safe integer");
  }
  return value;
}

function assertScheduler(scheduler) {
  if (typeof scheduler?.setTimeout !== "function" || typeof scheduler?.clearTimeout !== "function") {
    throw controllerError("provider_timeout_scheduler_invalid", "provider timeout scheduler must provide setTimeout and clearTimeout");
  }
}

function defaultScheduler() {
  return {
    clearTimeout: (timer) => clearTimeout(timer),
    setTimeout: (callback, delayMs) => {
      const timer = setTimeout(callback, delayMs);
      timer.unref?.();
      return timer;
    },
  };
}

function controllerError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

export {
  PROVIDER_TIMEOUT_CODES,
  createProviderTimeoutController,
};
