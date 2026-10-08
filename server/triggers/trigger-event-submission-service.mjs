import crypto from "node:crypto";
import { normalizeExecutionTaskSubmission } from "../agent-runtime/runtime-task-contract-v1.mjs";
import { normalizeProviderTimeoutPolicy } from "../agent-runtime/provider-timeout-policy.mjs";
import { TRIGGER_EXECUTION_SNAPSHOT_CONTRACT_VERSION } from "./sqlite-trigger-event-repository.mjs";

const TRIGGER_EVENT_SUBMISSION_SERVICE_VERSION = "trigger-event-submission-service.v3";
const TRIGGER_TASK_TYPE = "triggered_employee_task";
const TRIGGER_CHANNEL_ID = "trigger";

function createTriggerEventSubmissionService({
  bindingRegistry,
  executionTaskRepository,
  resolveEmployee,
  resolveProviderTimeoutPolicy,
  taskDefinitionRegistry,
  tenantScope,
  triggerEventRepository,
  workerPump = null,
} = {}) {
  assertDependencies({
    bindingRegistry,
    executionTaskRepository,
    resolveEmployee,
    resolveProviderTimeoutPolicy,
    taskDefinitionRegistry,
    tenantScope,
    triggerEventRepository,
  });

  function submit({ bindingId, event, sourceAdapterId } = {}) {
    const registeredBinding = bindingRegistry.get(bindingId);
    if (!registeredBinding) throw serviceError("trigger_binding_unavailable");
    const binding = bindingRegistry.resolve({
      bindingId,
      eventType: event?.eventType,
      sourceAdapterId,
      sourceSystemId: registeredBinding.sourceSystemId,
    });
    if (!binding) throw serviceError("trigger_binding_unavailable");
    const taskDefinition = taskDefinitionRegistry.get(binding.taskDefinitionId);
    if (!taskDefinition) throw serviceError("trigger_task_definition_unavailable");
    const employee = resolveEmployee(binding.targetEmployeeId);
    if (!employee) throw serviceError("trigger_target_employee_unavailable");
    if (!["在线", "试运行"].includes(String(employee.status || "").trim())) {
      throw serviceError("trigger_target_employee_not_runnable");
    }
    const employeeVersion = requiredToken(employee.version, "employeeVersion", 80);
    const executionSnapshot = {
      contractVersion: TRIGGER_EXECUTION_SNAPSHOT_CONTRACT_VERSION,
      bindingId: binding.bindingId,
      bindingVersion: binding.bindingVersion,
      taskDefinitionId: binding.taskDefinitionId,
      taskDefinitionVersion: taskDefinition.taskDefinitionVersion,
      handlerVersion: taskDefinition.handlerVersion,
      skillPolicyRef: taskDefinition.skillPolicyRef,
      toolPolicyRef: taskDefinition.toolPolicyRef,
      outputPolicyRef: taskDefinition.outputPolicyRef,
      writebackPolicyRef: taskDefinition.writebackPolicyRef,
      targetEmployeeId: binding.targetEmployeeId,
      targetEmployeeVersion: employeeVersion,
      sourceAdapterId: binding.sourceAdapterId,
      sourceSystemId: binding.sourceSystemId,
    };
    const triggerResult = triggerEventRepository.saveOrGet(event, {
      bindingId: binding.bindingId,
      executionSnapshot,
      tenantScope,
    });
    const triggerEvent = triggerResult.triggerEvent;
    const taskBinding = projectTriggerExecutionTaskBinding(triggerEvent);
    const submission = normalizeExecutionTaskSubmission({
      ...taskBinding,
      providerTimeoutPolicy: normalizeProviderTimeoutPolicy(resolveProviderTimeoutPolicy({
        binding,
        employee,
        taskDefinition,
      })),
    }, { now: new Date(taskBinding.createdAt) });
    const taskResult = executionTaskRepository.submitOrGet(submission);
    if (taskResult.task.taskId !== submission.taskId) {
      throw serviceError("trigger_execution_task_binding_mismatch");
    }
    if (taskResult.created) workerPump?.wake?.();
    return Object.freeze({
      binding,
      created: taskResult.created,
      task: taskResult.task,
      triggerCreated: triggerResult.created,
      triggerEvent,
    });
  }

  return Object.freeze({
    contractVersion: TRIGGER_EVENT_SUBMISSION_SERVICE_VERSION,
    submit,
  });
}

