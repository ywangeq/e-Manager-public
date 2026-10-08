import crypto from "node:crypto";

const DESKTOP_SANDBOX_DISPATCH_ATTEMPT_CONTRACT_VERSION = "desktop-sandbox-dispatch-attempt.v1";
const DESKTOP_SANDBOX_DISPATCH_SAFE_PROJECTION_CONTRACT_VERSION = "desktop-sandbox-dispatch-safe-projection.v1";
const DISPATCH_STATES = Object.freeze([
  "eligible",
  "prepared",
  "accepted",
  "running",
  "completed",
  "failed",
  "rejected",
  "timed_out",
  "canceled",
  "unknown",
]);
const TERMINAL_STATES = new Set(["completed", "failed", "rejected", "timed_out", "canceled", "unknown"]);
const NEXT_STATES = new Map([
  ["eligible", new Set(["prepared"])],
  ["prepared", new Set(["running", "accepted", "canceled", "unknown"])],
  ["accepted", new Set(["running", "rejected", "canceled", "unknown"])],
  ["running", new Set(["completed", "failed", "rejected", "timed_out", "canceled", "unknown"])],
]);
const ATTEMPT_FIELDS = new Set([
  "attemptLeaseFenceDigest",
  "attemptLeaseFencingToken",
  "attemptId",
  "contractVersion",
  "createdAt",
  "deviceSessionDigest",
  "expiresAt",
  "operationDigest",
  "profileDigest",
  "stateEvidenceDigest",
  "status",
  "taskId",
  "tenantScope",
  "transitionLeaseFenceDigest",
  "transitionLeaseFencingToken",
  "taskInputDigest",
  "updatedAt",
  "workspaceInputDigest",
]);
const CREATE_FIELDS = new Set([
  "attemptId",
  "deviceSessionDigest",
  "expiresAt",
  "now",
  "operationDigest",
  "profileDigest",
  "taskIdentity",
  "taskOwnership",
  "taskInputDigest",
  "workspaceInputDigest",
]);
const TRANSITION_FIELDS = new Set([
  "attempt",
  "deviceSessionDigest",
  "nextStatus",
  "now",
  "taskIdentity",
  "taskOwnership",
]);
const TASK_IDENTITY_FIELDS = new Set(["taskId", "tenantScope"]);
const TASK_OWNERSHIP_FIELDS = new Set(["fencingToken", "leaseId", "workerIdDigest"]);
const TOKEN = /^[A-Za-z0-9][A-Za-z0-9._:@-]{0,159}$/;
const ATTEMPT_ID = /^sandbox_dispatch_[a-z0-9][a-z0-9._:-]{0,159}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const SHA256_PREFIXED = /^sha256:[a-f0-9]{64}$/;
const MAX_TTL_MS = 5 * 60 * 1000;

// This contract is deliberately command-free. A later HTTPS claim adapter may
// use its digest-bound state, but must keep raw execution input process-local.
function createDesktopSandboxDispatchAttempt(value = {}) {
  exactObject(value, CREATE_FIELDS);
  const taskIdentity = normalizeTaskIdentity(value.taskIdentity);
  const ownership = normalizeTaskOwnership(value.taskOwnership);
  const createdAt = timestamp(value.now, "now");
  const expiresAt = timestamp(value.expiresAt, "expiresAt");
  if (Date.parse(expiresAt) <= Date.parse(createdAt) || Date.parse(expiresAt) - Date.parse(createdAt) > MAX_TTL_MS) {
    throw dispatchError("desktop_sandbox_dispatch_attempt_ttl_invalid");
  }
  const attempt = {
    attemptLeaseFenceDigest: leaseFenceDigest(taskIdentity, ownership),
    attemptLeaseFencingToken: ownership.fencingToken,
    attemptId: attemptId(value.attemptId),
    contractVersion: DESKTOP_SANDBOX_DISPATCH_ATTEMPT_CONTRACT_VERSION,
    createdAt,
    deviceSessionDigest: digest(value.deviceSessionDigest, "deviceSessionDigest"),
    expiresAt,
    operationDigest: digest(value.operationDigest, "operationDigest"),
    profileDigest: prefixedDigest(value.profileDigest, "profileDigest"),
    status: "eligible",
    taskId: taskIdentity.taskId,
    tenantScope: taskIdentity.tenantScope,
    taskInputDigest: digest(value.taskInputDigest, "taskInputDigest"),
    transitionLeaseFenceDigest: leaseFenceDigest(taskIdentity, ownership),
    transitionLeaseFencingToken: ownership.fencingToken,
    updatedAt: createdAt,
    workspaceInputDigest: digest(value.workspaceInputDigest, "workspaceInputDigest"),
  };
  return sealAttempt(attempt);
}

