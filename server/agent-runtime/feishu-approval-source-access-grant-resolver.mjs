import crypto from "node:crypto";

const RESOLVER_VERSION = "feishu-approval-source-access-grant-resolver.v1";
const REQUEST_VERSION = "schedule-source-access-grant-request.v1";
const SNAPSHOT_VERSION = "feishu-approval-source-grant-snapshot.v1";
const SCOPE_AUTHORIZATION_VERSION = "feishu-tenant-scope-authorization.v1";
const DATA_AUTHORIZATION_VERSION = "feishu-approval-data-access-authorization.v1";
const GRANT_VERSION = "schedule-source-access-grant.v1";
const SOURCE_ADAPTER_ID = "feishu-approval-readonly-snapshot";
const REQUIRED_TENANT_SCOPES = Object.freeze([
  "approval:approval.list:readonly",
  "approval:approval:readonly",
]);
const REQUEST_FIELDS = new Set([
  "canonicalTaskId", "contractVersion", "employeeId", "evaluatedAt", "resourceKind",
  "runId", "scheduleId", "selectionMode", "sourceAdapterId", "sourceBindingDigest",
  "sourceBindingId", "sourceBindingVersion", "sourceSystemId", "taskDefinitionId",
  "taskDefinitionVersion", "tenantScope",
]);
const SNAPSHOT_FIELDS = new Set([
  "accessGrantId", "accessGrantVersion", "contractVersion", "credentialBindingId",
  "credentialBindingVersion", "dataAccessAuthorization", "employeeId", "resourceKind",
  "scheduleId", "scopeAuthorization", "selectionMode", "sourceAdapterId",
  "sourceBindingDigest", "sourceBindingId", "sourceBindingVersion", "sourceSystemId",
  "status", "taskDefinitionId", "taskDefinitionVersion", "tenantScope", "validUntil",
]);
const SCOPE_AUTHORIZATION_FIELDS = new Set([
  "authorityDigest", "contractVersion", "observedAt", "scopes", "status", "validUntil",
]);
const SCOPE_FIELDS = new Set(["grantStatus", "scopeName", "scopeType"]);
const DATA_AUTHORIZATION_FIELDS = new Set([
  "authorityDigest", "contractVersion", "policyId", "policyVersion", "resourceKind",
  "selectionMode", "status", "validUntil",
]);
const TOKEN = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,239}$/;
const DIGEST = /^[a-f0-9]{64}$/;

