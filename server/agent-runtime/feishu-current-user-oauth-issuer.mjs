import crypto from "node:crypto";

const FEISHU_CURRENT_USER_OAUTH_ISSUER_ADAPTER_ID = "feishu-current-user-oauth.v1";
const ISSUED_CREDENTIAL_CONTRACT_VERSION = "current-user-tool-issued-credential.v1";
const AUTHORIZATION_ACTION_CONTRACT_VERSION = "current-user-tool-authorization-action.v1";
const TOKEN_ENDPOINT = "https://open.feishu.cn/open-apis/authen/v2/oauth/token";
const USER_INFO_ENDPOINT = "https://open.feishu.cn/open-apis/authen/v1/user_info";
const AUTHORIZE_ENDPOINT = "https://accounts.feishu.cn/open-apis/authen/v1/authorize";
const ACCESS_TOKEN_SKEW_MS = 30_000;
const SUBJECT_ID_TYPES = new Set(["feishu_sender_id", "verified_email_alias"]);

function createFeishuCurrentUserOAuthIssuer({
  fetch = globalThis.fetch,
  now = () => new Date(),
  readEmployeeAppCredentials,
  redirectUri,
  store,
} = {}) {
  const callbackUri = normalizedRedirectUri(redirectUri);
  if (typeof fetch !== "function" || typeof now !== "function" ||
    typeof readEmployeeAppCredentials !== "function" ||
    typeof store?.createPendingAuthorization !== "function" ||
    typeof store?.consumePendingAuthorization !== "function" ||
    typeof store?.deleteGrant !== "function" || typeof store?.readGrant !== "function" || typeof store?.saveGrant !== "function") {
    throw new TypeError("feishu_current_user_oauth_issuer_invalid");
  }
  const pendingRefreshes = new Map();

  async function issueCredentialLease(grant, { signal = null } = {}) {
    requireGrant(grant);
    requireNotCanceled(signal);
    const at = trustedNow(now);
    const locator = grantLocator(grant);
    const credentials = employeeCredentials(grant.employeeId);
    let storedGrant = store.readGrant(locator);
    if (storedGrant && storedGrant.appCredentialDigest !== credentials.credentialDigest) {
      store.deleteGrant(locator);
      storedGrant = null;
    }
    if (usableAccessGrant(storedGrant, grant.scopes, at)) return issuedCredential(storedGrant, grant);
    if (refreshableGrant(storedGrant, at)) {
      try {
        const refreshed = await refreshGrantOnce(storedGrant, credentials, { signal });
        if (usableAccessGrant(refreshed, grant.scopes, trustedNow(now))) return issuedCredential(refreshed, grant);
      } catch (error) {
        requireNotCanceled(signal);
        if (["feishu_current_user_oauth_grant_rejected", "feishu_current_user_oauth_scope_missing"].includes(error?.code)) {
          store.deleteGrant(locator);
          throw authorizationRequired(grant);
        }
        throw error;
      }
    }
    throw authorizationRequired(grant);
  }

  async function handleCallback({ code, state, signal = null } = {}) {
    const authorizationCode = requiredText(code, 4_096, "feishu_current_user_oauth_callback_invalid");
    const pending = store.consumePendingAuthorization(requiredText(state, 180, "feishu_current_user_oauth_callback_invalid"));
    if (!pending) throw issuerError("feishu_current_user_oauth_state_invalid");
    requireNotCanceled(signal);
    const credentials = employeeCredentials(pending.employeeId);
    if (credentials.credentialDigest !== pending.appCredentialDigest) {
      throw issuerError("feishu_current_user_oauth_app_changed");
    }
    const token = await tokenRequest({
      body: {
        grant_type: "authorization_code",
        client_id: credentials.appId,
        client_secret: credentials.appSecret,
        code: authorizationCode,
        redirect_uri: callbackUri,
        code_verifier: pending.codeVerifier,
      },
      signal,
    });
    const userInfo = await requestUserInfo(token.accessToken, { signal });
    if (!SUBJECT_ID_TYPES.has(pending.subjectIdType) ||
      (pending.subjectIdType === "feishu_sender_id" && userInfo.openId !== pending.subjectId)) {
      throw issuerError("feishu_current_user_oauth_subject_mismatch");
    }
    requireScopes(token.scopes, pending.requiredScopes);
    const at = trustedNow(now);
    store.saveGrant({
      contractVersion: "feishu-current-user-oauth-grant.v1",
      actorSubjectDigest: pending.actorSubjectDigest,
      appCredentialDigest: pending.appCredentialDigest,
      authorizedOpenId: userInfo.openId,
      employeeId: pending.employeeId,
      subjectId: pending.subjectId,
      subjectIdType: pending.subjectIdType,
      scopes: token.scopes,
      accessToken: token.accessToken,
      refreshToken: token.refreshToken,
      issuedAt: at.toISOString(),
      expiresAt: new Date(at.getTime() + token.expiresInSeconds * 1_000).toISOString(),
      refreshExpiresAt: token.refreshToken
        ? new Date(at.getTime() + token.refreshExpiresInSeconds * 1_000).toISOString()
        : "",
    });
    return Object.freeze({
      contractVersion: "feishu-current-user-oauth-callback-result.v1",
      employeeId: pending.employeeId,
      status: "authorized",
      subjectIdType: pending.subjectIdType,
      scopes: Object.freeze([...token.scopes]),
    });
  }

  async function refreshGrantOnce(grant, credentials, { signal = null } = {}) {
    const key = refreshKey(grant);
    let refresh = pendingRefreshes.get(key);
    if (!refresh) {
      refresh = refreshGrant(grant, credentials, { signal: null });
      pendingRefreshes.set(key, refresh);
      refresh.finally(() => {
        if (pendingRefreshes.get(key) === refresh) pendingRefreshes.delete(key);
      }).catch(() => {});
    }
    return await awaitWithAbort(refresh, signal);
  }

  async function refreshGrant(grant, credentials, { signal = null } = {}) {
    const token = await tokenRequest({
      body: {
        grant_type: "refresh_token",
        client_id: credentials.appId,
        client_secret: credentials.appSecret,
        refresh_token: grant.refreshToken,
      },
      signal,
    });
    const at = trustedNow(now);
    const next = {
      contractVersion: "feishu-current-user-oauth-grant.v1",
      actorSubjectDigest: grant.actorSubjectDigest,
      appCredentialDigest: credentials.credentialDigest,
      authorizedOpenId: grant.authorizedOpenId,
      employeeId: grant.employeeId,
      subjectId: grant.subjectId,
      subjectIdType: grant.subjectIdType,
      scopes: token.scopes,
      accessToken: token.accessToken,
      refreshToken: token.refreshToken,
      issuedAt: at.toISOString(),
      expiresAt: new Date(at.getTime() + token.expiresInSeconds * 1_000).toISOString(),
      refreshExpiresAt: token.refreshToken
        ? new Date(at.getTime() + token.refreshExpiresInSeconds * 1_000).toISOString()
        : "",
    };
    store.saveGrant(next);
    return Object.freeze(next);
  }

  async function tokenRequest({ body, signal }) {
    requireNotCanceled(signal);
    let response;
    try {
      response = await fetch(TOKEN_ENDPOINT, {
        body: JSON.stringify(body),
        headers: { Accept: "application/json", "Content-Type": "application/json; charset=utf-8" },
        method: "POST",
        signal,
      });
    } catch {
      requireNotCanceled(signal);
      throw issuerError("feishu_current_user_oauth_exchange_unavailable");
    }
    const value = await safeJson(response);
    const oauthError = String(value?.error || value?.data?.error || "").trim().toLowerCase();
    const platformCode = Number(value?.code || 0);
    if (!response?.ok || platformCode !== 0 || oauthError) {
      const code = oauthError === "invalid_grant" || [20026, 20037, 20064, 20066, 20073].includes(platformCode)
        ? "feishu_current_user_oauth_grant_rejected"
        : platformCode === 20068
          ? "feishu_current_user_oauth_scope_missing"
          : "feishu_current_user_oauth_exchange_rejected";
      throw issuerError(code);
    }
    const accessToken = requiredSecret(value.access_token);
    const refreshToken = optionalSecret(value.refresh_token);
    const expiresInSeconds = boundedDurationSeconds(value.expires_in, 60, 24 * 60 * 60);
    const refreshExpiresInSeconds = refreshToken
      ? boundedDurationSeconds(value.refresh_token_expires_in, 60, 365 * 24 * 60 * 60)
      : 0;
    const scopes = normalizeScopes(String(value.scope || "").split(/\s+/));
    return Object.freeze({ accessToken, expiresInSeconds, refreshExpiresInSeconds, refreshToken, scopes });
  }

  async function requestUserInfo(accessToken, { signal }) {
    requireNotCanceled(signal);
    let response;
    try {
      response = await fetch(USER_INFO_ENDPOINT, {
        headers: { Accept: "application/json", Authorization: `Bearer ${accessToken}` },
        method: "GET",
        signal,
      });
    } catch {
      requireNotCanceled(signal);
      throw issuerError("feishu_current_user_oauth_user_info_unavailable");
    }
    const value = await safeJson(response);
    if (!response?.ok || Number(value?.code || 0) !== 0) throw issuerError("feishu_current_user_oauth_user_info_rejected");
    const openId = requiredText(value.open_id || value.data?.open_id, 240, "feishu_current_user_oauth_user_info_invalid");
    return Object.freeze({ openId });
  }

  function authorizationRequired(grant) {
    const credentials = employeeCredentials(grant.employeeId);
    const requiredScopes = normalizeScopes([...grant.scopes, "offline_access"]);
    const pending = store.createPendingAuthorization({
      actorSubjectDigest: grant.actorSubjectDigest,
      appCredentialDigest: credentials.credentialDigest,
      employeeId: grant.employeeId,
      requiredScopes,
      subjectId: grant.subjectId,
      subjectIdType: grant.subjectIdType,
    });
    const url = new URL(AUTHORIZE_ENDPOINT);
    url.searchParams.set("client_id", credentials.appId);
    url.searchParams.set("redirect_uri", callbackUri);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("scope", requiredScopes.join(" "));
    url.searchParams.set("state", pending.state);
    url.searchParams.set("code_challenge", pending.codeChallenge);
    url.searchParams.set("code_challenge_method", "S256");
    url.searchParams.set("prompt", "consent");
    const error = issuerError("current_user_tool_authorization_required");
    error.authorizationAction = Object.freeze({
      contractVersion: AUTHORIZATION_ACTION_CONTRACT_VERSION,
      kind: "open_url",
      label: "前往飞书授权",
      url: url.toString(),
      expiresAt: pending.expiresAt,
    });
    return error;
  }

  function employeeCredentials(employeeId) {
    const value = readEmployeeAppCredentials(requiredToken(employeeId, "feishu_current_user_oauth_employee_invalid")) || {};
    const appId = requiredText(value.appId, 240, "current_user_tool_credential_issuer_unconfigured");
    const appSecret = requiredSecret(value.appSecret, "current_user_tool_credential_issuer_unconfigured");
    const credentialDigest = crypto.createHash("sha256").update(`${appId}\0${appSecret}`).digest("hex");
    return Object.freeze({ appId, appSecret, credentialDigest });
  }

  return Object.freeze({
    adapterId: FEISHU_CURRENT_USER_OAUTH_ISSUER_ADAPTER_ID,
    handleCallback,
    issueCredentialLease,
  });
}