function transitionDesktopSandboxDispatchAttempt(value = {}) {
  exactObject(value, TRANSITION_FIELDS);
  const attempt = normalizeDesktopSandboxDispatchAttempt(value.attempt);
  const taskIdentity = normalizeTaskIdentity(value.taskIdentity);
  const ownership = normalizeTaskOwnership(value.taskOwnership);
  const currentFenceDigest = leaseFenceDigest(taskIdentity, ownership);
  const nextStatus = state(value.nextStatus);
  const updatedAt = timestamp(value.now, "now");
  if (taskIdentity.taskId !== attempt.taskId || taskIdentity.tenantScope !== attempt.tenantScope ||
    digest(value.deviceSessionDigest, "deviceSessionDigest") !== attempt.deviceSessionDigest) {
    throw dispatchError("desktop_sandbox_dispatch_attempt_scope_mismatch");
  }
  if (updatedAt < attempt.updatedAt) throw dispatchError("desktop_sandbox_dispatch_attempt_clock_invalid");
  if (!NEXT_STATES.get(attempt.status)?.has(nextStatus)) {
    throw dispatchError("desktop_sandbox_dispatch_attempt_transition_invalid");
  }
  if (updatedAt >= attempt.expiresAt && nextStatus !== "unknown") {
    throw dispatchError("desktop_sandbox_dispatch_attempt_expired");
  }
  if (nextStatus === "unknown") {
    if (ownership.fencingToken < attempt.attemptLeaseFencingToken ||
      (ownership.fencingToken === attempt.attemptLeaseFencingToken && currentFenceDigest !== attempt.attemptLeaseFenceDigest)) {
      throw dispatchError("desktop_sandbox_dispatch_attempt_lease_fence_conflict");
    }
  } else if (ownership.fencingToken !== attempt.attemptLeaseFencingToken || currentFenceDigest !== attempt.attemptLeaseFenceDigest) {
    throw dispatchError("desktop_sandbox_dispatch_attempt_lease_fence_conflict");
  }
  return sealAttempt({
    ...attempt,
    status: nextStatus,
    transitionLeaseFenceDigest: currentFenceDigest,
    transitionLeaseFencingToken: ownership.fencingToken,
    updatedAt,
  });
}

function normalizeDesktopSandboxDispatchAttempt(value = {}) {
  exactObject(value, ATTEMPT_FIELDS);
  if (value.contractVersion !== DESKTOP_SANDBOX_DISPATCH_ATTEMPT_CONTRACT_VERSION) {
    throw dispatchError("desktop_sandbox_dispatch_attempt_contract_invalid");
  }
  const normalized = {
    attemptLeaseFenceDigest: digest(value.attemptLeaseFenceDigest, "attemptLeaseFenceDigest"),
    attemptLeaseFencingToken: fencingToken(value.attemptLeaseFencingToken),
    attemptId: attemptId(value.attemptId),
    contractVersion: DESKTOP_SANDBOX_DISPATCH_ATTEMPT_CONTRACT_VERSION,
    createdAt: timestamp(value.createdAt, "createdAt"),
    deviceSessionDigest: digest(value.deviceSessionDigest, "deviceSessionDigest"),
    expiresAt: timestamp(value.expiresAt, "expiresAt"),
    operationDigest: digest(value.operationDigest, "operationDigest"),
    profileDigest: prefixedDigest(value.profileDigest, "profileDigest"),
    status: state(value.status),
    taskId: token(value.taskId, "taskId", 128),
    tenantScope: token(value.tenantScope, "tenantScope", 160),
    taskInputDigest: digest(value.taskInputDigest, "taskInputDigest"),
    transitionLeaseFenceDigest: digest(value.transitionLeaseFenceDigest, "transitionLeaseFenceDigest"),
    transitionLeaseFencingToken: fencingToken(value.transitionLeaseFencingToken),
    updatedAt: timestamp(value.updatedAt, "updatedAt"),
    workspaceInputDigest: digest(value.workspaceInputDigest, "workspaceInputDigest"),
  };
  if (normalized.expiresAt <= normalized.createdAt || normalized.updatedAt < normalized.createdAt ||
    normalized.attemptLeaseFencingToken > normalized.transitionLeaseFencingToken ||
    (!TERMINAL_STATES.has(normalized.status) && normalized.updatedAt >= normalized.expiresAt)) {
    throw dispatchError("desktop_sandbox_dispatch_attempt_state_invalid");
  }
  const expectedEvidence = stateEvidenceDigest(normalized);
  if (digest(value.stateEvidenceDigest, "stateEvidenceDigest") !== expectedEvidence) {
    throw dispatchError("desktop_sandbox_dispatch_attempt_evidence_invalid");
  }
  return Object.freeze({ ...normalized, stateEvidenceDigest: expectedEvidence });
}

function desktopSandboxDispatchAttemptSafeProjection(value = {}) {
  try {
    const attempt = normalizeDesktopSandboxDispatchAttempt(value);
    return Object.freeze({
      contractVersion: DESKTOP_SANDBOX_DISPATCH_SAFE_PROJECTION_CONTRACT_VERSION,
      status: attempt.status,
    });
  } catch {
    return null;
  }
}

function isDesktopSandboxDispatchAttemptTerminal(value = "") {
  return TERMINAL_STATES.has(String(value || ""));
}

