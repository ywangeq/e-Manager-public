import path from "node:path";

const TOKEN = /^[A-Za-z0-9][A-Za-z0-9._:@-]{0,159}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const SOURCE_FILE_FIELDS = new Set(["fileName", "filePath", "inode", "modifiedAtMs", "sizeBytes"]);
const IDLE_RECLAIM_DELAY_MS = 250;

// Electron-main-only composition. It is deliberately dormant until a later
// Center-owned HTTPS claim route invokes claimAndExecute; no renderer caller
// can bind material, create a client, or receive a local workspace path.
function createDesktopSandboxMainDispatch({
  authenticatedFetch,
  createClaimClient,
  currentActorContext,
  outputIngest = null,
  resolveAuthorizedSelection,
  supervisor = null,
  taskWorkspace,
} = {}) {
  if (typeof authenticatedFetch !== "function" || typeof createClaimClient !== "function" ||
    typeof currentActorContext !== "function" || typeof outputIngest?.ingest !== "function" || typeof resolveAuthorizedSelection !== "function" ||
    typeof taskWorkspace?.resolveTrustedTaskWorkspaceRoot !== "function" ||
    typeof taskWorkspace?.ensureTaskWorkspace !== "function" || typeof taskWorkspace?.materializeAuthorizedInputs !== "function") {
    throw new TypeError("desktop sandbox main dispatch dependencies are required");
  }
  const authorizedTasks = new Map();
  let activeClaim = null;

  function bindAuthorizedTaskInput({ inputDigest = "", selectionId = "", taskId = "", workspaceInputDigest = "" } = {}) {
    const actor = requiredActor(currentActorContext());
    const safeTaskId = requiredToken(taskId, "task reference");
    const canonicalInputDigest = requiredDigest(inputDigest, "task input digest");
    const deviceWorkspaceInputDigest = requiredDigest(workspaceInputDigest, "workspace input digest");
    const sourceFiles = resolveAuthorizedSelection({ selectionId: requiredToken(selectionId, "selection reference") });
    const files = normalizeAuthorizedFiles(sourceFiles);
    if (authorizedTasks.has(safeTaskId)) throw dispatchError("desktop_sandbox_task_input_binding_invalid");
    authorizedTasks.set(safeTaskId, Object.freeze({
      actorKey: actor.key,
      actorVersion: actor.version,
      files,
      inputDigest: canonicalInputDigest,
      state: "bound",
      workspaceInputDigest: deviceWorkspaceInputDigest,
    }));
    return Object.freeze({
      inputDigest: canonicalInputDigest,
      status: "bound",
      taskId: safeTaskId,
      workspaceInputDigest: deviceWorkspaceInputDigest,
    });
  }

  function createTrustedClaimClient({ centerOrigin = "" } = {}) {
    if (!supervisor?.executeTrustedRequest) throw dispatchError("desktop_sandbox_supervisor_unavailable");
    return createClaimClient({
      authenticatedFetch,
      centerOrigin: requiredHttpsOrigin(centerOrigin),
      outputIngest,
      resolveAuthorizedTaskInput: ({ taskId = "", taskInputDigest = "", workspaceInputDigest = "" } = {}) =>
        consumeAuthorizedTaskInput({ taskId, taskInputDigest, workspaceInputDigest }),
      resolveWorkspaceRoot: ({ taskId = "", taskInputDigest = "", workspaceInputDigest = "" } = {}) =>
        resolveTrustedWorkspaceRoot({ taskId, taskInputDigest, workspaceInputDigest }),
      supervisor,
      taskWorkspace,
    });
  }

  async function claimAndExecute({ centerOrigin = "", claimPath = "", taskId = "" } = {}) {
    if (activeClaim) return safeResult("rejected");
    const safeTaskId = requiredToken(taskId, "task reference");
    currentBinding(safeTaskId);
    const controller = new AbortController();
    activeClaim = Object.freeze({ controller, taskId: safeTaskId });
    try {
      const client = createTrustedClaimClient({ centerOrigin });
      let result = safeResult("unavailable");
      while (!controller.signal.aborted) {
        result = await client.claimAndExecute({ claimPath, signal: controller.signal, taskId: safeTaskId });
        if (result?.status === "idle") {
          await waitForNextClaim(controller.signal);
          continue;
        }
        if (!["completed", "failed", "timed_out"].includes(result?.status)) return result;
      }
      return safeResult("canceled");
    } catch {
      return safeResult(controller.signal.aborted ? "canceled" : "unavailable");
    } finally {
      if (activeClaim?.controller === controller) activeClaim = null;
    }
  }

  function finishTask({ taskId = "" } = {}) {
    const safeTaskId = requiredToken(taskId, "task reference");
    if (activeClaim?.taskId === safeTaskId) activeClaim.controller.abort();
    authorizedTasks.delete(safeTaskId);
  }

  function cancelAndClear() {
    activeClaim?.controller.abort();
    activeClaim = null;
    authorizedTasks.clear();
  }

  function consumeAuthorizedTaskInput({ taskId = "", taskInputDigest = "", workspaceInputDigest = "" } = {}) {
    const binding = currentBinding(taskId, taskInputDigest, workspaceInputDigest);
    if (binding.state === "ready") return [];
    if (binding.state !== "bound") throw dispatchError("desktop_sandbox_task_input_consumed");
    authorizedTasks.set(String(taskId).trim(), Object.freeze({ ...binding, state: "materializing" }));
    return binding.files.map((file) => ({ ...file }));
  }

  async function resolveTrustedWorkspaceRoot({ taskId = "", taskInputDigest = "", workspaceInputDigest = "" } = {}) {
    const safeTaskId = requiredToken(taskId, "task reference");
    currentBinding(safeTaskId, taskInputDigest, workspaceInputDigest);
    const root = await taskWorkspace.resolveTrustedTaskWorkspaceRoot({ taskId: safeTaskId });
    const current = currentBinding(safeTaskId, taskInputDigest, workspaceInputDigest);
    if (current.state === "materializing") {
      authorizedTasks.set(safeTaskId, Object.freeze({ ...current, files: Object.freeze([]), state: "ready" }));
    }
    return root;
  }

  function currentBinding(taskId, taskInputDigest = "", workspaceInputDigest = "") {
    const safeTaskId = requiredToken(taskId, "task reference");
    const binding = authorizedTasks.get(safeTaskId);
    const expectedTaskInputDigest = taskInputDigest ? requiredDigest(taskInputDigest, "task input digest") : binding?.inputDigest;
    const expectedWorkspaceInputDigest = workspaceInputDigest ? requiredDigest(workspaceInputDigest, "workspace input digest") : binding?.workspaceInputDigest;
    if (!binding || binding.inputDigest !== expectedTaskInputDigest || binding.workspaceInputDigest !== expectedWorkspaceInputDigest) {
      throw dispatchError("desktop_sandbox_task_input_not_authorized");
    }
    const actor = requiredActor(currentActorContext());
    if (binding.actorKey !== actor.key || binding.actorVersion !== actor.version) {
      throw dispatchError("desktop_sandbox_task_input_actor_changed");
    }
    return binding;
  }

  return Object.freeze({ bindAuthorizedTaskInput, cancelAndClear, claimAndExecute, createTrustedClaimClient, finishTask });
}

