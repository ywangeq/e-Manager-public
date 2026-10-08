import crypto from "node:crypto";
import {
  createDesktopSandboxDispatchAttempt,
  desktopSandboxDispatchAttemptSafeProjection,
  isDesktopSandboxDispatchAttemptTerminal,
  normalizeDesktopSandboxDispatchAttempt,
} from "./desktop-sandbox-dispatch-attempt-v1.mjs";
import { managedSandboxProfileRegistry } from "./managed-sandbox-profile-registry-v1.mjs";

const DESKTOP_SANDBOX_DISPATCH_SERVICE_CONTRACT_VERSION = "desktop-sandbox-dispatch-service.v1";
const DESKTOP_SANDBOX_PRIVATE_CLAIM_CONTRACT_VERSION = "desktop-sandbox-private-claim.v1";
const DEVICE_SESSION_ID = /^dws_[a-f0-9]{32}$/;
const TOKEN = /^[A-Za-z0-9][A-Za-z0-9._:@-]{0,159}$/;
const DEFAULT_TTL_MS = 2 * 60 * 1000;
const DEFAULT_TIMEOUT_MS = 60_000;
const DEFAULT_CLAIM_WAIT_MS = 90_000;
const DEFAULT_TERMINAL_WAIT_MS = 90_000;
const TERMINAL_DISPATCH_STATUSES = new Set(["canceled", "completed", "failed", "rejected", "timed_out"]);

