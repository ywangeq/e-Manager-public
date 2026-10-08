import { normalizeAgentModelSelection } from "./schedule-activation-snapshot.mjs";
import crypto from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { calculateLatestDueTime } from "./schedule-due-time-calculator.mjs";
import { normalizeProviderTimeoutPolicy } from "./provider-timeout-policy.mjs";
import { normalizeScheduleTaskExecutionDefinition } from "./schedule-task-execution-definition.mjs";
import { resolveAppliedTaskModelAssignments } from "../digital-employee-model-assignments.mjs";

const LEGACY_GOVERNED_SCHEDULE_REGISTRATION_CONTRACT_VERSION = "governed-schedule-registration.v1";
const GOVERNED_SCHEDULE_REGISTRATION_CONTRACT_VERSION = "governed-schedule-registration.v2";
const AGENT_GOVERNED_SCHEDULE_REGISTRATION_CONTRACT_VERSION = "governed-schedule-registration.v3";
const SCHEDULE_REGISTRATION_CONTEXT_CONTRACT_VERSION = "digital-employee-schedule-registration-context.v1";
const TASK_MODEL_BINDING_CONTRACT_VERSION = "digital-employee-task-model-binding.v1";
const SCHEDULE_BUSINESS_OWNER_CURRENT_BINDING_CONTRACT_VERSION = "schedule-business-owner-current-binding.v1";
const SCHEDULE_BUSINESS_OWNER_ACCEPTANCE_POLICY_CONTRACT_VERSION = "schedule-business-owner-acceptance-policy.v1";
const SCHEDULE_WRITEBACK_CONTRACT_VERSION = "schedule-writeback-contract.v1";
const LEGACY_SCHEDULE_FIELDS = new Set([
  "contractVersion",
  "employeeId",
  "enabled",
  "executionContractDigest",
  "executionMode",
  "id",
  "idempotencyKeyContract",
  "lastRun",
  "maxConcurrentRuns",
  "missedSlotPolicy",
  "nextRun",
  "overlapWindowMinutes",
  "ownerPrincipalId",
  "ownerPrincipalType",
  "registrationStatus",
  "registrationVersion",
  "remainingGates",
  "resultContract",
  "reviewGate",
  "reviewStatus",
  "schedule",
  "schedulePolicyDigest",
  "scheduleScope",
  "scheduleVersion",
  "source",
  "status",
  "taskId",
  "taskModelBinding",
  "tenantScope",
  "timeoutSeconds",
  "timezone",
  "title",
  "triggerMode",
  "updatedAt",
  "updatedBy",
  "updatedByDisplayName",
  "writebackMode",
]);
const CURRENT_SCHEDULE_FIELDS = new Set([
  ...LEGACY_SCHEDULE_FIELDS,
  "acceptancePolicy",
  "employeeVersion",
  "registrarSubjectDigest",
  "updatedByIdentitySource",
  "writebackContractDigest",
]);
const AGENT_SCHEDULE_FIELDS = new Set([...CURRENT_SCHEDULE_FIELDS].filter((field) => !["acceptancePolicy", "writebackContractDigest"].includes(field)).concat(["taskDefinitionVersion", "modelSelection"]));
const ACCEPTANCE_POLICY_FIELDS = new Set([
  "contractVersion",
  "maxValiditySeconds",
  "policyDigest",
  "policyVersion",
]);
const BINDING_FIELDS = new Set([
  "assignmentAppliedVersion",
  "assignmentId",
  "assignmentSetDigest",
  "bindingDigest",
  "bindingVersion",
  "contractVersion",
  "model",
  "modelId",
  "modelLevelId",
  "provider",
  "providerName",
  "providerRouteId",
  "requiredCapabilityProfileVersion",
  "status",
  "taskId",
]);
const SECRET_PATTERN = /(?:bearer\s+|sk-[a-z0-9_-]{8,}|(?:api|app)[ _-]?(?:key|secret)\s*[:=])/i;
const SCHEDULE_WRITEBACK_CONTRACT_DIGEST = digestCanonical({
  contractVersion: SCHEDULE_WRITEBACK_CONTRACT_VERSION,
  mode: "none",
});
const DEFAULT_SCHEDULE_BUSINESS_OWNER_ACCEPTANCE_POLICY = deepFreeze({
  contractVersion: SCHEDULE_BUSINESS_OWNER_ACCEPTANCE_POLICY_CONTRACT_VERSION,
  policyVersion: "schedule-owner-acceptance-standard-v1",
  maxValiditySeconds: 24 * 60 * 60,
  policyDigest: acceptancePolicyDigest({
    contractVersion: SCHEDULE_BUSINESS_OWNER_ACCEPTANCE_POLICY_CONTRACT_VERSION,
    policyVersion: "schedule-owner-acceptance-standard-v1",
    maxValiditySeconds: 24 * 60 * 60,
  }),
});

