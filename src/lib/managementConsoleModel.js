import { isOpenStatus, qualityEventTitle } from "./consoleCatalog.js";

export const MAIN_SYSTEM_SOURCE_ID = "digital-workforce";
export const MAIN_SYSTEM_SOURCE_NAME = "数字员工管理系统";

function relatedToSystem(item, systemId) {
  return [item.sourceSystemId, item.targetSystemId, ...(item.allowedCallers || [])].includes(systemId);
}

export function buildBusinessSystemReviewGroups({
  subsystems = [],
  capabilityRequests = [],
  distributions = [],
  qualityEvents = [],
  invocationPolicies = [],
} = {}) {
  const systemIds = new Set(subsystems.map((item) => item.id).filter((id) => id && id !== MAIN_SYSTEM_SOURCE_ID));
  capabilityRequests.forEach((item) => {
    if (item.sourceSystemId && item.sourceSystemId !== MAIN_SYSTEM_SOURCE_ID) systemIds.add(item.sourceSystemId);
  });
  distributions.forEach((item) => {
    if (item.targetSystemId && item.targetSystemId !== MAIN_SYSTEM_SOURCE_ID) systemIds.add(item.targetSystemId);
  });
  qualityEvents.forEach((item) => {
    if (item.sourceSystemId && item.sourceSystemId !== MAIN_SYSTEM_SOURCE_ID) systemIds.add(item.sourceSystemId);
  });
  invocationPolicies.forEach((item) =>
    (item.allowedCallers || []).forEach((caller) => {
      if (caller && caller !== MAIN_SYSTEM_SOURCE_ID) systemIds.add(caller);
    }),
  );

  return Array.from(systemIds).map((systemId) => {
    const subsystem = subsystems.find((item) => item.id === systemId);
    return {
      id: systemId,
      subsystem,
      capabilityRequests: capabilityRequests.filter((item) => relatedToSystem(item, systemId)),
      distributions: distributions.filter((item) => relatedToSystem(item, systemId)),
      qualityEvents: qualityEvents.filter((item) => relatedToSystem(item, systemId)),
      invocationPolicies: invocationPolicies.filter((item) => relatedToSystem(item, systemId)),
    };
  });
}

export function includesAny(value, keywords) {
  const text = String(value || "");
  return keywords.some((keyword) => text.includes(keyword));
}

export function buildEntityNameById(items = []) {
  return new Map(
    items
      .filter((item) => item.id && item.name)
      .map((item) => [item.id, item.name]),
  );
}

export function buildAllQualityBadcases({ platformBadcases = [], qualityEvents = [], subsystems = [], entityNameById = new Map() } = {}) {
  const subsystemById = new Map(subsystems.map((subsystem) => [subsystem.id, subsystem]));
  return [
    ...platformBadcases.map((badcase) => normalizedPlatformBadcase(badcase, subsystemById)),
    ...qualityEvents.map((event) => normalizedQualityEvent(event, subsystemById, entityNameById)),
  ];
}

export function normalizedPlatformBadcase(badcase, subsystemById = new Map()) {
  if (badcase.sourceSystemId && badcase.sourceSystemId !== MAIN_SYSTEM_SOURCE_ID) {
    const subsystem = subsystemById.get(badcase.sourceSystemId);
    const sourceName = subsystem?.name || badcase.sourceSystemId;
    return {
      ...badcase,
      sourceType: "subsystem",
      sourceTypeLabel: "子系统",
      sourceSystemId: badcase.sourceSystemId,
      sourceName,
      sourceEventId: badcase.sourceEventId || badcase.id,
      eventType: badcase.eventType || "subsystem_badcase_archive",
      sourceSummary: badcase.sourceEventId || "子系统归档 badcase",
    };
  }
  return {
    ...badcase,
    sourceType: "platform",
    sourceTypeLabel: "主系统",
    sourceSystemId: MAIN_SYSTEM_SOURCE_ID,
    sourceName: MAIN_SYSTEM_SOURCE_NAME,
    sourceEventId: badcase.id,
    eventType: "platform_badcase",
    sourceSummary: "主系统质量库",
  };
}