// This is a pure Center-side composition boundary. It owns neither an HTTP
// route nor a task repository: callers inject the canonical attempt adapter.
function createDesktopSandboxDispatchService({
  dispatchRepository = null,
  executionBoundary = null,
  deviceSessionRegistry = null,
  takeExecutionInput = null,
  profiles = managedSandboxProfileRegistry(),
  now = () => Date.now(),
  ttlMs = DEFAULT_TTL_MS,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  claimWaitMs = DEFAULT_CLAIM_WAIT_MS,
  terminalWaitMs = DEFAULT_TERMINAL_WAIT_MS,
} = {}) {
  assertDependencies({ dispatchRepository, executionBoundary, deviceSessionRegistry, takeExecutionInput, profiles, now, ttlMs, timeoutMs, claimWaitMs, terminalWaitMs });
  const profilesById = new Map(profiles.map((profile) => [profile.profileId, profile]));
  const privateBindings = new Map();
  const claimWaiters = new Map();
  const preparedClaims = new Map();
  const terminalWaiters = new Map();

  function prepare({ deviceSessionId = "", operation = null, runtimeTask = null, session = null, taskOwnership = null, workspaceInputDigest = "" } = {}) {
    let context;
    try {
      context = prepareContext({ deviceSessionId, operation, runtimeTask, session, taskOwnership, workspaceInputDigest });
    } catch {
      return safeResult("blocked", null, "sandbox_prepare_context_invalid");
    }
    if (!context) return safeResult("blocked", null, "sandbox_prepare_context_unavailable");
    const decision = authorizedDecision(executionBoundary, context);
    if (decision?.status !== "authorized") return safeResult("blocked", null, safeReason(decision?.reason, "sandbox_prepare_not_authorized"));
    let attempt;
    try {
      attempt = createDesktopSandboxDispatchAttempt({
        attemptId: attemptIdFor(context),
        deviceSessionDigest: context.deviceSessionDigest,
        expiresAt: new Date(context.nowMs + ttlMs).toISOString(),
        taskInputDigest: context.taskInputDigest,
        workspaceInputDigest: context.workspaceInputDigest,
        now: new Date(context.nowMs).toISOString(),
        operationDigest: operationDigest(context.operation),
        profileDigest: context.profile.profileDigest,
        taskIdentity: context.taskIdentity,
        taskOwnership: context.attemptOwnership,
      });
      const stored = normalizeDesktopSandboxDispatchAttempt(dispatchRepository.saveOrGet({
        attempt,
        taskOwnership: context.attemptOwnership,
      }));
      if (!sameAttemptIdentity(stored, attempt)) return safeResult("blocked");
      if (stored.status === "eligible") {
        attempt = normalizeDesktopSandboxDispatchAttempt(dispatchRepository.transition({
          attempt: stored,
          deviceSessionDigest: context.deviceSessionDigest,
          nextStatus: "prepared",
          now: new Date(context.nowMs).toISOString(),
          taskIdentity: context.taskIdentity,
          taskOwnership: context.attemptOwnership,
        }));
      } else {
        attempt = stored;
      }
    } catch (error) {
      return safeResult("blocked", null, safeReason(error?.code, "sandbox_prepare_attempt_unavailable"));
    }
    if (attempt.status !== "prepared") return safeResult("blocked", null, "sandbox_prepare_attempt_unavailable");
    privateBindings.set(attempt.attemptId, Object.freeze({
      commandEnvelopeRef: context.operation.commandEnvelopeRef,
      operation: Object.freeze({ ...context.operation }),
    }));
    const claimKey = claimWaitKey({ deviceSessionId: context.deviceSessionId, taskId: context.taskIdentity.taskId });
    preparedClaims.set(claimKey, Object.freeze({ attempt, context }));
    releaseClaimWaiter(claimKey);
    return safeResult("prepared", attempt);
  }

  // This is a single bounded waiter, not a polling endpoint.  The Device can
  // open it after the private task binding arrives; prepare resolves it only
  // for the exact bound task and Device session.
  function claimWhenPrepared({ deviceSessionId = "", session = null, taskId = "" } = {}) {
    const context = claimWaitContext({ deviceSessionId, session, taskId });
    if (!context) return Promise.resolve(null);
    const key = claimWaitKey(context);
    if (preparedClaims.has(key)) return Promise.resolve(takePreparedClaim(key));
    if (claimWaiters.has(key)) return Promise.resolve(null);
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        const waiter = claimWaiters.get(key);
        if (waiter?.resolve !== resolve) return;
        claimWaiters.delete(key);
        resolve(null);
      }, claimWaitMs);
      claimWaiters.set(key, Object.freeze({ resolve, timer }));
    });
  }

  function claim({ attemptId = "", deviceSessionId = "", runtimeTask = null, session = null, taskOwnership = null } = {}) {
    let context;
    try {
      context = readContext({ attemptId, deviceSessionId, runtimeTask, session, taskOwnership });
    } catch {
      return safeResult("blocked");
    }
    if (!context || context.attempt.status !== "prepared") return safeResult("blocked");
    const binding = privateBindings.get(context.attempt.attemptId);
    if (!binding || binding.commandEnvelopeRef !== binding.operation.commandEnvelopeRef ||
      operationDigest(binding.operation) !== context.attempt.operationDigest) {
      reconcileUnknown(context);
      return safeResult("blocked");
    }
    let running;
    try {
      running = transition(context, "running");
    } catch {
      return safeResult("blocked");
    }
    preparedClaims.delete(claimWaitKey({ deviceSessionId: context.deviceSessionId, taskId: context.taskIdentity.taskId }));
    let commandText = "";
    try {
      commandText = takeExecutionInput({
        commandEnvelopeRef: binding.commandEnvelopeRef,
        profileId: binding.operation.profileId,
        profileRevision: binding.operation.profileRevision,
        runtimeTask,
      });
    } catch {
      privateBindings.delete(running.attemptId);
      rejectDispatch(context, running);
      return safeResult("blocked");
    }
    privateBindings.delete(running.attemptId);
    if (typeof commandText !== "string" || !commandText || commandText.length > 12_000 || commandText.includes("\0")) {
      rejectDispatch(context, running);
      return safeResult("blocked");
    }
    return Object.freeze({
      attemptId: running.attemptId,
      commandText,
      contractVersion: DESKTOP_SANDBOX_PRIVATE_CLAIM_CONTRACT_VERSION,
      expiresAt: running.expiresAt,
      profileId: binding.operation.profileId,
      profileRevision: binding.operation.profileRevision,
      taskId: running.taskId,
      timeoutMs,
    });
  }

  function settle({ status = "", ...input } = {}) {
    if (!TERMINAL_DISPATCH_STATUSES.has(status)) return safeResult("blocked");
    let context;
    try {
      context = readContext(input);
    } catch {
      return safeResult("blocked");
    }
    if (!context || context.attempt.status !== "running") return safeResult("blocked");
    try {
      const settled = transition(context, status);
      releaseTerminalWaiter(settled);
      return safeResult("settled", settled);
    } catch {
      return safeResult("blocked");
    }
  }

  function cancel(input = {}) {
    let context;
    try {
      context = readContext(input);
    } catch {
      return safeResult("blocked");
    }
    return context ? cancelContext(context) : safeResult("blocked");
  }

  function cancelContext(context) {
    if (context.attempt.status === "canceled") return safeResult("canceled", context.attempt);
    if (isDesktopSandboxDispatchAttemptTerminal(context.attempt.status)) return safeResult("blocked");
    try {
      privateBindings.delete(context.attempt.attemptId);
      deletePreparedClaim(context.attempt.attemptId);
      const canceled = transition(context, "canceled");
      releaseTerminalWaiter(canceled);
      return safeResult("canceled", canceled);
    } catch {
      return safeResult("blocked");
    }
  }

  function reconcile({ attemptId = "", runtimeTask = null, taskOwnership = null } = {}) {
    let context;
    try {
      context = readReconcileContext({ attemptId, runtimeTask, taskOwnership });
    } catch {
      return safeResult("blocked");
    }
    if (!context) return safeResult("blocked");
    if (isDesktopSandboxDispatchAttemptTerminal(context.attempt.status)) return safeResult("reconciled", context.attempt);
    try {
      privateBindings.delete(context.attempt.attemptId);
      deletePreparedClaim(context.attempt.attemptId);
      const reconciled = transition(context, "unknown");
      releaseTerminalWaiter(reconciled);
      return safeResult("reconciled", reconciled);
    } catch {
      return safeResult("blocked");
    }
  }

  function awaitTerminal({ attemptId = "", deviceSessionId = "", runtimeTask = null, session = null, signal = null, taskOwnership = null } = {}) {
    let context;
    try {
      context = readReconcileContext({ attemptId, runtimeTask, taskOwnership });
    } catch {
      return Promise.resolve(safeResult("blocked"));
    }
    if (!context) return Promise.resolve(safeResult("blocked"));
    if (isDesktopSandboxDispatchAttemptTerminal(context.attempt.status)) return Promise.resolve(safeResult("terminal", context.attempt));
    if (signal?.aborted) {
      const canceled = cancelOwnedAttempt({ attemptId: context.attempt.attemptId, runtimeTask, taskOwnership });
      return Promise.resolve(canceled?.attempt ? terminalProjection(canceled.attempt) : safeResult("blocked"));
    }
    if (terminalWaiters.has(context.attempt.attemptId)) return Promise.resolve(safeResult("blocked"));
    return new Promise((resolve) => {
      let finished = false;
      const finish = (result) => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        signal?.removeEventListener?.("abort", onAbort);
        const current = terminalWaiters.get(context.attempt.attemptId);
        if (current?.resolve === finish) terminalWaiters.delete(context.attempt.attemptId);
        resolve(result);
      };
      const onAbort = () => {
        const canceled = cancelOwnedAttempt({ attemptId: context.attempt.attemptId, runtimeTask, taskOwnership });
        if (!canceled?.attempt) finish(safeResult("blocked"));
      };
      const timer = setTimeout(() => {
        const waiter = terminalWaiters.get(context.attempt.attemptId);
        if (waiter?.resolve !== finish) return;
        terminalWaiters.delete(context.attempt.attemptId);
        let reconciled = null;
        try { reconciled = reconcile({ attemptId: context.attempt.attemptId, runtimeTask, taskOwnership }); } catch {}
        finish(reconciled?.attempt ? terminalProjection(reconciled.attempt) : safeResult("blocked"));
      }, terminalWaitMs);
      terminalWaiters.set(context.attempt.attemptId, Object.freeze({ resolve: finish, timer }));
      signal?.addEventListener?.("abort", onAbort, { once: true });
      if (signal?.aborted) onAbort();
    });
  }

  function awaitPreparedTerminal({ deviceSessionId = "", operation = null, runtimeTask = null, session = null, signal = null, taskOwnership = null, workspaceInputDigest = "" } = {}) {
    let context;
    try {
      context = prepareContext({ deviceSessionId, operation, runtimeTask, session, taskOwnership, workspaceInputDigest });
    } catch {
      return Promise.resolve(safeResult("blocked"));
    }
    if (!context) return Promise.resolve(safeResult("blocked"));
    return awaitTerminal({ attemptId: attemptIdFor(context), deviceSessionId, runtimeTask, session, signal, taskOwnership });
  }

  function prepareContext({ deviceSessionId, operation, runtimeTask, session, taskOwnership, workspaceInputDigest }) {
    const taskIdentity = taskIdentityFor(runtimeTask);
    const attemptOwnership = attemptOwnershipFor(taskOwnership, taskIdentity);
    const normalizedOperation = operationFor(operation, taskIdentity.taskId);
    const profile = profilesById.get(normalizedOperation?.profileId);
    const normalizedSessionId = deviceSessionIdFor(deviceSessionId);
    const nowMs = clockNow(now);
    const taskInputDigest = digest(runtimeTask?.inputDigest);
    const safeWorkspaceInputDigest = digest(workspaceInputDigest);
    if (!taskIdentity || !attemptOwnership || !normalizedOperation || !profile || !taskInputDigest || !safeWorkspaceInputDigest ||
      profile.profileRevision !== normalizedOperation.profileRevision || profile.scope !== normalizedOperation.scope ||
      !normalizedSessionId || !deviceSessionRegistry.isBound({ deviceSessionId: normalizedSessionId, session })) return null;
    return Object.freeze({
      attemptOwnership,
      deviceSessionDigest: sha256(normalizedSessionId),
      deviceSessionId: normalizedSessionId,
      nowMs,
      operation: normalizedOperation,
      profile,
      runtimeTask,
      session,
      taskInputDigest,
      taskIdentity,
      taskOwnership,
      workspaceInputDigest: safeWorkspaceInputDigest,
    });
  }

  function cancelOwnedAttempt({ attemptId, runtimeTask, taskOwnership }) {
    let current;
    try {
      current = readReconcileContext({ attemptId, runtimeTask, taskOwnership });
    } catch {
      return safeResult("blocked");
    }
    return current ? cancelContext(current) : safeResult("blocked");
  }

  function readContext({ attemptId = "", deviceSessionId = "", runtimeTask = null, session = null, taskOwnership = null } = {}) {
    const taskIdentity = taskIdentityFor(runtimeTask);
    const attemptOwnership = attemptOwnershipFor(taskOwnership, taskIdentity);
    const normalizedSessionId = deviceSessionIdFor(deviceSessionId);
    if (!taskIdentity || !attemptOwnership || !normalizedSessionId || !deviceSessionRegistry.isBound({ deviceSessionId: normalizedSessionId, session })) return null;
    let attempt;
    try {
      attempt = normalizeDesktopSandboxDispatchAttempt(dispatchRepository.get({
        attemptId: normalizedAttemptId(attemptId),
        taskIdentity,
      }));
    } catch {
      return null;
    }
    if (attempt.taskId !== taskIdentity.taskId || attempt.tenantScope !== taskIdentity.tenantScope ||
      attempt.deviceSessionDigest !== sha256(normalizedSessionId)) return null;
    return Object.freeze({ attempt, attemptOwnership, deviceSessionDigest: attempt.deviceSessionDigest, deviceSessionId: normalizedSessionId, runtimeTask, taskIdentity, taskOwnership });
  }

  function readReconcileContext({ attemptId, runtimeTask, taskOwnership }) {
    const taskIdentity = taskIdentityFor(runtimeTask);
    const attemptOwnership = attemptOwnershipFor(taskOwnership, taskIdentity);
    if (!taskIdentity || !attemptOwnership) return null;
    let attempt;
    try {
      attempt = normalizeDesktopSandboxDispatchAttempt(dispatchRepository.get({
        attemptId: normalizedAttemptId(attemptId),
        taskIdentity,
      }));
    } catch {
      return null;
    }
    if (attempt.taskId !== taskIdentity.taskId || attempt.tenantScope !== taskIdentity.tenantScope) return null;
    return Object.freeze({ attempt, attemptOwnership, deviceSessionDigest: attempt.deviceSessionDigest, runtimeTask, taskIdentity, taskOwnership });
  }

  function claimWaitContext({ deviceSessionId, session, taskId }) {
    const normalizedSessionId = deviceSessionIdFor(deviceSessionId);
    const normalizedTaskId = token(taskId, 128);
    if (!normalizedSessionId || !normalizedTaskId || !deviceSessionRegistry.isBound({ deviceSessionId: normalizedSessionId, session }) ||
      !deviceSessionRegistry.resolveBoundTask({ deviceSessionId: normalizedSessionId, session, taskId: normalizedTaskId })) return null;
    return Object.freeze({ deviceSessionId: normalizedSessionId, session, taskId: normalizedTaskId });
  }

  function releaseClaimWaiter(key) {
    const waiter = claimWaiters.get(key);
    if (!waiter) return;
    claimWaiters.delete(key);
    clearTimeout(waiter.timer);
    waiter.resolve(takePreparedClaim(key));
  }

  function takePreparedClaim(key) {
    const prepared = preparedClaims.get(key);
    if (!prepared) return null;
    preparedClaims.delete(key);
    const { attempt, context } = prepared;
    let privateClaim = null;
    try {
      privateClaim = claim({
        attemptId: attempt.attemptId,
        deviceSessionId: context.deviceSessionId,
        runtimeTask: context.runtimeTask,
        session: context.session,
        taskOwnership: context.taskOwnership,
      });
    } catch {}
    const metadata = privateClaim?.attemptId === attempt.attemptId ? Object.freeze({
      attemptId: attempt.attemptId,
      operationDigest: attempt.operationDigest,
      taskId: attempt.taskId,
      taskInputDigest: attempt.taskInputDigest,
      workspaceInputDigest: attempt.workspaceInputDigest,
    }) : null;
    return metadata ? Object.freeze({ metadata, privateClaim }) : null;
  }

  function releaseTerminalWaiter(attempt) {
    const waiter = terminalWaiters.get(attempt.attemptId);
    if (!waiter) return;
    terminalWaiters.delete(attempt.attemptId);
    clearTimeout(waiter.timer);
    waiter.resolve(safeResult("terminal", attempt));
  }

  function deletePreparedClaim(attemptId) {
    for (const [key, prepared] of preparedClaims) {
      if (prepared.attempt.attemptId !== attemptId) continue;
      preparedClaims.delete(key);
      const waiter = claimWaiters.get(key);
      if (waiter) {
        claimWaiters.delete(key);
        clearTimeout(waiter.timer);
        waiter.resolve(null);
      }
    }
  }

  function transition(context, nextStatus) {
    return normalizeDesktopSandboxDispatchAttempt(dispatchRepository.transition({
      attempt: context.attempt,
      deviceSessionDigest: context.deviceSessionDigest,
      nextStatus,
      now: new Date(clockNow(now)).toISOString(),
      taskIdentity: context.taskIdentity,
      taskOwnership: context.attemptOwnership,
    }));
  }

  function rejectDispatch(context, attempt) {
    try {
      const rejected = normalizeDesktopSandboxDispatchAttempt(dispatchRepository.transition({
        attempt,
        deviceSessionDigest: context.deviceSessionDigest,
        nextStatus: "rejected",
        now: new Date(clockNow(now)).toISOString(),
        taskIdentity: context.taskIdentity,
        taskOwnership: context.attemptOwnership,
      }));
      releaseTerminalWaiter(rejected);
    } catch {}
  }

  function reconcileUnknown(context) {
    try {
      privateBindings.delete(context.attempt.attemptId);
      deletePreparedClaim(context.attempt.attemptId);
      const reconciled = transition(context, "unknown");
      releaseTerminalWaiter(reconciled);
    } catch {}
  }

  return Object.freeze({ awaitPreparedTerminal, awaitTerminal, cancel, claim, claimWhenPrepared, prepare, reconcile, settle });
}