function createGovernedScheduleRegistry({
  aiModelCatalog = [],
  getProviderRoutes = () => [],
  registrarSubjectHmacKey,
  repository,
  resolveProviderTimeoutPolicy,
  resolveTaskExecutionDefinitionExact,
  resolveTaskExecutionDefinitionVersion,
  validateEmployee = defaultValidateDispatchEmployee,
} = {}) {
  if (typeof repository?.get !== "function" || typeof repository?.list !== "function" || typeof repository?.upsert !== "function") {
    throw new TypeError("governed schedule registry requires a repository");
  }
  if (typeof getProviderRoutes !== "function") throw new TypeError("governed schedule registry requires getProviderRoutes");
  const subjectHmacKey = requiredHmacKey(registrarSubjectHmacKey);
  if (typeof resolveProviderTimeoutPolicy !== "function") {
    throw new TypeError("governed schedule registry requires resolveProviderTimeoutPolicy");
  }
  if (resolveTaskExecutionDefinitionExact !== undefined &&
    typeof resolveTaskExecutionDefinitionExact !== "function") {
    throw new TypeError("resolveTaskExecutionDefinitionExact must be a function");
  }
  if (resolveTaskExecutionDefinitionVersion !== undefined &&
    typeof resolveTaskExecutionDefinitionVersion !== "function") {
    throw new TypeError("resolveTaskExecutionDefinitionVersion must be a function");
  }
  if (typeof validateEmployee !== "function") throw new TypeError("governed schedule registry requires validateEmployee");

  function register({
    actor,
    employee,
    expectedRegistrationVersion,
    modelAssignmentId,
    modelId,
    scheduleId,
    scheduleScope = "system",
    configuration = null,
    tenantScope,
  } = {}) {
    const safeTenantScope = identifier(tenantScope, "tenantScope");
    const safeScheduleId = identifier(scheduleId, "scheduleId");
    const expectedVersion = boundedInteger(expectedRegistrationVersion, 0, Number.MAX_SAFE_INTEGER, "expectedRegistrationVersion");
    if (!employee?.id) throw registryError("governed_schedule_employee_not_found");
    const employeeId = identifier(employee.id, "employeeId");
    const auditActor = normalizeActor(actor);
    const ownership = scheduleOwnership({ employee, scheduleScope });
    const declaration = configuration === null ? scheduleDeclaration(employee, safeScheduleId) : normalizeAgentScheduleConfiguration(configuration);
    const taskId = identifier(declaration.taskId, "taskId");
    const taskDefinitionVersion = declaredTaskDefinitionVersion(declaration.taskDefinitionVersion);
    const now = new Date().toISOString();
    const taskDefinitionResolution = requireTaskExecutionDefinitionVersion({
      evaluatedAt: now,
      resolver: resolveTaskExecutionDefinitionVersion,
      taskDefinitionId: taskId,
      taskDefinitionVersion,
      tenantScope: safeTenantScope,
    });
    const agentMode = taskDefinitionResolution.definition.executionMode === "shared_agent_runtime";
    if (configuration !== null && !agentMode) throw registryError("governed_schedule_agent_definition_required");
    const taskBinding = resolveAssignedTaskBinding({
      aiModelCatalog,
      employee,
      getProviderRoutes,
      bindingVersion: `binding-${expectedVersion + 1}`,
      modelAssignmentId,
      modelId,
      taskId,
      agentMode,
    });

    const modelSelection = agentMode ? normalizeAgentModelSelection(modelAssignmentId
      ? { mode: "assignment", assignmentId: modelAssignmentId } : { mode: "employee_primary" }) : null;
    const scheduleVersion = `schedule-${expectedVersion + 1}`;
    const schedulePolicyDigest = digestCanonical({
      ...(agentMode ? { modelSelection } : {}),
      maxConcurrentRuns: requiredBoundedInteger(declaration.maxConcurrentRuns, 1, 100, "maxConcurrentRuns"),
      missedSlotPolicy: "latest_only",
      overlapWindowMinutes: requiredBoundedInteger(declaration.overlapWindowMinutes, 0, 1440, "overlapWindowMinutes"),
      scheduleScope: ownership.scheduleScope,
      ownerPrincipalType: ownership.ownerPrincipalType,
      ownerPrincipalId: ownership.ownerPrincipalId,
      schedule: basicCron(declaration.schedule),
      timeoutSeconds: requiredBoundedInteger(declaration.timeoutSeconds, 1, 86400, "timeoutSeconds"),
      timezone: canonicalTimezone(declaration.timezone),
    });
    const record = normalizeGovernedScheduleRegistration({
      contractVersion: agentMode ? AGENT_GOVERNED_SCHEDULE_REGISTRATION_CONTRACT_VERSION : GOVERNED_SCHEDULE_REGISTRATION_CONTRACT_VERSION,
      ...(agentMode ? { taskDefinitionVersion, modelSelection } : {}),
      tenantScope: safeTenantScope,
      employeeId,
      employeeVersion: identifier(employee.version, "employeeVersion"),
      id: safeScheduleId,
      scheduleVersion,
      registrationVersion: expectedVersion + 1,
      title: safeText(declaration.title || declaration.name || safeScheduleId, 160),
      taskId,
      triggerMode: "cron",
      schedule: basicCron(declaration.schedule),
      timezone: canonicalTimezone(declaration.timezone),
      missedSlotPolicy: "latest_only",
      timeoutSeconds: requiredBoundedInteger(declaration.timeoutSeconds, 1, 86400, "timeoutSeconds"),
      maxConcurrentRuns: requiredBoundedInteger(declaration.maxConcurrentRuns, 1, 100, "maxConcurrentRuns"),
      overlapWindowMinutes: requiredBoundedInteger(declaration.overlapWindowMinutes, 0, 1440, "overlapWindowMinutes"),
      scheduleScope: ownership.scheduleScope,
      ownerPrincipalType: ownership.ownerPrincipalType,
      ownerPrincipalId: ownership.ownerPrincipalId,
      idempotencyKeyContract: safeText(declaration.idempotencyKeyContract, 500),
      resultContract: safeText(declaration.resultContract, 500),
      reviewGate: safeText(declaration.reviewGate, 500),
      enabled: false,
      reviewStatus: "approved",
      registrationStatus: "applied",
      status: "registered_blocked",
      executionMode: agentMode ? "shared_agent_runtime" : "provider_dry_run_pending",
      writebackMode: agentMode ? "governed_tools" : "none",
      ...(!agentMode ? { writebackContractDigest: SCHEDULE_WRITEBACK_CONTRACT_DIGEST,
        acceptancePolicy: DEFAULT_SCHEDULE_BUSINESS_OWNER_ACCEPTANCE_POLICY } : {}),
      source: "governed_schedule_registry",
      lastRun: "",
      nextRun: "",
      remainingGates: agentMode ? ["current_authority", "skill_tool_policy", "agent_activation"] : [
        "provider_credential",
        "provider_only_dry_run",
        "schedule_run_ledger",
        "overlap_fencing",
        "emergency_stop",
        "result_parser_alerting",
        "business_owner_acceptance",
      ],
      taskModelBinding: taskBinding,
      schedulePolicyDigest,
      executionContractDigest: taskDefinitionResolution.executionContractDigest,
      registrarSubjectDigest: registrarSubjectDigest({
        actor: auditActor,
        key: subjectHmacKey,
        tenantScope: safeTenantScope,
      }),
      updatedAt: now,
      updatedBy: auditActor.principalId,
      updatedByDisplayName: auditActor.displayName,
      updatedByIdentitySource: auditActor.identitySource,
    });
    const saved = repository.upsert(record, { expectedRegistrationVersion: expectedVersion });
    return Object.freeze({ ...saved, schedule: publicScheduleProjection(saved.schedule) });
  }

  function registrationContext({ employee, scheduleId, tenantScope, configuration = null, modelAssignmentId } = {}) {
    const safeTenantScope = identifier(tenantScope, "tenantScope");
    const safeScheduleId = identifier(scheduleId, "scheduleId");
    if (!employee?.id) throw registryError("governed_schedule_employee_not_found");
    const employeeId = identifier(employee.id, "employeeId");
    const declaration = configuration === null ? scheduleDeclaration(employee, safeScheduleId) : normalizeAgentScheduleConfiguration(configuration);
    const taskId = identifier(declaration.taskId, "taskId");
    const taskDefinitionVersion = declaredTaskDefinitionVersion(declaration.taskDefinitionVersion);
    const resolution = requireTaskExecutionDefinitionVersion({
      evaluatedAt: new Date().toISOString(),
      resolver: resolveTaskExecutionDefinitionVersion,
      taskDefinitionId: taskId,
      taskDefinitionVersion,
      tenantScope: safeTenantScope,
    });
    const agentMode = resolution.definition.executionMode === "shared_agent_runtime";
    if (configuration !== null && !agentMode) throw registryError("governed_schedule_agent_definition_required");
    const modelOptions = resolveAssignedTaskModelOptions({
      aiModelCatalog,
      employee,
      getProviderRoutes,
      taskId,
      agentMode,
      modelAssignmentId,
    }).map(publicTaskModelOption);

    const current = repository.get(safeScheduleId, { employeeId, tenantScope: safeTenantScope });
    return deepFreeze({
      contractVersion: SCHEDULE_REGISTRATION_CONTEXT_CONTRACT_VERSION,
      candidate: {
        id: safeScheduleId,
        title: safeText(declaration.title || declaration.name || safeScheduleId, 160),
        taskId,
        taskDefinitionVersion,
        triggerMode: "cron",
        schedule: basicCron(declaration.schedule),
        timezone: canonicalTimezone(declaration.timezone),
        missedSlotPolicy: "latest_only",
        timeoutSeconds: requiredBoundedInteger(declaration.timeoutSeconds, 1, 86400, "timeoutSeconds"),
        maxConcurrentRuns: requiredBoundedInteger(declaration.maxConcurrentRuns, 1, 100, "maxConcurrentRuns"),
        overlapWindowMinutes: requiredBoundedInteger(declaration.overlapWindowMinutes, 0, 1440, "overlapWindowMinutes"),
      },
      expectedRegistrationVersion: Number(current?.registrationVersion || 0),
      modelOptions,
      modelSelectionMode: modelOptions.length === 1 ? "fixed" : "required",
      allowedScheduleScopes: ["department", "system"],
      canRegister: true,
      initialState: {
        enabled: false,
        executionMode: agentMode ? "shared_agent_runtime" : "provider_dry_run_pending",
        status: "registered_blocked",
        writebackMode: agentMode ? "governed_tools" : "none",
      },
      registrationAudit: current ? {
        registeredBy: {
          principalId: current.updatedBy,
          displayName: current.updatedByDisplayName || "目录姓名待解析",
          nameStatus: current.updatedByDisplayName ? "resolved" : "unresolved",
        },
        registeredAt: current.updatedAt,
      } : null,
    });
  }

  function withRegisteredSchedules(employees = [], { tenantScope } = {}) {
    const safeTenantScope = identifier(tenantScope, "tenantScope");
    const schedules = repository.list({ tenantScope: safeTenantScope });
    const byEmployee = new Map();
    for (const schedule of schedules) {
      const items = byEmployee.get(schedule.employeeId) || [];
      items.push(publicScheduleProjection(schedule));
      byEmployee.set(schedule.employeeId, items);
    }
    return employees.map((employee) => ({
      ...employee,
      runtimeSchedules: byEmployee.get(employee.id) || [],
    }));
  }

  function resolveCurrent({ employeeId, scheduleId, tenantScope } = {}) {
    const record = repository.get(scheduleId, { employeeId, tenantScope });
    if (!record) throw registryError("governed_schedule_not_found");
    requireTaskExecutionDefinitionExact({
      evaluatedAt: new Date().toISOString(),
      executionContractDigest: record.executionContractDigest,
      resolver: resolveTaskExecutionDefinitionExact,
      taskDefinitionId: record.taskId,
      tenantScope: record.tenantScope,
    });
    // Registration-time model evidence must not pin future Agent runs. The
    // selected current assignment and route are validated by resolveAgentRunBinding.
    if (record.contractVersion === AGENT_GOVERNED_SCHEDULE_REGISTRATION_CONTRACT_VERSION && record.modelSelection) {
      return normalizeGovernedScheduleRegistration(record);
    }
    const binding = resolveExactTaskModelBinding({
      aiModelCatalog,
      getProviderRoutes,
      schedule: record,
      taskId: record.taskId,
    });
    if (binding.bindingDigest !== record.taskModelBinding.bindingDigest) {
      throw registryError("governed_schedule_task_model_binding_changed");
    }
    return Object.freeze({ ...record, taskModelBinding: binding });
  }

  function resolveDispatchSchedule({ employee, purpose, scheduleId, tenantScope } = {}) {
    if (!employee?.id) throw registryError("governed_schedule_employee_not_found");
    if (purpose !== "provider_dry_run") throw registryError("governed_schedule_dispatch_purpose_invalid");
    requireDispatchableEmployee(validateEmployee, employee);
    const schedule = resolveCurrent({
      employeeId: employee.id,
      scheduleId,
      tenantScope,
    });
    if (schedule.contractVersion === GOVERNED_SCHEDULE_REGISTRATION_CONTRACT_VERSION &&
      identifier(employee.version, "employeeVersion") !== schedule.employeeVersion) {
      throw registryError("governed_schedule_employee_changed");
    }
    if (schedule.registrationStatus !== "applied" || schedule.reviewStatus !== "approved" || schedule.enabled !== false ||
      schedule.status !== "registered_blocked" || schedule.executionMode !== "provider_dry_run_pending" || schedule.writebackMode !== "none") {
      throw registryError("governed_schedule_provider_dry_run_not_allowed");
    }
    const taskModelBinding = resolveCurrentTaskAssignment({
      aiModelCatalog,
      employee,
      getProviderRoutes,
      registeredSchedule: schedule,
    });
    return deepFreeze({
      contractVersion: "schedule-provider-dispatch.v1",
      tenantScope: schedule.tenantScope,
      employeeId: schedule.employeeId,
      employeeVersion: identifier(employee.version, "employeeVersion"),
      scheduleId: schedule.id,
      scheduleVersion: schedule.scheduleVersion,
      registrationVersion: schedule.registrationVersion,
      taskId: schedule.taskId,
      taskModelBinding,
      executionContractDigest: schedule.executionContractDigest,
      schedulePolicyDigest: schedule.schedulePolicyDigest,
    });
  }

  function resolveAgentRunBinding({ employee, scheduleId, tenantScope } = {}) {
    if (!employee?.id) throw registryError("governed_schedule_employee_not_found");
    requireDispatchableEmployee(validateEmployee, employee);
    const schedule = resolveCurrent({ employeeId: employee.id, scheduleId, tenantScope });
    if (schedule.contractVersion !== AGENT_GOVERNED_SCHEDULE_REGISTRATION_CONTRACT_VERSION ||
      schedule.registrationStatus !== "applied" || schedule.reviewStatus !== "approved") {
      throw registryError("governed_schedule_agent_definition_required");
    }
    const taskModelBinding = resolveCurrentTaskAssignment({ aiModelCatalog, employee, getProviderRoutes, registeredSchedule: schedule });
    const routePolicy = normalizeProviderTimeoutPolicy(resolveProviderTimeoutPolicy({ employee, providerBinding: taskModelBinding, schedule }));
    const taskExecutionTotalMs = Math.min(routePolicy.taskExecutionTotalMs, schedule.timeoutSeconds * 1000);
    const requestTotalMs = Math.min(routePolicy.requestTotalMs, taskExecutionTotalMs);
    const providerTimeoutPolicy = normalizeProviderTimeoutPolicy({ ...routePolicy,
      taskExecutionTotalMs, requestTotalMs,
      connectMs: Math.min(routePolicy.connectMs, requestTotalMs),
      firstSemanticOutputMs: Math.min(routePolicy.firstSemanticOutputMs, requestTotalMs),
      streamIdleMs: Math.min(routePolicy.streamIdleMs, requestTotalMs),
    });
    return deepFreeze({ schedule, taskModelBinding, providerTimeoutPolicy });
  }

  // A current, administrator-approved registration is the system task grant.
  // Model/Skill selection is deliberately separate: updates apply to new runs,
  // while this identity remains available to revalidate already frozen runs.
  function resolveAgentAuthority({ employee, scheduleId, tenantScope } = {}) {
    requireDispatchableEmployee(validateEmployee, employee);
    const schedule = resolveCurrent({ employeeId: employee.id, scheduleId, tenantScope });
    if (schedule.contractVersion !== AGENT_GOVERNED_SCHEDULE_REGISTRATION_CONTRACT_VERSION ||
      !schedule.modelSelection || schedule.registrationStatus !== "applied" || schedule.reviewStatus !== "approved" ||
      schedule.scheduleScope !== "system") throw registryError("governed_schedule_agent_authority_unavailable");
    const ownership = scheduleOwnership({ employee, scheduleScope: schedule.scheduleScope });
    if (ownership.ownerPrincipalType !== schedule.ownerPrincipalType || ownership.ownerPrincipalId !== schedule.ownerPrincipalId) {
      throw registryError("governed_schedule_owner_changed");
    }
    const owner = { principalType: ownership.ownerPrincipalType, principalId: ownership.ownerPrincipalId };
    const subjectDigest = crypto.createHmac("sha256", subjectHmacKey).update(JSON.stringify({
      contractVersion: "schedule-service-subject.v1", tenantScope: schedule.tenantScope,
      subject: "digital-workforce-scheduler",
    })).digest("hex");
    const authorizationDigest = digestCanonical({
      contractVersion: "schedule-system-registration-authority.v1", tenantScope: schedule.tenantScope,
      employeeId: schedule.employeeId, scheduleId: schedule.id, registrationVersion: schedule.registrationVersion,
      registrarSubjectDigest: schedule.registrarSubjectDigest, executionContractDigest: schedule.executionContractDigest,
      schedulePolicyDigest: schedule.schedulePolicyDigest, owner,
    });
    const permissionDigest = digestCanonical({
      contractVersion: "schedule-system-execution-permission.v1", authorizationDigest,
      scheduleScope: schedule.scheduleScope, executionMode: "shared_agent_runtime", writebackMode: "governed_tools",
    });
    return deepFreeze({ actor: { issuer: "digital-workforce-scheduler", subjectDigest, authorizationDigest, permissionDigest },
      owner, scheduleScope: schedule.scheduleScope });
  }

  function resolveOwnerAcceptanceBinding({ employee, scheduleId, tenantScope } = {}) {
    if (!employee?.id) throw registryError("governed_schedule_employee_not_found");
    requireDispatchableEmployee(validateEmployee, employee);
    const schedule = resolveCurrent({
      employeeId: employee.id,
      scheduleId,
      tenantScope,
    });
    if (schedule.contractVersion !== GOVERNED_SCHEDULE_REGISTRATION_CONTRACT_VERSION) {
      throw registryError("governed_schedule_owner_acceptance_reregistration_required");
    }
    if (schedule.registrationStatus !== "applied" || schedule.reviewStatus !== "approved" || schedule.enabled !== false ||
      schedule.status !== "registered_blocked" || schedule.executionMode !== "provider_dry_run_pending" ||
      schedule.writebackMode !== "none") {
      throw registryError("governed_schedule_owner_acceptance_not_allowed");
    }
    const employeeVersion = identifier(employee.version, "employeeVersion");
    if (employeeVersion !== schedule.employeeVersion) {
      throw registryError("governed_schedule_employee_changed");
    }
    const expectedRegistrarDigest = registrarSubjectDigest({
      actor: {
        principalId: schedule.updatedBy,
        identitySource: schedule.updatedByIdentitySource,
      },
      key: subjectHmacKey,
      tenantScope: schedule.tenantScope,
    });
    if (expectedRegistrarDigest !== schedule.registrarSubjectDigest) {
      throw registryError("governed_schedule_registrar_identity_changed");
    }
    const taskModelBinding = resolveCurrentTaskAssignment({
      aiModelCatalog,
      employee,
      getProviderRoutes,
      registeredSchedule: schedule,
    });
    let providerTimeoutPolicy;
    try {
      providerTimeoutPolicy = normalizeProviderTimeoutPolicy(resolveProviderTimeoutPolicy({
        employee,
        providerBinding: taskModelBinding,
        schedule,
      }));
    } catch {
      throw registryError("governed_schedule_provider_timeout_policy_unavailable");
    }
    return deepFreeze({
      contractVersion: SCHEDULE_BUSINESS_OWNER_CURRENT_BINDING_CONTRACT_VERSION,
      tenantScope: schedule.tenantScope,
      employeeId: schedule.employeeId,
      employeeVersion,
      scheduleId: schedule.id,
      scheduleVersion: schedule.scheduleVersion,
      registrationVersion: schedule.registrationVersion,
      registrarSubjectDigest: schedule.registrarSubjectDigest,
      taskDefinitionId: schedule.taskId,
      schedulePolicyDigest: schedule.schedulePolicyDigest,
      executionContractDigest: schedule.executionContractDigest,
      taskModelBinding,
      providerTimeoutPolicy,
      ownerTarget: {
        targetType: schedule.ownerPrincipalType,
        targetId: schedule.ownerPrincipalId,
      },
      writebackContractDigest: schedule.writebackContractDigest,
      acceptancePolicy: schedule.acceptancePolicy,
    });
  }

  return Object.freeze({
    register,
    registrationContext,
    resolveCurrent,
    resolveDispatchSchedule,
    resolveOwnerAcceptanceBinding,
    resolveAgentRunBinding,
    resolveAgentAuthority,
    withRegisteredSchedules,
  });
}

