import { MAX_ARTIFACT_BYTES } from "./artifact-ref-contract-v1.mjs";
import { DEVICE_TASK_ARTIFACT_STAGING_CONTRACT_VERSION } from "./device-task-artifact-staging-service.mjs";

const ATTEMPT_ID = /^sandbox_dispatch_[a-z0-9][a-z0-9._:-]{0,159}$/;
const SHA256 = /^[a-f0-9]{64}$/;

// HTTP is only an authenticated Device adapter. Task identity, lease and
// running-attempt state are derived by the existing dispatch resolver; headers
// may describe one private byte stream but never select task authority.
export function createDesktopTaskArtifactStagingTransportHandlers({
  isManagedHttpsRequest = null,
  resolveActionContext = null,
  stagingService = null,
} = {}) {
  if (typeof isManagedHttpsRequest !== "function" || typeof resolveActionContext !== "function" ||
    typeof stagingService?.stage !== "function") {
    throw new TypeError("desktop task Artifact staging transport dependencies are required");
  }

  async function stage({ requestContext = null } = {}) {
    if (!managedHttps(requestContext)) return blocked();
    const artifact = artifactFromHeaders(requestContext?.req?.headers);
    if (!artifact) return blocked();
    let context;
    try {
      context = resolveActionContext({
        attemptId: artifact.attemptId,
        expectedAttemptStatus: "running",
        requestContext,
      });
    } catch {
      return blocked();
    }
    if (!validContext(context, artifact.attemptId)) return blocked();
    try {
      return await stagingService.stage({
        artifact: { relativePath: artifact.relativePath, sha256: artifact.sha256, sizeBytes: artifact.sizeBytes },
        source: requestContext.req,
        taskIdentity: { taskId: context.runtimeTask.taskId, tenantScope: context.runtimeTask.tenantScope },
        taskOwnership: context.taskOwnership.lease,
      });
    } catch {
      return blocked();
    }
  }

  function managedHttps(requestContext) {
    try {
      return isManagedHttpsRequest({ requestContext }) === true;
    } catch {
      return false;
    }
  }

  return Object.freeze({ stage });
}

function artifactFromHeaders(headers = null) {
  const attemptId = String(header(headers, "x-digital-workforce-dispatch-attempt") || "").trim().toLowerCase();
  const relativePath = decodeURIComponentSafe(header(headers, "x-digital-workforce-artifact-relative-path"));
  const sha256 = String(header(headers, "x-digital-workforce-artifact-sha256") || "").trim().toLowerCase();
  const contentLength = Number(header(headers, "content-length"));
  const contentType = String(header(headers, "content-type") || "").trim().toLowerCase();
  const contentEncoding = String(header(headers, "content-encoding") || "identity").trim().toLowerCase();
  if (!ATTEMPT_ID.test(attemptId) || !relativePath || !SHA256.test(sha256) ||
    !Number.isSafeInteger(contentLength) || contentLength < 1 || contentLength > MAX_ARTIFACT_BYTES ||
    contentType !== "application/octet-stream" || contentEncoding !== "identity") return null;
  return Object.freeze({ attemptId, relativePath, sha256, sizeBytes: contentLength });
}

function validContext(value, attemptId) {
  return Boolean(value && typeof value === "object" && value.attemptId === attemptId &&
    value.runtimeTask?.taskId && value.runtimeTask?.tenantScope && value.taskOwnership?.lease);
}

function header(headers, name) {
  const value = headers?.[name];
  return Array.isArray(value) ? "" : value;
}

function decodeURIComponentSafe(value) {
  try {
    return decodeURIComponent(String(value || ""));
  } catch {
    return "";
  }
}

function blocked() {
  return Object.freeze({
    contractVersion: DEVICE_TASK_ARTIFACT_STAGING_CONTRACT_VERSION,
    status: "blocked",
  });
}
