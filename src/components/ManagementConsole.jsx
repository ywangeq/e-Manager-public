import { useToolAssetCatalog } from "../lib/useToolAssetCatalog";
import {
  BrainCircuit,
  Building2,
  ChevronDown,
  CircleUserRound,
  DatabaseZap,
  GitPullRequestArrow,
  KeyRound,
  Layers3,
  LogOut,
  MonitorCog,
  Moon,
  Search,
  Server,
  Settings2,
  ShieldAlert,
  Sun,
  UsersRound,
  Workflow,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  badcaseRecords,
  basicSkills as catalogBasicSkills,
  businessSkills as catalogBusinessSkills,
  digitalEmployees,
  externalAuditRequests,
  preReviewWorkers,
  systemImportPipelines,
} from "../data/catalog";
import { attachCardSpotlight } from "../lib/cardSpotlight";
import { badcasesForEntity, displaySkillVersion, statusClass } from "../lib/consoleCatalog";
import { fetchControlPlaneState, postQualityReviewAction } from "../lib/controlPlane";
import { employeeChannels, digitalEmployeeFacets, digitalEmployeeLevelLabel } from "../lib/digitalEmployeeOverview";
import { applyDigitalEmployeeRuntimeConfig } from "../lib/digitalEmployeeModelBinding";
import { applyDigitalEmployeeLifecycle } from "../lib/digitalEmployeeLifecycle";
import {
  buildAllQualityBadcases,
  buildEntityNameById,
  buildNavBadgeCounts,
  buildQualityBadgeCount,
  buildQualitySourceContext,
  searchableBadcaseText,
  sourceMatchesQualityContext,
} from "../lib/managementConsoleModel";
import { recordOpsUsageEvent } from "../lib/opsUsage";
import {
  canViewSystemWorkerScheduling,
  hasControlPlaneManageAccess,
  hasControlPlaneReviewAccess,
  isSystemAdminSession,
} from "../lib/permissions";
import CapabilityAssetsView from "./capability-assets/CapabilityAssetsView";
import DigitalEmployeesView from "./DigitalEmployeesView";
import EnterpriseAssistant from "./EnterpriseAssistant";
import OpsMonitorView from "./OpsMonitorView";
import Overview from "./OverviewView";
import People from "./PeopleView";
import { EvaluationReview, QualityManagement, SkillEmployeeReview } from "./QualityViews";
import SubsystemRequestsView from "./SubsystemRequestsView";
import SystemImports from "./SystemImportsView";
import SystemManagement from "./SystemManagementView";
import SystemWorkersView from "./SystemWorkersView";
import RuntimeInfrastructureView from "./RuntimeInfrastructureView";
import TriggerManagementView from "./TriggerManagementView";

const views = [
  { id: "overview", label: "总览", icon: Building2 },
  { id: "people", label: "人员管理", icon: UsersRound },
  { id: "employees", label: "数字员工", icon: BrainCircuit },
  { id: "capabilityAssets", label: "能力资产", icon: Layers3 },
  { id: "systemImports", label: "系统接入", icon: DatabaseZap },
  { id: "subsystemRequests", label: "业务系统审核", icon: GitPullRequestArrow },
];

const adminViews = [
  { id: "opsMonitor", label: "运维监控", icon: MonitorCog },
  { id: "systemWorkers", label: "AI Worker 调度", icon: Settings2 },
  { id: "runtimeInfrastructure", label: "运行基础设施", icon: Server },
  { id: "triggerManagement", label: "Trigger 管理", icon: Workflow },
  { id: "systemManagement", label: "模型供应商与连接", icon: KeyRound },
];

const qualityViews = [
  { id: "qualityManagement", label: "质量管理" },
  { id: "skillEmployeeReview", label: "技能/员工评审" },
  { id: "evaluationReview", label: "测评审核" },
];

const viewLabels = new Map([...views, ...qualityViews, ...adminViews].map((view) => [view.id, view.label]));
const qualityViewIds = new Set(qualityViews.map((view) => view.id));
const adminViewIds = new Set(adminViews.map((view) => view.id));
const viewRoutes = {
  overview: "overview",
  people: "people",
  employees: "employees",
  capabilityAssets: "capability-assets",
  systemImports: "system-imports",
  subsystemRequests: "business-system-review",
  qualityManagement: "quality",
  skillEmployeeReview: "skill-employee-review",
  evaluationReview: "evaluation-review",
  opsMonitor: "ops-monitor",
  systemWorkers: "ai-workers",
  runtimeInfrastructure: "runtime-infrastructure",
  triggerManagement: "trigger-management",
  systemManagement: "api-keys",
};
const routeViews = {
  ...Object.fromEntries(Object.entries(viewRoutes).map(([viewId, route]) => [route, viewId])),
  "basic-skills": "capabilityAssets",
  "business-skills": "capabilityAssets",
  "enterprise-tools": "capabilityAssets",
  "subsystem-requests": "subsystemRequests",
};

const capabilityAssetSheetRoutes = {
  tools: "tools",
  enterpriseSkills: "enterprise-skills",
  businessSkills: "business-skills",
};

