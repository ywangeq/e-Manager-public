import crypto from "node:crypto";
import {
  OPERATION_RECEIPT_CONTRACT_VERSION,
  normalizeOperationReceiptRequest,
  operationReceiptError,
} from "./operation-receipt-contract-v1.mjs";

function createOperationReceiptProjector({ digestKey } = {}) {
  const key = normalizeDigestKey(digestKey);

  function project({ operation, targetScope, ...identity } = {}) {
    const operationJson = canonicalJson(operation, "operation");
    const targetScopeJson = canonicalJson(targetScope, "targetScope");
    return normalizeOperationReceiptRequest({
      contractVersion: OPERATION_RECEIPT_CONTRACT_VERSION,
      tenantScope: identity.tenantScope,
      taskId: identity.taskId,
      toolCallId: identity.toolCallId,
      effectKind: identity.effectKind,
      adapterId: identity.adapterId,
      actionCode: identity.actionCode,
      authorizationDigest: identity.authorizationDigest,
      recoveryMode: identity.recoveryMode,
      operationDigest: digest(key, "operation-receipt-operation.v1", operationJson),
      targetScopeDigest: digest(key, "operation-receipt-target.v1", targetScopeJson),
    });
  }

  return Object.freeze({ project });
}

function normalizeDigestKey(value) {
  const key = Buffer.isBuffer(value) ? Buffer.from(value) : value ? Buffer.from(value) : Buffer.alloc(0);
  if (key.length !== 32) throw new TypeError("operation receipt projector digestKey must contain exactly 32 bytes");
  return key;
}

function canonicalJson(value, label) {
  const normalized = normalizeJson(value, 0);
  const serialized = JSON.stringify(normalized);
  if (Buffer.byteLength(serialized, "utf8") > 1024 * 1024) {
    throw operationReceiptError("operation_receipt_projection_too_large", `${label} exceeds the bounded digest input size`);
  }
  return serialized;
}

function normalizeJson(value, depth) {
  if (depth > 16) throw operationReceiptError("operation_receipt_projection_invalid", "operation receipt digest input is too deeply nested");
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (Array.isArray(value)) return value.map((item) => normalizeJson(item, depth + 1));
  if (value && typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype) {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, normalizeJson(value[key], depth + 1)]));
  }
  throw operationReceiptError("operation_receipt_projection_invalid", "operation receipt digest input must be canonical JSON");
}

function digest(key, domain, value) {
  return crypto.createHmac("sha256", key).update(domain).update("\0").update(value).digest("hex");
}

export { createOperationReceiptProjector };
