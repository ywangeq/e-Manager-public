import crypto from "node:crypto";
import { link, lstat, mkdir, open, rename, rm } from "node:fs/promises";
import path from "node:path";

const DELIVERY_CONTRACT_VERSION = "digital-employee-task-artifact.v1";
const MAX_ARTIFACT_BYTES = 128 * 1024 * 1024;
const OPEN_PATH_TIMEOUT_MS = 10_000;
const MAX_PENDING_DELIVERIES = 64;
const SAFE_TOKEN_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:@-]*$/;
const OPEN_TYPES = new Map([
  ["application/json", new Set([".json"])],
  ["application/pdf", new Set([".pdf"])],
  ["text/markdown", new Set([".md", ".markdown"])],
  ["text/plain", new Set([".txt"])],
]);

export function createDesktopArtifactDeliveryService({
  currentActorContext,
  openPath,
  openPathTimeoutMs = OPEN_PATH_TIMEOUT_MS,
  request,
  revealPath,
  tempRoot,
  workspaceRoot,
} = {}) {
  if (typeof request !== "function" || typeof currentActorContext !== "function" ||
    typeof openPath !== "function" || typeof revealPath !== "function" ||
    !path.isAbsolute(String(tempRoot || "")) || !path.isAbsolute(String(workspaceRoot || ""))) {
    throw new TypeError("desktop artifact delivery dependencies are required");
  }
  const activeControllers = new Set();
  let deliveryTail = Promise.resolve();
  let deliveryGeneration = 0;
  let pendingDeliveries = 0;

  async function inspect(input = {}) {
    const reference = normalizeReference(input);
    if (!reference) return failure("invalid_reference");
    const actorContext = normalizeActorContext(currentActorContext());
    if (!actorContext.actorKey) return failure("authentication_required");
    try {
      const remoteArtifact = await fetchMetadata(reference);
      const artifact = await projectLocalAvailability(reference, actorContext, remoteArtifact);
      assertActorContext(actorContext);
      return success("available", artifact);
    } catch (error) {
      return failure(publicFailureStatus(error));
    }
  }

  async function deliver(input = {}) {
    const reference = normalizeReference(input);
    const action = input?.action;
    if (!reference || !["materialize", "open", "reveal"].includes(action)) return failure("invalid_reference");
    const actorContext = normalizeActorContext(currentActorContext());
    if (!actorContext.actorKey) return failure("authentication_required");
    if (pendingDeliveries >= MAX_PENDING_DELIVERIES) return failure("busy");
    const generation = deliveryGeneration;
    pendingDeliveries += 1;
    // Each caller revalidates authority and local availability; never cache open effects or credentials.
    const delivery = deliveryTail.then(async () => {
      try {
        if (generation !== deliveryGeneration) throw deliveryError("authentication_changed");
        assertActorContext(actorContext);
        return await performDelivery(reference, action, actorContext);
      } catch (error) {
        return failure(publicFailureStatus(error));
      } finally {
        pendingDeliveries -= 1;
      }
    });
    deliveryTail = delivery.then(() => undefined, () => undefined);
    return delivery;
  }

  async function performDelivery(reference, action, actorContext) {
    const controller = new AbortController();
    activeControllers.add(controller);
    try {
      const remoteArtifact = await fetchMetadata(reference, controller.signal);
      const artifact = await projectLocalAvailability(reference, actorContext, remoteArtifact);
      if (controller.signal.aborted) throw deliveryError("authentication_changed");
      assertActorContext(actorContext);
      const workspacePath = localArtifactPath(reference, actorContext, artifact);
      if (action === "open" && !artifact.canOpen) return failure("open_not_allowed", artifact);
      if (action === "reveal") {
        if (artifact.localAvailability !== "landed") return failure("local_unavailable", artifact);
        assertActorContext(actorContext);
        await Promise.resolve(revealPath(workspacePath)).catch(() => { throw deliveryError("reveal_failed"); });
        return success("revealed", artifact);
      }
      if (action === "materialize") {
        if (artifact.localAvailability === "landed") return success("landed", artifact);
        if (artifact.localAvailability === "conflict") return failure("local_conflict", artifact);
        await writeVerifiedArtifact({
          actorContext,
          artifact,
          controller,
          destinationPath: workspacePath,
          reference,
          publishMode: "create",
        });
        return success("landed", withLocalAvailability(artifact, "landed"));
      }
      if (artifact.localAvailability === "landed") {
        assertActorContext(actorContext);
        const openError = await openPathWithTimeout(
          () => openPath(workspacePath),
          normalizedOpenTimeout(openPathTimeoutMs),
        );
        if (openError) throw deliveryError("open_failed");
        return success("opened", artifact);
      }
      await mkdir(tempRoot, { recursive: true, mode: 0o700 });
      const openDirectory = path.join(tempRoot, crypto.randomUUID());
      await mkdir(openDirectory, { recursive: false, mode: 0o700 });
      const destinationPath = path.join(openDirectory, artifact.fileName);
      try {
        await writeVerifiedArtifact({
          actorContext,
          artifact,
          controller,
          destinationPath,
          reference,
          publishMode: "rename",
        });
        if (controller.signal.aborted) throw deliveryError("authentication_changed");
        assertActorContext(actorContext);
        const openError = await openPathWithTimeout(
          () => openPath(destinationPath),
          normalizedOpenTimeout(openPathTimeoutMs),
        );
        if (openError) throw deliveryError("open_failed");
        return success("opened", artifact);
      } catch (error) {
        await rm(openDirectory, { recursive: true, force: true }).catch(() => {});
        throw error;
      }
    } catch (error) {
      return failure(publicFailureStatus(error));
    } finally {
      activeControllers.delete(controller);
    }
  }

  function abortAll() {
    deliveryGeneration += 1;
    for (const controller of activeControllers) controller.abort();
  }

  async function cleanup() {
    abortAll();
    await rm(tempRoot, { recursive: true, force: true }).catch(() => {});
  }

  async function fetchMetadata(reference, signal = undefined) {
    const response = await request(artifactPath(reference), {
      cache: "no-store",
      headers: { Accept: "application/json" },
      redirect: "error",
      signal,
    }).catch(() => { throw deliveryError("network_unavailable"); });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw deliveryError(centerFailureStatus(response.status, body?.error));
    const normalized = normalizeMetadata(body, reference);
    if (!normalized) throw deliveryError("metadata_invalid");
    return normalized;
  }

  async function projectLocalAvailability(reference, actorContext, artifact) {
    const metadata = await lstat(localArtifactPath(reference, actorContext, artifact)).catch(() => null);
    if (!metadata) return withLocalAvailability(artifact, "remote");
    return withLocalAvailability(
      artifact,
      metadata.isFile() && metadata.size === artifact.sizeBytes ? "landed" : "conflict",
    );
  }

  function localArtifactPath(reference, actorContext, artifact) {
    const actorScope = crypto.createHash("sha256").update(actorContext.actorKey).digest("hex").slice(0, 16);
    return path.join(workspaceRoot, actorScope, reference.taskId, reference.artifactId, artifact.fileName);
  }

  async function writeVerifiedArtifact({ actorContext, artifact, controller, destinationPath, publishMode, reference }) {
    assertActorContext(actorContext);
    const destinationMetadata = await lstat(destinationPath).catch(() => null);
    if (destinationMetadata) throw deliveryError("destination_exists");
    await mkdir(path.dirname(destinationPath), { recursive: true, mode: 0o700 });
    const partialPath = path.join(
      path.dirname(destinationPath),
      `.${path.basename(destinationPath)}.${crypto.randomUUID()}.part`,
    );
    let handle = null;
    let reader = null;
    let committed = false;
    try {
      const response = await request(`${artifactPath(reference)}/content`, {
        cache: "no-store",
        headers: { Accept: "application/octet-stream", "Accept-Encoding": "identity" },
        redirect: "error",
        signal: controller.signal,
      }).catch(() => { throw deliveryError("network_unavailable"); });
      const expectedSha256 = validateContentResponse(response, artifact);
      if (!response.body?.getReader) throw deliveryError("download_interrupted");
      reader = response.body.getReader();
      handle = await open(partialPath, "wx", 0o600);
      const digest = crypto.createHash("sha256");
      let sizeBytes = 0;
      while (true) {
        const next = await reader.read();
        if (next.done) break;
        const chunk = Buffer.from(next.value || []);
        sizeBytes += chunk.length;
        if (sizeBytes > artifact.sizeBytes) throw deliveryError("integrity_failed");
        digest.update(chunk);
        await writeAll(handle, chunk);
        assertActorContext(actorContext);
      }
      if (sizeBytes !== artifact.sizeBytes || digest.digest("hex") !== expectedSha256) {
        throw deliveryError("integrity_failed");
      }
      await handle.sync();
      await handle.close();
      handle = null;
      if (controller.signal.aborted) throw deliveryError("authentication_changed");
      assertActorContext(actorContext);
      if (publishMode === "create") {
        await link(partialPath, destinationPath);
        await rm(partialPath, { force: true });
      } else {
        await rename(partialPath, destinationPath);
      }
      committed = true;
    } catch (error) {
      if (controller.signal.aborted) throw deliveryError("authentication_changed");
      if (["EEXIST", "EPERM"].includes(error?.code)) throw deliveryError("destination_exists");
      throw error?.code?.startsWith?.("artifact_delivery_") ? error : deliveryError("save_failed");
    } finally {
      await reader?.cancel?.().catch(() => {});
      await handle?.close().catch(() => {});
      if (!committed) await rm(partialPath, { force: true }).catch(() => {});
    }
  }

  function assertActorContext(expected) {
    const current = normalizeActorContext(currentActorContext());
    if (!current.actorKey || current.actorKey !== expected.actorKey || current.version !== expected.version) {
      throw deliveryError("authentication_changed");
    }
  }

  return Object.freeze({ abortAll, cleanup, deliver, inspect });
}

