import { Archive, BarChart3, CheckCircle2, ClipboardList, DatabaseZap, RefreshCcw, ShieldAlert, XCircle } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { isOpenStatus, qualityCodeText, qualityEnumText, severityClass, statusClass } from "../lib/consoleCatalog";
import { buildEvaluationDatasetRows, buildEvaluationDatasetSummary } from "../lib/managementConsoleModel";
import { DetailGrid, ExpandableList, ExpandableRow, SkillChips } from "./ConsolePrimitives";
import MetricCard from "./MetricCard";
import {
  AuditRequestBoard,
  EmployeeReviewDraftRow,
  PublishedSkillSummary,
  SkillReviewDraftRow,
  defaultEmployeeCheckedItems,
  defaultEmployeeReviewNote,
  defaultSkillReviewNote,
  employeeReviewKey,
} from "./quality/SkillEmployeeReviewPanels";

const hiddenQualityTags = new Set(["demo-case", "remove-before-production"]);

function sourceStatusClass(sourceType) {
  return sourceType === "subsystem" ? "info" : "good";
}

function sourceLine(badcase) {
  return [badcase.sourceTypeLabel, badcase.sourceName].filter(Boolean).join(" / ");
}

function formatDateTime(value) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString("zh-CN", { hour12: false });
}

function caseTimeSummary(row) {
  const occurredAt = formatDateTime(row.occurredAt);
  if (occurredAt) return `案例时间 ${occurredAt}`;
  const reportedAt = formatDateTime(row.reportedAt);
  return reportedAt ? `回流时间 ${reportedAt}` : "";
}

function visibleQualityTags(tags = []) {
  return tags.filter((tag) => !hiddenQualityTags.has(tag));
}

function QualitySourceToolbar({ context, onSourceScopeChange, onSubsystemChange }) {
  if (!context) return null;
  const sourceOptions = [
    { id: "all", label: "全部来源", count: context.counts.all },
    { id: "platform", label: "主系统", count: context.counts.platform },
    { id: "subsystem", label: "子系统", count: context.counts.subsystem },
  ];

  function handleSourceScopeChange(nextScope) {
    onSourceScopeChange(nextScope);
    if (nextScope !== "subsystem") {
      onSubsystemChange("all");
    }
  }

  return (
    <section className="quality-source-panel" aria-label="质量来源切换">
      <div className="quality-source-summary">
        <p className="eyebrow">Quality Context</p>
        <h3>{context.selectedLabel}</h3>
        <span>质量管理和测评审核共用当前来源视角</span>
      </div>
      <div className="quality-source-controls">
        <div className="quality-segmented" role="group" aria-label="来源类型">
          {sourceOptions.map((option) => (
            <button
              key={option.id}
              className={context.sourceScope === option.id ? "is-active" : ""}
              type="button"
              onClick={() => handleSourceScopeChange(option.id)}
            >
              <span>{option.label}</span>
              <b>{option.count}</b>
            </button>
          ))}
        </div>
        {context.sourceScope === "subsystem" ? (
          <label className="quality-subsystem-select">
            <span>子系统</span>
            <select value={context.selectedSubsystemId} onChange={(event) => onSubsystemChange(event.target.value)}>
              <option value="all">全部子系统</option>
              {context.subsystemOptions.map((option) => (
                <option key={option.id} value={option.id}>
                  {option.name}（{option.count}）
                </option>
              ))}
            </select>
          </label>
        ) : null}
      </div>
    </section>
  );
}

function BadcaseEmptyState({ label }) {
  return <p className="business-system-empty">{label}下没有匹配的 badcase 安全摘要。</p>;
}

