import { automationScope, automationDigest, automationError, automationId, automationInteger, automationTimestamp, TERMINAL_TASK_STATES } from "./personal-automation-contract.mjs";
import { latestIntervalSlot } from "./interval-due-slot.mjs";

const SCHEMA = `
CREATE TABLE personal_automations (
  automation_id TEXT PRIMARY KEY, tenant_scope TEXT NOT NULL, actor_issuer TEXT NOT NULL, actor_subject_digest TEXT NOT NULL,
  creation_key TEXT NOT NULL, definition_json TEXT NOT NULL CHECK(json_valid(definition_json)),
  state TEXT NOT NULL CHECK(state IN ('active','paused','disabled','exhausted','attention_required')),
  revision INTEGER NOT NULL, cursor_after TEXT NOT NULL, run_count INTEGER NOT NULL,
  last_task_id TEXT, reason_code TEXT NOT NULL DEFAULT '',
  UNIQUE(tenant_scope,actor_issuer,actor_subject_digest,creation_key)
);
CREATE TABLE personal_automation_runs (
  automation_id TEXT NOT NULL REFERENCES personal_automations(automation_id), scheduled_for TEXT NOT NULL,
  tenant_scope TEXT NOT NULL, task_id TEXT NOT NULL,
  PRIMARY KEY(automation_id,scheduled_for), UNIQUE(tenant_scope,task_id),
  FOREIGN KEY(tenant_scope,task_id) REFERENCES execution_tasks(tenant_scope,task_id)
);
CREATE TABLE personal_automation_notifications (
  automation_id TEXT NOT NULL REFERENCES personal_automations(automation_id), task_id TEXT NOT NULL,
  status TEXT NOT NULL, created_at TEXT NOT NULL, read_at TEXT,
  PRIMARY KEY(automation_id,task_id)
);
CREATE INDEX personal_automation_scan_idx ON personal_automations(state,cursor_after,automation_id);
`;
export function createPersonalAutomationSchema(database) { database.exec(SCHEMA); }
export function ensurePersonalAutomationSchema(database) {
  const present = database.prepare("SELECT name FROM sqlite_master WHERE name IN ('personal_automations','personal_automation_runs','personal_automation_notifications','personal_automation_scan_idx')").all();
  if (!present.length) createPersonalAutomationSchema(database);
  validatePersonalAutomationSchema(database);
  for (const table of ["personal_automations", "personal_automation_runs", "personal_automation_notifications"]) {
    if (database.prepare(`SELECT count(*) AS n FROM ${table}`).get().n !== 0) throw automationError("personal_automation_prepare_not_empty");
  }
}
export function validatePersonalAutomationSchema(database) {
  for (const statement of SCHEMA.split(";").map(v => v.trim()).filter(Boolean)) {
    const name = statement.match(/^CREATE (?:TABLE|INDEX) (\w+)/)[1];
    const actual = database.prepare("SELECT sql FROM sqlite_master WHERE name=?").get(name)?.sql;
    const normalize = s => (s || "").replace(/\s+/g, " ").trim();
    if (normalize(actual) !== normalize(statement)) throw automationError("personal_automation_schema_invalid");
  }
}

