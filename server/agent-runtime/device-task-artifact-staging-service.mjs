import crypto from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { link, lstat, mkdir, open, realpath, rm } from "node:fs/promises";
import path from "node:path";
import { MAX_ARTIFACT_BYTES } from "./artifact-ref-contract-v1.mjs";
import { executionTaskError, requiredExecutionTaskDigest, requiredExecutionTaskToken } from "./runtime-task-contract-v1.mjs";
import { DEFAULT_TASK_ARTIFACT_TTL_MS } from "./task-artifact-publication.mjs";

export const DEVICE_TASK_ARTIFACT_STAGING_CONTRACT_VERSION = "device-task-artifact-staging.v1";

const NOFOLLOW = fsConstants.O_NOFOLLOW || 0;
const SHA256 = /^[a-f0-9]{64}$/;

// This is the generic Device-to-Center Artifact data boundary. It owns no
// task, Artifact or object store: after staging a verified private snapshot in
// the canonical task workspace, it delegates publication to taskArtifactService.
export function createDeviceTaskArtifactStagingService({
  now = () => new Date(),
  repository,
  taskArtifactService,
  ttlMs = DEFAULT_TASK_ARTIFACT_TTL_MS,
  workspaceManager,
} = {}) {
  if (typeof repository?.canPublishArtifactWithLease !== "function" ||
    typeof taskArtifactService?.publishOutputArtifact !== "function" ||
    typeof workspaceManager?.workspaceForTask !== "function" || typeof now !== "function" ||
    !Number.isSafeInteger(ttlMs) || ttlMs < 1) {
    throw new TypeError("device task artifact staging dependencies are required");
  }

  async function stage({ artifact = null, source = null, taskIdentity = null, taskOwnership = null } = {}) {
    const identity = normalizeIdentity(taskIdentity, taskOwnership);
    const stagedArtifact = normalizeArtifact(artifact);
    const publicationNow = currentTime(now);
    assertCurrentLease(repository, identity, publicationNow);
    const workspace = await workspaceManager.workspaceForTask(identity.taskId, { create: true });
    const outputRoot = await canonicalDirectory(workspace?.outputRoot);
    const stagingRoot = await privateStagingDirectory(workspace?.workRoot);
    const targetPath = await targetOutputPath(outputRoot, stagedArtifact.relativePath);
    const snapshot = await snapshotSource({ source, stagingRoot, stagedArtifact });
    let linked = false;
    try {
      const existing = await lstat(targetPath).catch(() => null);
      if (existing) {
        if (!await samePublishedFile(targetPath, stagedArtifact)) throw stagingError("artifact_conflict");
      } else {
        await link(snapshot.path, targetPath);
        linked = true;
        // Keep atomic no-overwrite installation, but publish a single-link file.
        // The canonical Artifact publisher correctly rejects hard-link aliases.
        await rm(snapshot.path);
      }
      assertCurrentLease(repository, identity, publicationNow);
      const published = await taskArtifactService.publishOutputArtifact({
        expiresAt: new Date(publicationNow.getTime() + ttlMs).toISOString(),
        fencingToken: identity.fencingToken,
        leaseId: identity.leaseId,
        now: publicationNow,
        relativePath: stagedArtifact.relativePath,
        taskId: identity.taskId,
        tenantScope: identity.tenantScope,
        workerIdDigest: identity.workerIdDigest,
      });
      const publicArtifact = published?.artifact;
      if (!publicArtifact || publicArtifact.fileName !== stagedArtifact.fileName ||
        publicArtifact.sha256 !== stagedArtifact.sha256 || publicArtifact.sizeBytes !== stagedArtifact.sizeBytes) {
        throw stagingError("artifact_publication_invalid");
      }
      return Object.freeze({
        artifact: Object.freeze({
          fileName: publicArtifact.fileName,
          sha256: publicArtifact.sha256,
          sizeBytes: publicArtifact.sizeBytes,
        }),
        contractVersion: DEVICE_TASK_ARTIFACT_STAGING_CONTRACT_VERSION,
        status: "staged",
      });
    } catch (error) {
      if (linked) await rm(targetPath, { force: true }).catch(() => {});
      throw error;
    } finally {
      await rm(snapshot.path, { force: true }).catch(() => {});
    }
  }

  return Object.freeze({ stage });
}

function normalizeIdentity(taskIdentity, taskOwnership) {
  if (!plainObject(taskIdentity, ["taskId", "tenantScope"]) || !plainObject(taskOwnership, ["fencingToken", "leaseId", "workerIdDigest"])) {
    throw stagingError("identity_invalid");
  }
  const fencingToken = Number(taskOwnership.fencingToken);
  if (!Number.isSafeInteger(fencingToken) || fencingToken < 1) throw stagingError("identity_invalid");
  return Object.freeze({
    fencingToken,
    leaseId: requiredExecutionTaskToken(taskOwnership.leaseId, "leaseId", 160),
    taskId: requiredExecutionTaskToken(taskIdentity.taskId, "taskId", 128),
    tenantScope: requiredExecutionTaskToken(taskIdentity.tenantScope, "tenantScope", 160),
    workerIdDigest: requiredExecutionTaskDigest(taskOwnership.workerIdDigest, "workerIdDigest"),
  });
}

