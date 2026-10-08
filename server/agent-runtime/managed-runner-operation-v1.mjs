import crypto from "node:crypto";
import { runtimeSafeActivityDisplayName } from "./runtime-safe-activity-contract-v1.mjs";

const MANAGED_RUNNER_OPERATION_CONTRACT_VERSION = "managed-runner-operation.v1";
const MANAGED_RUNNER_SAFE_PROJECTION_CONTRACT_VERSION = "managed-runner-safe-projection.v1";
const MANAGED_RUNNER_TASK_CAPABILITY_GRANT_CONTRACT_VERSION = "managed-runner-task-capability-grant.v1";
const MANAGED_RUNNER_TOOL_ID = "managed-runner-v1";
const MANAGED_RUNNER_ACTION_CODE = "runner.execute";
const MANAGED_RUNNER_SUBJECT_ID = "managed-runner";
const CURRENT_TASK_WORKSPACE_SCOPE = "current_task_workspace";
const SAFE_TOKEN = /^[A-Za-z0-9][A-Za-z0-9._:@_-]*$/;
const SAFE_ACTION_ID = /^[a-z][a-z0-9._-]{0,79}$/;
const FORBIDDEN_ACTION_SEGMENT = /(?:^|[._-])(argv|command|cwd|env|exec|path|shell)(?:$|[._-])/;
const TASK_CAPABILITY_GRANT_POLICY = "task_capability_grant";
const MAX_CAPABILITY_GRANT_TTL_MS = 60 * 60 * 1000;
const MAX_CAPABILITY_GRANT_OPERATIONS = 50;

function createManagedRunnerOperationBoundary({ registrations = [], capabilityGrantService = null } = {}) {
  const registrationsByActionId = new Map();
  for (const registration of registrations) {
    const normalized = normalizeManagedRunnerRegistration(registration);
    if (registrationsByActionId.has(normalized.actionId)) {
      throw runnerError("managed_runner_action_duplicate");
    }
    registrationsByActionId.set(normalized.actionId, normalized);
  }

  function authorizeOperation({ operation = null, runtimeTask = null, taskOwnership = null, toolAuthorization = null } = {}) {
    let normalizedOperation;
    try {
      normalizedOperation = normalizeManagedRunnerOperation(operation);
    } catch {
      return blocked("managed_runner_operation_invalid");
    }
    let currentTaskId;
    try {
      currentTaskId = runtimeTaskId(runtimeTask);
    } catch {
      return blocked("managed_runner_task_identity_conflict");
    }
    if (currentTaskId !== normalizedOperation.taskId) {
      return blocked("managed_runner_task_identity_conflict");
    }
    const registration = registrationsByActionId.get(normalizedOperation.actionId);
    if (!registration) return blocked("managed_runner_action_not_registered");
    if (normalizedOperation.scope !== registration.scope) {
      return blocked("managed_runner_scope_not_authorized");
    }
    if (!capabilityGrantService?.admitOperation) {
      if (!isAuthorizedManagedRunnerTool(toolAuthorization, registration)) return blocked("managed_runner_tool_not_authorized");
      return authorized(registration);
    }
    const grantDecision = capabilityGrantService.admitOperation({
      actionId: registration.actionId,
      capabilityGrantId: normalizedOperation.capabilityGrantId,
      operationId: normalizedOperation.operationId,
      registration,
      runtimeTask,
      taskOwnership,
    });
    if (grantDecision.status !== "authorized") return blocked(grantDecision.reason);
    return authorized(registration);
  }

  function authorized(registration) {
    return Object.freeze({
      contractVersion: MANAGED_RUNNER_OPERATION_CONTRACT_VERSION,
      status: "authorized",
      actionId: registration.actionId,
      safeActivityDescriptor: safeActivityDescriptor(),
    });
  }

  return Object.freeze({ authorizeOperation });
}

