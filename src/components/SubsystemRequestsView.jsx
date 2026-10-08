import {
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  CircleAlert,
  ExternalLink,
  GitBranch,
  Handshake,
  Layers3,
  Network,
  RadioTower,
  ShieldCheck,
  XCircle,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { departments, personnel } from "../data/catalog";
import { qualityCodeText, qualityEnumText, qualityIssueName } from "../lib/consoleCatalog";
import { postCapabilityRequestDecision, postSubsystemAssignmentDraft } from "../lib/controlPlane";
import {
  capabilityReviewDecisionResult,
  capabilityReviewResultForRequest,
  focusedCapabilityRequestIdFromHash,
  isPendingCapabilityReview,
} from "../lib/controlPlaneReview";
import { buildBusinessSystemReviewGroups } from "../lib/managementConsoleModel";
import { DetailGrid, ExpandableList, ExpandableRow, SkillChips } from "./ConsolePrimitives";
import MetricCard from "./MetricCard";

const MANAGEMENT_SCOPE_OPTIONS = [
  { id: "capability_request", label: "能力申请" },
  { id: "distribution_mapping", label: "分发映射" },
  { id: "invocation_policy", label: "调用门禁" },
  { id: "quality_event", label: "质量回流" },
  { id: "discovery_only", label: "只读发现" },
];

function statusTone(status) {
  const value = String(status || "");
  if (value.includes("问题") || value.includes("失败") || value.includes("异常") || value.includes("拒绝")) return "bad";
  if (value.includes("待") || value.includes("试点") || value.includes("草案")) return "warn";
  if (value.includes("已纳管") || value.includes("通过") || value.includes("已确认") || value.includes("可用")) return "good";
  return "neutral";
}

function statusIcon(tone, size = 12) {
  return tone === "bad" ? <CircleAlert size={size} /> : <CheckCircle2 size={size} />;
}

function assignmentSummary(subsystem = {}) {
  const assignment = subsystem.assignmentDraft;
  if (!assignment?.updatedAt) return "";
  const scopeCount = assignment.managementScopes?.length || 0;
  return `${assignment.status || "归属草案已保存"} / ${assignment.departmentId || subsystem.departmentId} / ${scopeCount} 个范围`;
}

function qualitySummary(signal = {}) {
  return [
    `P0/P1 ${signal.p0p1Open ?? 0}`,
    `未关闭 ${signal.openBadcases ?? 0}`,
    `Eval ${signal.evalReady ?? 0}`,
    signal.lastRegressionStatus,
  ].filter(Boolean);
}

function EmptyState({ children }) {
  return <p className="business-system-empty">{children}</p>;
}

function SystemSection({ id, eyebrow, title, icon, status, summary = [], defaultOpen = false, children }) {
  const [isOpen, setIsOpen] = useState(defaultOpen);

  useEffect(() => {
    if (defaultOpen) setIsOpen(true);
  }, [defaultOpen]);

  return (
    <section className="business-system-section">
      <button
        className="business-system-section-head"
        type="button"
        aria-expanded={isOpen}
        aria-controls={`${id}-content`}
        onClick={() => setIsOpen((current) => !current)}
      >
        <span className="icon-chip">{icon}</span>
        <span className="business-system-section-title">
          <span className="eyebrow">{eyebrow}</span>
          <strong>{title}</strong>
          <span className="business-system-section-summary">
            {summary.filter(Boolean).map((item) => (
              <b key={item}>{item}</b>
            ))}
          </span>
        </span>
        {status}
        <span className="entity-cue" aria-hidden="true">
          {isOpen ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
        </span>
      </button>
      {isOpen ? (
        <div className="business-system-section-body" id={`${id}-content`}>
          {children}
        </div>
      ) : null}
    </section>
  );
}

function CollapsibleItem({ id, title, summary, status, defaultOpen = false, focused = false, children }) {
  const [isOpen, setIsOpen] = useState(defaultOpen);

  useEffect(() => {
    if (defaultOpen) setIsOpen(true);
  }, [defaultOpen]);

  return (
    <article id={id} className={`business-system-item ${isOpen ? "is-open" : "is-collapsed"} ${focused ? "is-focused" : ""}`}>
      <button
        className="business-system-item-head"
        type="button"
        aria-expanded={isOpen}
        aria-controls={`${id}-content`}
        onClick={() => setIsOpen((current) => !current)}
      >
        <span className="business-system-item-title">
          <strong>{title}</strong>
          <p>{summary}</p>
        </span>
        {status}
        <span className="entity-cue" aria-hidden="true">
          {isOpen ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
        </span>
      </button>
      {isOpen ? (
        <div className="business-system-item-body" id={`${id}-content`}>
          {children}
        </div>
      ) : null}
    </article>
  );
}

function approvalStatusTone(status) {
  if (String(status || "").includes("失败")) return "bad";
  if (String(status || "").includes("AI") || String(status || "").includes("预审")) return "info";
  if (String(status || "").includes("通过")) return "good";
  if (String(status || "").includes("待") || String(status || "").includes("退回") || String(status || "").includes("拒绝")) return "warn";
  return "muted";
}

function ApprovalActionPanel({ request, result, canManage, onDecision, isSubmitting = false }) {
  const pendingStatus = String(request.status || "").includes("AI 预审") ? "待平台人工审核" : request.status;
  const decisionStatus = result?.decision === "approved" ? "已通过审核" : result?.decision === "rejected" ? "已退回补充" : pendingStatus;
  const title = requestTitle(request);

  return (
    <section className="approval-action-panel">
      <div className="approval-action-head">
        <div>
          <strong>审核执行</strong>
          <p>当前为本地演示草案：记录审核结论、下一步门禁和影响范围，不写入生产目录。</p>
        </div>
        <span className={`status-pill ${approvalStatusTone(decisionStatus)}`}>{decisionStatus}</span>
      </div>
      {canManage ? (
        <div className="approval-action-buttons" role="group" aria-label={`${title} 审核动作`}>
          <button className="ghost-action table-action approval-pass" type="button" disabled={isSubmitting} onClick={() => onDecision(request.id, "approved")}>
            <CheckCircle2 size={15} />
            {isSubmitting ? "写入中" : "通过并生成分发草案"}
          </button>
          <button className="ghost-action table-action approval-return" type="button" disabled={isSubmitting} onClick={() => onDecision(request.id, "rejected")}>
            <XCircle size={15} />
            退回补充边界
          </button>
        </div>
      ) : (
        <p className="business-system-empty">当前会话仅可查看安全摘要和申请状态。</p>
      )}
      {result ? (
        <DetailGrid
          items={[
            ["执行状态", result.status],
            ["审核结论", result.summary],
            ["下一步", result.nextGate],
            ["执行时间", result.decidedAt],
          ]}
        />
      ) : null}
    </section>
  );
}

function requestTitle(request) {
  const name = request.capabilityName || request.targetEmployeeName || request.targetSkillName || request.customCapability?.name || request.targetEmployeeId || request.targetSkillId || request.id;
  const kind = request.capabilityKind || request.requestTypeLabel || "";
  return kind && !String(name).includes(kind) ? `${name} / ${kind}` : name;
}

function requestSummary(request) {
  return [
    request.requester ? `申请人：${request.requester}` : "",
    request.id ? `Request ID：${request.id}` : "",
    request.safeSummary,
  ].filter(Boolean).join(" ｜ ");
}

function requestTarget(request) {
  if (request.capabilityName) {
    return `${request.capabilityName} / ${request.capabilityKind || request.requestTypeLabel || request.requestType || "能力申请"}`;
  }
  return request.targetSkillId
    ? `${request.targetSkillName || request.targetSkillId} / ${request.targetSkillId}`
    : `${request.targetEmployeeName || request.targetEmployeeId || "待匹配"} / ${request.targetEmployeeId || "pending"}`;
}

function sourceAlignmentLabel(value) {
  return {
    update_existing_source: "绑定主系统已有源更新",
    create_new_source: "新增类能力归纳",
  }[value] || value || "待判定";
}

function preReviewStatusLabel(status) {
  return {
    completed: "预审完成",
    running: "预审核中",
    queued: "待执行",
    待执行: "待执行",
    failed: "执行失败",
    not_required_for_existing_source: "源对齐预审",
  }[status] || status || "待执行";
}

function preReviewRequestStatus(preReview, fallbackStatus) {
  if (!preReview?.status) return fallbackStatus;
  return {
    completed: "AI 预审完成",
    running: "AI 预审核中",
    queued: "AI 预审待执行",
    待执行: "AI 预审待执行",
    failed: "AI 预审失败",
    not_required_for_existing_source: "AI 源对齐预审",
  }[preReview.status] || fallbackStatus;
}

function shouldAutoRunPreReview(preReview) {
  return ["queued", "待执行", "not_required_for_existing_source"].includes(preReview?.status);
}

function PreReviewBlock({ preReview }) {
  if (!preReview) return null;
  const autoEvalNote = preReview.autoEval && preReview.autoEval !== "planned" ? preReview.autoEval : "后续接入 auto eval";
  const isExecuted = preReview.status === "completed" || preReview.executedAt;
  return (
    <div className="approval-action-panel">
      <div className="approval-action-head">
        <div>
          <strong>AI 预审核</strong>
          <p>
            {isExecuted
              ? "系统数字员工已完成 demo 安全摘要预审，结果已回显供提交人和审核人复核。"
              : `${autoEvalNote}；当前是预审草案/队列态，未调用真实模型或 worker。`}
          </p>
        </div>
        <span className="status-pill info">{preReviewStatusLabel(preReview.status)}</span>
      </div>
      <DetailGrid
        items={[
          ["Worker", preReview.workerName || preReview.workerId],
          ["系统员工", preReview.workerEmployeeId],
          ["Lane", preReview.lane],
          ["执行模式", preReview.executionMode],
          ["执行 ID", preReview.executionId],
          ["执行时间", preReview.executedAt ? new Date(preReview.executedAt).toLocaleString("zh-CN", { hour12: false }) : ""],
          ["置信度", preReview.confidence ? `${Math.round(preReview.confidence * 100)}%` : ""],
          ["风险等级", preReview.riskLevel],
          ["建议", preReview.recommendation],
          ["效率提升", preReview.efficiencyGain],
          ["下一步", preReview.nextGate],
          ["质量归口", preReview.qualityRoute?.target],
          ["质量事件", preReview.qualityRoute?.eventType],
          ["回测候选", preReview.qualityRoute ? (preReview.qualityRoute.evalCandidate ? "是" : "否") : ""],
        ]}
      />
      {preReview.fallbackSummary ? (
        <div className="gate-line">
          <CheckCircle2 size={16} />
          {preReview.fallbackSummary}
        </div>
      ) : null}
      {preReview.qualityRoute?.feedbackPolicy ? (
        <div className="gate-line">
          <ShieldCheck size={16} />
          质量回流：{preReview.qualityRoute.feedbackPolicy}
        </div>
      ) : null}
      <SkillChips title="预审发现" items={preReview.safeFindings || []} compact />
      <SkillChips title="缺口项" items={preReview.missingItems || []} compact />
      <SkillChips title="预期产出" items={preReview.expectedOutputs || []} compact />
    </div>
  );
}

function BusinessSystemLink({ url }) {
  if (!url) return null;
  return (
    <a className="business-system-link" href={url} target="_blank" rel="noreferrer">
      <span>{url}</span>
      <ExternalLink size={14} />
    </a>
  );
}

function buildAssignmentForm(subsystem = {}) {
  const assignmentDraft = subsystem.assignmentDraft || {};
  const scopes =
    assignmentDraft.managementScopes?.length
      ? assignmentDraft.managementScopes
      : subsystem.managementScopes?.length
        ? subsystem.managementScopes
        : subsystem.managementHandshake?.acceptedScopes?.length
          ? subsystem.managementHandshake.acceptedScopes
          : MANAGEMENT_SCOPE_OPTIONS.slice(0, 4).map((item) => item.id);
  return {
    departmentId: assignmentDraft.departmentId || subsystem.departmentId || "",
    businessDomain: assignmentDraft.businessDomain || subsystem.businessDomain || "",
    owner: assignmentDraft.owner || subsystem.owner || "",
    managementScopes: scopes.filter((scope) => MANAGEMENT_SCOPE_OPTIONS.some((option) => option.id === scope)),
    ownerConfirmed: Boolean(assignmentDraft.ownerConfirmed),
    note: assignmentDraft.note || "",
  };
}

function SubsystemAssignmentPanel({ subsystem, canManage, onSaved }) {
  const [form, setForm] = useState(() => buildAssignmentForm(subsystem));
  const [saveState, setSaveState] = useState({ state: "idle", message: "" });
  const assignmentDraft = subsystem?.assignmentDraft;
  const ownerOptions = useMemo(() => {
    const activeOwners = personnel.filter((person) => person.status !== "停用");
    const options = activeOwners.map((person) => ({
      value: person.name,
      label: `${person.name} / ${person.department}`,
    }));
    if (form.owner && !options.some((option) => option.value === form.owner)) {
      options.unshift({ value: form.owner, label: `${form.owner} / 当前登记` });
    }
    return options;
  }, [form.owner]);
  const departmentOptions = useMemo(() => {
    const options = departments.filter((department) => department.id !== "company");
    if (form.departmentId && !options.some((department) => department.id === form.departmentId)) {
      options.unshift({ id: form.departmentId, name: form.departmentId, leader: form.owner });
    }
    return options;
  }, [form.departmentId, form.owner]);

  useEffect(() => {
    setForm(buildAssignmentForm(subsystem));
  }, [
    subsystem?.id,
    subsystem?.departmentId,
    subsystem?.businessDomain,
    subsystem?.owner,
    subsystem?.assignmentDraft?.updatedAt,
  ]);

  function updateField(field, value) {
    setForm((current) => ({ ...current, [field]: value }));
  }

  function updateDepartment(departmentId) {
    const department = departments.find((item) => item.id === departmentId);
    const suggestedOwner =
      personnel.find((person) => person.departmentId === departmentId && String(person.governanceRole || "").includes("负责人")) ||
      personnel.find((person) => person.departmentId === departmentId);
    setForm((current) => ({
      ...current,
      departmentId,
      owner: suggestedOwner?.name || department?.leader || current.owner,
    }));
  }

  function toggleScope(scopeId) {
    setForm((current) => {
      const hasScope = current.managementScopes.includes(scopeId);
      return {
        ...current,
        managementScopes: hasScope
          ? current.managementScopes.filter((item) => item !== scopeId)
          : [...current.managementScopes, scopeId],
      };
    });
  }

  async function saveAssignment(event) {
    event.preventDefault();
    if (!canManage || !subsystem?.id) return;
    setSaveState({ state: "saving", message: "正在保存归属草案..." });
    try {
      const result = await postSubsystemAssignmentDraft(subsystem.id, form);
      setForm(buildAssignmentForm(result.subsystem || subsystem));
      setSaveState({ state: "saved", message: "归属草案已保存，页面已刷新控制面摘要。" });
      await onSaved?.();
    } catch (error) {
      setSaveState({ state: "error", message: error?.message || "归属草案保存失败" });
    }
  }

  const saveStatus = saveState.state === "idle" ? assignmentDraft?.status || "归属草案" : saveState.message;

  return (
    <section className="approval-action-panel subsystem-assignment-panel">
      <div className="approval-action-head">
        <div>
          <strong>归属部门与管理范围</strong>
          <p>把业务系统绑定到负责部门和业务 Owner；当前保存为 LAN MVP 治理草案，生产仍需 RBAC 与审计。</p>
        </div>
        <span className={`status-pill ${canManage ? "info" : "muted"}`}>{canManage ? saveStatus : "只读"}</span>
      </div>
      <form className="model-binding-form subsystem-assignment-form" onSubmit={saveAssignment}>
        <label>
          归属部门
          <select value={form.departmentId} onChange={(event) => updateDepartment(event.target.value)} disabled={!canManage}>
            <option value="">选择部门</option>
            {departmentOptions.map((department) => (
              <option key={department.id} value={department.id}>
                {department.name}
              </option>
            ))}
          </select>
        </label>
        <label>
          业务域
          <input value={form.businessDomain} onChange={(event) => updateField("businessDomain", event.target.value)} disabled={!canManage} />
        </label>
        <label>
          业务 Owner
          <select value={form.owner} onChange={(event) => updateField("owner", event.target.value)} disabled={!canManage}>
            <option value="">选择 Owner</option>
            {ownerOptions.map((owner) => (
              <option key={owner.value} value={owner.value}>
                {owner.label}
              </option>
            ))}
          </select>
        </label>
        <fieldset className="subsystem-scope-field" disabled={!canManage}>
          <legend>管理范围</legend>
          {MANAGEMENT_SCOPE_OPTIONS.map((scope) => (
            <label key={scope.id}>
              <input
                type="checkbox"
                checked={form.managementScopes.includes(scope.id)}
                onChange={() => toggleScope(scope.id)}
              />
              {scope.label}
            </label>
          ))}
        </fieldset>
        <label className="subsystem-assignment-note">
          草案备注
          <textarea
            value={form.note}
            onChange={(event) => updateField("note", event.target.value)}
            disabled={!canManage}
            placeholder="例如：由平台管理员根据部门 owner 申请调整归属。"
          />
        </label>
        <label className="subsystem-owner-confirm">
          <input
            type="checkbox"
            checked={form.ownerConfirmed}
            onChange={(event) => updateField("ownerConfirmed", event.target.checked)}
            disabled={!canManage}
          />
          Owner 已确认本系统归属和管理范围
        </label>
        <div className="model-binding-actions subsystem-assignment-actions">
          <span>{assignmentDraft?.reviewGate || "保存后进入部门 owner/RBAC 复核，不自动开通数字员工或 Skill 调用。"}</span>
          {canManage ? (
            <button className="ghost-action table-action approval-pass subsystem-assignment-save" type="submit" disabled={saveState.state === "saving"}>
              <CheckCircle2 size={15} />
              {saveState.state === "saving" ? "保存中" : "保存归属草案"}
            </button>
          ) : null}
        </div>
      </form>
    </section>
  );
}

function HandshakeChecklist({ handshake }) {
  if (!handshake) return <EmptyState>尚未完成主系统与业务系统的纳管握手。</EmptyState>;
  return (
    <div className="handshake-checklist">
      {(handshake.checks || []).map((check) => {
        const tone = statusTone(check.status);
        return (
          <div className={`handshake-check ${tone}`} key={check.id || check.label}>
            {statusIcon(tone)}
            <span>{check.label}</span>
            <b>{check.status}</b>
          </div>
        );
      })}
    </div>
  );
}

export default function SubsystemRequestsView({
  subsystems,
  capabilityRequests,
  distributions,
  qualityEvents,
  invocationPolicies,
  routeHash = "",
  canViewSubsystems = false,
  canManageSubsystems = false,
  onRefresh,
}) {
  const [approvalResults, setApprovalResults] = useState({});
  const [approvalSubmitting, setApprovalSubmitting] = useState({});
  const [preReviewResults, setPreReviewResults] = useState({});
  const autoPreReviewStartedRef = useRef(new Set());
  const businessSystems = useMemo(
    () =>
      buildBusinessSystemReviewGroups({
        subsystems,
        capabilityRequests,
        distributions,
        qualityEvents,
        invocationPolicies,
      }),
    [capabilityRequests, distributions, invocationPolicies, qualityEvents, subsystems],
  );
  const displayedCapabilityRequests = businessSystems.flatMap((system) => system.capabilityRequests);
  const displayedDistributions = businessSystems.flatMap((system) => system.distributions);
  const displayedQualityEvents = businessSystems.flatMap((system) => system.qualityEvents);
  const displayedInvocationPolicies = businessSystems.flatMap((system) => system.invocationPolicies);
  const focusedCapabilityRequestId = focusedCapabilityRequestIdFromHash(routeHash);
  const focusedSystemId = focusedCapabilityRequestId
    ? businessSystems.find((system) => system.capabilityRequests.some((request) => request.id === focusedCapabilityRequestId))?.id || ""
    : "";
  const approvedCount = displayedCapabilityRequests.filter((item) => capabilityReviewResultForRequest(item, approvalResults)?.decision === "approved").length;
  const pendingRequests = displayedCapabilityRequests.filter((item) => isPendingCapabilityReview(item, approvalResults)).length;
  const mappedEmployees = displayedDistributions.reduce((count, plan) => count + (plan.targetEmployeeIds?.length || 0), 0);
  const qualityOpen = displayedQualityEvents.filter((item) => String(item.status || "").includes("待")).length;
  const policyCount = displayedInvocationPolicies.length;

  async function recordApprovalDecision(requestId, decision) {
    const request = capabilityRequests.find((item) => item.id === requestId);
    const isApproved = decision === "approved";
    const title = request ? requestTitle(request) : requestId;

    setApprovalSubmitting((current) => ({ ...current, [requestId]: true }));
    try {
      const data = await postCapabilityRequestDecision(requestId, { decision });
      const result = capabilityReviewDecisionResult(data.reviewDecision || data.capabilityRequest?.reviewDecision);
      setApprovalResults((current) => ({
        ...current,
        [requestId]: result || {
          decision,
          status: isApproved ? "已通过审核" : "已退回补充",
          summary: isApproved
            ? `${title} 已通过平台人工审核。`
            : `${title} 已退回申请方补充材料。`,
          nextGate: isApproved ? "进入分发映射与调用策略确认" : "回到申请方或业务 owner 补充材料",
          decidedAt: new Date().toLocaleString("zh-CN", { hour12: false }),
        },
      }));
      await onRefresh?.();
    } catch (error) {
      setApprovalResults((current) => ({
        ...current,
        [requestId]: {
          decision: "failed",
          status: "审核写入失败",
          summary: error?.message || `${title} 审核结论写入失败`,
          nextGate: "请刷新后重试，或检查当前账号是否有控制面治理权限。",
          decidedAt: new Date().toLocaleString("zh-CN", { hour12: false }),
        },
      }));
    } finally {
      setApprovalSubmitting((current) => ({ ...current, [requestId]: false }));
    }
  }

  const runPreReview = useCallback(async (request) => {
    setPreReviewResults((current) => ({
      ...current,
      [request.id]: {
        ...(current[request.id] || request.preReview || {}),
        status: "running",
        executionMode: "demo_safe_summary",
      },
    }));

    try {
      const response = await fetch("/api/control-plane/capability-requests/pre-review", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ requestId: request.id }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok || !data.ok) throw new Error(data.error || "AI 预审核失败");
      setPreReviewResults((current) => ({
        ...current,
        [request.id]: data.preReview,
      }));
    } catch (error) {
      setPreReviewResults((current) => ({
        ...current,
        [request.id]: {
          ...(current[request.id] || request.preReview || {}),
          status: "failed",
          recommendation: "retry_or_manual_review",
          safeFindings: [error?.message || "AI 预审核失败，请人工复核。"],
        },
      }));
    }
  }, []);

  useEffect(() => {
    if (!canManageSubsystems) return;
    businessSystems.forEach((system) => {
      system.capabilityRequests.forEach((request) => {
        const preReview = preReviewResults[request.id] || request.preReview;
        if (!preReview || !shouldAutoRunPreReview(preReview) || autoPreReviewStartedRef.current.has(request.id)) return;
        autoPreReviewStartedRef.current.add(request.id);
        runPreReview(request);
      });
    });
  }, [businessSystems, canManageSubsystems, preReviewResults, runPreReview]);

  useEffect(() => {
    if (!focusedCapabilityRequestId) return undefined;
    const timer = window.setTimeout(() => {
      document.getElementById(`capability-request-${focusedCapabilityRequestId}`)?.scrollIntoView({
        block: "center",
        behavior: "smooth",
      });
    }, 120);
    return () => window.clearTimeout(timer);
  }, [focusedCapabilityRequestId, focusedSystemId]);

  if (!canViewSubsystems) {
    return (
      <section className="view-stack">
        <section className="panel empty-panel">
          <div className="panel-head">
            <div>
              <p className="eyebrow">Access Control</p>
              <h2>暂无业务系统审核权限</h2>
            </div>
            <span className="status-pill warn">治理角色可见</span>
          </div>
          <EmptyState>请先申请控制面治理、质量治理/审计或平台管理员权限。</EmptyState>
        </section>
      </section>
    );
  }

  return (
    <section className="view-stack">
      <div className="metrics-grid">
        <MetricCard label="接入业务系统" value={businessSystems.length} detail="注册执行面" />
        <MetricCard label="待评审申请" value={pendingRequests} detail="业务员工 / 技能 / 自定义能力" />
        <MetricCard label="映射员工" value={mappedEmployees} detail="分发目标" />
        <MetricCard label="审核执行" value={approvedCount} detail={`${policyCount} 条调用策略 / ${qualityOpen} 条质量回流`} />
      </div>

      <section className="panel">
        <div className="panel-head">
          <div>
            <p className="eyebrow">Business System Review</p>
            <h2>业务系统接入审核</h2>
          </div>
          <span className="status-pill warn">系统级员工仅预审，不可申请</span>
        </div>
        <ExpandableList defaultOpenId={focusedSystemId}>
          {({ openRowId, setOpenRowId }) =>
            businessSystems.map((system) => {
              const subsystem = system.subsystem;
              const displayName = subsystem?.name || system.id;
              const pendingSystemRequests = system.capabilityRequests.filter((item) => isPendingCapabilityReview(item, approvalResults)).length;
              const openSystemQuality = system.qualityEvents.filter((item) => String(item.status || "").includes("待")).length;
              const approvedSystemRequests = system.capabilityRequests.filter((item) => capabilityReviewResultForRequest(item, approvalResults)?.decision === "approved").length;
              const systemStatus = subsystem?.status || (pendingSystemRequests ? "待平台注册" : "待接入确认");

              return (
                <ExpandableRow
                  key={system.id}
                  rowId={system.id}
                  listId="business-systems"
                  openRowId={openRowId}
                  setOpenRowId={setOpenRowId}
                  icon={<Network size={18} />}
                  title={displayName}
                  description={subsystem?.privacyBoundary || "业务系统只进入接入登记和安全摘要协议确认，不作为能力申请对象。"}
                  status={<span className={`status-pill ${statusTone(systemStatus)}`}>{systemStatus}</span>}
                  summary={[
                    subsystem?.departmentId,
                    subsystem?.businessDomain,
                    assignmentSummary(subsystem),
                    `${system.capabilityRequests.length} 个能力申请`,
                    `${system.distributions.length} 个分发映射`,
                    subsystem?.managementHandshake?.status,
                    `${openSystemQuality} 条质量待复盘`,
                  ]}
                >
                  <div className="business-system-flow">
                    <SystemSection
                      id={`${system.id}-registration`}
                      eyebrow="Registration"
                      title="接入注册"
                      icon={<Network size={17} />}
                      status={<span className="status-pill muted">不是申请范围</span>}
                      defaultOpen={Boolean(subsystem?.assignmentDraft?.updatedAt)}
                      summary={[subsystem?.summaryEndpoint, subsystem?.supportedContracts?.length ? `${subsystem.supportedContracts.length} 个协议` : "待注册"]}
                    >
                      {subsystem ? (
                        <>
                          <DetailGrid
                            items={[
                              ["业务系统 ID", subsystem.id],
                              ["业务域", subsystem.businessDomain],
                              ["部门", subsystem.departmentId],
                              ["业务系统地址", <BusinessSystemLink url={subsystem.baseUrl} />],
                              ["Owner", subsystem.owner],
                              ["安全摘要", subsystem.summaryEndpoint],
                            ]}
                          />
                          <SubsystemAssignmentPanel
                            subsystem={subsystem}
                            canManage={canManageSubsystems}
                            onSaved={onRefresh}
                          />
                          <SkillChips title="支持协议" items={subsystem.supportedContracts || []} compact />
                        </>
                      ) : (
                        <EmptyState>当前筛选只命中了评审记录，还没有匹配的业务系统注册信息。</EmptyState>
                      )}
                    </SystemSection>

                    <SystemSection
                      id={`${system.id}-management-handshake`}
                      eyebrow="Management Handshake"
                      title="纳管握手"
                      icon={<Handshake size={17} />}
                      status={
                        <span className={`status-pill ${statusTone(subsystem?.managementHandshake?.status)}`}>
                          {subsystem?.managementHandshake?.status || "待握手"}
                        </span>
                      }
                      summary={[
                        subsystem?.managementHandshake?.contractVersion,
                        subsystem?.managementHandshake?.acceptedScopes?.length
                          ? `${subsystem.managementHandshake.acceptedScopes.length} 个纳管范围`
                          : "待确认范围",
                      ]}
                    >
                      {subsystem?.managementHandshake ? (
                        <>
                          <DetailGrid
                            items={[
                              ["握手协议", subsystem.managementHandshake.contractVersion],
                              ["确认时间", subsystem.managementHandshake.acceptedAt],
                              ["确认方", subsystem.managementHandshake.confirmedBy],
                              ["摘要 Hash", subsystem.managementHandshake.summaryHash],
                              ["安全摘要", subsystem.managementHandshake.safeSummary],
                            ]}
                          />
                          <SkillChips title="纳管范围" items={subsystem.managementHandshake.acceptedScopes || []} compact />
                          <HandshakeChecklist handshake={subsystem.managementHandshake} />
                        </>
                      ) : (
                        <HandshakeChecklist />
                      )}
                    </SystemSection>

                    <SystemSection
                      id={`${system.id}-capability-requests`}
                      eyebrow="能力申请"
                      title="业务数字员工 / 技能 / 自定义能力申请"
                      icon={<Layers3 size={17} />}
                      status={<span className={`status-pill ${pendingSystemRequests ? "warn" : "good"}`}>{pendingSystemRequests ? `${pendingSystemRequests} 条待处理` : "本地已处理"}</span>}
                      summary={[`${pendingSystemRequests} 条待平台评审`, approvedSystemRequests ? `${approvedSystemRequests} 条本地已执行` : "可执行审核"]}
                      defaultOpen={Boolean(focusedCapabilityRequestId && system.id === focusedSystemId)}
                    >
                      {system.capabilityRequests.length ? (
                        <div className="business-system-item-list">
                          {system.capabilityRequests.map((request) => (
                            (() => {
                              const preReview = preReviewResults[request.id] || request.preReview;
                              const isPreReviewRunning = preReview?.status === "running";
                              const hasPreReview = Boolean(preReview);
                              const reviewResult = capabilityReviewResultForRequest(request, approvalResults);
                              const requestStatus = reviewResult?.status || preReviewRequestStatus(preReview, request.status);
                              return (
                            <CollapsibleItem
                              id={`capability-request-${request.id}`}
                              key={request.id}
                              title={requestTitle(request)}
                              summary={requestSummary(request)}
                              defaultOpen={request.id === focusedCapabilityRequestId}
                              focused={request.id === focusedCapabilityRequestId}
                              status={
                                <span className={`status-pill ${approvalStatusTone(requestStatus)}`}>
                                  {requestStatus}
                                </span>
                              }
                            >
                              <DetailGrid
                                items={[
                                  ["Request ID", request.id],
                                  ["来源请求", request.sourceRequestId],
                                  ["申请类型", request.requestTypeLabel || request.requestType],
                                  ["目标对象", requestTarget(request)],
                                  ["源对齐", sourceAlignmentLabel(request.sourceAlignment)],
                                  ["Source Ref", request.targetSourceRef],
                                  ["申请方", request.requester],
                                  ["风险", request.risk],
                                  ["提交时间", request.submittedAt],
                                  ["审核门禁", request.reviewGate],
                                ]}
                              />
                              <SkillChips title="申请能力" items={request.requestedCapabilities || []} compact />
                              <SkillChips title="候选执行员工" items={request.candidateTargetEmployees || []} compact />
                              <SkillChips title="候选执行 Skill" items={request.candidateTargetSkills || []} compact />
                              <SkillChips title="安全警示" items={request.warnings || []} compact />
                              {hasPreReview && canManageSubsystems ? (
                                <div className="approval-action-buttons" role="group" aria-label={`${requestTitle(request)} AI 预审核`}>
                                  <button
                                    className="ghost-action table-action approval-pass"
                                    type="button"
                                    disabled={isPreReviewRunning}
                                    onClick={() => runPreReview(request)}
                                  >
                                    <CheckCircle2 size={15} />
                                    {isPreReviewRunning ? "预审核中" : preReview?.status === "completed" ? "重新执行 AI 预审核" : "执行 AI 预审核"}
                                  </button>
                                </div>
                              ) : null}
                              <PreReviewBlock preReview={preReview} />
                              <ApprovalActionPanel
                                request={request}
                                result={reviewResult}
                                canManage={canManageSubsystems}
                                isSubmitting={Boolean(approvalSubmitting[request.id])}
                                onDecision={recordApprovalDecision}
                              />
                            </CollapsibleItem>
                              );
                            })()
                          ))}
                        </div>
                      ) : (
                        <EmptyState>暂无数字员工或 Skill 能力申请。</EmptyState>
                      )}
                    </SystemSection>

                    <SystemSection
                      id={`${system.id}-distributions`}
                      eyebrow="Distribution Mapping"
                      title="分发映射与版本 pin"
                      icon={<GitBranch size={17} />}
                      status={<span className="status-pill warn">回滚策略必填</span>}
                      summary={[`${system.distributions.length} 个映射`, system.distributions[0]?.rolloutPolicy]}
                    >
                      {system.distributions.length ? (
                        <div className="business-system-item-list">
                          {system.distributions.map((plan) => (
                            <article className="business-system-item" key={plan.id}>
                              <div className="business-system-item-head">
                                <div>
                                  <strong>{plan.sourceEmployeeId}</strong>
                                  <p>{plan.safeSummary}</p>
                                </div>
                                <span className={`status-pill ${statusTone(plan.status)}`}>{plan.status}</span>
                              </div>
                              <DetailGrid
                                items={[
                                  ["分发 ID", plan.id],
                                  ["来源平台", plan.sourceSystemId],
                                  ["目标系统", plan.targetSystemId],
                                  ["中心版本", plan.sourceEmployeeVersion],
                                  ["Rollout", plan.rolloutPolicy],
                                  ["Rollback", plan.rollbackPolicy],
                                  ["审核门禁", plan.reviewGate],
                                  ["最近同步", plan.lastSyncedAt],
                                ]}
                              />
                              <SkillChips title="目标员工" items={plan.targetEmployeeIds || []} compact />
                              <SkillChips title="目标 Skill" items={plan.targetSkillIds || []} compact />
                              <SkillChips title="质量摘要" items={qualitySummary(plan.qualitySignal)} compact />
                            </article>
                          ))}
                        </div>
                      ) : (
                        <EmptyState>暂无平台到业务系统的分发映射。</EmptyState>
                      )}
                    </SystemSection>

                    <SystemSection
                      id={`${system.id}-invocation-policies`}
                      eyebrow="Invocation Policy"
                      title="调用门禁与阈值"
                      icon={<RadioTower size={17} />}
                      status={<span className="status-pill good">调用前检查</span>}
                      summary={[`${system.invocationPolicies.length} 条策略`, system.invocationPolicies[0]?.status]}
                    >
                      {system.invocationPolicies.length ? (
                        <div className="business-system-item-list">
                          {system.invocationPolicies.map((policy) => (
                            <article className="business-system-item" key={policy.id}>
                              <div className="business-system-item-head">
                                <div>
                                  <strong>{`${policy.employeeId} / ${policy.skillId}`}</strong>
                                  <p>{policy.privacyBoundary}</p>
                                </div>
                                <span className={`status-pill ${statusTone(policy.status)}`}>{policy.status}</span>
                              </div>
                              <DetailGrid
                                items={[
                                  ["策略 ID", policy.id],
                                  ["员工版本", policy.employeeVersion],
                                  ["Skill 版本", policy.skillVersion],
                                  ["模型白名单", (policy.modelLimits?.allowedModelIds || []).join(", ")],
                                  ["模型等级上限", policy.modelLimits?.maxModelLevelId],
                                  ["Key 策略", policy.modelLimits?.credentialLeasePolicy],
                                  ["每日/每小时", `${policy.resourceThresholds?.maxDailyCalls} / ${policy.resourceThresholds?.maxHourlyCalls}`],
                                  ["月预算", `${policy.resourceThresholds?.monthlyBudgetCny} CNY`],
                                  ["Eval 通过率", `>= ${policy.qualityThresholds?.minEvalPassRate}`],
                                  ["P0/P1 未关闭", `<= ${policy.qualityThresholds?.maxOpenP0P1Badcases}`],
                                  ["写回置信度", `>= ${policy.confidenceThresholds?.minConfidenceForWriteback}`],
                                  ["审核门禁", policy.reviewGate],
                                ]}
                              />
                              <SkillChips title="允许调用方" items={policy.allowedCallers || []} compact />
                              <SkillChips title="允许动作" items={policy.allowedActions || []} compact />
                              <SkillChips title="拒绝动作" items={policy.deniedActions || []} compact />
                            </article>
                          ))}
                        </div>
                      ) : (
                        <EmptyState>暂无已批准调用策略。</EmptyState>
                      )}
                    </SystemSection>

                    <SystemSection
                      id={`${system.id}-quality-events`}
                      eyebrow="Quality Feedback"
                      title="质量问题与回测候选"
                      icon={<ShieldCheck size={17} />}
                      status={<span className="status-pill warn">badcase / eval 主干</span>}
                      summary={[`${system.qualityEvents.length} 条事件`, openSystemQuality ? `${openSystemQuality} 条待复盘` : "暂无待复盘"]}
                    >
                      {system.qualityEvents.length ? (
                        <div className="business-system-item-list">
                          {system.qualityEvents.map((event) => (
                            <article className="business-system-item" key={event.id}>
                              <div className="business-system-item-head">
                                <div>
                                  <strong>{qualityIssueName(event.errorCode) || event.errorCode}</strong>
                                  <p>{event.evidenceSummary}</p>
                                </div>
                                <span className={`status-pill ${statusTone(event.status)}`}>{event.status}</span>
                              </div>
                              <DetailGrid
                                items={[
                                  ["事件 ID", event.id],
                                  ["来源事件", event.sourceEventId],
                                  ["实体", `${event.entityType} / ${event.entityId}`],
                                  ["实体版本", event.entityVersion],
                                  ["Prompt 版本", event.promptVersion],
                                  ["错误码", qualityCodeText(event.errorCode)],
                                  ["错误域", qualityEnumText("errorDomain", event.errorDomain)],
                                  ["严重级别", event.severity],
                                  ["根因", qualityEnumText("rootCauseCategory", event.rootCauseCategory)],
                                  ["处理动作", qualityEnumText("resolutionAction", event.resolutionAction)],
                                  ["归档模式", event.archiveMode],
                                  ["归档窗口", event.archiveWindow],
                                  ["期望摘要", event.expectedSummary],
                                  ["实际摘要", event.actualSummary],
                                  ["回测候选", event.evalCandidate ? "是" : "否"],
                                ]}
                              />
                              <PreReviewBlock preReview={event.preReview} />
                            </article>
                          ))}
                        </div>
                      ) : (
                        <EmptyState>暂无业务系统回传的质量事件。</EmptyState>
                      )}
                    </SystemSection>
                  </div>
                </ExpandableRow>
              );
            })
          }
        </ExpandableList>
      </section>
    </section>
  );
}
