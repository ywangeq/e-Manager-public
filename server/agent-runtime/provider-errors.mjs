const PROVIDER_RUNTIME_DIAGNOSTIC_VERSION = "provider-runtime-diagnostic.v1";
const DEFAULT_PROVIDER_DIAGNOSTIC = Object.freeze({
  contractVersion: PROVIDER_RUNTIME_DIAGNOSTIC_VERSION,
  category: "none",
  httpStatus: null,
  safeReasonCode: "none",
  retryable: false,
});

function createProviderRuntimeError(code = "model_request_failed", { providerDiagnostic = null, retryAfterMs = 0 } = {}) {
  const message = {
    model_rate_limited: "model_rate_limited",
    model_provider_unavailable: "model_provider_unavailable",
    model_request_invalid: "model_request_invalid",
    model_response_contract_invalid: "model_response_contract_invalid",
    model_request_failed: "model_request_failed",
    provider_adapter_not_registered: "provider_adapter_not_registered",
  }[code] || "model_request_failed";
  const error = new Error(message);
  error.code = message;
  error.isModelRuntimeError = true;
  error.retryable = ["model_rate_limited", "model_provider_unavailable", "model_response_contract_invalid"].includes(message);
  error.retryAfterMs = Math.max(0, Number(retryAfterMs) || 0);
  error.providerDiagnostic = normalizeProviderRuntimeDiagnostic(providerDiagnostic, {
    fallbackCategory: "provider_runtime_error",
    fallbackReasonCode: message,
    retryable: error.retryable,
  });
  return error;
}

function normalizeProviderRuntimeError(error) {
  if (error?.isModelRuntimeError) return error;
  if (error?.isProviderTimeout) {
    error.isModelRuntimeError = true;
    error.retryable = [
      "provider_connect_timeout",
      "provider_first_semantic_output_timeout",
      "provider_request_total_timeout",
    ].includes(error.code) && error.providerSemanticOutputObserved !== true;
    error.retryAfterMs = 0;
    error.providerDiagnostic = normalizeProviderRuntimeDiagnostic(error.providerDiagnostic, {
      fallbackCategory: "provider_timeout",
      fallbackReasonCode: error.code,
      retryable: error.retryable,
    });
    return error;
  }
  return createProviderRuntimeError("model_request_failed");
}

function providerErrorFromResponse(response, errorText = "") {
  return providerErrorFromMessage(errorText, Number(response?.status), retryAfterMs(response));
}

function providerErrorFromMessage(message = "", status = 0, retryAfter = 0) {
  const normalized = String(message || "").replace(/\s+/g, " ").trim().toLowerCase().slice(0, 2000);
  const httpStatus = safeHttpStatus(status);
  if (Number(status) === 429 || /concurrency limit|too many concurrent|rate[_ -]?limit|quota exceeded|resource exhausted|throttl|please retry later/.test(normalized)) {
    return createProviderRuntimeError("model_rate_limited", {
      providerDiagnostic: httpDiagnostic(httpStatus, "http_rate_limited", true),
      retryAfterMs: retryAfter,
    });
  }
  if (Number(status) === 408 || Number(status) === 409 || Number(status) >= 500 || /timeout|temporarily unavailable|overload|upstream error|backend error|connection reset/.test(normalized)) {
    return createProviderRuntimeError("model_provider_unavailable", {
      providerDiagnostic: httpDiagnostic(httpStatus, "http_provider_unavailable", true),
      retryAfterMs: retryAfter,
    });
  }
  if ([400, 404, 405, 415, 422].includes(Number(status))) {
    return createProviderRuntimeError("model_request_invalid", {
      providerDiagnostic: httpDiagnostic(httpStatus, `http_${httpStatus}_request_rejected`, false),
    });
  }
  return createProviderRuntimeError("model_request_failed", {
    providerDiagnostic: httpDiagnostic(httpStatus, httpStatus ? "http_request_failed" : "provider_request_failed", false),
  });
}

function retryAfterMs(response) {
  const value = String(response?.headers?.get?.("retry-after-ms") || response?.headers?.get?.("retry-after") || "").trim();
  if (!value) return 0;
  const milliseconds = Number(value);
  if (Number.isFinite(milliseconds)) {
    return response?.headers?.get?.("retry-after-ms") ? Math.max(0, milliseconds) : Math.max(0, milliseconds * 1000);
  }
  const dateMs = Date.parse(value);
  return Number.isFinite(dateMs) ? Math.max(0, dateMs - Date.now()) : 0;
}

function httpDiagnostic(httpStatus, safeReasonCode, retryable) {
  return {
    contractVersion: PROVIDER_RUNTIME_DIAGNOSTIC_VERSION,
    category: httpStatus ? "http_error" : "provider_error",
    httpStatus,
    safeReasonCode,
    retryable: retryable === true,
  };
}

function normalizeProviderRuntimeDiagnostic(value = null, {
  fallbackCategory = "provider_runtime_error",
  fallbackReasonCode = "provider_runtime_error",
  retryable = false,
  phase = null,
  attempt = null,
  durationMs = null,
} = {}) {
  const source = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  const category = safeDiagnosticToken(source.category) || safeDiagnosticToken(fallbackCategory) || "provider_runtime_error";
  const safeReasonCode = safeDiagnosticToken(source.safeReasonCode) ||
    safeDiagnosticToken(fallbackReasonCode) ||
    "provider_runtime_error";
  const normalized = {
    contractVersion: PROVIDER_RUNTIME_DIAGNOSTIC_VERSION,
    category,
    httpStatus: safeHttpStatus(source.httpStatus),
    safeReasonCode,
    retryable: source.retryable === true || retryable === true,
  };
  const safePhase = safeDiagnosticToken(source.phase) || safeDiagnosticToken(phase);
  const safeAttempt = safeBoundedInteger(source.attempt ?? attempt, 1, 100);
  const safeDurationMs = safeBoundedInteger(source.durationMs ?? durationMs, 0, 86_400_000);
  if (safePhase) normalized.phase = safePhase;
  if (safeAttempt !== null) normalized.attempt = safeAttempt;
  if (safeDurationMs !== null) normalized.durationMs = safeDurationMs;
  return Object.freeze(normalized);
}

function safeBoundedInteger(value, min, max) {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isSafeInteger(number) && number >= min && number <= max ? number : null;
}

function safeHttpStatus(value) {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isSafeInteger(number) && number >= 100 && number <= 599 ? number : null;
}

function safeDiagnosticToken(value) {
  const normalized = String(value || "").trim();
  return /^[a-z][a-z0-9_]{1,119}$/.test(normalized) ? normalized : "";
}

export {
  DEFAULT_PROVIDER_DIAGNOSTIC,
  PROVIDER_RUNTIME_DIAGNOSTIC_VERSION,
  createProviderRuntimeError,
  normalizeProviderRuntimeError,
  normalizeProviderRuntimeDiagnostic,
  providerErrorFromMessage,
  providerErrorFromResponse,
};