export function normalizedQualityEvent(event, subsystemById = new Map(), entityNameById = new Map()) {
  const timeFields = qualityEventTimeFields(event);
  if (!event.sourceSystemId || event.sourceSystemId === MAIN_SYSTEM_SOURCE_ID || event.sourceType === "platform") {
    const entityName = event.entityName || entityNameById.get(event.entityId) || event.entityType || event.entityId;
    const issueName = qualityEventTitle({ ...event, entityName });
    const evalCandidate = Boolean(event.evalCandidate || event.qualityRoute?.evalCandidate);
    return {
      id: `QE-${event.id}`,
      qualityEventId: event.id,
      title: `${MAIN_SYSTEM_SOURCE_NAME}：${issueName}`,
      entityType: event.entityType,
      entityId: event.entityId,
      entityName,
      errorDomain: event.errorDomain,
      errorCode: event.errorCode,
      severity: event.severity,
      status: event.status,
      owner: event.owner || event.departmentId || MAIN_SYSTEM_SOURCE_NAME,
      promptVersion: event.promptVersion,
      entityVersion: event.entityVersion,
      rootCauseCategory: event.rootCauseCategory,
      resolutionAction: event.resolutionAction,
      evidenceSummary: event.evidenceSummary,
      expectedSummary: event.expectedSummary,
      actualSummary: event.actualSummary,
      sourceType: "platform",
      sourceTypeLabel: "主系统",
      sourceSystemId: MAIN_SYSTEM_SOURCE_ID,
      sourceName: MAIN_SYSTEM_SOURCE_NAME,
      sourceEventId: event.sourceEventId || event.id,
      eventType: event.eventType || "platform_quality_event",
      businessDomain: event.businessDomain,
      departmentId: event.departmentId,
      evalCandidate,
      qualityRoute: event.qualityRoute || null,
      sourceSummary: event.sourceEventId || "主系统质量事件",
      tags: event.tags || [],
      linkedExecutionId: event.linkedExecutionId,
      linkedReview: event.linkedReview,
      reviewTask: event.reviewTask || null,
      ...timeFields,
    };
  }
  return normalizedSubsystemBadcase(event, subsystemById, entityNameById);
}

export function normalizedSubsystemBadcase(event, subsystemById = new Map(), entityNameById = new Map()) {
  const timeFields = qualityEventTimeFields(event);
  const subsystem = subsystemById.get(event.sourceSystemId);
  const sourceName = subsystem?.name || event.sourceSystemId || "未登记子系统";
  const entityName = event.entityName || entityNameById.get(event.entityId) || event.entityType || event.entityId;
  const issueName = qualityEventTitle({ ...event, entityName });
  const evalCandidate = Boolean(event.evalCandidate || event.qualityRoute?.evalCandidate);
  return {
    id: `QE-${event.id}`,
    qualityEventId: event.id,
    title: `${sourceName} 回传：${issueName}`,
    entityType: event.entityType,
    entityId: event.entityId,
    entityName,
    errorDomain: event.errorDomain,
    errorCode: event.errorCode,
    severity: event.severity,
    status: event.status,
    owner: subsystem?.owner || event.departmentId,
    promptVersion: event.promptVersion,
    entityVersion: event.entityVersion,
    rootCauseCategory: event.rootCauseCategory,
    resolutionAction: event.resolutionAction,
    evidenceSummary: event.evidenceSummary,
    expectedSummary: event.expectedSummary,
    actualSummary: event.actualSummary,
    sourceType: "subsystem",
    sourceTypeLabel: "子系统",
    sourceSystemId: event.sourceSystemId,
    sourceName,
    sourceEventId: event.sourceEventId,
    eventType: event.eventType,
    businessDomain: event.businessDomain,
    departmentId: event.departmentId,
    evalCandidate,
    qualityRoute: event.qualityRoute || null,
    sourceSummary: event.sourceEventId,
    tags: event.tags || [],
    reviewTask: event.reviewTask || null,
    ...timeFields,
  };
}

function qualityEventTimeFields(event = {}) {
  return {
    occurredAt: event.occurredAt || event.eventAt || event.createdAt || event.submittedAt || "",
    reportedAt: event.reportedAt || event.submittedAt || event.updatedAt || event.createdAt || "",
    createdAt: event.createdAt || "",
    updatedAt: event.updatedAt || "",
  };
}

export function isEvaluationCandidate(badcase = {}) {
  return (
    ["P0", "P1"].includes(badcase.severity) ||
    isOpenStatus(badcase.status) ||
    badcase.evalCandidate === true ||
    badcase.qualityRoute?.evalCandidate === true
  );
}

