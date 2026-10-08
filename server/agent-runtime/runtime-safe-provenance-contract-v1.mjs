const RUNTIME_SAFE_PROVENANCE_SOURCE_CONTRACT_VERSION = "runtime-safe-provenance-source.v1";
const RUNTIME_SAFE_PROVENANCE_CONTRACT_VERSION = "runtime-safe-provenance.v1";
const MAX_CALLABLE_SKILLS = 50;

const SOURCE_FIELDS = new Set(["callableSkills", "contractVersion", "employeeProfile", "taskId"]);
const PUBLIC_FIELDS = new Set([...SOURCE_FIELDS, "executedSkills"]);
const EMPLOYEE_PROFILE_FIELDS = new Set([
  "displayName", "fact", "promptHash", "promptScope", "promptVersion", "sourceVersion", "subjectId",
]);
const CALLABLE_SKILL_FIELDS = new Set([
  "displayName", "executionMode", "fact", "sourceVersion", "subjectId",
]);
const EXECUTED_SKILL_FIELDS = new Set([
  "activityId", "displayName", "fact", "sequence", "sourceVersion", "status", "subjectId",
]);
const EXECUTION_MODES = new Set(["deterministic_harness", "guidance", "tool_workflow"]);
const ACTIVITY_STATUSES = new Set([
  "blocked", "completed", "failed", "rejected", "started", "target_rejected",
]);
const SAFE_TOKEN = /^[A-Za-z0-9][A-Za-z0-9._:@/-]*$/;
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/;
const HOST_PATH = /^(?:\/|~[\\/]|[A-Za-z]:[\\/]|\\\\)/;
const SECRET_PREFIX = /^(?:bearer[\s._:-]*|sk-|rk-|xox[baprs]-|gh[pousr]_|glpat-|ya29\.)/i;

function normalizeRuntimeSafeProvenanceSource(value, {
  expectedEmployeeId = "",
  expectedEmployeeVersion = "",
  expectedTaskId = "",
} = {}) {
  exactObject(value, SOURCE_FIELDS, "runtime_safe_provenance_source_invalid");
  if (value.contractVersion !== RUNTIME_SAFE_PROVENANCE_SOURCE_CONTRACT_VERSION) {
    throw provenanceError("runtime_safe_provenance_source_contract_invalid");
  }
  const taskId = requiredToken(value.taskId, "taskId", 128);
  const employeeProfile = normalizeEmployeeProfile(value.employeeProfile);
  if (expectedTaskId && taskId !== expectedTaskId) {
    throw provenanceError("runtime_safe_provenance_task_mismatch");
  }
  if (expectedEmployeeId && employeeProfile.subjectId !== expectedEmployeeId) {
    throw provenanceError("runtime_safe_provenance_employee_mismatch");
  }
  if (expectedEmployeeVersion && employeeProfile.sourceVersion !== expectedEmployeeVersion) {
    throw provenanceError("runtime_safe_provenance_employee_version_mismatch");
  }
  const callableSkills = normalizeCallableSkills(value.callableSkills);
  return deepFreeze({
    contractVersion: RUNTIME_SAFE_PROVENANCE_SOURCE_CONTRACT_VERSION,
    taskId,
    employeeProfile,
    callableSkills,
  });
}

function normalizeRuntimeSafeProvenance(value, options = {}) {
  exactObject(value, PUBLIC_FIELDS, "runtime_safe_provenance_invalid");
  if (value.contractVersion !== RUNTIME_SAFE_PROVENANCE_CONTRACT_VERSION) {
    throw provenanceError("runtime_safe_provenance_contract_invalid");
  }
  const source = normalizeRuntimeSafeProvenanceSource({
    contractVersion: RUNTIME_SAFE_PROVENANCE_SOURCE_CONTRACT_VERSION,
    taskId: value.taskId,
    employeeProfile: value.employeeProfile,
    callableSkills: value.callableSkills,
  }, options);
  const executedSkills = normalizeExecutedSkills(value.executedSkills, source.callableSkills);
  return deepFreeze({
    contractVersion: RUNTIME_SAFE_PROVENANCE_CONTRACT_VERSION,
    taskId: source.taskId,
    employeeProfile: source.employeeProfile,
    callableSkills: source.callableSkills,
    executedSkills,
  });
}

function normalizeEmployeeProfile(value) {
  exactObject(value, EMPLOYEE_PROFILE_FIELDS, "runtime_safe_provenance_employee_invalid");
  if (value.fact !== "applied") throw provenanceError("runtime_safe_provenance_employee_fact_invalid");
  return Object.freeze({
    fact: "applied",
    subjectId: requiredToken(value.subjectId, "employeeProfile.subjectId", 160),
    displayName: requiredDisplayName(value.displayName, "employeeProfile.displayName"),
    sourceVersion: requiredToken(value.sourceVersion, "employeeProfile.sourceVersion", 120),
    promptScope: optionalToken(value.promptScope, "employeeProfile.promptScope", 160),
    promptVersion: requiredToken(value.promptVersion, "employeeProfile.promptVersion", 160),
    promptHash: optionalToken(value.promptHash, "employeeProfile.promptHash", 180),
  });
}

