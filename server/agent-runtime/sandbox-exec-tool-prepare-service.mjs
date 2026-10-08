import crypto from "node:crypto";
import {
  CURRENT_TASK_WORKSPACE_SCOPE,
  MANAGED_SANDBOX_EXECUTION_ACTION_ID,
  MANAGED_SANDBOX_EXECUTION_CONTRACT_VERSION,
  managedSandboxToolAuthorizationContract,
} from "./managed-sandbox-execution-v1.mjs";
import { isManagedSandboxProfile, managedSandboxProfileRegistry } from "./managed-sandbox-profile-registry-v1.mjs";
import { runtimeSafeActivityDisplayName } from "./runtime-safe-activity-contract-v1.mjs";

const SANDBOX_EXEC_TOOL_PREPARE_CONTRACT_VERSION = "sandbox-exec-tool-prepare.v1";
const MANAGED_RUNNER_ACTION_CODE = "runner.execute";
const MANAGED_RUNNER_SUBJECT_ID = "managed-runner";
const DEVICE_SESSION_ID = /^dws_[a-f0-9]{32}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const PREPARE_GRANT_TTL_MS = 60_000;

// This standard Tool-loop composition prepares one authorized sandbox.exec
// operation. It deliberately has no executor, HTTP, SQLite, or Runner role.
function createSandboxExecToolPrepareService({
  capabilityGrantService = null,
  dispatchService = null,
  executionInputs = null,
  providerResolver = null,
  profiles = managedSandboxProfileRegistry(),
} = {}) {
  const profile = singleRegisteredProfile(profiles);
  if (!profile || typeof capabilityGrantService?.issueGrant !== "function" ||
    typeof capabilityGrantService?.revokeGrant !== "function" || typeof executionInputs?.stage !== "function" ||
    typeof dispatchService?.prepare !== "function" || typeof dispatchService?.awaitPreparedTerminal !== "function") {
    throw new TypeError("sandbox exec tool prepare dependencies are required");
  }

  async function prepare(input = {}, { signal = null } = {}) {
    if (signal?.aborted) return safeResult("blocked", "sandbox_execution_canceled");
    let context;
    try {
      context = normalizePrepareInput(input, profile);
    } catch {
      return safeResult("blocked");
    }
    if (profile.status !== "enabled") return safeResult("blocked", "sandbox_profile_unavailable");
    let grant = null;
    let envelope = null;
    try {
      grant = capabilityGrantService.issueGrant({
        maxOperations: 1,
        runtimeTask: context.runtimeTask,
        taskOwnership: context.taskOwnership,
        toolAuthorization: context.toolAuthorization,
        ttlMs: PREPARE_GRANT_TTL_MS,
      });
      envelope = executionInputs.stage({
        command: context.commandText,
        profileId: profile.profileId,
        profileRevision: profile.profileRevision,
        runtimeTask: context.runtimeTask,
      });
      const operation = Object.freeze({
        actionId: MANAGED_SANDBOX_EXECUTION_ACTION_ID,
        capabilityGrantId: grant.grantId,
        commandEnvelopeRef: envelope.commandEnvelopeRef,
        contractVersion: MANAGED_SANDBOX_EXECUTION_CONTRACT_VERSION,
        operationId: `sandbox_operation_${crypto.randomUUID().replace(/-/g, "")}`,
        profileId: profile.profileId,
        profileRevision: profile.profileRevision,
        scope: profile.scope,
        taskId: context.taskId,
      });
      const result = dispatchService.prepare({
        deviceSessionId: context.deviceSessionId,
        operation,
        runtimeTask: context.runtimeTask,
        session: context.session,
        taskOwnership: context.taskOwnership,
        workspaceInputDigest: context.workspaceInputDigest,
      });
      if (result?.status !== "prepared") return safeResult("blocked", safeDispatchReason(result?.reason));
      const terminal = await dispatchService.awaitPreparedTerminal({
        deviceSessionId: context.deviceSessionId,
        operation,
        runtimeTask: context.runtimeTask,
        session: context.session,
        taskOwnership: context.taskOwnership,
        workspaceInputDigest: context.workspaceInputDigest,
        signal,
      });
      return safeTerminalResult(terminal?.attempt?.status);
    } catch {
      return safeResult("blocked", signal?.aborted ? "sandbox_execution_canceled" : "");
    } finally {
      if (envelope?.commandEnvelopeRef) {
        try {
          executionInputs.discard?.({
            commandEnvelopeRef: envelope.commandEnvelopeRef,
            profileId: profile.profileId,
            profileRevision: profile.profileRevision,
            runtimeTask: context?.runtimeTask,
          });
        } catch {}
      }
      if (grant?.grantId) {
        try {
          capabilityGrantService.revokeGrant({
            grantId: grant.grantId,
            runtimeTask: context?.runtimeTask,
            taskOwnership: context?.taskOwnership,
          });
        } catch {}
      }
    }
  }

  return Object.freeze({ prepare });
}

