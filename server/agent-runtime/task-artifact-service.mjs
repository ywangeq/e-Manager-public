import crypto from "node:crypto";
import fs from "node:fs";
import { lstat, mkdir, open, realpath, rename, rm } from "node:fs/promises";
import path from "node:path";
import {
  ARTIFACT_REF_CONTRACT_VERSION,
  MAX_ARTIFACT_BYTES,
  MAX_ARTIFACT_TTL_MS,
  normalizeArtifactRef,
} from "./artifact-ref-contract-v1.mjs";
import {
  createReusableArtifactGrant,
  REUSABLE_ARTIFACT_GRANT_TTL_MS,
} from "./reusable-artifact-grant-contract-v1.mjs";
import {
  executionTaskError,
  normalizedExecutionTaskNow,
  requiredExecutionTaskDigest,
  requiredExecutionTaskToken,
} from "./runtime-task-contract-v1.mjs";

const MIME_TYPES = new Map([
  [".csv", "text/csv"],
  [".html", "text/html"],
  [".json", "application/json"],
  [".md", "text/markdown"],
  [".pdf", "application/pdf"],
  [".txt", "text/plain"],
  [".zip", "application/zip"],
]);
const ARTIFACT_OBJECT_LOCKS = new Map();

export function createTaskArtifactService({ objectRoot, repository, workspaceManager, clock = () => new Date() } = {}) {
  const safeObjectRoot = requiredAbsoluteRoot(objectRoot);
  if (!repository?.canPublishArtifactWithLease || !repository?.publishArtifactWithLease ||
    !repository?.readArtifactForDownload || !repository?.isArtifactObjectReferenced ||
    !repository?.saveReusableArtifactGrant || !repository?.listReusableArtifactGrants ||
    !repository?.readReusableArtifactGrant || !repository?.retireExpiredArtifactAuthorities ||
    !repository?.listArtifactObjectCleanupCandidates || !repository?.readArtifactObjectCleanupCandidate ||
    !repository?.beginArtifactObjectCleanup || !repository?.markArtifactObjectReconcileRequired ||
    !repository?.finalizeArtifactObjectCleanup) {
    throw new TypeError("task artifact service requires the canonical execution-task repository");
  }
  if (typeof workspaceManager?.workspaceForTask !== "function") {
    throw new TypeError("task artifact service requires the canonical task workspace manager");
  }
  if (typeof clock !== "function") throw new TypeError("task artifact service clock must be a function");

  async function publishOutputArtifact({
    relativePath,
    tenantScope,
    taskId,
    leaseId,
    workerIdDigest,
    fencingToken,
    expiresAt,
    now = new Date(),
  } = {}) {
    const identity = {
      tenantScope: requiredExecutionTaskToken(tenantScope, "tenantScope", 160),
      taskId: requiredExecutionTaskToken(taskId, "taskId", 128),
      leaseId: requiredExecutionTaskToken(leaseId, "leaseId", 160),
      workerIdDigest: requiredExecutionTaskDigest(workerIdDigest, "workerIdDigest"),
      fencingToken: requiredPositiveInteger(fencingToken, "fencingToken"),
    };
    const createdAt = normalizedExecutionTaskNow(now);
    const safeExpiresAt = normalizedExecutionTaskNow(expiresAt);
    assertPublicationWindow(createdAt, safeExpiresAt);
    const task = repository.canPublishArtifactWithLease({ ...identity, now: createdAt });
    if (!task) throw executionTaskError("artifact_publish_not_owned", "artifact publication requires the current task lease");
    const workspace = await workspaceManager.workspaceForTask(identity.taskId, { create: false });
    const source = await openCanonicalOutputFile(workspace, identity.taskId, relativePath);
    let snapshot = null;
    let releaseObjectLock = null;
    try {
      const sourceDigest = await hashOpenFile(source.handle, {
        expectedMetadata: source.metadata,
        rejectHardLinks: true,
      });
      releaseObjectLock = await acquireArtifactObjectLock({
        objectRoot: safeObjectRoot,
        tenantScope: identity.tenantScope,
        sha256: sourceDigest.sha256,
      });
      snapshot = await snapshotArtifactObject({
        sourceHandle: source.handle,
        sourceMetadata: source.metadata,
        objectRoot: safeObjectRoot,
        tenantScope: identity.tenantScope,
        expectedDigest: sourceDigest,
      });
      const artifactId = artifactIdentity({
        tenantScope: identity.tenantScope,
        taskId: identity.taskId,
        relativePath: source.relativePath,
        sha256: snapshot.sha256,
      });
      const artifact = normalizeArtifactRef({
        artifactId,
        contractVersion: ARTIFACT_REF_CONTRACT_VERSION,
        taskId: identity.taskId,
        employeeId: task.employeeId,
        fileName: source.fileName,
        mimeType: MIME_TYPES.get(path.extname(source.fileName).toLowerCase()) || "application/octet-stream",
        sizeBytes: snapshot.sizeBytes,
        sha256: snapshot.sha256,
        createdAt,
        expiresAt: safeExpiresAt,
        visibilityScope: "task_submitter",
      });
      const commitAt = normalizedExecutionTaskNow(clock());
      assertPublicationWindow(commitAt, safeExpiresAt);
      const published = repository.publishArtifactWithLease({
        ...identity,
        artifact,
        objectCreated: snapshot.created,
        objectSha256: snapshot.sha256,
        now: commitAt,
      });
      if (!published) {
        throw executionTaskError("artifact_publish_not_owned", "artifact publication requires the current task lease");
      }
      return published;
    } catch (error) {
      if (snapshot?.created && !repository.isArtifactObjectReferenced({
        tenantScope: identity.tenantScope,
        objectSha256: snapshot.sha256,
        now: clock(),
      })) {
        await rm(snapshot.filePath, { force: true }).catch(() => {});
      }
      throw error;
    } finally {
      await releaseObjectLock?.();
      await source.handle.close().catch(() => {});
    }
  }

  async function resolveDownload({
    tenantScope,
    taskId,
    artifactId,
    actorIssuer,
    actorSubjectDigest,
    employeeId,
  } = {}, { authorizeFailedOutput = null } = {}) {
    if (authorizeFailedOutput !== null && typeof authorizeFailedOutput !== "function") throw new TypeError("artifact failed-output policy must be a server function");
    const safeTenantScope = requiredExecutionTaskToken(tenantScope, "tenantScope", 160);
    const lookup = {
      tenantScope: safeTenantScope,
      taskId: requiredExecutionTaskToken(taskId, "taskId", 128),
      artifactId: requiredExecutionTaskToken(artifactId, "artifactId", 160),
      actorIssuer: requiredExecutionTaskToken(actorIssuer, "actorIssuer", 160),
      actorSubjectDigest: requiredExecutionTaskDigest(actorSubjectDigest, "actorSubjectDigest"),
      employeeId: requiredExecutionTaskToken(employeeId, "employeeId", 160),
    };
    const initial = repository.readArtifactForDownload(lookup);
    if (!initial) throw executionTaskError("artifact_not_found", "artifact is unavailable");
    const releaseObjectLock = await acquireArtifactObjectLock({
      objectRoot: safeObjectRoot,
      tenantScope: safeTenantScope,
      sha256: initial.objectSha256,
    });
    let handle = null;
    try {
      const record = repository.readArtifactForDownload(lookup);
      if (!record || record.objectSha256 !== initial.objectSha256) {
        throw executionTaskError("artifact_not_found", "artifact is unavailable");
      }
      const nowIso = normalizedExecutionTaskNow(clock());
      if (record.taskStatus !== "completed") {
        // Explicit server capability; ordinary downloads/grants remain completed-only.
        // Group rejected-opinion reads are the sole caller of this narrow hook.
        let decision = false;
        if (record.taskStatus === "failed" && authorizeFailedOutput) {
          try { decision = authorizeFailedOutput(record); } catch { decision = false; }
          if (decision && typeof decision.then === "function") Promise.resolve(decision).catch(() => {});
        }
        if (decision !== true) throw executionTaskError("artifact_task_not_completed", "artifact task is not completed");
      }
      if (record.retiredAt || nowIso >= record.artifact.expiresAt) {
        throw executionTaskError("artifact_expired", "artifact has expired");
      }
      if (record.objectState !== "present" || record.objectSizeBytes !== record.artifact.sizeBytes) {
        throw executionTaskError("artifact_object_integrity_invalid", "artifact object authority failed integrity verification");
      }
      const filePath = objectPath(safeObjectRoot, safeTenantScope, record.objectSha256);
      handle = await openReadOnlyNoFollow(filePath, "artifact_object_integrity_invalid");
      const verified = await hashOpenFile(handle, { rejectHardLinks: true });
      if (verified.sha256 !== record.artifact.sha256 || verified.sizeBytes !== record.artifact.sizeBytes) {
        throw executionTaskError("artifact_object_integrity_invalid", "artifact object failed integrity verification");
      }
      const controlledHandle = controlledArtifactHandle(handle, releaseObjectLock);
      handle = null;
      return Object.freeze({ artifact: record.artifact, handle: controlledHandle, taskContext: record.taskContext });
    } catch (error) {
      await handle?.close().catch(() => {});
      await releaseObjectLock();
      throw error;
    }
  }

  async function saveReusableArtifact({
    tenantScope,
    taskId,
    artifactId,
    actorIssuer,
    actorSubjectDigest,
    employeeId,
  } = {}) {
    const resolved = await resolveDownload({
      tenantScope,
      taskId,
      artifactId,
      actorIssuer,
      actorSubjectDigest,
      employeeId,
    });
    await resolved.handle.close().catch(() => {});
    const createdAt = normalizedExecutionTaskNow(clock());
    const grant = createReusableArtifactGrant({
      tenantScope,
      actorIssuer,
      actorSubjectDigest,
      sourceTaskId: taskId,
      artifactId,
      createdAt,
      expiresAt: new Date(Date.parse(createdAt) + REUSABLE_ARTIFACT_GRANT_TTL_MS),
    });
    return repository.saveReusableArtifactGrant({ grant, now: createdAt });
  }

  function listReusableArtifacts({ tenantScope, actorIssuer, actorSubjectDigest, limit = 50 } = {}) {
    return repository.listReusableArtifactGrants({
      tenantScope,
      actorIssuer,
      actorSubjectDigest,
      limit,
      now: normalizedExecutionTaskNow(clock()),
    });
  }

  async function resolveReusableArtifact({ tenantScope, actorIssuer, actorSubjectDigest, grantId } = {}) {
    const safeTenantScope = requiredExecutionTaskToken(tenantScope, "tenantScope", 160);
    const lookup = {
      tenantScope: safeTenantScope,
      actorIssuer: requiredExecutionTaskToken(actorIssuer, "actorIssuer", 160),
      actorSubjectDigest: requiredExecutionTaskDigest(actorSubjectDigest, "actorSubjectDigest"),
      grantId: requiredExecutionTaskToken(grantId, "grantId", 160),
      now: normalizedExecutionTaskNow(clock()),
    };
    const initial = repository.readReusableArtifactGrant(lookup);
    if (!initial) throw executionTaskError("reusable_artifact_not_found", "reusable Artifact is unavailable");
    const releaseObjectLock = await acquireArtifactObjectLock({
      objectRoot: safeObjectRoot,
      tenantScope: safeTenantScope,
      sha256: initial.objectSha256,
    });
    let handle = null;
    try {
      const record = repository.readReusableArtifactGrant({ ...lookup, now: normalizedExecutionTaskNow(clock()) });
      if (!record || record.objectSha256 !== initial.objectSha256) {
        throw executionTaskError("reusable_artifact_not_found", "reusable Artifact is unavailable");
      }
      if (record.objectState !== "present" || record.objectSizeBytes !== record.artifact.sizeBytes) {
        throw executionTaskError("reusable_artifact_integrity_invalid", "reusable Artifact authority failed integrity verification");
      }
      const filePath = objectPath(safeObjectRoot, safeTenantScope, record.objectSha256);
      handle = await openReadOnlyNoFollow(filePath, "reusable_artifact_integrity_invalid");
      const verified = await hashOpenFile(handle, { rejectHardLinks: true });
      if (verified.sha256 !== record.artifact.sha256 || verified.sizeBytes !== record.artifact.sizeBytes) {
        throw executionTaskError("reusable_artifact_integrity_invalid", "reusable Artifact failed integrity verification");
      }
      const controlledHandle = controlledArtifactHandle(handle, releaseObjectLock);
      handle = null;
      return Object.freeze({ artifact: record.artifact, grant: record.grant, handle: controlledHandle });
    } catch (error) {
      await handle?.close().catch(() => {});
      await releaseObjectLock();
      throw error;
    }
  }

  async function cleanupExpiredArtifacts({ now = clock(), limit = 100, reasonCode = "scheduled_ttl" } = {}) {
    const startedAt = normalizedExecutionTaskNow(now);
    const safeLimit = boundedCleanupLimit(limit);
    const safeReasonCode = cleanupReasonCode(reasonCode);
    let authorities;
    try {
      authorities = repository.retireExpiredArtifactAuthorities({ now: startedAt, limit: safeLimit });
    } catch {
      return cleanupSummary({
        authorities: { artifactsRetired: 0, grantsDeleted: 0, integrityBlocked: 0 },
        complete: false,
        completedAt: normalizedExecutionTaskNow(clock()),
        objects: { alreadyClean: 0, deferred: 0, deleted: 0, examined: 0, failedSafe: 0 },
        reasonCode: safeReasonCode,
        startedAt,
        status: "authority_failed_safe",
      });
    }
    const objects = { alreadyClean: 0, deferred: 0, deleted: 0, examined: 0, failedSafe: 0 };
    const candidates = repository.listArtifactObjectCleanupCandidates({ limit: safeLimit });
    for (const candidate of candidates) {
      objects.examined += 1;
      const outcome = await cleanupArtifactObject({
        candidate,
        objectRoot: safeObjectRoot,
        repository,
        clock,
      });
      objects[outcome] += 1;
    }
    const complete = authorities.integrityBlocked === 0 && objects.failedSafe === 0;
    return cleanupSummary({
      authorities,
      complete,
      completedAt: normalizedExecutionTaskNow(clock()),
      objects,
      reasonCode: safeReasonCode,
      startedAt,
      status: complete ? (objects.examined ? "complete" : "no_candidates") : "incomplete",
    });
  }

  return Object.freeze({
    cleanupExpiredArtifacts,
    listReusableArtifacts,
    publishOutputArtifact,
    resolveDownload,
    resolveReusableArtifact,
    saveReusableArtifact,
  });
}

