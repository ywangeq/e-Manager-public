import crypto from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { lstat, open, readdir, realpath, rm } from "node:fs/promises";
import path from "node:path";
import { DESKTOP_TASK_ARTIFACT_STAGING_RESULT_CONTRACT_VERSION } from "./desktop-task-artifact-staging-client.mjs";

const DEVICE_SANDBOX_OUTPUT_INGEST_CONTRACT_VERSION = "device-sandbox-output-ingest.v1";
const DEVICE_SANDBOX_ARTIFACT_STAGING_RESULT_CONTRACT_VERSION = DESKTOP_TASK_ARTIFACT_STAGING_RESULT_CONTRACT_VERSION;
const TOKEN = /^[A-Za-z0-9][A-Za-z0-9._:@-]{0,159}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const RESERVED_WINDOWS_FILE_NAMES = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.[^.]*)?$/i;
const NOFOLLOW = fsConstants.O_NOFOLLOW || 0;
const DEFAULT_MAX_ARTIFACT_BYTES = 128 * 1024 * 1024;
const DEFAULT_MAX_ARTIFACT_FILES = 3;

// Electron-main-only output boundary. `stageTaskArtifacts` is a future trusted
// adapter that copies snapshots into the canonical task workspace and delegates
// publication to the existing taskArtifactService; this module owns no store.
function createDesktopSandboxOutputIngestService({
  stageTaskArtifacts,
  taskWorkspace,
  maxArtifactBytes = DEFAULT_MAX_ARTIFACT_BYTES,
  maxArtifactFiles = DEFAULT_MAX_ARTIFACT_FILES,
} = {}) {
  if (typeof stageTaskArtifacts !== "function" || typeof taskWorkspace?.resolveTrustedTaskWorkspaceRoot !== "function" ||
    !Number.isSafeInteger(maxArtifactBytes) || maxArtifactBytes < 1 || !Number.isSafeInteger(maxArtifactFiles) || maxArtifactFiles < 1) {
    throw new TypeError("desktop sandbox output ingest dependencies are required");
  }

  async function ingest({ attemptId = "", centerOrigin = "", signal = null, taskId = "" } = {}) {
    let context;
    let snapshots = [];
    try {
      if (signal?.aborted) return safeResult("rejected");
      context = normalizeContext({ attemptId, centerOrigin, taskId });
      const taskRoot = await resolvePrivateWorkspaceRoot(taskWorkspace, context.taskId);
      const directories = await resolvePrivateOutputDirectories(taskRoot);
      const files = await collectOutputFiles({ maxArtifactBytes, maxArtifactFiles, outputRoot: directories.outputRoot });
      if (!files.length) return safeResult("no_output");
      snapshots = await Promise.all(files.map((file, index) => snapshotOutputFile({
        file,
        stagingRoot: directories.stagingRoot,
        snapshotId: `${index + 1}-${crypto.randomUUID()}`,
      })));
      if (signal?.aborted) return safeResult("rejected");
      const staged = await stageTaskArtifacts({
        artifacts: snapshots.map(privateStagingArtifact),
        attemptId: context.attemptId,
        centerOrigin: context.centerOrigin,
        signal,
      });
      if (signal?.aborted) return safeResult("rejected");
      if (!validStagingResult(staged, snapshots)) return safeResult("rejected");
      return safeResult("ingested", snapshots);
    } catch {
      return safeResult("rejected");
    } finally {
      await Promise.all(snapshots.map((snapshot) => rm(snapshot.snapshotPath, { force: true }).catch(() => {})));
    }
  }

  return Object.freeze({ ingest });
}

function normalizeContext({ attemptId, centerOrigin, taskId }) {
  const safeAttemptId = requiredToken(attemptId, 160).toLowerCase();
  if (!safeAttemptId.startsWith("sandbox_dispatch_")) throw new TypeError("desktop sandbox output attempt is invalid");
  const normalizedCenterOrigin = httpsCenterOrigin(centerOrigin);
  return Object.freeze({
    attemptId: safeAttemptId,
    centerOrigin: normalizedCenterOrigin,
    taskId: requiredToken(taskId, 128),
  });
}

function httpsCenterOrigin(value) {
  let parsed;
  try {
    parsed = new URL(String(value || ""));
  } catch {
    throw new TypeError("desktop sandbox output Center origin is invalid");
  }
  if (parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.pathname !== "/" || parsed.search || parsed.hash) {
    throw new TypeError("desktop sandbox output Center origin is invalid");
  }
  return parsed.href;
}

