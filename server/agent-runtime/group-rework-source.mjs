import { groupContentDigest, groupContractError } from "./group-contracts-v1.mjs";

// Read canonical provenance only; this does not grant bytes or reactivate history.
export function readGroupReworkSource({ groups, actor, goalId, goalRevision }) {
  const goal = groups.readGoal(actor, goalId, goalRevision);
  if (!goal) throw groupContractError("group_goal_not_found");
  if (!goal.reworkSource) return null;
  const source = groups.rejectedReviewSource(actor, goal.reworkSource.runId);
  const run = source && groups.readRun(actor, source.runId);
  const plan = run && groups.readPlan(actor, run.planId, run.planRevision);
  if (!source || groupContentDigest(source) !== groupContentDigest(goal.reworkSource) ||
      !run || !plan || run.goalId !== goalId || run.goalRevision >= goalRevision ||
      run.groupId !== goal.planningContext?.groupId || plan.goalId !== run.goalId ||
      plan.goalRevision !== run.goalRevision || plan.groupId !== run.groupId || plan.groupVersion !== run.groupVersion) {
    throw groupContractError("group_rework_source_invalid");
  }
  return { source, run, plan };
}