export function QualityManagement({ badcases, sourceContext, onSourceScopeChange, onSubsystemChange, onReviewAction = null }) {
  const openCount = badcases.filter((item) => isOpenStatus(item.status)).length;
  const highRiskCount = badcases.filter((item) => ["P0", "P1"].includes(item.severity)).length;
  const promptLinkedCount = badcases.filter((item) => item.promptVersion).length;
  const rootCauseCount = badcases.filter((item) => item.rootCauseCategory && item.resolutionAction).length;
  const [actionState, setActionState] = useState({ id: "", status: "idle", message: "" });

  async function runReviewAction(badcase, payload) {
    if (!onReviewAction) return;
    setActionState({ id: badcase.id, status: "running", message: "处理中" });
    try {
      const result = await onReviewAction(badcase, payload);
      setActionState({ id: badcase.id, status: "done", message: result.status || "已更新" });
    } catch (error) {
      setActionState({ id: badcase.id, status: "error", message: error?.message || "操作失败" });
    }
  }

  return (
    <section className="view-stack">
      <QualitySourceToolbar context={sourceContext} onSourceScopeChange={onSourceScopeChange} onSubsystemChange={onSubsystemChange} />

      <div className="metrics-grid">
        <MetricCard label="质量事件" value={badcases.length} detail="badcase 安全摘要" />
        <MetricCard label="待闭环" value={openCount} detail={`${highRiskCount} 条 P0/P1`} />
        <MetricCard label="版本可追踪" value={promptLinkedCount} detail="绑定实体与 Prompt 版本" />
        <MetricCard label="根因动作" value={rootCauseCount} detail="用于升级前复盘" />
      </div>

      <section className="panel">
        <div className="panel-head">
          <div>
            <p className="eyebrow">Quality Management</p>
            <h2>质量闭环管理</h2>
          </div>
          <span className="status-pill good">不保存 raw prompt / payload</span>
        </div>
        <ExpandableList className="badcase-list">
          {({ openRowId, setOpenRowId }) => badcases.length ? badcases.map((badcase) => (
            <ExpandableRow
              key={badcase.id}
              rowId={badcase.id}
              listId="quality-management"
              openRowId={openRowId}
              setOpenRowId={setOpenRowId}
              icon={<ShieldAlert size={18} />}
              title={badcase.title}
              description={badcase.evidenceSummary}
              status={
                <>
                  <span className={`status-pill ${severityClass(badcase.severity)}`}>{badcase.severity}</span>
                  <span className={`status-pill ${statusClass(badcase.status)}`}>{badcase.status}</span>
                </>
              }
              summary={[
                sourceLine(badcase),
                badcase.entityType,
                badcase.entityName,
                qualityCodeText(badcase.errorCode),
                badcase.owner,
                badcase.status,
                ...visibleQualityTags(badcase.tags),
              ]}
            >
              <DetailGrid
                items={[
                  ["来源", sourceLine(badcase)],
                  ["来源事件", badcase.sourceEventId],
                  ["对象", `${badcase.entityType} / ${badcase.entityName}`],
                  ["实体版本", badcase.entityVersion],
                  ["Prompt 版本", badcase.promptVersion],
                  ["错误码", qualityCodeText(badcase.errorCode)],
                  ["错误域", qualityEnumText("errorDomain", badcase.errorDomain)],
                  ["根因类别", qualityEnumText("rootCauseCategory", badcase.rootCauseCategory)],
                  ["处理动作", qualityEnumText("resolutionAction", badcase.resolutionAction)],
                ]}
              />
              <div className="governance-meta">
                <span className={`status-pill ${sourceStatusClass(badcase.sourceType)}`}>{badcase.sourceTypeLabel}</span>
                <span>{qualityCodeText(badcase.errorCode)}</span>
                <span>{qualityEnumText("rootCauseCategory", badcase.rootCauseCategory)}</span>
                <span>{qualityEnumText("resolutionAction", badcase.resolutionAction)}</span>
              </div>
              <QualityReviewTaskPanel
                badcase={badcase}
                actionState={actionState.id === badcase.id ? actionState : null}
                onAction={(payload) => runReviewAction(badcase, payload)}
              />
            </ExpandableRow>
          )) : <BadcaseEmptyState label={sourceContext?.selectedLabel || "当前筛选"} />}
        </ExpandableList>
      </section>
    </section>
  );
}

function QualityReviewTaskPanel({ badcase, actionState, onAction }) {
  if (!badcase.qualityEventId) return null;
  const task = badcase.reviewTask || {};
  const evidenceRequest = task.evidenceRequest || null;
  const evidencePackage = task.evidencePackage || null;
  const busy = actionState?.status === "running";
  const nextAction = nextQualityAction(badcase);

  return (
    <section className="quality-review-task">
      <div className="quality-review-task-head">
        <div>
          <p className="eyebrow">Review Task</p>
          <h3>{task.status || "待发起复盘"}</h3>
          <span>{task.currentGate || "平台 reviewer 发起后，HR 子系统会收到脱敏证据请求。"}</span>
        </div>
        {nextAction ? (
          <button className="quality-review-action" type="button" disabled={busy} onClick={() => onAction(nextAction.payload)}>
            {busy ? "处理中" : nextAction.label}
          </button>
        ) : null}
      </div>
      {actionState?.message ? <p className={`quality-review-feedback ${actionState.status}`}>{actionState.message}</p> : null}
      <DetailGrid
        items={[
          ["证据模板", evidenceRequest?.evidenceTemplate || evidencePackage?.evidenceTemplate],
          ["证据请求", evidenceRequest?.status],
          ["证据提交", evidencePackage?.submittedAt ? `${evidencePackage.status} / ${evidencePackage.submittedBy}` : ""],
          ["申请岗位分类", evidencePackage?.applicationRoleClass],
          ["推荐岗位分类", evidencePackage?.recommendedRoleClass],
          ["岗位分类版本", evidencePackage?.jdTaxonomyVersion],
          ["回归样本", task.regressionPlan?.regressionCaseId],
          ["关闭原因", task.closure?.closeReason],
        ]}
      />
      {evidenceRequest?.requiredFields?.length ? (
        <SkillChips title="需提交" items={evidenceRequest.requiredFields} compact />
      ) : null}
      {evidenceRequest?.forbiddenFields?.length ? (
        <SkillChips title="禁止提交" items={evidenceRequest.forbiddenFields} compact />
      ) : null}
      {evidencePackage?.privacyBoundary ? (
        <p className="quality-review-privacy">{evidencePackage.privacyBoundary}</p>
      ) : null}
    </section>
  );
}

function nextQualityAction(badcase) {
  const status = badcase.status || "";
  if (!badcase.reviewTask) {
    return {
      label: "发起复盘",
      payload: {
        action: "start_review",
        evidenceTemplate: "role_match_conflict_v1",
        requestNote: "请 HR 系统提交岗位分类冲突脱敏证据包。",
      },
    };
  }
  if (status === "待平台确认根因") {
    return {
      label: "确认根因",
      payload: {
        action: "confirm_root_cause",
        rootCauseCategory: badcase.rootCauseCategory || "jd_taxonomy_gap",
        resolutionAction: badcase.resolutionAction || "jd_taxonomy_update",
        summary: "平台确认该 badcase 的根因和处理动作。",
      },
    };
  }
  if (status === "待整改") {
    return {
      label: "记录整改",
      payload: {
        action: "set_remediation",
        owner: badcase.owner || badcase.departmentId || "质量 owner",
        summary: "已记录整改计划，等待回归验证。",
      },
    };
  }
  if (status === "待回归验证") {
    return {
      label: "回归通过",
      payload: {
        action: "mark_regression",
        regressionCaseId: `REG-${badcase.qualityEventId || badcase.id}`,
        regressionStatus: "passed",
        summary: "已加入回归样本并通过验证。",
      },
    };
  }
  if (status === "待关闭") {
    return {
      label: "关闭复盘",
      payload: {
        action: "close_review",
        closeReason: "根因、整改和回归验证已完成。",
      },
    };
  }
  return null;
}

