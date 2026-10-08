import crypto from "node:crypto";

const OPS_INCIDENT_DIAGNOSIS_CONTRACT_VERSION = "ops-incident-diagnosis.v1";
const TERMINAL_STATUSES = new Set(["failed", "lost", "timed_out", "blocked", "rejected"]);
const DIAGNOSIS_STATES = new Set(["completed", "evidence_insufficient"]);
const DIAGNOSIS_KINDS = new Set(["automatic_initial", "operator"]);
const ROOT_CAUSES = new Set([
  "runtime_delivery_failure",
  "provider_or_model",
  "tool_or_target",
  "governance_or_authorization",
  "input_or_contract",
  "evidence_insufficient",
  "other",
]);

export function createOpsIncidentDiagnosisSchemaV17(database) {
  database.exec(`
    CREATE TABLE IF NOT EXISTS execution_ops_incident_sources (
      tenant_scope TEXT NOT NULL,
      incident_id TEXT NOT NULL,
      source_task_id TEXT NOT NULL,
      source_identity_digest TEXT NOT NULL CHECK (length(source_identity_digest) = 64),
      source_status TEXT NOT NULL CHECK (source_status IN ('failed', 'lost', 'timed_out', 'blocked', 'rejected')),
      classification TEXT NOT NULL CHECK (classification IN ('execution_failure', 'governance_signal')),
      employee_id TEXT NOT NULL,
      employee_version TEXT NOT NULL,
      source_finished_at TEXT NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY (tenant_scope, incident_id),
      UNIQUE (tenant_scope, source_task_id, source_identity_digest, classification),
      FOREIGN KEY (source_task_id) REFERENCES execution_tasks(task_id) ON DELETE RESTRICT
    );
    CREATE INDEX IF NOT EXISTS execution_ops_incident_sources_window_idx
      ON execution_ops_incident_sources (tenant_scope, source_finished_at DESC, incident_id);
    CREATE TABLE IF NOT EXISTS execution_ops_incident_heads (
      tenant_scope TEXT NOT NULL,
      incident_id TEXT NOT NULL,
      latest_version_no INTEGER NOT NULL CHECK (latest_version_no >= 0),
      revision INTEGER NOT NULL CHECK (revision >= 0),
      updated_at TEXT NOT NULL,
      PRIMARY KEY (tenant_scope, incident_id),
      FOREIGN KEY (tenant_scope, incident_id)
        REFERENCES execution_ops_incident_sources (tenant_scope, incident_id) ON DELETE CASCADE
    );
    CREATE TABLE IF NOT EXISTS execution_ops_incident_diagnosis_versions (
      tenant_scope TEXT NOT NULL,
      incident_id TEXT NOT NULL,
      version_no INTEGER NOT NULL CHECK (version_no > 0),
      diagnosis_id TEXT NOT NULL,
      contract_version TEXT NOT NULL CHECK (contract_version = '${OPS_INCIDENT_DIAGNOSIS_CONTRACT_VERSION}'),
      diagnosis_kind TEXT NOT NULL CHECK (diagnosis_kind IN ('automatic_initial', 'operator')),
      diagnosis_state TEXT NOT NULL CHECK (diagnosis_state IN ('completed', 'evidence_insufficient')),
      root_cause_category TEXT NOT NULL,
      stable_error_code TEXT NOT NULL,
      evidence_state TEXT NOT NULL CHECK (evidence_state IN ('available', 'missing')),
      diagnosis_summary TEXT NOT NULL,
      impact_summary TEXT NOT NULL,
      repair_draft_summary TEXT NOT NULL,
      actor_digest TEXT NOT NULL,
      idempotency_key TEXT NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY (tenant_scope, incident_id, version_no),
      UNIQUE (tenant_scope, diagnosis_id),
      UNIQUE (tenant_scope, incident_id, idempotency_key),
      FOREIGN KEY (tenant_scope, incident_id)
        REFERENCES execution_ops_incident_sources (tenant_scope, incident_id) ON DELETE RESTRICT
    );
    CREATE INDEX IF NOT EXISTS execution_ops_incident_diagnosis_latest_idx
      ON execution_ops_incident_diagnosis_versions (tenant_scope, incident_id, version_no DESC);
  `);
}

export function createOpsIncidentDiagnosisSchemaV18(database) {
  createOpsIncidentDiagnosisSchemaV17(database);
  const columns = new Set(database.prepare("PRAGMA table_info(execution_ops_incident_diagnosis_versions)").all()
    .map((column) => column.name));
  if (!columns.has("diagnosis_method")) {
    database.exec(`
      ALTER TABLE execution_ops_incident_diagnosis_versions
        ADD COLUMN diagnosis_method TEXT NOT NULL DEFAULT 'terminal_projection'
        CHECK (diagnosis_method IN ('terminal_projection', 'runtime_evidence', 'operator'));
    `);
  }
  if (!columns.has("diagnosis_confidence")) {
    database.exec(`
      ALTER TABLE execution_ops_incident_diagnosis_versions
        ADD COLUMN diagnosis_confidence TEXT NOT NULL DEFAULT 'insufficient'
        CHECK (diagnosis_confidence IN ('confirmed', 'probable', 'insufficient'));
    `);
  }
}

