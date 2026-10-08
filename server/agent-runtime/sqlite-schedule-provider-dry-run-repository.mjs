import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

const SCHEDULE_PROVIDER_DRY_RUN_REPOSITORY_CONTRACT_VERSION =
  "schedule-provider-dry-run-repository.v1";
const SCHEDULE_PROVIDER_DRY_RUN_EVIDENCE_CONTRACT_VERSION =
  "schedule-provider-dry-run-evidence.v1";
const SCHEMA_VERSION = 3;
const SUBMISSION_STATES = new Set(["prepared", "submitted", "reconcile_required"]);
const EXECUTION_PHASES = new Set(["pre_effect", "provider_attempt_started"]);
const EVIDENCE_STATES = new Set(["pending", "committed", "reconcile_required"]);
const EVIDENCE_OUTCOMES = new Set(["passed", "failed", "canceled"]);
const EVIDENCE_CODES = new Set([
  "provider_only_passed",
  "provider_only_blocked",
  "provider_only_canceled",
  "provider_only_failed",
  "provider_only_timed_out",
]);
const SUBMISSION_RECONCILE_CODES = new Set([
  "canonical_task_submission_unknown",
  "canonical_task_submission_reconcile_required",
]);
const EVIDENCE_RECONCILE_CODES = new Set([
  "provider_only_outcome_unknown",
  "provider_only_evidence_reconcile_required",
]);
const TERMINAL_BEFORE_ATTEMPT_STATUSES = new Set([
  "blocked",
  "canceled",
  "failed",
  "lost",
  "rejected",
  "timed_out",
]);
const PREPARE_FIELDS = new Set([
  "actorSubjectDigest",
  "dispatch",
  "inputDigest",
  "preparedAt",
  "purpose",
  "workflowRunId",
]);
const DISPATCH_FIELDS = new Set([
  "contractVersion",
  "employeeId",
  "employeeVersion",
  "executionContractDigest",
  "registrationVersion",
  "scheduleId",
  "schedulePolicyDigest",
  "scheduleVersion",
  "taskId",
  "taskModelBinding",
  "tenantScope",
]);
const TASK_BINDING_FIELDS = new Set([
  "assignmentAppliedVersion",
  "assignmentId",
  "assignmentSetDigest",
  "bindingDigest",
  "bindingVersion",
  "contractVersion",
  "model",
  "modelId",
  "modelLevelId",
  "provider",
  "providerName",
  "providerRouteId",
  "requiredCapabilityProfileVersion",
  "status",
  "taskId",
]);
const EVIDENCE_FIELDS = new Set([
  "contractVersion",
  "outcome",
  "evidenceCode",
  "providerAttempts",
  "usage",
  "safetyEvidence",
]);
const USAGE_FIELDS = new Set(["inputTokens", "outputTokens", "totalTokens"]);
const SAFETY_EVIDENCE_FIELDS = new Set([
  "businessPayloadAttempts",
  "outputPersisted",
  "skillAttempts",
  "toolAttempts",
  "writebackAttempts",
]);

