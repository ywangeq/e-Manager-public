const ADAPTER_CONTRACT_VERSION = "enterprise-personnel-owner-snapshot-adapter.v1";
const SOURCE_RESPONSE_CONTRACT_VERSION = "enterprise-personnel-owner-authority-response.v1";
const SNAPSHOT_CONTRACT_VERSION = "enterprise-personnel-owner-snapshot.v1";
const REQUEST_FIELDS = new Set([
  "evaluatedAt",
  "purpose",
  "requiredPermission",
  "targetId",
  "targetType",
  "tenantScope",
]);
const RESPONSE_FIELDS = new Set([
  "authorityVersion",
  "contractVersion",
  "owners",
  "sourceKind",
  "sourceSystemId",
  "status",
  "targetId",
  "targetType",
  "tenantScope",
  "validFrom",
  "validUntil",
]);
const OWNER_FIELDS = new Set([
  "assigneeType",
  "assignmentId",
  "assignmentMode",
  "assignmentVersion",
  "authorization",
  "confidence",
  "membership",
  "role",
  "status",
  "subjectRef",
  "validFrom",
  "validUntil",
]);
const MEMBERSHIP_FIELDS = new Set([
  "membershipId",
  "membershipVersion",
  "status",
  "subjectRef",
  "targetId",
  "targetType",
  "validFrom",
  "validUntil",
]);
const AUTHORIZATION_FIELDS = new Set([
  "authorizationVersion",
  "issuer",
  "permissionVersion",
  "permissions",
  "purpose",
  "status",
  "subjectRef",
  "validFrom",
  "validUntil",
]);
const TARGET_TYPES = new Set(["department", "digital_employee"]);
const TOKEN = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,159}$/;

function createEnterprisePersonnelOwnerSnapshotAdapter({
  allowlistedSourceSystemIds,
  fetchCurrentOwnerAuthority,
} = {}) {
  if (typeof fetchCurrentOwnerAuthority !== "function") {
    throw adapterError("enterprise_personnel_owner_adapter_source_required");
  }
  const allowlist = sourceAllowlist(allowlistedSourceSystemIds);

  async function readCurrentAuthoritySnapshot(value = {}) {
    const request = normalizeRequest(value);
    let response;
    try {
      response = await fetchCurrentOwnerAuthority(request);
    } catch {
      throw adapterError("enterprise_personnel_owner_adapter_source_unavailable");
    }
    return normalizeResponse(response, request, allowlist);
  }

  return Object.freeze({
    contractVersion: ADAPTER_CONTRACT_VERSION,
    readCurrentAuthoritySnapshot,
  });
}

function normalizeRequest(value) {
  exactObject(value, REQUEST_FIELDS, "enterprise_personnel_owner_adapter_request_invalid");
  return Object.freeze({
    tenantScope: token(value.tenantScope),
    targetType: enumValue(value.targetType, TARGET_TYPES),
    targetId: token(value.targetId),
    purpose: token(value.purpose),
    requiredPermission: token(value.requiredPermission),
    evaluatedAt: timestamp(value.evaluatedAt),
  });
}

function normalizeResponse(value, request, allowlist) {
  exactObject(value, RESPONSE_FIELDS, "enterprise_personnel_owner_adapter_response_invalid");
  if (value.contractVersion !== SOURCE_RESPONSE_CONTRACT_VERSION ||
    value.sourceKind !== "enterprise_personnel_authority" || value.status !== "active") {
    throw adapterError("enterprise_personnel_owner_adapter_response_invalid");
  }
  const sourceSystemId = token(value.sourceSystemId);
  if (!allowlist.has(sourceSystemId)) {
    throw adapterError("enterprise_personnel_owner_adapter_source_not_allowed");
  }
  const identity = {
    tenantScope: token(value.tenantScope),
    targetType: enumValue(value.targetType, TARGET_TYPES),
    targetId: token(value.targetId),
  };
  if (identity.tenantScope !== request.tenantScope || identity.targetType !== request.targetType ||
    identity.targetId !== request.targetId) {
    throw adapterError("enterprise_personnel_owner_adapter_target_mismatch");
  }
  if (!Array.isArray(value.owners) || value.owners.length !== 1) {
    throw adapterError("enterprise_personnel_owner_adapter_assignment_not_unique");
  }
  const owner = normalizeOwner(value.owners[0], request, identity);
  const validFrom = timestamp(value.validFrom);
  const validUntil = timestamp(value.validUntil);
  requireLive(validFrom, validUntil, request.evaluatedAt);
  return deepFreeze({
    contractVersion: SNAPSHOT_CONTRACT_VERSION,
    ...identity,
    sourceKind: "enterprise_personnel_authority",
    sourceSystemId,
    authorityVersion: token(value.authorityVersion),
    status: "active",
    validFrom,
    validUntil,
    assignments: [owner],
  });
}

