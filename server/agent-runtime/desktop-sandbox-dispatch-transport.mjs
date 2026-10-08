const DESKTOP_SANDBOX_DISPATCH_CLAIM_CONTRACT_VERSION = "desktop-sandbox-dispatch-claim.v1";
const DESKTOP_SANDBOX_DISPATCH_CLAIM_REQUEST_CONTRACT_VERSION = "desktop-sandbox-dispatch-claim-request.v2";
const DESKTOP_SANDBOX_DISPATCH_SETTLE_REQUEST_CONTRACT_VERSION = "desktop-sandbox-dispatch-settle-request.v1";
const DESKTOP_SANDBOX_DISPATCH_CANCEL_REQUEST_CONTRACT_VERSION = "desktop-sandbox-dispatch-cancel-request.v1";
const DESKTOP_SANDBOX_DISPATCH_TRANSPORT_RESULT_CONTRACT_VERSION = "desktop-sandbox-dispatch-transport-result.v1";
const DESKTOP_SANDBOX_PRIVATE_CLAIM_CONTRACT_VERSION = "desktop-sandbox-private-claim.v1";
const ATTEMPT_ID = /^sandbox_dispatch_[a-z0-9][a-z0-9._:-]{0,159}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const TOKEN = /^[A-Za-z0-9][A-Za-z0-9._:@-]{0,159}$/;
const SETTLE_STATUSES = new Set(["completed", "failed", "rejected", "timed_out"]);

// Pure server-side transport contract. Authentication, request parsing and
// route registration stay outside this factory; its injected resolvers must
// supply the already authenticated canonical task/device context.
function createDesktopSandboxDispatchTransportHandlers({
  dispatchService = null,
  isManagedHttpsRequest = null,
  resolveActionContext = null,
  resolveClaimContext = null,
  resolveClaimWaitContext = null,
} = {}) {
  if (!dispatchService || typeof dispatchService.claimWhenPrepared !== "function" ||
    typeof dispatchService.settle !== "function" || typeof dispatchService.cancel !== "function" ||
    typeof isManagedHttpsRequest !== "function" || typeof resolveActionContext !== "function" || typeof resolveClaimContext !== "function" ||
    typeof resolveClaimWaitContext !== "function") {
    throw new TypeError("desktop sandbox dispatch transport dependencies are required");
  }

  async function claim({ body = null, requestContext = null } = {}) {
    if (!managedHttps(requestContext) || !isExact(body, new Set(["contractVersion", "taskId"])) || body.contractVersion !== DESKTOP_SANDBOX_DISPATCH_CLAIM_REQUEST_CONTRACT_VERSION ||
      !TOKEN.test(String(body.taskId || "").trim())) {
      return emptyClaim();
    }
    let context;
    try {
      context = normalizeClaimWaitContext(resolveClaimWaitContext({ requestContext, taskId: body.taskId }));
    } catch {
      return emptyClaim();
    }
    if (!context) return emptyClaim();
    let waited;
    try {
      waited = await dispatchService.claimWhenPrepared(context.serviceContext);
    } catch {
      return emptyClaim();
    }
    return serializePrivateClaim(waited?.privateClaim, waited?.metadata) || emptyClaim();
  }

  function settle({ body = null, requestContext = null } = {}) {
    if (!managedHttps(requestContext) || !isExact(body, new Set(["attemptId", "contractVersion", "status"])) ||
      body.contractVersion !== DESKTOP_SANDBOX_DISPATCH_SETTLE_REQUEST_CONTRACT_VERSION ||
      !ATTEMPT_ID.test(String(body.attemptId || "").trim().toLowerCase()) || !SETTLE_STATUSES.has(body.status)) {
      return safeResult("blocked");
    }
    return invokeAction({
      attemptId: String(body.attemptId).trim().toLowerCase(),
      method: "settle",
      requestContext,
      status: body.status,
      successStatus: "settled",
    });
  }

  function cancel(input = {}) {
    return action(input, DESKTOP_SANDBOX_DISPATCH_CANCEL_REQUEST_CONTRACT_VERSION, "cancel", "canceled");
  }

  function action({ body = null, requestContext = null } = {}, contractVersion, method, successStatus, status = "") {
    if (!managedHttps(requestContext) || !isExact(body, new Set(["attemptId", "contractVersion"])) || body.contractVersion !== contractVersion ||
      !ATTEMPT_ID.test(String(body.attemptId || "").trim().toLowerCase())) {
      return safeResult("blocked");
    }
    return invokeAction({
      attemptId: String(body.attemptId).trim().toLowerCase(), method, requestContext, status, successStatus,
    });
  }

  function invokeAction({ attemptId, method, requestContext, status = "", successStatus }) {
    let context;
    try {
      context = normalizeActionContext(resolveActionContext({ attemptId, requestContext }));
    } catch {
      return safeResult("blocked");
    }
    if (!context || context.attemptId !== attemptId) return safeResult("blocked");
    let result;
    try {
      result = method === "settle"
        ? dispatchService.settle({ ...context.serviceContext, status })
        : dispatchService[method](context.serviceContext);
    } catch {
      return safeResult("blocked");
    }
    return result?.status === (method === "settle" ? "settled" : successStatus) ? safeResult(successStatus) : safeResult("blocked");
  }

  function managedHttps(requestContext) {
    try {
      return isManagedHttpsRequest({ requestContext }) === true;
    } catch {
      return false;
    }
  }

  return Object.freeze({ cancel, claim, settle });
}

