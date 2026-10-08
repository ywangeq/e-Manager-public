import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

export function loadSystemImportStore(storePath) {
  if (!storePath) return {};
  try {
    if (!fs.existsSync(storePath)) return {};
    const raw = fs.readFileSync(storePath, "utf8");
    if (!raw.trim()) return {};
    return normalizeSystemImportStoreState(JSON.parse(raw));
  } catch (error) {
    console.warn(`[system-import] failed to load system import store: ${error?.message || error}`);
    return {};
  }
}

export function persistSystemImportStore({
  storePath,
  importJobs,
  skillEmployeeReviews,
  mvpSkillPublications,
  publishedBusinessSkills,
  runtimeSkillProjections,
  digitalEmployeeReviews,
  mvpDigitalEmployeeStates,
  catalogSkillReviewStates,
  skillAgentPreReview,
  cleanText,
}) {
  if (!storePath) return { ok: true };
  const temporaryPath = `${storePath}.${randomUUID()}.tmp`;
  let committed = false;
  try {
    fs.mkdirSync(path.dirname(storePath), { recursive: true });
    const agentState = skillAgentPreReview.snapshot();
    fs.writeFileSync(
      temporaryPath,
      JSON.stringify(
        {
          version: "system-import-state.v1",
          updatedAt: new Date().toISOString(),
          importJobs: Object.fromEntries(importJobs.entries()),
          skillEmployeeReviews: Object.fromEntries(skillEmployeeReviews.entries()),
          mvpSkillPublications: Object.fromEntries(mvpSkillPublications.entries()),
          publishedBusinessSkills: Object.fromEntries(publishedBusinessSkills.entries()),
          runtimeSkillProjections: Object.fromEntries(runtimeSkillProjections.entries()),
          digitalEmployeeReviews: Object.fromEntries(digitalEmployeeReviews.entries()),
          mvpDigitalEmployeeStates: Object.fromEntries(mvpDigitalEmployeeStates.entries()),
          catalogSkillReviewStates: Object.fromEntries(catalogSkillReviewStates.entries()),
          agentPreReviewExecutions: agentState.executions,
          agentPreReviewQualityEvents: agentState.qualityEvents,
        },
        null,
        2,
      ),
    );
    fs.chmodSync(temporaryPath, 0o600);
    const fd = fs.openSync(temporaryPath, "r");
    try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    fs.renameSync(temporaryPath, storePath);
    committed = true;
    const directoryFd = fs.openSync(path.dirname(storePath), "r");
    try { fs.fsyncSync(directoryFd); } finally { fs.closeSync(directoryFd); }
    return { ok: true };
  } catch (error) {
    if (committed) {
      // Rename is the commit point. Returning failure would make callers restore
      // stale memory while other processes already see the new publication.
      // Stop this writer; the service supervisor reloads the disk authority.
      console.error("system_import_store_committed_durability_uncertain");
      process.exit(70);
    }
    console.warn(`[system-import] failed to persist system import store: ${error?.message || error}`);
    return { ok: false, error: cleanText(error?.message || error) };
  } finally {
    try { fs.rmSync(temporaryPath, { force: true }); } catch { /* A failed parent creation leaves no temporary file. */ }
  }
}

export function systemImportSnapshot({
  importJobs,
  skillEmployeeReviews,
  mvpSkillPublications,
  publishedBusinessSkills,
  runtimeSkillProjections,
  digitalEmployeeReviews,
  mvpDigitalEmployeeStates,
  catalogSkillReviewStates,
  skillAgentPreReview,
}) {
  const agentState = skillAgentPreReview.snapshot();
  return {
    importJobs: Object.fromEntries(importJobs.entries()),
    skillEmployeeReviews: Object.fromEntries(skillEmployeeReviews.entries()),
    mvpSkillPublications: Object.fromEntries(mvpSkillPublications.entries()),
    publishedBusinessSkills: Object.fromEntries(publishedBusinessSkills.entries()),
    runtimeSkillProjections: Object.fromEntries(runtimeSkillProjections.entries()),
    digitalEmployeeReviews: Object.fromEntries(digitalEmployeeReviews.entries()),
    mvpDigitalEmployeeStates: Object.fromEntries(mvpDigitalEmployeeStates.entries()),
    catalogSkillReviewStates: Object.fromEntries(catalogSkillReviewStates.entries()),
    agentPreReviewExecutions: agentState.executions,
    agentPreReviewQualityEvents: agentState.qualityEvents,
  };
}

export function restoreSystemImportSnapshot({
  snapshot = {},
  importJobs,
  skillEmployeeReviews,
  mvpSkillPublications,
  publishedBusinessSkills,
  runtimeSkillProjections,
  digitalEmployeeReviews,
  mvpDigitalEmployeeStates,
  catalogSkillReviewStates,
  skillAgentPreReview,
}) {
  replaceMap(importJobs, snapshot.importJobs);
  replaceMap(skillEmployeeReviews, snapshot.skillEmployeeReviews);
  replaceMap(mvpSkillPublications, snapshot.mvpSkillPublications);
  replaceMap(publishedBusinessSkills, snapshot.publishedBusinessSkills);
  replaceMap(runtimeSkillProjections, snapshot.runtimeSkillProjections);
  replaceMap(digitalEmployeeReviews, snapshot.digitalEmployeeReviews);
  replaceMap(mvpDigitalEmployeeStates, snapshot.mvpDigitalEmployeeStates);
  replaceMap(catalogSkillReviewStates, snapshot.catalogSkillReviewStates);
  skillAgentPreReview.restore({
    executions: snapshot.agentPreReviewExecutions || {},
    qualityEvents: snapshot.agentPreReviewQualityEvents || {},
  });
}

function normalizeSystemImportStoreState(state = {}) {
  return {
    importJobs: plainObject(state.importJobs),
    skillEmployeeReviews: plainObject(state.skillEmployeeReviews),
    mvpSkillPublications: plainObject(state.mvpSkillPublications),
    publishedBusinessSkills: plainObject(state.publishedBusinessSkills),
    runtimeSkillProjections: plainObject(state.runtimeSkillProjections),
    digitalEmployeeReviews: plainObject(state.digitalEmployeeReviews),
    mvpDigitalEmployeeStates: plainObject(state.mvpDigitalEmployeeStates),
    catalogSkillReviewStates: plainObject(state.catalogSkillReviewStates),
    agentPreReviewExecutions: plainObject(state.agentPreReviewExecutions),
    agentPreReviewQualityEvents: plainObject(state.agentPreReviewQualityEvents),
  };
}

function plainObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function replaceMap(target, values = {}) {
  target.clear();
  Object.entries(values || {}).forEach(([key, value]) => target.set(key, value));
}
