import { useToolAssetCatalog } from "../lib/useToolAssetCatalog";
import {
  Activity,
  AlertTriangle,
  ArrowLeft,
  BadgeCheck,
  BrainCircuit,
  ChevronDown,
  Code2,
  Download,
  FileText,
  History,
  KeyRound,
  Layers3,
  RadioTower,
  Settings2,
  ShieldCheck,
  UsersRound,
  Wrench,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { basicSkills, businessSkills as catalogBusinessSkills } from "../data/catalog";
import { digitalEmployeePackageExportPath, employeePackageRootSkillIds } from "../lib/digitalEmployeePackage";
import { employeeDisplayStatus, employeeRuntimeHealth, employeeRuntimeStatusDetail } from "../lib/digitalEmployeeHealth";
import {
  desktopChannelAvailable,
  employeeChannels,
  digitalEmployeeLevelLabel,
  feishuApplicationEnabled,
  normalizeDigitalEmployeeFilters,
} from "../lib/digitalEmployeeOverview";
import {
  aiModelLevels,
  apiDocSummary,
  digitalEmployeeModelCatalog,
  employeePermissionLabel,
  employeeQualityState,
  employeeStatusDetail,
  employeeWithDesktopAvailability,
  employeeWithFeishuApplication,
  modelBindingSummary,
  modelCatalogById,
  modelLevelById,
  normalizeModelBinding,
  normalizePromptGovernance,
  openBadcaseCount,
  previewItems,
  readableBoolean,
  skillNameById,
  supportedLevelsForModel,
  taskModelBindingSummaries,
} from "../lib/digitalEmployeeConfig";
import { digitalEmployeeAccess } from "../lib/permissions";
import { digitalEmployeeReadinessGateTarget } from "../lib/digitalEmployeeLifecycle";
import {
  fetchDigitalEmployeeAccessRequests,
  pendingDigitalEmployeeAccessRequestCount,
} from "../lib/digitalEmployeeAccessRequests";
import { workerRequestTypeOptions } from "../lib/systemWorkers";
import { buildSkillPackageBundle, packageBundleChips } from "../lib/skillPackaging";
import DigitalEmployeeOverview from "./DigitalEmployeeOverview";
import ApiAccessPanel from "./ApiAccessPanel";
import { DetailGrid, ExpandableList, ExpandableRow, GovernanceBlock, SkillChips } from "./ConsolePrimitives";
import EmployeeChannelsPanel from "./employee-config/EmployeeChannelsPanel";
import EmployeeCharacterRegistrationPanel from "./employee-config/EmployeeCharacterRegistrationPanel";
import FeishuAdapterRegistrationModal from "./employee-config/FeishuAdapterRegistrationModal";
import EmployeeInfrastructurePanel from "./employee-config/EmployeeInfrastructurePanel";
import EmployeeLifecycleToggle from "./employee-config/EmployeeLifecycleToggle";
import { EmployeeIdentityPanel, EmployeeUserProfilePanel } from "./employee-config/EmployeeProfilePanels";
import EmployeeSchedulePanel, { employeeScheduleRecords } from "./employee-config/EmployeeSchedulePanel";
import EmployeeTaskMonitorPanel from "./employee-config/EmployeeTaskMonitorPanel";
import { EmployeeRuntimeTasksProvider } from "./employee-config/EmployeeRuntimeTasksContext";
import EmployeeToolsPanel from "./employee-config/EmployeeToolsPanel";
import EmployeeUsageStatsPanel from "./employee-config/EmployeeUsageStatsPanel";
import MoreTabRail from "./employee-config/MoreTabRail";
import EmployeeConfigFilesPanel from "./EmployeeConfigFilesPanel";
import DigitalEmployeeAccessReview from "./DigitalEmployeeAccessReview";
import EmployeeSkillMountPanel from "./skills/EmployeeSkillMountPanel";

export default function DigitalEmployeesView({
  employees,
  selectedEmployeeId = "",
  statusClass,
  badcasesForEntity,
  businessSkills = catalogBusinessSkills,
  runtimeEvidenceByEmployeeId = {},
  isSystemAdmin = false,
  session = null,
  onNavigate = null,
  onSelectEmployee = null,
  onBackToList = null,
  onMountChange = null,
  onScheduleChange = null,
  onModelBindingChange = null,
  onLifecycleChange = null,
}) {
  const [modelOverrides, setModelOverrides] = useState({});
  const [employeeTableFilters, setEmployeeTableFilters] = useState(() => normalizeDigitalEmployeeFilters());
  const [desktopAvailabilityDrafts, setDesktopAvailabilityDrafts] = useState({});
  const [feishuApplicationDrafts, setFeishuApplicationDrafts] = useState({});
  const [listView, setListView] = useState("catalog");
  const [pendingAccessRequestCount, setPendingAccessRequestCount] = useState(0);
  const sessionPermissions = new Set(Array.isArray(session?.permissions) ? session.permissions : []);
  const canReviewAccessRequests = Boolean(
    isSystemAdmin ||
      sessionPermissions.has("digital-employees:*") ||
      (Array.isArray(session?.managedDepartmentIds) && session.managedDepartmentIds.length),
  );
  const effectiveEmployees = useMemo(
    () => employees.map((employee) => employeeWithDesktopAvailability(
      employeeWithFeishuApplication(employee, feishuApplicationDrafts[employee.id] ?? feishuApplicationEnabled(employee)),
      desktopAvailabilityDrafts[employee.id] ?? desktopChannelAvailable(employee),
    )),
    [desktopAvailabilityDrafts, employees, feishuApplicationDrafts],
  );
  const selectedEmployee = selectedEmployeeId ? effectiveEmployees.find((employee) => employee.id === selectedEmployeeId) || null : null;

  useEffect(() => {
    if (!canReviewAccessRequests) {
      setPendingAccessRequestCount(0);
      return undefined;
    }

    let active = true;
    async function refreshPendingAccessRequests() {
      try {
        const data = await fetchDigitalEmployeeAccessRequests();
        if (active) setPendingAccessRequestCount(pendingDigitalEmployeeAccessRequestCount(data.accessRequests));
      } catch {
        // Keep the last known count; the review page owns the visible retry/error state.
      }
    }

    refreshPendingAccessRequests();
    const intervalId = window.setInterval(refreshPendingAccessRequests, 60_000);
    window.addEventListener("focus", refreshPendingAccessRequests);
    return () => {
      active = false;
      window.clearInterval(intervalId);
      window.removeEventListener("focus", refreshPendingAccessRequests);
    };
  }, [canReviewAccessRequests, session?.employeeId]);

  async function saveModelBinding(employeeId, binding) {
    if (typeof onModelBindingChange !== "function") throw new Error("数字员工模型配置接口未连接");
    const result = await onModelBindingChange(employeeId, binding);
    if (result.status === "applied" && result.digitalEmployee?.modelBinding) {
      setModelOverrides((current) => ({ ...current, [employeeId]: result.digitalEmployee.modelBinding }));
    }
    return result;
  }

  function openDigitalEmployee(employeeId) {
    if (typeof onSelectEmployee === "function") {
      onSelectEmployee(employeeId);
    }
  }

  async function updateFeishuApplication(employeeId, enabled) {
    const response = await fetch(`/api/feishu/integrations/${encodeURIComponent(employeeId)}/registration`, {
      method: "PUT",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ applicationEnabled: enabled }),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || data.ok === false) {
      throw new Error(data.message || data.error || "飞书申请设置保存失败");
    }
    setFeishuApplicationDrafts((current) => ({ ...current, [employeeId]: enabled }));
    return data;
  }

  async function updateDesktopAvailability(employeeId, enabled) {
    const response = await fetch(`/api/digital-employees/${encodeURIComponent(employeeId)}/desktop-availability`, {
      method: "PUT",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ enabled }),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || data.ok === false) {
      throw new Error(data.message || data.error || "桌面端可用状态保存失败");
    }
    setDesktopAvailabilityDrafts((current) => ({ ...current, [employeeId]: enabled }));
    return data;
  }

  if (!employees.length) {
    return (
      <section className="view-stack">
        <section className="panel empty-panel">
          <p className="eyebrow">Digital Employees</p>
          <h2>没有匹配的数字员工</h2>
          <span>调整搜索词后再查看员工体系、版本、Prompt 和 badcase 归因。</span>
        </section>
      </section>
    );
  }

  if (selectedEmployeeId) {
    if (!selectedEmployee) {
      return (
        <section className="view-stack">
          <section className="panel empty-panel selected-employee-not-found">
            <p className="eyebrow">Digital Employee Config</p>
            <h2>没有找到这个数字员工</h2>
            <span>员工 ID：{selectedEmployeeId}。可能已下线、被筛选条件隐藏，或链接来自旧目录。</span>
            <button className="ghost-action selected-employee-back-action" type="button" onClick={onBackToList}>
              <ArrowLeft size={16} />
              返回数字员工列表
            </button>
          </section>
        </section>
      );
    }

    const selectedAccess = digitalEmployeeAccess(session, selectedEmployee);
    if (!selectedAccess.canOpenWorkbench) {
      return (
        <section className="view-stack">
          <EmployeeConfigAccessDenied employee={selectedEmployee} access={selectedAccess} onBackToList={onBackToList} />
        </section>
      );
    }

    return (
      <section className="view-stack">
        <SelectedEmployeeConfiguration
          employee={selectedEmployee}
          statusClass={statusClass}
          badcasesForEntity={badcasesForEntity}
          modelOverrides={modelOverrides}
          onSaveModelBinding={saveModelBinding}
          businessSkills={businessSkills}
          runtimeEvidenceByEmployeeId={runtimeEvidenceByEmployeeId}
          isSystemAdmin={isSystemAdmin}
          session={session}
          employeeAccess={selectedAccess}
          onNavigate={onNavigate}
          onBackToList={onBackToList}
          onMountChange={onMountChange}
          onScheduleChange={onScheduleChange}
          onLifecycleChange={onLifecycleChange}
        />
      </section>
    );
  }

  if (listView === "accessReview") {
    return (
      <section className="view-stack">
        <DigitalEmployeeAccessReview
          session={session}
          onBack={() => setListView("catalog")}
          onPendingCountChange={setPendingAccessRequestCount}
        />
      </section>
    );
  }

  return (
    <section className="view-stack">
      <DigitalEmployeeOverview
        employees={effectiveEmployees}
        statusClass={statusClass}
        badcasesForEntity={badcasesForEntity}
        businessSkills={businessSkills}
        runtimeEvidenceByEmployeeId={runtimeEvidenceByEmployeeId}
        isSystemAdmin={isSystemAdmin}
        session={session}
        onFeishuApplicationChange={updateFeishuApplication}
        onDesktopAvailabilityChange={updateDesktopAvailability}
        onOpenAccessReview={canReviewAccessRequests ? () => setListView("accessReview") : null}
        pendingAccessRequestCount={pendingAccessRequestCount}
        filters={employeeTableFilters}
        onFiltersChange={setEmployeeTableFilters}
        onSelectEmployee={openDigitalEmployee}
      />
    </section>
  );
}