function requireTaskExecutionDefinitionVersion({
  evaluatedAt,
  resolver,
  taskDefinitionId,
  taskDefinitionVersion,
  tenantScope,
}) {
  return requireTaskExecutionDefinition({
    evaluatedAt,
    expectedTaskDefinitionId: taskDefinitionId,
    expectedTaskDefinitionVersion: taskDefinitionVersion,
    resolver,
    request: { tenantScope, taskDefinitionId, taskDefinitionVersion },
  });
}

function requireTaskExecutionDefinitionExact({
  evaluatedAt,
  executionContractDigest,
  resolver,
  taskDefinitionId,
  tenantScope,
}) {
  return requireTaskExecutionDefinition({
    evaluatedAt,
    expectedExecutionContractDigest: executionContractDigest,
    expectedTaskDefinitionId: taskDefinitionId,
    resolver,
    request: { tenantScope, taskDefinitionId, executionContractDigest },
  });
}

function requireTaskExecutionDefinition({
  evaluatedAt,
  expectedExecutionContractDigest = null,
  expectedTaskDefinitionId,
  expectedTaskDefinitionVersion = null,
  request,
  resolver,
}) {
  if (typeof resolver !== "function") {
    throw registryError("governed_schedule_task_definition_authority_unavailable");
  }
  let resolution;
  try {
    resolution = resolver(request);
  } catch {
    throw registryError("governed_schedule_task_definition_authority_unavailable");
  }
  if (!resolution) throw registryError("governed_schedule_task_definition_not_published");
  const fields = ["contractVersion", "definition", "executionContractDigest", "payloadBoundary", "publishedAt"];
  if (typeof resolution !== "object" || Array.isArray(resolution) || resolution instanceof Promise ||
    !isDeepStrictEqual(Object.keys(resolution).sort(), fields)) {
    throw registryError("governed_schedule_task_definition_resolution_invalid");
  }
  let definition;
  let publishedAt;
  let resolvedDigest;
  try {
    if (resolution.contractVersion !== "schedule-task-execution-definition-resolution.v1" ||
      resolution.payloadBoundary !== "internal_only") {
      throw new TypeError("task definition resolution boundary invalid");
    }
    definition = normalizeScheduleTaskExecutionDefinition(resolution.definition);
    if (!["schedule-task-execution-definition.v2", "schedule-task-execution-definition.v3"].includes(definition.contractVersion)) {
      throw new TypeError("unsupported runnable Schedule definition");
    }
    publishedAt = requiredTimestamp(resolution.publishedAt, "publishedAt");
    resolvedDigest = requiredDigest(resolution.executionContractDigest, "executionContractDigest");
  } catch {
    throw registryError("governed_schedule_task_definition_resolution_invalid");
  }
  if (definition.taskDefinitionId !== expectedTaskDefinitionId ||
    (expectedTaskDefinitionVersion !== null &&
      definition.taskDefinitionVersion !== expectedTaskDefinitionVersion) ||
    (expectedExecutionContractDigest !== null && resolvedDigest !== expectedExecutionContractDigest) ||
    publishedAt > requiredTimestamp(evaluatedAt, "evaluatedAt")) {
    throw registryError("governed_schedule_task_definition_binding_mismatch");
  }
  return Object.freeze({ definition, executionContractDigest: resolvedDigest, publishedAt });
}

