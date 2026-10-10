import crypto from "node:crypto";

export const DEVICE_READ_OPERATION_VERSION = "device-read-operation.v1";
export const DEVICE_READ_RESULT_VERSION = "device-read-result.v1";
export const DEVICE_READ_MAX_BYTES = 32 * 1024;
const id = /^[A-Za-z0-9][A-Za-z0-9._:@-]{0,127}$/;
const digest = /^[a-f0-9]{64}$/;
const fields = ["contractVersion", "taskId", "toolCallId", "toolId", "operationId", "adapterDigest", "operationDigest",
  "taskInputDigest", "actorDigest", "deviceSessionDigest", "expiresAt", "input"];

export function deviceReadAdapterDigest(descriptor) {
  return hash({ contractVersion: DEVICE_READ_OPERATION_VERSION, risk: "read", maxBytes: DEVICE_READ_MAX_BYTES,
    ...(descriptor.credentialMode ? { credentialMode: descriptor.credentialMode } : {}),
    toolId: descriptor.toolId, operationId: descriptor.operationId, adapterVersion: descriptor.adapterVersion,
    inputSchema: descriptor.inputSchema, resultSchema: descriptor.resultSchema });
}

export function deviceReadOperationDigest(claim) {
  const { operationDigest: _ignored, ...binding } = claim;
  return hash(binding);
}

// Validation is transport-neutral. Authentication and canonical task/lease
// authority belong to the caller, never to identifiers supplied in this claim.
export function normalizeDeviceReadClaim(value, descriptor, now = Date.now()) {
  if (!plain(value) || Object.keys(value).length !== fields.length || fields.some(key => !Object.hasOwn(value, key)) ||
    value.contractVersion !== DEVICE_READ_OPERATION_VERSION ||
    ![value.taskId, value.toolCallId, value.toolId, value.operationId].every(value => typeof value === "string" && id.test(value)) ||
    ![value.adapterDigest, value.operationDigest, value.taskInputDigest, value.actorDigest, value.deviceSessionDigest]
      .every(value => typeof value === "string" && digest.test(value)) ||
    value.toolId !== descriptor.toolId || value.operationId !== descriptor.operationId ||
    value.adapterDigest !== deviceReadAdapterDigest(descriptor) ||
    typeof value.expiresAt !== "string" || !Number.isFinite(Date.parse(value.expiresAt)) ||
    !Number.isFinite(now) || Date.parse(value.expiresAt) <= now || Date.parse(value.expiresAt) - now > 120_000) return null;
  try {
    const normalized = descriptor.normalizeInput(value.input);
    if (stable(normalized) !== stable(value.input) || value.operationDigest !== deviceReadOperationDigest(value)) return null;
    return Object.freeze({ ...value, input: Object.freeze(normalized) });
  } catch { return null; }
}

export function boundedDeviceReadResult(value, descriptor) {
  const result = descriptor.normalizeResult(value);
  if (Buffer.byteLength(JSON.stringify(result), "utf8") > DEVICE_READ_MAX_BYTES) throw new Error("device_read_result_too_large");
  return structuredClone(result);
}

function hash(value) { return crypto.createHash("sha256").update(stable(value)).digest("hex"); }
function stable(value) {
  if (value === null || typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number" && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (!plain(value)) throw new Error("device_read_invalid_json");
  return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stable(value[key])}`).join(",")}}`;
}
function plain(value) { return Boolean(value && typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype); }
