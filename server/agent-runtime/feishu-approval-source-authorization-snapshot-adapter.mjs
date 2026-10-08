import crypto from "node:crypto";
import {
  FEISHU_APPROVAL_DATA_ACCESS_AUTHORIZATION_CONTRACT_VERSION,
  FEISHU_APPROVAL_SOURCE_GRANT_SNAPSHOT_CONTRACT_VERSION,
  FEISHU_APPROVAL_SOURCE_REQUIRED_TENANT_SCOPES,
  FEISHU_TENANT_SCOPE_AUTHORIZATION_CONTRACT_VERSION,
} from "./feishu-approval-source-access-grant-resolver.mjs";

const ADAPTER_VERSION = "feishu-approval-source-authorization-snapshot-adapter.v1";
const RESPONSE_VERSION = "enterprise-feishu-approval-source-authorization-response.v1";
const SCOPE_STATE_VERSION = "enterprise-feishu-tenant-scope-state.v1";
const DATA_POLICY_VERSION = "enterprise-feishu-approval-data-policy-state.v1";
const REQUEST_FIELDS = new Set([
  "canonicalTaskId", "contractVersion", "employeeId", "evaluatedAt", "resourceKind",
  "runId", "scheduleId", "selectionMode", "sourceAdapterId", "sourceBindingDigest",
  "sourceBindingId", "sourceBindingVersion", "sourceSystemId", "taskDefinitionId",
  "taskDefinitionVersion", "tenantScope",
]);
const RESPONSE_FIELDS = new Set([
  "accessGrantId", "accessGrantVersion", "authoritySourceId", "authorityVersion",
  "contractVersion", "credentialBindingId", "credentialBindingVersion",
  "dataAccessAuthorization", "scopeAuthorization", "sourceKind", "sourceSystemId",
  "status", "target", "tenantScope", "validFrom", "validUntil",
]);
const TARGET_FIELDS = new Set([
  "employeeId", "resourceKind", "scheduleId", "selectionMode", "sourceAdapterId",
  "sourceBindingDigest", "sourceBindingId", "sourceBindingVersion", "taskDefinitionId",
  "taskDefinitionVersion",
]);
const SCOPE_FIELDS = new Set([
  "contractVersion", "observedAt", "scopes", "status", "validFrom", "validUntil",
]);
const SCOPE_ENTRY_FIELDS = new Set(["grantStatus", "scopeName", "scopeType"]);
const DATA_FIELDS = new Set([
  "contractVersion", "observedAt", "policyId", "policyVersion", "resourceKind",
  "selectionMode", "status", "validFrom", "validUntil",
]);
const TOKEN = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,239}$/;
const DIGEST = /^[a-f0-9]{64}$/;

