import crypto from "node:crypto";
import { normalizeProviderTimeoutPolicy } from "./provider-timeout-policy.mjs";
import {
  normalizeScheduleResultProcessingBinding,
} from "./schedule-result-processing-contract.mjs";

const SCHEDULE_BUSINESS_OWNER_ACCEPTANCE_CANDIDATE_CONTRACT_VERSION =
  "schedule-business-owner-acceptance-candidate.v1";
const SCHEDULE_BUSINESS_OWNER_ACCEPTANCE_CONTRACT_VERSION =
  "schedule-business-owner-acceptance.v1";
const SCHEDULE_BUSINESS_OWNER_ACCEPTANCE_EVALUATION_CONTRACT_VERSION =
  "schedule-business-owner-acceptance-evaluation.v1";
const SCHEDULE_BUSINESS_OWNER_ACCEPTANCE_PROOF_CONTRACT_VERSION =
  "schedule-business-owner-acceptance-proof.v1";
const SCHEDULE_BUSINESS_OWNER_ACCEPTANCE_CANDIDATE_CONTRACT_VERSION_V2 =
  "schedule-business-owner-acceptance-candidate.v2";
const SCHEDULE_BUSINESS_OWNER_ACCEPTANCE_CONTRACT_VERSION_V2 =
  "schedule-business-owner-acceptance.v2";
const SCHEDULE_BUSINESS_OWNER_ACCEPTANCE_EVALUATION_CONTRACT_VERSION_V2 =
  "schedule-business-owner-acceptance-evaluation.v2";
const SCHEDULE_BUSINESS_OWNER_ACCEPTANCE_PROOF_CONTRACT_VERSION_V2 =
  "schedule-business-owner-acceptance-proof.v2";

const CANDIDATE_BODY_FIELDS = new Set([
  "acceptancePolicy",
  "alertContractDigest",
  "contractVersion",
  "employeeId",
  "employeeVersion",
  "executionContractDigest",
  "ownerAssignment",
  "ownerAuthorityValidUntil",
  "ownerAuthorization",
  "personnelAuthority",
  "providerTimeoutPolicy",
  "providerTrial",
  "readiness",
  "registrarSubjectDigest",
  "registrationVersion",
  "resultContractDigest",
  "scheduleId",
  "schedulePolicyDigest",
  "scheduleVersion",
  "taskBindingDigest",
  "taskDefinitionId",
  "tenantScope",
  "writebackContractDigest",
]);
const CANDIDATE_FIELDS = new Set([...CANDIDATE_BODY_FIELDS, "candidateDigest"]);
const CANDIDATE_BODY_FIELDS_V2 = new Set([
  ...CANDIDATE_BODY_FIELDS, "processingAuthorityDigest", "retentionDefinitionDigest",
]);
const CANDIDATE_FIELDS_V2 = new Set([...CANDIDATE_BODY_FIELDS_V2, "candidateDigest"]);
const REVISION_BODY_FIELDS = new Set([
  "acceptanceId",
  "acceptanceVersion",
  "actor",
  "candidate",
  "contractVersion",
  "decidedAt",
  "decision",
  "previousAcceptanceVersion",
  "validUntil",
]);
const REVISION_FIELDS = new Set([...REVISION_BODY_FIELDS, "revisionDigest"]);
const PROOF_BODY_FIELDS_V2 = new Set([
  "acceptanceCandidateDigest", "acceptanceRevisionDigest", "alertContractDigest", "approvalId",
  "approvalPolicyDigest", "approvalRevision", "approvedAt", "approverPrincipalId", "contractVersion",
  "decision", "employeeVersion", "executionContractDigest", "processingAuthorityDigest", "readinessDigest",
  "registrationVersion", "resultContractDigest", "retentionDefinitionDigest", "schedulePolicyDigest",
  "scheduleVersion", "taskBindingDigest", "validUntil", "writebackContractDigest",
]);
const PROOF_FIELDS_V2 = new Set([...PROOF_BODY_FIELDS_V2, "proofDigest"]);
const ACTOR_FIELDS = new Set([
  "authorizationDigest",
  "issuer",
  "ownerMembershipDigest",
  "permissionDigest",
  "subjectDigest",
]);
const OWNER_ASSIGNMENT_FIELDS = new Set([
  "assigneeType",
  "assigneeSubjectDigest",
  "assignmentDigest",
  "assignmentVersion",
  "contractVersion",
  "role",
]);
const PERSONNEL_AUTHORITY_FIELDS = new Set([
  "authorityDigest",
  "authorityVersion",
  "contractVersion",
  "ownerMembershipDigest",
]);
const ACCEPTANCE_POLICY_FIELDS = new Set([
  "contractVersion",
  "maxValiditySeconds",
  "policyDigest",
  "policyVersion",
]);
const READINESS_FIELDS = new Set(["contractVersion", "readinessDigest", "readinessVersion"]);
const PROVIDER_TRIAL_FIELDS = new Set([
  "attemptSequence",
  "canonicalTaskId",
  "canonicalTaskRevision",
  "canonicalTaskStatus",
  "dryRunId",
  "dryRunVersion",
  "employeeVersion",
  "evidenceDigest",
  "executionContractDigest",
  "outcome",
  "passedAt",
  "registrationVersion",
  "schedulePolicyDigest",
  "scheduleVersion",
  "taskBindingDigest",
]);
const TOKEN_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,159}$/;
const EMAIL_PATTERN = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const SECRET_PATTERN = /^(?:bearer\s+|sk-[a-z0-9_-]{8,}|rk-[a-z0-9_-]{8,}|xox[baprs]-|gh[pousr]_|glpat-|ya29\.|eyJ[A-Za-z0-9_-]{8,})/i;

