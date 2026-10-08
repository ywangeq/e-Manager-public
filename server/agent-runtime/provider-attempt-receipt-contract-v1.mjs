import crypto from "node:crypto";
import { isDeepStrictEqual } from "node:util";

const CONTRACT_VERSION = "provider-attempt-receipt.v1";
const ATTEMPT_EVIDENCE_VERSION = "provider-attempt-identity-evidence.v1";
const RECEIPT_EVIDENCE_VERSION = "provider-attempt-receipt-evidence.v1";
const DESCRIPTOR_FIELDS = new Set([
  "contractVersion", "executionScopeId", "inputDigest", "providerBindingDigest",
  "providerRequestId", "purpose", "recoveryMode", "requestDigest", "taskId", "tenantScope",
]);
const REQUEST_ID_FIELDS = new Set([
  "executionScopeId", "inputDigest", "providerBindingDigest", "purpose", "recoveryMode",
  "requestDigest", "taskId", "tenantScope",
]);
const RECEIPT_FIELDS = new Set([
  ...DESCRIPTOR_FIELDS, "attemptEvidenceDigest", "attemptNumber", "createdAt", "fencingToken",
  "finishedAt", "ingestEvidenceDigest", "ingestRef", "ownershipDigest", "safeResultCode",
  "receiptEvidenceDigest", "status", "updatedAt",
]);
const STATUSES = new Set(["dispatch_prepared", "response_recorded", "definitive_failed", "unknown"]);
const RECOVERY_MODES = new Set(["none", "remote_idempotency", "status_query"]);
const TOKEN = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,179}$/;
const DIGEST = /^[a-f0-9]{64}$/;

function normalizeProviderAttemptDescriptor(value = {}) {
  exactObject(value, DESCRIPTOR_FIELDS, "provider_attempt_descriptor_invalid");
  if (value.contractVersion !== CONTRACT_VERSION) throw receiptError("provider_attempt_contract_invalid");
  const recoveryMode = token(value.recoveryMode, "recoveryMode");
  if (!RECOVERY_MODES.has(recoveryMode)) throw receiptError("provider_attempt_recovery_mode_invalid");
  const normalized = {
    contractVersion: CONTRACT_VERSION,
    tenantScope: token(value.tenantScope, "tenantScope"),
    taskId: token(value.taskId, "taskId"),
    executionScopeId: token(value.executionScopeId, "executionScopeId"),
    purpose: token(value.purpose, "purpose"),
    providerRequestId: token(value.providerRequestId, "providerRequestId"),
    requestDigest: digest(value.requestDigest, "requestDigest"),
    providerBindingDigest: digest(value.providerBindingDigest, "providerBindingDigest"),
    inputDigest: digest(value.inputDigest, "inputDigest"),
    recoveryMode,
  };
  if (normalized.providerRequestId !== createProviderAttemptRequestId(
    Object.fromEntries([...REQUEST_ID_FIELDS].map((field) => [field, normalized[field]])),
  )) {
    throw receiptError("provider_attempt_request_identity_invalid");
  }
  return deepFreeze(normalized);
}

function createProviderAttemptRequestId(value = {}) {
  exactObject(value, REQUEST_ID_FIELDS, "provider_attempt_request_identity_invalid");
  const recoveryMode = token(value.recoveryMode, "recoveryMode");
  if (!RECOVERY_MODES.has(recoveryMode)) throw receiptError("provider_attempt_recovery_mode_invalid");
  const body = {
    contractVersion: "provider-attempt-request-identity.v1",
    tenantScope: token(value.tenantScope, "tenantScope"),
    taskId: token(value.taskId, "taskId"),
    executionScopeId: token(value.executionScopeId, "executionScopeId"),
    purpose: token(value.purpose, "purpose"),
    requestDigest: digest(value.requestDigest, "requestDigest"),
    providerBindingDigest: digest(value.providerBindingDigest, "providerBindingDigest"),
    inputDigest: digest(value.inputDigest, "inputDigest"),
    recoveryMode,
  };
  return `provider_attempt_${digestCanonical(body)}`;
}

