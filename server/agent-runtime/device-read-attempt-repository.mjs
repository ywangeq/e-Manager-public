import crypto from "node:crypto";
import { isDeepStrictEqual } from "node:util";

const FIELDS = ["taskId", "taskInputDigest", "actorDigest", "deviceSessionDigest", "leaseFenceDigest",
  "toolCallId", "toolId", "operationId", "adapterDigest", "inputDigest"];
const IDS = new Set(["taskId", "toolCallId", "toolId", "operationId"]);
const STATES = new Set(["prepared", "running", "completed", "failed", "canceled", "unknown"]);
const NEXT = { prepared: new Set(["running", "canceled", "unknown"]), running: new Set(["completed", "failed", "canceled", "unknown"]) };
const SCHEMA = [
  `CREATE TABLE execution_device_read_schema (singleton INTEGER PRIMARY KEY CHECK(singleton=1), version INTEGER NOT NULL CHECK(version=1), phase TEXT NOT NULL CHECK(phase IN ('prepare','activate')))`,
  `CREATE TABLE execution_device_read_attempts (tenant_scope TEXT NOT NULL, task_id TEXT NOT NULL, tool_call_id TEXT NOT NULL, attempt_id TEXT NOT NULL, binding_json TEXT NOT NULL, status TEXT NOT NULL CHECK(status IN ('prepared','running','completed','failed','canceled','unknown')), created_at TEXT NOT NULL, updated_at TEXT NOT NULL, expires_at TEXT NOT NULL, state_digest TEXT NOT NULL, PRIMARY KEY(tenant_scope,attempt_id), UNIQUE(tenant_scope,task_id,tool_call_id), FOREIGN KEY(tenant_scope,task_id) REFERENCES execution_tasks(tenant_scope,task_id))`,
  `CREATE INDEX execution_device_read_task_idx ON execution_device_read_attempts(tenant_scope,task_id,status)`,
];