function createScheduleBusinessOwnerAcceptanceCandidate(value = {}) {
  exactObject(value, CANDIDATE_BODY_FIELDS, "schedule_owner_acceptance_candidate_fields_invalid");
  const body = normalizeCandidateBody(value);
  return deepFreeze({ ...body, candidateDigest: digestCanonical(body) });
}

function normalizeScheduleBusinessOwnerAcceptanceCandidate(value = {}) {
  exactObject(value, CANDIDATE_FIELDS, "schedule_owner_acceptance_candidate_fields_invalid");
  const { candidateDigest, ...candidate } = value;
  const body = normalizeCandidateBody(candidate);
  const expected = digestCanonical(body);
  if (requiredDigest(candidateDigest, "candidateDigest") !== expected) {
    throw acceptanceError("schedule_owner_acceptance_candidate_digest_mismatch");
  }
  return deepFreeze({ ...body, candidateDigest: expected });
}

function createScheduleBusinessOwnerAcceptanceRevision({
  acceptanceVersion,
  actor,
  candidate,
  decidedAt,
  decision,
  validUntil,
} = {}) {
  const normalizedCandidate = normalizeScheduleBusinessOwnerAcceptanceCandidate(candidate);
  const version = positiveInteger(acceptanceVersion, "acceptanceVersion");
  const body = normalizeRevisionBody({
    contractVersion: SCHEDULE_BUSINESS_OWNER_ACCEPTANCE_CONTRACT_VERSION,
    acceptanceId: acceptanceIdFor(normalizedCandidate),
    acceptanceVersion: version,
    previousAcceptanceVersion: version - 1,
    candidate: normalizedCandidate,
    decision,
    actor,
    decidedAt,
    validUntil,
  });
  return deepFreeze({ ...body, revisionDigest: digestCanonical(body) });
}

function normalizeScheduleBusinessOwnerAcceptanceRevision(value = {}) {
  exactObject(value, REVISION_FIELDS, "schedule_owner_acceptance_revision_fields_invalid");
  const { revisionDigest, ...candidate } = value;
  const body = normalizeRevisionBody(candidate);
  const expected = digestCanonical(body);
  if (requiredDigest(revisionDigest, "revisionDigest") !== expected) {
    throw acceptanceError("schedule_owner_acceptance_revision_digest_mismatch");
  }
  return deepFreeze({ ...body, revisionDigest: expected });
}

function evaluateScheduleBusinessOwnerAcceptance({ acceptance, currentCandidate, evaluatedAt } = {}) {
  const revision = normalizeScheduleBusinessOwnerAcceptanceRevision(acceptance);
  const current = normalizeScheduleBusinessOwnerAcceptanceCandidate(currentCandidate);
  requireSameTarget(revision.candidate, current);
  const now = canonicalTimestamp(evaluatedAt, "evaluatedAt");
  const state = now < revision.decidedAt ? "not_effective"
    : revision.decision === "revoked" ? "revoked"
      : revision.candidate.candidateDigest !== current.candidateDigest ? "stale"
        : now >= revision.validUntil ? "expired" : "accepted_current";
  return deepFreeze({
    contractVersion: SCHEDULE_BUSINESS_OWNER_ACCEPTANCE_EVALUATION_CONTRACT_VERSION,
    acceptanceId: revision.acceptanceId,
    acceptanceVersion: revision.acceptanceVersion,
    state,
    current: state === "accepted_current",
    acceptedRegistrationVersion: revision.candidate.registrationVersion,
    decidedAt: revision.decidedAt,
    validUntil: revision.validUntil,
    evaluatedAt: now,
  });
}

