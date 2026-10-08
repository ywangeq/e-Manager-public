import crypto from "node:crypto";
import { createTaskCapabilityGrantService } from "./managed-runner-operation-v1.mjs";
import { runtimeSafeActivityDisplayName } from "./runtime-safe-activity-contract-v1.mjs";
import {
  CURRENT_TASK_WORKSPACE_SCOPE,
  MANAGED_SANDBOX_EXECUTION_ACTION_ID,
  isManagedSandboxProfile,
  managedSandboxProfileRegistry,
} from "./managed-sandbox-profile-registry-v1.mjs";

const MANAGED_SANDBOX_EXECUTION_CONTRACT_VERSION = "managed-sandbox-execution.v1";
const MANAGED_SANDBOX_EPHEMERAL_EXECUTION_INPUT_CONTRACT_VERSION = "managed-sandbox-ephemeral-execution-input.v1";
const MANAGED_SANDBOX_SAFE_PROJECTION_CONTRACT_VERSION = "managed-sandbox-safe-projection.v1";
const MANAGED_SANDBOX_TASK_CAPABILITY_GRANT_CONTRACT_VERSION = "managed-sandbox-task-capability-grant.v1";
const MANAGED_SANDBOX_TOOL_AUTHORIZATION_CONTRACT_VERSION = "managed-sandbox-tool-authorization.v1";
const MANAGED_SANDBOX_TOOL_ID = "managed-sandbox-exec";
const MANAGED_SANDBOX_ACTION_CODE = "runner.execute";
const MANAGED_SANDBOX_SUBJECT_ID = "managed-runner";
const SAFE_TOKEN = /^[A-Za-z0-9][A-Za-z0-9._:@_-]*$/;
const SAFE_PROFILE_ID = /^[a-z][a-z0-9_]{0,79}$/;
const TASK_CAPABILITY_GRANT_POLICY = "task_capability_grant";

function createManagedSandboxTaskCapabilityGrantService({ now = () => Date.now() } = {}) {
  const grantService = createTaskCapabilityGrantService({
    contractVersion: MANAGED_SANDBOX_TASK_CAPABILITY_GRANT_CONTRACT_VERSION,
    isAuthorizedTool: isAuthorizedManagedSandboxTool,
    now,
    normalizeRegistration: normalizeSandboxRegistration,
    registrations: [sandboxRegistration()],
  });

  function issueGrant(input = {}) {
    exactObject(input, new Set(["maxOperations", "runtimeTask", "taskOwnership", "toolAuthorization", "ttlMs"]));
    const { maxOperations = 0, runtimeTask = null, taskOwnership = null, toolAuthorization = null, ttlMs = 0 } = input;
    return grantService.issueGrant({
      actionIds: [MANAGED_SANDBOX_EXECUTION_ACTION_ID],
      maxOperations,
      runtimeTask,
      taskOwnership,
      toolAuthorization,
      ttlMs,
    });
  }

  function admitSandboxExecution(input = {}) {
    exactObject(input, new Set(["capabilityGrantId", "operationId", "runtimeTask", "taskOwnership"]));
    const { capabilityGrantId = "", operationId = "", runtimeTask = null, taskOwnership = null } = input;
    return grantService.admitOperation({
      actionId: MANAGED_SANDBOX_EXECUTION_ACTION_ID,
      capabilityGrantId,
      operationId,
      runtimeTask,
      taskOwnership,
    });
  }

  return Object.freeze({
    admitSandboxExecution,
    issueGrant,
    revokeGrant: ({ grantId = "", runtimeTask = null, taskOwnership = null } = {}) =>
      grantService.revokeGrant({ grantId, runtimeTask, taskOwnership }),
  });
}

