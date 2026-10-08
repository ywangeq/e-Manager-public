import crypto from "node:crypto";
import { managedSandboxProfileRegistry } from "./managed-sandbox-profile-registry-v1.mjs";

const DESKTOP_SANDBOX_DEVICE_SESSION_CONTRACT_VERSION = "desktop-sandbox-device-session.v1";
const DEFAULT_TTL_MS = 8 * 60 * 60 * 1000;
const DEVICE_SESSION_ID = /^dws_[a-f0-9]{32}$/;

function createDesktopSandboxDeviceSessionRegistry({ now = () => Date.now(), providerResolver = null, ttlMs = DEFAULT_TTL_MS } = {}) {
  if (!Number.isSafeInteger(ttlMs) || ttlMs < 60_000 || ttlMs > 24 * 60 * 60 * 1000) {
    throw new TypeError("desktop sandbox device session ttl invalid");
  }
  const sessionsById = new Map();

  function register({ deviceSessionId = "", session = null } = {}) {
    const normalizedId = normalizeDeviceSessionId(deviceSessionId);
    const deviceSessionDigest = sessionIdDigest(normalizedId);
    const actorDigest = sessionActorDigest(session);
    const currentTime = normalizedNow(now());
    const provider = providerResolver?.resolveReadyProvider?.({ profileDigest: managedProfileDigest() }) || null;
    if (!deviceSessionDigest || !actorDigest || (providerResolver && provider?.platform !== "device_managed")) return null;
    purgeExpired(currentTime);
    sessionsById.set(deviceSessionDigest, Object.freeze({ actorDigest, expiresAtMs: currentTime + ttlMs, providerId: provider?.providerId || "", providerRevision: provider?.providerRevision || "" }));
    return safeProjection(currentTime + ttlMs);
  }

  function isBound({ deviceSessionId = "", session = null } = {}) {
    const normalizedId = normalizeDeviceSessionId(deviceSessionId);
    const deviceSessionDigest = sessionIdDigest(normalizedId);
    const actorDigest = sessionActorDigest(session);
    const currentTime = normalizedNow(now());
    purgeExpired(currentTime);
    const record = sessionsById.get(deviceSessionDigest);
    const provider = providerResolver?.resolveReadyProvider?.({ profileDigest: managedProfileDigest() }) || null;
    return Boolean(record && actorDigest && (!providerResolver || (provider?.platform === "device_managed" && provider.providerId === record.providerId && provider.providerRevision === record.providerRevision)) && crypto.timingSafeEqual(Buffer.from(record.actorDigest), Buffer.from(actorDigest)));
  }

  // This is intentionally process-local. It carries only the opaque Desktop
  // session identifier needed to create a later private dispatch attempt; a
  // Center restart or Desktop session rotation therefore fails closed.
  const taskSessionsById = new Map();

  function bindTask({ deviceSessionId = "", runtimeTask = null, session = null } = {}) {
    const taskId = normalizeTaskId(runtimeTask);
    const inputDigest = normalizeDigest(runtimeTask?.inputDigest);
    const normalizedId = normalizeDeviceSessionId(deviceSessionId);
    const actorDigest = sessionActorDigest(session);
    const currentTime = normalizedNow(now());
    purgeExpired(currentTime);
    if (!taskId || !inputDigest || !normalizedId || !actorDigest || !isBound({ deviceSessionId: normalizedId, session })) {
      return false;
    }
    taskSessionsById.set(taskId, Object.freeze({
      actorDigest,
      deviceSessionId: normalizedId,
      inputDigest,
      expiresAtMs: currentTime + ttlMs,
    }));
    return true;
  }

  function resolveTask({ runtimeTask = null, session = null } = {}) {
    if (resolveTaskStatus({ runtimeTask, session }) !== "bound") return null;
    const taskId = normalizeTaskId(runtimeTask);
    const record = taskSessionsById.get(taskId);
    return Object.freeze({ deviceSessionId: record.deviceSessionId });
  }

  // This intentionally exposes only a bounded failure code. It lets the
  // persistent worker fail before provider/tool execution without leaking a
  // task id, session id, identity, workspace path, or digest value.
  function resolveTaskStatus({ runtimeTask = null, session = null } = {}) {
    const taskId = normalizeTaskId(runtimeTask);
    const inputDigest = normalizeDigest(runtimeTask?.inputDigest);
    const actorDigest = sessionActorDigest(session);
    const currentTime = normalizedNow(now());
    purgeExpired(currentTime);
    if (!taskId) return "task_id_invalid";
    if (!inputDigest) return "task_input_invalid";
    if (!actorDigest) return "task_actor_invalid";
    const record = taskSessionsById.get(taskId);
    if (!record) return "task_binding_missing";
    if (record.inputDigest !== inputDigest) return "task_input_mismatch";
    if (!crypto.timingSafeEqual(Buffer.from(record.actorDigest), Buffer.from(actorDigest))) return "task_actor_mismatch";
    if (!isBound({ deviceSessionId: record.deviceSessionId, session })) return "device_session_unbound";
    return "bound";
  }

  // A Device may prove that it owns a task only with the opaque task id that
  // Center just sent on its private binding stream.  This remains in-memory
  // and deliberately returns no workspace, material, or execution details.
  function resolveBoundTask({ deviceSessionId = "", session = null, taskId = "" } = {}) {
    const normalizedId = normalizeDeviceSessionId(deviceSessionId);
    const normalizedTaskId = String(taskId || "").trim();
    const actorDigest = sessionActorDigest(session);
    const currentTime = normalizedNow(now());
    purgeExpired(currentTime);
    const record = taskSessionsById.get(normalizedTaskId);
    if (!record || !normalizedId || !actorDigest || record.deviceSessionId !== normalizedId ||
      !crypto.timingSafeEqual(Buffer.from(record.actorDigest), Buffer.from(actorDigest)) ||
      !isBound({ deviceSessionId: normalizedId, session })) return null;
    return Object.freeze({ taskId: normalizedTaskId });
  }

  function purgeExpired(currentTime = normalizedNow(now())) {
    for (const [id, record] of sessionsById) {
      if (record.expiresAtMs <= currentTime) sessionsById.delete(id);
    }
    for (const [taskId, record] of taskSessionsById) {
      if (record.expiresAtMs <= currentTime) taskSessionsById.delete(taskId);
    }
  }

  return Object.freeze({ bindTask, isBound, purgeExpired, register, resolveBoundTask, resolveTask, resolveTaskStatus });
}