function waitForNextClaim(signal) {
  if (signal?.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(done, IDLE_RECLAIM_DELAY_MS);
    function done() {
      clearTimeout(timer);
      signal?.removeEventListener?.("abort", done);
      resolve();
    }
    signal?.addEventListener?.("abort", done, { once: true });
  });
}

function normalizeAuthorizedFiles(value) {
  if (!Array.isArray(value) || value.length > 20) throw dispatchError("desktop_sandbox_task_input_selection_invalid");
  return Object.freeze(value.map((file) => {
    if (!file || typeof file !== "object" || Array.isArray(file) || Object.getPrototypeOf(file) !== Object.prototype ||
      Object.keys(file).length !== SOURCE_FILE_FIELDS.size || Object.keys(file).some((key) => !SOURCE_FILE_FIELDS.has(key))) {
      throw dispatchError("desktop_sandbox_task_input_selection_invalid");
    }
    const fileName = String(file.fileName || "").normalize("NFC").trim();
    const filePath = String(file.filePath || "");
    const inode = Number(file.inode);
    const modifiedAtMs = Number(file.modifiedAtMs);
    const sizeBytes = Number(file.sizeBytes);
    if (!fileName || fileName.length > 180 || !path.isAbsolute(filePath) || !Number.isSafeInteger(inode) || inode < 0 ||
      !Number.isFinite(modifiedAtMs) || !Number.isSafeInteger(sizeBytes) || sizeBytes <= 0) {
      throw dispatchError("desktop_sandbox_task_input_selection_invalid");
    }
    return Object.freeze({ fileName, filePath, inode, modifiedAtMs, sizeBytes });
  }));
}

function requiredActor(value) {
  const key = String(value?.key || "").trim();
  const version = Number(value?.version);
  if (!TOKEN.test(key) || !Number.isSafeInteger(version) || version < 1) {
    throw dispatchError("desktop_sandbox_task_input_authentication_required");
  }
  return Object.freeze({ key, version });
}

function requiredToken(value, _field) {
  const normalized = String(value || "").trim();
  if (!TOKEN.test(normalized)) throw dispatchError("desktop_sandbox_task_input_reference_invalid");
  return normalized;
}

function requiredDigest(value, _field) {
  const normalized = String(value || "").trim().toLowerCase();
  if (!SHA256.test(normalized)) throw dispatchError("desktop_sandbox_task_input_digest_invalid");
  return normalized;
}

function requiredHttpsOrigin(value) {
  let parsed;
  try {
    parsed = new URL(String(value || ""));
  } catch {
    throw dispatchError("desktop_sandbox_dispatch_center_origin_invalid");
  }
  if (parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.pathname !== "/" || parsed.search || parsed.hash) {
    throw dispatchError("desktop_sandbox_dispatch_center_origin_invalid");
  }
  return parsed.href;
}

function safeResult(status) {
  return Object.freeze({
    artifactCount: 0,
    contractVersion: "desktop-sandbox-dispatch-client-result.v1",
    workspaceInputDigest: null,
    status,
  });
}

function dispatchError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

export { createDesktopSandboxMainDispatch };