function createManagedSandboxExecutionBoundary({
  capabilityGrantVerifier = null,
  executionInputResolver = null,
  profiles = managedSandboxProfileRegistry(),
} = {}) {
  const profilesById = profileMap(profiles);

  function authorizeOperation({ operation = null, runtimeTask = null, taskOwnership = null } = {}) {
    let normalizedOperation;
    try {
      normalizedOperation = normalizeOperation(operation);
    } catch {
      return blocked("managed_sandbox_execution_operation_invalid");
    }
    if (runtimeTaskId(runtimeTask) !== normalizedOperation.taskId) {
      return blocked("managed_sandbox_execution_task_identity_conflict");
    }
    const profile = profilesById.get(normalizedOperation.profileId);
    if (!profile || profile.profileRevision !== normalizedOperation.profileRevision || profile.scope !== normalizedOperation.scope) {
      return blocked("managed_sandbox_execution_profile_not_registered");
    }
    let hasExecutionInput = false;
    try {
      hasExecutionInput = Boolean(executionInputResolver?.assertReference?.({
        commandEnvelopeRef: normalizedOperation.commandEnvelopeRef,
        profileId: profile.profileId,
        profileRevision: profile.profileRevision,
        runtimeTask,
      }));
    } catch {}
    if (!hasExecutionInput) {
      return blocked("managed_sandbox_ephemeral_execution_input_invalid");
    }
    if (!capabilityGrantVerifier?.admitSandboxExecution) {
      return blocked("managed_sandbox_capability_grant_unavailable");
    }
    let grantDecision;
    try {
      grantDecision = capabilityGrantVerifier.admitSandboxExecution({
        capabilityGrantId: normalizedOperation.capabilityGrantId,
        operationId: normalizedOperation.operationId,
        runtimeTask,
        taskOwnership,
      });
    } catch {
      return blocked("managed_sandbox_capability_grant_not_authorized");
    }
    if (grantDecision?.status !== "authorized") {
      return blocked("managed_sandbox_capability_grant_not_authorized");
    }
    return Object.freeze({
      actionId: MANAGED_SANDBOX_EXECUTION_ACTION_ID,
      contractVersion: MANAGED_SANDBOX_EXECUTION_CONTRACT_VERSION,
      safeActivityDescriptor: safeActivityDescriptor(),
      status: "authorized",
    });
  }

  return Object.freeze({ authorizeOperation });
}

function createManagedSandboxEphemeralExecutionInputStore({ profiles = managedSandboxProfileRegistry() } = {}) {
  const profilesById = profileMap(profiles);
  const inputsByRef = new Map();

  function stage(input = {}) {
    exactObject(input, new Set(["command", "profileId", "profileRevision", "runtimeTask"]));
    const { command, profileId, profileRevision, runtimeTask } = input;
    const profile = profilesById.get(normalizeProfileId(profileId));
    const taskId = runtimeTaskId(runtimeTask);
    if (!profile || profile.profileRevision !== token(profileRevision, 40) || !taskId) {
      throw sandboxError("managed_sandbox_ephemeral_execution_input_invalid");
    }
    const executionInput = normalizeExecutionInput(command);
    const commandEnvelopeRef = `sandbox_input_${crypto.randomUUID().replace(/-/g, "")}`;
    inputsByRef.set(commandEnvelopeRef, Object.freeze({
      command: executionInput,
      profileId: profile.profileId,
      profileRevision: profile.profileRevision,
      taskId,
    }));
    return Object.freeze({
      commandEnvelopeRef,
      contractVersion: MANAGED_SANDBOX_EPHEMERAL_EXECUTION_INPUT_CONTRACT_VERSION,
    });
  }

  function assertReference(input = {}) {
    exactObject(input, new Set(["commandEnvelopeRef", "profileId", "profileRevision", "runtimeTask"]));
    const { commandEnvelopeRef, profileId, profileRevision, runtimeTask } = input;
    const executionInput = inputsByRef.get(token(commandEnvelopeRef, 160, { required: false }));
    return Boolean(executionInput && executionInput.taskId === runtimeTaskId(runtimeTask) &&
      executionInput.profileId === normalizeProfileId(profileId) && executionInput.profileRevision === token(profileRevision, 40));
  }

  function takeForExecution(input = {}) {
    exactObject(input, new Set(["commandEnvelopeRef", "profileId", "profileRevision", "runtimeTask"]));
    const { commandEnvelopeRef, profileId, profileRevision, runtimeTask } = input;
    if (!assertReference({ commandEnvelopeRef, profileId, profileRevision, runtimeTask })) {
      throw sandboxError("managed_sandbox_ephemeral_execution_input_invalid");
    }
    const executionInput = inputsByRef.get(commandEnvelopeRef);
    inputsByRef.delete(commandEnvelopeRef);
    return executionInput.command;
  }

  function discard(input = {}) {
    exactObject(input, new Set(["commandEnvelopeRef", "profileId", "profileRevision", "runtimeTask"]));
    const { commandEnvelopeRef, profileId, profileRevision, runtimeTask } = input;
    if (!assertReference({ commandEnvelopeRef, profileId, profileRevision, runtimeTask })) return false;
    inputsByRef.delete(commandEnvelopeRef);
    return true;
  }

  return Object.freeze({ assertReference, discard, stage, takeForExecution });
}