function claimWaitKey({ deviceSessionId, taskId }) {
  return `${deviceSessionId}\u0000${taskId}`;
}

function authorizedDecision(executionBoundary, context) {
  try {
    return executionBoundary.authorizeOperation({
      operation: context.operation,
      runtimeTask: context.runtimeTask,
      taskOwnership: context.taskOwnership,
    });
  } catch {
    return Object.freeze({ reason: "sandbox_prepare_authorization_unavailable", status: "blocked" });
  }
}

function safeResult(status, attempt = null, reason = "") {
  const projection = attempt ? desktopSandboxDispatchAttemptSafeProjection(attempt) : null;
  return Object.freeze({
    contractVersion: DESKTOP_SANDBOX_DISPATCH_SERVICE_CONTRACT_VERSION,
    status,
    ...(status === "blocked" && safeReason(reason) ? { reason: safeReason(reason) } : {}),
    ...(projection ? { attempt: projection } : {}),
  });
}

function terminalProjection(attempt) {
  return Object.freeze({
    contractVersion: DESKTOP_SANDBOX_DISPATCH_SERVICE_CONTRACT_VERSION,
    status: "terminal",
    attempt: Object.freeze({ ...attempt }),
  });
}

function safeReason(value, fallback = "") {
  const candidate = String(value || "").trim();
  if (/^sandbox_[a-z0-9_]{1,96}$/.test(candidate) || /^managed_sandbox_[a-z0-9_]{1,96}$/.test(candidate) ||
    /^desktop_sandbox_[a-z0-9_]{1,96}$/.test(candidate)) return candidate;
  return String(fallback || "").trim();
}

