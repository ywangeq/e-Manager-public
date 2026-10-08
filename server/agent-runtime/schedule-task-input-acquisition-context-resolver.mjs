import { isDeepStrictEqual } from "node:util";
import { normalizeScheduleActivationSnapshotV2 } from "./schedule-activation-snapshot.mjs";
import {
  normalizeScheduleTaskExecutionDefinitionV2,
  scheduleTaskInputContractDigest,
} from "./schedule-task-execution-definition.mjs";
import { scheduleTaskInputRetentionDefinitionDigest } from "./schedule-task-input-retention-contract.mjs";
import { assertScheduleTaskTriggerMatch } from "./schedule-task-input-resolver.mjs";
import {
  normalizeScheduleTaskSourceBinding,
  SCHEDULE_TASK_SOURCE_BINDING_RESOLUTION_CONTRACT_VERSION,
} from "./versioned-schedule-task-source-binding-catalog.mjs";

const RESOLVER_VERSION = "schedule-task-input-acquisition-context-resolver.v1";
const RUN_CONTEXT_VERSION = "schedule-run-authority-context.v1";
const CONTEXT_VERSION = "schedule-task-input-acquisition-context.v1";
const OWNERSHIP_VERSION = "schedule-task-input-acquisition-ownership.v1";
const BINDING_VERSION = "schedule-task-input-snapshot-binding.v2";
const REQUEST_FIELDS = new Set(["canonicalTaskId", "runId", "tenantScope"]);
const TOKEN = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,239}$/;
const DIGEST = /^[a-f0-9]{64}$/;

export function createScheduleTaskInputAcquisitionContextResolver({
  controlRepository,
  executionTaskRepository,
  resolveSourceBinding,
  resolveTaskExecutionDefinition,
  scheduleTriggerRepository,
} = {}) {
  requireMethods(controlRepository, "controlRepository", [
    "getActivationSnapshot", "getIntent", "getRunExecution", "resolveActiveActivationSnapshot",
  ]);
  requireMethods(executionTaskRepository, "executionTaskRepository", ["get"]);
  requireMethods(scheduleTriggerRepository, "scheduleTriggerRepository", ["get"]);
  if (typeof resolveTaskExecutionDefinition !== "function") {
    throw new TypeError("resolveTaskExecutionDefinition must be a function");
  }
  if (typeof resolveSourceBinding !== "function") {
    throw new TypeError("resolveSourceBinding must be a function");
  }

  async function resolveRunAuthorityContext(value = {}, {
    executionPhase = "pre_effect",
    recoveryOnly = false,
  } = {}) {
    const request = normalizeRequest(value);
    if (!new Set(["pre_effect", "effect_dispatch_prepared"]).has(executionPhase) ||
      typeof recoveryOnly !== "boolean" || (executionPhase === "pre_effect" && recoveryOnly)) {
      throw resolverError("schedule_task_input_context_mode_invalid");
    }
    const intent = controlRepository.getIntent(request.runId, { tenantScope: request.tenantScope });
    const execution = controlRepository.getRunExecution(request.runId, {
      tenantScope: request.tenantScope,
    });
    const task = executionTaskRepository.get(request.canonicalTaskId, {
      tenantScope: request.tenantScope,
    });
    requireCurrentLedger(request, intent, execution, task, { executionPhase, recoveryOnly });

    const trigger = scheduleTriggerRepository.get(intent.expectedTriggerId, {
      tenantScope: request.tenantScope,
    });
    requireTrigger(intent, execution, task, trigger);

    const active = await currentActivation(controlRepository, intent, recoveryOnly);
    const snapshot = normalizeCurrentSnapshot(active, intent, execution, task, trigger, recoveryOnly);
    const taskDefinitionResolution = await currentTaskDefinition(
      resolveTaskExecutionDefinition,
      request.tenantScope,
      snapshot,
    );
    const sourceBindingResolution = await currentSourceBinding(
      resolveSourceBinding,
      request.tenantScope,
      taskDefinitionResolution,
    );
    requireDefinitionAndSource(snapshot, taskDefinitionResolution, sourceBindingResolution);

    return deepFreeze({
      binding: projectScheduleTaskInputSnapshotBinding({
        execution,
        intent,
        snapshot,
        sourceBindingResolution,
        taskDefinitionResolution,
        task,
        trigger,
      }),
      contractVersion: RUN_CONTEXT_VERSION,
      execution,
      intent,
      snapshot,
      sourceBindingResolution,
      task,
      taskDefinitionResolution,
      trigger,
    });
  }

  async function resolve(value = {}) {
    const current = await resolveRunAuthorityContext(value);
    return deepFreeze({
      binding: current.binding,
      contractVersion: CONTEXT_VERSION,
      executionPhase: "pre_effect",
      executionVersion: current.execution.executionVersion,
      ownership: projectOwnership(current.execution, current.task),
      sourceBindingResolution: current.sourceBindingResolution,
      taskDefinitionResolution: current.taskDefinitionResolution,
    });
  }

  return Object.freeze({ contractVersion: RESOLVER_VERSION, resolve, resolveRunAuthorityContext });
}