function serializePrivateClaim(value, metadata) {
  const safeMetadata = normalizeSerializedClaimMetadata(metadata);
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype ||
    !safeMetadata ||
    !isExact(value, new Set(["attemptId", "commandText", "contractVersion", "expiresAt", "profileId", "profileRevision", "taskId", "timeoutMs"])) ||
    value.contractVersion !== DESKTOP_SANDBOX_PRIVATE_CLAIM_CONTRACT_VERSION || value.attemptId !== safeMetadata.attemptId ||
    value.taskId !== safeMetadata.taskId || !ATTEMPT_ID.test(value.attemptId) || !TOKEN.test(value.taskId) ||
    typeof value.commandText !== "string" || !value.commandText.trim() || value.commandText.length > 12_000 || value.commandText.includes("\0") ||
    !Number.isSafeInteger(value.timeoutMs) || value.timeoutMs < 1_000 || value.timeoutMs > 60_000) return null;
  return Object.freeze({
    attemptId: value.attemptId,
    commandText: value.commandText,
    contractVersion: DESKTOP_SANDBOX_DISPATCH_CLAIM_CONTRACT_VERSION,
    operationDigest: safeMetadata.operationDigest,
    status: "claimed",
    taskId: value.taskId,
    taskInputDigest: safeMetadata.taskInputDigest,
    timeoutMs: value.timeoutMs,
    workspaceInputDigest: safeMetadata.workspaceInputDigest,
  });
}

function normalizeClaimContext(value) {
  if (value === null) return null;
  if (!isExact(value, new Set([
    "attemptId", "deviceSessionId", "operationDigest", "runtimeTask", "session", "taskInputDigest", "taskOwnership", "workspaceInputDigest",
  ]))) return null;
  const metadata = normalizeClaimMetadata(value);
  if (!metadata) return null;
  return Object.freeze({
    metadata,
    serviceContext: Object.freeze({
      attemptId: metadata.attemptId,
      deviceSessionId: value.deviceSessionId,
      runtimeTask: value.runtimeTask,
      session: value.session,
      taskOwnership: value.taskOwnership,
    }),
  });
}

