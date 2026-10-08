import { opsAnalyticsWindow } from "./agent-runtime/ops-task-analytics-reader.mjs";
import crypto from "node:crypto";

const CONTRACT_VERSION = "ops-incident-diagnosis.v1";
const RUNTIME_SUMMARY_CONTRACT_VERSION = "ops-runtime-task-summary.v1";
const RUNTIME_TASK_PERFORMANCE_CONTRACT_VERSION = "ops-runtime-task-performance-summary.v1";
const CANDIDATE_CONTRACT_VERSION = "ops-incident-candidate.v1";
const MAX_INCIDENTS = 500;
const FAILURE_STATUSES = new Set(["failed", "lost", "timed_out"]);
const GOVERNANCE_STATUSES = new Set(["blocked", "rejected"]);
const TOKEN = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,159}$/;

export function createOpsIncidentHandlers({
  diagnosisTaskService,
  hasPermission,
  readJsonBody,
  referenceHmacKey,
  requireSession,
  runtimeTaskRepository,
  runtimePerformanceObserver = null,
  getRuntimeTaskActorDisplayNameCacheSummary = () => null,
  sendJson,
  tenantScope,
} = {}) {
  if (typeof diagnosisTaskService?.request !== "function" || typeof hasPermission !== "function" || typeof requireSession !== "function" ||
    typeof runtimeTaskRepository?.summarizeOpsRuntimeTasks !== "function" ||
    typeof runtimeTaskRepository?.summarizeOpsRuntimeTaskPerformance !== "function" ||
    typeof runtimeTaskRepository?.listOpsTerminalCandidates !== "function" ||
    typeof runtimeTaskRepository?.listOpsIncidentArchive !== "function" ||
    typeof runtimeTaskRepository?.backfillOpsIncidentDiagnoses !== "function" ||
    typeof runtimeTaskRepository?.diagnoseOpsIncidentsWithRuntimeEvidence !== "function" ||
    typeof runtimeTaskRepository?.appendOpsIncidentDiagnosis !== "function" ||
    typeof readJsonBody !== "function" || typeof sendJson !== "function") {
    throw new TypeError("ops incident handlers require runtime task and HTTP dependencies");
  }
  const key = normalizedHmacKey(referenceHmacKey);
  const configuredTenantScope = token(tenantScope, "tenantScope");

  async function handle(req, res, url) {
    const isKnownRoute = url.pathname === "/api/ops/runtime-task-analytics" ||
      url.pathname === "/api/ops/incidents" ||
      url.pathname === "/api/ops/incident-candidates" ||
      url.pathname === "/api/ops/runtime-task-summary" ||
      url.pathname === "/api/ops/runtime-task-performance-summary" ||
      url.pathname === "/api/ops/runtime-performance-summary" ||
      url.pathname === "/api/ops/incidents/backfill" ||
      url.pathname === "/api/ops/incidents/runtime-evidence-diagnose" ||
      /^\/api\/ops\/incidents\/OPS-[a-f0-9]{24}\/diagnosis-tasks$/.test(url.pathname) ||
      /^\/api\/ops\/incidents\/OPS-[a-f0-9]{24}\/diagnoses$/.test(url.pathname);
    if (!isKnownRoute) return undefined;
    const session = requireSession(req, res);
    if (!session) return true;
    if (!canReadOps(session, hasPermission)) {
      sendJson(res, 403, {
        ok: false,
        error: "ops_governance_required",
        contractVersion: CONTRACT_VERSION,
      });
      return true;
    }
    if (req.method === "GET" && url.pathname === "/api/ops/runtime-task-analytics") {
      let window;
      let employeeId;
      try {
        window = opsAnalyticsWindow({ days: url.searchParams.get("days") || 7, endDate: url.searchParams.get("endDate") || "" });
        employeeId = optionalToken(url.searchParams.get("employeeId"), "employeeId");
      } catch {
        return sendJson(res, 400, { ok: false, error: "ops_analytics_filter_invalid" });
      }
      if (typeof runtimeTaskRepository.summarizeOpsRuntimeTaskAnalytics !== "function") {
        return sendJson(res, 503, { ok: false, error: "ops_analytics_unavailable" });
      }
      return sendJson(res, 200, { ok: true, ...runtimeTaskRepository.summarizeOpsRuntimeTaskAnalytics({
        tenantScope: configuredTenantScope, days: window.days, endDate: window.endDate, asOf: window.sourceAsOf, employeeId,
      }) });
    }
    const days = boundedInteger(url.searchParams.get("days"), 1, 7, 7);
    const sourceAsOf = new Date().toISOString();
    const windowStart = new Date(Date.parse(sourceAsOf) - days * 24 * 60 * 60 * 1000).toISOString();
    if (req.method === "GET" && url.pathname === "/api/ops/runtime-task-summary") {
      return sendJson(res, 200, runtimeSummaryResponse({ sourceAsOf, summaries: runtimeTaskRepository.summarizeOpsRuntimeTasks({ tenantScope: configuredTenantScope, since: windowStart, until: sourceAsOf }), windowDays: days }));
    }
    if (req.method === "GET" && url.pathname === "/api/ops/runtime-task-performance-summary") {
      const employeeId = optionalToken(url.searchParams.get("employeeId"), "employeeId");
      return sendJson(res, 200, runtimeTaskPerformanceSummaryResponse({
        asOf: sourceAsOf,
        employeeId,
        groups: runtimeTaskRepository.summarizeOpsRuntimeTaskPerformance({
          asOf: sourceAsOf,
          employeeId,
          since: windowStart,
          tenantScope: configuredTenantScope,
          until: sourceAsOf,
        }),
        windowDays: days,
      }));
    }
    if (req.method === "GET" && url.pathname === "/api/ops/runtime-performance-summary") {
      return sendJson(res, 200, runtimePerformanceSummaryResponse({
        cache: getRuntimeTaskActorDisplayNameCacheSummary?.() || null,
        summary: runtimePerformanceObserver?.summarize?.({ windowMinutes: boundedInteger(url.searchParams.get("windowMinutes"), 1, 60, 15) }) || null,
      }));
    }
    if (req.method === "GET" && url.pathname === "/api/ops/incident-candidates") {
      const candidates = runtimeTaskRepository.listOpsTerminalCandidates({ tenantScope: configuredTenantScope, since: windowStart, until: sourceAsOf, limit: 500 });
      return sendJson(res, 200, candidateResponse({ candidates, key, sourceAsOf, windowDays: days }));
    }
    if (req.method === "GET" && url.pathname === "/api/ops/incidents") {
      return sendJson(res, 200, archiveResponse({ archive: runtimeTaskRepository.listOpsIncidentArchive({ tenantScope: configuredTenantScope, limit: MAX_INCIDENTS }), key }));
    }
    if (req.method !== "POST" || !canDiagnoseOps(session, hasPermission)) {
      return sendJson(res, 403, { ok: false, error: "ops_diagnose_required", contractVersion: CONTRACT_VERSION });
    }
    const actorDigest = opaqueReference(key, `actor\0${sessionActor(session)}`);
    if (url.pathname === "/api/ops/incidents/backfill") {
      const candidates = runtimeTaskRepository.listOpsTerminalCandidates({ tenantScope: configuredTenantScope, since: windowStart, until: sourceAsOf, limit: 500 });
      const created = runtimeTaskRepository.backfillOpsIncidentDiagnoses({ actorDigest, candidates, now: sourceAsOf, tenantScope: configuredTenantScope });
      return sendJson(res, 200, { ok: true, contractVersion: CONTRACT_VERSION, createdCount: created.length, coverage: { sourceAsOf, sourceLimit: 500, mayBeTruncated: candidates.length === 500, windowDays: days } });
    }
    if (url.pathname === "/api/ops/incidents/runtime-evidence-diagnose") {
      const candidates = runtimeTaskRepository.listOpsTerminalCandidates({ tenantScope: configuredTenantScope, since: windowStart, until: sourceAsOf, limit: 500 });
      const created = runtimeTaskRepository.diagnoseOpsIncidentsWithRuntimeEvidence({ actorDigest, candidates, now: sourceAsOf, tenantScope: configuredTenantScope });
      return sendJson(res, 200, {
        ok: true,
        contractVersion: CONTRACT_VERSION,
        createdCount: created.length,
        coverage: { sourceAsOf, sourceLimit: 500, mayBeTruncated: candidates.length === 500, windowDays: days },
        privacyBoundary: "仅使用 canonical Runtime 的安全终态、Provider 诊断和 Tool/Skill 活动状态；不读取任务正文、会话、Prompt、工具参数或结果。",
      });
    }
    const taskMatch = url.pathname.match(/^\/api\/ops\/incidents\/(OPS-[a-f0-9]{24})\/diagnosis-tasks$/);
    if (taskMatch) {
      const result = diagnosisTaskService.request({ actorDigest, incidentId: taskMatch[1], now: sourceAsOf });
      return sendJson(res, 202, {
        ok: true,
        contractVersion: CONTRACT_VERSION,
        incidentId: taskMatch[1],
        diagnosisTask: {
          created: result.created,
          taskRef: opaqueReference(key, `ops-diagnosis-task\0${result.task.taskId}`),
          status: result.task.status,
        },
        privacyBoundary: "运营员工只接收异常档案引用并读取受控 Runtime 安全证据；不读取任务正文、会话、Prompt、工具参数或结果。",
      });
    }
    const match = url.pathname.match(/^\/api\/ops\/incidents\/(OPS-[a-f0-9]{24})\/diagnoses$/);
    if (match) {
      const input = safeDiagnosisInput(await readJsonBody(req));
      const result = runtimeTaskRepository.appendOpsIncidentDiagnosis({ actorDigest, expectedRevision: input.expectedRevision, incidentId: match[1], input, now: sourceAsOf, tenantScope: configuredTenantScope });
      return sendJson(res, 201, { ok: true, contractVersion: CONTRACT_VERSION, incidentId: match[1], ...result });
    }
    return sendJson(res, 404, { ok: false, error: "ops_incident_route_not_found", contractVersion: CONTRACT_VERSION });
  }

  return Object.freeze({ contractVersion: CONTRACT_VERSION, handle });
}