function requireGrant(grant = {}) {
  if (grant?.issuerAdapterId !== FEISHU_CURRENT_USER_OAUTH_ISSUER_ADAPTER_ID || grant?.audience !== "feishu-openapi" ||
    !SUBJECT_ID_TYPES.has(grant?.subjectIdType) || !Array.isArray(grant.scopes) || !grant.scopes.length) {
    throw issuerError("feishu_current_user_oauth_grant_invalid");
  }
  requiredDigest(grant.actorSubjectDigest, "feishu_current_user_oauth_grant_invalid");
  requiredToken(grant.employeeId, "feishu_current_user_oauth_employee_invalid");
  requiredText(grant.subjectId, 240, "feishu_current_user_oauth_grant_invalid");
}

function grantLocator(grant) {
  return {
    actorSubjectDigest: grant.actorSubjectDigest,
    employeeId: grant.employeeId,
    subjectId: grant.subjectId,
    subjectIdType: grant.subjectIdType,
  };
}

function refreshKey(grant) {
  return JSON.stringify([grant.actorSubjectDigest, grant.employeeId, grant.subjectIdType, grant.subjectId]);
}

function usableAccessGrant(storedGrant, requiredScopes, at) {
  return Boolean(storedGrant) && Date.parse(storedGrant.expiresAt) - ACCESS_TOKEN_SKEW_MS > at.getTime() &&
    scopesContain(storedGrant.scopes, requiredScopes);
}