async function openCanonicalOutputFile(workspace, taskId, value) {
  if (workspace?.contractVersion !== "agent-task-workspace.v2" || workspace?.ownerType !== "execution_task" ||
    workspace?.ownerId !== taskId) {
    throw executionTaskError("artifact_source_rejected", "artifact source requires the canonical task workspace");
  }
  const workspaceRoot = requiredAbsoluteRoot(workspace.root);
  const outputRoot = requiredAbsoluteRoot(workspace.outputRoot);
  const relativePath = String(value || "").normalize("NFC");
  if (!relativePath || relativePath.includes("\\") || path.isAbsolute(relativePath) ||
    relativePath.split("/").some((part) => !part || part === "." || part === "..")) {
    throw executionTaskError("artifact_source_rejected", "artifact source must be an output-relative file");
  }
  const resolvedWorkspaceRoot = await realpath(workspaceRoot).catch(() => null);
  const resolvedOutputRoot = await realpath(outputRoot).catch(() => null);
  const outputRootMetadata = await lstat(outputRoot).catch(() => null);
  if (!resolvedWorkspaceRoot || !resolvedOutputRoot || resolvedOutputRoot !== path.join(resolvedWorkspaceRoot, "output")) {
    throw executionTaskError("artifact_source_rejected", "artifact output root is not canonical");
  }
  if (!outputRootMetadata?.isDirectory() || outputRootMetadata.isSymbolicLink()) {
    throw executionTaskError("artifact_source_rejected", "artifact output root must be a real directory");
  }
  const candidate = path.resolve(resolvedOutputRoot, relativePath);
  if (!isWithin(resolvedOutputRoot, candidate)) {
    throw executionTaskError("artifact_source_rejected", "artifact source escapes output");
  }
  let current = resolvedOutputRoot;
  for (const segment of relativePath.split("/")) {
    current = path.join(current, segment);
    const metadata = await lstat(current).catch(() => null);
    if (!metadata || metadata.isSymbolicLink()) {
      throw executionTaskError("artifact_source_rejected", "artifact source contains a link or is missing");
    }
  }
  const handle = await openReadOnlyNoFollow(candidate, "artifact_source_rejected");
  try {
    const metadata = await handle.stat();
    if (!metadata.isFile() || metadata.nlink !== 1 || metadata.size <= 0 || metadata.size > MAX_ARTIFACT_BYTES) {
      throw executionTaskError("artifact_source_rejected", "artifact source must be a private bounded regular file");
    }
    const openedPath = await realpath(candidate).catch(() => null);
    const openedMetadata = await lstat(candidate).catch(() => null);
    if (!openedPath || !openedMetadata || !isWithin(resolvedOutputRoot, openedPath) ||
      openedMetadata.dev !== metadata.dev || openedMetadata.ino !== metadata.ino ||
      openedMetadata.size !== metadata.size || openedMetadata.nlink !== metadata.nlink) {
      throw executionTaskError("artifact_source_rejected", "opened artifact source escapes output");
    }
    return Object.freeze({
      fileName: path.basename(candidate),
      handle,
      metadata,
      relativePath,
    });
  } catch (error) {
    await handle.close().catch(() => {});
    throw error;
  }
}