function runtimePerformanceSummaryResponse({ cache, summary }) {
  if (!summary) {
    return {
      ok: true,
      contractVersion: "ops-runtime-performance-summary.v1",
      status: "unavailable",
      metrics: [],
      cache: null,
      coverage: { collection: "unavailable" },
      privacyBoundary: "性能观测只聚合耗时、结果计数与缓存统计；不记录任务正文、姓名、身份标识、Prompt 或原始请求。",
    };
  }
  return {
    ok: true,
    ...summary,
    status: summary.metrics.some((metric) => metric.sampleCount > 0) ? "collecting" : "empty",
    cache,
    privacyBoundary: "性能观测只聚合耗时、结果计数与缓存统计；不记录任务正文、姓名、身份标识、Prompt 或原始请求。",
  };
}

export function projectOpsIncidents({
  employeeId = "",
  referenceHmacKey,
  sourceAsOf,
  tasks = [],
  windowStart,
} = {}) {
  const key = normalizedHmacKey(referenceHmacKey);
  const start = timestamp(windowStart, "windowStart");
  const asOf = timestamp(sourceAsOf, "sourceAsOf");
  const filterEmployeeId = optionalToken(employeeId, "employeeId");
  if (!Array.isArray(tasks)) throw projectionError("ops_incident_tasks_invalid");
  return Object.freeze(tasks
    .filter((task) => task && typeof task === "object")
    .map((task) => projectTaskIncident(task, key))
    .filter(Boolean)
    .filter((incident) => !filterEmployeeId || incident.employeeId === filterEmployeeId)
    .filter((incident) => incident.occurredAt >= start && incident.occurredAt <= asOf)
    .sort((left, right) => right.occurredAt.localeCompare(left.occurredAt) || left.incidentId.localeCompare(right.incidentId))
    .slice(0, MAX_INCIDENTS));
}

