import crypto from "node:crypto";

const DEVICE_SESSION_ID = /^dws_[a-f0-9]{32}$/;

// Composes existing authenticated session, Device-session and canonical-task
// authorities for the pure dispatch transport. It owns no route or state.
function createDesktopSandboxDispatchContextResolver({
  deviceSessionRegistry = null,
  dispatchRepository = null,
  now = () => new Date(),
  resolveSessionRoute = null,
  tenantScope = "",
} = {}) {
  const managedTenantScope = String(tenantScope || "").trim();
  if (typeof deviceSessionRegistry?.isBound !== "function" || typeof deviceSessionRegistry?.resolveBoundTask !== "function" || typeof dispatchRepository?.findForDevice !== "function" ||
    typeof now !== "function" || typeof resolveSessionRoute !== "function" || !managedTenantScope) {
    throw new TypeError("desktop sandbox dispatch context resolver dependencies are required");
  }

  function resolveClaimContext({ requestContext = null } = {}) {
    return resolve({ attemptId: "", requestContext, claim: true });
  }

  function resolveClaimWaitContext({ requestContext = null, taskId = "" } = {}) {
    const session = requestContext?.session;
    const deviceSessionId = deviceSessionIdFor(requestContext?.req);
    const normalizedTaskId = String(taskId || "").trim();
    if (!deviceSessionId || !/^[A-Za-z0-9][A-Za-z0-9._:@-]{0,127}$/.test(normalizedTaskId) ||
      !deviceSessionRegistry.isBound({ deviceSessionId, session }) ||
      !deviceSessionRegistry.resolveBoundTask({ deviceSessionId, session, taskId: normalizedTaskId })) return null;
    return Object.freeze({ deviceSessionId, session, taskId: normalizedTaskId });
  }

  function resolveActionContext({ attemptId = "", expectedAttemptStatus = "", requestContext = null } = {}) {
    return resolve({ attemptId, expectedAttemptStatus, requestContext, claim: false });
  }

  function resolve({ attemptId, expectedAttemptStatus = "", requestContext, claim }) {
    const session = requestContext?.session;
    const deviceSessionId = deviceSessionIdFor(requestContext?.req);
    if (!deviceSessionId || !deviceSessionRegistry.isBound({ deviceSessionId, session })) return null;
    let located;
    try {
      located = dispatchRepository.findForDevice({
        attemptId,
        deviceSessionDigest: sha256(deviceSessionId),
        now: nowIso(now),
        tenantScope: managedTenantScope,
      });
    } catch {
      return null;
    }
    const attempt = located?.attempt;
    const runtimeTask = located?.task;
    const taskOwnership = ownershipFor(runtimeTask);
    if (!attempt || !runtimeTask || !taskOwnership || runtimeTask.tenantScope !== managedTenantScope || (claim && attempt.status !== "prepared") ||
      (expectedAttemptStatus && attempt.status !== expectedAttemptStatus) ||
      attempt.taskId !== runtimeTask.taskId || attempt.tenantScope !== runtimeTask.tenantScope ||
      attempt.taskInputDigest !== runtimeTask.inputDigest || !sameActor({ runtimeTask, session, resolveSessionRoute })) {
      return null;
    }
    const base = Object.freeze({
      attemptId: attempt.attemptId,
      deviceSessionId,
      runtimeTask,
      session,
      taskOwnership,
    });
    if (!claim) return base;
    return Object.freeze({
      ...base,
      operationDigest: attempt.operationDigest,
      taskInputDigest: attempt.taskInputDigest,
      workspaceInputDigest: attempt.workspaceInputDigest,
    });
  }

  return Object.freeze({ resolveActionContext, resolveClaimContext, resolveClaimWaitContext });
}

function deviceSessionIdFor(req = null) {
  const header = req?.headers?.["x-digital-workforce-device-session"];
  const value = Array.isArray(header) ? "" : String(header || "").trim().toLowerCase();
  return DEVICE_SESSION_ID.test(value) ? value : "";
}

function ownershipFor(task = null) {
  if (!task?.lease || !Number.isSafeInteger(task.fencingToken) || task.fencingToken < 1 ||
    !task.lease.leaseId || !task.lease.workerIdDigest) return null;
  return Object.freeze({
    lease: Object.freeze({
      fencingToken: task.fencingToken,
      leaseId: task.lease.leaseId,
      workerIdDigest: task.lease.workerIdDigest,
    }),
    task: Object.freeze({ taskId: task.taskId }),
  });
}

function sameActor({ runtimeTask, session, resolveSessionRoute }) {
  let route;
  try {
    route = resolveSessionRoute({ channelId: "desktop", employeeId: runtimeTask.employeeId, session });
  } catch {
    return false;
  }
  return route?.actorIssuer === runtimeTask.actorIssuer && route?.actorSubjectDigest === runtimeTask.actorSubjectDigest;
}

function nowIso(clock) {
  const value = new Date(clock());
  if (!Number.isFinite(value.getTime())) throw new TypeError("desktop sandbox dispatch context resolver clock is invalid");
  return value.toISOString();
}

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

export { createDesktopSandboxDispatchContextResolver };
