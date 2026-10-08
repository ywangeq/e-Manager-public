import { createScheduleRunConfigurationStore, SCHEDULE_RUN_CONFIGURATION_TABLE_SQL } from "./schedule-run-configuration.mjs";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { isDeepStrictEqual } from "node:util";
import {
  SCHEDULE_ACTIVATION_SNAPSHOT_CONTRACT_VERSION,
  SCHEDULE_ACTIVATION_SNAPSHOT_CONTRACT_VERSION_V2,
  SCHEDULE_ACTIVATION_SNAPSHOT_CONTRACT_VERSION_V3,
  normalizeScheduleActivationSnapshotV3,
  normalizeRunnableScheduleActivationSnapshot,
  projectRunnableGovernedScheduleFromActivationSnapshot,
  normalizeScheduleActivationSnapshot,
  normalizeScheduleActivationSnapshotV2,
} from "./schedule-activation-snapshot.mjs";
import {
  SCHEDULE_BUSINESS_OWNER_ACCEPTANCE_CONTRACT_VERSION,
  SCHEDULE_BUSINESS_OWNER_ACCEPTANCE_CONTRACT_VERSION_V2,
  normalizeScheduleBusinessOwnerAcceptanceRevision,
  normalizeScheduleBusinessOwnerAcceptanceRevisionV2,
  projectScheduleBusinessOwnerAcceptanceProofV2,
} from "./schedule-business-owner-acceptance.mjs";
import { normalizeScheduleResultProcessingAuthority } from "./schedule-result-processing-contract.mjs";
import { normalizeScheduleTaskExecutionDefinitionV2, normalizeScheduleAgentTaskDefinition } from "./schedule-task-execution-definition.mjs";
import { scheduleTriggerSlotDigest } from "./schedule-trigger-service.mjs";

const SCHEDULE_CONTROL_REPOSITORY_CONTRACT_VERSION = "schedule-control-repository.v1";
const SCHEDULE_RUN_TERMINAL_EVIDENCE_CONTRACT_VERSION = "schedule-run-terminal-evidence.v1";
const SCHEMA_VERSION = 15;
const BUSINESS_OWNER_ACCEPTANCE_SCHEMA_SQL = `
  CREATE TABLE schedule_business_owner_acceptance_heads (
    tenant_scope TEXT NOT NULL,
    employee_id TEXT NOT NULL,
    schedule_id TEXT NOT NULL,
    acceptance_version INTEGER NOT NULL CHECK (acceptance_version > 0),
    revision_digest TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (tenant_scope, employee_id, schedule_id)
  );
  CREATE TABLE schedule_business_owner_acceptance_revisions (
    tenant_scope TEXT NOT NULL,
    employee_id TEXT NOT NULL,
    schedule_id TEXT NOT NULL,
    acceptance_version INTEGER NOT NULL CHECK (acceptance_version > 0),
    revision_digest TEXT NOT NULL,
    previous_revision_digest TEXT,
    decision TEXT NOT NULL CHECK (decision IN ('accepted', 'revoked')),
    candidate_digest TEXT NOT NULL,
    revision_json TEXT NOT NULL,
    decided_at TEXT NOT NULL,
    PRIMARY KEY (tenant_scope, employee_id, schedule_id, acceptance_version),
    UNIQUE (tenant_scope, revision_digest)
  );
  CREATE INDEX schedule_business_owner_acceptance_history_idx
    ON schedule_business_owner_acceptance_revisions (
      tenant_scope, employee_id, schedule_id, acceptance_version DESC
    );
`;
const RUN_RESULT_RECEIPT_SCHEMA_SQL = `
  CREATE TABLE schedule_run_result_receipts (
    tenant_scope TEXT NOT NULL,
    run_id TEXT NOT NULL,
    employee_id TEXT NOT NULL,
    schedule_id TEXT NOT NULL,
    receipt_version INTEGER NOT NULL CHECK (receipt_version = 1),
    result_receipt_digest TEXT NOT NULL,
    base_intent_version INTEGER NOT NULL CHECK (base_intent_version > 0),
    base_execution_version INTEGER NOT NULL CHECK (base_execution_version > 0),
    execution_task_id TEXT NOT NULL,
    activation_snapshot_id TEXT NOT NULL,
    activation_snapshot_digest TEXT NOT NULL,
    lease_id TEXT NOT NULL,
    owner_digest TEXT NOT NULL,
    fencing_token INTEGER NOT NULL CHECK (fencing_token > 0),
    task_lease_id TEXT NOT NULL,
    task_owner_digest TEXT NOT NULL,
    task_fencing_token INTEGER NOT NULL CHECK (task_fencing_token > 0),
    lease_binding_digest TEXT NOT NULL,
    operation_receipt_evidence_digest TEXT NOT NULL,
    receipt_effect_state TEXT NOT NULL CHECK (receipt_effect_state IN ('settled', 'reconcile_required')),
    outcome TEXT NOT NULL CHECK (outcome IN ('parsed_result', 'parse_failed', 'no_result_safe', 'unknown')),
    result_evidence_digest TEXT,
    recorded_at TEXT NOT NULL,
    PRIMARY KEY (tenant_scope, run_id),
    UNIQUE (tenant_scope, execution_task_id),
    UNIQUE (tenant_scope, result_receipt_digest),
    CHECK (
      (outcome = 'parsed_result' AND result_evidence_digest IS NOT NULL)
      OR (outcome = 'parse_failed' AND result_evidence_digest IS NULL)
      OR (outcome = 'no_result_safe' AND receipt_effect_state = 'settled' AND result_evidence_digest IS NULL)
      OR (outcome = 'unknown' AND receipt_effect_state = 'reconcile_required' AND result_evidence_digest IS NULL)
    )
  );
`;
const ACTIVATION_SNAPSHOT_SCHEMA_V12_SQL = `
  CREATE TABLE schedule_activation_snapshots (
    snapshot_id TEXT PRIMARY KEY,
    snapshot_version INTEGER NOT NULL CHECK (snapshot_version > 0),
    snapshot_digest TEXT NOT NULL,
    tenant_scope TEXT NOT NULL,
    employee_id TEXT NOT NULL,
    schedule_id TEXT NOT NULL,
    activation_version INTEGER NOT NULL CHECK (activation_version > 0),
    registration_version INTEGER NOT NULL CHECK (registration_version > 0),
    schedule_version TEXT NOT NULL,
    snapshot_json TEXT NOT NULL,
    created_at TEXT NOT NULL,
    snapshot_contract_version TEXT NOT NULL CHECK (snapshot_contract_version IN (
      'schedule-activation-snapshot.v1', 'schedule-activation-snapshot.v2'
    )),
    acceptance_candidate_digest TEXT,
    acceptance_revision_digest TEXT,
    acceptance_proof_digest TEXT,
    processing_authority_digest TEXT,
    CHECK (
      (snapshot_contract_version = 'schedule-activation-snapshot.v1'
        AND acceptance_candidate_digest IS NULL AND acceptance_revision_digest IS NULL
        AND acceptance_proof_digest IS NULL AND processing_authority_digest IS NULL)
      OR
      (snapshot_contract_version = 'schedule-activation-snapshot.v2'
        AND acceptance_candidate_digest IS NOT NULL AND acceptance_revision_digest IS NOT NULL
        AND acceptance_proof_digest IS NOT NULL AND processing_authority_digest IS NOT NULL)
    ),
    UNIQUE (tenant_scope, employee_id, schedule_id, activation_version)
  );
  CREATE INDEX schedule_activation_snapshots_lookup_idx
    ON schedule_activation_snapshots (tenant_scope, employee_id, schedule_id, activation_version);
`;
// v3 has no legacy business-owner/provider-result processing proof columns.
const ACTIVATION_SNAPSHOT_SCHEMA_V13_SQL = ACTIVATION_SNAPSHOT_SCHEMA_V12_SQL
  .replace("'schedule-activation-snapshot.v1', 'schedule-activation-snapshot.v2'",
    "'schedule-activation-snapshot.v1', 'schedule-activation-snapshot.v2', 'schedule-activation-snapshot.v3'")
  .replace("snapshot_contract_version = 'schedule-activation-snapshot.v1'",
    "snapshot_contract_version IN ('schedule-activation-snapshot.v1', 'schedule-activation-snapshot.v3')");
const ACTIVATION_STATES = new Set(["active", "paused", "registered", "retired"]);
const TERMINAL_TASK_STATUSES = new Set(["blocked", "canceled", "completed", "failed", "lost", "rejected", "timed_out"]);
const OBSERVABLE_TASK_STATUSES = new Set([...TERMINAL_TASK_STATUSES, "queued", "running", "waiting"]);
const INCOMPLETE_INTENT_STATES = new Set(["prepared", "reconcile_required", "submitted"]);
const RUN_EXECUTION_STATES = new Set([
  "active",
  "cancel_requested",
  "reconcile_blocked",
  "released",
  "skipped_admission",
]);
const CANCEL_RECONCILE_STATES = new Set(["pending", "reconcile_required", "settled"]);
const CANCEL_EFFECT_STATES = new Set(["safe_terminal", "reconcile_required"]);
const CANCEL_CANONICAL_TASK_STATUSES = new Set([...OBSERVABLE_TASK_STATUSES, "pre_canceled"]);
const RUN_EXECUTION_PHASES = new Set(["pre_effect", "effect_dispatch_prepared"]);
const RUN_RESULT_RECEIPT_REQUIREMENTS = new Set(["required", "legacy_unknown", "legacy_not_required"]);
const RUN_RECEIPT_EFFECT_STATES = new Set(["settled", "reconcile_required"]);
const RUN_RESULT_OUTCOMES = new Set(["parsed_result", "parse_failed", "no_result_safe", "unknown"]);
const RUN_RESULT_RECEIPT_FIELDS = new Set([
  "activationSnapshotDigest", "activationSnapshotId", "executionTaskId", "expectedExecutionVersion",
  "expectedIntentVersion", "fencingToken", "leaseId", "operationReceiptEvidenceDigest", "outcome",
  "ownerDigest", "receiptEffectState", "recordedAt", "resultEvidenceDigest", "runId", "taskFencingToken",
  "taskLeaseId", "taskOwnerDigest", "tenantScope",
]);
const RUN_RESULT_RECEIPT_ADOPTION_FIELDS = new Set([
  "expectedExecutionVersion", "expectedIntentVersion", "runId", "tenantScope",
]);
const INTERNAL_PROCESSING_OUTCOME_FIELDS = new Set([
  "binding", "contractVersion", "evidenceBoundary", "outcome",
]);
const INTERNAL_PROCESSING_BINDING_FIELDS = new Set([
  "activationSnapshotDigest", "activationSnapshotId", "activationVersion", "alertContractDigest",
  "canonicalTaskId", "contractVersion", "employeeId", "ingestEvidenceDigest", "ingestRef",
  "processingAuthorityDigest", "providerAttemptEvidenceDigest", "resultContractDigest",
  "retentionDefinitionDigest", "runId", "runLeaseBindingDigest", "scheduleId", "scheduledFor",
  "tenantScope", "triggerId",
]);
const INTERNAL_PROCESSING_EVIDENCE_FIELDS = new Set([
  "contractVersion", "processedAt", "processingEvidenceDigest", "resultEvidenceDigest",
  "safeFailureCode", "state",
]);

