import { authorizeSession, sessionMatchesActorLocator } from "./authorization-session-service.mjs";

function createExecutionRecoverySessionResolver({ authorizationSessions, refreshIdentity } = {}) {
  if (typeof authorizationSessions?.resolveSession !== "function" || typeof refreshIdentity !== "function") {
    throw new TypeError("execution_recovery_session_resolver_invalid");
  }

  return async function resolveExecutionRecoverySession(locator = {}, { sessionId = "" } = {}) {
    const current = sessionId ? authorizationSessions.resolveSession(String(sessionId)) : null;
    if (current?.allowed && sessionMatchesActorLocator(current.session, locator)) return current.session;
    const matching = authorizationSessions.resolveSessionByActorLocator?.(locator);
    if (matching?.allowed && sessionMatchesActorLocator(matching.session, locator)) return matching.session;

    try {
      const identity = await refreshIdentity(locator);
      if (identity?.accountProjection?.accountStatus !== "active") return null;
      return authorizeSession(identity.session, identity.accountProjection);
    } catch {
      return null;
    }
  };
}

export {
  createExecutionRecoverySessionResolver,
  sessionMatchesActorLocator,
};
