import { readFile } from "node:fs/promises";
import path from "node:path";
import { inspectPublishedSkillHarnessReadiness } from "./agent-runtime/published-skill-harness-readiness.mjs";
import { resolveDigitalWorkforceDataDir } from "./local-data-root.mjs";
import { createSkillHarnessRunner } from "./skill-harness-runner.mjs";
import { selectSkillPublicationHead } from "./skill-version-helpers.mjs";
import { draftRefsForJob } from "./system-import-review-helpers.mjs";

export async function checkPublishedSkillHarnesses() {
  const dataDir = resolveDigitalWorkforceDataDir();
  const statePath = process.env.SYSTEM_IMPORT_STORE_PATH || path.join(dataDir, "system-import-state.json");
  const publishedSkills = await readPublishedSkills(statePath);
  const skillHarnessRunner = createSkillHarnessRunner({ getPublishedSkills: () => publishedSkills });
  const result = await inspectPublishedSkillHarnessReadiness({ publishedSkills, skillHarnessRunner });
  if (!result.ok) throw new Error("published_skill_harness_preflight_failed");
  return result;
}

async function readPublishedSkills(filePath) {
  try {
    const state = JSON.parse(await readFile(filePath, "utf8"));
    return Object.values(state?.publishedBusinessSkills || {}).map((skill) => (
      recoveredSkillHeadForReadiness(skill, state)
    ));
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }
}

function recoveredSkillHeadForReadiness(skill = {}, state = {}) {
  if (skill?.mvpPublication?.deployment?.status === "ready") return skill;
  const skillId = String(skill?.id || "").trim();
  if (!skillId) return skill;
  const publications = Object.values(state?.mvpSkillPublications || {})
    .filter((publication) => publication?.skillId === skillId);
  const resolveDraft = (publication) => {
    const job = state?.importJobs?.[publication?.sourceJobId];
    return job
      ? draftRefsForJob(job).find(({ draft }) => draft?.draftId === publication?.sourceDraftId)?.draft || null
      : null;
  };
  const head = selectSkillPublicationHead({
    publications,
    resolveDraft,
    baselineVersion: skill.version,
  });
  if (!head || head.publication?.publicationId === skill?.mvpPublication?.publicationId) return skill;
  return {
    ...skill,
    version: head.publication.version,
    runtimeExecutionProfile: head.draft.runtimeExecutionProfile || skill.runtimeExecutionProfile,
    runtimeHarnessIdentity: head.draft.runtimeHarnessIdentity || skill.runtimeHarnessIdentity,
  };
}