async function openPathWithTimeout(openSystemPath, timeoutMs) {
  let timer = null;
  try {
    return await Promise.race([
      Promise.resolve().then(openSystemPath),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(deliveryError("open_failed")), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function normalizedOpenTimeout(value) {
  return Number.isSafeInteger(value) && value > 0 && value <= OPEN_PATH_TIMEOUT_MS
    ? value
    : OPEN_PATH_TIMEOUT_MS;
}

export function normalizeDesktopArtifactMetadata(value, expectedReference = {}) {
  return normalizeMetadata(value, normalizeReference(expectedReference));
}

function normalizeMetadata(value, expectedReference) {
  if (!expectedReference || !plainObjectWithFields(value, ["ok", "contractVersion", "employeeId", "taskId", "artifact"]) ||
    value.ok !== true || value.contractVersion !== DELIVERY_CONTRACT_VERSION ||
    value.employeeId !== expectedReference.employeeId || value.taskId !== expectedReference.taskId) return null;
  const artifact = value.artifact;
  if (!plainObjectWithFields(artifact, ["artifactId", "fileName", "mimeType", "sizeBytes", "deliveryStatus"]) ||
    artifact.artifactId !== expectedReference.artifactId || artifact.deliveryStatus !== "available") return null;
  const fileName = safeFileName(artifact.fileName);
  const mimeType = safeMimeType(artifact.mimeType);
  const sizeBytes = Number(artifact.sizeBytes);
  if (!fileName || !mimeType || !Number.isSafeInteger(sizeBytes) || sizeBytes <= 0 || sizeBytes > MAX_ARTIFACT_BYTES) return null;
  return Object.freeze({
    artifactId: artifact.artifactId,
    fileName,
    mimeType,
    sizeBytes,
    deliveryStatus: "available",
    canOpen: canOpenArtifact(fileName, mimeType),
    localAvailability: "remote",
  });
}

function withLocalAvailability(artifact, localAvailability) {
  return Object.freeze({ ...artifact, localAvailability });
}

function normalizeReference(value) {
  if (!value || typeof value !== "object") return null;
  const employeeId = safeToken(value.employeeId, 120);
  const taskId = safeToken(value.taskId, 128);
  const artifactId = safeToken(value.artifactId, 160);
  return employeeId && taskId && artifactId ? Object.freeze({ employeeId, taskId, artifactId }) : null;
}

function validateContentResponse(response, artifact) {
  if (!response.ok) throw deliveryError(centerFailureStatus(response.status, ""));
  const contentLength = Number(response.headers.get("content-length"));
  const contentType = String(response.headers.get("content-type") || "").toLowerCase();
  const contractVersion = response.headers.get("x-digital-workforce-artifact-contract");
  const artifactId = response.headers.get("x-digital-workforce-artifact-id");
  const sha256 = String(response.headers.get("x-digital-workforce-artifact-sha256") || "").toLowerCase();
  if (contractVersion !== DELIVERY_CONTRACT_VERSION || artifactId !== artifact.artifactId ||
    contentType !== artifact.mimeType || contentLength !== artifact.sizeBytes || !/^[a-f0-9]{64}$/.test(sha256)) {
    throw deliveryError("integrity_failed");
  }
  return sha256;
}

async function writeAll(handle, bytes) {
  let offset = 0;
  while (offset < bytes.length) {
    const result = await handle.write(bytes, offset, bytes.length - offset, null);
    if (!Number.isSafeInteger(result.bytesWritten) || result.bytesWritten <= 0) throw deliveryError("save_failed");
    offset += result.bytesWritten;
  }
}

function artifactPath(reference) {
  return `/api/digital-employees/${encodeURIComponent(reference.employeeId)}/runtime-tasks/${encodeURIComponent(reference.taskId)}/artifacts/${encodeURIComponent(reference.artifactId)}`;
}

function canOpenArtifact(fileName, mimeType) {
  return OPEN_TYPES.get(mimeType)?.has(path.extname(fileName).toLowerCase()) === true;
}

function safeFileName(value) {
  const fileName = String(value || "").normalize("NFC");
  const stem = fileName.split(".")[0]?.toLowerCase();
  if (!fileName || fileName.length > 255 || fileName === "." || fileName === ".." ||
    fileName.includes("/") || fileName.includes("\\") || /[\0-\x1f\x7f<>:"|?*\u202a-\u202e\u2066-\u2069]/u.test(fileName) ||
    /^[A-Za-z]:/.test(fileName) || fileName.endsWith(".") || fileName.endsWith(" ") ||
    /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])$/.test(stem)) return "";
  return fileName;
}

function safeMimeType(value) {
  const mimeType = String(value || "").trim().toLowerCase();
  return /^[a-z0-9][a-z0-9!#$&^_.+-]{0,126}\/[a-z0-9][a-z0-9!#$&^_.+-]{0,126}$/.test(mimeType) ? mimeType : "";
}

function safeToken(value, maxLength) {
  const token = String(value || "");
  return token.length <= maxLength && SAFE_TOKEN_PATTERN.test(token) ? token : "";
}

function plainObjectWithFields(value, fields) {
  return value && typeof value === "object" && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype &&
    Object.keys(value).length === fields.length && Object.keys(value).every((field) => fields.includes(field));
}

function normalizeActorContext(value) {
  return {
    actorKey: String(value?.actorKey || ""),
    version: Number.isSafeInteger(value?.version) ? value.version : -1,
  };
}

function centerFailureStatus(httpStatus, error) {
  if (httpStatus === 401) return "authentication_required";
  if (httpStatus === 403) return "access_denied";
  if (httpStatus === 409 || error === "task_artifact_not_completed") return "not_completed";
  if (httpStatus === 410 || error === "task_artifact_expired") return "expired";
  if (httpStatus === 422 || error === "task_artifact_integrity_failed") return "integrity_failed";
  if (httpStatus === 404) return "not_found";
  return "network_unavailable";
}

function publicFailureStatus(error) {
  const code = String(error?.code || "");
  return code.startsWith("artifact_delivery_") ? code.slice("artifact_delivery_".length) : "save_failed";
}

function deliveryError(status) {
  const error = new Error(`artifact_delivery_${status}`);
  error.code = `artifact_delivery_${status}`;
  return error;
}

function success(status, artifact) {
  return Object.freeze({ ok: true, status, ...(artifact ? { artifact } : {}) });
}

function failure(status, artifact = null) {
  return Object.freeze({ ok: false, status, ...(artifact ? { artifact } : {}) });
}