function skillReviewQueueViewFromHash() {
  if (typeof window === "undefined") return "employees";
  const [, queueView] = String(window.location.hash || "").replace(/^#\/?/, "").split("/");
  return ["employees", "completedEmployees", "departmentChanges", "skills", "auditRequests"].includes(queueView)
    ? queueView
    : "employees";
}

export function SkillEmployeeReview({ requests, onQueueChange = null, onEmployeeCatalogChange = null, onCatalogChange = null }) {
  const [skillReviewQueue, setSkillReviewQueue] = useState({
    status: "loading",
    pendingDrafts: [],
    pendingEmployeeDrafts: [],
    completedEmployeeDrafts: [],
    employeeReviews: [],
    publications: [],
    qualityEvents: [],
    error: "",
  });
  const [queueView, setQueueView] = useState(skillReviewQueueViewFromHash);
  const [reviewNotes, setReviewNotes] = useState({});
  const [reviewStatus, setReviewStatus] = useState({});
  const [preReviewStatus, setPreReviewStatus] = useState({});
  const [departmentChangeQueue, setDepartmentChangeQueue] = useState({ status: "loading", requests: [], error: "" });
  const [feedback, setFeedback] = useState("");
  const scheduledCount = requests.filter((request) => request.preReview?.triggerMode === "scheduled-scan").length;
  const completedPreReviews = requests.filter((request) => request.preReview?.status === "completed").length;
  const readySkillDrafts = useMemo(
    () => skillReviewQueue.pendingDrafts.filter((draft) => ["待技能评审", "approved_deployment_failed"].includes(draft.status)),
    [skillReviewQueue.pendingDrafts],
  );
  const pendingEmployeeDrafts = useMemo(
    () => skillReviewQueue.pendingEmployeeDrafts.filter((draft) => draft.status === "待人员审批"),
    [skillReviewQueue.pendingEmployeeDrafts],
  );
  const completedEmployeeDrafts = useMemo(
    () => skillReviewQueue.completedEmployeeDrafts.filter((draft) => draft.personnelApproval?.status === "personnel_approval_passed"),
    [skillReviewQueue.completedEmployeeDrafts],
  );
  const skillReviewCount = readySkillDrafts.length;
  const pendingDepartmentChanges = useMemo(
    () => departmentChangeQueue.requests.filter((request) => request.status === "pending_review"),
    [departmentChangeQueue.requests],
  );
  const queueViewTitle = {
    employees: "待人员审批数字员工",
    completedEmployees: "已通过数字员工记录",
    departmentChanges: "数字员工归属审批",
    skills: "Skill 评审与发布记录",
    auditRequests: "外部审计 Request 评审看板",
  }[queueView] || "待人员审批数字员工";

  async function loadSkillReviewQueue() {
    setSkillReviewQueue((current) => ({ ...current, status: "loading", error: "" }));
    try {
      const response = await fetch("/api/quality-reviews/skill-employee", { credentials: "include" });
      const data = await response.json().catch(() => ({}));
      if (!response.ok || !data.ok) throw new Error(data.error || "待技能评审队列读取失败");
      const nextQueue = {
        status: "ready",
        pendingDrafts: data.pendingDrafts || [],
        pendingEmployeeDrafts: data.pendingEmployeeDrafts || [],
        completedEmployeeDrafts: data.completedEmployeeDrafts || [],
        employeeReviews: data.employeeReviews || [],
        publications: data.publications || [],
        qualityEvents: data.qualityEvents || [],
        error: "",
      };
      setSkillReviewQueue(nextQueue);
      onQueueChange?.(nextQueue);
    } catch (error) {
      setSkillReviewQueue({
        status: "error",
        pendingDrafts: [],
        pendingEmployeeDrafts: [],
        completedEmployeeDrafts: [],
        employeeReviews: [],
        publications: [],
        qualityEvents: [],
        error: error?.message || "待技能评审队列读取失败",
      });
    }
  }

  async function loadDepartmentChangeQueue() {
    setDepartmentChangeQueue((current) => ({ ...current, status: "loading", error: "" }));
    try {
      const response = await fetch("/api/digital-employee-department-changes", { credentials: "include" });
      const data = await response.json().catch(() => ({}));
      if (!response.ok || !data.ok) throw new Error(data.message || data.error || "归属审批队列读取失败");
      setDepartmentChangeQueue({ status: "ready", requests: data.requests || [], error: "" });
    } catch (error) {
      setDepartmentChangeQueue({ status: "error", requests: [], error: error?.message || "归属审批队列读取失败" });
    }
  }

  async function submitDepartmentChangeDecision(request, decision) {
    const reviewKey = request.id;
    setReviewStatus((current) => ({ ...current, [reviewKey]: { state: "loading", message: "" } }));
    setFeedback("");
    try {
      const response = await fetch(`/api/digital-employee-department-changes/${encodeURIComponent(request.id)}/decision`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          decision,
          note: reviewNotes[reviewKey] || (decision === "approved" ? "归属、Owner、权限和 Skill 影响已确认。" : "归属变更退回补充。"),
        }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok || !data.ok) throw new Error(data.message || data.error || "归属变更审批失败");
      const message = decision === "approved" ? `${request.employeeName} 归属变更已批准。` : `${request.employeeName} 归属变更已驳回。`;
      setReviewStatus((current) => ({ ...current, [reviewKey]: { state: "ready", message } }));
      setFeedback(message);
      await loadDepartmentChangeQueue();
      await onEmployeeCatalogChange?.();
    } catch (error) {
      setReviewStatus((current) => ({
        ...current,
        [reviewKey]: { state: "error", message: error?.message || "归属变更审批失败" },
      }));
    }
  }

  async function submitSkillDraftReview(draft, decision) {
    const reviewKey = `${draft.jobId}-${draft.draftId}`;
    setReviewStatus((current) => ({ ...current, [reviewKey]: { state: "loading", message: "" } }));
    setFeedback("");
    try {
      const response = await fetch("/api/quality-reviews/skill-employee", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          jobId: draft.jobId,
          draftId: draft.draftId,
          decision,
          safeNotes: reviewNotes[reviewKey] || defaultSkillReviewNote(decision, draft),
          checkedItems: ["Agent 预审核结果", "Skill ID / sourceSkillId", "输入输出契约", "工具和权限声明", "Prompt 元数据", "挂载影响", "回归候选"],
        }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok || !data.ok) throw new Error(data.message || data.error || "技能评审提交失败");
      const deploymentFailed = data.publication?.status === "approved_deployment_failed";
      setReviewStatus((current) => ({
        ...current,
        [reviewKey]: {
          state: "ready",
          message: deploymentFailed ? "审核通过，但部署失败，尚未生效。原有效版本保持不变。" : decision === "approved" ? "已写入专项业务技能目录。" : "已驳回补充。",
        },
      }));
      setFeedback(deploymentFailed ? `${draft.name} 审核通过，但部署失败；修复后可重试，原有效版本保持不变。` : decision === "approved" ? `${draft.name} 已写入专项业务技能目录。` : `${draft.name} 已退回补充。`);
      await loadSkillReviewQueue();
      if (decision === "approved") await onCatalogChange?.();
    } catch (error) {
      setReviewStatus((current) => ({
        ...current,
        [reviewKey]: { state: "error", message: error?.message || "技能评审提交失败" },
      }));
    }
  }

  async function submitEmployeeDraftReview(draft, action) {
    const reviewKey = employeeReviewKey(draft);
    setReviewStatus((current) => ({ ...current, [reviewKey]: { state: "loading", message: "" } }));
    setFeedback("");
    try {
      const body = {
        reviewType: "employee",
        jobId: draft.jobId,
        draftId: draft.draftId,
        safeNotes: reviewNotes[reviewKey] || defaultEmployeeReviewNote(action, draft),
        checkedItems: defaultEmployeeCheckedItems(action),
      };
      body.decision = action === "reject_personnel" ? "rejected" : "approved";
      const response = await fetch("/api/quality-reviews/skill-employee", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok || !data.ok) throw new Error(data.error || "员工评审提交失败");
      const message = action === "reject_personnel"
        ? `${draft.name} 已退回补充。`
        : `${draft.name} 人员审批已通过并上线。`;
      setReviewStatus((current) => ({
        ...current,
        [reviewKey]: { state: "ready", message },
      }));
      setFeedback(message);
      await loadSkillReviewQueue();
      await onEmployeeCatalogChange?.();
    } catch (error) {
      setReviewStatus((current) => ({
        ...current,
        [reviewKey]: { state: "error", message: error?.message || "员工评审提交失败" },
      }));
    }
  }

  async function rerunAgentPreReview(draft) {
    const reviewKey = `${draft.jobId}-${draft.draftId}`;
    setPreReviewStatus((current) => ({ ...current, [reviewKey]: { state: "loading", message: "AI 预审核执行中..." } }));
    setFeedback("");
    try {
      const response = await fetch("/api/quality-reviews/skill-employee/pre-review", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jobId: draft.jobId, draftId: draft.draftId }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok || !data.ok) throw new Error(data.error || data.nextGate || "AI 预审核失败");
      setPreReviewStatus((current) => ({
        ...current,
        [reviewKey]: {
          state: "ready",
          message: data.agentPreReview?.errorCode
            ? `AI 预审核完成，错误码：${data.agentPreReview.errorCode}`
            : "AI 预审核完成。",
        },
      }));
      await loadSkillReviewQueue();
    } catch (error) {
      setPreReviewStatus((current) => ({
        ...current,
        [reviewKey]: { state: "error", message: error?.message || "AI 预审核失败" },
      }));
    }
  }

  useEffect(() => {
    loadSkillReviewQueue();
    loadDepartmentChangeQueue();
  }, []);

  function refreshReviewQueues() {
    loadSkillReviewQueue();
    loadDepartmentChangeQueue();
  }

  return (
    <section className="view-stack">
      <div className="metrics-grid">
        <MetricCard label="待人员审批" value={pendingEmployeeDrafts.length} detail="等待 owner/RBAC 审批" onClick={() => { setQueueView("employees"); loadSkillReviewQueue(); }} />
        <MetricCard label="待归属审批" value={pendingDepartmentChanges.length} detail="提交后进入独立审批环节" onClick={() => { setQueueView("departmentChanges"); loadDepartmentChangeQueue(); }} />
        <MetricCard label="已通过记录" value={completedEmployeeDrafts.length} detail="人员审批通过后在线" onClick={() => { setQueueView("completedEmployees"); loadSkillReviewQueue(); }} />
        <MetricCard label="待技能评审" value={skillReviewCount} detail={`${readySkillDrafts.length} 个 Skill 草案`} onClick={() => { setQueueView("skills"); loadSkillReviewQueue(); }} />
        <MetricCard label="MVP 已发布" value={skillReviewQueue.publications.length} detail="进程内发布记录" onClick={loadSkillReviewQueue} />
        <MetricCard label="审计请求" value={requests.length} detail="外部审计 Request" onClick={() => { setQueueView("auditRequests"); loadSkillReviewQueue(); }} />
        <MetricCard label="预审完成" value={completedPreReviews} detail={`${scheduledCount} 个来自定时补扫`} />
      </div>

      <section className="panel">
        <div className="panel-head">
          <div>
            <p className="eyebrow">Skill / Employee Review</p>
            <h2>{queueViewTitle}</h2>
          </div>
          <div className="review-panel-tools">
            <div className="review-queue-toolbar" role="group" aria-label="评审队列切换">
              <button
                className={queueView === "employees" ? "review-queue-tab is-active" : "review-queue-tab"}
                type="button"
                aria-pressed={queueView === "employees"}
                onClick={() => setQueueView("employees")}
              >
                <span>员工审批</span>
                <b>{pendingEmployeeDrafts.length}</b>
              </button>
              <button
                className={queueView === "completedEmployees" ? "review-queue-tab is-active" : "review-queue-tab"}
                type="button"
                aria-pressed={queueView === "completedEmployees"}
                onClick={() => setQueueView("completedEmployees")}
              >
                <span>已通过</span>
                <b>{completedEmployeeDrafts.length}</b>
              </button>
              <button
                className={queueView === "departmentChanges" ? "review-queue-tab is-active" : "review-queue-tab"}
                type="button"
                aria-pressed={queueView === "departmentChanges"}
                onClick={() => setQueueView("departmentChanges")}
              >
                <span>归属审批</span>
                <b>{pendingDepartmentChanges.length}</b>
              </button>
              <button
                className={queueView === "skills" ? "review-queue-tab is-active" : "review-queue-tab"}
                type="button"
                aria-pressed={queueView === "skills"}
                onClick={() => setQueueView("skills")}
              >
                <span>Skill 评审</span>
                <b>{skillReviewCount}</b>
              </button>
              <button
                className={queueView === "auditRequests" ? "review-queue-tab is-active" : "review-queue-tab"}
                type="button"
                aria-pressed={queueView === "auditRequests"}
                onClick={() => setQueueView("auditRequests")}
              >
                <span>审计请求</span>
                <b>{requests.length}</b>
              </button>
            </div>
            <button
              className="review-refresh-button"
              type="button"
              onClick={refreshReviewQueues}
              disabled={skillReviewQueue.status === "loading" || departmentChangeQueue.status === "loading"}
            >
              <RefreshCcw size={16} />
              <span>{skillReviewQueue.status === "loading" || departmentChangeQueue.status === "loading" ? "刷新中" : "刷新"}</span>
            </button>
          </div>
        </div>
        {feedback ? <p className="status-note">{feedback}</p> : null}
        {skillReviewQueue.status === "error" && queueView !== "departmentChanges" ? (
          <p className="business-system-empty">{skillReviewQueue.error}</p>
        ) : queueView === "employees" ? (
          pendingEmployeeDrafts.length ? (
            <ExpandableList>
              {({ openRowId, setOpenRowId }) => pendingEmployeeDrafts.map((draft) => (
                <EmployeeReviewDraftRow
                  key={`${draft.jobId}-${draft.draftId}`}
                  draft={draft}
                  openRowId={openRowId}
                  reviewNotes={reviewNotes}
                  reviewStatus={reviewStatus}
                  setOpenRowId={setOpenRowId}
                  onNoteChange={(note) => setReviewNotes((current) => ({ ...current, [employeeReviewKey(draft)]: note }))}
                  onAction={(action) => submitEmployeeDraftReview(draft, action)}
                />
              ))}
            </ExpandableList>
          ) : (
            <p className="business-system-empty">
              {skillReviewQueue.status === "loading" ? "正在读取待人员审批队列..." : "当前没有待人员审批数字员工。"}
            </p>
          )
        ) : queueView === "completedEmployees" ? (
          completedEmployeeDrafts.length ? (
            <ExpandableList>
              {({ openRowId, setOpenRowId }) => completedEmployeeDrafts.map((draft) => (
                <EmployeeReviewDraftRow
                  key={`${draft.jobId}-${draft.draftId}`}
                  draft={draft}
                  openRowId={openRowId}
                  reviewNotes={reviewNotes}
                  reviewStatus={reviewStatus}
                  setOpenRowId={setOpenRowId}
                  readOnly
                />
              ))}
            </ExpandableList>
          ) : (
            <p className="business-system-empty">
              {skillReviewQueue.status === "loading" ? "正在读取已通过员工记录..." : "当前没有已通过数字员工审核记录。"}
            </p>
          )
        ) : queueView === "departmentChanges" ? (
          departmentChangeQueue.status === "error" ? (
            <p className="business-system-empty">{departmentChangeQueue.error}</p>
          ) : pendingDepartmentChanges.length ? (
            <ExpandableList>
              {({ openRowId, setOpenRowId }) => pendingDepartmentChanges.map((request) => (
                <DepartmentChangeReviewRow
                  key={request.id}
                  request={request}
                  openRowId={openRowId}
                  setOpenRowId={setOpenRowId}
                  reviewNote={reviewNotes[request.id] || ""}
                  reviewStatus={reviewStatus[request.id]}
                  onNoteChange={(note) => setReviewNotes((current) => ({ ...current, [request.id]: note }))}
                  onDecision={(decision) => submitDepartmentChangeDecision(request, decision)}
                />
              ))}
            </ExpandableList>
          ) : (
            <p className="business-system-empty">
              {departmentChangeQueue.status === "loading" ? "正在读取待归属审批队列..." : "当前没有待处理的数字员工归属变更。"}
            </p>
          )
        ) : queueView === "skills" ? (
          <>
            {readySkillDrafts.length ? (
              <ExpandableList>
                {({ openRowId, setOpenRowId }) => readySkillDrafts.map((draft) => (
                  <SkillReviewDraftRow
                    key={`${draft.jobId}-${draft.draftId}`}
                    draft={draft}
                    openRowId={openRowId}
                    reviewNotes={reviewNotes}
                    reviewStatus={reviewStatus}
                    preReviewStatus={preReviewStatus}
                    setOpenRowId={setOpenRowId}
                    onNoteChange={(note) => setReviewNotes((current) => ({ ...current, [`${draft.jobId}-${draft.draftId}`]: note }))}
                    onDecision={(decision) => submitSkillDraftReview(draft, decision)}
                    onPreReview={() => rerunAgentPreReview(draft)}
                  />
                ))}
              </ExpandableList>
            ) : (
              <p className="business-system-empty">
                {skillReviewQueue.status === "loading" ? "正在读取待技能评审队列..." : "当前没有待技能评审 Skill 草案。请在专项业务技能目录确认状态，或先在系统接入页把业务 Skill 草案推进到待技能评审。"}
              </p>
            )}
          </>
        ) : (
          <AuditRequestBoard requests={requests} />
        )}
        {skillReviewQueue.publications.length ? <PublishedSkillSummary publications={skillReviewQueue.publications} /> : null}
      </section>
    </section>
  );
}

