import { groupContentDigest, groupContractError, groupId, groupScope } from "./group-contracts-v1.mjs";
import { normalizeExecutionTaskSubmission } from "./runtime-task-contract-v1.mjs";
import { assertWorkGoalBindingCurrent, assertWorkGoalBindingTask, createWorkGoalTaskBinding,
  normalizeWorkGoalTaskBinding } from "./work-goal-task-binding-v1.mjs";

export const WORK_GOAL_BINDING_SCHEMA_V26 = `CREATE TABLE work_goal_task_bindings (
  tenant_scope TEXT NOT NULL, actor_issuer TEXT NOT NULL, actor_subject_digest TEXT NOT NULL,
  task_id TEXT NOT NULL, goal_kind TEXT NOT NULL DEFAULT 'goal' CHECK(goal_kind='goal'),
  goal_id TEXT NOT NULL, goal_revision INTEGER NOT NULL CHECK(goal_revision>=1),
  binding_kind TEXT NOT NULL CHECK(binding_kind IN ('initial','continuation','scheduled')),
  source_task_id TEXT, creation_digest TEXT NOT NULL,
  content_json TEXT NOT NULL CHECK(json_valid(content_json)),
  PRIMARY KEY(tenant_scope, task_id),
  FOREIGN KEY(tenant_scope, task_id) REFERENCES execution_tasks(tenant_scope, task_id),
  FOREIGN KEY(tenant_scope, source_task_id) REFERENCES execution_tasks(tenant_scope, task_id),
  FOREIGN KEY(tenant_scope, actor_issuer, actor_subject_digest, goal_kind, goal_id, goal_revision)
    REFERENCES group_metadata(tenant_scope, actor_issuer, actor_subject_digest, entity_kind, entity_id, entity_version),
  CHECK((binding_kind='initial' AND source_task_id IS NULL) OR (binding_kind!='initial' AND source_task_id IS NOT NULL))
);
CREATE UNIQUE INDEX work_goal_initial_binding ON work_goal_task_bindings
  (tenant_scope, actor_issuer, actor_subject_digest, goal_id) WHERE binding_kind='initial'`;

export function createWorkGoalBindingSchemaV26(database) {
  const exists = database.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='work_goal_task_bindings'").get();
  if (!exists) database.exec(WORK_GOAL_BINDING_SCHEMA_V26);
}

export function validateWorkGoalBindingSchemaV26(database, { requireEmpty = false } = {}) {
  const canonical = sql => (sql || "").replace(/\s+/g, " ").trim();
  for (const statement of WORK_GOAL_BINDING_SCHEMA_V26.split(";").map(s => s.trim()).filter(Boolean)) {
    const [, type, name] = statement.match(/^CREATE (TABLE|UNIQUE INDEX) (\w+)/);
    const row = database.prepare("SELECT sql FROM sqlite_master WHERE type=? AND name=?")
      .get(type === "TABLE" ? "table" : "index", name);
    if (canonical(row?.sql) !== canonical(statement)) throw groupContractError("work_goal_binding_schema_invalid");
  }
  if (requireEmpty && database.prepare("SELECT 1 FROM work_goal_task_bindings LIMIT 1").get()) {
    throw groupContractError("work_goal_binding_prepare_not_empty");
  }
}