function normalizeProviderAttemptReceipt(value = {}) {
  exactObject(value, RECEIPT_FIELDS, "provider_attempt_receipt_invalid");
  const descriptor = normalizeProviderAttemptDescriptor(Object.fromEntries(
    [...DESCRIPTOR_FIELDS].map((field) => [field, value[field]]),
  ));
  const status = token(value.status, "status");
  if (!STATUSES.has(status)) throw receiptError("provider_attempt_status_invalid");
  const safeResultCode = optionalToken(value.safeResultCode, "safeResultCode");
  const ingestRef = optionalToken(value.ingestRef, "ingestRef");
  const ingestEvidenceDigest = value.ingestEvidenceDigest === null
    ? null
    : digest(value.ingestEvidenceDigest, "ingestEvidenceDigest");
  const finishedAt = optionalTimestamp(value.finishedAt, "finishedAt");
  const validState = status === "dispatch_prepared"
    ? safeResultCode === null && ingestRef === null && ingestEvidenceDigest === null && finishedAt === null
    : status === "response_recorded"
      ? safeResultCode !== null && ingestRef !== null && ingestEvidenceDigest !== null && finishedAt !== null
      : safeResultCode !== null && ingestRef === null && ingestEvidenceDigest === null && finishedAt !== null;
  if (!validState || value.attemptNumber !== 1) throw receiptError("provider_attempt_state_invalid");
  const attemptEvidenceDigest = digestCanonical(attemptEvidenceBody(descriptor));
  if (digest(value.attemptEvidenceDigest, "attemptEvidenceDigest") !== attemptEvidenceDigest) {
    throw receiptError("provider_attempt_evidence_invalid");
  }
  const receiptEvidenceDigest = digestCanonical(receiptEvidenceBody({
    attemptEvidenceDigest, status, safeResultCode, ingestRef, ingestEvidenceDigest,
  }));
  if (digest(value.receiptEvidenceDigest, "receiptEvidenceDigest") !== receiptEvidenceDigest) {
    throw receiptError("provider_attempt_receipt_evidence_invalid");
  }
  return deepFreeze({
    ...descriptor,
    attemptNumber: 1,
    status,
    safeResultCode,
    ingestRef,
    ingestEvidenceDigest,
    attemptEvidenceDigest,
    receiptEvidenceDigest,
    fencingToken: positiveInteger(value.fencingToken, "fencingToken"),
    ownershipDigest: digest(value.ownershipDigest, "ownershipDigest"),
    createdAt: timestamp(value.createdAt, "createdAt"),
    updatedAt: timestamp(value.updatedAt, "updatedAt"),
    finishedAt,
  });
}

function createProviderAttemptReceiptEvidence({ descriptor, status, safeResultCode = null,
  ingestRef = null, ingestEvidenceDigest = null } = {}) {
  const normalizedDescriptor = normalizeProviderAttemptDescriptor(descriptor);
  const attemptEvidenceDigest = digestCanonical(attemptEvidenceBody(normalizedDescriptor));
  const receiptEvidenceDigest = digestCanonical(receiptEvidenceBody({
    attemptEvidenceDigest, status, safeResultCode, ingestRef, ingestEvidenceDigest,
  }));
  const normalized = normalizeProviderAttemptReceipt({
    ...normalizedDescriptor,
    attemptNumber: 1,
    status,
    safeResultCode,
    ingestRef,
    ingestEvidenceDigest,
    attemptEvidenceDigest,
    receiptEvidenceDigest,
    fencingToken: 1,
    ownershipDigest: "0".repeat(64),
    createdAt: "2000-01-01T00:00:00.000Z",
    updatedAt: "2000-01-01T00:00:00.000Z",
    finishedAt: status === "dispatch_prepared" ? null : "2000-01-01T00:00:00.000Z",
  });
  return deepFreeze({
    contractVersion: RECEIPT_EVIDENCE_VERSION,
    attemptNumber: 1,
    status: normalized.status,
    safeResultCode: normalized.safeResultCode,
    ingestRef: normalized.ingestRef,
    ingestEvidenceDigest: normalized.ingestEvidenceDigest,
    attemptEvidenceDigest: normalized.attemptEvidenceDigest,
    receiptEvidenceDigest: normalized.receiptEvidenceDigest,
  });
}