function createManagedSandboxExecutionAdapter({ boundary = null, location = "" } = {}) {
  if (!boundary || typeof boundary.authorizeOperation !== "function" || !["center", "device"].includes(location)) {
    throw sandboxError("managed_sandbox_execution_adapter_invalid");
  }
  return Object.freeze({ authorizeOperation: (input = {}) => boundary.authorizeOperation(input) });
}

function managedSandboxToolAuthorizationContract() {
  return Object.freeze({
    action: "run",
    capabilities: Object.freeze([MANAGED_SANDBOX_EXECUTION_ACTION_ID]),
    confirmationPolicy: TASK_CAPABILITY_GRANT_POLICY,
    contractVersion: MANAGED_SANDBOX_TOOL_AUTHORIZATION_CONTRACT_VERSION,
    policyAction: "draft",
    risk: "controlled_execution",
    scope: Object.freeze([CURRENT_TASK_WORKSPACE_SCOPE]),
    toolId: MANAGED_SANDBOX_TOOL_ID,
    writebackBoundary: "none",
  });
}

function safeManagedSandboxExecutionProjection(decision = null) {
  if (!decision || decision.status !== "authorized" || decision.contractVersion !== MANAGED_SANDBOX_EXECUTION_CONTRACT_VERSION ||
    decision.actionId !== MANAGED_SANDBOX_EXECUTION_ACTION_ID || !safeActivityDescriptorMatches(decision.safeActivityDescriptor) ||
    Object.keys(decision).length !== 4) return null;
  return Object.freeze({
    actionCode: MANAGED_SANDBOX_ACTION_CODE,
    contractVersion: MANAGED_SANDBOX_SAFE_PROJECTION_CONTRACT_VERSION,
    displayName: runtimeSafeActivityDisplayName(MANAGED_SANDBOX_ACTION_CODE),
    kind: "tool",
    status: "authorized",
    subjectId: MANAGED_SANDBOX_SUBJECT_ID,
  });
}

function normalizeOperation(value = null) {
  exactObject(value, new Set(["actionId", "capabilityGrantId", "commandEnvelopeRef", "contractVersion", "operationId", "profileId", "profileRevision", "scope", "taskId"]));
  if (value.contractVersion !== MANAGED_SANDBOX_EXECUTION_CONTRACT_VERSION || value.actionId !== MANAGED_SANDBOX_EXECUTION_ACTION_ID) {
    throw sandboxError("managed_sandbox_execution_operation_invalid");
  }
  const scope = token(value.scope, 80);
  if (scope !== CURRENT_TASK_WORKSPACE_SCOPE) throw sandboxError("managed_sandbox_execution_operation_invalid");
  return Object.freeze({
    actionId: MANAGED_SANDBOX_EXECUTION_ACTION_ID,
    capabilityGrantId: token(value.capabilityGrantId, 160),
    commandEnvelopeRef: token(value.commandEnvelopeRef, 160),
    contractVersion: MANAGED_SANDBOX_EXECUTION_CONTRACT_VERSION,
    operationId: token(value.operationId, 160),
    profileId: normalizeProfileId(value.profileId),
    profileRevision: token(value.profileRevision, 40),
    scope,
    taskId: token(value.taskId, 128),
  });
}

function profileMap(profiles) {
  if (!Array.isArray(profiles) || !profiles.length) throw sandboxError("managed_sandbox_execution_profile_registry_invalid");
  const profilesById = new Map();
  for (const profile of profiles) {
    const normalized = normalizeProfile(profile);
    if (profilesById.has(normalized.profileId)) throw sandboxError("managed_sandbox_execution_profile_registry_invalid");
    profilesById.set(normalized.profileId, normalized);
  }
  return profilesById;
}

function normalizeProfile(value = null) {
  if (!isManagedSandboxProfile(value)) {
    throw sandboxError("managed_sandbox_execution_profile_registry_invalid");
  }
  return Object.freeze({ ...value });
}

function sandboxRegistration() {
  return Object.freeze({
    actionId: MANAGED_SANDBOX_EXECUTION_ACTION_ID,
    confirmationPolicy: TASK_CAPABILITY_GRANT_POLICY,
    risk: "controlled_execution",
    scope: CURRENT_TASK_WORKSPACE_SCOPE,
    toolId: MANAGED_SANDBOX_TOOL_ID,
    writebackBoundary: "none",
  });
}

function normalizeSandboxRegistration(value = null) {
  exactObject(value, new Set(["actionId", "confirmationPolicy", "risk", "scope", "toolId", "writebackBoundary"]));
  const expected = sandboxRegistration();
  if (Object.keys(expected).some((field) => value[field] !== expected[field])) {
    throw sandboxError("managed_sandbox_execution_registration_invalid");
  }
  return expected;
}

