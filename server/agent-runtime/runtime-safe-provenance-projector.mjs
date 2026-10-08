import {
  normalizeRuntimeSafeProvenance,
  normalizeRuntimeSafeProvenanceSource,
  RUNTIME_SAFE_PROVENANCE_CONTRACT_VERSION,
  RUNTIME_SAFE_PROVENANCE_SOURCE_CONTRACT_VERSION,
} from "./runtime-safe-provenance-contract-v1.mjs";
import { normalizeRuntimeSafeActivitySnapshot } from "./runtime-safe-activity-contract-v1.mjs";

const DEPENDENCY_CONTEXT_CONTRACT_VERSION = "digital-employee-runtime-dependency-context.v2";
const SKILL_PROFILE_CONTRACT_VERSION = "skill-runtime-execution-profile.v1";
const GENERIC_SKILL_NAMES = Object.freeze({
  guidance: "指导 Skill",
  tool_workflow: "Tool 工作流 Skill",
  deterministic_harness: "确定性执行 Skill",
});
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/;
const HOST_PATH = /^(?:\/|~[\\/]|[A-Za-z]:[\\/]|\\\\)/;
const SECRET_PREFIX = /^(?:bearer[\s._:-]*|sk-|rk-|xox[baprs]-|gh[pousr]_|glpat-|ya29\.)/i;

function projectRuntimeSafeProvenanceSource({ dependencyContext = {}, runtimeTask = {} } = {}) {
  if (dependencyContext?.contractVersion !== DEPENDENCY_CONTEXT_CONTRACT_VERSION) {
    throw projectorError("runtime_safe_provenance_dependency_context_invalid");
  }
  const taskId = requiredText(runtimeTask.taskId, "taskId");
  const employeeId = requiredText(runtimeTask.employeeId, "employeeId");
  const employeeVersion = requiredText(runtimeTask.employeeVersion, "employeeVersion");
  if (dependencyContext.employee?.id !== employeeId ||
    dependencyContext.employee?.version !== employeeVersion) {
    throw projectorError("runtime_safe_provenance_task_employee_mismatch");
  }
  const callableSkillIds = exactStringArray(dependencyContext.skillScope?.callableSkillIds);
  const callableSkills = Array.isArray(dependencyContext.callableSkills)
    ? dependencyContext.callableSkills
    : [];
  if (callableSkills.length !== callableSkillIds.length ||
    callableSkills.some((skill, index) => skill?.id !== callableSkillIds[index])) {
    throw projectorError("runtime_safe_provenance_callable_scope_mismatch");
  }
  const source = {
    contractVersion: RUNTIME_SAFE_PROVENANCE_SOURCE_CONTRACT_VERSION,
    taskId,
    employeeProfile: {
      fact: "applied",
      subjectId: employeeId,
      displayName: "员工职业设定",
      sourceVersion: employeeVersion,
      promptScope: optionalText(dependencyContext.promptMetadata?.promptScope),
      promptVersion: requiredText(dependencyContext.promptMetadata?.promptVersion, "promptVersion"),
      promptHash: optionalText(dependencyContext.promptMetadata?.promptHash),
    },
    callableSkills: callableSkills.map((skill) => {
      const mode = skill?.runtimeExecutionProfile?.contractVersion === SKILL_PROFILE_CONTRACT_VERSION
        ? skill.runtimeExecutionProfile.mode
        : "";
      if (skill?.runtimeEligibility?.allowed !== true || !GENERIC_SKILL_NAMES[mode]) {
        throw projectorError("runtime_safe_provenance_callable_skill_invalid");
      }
      return {
        fact: "callable",
        subjectId: requiredText(skill.id, "skillId"),
        displayName: managedDisplayName(skill.name, GENERIC_SKILL_NAMES[mode]),
        sourceVersion: requiredText(skill.version, "skillVersion"),
        executionMode: mode,
      };
    }),
  };
  return normalizeRuntimeSafeProvenanceSource(source, {
    expectedTaskId: taskId,
    expectedEmployeeId: employeeId,
    expectedEmployeeVersion: employeeVersion,
  });
}

function projectRuntimeSafeProvenance({ activitySnapshot = null, sourceSnapshot = null } = {}) {
  const source = normalizeRuntimeSafeProvenanceSource(sourceSnapshot || {});
  const activities = activitySnapshot
    ? normalizeRuntimeSafeActivitySnapshot(activitySnapshot, { expectedTaskId: source.taskId }).activities
    : [];
  const callableById = new Map(source.callableSkills.map((skill) => [skill.subjectId, skill]));
  const executedSkills = activities.filter((activity) => activity.kind === "skill").map((activity) => {
    const sourceSkill = callableById.get(activity.subjectId);
    if (!sourceSkill || sourceSkill.executionMode !== "deterministic_harness") {
      throw projectorError("runtime_safe_provenance_execution_source_mismatch");
    }
    return {
      fact: "executed",
      activityId: activity.activityId,
      sequence: activity.sequence,
      subjectId: activity.subjectId,
      displayName: activity.displayName,
      sourceVersion: sourceSkill.sourceVersion,
      status: activity.status,
    };
  });
  return normalizeRuntimeSafeProvenance({
    contractVersion: RUNTIME_SAFE_PROVENANCE_CONTRACT_VERSION,
    taskId: source.taskId,
    employeeProfile: source.employeeProfile,
    callableSkills: source.callableSkills,
    executedSkills,
  });
}

function projectSafeRuntimeProvenance(value = {}) {
  try {
    return projectRuntimeSafeProvenance(value);
  } catch {
    return null;
  }
}

function managedDisplayName(value, fallback) {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  if (!text || text.length > 160 || CONTROL_CHARACTERS.test(text) ||
    HOST_PATH.test(text) || SECRET_PREFIX.test(text)) return fallback;
  return text;
}

function exactStringArray(value) {
  if (!Array.isArray(value) || value.length > 50 ||
    value.some((item) => typeof item !== "string" || !item || item !== item.trim()) ||
    new Set(value).size !== value.length) {
    throw projectorError("runtime_safe_provenance_callable_scope_invalid");
  }
  return value;
}

function requiredText(value, field) {
  if (typeof value !== "string" || !value || value !== value.trim() || value.length > 180) {
    throw projectorError("runtime_safe_provenance_source_value_invalid", field);
  }
  return value;
}

function optionalText(value) {
  if (value === undefined || value === null || value === "") return "";
  return requiredText(value, "optionalSource");
}

function projectorError(code, field = "") {
  const error = new Error(field ? `${code}:${field}` : code);
  error.code = code;
  return error;
}

export {
  projectRuntimeSafeProvenance,
  projectRuntimeSafeProvenanceSource,
  projectSafeRuntimeProvenance,
};
