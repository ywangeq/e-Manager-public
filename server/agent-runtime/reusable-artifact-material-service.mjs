import crypto from "node:crypto";
import fs from "node:fs";
import { lstat, open, rename, rm } from "node:fs/promises";
import path from "node:path";
import { safeCanonicalFileName } from "./canonical-input-types.mjs";
import {
  executionTaskError,
  requiredExecutionTaskDigest,
  requiredExecutionTaskToken,
} from "./runtime-task-contract-v1.mjs";

export const REUSABLE_ARTIFACT_MATERIAL_ADAPTER_ID = "reusable-artifact-library.v1";
export const REUSABLE_ARTIFACT_MATERIAL_PAYLOAD_VERSION = "reusable-artifact-material-payload.v1";

export function createReusableArtifactMaterialService({ taskArtifactService, workspaceManager } = {}) {
  if (!taskArtifactService?.saveReusableArtifact || !taskArtifactService?.listReusableArtifacts ||
    !taskArtifactService?.resolveReusableArtifact) {
    throw new TypeError("reusable Artifact material service requires the canonical task Artifact service");
  }
  if (!workspaceManager?.workspaceForTask || !workspaceManager?.createTaskInputDirectory) {
    throw new TypeError("reusable Artifact material service requires the canonical task workspace manager");
  }

  async function savePersonal(input = {}) {
    const record = await taskArtifactService.saveReusableArtifact(input);
    return publicReusableArtifact(record);
  }

  function listPersonal(input = {}) {
    return taskArtifactService.listReusableArtifacts(input).map(record => publicReusableArtifact(record, input.includeSource === true));
  }

  async function materialBindingDescriptorForGrant({
    tenantScope,
    actorIssuer,
    actorSubjectDigest,
    grantId,
  } = {}) {
    const resolved = await taskArtifactService.resolveReusableArtifact({
      tenantScope,
      actorIssuer,
      actorSubjectDigest,
      grantId,
    });
    try {
      return Object.freeze({
        contractVersion: "task-material-binding-descriptor.v1",
        adapterId: REUSABLE_ARTIFACT_MATERIAL_ADAPTER_ID,
        sourceKind: "reusable_artifact_grant",
        sourceIdentityDigest: reusableArtifactSourceDigest(resolved.grant),
        expiresAt: resolved.grant.expiresAt,
        payload: Object.freeze({
          contractVersion: REUSABLE_ARTIFACT_MATERIAL_PAYLOAD_VERSION,
          grantId: resolved.grant.grantId,
        }),
      });
    } finally {
      await resolved.handle.close().catch(() => {});
    }
  }

  async function recoverBoundMaterial({ binding, taskId = "" } = {}) {
    const normalized = normalizeReusableArtifactBinding(binding, taskId);
    const resolved = await taskArtifactService.resolveReusableArtifact({
      tenantScope: normalized.tenantScope,
      actorIssuer: normalized.actorIssuer,
      actorSubjectDigest: normalized.actorSubjectDigest,
      grantId: normalized.grantId,
    });
    try {
      if (resolved.grant.expiresAt !== normalized.expiresAt ||
        reusableArtifactSourceDigest(resolved.grant) !== normalized.sourceIdentityDigest) {
        throw executionTaskError("reusable_artifact_binding_mismatch", "reusable Artifact binding no longer matches authority");
      }
      const workspace = await workspaceManager.workspaceForTask(normalized.taskId, { create: true });
      const inputRoot = await workspaceManager.createTaskInputDirectory(
        normalized.taskId,
        `reusable-source:${resolved.grant.grantId}`,
      );
      const fileName = safeCanonicalFileName(resolved.artifact.fileName, resolved.artifact.mimeType);
      const filePath = path.join(inputRoot, fileName);
      await copyVerifiedArtifact({
        sourceHandle: resolved.handle,
        targetPath: filePath,
        expectedSha256: resolved.artifact.sha256,
        expectedSizeBytes: resolved.artifact.sizeBytes,
      });
      return Object.freeze({
        contractVersion: "reusable-artifact-material-claim.v1",
        expiresAt: resolved.grant.expiresAt,
        items: Object.freeze([Object.freeze({
          contentDigest: resolved.artifact.sha256,
          inputId: `reusable-${resolved.grant.grantId.slice(-24)}`,
          fileName,
          filePath,
          mimeType: resolved.artifact.mimeType,
          sizeBytes: resolved.artifact.sizeBytes,
          sourceRef: resolved.grant.grantId,
        })]),
        workspace,
        workspaceManager,
        workspaceTaskId: normalized.taskId,
      });
    } finally {
      await resolved.handle.close().catch(() => {});
    }
  }

  return Object.freeze({
    listPersonal,
    materialBindingDescriptorForGrant,
    recoverBoundMaterial,
    savePersonal,
  });
}