function taskIdentityFor(runtimeTask) {
  const taskId = token(runtimeTask?.taskId || runtimeTask?.id, 128);
  const tenantScope = token(runtimeTask?.tenantScope, 160);
  if (!taskId || !tenantScope || runtimeTask?.workspaceRef !== `task:${taskId}`) return null;
  return Object.freeze({ taskId, tenantScope });
}

function attemptOwnershipFor(taskOwnership, taskIdentity) {
  const lease = taskOwnership?.lease;
  if (!taskIdentity || taskOwnership?.task?.taskId !== taskIdentity.taskId ||
    !Number.isSafeInteger(lease?.fencingToken) || lease.fencingToken < 1 ||
    !token(lease?.leaseId, 160) || !digest(lease?.workerIdDigest)) return null;
  return Object.freeze({ fencingToken: lease.fencingToken, leaseId: lease.leaseId, workerIdDigest: lease.workerIdDigest });
}

function operationFor(value, taskId) {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).length !== 9 ||
    !["actionId", "capabilityGrantId", "commandEnvelopeRef", "contractVersion", "operationId", "profileId", "profileRevision", "scope", "taskId"].every((field) => Object.hasOwn(value, field)) ||
    value.taskId !== taskId || !token(value.actionId, 80) || !token(value.capabilityGrantId, 160) ||
    !token(value.commandEnvelopeRef, 160) || !token(value.contractVersion, 80) || !token(value.operationId, 160) ||
    !token(value.profileId, 80) || !token(value.profileRevision, 40) || !token(value.scope, 80)) return null;
  return Object.freeze({ ...value });
}

