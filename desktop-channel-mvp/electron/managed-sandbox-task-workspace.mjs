import crypto from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { chmod, lstat, mkdir, open, readdir, realpath, rm } from "node:fs/promises";
import path from "node:path";
import { uniqueWorkspaceFileName } from "./desktop-sandbox-workspace-input.mjs";

const TASK_WORKSPACE_CONTRACT_VERSION = "device-sandbox-task-workspace.v1";
const TASK_ROOT_DIRECTORY = "managed-sandbox-task-workspaces";
const FIXED_DIRECTORIES = ["input", "work", "output", ".managed-sandbox-tmp"];
const MAX_INPUT_FILES = 20;
const TASK_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const SAFE_FILE_NAME_PATTERN = /^[^/\\\0\r\n]{1,180}$/u;
const RESERVED_WINDOWS_FILE_NAMES = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.[^.]*)?$/i;
const NOFOLLOW = fsConstants.O_NOFOLLOW || 0;

// Electron-main-only local storage boundary. The caller must already have
// authorized every source file for this task; this utility never receives IPC
// input and never returns a local path in its public result.
function createDesktopManagedSandboxTaskWorkspace({ userDataPath = "" } = {}) {
  const configuredUserDataPath = String(userDataPath || "");
  if (!path.isAbsolute(configuredUserDataPath)) {
    throw new TypeError("desktop managed sandbox workspace userDataPath is required");
  }
  const baseRoot = path.join(path.normalize(configuredUserDataPath), TASK_ROOT_DIRECTORY);

  async function ensureTaskWorkspace({ taskId = "" } = {}) {
    const workspace = await privateWorkspaceForTask(taskId);
    return safeWorkspaceSummary(workspace, []);
  }

  async function materializeAuthorizedInputs({ taskId = "", files = [] } = {}) {
    const workspace = await privateWorkspaceForTask(taskId);
    const authorizedFiles = normalizeAuthorizedFiles(files);
    const entries = await readdir(workspace.inputRoot).catch(() => { throw workspaceError("input_directory_unavailable"); });
    if (entries.length) throw workspaceError("input_directory_not_empty");

    const copied = [];
    try {
      for (const [index, file] of authorizedFiles.entries()) {
        const fileName = uniqueWorkspaceFileName(file.fileName, copied.map((item) => item.fileName));
        copied.push(await copyAuthorizedFile({ destinationRoot: workspace.inputRoot, file, fileName, inputId: `input-${index + 1}` }));
      }
    } catch (error) {
      await Promise.all(copied.map((item) => rm(path.join(workspace.inputRoot, item.fileName), { force: true }).catch(() => {})));
      throw error;
    }
    return safeWorkspaceSummary(workspace, copied);
  }

  // Internal Electron-main-only resolver. It intentionally returns a path for
  // the trusted supervisor boundary; never expose this function through IPC.
  async function resolveTrustedTaskWorkspaceRoot({ taskId = "" } = {}) {
    const workspace = await privateWorkspaceForTask(taskId);
    return workspace.taskRoot;
  }

  async function privateWorkspaceForTask(taskId = "") {
    const safeTaskId = normalizeTaskId(taskId);
    const root = path.join(baseRoot, taskDirectoryName(safeTaskId));
    const managedRoot = await ensurePrivateDirectory(baseRoot, null);
    const taskRoot = await ensurePrivateDirectory(root, managedRoot);
    const directories = {};
    for (const directoryName of FIXED_DIRECTORIES) {
      directories[directoryName] = await ensurePrivateDirectory(path.join(taskRoot, directoryName), taskRoot);
    }
    return {
      taskId: safeTaskId,
      taskRoot,
      inputRoot: directories.input,
      workRoot: directories.work,
      outputRoot: directories.output,
      tempRoot: directories[".managed-sandbox-tmp"],
    };
  }

  return Object.freeze({ ensureTaskWorkspace, materializeAuthorizedInputs, resolveTrustedTaskWorkspaceRoot });
}

async function ensurePrivateDirectory(directoryPath, expectedParent) {
  try {
    await mkdir(directoryPath, { recursive: true, mode: 0o700 });
    const metadata = await lstat(directoryPath);
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) throw workspaceError("workspace_path_invalid");
    await chmod(directoryPath, 0o700);
    const resolved = await realpath(directoryPath);
    if (expectedParent) assertWithinDirectory(expectedParent, resolved);
    return resolved;
  } catch (error) {
    if (error?.code?.startsWith?.("device_sandbox_task_workspace_")) throw error;
    throw workspaceError("workspace_path_unavailable");
  }
}