function refreshableGrant(storedGrant, at) {
  return Boolean(storedGrant?.refreshToken) && Date.parse(storedGrant.refreshExpiresAt) - ACCESS_TOKEN_SKEW_MS > at.getTime();
}

function issuedCredential(storedGrant, grant) {
  return Object.freeze({
    contractVersion: ISSUED_CREDENTIAL_CONTRACT_VERSION,
    issuerAdapterId: FEISHU_CURRENT_USER_OAUTH_ISSUER_ADAPTER_ID,
    audience: grant.audience,
    subjectId: grant.subjectId,
    scopes: Object.freeze([...grant.scopes]),
    accessToken: storedGrant.accessToken,
    issuedAt: storedGrant.issuedAt,
    expiresAt: storedGrant.expiresAt,
  });
}

function requireScopes(actual, required) {
  if (!scopesContain(actual, required)) throw issuerError("feishu_current_user_oauth_scope_missing");
}

function scopesContain(actual, required) {
  const available = new Set(normalizeScopes(actual));
  return normalizeScopes(required).every((scope) => available.has(scope));
}

function normalizeScopes(value) {
  const scopes = [...new Set((Array.isArray(value) ? value : [])
    .map((item) => String(item || "").trim()).filter(Boolean))].sort();
  if (!scopes.length || scopes.length > 50 || scopes.some((scope) => scope.length > 180 || /\s/.test(scope))) {
    throw issuerError("feishu_current_user_oauth_scope_invalid");
  }
  return Object.freeze(scopes);
}