function resolveAssignedTaskBinding({ aiModelCatalog, bindingVersion, employee, getProviderRoutes, modelAssignmentId, modelId, taskId, agentMode = false }) {
  const options = resolveAssignedTaskModelOptions({ aiModelCatalog, employee, getProviderRoutes, taskId, agentMode, modelAssignmentId });
  const selectedAssignmentId = String(modelAssignmentId || "").trim();
  const selectedModelId = String(modelId || "").trim();
  const selected = selectedAssignmentId
    ? options.filter((item) => item.assignmentId === selectedAssignmentId)
    : selectedModelId
      ? options.filter((item) => item.modelId === selectedModelId)
    : options.length === 1 ? options : [];
  if (!selectedAssignmentId && !selectedModelId && options.length > 1) throw registryError("governed_schedule_task_model_selection_required");
  if (selected.length !== 1) throw registryError("governed_schedule_task_model_not_allowed");
  if (selectedAssignmentId && selectedModelId && selected[0].modelId !== selectedModelId) {
    throw registryError("governed_schedule_task_model_not_allowed");
  }
  return normalizeTaskModelBinding({ ...selected[0], bindingVersion, status: "applied" });
}

function resolveAssignedTaskModelOptions({ aiModelCatalog, employee, getProviderRoutes, taskId, agentMode = false, modelAssignmentId }) {
  const resolved = resolveAppliedTaskModelAssignments({
    aiModelCatalog,
    employee,
    getProviderRoutes,
    taskDefinitionId: taskId,
    selectionMode: agentMode ? (modelAssignmentId ? "assignment" : "primary") : "task",
    ...(agentMode && modelAssignmentId ? { assignmentId: modelAssignmentId } : {}),
  });
  if (!resolved.items.length) throw registryError("governed_schedule_task_model_assignment_required");
  return resolved.items.map((assignment) => normalizeTaskModelBinding({
    contractVersion: TASK_MODEL_BINDING_CONTRACT_VERSION,
    taskId,
    assignmentId: assignment.assignmentId,
    assignmentAppliedVersion: resolved.appliedVersion,
    assignmentSetDigest: resolved.assignmentDigest,
    bindingVersion: "candidate",
    status: "applied",
    modelId: assignment.modelId,
    provider: assignment.provider,
    providerName: assignment.providerName,
    model: assignment.model,
    modelLevelId: assignment.modelLevelId,
    providerRouteId: assignment.providerRouteId,
    requiredCapabilityProfileVersion: assignment.requiredCapabilityProfileVersion,
    bindingDigest: taskBindingDigest({
      assignmentAppliedVersion: resolved.appliedVersion,
      assignmentId: assignment.assignmentId,
      assignmentSetDigest: resolved.assignmentDigest,
      model: assignment,
      modelLevelId: assignment.modelLevelId,
      taskId,
    }, getProviderRoutes),
  }));
}