async function resolvePrivateWorkspaceRoot(taskWorkspace, taskId) {
  const root = String(await taskWorkspace.resolveTrustedTaskWorkspaceRoot({ taskId }) || "");
  if (!path.isAbsolute(root)) throw new TypeError("desktop sandbox output workspace is invalid");
  const metadata = await lstat(root);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) throw new TypeError("desktop sandbox output workspace is invalid");
  return realpath(root);
}

async function resolvePrivateOutputDirectories(taskRoot) {
  const outputRoot = await realDirectory(path.join(taskRoot, "output"));
  const stagingRoot = await realDirectory(path.join(taskRoot, ".managed-sandbox-tmp"));
  if (outputRoot !== path.join(taskRoot, "output") || stagingRoot !== path.join(taskRoot, ".managed-sandbox-tmp")) {
    throw new TypeError("desktop sandbox output directory is invalid");
  }
  return Object.freeze({ outputRoot, stagingRoot });
}

async function realDirectory(directoryPath) {
  const metadata = await lstat(directoryPath);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) throw new TypeError("desktop sandbox output directory is invalid");
  return realpath(directoryPath);
}

async function collectOutputFiles({ outputRoot, maxArtifactBytes, maxArtifactFiles }) {
  const files = [];
  await walk(outputRoot, "");
  return files;

  async function walk(currentDirectory, relativeDirectory) {
    const entries = await readdir(currentDirectory, { withFileTypes: true });
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      const relativePath = relativeDirectory ? `${relativeDirectory}/${entry.name}` : entry.name;
      const candidate = path.join(currentDirectory, entry.name);
      const metadata = await lstat(candidate);
      if (metadata.isSymbolicLink() || (!metadata.isDirectory() && !metadata.isFile())) {
        throw new TypeError("desktop sandbox output entry is invalid");
      }
      if (metadata.isDirectory()) {
        await walk(candidate, relativePath);
        continue;
      }
      if (metadata.nlink !== 1 || metadata.size < 1 || metadata.size > maxArtifactBytes || files.length >= maxArtifactFiles) {
        throw new TypeError("desktop sandbox output file is invalid");
      }
      if (!safeRelativePath(relativePath) || !safeFileName(entry.name)) throw new TypeError("desktop sandbox output file is invalid");
      files.push(Object.freeze({ metadata, fileName: entry.name, relativePath, sourcePath: candidate }));
    }
  }
}

async function snapshotOutputFile({ file, stagingRoot, snapshotId }) {
  const snapshotPath = path.join(stagingRoot, `.artifact-${snapshotId}.snapshot`);
  if (!isWithin(stagingRoot, snapshotPath)) throw new TypeError("desktop sandbox output snapshot is invalid");
  let sourceHandle = null;
  let snapshotHandle = null;
  let committed = false;
  try {
    sourceHandle = await open(file.sourcePath, fsConstants.O_RDONLY | NOFOLLOW);
    const opened = await sourceHandle.stat();
    assertSamePrivateFile(file.metadata, opened);
    snapshotHandle = await open(snapshotPath, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | NOFOLLOW, 0o600);
    const digest = crypto.createHash("sha256");
    const buffer = Buffer.allocUnsafe(64 * 1024);
    let position = 0;
    let sizeBytes = 0;
    while (true) {
      const { bytesRead } = await sourceHandle.read(buffer, 0, buffer.length, position);
      if (!bytesRead) break;
      const chunk = buffer.subarray(0, bytesRead);
      sizeBytes += bytesRead;
      if (sizeBytes > file.metadata.size) throw new TypeError("desktop sandbox output changed");
      digest.update(chunk);
      await writeAll(snapshotHandle, chunk);
      position += bytesRead;
    }
    if (sizeBytes !== file.metadata.size) throw new TypeError("desktop sandbox output changed");
    await snapshotHandle.sync();
    await snapshotHandle.close();
    snapshotHandle = null;
    assertSamePrivateFile(file.metadata, await lstat(file.sourcePath));
    const snapshotMetadata = await lstat(snapshotPath);
    if (!snapshotMetadata.isFile() || snapshotMetadata.isSymbolicLink() || snapshotMetadata.nlink !== 1 || snapshotMetadata.size !== sizeBytes) {
      throw new TypeError("desktop sandbox output snapshot is invalid");
    }
    committed = true;
    return Object.freeze({
      fileName: file.fileName,
      relativePath: file.relativePath,
      sha256: digest.digest("hex"),
      sizeBytes,
      snapshotPath,
    });
  } finally {
    await sourceHandle?.close().catch(() => {});
    await snapshotHandle?.close().catch(() => {});
    if (!committed) await rm(snapshotPath, { force: true }).catch(() => {});
  }
}

