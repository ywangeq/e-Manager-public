import { businessSkills } from "../../data/catalog";

export function listItems(items, fallback = []) {
  const source = Array.isArray(items) ? items : fallback;
  return source.map((item) => String(item || "").trim()).filter(Boolean);
}

export function referenceItems(references) {
  return listItems(references).map((item) => item.replace(/^https?:\/\/git\.smoa\.cc\/skills_group\/yewu\/yewu\/-\/blob\/master\//, ""));
}

export function joinedList(value) {
  return listItems(value).join("\n");
}

export function splitDraftText(value) {
  return String(value || "")
    .split(/\n|,/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function sameDraftValue(left, right) {
  if (Array.isArray(left) || Array.isArray(right)) return sameItems(left, right);
  return String(left || "").trim() === String(right || "").trim();
}

export function changedDraftFields(form, baseline, labels) {
  return Object.entries(labels)
    .filter(([field]) => !sameDraftValue(form[field], baseline[field]))
    .map(([, label]) => label);
}

function nameFromSkills(id, source) {
  return source.find((item) => item.id === id)?.name || id;
}

export function downloadPolicyItems(policy) {
  if (!policy) return [];
  return [
    policy.permission,
    policy.audience ? `范围：${policy.audience}` : "",
    policy.packageRequirement,
    policy.approval,
  ].filter(Boolean);
}

export function businessSkillNames(ids, source = businessSkills) {
  return listItems(ids).map((id) => nameFromSkills(id, source));
}

export function businessSkillLinks(ids, source = businessSkills) {
  return listItems(ids)
    .map((id) => source.find((skill) => skill.id === id))
    .filter(Boolean);
}

export function sameItems(left = [], right = []) {
  const leftItems = listItems(left);
  const rightItems = listItems(right);
  if (leftItems.length !== rightItems.length) return false;
  const rightSet = new Set(rightItems);
  return leftItems.every((item) => rightSet.has(item));
}

export function promptGovernanceForSkill(skill, draft = null) {
  const governance = skill.promptGovernance || {};
  const merged = {
    promptScope: governance.promptScope || skill.promptScope || `skill:${skill.id}`,
    promptVersion: governance.promptVersion || skill.promptVersion || "",
    promptHash: governance.promptHash || skill.promptHash || "",
    promptKeys: governance.promptKeys || skill.promptKeys || [],
    promptChangeSummary: governance.promptChangeSummary || skill.promptChangeSummary || "",
    promptReviewGate: governance.promptReviewGate || skill.promptReviewGate || skill.reviewGate || "",
    rawPromptStored: governance.rawPromptStored ?? false,
    source: governance.source || "skill-prompt-config",
  };
  return draft ? { ...merged, ...draft, promptKeys: draft.promptKeys || merged.promptKeys } : merged;
}
