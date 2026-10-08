import { createHash } from "node:crypto";
import { ClassifiedOperationEffectError } from "./classified-operation-effect-error.mjs";

const CLIENT_VERSION = "fxiaoke-crm-service-client.v1";
const DEFAULT_BASE_URL = "https://open.fxiaoke.com";
const ALLOWED_ORIGINS = Object.freeze([DEFAULT_BASE_URL]);
const TOKEN_PATH = "/oauth2.0/token";
const DEFAULT_MAX_RESPONSE_BYTES = 1_000_000;
const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;
const ACTION_PATTERN = /^[a-z][a-z0-9_]{0,119}$/;
const PATH_PATTERN = /^\/cgi\/crm\/[A-Za-z0-9._~!$&'()*+,;=:@%/-]{1,500}$/;
const ERROR_CODES = Object.freeze([
  "fxiaoke_crm_service_authentication_failed",
  "fxiaoke_crm_service_credential_unavailable",
  "fxiaoke_crm_service_forbidden",
  "fxiaoke_crm_service_rate_limited",
  "fxiaoke_crm_service_request_cancelled",
  "fxiaoke_crm_service_request_invalid",
  "fxiaoke_crm_service_request_timeout",
  "fxiaoke_crm_service_response_invalid",
  "fxiaoke_crm_service_response_too_large",
  "fxiaoke_crm_service_unavailable",
  "fxiaoke_crm_service_upstream_error",
  "fxiaoke_crm_service_upstream_rejected",
  "fxiaoke_crm_service_writeback_confirmation_response_invalid",
]);
const OUTCOME_UNKNOWN_AFTER_DISPATCH_ACTIONS = new Set([
  "confirm_trigger_review_writeback",
  "lock_trigger_review_subject",
  "unlock_trigger_review_subject",
  "write_trigger_review_result",
]);
const OUTCOME_UNKNOWN_BUSINESS_CODES_AFTER_DISPATCH = new Set(["50009"]);
const LOCKED_OBJECT_ERROR_MESSAGE = "不能进行[编辑]操作，以下这些数据已被锁定。";

function createFxiaokeCrmServiceClient({
  baseUrl = DEFAULT_BASE_URL,
  credentialProvider,
  fetchImpl = globalThis.fetch,
  maxResponseBytes = DEFAULT_MAX_RESPONSE_BYTES,
  now = () => Date.now(),
  requestTimeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
  tokenSafetyWindowSeconds = 300,
} = {}) {
  const origin = allowedOrigin(baseUrl);
  const maximumBytes = boundedInteger(maxResponseBytes, 1_024, 10_000_000) ||
    DEFAULT_MAX_RESPONSE_BYTES;
  const timeoutMs = boundedInteger(requestTimeoutMs, 1, 60_000) ||
    DEFAULT_REQUEST_TIMEOUT_MS;
  const safetySeconds = boundedInteger(tokenSafetyWindowSeconds, 0, 3_600) ?? 300;
  let tokenCache = null;

  async function requestJson({ action, pathname, body, signal = null } = {}) {
    if (!origin || typeof credentialProvider !== "function" || typeof fetchImpl !== "function") {
      throw serviceError("fxiaoke_crm_service_unavailable");
    }
    if (!ACTION_PATTERN.test(String(action || "")) || !validPathname(pathname) ||
      !isPlainObject(body) || (signal !== null && !isAbortSignal(signal))) {
      throw serviceError("fxiaoke_crm_service_request_invalid");
    }

    let credentials;
    try {
      credentials = normalizeCredentials(await credentialProvider());
    } catch {
      throw serviceError("fxiaoke_crm_service_credential_unavailable");
    }
    if (!credentials) throw serviceError("fxiaoke_crm_service_credential_unavailable");

    const access = await resolveAccessToken(credentials, signal);
    try {
      return await postJson(pathname, body, {
        Authorization: `Bearer ${access.token}`,
        "x-fs-ea": access.ea,
        "x-fs-userid": credentials.userId,
      }, signal, OUTCOME_UNKNOWN_AFTER_DISPATCH_ACTIONS.has(action));
    } catch (error) {
      if (action === "confirm_trigger_review_writeback" &&
        error?.code === "fxiaoke_crm_service_response_invalid") {
        throw serviceError("fxiaoke_crm_service_writeback_confirmation_response_invalid", "unknown");
      }
      throw error;
    }
  }

  async function resolveAccessToken(credentials, signal) {
    if (tokenCache?.fingerprint === credentials.fingerprint &&
      tokenCache.expiresAt > Number(now())) {
      return tokenCache.value;
    }
    const response = await postJson(TOKEN_PATH, {
      appId: credentials.appId,
      appSecret: credentials.appSecret,
      permanentCode: credentials.permanentCode,
      grantType: "app_secret",
    }, {}, signal);
    const token = cleanText(
      response.accessToken || response.access_token || response.corpAccessToken ||
        response.corp_access_token,
      8 * 1024,
    );
    const ea = cleanText(response.ea, 1_000);
    const expiresIn = response.expiresIn === undefined && response.expires_in === undefined
      ? 7_200
      : boundedInteger(response.expiresIn ?? response.expires_in, 1, 86_400);
    if (!token || !ea || expiresIn === null) {
      throw serviceError("fxiaoke_crm_service_authentication_failed");
    }
    const safetyWindow = Math.min(safetySeconds, Math.max(1, Math.floor(expiresIn * 0.1)));
    tokenCache = {
      fingerprint: credentials.fingerprint,
      expiresAt: Number(now()) + Math.max(1, expiresIn - safetyWindow) * 1_000,
      value: Object.freeze({ ea, token }),
    };
    return tokenCache.value;
  }

  async function postJson(pathname, body, extraHeaders, externalSignal,
    outcomeUnknownAfterDispatch = false) {
    const controller = new AbortController();
    let timedOut = false;
    const abortFromCaller = () => controller.abort(externalSignal?.reason);
    if (externalSignal?.aborted) abortFromCaller();
    else externalSignal?.addEventListener?.("abort", abortFromCaller, { once: true });
    const timeoutId = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeoutMs);
    try {
      const response = await fetchImpl(new URL(pathname, origin).toString(), {
        method: "POST",
        redirect: "error",
        headers: { "Content-Type": "application/json", ...extraHeaders },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      if (response?.status === 401) {
        tokenCache = null;
        throw serviceError("fxiaoke_crm_service_authentication_failed");
      }
      if (response?.status === 403) throw serviceError("fxiaoke_crm_service_forbidden");
      if (response?.status === 429) throw serviceError("fxiaoke_crm_service_rate_limited");
      if (!response?.ok) {
        const status = Number(response?.status) >= 500
          ? outcomeStatus(outcomeUnknownAfterDispatch)
          : "definitive_failed";
        throw serviceError("fxiaoke_crm_service_upstream_error", status);
      }
      const parsed = await readBoundedJson(response, maximumBytes,
        outcomeStatus(outcomeUnknownAfterDispatch));
      if (upstreamRejected(parsed)) {
        throw upstreamRejectedError(parsed, outcomeUnknownAfterDispatch, response.status);
      }
      return parsed;
    } catch (error) {
      if (error instanceof ClassifiedOperationEffectError) throw error;
      const status = outcomeStatus(outcomeUnknownAfterDispatch);
      if (timedOut) throw serviceError("fxiaoke_crm_service_request_timeout", status);
      if (controller.signal.aborted) throw serviceError("fxiaoke_crm_service_request_cancelled", status);
      throw serviceError("fxiaoke_crm_service_upstream_error", status);
    } finally {
      clearTimeout(timeoutId);
      externalSignal?.removeEventListener?.("abort", abortFromCaller);
    }
  }

  return Object.freeze({ clientVersion: CLIENT_VERSION, requestJson });
}

function normalizeCredentials(value) {
  if (!isPlainObject(value)) return null;
  const normalized = {
    appId: cleanText(value.appId, 1_000),
    appSecret: cleanText(value.appSecret, 8 * 1024),
    permanentCode: cleanText(value.permanentCode, 8 * 1024),
    userId: cleanText(value.userId, 1_000),
  };
  if (!Object.values(normalized).every(Boolean)) return null;
  const revision = cleanText(value.revision, 1_000);
  if (!revision) return null;
  normalized.fingerprint = createHash("sha256").update(revision).digest("hex");
  return Object.freeze(normalized);
}

function allowedOrigin(value) {
  try {
    const url = new URL(String(value || ""));
    if (url.protocol !== "https:" || url.username || url.password || url.pathname !== "/" ||
      url.search || url.hash || !ALLOWED_ORIGINS.includes(url.origin)) return "";
    return `${url.origin}/`;
  } catch {
    return "";
  }
}

function validPathname(value) {
  if (typeof value !== "string" || !PATH_PATTERN.test(value) || value.includes("..") ||
    value.includes("//") || value.includes("?") || value.includes("#")) return false;
  try {
    const url = new URL(value, DEFAULT_BASE_URL);
    return url.origin === DEFAULT_BASE_URL && url.pathname === value;
  } catch {
    return false;
  }
}

function upstreamRejected(value) {
  if (value.success === false) return true;
  if (!Object.hasOwn(value, "errorCode")) return false;
  return value.errorCode !== 0 && value.errorCode !== "0";
}

async function readBoundedJson(response, maximumBytes, errorStatus = "definitive_failed") {
  const contentLength = Number(response?.headers?.get?.("content-length"));
  if (Number.isFinite(contentLength) && contentLength > maximumBytes) {
    throw serviceError("fxiaoke_crm_service_response_too_large", errorStatus);
  }
  const text = await readBoundedText(response, maximumBytes, errorStatus);
  let parsed;
  try {
    parsed = text ? JSON.parse(text) : {};
  } catch {
    throw serviceError("fxiaoke_crm_service_response_invalid", errorStatus);
  }
  if (!isPlainObject(parsed)) throw serviceError("fxiaoke_crm_service_response_invalid", errorStatus);
  return parsed;
}

async function readBoundedText(response, maximumBytes, errorStatus) {
  if (!response?.body?.getReader) {
    const text = await response.text();
    if (Buffer.byteLength(text, "utf8") > maximumBytes) {
      throw serviceError("fxiaoke_crm_service_response_too_large", errorStatus);
    }
    return text;
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let bytesRead = 0;
  let text = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    bytesRead += value.byteLength;
    if (bytesRead > maximumBytes) {
      await reader.cancel();
      throw serviceError("fxiaoke_crm_service_response_too_large", errorStatus);
    }
    text += decoder.decode(value, { stream: true });
  }
  return text + decoder.decode();
}

function boundedInteger(value, minimum, maximum) {
  return Number.isInteger(value) && value >= minimum && value <= maximum ? value : null;
}

function cleanText(value, maximum) {
  const text = typeof value === "string" ? value.trim() : "";
  return text && text.length <= maximum ? text : "";
}

function isAbortSignal(value) {
  return Boolean(value) && typeof value.aborted === "boolean" &&
    typeof value.addEventListener === "function";
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value) &&
    [Object.prototype, null].includes(Object.getPrototypeOf(value));
}

function outcomeStatus(outcomeUnknownAfterDispatch) {
  return outcomeUnknownAfterDispatch ? "unknown" : "definitive_failed";
}

function upstreamRejectedError(response, outcomeUnknownAfterDispatch = false, httpStatus = null) {
  const businessCode = String(response?.errorCode ?? "").trim();
  if (/^[0-9]{1,20}$/.test(businessCode)) {
    const error = new ClassifiedOperationEffectError({
      status: outcomeUnknownAfterDispatch &&
        OUTCOME_UNKNOWN_BUSINESS_CODES_AFTER_DISPATCH.has(businessCode)
        ? "unknown"
        : "definitive_failed",
      safeResultCode: `fxiaoke_crm_service_upstream_rejected_${businessCode}`,
    });
    const errorMessage = cleanText(response?.errorMessage, 200);
    error.upstreamDiagnostic = Object.freeze({
      ...(boundedInteger(httpStatus, 100, 599) !== null ? { httpStatus } : {}),
      errorCode: businessCode,
      ...(businessCode === "50009" && errorMessage === LOCKED_OBJECT_ERROR_MESSAGE
        ? { errorMessage }
        : {}),
    });
    return error;
  }
  return serviceError("fxiaoke_crm_service_upstream_rejected");
}

function serviceError(code, status = "definitive_failed") {
  const safeCode = ERROR_CODES.includes(code) ? code : "fxiaoke_crm_service_upstream_error";
  return new ClassifiedOperationEffectError({ status, safeResultCode: safeCode });
}

export {
  ALLOWED_ORIGINS as FXIAOKE_CRM_SERVICE_ALLOWED_ORIGINS,
  CLIENT_VERSION as FXIAOKE_CRM_SERVICE_CLIENT_VERSION,
  ERROR_CODES as FXIAOKE_CRM_SERVICE_ERROR_CODES,
  LOCKED_OBJECT_ERROR_MESSAGE as FXIAOKE_CRM_LOCKED_OBJECT_ERROR_MESSAGE,
  createFxiaokeCrmServiceClient,
};
