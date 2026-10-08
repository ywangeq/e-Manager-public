import crypto from "node:crypto";

const SNAPSHOT_CONTRACT_VERSION = "enterprise-personnel-owner-snapshot.v1";
const RESOLUTION_CONTRACT_VERSION = "enterprise-business-owner-resolution.v1";
const RECIPIENT_RESOLUTION_CONTRACT_VERSION = "enterprise-business-owner-recipient-resolution.v1";
const PURPOSE = "schedule_business_owner_acceptance";
const PERMISSION = "schedule:business_owner_accept";
const RECIPIENT_PURPOSE = "schedule_business_owner_alert_recipient";
const RECIPIENT_PERMISSION = "schedule:business_owner_receive_alert";
const REQUEST_FIELDS = new Set([
  "currentActor",
  "purpose",
  "requiredPermission",
  "targetId",
  "targetType",
  "tenantScope",
]);
const CURRENT_ACTOR_FIELDS = new Set(["issuer", "subjectRef"]);
const RECIPIENT_REQUEST_FIELDS = new Set(["targetId", "targetType", "tenantScope"]);
const SNAPSHOT_FIELDS = new Set([
  "assignments",
  "authorityVersion",
  "contractVersion",
  "sourceKind",
  "sourceSystemId",
  "status",
  "targetId",
  "targetType",
  "tenantScope",
  "validFrom",
  "validUntil",
]);
const ASSIGNMENT_FIELDS = new Set([
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
const TOKEN_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,159}$/;
const DIGEST_PATTERN = /^[a-f0-9]{64}$/;

export function createEnterpriseBusinessOwnerAuthorityResolver({
  readCurrentAuthoritySnapshot,
  hmacKey,
  hmacKeyVersion,
  allowlistedSourceSystemIds,
  now = () => new Date(),
} = {}) {
  if (typeof readCurrentAuthoritySnapshot !== "function") {
    throw authorityError("enterprise_business_owner_authority_source_required");
  }
  const secret = normalizeHmacKey(hmacKey);
  const keyVersion = token(hmacKeyVersion, "hmacKeyVersion");
  const allowedSourceSystems = normalizeSourceSystemAllowlist(allowlistedSourceSystemIds);
  if (typeof now !== "function") throw authorityError("enterprise_business_owner_authority_clock_invalid");

  async function resolveCurrentBusinessOwnerAuthority(value = {}) {
    const request = normalizeRequest(value, now);
    let source;
    try {
      source = await readCurrentAuthoritySnapshot({
        tenantScope: request.tenantScope,
        targetType: request.targetType,
        targetId: request.targetId,
        purpose: PURPOSE,
        requiredPermission: PERMISSION,
        evaluatedAt: request.evaluatedAt,
      });
    } catch {
      throw authorityError("enterprise_business_owner_authority_source_unavailable");
    }
    const snapshot = normalizeSnapshot(source, request, allowedSourceSystems);
    const assignment = snapshot.assignments[0];
    const subjectDigest = hmacDigest(secret, {
      domain: "enterprise-business-owner-subject.v1",
      hmacKeyVersion: keyVersion,
      tenantScope: snapshot.tenantScope,
      issuer: assignment.authorization.issuer,
      subjectRef: assignment.subjectRef,
    });
    const currentActorSubjectDigest = hmacDigest(secret, {
      domain: "enterprise-business-owner-subject.v1",
      hmacKeyVersion: keyVersion,
      tenantScope: snapshot.tenantScope,
      issuer: request.currentActor.issuer,
      subjectRef: request.currentActor.subjectRef,
    });
    if (request.currentActor.issuer !== assignment.authorization.issuer ||
      currentActorSubjectDigest !== subjectDigest) {
      throw authorityError("enterprise_business_owner_authority_actor_mismatch");
    }
    const assignmentDigest = canonicalDigest({
      contractVersion: "digital-employee-business-owner-assignment.v1",
      tenantScope: snapshot.tenantScope,
      targetType: snapshot.targetType,
      targetId: snapshot.targetId,
      authorityVersion: snapshot.authorityVersion,
      assignmentId: assignment.assignmentId,
      assignmentVersion: assignment.assignmentVersion,
      assignmentMode: assignment.assignmentMode,
      confidence: assignment.confidence,
      role: assignment.role,
      assigneeType: assignment.assigneeType,
      assigneeSubjectDigest: subjectDigest,
      status: assignment.status,
      validFrom: assignment.validFrom,
      validUntil: assignment.validUntil,
    });
    const ownerMembershipDigest = canonicalDigest({
      contractVersion: "personnel-owner-membership.v1",
      tenantScope: snapshot.tenantScope,
      targetType: snapshot.targetType,
      targetId: snapshot.targetId,
      authorityVersion: snapshot.authorityVersion,
      assignmentDigest,
      membershipId: assignment.membership.membershipId,
      membershipVersion: assignment.membership.membershipVersion,
      status: assignment.membership.status,
      subjectDigest,
      validFrom: assignment.membership.validFrom,
      validUntil: assignment.membership.validUntil,
    });
    const permissionDigest = canonicalDigest({
      contractVersion: "personnel-owner-permission-set.v1",
      permissionVersion: assignment.authorization.permissionVersion,
      purpose: PURPOSE,
      requiredPermission: PERMISSION,
    });
    const authorizationDigest = canonicalDigest({
      contractVersion: "personnel-owner-authorization.v1",
      tenantScope: snapshot.tenantScope,
      targetType: snapshot.targetType,
      targetId: snapshot.targetId,
      authorityVersion: snapshot.authorityVersion,
      authorizationVersion: assignment.authorization.authorizationVersion,
      issuer: assignment.authorization.issuer,
      ownerMembershipDigest,
      permissionDigest,
      purpose: PURPOSE,
      status: assignment.authorization.status,
      subjectDigest,
      validFrom: assignment.authorization.validFrom,
      validUntil: assignment.authorization.validUntil,
    });
    const authorityDigest = canonicalDigest({
      contractVersion: "personnel-owner-authority.v1",
      tenantScope: snapshot.tenantScope,
      targetType: snapshot.targetType,
      targetId: snapshot.targetId,
      sourceKind: snapshot.sourceKind,
      sourceSystemId: snapshot.sourceSystemId,
      authorityVersion: snapshot.authorityVersion,
      status: snapshot.status,
      hmacKeyVersion: keyVersion,
      assignmentDigest,
      ownerMembershipDigest,
      authorizationDigest,
      validFrom: snapshot.validFrom,
      validUntil: snapshot.validUntil,
    });
    const authorityValidUntil = earliestTimestamp([
      snapshot.validUntil,
      assignment.validUntil,
      assignment.membership.validUntil,
      assignment.authorization.validUntil,
    ]);
    const ownerAssignment = {
      contractVersion: "digital-employee-business-owner-assignment.v1",
      role: "businessOwner",
      assigneeType: "user",
      assignmentVersion: assignment.assignmentVersion,
      assigneeSubjectDigest: subjectDigest,
      assignmentDigest,
    };
    const personnelAuthority = {
      contractVersion: "personnel-owner-authority.v1",
      authorityVersion: snapshot.authorityVersion,
      authorityDigest,
      ownerMembershipDigest,
    };
    const ownerAuthorization = {
      issuer: assignment.authorization.issuer,
      subjectDigest,
      authorizationDigest,
      permissionDigest,
      ownerMembershipDigest,
    };
    const resolutionBody = {
      contractVersion: RESOLUTION_CONTRACT_VERSION,
      ownerAssignment,
      personnelAuthority,
      ownerAuthorization,
      authorityValidUntil,
    };
    return deepFreeze({ ...resolutionBody, resolutionDigest: canonicalDigest(resolutionBody) });
  }

  async function revalidateCurrentBusinessOwnerAuthority({ expectedResolutionDigest, ...value } = {}) {
    const expected = requiredDigest(expectedResolutionDigest, "expectedResolutionDigest");
    const current = await resolveCurrentBusinessOwnerAuthority(value);
    if (current.resolutionDigest !== expected) {
      throw authorityError("enterprise_business_owner_authority_stale");
    }
    return current;
  }

  return Object.freeze({
    contractVersion: RESOLUTION_CONTRACT_VERSION,
    resolveCurrentBusinessOwnerAuthority,
    revalidateCurrentBusinessOwnerAuthority,
  });
}

export function createEnterpriseBusinessOwnerRecipientAuthorityResolver({
  readCurrentAuthoritySnapshot,
  hmacKey,
  hmacKeyVersion,
  allowlistedSourceSystemIds,
  now = () => new Date(),
} = {}) {
  if (typeof readCurrentAuthoritySnapshot !== "function") {
    throw authorityError("enterprise_business_owner_authority_source_required");
  }
  const secret = normalizeHmacKey(hmacKey);
  const keyVersion = token(hmacKeyVersion, "hmacKeyVersion");
  const allowedSourceSystems = normalizeSourceSystemAllowlist(allowlistedSourceSystemIds);
  if (typeof now !== "function") throw authorityError("enterprise_business_owner_authority_clock_invalid");

  async function resolveCurrentBusinessOwnerRecipient(value = {}) {
    exactObject(value, RECIPIENT_REQUEST_FIELDS,
      "enterprise_business_owner_recipient_request_invalid");
    const request = {
      tenantScope: token(value.tenantScope, "tenantScope"),
      targetType: enumValue(value.targetType, TARGET_TYPES, "targetType"),
      targetId: token(value.targetId, "targetId"),
      purpose: RECIPIENT_PURPOSE,
      requiredPermission: RECIPIENT_PERMISSION,
      evaluatedAt: trustedTimestamp(now),
    };
    let source;
    try {
      source = await readCurrentAuthoritySnapshot({ ...request });
    } catch {
      throw authorityError("enterprise_business_owner_authority_source_unavailable");
    }
    const snapshot = normalizeSnapshot(source, request, allowedSourceSystems);
    const assignment = snapshot.assignments[0];
    const recipientPrincipalDigest = hmacDigest(secret, {
      domain: "enterprise-business-owner-subject.v1",
      hmacKeyVersion: keyVersion,
      tenantScope: snapshot.tenantScope,
      issuer: assignment.authorization.issuer,
      subjectRef: assignment.subjectRef,
    });
    const recipientAuthorityDigest = canonicalDigest({
      contractVersion: "enterprise-business-owner-recipient-authority.v1",
      tenantScope: snapshot.tenantScope,
      targetType: snapshot.targetType,
      targetId: snapshot.targetId,
      sourceSystemId: snapshot.sourceSystemId,
      authorityVersion: snapshot.authorityVersion,
      assignmentId: assignment.assignmentId,
      assignmentVersion: assignment.assignmentVersion,
      membershipId: assignment.membership.membershipId,
      membershipVersion: assignment.membership.membershipVersion,
      authorizationVersion: assignment.authorization.authorizationVersion,
      permissionVersion: assignment.authorization.permissionVersion,
      purpose: RECIPIENT_PURPOSE,
      requiredPermission: RECIPIENT_PERMISSION,
      recipientPrincipalDigest,
    });
    const body = {
      authorityValidUntil: earliestTimestamp([
        snapshot.validUntil,
        assignment.validUntil,
        assignment.membership.validUntil,
        assignment.authorization.validUntil,
      ]),
      contractVersion: RECIPIENT_RESOLUTION_CONTRACT_VERSION,
      recipientAuthorityDigest,
      recipientGeneration: assignment.assignmentVersion,
      recipientPrincipalDigest,
      recipientRole: "business_owner",
    };
    return deepFreeze({ ...body, resolutionDigest: canonicalDigest(body) });
  }

  return Object.freeze({
    contractVersion: RECIPIENT_RESOLUTION_CONTRACT_VERSION,
    resolveCurrentBusinessOwnerRecipient,
  });
}

function normalizeRequest(value, now) {
  exactObject(value, REQUEST_FIELDS, "enterprise_business_owner_authority_request_invalid");
  const tenantScope = token(value.tenantScope, "tenantScope");
  const targetType = enumValue(value.targetType, TARGET_TYPES, "targetType");
  const targetId = token(value.targetId, "targetId");
  if (value.purpose !== PURPOSE || value.requiredPermission !== PERMISSION) {
    throw authorityError("enterprise_business_owner_authority_request_invalid");
  }
  exactObject(value.currentActor, CURRENT_ACTOR_FIELDS, "enterprise_business_owner_authority_actor_invalid");
  const currentActor = {
    issuer: nonPiiIssuer(value.currentActor.issuer, "currentActor.issuer"),
    subjectRef: token(value.currentActor.subjectRef, "currentActor.subjectRef"),
  };
  let trustedNow;
  try {
    trustedNow = now();
  } catch {
    throw authorityError("enterprise_business_owner_authority_clock_invalid");
  }
  return {
    tenantScope,
    targetType,
    targetId,
    purpose: PURPOSE,
    requiredPermission: PERMISSION,
    currentActor,
    evaluatedAt: canonicalTimestamp(trustedNow, "evaluatedAt"),
  };
}

function trustedTimestamp(now) {
  let value;
  try { value = now(); }
  catch { throw authorityError("enterprise_business_owner_authority_clock_invalid"); }
  return canonicalTimestamp(value, "evaluatedAt");
}

function normalizeSnapshot(value, request, allowedSourceSystems) {
  exactObject(value, SNAPSHOT_FIELDS, "enterprise_business_owner_authority_snapshot_invalid");
  if (value.contractVersion !== SNAPSHOT_CONTRACT_VERSION ||
    value.sourceKind !== "enterprise_personnel_authority") {
    throw authorityError("enterprise_business_owner_authority_snapshot_invalid");
  }
  if (!Array.isArray(value.assignments) || value.assignments.length > 10) {
    throw authorityError("enterprise_business_owner_authority_snapshot_invalid");
  }
  const sourceSystemId = token(value.sourceSystemId, "snapshot.sourceSystemId");
  if (!allowedSourceSystems.has(sourceSystemId)) {
    throw authorityError("enterprise_business_owner_authority_source_not_allowed");
  }
  const snapshot = {
    contractVersion: SNAPSHOT_CONTRACT_VERSION,
    tenantScope: token(value.tenantScope, "snapshot.tenantScope"),
    targetType: enumValue(value.targetType, TARGET_TYPES, "snapshot.targetType"),
    targetId: token(value.targetId, "snapshot.targetId"),
    sourceKind: "enterprise_personnel_authority",
    sourceSystemId,
    authorityVersion: token(value.authorityVersion, "snapshot.authorityVersion"),
    status: enumValue(value.status, new Set(["active"]), "snapshot.status"),
    validFrom: canonicalTimestamp(value.validFrom, "snapshot.validFrom"),
    validUntil: canonicalTimestamp(value.validUntil, "snapshot.validUntil"),
    assignments: value.assignments.map(normalizeAssignment),
  };
  if (snapshot.tenantScope !== request.tenantScope || snapshot.targetType !== request.targetType ||
    snapshot.targetId !== request.targetId) {
    throw authorityError("enterprise_business_owner_authority_target_mismatch");
  }
  if (snapshot.assignments.length !== 1) {
    throw authorityError("enterprise_business_owner_authority_assignment_not_unique");
  }
  const assignment = snapshot.assignments[0];
  if (assignment.role !== "businessOwner" || assignment.assigneeType !== "user" ||
    assignment.assignmentMode !== "direct" || assignment.confidence !== "authoritative" ||
    assignment.status !== "active") {
    throw authorityError("enterprise_business_owner_authority_assignment_invalid");
  }
  if (assignment.membership.subjectRef !== assignment.subjectRef ||
    assignment.membership.targetType !== snapshot.targetType ||
    assignment.membership.targetId !== snapshot.targetId ||
    assignment.authorization.subjectRef !== assignment.subjectRef) {
    throw authorityError("enterprise_business_owner_authority_binding_mismatch");
  }
  if (assignment.authorization.purpose !== request.purpose ||
    !assignment.authorization.permissions.includes(request.requiredPermission)) {
    throw authorityError("enterprise_business_owner_authority_permission_missing");
  }
  for (const [validFrom, validUntil] of [
    [snapshot.validFrom, snapshot.validUntil],
    [assignment.validFrom, assignment.validUntil],
    [assignment.membership.validFrom, assignment.membership.validUntil],
    [assignment.authorization.validFrom, assignment.authorization.validUntil],
  ]) {
    requireLiveWindow(validFrom, validUntil, request.evaluatedAt);
  }
  return deepFreeze(snapshot);
}

function normalizeAssignment(value, index) {
  exactObject(value, ASSIGNMENT_FIELDS, "enterprise_business_owner_authority_assignment_invalid");
  return {
    assignmentId: token(value.assignmentId, `assignments[${index}].assignmentId`),
    assignmentVersion: positiveInteger(value.assignmentVersion, `assignments[${index}].assignmentVersion`),
    role: token(value.role, `assignments[${index}].role`),
    assigneeType: token(value.assigneeType, `assignments[${index}].assigneeType`),
    subjectRef: token(value.subjectRef, `assignments[${index}].subjectRef`),
    status: token(value.status, `assignments[${index}].status`),
    assignmentMode: token(value.assignmentMode, `assignments[${index}].assignmentMode`),
    confidence: token(value.confidence, `assignments[${index}].confidence`),
    validFrom: canonicalTimestamp(value.validFrom, `assignments[${index}].validFrom`),
    validUntil: canonicalTimestamp(value.validUntil, `assignments[${index}].validUntil`),
    membership: normalizeMembership(value.membership, index),
    authorization: normalizeAuthorization(value.authorization, index),
  };
}

function normalizeMembership(value, index) {
  exactObject(value, MEMBERSHIP_FIELDS, "enterprise_business_owner_authority_membership_invalid");
  const prefix = `assignments[${index}].membership`;
  const status = token(value.status, `${prefix}.status`);
  if (status !== "active") throw authorityError("enterprise_business_owner_authority_membership_invalid");
  return {
    membershipId: token(value.membershipId, `${prefix}.membershipId`),
    membershipVersion: token(value.membershipVersion, `${prefix}.membershipVersion`),
    status,
    subjectRef: token(value.subjectRef, `${prefix}.subjectRef`),
    targetType: enumValue(value.targetType, TARGET_TYPES, `${prefix}.targetType`),
    targetId: token(value.targetId, `${prefix}.targetId`),
    validFrom: canonicalTimestamp(value.validFrom, `${prefix}.validFrom`),
    validUntil: canonicalTimestamp(value.validUntil, `${prefix}.validUntil`),
  };
}

function normalizeAuthorization(value, index) {
  exactObject(value, AUTHORIZATION_FIELDS, "enterprise_business_owner_authority_authorization_invalid");
  const prefix = `assignments[${index}].authorization`;
  if (!Array.isArray(value.permissions) || value.permissions.length === 0 || value.permissions.length > 100) {
    throw authorityError("enterprise_business_owner_authority_authorization_invalid");
  }
  const permissions = [...new Set(value.permissions.map((item) => token(item, `${prefix}.permissions`)))].sort();
  if (permissions.length === 0 || value.status !== "active") {
    throw authorityError("enterprise_business_owner_authority_authorization_invalid");
  }
  return {
    authorizationVersion: token(value.authorizationVersion, `${prefix}.authorizationVersion`),
    issuer: nonPiiIssuer(value.issuer, `${prefix}.issuer`),
    permissionVersion: token(value.permissionVersion, `${prefix}.permissionVersion`),
    permissions,
    purpose: token(value.purpose, `${prefix}.purpose`),
    status: "active",
    subjectRef: token(value.subjectRef, `${prefix}.subjectRef`),
    validFrom: canonicalTimestamp(value.validFrom, `${prefix}.validFrom`),
    validUntil: canonicalTimestamp(value.validUntil, `${prefix}.validUntil`),
  };
}

function requireLiveWindow(validFrom, validUntil, evaluatedAt) {
  if (validFrom >= validUntil || evaluatedAt < validFrom || evaluatedAt >= validUntil) {
    throw authorityError("enterprise_business_owner_authority_not_current");
  }
}

function earliestTimestamp(values) {
  return values.toSorted()[0];
}

function hmacDigest(secret, value) {
  return crypto.createHmac("sha256", secret).update(canonicalJson(value)).digest("hex");
}

function canonicalDigest(value) {
  return crypto.createHash("sha256").update(canonicalJson(value)).digest("hex");
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function normalizeHmacKey(value) {
  const result = Buffer.isBuffer(value) ? Buffer.from(value) : Buffer.from(String(value || ""), "utf8");
  if (result.byteLength < 32) throw authorityError("enterprise_business_owner_authority_hmac_key_invalid");
  return result;
}

function normalizeSourceSystemAllowlist(value) {
  if (!Array.isArray(value) || value.length === 0 || value.length > 100) {
    throw authorityError("enterprise_business_owner_authority_source_allowlist_invalid");
  }
  const result = new Set(value.map((item) => token(item, "allowlistedSourceSystemIds")));
  if (result.size === 0) throw authorityError("enterprise_business_owner_authority_source_allowlist_invalid");
  return result;
}

function exactObject(value, fields, code) {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
    Object.keys(value).some((field) => !fields.has(field)) ||
    [...fields].some((field) => !Object.hasOwn(value, field))) {
    throw authorityError(code);
  }
}

function token(value, field) {
  const result = String(value || "").trim();
  if (!TOKEN_PATTERN.test(result)) throw authorityError("enterprise_business_owner_authority_token_invalid", field);
  return result;
}

function nonPiiIssuer(value, field) {
  const result = token(value, field);
  if (result.includes("@")) throw authorityError("enterprise_business_owner_authority_token_invalid", field);
  return result;
}

function enumValue(value, allowed, field) {
  const result = token(value, field);
  if (!allowed.has(result)) throw authorityError("enterprise_business_owner_authority_enum_invalid", field);
  return result;
}

function positiveInteger(value, field) {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw authorityError("enterprise_business_owner_authority_integer_invalid", field);
  }
  return value;
}