function DepartmentChangeReviewRow({ request, openRowId, setOpenRowId, reviewNote, reviewStatus, onNoteChange, onDecision }) {
  const isBusy = reviewStatus?.state === "loading";
  const canDecide = request.reviewPolicy?.canDecide !== false;
  const targetDepartments = (request.target?.departmentNames || [request.target?.departmentName]).filter(Boolean).join(" / ");

  return (
    <ExpandableRow
      rowId={request.id}
      listId="department-change-reviews"
      openRowId={openRowId}
      setOpenRowId={setOpenRowId}
      icon={<ClipboardList size={18} />}
      title={request.employeeName}
      description={`${request.current?.departmentName || "未绑定部门"} → ${targetDepartments}`}
      status={<span className={`status-pill ${statusClass(request.status)}`}>待归属审批</span>}
      summary={[request.target?.ownerName, request.reason, request.submittedBy?.name, formatDateTime(request.submittedAt)]}
    >
      <DetailGrid
        items={[
          ["申请编号", request.id],
          ["当前主责部门", request.current?.departmentName],
          ["目标归属部门", targetDepartments],
          ["新业务 Owner", request.target?.ownerName],
          ["变更原因", request.reason],
          ["计划生效", formatDateTime(request.effectiveAt)],
          ["提交人", request.submittedBy?.name],
          ["提交时间", formatDateTime(request.submittedAt)],
        ]}
      />
      <section className="approval-action-panel">
        <div className="approval-action-head">
          <div>
            <strong>归属变更审批</strong>
            <p>提交与审批仍是两个独立环节；确认归属、Owner、权限与 Skill 影响后，有权限的申请人也可审批。</p>
          </div>
          <span className={`status-pill ${canDecide ? "info" : "warn"}`}>{canDecide ? "待治理审核" : "无审批权限"}</span>
        </div>
        <textarea
          className="review-note-input"
          rows={3}
          value={reviewNote}
          onChange={(event) => onNoteChange(event.target.value)}
          placeholder="填写脱敏审批意见，例如：主责部门、协作范围、Owner 和 Skill 影响已确认。"
        />
        <div className="approval-action-buttons" role="group" aria-label={`${request.employeeName} 归属变更审批动作`}>
          <button className="ghost-action table-action approval-pass" type="button" onClick={() => onDecision("approved")} disabled={isBusy || !canDecide}>
            <CheckCircle2 size={15} />
            批准并生效
          </button>
          <button className="ghost-action table-action approval-return" type="button" onClick={() => onDecision("rejected")} disabled={isBusy || !canDecide}>
            <XCircle size={15} />
            驳回补充
          </button>
        </div>
        {!canDecide ? <small className="status-note danger-note">当前账号无此归属变更的审批权限。</small> : null}
        {reviewStatus?.message ? <small className={`status-note ${reviewStatus.state === "error" ? "danger-note" : ""}`}>{reviewStatus.message}</small> : null}
      </section>
    </ExpandableRow>
  );
}

