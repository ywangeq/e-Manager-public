const MAX_ARTIFACT_BYTES = 128 * 1024 * 1024;
const SAFE_TOKEN_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:@-]*$/;

export function createDesktopReusableArtifactMaterialService({ currentActorContext, request } = {}) {
  if (typeof currentActorContext !== "function" || typeof request !== "function") {
    throw new TypeError("Desktop reusable Artifact material dependencies are required");
  }

  async function save(input = {}) {
    const reference = normalizeArtifactReference(input);
    if (!reference) return failure("invalid_reference");
    const actor = normalizeActorContext(currentActorContext());
    if (!actor.actorKey) return failure("authentication_required");
    try {
      const response = await request(`${artifactPath(reference)}/reusable-material`, {
        method: "POST",
        cache: "no-store",
        headers: { Accept: "application/json" },
        redirect: "error",
      });
      const body = await response.json().catch(() => ({}));
      assertActorContext(actor, currentActorContext());
      if (!response.ok || body?.ok !== true) return failure(centerFailureStatus(response.status, body?.error));
      const material = normalizeReusableArtifactMaterial(body.material);
      return material ? success("saved", { material }) : failure("response_invalid");
    } catch (error) {
      return failure(error?.code === "desktop_reusable_artifact_authentication_changed"
        ? "authentication_changed"
        : "network_unavailable");
    }
  }

  async function list(input = {}) {
    const employeeId = safeToken(input?.employeeId, 120);
    if (!employeeId) return failure("invalid_reference", { materials: [] });
    const actor = normalizeActorContext(currentActorContext());
    if (!actor.actorKey) return failure("authentication_required", { materials: [] });
    try {
      const response = await request(`/api/digital-employees/${encodeURIComponent(employeeId)}/reusable-materials?includeSource=1`, {
        cache: "no-store",
        headers: { Accept: "application/json" },
        redirect: "error",
      });
      const body = await response.json().catch(() => ({}));
      assertActorContext(actor, currentActorContext());
      if (!response.ok || body?.ok !== true || !["reusable-artifact-material-list.v1", "reusable-artifact-material-list.v2"].includes(body.contractVersion) ||
        !Array.isArray(body.materials)) {
        return failure(centerFailureStatus(response.status, body?.error), { materials: [] });
      }
      const materials = body.materials.map(normalizeReusableArtifactMaterial);
      const version = body.contractVersion.endsWith(".v2") ? "reusable-artifact-material.v2" : "reusable-artifact-material.v1";
      if (materials.some((item) => !item || item.contractVersion !== version)) return failure("response_invalid", { materials: [] });
      return success("ready", { materials: Object.freeze(materials) });
    } catch (error) {
      return failure(error?.code === "desktop_reusable_artifact_authentication_changed"
        ? "authentication_changed"
        : "network_unavailable", { materials: [] });
    }
  }

  return Object.freeze({ list, save });
}

export function normalizeReusableArtifactMaterial(value) {
  const withSource = value?.contractVersion === "reusable-artifact-material.v2";
  if (!plainObjectWithFields(value, [
    "availabilityStatus", "contractVersion", "createdAt", "expiresAt", "fileName",
    "grantId", "mimeType", "scopeType", "sizeBytes", ...(withSource ? ["source"] : []),
  ]) || !["reusable-artifact-material.v1", "reusable-artifact-material.v2"].includes(value.contractVersion) || value.scopeType !== "personal" ||
    value.availabilityStatus !== "available") return null;
  const grantId = safeToken(value.grantId, 160);
  const fileName = safeFileName(value.fileName);
  const mimeType = safeMimeType(value.mimeType);
  const sizeBytes = Number(value.sizeBytes);
  const createdAt = safeTimestamp(value.createdAt);
  const expiresAt = safeTimestamp(value.expiresAt);
  const source = withSource ? normalizeArtifactReference(value.source) : null;
  if (withSource && (!plainObjectWithFields(value.source, ["employeeId", "taskId", "artifactId"]) || !source)) return null;
  if (!/^material_[a-f0-9]{64}$/.test(grantId) || !fileName || !mimeType ||
    !Number.isSafeInteger(sizeBytes) || sizeBytes <= 0 || sizeBytes > MAX_ARTIFACT_BYTES ||
    !createdAt || !expiresAt || expiresAt <= createdAt) return null;
  return Object.freeze({
    contractVersion: value.contractVersion,
    ...(source ? { source } : {}),
    grantId,
    scopeType: "personal",
    fileName,
    mimeType,
    sizeBytes,
    createdAt,
    expiresAt,
    availabilityStatus: "available",
  });
}

function normalizeArtifactReference(value) {
  const employeeId = safeToken(value?.employeeId, 120);
  const taskId = safeToken(value?.taskId, 128);
  const artifactId = safeToken(value?.artifactId, 160);
  return employeeId && taskId && artifactId ? Object.freeze({ employeeId, taskId, artifactId }) : null;
}

function artifactPath(reference) {
  return `/api/digital-employees/${encodeURIComponent(reference.employeeId)}` +
    `/runtime-tasks/${encodeURIComponent(reference.taskId)}/artifacts/${encodeURIComponent(reference.artifactId)}`;
}

function safeToken(value, maxLength) {
  const text = String(value || "").trim();
  return text && text.length <= maxLength && SAFE_TOKEN_PATTERN.test(text) ? text : "";
}

function safeFileName(value) {
  const text = String(value || "").normalize("NFC");
  if (!text || text.length > 180 || text === "." || text === ".." || /[\0-\x1f\x7f/\\]/.test(text) ||
    /[\u202a-\u202e\u2066-\u2069]/.test(text) || /[ .]$/.test(text)) return "";
  return text;
}

function safeMimeType(value) {
  const text = String(value || "").trim().toLowerCase();
  return /^[a-z0-9][a-z0-9!#$&^_.+-]{0,63}\/[a-z0-9][a-z0-9!#$&^_.+-]{0,95}$/.test(text) ? text : "";
}

function safeTimestamp(value) {
  const timestamp = new Date(value);
  return value && Number.isFinite(timestamp.getTime()) ? timestamp.toISOString() : "";
}

function normalizeActorContext(value) {
  return Object.freeze({
    actorKey: String(value?.actorKey || ""),
    version: Number.isSafeInteger(value?.version) ? value.version : 0,
  });
}

function assertActorContext(expected, currentValue) {
  const current = normalizeActorContext(currentValue);
  if (!current.actorKey || current.actorKey !== expected.actorKey || current.version !== expected.version) {
    const error = new Error("Desktop reusable Artifact actor context changed");
    error.code = "desktop_reusable_artifact_authentication_changed";
    throw error;
  }
}

function centerFailureStatus(statusCode, error) {
  if (statusCode === 401) return "authentication_required";
  if (statusCode === 403) return "permission_denied";
  if (statusCode === 409) return "source_not_completed";
  if (statusCode === 410) return "unavailable";
  if (statusCode === 422) return "integrity_failed";
  return String(error || "request_failed").slice(0, 120);
}

function plainObjectWithFields(value, fields) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype &&
    Object.keys(value).length === fields.length &&
    fields.every((field) => Object.hasOwn(value, field)));
}

function success(status, value = {}) {
  return Object.freeze({ ok: true, status, ...value });
}

function failure(status, value = {}) {
  return Object.freeze({ ok: false, status, ...value });
}