function projectTaskIncident(task, key) {
  const status = String(task.status || "").trim();
  const isFailure = FAILURE_STATUSES.has(status);
  const isGovernance = GOVERNANCE_STATUSES.has(status);
  if (!isFailure && !isGovernance) return null;
  const taskId = token(task.taskId, "taskId");
  const employeeId = token(task.employeeId, "employeeId");
  const employeeVersion = token(task.employeeVersion, "employeeVersion");
  const occurredAt = terminalTimestamp(task);
  const terminalEvidenceDigest = optionalDigest(task.terminalEvidenceDigest);
  const evidenceState = task.runtimeEvidence || task.runtimeEvidenceAvailable ? "available" : "missing";
  const category = isFailure ? "execution_failure" : "governance_signal";
  const incidentId = opaqueReference(key, `incident\0${taskId}\0${terminalEvidenceDigest || status}`);
  return Object.freeze({
    incidentId: `OPS-${incidentId}`,
    taskRef: opaqueReference(key, `task\0${taskId}`),
    employeeId,
    employeeVersion,
    occurredAt,
    category,
    severity: status === "lost" || status === "timed_out" ? "P1" : "P2",
    taskStatus: status,
    errorCode: safeErrorCode(task.lastErrorCode),
    evidenceState,
    evidenceSummary: safeSummary(task.resultSummary),
    diagnosticState: evidenceState === "available" ? "待受控诊断" : "安全证据不完整",
    diagnosisAvailable: false,
    repairState: "未授权",
    repairAvailable: false,
    sourceKind: "canonical_task_terminal_projection",
  });
}

