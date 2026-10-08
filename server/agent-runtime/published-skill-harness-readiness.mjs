const RUNNABLE_SKILL_STATUSES = new Set(["mvp_skill_published", "试运行", "可复用"]);

async function inspectPublishedSkillHarnessReadiness({ publishedSkills = [], skillHarnessRunner = null } = {}) {
  const targets = (Array.isArray(publishedSkills) ? publishedSkills : [])
    .filter((skill) => RUNNABLE_SKILL_STATUSES.has(skill?.status))
    .filter((skill) => skill?.runtimeEligibility?.allowed === true)
    .filter((skill) => skill?.runtimeExecutionProfile?.mode === "deterministic_harness")
    .map((skill) => ({
      expectedSafeOutputContract: cleanId(skill?.runtimeHarnessIdentity?.safeOutputContract),
      skillId: cleanId(skill?.id || skill?.skillId),
    }))
    .filter((skill) => skill.skillId);

  if (!targets.length) return readinessResult([], 0);
  if (typeof skillHarnessRunner?.inspectHarnessReadiness !== "function" ||
    typeof skillHarnessRunner?.completionEvidenceCapabilities !== "function") {
    return readinessResult(targets.map(({ skillId }) => ({
      skillId,
      status: "skill_harness_runner_unavailable",
    })), targets.length);
  }

  const skillIds = targets.map(({ skillId }) => skillId);
  const readiness = await skillHarnessRunner.inspectHarnessReadiness(skillIds);
  const blockedBySkillId = new Map((readiness?.blockedSkills || [])
    .map((item) => [cleanId(item?.skillId), cleanId(item?.status)])
    .filter(([skillId, status]) => skillId && status));
  const capabilities = await skillHarnessRunner.completionEvidenceCapabilities(skillIds);
  const capabilityKeys = new Set((Array.isArray(capabilities) ? capabilities : [])
    .map((capability) => {
      const skillId = cleanId(capability?.fixedArguments?.skillId);
      const contractId = cleanId(capability?.contractId);
      return skillId && contractId && capability?.toolName === "run_mounted_skill"
        ? `${skillId}\u0000${contractId}`
        : "";
    })
    .filter(Boolean));
  const blockedSkills = [];

  for (const target of targets) {
    const blockedStatus = blockedBySkillId.get(target.skillId);
    if (blockedStatus) {
      blockedSkills.push({ skillId: target.skillId, status: blockedStatus });
      continue;
    }
    if (!target.expectedSafeOutputContract) {
      blockedSkills.push({
        skillId: target.skillId,
        status: "skill_harness_safe_output_contract_unavailable",
      });
      continue;
    }
    if (!capabilityKeys.has(`${target.skillId}\u0000${target.expectedSafeOutputContract}`)) {
      blockedSkills.push({
        skillId: target.skillId,
        status: "skill_harness_completion_evidence_unavailable",
      });
    }
  }
  return readinessResult(blockedSkills, targets.length);
}

function readinessResult(blockedSkills, checkedSkillCount) {
  return Object.freeze({
    contractVersion: "published-skill-harness-readiness.v1",
    ok: blockedSkills.length === 0,
    checkedSkillCount,
    blockedSkills: Object.freeze(blockedSkills.map((item) => Object.freeze({ ...item }))),
  });
}

function cleanId(value = "") {
  const result = String(value || "").trim();
  return /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,179}$/.test(result) ? result : "";
}

export { inspectPublishedSkillHarnessReadiness };