function requiredDigest(value, field) {
  const result = String(value || "").trim().toLowerCase();
  if (!DIGEST_PATTERN.test(result)) throw authorityError("enterprise_business_owner_authority_digest_invalid", field);
  return result;
}

function canonicalTimestamp(value, field) {
  const input = value instanceof Date ? value.toISOString() : String(value || "").trim();
  const parsed = new Date(input);
  if (!input || !Number.isFinite(parsed.getTime()) || parsed.toISOString() !== input) {
    throw authorityError("enterprise_business_owner_authority_timestamp_invalid", field);
  }
  return input;
}

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value)) deepFreeze(child);
  return value;
}

function authorityError(code, detail = "") {
  const error = new Error(detail ? `${code}: ${detail}` : code);
  error.code = code;
  return error;
}

export {
  RECIPIENT_RESOLUTION_CONTRACT_VERSION as ENTERPRISE_BUSINESS_OWNER_RECIPIENT_RESOLUTION_CONTRACT_VERSION,
  RESOLUTION_CONTRACT_VERSION as ENTERPRISE_BUSINESS_OWNER_RESOLUTION_CONTRACT_VERSION,
  SNAPSHOT_CONTRACT_VERSION as ENTERPRISE_PERSONNEL_OWNER_SNAPSHOT_CONTRACT_VERSION,
};