export function createFeishuApprovalSourceAccessGrantResolver({
  maxEvaluationAgeMs = 30_000,
  now = () => new Date(),
  resolveCurrentAuthorizationSnapshot,
  stableGrantHmacKey,
} = {}) {
  if (typeof resolveCurrentAuthorizationSnapshot !== "function") {
    throw new TypeError(
      "Feishu approval source Grant resolver requires resolveCurrentAuthorizationSnapshot",
    );
  }
  if (typeof now !== "function") {
    throw new TypeError("Feishu approval source Grant resolver requires now");
  }
  if (!Number.isSafeInteger(maxEvaluationAgeMs) || maxEvaluationAgeMs < 1_000 ||
    maxEvaluationAgeMs > 5 * 60_000) {
    throw new TypeError("Feishu approval source Grant evaluation age is invalid");
  }
  const grantKey = exactKey(stableGrantHmacKey);

  async function resolveCurrentGrant(value = {}, { signal = null } = {}) {
    const request = normalizeRequest(value);
    const operationSignal = normalizeSignal(signal);
    requireNotCanceled(operationSignal);
    const checkedAt = trustedNow(now);
    const evaluatedAtMs = Date.parse(request.evaluatedAt);
    if (evaluatedAtMs > checkedAt.getTime() ||
      checkedAt.getTime() - evaluatedAtMs > maxEvaluationAgeMs) {
      throw grantError("schedule_feishu_approval_grant_evaluation_invalid");
    }
    let rawSnapshot;
    try {
      rawSnapshot = await raceWithSignal(
        resolveCurrentAuthorizationSnapshot(request, { signal: operationSignal }),
        operationSignal,
      );
    } catch {
      if (operationSignal?.aborted) throw grantError("schedule_feishu_approval_grant_canceled");
      throw grantError("schedule_feishu_approval_grant_authority_unavailable");
    }
    requireNotCanceled(operationSignal);
    const snapshot = normalizeSnapshot(rawSnapshot);
    requireCurrentSnapshot(request, snapshot, evaluatedAtMs);
    const permissionDigest = keyedDigest(grantKey, {
      contractVersion: "feishu-approval-source-permission-evidence.v1",
      dataAccessAuthorization: {
        authorityDigest: snapshot.dataAccessAuthorization.authorityDigest,
        contractVersion: snapshot.dataAccessAuthorization.contractVersion,
        policyId: snapshot.dataAccessAuthorization.policyId,
        policyVersion: snapshot.dataAccessAuthorization.policyVersion,
        resourceKind: snapshot.dataAccessAuthorization.resourceKind,
        selectionMode: snapshot.dataAccessAuthorization.selectionMode,
        status: snapshot.dataAccessAuthorization.status,
      },
      scopeAuthorization: {
        authorityDigest: snapshot.scopeAuthorization.authorityDigest,
        contractVersion: snapshot.scopeAuthorization.contractVersion,
        scopes: snapshot.scopeAuthorization.scopes,
        status: snapshot.scopeAuthorization.status,
      },
      sourceAdapterId: SOURCE_ADAPTER_ID,
      sourceBindingDigest: request.sourceBindingDigest,
      tenantScope: request.tenantScope,
    });
    const authorityDigest = keyedDigest(grantKey, {
      accessGrantId: snapshot.accessGrantId,
      accessGrantVersion: snapshot.accessGrantVersion,
      contractVersion: "feishu-approval-source-grant-authority.v1",
      credentialBindingId: snapshot.credentialBindingId,
      credentialBindingVersion: snapshot.credentialBindingVersion,
      employeeId: request.employeeId,
      permissionDigest,
      resourceKind: request.resourceKind,
      scheduleId: request.scheduleId,
      selectionMode: request.selectionMode,
      sourceAdapterId: request.sourceAdapterId,
      sourceBindingDigest: request.sourceBindingDigest,
      sourceBindingId: request.sourceBindingId,
      sourceBindingVersion: request.sourceBindingVersion,
      sourceSystemId: request.sourceSystemId,
      taskDefinitionId: request.taskDefinitionId,
      taskDefinitionVersion: request.taskDefinitionVersion,
      tenantScope: request.tenantScope,
    });
    return deepFreeze({
      accessGrantId: snapshot.accessGrantId,
      accessGrantVersion: snapshot.accessGrantVersion,
      authorityDigest,
      contractVersion: GRANT_VERSION,
      credentialBindingId: snapshot.credentialBindingId,
      credentialBindingVersion: snapshot.credentialBindingVersion,
      employeeId: request.employeeId,
      permissionDigest,
      resourceKind: request.resourceKind,
      scheduleId: request.scheduleId,
      selectionMode: request.selectionMode,
      sourceAdapterId: SOURCE_ADAPTER_ID,
      sourceBindingDigest: request.sourceBindingDigest,
      sourceBindingId: request.sourceBindingId,
      sourceBindingVersion: request.sourceBindingVersion,
      sourceSystemId: "feishu",
      status: "active",
      taskDefinitionId: request.taskDefinitionId,
      taskDefinitionVersion: request.taskDefinitionVersion,
      tenantScope: request.tenantScope,
      validUntil: earliestTimestamp([
        snapshot.validUntil,
        snapshot.scopeAuthorization.validUntil,
        snapshot.dataAccessAuthorization.validUntil,
      ]),
    });
  }

  return Object.freeze({
    contractVersion: RESOLVER_VERSION,
    resolveCurrentGrant,
  });
}

function normalizeRequest(value) {
  exactObject(value, REQUEST_FIELDS, "schedule_feishu_approval_grant_request_invalid");
  if (value.contractVersion !== REQUEST_VERSION) {
    throw grantError("schedule_feishu_approval_grant_request_invalid");
  }
  const request = deepFreeze({
    canonicalTaskId: token(value.canonicalTaskId),
    contractVersion: REQUEST_VERSION,
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
  });
  if (request.resourceKind !== "approval_instances" ||
    request.selectionMode !== "current_authorized_scope" ||
    request.sourceAdapterId !== SOURCE_ADAPTER_ID || request.sourceSystemId !== "feishu") {
    throw grantError("schedule_feishu_approval_grant_request_invalid");
  }
  return request;
}

