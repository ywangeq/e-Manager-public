import {
  createProviderRuntimeError,
  normalizeProviderRuntimeError,
} from "./provider-errors.mjs";

const DEFAULT_PROVIDER_RETRY_POLICY = {
  baseDelayMs: 500,
  jitter: 0.1,
  maxAttempts: 3,
  maxDelayMs: 4000,
  unavailableDelayMs: 60_000,
};

async function runProviderRequestWithRetry({
  operation,
  onRetry = null,
  retryCount,
  retryPolicy,
  signal = null,
  sleep = delay,
} = {}) {
  if (onRetry !== null && typeof onRetry !== "function") {
    throw new TypeError("provider retry onRetry must be a function");
  }
  const policy = normalizeProviderRetryPolicy(retryPolicy);
  const maxAttempts = Number.isFinite(retryCount)
    ? Math.max(1, retryCount + 1)
    : policy.maxAttempts;
  let lastError = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    throwIfAborted(signal);
    try {
      return await operation({ attempt });
    } catch (error) {
      throwIfAborted(signal);
      const runtimeError = normalizeProviderRuntimeError(error);
      runtimeError.attempts = attempt;
      lastError = runtimeError;
      if (runtimeError.providerSemanticOutputObserved || !runtimeError.retryable || attempt >= maxAttempts) throw runtimeError;
      await onRetry?.({
        attempt,
        nextAttempt: attempt + 1,
        reasonCode: String(runtimeError.code || "model_request_failed"),
      });
      await sleep(providerRetryDelayMs(runtimeError, attempt, policy), { signal });
      throwIfAborted(signal);
    }
  }

  throw lastError || createProviderRuntimeError("model_request_failed");
}

function providerRetryDelayMs(error, attempt, policy) {
  if (error.code === "model_provider_unavailable" && [502, 503].includes(error.providerDiagnostic?.httpStatus)) return policy.unavailableDelayMs;
  const exponentialDelay = Math.min(policy.maxDelayMs, policy.baseDelayMs * (2 ** Math.max(0, attempt - 1)));
  const preferredDelay = error.retryAfterMs ? Math.min(policy.maxDelayMs, error.retryAfterMs) : exponentialDelay;
  const jitter = preferredDelay * policy.jitter * Math.random();
  return Math.round(preferredDelay + jitter);
}

function normalizeProviderRetryPolicy(input = {}) {
  return {
    unavailableDelayMs: clampInteger(input?.unavailableDelayMs, DEFAULT_PROVIDER_RETRY_POLICY.unavailableDelayMs, 0, 60_000),
    maxAttempts: clampInteger(input?.maxAttempts, DEFAULT_PROVIDER_RETRY_POLICY.maxAttempts, 1, 5),
    baseDelayMs: clampInteger(input?.baseDelayMs, DEFAULT_PROVIDER_RETRY_POLICY.baseDelayMs, 0, 10_000),
    maxDelayMs: clampInteger(input?.maxDelayMs, DEFAULT_PROVIDER_RETRY_POLICY.maxDelayMs, 100, 60_000),
    jitter: clampNumber(input?.jitter, DEFAULT_PROVIDER_RETRY_POLICY.jitter, 0, 1),
  };
}

function delay(milliseconds = 0, { signal = null } = {}) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason || cancellationError());
    const finish = () => {
      signal?.removeEventListener?.("abort", abort);
      resolve();
    };
    const abort = () => {
      clearTimeout(timer);
      reject(signal?.reason || cancellationError());
    };
    const timer = setTimeout(finish, milliseconds);
    signal?.addEventListener?.("abort", abort, { once: true });
  });
}

function throwIfAborted(signal) {
  if (signal?.aborted) throw signal.reason || cancellationError();
}

function cancellationError() {
  const error = new Error("agent_turn_canceled");
  error.code = "agent_turn_canceled";
  return error;
}

function clampInteger(value, fallback, minimum, maximum) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(minimum, Math.min(maximum, Math.floor(number)));
}

function clampNumber(value, fallback, minimum, maximum) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(minimum, Math.min(maximum, number));
}

export {
  DEFAULT_PROVIDER_RETRY_POLICY,
  normalizeProviderRetryPolicy,
  runProviderRequestWithRetry,
};
