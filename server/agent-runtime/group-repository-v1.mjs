import { readGroupDelivery, assertGroupDeliveryAvailable } from "./group-delivery-v1.mjs";
import { EXECUTION_TASK_TERMINAL_STATUSES } from "./runtime-task-contract-v1.mjs";
import {
  assertGroupScope, groupContentDigest, groupContractError, groupId, groupInteger,
  groupScope, normalizeWorkGoal, normalizeGroupVersion, normalizeGroupPlan,
  normalizeGroupPlanDraft, normalizeGroupRun, normalizeGroupQuestion, requiredGroupExecutionStepIds,
} from "./group-contracts-v1.mjs";

const TYPES = Object.freeze({
  goal: { normalize: normalizeWorkGoal, id: "goalId", version: "revision" },
  version: { normalize: normalizeGroupVersion, id: "groupId", version: "version" },
  plan: { normalize: normalizeGroupPlan, id: "planId", version: "revision" },
  draft: { normalize: normalizeGroupPlanDraft, id: "planId", version: "revision" },
  run: { normalize: normalizeGroupRun, id: "runId" },
  question: { normalize: normalizeGroupQuestion, id: "questionId" },
});

export const GROUP_SCHEMA_V22 = `
  CREATE TABLE group_metadata (
    tenant_scope TEXT NOT NULL, actor_issuer TEXT NOT NULL, actor_subject_digest TEXT NOT NULL,
    entity_kind TEXT NOT NULL CHECK(entity_kind IN ('goal','version','plan','draft','run','question')),
    entity_id TEXT NOT NULL, entity_version INTEGER NOT NULL CHECK(entity_version >= 0),
    revision INTEGER NOT NULL CHECK(revision >= 0),
    idempotency_key TEXT NOT NULL, creation_digest TEXT NOT NULL, content_json TEXT NOT NULL CHECK(json_valid(content_json)),
    PRIMARY KEY(tenant_scope, actor_issuer, actor_subject_digest, entity_kind, entity_id, entity_version),
    UNIQUE(tenant_scope, actor_issuer, actor_subject_digest, entity_kind, idempotency_key)
  );
  CREATE TABLE group_step_bindings (
    tenant_scope TEXT NOT NULL, actor_issuer TEXT NOT NULL, actor_subject_digest TEXT NOT NULL,
    run_kind TEXT NOT NULL DEFAULT 'run' CHECK(run_kind='run'), run_id TEXT NOT NULL,
    run_version INTEGER NOT NULL DEFAULT 0 CHECK(run_version=0),
    plan_revision INTEGER NOT NULL, step_id TEXT NOT NULL, round INTEGER NOT NULL CHECK(round IN (0,1)), task_id TEXT NOT NULL,
    PRIMARY KEY(tenant_scope, actor_issuer, actor_subject_digest, run_id, step_id),
    UNIQUE(tenant_scope, task_id),
    FOREIGN KEY(tenant_scope, actor_issuer, actor_subject_digest, run_kind, run_id, run_version)
      REFERENCES group_metadata(tenant_scope, actor_issuer, actor_subject_digest, entity_kind, entity_id, entity_version),
    FOREIGN KEY(tenant_scope, task_id) REFERENCES execution_tasks(tenant_scope, task_id)
  );
`;

const HISTORY_SCHEMA = `CREATE TABLE group_history_deleted (
  tenant_scope TEXT NOT NULL, actor_issuer TEXT NOT NULL, actor_subject_digest TEXT NOT NULL,
  goal_id TEXT NOT NULL,
  PRIMARY KEY(tenant_scope, actor_issuer, actor_subject_digest, goal_id)
)`;
export function createGroupHistorySchemaV25(database) {
  const exists = database.prepare("SELECT 1 FROM sqlite_master WHERE name='group_history_deleted' AND type='table'").get();
  if (!exists) database.exec(HISTORY_SCHEMA);
}
export function validateGroupHistorySchemaV25(database) {
  const actual = database.prepare("SELECT sql FROM sqlite_master WHERE name='group_history_deleted' AND type='table'").get()?.sql;
  const canonical = value => (value || "").replace(/\s+/g, " ").trim();
  if (canonical(actual) !== canonical(HISTORY_SCHEMA)) throw groupContractError("group_history_schema_invalid");
}

