import crypto from "node:crypto";
import { groupContentDigest, groupContractError, groupId, groupScope } from "./group-contracts-v1.mjs";
import { EXECUTION_TASK_TERMINAL_STATUSES } from "./runtime-task-contract-v1.mjs";
import { readGroupReworkSource } from "./group-rework-source.mjs";

import { createPredecessorTaskMaterialBindingDescriptor, normalizeTaskMaterialBindingDescriptor } from "./task-material-binding.mjs";

// Bridges one already-authorized Desktop intake into a Group-owned opaque ref.
// The registry keeps only stable ids/digests and actor/session scope. File
// bytes, paths and grant payloads stay in the Desktop intake authority.
export function createGroupMaterialReferenceService({
  materialIntakeService,
  referenceRepository = null,
  taskRepository = null,
  resolveEmployee,
  canInvokeEmployee,
  runtimeSessionKey,
  now = () => Date.now(),
} = {}) {
  if (!materialIntakeService || typeof materialIntakeService.materialBindingDescriptorForIntake !== "function" ||
      typeof materialIntakeService.verifyIntake !== "function" ||
      typeof resolveEmployee !== "function" || typeof canInvokeEmployee !== "function" ||
      typeof runtimeSessionKey !== "function") {
    throw new TypeError("group material reference service dependencies are required");
  }
  const records = new Map();

  async function create({ actor, session, employeeId, intakeId, manifestDigest } = {}) {
    const scope = groupScope(actor || {});
    const safeEmployeeId = groupId(employeeId);
    const safeIntakeId = groupId(intakeId);
    const digest = String(manifestDigest || "").trim().toLowerCase();
    if (!/^sha256:[a-f0-9]{64}$/.test(digest)) throw groupContractError("group_material_manifest_invalid");
    const employee = await resolveEmployee(safeEmployeeId);
    if (!employee || employee.id !== safeEmployeeId || !(await canInvokeEmployee({ session, employee, channelId: "desktop" }))) {
      throw groupContractError("group_material_employee_authorization_denied");
    }
    const sessionKey = runtimeSessionKey({ channelId: "desktop", employeeId: safeEmployeeId, session });
    if (!(await materialIntakeService.verifyIntake({ employeeId: safeEmployeeId, intakeId: safeIntakeId, manifestDigest: digest, sessionKey }))) {
      throw groupContractError("group_material_intake_unavailable");
    }
    const createdAt = now();
    const refId = `group_material_${crypto.randomUUID()}`;
    const record = {
      ...scope,
      refId,
      employeeId: safeEmployeeId,
      employeeVersion: String(employee.version || ""),
      intakeId: safeIntakeId,
      manifestDigest: digest.slice(7),
      sessionKeyDigest: crypto.createHash("sha256").update(sessionKey).digest("hex"),
      createdAt: new Date(createdAt).toISOString(),
      expiresAt: new Date(createdAt + 60 * 60 * 1000).toISOString(),
    };
    if (referenceRepository?.saveGroupReferenceOrGet) {
      const saved = referenceRepository.saveGroupReferenceOrGet(record);
      return Object.freeze({ contractVersion: "group-input-reference.v1", refId: saved.reference.refId, version: "desktop-material-intake.v1", scope: "current_actor" });
    }
    records.set(refId, { ...record, sessionKey });
    return Object.freeze({
      contractVersion: "group-input-reference.v1",
      refId,
      version: "desktop-material-intake.v1",
      scope: "current_actor",
    });
  }

  async function resolveReference({ actor, session, reference, run = null, plan = null, step = null } = {}) {
    const persisted = referenceRepository?.getGroupReference?.(String(reference?.refId || ""), { now: new Date(now()) });
    const record = referenceRepository?.getGroupReference ? persisted : records.get(String(reference?.refId || ""));
    if (!record || Date.parse(record.expiresAt) <= now() || reference?.version !== "desktop-material-intake.v1" || reference?.scope !== "current_actor") return null;
    const scope = groupScope(actor || {});
    if (["tenantScope", "actorIssuer", "actorSubjectDigest"].some((field) => record[field] !== scope[field])) return null;
    const employee = await resolveEmployee(record.employeeId);
    if (!employee || employee.id !== record.employeeId || String(employee.version || "") !== record.employeeVersion ||
        !(await canInvokeEmployee({ session, employee, channelId: "desktop" }))) return null;
    let sessionKey;
    try { sessionKey = runtimeSessionKey({ channelId: "desktop", employeeId: record.employeeId, session }); } catch { return null; }
    if (crypto.createHash("sha256").update(sessionKey).digest("hex") !== record.sessionKeyDigest) return null;
    // Once admitted, the canonical task binding owns recovery. An in-memory
    // upload record is never required again and never silently renews a grant.
    if (run && taskRepository) {
      const pinned = await resolveBoundReference({ actor, session, record, reference, run, plan, step });
      if (pinned !== undefined) return pinned ? { ...reference, descriptor: pinned } : null;
    }
    const descriptor = await materialIntakeService.materialBindingDescriptorForIntake({
      employeeId: record.employeeId,
      intakeId: record.intakeId,
      manifestDigest: `sha256:${record.manifestDigest}`,
      sessionKey,
    });
    if (!descriptor || descriptor.adapterId !== "desktop-material-intake.v1") return null;
    return { ...reference, descriptor };
  }

  async function resolveBoundReference({ actor, session, record, reference, run, plan, step }) {
    const current = taskRepository.groups.readRun(actor, run.runId);
    if (!current || current.cancelRequested || current.activation !== "active" ||
        current.planId !== plan?.planId || current.planRevision !== plan?.revision) return null;
    const canonicalPlan = taskRepository.groups.readPlan(actor, current.planId, current.planRevision);
    if (!canonicalPlan || groupContentDigest(canonicalPlan) !== groupContentDigest(plan) ||
        !canonicalPlan.steps.some(item => groupContentDigest(item) === groupContentDigest(step)) ||
        !step.inputRefIds.includes(reference.refId) ||
        !canonicalPlan.inputRefs.some(item => groupContentDigest(item) === groupContentDigest(reference))) return null;
    const sameScope = value => value && ["tenantScope", "actorIssuer", "actorSubjectDigest"].every(key => value[key] === actor[key]);
    const boundTask = async (binding, ownerPlan = plan, ownerRun = current) => {
      const task = taskRepository.get(binding.taskId, { tenantScope: actor.tenantScope });
      const owner = ownerPlan.steps.find(item => item.stepId === binding.stepId);
      if (!owner || !sameScope(task) || (task.status !== "completed" && EXECUTION_TASK_TERMINAL_STATUSES.includes(task.status)) ||
          task.cancelRequested || task.sourceSystemId !== "group_studio" || task.taskType !== "group_step" ||
          task.submissionScope !== `group:${ownerRun.runId}` || task.employeeId !== owner.employeeId ||
          task.employeeVersion !== owner.employeeVersion || !owner.inputRefIds.includes(reference.refId) || binding.round !== owner.round) return null;
      const key = groupContentDigest({ ...groupScope(actor), runId: ownerRun.runId, planId: ownerPlan.planId,
        planRevision: ownerPlan.revision, stepId: owner.stepId, round: owner.round });
      if (task.taskId !== `group_task_${key}` || task.idempotencyKey !== key || task.sessionId !== null ||
          task.inputDigest !== groupContentDigest(owner) || groupContentDigest(task.executionInputRef) !== groupContentDigest(owner.instructionRef)) return null;
      const sourceEmployee = await resolveEmployee(task.employeeId);
      return sourceEmployee?.id === task.employeeId && String(sourceEmployee.version || "") === task.employeeVersion &&
        await canInvokeEmployee({ session, employee: sourceEmployee, channelId: "desktop" }) ? task : null;
    };
    const bindingsFor = taskId => referenceRepository?.getSet?.(taskId, { tenantScope: actor.tenantScope, now: new Date(now()) })?.bindings || [];
    const originalMatches = item => sameScope(item) && item.sourceKind === "channel_resource" && item.adapterId === "desktop-material-intake.v1" &&
      item.payload?.intakeId === record.intakeId && item.payload?.manifestDigest === `sha256:${record.manifestDigest}`;
    const sourceFor = async (binding, ownerRun = current) => {
      const stored = bindingsFor(binding.taskId);
      const original = stored.find(originalMatches);
      if (original) return original;
      const forks = stored.filter(item => sameScope(item) && item.sourceKind === "predecessor_task_input" && item.adapterId === "task-input-fork.v1");
      // Forks keep the original claim, not another fork. Follow only the
      // canonical, strictly older rejected-Run lineage to revalidate it.
      let lineage = readGroupReworkSource({ groups: taskRepository.groups, actor, goalId: ownerRun.goalId, goalRevision: ownerRun.goalRevision });
      while (forks.length && lineage) {
        if (!lineage.plan.inputRefs.some(item => groupContentDigest(item) === groupContentDigest(reference))) return null;
        for (const fork of forks) {
          const sourceBinding = lineage.run.stepBindings.find(item => item.taskId === fork.sourceTaskId);
          if (!sourceBinding) continue;
          const sourceTask = await boundTask(sourceBinding, lineage.plan, lineage.run);
          if (!sourceTask || sourceTask.status !== "completed") continue;
          const source = bindingsFor(sourceTask.taskId).find(item => item.bindingDigest === fork.sourceBindingDigest && originalMatches(item));
          if (source && groupContentDigest(descriptorOf(fork)) === groupContentDigest(createPredecessorTaskMaterialBindingDescriptor({ sourceBinding: source }))) return source;
        }
        lineage = readGroupReworkSource({ groups: taskRepository.groups, actor, goalId: lineage.run.goalId, goalRevision: lineage.run.goalRevision });
      }
      return null;
    };
    const own = current.stepBindings.find(item => item.stepId === step.stepId);
    if (own) {
      if (!await boundTask(own)) return null;
      const original = await sourceFor(own);
      if (original?.taskId === own.taskId) return descriptorOf(original);
      if (original) return createPredecessorTaskMaterialBindingDescriptor({ sourceBinding: original });
    }
    const ancestors = new Set();
    const visit = id => {
      if (ancestors.has(id)) return;
      ancestors.add(id);
      const parent = plan.steps.find(item => item.stepId === id);
      for (const next of [...(parent?.dependsOn || []), ...(parent?.optionalDependsOn || [])]) visit(next);
    };
    [...step.dependsOn, ...step.optionalDependsOn].forEach(visit);
    for (const binding of current.stepBindings) {
      if (!ancestors.has(binding.stepId)) continue;
      const task = await boundTask(binding);
      if (!task || task.cancelRequested || task.status !== "completed") continue;
      const source = await sourceFor(binding);
      if (!source) continue;
      const descriptor = createPredecessorTaskMaterialBindingDescriptor({ sourceBinding: source });
      if (own) {
        const stored = referenceRepository.getSet(own.taskId, { tenantScope: actor.tenantScope, now: new Date(now()) });
        if (!stored?.bindings.some(item => groupContentDigest(descriptorOf(item)) === groupContentDigest(descriptor))) return null;
      }
      return descriptor;
    }
    const rework = readGroupReworkSource({ groups: taskRepository.groups, actor, goalId: current.goalId, goalRevision: current.goalRevision });
    if (rework && rework.plan.inputRefs.some(item => groupContentDigest(item) === groupContentDigest(reference))) {
      for (const binding of rework.run.stepBindings) {
        const task = await boundTask(binding, rework.plan, rework.run);
        if (!task || task.status !== "completed") continue;
        const source = await sourceFor(binding, rework.run);
        if (!source) continue;
        const descriptor = createPredecessorTaskMaterialBindingDescriptor({ sourceBinding: source });
        if (own && !referenceRepository.getSet(own.taskId, { tenantScope: actor.tenantScope, now: new Date(now()) })?.bindings
          .some(item => groupContentDigest(descriptorOf(item)) === groupContentDigest(descriptor))) return null;
        return descriptor;
      }
      return null;
    }
    // A bound task must never fall back to another/new upload after revocation.
    return own ? null : undefined;
  }

  function clearExpired() {
    // The intake service remains the TTL authority. This only bounds the
    // process-local opaque lookup table and never affects an active intake.
    const cutoff = Number(now()) - 2 * 60 * 60 * 1000;
    for (const [refId, record] of records) if (Date.parse(record.createdAt) < cutoff) records.delete(refId);
    referenceRepository?.purgeGroupReferences?.({ now: new Date(now()) });
  }

  return Object.freeze({ clearExpired, create, resolveReference });
}

function descriptorOf(binding) {
  const fields = ["sourceKind", "adapterId", "sourceIdentityDigest", "expiresAt", "payload", "sourceTaskId", "sourceBindingDigest"];
  return normalizeTaskMaterialBindingDescriptor({ contractVersion: "task-material-binding-descriptor.v1",
    ...Object.fromEntries(fields.filter(key => binding[key] !== undefined).map(key => [key, binding[key]])) });
}
