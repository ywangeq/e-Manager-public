import { assertGroupScope, groupContentDigest, groupContractError, groupId } from "./group-contracts-v1.mjs";
import { readGroupReworkSource } from "./group-rework-source.mjs";

// Read-only access to explicitly published rejected opinions. This never grants
// reusable-material access, changes terminal status, or authorizes a new Run.
export function createGroupReviewOpinionReader({ taskRepository, taskArtifactService, authorizeReviewer }) {
  if (!taskRepository?.groups || typeof taskArtifactService?.resolveDownload !== "function" || typeof authorizeReviewer !== "function") throw new TypeError("group opinion reader requires canonical authorities");
  function source(actor, runId, stepId, taskId, artifactId) {
    const run = taskRepository.groups.readRun(actor, runId);
    if (!run || run.runId !== runId) throw groupContractError("group_run_not_found");
    const plan = taskRepository.groups.readPlan(actor, run.planId, run.planRevision);
    if (!plan || plan.planId !== run.planId || plan.revision !== run.planRevision) throw groupContractError("group_review_opinion_unavailable");
    assertGroupScope(run, actor); assertGroupScope(plan, actor);
    const step = plan.steps.find(step => step.stepId === stepId);
    const binding = run.stepBindings.find(binding => binding.stepId === stepId && binding.taskId === taskId);
    const task = taskRepository.get(taskId, { tenantScope: actor.tenantScope });
    if (!step || !binding || !task || step.kind !== "review" || step.outputScope !== "group" || binding.round !== step.round ||
        task.taskType !== "group_step" || task.sourceSystemId !== "group_studio" || task.submissionScope !== `group:${runId}` ||
        task.status !== "failed" || task.lastErrorCode !== "group_review_rejected" ||
        task.employeeId !== step.employeeId || task.employeeVersion !== step.employeeVersion) throw groupContractError("group_review_opinion_unavailable");
    assertGroupScope(task, actor);
    const artifacts = taskRepository.listArtifacts({ tenantScope: actor.tenantScope, taskId });
    const artifact = artifacts.find(item => item.artifactId === artifactId && item.fileName === "group-result.md" && item.mimeType === "text/markdown");
    if (!artifact) throw groupContractError("group_review_opinion_unavailable");
    return { step, task, artifact };
  }
  async function read({ actor, session, runId }) {
    groupId(runId);
    const run = taskRepository.groups.readRun(actor, runId);
    if (!run || run.runId !== runId) throw groupContractError("group_run_not_found");
    assertGroupScope(run, actor);
    const opinions = [];
    const sources = [];
    for (const binding of run.stepBindings) {
      const task = taskRepository.get(binding.taskId, { tenantScope: actor.tenantScope });
      if (task?.status !== "failed" || task.lastErrorCode !== "group_review_rejected") continue;
      const artifacts = taskRepository.listArtifacts({ tenantScope: actor.tenantScope, taskId: task.taskId });
      const artifact = artifacts.find(item => item.fileName === "group-result.md");
      if (!artifact) throw groupContractError("group_review_opinion_unavailable");
      const check = () => source(actor, runId, binding.stepId, task.taskId, artifact.artifactId);
      const current = check();
      if (await authorizeReviewer({ actor, session, ...current }) !== true) throw groupContractError("group_review_opinion_denied");
      let resolved;
      try {
        resolved = await taskArtifactService.resolveDownload({ ...actor, employeeId: current.step.employeeId, taskId: task.taskId, artifactId: artifact.artifactId }, {
          authorizeFailedOutput: record => { const latest = check(); return record.artifact.artifactId === latest.artifact.artifactId && record.taskStatus === "failed"; },
        });
        const stat = await resolved.handle.stat();
        if (!stat.isFile() || stat.size < 1 || stat.size > 32768) throw groupContractError("group_review_opinion_invalid");
        const bytes = Buffer.alloc(stat.size); let offset = 0;
        while (offset < bytes.length) {
          const { bytesRead } = await resolved.handle.read(bytes, offset, bytes.length - offset, offset);
          if (!bytesRead) throw groupContractError("group_review_opinion_invalid");
          offset += bytesRead;
        }
        const opinion = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
        if (!opinion || Array.isArray(opinion) || Object.keys(opinion).some(key => !["decision", "opinionSummary"].includes(key)) ||
            opinion.decision !== "rejected" || typeof opinion.opinionSummary !== "string" || !opinion.opinionSummary.trim() || opinion.opinionSummary.length > 4000) throw groupContractError("group_review_opinion_invalid");
        await resolved.handle.close(); resolved = null;
        const latest = check();
        if (await authorizeReviewer({ actor, session, ...latest }) !== true) throw groupContractError("group_review_opinion_denied");
        // Revalidate TTL/ref retirement/integrity after the read before disclosure.
        const final = await taskArtifactService.resolveDownload({ ...actor, employeeId: latest.step.employeeId, taskId: task.taskId, artifactId: artifact.artifactId }, { authorizeFailedOutput: () => { check(); return true; } });
        await final.handle.close();
        if (await authorizeReviewer({ actor, session, ...check() }) !== true) throw groupContractError("group_review_opinion_denied");
        sources.push(check);
        opinions.push({ stepId: binding.stepId, employeeId: latest.step.employeeId, artifactId: artifact.artifactId, decision: "rejected", opinionSummary: opinion.opinionSummary });
      } catch (error) {
        throw groupContractError(["group_review_opinion_denied", "group_review_opinion_invalid"].includes(error?.code) ? error.code : "group_review_opinion_unavailable");
      } finally { await resolved?.handle.close().catch(() => {}); }
    }
    // Later opinion reads may yield long enough for an earlier reviewer grant to change.
    for (const check of sources) {
      if (await authorizeReviewer({ actor, session, ...check() }) !== true) throw groupContractError("group_review_opinion_denied");
    }
    for (const check of sources) check();
    return opinions;
  }
  async function readForGoal({ actor, session, goalId, goalRevision }) {
    const resolved = readGroupReworkSource({ groups: taskRepository.groups, actor, goalId, goalRevision });
    if (!resolved) return null;
    const check = () => {
      const latest = readGroupReworkSource({ groups: taskRepository.groups, actor, goalId, goalRevision });
      if (!latest || groupContentDigest(latest.source) !== groupContentDigest(resolved.source)) {
        throw groupContractError("group_rework_source_invalid");
      }
      return latest.source;
    };
    const source = check();
    const opinions = await read({ actor, session, runId: source.runId });
    check();
    const matched = opinions.filter(opinion => opinion.artifactId === source.opinionArtifactId && opinion.decision === "rejected");
    if (matched.length !== 1) throw groupContractError("group_review_opinion_unavailable");
    return { runId: source.runId, opinionArtifactId: source.opinionArtifactId, opinionSummary: matched[0].opinionSummary };
  }
  return Object.freeze({ read, readForGoal });
}