export function createGroupSchemaV22(database) { database.exec(GROUP_SCHEMA_V22); }

export function validateGroupSchemaV22(database) {
  for (const statement of GROUP_SCHEMA_V22.split(";").map(s => s.trim()).filter(Boolean)) {
    const name = statement.match(/^CREATE TABLE (\w+)/)[1];
    const actual = database.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name=?").get(name)?.sql;
    const canonical = sql => (sql || "").replace(/\s+/g, " ").trim();
    if (canonical(actual) !== canonical(statement)) throw groupContractError("group_schema_invalid");
  }
}

// Constructed by the canonical execution repository with its existing connection.
// It never opens a database, creates a task queue, or stores canonical task state.
export function createGroupRepository({ database, submitTaskInTransaction, cancelTaskInTransaction, readTask, readEffects, listArtifacts, readArtifactForDownload }) {
  if (!database || ![submitTaskInTransaction, cancelTaskInTransaction, readTask, readEffects].every(fn => typeof fn === "function")) {
    throw groupContractError("group_repository_dependencies_required");
  }
  const scopeArgs = actor => Object.values(groupScope(actor));
  function transaction(fn) {
    database.exec("BEGIN IMMEDIATE");
    try { const result = fn(); database.exec("COMMIT"); return result; }
    catch (error) { database.exec("ROLLBACK"); throw error; }
  }
  function row(actor, type, id, version = 0) {
    groupId(id); groupInteger(version);
    return database.prepare(`SELECT * FROM group_metadata
      WHERE tenant_scope=? AND actor_issuer=? AND actor_subject_digest=? AND entity_kind=? AND entity_id=? AND entity_version=?
    `).get(...scopeArgs(actor), type, id, version) || null;
  }
  function decode(record) {
    if (!record) return null;
    const value = TYPES[record.entity_kind].normalize(JSON.parse(record.content_json));
    if (value.tenantScope !== record.tenant_scope || value.actorIssuer !== record.actor_issuer || value.actorSubjectDigest !== record.actor_subject_digest ||
        value[TYPES[record.entity_kind].id] !== record.entity_id || (value.casRevision ?? value.revision ?? 0) !== record.revision) throw groupContractError("group_integrity_invalid");
    return value;
  }
  function read(actor, type, id, version = 0) {
    const metadata = row(actor, type, id, version);
    const value = decode(metadata);
    if (!value || type !== "run") return value;
    const bindings = database.prepare(`SELECT step_id, task_id, plan_revision, round FROM group_step_bindings
      WHERE tenant_scope=? AND actor_issuer=? AND actor_subject_digest=? AND run_id=? ORDER BY step_id
    `).all(...scopeArgs(actor), id);
    const latest = row(actor, type, id, version);
    if (!latest || latest.revision !== metadata.revision || bindings.some(binding => binding.plan_revision !== value.planRevision)) throw groupContractError("group_snapshot_conflict");
    return normalizeGroupRun({ ...value, stepBindings: bindings.map(b => ({stepId:b.step_id, taskId:b.task_id, round:b.round})) });
  }
  function readLatestGoal(actor, id) {
    groupId(id);
    const record = database.prepare(`SELECT * FROM group_metadata
      WHERE tenant_scope=? AND actor_issuer=? AND actor_subject_digest=? AND entity_kind='goal' AND entity_id=?
      ORDER BY entity_version DESC LIMIT 1`).get(...scopeArgs(actor), id);
    return decode(record);
  }
  function readGoalRevisions(actor, id, { limit = 101 } = {}) {
    groupId(id);
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 201) throw groupContractError("group_integer_invalid");
    return database.prepare(`SELECT * FROM group_metadata
      WHERE tenant_scope=? AND actor_issuer=? AND actor_subject_digest=? AND entity_kind='goal' AND entity_id=?
      ORDER BY entity_version DESC LIMIT ?`).all(...scopeArgs(actor), id, limit).reverse()
      .map(decode);
  }
  function listActiveGoalSessions(actor, { limit = 20 } = {}) {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 50) throw groupContractError("group_integer_invalid");
    return database.prepare(`SELECT content_json FROM group_metadata g
      WHERE g.tenant_scope=? AND g.actor_issuer=? AND g.actor_subject_digest=? AND g.entity_kind='goal'
        AND g.entity_version=(SELECT MAX(h.entity_version) FROM group_metadata h
          WHERE h.tenant_scope=g.tenant_scope AND h.actor_issuer=g.actor_issuer AND h.actor_subject_digest=g.actor_subject_digest
            AND h.entity_kind='goal' AND h.entity_id=g.entity_id)
        AND NOT EXISTS (SELECT 1 FROM group_history_deleted d
          WHERE d.tenant_scope=g.tenant_scope AND d.actor_issuer=g.actor_issuer AND d.actor_subject_digest=g.actor_subject_digest
            AND d.goal_id=g.entity_id)
      ORDER BY g.rowid DESC LIMIT ?`).all(...scopeArgs(actor), limit)
      .map(record => normalizeWorkGoal(JSON.parse(record.content_json)))
      .filter(goal => goal.transcriptSessionId);
  }
  function isHistoryHidden(actor, goalId) {
    groupId(goalId);
    return Boolean(database.prepare(`SELECT 1 FROM group_history_deleted
      WHERE tenant_scope=? AND actor_issuer=? AND actor_subject_digest=? AND goal_id=? LIMIT 1`
    ).get(...scopeArgs(actor), goalId));
  }
  function hasPlanOrRun(actor, goalId, goalRevision) {
    return Boolean(database.prepare(`SELECT 1 FROM group_metadata
      WHERE tenant_scope=? AND actor_issuer=? AND actor_subject_digest=? AND entity_kind IN ('plan','run')
        AND json_extract(content_json,'$.goalId')=? AND json_extract(content_json,'$.goalRevision')=? LIMIT 1`
    ).get(...scopeArgs(actor), goalId, goalRevision));
  }
  function rejectedReviewSource(actor, runId) {
    const run = read(actor, "run", runId);
    if (!run || run.cancelRequested || run.acceptance) return null;
    const plan = read(actor, "plan", run.planId, run.planRevision);
    if (!plan) return null;
    const rejected = run.stepBindings.flatMap(binding => {
      const step = plan.steps.find(step => step.stepId === binding.stepId);
      const task = readTask(binding.taskId, run.tenantScope);
      if (!step || !task || step.kind !== "review" || step.outputScope !== "group" || binding.round !== step.round ||
          task.status !== "failed" || task.lastErrorCode !== "group_review_rejected" || task.taskType !== "group_step" ||
          task.sourceSystemId !== "group_studio" || task.submissionScope !== `group:${runId}` ||
          task.employeeId !== step.employeeId || task.employeeVersion !== step.employeeVersion ||
          task.inputDigest !== groupContentDigest(step) ||
          groupContentDigest(task.executionInputRef) !== groupContentDigest(step.instructionRef)) return [];
      assertGroupScope(task, actor);
      return (listArtifacts({ tenantScope: run.tenantScope, taskId: task.taskId }) || [])
        .filter(artifact => artifact.taskId === task.taskId && artifact.employeeId === step.employeeId &&
          artifact.fileName === "group-result.md" && artifact.mimeType === "text/markdown")
        .map(artifact => ({ runId, planId: run.planId, planRevision: run.planRevision,
          reviewTaskId: task.taskId, opinionArtifactId: artifact.artifactId }));
    });
    return rejected.length === 1 ? rejected[0] : null;
  }
  function readDraftForGoal(actor, goalId, goalRevision) {
    const record = database.prepare(`SELECT * FROM group_metadata
      WHERE tenant_scope=? AND actor_issuer=? AND actor_subject_digest=? AND entity_kind='draft'
        AND json_extract(content_json,'$.goalId')=? AND json_extract(content_json,'$.goalRevision')=?
      ORDER BY rowid DESC LIMIT 1`).get(...scopeArgs(actor), goalId, goalRevision);
    return decode(record);
  }
  function requireCurrentGoalRevision(actor, goalId, goalRevision) {
    const head = readLatestGoal(actor, goalId);
    if (!head || head.revision !== goalRevision) throw groupContractError("group_goal_revision_stale");
    return head;
  }
  function findByIdempotency(actor, type, idempotencyKey) {
    const record = database.prepare(`SELECT * FROM group_metadata
      WHERE tenant_scope=? AND actor_issuer=? AND actor_subject_digest=? AND entity_kind=? AND idempotency_key=?`
    ).get(...scopeArgs(actor), type, idempotencyKey);
    return decode(record);
  }

  function put(actor, type, input) {
    const definition = TYPES[type];
    const item = definition.normalize(input);
    assertGroupScope(item, actor);
    if (type === "run" && (item.stepBindings.length || item.casRevision !== 0 || item.cancelRequested || item.acceptance)) throw groupContractError("group_initial_run_invalid");
    const version = definition.version ? item[definition.version] : 0;
    const idempotencyKey = type === "question" ? item.messageId : item.idempotencyKey;
    const digest = groupContentDigest(item);
    const duplicate = database.prepare(`SELECT * FROM group_metadata
      WHERE tenant_scope=? AND actor_issuer=? AND actor_subject_digest=? AND entity_kind=? AND idempotency_key=?
    `).get(...scopeArgs(actor), type, idempotencyKey);
    if (duplicate) {
      if (duplicate.creation_digest !== digest) throw groupContractError("group_idempotency_conflict");
      if (["plan", "draft", "run"].includes(type)) requireCurrentGoalRevision(actor, item.goalId, item.goalRevision);
      return read(actor, type, duplicate.entity_id, duplicate.entity_version);
    }
    if (row(actor, type, item[definition.id], version)) throw groupContractError("group_entity_exists");
    if (["plan", "draft"].includes(type)) {
      const bindingsExist = database.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='work_goal_task_bindings'").get();
      if (bindingsExist && database.prepare(`SELECT 1 FROM work_goal_task_bindings
        WHERE tenant_scope=? AND actor_issuer=? AND actor_subject_digest=? AND goal_id=? AND binding_kind='initial'`)
        .get(...scopeArgs(actor), item.goalId)) throw groupContractError("group_direct_goal_plan_denied");
      requireCurrentGoalRevision(actor, item.goalId, item.goalRevision);
      validatePlanRefs(actor, item);
    }
    if (type === "run") {
      requireCurrentGoalRevision(actor, item.goalId, item.goalRevision);
      const plan = read(actor, "plan", item.planId, item.planRevision);
      if (!plan || plan.goalId !== item.goalId || plan.goalRevision !== item.goalRevision || plan.groupId !== item.groupId || plan.groupVersion !== item.groupVersion) throw groupContractError("group_plan_reference_invalid");
      const goal = read(actor, "goal", item.goalId, item.goalRevision);
      if (goal?.phase !== "adopted") throw groupContractError("group_goal_not_adopted");
    }
    database.prepare(`INSERT INTO group_metadata VALUES(?,?,?,?,?,?,?,?,?,?)`).run(
      ...scopeArgs(actor), type, item[definition.id], version, item.casRevision ?? item.revision ?? 0,
      idempotencyKey, digest, JSON.stringify(item),
    );
    return item;
  }
  function validatePlanRefs(actor, plan) {
    const group = read(actor, "version", plan.groupId, plan.groupVersion);
    const goal = read(actor, "goal", plan.goalId, plan.goalRevision);
    if (!group || !goal) throw groupContractError("group_plan_reference_invalid");
    const goalInputRefs = new Map((goal.inputRefs || []).map((ref) => [ref.refId, ref]));
    for (const ref of plan.inputRefs || []) {
      const goalRef = goalInputRefs.get(ref.refId);
      if (!goalRef || goalRef.version !== ref.version || goalRef.scope !== ref.scope) throw groupContractError("group_input_reference_scope_invalid");
    }
    if (groupContentDigest(plan.reviewerGroup || null) !== groupContentDigest(group.reviewerGroup || null)) throw groupContractError("group_reviewer_policy_mismatch");
    if (Object.keys(plan.budget).some(key => plan.budget[key] > goal.budget[key])) throw groupContractError("group_budget_exceeded");
    for (const step of plan.steps) {
      if (!group.members.some(m => m.employeeId === step.employeeId && m.employeeVersion === step.employeeVersion)) throw groupContractError("group_member_version_invalid");
    }
  }
  function updateRunInTransaction(actor, run, expectedRevision, patch) {
    if (run.casRevision !== expectedRevision) throw groupContractError("group_revision_conflict");
    const updated = normalizeGroupRun({ ...run, ...patch, casRevision: expectedRevision + 1, stepBindings: [] });
    const result = database.prepare(`UPDATE group_metadata SET content_json=?, revision=?
      WHERE tenant_scope=? AND actor_issuer=? AND actor_subject_digest=? AND entity_kind='run' AND entity_id=? AND entity_version=0 AND revision=?
    `).run(JSON.stringify(updated), updated.casRevision, ...scopeArgs(actor), run.runId, expectedRevision);
    if (result.changes !== 1) throw groupContractError("group_revision_conflict");
    return read(actor, "run", run.runId);
  }
  function requireRun(actor, runId) {
    const run = read(actor, "run", runId);
    if (!run) throw groupContractError("group_run_not_found");
    return run;
  }
  function requiredStepFailure(run) {
    const plan = read(run, "plan", run.planId, run.planRevision);
    if (!plan) throw groupContractError("group_plan_not_found");
    const requiredStepIds = new Set(requiredGroupExecutionStepIds(plan));
    for (const step of plan.steps) {
      if (!requiredStepIds.has(step.stepId)) continue;
      const binding = run.stepBindings.find(item => item.stepId === step.stepId);
      if (!binding) continue;
      const task = readTask(binding.taskId, run.tenantScope);
      if (!task) throw groupContractError("group_integrity_invalid");
      if (task.status !== "completed" && EXECUTION_TASK_TERMINAL_STATUSES.includes(task.status)) return step.stepId;
    }
    return null;
  }
  function submitStep({ actor, runId, stepId, expectedRevision, submission }) {
    return transaction(() => {
      const run = requireRun(actor, runId);
      const plan = read(actor, "plan", run.planId, run.planRevision);
      const step = plan.steps.find(s => s.stepId === stepId);
      if (!step) throw groupContractError("group_step_not_found");
      assertGroupScope(submission, actor);
      const key = groupContentDigest({ ...groupScope(actor), runId, planId: run.planId, planRevision: run.planRevision, stepId, round: step.round });
      if (submission.taskId !== `group_task_${key}` || submission.idempotencyKey !== key || submission.submissionScope !== `group:${runId}` ||
          submission.employeeId !== step.employeeId || submission.employeeVersion !== step.employeeVersion || submission.sessionId != null ||
          submission.taskType !== "group_step" || submission.sourceSystemId !== "group_studio" || groupContentDigest(submission.executionInputRef) !== groupContentDigest(step.instructionRef)) throw groupContractError("group_task_binding_invalid");
      const existing = run.stepBindings.find(b => b.stepId === stepId);
      if (existing) {
        const result = submitTaskInTransaction(submission);
        if (existing.taskId !== result.task.taskId) throw groupContractError("group_task_binding_invalid");
        return { run, task: result.task, created: false };
      }
      if (run.casRevision !== expectedRevision) throw groupContractError("group_revision_conflict");
      if (run.cancelRequested || run.activation !== "active") throw groupContractError("group_run_inactive");
      if (run.stepBindings.length >= plan.budget.maxSteps) throw groupContractError("group_budget_exceeded");
      const tasks = run.stepBindings.map(b => readTask(b.taskId, run.tenantScope));
      if (tasks.some(task => !task)) throw groupContractError("group_integrity_invalid");
      if (tasks.some(task => readEffects({tenantScope:run.tenantScope, taskId:task.taskId})?.effectState === "reconcile_required")) throw groupContractError("group_reconcile_required");
      if (requiredStepFailure(run)) throw groupContractError("group_required_step_failed");
      if (tasks.filter(task => ["queued", "waiting", "running"].includes(task.status)).length >= plan.budget.maxParallel) throw groupContractError("group_parallel_limit");
      const taskFor = id => tasks.find(task => task.taskId === run.stepBindings.find(b => b.stepId === id)?.taskId);
      if (step.dependsOn.some(id => taskFor(id)?.status !== "completed") || step.optionalDependsOn.some(id => !["completed","failed","blocked","lost","rejected","canceled","timed_out"].includes(taskFor(id)?.status))) throw groupContractError("group_dependency_not_ready");
      const result = submitTaskInTransaction(submission);
      database.prepare(`INSERT INTO group_step_bindings
        (tenant_scope,actor_issuer,actor_subject_digest,run_id,plan_revision,step_id,round,task_id) VALUES(?,?,?,?,?,?,?,?)
      `).run(...scopeArgs(actor), runId, run.planRevision, stepId, step.round, result.task.taskId);
      const updated = updateRunInTransaction(actor, run, expectedRevision, {});
      return { run: updated, task: result.task, created: result.created };
    });
  }
  function cancelRun({ actor, runId, expectedRevision }) {
    return transaction(() => {
      const run = requireRun(actor, runId);
      if (run.acceptance) throw groupContractError("group_run_closed");
      if (run.cancelRequested) return run;
      if (run.casRevision !== expectedRevision) throw groupContractError("group_revision_conflict");
      for (const binding of run.stepBindings) cancelTaskInTransaction({tenantScope:run.tenantScope, taskId:binding.taskId, reasonCode:"group_cancel_requested"});
      return updateRunInTransaction(actor, run, expectedRevision, {cancelRequested:true, activation:"closed"});
    });
  }
  function acceptDelivery({ actor, runId, expectedRevision, goalId, deliveryDigest, decision, now = new Date().toISOString() }) {
    return transaction(() => {
      const run = requireRun(actor, runId);
      if (goalId !== run.goalId) throw groupContractError("group_delivery_changed");
      if (run.acceptance) {
        if (run.acceptance.deliveryDigest !== deliveryDigest || run.acceptance.decision !== decision) throw groupContractError("group_acceptance_conflict");
        return run;
      }
      if (run.casRevision !== expectedRevision) throw groupContractError("group_revision_conflict");
      const plan = read(actor, "plan", run.planId, run.planRevision);
      const taskRepository = { get: (id, { tenantScope }) => readTask(id, tenantScope), summarizeOperationReceipts: readEffects, listArtifacts, readArtifactForDownload };
      const delivery = readGroupDelivery({ actor, run, plan, taskRepository });
      if (delivery.deliveryDigest !== deliveryDigest) throw groupContractError("group_delivery_changed");
      assertGroupDeliveryAvailable({ actor, delivery, taskRepository, now });
      return updateRunInTransaction(actor, run, expectedRevision, { activation: "closed", acceptance: { decision, deliveryDigest, decidedAt: now } });
    });
  }
  function answerQuestion({ actor, questionId, expectedRevision, answerRef, messageId, now = new Date().toISOString() }) {
    return transaction(() => {
      const question = read(actor, "question", questionId);
      if (!question) throw groupContractError("group_question_not_found");
      if (question.casRevision !== expectedRevision || question.status !== "open") throw groupContractError("group_question_revision_conflict");
      const updated = normalizeGroupQuestion({ ...question, messageId: groupId(messageId), replyTo: question.questionId, answerRef, status: "answered", casRevision: expectedRevision + 1 });
      const result = database.prepare(`UPDATE group_metadata SET content_json=?, revision=?, creation_digest=?
        WHERE tenant_scope=? AND actor_issuer=? AND actor_subject_digest=? AND entity_kind='question' AND entity_id=? AND entity_version=0 AND revision=?`).run(
        JSON.stringify(updated), updated.casRevision, groupContentDigest(updated), ...scopeArgs(actor), question.questionId, expectedRevision);
      if (result.changes !== 1) throw groupContractError("group_question_revision_conflict");
      return read(actor, "question", question.questionId);
    });
  }

  function setActivation({ actor, runId, expectedRevision, activation }) {
    return transaction(() => {
      const run = requireRun(actor, runId);
      if (run.cancelRequested || run.activation === "closed") throw groupContractError("group_run_closed");
      if (!["paused", "active", "resume_required"].includes(activation)) throw groupContractError("group_activation_invalid");
      if (activation === "active" && run.stepBindings.some(binding => readEffects({tenantScope:run.tenantScope, taskId:binding.taskId})?.effectState === "reconcile_required")) throw groupContractError("group_reconcile_required");
      if (activation === "active" && requiredStepFailure(run)) throw groupContractError("group_required_step_failed");
      return updateRunInTransaction(actor, run, expectedRevision, {activation});
    });
  }
  function requireResumeAfterRestart() {
    return transaction(() => {
      const rows = database.prepare("SELECT * FROM group_metadata WHERE entity_kind='run'").all();
      let changed = 0;
      for (const row of rows) {
        const run = decode(row);
        if (run.activation !== "active" || run.cancelRequested) continue;
        updateRunInTransaction(run, run, run.casRevision, {activation:"resume_required"});
        changed += 1;
      }
      return {changed};
    });
  }
  function reserveContinuation({ actor, expectedGoalRevision, goal, groupVersion }) {
    return transaction(() => {
      const nextGoal = normalizeWorkGoal(goal);
      const nextVersion = normalizeGroupVersion(groupVersion);
      assertGroupScope(nextGoal, actor); assertGroupScope(nextVersion, actor);
      const existing = findByIdempotency(actor, "goal", nextGoal.idempotencyKey);
      if (existing) {
        if (groupContentDigest(existing) !== groupContentDigest(nextGoal) || readLatestGoal(actor, nextGoal.goalId)?.revision !== existing.revision) throw groupContractError("group_goal_revision_stale");
        const existingVersion = read(actor, "version", nextVersion.groupId, nextVersion.version);
        if (!existingVersion || groupContentDigest(existingVersion) !== groupContentDigest(nextVersion)) throw groupContractError("group_idempotency_conflict");
        return { goal: existing, groupVersion: existingVersion, created: false };
      }
      const head = requireCurrentGoalRevision(actor, nextGoal.goalId, expectedGoalRevision);
      if (hasPlanOrRun(actor, head.goalId, head.revision)) {
        const source = nextGoal.reworkSource && rejectedReviewSource(actor, nextGoal.reworkSource.runId);
        const run = source && read(actor, "run", source.runId);
        if (!source || groupContentDigest(source) !== groupContentDigest(nextGoal.reworkSource) ||
            run.goalId !== head.goalId || run.goalRevision !== head.revision ||
            run.groupId !== nextVersion.groupId || run.groupVersion !== nextVersion.version - 1 ||
            head.planningContext?.groupId !== run.groupId || head.planningContext?.groupVersion !== run.groupVersion ||
            groupContentDigest(nextVersion.reviewerGroup || null) !== groupContentDigest(read(actor, "version", run.groupId, run.groupVersion)?.reviewerGroup || null)) {
          throw groupContractError("group_rework_source_invalid");
        }
      } else if (nextGoal.reworkSource || head.reworkSource) {
        const source = head.reworkSource && rejectedReviewSource(actor, head.reworkSource.runId);
        const sourceRun = source && read(actor, "run", source.runId);
        if (!source || groupContentDigest(source) !== groupContentDigest(nextGoal.reworkSource || null) ||
            groupContentDigest(source) !== groupContentDigest(head.reworkSource) || sourceRun.goalId !== head.goalId ||
            sourceRun.goalRevision >= head.revision || sourceRun.groupId !== nextVersion.groupId ||
            nextVersion.groupId !== head.planningContext?.groupId || nextVersion.version !== head.planningContext?.groupVersion + 1 ||
            groupContentDigest(nextVersion.reviewerGroup || null) !== groupContentDigest(read(actor, "version", nextVersion.groupId, head.planningContext.groupVersion)?.reviewerGroup || null)) {
          throw groupContractError("group_rework_source_invalid");
        }
      }
      if (nextGoal.revision !== head.revision + 1 || nextVersion.version < 2) throw groupContractError("group_revision_conflict");
      return { goal: put(actor, "goal", nextGoal), groupVersion: put(actor, "version", nextVersion), created: true };
    });
  }

  return Object.freeze({
    requireResumeAfterRestart,
    deleteHistory: (actor, goalId) => transaction(() => {
      groupId(goalId);
      const owned = database.prepare("SELECT 1 FROM group_metadata WHERE tenant_scope=? AND actor_issuer=? AND actor_subject_digest=? AND entity_kind='goal' AND entity_id=?").get(...scopeArgs(actor), goalId);
      if (!owned) throw groupContractError("group_history_not_found");
      database.prepare("INSERT OR IGNORE INTO group_history_deleted VALUES (?,?,?,?)").run(...scopeArgs(actor), goalId);
      return { goalId };
    }),
    listHistory: (actor) => database.prepare(`SELECT * FROM group_metadata
      WHERE tenant_scope=? AND actor_issuer=? AND actor_subject_digest=?
        AND entity_kind IN ('run','draft','goal')
        AND NOT EXISTS (SELECT 1 FROM group_history_deleted h WHERE h.tenant_scope=group_metadata.tenant_scope
          AND h.actor_issuer=group_metadata.actor_issuer AND h.actor_subject_digest=group_metadata.actor_subject_digest
          AND h.goal_id=json_extract(group_metadata.content_json,'$.goalId'))
        AND (entity_kind='run' OR NOT EXISTS (
          SELECT 1 FROM group_metadata r WHERE r.tenant_scope=group_metadata.tenant_scope
          AND r.actor_issuer=group_metadata.actor_issuer AND r.actor_subject_digest=group_metadata.actor_subject_digest
          AND r.entity_kind='run' AND json_extract(r.content_json,'$.planId')=group_metadata.entity_id))
        AND (entity_kind!='draft' OR NOT EXISTS (
          SELECT 1 FROM group_metadata g WHERE g.tenant_scope=group_metadata.tenant_scope
          AND g.actor_issuer=group_metadata.actor_issuer AND g.actor_subject_digest=group_metadata.actor_subject_digest
          AND g.entity_kind='goal' AND g.entity_id=json_extract(group_metadata.content_json,'$.goalId')
          AND g.entity_version>json_extract(group_metadata.content_json,'$.goalRevision')))
        AND (entity_kind!='goal' OR (entity_version=(SELECT MAX(g.entity_version) FROM group_metadata g WHERE g.tenant_scope=group_metadata.tenant_scope AND g.actor_issuer=group_metadata.actor_issuer AND g.actor_subject_digest=group_metadata.actor_subject_digest AND g.entity_kind='goal' AND g.entity_id=group_metadata.entity_id) AND NOT EXISTS (SELECT 1 FROM group_metadata d WHERE d.tenant_scope=group_metadata.tenant_scope AND d.actor_issuer=group_metadata.actor_issuer AND d.actor_subject_digest=group_metadata.actor_subject_digest AND d.entity_kind IN ('draft','run') AND json_extract(d.content_json,'$.goalId')=group_metadata.entity_id AND json_extract(d.content_json,'$.goalRevision')=group_metadata.entity_version)))
      ORDER BY rowid DESC LIMIT 50`).all(...scopeArgs(actor))
      .map(record => ({ kind: record.entity_kind, value: read(actor, record.entity_kind, record.entity_id, record.entity_version) })),
    createGoal: (actor, value) => transaction(() => put(actor,"goal",value)),
    createGoalInTransaction: (actor, value) => {
      if (!database.isTransaction) throw groupContractError("group_transaction_required");
      return put(actor, "goal", value);
    },
    createGroupVersion: (actor, value) => transaction(() => put(actor,"version",value)),
    createPlan: (actor, value) => transaction(() => put(actor,"plan",value)),
    createDraft: (actor, value) => transaction(() => put(actor,"draft",value)),
    createRun: (actor, value) => transaction(() => put(actor,"run",value)),
    reserveContinuation,
    readLatestGoal,
    readGoalRevisions,
    listActiveGoalSessions,
    isHistoryHidden,
    hasPlanOrRun,
    hasPlanningForGoal: (actor, goalId) => {
      groupId(goalId);
      return Boolean(database.prepare(`SELECT 1 FROM group_metadata
        WHERE tenant_scope=? AND actor_issuer=? AND actor_subject_digest=?
          AND entity_kind IN ('draft','plan','run') AND json_extract(content_json,'$.goalId')=? LIMIT 1`)
        .get(...scopeArgs(actor), goalId));
    },
    rejectedReviewSource,
    readDraftForGoal,
    createQuestion: (actor, value) => transaction(() => {
      const run = read(actor, "run", value.runId);
      if (!run || run.planRevision !== value.planRevision) throw groupContractError("group_question_run_revision_invalid");
      return put(actor, "question", value);
    }),
    readGoal: (actor,id,revision) => read(actor,"goal",id,revision),
    readGroupVersion: (actor,id,version) => read(actor,"version",id,version),
    readDraft: (actor,id,revision) => read(actor,"draft",id,revision),
    readPlan: (actor,id,revision) => read(actor,"plan",id,revision),
    readRun: (actor,id) => read(actor,"run",id),
    readQuestion: (actor,id) => read(actor,"question",id),
    readRequiredStepFailure: (actor, runId) => requiredStepFailure(requireRun(actor, runId)),
    submitStep, cancelRun, setActivation, answerQuestion, acceptDelivery,
  });
}
