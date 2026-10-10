import crypto from "node:crypto";

const DEVICE_ID = /^dwr_[a-f0-9]{32}$/;
const DIGEST = /^[a-f0-9]{64}$/;
const TASK_ID = /^[A-Za-z0-9][A-Za-z0-9._:@-]{0,127}$/;

// Runtime/Device owns this ephemeral presence/capability binding. The canonical
// task remains the task/actor/input authority; target RBAC and per-Tool policy
// remain authorization. Presence expiry is not CLI credential expiry. Rotation
// or Center restart invalidates bindings and never silently selects another PC.
export function createDeviceReadSessionRegistry({ resolveActor, adapterDigests = [], now = () => Date.now(), presenceTtlMs = 120_000 } = {}) {
  if (typeof resolveActor !== "function" || !Number.isSafeInteger(presenceTtlMs) || presenceTtlMs < 30_000 || presenceTtlMs > 300_000 ||
    !adapterDigests.length || adapterDigests.some(value => !DIGEST.test(value))) throw new TypeError("device_read_session_registry_invalid");
  const published = new Set(adapterDigests), devices = new Map(), tasks = new Map();
  const taskKey = task => JSON.stringify([task?.tenantScope, task?.taskId]);
  const deviceDigest = id => typeof id === "string" && DEVICE_ID.test(id) ? crypto.createHash("sha256").update(id).digest("hex") : "";
  function actorFor(session) {
    try {
      const actor = resolveActor(session);
      return typeof actor?.tenantScope === "string" && actor.tenantScope && DIGEST.test(actor.actorDigest) ?
        Object.freeze({ tenantScope: actor.tenantScope, actorDigest: actor.actorDigest }) : null;
    } catch { return null; }
  }
  function purge() {
    const at = now();
    for (const [digest, record] of devices) if (record.expiresAtMs <= at) devices.delete(digest);
    for (const [key, record] of tasks) if (!devices.has(record.deviceSessionDigest)) tasks.delete(key);
  }
  function identity({ deviceSessionId, session } = {}) {
    purge();
    const actor = actorFor(session), digest = deviceDigest(deviceSessionId), record = devices.get(digest);
    if (!actor || !record || record.actorDigest !== actor.actorDigest || record.tenantScope !== actor.tenantScope) return null;
    return Object.freeze({ ...actor, deviceSessionDigest: digest });
  }
  function register({ deviceSessionId, session, capabilities, timeZone = "" } = {}) {
    purge();
    const actor = actorFor(session), digest = deviceDigest(deviceSessionId);
    if (!actor || !digest || !Array.isArray(capabilities) || !capabilities.length || capabilities.length > published.size ||
      new Set(capabilities).size !== capabilities.length || capabilities.some(value => typeof value !== "string" || !published.has(value))) return null;
    const previous = devices.get(digest);
    if (previous && (previous.tenantScope !== actor.tenantScope || previous.actorDigest !== actor.actorDigest)) return null;
    try { if (timeZone && (typeof timeZone !== "string" || timeZone.length > 128 || new Intl.DateTimeFormat("en", {timeZone}).resolvedOptions().timeZone !== timeZone)) return null; } catch { return null; }
    const expiresAtMs = now() + presenceTtlMs;
    const generation = previous && previous.timeZone === timeZone && JSON.stringify(previous.capabilities) === JSON.stringify(capabilities)
      ? previous.generation : crypto.randomUUID();
    devices.set(digest, Object.freeze({ ...actor, capabilities: Object.freeze([...capabilities]), expiresAtMs, timeZone, generation }));
    return Object.freeze({ status: "available", expiresAt: new Date(expiresAtMs).toISOString() });
  }
  function bindTask({ deviceSessionId, session, task, created = false } = {}) {
    const current = identity({ deviceSessionId, session });
    if (!current || !validTask(task) || current.tenantScope !== task.tenantScope || current.actorDigest !== task.actorSubjectDigest) return false;
    const key = taskKey(task), existing = tasks.get(key);
    // Only the canonical submit result may establish a new binding. A duplicate
    // request after expiry/restart cannot rebind the existing task to another PC.
    if (!existing && (created !== true || tasks.size >= 10_000)) return false;
    const record = Object.freeze({ ...current, taskInputDigest: task.inputDigest });
    if (existing && (existing.deviceSessionDigest !== record.deviceSessionDigest || existing.taskInputDigest !== record.taskInputDigest ||
      existing.actorDigest !== record.actorDigest)) return false;
    tasks.set(key, record); return true;
  }
  function resolveTask({ session, task, adapterDigest } = {}) {
    purge();
    const actor = actorFor(session), record = tasks.get(taskKey(task));
    if (!actor || !validTask(task) || !record || record.tenantScope !== actor.tenantScope || task.tenantScope !== actor.tenantScope ||
      record.actorDigest !== actor.actorDigest || task.actorSubjectDigest !== actor.actorDigest || record.taskInputDigest !== task.inputDigest) return null;
    const device = devices.get(record.deviceSessionDigest);
    if (!device || device.actorDigest !== actor.actorDigest || device.tenantScope !== actor.tenantScope || !device.capabilities.includes(adapterDigest)) return null;
    return Object.freeze({ ...record, timeZone: device.timeZone });
  }
  function revoke({ deviceSessionId, session } = {}) {
    const current = identity({ deviceSessionId, session });
    if (!current) return false;
    devices.delete(current.deviceSessionDigest); purge(); return true;
  }
  return Object.freeze({ register, identity, bindTask, resolveTask, revoke, purge });
}
function validTask(task) {
  return Boolean(task && typeof task.tenantScope === "string" && task.tenantScope && TASK_ID.test(task.taskId) &&
    DIGEST.test(task.inputDigest) && DIGEST.test(task.actorSubjectDigest));
}