function createSqliteScheduleProviderDryRunRepository({ databasePath } = {}) {
  const safeDatabasePath = requiredDatabasePath(databasePath);
  if (safeDatabasePath !== ":memory:") fs.mkdirSync(path.dirname(safeDatabasePath), { recursive: true });
  const database = new DatabaseSync(safeDatabasePath);
  initializeDatabase(database);

  function prepareOrGet(input = {}) {
    exactObject(input, PREPARE_FIELDS, "schedule_provider_dry_run_prepare_invalid");
    const dispatch = normalizeDispatch(input.dispatch);
    if (input.purpose !== "provider_dry_run") {
      throw repositoryError("schedule_provider_dry_run_purpose_invalid");
    }
    const workflowRunId = token(input.workflowRunId, "workflowRunId");
    const inputDigest = digest(input.inputDigest, "inputDigest");
    const actorSubjectDigest = digest(input.actorSubjectDigest, "actorSubjectDigest");
    const now = canonicalTimestamp(input.preparedAt, "preparedAt");
    const canonicalTaskId = deterministicId("task", {
      employeeId: dispatch.employeeId,
      inputDigest,
      purpose: input.purpose,
      workflowRunId,
      scheduleId: dispatch.scheduleId,
      taskBindingDigest: dispatch.taskModelBinding.bindingDigest,
      tenantScope: dispatch.tenantScope,
    });
    const requestIdDigest = digestCanonical({
      canonicalTaskId,
      employeeId: dispatch.employeeId,
      executionContractDigest: dispatch.executionContractDigest,
      inputDigest,
      purpose: input.purpose,
      registrationVersion: dispatch.registrationVersion,
      workflowRunId,
      scheduleId: dispatch.scheduleId,
      schedulePolicyDigest: dispatch.schedulePolicyDigest,
      scheduleVersion: dispatch.scheduleVersion,
      taskBindingDigest: dispatch.taskModelBinding.bindingDigest,
      tenantScope: dispatch.tenantScope,
    });
    const dryRunId = `schedule_provider_dry_run_${requestIdDigest}`;
    const expectedExecutionTaskId = canonicalTaskId;
    return transaction(database, () => {
      const existing = readRow(dryRunId, dispatch.tenantScope);
      if (existing) {
        requireSamePreparedRequest(existing, {
          actorSubjectDigest,
          dispatch,
          expectedExecutionTaskId,
          inputDigest,
          requestIdDigest,
          workflowRunId,
        });
        return Object.freeze({ created: false, dryRun: rowToDryRun(existing) });
      }
      const active = database.prepare(`
        SELECT dry_run_id FROM schedule_provider_dry_runs
        WHERE tenant_scope = ? AND employee_id = ? AND schedule_id = ? AND registration_version = ?
          AND evidence_state <> 'committed'
      `).get(
        dispatch.tenantScope,
        dispatch.employeeId,
        dispatch.scheduleId,
        dispatch.registrationVersion,
      );
      if (active) throw repositoryError("schedule_provider_dry_run_registration_active");
      const usedRun = database.prepare(`
        SELECT dry_run_id FROM schedule_provider_dry_runs
        WHERE tenant_scope = ? AND workflow_run_id = ?
      `).get(dispatch.tenantScope, workflowRunId);
      if (usedRun) throw repositoryError("schedule_provider_dry_run_workflow_already_used");
      const attemptSequence = database.prepare(`
        SELECT COALESCE(MAX(attempt_sequence), 0) + 1 AS next_sequence
        FROM schedule_provider_dry_runs
        WHERE tenant_scope = ? AND employee_id = ? AND schedule_id = ?
      `).get(dispatch.tenantScope, dispatch.employeeId, dispatch.scheduleId).next_sequence;
      database.prepare(`
        INSERT INTO schedule_provider_dry_runs (
          dry_run_id, dry_run_version, tenant_scope, employee_id, employee_version,
          schedule_id, attempt_sequence, registration_version, schedule_version, task_id,
          schedule_policy_digest, execution_contract_digest,
          assignment_id, assignment_applied_version, assignment_set_digest,
          task_binding_version, task_binding_digest,
          model, model_id, model_level_id, provider_id, provider_route_id, capability_profile_version,
          request_id_digest, actor_subject_digest, expected_execution_task_id,
          workflow_run_id, input_digest,
          submission_state, execution_phase, evidence_state,
          execution_fencing_token, prepared_at, updated_at
        ) VALUES (
          ?, 1,
          ?, ?, ?, ?, ?, ?, ?, ?, ?,
          ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
          ?, ?, ?, ?, ?,
          'prepared', NULL, 'pending', 0, ?, ?
        )
      `).run(
        dryRunId,
        dispatch.tenantScope,
        dispatch.employeeId,
        dispatch.employeeVersion,
        dispatch.scheduleId,
        attemptSequence,
        dispatch.registrationVersion,
        dispatch.scheduleVersion,
        dispatch.taskId,
        dispatch.schedulePolicyDigest,
        dispatch.executionContractDigest,
        dispatch.taskModelBinding.assignmentId,
        dispatch.taskModelBinding.assignmentAppliedVersion,
        dispatch.taskModelBinding.assignmentSetDigest,
        dispatch.taskModelBinding.bindingVersion,
        dispatch.taskModelBinding.bindingDigest,
        dispatch.taskModelBinding.model,
        dispatch.taskModelBinding.modelId,
        dispatch.taskModelBinding.modelLevelId,
        dispatch.taskModelBinding.provider,
        dispatch.taskModelBinding.providerRouteId,
        dispatch.taskModelBinding.requiredCapabilityProfileVersion,
        requestIdDigest,
        actorSubjectDigest,
        expectedExecutionTaskId,
        workflowRunId,
        inputDigest,
        now,
        now,
      );
      return Object.freeze({ created: true, dryRun: rowToDryRun(requireRow(dryRunId, dispatch.tenantScope)) });
    });
  }

  function markSubmitted({
    tenantScope,
    dryRunId,
    expectedDryRunVersion,
    executionTaskId,
    submittedAt,
  } = {}) {
    const identity = normalizeDryRunIdentity({ dryRunId, tenantScope });
    const expectedVersion = positiveInteger(expectedDryRunVersion, "expectedDryRunVersion");
    const taskId = token(executionTaskId, "executionTaskId");
    const now = canonicalTimestamp(submittedAt, "submittedAt");
    const result = database.prepare(`
      UPDATE schedule_provider_dry_runs
      SET dry_run_version = dry_run_version + 1,
          submission_state = 'submitted', execution_task_id = ?,
          submission_error_code = NULL, submitted_at = ?, updated_at = ?
      WHERE dry_run_id = ? AND tenant_scope = ? AND dry_run_version = ?
        AND submission_state IN ('prepared', 'reconcile_required')
        AND evidence_state = 'pending' AND expected_execution_task_id = ?
    `).run(taskId, now, now, identity.dryRunId, identity.tenantScope, expectedVersion, taskId);
    if (result.changes !== 1) throw repositoryError("schedule_provider_dry_run_submission_conflict");
    return rowToDryRun(requireRow(identity.dryRunId, identity.tenantScope));
  }

  function markSubmissionReconcileRequired({
    tenantScope,
    dryRunId,
    expectedDryRunVersion,
    errorCode,
    reconciledAt,
  } = {}) {
    const identity = normalizeDryRunIdentity({ dryRunId, tenantScope });
    const expectedVersion = positiveInteger(expectedDryRunVersion, "expectedDryRunVersion");
    const safeErrorCode = enumValue(
      errorCode,
      SUBMISSION_RECONCILE_CODES,
      "schedule_provider_dry_run_submission_error_code_invalid",
    );
    const now = canonicalTimestamp(reconciledAt, "reconciledAt");
    const result = database.prepare(`
      UPDATE schedule_provider_dry_runs
      SET dry_run_version = dry_run_version + 1,
          submission_state = 'reconcile_required', submission_error_code = ?,
          submission_reconciled_at = ?, updated_at = ?
      WHERE dry_run_id = ? AND tenant_scope = ? AND dry_run_version = ?
        AND submission_state = 'prepared' AND evidence_state = 'pending'
    `).run(safeErrorCode, now, now, identity.dryRunId, identity.tenantScope, expectedVersion);
    if (result.changes !== 1) throw repositoryError("schedule_provider_dry_run_submission_conflict");
    return rowToDryRun(requireRow(identity.dryRunId, identity.tenantScope));
  }

  function claimPreEffect({
    tenantScope,
    dryRunId,
    expectedDryRunVersion,
    taskLeaseId,
    taskOwnerDigest,
    taskFencingToken,
    taskLeaseExpiresAt,
    executionOwnerDigest,
    leaseDurationMs = 30_000,
    claimedAt,
  } = {}) {
    const identity = normalizeDryRunIdentity({ dryRunId, tenantScope });
    const expectedVersion = positiveInteger(expectedDryRunVersion, "expectedDryRunVersion");
    const taskLease = normalizeClaimTaskLeaseIdentity({
      taskFencingToken,
      taskLeaseExpiresAt,
      taskLeaseId,
      taskOwnerDigest,
    });
    const safeOwnerDigest = digest(executionOwnerDigest, "executionOwnerDigest");
    const now = canonicalTimestamp(claimedAt, "claimedAt");
    const leaseExpiresAt = earliestTimestamp(
      addMilliseconds(now, boundedInteger(leaseDurationMs, 1, 86_400_000, "leaseDurationMs")),
      taskLease.taskLeaseExpiresAt,
    );
    if (leaseExpiresAt <= now) throw repositoryError("schedule_provider_dry_run_task_lease_expired");
    const leaseId = `schedule-provider-dry-run-lease-${crypto.randomUUID()}`;
    const result = database.prepare(`
      UPDATE schedule_provider_dry_runs
      SET dry_run_version = dry_run_version + 1,
          execution_phase = 'pre_effect', execution_lease_id = ?, execution_owner_digest = ?,
          execution_fencing_token = 1, execution_lease_expires_at = ?,
          task_lease_id = ?, task_owner_digest = ?, task_fencing_token = ?, task_lease_expires_at = ?,
          claimed_at = ?, updated_at = ?
      WHERE dry_run_id = ? AND tenant_scope = ? AND dry_run_version = ?
        AND submission_state = 'submitted' AND execution_phase IS NULL AND evidence_state = 'pending'
    `).run(
      leaseId,
      safeOwnerDigest,
      leaseExpiresAt,
      taskLease.taskLeaseId,
      taskLease.taskOwnerDigest,
      taskLease.taskFencingToken,
      taskLease.taskLeaseExpiresAt,
      now,
      now,
      identity.dryRunId,
      identity.tenantScope,
      expectedVersion,
    );
    if (result.changes !== 1) throw repositoryError("schedule_provider_dry_run_execution_claim_conflict");
    return rowToDryRun(requireRow(identity.dryRunId, identity.tenantScope));
  }

  function takeoverPreEffect({
    tenantScope,
    dryRunId,
    expectedDryRunVersion,
    taskLeaseId,
    taskOwnerDigest,
    taskFencingToken,
    taskLeaseExpiresAt,
    executionOwnerDigest,
    leaseDurationMs = 30_000,
    takenOverAt,
  } = {}) {
    const identity = normalizeDryRunIdentity({ dryRunId, tenantScope });
    const expectedVersion = positiveInteger(expectedDryRunVersion, "expectedDryRunVersion");
    const taskLease = normalizeClaimTaskLeaseIdentity({
      taskFencingToken,
      taskLeaseExpiresAt,
      taskLeaseId,
      taskOwnerDigest,
    });
    const safeOwnerDigest = digest(executionOwnerDigest, "executionOwnerDigest");
    const now = canonicalTimestamp(takenOverAt, "takenOverAt");
    const leaseExpiresAt = earliestTimestamp(
      addMilliseconds(now, boundedInteger(leaseDurationMs, 1, 86_400_000, "leaseDurationMs")),
      taskLease.taskLeaseExpiresAt,
    );
    if (leaseExpiresAt <= now) throw repositoryError("schedule_provider_dry_run_task_lease_expired");
    const leaseId = `schedule-provider-dry-run-lease-${crypto.randomUUID()}`;
    const result = database.prepare(`
      UPDATE schedule_provider_dry_runs
      SET dry_run_version = dry_run_version + 1,
          execution_lease_id = ?, execution_owner_digest = ?,
          execution_fencing_token = execution_fencing_token + 1, execution_lease_expires_at = ?,
          task_lease_id = ?, task_owner_digest = ?, task_fencing_token = ?, task_lease_expires_at = ?,
          claimed_at = ?, updated_at = ?
      WHERE dry_run_id = ? AND tenant_scope = ? AND dry_run_version = ?
        AND submission_state = 'submitted' AND execution_phase = 'pre_effect' AND evidence_state = 'pending'
        AND execution_lease_expires_at <= ? AND task_fencing_token < ?
    `).run(
      leaseId,
      safeOwnerDigest,
      leaseExpiresAt,
      taskLease.taskLeaseId,
      taskLease.taskOwnerDigest,
      taskLease.taskFencingToken,
      taskLease.taskLeaseExpiresAt,
      now,
      now,
      identity.dryRunId,
      identity.tenantScope,
      expectedVersion,
      now,
      taskLease.taskFencingToken,
    );
    if (result.changes !== 1) throw repositoryError("schedule_provider_dry_run_execution_takeover_conflict");
    return rowToDryRun(requireRow(identity.dryRunId, identity.tenantScope));
  }

  // A successful CAS is the sole authorization to send this workflow's one Provider request.
  function beginProviderAttempt({
    tenantScope,
    dryRunId,
    expectedDryRunVersion,
    leaseId,
    executionOwnerDigest,
    executionFencingToken,
    taskLeaseId,
    taskOwnerDigest,
    taskFencingToken,
    preparedAt,
  } = {}) {
    const identity = normalizeDryRunIdentity({ dryRunId, tenantScope });
    const expectedVersion = positiveInteger(expectedDryRunVersion, "expectedDryRunVersion");
    const lease = normalizeDualLeaseIdentity({
      executionFencingToken,
      executionOwnerDigest,
      leaseId,
      taskFencingToken,
      taskLeaseId,
      taskOwnerDigest,
    });
    const now = canonicalTimestamp(preparedAt, "preparedAt");
    const result = database.prepare(`
      UPDATE schedule_provider_dry_runs
      SET dry_run_version = dry_run_version + 1,
          execution_phase = 'provider_attempt_started', provider_attempts = 1,
          provider_attempt_started_at = ?, updated_at = ?
      WHERE dry_run_id = ? AND tenant_scope = ? AND dry_run_version = ?
        AND submission_state = 'submitted' AND execution_phase = 'pre_effect' AND evidence_state = 'pending'
        AND execution_lease_id = ? AND execution_owner_digest = ? AND execution_fencing_token = ?
        AND task_lease_id = ? AND task_owner_digest = ? AND task_fencing_token = ?
        AND execution_lease_expires_at > ? AND task_lease_expires_at > ?
    `).run(
      now,
      now,
      identity.dryRunId,
      identity.tenantScope,
      expectedVersion,
      lease.leaseId,
      lease.executionOwnerDigest,
      lease.executionFencingToken,
      lease.taskLeaseId,
      lease.taskOwnerDigest,
      lease.taskFencingToken,
      now,
      now,
    );
    if (result.changes !== 1) throw repositoryError("schedule_provider_dry_run_effect_prepare_conflict");
    return rowToDryRun(requireRow(identity.dryRunId, identity.tenantScope));
  }

  function commitEvidence({
    tenantScope,
    dryRunId,
    expectedDryRunVersion,
    leaseId,
    executionOwnerDigest,
    executionFencingToken,
    taskLeaseId,
    taskOwnerDigest,
    taskFencingToken,
    evidence,
    committedAt,
  } = {}) {
    const identity = normalizeDryRunIdentity({ dryRunId, tenantScope });
    const expectedVersion = positiveInteger(expectedDryRunVersion, "expectedDryRunVersion");
    const lease = normalizeDualLeaseIdentity({
      executionFencingToken,
      executionOwnerDigest,
      leaseId,
      taskFencingToken,
      taskLeaseId,
      taskOwnerDigest,
    });
    const safeEvidence = normalizeEvidence(evidence);
    const now = canonicalTimestamp(committedAt, "committedAt");
    return transaction(database, () => {
      const current = requireRow(identity.dryRunId, identity.tenantScope);
      if (current.dry_run_version !== expectedVersion || current.submission_state !== "submitted" ||
        current.evidence_state !== "pending" || !EXECUTION_PHASES.has(current.execution_phase) ||
        !sameDualLease(current, lease) ||
        (current.execution_phase === "provider_attempt_started" &&
          (safeEvidence.providerAttempts !== 1 || safeEvidence.outcome !== "passed")) ||
        (current.execution_phase === "pre_effect" && safeEvidence.providerAttempts !== 0)) {
        throw repositoryError("schedule_provider_dry_run_evidence_commit_conflict");
      }
      const evidenceDigest = digestCanonical({
        dryRunId: current.dry_run_id,
        evidence: safeEvidence,
        executionFencingToken: current.execution_fencing_token,
        taskBindingDigest: current.task_binding_digest,
        taskFencingToken: current.task_fencing_token,
      });
      const result = database.prepare(`
        UPDATE schedule_provider_dry_runs
        SET dry_run_version = dry_run_version + 1,
            evidence_state = 'committed', evidence_outcome = ?, evidence_code = ?,
            provider_attempts = ?, usage_input_tokens = ?, usage_output_tokens = ?, usage_total_tokens = ?,
            evidence_digest = ?, evidence_committed_at = ?,
            execution_lease_id = NULL, execution_owner_digest = NULL, execution_lease_expires_at = NULL,
            updated_at = ?
        WHERE dry_run_id = ? AND tenant_scope = ? AND dry_run_version = ? AND evidence_state = 'pending'
          AND execution_lease_id = ? AND execution_owner_digest = ? AND execution_fencing_token = ?
          AND task_lease_id = ? AND task_owner_digest = ? AND task_fencing_token = ?
      `).run(
        safeEvidence.outcome,
        safeEvidence.evidenceCode,
        safeEvidence.providerAttempts,
        safeEvidence.usage.inputTokens,
        safeEvidence.usage.outputTokens,
        safeEvidence.usage.totalTokens,
        evidenceDigest,
        now,
        now,
        identity.dryRunId,
        identity.tenantScope,
        expectedVersion,
        lease.leaseId,
        lease.executionOwnerDigest,
        lease.executionFencingToken,
        lease.taskLeaseId,
        lease.taskOwnerDigest,
        lease.taskFencingToken,
      );
      if (result.changes !== 1) throw repositoryError("schedule_provider_dry_run_evidence_commit_conflict");
      return rowToDryRun(requireRow(identity.dryRunId, identity.tenantScope));
    });
  }

  function markEvidenceReconcileRequired({
    tenantScope,
    dryRunId,
    expectedDryRunVersion,
    leaseId,
    executionOwnerDigest,
    executionFencingToken,
    taskLeaseId,
    taskOwnerDigest,
    taskFencingToken,
    errorCode,
    reconciledAt,
  } = {}) {
    const identity = normalizeDryRunIdentity({ dryRunId, tenantScope });
    const expectedVersion = positiveInteger(expectedDryRunVersion, "expectedDryRunVersion");
    const lease = normalizeDualLeaseIdentity({
      executionFencingToken,
      executionOwnerDigest,
      leaseId,
      taskFencingToken,
      taskLeaseId,
      taskOwnerDigest,
    });
    const safeErrorCode = enumValue(
      errorCode,
      EVIDENCE_RECONCILE_CODES,
      "schedule_provider_dry_run_evidence_error_code_invalid",
    );
    const now = canonicalTimestamp(reconciledAt, "reconciledAt");
    const evidenceDigest = digestCanonical({
      dryRunId: identity.dryRunId,
      errorCode: safeErrorCode,
      executionFencingToken: lease.executionFencingToken,
      taskFencingToken: lease.taskFencingToken,
    });
    const result = database.prepare(`
      UPDATE schedule_provider_dry_runs
      SET dry_run_version = dry_run_version + 1,
          evidence_state = 'reconcile_required', evidence_code = ?, evidence_digest = ?,
          evidence_reconciled_at = ?, execution_lease_id = NULL,
          execution_owner_digest = NULL, execution_lease_expires_at = NULL, updated_at = ?
      WHERE dry_run_id = ? AND tenant_scope = ? AND dry_run_version = ?
        AND submission_state = 'submitted' AND execution_phase = 'provider_attempt_started'
        AND evidence_state = 'pending'
        AND execution_lease_id = ? AND execution_owner_digest = ? AND execution_fencing_token = ?
        AND task_lease_id = ? AND task_owner_digest = ? AND task_fencing_token = ?
    `).run(
      safeErrorCode,
      evidenceDigest,
      now,
      now,
      identity.dryRunId,
      identity.tenantScope,
      expectedVersion,
      lease.leaseId,
      lease.executionOwnerDigest,
      lease.executionFencingToken,
      lease.taskLeaseId,
      lease.taskOwnerDigest,
      lease.taskFencingToken,
    );
    if (result.changes !== 1) throw repositoryError("schedule_provider_dry_run_evidence_reconcile_conflict");
    return rowToDryRun(requireRow(identity.dryRunId, identity.tenantScope));
  }

  function observeCanonicalTerminalBeforeAttempt({
    tenantScope,
    dryRunId,
    expectedDryRunVersion,
    canonicalTaskId,
    canonicalTaskRevision,
    canonicalTaskStatus,
    observedAt,
  } = {}) {
    const identity = normalizeDryRunIdentity({ dryRunId, tenantScope });
    const expectedVersion = positiveInteger(expectedDryRunVersion, "expectedDryRunVersion");
    const taskId = token(canonicalTaskId, "canonicalTaskId");
    const taskRevision = positiveInteger(canonicalTaskRevision, "canonicalTaskRevision");
    const taskStatus = enumValue(
      canonicalTaskStatus,
      TERMINAL_BEFORE_ATTEMPT_STATUSES,
      "schedule_provider_dry_run_canonical_terminal_status_invalid",
    );
    const now = canonicalTimestamp(observedAt, "observedAt");
    const outcome = taskStatus === "canceled" ? "canceled" : "failed";
    const evidenceCode = taskStatus === "canceled"
      ? "provider_only_canceled"
      : taskStatus === "timed_out"
        ? "provider_only_timed_out"
        : ["blocked", "rejected"].includes(taskStatus)
          ? "provider_only_blocked"
          : "provider_only_failed";
    const evidenceDigest = digestCanonical({
      canonicalTaskId: taskId,
      canonicalTaskRevision: taskRevision,
      canonicalTaskStatus: taskStatus,
      dryRunId: identity.dryRunId,
      evidenceCode,
      outcome,
      providerAttempts: 0,
    });
    const result = database.prepare(`
      UPDATE schedule_provider_dry_runs
      SET dry_run_version = dry_run_version + 1,
          evidence_state = 'committed', evidence_outcome = ?, evidence_code = ?,
          provider_attempts = 0, usage_input_tokens = 0, usage_output_tokens = 0, usage_total_tokens = 0,
          evidence_digest = ?, evidence_committed_at = ?,
          canonical_task_revision = ?, canonical_task_status = ?, canonical_terminal_observed_at = ?,
          execution_lease_id = NULL, execution_owner_digest = NULL, execution_lease_expires_at = NULL,
          updated_at = ?
      WHERE dry_run_id = ? AND tenant_scope = ? AND dry_run_version = ?
        AND submission_state = 'submitted' AND execution_task_id = ? AND expected_execution_task_id = ?
        AND evidence_state = 'pending' AND execution_phase IS NOT 'provider_attempt_started'
        AND (provider_attempts IS NULL OR provider_attempts = 0)
    `).run(
      outcome,
      evidenceCode,
      evidenceDigest,
      now,
      taskRevision,
      taskStatus,
      now,
      now,
      identity.dryRunId,
      identity.tenantScope,
      expectedVersion,
      taskId,
      taskId,
    );
    if (result.changes !== 1) {
      throw repositoryError("schedule_provider_dry_run_canonical_terminal_conflict");
    }
    return rowToDryRun(requireRow(identity.dryRunId, identity.tenantScope));
  }

  function get(dryRunId, { tenantScope } = {}) {
    const identity = normalizeDryRunIdentity({ dryRunId, tenantScope });
    const row = readRow(identity.dryRunId, identity.tenantScope);
    return row ? rowToDryRun(row) : null;
  }

  function getLatestForSchedule({ employeeId, scheduleId, tenantScope } = {}) {
    const safeTenant = token(tenantScope, "tenantScope");
    const safeEmployeeId = token(employeeId, "employeeId");
    const safeScheduleId = token(scheduleId, "scheduleId");
    const row = database.prepare(`
      SELECT * FROM schedule_provider_dry_runs
      WHERE tenant_scope = ? AND employee_id = ? AND schedule_id = ?
      ORDER BY attempt_sequence DESC LIMIT 1
    `).get(safeTenant, safeEmployeeId, safeScheduleId);
    return row ? rowToDryRun(row) : null;
  }

  function listIncomplete({ tenantScope, limit = 100 } = {}) {
    const safeTenant = token(tenantScope, "tenantScope");
    const safeLimit = boundedInteger(limit, 1, 500, "limit");
    return database.prepare(`
      SELECT * FROM schedule_provider_dry_runs
      WHERE tenant_scope = ? AND evidence_state <> 'committed'
      ORDER BY prepared_at ASC, dry_run_id ASC LIMIT ?
    `).all(safeTenant, safeLimit).map(rowToDryRun);
  }

  function readRow(dryRunId, tenantScope) {
    return database.prepare(`
      SELECT * FROM schedule_provider_dry_runs
      WHERE dry_run_id = ? AND tenant_scope = ?
    `).get(dryRunId, tenantScope) || null;
  }

  function requireRow(dryRunId, tenantScope) {
    const row = readRow(dryRunId, tenantScope);
    if (!row) throw repositoryError("schedule_provider_dry_run_not_found");
    return row;
  }

  return Object.freeze({
    adapterKind: "sqlite_schedule_provider_dry_run_intent_and_evidence",
    claimPreEffect,
    close: () => database.close(),
    commitEvidence,
    contractVersion: SCHEDULE_PROVIDER_DRY_RUN_REPOSITORY_CONTRACT_VERSION,
    get,
    getLatestForSchedule,
    listIncomplete,
    markEvidenceReconcileRequired,
    markSubmitted,
    markSubmissionReconcileRequired,
    observeCanonicalTerminalBeforeAttempt,
    beginProviderAttempt,
    prepareOrGet,
    takeoverPreEffect,
  });
}