function safeTerminalResult(status) {
  if (status === "completed") return safeResult("completed");
  const reason = {
    canceled: "sandbox_execution_canceled",
    failed: "sandbox_execution_failed",
    rejected: "sandbox_execution_rejected",
    timed_out: "sandbox_execution_timed_out",
    unknown: "sandbox_execution_unknown",
  }[status] || "sandbox_dispatch_terminal_unavailable";
  return safeResult("blocked", reason);
}

function normalizePrepareInput(value = {}, profile) {
  exactObject(value, new Set([
    "commandText", "deviceSessionId", "runtimeTask", "session", "taskOwnership", "toolAuthorization", "workspaceInputDigest",
  ]));
  const taskId = taskIdFor(value.runtimeTask);
  const deviceSessionId = String(value.deviceSessionId || "").trim().toLowerCase();
  if (!taskId || !DEVICE_SESSION_ID.test(deviceSessionId) || typeof value.commandText !== "string" ||
    !value.commandText.trim() || value.commandText.length > 12_000 || value.commandText.includes("\0") ||
    !SHA256.test(String(value.workspaceInputDigest || "").trim().toLowerCase()) || !profile ||
    profile.actionId !== MANAGED_SANDBOX_EXECUTION_ACTION_ID || profile.scope !== CURRENT_TASK_WORKSPACE_SCOPE) {
    throw new TypeError("sandbox exec tool prepare input invalid");
  }
  return Object.freeze({
    commandText: value.commandText,
    deviceSessionId,
    runtimeTask: value.runtimeTask,
    session: value.session,
    taskId,
    taskOwnership: value.taskOwnership,
    toolAuthorization: value.toolAuthorization,
    workspaceInputDigest: String(value.workspaceInputDigest).trim().toLowerCase(),
  });
}

function singleRegisteredProfile(profiles = []) {
  const candidates = Array.isArray(profiles)
    ? profiles.filter((profile) => isManagedSandboxProfile(profile) && profile.actionId === MANAGED_SANDBOX_EXECUTION_ACTION_ID)
    : [];
  return candidates.length === 1 ? Object.freeze({ ...candidates[0] }) : null;
}

function taskIdFor(runtimeTask = null) {
  const taskId = String(runtimeTask?.taskId || runtimeTask?.id || "").trim();
  return /^[A-Za-z0-9][A-Za-z0-9._:@-]{0,127}$/.test(taskId) ? taskId : "";
}

function exactObject(value, fields) {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).length !== fields.size ||
    Object.keys(value).some((field) => !fields.has(field)) || [...fields].some((field) => !Object.hasOwn(value, field))) {
    throw new TypeError("sandbox exec tool prepare input invalid");
  }
}

function safeResult(status, reason = "") {
  return Object.freeze({
    contractVersion: SANDBOX_EXEC_TOOL_PREPARE_CONTRACT_VERSION,
    status,
    ...(status === "blocked" && safeDispatchReason(reason) ? { reason: safeDispatchReason(reason) } : {}),
    ...(status === "prepared" || status === "completed" ? {
      activity: Object.freeze({
        actionCode: MANAGED_RUNNER_ACTION_CODE,
        displayName: runtimeSafeActivityDisplayName(MANAGED_RUNNER_ACTION_CODE),
        kind: "tool",
        subjectId: MANAGED_RUNNER_SUBJECT_ID,
      }),
    } : {}),
  });
}

function safeDispatchReason(value) {
  const reason = String(value || "").trim();
  return /^sandbox_[a-z0-9_]{1,96}$/.test(reason) || /^managed_sandbox_[a-z0-9_]{1,96}$/.test(reason) ||
    /^desktop_sandbox_[a-z0-9_]{1,96}$/.test(reason)
    ? reason
    : "";
}

export {
  SANDBOX_EXEC_TOOL_PREPARE_CONTRACT_VERSION,
  createSandboxExecToolPrepareService,
  managedSandboxToolAuthorizationContract,
};