function createFeishuApprovalSourceAuthorizationSnapshotAdapter({
  allowlistedAuthoritySourceIds,
  fetchCurrentAuthorization,
  maxObservationAgeMs = 30_000,
  stableAuthorityHmacKey,
} = {}) {
  if (typeof fetchCurrentAuthorization !== "function") {
    throw new TypeError("Feishu approval authorization adapter requires a source");
  }
  const allowedSources = allowlist(allowlistedAuthoritySourceIds);
  const hmacKey = exactKey(stableAuthorityHmacKey);
  if (!Number.isSafeInteger(maxObservationAgeMs) || maxObservationAgeMs < 1_000 ||
    maxObservationAgeMs > 5 * 60_000) {
    throw new TypeError("Feishu approval authorization observation age is invalid");
  }

  async function readCurrentAuthorizationSnapshot(value = {}, { signal = null } = {}) {
    const request = normalizeRequest(value);
    let raw;
    try {
      raw = await fetchCurrentAuthorization(request, { signal });
    } catch {
      throw adapterError("schedule_feishu_approval_authorization_source_unavailable");
    }
    const response = normalizeResponse(raw, request, allowedSources, maxObservationAgeMs);
    const evidenceBinding = {
      authoritySourceId: response.authoritySourceId,
      authorityVersion: response.authorityVersion,
      target: response.target,
      tenantScope: response.tenantScope,
    };
    const scopeAuthorization = {
      authorityDigest: keyedDigest(hmacKey, {
        contractVersion: "feishu-approval-scope-authority-evidence.v1",
        ...evidenceBinding,
        scopeAuthorization: {
          scopes: response.scopeAuthorization.scopes,
          status: response.scopeAuthorization.status,
        },
      }),
      contractVersion: FEISHU_TENANT_SCOPE_AUTHORIZATION_CONTRACT_VERSION,
      observedAt: response.scopeAuthorization.observedAt,
      scopes: response.scopeAuthorization.scopes,
      status: "authorized",
      validUntil: response.scopeAuthorization.validUntil,
    };
    const dataAccessAuthorization = {
      authorityDigest: keyedDigest(hmacKey, {
        contractVersion: "feishu-approval-data-authority-evidence.v1",
        ...evidenceBinding,
        dataAccessAuthorization: {
          policyId: response.dataAccessAuthorization.policyId,
          policyVersion: response.dataAccessAuthorization.policyVersion,
          resourceKind: response.dataAccessAuthorization.resourceKind,
          selectionMode: response.dataAccessAuthorization.selectionMode,
          status: response.dataAccessAuthorization.status,
        },
      }),
      contractVersion: FEISHU_APPROVAL_DATA_ACCESS_AUTHORIZATION_CONTRACT_VERSION,
      policyId: response.dataAccessAuthorization.policyId,
      policyVersion: response.dataAccessAuthorization.policyVersion,
      resourceKind: response.dataAccessAuthorization.resourceKind,
      selectionMode: response.dataAccessAuthorization.selectionMode,
      status: "authorized",
      validUntil: response.dataAccessAuthorization.validUntil,
    };
    return deepFreeze({
      accessGrantId: response.accessGrantId,
      accessGrantVersion: response.accessGrantVersion,
      contractVersion: FEISHU_APPROVAL_SOURCE_GRANT_SNAPSHOT_CONTRACT_VERSION,
      credentialBindingId: response.credentialBindingId,
      credentialBindingVersion: response.credentialBindingVersion,
      dataAccessAuthorization,
      ...response.target,
      scopeAuthorization,
      sourceSystemId: "feishu",
      status: "active",
      tenantScope: response.tenantScope,
      validUntil: earliestTimestamp([
        response.validUntil,
        response.scopeAuthorization.validUntil,
        response.dataAccessAuthorization.validUntil,
      ]),
    });
  }

  return Object.freeze({
    contractVersion: ADAPTER_VERSION,
    readCurrentAuthorizationSnapshot,
  });
}

function normalizeRequest(value) {
  exactObject(value, REQUEST_FIELDS, "schedule_feishu_approval_authorization_request_invalid");
  const result = {
    canonicalTaskId: token(value.canonicalTaskId),
    contractVersion: value.contractVersion,
    employeeId: token(value.employeeId),
    evaluatedAt: timestamp(value.evaluatedAt),
    resourceKind: token(value.resourceKind),
    runId: token(value.runId),
    scheduleId: token(value.scheduleId),
    selectionMode: token(value.selectionMode),
    sourceAdapterId: token(value.sourceAdapterId),
    sourceBindingDigest: digest(value.sourceBindingDigest),
    sourceBindingId: token(value.sourceBindingId),
    sourceBindingVersion: positiveInteger(value.sourceBindingVersion),
    sourceSystemId: token(value.sourceSystemId),
    taskDefinitionId: token(value.taskDefinitionId),
    taskDefinitionVersion: positiveInteger(value.taskDefinitionVersion),
    tenantScope: token(value.tenantScope),
  };
  if (result.contractVersion !== "schedule-source-access-grant-request.v1" ||
    result.sourceSystemId !== "feishu" ||
    result.sourceAdapterId !== "feishu-approval-readonly-snapshot" ||
    result.resourceKind !== "approval_instances" ||
    result.selectionMode !== "current_authorized_scope") {
    throw adapterError("schedule_feishu_approval_authorization_request_invalid");
  }
  return deepFreeze(result);
}