function resolveExactTaskModelBinding({ aiModelCatalog = [], getProviderRoutes = () => [], schedule, taskId } = {}) {
  const record = normalizeGovernedScheduleRegistration(schedule);
  const safeTaskId = identifier(taskId, "taskId");
  if (record.taskId !== safeTaskId || record.taskModelBinding.taskId !== safeTaskId) {
    throw registryError("governed_schedule_task_model_binding_mismatch");
  }
  if (record.taskModelBinding.status !== "applied") throw registryError("governed_schedule_task_model_binding_not_applied");
  const model = aiModelCatalog.find((item) => item.id === record.taskModelBinding.modelId);
  if (!model || model.model !== record.taskModelBinding.model || model.provider !== record.taskModelBinding.provider ||
    model.providerRouteId !== record.taskModelBinding.providerRouteId ||
    model.requiredCapabilityProfileVersion !== record.taskModelBinding.requiredCapabilityProfileVersion ||
    !model.supportedLevelIds?.includes(record.taskModelBinding.modelLevelId)) {
    throw registryError("governed_schedule_task_model_catalog_changed");
  }
  const bindingDigest = taskBindingDigest({
    assignmentAppliedVersion: record.taskModelBinding.assignmentAppliedVersion,
    assignmentId: record.taskModelBinding.assignmentId,
    assignmentSetDigest: record.taskModelBinding.assignmentSetDigest,
    model,
    modelLevelId: record.taskModelBinding.modelLevelId,
    taskId: safeTaskId,
  }, getProviderRoutes);
  return normalizeTaskModelBinding({ ...record.taskModelBinding, bindingDigest });
}

