import {
  assertGroupScope, groupContractError, groupDigest, groupEnum, groupFreeze,
  groupId, groupInteger, groupObject, groupScope, normalizeWorkGoal,
} from "./group-contracts-v1.mjs";
import { requiredExecutionTaskToken } from "./runtime-task-contract-v1.mjs";

export const WORK_GOAL_TASK_BINDING_VERSION = "work-goal-task-binding.v1";

// Metadata contract only. The canonical SQLite submission/Tool boundaries must
// integrate this before activation; a valid binding never authorizes a Tool.
export function normalizeWorkGoalTaskBinding(value) {
  const v = groupObject(value, ["tenantScope", "actorIssuer", "actorSubjectDigest",
    "taskId", "goalId", "goalRevision", "objectiveDigest", "employeeId",
    "employeeVersion", "sessionId", "inputRef", "inputDigest", "kind", "sourceTaskId"], WORK_GOAL_TASK_BINDING_VERSION);
  const input = groupObject(v.inputRef, ["kind", "refId"]);
  const kind = groupEnum(v.kind, ["initial", "continuation", "scheduled"]);
  if ((kind === "initial") !== (v.sourceTaskId === null)) throw groupContractError("work_goal_binding_source_invalid");
  const taskId = requiredExecutionTaskToken(v.taskId, "taskId", 128);
  const sourceTaskId = v.sourceTaskId === null ? null : requiredExecutionTaskToken(v.sourceTaskId, "sourceTaskId", 128);
  if (taskId === sourceTaskId) throw groupContractError("work_goal_binding_source_invalid");
  return groupFreeze({ contractVersion: WORK_GOAL_TASK_BINDING_VERSION, ...groupScope(v),
    taskId, goalId: groupId(v.goalId), goalRevision: groupInteger(v.goalRevision, 1),
    objectiveDigest: groupDigest(v.objectiveDigest), employeeId: groupId(v.employeeId),
    employeeVersion: groupId(v.employeeVersion), sessionId: groupId(v.sessionId),
    inputRef: { kind: groupEnum(input.kind, ["artifact_ref", "transcript_entry"]),
      refId: requiredExecutionTaskToken(input.refId, "inputRef.refId", 240) },
    inputDigest: groupDigest(v.inputDigest), kind, sourceTaskId });
}

export function assertWorkGoalBindingTask(binding, task) {
  const b = normalizeWorkGoalTaskBinding(binding);
  assertGroupScope(b, task);
  if (b.taskId !== task.taskId || b.employeeId !== task.employeeId ||
    b.employeeVersion !== task.employeeVersion || b.sessionId !== task.sessionId ||
    b.inputDigest !== task.inputDigest || b.inputRef.kind !== task.executionInputRef?.kind ||
    b.inputRef.refId !== task.executionInputRef?.refId) throw groupContractError("work_goal_binding_task_mismatch");
  return b;
}

export function assertWorkGoalBindingCurrent(binding, currentGoal) {
  const b = normalizeWorkGoalTaskBinding(binding);
  const goal = normalizeWorkGoal(currentGoal);
  assertGroupScope(b, goal);
  if (b.goalId !== goal.goalId || b.goalRevision !== goal.revision ||
    b.objectiveDigest !== goal.objectiveDigest) throw groupContractError("work_goal_binding_revision_changed");
  if (goal.phase !== "adopted") throw groupContractError("work_goal_binding_not_active");
  return b;
}

export function createWorkGoalTaskBinding({ goal, task, kind = "initial", sourceBinding = null, sourceTask = null } = {}) {
  const normalizedGoal = normalizeWorkGoal(goal);
  assertGroupScope(normalizedGoal, task);
  if (normalizedGoal.phase !== "adopted") throw groupContractError("work_goal_binding_not_active");
  if (kind === "initial") {
    if (sourceBinding !== null || sourceTask !== null ||
      normalizedGoal.objectiveRef.kind !== task.executionInputRef?.kind ||
      normalizedGoal.objectiveRef.refId !== task.executionInputRef?.refId ||
      normalizedGoal.transcriptSessionId !== task.sessionId) throw groupContractError("work_goal_binding_initial_input_mismatch");
  } else {
    if (!sourceBinding || !sourceTask) throw groupContractError("work_goal_binding_source_required");
    const source = assertWorkGoalBindingTask(sourceBinding, sourceTask);
    assertWorkGoalBindingCurrent(source, normalizedGoal);
    if (source.employeeId !== task.employeeId || source.employeeVersion !== task.employeeVersion ||
      source.sessionId !== task.sessionId) throw groupContractError("work_goal_binding_executor_changed");
  }
  const binding = normalizeWorkGoalTaskBinding({ contractVersion: WORK_GOAL_TASK_BINDING_VERSION,
    ...groupScope(task), taskId: task.taskId, goalId: normalizedGoal.goalId,
    goalRevision: normalizedGoal.revision, objectiveDigest: normalizedGoal.objectiveDigest,
    employeeId: task.employeeId, employeeVersion: task.employeeVersion, sessionId: task.sessionId,
    inputRef: task.executionInputRef, inputDigest: task.inputDigest, kind,
    sourceTaskId: sourceTask?.taskId ?? null });
  assertWorkGoalBindingTask(binding, task);
  assertWorkGoalBindingCurrent(binding, normalizedGoal);
  return binding;
}