async function snapshotArtifactObject({
  sourceHandle,
  sourceMetadata,
  objectRoot,
  tenantScope,
  expectedDigest,
}) {
  const before = await hashOpenFile(sourceHandle, { expectedMetadata: sourceMetadata, rejectHardLinks: true });
  if (before.sha256 !== expectedDigest.sha256 || before.sizeBytes !== expectedDigest.sizeBytes) {
    throw executionTaskError("artifact_source_changed", "artifact source changed before publication lock");
  }
  const target = objectPath(objectRoot, tenantScope, before.sha256);
  const directory = path.dirname(target);
  await ensurePrivateArtifactDirectory(objectRoot, directory);
  const existing = await lstat(target).catch(() => null);
  if (existing) {
    if (!existing.isFile() || existing.isSymbolicLink()) {
      throw executionTaskError("artifact_object_conflict", "artifact object target is invalid");
    }
    const targetHandle = await openReadOnlyNoFollow(target, "artifact_object_integrity_invalid");
    try {
      const current = await hashOpenFile(targetHandle, { rejectHardLinks: true });
      if (current.sha256 !== before.sha256 || current.sizeBytes !== before.sizeBytes) {
        throw executionTaskError("artifact_object_integrity_invalid", "artifact object failed integrity verification");
      }
    } finally {
      await targetHandle.close().catch(() => {});
    }
    const after = await hashOpenFile(sourceHandle, { expectedMetadata: sourceMetadata, rejectHardLinks: true });
    if (after.sha256 !== before.sha256 || after.sizeBytes !== before.sizeBytes) {
      throw executionTaskError("artifact_source_changed", "artifact source changed during publication");
    }
    return Object.freeze({ ...before, created: false, filePath: target });
  }
  const staging = path.join(directory, `.${before.sha256}.${crypto.randomUUID()}.tmp`);
  let stagingHandle = null;
  try {
    stagingHandle = await open(staging, "wx+", 0o600);
    const copied = await copyOpenFile(sourceHandle, stagingHandle, sourceMetadata);
    const staged = await hashOpenFile(stagingHandle, { rejectHardLinks: true });
    await stagingHandle.sync();
    await stagingHandle.close();
    stagingHandle = null;
    const after = await hashOpenFile(sourceHandle, { expectedMetadata: sourceMetadata, rejectHardLinks: true });
    if (copied.sha256 !== before.sha256 || copied.sizeBytes !== before.sizeBytes ||
      staged.sha256 !== before.sha256 || staged.sizeBytes !== before.sizeBytes ||
      after.sha256 !== before.sha256 || after.sizeBytes !== before.sizeBytes) {
      throw executionTaskError("artifact_source_changed", "artifact source changed during publication");
    }
    await rename(staging, target);
    try {
      await syncArtifactDirectory(directory);
    } catch (error) {
      await rm(target, { force: true }).catch(() => {});
      await syncArtifactDirectory(directory).catch(() => {});
      throw error;
    }
    return Object.freeze({ ...before, created: true, filePath: target });
  } finally {
    await stagingHandle?.close().catch(() => {});
    await rm(staging, { force: true }).catch(() => {});
  }
}

