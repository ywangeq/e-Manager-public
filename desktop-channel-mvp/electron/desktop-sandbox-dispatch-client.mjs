import path from "node:path";
import { workspaceInputDigest } from "./desktop-sandbox-workspace-input.mjs";

const DESKTOP_SANDBOX_DISPATCH_CLAIM_CONTRACT_VERSION = "desktop-sandbox-dispatch-claim.v1";
const DESKTOP_SANDBOX_DISPATCH_CLAIM_REQUEST_CONTRACT_VERSION = "desktop-sandbox-dispatch-claim-request.v2";
const DESKTOP_SANDBOX_DISPATCH_SETTLE_REQUEST_CONTRACT_VERSION = "desktop-sandbox-dispatch-settle-request.v1";
const DESKTOP_SANDBOX_DISPATCH_CANCEL_REQUEST_CONTRACT_VERSION = "desktop-sandbox-dispatch-cancel-request.v1";
const DESKTOP_SANDBOX_DISPATCH_TRANSPORT_RESULT_CONTRACT_VERSION = "desktop-sandbox-dispatch-transport-result.v1";
const DESKTOP_SANDBOX_DISPATCH_CLIENT_RESULT_CONTRACT_VERSION = "desktop-sandbox-dispatch-client-result.v1";
const CLAIMED_FIELDS = new Set(["attemptId", "commandText", "contractVersion", "operationDigest", "status", "taskId", "taskInputDigest", "timeoutMs", "workspaceInputDigest"]);
const EMPTY_FIELDS = new Set(["contractVersion", "status"]);
const SAFE_STATUSES = new Set(["canceled", "completed", "failed", "idle", "rejected", "timed_out", "unavailable"]);
const SUPERVISOR_STATUSES = new Set(["canceled", "completed", "failed", "rejected", "timed_out", "unavailable"]);
const TOKEN = /^[A-Za-z0-9][A-Za-z0-9._:@-]{0,159}$/;
const ATTEMPT_ID = /^sandbox_dispatch_[a-z0-9][a-z0-9._:-]{0,159}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const MAX_COMMAND_LENGTH = 12_000;
const MAX_TIMEOUT_MS = 60_000;

