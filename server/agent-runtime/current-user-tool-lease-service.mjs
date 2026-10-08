import crypto from "node:crypto";

const SERVICE_CONTRACT_VERSION = "current-user-tool-credential-lease-service.v1";
const EXECUTION_IDENTITY_CONTRACT_VERSION = "current-user-tool-execution-identity.v1";
const GRANT_CONTRACT_VERSION = "current-user-tool-access-grant.v1";
const ISSUED_CREDENTIAL_CONTRACT_VERSION = "current-user-tool-issued-credential.v1";
const LEASE_CONTRACT_VERSION = "current-user-tool-credential-lease.v1";
const DIGEST = /^[a-f0-9]{64}$/;
const TOKEN = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,239}$/;

function createCurrentUserToolCredentialLeaseService({
  bindingRegistry,
  issuerAdapters = [],
  now = () => new Date(),
  renewalSkewMs = 30_000,
} = {}) {
  if (typeof bindingRegistry?.bindingFor !== "function") throw new TypeError("current_user_tool_credential_binding_registry_required");
  if (typeof now !== "function" || !Number.isSafeInteger(renewalSkewMs) || renewalSkewMs < 0 || renewalSkewMs > 60_000) {
    throw new TypeError("current_user_tool_credential_lease_service_invalid");
  }
  const issuers = new Map();
  for (const adapter of Array.isArray(issuerAdapters) ? issuerAdapters.filter(Boolean) : []) {
    const adapterId = requiredToken(adapter.adapterId, "current_user_tool_credential_issuer_invalid");
    if (typeof adapter.issueCredentialLease !== "function" || issuers.has(adapterId)) {
      throw new TypeError("current_user_tool_credential_issuer_invalid");
    }
    issuers.set(adapterId, adapter);
  }
  const cache = new Map();
  const leaseKeyByRef = new Map();
  const pending = new Map();

  function bindingFor(toolId) {
    return bindingRegistry.bindingFor(toolId);
  }

  async function acquireForOperation({ employeeId = "", executionIdentity, forceRefresh = false, operation = null, signal = null, toolId = "" } = {}) {
    requireNotCanceled(signal);
    const binding = bindingFor(toolId);
    if (!binding) throw leaseError("current_user_tool_credential_binding_unavailable");
    const identity = normalizeExecutionIdentity(executionIdentity, trustedNow(now));
    const scopes = normalizeOperationScopes(operation, binding.toolId);
    const scopeDigest = digestCanonical(scopes);
    const normalizedEmployeeId = optionalToken(employeeId, "current_user_tool_employee_invalid");
    const key = cacheKey({ binding, employeeId: normalizedEmployeeId, identity, scopeDigest });
    if (forceRefresh) evictKey(key);
    const checkedAt = trustedNow(now);
    const cached = cache.get(key);
    if (cached && Date.parse(cached.expiresAt) - renewalSkewMs > checkedAt.getTime()) return cached;
    evictKey(key);
    if (pending.has(key)) return await awaitWithAbort(pending.get(key), signal);
    const resolution = issueLease({ binding, checkedAt, employeeId: normalizedEmployeeId, identity, key, operation, scopeDigest, scopes, signal });
    pending.set(key, resolution);
    try {
      return await resolution;
    } finally {
      pending.delete(key);
    }
  }

  async function issueLease({ binding, checkedAt, employeeId, identity, key, operation, scopeDigest, scopes, signal }) {
    const issuer = issuers.get(binding.issuerAdapterId);
    if (!issuer) throw leaseError("current_user_tool_credential_issuer_unavailable");
    const grantValidUntil = earliestTimestamp([
      identity.authorizationValidUntil,
      new Date(checkedAt.getTime() + binding.maxLeaseDurationMs).toISOString(),
    ]);
    const grantCore = {
      contractVersion: GRANT_CONTRACT_VERSION,
      tenantScope: identity.tenantScope,
      actorIssuer: identity.actorIssuer,
      actorSubjectDigest: identity.actorSubjectDigest,
      identitySource: identity.identitySource,
      subjectId: identity.subjectId,
      subjectIdType: identity.subjectIdType,
      ...(identity.subjectDisplayName ? { subjectDisplayName: identity.subjectDisplayName } : {}),
      ...(identity.departmentRefs.length ? { departmentRefs: identity.departmentRefs } : {}),
      permissionVersion: identity.permissionVersion,
      ...(employeeId ? { employeeId } : {}),
      toolId: binding.toolId,
      bindingId: binding.bindingId,
      bindingVersion: binding.bindingVersion,
      issuerAdapterId: binding.issuerAdapterId,
      audience: binding.audience,
      operationId: requiredToken(operation?.operationId, "current_user_tool_operation_invalid"),
      scopes,
      validUntil: grantValidUntil,
    };
    const grant = Object.freeze({ ...grantCore, grantAuthorityDigest: digestCanonical(grantCore) });
    let issued;
    try {
      issued = await issuer.issueCredentialLease(grant, { signal });
    } catch (error) {
      if (signal?.aborted) throw leaseError("current_user_tool_credential_lease_canceled");
      const safeCode = new Set([
        "current_user_tool_authorization_required",
        "current_user_tool_credential_issuer_unconfigured",
      ]).has(error?.code) ? error.code : "current_user_tool_credential_issuer_unavailable";
      const wrapped = leaseError(safeCode);
      const authorizationAction = safeAuthorizationAction(error?.authorizationAction);
      if (authorizationAction) wrapped.authorizationAction = authorizationAction;
      throw wrapped;
    }
    requireNotCanceled(signal);
    const credential = normalizeIssuedCredential(issued, grant, checkedAt);
    const issuedAt = trustedNow(now);
    const expiresAt = earliestTimestamp([grant.validUntil, credential.expiresAt]);
    if (Date.parse(expiresAt) <= issuedAt.getTime()) throw leaseError("current_user_tool_credential_lease_expired");
    const leaseRef = `tool-credential-lease:${crypto.randomUUID()}`;
    const lease = Object.freeze({
      contractVersion: LEASE_CONTRACT_VERSION,
      leaseRef,
      toolId: binding.toolId,
      issuerAdapterId: binding.issuerAdapterId,
      actorSubjectDigest: identity.actorSubjectDigest,
      audience: binding.audience,
      scopesDigest: scopeDigest,
      permissionVersion: identity.permissionVersion,
      bindingVersion: binding.bindingVersion,
      issuedAt: credential.issuedAt,
      expiresAt,
      authorization: `Bearer ${credential.accessToken}`,
    });
    cache.set(key, lease);
    leaseKeyByRef.set(leaseRef, key);
    return lease;
  }

  function invalidate(leaseRef) {
    const key = leaseKeyByRef.get(String(leaseRef || ""));
    if (!key) return false;
    evictKey(key);
    return true;
  }

  function revokeSubject(actorSubjectDigest) {
    const digest = requiredDigest(actorSubjectDigest, "current_user_tool_execution_identity_invalid");
    let revoked = 0;
    for (const [key, lease] of cache) {
      if (lease.actorSubjectDigest !== digest) continue;
      evictKey(key);
      revoked += 1;
    }
    for (const issuer of issuers.values()) issuer.revokeSubject?.(digest);
    return revoked;
  }

  function evictKey(key) {
    const lease = cache.get(key);
    if (lease) leaseKeyByRef.delete(lease.leaseRef);
    cache.delete(key);
  }

  return Object.freeze({
    acquireForOperation,
    bindingFor,
    contractVersion: SERVICE_CONTRACT_VERSION,
    invalidate,
    revokeSubject,
  });
}

