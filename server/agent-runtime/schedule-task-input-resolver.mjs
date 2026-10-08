import { isDeepStrictEqual } from "node:util";
import { EXECUTION_TASK_CONTRACT_VERSION } from "./runtime-task-contract-v1.mjs";
import {
  normalizeGovernedSchedule,
  normalizeScheduleTrigger,
  scheduleTriggerDigest,
} from "./schedule-trigger-service.mjs";

const SCHEDULE_TASK_INPUT_RESOLVER_CONTRACT_VERSION = "schedule-task-input-resolver.v3";

function createScheduleTaskInputResolver({
  resolveEmployee,
  resolveSchedule,
  resolveAuthorizationDigest,
  resolveExecutionContractDigest,
  scheduleTriggerRepository,
  resolveSchedulePolicyDigest,
  validateEmployee,
} = {}) {
  assertDependencies({
    resolveAuthorizationDigest,
    resolveEmployee,
    resolveExecutionContractDigest,
    resolveSchedule,
    resolveSchedulePolicyDigest,
    scheduleTriggerRepository,
    validateEmployee,
  });

  async function resolve(task) {
    requireScheduleTask(task);
    const trigger = scheduleTriggerRepository.get(task.executionInputRef.refId, {
      tenantScope: task.tenantScope,
    });
    if (!trigger) throw resolverError("schedule_task_trigger_not_found");
    assertScheduleTaskTriggerMatch(task, trigger);

    const [employee, scheduleValue] = await Promise.all([
      resolveCurrent(resolveEmployee, task.employeeId, "schedule_task_employee_unavailable"),
      resolveCurrent(
        resolveSchedule,
        { employeeId: task.employeeId, scheduleId: trigger.scheduleId },
        "schedule_task_schedule_unavailable",
      ),
    ]);
    if (!employee || employee.id !== task.employeeId) throw resolverError("schedule_task_employee_unavailable");
    if (String(employee.version || "") !== task.employeeVersion) {
      throw resolverError("schedule_task_employee_version_changed");
    }
    await requireRunnableEmployee(validateEmployee, employee);

    let schedule;
    try {
      schedule = normalizeGovernedSchedule(scheduleValue);
    } catch (error) {
      if (error?.code === "schedule_trigger_schedule_not_approved") {
        throw resolverError("schedule_task_schedule_not_approved");
      }
      throw resolverError("schedule_task_schedule_invalid");
    }
    requireCurrentScheduleMatch(task, trigger, schedule);
    const [authorizationDigest, executionContractDigest, schedulePolicyDigest] = await Promise.all([
      resolveCurrentDigest(
        resolveAuthorizationDigest,
        { employee, schedule, task, trigger },
        "schedule_task_authorization_unavailable",
      ),
      resolveCurrentDigest(
        resolveExecutionContractDigest,
        { employee, schedule, task, trigger },
        "schedule_task_execution_contract_unavailable",
      ),
      resolveCurrentDigest(
        resolveSchedulePolicyDigest,
        { employee, schedule, task, trigger },
        "schedule_task_schedule_policy_unavailable",
      ),
    ]);
    if (authorizationDigest !== trigger.authorizationDigest) {
      throw resolverError("schedule_task_authorization_changed");
    }
    if (executionContractDigest !== trigger.executionContractDigest) {
      throw resolverError("schedule_task_execution_contract_changed");
    }
    if (schedulePolicyDigest !== trigger.schedulePolicyDigest) {
      throw resolverError("schedule_task_schedule_policy_changed");
    }
    return Object.freeze({ employee, schedule, trigger });
  }

  return Object.freeze({
    contractVersion: SCHEDULE_TASK_INPUT_RESOLVER_CONTRACT_VERSION,
    resolve,
  });
}

function requireScheduleTask(task) {
  if (!task || typeof task !== "object" || Array.isArray(task) ||
    task.contractVersion !== EXECUTION_TASK_CONTRACT_VERSION ||
    task.channelId !== "schedule" || task.sourceSystemId !== "digital-workforce-scheduler" ||
    task.taskType !== "scheduled_employee_task" || task.sessionId !== null ||
    !task.executionInputRef || task.executionInputRef.kind !== "artifact_ref" ||
    typeof task.executionInputRef.refId !== "string" || !task.executionInputRef.refId) {
    throw resolverError("schedule_task_input_task_invalid");
  }
}