function normalizeSnapshot(value) {
  exactObject(value, SNAPSHOT_FIELDS, "schedule_feishu_approval_grant_snapshot_invalid");
  if (value.contractVersion !== SNAPSHOT_VERSION) {
    throw grantError("schedule_feishu_approval_grant_snapshot_invalid");
  }
  return deepFreeze({
    accessGrantId: token(value.accessGrantId),
    accessGrantVersion: positiveInteger(value.accessGrantVersion),
    contractVersion: SNAPSHOT_VERSION,
    credentialBindingId: token(value.credentialBindingId),
    credentialBindingVersion: positiveInteger(value.credentialBindingVersion),
    dataAccessAuthorization: normalizeDataAuthorization(value.dataAccessAuthorization),
    employeeId: token(value.employeeId),
    resourceKind: token(value.resourceKind),
    scheduleId: token(value.scheduleId),
    scopeAuthorization: normalizeScopeAuthorization(value.scopeAuthorization),
    selectionMode: token(value.selectionMode),
    sourceAdapterId: token(value.sourceAdapterId),
    sourceBindingDigest: digest(value.sourceBindingDigest),
    sourceBindingId: token(value.sourceBindingId),
    sourceBindingVersion: positiveInteger(value.sourceBindingVersion),
    sourceSystemId: token(value.sourceSystemId),
    status: value.status,
    taskDefinitionId: token(value.taskDefinitionId),
    taskDefinitionVersion: positiveInteger(value.taskDefinitionVersion),
    tenantScope: token(value.tenantScope),
    validUntil: timestamp(value.validUntil),
  });
}

function normalizeScopeAuthorization(value) {
  exactObject(value, SCOPE_AUTHORIZATION_FIELDS,
    "schedule_feishu_approval_scope_authorization_invalid");
  if (value.contractVersion !== SCOPE_AUTHORIZATION_VERSION || value.status !== "authorized") {
    throw grantError("schedule_feishu_approval_scope_not_granted");
  }
  if (!Array.isArray(value.scopes) || value.scopes.length !== REQUIRED_TENANT_SCOPES.length) {
    throw grantError("schedule_feishu_approval_scope_not_granted");
  }
  const scopes = value.scopes.map((entry) => {
    exactObject(entry, SCOPE_FIELDS, "schedule_feishu_approval_scope_authorization_invalid");
    const scope = deepFreeze({
      grantStatus: entry.grantStatus,
      scopeName: token(entry.scopeName),
      scopeType: entry.scopeType,
    });
    if (scope.grantStatus !== "granted" || scope.scopeType !== "tenant") {
      throw grantError("schedule_feishu_approval_scope_not_granted");
    }
    return scope;
  }).sort((left, right) => left.scopeName.localeCompare(right.scopeName));
  const names = new Set(scopes.map((entry) => entry.scopeName));
  if (names.size !== scopes.length ||
    REQUIRED_TENANT_SCOPES.some((required) => !names.has(required))) {
    throw grantError("schedule_feishu_approval_scope_not_granted");
  }
  return deepFreeze({
    authorityDigest: digest(value.authorityDigest),
    contractVersion: SCOPE_AUTHORIZATION_VERSION,
    observedAt: timestamp(value.observedAt),
    scopes,
    status: "authorized",
    validUntil: timestamp(value.validUntil),
  });
}

function normalizeDataAuthorization(value) {
  exactObject(value, DATA_AUTHORIZATION_FIELDS,
    "schedule_feishu_approval_data_authorization_invalid");
  const result = deepFreeze({
    authorityDigest: digest(value.authorityDigest),
    contractVersion: value.contractVersion,
    policyId: token(value.policyId),
    policyVersion: positiveInteger(value.policyVersion),
    resourceKind: token(value.resourceKind),
    selectionMode: token(value.selectionMode),
    status: value.status,
    validUntil: timestamp(value.validUntil),
  });
  if (result.contractVersion !== DATA_AUTHORIZATION_VERSION || result.status !== "authorized" ||
    result.resourceKind !== "approval_instances" ||
    result.selectionMode !== "current_authorized_scope") {
    throw grantError("schedule_feishu_approval_data_access_not_authorized");
  }
  return result;
}

function requireCurrentSnapshot(request, snapshot, evaluatedAtMs) {
  const matches = snapshot.status === "active" && snapshot.tenantScope === request.tenantScope &&
    snapshot.employeeId === request.employeeId && snapshot.scheduleId === request.scheduleId &&
    snapshot.taskDefinitionId === request.taskDefinitionId &&
    snapshot.taskDefinitionVersion === request.taskDefinitionVersion &&
    snapshot.sourceBindingId === request.sourceBindingId &&
    snapshot.sourceBindingVersion === request.sourceBindingVersion &&
    snapshot.sourceBindingDigest === request.sourceBindingDigest &&
    snapshot.sourceAdapterId === SOURCE_ADAPTER_ID &&
    snapshot.sourceSystemId === "feishu" && snapshot.resourceKind === "approval_instances" &&
    snapshot.selectionMode === "current_authorized_scope";
  if (!matches) throw grantError("schedule_feishu_approval_grant_snapshot_invalid");
  const observedAtMs = Date.parse(snapshot.scopeAuthorization.observedAt);
  if (observedAtMs > evaluatedAtMs || Date.parse(snapshot.validUntil) <= evaluatedAtMs ||
    Date.parse(snapshot.scopeAuthorization.validUntil) <= evaluatedAtMs ||
    Date.parse(snapshot.dataAccessAuthorization.validUntil) <= evaluatedAtMs) {
    throw grantError("schedule_feishu_approval_grant_expired");
  }
}

