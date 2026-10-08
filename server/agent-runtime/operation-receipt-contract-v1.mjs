import { isDeepStrictEqual } from "node:util";

const OPERATION_RECEIPT_CONTRACT_VERSION = "operation-receipt.v1";
const EFFECT_KINDS = new Set(["channel_delivery", "external_write", "workspace_write"]);
const RECOVERY_MODES = new Set(["none", "remote_idempotency", "status_query"]);
const RECEIPT_STATUSES = new Set(["prepared", "succeeded", "definitive_failed", "unknown"]);
const OUTCOME_STATUSES = new Set(["succeeded", "definitive_failed", "unknown"]);
const SAFE_TOKEN_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:@-]*$/;
const DIGEST_PATTERN = /^(?:sha256:)?[a-f0-9]{64}$/;
const FORBIDDEN_FIELD_PATTERN = /(?:auth|bearer|cookie|credential|message|password|path|prompt|provider|raw|secret|token)/i;
const SECRET_VALUE_PATTERN = /(?:^|\s)(?:bearer\s+|sk-|rk-|xox[baprs]-|gh[pousr]_|glpat-|ya29\.|eyJ)[A-Za-z0-9._~+\/-]{8,}/i;
const EMAIL_VALUE_PATTERN = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i;
const HOST_PATH_PATTERN = /^(?:\/|~[\\/]|[A-Za-z]:[\\/]|\\\\)/;
const REQUEST_FIELDS = new Set([
  "actionCode",
  "adapterId",
  "authorizationDigest",
  "contractVersion",
  "effectKind",
  "operationDigest",
  "recoveryMode",
  "targetScopeDigest",
  "taskId",
  "tenantScope",
  "toolCallId",
]);
const RECEIPT_FIELDS = new Set([
  ...REQUEST_FIELDS,
  "createdAt",
  "fencingToken",
  "finishedAt",
  "payload",
  "safeResultCode",
  "status",
  "updatedAt",
]);
const OUTCOME_FIELDS = new Set(["receiptPayload", "safeResultCode", "status"]);
const AUTHORIZATION_FIELDS = new Set(["authorizationDigest", "reasonCode", "status"]);

function normalizeOperationReceiptRequest(value) {
  requirePlainObject(value, "operation receipt request");
  rejectForbiddenOrUnknownFields(value, REQUEST_FIELDS, "operation receipt request");
  if (value.contractVersion !== OPERATION_RECEIPT_CONTRACT_VERSION) {
    throw operationReceiptError("operation_receipt_contract_invalid", "operation receipt contractVersion is invalid");
  }
  return deepFreeze({
    contractVersion: OPERATION_RECEIPT_CONTRACT_VERSION,
    tenantScope: requiredToken(value.tenantScope, "tenantScope", 160),
    taskId: requiredToken(value.taskId, "taskId", 128),
    toolCallId: requiredToken(value.toolCallId, "toolCallId", 180),
    operationDigest: requiredDigest(value.operationDigest, "operationDigest"),
    effectKind: allowedToken(value.effectKind, "effectKind", EFFECT_KINDS),
    adapterId: requiredToken(value.adapterId, "adapterId", 160),
    actionCode: requiredToken(value.actionCode, "actionCode", 160),
    targetScopeDigest: requiredDigest(value.targetScopeDigest, "targetScopeDigest"),
    authorizationDigest: requiredDigest(value.authorizationDigest, "authorizationDigest"),
    recoveryMode: allowedToken(value.recoveryMode, "recoveryMode", RECOVERY_MODES),
  });
}

function normalizeOperationReceipt(value) {
  requirePlainObject(value, "operation receipt");
  rejectForbiddenOrUnknownFields(value, RECEIPT_FIELDS, "operation receipt", { scanPayload: false });
  const request = normalizeOperationReceiptRequest(Object.fromEntries(
    [...REQUEST_FIELDS].map((field) => [field, value[field]]),
  ));
  const status = allowedToken(value.status, "status", RECEIPT_STATUSES);
  const safeResultCode = optionalToken(value.safeResultCode, "safeResultCode", 160);
  if (status === "prepared" && safeResultCode) {
    throw operationReceiptError("operation_receipt_state_invalid", "a prepared receipt cannot have a terminal result code");
  }
  if (status !== "prepared" && !safeResultCode) {
    throw operationReceiptError("operation_receipt_state_invalid", "a terminal receipt requires a safe result code");
  }
  return deepFreeze({
    ...request,
    status,
    safeResultCode,
    payload: normalizeJsonPayload(value.payload),
    fencingToken: optionalPositiveInteger(value.fencingToken, "fencingToken"),
    createdAt: optionalTimestamp(value.createdAt, "createdAt"),
    updatedAt: optionalTimestamp(value.updatedAt, "updatedAt"),
    finishedAt: optionalTimestamp(value.finishedAt, "finishedAt"),
  });
}

function normalizeOperationEffectOutcome(value) {
  requirePlainObject(value, "operation effect outcome");
  rejectForbiddenOrUnknownFields(value, OUTCOME_FIELDS, "operation effect outcome", { scanPayload: false });
  const status = allowedToken(value.status, "status", OUTCOME_STATUSES);
  return deepFreeze({
    status,
    safeResultCode: requiredToken(value.safeResultCode, "safeResultCode", 160),
    receiptPayload: normalizeJsonPayload(value.receiptPayload),
  });
}

