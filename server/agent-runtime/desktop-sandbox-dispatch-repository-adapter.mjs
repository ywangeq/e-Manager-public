const DESKTOP_SANDBOX_DISPATCH_REPOSITORY_ADAPTER_CONTRACT_VERSION = "desktop-sandbox-dispatch-repository-adapter.v1";

// Adapts the pure dispatch service to the existing canonical task repository.
// It owns no state and never accepts private command input.
function createDesktopSandboxDispatchRepositoryAdapter({ repository = null } = {}) {
  if (!repository || typeof repository.createDesktopSandboxDispatchAttemptWithLease !== "function" ||
    typeof repository.readDesktopSandboxDispatchAttemptExact !== "function" ||
    typeof repository.readDesktopSandboxDispatchAttemptForDevice !== "function" ||
    typeof repository.transitionDesktopSandboxDispatchAttemptWithLease !== "function") {
    throw new TypeError("desktop sandbox dispatch repository adapter dependencies are required");
  }

  function saveOrGet({ attempt = null, taskOwnership = null } = {}) {
    const ownership = normalizeOwnership(taskOwnership);
    const result = repository.createDesktopSandboxDispatchAttemptWithLease({
      attemptId: attempt?.attemptId,
      deviceSessionDigest: attempt?.deviceSessionDigest,
      expiresAt: attempt?.expiresAt,
      fencingToken: ownership.fencingToken,
      leaseId: ownership.leaseId,
      now: attempt?.createdAt,
      operationDigest: attempt?.operationDigest,
      profileDigest: attempt?.profileDigest,
      taskId: attempt?.taskId,
      taskInputDigest: attempt?.taskInputDigest,
      tenantScope: attempt?.tenantScope,
      workerIdDigest: ownership.workerIdDigest,
      workspaceInputDigest: attempt?.workspaceInputDigest,
    });
    if (!result?.attempt) throw new TypeError("desktop sandbox dispatch attempt is unavailable");
    return result.attempt;
  }

  function get({ attemptId = "", taskIdentity = null } = {}) {
    const identity = normalizeTaskIdentity(taskIdentity);
    const attempt = repository.readDesktopSandboxDispatchAttemptExact({
      attemptId,
      taskId: identity.taskId,
      tenantScope: identity.tenantScope,
    });
    if (!attempt) throw new TypeError("desktop sandbox dispatch attempt is unavailable");
    return attempt;
  }

  function findForDevice({ attemptId = "", deviceSessionDigest = "", now = "", tenantScope = "" } = {}) {
    const located = repository.readDesktopSandboxDispatchAttemptForDevice({
      attemptId,
      deviceSessionDigest,
      now,
      tenantScope,
    });
    if (!located?.attempt || !located?.task) throw new TypeError("desktop sandbox dispatch attempt is unavailable");
    return located;
  }

  function transition({ attempt = null, deviceSessionDigest = "", nextStatus = "", now = "", taskIdentity = null, taskOwnership = null } = {}) {
    const identity = normalizeTaskIdentity(taskIdentity);
    const ownership = normalizeOwnership(taskOwnership);
    const next = repository.transitionDesktopSandboxDispatchAttemptWithLease({
      attemptId: attempt?.attemptId,
      deviceSessionDigest,
      fencingToken: ownership.fencingToken,
      leaseId: ownership.leaseId,
      nextStatus,
      now,
      taskId: identity.taskId,
      tenantScope: identity.tenantScope,
      workerIdDigest: ownership.workerIdDigest,
    });
    if (!next) throw new TypeError("desktop sandbox dispatch transition is unavailable");
    return next;
  }

  return Object.freeze({
    contractVersion: DESKTOP_SANDBOX_DISPATCH_REPOSITORY_ADAPTER_CONTRACT_VERSION,
    findForDevice,
    get,
    saveOrGet,
    transition,
  });
}

function normalizeTaskIdentity(value = null) {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).length !== 2 ||
    !Object.hasOwn(value, "taskId") || !Object.hasOwn(value, "tenantScope")) {
    throw new TypeError("desktop sandbox dispatch task identity is invalid");
  }
  return Object.freeze({ taskId: value.taskId, tenantScope: value.tenantScope });
}

function normalizeOwnership(value = null) {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).length !== 3 ||
    !Object.hasOwn(value, "fencingToken") || !Object.hasOwn(value, "leaseId") || !Object.hasOwn(value, "workerIdDigest")) {
    throw new TypeError("desktop sandbox dispatch task ownership is invalid");
  }
  return Object.freeze({
    fencingToken: value.fencingToken,
    leaseId: value.leaseId,
    workerIdDigest: value.workerIdDigest,
  });
}

export {
  DESKTOP_SANDBOX_DISPATCH_REPOSITORY_ADAPTER_CONTRACT_VERSION,
  createDesktopSandboxDispatchRepositoryAdapter,
};