function normalizeClaimWaitContext(value) {
  if (!isExact(value, new Set(["deviceSessionId", "session", "taskId"]))) return null;
  const taskId = String(value.taskId || "").trim();
  if (!TOKEN.test(taskId)) return null;
  return Object.freeze({
    serviceContext: Object.freeze({ deviceSessionId: value.deviceSessionId, session: value.session, taskId }),
  });
}

function normalizeActionContext(value) {
  if (!isExact(value, new Set(["attemptId", "deviceSessionId", "runtimeTask", "session", "taskOwnership"]))) return null;
  const attemptId = String(value.attemptId || "").trim().toLowerCase();
  if (!ATTEMPT_ID.test(attemptId)) return null;
  return Object.freeze({
    attemptId,
    serviceContext: Object.freeze({
      attemptId,
      deviceSessionId: value.deviceSessionId,
      runtimeTask: value.runtimeTask,
      session: value.session,
      taskOwnership: value.taskOwnership,
    }),
  });
}

function normalizeClaimMetadata(value) {
  const attemptId = String(value.attemptId || "").trim().toLowerCase();
  const taskId = String(value.runtimeTask?.taskId || "").trim();
  const operationDigest = String(value.operationDigest || "").trim().toLowerCase();
  const taskInputDigest = String(value.taskInputDigest || "").trim().toLowerCase();
  const workspaceInputDigest = String(value.workspaceInputDigest || "").trim().toLowerCase();
  if (!ATTEMPT_ID.test(attemptId) || !TOKEN.test(taskId) || !SHA256.test(operationDigest) ||
    !SHA256.test(taskInputDigest) || !SHA256.test(workspaceInputDigest)) return null;
  return Object.freeze({ attemptId, operationDigest, taskId, taskInputDigest, workspaceInputDigest });
}

function normalizeSerializedClaimMetadata(value) {
  if (!isExact(value, new Set(["attemptId", "operationDigest", "taskId", "taskInputDigest", "workspaceInputDigest"]))) return null;
  const attemptId = String(value.attemptId || "").trim().toLowerCase();
  const taskId = String(value.taskId || "").trim();
  const operationDigest = String(value.operationDigest || "").trim().toLowerCase();
  const taskInputDigest = String(value.taskInputDigest || "").trim().toLowerCase();
  const workspaceInputDigest = String(value.workspaceInputDigest || "").trim().toLowerCase();
  if (!ATTEMPT_ID.test(attemptId) || !TOKEN.test(taskId) || !SHA256.test(operationDigest) ||
    !SHA256.test(taskInputDigest) || !SHA256.test(workspaceInputDigest)) return null;
  return Object.freeze({ attemptId, operationDigest, taskId, taskInputDigest, workspaceInputDigest });
}

function emptyClaim() {
  return Object.freeze({
    contractVersion: DESKTOP_SANDBOX_DISPATCH_CLAIM_CONTRACT_VERSION,
    status: "empty",
  });
}

function safeResult(status) {
  return Object.freeze({
    contractVersion: DESKTOP_SANDBOX_DISPATCH_TRANSPORT_RESULT_CONTRACT_VERSION,
    status: status === "settled" || status === "canceled" ? status : "blocked",
  });
}

function isExact(value, fields) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype &&
    Object.keys(value).length === fields.size && Object.keys(value).every((field) => fields.has(field)) &&
    [...fields].every((field) => Object.hasOwn(value, field)));
}

export {
  DESKTOP_SANDBOX_DISPATCH_CANCEL_REQUEST_CONTRACT_VERSION,
  DESKTOP_SANDBOX_DISPATCH_CLAIM_CONTRACT_VERSION,
  DESKTOP_SANDBOX_DISPATCH_CLAIM_REQUEST_CONTRACT_VERSION,
  DESKTOP_SANDBOX_DISPATCH_SETTLE_REQUEST_CONTRACT_VERSION,
  DESKTOP_SANDBOX_DISPATCH_TRANSPORT_RESULT_CONTRACT_VERSION,
  createDesktopSandboxDispatchTransportHandlers,
};