function normalizeResponse(value, request, allowedSources, maxObservationAgeMs) {
  exactObject(value, RESPONSE_FIELDS, "schedule_feishu_approval_authorization_response_invalid");
  if (value.contractVersion !== RESPONSE_VERSION || value.sourceKind !== "enterprise_source_authority" ||
    value.sourceSystemId !== "feishu" || value.status !== "active") {
    throw adapterError("schedule_feishu_approval_authorization_response_invalid");
  }
  const authoritySourceId = token(value.authoritySourceId);
  if (!allowedSources.has(authoritySourceId)) {
    throw adapterError("schedule_feishu_approval_authorization_source_not_allowed");
  }
  const tenantScope = token(value.tenantScope);
  if (tenantScope !== request.tenantScope) {
    throw adapterError("schedule_feishu_approval_authorization_binding_mismatch");
  }
  const target = normalizeTarget(value.target);
  for (const field of TARGET_FIELDS) {
    if (target[field] !== request[field]) {
      throw adapterError("schedule_feishu_approval_authorization_binding_mismatch");
    }
  }
  const validFrom = timestamp(value.validFrom);
  const validUntil = timestamp(value.validUntil);
  requireLive(validFrom, validUntil, request.evaluatedAt);
  const scopeAuthorization = normalizeScopeAuthorization(
    value.scopeAuthorization,
    request.evaluatedAt,
    maxObservationAgeMs,
  );
  const dataAccessAuthorization = normalizeDataAuthorization(
    value.dataAccessAuthorization,
    request,
    maxObservationAgeMs,
  );
  return deepFreeze({
    accessGrantId: token(value.accessGrantId),
    accessGrantVersion: positiveInteger(value.accessGrantVersion),
    authoritySourceId,
    authorityVersion: token(value.authorityVersion),
    credentialBindingId: token(value.credentialBindingId),
    credentialBindingVersion: positiveInteger(value.credentialBindingVersion),
    dataAccessAuthorization,
    scopeAuthorization,
    target,
    tenantScope,
    validUntil,
  });
}

function normalizeTarget(value) {
  exactObject(value, TARGET_FIELDS, "schedule_feishu_approval_authorization_target_invalid");
  return {
    employeeId: token(value.employeeId),
    resourceKind: token(value.resourceKind),
    scheduleId: token(value.scheduleId),
    selectionMode: token(value.selectionMode),
    sourceAdapterId: token(value.sourceAdapterId),
    sourceBindingDigest: digest(value.sourceBindingDigest),
    sourceBindingId: token(value.sourceBindingId),
    sourceBindingVersion: positiveInteger(value.sourceBindingVersion),
    taskDefinitionId: token(value.taskDefinitionId),
    taskDefinitionVersion: positiveInteger(value.taskDefinitionVersion),
  };
}

function normalizeScopeAuthorization(value, evaluatedAt, maxObservationAgeMs) {
  exactObject(value, SCOPE_FIELDS, "schedule_feishu_approval_authorization_scope_invalid");
  if (value.contractVersion !== SCOPE_STATE_VERSION || value.status !== "authorized" ||
    !Array.isArray(value.scopes) || value.scopes.length !== FEISHU_APPROVAL_SOURCE_REQUIRED_TENANT_SCOPES.length) {
    throw adapterError("schedule_feishu_approval_authorization_scope_invalid");
  }
  const scopes = value.scopes.map((entry) => {
    exactObject(entry, SCOPE_ENTRY_FIELDS, "schedule_feishu_approval_authorization_scope_invalid");
    if (entry.grantStatus !== "granted" || entry.scopeType !== "tenant") {
      throw adapterError("schedule_feishu_approval_authorization_scope_invalid");
    }
    return {
      grantStatus: "granted",
      scopeName: token(entry.scopeName),
      scopeType: "tenant",
    };
  }).sort((left, right) => left.scopeName.localeCompare(right.scopeName));
  const names = new Set(scopes.map(({ scopeName }) => scopeName));
  if (names.size !== scopes.length ||
    FEISHU_APPROVAL_SOURCE_REQUIRED_TENANT_SCOPES.some((scope) => !names.has(scope))) {
    throw adapterError("schedule_feishu_approval_authorization_scope_invalid");
  }
  const validFrom = timestamp(value.validFrom);
  const validUntil = timestamp(value.validUntil);
  const observedAt = timestamp(value.observedAt);
  requireLive(validFrom, validUntil, evaluatedAt);
  requireFreshObservation(observedAt, validFrom, evaluatedAt, maxObservationAgeMs,
    "schedule_feishu_approval_authorization_scope_invalid");
  return deepFreeze({ observedAt, scopes, status: "authorized", validUntil });
}

