import { projectTriggerExecutionTaskBinding } from "./trigger-event-submission-service.mjs";

const TRIGGER_TASK_INPUT_RESOLVER_VERSION = "trigger-task-input-resolver.v3";

function createTriggerTaskInputResolver({
  bindingRegistry,
  resolveEmployee,
  taskDefinitionRegistry,
  tenantScope,
  triggerEventRepository,
} = {}) {
  assertDependencies({
    bindingRegistry,
    resolveEmployee,
    taskDefinitionRegistry,
    tenantScope,
    triggerEventRepository,
  });

  function resolve(task = {}) {
    if (task.channelId !== "trigger" || task.taskType !== "triggered_employee_task" ||
      task.executionInputRef?.kind !== "artifact_ref") {
      throw resolverError("trigger_task_contract_invalid");
    }
    if (task.tenantScope !== tenantScope) throw resolverError("trigger_task_tenant_mismatch");
    const triggerEvent = triggerEventRepository.get(task.executionInputRef.refId, { tenantScope });
    if (!triggerEvent) throw resolverError("trigger_event_not_found");
    const snapshot = triggerEvent.executionSnapshot;
    if (!snapshot || snapshot.bindingId !== triggerEvent.bindingId) {
      throw resolverError("trigger_task_execution_snapshot_invalid");
    }
    assertTaskMatchesSnapshot(task, triggerEvent);
    const registeredBinding = bindingRegistry.get(snapshot.bindingId);
    if (!registeredBinding) throw resolverError("trigger_binding_unavailable");
    assertCurrentBindingMatchesSnapshot(registeredBinding, snapshot, triggerEvent.event.eventType);
    const binding = registeredBinding && bindingRegistry.resolve({
      bindingId: snapshot.bindingId,
      eventType: triggerEvent.event.eventType,
      sourceAdapterId: snapshot.sourceAdapterId,
      sourceSystemId: snapshot.sourceSystemId,
    });
    if (!binding) throw resolverError("trigger_binding_unavailable");
    const taskDefinition = taskDefinitionRegistry.resolve({
      taskDefinitionId: snapshot.taskDefinitionId,
      taskDefinitionVersion: snapshot.taskDefinitionVersion,
      handlerVersion: snapshot.handlerVersion,
    });
    if (!taskDefinition) throw resolverError("trigger_task_definition_changed");
    if (taskDefinition.skillPolicyRef !== snapshot.skillPolicyRef ||
      taskDefinition.toolPolicyRef !== snapshot.toolPolicyRef ||
      taskDefinition.outputPolicyRef !== snapshot.outputPolicyRef ||
      taskDefinition.writebackPolicyRef !== snapshot.writebackPolicyRef) {
      throw resolverError("trigger_task_definition_changed");
    }
    if (task.sourceSystemId !== snapshot.sourceSystemId) {
      throw resolverError("trigger_task_source_binding_mismatch");
    }
    if (task.employeeId !== snapshot.targetEmployeeId) {
      throw resolverError("trigger_task_employee_binding_mismatch");
    }
    if (task.employeeVersion !== snapshot.targetEmployeeVersion) {
      throw resolverError("trigger_task_employee_version_changed");
    }
    const employee = resolveEmployee(snapshot.targetEmployeeId);
    if (!employee || String(employee.version || "") !== snapshot.targetEmployeeVersion) {
      throw resolverError("trigger_task_employee_version_changed");
    }
    if (!["在线", "试运行"].includes(String(employee.status || "").trim())) {
      throw resolverError("trigger_target_employee_not_runnable");
    }
    return Object.freeze({ binding, employee, taskDefinition, triggerEvent });
  }

  return Object.freeze({
    contractVersion: TRIGGER_TASK_INPUT_RESOLVER_VERSION,
    resolve,
  });
}