function EmployeeConfigAccessDenied({ employee, access, onBackToList }) {
  return (
    <section className="panel empty-panel selected-employee-access-denied">
      <p className="eyebrow">Digital Employee Config</p>
      <h2>没有企业级配置权限</h2>
      <span>
        {employee.name} 是{access.scopeLabel}数字员工。{access.blockedReason}
      </span>
      <div className="employee-access-boundary">
        <span>
          <ShieldCheck size={15} />
          配置权：系统管理员、控制面治理或所属治理部门管理员
        </span>
        <span>
          <KeyRound size={15} />
          申请权：业务级数字员工通过申请入口进入审核
        </span>
      </div>
      <button className="ghost-action selected-employee-back-action" type="button" onClick={onBackToList}>
        <ArrowLeft size={16} />
        返回数字员工列表
      </button>
    </section>
  );
}

function SelectedEmployeeConfiguration({
  employee,
  statusClass,
  badcasesForEntity,
  modelOverrides,
  onSaveModelBinding,
  businessSkills,
  runtimeEvidenceByEmployeeId,
  isSystemAdmin,
  session,
  employeeAccess,
  onNavigate,
  onBackToList,
  onMountChange,
  onScheduleChange,
  onLifecycleChange,
}) {
  const [workbenchRequest, setWorkbenchRequest] = useState({ employeeId: "", tabId: "", action: "", sequence: 0 });
  const selectedBadcases = typeof badcasesForEntity === "function" ? badcasesForEntity(employee.id) : [];
  const selectedModelOverride = modelOverrides[employee.id];
  const selectedConfiguredModelBinding = selectedModelOverride || employee.modelBinding || {};
  const selectedModelBinding = normalizeModelBinding(selectedConfiguredModelBinding);
  const selectedRuntimeEvidence = runtimeEvidenceByEmployeeId[employee.id] || employee.runtimeEvidence || {};
  const selectedHealth = employeeRuntimeHealth(employee, selectedConfiguredModelBinding, selectedRuntimeEvidence);
  const selectedDisplayStatus = employeeDisplayStatus(employee, selectedHealth);
  const selectedDisplayStatusTone = selectedHealth.overall.tone === "bad" ? "bad" : statusClass(selectedDisplayStatus);
  const selectedRuntimeStatusDetail = employeeRuntimeStatusDetail(selectedHealth);

  function openReadinessGate(gate) {
    const target = digitalEmployeeReadinessGateTarget(gate);
    if (target.viewId && typeof onNavigate === "function") {
      onNavigate(target.viewId);
      return;
    }
    const action = gate.actionRoute === "#employee-responsibilities" || String(gate.id || "").startsWith("responsibility:")
      ? "openResponsibilities"
      : "";
    setWorkbenchRequest((current) => ({ employeeId: employee.id, tabId: target.tabId, action, sequence: current.sequence + 1 }));
  }

  return (
    <section className="panel selected-employee-config" id="selected-digital-employee-config">
      <div className="selected-employee-config-head">
        <div>
          <p className="eyebrow">Digital Employee Config</p>
          <h2>{employee.name}</h2>
          <span>{digitalEmployeeLevelLabel(employee)} · {employee.department} · {employee.owner || "未指定负责人"}</span>
        </div>
        <div className="selected-employee-config-actions">
          <button className="ghost-action selected-employee-back-action" type="button" onClick={onBackToList}>
            <ArrowLeft size={16} />
            返回列表
          </button>
          {isSystemAdmin ? (
            <EmployeeLifecycleToggle employee={employee} onChange={onLifecycleChange} onGateAction={openReadinessGate} />
          ) : null}
          <span className={`status-pill ${selectedDisplayStatusTone}`}>{selectedDisplayStatus}</span>
          {selectedRuntimeStatusDetail ? (
            <span className={`status-pill ${selectedHealth.overall.tone}`}>{selectedRuntimeStatusDetail}</span>
          ) : null}
          {selectedDisplayStatus !== employee.status ? (
            <span className={`status-pill ${statusClass(employee.status)}`}>{employee.status}</span>
          ) : null}
          <span className={`status-pill ${employeeAccess?.canConfigure ? "good" : "warn"}`}>
            {employeeAccess?.canConfigure ? "配置权已确认" : "申请模式"}
          </span>
        </div>
      </div>
      <EmployeeRuntimeTasksProvider employeeId={employee.id} key={employee.id}>
        <div className="selected-employee-cockpit-grid">
          <div className="selected-employee-cockpit-rail">
            <EmployeeCharacterRegistrationPanel employee={employee} />
            <EmployeeUsageStatsPanel employee={employee} modelBinding={selectedConfiguredModelBinding} runtimeEvidence={selectedRuntimeEvidence} badcases={selectedBadcases} />
          </div>
          <DigitalEmployeeList
            employees={[employee]}
            listId="selected-digital-employee"
            statusClass={statusClass}
            badcasesForEntity={badcasesForEntity}
            modelOverrides={modelOverrides}
            onSaveModelBinding={onSaveModelBinding}
            businessSkills={businessSkills}
            runtimeEvidenceByEmployeeId={runtimeEvidenceByEmployeeId}
            isSystemAdmin={isSystemAdmin}
            session={session}
            selectedEmployeeAccess={employeeAccess}
            onNavigate={onNavigate}
            onMountChange={onMountChange}
            onScheduleChange={onScheduleChange}
            focusedEmployeeId={employee.id}
            workbenchRequest={workbenchRequest}
          />
        </div>
      </EmployeeRuntimeTasksProvider>
    </section>
  );
}

