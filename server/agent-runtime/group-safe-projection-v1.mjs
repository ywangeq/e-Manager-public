import { readGroupDelivery, assertGroupDeliveryAvailable } from "./group-delivery-v1.mjs";
import { safeGroupExecutionErrorCode } from "./group-execution-errors.mjs";
import {
  assertGroupScope, groupContractError, groupFreeze, normalizeGroupRun, normalizeGroupPlan,
  requiredGroupExecutionStepIds,
} from "./group-contracts-v1.mjs";
import { normalizeRuntimeSafeActivitySnapshot } from "./runtime-safe-activity-contract-v1.mjs";

const TASK_STATES = new Set(["queued", "running", "waiting", "completed", "failed", "blocked", "rejected", "canceled", "timed_out", "lost"]);

export function projectGroupRunSafe({run: input, plan: planInput, actor, taskRepository, stepObjectives = {}, now = new Date()}) {
  const run = normalizeGroupRun(input), plan = normalizeGroupPlan(planInput);
  assertGroupScope(run, actor);
  assertGroupScope(plan, actor);
  if (run.planId !== plan.planId || run.planRevision !== plan.revision || run.groupId !== plan.groupId || run.groupVersion !== plan.groupVersion) throw groupContractError("group_plan_reference_invalid");
  if (typeof taskRepository?.get !== "function" || typeof taskRepository?.summarizeOperationReceipts !== "function") throw groupContractError("group_projection_authority_required");
  if (!stepObjectives || typeof stepObjectives !== "object" || Array.isArray(stepObjectives) ||
    Object.entries(stepObjectives).some(([id, value]) => !plan.steps.some(step => step.stepId === id) ||
      typeof value !== "string" || !value.trim() || value.length > 600 || /[\u0000-\u001f\u007f]/.test(value))) {
    throw groupContractError("group_display_projection_invalid");
  }
  if (!Number.isFinite(new Date(now).getTime())) throw groupContractError("group_clock_invalid");
  const requiredStepIds = new Set(requiredGroupExecutionStepIds(plan));
  const sourceAsOf = new Date(now).toISOString();
  const activities = [];
  const executionUpdates = [], executionStarts = [];
  const steps = plan.steps.map(step => {
    const binding = run.stepBindings.find(item => item.stepId === step.stepId);
    const task = binding ? taskRepository.get(binding.taskId, {tenantScope:run.tenantScope}) : null;
    if (binding && (!task || task.taskId !== binding.taskId || task.employeeId !== step.employeeId || task.employeeVersion !== step.employeeVersion)) throw groupContractError("group_task_reference_invalid");
    if (task) {
      assertGroupScope(task, actor);
      for (const [value, target] of [[task.updatedAt, executionUpdates], [task.startedAt, executionStarts]]) {
        if (typeof value === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value) &&
            Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 19) === value.slice(0, 19)) target.push(Date.parse(value));
      }
    }
    const effect = task ? taskRepository.summarizeOperationReceipts({tenantScope:run.tenantScope, taskId:task.taskId}) : null;
    const artifacts = task && typeof taskRepository.listArtifacts === "function"
      ? taskRepository.listArtifacts({ tenantScope: run.tenantScope, taskId: task.taskId })
        .filter(artifact => artifact.taskId === task.taskId && artifact.employeeId === step.employeeId)
        .map(({ artifactId, taskId, employeeId, fileName, mimeType, sizeBytes, createdAt, expiresAt }) =>
          ({ artifactId, taskId, employeeId, fileName, mimeType, sizeBytes, createdAt, expiresAt })) : [];
    if (task && (!TASK_STATES.has(task.status) || !Number.isSafeInteger(task.revision) || task.revision < 0)) throw groupContractError("group_task_state_invalid");
    let blockCode = null;
    if (effect?.effectState === "reconcile_required") blockCode = "external_effect_unknown";
    else if (task && ["failed", "blocked", "rejected", "timed_out", "lost", "canceled"].includes(task.status)) blockCode = "dependency_failed";
    else if (!task && run.activation === "resume_required") blockCode = "resume_required";
    if (task) activities.push(...projectStepActivities({ run, step, task }));
    return {
      stepId:step.stepId, employeeId:step.employeeId, employeeVersion:step.employeeVersion, kind:step.kind,
      dependsOn:[...step.dependsOn], optionalDependsOn:[...step.optionalDependsOn],
      ...(stepObjectives[step.stepId] ? { objective: stepObjectives[step.stepId] } : {}),
      artifacts,
      taskId:task?.taskId || null, taskRevision:task?.revision || null,
      submittedAt: safeTaskTime(task?.createdAt), startedAt: safeTaskTime(task?.startedAt), finishedAt: safeTaskTime(task?.finishedAt), updatedAt: safeTaskTime(task?.updatedAt),
      status:task?.status || (run.cancelRequested ? "canceled" : "pending"), blockCode,
      ...(task?.status === "completed" && task.resultSummary === "Group step deliverable published."
        ? { resultSummary: "步骤产出物已发布，请打开产出物查看完整结果。" } : {}),
      ...(task?.status === "failed" && task.resultSummary === "Group review rejected; opinion Artifact published."
        ? { resultSummary: "复核未通过，复核意见已作为产出物发布。" } : {}),
      ...(blockCode === "dependency_failed" ? { errorCode: safeGroupExecutionErrorCode(task?.lastErrorCode) } : {}),
    };
  });
  const reviewerMembers = plan.reviewerGroup?.members.map(member => {
    const matching = steps.filter(step => step.kind === "review" && step.employeeId === member.employeeId && step.employeeVersion === member.employeeVersion);
    const blocked = matching.find(step => step.blockCode);
    const complete = matching.length > 0 && matching.every(step => step.status === "completed");
    return { ...member, status: blocked?.status || (complete ? "completed" : matching.find(step => step.status !== "completed")?.status || "pending"),
      blockCode: blocked?.errorCode || blocked?.blockCode || null,
      opinionSummary: null };
  });
  const reviewerGroup = plan.reviewerGroup ? { ...plan.reviewerGroup, members: reviewerMembers,
    blocking: reviewerMembers.some(member => member.status !== "completed"),
    status: reviewerMembers.some(member => member.blockCode) ? "failed" : reviewerMembers.every(member => member.status === "completed") ? "approved" : "pending",
  } : null;
  let delivery = null;
  try {
    const snapshot = readGroupDelivery({ actor, run, plan, taskRepository });
    if (!run.acceptance) assertGroupDeliveryAvailable({ actor, delivery: snapshot, taskRepository, now });
    delivery = { deliveryDigest: snapshot.deliveryDigest };
  } catch (error) {
    if (error?.code !== "group_delivery_unavailable") throw error;
  }
  let status = run.activation === "active" ? "running" : run.activation;
  if (steps.some(step => step.blockCode === "external_effect_unknown")) status = "reconcile_required";
  else if (run.cancelRequested) status = "canceled";
  else if (steps.some(step => requiredStepIds.has(step.stepId) && step.blockCode === "dependency_failed")) status = "blocked";
  else if (steps.some(step => step.errorCode === "group_review_rejected")) status = "blocked";
  else if (steps.every(step => step.status === "completed")) {
    status = delivery ? "awaiting_acceptance" : "execution_completed";
    if (run.acceptance) status = delivery?.deliveryDigest === run.acceptance.deliveryDigest ? run.acceptance.decision : "reconcile_required";
  } else if (run.activation === "active" && reviewerGroup?.blocking && steps.filter(step => !["review", "summary"].includes(step.kind)).every(step => step.status === "completed")) status = "awaiting_review";
  return groupFreeze({
    contractVersion:"group-run-safe-projection.v1", sourceAsOf,
    executionUpdatedAt: executionUpdates.length ? new Date(Math.max(...executionUpdates)).toISOString() : null,
    executionStartedAt: executionStarts.length ? new Date(Math.min(...executionStarts)).toISOString() : null,
    runId:run.runId, goalId:run.goalId, groupId:run.groupId, groupVersion:run.groupVersion,
    planId:run.planId, planRevision:run.planRevision, casRevision:run.casRevision,
    delivery, acceptance: run.acceptance || null, reviewerGroup, activation:run.activation, cancellationRequested:run.cancelRequested, status, steps, activities,
  });
}

