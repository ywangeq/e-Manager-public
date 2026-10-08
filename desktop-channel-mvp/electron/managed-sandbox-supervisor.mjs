import { execFileSync, spawn } from "node:child_process";
import path from "node:path";

const HELPER_CONTRACT_VERSION = "managed-sandbox-helper.internal.v1";
const SAFE_RESULT_STATUSES = new Set(["canceled", "completed", "failed", "rejected", "timed_out", "unavailable"]);
const MAX_COMMAND_LENGTH = 12_000;
const MAX_TIMEOUT_MS = 60_000;

// This is an Electron-main-only boundary. Do not expose it through preload or IPC:
// a future authenticated Device dispatch adapter is its only caller.
function createDesktopManagedSandboxSupervisor({
  helperPath = "",
  spawnProcess = spawn,
  terminateProcessTree = terminateManagedProcessTree,
} = {}) {
  const configuredHelperPath = String(helperPath || "").trim();
  if (!configuredHelperPath || !path.isAbsolute(configuredHelperPath) || typeof spawnProcess !== "function" ||
    typeof terminateProcessTree !== "function") {
    throw new TypeError("desktop managed sandbox supervisor dependencies are required");
  }
  const resolvedHelperPath = path.normalize(configuredHelperPath);

  async function executeTrustedRequest(request = {}, { signal = null } = {}) {
    const normalized = normalizeRequest(request);
    if (!normalized || signal?.aborted) return safeResult(signal?.aborted ? "canceled" : "rejected");
    return runHelper({ helperPath: resolvedHelperPath, request: normalized, signal, spawnProcess, terminateProcessTree });
  }

  return Object.freeze({ executeTrustedRequest });
}

function normalizeRequest(value = {}) {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
    Object.keys(value).length !== 3 || !["commandText", "timeoutMs", "workspaceRoot"].every((field) => Object.hasOwn(value, field))) {
    return null;
  }
  const commandText = value.commandText;
  const timeoutMs = Number(value.timeoutMs);
  const workspaceRoot = String(value.workspaceRoot || "");
  if (typeof commandText !== "string" || !commandText.trim() || commandText.length > MAX_COMMAND_LENGTH || commandText.includes("\0") ||
    !Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > MAX_TIMEOUT_MS || !path.isAbsolute(workspaceRoot)) {
    return null;
  }
  return Object.freeze({
    command: ["/bin/sh", "-lc", commandText],
    contractVersion: HELPER_CONTRACT_VERSION,
    timeoutMs,
    workspaceRoot,
  });
}

function runHelper({ helperPath, request, signal, spawnProcess, terminateProcessTree }) {
  return new Promise((resolve) => {
    let settled = false;
    let output = "";
    let abortListener = null;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      if (abortListener && signal?.removeEventListener) signal.removeEventListener("abort", abortListener);
      resolve(result);
    };
    let child;
    try {
      child = spawnProcess(helperPath, [], {
        detached: process.platform !== "win32",
        stdio: ["pipe", "pipe", "ignore"],
      });
    } catch {
      finish(safeResult("unavailable"));
      return;
    }
    child.once("error", () => finish(safeResult("unavailable")));
    child.stdout?.setEncoding?.("utf8");
    child.stdout?.on("data", (chunk) => {
      if (output.length <= 512) output += String(chunk).slice(0, 513 - output.length);
    });
    child.once("exit", (code) => finish(code === 0 ? parseSafeResult(output) : safeResult("unavailable")));
    if (signal?.addEventListener) {
      abortListener = () => {
        terminateProcessTree(child);
        finish(safeResult("canceled"));
      };
      signal.addEventListener("abort", abortListener, { once: true });
    }
    try {
      child.stdin?.end(JSON.stringify(request));
    } catch {
      terminateProcessTree(child);
      finish(safeResult("unavailable"));
    }
  });
}

function terminateManagedProcessTree(child) {
  const rootPid = Number(child?.pid);
  if (!Number.isSafeInteger(rootPid) || rootPid <= 0) {
    child?.kill?.("SIGTERM");
    return;
  }
  const pids = [rootPid, ...descendantProcessIds(rootPid)];
  terminateProcessIds(pids, "SIGTERM");
  terminateProcessIds(pids, "SIGKILL");
}

function descendantProcessIds(rootPid) {
  if (process.platform === "win32") return [];
  try {
    const processTable = execFileSync("/bin/ps", ["-axo", "pid=,ppid="], {
      encoding: "utf8",
      maxBuffer: 128 * 1024,
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 1_000,
    });
    const childrenByParent = new Map();
    for (const line of String(processTable).split("\n")) {
      const [pid, parentPid] = line.trim().split(/\s+/).map(Number);
      if (!Number.isSafeInteger(pid) || pid <= 0 || !Number.isSafeInteger(parentPid) || parentPid <= 0) continue;
      const siblings = childrenByParent.get(parentPid) || [];
      siblings.push(pid);
      childrenByParent.set(parentPid, siblings);
    }
    const descendants = [];
    const pending = [...(childrenByParent.get(rootPid) || [])];
    while (pending.length) {
      const pid = pending.pop();
      descendants.push(pid);
      pending.push(...(childrenByParent.get(pid) || []));
    }
    return descendants;
  } catch {
    return [];
  }
}

function terminateProcessIds(processIds, signal) {
  for (const pid of [...new Set(processIds)].reverse()) {
    try {
      if (process.platform !== "win32") process.kill(-pid, signal);
    } catch {}
    try {
      process.kill(pid, signal);
    } catch {}
  }
}

function parseSafeResult(value = "") {
  try {
    const result = JSON.parse(String(value || ""));
    if (!result || typeof result !== "object" || Array.isArray(result) || Object.keys(result).length !== 2 ||
      result.contractVersion !== HELPER_CONTRACT_VERSION || !SAFE_RESULT_STATUSES.has(result.status)) {
      return safeResult("unavailable");
    }
    return safeResult(result.status);
  } catch {
    return safeResult("unavailable");
  }
}

function safeResult(status) {
  return Object.freeze({ contractVersion: HELPER_CONTRACT_VERSION, status });
}

export { HELPER_CONTRACT_VERSION, createDesktopManagedSandboxSupervisor };