function normalizeTaskIdentity(value = {}) {
  exactObject(value, TASK_IDENTITY_FIELDS);
  return Object.freeze({
    taskId: token(value.taskId, "taskId", 128),
    tenantScope: token(value.tenantScope, "tenantScope", 160),
  });
}

function normalizeTaskOwnership(value = {}) {
  exactObject(value, TASK_OWNERSHIP_FIELDS);
  return Object.freeze({
    fencingToken: fencingToken(value.fencingToken),
    leaseId: token(value.leaseId, "leaseId", 160),
    workerIdDigest: digest(value.workerIdDigest, "workerIdDigest"),
  });
}

function sealAttempt(value) {
  return Object.freeze({ ...value, stateEvidenceDigest: stateEvidenceDigest(value) });
}

function stateEvidenceDigest(value) {
  const body = {
    attemptLeaseFenceDigest: value.attemptLeaseFenceDigest,
    attemptLeaseFencingToken: value.attemptLeaseFencingToken,
    attemptId: value.attemptId,
    contractVersion: DESKTOP_SANDBOX_DISPATCH_ATTEMPT_CONTRACT_VERSION,
    createdAt: value.createdAt,
    deviceSessionDigest: value.deviceSessionDigest,
    expiresAt: value.expiresAt,
    operationDigest: value.operationDigest,
    profileDigest: value.profileDigest,
    status: value.status,
    taskId: value.taskId,
    tenantScope: value.tenantScope,
    taskInputDigest: value.taskInputDigest,
    transitionLeaseFenceDigest: value.transitionLeaseFenceDigest,
    transitionLeaseFencingToken: value.transitionLeaseFencingToken,
    updatedAt: value.updatedAt,
    workspaceInputDigest: value.workspaceInputDigest,
  };
  return crypto.createHash("sha256").update(JSON.stringify(body)).digest("hex");
}

function leaseFenceDigest(taskIdentity, ownership) {
  return crypto.createHash("sha256").update(JSON.stringify({
    contractVersion: "desktop-sandbox-dispatch-lease-fence.v1",
    fencingToken: ownership.fencingToken,
    leaseId: ownership.leaseId,
    taskId: taskIdentity.taskId,
    tenantScope: taskIdentity.tenantScope,
    workerIdDigest: ownership.workerIdDigest,
  })).digest("hex");
}

function exactObject(value, fields) {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype ||
    Object.keys(value).length !== fields.size || Object.keys(value).some((field) => !fields.has(field)) ||
    [...fields].some((field) => !Object.hasOwn(value, field))) {
    throw dispatchError("desktop_sandbox_dispatch_attempt_contract_shape_invalid");
  }
}

function attemptId(value) {
  const normalized = String(value || "").trim().toLowerCase();
  if (!ATTEMPT_ID.test(normalized)) throw dispatchError("desktop_sandbox_dispatch_attempt_id_invalid");
  return normalized;
}

function token(value, field, maxLength) {
  const normalized = String(value || "").trim();
  if (!normalized || normalized.length > maxLength || !TOKEN.test(normalized)) {
    throw dispatchError("desktop_sandbox_dispatch_attempt_token_invalid", field);
  }
  return normalized;
}

function digest(value, field) {
  const normalized = String(value || "").trim().toLowerCase();
  if (!SHA256.test(normalized)) throw dispatchError("desktop_sandbox_dispatch_attempt_digest_invalid", field);
  return normalized;
}

function prefixedDigest(value, field) {
  const normalized = String(value || "").trim().toLowerCase();
  if (!SHA256_PREFIXED.test(normalized)) throw dispatchError("desktop_sandbox_dispatch_attempt_digest_invalid", field);
  return normalized;
}

function fencingToken(value) {
  if (!Number.isSafeInteger(value) || value < 1) throw dispatchError("desktop_sandbox_dispatch_attempt_fence_invalid");
  return value;
}

function state(value) {
  const normalized = String(value || "").trim();
  if (!DISPATCH_STATES.includes(normalized)) throw dispatchError("desktop_sandbox_dispatch_attempt_state_invalid");
  return normalized;
}

function timestamp(value, field) {
  const parsed = new Date(value);
  if (!value || !Number.isFinite(parsed.getTime()) || parsed.toISOString() !== value) {
    throw dispatchError("desktop_sandbox_dispatch_attempt_timestamp_invalid", field);
  }
  return value;
}

function dispatchError(code, _field = "") {
  const error = new Error(code);
  error.code = code;
  return error;
}

export {
  DESKTOP_SANDBOX_DISPATCH_ATTEMPT_CONTRACT_VERSION,
  DESKTOP_SANDBOX_DISPATCH_SAFE_PROJECTION_CONTRACT_VERSION,
  DISPATCH_STATES,
  createDesktopSandboxDispatchAttempt,
  desktopSandboxDispatchAttemptSafeProjection,
  isDesktopSandboxDispatchAttemptTerminal,
  normalizeDesktopSandboxDispatchAttempt,
  transitionDesktopSandboxDispatchAttempt,
};