function projectScheduleBusinessOwnerAcceptanceProof({ acceptance, currentCandidate, evaluatedAt } = {}) {
  const revision = normalizeScheduleBusinessOwnerAcceptanceRevision(acceptance);
  const evaluation = evaluateScheduleBusinessOwnerAcceptance({
    acceptance: revision,
    currentCandidate,
    evaluatedAt,
  });
  if (!evaluation.current) throw acceptanceError("schedule_owner_acceptance_not_current");
  const candidate = revision.candidate;
  return deepFreeze({
    contractVersion: SCHEDULE_BUSINESS_OWNER_ACCEPTANCE_PROOF_CONTRACT_VERSION,
    acceptanceCandidateDigest: candidate.candidateDigest,
    approvalId: revision.acceptanceId,
    approvalRevision: revision.acceptanceVersion,
    decision: "approved",
    approverPrincipalId: `business_owner_${revision.actor.subjectDigest}`,
    approvalPolicyDigest: candidate.acceptancePolicy.policyDigest,
    readinessDigest: candidate.readiness.readinessDigest,
    registrationVersion: candidate.registrationVersion,
    scheduleVersion: candidate.scheduleVersion,
    employeeVersion: candidate.employeeVersion,
    schedulePolicyDigest: candidate.schedulePolicyDigest,
    executionContractDigest: candidate.executionContractDigest,
    taskBindingDigest: candidate.taskBindingDigest,
    resultContractDigest: candidate.resultContractDigest,
    alertContractDigest: candidate.alertContractDigest,
    writebackContractDigest: candidate.writebackContractDigest,
    approvedAt: revision.decidedAt,
    validUntil: revision.validUntil,
  });
}

function createScheduleBusinessOwnerAcceptanceCandidateV2(value = {}) {
  exactObject(value, CANDIDATE_BODY_FIELDS_V2, "schedule_owner_acceptance_candidate_v2_fields_invalid");
  const body = normalizeCandidateBodyV2(value);
  return deepFreeze({ ...body, candidateDigest: digestCanonical(body) });
}

function normalizeScheduleBusinessOwnerAcceptanceCandidateV2(value = {}) {
  exactObject(value, CANDIDATE_FIELDS_V2, "schedule_owner_acceptance_candidate_v2_fields_invalid");
  const { candidateDigest, ...candidate } = value;
  const body = normalizeCandidateBodyV2(candidate);
  const expected = digestCanonical(body);
  if (requiredDigest(candidateDigest, "candidateDigest") !== expected) {
    throw acceptanceError("schedule_owner_acceptance_candidate_v2_digest_mismatch");
  }
  return deepFreeze({ ...body, candidateDigest: expected });
}

function createScheduleBusinessOwnerAcceptanceRevisionV2({
  acceptanceVersion, actor, candidate, decidedAt, decision, validUntil,
} = {}) {
  const normalizedCandidate = normalizeScheduleBusinessOwnerAcceptanceCandidateV2(candidate);
  const version = positiveInteger(acceptanceVersion, "acceptanceVersion");
  const body = normalizeRevisionBodyV2({
    contractVersion: SCHEDULE_BUSINESS_OWNER_ACCEPTANCE_CONTRACT_VERSION_V2,
    acceptanceId: acceptanceIdFor(normalizedCandidate),
    acceptanceVersion: version,
    previousAcceptanceVersion: version - 1,
    candidate: normalizedCandidate,
    decision,
    actor,
    decidedAt,
    validUntil,
  });
  return deepFreeze({ ...body, revisionDigest: digestCanonical(body) });
}

function normalizeScheduleBusinessOwnerAcceptanceRevisionV2(value = {}) {
  exactObject(value, REVISION_FIELDS, "schedule_owner_acceptance_revision_v2_fields_invalid");
  const { revisionDigest, ...candidate } = value;
  const body = normalizeRevisionBodyV2(candidate);
  const expected = digestCanonical(body);
  if (requiredDigest(revisionDigest, "revisionDigest") !== expected) {
    throw acceptanceError("schedule_owner_acceptance_revision_v2_digest_mismatch");
  }
  return deepFreeze({ ...body, revisionDigest: expected });
}

function evaluateScheduleBusinessOwnerAcceptanceV2({ acceptance, currentCandidate, evaluatedAt } = {}) {
  const revision = normalizeScheduleBusinessOwnerAcceptanceRevisionV2(acceptance);
  const current = normalizeScheduleBusinessOwnerAcceptanceCandidateV2(currentCandidate);
  requireSameTarget(revision.candidate, current);
  const now = canonicalTimestamp(evaluatedAt, "evaluatedAt");
  const state = now < revision.decidedAt ? "not_effective"
    : revision.decision === "revoked" ? "revoked"
      : revision.candidate.candidateDigest !== current.candidateDigest ? "stale"
        : now >= revision.validUntil ? "expired" : "accepted_current";
  return deepFreeze({
    contractVersion: SCHEDULE_BUSINESS_OWNER_ACCEPTANCE_EVALUATION_CONTRACT_VERSION_V2,
    acceptanceId: revision.acceptanceId,
    acceptanceVersion: revision.acceptanceVersion,
    state,
    current: state === "accepted_current",
    acceptedRegistrationVersion: revision.candidate.registrationVersion,
    decidedAt: revision.decidedAt,
    validUntil: revision.validUntil,
    evaluatedAt: now,
  });
}