function sameAttemptIdentity(left, right) {
  return left.attemptId === right.attemptId && left.taskId === right.taskId && left.tenantScope === right.tenantScope &&
    left.deviceSessionDigest === right.deviceSessionDigest && left.inputDigest === right.inputDigest &&
    left.operationDigest === right.operationDigest && left.profileDigest === right.profileDigest &&
    left.attemptLeaseFenceDigest === right.attemptLeaseFenceDigest;
}

function attemptIdFor(context) {
  return `sandbox_dispatch_${sha256(JSON.stringify([
    DESKTOP_SANDBOX_DISPATCH_SERVICE_CONTRACT_VERSION,
    context.taskIdentity.taskId,
    context.taskIdentity.tenantScope,
    context.deviceSessionDigest,
    operationDigest(context.operation),
    context.attemptOwnership.fencingToken,
    context.attemptOwnership.leaseId,
    context.attemptOwnership.workerIdDigest,
  ])).slice(0, 48)}`;
}

function operationDigest(operation) {
  return sha256(JSON.stringify([
    operation.actionId, operation.capabilityGrantId, operation.commandEnvelopeRef, operation.contractVersion,
    operation.operationId, operation.profileId, operation.profileRevision, operation.scope, operation.taskId,
  ]));
}

function deviceSessionIdFor(value) {
  const normalized = String(value || "").trim().toLowerCase();
  return DEVICE_SESSION_ID.test(normalized) ? normalized : "";
}