function normalizeArtifact(value) {
  if (!plainObject(value, ["relativePath", "sha256", "sizeBytes"])) throw stagingError("artifact_invalid");
  const relativePath = String(value.relativePath || "").normalize("NFC");
  const parts = relativePath.split("/");
  const sha256 = String(value.sha256 || "").trim().toLowerCase();
  const sizeBytes = Number(value.sizeBytes);
  if (!relativePath || relativePath.includes("\\") || path.isAbsolute(relativePath) ||
    parts.some((part) => !part || part === "." || part === "..") ||
    !SHA256.test(sha256) || !Number.isSafeInteger(sizeBytes) || sizeBytes < 1 || sizeBytes > MAX_ARTIFACT_BYTES ||
    parts.some((part) => !safeFileName(part))) {
    throw stagingError("artifact_invalid");
  }
  const fileName = path.posix.basename(relativePath);
  return Object.freeze({ fileName, relativePath, sha256, sizeBytes });
}

function assertCurrentLease(repository, identity, now) {
  const current = repository.canPublishArtifactWithLease({ ...identity, now: now.toISOString() });
  if (!current) throw stagingError("not_owned");
}

function currentTime(clock) {
  const value = new Date(clock());
  if (!Number.isFinite(value.getTime())) throw stagingError("clock_invalid");
  return value;
}

async function canonicalDirectory(value) {
  const directory = String(value || "");
  if (!path.isAbsolute(directory)) throw stagingError("workspace_invalid");
  const metadata = await lstat(directory).catch(() => null);
  if (!metadata?.isDirectory() || metadata.isSymbolicLink()) throw stagingError("workspace_invalid");
  return realpath(directory);
}

async function privateStagingDirectory(workRoot) {
  const root = await canonicalDirectory(workRoot);
  const candidate = path.join(root, ".device-artifact-staging");
  await mkdir(candidate, { recursive: true, mode: 0o700 });
  const resolved = await canonicalDirectory(candidate);
  if (resolved !== candidate) throw stagingError("workspace_invalid");
  return resolved;
}

async function targetOutputPath(outputRoot, relativePath) {
  let current = outputRoot;
  const parts = relativePath.split("/");
  for (const part of parts.slice(0, -1)) {
    current = path.join(current, part);
    const existing = await lstat(current).catch(() => null);
    if (existing) {
      if (!existing.isDirectory() || existing.isSymbolicLink()) throw stagingError("artifact_path_invalid");
      continue;
    }
    await mkdir(current, { mode: 0o700 });
  }
  const target = path.join(current, parts.at(-1));
  if (!within(outputRoot, target)) throw stagingError("artifact_path_invalid");
  return target;
}

async function snapshotSource({ source, stagingRoot, stagedArtifact }) {
  if (!source || typeof source[Symbol.asyncIterator] !== "function") throw stagingError("source_invalid");
  const snapshotPath = path.join(stagingRoot, `.${crypto.randomUUID()}.part`);
  let handle = null;
  let committed = false;
  try {
    handle = await open(snapshotPath, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | NOFOLLOW, 0o600);
    const digest = crypto.createHash("sha256");
    let sizeBytes = 0;
    for await (const value of source) {
      const chunk = Buffer.from(value || []);
      if (!chunk.length) continue;
      sizeBytes += chunk.length;
      if (sizeBytes > stagedArtifact.sizeBytes || sizeBytes > MAX_ARTIFACT_BYTES) throw stagingError("source_size_invalid");
      digest.update(chunk);
      await writeAll(handle, chunk);
    }
    if (sizeBytes !== stagedArtifact.sizeBytes || digest.digest("hex") !== stagedArtifact.sha256) throw stagingError("source_digest_invalid");
    await handle.sync();
    await handle.close();
    handle = null;
    const metadata = await lstat(snapshotPath);
    if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.nlink !== 1 || metadata.size !== sizeBytes) {
      throw stagingError("source_invalid");
    }
    committed = true;
    return Object.freeze({ path: snapshotPath });
  } finally {
    await handle?.close().catch(() => {});
    if (!committed) await rm(snapshotPath, { force: true }).catch(() => {});
  }
}

async function samePublishedFile(filePath, artifact) {
  const metadata = await lstat(filePath).catch(() => null);
  if (!metadata?.isFile() || metadata.isSymbolicLink() || metadata.nlink !== 1 || metadata.size !== artifact.sizeBytes) return false;
  let handle = null;
  try {
    handle = await open(filePath, fsConstants.O_RDONLY | NOFOLLOW);
    const digest = crypto.createHash("sha256");
    const buffer = Buffer.allocUnsafe(64 * 1024);
    let position = 0;
    while (true) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, position);
      if (!bytesRead) break;
      digest.update(buffer.subarray(0, bytesRead));
      position += bytesRead;
    }
    return digest.digest("hex") === artifact.sha256;
  } finally {
    await handle?.close().catch(() => {});
  }
}

async function writeAll(handle, chunk) {
  let offset = 0;
  while (offset < chunk.length) {
    const { bytesWritten } = await handle.write(chunk, offset, chunk.length - offset, null);
    if (!bytesWritten) throw stagingError("source_invalid");
    offset += bytesWritten;
  }
}

function safeFileName(value) {
  return Boolean(value && value.length <= 255 && value !== "." && value !== ".." &&
    !/[\0-\x1f\x7f<>:"|?*\u202a-\u202e\u2066-\u2069]/u.test(value) && !value.endsWith(".") && !value.endsWith(" "));
}

function within(root, candidate) {
  const relative = path.relative(root, candidate);
  return Boolean(relative && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function plainObject(value, fields) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype &&
    Object.keys(value).length === fields.length && fields.every((field) => Object.hasOwn(value, field)));
}

function stagingError(code) {
  return executionTaskError(`device_task_artifact_staging_${code}`, "device task Artifact staging is unavailable");
}
