import { normalizeDesktopConversationHistoryPolicy } from "../../desktop-channel-mvp/shared/desktop-conversation-history-policy.mjs";

function createConversationHistoryPolicyService({ readManagedPolicy } = {}) {
  if (typeof readManagedPolicy !== "function") throw new TypeError("conversation history policy service requires readManagedPolicy");

  function resolve({ route = {}, session = {} } = {}) {
    const normalized = normalizeDesktopConversationHistoryPolicy(readManagedPolicy());
    if (normalized.ok !== true || normalized.enabled !== true) return disabled(normalized.reason || "policy_unavailable");
    const policy = normalized.policy;
    if (policy.centerInstanceId !== route.centerInstanceId || policy.tenantScope !== route.tenantScope ||
      policy.centerInstanceId !== session.centerInstanceId || policy.tenantScope !== session.tenantScope) {
      return disabled("policy_namespace_mismatch");
    }
    return { ok: true, enabled: true, status: "enabled", reason: "", policy };
  }

  function bootstrap({ authExpiresAt = "", sessions = {}, groupSessions = {} } = {}) {
    const normalized = normalizeDesktopConversationHistoryPolicy(readManagedPolicy());
    if (normalized.ok !== true || normalized.enabled !== true) {
      return {
        contractVersion: "desktop-conversation-history-bootstrap.v2",
        enabled: false,
        status: "disabled",
        reason: normalized.reason || "policy_unavailable",
        policy: normalized.policy,
        authExpiresAt: validTimestamp(authExpiresAt),
        sessions: {},
        groupSessions: {},
      };
    }
    return {
      contractVersion: "desktop-conversation-history-bootstrap.v2",
      enabled: true,
      status: "enabled",
      reason: "",
      policy: normalized.policy,
      authExpiresAt: validTimestamp(authExpiresAt),
      sessions: normalizeSessions(sessions),
      groupSessions: normalizeGroupSessions(groupSessions),
    };
  }

  return { bootstrap, resolve };
}

function readManagedConversationHistoryPolicyFromEnvironment(environment = process.env) {
  const value = String(environment.DESKTOP_CONVERSATION_HISTORY_POLICY_JSON || "").trim();
  if (!value) return null;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function normalizeSessions(value = {}) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.fromEntries(Object.entries(value).flatMap(([employeeId, session]) => {
    const safeEmployeeId = identifier(employeeId);
    const sessionId = identifier(session?.sessionId);
    const sessionExpiresAt = validTimestamp(session?.sessionExpiresAt);
    return safeEmployeeId && sessionId && sessionExpiresAt
      ? [[safeEmployeeId, { sessionId, sessionExpiresAt }]]
      : [];
  }));
}

function normalizeGroupSessions(value = {}) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.fromEntries(Object.entries(value).flatMap(([goalId, session]) => {
    const safeGoalId = identifier(goalId);
    const employeeId = identifier(session?.employeeId);
    const sessionId = identifier(session?.sessionId);
    const sessionExpiresAt = validTimestamp(session?.sessionExpiresAt);
    return safeGoalId && employeeId === "group-orchestrator" && sessionId && sessionExpiresAt
      ? [[safeGoalId, { employeeId, sessionId, sessionExpiresAt }]]
      : [];
  }));
}

function disabled(reason) {
  return { ok: false, enabled: false, status: "disabled", reason, policy: null };
}

function identifier(value) {
  const result = String(value || "").trim();
  return /^[a-zA-Z0-9._:@-]{1,240}$/.test(result) ? result : "";
}

function validTimestamp(value) {
  const text = String(value || "").trim();
  return Number.isFinite(Date.parse(text)) ? new Date(text).toISOString() : "";
}

export {
  createConversationHistoryPolicyService,
  readManagedConversationHistoryPolicyFromEnvironment,
};
