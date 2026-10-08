import crypto from "node:crypto";
import { createScheduleActivationSnapshotV3 } from "./schedule-activation-snapshot.mjs";
import { resolveScheduleAgentDependencies } from "./schedule-agent-context.mjs";
import { calculateLatestDueTime } from "./schedule-due-time-calculator.mjs";

const RESULT_DIGEST = crypto.createHash("sha256").update("schedule-agent-task-summary.v1").digest("hex");
const CONFIG_FIELDS = ["title", "taskInstruction", "schedule", "timezone", "timeoutSeconds", "maxConcurrentRuns", "overlapWindowMinutes"];

// Management owns administrator-authored task instructions and timing only.
// Mounted Skills/Tools remain governed by the employee's existing authorities.
export function createScheduleConfigurationService({ registry, repository, definitionRepository, controlRepository,
  resolveEmployee, getBusinessSkills, tenantScope, now = () => new Date().toISOString() } = {}) {
  function identity(employeeId, scheduleId) {
    return { tenantScope, employeeId: token(employeeId), scheduleId: token(scheduleId) };
  }
  function currentEmployee(employeeId) {
    const employee = resolveEmployee({ tenantScope, employeeId });
    if (!employee || !employee.version || !["在线", "试运行"].includes(employee.status)) throw failure("schedule_employee_unavailable");
    return employee;
  }
  function currentSchedule(id) {
    const schedule = repository.get(id.scheduleId, id);
    if (!schedule || schedule.contractVersion !== "governed-schedule-registration.v3" || !schedule.modelSelection) {
      throw failure("schedule_configuration_not_found");
    }
    return schedule;
  }
  function definitionFor(schedule) {
    const resolution = definitionRepository.resolveExact({ tenantScope,
      taskDefinitionId: schedule.taskId, executionContractDigest: schedule.executionContractDigest });
    if (!resolution || resolution.definition.executionMode !== "shared_agent_runtime") throw failure("schedule_definition_unavailable");
    return resolution.definition;
  }
  function read({ employeeId, scheduleId }) {
    const id = identity(employeeId, scheduleId), schedule = currentSchedule(id), definition = definitionFor(schedule);
    const control = controlRepository.getControl(id);
    return { contractVersion: "schedule-configuration.v1", scheduleId, registrationVersion: schedule.registrationVersion,
      controlVersion: control?.controlVersion || 0, state: control?.activationState || "registered",
      emergencyStopped: control?.emergencyStop.active || false,
      controlSyncRequired: !matches(control, schedule), modelSelection: schedule.modelSelection,
      configuration: Object.fromEntries(CONFIG_FIELDS.map(key => [key, key === "taskInstruction" ? definition.taskInstruction : schedule[key]])) };
  }
  function requireEditable(id, control, expectedControlVersion) {
    if ((control?.controlVersion || 0) !== expectedControlVersion) throw failure("schedule_control_version_conflict");
    if (control && (!["registered", "paused"].includes(control.activationState) || control.emergencyStop.active)) {
      throw failure("schedule_configuration_pause_required");
    }
    const summary = controlRepository.summarizeRuns(id);
    if (["prepared", "submitted", "cancel_requested", "reconcile_required"].some(key => summary.intents?.[key] > 0) ||
      ["active", "cancel_requested", "reconcile_blocked"].some(key => summary.executions?.[key] > 0)) {
      throw failure("schedule_configuration_runs_pending");
    }
  }
  function syncControl(id, schedule, expectedControlVersion) {
    return controlRepository.initializeRegisteredControl({ ...id, expectedControlVersion,
      registrationVersion: schedule.registrationVersion, scheduleVersion: schedule.scheduleVersion,
      schedulePolicyDigest: schedule.schedulePolicyDigest, executionContractDigest: schedule.executionContractDigest,
      maxConcurrentRuns: schedule.maxConcurrentRuns, overlapWindowMinutes: schedule.overlapWindowMinutes, initializedAt: now() });
  }
  function save({ employeeId, scheduleId, expectedRegistrationVersion, expectedControlVersion, configuration, modelAssignmentId, actor }) {
    const id = identity(employeeId, scheduleId), employee = currentEmployee(employeeId);
    const config = normalizeConfig(configuration);
    if (!Number.isSafeInteger(expectedRegistrationVersion) || expectedRegistrationVersion < 0 ||
      !Number.isSafeInteger(expectedControlVersion) || expectedControlVersion < 0) throw failure("schedule_configuration_invalid");
    const previous = repository.get(scheduleId, id);
    if (previous && previous.contractVersion !== "governed-schedule-registration.v3") throw failure("schedule_legacy_configuration_retired");
    if ((previous?.registrationVersion || 0) !== expectedRegistrationVersion) throw failure("governed_schedule_version_conflict");
    const control = controlRepository.getControl(id);
    requireEditable(id, control, expectedControlVersion);
    // Stable per-task identity allows explicit task-model assignments. Definition
    // versions are independent of registry versions so inert failed saves can retry.
    const taskId = previous?.taskId || `schedule-${crypto.createHash("sha256").update(JSON.stringify(id)).digest("hex")}`;
    const published = definitionRepository.publishNext({ tenantScope, definition: {
      contractVersion: "schedule-task-execution-definition.v3", executionMode: "shared_agent_runtime",
      taskDefinitionId: taskId, taskInstruction: config.taskInstruction,
      inputContract: { contractVersion: "schedule-task-input-contract.v3", retrievalMode: "schedule_context" },
      skillPolicyRef: "skill-policy:employee-mounted@v1", toolPolicyRef: "tool-policy:employee-mounted@v1",
      resultContractDigest: RESULT_DIGEST,
    } });
    const { taskInstruction: _, ...timing } = config;
    registry.register({ ...id, employee, actor, expectedRegistrationVersion, modelAssignmentId, scheduleScope: "system",
      configuration: { ...timing, taskId, taskDefinitionVersion: published.definition.taskDefinitionVersion } });
    const schedule = currentSchedule(id);
    try { syncControl(id, schedule, expectedControlVersion); }
    catch (error) {
      // Registry authority changed, so the old snapshot is no longer runnable.
      // Expose the recoverable state; activation rechecks and synchronizes it.
      return { ...read(id), controlSyncRequired: true, warning: "schedule_control_sync_required" };
    }
    return read(id);
  }
  function activate({ employeeId, scheduleId, expectedControlVersion }) {
    const id = identity(employeeId, scheduleId), employee = currentEmployee(employeeId), schedule = currentSchedule(id);
    let control = controlRepository.getControl(id);
    requireEditable(id, control, expectedControlVersion);
    if (!matches(control, schedule)) control = syncControl(id, schedule, expectedControlVersion);
    const { taskModelBinding, providerTimeoutPolicy } = registry.resolveAgentRunBinding({ ...id, employee });
    const authority = registry.resolveAgentAuthority({ ...id, employee });
    const definition = definitionFor(schedule);
    const { skillPolicyDigest, toolPolicyDigest } = resolveScheduleAgentDependencies({ employee,
      businessSkills: getBusinessSkills({ tenantScope, employee }), definition });
    const activationSnapshot = createScheduleActivationSnapshotV3({
      contractVersion: "schedule-activation-snapshot.v3", executionMode: "shared_agent_runtime",
      snapshotVersion: control.activationVersion + 1, activationVersion: control.activationVersion + 1,
      registrationVersion: schedule.registrationVersion, ...id, employeeVersion: employee.version,
      scheduleVersion: schedule.scheduleVersion, taskDefinitionId: schedule.taskId,
      taskDefinitionVersion: definition.taskDefinitionVersion, modelSelection: schedule.modelSelection,
      cron: schedule.schedule, timezone: schedule.timezone, missedSlotPolicy: schedule.missedSlotPolicy,
      timeoutSeconds: schedule.timeoutSeconds, maxConcurrentRuns: schedule.maxConcurrentRuns,
      overlapWindowMinutes: schedule.overlapWindowMinutes, ...authority,
      schedulePolicyDigest: schedule.schedulePolicyDigest, executionContractDigest: schedule.executionContractDigest,
      taskModelBinding, providerTimeoutPolicy, resultContractDigest: definition.resultContractDigest,
      skillPolicyDigest, toolPolicyDigest, createdAt: now(),
    });
    controlRepository.activate({ activationSnapshot, expectedControlVersion: control.controlVersion });
    return read(id);
  }
  function pause({ employeeId, scheduleId, expectedControlVersion }) {
    const id = identity(employeeId, scheduleId);
    currentSchedule(id);
    controlRepository.pause({ ...id, expectedControlVersion, pausedAt: now() });
    return read(id);
  }
  function list({ employeeId }) {
    return repository.list({ tenantScope, employeeId: token(employeeId) })
      .filter(schedule => schedule.contractVersion === "governed-schedule-registration.v3" && schedule.modelSelection)
      .map(schedule => read({ employeeId, scheduleId: schedule.id }));
  }
  return Object.freeze({ read, list, save, activate, pause });
}
function matches(control, schedule) {
  return Boolean(control && control.registrationVersion === schedule.registrationVersion &&
    control.schedulePolicyDigest === schedule.schedulePolicyDigest && control.executionContractDigest === schedule.executionContractDigest);
}
function token(value) {
  if (typeof value !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,159}$/.test(value)) throw failure("schedule_configuration_invalid");
  return value;
}
function normalizeConfig(value) {
  if (!value || Array.isArray(value) || Object.keys(value).length !== CONFIG_FIELDS.length ||
    Object.keys(value).some(key => !CONFIG_FIELDS.includes(key))) throw failure("schedule_configuration_invalid");
  for (const [key, max] of [["title", 160], ["taskInstruction", 16384], ["schedule", 120], ["timezone", 100]]) {
    if (typeof value[key] !== "string" || !value[key].trim() || value[key].length > max) throw failure("schedule_configuration_invalid");
  }
  for (const [key, min, max] of [["timeoutSeconds", 1, 86400], ["maxConcurrentRuns", 1, 100], ["overlapWindowMinutes", 0, 1440]]) {
    if (!Number.isSafeInteger(value[key]) || value[key] < min || value[key] > max) throw failure("schedule_configuration_invalid");
  }
  calculateLatestDueTime({ cronExpression: value.schedule, timezone: value.timezone,
    afterExclusive: "2026-01-01T00:00:00.000Z", throughInclusive: "2026-01-01T00:00:00.000Z" });
  return Object.fromEntries(CONFIG_FIELDS.map(key => [key, typeof value[key] === "string" ? value[key].trim() : value[key]]));
}
function failure(code) { return Object.assign(new Error(code), { code }); }