function DigitalEmployeeList({
  employees,
  listId,
  statusClass,
  badcasesForEntity,
  modelOverrides,
  onSaveModelBinding,
  businessSkills = catalogBusinessSkills,
  runtimeEvidenceByEmployeeId = {},
  isSystemAdmin,
  session,
  selectedEmployeeAccess = null,
  onNavigate,
  onMountChange,
  onScheduleChange,
  focusedEmployeeId = "",
  focusedEmployeeToken = 0,
  workbenchRequest = null,
}) {
  return (
    <ExpandableList className="compact-list" defaultOpenId={focusedEmployeeId} key={`${listId}-${focusedEmployeeId}-${focusedEmployeeToken}`}>
      {({ openRowId, setOpenRowId }) =>
        employees.map((employee) => {
          const badcases = badcasesForEntity(employee.id);
          const basicSkillNames = (employee.basicSkillIds || []).map((id) => skillNameById(id, basicSkills));
          const businessSkillNames = (employee.businessSkillIds || []).map((id) => skillNameById(id, businessSkills));
          const modelOverride = modelOverrides[employee.id];
          const configuredModelBinding = modelOverride || employee.modelBinding || {};
          const modelBinding = normalizeModelBinding(configuredModelBinding);
          const promptConfig = normalizePromptGovernance(employee);
          const employeeAccess = selectedEmployeeAccess || digitalEmployeeAccess(session, employee);

          return (
            <DigitalEmployeeRow
              key={employee.id}
              employee={employee}
              listId={listId}
              openRowId={openRowId}
              setOpenRowId={setOpenRowId}
              statusClass={statusClass}
              badcases={badcases}
              basicSkillNames={basicSkillNames}
              businessSkillNames={businessSkillNames}
              modelBinding={modelBinding}
              configuredModelBinding={configuredModelBinding}
              promptConfig={promptConfig}
              businessSkills={businessSkills}
              runtimeEvidence={runtimeEvidenceByEmployeeId[employee.id]}
              isSystemAdmin={isSystemAdmin}
              employeeAccess={employeeAccess}
              onNavigate={onNavigate}
              onSaveModelBinding={(binding) => onSaveModelBinding(employee.id, binding)}
              onMountChange={onMountChange}
              onScheduleChange={onScheduleChange}
              workbenchRequest={workbenchRequest}
            />
          );
        })
      }
    </ExpandableList>
  );
}

function DigitalEmployeeRow({
  employee,
  listId,
  openRowId,
  setOpenRowId,
  statusClass,
  badcases,
  basicSkillNames,
  businessSkillNames,
  modelBinding,
  configuredModelBinding,
  promptConfig,
  businessSkills,
  runtimeEvidence,
  isSystemAdmin,
  employeeAccess,
  onNavigate,
  onSaveModelBinding,
  onMountChange,
  onScheduleChange,
  workbenchRequest,
}) {
  const [activeWorkbenchTab, setActiveWorkbenchTab] = useState("identity");
  const [showFeishuApplication, setShowFeishuApplication] = useState(false);
  const isBusinessEmployee = employee.level !== "系统级";
  const canConfigureEmployee = Boolean(employeeAccess?.canConfigure);
  const canRequestFeishu = feishuApplicationEnabled(employee);
  const feishuActionLabel = canRequestFeishu ? "申请飞书" : "飞书不可申请";
  const feishuActionTitle = !canRequestFeishu
    ? "管理员未允许该数字员工发起飞书申请"
    : `申请 ${employee.name} 接入飞书`;
  const packageRootSkillIds = employeePackageRootSkillIds(employee);
  const packageBundle = buildSkillPackageBundle(packageRootSkillIds, [...basicSkills, ...(businessSkills || catalogBusinessSkills)]);
  const packageBundleItems = packageBundleChips(packageBundle);
  const hasDeclaredPackage = Boolean(employee.downloadUrl || employee.packageIncludes?.length || employee.packageBundleSkillIds?.length || employee.effectivePackageBundleSkillIds?.length);
  const packageDependenciesReady = packageBundle.includedSkillIds.length > 0 && packageBundle.missingDependencyIds.length === 0;
  const packageExportPath = packageDependenciesReady ? digitalEmployeePackageExportPath(employee) : "";
  const downloadLabel = packageExportPath ? "下载完整包" : "下载待发布";
  const packageBundleSummary = hasDeclaredPackage && packageBundle.includedSkillIds.length ? `随包 ${packageBundle.includedSkillIds.length} 个 Skill` : "";
  const needsPersonnelApproval = employee.status === "待人员审批" && typeof onNavigate === "function";
  const permissionLabel = employeePermissionLabel(employee);
  const enabledSkillCount = basicSkillNames.length + businessSkillNames.length;
  const enabledSkillSummary = `${enabledSkillCount} 个技能已启用`;
  const qualityState = employeeQualityState(employee, badcases);
  const channels = employeeChannels(employee);
  const effectiveRuntimeEvidence = runtimeEvidence || employee.runtimeEvidence || {};
  const runtimeHealth = employeeRuntimeHealth(employee, configuredModelBinding, effectiveRuntimeEvidence);
  const displayStatus = employeeDisplayStatus(employee, runtimeHealth);
  const displayStatusTone = runtimeHealth.overall.tone === "bad" ? "bad" : statusClass(displayStatus);
  const runtimeStatusDetail = employeeRuntimeStatusDetail(runtimeHealth);

  useEffect(() => {
    if (!workbenchRequest?.sequence || !workbenchRequest.tabId) return undefined;
    setOpenRowId(employee.id);
    setActiveWorkbenchTab(workbenchRequest.tabId);
    const frameId = window.requestAnimationFrame(() => {
      document.getElementById(`employee-config-workbench-${employee.id}`)?.scrollIntoView({ behavior: "smooth", block: "start" });
    });
    return () => window.cancelAnimationFrame(frameId);
  }, [employee.id, setOpenRowId, workbenchRequest?.sequence, workbenchRequest?.tabId]);

  function toggleApiAccess() {
    setOpenRowId(employee.id);
    setActiveWorkbenchTab("channels");
  }

  function openFeishuApplication() {
    if (!canRequestFeishu) return;
    setOpenRowId(employee.id);
    setShowFeishuApplication(true);
  }

  return (
    <>
      <ExpandableRow
        rowId={employee.id}
        listId={listId}
        openRowId={openRowId}
        setOpenRowId={setOpenRowId}
        icon={<BrainCircuit size={18} />}
        title={employee.name}
        description={employee.objective}
        status={<span className={`status-pill ${displayStatusTone}`}>{displayStatus}</span>}
        summary={[
          digitalEmployeeLevelLabel(employee),
          employee.department,
          permissionLabel,
          `${channels.length} Channels`,
          enabledSkillSummary,
          qualityState.label,
          runtimeStatusDetail || runtimeHealth.overall.label,
          modelBindingSummary(modelBinding),
          employee.owner,
          packageBundleSummary,
        ]}
        actions={isBusinessEmployee ? (
          <>
            {needsPersonnelApproval ? (
              <button
                className="ghost-action entity-row-action employee-approval-action"
                type="button"
                title={`打开 ${employee.name} 的技能/员工评审入口`}
                onClick={() => onNavigate("skillEmployeeReview")}
              >
                <UsersRound size={15} />
                待人员评审
              </button>
            ) : null}
            <button
              className="ghost-action entity-row-action entity-row-feishu-action"
              type="button"
              disabled={!canRequestFeishu}
              title={feishuActionTitle}
              onClick={openFeishuApplication}
            >
              <RadioTower size={15} />
              {feishuActionLabel}
            </button>
            {packageExportPath ? (
              <a className="ghost-action entity-row-action entity-row-link-action entity-row-download-action" href={packageExportPath}>
                <Download size={15} />
                {downloadLabel}
              </a>
            ) : (
              <button className="ghost-action entity-row-action" type="button" disabled title="该业务数字员工还没有发布可下载包">
                <Download size={15} />
                {downloadLabel}
              </button>
            )}
            <button className="ghost-action entity-row-action" type="button" onClick={toggleApiAccess}>
              <Code2 size={15} />
              API 接入
            </button>
          </>
        ) : null}
      >
        <EmployeeConfigurationWorkbench
          activeTab={activeWorkbenchTab}
          onTabChange={setActiveWorkbenchTab}
          employee={employee}
          badcases={badcases}
          basicSkillNames={basicSkillNames}
          businessSkillNames={businessSkillNames}
          modelBinding={modelBinding}
          promptConfig={promptConfig}
          businessSkills={businessSkills}
          isSystemAdmin={isSystemAdmin}
          canConfigureEmployee={canConfigureEmployee}
          isBusinessEmployee={isBusinessEmployee}
          packageBundleItems={packageBundleItems}
          hasDeclaredPackage={hasDeclaredPackage}
          channels={channels}
          permissionLabel={permissionLabel}
          statusClass={statusClass}
          onSaveModelBinding={onSaveModelBinding}
          onMountChange={onMountChange}
          onScheduleChange={onScheduleChange}
          onOpenFeishuApplication={openFeishuApplication}
          workbenchRequest={workbenchRequest}
        />
      </ExpandableRow>
      {showFeishuApplication ? (
        <FeishuAdapterRegistrationModal
          employee={employee}
          isSystemAdmin={isSystemAdmin}
          open={showFeishuApplication}
          onClose={() => setShowFeishuApplication(false)}
        />
      ) : null}
    </>
  );
}