function normalizeReusableArtifactBinding(value, taskId) {
  const safeTaskId = requiredExecutionTaskToken(taskId, "taskId", 128);
  if (value?.contractVersion !== "task-material-binding.v1" ||
    value.sourceKind !== "reusable_artifact_grant" ||
    value.adapterId !== REUSABLE_ARTIFACT_MATERIAL_ADAPTER_ID ||
    value.taskId !== safeTaskId ||
    !plainObjectWithFields(value.payload, ["contractVersion", "grantId"]) ||
    value.payload.contractVersion !== REUSABLE_ARTIFACT_MATERIAL_PAYLOAD_VERSION) {
    throw executionTaskError("reusable_artifact_binding_invalid", "reusable Artifact binding is invalid");
  }
  return Object.freeze({
    taskId: safeTaskId,
    tenantScope: requiredExecutionTaskToken(value.tenantScope, "tenantScope", 160),
    actorIssuer: requiredExecutionTaskToken(value.actorIssuer, "actorIssuer", 160),
    actorSubjectDigest: requiredExecutionTaskDigest(value.actorSubjectDigest, "actorSubjectDigest"),
    grantId: requiredExecutionTaskToken(value.payload.grantId, "grantId", 160),
    sourceIdentityDigest: requiredExecutionTaskDigest(value.sourceIdentityDigest, "sourceIdentityDigest"),
    expiresAt: normalizedTimestamp(value.expiresAt),
  });
}

