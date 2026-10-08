import { resolveSkillRuntimeExecutionProfile } from "./skill-runtime-profile.mjs";

const SKILL_SCOPE_CONTRACT = "digital-employee-skill-scope.v2";

function resolveEffectiveSkillScope({ employee = {}, skills = [], workerBinding = {}, organizationSkillIds = [] } = {}) {
  const employeeMountedSkillIds = uniqueList([
    ...(employee.basicSkillIds || []),
    ...(employee.businessSkillIds || []),
  ]);
  const packageSkillIds = uniqueList(employee.packageBundleSkillIds || []);
  const selectedSkillFieldPresent = Object.prototype.hasOwnProperty.call(workerBinding, "selectedSkillIds");
  const normalizedSelectedSkillIds = selectedSkillFieldPresent ? uniqueList(workerBinding.selectedSkillIds || []) : [];
  const declaredRestrictedSelection = workerBinding.skillScopeMode === "restricted" && selectedSkillFieldPresent;
  const legacyRestrictedSelection = !cleanId(workerBinding.skillScopeMode)
    && selectedSkillFieldPresent
    && normalizedSelectedSkillIds.length > 0;
  const hasExplicitChannelSelection = declaredRestrictedSelection || legacyRestrictedSelection;
  const channelSelectedSkillIds = hasExplicitChannelSelection
    ? normalizedSelectedSkillIds
    : [];
  const requestedSkillIds = hasExplicitChannelSelection
    ? channelSelectedSkillIds
    : uniqueList([...employeeMountedSkillIds, ...organizationSkillIds]);
  const mountedSkillIdSet = new Set(employeeMountedSkillIds);
  const organizationSkillIdSet = new Set(uniqueList(organizationSkillIds));
  const skillById = new Map((skills || []).map((skill) => [cleanId(skill?.id), skill]).filter(([id]) => id));
  const callableSkillIds = [];
  const guidanceSkillIds = [];
  const toolWorkflowSkillIds = [];
  const deterministicHarnessSkillIds = [];
  const runtimeExecutionProfiles = [];
  const blockedSkills = [];

  for (const skillId of requestedSkillIds) {
    if (!mountedSkillIdSet.has(skillId) && !organizationSkillIdSet.has(skillId)) {
      blockedSkills.push(blockedSkill(skillId, "channel_skill_not_mounted"));
      continue;
    }
    const skill = skillById.get(skillId);
    if (!skill) {
      blockedSkills.push(blockedSkill(skillId, "skill_catalog_entry_missing"));
      continue;
    }
    const eligibility = skillRuntimeEligibility(skill);
    if (!eligibility.allowed) {
      blockedSkills.push(blockedSkill(skillId, eligibility.reason, skill.status));
      continue;
    }
    const runtimeProfile = resolveSkillRuntimeExecutionProfile(skill);
    if (!runtimeProfile) {
      blockedSkills.push(blockedSkill(
        skillId,
        skill.runtimeExecutionProfile == null
          ? "skill_runtime_execution_profile_missing"
          : "skill_runtime_execution_profile_invalid",
        skill.status,
      ));
      continue;
    }
    callableSkillIds.push(skillId);
    runtimeExecutionProfiles.push({ skillId, ...runtimeProfile });
    if (runtimeProfile.mode === "deterministic_harness") deterministicHarnessSkillIds.push(skillId);
    else if (runtimeProfile.mode === "tool_workflow") toolWorkflowSkillIds.push(skillId);
    else guidanceSkillIds.push(skillId);
  }

  return {
    contractVersion: SKILL_SCOPE_CONTRACT,
    selectionMode: hasExplicitChannelSelection ? "channel_explicit" : "employee_mount_default",
    selectionSource: declaredRestrictedSelection
      ? "declared_mode"
      : legacyRestrictedSelection
        ? "legacy_nonempty_selection"
        : "employee_mount_default",
    ...(organizationSkillIdSet.size ? { organizationSkillIds: [...organizationSkillIdSet] } : {}),
    packageSkillIds,
    employeeMountedSkillIds,
    channelSelectedSkillIds,
    requestedSkillIds,
    callableSkillIds,
    guidanceSkillIds,
    toolWorkflowSkillIds,
    deterministicHarnessSkillIds,
    runtimeExecutionProfiles,
    blockedSkills,
    ...(legacyRestrictedSelection ? {
      compatibility: {
        owner: "Channel worker binding migration",
        removalCondition: "all_worker_bindings_declare_skill_scope_mode",
      },
    } : {}),
  };
}

function skillRuntimeEligibility(skill = {}) {
  const declared = skill.runtimeEligibility;
  if (typeof declared?.allowed === "boolean") {
    return {
      allowed: declared.allowed,
      reason: cleanId(declared.reason) || (declared.allowed ? "runtime_eligibility_declared" : "skill_governance_not_callable"),
    };
  }
  return { allowed: false, reason: "skill_runtime_eligibility_missing" };
}

function blockedSkill(skillId, reason, status = "") {
  return {
    skillId: cleanId(skillId),
    reason: cleanId(reason),
    status: cleanId(status),
  };
}

function uniqueList(values = []) {
  return [...new Set((Array.isArray(values) ? values : [values]).map(cleanId).filter(Boolean))];
}

function cleanId(value = "") {
  return String(value || "").trim().slice(0, 160);
}

export {
  SKILL_SCOPE_CONTRACT,
  resolveEffectiveSkillScope,
  skillRuntimeEligibility,
};
