function projectRuntimeBusinessSkills({
  businessSkills = [],
  catalogSkillReviewStates = new Map(),
  publishedBusinessSkills = new Map(),
  runtimeSkillProjections = new Map(),
  skillById = new Map(),
  status = "",
  departmentId = "",
  domain = "",
  risk = "",
} = {}) {
  const reviewStateById = collectionMap(catalogSkillReviewStates);
  const publishedSkillById = collectionMap(publishedBusinessSkills);
  const runtimeProjectionById = collectionMap(runtimeSkillProjections);
  const currentSkillById = collectionMap(skillById);
  const catalogSkills = businessSkills.map((skill) => {
    const currentSkill = currentSkillById.get(skill.id) || publishedSkillById.get(skill.id) || skill;
    const runtimeProjection = runtimeProjectionById.get(skill.id);
    const state = reviewStateById.get(skill.id);
    const projectedSkill = currentSkill.status === "mvp_skill_published"
      ? currentSkill
      : !state?.mvpPublication
        ? currentSkill
        : {
            ...currentSkill,
            status: state.status || currentSkill.status,
            runtimeEligibility: { allowed: true, reason: "mvp_skill_review_approved" },
            mvpPublication: state.mvpPublication,
        };
    return runtimeProjection && typeof runtimeProjection === "object"
      ? { ...projectedSkill, ...runtimeProjection, id: projectedSkill.id }
      : projectedSkill;
  });
  const catalogSkillIds = new Set(businessSkills.map((skill) => skill.id));
  const importedSkills = [...publishedSkillById.values()].filter((skill) => !catalogSkillIds.has(skill.id));
  return [...catalogSkills, ...importedSkills]
    .filter((skill) => !status || skill.status === status)
    .filter((skill) => !departmentId || skill.departmentId === departmentId)
    .filter((skill) => !domain || skill.domain === domain)
    .filter((skill) => !risk || skill.risk === risk)
    .sort((left, right) => {
      const leftTime = left.mvpPublication?.publishedAt || left.updatedAt || left.version || "";
      const rightTime = right.mvpPublication?.publishedAt || right.updatedAt || right.version || "";
      return String(rightTime).localeCompare(String(leftTime));
    });
}

async function fetchRuntimeSkillCatalog({ baseUrl, fetch = globalThis.fetch } = {}) {
  const origin = String(baseUrl || "").replace(/\/$/, "");
  if (!origin) throw new Error("runtime_skill_catalog_origin_required");
  const [basicResponse, businessResponse] = await Promise.all([
    fetch(`${origin}/api/basic-skills`),
    fetch(`${origin}/api/business-skills`),
  ]);
  if (!basicResponse.ok || !businessResponse.ok) {
    throw new Error(`runtime_skill_catalog_unavailable:${basicResponse.status}:${businessResponse.status}`);
  }
  const [basicPayload, businessPayload] = await Promise.all([
    basicResponse.json(),
    businessResponse.json(),
  ]);
  if (!Array.isArray(basicPayload.basicSkills) || !Array.isArray(businessPayload.businessSkills)) {
    throw new Error("runtime_skill_catalog_contract_invalid");
  }
  const skillById = new Map();
  [...basicPayload.basicSkills, ...businessPayload.businessSkills].forEach((skill) => {
    if (skill?.id) skillById.set(skill.id, skill);
  });
  return {
    skills: [...skillById.values()],
    source: "management_catalog_api",
  };
}

function collectionMap(value) {
  if (value instanceof Map) return value;
  if (!value || typeof value !== "object" || Array.isArray(value)) return new Map();
  return new Map(Object.entries(value));
}

export { fetchRuntimeSkillCatalog, projectRuntimeBusinessSkills };