function assertTaskMatchesSnapshot(task, triggerEvent) {
  let expected;
  try {
    expected = projectTriggerExecutionTaskBinding(triggerEvent);
  } catch {
    throw resolverError("trigger_task_execution_snapshot_invalid");
  }
  for (const field of [
    "taskId",
    "tenantScope",
    "actorIssuer",
    "actorSubjectDigest",
    "employeeId",
    "employeeVersion",
    "sourceSystemId",
    "channelId",
    "taskType",
    "submissionScope",
    "idempotencyKey",
    "inputDigest",
    "createdAt",
  ]) {
    if (task[field] !== expected[field]) throw resolverError("trigger_task_snapshot_binding_mismatch");
  }
  if (task.executionInputRef?.kind !== expected.executionInputRef.kind ||
    task.executionInputRef?.refId !== expected.executionInputRef.refId) {
    throw resolverError("trigger_task_snapshot_binding_mismatch");
  }
}

function assertCurrentBindingMatchesSnapshot(binding, snapshot, eventType) {
  if (binding.bindingVersion !== snapshot.bindingVersion) {
    throw resolverError("trigger_task_binding_version_changed");
  }
  if (binding.bindingId !== snapshot.bindingId ||
    binding.taskDefinitionId !== snapshot.taskDefinitionId ||
    binding.targetEmployeeId !== snapshot.targetEmployeeId ||
    binding.sourceAdapterId !== snapshot.sourceAdapterId ||
    binding.sourceSystemId !== snapshot.sourceSystemId ||
    binding.eventType !== eventType) {
    throw resolverError("trigger_task_binding_changed");
  }
}

function createTriggerTaskExecutorResolver({ inputResolver, executeTrigger = null } = {}) {
  if (typeof inputResolver?.resolve !== "function") throw new TypeError("trigger task executor requires inputResolver.resolve");
  if (executeTrigger !== null && typeof executeTrigger !== "function") throw new TypeError("executeTrigger must be a function");
  return Object.freeze({
    resolvePersistentTaskExecutor(task) {
      if (task?.channelId !== "trigger" || task?.taskType !== "triggered_employee_task") return null;
      return async (ownership) => {
        try {
          const context = inputResolver.resolve(task);
          if (ownership?.isCancellationRequested?.()) throw resolverError("agent_turn_canceled");
          if (!executeTrigger) {
            return {
              settlement: {
                status: "blocked",
                lastErrorCode: "trigger_execution_adapter_unavailable",
                resultSummary: "Trigger accepted; governed business input and execution adapter are not enabled.",
              },
            };
          }
          return executeTrigger({ context, ownership, task });
        } catch (error) {
          return {
            settlement: {
              status: "blocked",
              lastErrorCode: safeErrorCode(error),
              resultSummary: "Trigger execution stopped at a governed input or binding boundary.",
            },
          };
        }
      };
    },
  });
}

function assertDependencies(value) {
  if (typeof value.bindingRegistry?.get !== "function") throw new TypeError("trigger input resolver requires bindingRegistry.get");
  if (typeof value.bindingRegistry?.resolve !== "function") throw new TypeError("trigger input resolver requires bindingRegistry.resolve");
  if (typeof value.triggerEventRepository?.get !== "function") throw new TypeError("trigger input resolver requires triggerEventRepository.get");
  if (typeof value.taskDefinitionRegistry?.resolve !== "function") throw new TypeError("trigger input resolver requires taskDefinitionRegistry.resolve");
  if (typeof value.resolveEmployee !== "function") throw new TypeError("trigger input resolver requires resolveEmployee");
  if (!String(value.tenantScope || "").trim()) throw new TypeError("trigger input resolver requires tenantScope");
}

function safeErrorCode(error) {
  const code = String(error?.code || "");
  return /^[a-z][a-z0-9_]{1,119}$/.test(code) ? code : "trigger_execution_input_invalid";
}

function resolverError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

export {
  TRIGGER_TASK_INPUT_RESOLVER_VERSION,
  createTriggerTaskExecutorResolver,
  createTriggerTaskInputResolver,
};
