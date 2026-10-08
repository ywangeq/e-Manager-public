const CONTRACT_VERSION = "desktop-conversation-history-policy.v1";
const BOOTSTRAP_CONTRACT_V1 = "desktop-conversation-history-bootstrap.v1";
const BOOTSTRAP_CONTRACT_VERSION = "desktop-conversation-history-bootstrap.v2";
const HISTORY_SOURCE = "center_projection";
const CACHE_MODES = new Set(["disabled", "encrypted_read_only"]);
const RESUME_POLICIES = new Set(["disabled", "explicit", "same_authenticated_session"]);
const TOP_LEVEL_FIELDS = new Set([
  "contractVersion",
  "centerInstanceId",
  "tenantScope",
  "historySource",
  "projection",
  "offlineCache",
  "resumePolicy",
  "policyVersion",
]);
const PROJECTION_FIELDS = new Set(["revision", "paging", "messageGet"]);
const CACHE_FIELDS = new Set([
  "mode",
  "maxTtlSeconds",
  "maxSessions",
  "maxTurns",
  "maxChars",
  "clearOnLogout",
]);
const BOOTSTRAP_FIELDS = new Set([
  "contractVersion", "enabled", "status", "reason", "policy", "authExpiresAt", "sessions", "groupSessions",
]);

function normalizeDesktopConversationHistoryPolicy(value = null) {
  const parsed = parsePolicy(value);
  return parsed.ok
    ? policyResult(parsed.policy.offlineCache.mode === "encrypted_read_only", "valid", parsed.policy)
    : failClosedResult(parsed.reason);
}

function resolveEffectiveDesktopConversationHistoryPolicy({
  authExpiresAt = "",
  centerManagedPolicy = null,
  now = Date.now(),
  packagedSafetyCeiling = null,
  sessionExpiresAt = "",
} = {}) {
  const packaged = parsePolicy(packagedSafetyCeiling);
  if (!packaged.ok) return failClosedResult(`packaged_${packaged.reason}`);

  const center = parsePolicy(centerManagedPolicy);
  if (!center.ok) return failClosedResult(`center_${center.reason}`, packaged.policy);
  if (!sameNamespace(packaged.policy, center.policy)) {
    return failClosedResult("center_namespace_mismatch", packaged.policy);
  }
  if (centerPolicyExpandsCeiling(packaged.policy, center.policy)) {
    return failClosedResult("center_policy_exceeds_packaged_ceiling", packaged.policy);
  }

  const policy = intersectPolicies(packaged.policy, center.policy);
  if (policy.offlineCache.mode === "disabled") {
    return policyResult(false, "disabled_by_policy", policy);
  }

  const nowMs = Number(now);
  const sessionRemainingSeconds = remainingSeconds(sessionExpiresAt, nowMs);
  const authRemainingSeconds = remainingSeconds(authExpiresAt, nowMs);
  if (!Number.isFinite(nowMs) || sessionRemainingSeconds <= 0 || authRemainingSeconds <= 0) {
    return failClosedResult("session_or_auth_expired", policy);
  }

  const maxTtlSeconds = Math.min(
    policy.offlineCache.maxTtlSeconds,
    sessionRemainingSeconds,
    authRemainingSeconds,
  );
  if (maxTtlSeconds <= 0) return failClosedResult("session_or_auth_expired", policy);

  return policyResult(true, "enabled", {
    ...policy,
    offlineCache: { ...policy.offlineCache, maxTtlSeconds },
  });
}

function normalizeDesktopConversationHistoryBootstrap(value = null) {
  if (!isPlainObject(value) || hasUnknownFields(value, BOOTSTRAP_FIELDS) ||
    ![BOOTSTRAP_CONTRACT_V1, BOOTSTRAP_CONTRACT_VERSION].includes(value.contractVersion)) {
    return { ok: false, enabled: false, reason: "bootstrap_shape_invalid", bootstrap: null };
  }
  if (value.enabled !== true || value.status !== "enabled") {
    return {
      ok: true,
      enabled: false,
      reason: strictReason(value.reason) || "disabled_by_center",
      bootstrap: null,
    };
  }
  const normalizedPolicy = normalizeDesktopConversationHistoryPolicy(value.policy);
  const authExpiresAt = normalizedTimestamp(value.authExpiresAt);
  if (!normalizedPolicy.ok || !normalizedPolicy.enabled || !authExpiresAt) {
    return { ok: false, enabled: false, reason: "bootstrap_policy_invalid", bootstrap: null };
  }
  const sessions = normalizeBootstrapSessions(value.sessions, authExpiresAt);
  if (!sessions) return { ok: false, enabled: false, reason: "bootstrap_sessions_invalid", bootstrap: null };
  const groupSessions = value.contractVersion === BOOTSTRAP_CONTRACT_VERSION
    ? normalizeBootstrapGroupSessions(value.groupSessions, authExpiresAt)
    : {};
  if (!groupSessions) return { ok: false, enabled: false, reason: "bootstrap_group_sessions_invalid", bootstrap: null };
  return {
    ok: true,
    enabled: true,
    reason: "",
    bootstrap: {
      contractVersion: BOOTSTRAP_CONTRACT_VERSION,
      enabled: true,
      status: "enabled",
      reason: "",
      policy: normalizedPolicy.policy,
      authExpiresAt,
      sessions,
      groupSessions,
    },
  };
}