function initializeDatabase(database) {
  database.exec(`
    PRAGMA foreign_keys = ON;
    PRAGMA busy_timeout = 5000;
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = FULL;
  `);
  database.exec(`
    CREATE TABLE IF NOT EXISTS schedule_provider_dry_run_schema (
      singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
      version INTEGER NOT NULL
    );
    INSERT OR IGNORE INTO schedule_provider_dry_run_schema (singleton, version) VALUES (1, ${SCHEMA_VERSION});
  `);
  let schema = database.prepare("SELECT version FROM schedule_provider_dry_run_schema WHERE singleton = 1").get();
  if (schema?.version === 1) {
    const columns = new Set(database.prepare("PRAGMA table_info(schedule_provider_dry_runs)").all()
      .map((column) => column.name));
    const newColumns = ["canonical_task_revision", "canonical_task_status", "canonical_terminal_observed_at"];
    if (newColumns.some((column) => columns.has(column))) {
      throw new TypeError("invalid partial schedule provider dry-run SQLite schema migration");
    }
    database.exec(`
      BEGIN IMMEDIATE;
      ALTER TABLE schedule_provider_dry_runs ADD COLUMN canonical_task_revision INTEGER
        CHECK (canonical_task_revision IS NULL OR canonical_task_revision > 0);
      ALTER TABLE schedule_provider_dry_runs ADD COLUMN canonical_task_status TEXT
        CHECK (canonical_task_status IS NULL OR canonical_task_status IN (
          'blocked', 'canceled', 'failed', 'lost', 'rejected', 'timed_out'
        ));
      ALTER TABLE schedule_provider_dry_runs ADD COLUMN canonical_terminal_observed_at TEXT;
      UPDATE schedule_provider_dry_run_schema SET version = 2 WHERE singleton = 1 AND version = 1;
      COMMIT;
    `);
    schema = { version: 2 };
  }
  if (schema?.version === 2) {
    const columns = new Set(database.prepare("PRAGMA table_info(schedule_provider_dry_runs)").all()
      .map((column) => column.name));
    if (columns.has("attempt_sequence")) {
      throw new TypeError("invalid partial schedule provider dry-run SQLite schema migration");
    }
    database.exec(`
      BEGIN IMMEDIATE;
      ALTER TABLE schedule_provider_dry_runs ADD COLUMN attempt_sequence INTEGER;
      WITH ranked AS (
        SELECT dry_run_id,
          ROW_NUMBER() OVER (
            PARTITION BY tenant_scope, employee_id, schedule_id
            ORDER BY prepared_at ASC, dry_run_id ASC
          ) AS sequence
        FROM schedule_provider_dry_runs
      )
      UPDATE schedule_provider_dry_runs
      SET attempt_sequence = (SELECT sequence FROM ranked WHERE ranked.dry_run_id = schedule_provider_dry_runs.dry_run_id);
      CREATE UNIQUE INDEX schedule_provider_dry_runs_attempt_sequence_idx
        ON schedule_provider_dry_runs (tenant_scope, employee_id, schedule_id, attempt_sequence);
      UPDATE schedule_provider_dry_run_schema SET version = 3 WHERE singleton = 1 AND version = 2;
      COMMIT;
    `);
    schema = { version: 3 };
  }
  if (schema?.version !== SCHEMA_VERSION) {
    throw new TypeError("unsupported schedule provider dry-run SQLite schema version");
  }
  database.exec(`
    CREATE TABLE IF NOT EXISTS schedule_provider_dry_runs (
      dry_run_id TEXT PRIMARY KEY,
      dry_run_version INTEGER NOT NULL CHECK (dry_run_version > 0),
      tenant_scope TEXT NOT NULL,
      employee_id TEXT NOT NULL,
      employee_version TEXT NOT NULL,
      schedule_id TEXT NOT NULL,
      attempt_sequence INTEGER NOT NULL CHECK (attempt_sequence > 0),
      registration_version INTEGER NOT NULL CHECK (registration_version > 0),
      schedule_version TEXT NOT NULL,
      task_id TEXT NOT NULL,
      schedule_policy_digest TEXT NOT NULL,
      execution_contract_digest TEXT NOT NULL,
      assignment_id TEXT NOT NULL,
      assignment_applied_version INTEGER NOT NULL CHECK (assignment_applied_version > 0),
      assignment_set_digest TEXT NOT NULL,
      task_binding_version TEXT NOT NULL,
      task_binding_digest TEXT NOT NULL,
      model TEXT NOT NULL,
      model_id TEXT NOT NULL,
      model_level_id TEXT NOT NULL,
      provider_id TEXT NOT NULL,
      provider_route_id TEXT NOT NULL,
      capability_profile_version TEXT NOT NULL,
      request_id_digest TEXT NOT NULL,
      actor_subject_digest TEXT NOT NULL,
      expected_execution_task_id TEXT NOT NULL,
      workflow_run_id TEXT NOT NULL,
      input_digest TEXT NOT NULL,
      execution_task_id TEXT,
      submission_state TEXT NOT NULL CHECK (submission_state IN ('prepared', 'submitted', 'reconcile_required')),
      submission_error_code TEXT,
      submission_reconciled_at TEXT,
      submitted_at TEXT,
      execution_phase TEXT CHECK (execution_phase IS NULL OR execution_phase IN ('pre_effect', 'provider_attempt_started')),
      execution_lease_id TEXT,
      execution_owner_digest TEXT,
      execution_fencing_token INTEGER NOT NULL CHECK (execution_fencing_token >= 0),
      execution_lease_expires_at TEXT,
      task_lease_id TEXT,
      task_owner_digest TEXT,
      task_fencing_token INTEGER CHECK (task_fencing_token IS NULL OR task_fencing_token > 0),
      task_lease_expires_at TEXT,
      claimed_at TEXT,
      provider_attempt_started_at TEXT,
      evidence_state TEXT NOT NULL CHECK (evidence_state IN ('pending', 'committed', 'reconcile_required')),
      evidence_outcome TEXT CHECK (evidence_outcome IS NULL OR evidence_outcome IN ('passed', 'failed', 'canceled')),
      evidence_code TEXT,
      provider_attempts INTEGER CHECK (provider_attempts IS NULL OR provider_attempts IN (0, 1)),
      usage_input_tokens INTEGER CHECK (usage_input_tokens IS NULL OR usage_input_tokens >= 0),
      usage_output_tokens INTEGER CHECK (usage_output_tokens IS NULL OR usage_output_tokens >= 0),
      usage_total_tokens INTEGER CHECK (usage_total_tokens IS NULL OR usage_total_tokens >= 0),
      evidence_digest TEXT,
      evidence_committed_at TEXT,
      evidence_reconciled_at TEXT,
      canonical_task_revision INTEGER CHECK (canonical_task_revision IS NULL OR canonical_task_revision > 0),
      canonical_task_status TEXT CHECK (canonical_task_status IS NULL OR canonical_task_status IN (
        'blocked', 'canceled', 'failed', 'lost', 'rejected', 'timed_out'
      )),
      canonical_terminal_observed_at TEXT,
      prepared_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE (tenant_scope, request_id_digest),
      UNIQUE (tenant_scope, workflow_run_id)
    );
    CREATE UNIQUE INDEX IF NOT EXISTS schedule_provider_dry_runs_active_registration_idx
      ON schedule_provider_dry_runs (tenant_scope, employee_id, schedule_id, registration_version)
      WHERE evidence_state <> 'committed';
    CREATE INDEX IF NOT EXISTS schedule_provider_dry_runs_incomplete_idx
      ON schedule_provider_dry_runs (tenant_scope, evidence_state, prepared_at);
    CREATE UNIQUE INDEX IF NOT EXISTS schedule_provider_dry_runs_attempt_sequence_idx
      ON schedule_provider_dry_runs (tenant_scope, employee_id, schedule_id, attempt_sequence);
  `);
  const columns = new Set(database.prepare("PRAGMA table_info(schedule_provider_dry_runs)").all()
    .map((column) => column.name));
  for (const required of [
    "assignment_set_digest",
    "attempt_sequence",
    "canonical_task_revision",
    "canonical_task_status",
    "canonical_terminal_observed_at",
    "model",
    "provider_attempt_started_at",
    "provider_attempts",
    "task_binding_version",
    "task_lease_expires_at",
    "workflow_run_id",
  ]) {
    if (!columns.has(required)) throw new TypeError("invalid schedule provider dry-run SQLite schema shape");
  }
}