function normalizeCurrentOperationAuthorization(value) {
  requirePlainObject(value, "current operation authorization");
  rejectForbiddenOrUnknownFields(value, AUTHORIZATION_FIELDS, "current operation authorization");
  const status = allowedToken(value.status, "status", new Set(["allowed", "denied"]));
  return deepFreeze({
    status,
    authorizationDigest: requiredDigest(value.authorizationDigest, "authorizationDigest"),
    reasonCode: optionalToken(value.reasonCode, "reasonCode", 160),
  });
}

function sameOperationReceiptIdentity(receipt, request) {
  try {
    const normalizedReceipt = normalizeOperationReceipt(receipt);
    const normalizedRequest = normalizeOperationReceiptRequest(request);
    return [...REQUEST_FIELDS].every((field) => isDeepStrictEqual(normalizedReceipt[field], normalizedRequest[field]));
  } catch {
    return false;
  }
}

function operationReceiptIdentity(value) {
  const request = normalizeOperationReceiptRequest(value);
  return Object.freeze({
    tenantScope: request.tenantScope,
    taskId: request.taskId,
    toolCallId: request.toolCallId,
    operationDigest: request.operationDigest,
  });
}

function requirePlainObject(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) {
    throw operationReceiptError("operation_receipt_value_invalid", `${label} must be a plain object`);
  }
}

function rejectForbiddenOrUnknownFields(value, allowedFields, label, { scanPayload = true } = {}) {
  for (const [field, fieldValue] of Object.entries(value)) {
    if (!allowedFields.has(field)) {
      const code = FORBIDDEN_FIELD_PATTERN.test(field)
        ? "operation_receipt_sensitive_field"
        : "operation_receipt_field_not_allowed";
      throw operationReceiptError(code, `${label} contains an undeclared field`);
    }
    if (scanPayload || !["payload", "receiptPayload"].includes(field)) assertSafeScalarValue(fieldValue, field);
  }
}

function assertSafeScalarValue(value, field) {
  if (value === undefined || value === null || typeof value === "number" || typeof value === "boolean") return;
  if (typeof value !== "string") return;
  const text = value.trim();
  if (SECRET_VALUE_PATTERN.test(text) || EMAIL_VALUE_PATTERN.test(text) || HOST_PATH_PATTERN.test(text)) {
    throw operationReceiptError("operation_receipt_sensitive_value", `${field} contains a sensitive value`);
  }
}

function requiredToken(value, field, maxLength) {
  const token = String(value || "").trim();
  assertSafeScalarValue(token, field);
  if (!token || token.length > maxLength || !SAFE_TOKEN_PATTERN.test(token)) {
    throw operationReceiptError("operation_receipt_token_invalid", `${field} must be a bounded opaque identifier`);
  }
  return token;
}

function optionalToken(value, field, maxLength) {
  if (value === undefined || value === null || value === "") return null;
  return requiredToken(value, field, maxLength);
}

function allowedToken(value, field, allowed) {
  const token = requiredToken(value, field, 80);
  if (!allowed.has(token)) throw operationReceiptError("operation_receipt_enum_invalid", `${field} is invalid`);
  return token;
}

function requiredDigest(value, field) {
  const digest = String(value || "").trim().toLowerCase();
  if (!DIGEST_PATTERN.test(digest)) {
    throw operationReceiptError("operation_receipt_digest_invalid", `${field} must be a sha256 digest`);
  }
  return digest.replace(/^sha256:/, "");
}

function optionalTimestamp(value, field) {
  if (value === undefined || value === null || value === "") return null;
  const timestamp = new Date(value);
  if (!Number.isFinite(timestamp.getTime())) {
    throw operationReceiptError("operation_receipt_timestamp_invalid", `${field} must be an ISO timestamp`);
  }
  return timestamp.toISOString();
}

function optionalPositiveInteger(value, field) {
  if (value === undefined || value === null || value === "") return null;
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number <= 0) {
    throw operationReceiptError("operation_receipt_integer_invalid", `${field} must be a positive safe integer`);
  }
  return number;
}

function normalizeJsonPayload(value) {
  if (value === undefined || value === null) return null;
  assertJsonValue(value, 0);
  let serialized;
  try {
    serialized = JSON.stringify(value);
  } catch {
    throw operationReceiptError("operation_receipt_payload_invalid", "receipt payload must be JSON serializable");
  }
  if (serialized === undefined || Buffer.byteLength(serialized, "utf8") > 1024 * 1024) {
    throw operationReceiptError("operation_receipt_payload_invalid", "receipt payload exceeds the bounded JSON contract");
  }
  const parsed = JSON.parse(serialized);
  return deepFreeze(parsed);
}

function assertJsonValue(value, depth) {
  if (depth > 16) throw operationReceiptError("operation_receipt_payload_invalid", "receipt payload nesting is too deep");
  if (value === null || typeof value === "string" || typeof value === "boolean") return;
  if (typeof value === "number" && Number.isFinite(value)) return;
  if (Array.isArray(value)) {
    value.forEach((item) => assertJsonValue(item, depth + 1));
    return;
  }
  if (typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype) {
    Object.values(value).forEach((item) => assertJsonValue(item, depth + 1));
    return;
  }
  throw operationReceiptError("operation_receipt_payload_invalid", "receipt payload contains an unsupported JSON value");
}

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  Object.values(value).forEach(deepFreeze);
  return Object.freeze(value);
}

function operationReceiptError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

export {
  OPERATION_RECEIPT_CONTRACT_VERSION,
  normalizeCurrentOperationAuthorization,
  normalizeOperationEffectOutcome,
  normalizeOperationReceipt,
  normalizeOperationReceiptRequest,
  operationReceiptError,
  operationReceiptIdentity,
  sameOperationReceiptIdentity,
};