export function evaluationDatasetCaseId(badcase = {}) {
  if (badcase.caseId) return badcase.caseId;
  return [
    "EVAL",
    badcase.sourceSystemId || MAIN_SYSTEM_SOURCE_ID,
    badcase.sourceEventId || badcase.id,
    badcase.entityId || badcase.entityName,
    badcase.errorCode || "QUALITY",
  ]
    .filter(Boolean)
    .join("::");
}

export function buildEvaluationDatasetRows(badcases = [], decisions = {}) {
  const decisionByCaseId = normalizeEvaluationDatasetDecisions(decisions);
  const candidateBadcases = badcases.filter(isEvaluationCandidate);
  const candidateCaseIds = new Set(candidateBadcases.map((badcase) => evaluationDatasetCaseId(badcase)));
  const archivedDecisionBadcases = Object.values(decisionByCaseId)
    .filter((decision) => decision.caseId && !candidateCaseIds.has(decision.caseId))
    .filter((decision) => decision.reviewStatus === "approved" || decision.evalStatus === "archived")
    .map(evaluationBadcaseFromDecision);
  return [...candidateBadcases, ...archivedDecisionBadcases].map((badcase) => {
    const caseId = evaluationDatasetCaseId(badcase);
    const decision = decisionByCaseId[caseId] || decisionByCaseId[badcase.id] || null;
    const qualityGate = evaluationQualityGate(badcase);
    const reviewStatus = decision?.reviewStatus || defaultEvaluationReviewStatus(badcase, qualityGate);
    const evalStatus = decision?.evalStatus || statusForEvaluationReview(reviewStatus);
    const lastRunStatus = decision?.lastRunStatus || badcase.lastRunStatus || "not_run";
    const occurredAt = decision?.occurredAt || caseOccurredAt(badcase);
    const reportedAt = decision?.reportedAt || caseReportedAt(badcase);
    return {
      id: caseId,
      caseId,
      badcase,
      qualityGate,
      reviewStatus,
      evalStatus,
      statusLabel: evaluationStatusLabel(reviewStatus, evalStatus),
      statusTone: evaluationStatusTone(reviewStatus, evalStatus, qualityGate),
      reviewNote: decision?.reviewNote || "",
      reviewer: decision?.reviewedBy || "",
      reviewedAt: decision?.reviewedAt || "",
      lastRunStatus,
      lastRunLabel: evaluationRunStatusLabel(lastRunStatus),
      lastRunTone: evaluationRunTone(lastRunStatus),
      lastRunId: decision?.lastRunId || badcase.lastRunId || "",
      lastRunSummary: decision?.lastRunSummary || badcase.lastRunSummary || "",
      lastRunAt: decision?.lastRunAt || badcase.lastRunAt || "",
      occurredAt,
      reportedAt,
      enteredAt: decision?.reviewStatus === "approved" ? decision.reviewedAt || "" : "",
    };
  });
}

function caseOccurredAt(badcase = {}) {
  return badcase.occurredAt || badcase.eventAt || badcase.createdAt || badcase.submittedAt || badcase.reportedAt || badcase.updatedAt || "";
}

function caseReportedAt(badcase = {}) {
  return badcase.reportedAt || badcase.submittedAt || badcase.updatedAt || badcase.createdAt || badcase.occurredAt || "";
}

function normalizeEvaluationDatasetDecisions(decisions = {}) {
  if (Array.isArray(decisions)) {
    return Object.fromEntries(decisions.filter((decision) => decision?.caseId).map((decision) => [decision.caseId, decision]));
  }
  return decisions || {};
}

function evaluationBadcaseFromDecision(decision = {}) {
  return {
    id: decision.badcaseId || decision.caseId,
    caseId: decision.caseId,
    title:
      decision.title ||
      `${decision.sourceName || MAIN_SYSTEM_SOURCE_NAME}：${decision.entityName || decision.errorCode || "测评样本"}`,
    entityType: decision.entityType,
    entityId: decision.entityId,
    entityName: decision.entityName,
    errorDomain: decision.errorDomain,
    errorCode: decision.errorCode,
    severity: decision.severity,
    status: decision.qualityStatus || "已关闭",
    owner: decision.owner,
    promptVersion: decision.promptVersion,
    entityVersion: decision.entityVersion,
    rootCauseCategory: decision.rootCauseCategory,
    resolutionAction: decision.resolutionAction,
    evidenceSummary: decision.evidenceSummary,
    expectedSummary: decision.expectedSummary,
    actualSummary: decision.actualSummary,
    occurredAt: decision.occurredAt,
    reportedAt: decision.reportedAt,
    createdAt: decision.createdAt,
    updatedAt: decision.updatedAt,
    sourceType: decision.sourceType || "platform",
    sourceTypeLabel: decision.sourceTypeLabel || "主系统",
    sourceSystemId: decision.sourceSystemId || MAIN_SYSTEM_SOURCE_ID,
    sourceName: decision.sourceName || MAIN_SYSTEM_SOURCE_NAME,
    sourceEventId: decision.sourceEventId || decision.badcaseId || decision.caseId,
    eventType: decision.eventType || "evaluation_dataset_archive",
    evalCandidate: true,
    qualityRoute: { evalCandidate: true },
    sourceSummary: decision.sourceEventId || decision.caseId,
    tags: [...(decision.tags || []), "evaluation-dataset-archive"],
  };
}

