const ATTEMPT = /^device_read_[a-f0-9]{64}$/;
const DIGEST = /^[a-f0-9]{64}$/;

// Pure transport boundary. The host supplies an authenticated session and
// managed HTTPS evidence; bodies never select actor/tenant/device identity.
export function createDeviceReadTransport({ sessions, dispatch, isManagedHttpsRequest } = {}) {
  if (typeof sessions?.identity !== "function" || typeof dispatch?.claimNext !== "function" || typeof isManagedHttpsRequest !== "function")
    throw new TypeError("device_read_transport_dependencies_required");
  const blocked = () => Object.freeze({ ok: false, error: "device_read_unavailable" });
  function context(requestContext) {
    try {
      if (isManagedHttpsRequest({ requestContext }) !== true || !requestContext?.session) return null;
      const id = requestContext.req?.headers?.["x-digital-workforce-read-device"];
      if (typeof id !== "string" || !/^dwr_[a-f0-9]{32}$/.test(id)) return null;
      return { deviceSessionId: id, session: requestContext.session };
    } catch { return null; }
  }
  return Object.freeze({
    register({ body, requestContext } = {}) {
      const ctx = context(requestContext);
      if (!ctx || !(exact(body, ["capabilities"]) || exact(body, ["capabilities", "timeZone"]))) return blocked();
      const registration = sessions.register({ ...ctx, capabilities: body.capabilities, ...(body.timeZone === undefined ? {} : {timeZone:body.timeZone}) });
      return registration ? { ok: true, ...registration } : blocked();
    },
    revoke({ requestContext } = {}) {
      const ctx = context(requestContext);
      return ctx && sessions.revoke(ctx) ? { ok: true } : blocked();
    },
    async claim({ requestContext } = {}) {
      const ctx = context(requestContext), identity = ctx && sessions.identity(ctx);
      if (!identity) return blocked();
      try { return { ok: true, dispatch: await dispatch.claimNext(identity) }; } catch { return blocked(); }
    },
    async validate({ attemptId, body, requestContext } = {}) {
      const ctx = context(requestContext), identity = ctx && sessions.identity(ctx);
      if (!identity || !ATTEMPT.test(attemptId || "") || !exact(body, ["operationDigest"]) || !DIGEST.test(body.operationDigest)) return blocked();
      try { return { ok: true, allowed: await dispatch.validateClaim(identity, attemptId, body.operationDigest) }; } catch { return blocked(); }
    },
    async complete({ attemptId, body, requestContext } = {}) {
      const ctx = context(requestContext), identity = ctx && sessions.identity(ctx);
      const fields = body?.status === "completed" ? ["operationDigest", "status", "result"] : ["operationDigest", "status"];
      if (!identity || !ATTEMPT.test(attemptId || "") || !exact(body, fields) || !DIGEST.test(body.operationDigest) ||
        !["completed", "failed", "canceled"].includes(body.status)) return blocked();
      try { return await dispatch.complete(identity, { ...body, attemptId }); } catch { return blocked(); }
    },
  });
}
function exact(value, fields) {
  return Boolean(value && Object.getPrototypeOf(value) === Object.prototype && Object.keys(value).length === fields.length && fields.every(key => Object.hasOwn(value, key)));
}
