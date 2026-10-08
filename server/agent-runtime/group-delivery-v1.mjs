import { assertGroupScope, groupContentDigest, groupContractError } from "./group-contracts-v1.mjs";

// A delivery is a snapshot of existing canonical tasks and immutable Artifact refs.
// No task state, output body, or second Artifact store is created here.
export function readGroupDelivery({ actor, run, plan, taskRepository }) {
  assertGroupScope(run, actor); assertGroupScope(plan, actor);
  if (run.cancelRequested || plan.goalId !== run.goalId || plan.goalRevision !== run.goalRevision ||
      plan.planId !== run.planId || plan.revision !== run.planRevision || plan.groupId !== run.groupId || plan.groupVersion !== run.groupVersion) {
    throw groupContractError("group_delivery_unavailable");
  }
  const steps = plan.steps.map(step => {
    const binding = run.stepBindings.find(item => item.stepId === step.stepId);
    const task = binding && taskRepository.get(binding.taskId, { tenantScope: run.tenantScope });
    if (!task || task.status !== "completed" || task.employeeId !== step.employeeId || task.employeeVersion !== step.employeeVersion ||
        binding.round !== step.round || task.taskType !== "group_step" || task.sourceSystemId !== "group_studio" ||
        task.submissionScope !== `group:${run.runId}` || task.inputDigest !== groupContentDigest(step) ||
        groupContentDigest(task.executionInputRef) !== groupContentDigest(step.instructionRef) ||
        taskRepository.summarizeOperationReceipts({ tenantScope: run.tenantScope, taskId: task.taskId })?.effectState === "reconcile_required") {
      throw groupContractError("group_delivery_unavailable");
    }
    assertGroupScope(task, actor);
    const artifacts = taskRepository.listArtifacts({ tenantScope: run.tenantScope, taskId: task.taskId })
      .filter(item => item.taskId === task.taskId && item.employeeId === step.employeeId)
      .map(({ artifactId, taskId, employeeId, sha256, sizeBytes }) => ({ artifactId, taskId, employeeId, sha256, sizeBytes }))
      .sort((a, b) => a.artifactId.localeCompare(b.artifactId));
    if (step.kind === "summary" && !artifacts.length) throw groupContractError("group_delivery_unavailable");
    return { stepId: step.stepId, taskId: task.taskId, taskRevision: task.revision, artifacts };
  });
  if (!plan.steps.some(step => step.kind === "summary") || !steps.some(step => step.artifacts.length)) throw groupContractError("group_delivery_unavailable");
  const snapshot = { goalId: run.goalId, goalRevision: run.goalRevision, runId: run.runId,
    planId: plan.planId, planRevision: plan.revision, groupId: run.groupId, groupVersion: run.groupVersion,
    reviewerPolicyDigest: groupContentDigest(plan.reviewerGroup || null), steps };
  return { ...snapshot, deliveryDigest: groupContentDigest(snapshot) };
}

export function assertGroupDeliveryAvailable({ actor, delivery, taskRepository, now }) {
  for (const artifact of delivery.steps.flatMap(step => step.artifacts)) {
    const record = taskRepository.readArtifactForDownload({ ...actor, ...artifact });
    if (!record || record.taskStatus !== "completed" || record.retiredAt || record.objectState !== "present" ||
        record.artifact.sha256 !== artifact.sha256 || record.objectSizeBytes !== artifact.sizeBytes ||
        new Date(now).toISOString() >= record.artifact.expiresAt) throw groupContractError("group_delivery_unavailable");
  }
}