function createManagedRunnerTaskCapabilityGrantService({ registrations = [], now = () => Date.now() } = {}) {
  return createTaskCapabilityGrantService({
    contractVersion: MANAGED_RUNNER_TASK_CAPABILITY_GRANT_CONTRACT_VERSION,
    isAuthorizedTool: isAuthorizedManagedRunnerTool,
    now,
    normalizeRegistration: normalizeManagedRunnerRegistration,
    registrations,
  });
}

function createTaskCapabilityGrantService({
  contractVersion = "",
  isAuthorizedTool = null,
  now = () => Date.now(),
  normalizeRegistration = null,
  registrations = [],
} = {}) {
  if (typeof isAuthorizedTool !== "function" || typeof normalizeRegistration !== "function" ||
    !SAFE_TOKEN.test(String(contractVersion || ""))) {
    throw runnerError("task_capability_grant_service_invalid");
  }
  const registrationsByActionId = new Map();
  const grantsById = new Map();
  for (const registration of registrations) {
    const normalized = normalizeRegistration(registration);
    if (registrationsByActionId.has(normalized.actionId)) throw runnerError("managed_runner_action_duplicate");
    registrationsByActionId.set(normalized.actionId, normalized);
  }

  function issueGrant({ actionIds = [], runtimeTask = null, taskOwnership = null, toolAuthorization = null, ttlMs = 0, maxOperations = 0 } = {}) {
    const task = normalizeGrantTask(runtimeTask, taskOwnership);
    const requestedActionIds = normalizeGrantActionIds(actionIds, registrationsByActionId, registeredActionId);
    const registrationsForGrant = requestedActionIds.map((actionId) => registrationsByActionId.get(actionId));
    if (!task || !registrationsForGrant.length || registrationsForGrant.some((registration) =>
      registration.confirmationPolicy !== TASK_CAPABILITY_GRANT_POLICY || !isAuthorizedTool(toolAuthorization, registration))) {
      throw runnerError("managed_runner_capability_grant_not_authorized");
    }
    const issuedAtMs = normalizedNow(now);
    const durationMs = boundedGrantValue(ttlMs, 30_000, MAX_CAPABILITY_GRANT_TTL_MS, "managed_runner_capability_grant_ttl_invalid");
    const allowedOperations = boundedGrantValue(maxOperations, 1, MAX_CAPABILITY_GRANT_OPERATIONS, "managed_runner_capability_grant_limit_invalid");
    const grant = Object.freeze({
      actionIds: Object.freeze(requestedActionIds),
      allowedOperations,
      expiresAtMs: issuedAtMs + durationMs,
      grantId: `grant_${crypto.randomUUID()}`,
      issuedAtMs,
      task,
      usesByOperationId: new Map(),
    });
    grantsById.set(grant.grantId, grant);
    return Object.freeze({
      contractVersion,
      expiresAt: new Date(grant.expiresAtMs).toISOString(),
      grantId: grant.grantId,
    });
  }

  function admitOperation({ actionId = "", capabilityGrantId = "", operationId = "", registration = null, runtimeTask = null, taskOwnership = null } = {}) {
    let task;
    try {
      task = normalizeGrantTask(runtimeTask, taskOwnership);
    } catch {
      return { status: "blocked", reason: "managed_runner_capability_grant_invalid" };
    }
    const grant = grantsById.get(capabilityGrantId);
    const registered = registrationsByActionId.get(actionId);
    if (!grant || !task || !registered || grant.expiresAtMs <= normalizedNow(now)) {
      return { status: "blocked", reason: "managed_runner_capability_grant_invalid" };
    }
    if (!sameGrantTask(grant.task, task) || !grant.actionIds.includes(actionId) ||
      registered.confirmationPolicy !== TASK_CAPABILITY_GRANT_POLICY ||
      (registration && registration.actionId !== registered.actionId)) {
      return { status: "blocked", reason: "managed_runner_capability_grant_not_authorized" };
    }
    const existingActionId = grant.usesByOperationId.get(operationId);
    if (existingActionId && existingActionId !== actionId) {
      return { status: "blocked", reason: "managed_runner_operation_identity_conflict" };
    }
    if (!existingActionId && grant.usesByOperationId.size >= grant.allowedOperations) {
      return { status: "blocked", reason: "managed_runner_capability_grant_exhausted" };
    }
    if (!existingActionId) grant.usesByOperationId.set(operationId, actionId);
    return { status: "authorized" };
  }

  function revokeGrant({ grantId = "", runtimeTask = null, taskOwnership = null } = {}) {
    const grant = grantsById.get(grantId);
    let task;
    try {
      task = normalizeGrantTask(runtimeTask, taskOwnership);
    } catch {
      return false;
    }
    if (!grant || !task || !sameGrantTask(grant.task, task)) return false;
    grantsById.delete(grantId);
    return true;
  }

  return Object.freeze({ admitOperation, issueGrant, revokeGrant });
}