function terminalTimestamp(task) {
  const candidate = task.occurredAt || task.finishedAt || task.updatedAt || task.createdAt;
  return timestamp(candidate, "taskTimestamp");
}

function runtimeSummaryResponse({ sourceAsOf, summaries, windowDays }) {
  const rows = new Map();
  for (const item of summaries) {
    const key = `${item.employeeId}\0${item.employeeVersion}`;
    const current = rows.get(key) || {
      employeeId: item.employeeId, employeeVersion: item.employeeVersion, taskCount: 0,
      completedCount: 0, failedCount: 0, blockedCount: 0, activeCount: 0, latestTaskAt: "",
    };
    current.taskCount += item.taskCount;
    if (item.status === "completed") current.completedCount += item.taskCount;
    else if (FAILURE_STATUSES.has(item.status)) current.failedCount += item.taskCount;
    else if (GOVERNANCE_STATUSES.has(item.status)) current.blockedCount += item.taskCount;
    else current.activeCount += item.taskCount;
    if (!current.latestTaskAt || item.latestTaskAt > current.latestTaskAt) current.latestTaskAt = item.latestTaskAt;
    rows.set(key, current);
  }
  return {
    ok: true,
    contractVersion: RUNTIME_SUMMARY_CONTRACT_VERSION,
    summaries: [...rows.values()].sort((left, right) => left.employeeId.localeCompare(right.employeeId)),
    coverage: { sourceAsOf, taskAuthority: "canonical_execution_task", windowDays, mayBeTruncated: false },
    privacyBoundary: "仅返回按员工和版本聚合的任务状态计数与最近时间；不返回任务正文、会话、Prompt、工具数据或原始异常。",
  };
}

function runtimeTaskPerformanceSummaryResponse({ asOf, employeeId, groups, windowDays }) {
  return {
    ok: true,
    contractVersion: RUNTIME_TASK_PERFORMANCE_CONTRACT_VERSION,
    groups,
    filter: employeeId ? { employeeId } : null,
    coverage: {
      sourceAsOf: asOf,
      taskAuthority: "canonical_execution_task",
      terminalWindowField: "finished_at",
      terminalWindowFallback: "updated_at only for missing or invalid finished_at",
      windowDays,
      persistence: "execution_task_sqlite",
      activeStatuses: ["queued", "running", "waiting"],
      durationDefinitions: {
        total: "finished_at - created_at",
        startupWait: "started_at - queued_at",
        executionPhase: "finished_at - started_at; includes waiting and retries",
      },
    },
    privacyBoundary: "仅返回按员工和版本聚合的任务耗时分位数、样本覆盖与运行中时长；不返回任务正文、会话、Prompt、工具参数/结果、路径、凭据或原始异常。",
  };
}

function candidateResponse({ candidates, key, sourceAsOf, windowDays }) {
  return {
    ok: true,
    contractVersion: CANDIDATE_CONTRACT_VERSION,
    candidates: projectOpsIncidents({ key, referenceHmacKey: key, sourceAsOf, tasks: candidates, windowStart: new Date(Date.parse(sourceAsOf) - windowDays * 24 * 60 * 60 * 1000).toISOString() }),
    coverage: { sourceAsOf, taskAuthority: "canonical_execution_task", windowDays, sourceLimit: 500, mayBeTruncated: candidates.length === 500, persistence: "read_only_projection" },
    privacyBoundary: "仅返回任务状态、稳定错误码、受限安全摘要和 HMAC 任务引用；不返回任务正文、会话、Prompt、工具参数/结果、路径、凭据或原始异常。",
  };
}