function resolveCurrentTaskAssignment({ aiModelCatalog = [], employee, getProviderRoutes = () => [], registeredSchedule } = {}) {
  const schedule = normalizeGovernedScheduleRegistration(registeredSchedule);
  if (!employee?.id || identifier(employee.id, "employeeId") !== schedule.employeeId) {
    throw registryError("governed_schedule_employee_changed");
  }
  if (schedule.contractVersion === AGENT_GOVERNED_SCHEDULE_REGISTRATION_CONTRACT_VERSION) {
    if (!schedule.modelSelection) throw registryError("governed_schedule_model_selection_migration_required");
    return resolveAssignedTaskBinding({ aiModelCatalog, employee, getProviderRoutes, taskId: schedule.taskId,
      bindingVersion: "current-run", agentMode: true,
      ...(schedule.modelSelection.mode === "assignment" ? { modelAssignmentId: schedule.modelSelection.assignmentId } : {}),
    });
  }
  let resolved;
  try {
    resolved = resolveAppliedTaskModelAssignments({
      aiModelCatalog,
      employee,
      getProviderRoutes,
      taskDefinitionId: schedule.taskId,
      selectionMode: "task",
    });
  } catch {
    throw registryError("governed_schedule_task_model_assignment_changed");
  }
  const currentAssignments = resolved.items.filter((item) => item.assignmentId === schedule.taskModelBinding.assignmentId);
  if (currentAssignments.length !== 1 ||
    resolved.appliedVersion !== schedule.taskModelBinding.assignmentAppliedVersion ||
    resolved.assignmentDigest !== schedule.taskModelBinding.assignmentSetDigest) {
    throw registryError("governed_schedule_task_model_assignment_changed");
  }
  const current = currentAssignments[0];
  for (const field of [
    "modelId",
    "provider",
    "providerName",
    "model",
    "modelLevelId",
    "providerRouteId",
    "requiredCapabilityProfileVersion",
  ]) {
    if (String(current[field] || "") !== String(schedule.taskModelBinding[field] || "")) {
      throw registryError("governed_schedule_task_model_assignment_changed");
    }
  }
  const binding = normalizeTaskModelBinding({
    ...schedule.taskModelBinding,
    bindingDigest: taskBindingDigest({
      assignmentAppliedVersion: resolved.appliedVersion,
      assignmentId: current.assignmentId,
      assignmentSetDigest: resolved.assignmentDigest,
      model: current,
      modelLevelId: current.modelLevelId,
      taskId: schedule.taskId,
    }, getProviderRoutes),
  });
  if (binding.bindingDigest !== schedule.taskModelBinding.bindingDigest) {
    throw registryError("governed_schedule_task_model_binding_changed");
  }
  return binding;
}

function taskBindingDigest({ assignmentAppliedVersion, assignmentId, assignmentSetDigest, model, modelLevelId, taskId }, getProviderRoutes) {
  if (!model?.providerRouteId || !model?.requiredCapabilityProfileVersion) {
    throw registryError("governed_schedule_task_model_contract_incomplete");
  }
  const route = getProviderRoutes().find((item) => item.id === model.providerRouteId);
  if (!route || route.enabled === false || ["disabled", "retired", "planned"].includes(String(route.health || "").toLowerCase()) ||
    route.provider !== model.provider || route.capabilityProfileVersion !== model.requiredCapabilityProfileVersion ||
    !route.credentialId || !route.apiProtocol || !route.authMode || !route.upstreamDialect) {
    throw registryError("governed_schedule_provider_route_unavailable");
  }
  if (route.fallbackRouteId) throw registryError("governed_schedule_provider_fallback_forbidden");
  return digestCanonical({
    bindingContractVersion: TASK_MODEL_BINDING_CONTRACT_VERSION,
    ...(assignmentId ? {
      assignmentAppliedVersion,
      assignmentId,
      assignmentSetDigest,
    } : {}),
    model: model.model,
    modelId: model.id || model.modelId,
    modelLevelId,
    provider: model.provider,
    providerRoute: {
      apiProtocol: route.apiProtocol,
      authMode: route.authMode,
      capabilityProfileVersion: route.capabilityProfileVersion,
      credentialId: route.credentialId,
      enabled: route.enabled !== false,
      health: route.health,
      id: route.id,
      provider: route.provider,
      upstreamDialect: route.upstreamDialect,
    },
    requiredCapabilityProfileVersion: model.requiredCapabilityProfileVersion,
    taskId,
  });
}

function normalizeGovernedScheduleRegistration(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw registryError("governed_schedule_invalid");
  const fields = value.contractVersion === LEGACY_GOVERNED_SCHEDULE_REGISTRATION_CONTRACT_VERSION
    ? LEGACY_SCHEDULE_FIELDS
    : value.contractVersion === GOVERNED_SCHEDULE_REGISTRATION_CONTRACT_VERSION
      ? CURRENT_SCHEDULE_FIELDS
      : value.contractVersion === AGENT_GOVERNED_SCHEDULE_REGISTRATION_CONTRACT_VERSION ? AGENT_SCHEDULE_FIELDS : null;
  if (!fields) throw registryError("governed_schedule_contract_invalid");
  const unknown = Object.keys(value).find((field) => !fields.has(field));
  if (unknown) throw registryError("governed_schedule_unknown_field");
  const agentMode = value.contractVersion === AGENT_GOVERNED_SCHEDULE_REGISTRATION_CONTRACT_VERSION;
  const currentAuthority = value.contractVersion !== LEGACY_GOVERNED_SCHEDULE_REGISTRATION_CONTRACT_VERSION ? {
    employeeVersion: identifier(value.employeeVersion, "employeeVersion"),
    registrarSubjectDigest: requiredDigest(value.registrarSubjectDigest, "registrarSubjectDigest"),
    ...(agentMode ? { taskDefinitionVersion: declaredTaskDefinitionVersion(value.taskDefinitionVersion),
      ...(value.modelSelection !== undefined ? { modelSelection: normalizeAgentModelSelection(value.modelSelection) } : {}),
    } : {
      writebackContractDigest: requireNoWritebackContract(value.writebackContractDigest),
      acceptancePolicy: normalizeAcceptancePolicy(value.acceptancePolicy),
    }),
    updatedByIdentitySource: identifier(value.updatedByIdentitySource, "updatedByIdentitySource"),
  } : {};
  return deepFreeze({
    contractVersion: value.contractVersion,
    tenantScope: identifier(value.tenantScope, "tenantScope"),
    employeeId: identifier(value.employeeId, "employeeId"),
    ...currentAuthority,
    id: identifier(value.id, "scheduleId"),
    scheduleVersion: identifier(value.scheduleVersion, "scheduleVersion"),
    registrationVersion: boundedInteger(value.registrationVersion, 1, Number.MAX_SAFE_INTEGER, "registrationVersion"),
    title: safeText(value.title || value.id, 160),
    taskId: identifier(value.taskId, "taskId"),
    triggerMode: value.triggerMode === "cron" ? "cron" : invalidValue("governed_schedule_trigger_mode_invalid"),
    schedule: basicCron(value.schedule),
    timezone: canonicalTimezone(value.timezone),
    missedSlotPolicy: value.missedSlotPolicy === "latest_only" ? "latest_only" : invalidValue("governed_schedule_missed_slot_policy_invalid"),
    timeoutSeconds: requiredBoundedInteger(value.timeoutSeconds, 1, 86400, "timeoutSeconds"),
    maxConcurrentRuns: requiredBoundedInteger(value.maxConcurrentRuns, 1, 100, "maxConcurrentRuns"),
    overlapWindowMinutes: requiredBoundedInteger(value.overlapWindowMinutes, 0, 1440, "overlapWindowMinutes"),
    scheduleScope: enumValue(value.scheduleScope, ["department", "system"], "governed_schedule_scope_invalid"),
    ownerPrincipalType: enumValue(value.ownerPrincipalType, ["department", "digital_employee"], "governed_schedule_owner_type_invalid"),
    ownerPrincipalId: identifier(value.ownerPrincipalId, "ownerPrincipalId"),
    idempotencyKeyContract: safeText(value.idempotencyKeyContract, 500),
    resultContract: safeText(value.resultContract, 500),
    reviewGate: safeText(value.reviewGate, 500),
    enabled: value.enabled === true,
    reviewStatus: enumValue(value.reviewStatus, ["approved", "pending", "rejected"], "governed_schedule_review_status_invalid"),
    registrationStatus: enumValue(value.registrationStatus, ["applied", "retired"], "governed_schedule_registration_status_invalid"),
    status: enumValue(value.status, ["registered_blocked", "enabled", "disabled", "retired"], "governed_schedule_status_invalid"),
    executionMode: enumValue(value.executionMode, agentMode ? ["shared_agent_runtime"] : ["provider_dry_run_pending", "provider_dry_run"], "governed_schedule_execution_mode_invalid"),
    writebackMode: agentMode
      ? enumValue(value.writebackMode, ["governed_tools"], "governed_schedule_writeback_forbidden")
      : value.writebackMode === "none" ? "none" : invalidValue("governed_schedule_writeback_forbidden"),
    source: value.source === "governed_schedule_registry" ? value.source : invalidValue("governed_schedule_source_invalid"),
    lastRun: optionalTimestamp(value.lastRun, "lastRun"),
    nextRun: optionalTimestamp(value.nextRun, "nextRun"),
    remainingGates: safeTextList(value.remainingGates, 16, 80),
    taskModelBinding: normalizeTaskModelBinding(value.taskModelBinding),
    schedulePolicyDigest: requiredDigest(value.schedulePolicyDigest, "schedulePolicyDigest"),
    executionContractDigest: requiredDigest(value.executionContractDigest, "executionContractDigest"),
    updatedAt: requiredTimestamp(value.updatedAt, "updatedAt"),
    updatedBy: safeText(value.updatedBy, 120),
    updatedByDisplayName: safeText(value.updatedByDisplayName, 120),
  });
}