function normalizeOwner(value, request, identity) {
  exactObject(value, OWNER_FIELDS, "enterprise_personnel_owner_adapter_assignment_invalid");
  const owner = {
    assignmentId: token(value.assignmentId),
    assignmentVersion: positiveInteger(value.assignmentVersion),
    role: value.role,
    assigneeType: value.assigneeType,
    subjectRef: token(value.subjectRef),
    status: value.status,
    assignmentMode: value.assignmentMode,
    confidence: value.confidence,
    validFrom: timestamp(value.validFrom),
    validUntil: timestamp(value.validUntil),
    membership: normalizeMembership(value.membership),
    authorization: normalizeAuthorization(value.authorization),
  };
  if (owner.role !== "businessOwner" || owner.assigneeType !== "user" || owner.status !== "active" ||
    owner.assignmentMode !== "direct" || owner.confidence !== "authoritative") {
    throw adapterError("enterprise_personnel_owner_adapter_assignment_invalid");
  }
  if (owner.membership.subjectRef !== owner.subjectRef || owner.membership.targetType !== identity.targetType ||
    owner.membership.targetId !== identity.targetId || owner.authorization.subjectRef !== owner.subjectRef) {
    throw adapterError("enterprise_personnel_owner_adapter_binding_mismatch");
  }
  if (owner.authorization.purpose !== request.purpose ||
    !owner.authorization.permissions.includes(request.requiredPermission)) {
    throw adapterError("enterprise_personnel_owner_adapter_permission_missing");
  }
  for (const item of [owner, owner.membership, owner.authorization]) {
    requireLive(item.validFrom, item.validUntil, request.evaluatedAt);
  }
  return owner;
}

function normalizeMembership(value) {
  exactObject(value, MEMBERSHIP_FIELDS, "enterprise_personnel_owner_adapter_membership_invalid");
  if (value.status !== "active") throw adapterError("enterprise_personnel_owner_adapter_membership_invalid");
  return {
    membershipId: token(value.membershipId),
    membershipVersion: token(value.membershipVersion),
    status: "active",
    subjectRef: token(value.subjectRef),
    targetType: enumValue(value.targetType, TARGET_TYPES),
    targetId: token(value.targetId),
    validFrom: timestamp(value.validFrom),
    validUntil: timestamp(value.validUntil),
  };
}

function normalizeAuthorization(value) {
  exactObject(value, AUTHORIZATION_FIELDS, "enterprise_personnel_owner_adapter_authorization_invalid");
  if (value.status !== "active" || !Array.isArray(value.permissions) ||
    value.permissions.length < 1 || value.permissions.length > 100) {
    throw adapterError("enterprise_personnel_owner_adapter_authorization_invalid");
  }
  return {
    authorizationVersion: token(value.authorizationVersion),
    issuer: token(value.issuer),
    permissionVersion: token(value.permissionVersion),
    permissions: [...new Set(value.permissions.map(token))].sort(),
    purpose: token(value.purpose),
    status: "active",
    subjectRef: token(value.subjectRef),
    validFrom: timestamp(value.validFrom),
    validUntil: timestamp(value.validUntil),
  };
}

function sourceAllowlist(value) {
  if (!Array.isArray(value) || value.length < 1 || value.length > 20) {
    throw adapterError("enterprise_personnel_owner_adapter_source_allowlist_invalid");
  }
  return new Set(value.map(token));
}

function exactObject(value, fields, code) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw adapterError(code);
  const keys = Object.keys(value);
  if (keys.length !== fields.size || keys.some((key) => !fields.has(key))) throw adapterError(code);
}

function token(value) {
  const result = String(value || "").trim();
  if (!TOKEN.test(result) || result.includes("@")) {
    throw adapterError("enterprise_personnel_owner_adapter_token_invalid");
  }
  return result;
}

function enumValue(value, allowed) {
  if (!allowed.has(value)) throw adapterError("enterprise_personnel_owner_adapter_enum_invalid");
  return value;
}

function positiveInteger(value) {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw adapterError("enterprise_personnel_owner_adapter_number_invalid");
  }
  return value;
}

function timestamp(value) {
  const result = String(value || "").trim();
  const parsed = new Date(result);
  if (!result || !Number.isFinite(parsed.getTime()) || parsed.toISOString() !== result) {
    throw adapterError("enterprise_personnel_owner_adapter_timestamp_invalid");
  }
  return result;
}

function requireLive(validFrom, validUntil, evaluatedAt) {
  if (validFrom >= validUntil || evaluatedAt < validFrom || evaluatedAt >= validUntil) {
    throw adapterError("enterprise_personnel_owner_adapter_authority_expired");
  }
}

function adapterError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

function deepFreeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    Object.values(value).forEach(deepFreeze);
  }
  return value;
}

export {
  ADAPTER_CONTRACT_VERSION as ENTERPRISE_PERSONNEL_OWNER_SNAPSHOT_ADAPTER_CONTRACT_VERSION,
  SOURCE_RESPONSE_CONTRACT_VERSION as ENTERPRISE_PERSONNEL_OWNER_AUTHORITY_RESPONSE_CONTRACT_VERSION,
  createEnterprisePersonnelOwnerSnapshotAdapter,
};