function raceWithSignal(value, signal) {
  if (!signal) return Promise.resolve(value);
  if (signal.aborted) return Promise.reject(grantError("schedule_feishu_approval_grant_canceled"));
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(grantError("schedule_feishu_approval_grant_canceled"));
    signal.addEventListener("abort", onAbort, { once: true });
    Promise.resolve(value).then(resolve, reject).finally(() => {
      signal.removeEventListener("abort", onAbort);
    });
  });
}

function normalizeSignal(value) {
  if (value === null || value === undefined) return null;
  if (typeof value !== "object" || typeof value.aborted !== "boolean" ||
    typeof value.addEventListener !== "function") {
    throw new TypeError("Feishu approval source Grant signal must be an AbortSignal");
  }
  return value;
}

function requireNotCanceled(signal) {
  if (signal?.aborted) throw grantError("schedule_feishu_approval_grant_canceled");
}

function exactObject(value, fields, code) {
  if (!plainObject(value)) throw grantError(code);
  const keys = Object.keys(value);
  if (keys.length !== fields.size || keys.some((key) => !fields.has(key))) {
    throw grantError(code);
  }
}

function plainObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function token(value) {
  const result = String(value || "").trim();
  if (!TOKEN.test(result) || /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(result)) {
    throw grantError("schedule_feishu_approval_grant_reference_invalid");
  }
  return result;
}

function digest(value) {
  const result = String(value || "").trim().toLowerCase();
  if (!DIGEST.test(result)) throw grantError("schedule_feishu_approval_grant_digest_invalid");
  return result;
}

function positiveInteger(value) {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw grantError("schedule_feishu_approval_grant_number_invalid");
  }
  return value;
}

function timestamp(value) {
  const result = value instanceof Date ? value.toISOString() : String(value || "").trim();
  const parsed = new Date(result);
  if (!result || !Number.isFinite(parsed.getTime()) || parsed.toISOString() !== result) {
    throw grantError("schedule_feishu_approval_grant_timestamp_invalid");
  }
  return result;
}

function earliestTimestamp(values) {
  return new Date(Math.min(...values.map((value) => Date.parse(value)))).toISOString();
}

function trustedNow(now) {
  let value;
  try { value = now(); }
  catch { throw grantError("schedule_feishu_approval_grant_clock_invalid"); }
  const result = value instanceof Date ? new Date(value.getTime()) : new Date(value);
  if (!Number.isFinite(result.getTime())) {
    throw grantError("schedule_feishu_approval_grant_clock_invalid");
  }
  return result;
}

function exactKey(value) {
  const key = Buffer.isBuffer(value) ? Buffer.from(value) : Buffer.from(value || []);
  if (key.length !== 32) {
    throw new TypeError("Feishu approval source Grant HMAC key must be 32 bytes");
  }
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
  if (result === undefined) throw grantError("schedule_feishu_approval_grant_value_invalid");
  return result;
}

function deepFreeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    Object.values(value).forEach(deepFreeze);
  }
  return value;
}

function grantError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

export {
  DATA_AUTHORIZATION_VERSION as FEISHU_APPROVAL_DATA_ACCESS_AUTHORIZATION_CONTRACT_VERSION,
  REQUIRED_TENANT_SCOPES as FEISHU_APPROVAL_SOURCE_REQUIRED_TENANT_SCOPES,
  RESOLVER_VERSION as FEISHU_APPROVAL_SOURCE_ACCESS_GRANT_RESOLVER_CONTRACT_VERSION,
  SCOPE_AUTHORIZATION_VERSION as FEISHU_TENANT_SCOPE_AUTHORIZATION_CONTRACT_VERSION,
  SNAPSHOT_VERSION as FEISHU_APPROVAL_SOURCE_GRANT_SNAPSHOT_CONTRACT_VERSION,
};
