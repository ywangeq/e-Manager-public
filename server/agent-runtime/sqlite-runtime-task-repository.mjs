import { createOpsTaskAnalyticsReader } from "./ops-task-analytics-reader.mjs";
import { createDeviceReadAttemptRepository } from "./device-read-attempt-repository.mjs";
import { createPersonalAutomationRepository, createPersonalAutomationSchema, ensurePersonalAutomationSchema, validatePersonalAutomationSchema } from "./personal-automation-repository.mjs";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { closeSqliteDatabase } from "../sqlite-lifecycle.mjs";
import { isDeepStrictEqual } from "node:util";
import {
  EXECUTION_TASK_REPOSITORY_CONTRACT_VERSION,
  executionTaskError,
  normalizeExecutionTaskSettlement,
  normalizeExecutionTaskSubmission,
  normalizedExecutionTaskNow,
  requiredExecutionTaskDigest,
  requiredExecutionTaskToken,
} from "./runtime-task-contract-v1.mjs";
import {
  normalizeTaskEventAfterSeq,
  normalizeTaskEventAppend,
  TASK_EVENT_CONTRACT_VERSION,
} from "./task-event-contract-v1.mjs";
import {
  normalizeOperationEffectOutcome,
  normalizeOperationReceiptRequest,
} from "./operation-receipt-contract-v1.mjs";
import {
  createProviderAttemptReceiptEvidence,
  normalizeProviderAttemptDescriptor,
  normalizeProviderAttemptReceipt,
} from "./provider-attempt-receipt-contract-v1.mjs";
import {
  createDesktopSandboxDispatchAttempt,
  normalizeDesktopSandboxDispatchAttempt,
  transitionDesktopSandboxDispatchAttempt,
} from "./desktop-sandbox-dispatch-attempt-v1.mjs";
import {
  AGENT_RUNTIME_EVIDENCE_CONTRACT_VERSION,
  normalizeAgentRuntimeEvidence,
} from "./runtime-task-evidence-contract-v1.mjs";
import {
  assertRuntimeSafeActivitySnapshotProgress,
  canonicalRuntimeSafeActivityId,
  normalizeRuntimeSafeActivitySnapshot,
  RUNTIME_SAFE_ACTIVITY_SNAPSHOT_CONTRACT_VERSION,
  runtimeSafeActivityDisplayName,
} from "./runtime-safe-activity-contract-v1.mjs";
import {
  ARTIFACT_REF_CONTRACT_VERSION,
  normalizeArtifactRef,
} from "./artifact-ref-contract-v1.mjs";
import {
  normalizeReusableArtifactGrant,
  REUSABLE_ARTIFACT_GRANT_CONTRACT_VERSION,
} from "./reusable-artifact-grant-contract-v1.mjs";
import {
  createRuntimeSafeProvenanceSchemaV13,
  readRuntimeSafeProvenanceForTasks,
  readRuntimeSafeProvenanceState,
  validateRuntimeSafeProvenanceSchemaV13,
  writeRuntimeSafeProvenanceSource,
} from "./runtime-safe-provenance-sqlite-store.mjs";
import {
  createRuntimeToolEfficiencySchemaV14,
  readRuntimeToolEfficiencyForTasks,
  readRuntimeToolEfficiencyState,
  validateRuntimeToolEfficiencySchemaV14,
  writeRuntimeToolEfficiencyMutation,
} from "./runtime-tool-efficiency-sqlite-store.mjs";
import {
  createRuntimeTaskQueueSchemaV15,
  listCurrentUserRuntimeTaskRows,
  reorderCurrentUserRuntimeTaskRows,
  validateRuntimeTaskQueueSchemaV15,
} from "./current-user-runtime-task-queue-sqlite-store.mjs";
import {
  DEFAULT_PROVIDER_DIAGNOSTIC,
  normalizeProviderRuntimeDiagnostic,
} from "./provider-errors.mjs";
import {
  createOpsIncidentDiagnosisSchemaV17,
  createOpsIncidentDiagnosisSchemaV18,
  createOpsIncidentDiagnosisSchemaV19,
  createOpsIncidentDiagnosisStore,
  validateOpsIncidentDiagnosisSchemaV17,
  validateOpsIncidentDiagnosisSchemaV18,
  validateOpsIncidentDiagnosisSchemaV19,
} from "./ops-incident-diagnosis-sqlite-store.mjs";

import { createGroupRepository, createGroupSchemaV22, validateGroupSchemaV22, createGroupHistorySchemaV25, validateGroupHistorySchemaV25 } from "./group-repository-v1.mjs";
import { createWorkGoalBindingSchemaV26, validateWorkGoalBindingSchemaV26, createWorkGoalTaskBindingRepository } from "./work-goal-task-binding-repository.mjs";

const SQLITE_EXECUTION_TASK_SCHEMA_VERSION = 25;
const DEFAULT_LEASE_DURATION_MS = 30_000;
const MAX_ARTIFACT_REFS_PER_TASK = 100;
const MAX_ARTIFACT_BYTES_PER_TASK = 512 * 1024 * 1024;
const MAX_ARTIFACT_OBJECT_BYTES_PER_TENANT = 10 * 1024 * 1024 * 1024;
const ARTIFACT_CLEANUP_RESULT_CODES = new Set([
  "delete_pending",
  "deleted",
  "integrity_invalid",
  "object_missing",
  "object_state_invalid",
  "reference_changed",
]);
const TERMINAL_TASK_STATUSES = new Set([
  "blocked",
  "canceled",
  "completed",
  "failed",
  "lost",
  "rejected",
  "timed_out",
]);
const PROVIDER_ATTEMPT_BEGIN_FIELDS = new Set([
  "contractVersion", "executionScopeId", "fencingToken", "inputDigest", "leaseId", "now",
  "providerBindingDigest", "providerRequestId", "purpose", "recoveryMode", "requestDigest",
  "taskId", "tenantScope", "workerIdDigest",
]);
const PROVIDER_ATTEMPT_COMMIT_FIELDS = new Set([
  ...PROVIDER_ATTEMPT_BEGIN_FIELDS, "ingestEvidenceDigest", "ingestRef", "safeResultCode", "status",
]);
const PROVIDER_ATTEMPT_READ_FIELDS = new Set([
  "executionScopeId", "purpose", "taskId", "tenantScope",
]);
const DESKTOP_SANDBOX_DISPATCH_ATTEMPT_CREATE_FIELDS = new Set([
  "attemptId", "deviceSessionDigest", "expiresAt", "fencingToken", "leaseId", "now", "operationDigest",
  "profileDigest", "taskId", "taskInputDigest", "tenantScope", "workerIdDigest", "workspaceInputDigest",
]);
const DESKTOP_SANDBOX_DISPATCH_ATTEMPT_TRANSITION_FIELDS = new Set([
  "attemptId", "deviceSessionDigest", "fencingToken", "leaseId", "nextStatus", "now", "taskId",
  "tenantScope", "workerIdDigest",
]);
const DESKTOP_SANDBOX_DISPATCH_ATTEMPT_READ_FIELDS = new Set([
  "attemptId", "taskId", "tenantScope",
]);
const DESKTOP_SANDBOX_DISPATCH_ATTEMPT_DEVICE_READ_FIELDS = new Set([
  "attemptId", "deviceSessionDigest", "now", "tenantScope",
]);
const PROVIDER_ATTEMPT_SCHEMA_SQL = `
  CREATE TABLE execution_provider_attempt_receipts (
    tenant_scope TEXT NOT NULL,
    task_id TEXT NOT NULL,
    execution_scope_id TEXT NOT NULL,
    purpose TEXT NOT NULL,
    provider_request_id TEXT NOT NULL,
    request_digest TEXT NOT NULL,
    provider_binding_digest TEXT NOT NULL,
    input_digest TEXT NOT NULL,
    recovery_mode TEXT NOT NULL CHECK (recovery_mode IN ('none', 'remote_idempotency', 'status_query')),
    contract_version TEXT NOT NULL CHECK (contract_version = 'provider-attempt-receipt.v1'),
    attempt_number INTEGER NOT NULL CHECK (attempt_number = 1),
    status TEXT NOT NULL CHECK (status IN ('dispatch_prepared', 'response_recorded', 'definitive_failed', 'unknown')),
    fencing_token INTEGER NOT NULL CHECK (fencing_token > 0),
    ownership_digest TEXT NOT NULL,
    safe_result_code TEXT,
    ingest_ref TEXT,
    ingest_evidence_digest TEXT,
    attempt_evidence_digest TEXT NOT NULL,
    receipt_evidence_digest TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    finished_at TEXT,
    PRIMARY KEY (tenant_scope, task_id),
    UNIQUE (tenant_scope, provider_request_id),
    FOREIGN KEY (tenant_scope, task_id) REFERENCES execution_tasks (tenant_scope, task_id) ON DELETE CASCADE,
    CHECK (
      (status = 'dispatch_prepared' AND safe_result_code IS NULL AND ingest_ref IS NULL
        AND ingest_evidence_digest IS NULL AND finished_at IS NULL)
      OR
      (status = 'response_recorded' AND safe_result_code IS NOT NULL AND ingest_ref IS NOT NULL
        AND ingest_evidence_digest IS NOT NULL AND finished_at IS NOT NULL)
      OR
      (status IN ('definitive_failed', 'unknown') AND safe_result_code IS NOT NULL AND ingest_ref IS NULL
        AND ingest_evidence_digest IS NULL AND finished_at IS NOT NULL)
    )
  );
  CREATE INDEX execution_provider_attempt_receipts_status_idx
    ON execution_provider_attempt_receipts (tenant_scope, status, updated_at);
`;
const DESKTOP_SANDBOX_DISPATCH_ATTEMPT_SCHEMA_V21_SQL = `
  CREATE TABLE IF NOT EXISTS execution_desktop_sandbox_dispatch_attempts (
    tenant_scope TEXT NOT NULL,
    task_id TEXT NOT NULL,
    attempt_id TEXT NOT NULL,
    contract_version TEXT NOT NULL CHECK (contract_version = 'desktop-sandbox-dispatch-attempt.v1'),
    device_session_digest TEXT NOT NULL CHECK (
      length(device_session_digest) = 64 AND device_session_digest NOT GLOB '*[^a-f0-9]*'
    ),
    profile_digest TEXT NOT NULL CHECK (
      length(profile_digest) = 71 AND profile_digest GLOB 'sha256:*' AND
      substr(profile_digest, 8) NOT GLOB '*[^a-f0-9]*'
    ),
    operation_digest TEXT NOT NULL CHECK (
      length(operation_digest) = 64 AND operation_digest NOT GLOB '*[^a-f0-9]*'
    ),
    task_input_digest TEXT NOT NULL CHECK (
      length(task_input_digest) = 64 AND task_input_digest NOT GLOB '*[^a-f0-9]*'
    ),
    workspace_input_digest TEXT NOT NULL CHECK (
      length(workspace_input_digest) = 64 AND workspace_input_digest NOT GLOB '*[^a-f0-9]*'
    ),
    attempt_lease_fence_digest TEXT NOT NULL CHECK (
      length(attempt_lease_fence_digest) = 64 AND attempt_lease_fence_digest NOT GLOB '*[^a-f0-9]*'
    ),
    attempt_lease_fencing_token INTEGER NOT NULL CHECK (attempt_lease_fencing_token > 0),
    status TEXT NOT NULL CHECK (status IN (
      'eligible', 'prepared', 'accepted', 'running', 'completed', 'failed', 'rejected', 'timed_out', 'canceled', 'unknown'
    )),
    transition_lease_fence_digest TEXT NOT NULL CHECK (
      length(transition_lease_fence_digest) = 64 AND transition_lease_fence_digest NOT GLOB '*[^a-f0-9]*'
    ),
    transition_lease_fencing_token INTEGER NOT NULL CHECK (transition_lease_fencing_token > 0),
    state_evidence_digest TEXT NOT NULL CHECK (
      length(state_evidence_digest) = 64 AND state_evidence_digest NOT GLOB '*[^a-f0-9]*'
    ),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    PRIMARY KEY (tenant_scope, attempt_id),
    UNIQUE (tenant_scope, task_id, operation_digest),
    FOREIGN KEY (tenant_scope, task_id) REFERENCES execution_tasks (tenant_scope, task_id) ON DELETE CASCADE
  );
  CREATE INDEX IF NOT EXISTS execution_desktop_sandbox_dispatch_attempts_task_idx
    ON execution_desktop_sandbox_dispatch_attempts (tenant_scope, task_id, updated_at, attempt_id);
  CREATE INDEX IF NOT EXISTS execution_desktop_sandbox_dispatch_attempts_device_idx
    ON execution_desktop_sandbox_dispatch_attempts (tenant_scope, device_session_digest, status, expires_at, updated_at);
`;
const RUNTIME_EVIDENCE_SCHEMA_SQL = `
  CREATE TABLE execution_task_runtime_evidence (
    tenant_scope TEXT NOT NULL,
    task_id TEXT NOT NULL,
    contract_version TEXT NOT NULL CHECK (contract_version = '${AGENT_RUNTIME_EVIDENCE_CONTRACT_VERSION}'),
    status TEXT NOT NULL CHECK (status IN (
      'model_request_started', 'model_response_received', 'model_request_failed',
      'tool_call_started', 'tool_call_completed'
    )),
    real_model_requested INTEGER NOT NULL CHECK (real_model_requested = 1),
    provider TEXT NOT NULL,
    model TEXT NOT NULL,
    reasoning_effort TEXT NOT NULL,
    adapter TEXT NOT NULL,
    request_count INTEGER NOT NULL CHECK (request_count >= 1),
    tool_call_count INTEGER NOT NULL CHECK (tool_call_count >= 0),
    tool_calls_json TEXT NOT NULL,
    input_tokens INTEGER CHECK (input_tokens IS NULL OR input_tokens >= 0),
    output_tokens INTEGER CHECK (output_tokens IS NULL OR output_tokens >= 0),
    total_tokens INTEGER CHECK (total_tokens IS NULL OR total_tokens >= 0),
    blocked_reason TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (tenant_scope, task_id),
    FOREIGN KEY (tenant_scope, task_id) REFERENCES execution_tasks (tenant_scope, task_id) ON DELETE CASCADE
  );
`;
const DEFAULT_PROVIDER_DIAGNOSTIC_JSON = JSON.stringify(DEFAULT_PROVIDER_DIAGNOSTIC);
const RUNTIME_EVIDENCE_PROVIDER_DIAGNOSTIC_COLUMN_SQL =
  `provider_diagnostic_json TEXT NOT NULL DEFAULT '${DEFAULT_PROVIDER_DIAGNOSTIC_JSON}'`;
const RUNTIME_EVIDENCE_REQUEST_METRICS_COLUMN_SQL =
  "request_metrics_json TEXT NOT NULL DEFAULT '[]'";
const RUNTIME_ACTIVITY_SCHEMA_V12_SQL = `
  CREATE TABLE execution_task_runtime_activities (
    tenant_scope TEXT NOT NULL,
    task_id TEXT NOT NULL,
    activity_id TEXT NOT NULL,
    sequence INTEGER NOT NULL CHECK (sequence > 0 AND sequence <= 10000),
    contract_version TEXT NOT NULL CHECK (contract_version = 'runtime-safe-activity.v1'),
    kind TEXT NOT NULL CHECK (kind IN ('tool', 'skill')),
    subject_id TEXT NOT NULL,
    display_name TEXT NOT NULL,
    action_code TEXT NOT NULL,
    operation_code TEXT,
    status TEXT NOT NULL CHECK (status IN (
      'started', 'completed', 'blocked', 'failed', 'rejected', 'target_rejected'
    )),
    updated_at TEXT NOT NULL,
    PRIMARY KEY (tenant_scope, task_id, activity_id),
    UNIQUE (tenant_scope, task_id, sequence),
    FOREIGN KEY (tenant_scope, task_id) REFERENCES execution_tasks (tenant_scope, task_id) ON DELETE CASCADE
  );
  CREATE INDEX execution_task_runtime_activities_order_idx
    ON execution_task_runtime_activities (tenant_scope, task_id, sequence);
`;
const ARTIFACT_SCHEMA_SQL = `
  CREATE TABLE execution_artifact_objects (
    tenant_scope TEXT NOT NULL,
    sha256 TEXT NOT NULL CHECK (length(sha256) = 64 AND sha256 NOT GLOB '*[^a-f0-9]*'),
    size_bytes INTEGER NOT NULL CHECK (size_bytes > 0),
    created_at TEXT NOT NULL,
    PRIMARY KEY (tenant_scope, sha256)
  );
  CREATE TABLE execution_task_artifacts (
    tenant_scope TEXT NOT NULL,
    task_id TEXT NOT NULL,
    artifact_id TEXT NOT NULL,
    contract_version TEXT NOT NULL CHECK (contract_version = '${ARTIFACT_REF_CONTRACT_VERSION}'),
    employee_id TEXT NOT NULL,
    file_name TEXT NOT NULL,
    mime_type TEXT NOT NULL,
    size_bytes INTEGER NOT NULL CHECK (size_bytes > 0),
    sha256 TEXT NOT NULL CHECK (length(sha256) = 64 AND sha256 NOT GLOB '*[^a-f0-9]*'),
    object_sha256 TEXT NOT NULL CHECK (length(object_sha256) = 64 AND object_sha256 NOT GLOB '*[^a-f0-9]*'),
    created_at TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    visibility_scope TEXT NOT NULL CHECK (visibility_scope = 'task_submitter'),
    PRIMARY KEY (tenant_scope, artifact_id),
    UNIQUE (tenant_scope, task_id, artifact_id),
    FOREIGN KEY (tenant_scope, task_id) REFERENCES execution_tasks (tenant_scope, task_id) ON DELETE CASCADE,
    FOREIGN KEY (tenant_scope, object_sha256) REFERENCES execution_artifact_objects (tenant_scope, sha256),
    CHECK (sha256 = object_sha256)
  );
  CREATE INDEX execution_task_artifacts_task_idx
    ON execution_task_artifacts (tenant_scope, task_id, created_at, artifact_id);
  CREATE INDEX execution_task_artifacts_expiry_idx
    ON execution_task_artifacts (tenant_scope, expires_at);
`;
const REUSABLE_ARTIFACT_GRANT_SCHEMA_SQL = `
  CREATE TABLE execution_reusable_artifact_grants (
    tenant_scope TEXT NOT NULL,
    grant_id TEXT NOT NULL,
    contract_version TEXT NOT NULL CHECK (contract_version = '${REUSABLE_ARTIFACT_GRANT_CONTRACT_VERSION}'),
    actor_issuer TEXT NOT NULL,
    actor_subject_digest TEXT NOT NULL CHECK (
      length(actor_subject_digest) = 64 AND actor_subject_digest NOT GLOB '*[^a-f0-9]*'
    ),
    scope_type TEXT NOT NULL CHECK (scope_type = 'personal'),
    source_task_id TEXT NOT NULL,
    artifact_id TEXT NOT NULL,
    created_at TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    PRIMARY KEY (tenant_scope, grant_id),
    UNIQUE (tenant_scope, actor_issuer, actor_subject_digest, artifact_id),
    FOREIGN KEY (tenant_scope, source_task_id, artifact_id)
      REFERENCES execution_task_artifacts (tenant_scope, task_id, artifact_id)
  );
  CREATE INDEX execution_reusable_artifact_grants_actor_idx
    ON execution_reusable_artifact_grants (
      tenant_scope, actor_issuer, actor_subject_digest, expires_at, created_at, grant_id
    );
`;
const ARTIFACT_RETENTION_SCHEMA_V11_SQL = `
  CREATE TABLE execution_artifact_ref_retirements (
    tenant_scope TEXT NOT NULL,
    artifact_id TEXT NOT NULL,
    contract_version TEXT NOT NULL CHECK (contract_version = 'artifact-ref-retirement.v1'),
    retired_at TEXT NOT NULL,
    reason_code TEXT NOT NULL CHECK (reason_code = 'ttl_expired'),
    PRIMARY KEY (tenant_scope, artifact_id),
    FOREIGN KEY (tenant_scope, artifact_id)
      REFERENCES execution_task_artifacts (tenant_scope, artifact_id)
  );
  CREATE INDEX execution_artifact_ref_retirements_time_idx
    ON execution_artifact_ref_retirements (tenant_scope, retired_at, artifact_id);
  CREATE TABLE execution_artifact_object_lifecycle (
    tenant_scope TEXT NOT NULL,
    object_sha256 TEXT NOT NULL CHECK (
      length(object_sha256) = 64 AND object_sha256 NOT GLOB '*[^a-f0-9]*'
    ),
    contract_version TEXT NOT NULL CHECK (contract_version = 'artifact-object-lifecycle.v1'),
    state TEXT NOT NULL CHECK (state IN ('present', 'delete_pending', 'deleted', 'reconcile_required')),
    generation INTEGER NOT NULL CHECK (generation >= 0),
    attempt_count INTEGER NOT NULL CHECK (attempt_count >= 0),
    last_result_code TEXT CHECK (
      last_result_code IS NULL OR (
        length(last_result_code) BETWEEN 1 AND 80 AND
        last_result_code NOT GLOB '*[^a-z0-9_]*'
      )
    ),
    cleanup_requested_at TEXT,
    updated_at TEXT NOT NULL,
    deleted_at TEXT,
    PRIMARY KEY (tenant_scope, object_sha256),
    FOREIGN KEY (tenant_scope, object_sha256)
      REFERENCES execution_artifact_objects (tenant_scope, sha256),
    CHECK (
      (state = 'present' AND cleanup_requested_at IS NULL AND deleted_at IS NULL)
      OR (state = 'delete_pending' AND cleanup_requested_at IS NOT NULL AND deleted_at IS NULL)
      OR (state = 'deleted' AND cleanup_requested_at IS NOT NULL AND deleted_at IS NOT NULL)
      OR (state = 'reconcile_required' AND deleted_at IS NULL)
    )
  );
  CREATE INDEX execution_artifact_object_lifecycle_state_idx
    ON execution_artifact_object_lifecycle (state, updated_at, tenant_scope, object_sha256);
  CREATE INDEX execution_task_artifacts_object_expiry_v11_idx
    ON execution_task_artifacts (tenant_scope, object_sha256, expires_at, artifact_id);
  CREATE INDEX execution_reusable_artifact_grants_expiry_v11_idx
    ON execution_reusable_artifact_grants (expires_at, tenant_scope, grant_id);
  CREATE INDEX execution_reusable_artifact_grants_source_expiry_v11_idx
    ON execution_reusable_artifact_grants (
      tenant_scope, source_task_id, artifact_id, expires_at, grant_id
    );
`;
const TASK_EVENT_SCHEMA_V8_SQL = `
  CREATE TABLE IF NOT EXISTS execution_task_events (
    tenant_scope TEXT NOT NULL,
    task_id TEXT NOT NULL,
    seq INTEGER NOT NULL CHECK (seq > 0),
    event_key TEXT NOT NULL,
    ownership_digest TEXT,
    contract_version TEXT NOT NULL CHECK (contract_version = 'task-event.v1'),
    event_type TEXT NOT NULL CHECK (event_type IN ('task.state_changed', 'task.progress', 'task.result_available')),
    occurred_at TEXT NOT NULL,
    task_revision INTEGER NOT NULL CHECK (task_revision > 0),
    status TEXT,
    wait_reason_code TEXT,
    last_error_code TEXT,
    attempt_count INTEGER,
    recovery_count INTEGER,
    progress_stage TEXT,
    progress_status TEXT,
    presentation_code TEXT,
    result_kind TEXT,
    PRIMARY KEY(tenant_scope, task_id, seq),
    UNIQUE(tenant_scope, task_id, event_key),
    FOREIGN KEY(tenant_scope, task_id) REFERENCES execution_tasks(tenant_scope, task_id) ON DELETE CASCADE,
    CHECK (
      (event_type = 'task.state_changed' AND status IS NOT NULL
        AND attempt_count IS NOT NULL AND recovery_count IS NOT NULL
        AND progress_stage IS NULL AND progress_status IS NULL AND result_kind IS NULL
        AND ownership_digest IS NULL)
      OR
      (event_type = 'task.progress' AND status IS NULL
        AND wait_reason_code IS NULL AND last_error_code IS NULL
        AND attempt_count IS NULL AND recovery_count IS NULL
        AND progress_stage IS NOT NULL AND progress_status IS NOT NULL
        AND presentation_code IS NOT NULL AND result_kind IS NULL
        AND ownership_digest IS NOT NULL)
      OR
      (event_type = 'task.result_available' AND status IS NULL
        AND wait_reason_code IS NULL AND last_error_code IS NULL
        AND attempt_count IS NULL AND recovery_count IS NULL
        AND progress_stage IS NULL AND progress_status IS NULL
        AND presentation_code IS NULL AND result_kind = 'conversation_history'
        AND ownership_digest IS NOT NULL)
    )
  );
  CREATE INDEX IF NOT EXISTS execution_task_events_lookup_idx
    ON execution_task_events(tenant_scope, task_id, seq);
`;
const TASK_EVENT_SCHEMA_V9_SQL = `
  CREATE TABLE execution_task_events_v9 (
    tenant_scope TEXT NOT NULL,
    task_id TEXT NOT NULL,
    seq INTEGER NOT NULL CHECK (seq > 0),
    event_key TEXT NOT NULL,
    ownership_digest TEXT,
    contract_version TEXT NOT NULL CHECK (contract_version = 'task-event.v1'),
    event_type TEXT NOT NULL CHECK (event_type IN (
      'task.state_changed', 'task.progress', 'task.result_available', 'task.artifact_available'
    )),
    occurred_at TEXT NOT NULL,
    task_revision INTEGER NOT NULL CHECK (task_revision > 0),
    status TEXT,
    wait_reason_code TEXT,
    last_error_code TEXT,
    attempt_count INTEGER,
    recovery_count INTEGER,
    progress_stage TEXT,
    progress_status TEXT,
    presentation_code TEXT,
    result_kind TEXT,
    artifact_id TEXT,
    PRIMARY KEY(tenant_scope, task_id, seq),
    UNIQUE(tenant_scope, task_id, event_key),
    FOREIGN KEY(tenant_scope, task_id) REFERENCES execution_tasks(tenant_scope, task_id) ON DELETE CASCADE,
    FOREIGN KEY(tenant_scope, task_id, artifact_id)
      REFERENCES execution_task_artifacts(tenant_scope, task_id, artifact_id),
    CHECK (
      (event_type = 'task.state_changed' AND status IS NOT NULL
        AND attempt_count IS NOT NULL AND recovery_count IS NOT NULL
        AND progress_stage IS NULL AND progress_status IS NULL AND result_kind IS NULL
        AND artifact_id IS NULL AND ownership_digest IS NULL)
      OR
      (event_type = 'task.progress' AND status IS NULL
        AND wait_reason_code IS NULL AND last_error_code IS NULL
        AND attempt_count IS NULL AND recovery_count IS NULL
        AND progress_stage IS NOT NULL AND progress_status IS NOT NULL
        AND presentation_code IS NOT NULL AND result_kind IS NULL
        AND artifact_id IS NULL AND ownership_digest IS NOT NULL)
      OR
      (event_type = 'task.result_available' AND status IS NULL
        AND wait_reason_code IS NULL AND last_error_code IS NULL
        AND attempt_count IS NULL AND recovery_count IS NULL
        AND progress_stage IS NULL AND progress_status IS NULL
        AND presentation_code IS NULL AND result_kind = 'conversation_history'
        AND artifact_id IS NULL AND ownership_digest IS NOT NULL)
      OR
      (event_type = 'task.artifact_available' AND status IS NULL
        AND wait_reason_code IS NULL AND last_error_code IS NULL
        AND attempt_count IS NULL AND recovery_count IS NULL
        AND progress_stage IS NULL AND progress_status IS NULL
        AND presentation_code IS NULL AND result_kind IS NULL
        AND artifact_id IS NOT NULL AND ownership_digest IS NOT NULL)
    )
  );
`;