function normalizeTaskModelBinding(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw registryError("governed_schedule_task_model_binding_invalid");
  const unknown = Object.keys(value).find((field) => !BINDING_FIELDS.has(field));
  if (unknown) throw registryError("governed_schedule_task_model_binding_unknown_field");
  if (value.contractVersion !== TASK_MODEL_BINDING_CONTRACT_VERSION) throw registryError("governed_schedule_task_model_binding_contract_invalid");
  const hasAssignmentAuthority = Boolean(value.assignmentId || value.assignmentSetDigest || value.assignmentAppliedVersion !== undefined);
  const assignmentAuthority = hasAssignmentAuthority ? {
    assignmentId: identifier(value.assignmentId, "assignmentId"),
    assignmentAppliedVersion: boundedInteger(value.assignmentAppliedVersion, 0, Number.MAX_SAFE_INTEGER, "assignmentAppliedVersion"),
    assignmentSetDigest: requiredDigest(value.assignmentSetDigest, "assignmentSetDigest"),
  } : {};
  return deepFreeze({
    contractVersion: TASK_MODEL_BINDING_CONTRACT_VERSION,
    taskId: identifier(value.taskId, "taskId"),
    ...assignmentAuthority,
    bindingVersion: identifier(value.bindingVersion, "bindingVersion"),
    status: value.status === "applied" ? "applied" : invalidValue("governed_schedule_task_model_binding_not_applied"),
    modelId: identifier(value.modelId, "modelId"),
    provider: identifier(value.provider, "provider"),
    providerName: safeText(value.providerName, 120),
    model: safeText(value.model, 120),
    modelLevelId: identifier(value.modelLevelId, "modelLevelId"),
    providerRouteId: identifier(value.providerRouteId, "providerRouteId"),
    requiredCapabilityProfileVersion: identifier(value.requiredCapabilityProfileVersion, "requiredCapabilityProfileVersion"),
    bindingDigest: requiredDigest(value.bindingDigest, "bindingDigest"),
  });
}

function publicScheduleProjection(record) {
  const schedule = normalizeGovernedScheduleRegistration(record);
  const {
    acceptancePolicy: _acceptancePolicy,
    employeeVersion: _employeeVersion,
    executionContractDigest: _executionContractDigest,
    registrarSubjectDigest: _registrarSubjectDigest,
    schedulePolicyDigest: _schedulePolicyDigest,
    taskModelBinding,
    updatedBy: _updatedBy,
    updatedByDisplayName: _updatedByDisplayName,
    updatedByIdentitySource: _updatedByIdentitySource,
    writebackContractDigest: _writebackContractDigest,
    ...safeSchedule
  } = schedule;
  const { assignmentSetDigest: _assignmentSetDigest, bindingDigest: _bindingDigest, ...safeBinding } = taskModelBinding;
  return deepFreeze({ ...safeSchedule, taskModelBinding: safeBinding });
}

function publicTaskModelOption(binding) {
  const normalized = normalizeTaskModelBinding(binding);
  return deepFreeze({
    contractVersion: TASK_MODEL_BINDING_CONTRACT_VERSION,
    taskId: normalized.taskId,
    assignmentId: normalized.assignmentId,
    assignmentAppliedVersion: normalized.assignmentAppliedVersion,
    modelId: normalized.modelId,
    provider: normalized.provider,
    providerName: normalized.providerName,
    model: normalized.model,
    modelLevelId: normalized.modelLevelId,
    providerRouteId: normalized.providerRouteId,
    requiredCapabilityProfileVersion: normalized.requiredCapabilityProfileVersion,
  });
}

function normalizeAgentScheduleConfiguration(value) {
  const fields = ["title", "taskId", "taskDefinitionVersion", "schedule", "timezone", "timeoutSeconds", "maxConcurrentRuns", "overlapWindowMinutes"];
  if (!value || typeof value !== "object" || Array.isArray(value) ||
    !isDeepStrictEqual(Object.keys(value).sort(), [...fields].sort())) {
    throw registryError("governed_schedule_agent_configuration_invalid");
  }
  return {
    title: safeText(value.title, 160), taskId: identifier(value.taskId, "taskId"),
    taskDefinitionVersion: declaredTaskDefinitionVersion(value.taskDefinitionVersion),
    schedule: basicCron(value.schedule), timezone: canonicalTimezone(value.timezone),
    timeoutSeconds: requiredBoundedInteger(value.timeoutSeconds, 1, 86400, "timeoutSeconds"),
    maxConcurrentRuns: requiredBoundedInteger(value.maxConcurrentRuns, 1, 100, "maxConcurrentRuns"),
    overlapWindowMinutes: requiredBoundedInteger(value.overlapWindowMinutes, 0, 1440, "overlapWindowMinutes"),
    idempotencyKeyContract: "canonical schedule slot",
    resultContract: "task-local artifact summary",
    reviewGate: "current administrator and mounted capability authority",
  };
}

function scheduleDeclaration(employee, scheduleId) {
  const declarations = (Array.isArray(employee?.scheduleBindings) ? employee.scheduleBindings : [])
    .filter((item) => String(item?.id || item?.scheduleId || "").trim() === scheduleId);
  if (declarations.length !== 1) throw registryError("governed_schedule_declaration_not_found");
  return declarations[0];
}

function declaredTaskDefinitionVersion(value) {
  if (value === undefined || value === null || value === "") {
    throw registryError("governed_schedule_task_definition_version_required");
  }
  return boundedInteger(value, 1, Number.MAX_SAFE_INTEGER, "taskDefinitionVersion");
}

