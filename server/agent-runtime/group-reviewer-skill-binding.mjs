import { groupContentDigest } from "./group-contracts-v1.mjs";
import { projectSkillDependency } from "./dependency-context.mjs";

// Deployment composition selects the recommendation; this boundary only pins
// its reviewed runtime contract. Publication eligibility is checked separately.
function contentDigest(skill) {
  const { status, runtimeEligibility, ...content } = projectSkillDependency(skill);
  return groupContentDigest(content);
}
function eligible(skill) {
  return skill?.runtimeEligibility?.allowed === true &&
    skill.runtimeExecutionProfile?.contractVersion === "skill-runtime-execution-profile.v1" &&
    skill.runtimeExecutionProfile.mode === "guidance" &&
    skill.activationPolicy === "agent_discretion" && Boolean(skill.id && skill.version);
}
export function bindGroupReviewerSkill({ reviewerGroup, skill } = {}) {
  if (!reviewerGroup || !eligible(skill)) return null;
  return { skillId: skill.id, version: skill.version, contentDigest: contentDigest(skill) };
}
export function resolveGroupReviewerSkill({ binding, skills = [] } = {}) {
  if (!binding) return null;
  const skill = skills.find(item => item.id === binding.skillId);
  return eligible(skill) && skill.version === binding.version &&
    contentDigest(skill) === binding.contentDigest ? skill : null;
}