// Uses the canonical connection and internal task submission, never another queue.
export function createWorkGoalTaskBindingRepository({ database, groups, submitTaskInTransaction, readTask, enabled = false }) {
  const scope = actor => Object.values(groupScope(actor));
  function decode(row) {
    if (!row) return null;
    const b = normalizeWorkGoalTaskBinding(JSON.parse(row.content_json));
    if (groupContentDigest(b) !== row.creation_digest || b.tenantScope !== row.tenant_scope ||
      b.actorIssuer !== row.actor_issuer || b.actorSubjectDigest !== row.actor_subject_digest ||
      b.taskId !== row.task_id || b.goalId !== row.goal_id || b.goalRevision !== row.goal_revision ||
      b.kind !== row.binding_kind || b.sourceTaskId !== row.source_task_id) throw groupContractError("work_goal_binding_integrity_invalid");
    return b;
  }
  function read(actor, taskId) {
    groupId(taskId);
    return decode(database.prepare(`SELECT * FROM work_goal_task_bindings
      WHERE tenant_scope=? AND actor_issuer=? AND actor_subject_digest=? AND task_id=?`).get(...scope(actor), taskId));
  }
  function write(binding) {
    const b = normalizeWorkGoalTaskBinding(binding);
    database.prepare("INSERT INTO work_goal_task_bindings VALUES(?,?,?,?,'goal',?,?,?,?,?,?)")
      .run(...scope(b), b.taskId, b.goalId, b.goalRevision, b.kind, b.sourceTaskId, groupContentDigest(b), JSON.stringify(b));
    return b;
  }
  function submit({ actor, goalId, expectedGoalRevision, submission, initialGoal = null, kind = "initial", sourceTaskId = null }) {
    if (!enabled) throw groupContractError("work_goal_binding_not_active");
    if ((kind === "initial") !== (sourceTaskId === null)) throw groupContractError("work_goal_binding_source_invalid");
    if (initialGoal && (initialGoal.goalId !== goalId || initialGoal.revision !== expectedGoalRevision || kind !== "initial")) {
      throw groupContractError("work_goal_binding_initial_goal_invalid");
    }
    const taskInput = normalizeExecutionTaskSubmission(submission);
    database.exec("BEGIN IMMEDIATE");
    try {
      const existing = read(actor, taskInput.taskId);
      if (existing) {
        assertWorkGoalBindingTask(existing, taskInput);
        if (existing.goalId !== goalId || existing.goalRevision !== expectedGoalRevision ||
          existing.kind !== kind || existing.sourceTaskId !== sourceTaskId) throw groupContractError("work_goal_binding_idempotency_conflict");
        if (initialGoal) groups.createGoalInTransaction(actor, initialGoal);
        const result = submitTaskInTransaction(taskInput);
        database.exec("COMMIT");
        return { ...result, binding: existing };
      }
      if (initialGoal) groups.createGoalInTransaction(actor, initialGoal);
      const goal = groups.readLatestGoal(actor, goalId);
      if (!goal || goal.revision !== expectedGoalRevision) throw groupContractError("work_goal_binding_revision_changed");
      if (groups.hasPlanningForGoal(actor, goalId)) throw groupContractError("work_goal_binding_planned_goal");
      if (kind === "initial" && database.prepare(`SELECT 1 FROM work_goal_task_bindings
        WHERE tenant_scope=? AND actor_issuer=? AND actor_subject_digest=? AND goal_id=? AND binding_kind='initial'`)
        .get(...scope(actor), goalId)) throw groupContractError("work_goal_binding_initial_exists");
      const sourceBinding = sourceTaskId === null ? null : read(actor, sourceTaskId);
      const sourceTask = sourceTaskId === null ? null : readTask(sourceTaskId, groupScope(actor).tenantScope);
      const binding = createWorkGoalTaskBinding({ goal, task: taskInput, kind, sourceBinding, sourceTask });
      // A legacy/unbound canonical task cannot be silently adopted through submit.
      if (readTask(taskInput.taskId, groupScope(actor).tenantScope)) throw groupContractError("work_goal_binding_existing_unbound_task");
      const result = submitTaskInTransaction(taskInput);
      write(binding);
      database.exec("COMMIT");
      return { ...result, binding };
    } catch (error) { if (database.isTransaction) database.exec("ROLLBACK"); throw error; }
  }
  function readContext(actor, taskId) {
    const binding = read(actor, taskId);
    if (!binding) return null;
    const task = readTask(taskId, groupScope(actor).tenantScope);
    if (!task) throw groupContractError("work_goal_binding_integrity_invalid");
    assertWorkGoalBindingTask(binding, task);
    const goal = groups.readGoal(actor, binding.goalId, binding.goalRevision);
    if (!goal || goal.objectiveDigest !== binding.objectiveDigest) throw groupContractError("work_goal_binding_integrity_invalid");
    return { binding, goal };
  }
  function assertCurrent(actor, taskId) {
    const context = readContext(actor, taskId);
    if (!context) throw groupContractError("work_goal_binding_source_required");
    assertWorkGoalBindingCurrent(context.binding, groups.readLatestGoal(actor, context.binding.goalId));
    return context;
  }
  return Object.freeze({ enabled, read, readContext, assertCurrent, submit });
}
