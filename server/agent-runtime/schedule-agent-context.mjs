import { operationReceiptContextForExecutionOwnership } from "./operation-receipt-context.mjs";
import crypto from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { projectScheduleFromRunConfiguration } from "./schedule-run-configuration.mjs";
import { assembleDigitalEmployeeDependencyContext } from "./dependency-context.mjs";
import { normalizeScheduleAgentTaskDefinition } from "./schedule-task-execution-definition.mjs";
import { normalizeScheduleActivationSnapshotV3 } from "./schedule-activation-snapshot.mjs";
import { assertScheduleTaskTriggerMatch } from "./schedule-task-input-resolver.mjs";

// Hash the same effective dependencies used by the shared Agent. There is no
// Schedule-specific permission catalog or duplicated Skill policy store.
export function resolveScheduleAgentDependencies({ employee, businessSkills, definition, workerBinding = {} }) {
  const normalized = normalizeScheduleAgentTaskDefinition(definition);
  const dependencyContext = assembleDigitalEmployeeDependencyContext({
    employee, businessSkills, workerBinding,
    channel: { channel: "schedule", sourceSystemId: "digital-workforce-scheduler", status: "active" },
  });
  if (dependencyContext.skillScope.blockedSkills.length) throw failure("schedule_agent_skill_unavailable");
  const skillPolicyDigest = hash({
    reference: normalized.skillPolicyRef, scope: dependencyContext.skillScope,
    skills: dependencyContext.callableSkills, promptMetadata: dependencyContext.promptMetadata,
    objective: dependencyContext.employee.objective,
    configuredFunctions: dependencyContext.employee.configuredFunctions,
    identityBoundaries: dependencyContext.employee.identityBoundaries,
    outputContract: dependencyContext.outputContract,
  });
  const toolPolicyDigest = hash({
    reference: normalized.toolPolicyRef, tools: dependencyContext.declaredTools,
    permissionScope: dependencyContext.employee.permissionScope,
    constraints: dependencyContext.constraints, unsupportedActions: dependencyContext.unsupportedActions,
    writebackBoundary: dependencyContext.writebackBoundary, reviewGate: dependencyContext.reviewGate,
  });
  return { dependencyContext, skillPolicyDigest, toolPolicyDigest };
}

// Called synchronously inside the control repository's first-slot transaction.
// A repeated slot is read from encrypted storage before this producer is invoked.
export function createScheduleAgentActivationAuthorityResolver({ resolveEmployee, getBusinessSkills, registry } = {}) {
  if (![resolveEmployee, getBusinessSkills, registry?.resolveAgentAuthority, registry?.resolveAgentRunBinding]
    .every(value => typeof value === "function")) throw new TypeError("Schedule activation requires current authorities");
  return ({ tenantScope, employeeId, scheduleId, definition, initialActivation = false }) => {
    const employee = resolveEmployee({ tenantScope, employeeId });
    if (!employee || employee instanceof Promise || employee.id !== employeeId) throw failure("schedule_agent_employee_unavailable");
    const authority = { contractVersion: "schedule-agent-activation-authority.v1",
      ...registry.resolveAgentAuthority({ tenantScope, employee, scheduleId }) };
    if (!initialActivation) return authority;
    const { taskModelBinding } = registry.resolveAgentRunBinding({ tenantScope, employee, scheduleId });
    const businessSkills = getBusinessSkills({ tenantScope, employee });
    if (!Array.isArray(businessSkills)) throw failure("schedule_agent_skill_unavailable");
    const { skillPolicyDigest, toolPolicyDigest } = resolveScheduleAgentDependencies({ employee, businessSkills, definition });
    return { ...authority, employeeVersion: employee.version, taskModelBinding, skillPolicyDigest, toolPolicyDigest };
  };
}

