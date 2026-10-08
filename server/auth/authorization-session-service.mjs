import crypto from "node:crypto";

const CONTRACT_VERSION = "session-authorization.v1";
const ACTIVE_ACCOUNT_STATUS = "active";

export function createAuthorizationSessionService({
  authorizationMaxAgeMs = 24 * 60 * 60 * 1000,
  now = () => Date.now(),
  sessionTtlMs = 8 * 60 * 60 * 1000,
} = {}) {
  const sessions = new Map();
  const currentProjectionBySubject = new Map();
  const sessionIdsBySubject = new Map();

  function createSession(session, accountProjection, options = {}) {
    const sessionId = options.sessionId || crypto.randomBytes(24).toString("hex");
    const issuedAtMs = now();
    const nextSession = authorizeSession(session, accountProjection, {
      authorizationMaxAgeMs,
      expiresAt: new Date(issuedAtMs + sessionTtlMs).toISOString(),
      signedInAt: session.signedInAt || new Date(issuedAtMs).toISOString(),
      verifiedAt: options.verifiedAt || new Date(issuedAtMs).toISOString(),
    });
    const decision = authorizationDecision(nextSession, { now: issuedAtMs });
    updateCurrentProjection(nextSession);
    if (!decision.allowed) return { ...decision, session: nextSession, sessionId };
    saveSession(sessionId, nextSession);
    return { allowed: true, session: nextSession, sessionId };
  }

  function revalidateSession(sessionId, session, accountProjection, options = {}) {
    const previous = sessions.get(sessionId);
    if (!previous) return denied("authentication_required", 401);
    const verifiedAtMs = now();
    const nextSession = authorizeSession(session, accountProjection, {
      authorizationMaxAgeMs,
      expiresAt: previous.expiresAt,
      signedInAt: previous.signedInAt,
      verifiedAt: options.verifiedAt || new Date(verifiedAtMs).toISOString(),
    });
    const decision = authorizationDecision(nextSession, { now: verifiedAtMs });
    updateCurrentProjection(nextSession);
    if (!decision.allowed) {
      revokeSubject(subjectId(nextSession));
      return { ...decision, session: nextSession, sessionId };
    }
    removeSession(sessionId);
    saveSession(sessionId, nextSession);
    return { allowed: true, session: nextSession, sessionId };
  }

  function resolveSession(sessionId) {
    const session = sessions.get(sessionId);
    if (!session) return denied("authentication_required", 401);

    const nowMs = now();
    if (!validFutureTime(session.expiresAt, nowMs)) {
      removeSession(sessionId);
      return denied("session_expired", 401);
    }

    const projection = currentProjectionBySubject.get(subjectId(session));
    if (projection?.accountStatus && projection.accountStatus !== ACTIVE_ACCOUNT_STATUS) {
      const decision = accountStatusDecision(projection.accountStatus);
      revokeSubject(subjectId(session));
      return decision;
    }
    if (projection?.permissionVersion && projection.permissionVersion !== session.authorization?.permissionVersion) {
      return denied("authorization_version_mismatch", 403);
    }

    const decision = authorizationDecision(session, { now: nowMs });
    if (!decision.allowed) return decision;
    return { allowed: true, session, sessionId };
  }

  function resolveSessionByActorLocator(locator = {}) {
    for (const sessionId of sessions.keys()) {
      const decision = resolveSession(sessionId);
      if (decision.allowed && sessionMatchesActorLocator(decision.session, locator)) return decision;
    }
    return denied("authentication_required", 401);
  }

  function peekSession(sessionId) {
    const session = sessions.get(sessionId);
    if (!session) return denied("authentication_required", 401);
    if (!validFutureTime(session.expiresAt, now())) {
      removeSession(sessionId);
      return denied("session_expired", 401);
    }
    return { allowed: true, session, sessionId };
  }

  function removeSession(sessionId) {
    const session = sessions.get(sessionId);
    if (!session) return;
    sessions.delete(sessionId);
    const id = subjectId(session);
    const ids = sessionIdsBySubject.get(id);
    ids?.delete(sessionId);
    if (ids && ids.size === 0) sessionIdsBySubject.delete(id);
  }

  function revokeSubject(id) {
    const ids = sessionIdsBySubject.get(id);
    if (!ids) return 0;
    const count = ids.size;
    for (const sessionId of [...ids]) removeSession(sessionId);
    return count;
  }

  function saveSession(sessionId, session) {
    sessions.set(sessionId, session);
    const id = subjectId(session);
    if (!sessionIdsBySubject.has(id)) sessionIdsBySubject.set(id, new Set());
    sessionIdsBySubject.get(id).add(sessionId);
  }

  function updateCurrentProjection(session) {
    const id = subjectId(session);
    if (!id) return;
    currentProjectionBySubject.set(id, {
      accountStatus: session.authorization?.accountStatus || "unknown",
      lastVerifiedAt: session.authorization?.lastVerifiedAt || "",
      permissionVersion: session.authorization?.permissionVersion || "",
    });
  }

  return {
    createSession,
    peekSession,
    removeSession,
    resolveSession,
    resolveSessionByActorLocator,
    revalidateSession,
    revokeSubject,
  };
}