function attemptEvidenceBody(descriptor) {
  return {
    contractVersion: ATTEMPT_EVIDENCE_VERSION,
    descriptor,
    attemptNumber: 1,
  };
}

function receiptEvidenceBody({ attemptEvidenceDigest, status, safeResultCode, ingestRef,
  ingestEvidenceDigest }) {
  return {
    contractVersion: RECEIPT_EVIDENCE_VERSION,
    attemptEvidenceDigest,
    attemptNumber: 1,
    status,
    safeResultCode,
    ingestRef,
    ingestEvidenceDigest,
  };
}

function sameProviderAttemptDescriptor(receipt, descriptor) {
  try {
    const normalizedReceipt = normalizeProviderAttemptReceipt(receipt);
    const normalizedDescriptor = normalizeProviderAttemptDescriptor(descriptor);
    return [...DESCRIPTOR_FIELDS].every((field) =>
      isDeepStrictEqual(normalizedReceipt[field], normalizedDescriptor[field]));
  } catch {
    return false;
  }
}

function exactObject(value, fields, code) {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) {
    throw receiptError(code);
  }
  const keys = Object.keys(value);
  if (keys.length !== fields.size || keys.some((key) => !fields.has(key))) throw receiptError(code);
}

function token(value, field) {
  const result = String(value || "").trim();
  if (!TOKEN.test(result) || /@[^/]+\.[A-Za-z]{2,}$/.test(result)) {
    throw receiptError("provider_attempt_token_invalid", field);
  }
  return result;
}

function optionalToken(value, field) {
  return value === null ? null : token(value, field);
}

function digest(value, field) {
  const result = String(value || "").trim().toLowerCase();
  if (!DIGEST.test(result)) throw receiptError("provider_attempt_digest_invalid", field);
  return result;
}

function positiveInteger(value, field) {
  if (!Number.isSafeInteger(value) || value < 1) throw receiptError("provider_attempt_number_invalid", field);
  return value;
}

function timestamp(value, field) {
  const result = String(value || "").trim();
  const parsed = new Date(result);
  if (!result || !Number.isFinite(parsed.getTime()) || parsed.toISOString() !== result) {
    throw receiptError("provider_attempt_timestamp_invalid", field);
  }
  return result;
}

function optionalTimestamp(value, field) {
  return value === null ? null : timestamp(value, field);
}

function digestCanonical(value) {
  return crypto.createHash("sha256").update(JSON.stringify(sortCanonical(value))).digest("hex");
}

function sortCanonical(value) {
  if (Array.isArray(value)) return value.map(sortCanonical);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, sortCanonical(value[key])]));
}

function deepFreeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    Object.values(value).forEach(deepFreeze);
  }
  return value;
}

function receiptError(code, detail = "") {
  const error = new Error(detail ? `${code}: ${detail}` : code);
  error.code = code;
  return error;
}

export {
  CONTRACT_VERSION as PROVIDER_ATTEMPT_RECEIPT_CONTRACT_VERSION,
  ATTEMPT_EVIDENCE_VERSION as PROVIDER_ATTEMPT_IDENTITY_EVIDENCE_VERSION,
  RECEIPT_EVIDENCE_VERSION as PROVIDER_ATTEMPT_RECEIPT_EVIDENCE_VERSION,
  createProviderAttemptReceiptEvidence,
  createProviderAttemptRequestId,
  normalizeProviderAttemptDescriptor,
  normalizeProviderAttemptReceipt,
  receiptError as providerAttemptReceiptError,
  sameProviderAttemptDescriptor,
};