export function createScheduleRunConfigurationResolver({ resolveEmployee, getBusinessSkills, registry, resolveDefinition } = {}) {
  if (![resolveEmployee, getBusinessSkills, resolveDefinition, registry?.resolveAgentRunBinding]
    .every(value => typeof value === "function")) throw new TypeError("Schedule run configuration requires current authorities");
  return function resolve({ intent, activationSnapshot }) {
    const snapshot = normalizeScheduleActivationSnapshotV3(activationSnapshot);
    if (!intent || ["tenantScope", "employeeId", "scheduleId"].some(key => intent[key] !== snapshot[key]) ||
      intent.activationSnapshotDigest !== snapshot.snapshotDigest) throw failure("schedule_agent_snapshot_mismatch");
    const employee = resolveEmployee({ tenantScope: snapshot.tenantScope, employeeId: snapshot.employeeId });
    if (!employee || employee instanceof Promise || employee.id !== snapshot.employeeId) throw failure("schedule_agent_employee_unavailable");
    const binding = registry.resolveAgentRunBinding({ employee, tenantScope: snapshot.tenantScope, scheduleId: snapshot.scheduleId });
    if (!binding || binding instanceof Promise) throw failure("schedule_agent_configuration_unavailable");
    const { schedule, taskModelBinding, providerTimeoutPolicy } = binding;
    if (["tenantScope", "employeeId", "scheduleVersion", "registrationVersion", "schedulePolicyDigest",
      "executionContractDigest", "taskDefinitionVersion", "scheduleScope"].some(key => schedule[key] !== snapshot[key]) ||
      schedule.id !== snapshot.scheduleId || schedule.taskId !== snapshot.taskDefinitionId) throw failure("schedule_agent_registration_changed");
    const resolution = resolveDefinition({ tenantScope: snapshot.tenantScope,
      taskDefinitionId: snapshot.taskDefinitionId, executionContractDigest: snapshot.executionContractDigest });
    if (!resolution || resolution instanceof Promise || resolution.executionContractDigest !== snapshot.executionContractDigest) {
      throw failure("schedule_agent_definition_unavailable");
    }
    const definition = normalizeScheduleAgentTaskDefinition(resolution.definition);
    if (definition.taskDefinitionId !== snapshot.taskDefinitionId || definition.taskDefinitionVersion !== snapshot.taskDefinitionVersion ||
      definition.resultContractDigest !== snapshot.resultContractDigest) throw failure("schedule_agent_definition_changed");
    const businessSkills = getBusinessSkills({ tenantScope: snapshot.tenantScope, employee });
    if (!Array.isArray(businessSkills)) throw failure("schedule_agent_skill_unavailable");
    const { dependencyContext } = resolveScheduleAgentDependencies({ employee, businessSkills, definition });
    return { dependencyContext, taskModelBinding, providerTimeoutPolicy };
  };
}