function EmployeeConfigurationWorkbench({
  activeTab,
  onTabChange,
  employee,
  badcases,
  basicSkillNames,
  businessSkillNames,
  modelBinding,
  promptConfig,
  businessSkills,
  isSystemAdmin,
  canConfigureEmployee = false,
  isBusinessEmployee,
  packageBundleItems,
  hasDeclaredPackage,
  channels,
  permissionLabel,
  statusClass,
  onSaveModelBinding,
  onMountChange,
  onScheduleChange,
  onOpenFeishuApplication,
  workbenchRequest,
}) {
  const moreTabDefs = useMemo(() => [
    { id: "overview", label: "总览", icon: <BadgeCheck size={15} /> },
    { id: "files", label: "配置文件", icon: <FileText size={15} /> },
    { id: "skills", label: "技能", icon: <Layers3 size={15} /> },
    { id: "tools", label: "工具", icon: <Wrench size={15} /> },
    { id: "channels", label: "渠道", icon: <RadioTower size={15} /> },
    { id: "schedule", label: "定时任务", icon: <History size={15} /> },
    { id: "runtime", label: "运行", icon: <Settings2 size={15} /> },
    { id: "quality", label: "质量", icon: <ShieldCheck size={15} /> },
    isSystemAdmin ? { id: "advanced", label: "高级", icon: <Code2 size={15} /> } : null,
  ].filter(Boolean), [isSystemAdmin]);
  const [moreTabOrder, setMoreTabOrder] = useState(() => moreTabDefs.map((tab) => tab.id));
  const moreTabs = useMemo(() => {
    const tabById = new Map(moreTabDefs.map((tab) => [tab.id, tab]));
    const orderedTabs = moreTabOrder.map((id) => tabById.get(id)).filter(Boolean);
    const remainingTabs = moreTabDefs.filter((tab) => !moreTabOrder.includes(tab.id));
    return [...orderedTabs, ...remainingTabs];
  }, [moreTabDefs, moreTabOrder]);
  function reorderMoreTabs(sourceId, targetId) {
    setMoreTabOrder((current) => {
      const validIds = moreTabDefs.map((tab) => tab.id);
      const orderedIds = [...current.filter((id) => validIds.includes(id)), ...validIds.filter((id) => !current.includes(id))];
      const sourceIndex = orderedIds.indexOf(sourceId);
      const targetIndex = orderedIds.indexOf(targetId);
      if (sourceIndex < 0 || targetIndex < 0 || sourceIndex === targetIndex) return current;
      const next = [...orderedIds];
      const [movedId] = next.splice(sourceIndex, 1);
      next.splice(targetIndex, 0, movedId);
      return next;
    });
  }
  const primaryTabs = [
    { id: "identity", label: "智能体档案" },
    { id: "behavior", label: "行为准则" },
    { id: "workflow", label: "工作流程" },
    { id: "tasks", label: "任务监控" },
    { id: "user", label: "用户档案" },
  ];
  const isMoreTab = moreTabs.some((tab) => tab.id === activeTab);
  const selectedTab = primaryTabs.some((tab) => tab.id === activeTab) || isMoreTab ? activeTab : "identity";
  const selectedPrimaryTab = isMoreTab ? "more" : selectedTab;
  const selectedMoreTab = isMoreTab ? selectedTab : "overview";
  const selectedMoreTabLabel = moreTabs.find((tab) => tab.id === selectedMoreTab)?.label || "总览";

  return (
    <div className="employee-config-workbench" id={`employee-config-workbench-${employee.id}`}>
      <div className="employee-config-tabs" role="tablist" aria-label={`${employee.name} 配置工作台`}>
        {primaryTabs.map((tab) => (
          <button
            className={selectedPrimaryTab === tab.id ? "is-active" : ""}
            type="button"
            role="tab"
            aria-selected={selectedPrimaryTab === tab.id}
            key={tab.id}
            onClick={() => onTabChange(tab.id)}
          >
            <span>{tab.label}</span>
          </button>
        ))}
        <button
          className={selectedPrimaryTab === "more" ? "is-active" : ""}
          type="button"
          role="tab"
          aria-selected={selectedPrimaryTab === "more"}
          onClick={() => onTabChange(selectedMoreTab)}
        >
          <span>更多</span>
          <small>{selectedPrimaryTab === "more" ? selectedMoreTabLabel : moreTabs.length}</small>
          <ChevronDown size={14} />
        </button>
      </div>

      <div className="employee-config-tab-body">
        {selectedTab === "identity" ? (
          <EmployeeIdentityPanel
            employee={employee}
            modelBindingLabel={modelBindingSummary(modelBinding)}
            promptConfig={promptConfig}
            permissionLabel={permissionLabel}
            canConfigure={canConfigureEmployee}
            canRename={isSystemAdmin}
            onEmployeeChange={onMountChange}
            responsibilityOpenRequest={workbenchRequest?.employeeId === employee.id && workbenchRequest?.action === "openResponsibilities"
              ? workbenchRequest.sequence
              : 0}
          />
        ) : null}

        {selectedTab === "behavior" ? (
          <EmployeeBehaviorRulesPanel
            employee={employee}
            channels={channels}
            permissionLabel={permissionLabel}
            isBusinessEmployee={isBusinessEmployee}
            isSystemAdmin={isSystemAdmin}
            promptConfig={promptConfig}
            onOpenFeishuApplication={onOpenFeishuApplication}
          />
        ) : null}

        {selectedTab === "workflow" ? (
          <EmployeeWorkflowPanel
            employee={employee}
            modelBinding={modelBinding}
            promptConfig={promptConfig}
            isSystemAdmin={isSystemAdmin}
            onScheduleChange={onScheduleChange}
          />
        ) : null}

        {selectedTab === "user" ? (
          <EmployeeUserProfilePanel
            employee={employee}
            channels={channels}
            permissionLabel={permissionLabel}
            isBusinessEmployee={isBusinessEmployee}
          />
        ) : null}

        {selectedTab === "tasks" ? (
          <EmployeeTaskMonitorPanel employee={employee} />
        ) : null}

        {isMoreTab ? (
          <EmployeeMoreConfigurationPanel
            selectedTab={selectedMoreTab}
            tabs={moreTabs}
            onTabChange={onTabChange}
            onReorderTabs={reorderMoreTabs}
            employee={employee}
            badcases={badcases}
            basicSkillNames={basicSkillNames}
            businessSkillNames={businessSkillNames}
            modelBinding={modelBinding}
            promptConfig={promptConfig}
            businessSkills={businessSkills}
            isSystemAdmin={isSystemAdmin}
            canConfigureEmployee={canConfigureEmployee}
            isBusinessEmployee={isBusinessEmployee}
            packageBundleItems={packageBundleItems}
            hasDeclaredPackage={hasDeclaredPackage}
            channels={channels}
            permissionLabel={permissionLabel}
            statusClass={statusClass}
            onSaveModelBinding={onSaveModelBinding}
            onMountChange={onMountChange}
            onScheduleChange={onScheduleChange}
            onOpenFeishuApplication={onOpenFeishuApplication}
          />
        ) : null}
      </div>
    </div>
  );
}