function projectScheduleBusinessOwnerAcceptanceProofV2({ acceptance, currentCandidate, evaluatedAt } = {}) {
  const revision = normalizeScheduleBusinessOwnerAcceptanceRevisionV2(acceptance);
  const evaluation = evaluateScheduleBusinessOwnerAcceptanceV2({
    acceptance: revision, currentCandidate, evaluatedAt,
  });
  if (!evaluation.current) throw acceptanceError("schedule_owner_acceptance_not_current");
  const candidate = revision.candidate;
  const body = normalizeProofBodyV2({
    contractVersion: SCHEDULE_BUSINESS_OWNER_ACCEPTANCE_PROOF_CONTRACT_VERSION_V2,
    acceptanceCandidateDigest: candidate.candidateDigest,
    acceptanceRevisionDigest: revision.revisionDigest,
    approvalId: revision.acceptanceId,
    approvalRevision: revision.acceptanceVersion,
    decision: "approved",
    approverPrincipalId: `business_owner_${revision.actor.subjectDigest}`,
    approvalPolicyDigest: candidate.acceptancePolicy.policyDigest,
    readinessDigest: candidate.readiness.readinessDigest,
    registrationVersion: candidate.registrationVersion,
    scheduleVersion: candidate.scheduleVersion,
    employeeVersion: candidate.employeeVersion,
    schedulePolicyDigest: candidate.schedulePolicyDigest,
    executionContractDigest: candidate.executionContractDigest,
    taskBindingDigest: candidate.taskBindingDigest,
    resultContractDigest: candidate.resultContractDigest,
    alertContractDigest: candidate.alertContractDigest,
    retentionDefinitionDigest: candidate.retentionDefinitionDigest,
    processingAuthorityDigest: candidate.processingAuthorityDigest,
    writebackContractDigest: candidate.writebackContractDigest,
    approvedAt: revision.decidedAt,
    validUntil: revision.validUntil,
  });
  return deepFreeze({ ...body, proofDigest: digestCanonical(body) });
}

function normalizeScheduleBusinessOwnerAcceptanceProofV2(value = {}) {
  exactObject(value, PROOF_FIELDS_V2, "schedule_owner_acceptance_proof_v2_fields_invalid");
  const { proofDigest, ...candidate } = value;
  const body = normalizeProofBodyV2(candidate);
  const expected = digestCanonical(body);
  if (requiredDigest(proofDigest, "proofDigest") !== expected) {
    throw acceptanceError("schedule_owner_acceptance_proof_v2_digest_mismatch");
  }
  return deepFreeze({ ...body, proofDigest: expected });
}

function normalizeCandidateBody(value) {
  if (value.contractVersion !== SCHEDULE_BUSINESS_OWNER_ACCEPTANCE_CANDIDATE_CONTRACT_VERSION) {
    throw acceptanceError("schedule_owner_acceptance_candidate_contract_invalid");
  }
  const body = {
    contractVersion: SCHEDULE_BUSINESS_OWNER_ACCEPTANCE_CANDIDATE_CONTRACT_VERSION,
    tenantScope: token(value.tenantScope, "tenantScope"),
    employeeId: token(value.employeeId, "employeeId"),
    employeeVersion: token(value.employeeVersion, "employeeVersion"),
    scheduleId: token(value.scheduleId, "scheduleId"),
    scheduleVersion: token(value.scheduleVersion, "scheduleVersion"),
    registrationVersion: positiveInteger(value.registrationVersion, "registrationVersion"),
    registrarSubjectDigest: requiredDigest(value.registrarSubjectDigest, "registrarSubjectDigest"),
    taskDefinitionId: token(value.taskDefinitionId, "taskDefinitionId"),
    schedulePolicyDigest: requiredDigest(value.schedulePolicyDigest, "schedulePolicyDigest"),
    executionContractDigest: requiredDigest(value.executionContractDigest, "executionContractDigest"),
    taskBindingDigest: requiredDigest(value.taskBindingDigest, "taskBindingDigest"),
    providerTrial: normalizeProviderTrial(value.providerTrial),
    providerTimeoutPolicy: normalizeTimeoutPolicy(value.providerTimeoutPolicy),
    resultContractDigest: requiredDigest(value.resultContractDigest, "resultContractDigest"),
    alertContractDigest: requiredDigest(value.alertContractDigest, "alertContractDigest"),
    writebackContractDigest: requiredDigest(value.writebackContractDigest, "writebackContractDigest"),
    ownerAssignment: normalizeOwnerAssignment(value.ownerAssignment),
    ownerAuthorityValidUntil: canonicalTimestamp(value.ownerAuthorityValidUntil, "ownerAuthorityValidUntil"),
    ownerAuthorization: normalizeActor(value.ownerAuthorization),
    personnelAuthority: normalizePersonnelAuthority(value.personnelAuthority),
    acceptancePolicy: normalizeAcceptancePolicy(value.acceptancePolicy),
    readiness: normalizeReadiness(value.readiness),
  };
  requireCandidateBindings(body);
  return deepFreeze(body);
}