function normalizeDispatch(value) {
  exactObject(value, DISPATCH_FIELDS, "schedule_provider_dry_run_dispatch_invalid");
  if (value.contractVersion !== "schedule-provider-dispatch.v1") {
    throw repositoryError("schedule_provider_dry_run_dispatch_invalid");
  }
  const taskModelBinding = normalizeTaskBinding(value.taskModelBinding);
  const taskId = token(value.taskId, "taskId");
  if (taskModelBinding.taskId !== taskId) throw repositoryError("schedule_provider_dry_run_dispatch_invalid");
  return Object.freeze({
    contractVersion: value.contractVersion,
    tenantScope: token(value.tenantScope, "tenantScope"),
    employeeId: token(value.employeeId, "employeeId"),
    employeeVersion: token(value.employeeVersion, "employeeVersion"),
    scheduleId: token(value.scheduleId, "scheduleId"),
    registrationVersion: positiveInteger(value.registrationVersion, "registrationVersion"),
    scheduleVersion: token(value.scheduleVersion, "scheduleVersion"),
    taskId,
    schedulePolicyDigest: digest(value.schedulePolicyDigest, "schedulePolicyDigest"),
    executionContractDigest: digest(value.executionContractDigest, "executionContractDigest"),
    taskModelBinding,
  });
}

