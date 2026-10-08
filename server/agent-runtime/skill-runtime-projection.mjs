const SKILL_RUNTIME_PROJECTION_CONTRACT = "digital-employee-skill-runtime-projection.v1";

async function resolveSkillRuntimeProjection({ skillHarnessRunner = null, skillScope = {}, runtimeTask = null } = {}) {
  const deterministicHarnessSkillIds = uniqueList(skillScope.deterministicHarnessSkillIds || []);
  if (!deterministicHarnessSkillIds.length) {
    return {
      contractVersion: SKILL_RUNTIME_PROJECTION_CONTRACT,
      deterministicHarnessSkillIds: [],
      verifiedHarnessSkillIds: [],
      blockedHarnessSkills: [],
      completionEvidenceCapabilities: [],
      materialInputContracts: [],
    };
  }

  try {
    if (runtimeTask && typeof skillHarnessRunner?.forTask === "function") skillHarnessRunner = await skillHarnessRunner.forTask(runtimeTask);
    const readiness = typeof skillHarnessRunner?.inspectHarnessReadiness === "function"
      ? await skillHarnessRunner.inspectHarnessReadiness(deterministicHarnessSkillIds)
      : await inspectLegacyRunner(skillHarnessRunner, deterministicHarnessSkillIds);
    const verified = new Set(uniqueList(readiness?.verifiedSkillIds || []));
    const verifiedHarnessSkillIds = deterministicHarnessSkillIds.filter((skillId) => verified.has(skillId));
    const materialInputContracts = typeof skillHarnessRunner?.materialInputContracts === "function"
      ? await skillHarnessRunner.materialInputContracts(verifiedHarnessSkillIds)
      : [];
    const completionEvidenceCapabilities = typeof skillHarnessRunner?.completionEvidenceCapabilities === "function"
      ? await skillHarnessRunner.completionEvidenceCapabilities(verifiedHarnessSkillIds)
      : [];
    return {
      contractVersion: SKILL_RUNTIME_PROJECTION_CONTRACT,
      deterministicHarnessSkillIds,
      verifiedHarnessSkillIds,
      blockedHarnessSkills: (readiness?.blockedSkills || []).map(safeBlockedHarness).filter(Boolean),
      completionEvidenceCapabilities: Array.isArray(completionEvidenceCapabilities)
        ? completionEvidenceCapabilities
        : [],
      materialInputContracts: Array.isArray(materialInputContracts) ? materialInputContracts : [],
      skillHarnessRunner,
    };
  } catch {
    return {
      contractVersion: SKILL_RUNTIME_PROJECTION_CONTRACT,
      deterministicHarnessSkillIds,
      verifiedHarnessSkillIds: [],
      blockedHarnessSkills: deterministicHarnessSkillIds.map((skillId) => ({
        skillId,
        status: "skill_harness_readiness_unavailable",
      })),
      completionEvidenceCapabilities: [],
      materialInputContracts: [],
    };
  }
}

async function inspectLegacyRunner(skillHarnessRunner, skillIds) {
  if (typeof skillHarnessRunner?.hasHarness !== "function") {
    return {
      verifiedSkillIds: [],
      blockedSkills: skillIds.map((skillId) => ({ skillId, status: "skill_harness_runner_unavailable" })),
    };
  }
  const results = await Promise.all(skillIds.map(async (skillId) => ({
    skillId,
    verified: await skillHarnessRunner.hasHarness(skillId),
  })));
  return {
    verifiedSkillIds: results.filter((item) => item.verified).map((item) => item.skillId),
    blockedSkills: results.filter((item) => !item.verified).map((item) => ({
      skillId: item.skillId,
      status: "skill_harness_not_ready",
    })),
  };
}

function safeBlockedHarness(value = {}) {
  const skillId = cleanId(value.skillId);
  const status = cleanId(value.status);
  return skillId && status ? { skillId, status } : null;
}

function uniqueList(values = []) {
  return [...new Set((Array.isArray(values) ? values : []).map(cleanId).filter(Boolean))];
}

function cleanId(value = "") {
  return String(value || "").trim().slice(0, 160);
}

export { SKILL_RUNTIME_PROJECTION_CONTRACT, resolveSkillRuntimeProjection };