function normalizeExecutionIdentity(value, checkedAt) {
  if (!plainObject(value) || value.contractVersion !== EXECUTION_IDENTITY_CONTRACT_VERSION || value.accountStatus !== "active") {
    throw leaseError("current_user_tool_execution_identity_invalid");
  }
  const authorizationValidUntil = timestamp(value.authorizationValidUntil, "current_user_tool_execution_identity_invalid");
  if (Date.parse(authorizationValidUntil) <= checkedAt.getTime()) throw leaseError("current_user_tool_execution_identity_expired");
  const subjectIdType = requiredToken(value.subjectIdType, "current_user_tool_execution_identity_invalid");
  const subjectId = subjectIdType === "verified_email_alias"
    ? canonicalEmail(value.subjectId)
    : boundedText(value.subjectId, 240, "current_user_tool_execution_identity_invalid");
  return Object.freeze({
    contractVersion: EXECUTION_IDENTITY_CONTRACT_VERSION,
    accountStatus: "active",
    tenantScope: requiredToken(value.tenantScope, "current_user_tool_execution_identity_invalid"),
    actorIssuer: requiredToken(value.actorIssuer, "current_user_tool_execution_identity_invalid"),
    actorSubjectDigest: requiredDigest(value.actorSubjectDigest, "current_user_tool_execution_identity_invalid"),
    identitySource: requiredToken(value.identitySource, "current_user_tool_execution_identity_invalid"),
    subjectId,
    subjectIdType,
    subjectDisplayName: optionalBoundedText(value.subjectDisplayName, 120, "current_user_tool_execution_identity_invalid"),
    departmentRefs: Object.freeze(uniqueBoundedTexts(value.departmentRefs, 20, 160, "current_user_tool_execution_identity_invalid")),
    permissionVersion: requiredToken(value.permissionVersion, "current_user_tool_execution_identity_invalid"),
    authorizationValidUntil,
  });
}

