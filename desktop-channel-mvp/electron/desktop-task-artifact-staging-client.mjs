import crypto from "node:crypto";
import { lstat, readFile } from "node:fs/promises";
import path from "node:path";

export const DESKTOP_TASK_ARTIFACT_STAGING_RESULT_CONTRACT_VERSION = "device-sandbox-artifact-staging-result.v1";

const DEVICE_TASK_ARTIFACT_STAGING_CONTRACT_VERSION = "device-task-artifact-staging.v1";
const ATTEMPT_ID = /^sandbox_dispatch_[a-z0-9][a-z0-9._:-]{0,159}$/;
const SHA256 = /^[a-f0-9]{64}$/;

// Electron-main-only byte-transfer adapter. It is intentionally generic: the
// server derives task authority from the dispatch attempt, and this module
// returns only safe Artifact metadata to the local output collector.
export function createDesktopTaskArtifactStagingClient({ authenticatedFetch } = {}) {
  if (typeof authenticatedFetch !== "function") {
    throw new TypeError("desktop task Artifact staging client dependencies are required");
  }

  async function stageTaskArtifacts({ artifacts = [], attemptId = "", centerOrigin = "", signal = null } = {}) {
    const normalizedAttemptId = String(attemptId || "").trim().toLowerCase();
    const target = stagingTarget(centerOrigin);
    const normalizedArtifacts = normalizeArtifacts(artifacts);
    if (!ATTEMPT_ID.test(normalizedAttemptId) || !normalizedArtifacts.length || signal?.aborted) return rejected();
    const staged = [];
    for (const artifact of normalizedArtifacts) {
      if (signal?.aborted) return rejected();
      const result = await uploadArtifact({ artifact, attemptId: normalizedAttemptId, signal, target });
      if (!result) return rejected();
      staged.push(result);
    }
    return Object.freeze({
      artifacts: Object.freeze(staged),
      contractVersion: DESKTOP_TASK_ARTIFACT_STAGING_RESULT_CONTRACT_VERSION,
      status: "staged",
    });
  }

  async function uploadArtifact({ artifact, attemptId, signal = null, target }) {
    let bytes;
    try {
      const metadata = await lstat(artifact.snapshotPath);
      if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.nlink !== 1 || metadata.size !== artifact.sizeBytes) return null;
      bytes = await readFile(artifact.snapshotPath);
      if (bytes.length !== artifact.sizeBytes || sha256(bytes) !== artifact.sha256) return null;
    } catch {
      return null;
    }
    let response;
    try {
      response = await authenticatedFetch(target.href, {
        body: bytes,
        cache: "no-store",
        headers: {
          Accept: "application/json",
          "Content-Encoding": "identity",
          // Chromium owns Content-Length for Buffer bodies; setting it rejects net.fetch.
          "Content-Type": "application/octet-stream",
          "X-Digital-Workforce-Artifact-Relative-Path": encodeURIComponent(artifact.relativePath),
          "X-Digital-Workforce-Artifact-Sha256": artifact.sha256,
          "X-Digital-Workforce-Dispatch-Attempt": attemptId,
        },
        method: "POST",
        redirect: "error",
        ...(signal ? { signal } : {}),
      });
    } catch {
      return null;
    }
    if (!response?.ok || !Number.isInteger(response.status)) return null;
    let result;
    try {
      result = await response.json();
    } catch {
      return null;
    }
    if (!exactObject(result, ["artifact", "contractVersion", "status"]) ||
      result.contractVersion !== DEVICE_TASK_ARTIFACT_STAGING_CONTRACT_VERSION || result.status !== "staged" ||
      !exactObject(result.artifact, ["fileName", "sha256", "sizeBytes"]) ||
      result.artifact.fileName !== artifact.fileName || result.artifact.sha256 !== artifact.sha256 ||
      result.artifact.sizeBytes !== artifact.sizeBytes) return null;
    return Object.freeze({ fileName: artifact.fileName, sha256: artifact.sha256, sizeBytes: artifact.sizeBytes });
  }

  return Object.freeze({ stageTaskArtifacts });
}

function normalizeArtifacts(value) {
  if (!Array.isArray(value) || !value.length || value.length > 3) return [];
  const seen = new Set();
  const artifacts = [];
  for (const artifact of value) {
    if (!exactObject(artifact, ["fileName", "relativePath", "sha256", "sizeBytes", "snapshotPath"])) return [];
    const fileName = String(artifact.fileName || "").normalize("NFC");
    const relativePath = String(artifact.relativePath || "").normalize("NFC");
    const sha256Value = String(artifact.sha256 || "").trim().toLowerCase();
    const sizeBytes = Number(artifact.sizeBytes);
    const snapshotPath = String(artifact.snapshotPath || "");
    if (!safeRelativePath(relativePath) || path.posix.basename(relativePath) !== fileName || !safeFileName(fileName) ||
      !SHA256.test(sha256Value) || !Number.isSafeInteger(sizeBytes) || sizeBytes < 1 || sizeBytes > 128 * 1024 * 1024 ||
      !path.isAbsolute(snapshotPath) || seen.has(relativePath)) return [];
    seen.add(relativePath);
    artifacts.push(Object.freeze({ fileName, relativePath, sha256: sha256Value, sizeBytes, snapshotPath }));
  }
  return artifacts;
}

function stagingTarget(centerOrigin) {
  let origin;
  try {
    origin = new URL(String(centerOrigin || ""));
  } catch {
    throw new TypeError("desktop task Artifact staging HTTPS Center origin is required");
  }
  if (origin.protocol !== "https:" || origin.username || origin.password || origin.pathname !== "/" || origin.search || origin.hash) {
    throw new TypeError("desktop task Artifact staging HTTPS Center origin is required");
  }
  return new URL("/api/channels/desktop/task-artifact-staging", origin);
}

function rejected() {
  return Object.freeze({
    artifacts: Object.freeze([]),
    contractVersion: DESKTOP_TASK_ARTIFACT_STAGING_RESULT_CONTRACT_VERSION,
    status: "rejected",
  });
}

function safeRelativePath(value) {
  return Boolean(value && !path.isAbsolute(value) && !value.includes("\\") &&
    !value.split("/").some((part) => !part || part === "." || part === ".."));
}

function safeFileName(value) {
  return Boolean(value && value.length <= 255 && value !== "." && value !== ".." &&
    !/[\0-\x1f\x7f<>:"|?*\u202a-\u202e\u2066-\u2069]/u.test(value) && !value.endsWith(".") && !value.endsWith(" "));
}

function exactObject(value, fields) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype &&
    Object.keys(value).length === fields.length && fields.every((field) => Object.hasOwn(value, field)));
}

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}