function normalizeCandidateBodyV2(value) {
  if (value.contractVersion !== SCHEDULE_BUSINESS_OWNER_ACCEPTANCE_CANDIDATE_CONTRACT_VERSION_V2) {
    throw acceptanceError("schedule_owner_acceptance_candidate_v2_contract_invalid");
  }
  const { processingAuthorityDigest, retentionDefinitionDigest, ...legacyValue } = value;
  const legacy = normalizeCandidateBody({
    ...legacyValue,
    contractVersion: SCHEDULE_BUSINESS_OWNER_ACCEPTANCE_CANDIDATE_CONTRACT_VERSION,
  });
  const processing = normalizeScheduleResultProcessingBinding({
    contractVersion: "schedule-result-processing-binding.v1",
    resultContractDigest: legacy.resultContractDigest,
    alertContractDigest: legacy.alertContractDigest,
    retentionDefinitionDigest,
    processingAuthorityDigest,
  });
  const { contractVersion: _bindingVersion, ...processingDigests } = processing;
  return deepFreeze({
    ...legacy,
    contractVersion: SCHEDULE_BUSINESS_OWNER_ACCEPTANCE_CANDIDATE_CONTRACT_VERSION_V2,
    ...processingDigests,
  });
}

function normalizeRevisionBody(value) {
  exactObject(value, REVISION_BODY_FIELDS, "schedule_owner_acceptance_revision_fields_invalid");
  if (value.contractVersion !== SCHEDULE_BUSINESS_OWNER_ACCEPTANCE_CONTRACT_VERSION) {
    throw acceptanceError("schedule_owner_acceptance_revision_contract_invalid");
  }
  const candidate = normalizeScheduleBusinessOwnerAcceptanceCandidate(value.candidate);
  const acceptanceVersion = positiveInteger(value.acceptanceVersion, "acceptanceVersion");
  const previousAcceptanceVersion = nonNegativeInteger(value.previousAcceptanceVersion, "previousAcceptanceVersion");
  if (previousAcceptanceVersion !== acceptanceVersion - 1) {
    throw acceptanceError("schedule_owner_acceptance_revision_sequence_invalid");
  }
  const decidedAt = canonicalTimestamp(value.decidedAt, "decidedAt");
  const validUntil = canonicalTimestamp(value.validUntil, "validUntil");
  if (validUntil <= decidedAt) throw acceptanceError("schedule_owner_acceptance_validity_invalid");
  if (validUntil > candidate.ownerAuthorityValidUntil) {
    throw acceptanceError("schedule_owner_acceptance_validity_exceeds_owner_authority");
  }
  const actor = normalizeActor(value.actor);
  const decision = enumValue(value.decision, ["accepted", "revoked"], "schedule_owner_acceptance_decision_invalid");
  if (decision === "accepted" && decidedAt < candidate.providerTrial.passedAt) {
    throw acceptanceError("schedule_owner_acceptance_decision_before_provider_trial");
  }
  if (Date.parse(validUntil) - Date.parse(decidedAt) > candidate.acceptancePolicy.maxValiditySeconds * 1_000) {
    throw acceptanceError("schedule_owner_acceptance_validity_exceeds_policy");
  }
  if (!sameActor(actor, candidate.ownerAuthorization)) {
    throw acceptanceError("schedule_owner_acceptance_actor_binding_mismatch");
  }
  if (decision === "accepted" && actor.subjectDigest === candidate.registrarSubjectDigest) {
    throw acceptanceError("schedule_owner_acceptance_separation_of_duties_required");
  }
  const acceptanceId = token(value.acceptanceId, "acceptanceId");
  if (acceptanceId !== acceptanceIdFor(candidate)) {
    throw acceptanceError("schedule_owner_acceptance_id_mismatch");
  }
  return deepFreeze({
    contractVersion: SCHEDULE_BUSINESS_OWNER_ACCEPTANCE_CONTRACT_VERSION,
    acceptanceId,
    acceptanceVersion,
    previousAcceptanceVersion,
    candidate,
    decision,
    actor,
    decidedAt,
    validUntil,
  });
}

function normalizeRevisionBodyV2(value) {
  exactObject(value, REVISION_BODY_FIELDS, "schedule_owner_acceptance_revision_v2_fields_invalid");
  if (value.contractVersion !== SCHEDULE_BUSINESS_OWNER_ACCEPTANCE_CONTRACT_VERSION_V2) {
    throw acceptanceError("schedule_owner_acceptance_revision_v2_contract_invalid");
  }
  const candidate = normalizeScheduleBusinessOwnerAcceptanceCandidateV2(value.candidate);
  const {
    processingAuthorityDigest: _processing,
    retentionDefinitionDigest: _retention,
    candidateDigest: _candidateDigest,
    ...legacyCandidateFields
  } = candidate;
  const legacyCandidateBody = {
    ...legacyCandidateFields,
    contractVersion: SCHEDULE_BUSINESS_OWNER_ACCEPTANCE_CANDIDATE_CONTRACT_VERSION,
  };
  const legacy = normalizeRevisionBody({
    ...value,
    contractVersion: SCHEDULE_BUSINESS_OWNER_ACCEPTANCE_CONTRACT_VERSION,
    candidate: { ...legacyCandidateBody, candidateDigest: digestCanonical(legacyCandidateBody) },
  });
  return deepFreeze({
    ...legacy,
    contractVersion: SCHEDULE_BUSINESS_OWNER_ACCEPTANCE_CONTRACT_VERSION_V2,
    candidate,
  });
}