function archiveResponse({ archive, key }) {
  return {
    ok: true,
    contractVersion: CONTRACT_VERSION,
    incidents: archive.map((item) => ({
      ...item,
      incidentId: item.incidentId,
      taskRef: opaqueReference(key, `archive\0${item.incidentId}`),
      severity: item.sourceStatus === "lost" || item.sourceStatus === "timed_out" ? "P1" : "P2",
    })),
    persistence: "execution_task_sqlite_ops_diagnosis_versions",
    privacyBoundary: "档案只保存脱敏诊断结论、稳定错误码、安全摘要和修复草案；不保存任务正文、会话、Prompt、工具数据、凭据或原始异常。",
  };
}

function canDiagnoseOps(session, hasPermission) {
  return session?.role === "admin" || hasPermission(session?.permissions, "ops:diagnose");
}

function sessionActor(session) {
  return String(session?.subject || session?.email || session?.name || session?.id || "ops-administrator");
}

function safeDiagnosisInput(value) {
  const input = value && typeof value === "object" ? value : {};
  const rootCauseCategory = String(input.rootCauseCategory || "").trim();
  if (![
    "runtime_delivery_failure", "provider_or_model", "tool_or_target", "governance_or_authorization",
    "input_or_contract", "evidence_insufficient", "other",
  ].includes(rootCauseCategory)) throw projectionError("ops_incident_root_cause_invalid");
  const expectedRevision = Number(input.expectedRevision);
  if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 1) throw projectionError("ops_incident_revision_invalid");
  return {
    diagnosisKind: "operator",
    diagnosisMethod: "operator",
    diagnosisConfidence: "probable",
    diagnosisState: input.diagnosisState === "evidence_insufficient" ? "evidence_insufficient" : "completed",
    rootCauseCategory,
    errorCode: safeErrorCode(input.errorCode),
    evidenceState: input.evidenceState === "missing" ? "missing" : "available",
    diagnosisSummary: safeOperatorText(input.diagnosisSummary, "diagnosisSummary"),
    impactSummary: safeOperatorText(input.impactSummary, "impactSummary"),
    repairDraftSummary: safeOperatorText(input.repairDraftSummary, "repairDraftSummary"),
    expectedRevision,
    idempotencyKey: token(input.idempotencyKey, "idempotencyKey"),
  };
}

function safeOperatorText(value, field) {
  const result = String(value || "").trim().replace(/[\r\n\0]+/g, " ");
  if (!result || result.length > 500 || /(password|token|secret|api[_-]?key|bearer|credential|cookie)/i.test(result)) {
    throw projectionError("ops_incident_safe_text_invalid", field);
  }
  return result;
}

function safeErrorCode(value) {
  const result = String(value || "").trim();
  return TOKEN.test(result) ? result : "runtime_failure_unclassified";
}

function safeSummary(value) {
  const result = String(value || "").trim().replace(/[\r\n\0]+/g, " ");
  return result.slice(0, 500);
}

function canReadOps(session, hasPermission) {
  return session?.role === "admin" || hasPermission(session?.permissions, "system:read") ||
    hasPermission(session?.permissions, "ops:read");
}

function boundedInteger(value, minimum, maximum, defaultValue) {
  if (value === null || value === undefined || value === "") return defaultValue;
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < minimum || number > maximum) {
    throw projectionError("ops_incident_window_invalid");
  }
  return number;
}

function timestamp(value, field) {
  const result = String(value || "").trim();
  const parsed = new Date(result);
  if (!result || !Number.isFinite(parsed.getTime())) throw projectionError("ops_incident_timestamp_invalid", field);
  return parsed.toISOString();
}

function optionalDigest(value) {
  const result = String(value || "").trim().toLowerCase();
  return /^[a-f0-9]{64}$/.test(result) ? result : "";
}

function token(value, field) {
  const result = String(value || "").trim();
  if (!TOKEN.test(result)) throw projectionError("ops_incident_token_invalid", field);
  return result;
}

function optionalToken(value, field) {
  if (value === null || value === undefined || value === "") return "";
  return token(value, field);
}

function normalizedHmacKey(value) {
  const key = Buffer.isBuffer(value) ? Buffer.from(value) : Buffer.from(value || []);
  if (key.length !== 32) throw projectionError("ops_incident_reference_key_invalid");
  return key;
}

function opaqueReference(key, value) {
  return crypto.createHmac("sha256", key).update(value, "utf8").digest("hex").slice(0, 20);
}

function projectionError(code, detail = "") {
  const error = new Error(detail ? `${code}: ${detail}` : code);
  error.code = code;
  return error;
}

export { CONTRACT_VERSION as OPS_INCIDENT_PROJECTION_CONTRACT_VERSION, projectionError as opsIncidentProjectionError };