function normalizeDataAuthorization(value, request, maxObservationAgeMs) {
  exactObject(value, DATA_FIELDS, "schedule_feishu_approval_authorization_policy_invalid");
  if (value.contractVersion !== DATA_POLICY_VERSION || value.status !== "authorized" ||
    value.resourceKind !== request.resourceKind || value.selectionMode !== request.selectionMode) {
    throw adapterError("schedule_feishu_approval_authorization_policy_invalid");
  }
  const validFrom = timestamp(value.validFrom);
  const validUntil = timestamp(value.validUntil);
  const observedAt = timestamp(value.observedAt);
  requireLive(validFrom, validUntil, request.evaluatedAt);
  requireFreshObservation(observedAt, validFrom, request.evaluatedAt, maxObservationAgeMs,
    "schedule_feishu_approval_authorization_policy_invalid");
  return deepFreeze({
    policyId: token(value.policyId),
    policyVersion: positiveInteger(value.policyVersion),
    resourceKind: request.resourceKind,
    selectionMode: request.selectionMode,
    status: "authorized",
    validUntil,
  });
}

function exactObject(value, fields, code) {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(value))) throw adapterError(code);
  const keys = Object.keys(value);
  if (keys.length !== fields.size || keys.some((key) => !fields.has(key))) throw adapterError(code);
}

function token(value) {
  const result = String(value || "").trim();
  if (!TOKEN.test(result) || /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(result)) {
    throw adapterError("schedule_feishu_approval_authorization_reference_invalid");
  }
  return result;
}

function digest(value) {
  const result = String(value || "").trim().toLowerCase();
  if (!DIGEST.test(result)) throw adapterError("schedule_feishu_approval_authorization_digest_invalid");
  return result;
}

function positiveInteger(value) {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw adapterError("schedule_feishu_approval_authorization_number_invalid");
  }
  return value;
}

function timestamp(value) {
  const result = String(value || "").trim();
  const parsed = new Date(result);
  if (!result || !Number.isFinite(parsed.getTime()) || parsed.toISOString() !== result) {
    throw adapterError("schedule_feishu_approval_authorization_timestamp_invalid");
  }
  return result;
}

function requireLive(validFrom, validUntil, evaluatedAt) {
  if (validFrom >= validUntil || evaluatedAt < validFrom || evaluatedAt >= validUntil) {
    throw adapterError("schedule_feishu_approval_authorization_expired");
  }
}

function requireFreshObservation(observedAt, validFrom, evaluatedAt, maxObservationAgeMs, code) {
  const observedMs = Date.parse(observedAt);
  const evaluatedMs = Date.parse(evaluatedAt);
  if (observedAt < validFrom || observedMs > evaluatedMs ||
    evaluatedMs - observedMs > maxObservationAgeMs) {
    throw adapterError(code);
  }
}

function allowlist(value) {
  if (!Array.isArray(value) || value.length < 1 || value.length > 20) {
    throw adapterError("schedule_feishu_approval_authorization_source_allowlist_invalid");
  }
  return new Set(value.map(token));
}

function exactKey(value) {
  const key = Buffer.isBuffer(value) ? Buffer.from(value) : Buffer.from(value || []);
  if (key.length !== 32) throw new TypeError("Feishu approval authorization HMAC key must be 32 bytes");
  return key;
}

function keyedDigest(key, value) {
  return crypto.createHmac("sha256", key).update(canonicalJson(value)).digest("hex");
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) =>
      `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  const result = JSON.stringify(Object.is(value, -0) ? 0 : value);
  if (result === undefined) throw adapterError("schedule_feishu_approval_authorization_value_invalid");
  return result;
}

function earliestTimestamp(values) {
  return new Date(Math.min(...values.map((value) => Date.parse(value)))).toISOString();
}

function deepFreeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    Object.values(value).forEach(deepFreeze);
  }
  return value;
}

function adapterError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

export {
  ADAPTER_VERSION as FEISHU_APPROVAL_SOURCE_AUTHORIZATION_SNAPSHOT_ADAPTER_CONTRACT_VERSION,
  DATA_POLICY_VERSION as ENTERPRISE_FEISHU_APPROVAL_DATA_POLICY_STATE_CONTRACT_VERSION,
  RESPONSE_VERSION as ENTERPRISE_FEISHU_APPROVAL_SOURCE_AUTHORIZATION_RESPONSE_CONTRACT_VERSION,
  SCOPE_STATE_VERSION as ENTERPRISE_FEISHU_TENANT_SCOPE_STATE_CONTRACT_VERSION,
  createFeishuApprovalSourceAuthorizationSnapshotAdapter,
};