function parsePolicy(value) {
  if (!isPlainObject(value) || hasUnknownFields(value, TOP_LEVEL_FIELDS)) {
    return parseFailure("policy_shape_invalid");
  }
  if (value.contractVersion !== CONTRACT_VERSION) return parseFailure("contract_version_unsupported");

  const centerInstanceId = strictIdentifier(value.centerInstanceId);
  const tenantScope = strictIdentifier(value.tenantScope);
  const policyVersion = strictIdentifier(value.policyVersion);
  if (!centerInstanceId || !tenantScope) return parseFailure("namespace_invalid");
  if (!policyVersion) return parseFailure("policy_version_invalid");
  if (value.historySource !== HISTORY_SOURCE) return parseFailure("history_source_unsupported");

  const projection = parseProjection(value.projection);
  if (!projection) return parseFailure("projection_invalid");
  const offlineCache = parseOfflineCache(value.offlineCache, projection);
  if (!offlineCache) return parseFailure("offline_cache_invalid");
  if (!RESUME_POLICIES.has(value.resumePolicy)) return parseFailure("resume_policy_invalid");

  return {
    ok: true,
    policy: {
      contractVersion: CONTRACT_VERSION,
      centerInstanceId,
      tenantScope,
      historySource: HISTORY_SOURCE,
      projection,
      offlineCache,
      resumePolicy: value.resumePolicy,
      policyVersion,
    },
  };
}

function parseProjection(value) {
  if (!isPlainObject(value) || hasUnknownFields(value, PROJECTION_FIELDS)) return null;
  if (![value.revision, value.paging, value.messageGet].every((item) => typeof item === "boolean")) return null;
  return {
    revision: value.revision,
    paging: value.paging,
    messageGet: value.messageGet,
  };
}

function parseOfflineCache(value, projection) {
  if (!isPlainObject(value) || hasUnknownFields(value, CACHE_FIELDS)) return null;
  if (!CACHE_MODES.has(value.mode) || value.clearOnLogout !== true) return null;

  const limits = [value.maxTtlSeconds, value.maxSessions, value.maxTurns, value.maxChars];
  if (!limits.every(Number.isSafeInteger)) return null;
  if (value.mode === "disabled" && !limits.every((item) => item === 0)) return null;
  if (value.mode === "encrypted_read_only" && (!projection.revision || !limits.every((item) => item > 0))) return null;

  return {
    mode: value.mode,
    maxTtlSeconds: value.maxTtlSeconds,
    maxSessions: value.maxSessions,
    maxTurns: value.maxTurns,
    maxChars: value.maxChars,
    clearOnLogout: true,
  };
}

function centerPolicyExpandsCeiling(packaged, center) {
  if (cacheModeRank(center.offlineCache.mode) > cacheModeRank(packaged.offlineCache.mode)) return true;
  if (resumePolicyRank(center.resumePolicy) > resumePolicyRank(packaged.resumePolicy)) return true;
  if ([...PROJECTION_FIELDS].some((key) => center.projection[key] && !packaged.projection[key])) return true;
  if (center.offlineCache.mode === "encrypted_read_only") {
    return ["maxTtlSeconds", "maxSessions", "maxTurns", "maxChars"]
      .some((key) => center.offlineCache[key] > packaged.offlineCache[key]);
  }
  return false;
}

function intersectPolicies(packaged, center) {
  const cacheEnabled = packaged.offlineCache.mode === "encrypted_read_only"
    && center.offlineCache.mode === "encrypted_read_only";
  return {
    contractVersion: CONTRACT_VERSION,
    centerInstanceId: packaged.centerInstanceId,
    tenantScope: packaged.tenantScope,
    historySource: HISTORY_SOURCE,
    projection: {
      revision: packaged.projection.revision && center.projection.revision,
      paging: packaged.projection.paging && center.projection.paging,
      messageGet: packaged.projection.messageGet && center.projection.messageGet,
    },
    offlineCache: cacheEnabled ? {
      mode: "encrypted_read_only",
      maxTtlSeconds: Math.min(packaged.offlineCache.maxTtlSeconds, center.offlineCache.maxTtlSeconds),
      maxSessions: Math.min(packaged.offlineCache.maxSessions, center.offlineCache.maxSessions),
      maxTurns: Math.min(packaged.offlineCache.maxTurns, center.offlineCache.maxTurns),
      maxChars: Math.min(packaged.offlineCache.maxChars, center.offlineCache.maxChars),
      clearOnLogout: true,
    } : disabledCachePolicy(),
    resumePolicy: resumePolicyRank(center.resumePolicy) <= resumePolicyRank(packaged.resumePolicy)
      ? center.resumePolicy
      : "disabled",
    policyVersion: center.policyVersion,
  };
}