// Electron-main-only claim boundary. The Center's command text is held only in
// this call frame and is never returned, logged, persisted, or sent over IPC.
function createDesktopSandboxDispatchClient({
  authenticatedFetch,
  centerOrigin = "",
  outputIngest,
  resolveAuthorizedTaskInput,
  resolveWorkspaceRoot,
  supervisor,
  taskWorkspace,
} = {}) {
  if (typeof authenticatedFetch !== "function" || typeof outputIngest?.ingest !== "function" || typeof resolveAuthorizedTaskInput !== "function" ||
    typeof resolveWorkspaceRoot !== "function" || typeof supervisor?.executeTrustedRequest !== "function" ||
    typeof taskWorkspace?.ensureTaskWorkspace !== "function" || typeof taskWorkspace?.materializeAuthorizedInputs !== "function") {
    throw new TypeError("desktop sandbox dispatch client dependencies are required");
  }
  const normalizedCenterOrigin = httpsCenterOrigin(centerOrigin);
  const claimedAttemptIds = new Set();
  const claimedOperationDigests = new Set();
  const workspaceSummaries = new Map();

  async function claimAndExecute({ claimPath = "", signal = null, taskId = "" } = {}) {
    if (signal?.aborted) return safeResult("canceled");
    const boundTaskId = String(taskId || "").trim();
    if (!TOKEN.test(boundTaskId)) return safeResult("rejected");
    const target = sameOriginClaimTarget(normalizedCenterOrigin, claimPath);
    let response;
    try {
      response = await authenticatedFetch(target.href, {
        body: JSON.stringify({ contractVersion: DESKTOP_SANDBOX_DISPATCH_CLAIM_REQUEST_CONTRACT_VERSION, taskId: boundTaskId }),
        cache: "no-store",
        headers: { Accept: "application/json", "Content-Type": "application/json" },
        method: "POST",
        redirect: "error",
        signal,
      });
    } catch {
      return safeResult(signal?.aborted ? "canceled" : "unavailable");
    }
    if (signal?.aborted) return safeResult("canceled");
    if (!response || !Number.isInteger(response.status) || !response.ok) {
      return safeResult(response?.status === 401 || response?.status === 403 ? "rejected" : "unavailable");
    }

    let claim;
    try {
      claim = normalizeClaim(await response.json());
    } catch {
      return safeResult("rejected");
    }
    if (claim.status === "empty") return safeResult("idle");
    if (claim.taskId !== boundTaskId) return safeResult("unavailable", claim.workspaceInputDigest);
    if (claimedAttemptIds.has(claim.attemptId) || claimedOperationDigests.has(claim.operationDigest)) {
      return safeResult("unavailable", claim.workspaceInputDigest);
    }
    claimedAttemptIds.add(claim.attemptId);
    claimedOperationDigests.add(claim.operationDigest);
    if (signal?.aborted) {
      await finishDispatch({ claim, claimTarget: target, status: "canceled" });
      return safeResult("canceled", claim.workspaceInputDigest);
    }

    let authorizedFiles;
    let workspaceSummary;
    let workspaceRoot;
    try {
      authorizedFiles = await resolveAuthorizedTaskInput({
        taskId: claim.taskId,
        taskInputDigest: claim.taskInputDigest,
        workspaceInputDigest: claim.workspaceInputDigest,
      });
      if (!Array.isArray(authorizedFiles)) throw new TypeError("authorized task input is invalid");
      workspaceSummary = authorizedFiles.length
        ? await taskWorkspace.materializeAuthorizedInputs({ files: authorizedFiles, taskId: claim.taskId })
        : workspaceSummaries.get(claim.taskId) || await taskWorkspace.ensureTaskWorkspace({ taskId: claim.taskId });
      if (workspaceInputDigest(workspaceSummary) !== claim.workspaceInputDigest) {
        await finishDispatch({ claim, claimTarget: target, status: "rejected" });
        return safeResult("rejected", claim.workspaceInputDigest);
      }
      workspaceSummaries.set(claim.taskId, workspaceSummary);
      if (signal?.aborted) {
        await finishDispatch({ claim, claimTarget: target, status: "canceled" });
        return safeResult("canceled", claim.workspaceInputDigest);
      }
      workspaceRoot = await resolveWorkspaceRoot({
        taskId: claim.taskId,
        taskInputDigest: claim.taskInputDigest,
        workspaceInputDigest: claim.workspaceInputDigest,
      });
      if (!path.isAbsolute(String(workspaceRoot || ""))) throw new TypeError("workspace root is invalid");
    } catch {
      await finishDispatch({ claim, claimTarget: target, status: signal?.aborted ? "canceled" : "rejected" });
      return safeResult(signal?.aborted ? "canceled" : "rejected", claim.workspaceInputDigest);
    }
    if (signal?.aborted) {
      await finishDispatch({ claim, claimTarget: target, status: "canceled" });
      return safeResult("canceled", claim.workspaceInputDigest);
    }
    let execution;
    try {
      execution = await supervisor.executeTrustedRequest({
        commandText: claim.commandText,
        timeoutMs: claim.timeoutMs,
        workspaceRoot: path.normalize(workspaceRoot),
      }, { signal });
    } catch {
      execution = { status: signal?.aborted ? "canceled" : "failed" };
    }
    let status = signal?.aborted ? "canceled" : SUPERVISOR_STATUSES.has(execution?.status) ? execution.status : "failed";
    const stagedArtifactCount = status === "completed"
      ? await stageOutputArtifacts({ claim, outputIngest, centerOrigin: normalizedCenterOrigin.href, signal })
      : 0;
    if (signal?.aborted) status = "canceled";
    const settled = await finishDispatch({ claim, claimTarget: target, status });
    if (!settled && status !== "canceled") return safeResult("unavailable", claim.workspaceInputDigest, stagedArtifactCount);
    return safeResult(status, claim.workspaceInputDigest, stagedArtifactCount);
  }

  async function finishDispatch({ claim, claimTarget, status }) {
    const canceled = status === "canceled";
    return sendDispatchRequest({
      body: canceled
        ? { attemptId: claim.attemptId, contractVersion: DESKTOP_SANDBOX_DISPATCH_CANCEL_REQUEST_CONTRACT_VERSION }
        : {
            attemptId: claim.attemptId,
            contractVersion: DESKTOP_SANDBOX_DISPATCH_SETTLE_REQUEST_CONTRACT_VERSION,
            status: terminalDispatchStatus(status),
          },
      claimTarget,
      expectedStatus: canceled ? "canceled" : "settled",
      operation: canceled ? "cancel" : "settle",
    });
  }

  async function sendDispatchRequest({ body, claimTarget, expectedStatus, operation, signal = null }) {
    let response;
    try {
      response = await authenticatedFetch(dispatchTarget(claimTarget, operation).href, {
        body: JSON.stringify(body),
        cache: "no-store",
        headers: { Accept: "application/json", "Content-Type": "application/json" },
        method: "POST",
        redirect: "error",
        ...(signal ? { signal } : {}),
      });
    } catch {
      return false;
    }
    if (!response?.ok || !Number.isInteger(response.status)) return false;
    try {
      const result = await response.json();
      return exactTransportResult(result, expectedStatus);
    } catch {
      return false;
    }
  }

  return Object.freeze({ claimAndExecute });
}

