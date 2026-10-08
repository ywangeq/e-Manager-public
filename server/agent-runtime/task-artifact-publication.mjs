import { executionTaskError } from "./runtime-task-contract-v1.mjs";

export const DEFAULT_TASK_ARTIFACT_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export async function publishTaskOutputArtifacts({
  artifacts = [],
  executionOwnership = null,
  taskArtifactService = null,
  now = () => new Date(),
  ttlMs = DEFAULT_TASK_ARTIFACT_TTL_MS,
} = {}) {
  const outputs = Array.isArray(artifacts) ? artifacts.slice(0, 3) : [];
  if (!outputs.length) return Object.freeze([]);
  const authority = executionOwnership?.artifactPublicationAuthority;
  if (!taskArtifactService?.publishOutputArtifact || !validAuthority(authority) ||
    typeof executionOwnership?.refreshCurrentLease !== "function") {
    throw executionTaskError("artifact_publication_unavailable", "task artifact publication authority is unavailable");
  }
  if (typeof now !== "function" || !Number.isSafeInteger(ttlMs) || ttlMs <= 0) {
    throw executionTaskError("artifact_publication_policy_invalid", "task artifact publication policy is invalid");
  }
  const published = [];
  const seen = new Set();
  for (const output of outputs) {
    const relativePath = String(output?.relativePath || "").normalize("NFC");
    if (!relativePath || seen.has(relativePath)) continue;
    seen.add(relativePath);
    executionOwnership.refreshCurrentLease();
    const createdAt = new Date(now());
    if (!Number.isFinite(createdAt.getTime())) {
      throw executionTaskError("artifact_publication_policy_invalid", "task artifact publication clock is invalid");
    }
    published.push(await taskArtifactService.publishOutputArtifact({
      ...authority,
      relativePath,
      expiresAt: new Date(createdAt.getTime() + ttlMs).toISOString(),
      now: createdAt,
    }));
  }
  return Object.freeze(published);
}

function validAuthority(value) {
  return value && typeof value === "object" &&
    typeof value.tenantScope === "string" && value.tenantScope &&
    typeof value.taskId === "string" && value.taskId &&
    typeof value.leaseId === "string" && value.leaseId &&
    typeof value.workerIdDigest === "string" && value.workerIdDigest &&
    Number.isSafeInteger(value.fencingToken) && value.fencingToken > 0;
}