function normalizeProofBodyV2(value) {
  exactObject(value, PROOF_BODY_FIELDS_V2, "schedule_owner_acceptance_proof_v2_fields_invalid");
  if (value.contractVersion !== SCHEDULE_BUSINESS_OWNER_ACCEPTANCE_PROOF_CONTRACT_VERSION_V2) {
    throw acceptanceError("schedule_owner_acceptance_proof_v2_contract_invalid");
  }
  const processing = normalizeScheduleResultProcessingBinding({
    contractVersion: "schedule-result-processing-binding.v1",
    resultContractDigest: value.resultContractDigest,
    alertContractDigest: value.alertContractDigest,
    retentionDefinitionDigest: value.retentionDefinitionDigest,
    processingAuthorityDigest: value.processingAuthorityDigest,
  });
  const approvedAt = canonicalTimestamp(value.approvedAt, "approvedAt");
  const validUntil = canonicalTimestamp(value.validUntil, "validUntil");
  if (validUntil <= approvedAt) throw acceptanceError("schedule_owner_acceptance_validity_invalid");
  return deepFreeze({
    contractVersion: SCHEDULE_BUSINESS_OWNER_ACCEPTANCE_PROOF_CONTRACT_VERSION_V2,
    acceptanceCandidateDigest: requiredDigest(value.acceptanceCandidateDigest, "acceptanceCandidateDigest"),
    acceptanceRevisionDigest: requiredDigest(value.acceptanceRevisionDigest, "acceptanceRevisionDigest"),
    approvalId: token(value.approvalId, "approvalId"),
    approvalRevision: positiveInteger(value.approvalRevision, "approvalRevision"),
    decision: exactValue(value.decision, "approved", "schedule_owner_acceptance_proof_v2_invalid"),
    approverPrincipalId: token(value.approverPrincipalId, "approverPrincipalId"),
    approvalPolicyDigest: requiredDigest(value.approvalPolicyDigest, "approvalPolicyDigest"),
    readinessDigest: requiredDigest(value.readinessDigest, "readinessDigest"),
    registrationVersion: positiveInteger(value.registrationVersion, "registrationVersion"),
    scheduleVersion: token(value.scheduleVersion, "scheduleVersion"),
    employeeVersion: token(value.employeeVersion, "employeeVersion"),
    schedulePolicyDigest: requiredDigest(value.schedulePolicyDigest, "schedulePolicyDigest"),
    executionContractDigest: requiredDigest(value.executionContractDigest, "executionContractDigest"),
    taskBindingDigest: requiredDigest(value.taskBindingDigest, "taskBindingDigest"),
    resultContractDigest: processing.resultContractDigest,
    alertContractDigest: processing.alertContractDigest,
    retentionDefinitionDigest: processing.retentionDefinitionDigest,
    processingAuthorityDigest: processing.processingAuthorityDigest,
    writebackContractDigest: requiredDigest(value.writebackContractDigest, "writebackContractDigest"),
    approvedAt,
    validUntil,
  });
}

function normalizeProviderTrial(value) {
  exactObject(value, PROVIDER_TRIAL_FIELDS, "schedule_owner_acceptance_provider_trial_invalid");
  return deepFreeze({
    dryRunId: token(value.dryRunId, "providerTrial.dryRunId"),
    attemptSequence: positiveInteger(value.attemptSequence, "providerTrial.attemptSequence"),
    dryRunVersion: positiveInteger(value.dryRunVersion, "providerTrial.dryRunVersion"),
    registrationVersion: positiveInteger(value.registrationVersion, "providerTrial.registrationVersion"),
    scheduleVersion: token(value.scheduleVersion, "providerTrial.scheduleVersion"),
    employeeVersion: token(value.employeeVersion, "providerTrial.employeeVersion"),
    schedulePolicyDigest: requiredDigest(value.schedulePolicyDigest, "providerTrial.schedulePolicyDigest"),
    executionContractDigest: requiredDigest(value.executionContractDigest, "providerTrial.executionContractDigest"),
    taskBindingDigest: requiredDigest(value.taskBindingDigest, "providerTrial.taskBindingDigest"),
    outcome: exactValue(value.outcome, "passed", "schedule_owner_acceptance_provider_trial_invalid"),
    evidenceDigest: requiredDigest(value.evidenceDigest, "providerTrial.evidenceDigest"),
    canonicalTaskId: token(value.canonicalTaskId, "providerTrial.canonicalTaskId"),
    canonicalTaskRevision: positiveInteger(value.canonicalTaskRevision, "providerTrial.canonicalTaskRevision"),
    canonicalTaskStatus: exactValue(
      value.canonicalTaskStatus,
      "completed",
      "schedule_owner_acceptance_provider_trial_invalid",
    ),
    passedAt: canonicalTimestamp(value.passedAt, "providerTrial.passedAt"),
  });
}

