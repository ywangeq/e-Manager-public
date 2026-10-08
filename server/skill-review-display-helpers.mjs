const smossConfigSkillNames = {};

export function createMountedSkillSummarizer({
  businessSkills,
  publishedBusinessSkills,
  mvpSkillPublications,
  importJobs,
  draftRefsForJob,
  cleanEntityId,
  cleanList,
  cleanText,
}) {
  function summarizeMountedSkillHints(hints = []) {
    return cleanList(hints).map((hint) => {
      const skill = findSkillSummaryForHint(hint);
      const id = cleanText(skill?.id || skill?.skillId || hint);
      const skillApiId = cleanText(skill?.skillApiId || id);
      const sourceSkillId = cleanText(skill?.sourceSkillId || "");
      return {
        id,
        skillApiId,
        sourceSkillId,
        name: displayNameForMountedSkill({ hint, skill, id }),
        status: cleanText(skill?.status || ""),
        domain: cleanText(skill?.domain || skill?.businessGroup || ""),
        source: cleanText(skill?.source || ""),
      };
    });
  }

  function findSkillSummaryForHint(hint) {
    const rawHint = cleanText(hint);
    const normalizedHint = cleanEntityId(rawHint);
    if (!rawHint) return null;
    const candidates = [
      ...[...publishedBusinessSkills.values()].map((skill) => ({ ...skill, source: "runtime-publication" })),
      ...[...mvpSkillPublications.values()].map((publication) => ({ ...publication, id: publication.skillId, source: "mvp-publication" })),
      ...[...importJobs.values()].flatMap((job) => draftRefsForJob(job)
        .filter(({ kind }) => kind === "skillDrafts" || kind === "skillUpdateDrafts")
        .map(({ draft }) => ({
          ...draft,
          id: draft.skillId,
          source: "import-draft",
        }))),
      ...businessSkills.map((skill) => ({ ...skill, source: "catalog" })),
    ];
    return candidates.find((skill) => skillMatchesHint(skill, rawHint, normalizedHint)) || null;
  }

  function skillMatchesHint(skill, rawHint, normalizedHint) {
    return [
      skill?.id,
      skill?.skillId,
      skill?.skillApiId,
      skill?.sourceSkillId,
      skill?.lineageKey,
    ].some((value) => {
      const text = cleanText(value);
      return text && (text === rawHint || cleanEntityId(text) === normalizedHint);
    });
  }

  function displayNameForMountedSkill({ hint, skill, id }) {
    const rawHint = cleanText(hint);
    const rawName = cleanText(skill?.name || skill?.title || "");
    if (rawName && rawName !== rawHint && rawName !== id) return rawName;
    return friendlySkillNameForId(id || rawHint, { cleanEntityId, cleanText });
  }

  return summarizeMountedSkillHints;
}

export function friendlySkillNameForId(value, { cleanEntityId, cleanText }) {
  const id = cleanEntityId(value);
  return smossConfigSkillNames[id] || cleanText(value);
}