export function createSqliteExecutionTaskRepository({
  databasePath,
  efficiencyFingerprintKey = null,
  receiptEncryptionKey = null,
  personalAutomationSchemaPhase = "activate",
  workGoalContextSchemaPhase = "inactive",
  deviceReadSchemaPhase = "inactive",
} = {}) {
  if (!["prepare", "activate"].includes(personalAutomationSchemaPhase)) throw new TypeError("personal automation schema phase invalid");
  if (!["inactive", "prepare", "activate"].includes(workGoalContextSchemaPhase) ||
    (workGoalContextSchemaPhase !== "inactive" && personalAutomationSchemaPhase !== "activate")) throw new TypeError("work goal schema phase invalid");
  const safeDatabasePath = requiredDatabasePath(databasePath);
  if (safeDatabasePath !== ":memory:") fs.mkdirSync(path.dirname(safeDatabasePath), { recursive: true });
  const database = new DatabaseSync(safeDatabasePath);
  let schemaVersion, receiptCipher, opsIncidentDiagnosisStore, deviceReads;
  try {
    initializeDatabase(database, { efficiencyFingerprintKey, personalAutomationSchemaPhase });
    if (workGoalContextSchemaPhase !== "inactive") {
      database.exec("BEGIN IMMEDIATE");
      try {
        createWorkGoalBindingSchemaV26(database);
        const version = database.prepare("SELECT version FROM execution_task_schema WHERE singleton=1").get().version;
        validateWorkGoalBindingSchemaV26(database, { requireEmpty: version === 25 });
        if (workGoalContextSchemaPhase === "activate" && version === 25) {
          const migrated = database.prepare("UPDATE execution_task_schema SET version=26 WHERE singleton=1 AND version=25").run();
          if (migrated.changes !== 1) throw executionTaskError("execution_task_schema_migration_conflict", "goal binding migration conflict");
        }
        database.exec("COMMIT");
      } catch (error) { rollbackIfActive(database); throw error; }
    }
    schemaVersion = database.prepare("SELECT version FROM execution_task_schema WHERE singleton=1").get().version;
    receiptCipher = createReceiptCipher(receiptEncryptionKey);
    opsIncidentDiagnosisStore = createOpsIncidentDiagnosisStore({ database, executionTaskError });
    deviceReads = createDeviceReadAttemptRepository({ database, phase: deviceReadSchemaPhase,
      readTask: readByTaskId, ownsLiveLease, normalizeLeaseIdentity, rollbackIfActive });
  } catch (error) {
    if (database.isOpen !== false) {
      try { database.close(); } catch (cleanupError) {
        if (cleanupError.code !== "ERR_INVALID_STATE") throw new AggregateError([error, cleanupError], "execution_task_initialization_failed", { cause: error });
      }
    }
    throw error;
  }

  // Metadata activation is not execution activation. Until the shared Runtime
  // validates goal/budget context, bound tasks cannot enter the Worker queue.
  const goalBindingAdmissionSql = schemaVersion >= 26 ? `AND NOT EXISTS (
    SELECT 1 FROM work_goal_task_bindings b
    WHERE b.tenant_scope=execution_tasks.tenant_scope AND b.task_id=execution_tasks.task_id
  )` : "";

  function assertSubmissionCompatible(value, { now = new Date() } = {}) {
    const submission = normalizeExecutionTaskSubmission(value, { now });
    const existing = readBySubmissionKey(submission.tenantScope, submission.submissionScope, submission.idempotencyKey) ||
      readByTaskId(submission.taskId, submission.tenantScope);
    if (existing && !isSameImmutableSubmission(existing, submission)) {
      throw executionTaskError(
        "execution_task_idempotency_conflict",
        "the execution task identity already belongs to a different immutable submission",
      );
    }
    return existing;
  }

  function submitOrGet(...args) {
    database.exec("BEGIN IMMEDIATE");
    try {
      const result = submitOrGetInTransaction(...args);
      database.exec("COMMIT");
      return result;
    } catch (error) {
      rollbackIfActive(database);
      throw error;
    }
  }

  function submitOrGetInTransaction(value, { now = new Date() } = {}) {
    const submission = normalizeExecutionTaskSubmission(value, { now });
    const nowIso = normalizedExecutionTaskNow(now);
    try {
      const existing = readBySubmissionKey(
        submission.tenantScope,
        submission.submissionScope,
        submission.idempotencyKey,
      );
      if (existing) {
        if (!isSameImmutableSubmission(existing, submission)) {
          throw executionTaskError(
            "execution_task_idempotency_conflict",
            "the execution task submission key was already used for a different immutable submission",
          );
        }
        return Object.freeze({ created: false, task: existing });
      }
      const taskCancellationFence = readScheduleCancellationFence(
        submission.tenantScope,
        submission.taskId,
      );
      const submissionCancellationFence = readScheduleCancellationFenceBySubmissionKey(
        submission.tenantScope,
        submission.submissionScope,
        submission.idempotencyKey,
      );
      if (taskCancellationFence && submissionCancellationFence &&
        taskCancellationFence.task_id !== submissionCancellationFence.task_id) {
        throw executionTaskError(
          "execution_task_schedule_cancel_fence_conflict",
          "Schedule cancellation task and submission identities resolve to different fences",
        );
      }
      const cancellationFence = taskCancellationFence || submissionCancellationFence;
      if (cancellationFence) assertSubmissionMatchesScheduleCancellationFence(submission, cancellationFence);
      const fenced = Boolean(cancellationFence);
      database.prepare(`
        INSERT INTO execution_tasks (
          task_id, contract_version, revision,
          tenant_scope, actor_issuer, actor_subject_digest,
          employee_id, employee_version, session_id,
          source_system_id, channel_id, task_type,
          submission_scope, idempotency_key, input_digest,
          execution_input_kind, execution_input_ref_id, workspace_ref,
          priority, queue_order, status, wait_reason_code, available_at,
          attempt_count, recovery_count, max_recoveries,
          execution_deadline_at, timeout_policy_version,
          timeout_connect_ms, timeout_first_output_ms, timeout_stream_idle_ms,
          timeout_request_total_ms, timeout_task_total_ms, fencing_token,
          created_at, queued_at, finished_at, updated_at, last_error_code
        ) VALUES (?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0,
          ?, ?, ?, 0, 0, ?, NULL, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?)
      `).run(
        submission.taskId,
        submission.contractVersion,
        submission.tenantScope,
        submission.actorIssuer,
        submission.actorSubjectDigest,
        submission.employeeId,
        submission.employeeVersion,
        submission.sessionId,
        submission.sourceSystemId,
        submission.channelId,
        submission.taskType,
        submission.submissionScope,
        submission.idempotencyKey,
        submission.inputDigest,
        submission.executionInputRef.kind,
        submission.executionInputRef.refId,
        submission.workspaceRef,
        submission.priority,
        fenced ? "canceled" : "queued",
        fenced ? null : "awaiting_worker",
        submission.availableAt,
        submission.maxRecoveries,
        submission.providerTimeoutPolicy.policyVersion,
        submission.providerTimeoutPolicy.connectMs,
        submission.providerTimeoutPolicy.firstSemanticOutputMs,
        submission.providerTimeoutPolicy.streamIdleMs,
        submission.providerTimeoutPolicy.requestTotalMs,
        submission.providerTimeoutPolicy.taskExecutionTotalMs,
        submission.createdAt,
        submission.createdAt,
        fenced ? nowIso : null,
        fenced ? nowIso : submission.createdAt,
        fenced ? "schedule_task_cancellation_fenced" : null,
      );
      const queued = database.prepare(`
        UPDATE execution_tasks SET queue_order = enqueue_seq
        WHERE tenant_scope = ? AND task_id = ? AND queue_order = 0
      `).run(submission.tenantScope, submission.taskId);
      if (queued.changes !== 1) {
        throw executionTaskError(
          "runtime_task_queue_order_conflict",
          "execution task queue order could not bind to its canonical enqueue sequence",
        );
      }
      appendStateEventInTransaction(readByTaskId(submission.taskId, submission.tenantScope), {
        code: fenced ? "task_canceled" : "task_submitted",
      });
      const task = readByTaskId(submission.taskId, submission.tenantScope);
      return Object.freeze({ created: true, task });
    } catch (error) {
      if (String(error?.message || "").includes("execution_tasks.task_id")) {
        throw executionTaskError("execution_task_id_conflict", "execution taskId already exists");
      }
      throw error;
    }
  }

  function get(taskId, { tenantScope } = {}) {
    return readByTaskId(
      requiredExecutionTaskToken(taskId, "taskId", 128),
      requiredExecutionTaskToken(tenantScope, "tenantScope", 160),
    );
  }

  function list({ tenantScope, employeeId = null, employeeIds = null, status = null, order = "queue", limit = 100, offset = 0 } = {}) {
    const safeTenantScope = requiredExecutionTaskToken(tenantScope, "tenantScope", 160);
    if (employeeId !== null && employeeIds !== null) throw executionTaskError("execution_task_employee_filter_conflict");
    const safeEmployeeIds = employeeIds === null
      ? employeeId === null ? null : [requiredExecutionTaskToken(employeeId, "employeeId", 160)]
      : Array.from(new Set((Array.isArray(employeeIds) ? employeeIds : []).map((value) =>
        requiredExecutionTaskToken(value, "employeeId", 160)
      )));
    if (safeEmployeeIds !== null && safeEmployeeIds.length === 0) throw executionTaskError("execution_task_employee_filter_empty");
    const safeStatus = status === null ? null : requiredExecutionTaskToken(status, "status", 40);
    const orderBy = runtimeTaskListOrder(order);
    const safeLimit = boundedPositiveInteger(limit, "limit", 1, 500);
    const safeOffset = boundedNonNegativeInteger(offset, "offset", 10_000);
    const employeeClause = safeEmployeeIds === null
      ? ""
      : `AND employee_id IN (${safeEmployeeIds.map(() => "?").join(", ")})`;
    const rows = database.prepare(`
      SELECT *
      FROM execution_tasks
      WHERE tenant_scope = ?
        ${employeeClause}
        AND (? IS NULL OR status = ?)
      ORDER BY ${orderBy}
      LIMIT ?
      OFFSET ?
    `).all(
      safeTenantScope,
      ...(safeEmployeeIds || []),
      safeStatus,
      safeStatus,
      safeLimit,
      safeOffset,
    );
    const evidenceByTask = readRuntimeEvidenceForTaskIds(
      safeTenantScope,
      rows.map((row) => row.task_id),
    );
    const activitiesByTask = readRuntimeActivitiesForTaskIds(
      safeTenantScope,
      rows.map((row) => row.task_id),
    );
    const provenanceByTask = readRuntimeSafeProvenanceForTasks(database, rows);
    const efficiencyByTask = readRuntimeToolEfficiencyForTasks(database, rows, {
      fingerprintKey: efficiencyFingerprintKey,
    });
    return rows.map((row) => rowToTask(
      row,
      evidenceByTask.get(row.task_id) || null,
      activitiesByTask.get(row.task_id) || null,
      provenanceByTask.get(row.task_id) || null,
      efficiencyByTask.get(row.task_id) || null,
    ));
  }

  function listByActor({
    tenantScope,
    actorIssuer,
    actorSubjectDigest,
    employeeIds = null,
    statuses = null,
    excludedTaskTypes = [],
    order = "queue",
    limit = 100,
  } = {}) {
    const rows = listCurrentUserRuntimeTaskRows(database, {
      tenantScope,
      actorIssuer,
      actorSubjectDigest,
      employeeIds,
      statuses,
      excludedTaskTypes,
      order,
      limit,
    });
    const evidenceByTask = readRuntimeEvidenceForTaskIds(tenantScope, rows.map((row) => row.task_id));
    const activitiesByTask = readRuntimeActivitiesForTaskIds(tenantScope, rows.map((row) => row.task_id));
    const provenanceByTask = readRuntimeSafeProvenanceForTasks(database, rows);
    const efficiencyByTask = readRuntimeToolEfficiencyForTasks(database, rows, {
      fingerprintKey: efficiencyFingerprintKey,
    });
    return rows.map((row) => rowToTask(
      row,
      evidenceByTask.get(row.task_id) || null,
      activitiesByTask.get(row.task_id) || null,
      provenanceByTask.get(row.task_id) || null,
      efficiencyByTask.get(row.task_id) || null,
    ));
  }

  function reorderQueuedByActor({
    tenantScope,
    actorIssuer,
    actorSubjectDigest,
    employeeId,
    employeeIds = null,
    expectedRevision,
    orderedTaskIds,
  } = {}) {
    const result = reorderCurrentUserRuntimeTaskRows(database, {
      tenantScope,
      actorIssuer,
      actorSubjectDigest,
      employeeId,
      employeeIds,
      expectedRevision,
      orderedTaskIds,
    });
    return Object.freeze({
      changed: result.changed,
      revision: result.revision,
      tasks: Object.freeze(result.rows.map((row) => rowToTask(row))),
    });
  }

  function summarizeUsageByEmployee({ tenantScope, employeeId = null } = {}) {
    const safeTenantScope = requiredExecutionTaskToken(tenantScope, "tenantScope", 160);
    const safeEmployeeId = employeeId === null
      ? null
      : requiredExecutionTaskToken(employeeId, "employeeId", 160);
    return database.prepare(`
      SELECT
        employee_id,
        COUNT(*) AS total_tasks,
        SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) AS completed_tasks,
        SUM(CASE WHEN status = 'completed' AND channel_id = 'trigger' THEN 1 ELSE 0 END) AS trigger_completed_tasks,
        SUM(CASE WHEN status = 'completed' AND channel_id <> 'trigger' THEN 1 ELSE 0 END) AS non_trigger_completed_tasks,
        MAX(updated_at) AS updated_at
      FROM execution_tasks
      WHERE tenant_scope = ?
        AND (? IS NULL OR employee_id = ?)
      GROUP BY employee_id
      ORDER BY employee_id ASC
    `).all(safeTenantScope, safeEmployeeId, safeEmployeeId).map((row) => Object.freeze({
      employeeId: row.employee_id,
      totalTasks: Number(row.total_tasks || 0),
      completedTasks: Number(row.completed_tasks || 0),
      triggerCompletedTasks: Number(row.trigger_completed_tasks || 0),
      nonTriggerCompletedTasks: Number(row.non_trigger_completed_tasks || 0),
      updatedAt: row.updated_at || "",
    }));
  }

  function peekNextQueued({ tenantScope, employeeId } = {}) {
    const safeTenantScope = requiredExecutionTaskToken(tenantScope, "tenantScope", 160);
    const safeEmployeeId = requiredExecutionTaskToken(employeeId, "employeeId", 160);
    const row = database.prepare(`
      SELECT *
      FROM execution_tasks
      WHERE tenant_scope = ? AND employee_id = ? AND status = 'queued'
        ${goalBindingAdmissionSql}
      ORDER BY queue_order ASC, enqueue_seq ASC
      LIMIT 1
    `).get(safeTenantScope, safeEmployeeId);
    return row ? rowToTask(row) : null;
  }

  function claimNext({
    tenantScope,
    workerIdDigest,
    employeeId = null,
    leaseDurationMs = DEFAULT_LEASE_DURATION_MS,
    maxGlobalLeases = Number.MAX_SAFE_INTEGER,
    maxActorLeases = Number.MAX_SAFE_INTEGER,
    maxEmployeeLeases = 1,
    resolveMaxEmployeeLeases = null,
    now = new Date(),
  } = {}) {
    const safeTenantScope = requiredExecutionTaskToken(tenantScope, "tenantScope", 160);
    const safeWorkerIdDigest = requiredExecutionTaskDigest(workerIdDigest, "workerIdDigest");
    const safeEmployeeId = employeeId === null
      ? null
      : requiredExecutionTaskToken(employeeId, "employeeId", 160);
    const safeLeaseDurationMs = boundedPositiveInteger(leaseDurationMs, "leaseDurationMs", 1, 86_400_000);
    const limits = {
      global: boundedPositiveInteger(maxGlobalLeases, "maxGlobalLeases", 1, Number.MAX_SAFE_INTEGER),
      actor: boundedPositiveInteger(maxActorLeases, "maxActorLeases", 1, Number.MAX_SAFE_INTEGER),
      employee: boundedPositiveInteger(maxEmployeeLeases, "maxEmployeeLeases", 1, Number.MAX_SAFE_INTEGER),
      resolveEmployee: typeof resolveMaxEmployeeLeases === "function" ? resolveMaxEmployeeLeases : null,
    };
    const nowIso = normalizedExecutionTaskNow(now);
    const leaseExpiresAt = new Date(new Date(nowIso).getTime() + safeLeaseDurationMs).toISOString();
    database.exec("BEGIN IMMEDIATE");
    try {
      reconcileExpiredLeasesInTransaction(nowIso, safeTenantScope);
      const queueProjection = refreshWaitReasonsInTransaction(nowIso, safeTenantScope, limits);
      if (queueProjection.activeCount >= limits.global) {
        database.exec("COMMIT");
        return null;
      }
      const candidates = database.prepare(`
        SELECT *
        FROM execution_tasks
        WHERE tenant_scope = ?
          AND status = 'queued'
          AND available_at <= ?
          AND (? IS NULL OR employee_id = ?)
          ${goalBindingAdmissionSql}
        ORDER BY queue_order ASC, enqueue_seq ASC
      `).all(safeTenantScope, nowIso, safeEmployeeId, safeEmployeeId);
      const candidate = candidates.find((row) => row.wait_reason_code === "awaiting_worker") || null;
      if (!candidate) {
        database.exec("COMMIT");
        return null;
      }
      const leaseId = `lease_${crypto.randomUUID()}`;
      const executionDeadlineAt = candidate.execution_deadline_at || new Date(
        new Date(nowIso).getTime() + Number(candidate.timeout_task_total_ms),
      ).toISOString();
      const result = database.prepare(`
        UPDATE execution_tasks
        SET status = 'running', wait_reason_code = NULL,
            revision = revision + 1, attempt_count = attempt_count + 1,
            fencing_token = fencing_token + 1,
            lease_id = ?, worker_id_digest = ?, claimed_at = ?, heartbeat_at = ?, lease_expires_at = ?,
            execution_deadline_at = COALESCE(execution_deadline_at, ?),
            started_at = COALESCE(started_at, ?), updated_at = ?
        WHERE task_id = ? AND status = 'queued'
          ${goalBindingAdmissionSql}
      `).run(
        leaseId,
        safeWorkerIdDigest,
        nowIso,
        nowIso,
        leaseExpiresAt,
        executionDeadlineAt,
        nowIso,
        nowIso,
        candidate.task_id,
      );
      if (result.changes !== 1) {
        throw executionTaskError("execution_task_claim_conflict", "execution task claim lost its atomic transition");
      }
      refreshWaitReasonsInTransaction(nowIso, safeTenantScope, limits);
      appendStateEventInTransaction(readByTaskId(candidate.task_id, safeTenantScope), {
        code: "worker_claimed",
      });
      const task = readByTaskId(candidate.task_id, safeTenantScope);
      database.exec("COMMIT");
      return task;
    } catch (error) {
      rollbackIfActive(database);
      throw error;
    }
  }

  function renewLease({
    tenantScope,
    taskId,
    leaseId,
    workerIdDigest,
    fencingToken,
    leaseDurationMs = DEFAULT_LEASE_DURATION_MS,
    now = new Date(),
  } = {}) {
    const identity = normalizeLeaseIdentity({ tenantScope, taskId, leaseId, workerIdDigest, fencingToken });
    const safeLeaseDurationMs = boundedPositiveInteger(leaseDurationMs, "leaseDurationMs", 1, 86_400_000);
    const nowIso = normalizedExecutionTaskNow(now);
    const leaseExpiresAt = new Date(new Date(nowIso).getTime() + safeLeaseDurationMs).toISOString();
    database.exec("BEGIN IMMEDIATE");
    try {
      timeoutExpiredTaskInTransaction(nowIso, identity.tenantScope, identity.taskId);
      const result = database.prepare(`
        UPDATE execution_tasks
        SET heartbeat_at = ?, lease_expires_at = ?, updated_at = ?, revision = revision + 1
        WHERE tenant_scope = ? AND task_id = ? AND status = 'running'
          AND lease_id = ? AND worker_id_digest = ? AND fencing_token = ?
          AND lease_expires_at > ?
      `).run(
        nowIso,
        leaseExpiresAt,
        nowIso,
        identity.tenantScope,
        identity.taskId,
        identity.leaseId,
        identity.workerIdDigest,
        identity.fencingToken,
        nowIso,
      );
      if (result.changes !== 1) {
        database.exec("COMMIT");
        return null;
      }
      const task = readByTaskId(identity.taskId, identity.tenantScope);
      database.exec("COMMIT");
      return task;
    } catch (error) {
      rollbackIfActive(database);
      throw error;
    }
  }

  function settleWithLease({
    tenantScope,
    taskId,
    leaseId,
    workerIdDigest,
    fencingToken,
    status,
    lastErrorCode = null,
    resultSummary = null,
    terminalEvidenceDigest = null,
    now = new Date(),
  } = {}) {
    const identity = normalizeLeaseIdentity({ tenantScope, taskId, leaseId, workerIdDigest, fencingToken });
    const settlement = normalizeExecutionTaskSettlement({
      status,
      lastErrorCode,
      resultSummary,
      terminalEvidenceDigest,
    });
    const nowIso = normalizedExecutionTaskNow(now);
    database.exec("BEGIN IMMEDIATE");
    try {
      if (settlement.status !== "timed_out") {
        timeoutExpiredTaskInTransaction(nowIso, identity.tenantScope, identity.taskId);
      }
      const result = database.prepare(`
        UPDATE execution_tasks
        SET status = ?, last_error_code = ?, result_summary = ?, terminal_evidence_digest = ?,
            finished_at = ?, updated_at = ?, revision = revision + 1,
            lease_id = NULL, worker_id_digest = NULL, claimed_at = NULL,
            heartbeat_at = NULL, lease_expires_at = NULL
        WHERE tenant_scope = ? AND task_id = ? AND status = 'running'
          AND lease_id = ? AND worker_id_digest = ? AND fencing_token = ?
          AND lease_expires_at > ?
      `).run(
        settlement.status,
        settlement.lastErrorCode,
        settlement.resultSummary,
        settlement.terminalEvidenceDigest,
        nowIso,
        nowIso,
        identity.tenantScope,
        identity.taskId,
        identity.leaseId,
        identity.workerIdDigest,
        identity.fencingToken,
        nowIso,
      );
      if (result.changes !== 1) {
        if (settlement.status === "timed_out") {
          timeoutExpiredTaskInTransaction(nowIso, identity.tenantScope, identity.taskId);
        }
        database.exec("COMMIT");
        return null;
      }
      appendStateEventInTransaction(readByTaskId(identity.taskId, identity.tenantScope), {
        code: "worker_settled",
      });
      const task = readByTaskId(identity.taskId, identity.tenantScope);
      database.exec("COMMIT");
      return task;
    } catch (error) {
      rollbackIfActive(database);
      throw error;
    }
  }

  function releaseToWaitingWithLease({
    tenantScope,
    taskId,
    leaseId,
    workerIdDigest,
    fencingToken,
    waitReasonCode,
    lastErrorCode = null,
    resultSummary = null,
    now = new Date(),
  } = {}) {
    const identity = normalizeLeaseIdentity({ tenantScope, taskId, leaseId, workerIdDigest, fencingToken });
    const reason = requiredExecutionTaskToken(waitReasonCode, "waitReasonCode", 120);
    const safeErrorCode = lastErrorCode ? requiredExecutionTaskToken(lastErrorCode, "lastErrorCode", 120) : null;
    const safeResultSummary = normalizeImportSummary(resultSummary);
    const nowIso = normalizedExecutionTaskNow(now);
    database.exec("BEGIN IMMEDIATE");
    try {
      const result = database.prepare(`
        UPDATE execution_tasks
        SET status = 'waiting', wait_reason_code = ?, last_error_code = ?, result_summary = ?,
            updated_at = ?, revision = revision + 1,
            lease_id = NULL, worker_id_digest = NULL, claimed_at = NULL,
            heartbeat_at = NULL, lease_expires_at = NULL
        WHERE tenant_scope = ? AND task_id = ? AND status = 'running'
          AND lease_id = ? AND worker_id_digest = ? AND fencing_token = ?
          AND lease_expires_at > ?
      `).run(
        reason,
        safeErrorCode,
        safeResultSummary,
        nowIso,
        identity.tenantScope,
        identity.taskId,
        identity.leaseId,
        identity.workerIdDigest,
        identity.fencingToken,
        nowIso,
      );
      if (result.changes !== 1) {
        database.exec("COMMIT");
        return null;
      }
      appendStateEventInTransaction(readByTaskId(identity.taskId, identity.tenantScope), {
        code: "worker_waiting",
      });
      const task = readByTaskId(identity.taskId, identity.tenantScope);
      database.exec("COMMIT");
      return task;
    } catch (error) {
      rollbackIfActive(database);
      throw error;
    }
  }

  function markReady({ tenantScope, taskId, now = new Date() } = {}) {
    const safeTenantScope = requiredExecutionTaskToken(tenantScope, "tenantScope", 160);
    const safeTaskId = requiredExecutionTaskToken(taskId, "taskId", 128);
    const nowIso = normalizedExecutionTaskNow(now);
    database.exec("BEGIN IMMEDIATE");
    try {
      const result = database.prepare(`
        UPDATE execution_tasks
        SET status = 'queued', wait_reason_code = 'awaiting_worker', available_at = ?,
            updated_at = ?, revision = revision + 1
        WHERE tenant_scope = ? AND task_id = ? AND status = 'waiting'
      `).run(nowIso, nowIso, safeTenantScope, safeTaskId);
      if (result.changes !== 1) {
        database.exec("COMMIT");
        return null;
      }
      appendStateEventInTransaction(readByTaskId(safeTaskId, safeTenantScope), {
        code: "task_ready",
      });
      const task = readByTaskId(safeTaskId, safeTenantScope);
      database.exec("COMMIT");
      return task;
    } catch (error) {
      rollbackIfActive(database);
      throw error;
    }
  }

  function reconcileExpiredLeases({ tenantScope, now = new Date() } = {}) {
    const safeTenantScope = requiredExecutionTaskToken(tenantScope, "tenantScope", 160);
    const nowIso = normalizedExecutionTaskNow(now);
    database.exec("BEGIN IMMEDIATE");
    try {
      const result = reconcileExpiredLeasesInTransaction(nowIso, safeTenantScope);
      database.exec("COMMIT");
      return result;
    } catch (error) {
      rollbackIfActive(database);
      throw error;
    }
  }

  function cancel(...args) {
    database.exec("BEGIN IMMEDIATE");
    try {
      const result = cancelInTransaction(...args);
      database.exec("COMMIT");
      return result;
    } catch (error) {
      rollbackIfActive(database);
      throw error;
    }
  }

  function cancelInTransaction({
    tenantScope,
    taskId,
    reasonCode = "operator_requested",
    now = new Date(),
  } = {}) {
    const safeTenantScope = requiredExecutionTaskToken(tenantScope, "tenantScope", 160);
    const safeTaskId = requiredExecutionTaskToken(taskId, "taskId", 128);
    const safeReasonCode = requiredExecutionTaskToken(reasonCode, "reasonCode", 120);
    const nowIso = normalizedExecutionTaskNow(now);
    try {
      timeoutExpiredTaskInTransaction(nowIso, safeTenantScope, safeTaskId);
      const current = readByTaskId(safeTaskId, safeTenantScope);
      if (!current) {
        return Object.freeze({ changed: false, reason: "not_found", task: null });
      }
      if (!["queued", "running", "waiting"].includes(current.status)) {
        return Object.freeze({ changed: false, reason: "not_cancelable", task: current });
      }
      const result = database.prepare(`
        UPDATE execution_tasks
        SET status = 'canceled', wait_reason_code = NULL,
            finished_at = ?, updated_at = ?, revision = revision + 1,
            last_error_code = ?, fencing_token = fencing_token + 1,
            lease_id = NULL, worker_id_digest = NULL, claimed_at = NULL,
            heartbeat_at = NULL, lease_expires_at = NULL
        WHERE tenant_scope = ? AND task_id = ? AND status IN ('queued', 'running', 'waiting')
      `).run(nowIso, nowIso, safeReasonCode, safeTenantScope, safeTaskId);
      if (result.changes !== 1) {
        throw executionTaskError("execution_task_cancel_conflict", "execution task cancel lost its atomic transition");
      }
      appendStateEventInTransaction(readByTaskId(safeTaskId, safeTenantScope), {
        code: "task_canceled",
      });
      const task = readByTaskId(safeTaskId, safeTenantScope);
      return Object.freeze({ changed: true, reason: "canceled", task });
    } catch (error) {
      throw error;
    }
  }

  function cancelScheduledTaskOrFence({ expectedIdentity, stopGeneration, now = new Date() } = {}) {
    const identity = normalizeScheduleCancellationIdentity(expectedIdentity);
    const generation = boundedPositiveInteger(stopGeneration, "stopGeneration", 1, Number.MAX_SAFE_INTEGER);
    const nowIso = normalizedExecutionTaskNow(now);
    database.exec("BEGIN IMMEDIATE");
    try {
      timeoutExpiredTaskInTransaction(nowIso, identity.tenantScope, identity.taskId);
      const current = readByTaskId(identity.taskId, identity.tenantScope);
      if (current) {
        assertTaskMatchesScheduleCancellationIdentity(current, identity);
        if (!["queued", "running", "waiting"].includes(current.status)) {
          database.exec("COMMIT");
          return Object.freeze({
            changed: false,
            outcome: current.status,
            stopGeneration: generation,
            task: current,
          });
        }
        const canceled = database.prepare(`
          UPDATE execution_tasks
          SET status = 'canceled', wait_reason_code = NULL,
              finished_at = ?, updated_at = ?, revision = revision + 1,
              last_error_code = 'schedule_task_cancellation_fenced', fencing_token = fencing_token + 1,
              lease_id = NULL, worker_id_digest = NULL, claimed_at = NULL,
              heartbeat_at = NULL, lease_expires_at = NULL
          WHERE tenant_scope = ? AND task_id = ? AND status IN ('queued', 'running', 'waiting')
        `).run(nowIso, nowIso, identity.tenantScope, identity.taskId);
        if (canceled.changes !== 1) {
          throw executionTaskError(
            "execution_task_schedule_cancel_conflict",
            "Schedule execution task cancellation lost its atomic transition",
          );
        }
        appendStateEventInTransaction(readByTaskId(identity.taskId, identity.tenantScope), {
          code: "task_canceled",
        });
        const task = readByTaskId(identity.taskId, identity.tenantScope);
        database.exec("COMMIT");
        return Object.freeze({ changed: true, outcome: "canceled", stopGeneration: generation, task });
      }

      const existingFence = readScheduleCancellationFence(identity.tenantScope, identity.taskId);
      if (existingFence) {
        assertScheduleCancellationFenceMatchesIdentity(existingFence, identity);
        if (existingFence.stop_generation > generation) {
          throw executionTaskError(
            "execution_task_schedule_cancel_generation_conflict",
            "Schedule cancellation stopGeneration cannot move backwards",
          );
        }
        if (existingFence.stop_generation === generation) {
          database.exec("COMMIT");
          return Object.freeze({ changed: false, outcome: "fenced", stopGeneration: generation, task: null });
        }
        const updated = database.prepare(`
          UPDATE execution_schedule_cancel_fences
          SET stop_generation = ?, updated_at = ?
          WHERE tenant_scope = ? AND task_id = ? AND stop_generation = ?
        `).run(
          generation,
          nowIso,
          identity.tenantScope,
          identity.taskId,
          existingFence.stop_generation,
        );
        if (updated.changes !== 1) {
          throw executionTaskError(
            "execution_task_schedule_cancel_conflict",
            "Schedule cancellation fence generation update lost its atomic transition",
          );
        }
        database.exec("COMMIT");
        return Object.freeze({ changed: true, outcome: "fenced", stopGeneration: generation, task: null });
      }

      const conflictingFence = database.prepare(`
        SELECT task_id
        FROM execution_schedule_cancel_fences
        WHERE tenant_scope = ? AND submission_scope = ? AND idempotency_key = ?
      `).get(identity.tenantScope, identity.submissionScope, identity.idempotencyKey);
      if (conflictingFence) {
        throw executionTaskError(
          "execution_task_schedule_cancel_fence_conflict",
          "Schedule cancellation submission identity is already fenced for another task",
        );
      }
      database.prepare(`
        INSERT INTO execution_schedule_cancel_fences (
          tenant_scope, task_id, employee_id, source_system_id, channel_id, task_type,
          submission_scope, idempotency_key, execution_input_kind, execution_input_ref_id,
          stop_generation, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        identity.tenantScope,
        identity.taskId,
        identity.employeeId,
        identity.sourceSystemId,
        identity.channelId,
        identity.taskType,
        identity.submissionScope,
        identity.idempotencyKey,
        identity.executionInputRef.kind,
        identity.executionInputRef.refId,
        generation,
        nowIso,
        nowIso,
      );
      database.exec("COMMIT");
      return Object.freeze({ changed: true, outcome: "fenced", stopGeneration: generation, task: null });
    } catch (error) {
      rollbackIfActive(database);
      throw error;
    }
  }

  function reconcileExpiredLeasesInTransaction(nowIso, tenantScope) {
    const deadlineExpired = database.prepare(`
      SELECT task_id
      FROM execution_tasks
      WHERE tenant_scope = ? AND status IN ('queued', 'running', 'waiting')
        AND execution_deadline_at IS NOT NULL AND execution_deadline_at <= ?
      ORDER BY enqueue_seq ASC
    `).all(tenantScope, nowIso);
    let timedOut = 0;
    for (const row of deadlineExpired) {
      if (timeoutExpiredTaskInTransaction(nowIso, tenantScope, row.task_id)) timedOut += 1;
    }
    const expired = database.prepare(`
      SELECT task_id, recovery_count, max_recoveries
      FROM execution_tasks
      WHERE tenant_scope = ? AND status = 'running' AND lease_expires_at <= ?
      ORDER BY enqueue_seq ASC
    `).all(tenantScope, nowIso);
    let requeued = 0;
    let lost = 0;
    for (const row of expired) {
      if (settleExpiredToolLoopBreakerInTransaction(nowIso, tenantScope, row.task_id)) continue;
      const canRecover = row.recovery_count < row.max_recoveries;
      const nextStatus = canRecover ? "queued" : "lost";
      const result = database.prepare(`
        UPDATE execution_tasks
        SET status = ?, wait_reason_code = ?, recovery_count = recovery_count + ?,
            last_error_code = ?, finished_at = ?, updated_at = ?, revision = revision + 1,
            lease_id = NULL, worker_id_digest = NULL, claimed_at = NULL,
            heartbeat_at = NULL, lease_expires_at = NULL
        WHERE tenant_scope = ? AND task_id = ? AND status = 'running' AND lease_expires_at <= ?
      `).run(
        nextStatus,
        canRecover ? "awaiting_worker" : null,
        canRecover ? 1 : 0,
        canRecover ? "worker_lease_expired_requeued" : "worker_recovery_budget_exhausted",
        canRecover ? null : nowIso,
        nowIso,
        tenantScope,
        row.task_id,
        nowIso,
      );
      if (result.changes === 1) {
        appendStateEventInTransaction(readByTaskId(row.task_id, tenantScope), {
          code: canRecover ? "worker_lease_expired_requeued" : "worker_recovery_budget_exhausted",
        });
        if (canRecover) requeued += 1;
        else lost += 1;
      }
    }
    return Object.freeze({ examined: expired.length + deadlineExpired.length, requeued, lost, timedOut });
  }

  function settleExpiredToolLoopBreakerInTransaction(nowIso, tenantScope, taskId) {
    const row = database.prepare(`
      SELECT * FROM execution_tasks
      WHERE tenant_scope = ? AND task_id = ? AND status = 'running' AND lease_expires_at <= ?
    `).get(tenantScope, taskId, nowIso);
    if (!row) return false;
    const activitySnapshot = readRuntimeActivityState(tenantScope, taskId)?.activitySnapshot ||
      emptyRuntimeActivitySnapshot(taskId);
    const efficiencyState = readRuntimeToolEfficiencyState(database, row, {
      fingerprintKey: efficiencyFingerprintKey,
    });
    const sourceSnapshot = efficiencyState?.sourceSnapshot;
    const terminalActivities = activitySnapshot.activities.filter((activity) =>
      ["blocked", "completed", "failed", "rejected", "target_rejected"].includes(activity.status));
    const lastActivity = terminalActivities.at(-1);
    if (sourceSnapshot?.breaker?.status !== "triggered" ||
      sourceSnapshot.calls.length !== terminalActivities.length ||
      sourceSnapshot.breaker.activityId !== lastActivity?.activityId ||
      sourceSnapshot.breaker.sequence !== lastActivity?.sequence ||
      !runtimeEfficiencyMatchesTaskActivityPrefix({ activitySnapshot, row, sourceSnapshot })) return false;
    const result = database.prepare(`
      UPDATE execution_tasks
      SET status = 'blocked', wait_reason_code = NULL,
          last_error_code = 'agent_tool_loop_no_progress',
          result_summary = 'Agent turn was blocked by runtime policy.',
          finished_at = ?, updated_at = ?, revision = revision + 1,
          lease_id = NULL, worker_id_digest = NULL, claimed_at = NULL,
          heartbeat_at = NULL, lease_expires_at = NULL
      WHERE tenant_scope = ? AND task_id = ? AND status = 'running' AND lease_expires_at <= ?
    `).run(nowIso, nowIso, tenantScope, taskId, nowIso);
    if (result.changes !== 1) return false;
    appendStateEventInTransaction(readByTaskId(taskId, tenantScope), { code: "worker_settled" });
    return true;
  }

  function timeoutExpiredTaskInTransaction(nowIso, tenantScope, taskId) {
    const result = database.prepare(`
      UPDATE execution_tasks
      SET status = 'timed_out', wait_reason_code = NULL,
          last_error_code = 'task_execution_timeout', result_summary = 'Execution stopped at a governed timeout boundary.',
          finished_at = ?, updated_at = ?, revision = revision + 1, fencing_token = fencing_token + 1,
          lease_id = NULL, worker_id_digest = NULL, claimed_at = NULL,
          heartbeat_at = NULL, lease_expires_at = NULL
      WHERE tenant_scope = ? AND task_id = ? AND status IN ('queued', 'running', 'waiting')
        AND execution_deadline_at IS NOT NULL AND execution_deadline_at <= ?
    `).run(nowIso, nowIso, tenantScope, taskId, nowIso);
    if (result.changes !== 1) return false;
    appendStateEventInTransaction(readByTaskId(taskId, tenantScope), { code: "worker_settled" });
    return true;
  }

  function refreshWaitReasonsInTransaction(nowIso, tenantScope, limits) {
    const activeRows = database.prepare(`
      SELECT tenant_scope, employee_id, actor_issuer, actor_subject_digest
      FROM execution_tasks
      WHERE tenant_scope = ? AND status = 'running' AND lease_expires_at > ?
    `).all(tenantScope, nowIso);
    const queuedRows = database.prepare(`
      SELECT task_id, tenant_scope, employee_id, actor_issuer, actor_subject_digest, wait_reason_code
      FROM execution_tasks
      WHERE tenant_scope = ? AND status = 'queued' AND available_at <= ?
        ${goalBindingAdmissionSql}
      ORDER BY queue_order ASC, enqueue_seq ASC
    `).all(tenantScope, nowIso);
    const employeeCounts = countBy(activeRows, employeeKey);
    const actorCounts = countBy(activeRows, actorKey);
    const blockedEmployees = new Set();
    const updateReason = database.prepare(`
      UPDATE execution_tasks
      SET wait_reason_code = ?, updated_at = ?, revision = revision + 1
      WHERE task_id = ? AND status = 'queued' AND wait_reason_code IS NOT ?
    `);
    for (const row of queuedRows) {
      let reason = "awaiting_worker";
      const safeEmployeeKey = employeeKey(row);
      if (activeRows.length >= limits.global) {
        reason = "global_capacity";
      } else if (blockedEmployees.has(safeEmployeeKey)) {
        reason = "employee_fifo";
      } else if ((employeeCounts.get(safeEmployeeKey) || 0) >= employeeLeaseLimit(limits, row.employee_id)) {
        reason = "employee_capacity";
        blockedEmployees.add(safeEmployeeKey);
      } else if ((actorCounts.get(actorKey(row)) || 0) >= limits.actor) {
        reason = "actor_capacity";
        blockedEmployees.add(safeEmployeeKey);
      }
      if (row.wait_reason_code !== reason) {
        const changedReason = updateReason.run(reason, nowIso, row.task_id, reason);
        if (changedReason.changes === 1) {
          appendStateEventInTransaction(readByTaskId(row.task_id, tenantScope), { code: "queue_wait_reason_changed" });
        }
      }
    }
    return Object.freeze({ activeCount: activeRows.length });
  }

  function listEvents({ tenantScope, taskId, afterSeq = 0, limit = 100 } = {}) {
    const safeTenantScope = requiredExecutionTaskToken(tenantScope, "tenantScope", 160);
    const safeTaskId = requiredExecutionTaskToken(taskId, "taskId", 128);
    const safeAfterSeq = normalizeTaskEventAfterSeq(afterSeq);
    const safeLimit = boundedPositiveInteger(limit, "limit", 1, 200);
    const task = readByTaskId(safeTaskId, safeTenantScope);
    if (!task) throw executionTaskError("execution_task_not_found", "execution task was not found");
    if (safeAfterSeq > task.latestEventSeq) {
      throw executionTaskError("task_event_cursor_ahead", "afterSeq is ahead of the latest task event");
    }
    if (safeAfterSeq < task.eventsPrunedThroughSeq) {
      return Object.freeze({
        events: Object.freeze([]),
        nextAfterSeq: safeAfterSeq,
        latestSeq: task.latestEventSeq,
        minAvailableSeq: task.eventsPrunedThroughSeq + 1,
        terminal: TERMINAL_TASK_STATUSES.has(task.status),
        hasMore: false,
        resetRequired: true,
      });
    }
    const rows = database.prepare(`
      SELECT *
      FROM execution_task_events
      WHERE tenant_scope = ? AND task_id = ? AND seq > ?
      ORDER BY seq ASC
      LIMIT ?
    `).all(safeTenantScope, safeTaskId, safeAfterSeq, safeLimit + 1);
    const hasMore = rows.length > safeLimit;
    const events = rows.slice(0, safeLimit).map(rowToTaskEvent);
    return Object.freeze({
      events: Object.freeze(events),
      nextAfterSeq: events.at(-1)?.seq ?? safeAfterSeq,
      latestSeq: task.latestEventSeq,
      minAvailableSeq: task.eventsPrunedThroughSeq + 1,
      terminal: TERMINAL_TASK_STATUSES.has(task.status),
      hasMore,
      resetRequired: false,
    });
  }

  function hasResultAvailable({ tenantScope, taskId } = {}) {
    const safeTenantScope = requiredExecutionTaskToken(tenantScope, "tenantScope", 160);
    const safeTaskId = requiredExecutionTaskToken(taskId, "taskId", 128);
    return Boolean(database.prepare(`
      SELECT 1
      FROM execution_task_events
      WHERE tenant_scope = ? AND task_id = ? AND event_type = 'task.result_available'
      LIMIT 1
    `).get(safeTenantScope, safeTaskId));
  }

  function appendProgressWithLease({
    tenantScope,
    taskId,
    leaseId,
    workerIdDigest,
    fencingToken,
    eventKey,
    stage,
    status,
    code,
    now = new Date(),
  } = {}) {
    return appendEventWithLease({
      identity: normalizeLeaseIdentity({ tenantScope, taskId, leaseId, workerIdDigest, fencingToken }),
      eventKey,
      eventType: "task.progress",
      data: { stage, status, code },
      now,
    });
  }

  function appendResultAvailableWithLease({
    tenantScope,
    taskId,
    leaseId,
    workerIdDigest,
    fencingToken,
    now = new Date(),
  } = {}) {
    return appendEventWithLease({
      identity: normalizeLeaseIdentity({ tenantScope, taskId, leaseId, workerIdDigest, fencingToken }),
      eventKey: "conversation_history",
      eventType: "task.result_available",
      data: { resultKind: "conversation_history" },
      now,
    });
  }

  function publishArtifactWithLease({
    tenantScope,
    taskId,
    leaseId,
    workerIdDigest,
    fencingToken,
    artifact,
    objectCreated = false,
    objectSha256,
    now = new Date(),
  } = {}) {
    const identity = normalizeLeaseIdentity({ tenantScope, taskId, leaseId, workerIdDigest, fencingToken });
    const normalizedArtifact = normalizeArtifactRef(artifact);
    const safeObjectSha256 = requiredExecutionTaskDigest(objectSha256, "objectSha256");
    const nowIso = normalizedExecutionTaskNow(now);
    if (normalizedArtifact.taskId !== identity.taskId || normalizedArtifact.sha256 !== safeObjectSha256) {
      throw executionTaskError("artifact_task_binding_mismatch", "artifact ref does not match its task or object");
    }
    const eventKeyDigest = taskEventKeyDigest(["artifact", normalizedArtifact.artifactId]);
    const ownerDigest = taskEventOwnershipDigest(identity);
    database.exec("BEGIN IMMEDIATE");
    try {
      const task = readByTaskId(identity.taskId, identity.tenantScope);
      const liveOwnership = ownsLiveLease(task, identity, nowIso);
      const existingRow = readArtifactRow(identity.tenantScope, normalizedArtifact.artifactId);
      if (existingRow) {
        const stored = rowToArtifactRef(existingRow);
        const existingEventRow = database.prepare(`
          SELECT * FROM execution_task_events
          WHERE tenant_scope = ? AND task_id = ? AND event_key = ?
        `).get(identity.tenantScope, identity.taskId, eventKeyDigest);
        if (!sameArtifactPublication(stored, normalizedArtifact) ||
          existingRow.object_sha256 !== safeObjectSha256 || !existingEventRow ||
          (existingEventRow.ownership_digest !== ownerDigest && !liveOwnership)) {
          throw executionTaskError("artifact_publish_conflict", "artifact identity conflicts with its stored publication");
        }
        const event = rowToTaskEvent(existingEventRow);
        database.exec("COMMIT");
        return Object.freeze({ artifact: stored, event });
      }
      if (!liveOwnership) {
        database.exec("COMMIT");
        return null;
      }
      if (task.employeeId !== normalizedArtifact.employeeId) {
        throw executionTaskError("artifact_task_binding_mismatch", "artifact employee does not match its task");
      }
      const taskUsage = database.prepare(`
        SELECT COUNT(*) AS ref_count, COALESCE(SUM(size_bytes), 0) AS total_bytes
        FROM execution_task_artifacts WHERE tenant_scope = ? AND task_id = ?
      `).get(identity.tenantScope, identity.taskId);
      if (taskUsage.ref_count >= MAX_ARTIFACT_REFS_PER_TASK ||
        taskUsage.total_bytes + normalizedArtifact.sizeBytes > MAX_ARTIFACT_BYTES_PER_TASK) {
        throw executionTaskError("artifact_quota_exceeded", "task artifact quota exceeded");
      }
      const existingObject = database.prepare(`
        SELECT object.*, lifecycle.state AS lifecycle_state, lifecycle.generation AS lifecycle_generation
        FROM execution_artifact_objects object
        INNER JOIN execution_artifact_object_lifecycle lifecycle
          ON lifecycle.tenant_scope = object.tenant_scope AND lifecycle.object_sha256 = object.sha256
        WHERE object.tenant_scope = ? AND object.sha256 = ?
      `).get(identity.tenantScope, safeObjectSha256);
      if (existingObject?.lifecycle_state === "delete_pending") {
        throw executionTaskError("artifact_object_cleanup_in_progress", "artifact content object cleanup is in progress");
      }
      if (existingObject?.lifecycle_state === "deleted") {
        const tenantUsage = database.prepare(`
          SELECT COALESCE(SUM(object.size_bytes), 0) AS total_bytes
          FROM execution_artifact_objects object
          INNER JOIN execution_artifact_object_lifecycle lifecycle
            ON lifecycle.tenant_scope = object.tenant_scope AND lifecycle.object_sha256 = object.sha256
          WHERE object.tenant_scope = ? AND lifecycle.state <> 'deleted'
        `).get(identity.tenantScope);
        if (tenantUsage.total_bytes + normalizedArtifact.sizeBytes > MAX_ARTIFACT_OBJECT_BYTES_PER_TENANT) {
          throw executionTaskError("artifact_quota_exceeded", "tenant artifact object quota exceeded");
        }
      }
      if (!existingObject) {
        const tenantUsage = database.prepare(`
          SELECT COALESCE(SUM(object.size_bytes), 0) AS total_bytes
          FROM execution_artifact_objects object
          INNER JOIN execution_artifact_object_lifecycle lifecycle
            ON lifecycle.tenant_scope = object.tenant_scope AND lifecycle.object_sha256 = object.sha256
          WHERE object.tenant_scope = ? AND lifecycle.state <> 'deleted'
        `).get(identity.tenantScope);
        if (tenantUsage.total_bytes + normalizedArtifact.sizeBytes > MAX_ARTIFACT_OBJECT_BYTES_PER_TENANT) {
          throw executionTaskError("artifact_quota_exceeded", "tenant artifact object quota exceeded");
        }
      }
      database.prepare(`
        INSERT INTO execution_artifact_objects (tenant_scope, sha256, size_bytes, created_at)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(tenant_scope, sha256) DO NOTHING
      `).run(identity.tenantScope, safeObjectSha256, normalizedArtifact.sizeBytes, normalizedArtifact.createdAt);
      database.prepare(`
        INSERT INTO execution_artifact_object_lifecycle (
          tenant_scope, object_sha256, contract_version, state, generation, attempt_count,
          last_result_code, cleanup_requested_at, updated_at, deleted_at
        ) VALUES (?, ?, 'artifact-object-lifecycle.v1', 'present', 0, 0, NULL, NULL, ?, NULL)
        ON CONFLICT(tenant_scope, object_sha256) DO NOTHING
      `).run(identity.tenantScope, safeObjectSha256, nowIso);
      const objectRow = database.prepare(`
        SELECT object.*, lifecycle.state AS lifecycle_state, lifecycle.generation AS lifecycle_generation
        FROM execution_artifact_objects object
        INNER JOIN execution_artifact_object_lifecycle lifecycle
          ON lifecycle.tenant_scope = object.tenant_scope AND lifecycle.object_sha256 = object.sha256
        WHERE object.tenant_scope = ? AND object.sha256 = ?
      `).get(identity.tenantScope, safeObjectSha256);
      if (!objectRow || objectRow.size_bytes !== normalizedArtifact.sizeBytes) {
        throw executionTaskError("artifact_object_conflict", "artifact content object conflicts with stored metadata");
      }
      if (objectRow.lifecycle_state === "deleted" && objectCreated === true) {
        const reactivated = database.prepare(`
          UPDATE execution_artifact_object_lifecycle
          SET state = 'present', cleanup_requested_at = NULL, deleted_at = NULL,
            last_result_code = NULL, updated_at = ?
          WHERE tenant_scope = ? AND object_sha256 = ? AND generation = ?
            AND state = 'deleted'
        `).run(nowIso, identity.tenantScope, safeObjectSha256, objectRow.lifecycle_generation);
        if (reactivated.changes !== 1) {
          throw executionTaskError("artifact_object_conflict", "artifact content object lifecycle changed during publication");
        }
      } else if (objectRow.lifecycle_state !== "present") {
        throw executionTaskError("artifact_object_conflict", "artifact content object lifecycle is unavailable");
      }
      database.prepare(`
        INSERT INTO execution_task_artifacts (
          tenant_scope, task_id, artifact_id, contract_version, employee_id, file_name, mime_type,
          size_bytes, sha256, object_sha256, created_at, expires_at, visibility_scope
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        identity.tenantScope,
        normalizedArtifact.taskId,
        normalizedArtifact.artifactId,
        normalizedArtifact.contractVersion,
        normalizedArtifact.employeeId,
        normalizedArtifact.fileName,
        normalizedArtifact.mimeType,
        normalizedArtifact.sizeBytes,
        normalizedArtifact.sha256,
        safeObjectSha256,
        normalizedArtifact.createdAt,
        normalizedArtifact.expiresAt,
        normalizedArtifact.visibilityScope,
      );
      const event = appendTaskEventInTransaction(task, {
        eventKeyDigest,
        eventType: "task.artifact_available",
        data: { artifactId: normalizedArtifact.artifactId },
        occurredAt: nowIso,
        ownershipDigest: ownerDigest,
      });
      const stored = rowToArtifactRef(readArtifactRow(identity.tenantScope, normalizedArtifact.artifactId));
      database.exec("COMMIT");
      return Object.freeze({ artifact: stored, event });
    } catch (error) {
      rollbackIfActive(database);
      throw error;
    }
  }

  function canPublishArtifactWithLease({
    tenantScope,
    taskId,
    leaseId,
    workerIdDigest,
    fencingToken,
    now = new Date(),
  } = {}) {
    const identity = normalizeLeaseIdentity({ tenantScope, taskId, leaseId, workerIdDigest, fencingToken });
    const task = readByTaskId(identity.taskId, identity.tenantScope);
    return ownsLiveLease(task, identity, normalizedExecutionTaskNow(now)) ? task : null;
  }

  function isArtifactObjectReferenced({ tenantScope, objectSha256, now = new Date() } = {}) {
    const safeTenantScope = requiredExecutionTaskToken(tenantScope, "tenantScope", 160);
    const safeObjectSha256 = requiredExecutionTaskDigest(objectSha256, "objectSha256");
    const nowIso = normalizedExecutionTaskNow(now);
    return Boolean(database.prepare(`
      SELECT 1
      FROM execution_task_artifacts artifact
      LEFT JOIN execution_artifact_ref_retirements retirement
        ON retirement.tenant_scope = artifact.tenant_scope AND retirement.artifact_id = artifact.artifact_id
      WHERE artifact.tenant_scope = ? AND artifact.object_sha256 = ?
        AND artifact.expires_at > ? AND retirement.artifact_id IS NULL
      UNION ALL
      SELECT 1
      FROM execution_reusable_artifact_grants grant
      INNER JOIN execution_task_artifacts artifact
        ON artifact.tenant_scope = grant.tenant_scope
        AND artifact.task_id = grant.source_task_id AND artifact.artifact_id = grant.artifact_id
      WHERE artifact.tenant_scope = ? AND artifact.object_sha256 = ? AND grant.expires_at > ?
      LIMIT 1
    `).get(
      safeTenantScope, safeObjectSha256, nowIso,
      safeTenantScope, safeObjectSha256, nowIso,
    ));
  }

  function listArtifacts({ tenantScope, taskId } = {}) {
    const safeTenantScope = requiredExecutionTaskToken(tenantScope, "tenantScope", 160);
    const safeTaskId = requiredExecutionTaskToken(taskId, "taskId", 128);
    if (!readByTaskId(safeTaskId, safeTenantScope)) {
      throw executionTaskError("execution_task_not_found", "execution task does not exist in this tenant");
    }
    return database.prepare(`
      SELECT * FROM execution_task_artifacts
      WHERE tenant_scope = ? AND task_id = ?
      ORDER BY created_at ASC, artifact_id ASC
    `).all(safeTenantScope, safeTaskId).map(rowToArtifactRef);
  }

  function readArtifactForDownload({
    tenantScope,
    taskId,
    artifactId,
    actorIssuer,
    actorSubjectDigest,
    employeeId,
  } = {}) {
    const row = database.prepare(`
      SELECT artifact.*, task.status AS task_status,
        task.channel_id AS task_channel_id, task.session_id AS task_session_id,
        retirement.retired_at AS artifact_retired_at,
        object.size_bytes AS object_size_bytes,
        lifecycle.state AS object_lifecycle_state
      FROM execution_task_artifacts artifact
      INNER JOIN execution_tasks task
        ON task.tenant_scope = artifact.tenant_scope AND task.task_id = artifact.task_id
      INNER JOIN execution_artifact_objects object
        ON object.tenant_scope = artifact.tenant_scope AND object.sha256 = artifact.object_sha256
      INNER JOIN execution_artifact_object_lifecycle lifecycle
        ON lifecycle.tenant_scope = object.tenant_scope AND lifecycle.object_sha256 = object.sha256
      LEFT JOIN execution_artifact_ref_retirements retirement
        ON retirement.tenant_scope = artifact.tenant_scope AND retirement.artifact_id = artifact.artifact_id
      WHERE artifact.tenant_scope = ? AND artifact.task_id = ? AND artifact.artifact_id = ?
        AND task.actor_issuer = ? AND task.actor_subject_digest = ? AND task.employee_id = ?
    `).get(
      requiredExecutionTaskToken(tenantScope, "tenantScope", 160),
      requiredExecutionTaskToken(taskId, "taskId", 128),
      requiredExecutionTaskToken(artifactId, "artifactId", 160),
      requiredExecutionTaskToken(actorIssuer, "actorIssuer", 160),
      requiredExecutionTaskDigest(actorSubjectDigest, "actorSubjectDigest"),
      requiredExecutionTaskToken(employeeId, "employeeId", 160),
    );
    if (!row) return null;
    return Object.freeze({
      artifact: rowToArtifactRef(row),
      objectSha256: row.object_sha256,
      objectSizeBytes: row.object_size_bytes,
      objectState: row.object_lifecycle_state,
      retiredAt: row.artifact_retired_at,
      taskStatus: row.task_status,
      taskContext: Object.freeze({
        channelId: row.task_channel_id,
        sessionId: row.task_session_id,
      }),
    });
  }

  function saveReusableArtifactGrant({ grant, now = new Date() } = {}) {
    const normalized = normalizeReusableArtifactGrant(grant);
    const nowIso = normalizedExecutionTaskNow(now);
    database.exec("BEGIN IMMEDIATE");
    try {
      const existing = readReusableArtifactGrantRow({
        tenantScope: normalized.tenantScope,
        actorIssuer: normalized.actorIssuer,
        actorSubjectDigest: normalized.actorSubjectDigest,
        grantId: normalized.grantId,
        includeExpired: true,
      });
      if (existing) {
        const record = rowToReusableArtifactGrantRecord(existing);
        if (record.grant.artifactId !== normalized.artifactId ||
          record.grant.sourceTaskId !== normalized.sourceTaskId || record.grant.scopeType !== normalized.scopeType) {
          throw executionTaskError("reusable_artifact_grant_conflict", "reusable Artifact grant identity conflicts with stored authority");
        }
        database.exec("COMMIT");
        return record;
      }
      const source = database.prepare(`
        SELECT artifact.*, task.status AS task_status, object.size_bytes AS object_size_bytes,
          lifecycle.state AS object_lifecycle_state, retirement.retired_at AS artifact_retired_at
        FROM execution_task_artifacts artifact
        INNER JOIN execution_tasks task
          ON task.tenant_scope = artifact.tenant_scope AND task.task_id = artifact.task_id
        INNER JOIN execution_artifact_objects object
          ON object.tenant_scope = artifact.tenant_scope AND object.sha256 = artifact.object_sha256
        INNER JOIN execution_artifact_object_lifecycle lifecycle
          ON lifecycle.tenant_scope = object.tenant_scope AND lifecycle.object_sha256 = object.sha256
        LEFT JOIN execution_artifact_ref_retirements retirement
          ON retirement.tenant_scope = artifact.tenant_scope AND retirement.artifact_id = artifact.artifact_id
        WHERE artifact.tenant_scope = ? AND artifact.task_id = ? AND artifact.artifact_id = ?
          AND task.actor_issuer = ? AND task.actor_subject_digest = ?
      `).get(
        normalized.tenantScope,
        normalized.sourceTaskId,
        normalized.artifactId,
        normalized.actorIssuer,
        normalized.actorSubjectDigest,
      );
      if (!source || source.task_status !== "completed" || source.expires_at <= nowIso ||
        source.artifact_retired_at || source.object_lifecycle_state !== "present" ||
        source.size_bytes !== source.object_size_bytes) {
        throw executionTaskError("reusable_artifact_source_unavailable", "reusable Artifact source is unavailable");
      }
      database.prepare(`
        INSERT INTO execution_reusable_artifact_grants (
          tenant_scope, grant_id, contract_version, actor_issuer, actor_subject_digest,
          scope_type, source_task_id, artifact_id, created_at, expires_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        normalized.tenantScope,
        normalized.grantId,
        normalized.contractVersion,
        normalized.actorIssuer,
        normalized.actorSubjectDigest,
        normalized.scopeType,
        normalized.sourceTaskId,
        normalized.artifactId,
        normalized.createdAt,
        normalized.expiresAt,
      );
      const stored = readReusableArtifactGrantRow({
        tenantScope: normalized.tenantScope,
        actorIssuer: normalized.actorIssuer,
        actorSubjectDigest: normalized.actorSubjectDigest,
        grantId: normalized.grantId,
        includeExpired: true,
      });
      database.exec("COMMIT");
      return rowToReusableArtifactGrantRecord(stored);
    } catch (error) {
      rollbackIfActive(database);
      throw error;
    }
  }

  function listReusableArtifactGrants({
    tenantScope,
    actorIssuer,
    actorSubjectDigest,
    now = new Date(),
    limit = 50,
  } = {}) {
    const identity = reusableArtifactActorIdentity({ tenantScope, actorIssuer, actorSubjectDigest });
    const safeLimit = Math.max(1, Math.min(Number(limit) || 50, 100));
    return database.prepare(`${reusableArtifactGrantSelectSql()}
      WHERE grant.tenant_scope = ? AND grant.actor_issuer = ? AND grant.actor_subject_digest = ?
        AND grant.expires_at > ? AND lifecycle.state = 'present'
      ORDER BY grant.created_at DESC, grant.grant_id ASC
      LIMIT ?
    `).all(
      identity.tenantScope,
      identity.actorIssuer,
      identity.actorSubjectDigest,
      normalizedExecutionTaskNow(now),
      safeLimit,
    ).map(rowToReusableArtifactGrantRecord);
  }

  function readReusableArtifactGrant({ tenantScope, actorIssuer, actorSubjectDigest, grantId, now = new Date() } = {}) {
    const identity = reusableArtifactActorIdentity({ tenantScope, actorIssuer, actorSubjectDigest });
    const row = readReusableArtifactGrantRow({
      ...identity,
      grantId: requiredExecutionTaskToken(grantId, "grantId", 160),
      now: normalizedExecutionTaskNow(now),
    });
    return row ? rowToReusableArtifactGrantRecord(row) : null;
  }

  function readReusableArtifactGrantRow({
    tenantScope,
    actorIssuer,
    actorSubjectDigest,
    grantId,
    now = "",
    includeExpired = false,
  }) {
    return database.prepare(`${reusableArtifactGrantSelectSql()}
      WHERE grant.tenant_scope = ? AND grant.actor_issuer = ? AND grant.actor_subject_digest = ?
        AND grant.grant_id = ? ${includeExpired ? "" : "AND grant.expires_at > ? AND lifecycle.state = 'present'"}
    `).get(
      tenantScope,
      actorIssuer,
      actorSubjectDigest,
      grantId,
      ...(!includeExpired ? [now] : []),
    ) || null;
  }

  function readArtifactRow(tenantScope, artifactId) {
    return database.prepare(`
      SELECT * FROM execution_task_artifacts WHERE tenant_scope = ? AND artifact_id = ?
    `).get(tenantScope, artifactId);
  }

  function retireExpiredArtifactAuthorities({ now = new Date(), limit = 100 } = {}) {
    const nowIso = normalizedExecutionTaskNow(now);
    const safeLimit = boundedArtifactCleanupLimit(limit);
    database.exec("BEGIN IMMEDIATE");
    try {
      const expiredGrants = database.prepare(`
        SELECT * FROM execution_reusable_artifact_grants
        WHERE expires_at <= ?
        ORDER BY expires_at ASC, tenant_scope ASC, grant_id ASC
        LIMIT ?
      `).all(nowIso, safeLimit);
      let grantsDeleted = 0;
      for (const row of expiredGrants) {
        normalizeReusableArtifactGrant({
          contractVersion: row.contract_version,
          tenantScope: row.tenant_scope,
          grantId: row.grant_id,
          actorIssuer: row.actor_issuer,
          actorSubjectDigest: row.actor_subject_digest,
          scopeType: row.scope_type,
          sourceTaskId: row.source_task_id,
          artifactId: row.artifact_id,
          createdAt: row.created_at,
          expiresAt: row.expires_at,
        });
        grantsDeleted += database.prepare(`
          DELETE FROM execution_reusable_artifact_grants
          WHERE tenant_scope = ? AND grant_id = ? AND expires_at <= ?
        `).run(row.tenant_scope, row.grant_id, nowIso).changes;
      }
      const expiredArtifacts = database.prepare(`
        SELECT artifact.*, object.size_bytes AS object_size_bytes
        FROM execution_task_artifacts artifact
        INNER JOIN execution_artifact_objects object
          ON object.tenant_scope = artifact.tenant_scope AND object.sha256 = artifact.object_sha256
        LEFT JOIN execution_artifact_ref_retirements retirement
          ON retirement.tenant_scope = artifact.tenant_scope AND retirement.artifact_id = artifact.artifact_id
        WHERE artifact.expires_at <= ? AND retirement.artifact_id IS NULL
        ORDER BY artifact.expires_at ASC, artifact.tenant_scope ASC, artifact.artifact_id ASC
        LIMIT ?
      `).all(nowIso, safeLimit);
      let artifactsRetired = 0;
      let integrityBlocked = 0;
      for (const row of expiredArtifacts) {
        const artifact = rowToArtifactRef(row);
        if (artifact.sizeBytes !== row.object_size_bytes || artifact.sha256 !== row.object_sha256) {
          integrityBlocked += 1;
          continue;
        }
        artifactsRetired += database.prepare(`
          INSERT INTO execution_artifact_ref_retirements (
            tenant_scope, artifact_id, contract_version, retired_at, reason_code
          ) VALUES (?, ?, 'artifact-ref-retirement.v1', ?, 'ttl_expired')
          ON CONFLICT(tenant_scope, artifact_id) DO NOTHING
        `).run(row.tenant_scope, artifact.artifactId, nowIso).changes;
      }
      database.exec("COMMIT");
      return Object.freeze({ artifactsRetired, grantsDeleted, integrityBlocked });
    } catch (error) {
      rollbackIfActive(database);
      throw error;
    }
  }

  function listArtifactObjectCleanupCandidates({ limit = 100 } = {}) {
    return database.prepare(`${artifactObjectCleanupCandidateSelectSql()}
      WHERE lifecycle.state <> 'deleted'
        AND NOT EXISTS (
          SELECT 1 FROM execution_task_artifacts active_artifact
          LEFT JOIN execution_artifact_ref_retirements active_retirement
            ON active_retirement.tenant_scope = active_artifact.tenant_scope
            AND active_retirement.artifact_id = active_artifact.artifact_id
          WHERE active_artifact.tenant_scope = object.tenant_scope
            AND active_artifact.object_sha256 = object.sha256
            AND active_retirement.artifact_id IS NULL
        )
        AND NOT EXISTS (
          SELECT 1 FROM execution_reusable_artifact_grants active_grant
          INNER JOIN execution_task_artifacts grant_artifact
            ON grant_artifact.tenant_scope = active_grant.tenant_scope
            AND grant_artifact.task_id = active_grant.source_task_id
            AND grant_artifact.artifact_id = active_grant.artifact_id
          WHERE grant_artifact.tenant_scope = object.tenant_scope
            AND grant_artifact.object_sha256 = object.sha256
        )
      ORDER BY CASE lifecycle.state WHEN 'delete_pending' THEN 0 WHEN 'reconcile_required' THEN 1 ELSE 2 END,
        lifecycle.updated_at ASC, object.tenant_scope ASC, object.sha256 ASC
      LIMIT ?
    `).all(boundedArtifactCleanupLimit(limit)).map(rowToArtifactObjectCleanupCandidate);
  }

  function readArtifactObjectCleanupCandidate({ tenantScope, objectSha256 } = {}) {
    const row = database.prepare(`${artifactObjectCleanupCandidateSelectSql()}
      WHERE object.tenant_scope = ? AND object.sha256 = ?
        AND lifecycle.state <> 'deleted'
        AND NOT EXISTS (
          SELECT 1 FROM execution_task_artifacts active_artifact
          LEFT JOIN execution_artifact_ref_retirements active_retirement
            ON active_retirement.tenant_scope = active_artifact.tenant_scope
            AND active_retirement.artifact_id = active_artifact.artifact_id
          WHERE active_artifact.tenant_scope = object.tenant_scope
            AND active_artifact.object_sha256 = object.sha256
            AND active_retirement.artifact_id IS NULL
        )
        AND NOT EXISTS (
          SELECT 1 FROM execution_reusable_artifact_grants active_grant
          INNER JOIN execution_task_artifacts grant_artifact
            ON grant_artifact.tenant_scope = active_grant.tenant_scope
            AND grant_artifact.task_id = active_grant.source_task_id
            AND grant_artifact.artifact_id = active_grant.artifact_id
          WHERE grant_artifact.tenant_scope = object.tenant_scope
            AND grant_artifact.object_sha256 = object.sha256
        )
    `).get(
      requiredExecutionTaskToken(tenantScope, "tenantScope", 160),
      requiredExecutionTaskDigest(objectSha256, "objectSha256"),
    );
    return row ? rowToArtifactObjectCleanupCandidate(row) : null;
  }

  function beginArtifactObjectCleanup({
    tenantScope,
    objectSha256,
    expectedSizeBytes,
    now = new Date(),
  } = {}) {
    const safeTenantScope = requiredExecutionTaskToken(tenantScope, "tenantScope", 160);
    const safeObjectSha256 = requiredExecutionTaskDigest(objectSha256, "objectSha256");
    const safeExpectedSizeBytes = requiredPositiveArtifactSize(expectedSizeBytes);
    const nowIso = normalizedExecutionTaskNow(now);
    database.exec("BEGIN IMMEDIATE");
    try {
      const candidate = readArtifactObjectCleanupCandidate({
        tenantScope: safeTenantScope,
        objectSha256: safeObjectSha256,
      });
      if (!candidate || !candidate.integrityValid || candidate.sizeBytes !== safeExpectedSizeBytes ||
        !["present", "reconcile_required"].includes(candidate.state)) {
        database.exec("COMMIT");
        return null;
      }
      const nextGeneration = candidate.generation + 1;
      const updated = database.prepare(`
        UPDATE execution_artifact_object_lifecycle
        SET state = 'delete_pending', generation = ?, attempt_count = attempt_count + 1,
          last_result_code = 'delete_pending', cleanup_requested_at = ?, updated_at = ?, deleted_at = NULL
        WHERE tenant_scope = ? AND object_sha256 = ? AND generation = ?
          AND state IN ('present', 'reconcile_required')
      `).run(
        nextGeneration,
        nowIso,
        nowIso,
        safeTenantScope,
        safeObjectSha256,
        candidate.generation,
      );
      if (updated.changes !== 1) {
        database.exec("COMMIT");
        return null;
      }
      database.exec("COMMIT");
      return Object.freeze({ ...candidate, state: "delete_pending", generation: nextGeneration });
    } catch (error) {
      rollbackIfActive(database);
      throw error;
    }
  }

  function markArtifactObjectReconcileRequired({
    tenantScope,
    objectSha256,
    generation = null,
    resultCode,
    now = new Date(),
  } = {}) {
    const safeTenantScope = requiredExecutionTaskToken(tenantScope, "tenantScope", 160);
    const safeObjectSha256 = requiredExecutionTaskDigest(objectSha256, "objectSha256");
    const safeResultCode = artifactCleanupResultCode(resultCode);
    const nowIso = normalizedExecutionTaskNow(now);
    const safeGeneration = generation === null ? null : requiredNonNegativeInteger(generation, "generation");
    const result = database.prepare(`
      UPDATE execution_artifact_object_lifecycle
      SET state = 'reconcile_required', attempt_count = attempt_count + 1,
        last_result_code = ?, cleanup_requested_at = NULL, updated_at = ?, deleted_at = NULL
      WHERE tenant_scope = ? AND object_sha256 = ? AND state <> 'deleted'
        ${safeGeneration === null ? "" : "AND generation = ?"}
    `).run(
      safeResultCode,
      nowIso,
      safeTenantScope,
      safeObjectSha256,
      ...(safeGeneration === null ? [] : [safeGeneration]),
    );
    return result.changes === 1;
  }

  function finalizeArtifactObjectCleanup({
    tenantScope,
    objectSha256,
    generation,
    now = new Date(),
  } = {}) {
    const safeTenantScope = requiredExecutionTaskToken(tenantScope, "tenantScope", 160);
    const safeObjectSha256 = requiredExecutionTaskDigest(objectSha256, "objectSha256");
    const safeGeneration = requiredPositiveInteger(generation, "generation");
    const nowIso = normalizedExecutionTaskNow(now);
    database.exec("BEGIN IMMEDIATE");
    try {
      const candidate = readArtifactObjectCleanupCandidate({
        tenantScope: safeTenantScope,
        objectSha256: safeObjectSha256,
      });
      if (!candidate || candidate.state !== "delete_pending" || candidate.generation !== safeGeneration) {
        database.exec("COMMIT");
        return false;
      }
      const updated = database.prepare(`
        UPDATE execution_artifact_object_lifecycle
        SET state = 'deleted', last_result_code = 'deleted', updated_at = ?, deleted_at = ?
        WHERE tenant_scope = ? AND object_sha256 = ? AND state = 'delete_pending' AND generation = ?
      `).run(nowIso, nowIso, safeTenantScope, safeObjectSha256, safeGeneration);
      database.exec("COMMIT");
      return updated.changes === 1;
    } catch (error) {
      rollbackIfActive(database);
      throw error;
    }
  }

  function appendEventWithLease({ identity, eventKey, eventType, data, now }) {
    const occurredAt = normalizedExecutionTaskNow(now);
    const safeEventKey = requiredExecutionTaskToken(eventKey, "eventKey", 160);
    const eventKeyDigest = taskEventKeyDigest(eventType === "task.result_available"
      ? ["result", safeEventKey]
      : ["progress", identity.fencingToken, safeEventKey]);
    const ownerDigest = taskEventOwnershipDigest(identity);
    database.exec("BEGIN IMMEDIATE");
    try {
      const task = readByTaskId(identity.taskId, identity.tenantScope);
      const liveOwnership = Boolean(task && task.status === "running" &&
        task.lease?.leaseId === identity.leaseId &&
        task.lease?.workerIdDigest === identity.workerIdDigest &&
        task.fencingToken === identity.fencingToken &&
        task.lease.expiresAt > occurredAt);
      const existing = database.prepare(`
        SELECT * FROM execution_task_events
        WHERE tenant_scope = ? AND task_id = ? AND event_key = ?
      `).get(identity.tenantScope, identity.taskId, eventKeyDigest);
      if (existing && (existing.ownership_digest === ownerDigest || liveOwnership)) {
        const normalized = normalizeTaskEventAppend({
          tenantScope: identity.tenantScope,
          taskId: identity.taskId,
          eventType,
          data,
          occurredAt,
        });
        const existingEvent = rowToTaskEvent(existing);
        if (existingEvent.eventType !== normalized.eventType ||
          JSON.stringify(existingEvent.data) !== JSON.stringify(normalized.data)) {
          throw executionTaskError("task_event_idempotency_conflict", "task event key conflicts with existing event data");
        }
        database.exec("COMMIT");
        return existingEvent;
      }
      if (!liveOwnership) {
        database.exec("COMMIT");
        return null;
      }
      const event = appendTaskEventInTransaction(task, {
        eventKeyDigest,
        eventType,
        data,
        occurredAt,
        ownershipDigest: ownerDigest,
      });
      database.exec("COMMIT");
      return event;
    } catch (error) {
      rollbackIfActive(database);
      throw error;
    }
  }

  function appendStateEventInTransaction(task, { code = null } = {}) {
    return appendTaskEventInTransaction(task, {
      eventKeyDigest: taskEventKeyDigest(["state", task.revision, code || task.status]),
      eventType: "task.state_changed",
      data: {
        status: task.status,
        waitReasonCode: task.waitReasonCode,
        lastErrorCode: task.lastErrorCode,
        attemptCount: task.attemptCount,
        recoveryCount: task.recoveryCount,
        code,
      },
    });
  }

  function appendTaskEventInTransaction(task, {
    eventKeyDigest,
    eventType,
    data,
    occurredAt = null,
    ownershipDigest = null,
  } = {}) {
    const safeEventKeyDigest = requiredExecutionTaskDigest(eventKeyDigest, "eventKeyDigest");
    const event = normalizeTaskEventAppend({
      tenantScope: task?.tenantScope,
      taskId: task?.taskId,
      eventType,
      data,
      occurredAt: occurredAt || task?.updatedAt,
    });
    const existing = database.prepare(`
      SELECT * FROM execution_task_events
      WHERE tenant_scope = ? AND task_id = ? AND event_key = ?
    `).get(event.tenantScope, event.taskId, safeEventKeyDigest);
    if (existing) {
      const existingEvent = rowToTaskEvent(existing);
      if (existingEvent.eventType === event.eventType &&
        JSON.stringify(existingEvent.data) === JSON.stringify(event.data)) {
        return existingEvent;
      }
      throw executionTaskError("task_event_idempotency_conflict", "task event key conflicts with existing event data");
    }
    const nextSeq = Number(task.latestEventSeq || 0) + 1;
    const advanced = database.prepare(`
      UPDATE execution_tasks
      SET last_event_seq = ?
      WHERE tenant_scope = ? AND task_id = ? AND last_event_seq = ?
    `).run(nextSeq, event.tenantScope, event.taskId, task.latestEventSeq || 0);
    if (advanced.changes !== 1) {
      throw executionTaskError("task_event_sequence_conflict", "task event sequence lost its atomic transition");
    }
    database.prepare(`
      INSERT INTO execution_task_events (
        tenant_scope, task_id, seq, event_key, ownership_digest, contract_version, event_type, occurred_at,
        task_revision, status, wait_reason_code, last_error_code,
        attempt_count, recovery_count, progress_stage, progress_status,
        presentation_code, result_kind, artifact_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      event.tenantScope,
      event.taskId,
      nextSeq,
      safeEventKeyDigest,
      ownershipDigest,
      TASK_EVENT_CONTRACT_VERSION,
      event.eventType,
      event.occurredAt,
      task.revision,
      event.eventType === "task.state_changed" ? event.data.status : null,
      event.data.waitReasonCode || null,
      event.data.lastErrorCode || null,
      event.data.attemptCount ?? null,
      event.data.recoveryCount ?? null,
      event.data.stage || null,
      event.data.status && event.eventType === "task.progress" ? event.data.status : null,
      event.data.code || null,
      event.data.resultKind || null,
      event.data.artifactId || null,
    );
    return rowToTaskEvent(database.prepare(`
      SELECT * FROM execution_task_events
      WHERE tenant_scope = ? AND task_id = ? AND seq = ?
    `).get(event.tenantScope, event.taskId, nextSeq));
  }

  function readByTaskId(taskId, tenantScope) {
    const row = database.prepare(`
      SELECT * FROM execution_tasks WHERE tenant_scope = ? AND task_id = ?
    `).get(tenantScope, taskId);
    return row ? rowToTask(
      row,
      readRuntimeEvidenceRow(tenantScope, taskId),
      readRuntimeActivityState(tenantScope, taskId),
      readRuntimeSafeProvenanceState(database, row),
      readRuntimeToolEfficiencyState(database, row, { fingerprintKey: efficiencyFingerprintKey }),
    ) : null;
  }

  function readBySubmissionKey(tenantScope, submissionScope, idempotencyKey) {
    const row = database.prepare(`
      SELECT * FROM execution_tasks
      WHERE tenant_scope = ? AND submission_scope = ? AND idempotency_key = ?
    `).get(tenantScope, submissionScope, idempotencyKey);
    return row ? rowToTask(
      row,
      readRuntimeEvidenceRow(tenantScope, row.task_id),
      readRuntimeActivityState(tenantScope, row.task_id),
      readRuntimeSafeProvenanceState(database, row),
      readRuntimeToolEfficiencyState(database, row, { fingerprintKey: efficiencyFingerprintKey }),
    ) : null;
  }

  function recordRuntimeEvidenceWithLease(value = {}) {
    const identity = normalizeLeaseIdentity(value);
    const evidence = normalizeAgentRuntimeEvidence(value.evidence, { expectedTaskId: identity.taskId });
    if (!evidence.activitySnapshot) {
      throw executionTaskError(
        "runtime_evidence_legacy_write_forbidden",
        "new runtime evidence must use the canonical safe activity snapshot",
      );
    }
    if (evidence.activitySnapshot.activities.length !== evidence.toolCallCount ||
      (evidence.toolCallCount > 0 &&
        evidence.activitySnapshot.activities.at(-1)?.sequence !== evidence.toolCallCount)) {
      throw executionTaskError(
        "runtime_evidence_activity_count_invalid",
        "new runtime evidence must include every canonical activity sequence",
      );
    }
    const nowIso = normalizedExecutionTaskNow(value.now || new Date());
    database.exec("BEGIN IMMEDIATE");
    try {
      const task = readByTaskId(identity.taskId, identity.tenantScope);
      if (!ownsLiveLease(task, identity, nowIso)) {
        database.exec("COMMIT");
        return null;
      }
      const existingRow = readRuntimeEvidenceRow(identity.tenantScope, identity.taskId);
      const existingActivitySnapshot = readRuntimeActivityState(
        identity.tenantScope,
        identity.taskId,
      )?.activitySnapshot || emptyRuntimeActivitySnapshot(identity.taskId);
      if (existingRow) {
        assertRuntimeEvidenceProgress(
          rowToRuntimeEvidence(existingRow, existingActivitySnapshot),
          evidence,
        );
      } else if (existingActivitySnapshot?.activities.length) {
        assertRuntimeSafeActivitySnapshotProgress(existingActivitySnapshot, evidence.activitySnapshot);
      } else {
        assertInitialRuntimeEvidence(evidence);
      }
      writeRuntimeActivitySnapshot({
        identity,
        existingSnapshot: existingActivitySnapshot,
        nextSnapshot: evidence.activitySnapshot,
        nowIso,
      });
      database.prepare(`
        INSERT INTO execution_task_runtime_evidence (
          tenant_scope, task_id, contract_version, status, real_model_requested,
          provider, model, reasoning_effort, adapter, request_count, tool_call_count,
          tool_calls_json, input_tokens, output_tokens, total_tokens, blocked_reason,
          provider_diagnostic_json, request_metrics_json, updated_at
        ) VALUES (?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(tenant_scope, task_id) DO UPDATE SET
          status = excluded.status,
          request_count = excluded.request_count,
          tool_call_count = excluded.tool_call_count,
          tool_calls_json = excluded.tool_calls_json,
          input_tokens = excluded.input_tokens,
          output_tokens = excluded.output_tokens,
          total_tokens = excluded.total_tokens,
          blocked_reason = excluded.blocked_reason,
          provider_diagnostic_json = excluded.provider_diagnostic_json,
          request_metrics_json = excluded.request_metrics_json,
          updated_at = excluded.updated_at
      `).run(
        identity.tenantScope,
        identity.taskId,
        evidence.contractVersion,
        evidence.status,
        evidence.provider,
        evidence.model,
        evidence.reasoningEffort,
        evidence.adapter,
        evidence.requestCount,
        evidence.toolCallCount,
        "[]",
        evidence.usage.inputTokens,
        evidence.usage.outputTokens,
        evidence.usage.totalTokens,
        evidence.blockedReason,
        providerDiagnosticJson(evidence.providerDiagnostic),
        JSON.stringify(evidence.requestMetrics || []),
        nowIso,
      );
      const stored = rowToRuntimeEvidence(
        readRuntimeEvidenceRow(identity.tenantScope, identity.taskId),
        readRuntimeActivityState(identity.tenantScope, identity.taskId)?.activitySnapshot ||
          emptyRuntimeActivitySnapshot(identity.taskId),
      );
      database.exec("COMMIT");
      return stored;
    } catch (error) {
      rollbackIfActive(database);
      throw error;
    }
  }

  function recordRuntimeActivityWithLease(value = {}) {
    const identity = normalizeLeaseIdentity(value);
    const nextSnapshot = normalizeRuntimeSafeActivitySnapshot(value.activitySnapshot, {
      expectedTaskId: identity.taskId,
    });
    const nowIso = normalizedExecutionTaskNow(value.now || new Date());
    database.exec("BEGIN IMMEDIATE");
    try {
      const task = readByTaskId(identity.taskId, identity.tenantScope);
      if (!ownsLiveLease(task, identity, nowIso)) {
        database.exec("COMMIT");
        return null;
      }
      const existingSnapshot = readRuntimeActivityState(
        identity.tenantScope,
        identity.taskId,
      )?.activitySnapshot || null;
      writeRuntimeActivitySnapshot({ identity, existingSnapshot, nextSnapshot, nowIso });
      const stored = readRuntimeActivityState(identity.tenantScope, identity.taskId)?.activitySnapshot;
      database.exec("COMMIT");
      return Object.freeze({ activitySnapshot: stored, updatedAt: nowIso });
    } catch (error) {
      rollbackIfActive(database);
      throw error;
    }
  }

  function recordRuntimeProvenanceWithLease(value = {}) {
    const identity = normalizeLeaseIdentity(value);
    const nowIso = normalizedExecutionTaskNow(value.now || new Date());
    database.exec("BEGIN IMMEDIATE");
    try {
      const task = readByTaskId(identity.taskId, identity.tenantScope);
      if (!ownsLiveLease(task, identity, nowIso)) {
        database.exec("COMMIT");
        return null;
      }
      const stored = writeRuntimeSafeProvenanceSource(database, {
        nowIso,
        sourceSnapshot: value.sourceSnapshot,
        task,
      });
      database.exec("COMMIT");
      return stored;
    } catch (error) {
      rollbackIfActive(database);
      throw error;
    }
  }

  function recordRuntimeEfficiencyWithLease(value = {}) {
    const identity = normalizeLeaseIdentity(value);
    const nowIso = normalizedExecutionTaskNow(value.now || new Date());
    database.exec("BEGIN IMMEDIATE");
    try {
      const task = readByTaskId(identity.taskId, identity.tenantScope);
      if (!ownsLiveLease(task, identity, nowIso)) {
        database.exec("COMMIT");
        return null;
      }
      const stored = writeRuntimeToolEfficiencyMutation(database, {
        fingerprintKey: efficiencyFingerprintKey,
        mutation: value.mutation,
        nowIso,
        task,
      });
      database.exec("COMMIT");
      return stored;
    } catch (error) {
      rollbackIfActive(database);
      throw error;
    }
  }

  function writeRuntimeActivitySnapshot({ identity, existingSnapshot = null, nextSnapshot, nowIso }) {
    const current = existingSnapshot || normalizeRuntimeSafeActivitySnapshot({
      contractVersion: RUNTIME_SAFE_ACTIVITY_SNAPSHOT_CONTRACT_VERSION,
      taskId: identity.taskId,
      activities: [],
    }, { expectedTaskId: identity.taskId });
    assertRuntimeSafeActivitySnapshotProgress(current, nextSnapshot);
    if (isDeepStrictEqual(current, nextSnapshot)) return;
    const nextActivity = nextSnapshot.activities.at(-1);
    const previousActivity = current.activities.at(-1);
    if (nextSnapshot.activities.length === current.activities.length + 1) {
      database.prepare(`
        INSERT INTO execution_task_runtime_activities (
          tenant_scope, task_id, activity_id, sequence, contract_version, kind,
          subject_id, display_name, action_code, operation_code, status, updated_at
        ) VALUES (?, ?, ?, ?, 'runtime-safe-activity.v1', ?, ?, ?, ?, ?, ?, ?)
      `).run(
        identity.tenantScope,
        identity.taskId,
        nextActivity.activityId,
        nextActivity.sequence,
        nextActivity.kind,
        nextActivity.subjectId,
        nextActivity.displayName,
        nextActivity.actionCode,
        nextActivity.operationCode || null,
        nextActivity.status,
        nowIso,
      );
      return;
    }
    const changed = database.prepare(`
      UPDATE execution_task_runtime_activities
      SET operation_code = ?, status = ?, updated_at = ?
      WHERE tenant_scope = ? AND task_id = ? AND activity_id = ? AND sequence = ?
        AND status = 'started' AND kind = ? AND subject_id = ?
        AND display_name = ? AND action_code = ? AND operation_code IS NULL
    `).run(
      nextActivity.operationCode || null,
      nextActivity.status,
      nowIso,
      identity.tenantScope,
      identity.taskId,
      previousActivity.activityId,
      previousActivity.sequence,
      previousActivity.kind,
      previousActivity.subjectId,
      previousActivity.displayName,
      previousActivity.actionCode,
    );
    if (changed.changes !== 1) {
      throw executionTaskError(
        "runtime_safe_activity_progress_conflict",
        "runtime activity lifecycle transition lost its atomic update",
      );
    }
  }

  function readRuntimeEvidenceRow(tenantScope, taskId) {
    return database.prepare(`
      SELECT * FROM execution_task_runtime_evidence
      WHERE tenant_scope = ? AND task_id = ?
    `).get(tenantScope, taskId) || null;
  }

  function readRuntimeEvidenceForTaskIds(tenantScope, taskIds) {
    if (!taskIds.length) return new Map();
    const placeholders = taskIds.map(() => "?").join(",");
    const rows = database.prepare(`
      SELECT * FROM execution_task_runtime_evidence
      WHERE tenant_scope = ? AND task_id IN (${placeholders})
    `).all(tenantScope, ...taskIds);
    return new Map(rows.map((row) => [row.task_id, row]));
  }

  function readRuntimeActivityState(tenantScope, taskId) {
    const rows = database.prepare(`
      SELECT * FROM execution_task_runtime_activities
      WHERE tenant_scope = ? AND task_id = ?
      ORDER BY sequence ASC
    `).all(tenantScope, taskId);
    if (!rows.length) return null;
    return Object.freeze({
      activitySnapshot: runtimeActivityRowsToSnapshot(rows, taskId),
      updatedAt: normalizedExecutionTaskNow(rows.at(-1).updated_at),
    });
  }

  function readRuntimeActivitiesForTaskIds(tenantScope, taskIds) {
    if (!taskIds.length) return new Map();
    const placeholders = taskIds.map(() => "?").join(",");
    const rows = database.prepare(`
      SELECT * FROM execution_task_runtime_activities
      WHERE tenant_scope = ? AND task_id IN (${placeholders})
      ORDER BY task_id ASC, sequence ASC
    `).all(tenantScope, ...taskIds);
    const grouped = new Map();
    for (const row of rows) {
      const current = grouped.get(row.task_id) || [];
      current.push(row);
      grouped.set(row.task_id, current);
    }
    return new Map([...grouped].map(([taskId, taskRows]) => [taskId, Object.freeze({
      activitySnapshot: runtimeActivityRowsToSnapshot(taskRows, taskId),
      updatedAt: normalizedExecutionTaskNow(taskRows.at(-1).updated_at),
    })]));
  }

  function prepareOperationReceiptWithLease(value = {}) {
    const identity = normalizeLeaseIdentity(value);
    const descriptor = normalizeOperationReceiptDescriptor(value);
    const nowIso = normalizedExecutionTaskNow(value.now || new Date());
    const ownerDigest = operationReceiptOwnershipDigest(identity);
    const preparedPayload = null;
    const payloadDigest = operationReceiptPayloadDigest(preparedPayload);
    const ciphertext = receiptCipher.encrypt(preparedPayload, descriptorAad(identity, descriptor, {
      status: "prepared",
      safeResultCode: null,
      payloadDigest,
      ownershipDigest: ownerDigest,
      createdAt: nowIso,
      updatedAt: nowIso,
      finishedAt: null,
    }));
    database.exec("BEGIN IMMEDIATE");
    try {
      const existing = readOperationReceiptRow(identity.tenantScope, identity.taskId, descriptor.toolCallId);
      if (existing) {
        assertSameOperationReceipt(existing, descriptor);
        database.exec("COMMIT");
        return Object.freeze({ created: false, receipt: rowToOperationReceipt(existing, receiptCipher) });
      }
      const task = readByTaskId(identity.taskId, identity.tenantScope);
      if (!ownsLiveLease(task, identity, nowIso)) {
        database.exec("COMMIT");
        return null;
      }
      database.prepare(`
        INSERT INTO execution_operation_receipts (
          tenant_scope, task_id, tool_call_id, operation_digest, contract_version,
          effect_kind, adapter_id, action_code, target_scope_digest, authorization_digest,
          recovery_mode, status, fencing_token, ownership_digest, safe_result_code,
          payload_digest, receipt_ciphertext, created_at, updated_at, finished_at
        ) VALUES (?, ?, ?, ?, 'operation-receipt.v1', ?, ?, ?, ?, ?, ?, 'prepared', ?, ?, NULL, ?, ?, ?, ?, NULL)
      `).run(
        identity.tenantScope,
        identity.taskId,
        descriptor.toolCallId,
        descriptor.operationDigest,
        descriptor.effectKind,
        descriptor.adapterId,
        descriptor.actionCode,
        descriptor.targetScopeDigest,
        descriptor.authorizationDigest,
        descriptor.recoveryMode,
        identity.fencingToken,
        ownerDigest,
        payloadDigest,
        ciphertext,
        nowIso,
        nowIso,
      );
      const receipt = rowToOperationReceipt(
        readOperationReceiptRow(identity.tenantScope, identity.taskId, descriptor.toolCallId),
        receiptCipher,
      );
      database.exec("COMMIT");
      return Object.freeze({ created: true, receipt });
    } catch (error) {
      rollbackIfActive(database);
      throw error;
    }
  }

  function readOperationReceiptExact({ tenantScope, taskId, toolCallId, operationDigest } = {}) {
    const safeTenantScope = requiredExecutionTaskToken(tenantScope, "tenantScope", 160);
    const safeTaskId = requiredExecutionTaskToken(taskId, "taskId", 128);
    const safeToolCallId = requiredExecutionTaskToken(toolCallId, "toolCallId", 180);
    const safeOperationDigest = requiredExecutionTaskDigest(operationDigest, "operationDigest");
    const row = readOperationReceiptRow(safeTenantScope, safeTaskId, safeToolCallId);
    if (!row) return null;
    if (row.operation_digest !== safeOperationDigest) {
      throw executionTaskError("operation_receipt_conflict", "toolCallId is already bound to a different operation digest");
    }
    return rowToOperationReceipt(row, receiptCipher);
  }

  function commitOperationReceiptWithLease(value = {}) {
    const identity = normalizeLeaseIdentity(value);
    const toolCallId = requiredExecutionTaskToken(value.toolCallId, "toolCallId", 180);
    const operationDigest = requiredExecutionTaskDigest(value.operationDigest, "operationDigest");
    const outcome = normalizeOperationEffectOutcome({
      status: value.status,
      safeResultCode: value.safeResultCode,
      receiptPayload: value.receiptPayload,
    });
    const status = outcome.status;
    const safeResultCode = outcome.safeResultCode;
    const nowIso = normalizedExecutionTaskNow(value.now || new Date());
    const payload = outcome.receiptPayload;
    const payloadDigest = operationReceiptPayloadDigest(payload);
    database.exec("BEGIN IMMEDIATE");
    try {
      const existing = readOperationReceiptRow(identity.tenantScope, identity.taskId, toolCallId);
      if (!existing) {
        database.exec("COMMIT");
        return null;
      }
      if (existing.operation_digest !== operationDigest) {
        throw executionTaskError("operation_receipt_conflict", "toolCallId is already bound to a different operation digest");
      }
      const ownerDigest = operationReceiptOwnershipDigest(identity);
      if (existing.status !== "prepared") {
        if (existing.status !== status || existing.safe_result_code !== safeResultCode || existing.payload_digest !== payloadDigest) {
          throw executionTaskError("operation_receipt_idempotency_conflict", "terminal operation receipt conflicts with the committed result");
        }
        const receipt = rowToOperationReceipt(existing, receiptCipher);
        database.exec("COMMIT");
        return receipt;
      }
      const task = readByTaskId(identity.taskId, identity.tenantScope);
      const ownsPrepared = existing.ownership_digest === ownerDigest;
      const ownsCurrentTask = ownsLiveLease(task, identity, nowIso);
      if (!ownsPrepared && !ownsCurrentTask) {
        database.exec("COMMIT");
        return null;
      }
      const descriptor = descriptorFromReceiptRow(existing);
      const ciphertext = receiptCipher.encrypt(payload, descriptorAad(identity, descriptor, {
        status,
        safeResultCode,
        payloadDigest,
        ownershipDigest: ownerDigest,
        createdAt: existing.created_at,
        updatedAt: nowIso,
        finishedAt: nowIso,
      }));
      const changed = database.prepare(`
        UPDATE execution_operation_receipts
        SET status = ?, fencing_token = ?, ownership_digest = ?, safe_result_code = ?,
            payload_digest = ?, receipt_ciphertext = ?, updated_at = ?, finished_at = ?
        WHERE tenant_scope = ? AND task_id = ? AND tool_call_id = ?
          AND operation_digest = ? AND status = 'prepared'
      `).run(
        status,
        identity.fencingToken,
        ownerDigest,
        safeResultCode,
        payloadDigest,
        ciphertext,
        nowIso,
        nowIso,
        identity.tenantScope,
        identity.taskId,
        toolCallId,
        operationDigest,
      );
      if (changed.changes !== 1) {
        throw executionTaskError("operation_receipt_transition_conflict", "operation receipt terminal transition lost its atomic update");
      }
      const receipt = rowToOperationReceipt(
        readOperationReceiptRow(identity.tenantScope, identity.taskId, toolCallId),
        receiptCipher,
      );
      database.exec("COMMIT");
      return receipt;
    } catch (error) {
      rollbackIfActive(database);
      throw error;
    }
  }

  function markPreparedOperationUnknownWithLease(value = {}) {
    const identity = normalizeLeaseIdentity(value);
    const toolCallId = requiredExecutionTaskToken(value.toolCallId, "toolCallId", 180);
    const operationDigest = requiredExecutionTaskDigest(value.operationDigest, "operationDigest");
    const unknownOutcome = normalizeOperationEffectOutcome({
      status: "unknown",
      safeResultCode: value.safeResultCode || "external_effect_unknown",
      receiptPayload: { recovery: "manual_review_required" },
    });
    const safeResultCode = unknownOutcome.safeResultCode;
    const nowIso = normalizedExecutionTaskNow(value.now || new Date());
    database.exec("BEGIN IMMEDIATE");
    try {
      const existing = readOperationReceiptRow(identity.tenantScope, identity.taskId, toolCallId);
      if (!existing) {
        database.exec("COMMIT");
        return null;
      }
      if (existing.operation_digest !== operationDigest) {
        throw executionTaskError("operation_receipt_conflict", "toolCallId is already bound to a different operation digest");
      }
      if (existing.status !== "prepared") {
        const receipt = rowToOperationReceipt(existing, receiptCipher);
        database.exec("COMMIT");
        return receipt;
      }
      const task = readByTaskId(identity.taskId, identity.tenantScope);
      const ownerDigest = operationReceiptOwnershipDigest(identity);
      if (existing.ownership_digest !== ownerDigest && !ownsLiveLease(task, identity, nowIso)) {
        database.exec("COMMIT");
        return null;
      }
      const descriptor = descriptorFromReceiptRow(existing);
      const payload = unknownOutcome.receiptPayload;
      const payloadDigest = operationReceiptPayloadDigest(payload);
      const ciphertext = receiptCipher.encrypt(payload, descriptorAad(identity, descriptor, {
        status: "unknown",
        safeResultCode,
        payloadDigest,
        ownershipDigest: ownerDigest,
        createdAt: existing.created_at,
        updatedAt: nowIso,
        finishedAt: nowIso,
      }));
      const changed = database.prepare(`
        UPDATE execution_operation_receipts
        SET status = 'unknown', fencing_token = ?, ownership_digest = ?, safe_result_code = ?,
            payload_digest = ?, receipt_ciphertext = ?, updated_at = ?, finished_at = ?
        WHERE tenant_scope = ? AND task_id = ? AND tool_call_id = ?
          AND operation_digest = ? AND status = 'prepared'
      `).run(
        identity.fencingToken,
        ownerDigest,
        safeResultCode,
        payloadDigest,
        ciphertext,
        nowIso,
        nowIso,
        identity.tenantScope,
        identity.taskId,
        toolCallId,
        operationDigest,
      );
      if (changed.changes !== 1) {
        throw executionTaskError("operation_receipt_transition_conflict", "prepared receipt recovery lost its atomic update");
      }
      const receipt = rowToOperationReceipt(
        readOperationReceiptRow(identity.tenantScope, identity.taskId, toolCallId),
        receiptCipher,
      );
      database.exec("COMMIT");
      return receipt;
    } catch (error) {
      rollbackIfActive(database);
      throw error;
    }
  }

  function readOperationReceiptRow(tenantScope, taskId, toolCallId) {
    return database.prepare(`
      SELECT * FROM execution_operation_receipts
      WHERE tenant_scope = ? AND task_id = ? AND tool_call_id = ?
    `).get(tenantScope, taskId, toolCallId) || null;
  }

  function readScheduleCancellationFence(tenantScope, taskId) {
    return database.prepare(`
      SELECT *
      FROM execution_schedule_cancel_fences
      WHERE tenant_scope = ? AND task_id = ?
    `).get(tenantScope, taskId) || null;
  }

  function readScheduleCancellationFenceBySubmissionKey(tenantScope, submissionScope, idempotencyKey) {
    return database.prepare(`
      SELECT *
      FROM execution_schedule_cancel_fences
      WHERE tenant_scope = ? AND submission_scope = ? AND idempotency_key = ?
    `).get(tenantScope, submissionScope, idempotencyKey) || null;
  }

  function summarizeOperationReceipts({ tenantScope, taskId } = {}) {
    const safeTenantScope = requiredExecutionTaskToken(tenantScope, "tenantScope", 160);
    const safeTaskId = requiredExecutionTaskToken(taskId, "taskId", 128);
    if (!readByTaskId(safeTaskId, safeTenantScope)) return null;
    const counts = database.prepare(`
      SELECT
        COUNT(*) AS total,
        SUM(CASE WHEN status = 'prepared' THEN 1 ELSE 0 END) AS prepared,
        SUM(CASE WHEN status = 'succeeded' THEN 1 ELSE 0 END) AS succeeded,
        SUM(CASE WHEN status = 'definitive_failed' THEN 1 ELSE 0 END) AS definitive_failed,
        SUM(CASE WHEN status = 'unknown' THEN 1 ELSE 0 END) AS unknown_count
      FROM execution_operation_receipts
      WHERE tenant_scope = ? AND task_id = ?
    `).get(safeTenantScope, safeTaskId);
    const summary = {
      total: Number(counts?.total || 0),
      prepared: Number(counts?.prepared || 0),
      succeeded: Number(counts?.succeeded || 0),
      definitiveFailed: Number(counts?.definitive_failed || 0),
      unknown: Number(counts?.unknown_count || 0),
    };
    const effectState = summary.prepared > 0 || summary.unknown > 0
      ? "reconcile_required"
      : "settled";
    const evidenceDigest = taskEventKeyDigest([
      "execution-operation-receipt-summary.v1",
      safeTenantScope,
      safeTaskId,
      summary.total,
      summary.prepared,
      summary.succeeded,
      summary.definitiveFailed,
      summary.unknown,
      effectState,
    ]);
    return Object.freeze({ ...summary, effectState, evidenceDigest });
  }

  function listOperationReceiptExternalReferences({ tenantScope, taskId } = {}) {
    const safeTenantScope = requiredExecutionTaskToken(tenantScope, "tenantScope", 160);
    const safeTaskId = requiredExecutionTaskToken(taskId, "taskId", 128);
    if (!readByTaskId(safeTaskId, safeTenantScope)) return Object.freeze([]);
    const rows = database.prepare(`
      SELECT * FROM execution_operation_receipts
      WHERE tenant_scope = ? AND task_id = ? AND status = 'succeeded'
      ORDER BY created_at ASC, tool_call_id ASC
    `).all(safeTenantScope, safeTaskId);
    return Object.freeze(rows
      .map((row) => operationReceiptExternalReference(rowToOperationReceipt(row, receiptCipher)))
      .filter(Boolean));
  }

  function beginProviderAttemptWithLease(value = {}) {
    const { descriptor, identity, nowIso } = normalizeProviderAttemptMutation(
      value,
      PROVIDER_ATTEMPT_BEGIN_FIELDS,
    );
    const ownershipDigest = providerAttemptOwnershipDigest(identity);
    const evidence = createProviderAttemptReceiptEvidence({
      descriptor,
      status: "dispatch_prepared",
    });
    database.exec("BEGIN IMMEDIATE");
    try {
      const task = readByTaskId(identity.taskId, identity.tenantScope);
      if (!task) {
        database.exec("COMMIT");
        return null;
      }
      requireProviderAttemptTaskBinding(task, descriptor);
      const existing = readProviderAttemptReceiptRow(identity.tenantScope, identity.taskId);
      if (existing) {
        assertSameProviderAttemptDescriptor(existing, descriptor);
        const receipt = rowToProviderAttemptReceipt(existing);
        database.exec("COMMIT");
        return Object.freeze({ created: false, receipt });
      }
      if (!ownsLiveLease(task, identity, nowIso)) {
        database.exec("COMMIT");
        return null;
      }
      database.prepare(`
        INSERT INTO execution_provider_attempt_receipts (
          tenant_scope, task_id, execution_scope_id, purpose, provider_request_id,
          request_digest, provider_binding_digest, input_digest, recovery_mode,
          contract_version, attempt_number, status, fencing_token, ownership_digest,
          safe_result_code, ingest_ref, ingest_evidence_digest, attempt_evidence_digest,
          receipt_evidence_digest, created_at, updated_at, finished_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'provider-attempt-receipt.v1', 1,
          'dispatch_prepared', ?, ?, NULL, NULL, NULL, ?, ?, ?, ?, NULL)
      `).run(
        descriptor.tenantScope,
        descriptor.taskId,
        descriptor.executionScopeId,
        descriptor.purpose,
        descriptor.providerRequestId,
        descriptor.requestDigest,
        descriptor.providerBindingDigest,
        descriptor.inputDigest,
        descriptor.recoveryMode,
        identity.fencingToken,
        ownershipDigest,
        evidence.attemptEvidenceDigest,
        evidence.receiptEvidenceDigest,
        nowIso,
        nowIso,
      );
      const receipt = rowToProviderAttemptReceipt(
        readProviderAttemptReceiptRow(identity.tenantScope, identity.taskId),
      );
      database.exec("COMMIT");
      return Object.freeze({ created: true, receipt });
    } catch (error) {
      rollbackIfActive(database);
      if (String(error?.message || "").includes("execution_provider_attempt_receipts.tenant_scope")) {
        throw executionTaskError(
          "provider_attempt_request_conflict",
          "provider request identity is already bound to another canonical task",
        );
      }
      throw error;
    }
  }

  function commitProviderAttemptWithLease(value = {}) {
    const { descriptor, identity, nowIso } = normalizeProviderAttemptMutation(
      value,
      PROVIDER_ATTEMPT_COMMIT_FIELDS,
    );
    if (!new Set(["response_recorded", "definitive_failed", "unknown"]).has(value.status)) {
      throw executionTaskError("provider_attempt_status_invalid", "provider attempt terminal status is invalid");
    }
    const evidence = createProviderAttemptReceiptEvidence({
      descriptor,
      status: value.status,
      safeResultCode: value.safeResultCode,
      ingestRef: value.ingestRef,
      ingestEvidenceDigest: value.ingestEvidenceDigest,
    });
    const ownershipDigest = providerAttemptOwnershipDigest(identity);
    database.exec("BEGIN IMMEDIATE");
    try {
      const task = readByTaskId(identity.taskId, identity.tenantScope);
      if (!task) {
        database.exec("COMMIT");
        return null;
      }
      requireProviderAttemptTaskBinding(task, descriptor);
      const existing = readProviderAttemptReceiptRow(identity.tenantScope, identity.taskId);
      if (!existing) {
        database.exec("COMMIT");
        return null;
      }
      assertSameProviderAttemptDescriptor(existing, descriptor);
      if (existing.status !== "dispatch_prepared") {
        const receipt = rowToProviderAttemptReceipt(existing);
        if (receipt.status !== evidence.status || receipt.safeResultCode !== evidence.safeResultCode ||
          receipt.ingestRef !== evidence.ingestRef ||
          receipt.ingestEvidenceDigest !== evidence.ingestEvidenceDigest ||
          receipt.attemptEvidenceDigest !== evidence.attemptEvidenceDigest ||
          receipt.receiptEvidenceDigest !== evidence.receiptEvidenceDigest) {
          throw executionTaskError(
            "provider_attempt_idempotency_conflict",
            "terminal provider attempt receipt conflicts with the committed evidence",
          );
        }
        database.exec("COMMIT");
        return receipt;
      }
      if (existing.ownership_digest !== ownershipDigest && !ownsLiveLease(task, identity, nowIso)) {
        database.exec("COMMIT");
        return null;
      }
      const changed = database.prepare(`
        UPDATE execution_provider_attempt_receipts
        SET status = ?, fencing_token = ?, ownership_digest = ?, safe_result_code = ?,
            ingest_ref = ?, ingest_evidence_digest = ?, attempt_evidence_digest = ?,
            receipt_evidence_digest = ?, updated_at = ?, finished_at = ?
        WHERE tenant_scope = ? AND task_id = ? AND status = 'dispatch_prepared'
      `).run(
        evidence.status,
        identity.fencingToken,
        ownershipDigest,
        evidence.safeResultCode,
        evidence.ingestRef,
        evidence.ingestEvidenceDigest,
        evidence.attemptEvidenceDigest,
        evidence.receiptEvidenceDigest,
        nowIso,
        nowIso,
        identity.tenantScope,
        identity.taskId,
      );
      if (changed.changes !== 1) {
        throw executionTaskError(
          "provider_attempt_transition_conflict",
          "provider attempt terminal transition lost its atomic update",
        );
      }
      const receipt = rowToProviderAttemptReceipt(
        readProviderAttemptReceiptRow(identity.tenantScope, identity.taskId),
      );
      database.exec("COMMIT");
      return receipt;
    } catch (error) {
      rollbackIfActive(database);
      throw error;
    }
  }

  function readProviderAttemptReceiptExact(value = {}) {
    requireExactProviderAttemptObject(
      value,
      PROVIDER_ATTEMPT_READ_FIELDS,
      "provider_attempt_read_request_invalid",
    );
    const tenantScope = requiredExecutionTaskToken(value.tenantScope, "tenantScope", 160);
    const taskId = requiredExecutionTaskToken(value.taskId, "taskId", 128);
    const executionScopeId = requiredExecutionTaskToken(value.executionScopeId, "executionScopeId", 180);
    const purpose = requiredExecutionTaskToken(value.purpose, "purpose", 180);
    const row = readProviderAttemptReceiptRow(tenantScope, taskId);
    if (!row) return null;
    if (row.execution_scope_id !== executionScopeId || row.purpose !== purpose) {
      throw executionTaskError(
        "provider_attempt_receipt_conflict",
        "provider attempt receipt is bound to a different execution scope or purpose",
      );
    }
    const receipt = rowToProviderAttemptReceipt(row);
    const task = readByTaskId(taskId, tenantScope);
    if (!task) throw executionTaskError(
      "provider_attempt_receipt_integrity_invalid",
      "provider attempt receipt lost its canonical task",
    );
    requireProviderAttemptTaskBinding(task, receipt);
    return receipt;
  }

  function readProviderAttemptReceiptRow(tenantScope, taskId) {
    return database.prepare(`
      SELECT * FROM execution_provider_attempt_receipts
      WHERE tenant_scope = ? AND task_id = ?
    `).get(tenantScope, taskId) || null;
  }

  function createDesktopSandboxDispatchAttemptWithLease(value = {}) {
    const { attempt, identity, nowIso } = normalizeDesktopSandboxDispatchAttemptCreate(value);
    database.exec("BEGIN IMMEDIATE");
    try {
      const task = readByTaskId(identity.taskId, identity.tenantScope);
      if (!task) {
        database.exec("COMMIT");
        return null;
      }
      requireDesktopSandboxDispatchAttemptTaskBinding(task, attempt);
      const existing = readDesktopSandboxDispatchAttemptRow(identity.tenantScope, attempt.attemptId);
      if (existing) {
        const stored = rowToDesktopSandboxDispatchAttempt(existing);
        assertSameDesktopSandboxDispatchAttempt(stored, attempt);
        database.exec("COMMIT");
        return Object.freeze({ created: false, attempt: stored });
      }
      if (!ownsLiveLease(task, identity, nowIso)) {
        database.exec("COMMIT");
        return null;
      }
      database.prepare(`
        INSERT INTO execution_desktop_sandbox_dispatch_attempts (
          tenant_scope, task_id, attempt_id, contract_version, device_session_digest, profile_digest,
          operation_digest, task_input_digest, workspace_input_digest, attempt_lease_fence_digest, attempt_lease_fencing_token,
          status, transition_lease_fence_digest, transition_lease_fencing_token, state_evidence_digest,
          created_at, updated_at, expires_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        attempt.tenantScope,
        attempt.taskId,
        attempt.attemptId,
        attempt.contractVersion,
        attempt.deviceSessionDigest,
        attempt.profileDigest,
        attempt.operationDigest,
        attempt.taskInputDigest,
        attempt.workspaceInputDigest,
        attempt.attemptLeaseFenceDigest,
        attempt.attemptLeaseFencingToken,
        attempt.status,
        attempt.transitionLeaseFenceDigest,
        attempt.transitionLeaseFencingToken,
        attempt.stateEvidenceDigest,
        attempt.createdAt,
        attempt.updatedAt,
        attempt.expiresAt,
      );
      const stored = rowToDesktopSandboxDispatchAttempt(
        readDesktopSandboxDispatchAttemptRow(identity.tenantScope, attempt.attemptId),
      );
      database.exec("COMMIT");
      return Object.freeze({ created: true, attempt: stored });
    } catch (error) {
      rollbackIfActive(database);
      if (String(error?.message || "").includes("execution_desktop_sandbox_dispatch_attempts.tenant_scope")) {
        throw executionTaskError(
          "desktop_sandbox_dispatch_attempt_operation_conflict",
          "canonical task operation already owns a different Desktop Sandbox dispatch attempt",
        );
      }
      throw error;
    }
  }

  function transitionDesktopSandboxDispatchAttemptWithLease(value = {}) {
    const { attemptId, deviceSessionDigest, identity, nextStatus, nowIso } =
      normalizeDesktopSandboxDispatchAttemptTransition(value);
    database.exec("BEGIN IMMEDIATE");
    try {
      const task = readByTaskId(identity.taskId, identity.tenantScope);
      if (!task) {
        database.exec("COMMIT");
        return null;
      }
      const row = readDesktopSandboxDispatchAttemptRow(identity.tenantScope, attemptId);
      if (!row) {
        database.exec("COMMIT");
        return null;
      }
      const stored = rowToDesktopSandboxDispatchAttempt(row);
      if (stored.taskId !== identity.taskId) {
        throw executionTaskError(
          "desktop_sandbox_dispatch_attempt_scope_conflict",
          "Desktop Sandbox dispatch attempt does not belong to the canonical task",
        );
      }
      requireDesktopSandboxDispatchAttemptTaskBinding(task, stored);
      const preparedClaim = stored.status === "prepared" && nextStatus === "running";
      if (!preparedClaim && !ownsLiveLease(task, identity, nowIso)) {
        database.exec("COMMIT");
        return null;
      }
      const next = transitionDesktopSandboxDispatchAttempt({
        attempt: stored,
        deviceSessionDigest,
        nextStatus,
        now: nowIso,
        taskIdentity: { taskId: identity.taskId, tenantScope: identity.tenantScope },
        taskOwnership: {
          fencingToken: identity.fencingToken,
          leaseId: identity.leaseId,
          workerIdDigest: identity.workerIdDigest,
        },
      });
      const changed = database.prepare(`
        UPDATE execution_desktop_sandbox_dispatch_attempts
        SET status = ?, transition_lease_fence_digest = ?, transition_lease_fencing_token = ?,
            state_evidence_digest = ?, updated_at = ?
        WHERE tenant_scope = ? AND attempt_id = ? AND state_evidence_digest = ?
      `).run(
        next.status,
        next.transitionLeaseFenceDigest,
        next.transitionLeaseFencingToken,
        next.stateEvidenceDigest,
        next.updatedAt,
        identity.tenantScope,
        attemptId,
        stored.stateEvidenceDigest,
      );
      if (changed.changes !== 1) {
        throw executionTaskError(
          "desktop_sandbox_dispatch_attempt_transition_conflict",
          "Desktop Sandbox dispatch transition lost its atomic update",
        );
      }
      database.exec("COMMIT");
      return rowToDesktopSandboxDispatchAttempt(
        readDesktopSandboxDispatchAttemptRow(identity.tenantScope, attemptId),
      );
    } catch (error) {
      rollbackIfActive(database);
      throw error;
    }
  }

  function readDesktopSandboxDispatchAttemptExact(value = {}) {
    requireExactDesktopSandboxDispatchAttemptObject(
      value,
      DESKTOP_SANDBOX_DISPATCH_ATTEMPT_READ_FIELDS,
      "desktop_sandbox_dispatch_attempt_read_request_invalid",
    );
    const tenantScope = requiredExecutionTaskToken(value.tenantScope, "tenantScope", 160);
    const taskId = requiredExecutionTaskToken(value.taskId, "taskId", 128);
    const attemptId = requiredExecutionTaskToken(value.attemptId, "attemptId", 180).toLowerCase();
    const row = readDesktopSandboxDispatchAttemptRow(tenantScope, attemptId);
    if (!row) return null;
    const attempt = rowToDesktopSandboxDispatchAttempt(row);
    if (attempt.taskId !== taskId) {
      throw executionTaskError(
        "desktop_sandbox_dispatch_attempt_scope_conflict",
        "Desktop Sandbox dispatch attempt does not belong to the canonical task",
      );
    }
    const task = readByTaskId(taskId, tenantScope);
    if (!task) {
      throw executionTaskError(
        "desktop_sandbox_dispatch_attempt_integrity_invalid",
        "Desktop Sandbox dispatch attempt lost its canonical task",
      );
    }
    requireDesktopSandboxDispatchAttemptTaskBinding(task, attempt);
    return attempt;
  }

  // This is a locator for the existing canonical attempt authority, not a
  // second dispatch queue. An omitted attempt id is permitted only when one
  // currently prepared attempt is uniquely bound to the authenticated Device.
  function readDesktopSandboxDispatchAttemptForDevice(value = {}) {
    requireExactDesktopSandboxDispatchAttemptObject(
      value,
      DESKTOP_SANDBOX_DISPATCH_ATTEMPT_DEVICE_READ_FIELDS,
      "desktop_sandbox_dispatch_attempt_device_read_request_invalid",
    );
    const tenantScope = requiredExecutionTaskToken(value.tenantScope, "tenantScope", 160);
    const deviceSessionDigest = requiredExecutionTaskDigest(value.deviceSessionDigest, "deviceSessionDigest");
    const nowIso = normalizedExecutionTaskNow(value.now);
    const attemptId = String(value.attemptId || "").trim().toLowerCase();
    if (attemptId && !/^sandbox_dispatch_[a-z0-9][a-z0-9._:-]{0,159}$/.test(attemptId)) {
      throw executionTaskError(
        "desktop_sandbox_dispatch_attempt_device_read_request_invalid",
        "Desktop Sandbox dispatch Device lookup attempt id is invalid",
      );
    }
    const rows = database.prepare(attemptId ? `
      SELECT * FROM execution_desktop_sandbox_dispatch_attempts
      WHERE tenant_scope = ? AND device_session_digest = ? AND attempt_id = ?
      LIMIT 2
    ` : `
      SELECT * FROM execution_desktop_sandbox_dispatch_attempts
      WHERE tenant_scope = ? AND device_session_digest = ? AND status = 'prepared' AND expires_at > ?
      ORDER BY created_at ASC, attempt_id ASC
      LIMIT 2
    `).all(
      tenantScope,
      deviceSessionDigest,
      ...(attemptId ? [attemptId] : [nowIso]),
    );
    if (rows.length !== 1) return null;
    const attempt = rowToDesktopSandboxDispatchAttempt(rows[0]);
    if (!attemptId && attempt.status !== "prepared") return null;
    const task = readByTaskId(attempt.taskId, tenantScope);
    if (!task) {
      throw executionTaskError(
        "desktop_sandbox_dispatch_attempt_integrity_invalid",
        "Desktop Sandbox dispatch attempt lost its canonical task",
      );
    }
    requireDesktopSandboxDispatchAttemptTaskBinding(task, attempt);
    const identity = {
      fencingToken: attempt.attemptLeaseFencingToken,
      leaseId: task.lease?.leaseId,
      taskId: attempt.taskId,
      tenantScope,
      workerIdDigest: task.lease?.workerIdDigest,
    };
    // A prepared claim is the local-execution handoff boundary. Do not add a
    // second live-worker-lease gate after the immutable attempt was prepared.
    if (attempt.status !== "prepared" && (!task.lease || !ownsLiveLease(task, identity, nowIso))) return null;
    return Object.freeze({ attempt, task });
  }

  function readDesktopSandboxDispatchAttemptRow(tenantScope, attemptId) {
    return database.prepare(`
      SELECT * FROM execution_desktop_sandbox_dispatch_attempts
      WHERE tenant_scope = ? AND attempt_id = ?
    `).get(tenantScope, attemptId) || null;
  }

  const personalAutomations = createPersonalAutomationRepository({ database, submitTaskInTransaction: submitOrGetInTransaction, readTask: readByTaskId, enabled: schemaVersion >= 24 });
  const groups = createGroupRepository({
    database,
    submitTaskInTransaction: submitOrGetInTransaction,
    cancelTaskInTransaction: cancelInTransaction,
    readTask: readByTaskId,
    readEffects: summarizeOperationReceipts,
    listArtifacts, readArtifactForDownload,
  });
  const workGoalBindings = schemaVersion >= 26 ? createWorkGoalTaskBindingRepository({
    database, groups, submitTaskInTransaction: submitOrGetInTransaction, readTask: readByTaskId,
    enabled: workGoalContextSchemaPhase === "activate",
  }) : null;

  return Object.freeze({
    deviceReads,
    groups,
    workGoalBindings,
    personalAutomations,
    adapterKind: "sqlite_durable",
    assertSubmissionCompatible,
    appendProgressWithLease,
    appendResultAvailableWithLease,
    beginProviderAttemptWithLease,
    createDesktopSandboxDispatchAttemptWithLease,
    beginArtifactObjectCleanup,
    canPublishArtifactWithLease,
    cancel,
    cancelScheduledTaskOrFence,
    claimNext,
    close: () => closeSqliteDatabase(database),
    contractVersion: EXECUTION_TASK_REPOSITORY_CONTRACT_VERSION,
    deploymentScope: "single_center",
    distributedCoordination: false,
    get,
    hasResultAvailable,
    list,
    listByActor,
    listArtifacts,
    listArtifactObjectCleanupCandidates,
    listReusableArtifactGrants,
    listEvents,
    listOpsIncidentArchive: opsIncidentDiagnosisStore.listArchive,
    listOpsTerminalCandidates: opsIncidentDiagnosisStore.listTerminalCandidates,
    listOperationReceiptExternalReferences,
    isArtifactObjectReferenced,
    markPreparedOperationUnknownWithLease,
    markArtifactObjectReconcileRequired,
    markReady,
    peekNextQueued,
    reconcileExpiredLeases,
    readOperationReceiptExact,
    readArtifactObjectCleanupCandidate,
    readArtifactForDownload,
    readReusableArtifactGrant,
    readProviderAttemptReceiptExact,
    readDesktopSandboxDispatchAttemptExact,
    readDesktopSandboxDispatchAttemptForDevice,
    recordRuntimeActivityWithLease,
    recordRuntimeEfficiencyWithLease,
    recordRuntimeEvidenceWithLease,
    recordRuntimeProvenanceWithLease,
    retireExpiredArtifactAuthorities,
    renewLease,
    reorderQueuedByActor,
    releaseToWaitingWithLease,
    schemaVersion,
    summarizeOpsRuntimeTaskAnalytics: createOpsTaskAnalyticsReader(database),
    summarizeOpsRuntimeTasks: opsIncidentDiagnosisStore.summarizeRuntimeTasks,
    summarizeOpsRuntimeTaskPerformance: opsIncidentDiagnosisStore.summarizeRuntimeTaskPerformance,
    backfillOpsIncidentDiagnoses: opsIncidentDiagnosisStore.backfillInitialDiagnoses,
    diagnoseOpsIncidentsWithRuntimeEvidence: opsIncidentDiagnosisStore.diagnoseWithRuntimeEvidence,
    createOpsIncidentDiagnosisRequest: opsIncidentDiagnosisStore.createDiagnosisRequest,
    getOpsIncidentDiagnosisRequest: opsIncidentDiagnosisStore.getDiagnosisRequest,
    getOpsIncidentHead: opsIncidentDiagnosisStore.getIncidentHead,
    completeOpsIncidentDiagnosisRequest: opsIncidentDiagnosisStore.completeDiagnosisRequest,
    appendOpsIncidentDiagnosis: opsIncidentDiagnosisStore.appendOperatorDiagnosis,
    taskEventContractVersion: TASK_EVENT_CONTRACT_VERSION,
    settleWithLease,
    finalizeArtifactObjectCleanup,
    submitOrGet,
    summarizeUsageByEmployee,
    summarizeOperationReceipts,
    prepareOperationReceiptWithLease,
    publishArtifactWithLease,
    saveReusableArtifactGrant,
    commitOperationReceiptWithLease,
    commitProviderAttemptWithLease,
    transitionDesktopSandboxDispatchAttemptWithLease,
  });
}

function employeeLeaseLimit(limits, employeeId) {
  if (!limits.resolveEmployee) return limits.employee;
  try {
    return boundedPositiveInteger(limits.resolveEmployee(employeeId), "maxEmployeeLeases", 1, Number.MAX_SAFE_INTEGER);
  } catch {
    return limits.employee;
  }
}

function initializeDatabase(database, { efficiencyFingerprintKey = null, personalAutomationSchemaPhase = "activate" } = {}) {
  const targetVersion = personalAutomationSchemaPhase === "prepare" ? 23 : SQLITE_EXECUTION_TASK_SCHEMA_VERSION;
  database.exec(`
    PRAGMA foreign_keys = ON;
    PRAGMA busy_timeout = 5000;
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = FULL;
    CREATE TABLE IF NOT EXISTS execution_task_schema (
      singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
      version INTEGER NOT NULL
    );
  `);
  const schema = database.prepare("SELECT version FROM execution_task_schema WHERE singleton = 1").get();
  if (!schema) {
    database.exec("BEGIN IMMEDIATE");
    try {
      createExecutionTaskSchemaV21(database);
      createGroupSchemaV22(database);
      if (targetVersion >= 25) createGroupHistorySchemaV25(database);
      createRuntimeRequestMetricsSchemaV23(database);
      createPersonalAutomationSchema(database);
      database.prepare(`
        INSERT INTO execution_task_schema (singleton, version) VALUES (1, ?)
      `).run(targetVersion);
      database.exec("COMMIT");
      return;
    } catch (error) {
      rollbackIfActive(database);
      database.close();
      throw error;
    }
  }
  const migrations = new Map([
    [1, migrateExecutionTaskSchemaV1ToV2],
    [2, migrateExecutionTaskSchemaV2ToV3],
    [3, migrateExecutionTaskSchemaV3ToV4],
    [4, migrateExecutionTaskSchemaV4ToV5],
    [5, migrateExecutionTaskSchemaV5ToV6],
    [6, migrateExecutionTaskSchemaV6ToV7],
    [7, migrateExecutionTaskSchemaV7ToV8],
    [8, migrateExecutionTaskSchemaV8ToV9],
    [9, migrateExecutionTaskSchemaV9ToV10],
    [10, migrateExecutionTaskSchemaV10ToV11],
    [11, migrateExecutionTaskSchemaV11ToV12],
    [12, migrateExecutionTaskSchemaV12ToV13],
    [13, () => migrateExecutionTaskSchemaV13ToV14(database, { efficiencyFingerprintKey })],
    [14, () => migrateExecutionTaskSchemaV14ToV15(database, { efficiencyFingerprintKey })],
    [15, () => migrateExecutionTaskSchemaV15ToV16(database, { efficiencyFingerprintKey })],
    [16, () => migrateExecutionTaskSchemaV16ToV17(database, { efficiencyFingerprintKey })],
    [17, () => migrateExecutionTaskSchemaV17ToV18(database, { efficiencyFingerprintKey })],
    [18, () => migrateExecutionTaskSchemaV18ToV19(database, { efficiencyFingerprintKey })],
    [19, () => migrateExecutionTaskSchemaV19ToV20(database)],
    [20, () => migrateExecutionTaskSchemaV20ToV21(database)],
    [21, () => migrateExecutionTaskSchemaV21ToV22(database)],
    [22, () => migrateExecutionTaskSchemaV22ToV23(database)],
    [23, () => migrateExecutionTaskSchemaV23ToV24(database)],
    [24, () => migrateExecutionTaskSchemaV24ToV25(database)],
  ]);
  let version = Number(schema.version);
  while (version < targetVersion) {
    const migrate = migrations.get(version);
    if (typeof migrate !== "function") break;
    if (version >= 13) migrate();
    else migrate(database);
    version += 1;
  }
  if ([SQLITE_EXECUTION_TASK_SCHEMA_VERSION, 26].includes(version) || ([23, 24].includes(version) && targetVersion === 23)) {
    try {
      if (version === 23) {
        database.exec("BEGIN IMMEDIATE");
        ensurePersonalAutomationSchema(database);
        database.exec("COMMIT");
      }
      createExecutionTaskSchemaV5(database);
      validateExecutionTaskSchemaV6(database);
      validateExecutionTaskSchemaV7(database);
      validateExecutionTaskSchemaV8(database);
      validateExecutionTaskSchemaV9(database);
      validateExecutionTaskSchemaV10(database);
      validateExecutionTaskSchemaV11(database);
      validateExecutionTaskSchemaV12(database);
      validateRuntimeSafeProvenanceSchemaV13(database);
      validateRuntimeToolEfficiencySchemaV14(database, { fingerprintKey: efficiencyFingerprintKey });
      validateRuntimeTaskQueueSchemaV15(database);
      validateExecutionTaskSchemaV16(database);
      validateOpsIncidentDiagnosisSchemaV19(database);
      validateDesktopSandboxDispatchAttemptSchemaV21(database);
      validateGroupSchemaV22(database);
      if (version >= 25) validateGroupHistorySchemaV25(database);
      const goalBindingPrepared = database.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='work_goal_task_bindings'").get();
      if (version >= 26 || goalBindingPrepared) validateWorkGoalBindingSchemaV26(database, { requireEmpty: version < 26 });
      validateRuntimeRequestMetricsSchemaV23(database);
      validatePersonalAutomationSchema(database);
      return;
    } catch (error) {
      rollbackIfActive(database);
      database.close();
      throw error;
    }
  }
  database.close();
  throw executionTaskError(
    "execution_task_schema_unsupported",
    "execution task SQLite schema version is unsupported",
  );
}

function createExecutionTaskSchemaV2(database) {
  database.exec(`
    CREATE TABLE IF NOT EXISTS execution_tasks (
      enqueue_seq INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id TEXT NOT NULL UNIQUE,
      contract_version TEXT NOT NULL,
      revision INTEGER NOT NULL CHECK (revision > 0),
      tenant_scope TEXT NOT NULL,
      actor_issuer TEXT NOT NULL,
      actor_subject_digest TEXT NOT NULL,
      employee_id TEXT NOT NULL,
      employee_version TEXT,
      session_id TEXT,
      source_system_id TEXT NOT NULL,
      channel_id TEXT NOT NULL,
      task_type TEXT NOT NULL,
      submission_scope TEXT NOT NULL,
      idempotency_key TEXT NOT NULL,
      input_digest TEXT NOT NULL,
      execution_input_kind TEXT NOT NULL,
      execution_input_ref_id TEXT NOT NULL,
      workspace_ref TEXT NOT NULL,
      priority INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL,
      wait_reason_code TEXT,
      available_at TEXT NOT NULL,
      attempt_count INTEGER NOT NULL DEFAULT 0,
      recovery_count INTEGER NOT NULL DEFAULT 0,
      max_recoveries INTEGER NOT NULL,
      execution_deadline_at TEXT,
      timeout_policy_version TEXT NOT NULL,
      timeout_connect_ms INTEGER NOT NULL CHECK (timeout_connect_ms > 0),
      timeout_first_output_ms INTEGER NOT NULL CHECK (timeout_first_output_ms > 0),
      timeout_stream_idle_ms INTEGER NOT NULL CHECK (timeout_stream_idle_ms > 0),
      timeout_request_total_ms INTEGER NOT NULL CHECK (timeout_request_total_ms > 0),
      timeout_task_total_ms INTEGER NOT NULL CHECK (timeout_task_total_ms > 0),
      created_at TEXT NOT NULL,
      queued_at TEXT NOT NULL,
      started_at TEXT,
      finished_at TEXT,
      updated_at TEXT NOT NULL,
      last_error_code TEXT,
      result_summary TEXT,
      lease_id TEXT,
      worker_id_digest TEXT,
      fencing_token INTEGER NOT NULL DEFAULT 0,
      claimed_at TEXT,
      heartbeat_at TEXT,
      lease_expires_at TEXT,
      last_event_seq INTEGER NOT NULL DEFAULT 0 CHECK (last_event_seq >= 0),
      events_pruned_through_seq INTEGER NOT NULL DEFAULT 0 CHECK (events_pruned_through_seq >= 0),
      UNIQUE(tenant_scope, submission_scope, idempotency_key)
    );
    CREATE INDEX IF NOT EXISTS execution_tasks_runnable_idx
      ON execution_tasks(status, available_at, priority DESC, enqueue_seq ASC);
    CREATE INDEX IF NOT EXISTS execution_tasks_employee_idx
      ON execution_tasks(employee_id, status, enqueue_seq ASC);
    CREATE INDEX IF NOT EXISTS execution_tasks_actor_idx
      ON execution_tasks(actor_issuer, actor_subject_digest, status);
    CREATE INDEX IF NOT EXISTS execution_tasks_lease_idx
      ON execution_tasks(status, lease_expires_at);
    CREATE UNIQUE INDEX IF NOT EXISTS execution_tasks_tenant_task_idx
      ON execution_tasks(tenant_scope, task_id);
    ${TASK_EVENT_SCHEMA_V8_SQL}
  `);
}

function createExecutionTaskSchemaV3(database) {
  createExecutionTaskSchemaV2(database);
  createOperationReceiptSchemaV3(database);
}

function createExecutionTaskSchemaV4(database) {
  createExecutionTaskSchemaV3(database);
}

function createExecutionTaskSchemaV5(database) {
  createExecutionTaskSchemaV4(database);
  createScheduleCancellationFenceSchemaV5(database);
}

function createExecutionTaskSchemaV6(database) {
  createExecutionTaskSchemaV5(database);
  database.exec(`
    ALTER TABLE execution_tasks ADD COLUMN terminal_evidence_digest TEXT
      CHECK (
        terminal_evidence_digest IS NULL OR
        (length(terminal_evidence_digest) = 64 AND terminal_evidence_digest NOT GLOB '*[^a-f0-9]*')
      );
  `);
}

function createExecutionTaskSchemaV7(database) {
  createExecutionTaskSchemaV6(database);
  database.exec(PROVIDER_ATTEMPT_SCHEMA_SQL);
}

function createExecutionTaskSchemaV8(database) {
  createExecutionTaskSchemaV7(database);
  database.exec(RUNTIME_EVIDENCE_SCHEMA_SQL);
}

function createExecutionTaskSchemaV9(database) {
  createExecutionTaskSchemaV8(database);
  database.exec(ARTIFACT_SCHEMA_SQL);
  rebuildTaskEventSchemaV9(database);
}

function createExecutionTaskSchemaV10(database) {
  createExecutionTaskSchemaV9(database);
  database.exec(REUSABLE_ARTIFACT_GRANT_SCHEMA_SQL);
}

function createExecutionTaskSchemaV11(database) {
  createExecutionTaskSchemaV10(database);
  database.exec(ARTIFACT_RETENTION_SCHEMA_V11_SQL);
}

function createExecutionTaskSchemaV12(database) {
  createExecutionTaskSchemaV11(database);
  database.exec(RUNTIME_ACTIVITY_SCHEMA_V12_SQL);
}

function createExecutionTaskSchemaV13(database) {
  createExecutionTaskSchemaV12(database);
  createRuntimeSafeProvenanceSchemaV13(database);
}

function createExecutionTaskSchemaV14(database) {
  createExecutionTaskSchemaV13(database);
  createRuntimeToolEfficiencySchemaV14(database);
}

function createExecutionTaskSchemaV15(database) {
  createExecutionTaskSchemaV14(database);
  createRuntimeTaskQueueSchemaV15(database);
}

function createExecutionTaskSchemaV16(database) {
  createExecutionTaskSchemaV15(database);
  addRuntimeEvidenceProviderDiagnosticColumn(database);
}

function createExecutionTaskSchemaV17(database) {
  createExecutionTaskSchemaV16(database);
  createOpsIncidentDiagnosisSchemaV17(database);
}

function createExecutionTaskSchemaV18(database) {
  createExecutionTaskSchemaV17(database);
  createOpsIncidentDiagnosisSchemaV18(database);
}

function createExecutionTaskSchemaV19(database) {
  createExecutionTaskSchemaV18(database);
  createOpsIncidentDiagnosisSchemaV19(database);
}

function createExecutionTaskSchemaV21(database) {
  createExecutionTaskSchemaV19(database);
  database.exec(DESKTOP_SANDBOX_DISPATCH_ATTEMPT_SCHEMA_V21_SQL);
}

function createRuntimeRequestMetricsSchemaV23(database) {
  const column = database.prepare("PRAGMA table_info(execution_task_runtime_evidence)").all()
    .find((item) => item.name === "request_metrics_json");
  if (!column) database.exec(`ALTER TABLE execution_task_runtime_evidence ADD COLUMN ${RUNTIME_EVIDENCE_REQUEST_METRICS_COLUMN_SQL}`);
}

function addRuntimeEvidenceProviderDiagnosticColumn(database) {
  database.exec(`
    ALTER TABLE execution_task_runtime_evidence
      ADD COLUMN ${RUNTIME_EVIDENCE_PROVIDER_DIAGNOSTIC_COLUMN_SQL};
  `);
}

function createScheduleCancellationFenceSchemaV5(database) {
  database.exec(`
    CREATE TABLE IF NOT EXISTS execution_schedule_cancel_fences (
      tenant_scope TEXT NOT NULL,
      task_id TEXT NOT NULL,
      employee_id TEXT NOT NULL,
      source_system_id TEXT NOT NULL,
      channel_id TEXT NOT NULL,
      task_type TEXT NOT NULL,
      submission_scope TEXT NOT NULL,
      idempotency_key TEXT NOT NULL,
      execution_input_kind TEXT NOT NULL,
      execution_input_ref_id TEXT NOT NULL,
      stop_generation INTEGER NOT NULL CHECK (stop_generation > 0),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (tenant_scope, task_id),
      UNIQUE (tenant_scope, submission_scope, idempotency_key)
    );
    CREATE INDEX IF NOT EXISTS execution_schedule_cancel_fences_generation_idx
      ON execution_schedule_cancel_fences (tenant_scope, stop_generation, updated_at);
  `);
}

function createOperationReceiptSchemaV3(database) {
  database.exec(`
    CREATE TABLE IF NOT EXISTS execution_operation_receipts (
      tenant_scope TEXT NOT NULL,
      task_id TEXT NOT NULL,
      tool_call_id TEXT NOT NULL,
      operation_digest TEXT NOT NULL,
      contract_version TEXT NOT NULL CHECK (contract_version = 'operation-receipt.v1'),
      effect_kind TEXT NOT NULL CHECK (effect_kind IN ('external_write', 'workspace_write', 'channel_delivery')),
      adapter_id TEXT NOT NULL,
      action_code TEXT NOT NULL,
      target_scope_digest TEXT NOT NULL,
      authorization_digest TEXT NOT NULL,
      recovery_mode TEXT NOT NULL CHECK (recovery_mode IN ('remote_idempotency', 'status_query', 'none')),
      status TEXT NOT NULL CHECK (status IN ('prepared', 'succeeded', 'definitive_failed', 'unknown')),
      fencing_token INTEGER NOT NULL CHECK (fencing_token > 0),
      ownership_digest TEXT NOT NULL,
      safe_result_code TEXT,
      payload_digest TEXT NOT NULL,
      receipt_ciphertext TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      finished_at TEXT,
      PRIMARY KEY(tenant_scope, task_id, tool_call_id),
      FOREIGN KEY(tenant_scope, task_id) REFERENCES execution_tasks(tenant_scope, task_id) ON DELETE CASCADE,
      CHECK (
        (status = 'prepared' AND finished_at IS NULL AND safe_result_code IS NULL)
        OR
        (status IN ('succeeded', 'definitive_failed', 'unknown') AND finished_at IS NOT NULL AND safe_result_code IS NOT NULL)
      )
    );
    CREATE INDEX IF NOT EXISTS execution_operation_receipts_status_idx
      ON execution_operation_receipts(tenant_scope, status, updated_at);
  `);
}

function migrateExecutionTaskSchemaV1ToV2(database) {
  database.exec("BEGIN IMMEDIATE");
  try {
    database.exec(`
      ALTER TABLE execution_tasks
        ADD COLUMN last_event_seq INTEGER NOT NULL DEFAULT 0 CHECK (last_event_seq >= 0);
      ALTER TABLE execution_tasks
        ADD COLUMN events_pruned_through_seq INTEGER NOT NULL DEFAULT 0 CHECK (events_pruned_through_seq >= 0);
    `);
    createExecutionTaskSchemaV2(database);
    const insertBackfill = database.prepare(`
      INSERT INTO execution_task_events (
        tenant_scope, task_id, seq, event_key, ownership_digest, contract_version, event_type, occurred_at,
        task_revision, status, wait_reason_code, last_error_code,
        attempt_count, recovery_count, presentation_code
      ) VALUES (?, ?, 1, ?, NULL, ?, 'task.state_changed', ?, ?, ?, ?, ?, ?, ?, 'c002_backfill')
    `);
    const markBackfilled = database.prepare(`
      UPDATE execution_tasks SET last_event_seq = 1
      WHERE tenant_scope = ? AND task_id = ? AND last_event_seq = 0
    `);
    const legacyTasks = database.prepare("SELECT * FROM execution_tasks ORDER BY enqueue_seq ASC").all();
    for (const row of legacyTasks) {
      const event = normalizeTaskEventAppend({
        tenantScope: row.tenant_scope,
        taskId: row.task_id,
        eventType: "task.state_changed",
        occurredAt: row.updated_at,
        data: {
          status: row.status,
          waitReasonCode: row.wait_reason_code,
          lastErrorCode: row.last_error_code,
          attemptCount: row.attempt_count,
          recoveryCount: row.recovery_count,
          code: "c002_backfill",
        },
      });
      insertBackfill.run(
        event.tenantScope,
        event.taskId,
        taskEventKeyDigest(["state", row.revision, "c002_backfill"]),
        TASK_EVENT_CONTRACT_VERSION,
        event.occurredAt,
        row.revision,
        event.data.status,
        event.data.waitReasonCode,
        event.data.lastErrorCode,
        event.data.attemptCount,
        event.data.recoveryCount,
      );
      if (markBackfilled.run(event.tenantScope, event.taskId).changes !== 1) {
        throw executionTaskError("task_event_backfill_conflict", "task event backfill lost its atomic transition");
      }
    }
    database.prepare(`
      UPDATE execution_task_schema SET version = ? WHERE singleton = 1 AND version = 1
    `).run(2);
    database.exec("COMMIT");
  } catch (error) {
    rollbackIfActive(database);
    database.close();
    throw error;
  }
}

function migrateExecutionTaskSchemaV2ToV3(database) {
  database.exec("BEGIN IMMEDIATE");
  try {
    createOperationReceiptSchemaV3(database);
    const updated = database.prepare(`
      UPDATE execution_task_schema SET version = 3 WHERE singleton = 1 AND version = 2
    `).run();
    if (updated.changes !== 1) {
      throw executionTaskError("execution_task_schema_migration_conflict", "execution task schema v2 to v3 migration lost its version transition");
    }
    database.exec("COMMIT");
  } catch (error) {
    rollbackIfActive(database);
    database.close();
    throw error;
  }
}

function migrateExecutionTaskSchemaV3ToV4(database) {
  database.exec("BEGIN IMMEDIATE");
  try {
    const existingColumns = new Set(database.prepare("PRAGMA table_info(execution_tasks)").all().map((column) => column.name));
    for (const [column, type] of [
      ["execution_deadline_at", "TEXT"],
      ["timeout_policy_version", "TEXT"],
      ["timeout_connect_ms", "INTEGER"],
      ["timeout_first_output_ms", "INTEGER"],
      ["timeout_stream_idle_ms", "INTEGER"],
      ["timeout_request_total_ms", "INTEGER"],
      ["timeout_task_total_ms", "INTEGER"],
    ]) {
      if (!existingColumns.has(column)) database.exec(`ALTER TABLE execution_tasks ADD COLUMN ${column} ${type}`);
    }
    const update = database.prepare(`
      UPDATE execution_tasks
      SET execution_deadline_at = ?, timeout_policy_version = ?,
          timeout_connect_ms = ?, timeout_first_output_ms = ?, timeout_stream_idle_ms = ?,
          timeout_request_total_ms = ?, timeout_task_total_ms = ?
      WHERE tenant_scope = ? AND task_id = ?
        AND timeout_policy_version IS NULL
    `);
    const rows = database.prepare(`
      SELECT tenant_scope, task_id, status, started_at
      FROM execution_tasks
      WHERE timeout_policy_version IS NULL
    `).all();
    for (const row of rows) {
      const startedAtMs = row.started_at ? Date.parse(row.started_at) : NaN;
      const executionDeadlineAt = ["queued", "running", "waiting"].includes(row.status) && Number.isFinite(startedAtMs)
        ? new Date(startedAtMs + 30 * 60 * 1000).toISOString()
        : null;
      const result = update.run(
        executionDeadlineAt,
        "provider-timeout-c005-backfill-v1",
        15_000,
        60_000,
        60_000,
        5 * 60_000,
        30 * 60_000,
        row.tenant_scope,
        row.task_id,
      );
      if (result.changes !== 1) {
        throw executionTaskError("execution_task_schema_migration_conflict", "execution task deadline backfill lost its row transition");
      }
    }
    const updated = database.prepare(`
      UPDATE execution_task_schema SET version = 4 WHERE singleton = 1 AND version = 3
    `).run();
    if (updated.changes !== 1) {
      throw executionTaskError("execution_task_schema_migration_conflict", "execution task schema v3 to v4 migration lost its version transition");
    }
    database.exec("COMMIT");
  } catch (error) {
    rollbackIfActive(database);
    database.close();
    throw error;
  }
}

function migrateExecutionTaskSchemaV4ToV5(database) {
  database.exec("BEGIN IMMEDIATE");
  try {
    createScheduleCancellationFenceSchemaV5(database);
    const updated = database.prepare(`
      UPDATE execution_task_schema SET version = 5 WHERE singleton = 1 AND version = 4
    `).run();
    if (updated.changes !== 1) {
      throw executionTaskError(
        "execution_task_schema_migration_conflict",
        "execution task schema v4 to v5 migration lost its version transition",
      );
    }
    database.exec("COMMIT");
  } catch (error) {
    rollbackIfActive(database);
    database.close();
    throw error;
  }
}

function migrateExecutionTaskSchemaV5ToV6(database) {
  database.exec("BEGIN IMMEDIATE");
  try {
    database.exec(`
      ALTER TABLE execution_tasks ADD COLUMN terminal_evidence_digest TEXT
        CHECK (
          terminal_evidence_digest IS NULL OR
          (length(terminal_evidence_digest) = 64 AND terminal_evidence_digest NOT GLOB '*[^a-f0-9]*')
        );
    `);
    const updated = database.prepare(`
      UPDATE execution_task_schema SET version = 6 WHERE singleton = 1 AND version = 5
    `).run();
    if (updated.changes !== 1) {
      throw executionTaskError(
        "execution_task_schema_migration_conflict",
        "execution task schema v5 to v6 migration lost its version transition",
      );
    }
    database.exec("COMMIT");
  } catch (error) {
    rollbackIfActive(database);
    database.close();
    throw error;
  }
}

function migrateExecutionTaskSchemaV6ToV7(database) {
  database.exec("BEGIN IMMEDIATE");
  try {
    const preexisting = database.prepare(`
      SELECT type FROM sqlite_master WHERE name IN (
        'execution_provider_attempt_receipts',
        'execution_provider_attempt_receipts_status_idx'
      )
    `).all();
    if (preexisting.length !== 0) {
      throw executionTaskError(
        "execution_task_schema_unsupported",
        "unsafe preexisting execution task SQLite v7 Provider attempt schema",
      );
    }
    database.exec(PROVIDER_ATTEMPT_SCHEMA_SQL);
    const updated = database.prepare(`
      UPDATE execution_task_schema SET version = 7 WHERE singleton = 1 AND version = 6
    `).run();
    if (updated.changes !== 1) {
      throw executionTaskError(
        "execution_task_schema_migration_conflict",
        "execution task schema v6 to v7 migration lost its version transition",
      );
    }
    database.exec("COMMIT");
  } catch (error) {
    rollbackIfActive(database);
    database.close();
    throw error;
  }
}

function migrateExecutionTaskSchemaV7ToV8(database) {
  database.exec("BEGIN IMMEDIATE");
  try {
    const preexisting = database.prepare(`
      SELECT type FROM sqlite_master WHERE name = 'execution_task_runtime_evidence'
    `).all();
    if (preexisting.length !== 0) {
      throw executionTaskError(
        "execution_task_schema_unsupported",
        "unsafe preexisting execution task SQLite v8 runtime evidence schema",
      );
    }
    database.exec(RUNTIME_EVIDENCE_SCHEMA_SQL);
    const updated = database.prepare(`
      UPDATE execution_task_schema SET version = 8 WHERE singleton = 1 AND version = 7
    `).run();
    if (updated.changes !== 1) {
      throw executionTaskError(
        "execution_task_schema_migration_conflict",
        "execution task schema v7 to v8 migration lost its version transition",
      );
    }
    database.exec("COMMIT");
  } catch (error) {
    rollbackIfActive(database);
    database.close();
    throw error;
  }
}

function migrateExecutionTaskSchemaV8ToV9(database) {
  database.exec("BEGIN IMMEDIATE");
  try {
    validateExecutionTaskSchemaV6(database);
    validateExecutionTaskSchemaV7(database);
    validateExecutionTaskSchemaV8(database);
    validateTaskEventSchemaV8MigrationSource(database);
    const preexisting = database.prepare(`
      SELECT type, name FROM sqlite_master WHERE name IN (
        'execution_artifact_objects', 'execution_task_artifacts', 'execution_task_events_v9'
      )
    `).all();
    if (preexisting.length !== 0) {
      throw executionTaskError(
        "execution_task_schema_unsupported",
        "unsafe preexisting execution task SQLite v9 artifact schema",
      );
    }
    database.exec(ARTIFACT_SCHEMA_SQL);
    rebuildTaskEventSchemaV9(database);
    validateExecutionTaskSchemaV9(database);
    const updated = database.prepare(`
      UPDATE execution_task_schema SET version = 9 WHERE singleton = 1 AND version = 8
    `).run();
    if (updated.changes !== 1) {
      throw executionTaskError(
        "execution_task_schema_migration_conflict",
        "execution task schema v8 to v9 migration lost its version transition",
      );
    }
    database.exec("COMMIT");
  } catch (error) {
    rollbackIfActive(database);
    database.close();
    throw error;
  }
}

function migrateExecutionTaskSchemaV9ToV10(database) {
  database.exec("BEGIN IMMEDIATE");
  try {
    validateExecutionTaskSchemaV9(database);
    const preexisting = database.prepare(`
      SELECT type, name FROM sqlite_master WHERE name IN (
        'execution_reusable_artifact_grants', 'execution_reusable_artifact_grants_actor_idx'
      )
    `).all();
    if (preexisting.length !== 0) {
      throw executionTaskError(
        "execution_task_schema_unsupported",
        "unsafe preexisting execution task SQLite v10 reusable Artifact grant schema",
      );
    }
    database.exec(REUSABLE_ARTIFACT_GRANT_SCHEMA_SQL);
    validateExecutionTaskSchemaV10(database);
    const updated = database.prepare(`
      UPDATE execution_task_schema SET version = 10 WHERE singleton = 1 AND version = 9
    `).run();
    if (updated.changes !== 1) {
      throw executionTaskError(
        "execution_task_schema_migration_conflict",
        "execution task schema v9 to v10 migration lost its version transition",
      );
    }
    database.exec("COMMIT");
  } catch (error) {
    rollbackIfActive(database);
    database.close();
    throw error;
  }
}

function migrateExecutionTaskSchemaV10ToV11(database) {
  database.exec("BEGIN IMMEDIATE");
  try {
    validateExecutionTaskSchemaV9(database);
    validateExecutionTaskSchemaV10(database);
    const preexisting = database.prepare(`
      SELECT type, name FROM sqlite_master WHERE name IN (
        'execution_artifact_ref_retirements',
        'execution_artifact_ref_retirements_time_idx',
        'execution_artifact_object_lifecycle',
        'execution_artifact_object_lifecycle_state_idx',
        'execution_task_artifacts_object_expiry_v11_idx',
        'execution_reusable_artifact_grants_expiry_v11_idx',
        'execution_reusable_artifact_grants_source_expiry_v11_idx'
      )
    `).all();
    if (preexisting.length !== 0) {
      throw executionTaskError(
        "execution_task_schema_unsupported",
        "unsafe preexisting execution task SQLite v11 Artifact retention schema",
      );
    }
    database.exec(ARTIFACT_RETENTION_SCHEMA_V11_SQL);
    database.prepare(`
      INSERT INTO execution_artifact_object_lifecycle (
        tenant_scope, object_sha256, contract_version, state, generation, attempt_count,
        last_result_code, cleanup_requested_at, updated_at, deleted_at
      )
      SELECT tenant_scope, sha256, 'artifact-object-lifecycle.v1', 'present', 0, 0,
        NULL, NULL, created_at, NULL
      FROM execution_artifact_objects
    `).run();
    validateExecutionTaskSchemaV11(database);
    const updated = database.prepare(`
      UPDATE execution_task_schema SET version = 11 WHERE singleton = 1 AND version = 10
    `).run();
    if (updated.changes !== 1) {
      throw executionTaskError(
        "execution_task_schema_migration_conflict",
        "execution task schema v10 to v11 migration lost its version transition",
      );
    }
    database.exec("COMMIT");
  } catch (error) {
    rollbackIfActive(database);
    database.close();
    throw error;
  }
}

function migrateExecutionTaskSchemaV11ToV12(database) {
  database.exec("BEGIN IMMEDIATE");
  try {
    validateExecutionTaskSchemaV8(database);
    validateExecutionTaskSchemaV11(database);
    const preexisting = database.prepare(`
      SELECT type, name FROM sqlite_master WHERE name IN (
        'execution_task_runtime_activities',
        'execution_task_runtime_activities_order_idx'
      )
    `).all();
    if (preexisting.length !== 0) {
      throw executionTaskError(
        "execution_task_schema_unsupported",
        "unsafe preexisting execution task SQLite v12 runtime activity schema",
      );
    }
    database.exec(RUNTIME_ACTIVITY_SCHEMA_V12_SQL);
    const insertActivity = database.prepare(`
      INSERT INTO execution_task_runtime_activities (
        tenant_scope, task_id, activity_id, sequence, contract_version, kind,
        subject_id, display_name, action_code, operation_code, status, updated_at
      ) VALUES (?, ?, ?, ?, 'runtime-safe-activity.v1', ?, ?, ?, ?, ?, ?, ?)
    `);
    const rows = database.prepare(`
      SELECT * FROM execution_task_runtime_evidence
      ORDER BY tenant_scope, task_id
    `).all();
    for (const row of rows) {
      const evidence = rowToRuntimeEvidence(row);
      const snapshot = evidence.activitySnapshot || legacyRuntimeSafeActivitySnapshot({
        taskId: row.task_id,
        toolCalls: evidence.toolCalls,
      });
      for (const activity of snapshot.activities) {
        insertActivity.run(
          row.tenant_scope,
          row.task_id,
          activity.activityId,
          activity.sequence,
          activity.kind,
          activity.subjectId,
          activity.displayName,
          activity.actionCode,
          activity.operationCode || null,
          activity.status,
          row.updated_at,
        );
      }
    }
    database.prepare("UPDATE execution_task_runtime_evidence SET tool_calls_json = '[]'").run();
    validateExecutionTaskSchemaV12(database);
    const updated = database.prepare(`
      UPDATE execution_task_schema SET version = 12 WHERE singleton = 1 AND version = 11
    `).run();
    if (updated.changes !== 1) {
      throw executionTaskError(
        "execution_task_schema_migration_conflict",
        "execution task schema v11 to v12 migration lost its version transition",
      );
    }
    database.exec("COMMIT");
  } catch (error) {
    rollbackIfActive(database);
    database.close();
    throw error;
  }
}

function migrateExecutionTaskSchemaV12ToV13(database) {
  database.exec("BEGIN IMMEDIATE");
  try {
    validateExecutionTaskSchemaV12(database);
    const preexisting = database.prepare(`
      SELECT type, name FROM sqlite_master
      WHERE name = 'execution_task_runtime_provenance'
    `).all();
    if (preexisting.length !== 0) {
      throw executionTaskError(
        "execution_task_schema_unsupported",
        "unsafe preexisting execution task SQLite v13 Runtime provenance schema",
      );
    }
    createRuntimeSafeProvenanceSchemaV13(database);
    validateRuntimeSafeProvenanceSchemaV13(database);
    const updated = database.prepare(`
      UPDATE execution_task_schema SET version = 13 WHERE singleton = 1 AND version = 12
    `).run();
    if (updated.changes !== 1) {
      throw executionTaskError(
        "execution_task_schema_migration_conflict",
        "execution task schema v12 to v13 migration lost its version transition",
      );
    }
    database.exec("COMMIT");
  } catch (error) {
    rollbackIfActive(database);
    database.close();
    throw error;
  }
}

function migrateExecutionTaskSchemaV13ToV14(database, { efficiencyFingerprintKey = null } = {}) {
  database.exec("BEGIN IMMEDIATE");
  try {
    validateExecutionTaskSchemaV12(database);
    validateRuntimeSafeProvenanceSchemaV13(database);
    const preexisting = database.prepare(`
      SELECT type, name FROM sqlite_master
      WHERE name = 'execution_task_runtime_tool_efficiency'
    `).all();
    if (preexisting.length !== 0) {
      throw executionTaskError(
        "execution_task_schema_unsupported",
        "unsafe preexisting execution task SQLite v14 Tool efficiency schema",
      );
    }
    createRuntimeToolEfficiencySchemaV14(database);
    validateRuntimeToolEfficiencySchemaV14(database, { fingerprintKey: efficiencyFingerprintKey });
    const updated = database.prepare(`
      UPDATE execution_task_schema SET version = 14 WHERE singleton = 1 AND version = 13
    `).run();
    if (updated.changes !== 1) {
      throw executionTaskError(
        "execution_task_schema_migration_conflict",
        "execution task schema v13 to v14 migration lost its version transition",
      );
    }
    database.exec("COMMIT");
  } catch (error) {
    rollbackIfActive(database);
    database.close();
    throw error;
  }
}

function migrateExecutionTaskSchemaV14ToV15(database, { efficiencyFingerprintKey = null } = {}) {
  database.exec("BEGIN IMMEDIATE");
  try {
    validateExecutionTaskSchemaV12(database);
    validateRuntimeSafeProvenanceSchemaV13(database);
    validateRuntimeToolEfficiencySchemaV14(database, { fingerprintKey: efficiencyFingerprintKey });
    const columns = database.prepare("PRAGMA table_info(execution_tasks)").all();
    const preexistingIndex = database.prepare(`
      SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'execution_tasks_queue_order_idx'
    `).get();
    if (columns.some((column) => column.name === "queue_order") || preexistingIndex) {
      throw executionTaskError(
        "execution_task_schema_unsupported",
        "unsafe preexisting execution task SQLite v15 queue authority",
      );
    }
    createRuntimeTaskQueueSchemaV15(database);
    validateRuntimeTaskQueueSchemaV15(database);
    const updated = database.prepare(`
      UPDATE execution_task_schema SET version = 15 WHERE singleton = 1 AND version = 14
    `).run();
    if (updated.changes !== 1) {
      throw executionTaskError(
        "execution_task_schema_migration_conflict",
        "execution task schema v14 to v15 migration lost its version transition",
      );
    }
    database.exec("COMMIT");
  } catch (error) {
    rollbackIfActive(database);
    database.close();
    throw error;
  }
}

function migrateExecutionTaskSchemaV15ToV16(database, { efficiencyFingerprintKey = null } = {}) {
  database.exec("BEGIN IMMEDIATE");
  try {
    validateExecutionTaskSchemaV12(database);
    validateRuntimeSafeProvenanceSchemaV13(database);
    validateRuntimeToolEfficiencySchemaV14(database, { fingerprintKey: efficiencyFingerprintKey });
    validateRuntimeTaskQueueSchemaV15(database);
    const columns = database.prepare("PRAGMA table_info(execution_task_runtime_evidence)").all();
    if (columns.some((column) => column.name === "provider_diagnostic_json")) {
      throw executionTaskError(
        "execution_task_schema_unsupported",
        "unsafe preexisting execution task SQLite v16 Provider diagnostic schema",
      );
    }
    addRuntimeEvidenceProviderDiagnosticColumn(database);
    validateExecutionTaskSchemaV16(database);
    const updated = database.prepare(`
      UPDATE execution_task_schema SET version = 16 WHERE singleton = 1 AND version = 15
    `).run();
    if (updated.changes !== 1) {
      throw executionTaskError(
        "execution_task_schema_migration_conflict",
        "execution task schema v15 to v16 migration lost its version transition",
      );
    }
    database.exec("COMMIT");
  } catch (error) {
    rollbackIfActive(database);
    database.close();
    throw error;
  }
}

function migrateExecutionTaskSchemaV16ToV17(database, { efficiencyFingerprintKey = null } = {}) {
  database.exec("BEGIN IMMEDIATE");
  try {
    validateExecutionTaskSchemaV16(database);
    createOpsIncidentDiagnosisSchemaV17(database);
    validateOpsIncidentDiagnosisSchemaV17(database);
    const updated = database.prepare(`
      UPDATE execution_task_schema SET version = 17 WHERE singleton = 1 AND version = 16
    `).run();
    if (updated.changes !== 1) {
      throw executionTaskError(
        "execution_task_schema_migration_conflict",
        "execution task schema v16 to v17 migration lost its version transition",
      );
    }
    database.exec("COMMIT");
  } catch (error) {
    rollbackIfActive(database);
    database.close();
    throw error;
  }
}

function migrateExecutionTaskSchemaV17ToV18(database, { efficiencyFingerprintKey = null } = {}) {
  database.exec("BEGIN IMMEDIATE");
  try {
    validateOpsIncidentDiagnosisSchemaV17(database);
    createOpsIncidentDiagnosisSchemaV18(database);
    validateOpsIncidentDiagnosisSchemaV18(database);
    const updated = database.prepare(`
      UPDATE execution_task_schema SET version = 18 WHERE singleton = 1 AND version = 17
    `).run();
    if (updated.changes !== 1) {
      throw executionTaskError(
        "execution_task_schema_migration_conflict",
        "execution task schema v17 to v18 migration lost its version transition",
      );
    }
    database.exec("COMMIT");
  } catch (error) {
    rollbackIfActive(database);
    database.close();
    throw error;
  }
}

function migrateExecutionTaskSchemaV18ToV19(database, { efficiencyFingerprintKey = null } = {}) {
  database.exec("BEGIN IMMEDIATE");
  try {
    validateOpsIncidentDiagnosisSchemaV18(database);
    createOpsIncidentDiagnosisSchemaV19(database);
    validateOpsIncidentDiagnosisSchemaV19(database);
    const updated = database.prepare(`
      UPDATE execution_task_schema SET version = 19 WHERE singleton = 1 AND version = 18
    `).run();
    if (updated.changes !== 1) {
      throw executionTaskError(
        "execution_task_schema_migration_conflict",
        "execution task schema v18 to v19 migration lost its version transition",
      );
    }
    database.exec("COMMIT");
  } catch (error) {
    rollbackIfActive(database);
    database.close();
    throw error;
  }
}

function migrateExecutionTaskSchemaV19ToV20(database) {
  database.exec("BEGIN IMMEDIATE");
  try {
    validateOpsIncidentDiagnosisSchemaV19(database);
    database.exec(DESKTOP_SANDBOX_DISPATCH_ATTEMPT_SCHEMA_V21_SQL);
    validateDesktopSandboxDispatchAttemptSchemaV21(database);
    const updated = database.prepare(`
      UPDATE execution_task_schema SET version = 20 WHERE singleton = 1 AND version = 19
    `).run();
    if (updated.changes !== 1) {
      throw executionTaskError(
        "execution_task_schema_migration_conflict",
        "execution task schema v19 to v20 migration lost its version transition",
      );
    }
    database.exec("COMMIT");
  } catch (error) {
    rollbackIfActive(database);
    database.close();
    throw error;
  }
}

function migrateExecutionTaskSchemaV20ToV21(database) {
  database.exec("BEGIN IMMEDIATE");
  try {
    const count = Number(database.prepare(`
      SELECT COUNT(*) AS count FROM execution_desktop_sandbox_dispatch_attempts
    `).get()?.count || 0);
    if (count !== 0) {
      throw executionTaskError(
        "desktop_sandbox_dispatch_attempt_migration_blocked",
        "v20 Desktop Sandbox dispatch attempts require explicit reconciliation before migration",
      );
    }
    database.exec("DROP TABLE execution_desktop_sandbox_dispatch_attempts");
    database.exec(DESKTOP_SANDBOX_DISPATCH_ATTEMPT_SCHEMA_V21_SQL);
    validateDesktopSandboxDispatchAttemptSchemaV21(database);
    const updated = database.prepare(`
      UPDATE execution_task_schema SET version = 21 WHERE singleton = 1 AND version = 20
    `).run();
    if (updated.changes !== 1) {
      throw executionTaskError(
        "execution_task_schema_migration_conflict",
        "execution task schema v20 to v21 migration lost its version transition",
      );
    }
    database.exec("COMMIT");
  } catch (error) {
    rollbackIfActive(database);
    database.close();
    throw error;
  }
}

function migrateExecutionTaskSchemaV22ToV23(database) {
  database.exec("BEGIN IMMEDIATE");
  try {
    createRuntimeRequestMetricsSchemaV23(database);
    validateRuntimeRequestMetricsSchemaV23(database);
    const result = database.prepare("UPDATE execution_task_schema SET version=23 WHERE singleton=1 AND version=22").run();
    if (result.changes !== 1) throw executionTaskError("execution_task_schema_migration_conflict", "runtime request metrics migration conflict");
    database.exec("COMMIT");
  } catch (error) { rollbackIfActive(database); database.close(); throw error; }
}
function migrateExecutionTaskSchemaV21ToV22(database) {
  database.exec("BEGIN IMMEDIATE");
  try {
    createGroupSchemaV22(database);
    validateGroupSchemaV22(database);
    const result = database.prepare("UPDATE execution_task_schema SET version=22 WHERE singleton=1 AND version=21").run();
    if (result.changes !== 1) throw executionTaskError("execution_task_schema_migration_conflict", "Group metadata migration conflict");
    database.exec("COMMIT");
  } catch (error) {
    rollbackIfActive(database);
    database.close();
    throw error;
  }
}

function validateDesktopSandboxDispatchAttemptSchemaV21(database) {
  const expectedColumns = new Set([
    "tenant_scope", "task_id", "attempt_id", "contract_version", "device_session_digest", "profile_digest",
    "operation_digest", "task_input_digest", "workspace_input_digest", "attempt_lease_fence_digest",
    "attempt_lease_fencing_token", "status", "transition_lease_fence_digest", "transition_lease_fencing_token",
    "state_evidence_digest", "created_at", "updated_at", "expires_at",
  ]);
  const columns = database.prepare("PRAGMA table_info(execution_desktop_sandbox_dispatch_attempts)").all();
  const foreignKeys = database.prepare("PRAGMA foreign_key_list(execution_desktop_sandbox_dispatch_attempts)").all();
  const indexCount = database.prepare(`
    SELECT COUNT(*) AS count FROM sqlite_master
    WHERE type = 'index' AND name IN (
      'execution_desktop_sandbox_dispatch_attempts_task_idx',
      'execution_desktop_sandbox_dispatch_attempts_device_idx'
    )
  `).get()?.count;
  if (columns.length !== expectedColumns.size || !columns.every((column) => expectedColumns.has(column.name)) ||
    foreignKeys.length !== 2 || !foreignKeys.every((foreignKey) =>
      foreignKey.table === "execution_tasks" && foreignKey.on_delete === "CASCADE") || indexCount !== 2) {
    throw executionTaskError(
      "execution_task_schema_unsupported",
      "execution task SQLite schema v21 Desktop Sandbox dispatch authority is invalid",
    );
  }
}

function validateTaskEventSchemaV8MigrationSource(database) {
  const statements = TASK_EVENT_SCHEMA_V8_SQL.split(";").map((value) => value.trim()).filter(Boolean);
  const canonicalTableSql = statements[0].replace(
    "CREATE TABLE IF NOT EXISTS execution_task_events",
    "CREATE TABLE execution_task_events",
  );
  const renamedTableSql = statements[0].replace(
    "CREATE TABLE IF NOT EXISTS execution_task_events",
    'CREATE TABLE "execution_task_events"',
  );
  const canonicalIndexSql = statements[1].replace("CREATE INDEX IF NOT EXISTS", "CREATE INDEX");
  const columns = database.prepare("PRAGMA table_info(execution_task_events)").all();
  const expectedColumns = [
    "tenant_scope", "task_id", "seq", "event_key", "ownership_digest", "contract_version",
    "event_type", "occurred_at", "task_revision", "status", "wait_reason_code", "last_error_code",
    "attempt_count", "recovery_count", "progress_stage", "progress_status", "presentation_code", "result_kind",
  ];
  const tableSql = normalizeSchemaSql(database.prepare(`
    SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'execution_task_events'
  `).get()?.sql);
  const indexSql = normalizeSchemaSql(database.prepare(`
    SELECT sql FROM sqlite_master WHERE type = 'index' AND name = 'execution_task_events_lookup_idx'
  `).get()?.sql);
  const foreignKeys = database.prepare("PRAGMA foreign_key_list(execution_task_events)").all();
  const attachedObjects = database.prepare(`
    SELECT type, name FROM sqlite_master
    WHERE tbl_name = 'execution_task_events'
    ORDER BY type, name
  `).all();
  const referencingViews = database.prepare(`
    SELECT name FROM sqlite_master
    WHERE type = 'view' AND lower(COALESCE(sql, '')) LIKE '%execution_task_events%'
  `).all();
  const expectedObjects = [
    "execution_task_events",
    "execution_task_events_lookup_idx",
    "sqlite_autoindex_execution_task_events_1",
    "sqlite_autoindex_execution_task_events_2",
  ].sort();
  const valid = columns.length === expectedColumns.length &&
    columns.every((column, index) => column.name === expectedColumns[index]) &&
    columns[0]?.pk === 1 && columns[1]?.pk === 2 && columns[2]?.pk === 3 &&
    (tableSql === normalizeSchemaSql(canonicalTableSql) || tableSql === normalizeSchemaSql(renamedTableSql)) &&
    indexSql === normalizeSchemaSql(canonicalIndexSql) &&
    foreignKeys.length === 2 && foreignKeys.every((item) =>
      item.table === "execution_tasks" && item.on_delete === "CASCADE") &&
    isDeepStrictEqual(attachedObjects.map((item) => item.name).sort(), expectedObjects) &&
    referencingViews.length === 0;
  if (!valid) {
    throw executionTaskError(
      "execution_task_schema_unsupported",
      "execution task SQLite schema v8 task event authority is invalid",
    );
  }
}

function rebuildTaskEventSchemaV9(database) {
  database.exec(TASK_EVENT_SCHEMA_V9_SQL);
  database.exec(`
    INSERT INTO execution_task_events_v9 (
      tenant_scope, task_id, seq, event_key, ownership_digest, contract_version, event_type, occurred_at,
      task_revision, status, wait_reason_code, last_error_code, attempt_count, recovery_count,
      progress_stage, progress_status, presentation_code, result_kind, artifact_id
    )
    SELECT tenant_scope, task_id, seq, event_key, ownership_digest, contract_version, event_type, occurred_at,
      task_revision, status, wait_reason_code, last_error_code, attempt_count, recovery_count,
      progress_stage, progress_status, presentation_code, result_kind, NULL
    FROM execution_task_events;
    DROP TABLE execution_task_events;
    ALTER TABLE execution_task_events_v9 RENAME TO execution_task_events;
    CREATE INDEX execution_task_events_lookup_idx
      ON execution_task_events(tenant_scope, task_id, seq);
  `);
}

function validateExecutionTaskSchemaV6(database) {
  const column = database.prepare("PRAGMA table_info(execution_tasks)").all()
    .find((item) => item.name === "terminal_evidence_digest");
  const tableSql = String(database.prepare(`
    SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'execution_tasks'
  `).get()?.sql || "").replace(/\s+/g, " ").replace(/\(\s+/g, "(").replace(/\s+\)/g, ")").toLowerCase();
  const terminalEvidenceCheck = `terminal_evidence_digest text check (` +
    `terminal_evidence_digest is null or ` +
    `(length(terminal_evidence_digest) = 64 and terminal_evidence_digest not glob '*[^a-f0-9]*'))`;
  if (!column || String(column.type).toUpperCase() !== "TEXT" || column.notnull !== 0 ||
    column.dflt_value !== null || !tableSql.includes(terminalEvidenceCheck)) {
    throw executionTaskError(
      "execution_task_schema_unsupported",
      "execution task SQLite schema v6 terminal evidence column is invalid",
    );
  }
}

function validateExecutionTaskSchemaV7(database) {
  const columns = database.prepare("PRAGMA table_info(execution_provider_attempt_receipts)").all();
  const expectedColumns = [
    "tenant_scope", "task_id", "execution_scope_id", "purpose", "provider_request_id",
    "request_digest", "provider_binding_digest", "input_digest", "recovery_mode", "contract_version",
    "attempt_number", "status", "fencing_token", "ownership_digest", "safe_result_code", "ingest_ref",
    "ingest_evidence_digest", "attempt_evidence_digest", "receipt_evidence_digest",
    "created_at", "updated_at", "finished_at",
  ];
  const index = database.prepare(`
    SELECT type, sql FROM sqlite_master
    WHERE name = 'execution_provider_attempt_receipts_status_idx'
  `).get();
  const tableSql = normalizeSchemaSql(database.prepare(`
    SELECT sql FROM sqlite_master
    WHERE type = 'table' AND name = 'execution_provider_attempt_receipts'
  `).get()?.sql);
  const foreignKeys = database.prepare("PRAGMA foreign_key_list(execution_provider_attempt_receipts)").all();
  const attachedObjects = database.prepare(`
    SELECT type, name FROM sqlite_master
    WHERE tbl_name = 'execution_provider_attempt_receipts'
    ORDER BY type, name
  `).all();
  const expectedIndexes = [
    "execution_provider_attempt_receipts_status_idx",
    "sqlite_autoindex_execution_provider_attempt_receipts_1",
    "sqlite_autoindex_execution_provider_attempt_receipts_2",
  ];
  const attachedIndexes = attachedObjects.filter((item) => item.type === "index")
    .map((item) => item.name).sort();
  const valid = columns.length === expectedColumns.length &&
    columns.every((column, indexValue) => column.name === expectedColumns[indexValue]) &&
    columns[0]?.pk === 1 && columns[1]?.pk === 2 &&
    index?.type === "index" && normalizeSchemaSql(index.sql) === normalizeSchemaSql(
      "CREATE INDEX execution_provider_attempt_receipts_status_idx " +
      "ON execution_provider_attempt_receipts (tenant_scope, status, updated_at)",
    ) &&
    foreignKeys.length === 2 && foreignKeys.every((item) =>
      item.table === "execution_tasks" && item.on_delete === "CASCADE") &&
    attachedObjects.filter((item) => item.type === "table").length === 1 &&
    attachedObjects.filter((item) => item.type === "trigger" || item.type === "view").length === 0 &&
    isDeepStrictEqual(attachedIndexes, expectedIndexes) &&
    tableSql === normalizeSchemaSql(PROVIDER_ATTEMPT_SCHEMA_SQL.split(";")[0]);
  if (!valid) {
    throw executionTaskError(
      "execution_task_schema_unsupported",
      "execution task SQLite schema v7 Provider attempt authority is invalid",
    );
  }
}

function validateExecutionTaskSchemaV8(database) {
  const columns = database.prepare("PRAGMA table_info(execution_task_runtime_evidence)").all();
  const hasProviderDiagnostic = columns.some((column) => column.name === "provider_diagnostic_json");
  const hasRequestMetrics = columns.some((column) => column.name === "request_metrics_json");
  const expectedColumns = [
    "tenant_scope", "task_id", "contract_version", "status", "real_model_requested",
    "provider", "model", "reasoning_effort", "adapter", "request_count", "tool_call_count",
    "tool_calls_json", "input_tokens", "output_tokens", "total_tokens", "blocked_reason", "updated_at",
    ...(hasProviderDiagnostic ? ["provider_diagnostic_json"] : []),
    ...(hasRequestMetrics ? ["request_metrics_json"] : []),
  ];
  const tableSql = normalizeSchemaSql(database.prepare(`
    SELECT sql FROM sqlite_master
    WHERE type = 'table' AND name = 'execution_task_runtime_evidence'
  `).get()?.sql);
  const foreignKeys = database.prepare("PRAGMA foreign_key_list(execution_task_runtime_evidence)").all();
  const attachedObjects = database.prepare(`
    SELECT type, name FROM sqlite_master
    WHERE tbl_name = 'execution_task_runtime_evidence'
    ORDER BY type, name
  `).all();
  const attachedIndexes = attachedObjects.filter((item) => item.type === "index")
    .map((item) => item.name).sort();
  const valid = columns.length === expectedColumns.length &&
    columns.every((column, indexValue) => column.name === expectedColumns[indexValue]) &&
    columns[0]?.pk === 1 && columns[1]?.pk === 2 &&
    foreignKeys.length === 2 && foreignKeys.every((item) =>
      item.table === "execution_tasks" && item.on_delete === "CASCADE") &&
    attachedObjects.filter((item) => item.type === "table").length === 1 &&
    attachedObjects.filter((item) => item.type === "trigger" || item.type === "view").length === 0 &&
    isDeepStrictEqual(attachedIndexes, ["sqlite_autoindex_execution_task_runtime_evidence_1"]) &&
    (hasProviderDiagnostic
      ? tableSql.includes("provider_diagnostic_json text not null default")
      : tableSql === normalizeSchemaSql(RUNTIME_EVIDENCE_SCHEMA_SQL.split(";")[0]));
  if (!valid) {
    throw executionTaskError(
      "execution_task_schema_unsupported",
      "execution task SQLite schema v8 runtime evidence authority is invalid",
    );
  }
}

function validateExecutionTaskSchemaV9(database) {
  const statements = ARTIFACT_SCHEMA_SQL.split(";").map((value) => value.trim()).filter(Boolean);
  const expectedSql = new Map([
    ["execution_artifact_objects", normalizeSchemaSql(statements[0])],
    ["execution_task_artifacts", normalizeSchemaSql(statements[1])],
    ["execution_task_artifacts_task_idx", normalizeSchemaSql(statements[2])],
    ["execution_task_artifacts_expiry_idx", normalizeSchemaSql(statements[3])],
    ["execution_task_events", normalizeSchemaSql(TASK_EVENT_SCHEMA_V9_SQL.trim()
      .replace("CREATE TABLE execution_task_events_v9", "CREATE TABLE \"execution_task_events\"")
      .replace(/;$/, ""))],
    ["execution_task_events_lookup_idx", normalizeSchemaSql(
      "CREATE INDEX execution_task_events_lookup_idx " +
      "ON execution_task_events(tenant_scope, task_id, seq)",
    )],
  ]);
  let actualObjects = database.prepare(`
    SELECT type, name, tbl_name, sql FROM sqlite_master
    WHERE tbl_name IN ('execution_artifact_objects', 'execution_task_artifacts', 'execution_task_events')
    ORDER BY type, name
  `).all();
  if (database.prepare("SELECT version FROM execution_task_schema WHERE singleton = 1").get()?.version >= 11) {
    actualObjects = actualObjects.filter((item) => item.name !== "execution_task_artifacts_object_expiry_v11_idx");
  }
  const expectedNames = [
    "execution_artifact_objects",
    "execution_task_artifacts",
    "execution_task_artifacts_expiry_idx",
    "execution_task_artifacts_task_idx",
    "execution_task_events",
    "execution_task_events_lookup_idx",
    "sqlite_autoindex_execution_artifact_objects_1",
    "sqlite_autoindex_execution_task_artifacts_1",
    "sqlite_autoindex_execution_task_artifacts_2",
    "sqlite_autoindex_execution_task_events_1",
    "sqlite_autoindex_execution_task_events_2",
  ].sort();
  const actualNames = actualObjects.map((item) => item.name).sort();
  const valid = isDeepStrictEqual(actualNames, expectedNames) && actualObjects.every((item) =>
    item.name.startsWith("sqlite_autoindex_") ||
    normalizeSchemaSql(item.sql) === expectedSql.get(item.name));
  if (!valid) {
    throw executionTaskError(
      "execution_task_schema_unsupported",
      "execution task SQLite schema v9 artifact authority is invalid",
    );
  }
}

function validateExecutionTaskSchemaV10(database) {
  const statements = REUSABLE_ARTIFACT_GRANT_SCHEMA_SQL.split(";").map((value) => value.trim()).filter(Boolean);
  const expectedSql = new Map([
    ["execution_reusable_artifact_grants", normalizeSchemaSql(statements[0])],
    ["execution_reusable_artifact_grants_actor_idx", normalizeSchemaSql(statements[1])],
  ]);
  let actualObjects = database.prepare(`
    SELECT type, name, sql FROM sqlite_master
    WHERE tbl_name = 'execution_reusable_artifact_grants'
    ORDER BY type, name
  `).all();
  if (database.prepare("SELECT version FROM execution_task_schema WHERE singleton = 1").get()?.version >= 11) {
    actualObjects = actualObjects.filter((item) => ![
      "execution_reusable_artifact_grants_expiry_v11_idx",
      "execution_reusable_artifact_grants_source_expiry_v11_idx",
    ].includes(item.name));
  }
  const expectedNames = [
    "execution_reusable_artifact_grants",
    "execution_reusable_artifact_grants_actor_idx",
    "sqlite_autoindex_execution_reusable_artifact_grants_1",
    "sqlite_autoindex_execution_reusable_artifact_grants_2",
  ].sort();
  const foreignKeys = database.prepare("PRAGMA foreign_key_list(execution_reusable_artifact_grants)").all();
  const valid = isDeepStrictEqual(actualObjects.map((item) => item.name).sort(), expectedNames) &&
    actualObjects.every((item) => item.name.startsWith("sqlite_autoindex_") ||
      normalizeSchemaSql(item.sql) === expectedSql.get(item.name)) &&
    foreignKeys.length === 3 && foreignKeys.every((item) =>
      item.table === "execution_task_artifacts" && item.on_delete === "NO ACTION");
  if (!valid) {
    throw executionTaskError(
      "execution_task_schema_unsupported",
      "execution task SQLite schema v10 reusable Artifact grant authority is invalid",
    );
  }
}

function validateExecutionTaskSchemaV11(database) {
  const statements = ARTIFACT_RETENTION_SCHEMA_V11_SQL.split(";").map((value) => value.trim()).filter(Boolean);
  const expectedSql = new Map([
    ["execution_artifact_ref_retirements", normalizeSchemaSql(statements[0])],
    ["execution_artifact_ref_retirements_time_idx", normalizeSchemaSql(statements[1])],
    ["execution_artifact_object_lifecycle", normalizeSchemaSql(statements[2])],
    ["execution_artifact_object_lifecycle_state_idx", normalizeSchemaSql(statements[3])],
    ["execution_task_artifacts_object_expiry_v11_idx", normalizeSchemaSql(statements[4])],
    ["execution_reusable_artifact_grants_expiry_v11_idx", normalizeSchemaSql(statements[5])],
    ["execution_reusable_artifact_grants_source_expiry_v11_idx", normalizeSchemaSql(statements[6])],
  ]);
  const actualObjects = database.prepare(`
    SELECT type, name, sql FROM sqlite_master
    WHERE tbl_name IN ('execution_artifact_ref_retirements', 'execution_artifact_object_lifecycle')
      OR name IN (
        'execution_task_artifacts_object_expiry_v11_idx',
        'execution_reusable_artifact_grants_expiry_v11_idx',
        'execution_reusable_artifact_grants_source_expiry_v11_idx'
      )
    ORDER BY type, name
  `).all();
  const expectedNames = [
    "execution_artifact_ref_retirements",
    "execution_artifact_ref_retirements_time_idx",
    "execution_artifact_object_lifecycle",
    "execution_artifact_object_lifecycle_state_idx",
    "execution_task_artifacts_object_expiry_v11_idx",
    "execution_reusable_artifact_grants_expiry_v11_idx",
    "execution_reusable_artifact_grants_source_expiry_v11_idx",
    "sqlite_autoindex_execution_artifact_ref_retirements_1",
    "sqlite_autoindex_execution_artifact_object_lifecycle_1",
  ].sort();
  const retirementForeignKeys = database.prepare(
    "PRAGMA foreign_key_list(execution_artifact_ref_retirements)",
  ).all();
  const lifecycleForeignKeys = database.prepare(
    "PRAGMA foreign_key_list(execution_artifact_object_lifecycle)",
  ).all();
  const objectCount = database.prepare("SELECT COUNT(*) AS count FROM execution_artifact_objects").get().count;
  const lifecycleCount = database.prepare("SELECT COUNT(*) AS count FROM execution_artifact_object_lifecycle").get().count;
  const invalidStateCount = database.prepare(`
    SELECT COUNT(*) AS count FROM execution_artifact_object_lifecycle lifecycle
    LEFT JOIN execution_artifact_objects object
      ON object.tenant_scope = lifecycle.tenant_scope AND object.sha256 = lifecycle.object_sha256
    WHERE object.sha256 IS NULL
      OR (lifecycle.state = 'present' AND (
        lifecycle.cleanup_requested_at IS NOT NULL OR lifecycle.deleted_at IS NOT NULL
      ))
      OR (lifecycle.state = 'delete_pending' AND (
        lifecycle.cleanup_requested_at IS NULL OR lifecycle.deleted_at IS NOT NULL
      ))
      OR (lifecycle.state = 'deleted' AND (
        lifecycle.cleanup_requested_at IS NULL OR lifecycle.deleted_at IS NULL
      ))
      OR (lifecycle.state = 'reconcile_required' AND lifecycle.deleted_at IS NOT NULL)
  `).get().count;
  const valid = isDeepStrictEqual(actualObjects.map((item) => item.name).sort(), expectedNames) &&
    actualObjects.every((item) => item.name.startsWith("sqlite_autoindex_") ||
      normalizeSchemaSql(item.sql) === expectedSql.get(item.name)) &&
    retirementForeignKeys.length === 2 && retirementForeignKeys.every((item) =>
      item.table === "execution_task_artifacts" && item.on_delete === "NO ACTION") &&
    lifecycleForeignKeys.length === 2 && lifecycleForeignKeys.every((item) =>
      item.table === "execution_artifact_objects" && item.on_delete === "NO ACTION") &&
    lifecycleCount === objectCount && invalidStateCount === 0;
  if (!valid) {
    throw executionTaskError(
      "execution_task_schema_unsupported",
      "execution task SQLite schema v11 Artifact retention authority is invalid",
    );
  }
}

function validateExecutionTaskSchemaV12(database) {
  const statements = RUNTIME_ACTIVITY_SCHEMA_V12_SQL.split(";").map((value) => value.trim()).filter(Boolean);
  const expectedSql = new Map([
    ["execution_task_runtime_activities", normalizeSchemaSql(statements[0])],
    ["execution_task_runtime_activities_order_idx", normalizeSchemaSql(statements[1])],
  ]);
  const actualObjects = database.prepare(`
    SELECT type, name, sql FROM sqlite_master
    WHERE tbl_name = 'execution_task_runtime_activities'
    ORDER BY type, name
  `).all();
  const expectedNames = [
    "execution_task_runtime_activities",
    "execution_task_runtime_activities_order_idx",
    "sqlite_autoindex_execution_task_runtime_activities_1",
    "sqlite_autoindex_execution_task_runtime_activities_2",
  ].sort();
  const foreignKeys = database.prepare(
    "PRAGMA foreign_key_list(execution_task_runtime_activities)",
  ).all();
  const unsafeEvidencePayloadCount = database.prepare(`
    SELECT COUNT(*) AS count FROM execution_task_runtime_evidence
    WHERE tool_calls_json <> '[]'
  `).get().count;
  const countMismatch = database.prepare(`
    SELECT COUNT(*) AS count
    FROM (
      SELECT evidence.tenant_scope, evidence.task_id
      FROM execution_task_runtime_evidence evidence
      LEFT JOIN execution_task_runtime_activities activity
        ON activity.tenant_scope = evidence.tenant_scope AND activity.task_id = evidence.task_id
      GROUP BY evidence.tenant_scope, evidence.task_id, evidence.tool_call_count
      HAVING COUNT(activity.activity_id) > evidence.tool_call_count
    )
  `).get().count;
  let activityRowsValid = true;
  const activityRows = database.prepare(`
    SELECT * FROM execution_task_runtime_activities
    ORDER BY tenant_scope, task_id, sequence
  `).all();
  const grouped = new Map();
  for (const row of activityRows) {
    const key = `${row.tenant_scope}\0${row.task_id}`;
    const rows = grouped.get(key) || [];
    rows.push(row);
    grouped.set(key, rows);
  }
  try {
    for (const rows of grouped.values()) runtimeActivityRowsToSnapshot(rows, rows[0].task_id);
  } catch {
    activityRowsValid = false;
  }
  const valid = isDeepStrictEqual(actualObjects.map((item) => item.name).sort(), expectedNames) &&
    actualObjects.every((item) => item.name.startsWith("sqlite_autoindex_") ||
      normalizeSchemaSql(item.sql) === expectedSql.get(item.name)) &&
    foreignKeys.length === 2 && foreignKeys.every((item) =>
      item.table === "execution_tasks" && item.on_delete === "CASCADE") &&
    unsafeEvidencePayloadCount === 0 && countMismatch === 0 && activityRowsValid;
  if (!valid) {
    throw executionTaskError(
      "execution_task_schema_unsupported",
      "execution task SQLite schema v12 runtime activity authority is invalid",
    );
  }
}

function validateExecutionTaskSchemaV16(database) {
  const column = database.prepare("PRAGMA table_info(execution_task_runtime_evidence)").all()
    .find((item) => item.name === "provider_diagnostic_json");
  const validColumn = column &&
    String(column.type).toUpperCase() === "TEXT" &&
    column.notnull === 1 &&
    sqliteDefaultJsonMatches(column.dflt_value, DEFAULT_PROVIDER_DIAGNOSTIC);
  if (!validColumn) {
    throw executionTaskError(
      "execution_task_schema_unsupported",
      "execution task SQLite schema v16 Provider diagnostic column is invalid",
    );
  }
  const rows = database.prepare(`
    SELECT provider_diagnostic_json FROM execution_task_runtime_evidence
    ORDER BY tenant_scope, task_id
  `).all();
  const validRows = rows.every((row) => {
    try {
      return providerDiagnosticJson(parseProviderDiagnosticJson(row.provider_diagnostic_json)) ===
        row.provider_diagnostic_json;
    } catch {
      return false;
    }
  });
  if (!validRows) {
    throw executionTaskError(
      "execution_task_schema_unsupported",
      "execution task SQLite schema v16 Provider diagnostic payload is invalid",
    );
  }
}

function validateRuntimeRequestMetricsSchemaV23(database) {
  const column = database.prepare("PRAGMA table_info(execution_task_runtime_evidence)").all()
    .find((item) => item.name === "request_metrics_json");
  if (!column || String(column.type).toUpperCase() !== "TEXT" || column.notnull !== 1 ||
    !sqliteDefaultJsonMatches(column.dflt_value, [])) {
    throw executionTaskError(
      "execution_task_schema_unsupported",
      "execution task schema v23 runtime request metrics column is invalid",
    );
  }
  const rows = database.prepare("SELECT request_metrics_json FROM execution_task_runtime_evidence").all();
  for (const row of rows) {
    try {
      if (!Array.isArray(JSON.parse(row.request_metrics_json || "[]"))) throw new Error("not an array");
    } catch {
      throw executionTaskError(
        "execution_task_schema_unsupported",
        "execution task schema v23 runtime request metrics payload is invalid",
      );
    }
  }
}

function normalizeSchemaSql(value) {
  return String(value || "").replace(/\s+/g, " ").replace(/\(\s+/g, "(").replace(/\s+\)/g, ")")
    .trim().toLowerCase();
}

function sqliteDefaultJsonMatches(value, expected) {
  const raw = String(value || "").trim();
  const unquoted = raw.startsWith("'") && raw.endsWith("'")
    ? raw.slice(1, -1).replace(/''/g, "'")
    : raw;
  try {
    return isDeepStrictEqual(JSON.parse(unquoted), expected);
  } catch {
    return false;
  }
}

function runtimeActivityRowsToSnapshot(rows, taskId) {
  return normalizeRuntimeSafeActivitySnapshot({
    contractVersion: RUNTIME_SAFE_ACTIVITY_SNAPSHOT_CONTRACT_VERSION,
    taskId,
    activities: rows.map((row) => ({
      activityId: row.activity_id,
      sequence: row.sequence,
      kind: row.kind,
      subjectId: row.subject_id,
      displayName: row.display_name,
      actionCode: row.action_code,
      ...(row.operation_code ? { operationCode: row.operation_code } : {}),
      status: row.status,
    })),
  }, { expectedTaskId: taskId });
}

function legacyRuntimeSafeActivitySnapshot({ taskId, toolCalls = [] } = {}) {
  return normalizeRuntimeSafeActivitySnapshot({
    contractVersion: RUNTIME_SAFE_ACTIVITY_SNAPSHOT_CONTRACT_VERSION,
    taskId,
    activities: toolCalls.map((call) => ({
      activityId: canonicalRuntimeSafeActivityId(taskId, call.sequence),
      sequence: call.sequence,
      kind: "tool",
      subjectId: "declared-tool",
      displayName: runtimeSafeActivityDisplayName("tool.execute"),
      actionCode: "tool.execute",
      status: call.status === "running" ? "started" : call.status,
    })),
  }, { expectedTaskId: taskId });
}

function emptyRuntimeActivitySnapshot(taskId) {
  return normalizeRuntimeSafeActivitySnapshot({
    contractVersion: RUNTIME_SAFE_ACTIVITY_SNAPSHOT_CONTRACT_VERSION,
    taskId,
    activities: [],
  }, { expectedTaskId: taskId });
}

function rowToTask(
  row,
  runtimeEvidenceRow = null,
  runtimeActivityState = null,
  runtimeProvenanceState = null,
  runtimeEfficiencyState = null,
) {
  const activitySnapshot = runtimeActivityState?.activitySnapshot ||
    (runtimeEvidenceRow ? emptyRuntimeActivitySnapshot(row.task_id) : null);
  if (runtimeEfficiencyState && !runtimeEfficiencyMatchesTaskActivityPrefix({
    activitySnapshot: activitySnapshot || emptyRuntimeActivitySnapshot(row.task_id),
    row,
    sourceSnapshot: runtimeEfficiencyState.sourceSnapshot,
  })) {
    throw executionTaskError(
      "runtime_tool_efficiency_task_activity_conflict",
      "Tool efficiency source does not match canonical task and activity authority",
    );
  }
  return Object.freeze({
    taskId: row.task_id,
    contractVersion: row.contract_version,
    revision: row.revision,
    tenantScope: row.tenant_scope,
    actorIssuer: row.actor_issuer,
    actorSubjectDigest: row.actor_subject_digest,
    employeeId: row.employee_id,
    employeeVersion: row.employee_version,
    sessionId: row.session_id,
    sourceSystemId: row.source_system_id,
    channelId: row.channel_id,
    taskType: row.task_type,
    submissionScope: row.submission_scope,
    idempotencyKey: row.idempotency_key,
    inputDigest: row.input_digest,
    executionInputRef: Object.freeze({
      kind: row.execution_input_kind,
      refId: row.execution_input_ref_id,
    }),
    workspaceRef: row.workspace_ref,
    priority: row.priority,
    status: row.status,
    waitReasonCode: row.wait_reason_code,
    latestEventSeq: row.last_event_seq,
    eventsPrunedThroughSeq: row.events_pruned_through_seq,
    enqueueSeq: row.enqueue_seq,
    queueOrder: row.queue_order,
    availableAt: row.available_at,
    attemptCount: row.attempt_count,
    recoveryCount: row.recovery_count,
    maxRecoveries: row.max_recoveries,
    executionDeadlineAt: row.execution_deadline_at,
    providerTimeoutPolicy: Object.freeze({
      contractVersion: "provider-timeout-policy.v1",
      policyVersion: row.timeout_policy_version,
      connectMs: row.timeout_connect_ms,
      firstSemanticOutputMs: row.timeout_first_output_ms,
      streamIdleMs: row.timeout_stream_idle_ms,
      requestTotalMs: row.timeout_request_total_ms,
      taskExecutionTotalMs: row.timeout_task_total_ms,
    }),
    createdAt: row.created_at,
    queuedAt: row.queued_at,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    updatedAt: row.updated_at,
    lastErrorCode: row.last_error_code,
    resultSummary: row.result_summary,
    terminalEvidenceDigest: row.terminal_evidence_digest,
    runtimeEvidence: runtimeEvidenceRow ? rowToRuntimeEvidence(runtimeEvidenceRow, activitySnapshot) : null,
    activitySnapshot,
    activityUpdatedAt: runtimeActivityState?.updatedAt || "",
    provenanceSource: runtimeProvenanceState?.sourceSnapshot || null,
    provenanceRecordedAt: runtimeProvenanceState?.recordedAt || "",
    toolEfficiencySource: runtimeEfficiencyState?.sourceSnapshot || null,
    toolEfficiencyUpdatedAt: runtimeEfficiencyState?.updatedAt || "",
    lease: row.lease_id ? Object.freeze({
      leaseId: row.lease_id,
      workerIdDigest: row.worker_id_digest,
      fencingToken: row.fencing_token,
      claimedAt: row.claimed_at,
      heartbeatAt: row.heartbeat_at,
      expiresAt: row.lease_expires_at,
    }) : null,
    fencingToken: row.fencing_token,
  });
}

function runtimeEfficiencyMatchesTaskActivityPrefix({ activitySnapshot, row, sourceSnapshot }) {
  const terminalActivities = activitySnapshot.activities.filter((activity) =>
    ["blocked", "completed", "failed", "rejected", "target_rejected"].includes(activity.status));
  if (sourceSnapshot.taskId !== row.task_id || sourceSnapshot.calls.length > terminalActivities.length) return false;
  if (sourceSnapshot.calls.some((call, index) =>
    call.activityId !== terminalActivities[index]?.activityId ||
    call.sequence !== terminalActivities[index]?.sequence)) return false;
  if (TERMINAL_TASK_STATUSES.has(row.status) && sourceSnapshot.calls.length !== terminalActivities.length) return false;
  if (sourceSnapshot.breaker.status !== "triggered") return true;
  if (!TERMINAL_TASK_STATUSES.has(row.status)) return true;
  return row.status === "blocked" && row.last_error_code === "agent_tool_loop_no_progress";
}

function rowToRuntimeEvidence(row, canonicalActivitySnapshot = null) {
  let activityPayload;
  try {
    activityPayload = JSON.parse(row.tool_calls_json);
  } catch {
    throw executionTaskError(
      "runtime_evidence_integrity_invalid",
      "runtime evidence Tool-call projection is not valid JSON",
    );
  }
  const providerDiagnostic = parseProviderDiagnosticJson(row.provider_diagnostic_json);
  let requestMetrics = [];
  if (row.request_metrics_json !== undefined) {
    try {
      requestMetrics = JSON.parse(row.request_metrics_json || "[]");
    } catch {
      throw executionTaskError(
        "runtime_evidence_integrity_invalid",
        "runtime evidence request metrics projection is not valid JSON",
      );
    }
  }
  const safeActivityFormat = Boolean(canonicalActivitySnapshot) ||
    activityPayload?.contractVersion === RUNTIME_SAFE_ACTIVITY_SNAPSHOT_CONTRACT_VERSION;
  const activitySnapshot = canonicalActivitySnapshot || (safeActivityFormat ? activityPayload : null);
  const normalized = normalizeAgentRuntimeEvidence({
    contractVersion: row.contract_version,
    status: row.status,
    realModelRequested: row.real_model_requested === 1,
    provider: row.provider,
    model: row.model,
    reasoningEffort: row.reasoning_effort,
    adapter: row.adapter,
    requestCount: row.request_count,
    toolCallCount: row.tool_call_count,
    ...(safeActivityFormat ? { activitySnapshot } : { toolCalls: activityPayload }),
    usage: {
      inputTokens: row.input_tokens,
      outputTokens: row.output_tokens,
      totalTokens: row.total_tokens,
    },
    blockedReason: row.blocked_reason,
    providerDiagnostic,
    ...(row.request_metrics_json !== undefined ? { requestMetrics } : {}),
  }, { expectedTaskId: row.task_id });
  return Object.freeze({ ...normalized, updatedAt: normalizedExecutionTaskNow(row.updated_at) });
}

function providerDiagnosticJson(value) {
  return JSON.stringify(normalizeProviderRuntimeDiagnostic(value, {
    fallbackCategory: "none",
    fallbackReasonCode: "none",
    retryable: false,
  }));
}

function parseProviderDiagnosticJson(value) {
  try {
    return normalizeProviderRuntimeDiagnostic(JSON.parse(value || DEFAULT_PROVIDER_DIAGNOSTIC_JSON), {
      fallbackCategory: "none",
      fallbackReasonCode: "none",
      retryable: false,
    });
  } catch {
    throw executionTaskError(
      "runtime_evidence_integrity_invalid",
      "runtime evidence Provider diagnostic projection is not valid JSON",
    );
  }
}

function assertRuntimeEvidenceProgress(existing, next) {
  for (const field of ["contractVersion", "provider", "model", "reasoningEffort", "adapter"]) {
    if (existing[field] !== next[field]) {
      throw executionTaskError(
        "runtime_evidence_identity_conflict",
        `runtime evidence changed immutable ${field}`,
      );
    }
  }
  const existingSafeActivityFormat = Boolean(existing.activitySnapshot);
  const nextSafeActivityFormat = Boolean(next.activitySnapshot);
  if (existingSafeActivityFormat !== nextSafeActivityFormat) {
    throw executionTaskError(
      "runtime_evidence_identity_conflict",
      "runtime evidence activity format cannot change within one task",
    );
  }
  if (next.requestCount < existing.requestCount || next.toolCallCount < existing.toolCallCount) {
    throw executionTaskError(
      "runtime_evidence_progress_conflict",
      "runtime evidence counts cannot move backwards",
    );
  }
  for (const field of ["inputTokens", "outputTokens", "totalTokens"]) {
    const previous = existing.usage[field];
    const current = next.usage[field];
    if (previous !== null && (current === null || current < previous)) {
      throw executionTaskError(
        "runtime_evidence_progress_conflict",
        `runtime evidence ${field} cannot move backwards`,
      );
    }
  }
  const existingMetrics = existing.requestMetrics || [];
  const nextMetrics = next.requestMetrics || [];
  const existingLastSequence = existingMetrics.at(-1)?.sequence || 0;
  const nextLastSequence = nextMetrics.at(-1)?.sequence || 0;
  if (nextLastSequence < existingLastSequence || nextLastSequence > next.requestCount) {
    throw executionTaskError(
      "runtime_evidence_progress_conflict",
      "runtime request metrics cannot move backwards or exceed the request count",
    );
  }
  const nextBySequence = new Map(nextMetrics.map((metric) => [metric.sequence, metric]));
  existingMetrics.forEach((metric) => {
    const current = nextBySequence.get(metric.sequence);
    if (current && !isDeepStrictEqual(metric, current)) {
      throw executionTaskError(
        "runtime_evidence_progress_conflict",
        "runtime request metric identity cannot change",
      );
    }
  });
  if (existingSafeActivityFormat) {
    try {
      assertRuntimeSafeActivitySnapshotProgress(existing.activitySnapshot, next.activitySnapshot);
    } catch (error) {
      throw executionTaskError(
        error?.code || "runtime_evidence_activity_conflict",
        "runtime evidence safe activity identity or lifecycle changed",
      );
    }
    const appendedActivity = next.activitySnapshot.activities.length > existing.activitySnapshot.activities.length;
    const settledActivity = existing.activitySnapshot.activities.some((previous, index) =>
      previous.status === "started" && next.activitySnapshot.activities[index]?.status !== "started");
    if ((appendedActivity && next.status !== "tool_call_started") ||
      (settledActivity && next.status !== "tool_call_completed")) {
      throw executionTaskError(
        "runtime_safe_activity_progress_conflict",
        "runtime evidence status does not match the safe activity lifecycle transition",
      );
    }
    return;
  }
  if (next.toolCalls.length < existing.toolCalls.length) {
    throw executionTaskError(
      "runtime_evidence_progress_conflict",
      "runtime evidence Tool list cannot move backwards",
    );
  }
  existing.toolCalls.forEach((previous, index) => {
    const current = next.toolCalls[index];
    if (!current || previous.sequence !== current.sequence || previous.name !== current.name ||
      (previous.skillId && previous.skillId !== current.skillId) ||
      (previous.status !== "running" && previous.status !== current.status)) {
      throw executionTaskError(
        "runtime_evidence_tool_conflict",
        "runtime evidence Tool identity or terminal status changed",
      );
    }
  });
}

function assertInitialRuntimeEvidence(evidence) {
  if (!evidence.activitySnapshot?.activities.length) return;
  if (evidence.activitySnapshot.activities.length !== 1 ||
    evidence.activitySnapshot.activities[0].status !== "started" ||
    evidence.status !== "tool_call_started") {
    throw executionTaskError(
      "runtime_safe_activity_progress_conflict",
      "the first persisted safe activity must record one started invocation",
    );
  }
}

function rowToTaskEvent(row) {
  const data = row.event_type === "task.state_changed"
    ? {
        status: row.status,
        waitReasonCode: row.wait_reason_code,
        lastErrorCode: row.last_error_code,
        attemptCount: row.attempt_count,
        recoveryCount: row.recovery_count,
        code: row.presentation_code,
      }
    : row.event_type === "task.progress"
      ? { stage: row.progress_stage, status: row.progress_status, code: row.presentation_code }
      : row.event_type === "task.artifact_available"
        ? { artifactId: row.artifact_id }
        : { resultKind: row.result_kind };
  return Object.freeze({
    contractVersion: row.contract_version,
    taskId: row.task_id,
    seq: row.seq,
    taskRevision: row.task_revision,
    eventType: row.event_type,
    occurredAt: row.occurred_at,
    data: Object.freeze(data),
  });
}

function rowToArtifactRef(row) {
  return normalizeArtifactRef({
    artifactId: row.artifact_id,
    contractVersion: row.contract_version,
    taskId: row.task_id,
    employeeId: row.employee_id,
    fileName: row.file_name,
    mimeType: row.mime_type,
    sizeBytes: row.size_bytes,
    sha256: row.sha256,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    visibilityScope: row.visibility_scope,
  });
}

function artifactObjectCleanupCandidateSelectSql() {
  return `
    SELECT object.tenant_scope, object.sha256 AS object_sha256, object.size_bytes,
      lifecycle.state, lifecycle.generation, lifecycle.attempt_count,
      lifecycle.last_result_code, lifecycle.cleanup_requested_at,
      lifecycle.updated_at, lifecycle.deleted_at,
      CASE WHEN EXISTS (
        SELECT 1 FROM execution_task_artifacts integrity_artifact
        WHERE integrity_artifact.tenant_scope = object.tenant_scope
          AND integrity_artifact.object_sha256 = object.sha256
          AND (
            integrity_artifact.sha256 <> object.sha256
            OR integrity_artifact.size_bytes <> object.size_bytes
          )
      ) THEN 0 ELSE 1 END AS integrity_valid
    FROM execution_artifact_objects object
    INNER JOIN execution_artifact_object_lifecycle lifecycle
      ON lifecycle.tenant_scope = object.tenant_scope AND lifecycle.object_sha256 = object.sha256
  `;
}

function rowToArtifactObjectCleanupCandidate(row) {
  const state = String(row.state || "");
  if (!["present", "delete_pending", "deleted", "reconcile_required"].includes(state)) {
    throw executionTaskError("artifact_object_lifecycle_invalid", "artifact object lifecycle state is invalid");
  }
  return Object.freeze({
    tenantScope: requiredExecutionTaskToken(row.tenant_scope, "tenantScope", 160),
    objectSha256: requiredExecutionTaskDigest(row.object_sha256, "objectSha256"),
    sizeBytes: requiredPositiveArtifactSize(row.size_bytes),
    integrityValid: row.integrity_valid === 1,
    state,
    generation: requiredNonNegativeInteger(row.generation, "generation"),
    attemptCount: requiredNonNegativeInteger(row.attempt_count, "attemptCount"),
    lastResultCode: row.last_result_code || null,
    cleanupRequestedAt: row.cleanup_requested_at || null,
    updatedAt: normalizedExecutionTaskNow(row.updated_at),
    deletedAt: row.deleted_at || null,
  });
}

function reusableArtifactGrantSelectSql() {
  return `
    SELECT
      grant.tenant_scope AS grant_tenant_scope,
      grant.grant_id,
      grant.contract_version AS grant_contract_version,
      grant.actor_issuer,
      grant.actor_subject_digest,
      grant.scope_type,
      grant.source_task_id,
      grant.artifact_id AS grant_artifact_id,
      grant.created_at AS grant_created_at,
      grant.expires_at AS grant_expires_at,
      artifact.contract_version AS artifact_contract_version,
      artifact.task_id AS artifact_task_id,
      artifact.employee_id AS artifact_employee_id,
      artifact.file_name AS artifact_file_name,
      artifact.mime_type AS artifact_mime_type,
      artifact.size_bytes AS artifact_size_bytes,
      artifact.sha256 AS artifact_sha256,
      artifact.object_sha256,
      artifact.created_at AS artifact_created_at,
      artifact.expires_at AS artifact_expires_at,
      artifact.visibility_scope AS artifact_visibility_scope,
      object.size_bytes AS object_size_bytes,
      lifecycle.state AS object_lifecycle_state
    FROM execution_reusable_artifact_grants grant
    INNER JOIN execution_task_artifacts artifact
      ON artifact.tenant_scope = grant.tenant_scope
      AND artifact.task_id = grant.source_task_id
      AND artifact.artifact_id = grant.artifact_id
    INNER JOIN execution_artifact_objects object
      ON object.tenant_scope = artifact.tenant_scope AND object.sha256 = artifact.object_sha256
    INNER JOIN execution_artifact_object_lifecycle lifecycle
      ON lifecycle.tenant_scope = object.tenant_scope AND lifecycle.object_sha256 = object.sha256
  `;
}

function rowToReusableArtifactGrantRecord(row) {
  const grant = normalizeReusableArtifactGrant({
    contractVersion: row.grant_contract_version,
    tenantScope: row.grant_tenant_scope,
    grantId: row.grant_id,
    actorIssuer: row.actor_issuer,
    actorSubjectDigest: row.actor_subject_digest,
    scopeType: row.scope_type,
    sourceTaskId: row.source_task_id,
    artifactId: row.grant_artifact_id,
    createdAt: row.grant_created_at,
    expiresAt: row.grant_expires_at,
  });
  const artifact = rowToArtifactRef({
    artifact_id: row.grant_artifact_id,
    contract_version: row.artifact_contract_version,
    task_id: row.artifact_task_id,
    employee_id: row.artifact_employee_id,
    file_name: row.artifact_file_name,
    mime_type: row.artifact_mime_type,
    size_bytes: row.artifact_size_bytes,
    sha256: row.artifact_sha256,
    created_at: row.artifact_created_at,
    expires_at: row.artifact_expires_at,
    visibility_scope: row.artifact_visibility_scope,
  });
  return Object.freeze({
    artifact,
    grant,
    objectSha256: row.object_sha256,
    objectSizeBytes: row.object_size_bytes,
    objectState: row.object_lifecycle_state,
  });
}

function reusableArtifactActorIdentity({ tenantScope, actorIssuer, actorSubjectDigest } = {}) {
  return Object.freeze({
    tenantScope: requiredExecutionTaskToken(tenantScope, "tenantScope", 160),
    actorIssuer: requiredExecutionTaskToken(actorIssuer, "actorIssuer", 160),
    actorSubjectDigest: requiredExecutionTaskDigest(actorSubjectDigest, "actorSubjectDigest"),
  });
}

function sameArtifactPublication(existing, requested) {
  return existing.artifactId === requested.artifactId &&
    existing.contractVersion === requested.contractVersion &&
    existing.taskId === requested.taskId &&
    existing.employeeId === requested.employeeId &&
    existing.fileName === requested.fileName &&
    existing.mimeType === requested.mimeType &&
    existing.sizeBytes === requested.sizeBytes &&
    existing.sha256 === requested.sha256 &&
    existing.visibilityScope === requested.visibilityScope;
}

function rowToOperationReceipt(row, receiptCipher) {
  const descriptor = descriptorFromReceiptRow(row);
  const identity = {
    tenantScope: row.tenant_scope,
    taskId: row.task_id,
    fencingToken: row.fencing_token,
  };
  const payload = receiptCipher.decrypt(row.receipt_ciphertext, descriptorAad(identity, descriptor, {
    status: row.status,
    safeResultCode: row.safe_result_code,
    payloadDigest: row.payload_digest,
    ownershipDigest: row.ownership_digest,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    finishedAt: row.finished_at,
  }));
  if (operationReceiptPayloadDigest(payload) !== row.payload_digest) {
    throw executionTaskError("operation_receipt_integrity_invalid", "operation receipt payload digest did not match its encrypted content");
  }
  return Object.freeze({
    contractVersion: row.contract_version,
    tenantScope: row.tenant_scope,
    taskId: row.task_id,
    toolCallId: row.tool_call_id,
    operationDigest: row.operation_digest,
    effectKind: row.effect_kind,
    adapterId: row.adapter_id,
    actionCode: row.action_code,
    targetScopeDigest: row.target_scope_digest,
    authorizationDigest: row.authorization_digest,
    recoveryMode: row.recovery_mode,
    status: row.status,
    fencingToken: row.fencing_token,
    safeResultCode: row.safe_result_code,
    payload,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    finishedAt: row.finished_at,
  });
}

function operationReceiptExternalReference(receipt = {}) {
  if (receipt.status !== "succeeded" || receipt.safeResultCode !== "external_write_succeeded") return null;
  if (receipt.adapterId !== "feishu-approval-openapi" || receipt.actionCode !== "approval.instances.create") return null;
  const instanceCode = safeExternalReferenceValue(
    receipt.payload?.toolResult?.data?.instance_code ||
    receipt.payload?.toolResult?.data?.instanceCode ||
    receipt.payload?.data?.instance_code ||
    receipt.payload?.instance_code,
  );
  if (!instanceCode) return null;
  return Object.freeze({
    contractVersion: "runtime-task-external-reference.v1",
    type: "feishu_approval_instance",
    label: "飞书审批实例",
    sourceField: "toolResult.data.instance_code",
    value: instanceCode,
    targetSystem: "feishu_approval",
    actionCode: receipt.actionCode,
    createdAt: receipt.createdAt,
    finishedAt: receipt.finishedAt || "",
  });
}

function safeExternalReferenceValue(value) {
  const text = String(value || "").trim();
  if (!text || text.length > 200 || /[\u0000-\u001F\u007F]/.test(text)) return "";
  if (!/^[A-Za-z0-9_.:-]{6,200}$/.test(text)) return "";
  return text;
}

function rowToProviderAttemptReceipt(row) {
  if (!row) throw executionTaskError("provider_attempt_receipt_invalid", "provider attempt receipt is missing");
  try {
    return normalizeProviderAttemptReceipt({
      contractVersion: row.contract_version,
      tenantScope: row.tenant_scope,
      taskId: row.task_id,
      executionScopeId: row.execution_scope_id,
      purpose: row.purpose,
      providerRequestId: row.provider_request_id,
      requestDigest: row.request_digest,
      providerBindingDigest: row.provider_binding_digest,
      inputDigest: row.input_digest,
      recoveryMode: row.recovery_mode,
      attemptNumber: row.attempt_number,
      status: row.status,
      fencingToken: row.fencing_token,
      ownershipDigest: row.ownership_digest,
      safeResultCode: row.safe_result_code,
      ingestRef: row.ingest_ref,
      ingestEvidenceDigest: row.ingest_evidence_digest,
      attemptEvidenceDigest: row.attempt_evidence_digest,
      receiptEvidenceDigest: row.receipt_evidence_digest,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      finishedAt: row.finished_at,
    });
  } catch {
    throw executionTaskError(
      "provider_attempt_receipt_integrity_invalid",
      "provider attempt receipt failed its canonical integrity contract",
    );
  }
}

function normalizeProviderAttemptMutation(value, fields) {
  requireExactProviderAttemptObject(value, fields, "provider_attempt_request_invalid");
  const descriptor = normalizeProviderAttemptDescriptor({
    contractVersion: value.contractVersion,
    tenantScope: value.tenantScope,
    taskId: value.taskId,
    executionScopeId: value.executionScopeId,
    purpose: value.purpose,
    providerRequestId: value.providerRequestId,
    requestDigest: value.requestDigest,
    providerBindingDigest: value.providerBindingDigest,
    inputDigest: value.inputDigest,
    recoveryMode: value.recoveryMode,
  });
  return Object.freeze({
    descriptor,
    identity: normalizeLeaseIdentity(value),
    nowIso: normalizedExecutionTaskNow(value.now),
  });
}

function requireExactProviderAttemptObject(value, fields, code) {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) {
    throw executionTaskError(code, "provider attempt request must be a plain exact object");
  }
  const keys = Object.keys(value);
  if (keys.length !== fields.size || keys.some((key) => !fields.has(key))) {
    throw executionTaskError(code, "provider attempt request contains unknown or missing fields");
  }
}

function normalizeDesktopSandboxDispatchAttemptCreate(value) {
  requireExactDesktopSandboxDispatchAttemptObject(
    value,
    DESKTOP_SANDBOX_DISPATCH_ATTEMPT_CREATE_FIELDS,
    "desktop_sandbox_dispatch_attempt_request_invalid",
  );
  const identity = normalizeLeaseIdentity(value);
  const nowIso = normalizedExecutionTaskNow(value.now);
  return Object.freeze({
    attempt: createDesktopSandboxDispatchAttempt({
      attemptId: value.attemptId,
      deviceSessionDigest: value.deviceSessionDigest,
      expiresAt: value.expiresAt,
      taskInputDigest: value.taskInputDigest,
      workspaceInputDigest: value.workspaceInputDigest,
      now: nowIso,
      operationDigest: value.operationDigest,
      profileDigest: value.profileDigest,
      taskIdentity: { taskId: identity.taskId, tenantScope: identity.tenantScope },
      taskOwnership: {
        fencingToken: identity.fencingToken,
        leaseId: identity.leaseId,
        workerIdDigest: identity.workerIdDigest,
      },
    }),
    identity,
    nowIso,
  });
}

function normalizeDesktopSandboxDispatchAttemptTransition(value) {
  requireExactDesktopSandboxDispatchAttemptObject(
    value,
    DESKTOP_SANDBOX_DISPATCH_ATTEMPT_TRANSITION_FIELDS,
    "desktop_sandbox_dispatch_attempt_transition_request_invalid",
  );
  return Object.freeze({
    attemptId: requiredExecutionTaskToken(value.attemptId, "attemptId", 180).toLowerCase(),
    deviceSessionDigest: requiredExecutionTaskDigest(value.deviceSessionDigest, "deviceSessionDigest"),
    identity: normalizeLeaseIdentity(value),
    nextStatus: String(value.nextStatus || "").trim(),
    nowIso: normalizedExecutionTaskNow(value.now),
  });
}

function requireExactDesktopSandboxDispatchAttemptObject(value, fields, code) {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) {
    throw executionTaskError(code, "Desktop Sandbox dispatch attempt request must be a plain exact object");
  }
  const keys = Object.keys(value);
  if (keys.length !== fields.size || keys.some((key) => !fields.has(key))) {
    throw executionTaskError(code, "Desktop Sandbox dispatch attempt request contains unknown or missing fields");
  }
}

function rowToDesktopSandboxDispatchAttempt(row) {
  if (!row) throw executionTaskError("desktop_sandbox_dispatch_attempt_integrity_invalid");
  try {
    return normalizeDesktopSandboxDispatchAttempt({
      attemptLeaseFenceDigest: row.attempt_lease_fence_digest,
      attemptLeaseFencingToken: row.attempt_lease_fencing_token,
      attemptId: row.attempt_id,
      contractVersion: row.contract_version,
      createdAt: row.created_at,
      deviceSessionDigest: row.device_session_digest,
      expiresAt: row.expires_at,
      taskInputDigest: row.task_input_digest,
      workspaceInputDigest: row.workspace_input_digest,
      operationDigest: row.operation_digest,
      profileDigest: row.profile_digest,
      stateEvidenceDigest: row.state_evidence_digest,
      status: row.status,
      taskId: row.task_id,
      tenantScope: row.tenant_scope,
      transitionLeaseFenceDigest: row.transition_lease_fence_digest,
      transitionLeaseFencingToken: row.transition_lease_fencing_token,
      updatedAt: row.updated_at,
    });
  } catch {
    throw executionTaskError(
      "desktop_sandbox_dispatch_attempt_integrity_invalid",
      "Desktop Sandbox dispatch attempt failed its canonical integrity contract",
    );
  }
}

function requireDesktopSandboxDispatchAttemptTaskBinding(task, attempt) {
  if (task.tenantScope !== attempt.tenantScope || task.taskId !== attempt.taskId ||
    task.inputDigest !== attempt.taskInputDigest) {
    throw executionTaskError(
      "desktop_sandbox_dispatch_attempt_task_binding_mismatch",
      "Desktop Sandbox dispatch attempt does not match the canonical task input authority",
    );
  }
}

function assertSameDesktopSandboxDispatchAttempt(stored, attempt) {
  const immutableFields = [
    "attemptLeaseFenceDigest", "attemptLeaseFencingToken", "attemptId", "contractVersion", "createdAt",
    "deviceSessionDigest", "expiresAt", "operationDigest", "profileDigest", "taskId", "taskInputDigest", "tenantScope",
    "workspaceInputDigest",
  ];
  if (immutableFields.some((field) => stored[field] !== attempt[field])) {
    throw executionTaskError(
      "desktop_sandbox_dispatch_attempt_idempotency_conflict",
      "Desktop Sandbox dispatch attempt identity conflicts with its canonical state",
    );
  }
}

function assertSameProviderAttemptDescriptor(row, descriptor) {
  const fields = {
    contractVersion: row.contract_version,
    tenantScope: row.tenant_scope,
    taskId: row.task_id,
    executionScopeId: row.execution_scope_id,
    purpose: row.purpose,
    providerRequestId: row.provider_request_id,
    requestDigest: row.request_digest,
    providerBindingDigest: row.provider_binding_digest,
    inputDigest: row.input_digest,
    recoveryMode: row.recovery_mode,
  };
  let stored;
  try {
    stored = normalizeProviderAttemptDescriptor(fields);
  } catch {
    throw executionTaskError(
      "provider_attempt_receipt_integrity_invalid",
      "stored provider attempt descriptor is invalid",
    );
  }
  if (!isDeepStrictEqual(stored, descriptor)) {
    throw executionTaskError(
      "provider_attempt_receipt_conflict",
      "canonical task already owns a different Provider attempt descriptor",
    );
  }
}

function requireProviderAttemptTaskBinding(task, descriptor) {
  if (task.tenantScope !== descriptor.tenantScope || task.taskId !== descriptor.taskId ||
    task.inputDigest !== descriptor.inputDigest) {
    throw executionTaskError(
      "provider_attempt_task_binding_mismatch",
      "Provider attempt descriptor does not match the canonical task input authority",
    );
  }
}

function providerAttemptOwnershipDigest(identity) {
  return taskEventKeyDigest([
    "provider-attempt-owner.v1",
    identity.tenantScope,
    identity.taskId,
    identity.leaseId,
    identity.workerIdDigest,
    identity.fencingToken,
  ]);
}

function descriptorFromReceiptRow(row) {
  return Object.freeze({
    toolCallId: row.tool_call_id,
    operationDigest: row.operation_digest,
    effectKind: row.effect_kind,
    adapterId: row.adapter_id,
    actionCode: row.action_code,
    targetScopeDigest: row.target_scope_digest,
    authorizationDigest: row.authorization_digest,
    recoveryMode: row.recovery_mode,
  });
}

function normalizeOperationReceiptDescriptor(value = {}) {
  const normalized = normalizeOperationReceiptRequest({
    contractVersion: "operation-receipt.v1",
    tenantScope: value.tenantScope,
    taskId: value.taskId,
    toolCallId: value.toolCallId,
    operationDigest: value.operationDigest,
    effectKind: value.effectKind,
    adapterId: value.adapterId,
    actionCode: value.actionCode,
    targetScopeDigest: value.targetScopeDigest,
    authorizationDigest: value.authorizationDigest,
    recoveryMode: value.recoveryMode,
  });
  return Object.freeze({
    toolCallId: normalized.toolCallId,
    operationDigest: normalized.operationDigest,
    effectKind: normalized.effectKind,
    adapterId: normalized.adapterId,
    actionCode: normalized.actionCode,
    targetScopeDigest: normalized.targetScopeDigest,
    authorizationDigest: normalized.authorizationDigest,
    recoveryMode: normalized.recoveryMode,
  });
}

function assertSameOperationReceipt(row, descriptor) {
  const existing = descriptorFromReceiptRow(row);
  if (Object.keys(existing).some((key) => existing[key] !== descriptor[key])) {
    throw executionTaskError("operation_receipt_conflict", "toolCallId is already bound to different immutable operation receipt fields");
  }
}

function operationReceiptPayloadDigest(value) {
  return crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function operationReceiptOwnershipDigest(identity) {
  return taskEventKeyDigest([
    "operation-receipt-owner.v1",
    identity.tenantScope,
    identity.taskId,
    identity.leaseId,
    identity.workerIdDigest,
    identity.fencingToken,
  ]);
}

function descriptorAad(identity, descriptor, receiptState = {}) {
  return [
    "operation-receipt.v1",
    identity.tenantScope,
    identity.taskId,
    descriptor.toolCallId,
    descriptor.operationDigest,
    descriptor.effectKind,
    descriptor.adapterId,
    descriptor.actionCode,
    descriptor.targetScopeDigest,
    descriptor.authorizationDigest,
    descriptor.recoveryMode,
    identity.fencingToken,
    receiptState.status,
    receiptState.safeResultCode || "",
    receiptState.payloadDigest,
    receiptState.ownershipDigest,
    receiptState.createdAt,
    receiptState.updatedAt,
    receiptState.finishedAt || "",
  ].join("\0");
}

function ownsLiveLease(task, identity, nowIso) {
  return Boolean(task && task.status === "running" &&
    task.lease?.leaseId === identity.leaseId &&
    task.lease?.workerIdDigest === identity.workerIdDigest &&
    task.fencingToken === identity.fencingToken &&
    task.lease.expiresAt > nowIso);
}

function createReceiptCipher(value) {
  if (value === null || value === undefined) {
    return Object.freeze({
      decrypt: () => { throw executionTaskError("operation_receipt_encryption_unavailable", "operation receipt encryption key is unavailable"); },
      encrypt: () => { throw executionTaskError("operation_receipt_encryption_unavailable", "operation receipt encryption key is unavailable"); },
    });
  }
  const key = Buffer.isBuffer(value) ? Buffer.from(value) : Buffer.from(value);
  if (key.length !== 32) throw new TypeError("receiptEncryptionKey must contain exactly 32 bytes");
  return Object.freeze({
    encrypt(payload, aad) {
      const iv = crypto.randomBytes(12);
      const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
      cipher.setAAD(Buffer.from(aad, "utf8"));
      const ciphertext = Buffer.concat([cipher.update(JSON.stringify(payload), "utf8"), cipher.final()]);
      return [iv, cipher.getAuthTag(), ciphertext].map((part) => part.toString("base64")).join(".");
    },
    decrypt(envelope, aad) {
      try {
        const [iv, tag, ciphertext] = String(envelope || "").split(".").map((part) => Buffer.from(part, "base64"));
        if (iv.length !== 12 || tag.length !== 16 || !ciphertext.length) throw new Error("invalid envelope");
        const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
        decipher.setAAD(Buffer.from(aad, "utf8"));
        decipher.setAuthTag(tag);
        return JSON.parse(Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8"));
      } catch {
        throw executionTaskError("operation_receipt_decryption_failed", "operation receipt could not be decrypted or authenticated");
      }
    },
  });
}

function isSameImmutableSubmission(task, submission) {
  return task.tenantScope === submission.tenantScope &&
    task.actorIssuer === submission.actorIssuer &&
    task.actorSubjectDigest === submission.actorSubjectDigest &&
    task.employeeId === submission.employeeId &&
    task.employeeVersion === submission.employeeVersion &&
    task.sessionId === submission.sessionId &&
    task.sourceSystemId === submission.sourceSystemId &&
    task.channelId === submission.channelId &&
    task.taskType === submission.taskType &&
    task.inputDigest === submission.inputDigest &&
    task.executionInputRef.kind === submission.executionInputRef.kind &&
    task.executionInputRef.refId === submission.executionInputRef.refId &&
    task.priority === submission.priority &&
    task.maxRecoveries === submission.maxRecoveries &&
    task.providerTimeoutPolicy.policyVersion === submission.providerTimeoutPolicy.policyVersion &&
    task.providerTimeoutPolicy.connectMs === submission.providerTimeoutPolicy.connectMs &&
    task.providerTimeoutPolicy.firstSemanticOutputMs === submission.providerTimeoutPolicy.firstSemanticOutputMs &&
    task.providerTimeoutPolicy.streamIdleMs === submission.providerTimeoutPolicy.streamIdleMs &&
    task.providerTimeoutPolicy.requestTotalMs === submission.providerTimeoutPolicy.requestTotalMs &&
    task.providerTimeoutPolicy.taskExecutionTotalMs === submission.providerTimeoutPolicy.taskExecutionTotalMs;
}

function normalizeScheduleCancellationIdentity(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw executionTaskError(
      "execution_task_schedule_cancel_identity_invalid",
      "expectedIdentity must be an exact Schedule task identity",
    );
  }
  const executionInputRef = value.executionInputRef;
  if (!executionInputRef || typeof executionInputRef !== "object" || Array.isArray(executionInputRef)) {
    throw executionTaskError(
      "execution_task_schedule_cancel_identity_invalid",
      "expectedIdentity.executionInputRef must be an object",
    );
  }
  const identity = Object.freeze({
    tenantScope: requiredExecutionTaskToken(value.tenantScope, "expectedIdentity.tenantScope", 160),
    taskId: requiredExecutionTaskToken(value.taskId, "expectedIdentity.taskId", 128),
    employeeId: requiredExecutionTaskToken(value.employeeId, "expectedIdentity.employeeId", 160),
    sourceSystemId: requiredExecutionTaskToken(value.sourceSystemId, "expectedIdentity.sourceSystemId", 120),
    channelId: requiredExecutionTaskToken(value.channelId, "expectedIdentity.channelId", 120),
    taskType: requiredExecutionTaskToken(value.taskType, "expectedIdentity.taskType", 120),
    submissionScope: requiredExecutionTaskToken(value.submissionScope, "expectedIdentity.submissionScope", 240),
    idempotencyKey: requiredExecutionTaskToken(value.idempotencyKey, "expectedIdentity.idempotencyKey", 240),
    executionInputRef: Object.freeze({
      kind: requiredExecutionTaskToken(executionInputRef.kind, "expectedIdentity.executionInputRef.kind", 40),
      refId: requiredExecutionTaskToken(executionInputRef.refId, "expectedIdentity.executionInputRef.refId", 240),
    }),
  });
  if (identity.sourceSystemId !== "digital-workforce-scheduler" || identity.channelId !== "schedule" ||
    identity.taskType !== "scheduled_employee_task" || identity.executionInputRef.kind !== "artifact_ref") {
    throw executionTaskError(
      "execution_task_schedule_cancel_identity_invalid",
      "expectedIdentity must identify a canonical Schedule execution task",
    );
  }
  return identity;
}

function assertTaskMatchesScheduleCancellationIdentity(task, identity) {
  if (task.tenantScope !== identity.tenantScope || task.taskId !== identity.taskId ||
    task.employeeId !== identity.employeeId || task.sourceSystemId !== identity.sourceSystemId ||
    task.channelId !== identity.channelId || task.taskType !== identity.taskType ||
    task.submissionScope !== identity.submissionScope || task.idempotencyKey !== identity.idempotencyKey ||
    task.executionInputRef.kind !== identity.executionInputRef.kind ||
    task.executionInputRef.refId !== identity.executionInputRef.refId) {
    throw executionTaskError(
      "execution_task_schedule_cancel_identity_conflict",
      "existing execution task does not match the exact Schedule cancellation identity",
    );
  }
}

function assertScheduleCancellationFenceMatchesIdentity(fence, identity) {
  if (fence.tenant_scope !== identity.tenantScope || fence.task_id !== identity.taskId ||
    fence.employee_id !== identity.employeeId || fence.source_system_id !== identity.sourceSystemId ||
    fence.channel_id !== identity.channelId || fence.task_type !== identity.taskType ||
    fence.submission_scope !== identity.submissionScope || fence.idempotency_key !== identity.idempotencyKey ||
    fence.execution_input_kind !== identity.executionInputRef.kind ||
    fence.execution_input_ref_id !== identity.executionInputRef.refId) {
    throw executionTaskError(
      "execution_task_schedule_cancel_fence_conflict",
      "existing Schedule cancellation fence does not match expectedIdentity",
    );
  }
}

function assertSubmissionMatchesScheduleCancellationFence(submission, fence) {
  assertScheduleCancellationFenceMatchesIdentity(fence, {
    tenantScope: submission.tenantScope,
    taskId: submission.taskId,
    employeeId: submission.employeeId,
    sourceSystemId: submission.sourceSystemId,
    channelId: submission.channelId,
    taskType: submission.taskType,
    submissionScope: submission.submissionScope,
    idempotencyKey: submission.idempotencyKey,
    executionInputRef: submission.executionInputRef,
  });
}

function normalizeLeaseIdentity({ tenantScope, taskId, leaseId, workerIdDigest, fencingToken }) {
  const safeFencingToken = Number(fencingToken);
  if (!Number.isSafeInteger(safeFencingToken) || safeFencingToken < 1) {
    throw executionTaskError("execution_task_fencing_token_invalid", "fencingToken must be a positive integer");
  }
  return Object.freeze({
    tenantScope: requiredExecutionTaskToken(tenantScope, "tenantScope", 160),
    taskId: requiredExecutionTaskToken(taskId, "taskId", 128),
    leaseId: requiredExecutionTaskToken(leaseId, "leaseId", 128),
    workerIdDigest: requiredExecutionTaskDigest(workerIdDigest, "workerIdDigest"),
    fencingToken: safeFencingToken,
  });
}

function countBy(rows, keyFor) {
  const counts = new Map();
  for (const row of rows) {
    const key = keyFor(row);
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  return counts;
}

function actorKey(row) {
  return `${row.tenant_scope}\0${row.actor_issuer}\0${row.actor_subject_digest}`;
}

function employeeKey(row) {
  return `${row.tenant_scope}\0${row.employee_id}`;
}

function requiredDatabasePath(value) {
  const databasePath = String(value || "").trim();
  if (!databasePath) throw new TypeError("execution task databasePath is required");
  return databasePath === ":memory:" ? databasePath : path.resolve(databasePath);
}

function normalizeImportSummary(value) {
  if (value === undefined || value === null || value === "") return null;
  const summary = String(value).trim();
  if (!summary || summary.length > 500 || /[\r\n\0]/.test(summary)) {
    throw executionTaskError(
      "execution_task_result_summary_invalid",
      "resultSummary must be a single-line audit-safe summary no longer than 500 characters",
    );
  }
  return summary;
}

function runtimeTaskListOrder(value) {
  if (value === "queue") return "enqueue_seq ASC";
  if (value === "recent") return "updated_at DESC, enqueue_seq DESC";
  throw executionTaskError("execution_task_list_order_invalid", "order must be queue or recent");
}

function boundedPositiveInteger(value, fieldName, min, max) {
  const normalized = Number(value);
  if (!Number.isSafeInteger(normalized) || normalized < min || normalized > max) {
    throw executionTaskError(
      "execution_task_integer_invalid",
      `${fieldName} must be an integer between ${min} and ${max}`,
    );
  }
  return normalized;
}

function boundedNonNegativeInteger(value, fieldName, max) {
  const normalized = Number(value);
  if (!Number.isSafeInteger(normalized) || normalized < 0 || normalized > max) {
    throw executionTaskError(
      "execution_task_integer_invalid",
      `${fieldName} must be an integer between 0 and ${max}`,
    );
  }
  return normalized;
}

function boundedArtifactCleanupLimit(value) {
  return boundedPositiveInteger(value, "artifact cleanup limit", 1, 500);
}

function requiredPositiveArtifactSize(value) {
  const normalized = Number(value);
  if (!Number.isSafeInteger(normalized) || normalized <= 0) {
    throw executionTaskError("artifact_object_size_invalid", "artifact object size must be a positive integer");
  }
  return normalized;
}

function requiredNonNegativeInteger(value, fieldName) {
  const normalized = Number(value);
  if (!Number.isSafeInteger(normalized) || normalized < 0) {
    throw executionTaskError("artifact_cleanup_integer_invalid", `${fieldName} must be a non-negative integer`);
  }
  return normalized;
}

function requiredPositiveInteger(value, fieldName) {
  const normalized = requiredNonNegativeInteger(value, fieldName);
  if (normalized === 0) {
    throw executionTaskError("artifact_cleanup_integer_invalid", `${fieldName} must be a positive integer`);
  }
  return normalized;
}

function artifactCleanupResultCode(value) {
  const normalized = String(value || "").trim();
  if (!ARTIFACT_CLEANUP_RESULT_CODES.has(normalized)) {
    throw executionTaskError("artifact_cleanup_result_code_invalid", "artifact cleanup result code is invalid");
  }
  return normalized;
}

function taskEventKeyDigest(parts) {
  return crypto.createHash("sha256").update(parts.map((part) => String(part)).join("\0")).digest("hex");
}

function taskEventOwnershipDigest(identity) {
  return taskEventKeyDigest([
    "task-event-owner.v1",
    identity.tenantScope,
    identity.taskId,
    identity.leaseId,
    identity.workerIdDigest,
    identity.fencingToken,
  ]);
}

function rollbackIfActive(database) {
  try {
    database.exec("ROLLBACK");
  } catch {
    // The transaction may already have been rolled back by SQLite.
  }
}

function migrateExecutionTaskSchemaV23ToV24(database) {
  database.exec("BEGIN IMMEDIATE");
  try {
    ensurePersonalAutomationSchema(database);
    validatePersonalAutomationSchema(database);
    const result = database.prepare("UPDATE execution_task_schema SET version=24 WHERE singleton=1 AND version=23").run();
    if (result.changes !== 1) throw executionTaskError("execution_task_schema_migration_conflict", "personal automation migration conflict");
    database.exec("COMMIT");
  } catch (error) { rollbackIfActive(database); database.close(); throw error; }
}

function migrateExecutionTaskSchemaV24ToV25(database) {
  database.exec("BEGIN IMMEDIATE");
  try {
    createGroupHistorySchemaV25(database);
    validateGroupHistorySchemaV25(database);
    const result = database.prepare("UPDATE execution_task_schema SET version=25 WHERE singleton=1 AND version=24").run();
    if (result.changes !== 1) throw executionTaskError("execution_task_schema_migration_conflict", "group history migration conflict");
    database.exec("COMMIT");
  } catch (error) { rollbackIfActive(database); database.close(); throw error; }
}