async function copyOpenFile(sourceHandle, targetHandle, expectedMetadata) {
  const digest = crypto.createHash("sha256");
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  let position = 0;
  while (position < expectedMetadata.size) {
    const { bytesRead } = await sourceHandle.read(buffer, 0, Math.min(buffer.length, expectedMetadata.size - position), position);
    if (!bytesRead) throw executionTaskError("artifact_source_changed", "artifact source ended during publication");
    let written = 0;
    while (written < bytesRead) {
      const result = await targetHandle.write(buffer, written, bytesRead - written, position + written);
      if (!result.bytesWritten) {
        throw executionTaskError("artifact_object_write_failed", "artifact object staging write made no progress");
      }
      written += result.bytesWritten;
    }
    digest.update(buffer.subarray(0, bytesRead));
    position += bytesRead;
  }
  await targetHandle.truncate(position);
  return Object.freeze({ sha256: digest.digest("hex"), sizeBytes: position });
}

async function acquireArtifactObjectLock({ objectRoot, tenantScope, sha256 }) {
  const lockKey = `${requiredAbsoluteRoot(objectRoot)}\0${tenantScope}\0${sha256}`;
  const prior = ARTIFACT_OBJECT_LOCKS.get(lockKey) || Promise.resolve();
  let unlock;
  const current = new Promise((resolve) => { unlock = resolve; });
  const tail = prior.then(() => current);
  ARTIFACT_OBJECT_LOCKS.set(lockKey, tail);
  await prior;
  let released = false;
  return async () => {
    if (released) return;
    released = true;
    unlock();
    if (ARTIFACT_OBJECT_LOCKS.get(lockKey) === tail) ARTIFACT_OBJECT_LOCKS.delete(lockKey);
  };
}