function normalizeOperationScopes(operation, toolId) {
  if (!plainObject(operation) || operation.toolId !== toolId || !requiredToken(operation.operationId, "current_user_tool_operation_invalid")) {
    throw leaseError("current_user_tool_operation_invalid");
  }
  const scopes = [...new Set((Array.isArray(operation.scope) ? operation.scope : [])
    .map((scope) => requiredToken(scope, "current_user_tool_operation_scope_invalid")))].sort();
  if (!scopes.length) throw leaseError("current_user_tool_operation_scope_invalid");
  return Object.freeze(scopes);
}

function normalizeIssuedCredential(value, grant, checkedAt) {
  if (!plainObject(value) || value.contractVersion !== ISSUED_CREDENTIAL_CONTRACT_VERSION ||
    value.issuerAdapterId !== grant.issuerAdapterId || value.audience !== grant.audience || value.subjectId !== grant.subjectId) {
    throw leaseError("current_user_tool_issued_credential_invalid");
  }
  const scopes = [...new Set((Array.isArray(value.scopes) ? value.scopes : []).map((scope) => String(scope || "").trim()).filter(Boolean))].sort();
  if (JSON.stringify(scopes) !== JSON.stringify(grant.scopes)) throw leaseError("current_user_tool_issued_credential_invalid");
  const accessToken = boundedSecret(value.accessToken);
  const issuedAt = timestamp(value.issuedAt, "current_user_tool_issued_credential_invalid");
  const expiresAt = timestamp(value.expiresAt, "current_user_tool_issued_credential_invalid");
  if (Date.parse(issuedAt) > checkedAt.getTime() + 5_000 || Date.parse(expiresAt) <= checkedAt.getTime()) {
    throw leaseError("current_user_tool_issued_credential_invalid");
  }
  return Object.freeze({ accessToken, expiresAt, issuedAt });
}

function cacheKey({ binding, employeeId = "", identity, scopeDigest }) {
  return JSON.stringify([
    identity.tenantScope,
    identity.identitySource,
    identity.subjectIdType,
    identity.actorSubjectDigest,
    employeeId,
    binding.toolId,
    binding.audience,
    scopeDigest,
    identity.permissionVersion,
    digestCanonical([identity.subjectDisplayName, identity.departmentRefs]),
    binding.bindingVersion,
  ]);
}