function EmployeeBehaviorRulesPanel({ employee, channels, permissionLabel, isBusinessEmployee, isSystemAdmin, promptConfig, onOpenFeishuApplication }) {
  const ruleItems = previewItems([
    ...(employee.constraints || []),
    employee.reviewGate || promptConfig.promptReviewGate,
    ...(employee.unsupportedActions || []),
  ]);
  const soulLines = [
    ["# SOUL.md - 你是谁", employee.objective || "围绕部门职责提供受控建议和任务草案。"],
    ["## 行为准则", ruleItems.length ? ruleItems.join("\n") : "先确认权限和上下文，再输出可追溯建议。"],
    ["## 安全边界", "不保存 raw prompt、provider key、模型 trace、执行 payload、客户数据或员工 PII。"],
  ];

  return (
    <div className="employee-config-tab-panel">
      <section className="agent-rules-card">
        <div className="agent-rules-card-head">
          <span>
            <strong>SOUL.md</strong>
            <small>智能体必须遵守的底线规则、安全框架和核心价值观</small>
          </span>
          <span className="status-pill info">{promptConfig.promptVersion || "Prompt 元数据"}</span>
        </div>
        <div className="agent-rules-doc">
          {soulLines.map(([title, body]) => (
            <div key={title}>
              <strong>{title}</strong>
              {body.split("\n").map((line) => (
                <p key={line}>{line}</p>
              ))}
            </div>
          ))}
        </div>
      </section>
      <EmployeeChannelsPanel employee={employee} channels={channels} permissionLabel={permissionLabel} isBusinessEmployee={isBusinessEmployee} isSystemAdmin={isSystemAdmin} onOpenFeishuApplication={onOpenFeishuApplication} />
    </div>
  );
}

function EmployeeWorkflowPanel({ employee, modelBinding, promptConfig, isSystemAdmin, onScheduleChange }) {
  return (
    <div className="employee-config-tab-panel">
      <EmployeeSchedulePanel employee={employee} isSystemAdmin={isSystemAdmin} onScheduleChange={onScheduleChange} />
      <EmployeeRuntimePanel employee={employee} modelBinding={modelBinding} promptConfig={promptConfig} />
      <PromptGovernancePanel
        promptConfig={promptConfig}
      />
    </div>
  );
}

function EmployeeMoreConfigurationPanel({
  selectedTab,
  tabs,
  onTabChange,
  onReorderTabs,
  employee,
  badcases,
  basicSkillNames,
  businessSkillNames,
  modelBinding,
  promptConfig,
  businessSkills,
  isSystemAdmin,
  canConfigureEmployee = false,
  isBusinessEmployee,
  packageBundleItems,
  hasDeclaredPackage,
  channels,
  permissionLabel,
  statusClass,
  onSaveModelBinding,
  onMountChange,
  onScheduleChange,
  onOpenFeishuApplication,
}) {
  const toolCatalog = useToolAssetCatalog();
  return (
    <div className="employee-config-tab-panel">
      <MoreTabRail
        tabs={tabs}
        selectedTab={selectedTab}
        onTabChange={onTabChange}
        onReorder={onReorderTabs}
        ariaLabel={`${employee.name} 更多配置`}
      />

      {selectedTab === "overview" ? (
        <div className="employee-config-tab-panel">
          <EmployeeProductOverview
            employee={employee}
            badcases={badcases}
            basicSkillNames={basicSkillNames}
            businessSkillNames={businessSkillNames}
            modelBinding={modelBinding}
            promptConfig={promptConfig}
            channels={channels}
            statusClass={statusClass}
          />
        </div>
      ) : null}

      {selectedTab === "files" ? (
        <EmployeeConfigFilesPanel
          employee={employee}
          basicSkillNames={basicSkillNames}
          businessSkillNames={businessSkillNames}
          promptConfig={promptConfig}
          modelBinding={modelBinding}
          isSystemAdmin={isSystemAdmin}
        />
      ) : null}

      {selectedTab === "skills" ? (
        <EmployeeSkillMountPanel
          employee={employee}
          basicSkills={basicSkills}
          businessSkills={businessSkills}
          isSystemAdmin={isSystemAdmin}
          onMountChange={onMountChange}
        />
      ) : null}

      {selectedTab === "tools" ? (
        <>
        {toolCatalog.status !== "ready" ? <p role="status">
          {toolCatalog.status === "loading" ? "正在读取受管 Tool 目录…" : "Tool 目录暂不可用。"}
          {toolCatalog.status === "unavailable" ? <button type="button" onClick={toolCatalog.reload}>重试</button> : null}
        </p> : null}
        <EmployeeToolsPanel
          employee={employee}
          basicSkills={basicSkills}
          businessSkills={businessSkills}
          enterpriseTools={toolCatalog.tools}
          onToolChange={onMountChange}
          onOpenFeishuApplication={onOpenFeishuApplication}
        />
        </>
      ) : null}

      {selectedTab === "channels" ? (
        <div className="employee-config-tab-panel">
          <EmployeeChannelsPanel
            employee={employee}
            channels={channels}
            permissionLabel={permissionLabel}
            isBusinessEmployee={isBusinessEmployee}
            isSystemAdmin={isSystemAdmin}
            onOpenFeishuApplication={onOpenFeishuApplication}
            apiAccessPanel={isBusinessEmployee ? <ApiAccessPanel entity={employee} kind="businessEmployee" /> : null}
          />
        </div>
      ) : null}

      {selectedTab === "schedule" ? (
        <div className="employee-config-tab-panel">
          <EmployeeSchedulePanel employee={employee} isSystemAdmin={isSystemAdmin} onScheduleChange={onScheduleChange} />
        </div>
      ) : null}

      {selectedTab === "runtime" ? (
        <div className="employee-config-tab-panel">
          <EmployeeRuntimePanel employee={employee} modelBinding={modelBinding} promptConfig={promptConfig} />
          <ModelBindingPanel
            employee={employee}
            binding={modelBinding}
            canConfigureEmployee={canConfigureEmployee}
            onSave={onSaveModelBinding}
          />
        </div>
      ) : null}

      {selectedTab === "quality" ? (
        <div className="employee-config-tab-panel">
          <EmployeeQualityPanel employee={employee} badcases={badcases} promptConfig={promptConfig} />
        </div>
      ) : null}

      {selectedTab === "advanced" && isSystemAdmin ? (
        <EmployeeAdvancedPanel
          employee={employee}
          modelBinding={modelBinding}
          promptConfig={promptConfig}
          packageBundleItems={packageBundleItems}
          hasDeclaredPackage={hasDeclaredPackage}
          basicSkillNames={basicSkillNames}
          businessSkillNames={businessSkillNames}
        />
      ) : null}
    </div>
  );
}