function controlledArtifactHandle(handle, releaseObjectLock) {
  let closed = false;
  let closePromise = null;
  const close = async () => {
    if (closed) return;
    if (!closePromise) {
      closePromise = (async () => {
        await handle.close();
        closed = true;
        await releaseObjectLock();
      })();
    }
    try {
      await closePromise;
    } catch (error) {
      closePromise = null;
      throw error;
    }
  };
  return new Proxy(handle, {
    get(target, property) {
      if (property === "close") return close;
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

async function cleanupArtifactObject({ candidate, objectRoot, repository, clock }) {
  const releaseObjectLock = await acquireArtifactObjectLock({
    objectRoot,
    tenantScope: candidate.tenantScope,
    sha256: candidate.objectSha256,
  });
  let generation = candidate.generation;
  try {
    let current = repository.readArtifactObjectCleanupCandidate({
      tenantScope: candidate.tenantScope,
      objectSha256: candidate.objectSha256,
    });
    if (!current) return "alreadyClean";
    if (!current.integrityValid) {
      repository.markArtifactObjectReconcileRequired({
        tenantScope: current.tenantScope,
        objectSha256: current.objectSha256,
        resultCode: "integrity_invalid",
        now: clock(),
      });
      return "failedSafe";
    }
    const canonicalPath = objectPath(objectRoot, current.tenantScope, current.objectSha256);
    const directory = path.dirname(canonicalPath);
    const deletionPath = path.join(directory, `.${current.objectSha256}.delete-pending`);
    await assertExistingArtifactDirectory(objectRoot, directory);

    if (current.state !== "delete_pending") {
      const canonicalMetadata = await lstatExact(canonicalPath);
      const deletionMetadata = await lstatExact(deletionPath);
      if (!canonicalMetadata || deletionMetadata) {
        repository.markArtifactObjectReconcileRequired({
          tenantScope: current.tenantScope,
          objectSha256: current.objectSha256,
          resultCode: canonicalMetadata ? "object_state_invalid" : "object_missing",
          now: clock(),
        });
        return "failedSafe";
      }
      await verifyArtifactObjectPath(canonicalPath, current);
      current = repository.beginArtifactObjectCleanup({
        tenantScope: current.tenantScope,
        objectSha256: current.objectSha256,
        expectedSizeBytes: current.sizeBytes,
        now: clock(),
      });
      if (!current) return "deferred";
      generation = current.generation;
    }

    let canonicalMetadata = await lstatExact(canonicalPath);
    let deletionMetadata = await lstatExact(deletionPath);
    if (canonicalMetadata && deletionMetadata) {
      repository.markArtifactObjectReconcileRequired({
        tenantScope: current.tenantScope,
        objectSha256: current.objectSha256,
        generation,
        resultCode: "object_state_invalid",
        now: clock(),
      });
      return "failedSafe";
    }
    if (canonicalMetadata) {
      await verifyArtifactObjectPath(canonicalPath, current);
      await rename(canonicalPath, deletionPath);
      await syncArtifactDirectory(directory);
      deletionMetadata = await lstatExact(deletionPath);
      canonicalMetadata = await lstatExact(canonicalPath);
      if (canonicalMetadata || !deletionMetadata) {
        throw cleanupPhysicalError("object_state_invalid");
      }
    }
    if (deletionMetadata) {
      await verifyArtifactObjectPath(deletionPath, current);
      await rm(deletionPath, { force: false });
      await syncArtifactDirectory(directory);
    } else {
      await syncArtifactDirectory(directory);
    }
    if (await lstatExact(canonicalPath) || await lstatExact(deletionPath)) {
      throw cleanupPhysicalError("object_state_invalid");
    }
    if (!repository.finalizeArtifactObjectCleanup({
      tenantScope: current.tenantScope,
      objectSha256: current.objectSha256,
      generation,
      now: clock(),
    })) {
      repository.markArtifactObjectReconcileRequired({
        tenantScope: current.tenantScope,
        objectSha256: current.objectSha256,
        generation,
        resultCode: "reference_changed",
        now: clock(),
      });
      return "failedSafe";
    }
    return "deleted";
  } catch (error) {
    const resultCode = [
      "integrity_invalid", "object_missing", "object_state_invalid", "reference_changed",
    ].includes(error?.cleanupResultCode) ? error.cleanupResultCode : "integrity_invalid";
    repository.markArtifactObjectReconcileRequired({
      tenantScope: candidate.tenantScope,
      objectSha256: candidate.objectSha256,
      generation: generation > 0 ? generation : null,
      resultCode,
      now: clock(),
    });
    return "failedSafe";
  } finally {
    await releaseObjectLock();
  }
}

async function verifyArtifactObjectPath(filePath, candidate) {
  const handle = await openReadOnlyNoFollow(filePath, "artifact_object_integrity_invalid")
    .catch(() => { throw cleanupPhysicalError("integrity_invalid"); });
  try {
    const verified = await hashOpenFile(handle, { rejectHardLinks: true })
      .catch(() => { throw cleanupPhysicalError("integrity_invalid"); });
    if (verified.sha256 !== candidate.objectSha256 || verified.sizeBytes !== candidate.sizeBytes) {
      throw cleanupPhysicalError("integrity_invalid");
    }
  } finally {
    await handle.close().catch(() => {});
  }
}

async function lstatExact(filePath) {
  try {
    return await lstat(filePath);
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw cleanupPhysicalError("object_state_invalid");
  }
}

async function assertExistingArtifactDirectory(objectRoot, directory) {
  if (!isWithin(objectRoot, directory)) throw cleanupPhysicalError("object_state_invalid");
  const filesystemRoot = path.parse(objectRoot).root;
  let current = filesystemRoot;
  for (const segment of path.relative(filesystemRoot, directory).split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    const metadata = await lstatExact(current);
    if (!metadata?.isDirectory() || metadata.isSymbolicLink()) {
      throw cleanupPhysicalError("object_state_invalid");
    }
  }
}

function cleanupPhysicalError(resultCode) {
  const error = new Error("artifact cleanup failed safe");
  error.cleanupResultCode = resultCode;
  return error;
}

function boundedCleanupLimit(value) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 1 || number > 500) {
    throw executionTaskError("artifact_cleanup_limit_invalid", "artifact cleanup limit is invalid");
  }
  return number;
}

function cleanupReasonCode(value) {
  const reasonCode = String(value || "").trim();
  if (!["scheduled_ttl", "startup_recovery", "controlled_acceptance"].includes(reasonCode)) {
    throw executionTaskError("artifact_cleanup_reason_invalid", "artifact cleanup reason is invalid");
  }
  return reasonCode;
}

function cleanupSummary({ authorities, complete, completedAt, objects, reasonCode, startedAt, status }) {
  return Object.freeze({
    contractVersion: "artifact-retention-cleanup.v1",
    status,
    complete,
    reasonCode,
    startedAt,
    completedAt,
    authorities: Object.freeze({ ...authorities }),
    objects: Object.freeze({ ...objects }),
  });
}

async function hashOpenFile(handle, { expectedMetadata = null, rejectHardLinks = false } = {}) {
  const before = await handle.stat();
  if (!before.isFile() || before.size <= 0 || before.size > MAX_ARTIFACT_BYTES ||
    (rejectHardLinks && before.nlink !== 1) ||
    (expectedMetadata && (before.dev !== expectedMetadata.dev || before.ino !== expectedMetadata.ino ||
      before.size !== expectedMetadata.size || before.nlink !== expectedMetadata.nlink))) {
    throw executionTaskError("artifact_source_changed", "artifact file identity changed during publication");
  }
  const digest = crypto.createHash("sha256");
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  let position = 0;
  while (position < before.size) {
    const { bytesRead } = await handle.read(buffer, 0, Math.min(buffer.length, before.size - position), position);
    if (!bytesRead) throw executionTaskError("artifact_source_changed", "artifact file ended while hashing");
    digest.update(buffer.subarray(0, bytesRead));
    position += bytesRead;
  }
  const after = await handle.stat();
  if (after.dev !== before.dev || after.ino !== before.ino || after.size !== before.size || after.nlink !== before.nlink) {
    throw executionTaskError("artifact_source_changed", "artifact file identity changed while hashing");
  }
  return Object.freeze({ sha256: digest.digest("hex"), sizeBytes: position });
}

function objectPath(objectRoot, tenantScope, sha256) {
  const safeDigest = requiredExecutionTaskDigest(sha256, "objectSha256");
  const tenantDigest = crypto.createHash("sha256").update(tenantScope).digest("hex");
  return path.join(objectRoot, tenantDigest, safeDigest.slice(0, 2), safeDigest);
}

function artifactIdentity({ tenantScope, taskId, relativePath, sha256 }) {
  return `artifact_${crypto.createHash("sha256")
    .update([ARTIFACT_REF_CONTRACT_VERSION, tenantScope, taskId, relativePath, sha256].join("\0"))
    .digest("hex")}`;
}

function requiredAbsoluteRoot(value) {
  const root = String(value || "").trim();
  if (!root || !path.isAbsolute(root)) throw new TypeError("artifact object root must be absolute");
  const normalized = path.normalize(root);
  if (fs.existsSync(normalized) && fs.lstatSync(normalized).isSymbolicLink()) {
    throw new TypeError("artifact object root must not be a symbolic link");
  }
  const missing = [];
  let existing = normalized;
  while (!fs.existsSync(existing)) {
    missing.unshift(path.basename(existing));
    const parent = path.dirname(existing);
    if (parent === existing) break;
    existing = parent;
  }
  return path.join(fs.realpathSync(existing), ...missing);
}

function requiredPositiveInteger(value, fieldName) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number <= 0) {
    throw executionTaskError("artifact_publish_identity_invalid", `${fieldName} must be a positive integer`);
  }
  return number;
}