async function writeAll(handle, chunk) {
  let offset = 0;
  while (offset < chunk.length) {
    const { bytesWritten } = await handle.write(chunk, offset, chunk.length - offset, null);
    if (!bytesWritten) throw new TypeError("desktop sandbox output snapshot is invalid");
    offset += bytesWritten;
  }
}

function privateStagingArtifact(snapshot) {
  return Object.freeze({
    fileName: snapshot.fileName,
    relativePath: snapshot.relativePath,
    sha256: snapshot.sha256,
    sizeBytes: snapshot.sizeBytes,
    snapshotPath: snapshot.snapshotPath,
  });
}

function validStagingResult(value, snapshots) {
  if (!exactObject(value, new Set(["artifacts", "contractVersion", "status"])) ||
    value.contractVersion !== DEVICE_SANDBOX_ARTIFACT_STAGING_RESULT_CONTRACT_VERSION || value.status !== "staged" ||
    !Array.isArray(value.artifacts) || value.artifacts.length !== snapshots.length) return false;
  return value.artifacts.every((artifact, index) => exactObject(artifact, new Set(["fileName", "sha256", "sizeBytes"])) &&
    artifact.fileName === snapshots[index].fileName && artifact.sha256 === snapshots[index].sha256 && artifact.sizeBytes === snapshots[index].sizeBytes);
}

function safeResult(status, snapshots = []) {
  const artifacts = status === "ingested"
    ? snapshots.map((snapshot) => Object.freeze({ fileName: snapshot.fileName, sha256: snapshot.sha256, sizeBytes: snapshot.sizeBytes }))
    : [];
  return Object.freeze({
    artifactCount: artifacts.length,
    artifacts: Object.freeze(artifacts),
    contractVersion: DEVICE_SANDBOX_OUTPUT_INGEST_CONTRACT_VERSION,
    status: status === "ingested" || status === "no_output" ? status : "rejected",
  });
}

function assertSamePrivateFile(expected, actual) {
  if (!actual?.isFile?.() || actual.isSymbolicLink?.() || actual.nlink !== 1 || actual.dev !== expected.dev ||
    actual.ino !== expected.ino || actual.size !== expected.size || actual.mtimeMs !== expected.mtimeMs) {
    throw new TypeError("desktop sandbox output changed");
  }
}

function safeRelativePath(value) {
  const relativePath = String(value || "");
  return relativePath && !path.isAbsolute(relativePath) && !relativePath.includes("\\") &&
    !relativePath.split("/").some((segment) => !segment || segment === "." || segment === "..");
}

function safeFileName(value) {
  const fileName = String(value || "").normalize("NFC");
  return fileName && fileName.length <= 255 && fileName !== "." && fileName !== ".." && !fileName.includes("/") &&
    !fileName.includes("\\") && !/[\0-\x1f\x7f<>:"|?*\u202a-\u202e\u2066-\u2069]/u.test(fileName) && !fileName.endsWith(".") &&
    !fileName.endsWith(" ") && !RESERVED_WINDOWS_FILE_NAMES.test(fileName);
}

function isWithin(root, candidate) {
  const relative = path.relative(root, candidate);
  return Boolean(relative && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function exactObject(value, fields) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype &&
    Object.keys(value).length === fields.size && Object.keys(value).every((field) => fields.has(field)) &&
    [...fields].every((field) => Object.hasOwn(value, field)));
}

function requiredToken(value, maxLength = 160) {
  const normalized = String(value || "").trim();
  if (!TOKEN.test(normalized) || normalized.length > maxLength) throw new TypeError("desktop sandbox output identity is invalid");
  return normalized;
}

function requiredDigest(value) {
  const normalized = String(value || "").trim().toLowerCase();
  if (!SHA256.test(normalized)) throw new TypeError("desktop sandbox output digest is invalid");
  return normalized;
}

function requiredFence(value) {
  if (!Number.isSafeInteger(value) || value < 1) throw new TypeError("desktop sandbox output lease is invalid");
  return value;
}

export {
  DEFAULT_MAX_ARTIFACT_BYTES,
  DEFAULT_MAX_ARTIFACT_FILES,
  DEVICE_SANDBOX_ARTIFACT_STAGING_RESULT_CONTRACT_VERSION,
  DEVICE_SANDBOX_OUTPUT_INGEST_CONTRACT_VERSION,
  createDesktopSandboxOutputIngestService,
};