function normalizeClaim(value) {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) {
    throw new TypeError("desktop sandbox dispatch claim is invalid");
  }
  if (value.status === "empty") {
    exactFields(value, EMPTY_FIELDS);
    if (value.contractVersion !== DESKTOP_SANDBOX_DISPATCH_CLAIM_CONTRACT_VERSION) throw new TypeError("desktop sandbox dispatch claim is invalid");
    return Object.freeze({ status: "empty" });
  }
  exactFields(value, CLAIMED_FIELDS);
  const attemptId = String(value.attemptId || "").trim().toLowerCase();
  const taskId = String(value.taskId || "").trim();
  const taskInputDigest = String(value.taskInputDigest || "").trim().toLowerCase();
  const workspaceInputDigestValue = String(value.workspaceInputDigest || "").trim().toLowerCase();
  const operationDigest = String(value.operationDigest || "").trim().toLowerCase();
  const commandText = value.commandText;
  const timeoutMs = Number(value.timeoutMs);
  if (value.contractVersion !== DESKTOP_SANDBOX_DISPATCH_CLAIM_CONTRACT_VERSION || value.status !== "claimed" ||
    !ATTEMPT_ID.test(attemptId) || !TOKEN.test(taskId) || !SHA256.test(taskInputDigest) || !SHA256.test(workspaceInputDigestValue) || !SHA256.test(operationDigest) ||
    typeof commandText !== "string" || !commandText.trim() || commandText.length > MAX_COMMAND_LENGTH || commandText.includes("\0") ||
    !Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > MAX_TIMEOUT_MS) {
    throw new TypeError("desktop sandbox dispatch claim is invalid");
  }
  return Object.freeze({ attemptId, commandText, operationDigest, status: "claimed", taskId, taskInputDigest, timeoutMs, workspaceInputDigest: workspaceInputDigestValue });
}

function httpsCenterOrigin(value) {
  let parsed;
  try {
    parsed = new URL(String(value || ""));
  } catch {
    throw new TypeError("desktop sandbox dispatch HTTPS Center origin is required");
  }
  if (parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.pathname !== "/" || parsed.search || parsed.hash) {
    throw new TypeError("desktop sandbox dispatch HTTPS Center origin is required");
  }
  return parsed;
}

function sameOriginClaimTarget(centerOrigin, claimPath) {
  const normalizedPath = String(claimPath || "").trim();
  if (!normalizedPath.startsWith("/") || normalizedPath.startsWith("//")) {
    throw new TypeError("desktop sandbox dispatch claim path is required");
  }
  let target;
  try {
    target = new URL(normalizedPath, centerOrigin);
  } catch {
    throw new TypeError("desktop sandbox dispatch claim path is required");
  }
  if (target.origin !== centerOrigin.origin || target.username || target.password || target.search || target.hash) {
    throw new TypeError("desktop sandbox dispatch claim path is required");
  }
  return target;
}

function dispatchTarget(claimTarget, operation) {
  if (!claimTarget?.pathname?.endsWith("/claim") || !["settle", "cancel"].includes(operation)) {
    throw new TypeError("desktop sandbox dispatch claim path is required");
  }
  const target = new URL(claimTarget.href);
  target.pathname = `${target.pathname.slice(0, -"claim".length)}${operation}`;
  return target;
}

function terminalDispatchStatus(status) {
  return ["completed", "failed", "rejected", "timed_out"].includes(status) ? status : "failed";
}

function exactTransportResult(value, expectedStatus) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype &&
    Object.keys(value).length === 2 && value.contractVersion === DESKTOP_SANDBOX_DISPATCH_TRANSPORT_RESULT_CONTRACT_VERSION &&
    value.status === expectedStatus);
}

function exactFields(value, fields) {
  if (Object.keys(value).length !== fields.size || Object.keys(value).some((field) => !fields.has(field)) ||
    [...fields].some((field) => !Object.hasOwn(value, field))) {
    throw new TypeError("desktop sandbox dispatch claim is invalid");
  }
}

async function stageOutputArtifacts({ claim, outputIngest, centerOrigin, signal = null }) {
  if (signal?.aborted) return 0;
  try {
    const staged = await outputIngest.ingest({
      attemptId: claim.attemptId,
      centerOrigin,
      taskId: claim.taskId,
      ...(signal ? { signal } : {}),
    });
    return !signal?.aborted && Number.isSafeInteger(staged?.artifactCount) && staged.artifactCount >= 0 && staged.artifactCount <= 3
      ? staged.artifactCount
      : 0;
  } catch {
    return 0;
  }
}

function safeResult(status, workspaceInputDigestValue = "", artifactCount = 0) {
  const result = {
    artifactCount: Number.isSafeInteger(artifactCount) && artifactCount >= 0 && artifactCount <= 3 ? artifactCount : 0,
    contractVersion: DESKTOP_SANDBOX_DISPATCH_CLIENT_RESULT_CONTRACT_VERSION,
    workspaceInputDigest: SHA256.test(workspaceInputDigestValue) ? workspaceInputDigestValue : null,
    status: SAFE_STATUSES.has(status) ? status : "unavailable",
  };
  return Object.freeze(result);
}

export {
  DESKTOP_SANDBOX_DISPATCH_CLAIM_CONTRACT_VERSION,
  DESKTOP_SANDBOX_DISPATCH_CLAIM_REQUEST_CONTRACT_VERSION,
  DESKTOP_SANDBOX_DISPATCH_CLIENT_RESULT_CONTRACT_VERSION,
  createDesktopSandboxDispatchClient,
  workspaceInputDigest,
};
