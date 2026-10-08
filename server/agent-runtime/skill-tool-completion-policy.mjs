import { AGENT_COMPLETION_CONTRACT_VERSION } from "./agent-completion-contract.mjs";

const TOOL_OPERATION_COMPLETION_POLICY_VERSION = "tool-operation-completion-policy.v1";
const CONTRACT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,179}$/;
const ENTITY_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/;

function normalizeSkillToolCompletionPolicies(value = []) {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 8).map(normalizePolicy).filter(Boolean);
}

function normalizePolicy(value = {}) {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
    value.contractVersion !== TOOL_OPERATION_COMPLETION_POLICY_VERSION) return null;
  const contractId = token(value.contractId, CONTRACT_ID_PATTERN);
  const toolId = token(value.toolId, ENTITY_ID_PATTERN);
  const operationId = token(value.operationId, ENTITY_ID_PATTERN);
  const evidenceMode = value.evidenceMode === "target_response_observed"
    ? "target_response_observed"
    : "successful_operation";
  const activationTerms = [...new Set((Array.isArray(value.activationTerms) ? value.activationTerms : [])
    .map((item) => String(item || "").trim())
    .filter((item) => item && item.length <= 80))].slice(0, 12);
  const maxEvidenceContinuationRounds = Number(value.maxEvidenceContinuationRounds);
  const preparationOperationIds = [...new Set((Array.isArray(value.preparationOperationIds)
    ? value.preparationOperationIds
    : []).map((item) => token(item, ENTITY_ID_PATTERN)).filter(Boolean))].slice(0, 8);
  if (!contractId || !toolId || !operationId || !activationTerms.length ||
    !Number.isSafeInteger(maxEvidenceContinuationRounds) ||
    maxEvidenceContinuationRounds < 1 || maxEvidenceContinuationRounds > 3) return null;
  return Object.freeze({
    contractVersion: TOOL_OPERATION_COMPLETION_POLICY_VERSION,
    contractId,
    toolId,
    operationId,
    evidenceMode,
    activationTerms: Object.freeze(activationTerms),
    preparationOperationIds: Object.freeze(preparationOperationIds),
    maxEvidenceContinuationRounds,
  });
}

function skillToolCompletionPolicies(callableSkills = []) {
  const policies = [];
  for (const skill of Array.isArray(callableSkills) ? callableSkills : []) {
    const declared = skill?.toolCompletionPolicies || skill?.skillPackageIdentity?.toolCompletionPolicies;
    policies.push(...normalizeSkillToolCompletionPolicies(declared));
  }
  return policies;
}

function resolveSkillToolCompletionContract({ callableSkills = [], userText = "" } = {}) {
  const normalizedText = String(userText || "").toLocaleLowerCase("zh-CN");
  const active = skillToolCompletionPolicies(callableSkills).filter((policy) =>
    policy.activationTerms.some((term) => normalizedText.includes(term.toLocaleLowerCase("zh-CN"))));
  if (!active.length) return null;
  return Object.freeze({
    contractVersion: AGENT_COMPLETION_CONTRACT_VERSION,
    maxCandidateRepairRounds: 0,
    maxEvidenceContinuationRounds: Math.max(...active.map((policy) => policy.maxEvidenceContinuationRounds)),
    requiredEvidence: Object.freeze([...new Set(active.map((policy) => policy.contractId))]),
  });
}

function token(value, pattern) {
  const normalized = String(value || "").trim();
  return pattern.test(normalized) ? normalized : "";
}

export {
  TOOL_OPERATION_COMPLETION_POLICY_VERSION,
  normalizeSkillToolCompletionPolicies,
  resolveSkillToolCompletionContract,
  skillToolCompletionPolicies,
};