export function createOpsIncidentDiagnosisSchemaV19(database) {
  createOpsIncidentDiagnosisSchemaV18(database);
  database.exec(`
    CREATE TABLE IF NOT EXISTS execution_ops_incident_diagnosis_requests (
      tenant_scope TEXT NOT NULL,
      request_id TEXT NOT NULL,
      incident_id TEXT NOT NULL,
      requested_revision INTEGER NOT NULL CHECK (requested_revision >= 0),
      canonical_task_id TEXT NOT NULL,
      employee_version TEXT NOT NULL,
      requested_by_digest TEXT NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY (tenant_scope, request_id),
      UNIQUE (tenant_scope, canonical_task_id),
      UNIQUE (tenant_scope, incident_id, requested_revision, requested_by_digest),
      FOREIGN KEY (tenant_scope, incident_id)
        REFERENCES execution_ops_incident_sources (tenant_scope, incident_id) ON DELETE RESTRICT,
      FOREIGN KEY (canonical_task_id) REFERENCES execution_tasks(task_id) ON DELETE RESTRICT
    );
    CREATE INDEX IF NOT EXISTS execution_ops_incident_diagnosis_requests_incident_idx
      ON execution_ops_incident_diagnosis_requests (tenant_scope, incident_id, created_at DESC);
    CREATE TABLE IF NOT EXISTS execution_ops_repair_plans (
      tenant_scope TEXT NOT NULL,
      plan_id TEXT NOT NULL,
      incident_id TEXT NOT NULL,
      diagnosis_version_no INTEGER NOT NULL CHECK (diagnosis_version_no > 0),
      plan_digest TEXT NOT NULL CHECK (length(plan_digest) = 64),
      lifecycle_state TEXT NOT NULL CHECK (lifecycle_state IN ('draft', 'blocked', 'approval_required', 'auto_dispatchable')),
      risk_tier TEXT NOT NULL CHECK (risk_tier IN ('read_only', 'controlled_write', 'high_impact', 'unconfigured')),
      decision_code TEXT NOT NULL,
      scope_summary TEXT NOT NULL,
      precheck_summary TEXT NOT NULL,
      rollback_or_reconcile_summary TEXT NOT NULL,
      verification_summary TEXT NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY (tenant_scope, plan_id),
      UNIQUE (tenant_scope, incident_id, diagnosis_version_no, plan_digest),
      FOREIGN KEY (tenant_scope, incident_id)
        REFERENCES execution_ops_incident_sources (tenant_scope, incident_id) ON DELETE RESTRICT
    );
    CREATE INDEX IF NOT EXISTS execution_ops_repair_plans_incident_idx
      ON execution_ops_repair_plans (tenant_scope, incident_id, created_at DESC);
  `);
}

export function validateOpsIncidentDiagnosisSchemaV17(database) {
  const names = new Set(database.prepare(`
    SELECT name FROM sqlite_master WHERE type = 'table'
      AND name IN ('execution_ops_incident_sources', 'execution_ops_incident_heads', 'execution_ops_incident_diagnosis_versions')
  `).all().map((row) => row.name));
  if (names.size !== 3) throw opsIncidentDiagnosisError("ops_incident_schema_invalid");
}

export function validateOpsIncidentDiagnosisSchemaV18(database) {
  validateOpsIncidentDiagnosisSchemaV17(database);
  const columns = new Set(database.prepare("PRAGMA table_info(execution_ops_incident_diagnosis_versions)").all()
    .map((column) => column.name));
  if (!columns.has("diagnosis_method") || !columns.has("diagnosis_confidence")) {
    throw opsIncidentDiagnosisError("ops_incident_schema_invalid");
  }
}

export function validateOpsIncidentDiagnosisSchemaV19(database) {
  validateOpsIncidentDiagnosisSchemaV18(database);
  const names = new Set(database.prepare(`
    SELECT name FROM sqlite_master WHERE type = 'table'
      AND name IN ('execution_ops_incident_diagnosis_requests', 'execution_ops_repair_plans')
  `).all().map((row) => row.name));
  if (names.size !== 2) throw opsIncidentDiagnosisError("ops_incident_schema_invalid");
}

