const ID = /^[A-Za-z0-9][A-Za-z0-9._:@-]{0,159}$/;

function text(value, max) {
  return typeof value === "string" && value.trim() && value.length <= max && !/[\u0000-\u001f\u007f]/.test(value)
    ? value.trim() : null;
}

export function projectGroupPlannerDisplay({ response, draft, groupVersion } = {}) {
  let parsed;
  try { parsed = JSON.parse(response); } catch { return null; }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed) || !draft || !groupVersion ||
    !Array.isArray(draft.steps) || !Array.isArray(groupVersion.members) || !Array.isArray(parsed.memberRecommendations)) return null;
  const understanding = text(parsed.goalUnderstanding, 600);
  const recommendations = parsed.memberRecommendations;
  if (!understanding || recommendations.length > 12) return null;
  const originalSteps = parsed.planDraft?.steps;
  if (!Array.isArray(originalSteps) || originalSteps.length !== draft.steps.length) return null;
  const byStep = new Map(originalSteps.map(step => [step?.stepId, step]));
  if (byStep.size !== draft.steps.length || draft.steps.some(step => {
    const proposed = byStep.get(step.stepId);
    return proposed?.employeeId !== step.employeeId || proposed?.employeeVersion !== step.employeeVersion ||
      proposed?.kind !== step.kind || JSON.stringify(proposed?.dependsOn || []) !== JSON.stringify(step.dependsOn);
  })) return null;
  const selected = new Set(draft.steps.map(step => step.employeeId));
  const allowed = new Map(groupVersion.members.map(member => [member.employeeId, member.employeeVersion]));
  if (draft.groupId !== groupVersion.groupId || draft.groupVersion !== groupVersion.version ||
    draft.steps.some(step => allowed.get(step.employeeId) !== step.employeeVersion)) return null;
  const projected = recommendations.map(item => {
    const employeeId = item?.employeeId;
    const assignment = text(item?.assignment, 240);
    const reason = text(item?.reason, 240);
    return ID.test(employeeId) && selected.has(employeeId) && allowed.has(employeeId) && assignment && reason
      ? { employeeId, assignment, reason } : null;
  });
  if (projected.some(item => !item) || new Set(projected.map(item => item.employeeId)).size !== projected.length) return null;
  return { understanding, recommendations: projected };
}
