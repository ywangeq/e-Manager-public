import { assembleDigitalEmployeeDependencyContext } from "../../agent-runtime/dependency-context.mjs";
import { hasCompleteVerifiedSkillRuntimeDocuments } from "../../agent-runtime/verified-skill-runtime-documents.mjs";

const CONTEXT_CONTRACT_VERSION = "hr-training-evaluation-skill-context.v1";

function createHrTrainingEvaluationSkillContextResolver({
  businessSkills = [],
  getBusinessSkills = null,
  skillId,
} = {}) {
  const exactSkillId = requiredReference(skillId, "skillId");
  if (getBusinessSkills !== null && typeof getBusinessSkills !== "function") {
    throw new TypeError("HR Training evaluation Skill resolver getBusinessSkills must be a function");
  }

  return Object.freeze({
    contractVersion: CONTEXT_CONTRACT_VERSION,
    resolve({ capability, employee, task, taskDefinition, triggerEvent } = {}) {
      const exactSkillPolicyRef = assertFrozenPolicy({ taskDefinition, triggerEvent });
      const currentSkills = typeof getBusinessSkills === "function" ? getBusinessSkills() : businessSkills;
      const dependencyEmployee = capability === "hr_training.content_evaluate.v1"
        ? contentEvaluationEmployeeProjection(employee)
        : employee;
      const dependencyContext = assembleDigitalEmployeeDependencyContext({
        businessSkills: currentSkills,
        channel: {
          channel: "trigger",
          sourceSystemId: "hr-train",
          status: "active",
          receiveMode: "capability_run",
        },
        employee: dependencyEmployee,
        workerBinding: {
          employeeId: employee?.id || task?.employeeId,
          selectedSkillIds: [exactSkillId],
          skillScopeMode: "restricted",
        },
      });
      const sourceSkill = currentSkills.find((item) => item?.id === exactSkillId);
      const skill = dependencyContext.callableSkills.find((item) => item.id === exactSkillId);
      if (!skill || dependencyContext.skillScope.callableSkillIds.length !== 1 ||
        !hasCompleteVerifiedSkillRuntimeDocuments({
          sourceSkill,
          runtimeSkill: skill,
          skillPolicyRef: exactSkillPolicyRef,
        })) {
        throw contextError("hr_training_evaluation_skill_unavailable");
      }
      return Object.freeze({
        ...dependencyContext,
        capabilityScope: Object.freeze({
          ...dependencyContext.capabilityScope,
          source: "frozen_trigger_skill_policy",
          activeCapabilities: [requiredReference(capability, "capability")],
          activeInputs: [capability === "hr_training.aggregate_feedback.v1"
            ? "hr-training.aggregate-feedback-context.v1"
            : capability === "hr_training.followup_round_evaluate.v1"
              ? "hr-training.followup-round-evaluation-context.v3"
              : "hr-training.evaluation-context.v1"],
        }),
      });
    },
  });
}

function contentEvaluationEmployeeProjection(employee = {}) {
  return Object.freeze({
    id: employee.id,
    status: employee.status,
    version: employee.version,
    promptScope: employee.promptScope || employee.promptGovernance?.promptScope,
    promptVersion: employee.promptVersion || employee.promptGovernance?.promptVersion,
    promptHash: employee.promptHash || employee.promptGovernance?.promptHash,
    basicSkillIds: employee.basicSkillIds,
    businessSkillIds: employee.businessSkillIds,
    packageBundleSkillIds: employee.packageBundleSkillIds,
    toolBindings: employee.toolBindings,
  });
}

function assertFrozenPolicy({ taskDefinition, triggerEvent } = {}) {
  const skillPolicyRef = requiredReference(taskDefinition?.skillPolicyRef, "taskDefinition.skillPolicyRef");
  const snapshot = triggerEvent?.executionSnapshot;
  if (taskDefinition?.skillPolicyRef !== skillPolicyRef ||
    snapshot?.skillPolicyRef !== skillPolicyRef ||
    snapshot?.taskDefinitionVersion !== taskDefinition?.taskDefinitionVersion ||
    snapshot?.handlerVersion !== taskDefinition?.handlerVersion) {
    throw contextError("hr_training_evaluation_skill_policy_snapshot_mismatch");
  }
  return skillPolicyRef;
}

function requiredReference(value, field) {
  const text = String(value || "").trim();
  if (!text || text.length > 240 || /[\s\u0000-\u001f\u007f]/.test(text)) {
    throw new TypeError(`HR Training evaluation Skill resolver ${field} is invalid`);
  }
  return text;
}

function contextError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

export {
  CONTEXT_CONTRACT_VERSION as HR_TRAINING_EVALUATION_SKILL_CONTEXT_VERSION,
  createHrTrainingEvaluationSkillContextResolver,
};