function assertPublicationWindow(createdAt, expiresAt) {
  const created = Date.parse(createdAt);
  const expires = Date.parse(expiresAt);
  if (expires <= created || expires - created > MAX_ARTIFACT_TTL_MS) {
    throw executionTaskError(
      "artifact_expiry_invalid",
      "artifact expiry must be after publication and within the maximum TTL",
    );
  }
}

async function openReadOnlyNoFollow(filePath, errorCode) {
  try {
    return await open(filePath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  } catch (error) {
    if (["ELOOP", "ENOENT", "ENOTDIR"].includes(error?.code)) {
      throw executionTaskError(errorCode, "artifact file is missing or resolves through a link");
    }
    throw error;
  }
}

async function ensurePrivateArtifactDirectory(objectRoot, directory) {
  if (!isWithin(objectRoot, directory)) {
    throw executionTaskError("artifact_object_root_invalid", "artifact object directory escapes its root");
  }
  await ensureDirectoryTreeNoLinks(objectRoot);
  const relative = path.relative(objectRoot, directory);
  let current = objectRoot;
  for (const segment of relative.split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    let created = false;
    try {
      await mkdir(current, { mode: 0o700 });
      created = true;
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
    }
    const metadata = await lstat(current);
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
      throw executionTaskError("artifact_object_root_invalid", "artifact object root contains a link");
    }
    if (created) await syncArtifactDirectory(path.dirname(current));
  }
}

async function ensureDirectoryTreeNoLinks(directory) {
  const root = path.parse(directory).root;
  let current = root;
  for (const segment of path.relative(root, directory).split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    let created = false;
    try {
      await mkdir(current, { mode: 0o700 });
      created = true;
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
    }
    const metadata = await lstat(current);
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
      throw executionTaskError("artifact_object_root_invalid", "artifact object root contains a link");
    }
    if (created) await syncArtifactDirectory(path.dirname(current));
  }
}

async function syncArtifactDirectory(directory) {
  let handle;
  try {
    handle = await open(directory, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    await handle.sync();
  } catch {
    throw executionTaskError(
      "artifact_object_sync_failed",
      "artifact object directory could not be durably synchronized",
    );
  } finally {
    await handle?.close().catch(() => {});
  }
}

function isWithin(root, candidate) {
  return candidate !== root && candidate.startsWith(`${root}${path.sep}`);
}
