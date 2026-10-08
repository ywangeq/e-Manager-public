import { groupObject, groupId, groupDigest, groupInteger, groupEnum, groupContractError } from "./group-contracts-v1.mjs";
import { readGroupDelivery } from "./group-delivery-v1.mjs";

// User acceptance owns Group closure. Runtime task feedback remains step-local.
// Artifact service holds object locks through the final SQLite CAS transaction.
export function createGroupDeliveryAcceptance({ taskRepository, taskArtifactService, authorizeStep, now = () => new Date().toISOString() }) {
  if (!taskRepository?.groups || typeof taskArtifactService?.resolveDownload !== "function" || typeof authorizeStep !== "function") throw new TypeError("group acceptance requires canonical authorities");
  return Object.freeze({ async decide({ actor, session, runId, input }) {
    groupId(runId);
    const body = groupObject(input, ["goalId", "expectedRevision", "deliveryDigest", "decision"]);
    const request = { actor, runId, goalId: groupId(body.goalId), expectedRevision: groupInteger(body.expectedRevision),
      deliveryDigest: groupDigest(body.deliveryDigest), decision: groupEnum(body.decision, ["accepted", "rejected"]) };
    function load() {
      const run = taskRepository.groups.readRun(actor, runId);
      if (!run) throw groupContractError("group_run_not_found");
      const plan = taskRepository.groups.readPlan(actor, run.planId, run.planRevision);
      if (!plan || run.goalId !== request.goalId) throw groupContractError("group_delivery_changed");
      // This callback must be synchronous: no authorization/CAS yield window.
      if (plan.steps.some(step => authorizeStep({ actor, session, step }) !== true)) throw groupContractError("group_acceptance_denied");
      return { run, plan };
    }
    const { run, plan } = load();
    if (run.acceptance) return taskRepository.groups.acceptDelivery({ ...request, now: now() });
    if (run.casRevision !== request.expectedRevision) throw groupContractError("group_revision_conflict");
    const delivery = readGroupDelivery({ actor, run, plan, taskRepository });
    if (delivery.deliveryDigest !== request.deliveryDigest) throw groupContractError("group_delivery_changed");
    // Different refs can share one object; avoid acquiring a non-reentrant lock twice.
    const handles = [];
    const locked = new Set();
    try {
      for (const artifact of delivery.steps.flatMap(step => step.artifacts).sort((a, b) => a.sha256.localeCompare(b.sha256))) {
        if (locked.has(artifact.sha256)) continue;
        const resolved = await taskArtifactService.resolveDownload({ ...actor, ...artifact });
        handles.push(resolved.handle); locked.add(artifact.sha256);
      }
      load();
      return taskRepository.groups.acceptDelivery({ ...request, now: now() });
    } catch (error) {
      if (String(error?.code || "").startsWith("group_")) throw error;
      throw groupContractError("group_delivery_unavailable");
    } finally {
      await Promise.all(handles.map(handle => handle.close().catch(() => {})));
    }
  } });
}