// Metadata and canonical task creation share the existing execution DB transaction.
export function createPersonalAutomationRepository({ database, submitTaskInTransaction, readTask, enabled = true }) {
  const scopeArgs = value => Object.values(automationScope(value));
  function transaction(fn) {
    database.exec("BEGIN IMMEDIATE");
    try { const result = fn(); database.exec("COMMIT"); return result; }
    catch (error) { database.exec("ROLLBACK"); throw error; }
  }
  function decode(row) {
    if (!row) return null;
    return { ...JSON.parse(row.definition_json), state: row.state, revision: row.revision, cursorAfter: row.cursor_after,
      runCount: row.run_count, lastTaskId: row.last_task_id, reasonCode: row.reason_code };
  }
  function get(scope, id) {
    return decode(database.prepare("SELECT * FROM personal_automations WHERE tenant_scope=? AND actor_issuer=? AND actor_subject_digest=? AND automation_id=?").get(...scopeArgs(scope), automationId(id)));
  }
  function create(definition) {
    if (!enabled) throw automationError("personal_automation_not_active");
    const { idempotencyKey, ...safeDefinition } = definition;
    const creationKey = automationDigest(automationId(idempotencyKey));
    return transaction(() => {
      const existing = database.prepare("SELECT * FROM personal_automations WHERE tenant_scope=? AND actor_issuer=? AND actor_subject_digest=? AND creation_key=?").get(...scopeArgs(definition), creationKey);
      if (existing) {
        if (existing.definition_json !== JSON.stringify(safeDefinition)) throw automationError("personal_automation_idempotency_conflict");
        return decode(existing);
      }
      const count = database.prepare("SELECT count(*) AS n FROM personal_automations WHERE tenant_scope=? AND actor_issuer=? AND actor_subject_digest=?").get(...scopeArgs(definition)).n;
      if (count >= 100) throw automationError("personal_automation_owner_limit");
      database.prepare("INSERT INTO personal_automations(automation_id,tenant_scope,actor_issuer,actor_subject_digest,creation_key,definition_json,state,revision,cursor_after,run_count) VALUES(?,?,?,?,?,?,'active',1,?,0)")
        .run(definition.automationId, ...scopeArgs(definition), creationKey, JSON.stringify(safeDefinition), new Date(Date.parse(definition.startAt) - 1).toISOString());
      return get(definition, definition.automationId);
    });
  }
  function list(scope) {
    return database.prepare("SELECT * FROM personal_automations WHERE tenant_scope=? AND actor_issuer=? AND actor_subject_digest=? ORDER BY automation_id LIMIT 100").all(...scopeArgs(scope)).map(decode);
  }
  function change(scope, id, expectedRevision, action, now) {
    automationInteger(expectedRevision, 1, Number.MAX_SAFE_INTEGER); automationTimestamp(now);
    if (!["pause", "resume", "disable"].includes(action)) throw automationError("personal_automation_action_invalid");
    return transaction(() => {
      const row = get(scope, id);
      if (!row) throw automationError("personal_automation_not_found");
      if (row.revision !== expectedRevision) throw automationError("personal_automation_revision_conflict");
      if (["disabled", "exhausted"].includes(row.state)) throw automationError("personal_automation_terminal");
      const expired = now >= row.expiresAt || row.runCount >= row.maxRuns;
      const state = expired ? "exhausted" : ({pause:"paused",resume:"active",disable:"disabled"})[action];
      database.prepare("UPDATE personal_automations SET state=?,revision=revision+1,cursor_after=?,reason_code='' WHERE automation_id=?")
        .run(state, action === "resume" ? (now > row.cursorAfter ? now : row.cursorAfter) : row.cursorAfter, id);
      return get(scope, id);
    });
  }
  function candidates(limit = 100) {
    if (!enabled) return [];
    return database.prepare("SELECT * FROM personal_automations WHERE state='active' ORDER BY cursor_after,automation_id LIMIT ?").all(automationInteger(limit,1,500)).map(decode);
  }
  function advance(definition, now, submission = null, selectedSlot = null, {skipDueSlot = false} = {}) {
    if (!enabled) throw automationError("personal_automation_not_active");
    automationTimestamp(now);
    return transaction(() => {
      const current = get(definition, definition.automationId);
      if (!current || current.revision !== definition.revision || current.cursorAfter !== definition.cursorAfter || current.state !== "active") throw automationError("personal_automation_revision_conflict");
      if (now < current.cursorAfter) return null;
      if (now >= current.expiresAt || current.runCount >= current.maxRuns) {
        database.prepare("UPDATE personal_automations SET state='exhausted',revision=revision+1,reason_code='limit_reached' WHERE automation_id=?").run(current.automationId);
        return null;
      }
      if (skipDueSlot) {
        if (submission || selectedSlot) throw automationError("personal_automation_submission_invalid");
        database.prepare("UPDATE personal_automations SET cursor_after=? WHERE automation_id=?").run(now,current.automationId);
        return null;
      }
      const slot = selectedSlot || latestIntervalSlot({ ...current, afterExclusive: current.cursorAfter, throughInclusive: now });
      if (selectedSlot && (selectedSlot > now || latestIntervalSlot({...current,afterExclusive:current.cursorAfter,throughInclusive:selectedSlot}) !== selectedSlot)) throw automationError("personal_automation_submission_invalid");
      const previous = current.lastTaskId ? readTask(current.lastTaskId, current.tenantScope) : null;
      if (current.lastTaskId && !previous) throw automationError("personal_automation_task_missing");
      const busy = previous && !TERMINAL_TASK_STATES.has(previous.status);
      let result = null;
      if (slot && !busy) {
        if (!submission) return null; // Preparation is required before a due slot can advance.
        if (submission.tenantScope !== current.tenantScope || submission.actorIssuer !== current.actorIssuer || submission.actorSubjectDigest !== current.actorSubjectDigest ||
            submission.employeeId !== current.employeeId || submission.employeeVersion !== current.employeeVersion ||
            submission.executionInputRef?.kind !== "transcript_entry" || submission.sourceSystemId !== "personal-automation" ||
            submission.providerTimeoutPolicy.taskExecutionTotalMs > current.budget.taskExecutionTotalMs) throw automationError("personal_automation_submission_invalid");
        result = submitTaskInTransaction(submission);
        database.prepare("INSERT INTO personal_automation_runs VALUES(?,?,?,?)").run(current.automationId, slot, current.tenantScope, result.task.taskId);
      }
      database.prepare("UPDATE personal_automations SET cursor_after=?,revision=revision+?,run_count=run_count+?,last_task_id=coalesce(?,last_task_id) WHERE automation_id=?")
        .run(now, result ? 1 : 0, result ? 1 : 0, result?.task.taskId || null, current.automationId);
      return result;
    });
  }
  function hold(definition, reasonCode) {
    if (!["input_unavailable", "authorization_changed", "execution_unavailable"].includes(reasonCode)) throw automationError("personal_automation_reason_invalid");
    database.prepare("UPDATE personal_automations SET state='attention_required',reason_code=?,revision=revision+1 WHERE automation_id=? AND revision=? AND state='active'")
      .run(reasonCode, definition.automationId, definition.revision);
  }
  function reconcile(now) {
    // Reconcile every run, including older runs beyond a previous batch limit.
    for (const row of database.prepare(`SELECT r.automation_id,r.tenant_scope,r.task_id FROM personal_automation_runs r
      JOIN execution_tasks t ON t.tenant_scope=r.tenant_scope AND t.task_id=r.task_id
      WHERE t.status IN ('completed','failed','blocked','rejected','canceled','timed_out','lost')
      AND NOT EXISTS (SELECT 1 FROM personal_automation_notifications n WHERE n.automation_id=r.automation_id AND n.task_id=r.task_id)
      ORDER BY r.scheduled_for,r.automation_id LIMIT 500`).all()) {
      const task = readTask(row.task_id, row.tenant_scope);
      if (!task || !TERMINAL_TASK_STATES.has(task.status)) continue;
      transaction(() => {
        if (database.prepare("SELECT 1 FROM personal_automation_notifications WHERE automation_id=? AND task_id=?").get(row.automation_id,task.taskId)) return;
        database.prepare("INSERT OR IGNORE INTO personal_automation_notifications VALUES(?,?,?,?,NULL)").run(row.automation_id, task.taskId, task.status, now);
      });
    }
  }
  function detail(scope, id) {
    const definition = get(scope, id);
    if (!definition) throw automationError("personal_automation_not_found");
    const runs = database.prepare("SELECT scheduled_for,task_id FROM personal_automation_runs WHERE automation_id=? ORDER BY scheduled_for DESC LIMIT 100").all(id)
      .map(row => ({ scheduledFor: row.scheduled_for, taskId: row.task_id, status: readTask(row.task_id, definition.tenantScope)?.status || "lost" }));
    return { definition, runs };
  }
  function notifications(scope) {
    return database.prepare(`SELECT n.automation_id AS automationId,n.task_id AS taskId,n.status,n.created_at AS createdAt,n.read_at AS readAt
      FROM personal_automation_notifications n JOIN personal_automations a ON a.automation_id=n.automation_id
      WHERE a.tenant_scope=? AND a.actor_issuer=? AND a.actor_subject_digest=? ORDER BY n.created_at DESC LIMIT 100`).all(...scopeArgs(scope));
  }
  function markRead(scope, id, taskId, now) {
    if (!get(scope,id)) throw automationError("personal_automation_not_found");
    database.prepare("UPDATE personal_automation_notifications SET read_at=coalesce(read_at,?) WHERE automation_id=? AND task_id=?").run(automationTimestamp(now),id,automationId(taskId));
  }
  function forTask(task) {
    const row = database.prepare("SELECT a.* FROM personal_automations a JOIN personal_automation_runs r ON r.automation_id=a.automation_id WHERE r.tenant_scope=? AND r.task_id=?").get(task.tenantScope, task.taskId);
    return decode(row);
  }
  return Object.freeze({enabled,create,get,list,change,candidates,advance,hold,reconcile,detail,notifications,markRead,forTask});
}