function normalizeOwnerAssignment(value) {
  exactObject(value, OWNER_ASSIGNMENT_FIELDS, "schedule_owner_acceptance_owner_assignment_invalid");
  if (value.contractVersion !== "digital-employee-business-owner-assignment.v1" ||
    value.role !== "businessOwner" || value.assigneeType !== "user") {
    throw acceptanceError("schedule_owner_acceptance_owner_assignment_invalid");
  }
  return deepFreeze({
    contractVersion: "digital-employee-business-owner-assignment.v1",
    role: "businessOwner",
    assigneeType: "user",
    assignmentVersion: positiveInteger(value.assignmentVersion, "ownerAssignment.assignmentVersion"),
    assigneeSubjectDigest: requiredDigest(value.assigneeSubjectDigest, "ownerAssignment.assigneeSubjectDigest"),
    assignmentDigest: requiredDigest(value.assignmentDigest, "ownerAssignment.assignmentDigest"),
  });
}

function normalizePersonnelAuthority(value) {
  exactObject(value, PERSONNEL_AUTHORITY_FIELDS, "schedule_owner_acceptance_personnel_authority_invalid");
  if (value.contractVersion !== "personnel-owner-authority.v1") {
    throw acceptanceError("schedule_owner_acceptance_personnel_authority_invalid");
  }
  return deepFreeze({
    contractVersion: "personnel-owner-authority.v1",
    authorityVersion: token(value.authorityVersion, "personnelAuthority.authorityVersion"),
    authorityDigest: requiredDigest(value.authorityDigest, "personnelAuthority.authorityDigest"),
    ownerMembershipDigest: requiredDigest(value.ownerMembershipDigest, "personnelAuthority.ownerMembershipDigest"),
  });
}

function normalizeAcceptancePolicy(value) {
  exactObject(value, ACCEPTANCE_POLICY_FIELDS, "schedule_owner_acceptance_policy_invalid");
  if (value.contractVersion !== "schedule-business-owner-acceptance-policy.v1") {
    throw acceptanceError("schedule_owner_acceptance_policy_invalid");
  }
  return deepFreeze({
    contractVersion: "schedule-business-owner-acceptance-policy.v1",
    policyVersion: token(value.policyVersion, "acceptancePolicy.policyVersion"),
    maxValiditySeconds: boundedInteger(
      value.maxValiditySeconds,
      1,
      31_536_000,
      "acceptancePolicy.maxValiditySeconds",
    ),
    policyDigest: requiredDigest(value.policyDigest, "acceptancePolicy.policyDigest"),
  });
}

function normalizeReadiness(value) {
  exactObject(value, READINESS_FIELDS, "schedule_owner_acceptance_readiness_invalid");
  if (value.contractVersion !== "schedule-pre-owner-readiness.v1") {
    throw acceptanceError("schedule_owner_acceptance_readiness_invalid");
  }
  return deepFreeze({
    contractVersion: "schedule-pre-owner-readiness.v1",
    readinessVersion: positiveInteger(value.readinessVersion, "readiness.readinessVersion"),
    readinessDigest: requiredDigest(value.readinessDigest, "readiness.readinessDigest"),
  });
}

function normalizeActor(value) {
  exactObject(value, ACTOR_FIELDS, "schedule_owner_acceptance_actor_invalid");
  return deepFreeze({
    issuer: token(value.issuer, "actor.issuer"),
    subjectDigest: requiredDigest(value.subjectDigest, "actor.subjectDigest"),
    authorizationDigest: requiredDigest(value.authorizationDigest, "actor.authorizationDigest"),
    permissionDigest: requiredDigest(value.permissionDigest, "actor.permissionDigest"),
    ownerMembershipDigest: requiredDigest(value.ownerMembershipDigest, "actor.ownerMembershipDigest"),
  });
}

function requireCandidateBindings(candidate) {
  const trial = candidate.providerTrial;
  if (trial.registrationVersion !== candidate.registrationVersion ||
    trial.scheduleVersion !== candidate.scheduleVersion || trial.employeeVersion !== candidate.employeeVersion ||
    trial.schedulePolicyDigest !== candidate.schedulePolicyDigest ||
    trial.executionContractDigest !== candidate.executionContractDigest ||
    trial.taskBindingDigest !== candidate.taskBindingDigest) {
    throw acceptanceError("schedule_owner_acceptance_provider_trial_binding_mismatch");
  }
  if (candidate.ownerAuthorization.subjectDigest !== candidate.ownerAssignment.assigneeSubjectDigest ||
    candidate.ownerAuthorization.ownerMembershipDigest !== candidate.personnelAuthority.ownerMembershipDigest) {
    throw acceptanceError("schedule_owner_acceptance_owner_authorization_binding_mismatch");
  }
  if (candidate.ownerAuthorityValidUntil <= trial.passedAt) {
    throw acceptanceError("schedule_owner_acceptance_owner_authority_validity_invalid");
  }
}