function normalizeTaskBinding(value) {
  exactObject(value, TASK_BINDING_FIELDS, "schedule_provider_dry_run_task_binding_invalid");
  if (value.contractVersion !== "digital-employee-task-model-binding.v1" || value.status !== "applied") {
    throw repositoryError("schedule_provider_dry_run_task_binding_invalid");
  }
  return Object.freeze({
    taskId: token(value.taskId, "taskModelBinding.taskId"),
    assignmentId: token(value.assignmentId, "taskModelBinding.assignmentId"),
    assignmentAppliedVersion: positiveInteger(
      value.assignmentAppliedVersion,
      "taskModelBinding.assignmentAppliedVersion",
    ),
    assignmentSetDigest: digest(value.assignmentSetDigest, "taskModelBinding.assignmentSetDigest"),
    bindingVersion: token(value.bindingVersion, "taskModelBinding.bindingVersion"),
    bindingDigest: digest(value.bindingDigest, "taskModelBinding.bindingDigest"),
    model: token(value.model, "taskModelBinding.model"),
    modelId: token(value.modelId, "taskModelBinding.modelId"),
    modelLevelId: token(value.modelLevelId, "taskModelBinding.modelLevelId"),
    provider: token(value.provider, "taskModelBinding.provider"),
    providerRouteId: token(value.providerRouteId, "taskModelBinding.providerRouteId"),
    requiredCapabilityProfileVersion: token(
      value.requiredCapabilityProfileVersion,
      "taskModelBinding.requiredCapabilityProfileVersion",
    ),
  });
}

