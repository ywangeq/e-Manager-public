import crypto from "node:crypto";
import {
  executionTaskError,
  normalizedExecutionTaskNow,
  requiredExecutionTaskDigest,
  requiredExecutionTaskToken,
} from "./runtime-task-contract-v1.mjs";

export const REUSABLE_ARTIFACT_GRANT_CONTRACT_VERSION = "reusable-artifact-grant.v1";
export const REUSABLE_ARTIFACT_GRANT_TTL_MS = 30 * 24 * 60 * 60 * 1000;

export function createReusableArtifactGrant({
  tenantScope,
  actorIssuer,
  actorSubjectDigest,
  sourceTaskId,
  artifactId,
  createdAt,
  expiresAt,
} = {}) {
  const grant = {
    contractVersion: REUSABLE_ARTIFACT_GRANT_CONTRACT_VERSION,
    tenantScope: requiredExecutionTaskToken(tenantScope, "tenantScope", 160),
    actorIssuer: requiredExecutionTaskToken(actorIssuer, "actorIssuer", 160),
    actorSubjectDigest: requiredExecutionTaskDigest(actorSubjectDigest, "actorSubjectDigest"),
    scopeType: "personal",
    sourceTaskId: requiredExecutionTaskToken(sourceTaskId, "sourceTaskId", 128),
    artifactId: requiredExecutionTaskToken(artifactId, "artifactId", 160),
    createdAt: normalizedExecutionTaskNow(createdAt),
    expiresAt: normalizedExecutionTaskNow(expiresAt),
  };
  const ttlMs = Date.parse(grant.expiresAt) - Date.parse(grant.createdAt);
  if (ttlMs <= 0 || ttlMs > REUSABLE_ARTIFACT_GRANT_TTL_MS) {
    throw executionTaskError("reusable_artifact_grant_expiry_invalid", "reusable Artifact grant expiry is outside policy");
  }
  grant.grantId = reusableArtifactGrantId(grant);
  return Object.freeze(grant);
}

export function normalizeReusableArtifactGrant(value) {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype ||
    Object.keys(value).some((field) => ![
      "actorIssuer", "actorSubjectDigest", "artifactId", "contractVersion", "createdAt", "expiresAt",
      "grantId", "scopeType", "sourceTaskId", "tenantScope",
    ].includes(field)) || value.contractVersion !== REUSABLE_ARTIFACT_GRANT_CONTRACT_VERSION || value.scopeType !== "personal") {
    throw executionTaskError("reusable_artifact_grant_invalid", "reusable Artifact grant is invalid");
  }
  const normalized = createReusableArtifactGrant(value);
  if (requiredExecutionTaskToken(value.grantId, "grantId", 160) !== normalized.grantId) {
    throw executionTaskError("reusable_artifact_grant_identity_mismatch", "reusable Artifact grant identity is invalid");
  }
  return normalized;
}

function reusableArtifactGrantId(value) {
  return `material_${crypto.createHash("sha256").update(JSON.stringify([
    REUSABLE_ARTIFACT_GRANT_CONTRACT_VERSION,
    value.tenantScope,
    value.actorIssuer,
    value.actorSubjectDigest,
    value.scopeType,
    value.artifactId,
  ])).digest("hex")}`;
}
