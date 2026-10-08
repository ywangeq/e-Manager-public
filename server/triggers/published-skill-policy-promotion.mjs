const POLICY_PREFIX = "skill-policy:";
const SKILL_POLICY = /^skill-policy:([A-Za-z0-9][A-Za-z0-9._-]{0,159})@([A-Za-z0-9][A-Za-z0-9._-]{0,159})$/;
const VERSION = /^[A-Za-z0-9][A-Za-z0-9._-]{0,159}$/;

function applyPublishedSkillPolicyHeadPromotion({ configRepository, publishedBusinessSkills } = {}) {
  if (typeof configRepository?.loadPublishedConfiguration !== "function" ||
    typeof configRepository?.applyTaskDefinitionMigration !== "function") {
    throw new TypeError("published Skill policy promotion requires the Trigger configuration repository");
  }
  const heads = publishedSkillHeads(publishedBusinessSkills);
  const promotions = [];
  for (const definition of configRepository.loadPublishedConfiguration().taskDefinitions) {
    const current = parseSkillPolicyRef(definition.skillPolicyRef);
    const version = heads.get(current?.skillId);
    if (!version || version === current.version) continue;
    const replacement = Object.freeze({
      ...definition,
      taskDefinitionVersion: promotedTaskDefinitionVersion(version),
      skillPolicyRef: `${POLICY_PREFIX}${current.skillId}@${version}`,
    });
    const result = configRepository.applyTaskDefinitionMigration({
      migrationId: `published-skill-policy-head:${definition.taskDefinitionId}:${version}`,
      expectedDefinitions: [definition],
      replacement,
    });
    promotions.push(Object.freeze({
      taskDefinitionId: definition.taskDefinitionId,
      version,
      migrated: result.migrated === true,
    }));
  }
  return Object.freeze(promotions);
}

function publishedSkillHeads(value) {
  const entries = value instanceof Map
    ? [...value.entries()]
    : value && typeof value === "object" && !Array.isArray(value)
      ? Object.entries(value)
      : [];
  const heads = new Map();
  for (const [mapSkillId, skill] of entries) {
    const skillId = String(skill?.id || mapSkillId || "").trim();
    const version = String(skill?.version || "").trim();
    if (skill?.status !== "mvp_skill_published" || !VERSION.test(skillId) || !VERSION.test(version)) continue;
    heads.set(skillId, version);
  }
  return heads;
}

function parseSkillPolicyRef(value) {
  const match = SKILL_POLICY.exec(String(value || "").trim());
  return match ? Object.freeze({ skillId: match[1], version: match[2] }) : null;
}

function promotedTaskDefinitionVersion(skillVersion) {
  const suffix = String(skillVersion || "").replace(/^skill-/, "");
  const version = `task-definition-${suffix}`;
  if (!VERSION.test(version) || version.length > 80) {
    throw new TypeError("published Skill version cannot produce a Trigger task definition version");
  }
  return version;
}

export { applyPublishedSkillPolicyHeadPromotion };
