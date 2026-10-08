import crypto from "node:crypto";

const CONTRACT_VERSION = "dataflow-device-session-credential-broker.v1";
const TOOL_ID = "dataflow-rest-api";
const DEFAULT_PATHS = Object.freeze({
  logout: "/api/v1/auth/logout",
  me: "/api/v1/users/me",
  refresh: "/api/v1/auth/refresh",
});
const DEFAULT_ACCESS_TOKEN_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_ACCESS_TOKEN_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_JSON_BYTES = 256 * 1024;
const MAX_SECRET_LENGTH = 8 * 1024;

function createDataflowDeviceSessionCredentialBroker({
  accessTokenJsonPath,
  actorBindingId,
  allowedLoginOrigins = [],
  apiOrigin,
  certificateSha256Fingerprints = [],
  expectedIdentity,
  expiresInSecondsJsonPath = "",
  fallbackAccessTokenTtlMs = DEFAULT_ACCESS_TOKEN_TTL_MS,
  identityJsonPath,
  now = () => Date.now(),
  paths = {},
  sessionFromPartition,
} = {}) {
  if (typeof sessionFromPartition !== "function") throw brokerError("dataflow_session_factory_required");
  const origin = strictHttpsOrigin(apiOrigin);
  const actor = requiredOpaqueText(actorBindingId, "dataflow_actor_binding_required", 320);
  const actorBindingDigest = digestActorBinding(actor);
  const expectedUser = verifiedEnterpriseUsername(expectedIdentity);
  const tokenPath = jsonPath(accessTokenJsonPath, "dataflow_access_token_json_path_required");
  const userPath = jsonPath(identityJsonPath, "dataflow_identity_json_path_required");
  const expiryPath = expiresInSecondsJsonPath
    ? jsonPath(expiresInSecondsJsonPath, "dataflow_expiry_json_path_invalid")
    : null;
  const endpointPaths = {
    logout: sameOriginPath(paths.logout || DEFAULT_PATHS.logout),
    me: sameOriginPath(paths.me || DEFAULT_PATHS.me),
    refresh: sameOriginPath(paths.refresh || DEFAULT_PATHS.refresh),
  };
  const fallbackTtlMs = boundedTtl(fallbackAccessTokenTtlMs);
  const partition = dataflowCredentialPartition({ actorBindingId: actor, apiOrigin: origin });
  const browserSession = sessionFromPartition(partition);
  assertSession(browserSession);
  denySessionPermissions(browserSession);
  const removeCertificateTrust = installExactCertificateTrust({
    browserSession,
    certificateSha256Fingerprints,
    origin,
  });
  const allowedOrigins = new Set([
    origin,
    ...allowedLoginOrigins.map((value) => strictHttpsOrigin(value)),
  ]);
  let accessProjection = null;
  let refreshPromise = null;
  let authenticatedAt = "";
  let checkedAt = "";
  let verifiedAt = "";
  let expiryKnown = false;
  let generation = 0;
  let disposed = false;

  async function authorizationFor({ minimumValidityMs = 5_000, signal = null } = {}) {
    throwIfAborted(signal);
    if (disposed) throw brokerError("dataflow_credential_request_canceled");
    const currentTime = validNow(now());
    if (accessProjection && accessProjection.expiresAtMs - currentTime > boundedMinimumValidity(minimumValidityMs)) {
      return ephemeralLease(accessProjection, actorBindingDigest);
    }
    return refreshAccessToken({ signal });
  }

  async function refreshAccessToken({ signal = null } = {}) {
    throwIfAborted(signal);
    if (disposed) throw brokerError("dataflow_credential_request_canceled");
    if (refreshPromise) return awaitWithAbort(refreshPromise, signal);
    const refreshGeneration = generation;
    refreshPromise = (async () => {
      accessProjection = null;
      checkedAt = new Date(validNow(now())).toISOString();
      const refreshResponse = await safeFetch(browserSession, endpointUrl(origin, endpointPaths.refresh), {
        method: "POST",
        headers: { Accept: "application/json" },
        credentials: "include",
        cache: "no-store",
        redirect: "error",
        signal,
      }, "dataflow_refresh_unavailable");
      throwIfAborted(signal);
      if (!refreshResponse.ok) throw brokerError(refreshResponse.status === 401
        ? "dataflow_interactive_login_required"
        : "dataflow_refresh_rejected");
      const refreshPayload = await strictJson(refreshResponse, "dataflow_refresh_response_invalid");
      throwIfAborted(signal);
      const token = accessToken(valueAtJsonPath(refreshPayload, tokenPath));
      if (!token) throw brokerError("dataflow_refresh_access_token_missing");
      const identityResponse = await safeFetch(browserSession, endpointUrl(origin, endpointPaths.me), {
        method: "GET",
        headers: { Accept: "application/json", Authorization: `Bearer ${token}` },
        credentials: "omit",
        cache: "no-store",
        redirect: "error",
        signal,
      }, "dataflow_identity_probe_unavailable");
      throwIfAborted(signal);
      if (!identityResponse.ok) throw brokerError(identityResponse.status === 401
        ? "dataflow_refreshed_token_rejected"
        : identityResponse.status === 403
          ? "dataflow_identity_probe_forbidden"
          : "dataflow_identity_probe_rejected");
      const identityPayload = await strictJson(identityResponse, "dataflow_identity_response_invalid");
      throwIfAborted(signal);
      const actualIdentity = canonicalEnterpriseUsername(
        valueAtJsonPath(identityPayload, userPath),
      );
      if (!constantTimeTextEqual(actualIdentity, expectedUser.value)) throw brokerError("dataflow_identity_mismatch");
      throwIfAborted(signal);
      if (disposed || generation !== refreshGeneration) throw brokerError("dataflow_credential_request_canceled");
      const issuedAtMs = validNow(now());
      const expiresAtMs = issuedAtMs + accessTokenTtlMs({
        expiresInSeconds: expiryPath ? valueAtJsonPath(refreshPayload, expiryPath) : null,
        fallbackTtlMs,
      });
      expiryKnown = Boolean(expiryPath && valueAtJsonPath(refreshPayload, expiryPath) != null);
      verifiedAt = new Date(issuedAtMs).toISOString();
      accessProjection = { token, expiresAtMs };
      return ephemeralLease(accessProjection, actorBindingDigest);
    })();
    try {
      return await refreshPromise;
    } finally {
      refreshPromise = null;
    }
  }

  async function logout({ signal = null } = {}) {
    generation++;
    accessProjection = null;
    let remoteLogoutConfirmed = false;
    try {
      const response = await safeFetch(browserSession, endpointUrl(origin, endpointPaths.logout), {
        method: "POST",
        headers: { Accept: "application/json" },
        credentials: "include",
        cache: "no-store",
        redirect: "error",
        signal,
      }, "dataflow_logout_unavailable");
      remoteLogoutConfirmed = response.ok;
    } catch {
      remoteLogoutConfirmed = false;
    }
    authenticatedAt = "";
    verifiedAt = "";
    expiryKnown = false;
    await browserSession.clearStorageData();
    browserSession.flushStorageData?.();
    return Object.freeze({
      contractVersion: CONTRACT_VERSION,
      ok: true,
      remoteLogoutConfirmed,
      status: remoteLogoutConfirmed ? "logged_out" : "local_session_cleared",
    });
  }

  function clearAccessToken() {
    generation++;
    accessProjection = null;
    return safeStatus("access_token_cleared");
  }

  function dispose() {
    disposed = true;
    generation++;
    accessProjection = null;
    removeCertificateTrust();
  }

  function status() {
    const currentTime = validNow(now());
    if (accessProjection && accessProjection.expiresAtMs <= currentTime) accessProjection = null;
    return safeStatus(accessProjection ? "ready" : "refresh_required", accessProjection?.expiresAtMs);
  }

  function markInteractiveLoginVerified() {
    if (accessProjection && accessProjection.expiresAtMs > validNow(now())) authenticatedAt = verifiedAt;
    return status();
  }

  function isAllowedLoginNavigation(value) {
    try {
      return allowedOrigins.has(new URL(String(value || "")).origin);
    } catch {
      return false;
    }
  }

  function safeStatus(state, expiresAtMs = 0) {
    return Object.freeze({
      contractVersion: CONTRACT_VERSION,
      toolId: TOOL_ID,
      status: state,
      partition,
      apiOrigin: origin,
      actorBindingDigest,
      accessTokenInMemory: state === "ready",
      expiresAt: expiresAtMs ? new Date(expiresAtMs).toISOString() : "",
      authenticatedAt,
      checkedAt,
      verifiedAt,
      expiryKnown,
    });
  }

  return Object.freeze({
    authorizationFor,
    clearAccessToken,
    contractVersion: CONTRACT_VERSION,
    dispose,
    isAllowedLoginNavigation,
    markInteractiveLoginVerified,
    logout,
    partition,
    refreshAccessToken,
    status,
    toolId: TOOL_ID,
  });
}