function normalizeEvidence(value) {
  exactObject(value, EVIDENCE_FIELDS, "schedule_provider_dry_run_evidence_invalid");
  if (value.contractVersion !== SCHEDULE_PROVIDER_DRY_RUN_EVIDENCE_CONTRACT_VERSION) {
    throw repositoryError("schedule_provider_dry_run_evidence_invalid");
  }
  const outcome = enumValue(value.outcome, EVIDENCE_OUTCOMES, "schedule_provider_dry_run_evidence_invalid");
  const evidenceCode = enumValue(value.evidenceCode, EVIDENCE_CODES, "schedule_provider_dry_run_evidence_invalid");
  const validOutcomeCode = (outcome === "passed" && evidenceCode === "provider_only_passed") ||
    (outcome === "canceled" && evidenceCode === "provider_only_canceled") ||
    (outcome === "failed" && !["provider_only_passed", "provider_only_canceled"].includes(evidenceCode));
  if (!validOutcomeCode) throw repositoryError("schedule_provider_dry_run_evidence_invalid");
  exactObject(value.usage, USAGE_FIELDS, "schedule_provider_dry_run_evidence_invalid");
  exactObject(value.safetyEvidence, SAFETY_EVIDENCE_FIELDS, "schedule_provider_dry_run_evidence_invalid");
  const safetyEvidence = value.safetyEvidence;
  if (safetyEvidence.businessPayloadAttempts !== 0 || safetyEvidence.outputPersisted !== false ||
    safetyEvidence.skillAttempts !== 0 || safetyEvidence.toolAttempts !== 0 ||
    safetyEvidence.writebackAttempts !== 0) {
    throw repositoryError("schedule_provider_dry_run_evidence_invalid");
  }
  const providerAttempts = boundedInteger(value.providerAttempts, 0, 1, "providerAttempts");
  if (outcome === "passed" && providerAttempts !== 1) {
    throw repositoryError("schedule_provider_dry_run_evidence_invalid");
  }
  const inputTokens = boundedInteger(value.usage.inputTokens, 0, Number.MAX_SAFE_INTEGER, "usage.inputTokens");
  const outputTokens = boundedInteger(value.usage.outputTokens, 0, Number.MAX_SAFE_INTEGER, "usage.outputTokens");
  const totalTokens = boundedInteger(value.usage.totalTokens, 0, Number.MAX_SAFE_INTEGER, "usage.totalTokens");
  if (totalTokens !== inputTokens + outputTokens) {
    throw repositoryError("schedule_provider_dry_run_evidence_invalid");
  }
  return deepFreeze({
    contractVersion: value.contractVersion,
    outcome,
    evidenceCode,
    providerAttempts,
    usage: {
      inputTokens,
      outputTokens,
      totalTokens,
    },
    safetyEvidence: {
      businessPayloadAttempts: 0,
      outputPersisted: false,
      skillAttempts: 0,
      toolAttempts: 0,
      writebackAttempts: 0,
    },
  });
}

