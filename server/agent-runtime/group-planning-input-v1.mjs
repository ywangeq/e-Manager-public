import { groupContentDigest, groupContractError } from './group-contracts-v1.mjs';

// Lives in the existing encrypted Goal transcript, never in task evidence or metadata.
export function groupPlanningInputSnapshot({ objective, inputRefs = [], constraints = [], planContext }) {
  return { contractVersion: 'group-planning-input.v1', goalId: planContext.goalId, goalRevision: planContext.goalRevision,
    groupId: planContext.groupId, groupVersion: planContext.groupVersion,
    input: { objective, inputRefs, planningHints: constraints, resourceScope: planContext.resourceScope || [] } };
}
export function readGroupPlanningInputSnapshot(snapshot, goal, groupVersion) {
  if (snapshot?.contractVersion !== 'group-planning-input.v1' || snapshot.goalId !== goal.goalId ||
      snapshot.goalRevision !== goal.revision || snapshot.groupId !== groupVersion.groupId || snapshot.groupVersion !== groupVersion.version ||
      typeof snapshot.input?.objective !== 'string' || !snapshot.input.objective.trim() ||
      !['inputRefs', 'planningHints', 'resourceScope'].every(key => Array.isArray(snapshot.input[key])) ||
      groupContentDigest({ objective: snapshot.input.objective }) !== goal.objectiveDigest ||
      groupContentDigest(snapshot.input.inputRefs) !== groupContentDigest(goal.inputRefs)) {
    throw groupContractError('group_planner_input_unavailable');
  }
  return snapshot.input;
}

// Bounded migration for pre-snapshot initial Goals only. Reconstruct candidates from
// server-owned text/metadata and require the original full request hash to match.
// Never guess omitted constraints, resource scope or a continuation's original turn.
export function recoverLegacyGroupPlanningInput({ goal, groupVersion, objective, input = {} }) {
  if (goal.revision !== 1 || groupVersion.version !== 1 || !objective ||
      groupContentDigest({ objective }) !== goal.objectiveDigest) throw groupContractError('group_planner_input_unavailable');
  const planningHints = input.planningHints || [], resourceScope = input.resourceScope || [];
  for (const completionConditions of [goal.completionConditions, undefined]) {
    const digest = groupContentDigest({ requestKey: goal.planningContext.clientRequestId, objective,
      members: groupVersion.members.map(({ employeeId, employeeVersion }) => ({ employeeId, employeeVersion })),
      budget: goal.budget, inputRefs: goal.inputRefs, planningHints, resourceScope, completionConditions,
      reviewerGroup: groupVersion.reviewerGroup || null });
    if (groupVersion.idempotencyKey === `message-${digest}`) return { objective, inputRefs: goal.inputRefs, planningHints, resourceScope };
  }
  throw groupContractError('group_planner_input_unavailable');
}