function EmployeeRuntimePanel({ employee, modelBinding, promptConfig }) {
  const runtimeBinding = employee.runtimeBinding || {};
  const runtimeQueueConfig = runtimeQueueConfigForEmployee(employee, modelBinding);
  const scheduleItems = employeeScheduleRecords(employee).map((item) => `${item.title}：${item.status}`);
  const runtimeWorkerItems = (employee.runtimeWorkers || []).map((worker) =>
    `${worker.workerRole === "primary" ? "主 Worker" : "辅助 Lane"} · ${worker.name || worker.lane} · ${worker.model || "待模型"} / ${worker.reasoningEffort || "待等级"}`,
  );

  return (
    <>
      <section className="employee-cockpit-grid">
        <article className="employee-cockpit-section">
          <div className="employee-config-section-head">
            <Activity size={16} />
            <span>
              <strong>Agent Runtime</strong>
              <small>模型、Worker、Key 租约和运行模式</small>
            </span>
          </div>
          <DetailGrid
            items={[
              ["Agent Runtime", runtimeBinding.agentRuntimeId || employee.id],
              ["Runtime Adapter", runtimeBinding.runtimeAdapter || modelBinding.runtimeAdapter || "由控制面分配"],
              ["Worker Lane", runtimeBinding.workerLane || modelBinding.workerLane || runtimeBinding.assignedAiWorker],
              ["Worker 模式", runtimeBinding.workerPoolMode || "按控制面策略分配"],
              ["Provider", runtimeBinding.provider || modelBinding.provider || modelBinding.providerName],
              ["Provider Route", runtimeBinding.preferredProviderRouteId || modelBinding.preferredProviderRouteId || modelBinding.providerRouteId || "server-side lease"],
              ["Key 可见性", runtimeBinding.keyVisibility || "server_only"],
              ["共享额度", readableBoolean(runtimeBinding.consumesSharedWorkerQuota, "占用共享额度", "不占共享额度")],
              ["并行 Worker", `${runtimeQueueConfig.maxParallelWorkers} 个`],
              ["最大排队数", `${runtimeQueueConfig.taskBufferQueueSize} 个任务`],
              ["排队提醒阈值", `${runtimeQueueConfig.taskBufferMinutes} 分钟`],
              ["接收上限", `${runtimeQueueConfig.totalTaskCapacity} 个任务`],
              ["默认模式", runtimeBinding.defaultMode || modelBinding.defaultMode],
            ]}
          />
          {runtimeWorkerItems.length ? <SkillChips title="同源 Worker Lanes" items={runtimeWorkerItems} compact /> : null}
        </article>
        <article className="employee-cockpit-section">
          <div className="employee-config-section-head">
            <History size={16} />
            <span>
              <strong>任务与上下文</strong>
              <small>定时任务、Prompt 元数据和依赖注入</small>
            </span>
          </div>
          <SkillChips title="任务" items={scheduleItems} compact />
          <DetailGrid
            items={[
              ["Prompt scope", promptConfig.promptScope],
              ["Prompt 指纹", promptConfig.promptHash || "待生成"],
              ["依赖上下文", "digital-employee-runtime-dependency-context.v2"],
              ["上下文边界", "只注入安全元数据，不注入 raw prompt / provider key / 执行 payload"],
            ]}
          />
        </article>
      </section>
      <EmployeeInfrastructurePanel employee={employee} />
    </>
  );
}

function runtimeQueueConfigForEmployee(employee = {}, modelBinding = {}) {
  const binding = {
    ...(modelBinding || {}),
    ...(employee.runtimeBinding || {}),
  };
  const maxParallelWorkers = positiveRuntimeNumber(binding.maxParallelWorkers || binding.reservedWorkerSlots, 1);
  const taskBufferQueueSize = positiveRuntimeNumber(
    binding.taskBufferQueueSize || binding.maxBufferedTasks || binding.bufferQueueSize,
    0,
    0,
  );
  const taskBufferMinutes = positiveRuntimeNumber(binding.taskBufferMinutes || binding.taskTimeoutMinutes, 240);
  return {
    maxParallelWorkers,
    taskBufferQueueSize,
    taskBufferMinutes,
    totalTaskCapacity: maxParallelWorkers + taskBufferQueueSize,
  };
}

function positiveRuntimeNumber(value, fallback, minimum = 1) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(minimum, Math.floor(number));
}

function EmployeeQualityPanel({ employee, badcases, promptConfig }) {
  const qualityState = employeeQualityState(employee, badcases);
  const openCount = openBadcaseCount(employee, badcases);
  const qualityCards = [
    ["质量状态", qualityState.label],
    ["未关闭 badcase", `${openCount}`],
    ["Prompt 版本", promptConfig.promptVersion || "待配置"],
    ["输出契约", employee.outputContract || "待声明"],
  ];

  return (
    <>
      <section className="employee-quality-cards">
        {qualityCards.map(([label, value]) => (
          <article className="employee-quality-card" key={label}>
            <small>{label}</small>
            <strong>{value}</strong>
          </article>
        ))}
      </section>
      <section className="employee-cockpit-section">
        <div className="employee-config-section-head">
          <ShieldCheck size={16} />
          <span>
            <strong>治理边界</strong>
            <small>能力、输入输出、工具、badcase 与人审门禁</small>
          </span>
        </div>
        <GovernanceBlock constraints={employee.constraints} promptKeys={[employee.promptScope]} badcases={badcases} />
        {employee.capabilities?.length ? <SkillChips title="能力" items={employee.capabilities} compact /> : null}
        {employee.inputs?.length ? <SkillChips title="输入" items={employee.inputs} compact /> : null}
        {employee.outputs?.length ? <SkillChips title="输出" items={employee.outputs} compact /> : null}
        {employee.rules?.length ? <SkillChips title="运行规则" items={employee.rules} compact /> : null}
        {employee.unsupportedActions?.length ? <SkillChips title="不支持动作" items={employee.unsupportedActions} compact /> : null}
        <DetailGrid
          items={[
            ["质量焦点", employee.quality?.rootCauseFocus],
            ["审核门禁", employee.reviewGate || promptConfig.promptReviewGate],
            ["Review Spec", employee.reviewOutputSpec?.contractVersion],
            ["Badcase 边界", "只保存安全摘要、错误码、影响范围和复盘结论"],
          ]}
        />
      </section>
      {badcases.length ? (
        <section className="employee-cockpit-section">
          <div className="employee-config-section-head">
            <AlertTriangle size={16} />
            <span>
              <strong>Badcase 摘要</strong>
              <small>只展示平台允许的安全摘要</small>
            </span>
          </div>
          <div className="employee-badcase-list">
            {badcases.slice(0, 4).map((badcase) => (
              <article className="employee-badcase-item" key={badcase.id || badcase.errorCode || badcase.title}>
                <span className="status-pill warn">{badcase.severity || badcase.status || "待复盘"}</span>
                <strong>{badcase.title || badcase.errorCode || "质量事件"}</strong>
                <small>{badcase.expectedBehavior || badcase.summary || badcase.rootCauseCategory || "安全摘要待补齐"}</small>
              </article>
            ))}
          </div>
        </section>
      ) : null}
    </>
  );
}

