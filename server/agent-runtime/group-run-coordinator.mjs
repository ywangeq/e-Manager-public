import { assertGroupScope, groupContractError, normalizeGroupRun } from "./group-contracts-v1.mjs";

// Coordinates references only. Submission/binding/CAS and cancellation/fencing
// commit together in the canonical repository; no Group task state is settled here.
export function createGroupRunCoordinator({ taskRepository, authorizeRun, authorizeStep, buildSubmission, verifyDependency, resolveStepMaterialBindings = null, artifactDependencyGate = null, workerPump }) {
  if (!taskRepository?.groups || ![authorizeRun, authorizeStep, buildSubmission, verifyDependency].every(fn => typeof fn === "function")) {
    throw groupContractError("group_coordinator_dependencies_required");
  }
  if (resolveStepMaterialBindings !== null && resolveStepMaterialBindings !== undefined && typeof resolveStepMaterialBindings !== "function") {
    throw groupContractError("group_material_binding_resolver_invalid");
  }
  const groups = taskRepository.groups;
  async function load(actor, runId) {
    if (await authorizeRun({actor, runId}) !== true) throw groupContractError("group_authorization_denied");
    const run = groups.readRun(actor, runId);
    if (!run) throw groupContractError("group_run_not_found");
    assertGroupScope(run, actor);
    return normalizeGroupRun(run);
  }
  return Object.freeze({
    async advance({actor, session = null, runId, expectedRevision}) {
      let run = await load(actor, runId);
      if (run.casRevision !== expectedRevision) throw groupContractError("group_revision_conflict");
      if (run.activation !== "active" || run.cancelRequested) return run;
      const plan = groups.readPlan(actor, run.planId, run.planRevision);
      if (!plan) throw groupContractError("group_plan_not_found");
      if (groups.readRequiredStepFailure(actor, runId)) {
        return groups.setActivation({ actor, runId, expectedRevision, activation: "resume_required" });
      }
      for (const step of plan.steps) {
        if (run.stepBindings.some(binding => binding.stepId === step.stepId)) continue;
        const dependencies = [...step.dependsOn, ...step.optionalDependsOn];
        if (dependencies.some(id => !run.stepBindings.some(binding => binding.stepId === id))) continue;
        // Artifact completion/access is separate from a canonical completed status.
        let ready = true;
        if (artifactDependencyGate && await artifactDependencyGate.verify({actor, run, step}) !== true) ready = false;
        for (const id of step.dependsOn) {
          const binding = run.stepBindings.find(item => item.stepId === id);
          if (await verifyDependency({actor, run, step, binding}) !== true) { ready = false; break; }
        }
        if (!ready) continue;
        if (await authorizeStep({actor, session, run, plan, step}) !== true) throw groupContractError("group_step_authorization_denied");
        const materialBindings = step.inputRefIds?.length
          ? await resolveStepMaterialBindings?.({ actor, session, run, plan, step })
          : [];
        if (step.inputRefIds?.length && !Array.isArray(materialBindings)) throw groupContractError("group_material_binding_resolver_unavailable");
        const submission = await buildSubmission({actor, session, run, plan, step, materialBindings});
        // Reloaded CAS inside submitStep protects async authorization/preparation
        // against concurrent cancellation, pause and another coordinator.
        try {
          const result = groups.submitStep({actor, runId, stepId:step.stepId, expectedRevision:run.casRevision, submission});
          run = result.run;
          workerPump?.wake?.();
        } catch (error) {
          if (["group_dependency_not_ready", "group_parallel_limit"].includes(error?.code)) continue;
          throw groupContractError(["group_revision_conflict", "group_run_inactive", "group_reconcile_required", "group_budget_exceeded", "group_required_step_failed"].includes(error?.code) ? error.code : "group_submission_failed");
        }
      }
      return run;
    },
    async cancel({actor, runId, expectedRevision}) {
      await load(actor, runId);
      const run = groups.cancelRun({actor, runId, expectedRevision});
      // Canonical cancel has already fenced late results; abort is best effort.
      for (const binding of run.stepBindings) workerPump?.abortTask?.(binding.taskId);
      return run;
    },
    async resume({actor, session = null, runId, expectedRevision}) {
      const run = await load(actor, runId);
      const plan = groups.readPlan(actor, run.planId, run.planRevision);
      for (const step of plan.steps) {
        if (await authorizeStep({actor, session, run, plan, step}) !== true) throw groupContractError("group_step_authorization_denied");
      }
      return groups.setActivation({actor, runId, expectedRevision, activation:"active"});
    },
  });
}