function sameActor(left, right) {
  return left.issuer === right.issuer && left.subjectDigest === right.subjectDigest &&
    left.authorizationDigest === right.authorizationDigest && left.permissionDigest === right.permissionDigest &&
    left.ownerMembershipDigest === right.ownerMembershipDigest;
}

function requireSameTarget(left, right) {
  if (left.tenantScope !== right.tenantScope || left.employeeId !== right.employeeId ||
    left.scheduleId !== right.scheduleId) {
    throw acceptanceError("schedule_owner_acceptance_target_mismatch");
  }
}

function acceptanceIdFor(candidate) {
  return `schedule_owner_acceptance_${digestCanonical({
    tenantScope: candidate.tenantScope,
    employeeId: candidate.employeeId,
    scheduleId: candidate.scheduleId,
  })}`;
}

function normalizeTimeoutPolicy(value) {
  try {
    return normalizeProviderTimeoutPolicy(value);
  } catch {
    throw acceptanceError("schedule_owner_acceptance_timeout_policy_invalid");
  }
}

function exactObject(value, fields, code) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw acceptanceError(code);
  const expected = [...fields].sort();
  const actual = Object.keys(value).sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw acceptanceError(code);
  }
}

function token(value, field) {
  const result = String(value || "").trim();
  if (!TOKEN_PATTERN.test(result) || EMAIL_PATTERN.test(result) || SECRET_PATTERN.test(result)) {
    throw acceptanceError("schedule_owner_acceptance_token_invalid", field);
  }
  return result;
}

function requiredDigest(value, field) {
  const result = String(value || "").trim().toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(result)) {
    throw acceptanceError("schedule_owner_acceptance_digest_invalid", field);
  }
  return result;
}

function canonicalTimestamp(value, field) {
  if (typeof value !== "string") throw acceptanceError("schedule_owner_acceptance_timestamp_invalid", field);
  const timestamp = new Date(value);
  if (!Number.isFinite(timestamp.getTime()) || timestamp.toISOString() !== value) {
    throw acceptanceError("schedule_owner_acceptance_timestamp_invalid", field);
  }
  return value;
}

function positiveInteger(value, field) {
  const result = Number(value);
  if (!Number.isSafeInteger(result) || result < 1) {
    throw acceptanceError("schedule_owner_acceptance_number_invalid", field);
  }
  return result;
}

function nonNegativeInteger(value, field) {
  return boundedInteger(value, 0, Number.MAX_SAFE_INTEGER, field);
}

function boundedInteger(value, minimum, maximum, field) {
  const result = Number(value);
  if (!Number.isSafeInteger(result) || result < minimum || result > maximum) {
    throw acceptanceError("schedule_owner_acceptance_number_invalid", field);
  }
  return result;
}

function enumValue(value, allowed, code) {
  if (!allowed.includes(value)) throw acceptanceError(code);
  return value;
}

function exactValue(value, expected, code) {
  if (value !== expected) throw acceptanceError(code);
  return expected;
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

function acceptanceError(code, detail = "") {
  const error = new Error(detail ? `${code}: ${detail}` : code);
  error.code = code;
  return error;
}

export {
  SCHEDULE_BUSINESS_OWNER_ACCEPTANCE_CANDIDATE_CONTRACT_VERSION,
  SCHEDULE_BUSINESS_OWNER_ACCEPTANCE_CONTRACT_VERSION,
  SCHEDULE_BUSINESS_OWNER_ACCEPTANCE_EVALUATION_CONTRACT_VERSION,
  SCHEDULE_BUSINESS_OWNER_ACCEPTANCE_PROOF_CONTRACT_VERSION,
  SCHEDULE_BUSINESS_OWNER_ACCEPTANCE_CANDIDATE_CONTRACT_VERSION_V2,
  SCHEDULE_BUSINESS_OWNER_ACCEPTANCE_CONTRACT_VERSION_V2,
  SCHEDULE_BUSINESS_OWNER_ACCEPTANCE_EVALUATION_CONTRACT_VERSION_V2,
  SCHEDULE_BUSINESS_OWNER_ACCEPTANCE_PROOF_CONTRACT_VERSION_V2,
  createScheduleBusinessOwnerAcceptanceCandidate,
  createScheduleBusinessOwnerAcceptanceCandidateV2,
  createScheduleBusinessOwnerAcceptanceRevision,
  createScheduleBusinessOwnerAcceptanceRevisionV2,
  evaluateScheduleBusinessOwnerAcceptance,
  evaluateScheduleBusinessOwnerAcceptanceV2,
  normalizeScheduleBusinessOwnerAcceptanceCandidate,
  normalizeScheduleBusinessOwnerAcceptanceCandidateV2,
  normalizeScheduleBusinessOwnerAcceptanceProofV2,
  normalizeScheduleBusinessOwnerAcceptanceRevision,
  normalizeScheduleBusinessOwnerAcceptanceRevisionV2,
  projectScheduleBusinessOwnerAcceptanceProof,
  projectScheduleBusinessOwnerAcceptanceProofV2,
};