function normalizedAttemptId(value) {
  const normalized = String(value || "").trim().toLowerCase();
  return /^sandbox_dispatch_[a-z0-9][a-z0-9._:-]{0,159}$/.test(normalized) ? normalized : "";
}

function token(value, maxLength) {
  const normalized = String(value || "").trim();
  return normalized && normalized.length <= maxLength && TOKEN.test(normalized) ? normalized : "";
}

function digest(value) {
  const normalized = String(value || "").trim().toLowerCase();
  return /^[a-f0-9]{64}$/.test(normalized) ? normalized : "";
}

function sha256(value) {
  return crypto.createHash("sha256").update(String(value), "utf8").digest("hex");
}

function clockNow(now) {
  const value = Number(now());
  if (!Number.isSafeInteger(value) || value <= 0) throw new TypeError("desktop sandbox dispatch clock invalid");
  return value;
}

function assertDependencies({ dispatchRepository, executionBoundary, deviceSessionRegistry, takeExecutionInput, profiles, now, ttlMs, timeoutMs, claimWaitMs, terminalWaitMs }) {
  if (!dispatchRepository || typeof dispatchRepository.saveOrGet !== "function" || typeof dispatchRepository.get !== "function" ||
    typeof dispatchRepository.transition !== "function" || typeof executionBoundary?.authorizeOperation !== "function" ||
    typeof deviceSessionRegistry?.isBound !== "function" || typeof deviceSessionRegistry?.resolveBoundTask !== "function" || typeof takeExecutionInput !== "function" ||
    !Array.isArray(profiles) || !profiles.length || typeof now !== "function" ||
    !Number.isSafeInteger(ttlMs) || ttlMs < 30_000 || ttlMs > 5 * 60 * 1000 ||
    !Number.isSafeInteger(timeoutMs) || timeoutMs < 1_000 || timeoutMs > 60_000 ||
    !Number.isSafeInteger(claimWaitMs) || claimWaitMs < 1_000 || claimWaitMs > 5 * 60 * 1000 ||
    !Number.isSafeInteger(terminalWaitMs) || terminalWaitMs < 1_000 || terminalWaitMs > 5 * 60 * 1000) {
    throw new TypeError("desktop sandbox dispatch service dependencies are required");
  }
}

export {
  DESKTOP_SANDBOX_DISPATCH_SERVICE_CONTRACT_VERSION,
  DESKTOP_SANDBOX_PRIVATE_CLAIM_CONTRACT_VERSION,
  createDesktopSandboxDispatchService,
};