function dataflowCredentialPartition({ actorBindingId, apiOrigin } = {}) {
  const actor = requiredOpaqueText(actorBindingId, "dataflow_actor_binding_required", 320);
  const origin = strictHttpsOrigin(apiOrigin);
  const digest = crypto.createHash("sha256").update(`${actor}\u0000${origin}`).digest("hex");
  return `persist:dw-dataflow-${digest}`;
}

function digestActorBinding(value) {
  return crypto.createHash("sha256").update(`dataflow-actor-binding.v1\u0000${value}`).digest("hex");
}

function installExactCertificateTrust({ browserSession, certificateSha256Fingerprints = [], origin } = {}) {
  if (typeof browserSession?.setCertificateVerifyProc !== "function") {
    throw brokerError("dataflow_certificate_boundary_unavailable");
  }
  const hostname = new URL(strictHttpsOrigin(origin)).hostname;
  const fingerprints = new Set(certificateSha256Fingerprints.map(normalizeSha256Fingerprint));
  browserSession.setCertificateVerifyProc((request, callback) => {
    const requestHostname = String(request?.hostname || "").trim().toLowerCase();
    const systemTrusted = request?.errorCode === 0;
    if (requestHostname !== hostname) {
      callback(systemTrusted ? 0 : -2);
      return;
    }
    if (!fingerprints.size) {
      callback(systemTrusted ? 0 : -2);
      return;
    }
    const presented = normalizePresentedFingerprint(
      request?.validatedCertificate?.fingerprint || request?.certificate?.fingerprint,
    );
    callback(presented && fingerprints.has(presented) ? 0 : -2);
  });
  return () => browserSession.setCertificateVerifyProc(null);
}