export function buildEvaluationDatasetSummary(rows = []) {
  const archived = rows.filter((row) => row.evalStatus === "archived").length;
  const pending = rows.filter((row) => row.reviewStatus === "pending").length;
  const rejected = rows.filter((row) => row.reviewStatus === "rejected").length;
  const open = rows.filter((row) => isOpenStatus(row.badcase.status)).length;
  const qualityReady = rows.filter((row) => row.qualityGate.passed === row.qualityGate.total).length;
  const needsCriteria = rows.length - qualityReady;
  const highRisk = rows.filter((row) => ["P0", "P1"].includes(row.badcase.severity)).length;
  const runStats = rows.reduce(
    (acc, row) => {
      acc[row.lastRunStatus] = (acc[row.lastRunStatus] || 0) + 1;
      return acc;
    },
    { passed: 0, failed: 0, needs_review: 0, error: 0, not_run: 0 },
  );
  const runTotal = rows.filter((row) => row.lastRunStatus !== "not_run").length;
  const passed = runStats.passed || 0;
  return {
    total: rows.length,
    archived,
    pending,
    rejected,
    open,
    closed: rows.length - open,
    qualityReady,
    needsCriteria,
    highRisk,
    runStats,
    runTotal,
    passRate: runTotal ? Math.round((passed / runTotal) * 100) : null,
  };
}

function evaluationQualityGate(badcase = {}) {
  const checks = [
    ["expectedSummary", "预期标准", badcase.expectedSummary],
    ["actualSummary", "实际表现", badcase.actualSummary],
    ["evidenceSummary", "安全证据", badcase.evidenceSummary],
    ["rootCauseCategory", "根因分类", badcase.rootCauseCategory],
    ["resolutionAction", "处理动作", badcase.resolutionAction],
    ["promptVersion", "版本追踪", badcase.promptVersion || badcase.entityVersion],
  ];
  const missing = checks.filter(([, , value]) => !value).map(([, label]) => label);
  return {
    total: checks.length,
    passed: checks.length - missing.length,
    missing,
  };
}

function defaultEvaluationReviewStatus(badcase, qualityGate) {
  if (isOpenStatus(badcase.status)) return "pending";
  if (qualityGate.passed < qualityGate.total) return "pending";
  return badcase.evalCandidate || badcase.qualityRoute?.evalCandidate ? "pending" : "pending";
}

function statusForEvaluationReview(reviewStatus) {
  if (reviewStatus === "approved") return "archived";
  if (reviewStatus === "rejected") return "candidate";
  return "ready";
}

function evaluationStatusLabel(reviewStatus, evalStatus) {
  if (reviewStatus === "approved" || evalStatus === "archived") return "已入测评集";
  if (reviewStatus === "rejected") return "暂缓入库";
  return "待确认入库";
}

function evaluationStatusTone(reviewStatus, evalStatus, qualityGate) {
  if (reviewStatus === "approved" || evalStatus === "archived") return "good";
  if (qualityGate.passed < qualityGate.total) return "warn";
  if (reviewStatus === "rejected") return "muted";
  return "info";
}

function evaluationRunStatusLabel(status) {
  return {
    not_run: "未运行",
    queued: "排队中",
    running: "运行中",
    passed: "通过",
    failed: "未通过",
    needs_review: "需复核",
    error: "异常",
    canceled: "已取消",
  }[status] || status || "未运行";
}

function evaluationRunTone(status) {
  if (status === "passed") return "good";
  if (["failed", "needs_review", "error"].includes(status)) return "warn";
  if (["queued", "running"].includes(status)) return "info";
  return "muted";
}