function EmployeeAdvancedPanel({
  employee,
  modelBinding,
  promptConfig,
  packageBundleItems,
  hasDeclaredPackage,
  basicSkillNames,
  businessSkillNames,
}) {
  return (
    <section className="employee-cockpit-section">
      <div className="employee-config-section-head">
        <Code2 size={16} />
        <span>
          <strong>高级配置</strong>
          <small>主键、Prompt 指纹、包声明、接口边界</small>
        </span>
      </div>
      <DetailGrid
        items={[
          ["员工主键", employee.id],
          ["归属部门主键", employee.ownerDepartmentId || employee.departmentId],
          ["负责人主键", employee.ownerUserId],
          ["模型 ID", modelBinding.modelId],
          ["Provider Route", modelBinding.providerRouteId || "由控制面分配"],
          ["所需能力版本", modelBinding.requiredCapabilityProfileVersion || "未限定"],
          ["reasoning.effort", modelBinding.modelLevelLabel || "未配置"],
          ["模型状态", modelBinding.modelStatus || modelBinding.status || "未配置"],
          ["Prompt scope", promptConfig.promptScope],
          ["Prompt 指纹", promptConfig.promptHash || "待生成"],
          ["Raw Prompt", promptConfig.rawPromptStored ? "不合规：需迁出" : "未保存"],
          ["安装包格式", employee.packageFormat],
          ["包/平台边界", employee.packageRecordBoundary || employee.packageBoundary?.boundarySummary],
          ["输出契约", employee.outputContract],
          ["审核门禁", employee.reviewGate],
        ]}
      />
      {employee.packageIncludes?.length ? <SkillChips title="完整包内容" items={employee.packageIncludes} compact /> : null}
      {hasDeclaredPackage && packageBundleItems.length ? <SkillChips title="下载包包含 Skill" items={packageBundleItems} compact /> : null}
      {employee.packageBoundary?.portableContents?.length ? <SkillChips title="包内能力声明" items={employee.packageBoundary.portableContents} compact /> : null}
      {employee.packageBoundary?.platformRecords?.length ? <SkillChips title="平台闭环记录" items={employee.packageBoundary.platformRecords} compact /> : null}
      {employee.registryRules?.length ? <SkillChips title="登记拆分规则" items={employee.registryRules} compact /> : null}
      {employee.reviewOutputSpec ? <ReviewOutputSpec spec={employee.reviewOutputSpec} /> : null}
      {employee.apiEndpoints?.length ? <SkillChips title="API 文档" items={apiDocSummary(employee.apiEndpoints)} /> : null}
      {employee.sourceTargets?.length ? <SkillChips title="来源" items={employee.sourceTargets} /> : null}
      {basicSkillNames.length ? <SkillChips title="基础技能" items={basicSkillNames} /> : null}
      {businessSkillNames.length ? <SkillChips title="专项业务技能" items={businessSkillNames} /> : null}
    </section>
  );
}

function EmployeeProductOverview({
  employee,
  badcases,
  basicSkillNames,
  businessSkillNames,
  modelBinding,
  promptConfig,
  channels = [],
  statusClass,
}) {
  const permissionLabel = employeePermissionLabel(employee);
  const qualityState = employeeQualityState(employee, badcases);
  const statusTone = typeof statusClass === "function" ? statusClass(employee.status) : "muted";
  const enabledSkillCount = basicSkillNames.length + businessSkillNames.length;
  const capabilityItems = previewItems(employee.capabilities?.length ? employee.capabilities : [employee.objective]);
  const boundaryItems = previewItems([
    ...(employee.unsupportedActions || []),
    ...(employee.constraints || []),
    employee.reviewGate,
  ]);
  const configItems = [
    ["Channels", channels.length ? channels.join(" / ") : "待配置"],
    ["模型", modelBindingSummary(modelBinding)],
    ["Prompt", promptConfig.promptVersion || "未配置"],
    ["负责人", employee.owner || "未指定"],
  ];
  const cards = [
    {
      label: "当前状态",
      value: employee.status || "未配置",
      detail: employeeStatusDetail(employee.status),
      icon: <Activity size={16} />,
      tone: statusTone,
    },
    {
      label: "可用范围",
      value: permissionLabel,
      detail: employee.permissionSummary || employee.department || "按组织权限控制",
      icon: <KeyRound size={16} />,
      tone: "info",
    },
    {
      label: "技能开关",
      value: `${enabledSkillCount} 个已启用`,
      detail: `${basicSkillNames.length} 基础 · ${businessSkillNames.length} 专项`,
      icon: <Layers3 size={16} />,
      tone: "good",
    },
    {
      label: "风险/质量",
      value: qualityState.label,
      detail: qualityState.detail,
      icon: qualityState.tone === "good" ? <ShieldCheck size={16} /> : <AlertTriangle size={16} />,
      tone: qualityState.tone,
    },
  ];

  return (
    <section className="employee-product-overview">
      <div className="employee-product-cards">
        {cards.map((card) => (
          <div className={`employee-product-card is-${card.tone || "muted"}`} key={card.label}>
            <span className="employee-product-card-icon" aria-hidden="true">
              {card.icon}
            </span>
            <span>
              <small>{card.label}</small>
              <strong>{card.value}</strong>
              <em>{card.detail}</em>
            </span>
          </div>
        ))}
      </div>

      <div className="employee-product-panels">
        <article className="employee-product-panel">
          <div className="employee-product-panel-title">
            <BadgeCheck size={16} />
            <strong>可处理工作</strong>
          </div>
          <ul>
            {(capabilityItems.length ? capabilityItems : ["暂无能力声明，需补齐员工职责说明。"]).map((item) => (
              <li key={item}>{item}</li>
            ))}
          </ul>
        </article>
        <article className="employee-product-panel">
          <div className="employee-product-panel-title">
            <AlertTriangle size={16} />
            <strong>边界与门禁</strong>
          </div>
          <ul>
            {(boundaryItems.length ? boundaryItems : ["暂无额外边界，按部门权限和人工复核执行。"]).map((item) => (
              <li key={item}>{item}</li>
            ))}
          </ul>
        </article>
        <article className="employee-product-panel">
          <div className="employee-product-panel-title">
            <Settings2 size={16} />
            <strong>当前配置</strong>
          </div>
          <dl>
            {configItems.map(([label, value]) => (
              <div key={label}>
                <dt>{label}</dt>
                <dd>{value}</dd>
              </div>
            ))}
          </dl>
        </article>
      </div>
    </section>
  );
}

function ReviewOutputSpec({ spec }) {
  return (
    <div className="governance-block compact">
      <div className="governance-line">
        <History size={15} />
        <span>会写规范</span>
        <b>{spec.contractVersion}</b>
        <b>{spec.writebackTarget}</b>
      </div>
      <SkillChips title="必填字段" items={spec.requiredFields || []} compact />
      {spec.uiDisplay ? <small className="model-binding-note">{spec.uiDisplay}</small> : null}
      {spec.privacyBoundary ? <small className="model-binding-note">{spec.privacyBoundary}</small> : null}
    </div>
  );
}