function failClosedResult(reason, trustedPolicy = null) {
  return {
    ok: false,
    enabled: false,
    status: "disabled",
    reason,
    policy: disabledPolicy(trustedPolicy),
  };
}

function policyResult(enabled, status, policy) {
  return {
    ok: true,
    enabled,
    status,
    reason: "",
    policy,
  };
}

function disabledPolicy(trustedPolicy = null) {
  return {
    contractVersion: CONTRACT_VERSION,
    centerInstanceId: strictIdentifier(trustedPolicy?.centerInstanceId),
    tenantScope: strictIdentifier(trustedPolicy?.tenantScope),
    historySource: HISTORY_SOURCE,
    projection: { revision: false, paging: false, messageGet: false },
    offlineCache: disabledCachePolicy(),
    resumePolicy: "disabled",
    policyVersion: strictIdentifier(trustedPolicy?.policyVersion),
  };
}

function disabledCachePolicy() {
  return {
    mode: "disabled",
    maxTtlSeconds: 0,
    maxSessions: 0,
    maxTurns: 0,
    maxChars: 0,
    clearOnLogout: true,
  };
}

function remainingSeconds(expiresAt, nowMs) {
  if (typeof expiresAt !== "string" || !expiresAt.trim() || !Number.isFinite(nowMs)) return 0;
  const expiresAtMs = Date.parse(expiresAt);
  return Number.isFinite(expiresAtMs) ? Math.floor((expiresAtMs - nowMs) / 1000) : 0;
}

function sameNamespace(left, right) {
  return left.centerInstanceId === right.centerInstanceId && left.tenantScope === right.tenantScope;
}

function normalizeBootstrapSessions(value, authExpiresAt) {
  if (!isPlainObject(value)) return null;
  const sessions = {};
  for (const [employeeIdValue, session] of Object.entries(value)) {
    const employeeId = strictTechnicalId(employeeIdValue);
    const sessionId = strictTechnicalId(session?.sessionId);
    const sessionExpiresAt = normalizedTimestamp(session?.sessionExpiresAt);
    if (!employeeId || !sessionId || !sessionExpiresAt || Date.parse(sessionExpiresAt) > Date.parse(authExpiresAt)) return null;
    sessions[employeeId] = { sessionId, sessionExpiresAt };
  }
  return sessions;
}

function normalizeBootstrapGroupSessions(value, authExpiresAt) {
  if (!isPlainObject(value)) return null;
  const result = {};
  for (const [goalIdValue, session] of Object.entries(value)) {
    const goalId = strictTechnicalId(goalIdValue);
    const employeeId = strictTechnicalId(session?.employeeId);
    const sessionId = strictTechnicalId(session?.sessionId);
    const sessionExpiresAt = normalizedTimestamp(session?.sessionExpiresAt);
    if (!goalId || !employeeId || employeeId !== "group-orchestrator" || !sessionId || !sessionExpiresAt ||
      Date.parse(sessionExpiresAt) > Date.parse(authExpiresAt)) return null;
    result[goalId] = { employeeId, sessionId, sessionExpiresAt };
  }
  return result;
}

function cacheModeRank(value) {
  return value === "encrypted_read_only" ? 1 : 0;
}

function resumePolicyRank(value) {
  if (value === "same_authenticated_session") return 2;
  if (value === "explicit") return 1;
  return 0;
}

function strictIdentifier(value) {
  const text = String(value || "").trim();
  return /^[a-zA-Z0-9._:@-]{1,160}$/.test(text) ? text : "";
}

function strictTechnicalId(value) {
  const text = String(value || "").trim();
  return /^[a-zA-Z0-9._:@-]{1,240}$/.test(text) ? text : "";
}

function normalizedTimestamp(value) {
  const text = String(value || "").trim();
  return Number.isFinite(Date.parse(text)) ? new Date(text).toISOString() : "";
}

function strictReason(value) {
  const text = String(value || "").trim();
  return /^[a-zA-Z0-9._:@-]{1,160}$/.test(text) ? text : "";
}

function parseFailure(reason) {
  return { ok: false, reason };
}

function hasUnknownFields(value, allowed) {
  return Object.keys(value).some((key) => !allowed.has(key));
}

function isPlainObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

export {
  BOOTSTRAP_CONTRACT_VERSION,
  CONTRACT_VERSION,
  normalizeDesktopConversationHistoryBootstrap,
  normalizeDesktopConversationHistoryPolicy,
  resolveEffectiveDesktopConversationHistoryPolicy,
};