function isAuthorizedManagedSandboxTool(value = null, registration = null) {
  if (!value || typeof value !== "object" || Array.isArray(value) || value.status !== "allowed" ||
    Object.keys(value).length !== 2 || Object.keys(value).some((field) => !new Set(["status", "toolContract"]).has(field))) {
    return false;
  }
  const contract = value.toolContract;
  const expected = managedSandboxToolAuthorizationContract();
  if (!contract || typeof contract !== "object" || Array.isArray(contract) ||
    Object.keys(contract).length !== Object.keys(expected).length ||
    Object.keys(contract).some((field) => !Object.hasOwn(expected, field))) return false;
  return contract.contractVersion === expected.contractVersion && contract.toolId === registration?.toolId &&
    contract.toolId === expected.toolId && contract.action === expected.action && contract.policyAction === expected.policyAction &&
    contract.risk === registration?.risk && contract.risk === expected.risk &&
    contract.confirmationPolicy === registration?.confirmationPolicy &&
    contract.confirmationPolicy === expected.confirmationPolicy && contract.writebackBoundary === registration?.writebackBoundary &&
    contract.writebackBoundary === expected.writebackBoundary && Array.isArray(contract.scope) &&
    contract.scope.length === 1 && contract.scope[0] === registration?.scope && Array.isArray(contract.capabilities) &&
    contract.capabilities.length === 1 && contract.capabilities[0] === expected.capabilities[0];
}

function normalizeExecutionInput(value = "") {
  if (typeof value !== "string" || !value.trim() || value.length > 12_000 || value.includes("\0")) {
    throw sandboxError("managed_sandbox_ephemeral_execution_input_invalid");
  }
  return value;
}

function safeActivityDescriptor() {
  return Object.freeze({ actionCode: MANAGED_SANDBOX_ACTION_CODE, kind: "tool", subjectId: MANAGED_SANDBOX_SUBJECT_ID });
}

function safeActivityDescriptorMatches(value = null) {
  return value && typeof value === "object" && !Array.isArray(value) && Object.keys(value).length === 3 &&
    value.actionCode === MANAGED_SANDBOX_ACTION_CODE && value.kind === "tool" && value.subjectId === MANAGED_SANDBOX_SUBJECT_ID;
}

function blocked(reason) {
  return Object.freeze({ contractVersion: MANAGED_SANDBOX_EXECUTION_CONTRACT_VERSION, reason, status: "blocked" });
}

function runtimeTaskId(value = null) {
  return token(value?.taskId || value?.id, 128, { required: false });
}

function exactObject(value, fields) {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).length !== fields.size ||
    Object.keys(value).some((field) => !fields.has(field)) || [...fields].some((field) => !Object.hasOwn(value, field))) {
    throw sandboxError("managed_sandbox_execution_contract_shape_invalid");
  }
}

function normalizeProfileId(value = "") {
  const normalized = String(value || "").trim();
  if (!SAFE_PROFILE_ID.test(normalized)) throw sandboxError("managed_sandbox_execution_profile_invalid");
  return normalized;
}

function token(value, maxLength, { required = true } = {}) {
  const normalized = String(value || "").trim();
  if ((!normalized && !required) || (normalized && normalized.length <= maxLength && SAFE_TOKEN.test(normalized))) return normalized;
  throw sandboxError("managed_sandbox_execution_token_invalid");
}

function sandboxError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

export {
  CURRENT_TASK_WORKSPACE_SCOPE,
  MANAGED_SANDBOX_EXECUTION_ACTION_ID,
  MANAGED_SANDBOX_EXECUTION_CONTRACT_VERSION,
  MANAGED_SANDBOX_EPHEMERAL_EXECUTION_INPUT_CONTRACT_VERSION,
  MANAGED_SANDBOX_SAFE_PROJECTION_CONTRACT_VERSION,
  MANAGED_SANDBOX_TASK_CAPABILITY_GRANT_CONTRACT_VERSION,
  MANAGED_SANDBOX_TOOL_AUTHORIZATION_CONTRACT_VERSION,
  MANAGED_SANDBOX_TOOL_ID,
  createManagedSandboxExecutionAdapter,
  createManagedSandboxExecutionBoundary,
  createManagedSandboxEphemeralExecutionInputStore,
  createManagedSandboxTaskCapabilityGrantService,
  managedSandboxToolAuthorizationContract,
  safeManagedSandboxExecutionProjection,
};