function requireCurrentLedger(request, intent, execution, task, { executionPhase, recoveryOnly }) {
  const current = intent?.tenantScope === request.tenantScope && intent.runId === request.runId &&
    intent.intentState === "submitted" && intent.executionTaskId === request.canonicalTaskId &&
    execution?.tenantScope === request.tenantScope && execution.runId === request.runId &&
    execution.executionTaskId === request.canonicalTaskId && execution.executionState === "active" &&
    execution.executionPhase === executionPhase && execution.admissionOutcome === "admitted" &&
    (executionPhase !== "effect_dispatch_prepared" ||
      (execution.resultReceiptRequirement === "required" && !execution.resultReceiptDigest)) &&
    task?.tenantScope === request.tenantScope && task.taskId === request.canonicalTaskId &&
    task.status === "running" && task.lease;
  if (!current) throw resolverError("schedule_task_input_context_ledger_not_current");
  const executionMatchesIntent = execution.employeeId === intent.employeeId &&
    execution.scheduleId === intent.scheduleId && execution.activationVersion === intent.activationVersion;
  const taskLeaseMatches = recoveryOnly || (
    execution.taskLeaseId === task.lease.leaseId &&
    execution.taskOwnerDigest === task.lease.workerIdDigest &&
    execution.taskFencingToken === task.lease.fencingToken &&
    timestampMs(task.lease.expiresAt) >= timestampMs(execution.taskLeaseExpiresAt) &&
    timestampMs(execution.leaseExpiresAt) <= timestampMs(task.lease.expiresAt)
  );
  if (!executionMatchesIntent || !taskLeaseMatches || !execution.leaseId || !execution.ownerDigest) {
    throw resolverError("schedule_task_input_context_lease_mismatch");
  }
}

function requireTrigger(intent, execution, task, trigger) {
  if (!trigger) throw resolverError("schedule_task_input_trigger_unavailable");
  try { assertScheduleTaskTriggerMatch(task, trigger); }
  catch { throw resolverError("schedule_task_input_trigger_mismatch"); }
  const matches = trigger.triggerId === intent.expectedTriggerId &&
    trigger.executionTaskId === intent.executionTaskId && trigger.tenantScope === intent.tenantScope &&
    trigger.employeeId === intent.employeeId && trigger.scheduleId === intent.scheduleId &&
    trigger.scheduleVersion === intent.scheduleVersion && trigger.scheduledFor === intent.scheduledFor &&
    trigger.executionContractDigest === intent.executionContractDigest &&
    trigger.schedulePolicyDigest === intent.schedulePolicyDigest &&
    execution.windowStart === intent.scheduledFor;
  if (!matches) throw resolverError("schedule_task_input_trigger_mismatch");
}

async function currentActivation(controlRepository, intent, recoveryOnly) {
  try {
    if (recoveryOnly) {
      return {
        governedSchedule: null,
        snapshot: controlRepository.getActivationSnapshot(intent.activationSnapshotId, {
          tenantScope: intent.tenantScope,
        }),
      };
    }
    return await controlRepository.resolveActiveActivationSnapshot({
      tenantScope: intent.tenantScope,
      employeeId: intent.employeeId,
      scheduleId: intent.scheduleId,
      activationVersion: intent.activationVersion,
      activationSnapshotId: intent.activationSnapshotId,
      activationSnapshotDigest: intent.activationSnapshotDigest,
    });
  } catch {
    throw resolverError("schedule_task_input_activation_not_current");
  }
}