function createManagedRunnerOperationAdapter({ boundary = null, location = "" } = {}) {
  if (!boundary || typeof boundary.authorizeOperation !== "function" || !["center", "device"].includes(location)) {
    throw runnerError("managed_runner_adapter_invalid");
  }
  return Object.freeze({
    authorizeOperation: (input = {}) => boundary.authorizeOperation(input),
  });
}

function normalizeManagedRunnerOperation(value = null) {
  const fields = Object.keys(value || {}).sort();
  const legacy = ["actionId", "contractVersion", "scope", "taskId"];
  const granted = ["actionId", "capabilityGrantId", "contractVersion", "operationId", "scope", "taskId"];
  if (JSON.stringify(fields) !== JSON.stringify(legacy) && JSON.stringify(fields) !== JSON.stringify(granted)) {
    throw runnerError("managed_runner_contract_shape_invalid");
  }
  if (value.contractVersion !== MANAGED_RUNNER_OPERATION_CONTRACT_VERSION) {
    throw runnerError("managed_runner_operation_contract_invalid");
  }
  const normalizedActionId = managedActionId(value.actionId);
  const taskId = token(value.taskId, 128);
  const scope = token(value.scope, 80);
  if (scope !== CURRENT_TASK_WORKSPACE_SCOPE) throw runnerError("managed_runner_operation_scope_invalid");
  return Object.freeze({
    contractVersion: MANAGED_RUNNER_OPERATION_CONTRACT_VERSION,
    actionId: normalizedActionId,
    capabilityGrantId: token(value.capabilityGrantId, 160, { required: false }),
    taskId,
    operationId: token(value.operationId, 160, { required: false }),
    scope,
  });
}

function normalizeManagedRunnerRegistration(value = null) {
  const fields = Object.keys(value || {}).sort();
  const legacy = ["actionId", "risk", "scope", "toolId", "writebackBoundary"];
  const granted = ["actionId", "confirmationPolicy", "risk", "scope", "toolId", "writebackBoundary"];
  if (JSON.stringify(fields) !== JSON.stringify(legacy) && JSON.stringify(fields) !== JSON.stringify(granted)) {
    throw runnerError("managed_runner_contract_shape_invalid");
  }
  const normalized = {
    actionId: managedActionId(value.actionId),
    confirmationPolicy: token(value.confirmationPolicy || "explicit_per_call", 80),
    toolId: token(value.toolId, 120),
    risk: token(value.risk, 40),
    scope: token(value.scope, 80),
    writebackBoundary: token(value.writebackBoundary, 80),
  };
  if (normalized.toolId !== MANAGED_RUNNER_TOOL_ID || !["high", "read_only"].includes(normalized.risk) ||
    !["explicit_per_call", TASK_CAPABILITY_GRANT_POLICY].includes(normalized.confirmationPolicy) || normalized.scope !== CURRENT_TASK_WORKSPACE_SCOPE ||
    normalized.writebackBoundary !== "none") {
    throw runnerError("managed_runner_registration_invalid");
  }
  return Object.freeze(normalized);
}