function normalizeActor(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw registryError("governed_schedule_actor_invalid");
  }
  return {
    principalId: identifier(value.principalId, "actorPrincipalId"),
    displayName: safeText(value.displayName, 120),
    identitySource: identifier(value.identitySource, "actorIdentitySource"),
  };
}

function registrarSubjectDigest({ actor, key, tenantScope }) {
  return crypto.createHmac("sha256", key).update(JSON.stringify({
    contractVersion: "schedule-registrar-subject.v1",
    tenantScope,
    identitySource: identifier(actor.identitySource, "actorIdentitySource"),
    principalId: identifier(actor.principalId, "actorPrincipalId"),
  })).digest("hex");
}

function normalizeAcceptancePolicy(value) {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
    !isDeepStrictEqual(Object.keys(value).sort(), [...ACCEPTANCE_POLICY_FIELDS].sort())) {
    throw registryError("governed_schedule_acceptance_policy_invalid");
  }
  const policy = {
    contractVersion: value.contractVersion === SCHEDULE_BUSINESS_OWNER_ACCEPTANCE_POLICY_CONTRACT_VERSION
      ? value.contractVersion
      : invalidValue("governed_schedule_acceptance_policy_invalid"),
    policyVersion: identifier(value.policyVersion, "acceptancePolicy.policyVersion"),
    maxValiditySeconds: boundedInteger(
      value.maxValiditySeconds,
      1,
      365 * 24 * 60 * 60,
      "acceptancePolicy.maxValiditySeconds",
    ),
    policyDigest: requiredDigest(value.policyDigest, "acceptancePolicy.policyDigest"),
  };
  if (policy.policyDigest !== acceptancePolicyDigest(policy)) {
    throw registryError("governed_schedule_acceptance_policy_invalid");
  }
  return deepFreeze(policy);
}

function acceptancePolicyDigest(value) {
  return digestCanonical({
    contractVersion: value.contractVersion,
    policyVersion: value.policyVersion,
    maxValiditySeconds: value.maxValiditySeconds,
  });
}

function requireNoWritebackContract(value) {
  const digest = requiredDigest(value, "writebackContractDigest");
  if (digest !== SCHEDULE_WRITEBACK_CONTRACT_DIGEST) {
    throw registryError("governed_schedule_writeback_contract_invalid");
  }
  return digest;
}

function requiredHmacKey(value) {
  if (!Buffer.isBuffer(value) || value.length !== 32) {
    throw new TypeError("governed schedule registry requires a 32-byte registrarSubjectHmacKey");
  }
  return Buffer.from(value);
}

function scheduleOwnership({ employee, scheduleScope }) {
  if (scheduleScope === "department") {
    return {
      scheduleScope: "department",
      ownerPrincipalType: "department",
      ownerPrincipalId: identifier(employee.ownerDepartmentId || employee.departmentId, "ownerDepartmentId"),
    };
  }
  if (scheduleScope === "system") {
    return {
      scheduleScope: "system",
      ownerPrincipalType: "digital_employee",
      ownerPrincipalId: identifier(employee.id, "employeeId"),
    };
  }
  throw registryError("governed_schedule_scope_invalid");
}

function defaultValidateDispatchEmployee(employee = {}) {
  return ["在线", "试运行"].includes(String(employee.status || "").trim());
}

function requireDispatchableEmployee(validateEmployee, employee) {
  if (!employee.version) throw registryError("governed_schedule_employee_not_runnable");
  let runnable;
  try {
    runnable = validateEmployee(employee);
  } catch {
    throw registryError("governed_schedule_employee_state_unavailable");
  }
  if (runnable !== true) throw registryError("governed_schedule_employee_not_runnable");
}

function basicCron(value) {
  const cronExpression = safeText(value, 120);
  try {
    calculateLatestDueTime({
      cronExpression,
      timezone: "UTC",
      afterExclusive: "2026-01-01T00:00:00.000Z",
      throughInclusive: "2026-01-01T00:00:00.000Z",
    });
  } catch {
    throw registryError("governed_schedule_cron_invalid");
  }
  return cronExpression;
}

function canonicalTimezone(value) {
  const timezone = safeText(value, 120);
  try {
    return new Intl.DateTimeFormat("en-US", { timeZone: timezone }).resolvedOptions().timeZone;
  } catch {
    throw registryError("governed_schedule_timezone_invalid");
  }
}

function identifier(value, field) {
  const result = String(value || "").trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,159}$/.test(result)) throw registryError("governed_schedule_reference_invalid", field);
  return result;
}

function safeText(value, limit) {
  const result = String(value || "").replace(/[\u0000-\u001f\u007f]/g, " ").trim();
  if (result.length > limit || SECRET_PATTERN.test(result)) throw registryError("governed_schedule_sensitive_text_forbidden");
  return result;
}

function safeTextList(value, limit, itemLimit) {
  if (!Array.isArray(value)) throw registryError("governed_schedule_list_invalid");
  return [...new Set(value.map((item) => safeText(item, itemLimit)).filter(Boolean))].slice(0, limit);
}

function boundedInteger(value, minimum, maximum, field) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < minimum || number > maximum) {
    throw registryError("governed_schedule_number_invalid", field);
  }
  return number;
}

function requiredBoundedInteger(value, minimum, maximum, field) {
  if (value === undefined || value === null || value === "") throw registryError("governed_schedule_number_required", field);
  return boundedInteger(value, minimum, maximum, field);
}

function enumValue(value, allowed, code) {
  if (!allowed.includes(value)) return invalidValue(code);
  return value;
}

function invalidValue(code) {
  throw registryError(code);
}

function optionalTimestamp(value, field) {
  return value ? requiredTimestamp(value, field) : "";
}

function requiredTimestamp(value, field) {
  const timestamp = new Date(value);
  if (!value || !Number.isFinite(timestamp.getTime())) throw registryError("governed_schedule_timestamp_invalid", field);
  return timestamp.toISOString();
}

function requiredDigest(value, field) {
  const result = String(value || "").trim().toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(result)) throw registryError("governed_schedule_digest_invalid", field);
  return result;
}

function digestCanonical(value) {
  return crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function registryError(code, message = code) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function deepFreeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

export {
  DEFAULT_SCHEDULE_BUSINESS_OWNER_ACCEPTANCE_POLICY,
  GOVERNED_SCHEDULE_REGISTRATION_CONTRACT_VERSION,
  LEGACY_GOVERNED_SCHEDULE_REGISTRATION_CONTRACT_VERSION,
  SCHEDULE_REGISTRATION_CONTEXT_CONTRACT_VERSION,
  SCHEDULE_BUSINESS_OWNER_CURRENT_BINDING_CONTRACT_VERSION,
  SCHEDULE_WRITEBACK_CONTRACT_DIGEST,
  TASK_MODEL_BINDING_CONTRACT_VERSION,
  createGovernedScheduleRegistry,
  normalizeGovernedScheduleRegistration,
  normalizeTaskModelBinding,
  resolveCurrentTaskAssignment,
  resolveExactTaskModelBinding,
};
