const AGENT_COMPLETION_CONTRACT_VERSION = "agent-completion-contract.v1";
const AGENT_COMPLETION_FEEDBACK_VERSION = "agent-completion-feedback.v1";
const CONTRACT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,179}$/;

const DEFAULT_AGENT_COMPLETION_CONTRACT = Object.freeze({
  contractVersion: AGENT_COMPLETION_CONTRACT_VERSION,
  maxCandidateRepairRounds: 0,
  maxEvidenceContinuationRounds: 0,
  requiredEvidence: Object.freeze([]),
});

function normalizeAgentCompletionContract(value = null) {
  if (value === null || value === undefined) return DEFAULT_AGENT_COMPLETION_CONTRACT;
  requirePlainObject(value, "agent_completion_contract_invalid");
  const fields = new Set([
    "contractVersion",
    "maxCandidateRepairRounds",
    "maxEvidenceContinuationRounds",
    "requiredEvidence",
  ]);
  requireExactFields(value, fields, "agent_completion_contract_invalid");
  if (value.contractVersion !== AGENT_COMPLETION_CONTRACT_VERSION) {
    throw completionError("agent_completion_contract_version_invalid");
  }
  if (!validRoundLimit(value.maxCandidateRepairRounds) ||
    !validRoundLimit(value.maxEvidenceContinuationRounds)) {
    throw completionError("agent_completion_continuation_limit_invalid");
  }
  if (!Array.isArray(value.requiredEvidence) || value.requiredEvidence.length > 12) {
    throw completionError("agent_completion_required_evidence_invalid");
  }
  const requiredEvidence = [...new Set(value.requiredEvidence.map(requiredContractId))];
  if (requiredEvidence.length && value.maxEvidenceContinuationRounds < 1) {
    throw completionError("agent_completion_continuation_limit_invalid");
  }
  return Object.freeze({
    contractVersion: AGENT_COMPLETION_CONTRACT_VERSION,
    maxCandidateRepairRounds: value.maxCandidateRepairRounds,
    maxEvidenceContinuationRounds: value.maxEvidenceContinuationRounds,
    requiredEvidence: Object.freeze(requiredEvidence),
  });
}

function validRoundLimit(value) {
  return Number.isSafeInteger(value) && value >= 0 && value <= 3;
}

function missingAgentCompletionEvidence(contract, evidence = []) {
  const normalized = normalizeAgentCompletionContract(contract);
  const verified = new Set((Array.isArray(evidence) ? evidence : []).flatMap((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item) || item.status !== "verified") return [];
    try {
      return [requiredContractId(item.contractId)];
    } catch {
      return [];
    }
  }));
  return normalized.requiredEvidence.filter((contractId) => !verified.has(contractId));
}

function agentCompletionFeedback({ code, issues = [], missingEvidence = [], remainingRoundsAfterCurrent } = {}) {
  const safeCode = requiredCode(code);
  if (!Number.isSafeInteger(remainingRoundsAfterCurrent) ||
    remainingRoundsAfterCurrent < 0 || remainingRoundsAfterCurrent > 3) {
    throw completionError("agent_completion_feedback_invalid");
  }
  const missing = [...new Set((Array.isArray(missingEvidence) ? missingEvidence : [])
    .map(requiredContractId))];
  const safeIssues = [...new Set((Array.isArray(issues) ? issues : []).map(requiredCode))].slice(0, 8);
  return Object.freeze({
    contractVersion: AGENT_COMPLETION_FEEDBACK_VERSION,
    code: safeCode,
    issues: Object.freeze(safeIssues),
    missingEvidence: Object.freeze(missing),
    remainingRoundsAfterCurrent,
  });
}

function requiredContractId(value) {
  const normalized = String(value || "").trim();
  if (!CONTRACT_ID_PATTERN.test(normalized)) {
    throw completionError("agent_completion_evidence_contract_invalid");
  }
  return normalized;
}

function requiredCode(value) {
  const normalized = String(value || "").trim();
  if (!/^[a-z][a-z0-9_]{1,119}$/.test(normalized)) {
    throw completionError("agent_completion_feedback_invalid");
  }
  return normalized;
}

function requirePlainObject(value, code) {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(value))) {
    throw completionError(code);
  }
}

function requireExactFields(value, fields, code) {
  const keys = Object.keys(value);
  if (keys.length !== fields.size || keys.some((field) => !fields.has(field)) ||
    [...fields].some((field) => !Object.hasOwn(value, field))) {
    throw completionError(code);
  }
}

function completionError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

export {
  AGENT_COMPLETION_CONTRACT_VERSION,
  AGENT_COMPLETION_FEEDBACK_VERSION,
  DEFAULT_AGENT_COMPLETION_CONTRACT,
  agentCompletionFeedback,
  missingAgentCompletionEvidence,
  normalizeAgentCompletionContract,
};