function denySessionPermissions(browserSession) {
  browserSession.setPermissionRequestHandler?.((_webContents, _permission, callback) => callback(false));
  browserSession.setPermissionCheckHandler?.(() => false);
}

function ephemeralLease(projection, actorBindingDigest) {
  return Object.freeze({
    contractVersion: CONTRACT_VERSION,
    toolId: TOOL_ID,
    actorBindingDigest,
    authorization: `Bearer ${projection.token}`,
    expiresAt: new Date(projection.expiresAtMs).toISOString(),
    persistence: "main_process_memory_only",
  });
}

async function safeFetch(browserSession, url, options, errorCode) {
  throwIfAborted(options?.signal);
  try {
    return await browserSession.fetch(url, options);
  } catch {
    if (options?.signal?.aborted) throw brokerError("dataflow_credential_request_canceled");
    throw brokerError(errorCode);
  }
}

function awaitWithAbort(promise, signal) {
  throwIfAborted(signal);
  if (!signal) return promise;
  return new Promise((resolve, reject) => {
    const cancel = () => reject(brokerError("dataflow_credential_request_canceled"));
    signal.addEventListener("abort", cancel, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", cancel));
  });
}

function throwIfAborted(signal) {
  if (signal?.aborted) throw brokerError("dataflow_credential_request_canceled");
}

async function strictJson(response, errorCode) {
  let text;
  try {
    text = await response.text();
  } catch {
    throw brokerError(errorCode);
  }
  if (Buffer.byteLength(text, "utf8") > MAX_JSON_BYTES) throw brokerError(errorCode);
  try {
    const value = JSON.parse(text);
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid");
    return value;
  } catch {
    throw brokerError(errorCode);
  }
}

function valueAtJsonPath(value, path) {
  return path.reduce((current, key) => current && typeof current === "object" ? current[key] : undefined, value);
}

function jsonPath(value, errorCode) {
  const parts = Array.isArray(value) ? value : String(value || "").split(".");
  if (!parts.length || parts.some((part) => !/^[A-Za-z0-9_-]{1,80}$/.test(String(part)))) {
    throw brokerError(errorCode);
  }
  return parts.map(String);
}

function strictHttpsOrigin(value) {
  try {
    const url = new URL(String(value || ""));
    if (url.protocol !== "https:" || url.username || url.password || url.pathname !== "/" || url.search || url.hash) {
      throw new Error("invalid");
    }
    return url.origin;
  } catch {
    throw brokerError("dataflow_api_origin_invalid");
  }
}

function sameOriginPath(value) {
  const path = String(value || "").trim();
  if (!path.startsWith("/") || path.startsWith("//") || /[\r\n\0?#]/.test(path)) {
    throw brokerError("dataflow_auth_path_invalid");
  }
  return path;
}

function endpointUrl(origin, path) {
  const url = new URL(path, `${origin}/`);
  if (url.origin !== origin) throw brokerError("dataflow_auth_origin_mismatch");
  return url.toString();
}

function accessToken(value) {
  const token = String(value || "").trim();
  return token && token.length <= MAX_SECRET_LENGTH && !/[\s\0]/.test(token) ? token : "";
}

function accessTokenTtlMs({ expiresInSeconds, fallbackTtlMs }) {
  if (expiresInSeconds === null || expiresInSeconds === undefined) return fallbackTtlMs;
  const milliseconds = Number(expiresInSeconds) * 1000;
  if (!Number.isFinite(milliseconds) || milliseconds <= 0) throw brokerError("dataflow_access_token_expiry_invalid");
  return Math.min(milliseconds, MAX_ACCESS_TOKEN_TTL_MS);
}

function boundedTtl(value) {
  const ttl = Number(value);
  if (!Number.isFinite(ttl) || ttl <= 0) throw brokerError("dataflow_access_token_ttl_invalid");
  return Math.min(Math.round(ttl), MAX_ACCESS_TOKEN_TTL_MS);
}

function boundedMinimumValidity(value) {
  const result = Number(value);
  if (!Number.isFinite(result) || result < 0) throw brokerError("dataflow_minimum_validity_invalid");
  return Math.min(Math.round(result), MAX_ACCESS_TOKEN_TTL_MS);
}

function validNow(value) {
  const currentTime = Number(value);
  if (!Number.isFinite(currentTime) || currentTime < 0) throw brokerError("dataflow_clock_invalid");
  return currentTime;
}

function normalizeSha256Fingerprint(value) {
  const canonical = String(value || "");
  if (!/^[a-f0-9]{64}$/.test(canonical)) throw brokerError("dataflow_certificate_fingerprint_invalid");
  return canonical;
}

function normalizePresentedFingerprint(value) {
  const presented = String(value || "").trim();
  const electronBase64 = presented.match(/^sha256\/([A-Za-z0-9+/]{43}=)$/i)?.[1] || "";
  if (electronBase64) {
    const digest = Buffer.from(electronBase64, "base64");
    if (digest.length === 32 && digest.toString("base64") === electronBase64) {
      return digest.toString("hex");
    }
  }
  const normalized = presented.replace(/^SHA256:/i, "").replaceAll(":", "").toLowerCase();
  return /^[a-f0-9]{64}$/.test(normalized) ? normalized : "";
}

function constantTimeTextEqual(left, right) {
  const leftBytes = Buffer.from(left, "utf8");
  const rightBytes = Buffer.from(right, "utf8");
  return leftBytes.length === rightBytes.length && crypto.timingSafeEqual(leftBytes, rightBytes);
}

function requiredOpaqueText(value, errorCode, maxLength) {
  const result = requiredText(value, errorCode, maxLength);
  if (!/^[A-Za-z0-9._:@-]+$/.test(result)) throw brokerError(errorCode);
  return result;
}

function verifiedEnterpriseUsername(value) {
  if (!value || typeof value !== "object" || Array.isArray(value) || value.type !== "verified_enterprise_username" ||
    Object.keys(value).some((key) => !["type", "value"].includes(key))) {
    throw brokerError("dataflow_expected_identity_invalid");
  }
  if (typeof value.value !== "string" || value.value !== value.value.toLowerCase() || !enterpriseUsername(value.value)) {
    throw brokerError("dataflow_expected_identity_invalid");
  }
  return Object.freeze({ type: "verified_enterprise_username", value: value.value });
}

function canonicalEnterpriseUsername(value) {
  if (typeof value !== "string" || !enterpriseUsername(value)) throw brokerError("dataflow_identity_value_invalid");
  return value.toLowerCase();
}

function enterpriseUsername(value) {
  return /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value);
}

function requiredText(value, errorCode, maxLength) {
  const result = String(value ?? "").trim();
  if (!result || result.length > maxLength || /[\r\n\0]/.test(result)) throw brokerError(errorCode);
  return result;
}

function assertSession(value) {
  for (const method of ["clearStorageData", "fetch", "setCertificateVerifyProc"]) {
    if (typeof value?.[method] !== "function") throw brokerError("dataflow_session_invalid");
  }
}

function brokerError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

export {
  CONTRACT_VERSION as DATAFLOW_DEVICE_SESSION_CREDENTIAL_BROKER_CONTRACT,
  TOOL_ID as DATAFLOW_TOOL_ID,
  createDataflowDeviceSessionCredentialBroker,
  dataflowCredentialPartition,
  installExactCertificateTrust,
};