function isAuthorizedManagedRunnerTool(value = null, registration = null) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const contract = value.toolContract;
  if (value.status !== "allowed" || !contract || typeof contract !== "object" || Array.isArray(contract) ||
    Object.keys(value).some((field) => !new Set(["status", "toolContract"]).has(field))) return false;
  const fields = new Set(["action", "capabilities", "confirmationPolicy", "contractVersion", "policyAction", "risk", "scope", "toolId", "writebackBoundary"]);
  if (Object.keys(contract).length !== fields.size || Object.keys(contract).some((field) => !fields.has(field)) ||
    [...fields].some((field) => !Object.hasOwn(contract, field))) return false;
  return contract.contractVersion === MANAGED_RUNNER_OPERATION_CONTRACT_VERSION &&
    contract.toolId === registration.toolId &&
    contract.action === "run" &&
    contract.policyAction === "draft" &&
    contract.risk === registration.risk &&
    contract.confirmationPolicy === registration.confirmationPolicy &&
    contract.writebackBoundary === registration.writebackBoundary &&
    Array.isArray(contract.scope) && contract.scope.length === 1 && contract.scope[0] === registration.scope &&
    Array.isArray(contract.capabilities) && contract.capabilities.length === 1 && contract.capabilities[0] === "managed_runner.execute";
}

function normalizeGrantTask(runtimeTask = null, taskOwnership = null) {
  const taskId = runtimeTaskId(runtimeTask);
  const employeeId = token(runtimeTask?.employeeId, 160, { required: false });
  const actorSubjectDigest = String(runtimeTask?.actorSubjectDigest || "").trim().toLowerCase();
  const workspaceRef = token(runtimeTask?.workspaceRef, 160, { required: false });
  const lease = taskOwnership?.lease;
  if (!taskId || !employeeId || !/^[a-f0-9]{64}$/.test(actorSubjectDigest) || workspaceRef !== `task:${taskId}` ||
    !token(lease?.leaseId, 160, { required: false }) || !token(lease?.workerIdDigest, 160, { required: false }) ||
    !Number.isSafeInteger(lease?.fencingToken) || lease.fencingToken <= 0 || runtimeTaskId(taskOwnership?.task) !== taskId) return null;
  return Object.freeze({
    actorSubjectDigest,
    employeeId,
    fencingToken: lease.fencingToken,
    leaseId: lease.leaseId,
    taskId,
    workerIdDigest: lease.workerIdDigest,
    workspaceRef,
  });
}

function normalizeGrantActionIds(value, registrationsByActionId, normalizeActionId = managedActionId) {
  if (!Array.isArray(value) || !value.length || value.length > 20) throw runnerError("managed_runner_capability_grant_actions_invalid");
  const actionIds = [...new Set(value.map(normalizeActionId))].sort();
  if (actionIds.length !== value.length || actionIds.some((actionId) => !registrationsByActionId.has(actionId))) {
    throw runnerError("managed_runner_capability_grant_actions_invalid");
  }
  return actionIds;
}

function registeredActionId(value) {
  const normalized = String(value || "").trim();
  if (!SAFE_ACTION_ID.test(normalized)) throw runnerError("managed_runner_capability_grant_actions_invalid");
  return normalized;
}

function sameGrantTask(left, right) {
  return left.taskId === right.taskId && left.employeeId === right.employeeId &&
    left.actorSubjectDigest === right.actorSubjectDigest && left.workspaceRef === right.workspaceRef &&
    left.leaseId === right.leaseId && left.workerIdDigest === right.workerIdDigest && left.fencingToken === right.fencingToken;
}