function requireSamePreparedRequest(row, {
  actorSubjectDigest,
  dispatch,
  expectedExecutionTaskId,
  inputDigest,
  requestIdDigest,
  workflowRunId,
}) {
  const matches = row.request_id_digest === requestIdDigest && row.actor_subject_digest === actorSubjectDigest &&
    row.employee_id === dispatch.employeeId && row.employee_version === dispatch.employeeVersion &&
    row.schedule_id === dispatch.scheduleId && row.registration_version === dispatch.registrationVersion &&
    row.schedule_version === dispatch.scheduleVersion && row.task_id === dispatch.taskId &&
    row.schedule_policy_digest === dispatch.schedulePolicyDigest &&
    row.execution_contract_digest === dispatch.executionContractDigest &&
    row.assignment_id === dispatch.taskModelBinding.assignmentId &&
    row.assignment_applied_version === dispatch.taskModelBinding.assignmentAppliedVersion &&
    row.assignment_set_digest === dispatch.taskModelBinding.assignmentSetDigest &&
    row.task_binding_version === dispatch.taskModelBinding.bindingVersion &&
    row.task_binding_digest === dispatch.taskModelBinding.bindingDigest &&
    row.model === dispatch.taskModelBinding.model && row.model_id === dispatch.taskModelBinding.modelId &&
    row.model_level_id === dispatch.taskModelBinding.modelLevelId &&
    row.provider_id === dispatch.taskModelBinding.provider &&
    row.provider_route_id === dispatch.taskModelBinding.providerRouteId &&
    row.capability_profile_version === dispatch.taskModelBinding.requiredCapabilityProfileVersion &&
    row.expected_execution_task_id === expectedExecutionTaskId && row.workflow_run_id === workflowRunId &&
    row.input_digest === inputDigest;
  if (!matches) throw repositoryError("schedule_provider_dry_run_idempotency_conflict");
}

