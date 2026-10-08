import { EXECUTION_TASK_CONTRACT_VERSION, EXECUTION_TASK_TERMINAL_STATUSES } from "./runtime-task-contract-v1.mjs";
import { GROUP_EXECUTION_CONTEXT_CODES } from "./group-execution-errors.mjs";
import {
  assertGroupScope, groupContentDigest, groupContractError, groupFreeze, groupId, groupScope,
} from "./group-contracts-v1.mjs";
import { taskMaterialBindingDescriptorDigest } from "./task-material-binding.mjs";

const GROUP_EXECUTION_CONTEXT_CONTRACT = "group-execution-context.v1";
const TASK_BINDING_FIELDS = [
  "contractVersion", "taskId", "tenantScope", "actorIssuer", "actorSubjectDigest", "employeeId",
  "employeeVersion", "sessionId", "sourceSystemId", "channelId", "taskType", "submissionScope",
  "idempotencyKey", "inputDigest",
];
const TERMINAL = new Set(EXECUTION_TASK_TERMINAL_STATUSES);

// Resolves metadata from the existing canonical repository. This does not
// dereference material, grant Tool access, acquire a lease, or execute a model.
export function createGroupExecutionContext({ taskRepository, authorizeTask, resolveStepMaterialBindings = null, readTaskMaterialBindings = null } = {}) {
  if (!["get", "summarizeOperationReceipts", "listArtifacts"].every(name => typeof taskRepository?.[name] === "function") ||
    !["readRun", "readPlan", "readGoal", "readGroupVersion"].every(name => typeof taskRepository?.groups?.[name] === "function") ||
    typeof authorizeTask !== "function") {
    throw new TypeError("group execution context requires canonical repository and authorization");
  }
  const groups = taskRepository.groups;
  if (resolveStepMaterialBindings !== null && typeof resolveStepMaterialBindings !== "function") {
    throw new TypeError("group execution material resolver invalid");
  }

  async function snapshot(task, actor, session = null) {
    const stored = taskRepository.get(task.taskId, { tenantScope: actor.tenantScope });
    if (!stored || TASK_BINDING_FIELDS.some(field => stored[field] !== task[field]) ||
      groupContentDigest(stored.executionInputRef) !== groupContentDigest(task.executionInputRef)) {
      throw groupContractError("group_execution_task_mismatch");
    }
    assertGroupScope(stored, actor);
    if (TERMINAL.has(stored.status) || stored.cancelRequested) throw groupContractError("group_execution_task_inactive");
    const runId = groupId(stored.submissionScope.startsWith("group:") ? stored.submissionScope.slice(6) : "");
    const run = groups.readRun(actor, runId);
    if (!run) throw groupContractError("group_execution_context_unavailable");
    assertGroupScope(run, actor);
    if (run.cancelRequested || run.activation !== "active") throw groupContractError("group_execution_run_inactive");
    const plan = groups.readPlan(actor, run.planId, run.planRevision);
    if (!plan || plan.planId !== run.planId || plan.revision !== run.planRevision ||
      plan.groupId !== run.groupId || plan.groupVersion !== run.groupVersion ||
      plan.goalId !== run.goalId || plan.goalRevision !== run.goalRevision) {
      throw groupContractError("group_execution_plan_mismatch");
    }
    assertGroupScope(plan, actor);
    // Task identity, not a potentially shared instruction ref, owns step selection.
    const binding = run.stepBindings.find(item => item.taskId === stored.taskId);
    const step = binding && plan.steps.find(item => item.stepId === binding.stepId);
    if (!step || binding.round !== step.round) throw groupContractError("group_execution_binding_invalid");
    if (step.inputRefIds?.length) {
      if (!resolveStepMaterialBindings || typeof readTaskMaterialBindings !== "function") {
        throw groupContractError("group_material_binding_resolver_unavailable");
      }
      const resolved = await resolveStepMaterialBindings({ actor, session, run, plan, step });
      const stored = readTaskMaterialBindings(task.taskId, { tenantScope: actor.tenantScope });
      const expected = (resolved || []).map(taskMaterialBindingDescriptorDigest).sort();
      const actual = (stored || []).map((item) => item.descriptorDigest).sort();
      if (!expected.length || expected.length !== actual.length || expected.some((digest, index) => digest !== actual[index])) {
        throw groupContractError("group_material_binding_resolution_failed");
      }
    }
    const key = groupContentDigest({ ...groupScope(actor), runId, planId: plan.planId,
      planRevision: plan.revision, stepId: step.stepId, round: step.round });
    if (stored.taskId !== `group_task_${key}` || stored.idempotencyKey !== key || stored.sessionId !== null ||
      stored.employeeId !== step.employeeId || stored.employeeVersion !== step.employeeVersion ||
      stored.inputDigest !== groupContentDigest(step) ||
      groupContentDigest(stored.executionInputRef) !== groupContentDigest(step.instructionRef)) {
      throw groupContractError("group_execution_binding_invalid");
    }
    const goal = groups.readGoal(actor, run.goalId, run.goalRevision);
    const group = groups.readGroupVersion(actor, run.groupId, run.groupVersion);
    if (!goal || !group || goal.phase !== "adopted" || goal.goalId !== run.goalId || goal.revision !== run.goalRevision ||
      group.groupId !== run.groupId || group.version !== run.groupVersion ||
      !group.members.some(member => member.employeeId === step.employeeId && member.employeeVersion === step.employeeVersion)) {
      throw groupContractError("group_execution_context_unavailable");
    }
    assertGroupScope(goal, actor);
    assertGroupScope(group, actor);
    if (groupContentDigest(plan.reviewerGroup || null) !== groupContentDigest(group.reviewerGroup || null)) {
      throw groupContractError("group_execution_plan_mismatch");
    }
    const tasks = run.stepBindings.map(item => taskRepository.get(item.taskId, { tenantScope: actor.tenantScope }));
    if (tasks.some(item => !item)) throw groupContractError("group_execution_task_mismatch");
    for (const item of tasks) {
      assertGroupScope(item, actor);
      const effect = taskRepository.summarizeOperationReceipts({ tenantScope: actor.tenantScope, taskId: item.taskId });
      if (!effect) throw groupContractError("group_execution_task_mismatch");
      if (effect.effectState === "reconcile_required") throw groupContractError("group_reconcile_required");
    }
    const dependencyTask = id => tasks.find(item => item.taskId === run.stepBindings.find(b => b.stepId === id)?.taskId);
    if (step.dependsOn.some(id => dependencyTask(id)?.status !== "completed") ||
      step.optionalDependsOn.some(id => !TERMINAL.has(dependencyTask(id)?.status))) {
      throw groupContractError("group_dependency_not_ready");
    }
    // Shared outputs are discovered through the Group Artifact Tool. Keep the
    // explicit handoff contract intact and never fan out every task Artifact
    // into a summary step's dependency context (which would expose private
    // task outputs and freeze a stale catalog into the context digest).
    const dependencyRefs = step.inputArtifactIds.map(refId => ({ kind: "artifact_ref", refId }));
    return { run, plan, step, goal, group, dependencyRefs };
  }

  return Object.freeze({
    contractVersion: GROUP_EXECUTION_CONTEXT_CONTRACT,
    async resolve({ task, actor, session = null } = {}) {
      if (task?.taskType !== "group_step") return null;
      if (task.sourceSystemId !== "group_studio" || task.contractVersion !== EXECUTION_TASK_CONTRACT_VERSION) {
        throw groupContractError("group_execution_task_invalid");
      }
      const scope = groupScope(actor);
      assertGroupScope(task, scope);
      groupId(task.taskId);
      let initial;
      try { initial = await snapshot(task, scope, session); }
      catch (error) { throw safeError(error); }
      let allowed;
      try { allowed = await authorizeTask({ actor: scope, task, ...initial }); }
      catch { throw groupContractError("group_execution_authorization_unavailable"); }
      if (allowed !== true) throw groupContractError("group_execution_authorization_denied");
      // Authorization may yield while cancellation/restart/plan changes commit.
      let current;
      try { current = await snapshot(task, scope, session); }
      catch (error) { throw safeError(error); }
      // Sibling admission advances Run CAS without changing this task's pinned
      // inputs. Both snapshots still check live cancellation, grants and effects.
      const pinnedDigest = ({ plan, step, goal, group, dependencyRefs }) =>
        groupContentDigest({ plan, step, goal, group, dependencyRefs });
      if (pinnedDigest(current) !== pinnedDigest(initial)) throw groupContractError("group_snapshot_conflict");
      const { run, plan, step, goal, dependencyRefs } = current;
      const reviewerSkillBinding = step.kind === "review" && plan.reviewerGroup?.members.some(member =>
        member.employeeId === step.employeeId && member.employeeVersion === step.employeeVersion)
        ? current.group.reviewerSkillBinding : null;
      return groupFreeze({
        contractVersion: GROUP_EXECUTION_CONTEXT_CONTRACT, ...scope, taskId: task.taskId,
        runId: run.runId, groupId: run.groupId, groupVersion: run.groupVersion,
        goalId: goal.goalId, goalRevision: goal.revision, objectiveRef: goal.objectiveRef, objectiveDigest: goal.objectiveDigest,
        planId: plan.planId, planRevision: plan.revision, instructionRevision: plan.instructionRevision,
        stepId: step.stepId, stepKind: step.kind, round: step.round, employeeId: step.employeeId, employeeVersion: step.employeeVersion,
        instructionRef: step.instructionRef,
        dependencyRefs,
        ...(reviewerSkillBinding ? { reviewerSkillBinding } : {}),
        budget: plan.budget, completionConditions: step.completionConditions,
      });
    },
  });
}

function safeError(error) {
  // Do not forward arbitrary repository or adapter exception codes/messages.
  return groupContractError(GROUP_EXECUTION_CONTEXT_CODES.includes(error?.code) ? error.code : "group_execution_context_unavailable");
}

export { GROUP_EXECUTION_CONTEXT_CONTRACT };
