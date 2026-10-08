const SKILL_RUNTIME_EXECUTION_PROFILE_CONTRACT = "skill-runtime-execution-profile.v1";
const SKILL_RUNTIME_EXECUTION_MODES = new Set([
  "guidance",
  "tool_workflow",
  "deterministic_harness",
]);

function createSkillRuntimeExecutionProfile(mode = "") {
  const normalizedMode = cleanMode(mode);
  if (!normalizedMode) throw new TypeError("skill runtime execution mode invalid");
  return {
    contractVersion: SKILL_RUNTIME_EXECUTION_PROFILE_CONTRACT,
    mode: normalizedMode,
  };
}

function normalizeSkillRuntimeExecutionProfile(value = {}) {
  if (value?.contractVersion !== SKILL_RUNTIME_EXECUTION_PROFILE_CONTRACT) return null;
  const mode = cleanMode(value.mode);
  return mode ? createSkillRuntimeExecutionProfile(mode) : null;
}

function resolveSkillRuntimeExecutionProfile(skill = {}) {
  const declared = normalizeSkillRuntimeExecutionProfile(skill.runtimeExecutionProfile);
  return declared
    ? { ...declared, profileSource: "declared_skill_contract" }
    : null;
}

function cleanMode(value = "") {
  const mode = String(value || "").trim();
  return SKILL_RUNTIME_EXECUTION_MODES.has(mode) ? mode : "";
}

export {
  SKILL_RUNTIME_EXECUTION_MODES,
  SKILL_RUNTIME_EXECUTION_PROFILE_CONTRACT,
  createSkillRuntimeExecutionProfile,
  normalizeSkillRuntimeExecutionProfile,
  resolveSkillRuntimeExecutionProfile,
};