export function createOpsIncidentDiagnosisStore({ database, executionTaskError }) {
  const error = typeof executionTaskError === "function" ? executionTaskError : opsIncidentDiagnosisError;

  function summarizeRuntimeTasks({ tenantScope, since, until }) {
    return database.prepare(`
      SELECT employee_id, COALESCE(employee_version, '') AS employee_version, status,
        COUNT(*) AS task_count, MAX(updated_at) AS latest_task_at
      FROM execution_tasks
      WHERE tenant_scope = ? AND updated_at >= ? AND updated_at <= ?
      GROUP BY employee_id, COALESCE(employee_version, ''), status
      ORDER BY employee_id ASC, employee_version ASC, status ASC
    `).all(tenantScope, since, until).map((row) => ({
      employeeId: row.employee_id,
      employeeVersion: row.employee_version || "unknown",
      status: row.status,
      taskCount: Number(row.task_count || 0),
      latestTaskAt: row.latest_task_at,
    }));
  }

  function summarizeRuntimeTaskPerformance({ tenantScope, since, until, asOf, employeeId = "" }) {
    const rows = database.prepare(`
      SELECT employee_id, COALESCE(employee_version, '') AS employee_version, status,
        created_at, queued_at, started_at, finished_at
      FROM execution_tasks
      WHERE tenant_scope = ?
        AND (
          (status IN ('completed', 'failed', 'lost', 'timed_out', 'blocked', 'rejected', 'canceled')
            AND (
              (finished_at >= ? AND finished_at <= ?)
              OR (updated_at >= ? AND updated_at <= ?)
            ))
          OR status IN ('queued', 'running', 'waiting')
        )
        AND (? = '' OR employee_id = ?)
      ORDER BY employee_id ASC, employee_version ASC, created_at ASC, task_id ASC
    `).all(tenantScope, since, until, since, until, employeeId, employeeId);

    const groups = new Map();
    for (const row of rows) {
      const key = `${row.employee_id}\0${row.employee_version || "unknown"}`;
      const group = groups.get(key) || createTaskPerformanceGroup({
        employeeId: row.employee_id,
        employeeVersion: row.employee_version || "unknown",
      });
      if (TERMINAL_TASK_STATUSES.has(row.status) && terminalPerformanceWindowMatch(row, since, until)) {
        group.terminalTaskCount += 1;
        addTaskPerformanceSample(group, row);
      } else if (ACTIVE_TASK_STATUSES.has(row.status)) {
        group.activeTaskCount += 1;
        const ageMs = activeTaskAgeMs(row, asOf);
        if (Number.isFinite(ageMs)) group.activeAgesMs.push(ageMs);
        else group.activeInvalidCount += 1;
      }
      groups.set(key, group);
    }

    return [...groups.values()]
      .map(finalizeTaskPerformanceGroup)
      .sort((left, right) => left.employeeId.localeCompare(right.employeeId) ||
        left.employeeVersion.localeCompare(right.employeeVersion));
  }

  function listTerminalCandidates({ tenantScope, since, until, limit = 500 }) {
    return database.prepare(`
      SELECT task.task_id, task.employee_id, COALESCE(task.employee_version, '') AS employee_version,
        task.status, task.finished_at, task.updated_at, task.last_error_code, task.result_summary, task.terminal_evidence_digest,
        task.attempt_count, task.recovery_count,
        evidence.provider_diagnostic_json, evidence.blocked_reason, evidence.request_count, evidence.tool_call_count,
        (SELECT group_concat(activity.status, ',') FROM execution_task_runtime_activities activity
          WHERE activity.tenant_scope = task.tenant_scope AND activity.task_id = task.task_id) AS activity_statuses,
        EXISTS(SELECT 1 FROM execution_task_runtime_evidence runtime_evidence
          WHERE runtime_evidence.tenant_scope = task.tenant_scope AND runtime_evidence.task_id = task.task_id) AS has_runtime_evidence
      FROM execution_tasks task
      LEFT JOIN execution_task_runtime_evidence evidence
        ON evidence.tenant_scope = task.tenant_scope AND evidence.task_id = task.task_id
      WHERE task.tenant_scope = ? AND task.status IN ('failed', 'lost', 'timed_out', 'blocked', 'rejected')
        AND COALESCE(task.finished_at, task.updated_at) >= ? AND COALESCE(task.finished_at, task.updated_at) <= ?
      ORDER BY COALESCE(task.finished_at, task.updated_at) DESC, task.task_id ASC
      LIMIT ?
    `).all(tenantScope, since, until, limit).map((row) => ({
      taskId: row.task_id,
      employeeId: row.employee_id,
      employeeVersion: row.employee_version || "unknown",
      status: row.status,
      occurredAt: row.finished_at || row.updated_at,
      lastErrorCode: row.last_error_code || "runtime_failure_unclassified",
      resultSummary: row.result_summary || "",
      terminalEvidenceDigest: row.terminal_evidence_digest || "",
      runtimeEvidenceAvailable: Boolean(row.has_runtime_evidence),
      attemptCount: Number(row.attempt_count || 0),
      recoveryCount: Number(row.recovery_count || 0),
      blockedReason: safeToken(row.blocked_reason),
      providerDiagnostic: safeProviderDiagnostic(row.provider_diagnostic_json),
      requestCount: Number(row.request_count || 0),
      toolCallCount: Number(row.tool_call_count || 0),
      activityStatuses: safeActivityStatuses(row.activity_statuses),
    }));
  }

  function backfillInitialDiagnoses({ actorDigest, candidates = [], now, tenantScope }) {
    const created = [];
    database.exec("BEGIN IMMEDIATE");
    try {
      for (const candidate of candidates) {
        const source = upsertSource(candidate, { now, tenantScope });
        const existing = database.prepare(`
          SELECT 1 FROM execution_ops_incident_diagnosis_versions
          WHERE tenant_scope = ? AND incident_id = ? AND idempotency_key = ?
        `).get(tenantScope, source.incidentId, "automatic_initial.v1");
        if (existing) continue;
        const diagnosis = terminalProjectionDiagnosis(candidate);
        const version = insertDiagnosis({
          actorDigest,
          diagnosis,
          idempotencyKey: "automatic_initial.v1",
          incidentId: source.incidentId,
          now,
          tenantScope,
        });
        created.push({ incidentId: source.incidentId, ...version });
      }
      database.exec("COMMIT");
      return created;
    } catch (cause) {
      rollback(database);
      throw cause;
    }
  }

  function diagnoseWithRuntimeEvidence({ actorDigest, candidates = [], now, tenantScope }) {
    const created = [];
    database.exec("BEGIN IMMEDIATE");
    try {
      for (const candidate of candidates) {
        const source = upsertSource(candidate, { now, tenantScope });
        const existing = database.prepare(`
          SELECT 1 FROM execution_ops_incident_diagnosis_versions
          WHERE tenant_scope = ? AND incident_id = ? AND idempotency_key = ?
        `).get(tenantScope, source.incidentId, "automatic_runtime_evidence.v1");
        if (existing) continue;
        const version = insertDiagnosis({
          actorDigest,
          diagnosis: runtimeEvidenceDiagnosis(candidate),
          idempotencyKey: "automatic_runtime_evidence.v1",
          incidentId: source.incidentId,
          now,
          tenantScope,
        });
        created.push({ incidentId: source.incidentId, ...version });
      }
      database.exec("COMMIT");
      return created;
    } catch (cause) {
      rollback(database);
      throw cause;
    }
  }

  function appendOperatorDiagnosis({ actorDigest, expectedRevision, incidentId, input, now, tenantScope }) {
    database.exec("BEGIN IMMEDIATE");
    try {
      const head = database.prepare(`
        SELECT revision FROM execution_ops_incident_heads WHERE tenant_scope = ? AND incident_id = ?
      `).get(tenantScope, incidentId);
      if (!head) throw error("ops_incident_not_found", "ops incident was not found");
      if (Number(head.revision) !== Number(expectedRevision)) {
        throw error("ops_incident_revision_conflict", "ops incident diagnosis changed; refresh before retry");
      }
      const version = insertDiagnosis({ actorDigest, diagnosis: input, idempotencyKey: input.idempotencyKey, incidentId, now, tenantScope });
      database.exec("COMMIT");
      return version;
    } catch (cause) {
      rollback(database);
      throw cause;
    }
  }

  function createDiagnosisRequest({ actorDigest, canonicalTaskId, employeeVersion, expectedRevision, incidentId, now, requestId, tenantScope }) {
    database.exec("BEGIN IMMEDIATE");
    try {
      const head = database.prepare(`
        SELECT revision FROM execution_ops_incident_heads WHERE tenant_scope = ? AND incident_id = ?
      `).get(tenantScope, incidentId);
      if (!head) throw error("ops_incident_not_found", "ops incident was not found");
      if (Number(head.revision) !== Number(expectedRevision)) {
        throw error("ops_incident_revision_conflict", "ops incident diagnosis changed; refresh before retry");
      }
      const task = database.prepare(`
        SELECT task_id, employee_id, employee_version, channel_id, task_type, tenant_scope
        FROM execution_tasks WHERE tenant_scope = ? AND task_id = ?
      `).get(tenantScope, canonicalTaskId);
      if (!task || task.employee_id !== "workforce-admin" || task.employee_version !== employeeVersion ||
        task.channel_id !== "ops_monitor" || task.task_type !== "ops_incident_diagnosis") {
        throw error("ops_diagnosis_task_binding_invalid", "ops diagnosis task did not match the governed binding");
      }
      const existing = database.prepare(`
        SELECT request_id, canonical_task_id, requested_revision FROM execution_ops_incident_diagnosis_requests
        WHERE tenant_scope = ? AND incident_id = ? AND requested_revision = ? AND requested_by_digest = ?
      `).get(tenantScope, incidentId, head.revision, actorDigest);
      if (existing) {
        database.exec("COMMIT");
        return { requestId: existing.request_id, taskId: existing.canonical_task_id, created: false, requestedRevision: Number(existing.requested_revision) };
      }
      database.prepare(`
        INSERT INTO execution_ops_incident_diagnosis_requests (
          tenant_scope, request_id, incident_id, requested_revision, canonical_task_id,
          employee_version, requested_by_digest, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(tenantScope, requestId, incidentId, head.revision, canonicalTaskId, employeeVersion, actorDigest, now);
      database.exec("COMMIT");
      return { requestId, taskId: canonicalTaskId, created: true, requestedRevision: Number(head.revision) };
    } catch (cause) {
      rollback(database);
      throw cause;
    }
  }

  function getDiagnosisRequest({ taskId, tenantScope }) {
    return database.prepare(`
      SELECT request_id, incident_id, requested_revision, canonical_task_id, employee_version, requested_by_digest, created_at
      FROM execution_ops_incident_diagnosis_requests
      WHERE tenant_scope = ? AND canonical_task_id = ?
    `).get(tenantScope, taskId) || null;
  }

  function getIncidentHead({ incidentId, tenantScope }) {
    const row = database.prepare(`
      SELECT revision FROM execution_ops_incident_heads WHERE tenant_scope = ? AND incident_id = ?
    `).get(tenantScope, incidentId);
    return row ? { revision: Number(row.revision) } : null;
  }

  function completeDiagnosisRequest({ actorDigest, now, taskId, tenantScope }) {
    database.exec("BEGIN IMMEDIATE");
    try {
      const request = getDiagnosisRequest({ taskId, tenantScope });
      if (!request) throw error("ops_diagnosis_request_not_found", "ops diagnosis request was not found");
      const head = getIncidentHead({ incidentId: request.incident_id, tenantScope });
      if (!head || head.revision !== Number(request.requested_revision)) {
        throw error("ops_incident_revision_conflict", "ops incident diagnosis changed; refresh before retry");
      }
      const candidate = candidateForIncident({ incidentId: request.incident_id, tenantScope });
      if (!candidate) throw error("ops_incident_source_unavailable", "ops incident source is unavailable");
      const version = insertDiagnosis({
        actorDigest,
        diagnosis: runtimeEvidenceDiagnosis(candidate),
        idempotencyKey: `runtime_agent:${request.request_id}`,
        incidentId: request.incident_id,
        now,
        tenantScope,
      });
      const repairPlan = createRepairPlan({ incidentId: request.incident_id, now, tenantScope, versionNo: version.versionNo });
      database.exec("COMMIT");
      return { incidentId: request.incident_id, repairPlan, requestId: request.request_id, ...version };
    } catch (cause) {
      rollback(database);
      throw cause;
    }
  }

  function listArchive({ tenantScope, limit = 200 }) {
    return database.prepare(`
      SELECT source.incident_id, source.employee_id, source.employee_version, source.source_status,
        source.classification, source.source_finished_at, head.revision,
        version.version_no, version.diagnosis_kind, version.diagnosis_method, version.diagnosis_confidence,
        version.diagnosis_state, version.root_cause_category,
        version.stable_error_code, version.evidence_state, version.diagnosis_summary,
        version.impact_summary, version.repair_draft_summary, version.created_at,
        (SELECT lifecycle_state FROM execution_ops_repair_plans plan
          WHERE plan.tenant_scope = source.tenant_scope AND plan.incident_id = source.incident_id
          ORDER BY plan.created_at DESC LIMIT 1) AS repair_plan_state,
        (SELECT risk_tier FROM execution_ops_repair_plans plan
          WHERE plan.tenant_scope = source.tenant_scope AND plan.incident_id = source.incident_id
          ORDER BY plan.created_at DESC LIMIT 1) AS repair_plan_risk,
        (SELECT decision_code FROM execution_ops_repair_plans plan
          WHERE plan.tenant_scope = source.tenant_scope AND plan.incident_id = source.incident_id
          ORDER BY plan.created_at DESC LIMIT 1) AS repair_plan_decision
      FROM execution_ops_incident_heads head
      JOIN execution_ops_incident_sources source
        ON source.tenant_scope = head.tenant_scope AND source.incident_id = head.incident_id
      JOIN execution_ops_incident_diagnosis_versions version
        ON version.tenant_scope = head.tenant_scope AND version.incident_id = head.incident_id
          AND version.version_no = head.latest_version_no
      WHERE head.tenant_scope = ?
      ORDER BY version.created_at DESC, source.incident_id ASC
      LIMIT ?
    `).all(tenantScope, limit).map((row) => ({
      incidentId: row.incident_id,
      employeeId: row.employee_id,
      employeeVersion: row.employee_version,
      sourceStatus: row.source_status,
      classification: row.classification,
      occurredAt: row.source_finished_at,
      revision: Number(row.revision),
      diagnosisVersion: Number(row.version_no),
      diagnosisKind: row.diagnosis_kind,
      diagnosisMethod: row.diagnosis_method,
      diagnosisConfidence: row.diagnosis_confidence,
      diagnosisState: row.diagnosis_state,
      rootCauseCategory: row.root_cause_category,
      errorCode: row.stable_error_code,
      evidenceState: row.evidence_state,
      diagnosisSummary: row.diagnosis_summary,
      impactSummary: row.impact_summary,
      repairDraftSummary: row.repair_draft_summary,
      repairPlan: row.repair_plan_state ? {
        lifecycleState: row.repair_plan_state,
        riskTier: row.repair_plan_risk,
        decisionCode: row.repair_plan_decision,
      } : null,
      diagnosedAt: row.created_at,
    }));
  }

  function candidateForIncident({ incidentId, tenantScope }) {
    const row = database.prepare(`
      SELECT task.task_id, task.employee_id, COALESCE(task.employee_version, '') AS employee_version,
        task.status, task.finished_at, task.updated_at, task.last_error_code, task.result_summary, task.terminal_evidence_digest,
        task.attempt_count, task.recovery_count, evidence.provider_diagnostic_json, evidence.blocked_reason,
        evidence.request_count, evidence.tool_call_count,
        (SELECT group_concat(activity.status, ',') FROM execution_task_runtime_activities activity
          WHERE activity.tenant_scope = task.tenant_scope AND activity.task_id = task.task_id) AS activity_statuses,
        EXISTS(SELECT 1 FROM execution_task_runtime_evidence runtime_evidence
          WHERE runtime_evidence.tenant_scope = task.tenant_scope AND runtime_evidence.task_id = task.task_id) AS has_runtime_evidence
      FROM execution_ops_incident_sources source
      JOIN execution_tasks task ON task.task_id = source.source_task_id AND task.tenant_scope = source.tenant_scope
      LEFT JOIN execution_task_runtime_evidence evidence
        ON evidence.tenant_scope = task.tenant_scope AND evidence.task_id = task.task_id
      WHERE source.tenant_scope = ? AND source.incident_id = ?
    `).get(tenantScope, incidentId);
    return row ? candidateFromRow(row) : null;
  }

  function createRepairPlan({ incidentId, now, tenantScope, versionNo }) {
    const diagnosis = database.prepare(`
      SELECT root_cause_category, diagnosis_state, stable_error_code
      FROM execution_ops_incident_diagnosis_versions
      WHERE tenant_scope = ? AND incident_id = ? AND version_no = ?
    `).get(tenantScope, incidentId, versionNo);
    if (!diagnosis) throw error("ops_incident_diagnosis_not_found", "ops incident diagnosis was not found");
    const plan = repairPlanForDiagnosis(diagnosis);
    const planDigest = crypto.createHash("sha256").update(JSON.stringify([incidentId, versionNo, plan]), "utf8").digest("hex");
    const existing = database.prepare(`
      SELECT plan_id, lifecycle_state, risk_tier, decision_code FROM execution_ops_repair_plans
      WHERE tenant_scope = ? AND incident_id = ? AND diagnosis_version_no = ? AND plan_digest = ?
    `).get(tenantScope, incidentId, versionNo, planDigest);
    if (existing) return { planId: existing.plan_id, lifecycleState: existing.lifecycle_state, riskTier: existing.risk_tier, decisionCode: existing.decision_code, created: false };
    const planId = `ORP-${crypto.randomBytes(12).toString("hex")}`;
    database.prepare(`
      INSERT INTO execution_ops_repair_plans (
        tenant_scope, plan_id, incident_id, diagnosis_version_no, plan_digest, lifecycle_state, risk_tier,
        decision_code, scope_summary, precheck_summary, rollback_or_reconcile_summary, verification_summary, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(tenantScope, planId, incidentId, versionNo, planDigest, plan.lifecycleState, plan.riskTier,
      plan.decisionCode, plan.scopeSummary, plan.precheckSummary, plan.rollbackOrReconcileSummary, plan.verificationSummary, now);
    return { planId, lifecycleState: plan.lifecycleState, riskTier: plan.riskTier, decisionCode: plan.decisionCode, created: true };
  }

  function upsertSource(candidate, { now, tenantScope }) {
    const canonical = database.prepare(`
      SELECT employee_id, COALESCE(employee_version, '') AS employee_version, status,
        COALESCE(finished_at, updated_at) AS occurred_at, terminal_evidence_digest
      FROM execution_tasks
      WHERE tenant_scope = ? AND task_id = ?
    `).get(tenantScope, candidate.taskId);
    if (!canonical || !TERMINAL_STATUSES.has(canonical.status) || canonical.status !== candidate.status ||
      canonical.employee_id !== candidate.employeeId || (canonical.employee_version || "unknown") !== candidate.employeeVersion ||
      canonical.occurred_at !== candidate.occurredAt || (canonical.terminal_evidence_digest || "") !== (candidate.terminalEvidenceDigest || "")) {
      throw error("ops_incident_source_mismatch", "canonical task source did not match the terminal candidate");
    }
    const classification = candidate.status === "blocked" || candidate.status === "rejected" ? "governance_signal" : "execution_failure";
    const identity = crypto.createHash("sha256").update([
      candidate.taskId, candidate.status, candidate.occurredAt, candidate.terminalEvidenceDigest || "missing",
    ].join("\0"), "utf8").digest("hex");
    const existing = database.prepare(`
      SELECT incident_id FROM execution_ops_incident_sources
      WHERE tenant_scope = ? AND source_task_id = ? AND source_identity_digest = ? AND classification = ?
    `).get(tenantScope, candidate.taskId, identity, classification);
    if (existing) return { incidentId: existing.incident_id };
    const incidentId = `OPS-${crypto.randomBytes(12).toString("hex")}`;
    database.prepare(`
      INSERT INTO execution_ops_incident_sources (
        tenant_scope, incident_id, source_task_id, source_identity_digest, source_status,
        classification, employee_id, employee_version, source_finished_at, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(tenantScope, incidentId, candidate.taskId, identity, candidate.status, classification,
      candidate.employeeId, candidate.employeeVersion, candidate.occurredAt, now);
    database.prepare(`
      INSERT INTO execution_ops_incident_heads (tenant_scope, incident_id, latest_version_no, revision, updated_at)
      VALUES (?, ?, 0, 0, ?)
    `).run(tenantScope, incidentId, now);
    return { incidentId };
  }

  function insertDiagnosis({ actorDigest, diagnosis, idempotencyKey, incidentId, now, tenantScope }) {
    const previous = database.prepare(`
      SELECT latest_version_no, revision FROM execution_ops_incident_heads WHERE tenant_scope = ? AND incident_id = ?
    `).get(tenantScope, incidentId);
    if (!previous) throw error("ops_incident_not_found", "ops incident was not found");
    const existing = database.prepare(`
      SELECT version_no, diagnosis_id FROM execution_ops_incident_diagnosis_versions
      WHERE tenant_scope = ? AND incident_id = ? AND idempotency_key = ?
    `).get(tenantScope, incidentId, idempotencyKey);
    if (existing) return { diagnosisId: existing.diagnosis_id, revision: Number(previous.revision), versionNo: Number(existing.version_no) };
    const versionNo = Number(previous.latest_version_no) + 1;
    const diagnosisId = `ODI-${crypto.randomBytes(12).toString("hex")}`;
    database.prepare(`
      INSERT INTO execution_ops_incident_diagnosis_versions (
        tenant_scope, incident_id, version_no, diagnosis_id, contract_version, diagnosis_kind,
        diagnosis_state, root_cause_category, stable_error_code, evidence_state, diagnosis_method, diagnosis_confidence, diagnosis_summary,
        impact_summary, repair_draft_summary, actor_digest, idempotency_key, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(tenantScope, incidentId, versionNo, diagnosisId, OPS_INCIDENT_DIAGNOSIS_CONTRACT_VERSION,
      diagnosis.diagnosisKind, diagnosis.diagnosisState, diagnosis.rootCauseCategory,
      diagnosis.errorCode, diagnosis.evidenceState, diagnosis.diagnosisMethod || "operator", diagnosis.diagnosisConfidence || "probable", diagnosis.diagnosisSummary,
      diagnosis.impactSummary, diagnosis.repairDraftSummary, actorDigest, idempotencyKey, now);
    const nextRevision = Number(previous.revision) + 1;
    const updated = database.prepare(`
      UPDATE execution_ops_incident_heads
      SET latest_version_no = ?, revision = ?, updated_at = ?
      WHERE tenant_scope = ? AND incident_id = ? AND revision = ?
    `).run(versionNo, nextRevision, now, tenantScope, incidentId, previous.revision);
    if (updated.changes !== 1) throw error("ops_incident_revision_conflict", "ops incident head changed");
    return { diagnosisId, revision: nextRevision, versionNo };
  }

  return Object.freeze({ appendOperatorDiagnosis, backfillInitialDiagnoses, candidateForIncident, completeDiagnosisRequest, createDiagnosisRequest, diagnoseWithRuntimeEvidence, getDiagnosisRequest, getIncidentHead, listArchive, listTerminalCandidates, summarizeRuntimeTaskPerformance, summarizeRuntimeTasks });
}

const TERMINAL_TASK_STATUSES = new Set(["completed", "failed", "lost", "timed_out", "blocked", "rejected", "canceled"]);
const ACTIVE_TASK_STATUSES = new Set(["queued", "running", "waiting"]);
const PERFORMANCE_OUTCOMES = Object.freeze([
  { key: "success", label: "成功", statuses: new Set(["completed"]) },
  { key: "executionFailure", label: "执行失败", statuses: new Set(["failed", "lost", "timed_out"]) },
  { key: "governance", label: "治理/未接收", statuses: new Set(["blocked", "rejected", "canceled"]) },
]);

function createTaskPerformanceGroup({ employeeId, employeeVersion }) {
  return {
    employeeId,
    employeeVersion,
    terminalTaskCount: 0,
    activeTaskCount: 0,
    activeAgesMs: [],
    activeInvalidCount: 0,
    outcomes: new Map(PERFORMANCE_OUTCOMES.map((outcome) => [outcome.key, {
      key: outcome.key,
      label: outcome.label,
      taskCount: 0,
      metrics: {
        total: createDurationMetric(),
        startupWait: createDurationMetric(),
        executionPhase: createDurationMetric(),
      },
    }])),
  };
}

function addTaskPerformanceSample(group, row) {
  const outcome = PERFORMANCE_OUTCOMES.find((candidate) => candidate.statuses.has(row.status));
  if (!outcome) return;
  const target = group.outcomes.get(outcome.key);
  target.taskCount += 1;
  addDurationSample(target.metrics.total, durationBetween(row.created_at, row.finished_at));
  addDurationSample(target.metrics.startupWait, durationBetween(row.queued_at, row.started_at));
  addDurationSample(target.metrics.executionPhase, durationBetween(row.started_at, row.finished_at));
}

function finalizeTaskPerformanceGroup(group) {
  const outcomes = {};
  for (const outcome of PERFORMANCE_OUTCOMES) {
    const source = group.outcomes.get(outcome.key);
    outcomes[outcome.key] = {
      taskCount: source.taskCount,
      metrics: Object.fromEntries(Object.entries(source.metrics).map(([key, metric]) => [key, finalizeDurationMetric(metric)])),
    };
  }
  const maxActiveAgeMs = group.activeAgesMs.length ? Math.max(...group.activeAgesMs) : null;
  return {
    employeeId: group.employeeId,
    employeeVersion: group.employeeVersion,
    terminalTaskCount: group.terminalTaskCount,
    active: {
      taskCount: group.activeTaskCount,
      maxAgeMs: maxActiveAgeMs,
      invalidAgeCount: group.activeInvalidCount,
    },
    outcomes,
  };
}

function createDurationMetric() {
  return { values: [], missingCount: 0, invalidCount: 0 };
}

function addDurationSample(metric, value) {
  if (value === null) metric.missingCount += 1;
  else if (!Number.isFinite(value) || value < 0) metric.invalidCount += 1;
  else metric.values.push(value);
}

function finalizeDurationMetric(metric) {
  const values = metric.values.toSorted((left, right) => left - right);
  return {
    sampleCount: values.length,
    missingCount: metric.missingCount,
    invalidCount: metric.invalidCount,
    p50Ms: nearestRank(values, 0.50),
    p95Ms: nearestRank(values, 0.95),
    p99Ms: nearestRank(values, 0.99),
  };
}

export function nearestRank(values, percentile) {
  if (!values.length) return null;
  return values[Math.max(0, Math.ceil(values.length * percentile) - 1)];
}

export function durationBetween(start, end) {
  if (!start || !end) return null;
  const startMs = Date.parse(start);
  const endMs = Date.parse(end);
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) return NaN;
  return endMs - startMs;
}

function activeTaskAgeMs(row, asOf) {
  const anchor = row.started_at || row.queued_at || row.created_at;
  return durationBetween(anchor, asOf);
}

function terminalPerformanceWindowMatch(row, since, until) {
  const finishedMs = Date.parse(row.finished_at || "");
  const boundaryMs = Number.isFinite(finishedMs) ? finishedMs : Date.parse(row.updated_at || "");
  return Number.isFinite(boundaryMs) && boundaryMs >= Date.parse(since) && boundaryMs <= Date.parse(until);
}

function candidateFromRow(row) {
  return {
    taskId: row.task_id,
    employeeId: row.employee_id,
    employeeVersion: row.employee_version || "unknown",
    status: row.status,
    occurredAt: row.finished_at || row.updated_at,
    lastErrorCode: row.last_error_code || "runtime_failure_unclassified",
    resultSummary: row.result_summary || "",
    terminalEvidenceDigest: row.terminal_evidence_digest || "",
    runtimeEvidenceAvailable: Boolean(row.has_runtime_evidence),
    attemptCount: Number(row.attempt_count || 0),
    recoveryCount: Number(row.recovery_count || 0),
    blockedReason: safeToken(row.blocked_reason),
    providerDiagnostic: safeProviderDiagnostic(row.provider_diagnostic_json),
    requestCount: Number(row.request_count || 0),
    toolCallCount: Number(row.tool_call_count || 0),
    activityStatuses: safeActivityStatuses(row.activity_statuses),
  };
}

function repairPlanForDiagnosis(diagnosis) {
  return {
    lifecycleState: "blocked",
    riskTier: "unconfigured",
    decisionCode: "no_approved_repair_tool",
    scopeSummary: `根因分类为 ${diagnosis.root_cause_category} 的单一异常档案；当前未选择外部目标。`,
    precheckSummary: "需先匹配已备案 Tool、精确 operation、目标 RBAC 和受限影响范围。",
    rollbackOrReconcileSummary: "没有已批准外部效果，当前不执行；后续若效果不确定，必须进入对账而非重试。",
    verificationSummary: "接入修复 Tool 后，必须定义同一目标的只读前检和后检，再允许创建修复任务。",
  };
}

function terminalProjectionDiagnosis(candidate) {
  const governance = candidate.status === "blocked" || candidate.status === "rejected";
  const hasSufficientEvidence = Boolean(candidate.terminalEvidenceDigest && candidate.runtimeEvidenceAvailable && candidate.resultSummary);
  const rootCauseCategory = governance
    ? "governance_or_authorization"
    : hasSufficientEvidence ? categoryForErrorCode(candidate.lastErrorCode) : "evidence_insufficient";
  return {
    diagnosisKind: "automatic_initial",
    diagnosisMethod: "terminal_projection",
    diagnosisConfidence: hasSufficientEvidence || governance ? "probable" : "insufficient",
    diagnosisState: hasSufficientEvidence || governance ? "completed" : "evidence_insufficient",
    rootCauseCategory,
    errorCode: candidate.lastErrorCode,
    evidenceState: candidate.runtimeEvidenceAvailable ? "available" : "missing",
    diagnosisSummary: governance
      ? `任务在 ${candidate.status} 门禁终态结束；初诊归类为治理或授权阻断。`
      : hasSufficientEvidence
        ? `任务在 ${candidate.status} 终态结束；初诊依据稳定错误码与现有安全运行证据归类。`
        : `任务在 ${candidate.status} 终态结束，但安全证据不足以判定根因；需复诊。`,
    impactSummary: "未改写原任务；影响范围以该任务和同类错误的后续聚合为准。",
    repairDraftSummary: governance
      ? "核对调用授权、RBAC、配置版本和准入契约；不得直接重试或绕过门禁。"
      : hasSufficientEvidence
        ? "先核对稳定错误码对应的运行配置与安全证据，再决定是否创建经授权的修复任务。"
        : "补充受控诊断证据后重新诊断；当前不得执行自动修复或重试。",
  };
}

function runtimeEvidenceDiagnosis(candidate) {
  const governance = candidate.status === "blocked" || candidate.status === "rejected";
  const diagnostic = candidate.providerDiagnostic || {};
  const activityStatuses = new Set(candidate.activityStatuses || []);
  if (activityStatuses.has("target_rejected")) {
    return automaticRuntimeDiagnosis(candidate, "completed", "confirmed", "tool_or_target",
      "安全 Tool 活动状态显示目标侧拒绝了该次操作。",
      "核对目标系统权限、目标状态和 Tool 契约，再决定是否创建受控修复任务。");
  }
  if (["provider_timeout", "http_error", "provider_error"].includes(diagnostic.category)) {
    return automaticRuntimeDiagnosis(candidate, "completed", "confirmed", "provider_or_model",
      `安全 Provider 诊断确认 ${providerDiagnosticLabel(diagnostic.category)}。`,
      "核对 Provider 可用性、超时/重试策略与模型配置；修复须另起受控任务。");
  }
  if (governance || activityStatuses.has("blocked") || activityStatuses.has("rejected")) {
    return automaticRuntimeDiagnosis(candidate, "completed", "probable", "governance_or_authorization",
      "安全运行状态确认该任务被治理或授权门禁阻断，但尚未确认具体根因。",
      "核对 RBAC、调用准入和当前配置版本；不得绕过门禁或直接重试。");
  }
  if (candidate.terminalEvidenceDigest && candidate.runtimeEvidenceAvailable) {
    return automaticRuntimeDiagnosis(candidate, "completed", "probable", "runtime_delivery_failure",
      "终态证据与安全运行证据表明任务未完成，但当前证据不能确认单一根因。",
      "按安全活动、恢复次数和配置版本复核；需要时由运维人员补充诊断，不得自动修复。");
  }
  return automaticRuntimeDiagnosis(candidate, "evidence_insufficient", "insufficient", "evidence_insufficient",
    "未取得足够的安全运行证据，不能确认失败根因。",
    "补齐受控运行证据后重新诊断；不得依据错误码自动修复或重试。");
}

function automaticRuntimeDiagnosis(candidate, diagnosisState, diagnosisConfidence, rootCauseCategory, diagnosisSummary, repairDraftSummary) {
  return {
    diagnosisKind: "automatic_initial",
    diagnosisMethod: "runtime_evidence",
    diagnosisConfidence,
    diagnosisState,
    rootCauseCategory,
    errorCode: candidate.lastErrorCode,
    evidenceState: candidate.runtimeEvidenceAvailable ? "available" : "missing",
    diagnosisSummary,
    impactSummary: "未改写原任务；影响范围以该任务和同类安全证据的后续聚合为准。",
    repairDraftSummary,
  };
}

function providerDiagnosticLabel(category) {
  if (category === "provider_timeout") return "Provider 超时";
  if (category === "http_error") return "Provider HTTP 错误";
  return "Provider 错误";
}

function safeProviderDiagnostic(value) {
  try {
    const input = JSON.parse(String(value || "{}"));
    const category = ["provider_timeout", "http_error", "provider_error"].includes(input?.category) ? input.category : "none";
    return { category, safeReasonCode: safeToken(input?.safeReasonCode), retryable: input?.retryable === true };
  } catch {
    return { category: "none", safeReasonCode: "", retryable: false };
  }
}

function safeActivityStatuses(value) {
  return [...new Set(String(value || "").split(",").filter((status) =>
    ["started", "completed", "blocked", "failed", "rejected", "target_rejected"].includes(status)))];
}

function safeToken(value) {
  const token = String(value || "").trim();
  return /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,159}$/.test(token) ? token : "";
}

function categoryForErrorCode(value) {
  const code = String(value || "").toLowerCase();
  if (/provider|model|stream|timeout/.test(code)) return "provider_or_model";
  if (/tool|target|http|api/.test(code)) return "tool_or_target";
  if (/input|contract|schema|validation/.test(code)) return "input_or_contract";
  return "runtime_delivery_failure";
}

function rollback(database) {
  try { database.exec("ROLLBACK"); } catch { /* no active transaction */ }
}

function opsIncidentDiagnosisError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

export { OPS_INCIDENT_DIAGNOSIS_CONTRACT_VERSION, DIAGNOSIS_KINDS, DIAGNOSIS_STATES, ROOT_CAUSES, TERMINAL_STATUSES };