function projectStepActivities({ run, step, task }) {
  const result = [{
    activityId: `group_task_state:${run.runId}:${step.stepId}:${task.taskId}:${task.revision}`,
    source: "canonical_task_state",
    stepId: step.stepId,
    employeeId: step.employeeId,
    taskId: task.taskId,
    taskRevision: task.revision,
    kind: "task",
    status: task.status,
    displayName: "任务状态",
    ...(safeTaskTime(task.updatedAt) ? { updatedAt: safeTaskTime(task.updatedAt) } : {}),
  }];
  let snapshot;
  try {
    snapshot = normalizeRuntimeSafeActivitySnapshot(task.activitySnapshot, { expectedTaskId: task.taskId });
  } catch {
    return result;
  }
  for (const activity of snapshot.activities) {
    result.push({
      activityId: activity.activityId,
      source: "runtime_safe_activity",
      stepId: step.stepId,
      employeeId: step.employeeId,
      taskId: task.taskId,
      taskRevision: task.revision,
      sequence: activity.sequence,
      kind: activity.kind,
      status: activity.status,
      displayName: activity.displayName,
      subjectId: activity.subjectId,
      actionCode: activity.actionCode,
      ...(activity.operationCode ? { operationCode: activity.operationCode } : {}),
    });
  }
  return result;
}

function safeTaskTime(value) {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value) && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 19) === value.slice(0, 19) ? value : null;
}