// Versioned extension of the canonical task DB, never a database/queue owner.
// Temporary feature schema avoids activating the independently owned v26 goal
// binding. Runtime Device owns migration into a common extension registry.
export function createDeviceReadAttemptRepository({ database, phase = "inactive", readTask, ownsLiveLease, normalizeLeaseIdentity, rollbackIfActive }) {
  if (!["inactive", "prepare", "activate"].includes(phase)) fail("schema_phase_invalid");
  let metadata = database.prepare("SELECT name FROM sqlite_master WHERE name IN ('execution_device_read_schema','execution_device_read_attempts')").all();
  if (!metadata.length && phase === "inactive") return null;
  if (!metadata.length) {
    if (phase !== "prepare") fail("schema_prepare_required");
    transaction(() => { SCHEMA.forEach(sql => database.exec(sql)); database.exec("INSERT INTO execution_device_read_schema VALUES(1,1,'prepare')"); });
  }
  validateSchema();
  if (phase === "inactive") return null;
  if (phase === "prepare") {
    if (state() !== "prepare" || database.prepare("SELECT COUNT(*) AS n FROM execution_device_read_attempts").get().n !== 0) fail("schema_prepare_conflict");
    return null;
  }
  if (state() === "prepare") transaction(() => {
    validateSchema();
    if (database.prepare("SELECT COUNT(*) AS n FROM execution_device_read_attempts").get().n !== 0) fail("schema_prepare_not_empty");
    if (database.prepare("UPDATE execution_device_read_schema SET phase='activate' WHERE singleton=1 AND version=1 AND phase='prepare'").run().changes !== 1) fail("schema_activation_conflict");
  });
  const active = () => { if (state() !== "activate") fail("schema_not_active"); };

  function create({ tenantScope, ownership, binding, now, expiresAt }) {
    const normalized = normalizeBinding(binding), at = time(now), until = time(expiresAt);
    if (until <= at || Date.parse(until) - Date.parse(at) > 120000) fail("expiry_invalid");
    return transaction(() => {
      active();
      const task = requireTask(tenantScope, normalized, ownership, at);
      const id = `device_read_${hash({ tenantScope: task.tenantScope, taskId: task.taskId, toolCallId: normalized.toolCallId })}`;
      const previous = read({ tenantScope, attemptId: id });
      if (previous) {
        if (!isDeepStrictEqual(previous.binding, normalized)) fail("binding_conflict");
        return { created: false, attempt: previous };
      }
      const attempt = seal({ attemptId: id, tenantScope, binding: normalized, status: "prepared", createdAt: at, updatedAt: at, expiresAt: until });
      database.prepare("INSERT INTO execution_device_read_attempts VALUES(?,?,?,?,?,?,?,?,?,?)").run(
        tenantScope, task.taskId, normalized.toolCallId, id, JSON.stringify(normalized), attempt.status, at, at, until, attempt.stateDigest);
      return { created: true, attempt };
    });
  }
  function read({ tenantScope, attemptId }) {
    active();
    const row = database.prepare("SELECT * FROM execution_device_read_attempts WHERE tenant_scope=? AND attempt_id=?").get(tenantScope, attemptId);
    if (!row) return null;
    const attempt = seal({ attemptId: row.attempt_id, tenantScope: row.tenant_scope, binding: normalizeBinding(JSON.parse(row.binding_json)),
      status: row.status, createdAt: time(row.created_at), updatedAt: time(row.updated_at), expiresAt: time(row.expires_at) });
    if (attempt.stateDigest !== row.state_digest || attempt.binding.taskId !== row.task_id || attempt.binding.toolCallId !== row.tool_call_id || !STATES.has(row.status)) fail("integrity_invalid");
    return attempt;
  }
  function transition({ tenantScope, attemptId, ownership, deviceSessionDigest, nextStatus, now }) {
    const at = time(now);
    return transaction(() => {
      active();
      const stored = read({ tenantScope, attemptId });
      if (!stored || !NEXT[stored.status]?.has(nextStatus) || deviceSessionDigest !== stored.binding.deviceSessionDigest || at < stored.updatedAt) fail("transition_invalid");
      requireTask(tenantScope, stored.binding, ownership, at, nextStatus === "unknown");
      if (at >= stored.expiresAt && nextStatus !== "unknown") fail("attempt_expired");
      const updated = seal({ ...stored, status: nextStatus, updatedAt: at });
      const changed = database.prepare("UPDATE execution_device_read_attempts SET status=?,updated_at=?,state_digest=? WHERE tenant_scope=? AND attempt_id=? AND state_digest=?")
        .run(updated.status, at, updated.stateDigest, tenantScope, attemptId, stored.stateDigest);
      if (changed.changes !== 1) fail("transition_conflict");
      return updated;
    });
  }
  function isLive({ tenantScope, attemptId, ownership, deviceSessionDigest, now }) {
    const at = time(now);
    const stored = read({ tenantScope, attemptId });
    if (!stored || !["prepared", "running"].includes(stored.status) || stored.binding.deviceSessionDigest !== deviceSessionDigest ||
      at < stored.updatedAt || at >= stored.expiresAt) return false;
    try { requireTask(tenantScope, stored.binding, ownership, at); return true; }
    catch { return false; }
  }
  function requireTask(tenantScope, binding, ownership, at, reconcile = false) {
    const identity = normalizeLeaseIdentity({ ...ownership, tenantScope, taskId: binding.taskId });
    const task = readTask(binding.taskId, tenantScope);
    if (!task || task.tenantScope !== tenantScope || task.taskId !== binding.taskId ||
      task.inputDigest !== binding.taskInputDigest || task.actorSubjectDigest !== binding.actorDigest || !ownsLiveLease(task, identity, at)) fail("task_lease_unavailable");
    if (!reconcile && deviceReadLeaseFenceDigest(identity) !== binding.leaseFenceDigest) fail("lease_fence_changed");
    return task;
  }
  function state() {
    const rows = database.prepare("SELECT * FROM execution_device_read_schema").all();
    if (rows.length !== 1 || rows[0].singleton !== 1 || rows[0].version !== 1 || !["prepare", "activate"].includes(rows[0].phase)) fail("schema_metadata_invalid");
    return rows[0].phase;
  }
  function validateSchema() {
    for (const sql of SCHEMA) {
      const name = sql.match(/CREATE (?:TABLE|INDEX) (\w+)/)[1];
      const actual = database.prepare("SELECT sql FROM sqlite_master WHERE name=?").get(name)?.sql;
      if (actual?.replace(/\s+/g, " ").trim() !== sql) fail("schema_integrity_invalid");
    }
    state();
  }
  function transaction(action) {
    database.exec("BEGIN IMMEDIATE");
    try { const result = action(); database.exec("COMMIT"); return result; }
    catch (error) { rollbackIfActive(database); throw error; }
  }
  function reconcileForTask({ tenantScope, taskId, ownership, now }) {
    active();
    const at = time(now), task = readTask(taskId, tenantScope);
    const identity = normalizeLeaseIdentity({ ...ownership, tenantScope, taskId });
    if (!task || !ownsLiveLease(task, identity, at)) fail("task_lease_unavailable");
    const currentFence = deviceReadLeaseFenceDigest(identity);
    let reconciled = 0;
    for (const row of database.prepare("SELECT attempt_id FROM execution_device_read_attempts WHERE tenant_scope=? AND task_id=? AND status IN ('prepared','running')").all(tenantScope, taskId)) {
      const stored = read({ tenantScope, attemptId: row.attempt_id });
      if (stored.binding.leaseFenceDigest === currentFence) continue;
      // A new canonical Worker owns reconciliation, never the stale caller.
      // Private facts vanished with the old process; no attempt is re-dispatched.
      transition({ tenantScope, attemptId: stored.attemptId, ownership,
        deviceSessionDigest: stored.binding.deviceSessionDigest, nextStatus: "unknown", now: at });
      reconciled++;
    }
    return reconciled;
  }
  return Object.freeze({ create, read, transition, isLive, reconcileForTask });
}

export function deviceReadLeaseFenceDigest(identity) {
  const { tenantScope, taskId, leaseId, workerIdDigest, fencingToken } = identity;
  return hash({ tenantScope, taskId, leaseId, workerIdDigest, fencingToken });
}
function normalizeBinding(value) {
  if (!value || Object.getPrototypeOf(value) !== Object.prototype || Object.keys(value).length !== FIELDS.length || FIELDS.some(key =>
    !Object.hasOwn(value, key) || typeof value[key] !== "string" || !(IDS.has(key) ? /^[A-Za-z0-9][A-Za-z0-9._:@-]{0,127}$/ : /^[a-f0-9]{64}$/).test(value[key]))) fail("binding_invalid");
  return Object.freeze(Object.fromEntries(FIELDS.map(key => [key, value[key]])));
}
function seal(value) {
  const { stateDigest: ignored, ...body } = value;
  return Object.freeze({ ...body, stateDigest: hash(body) });
}
function hash(value) { return crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex"); }
function time(value) { if (!(value instanceof Date) && typeof value !== "string") fail("time_invalid"); const date = new Date(value); if (!Number.isFinite(+date)) fail("time_invalid"); return date.toISOString(); }
function fail(reason) { throw Object.assign(new Error(`device_read_${reason}`), { code: `device_read_${reason}` }); }