async function copyVerifiedArtifact({ sourceHandle, targetPath, expectedSha256, expectedSizeBytes }) {
  const directory = path.dirname(targetPath);
  const temporaryPath = path.join(directory, `.${path.basename(targetPath)}.${crypto.randomUUID()}.tmp`);
  let targetHandle = null;
  let committed = false;
  try {
    const sourceBefore = await sourceHandle.stat();
    if (!sourceBefore.isFile() || sourceBefore.isSymbolicLink?.() || sourceBefore.nlink !== 1 ||
      sourceBefore.size !== expectedSizeBytes) {
      throw executionTaskError("reusable_artifact_integrity_invalid", "reusable Artifact source identity is invalid");
    }
    targetHandle = await open(temporaryPath, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_RDWR, 0o600);
    const digest = crypto.createHash("sha256");
    const buffer = Buffer.allocUnsafe(1024 * 1024);
    let position = 0;
    while (position < expectedSizeBytes) {
      const { bytesRead } = await sourceHandle.read(
        buffer,
        0,
        Math.min(buffer.length, expectedSizeBytes - position),
        position,
      );
      if (!bytesRead) throw executionTaskError("reusable_artifact_integrity_invalid", "reusable Artifact ended during task mount");
      let written = 0;
      while (written < bytesRead) {
        const result = await targetHandle.write(buffer, written, bytesRead - written, position + written);
        if (!result.bytesWritten) {
          throw executionTaskError("reusable_artifact_mount_failed", "reusable Artifact task mount made no progress");
        }
        written += result.bytesWritten;
      }
      digest.update(buffer.subarray(0, bytesRead));
      position += bytesRead;
    }
    const sourceAfter = await sourceHandle.stat();
    if (digest.digest("hex") !== expectedSha256 || position !== expectedSizeBytes ||
      sourceAfter.dev !== sourceBefore.dev || sourceAfter.ino !== sourceBefore.ino ||
      sourceAfter.size !== sourceBefore.size || sourceAfter.nlink !== sourceBefore.nlink) {
      throw executionTaskError("reusable_artifact_integrity_invalid", "reusable Artifact changed during task mount");
    }
    await targetHandle.truncate(position);
    await targetHandle.sync();
    const targetDigest = await hashOpenFile(targetHandle);
    if (targetDigest.sha256 !== expectedSha256 || targetDigest.sizeBytes !== expectedSizeBytes) {
      throw executionTaskError("reusable_artifact_integrity_invalid", "reusable Artifact task mount failed verification");
    }
    await targetHandle.close();
    targetHandle = null;
    await rename(temporaryPath, targetPath);
    committed = true;
    const directoryHandle = await open(directory, fs.constants.O_RDONLY);
    try {
      await directoryHandle.sync();
    } finally {
      await directoryHandle.close().catch(() => {});
    }
    const metadata = await lstat(targetPath);
    if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.nlink !== 1 || metadata.size !== expectedSizeBytes) {
      throw executionTaskError("reusable_artifact_integrity_invalid", "reusable Artifact task mount is invalid");
    }
  } catch (error) {
    if (committed) await rm(targetPath, { force: true }).catch(() => {});
    throw error;
  } finally {
    await targetHandle?.close().catch(() => {});
    await rm(temporaryPath, { force: true }).catch(() => {});
  }
}

async function hashOpenFile(handle) {
  const metadata = await handle.stat();
  const digest = crypto.createHash("sha256");
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  let position = 0;
  while (position < metadata.size) {
    const { bytesRead } = await handle.read(buffer, 0, Math.min(buffer.length, metadata.size - position), position);
    if (!bytesRead) throw executionTaskError("reusable_artifact_integrity_invalid", "mounted reusable Artifact ended during verification");
    digest.update(buffer.subarray(0, bytesRead));
    position += bytesRead;
  }
  return Object.freeze({ sha256: digest.digest("hex"), sizeBytes: position });
}

function publicReusableArtifact(record, includeSource = false) {
  return Object.freeze({
    contractVersion: includeSource ? "reusable-artifact-material.v2" : "reusable-artifact-material.v1",
    ...(includeSource ? { source: { employeeId: record.artifact.employeeId, taskId: record.grant.sourceTaskId, artifactId: record.artifact.artifactId } } : {}),
    grantId: record.grant.grantId,
    scopeType: record.grant.scopeType,
    fileName: record.artifact.fileName,
    mimeType: record.artifact.mimeType,
    sizeBytes: record.artifact.sizeBytes,
    createdAt: record.grant.createdAt,
    expiresAt: record.grant.expiresAt,
    availabilityStatus: "available",
  });
}

function reusableArtifactSourceDigest(grant) {
  return crypto.createHash("sha256").update(JSON.stringify([
    REUSABLE_ARTIFACT_MATERIAL_ADAPTER_ID,
    grant.tenantScope,
    grant.actorIssuer,
    grant.actorSubjectDigest,
    grant.grantId,
    grant.artifactId,
  ])).digest("hex");
}

function plainObjectWithFields(value, fields) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype &&
    Object.keys(value).every((field) => fields.includes(field)) &&
    fields.every((field) => Object.hasOwn(value, field)));
}

function normalizedTimestamp(value) {
  const timestamp = new Date(value);
  if (!value || !Number.isFinite(timestamp.getTime())) {
    throw executionTaskError("reusable_artifact_binding_invalid", "reusable Artifact binding expiry is invalid");
  }
  return timestamp.toISOString();
}