function assertScheduleTaskTriggerMatch(task, triggerValue) {
  requireScheduleTask(task);
  let trigger;
  try {
    trigger = normalizeScheduleTrigger(triggerValue);
  } catch {
    throw resolverError("schedule_task_trigger_invalid");
  }
  const matches = task.taskId === trigger.executionTaskId &&
    task.executionInputRef.refId === trigger.triggerId &&
    task.inputDigest === scheduleTriggerDigest(trigger) &&
    task.tenantScope === trigger.tenantScope &&
    task.actorIssuer === trigger.actorIssuer &&
    task.actorSubjectDigest === trigger.actorSubjectDigest &&
    task.employeeId === trigger.employeeId &&
    task.employeeVersion === trigger.employeeVersion &&
    task.createdAt === trigger.scheduledFor &&
    task.availableAt === trigger.scheduledFor;
  if (!matches) throw resolverError("schedule_task_trigger_binding_mismatch");
}

function requireCurrentScheduleMatch(task, trigger, schedule) {
  const matches = schedule.runConfigurationDigest === trigger.runConfigurationDigest &&
    schedule.tenantScope === trigger.tenantScope &&
    schedule.scheduleId === trigger.scheduleId &&
    schedule.scheduleVersion === trigger.scheduleVersion &&
    schedule.taskDefinitionId === trigger.taskDefinitionId &&
    schedule.actorIssuer === trigger.actorIssuer &&
    schedule.actorSubjectDigest === trigger.actorSubjectDigest &&
    schedule.authorizationDigest === trigger.authorizationDigest &&
    schedule.employeeId === trigger.employeeId &&
    schedule.employeeVersion === trigger.employeeVersion &&
    schedule.executionContractDigest === trigger.executionContractDigest &&
    schedule.permissionDigest === trigger.permissionDigest &&
    schedule.schedulePolicyDigest === trigger.schedulePolicyDigest &&
    isDeepStrictEqual(schedule.providerTimeoutPolicy, task.providerTimeoutPolicy);
  if (!matches) throw resolverError("schedule_task_governance_changed");
}

async function resolveCurrent(resolver, input, failureCode) {
  try {
    return await resolver(input);
  } catch {
    throw resolverError(failureCode);
  }
}

async function resolveCurrentDigest(resolver, input, failureCode) {
  let value;
  try {
    value = await resolver(input);
  } catch {
    throw resolverError(failureCode);
  }
  const digest = String(value || "").trim().toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(digest)) throw resolverError(failureCode);
  return digest;
}

async function requireRunnableEmployee(validateEmployee, employee) {
  let runnable;
  try {
    runnable = await validateEmployee(employee);
  } catch {
    throw resolverError("schedule_task_employee_state_unavailable");
  }
  if (runnable !== true) throw resolverError("schedule_task_employee_not_runnable");
}

function assertDependencies({
  resolveAuthorizationDigest,
  resolveEmployee,
  resolveExecutionContractDigest,
  resolveSchedule,
  resolveSchedulePolicyDigest,
  scheduleTriggerRepository,
  validateEmployee,
}) {
  if (typeof resolveEmployee !== "function") throw new TypeError("schedule task input resolver requires resolveEmployee");
  if (typeof resolveSchedule !== "function") throw new TypeError("schedule task input resolver requires resolveSchedule");
  if (typeof resolveAuthorizationDigest !== "function") {
    throw new TypeError("schedule task input resolver requires resolveAuthorizationDigest");
  }
  if (typeof resolveExecutionContractDigest !== "function") {
    throw new TypeError("schedule task input resolver requires resolveExecutionContractDigest");
  }
  if (typeof resolveSchedulePolicyDigest !== "function") {
    throw new TypeError("schedule task input resolver requires resolveSchedulePolicyDigest");
  }
  if (typeof validateEmployee !== "function") {
    throw new TypeError("schedule task input resolver requires validateEmployee");
  }
  if (typeof scheduleTriggerRepository?.get !== "function") {
    throw new TypeError("schedule task input resolver requires scheduleTriggerRepository.get");
  }
}

function resolverError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

export {
  SCHEDULE_TASK_INPUT_RESOLVER_CONTRACT_VERSION,
  assertScheduleTaskTriggerMatch,
  createScheduleTaskInputResolver,
};