export function EvaluationReview({ badcases, sourceContext, onSourceScopeChange, onSubsystemChange }) {
  const [datasetView, setDatasetView] = useState("pending");
  const [datasetReviewState, setDatasetReviewState] = useState({
    status: "loading",
    decisionsByCaseId: {},
    feedback: "",
    error: "",
  });
  const datasetRows = useMemo(
    () => buildEvaluationDatasetRows(badcases, datasetReviewState.decisionsByCaseId),
    [badcases, datasetReviewState.decisionsByCaseId],
  );
  const datasetSummary = useMemo(() => buildEvaluationDatasetSummary(datasetRows), [datasetRows]);
  const datasetViewOptions = useMemo(
    () => [
      { id: "pending", label: "待确认", count: datasetSummary.pending },
      { id: "archived", label: "已入库", count: datasetSummary.archived },
      { id: "all", label: "全部", count: datasetSummary.total },
    ],
    [datasetSummary],
  );
  const activeDatasetView = datasetViewOptions.find((option) => option.id === datasetView) || datasetViewOptions[0];
  const visibleDatasetRows = useMemo(() => {
    if (datasetView === "pending") return datasetRows.filter((row) => row.reviewStatus === "pending");
    if (datasetView === "archived") return datasetRows.filter((row) => row.reviewStatus === "approved" || row.evalStatus === "archived");
    return datasetRows;
  }, [datasetRows, datasetView]);

  async function loadEvaluationDatasetReviews() {
    setDatasetReviewState((current) => ({ ...current, status: "loading", error: "" }));
    try {
      const response = await fetch("/api/quality-reviews/evaluation-dataset", { credentials: "include" });
      const data = await response.json().catch(() => ({}));
      if (!response.ok || !data.ok) throw new Error(data.error || "测评集确认记录读取失败");
      setDatasetReviewState({
        status: "ready",
        decisionsByCaseId: data.decisionsByCaseId || {},
        feedback: "",
        error: "",
      });
    } catch (error) {
      setDatasetReviewState((current) => ({
        ...current,
        status: "error",
        error: error?.message || "测评集确认记录读取失败",
      }));
    }
  }

  async function submitEvaluationDatasetReview(row) {
    setDatasetReviewState((current) => ({
      ...current,
      status: "submitting",
      feedback: "",
      error: "",
    }));
    const { badcase } = row;
    try {
      const response = await fetch("/api/quality-reviews/evaluation-dataset", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          caseId: row.caseId,
          sourceEventId: badcase.sourceEventId,
          badcaseId: badcase.id,
          sourceSystemId: badcase.sourceSystemId,
          title: badcase.title,
          sourceName: badcase.sourceName,
          sourceType: badcase.sourceType,
          sourceTypeLabel: badcase.sourceTypeLabel,
          eventType: badcase.eventType,
          entityType: badcase.entityType,
          entityId: badcase.entityId,
          entityName: badcase.entityName,
          severity: badcase.severity,
          qualityStatus: badcase.status,
          errorDomain: badcase.errorDomain,
          errorCode: badcase.errorCode,
          entityVersion: badcase.entityVersion,
          promptVersion: badcase.promptVersion,
          owner: badcase.owner,
          rootCauseCategory: badcase.rootCauseCategory,
          resolutionAction: badcase.resolutionAction,
          evidenceSummary: badcase.evidenceSummary,
          expectedSummary: badcase.expectedSummary,
          actualSummary: badcase.actualSummary,
          occurredAt: row.occurredAt || badcase.occurredAt || "",
          reportedAt: row.reportedAt || badcase.reportedAt || "",
          lastRunAt: row.lastRunAt || badcase.lastRunAt || "",
          lastRunId: row.lastRunId || badcase.lastRunId || "",
          lastRunStatus: row.lastRunStatus || badcase.lastRunStatus || "not_run",
          lastRunSummary: row.lastRunSummary || badcase.lastRunSummary || "",
          tags: badcase.tags || [],
          decision: "approved",
          reviewNote: `确认 ${badcase.entityName || badcase.title} 的已关闭/候选问题进入 MVP 测评集。`,
        }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok || !data.ok) throw new Error(data.error || "测评集确认失败");
      setDatasetReviewState({
        status: "ready",
        decisionsByCaseId: data.decisionsByCaseId || {
          ...datasetReviewState.decisionsByCaseId,
          [row.caseId]: data.review,
        },
        feedback: "已确认入测评集，可在已入库视图查看。",
        error: "",
      });
    } catch (error) {
      setDatasetReviewState((current) => ({
        ...current,
        status: "error",
        error: error?.message || "测评集确认失败",
      }));
    }
  }

  useEffect(() => {
    loadEvaluationDatasetReviews();
  }, []);

  return (
    <section className="view-stack">
      <QualitySourceToolbar context={sourceContext} onSourceScopeChange={onSourceScopeChange} onSubsystemChange={onSubsystemChange} />

      <div className="metrics-grid">
        <MetricCard label="候选样本" value={datasetSummary.total} detail={`${datasetSummary.pending} 条待确认入库`} />
        <MetricCard label="已入测评集" value={datasetSummary.archived} detail={`${datasetSummary.closed} 条质量问题已关闭`} />
        <MetricCard label="门禁完整" value={datasetSummary.qualityReady} detail={`${datasetSummary.needsCriteria} 条待补标准`} />
        <MetricCard
          label="Latest 通过率"
          value={datasetSummary.passRate === null ? "--" : `${datasetSummary.passRate}%`}
          detail={datasetSummary.runTotal ? `${datasetSummary.runStats.passed || 0}/${datasetSummary.runTotal} 已运行` : "等待首次回归运行"}
        />
      </div>

      <section className="panel evaluation-ops-panel">
        <div className="panel-head">
          <div>
            <p className="eyebrow">Evaluation Dataset Ops</p>
            <h2>测评集归档统计</h2>
          </div>
          <span className="status-pill info">待审核样本通过后移入测试数据</span>
        </div>
        <div className="evaluation-ops-layout">
          <div className="evaluation-flow">
            <div>
              <span>候选</span>
              <strong>{datasetSummary.total}</strong>
              <small>P0/P1 {datasetSummary.highRisk} · 未关闭 {datasetSummary.open}</small>
            </div>
            <div>
              <span>待确认</span>
              <strong>{datasetSummary.pending}</strong>
              <small>人工确认后才进入测评集</small>
            </div>
            <div>
              <span>已归档</span>
              <strong>{datasetSummary.archived}</strong>
              <small>可参与后续回归</small>
            </div>
            <div>
              <span>回归准备</span>
              <strong>{datasetSummary.qualityReady}</strong>
              <small>{datasetSummary.runTotal ? `${datasetSummary.runTotal} 条已有运行记录` : "等待首次回归运行"}</small>
            </div>
          </div>
          <div className="evaluation-run-board">
            <div className="evaluation-run-head">
              <BarChart3 size={17} />
              <strong>Run 概览</strong>
              <span>{datasetSummary.runTotal ? `${datasetSummary.runTotal} 条已运行` : "未启动回归"}</span>
            </div>
            <div className="evaluation-run-bars" aria-label="测评运行状态分布">
              {[
                ["通过", datasetSummary.runStats.passed || 0, "good"],
                ["未通过", datasetSummary.runStats.failed || 0, "warn"],
                ["需复核", datasetSummary.runStats.needs_review || 0, "info"],
                ["未运行", datasetSummary.runStats.not_run || 0, "muted"],
              ].map(([label, value, tone]) => (
                <span key={label} data-tone={tone} style={{ "--bar-size": `${Math.max(4, datasetSummary.total ? (Number(value) / datasetSummary.total) * 100 : 4)}%` }}>
                  <b>{label}</b>
                  <em>{value}</em>
                </span>
              ))}
            </div>
          </div>
        </div>
        {datasetReviewState.feedback ? <p className="evaluation-feedback good">{datasetReviewState.feedback}</p> : null}
        {datasetReviewState.error ? <p className="evaluation-feedback warn">{datasetReviewState.error}</p> : null}
      </section>

      <section className="panel">
        <div className="panel-head evaluation-dataset-head">
          <div>
            <p className="eyebrow">Evaluation Review</p>
            <h2>测评样本入库确认</h2>
          </div>
          <div className="quality-segmented evaluation-dataset-tabs" role="group" aria-label="测评样本视图">
            {datasetViewOptions.map((option) => (
              <button
                key={option.id}
                className={datasetView === option.id ? "is-active" : ""}
                type="button"
                onClick={() => setDatasetView(option.id)}
              >
                <span>{option.label}</span>
                <b>{option.count}</b>
              </button>
            ))}
          </div>
        </div>
        <ExpandableList className="badcase-list">
          {({ openRowId, setOpenRowId }) => visibleDatasetRows.length ? visibleDatasetRows.map((row) => {
            const badcase = row.badcase;
            const isArchived = row.reviewStatus === "approved";
            const isSubmitting = datasetReviewState.status === "submitting";
            return (
            <ExpandableRow
              key={row.caseId}
              rowId={row.caseId}
              listId="evaluation-review"
              openRowId={openRowId}
              setOpenRowId={setOpenRowId}
              icon={isArchived ? <Archive size={18} /> : <ShieldAlert size={18} />}
              title={badcase.title}
              description={badcase.evidenceSummary}
              status={
                <>
                  <span className={`status-pill ${severityClass(badcase.severity)}`}>{badcase.severity}</span>
                  <span className={`status-pill ${row.statusTone}`}>{row.statusLabel}</span>
                  <span className={`status-pill ${row.lastRunTone}`}>{row.lastRunLabel}</span>
                </>
              }
              summary={[
                sourceLine(badcase),
                caseTimeSummary(row),
                badcase.entityType,
                badcase.entityName,
                qualityCodeText(badcase.errorCode),
                badcase.status,
                `门禁 ${row.qualityGate.passed}/${row.qualityGate.total}`,
                ...visibleQualityTags(badcase.tags),
              ]}
              actions={
                <div className="evaluation-row-actions">
                  <button
                    className="entity-row-action evaluation-approve-action"
                    type="button"
                    disabled={isArchived || isSubmitting}
                    title="确认该样本进入测评集"
                    onClick={() => submitEvaluationDatasetReview(row)}
                  >
                    <Archive size={14} />
                    {isArchived ? "已入库" : "确认入库"}
                  </button>
                </div>
              }
            >
              <DetailGrid
                items={[
                  ["来源", sourceLine(badcase)],
                  ["来源事件", badcase.sourceEventId],
                  ["案例时间", formatDateTime(row.occurredAt)],
                  ["回流时间", formatDateTime(row.reportedAt)],
                  ["测评对象", `${badcase.entityType} / ${badcase.entityName}`],
                  ["实体版本", badcase.entityVersion],
                  ["Prompt 版本", badcase.promptVersion],
                  ["错误码", qualityCodeText(badcase.errorCode)],
                  ["根因类别", qualityEnumText("rootCauseCategory", badcase.rootCauseCategory)],
                  ["建议动作", qualityEnumText("resolutionAction", badcase.resolutionAction)],
                  ["测评集状态", row.statusLabel],
                  ["门禁完整度", `${row.qualityGate.passed}/${row.qualityGate.total}`],
                  ["最近回归", row.lastRunLabel],
                  ["最近回归时间", formatDateTime(row.lastRunAt)],
                  ["入库确认", formatDateTime(row.reviewedAt)],
                ]}
              />
              {row.qualityGate.missing.length ? (
                <div className="evaluation-gate-warning">
                  <DatabaseZap size={16} />
                  <span>待补标准</span>
                  {row.qualityGate.missing.map((item) => <b key={item}>{item}</b>)}
                </div>
              ) : (
                <div className="evaluation-gate-warning is-ready">
                  <CheckCircle2 size={16} />
                  <span>入库门禁已完整</span>
                  <b>可确认进入测评集</b>
                </div>
              )}
              <div className="governance-meta">
                <span className={`status-pill ${sourceStatusClass(badcase.sourceType)}`}>{badcase.sourceTypeLabel}</span>
                <span>回归候选</span>
                <span>{qualityEnumText("errorDomain", badcase.errorDomain)}</span>
                <span>{badcase.owner}</span>
                {row.reviewedAt ? <span>确认人 {row.reviewer || "管理员"}</span> : null}
              </div>
            </ExpandableRow>
          );
          }) : <BadcaseEmptyState label={`${sourceContext?.selectedLabel || "当前筛选"} · ${activeDatasetView.label}`} />}
        </ExpandableList>
      </section>
    </section>
  );
}