function createSqliteScheduleControlRepository({
  databasePath,
  now,
  resolveProcessingAuthority,
  resolveTaskExecutionDefinition,
  resolveResultProcessingOutcome,
  resolveAgentActivationAuthority,
  resolveAgentTerminalEvidence,
  runConfigurationEncryption,
  resolveRunConfiguration,
  authorizeManualRun,
} = {}) {
  if (resolveAgentActivationAuthority !== undefined && typeof resolveAgentActivationAuthority !== "function") {
    throw new TypeError("resolveAgentActivationAuthority must be a function");
  }
  if (resolveAgentTerminalEvidence !== undefined && typeof resolveAgentTerminalEvidence !== "function") {
    throw new TypeError("resolveAgentTerminalEvidence must be a function");
  }
  if (resolveRunConfiguration !== undefined && (typeof resolveRunConfiguration !== "function" || !runConfigurationEncryption)) {
    throw new TypeError("run configuration resolver requires encryption authority");
  }
  const safeDatabasePath = requiredDatabasePath(databasePath);
  if (now !== undefined && typeof now !== "function") throw new TypeError("now must be a function");
  if (resolveProcessingAuthority !== undefined && typeof resolveProcessingAuthority !== "function") {
    throw new TypeError("resolveProcessingAuthority must be a function");
  }
  if (resolveTaskExecutionDefinition !== undefined && typeof resolveTaskExecutionDefinition !== "function") {
    throw new TypeError("resolveTaskExecutionDefinition must be a function");
  }
  if (resolveResultProcessingOutcome !== undefined && typeof resolveResultProcessingOutcome !== "function") {
    throw new TypeError("resolveResultProcessingOutcome must be a function");
  }
  if (safeDatabasePath !== ":memory:") fs.mkdirSync(path.dirname(safeDatabasePath), { recursive: true });
  const database = new DatabaseSync(safeDatabasePath);
  let runConfigurations;
  try {
    runConfigurations = runConfigurationEncryption
      ? createScheduleRunConfigurationStore({ ...runConfigurationEncryption, database }) : null;
    initializeDatabase(database);
  } catch (error) {
    database.close();
    throw error;
  }

  function getRunConfiguration({ tenantScope, runId } = {}) {
    const intent = getIntent(runId, { tenantScope });
    if (!intent) return null;
    if (!runConfigurations) {
      const exists = database.prepare("SELECT 1 FROM schedule_run_configurations WHERE tenant_scope=? AND run_id=?").get(tenantScope, runId);
      if (exists) throw controlError("schedule_run_configuration_key_unavailable");
      return null;
    }
    return runConfigurations.read(intent);
  }

  // Internal ingress: the composition supplies RBAC and a principal-scoped request
  // digest. The server clock, not the caller, defines the first accepted date.
  function prepareManualIntent({ tenantScope, employeeId, scheduleId, expectedControlVersion, requestDigest, actor } = {}) {
    const identity = normalizeIdentity({ tenantScope, employeeId, scheduleId });
    const manualRequestDigest = digest(requestDigest, "requestDigest");
    const expected = positiveInteger(expectedControlVersion, "expectedControlVersion");
    if (typeof authorizeManualRun !== "function" || typeof now !== "function") throw controlError("schedule_manual_authority_unavailable");
    return transaction(database, () => {
      const allowed = authorizeManualRun({ ...identity, actor, requestDigest: manualRequestDigest });
      if (allowed !== true) throw controlError("schedule_manual_forbidden");
      const control = requireControl(identity);
      if (!["active", "paused"].includes(control.activation_state) || control.emergency_stop_active) throw controlError("schedule_manual_control_blocked");
      const snapshot = requireActiveSnapshotRow(control).snapshot;
      if (snapshot.contractVersion !== SCHEDULE_ACTIVATION_SNAPSHOT_CONTRACT_VERSION_V3) throw controlError("schedule_manual_agent_required");
      const existing = database.prepare("SELECT * FROM schedule_run_intents WHERE tenant_scope=? AND employee_id=? AND schedule_id=? AND manual_request_digest=?")
        .get(identity.tenantScope, identity.employeeId, identity.scheduleId, manualRequestDigest);
      if (existing) {
        if (existing.activation_snapshot_digest !== control.activation_snapshot_digest || existing.schedule_version !== control.schedule_version) throw controlError("schedule_manual_idempotency_conflict");
        return rowToIntent(existing);
      }
      if (control.control_version !== expected) throw controlError("schedule_control_version_conflict");
      const acceptedAt = canonicalTimestamp(now(), "now");
      return prepareIntentInTransaction({ control, identity, scheduledFor: acceptedAt, scannerFencingToken: null, manualRequestDigest, now: acceptedAt });
    });
  }

  function initializeRegisteredControl({
    tenantScope,
    employeeId,
    scheduleId,
    expectedControlVersion = 0,
    registrationVersion,
    scheduleVersion,
    schedulePolicyDigest,
    executionContractDigest,
    maxConcurrentRuns,
    overlapWindowMinutes,
    initializedAt,
  } = {}) {
    const identity = normalizeIdentity({ tenantScope, employeeId, scheduleId });
    const expected = nonNegativeInteger(expectedControlVersion, "expectedControlVersion");
    const binding = normalizeControlBinding({
      executionContractDigest,
      maxConcurrentRuns,
      overlapWindowMinutes,
      registrationVersion,
      schedulePolicyDigest,
      scheduleVersion,
    });
    const now = canonicalTimestamp(initializedAt, "initializedAt");
    return transaction(database, () => {
      const current = readControlRow(identity);
      if (current) {
        if (current.control_version !== expected) throw controlError("schedule_control_version_conflict");
        if (controlBindingMatches(current, binding)) return rowToControl(current);
        if (current.emergency_stop_active) throw controlError("schedule_control_emergency_stop_active");
        if (current.activation_state !== "registered" && current.activation_state !== "paused") {
          throw controlError("schedule_control_registration_transition_invalid");
        }
        requireNoPendingScheduleLedger(identity, "schedule_control_registration_reconcile_pending");
        database.prepare(`
          UPDATE schedule_controls
          SET control_version = control_version + 1,
              activation_state = 'registered',
              registration_version = ?, schedule_version = ?,
              schedule_policy_digest = ?, execution_contract_digest = ?,
              max_concurrent_runs = ?, overlap_window_minutes = ?,
              activation_snapshot_id = NULL, activation_snapshot_digest = NULL,
              activated_at = NULL, cursor_after = NULL,
              scanner_fencing_token = scanner_fencing_token + 1,
              scanner_lease_id = NULL, scanner_owner_digest = NULL, scanner_lease_expires_at = NULL,
              next_scan_at = NULL, updated_at = ?
          WHERE tenant_scope = ? AND employee_id = ? AND schedule_id = ? AND control_version = ?
        `).run(
          binding.registrationVersion,
          binding.scheduleVersion,
          binding.schedulePolicyDigest,
          binding.executionContractDigest,
          binding.maxConcurrentRuns,
          binding.overlapWindowMinutes,
          now,
          identity.tenantScope,
          identity.employeeId,
          identity.scheduleId,
          expected,
        );
        return rowToControl(readControlRow(identity));
      }
      if (expected !== 0) throw controlError("schedule_control_version_conflict");
      database.prepare(`
        INSERT INTO schedule_controls (
          tenant_scope, employee_id, schedule_id,
          control_version, activation_version, activation_state,
          registration_version, schedule_version, schedule_policy_digest, execution_contract_digest,
          max_concurrent_runs, overlap_window_minutes,
          activated_at, cursor_after, next_scan_at,
          emergency_stop_active, emergency_stop_version,
          scanner_fencing_token, created_at, updated_at
        ) VALUES (?, ?, ?, 1, 0, 'registered', ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, 0, 0, 0, ?, ?)
      `).run(
        identity.tenantScope,
        identity.employeeId,
        identity.scheduleId,
        binding.registrationVersion,
        binding.scheduleVersion,
        binding.schedulePolicyDigest,
        binding.executionContractDigest,
        binding.maxConcurrentRuns,
        binding.overlapWindowMinutes,
        now,
        now,
      );
      return rowToControl(readControlRow(identity));
    });
  }

  function activate({
    activationSnapshot,
    expectedControlVersion,
  } = {}) {
    const snapshot = normalizeRunnableScheduleActivationSnapshot(activationSnapshot);
    const identity = normalizeIdentity(snapshot);
    const expected = positiveInteger(expectedControlVersion, "expectedControlVersion");
    const binding = normalizeControlBinding({
      executionContractDigest: snapshot.executionContractDigest,
      maxConcurrentRuns: snapshot.maxConcurrentRuns,
      overlapWindowMinutes: snapshot.overlapWindowMinutes,
      registrationVersion: snapshot.registrationVersion,
      schedulePolicyDigest: snapshot.schedulePolicyDigest,
      scheduleVersion: snapshot.scheduleVersion,
    });
    return transaction(database, () => {
      if (typeof now !== "function" ||
        (snapshot.contractVersion === SCHEDULE_ACTIVATION_SNAPSHOT_CONTRACT_VERSION_V3
          ? typeof resolveAgentActivationAuthority !== "function" : typeof resolveProcessingAuthority !== "function") ||
        typeof resolveTaskExecutionDefinition !== "function") {
        throw controlError("schedule_control_activation_authority_unavailable");
      }
      const activationTime = canonicalTimestamp(now(), "now");
      if (snapshot.createdAt > activationTime) {
        throw controlError("schedule_control_activation_snapshot_from_future");
      }
      const current = readControlRow(identity);
      if (!current) throw controlError("schedule_control_activation_registration_required");
      if (current.control_version !== expected) throw controlError("schedule_control_version_conflict");
      if (current.activation_state === "retired") throw controlError("schedule_control_retired");
      if (current.activation_state !== "registered" && current.activation_state !== "paused") {
        throw controlError("schedule_control_activation_transition_invalid");
      }
      if (current.emergency_stop_active) throw controlError("schedule_control_emergency_stop_active");
      const nextActivationVersion = current.activation_version + 1;
      if (snapshot.activationVersion !== nextActivationVersion || snapshot.snapshotVersion !== nextActivationVersion) {
        throw controlError("schedule_control_activation_snapshot_version_conflict");
      }
      try {
        requireSameControlBinding(current, binding);
      } catch {
        throw controlError("schedule_control_activation_snapshot_registration_stale");
      }
      requireNoPendingScheduleLedger(identity, "schedule_control_activation_reconcile_pending");
      requireCurrentActivationGovernance(snapshot, activationTime, true);
      const storedSnapshot = saveActivationSnapshotInTransaction(snapshot);
      database.prepare(`
          UPDATE schedule_controls
          SET control_version = control_version + 1,
              activation_version = activation_version + 1,
              activation_state = 'active',
              activation_snapshot_id = ?, activation_snapshot_digest = ?,
              registration_version = ?, schedule_version = ?,
              schedule_policy_digest = ?, execution_contract_digest = ?,
              max_concurrent_runs = ?, overlap_window_minutes = ?,
              activated_at = ?, cursor_after = ?,
              scanner_fencing_token = scanner_fencing_token + 1,
              scanner_lease_id = NULL, scanner_owner_digest = NULL, scanner_lease_expires_at = NULL,
              next_scan_at = NULL,
              updated_at = ?
          WHERE tenant_scope = ? AND employee_id = ? AND schedule_id = ? AND control_version = ?
      `).run(
          storedSnapshot.snapshotId,
          snapshot.snapshotDigest,
          binding.registrationVersion,
          binding.scheduleVersion,
          binding.schedulePolicyDigest,
          binding.executionContractDigest,
          binding.maxConcurrentRuns,
          binding.overlapWindowMinutes,
          activationTime,
          activationTime,
          activationTime,
          identity.tenantScope,
          identity.employeeId,
          identity.scheduleId,
          expected,
      );
      return rowToControl(readControlRow(identity));
    });
  }

  function pause({ tenantScope, employeeId, scheduleId, expectedControlVersion, pausedAt } = {}) {
    return transitionActivation({
      tenantScope,
      employeeId,
      scheduleId,
      expectedControlVersion,
      state: "paused",
      timestamp: pausedAt,
    });
  }

  function retire({ tenantScope, employeeId, scheduleId, expectedControlVersion, retiredAt } = {}) {
    return transitionActivation({
      tenantScope,
      employeeId,
      scheduleId,
      expectedControlVersion,
      state: "retired",
      timestamp: retiredAt,
    });
  }

  function transitionActivation({ tenantScope, employeeId, scheduleId, expectedControlVersion, state, timestamp }) {
    const identity = normalizeIdentity({ tenantScope, employeeId, scheduleId });
    const expected = positiveInteger(expectedControlVersion, "expectedControlVersion");
    const safeState = enumValue(state, ACTIVATION_STATES, "schedule_control_activation_state_invalid");
    const now = canonicalTimestamp(timestamp, `${safeState}At`);
    return transaction(database, () => {
      const current = requireControl(identity);
      if (current.control_version !== expected) throw controlError("schedule_control_version_conflict");
      if (current.emergency_stop_active) throw controlError("schedule_control_emergency_stop_active");
      if (current.activation_state === "retired") throw controlError("schedule_control_retired");
      if (safeState === "paused" && current.activation_state !== "active") {
        throw controlError("schedule_control_activation_transition_invalid");
      }
      const retainActivation = safeState === "paused" && getActivationSnapshot(current.activation_snapshot_id, { tenantScope: identity.tenantScope })?.contractVersion === SCHEDULE_ACTIVATION_SNAPSHOT_CONTRACT_VERSION_V3;
      database.prepare(`
        UPDATE schedule_controls
        SET control_version = control_version + 1,
            activation_version = activation_version + ?,
            activation_state = ?,
            scanner_fencing_token = scanner_fencing_token + 1,
            scanner_lease_id = NULL, scanner_owner_digest = NULL, scanner_lease_expires_at = NULL,
            updated_at = ?
        WHERE tenant_scope = ? AND employee_id = ? AND schedule_id = ? AND control_version = ?
      `).run(retainActivation ? 0 : 1, safeState, now, identity.tenantScope, identity.employeeId, identity.scheduleId, expected);
      return rowToControl(readControlRow(identity));
    });
  }

  function emergencyStop({
    tenantScope,
    employeeId,
    scheduleId,
    expectedControlVersion,
    reasonCode,
    safeReason,
    actor,
    stoppedAt,
  } = {}) {
    const identity = normalizeIdentity({ tenantScope, employeeId, scheduleId });
    const expected = positiveInteger(expectedControlVersion, "expectedControlVersion");
    const safeReasonCode = token(reasonCode, "reasonCode", 120);
    const audit = normalizeControlAudit({ actor, safeReason });
    const now = canonicalTimestamp(stoppedAt, "stoppedAt");
    return transaction(database, () => {
      const current = requireControl(identity);
      if (current.control_version !== expected) throw controlError("schedule_control_version_conflict");
      if (current.activation_state !== "registered" && current.activation_state !== "active" &&
        current.activation_state !== "paused") {
        throw controlError("schedule_control_emergency_stop_transition_invalid");
      }
      if (current.emergency_stop_active) {
        return Object.freeze({
          control: rowToControl(current),
          cancelOutbox: listCancelOutbox({
            ...identity,
            emergencyStopVersion: current.emergency_stop_version,
          }),
        });
      }
      const stopGeneration = current.emergency_stop_version + 1;
      database.prepare(`
        UPDATE schedule_controls
        SET control_version = control_version + 1,
            activation_version = CASE WHEN activation_state = 'active' THEN activation_version + 1 ELSE activation_version END,
            activation_state = CASE WHEN activation_state = 'active' THEN 'paused' ELSE activation_state END,
            emergency_stop_active = 1,
            emergency_stop_version = emergency_stop_version + 1,
            emergency_stop_reason_code = ?, emergency_stopped_at = ?,
            scanner_fencing_token = scanner_fencing_token + 1,
            scanner_lease_id = NULL, scanner_owner_digest = NULL, scanner_lease_expires_at = NULL,
            next_scan_at = NULL,
            updated_at = ?
        WHERE tenant_scope = ? AND employee_id = ? AND schedule_id = ? AND control_version = ?
      `).run(safeReasonCode, now, now, identity.tenantScope, identity.employeeId, identity.scheduleId, expected);

      insertControlEvent({
        ...audit,
        controlVersion: expected + 1,
        eventAt: now,
        eventType: "emergency_stop_engaged",
        identity,
        reasonCode: safeReasonCode,
      });

      database.prepare(`
        UPDATE schedule_run_executions
        SET execution_version = execution_version + 1,
            execution_state = 'cancel_requested',
            fencing_token = fencing_token + 1,
            lease_id = NULL, owner_digest = NULL, lease_expires_at = NULL,
            last_error_code = 'schedule_emergency_stop', updated_at = ?
        WHERE tenant_scope = ? AND employee_id = ? AND schedule_id = ?
          AND execution_state = 'active'
      `).run(now, identity.tenantScope, identity.employeeId, identity.scheduleId);

      const pending = database.prepare(`
        SELECT * FROM schedule_run_intents
        WHERE tenant_scope = ? AND employee_id = ? AND schedule_id = ?
          AND intent_state IN ('prepared', 'reconcile_required', 'submitted', 'cancel_requested')
        ORDER BY scheduled_for ASC, run_id ASC
      `).all(identity.tenantScope, identity.employeeId, identity.scheduleId);
      for (const intent of pending) {
        const targetTaskId = intent.execution_task_id || intent.expected_execution_task_id;
        const nextState = intent.execution_task_id ? "cancel_requested" : "skipped_emergency_stop";
        database.prepare(`
          UPDATE schedule_run_intents
          SET intent_version = intent_version + 1, intent_state = ?,
              last_error_code = 'schedule_emergency_stop', reconciled_at = ?, updated_at = ?
          WHERE run_id = ?
        `).run(nextState, now, now, intent.run_id);
        insertCancelOutbox({
          activationVersion: intent.activation_version,
          emergencyStopVersion: stopGeneration,
          expectedTriggerId: intent.expected_trigger_id,
          identity,
          reasonCode: safeReasonCode,
          runId: intent.run_id,
          taskId: targetTaskId,
          now,
        });
      }
      return Object.freeze({
        control: rowToControl(readControlRow(identity)),
        cancelOutbox: listCancelOutbox({ ...identity, emergencyStopVersion: stopGeneration }),
      });
    });
  }

  function clearEmergencyStop({
    tenantScope,
    employeeId,
    scheduleId,
    expectedControlVersion,
    reasonCode,
    safeReason,
    actor,
    clearedAt,
  } = {}) {
    const identity = normalizeIdentity({ tenantScope, employeeId, scheduleId });
    const expected = positiveInteger(expectedControlVersion, "expectedControlVersion");
    const safeReasonCode = token(reasonCode, "reasonCode", 120);
    const audit = normalizeControlAudit({ actor, safeReason });
    const now = canonicalTimestamp(clearedAt, "clearedAt");
    return transaction(database, () => {
      const current = requireControl(identity);
      if (current.control_version !== expected) throw controlError("schedule_control_version_conflict");
      if (current.activation_state !== "registered" && current.activation_state !== "paused") {
        throw controlError("schedule_control_emergency_stop_transition_invalid");
      }
      requireNoPendingScheduleLedger(identity, "schedule_control_cancellation_reconcile_pending");
      if (!current.emergency_stop_active) return rowToControl(current);
      database.prepare(`
        UPDATE schedule_controls
        SET control_version = control_version + 1,
            emergency_stop_active = 0,
            emergency_stop_version = emergency_stop_version + 1,
            emergency_stop_reason_code = NULL, emergency_stopped_at = NULL,
            scanner_fencing_token = scanner_fencing_token + 1,
            scanner_lease_id = NULL, scanner_owner_digest = NULL, scanner_lease_expires_at = NULL,
            next_scan_at = NULL,
            updated_at = ?
        WHERE tenant_scope = ? AND employee_id = ? AND schedule_id = ? AND control_version = ?
      `).run(now, identity.tenantScope, identity.employeeId, identity.scheduleId, expected);
      insertControlEvent({
        ...audit,
        controlVersion: expected + 1,
        eventAt: now,
        eventType: "emergency_stop_cleared",
        identity,
        reasonCode: safeReasonCode,
      });
      return rowToControl(readControlRow(identity));
    });
  }

  function claimScannerLease({ tenantScope, employeeId, scheduleId, ownerDigest, leaseDurationMs = 30_000, now = new Date() } = {}) {
    const identity = normalizeIdentity({ tenantScope, employeeId, scheduleId });
    const safeOwnerDigest = digest(ownerDigest, "ownerDigest");
    const safeNow = canonicalTimestamp(now, "now");
    const duration = boundedInteger(leaseDurationMs, 1, 86_400_000, "leaseDurationMs");
    const expiresAt = new Date(Date.parse(safeNow) + duration).toISOString();
    return transaction(database, () => {
      const current = requireControl(identity);
      if (current.activation_state !== "active" || current.emergency_stop_active) return null;
      requireActiveSnapshotRow(current);
      if (current.scanner_lease_expires_at && current.scanner_lease_expires_at > safeNow) return null;
      const leaseId = `schedule-scan-lease-${crypto.randomUUID()}`;
      database.prepare(`
        UPDATE schedule_controls
        SET scanner_fencing_token = scanner_fencing_token + 1,
            scanner_lease_id = ?, scanner_owner_digest = ?, scanner_lease_expires_at = ?, updated_at = ?
        WHERE tenant_scope = ? AND employee_id = ? AND schedule_id = ?
          AND activation_state = 'active' AND emergency_stop_active = 0
          AND activation_snapshot_id IS NOT NULL AND activation_snapshot_digest IS NOT NULL
          AND (scanner_lease_expires_at IS NULL OR scanner_lease_expires_at <= ?)
      `).run(
        leaseId,
        safeOwnerDigest,
        expiresAt,
        safeNow,
        identity.tenantScope,
        identity.employeeId,
        identity.scheduleId,
        safeNow,
      );
      const claimed = readControlRow(identity);
      if (claimed.scanner_lease_id !== leaseId) return null;
      return rowToScannerLease(claimed);
    });
  }

  function renewScannerLease({ tenantScope, employeeId, scheduleId, leaseId, ownerDigest, fencingToken, leaseDurationMs = 30_000, now = new Date() } = {}) {
    const identity = normalizeIdentity({ tenantScope, employeeId, scheduleId });
    const lease = normalizeLeaseIdentity({ leaseId, ownerDigest, fencingToken });
    const safeNow = canonicalTimestamp(now, "now");
    const duration = boundedInteger(leaseDurationMs, 1, 86_400_000, "leaseDurationMs");
    const expiresAt = new Date(Date.parse(safeNow) + duration).toISOString();
    const result = database.prepare(`
      UPDATE schedule_controls
      SET scanner_lease_expires_at = ?, updated_at = ?
      WHERE tenant_scope = ? AND employee_id = ? AND schedule_id = ?
        AND activation_state = 'active' AND emergency_stop_active = 0
        AND activation_snapshot_id IS NOT NULL AND activation_snapshot_digest IS NOT NULL
        AND scanner_lease_id = ? AND scanner_owner_digest = ? AND scanner_fencing_token = ?
        AND scanner_lease_expires_at > ?
    `).run(
      expiresAt,
      safeNow,
      identity.tenantScope,
      identity.employeeId,
      identity.scheduleId,
      lease.leaseId,
      lease.ownerDigest,
      lease.fencingToken,
      safeNow,
    );
    return result.changes === 1 ? rowToScannerLease(readControlRow(identity)) : null;
  }

  function releaseScannerLease({ tenantScope, employeeId, scheduleId, leaseId, ownerDigest, fencingToken, releasedAt } = {}) {
    const identity = normalizeIdentity({ tenantScope, employeeId, scheduleId });
    const lease = normalizeLeaseIdentity({ leaseId, ownerDigest, fencingToken });
    const now = canonicalTimestamp(releasedAt, "releasedAt");
    const result = database.prepare(`
      UPDATE schedule_controls
      SET scanner_lease_id = NULL, scanner_owner_digest = NULL, scanner_lease_expires_at = NULL, updated_at = ?
      WHERE tenant_scope = ? AND employee_id = ? AND schedule_id = ?
        AND scanner_lease_id = ? AND scanner_owner_digest = ? AND scanner_fencing_token = ?
    `).run(
      now,
      identity.tenantScope,
      identity.employeeId,
      identity.scheduleId,
      lease.leaseId,
      lease.ownerDigest,
      lease.fencingToken,
    );
    return result.changes === 1;
  }

  function commitCursorAndPrepareIntent({
    tenantScope,
    employeeId,
    scheduleId,
    leaseId,
    ownerDigest,
    fencingToken,
    expectedCursorAfter,
    throughInclusive,
    scheduledFor = null,
    committedAt,
  } = {}) {
    const identity = normalizeIdentity({ tenantScope, employeeId, scheduleId });
    const lease = normalizeLeaseIdentity({ leaseId, ownerDigest, fencingToken });
    const expectedCursor = canonicalTimestamp(expectedCursorAfter, "expectedCursorAfter");
    const through = canonicalTimestamp(throughInclusive, "throughInclusive");
    const now = canonicalTimestamp(committedAt, "committedAt");
    if (through < expectedCursor) throw controlError("schedule_control_cursor_not_monotonic");
    if (through > now) throw controlError("schedule_control_cursor_in_future");
    const slot = scheduledFor === null ? null : canonicalTimestamp(scheduledFor, "scheduledFor");
    if (slot && (slot <= expectedCursor || slot > through)) throw controlError("schedule_control_slot_outside_cursor_window");
    return transaction(database, () => {
      const current = requireControl(identity);
      requireCurrentScannerLease(current, lease, now);
      requireActiveSnapshotRow(current);
      if (current.cursor_after !== expectedCursor) throw controlError("schedule_control_cursor_conflict");
      let intent = null;
      if (slot) {
        intent = prepareIntentInTransaction({
          control: current,
          identity,
          scheduledFor: slot,
          scannerFencingToken: lease.fencingToken,
          now,
        });
      }
      const updated = database.prepare(`
        UPDATE schedule_controls
        SET cursor_after = ?, updated_at = ?
        WHERE tenant_scope = ? AND employee_id = ? AND schedule_id = ?
          AND cursor_after = ?
          AND activation_state = 'active' AND emergency_stop_active = 0
          AND scanner_lease_id = ? AND scanner_owner_digest = ? AND scanner_fencing_token = ?
          AND scanner_lease_expires_at > ?
      `).run(
        through,
        now,
        identity.tenantScope,
        identity.employeeId,
        identity.scheduleId,
        expectedCursor,
        lease.leaseId,
        lease.ownerDigest,
        lease.fencingToken,
        now,
      );
      if (updated.changes !== 1) throw controlError("schedule_control_scanner_fenced");
      return Object.freeze({ control: rowToControl(readControlRow(identity)), intent });
    });
  }

  function markSubmitted({ tenantScope, runId, expectedIntentVersion, executionTaskId, submittedAt } = {}) {
    const safeTenant = token(tenantScope, "tenantScope");
    const safeRunId = token(runId, "runId");
    const expected = positiveInteger(expectedIntentVersion, "expectedIntentVersion");
    const taskId = token(executionTaskId, "executionTaskId");
    const now = canonicalTimestamp(submittedAt, "submittedAt");
    return transaction(database, () => {
      const current = requireIntent(safeRunId, safeTenant);
      if (current.intent_version !== expected) throw controlError("schedule_control_intent_version_conflict");
      requireCurrentIntentDispatchGovernance(current);
      if (current.expected_execution_task_id !== taskId) throw controlError("schedule_control_execution_task_binding_mismatch");
      if (!["prepared", "reconcile_required"].includes(current.intent_state)) {
        throw controlError("schedule_control_intent_transition_invalid");
      }
      database.prepare(`
        UPDATE schedule_run_intents
        SET intent_version = intent_version + 1, intent_state = 'submitted',
            execution_task_id = ?, submitted_at = COALESCE(submitted_at, ?),
            last_error_code = NULL, updated_at = ?
        WHERE run_id = ? AND tenant_scope = ? AND intent_version = ?
      `).run(taskId, now, now, safeRunId, safeTenant, expected);
      return rowToIntent(requireIntent(safeRunId, safeTenant));
    });
  }

  function revalidateSubmittedIntent({ tenantScope, runId, expectedIntentVersion, executionTaskId } = {}) {
    const safeTenant = token(tenantScope, "tenantScope");
    const safeRunId = token(runId, "runId");
    const expected = positiveInteger(expectedIntentVersion, "expectedIntentVersion");
    const taskId = token(executionTaskId, "executionTaskId");
    return transaction(database, () => {
      const current = requireIntent(safeRunId, safeTenant);
      if (current.intent_version !== expected) throw controlError("schedule_control_intent_version_conflict");
      if (current.intent_state !== "submitted") throw controlError("schedule_control_intent_transition_invalid");
      if (current.expected_execution_task_id !== taskId || current.execution_task_id !== taskId) {
        throw controlError("schedule_control_execution_task_binding_mismatch");
      }
      requireCurrentIntentDispatchGovernance(current);
      return rowToIntent(current);
    });
  }

  function markReconcileRequired({ tenantScope, runId, expectedIntentVersion, errorCode, reconciledAt } = {}) {
    const safeTenant = token(tenantScope, "tenantScope");
    const safeRunId = token(runId, "runId");
    const expected = positiveInteger(expectedIntentVersion, "expectedIntentVersion");
    const safeError = token(errorCode, "errorCode", 120);
    const now = canonicalTimestamp(reconciledAt, "reconciledAt");
    const current = requireIntent(safeRunId, safeTenant);
    if (current.intent_version !== expected) throw controlError("schedule_control_intent_version_conflict");
    if (!INCOMPLETE_INTENT_STATES.has(current.intent_state)) throw controlError("schedule_control_intent_transition_invalid");
    const result = database.prepare(`
      UPDATE schedule_run_intents
      SET intent_version = intent_version + 1, intent_state = 'reconcile_required',
          last_error_code = ?, reconciled_at = ?, updated_at = ?
      WHERE run_id = ? AND tenant_scope = ? AND intent_version = ?
    `).run(safeError, now, now, safeRunId, safeTenant, expected);
    if (result.changes !== 1) throw controlError("schedule_control_intent_version_conflict");
    return rowToIntent(requireIntent(safeRunId, safeTenant));
  }

  function observeExecutionTask({ tenantScope, runId, expectedIntentVersion, taskStatus, observedAt } = {}) {
    const safeTenant = token(tenantScope, "tenantScope");
    const safeRunId = token(runId, "runId");
    const expected = positiveInteger(expectedIntentVersion, "expectedIntentVersion");
    const status = enumValue(taskStatus, OBSERVABLE_TASK_STATUSES, "schedule_control_task_status_invalid");
    const now = canonicalTimestamp(observedAt, "observedAt");
    return transaction(database, () => {
      const current = requireIntent(safeRunId, safeTenant);
      if (current.intent_version !== expected) throw controlError("schedule_control_intent_version_conflict");
      if (!current.execution_task_id) throw controlError("schedule_control_execution_task_not_bound");
      const intentState = TERMINAL_TASK_STATUSES.has(status)
        ? "terminal_observed"
        : current.intent_state === "cancel_requested" ? "cancel_requested" : "submitted";
      const terminalAt = TERMINAL_TASK_STATUSES.has(status) ? now : null;
      const result = database.prepare(`
        UPDATE schedule_run_intents
        SET intent_version = intent_version + 1, intent_state = ?, observed_task_status = ?,
            reconciled_at = ?, terminal_at = ?, updated_at = ?
        WHERE run_id = ? AND tenant_scope = ? AND intent_version = ?
      `).run(intentState, status, now, terminalAt, now, safeRunId, safeTenant, expected);
      if (result.changes !== 1) throw controlError("schedule_control_intent_version_conflict");
      if (TERMINAL_TASK_STATUSES.has(status)) {
        database.prepare(`
          UPDATE schedule_run_executions
          SET execution_version = execution_version + 1,
              execution_state = CASE
                WHEN execution_state = 'reconcile_blocked' THEN execution_state
                WHEN execution_phase = 'effect_dispatch_prepared' THEN 'reconcile_blocked'
                ELSE 'released'
              END,
              observed_task_status = ?,
              last_error_code = CASE
                WHEN execution_phase = 'effect_dispatch_prepared' THEN 'schedule_run_effect_evidence_required'
                ELSE last_error_code
              END,
              lease_id = CASE WHEN execution_state = 'reconcile_blocked' THEN lease_id ELSE NULL END,
              owner_digest = CASE WHEN execution_state = 'reconcile_blocked' THEN owner_digest ELSE NULL END,
              lease_expires_at = CASE WHEN execution_state = 'reconcile_blocked' THEN lease_expires_at ELSE NULL END,
              reconcile_blocked_at = CASE
                WHEN execution_phase = 'effect_dispatch_prepared' THEN ?
                ELSE reconcile_blocked_at
              END,
              released_at = CASE
                WHEN execution_state = 'reconcile_blocked' OR execution_phase = 'effect_dispatch_prepared' THEN released_at
                ELSE ?
              END,
              updated_at = ?
          WHERE run_id = ? AND tenant_scope = ?
            AND execution_state IN ('active', 'cancel_requested', 'reconcile_blocked')
        `).run(status, now, now, now, safeRunId, safeTenant);
      }
      return rowToIntent(requireIntent(safeRunId, safeTenant));
    });
  }

  function claimRunExecution({
    tenantScope,
    employeeId,
    scheduleId,
    runId,
    executionTaskId,
    expectedIntentVersion,
    activationVersion,
    taskLeaseId,
    taskOwnerDigest,
    taskFencingToken,
    taskLeaseExpiresAt,
    runOwnerDigest,
    leaseDurationMs = 30_000,
    now = new Date(),
  } = {}) {
    const identity = normalizeIdentity({ tenantScope, employeeId, scheduleId });
    const safeRunId = token(runId, "runId");
    const taskId = token(executionTaskId, "executionTaskId");
    const expectedVersion = positiveInteger(expectedIntentVersion, "expectedIntentVersion");
    const expectedActivation = positiveInteger(activationVersion, "activationVersion");
    const safeTaskLeaseId = token(taskLeaseId, "taskLeaseId");
    const safeTaskOwnerDigest = digest(taskOwnerDigest, "taskOwnerDigest");
    const safeTaskFencingToken = positiveInteger(taskFencingToken, "taskFencingToken");
    const safeRunOwnerDigest = digest(runOwnerDigest, "runOwnerDigest");
    const safeNow = canonicalTimestamp(now, "now");
    const safeTaskLeaseExpiresAt = liveTaskLeaseExpiry(taskLeaseExpiresAt, safeNow);
    const duration = boundedInteger(leaseDurationMs, 1, 86_400_000, "leaseDurationMs");
    const leaseExpiresAt = cappedLeaseExpiry(safeNow, duration, safeTaskLeaseExpiresAt);
    return transaction(database, () => {
      const control = requireControl(identity);
      const intent = requireIntent(safeRunId, identity.tenantScope);
      requireRunExecutionClaim({
        activationVersion: expectedActivation,
        control,
        executionTaskId: taskId,
        expectedIntentVersion: expectedVersion,
        identity,
        intent,
      });
      const existing = readRunExecution(safeRunId, identity.tenantScope);
      if (existing) {
        requireSameRunExecution(existing, {
          activationVersion: expectedActivation,
          executionTaskId: taskId,
          identity,
          taskFencingToken: safeTaskFencingToken,
          taskLeaseId: safeTaskLeaseId,
          taskLeaseExpiresAt: safeTaskLeaseExpiresAt,
          taskOwnerDigest: safeTaskOwnerDigest,
          runOwnerDigest: safeRunOwnerDigest,
        });
        return rowToRunExecution(existing);
      }
      const windowEnd = intent.scheduled_for;
      const windowStart = new Date(
        Date.parse(windowEnd) - control.overlap_window_minutes * 60_000,
      ).toISOString();
      const activeCount = Number(database.prepare(`
        SELECT COUNT(*) AS count
        FROM schedule_run_executions
        WHERE tenant_scope = ? AND employee_id = ? AND schedule_id = ?
          AND execution_state IN ('active', 'cancel_requested')
      `).get(identity.tenantScope, identity.employeeId, identity.scheduleId).count);
      let admissionOutcome = "admitted";
      if (activeCount >= control.max_concurrent_runs) {
        admissionOutcome = "skipped_max_concurrency";
      } else if (control.overlap_window_minutes > 0) {
        const overlapping = database.prepare(`
          SELECT run_id
          FROM schedule_run_executions
          WHERE tenant_scope = ? AND employee_id = ? AND schedule_id = ?
            AND execution_state IN ('active', 'cancel_requested', 'reconcile_blocked')
            AND window_start < ? AND ? < window_end
          LIMIT 1
        `).get(
          identity.tenantScope,
          identity.employeeId,
          identity.scheduleId,
          windowEnd,
          windowStart,
        );
        if (overlapping) admissionOutcome = "skipped_overlap_window";
      }
      const admitted = admissionOutcome === "admitted";
      const leaseId = admitted ? `schedule-run-lease-${crypto.randomUUID()}` : null;
      database.prepare(`
        INSERT INTO schedule_run_executions (
          run_id, execution_version, tenant_scope, employee_id, schedule_id,
          execution_task_id, activation_version, window_start, window_end,
          execution_state, execution_phase, admission_outcome,
          lease_id, owner_digest, fencing_token, lease_expires_at,
          task_lease_id, task_owner_digest, task_fencing_token, task_lease_expires_at,
          result_receipt_requirement,
          claimed_at, released_at, updated_at
        ) VALUES (?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'required', ?, ?, ?)
      `).run(
        safeRunId,
        identity.tenantScope,
        identity.employeeId,
        identity.scheduleId,
        taskId,
        expectedActivation,
        windowStart,
        windowEnd,
        admitted ? "active" : "skipped_admission",
        "pre_effect",
        admissionOutcome,
        leaseId,
        admitted ? safeRunOwnerDigest : null,
        admitted ? 1 : 0,
        admitted ? leaseExpiresAt : null,
        safeTaskLeaseId,
        safeTaskOwnerDigest,
        safeTaskFencingToken,
        safeTaskLeaseExpiresAt,
        safeNow,
        admitted ? null : safeNow,
        safeNow,
      );
      return rowToRunExecution(readRunExecution(safeRunId, identity.tenantScope));
    });
  }

  function rebindPreEffectRunExecution({
    tenantScope,
    employeeId,
    scheduleId,
    runId,
    executionTaskId,
    expectedIntentVersion,
    expectedExecutionVersion,
    activationVersion,
    taskLeaseId,
    taskOwnerDigest,
    taskFencingToken,
    taskLeaseExpiresAt,
    runOwnerDigest,
    leaseDurationMs = 30_000,
    now = new Date(),
  } = {}) {
    const identity = normalizeIdentity({ tenantScope, employeeId, scheduleId });
    const safeRunId = token(runId, "runId");
    const taskId = token(executionTaskId, "executionTaskId");
    const expectedIntent = positiveInteger(expectedIntentVersion, "expectedIntentVersion");
    const expectedExecution = positiveInteger(expectedExecutionVersion, "expectedExecutionVersion");
    const expectedActivation = positiveInteger(activationVersion, "activationVersion");
    const safeTaskLeaseId = token(taskLeaseId, "taskLeaseId");
    const safeTaskOwnerDigest = digest(taskOwnerDigest, "taskOwnerDigest");
    const safeTaskFencingToken = positiveInteger(taskFencingToken, "taskFencingToken");
    const safeRunOwnerDigest = digest(runOwnerDigest, "runOwnerDigest");
    const safeNow = canonicalTimestamp(now, "now");
    const safeTaskLeaseExpiresAt = liveTaskLeaseExpiry(taskLeaseExpiresAt, safeNow);
    const duration = boundedInteger(leaseDurationMs, 1, 86_400_000, "leaseDurationMs");
    const leaseExpiresAt = cappedLeaseExpiry(safeNow, duration, safeTaskLeaseExpiresAt);
    const leaseId = `schedule-run-lease-${crypto.randomUUID()}`;
    return transaction(database, () => {
      const control = requireControl(identity);
      const intent = requireIntent(safeRunId, identity.tenantScope);
      requireRunExecutionClaim({
        activationVersion: expectedActivation,
        control,
        executionTaskId: taskId,
        expectedIntentVersion: expectedIntent,
        identity,
        intent,
      });
      const existing = readRunExecution(safeRunId, identity.tenantScope);
      const matches = existing && existing.execution_version === expectedExecution &&
        existing.employee_id === identity.employeeId && existing.schedule_id === identity.scheduleId &&
        existing.execution_task_id === taskId && existing.activation_version === expectedActivation &&
        existing.execution_state === "active" && existing.execution_phase === "pre_effect" &&
        existing.admission_outcome === "admitted" && existing.lease_expires_at <= safeNow &&
        existing.task_lease_expires_at !== null &&
        safeTaskFencingToken > existing.task_fencing_token;
      if (!matches) throw controlError("schedule_control_run_execution_takeover_conflict");
      const result = database.prepare(`
        UPDATE schedule_run_executions
        SET execution_version = execution_version + 1,
            lease_id = ?, owner_digest = ?, fencing_token = fencing_token + 1,
            lease_expires_at = ?, task_lease_id = ?, task_owner_digest = ?, task_fencing_token = ?,
            task_lease_expires_at = ?, claimed_at = ?, updated_at = ?
        WHERE run_id = ? AND tenant_scope = ? AND execution_version = ?
          AND execution_state = 'active' AND execution_phase = 'pre_effect'
          AND execution_task_id = ? AND activation_version = ?
          AND lease_expires_at <= ? AND task_lease_expires_at IS NOT NULL AND task_fencing_token < ?
      `).run(
        leaseId,
        safeRunOwnerDigest,
        leaseExpiresAt,
        safeTaskLeaseId,
        safeTaskOwnerDigest,
        safeTaskFencingToken,
        safeTaskLeaseExpiresAt,
        safeNow,
        safeNow,
        safeRunId,
        identity.tenantScope,
        expectedExecution,
        taskId,
        expectedActivation,
        safeNow,
        safeTaskFencingToken,
      );
      if (result.changes !== 1) throw controlError("schedule_control_run_execution_takeover_conflict");
      return rowToRunExecution(readRunExecution(safeRunId, identity.tenantScope));
    });
  }

  function prepareRunExecutionEffectDispatch({
    tenantScope,
    runId,
    expectedExecutionVersion,
    leaseId,
    ownerDigest,
    fencingToken,
    taskLeaseId,
    taskOwnerDigest,
    taskFencingToken,
    preparedAt,
  } = {}) {
    const safeTenant = token(tenantScope, "tenantScope");
    const safeRunId = token(runId, "runId");
    const expectedExecution = positiveInteger(expectedExecutionVersion, "expectedExecutionVersion");
    const lease = normalizeDualRunLeaseIdentity({
      leaseId,
      ownerDigest,
      fencingToken,
      taskLeaseId,
      taskOwnerDigest,
      taskFencingToken,
    });
    const now = canonicalTimestamp(preparedAt, "preparedAt");
    const result = database.prepare(`
      UPDATE schedule_run_executions
      SET execution_version = execution_version + 1,
          execution_phase = 'effect_dispatch_prepared', updated_at = ?
      WHERE run_id = ? AND tenant_scope = ? AND execution_version = ?
        AND execution_state = 'active' AND execution_phase = 'pre_effect'
        AND lease_id = ? AND owner_digest = ? AND fencing_token = ?
        AND task_lease_id = ? AND task_owner_digest = ? AND task_fencing_token = ?
        AND lease_expires_at > ? AND task_lease_expires_at > ?
    `).run(
      now,
      safeRunId,
      safeTenant,
      expectedExecution,
      lease.leaseId,
      lease.ownerDigest,
      lease.fencingToken,
      lease.taskLeaseId,
      lease.taskOwnerDigest,
      lease.taskFencingToken,
      now,
      now,
    );
    if (result.changes !== 1) throw controlError("schedule_control_run_execution_phase_conflict");
    return rowToRunExecution(readRunExecution(safeRunId, safeTenant));
  }

  function guardRunExecutionEffectDispatch({
    tenantScope,
    runId,
    executionTaskId,
    expectedIntentVersion,
    expectedExecutionVersion,
    activationVersion,
    leaseId,
    ownerDigest,
    fencingToken,
    leaseExpiresAt,
    taskLeaseId,
    taskOwnerDigest,
    taskFencingToken,
    taskLeaseExpiresAt,
  } = {}) {
    const safeTenant = token(tenantScope, "tenantScope");
    const safeRunId = token(runId, "runId");
    const taskId = token(executionTaskId, "executionTaskId");
    const expectedIntent = positiveInteger(expectedIntentVersion, "expectedIntentVersion");
    const expectedExecution = positiveInteger(expectedExecutionVersion, "expectedExecutionVersion");
    const expectedActivation = positiveInteger(activationVersion, "activationVersion");
    const lease = normalizeDualRunLeaseIdentity({
      leaseId,
      ownerDigest,
      fencingToken,
      taskLeaseId,
      taskOwnerDigest,
      taskFencingToken,
    });
    const expectedLeaseExpiry = canonicalTimestamp(leaseExpiresAt, "leaseExpiresAt");
    const expectedTaskLeaseExpiry = canonicalTimestamp(taskLeaseExpiresAt, "taskLeaseExpiresAt");
    if (typeof now !== "function") throw controlError("schedule_control_activation_authority_unavailable");
    const safeNow = canonicalTimestamp(now(), "now");
    return transaction(database, () => {
      const intent = requireIntent(safeRunId, safeTenant);
      const identity = normalizeIdentity({
        tenantScope: intent.tenant_scope,
        employeeId: intent.employee_id,
        scheduleId: intent.schedule_id,
      });
      const control = requireControl(identity);
      requireRunExecutionClaim({
        activationVersion: expectedActivation,
        control,
        executionTaskId: taskId,
        expectedIntentVersion: expectedIntent,
        identity,
        intent,
      });
      const execution = readRunExecution(safeRunId, safeTenant);
      const slotDigest = scheduleTriggerSlotDigest({
        tenantScope: intent.tenant_scope,
        employeeId: intent.employee_id,
        scheduleId: intent.schedule_id,
        scheduledFor: intent.scheduled_for, manualRequestDigest: intent.manual_request_digest ?? undefined,
      });
      const matches = execution && execution.execution_version === expectedExecution &&
        intent.run_id === `schedule_run_${slotDigest}` &&
        intent.expected_trigger_id === `schedule_trigger_${slotDigest}` &&
        intent.expected_execution_task_id === `task_${slotDigest}` &&
        taskId === `task_${slotDigest}` &&
        execution.tenant_scope === safeTenant && execution.employee_id === identity.employeeId &&
        execution.schedule_id === identity.scheduleId && execution.execution_task_id === taskId &&
        execution.window_end === intent.scheduled_for && execution.result_receipt_requirement === "required" &&
        execution.activation_version === expectedActivation && execution.execution_state === "active" &&
        execution.execution_phase === "effect_dispatch_prepared" && execution.admission_outcome === "admitted" &&
        execution.lease_id === lease.leaseId && execution.owner_digest === lease.ownerDigest &&
        execution.fencing_token === lease.fencingToken && execution.lease_expires_at === expectedLeaseExpiry &&
        execution.task_lease_id === lease.taskLeaseId && execution.task_owner_digest === lease.taskOwnerDigest &&
        execution.task_fencing_token === lease.taskFencingToken &&
        execution.task_lease_expires_at === expectedTaskLeaseExpiry &&
        expectedLeaseExpiry > safeNow && expectedTaskLeaseExpiry > safeNow &&
        readRunResultReceipt(safeRunId, safeTenant) === null;
      if (!matches) throw controlError("schedule_control_run_execution_effect_guard_fenced");
      const changed = database.prepare(`
        UPDATE schedule_run_executions
        SET execution_version = execution_version + 1, updated_at = ?
        WHERE run_id = ? AND tenant_scope = ? AND execution_version = ?
          AND execution_state = 'active' AND execution_phase = 'effect_dispatch_prepared'
          AND admission_outcome = 'admitted' AND execution_task_id = ? AND activation_version = ?
          AND lease_id = ? AND owner_digest = ? AND fencing_token = ? AND lease_expires_at = ?
          AND task_lease_id = ? AND task_owner_digest = ? AND task_fencing_token = ?
          AND task_lease_expires_at = ? AND lease_expires_at > ? AND task_lease_expires_at > ?
      `).run(
        safeNow,
        safeRunId,
        safeTenant,
        expectedExecution,
        taskId,
        expectedActivation,
        lease.leaseId,
        lease.ownerDigest,
        lease.fencingToken,
        expectedLeaseExpiry,
        lease.taskLeaseId,
        lease.taskOwnerDigest,
        lease.taskFencingToken,
        expectedTaskLeaseExpiry,
        safeNow,
        safeNow,
      );
      if (changed.changes !== 1) throw controlError("schedule_control_run_execution_effect_guard_fenced");
      return rowToRunExecution(readRunExecution(safeRunId, safeTenant));
    });
  }

  function finalizeRunExecution({
    tenantScope,
    runId,
    expectedIntentVersion,
    expectedExecutionVersion,
    leaseId,
    ownerDigest,
    fencingToken,
    taskLeaseId,
    taskOwnerDigest,
    taskFencingToken,
    canonicalTaskRevision,
    canonicalTaskStatus,
    receiptEffectState,
    receiptEvidenceDigest,
    resultReceiptDigest = null,
    canonicalTerminalEvidenceDigest = null,
    finalizedAt,
  } = {}) {
    const safeTenant = token(tenantScope, "tenantScope");
    const safeRunId = token(runId, "runId");
    const expectedIntent = positiveInteger(expectedIntentVersion, "expectedIntentVersion");
    const expectedExecution = positiveInteger(expectedExecutionVersion, "expectedExecutionVersion");
    const lease = normalizeDualRunLeaseIdentity({
      leaseId,
      ownerDigest,
      fencingToken,
      taskLeaseId,
      taskOwnerDigest,
      taskFencingToken,
    });
    const taskRevision = positiveInteger(canonicalTaskRevision, "canonicalTaskRevision");
    const taskStatus = enumValue(canonicalTaskStatus, TERMINAL_TASK_STATUSES, "schedule_control_task_status_invalid");
    const effectState = enumValue(
      receiptEffectState,
      RUN_RECEIPT_EFFECT_STATES,
      "schedule_control_run_receipt_effect_state_invalid",
    );
    const evidenceDigest = digest(receiptEvidenceDigest, "receiptEvidenceDigest");
    const referencedResultReceiptDigest = resultReceiptDigest === null
      ? null
      : digest(resultReceiptDigest, "resultReceiptDigest");
    const terminalEvidenceDigest = canonicalTerminalEvidenceDigest === null
      ? null
      : digest(canonicalTerminalEvidenceDigest, "canonicalTerminalEvidenceDigest");
    const now = canonicalTimestamp(finalizedAt, "finalizedAt");
    return transaction(database, () => {
      const intent = requireIntent(safeRunId, safeTenant);
      const execution = readRunExecution(safeRunId, safeTenant);
      if (execution?.execution_phase === "pre_effect" && taskStatus === "completed") {
        throw controlError("schedule_control_run_execution_effect_not_prepared");
      }
      const matches = execution && intent.intent_version === expectedIntent && intent.intent_state === "submitted" &&
        execution.execution_version === expectedExecution && execution.execution_state === "active" &&
        RUN_EXECUTION_PHASES.has(execution.execution_phase) &&
        execution.execution_task_id === intent.execution_task_id &&
        execution.employee_id === intent.employee_id && execution.schedule_id === intent.schedule_id &&
        execution.activation_version === intent.activation_version &&
        execution.lease_id === lease.leaseId && execution.owner_digest === lease.ownerDigest &&
        execution.fencing_token === lease.fencingToken && execution.task_lease_id === lease.taskLeaseId &&
        execution.task_owner_digest === lease.taskOwnerDigest &&
        execution.task_fencing_token === lease.taskFencingToken;
      if (!matches) throw controlError("schedule_control_run_execution_finalize_conflict");
      const requirement = enumValue(
        execution.result_receipt_requirement,
        RUN_RESULT_RECEIPT_REQUIREMENTS,
        "schedule_control_run_result_receipt_requirement_invalid",
      );
      let authoritativeEffectState = effectState;
      let authoritativeEvidenceDigest = evidenceDigest;
      let storedResultReceiptDigest = null;
      let storedTerminalEvidenceDigest = null;
      let receiptOutcome = null;
      let forcedErrorCode = null;
      const activationRow = database.prepare(`
        SELECT * FROM schedule_activation_snapshots WHERE snapshot_id = ? AND tenant_scope = ?
      `).get(intent.activation_snapshot_id, safeTenant);
      const activation = activationRow ? rowToActivationSnapshot(activationRow).snapshot : null;
      if (activation?.contractVersion === SCHEDULE_ACTIVATION_SNAPSHOT_CONTRACT_VERSION_V3) {
        if (requirement !== "required" || referencedResultReceiptDigest ||
          activation.snapshotDigest !== intent.activation_snapshot_digest ||
          typeof resolveAgentTerminalEvidence !== "function") {
          throw controlError("schedule_control_agent_terminal_evidence_required");
        }
        let trusted;
        const runConfigurationDigest = getRunConfiguration({ tenantScope: safeTenant, runId: execution.run_id })?.configurationDigest;
        try {
          trusted = resolveAgentTerminalEvidence({
            tenantScope: safeTenant, taskId: execution.execution_task_id,
            employeeId: execution.employee_id, activationSnapshotDigest: activation.snapshotDigest, runConfigurationDigest,
          });
        } catch {
          throw controlError("schedule_control_agent_terminal_evidence_required");
        }
        if (!trusted || trusted instanceof Promise ||
          trusted.contractVersion !== (runConfigurationDigest ? "schedule-agent-terminal-evidence.v2" : "schedule-agent-terminal-evidence.v1") ||
          trusted.runConfigurationDigest !== runConfigurationDigest ||
          trusted.tenantScope !== safeTenant || trusted.taskId !== execution.execution_task_id ||
          trusted.employeeId !== execution.employee_id || trusted.activationSnapshotDigest !== activation.snapshotDigest ||
          trusted.taskRevision !== taskRevision || trusted.taskStatus !== taskStatus ||
          (execution.execution_phase === "pre_effect" && trusted.operationCount !== 0) ||
          trusted.effectState !== effectState || trusted.operationReceiptEvidenceDigest !== evidenceDigest ||
          trusted.terminalEvidenceDigest !== terminalEvidenceDigest) {
          throw controlError("schedule_control_agent_terminal_evidence_mismatch");
        }
        authoritativeEffectState = trusted.effectState;
        authoritativeEvidenceDigest = trusted.operationReceiptEvidenceDigest;
        storedTerminalEvidenceDigest = trusted.terminalEvidenceDigest;
      } else if (requirement === "required") {
        if (!terminalEvidenceDigest) {
          if (execution.execution_phase !== "effect_dispatch_prepared") {
            throw controlError("schedule_control_run_terminal_evidence_required");
          }
          authoritativeEffectState = "reconcile_required";
          forcedErrorCode = "schedule_run_terminal_evidence_required";
        } else if (execution.execution_phase === "pre_effect") {
          if (referencedResultReceiptDigest) {
            throw controlError("schedule_control_run_result_receipt_finalize_conflict");
          }
          if (effectState !== "settled" || terminalEvidenceDigest !== evidenceDigest) {
            authoritativeEffectState = "reconcile_required";
            forcedErrorCode = "schedule_run_pre_effect_evidence_required";
          }
          storedTerminalEvidenceDigest = terminalEvidenceDigest;
        } else {
          const receiptRow = readRunResultReceipt(safeRunId, safeTenant);
          if (!receiptRow || !referencedResultReceiptDigest) {
            authoritativeEffectState = "reconcile_required";
            forcedErrorCode = "schedule_run_result_receipt_required";
          } else {
            const receipt = rowToRunResultReceipt(receiptRow, intent);
            const receiptMatches = receipt.resultReceiptDigest === referencedResultReceiptDigest &&
              receipt.executionTaskId === execution.execution_task_id &&
              receipt.leaseId === lease.leaseId && receipt.ownerDigest === lease.ownerDigest &&
              receipt.fencingToken === lease.fencingToken && receipt.taskLeaseId === lease.taskLeaseId &&
              receipt.taskOwnerDigest === lease.taskOwnerDigest &&
              receipt.taskFencingToken === lease.taskFencingToken &&
              receipt.receiptEffectState === effectState &&
              receipt.operationReceiptEvidenceDigest === evidenceDigest;
            if (!receiptMatches) throw controlError("schedule_control_run_result_receipt_finalize_conflict");
            authoritativeEffectState = receipt.receiptEffectState;
            authoritativeEvidenceDigest = receipt.operationReceiptEvidenceDigest;
            storedResultReceiptDigest = receipt.resultReceiptDigest;
            receiptOutcome = receipt.outcome;
            const terminalEvidence = projectScheduleRunTerminalEvidence({
              receipt,
              canonicalTaskStatus: taskStatus,
            });
            if (terminalEvidenceDigest !== terminalEvidence.terminalEvidenceDigest) {
              throw controlError("schedule_control_run_terminal_evidence_mismatch");
            }
            storedTerminalEvidenceDigest = terminalEvidence.terminalEvidenceDigest;
          }
        }
      } else {
        throw controlError("schedule_control_legacy_run_reconciliation_required");
      }
      const released = authoritativeEffectState === "settled" && receiptOutcome !== "unknown";
      const nextExecutionState = released ? "released" : "reconcile_blocked";
      const lastErrorCode = released
        ? null
        : forcedErrorCode || (receiptOutcome === "unknown"
          ? "schedule_run_result_unknown"
          : "schedule_run_effect_reconcile_required");
      const intentResult = database.prepare(`
        UPDATE schedule_run_intents
        SET intent_version = intent_version + 1, intent_state = 'terminal_observed',
            observed_task_status = ?, last_error_code = ?, reconciled_at = ?, terminal_at = ?, updated_at = ?
        WHERE run_id = ? AND tenant_scope = ? AND intent_version = ? AND intent_state = 'submitted'
      `).run(
        taskStatus,
        lastErrorCode,
        now,
        now,
        now,
        safeRunId,
        safeTenant,
        expectedIntent,
      );
      if (intentResult.changes !== 1) throw controlError("schedule_control_run_execution_finalize_conflict");
      const executionResult = database.prepare(`
        UPDATE schedule_run_executions
        SET execution_version = execution_version + 1, execution_state = ?,
            observed_task_status = ?, last_error_code = ?,
            canonical_task_revision = ?, canonical_task_status = ?,
            effect_state = ?, effect_evidence_digest = ?, finalized_at = ?,
            result_receipt_digest = ?, canonical_terminal_evidence_digest = ?,
            lease_id = NULL, owner_digest = NULL, lease_expires_at = NULL,
            reconcile_blocked_at = CASE WHEN ? = 'reconcile_blocked' THEN ? ELSE NULL END,
            released_at = CASE WHEN ? = 'released' THEN ? ELSE NULL END,
            updated_at = ?
        WHERE run_id = ? AND tenant_scope = ? AND execution_version = ?
          AND execution_state = 'active'
          AND lease_id = ? AND owner_digest = ? AND fencing_token = ?
          AND task_lease_id = ? AND task_owner_digest = ? AND task_fencing_token = ?
      `).run(
        nextExecutionState,
        taskStatus,
        lastErrorCode,
        taskRevision,
        taskStatus,
        authoritativeEffectState,
        authoritativeEvidenceDigest,
        now,
        storedResultReceiptDigest,
        storedTerminalEvidenceDigest,
        nextExecutionState,
        now,
        nextExecutionState,
        now,
        now,
        safeRunId,
        safeTenant,
        expectedExecution,
        lease.leaseId,
        lease.ownerDigest,
        lease.fencingToken,
        lease.taskLeaseId,
        lease.taskOwnerDigest,
        lease.taskFencingToken,
      );
      if (executionResult.changes !== 1) throw controlError("schedule_control_run_execution_finalize_conflict");
      return Object.freeze({
        intent: rowToIntent(requireIntent(safeRunId, safeTenant)),
        execution: rowToRunExecution(readRunExecution(safeRunId, safeTenant)),
      });
    });
  }

  function recordRunResultReceipt(value = {}) {
    requireExactObject(value, RUN_RESULT_RECEIPT_FIELDS, "schedule_control_run_result_receipt_invalid");
    const safeTenant = token(value.tenantScope, "tenantScope");
    const safeRunId = token(value.runId, "runId");
    return transaction(database, () => {
      const intent = requireIntent(safeRunId, safeTenant);
      const candidate = normalizeRunResultReceiptCandidate(value, {
        employeeId: intent.employee_id,
        scheduleId: intent.schedule_id,
      });
      const existing = readRunResultReceipt(candidate.runId, candidate.tenantScope);
      if (existing) {
        const receipt = rowToRunResultReceipt(existing, intent);
        if (!sameRunResultReceiptCandidate(receipt, candidate)) {
          throw controlError("schedule_control_run_result_receipt_conflict");
        }
        const currentExecution = readRunExecution(candidate.runId, candidate.tenantScope);
        return Object.freeze({
          created: false,
          receipt,
          execution: currentExecution ? rowToRunExecution(currentExecution) : null,
        });
      }
      const execution = readRunExecution(candidate.runId, candidate.tenantScope);
      const current = intent.intent_state === "submitted" &&
        intent.intent_version === candidate.baseIntentVersion && execution &&
        execution.execution_version === candidate.baseExecutionVersion &&
        execution.execution_state === "active" && execution.execution_phase === "effect_dispatch_prepared" &&
        intent.execution_task_id === candidate.executionTaskId &&
        execution.execution_task_id === candidate.executionTaskId &&
        execution.employee_id === intent.employee_id && execution.schedule_id === intent.schedule_id &&
        execution.activation_version === intent.activation_version &&
        intent.activation_snapshot_id === candidate.activationSnapshotId &&
        intent.activation_snapshot_digest === candidate.activationSnapshotDigest &&
        execution.lease_id === candidate.leaseId && execution.owner_digest === candidate.ownerDigest &&
        execution.fencing_token === candidate.fencingToken &&
        execution.task_lease_id === candidate.taskLeaseId &&
        execution.task_owner_digest === candidate.taskOwnerDigest &&
        execution.task_fencing_token === candidate.taskFencingToken &&
        execution.lease_expires_at > candidate.recordedAt &&
        execution.task_lease_expires_at > candidate.recordedAt;
      if (!current) throw controlError("schedule_control_run_result_receipt_fenced");

      insertRunResultReceipt(candidate);
      const changed = database.prepare(`
        UPDATE schedule_run_executions
        SET execution_version = execution_version + 1, updated_at = ?
        WHERE tenant_scope = ? AND run_id = ? AND execution_version = ?
          AND execution_state = 'active' AND execution_phase = 'effect_dispatch_prepared'
          AND execution_task_id = ?
          AND lease_id = ? AND owner_digest = ? AND fencing_token = ?
          AND task_lease_id = ? AND task_owner_digest = ? AND task_fencing_token = ?
          AND lease_expires_at > ? AND task_lease_expires_at > ?
      `).run(
        candidate.recordedAt, candidate.tenantScope, candidate.runId, candidate.baseExecutionVersion,
        candidate.executionTaskId, candidate.leaseId, candidate.ownerDigest, candidate.fencingToken,
        candidate.taskLeaseId, candidate.taskOwnerDigest, candidate.taskFencingToken,
        candidate.recordedAt, candidate.recordedAt,
      );
      if (changed.changes !== 1) throw controlError("schedule_control_run_result_receipt_fenced");
      return Object.freeze({
        created: true,
        receipt: rowToRunResultReceipt(
          readRunResultReceipt(candidate.runId, candidate.tenantScope),
          intent,
        ),
        execution: rowToRunExecution(readRunExecution(candidate.runId, candidate.tenantScope)),
      });
    });
  }

  function adoptRunResultReceiptForReconciliation(value = {}) {
    requireExactObject(
      value,
      RUN_RESULT_RECEIPT_ADOPTION_FIELDS,
      "schedule_control_run_result_receipt_adoption_invalid",
    );
    if (typeof now !== "function" || typeof resolveResultProcessingOutcome !== "function") {
      throw controlError("schedule_control_run_result_receipt_adoption_unavailable");
    }
    const safeTenant = token(value.tenantScope, "tenantScope");
    const safeRunId = token(value.runId, "runId");
    const expectedIntent = positiveInteger(value.expectedIntentVersion, "expectedIntentVersion");
    const expectedExecution = positiveInteger(value.expectedExecutionVersion, "expectedExecutionVersion");
    const adoptedAt = canonicalTimestamp(now(), "now");
    return transaction(database, () => {
      const intent = requireIntent(safeRunId, safeTenant);
      const execution = readRunExecution(safeRunId, safeTenant);
      const resolved = requireResultProcessingOutcomeResolution(resolveResultProcessingOutcome({
        tenantScope: safeTenant,
        runId: safeRunId,
      }));
      const existing = readRunResultReceipt(safeRunId, safeTenant);
      const existingReceipt = existing ? rowToRunResultReceipt(existing, intent) : null;
      requireResultProcessingOutcomeMatches({
        adoptedAt,
        execution,
        intent,
        receipt: existingReceipt,
        resolved,
      });
      const lease = existingReceipt || execution;
      const candidate = normalizeRunResultReceiptCandidate({
        tenantScope: safeTenant,
        runId: safeRunId,
        expectedIntentVersion: expectedIntent,
        expectedExecutionVersion: expectedExecution,
        executionTaskId: intent.execution_task_id,
        activationSnapshotId: intent.activation_snapshot_id,
        activationSnapshotDigest: intent.activation_snapshot_digest,
        leaseId: existingReceipt ? lease.leaseId : lease?.lease_id,
        ownerDigest: existingReceipt ? lease.ownerDigest : lease?.owner_digest,
        fencingToken: existingReceipt ? lease.fencingToken : lease?.fencing_token,
        taskLeaseId: existingReceipt ? lease.taskLeaseId : lease?.task_lease_id,
        taskOwnerDigest: existingReceipt ? lease.taskOwnerDigest : lease?.task_owner_digest,
        taskFencingToken: existingReceipt ? lease.taskFencingToken : lease?.task_fencing_token,
        operationReceiptEvidenceDigest: resolved.outcome.processingEvidenceDigest,
        receiptEffectState: "reconcile_required",
        outcome: resolved.outcome.state,
        resultEvidenceDigest: resolved.outcome.resultEvidenceDigest,
        recordedAt: adoptedAt,
      }, {
        employeeId: intent.employee_id,
        scheduleId: intent.schedule_id,
      });
      if (existing) {
        if (!sameRunResultReceiptCandidate(existingReceipt, candidate)) {
          throw controlError("schedule_control_run_result_receipt_conflict");
        }
        return Object.freeze({
          created: false,
          receipt: existingReceipt,
          execution: execution ? rowToRunExecution(execution) : null,
        });
      }
      const adoptable = intent.intent_state === "submitted" && intent.intent_version === expectedIntent &&
        execution && execution.execution_version === expectedExecution && execution.execution_state === "active" &&
        execution.execution_phase === "effect_dispatch_prepared" &&
        execution.result_receipt_requirement === "required" &&
        execution.execution_task_id === intent.execution_task_id &&
        execution.lease_expires_at !== null && execution.task_lease_expires_at !== null &&
        execution.lease_expires_at <= adoptedAt && execution.task_lease_expires_at <= adoptedAt;
      if (!adoptable) throw controlError("schedule_control_run_result_receipt_adoption_fenced");
      insertRunResultReceipt(candidate);
      const changed = database.prepare(`
        UPDATE schedule_run_executions
        SET execution_version = execution_version + 1,
            execution_state = 'reconcile_blocked',
            last_error_code = 'schedule_run_result_receipt_recovery_adopted',
            lease_id = NULL, owner_digest = NULL, lease_expires_at = NULL,
            reconcile_blocked_at = ?, updated_at = ?
        WHERE tenant_scope = ? AND run_id = ? AND execution_version = ?
          AND execution_state = 'active' AND execution_phase = 'effect_dispatch_prepared'
          AND result_receipt_requirement = 'required'
          AND execution_task_id = ?
          AND lease_id = ? AND owner_digest = ? AND fencing_token = ?
          AND task_lease_id = ? AND task_owner_digest = ? AND task_fencing_token = ?
          AND lease_expires_at <= ? AND task_lease_expires_at <= ?
      `).run(
        adoptedAt,
        adoptedAt,
        safeTenant,
        safeRunId,
        expectedExecution,
        candidate.executionTaskId,
        candidate.leaseId,
        candidate.ownerDigest,
        candidate.fencingToken,
        candidate.taskLeaseId,
        candidate.taskOwnerDigest,
        candidate.taskFencingToken,
        adoptedAt,
        adoptedAt,
      );
      if (changed.changes !== 1) {
        throw controlError("schedule_control_run_result_receipt_adoption_fenced");
      }
      return Object.freeze({
        created: true,
        receipt: rowToRunResultReceipt(readRunResultReceipt(safeRunId, safeTenant), intent),
        execution: rowToRunExecution(readRunExecution(safeRunId, safeTenant)),
      });
    });
  }

  function insertRunResultReceipt(candidate) {
    database.prepare(`
      INSERT INTO schedule_run_result_receipts (
        tenant_scope, run_id, employee_id, schedule_id, receipt_version, result_receipt_digest,
        base_intent_version, base_execution_version, execution_task_id,
        activation_snapshot_id, activation_snapshot_digest,
        lease_id, owner_digest, fencing_token,
        task_lease_id, task_owner_digest, task_fencing_token, lease_binding_digest,
        operation_receipt_evidence_digest, receipt_effect_state, outcome,
        result_evidence_digest, recorded_at
      ) VALUES (?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      candidate.tenantScope, candidate.runId, candidate.employeeId, candidate.scheduleId,
      candidate.resultReceiptDigest,
      candidate.baseIntentVersion, candidate.baseExecutionVersion, candidate.executionTaskId,
      candidate.activationSnapshotId, candidate.activationSnapshotDigest,
      candidate.leaseId, candidate.ownerDigest, candidate.fencingToken,
      candidate.taskLeaseId, candidate.taskOwnerDigest, candidate.taskFencingToken,
      candidate.leaseBindingDigest,
      candidate.operationReceiptEvidenceDigest, candidate.receiptEffectState, candidate.outcome,
      candidate.resultEvidenceDigest, candidate.recordedAt,
    );
  }

  function requireResultProcessingOutcomeMatches({ adoptedAt, execution, intent, receipt, resolved }) {
    const snapshotRow = database.prepare(`
      SELECT * FROM schedule_activation_snapshots
      WHERE tenant_scope = ? AND snapshot_id = ?
    `).get(intent.tenant_scope, intent.activation_snapshot_id);
    if (!snapshotRow) throw controlError("schedule_control_run_result_processing_binding_mismatch");
    const snapshotRecord = rowToActivationSnapshot(snapshotRow);
    const snapshot = snapshotRecord.snapshot;
    const binding = resolved.binding;
    const leaseBindingDigest = receipt?.leaseBindingDigest || (execution ? digestCanonical({
      contractVersion: "schedule-run-dual-lease-binding.v1",
      leaseId: execution.lease_id,
      ownerDigest: execution.owner_digest,
      fencingToken: execution.fencing_token,
      taskLeaseId: execution.task_lease_id,
      taskOwnerDigest: execution.task_owner_digest,
      taskFencingToken: execution.task_fencing_token,
    }) : null);
    const matches = snapshot.contractVersion === SCHEDULE_ACTIVATION_SNAPSHOT_CONTRACT_VERSION_V2 &&
      snapshotRecord.snapshotDigest === intent.activation_snapshot_digest &&
      binding.tenantScope === intent.tenant_scope && binding.employeeId === intent.employee_id &&
      binding.scheduleId === intent.schedule_id && binding.runId === intent.run_id &&
      binding.canonicalTaskId === intent.execution_task_id && binding.triggerId === intent.expected_trigger_id &&
      binding.scheduledFor === intent.scheduled_for && binding.activationVersion === intent.activation_version &&
      binding.activationSnapshotId === intent.activation_snapshot_id &&
      binding.activationSnapshotDigest === intent.activation_snapshot_digest &&
      binding.processingAuthorityDigest === snapshot.processingAuthorityDigest &&
      binding.resultContractDigest === snapshot.resultContractDigest &&
      binding.alertContractDigest === snapshot.alertContractDigest &&
      binding.retentionDefinitionDigest === snapshot.retentionDefinitionDigest &&
      binding.runLeaseBindingDigest === leaseBindingDigest &&
      resolved.outcome.processedAt >= intent.submitted_at && resolved.outcome.processedAt <= adoptedAt;
    if (!matches) throw controlError("schedule_control_run_result_processing_binding_mismatch");
  }

  function getRunResultReceipt(runId, { tenantScope } = {}) {
    const safeRunId = token(runId, "runId");
    const safeTenant = token(tenantScope, "tenantScope");
    const row = readRunResultReceipt(safeRunId, safeTenant);
    if (!row) return null;
    return rowToRunResultReceipt(row, requireIntent(safeRunId, safeTenant));
  }

  function renewRunExecution({
    tenantScope,
    runId,
    leaseId,
    ownerDigest,
    fencingToken,
    taskLeaseId,
    taskOwnerDigest,
    taskFencingToken,
    taskLeaseExpiresAt,
    leaseDurationMs = 30_000,
    now = new Date(),
  } = {}) {
    const safeTenant = token(tenantScope, "tenantScope");
    const lease = normalizeDualRunLeaseIdentity({
      leaseId,
      ownerDigest,
      fencingToken,
      taskLeaseId,
      taskOwnerDigest,
      taskFencingToken,
    });
    const safeRunId = token(runId, "runId");
    const safeNow = canonicalTimestamp(now, "now");
    const safeTaskLeaseExpiresAt = canonicalTimestamp(taskLeaseExpiresAt, "taskLeaseExpiresAt");
    if (safeTaskLeaseExpiresAt <= safeNow) return null;
    const duration = boundedInteger(leaseDurationMs, 1, 86_400_000, "leaseDurationMs");
    const expiresAt = cappedLeaseExpiry(safeNow, duration, safeTaskLeaseExpiresAt);
    const result = database.prepare(`
      UPDATE schedule_run_executions
      SET lease_expires_at = ?, task_lease_expires_at = ?, updated_at = ?
      WHERE run_id = ? AND tenant_scope = ? AND execution_state = 'active'
        AND lease_id = ? AND owner_digest = ? AND fencing_token = ?
        AND task_lease_id = ? AND task_owner_digest = ? AND task_fencing_token = ?
        AND lease_expires_at > ? AND task_lease_expires_at > ?
        AND task_lease_expires_at <= ?
    `).run(
      expiresAt,
      safeTaskLeaseExpiresAt,
      safeNow,
      safeRunId,
      safeTenant,
      lease.leaseId,
      lease.ownerDigest,
      lease.fencingToken,
      lease.taskLeaseId,
      lease.taskOwnerDigest,
      lease.taskFencingToken,
      safeNow,
      safeNow,
      safeTaskLeaseExpiresAt,
    );
    return result.changes === 1 ? rowToRunExecution(readRunExecution(safeRunId, safeTenant)) : null;
  }

  function releaseRunExecution({
    tenantScope,
    runId,
    leaseId,
    ownerDigest,
    fencingToken,
    taskFencingToken,
    taskStatus,
    releasedAt,
  } = {}) {
    const safeTenant = token(tenantScope, "tenantScope");
    const lease = normalizeRunLeaseIdentity({ leaseId, ownerDigest, fencingToken, taskFencingToken });
    const safeRunId = token(runId, "runId");
    const status = enumValue(taskStatus, TERMINAL_TASK_STATUSES, "schedule_control_task_status_invalid");
    const now = canonicalTimestamp(releasedAt, "releasedAt");
    const result = database.prepare(`
      UPDATE schedule_run_executions
      SET execution_version = execution_version + 1, execution_state = 'released',
          observed_task_status = ?, lease_id = NULL, owner_digest = NULL,
          lease_expires_at = NULL, released_at = ?, updated_at = ?
      WHERE run_id = ? AND tenant_scope = ? AND execution_state = 'active'
        AND execution_phase = 'pre_effect'
        AND lease_id = ? AND owner_digest = ? AND fencing_token = ? AND task_fencing_token = ?
        AND lease_expires_at > ?
    `).run(
      status,
      now,
      now,
      safeRunId,
      safeTenant,
      lease.leaseId,
      lease.ownerDigest,
      lease.fencingToken,
      lease.taskFencingToken,
      now,
    );
    if (result.changes !== 1) throw controlError("schedule_control_run_execution_fenced");
    return rowToRunExecution(readRunExecution(safeRunId, safeTenant));
  }

  function markRunExecutionReconcileBlocked({
    tenantScope,
    runId,
    leaseId,
    ownerDigest,
    fencingToken,
    taskFencingToken,
    errorCode,
    blockedAt,
  } = {}) {
    const safeTenant = token(tenantScope, "tenantScope");
    const lease = normalizeRunLeaseIdentity({ leaseId, ownerDigest, fencingToken, taskFencingToken });
    const safeRunId = token(runId, "runId");
    const safeError = token(errorCode, "errorCode", 120);
    const now = canonicalTimestamp(blockedAt, "blockedAt");
    const result = database.prepare(`
      UPDATE schedule_run_executions
      SET execution_version = execution_version + 1, execution_state = 'reconcile_blocked',
          last_error_code = ?, lease_id = NULL, owner_digest = NULL,
          lease_expires_at = NULL, reconcile_blocked_at = ?, updated_at = ?
      WHERE run_id = ? AND tenant_scope = ? AND execution_state = 'active'
        AND lease_id = ? AND owner_digest = ? AND fencing_token = ? AND task_fencing_token = ?
        AND lease_expires_at > ?
    `).run(
      safeError,
      now,
      now,
      safeRunId,
      safeTenant,
      lease.leaseId,
      lease.ownerDigest,
      lease.fencingToken,
      lease.taskFencingToken,
      now,
    );
    if (result.changes !== 1) throw controlError("schedule_control_run_execution_fenced");
    return rowToRunExecution(readRunExecution(safeRunId, safeTenant));
  }

  function getRunExecution(runId, { tenantScope } = {}) {
    const safeTenant = token(tenantScope, "tenantScope");
    const row = readRunExecution(token(runId, "runId"), safeTenant);
    return row ? rowToRunExecution(row) : null;
  }

  function recordCancelDispatch({
    tenantScope,
    cancelId,
    runId,
    emergencyStopVersion,
    expectedOutboxVersion,
    canonicalTaskRevision,
    canonicalTaskStatus,
    effectState,
    effectEvidenceDigest,
    dispatchedAt,
  } = {}) {
    const safeTenant = token(tenantScope, "tenantScope");
    const safeCancelId = token(cancelId, "cancelId");
    const safeRunId = token(runId, "runId");
    const stopGeneration = positiveInteger(emergencyStopVersion, "emergencyStopVersion");
    const expected = positiveInteger(expectedOutboxVersion, "expectedOutboxVersion");
    const taskRevision = nonNegativeInteger(canonicalTaskRevision, "canonicalTaskRevision");
    const taskStatus = enumValue(canonicalTaskStatus, CANCEL_CANONICAL_TASK_STATUSES, "schedule_control_task_status_invalid");
    const safeEffectState = enumValue(effectState, CANCEL_EFFECT_STATES, "schedule_control_cancel_effect_state_invalid");
    const evidenceDigest = digest(effectEvidenceDigest, "effectEvidenceDigest");
    requireCancelCanonicalEvidence({ effectState: safeEffectState, taskRevision, taskStatus });
    if (safeEffectState === "safe_terminal" && !isCancellationTerminalStatus(taskStatus)) {
      throw controlError("schedule_control_cancel_terminal_evidence_invalid");
    }
    const now = canonicalTimestamp(dispatchedAt, "dispatchedAt");
    return transaction(database, () => {
      const result = database.prepare(`
        UPDATE schedule_cancel_outbox
        SET outbox_version = outbox_version + 1,
            outbox_state = 'dispatched',
            canonical_task_revision = ?, canonical_task_status = ?,
            effect_state = ?, effect_evidence_digest = ?,
            dispatched_at = ?, updated_at = ?
        WHERE cancel_id = ? AND tenant_scope = ? AND run_id = ?
          AND emergency_stop_version = ?
          AND outbox_version = ? AND outbox_state = 'pending'
          AND reconcile_state = 'pending'
      `).run(
        taskRevision,
        taskStatus,
        safeEffectState,
        evidenceDigest,
        now,
        now,
        safeCancelId,
        safeTenant,
        safeRunId,
        stopGeneration,
        expected,
      );
      if (result.changes !== 1) throw controlError("schedule_control_cancel_outbox_conflict");
      return rowToCancelOutbox(requireCancelOutbox(safeCancelId, safeTenant));
    });
  }

  function observeCancellationOutcome({
    tenantScope,
    cancelId,
    runId,
    emergencyStopVersion,
    expectedOutboxVersion,
    expectedIntentVersion,
    expectedExecutionVersion = null,
    canonicalTaskRevision,
    canonicalTaskStatus,
    effectState,
    effectEvidenceDigest,
    reconciledAt,
  } = {}) {
    const safeTenant = token(tenantScope, "tenantScope");
    const safeCancelId = token(cancelId, "cancelId");
    const safeRunId = token(runId, "runId");
    const stopGeneration = positiveInteger(emergencyStopVersion, "emergencyStopVersion");
    const expectedOutbox = positiveInteger(expectedOutboxVersion, "expectedOutboxVersion");
    const expectedIntent = positiveInteger(expectedIntentVersion, "expectedIntentVersion");
    const expectedExecution = expectedExecutionVersion === null
      ? null
      : positiveInteger(expectedExecutionVersion, "expectedExecutionVersion");
    const taskRevision = nonNegativeInteger(canonicalTaskRevision, "canonicalTaskRevision");
    const taskStatus = enumValue(canonicalTaskStatus, CANCEL_CANONICAL_TASK_STATUSES, "schedule_control_task_status_invalid");
    const safeEffectState = enumValue(effectState, CANCEL_EFFECT_STATES, "schedule_control_cancel_effect_state_invalid");
    const evidenceDigest = digest(effectEvidenceDigest, "effectEvidenceDigest");
    const now = canonicalTimestamp(reconciledAt, "reconciledAt");
    requireCancelCanonicalEvidence({ effectState: safeEffectState, taskRevision, taskStatus });
    if (safeEffectState === "safe_terminal" && !isCancellationTerminalStatus(taskStatus)) {
      throw controlError("schedule_control_cancel_terminal_evidence_invalid");
    }
    return transaction(database, () => {
      const outbox = requireCancelOutbox(safeCancelId, safeTenant);
      if (outbox.run_id !== safeRunId || outbox.emergency_stop_version !== stopGeneration ||
        outbox.outbox_version !== expectedOutbox || outbox.outbox_state !== "dispatched" ||
        outbox.reconcile_state !== "pending" || outbox.canonical_task_revision !== taskRevision ||
        outbox.canonical_task_status !== taskStatus || outbox.effect_state !== safeEffectState ||
        outbox.effect_evidence_digest !== evidenceDigest) {
        throw controlError("schedule_control_cancel_outbox_conflict");
      }
      const intent = requireIntent(safeRunId, safeTenant);
      if (intent.intent_version !== expectedIntent || intent.employee_id !== outbox.employee_id ||
        intent.schedule_id !== outbox.schedule_id || intent.activation_version !== outbox.activation_version ||
        intent.expected_trigger_id !== outbox.expected_trigger_id ||
        (intent.execution_task_id || intent.expected_execution_task_id) !== outbox.execution_task_id) {
        throw controlError("schedule_control_cancel_intent_conflict");
      }
      const execution = readRunExecution(safeRunId, safeTenant);
      if ((execution && expectedExecution === null) || (!execution && expectedExecution !== null) ||
        (execution && execution.execution_version !== expectedExecution)) {
        throw controlError("schedule_control_cancel_execution_conflict");
      }

      if (safeEffectState === "safe_terminal") {
        if (!["cancel_requested", "skipped_emergency_stop"].includes(intent.intent_state)) {
          throw controlError("schedule_control_cancel_intent_conflict");
        }
        const intentResult = database.prepare(`
          UPDATE schedule_run_intents
          SET intent_version = intent_version + 1, intent_state = 'terminal_observed',
              observed_task_status = ?, reconciled_at = ?, terminal_at = ?, updated_at = ?
          WHERE run_id = ? AND tenant_scope = ? AND intent_version = ?
            AND intent_state IN ('cancel_requested', 'skipped_emergency_stop')
        `).run(taskStatus, now, now, now, safeRunId, safeTenant, expectedIntent);
        if (intentResult.changes !== 1) throw controlError("schedule_control_cancel_intent_conflict");
        if (execution && execution.execution_state !== "reconcile_blocked") {
          const executionResult = database.prepare(`
            UPDATE schedule_run_executions
            SET execution_version = execution_version + 1, execution_state = 'released',
                observed_task_status = ?, lease_id = NULL, owner_digest = NULL,
                lease_expires_at = NULL, released_at = ?, updated_at = ?
            WHERE run_id = ? AND tenant_scope = ? AND execution_version = ?
              AND execution_state = 'cancel_requested'
          `).run(taskStatus, now, now, safeRunId, safeTenant, expectedExecution);
          if (executionResult.changes !== 1) throw controlError("schedule_control_cancel_execution_conflict");
        }
      } else {
        if (intent.intent_state !== "cancel_requested") {
          throw controlError("schedule_control_cancel_intent_conflict");
        }
        const intentResult = database.prepare(`
          UPDATE schedule_run_intents
          SET intent_version = intent_version + 1, intent_state = 'cancel_requested',
              observed_task_status = ?, last_error_code = 'schedule_cancel_effect_reconcile_required',
              reconciled_at = ?, updated_at = ?
          WHERE run_id = ? AND tenant_scope = ? AND intent_version = ?
            AND intent_state = 'cancel_requested'
        `).run(taskStatus, now, now, safeRunId, safeTenant, expectedIntent);
        if (intentResult.changes !== 1) throw controlError("schedule_control_cancel_intent_conflict");
        if (execution) {
          const executionResult = database.prepare(`
            UPDATE schedule_run_executions
            SET execution_version = execution_version + 1, execution_state = 'reconcile_blocked',
                observed_task_status = ?, last_error_code = 'schedule_cancel_effect_reconcile_required',
                fencing_token = fencing_token + 1,
                lease_id = NULL, owner_digest = NULL, lease_expires_at = NULL,
                reconcile_blocked_at = ?, updated_at = ?
            WHERE run_id = ? AND tenant_scope = ? AND execution_version = ?
              AND execution_state IN ('cancel_requested', 'reconcile_blocked')
          `).run(taskStatus, now, now, safeRunId, safeTenant, expectedExecution);
          if (executionResult.changes !== 1) throw controlError("schedule_control_cancel_execution_conflict");
        }
      }

      const reconcileState = safeEffectState === "safe_terminal" ? "settled" : "reconcile_required";
      const outboxResult = database.prepare(`
        UPDATE schedule_cancel_outbox
        SET outbox_version = outbox_version + 1, reconcile_state = ?, reconciled_at = ?, updated_at = ?
        WHERE cancel_id = ? AND tenant_scope = ? AND run_id = ?
          AND emergency_stop_version = ? AND outbox_version = ?
          AND outbox_state = 'dispatched' AND reconcile_state = 'pending'
      `).run(
        reconcileState,
        now,
        now,
        safeCancelId,
        safeTenant,
        safeRunId,
        stopGeneration,
        expectedOutbox,
      );
      if (outboxResult.changes !== 1) throw controlError("schedule_control_cancel_outbox_conflict");
      return Object.freeze({
        intent: rowToIntent(requireIntent(safeRunId, safeTenant)),
        execution: readRunExecution(safeRunId, safeTenant)
          ? rowToRunExecution(readRunExecution(safeRunId, safeTenant))
          : null,
        outbox: rowToCancelOutbox(requireCancelOutbox(safeCancelId, safeTenant)),
      });
    });
  }

  function markCancelDispatched({ tenantScope, cancelId, expectedOutboxVersion, dispatchedAt } = {}) {
    const safeTenant = token(tenantScope, "tenantScope");
    const safeCancelId = token(cancelId, "cancelId");
    const expected = positiveInteger(expectedOutboxVersion, "expectedOutboxVersion");
    const now = canonicalTimestamp(dispatchedAt, "dispatchedAt");
    const result = database.prepare(`
      UPDATE schedule_cancel_outbox
      SET outbox_version = outbox_version + 1, outbox_state = 'dispatched',
          reconcile_state = 'reconcile_required', effect_state = 'reconcile_required',
          dispatched_at = ?, reconciled_at = ?, updated_at = ?
      WHERE cancel_id = ? AND tenant_scope = ? AND outbox_version = ? AND outbox_state = 'pending'
    `).run(now, now, now, safeCancelId, safeTenant, expected);
    if (result.changes !== 1) throw controlError("schedule_control_cancel_outbox_conflict");
    return rowToCancelOutbox(requireCancelOutbox(safeCancelId, safeTenant));
  }

  function getControl({ tenantScope, employeeId, scheduleId } = {}) {
    const identity = normalizeIdentity({ tenantScope, employeeId, scheduleId });
    const row = readControlRow(identity);
    return row ? rowToControl(row) : null;
  }

  function listActiveSnapshotControls({ tenantScope, limit = 100 } = {}) {
    const safeTenant = token(tenantScope, "tenantScope");
    const safeLimit = boundedInteger(limit, 1, 500, "limit");
    return database.prepare(`
      SELECT tenant_scope, employee_id, schedule_id, control_version, activation_version,
        activation_state, activation_snapshot_id, activation_snapshot_digest
      FROM schedule_controls
      WHERE tenant_scope = ? AND activation_state = 'active' AND emergency_stop_active = 0
        AND activation_snapshot_id IS NOT NULL AND activation_snapshot_digest IS NOT NULL
      ORDER BY employee_id ASC, schedule_id ASC
      LIMIT ?
    `).all(safeTenant, safeLimit).map((row) => deepFreeze({
      tenantScope: row.tenant_scope,
      employeeId: row.employee_id,
      scheduleId: row.schedule_id,
      controlVersion: row.control_version,
      activationVersion: row.activation_version,
      activationState: row.activation_state,
      activationSnapshotId: row.activation_snapshot_id,
      activationSnapshotDigest: row.activation_snapshot_digest,
      effectiveActive: true,
    }));
  }

  function getActivationSnapshot(snapshotId, { tenantScope } = {}) {
    const safeSnapshotId = token(snapshotId, "snapshotId");
    const safeTenantScope = token(tenantScope, "tenantScope");
    const row = database.prepare(`
      SELECT * FROM schedule_activation_snapshots
      WHERE snapshot_id = ? AND tenant_scope = ?
    `).get(safeSnapshotId, safeTenantScope);
    return row ? rowToActivationSnapshot(row).snapshot : null;
  }

  function resolveActiveActivationSnapshot({
    runId,
    tenantScope,
    employeeId,
    scheduleId,
    activationVersion,
    activationSnapshotId,
    activationSnapshotDigest,
  } = {}) {
    const identity = normalizeIdentity({ tenantScope, employeeId, scheduleId });
    const expectedActivationVersion = positiveInteger(activationVersion, "activationVersion");
    const expectedSnapshotId = token(activationSnapshotId, "activationSnapshotId");
    const expectedSnapshotDigest = digest(activationSnapshotDigest, "activationSnapshotDigest");
    const control = readControlRow(identity);
    const run = runId ? requireIntent(token(runId, "runId"), identity.tenantScope) : null;
    const manual = run?.manual_request_digest && run.employee_id === identity.employeeId && run.schedule_id === identity.scheduleId &&
      run.activation_snapshot_digest === expectedSnapshotDigest;
    if (!control || !(control.activation_state === "active" || (manual && control.activation_state === "paused")) || control.emergency_stop_active === 1 ||
      control.activation_version !== expectedActivationVersion ||
      control.activation_snapshot_id !== expectedSnapshotId ||
      control.activation_snapshot_digest !== expectedSnapshotDigest) {
      throw controlError("schedule_control_activation_snapshot_not_active");
    }
    const row = database.prepare(`
      SELECT * FROM schedule_activation_snapshots
      WHERE snapshot_id = ? AND tenant_scope = ?
    `).get(expectedSnapshotId, identity.tenantScope);
    if (!row) throw controlError("schedule_control_activation_snapshot_not_found");
    const stored = rowToActivationSnapshot(row);
    const snapshot = stored.snapshot;
    if (![SCHEDULE_ACTIVATION_SNAPSHOT_CONTRACT_VERSION_V2, SCHEDULE_ACTIVATION_SNAPSHOT_CONTRACT_VERSION_V3].includes(snapshot.contractVersion) ||
      stored.snapshotDigest !== expectedSnapshotDigest || snapshot.activationVersion !== expectedActivationVersion ||
      snapshot.tenantScope !== identity.tenantScope || snapshot.employeeId !== identity.employeeId ||
      snapshot.scheduleId !== identity.scheduleId || snapshot.registrationVersion !== control.registration_version ||
      snapshot.scheduleVersion !== control.schedule_version || snapshot.schedulePolicyDigest !== control.schedule_policy_digest ||
      snapshot.executionContractDigest !== control.execution_contract_digest) {
      throw controlError("schedule_control_activation_snapshot_binding_mismatch");
    }
    if (typeof now !== "function" ||
        (snapshot.contractVersion === SCHEDULE_ACTIVATION_SNAPSHOT_CONTRACT_VERSION_V3
          ? typeof resolveAgentActivationAuthority !== "function" : typeof resolveProcessingAuthority !== "function") ||
      typeof resolveTaskExecutionDefinition !== "function") {
      throw controlError("schedule_control_activation_authority_unavailable");
    }
    requireCurrentActivationGovernance(snapshot, canonicalTimestamp(now(), "now"));
    return deepFreeze({
      snapshot,
      governedSchedule: projectRunnableGovernedScheduleFromActivationSnapshot(snapshot),
    });
  }

  function getIntent(runId, { tenantScope } = {}) {
    const safeTenant = token(tenantScope, "tenantScope");
    const row = database.prepare(
      "SELECT * FROM schedule_run_intents WHERE run_id = ? AND tenant_scope = ?",
    ).get(token(runId, "runId"), safeTenant);
    return row ? rowToIntent(row) : null;
  }

  function listIncompleteIntents({ tenantScope, employeeId = null, scheduleId = null, limit = 100 } = {}) {
    const safeTenant = token(tenantScope, "tenantScope");
    const safeEmployee = employeeId === null ? null : token(employeeId, "employeeId");
    const safeSchedule = scheduleId === null ? null : token(scheduleId, "scheduleId");
    const safeLimit = boundedInteger(limit, 1, 500, "limit");
    return database.prepare(`
      SELECT * FROM schedule_run_intents
      WHERE tenant_scope = ?
        AND (? IS NULL OR employee_id = ?)
        AND (? IS NULL OR schedule_id = ?)
        AND intent_state IN ('prepared', 'reconcile_required', 'submitted', 'cancel_requested')
      ORDER BY scheduled_for ASC, run_id ASC
      LIMIT ?
    `).all(safeTenant, safeEmployee, safeEmployee, safeSchedule, safeSchedule, safeLimit).map(rowToIntent);
  }

  function listRunIntents({ tenantScope, employeeId, scheduleId, beforeScheduledFor = null, limit = 50 } = {}) {
    const identity = normalizeIdentity({ tenantScope, employeeId, scheduleId });
    const before = beforeScheduledFor === null ? null : canonicalTimestamp(beforeScheduledFor, "beforeScheduledFor");
    const safeLimit = boundedInteger(limit, 1, 100, "limit");
    return database.prepare(`
      SELECT * FROM schedule_run_intents
      WHERE tenant_scope = ? AND employee_id = ? AND schedule_id = ?
        AND (? IS NULL OR scheduled_for < ?)
      ORDER BY scheduled_for DESC, run_id DESC
      LIMIT ?
    `).all(
      identity.tenantScope,
      identity.employeeId,
      identity.scheduleId,
      before,
      before,
      safeLimit,
    ).map(rowToIntent);
  }

  function summarizeRuns({ tenantScope, employeeId, scheduleId } = {}) {
    const identity = normalizeIdentity({ tenantScope, employeeId, scheduleId });
    const intents = Object.fromEntries(database.prepare(`
      SELECT intent_state AS state, COUNT(*) AS count
      FROM schedule_run_intents
      WHERE tenant_scope = ? AND employee_id = ? AND schedule_id = ?
      GROUP BY intent_state
    `).all(identity.tenantScope, identity.employeeId, identity.scheduleId)
      .map((row) => [row.state, Number(row.count)]));
    const executions = Object.fromEntries(database.prepare(`
      SELECT execution_state AS state, COUNT(*) AS count
      FROM schedule_run_executions
      WHERE tenant_scope = ? AND employee_id = ? AND schedule_id = ?
      GROUP BY execution_state
    `).all(identity.tenantScope, identity.employeeId, identity.scheduleId)
      .map((row) => [row.state, Number(row.count)]));
    return deepFreeze({ intents, executions });
  }

  function listCancelOutbox({
    tenantScope,
    employeeId = null,
    scheduleId = null,
    emergencyStopVersion = null,
    state = "pending",
    reconcileState = null,
    limit = 100,
  } = {}) {
    const safeTenant = token(tenantScope, "tenantScope");
    const safeEmployee = employeeId === null ? null : token(employeeId, "employeeId");
    const safeSchedule = scheduleId === null ? null : token(scheduleId, "scheduleId");
    const safeStopGeneration = emergencyStopVersion === null
      ? null
      : nonNegativeInteger(emergencyStopVersion, "emergencyStopVersion");
    const safeState = enumValue(state, new Set(["pending", "dispatched"]), "schedule_control_cancel_outbox_state_invalid");
    const safeReconcileState = reconcileState === null
      ? null
      : enumValue(reconcileState, CANCEL_RECONCILE_STATES, "schedule_control_cancel_reconcile_state_invalid");
    const safeLimit = boundedInteger(limit, 1, 500, "limit");
    return database.prepare(`
      SELECT * FROM schedule_cancel_outbox
      WHERE tenant_scope = ?
        AND (? IS NULL OR employee_id = ?)
        AND (? IS NULL OR schedule_id = ?)
        AND (? IS NULL OR emergency_stop_version = ?)
        AND outbox_state = ?
        AND (? IS NULL OR reconcile_state = ?)
      ORDER BY created_at ASC, cancel_id ASC
      LIMIT ?
    `).all(
      safeTenant,
      safeEmployee,
      safeEmployee,
      safeSchedule,
      safeSchedule,
      safeStopGeneration,
      safeStopGeneration,
      safeState,
      safeReconcileState,
      safeReconcileState,
      safeLimit,
    ).map(rowToCancelOutbox);
  }

  function listControlEvents({ tenantScope, employeeId, scheduleId, limit = 100 } = {}) {
    const identity = normalizeIdentity({ tenantScope, employeeId, scheduleId });
    const safeLimit = boundedInteger(limit, 1, 500, "limit");
    return database.prepare(`
      SELECT * FROM schedule_control_events
      WHERE tenant_scope = ? AND employee_id = ? AND schedule_id = ?
      ORDER BY event_at DESC, event_id DESC
      LIMIT ?
    `).all(identity.tenantScope, identity.employeeId, identity.scheduleId, safeLimit).map(rowToControlEvent);
  }

  function prepareIntentInTransaction({ control, identity, scheduledFor, scannerFencingToken, manualRequestDigest, now }) {
    if (!control.activation_snapshot_id || !control.activation_snapshot_digest) {
      throw controlError("schedule_control_activation_snapshot_required");
    }
    const ids = deterministicIntentIds(identity, scheduledFor, manualRequestDigest);
    const existing = database.prepare(`
      SELECT * FROM schedule_run_intents
      WHERE run_id = ? AND tenant_scope = ?
    `).get(ids.runId, identity.tenantScope);
    if (existing) {
      const normalized = rowToIntent(existing);
      if (normalized.runId !== ids.runId || normalized.activationVersion !== control.activation_version ||
        normalized.activationSnapshotId !== control.activation_snapshot_id ||
        normalized.activationSnapshotDigest !== control.activation_snapshot_digest ||
        normalized.scheduleVersion !== control.schedule_version || normalized.schedulePolicyDigest !== control.schedule_policy_digest ||
        normalized.executionContractDigest !== control.execution_contract_digest) {
        throw controlError("schedule_control_slot_idempotency_conflict");
      }
      return normalized;
    }
    const overlapOutcome = "admitted";
    const state = "prepared";
    database.prepare(`
      INSERT INTO schedule_run_intents (
        run_id, intent_version, tenant_scope, employee_id, schedule_id,
        activation_version, activation_snapshot_id, activation_snapshot_digest,
        schedule_version, schedule_policy_digest, execution_contract_digest,
        scheduled_for, expected_trigger_id, expected_execution_task_id,
        intent_state, overlap_outcome, scanner_fencing_token,
        prepared_at, created_at, updated_at, manual_request_digest
      ) VALUES (?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      ids.runId,
      identity.tenantScope,
      identity.employeeId,
      identity.scheduleId,
      control.activation_version,
      control.activation_snapshot_id,
      control.activation_snapshot_digest,
      control.schedule_version,
      control.schedule_policy_digest,
      control.execution_contract_digest,
      scheduledFor,
      ids.triggerId,
      ids.executionTaskId,
      state,
      overlapOutcome,
      scannerFencingToken,
      now,
      now,
      now,
      manualRequestDigest ?? null,
    );
    const prepared = rowToIntent(requireIntent(ids.runId));
    const activationSnapshot = getActivationSnapshot(prepared.activationSnapshotId, { tenantScope: prepared.tenantScope });
    if (activationSnapshot.contractVersion === SCHEDULE_ACTIVATION_SNAPSHOT_CONTRACT_VERSION_V3) {
      if (!resolveRunConfiguration) throw controlError("schedule_run_configuration_unavailable");
      const configuration = resolveRunConfiguration({ intent: prepared, activationSnapshot });
      if (!configuration || configuration instanceof Promise) throw controlError("schedule_run_configuration_unavailable");
      if (configuration.taskModelBinding?.taskId !== activationSnapshot.taskDefinitionId) throw controlError("schedule_run_configuration_task_mismatch");
      runConfigurations.seal(prepared, configuration);
    }
    return prepared;
  }


  function insertCancelOutbox({
    activationVersion,
    emergencyStopVersion,
    expectedTriggerId,
    identity,
    reasonCode,
    runId,
    taskId,
    now,
  }) {
    const cancelId = `schedule-cancel-${digestCanonical([
      identity.tenantScope,
      identity.employeeId,
      identity.scheduleId,
      taskId,
      emergencyStopVersion,
    ])}`;
    database.prepare(`
      INSERT INTO schedule_cancel_outbox (
        cancel_id, outbox_version, tenant_scope, employee_id, schedule_id,
        run_id, execution_task_id, emergency_stop_version, activation_version,
        expected_trigger_id, reason_code, outbox_state, reconcile_state,
        created_at, updated_at
      ) VALUES (?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', 'pending', ?, ?)
      ON CONFLICT(cancel_id) DO NOTHING
    `).run(
      cancelId,
      identity.tenantScope,
      identity.employeeId,
      identity.scheduleId,
      runId,
      taskId,
      emergencyStopVersion,
      activationVersion,
      expectedTriggerId,
      reasonCode,
      now,
      now,
    );
  }

  function insertControlEvent({
    actorDisplayName,
    actorIdentitySource,
    actorNameStatus,
    actorPrincipalId,
    actorResolvedAt,
    controlVersion,
    eventAt,
    eventType,
    identity,
    reasonCode,
    safeReason,
  }) {
    const eventId = `schedule-control-event-${digestCanonical([
      "schedule-control-event.v1",
      identity.tenantScope,
      identity.employeeId,
      identity.scheduleId,
      controlVersion,
      eventType,
    ])}`;
    database.prepare(`
      INSERT INTO schedule_control_events (
        event_id, tenant_scope, employee_id, schedule_id, control_version,
        event_type, reason_code, safe_reason,
        actor_principal_id, actor_display_name, actor_name_status,
        actor_identity_source, actor_resolved_at, event_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      eventId,
      identity.tenantScope,
      identity.employeeId,
      identity.scheduleId,
      controlVersion,
      eventType,
      reasonCode,
      safeReason,
      actorPrincipalId,
      actorDisplayName,
      actorNameStatus,
      actorIdentitySource,
      actorResolvedAt,
      eventAt,
    );
  }

  function requireCurrentActivationGovernance(snapshot, evaluatedAt, initialActivation = false) {
    if (snapshot.contractVersion === SCHEDULE_ACTIVATION_SNAPSHOT_CONTRACT_VERSION_V3) {
      return requireCurrentAgentActivationGovernance(snapshot, evaluatedAt, initialActivation);
    }
    const identity = normalizeIdentity(snapshot);
    const head = readBusinessOwnerAcceptanceHeadRow(identity);
    if (!head) throw controlError("schedule_control_activation_owner_acceptance_required");
    const acceptance = requireBusinessOwnerAcceptanceHeadRevision(identity, head);
    if (acceptance.contractVersion !== SCHEDULE_BUSINESS_OWNER_ACCEPTANCE_CONTRACT_VERSION_V2 ||
      acceptance.decision !== "accepted") {
      throw controlError("schedule_control_activation_owner_acceptance_v2_required");
    }
    let proof;
    try {
      proof = projectScheduleBusinessOwnerAcceptanceProofV2({
        acceptance,
        currentCandidate: acceptance.candidate,
        evaluatedAt,
      });
    } catch {
      throw controlError("schedule_control_activation_owner_acceptance_not_current");
    }
    if (!isDeepStrictEqual(proof, snapshot.approval)) {
      throw controlError("schedule_control_activation_owner_acceptance_proof_mismatch");
    }

    let resolution;
    try {
      resolution = resolveProcessingAuthority({
        tenantScope: identity.tenantScope,
        processingAuthorityDigest: snapshot.processingAuthorityDigest,
      });
    } catch {
      throw controlError("schedule_control_activation_processing_authority_unavailable");
    }
    const expectedResolutionFields = [
      "alertContract", "authority", "contractVersion", "resultContract", "retentionDefinition",
    ];
    if (!resolution || resolution instanceof Promise ||
      !isDeepStrictEqual(Object.keys(resolution).sort(), expectedResolutionFields)) {
      throw controlError("schedule_control_activation_processing_authority_invalid");
    }
    let authority;
    try {
      if (resolution.contractVersion !== "schedule-result-processing-resolution.v1") {
        throw new TypeError("processing resolution version invalid");
      }
      authority = normalizeScheduleResultProcessingAuthority(resolution.authority, {
        resultContract: resolution.resultContract,
        alertContract: resolution.alertContract,
        retentionDefinition: resolution.retentionDefinition,
      });
    } catch {
      throw controlError("schedule_control_activation_processing_authority_invalid");
    }
    if (authority.resultContractDigest !== snapshot.resultContractDigest ||
      authority.alertContractDigest !== snapshot.alertContractDigest ||
      authority.retentionDefinitionDigest !== snapshot.retentionDefinitionDigest ||
      authority.processingAuthorityDigest !== snapshot.processingAuthorityDigest) {
      throw controlError("schedule_control_activation_processing_authority_mismatch");
    }

    let taskResolution;
    try {
      taskResolution = resolveTaskExecutionDefinition({
        tenantScope: identity.tenantScope,
        taskDefinitionId: snapshot.taskDefinitionId,
        executionContractDigest: snapshot.executionContractDigest,
      });
    } catch {
      throw controlError("schedule_control_activation_task_definition_unavailable");
    }
    const expectedTaskResolutionFields = [
      "contractVersion", "definition", "executionContractDigest", "payloadBoundary", "publishedAt",
    ];
    if (!taskResolution || typeof taskResolution !== "object" || Array.isArray(taskResolution) ||
      taskResolution instanceof Promise ||
      !isDeepStrictEqual(Object.keys(taskResolution).sort(), expectedTaskResolutionFields)) {
      throw controlError("schedule_control_activation_task_definition_invalid");
    }
    let taskDefinition;
    let taskDefinitionPublishedAt;
    try {
      if (taskResolution.contractVersion !== "schedule-task-execution-definition-resolution.v1" ||
        taskResolution.payloadBoundary !== "internal_only") {
        throw new TypeError("task definition resolution boundary invalid");
      }
      taskDefinition = normalizeScheduleTaskExecutionDefinitionV2(taskResolution.definition);
      taskDefinitionPublishedAt = canonicalTimestamp(taskResolution.publishedAt, "taskDefinitionPublishedAt");
    } catch {
      throw controlError("schedule_control_activation_task_definition_invalid");
    }
    if (taskResolution.executionContractDigest !== snapshot.executionContractDigest ||
      taskDefinition.taskDefinitionId !== snapshot.taskDefinitionId ||
      taskDefinition.resultContractDigest !== snapshot.resultContractDigest ||
      taskDefinitionPublishedAt > evaluatedAt) {
      throw controlError("schedule_control_activation_task_definition_mismatch");
    }
  }

  function requireCurrentAgentActivationGovernance(snapshot, evaluatedAt, initialActivation) {
    let resolution;
    let authority;
    try {
      resolution = resolveTaskExecutionDefinition({
        tenantScope: snapshot.tenantScope,
        taskDefinitionId: snapshot.taskDefinitionId,
        executionContractDigest: snapshot.executionContractDigest,
      });
      if (resolution?.contractVersion !== "schedule-task-execution-definition-resolution.v1" ||
        resolution.payloadBoundary !== "internal_only" || resolution instanceof Promise) throw new Error();
      const definition = normalizeScheduleAgentTaskDefinition(resolution.definition);
      if (resolution.executionContractDigest !== snapshot.executionContractDigest ||
        definition.taskDefinitionId !== snapshot.taskDefinitionId ||
        definition.taskDefinitionVersion !== snapshot.taskDefinitionVersion ||
        definition.resultContractDigest !== snapshot.resultContractDigest ||
        canonicalTimestamp(resolution.publishedAt, "publishedAt") > evaluatedAt) throw new Error();
      // Trusted composition resolves current administrator/owner, employee, model and
      // mounted immutable policies. No caller-supplied approval flag grants authority.
      authority = resolveAgentActivationAuthority({
        tenantScope: snapshot.tenantScope, employeeId: snapshot.employeeId,
        scheduleId: snapshot.scheduleId, actor: snapshot.actor,
        owner: snapshot.owner, scheduleScope: snapshot.scheduleScope,
        definition, evaluatedAt, initialActivation,
      });
    } catch {
      throw controlError("schedule_control_agent_activation_authority_unavailable");
    }
    const expected = {
      contractVersion: "schedule-agent-activation-authority.v1",
      actor: snapshot.actor, owner: snapshot.owner, scheduleScope: snapshot.scheduleScope,
      employeeVersion: snapshot.employeeVersion, taskModelBinding: snapshot.taskModelBinding,
      skillPolicyDigest: snapshot.skillPolicyDigest, toolPolicyDigest: snapshot.toolPolicyDigest,
    };
    const actual = initialActivation ? authority : {
      contractVersion: authority?.contractVersion, actor: authority?.actor, owner: authority?.owner, scheduleScope: authority?.scheduleScope,
    };
    if (!initialActivation) for (const field of ["employeeVersion", "taskModelBinding", "skillPolicyDigest", "toolPolicyDigest"]) delete expected[field];
    if (!isDeepStrictEqual(actual, expected)) {
      throw controlError("schedule_control_agent_activation_authority_mismatch");
    }
  }

  function saveActivationSnapshotInTransaction(snapshotValue) {
    const snapshot = normalizeRunnableScheduleActivationSnapshot(snapshotValue);
    const snapshotId = `schedule_activation_snapshot_${snapshot.snapshotDigest}`;
    const serialized = JSON.stringify(snapshot);
    const existingGeneration = database.prepare(`
      SELECT snapshot_id FROM schedule_activation_snapshots
      WHERE tenant_scope = ? AND employee_id = ? AND schedule_id = ? AND activation_version = ?
    `).get(snapshot.tenantScope, snapshot.employeeId, snapshot.scheduleId, snapshot.activationVersion);
    if (existingGeneration && existingGeneration.snapshot_id !== snapshotId) {
      throw controlError("schedule_control_activation_snapshot_conflict");
    }
    const existing = database.prepare(`
      SELECT * FROM schedule_activation_snapshots
      WHERE snapshot_id = ? AND tenant_scope = ?
    `).get(snapshotId, snapshot.tenantScope);
    if (existing) {
      const stored = rowToActivationSnapshot(existing);
      if (stored.snapshotDigest !== snapshot.snapshotDigest || !isDeepStrictEqual(stored.snapshot, snapshot)) {
        throw controlError("schedule_control_activation_snapshot_conflict");
      }
      return stored;
    }
    database.prepare(`
      INSERT INTO schedule_activation_snapshots (
        snapshot_id, snapshot_version, snapshot_digest,
        tenant_scope, employee_id, schedule_id, activation_version,
        registration_version, schedule_version, snapshot_json, created_at,
        snapshot_contract_version, acceptance_candidate_digest,
        acceptance_revision_digest, acceptance_proof_digest, processing_authority_digest
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      snapshotId,
      snapshot.snapshotVersion,
      snapshot.snapshotDigest,
      snapshot.tenantScope,
      snapshot.employeeId,
      snapshot.scheduleId,
      snapshot.activationVersion,
      snapshot.registrationVersion,
      snapshot.scheduleVersion,
      serialized,
      snapshot.createdAt,
      snapshot.contractVersion,
      snapshot.approval?.acceptanceCandidateDigest ?? null,
      snapshot.approval?.acceptanceRevisionDigest ?? null,
      snapshot.approval?.proofDigest ?? null,
      snapshot.processingAuthorityDigest ?? null,
    );
    return rowToActivationSnapshot(database.prepare(`
      SELECT * FROM schedule_activation_snapshots
      WHERE snapshot_id = ? AND tenant_scope = ?
    `).get(snapshotId, snapshot.tenantScope));
  }

  function readControlRow(identity) {
    return database.prepare(`
      SELECT * FROM schedule_controls
      WHERE tenant_scope = ? AND employee_id = ? AND schedule_id = ?
    `).get(identity.tenantScope, identity.employeeId, identity.scheduleId) || null;
  }

  function requireNoPendingScheduleLedger(identity, errorCode) {
    const pendingIntent = database.prepare(`
      SELECT run_id FROM schedule_run_intents
      WHERE tenant_scope = ? AND employee_id = ? AND schedule_id = ?
        AND intent_state IN ('prepared', 'submitted', 'cancel_requested', 'reconcile_required')
      LIMIT 1
    `).get(identity.tenantScope, identity.employeeId, identity.scheduleId);
    const pendingExecution = database.prepare(`
      SELECT run_id FROM schedule_run_executions
      WHERE tenant_scope = ? AND employee_id = ? AND schedule_id = ?
        AND execution_state IN ('active', 'cancel_requested', 'reconcile_blocked')
      LIMIT 1
    `).get(identity.tenantScope, identity.employeeId, identity.scheduleId);
    const pendingCancellation = database.prepare(`
      SELECT cancel_id FROM schedule_cancel_outbox
      WHERE tenant_scope = ? AND employee_id = ? AND schedule_id = ?
        AND reconcile_state != 'settled'
      LIMIT 1
    `).get(identity.tenantScope, identity.employeeId, identity.scheduleId);
    if (pendingIntent || pendingExecution || pendingCancellation) throw controlError(errorCode);
  }

  function requireActiveSnapshotRow(control) {
    if (!control.activation_snapshot_id || !control.activation_snapshot_digest) {
      throw controlError("schedule_control_activation_snapshot_required");
    }
    const row = database.prepare(`
      SELECT * FROM schedule_activation_snapshots
      WHERE snapshot_id = ? AND tenant_scope = ?
    `).get(control.activation_snapshot_id, control.tenant_scope);
    const stored = row ? rowToActivationSnapshot(row) : null;
    if (!stored || ![SCHEDULE_ACTIVATION_SNAPSHOT_CONTRACT_VERSION_V2, SCHEDULE_ACTIVATION_SNAPSHOT_CONTRACT_VERSION_V3].includes(stored.snapshot.contractVersion) ||
      stored.snapshotDigest !== control.activation_snapshot_digest ||
      stored.snapshot.activationVersion !== control.activation_version ||
      stored.snapshot.employeeId !== control.employee_id || stored.snapshot.scheduleId !== control.schedule_id) {
      throw controlError("schedule_control_activation_snapshot_binding_mismatch");
    }
    if (typeof now !== "function" ||
        (stored.snapshot.contractVersion === SCHEDULE_ACTIVATION_SNAPSHOT_CONTRACT_VERSION_V3
          ? typeof resolveAgentActivationAuthority !== "function" : typeof resolveProcessingAuthority !== "function") ||
      typeof resolveTaskExecutionDefinition !== "function") {
      throw controlError("schedule_control_activation_authority_unavailable");
    }
    requireCurrentActivationGovernance(stored.snapshot, canonicalTimestamp(now(), "now"));
    return stored;
  }

  function requireControl(identity) {
    const row = readControlRow(identity);
    if (!row) throw controlError("schedule_control_not_found");
    return row;
  }

  function requireCurrentIntentDispatchGovernance(intent) {
    const control = readControlRow({
      tenantScope: intent.tenant_scope,
      employeeId: intent.employee_id,
      scheduleId: intent.schedule_id,
    });
    if (!control || !(control.activation_state === "active" || (intent.manual_request_digest && control.activation_state === "paused")) || control.emergency_stop_active === 1 ||
      control.activation_version !== intent.activation_version || control.schedule_version !== intent.schedule_version ||
      control.activation_snapshot_id !== intent.activation_snapshot_id ||
      control.activation_snapshot_digest !== intent.activation_snapshot_digest ||
      control.schedule_policy_digest !== intent.schedule_policy_digest ||
      control.execution_contract_digest !== intent.execution_contract_digest) {
      throw controlError("schedule_control_intent_governance_changed");
    }
    try {
      requireActiveSnapshotRow(control);
    } catch {
      throw controlError("schedule_control_intent_governance_changed");
    }
    return control;
  }

  function requireIntent(runId, tenantScope = null) {
    const row = tenantScope === null
      ? database.prepare("SELECT * FROM schedule_run_intents WHERE run_id = ?").get(runId)
      : database.prepare("SELECT * FROM schedule_run_intents WHERE run_id = ? AND tenant_scope = ?").get(runId, tenantScope);
    if (!row) throw controlError("schedule_control_intent_not_found");
    return row;
  }

  function requireCancelOutbox(cancelId, tenantScope = null) {
    const row = tenantScope === null
      ? database.prepare("SELECT * FROM schedule_cancel_outbox WHERE cancel_id = ?").get(cancelId)
      : database.prepare("SELECT * FROM schedule_cancel_outbox WHERE cancel_id = ? AND tenant_scope = ?").get(cancelId, tenantScope);
    if (!row) throw controlError("schedule_control_cancel_outbox_not_found");
    return row;
  }

  function readRunExecution(runId, tenantScope) {
    return database.prepare(`
      SELECT * FROM schedule_run_executions
      WHERE run_id = ? AND tenant_scope = ?
    `).get(runId, tenantScope) || null;
  }

  function readRunResultReceipt(runId, tenantScope) {
    return database.prepare(`
      SELECT * FROM schedule_run_result_receipts
      WHERE run_id = ? AND tenant_scope = ?
    `).get(runId, tenantScope) || null;
  }

  function requireRunExecutionClaim({
    activationVersion,
    control,
    executionTaskId,
    expectedIntentVersion,
    identity,
    intent,
  }) {
    let storedSnapshot;
    try {
      storedSnapshot = requireActiveSnapshotRow(control);
    } catch {
      throw controlError("schedule_control_run_execution_governance_changed");
    }
    const snapshot = storedSnapshot.snapshot;
    const validControl = (control.activation_state === "active" || (intent.manual_request_digest && control.activation_state === "paused")) && control.emergency_stop_active === 0 &&
      control.activation_version === activationVersion &&
      Number.isInteger(control.max_concurrent_runs) && Number.isInteger(control.overlap_window_minutes);
    const validIntent = intent.intent_version === expectedIntentVersion && intent.intent_state === "submitted" &&
      intent.tenant_scope === identity.tenantScope && intent.employee_id === identity.employeeId &&
      intent.schedule_id === identity.scheduleId && intent.execution_task_id === executionTaskId &&
      intent.activation_version === activationVersion && intent.schedule_version === control.schedule_version &&
      intent.activation_snapshot_id === control.activation_snapshot_id &&
      intent.activation_snapshot_digest === control.activation_snapshot_digest &&
      intent.schedule_policy_digest === control.schedule_policy_digest &&
      intent.execution_contract_digest === control.execution_contract_digest;
    const validSnapshot = snapshot.tenantScope === identity.tenantScope &&
      snapshot.employeeId === identity.employeeId && snapshot.scheduleId === identity.scheduleId &&
      snapshot.activationVersion === activationVersion && storedSnapshot.snapshotId === control.activation_snapshot_id &&
      storedSnapshot.snapshotDigest === control.activation_snapshot_digest &&
      snapshot.scheduleVersion === control.schedule_version &&
      snapshot.schedulePolicyDigest === control.schedule_policy_digest &&
      snapshot.executionContractDigest === control.execution_contract_digest &&
      /^[a-f0-9]{64}$/.test(snapshot.resultContractDigest);
    if (!validControl || !validIntent || !validSnapshot) {
      throw controlError("schedule_control_run_execution_governance_changed");
    }
  }

  function requireSameRunExecution(existing, {
    activationVersion,
    executionTaskId,
    identity,
    taskFencingToken,
    taskLeaseId,
    taskLeaseExpiresAt,
    taskOwnerDigest,
    runOwnerDigest,
  }) {
    const matches = existing.tenant_scope === identity.tenantScope &&
      existing.employee_id === identity.employeeId && existing.schedule_id === identity.scheduleId &&
      existing.execution_task_id === executionTaskId && existing.activation_version === activationVersion &&
      existing.task_lease_id === taskLeaseId && existing.task_owner_digest === taskOwnerDigest &&
      existing.task_fencing_token === taskFencingToken && existing.task_lease_expires_at === taskLeaseExpiresAt &&
      (existing.execution_state !== "active" || existing.owner_digest === runOwnerDigest);
    if (!matches) throw controlError("schedule_control_run_execution_idempotency_conflict");
  }

  function recordBusinessOwnerAcceptanceV2({
    revision,
    expectedAcceptanceVersion,
    expectedPreviousRevisionDigest,
  } = {}) {
    const acceptance = normalizeScheduleBusinessOwnerAcceptanceRevisionV2(revision);
    const identity = normalizeIdentity(acceptance.candidate);
    const expectedVersion = nonNegativeInteger(expectedAcceptanceVersion, "expectedAcceptanceVersion");
    if (acceptance.acceptanceVersion !== expectedVersion + 1 ||
      acceptance.previousAcceptanceVersion !== expectedVersion) {
      throw controlError("schedule_control_owner_acceptance_version_conflict");
    }
    let expectedPreviousDigest = null;
    if (expectedVersion === 0) {
      if (expectedPreviousRevisionDigest !== null) {
        throw controlError("schedule_control_owner_acceptance_previous_digest_invalid");
      }
    } else {
      expectedPreviousDigest = digest(expectedPreviousRevisionDigest, "expectedPreviousRevisionDigest");
    }

    return transaction(database, () => {
      const head = readBusinessOwnerAcceptanceHeadRow(identity);
      const existingRevisionRow = readBusinessOwnerAcceptanceRevisionRow(identity, acceptance.acceptanceVersion);
      if (existingRevisionRow) {
        const existing = rowToBusinessOwnerAcceptance(existingRevisionRow);
        if (existing.revisionDigest !== acceptance.revisionDigest) {
          throw controlError("schedule_control_owner_acceptance_revision_conflict");
        }
        if (existingRevisionRow.previous_revision_digest !== expectedPreviousDigest) {
          throw controlError("schedule_control_owner_acceptance_previous_digest_conflict");
        }
        if (!head || head.acceptance_version !== existing.acceptanceVersion ||
          head.revision_digest !== existing.revisionDigest) {
          throw controlError("schedule_control_owner_acceptance_version_conflict");
        }
        return deepFreeze({ created: false, acceptance: existing });
      }

      const currentVersion = Number(head?.acceptance_version || 0);
      if (currentVersion !== expectedVersion) {
        throw controlError("schedule_control_owner_acceptance_version_conflict");
      }
      if (expectedVersion > 0 && (!head || head.revision_digest !== expectedPreviousDigest)) {
        throw controlError("schedule_control_owner_acceptance_previous_digest_conflict");
      }
      const currentAcceptance = head ? requireBusinessOwnerAcceptanceHeadRevision(identity, head) : null;
      if (acceptance.decision === "revoked") {
        if (!currentAcceptance || currentAcceptance.decision !== "accepted" ||
          currentAcceptance.candidate.candidateDigest !== acceptance.candidate.candidateDigest) {
          throw controlError("schedule_control_owner_acceptance_revoke_transition_invalid");
        }
      } else if (currentAcceptance?.decision === "accepted" &&
        currentAcceptance.candidate.candidateDigest === acceptance.candidate.candidateDigest) {
        throw controlError("schedule_control_owner_acceptance_refresh_not_allowed");
      }

      const serialized = JSON.stringify(acceptance);
      database.prepare(`
        INSERT INTO schedule_business_owner_acceptance_revisions (
          tenant_scope, employee_id, schedule_id, acceptance_version,
          revision_digest, previous_revision_digest, decision, candidate_digest,
          revision_json, decided_at, acceptance_contract_version
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        identity.tenantScope,
        identity.employeeId,
        identity.scheduleId,
        acceptance.acceptanceVersion,
        acceptance.revisionDigest,
        expectedPreviousDigest,
        acceptance.decision,
        acceptance.candidate.candidateDigest,
        serialized,
        acceptance.decidedAt,
        acceptance.contractVersion,
      );
      database.prepare(`
        INSERT INTO schedule_business_owner_acceptance_heads (
          tenant_scope, employee_id, schedule_id, acceptance_version, revision_digest, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(tenant_scope, employee_id, schedule_id) DO UPDATE SET
          acceptance_version = excluded.acceptance_version,
          revision_digest = excluded.revision_digest,
          updated_at = excluded.updated_at
      `).run(
        identity.tenantScope,
        identity.employeeId,
        identity.scheduleId,
        acceptance.acceptanceVersion,
        acceptance.revisionDigest,
        acceptance.decidedAt,
      );
      return deepFreeze({ created: true, acceptance });
    });
  }

  function getBusinessOwnerAcceptance(value = {}) {
    const identity = normalizeIdentity(value);
    const joined = readBusinessOwnerAcceptanceHeadRevisionRow(identity);
    if (joined) return requireBusinessOwnerAcceptanceJoinedRevision(joined);
    if (hasBusinessOwnerAcceptanceRevision(identity)) {
      throw controlError("schedule_control_owner_acceptance_head_invalid");
    }
    return null;
  }

  function listBusinessOwnerAcceptanceHistory(value = {}, { limit = 50, beforeVersion = null } = {}) {
    const identity = normalizeIdentity(value);
    const safeLimit = boundedInteger(limit, 1, 100, "limit");
    const before = beforeVersion === null ? null : positiveInteger(beforeVersion, "beforeVersion");
    const rows = database.prepare(`
      SELECT * FROM schedule_business_owner_acceptance_revisions
      WHERE tenant_scope = ? AND employee_id = ? AND schedule_id = ?
        AND (? IS NULL OR acceptance_version < ?)
      ORDER BY acceptance_version DESC
      LIMIT ?
    `).all(
      identity.tenantScope,
      identity.employeeId,
      identity.scheduleId,
      before,
      before,
      safeLimit + 1,
    );
    const head = readBusinessOwnerAcceptanceHeadRow(identity);
    if (!head) {
      if (rows.length > 0 || hasBusinessOwnerAcceptanceRevision(identity)) {
        throw controlError("schedule_control_owner_acceptance_head_invalid");
      }
      return [];
    }
    requireBusinessOwnerAcceptanceHeadRevision(identity, head);
    for (let index = 0; index + 1 < rows.length; index += 1) {
      requireBusinessOwnerAcceptanceHistoryLink(rows[index], rows[index + 1]);
    }
    if (rows.length > 0) {
      if (before === null) {
        if (rows[0].acceptance_version !== head.acceptance_version ||
          rows[0].revision_digest !== head.revision_digest) {
          throw controlError("schedule_control_owner_acceptance_history_invalid");
        }
      } else {
        const upperAnchor = database.prepare(`
          SELECT * FROM schedule_business_owner_acceptance_revisions
          WHERE tenant_scope = ? AND employee_id = ? AND schedule_id = ? AND acceptance_version >= ?
          ORDER BY acceptance_version ASC
          LIMIT 1
        `).get(identity.tenantScope, identity.employeeId, identity.scheduleId, before) || null;
        if (upperAnchor) {
          requireBusinessOwnerAcceptanceHistoryLink(upperAnchor, rows[0]);
        } else if (rows[0].acceptance_version !== head.acceptance_version ||
          rows[0].revision_digest !== head.revision_digest) {
          throw controlError("schedule_control_owner_acceptance_history_invalid");
        }
      }
      if (rows.length <= safeLimit) {
        const oldest = rows.at(-1);
        if (oldest.acceptance_version !== 1 || oldest.previous_revision_digest !== null) {
          throw controlError("schedule_control_owner_acceptance_history_invalid");
        }
      }
    }
    return rows.slice(0, safeLimit).map(rowToBusinessOwnerAcceptance);
  }

  function readBusinessOwnerAcceptanceHeadRow(identity) {
    return database.prepare(`
      SELECT * FROM schedule_business_owner_acceptance_heads
      WHERE tenant_scope = ? AND employee_id = ? AND schedule_id = ?
    `).get(identity.tenantScope, identity.employeeId, identity.scheduleId) || null;
  }

  function readBusinessOwnerAcceptanceRevisionRow(identity, acceptanceVersion) {
    return database.prepare(`
      SELECT * FROM schedule_business_owner_acceptance_revisions
      WHERE tenant_scope = ? AND employee_id = ? AND schedule_id = ? AND acceptance_version = ?
    `).get(identity.tenantScope, identity.employeeId, identity.scheduleId, acceptanceVersion) || null;
  }

  function hasBusinessOwnerAcceptanceRevision(identity) {
    return Boolean(database.prepare(`
      SELECT 1 FROM schedule_business_owner_acceptance_revisions
      WHERE tenant_scope = ? AND employee_id = ? AND schedule_id = ?
      LIMIT 1
    `).get(identity.tenantScope, identity.employeeId, identity.scheduleId));
  }

  function readBusinessOwnerAcceptanceHeadRevisionRow(identity) {
    return database.prepare(`
      SELECT
        head.acceptance_version AS head_acceptance_version,
        head.revision_digest AS head_revision_digest,
        revision.*
      FROM schedule_business_owner_acceptance_heads AS head
      LEFT JOIN schedule_business_owner_acceptance_revisions AS revision
        ON revision.tenant_scope = head.tenant_scope
        AND revision.employee_id = head.employee_id
        AND revision.schedule_id = head.schedule_id
        AND revision.acceptance_version = head.acceptance_version
      WHERE head.tenant_scope = ? AND head.employee_id = ? AND head.schedule_id = ?
    `).get(identity.tenantScope, identity.employeeId, identity.scheduleId) || null;
  }

  function requireBusinessOwnerAcceptanceHeadRevision(identity, head) {
    const joined = readBusinessOwnerAcceptanceHeadRevisionRow(identity);
    if (!joined || joined.head_acceptance_version !== head.acceptance_version ||
      joined.head_revision_digest !== head.revision_digest) {
      throw controlError("schedule_control_owner_acceptance_head_invalid");
    }
    return requireBusinessOwnerAcceptanceJoinedRevision(joined);
  }

  function requireBusinessOwnerAcceptanceJoinedRevision(row) {
    if (!row.revision_digest || row.head_acceptance_version !== row.acceptance_version ||
      row.head_revision_digest !== row.revision_digest) {
      throw controlError("schedule_control_owner_acceptance_head_invalid");
    }
    return rowToBusinessOwnerAcceptance(row);
  }

  function requireBusinessOwnerAcceptanceHistoryLink(newer, older) {
    rowToBusinessOwnerAcceptance(newer);
    rowToBusinessOwnerAcceptance(older);
    if (newer.acceptance_version !== older.acceptance_version + 1 ||
      newer.previous_revision_digest !== older.revision_digest) {
      throw controlError("schedule_control_owner_acceptance_history_invalid");
    }
  }

  return Object.freeze({
    activate,
    adoptRunResultReceiptForReconciliation,
    adapterKind: "sqlite_schedule_control_and_outbox",
    claimRunExecution,
    claimScannerLease,
    clearEmergencyStop,
    close: () => database.close(),
    commitCursorAndPrepareIntent,
    prepareManualIntent,
    contractVersion: SCHEDULE_CONTROL_REPOSITORY_CONTRACT_VERSION,
    deploymentScope: "single_center",
    distributedCoordination: false,
    emergencyStop,
    finalizeRunExecution,
    guardRunExecutionEffectDispatch,
    getRunResultReceipt,
    getActivationSnapshot,
    getBusinessOwnerAcceptance,
    getControl,
    getIntent,
    getRunExecution,
    getRunConfiguration,
    initializeRegisteredControl,
    listCancelOutbox,
    listActiveSnapshotControls,
    listBusinessOwnerAcceptanceHistory,
    listControlEvents,
    listIncompleteIntents,
    listRunIntents,
    markCancelDispatched,
    markReconcileRequired,
    markRunExecutionReconcileBlocked,
    markSubmitted,
    observeCancellationOutcome,
    observeExecutionTask,
    pause,
    prepareRunExecutionEffectDispatch,
    recordRunResultReceipt,
    recordBusinessOwnerAcceptanceV2,
    revalidateSubmittedIntent,
    rebindPreEffectRunExecution,
    releaseScannerLease,
    releaseRunExecution,
    resolveActiveActivationSnapshot,
    recordCancelDispatch,
    renewRunExecution,
    renewScannerLease,
    retire,
    summarizeRuns,
  });
}

function initializeDatabase(database) {
  database.exec(`
    PRAGMA busy_timeout = 5000;
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = FULL;
    CREATE TABLE IF NOT EXISTS schedule_control_schema (
      singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
      version INTEGER NOT NULL
    );
    INSERT INTO schedule_control_schema (singleton, version) VALUES (1, 7)
      ON CONFLICT(singleton) DO NOTHING;
    CREATE TABLE IF NOT EXISTS schedule_controls (
      tenant_scope TEXT NOT NULL,
      employee_id TEXT NOT NULL,
      schedule_id TEXT NOT NULL,
      control_version INTEGER NOT NULL CHECK (control_version > 0),
      activation_version INTEGER NOT NULL CHECK (activation_version >= 0),
      activation_state TEXT NOT NULL CHECK (activation_state IN ('registered', 'active', 'paused', 'retired')),
      activation_snapshot_id TEXT,
      activation_snapshot_digest TEXT,
      registration_version INTEGER NOT NULL CHECK (registration_version > 0),
      schedule_version TEXT NOT NULL,
      schedule_policy_digest TEXT NOT NULL,
      execution_contract_digest TEXT NOT NULL,
      max_concurrent_runs INTEGER CHECK (max_concurrent_runs IS NULL OR max_concurrent_runs BETWEEN 1 AND 100),
      overlap_window_minutes INTEGER CHECK (overlap_window_minutes IS NULL OR overlap_window_minutes BETWEEN 0 AND 1440),
      activated_at TEXT,
      cursor_after TEXT,
      next_scan_at TEXT,
      emergency_stop_active INTEGER NOT NULL DEFAULT 0 CHECK (emergency_stop_active IN (0, 1)),
      emergency_stop_version INTEGER NOT NULL DEFAULT 0 CHECK (emergency_stop_version >= 0),
      emergency_stop_reason_code TEXT,
      emergency_stopped_at TEXT,
      scanner_fencing_token INTEGER NOT NULL DEFAULT 0 CHECK (scanner_fencing_token >= 0),
      scanner_lease_id TEXT,
      scanner_owner_digest TEXT,
      scanner_lease_expires_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (tenant_scope, employee_id, schedule_id)
    );
    CREATE TABLE IF NOT EXISTS schedule_run_intents (
      run_id TEXT PRIMARY KEY,
      intent_version INTEGER NOT NULL CHECK (intent_version > 0),
      tenant_scope TEXT NOT NULL,
      employee_id TEXT NOT NULL,
      schedule_id TEXT NOT NULL,
      activation_version INTEGER NOT NULL CHECK (activation_version > 0),
      activation_snapshot_id TEXT,
      activation_snapshot_digest TEXT,
      schedule_version TEXT NOT NULL,
      schedule_policy_digest TEXT NOT NULL,
      execution_contract_digest TEXT NOT NULL,
      scheduled_for TEXT NOT NULL,
      expected_trigger_id TEXT NOT NULL,
      expected_execution_task_id TEXT NOT NULL,
      execution_task_id TEXT,
      intent_state TEXT NOT NULL CHECK (intent_state IN (
        'prepared', 'submitted', 'reconcile_required', 'skipped_overlap',
        'skipped_emergency_stop', 'cancel_requested', 'terminal_observed'
      )),
      overlap_outcome TEXT NOT NULL CHECK (overlap_outcome IN (
        'admitted', 'skipped_max_concurrency', 'skipped_overlap_window'
      )),
      scanner_fencing_token INTEGER NOT NULL CHECK (scanner_fencing_token > 0),
      observed_task_status TEXT,
      last_error_code TEXT,
      prepared_at TEXT NOT NULL,
      submitted_at TEXT,
      reconciled_at TEXT,
      terminal_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE (tenant_scope, employee_id, schedule_id, scheduled_for)
    );
    CREATE INDEX IF NOT EXISTS schedule_run_intents_reconcile_idx
      ON schedule_run_intents (tenant_scope, intent_state, scheduled_for);
    CREATE TABLE IF NOT EXISTS schedule_activation_snapshots (
      snapshot_id TEXT PRIMARY KEY,
      snapshot_version INTEGER NOT NULL CHECK (snapshot_version > 0),
      snapshot_digest TEXT NOT NULL,
      tenant_scope TEXT NOT NULL,
      employee_id TEXT NOT NULL,
      schedule_id TEXT NOT NULL,
      activation_version INTEGER NOT NULL CHECK (activation_version > 0),
      registration_version INTEGER NOT NULL CHECK (registration_version > 0),
      schedule_version TEXT NOT NULL,
      snapshot_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      UNIQUE (tenant_scope, employee_id, schedule_id, activation_version)
    );
    CREATE INDEX IF NOT EXISTS schedule_activation_snapshots_lookup_idx
      ON schedule_activation_snapshots (tenant_scope, employee_id, schedule_id, activation_version);
    CREATE TABLE IF NOT EXISTS schedule_run_executions (
      run_id TEXT PRIMARY KEY,
      execution_version INTEGER NOT NULL CHECK (execution_version > 0),
      tenant_scope TEXT NOT NULL,
      employee_id TEXT NOT NULL,
      schedule_id TEXT NOT NULL,
      execution_task_id TEXT NOT NULL UNIQUE,
      activation_version INTEGER NOT NULL CHECK (activation_version > 0),
      window_start TEXT NOT NULL,
      window_end TEXT NOT NULL,
      execution_state TEXT NOT NULL CHECK (execution_state IN (
        'active', 'cancel_requested', 'reconcile_blocked', 'released', 'skipped_admission'
      )),
      execution_phase TEXT NOT NULL CHECK (execution_phase IN ('pre_effect', 'effect_dispatch_prepared', 'legacy_unknown')),
      admission_outcome TEXT NOT NULL CHECK (admission_outcome IN (
        'admitted', 'skipped_max_concurrency', 'skipped_overlap_window'
      )),
      lease_id TEXT,
      owner_digest TEXT,
      fencing_token INTEGER NOT NULL CHECK (fencing_token >= 0),
      lease_expires_at TEXT,
      task_lease_id TEXT NOT NULL,
      task_owner_digest TEXT NOT NULL,
      task_fencing_token INTEGER NOT NULL CHECK (task_fencing_token > 0),
      task_lease_expires_at TEXT,
      observed_task_status TEXT,
      last_error_code TEXT,
      canonical_task_revision INTEGER CHECK (canonical_task_revision IS NULL OR canonical_task_revision > 0),
      canonical_task_status TEXT CHECK (canonical_task_status IS NULL OR canonical_task_status IN (
        'blocked', 'canceled', 'completed', 'failed', 'lost', 'rejected', 'timed_out'
      )),
      effect_state TEXT CHECK (effect_state IS NULL OR effect_state IN ('settled', 'reconcile_required')),
      effect_evidence_digest TEXT,
      claimed_at TEXT NOT NULL,
      reconcile_blocked_at TEXT,
      released_at TEXT,
      finalized_at TEXT,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS schedule_run_executions_admission_idx
      ON schedule_run_executions (tenant_scope, employee_id, schedule_id, execution_state, window_start, window_end);
    CREATE TABLE IF NOT EXISTS schedule_cancel_outbox (
      cancel_id TEXT PRIMARY KEY,
      outbox_version INTEGER NOT NULL CHECK (outbox_version > 0),
      tenant_scope TEXT NOT NULL,
      employee_id TEXT NOT NULL,
      schedule_id TEXT NOT NULL,
      run_id TEXT NOT NULL,
      execution_task_id TEXT NOT NULL,
      emergency_stop_version INTEGER NOT NULL CHECK (emergency_stop_version >= 0),
      activation_version INTEGER NOT NULL CHECK (activation_version >= 0),
      expected_trigger_id TEXT,
      reason_code TEXT NOT NULL,
      outbox_state TEXT NOT NULL CHECK (outbox_state IN ('pending', 'dispatched')),
      reconcile_state TEXT NOT NULL CHECK (reconcile_state IN ('pending', 'reconcile_required', 'settled')),
      canonical_task_revision INTEGER CHECK (canonical_task_revision IS NULL OR canonical_task_revision >= 0),
      canonical_task_status TEXT CHECK (canonical_task_status IS NULL OR canonical_task_status IN (
        'blocked', 'canceled', 'completed', 'failed', 'lost', 'rejected', 'timed_out', 'queued', 'running', 'waiting',
        'pre_canceled'
      )),
      effect_state TEXT CHECK (effect_state IS NULL OR effect_state IN ('safe_terminal', 'reconcile_required')),
      effect_evidence_digest TEXT,
      created_at TEXT NOT NULL,
      dispatched_at TEXT,
      reconciled_at TEXT,
      updated_at TEXT NOT NULL,
      UNIQUE (tenant_scope, execution_task_id, emergency_stop_version)
    );
    CREATE INDEX IF NOT EXISTS schedule_cancel_outbox_pending_idx
      ON schedule_cancel_outbox (tenant_scope, outbox_state, created_at);
    CREATE TABLE IF NOT EXISTS schedule_control_events (
      event_id TEXT PRIMARY KEY,
      tenant_scope TEXT NOT NULL,
      employee_id TEXT NOT NULL,
      schedule_id TEXT NOT NULL,
      control_version INTEGER NOT NULL CHECK (control_version > 0),
      event_type TEXT NOT NULL CHECK (event_type IN ('emergency_stop_engaged', 'emergency_stop_cleared')),
      reason_code TEXT NOT NULL,
      safe_reason TEXT NOT NULL,
      actor_principal_id TEXT NOT NULL,
      actor_display_name TEXT NOT NULL,
      actor_name_status TEXT NOT NULL CHECK (actor_name_status IN ('verified', 'unresolved')),
      actor_identity_source TEXT NOT NULL,
      actor_resolved_at TEXT,
      event_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS schedule_control_events_schedule_idx
      ON schedule_control_events (tenant_scope, employee_id, schedule_id, event_at DESC, event_id DESC);
  `);
  let schema = database.prepare("SELECT version FROM schedule_control_schema WHERE singleton = 1").get();
  if (schema?.version === 1) {
    database.exec(`
      BEGIN IMMEDIATE;
      ALTER TABLE schedule_controls ADD COLUMN max_concurrent_runs INTEGER;
      ALTER TABLE schedule_controls ADD COLUMN overlap_window_minutes INTEGER;
      UPDATE schedule_control_schema SET version = 2 WHERE singleton = 1;
      COMMIT;
    `);
    schema = { version: 2 };
  }
  if (schema?.version === 2) {
    database.exec(`
      BEGIN IMMEDIATE;
      ALTER TABLE schedule_controls RENAME TO schedule_controls_v2;
      CREATE TABLE schedule_controls (
        tenant_scope TEXT NOT NULL,
        employee_id TEXT NOT NULL,
        schedule_id TEXT NOT NULL,
        control_version INTEGER NOT NULL CHECK (control_version > 0),
        activation_version INTEGER NOT NULL CHECK (activation_version >= 0),
        activation_state TEXT NOT NULL CHECK (activation_state IN ('registered', 'active', 'paused', 'retired')),
        registration_version INTEGER NOT NULL CHECK (registration_version > 0),
        schedule_version TEXT NOT NULL,
        schedule_policy_digest TEXT NOT NULL,
        execution_contract_digest TEXT NOT NULL,
        max_concurrent_runs INTEGER CHECK (max_concurrent_runs IS NULL OR max_concurrent_runs BETWEEN 1 AND 100),
        overlap_window_minutes INTEGER CHECK (overlap_window_minutes IS NULL OR overlap_window_minutes BETWEEN 0 AND 1440),
        activated_at TEXT,
        cursor_after TEXT,
        next_scan_at TEXT,
        emergency_stop_active INTEGER NOT NULL DEFAULT 0 CHECK (emergency_stop_active IN (0, 1)),
        emergency_stop_version INTEGER NOT NULL DEFAULT 0 CHECK (emergency_stop_version >= 0),
        emergency_stop_reason_code TEXT,
        emergency_stopped_at TEXT,
        scanner_fencing_token INTEGER NOT NULL DEFAULT 0 CHECK (scanner_fencing_token >= 0),
        scanner_lease_id TEXT,
        scanner_owner_digest TEXT,
        scanner_lease_expires_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (tenant_scope, employee_id, schedule_id)
      );
      INSERT INTO schedule_controls (
        tenant_scope, employee_id, schedule_id,
        control_version, activation_version, activation_state,
        registration_version, schedule_version, schedule_policy_digest, execution_contract_digest,
        max_concurrent_runs, overlap_window_minutes,
        activated_at, cursor_after, next_scan_at,
        emergency_stop_active, emergency_stop_version, emergency_stop_reason_code, emergency_stopped_at,
        scanner_fencing_token, scanner_lease_id, scanner_owner_digest, scanner_lease_expires_at,
        created_at, updated_at
      )
      SELECT
        tenant_scope, employee_id, schedule_id,
        control_version, activation_version, activation_state,
        registration_version, schedule_version, schedule_policy_digest, execution_contract_digest,
        max_concurrent_runs, overlap_window_minutes,
        activated_at, cursor_after, next_scan_at,
        emergency_stop_active, emergency_stop_version, emergency_stop_reason_code, emergency_stopped_at,
        scanner_fencing_token, scanner_lease_id, scanner_owner_digest, scanner_lease_expires_at,
        created_at, updated_at
      FROM schedule_controls_v2;
      DROP TABLE schedule_controls_v2;
      UPDATE schedule_control_schema SET version = 3 WHERE singleton = 1;
      COMMIT;
    `);
    schema = { version: 3 };
  }
  if (schema?.version === 3) {
    database.exec(`
      BEGIN IMMEDIATE;
      ALTER TABLE schedule_cancel_outbox RENAME TO schedule_cancel_outbox_v3;
      DROP INDEX IF EXISTS schedule_cancel_outbox_pending_idx;
      CREATE TABLE schedule_cancel_outbox (
        cancel_id TEXT PRIMARY KEY,
        outbox_version INTEGER NOT NULL CHECK (outbox_version > 0),
        tenant_scope TEXT NOT NULL,
        employee_id TEXT NOT NULL,
        schedule_id TEXT NOT NULL,
        run_id TEXT NOT NULL,
        execution_task_id TEXT NOT NULL,
        emergency_stop_version INTEGER NOT NULL CHECK (emergency_stop_version >= 0),
        activation_version INTEGER NOT NULL CHECK (activation_version >= 0),
        expected_trigger_id TEXT,
        reason_code TEXT NOT NULL,
        outbox_state TEXT NOT NULL CHECK (outbox_state IN ('pending', 'dispatched')),
        reconcile_state TEXT NOT NULL CHECK (reconcile_state IN ('pending', 'reconcile_required', 'settled')),
        canonical_task_revision INTEGER CHECK (canonical_task_revision IS NULL OR canonical_task_revision >= 0),
        canonical_task_status TEXT CHECK (canonical_task_status IS NULL OR canonical_task_status IN (
          'blocked', 'canceled', 'completed', 'failed', 'lost', 'rejected', 'timed_out', 'queued', 'running', 'waiting',
          'pre_canceled'
        )),
        effect_state TEXT CHECK (effect_state IS NULL OR effect_state IN ('safe_terminal', 'reconcile_required')),
        effect_evidence_digest TEXT,
        created_at TEXT NOT NULL,
        dispatched_at TEXT,
        reconciled_at TEXT,
        updated_at TEXT NOT NULL,
        UNIQUE (tenant_scope, execution_task_id, emergency_stop_version)
      );
      INSERT INTO schedule_cancel_outbox (
        cancel_id, outbox_version, tenant_scope, employee_id, schedule_id,
        run_id, execution_task_id, emergency_stop_version, activation_version,
        expected_trigger_id, reason_code, outbox_state, reconcile_state,
        canonical_task_revision, canonical_task_status, effect_state, effect_evidence_digest,
        created_at, dispatched_at, reconciled_at, updated_at
      )
      SELECT
        legacy.cancel_id, legacy.outbox_version, legacy.tenant_scope, legacy.employee_id, legacy.schedule_id,
        legacy.run_id, legacy.execution_task_id, 0, COALESCE(intent.activation_version, 0),
        intent.expected_trigger_id, legacy.reason_code, legacy.outbox_state, 'reconcile_required',
        NULL, NULL, 'reconcile_required', NULL,
        legacy.created_at, legacy.dispatched_at, legacy.updated_at, legacy.updated_at
      FROM schedule_cancel_outbox_v3 AS legacy
      LEFT JOIN schedule_run_intents AS intent
        ON intent.tenant_scope = legacy.tenant_scope AND intent.run_id = legacy.run_id;
      DROP TABLE schedule_cancel_outbox_v3;
      CREATE INDEX schedule_cancel_outbox_pending_idx
        ON schedule_cancel_outbox (tenant_scope, outbox_state, created_at);
      CREATE INDEX schedule_cancel_outbox_reconcile_idx
        ON schedule_cancel_outbox (tenant_scope, reconcile_state, updated_at);
      UPDATE schedule_control_schema SET version = 4 WHERE singleton = 1;
      COMMIT;
    `);
    schema = { version: 4 };
  }
  if (schema?.version === 4) {
    const runExecutionColumns = new Set(
      database.prepare("PRAGMA table_info(schedule_run_executions)").all().map((column) => column.name),
    );
    const v5Columns = [
      "execution_phase",
      "canonical_task_revision",
      "canonical_task_status",
      "effect_state",
      "effect_evidence_digest",
      "finalized_at",
    ];
    const presentV5Columns = v5Columns.filter((column) => runExecutionColumns.has(column));
    if (presentV5Columns.length === 0) {
      database.exec(`
        BEGIN IMMEDIATE;
        ALTER TABLE schedule_run_executions
          ADD COLUMN execution_phase TEXT NOT NULL DEFAULT 'legacy_unknown'
            CHECK (execution_phase IN ('pre_effect', 'effect_dispatch_prepared', 'legacy_unknown'));
        ALTER TABLE schedule_run_executions
          ADD COLUMN canonical_task_revision INTEGER
            CHECK (canonical_task_revision IS NULL OR canonical_task_revision > 0);
        ALTER TABLE schedule_run_executions
          ADD COLUMN canonical_task_status TEXT
            CHECK (canonical_task_status IS NULL OR canonical_task_status IN (
              'blocked', 'canceled', 'completed', 'failed', 'lost', 'rejected', 'timed_out'
            ));
        ALTER TABLE schedule_run_executions
          ADD COLUMN effect_state TEXT
            CHECK (effect_state IS NULL OR effect_state IN ('settled', 'reconcile_required'));
        ALTER TABLE schedule_run_executions ADD COLUMN effect_evidence_digest TEXT;
        ALTER TABLE schedule_run_executions ADD COLUMN finalized_at TEXT;
        UPDATE schedule_run_executions
          SET execution_phase = 'effect_dispatch_prepared'
          WHERE execution_state IN ('active', 'cancel_requested', 'reconcile_blocked');
        UPDATE schedule_control_schema SET version = 5 WHERE singleton = 1;
        COMMIT;
      `);
    } else if (presentV5Columns.length === v5Columns.length) {
      database.prepare("UPDATE schedule_control_schema SET version = 5 WHERE singleton = 1 AND version = 4").run();
    } else {
      throw new TypeError("incomplete schedule control SQLite v5 migration");
    }
    schema = { version: 5 };
  }
  if (schema?.version === 5) {
    const runExecutionColumns = new Set(
      database.prepare("PRAGMA table_info(schedule_run_executions)").all().map((column) => column.name),
    );
    if (!runExecutionColumns.has("task_lease_expires_at")) {
      database.exec(`
        BEGIN IMMEDIATE;
        ALTER TABLE schedule_run_executions ADD COLUMN task_lease_expires_at TEXT;
        UPDATE schedule_control_schema SET version = 6 WHERE singleton = 1;
        COMMIT;
      `);
    } else {
      database.prepare("UPDATE schedule_control_schema SET version = 6 WHERE singleton = 1 AND version = 5").run();
    }
    schema = { version: 6 };
  }
  if (schema?.version === 6) {
    const controlColumns = new Set(
      database.prepare("PRAGMA table_info(schedule_controls)").all().map((column) => column.name),
    );
    const intentColumns = new Set(
      database.prepare("PRAGMA table_info(schedule_run_intents)").all().map((column) => column.name),
    );
    const controlSnapshotColumns = [
      controlColumns.has("activation_snapshot_id"),
      controlColumns.has("activation_snapshot_digest"),
    ];
    const intentSnapshotColumns = [
      intentColumns.has("activation_snapshot_id"),
      intentColumns.has("activation_snapshot_digest"),
    ];
    if (controlSnapshotColumns.filter(Boolean).length === 1 || intentSnapshotColumns.filter(Boolean).length === 1) {
      throw new TypeError("incomplete schedule control SQLite v7 migration");
    }
    const migrationStatements = [
      ...(controlSnapshotColumns[0] ? [] : [
        "ALTER TABLE schedule_controls ADD COLUMN activation_snapshot_id TEXT",
        "ALTER TABLE schedule_controls ADD COLUMN activation_snapshot_digest TEXT",
      ]),
      ...(intentSnapshotColumns[0] ? [] : [
        "ALTER TABLE schedule_run_intents ADD COLUMN activation_snapshot_id TEXT",
        "ALTER TABLE schedule_run_intents ADD COLUMN activation_snapshot_digest TEXT",
      ]),
    ];
    database.exec(`
        BEGIN IMMEDIATE;
        ${migrationStatements.map((statement) => `${statement};`).join("\n        ")}
        UPDATE schedule_controls
          SET activation_state = 'paused',
              scanner_fencing_token = scanner_fencing_token + 1,
              scanner_lease_id = NULL,
              scanner_owner_digest = NULL,
              scanner_lease_expires_at = NULL,
              next_scan_at = NULL
          WHERE activation_state = 'active';
        UPDATE schedule_run_intents
          SET intent_version = intent_version + 1,
              intent_state = 'reconcile_required',
              last_error_code = 'schedule_control_activation_snapshot_missing'
          WHERE intent_state IN ('prepared', 'submitted');
        UPDATE schedule_run_executions
          SET execution_version = execution_version + 1,
              execution_state = 'reconcile_blocked',
              last_error_code = 'schedule_control_activation_snapshot_missing',
              fencing_token = fencing_token + 1,
              lease_id = NULL,
              owner_digest = NULL,
              lease_expires_at = NULL,
              task_lease_expires_at = NULL,
              reconcile_blocked_at = COALESCE(reconcile_blocked_at, updated_at)
          WHERE execution_state IN ('active', 'cancel_requested');
        UPDATE schedule_control_schema SET version = 7 WHERE singleton = 1;
        COMMIT;
      `);
    schema = { version: 7 };
  }
  if (schema?.version === 7) {
    const acceptanceTables = database.prepare(`
      SELECT name FROM sqlite_master
      WHERE type = 'table' AND name IN (
        'schedule_business_owner_acceptance_heads',
        'schedule_business_owner_acceptance_revisions'
      )
    `).all();
    if (acceptanceTables.length !== 0) {
      throw new TypeError("unsafe preexisting schedule control SQLite v8 acceptance schema");
    }
    database.exec(`
      BEGIN IMMEDIATE;
      ${BUSINESS_OWNER_ACCEPTANCE_SCHEMA_SQL}
      UPDATE schedule_control_schema SET version = 8 WHERE singleton = 1;
      COMMIT;
    `);
    schema = { version: 8 };
  }
  if (schema?.version === 8) {
    validateBusinessOwnerAcceptanceSchema(database);
    const preexisting = database.prepare(`
      SELECT type FROM sqlite_master WHERE name = 'schedule_run_result_receipts'
    `).get();
    if (preexisting) throw new TypeError("unsafe preexisting schedule control SQLite v9 result receipt schema");
    database.exec(`
      BEGIN IMMEDIATE;
      ${RUN_RESULT_RECEIPT_SCHEMA_SQL}
      UPDATE schedule_control_schema SET version = 9 WHERE singleton = 1 AND version = 8;
      COMMIT;
    `);
    schema = { version: 9 };
  }
  if (schema?.version === 9) {
    validateBusinessOwnerAcceptanceSchema(database);
    validateRunResultReceiptSchema(database);
    const executionColumns = new Set(
      database.prepare("PRAGMA table_info(schedule_run_executions)").all().map((column) => column.name),
    );
    const resultReceiptColumns = [
      "result_receipt_requirement",
      "result_receipt_digest",
      "canonical_terminal_evidence_digest",
    ];
    const presentColumns = resultReceiptColumns.filter((column) => executionColumns.has(column));
    if (presentColumns.length === 0) {
      database.exec(`
        BEGIN IMMEDIATE;
        ALTER TABLE schedule_run_executions
          ADD COLUMN result_receipt_requirement TEXT NOT NULL DEFAULT 'legacy_unknown'
            CHECK (result_receipt_requirement IN ('required', 'legacy_unknown', 'legacy_not_required'));
        ALTER TABLE schedule_run_executions ADD COLUMN result_receipt_digest TEXT;
        ALTER TABLE schedule_run_executions ADD COLUMN canonical_terminal_evidence_digest TEXT;
        UPDATE schedule_run_executions
          SET result_receipt_requirement = 'legacy_not_required'
          WHERE execution_state IN ('released', 'skipped_admission');
        UPDATE schedule_control_schema SET version = 10 WHERE singleton = 1 AND version = 9;
        COMMIT;
      `);
    } else {
      throw new TypeError("unsafe preexisting schedule control SQLite v10 result receipt requirement schema");
    }
    schema = { version: 10 };
  }
  if (schema?.version === 10) {
    const revisionColumns = new Set(
      database.prepare("PRAGMA table_info(schedule_business_owner_acceptance_revisions)")
        .all().map((column) => column.name),
    );
    if (revisionColumns.has("acceptance_contract_version")) {
      throw new TypeError("unsafe preexisting schedule control SQLite v11 acceptance contract schema");
    }
    validateBusinessOwnerAcceptanceSchema(database);
    database.exec(`
      BEGIN IMMEDIATE;
      ALTER TABLE schedule_business_owner_acceptance_revisions
        ADD COLUMN acceptance_contract_version TEXT NOT NULL
          DEFAULT '${SCHEDULE_BUSINESS_OWNER_ACCEPTANCE_CONTRACT_VERSION}'
          CHECK (acceptance_contract_version IN (
            '${SCHEDULE_BUSINESS_OWNER_ACCEPTANCE_CONTRACT_VERSION}',
            '${SCHEDULE_BUSINESS_OWNER_ACCEPTANCE_CONTRACT_VERSION_V2}'
          ));
      UPDATE schedule_control_schema SET version = 11 WHERE singleton = 1 AND version = 10;
      COMMIT;
    `);
    schema = { version: 11 };
  }
  if (schema?.version === 11) {
    const snapshotColumns = new Set(
      database.prepare("PRAGMA table_info(schedule_activation_snapshots)").all().map((column) => column.name),
    );
    const v12Columns = [
      "snapshot_contract_version", "acceptance_candidate_digest", "acceptance_revision_digest",
      "acceptance_proof_digest", "processing_authority_digest",
    ];
    if (v12Columns.some((column) => snapshotColumns.has(column))) {
      throw new TypeError("unsafe preexisting schedule control SQLite v12 activation snapshot schema");
    }
    validateActivationSnapshotSchema(database, { contractVersioned: false });
    database.exec(`
      BEGIN IMMEDIATE;
      UPDATE schedule_controls
        SET control_version = control_version + 1,
            activation_state = 'paused',
            scanner_fencing_token = scanner_fencing_token + 1,
            scanner_lease_id = NULL,
            scanner_owner_digest = NULL,
            scanner_lease_expires_at = NULL,
            next_scan_at = NULL,
            updated_at = COALESCE(updated_at, activated_at)
        WHERE activation_state = 'active';
      UPDATE schedule_run_intents
        SET intent_version = intent_version + 1,
            intent_state = 'reconcile_required',
            last_error_code = 'schedule_control_activation_snapshot_v2_required',
            reconciled_at = COALESCE(reconciled_at, updated_at),
            updated_at = COALESCE(updated_at, prepared_at)
        WHERE intent_state IN ('prepared', 'submitted');
      UPDATE schedule_run_executions
        SET execution_version = execution_version + 1,
            execution_state = 'reconcile_blocked',
            last_error_code = 'schedule_control_activation_snapshot_v2_required',
            fencing_token = fencing_token + 1,
            lease_id = NULL,
            owner_digest = NULL,
            lease_expires_at = NULL,
            task_lease_expires_at = NULL,
            reconcile_blocked_at = COALESCE(reconcile_blocked_at, updated_at)
        WHERE execution_state IN ('active', 'cancel_requested');
      DROP INDEX schedule_activation_snapshots_lookup_idx;
      ALTER TABLE schedule_activation_snapshots RENAME TO schedule_activation_snapshots_v11;
      ${ACTIVATION_SNAPSHOT_SCHEMA_V12_SQL}
      INSERT INTO schedule_activation_snapshots (
        snapshot_id, snapshot_version, snapshot_digest,
        tenant_scope, employee_id, schedule_id, activation_version,
        registration_version, schedule_version, snapshot_json, created_at,
        snapshot_contract_version, acceptance_candidate_digest,
        acceptance_revision_digest, acceptance_proof_digest, processing_authority_digest
      )
      SELECT
        snapshot_id, snapshot_version, snapshot_digest,
        tenant_scope, employee_id, schedule_id, activation_version,
        registration_version, schedule_version, snapshot_json, created_at,
        '${SCHEDULE_ACTIVATION_SNAPSHOT_CONTRACT_VERSION}', NULL, NULL, NULL, NULL
      FROM schedule_activation_snapshots_v11;
      DROP TABLE schedule_activation_snapshots_v11;
      UPDATE schedule_control_schema SET version = 12 WHERE singleton = 1 AND version = 11;
      COMMIT;
    `);
    schema = { version: 12 };
  }
  if (schema?.version === 12) {
    validateActivationSnapshotSchema(database, { contractVersioned: true, agentProfile: false });
    if (database.prepare("SELECT name FROM sqlite_master WHERE name = 'schedule_activation_snapshots_v12'").get()) {
      throw new TypeError("unsafe preexisting schedule control SQLite v13 migration table");
    }
    transaction(database, () => {
      database.exec(`
        DROP INDEX schedule_activation_snapshots_lookup_idx;
        ALTER TABLE schedule_activation_snapshots RENAME TO schedule_activation_snapshots_v12;
        ${ACTIVATION_SNAPSHOT_SCHEMA_V13_SQL}
        INSERT INTO schedule_activation_snapshots SELECT * FROM schedule_activation_snapshots_v12;
        DROP TABLE schedule_activation_snapshots_v12;
        UPDATE schedule_control_schema SET version = 13 WHERE singleton = 1 AND version = 12;
      `);
      validateActivationSnapshotSchema(database, { contractVersioned: true, agentProfile: true });
      if (database.prepare("PRAGMA foreign_key_check").all().length) {
        throw new TypeError("schedule control SQLite v13 foreign key check failed");
      }
    });
    schema = { version: 13 };
  }
  if (schema?.version === 13) {
    if (database.prepare("SELECT 1 FROM sqlite_master WHERE name='schedule_run_configurations'").get()) {
      throw new TypeError("unsafe preexisting schedule control SQLite v14 configuration table");
    }
    transaction(database, () => {
      database.exec(SCHEDULE_RUN_CONFIGURATION_TABLE_SQL);
      database.exec("UPDATE schedule_control_schema SET version=14 WHERE singleton=1 AND version=13");
    });
    schema = { version: 14 };
  }
  if (schema?.version === 14) {
    const columns = database.prepare("PRAGMA table_info(schedule_run_intents)").all();
    if (columns.some(c => c.name === "manual_request_digest")) throw new TypeError("unsafe preexisting schedule manual schema");
    const sql = database.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='schedule_run_intents'").get().sql;
    const indexes = database.prepare("SELECT sql FROM sqlite_master WHERE type='index' AND tbl_name='schedule_run_intents' AND sql IS NOT NULL").all();
    const updated = sql.replace(/scanner_fencing_token INTEGER NOT NULL CHECK \(scanner_fencing_token > 0\)/, "scanner_fencing_token INTEGER CHECK (scanner_fencing_token > 0)")
      .replace("UNIQUE (tenant_scope, employee_id, schedule_id, scheduled_for)", "manual_request_digest TEXT, CHECK ((manual_request_digest IS NULL AND scanner_fencing_token IS NOT NULL) OR (manual_request_digest IS NOT NULL AND scanner_fencing_token IS NULL))");
    if (updated === sql || updated.includes("UNIQUE (tenant_scope, employee_id, schedule_id, scheduled_for)")) throw new TypeError("unsupported schedule intent migration shape");
    transaction(database, () => {
      database.exec("ALTER TABLE schedule_run_intents RENAME TO schedule_run_intents_v14");
      database.exec(updated);
      const names = columns.map(c => c.name).join(",");
      database.exec(`INSERT INTO schedule_run_intents (${names}) SELECT ${names} FROM schedule_run_intents_v14`);
      database.exec("DROP TABLE schedule_run_intents_v14");
      for (const index of indexes) database.exec(index.sql);
      database.exec("CREATE UNIQUE INDEX schedule_run_intents_cron_idx ON schedule_run_intents (tenant_scope,employee_id,schedule_id,scheduled_for) WHERE manual_request_digest IS NULL");
      database.exec("CREATE UNIQUE INDEX schedule_run_intents_manual_idx ON schedule_run_intents (tenant_scope,employee_id,schedule_id,manual_request_digest) WHERE manual_request_digest IS NOT NULL");
      database.exec("UPDATE schedule_control_schema SET version=15 WHERE singleton=1 AND version=14");
    });
    schema = { version: 15 };
  }
  if (schema?.version !== SCHEMA_VERSION) throw new TypeError("unsupported schedule control SQLite schema version");
  if (normalizeSchemaSql(database.prepare("SELECT sql FROM sqlite_master WHERE name='schedule_run_configurations'").get()?.sql) !==
    normalizeSchemaSql(SCHEDULE_RUN_CONFIGURATION_TABLE_SQL)) throw new TypeError("incomplete schedule control SQLite v14 configuration table");
  if (database.prepare("SELECT 1 FROM sqlite_master WHERE type='trigger' AND tbl_name='schedule_run_configurations'").get()) {
    throw new TypeError("unexpected schedule run configuration trigger");
  }
  const currentRunExecutionColumns = new Set(
    database.prepare("PRAGMA table_info(schedule_run_executions)").all().map((column) => column.name),
  );
  if (!currentRunExecutionColumns.has("task_lease_expires_at")) {
    throw new TypeError("incomplete schedule control SQLite v6 migration");
  }
  const resultReceiptColumns = [
    "result_receipt_requirement",
    "result_receipt_digest",
    "canonical_terminal_evidence_digest",
  ];
  if (!resultReceiptColumns.every((column) => currentRunExecutionColumns.has(column))) {
    throw new TypeError("incomplete schedule control SQLite v10 migration");
  }
  const executionTableSql = normalizeSchemaSql(database.prepare(`
    SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'schedule_run_executions'
  `).get()?.sql).toLowerCase();
  if (!/check \( ?result_receipt_requirement in \('required', 'legacy_unknown', 'legacy_not_required'\) ?\)/
    .test(executionTableSql)) {
    throw new TypeError("incomplete schedule control SQLite v10 migration");
  }
  const currentControlColumns = new Set(
    database.prepare("PRAGMA table_info(schedule_controls)").all().map((column) => column.name),
  );
  const currentIntentColumns = new Set(
    database.prepare("PRAGMA table_info(schedule_run_intents)").all().map((column) => column.name),
  );
  if (!currentControlColumns.has("activation_snapshot_id") ||
    !currentControlColumns.has("activation_snapshot_digest") ||
    !currentIntentColumns.has("activation_snapshot_id") ||
    !currentIntentColumns.has("activation_snapshot_digest")) {
    throw new TypeError("incomplete schedule control SQLite v7 migration");
  }
  validateBusinessOwnerAcceptanceSchema(database, { includeContractVersion: true });
  validateActivationSnapshotSchema(database, { contractVersioned: true });
  validateRunResultReceiptSchema(database);
  database.exec(`
    CREATE INDEX IF NOT EXISTS schedule_cancel_outbox_reconcile_idx
      ON schedule_cancel_outbox (tenant_scope, reconcile_state, updated_at);
  `);
}

function validateRunResultReceiptSchema(database) {
  const table = database.prepare(`
    SELECT type, sql FROM sqlite_master WHERE name = 'schedule_run_result_receipts'
  `).get();
  const expectedSql = RUN_RESULT_RECEIPT_SCHEMA_SQL.match(
    /CREATE TABLE schedule_run_result_receipts \([\s\S]*?\n  \);/,
  )?.[0];
  if (table?.type !== "table" || normalizeSchemaSql(table.sql) !== normalizeSchemaSql(expectedSql)) {
    throw new TypeError("incomplete schedule control SQLite v9 migration");
  }
  const columns = database.prepare("PRAGMA table_info(schedule_run_result_receipts)").all().map((column) => [
    column.name,
    String(column.type || "").toUpperCase(),
    column.notnull,
    column.pk,
  ]);
  const expectedColumns = [
    ["tenant_scope", "TEXT", 1, 1],
    ["run_id", "TEXT", 1, 2],
    ["employee_id", "TEXT", 1, 0],
    ["schedule_id", "TEXT", 1, 0],
    ["receipt_version", "INTEGER", 1, 0],
    ["result_receipt_digest", "TEXT", 1, 0],
    ["base_intent_version", "INTEGER", 1, 0],
    ["base_execution_version", "INTEGER", 1, 0],
    ["execution_task_id", "TEXT", 1, 0],
    ["activation_snapshot_id", "TEXT", 1, 0],
    ["activation_snapshot_digest", "TEXT", 1, 0],
    ["lease_id", "TEXT", 1, 0],
    ["owner_digest", "TEXT", 1, 0],
    ["fencing_token", "INTEGER", 1, 0],
    ["task_lease_id", "TEXT", 1, 0],
    ["task_owner_digest", "TEXT", 1, 0],
    ["task_fencing_token", "INTEGER", 1, 0],
    ["lease_binding_digest", "TEXT", 1, 0],
    ["operation_receipt_evidence_digest", "TEXT", 1, 0],
    ["receipt_effect_state", "TEXT", 1, 0],
    ["outcome", "TEXT", 1, 0],
    ["result_evidence_digest", "TEXT", 0, 0],
    ["recorded_at", "TEXT", 1, 0],
  ];
  if (!isDeepStrictEqual(columns, expectedColumns)) {
    throw new TypeError("incomplete schedule control SQLite v9 migration");
  }
  const indexes = database.prepare("PRAGMA index_list(schedule_run_result_receipts)").all().map((index) => ({
    origin: index.origin,
    unique: index.unique,
    columns: database.prepare(`PRAGMA index_info(${index.name})`).all()
      .sort((left, right) => left.seqno - right.seqno)
      .map((column) => column.name),
  })).toSorted((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
  const expectedIndexes = [
    { origin: "pk", unique: 1, columns: ["tenant_scope", "run_id"] },
    { origin: "u", unique: 1, columns: ["tenant_scope", "execution_task_id"] },
    { origin: "u", unique: 1, columns: ["tenant_scope", "result_receipt_digest"] },
  ].toSorted((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
  const triggers = database.prepare(`
    SELECT count(*) AS count FROM sqlite_master
    WHERE type = 'trigger' AND tbl_name = 'schedule_run_result_receipts'
  `).get().count;
  if (!isDeepStrictEqual(indexes, expectedIndexes) || triggers !== 0) {
    throw new TypeError("incomplete schedule control SQLite v9 migration");
  }
}

function validateActivationSnapshotSchema(database, { contractVersioned, agentProfile = true }) {
  const table = database.prepare(`
    SELECT type, sql FROM sqlite_master WHERE name = 'schedule_activation_snapshots'
  `).get();
  if (table?.type !== "table") throw new TypeError("incomplete schedule control SQLite activation snapshot schema");
  const actualColumns = database.prepare("PRAGMA table_info(schedule_activation_snapshots)").all().map((column) => [
    column.name,
    String(column.type || "").toUpperCase(),
    column.notnull,
    column.pk,
  ]);
  const expectedColumns = [
    ["snapshot_id", "TEXT", 0, 1],
    ["snapshot_version", "INTEGER", 1, 0],
    ["snapshot_digest", "TEXT", 1, 0],
    ["tenant_scope", "TEXT", 1, 0],
    ["employee_id", "TEXT", 1, 0],
    ["schedule_id", "TEXT", 1, 0],
    ["activation_version", "INTEGER", 1, 0],
    ["registration_version", "INTEGER", 1, 0],
    ["schedule_version", "TEXT", 1, 0],
    ["snapshot_json", "TEXT", 1, 0],
    ["created_at", "TEXT", 1, 0],
    ...(contractVersioned ? [
      ["snapshot_contract_version", "TEXT", 1, 0],
      ["acceptance_candidate_digest", "TEXT", 0, 0],
      ["acceptance_revision_digest", "TEXT", 0, 0],
      ["acceptance_proof_digest", "TEXT", 0, 0],
      ["processing_authority_digest", "TEXT", 0, 0],
    ] : []),
  ];
  if (!isDeepStrictEqual(actualColumns, expectedColumns)) {
    throw new TypeError("incomplete schedule control SQLite activation snapshot schema");
  }
  if (contractVersioned) {
    const expectedTableSql = (agentProfile ? ACTIVATION_SNAPSHOT_SCHEMA_V13_SQL : ACTIVATION_SNAPSHOT_SCHEMA_V12_SQL).match(
      /CREATE TABLE schedule_activation_snapshots \([\s\S]*?\n  \);/,
    )?.[0];
    if (normalizeSchemaSql(table.sql) !== normalizeSchemaSql(expectedTableSql)) {
      throw new TypeError("incomplete schedule control SQLite v12 activation snapshot schema");
    }
  }
  const indexes = database.prepare("PRAGMA index_list(schedule_activation_snapshots)").all().map((index) => ({
    origin: index.origin,
    unique: index.unique,
    columns: database.prepare(`PRAGMA index_info(${index.name})`).all()
      .sort((left, right) => left.seqno - right.seqno)
      .map((column) => column.name),
  })).toSorted((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
  const expectedIndexes = [
    { origin: "c", unique: 0, columns: ["tenant_scope", "employee_id", "schedule_id", "activation_version"] },
    { origin: "pk", unique: 1, columns: ["snapshot_id"] },
    { origin: "u", unique: 1, columns: ["tenant_scope", "employee_id", "schedule_id", "activation_version"] },
  ].toSorted((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
  const triggers = database.prepare(`
    SELECT count(*) AS count FROM sqlite_master
    WHERE type = 'trigger' AND tbl_name = 'schedule_activation_snapshots'
  `).get().count;
  if (!isDeepStrictEqual(indexes, expectedIndexes) || triggers !== 0) {
    throw new TypeError("incomplete schedule control SQLite activation snapshot schema");
  }
}

function normalizeSchemaSql(value) {
  return String(value || "").replace(/\s+/g, " ").replace(/;$/, "").trim();
}

function validateBusinessOwnerAcceptanceSchema(database, { includeContractVersion = false } = {}) {
  requireExactAcceptanceTable(database, "schedule_business_owner_acceptance_heads", [
    ["tenant_scope", "TEXT", 1, 1],
    ["employee_id", "TEXT", 1, 2],
    ["schedule_id", "TEXT", 1, 3],
    ["acceptance_version", "INTEGER", 1, 0],
    ["revision_digest", "TEXT", 1, 0],
    ["updated_at", "TEXT", 1, 0],
  ]);
  requireExactAcceptanceTable(database, "schedule_business_owner_acceptance_revisions", [
    ["tenant_scope", "TEXT", 1, 1],
    ["employee_id", "TEXT", 1, 2],
    ["schedule_id", "TEXT", 1, 3],
    ["acceptance_version", "INTEGER", 1, 4],
    ["revision_digest", "TEXT", 1, 0],
    ["previous_revision_digest", "TEXT", 0, 0],
    ["decision", "TEXT", 1, 0],
    ["candidate_digest", "TEXT", 1, 0],
    ["revision_json", "TEXT", 1, 0],
    ["decided_at", "TEXT", 1, 0],
    ...(includeContractVersion ? [["acceptance_contract_version", "TEXT", 1, 0]] : []),
  ]);
  if (includeContractVersion) {
    const contractColumn = database.prepare("PRAGMA table_info(schedule_business_owner_acceptance_revisions)")
      .all().find((column) => column.name === "acceptance_contract_version");
    const tableSql = normalizeSchemaSql(database.prepare(`
      SELECT sql FROM sqlite_master
      WHERE type = 'table' AND name = 'schedule_business_owner_acceptance_revisions'
    `).get()?.sql);
    const expectedCheck = normalizeSchemaSql(`CHECK (acceptance_contract_version IN (
      '${SCHEDULE_BUSINESS_OWNER_ACCEPTANCE_CONTRACT_VERSION}',
      '${SCHEDULE_BUSINESS_OWNER_ACCEPTANCE_CONTRACT_VERSION_V2}'
    ))`);
    if (contractColumn?.dflt_value !== `'${SCHEDULE_BUSINESS_OWNER_ACCEPTANCE_CONTRACT_VERSION}'` ||
      !tableSql.includes(expectedCheck)) {
      throw new TypeError("incomplete schedule control SQLite v11 acceptance contract migration");
    }
  }
  requireExactAcceptanceIndexes(database, "schedule_business_owner_acceptance_heads", [
    { origin: "pk", unique: 1, columns: ["tenant_scope", "employee_id", "schedule_id"] },
  ]);
  requireExactAcceptanceIndexes(database, "schedule_business_owner_acceptance_revisions", [
    {
      name: "schedule_business_owner_acceptance_history_idx",
      origin: "c",
      unique: 0,
      columns: ["tenant_scope", "employee_id", "schedule_id", "acceptance_version"],
      descending: [false, false, false, true],
    },
    { origin: "u", unique: 1, columns: ["tenant_scope", "revision_digest"] },
    {
      origin: "pk",
      unique: 1,
      columns: ["tenant_scope", "employee_id", "schedule_id", "acceptance_version"],
    },
  ]);
}

function requireExactAcceptanceTable(database, tableName, expectedColumns) {
  const table = database.prepare("SELECT type FROM sqlite_master WHERE name = ?").get(tableName);
  if (table?.type !== "table") throw new TypeError("incomplete schedule control SQLite v8 migration");
  const actual = database.prepare(`PRAGMA table_info(${tableName})`).all().map((column) => [
    column.name,
    String(column.type || "").toUpperCase(),
    column.notnull,
    column.pk,
  ]);
  if (!isDeepStrictEqual(actual, expectedColumns)) {
    throw new TypeError("incomplete schedule control SQLite v8 migration");
  }
}

function requireExactAcceptanceIndexes(database, tableName, expectedIndexes) {
  const actualIndexes = database.prepare(`PRAGMA index_list(${tableName})`).all().map((index) => {
    const columns = database.prepare(`PRAGMA index_info(${index.name})`).all()
      .sort((left, right) => left.seqno - right.seqno)
      .map((column) => column.name);
    const descending = database.prepare(`PRAGMA index_xinfo(${index.name})`).all()
      .filter((column) => column.key === 1)
      .sort((left, right) => left.seqno - right.seqno)
      .map((column) => column.desc === 1);
    return {
      ...(index.origin === "c" ? { name: index.name } : {}),
      origin: index.origin,
      unique: index.unique,
      columns,
      ...(index.origin === "c" ? { descending } : {}),
    };
  });
  const sortIndexes = (indexes) => indexes.toSorted((left, right) =>
    `${left.origin}:${left.name || ""}`.localeCompare(`${right.origin}:${right.name || ""}`));
  if (!isDeepStrictEqual(sortIndexes(actualIndexes), sortIndexes(expectedIndexes))) {
    throw new TypeError("incomplete schedule control SQLite v8 migration");
  }
}

function rowToBusinessOwnerAcceptance(row) {
  let value;
  try {
    const normalizer = row.acceptance_contract_version === SCHEDULE_BUSINESS_OWNER_ACCEPTANCE_CONTRACT_VERSION
      ? normalizeScheduleBusinessOwnerAcceptanceRevision
      : row.acceptance_contract_version === SCHEDULE_BUSINESS_OWNER_ACCEPTANCE_CONTRACT_VERSION_V2
        ? normalizeScheduleBusinessOwnerAcceptanceRevisionV2
        : null;
    if (!normalizer) throw new TypeError("unsupported acceptance contract version");
    value = normalizer(JSON.parse(row.revision_json));
  } catch {
    throw controlError("schedule_control_owner_acceptance_record_invalid");
  }
  const matches = row.tenant_scope === value.candidate.tenantScope &&
    row.employee_id === value.candidate.employeeId && row.schedule_id === value.candidate.scheduleId &&
    row.acceptance_version === value.acceptanceVersion && row.revision_digest === value.revisionDigest &&
    row.decision === value.decision && row.candidate_digest === value.candidate.candidateDigest &&
    row.acceptance_contract_version === value.contractVersion &&
    (!Object.hasOwn(row, "decided_at") || row.decided_at === value.decidedAt);
  if (!matches) throw controlError("schedule_control_owner_acceptance_record_invalid");
  return value;
}

function rowToControl(row) {
  return deepFreeze({
    tenantScope: row.tenant_scope,
    employeeId: row.employee_id,
    scheduleId: row.schedule_id,
    controlVersion: row.control_version,
    activationVersion: row.activation_version,
    activationState: row.activation_state,
    activationSnapshotId: row.activation_snapshot_id,
    activationSnapshotDigest: row.activation_snapshot_digest,
    effectiveActive: row.activation_state === "active" && row.emergency_stop_active === 0,
    registrationVersion: row.registration_version,
    scheduleVersion: row.schedule_version,
    schedulePolicyDigest: row.schedule_policy_digest,
    executionContractDigest: row.execution_contract_digest,
    maxConcurrentRuns: row.max_concurrent_runs,
    overlapWindowMinutes: row.overlap_window_minutes,
    activatedAt: row.activated_at,
    cursorAfter: row.cursor_after,
    nextScanAt: row.next_scan_at,
    emergencyStop: {
      active: row.emergency_stop_active === 1,
      version: row.emergency_stop_version,
      reasonCode: row.emergency_stop_reason_code,
      stoppedAt: row.emergency_stopped_at,
    },
    scanner: {
      fencingToken: row.scanner_fencing_token,
      leaseId: row.scanner_lease_id,
      ownerDigest: row.scanner_owner_digest,
      leaseExpiresAt: row.scanner_lease_expires_at,
    },
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  });
}

function rowToActivationSnapshot(row) {
  let value;
  try {
    value = JSON.parse(row.snapshot_json);
  } catch {
    throw controlError("schedule_control_activation_snapshot_invalid");
  }
  let snapshot;
  try {
    const normalizer = row.snapshot_contract_version === SCHEDULE_ACTIVATION_SNAPSHOT_CONTRACT_VERSION
      ? normalizeScheduleActivationSnapshot
      : row.snapshot_contract_version === SCHEDULE_ACTIVATION_SNAPSHOT_CONTRACT_VERSION_V2
        ? normalizeScheduleActivationSnapshotV2
        : row.snapshot_contract_version === SCHEDULE_ACTIVATION_SNAPSHOT_CONTRACT_VERSION_V3
          ? normalizeScheduleActivationSnapshotV3 : null;
    if (!normalizer) throw new TypeError("unsupported activation snapshot contract version");
    snapshot = normalizer(value);
  } catch {
    throw controlError("schedule_control_activation_snapshot_invalid");
  }
  const matches = row.snapshot_id === `schedule_activation_snapshot_${snapshot.snapshotDigest}` &&
    row.snapshot_version === snapshot.snapshotVersion && row.snapshot_digest === snapshot.snapshotDigest &&
    row.tenant_scope === snapshot.tenantScope && row.employee_id === snapshot.employeeId &&
    row.schedule_id === snapshot.scheduleId && row.activation_version === snapshot.activationVersion &&
    row.registration_version === snapshot.registrationVersion && row.schedule_version === snapshot.scheduleVersion &&
    row.created_at === snapshot.createdAt && row.snapshot_contract_version === snapshot.contractVersion &&
    (snapshot.contractVersion !== SCHEDULE_ACTIVATION_SNAPSHOT_CONTRACT_VERSION_V2
      ? row.acceptance_candidate_digest === null && row.acceptance_revision_digest === null &&
        row.acceptance_proof_digest === null && row.processing_authority_digest === null
      : row.acceptance_candidate_digest === snapshot.approval.acceptanceCandidateDigest &&
        row.acceptance_revision_digest === snapshot.approval.acceptanceRevisionDigest &&
        row.acceptance_proof_digest === snapshot.approval.proofDigest &&
        row.processing_authority_digest === snapshot.processingAuthorityDigest);
  if (!matches) throw controlError("schedule_control_activation_snapshot_binding_mismatch");
  return deepFreeze({
    snapshotId: row.snapshot_id,
    snapshotVersion: row.snapshot_version,
    snapshotDigest: row.snapshot_digest,
    snapshot,
  });
}

function rowToScannerLease(row) {
  return deepFreeze({
    tenantScope: row.tenant_scope,
    employeeId: row.employee_id,
    scheduleId: row.schedule_id,
    leaseId: row.scanner_lease_id,
    ownerDigest: row.scanner_owner_digest,
    fencingToken: row.scanner_fencing_token,
    leaseExpiresAt: row.scanner_lease_expires_at,
    cursorAfter: row.cursor_after,
    activationVersion: row.activation_version,
  });
}

function rowToIntent(row) {
  return deepFreeze({
    ...(row.manual_request_digest != null ? { manualRequestDigest: row.manual_request_digest } : {}),
    runId: row.run_id,
    intentVersion: row.intent_version,
    tenantScope: row.tenant_scope,
    employeeId: row.employee_id,
    scheduleId: row.schedule_id,
    activationVersion: row.activation_version,
    activationSnapshotId: row.activation_snapshot_id,
    activationSnapshotDigest: row.activation_snapshot_digest,
    scheduleVersion: row.schedule_version,
    schedulePolicyDigest: row.schedule_policy_digest,
    executionContractDigest: row.execution_contract_digest,
    scheduledFor: row.scheduled_for,
    expectedTriggerId: row.expected_trigger_id,
    expectedExecutionTaskId: row.expected_execution_task_id,
    executionTaskId: row.execution_task_id,
    intentState: row.intent_state,
    overlapOutcome: row.overlap_outcome,
    scannerFencingToken: row.scanner_fencing_token,
    observedTaskStatus: row.observed_task_status,
    lastErrorCode: row.last_error_code,
    preparedAt: row.prepared_at,
    submittedAt: row.submitted_at,
    reconciledAt: row.reconciled_at,
    terminalAt: row.terminal_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  });
}

function normalizeRunResultReceiptCandidate(value, { employeeId, scheduleId }) {
  const outcome = enumValue(value.outcome, RUN_RESULT_OUTCOMES, "schedule_control_run_result_outcome_invalid");
  const receiptEffectState = enumValue(
    value.receiptEffectState,
    RUN_RECEIPT_EFFECT_STATES,
    "schedule_control_run_result_effect_state_invalid",
  );
  const resultEvidenceDigest = value.resultEvidenceDigest === null
    ? null
    : digest(value.resultEvidenceDigest, "resultEvidenceDigest");
  const validOutcome = outcome === "parsed_result"
    ? resultEvidenceDigest !== null
    : outcome === "unknown"
      ? receiptEffectState === "reconcile_required" && resultEvidenceDigest === null
      : outcome === "no_result_safe"
        ? receiptEffectState === "settled" && resultEvidenceDigest === null
        : resultEvidenceDigest === null;
  if (!validOutcome) throw controlError("schedule_control_run_result_evidence_invalid");
  const lease = normalizeDualRunLeaseIdentity(value);
  const body = {
    contractVersion: "schedule-run-result-receipt.v1",
    receiptVersion: 1,
    tenantScope: token(value.tenantScope, "tenantScope"),
    runId: token(value.runId, "runId"),
    employeeId: token(employeeId, "employeeId"),
    scheduleId: token(scheduleId, "scheduleId"),
    baseIntentVersion: positiveInteger(value.expectedIntentVersion, "expectedIntentVersion"),
    baseExecutionVersion: positiveInteger(value.expectedExecutionVersion, "expectedExecutionVersion"),
    executionTaskId: token(value.executionTaskId, "executionTaskId"),
    activationSnapshotId: token(value.activationSnapshotId, "activationSnapshotId"),
    activationSnapshotDigest: digest(value.activationSnapshotDigest, "activationSnapshotDigest"),
    leaseId: lease.leaseId,
    ownerDigest: lease.ownerDigest,
    fencingToken: lease.fencingToken,
    taskLeaseId: lease.taskLeaseId,
    taskOwnerDigest: lease.taskOwnerDigest,
    taskFencingToken: lease.taskFencingToken,
    leaseBindingDigest: digestCanonical({
      contractVersion: "schedule-run-dual-lease-binding.v1",
      leaseId: lease.leaseId,
      ownerDigest: lease.ownerDigest,
      fencingToken: lease.fencingToken,
      taskLeaseId: lease.taskLeaseId,
      taskOwnerDigest: lease.taskOwnerDigest,
      taskFencingToken: lease.taskFencingToken,
    }),
    operationReceiptEvidenceDigest: digest(
      value.operationReceiptEvidenceDigest,
      "operationReceiptEvidenceDigest",
    ),
    receiptEffectState,
    outcome,
    resultEvidenceDigest,
  };
  return deepFreeze({
    ...body,
    resultReceiptDigest: digestCanonical(body),
    recordedAt: canonicalTimestamp(value.recordedAt, "recordedAt"),
  });
}

function requireResultProcessingOutcomeResolution(value) {
  requireExactObject(
    value,
    INTERNAL_PROCESSING_OUTCOME_FIELDS,
    "schedule_control_run_result_processing_outcome_invalid",
  );
  if (value.contractVersion !== "schedule-result-processing-outcome-internal-evidence.v1" ||
    value.evidenceBoundary !== "internal_only") {
    throw controlError("schedule_control_run_result_processing_outcome_invalid");
  }
  requireExactObject(
    value.binding,
    INTERNAL_PROCESSING_BINDING_FIELDS,
    "schedule_control_run_result_processing_outcome_invalid",
  );
  requireExactObject(
    value.outcome,
    INTERNAL_PROCESSING_EVIDENCE_FIELDS,
    "schedule_control_run_result_processing_outcome_invalid",
  );
  if (value.binding.contractVersion !== "schedule-result-processing-outcome-binding.v1" ||
    value.outcome.contractVersion !== "schedule-result-processing-outcome-evidence.v1") {
    throw controlError("schedule_control_run_result_processing_outcome_invalid");
  }
  const state = enumValue(
    value.outcome.state,
    new Set(["parsed_result", "parse_failed", "unknown"]),
    "schedule_control_run_result_processing_outcome_invalid",
  );
  const resultEvidenceDigest = value.outcome.resultEvidenceDigest === null
    ? null
    : digest(value.outcome.resultEvidenceDigest, "resultEvidenceDigest");
  const safeFailureCode = value.outcome.safeFailureCode === null
    ? null
    : token(value.outcome.safeFailureCode, "safeFailureCode");
  const outcomeShapeValid = state === "parsed_result"
    ? resultEvidenceDigest !== null && safeFailureCode === null
    : resultEvidenceDigest === null && safeFailureCode !== null;
  if (!outcomeShapeValid) {
    throw controlError("schedule_control_run_result_processing_outcome_invalid");
  }
  return deepFreeze({
    contractVersion: value.contractVersion,
    evidenceBoundary: value.evidenceBoundary,
    binding: {
      contractVersion: value.binding.contractVersion,
      tenantScope: token(value.binding.tenantScope, "binding.tenantScope"),
      employeeId: token(value.binding.employeeId, "binding.employeeId"),
      scheduleId: token(value.binding.scheduleId, "binding.scheduleId"),
      runId: token(value.binding.runId, "binding.runId"),
      canonicalTaskId: token(value.binding.canonicalTaskId, "binding.canonicalTaskId"),
      triggerId: token(value.binding.triggerId, "binding.triggerId"),
      scheduledFor: canonicalTimestamp(value.binding.scheduledFor, "binding.scheduledFor"),
      activationVersion: positiveInteger(value.binding.activationVersion, "binding.activationVersion"),
      activationSnapshotId: token(value.binding.activationSnapshotId, "binding.activationSnapshotId"),
      activationSnapshotDigest: digest(value.binding.activationSnapshotDigest, "binding.activationSnapshotDigest"),
      processingAuthorityDigest: digest(value.binding.processingAuthorityDigest, "binding.processingAuthorityDigest"),
      resultContractDigest: digest(value.binding.resultContractDigest, "binding.resultContractDigest"),
      alertContractDigest: digest(value.binding.alertContractDigest, "binding.alertContractDigest"),
      retentionDefinitionDigest: digest(
        value.binding.retentionDefinitionDigest,
        "binding.retentionDefinitionDigest",
      ),
      ingestRef: token(value.binding.ingestRef, "binding.ingestRef"),
      ingestEvidenceDigest: digest(value.binding.ingestEvidenceDigest, "binding.ingestEvidenceDigest"),
      providerAttemptEvidenceDigest: digest(
        value.binding.providerAttemptEvidenceDigest,
        "binding.providerAttemptEvidenceDigest",
      ),
      runLeaseBindingDigest: digest(value.binding.runLeaseBindingDigest, "binding.runLeaseBindingDigest"),
    },
    outcome: {
      contractVersion: value.outcome.contractVersion,
      state,
      processingEvidenceDigest: digest(
        value.outcome.processingEvidenceDigest,
        "outcome.processingEvidenceDigest",
      ),
      resultEvidenceDigest,
      safeFailureCode,
      processedAt: canonicalTimestamp(value.outcome.processedAt, "outcome.processedAt"),
    },
  });
}

function sameRunResultReceiptCandidate(stored, candidate) {
  const { recordedAt: storedRecordedAt, ...storedCanonical } = stored;
  const { recordedAt: candidateRecordedAt, ...candidateCanonical } = candidate;
  return Boolean(storedRecordedAt && candidateRecordedAt && isDeepStrictEqual(storedCanonical, candidateCanonical));
}

function projectScheduleRunTerminalEvidence({ receipt, canonicalTaskStatus } = {}) {
  if (!receipt || typeof receipt !== "object" || Array.isArray(receipt)) {
    throw controlError("schedule_control_run_terminal_evidence_invalid");
  }
  const outcome = enumValue(receipt.outcome, RUN_RESULT_OUTCOMES, "schedule_control_run_terminal_evidence_invalid");
  const effectState = enumValue(
    receipt.receiptEffectState,
    RUN_RECEIPT_EFFECT_STATES,
    "schedule_control_run_terminal_evidence_invalid",
  );
  const taskStatus = enumValue(
    canonicalTaskStatus,
    TERMINAL_TASK_STATUSES,
    "schedule_control_task_status_invalid",
  );
  const allowedStatus = (outcome === "parsed_result" && effectState === "settled" && taskStatus === "completed") ||
    (outcome === "parsed_result" && effectState === "reconcile_required" && taskStatus === "blocked") ||
    (outcome === "parse_failed" && effectState === "settled" && taskStatus === "failed") ||
    (outcome === "parse_failed" && effectState === "reconcile_required" && taskStatus === "blocked") ||
    (outcome === "no_result_safe" && effectState === "settled" && taskStatus === "blocked") ||
    (outcome === "unknown" && effectState === "reconcile_required" &&
      (taskStatus === "blocked" || taskStatus === "timed_out"));
  if (!allowedStatus) throw controlError("schedule_control_run_result_terminal_status_conflict");
  const body = {
    contractVersion: SCHEDULE_RUN_TERMINAL_EVIDENCE_CONTRACT_VERSION,
    tenantScope: token(receipt.tenantScope, "receipt.tenantScope"),
    runId: token(receipt.runId, "receipt.runId"),
    executionTaskId: token(receipt.executionTaskId, "receipt.executionTaskId"),
    activationSnapshotId: token(receipt.activationSnapshotId, "receipt.activationSnapshotId"),
    activationSnapshotDigest: digest(receipt.activationSnapshotDigest, "receipt.activationSnapshotDigest"),
    resultReceiptDigest: digest(receipt.resultReceiptDigest, "receipt.resultReceiptDigest"),
    outcome,
    receiptEffectState: effectState,
    resultEvidenceDigest: receipt.resultEvidenceDigest === null
      ? null
      : digest(receipt.resultEvidenceDigest, "receipt.resultEvidenceDigest"),
    operationReceiptEvidenceDigest: digest(
      receipt.operationReceiptEvidenceDigest,
      "receipt.operationReceiptEvidenceDigest",
    ),
    canonicalTaskStatus: taskStatus,
  };
  return deepFreeze({ ...body, terminalEvidenceDigest: digestCanonical(body) });
}

function rowToRunResultReceipt(row, intent) {
  let receipt;
  try {
    receipt = normalizeRunResultReceiptCandidate({
      tenantScope: row.tenant_scope,
      runId: row.run_id,
      expectedIntentVersion: row.base_intent_version,
      expectedExecutionVersion: row.base_execution_version,
      executionTaskId: row.execution_task_id,
      activationSnapshotId: row.activation_snapshot_id,
      activationSnapshotDigest: row.activation_snapshot_digest,
      leaseId: row.lease_id,
      ownerDigest: row.owner_digest,
      fencingToken: row.fencing_token,
      taskLeaseId: row.task_lease_id,
      taskOwnerDigest: row.task_owner_digest,
      taskFencingToken: row.task_fencing_token,
      operationReceiptEvidenceDigest: row.operation_receipt_evidence_digest,
      receiptEffectState: row.receipt_effect_state,
      outcome: row.outcome,
      resultEvidenceDigest: row.result_evidence_digest,
      recordedAt: row.recorded_at,
    }, {
      employeeId: row.employee_id,
      scheduleId: row.schedule_id,
    });
  } catch {
    throw controlError("schedule_control_run_result_receipt_corrupt");
  }
  if (!intent || row.employee_id !== intent.employee_id || row.schedule_id !== intent.schedule_id ||
    row.execution_task_id !== intent.execution_task_id ||
    row.activation_snapshot_id !== intent.activation_snapshot_id ||
    row.activation_snapshot_digest !== intent.activation_snapshot_digest ||
    row.receipt_version !== 1 || row.lease_binding_digest !== receipt.leaseBindingDigest ||
    row.result_receipt_digest !== receipt.resultReceiptDigest) {
    throw controlError("schedule_control_run_result_receipt_corrupt");
  }
  return receipt;
}

function rowToRunExecution(row) {
  if (!row || !RUN_EXECUTION_STATES.has(row.execution_state)) {
    throw controlError("schedule_control_run_execution_invalid");
  }
  const resultReceiptRequirement = enumValue(
    row.result_receipt_requirement,
    RUN_RESULT_RECEIPT_REQUIREMENTS,
    "schedule_control_run_result_receipt_requirement_invalid",
  );
  let resultReceiptDigest = null;
  let canonicalTerminalEvidenceDigest = null;
  try {
    resultReceiptDigest = row.result_receipt_digest === null
      ? null
      : digest(row.result_receipt_digest, "resultReceiptDigest");
    canonicalTerminalEvidenceDigest = row.canonical_terminal_evidence_digest === null
      ? null
      : digest(row.canonical_terminal_evidence_digest, "canonicalTerminalEvidenceDigest");
  } catch {
    throw controlError("schedule_control_run_execution_invalid");
  }
  if (resultReceiptDigest !== null && canonicalTerminalEvidenceDigest === null) {
    throw controlError("schedule_control_run_execution_invalid");
  }
  return deepFreeze({
    runId: row.run_id,
    executionVersion: row.execution_version,
    tenantScope: row.tenant_scope,
    employeeId: row.employee_id,
    scheduleId: row.schedule_id,
    executionTaskId: row.execution_task_id,
    activationVersion: row.activation_version,
    windowStart: row.window_start,
    windowEnd: row.window_end,
    executionState: row.execution_state,
    executionPhase: row.execution_phase,
    admissionOutcome: row.admission_outcome,
    leaseId: row.lease_id,
    ownerDigest: row.owner_digest,
    fencingToken: row.fencing_token,
    leaseExpiresAt: row.lease_expires_at,
    taskLeaseId: row.task_lease_id,
    taskOwnerDigest: row.task_owner_digest,
    taskFencingToken: row.task_fencing_token,
    taskLeaseExpiresAt: row.task_lease_expires_at,
    observedTaskStatus: row.observed_task_status,
    lastErrorCode: row.last_error_code,
    canonicalTaskRevision: row.canonical_task_revision,
    canonicalTaskStatus: row.canonical_task_status,
    effectState: row.effect_state,
    effectEvidenceDigest: row.effect_evidence_digest,
    resultReceiptRequirement,
    resultReceiptDigest,
    canonicalTerminalEvidenceDigest,
    claimedAt: row.claimed_at,
    reconcileBlockedAt: row.reconcile_blocked_at,
    releasedAt: row.released_at,
    finalizedAt: row.finalized_at,
    updatedAt: row.updated_at,
  });
}

function rowToCancelOutbox(row) {
  return deepFreeze({
    cancelId: row.cancel_id,
    outboxVersion: row.outbox_version,
    tenantScope: row.tenant_scope,
    employeeId: row.employee_id,
    scheduleId: row.schedule_id,
    runId: row.run_id,
    executionTaskId: row.execution_task_id,
    emergencyStopVersion: row.emergency_stop_version,
    activationVersion: row.activation_version,
    expectedTriggerId: row.expected_trigger_id,
    reasonCode: row.reason_code,
    state: row.outbox_state,
    dispatchState: row.outbox_state,
    reconcileState: row.reconcile_state,
    canonicalTaskRevision: row.canonical_task_revision,
    canonicalTaskStatus: row.canonical_task_status,
    effectState: row.effect_state,
    effectEvidenceDigest: row.effect_evidence_digest,
    createdAt: row.created_at,
    dispatchedAt: row.dispatched_at,
    reconciledAt: row.reconciled_at,
    updatedAt: row.updated_at,
  });
}

function rowToControlEvent(row) {
  return deepFreeze({
    eventId: row.event_id,
    tenantScope: row.tenant_scope,
    employeeId: row.employee_id,
    scheduleId: row.schedule_id,
    controlVersion: row.control_version,
    eventType: row.event_type,
    reasonCode: row.reason_code,
    safeReason: row.safe_reason,
    actor: {
      principalId: row.actor_principal_id,
      displayName: row.actor_display_name,
      nameStatus: row.actor_name_status,
      identitySource: row.actor_identity_source,
      resolvedAt: row.actor_resolved_at,
    },
    eventAt: row.event_at,
  });
}

function deterministicIntentIds(identity, scheduledFor, manualRequestDigest) {
  const slotDigest = scheduleTriggerSlotDigest({ ...identity, scheduledFor, manualRequestDigest });
  return {
    runId: `schedule_run_${slotDigest}`,
    triggerId: `schedule_trigger_${slotDigest}`,
    executionTaskId: `task_${slotDigest}`,
  };
}

function requireCurrentScannerLease(control, lease, now) {
  if (control.activation_state !== "active" || control.emergency_stop_active === 1 ||
    control.scanner_lease_id !== lease.leaseId || control.scanner_owner_digest !== lease.ownerDigest ||
    control.scanner_fencing_token !== lease.fencingToken || !control.scanner_lease_expires_at ||
    control.scanner_lease_expires_at <= now) {
    throw controlError("schedule_control_scanner_fenced");
  }
}

function normalizeIdentity({ tenantScope, employeeId, scheduleId }) {
  return {
    tenantScope: token(tenantScope, "tenantScope"),
    employeeId: token(employeeId, "employeeId"),
    scheduleId: token(scheduleId, "scheduleId"),
  };
}

function normalizeLeaseIdentity({ leaseId, ownerDigest, fencingToken }) {
  return {
    leaseId: token(leaseId, "leaseId"),
    ownerDigest: digest(ownerDigest, "ownerDigest"),
    fencingToken: positiveInteger(fencingToken, "fencingToken"),
  };
}

function normalizeRunLeaseIdentity({ leaseId, ownerDigest, fencingToken, taskFencingToken }) {
  return {
    leaseId: token(leaseId, "leaseId"),
    ownerDigest: digest(ownerDigest, "ownerDigest"),
    fencingToken: positiveInteger(fencingToken, "fencingToken"),
    taskFencingToken: positiveInteger(taskFencingToken, "taskFencingToken"),
  };
}

function normalizeDualRunLeaseIdentity({
  leaseId,
  ownerDigest,
  fencingToken,
  taskLeaseId,
  taskOwnerDigest,
  taskFencingToken,
}) {
  return {
    ...normalizeRunLeaseIdentity({ leaseId, ownerDigest, fencingToken, taskFencingToken }),
    taskLeaseId: token(taskLeaseId, "taskLeaseId"),
    taskOwnerDigest: digest(taskOwnerDigest, "taskOwnerDigest"),
  };
}

function normalizeControlBinding({
  executionContractDigest,
  maxConcurrentRuns,
  overlapWindowMinutes,
  registrationVersion,
  schedulePolicyDigest,
  scheduleVersion,
}) {
  return {
    registrationVersion: positiveInteger(registrationVersion, "registrationVersion"),
    scheduleVersion: token(scheduleVersion, "scheduleVersion"),
    schedulePolicyDigest: digest(schedulePolicyDigest, "schedulePolicyDigest"),
    executionContractDigest: digest(executionContractDigest, "executionContractDigest"),
    maxConcurrentRuns: boundedInteger(maxConcurrentRuns, 1, 100, "maxConcurrentRuns"),
    overlapWindowMinutes: boundedInteger(overlapWindowMinutes, 0, 1440, "overlapWindowMinutes"),
  };
}

function requireSameControlBinding(control, binding) {
  if (!controlBindingMatches(control, binding)) throw controlError("schedule_control_registration_changed");
}

function controlBindingMatches(control, binding) {
  return control.registration_version === binding.registrationVersion &&
    control.schedule_version === binding.scheduleVersion &&
    control.schedule_policy_digest === binding.schedulePolicyDigest &&
    control.execution_contract_digest === binding.executionContractDigest &&
    control.max_concurrent_runs === binding.maxConcurrentRuns &&
    control.overlap_window_minutes === binding.overlapWindowMinutes;
}

function normalizeControlAudit({ actor, safeReason }) {
  if (!actor || typeof actor !== "object" || Array.isArray(actor)) {
    throw controlError("schedule_control_actor_invalid");
  }
  const nameStatus = enumValue(actor.nameStatus, new Set(["verified", "unresolved"]), "schedule_control_actor_invalid");
  const resolvedAt = actor.resolvedAt === null || actor.resolvedAt === undefined
    ? null
    : canonicalTimestamp(actor.resolvedAt, "actor.resolvedAt");
  return {
    actorPrincipalId: token(actor.principalId, "actor.principalId", 160),
    actorDisplayName: safeLine(actor.displayName, "actor.displayName", 120),
    actorNameStatus: nameStatus,
    actorIdentitySource: token(actor.identitySource, "actor.identitySource", 120),
    actorResolvedAt: resolvedAt,
    safeReason: safeLine(safeReason, "safeReason", 300),
  };
}

function requireCancelCanonicalEvidence({ effectState, taskRevision, taskStatus }) {
  if (taskStatus === "pre_canceled") {
    if (taskRevision !== 0 || effectState !== "safe_terminal") {
      throw controlError("schedule_control_cancel_terminal_evidence_invalid");
    }
    return;
  }
  if (taskRevision < 1) throw controlError("schedule_control_cancel_terminal_evidence_invalid");
}

function isCancellationTerminalStatus(value) {
  return value === "pre_canceled" || TERMINAL_TASK_STATUSES.has(value);
}

function transaction(database, run) {
  database.exec("BEGIN IMMEDIATE");
  try {
    const result = run();
    database.exec("COMMIT");
    return result;
  } catch (error) {
    if (database.isTransaction) database.exec("ROLLBACK");
    throw error;
  }
}

function requireExactObject(value, fields, code) {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
    Object.keys(value).some((field) => !fields.has(field)) ||
    [...fields].some((field) => !Object.hasOwn(value, field))) {
    throw controlError(code);
  }
}

function requiredDatabasePath(value) {
  const result = String(value || "").trim();
  if (result === ":memory:") return result;
  if (!result || !path.isAbsolute(result)) throw new TypeError("schedule control databasePath must be absolute or :memory:");
  return path.normalize(result);
}

function token(value, field, maxLength = 160) {
  const result = String(value || "").trim();
  if (!result || result.length > maxLength || !/^[A-Za-z0-9][A-Za-z0-9._:@/-]*$/.test(result)) {
    throw controlError("schedule_control_reference_invalid", field);
  }
  return result;
}

function safeLine(value, field, maxLength) {
  const result = String(value || "").replace(/[\u0000-\u001f\u007f]/g, " ").trim();
  if (!result || result.length > maxLength || /(?:bearer\s+|sk-[a-z0-9_-]{8,}|api[_ -]?key|credential|password|secret)/i.test(result)) {
    throw controlError("schedule_control_safe_text_invalid", field);
  }
  return result;
}

function digest(value, field) {
  const result = String(value || "").trim().toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(result)) throw controlError("schedule_control_digest_invalid", field);
  return result;
}

function canonicalTimestamp(value, field) {
  const input = value instanceof Date ? value.toISOString() : String(value || "").trim();
  const parsed = new Date(input);
  if (!input || !Number.isFinite(parsed.getTime()) || parsed.toISOString() !== input) {
    throw controlError("schedule_control_timestamp_invalid", field);
  }
  return input;
}

function liveTaskLeaseExpiry(value, now) {
  const expiresAt = canonicalTimestamp(value, "taskLeaseExpiresAt");
  if (expiresAt <= now) throw controlError("schedule_control_task_lease_expired");
  return expiresAt;
}

function cappedLeaseExpiry(now, durationMs, taskLeaseExpiresAt) {
  return new Date(Math.min(Date.parse(now) + durationMs, Date.parse(taskLeaseExpiresAt))).toISOString();
}

function positiveInteger(value, field) {
  return boundedInteger(value, 1, Number.MAX_SAFE_INTEGER, field);
}

function nonNegativeInteger(value, field) {
  return boundedInteger(value, 0, Number.MAX_SAFE_INTEGER, field);
}

function boundedInteger(value, minimum, maximum, field) {
  const result = Number(value);
  if (!Number.isSafeInteger(result) || result < minimum || result > maximum) {
    throw controlError("schedule_control_number_invalid", field);
  }
  return result;
}

function enumValue(value, allowed, code) {
  if (!allowed.has(value)) throw controlError(code);
  return value;
}

function digestCanonical(value) {
  return crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function deepFreeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    Object.values(value).forEach(deepFreeze);
  }
  return value;
}

function controlError(code, detail = "") {
  const error = new Error(detail ? `${code}: ${detail}` : code);
  error.code = code;
  return error;
}

export {
  SCHEDULE_CONTROL_REPOSITORY_CONTRACT_VERSION,
  SCHEDULE_RUN_TERMINAL_EVIDENCE_CONTRACT_VERSION,
  createSqliteScheduleControlRepository,
  projectScheduleRunTerminalEvidence,
};
