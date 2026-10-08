import { EXECUTION_TASK_CONTRACT_VERSION } from "./runtime-task-contract-v1.mjs";
import { groupContentDigest, groupId } from "./group-contracts-v1.mjs";

function createGroupArtifactDeliveryAuthorizer({ taskRepository } = {}) {
  if (typeof taskRepository?.get !== "function" ||
    !["readRun", "readPlan", "readGroupVersion"].every(name => typeof taskRepository?.groups?.[name] === "function")) {
    throw new TypeError("group artifact delivery authorizer requires canonical repository");
  }
  const groups = taskRepository.groups;

  async function authorize({ employeeId = "", route = null, taskContext = null, taskId = "" } = {}) {
    try {
      if (!route || taskContext?.channelId !== "desktop" || taskContext.sessionId !== null) return false;
      const task = taskRepository.get(taskId, { tenantScope: route.tenantScope });
      if (!task || task.status !== "completed" || task.contractVersion !== EXECUTION_TASK_CONTRACT_VERSION ||
        task.taskType !== "group_step" || task.sourceSystemId !== "group_studio" || task.channelId !== "desktop" ||
        task.sessionId !== null || task.taskId !== taskId || task.employeeId !== employeeId ||
        task.tenantScope !== route.tenantScope || task.actorIssuer !== route.actorIssuer ||
        task.actorSubjectDigest !== route.actorSubjectDigest || !task.submissionScope.startsWith("group:")) return false;

      const runId = groupId(task.submissionScope.slice(6));
      const actor = {
        tenantScope: route.tenantScope,
        actorIssuer: route.actorIssuer,
        actorSubjectDigest: route.actorSubjectDigest,
      };
      const run = groups.readRun(actor, runId);
      if (!run || run.runId !== runId || run.planId == null || run.planRevision == null) return false;
      const plan = groups.readPlan(actor, run.planId, run.planRevision);
      if (!plan || plan.planId !== run.planId || plan.revision !== run.planRevision ||
        plan.groupId !== run.groupId || plan.groupVersion !== run.groupVersion ||
        plan.goalId !== run.goalId || plan.goalRevision !== run.goalRevision) return false;
      const binding = run.stepBindings.find(item => item.taskId === task.taskId);
      const step = binding && plan.steps.find(item => item.stepId === binding.stepId);
      if (!step || binding.round !== step.round || step.employeeId !== task.employeeId ||
        String(step.employeeVersion) !== String(task.employeeVersion)) return false;
      const group = groups.readGroupVersion(actor, run.groupId, run.groupVersion);
      if (!group || group.groupId !== run.groupId || group.version !== run.groupVersion ||
        !group.members.some(member => member.employeeId === task.employeeId &&
          String(member.employeeVersion) === String(task.employeeVersion))) return false;

      const key = groupContentDigest({ ...actor, runId, planId: plan.planId,
        planRevision: plan.revision, stepId: step.stepId, round: step.round });
      return task.taskId === `group_task_${key}` && task.idempotencyKey === key &&
        task.inputDigest === groupContentDigest(step) &&
        groupContentDigest(task.executionInputRef) === groupContentDigest(step.instructionRef);
    } catch {
      return false;
    }
  }

  return Object.freeze({ authorize });
}

export { createGroupArtifactDeliveryAuthorizer };