function ModelBindingPanel({ employee, binding, canConfigureEmployee, onSave }) {
  const configuredModel = digitalEmployeeModelCatalog.find((model) => model.id === binding.modelId);
  const initialModel = configuredModel || digitalEmployeeModelCatalog[0];
  const initialModelId = initialModel?.id || "";
  const initialLevelOptions = supportedLevelsForModel(initialModelId);
  const initialLevelId = initialLevelOptions.some((level) => level.id === binding.modelLevelId)
    ? binding.modelLevelId
    : initialModel?.defaultLevelId || initialLevelOptions[0]?.id || "";
  const [modelId, setModelId] = useState(initialModelId);
  const [modelLevelId, setModelLevelId] = useState(initialLevelId);
  const initialRequestTypes = requestTypesForEmployee(employee);
  const [assignedRequestTypes, setAssignedRequestTypes] = useState(initialRequestTypes);
  const [saveState, setSaveState] = useState("idle");
  const [saveError, setSaveError] = useState("");
  const selectedModel = digitalEmployeeModelCatalog.find((model) => model.id === modelId) || initialModel;
  const levelOptions = supportedLevelsForModel(modelId);
  const selectedLevel = levelOptions.find((level) => level.id === modelLevelId) || levelOptions[0] || aiModelLevels[0];
  const taskBindingSummaries = taskModelBindingSummaries(employee);
  const requestTypeOptions = Array.from(new Set([...workerRequestTypeOptions, ...initialRequestTypes]));

  function selectModel(nextModelId) {
    const nextModel = digitalEmployeeModelCatalog.find((model) => model.id === nextModelId) || digitalEmployeeModelCatalog[0];
    setModelId(nextModel.id);
    setModelLevelId(nextModel.defaultLevelId || supportedLevelsForModel(nextModel.id)[0]?.id || "");
  }

  async function applyModelBinding(event) {
    event.preventDefault();
    setSaveState("saving");
    setSaveError("");
    try {
      const result = await onSave({
        modelId: selectedModel.id,
        modelLevelId: selectedLevel?.id || selectedModel.defaultLevelId,
        assignedRequestTypes,
      });
      setSaveState(result?.status === "pending_review" ? "pending" : "saved");
    } catch (error) {
      setSaveState("error");
      setSaveError(error?.message || "运行配置保存失败");
    }
  }

  function toggleRequestType(type) {
    setAssignedRequestTypes((current) => current.includes(type)
      ? current.filter((item) => item !== type)
      : [...current, type]);
  }

  return (
    <section className="model-binding-panel">
      <div className="model-binding-head">
        <span className="model-binding-icon" aria-hidden="true">
          <Settings2 size={16} />
        </span>
        <div>
          <strong>模型与 Request 类型</strong>
          <p>
            默认模型：{binding.model || "未绑定模型"} / reasoning.effort={binding.modelLevelLabel || "未配置"}；任务级覆盖按 taskId 显式选择，不是 fallback。
          </p>
        </div>
        <span className="status-pill muted">{binding.modelStatus || binding.status || "未配置"}</span>
      </div>

      {canConfigureEmployee ? (
        <form className="model-binding-form" onSubmit={applyModelBinding}>
          <label>
            使用模型
            <select value={modelId} onChange={(event) => selectModel(event.target.value)}>
              {digitalEmployeeModelCatalog.map((model) => (
                <option key={model.id} value={model.id}>
                  {model.displayName || model.model}
                </option>
              ))}
            </select>
          </label>
          <label>
            推理强度
            <select value={selectedLevel?.id || ""} onChange={(event) => setModelLevelId(event.target.value)}>
              {levelOptions.map((level) => (
                <option key={level.id} value={level.id}>
                  {level.label}
                </option>
              ))}
            </select>
          </label>
          <fieldset className="worker-edit-checks model-binding-request-types">
            <legend>Request 类型</legend>
            <span className="model-binding-request-type-note">数字员工与主 Worker 共用</span>
            {requestTypeOptions.map((type) => (
              <label
                className={`${assignedRequestTypes.includes(type) ? "is-selected" : ""} ${type.includes("://") ? "is-wide" : ""}`.trim()}
                key={type}
              >
                <input
                  checked={assignedRequestTypes.includes(type)}
                  onChange={() => toggleRequestType(type)}
                  type="checkbox"
                />
                <span>{type}</span>
              </label>
            ))}
          </fieldset>
          <div className="model-binding-actions">
            <span>{selectedModel?.usage || selectedLevel?.description || "系统管理员可直接应用；其他有权用户提交后等待审核。"}</span>
            <button className="primary-action" type="submit" disabled={saveState === "saving" || !assignedRequestTypes.length}>
              {saveState === "saving" ? "提交中…" : "提交运行配置"}
            </button>
          </div>
        </form>
      ) : (
        <p className="model-binding-note">
          只有系统管理员、所属部门管理员或资产 owner 可以为 {employee.name} 调整模型、等级和 Request 类型。
        </p>
      )}

      {saveState === "saved" ? <small className="model-binding-note">模型与 Request 类型已应用，刷新页面后仍会保留。</small> : null}
      {saveState === "pending" ? <small className="model-binding-note">运行配置已提交审核；通过前继续使用当前生效版本。</small> : null}
      {saveError ? <small className="model-binding-note">保存失败：{saveError}</small> : null}
      {binding.appliedAt ? <small className="model-binding-note">最近应用：{new Date(binding.appliedAt).toLocaleString("zh-CN", { hour12: false })}</small> : null}
      {binding.providerRouteId ? <small className="model-binding-note">Route：{binding.providerRouteId} · {binding.requiredCapabilityProfileVersion || "能力版本未限定"}</small> : null}
      {taskBindingSummaries.length ? <SkillChips title="任务级模型覆盖" items={taskBindingSummaries} compact /> : null}
    </section>
  );
}

function requestTypesForEmployee(employee = {}) {
  const configured = employee.runtimeBinding?.assignedRequestTypes;
  if (Array.isArray(configured) && configured.length) return configured;
  const primaryWorker = (employee.runtimeWorkers || []).find((worker) => worker.workerRole === "primary");
  if (Array.isArray(primaryWorker?.assignedRequestTypes) && primaryWorker.assignedRequestTypes.length) {
    return primaryWorker.assignedRequestTypes;
  }
  return [...new Set([
    "数字员工运行",
    employee.businessDomain,
    employee.skillCluster,
    ...(Array.isArray(employee.sourceTargets) ? employee.sourceTargets.slice(0, 2) : []),
  ].filter(Boolean))];
}

function PromptGovernancePanel({ promptConfig }) {
  return (
    <section className="model-binding-panel prompt-governance-panel">
      <div className="model-binding-head">
        <span className="model-binding-icon" aria-hidden="true">
          <FileText size={16} />
        </span>
        <div>
          <strong>Prompt 治理配置</strong>
          <p>
            参考 HR 简历系统的 employee scope / promptVersion / promptHash 模型；这里只维护版本元数据和变更摘要，不保存 raw prompt。
          </p>
        </div>
        <span className="status-pill muted">{promptConfig.rawPromptStored ? "需脱敏" : "只读元数据"}</span>
      </div>

      <DetailGrid
        items={[
          ["Prompt 版本", promptConfig.promptVersion],
          ["版本域", promptConfig.promptScope],
          ["Prompt 指纹", promptConfig.promptHash || "待生成"],
          ["Raw Prompt", promptConfig.rawPromptStored ? "不合规：需迁出" : "未保存"],
          ["变更摘要", promptConfig.promptChangeSummary],
          ["审核门禁", promptConfig.promptReviewGate],
        ]}
      />
      <SkillChips title="Prompt Keys" items={promptConfig.promptKeys} compact />

      <p className="model-binding-note">Prompt 元数据目前只读；未接入持久化配置前，不提供“保存”或“待确认”状态。</p>
    </section>
  );
}