function normalizeCurrentSnapshot(active, intent, execution, task, trigger, recoveryOnly) {
  let snapshot;
  try { snapshot = normalizeScheduleActivationSnapshotV2(active?.snapshot); }
  catch { throw resolverError("schedule_task_input_activation_invalid"); }
  const matches = (recoveryOnly || active?.governedSchedule?.contractVersion === "governed-schedule.v2") &&
    snapshot.snapshotDigest === intent.activationSnapshotDigest &&
    `schedule_activation_snapshot_${snapshot.snapshotDigest}` === intent.activationSnapshotId &&
    snapshot.tenantScope === intent.tenantScope && snapshot.employeeId === intent.employeeId &&
    snapshot.employeeVersion === task.employeeVersion && snapshot.scheduleId === intent.scheduleId &&
    snapshot.scheduleVersion === intent.scheduleVersion &&
    snapshot.activationVersion === intent.activationVersion &&
    snapshot.taskDefinitionId === trigger.taskDefinitionId &&
    snapshot.executionContractDigest === intent.executionContractDigest &&
    snapshot.schedulePolicyDigest === intent.schedulePolicyDigest &&
    trigger.employeeVersion === snapshot.employeeVersion &&
    isDeepStrictEqual(snapshot.providerTimeoutPolicy, task.providerTimeoutPolicy) &&
    execution.activationVersion === snapshot.activationVersion;
  if (!matches) throw resolverError("schedule_task_input_activation_mismatch");
  return snapshot;
}

async function currentTaskDefinition(resolver, tenantScope, snapshot) {
  let value;
  try {
    value = await resolver({
      tenantScope,
      taskDefinitionId: snapshot.taskDefinitionId,
      executionContractDigest: snapshot.executionContractDigest,
    });
  } catch {
    throw resolverError("schedule_task_input_definition_unavailable");
  }
  if (!value || value.contractVersion !== "schedule-task-execution-definition-resolution.v1" ||
    value.payloadBoundary !== "internal_only") {
    throw resolverError("schedule_task_input_definition_unavailable");
  }
  let definition;
  try { definition = normalizeScheduleTaskExecutionDefinitionV2(value.definition); }
  catch { throw resolverError("schedule_task_input_definition_invalid"); }
  return deepFreeze({
    contractVersion: value.contractVersion,
    definition,
    executionContractDigest: digest(value.executionContractDigest),
    payloadBoundary: "internal_only",
    publishedAt: timestamp(value.publishedAt),
  });
}

async function currentSourceBinding(resolver, tenantScope, definitionResolution) {
  const definition = definitionResolution.definition;
  let value;
  try {
    value = await resolver({
      tenantScope,
      sourceAdapterId: definition.inputContract.sourceAdapterId,
      sourceBindingDigest: definition.inputContract.sourceBindingDigest,
      taskDefinitionId: definition.taskDefinitionId,
      taskDefinitionVersion: definition.taskDefinitionVersion,
    });
  } catch {
    throw resolverError("schedule_task_input_source_binding_unavailable");
  }
  if (!value || value.contractVersion !== SCHEDULE_TASK_SOURCE_BINDING_RESOLUTION_CONTRACT_VERSION ||
    value.payloadBoundary !== "internal_only") {
    throw resolverError("schedule_task_input_source_binding_unavailable");
  }
  let binding;
  try { binding = normalizeScheduleTaskSourceBinding(value.binding); }
  catch { throw resolverError("schedule_task_input_source_binding_invalid"); }
  return deepFreeze({
    binding,
    contractVersion: value.contractVersion,
    payloadBoundary: "internal_only",
    sourceBindingDigest: digest(value.sourceBindingDigest),
  });
}

function requireDefinitionAndSource(snapshot, taskResolution, sourceResolution) {
  const definition = taskResolution.definition;
  const input = definition.inputContract;
  const source = sourceResolution.binding;
  const matches = taskResolution.executionContractDigest === snapshot.executionContractDigest &&
    definition.taskDefinitionId === snapshot.taskDefinitionId &&
    definition.resultContractDigest === snapshot.resultContractDigest &&
    sourceResolution.sourceBindingDigest === input.sourceBindingDigest &&
    source.sourceAdapterId === input.sourceAdapterId &&
    source.taskDefinitionId === definition.taskDefinitionId &&
    source.taskDefinitionVersion === definition.taskDefinitionVersion &&
    timestampMs(source.publishedAt) <= timestampMs(taskResolution.publishedAt);
  if (!matches) throw resolverError("schedule_task_input_authority_mismatch");
}

