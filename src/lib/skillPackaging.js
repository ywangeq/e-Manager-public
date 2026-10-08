const dependencyFields = [
  "packageBundleSkillIds",
  "bundledSkillIds",
  "dependencySkillIds",
  "apiDependencySkillIds",
  "apiCalledSkillIds",
  "runtimeSkillIds",
  "referenceSkillIds",
  "linkedSkillIds",
];

function cleanList(items = []) {
  return (Array.isArray(items) ? items : [items])
    .map((item) => String(item || "").trim())
    .filter(Boolean);
}

function uniqueItems(items = []) {
  return Array.from(new Set(cleanList(items)));
}

function skillLabel(skill = {}) {
  const name = skill.name || skill.skillApiId || skill.id;
  const id = skill.skillApiId || skill.id;
  return name && id && name !== id ? `${name}（${id}）` : name || id;
}

function skillDependencyIds(skill = {}) {
  const apiEndpointIds = cleanList(skill.apiEndpoints)
    .flatMap((endpoint) => cleanList(endpoint?.calledSkillIds || endpoint?.skillIds || endpoint?.dependencies));
  return uniqueItems([
    ...dependencyFields.flatMap((field) => cleanList(skill[field])),
    ...apiEndpointIds,
  ]).filter((id) => id !== skill.id);
}

export function buildSkillPackageBundle(rootSkillIds = [], skills = []) {
  const skillById = new Map(skills.map((skill) => [skill.id, skill]));
  const rootIds = uniqueItems(rootSkillIds);
  const includedIds = [];
  const missingDependencyIds = [];
  const visited = new Set();
  const visiting = [...rootIds];

  while (visiting.length) {
    const skillId = visiting.shift();
    if (visited.has(skillId)) continue;
    visited.add(skillId);

    const skill = skillById.get(skillId);
    if (!skill) {
      missingDependencyIds.push(skillId);
      continue;
    }

    includedIds.push(skillId);
    skillDependencyIds(skill).forEach((dependencyId) => {
      if (!visited.has(dependencyId)) visiting.push(dependencyId);
    });
  }

  const rootIdSet = new Set(rootIds);
  const dependencyIds = includedIds.filter((id) => !rootIdSet.has(id));
  const missing = uniqueItems(missingDependencyIds);

  return {
    rootSkillIds: rootIds,
    includedSkillIds: includedIds,
    dependencySkillIds: dependencyIds,
    includedSkills: includedIds.map((id) => skillById.get(id)).filter(Boolean),
    dependencySkills: dependencyIds.map((id) => skillById.get(id)).filter(Boolean),
    includedLabels: includedIds.map((id) => skillLabel(skillById.get(id))).filter(Boolean),
    dependencyLabels: dependencyIds.map((id) => skillLabel(skillById.get(id))).filter(Boolean),
    missingDependencyIds: missing,
    warnings: missing.length ? [`缺少依赖 Skill：${missing.join("、")}`] : [],
  };
}

export function packageBundleChips(bundle = {}) {
  const labels = cleanList(bundle.includedLabels);
  const warnings = cleanList(bundle.warnings);
  return labels.length ? [...labels, ...warnings] : warnings;
}