function normalizedNow(now) {
  const value = Number(now());
  if (!Number.isSafeInteger(value) || value <= 0) throw runnerError("managed_runner_capability_grant_clock_invalid");
  return value;
}

function boundedGrantValue(value, min, max, code) {
  const normalized = Number(value);
  if (!Number.isSafeInteger(normalized) || normalized < min || normalized > max) throw runnerError(code);
  return normalized;
}

function safeManagedRunnerProjection(decision = null) {
  if (!decision || decision.status !== "authorized" || decision.contractVersion !== MANAGED_RUNNER_OPERATION_CONTRACT_VERSION ||
    decision.actionId === undefined || !safeActivityDescriptorMatches(decision.safeActivityDescriptor) ||
    Object.keys(decision).length !== 4 || Object.keys(decision).some((field) =>
      !new Set(["actionId", "contractVersion", "safeActivityDescriptor", "status"]).has(field))) return null;
  return Object.freeze({
    contractVersion: MANAGED_RUNNER_SAFE_PROJECTION_CONTRACT_VERSION,
    status: "authorized",
    actionCode: MANAGED_RUNNER_ACTION_CODE,
    displayName: runtimeSafeActivityDisplayName(MANAGED_RUNNER_ACTION_CODE),
    kind: "tool",
    subjectId: MANAGED_RUNNER_SUBJECT_ID,
  });
}

function safeActivityDescriptor() {
  return Object.freeze({
    actionCode: MANAGED_RUNNER_ACTION_CODE,
    kind: "tool",
    subjectId: MANAGED_RUNNER_SUBJECT_ID,
  });
}

function safeActivityDescriptorMatches(value = null) {
  return value && typeof value === "object" && !Array.isArray(value) &&
    Object.keys(value).length === 3 && value.actionCode === MANAGED_RUNNER_ACTION_CODE &&
    value.kind === "tool" && value.subjectId === MANAGED_RUNNER_SUBJECT_ID;
}

function blocked(reason) {
  return Object.freeze({
    contractVersion: MANAGED_RUNNER_OPERATION_CONTRACT_VERSION,
    status: "blocked",
    reason,
  });
}

function runtimeTaskId(value = null) {
  return token(value?.taskId || value?.id, 128, { required: false });
}

function exactObject(value, fields) {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).length !== fields.size ||
    Object.keys(value).some((field) => !fields.has(field)) || [...fields].some((field) => !Object.hasOwn(value, field))) {
    throw runnerError("managed_runner_contract_shape_invalid");
  }
}

function managedActionId(value) {
  const normalized = String(value || "").trim();
  if (!SAFE_ACTION_ID.test(normalized) || FORBIDDEN_ACTION_SEGMENT.test(normalized)) {
    throw runnerError("managed_runner_action_id_invalid");
  }
  return normalized;
}

function token(value, maxLength, { required = true } = {}) {
  const normalized = String(value || "").trim();
  if ((!normalized && !required) || (normalized && normalized.length <= maxLength && SAFE_TOKEN.test(normalized))) {
    return normalized;
  }
  throw runnerError("managed_runner_token_invalid");
}

function runnerError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

export {
  CURRENT_TASK_WORKSPACE_SCOPE,
  MANAGED_RUNNER_ACTION_CODE,
  MANAGED_RUNNER_OPERATION_CONTRACT_VERSION,
  MANAGED_RUNNER_SAFE_PROJECTION_CONTRACT_VERSION,
  MANAGED_RUNNER_SUBJECT_ID,
  MANAGED_RUNNER_TASK_CAPABILITY_GRANT_CONTRACT_VERSION,
  MANAGED_RUNNER_TOOL_ID,
  createTaskCapabilityGrantService,
  createManagedRunnerOperationAdapter,
  createManagedRunnerOperationBoundary,
  createManagedRunnerTaskCapabilityGrantService,
  normalizeManagedRunnerOperation,
  safeManagedRunnerProjection,
};
