import { smoothTrendPath } from "../lib/smoothTrend.js";
import OpsTaskAnalyticsPanel from "./OpsTaskAnalyticsPanel";
import {
  Activity,
  AlertTriangle,
  ChartColumnIncreasing,
  DatabaseZap,
  ShieldAlert,
  UsersRound,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { digitalEmployees } from "../data/catalog";
import { opsObservationBoundary } from "../data/opsObservability";
import { backfillOpsIncidentDiagnoses, diagnoseOpsIncidentsWithRuntimeEvidence, requestOpsIncidentCandidates, requestOpsIncidentDiagnosisTask, requestOpsIncidents, requestOpsRuntimePerformanceSummary, requestOpsRuntimeTaskPerformanceSummary, requestOpsRuntimeTaskSummary } from "../lib/opsIncidents";
import { isSystemAdminSession } from "../lib/permissions";
import { fetchOpsUsageSummary } from "../lib/opsUsage";
import MetricCard from "./MetricCard";

const viewLabels = {
  overview: "总览",
  people: "人员管理",
  employees: "数字员工",
  basicSkills: "基础技能",
  businessSkills: "专项业务技能",
  systemImports: "系统接入",
  subsystemRequests: "业务系统审核",
  qualityManagement: "质量管理",
  skillEmployeeReview: "技能/员工评审",
  evaluationReview: "测评审核",
  systemWorkers: "AI Worker 调度",
  systemManagement: "模型供应商与连接",
  opsMonitor: "运维监控",
};

const trendMeta = {
  intervene: { label: "需介入", tone: "warn", rank: 0 },
  watch: { label: "持续观察", tone: "info", rank: 1 },
  stable: { label: "稳定", tone: "good", rank: 2 },
  planned: { label: "待接入", tone: "muted", rank: 3 },
};

function formatTime(value) {
  if (!value) return "暂无";
  return new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(new Date(value));
}

function formatPercent(value) {
  if (!Number.isFinite(value)) return "暂无";
  return `${Math.round(value * 100)}%`;
}

function formatMetricNumber(value, digits = 1) {
  if (!Number.isFinite(value)) return "暂无";
  if (Math.abs(value) >= 1000) return value.toLocaleString("zh-CN");
  if (Number.isInteger(value)) return String(value);
  return value.toFixed(digits);
}

function formatDuration(value) {
  return Number.isFinite(value) ? `${formatMetricNumber(value)} ms` : "暂无";
}

function durationTone(value) {
  if (!Number.isFinite(value)) return "muted";
  if (value >= 30000) return "danger";
  if (value >= 5000) return "warn";
  return "good";
}

function metricTone(value) {
  return `is-${durationTone(value)}`;
}

function taskSuccessRate(tasks = {}) {
  if (!tasks.total) return null;
  return tasks.succeeded / tasks.total;
}

function taskIssueRate(tasks = {}) {
  if (!tasks.total) return null;
  return ((tasks.failed || 0) + (tasks.blocked || 0)) / tasks.total;
}

function taskIssueCount(tasks = {}) {
  return (tasks.failed || 0) + (tasks.blocked || 0);
}

function isHighSeverity(event) {
  return ["P0", "P1"].includes(event?.severity);
}

function policyByEmployeeId(policies = []) {
  return new Map((policies || []).filter((policy) => policy?.employeeId).map((policy) => [policy.employeeId, policy]));
}

function qualityEventsForEmployee(employee = {}, qualityEvents = []) {
  const relatedIds = new Set([
    employee.id,
    ...(employee.basicSkillIds || []),
    ...(employee.businessSkillIds || []),
  ].filter(Boolean));
  return (qualityEvents || []).filter((event) => relatedIds.has(event.entityId));
}

function emptyTaskSummary() {
  return { total: 0, succeeded: 0, failed: 0, blocked: 0, active: 0, inReview: 0 };
}

function taskSummaryForEmployee(employee = {}, runtimeSummary = null) {
  const runtime = runtimeSummary || { taskCount: 0, completedCount: 0, failedCount: 0, blockedCount: 0, activeCount: 0, latestTaskAt: "" };
  return {
    employeeId: employee.id,
    observationWindow: "近 7 日",
    calls: runtime.taskCount,
    tasks: { total: runtime.taskCount, succeeded: runtime.completedCount, failed: runtime.failedCount, blocked: runtime.blockedCount, active: runtime.activeCount, inReview: 0 },
    latencyP95Sec: null,
    lastRunAt: runtime.latestTaskAt || "",
    source: "canonical_execution_task",
  };
}

function governanceSignalForEmployee({ summary = {}, employee = {}, policy = null, relatedQualityEvents = [] } = {}) {
  const employeeName = employee.name || summary.employeeId || "该数字员工";
  const highSeverityCount = relatedQualityEvents.filter(isHighSeverity).length;
  const policyFailureRate = policy?.currentSignals?.failureRate7d;
  const maxFailureRate = policy?.qualityThresholds?.maxFailureRate7d;
  const overFailureThreshold =
    Number.isFinite(policyFailureRate) &&
    Number.isFinite(maxFailureRate) &&
    policyFailureRate > maxFailureRate;

  if (highSeverityCount > 0) {
    return {
      ...summary,
      trend: "intervene",
      primarySignal: `${employeeName} 有 ${highSeverityCount} 个 P0/P1 质量信号，需要先进入质量闭环确认根因和回归样本。`,
      nextAction: "进入质量管理页处理高优先级质量事件，确认修复动作和回归证据。",
    };
  }

  if (overFailureThreshold) {
    return {
      ...summary,
      trend: "intervene",
      primarySignal: `${employeeName} 当前失败率 ${formatPercent(policyFailureRate)} 超过调用门禁阈值 ${formatPercent(maxFailureRate)}。`,
      nextAction: "先收敛调用来源、错误码和质量事件，再调整额度或放开调用范围。",
    };
  }

  if (employee.status === "人员审批通过") {
    return {
      ...summary,
      trend: "watch",
      primarySignal: `${employeeName} 人员审批已通过，仍需单独确认试运行范围、调用门禁和回滚边界。`,
      nextAction: "在技能/员工评审页执行进入试运行；生产上线仍需正式 RBAC、审计和资源租约。",
      tasks: {
        ...(summary.tasks || emptyTaskSummary()),
        inReview: Math.max(summary.tasks?.inReview || 0, 1),
      },
    };
  }

  if (employee.status === "待人员审批") {
    return {
      ...summary,
      trend: "intervene",
      primarySignal: `${employeeName} 仍处于待人员审批，归属、权限范围和试运行资格尚未确认。`,
      nextAction: "先完成人员审批；通过后再单独确认试运行范围、调用门禁和回滚策略。",
    };
  }

  if (employee.status === "试运行") {
    return {
      ...summary,
      trend: taskIssueCount(summary.tasks) > 0 ? "watch" : "stable",
      primarySignal: `${employeeName} 已进入 MVP 试运行，继续按调用门禁、回归证据和质量事件观察。`,
      nextAction: "跟踪试运行质量事件和回归样本；生产上线仍需正式 RBAC、审计和资源租约。",
    };
  }

  if (employee.status === "在线") {
    return {
      ...summary,
      trend: taskIssueCount(summary.tasks) > 0 ? "watch" : "stable",
      primarySignal: `${employeeName} 当前为在线状态，运行观察以调用门禁、质量事件和后端采集为准。`,
      nextAction: "持续观察调用额度、失败率和质量回流；异常时进入质量闭环。",
    };
  }

  if (employee.status === "规划中") {
    return {
      ...summary,
      trend: "planned",
      primarySignal: `${employeeName} 仍是规划中资产，未进入运行监控。`,
      nextAction: "补齐 owner、输入输出契约、人审门禁和数据边界后再进入试运行。",
    };
  }

  return {
    ...summary,
    trend: summary.trend || "watch",
    primarySignal: `${employeeName} 当前状态为 ${employee.status || "未标注"}，请按后端目录和评审状态确认下一步。`,
    nextAction: "优先核对后端运行目录、人员/技能评审状态和调用门禁。",
  };
}

function shouldShowObservationEmployee(employee = {}, runtimeSummary, policy, relatedQualityEvents = []) {
  if (!employee.id) return false;
  if (runtimeSummary || policy || relatedQualityEvents.length) return true;
  if (employee.level === "系统级") return ["在线", "试运行"].includes(employee.status);
  return employee.status !== "规划中";
}

function healthForRow(summary, policy, relatedQualityEvents) {
  const policyFailureRate = policy?.currentSignals?.failureRate7d;
  const maxFailureRate = policy?.qualityThresholds?.maxFailureRate7d;
  const overFailureThreshold =
    Number.isFinite(policyFailureRate) &&
    Number.isFinite(maxFailureRate) &&
    policyFailureRate > maxFailureRate;
  const openHighSeverity = relatedQualityEvents.filter(isHighSeverity).length;
  if (summary.trend === "intervene" || overFailureThreshold || openHighSeverity > 0) return "intervene";
  if (summary.trend === "watch" || taskIssueCount(summary.tasks) > 0) return "watch";
  return summary.trend || "stable";
}

function buildObservationRows({ employees = digitalEmployees, invocationPolicies = [], qualityEvents = [], runtimeSummaries = [] } = {}) {
  const runtimeEmployees = employees || digitalEmployees;
  const employeeById = new Map(runtimeEmployees.map((employee) => [employee.id, employee]));
  const runtimeSummaryByEmployee = new Map();
  runtimeSummaries.forEach((summary) => {
    const current = runtimeSummaryByEmployee.get(summary.employeeId) || { employeeId: summary.employeeId, taskCount: 0, completedCount: 0, failedCount: 0, blockedCount: 0, activeCount: 0, latestTaskAt: "" };
    current.taskCount += summary.taskCount || 0;
    current.completedCount += summary.completedCount || 0;
    current.failedCount += summary.failedCount || 0;
    current.blockedCount += summary.blockedCount || 0;
    current.activeCount += summary.activeCount || 0;
    if (!current.latestTaskAt || summary.latestTaskAt > current.latestTaskAt) current.latestTaskAt = summary.latestTaskAt;
    runtimeSummaryByEmployee.set(summary.employeeId, current);
  });
  const policiesByEmployee = policyByEmployeeId(invocationPolicies);

  return [...employeeById.values()]
    .map((employee) => {
      const runtimeSummary = runtimeSummaryByEmployee.get(employee.id);
      const policy = policiesByEmployee.get(employee.id);
      const relatedQualityEvents = qualityEventsForEmployee(employee, qualityEvents);
      if (!shouldShowObservationEmployee(employee, runtimeSummary, policy, relatedQualityEvents)) return null;
      const summary = taskSummaryForEmployee(employee, runtimeSummary);
      const effectiveSummary = governanceSignalForEmployee({ summary, employee, policy, relatedQualityEvents });
      const healthKey = healthForRow(effectiveSummary, policy, relatedQualityEvents);
      const meta = trendMeta[healthKey] || trendMeta.stable;
      const policyFailureRate = policy?.currentSignals?.failureRate7d;
      const issueRate = Number.isFinite(policyFailureRate) ? policyFailureRate : taskIssueRate(effectiveSummary.tasks);
      return {
        employee,
        summary: effectiveSummary,
        policy,
        relatedQualityEvents,
        healthKey,
        healthLabel: meta.label,
        healthTone: meta.tone,
        healthRank: meta.rank,
        issueRate,
        successRate: taskSuccessRate(effectiveSummary.tasks),
      };
    })
    .filter(Boolean)
    .sort((left, right) => left.healthRank - right.healthRank || right.summary.calls - left.summary.calls);
}

function buildObservationMetrics(rows) {
  const totals = rows.reduce(
    (current, row) => {
      const tasks = row.summary.tasks || {};
      current.calls += row.summary.calls || 0;
      current.tasks += tasks.total || 0;
      current.succeeded += tasks.succeeded || 0;
      current.failed += tasks.failed || 0;
      current.blocked += tasks.blocked || 0;
      if ((row.summary.calls || 0) > 0) current.activeEmployees += 1;
      if (row.healthKey === "intervene") current.intervention += 1;
      if (row.healthKey === "watch") current.watch += 1;
      return current;
    },
    { calls: 0, tasks: 0, succeeded: 0, failed: 0, blocked: 0, activeEmployees: 0, intervention: 0, watch: 0 },
  );
  return {
    ...totals,
    successRate: totals.tasks ? totals.succeeded / totals.tasks : null,
    issueCount: totals.failed + totals.blocked,
  };
}

function diagnosisEvidencePresentation(incident = {}) {
  if (incident.diagnosisConfidence === "confirmed" && ["provider_or_model", "tool_or_target"].includes(incident.rootCauseCategory)) {
    return { detail: "安全运行证据已交叉确认", label: "根因已确认", tone: "root-confirmed" };
  }
  if (incident.diagnosisState === "evidence_insufficient") {
    return { detail: "需补充安全运行证据", label: "根因待定位", tone: "root-pending" };
  }
  return { detail: "终态或门禁事实已确认", label: "运行事实已确认", tone: "fact-confirmed" };
}

function runtimeHealthForRow(summary = {}) {
  const tasks = summary.tasks || {};
  if ((tasks.failed || 0) > 0) return "intervene";
  if ((tasks.blocked || 0) > 0 || (tasks.active || 0) > 0) return "watch";
  return "stable";
}

function runtimeNextAction(summary = {}) {
  const tasks = summary.tasks || {};
  if ((tasks.failed || 0) > 0) return "查看异常候选；完成诊断后才可形成受控修复草案。";
  if ((tasks.blocked || 0) > 0) return "核对治理或授权阻断；不要将其直接判为运行故障。";
  if ((tasks.active || 0) > 0) return "任务仍在处理中；未配置 SLA 时不自动判定超时。";
  return "本窗口内没有需要运维介入的终态问题。";
}

function TaskOutcomeBar({ tasks = {} }) {
  const total = Math.max(tasks.total || 0, 1);
  const succeededWidth = ((tasks.succeeded || 0) / total) * 100;
  const failedWidth = ((tasks.failed || 0) / total) * 100;
  const blockedWidth = ((tasks.blocked || 0) / total) * 100;
  return (
    <div className="ops-task-bar" aria-label={`${tasks.succeeded || 0} 成功，${tasks.failed || 0} 失败，${tasks.blocked || 0} 阻断`}>
      <span className="is-success" style={{ width: `${succeededWidth}%` }} />
      <span className="is-failed" style={{ width: `${failedWidth}%` }} />
      <span className="is-blocked" style={{ width: `${blockedWidth}%` }} />
    </div>
  );
}

function systemStatusLabel(status) {
  if (status === "collecting") return "已接入";
  return status || "未知";
}

function systemStatusTone(status) {
  if (status === "collecting") return "good";
  return "muted";
}

function statusToneClass(tone) {
  if (tone === "watch") return "warn";
  if (tone === "danger") return "danger";
  return tone || "muted";
}

function EmptyUsageState({ summary }) {
  return (
    <section className="panel ops-empty-panel">
      <DatabaseZap size={22} />
      <div>
        <h2>暂无真实使用统计</h2>
        <p>
          当前运维页只展示后端采集到的真实 MVP 使用事件。历史使用不会回填，也不会展示示例 DAU 或示例高频用户。
        </p>
        <span>{summary?.coverage?.note || "等待登录、会话刷新或页面访问事件进入后端统计。"}</span>
      </div>
    </section>
  );
}

function AccessDenied() {
  return (
    <section className="panel empty-panel">
      <div className="panel-head">
        <div>
          <p className="eyebrow">Ops Monitor</p>
          <h2>仅管理员可查看运维监控</h2>
        </div>
        <span className="status-pill warn">system:read required</span>
      </div>
      <p>
        日活和高频用户属于平台治理数据，需要系统管理员或等价后端权限。普通员工不能通过前端 hash 直接查看。
      </p>
    </section>
  );
}

function buildDauTrend(series = []) {
  const width = 760;
  const height = 118;
  const padding = { top: 12, right: 16, bottom: 24, left: 34 };
  const plotWidth = width - padding.left - padding.right;
  const plotHeight = height - padding.top - padding.bottom;
  const values = series.map((day) => {
    if (Number.isFinite(day.dau)) return day.dau;
    return (day.systems || []).reduce((sum, system) => sum + (system.dau || 0), 0);
  });
  const max = Math.max(1, ...values);
  const baseY = padding.top + plotHeight;
  const points = series.map((day, index) => {
    const ratio = series.length <= 1 ? 0.5 : index / (series.length - 1);
    const value = values[index] || 0;
    return {
      date: day.date,
      label: day.label,
      value,
      eventCount: day.eventCount || 0,
      x: padding.left + ratio * plotWidth,
      y: padding.top + (1 - value / max) * plotHeight,
    };
  });
  const linePath = smoothTrendPath(points);
  const areaPath = points.length
    ? `${linePath} L ${points[points.length - 1].x.toFixed(1)} ${baseY.toFixed(1)} L ${points[0].x.toFixed(1)} ${baseY.toFixed(1)} Z`
    : "";
  return { width, height, padding, plotHeight, max, baseY, points, linePath, areaPath };
}

function DauTrendLineChart({ series = [] }) {
  const chart = buildDauTrend(series);
  const midY = chart.padding.top + chart.plotHeight / 2;
  const peak = chart.points.reduce((current, point) => (point.value > current.value ? point : current), { value: 0 });

  return (
    <div className="ops-line-chart" aria-label="近 7 日 DAU 折线趋势">
      <svg viewBox={`0 0 ${chart.width} ${chart.height}`} role="img">
        <title>近 7 日 DAU 折线趋势</title>
        <line className="ops-line-grid" x1={chart.padding.left} y1={chart.padding.top} x2={chart.width - chart.padding.right} y2={chart.padding.top} />
        <line className="ops-line-grid" x1={chart.padding.left} y1={midY} x2={chart.width - chart.padding.right} y2={midY} />
        <line className="ops-line-grid" x1={chart.padding.left} y1={chart.baseY} x2={chart.width - chart.padding.right} y2={chart.baseY} />
        <text className="ops-line-axis-label" x="10" y={chart.padding.top + 4}>{chart.max}</text>
        <text className="ops-line-axis-label" x="10" y={chart.baseY + 4}>0</text>
        {chart.areaPath ? <path className="ops-line-area" d={chart.areaPath} /> : null}
        {chart.linePath ? <path className="ops-line-path" d={chart.linePath} /> : null}
        {chart.points.map((point) => (
          <g className="ops-line-point" key={point.date}>
            <line className="ops-line-tick" x1={point.x} y1={chart.baseY} x2={point.x} y2={chart.baseY + 6} />
            <circle cx={point.x} cy={point.y} r="4.4">
              <title>{`${point.label}: ${point.value} DAU，${point.eventCount} 条事件`}</title>
            </circle>
            <text className="ops-line-value" x={point.x} y={Math.max(12, point.y - 9)}>{point.value}</text>
            <text className="ops-line-date" x={point.x} y={chart.height - 9}>{point.label}</text>
          </g>
        ))}
      </svg>
      <div className="ops-line-summary">
        <span><i className="is-platform" />数字员工系统</span>
        <b>峰值 {peak.value} DAU{peak.label ? ` / ${peak.label}` : ""}</b>
      </div>
    </div>
  );
}

function buildSingleLineChart(series = [], valueKey = "value", { width = 520, height = 150 } = {}) {
  const padding = { top: 16, right: 18, bottom: 28, left: 34 };
  const plotWidth = width - padding.left - padding.right;
  const plotHeight = height - padding.top - padding.bottom;
  const values = series.map((point) => Number(point[valueKey]) || 0);
  const max = Math.max(1, ...values);
  const baseY = padding.top + plotHeight;
  const points = series.map((point, index) => {
    const ratio = series.length <= 1 ? 0.5 : index / (series.length - 1);
    const value = Number(point[valueKey]) || 0;
    return {
      ...point,
      value,
      x: padding.left + ratio * plotWidth,
      y: padding.top + (1 - value / max) * plotHeight,
    };
  });
  const linePath = smoothTrendPath(points);
  return { width, height, padding, plotHeight, max, baseY, points, linePath };
}

function MiniLineChart({ title, series = [], valueKey = "value", suffix = "" }) {
  const chart = buildSingleLineChart(series, valueKey);
  const lastPoint = chart.points[chart.points.length - 1];
  return (
    <div className="ops-mini-chart" aria-label={title}>
      <svg viewBox={`0 0 ${chart.width} ${chart.height}`} role="img">
        <title>{title}</title>
        <line className="ops-line-grid" x1={chart.padding.left} y1={chart.padding.top} x2={chart.width - chart.padding.right} y2={chart.padding.top} />
        <line className="ops-line-grid" x1={chart.padding.left} y1={chart.baseY} x2={chart.width - chart.padding.right} y2={chart.baseY} />
        {chart.linePath ? <path className="ops-line-path is-compact" d={chart.linePath} /> : null}
        {chart.points.map((point) => (
          <g className="ops-line-point" key={point.label}>
            <circle cx={point.x} cy={point.y} r="4.5">
              <title>{`${point.label}: ${formatMetricNumber(point.value, 2)}${suffix}`}</title>
            </circle>
            <text className="ops-line-date" x={point.x} y={chart.height - 10}>{point.label}</text>
          </g>
        ))}
      </svg>
      <div className="ops-line-summary">
        <span><i className="is-platform" />{title}</span>
        <b>最新 {lastPoint ? `${formatMetricNumber(lastPoint.value, 2)}${suffix}` : "暂无"}</b>
      </div>
    </div>
  );
}

function OpsHealthDial({ score, label, riskLevel }) {
  const clampedScore = Math.max(0, Math.min(100, Number(score) || 0));
  return (
    <div className={`ops-health-dial is-${riskLevel}`} style={{ "--score-deg": `${clampedScore * 3.6}deg` }}>
      <div>
        <strong>{clampedScore}</strong>
        <span>{label}</span>
      </div>
    </div>
  );
}

function sumPolicySignals(policyRows = []) {
  return policyRows.reduce(
    (totals, row) => {
      const signals = row.policy?.currentSignals || {};
      totals.callsToday += Number(signals.callsToday) || 0;
      totals.callsThisHour += Number(signals.callsThisHour) || 0;
      totals.concurrentRuns += Number(signals.concurrentRuns) || 0;
      return totals;
    },
    { callsToday: 0, callsThisHour: 0, concurrentRuns: 0 },
  );
}

function buildRuntimeHealth({ status, observationMetrics }) {
  const issueRate = observationMetrics.tasks ? observationMetrics.issueCount / observationMetrics.tasks : 0;
  const loadingPenalty = status === "loading" ? 6 : 0;
  const errorPenalty = status === "error" ? 28 : 0;
  const score = Math.max(
    0,
    Math.min(100, 100 - Math.round(issueRate * 55 + observationMetrics.intervention * 8 + loadingPenalty + errorPenalty)),
  );
  if (status === "error") return { score, label: "接口异常", riskLevel: "danger" };
  if (!observationMetrics.tasks) return { score, label: "暂无任务", riskLevel: "watch" };
  if (score >= 90) return { score, label: "稳定", riskLevel: "stable" };
  if (score >= 75) return { score, label: "观察", riskLevel: "watch" };
  return { score, label: "需介入", riskLevel: "danger" };
}

function collectionStatusLabel(status, summary) {
  if (status === "loading") return "读取中";
  if (status === "error") return "失败";
  if (summary?.status === "empty") return "无事件";
  return "正常";
}

function collectionStatusTone(status, summary) {
  if (status === "error") return "danger";
  if (status === "loading" || summary?.status === "empty") return "watch";
  return "good";
}

function buildRuntimeAlertRules({ status, observationMetrics, candidateCount = 0, incidentCount = 0, policyRows, qualityEvents }) {
  const rules = [];
  const p0p1Count = qualityEvents.filter(isHighSeverity).length;
  const quotaRows = policyRows.filter((row) => {
    const callsThisHour = row.policy?.currentSignals?.callsThisHour;
    const maxHourlyCalls = row.policy?.resourceThresholds?.maxHourlyCalls;
    return Number.isFinite(callsThisHour) && Number.isFinite(maxHourlyCalls) && maxHourlyCalls > 0 && callsThisHour / maxHourlyCalls >= 0.8;
  });

  if (status === "error") {
    rules.push({
      id: "runtime-task-summary-error",
      title: "Runtime 任务聚合读取失败",
      severity: "P1",
      status: "待处理",
      signal: "/api/ops/runtime-task-summary 未返回可用聚合。",
      nextAction: "检查 LAN 后端、登录态与 canonical task repository。",
    });
  }
  if (observationMetrics.failed) {
    rules.push({
      id: "runtime-task-failures",
      title: "canonical Runtime 出现失败任务",
      severity: "P1",
      status: "待诊断",
      signal: `近 7 日聚合到 ${observationMetrics.failed} 个失败任务。`,
      nextAction: "先查看异常候选，并从受控诊断档案确认安全证据。",
    });
  }
  if (observationMetrics.blocked) {
    rules.push({
      id: "runtime-task-blocked",
      title: "canonical Runtime 出现治理阻断",
      severity: "P2",
      status: "需核对",
      signal: `近 7 日聚合到 ${observationMetrics.blocked} 个 blocked/rejected 任务。`,
      nextAction: "核对授权、调用门禁或输入契约；不要直接视为运行故障。",
    });
  }
  if (candidateCount) {
    rules.push({
      id: "runtime-incident-candidates",
      title: "存在未归档异常候选",
      severity: "P2",
      status: "待诊断",
      signal: `${candidateCount} 条候选来自 canonical Runtime 终态投影。`,
      nextAction: "按需补充近一周诊断档案；该动作不会改写源任务。",
    });
  }
  if (p0p1Count) {
    rules.push({
      id: "quality-p0p1-open",
      title: "存在 P0/P1 质量信号",
      severity: "P1",
      status: "复盘中",
      signal: `${p0p1Count} 个高优先级质量事件来自控制面 API。`,
      nextAction: "进入质量管理页跟进根因、修复动作和回归样本。",
    });
  }
  if (quotaRows.length) {
    rules.push({
      id: "policy-quota-near-limit",
      title: "调用门禁接近小时额度",
      severity: "P2",
      status: "观察",
      signal: `${quotaRows.length} 条策略接近 maxHourlyCalls。`,
      nextAction: "检查调用方、部门额度和是否需要排队或扩容。",
    });
  }
  if (incidentCount) {
    rules.push({
      id: "runtime-incident-archive",
      title: "存在可复查问题档案",
      severity: "P3",
      status: "已归档",
      signal: `${incidentCount} 条档案保留了版本化安全诊断。`,
      nextAction: "复查诊断层级；修复仍需新建受控 Runtime 任务。",
    });
  }
  return rules.slice(0, 5);
}

function RuntimeAttentionItem({ onOpenCandidates, row }) {
  const hasCandidate = Boolean(row.summary.tasks.failed || row.summary.tasks.blocked);
  const content = (
    <>
      <div>
        <strong>{row.employee.name || row.summary.employeeId}</strong>
        <small>{row.summary.tasks.failed} 失败 · {row.summary.tasks.blocked} 阻断 · {row.summary.tasks.active} 处理中 · 最近 {formatTime(row.summary.lastRunAt)}</small>
      </div>
      <span className={`status-pill ${row.healthTone}`}>{hasCandidate ? `${row.healthLabel} · 查看候选` : row.healthLabel}</span>
      <p>{hasCandidate ? "点击进入该员工的异常候选，完成诊断后才能形成受控修复草案。" : row.summary.nextAction}</p>
    </>
  );

  if (!hasCandidate) return <div className="ops-runtime-attention-row">{content}</div>;
  return (
    <button
      className="ops-runtime-attention-row is-actionable"
      type="button"
      onClick={() => onOpenCandidates(row.summary.employeeId)}
      aria-label={`查看 ${row.employee.name || row.summary.employeeId} 的异常候选`}
    >
      {content}
    </button>
  );
}

function RuntimeOverview({
  summary,
  status,
  runtimeMetrics,
  runtimeTaskState,
  runtimePerformanceState,
  runtimeTaskPerformanceState,
  employees,
  candidateCount,
  incidentCount,
  policyRows,
  qualityEvents,
  runtimeAttentionRows,
  onOpenCandidates,
}) {
  const health = buildRuntimeHealth({ status: runtimeTaskState.status, observationMetrics: runtimeMetrics });
  const policyTotals = sumPolicySignals(policyRows);
  const p0p1Count = qualityEvents.filter(isHighSeverity).length;
  const alerts = buildRuntimeAlertRules({
    status: runtimeTaskState.status,
    observationMetrics: runtimeMetrics,
    candidateCount,
    incidentCount,
    policyRows,
    qualityEvents,
  });
  const eventSeries = (summary?.dailySeries || []).map((day) => ({ label: day.label, value: day.eventCount || 0 }));
  const runtimeCoverage = runtimeTaskState.data?.coverage;

  return (
    <>
      <section className={`panel ops-runtime-command is-${health.riskLevel}`}>
          <div className="panel-head">
            <div>
              <p className="eyebrow">Canonical Runtime</p>
              <h2>运行态指挥条</h2>
            </div>
            <span className={`status-pill ${runtimeTaskState.status === "error" ? "danger" : "info"}`}>{runtimeTaskState.status === "error" ? "Runtime 读取失败" : "真实任务聚合"}</span>
          </div>
          <div className="ops-runtime-command-body">
            <div className="ops-runtime-health">
              <OpsHealthDial score={health.score} label={health.label} riskLevel={health.riskLevel} />
              <small>只计算任务终态与任务聚合读取状态</small>
            </div>
            <dl className="ops-runtime-metrics">
              <div>
                <dt>任务</dt>
                <dd>{runtimeMetrics.tasks}</dd>
              </div>
              <div>
                <dt>失败 / 阻断</dt>
                <dd>{runtimeMetrics.failed} / {runtimeMetrics.blocked}</dd>
              </div>
              <div>
                <dt>处理中</dt>
                <dd>{runtimeMetrics.tasks - runtimeMetrics.succeeded - runtimeMetrics.failed - runtimeMetrics.blocked}</dd>
              </div>
              <div>
                <dt>候选 / 档案</dt>
                <dd>{candidateCount} / {incidentCount}</dd>
              </div>
            </dl>
            <div className="ops-runtime-usage">
              <span>辅助使用采集</span>
              <strong className={`is-${statusToneClass(collectionStatusTone(status, summary))}`}>{collectionStatusLabel(status, summary)}</strong>
              <small>{summary?.metrics?.events7d ?? 0} 条事件 · {summary?.metrics?.activeUsers7d ?? 0} 位活跃用户</small>
            </div>
          </div>
          <p className="ops-boundary-note">
            口径：{runtimeCoverage?.taskAuthority || "canonical_execution_task"} · 近 {runtimeCoverage?.windowDays || 7} 日 · 更新 {runtimeCoverage?.sourceAsOf ? formatTime(runtimeCoverage.sourceAsOf) : "读取中"}。
          </p>
      </section>

      <OpsTaskAnalyticsPanel employees={employees} />

      <section className="ops-performance-grid">
        <RuntimePerformancePanel state={runtimePerformanceState} />
        <RuntimeTaskPerformancePanel state={runtimeTaskPerformanceState} employees={employees} />
      </section>

      <section className="ops-runtime-workbench">
        <article className="panel ops-runtime-attention-panel">
          <div className="panel-head">
            <div>
              <p className="eyebrow">Priority queue</p>
              <h2>需处理的真实任务</h2>
            </div>
            <span className={`status-pill ${runtimeAttentionRows.length ? "warn" : "good"}`}>{runtimeAttentionRows.length || 0} 项</span>
          </div>
          <div className="ops-runtime-attention-list">
            {runtimeAttentionRows.length ? runtimeAttentionRows.map((row) => (
              <RuntimeAttentionItem key={row.summary.employeeId} row={row} onOpenCandidates={onOpenCandidates} />
            )) : <p className="business-system-empty">当前聚合窗口没有失败、阻断或仍在处理的 canonical Runtime 任务。</p>}
          </div>
        </article>

        <article className="panel ops-alert-panel">
          <div className="panel-head">
            <div>
              <p className="eyebrow">Alerts</p>
              <h2>运行与治理待办</h2>
            </div>
            <span className={`status-pill ${alerts.length ? "warn" : "good"}`}>{alerts.length || 0} 条</span>
          </div>
          <div className="ops-alert-list">
            {alerts.length ? alerts.map((rule) => (
              <article className="ops-alert-row" key={rule.id}>
                <span className="status-pill warn">{rule.severity}</span>
                <div><strong>{rule.title}</strong><small>{rule.signal}</small></div>
                <p>{rule.nextAction}</p>
              </article>
            )) : <p className="business-system-empty">当前真实 Runtime 与治理投影没有待办。</p>}
          </div>
        </article>
      </section>

      <section className="ops-runtime-secondary">
        <article className="panel ops-chart-panel">
          <div className="panel-head">
            <div>
              <p className="eyebrow">Usage telemetry</p>
              <h2>真实使用事件趋势</h2>
            </div>
            <Activity size={20} />
          </div>
          {eventSeries.length ? <MiniLineChart title="采集事件" series={eventSeries} suffix=" 条" /> : <p className="business-system-empty">等待后端返回真实使用事件。</p>}
        </article>

        <article className="panel ops-governance-context">
          <div className="panel-head">
            <div><p className="eyebrow">Governance context</p><h2>控制面辅助投影</h2></div>
            <span className="status-pill muted">不作为任务事实</span>
          </div>
          <div className="ops-governance-context-metrics">
            <span><b>{policyRows.length}</b> 条调用门禁</span>
            <span><b>{formatMetricNumber(policyTotals.callsToday, 0)}</b> 次今日调用</span>
            <span><b>{qualityEvents.length}</b> 条质量事件</span>
            <span><b>{p0p1Count}</b> 个 P0/P1</span>
          </div>
          <p>待接入：Provider Gateway SLA / TTFT、Worker Lease 队列与系统资源。未接入前不展示静态数值。</p>
        </article>
      </section>
    </>
  );
}

function RuntimePerformancePanel({ state }) {
  const data = state.data;
  const metrics = Array.isArray(data?.metrics) ? data.metrics : [];
  const cache = data?.cache;
  const hasSamples = metrics.some((metric) => metric.sampleCount > 0);
  return (
    <section className="panel">
      <div className="panel-head">
        <div>
          <p className="eyebrow">Performance observation</p>
          <h2>任务读取性能</h2>
        </div>
        <span className={`status-pill ${state.status === "error" ? "danger" : hasSamples ? "good" : "muted"}`}>
          {state.status === "error" ? "读取失败" : hasSamples ? "有数据" : "无数据"}
        </span>
      </div>
      {state.status === "error" ? <p className="business-system-empty">{state.error}</p> : null}
      {metrics.map((metric) => (
        <dl className="ops-runtime-metrics ops-performance-metrics" key={metric.metricId}>
          <div className="ops-metric-card is-blue"><dt>{metric.metricId === "digital_employee_runtime_task_list" ? "任务监控 API" : "目录解析"}</dt><dd>{metric.sampleCount}</dd><small>样本</small></div>
          <div className={`ops-metric-card ${metricTone(metric.p50Ms)}`}><dt>P50</dt><dd>{formatMetricDuration(metric.p50Ms)}</dd><small>典型耗时</small></div>
          <div className={`ops-metric-card ${metricTone(metric.p95Ms)}`}><dt>P95</dt><dd>{formatMetricDuration(metric.p95Ms)}</dd><small>高峰耗时</small></div>
          <div className={`ops-metric-card ${metricTone(metric.p99Ms)}`}><dt>P99</dt><dd>{formatMetricDuration(metric.p99Ms)}</dd><small>极端耗时</small></div>
          <div className={`ops-metric-card ${metric.errorCount > 0 ? "is-danger" : "is-good"}`}><dt>异常/超时</dt><dd>{metric.errorCount}</dd><small>{metric.errorCount > 0 ? "需关注" : "运行正常"}</small></div>
        </dl>
      ))}
      <p className="ops-boundary-note">
        {data?.coverage?.windowMinutes ? `近 ${data.coverage.windowMinutes} 分钟 · ${data.coverage.collection === "process_memory" ? "进程内" : "—"}` : "窗口 —"}
        {Number.isFinite(cache?.cacheHitRate) ? ` · 命中 ${formatPercent(cache.cacheHitRate)} · 外部解析 ${cache.externalResolutions || 0} · 持久化 ${cache.persistentSnapshotWrites || 0}` : ""}
        {" · 颜色：<5s 正常 · 5–30s 关注 · ≥30s 异常"}
      </p>
    </section>
  );
}

function RuntimeTaskPerformancePanel({ state, employees = [] }) {
  const data = state.data;
  const groups = Array.isArray(data?.groups) ? data.groups : [];
  const employeeNames = new Map((employees || []).map((employee) => [employee.id, employee.name || employee.id]));
  const terminalTaskCount = groups.reduce((total, group) => total + (group.terminalTaskCount || 0), 0);
  const activeTaskCount = groups.reduce((total, group) => total + (group.active?.taskCount || 0), 0);
  const outcomeLabels = [
    ["success", "成功"],
    ["executionFailure", "执行失败"],
    ["governance", "治理/未接收"],
  ];
  return (
    <section className="panel ops-task-performance-panel">
      <div className="panel-head">
        <div>
          <p className="eyebrow">Task processing</p>
          <h2>任务处理耗时</h2>
        </div>
        <span className={`status-pill ${state.status === "error" ? "danger" : terminalTaskCount || activeTaskCount ? "good" : "muted"}`}>
          {state.status === "error" ? "读取失败" : terminalTaskCount || activeTaskCount ? "有数据" : "无数据"}
        </span>
      </div>
      {state.status === "error" ? <p className="business-system-empty">{state.error}</p> : null}
      {!groups.length && state.status !== "error" ? (
        <dl className="ops-runtime-metrics ops-performance-metrics ops-task-empty-metrics">
          <div><dt>终态样本</dt><dd>0</dd></div>
          <div><dt>运行中</dt><dd>0</dd></div>
          <div><dt>P50</dt><dd>—</dd></div>
          <div><dt>P95</dt><dd>—</dd></div>
          <div><dt>P99</dt><dd>—</dd></div>
        </dl>
      ) : null}
      {groups.length ? (
        <div className="table-wrap">
          <table className="ops-task-performance-table">
            <thead>
              <tr>
                <th>数字员工 / 版本</th>
                <th>结果队列</th>
                <th>总历时 P50 / P95 / P99</th>
                <th>启动等待 P50 / P95 / P99</th>
                <th>执行阶段 P50 / P95 / P99</th>
                <th>运行中</th>
              </tr>
            </thead>
            <tbody>
              {groups.map((group) => (
                <tr key={`${group.employeeId}:${group.employeeVersion}`}>
                  <td>
                    <div className="table-user">
                      <strong>{employeeNames.get(group.employeeId) || "未命名数字员工"}</strong>
                      <small>{group.employeeVersion}</small>
                    </div>
                  </td>
                  <td>
                    <div className="ops-task-performance-outcomes">
                      {outcomeLabels.map(([key, label]) => (
                        <span className={`ops-outcome is-${key === "success" ? "success" : key === "executionFailure" ? "failed" : "blocked"}`} key={key}><i />{label} <b>{group.outcomes?.[key]?.taskCount || 0}</b></span>
                      ))}
                    </div>
                  </td>
                  <td>{formatOutcomeMetrics(group, "total")}</td>
                  <td>{formatOutcomeMetrics(group, "startupWait")}</td>
                  <td>{formatOutcomeMetrics(group, "executionPhase")}</td>
                  <td>
                    <div className="ops-table-number">
                      <strong>{group.active?.taskCount || 0}</strong>
                      <small>{formatDuration(group.active?.maxAgeMs)} 最长</small>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
      <p className="ops-boundary-note">
        {data?.coverage?.windowDays ? `近 ${data.coverage.windowDays} 日 · 终态 ${terminalTaskCount} · 运行中 ${activeTaskCount}` : "窗口 —"}
        {" · 颜色：<5s 正常 · 5–30s 关注 · ≥30s 异常"}
      </p>
    </section>
  );
}

function formatTaskPerformanceMetric(metric) {
  if (!metric?.sampleCount) return <><span className="ops-duration is-muted">— / — / —</span> · n={metric?.sampleCount || 0}</>;
  return (
    <>
      <span className={`ops-duration is-${durationTone(metric.p50Ms)}`}>{formatMetricDuration(metric.p50Ms)}</span>
      {" / "}
      <span className={`ops-duration is-${durationTone(metric.p95Ms)}`}>{formatMetricDuration(metric.p95Ms)}</span>
      {" / "}
      <span className={`ops-duration is-${durationTone(metric.p99Ms)}`}>{formatMetricDuration(metric.p99Ms)}</span>
      {" · n="}
      {metric.sampleCount}
    </>
  );
}

function formatMetricDuration(value) {
  return Number.isFinite(value) ? `${formatMetricNumber(value)} ms` : "—";
}

function formatOutcomeMetrics(group, metricKey) {
  return (
    <div className="ops-task-performance-metrics">
      {[
        ["success", "成功"],
        ["executionFailure", "执行失败"],
        ["governance", "治理"],
      ].map(([key, label]) => (
        <span key={key}><b>{label}</b> {formatTaskPerformanceMetric(group.outcomes?.[key]?.metrics?.[metricKey])}</span>
      ))}
    </div>
  );
}

export default function OpsMonitorView({ session, employees = digitalEmployees, invocationPolicies = [], qualityEvents = [] }) {
  const isSystemAdmin = isSystemAdminSession(session);
  const [summary, setSummary] = useState(null);
  const [status, setStatus] = useState("loading");
  const [error, setError] = useState("");
  const [incidentState, setIncidentState] = useState({ status: "loading", data: null, error: "" });
  const [candidateState, setCandidateState] = useState({ status: "loading", data: null, error: "" });
  const [runtimeTaskState, setRuntimeTaskState] = useState({ status: "loading", data: null, error: "" });
  const [runtimePerformanceState, setRuntimePerformanceState] = useState({ status: "loading", data: null, error: "" });
  const [runtimeTaskPerformanceState, setRuntimeTaskPerformanceState] = useState({ status: "loading", data: null, error: "" });
  const [backfillState, setBackfillState] = useState({ status: "idle", message: "" });
  const [evidenceDiagnosisState, setEvidenceDiagnosisState] = useState({ status: "idle", message: "" });
  const [scanState, setScanState] = useState({ status: "idle", message: "" });
  const [activeOpsSheet, setActiveOpsSheet] = useState("overview");
  const [candidateEmployeeFilter, setCandidateEmployeeFilter] = useState("");

  useEffect(() => {
    if (!isSystemAdmin) return undefined;
    let isMounted = true;
    setStatus("loading");
    setError("");
    fetchOpsUsageSummary({ days: 7 })
      .then((data) => {
        if (!isMounted) return;
        setSummary(data);
        setStatus("ready");
      })
      .catch((requestError) => {
        if (!isMounted) return;
        setStatus("error");
        setError(requestError?.message || "运维统计接口读取失败");
      });
    return () => {
      isMounted = false;
    };
  }, [isSystemAdmin]);

  useEffect(() => {
    if (!isSystemAdmin) return undefined;
    let isMounted = true;
    requestOpsRuntimeTaskSummary()
      .then((data) => { if (isMounted) setRuntimeTaskState({ status: "ready", data, error: "" }); })
      .catch((requestError) => { if (isMounted) setRuntimeTaskState({ status: "error", data: null, error: requestError?.message || "真实任务汇总读取失败" }); });
    requestOpsRuntimePerformanceSummary()
      .then((data) => { if (isMounted) setRuntimePerformanceState({ status: "ready", data, error: "" }); })
      .catch((requestError) => { if (isMounted) setRuntimePerformanceState({ status: "error", data: null, error: requestError?.message || "性能观测读取失败" }); });
    requestOpsRuntimeTaskPerformanceSummary()
      .then((data) => { if (isMounted) setRuntimeTaskPerformanceState({ status: "ready", data, error: "" }); })
      .catch((requestError) => { if (isMounted) setRuntimeTaskPerformanceState({ status: "error", data: null, error: requestError?.message || "任务耗时读取失败" }); });
    requestOpsIncidentCandidates()
      .then((data) => { if (isMounted) setCandidateState({ status: "ready", data, error: "" }); })
      .catch((requestError) => { if (isMounted) setCandidateState({ status: "error", data: null, error: requestError?.message || "异常候选读取失败" }); });
    return () => { isMounted = false; };
  }, [isSystemAdmin]);

  useEffect(() => {
    if (!isSystemAdmin) return undefined;
    let isMounted = true;
    requestOpsIncidents()
      .then((data) => {
        if (isMounted) setIncidentState({ status: "ready", data, error: "" });
      })
      .catch((requestError) => {
        if (isMounted) setIncidentState({ status: "error", data: null, error: requestError?.message || "异常档案读取失败" });
      });
    return () => { isMounted = false; };
  }, [isSystemAdmin]);

  const runtimeSummaries = Array.isArray(runtimeTaskState.data?.summaries) ? runtimeTaskState.data.summaries : [];
  const incidentCandidates = Array.isArray(candidateState.data?.candidates) ? candidateState.data.candidates : [];
  const observationRows = useMemo(
    () => buildObservationRows({ employees, invocationPolicies, qualityEvents, runtimeSummaries }),
    [employees, invocationPolicies, qualityEvents, runtimeSummaries],
  );
  const observationMetrics = useMemo(() => buildObservationMetrics(observationRows), [observationRows]);
  const runtimeObservationRows = useMemo(() => observationRows
    .filter((row) => row.summary.source === "canonical_execution_task" && row.summary.calls > 0)
    .map((row) => {
      const healthKey = runtimeHealthForRow(row.summary);
      const meta = trendMeta[healthKey] || trendMeta.stable;
      return {
        ...row,
        healthKey,
        healthLabel: meta.label,
        healthTone: meta.tone,
        issueRate: taskIssueRate(row.summary.tasks),
        summary: { ...row.summary, nextAction: runtimeNextAction(row.summary) },
      };
    }), [observationRows]);
  const runtimeObservationMetrics = useMemo(() => buildObservationMetrics(runtimeObservationRows), [runtimeObservationRows]);
  const runtimeAttentionRows = runtimeObservationRows.filter((row) => row.healthKey !== "stable").slice(0, 4);
  const policyRows = observationRows.filter((row) => row.policy).slice(0, 4);
  const employeeObservationSummary = `${runtimeObservationRows.length} 个员工 · ${runtimeObservationMetrics.tasks} 个任务 · ${runtimeObservationMetrics.issueCount} 失败/阻断`;
  const incidents = Array.isArray(incidentState.data?.incidents) ? incidentState.data.incidents : [];
  const opsSheets = [
    {
      id: "overview",
      icon: Activity,
      label: "运行总览",
      description: "运行态 / 调用门禁",
      detail: `${observationMetrics.intervention + observationMetrics.watch} 个待关注`,
    },
    {
      id: "employees",
      icon: UsersRound,
      label: "员工明细",
      description: "成功 / 失败 / 阻断",
      detail: employeeObservationSummary,
    },
    {
      id: "candidates",
      icon: AlertTriangle,
      label: "异常候选",
      description: "失败 / 超时 / 阻断",
      detail: candidateState.status === "loading" ? "读取中" : `${incidentCandidates.length} 条`,
    },
    {
      id: "incidents",
      icon: DatabaseZap,
      label: "问题档案",
      description: "已诊断 / 可复诊",
      detail: incidentState.status === "loading" ? "读取中" : `${incidents.length} 条`,
    },
    {
      id: "usage",
      icon: ChartColumnIncreasing,
      label: "平台使用",
      description: "DAU / 高频用户",
      detail: summary?.metrics ? `${summary.metrics.events7d} 条事件` : status === "loading" ? "读取中" : "真实事件",
    },
  ];
  const systems = summary?.systems || [];
  const hasEvents = Boolean(summary?.metrics?.events7d);

  if (!isSystemAdmin) return <AccessDenied />;

  return (
    <section className="view-stack ops-monitor">
      <section className="panel ops-monitor-header">
        <div className="panel-head">
          <div>
            <p className="eyebrow">Operations</p>
            <h2>运维监控台</h2>
          </div>
          <span className="status-pill info">管理员专属</span>
        </div>
        <div className="ops-monitor-context">
          <span className="status-pill good">canonical Runtime 优先</span>
          <small>{runtimeTaskState.data?.coverage?.windowDays ? `近 ${runtimeTaskState.data.coverage.windowDays} 日真实任务聚合` : "真实 Runtime 读取中"}</small>
          <small>{summary?.coverage?.updatedAt ? `使用采集更新 ${formatTime(summary.coverage.updatedAt)}` : "使用采集等待真实事件"}</small>
        </div>
        <div className="ops-sheet-options" role="tablist" aria-label="运维监控观察视图">
          {opsSheets.map((sheet) => {
            const SheetIcon = sheet.icon;
            const isActive = activeOpsSheet === sheet.id;
            return (
              <button
                className={isActive ? "ops-sheet-option is-active" : "ops-sheet-option"}
                type="button"
                role="tab"
                aria-selected={isActive}
                aria-controls={`ops-sheet-${sheet.id}`}
                id={`ops-sheet-tab-${sheet.id}`}
                key={sheet.id}
                onClick={() => setActiveOpsSheet(sheet.id)}
              >
                <SheetIcon size={18} aria-hidden="true" />
                <span>
                  <strong>{sheet.label}</strong>
                  <small>{sheet.description}</small>
                </span>
                <b>{sheet.detail}</b>
              </button>
            );
          })}
        </div>
      </section>

      <section
        className="ops-sheet-content"
        id={`ops-sheet-${activeOpsSheet}`}
        role="tabpanel"
        aria-labelledby={`ops-sheet-tab-${activeOpsSheet}`}
      >
        {activeOpsSheet === "overview" ? (
          <>
            <RuntimeOverview
              summary={summary}
              status={status}
              runtimeMetrics={runtimeObservationMetrics}
                runtimeTaskState={runtimeTaskState}
                runtimePerformanceState={runtimePerformanceState}
                runtimeTaskPerformanceState={runtimeTaskPerformanceState}
                employees={employees}
              candidateCount={incidentCandidates.length}
              incidentCount={incidents.length}
              policyRows={policyRows}
              qualityEvents={qualityEvents}
              runtimeAttentionRows={runtimeAttentionRows}
              onOpenCandidates={(employeeId) => {
                setCandidateEmployeeFilter(employeeId);
                setActiveOpsSheet("candidates");
              }}
            />

            <section className="panel ops-privacy-panel">
              <ShieldAlert size={19} />
              <span>{opsObservationBoundary}</span>
            </section>
          </>
        ) : null}

        {activeOpsSheet === "employees" ? (
          <section className="panel">
            <div className="panel-head">
              <div>
                <p className="eyebrow">Employees</p>
                <h2>AI 数字员工任务观测</h2>
              </div>
              <span className="status-pill muted">{employeeObservationSummary}</span>
            </div>
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>数字员工</th>
                    <th>Owner</th>
                    <th>任务数</th>
                    <th>任务结果</th>
                    <th>失败率</th>
                    <th>健康</th>
                    <th>最近运行</th>
                    <th>管理员动作</th>
                  </tr>
                </thead>
                <tbody>
                  {runtimeObservationRows.map((row) => (
                    <tr key={row.summary.employeeId}>
                      <td>
                        <div className="table-user">
                          <strong>{row.employee.name || row.summary.employeeId}</strong>
                          <small>{row.employee.level || "未分级"} · {row.employee.department || "未绑定部门"} · {row.employee.status || "未标注状态"}</small>
                        </div>
                      </td>
                      <td>{row.employee.owner || "未绑定"}</td>
                      <td>
                        <div className="ops-table-number">
                          <strong>{row.summary.calls}</strong>
                          <small>canonical Runtime · 近 7 日</small>
                        </div>
                      </td>
                      <td>
                        <TaskOutcomeBar tasks={row.summary.tasks} />
                        <small className="ops-task-text">
                          {row.summary.tasks.succeeded} 成功 / {row.summary.tasks.failed} 失败 / {row.summary.tasks.blocked} 阻断 / {row.summary.tasks.active} 进行中
                        </small>
                      </td>
                      <td>
                        <div className="ops-table-number">
                          <strong>{formatPercent(row.issueRate)}</strong>
                          <small>canonical Runtime 任务结果</small>
                        </div>
                      </td>
                      <td>
                        <div className="ops-table-number">
                          <span className={`status-pill ${row.healthTone}`}>{row.healthLabel}</span>
                          <small>按真实任务状态判定</small>
                        </div>
                      </td>
                      <td>{formatTime(row.summary.lastRunAt)}</td>
                      <td>{row.summary.nextAction}</td>
                    </tr>
                  ))}
                  {!runtimeObservationRows.length ? (
                    <tr><td colSpan="8"><p className="business-system-empty">近 7 日尚无可展示的 canonical Runtime 任务；不会用目录或治理样例补数。</p></td></tr>
                  ) : null}
                </tbody>
              </table>
            </div>
          </section>
        ) : null}

        {activeOpsSheet === "incidents" ? (
          <OpsIncidentArchive
            employees={employees}
            error={incidentState.error}
            incidents={incidents}
            isLoading={incidentState.status === "loading"}
            onOpenCandidates={() => setActiveOpsSheet("candidates")}
            onRequestDiagnosis={async (incident) => {
              const result = await requestOpsIncidentDiagnosisTask(incident.incidentId);
              const archive = await requestOpsIncidents();
              setIncidentState({ status: "ready", data: archive, error: "" });
              return result;
            }}
          />
        ) : null}

        {activeOpsSheet === "candidates" ? (
          <OpsIncidentCandidates
            candidates={incidentCandidates}
            coverage={candidateState.data?.coverage}
            employees={employees}
            error={candidateState.error}
            isLoading={candidateState.status === "loading"}
            backfillState={backfillState}
            evidenceDiagnosisState={evidenceDiagnosisState}
            scanState={scanState}
            selectedEmployeeId={candidateEmployeeFilter}
            onSelectedEmployeeIdChange={setCandidateEmployeeFilter}
            onBackfill={async () => {
              setBackfillState({ status: "submitting", message: "" });
              try {
                const result = await backfillOpsIncidentDiagnoses();
                const [archive, candidates] = await Promise.all([requestOpsIncidents(), requestOpsIncidentCandidates()]);
                setIncidentState({ status: "ready", data: archive, error: "" });
                setCandidateState({ status: "ready", data: candidates, error: "" });
                setBackfillState({ status: "success", message: `已补充 ${result.createdCount} 条诊断档案；可在“问题档案”查看。` });
              } catch (requestError) {
                setBackfillState({ status: "error", message: requestError?.message || "补档失败" });
              }
            }}
            onRuntimeEvidenceDiagnosis={async () => {
              setEvidenceDiagnosisState({ status: "submitting", message: "" });
              try {
                const result = await diagnoseOpsIncidentsWithRuntimeEvidence();
                const archive = await requestOpsIncidents();
                setIncidentState({ status: "ready", data: archive, error: "" });
                setEvidenceDiagnosisState({ status: "success", message: `已基于真实安全运行证据追加 ${result.createdCount} 条复诊版本；可在“问题档案”查看。` });
              } catch (requestError) {
                setEvidenceDiagnosisState({ status: "error", message: requestError?.message || "真实证据诊断失败" });
              }
            }}
            onRefresh={async () => {
              setScanState({ status: "submitting", message: "" });
              try {
                const [summaryResult, candidates, taskPerformance] = await Promise.all([
                  requestOpsRuntimeTaskSummary(),
                  requestOpsIncidentCandidates(),
                  requestOpsRuntimeTaskPerformanceSummary(),
                ]);
                setRuntimeTaskState({ status: "ready", data: summaryResult, error: "" });
                setRuntimeTaskPerformanceState({ status: "ready", data: taskPerformance, error: "" });
                setCandidateState({ status: "ready", data: candidates, error: "" });
                setScanState({ status: "success", message: `已按 ${candidates.coverage?.sourceAsOf ? formatTime(candidates.coverage.sourceAsOf) : "当前时间"} 完成真实 Runtime 手动巡检。` });
              } catch (requestError) {
                setScanState({ status: "error", message: requestError?.message || "手动巡检失败" });
              }
            }}
          />
        ) : null}

        {activeOpsSheet === "usage" ? (
          <>
            <section className="panel">
              <div className="panel-head">
                <div>
                  <p className="eyebrow">Usage</p>
                  <h2>平台真实使用统计</h2>
                </div>
                <span className="status-pill good">数字员工管理系统</span>
              </div>
              <p className="ops-boundary-note">
                统计口径：仅统计数字员工管理系统自身的脱敏使用事件，聚合 DAU 与高频用户；当前 MVP 文件存储不是生产审计库，生产需替换为服务端埋点、RBAC、审计日志和统计存储。HR 简历系统的业务运维看板应在 HR 简历系统内独立建设。
              </p>
            </section>

            {status === "error" ? <p className="business-system-empty">{error}</p> : null}
            {status === "loading" && !summary ? <p className="business-system-empty">正在读取真实使用统计...</p> : null}
            {summary && !hasEvents ? <EmptyUsageState summary={summary} /> : null}

            {summary?.systems?.length ? (
              <section className="ops-system-grid">
                {systems.map((system) => (
                  <article className="panel ops-system-card" key={system.id}>
                    <div className="panel-head">
                      <div>
                        <p className="eyebrow">{system.source === "subsystem" ? "Subsystem" : "Platform"}</p>
                        <h2>{system.name}</h2>
                      </div>
                      <span className={`status-pill ${systemStatusTone(system.status)}`}>{systemStatusLabel(system.status)}</span>
                    </div>
                    <dl className="ops-system-stats">
                      <div>
                        <dt>今日 DAU</dt>
                        <dd>{system.dauToday}</dd>
                      </div>
                      <div>
                        <dt>近 7 日活跃</dt>
                        <dd>{system.activeUsers7d}</dd>
                      </div>
                      <div>
                        <dt>近 7 日事件</dt>
                        <dd>{system.eventCount7d}</dd>
                      </div>
                      <div>
                        <dt>最近事件</dt>
                        <dd>{formatTime(system.lastEventAt)}</dd>
                      </div>
                    </dl>
                  </article>
                ))}
              </section>
            ) : null}

            {summary && hasEvents ? (
              <>
                <div className="metrics-grid">
                  <MetricCard label="今日 DAU" value={summary.metrics.dauToday} detail="按脱敏用户去重" />
                  <MetricCard label="昨日 DAU" value={summary.metrics.dauYesterday} detail="自然日口径" />
                  <MetricCard label="近 7 日活跃" value={summary.metrics.activeUsers7d} detail={`${summary.metrics.events7d} 条真实事件`} />
                  <MetricCard label="高频用户" value={summary.metrics.highFrequencyUsers} detail="近 7 日事件数 >= 3" />
                </div>

                <section className="panel">
                  <div className="panel-head">
                    <div>
                      <p className="eyebrow">Trend</p>
                      <h2>近 7 日 DAU 趋势</h2>
                    </div>
                    <ChartColumnIncreasing size={20} />
                  </div>
                  <DauTrendLineChart series={summary.dailySeries || []} />
                </section>

                <section className="panel">
                  <div className="panel-head">
                    <div>
                      <p className="eyebrow">Users</p>
                      <h2>近 7 日高频使用用户</h2>
                    </div>
                    <UsersRound size={20} />
                  </div>
                  {summary.topUsers?.length ? (
                    <div className="table-wrap">
                      <table>
                        <thead>
                          <tr>
                            <th>用户</th>
                            <th>部门</th>
                            <th>事件数</th>
                            <th>活跃天数</th>
                            <th>常用页面</th>
                            <th>最近活跃</th>
                          </tr>
                        </thead>
                        <tbody>
                          {summary.topUsers.map((user) => (
                            <tr key={user.userKey}>
                              <td>
                                <div className="table-user">
                                  <strong>{user.userLabel}</strong>
                                  <small>{user.userKey}</small>
                                </div>
                              </td>
                              <td>{user.departmentName || user.departmentId || "未映射"}</td>
                              <td>{user.eventCount}</td>
                              <td>{user.activeDays}</td>
                              <td>{viewLabels[user.topView] || user.topView || "暂无"}</td>
                              <td>{formatTime(user.lastActiveAt)}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  ) : (
                    <p className="business-system-empty">已有系统接入状态，但近 7 日还没有可展示的真实高频用户。</p>
                  )}
                </section>

                <section className="panel ops-privacy-panel">
                  <ShieldAlert size={19} />
                  <span>{summary.privacyBoundary}</span>
                </section>
              </>
            ) : null}
          </>
        ) : null}
      </section>
    </section>
  );
}

function OpsIncidentCandidates({
  backfillState,
  candidates,
  coverage,
  employees,
  error,
  evidenceDiagnosisState,
  isLoading,
  onBackfill,
  onRefresh,
  onRuntimeEvidenceDiagnosis,
  onSelectedEmployeeIdChange,
  scanState,
  selectedEmployeeId,
}) {
  const employeeNames = new Map((employees || []).map((employee) => [employee.id, employee.name || employee.id]));
  const employeeOptions = [...new Set(candidates.map((candidate) => candidate.employeeId))]
    .sort((left, right) => String(employeeNames.get(left) || left).localeCompare(String(employeeNames.get(right) || right)));
  const visibleCandidates = selectedEmployeeId
    ? candidates.filter((candidate) => candidate.employeeId === selectedEmployeeId)
    : candidates;
  const failureCount = visibleCandidates.filter((candidate) => candidate.category === "execution_failure").length;
  const governanceCount = visibleCandidates.filter((candidate) => candidate.category === "governance_signal").length;
  const isSubmitting = backfillState?.status === "submitting" || evidenceDiagnosisState?.status === "submitting" || scanState?.status === "submitting";
  return (
    <section className="panel ops-incident-panel">
      <div className="panel-head">
        <div>
          <p className="eyebrow">Triage Queue</p>
          <h2>异常候选</h2>
        </div>
        <div className="ops-archive-head-actions">
          <button className="ops-incident-backfill" type="button" disabled={isSubmitting || !candidates.length} onClick={onRuntimeEvidenceDiagnosis}>
            {evidenceDiagnosisState?.status === "submitting" ? "正在读取安全证据..." : "用真实运行证据复诊"}
          </button>
          <button type="button" disabled={isSubmitting || !candidates.length} onClick={onBackfill}>
            {backfillState?.status === "submitting" ? "正在补充诊断..." : "补充终态诊断档案"}
          </button>
          <button type="button" disabled={isSubmitting} onClick={onRefresh}>
            {scanState?.status === "submitting" ? "正在巡检..." : "刷新真实巡检"}
          </button>
        </div>
      </div>
      <div className="ops-incident-summary">
        <span><b>{failureCount}</b> 执行异常</span>
        <span><b>{governanceCount}</b> 治理阻断</span>
        <label className="ops-incident-filter">员工
          <select value={selectedEmployeeId} onChange={(event) => onSelectedEmployeeIdChange(event.target.value)}>
            <option value="">全部员工（{candidates.length}）</option>
            {employeeOptions.map((employeeId) => <option key={employeeId} value={employeeId}>{employeeNames.get(employeeId) || employeeId}</option>)}
          </select>
        </label>
        <small>{coverage?.mayBeTruncated ? `最新 ${coverage.sourceLimit} 条任务内的候选，当前窗口不完整。` : "L1 当前为手动真实巡检；定时巡检尚未启用。候选来自真实终态任务，诊断绝不读取任务正文。"}</small>
      </div>
      {error ? <p className="business-system-empty">{error}</p> : null}
      {backfillState?.message ? <p className={`ops-incident-feedback ${backfillState.status === "error" ? "is-error" : "is-success"}`}>{backfillState.message}</p> : null}
      {evidenceDiagnosisState?.message ? <p className={`ops-incident-feedback ${evidenceDiagnosisState.status === "error" ? "is-error" : "is-success"}`}>{evidenceDiagnosisState.message}</p> : null}
      {scanState?.message ? <p className={`ops-incident-feedback ${scanState.status === "error" ? "is-error" : "is-success"}`}>{scanState.message}</p> : null}
      {isLoading ? <p className="business-system-empty">正在读取真实异常任务...</p> : null}
      {!isLoading && !error && !candidates.length ? <p className="business-system-empty">近 7 日没有待补档的异常候选。</p> : null}
      {visibleCandidates.length ? (
        <div className="table-wrap">
          <table className="ops-incident-table">
            <thead><tr><th>级别</th><th>业务员工</th><th>任务状态</th><th>稳定错误码</th><th>发生时间</th><th>安全证据</th></tr></thead>
            <tbody>{visibleCandidates.map((candidate) => (
              <tr key={candidate.incidentId}>
                <td><span className={`status-pill ${candidate.severity === "P1" ? "bad" : "warn"}`}>{candidate.severity}</span></td>
                <td><div className="table-user"><strong>{employeeNames.get(candidate.employeeId) || candidate.employeeId}</strong><small>{candidate.employeeVersion}</small></div></td>
                <td><span className="status-pill muted">{candidate.taskStatus}</span></td>
                <td>{candidate.errorCode}</td>
                <td>{formatTime(candidate.occurredAt)}</td>
                <td><div className="ops-incident-copy"><span>{candidate.evidenceState === "available" ? candidate.evidenceSummary || "仅有状态和错误码" : "安全证据不足，补档时将显式记录。"}</span></div></td>
              </tr>
            ))}</tbody>
          </table>
        </div>
      ) : null}
      {!isLoading && !error && candidates.length && !visibleCandidates.length ? <p className="business-system-empty">该员工近 7 日没有异常候选。</p> : null}
    </section>
  );
}

function OpsIncidentArchive({ employees, error, incidents, isLoading, onOpenCandidates, onRequestDiagnosis }) {
  const [diagnosisFeedback, setDiagnosisFeedback] = useState("");
  const [selectedEmployeeId, setSelectedEmployeeId] = useState("");
  const employeeNames = new Map((employees || []).map((employee) => [employee.id, employee.name || employee.id]));
  const employeeOptions = [...new Set(incidents.map((incident) => incident.employeeId))]
    .sort((left, right) => String(employeeNames.get(left) || left).localeCompare(String(employeeNames.get(right) || right)));
  const visibleIncidents = selectedEmployeeId
    ? incidents.filter((incident) => incident.employeeId === selectedEmployeeId)
    : incidents;
  const failureCount = visibleIncidents.filter((incident) => incident.classification === "execution_failure").length;
  const governanceCount = visibleIncidents.filter((incident) => incident.classification === "governance_signal").length;
  return (
    <section className="panel ops-incident-panel">
      <div className="panel-head">
        <div>
          <p className="eyebrow">Incident Archive</p>
          <h2>问题档案</h2>
        </div>
        <div className="ops-archive-head-actions">
          <span className="status-pill muted">仅展示已完成诊断版本</span>
          <button type="button" onClick={onOpenCandidates}>前往异常候选</button>
        </div>
      </div>
      <div className="ops-incident-summary" aria-label="异常档案摘要">
        <span><b>{failureCount}</b> 失败/超时</span>
        <span><b>{governanceCount}</b> 治理阻断</span>
        <label className="ops-incident-filter">员工
          <select value={selectedEmployeeId} onChange={(event) => setSelectedEmployeeId(event.target.value)}>
            <option value="">全部员工（{incidents.length}）</option>
            {employeeOptions.map((employeeId) => <option key={employeeId} value={employeeId}>{employeeNames.get(employeeId) || employeeId}</option>)}
          </select>
        </label>
        <small>重新诊断会追加版本；原任务、终态证据和回执始终不可改写。</small>
      </div>
      {error ? <p className="business-system-empty">{error}</p> : null}
      {isLoading ? <p className="business-system-empty">正在读取历史异常任务...</p> : null}
      {!isLoading && !error && !incidents.length ? <p className="business-system-empty">暂无已完成诊断的问题档案，请先在异常候选中补充诊断。</p> : null}
      {diagnosisFeedback ? <p className="ops-incident-feedback is-success">{diagnosisFeedback}</p> : null}
      {visibleIncidents.length ? (
        <div className="table-wrap">
          <table className="ops-incident-table">
            <thead>
              <tr>
                <th>级别</th>
                <th>业务员工</th>
                <th>诊断结论</th>
                <th>发生时间</th>
                <th>证据</th>
                <th>修复草案</th>
              </tr>
            </thead>
            <tbody>
              {visibleIncidents.map((incident) => (
                <tr key={incident.incidentId}>
                  <td><span className={`status-pill ${incident.severity === "P1" ? "bad" : "warn"}`}>{incident.severity}</span></td>
                  <td>
                    <div className="table-user">
                      <strong>{employeeNames.get(incident.employeeId) || incident.employeeId}</strong>
                      <small>{incident.employeeVersion}</small>
                    </div>
                  </td>
                  <td>
                    <div className="ops-incident-copy">
                      <strong>{incident.rootCauseCategory}</strong>
                      <small>{incident.errorCode}</small>
                      <span>{incident.diagnosisSummary}</span>
                    </div>
                  </td>
                  <td>{formatTime(incident.occurredAt)}</td>
                  <td>{(() => {
                    const evidence = diagnosisEvidencePresentation(incident);
                    return <span className={`status-pill ops-diagnosis-state ${evidence.tone}`} title={evidence.detail}>{evidence.label}</span>;
                  })()}</td>
                  <td>
                    <div className="ops-incident-actions">
                      <span>{incident.repairDraftSummary}</span>
                      <div>
                        <small>v{incident.diagnosisVersion} · {incident.repairPlan ? `${incident.repairPlan.lifecycleState} / ${incident.repairPlan.riskTier}` : "待生成修复计划"}</small>
                        <div className="ops-incident-action-buttons">
                          <button type="button" onClick={async () => {
                            try {
                              const result = await onRequestDiagnosis(incident);
                              setDiagnosisFeedback(result.diagnosisTask.created ? "已触发运营员工诊断任务；档案将在任务完成后追加新版本。" : "运营员工诊断任务已存在，正在等待或执行中。");
                            } catch (requestError) {
                              setDiagnosisFeedback(requestError?.message || "触发运营员工诊断失败");
                            }
                          }}>触发运营员工诊断</button>
                          <button type="button" disabled title={incident.repairPlan?.decisionCode === "no_approved_repair_tool" ? "当前没有已批准的低风险修复 Tool；计划已保留，接入后会复用同一风险与回执链路。" : "后续将创建独立、受审批的 canonical 修复任务；当前不执行任何操作。"}>创建修复任务（待接入）</button>
                        </div>
                      </div>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
      {!isLoading && !error && incidents.length && !visibleIncidents.length ? <p className="business-system-empty">该员工暂无已完成诊断的问题档案。</p> : null}
    </section>
  );
}