const legacyCapabilityAssetSheets = {
  "basic-skills": "enterpriseSkills",
  "business-skills": "businessSkills",
  "enterprise-tools": "tools",
};

const entityNameById = buildEntityNameById([
  ...digitalEmployees,
  ...catalogBasicSkills,
  ...catalogBusinessSkills,
  ...systemImportPipelines,
]);

function routeFromHash(hash) {
  return String(hash || "").replace(/^#\/?/, "");
}

function routeBaseFromHash(hash) {
  return routeFromHash(hash).split("/")[0] || "";
}

function capabilityAssetSheetFromHash(hash, isSystemAdmin = true) {
  const route = routeFromHash(hash);
  const [base, sheetRoute] = route.split("/");
  const legacySheet = legacyCapabilityAssetSheets[base];
  const sheet = legacySheet || Object.entries(capabilityAssetSheetRoutes).find(([, value]) => value === sheetRoute)?.[0];
  if (sheet === "tools" && !isSystemAdmin) return "enterpriseSkills";
  return sheet || (isSystemAdmin ? "tools" : "enterpriseSkills");
}

function capabilityAssetSheetFromView(viewId, isSystemAdmin = true) {
  if (viewId === "enterpriseTools") return isSystemAdmin ? "tools" : "enterpriseSkills";
  if (viewId === "basicSkills") return "enterpriseSkills";
  if (viewId === "businessSkills") return "businessSkills";
  return "";
}

function capabilityAssetHash(sheetId) {
  return `#${viewRoutes.capabilityAssets}/${capabilityAssetSheetRoutes[sheetId] || capabilityAssetSheetRoutes.tools}`;
}

function employeeIdFromHash(hash) {
  const route = routeFromHash(hash);
  if (!route.startsWith("employees/")) return "";
  try {
    return decodeURIComponent(route.slice("employees/".length)).trim();
  } catch {
    return "";
  }
}

function NavBadge({ count }) {
  if (!count) return null;
  const label = count > 99 ? "99+" : String(count);
  return (
    <span className="nav-badge" aria-label={`${count} 条待处理`} title={`${count} 条待处理`}>
      {label}
    </span>
  );
}

function adminAuthorizationLabel(session, isSystemAdmin) {
  if (!isSystemAdmin) return "未获得系统管理员权限";
  if (session.governanceAssignment?.source === "personnel-governance-mvp") return "管理员来源：人员治理分配";
  if (session.adminResolution?.matchedField) return `管理员来源：Fortress ${session.adminResolution.matchedField} allowlist`;
  return "管理员来源：系统权限投影";
}

function viewFromHash(hash, { isSystemAdmin, canViewBusinessSystemReview, canViewSystemWorkers }) {
  const route = routeBaseFromHash(hash);
  const viewId = routeViews[route] || "overview";
  if (viewId === "subsystemRequests" && !canViewBusinessSystemReview) return "overview";
  if (viewId === "systemWorkers" && !canViewSystemWorkers) return "overview";
  return adminViewIds.has(viewId) && viewId !== "systemWorkers" && !isSystemAdmin ? "overview" : viewId;
}

export default function ManagementConsole({ session, onLogout }) {
  const toolCatalog = useToolAssetCatalog();
  const isSystemAdmin = isSystemAdminSession(session);
  const canViewSystemWorkers = canViewSystemWorkerScheduling(session);
  const canViewBusinessSystemReview = hasControlPlaneReviewAccess(session);
  const canManageControlPlane = hasControlPlaneManageAccess(session);
  const [activeView, setActiveViewState] = useState(() =>
    typeof window === "undefined"
      ? "overview"
      : viewFromHash(window.location.hash, { isSystemAdmin, canViewBusinessSystemReview, canViewSystemWorkers }),
  );
  const [activeAssetSheet, setActiveAssetSheet] = useState(() =>
    typeof window === "undefined" ? (isSystemAdmin ? "tools" : "enterpriseSkills") : capabilityAssetSheetFromHash(window.location.hash, isSystemAdmin),
  );
  const [routeHash, setRouteHash] = useState(() => (typeof window === "undefined" ? "#overview" : window.location.hash || "#overview"));
  const [theme, setTheme] = useState("light");
  const [query, setQuery] = useState("");
  const [qualitySourceScope, setQualitySourceScope] = useState("all");
  const [qualitySubsystemId, setQualitySubsystemId] = useState("all");
  const [controlPlaneState, setControlPlaneState] = useState({
    subsystems: [],
    capabilityRequests: [],
    distributions: [],
    qualityEvents: [],
    invocationPolicies: [],
    status: "loading",
    error: "",
  });
  const [skillReviewSummary, setSkillReviewSummary] = useState({
    pendingCount: 0,
    pendingEmployeeCount: 0,
    publicationCount: 0,
    qualityEvents: [],
    status: "loading",
  });
  const [digitalEmployeeCatalog, setDigitalEmployeeCatalog] = useState(digitalEmployees);
  const [basicSkillCatalog, setBasicSkillCatalog] = useState(catalogBasicSkills);
  const [businessSkillCatalog, setBusinessSkillCatalog] = useState(catalogBusinessSkills);
  const [runtimeEvidenceByEmployeeId, setRuntimeEvidenceByEmployeeId] = useState({});
  const consoleShellRef = useRef(null);
  const normalizedQuery = query.trim().toLowerCase();
  const isQualitySectionOpen = qualityViewIds.has(activeView);
  const adminStatusLabel = adminAuthorizationLabel(session, isSystemAdmin);
  const subsystemRegistry = controlPlaneState.subsystems;
  const capabilityRequests = controlPlaneState.capabilityRequests;
  const distributionPlans = controlPlaneState.distributions;
  const skillReviewQualityEvents = skillReviewSummary.status === "ready" ? skillReviewSummary.qualityEvents || [] : [];
  const qualityEvents = useMemo(
    () => [...controlPlaneState.qualityEvents, ...skillReviewQualityEvents],
    [controlPlaneState.qualityEvents, skillReviewQualityEvents],
  );
  const invocationPolicies = controlPlaneState.invocationPolicies;
  const allQualityBadcases = useMemo(() => {
    return buildAllQualityBadcases({
      platformBadcases: badcaseRecords,
      qualityEvents,
      subsystems: subsystemRegistry,
      entityNameById,
    });
  }, [qualityEvents, subsystemRegistry]);
  const qualitySourceContext = useMemo(
    () =>
      buildQualitySourceContext({
        sourceScope: qualitySourceScope,
        subsystemId: qualitySubsystemId,
        subsystems: subsystemRegistry,
        allBadcases: allQualityBadcases,
      }),
    [allQualityBadcases, qualitySourceScope, qualitySubsystemId],
  );
  const skillReviewPendingCount = skillReviewSummary.status === "ready" ? skillReviewSummary.pendingCount : 0;
  const employeeReviewPendingCount = skillReviewSummary.status === "ready"
    ? skillReviewSummary.pendingEmployeeCount
    : 0;
  const navBadgeCounts = buildNavBadgeCounts({
    systemImportPipelines,
    capabilityRequests,
    distributionPlans,
    qualityEvents,
    allQualityBadcases,
    skillReviewPendingCount: skillReviewPendingCount + employeeReviewPendingCount,
    preReviewWorkers,
  });
  const visibleAdminViews = adminViews.filter((view) => isSystemAdmin || (view.id === "systemWorkers" && canViewSystemWorkers));
  const qualityBadgeCount = buildQualityBadgeCount(navBadgeCounts);

  const navigateToView = useCallback(
    (viewId) => {
      const requestedAssetSheet = capabilityAssetSheetFromView(viewId, isSystemAdmin);
      const targetViewId = requestedAssetSheet ? "capabilityAssets" : viewId;
      const blockedBusinessReview = targetViewId === "subsystemRequests" && !canViewBusinessSystemReview;
      const blockedAdminView = adminViewIds.has(targetViewId) && targetViewId !== "systemWorkers" && !isSystemAdmin;
      const blockedWorkerView = targetViewId === "systemWorkers" && !canViewSystemWorkers;
      const nextView = blockedAdminView || blockedWorkerView || blockedBusinessReview ? "overview" : targetViewId;
      setActiveViewState(nextView);
      if (typeof window === "undefined") return;
      const nextAssetSheet = requestedAssetSheet || (activeAssetSheet === "tools" && !isSystemAdmin ? "enterpriseSkills" : activeAssetSheet);
      const nextHash = nextView === "capabilityAssets"
        ? capabilityAssetHash(nextAssetSheet || (isSystemAdmin ? "tools" : "enterpriseSkills"))
        : `#${viewRoutes[nextView] || viewRoutes.overview}`;
      if (nextView === "capabilityAssets") setActiveAssetSheet(capabilityAssetSheetFromHash(nextHash, isSystemAdmin));
      if (window.location.hash !== nextHash) {
        window.location.hash = nextHash;
      }
    },
    [activeAssetSheet, canViewBusinessSystemReview, canViewSystemWorkers, isSystemAdmin],
  );
  const navigateToAssetSheet = useCallback((sheetId) => {
    const nextSheet = sheetId === "tools" && !isSystemAdmin ? "enterpriseSkills" : sheetId;
    setActiveAssetSheet(nextSheet);
    setActiveViewState("capabilityAssets");
    if (typeof window === "undefined") return;
    const nextHash = capabilityAssetHash(nextSheet);
    if (window.location.hash !== nextHash) {
      window.location.hash = nextHash;
    }
  }, [isSystemAdmin]);
  const navigateToEmployee = useCallback((employeeId) => {
    if (typeof window === "undefined" || !employeeId) return;
    const nextHash = `#${viewRoutes.employees}/${encodeURIComponent(employeeId)}`;
    if (window.location.hash !== nextHash) {
      window.location.hash = nextHash;
    } else {
      setRouteHash(nextHash);
      setActiveViewState("employees");
    }
  }, []);
  const handleRuntimeVerified = useCallback((evidence = {}) => {
    const employeeId = String(evidence.employeeId || "").trim();
    if (!employeeId) return;
    setRuntimeEvidenceByEmployeeId((current) => ({
      ...current,
      [employeeId]: {
        ...(current[employeeId] || {}),
        ...evidence,
      },
    }));
  }, []);

  const updateSkillReviewSummary = useCallback((queue = {}) => {
    const pendingDrafts = Array.isArray(queue.pendingDrafts) ? queue.pendingDrafts : [];
    const pendingEmployeeDrafts = Array.isArray(queue.pendingEmployeeDrafts) ? queue.pendingEmployeeDrafts : [];
    const publications = Array.isArray(queue.publications) ? queue.publications : [];
    setSkillReviewSummary({
      pendingCount: pendingDrafts.filter((draft) => draft.status === "待技能评审").length,
      pendingEmployeeCount: pendingEmployeeDrafts.filter((draft) => draft.status === "待人员审批").length,
      publicationCount: publications.length,
      qualityEvents: Array.isArray(queue.qualityEvents) ? queue.qualityEvents : [],
      status: "ready",
    });
  }, []);

  const refreshSkillReviewSummary = useCallback(async () => {
    setSkillReviewSummary((current) => ({ ...current, status: "loading" }));
    try {
      const response = await fetch("/api/quality-reviews/skill-employee", { credentials: "include" });
      const data = await response.json().catch(() => ({}));
      if (!response.ok || !data.ok) throw new Error(data.error || "待技能评审队列读取失败");
      updateSkillReviewSummary(data);
    } catch {
      setSkillReviewSummary((current) => ({ ...current, status: "error" }));
    }
  }, [updateSkillReviewSummary]);

  const refreshDigitalEmployeeCatalog = useCallback(async () => {
    try {
      const response = await fetch("/api/digital-employees", { credentials: "include" });
      const data = await response.json().catch(() => ({}));
      if (!response.ok || !data.ok) throw new Error(data.error || "数字员工目录读取失败");
      setDigitalEmployeeCatalog(Array.isArray(data.digitalEmployees) ? data.digitalEmployees : digitalEmployees);
    } catch {
      setDigitalEmployeeCatalog(digitalEmployees);
    }
  }, []);

  const refreshBasicSkillCatalog = useCallback(async () => {
    try {
      const response = await fetch("/api/basic-skills", { credentials: "include" });
      const data = await response.json().catch(() => ({}));
      if (!response.ok || !data.ok) throw new Error(data.error || "企业技能目录读取失败");
      setBasicSkillCatalog(Array.isArray(data.basicSkills) ? data.basicSkills : catalogBasicSkills);
    } catch {
      setBasicSkillCatalog(catalogBasicSkills);
    }
  }, []);

  const applyModelBinding = useCallback(async (employeeId, binding) => {
    const result = await applyDigitalEmployeeRuntimeConfig(employeeId, binding);
    if (result.status === "applied" && result.digitalEmployee) {
      setDigitalEmployeeCatalog((current) => current.map((item) => (item.id === employeeId ? result.digitalEmployee : item)));
    }
    return result;
  }, []);

  const applyEmployeeLifecycle = useCallback(async (employeeId, enabled) => {
    const employee = await applyDigitalEmployeeLifecycle(employeeId, enabled);
    setDigitalEmployeeCatalog((current) => current.map((item) => (item.id === employeeId ? employee : item)));
    return employee;
  }, []);

  const refreshBusinessSkillCatalog = useCallback(async () => {
    try {
      const response = await fetch("/api/business-skills", { credentials: "include" });
      const data = await response.json().catch(() => ({}));
      if (!response.ok || !data.ok) throw new Error(data.error || "专项业务技能目录读取失败");
      setBusinessSkillCatalog(Array.isArray(data.businessSkills) ? data.businessSkills : catalogBusinessSkills);
    } catch {
      setBusinessSkillCatalog(catalogBusinessSkills);
    }
  }, []);

  const refreshControlPlaneState = useCallback(async () => {
    setControlPlaneState((current) => ({ ...current, status: "loading", error: "" }));
    try {
      const data = await fetchControlPlaneState();
      setControlPlaneState({
        ...data,
        status: "ready",
        error: "",
      });
    } catch (error) {
      setControlPlaneState((current) => ({
        ...current,
        status: "error",
        error: error?.message || "控制面接口读取失败",
      }));
    }
  }, []);

  const handleQualityReviewAction = useCallback(async (badcase, payload) => {
    const eventId = badcase.qualityEventId || String(badcase.id || "").replace(/^QE-/, "");
    if (!eventId) throw new Error("quality_event_id_required");
    const result = await postQualityReviewAction(eventId, payload);
    await refreshControlPlaneState();
    return result;
  }, [refreshControlPlaneState]);

  useEffect(() => {
    return attachCardSpotlight(consoleShellRef.current);
  }, []);

  useEffect(() => {
    refreshSkillReviewSummary();
  }, [refreshSkillReviewSummary]);

  useEffect(() => {
    refreshDigitalEmployeeCatalog();
  }, [refreshDigitalEmployeeCatalog]);

  useEffect(() => {
    refreshBasicSkillCatalog();
  }, [refreshBasicSkillCatalog]);

  useEffect(() => {
    refreshBusinessSkillCatalog();
  }, [refreshBusinessSkillCatalog]);

  useEffect(() => {
    refreshControlPlaneState();
  }, [refreshControlPlaneState]);

  useEffect(() => {
    function syncViewFromHash() {
      const nextHash = window.location.hash || "#overview";
      const nextView = viewFromHash(nextHash, { isSystemAdmin, canViewBusinessSystemReview, canViewSystemWorkers });
      setRouteHash(nextHash);
      setActiveViewState(nextView);
      if (nextView === "capabilityAssets") {
        setActiveAssetSheet(capabilityAssetSheetFromHash(nextHash, isSystemAdmin));
      }
    }

    window.addEventListener("hashchange", syncViewFromHash);
    syncViewFromHash();
    return () => window.removeEventListener("hashchange", syncViewFromHash);
  }, [canViewBusinessSystemReview, canViewSystemWorkers, isSystemAdmin]);

  const selectedDigitalEmployeeId = activeView === "employees" ? employeeIdFromHash(routeHash) : "";

  const filteredEmployees = useMemo(() => {
    if (!normalizedQuery) return digitalEmployeeCatalog;
    return digitalEmployeeCatalog.filter((employee) => {
      const facets = digitalEmployeeFacets(employee, businessSkillCatalog);
      return [
        employee.name,
        employee.title,
        employee.department,
        employee.owner,
        employee.status,
        employee.version,
        employee.level,
        digitalEmployeeLevelLabel(employee),
        employee.ownerDepartmentId,
        employee.ownerUserId,
        employee.permissionScope,
        employee.permissionSummary,
        employee.businessDomain,
        employee.capabilityLine,
        employee.skillCluster,
        employee.modelBinding?.model,
        employee.modelBinding?.modelLevelId,
        employee.runtimeBinding?.runtimeAdapter,
        employee.runtimeBinding?.workerLane,
        employee.promptVersion,
        employee.quality?.rootCauseFocus,
        ...employeeChannels(employee),
        ...(facets.tags || []),
        ...(employee.apiEndpoints || []),
        ...(employee.sourceTargets || []),
        ...(employee.constraints || []),
      ]
        .join(" ")
        .toLowerCase()
        .includes(normalizedQuery);
    });
  }, [businessSkillCatalog, digitalEmployeeCatalog, normalizedQuery]);

  const enterpriseAssistantEmployee = useMemo(
    () => digitalEmployeeCatalog.find((employee) => employee.id === "enterprise-ai-copilot") || null,
    [digitalEmployeeCatalog],
  );

  const filteredBasicSkills = useMemo(() => {
    if (!normalizedQuery) return basicSkillCatalog;
    return basicSkillCatalog.filter((skill) =>
      [
        skill.name,
        skill.category,
        skill.owner,
        skill.status,
        skill.description,
        displaySkillVersion(skill),
        skill.promptVersion,
        skill.rootCauseFocus,
        ...(skill.constraints || []),
      ]
        .join(" ")
        .toLowerCase()
        .includes(normalizedQuery),
    );
  }, [basicSkillCatalog, normalizedQuery]);

  const filteredBusinessSkills = useMemo(() => {
    if (!normalizedQuery) return businessSkillCatalog;
    return businessSkillCatalog.filter((skill) =>
      [
        skill.name,
        skill.domain,
        skill.department,
        skill.status,
        skill.reviewGate,
        skill.description,
        displaySkillVersion(skill),
        skill.promptVersion,
        skill.rootCauseFocus,
        ...(skill.constraints || []),
      ]
        .join(" ")
        .toLowerCase()
        .includes(normalizedQuery),
    );
  }, [businessSkillCatalog, normalizedQuery]);

  const filteredBadcases = useMemo(() => {
    const queryMatched = normalizedQuery
      ? allQualityBadcases.filter((badcase) => searchableBadcaseText(badcase).includes(normalizedQuery))
      : allQualityBadcases;
    return queryMatched.filter((badcase) => sourceMatchesQualityContext(badcase, qualitySourceScope, qualitySubsystemId));
  }, [allQualityBadcases, normalizedQuery, qualitySourceScope, qualitySubsystemId]);

  const filteredExternalAuditRequests = useMemo(() => {
    if (!normalizedQuery) return externalAuditRequests;
    return externalAuditRequests.filter((request) =>
      [
        request.title,
        request.requester,
        request.requestType,
        request.targetEntity,
        request.targetVersion,
        request.status,
        request.risk,
        request.auditorEmployee,
        request.checkResult,
        request.checkSummary,
        request.reviewer,
        request.gate,
        request.preReview?.workerId,
        request.preReview?.lane,
        request.preReview?.triggerMode,
        request.preReview?.triggerSource,
        request.preReview?.executionId,
        request.preReview?.provider,
        request.preReview?.providerCredentialId,
        request.preReview?.leaseRef,
        request.preReview?.codexConfig?.model,
        request.preReview?.codexConfig?.reasoningEffort,
        request.preReview?.recommendedDecision,
        request.preReview?.queueNote,
        ...(request.tags || []),
        ...(request.findings || []),
      ]
        .join(" ")
        .toLowerCase()
        .includes(normalizedQuery),
    );
  }, [normalizedQuery]);

  const filteredSystemImportPipelines = useMemo(() => {
    if (!normalizedQuery) return systemImportPipelines;
    return systemImportPipelines.filter((pipeline) =>
      [
        pipeline.name,
        pipeline.source,
        pipeline.target,
        pipeline.status,
        pipeline.apiEndpoint,
        pipeline.reviewGate,
        pipeline.output,
        ...(pipeline.constraints || []),
      ]
        .join(" ")
        .toLowerCase()
        .includes(normalizedQuery),
    );
  }, [normalizedQuery]);

  const filteredSubsystems = useMemo(() => {
    if (!normalizedQuery) return subsystemRegistry;
    return subsystemRegistry.filter((subsystem) =>
      [
        subsystem.id,
        subsystem.name,
        subsystem.departmentId,
        subsystem.businessDomain,
        subsystem.baseUrl,
        subsystem.status,
        subsystem.owner,
        subsystem.summaryEndpoint,
        subsystem.privacyBoundary,
        ...(subsystem.supportedContracts || []),
      ]
        .join(" ")
        .toLowerCase()
        .includes(normalizedQuery),
    );
  }, [normalizedQuery, subsystemRegistry]);

  const filteredCapabilityRequests = useMemo(() => {
    if (!normalizedQuery) return capabilityRequests;
    return capabilityRequests.filter((request) =>
      [
        request.id,
        request.sourceSystemId,
        request.sourceRequestId,
        request.requestType,
        request.departmentId,
        request.businessDomain,
        request.requester,
        request.status,
        request.risk,
        request.capabilityName,
        request.capabilityKind,
        request.targetEmployeeId,
        request.targetEmployeeName,
        request.safeSummary,
        request.reviewGate,
        ...(request.requestedCapabilities || []),
        ...(request.candidateTargetEmployees || []),
        ...(request.candidateTargetSkills || []),
        ...(request.warnings || []),
      ]
        .join(" ")
        .toLowerCase()
        .includes(normalizedQuery),
    );
  }, [capabilityRequests, normalizedQuery]);

  const filteredDistributions = useMemo(() => {
    if (!normalizedQuery) return distributionPlans;
    return distributionPlans.filter((plan) =>
      [
        plan.id,
        plan.sourceSystemId,
        plan.targetSystemId,
        plan.departmentId,
        plan.businessDomain,
        plan.sourceEmployeeId,
        plan.sourceEmployeeVersion,
        plan.status,
        plan.rolloutPolicy,
        plan.rollbackPolicy,
        plan.reviewGate,
        plan.safeSummary,
        plan.qualitySignal?.lastRegressionStatus,
        ...(plan.targetEmployeeIds || []),
        ...(plan.targetSkillIds || []),
      ]
        .join(" ")
        .toLowerCase()
        .includes(normalizedQuery),
    );
  }, [distributionPlans, normalizedQuery]);

  const filteredInvocationPolicies = useMemo(() => {
    if (!normalizedQuery) return invocationPolicies;
    return invocationPolicies.filter((policy) =>
      [
        policy.id,
        policy.employeeId,
        policy.employeeVersion,
        policy.skillId,
        policy.skillVersion,
        policy.sourceSystemId,
        policy.status,
        policy.reviewGate,
        policy.privacyBoundary,
        policy.modelLimits?.maxModelLevelId,
        policy.modelLimits?.credentialLeasePolicy,
        ...(policy.allowedCallers || []),
        ...(policy.allowedDepartments || []),
        ...(policy.allowedBusinessDomains || []),
        ...(policy.allowedActions || []),
        ...(policy.deniedActions || []),
        ...(policy.modelLimits?.allowedModelIds || []),
      ]
        .join(" ")
        .toLowerCase()
        .includes(normalizedQuery),
    );
  }, [invocationPolicies, normalizedQuery]);

  const filteredQualityEvents = useMemo(() => {
    if (!normalizedQuery) return qualityEvents;
    return qualityEvents.filter((event) =>
      [
        event.id,
        event.sourceSystemId,
        event.sourceEventId,
        event.eventType,
        event.departmentId,
        event.businessDomain,
        event.entityType,
        event.entityId,
        event.entityVersion,
        event.promptVersion,
        event.severity,
        event.status,
        event.errorDomain,
        event.errorCode,
        event.rootCauseCategory,
        event.resolutionAction,
        event.evidenceSummary,
        event.expectedSummary,
        event.actualSummary,
      ]
        .join(" ")
        .toLowerCase()
        .includes(normalizedQuery),
    );
  }, [normalizedQuery, qualityEvents]);

  const filteredPreReviewWorkers = useMemo(() => {
    if (!normalizedQuery) return preReviewWorkers;
    return preReviewWorkers.filter((worker) =>
      [
        worker.id,
        worker.name,
        worker.lane,
        worker.status,
        worker.triggerMode,
        worker.triggerPolicy,
        worker.credentialPolicy,
        worker.schedule,
        worker.ownerEmployeeId,
        worker.provider,
        worker.preferredProviderRouteId,
        worker.model,
        worker.reasoningEffort,
        worker.dedupeKey,
        worker.outputContract,
        worker.governance,
        ...(worker.departmentScope || []),
        ...(worker.assignedRequestTypes || []),
      ]
        .join(" ")
        .toLowerCase()
        .includes(normalizedQuery),
    );
  }, [normalizedQuery]);

  useEffect(() => {
    recordOpsUsageEvent({ eventType: "view", viewId: activeView });
  }, [activeView]);

  useEffect(() => {
    const nav = consoleShellRef.current?.querySelector(".sidebar nav");
    const activeItem = nav?.querySelector("button.is-active");
    if (!nav || !activeItem) return;
    const navRect = nav.getBoundingClientRect();
    const activeRect = activeItem.getBoundingClientRect();
    if (activeRect.top < navRect.top) {
      nav.scrollTop -= navRect.top - activeRect.top + 4;
    } else if (activeRect.bottom > navRect.bottom) {
      nav.scrollTop += activeRect.bottom - navRect.bottom + 4;
    }
  }, [activeView, isQualitySectionOpen, visibleAdminViews.length]);

  return (
    <div className="console-shell" data-theme={theme} ref={consoleShellRef}>
      <aside className="sidebar">
        <div className="sidebar-brand">
          <span className="brand-mark">
            <BrainCircuit size={20} />
          </span>
          <div>
            <strong>Digital Workforce</strong>
            <small>Company Admin</small>
          </div>
        </div>
        <nav aria-label="管理导航">
          {views.filter((view) => view.id !== "subsystemRequests" || canViewBusinessSystemReview).map((view) => {
            const Icon = view.icon;
            return (
              <button
                key={view.id}
                className={activeView === view.id ? "is-active" : ""}
                type="button"
                aria-current={activeView === view.id ? "page" : undefined}
                onClick={() => navigateToView(view.id)}
              >
                <span className="nav-item-label">
                  <Icon size={18} />
                  {view.label}
                </span>
                <NavBadge count={navBadgeCounts[view.id]} />
              </button>
            );
          })}
          <div className="nav-group">
            <button
              className={isQualitySectionOpen ? "nav-group-trigger is-open" : "nav-group-trigger"}
              type="button"
              aria-expanded={isQualitySectionOpen}
              onClick={() => navigateToView(isQualitySectionOpen ? "overview" : "qualityManagement")}
            >
              <span className="nav-group-label">
                <ShieldAlert size={18} />
                质量审核
                <NavBadge count={qualityBadgeCount} />
              </span>
              <ChevronDown size={16} />
            </button>
            {isQualitySectionOpen ? (
              <div className="nav-submenu">
                {qualityViews.map((view) => (
                  <button
                    key={view.id}
                    className={activeView === view.id ? "is-active" : ""}
                    type="button"
                    aria-current={activeView === view.id ? "page" : undefined}
                    onClick={() => navigateToView(view.id)}
                  >
                    <span className="nav-dot" aria-hidden="true" />
                    <span className="nav-submenu-label">{view.label}</span>
                    <NavBadge count={navBadgeCounts[view.id]} />
                  </button>
                ))}
              </div>
            ) : null}
          </div>
          {visibleAdminViews.length
            ? visibleAdminViews.map((view) => {
                const Icon = view.icon;
                return (
                  <button
                    key={view.id}
                    className={activeView === view.id ? "is-active" : ""}
                    type="button"
                    aria-current={activeView === view.id ? "page" : undefined}
                    onClick={() => navigateToView(view.id)}
                  >
                    <span className="nav-item-label">
                      <Icon size={18} />
                      {view.label}
                    </span>
                    <NavBadge count={navBadgeCounts[view.id]} />
                  </button>
                );
              })
            : null}
        </nav>
        <div className="sidebar-footer">
          <EnterpriseAssistant
            employee={enterpriseAssistantEmployee}
            session={session}
            activeViewLabel={viewLabels.get(activeView)}
            onNavigate={navigateToView}
            onRuntimeVerified={handleRuntimeVerified}
          />
          <div className="sidebar-user">
            <CircleUserRound size={20} />
            <div>
              <strong>{session.name}</strong>
              <small>{session.department}</small>
              {session.identitySource === "fortress-sso-v3" ? (
                <small>{adminStatusLabel}</small>
              ) : null}
            </div>
          </div>
        </div>
      </aside>

      <main className="workspace">
        <header className="topbar">
          <div>
            <p className="eyebrow">Digital Workforce Management</p>
            <h1>{viewLabels.get(activeView)}</h1>
          </div>
          <div className="topbar-actions">
            <label className="search-box">
              <Search size={18} />
              <input aria-label="搜索管理目录" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索员工、能力、业务系统…" />
            </label>
            <button
              className="theme-toggle"
              type="button"
              aria-label={theme === "dark" ? "切换到白色背景" : "切换到黑色背景"}
              title={theme === "dark" ? "切换到白色背景" : "切换到黑色背景"}
              onClick={() => setTheme((current) => (current === "dark" ? "light" : "dark"))}
            >
              {theme === "dark" ? <Sun size={17} /> : <Moon size={17} />}
            </button>
            <button className="ghost-action" type="button" aria-label="退出登录" title="退出登录" onClick={onLogout}>
              <LogOut size={18} />
            </button>
          </div>
        </header>

        {activeView === "overview" ? (
          <Overview
            session={session}
            onNavigate={navigateToView}
            digitalEmployees={digitalEmployeeCatalog}
            basicSkills={basicSkillCatalog}
            businessSkills={businessSkillCatalog}
          />
        ) : null}
        {activeView === "people" ? (
          <People
            session={session}
            onNavigate={navigateToView}
            isSystemAdmin={isSystemAdmin}
            controlPlaneSubsystems={subsystemRegistry}
            digitalEmployees={digitalEmployeeCatalog}
            businessSkills={businessSkillCatalog}
          />
        ) : null}
        {activeView === "employees" ? (
          <DigitalEmployeesView
            employees={selectedDigitalEmployeeId ? digitalEmployeeCatalog : filteredEmployees}
            selectedEmployeeId={selectedDigitalEmployeeId}
            statusClass={statusClass}
            badcasesForEntity={badcasesForEntity}
            businessSkills={businessSkillCatalog}
            runtimeEvidenceByEmployeeId={runtimeEvidenceByEmployeeId}
            isSystemAdmin={isSystemAdmin}
            session={session}
            onNavigate={navigateToView}
            onSelectEmployee={navigateToEmployee}
            onBackToList={() => navigateToView("employees")}
            onMountChange={refreshDigitalEmployeeCatalog}
            onScheduleChange={refreshDigitalEmployeeCatalog}
            onModelBindingChange={applyModelBinding}
            onLifecycleChange={applyEmployeeLifecycle}
          />
        ) : null}
        {activeView === "capabilityAssets" ? (
          <CapabilityAssetsView
            activeSheet={activeAssetSheet}
            basicSkills={filteredBasicSkills}
            businessSkills={filteredBusinessSkills}
            employees={digitalEmployeeCatalog}
            isSystemAdmin={isSystemAdmin}
            onSheetChange={navigateToAssetSheet}
            onToolBindingChange={refreshDigitalEmployeeCatalog}
            query={query}
            session={session}
            tools={toolCatalog.tools}
            toolCatalogStatus={toolCatalog.status}
            onReloadTools={toolCatalog.reload}
          />
        ) : null}
        {activeView === "systemImports" ? <SystemImports pipelines={filteredSystemImportPipelines} onNavigate={navigateToView} /> : null}
        {activeView === "subsystemRequests" ? (
          <SubsystemRequestsView
            subsystems={filteredSubsystems}
            capabilityRequests={filteredCapabilityRequests}
            distributions={filteredDistributions}
            qualityEvents={filteredQualityEvents}
            invocationPolicies={filteredInvocationPolicies}
            routeHash={routeHash}
            canViewSubsystems={canViewBusinessSystemReview}
            canManageSubsystems={canManageControlPlane}
            onRefresh={refreshControlPlaneState}
          />
        ) : null}
        {activeView === "qualityManagement" ? (
          <QualityManagement
            badcases={filteredBadcases}
            sourceContext={qualitySourceContext}
            onSourceScopeChange={setQualitySourceScope}
            onSubsystemChange={setQualitySubsystemId}
            onReviewAction={handleQualityReviewAction}
          />
        ) : null}
        {activeView === "skillEmployeeReview" ? (
	        <SkillEmployeeReview
	          requests={filteredExternalAuditRequests}
	          onQueueChange={updateSkillReviewSummary}
	          onEmployeeCatalogChange={refreshDigitalEmployeeCatalog}
	          onCatalogChange={refreshBusinessSkillCatalog}
	        />
        ) : null}
        {activeView === "evaluationReview" ? (
          <EvaluationReview
            badcases={filteredBadcases}
            sourceContext={qualitySourceContext}
            onSourceScopeChange={setQualitySourceScope}
            onSubsystemChange={setQualitySubsystemId}
          />
        ) : null}
        {activeView === "opsMonitor" && isSystemAdmin ? (
          <OpsMonitorView
            session={session}
            employees={digitalEmployeeCatalog}
            invocationPolicies={invocationPolicies}
            qualityEvents={qualityEvents}
          />
        ) : null}
        {activeView === "systemWorkers" && canViewSystemWorkers ? (
          <SystemWorkersView
            employees={digitalEmployeeCatalog}
            onRuntimeConfigChange={refreshDigitalEmployeeCatalog}
            session={session}
            workers={filteredPreReviewWorkers}
          />
        ) : null}
        {activeView === "runtimeInfrastructure" && isSystemAdmin ? <RuntimeInfrastructureView /> : null}
        {activeView === "triggerManagement" && isSystemAdmin ? <TriggerManagementView /> : null}
        {activeView === "systemManagement" && isSystemAdmin ? <SystemManagement session={session} /> : null}
      </main>
    </div>
  );
}