async function copyAuthorizedFile({ destinationRoot, file, fileName, inputId }) {
  const destinationPath = path.join(destinationRoot, fileName);
  assertWithinDirectory(destinationRoot, destinationPath);
  let sourceHandle = null;
  let destinationHandle = null;
  let committed = false;
  try {
    const sourceMetadata = await lstat(file.filePath).catch(() => null);
    if (!isAuthorizedSource(sourceMetadata, file)) throw workspaceError("source_file_changed");
    sourceHandle = await open(file.filePath, fsConstants.O_RDONLY | NOFOLLOW);
    const openedMetadata = await sourceHandle.stat();
    if (!isAuthorizedSource(openedMetadata, file)) throw workspaceError("source_file_changed");

    const existingDestination = await lstat(destinationPath).catch(() => null);
    if (existingDestination) throw workspaceError("destination_exists");
    destinationHandle = await open(destinationPath, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | NOFOLLOW, 0o600);
    const digest = crypto.createHash("sha256");
    const buffer = Buffer.allocUnsafe(64 * 1024);
    let sizeBytes = 0;
    let position = 0;
    while (true) {
      const { bytesRead } = await sourceHandle.read(buffer, 0, buffer.length, position);
      if (!bytesRead) break;
      const chunk = buffer.subarray(0, bytesRead);
      sizeBytes += bytesRead;
      if (sizeBytes > file.sizeBytes) throw workspaceError("source_file_changed");
      digest.update(chunk);
      await writeAll(destinationHandle, chunk);
      position += bytesRead;
    }
    if (sizeBytes !== file.sizeBytes) throw workspaceError("source_file_changed");
    await destinationHandle.sync();
    await destinationHandle.close();
    destinationHandle = null;
    const destinationMetadata = await lstat(destinationPath);
    if (!destinationMetadata.isFile() || destinationMetadata.isSymbolicLink() || destinationMetadata.size !== sizeBytes) {
      throw workspaceError("destination_invalid");
    }
    committed = true;
    return Object.freeze({
      contentDigest: `sha256:${digest.digest("hex")}`,
      fileName,
      inputId,
      sizeBytes,
    });
  } catch (error) {
    if (error?.code?.startsWith?.("device_sandbox_task_workspace_")) throw error;
    throw workspaceError("input_copy_failed");
  } finally {
    await sourceHandle?.close().catch(() => {});
    await destinationHandle?.close().catch(() => {});
    if (!committed) await rm(destinationPath, { force: true }).catch(() => {});
  }
}

async function writeAll(handle, chunk) {
  let offset = 0;
  while (offset < chunk.length) {
    const { bytesWritten } = await handle.write(chunk, offset, chunk.length - offset, null);
    if (!bytesWritten) throw workspaceError("input_copy_failed");
    offset += bytesWritten;
  }
}

function normalizeAuthorizedFiles(value) {
  if (!Array.isArray(value) || !value.length || value.length > MAX_INPUT_FILES) {
    throw workspaceError("authorized_files_invalid");
  }
  return value.map((file) => {
    if (!plainObjectWithFields(file, ["fileName", "filePath", "inode", "modifiedAtMs", "sizeBytes"])) {
      throw workspaceError("authorized_file_invalid");
    }
    const fileName = safeFileName(file.fileName);
    const filePath = String(file.filePath || "");
    const inode = Number(file.inode);
    const modifiedAtMs = Number(file.modifiedAtMs);
    const sizeBytes = Number(file.sizeBytes);
    if (!fileName || !path.isAbsolute(filePath) || !Number.isSafeInteger(inode) || inode < 0 ||
      !Number.isFinite(modifiedAtMs) || !Number.isSafeInteger(sizeBytes) || sizeBytes <= 0) {
      throw workspaceError("authorized_file_invalid");
    }
    return Object.freeze({ fileName, filePath, inode, modifiedAtMs, sizeBytes });
  });
}

function isAuthorizedSource(metadata, file) {
  return Boolean(metadata?.isFile?.() && !metadata.isSymbolicLink?.() &&
    metadata.ino === file.inode && metadata.size === file.sizeBytes && metadata.mtimeMs === file.modifiedAtMs);
}

function safeWorkspaceSummary(workspace, inputs) {
  return Object.freeze({
    contractVersion: TASK_WORKSPACE_CONTRACT_VERSION,
    inputCount: inputs.length,
    inputs: Object.freeze(inputs.map((input) => Object.freeze({ ...input }))),
    status: "ready",
    taskId: workspace.taskId,
    totalInputBytes: inputs.reduce((sum, input) => sum + input.sizeBytes, 0),
  });
}

function normalizeTaskId(value) {
  const taskId = String(value || "").trim();
  if (!TASK_ID_PATTERN.test(taskId)) throw workspaceError("task_reference_invalid");
  return taskId;
}

function taskDirectoryName(taskId) {
  return crypto.createHash("sha256").update(`device-sandbox-task-workspace.v1\0${taskId}`).digest("hex");
}

function safeFileName(value) {
  const fileName = String(value || "").normalize("NFC").trim();
  if (!SAFE_FILE_NAME_PATTERN.test(fileName) || fileName === "." || fileName === ".." || fileName.endsWith(".") ||
    fileName.endsWith(" ") || RESERVED_WINDOWS_FILE_NAMES.test(fileName)) return "";
  return fileName;
}

function assertWithinDirectory(directoryPath, candidatePath) {
  const relative = path.relative(directoryPath, candidatePath);
  if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw workspaceError("workspace_path_escape");
  }
}

function plainObjectWithFields(value, fields) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value) &&
    Object.keys(value).length === fields.length && fields.every((field) => Object.hasOwn(value, field)));
}

function workspaceError(code) {
  const error = new Error(code);
  error.code = `device_sandbox_task_workspace_${code}`;
  return error;
}

export { TASK_WORKSPACE_CONTRACT_VERSION, createDesktopManagedSandboxTaskWorkspace };