function normalizeCallableSkills(value) {
  if (!Array.isArray(value) || value.length > MAX_CALLABLE_SKILLS) {
    throw provenanceError("runtime_safe_provenance_callable_skills_invalid");
  }
  const subjectIds = new Set();
  return Object.freeze(value.map((item) => {
    exactObject(item, CALLABLE_SKILL_FIELDS, "runtime_safe_provenance_callable_skill_invalid");
    if (item.fact !== "callable") throw provenanceError("runtime_safe_provenance_callable_fact_invalid");
    const subjectId = requiredToken(item.subjectId, "callableSkills.subjectId", 160);
    if (subjectIds.has(subjectId)) throw provenanceError("runtime_safe_provenance_callable_skill_duplicate");
    subjectIds.add(subjectId);
    return Object.freeze({
      fact: "callable",
      subjectId,
      displayName: requiredDisplayName(item.displayName, "callableSkills.displayName"),
      sourceVersion: requiredToken(item.sourceVersion, "callableSkills.sourceVersion", 120),
      executionMode: enumToken(item.executionMode, EXECUTION_MODES, "callableSkills.executionMode"),
    });
  }));
}

function normalizeExecutedSkills(value, callableSkills) {
  if (!Array.isArray(value) || value.length > MAX_CALLABLE_SKILLS) {
    throw provenanceError("runtime_safe_provenance_executed_skills_invalid");
  }
  const callableById = new Map(callableSkills.map((skill) => [skill.subjectId, skill]));
  const activityIds = new Set();
  let previousSequence = 0;
  return Object.freeze(value.map((item) => {
    exactObject(item, EXECUTED_SKILL_FIELDS, "runtime_safe_provenance_executed_skill_invalid");
    if (item.fact !== "executed") throw provenanceError("runtime_safe_provenance_executed_fact_invalid");
    const activityId = requiredToken(item.activityId, "executedSkills.activityId", 200);
    const sequence = boundedInteger(item.sequence, "executedSkills.sequence", 1, 10_000);
    const subjectId = requiredToken(item.subjectId, "executedSkills.subjectId", 160);
    const callable = callableById.get(subjectId);
    if (!callable || callable.executionMode !== "deterministic_harness" ||
      item.sourceVersion !== callable.sourceVersion) {
      throw provenanceError("runtime_safe_provenance_execution_source_mismatch");
    }
    if (activityIds.has(activityId) || sequence <= previousSequence) {
      throw provenanceError("runtime_safe_provenance_execution_identity_invalid");
    }
    activityIds.add(activityId);
    previousSequence = sequence;
    return Object.freeze({
      fact: "executed",
      activityId,
      sequence,
      subjectId,
      displayName: requiredDisplayName(item.displayName, "executedSkills.displayName"),
      sourceVersion: callable.sourceVersion,
      status: enumToken(item.status, ACTIVITY_STATUSES, "executedSkills.status"),
    });
  }));
}

function exactObject(value, fields, code) {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
    Object.keys(value).length !== fields.size ||
    Object.keys(value).some((field) => !fields.has(field)) ||
    [...fields].some((field) => !Object.hasOwn(value, field))) {
    throw provenanceError(code);
  }
}

function requiredDisplayName(value, field) {
  if (typeof value !== "string" || value !== value.trim() || !value || value.length > 160 ||
    CONTROL_CHARACTERS.test(value) || HOST_PATH.test(value) || SECRET_PREFIX.test(value)) {
    throw provenanceError("runtime_safe_provenance_display_name_invalid", field);
  }
  return value;
}

function requiredToken(value, field, maxLength) {
  if (typeof value !== "string" || value !== value.trim() || !value || value.length > maxLength ||
    !SAFE_TOKEN.test(value) || SECRET_PREFIX.test(value)) {
    throw provenanceError("runtime_safe_provenance_token_invalid", field);
  }
  return value;
}

function optionalToken(value, field, maxLength) {
  if (value === "") return "";
  return requiredToken(value, field, maxLength);
}

function enumToken(value, allowed, field) {
  const token = requiredToken(value, field, 120);
  if (!allowed.has(token)) throw provenanceError("runtime_safe_provenance_enum_invalid", field);
  return token;
}

function boundedInteger(value, field, minimum, maximum) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw provenanceError("runtime_safe_provenance_integer_invalid", field);
  }
  return value;
}

function deepFreeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    Object.values(value).forEach(deepFreeze);
  }
  return value;
}

function provenanceError(code, field = "") {
  const error = new Error(field ? `${code}:${field}` : code);
  error.code = code;
  return error;
}

export {
  MAX_CALLABLE_SKILLS,
  RUNTIME_SAFE_PROVENANCE_CONTRACT_VERSION,
  RUNTIME_SAFE_PROVENANCE_SOURCE_CONTRACT_VERSION,
  normalizeRuntimeSafeProvenance,
  normalizeRuntimeSafeProvenanceSource,
};