function projectTriggerExecutionTaskBinding(triggerEvent) {
  const snapshot = triggerEvent?.executionSnapshot;
  if (!snapshot || snapshot.bindingId !== triggerEvent?.bindingId ||
    snapshot.contractVersion !== TRIGGER_EXECUTION_SNAPSHOT_CONTRACT_VERSION) {
    throw serviceError("trigger_execution_snapshot_invalid");
  }
  const identityDigest = digestCanonical([
    TRIGGER_EVENT_SUBMISSION_SERVICE_VERSION,
    triggerEvent.tenantScope,
    snapshot.bindingId,
    triggerEvent.externalEventId,
  ]);
  const createdAt = normalizedNow(triggerEvent.event?.occurredAt);
  return Object.freeze({
    taskId: `task_${identityDigest}`,
    tenantScope: triggerEvent.tenantScope,
    actorIssuer: `integration:${snapshot.sourceSystemId}`,
    actorSubjectDigest: digestCanonical([
      "trigger-binding-actor.v1",
      triggerEvent.tenantScope,
      snapshot.bindingId,
      snapshot.bindingVersion,
    ]),
    employeeId: snapshot.targetEmployeeId,
    employeeVersion: snapshot.targetEmployeeVersion,
    sourceSystemId: snapshot.sourceSystemId,
    channelId: TRIGGER_CHANNEL_ID,
    taskType: TRIGGER_TASK_TYPE,
    submissionScope: `trigger:${snapshot.bindingId}`,
    idempotencyKey: `event:${identityDigest}`,
    inputDigest: digestCanonical(["trigger-event-artifact.v2", triggerEvent]),
    executionInputRef: Object.freeze({
      kind: "artifact_ref",
      refId: triggerEvent.triggerEventId,
    }),
    createdAt,
    availableAt: createdAt,
  });
}

function assertDependencies(value) {
  if (typeof value.bindingRegistry?.get !== "function") throw new TypeError("trigger submission requires bindingRegistry.get");
  if (typeof value.bindingRegistry?.resolve !== "function") throw new TypeError("trigger submission requires bindingRegistry.resolve");
  if (typeof value.executionTaskRepository?.submitOrGet !== "function") throw new TypeError("trigger submission requires executionTaskRepository.submitOrGet");
  if (typeof value.triggerEventRepository?.saveOrGet !== "function") throw new TypeError("trigger submission requires triggerEventRepository.saveOrGet");
  if (typeof value.taskDefinitionRegistry?.get !== "function") throw new TypeError("trigger submission requires taskDefinitionRegistry.get");
  if (typeof value.resolveEmployee !== "function") throw new TypeError("trigger submission requires resolveEmployee");
  if (typeof value.resolveProviderTimeoutPolicy !== "function") throw new TypeError("trigger submission requires resolveProviderTimeoutPolicy");
  requiredToken(value.tenantScope, "tenantScope", 160);
}

function normalizedNow(value) {
  const timestamp = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(timestamp.getTime())) throw serviceError("trigger_submission_clock_invalid");
  return timestamp.toISOString();
}

function requiredToken(value, field, maxLength) {
  if (typeof value !== "string" || value !== value.trim() || !value ||
    value.length > maxLength || !/^[A-Za-z0-9][A-Za-z0-9._:@-]*$/.test(value)) {
    throw serviceError("trigger_submission_reference_invalid", `${field} must be a bounded opaque identifier`);
  }
  return value;
}

function digestCanonical(parts) {
  return crypto.createHash("sha256").update(JSON.stringify(parts)).digest("hex");
}

function serviceError(code, message = code) {
  const error = new Error(message);
  error.code = code;
  return error;
}

export {
  TRIGGER_CHANNEL_ID,
  TRIGGER_EVENT_SUBMISSION_SERVICE_VERSION,
  TRIGGER_TASK_TYPE,
  createTriggerEventSubmissionService,
  projectTriggerExecutionTaskBinding,
};