export function sessionMatchesActorLocator(session = {}, locator = {}) {
  const identitySource = cleanText(session.identitySource || session.authorization?.identitySource);
  if (!identitySource || identitySource !== cleanText(locator.identitySource)) return false;
  const expected = cleanText(locator.subjectId);
  if (!expected) return false;
  const type = cleanText(locator.subjectIdType);
  if (type === "feishu_id") return expected === cleanText(session.feishuUserId);
  if (type === "employee_id") return expected === cleanText(session.employeeId);
  if (type === "email") return expected.toLowerCase() === cleanText(session.email).toLowerCase();
  return false;
}

export function authorizeSession(session = {}, accountProjection = {}, options = {}) {
  const lastVerifiedAt = normalizeTime(options.verifiedAt) || new Date().toISOString();
  const maxAgeMs = positiveNumber(options.authorizationMaxAgeMs, 24 * 60 * 60 * 1000);
  const validUntil = new Date(new Date(lastVerifiedAt).getTime() + maxAgeMs).toISOString();
  const accountStatus = normalizeAccountStatus(accountProjection.accountStatus);
  const authorization = {
    contractVersion: CONTRACT_VERSION,
    accountStatus,
    permissionVersion: permissionVersion(session, accountStatus),
    lastVerifiedAt,
    validUntil,
    identitySource: cleanText(accountProjection.identitySource || session.identitySource),
    statusEvidence: accountProjection.explicitStatusEvidence ? "explicit" : "member_resolved",
  };
  return {
    ...session,
    signedInAt: normalizeTime(options.signedInAt || session.signedInAt) || lastVerifiedAt,
    expiresAt: normalizeTime(options.expiresAt || session.expiresAt) || validUntil,
    authorization,
  };
}

export function authorizationDecision(session, options = {}) {
  if (!session || !subjectId(session)) return denied("authentication_required", 401);
  const authorization = session.authorization;
  if (!authorization || authorization.contractVersion !== CONTRACT_VERSION) {
    return denied("authorization_snapshot_required", 403);
  }
  if (authorization.accountStatus !== ACTIVE_ACCOUNT_STATUS) {
    return accountStatusDecision(authorization.accountStatus);
  }
  const nowMs = Number.isFinite(options.now) ? options.now : Date.now();
  if (!validFutureTime(authorization.validUntil, nowMs)) return denied("authorization_stale", 403);
  return { allowed: true };
}

function accountStatusDecision(status) {
  if (status === "blocked") return denied("account_blocked", 403);
  if (status === "disabled") return denied("account_disabled", 403);
  return denied("account_status_unknown", 403);
}

function permissionVersion(session, accountStatus) {
  const canonical = {
    accountStatus,
    departmentId: cleanText(session.departmentId),
    employeeId: subjectId(session),
    governanceRole: cleanText(session.governanceRole),
    identitySource: cleanText(session.identitySource),
    managedDepartmentIds: cleanList(session.managedDepartmentIds),
    permissions: cleanList(session.permissions),
    reviewDepartmentIds: cleanList(session.reviewDepartmentIds),
    role: cleanText(session.role),
  };
  return crypto.createHash("sha256").update(JSON.stringify(canonical)).digest("hex").slice(0, 20);
}

function subjectId(session = {}) {
  return cleanText(session.employeeId || session.feishuUserId || session.employeeNo || session.email);
}

function cleanList(value) {
  return [...new Set((Array.isArray(value) ? value : []).map(cleanText).filter(Boolean))].sort();
}

function cleanText(value) {
  return String(value || "").replace(/\s+/g, " ").trim().slice(0, 240);
}

function normalizeAccountStatus(value) {
  const normalized = cleanText(value).toLowerCase();
  return ["active", "disabled", "blocked"].includes(normalized) ? normalized : "unknown";
}

function normalizeTime(value) {
  const date = new Date(value || "");
  return Number.isNaN(date.getTime()) ? "" : date.toISOString();
}

function validFutureTime(value, nowMs) {
  const timestamp = new Date(value || "").getTime();
  return Number.isFinite(timestamp) && timestamp > nowMs;
}

function positiveNumber(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : fallback;
}

function denied(error, statusCode) {
  return { allowed: false, error, statusCode };
}

export { CONTRACT_VERSION as SESSION_AUTHORIZATION_CONTRACT_VERSION };