function projectScheduleTaskInputSnapshotBinding({ intent, snapshot, sourceBindingResolution, taskDefinitionResolution,
  task, trigger }) {
  const input = taskDefinitionResolution.definition.inputContract;
  return {
    activationSnapshotDigest: intent.activationSnapshotDigest,
    activationSnapshotId: intent.activationSnapshotId,
    activationVersion: intent.activationVersion,
    canonicalTaskId: task.taskId,
    contractVersion: BINDING_VERSION,
    employeeId: intent.employeeId,
    executionContractDigest: intent.executionContractDigest,
    inputContractDigest: scheduleTaskInputContractDigest(input),
    maxItems: input.maxItems,
    maxPayloadBytes: input.maxPayloadBytes,
    retentionDefinitionDigest: scheduleTaskInputRetentionDefinitionDigest(input.retentionDefinition),
    runId: intent.runId,
    scheduleId: intent.scheduleId,
    scheduledFor: intent.scheduledFor,
    snapshotContractVersion: sourceBindingResolution.binding.snapshotContractVersion,
    sourceAdapterId: input.sourceAdapterId,
    sourceBindingDigest: input.sourceBindingDigest,
    snapshotRetentionSeconds: input.retentionDefinition.snapshotRetentionSeconds,
    taskDefinitionId: snapshot.taskDefinitionId,
    taskDefinitionVersion: taskDefinitionResolution.definition.taskDefinitionVersion,
    tenantScope: intent.tenantScope,
    triggerId: trigger.triggerId,
  };
}

function projectOwnership(execution, task) {
  return {
    contractVersion: OWNERSHIP_VERSION,
    runFencingToken: execution.fencingToken,
    runLeaseExpiresAt: execution.leaseExpiresAt,
    runLeaseId: execution.leaseId,
    runOwnerDigest: execution.ownerDigest,
    taskFencingToken: task.lease.fencingToken,
    taskLeaseExpiresAt: task.lease.expiresAt,
    taskLeaseId: task.lease.leaseId,
    taskOwnerDigest: task.lease.workerIdDigest,
  };
}

function normalizeRequest(value) {
  exactObject(value, REQUEST_FIELDS);
  return {
    canonicalTaskId: token(value.canonicalTaskId),
    runId: token(value.runId),
    tenantScope: token(value.tenantScope),
  };
}

function exactObject(value, fields) {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype) {
    throw resolverError("schedule_task_input_context_request_invalid");
  }
  const keys = Object.keys(value);
  if (keys.length !== fields.size || keys.some((key) => !fields.has(key))) {
    throw resolverError("schedule_task_input_context_request_invalid");
  }
}

function requireMethods(value, name, methods) {
  for (const method of methods) {
    if (typeof value?.[method] !== "function") throw new TypeError(`${name}.${method} must be a function`);
  }
}

function token(value) {
  const result = String(value || "").trim();
  if (!TOKEN.test(result) || /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(result)) {
    throw resolverError("schedule_task_input_context_reference_invalid");
  }
  return result;
}

function digest(value) {
  const result = String(value || "").trim().toLowerCase();
  if (!DIGEST.test(result)) throw resolverError("schedule_task_input_context_digest_invalid");
  return result;
}

function timestamp(value) {
  const input = value instanceof Date ? value.toISOString() : String(value || "").trim();
  const parsed = new Date(input);
  if (!input || !Number.isFinite(parsed.getTime()) || parsed.toISOString() !== input) {
    throw resolverError("schedule_task_input_context_timestamp_invalid");
  }
  return input;
}

function timestampMs(value) {
  return new Date(timestamp(value)).getTime();
}

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  Object.freeze(value);
  Object.values(value).forEach(deepFreeze);
  return value;
}

function resolverError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

export {
  RESOLVER_VERSION as SCHEDULE_TASK_INPUT_ACQUISITION_CONTEXT_RESOLVER_CONTRACT_VERSION,
  RUN_CONTEXT_VERSION as SCHEDULE_RUN_AUTHORITY_CONTEXT_CONTRACT_VERSION,
  projectScheduleTaskInputSnapshotBinding,
};