function managedProfileDigest() {
  return managedSandboxProfileRegistry()[0]?.profileDigest || "";
}

function safeProjection(expiresAtMs) {
  return Object.freeze({
    contractVersion: DESKTOP_SANDBOX_DEVICE_SESSION_CONTRACT_VERSION,
    expiresAt: new Date(expiresAtMs).toISOString(),
    status: "bound",
  });
}

function normalizeDeviceSessionId(value) {
  const normalized = String(value || "").trim().toLowerCase();
  return DEVICE_SESSION_ID.test(normalized) ? normalized : "";
}

function normalizeTaskId(value = null) {
  const taskId = String(value?.taskId || value?.id || "").trim();
  return /^[A-Za-z0-9][A-Za-z0-9._:@-]{0,127}$/.test(taskId) ? taskId : "";
}

function normalizeDigest(value = "") {
  const digest = String(value || "").trim().toLowerCase();
  return /^[a-f0-9]{64}$/.test(digest) ? digest : "";
}

function sessionIdDigest(deviceSessionId = "") {
  if (!deviceSessionId) return "";
  return crypto.createHash("sha256").update(deviceSessionId).digest("hex");
}

function sessionActorDigest(session = null) {
  const principal = String(session?.employeeId || session?.email || session?.feishuUserId || session?.employeeNo || "").trim().toLowerCase();
  const identitySource = String(session?.identitySource || session?.authorization?.identitySource || "").trim().toLowerCase();
  const tenantScope = String(session?.tenantScope || "").trim().toLowerCase();
  const identity = [tenantScope, identitySource, principal].join("\0");
  if (!principal || identity.length > 320) return "";
  return crypto.createHash("sha256").update(identity).digest("hex");
}

function normalizedNow(value) {
  const currentTime = Number(value);
  if (!Number.isFinite(currentTime) || currentTime < 0) throw new TypeError("desktop sandbox device session clock invalid");
  return currentTime;
}

export {
  DESKTOP_SANDBOX_DEVICE_SESSION_CONTRACT_VERSION,
  createDesktopSandboxDeviceSessionRegistry,
};
