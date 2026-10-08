import crypto from "node:crypto";
import { cp, mkdir, readdir, rename, rm, stat, utimes } from "node:fs/promises";
import path from "node:path";
import { resolveDigitalWorkforceDataDir } from "../local-data-root.mjs";

const DEFAULT_TTL_MS = 48 * 60 * 60 * 1000;

function createTaskWorkspaceManager({
  baseRoot = process.env.DIGITAL_WORKFORCE_AGENT_WORKSPACE_ROOT || path.join(resolveDigitalWorkforceDataDir(), "agent-workspaces"),
  now = () => Date.now(),
  ttlMs = DEFAULT_TTL_MS,
} = {}) {
  async function workspaceForTask(taskId = "", { create = false } = {}) {
    return workspaceForOwner("task", taskId, { create });
  }

  async function createTaskInputDirectory(taskId = "", inputRef = "") {
    const workspace = await workspaceForTask(taskId, { create: true });
    return createWorkspaceInputDirectory(workspace, inputRef);
  }

  async function workspaceForStaging(stagingId = "", { create = false } = {}) {
    return workspaceForOwner("staging", stagingId, { create });
  }

  async function createStagingInputDirectory(stagingId = "", inputRef = "") {
    const workspace = await workspaceForStaging(stagingId, { create: true });
    return createWorkspaceInputDirectory(workspace, inputRef);
  }

  async function adoptStagingWorkspaceForTask(stagingId = "", taskId = "") {
    if (!stagingId || !taskId) return null;
    await cleanupExpired();
    const sourceRoot = workspaceRoot("staging", stagingId);
    const targetRoot = workspaceRoot("task", taskId);
    const [sourceExists, targetExists] = await Promise.all([directoryExists(sourceRoot), directoryExists(targetRoot)]);
    if (sourceExists && targetExists) throw new Error("task_workspace_already_exists");
    if (targetExists) return workspaceRecord(targetRoot, "task", taskId);
    if (!sourceExists) return null;
    await rename(sourceRoot, targetRoot);
    await touch(targetRoot);
    return workspaceRecord(targetRoot, "task", taskId);
  }

  async function forkTaskWorkspace(sourceTaskId = "", targetTaskId = "") {
    if (!sourceTaskId || !targetTaskId || sourceTaskId === targetTaskId) return null;
    const source = await workspaceForTask(sourceTaskId);
    if (!source) return null;
    const targetRoot = workspaceRoot("task", targetTaskId);
    if (await directoryExists(targetRoot)) return workspaceRecord(targetRoot, "task", targetTaskId);
    const temporaryRoot = `${targetRoot}.fork-${crypto.randomUUID()}`;
    try {
      await Promise.all([
        mkdir(path.join(temporaryRoot, "input"), { recursive: true, mode: 0o700 }),
        mkdir(path.join(temporaryRoot, "work"), { recursive: true, mode: 0o700 }),
        mkdir(path.join(temporaryRoot, "output"), { recursive: true, mode: 0o700 }),
      ]);
      await cp(source.inputRoot, path.join(temporaryRoot, "input"), { recursive: true, force: false });
      await rename(temporaryRoot, targetRoot);
      await touch(targetRoot);
      return workspaceRecord(targetRoot, "task", targetTaskId);
    } catch (error) {
      await rm(temporaryRoot, { recursive: true, force: true });
      if (await directoryExists(targetRoot)) return workspaceRecord(targetRoot, "task", targetTaskId);
      throw error;
    }
  }

  // Migration adapter for pre-MR1 callers. New execution paths must use taskId;
  // remove this after no active intake or runtime record references a v1 path.
  async function workspaceForSession(sessionKey = "", { create = false } = {}) {
    return workspaceForOwner("legacy-session", sessionKey, { create });
  }

  async function createInputDirectory(sessionKey = "", inputRef = "") {
    const workspace = await workspaceForSession(sessionKey, { create: true });
    return createWorkspaceInputDirectory(workspace, inputRef);
  }

  async function createWorkspaceInputDirectory(workspace, inputRef = "") {
    if (!workspace) return null;
    const inputId = crypto.createHash("sha256").update(String(inputRef || crypto.randomUUID())).digest("hex").slice(0, 20);
    const inputRoot = path.join(workspace.inputRoot, inputId);
    await rm(inputRoot, { recursive: true, force: true });
    await mkdir(inputRoot, { recursive: true, mode: 0o700 });
    await touch(workspace.root);
    return inputRoot;
  }

  async function workspaceForOwner(ownerType, ownerId, { create = false } = {}) {
    if (!ownerId) return null;
    await cleanupExpired();
    const root = workspaceRoot(ownerType, ownerId);
    if (!create && !await directoryExists(root)) return null;
    await Promise.all([
      mkdir(path.join(root, "input"), { recursive: true, mode: 0o700 }),
      mkdir(path.join(root, "work"), { recursive: true, mode: 0o700 }),
      mkdir(path.join(root, "output"), { recursive: true, mode: 0o700 }),
    ]);
    await touch(root);
    return workspaceRecord(root, ownerType, ownerId);
  }

  async function latestInputDirectory(workspace = null) {
    if (!workspace?.inputRoot) return "";
    try {
      const entries = await readdir(workspace.inputRoot, { withFileTypes: true });
      const directories = await Promise.all(entries.filter((entry) => entry.isDirectory()).map(async (entry) => {
        const entryPath = path.join(workspace.inputRoot, entry.name);
        return { entryPath, modifiedAt: (await stat(entryPath)).mtimeMs };
      }));
      return directories.sort((left, right) => right.modifiedAt - left.modifiedAt)[0]?.entryPath || "";
    } catch {
      return "";
    }
  }

  async function cleanupExpired() {
    let entries;
    try {
      entries = await readdir(baseRoot, { withFileTypes: true });
    } catch {
      return;
    }
    await Promise.all(entries.filter((entry) => entry.isDirectory()).map(async (entry) => {
      const entryPath = path.join(baseRoot, entry.name);
      try {
        const metadata = await stat(entryPath);
        if (now() - metadata.mtimeMs > ttlMs) await rm(entryPath, { recursive: true, force: true });
      } catch {
        // A concurrent worker may already have removed it.
      }
    }));
  }

  async function cleanupTaskWorkspace(taskId = "") {
    if (!taskId) return;
    await rm(workspaceRoot("task", taskId), { recursive: true, force: true });
  }

  function workspaceRoot(ownerType, ownerId) {
    const scope = ownerType === "legacy-session" ? ownerId : `${ownerType}:${ownerId}`;
    const digest = crypto.createHash("sha256").update(scope).digest("hex");
    return path.join(baseRoot, digest);
  }

  return {
    adoptStagingWorkspaceForTask,
    cleanupTaskWorkspace,
    cleanupExpired,
    createInputDirectory,
    createStagingInputDirectory,
    createTaskInputDirectory,
    forkTaskWorkspace,
    latestInputDirectory,
    workspaceForSession,
    workspaceForStaging,
    workspaceForTask,
  };
}

function workspaceRecord(root, ownerType, ownerId) {
  return {
    contractVersion: ownerType === "task"
      ? "agent-task-workspace.v2"
      : ownerType === "staging"
        ? "material-intake-staging.v1"
        : "agent-task-workspace.v1",
    ownerType: ownerType === "task"
      ? "execution_task"
      : ownerType === "staging"
        ? "material_intake"
        : "legacy_session_compatibility",
    ownerId,
    root,
    inputRoot: path.join(root, "input"),
    workRoot: path.join(root, "work"),
    outputRoot: path.join(root, "output"),
  };
}

async function directoryExists(value) {
  try {
    return (await stat(value)).isDirectory();
  } catch {
    return false;
  }
}

async function touch(value) {
  const time = new Date();
  await utimes(value, time, time).catch(() => {});
}

export { createTaskWorkspaceManager };
