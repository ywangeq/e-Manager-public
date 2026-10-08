import {
  executionTaskError,
  requiredExecutionTaskDigest,
  requiredExecutionTaskToken,
} from "./runtime-task-contract-v1.mjs";

export const ARTIFACT_REF_CONTRACT_VERSION = "artifact-ref.v1";
export const MAX_ARTIFACT_BYTES = 128 * 1024 * 1024;
export const MAX_ARTIFACT_TTL_MS = 30 * 24 * 60 * 60 * 1000;

const ARTIFACT_FIELDS = new Set([
  "artifactId",
  "contractVersion",
  "createdAt",
  "employeeId",
  "expiresAt",
  "fileName",
  "mimeType",
  "sha256",
  "sizeBytes",
  "taskId",
  "visibilityScope",
]);

export function normalizeArtifactRef(value) {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) {
    throw artifactRefError("artifact_ref_invalid", "artifact ref must be a plain object");
  }
  if (Object.keys(value).some((field) => !ARTIFACT_FIELDS.has(field))) {
    throw artifactRefError("artifact_ref_field_not_allowed", "artifact ref contains an undeclared field");
  }
  const contractVersion = value.contractVersion;
  if (contractVersion !== ARTIFACT_REF_CONTRACT_VERSION) {
    throw artifactRefError("artifact_ref_contract_version_invalid", "artifact ref contract version is invalid");
  }
  const createdAt = isoTimestamp(value.createdAt, "createdAt");
  const expiresAt = isoTimestamp(value.expiresAt, "expiresAt");
  const ttlMs = Date.parse(expiresAt) - Date.parse(createdAt);
  if (ttlMs <= 0 || ttlMs > MAX_ARTIFACT_TTL_MS) {
    throw artifactRefError("artifact_ref_expiry_invalid", "artifact ref expiry must be after creation and within policy");
  }
  if (value.visibilityScope !== "task_submitter") {
    throw artifactRefError("artifact_ref_visibility_invalid", "artifact visibility scope is invalid");
  }
  return Object.freeze({
    artifactId: requiredExecutionTaskToken(value.artifactId, "artifactId", 160),
    contractVersion: ARTIFACT_REF_CONTRACT_VERSION,
    taskId: requiredExecutionTaskToken(value.taskId, "taskId", 128),
    employeeId: requiredExecutionTaskToken(value.employeeId, "employeeId", 160),
    fileName: safeFileName(value.fileName),
    mimeType: safeMimeType(value.mimeType),
    sizeBytes: boundedSize(value.sizeBytes),
    sha256: requiredExecutionTaskDigest(value.sha256, "sha256"),
    createdAt,
    expiresAt,
    visibilityScope: "task_submitter",
  });
}

export function artifactRefError(code, message) {
  return executionTaskError(code, message);
}

function safeFileName(value) {
  const fileName = String(value || "").normalize("NFC");
  const stem = fileName.split(".")[0]?.toLowerCase();
  if (!fileName || fileName.length > 255 || fileName === "." || fileName === ".." ||
    fileName.includes("/") || fileName.includes("\\") || /[\0-\x1f\x7f<>:"|?*\u202a-\u202e\u2066-\u2069]/u.test(fileName) ||
    /^[A-Za-z]:/.test(fileName) || fileName.endsWith(".") || fileName.endsWith(" ") ||
    /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])$/.test(stem)) {
    throw artifactRefError("artifact_ref_file_name_invalid", "artifact fileName must be a bounded basename");
  }
  return fileName;
}

function safeMimeType(value) {
  const mimeType = String(value || "").trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9!#$&^_.+-]{0,126}\/[a-z0-9][a-z0-9!#$&^_.+-]{0,126}$/.test(mimeType)) {
    throw artifactRefError("artifact_ref_mime_type_invalid", "artifact mimeType is invalid");
  }
  return mimeType;
}

function boundedSize(value) {
  const sizeBytes = Number(value);
  if (!Number.isSafeInteger(sizeBytes) || sizeBytes <= 0 || sizeBytes > MAX_ARTIFACT_BYTES) {
    throw artifactRefError("artifact_ref_size_invalid", "artifact sizeBytes exceeds policy");
  }
  return sizeBytes;
}

function isoTimestamp(value, fieldName) {
  if (typeof value !== "string") {
    throw artifactRefError("artifact_ref_timestamp_invalid", `${fieldName} must be a canonical ISO timestamp`);
  }
  const date = new Date(value);
  if (!Number.isFinite(date.getTime()) || date.toISOString() !== value) {
    throw artifactRefError("artifact_ref_timestamp_invalid", `${fieldName} must be an ISO timestamp`);
  }
  return date.toISOString();
}