function normalizedRedirectUri(value) {
  try {
    const url = new URL(String(value || "").trim());
    const privateHttp = url.protocol === "http:" && privateLanHostname(url.hostname);
    if (!(url.protocol === "https:" || privateHttp) || url.username || url.password || url.hash) throw new Error();
    return url.toString();
  } catch {
    throw new TypeError("feishu_current_user_oauth_redirect_uri_invalid");
  }
}

function privateLanHostname(hostname) {
  const host = String(hostname || "").trim().toLowerCase();
  if (["localhost", "127.0.0.1", "::1", "[::1]"].includes(host)) return true;
  const octets = host.split(".").map(Number);
  if (octets.length !== 4 || octets.some((value) => !Number.isInteger(value) || value < 0 || value > 255)) return false;
  return octets[0] === 10 || (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31) ||
    (octets[0] === 192 && octets[1] === 168);
}

function requiredToken(value, code) {
  const token = String(value || "").trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,239}$/.test(token)) throw issuerError(code);
  return token;
}

function requiredText(value, maximum, code) {
  const text = String(value || "").trim();
  if (!text || text.length > maximum || /[\r\n\0]/.test(text)) throw issuerError(code);
  return text;
}

function requiredDigest(value, code) {
  const digest = String(value || "").trim().toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(digest)) throw issuerError(code);
  return digest;
}

function requiredSecret(value, code = "feishu_current_user_oauth_exchange_invalid") {
  const text = String(value || "").trim();
  if (!text || text.length > 8 * 1024 || /\s/.test(text)) throw issuerError(code);
  return text;
}

function optionalSecret(value) {
  return value ? requiredSecret(value) : "";
}

function boundedDurationSeconds(value, minimum, maximum) {
  const duration = Number(value);
  if (!Number.isSafeInteger(duration) || duration < minimum || duration > maximum) {
    throw issuerError("feishu_current_user_oauth_exchange_invalid");
  }
  return duration;
}

function trustedNow(now) {
  const value = now();
  const at = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(at.getTime())) throw new TypeError("feishu_current_user_oauth_clock_invalid");
  return at;
}

function requireNotCanceled(signal) {
  if (signal?.aborted) throw issuerError("current_user_tool_credential_lease_canceled");
}

async function awaitWithAbort(promise, signal) {
  requireNotCanceled(signal);
  if (!signal) return await promise;
  return await new Promise((resolve, reject) => {
    const abort = () => reject(issuerError("current_user_tool_credential_lease_canceled"));
    signal.addEventListener("abort", abort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}

async function safeJson(response) {
  try {
    return await response.json();
  } catch {
    throw issuerError("feishu_current_user_oauth_response_invalid");
  }
}

function issuerError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

export {
  AUTHORIZATION_ACTION_CONTRACT_VERSION,
  FEISHU_CURRENT_USER_OAUTH_ISSUER_ADAPTER_ID,
  createFeishuCurrentUserOAuthIssuer,
};