export function sourceMatchesQualityContext(badcase, sourceScope, subsystemId) {
  if (sourceScope === "platform") return badcase.sourceType === "platform";
  if (sourceScope !== "subsystem") return true;
  if (badcase.sourceType !== "subsystem") return false;
  return subsystemId === "all" || badcase.sourceSystemId === subsystemId;
}

export function searchableBadcaseText(badcase) {
  return [
    badcase.title,
    badcase.entityType,
    badcase.entityName,
    badcase.errorDomain,
    badcase.errorCode,
    badcase.severity,
    badcase.status,
    badcase.owner,
    badcase.promptVersion,
    badcase.rootCauseCategory,
    badcase.resolutionAction,
    badcase.evidenceSummary,
    badcase.expectedSummary,
    badcase.actualSummary,
    badcase.sourceTypeLabel,
    badcase.sourceSystemId,
    badcase.sourceName,
    badcase.sourceEventId,
    badcase.eventType,
    badcase.businessDomain,
    badcase.occurredAt,
    badcase.reportedAt,
    badcase.createdAt,
    badcase.updatedAt,
    ...(badcase.tags || []),
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
}

export function buildQualitySourceContext({ sourceScope, subsystemId, subsystems, allBadcases } = {}) {
  const platformCount = allBadcases.filter((item) => item.sourceType === "platform").length;
  const subsystemCount = allBadcases.filter((item) => item.sourceType === "subsystem").length;
  const subsystemOptions = subsystems.map((subsystem) => {
    const items = allBadcases.filter((item) => item.sourceType === "subsystem" && item.sourceSystemId === subsystem.id);
    return {
      id: subsystem.id,
      name: subsystem.name,
      status: subsystem.status,
      count: items.length,
      openCount: items.filter((item) => isOpenStatus(item.status)).length,
    };
  });
  const selectedSubsystem = subsystemOptions.find((option) => option.id === subsystemId);
  const selectedLabel =
    sourceScope === "platform"
      ? MAIN_SYSTEM_SOURCE_NAME
      : sourceScope === "subsystem"
        ? selectedSubsystem?.name || "全部子系统"
        : "全部来源";

  return {
    sourceScope,
    selectedSubsystemId: subsystemId,
    selectedLabel,
    subsystemOptions,
    counts: {
      all: allBadcases.length,
      platform: platformCount,
      subsystem: subsystemCount,
      selectedSubsystem: selectedSubsystem?.count || subsystemCount,
    },
  };
}

export function buildNavBadgeCounts({
  systemImportPipelines = [],
  capabilityRequests = [],
  distributionPlans = [],
  qualityEvents = [],
  allQualityBadcases = [],
  skillReviewPendingCount = 0,
  preReviewWorkers = [],
} = {}) {
  const businessSystemGroups = buildBusinessSystemReviewGroups({
    capabilityRequests,
    distributions: distributionPlans,
    qualityEvents,
    invocationPolicies: [],
  });
  const businessSystemIds = new Set(businessSystemGroups.map((system) => system.id));
  const isBusinessSystemRelated = (item) => Array.from(businessSystemIds).some((systemId) => relatedToSystem(item, systemId));

  return {
    systemImports: systemImportPipelines.filter((pipeline) => includesAny(pipeline.status, ["设计中", "API 对齐", "待"])).length,
    subsystemRequests:
      capabilityRequests.filter((request) => isBusinessSystemRelated(request) && includesAny(request.status, ["待", "预审核", "评审", "审核"])).length +
      distributionPlans.filter((plan) => isBusinessSystemRelated(plan) && includesAny(plan.status, ["待", "确认", "评审", "审核"])).length +
      qualityEvents.filter((event) => isBusinessSystemRelated(event) && includesAny(event.status, ["待", "复盘", "评审", "审核"])).length,
    qualityManagement: allQualityBadcases.filter((badcase) => isOpenStatus(badcase.status)).length,
    skillEmployeeReview: skillReviewPendingCount,
    evaluationReview: allQualityBadcases.filter(isEvaluationCandidate).length,
    systemWorkers: preReviewWorkers.filter((worker) => includesAny(worker.status, ["设计中", "规划", "待", "异常"])).length,
  };
}

export function buildQualityBadgeCount(navBadgeCounts = {}) {
  return (navBadgeCounts.qualityManagement || 0) + (navBadgeCounts.skillEmployeeReview || 0) + (navBadgeCounts.evaluationReview || 0);
}