function earliestTimestamp(values) {
  return new Date(Math.min(...values.map((value) => Date.parse(timestamp(value))))).toISOString();
}

function trustedNow(now) {
  const value = now();
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) throw new TypeError("current_user_tool_credential_clock_invalid");
  return date;
}

function timestamp(value, code = "current_user_tool_credential_time_invalid") {
  const text = String(value || "");
  if (!Number.isFinite(Date.parse(text))) throw leaseError(code);
  return new Date(text).toISOString();
}

function requiredToken(value, code) {
  const token = String(value || "").trim();
  if (!TOKEN.test(token)) throw leaseError(code);
  return token;
}

function optionalToken(value, code) {
  if (value === undefined || value === null || value === "") return "";
  return requiredToken(value, code);
}

function safeAuthorizationAction(value) {
  if (!plainObject(value) || value.contractVersion !== "current-user-tool-authorization-action.v1" || value.kind !== "open_url") return null;
  try {
    const url = new URL(String(value.url || ""));
    if (url.protocol !== "https:" || url.hostname !== "accounts.feishu.cn" || url.pathname !== "/open-apis/authen/v1/authorize") return null;
    return Object.freeze({
      contractVersion: value.contractVersion,
      kind: value.kind,
      label: boundedText(value.label, 80, "current_user_tool_authorization_action_invalid"),
      url: url.toString(),
      expiresAt: timestamp(value.expiresAt, "current_user_tool_authorization_action_invalid"),
    });
  } catch {
    return null;
  }
}

function requiredDigest(value, code) {
  const digest = String(value || "").trim().toLowerCase();
  if (!DIGEST.test(digest)) throw leaseError(code);
  return digest;
}

function boundedText(value, maxLength, code) {
  const text = String(value || "").trim();
  if (!text || text.length > maxLength || /[\r\n\0]/.test(text)) throw leaseError(code);
  return text;
}

function optionalBoundedText(value, maxLength, code) {
  if (value === undefined || value === null || value === "") return "";
  return boundedText(value, maxLength, code);
}

function uniqueBoundedTexts(value, maxItems, maxLength, code) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.length > maxItems) throw leaseError(code);
  return [...new Set(value.map((item) => boundedText(item, maxLength, code)))];
}

function canonicalEmail(value) {
  const email = String(value || "").trim().toLowerCase();
  if (email.length > 240 || /[\s\x00-\x1f\x7f]/.test(email) ||
    !/^[^@]+@[^@]+$/.test(email) || email.startsWith("@") || email.endsWith("@")) {
    throw leaseError("current_user_tool_execution_identity_invalid");
  }
  return email;
}

function boundedSecret(value) {
  const token = String(value || "").trim();
  if (!token || token.length > 8 * 1024 || /\s/.test(token)) throw leaseError("current_user_tool_issued_credential_invalid");
  return token;
}

function digestCanonical(value) {
  return crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function requireNotCanceled(signal) {
  if (signal?.aborted) throw leaseError("current_user_tool_credential_lease_canceled");
}

function awaitWithAbort(promise, signal) {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(leaseError("current_user_tool_credential_lease_canceled"));
  return new Promise((resolve, reject) => {
    const canceled = () => reject(leaseError("current_user_tool_credential_lease_canceled"));
    signal.addEventListener("abort", canceled, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", canceled));
  });
}

function plainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value) &&
    [Object.prototype, null].includes(Object.getPrototypeOf(value));
}

function leaseError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

export {
  EXECUTION_IDENTITY_CONTRACT_VERSION,
  GRANT_CONTRACT_VERSION,
  ISSUED_CREDENTIAL_CONTRACT_VERSION,
  LEASE_CONTRACT_VERSION,
  SERVICE_CONTRACT_VERSION,
  createCurrentUserToolCredentialLeaseService,
};
