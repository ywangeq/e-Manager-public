import {
  createScheduleBusinessOwnerAcceptanceCandidateV2,
  createScheduleBusinessOwnerAcceptanceRevisionV2,
  projectScheduleBusinessOwnerAcceptanceProofV2,
} from "./schedule-business-owner-acceptance.mjs";

const SCHEDULE_BUSINESS_OWNER_ACCEPTANCE_SERVICE_CONTRACT_VERSION =
  "schedule-business-owner-acceptance-service.v1";
const SCHEDULE_BUSINESS_OWNER_ACCEPTANCE_SERVICE_RESULT_CONTRACT_VERSION =
  "schedule-business-owner-acceptance-service-result.v1";
const ACCEPTANCE_CONTEXT_CONTRACT_VERSION = "schedule-business-owner-acceptance-context.v1";
const PURPOSE = "schedule_business_owner_acceptance";
const REQUIRED_PERMISSION = "schedule:business_owner_accept";
const REQUEST_FIELDS = new Set([
  "authenticatedActorContext",
  "employeeId",
  "expectedAcceptanceVersion",
  "expectedPreviousRevisionDigest",
  "expectedRegistrationVersion",
  "scheduleId",
  "tenantScope",
]);
const ACTOR_FIELDS = new Set(["issuer", "subjectRef"]);
const CONTEXT_FIELDS = new Set([
  "acceptancePolicy",
  "alertContractDigest",
  "contractVersion",
  "employeeId",
  "employeeVersion",
  "executionContractDigest",
  "ownerTarget",
  "processingAuthorityDigest",
  "providerTimeoutPolicy",
  "providerTrial",
  "readiness",
  "registrarSubjectDigest",
  "registrationVersion",
  "resultContractDigest",
  "retentionDefinitionDigest",
  "scheduleId",
  "schedulePolicyDigest",
  "scheduleVersion",
  "taskBindingDigest",
  "taskDefinitionId",
  "tenantScope",
  "writebackContractDigest",
]);
const OWNER_TARGET_FIELDS = new Set(["targetId", "targetType"]);
const TARGET_TYPES = new Set(["department", "digital_employee"]);
const TOKEN_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,159}$/;