// resolveCurrent is the Center-owned live admission/revocation projection.
// It must not recover a personal conversation or manufacture a login session.
export function createScheduleAgentContextResolver({ resolveCurrent, resolveDefinition,
  resolveProviderLease, createToolExecutor, maxOutputTokens = 4096 } = {}) {
  if (![resolveCurrent, resolveDefinition, resolveProviderLease, createToolExecutor]
    .every(value => typeof value === "function")) throw new TypeError("Schedule Agent context requires governed current authorities");
  if (!Number.isInteger(maxOutputTokens) || maxOutputTokens < 1 || maxOutputTokens > 32768) {
    throw new TypeError("Schedule Agent output budget invalid");
  }
  return async function resolve({ task, snapshot: value, trigger, signal, ownership, runConfiguration }) {
    const snapshot = normalizeScheduleActivationSnapshotV3(value);
    assertScheduleTaskTriggerMatch(task, trigger);
    const schedule = projectScheduleFromRunConfiguration(snapshot, runConfiguration);
    if (runConfiguration.binding.executionTaskId !== task.taskId || runConfiguration.binding.scheduledFor !== trigger.scheduledFor ||
      trigger.runConfigurationDigest !== runConfiguration.configurationDigest) throw failure("schedule_agent_run_configuration_mismatch");
    if (["tenantScope", "employeeId", "employeeVersion", "scheduleId", "scheduleVersion", "taskDefinitionId",
      "actorIssuer", "actorSubjectDigest", "authorizationDigest", "permissionDigest", "schedulePolicyDigest",
      "executionContractDigest"].some(key => schedule[key] !== trigger[key]) ||
      !isDeepStrictEqual(schedule.providerTimeoutPolicy, task.providerTimeoutPolicy)) {
      throw failure("schedule_agent_snapshot_mismatch");
    }
    const resolution = await resolveDefinition({ tenantScope: task.tenantScope,
      taskDefinitionId: snapshot.taskDefinitionId, executionContractDigest: snapshot.executionContractDigest });
    if (!resolution || resolution.executionContractDigest !== snapshot.executionContractDigest) {
      throw failure("schedule_agent_definition_unavailable");
    }
    const definition = normalizeScheduleAgentTaskDefinition(resolution.definition);
    if (definition.taskDefinitionId !== snapshot.taskDefinitionId ||
      definition.taskDefinitionVersion !== snapshot.taskDefinitionVersion ||
      definition.resultContractDigest !== snapshot.resultContractDigest) throw failure("schedule_agent_definition_changed");

    const { dependencyContext, taskModelBinding } = runConfiguration.configuration;
    // Selection comes exclusively from the frozen run. Current employee state is
    // supplied separately for live authorization, never to rebuild the prompt.
    const employee = { ...dependencyContext.employee,
      businessSkillIds: dependencyContext.skillScope.employeeMountedSkillIds,
      tools: dependencyContext.declaredTools.map(tool => ({ ...tool, ...tool.authorizationPolicy, policyMode: tool.authorizationPolicy.mode })),
    };
    async function current(operation) {
      if (signal?.aborted || ownership?.isCancellationRequested?.()) throw failure("schedule_agent_canceled");
      ownership?.refreshCurrentLease?.();
      const authority = await resolveCurrent({ task, snapshot, trigger, runConfiguration, operation });
      if (authority?.allowed !== true || authority.employee?.id !== task.employeeId) {
        throw failure("schedule_agent_current_authority_changed");
      }
      return authority;
    }
    const initial = await current();
    const lease = await resolveProviderLease({ employee, currentEmployee: initial.employee, task, taskModelBinding });
    if (!lease || lease.model !== taskModelBinding.model) throw failure("schedule_agent_model_unavailable");
    const executor = await createToolExecutor({ task, snapshot, trigger, signal, ownership, employee, currentEmployee: initial.employee,
      dependencyContext, revalidate: current });
    if (!executor || typeof executor.execute !== "function") throw failure("schedule_agent_tools_unavailable");
    // Recheck after asynchronous preparation and before each Tool invocation. The
    // wrapped executor still owns structured per-operation authorization/receipts.
    await current();
    const toolExecutor = Object.freeze({ ...executor, execute: async (...args) => {
      await current(args[0]);
      return executor.execute(...args);
    } });
    return {
      operationReceiptContext: operationReceiptContextForExecutionOwnership(ownership),
      dependencyContext, employeeIdentity: dependencyContext.employee,
      lease, maxOutputTokens, toolExecutor,
      runtimeContext: { currentTurn: { text: definition.taskInstruction } },
      safeContext: { contractVersion: "schedule-agent-context.v1", schedule: {
        scheduledFor: trigger.scheduledFor, timezone: snapshot.timezone,
        taskDefinitionVersion: definition.taskDefinitionVersion,
      } },
    };
  };
}

function hash(value) {
  return crypto.createHash("sha256").update(canonical(value)).digest("hex");
}
function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
  return JSON.stringify(value);
}
function failure(code) { const error = new Error(code); error.code = code; return error; }