function rowToDryRun(row) {
  return deepFreeze({
    contractVersion: SCHEDULE_PROVIDER_DRY_RUN_REPOSITORY_CONTRACT_VERSION,
    dryRunId: row.dry_run_id,
    dryRunVersion: row.dry_run_version,
    tenantScope: row.tenant_scope,
    employeeId: row.employee_id,
    employeeVersion: row.employee_version,
    scheduleId: row.schedule_id,
    attemptSequence: row.attempt_sequence,
    registrationVersion: row.registration_version,
    scheduleVersion: row.schedule_version,
    taskId: row.task_id,
    schedulePolicyDigest: row.schedule_policy_digest,
    executionContractDigest: row.execution_contract_digest,
    taskModelBinding: {
      assignmentId: row.assignment_id,
      assignmentAppliedVersion: row.assignment_applied_version,
      assignmentSetDigest: row.assignment_set_digest,
      bindingVersion: row.task_binding_version,
      bindingDigest: row.task_binding_digest,
      model: row.model,
      modelId: row.model_id,
      modelLevelId: row.model_level_id,
      provider: row.provider_id,
      providerRouteId: row.provider_route_id,
      requiredCapabilityProfileVersion: row.capability_profile_version,
    },
    requestIdDigest: row.request_id_digest,
    actorSubjectDigest: row.actor_subject_digest,
    workflowRunId: row.workflow_run_id,
    inputDigest: row.input_digest,
    expectedExecutionTaskId: row.expected_execution_task_id,
    executionTaskId: row.execution_task_id,
    submission: {
      state: enumValue(row.submission_state, SUBMISSION_STATES, "schedule_provider_dry_run_row_invalid"),
      errorCode: row.submission_error_code,
      reconciledAt: row.submission_reconciled_at,
      submittedAt: row.submitted_at,
    },
    execution: {
      phase: row.execution_phase === null
        ? null
        : enumValue(row.execution_phase, EXECUTION_PHASES, "schedule_provider_dry_run_row_invalid"),
      leaseId: row.execution_lease_id,
      ownerDigest: row.execution_owner_digest,
      fencingToken: row.execution_fencing_token,
      leaseExpiresAt: row.execution_lease_expires_at,
      taskLeaseId: row.task_lease_id,
      taskOwnerDigest: row.task_owner_digest,
      taskFencingToken: row.task_fencing_token,
      taskLeaseExpiresAt: row.task_lease_expires_at,
      claimedAt: row.claimed_at,
      providerAttemptStartedAt: row.provider_attempt_started_at,
    },
    evidence: {
      contractVersion: SCHEDULE_PROVIDER_DRY_RUN_EVIDENCE_CONTRACT_VERSION,
      state: enumValue(row.evidence_state, EVIDENCE_STATES, "schedule_provider_dry_run_row_invalid"),
      outcome: row.evidence_outcome,
      evidenceCode: row.evidence_code,
      providerAttempts: row.provider_attempts,
      usage: row.provider_attempts === null ? null : {
        inputTokens: row.usage_input_tokens,
        outputTokens: row.usage_output_tokens,
        totalTokens: row.usage_total_tokens,
      },
      safetyEvidence: row.evidence_state === "committed" ? {
        businessPayloadAttempts: 0,
        outputPersisted: false,
        skillAttempts: 0,
        toolAttempts: 0,
        writebackAttempts: 0,
      } : null,
      evidenceDigest: row.evidence_digest,
      committedAt: row.evidence_committed_at,
      reconciledAt: row.evidence_reconciled_at,
    },
    canonicalTerminal: row.canonical_task_status ? {
      taskRevision: row.canonical_task_revision,
      taskStatus: row.canonical_task_status,
      observedAt: row.canonical_terminal_observed_at,
    } : null,
    preparedAt: row.prepared_at,
    updatedAt: row.updated_at,
  });
}

function normalizeDryRunIdentity({ dryRunId, tenantScope }) {
  return Object.freeze({
    dryRunId: prefixedDigestId(dryRunId, "schedule_provider_dry_run_", "dryRunId"),
    tenantScope: token(tenantScope, "tenantScope"),
  });
}

function normalizeTaskLeaseIdentity({ taskLeaseId, taskOwnerDigest, taskFencingToken }) {
  return Object.freeze({
    taskLeaseId: token(taskLeaseId, "taskLeaseId"),
    taskOwnerDigest: digest(taskOwnerDigest, "taskOwnerDigest"),
    taskFencingToken: positiveInteger(taskFencingToken, "taskFencingToken"),
  });
}

function normalizeClaimTaskLeaseIdentity({ taskLeaseExpiresAt, ...identity }) {
  return Object.freeze({
    ...normalizeTaskLeaseIdentity(identity),
    taskLeaseExpiresAt: canonicalTimestamp(taskLeaseExpiresAt, "taskLeaseExpiresAt"),
  });
}

function normalizeDualLeaseIdentity({
  leaseId,
  executionOwnerDigest,
  executionFencingToken,
  taskLeaseId,
  taskOwnerDigest,
  taskFencingToken,
}) {
  return Object.freeze({
    leaseId: token(leaseId, "leaseId"),
    executionOwnerDigest: digest(executionOwnerDigest, "executionOwnerDigest"),
    executionFencingToken: positiveInteger(executionFencingToken, "executionFencingToken"),
    ...normalizeTaskLeaseIdentity({ taskFencingToken, taskLeaseId, taskOwnerDigest }),
  });
}

function sameDualLease(row, lease) {
  return row.execution_lease_id === lease.leaseId && row.execution_owner_digest === lease.executionOwnerDigest &&
    row.execution_fencing_token === lease.executionFencingToken && row.task_lease_id === lease.taskLeaseId &&
    row.task_owner_digest === lease.taskOwnerDigest && row.task_fencing_token === lease.taskFencingToken;
}

function transaction(database, operation) {
  database.exec("BEGIN IMMEDIATE;");
  try {
    const result = operation();
    database.exec("COMMIT;");
    return result;
  } catch (error) {
    try {
      database.exec("ROLLBACK;");
    } catch {
      // Preserve the original failure.
    }
    throw error;
  }
}

function exactObject(value, allowedFields, code) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw repositoryError(code);
  const keys = Object.keys(value);
  if (keys.length !== allowedFields.size || keys.some((key) => !allowedFields.has(key))) throw repositoryError(code);
  return value;
}

function deterministicId(prefix, value) {
  return `${prefix}_${digestCanonical(value)}`;
}

function digestCanonical(value) {
  return crypto.createHash("sha256").update(JSON.stringify(sortCanonical(value))).digest("hex");
}

function sortCanonical(value) {
  if (Array.isArray(value)) return value.map(sortCanonical);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, sortCanonical(value[key])]));
}

function digest(value, field) {
  const safe = String(value || "").trim().toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(safe)) throw new TypeError(`${field} must be a SHA-256 digest`);
  return safe;
}

function prefixedDigestId(value, prefix, field) {
  const safe = String(value || "").trim();
  if (!new RegExp(`^${prefix}[a-f0-9]{64}$`).test(safe)) throw new TypeError(`${field} is invalid`);
  return safe;
}

function token(value, field) {
  const safe = String(value || "").trim();
  if (!safe || safe.length > 200 || !/^[A-Za-z0-9._:@/-]+$/.test(safe)) throw new TypeError(`${field} is invalid`);
  return safe;
}

function positiveInteger(value, field) {
  return boundedInteger(value, 1, Number.MAX_SAFE_INTEGER, field);
}

function boundedInteger(value, min, max, field) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < min || number > max) throw new TypeError(`${field} is invalid`);
  return number;
}

function canonicalTimestamp(value, field) {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) throw new TypeError(`${field} is invalid`);
  return date.toISOString();
}

function addMilliseconds(timestamp, milliseconds) {
  return new Date(Date.parse(timestamp) + milliseconds).toISOString();
}

function earliestTimestamp(left, right) {
  return left <= right ? left : right;
}

function enumValue(value, allowed, code) {
  if (!allowed.has(value)) throw repositoryError(code);
  return value;
}

function requiredDatabasePath(value) {
  const safe = String(value || "").trim();
  if (!safe) throw new TypeError("schedule provider dry-run repository requires databasePath");
  return safe;
}

function repositoryError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const nested of Object.values(value)) deepFreeze(nested);
  return value;
}

export {
  SCHEDULE_PROVIDER_DRY_RUN_EVIDENCE_CONTRACT_VERSION,
  SCHEDULE_PROVIDER_DRY_RUN_REPOSITORY_CONTRACT_VERSION,
  createSqliteScheduleProviderDryRunRepository,
};