function createScheduleBusinessOwnerAcceptanceService({
  controlRepository,
  ownerAuthorityResolver,
  resolveCurrentAcceptanceContext,
  serverClock,
} = {}) {
  if (typeof controlRepository?.getBusinessOwnerAcceptance !== "function" ||
    typeof controlRepository?.recordBusinessOwnerAcceptanceV2 !== "function") {
    throw new TypeError("Schedule Owner acceptance service requires the control acceptance authority");
  }
  if (typeof ownerAuthorityResolver?.resolveCurrentBusinessOwnerAuthority !== "function") {
    throw new TypeError("Schedule Owner acceptance service requires the enterprise Owner authority resolver");
  }
  if (typeof resolveCurrentAcceptanceContext !== "function") {
    throw new TypeError("Schedule Owner acceptance service requires the current acceptance context resolver");
  }
  if (typeof serverClock !== "function") {
    throw new TypeError("Schedule Owner acceptance service requires a server clock");
  }

  async function accept(value = {}) {
    return recordDecision(value, "accepted");
  }

  async function revoke(value = {}) {
    return recordDecision(value, "revoked");
  }

  async function recordDecision(value, decision) {
    const request = normalizeRequest(value);
    const decidedAt = trustedTimestamp(serverClock);
    const initial = await resolveCandidate({ request, evaluatedAt: decidedAt });
    const current = controlRepository.getBusinessOwnerAcceptance(request);
    let revision;

    if (isExactReplay(current, initial.candidate, request.expectedAcceptanceVersion, decision)) {
      revision = current;
    } else {
      revision = createScheduleBusinessOwnerAcceptanceRevisionV2({
        acceptanceVersion: request.expectedAcceptanceVersion + 1,
        actor: initial.candidate.ownerAuthorization,
        candidate: initial.candidate,
        decidedAt,
        decision,
        validUntil: acceptanceValidUntil(initial.candidate, decidedAt),
      });
    }

    const currentCandidate = (await resolveCandidate({ request, evaluatedAt: decidedAt })).candidate;
    if (currentCandidate.candidateDigest !== initial.candidate.candidateDigest) {
      throw serviceError("schedule_owner_acceptance_current_context_changed");
    }
    const recorded = controlRepository.recordBusinessOwnerAcceptanceV2({
      revision,
      expectedAcceptanceVersion: request.expectedAcceptanceVersion,
      expectedPreviousRevisionDigest: request.expectedPreviousRevisionDigest,
    });

    if (decision === "revoked") {
      return deepFreeze({
        contractVersion: SCHEDULE_BUSINESS_OWNER_ACCEPTANCE_SERVICE_RESULT_CONTRACT_VERSION,
        created: recorded.created,
        state: "revoked",
        acceptance: recorded.acceptance,
        proof: null,
      });
    }

    let proof = null;
    try {
      proof = projectScheduleBusinessOwnerAcceptanceProofV2({
        acceptance: recorded.acceptance,
        currentCandidate,
        evaluatedAt: decidedAt,
      });
    } catch {
      proof = null;
    }
    return deepFreeze({
      contractVersion: SCHEDULE_BUSINESS_OWNER_ACCEPTANCE_SERVICE_RESULT_CONTRACT_VERSION,
      created: recorded.created,
      state: proof ? "accepted_current" : "recorded_unverified",
      acceptance: recorded.acceptance,
      proof,
    });
  }

  async function resolveCandidate({ request, evaluatedAt }) {
    let contextValue;
    try {
      contextValue = await resolveCurrentAcceptanceContext({
        tenantScope: request.tenantScope,
        employeeId: request.employeeId,
        scheduleId: request.scheduleId,
        evaluatedAt,
      });
    } catch {
      throw serviceError("schedule_owner_acceptance_context_unavailable");
    }
    const context = normalizeContext(contextValue, request);
    let owner;
    try {
      owner = await ownerAuthorityResolver.resolveCurrentBusinessOwnerAuthority({
        tenantScope: request.tenantScope,
        targetType: context.ownerTarget.targetType,
        targetId: context.ownerTarget.targetId,
        purpose: PURPOSE,
        requiredPermission: REQUIRED_PERMISSION,
        currentActor: request.authenticatedActorContext,
      });
    } catch (error) {
      if (String(error?.code || "").startsWith("enterprise_business_owner_authority_")) throw error;
      throw serviceError("schedule_owner_acceptance_authority_unavailable");
    }
    if (!owner || typeof owner !== "object" || Array.isArray(owner)) {
      throw serviceError("schedule_owner_acceptance_authority_unavailable");
    }
    const candidate = createScheduleBusinessOwnerAcceptanceCandidateV2({
      contractVersion: "schedule-business-owner-acceptance-candidate.v2",
      tenantScope: context.tenantScope,
      employeeId: context.employeeId,
      employeeVersion: context.employeeVersion,
      scheduleId: context.scheduleId,
      scheduleVersion: context.scheduleVersion,
      registrationVersion: context.registrationVersion,
      registrarSubjectDigest: context.registrarSubjectDigest,
      taskDefinitionId: context.taskDefinitionId,
      schedulePolicyDigest: context.schedulePolicyDigest,
      executionContractDigest: context.executionContractDigest,
      taskBindingDigest: context.taskBindingDigest,
      providerTrial: context.providerTrial,
      providerTimeoutPolicy: context.providerTimeoutPolicy,
      resultContractDigest: context.resultContractDigest,
      alertContractDigest: context.alertContractDigest,
      retentionDefinitionDigest: context.retentionDefinitionDigest,
      processingAuthorityDigest: context.processingAuthorityDigest,
      writebackContractDigest: context.writebackContractDigest,
      ownerAssignment: owner.ownerAssignment,
      ownerAuthorityValidUntil: owner.authorityValidUntil,
      ownerAuthorization: owner.ownerAuthorization,
      personnelAuthority: owner.personnelAuthority,
      acceptancePolicy: context.acceptancePolicy,
      readiness: context.readiness,
    });
    return Object.freeze({ candidate });
  }

  return Object.freeze({
    contractVersion: SCHEDULE_BUSINESS_OWNER_ACCEPTANCE_SERVICE_CONTRACT_VERSION,
    accept,
    revoke,
  });
}

function normalizeRequest(value) {
  exactObject(value, REQUEST_FIELDS, "schedule_owner_acceptance_service_request_invalid");
  exactObject(value.authenticatedActorContext, ACTOR_FIELDS, "schedule_owner_acceptance_service_actor_invalid");
  const expectedAcceptanceVersion = nonNegativeInteger(
    value.expectedAcceptanceVersion,
    "expectedAcceptanceVersion",
  );
  const expectedPreviousRevisionDigest = expectedAcceptanceVersion === 0
    ? value.expectedPreviousRevisionDigest === null ? null : invalidPreviousDigest()
    : requiredDigest(value.expectedPreviousRevisionDigest, "expectedPreviousRevisionDigest");
  return Object.freeze({
    tenantScope: token(value.tenantScope, "tenantScope"),
    employeeId: token(value.employeeId, "employeeId"),
    scheduleId: token(value.scheduleId, "scheduleId"),
    expectedRegistrationVersion: positiveInteger(
      value.expectedRegistrationVersion,
      "expectedRegistrationVersion",
    ),
    expectedAcceptanceVersion,
    expectedPreviousRevisionDigest,
    authenticatedActorContext: Object.freeze({
      issuer: token(value.authenticatedActorContext.issuer, "authenticatedActorContext.issuer"),
      subjectRef: token(value.authenticatedActorContext.subjectRef, "authenticatedActorContext.subjectRef"),
    }),
  });
}

function normalizeContext(value, request) {
  exactObject(value, CONTEXT_FIELDS, "schedule_owner_acceptance_context_invalid");
  exactObject(value.ownerTarget, OWNER_TARGET_FIELDS, "schedule_owner_acceptance_owner_target_invalid");
  const identity = {
    tenantScope: token(value.tenantScope, "context.tenantScope"),
    employeeId: token(value.employeeId, "context.employeeId"),
    scheduleId: token(value.scheduleId, "context.scheduleId"),
  };
  const registrationVersion = positiveInteger(value.registrationVersion, "context.registrationVersion");
  if (identity.tenantScope !== request.tenantScope || identity.employeeId !== request.employeeId ||
    identity.scheduleId !== request.scheduleId || registrationVersion !== request.expectedRegistrationVersion) {
    throw serviceError("schedule_owner_acceptance_context_stale");
  }
  return Object.freeze({
    ...value,
    ...identity,
    contractVersion: exactValue(
      value.contractVersion,
      ACCEPTANCE_CONTEXT_CONTRACT_VERSION,
      "schedule_owner_acceptance_context_invalid",
    ),
    registrationVersion,
    ownerTarget: Object.freeze({
      targetType: enumValue(value.ownerTarget.targetType, TARGET_TYPES, "schedule_owner_acceptance_owner_target_invalid"),
      targetId: token(value.ownerTarget.targetId, "ownerTarget.targetId"),
    }),
  });
}

function isExactReplay(current, candidate, expectedVersion, decision) {
  return Boolean(current && current.contractVersion === "schedule-business-owner-acceptance.v2" &&
    current.acceptanceVersion === expectedVersion + 1 && current.decision === decision &&
    current.candidate?.candidateDigest === candidate.candidateDigest);
}

function acceptanceValidUntil(candidate, decidedAt) {
  const policyExpiry = Date.parse(decidedAt) + candidate.acceptancePolicy.maxValiditySeconds * 1_000;
  const authorityExpiry = Date.parse(candidate.ownerAuthorityValidUntil);
  const validUntil = new Date(Math.min(policyExpiry, authorityExpiry)).toISOString();
  if (validUntil <= decidedAt) throw serviceError("schedule_owner_acceptance_authority_expired");
  return validUntil;
}

function trustedTimestamp(serverClock) {
  let value;
  try {
    value = serverClock();
  } catch {
    throw serviceError("schedule_owner_acceptance_clock_unavailable");
  }
  const timestamp = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(timestamp.getTime())) throw serviceError("schedule_owner_acceptance_clock_unavailable");
  return timestamp.toISOString();
}

function exactObject(value, fields, code) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw serviceError(code);
  const expected = [...fields].sort();
  const actual = Object.keys(value).sort();
  if (expected.length !== actual.length || actual.some((field, index) => field !== expected[index])) {
    throw serviceError(code);
  }
}

function token(value, field) {
  const result = String(value || "").trim();
  if (!TOKEN_PATTERN.test(result)) throw serviceError("schedule_owner_acceptance_service_token_invalid", field);
  return result;
}

function requiredDigest(value, field) {
  const result = String(value || "").trim().toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(result)) {
    throw serviceError("schedule_owner_acceptance_service_digest_invalid", field);
  }
  return result;
}

function positiveInteger(value, field) {
  const result = Number(value);
  if (!Number.isSafeInteger(result) || result < 1) {
    throw serviceError("schedule_owner_acceptance_service_number_invalid", field);
  }
  return result;
}

function nonNegativeInteger(value, field) {
  const result = Number(value);
  if (!Number.isSafeInteger(result) || result < 0) {
    throw serviceError("schedule_owner_acceptance_service_number_invalid", field);
  }
  return result;
}

function enumValue(value, allowed, code) {
  if (!allowed.has(value)) throw serviceError(code);
  return value;
}

function exactValue(value, expected, code) {
  if (value !== expected) throw serviceError(code);
  return expected;
}

function invalidPreviousDigest() {
  throw serviceError("schedule_owner_acceptance_service_previous_digest_invalid");
}

function serviceError(code) {
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
  ACCEPTANCE_CONTEXT_CONTRACT_VERSION,
  SCHEDULE_BUSINESS_OWNER_ACCEPTANCE_SERVICE_CONTRACT_VERSION,
  SCHEDULE_BUSINESS_OWNER_ACCEPTANCE_SERVICE_RESULT_CONTRACT_VERSION,
  createScheduleBusinessOwnerAcceptanceService,
};
