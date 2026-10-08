import { AlertTriangle, ArrowRight, Building2, CalendarClock, CheckCircle2, RefreshCw, Search, ShieldCheck, UserRound, X } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";

const requestStatusLabels = {
  pending_review: "审批中",
  approved_scheduled: "已批准，待生效",
  approved: "已生效",
  rejected: "已驳回",
};

export default function EmployeeDepartmentChangePanel({ employee, canConfigure = false, onEmployeeChange = null }) {
  const [isOpen, setIsOpen] = useState(false);
  const [context, setContext] = useState(null);
  const [loadState, setLoadState] = useState({ status: "idle", error: "" });
  const [actionState, setActionState] = useState({ status: "idle", message: "" });
  const [departmentQuery, setDepartmentQuery] = useState("");
  const [form, setForm] = useState({ primaryDepartmentId: "", targetDepartmentIds: [], targetOwnerUserId: "", reason: "", effectiveAt: "" });

  useEffect(() => {
    if (!canConfigure || !employee.id) return;
    loadContext();
  }, [canConfigure, employee.id, employee.ownerDepartmentId, employee.version]);

  const activeRequest = context?.activeRequest || null;
  const latestRequest = context?.latestRequest || null;
  const primaryDepartment = context?.departmentOptions?.find((item) => item.id === form.primaryDepartmentId) || null;
  const targetDepartments = (context?.departmentOptions || []).filter((item) => form.targetDepartmentIds.includes(item.id));
  const visibleDepartmentOptions = useMemo(() => {
    const query = departmentQuery.replace(/\s+/g, "").toLowerCase();
    if (!query) return context?.departmentOptions || [];
    return (context?.departmentOptions || []).filter((item) =>
      String(item.label || item.name || "").replace(/\s+/g, "").toLowerCase().includes(query),
    );
  }, [context?.departmentOptions, departmentQuery]);
  const targetOwners = useMemo(
    () => (context?.ownerOptions || []).filter((item) => item.departmentId === form.primaryDepartmentId),
    [context?.ownerOptions, form.primaryDepartmentId],
  );
  const incompatibleSkills = useMemo(
    () => (context?.mountedBusinessSkills || []).filter((skill) => skill.departmentId && !form.targetDepartmentIds.includes(skill.departmentId)),
    [context?.mountedBusinessSkills, form.targetDepartmentIds],
  );
  let submitBlockReason = "";
  if (!form.primaryDepartmentId) submitBlockReason = "请先选择主责部门";
  else if (!targetOwners.length) submitBlockReason = `${primaryDepartment?.name || "该部门"}暂无可选 Owner，请先同步或登记部门负责人`;
  else if (!form.targetOwnerUserId) submitBlockReason = "请选择新 Owner";
  else if (!form.targetDepartmentIds.length) submitBlockReason = "请至少选择一个归属部门";
  else if (form.reason.trim().length < 4) submitBlockReason = "变更原因至少填写 4 个字";
  else if (activeRequest) submitBlockReason = "该数字员工已有待处理的归属变更";
  const canSubmit = !submitBlockReason;

  async function loadContext() {
    setLoadState({ status: "loading", error: "" });
    try {
      const response = await fetch(`/api/digital-employees/${encodeURIComponent(employee.id)}/department-change`, { credentials: "include" });
      const data = await response.json().catch(() => ({}));
      if (!response.ok || !data.ok) throw new Error(data.message || data.error || "归属变更上下文读取失败");
      setContext(data);
      setLoadState({ status: "ready", error: "" });
      if (employeeProjectionChanged(employee, data.employee)) await onEmployeeChange?.(data.employee);
    } catch (error) {
      setLoadState({ status: "error", error: error?.message || "归属变更上下文读取失败" });
    }
  }

  function updateDepartment(departmentId) {
    const firstOwner = (context?.ownerOptions || []).find((item) => item.departmentId === departmentId);
    setForm((current) => ({
      ...current,
      primaryDepartmentId: departmentId,
      targetDepartmentIds: departmentId ? [...new Set([departmentId, ...current.targetDepartmentIds])] : current.targetDepartmentIds,
      targetOwnerUserId: firstOwner?.id || "",
    }));
  }

  function toggleTargetDepartment(departmentId) {
    if (departmentId === form.primaryDepartmentId) return;
    setForm((current) => ({
      ...current,
      targetDepartmentIds: current.targetDepartmentIds.includes(departmentId)
        ? current.targetDepartmentIds.filter((item) => item !== departmentId)
        : [...current.targetDepartmentIds, departmentId],
    }));
  }

  async function submitChange(event) {
    event.preventDefault();
    if (!canSubmit) return;
    setActionState({ status: "loading", message: "" });
    try {
      const response = await fetch(`/api/digital-employees/${encodeURIComponent(employee.id)}/department-change`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(form),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok || !data.ok) throw new Error(data.message || data.error || "归属变更提交失败");
      setActionState({ status: "ready", message: data.message || "归属变更已提交审批。" });
      await loadContext();
    } catch (error) {
      setActionState({ status: "error", message: error?.message || "归属变更提交失败" });
    }
  }

  if (!canConfigure) return null;
  const displayedRequest = activeRequest || latestRequest;
  const statusLabel = requestStatusLabels[displayedRequest?.status] || "";
  const displayedDepartmentNames = requestDepartmentNames(displayedRequest);
  const currentAuthorizationNames = (employee.authorizedDepartmentNames || []).filter(Boolean).join(" / ");

  return (
    <>
      <div className="employee-department-change-control">
        <span>
          <Building2 size={15} />
          <small>{activeRequest
            ? `待处理 · ${displayedDepartmentNames} · ${statusLabel}`
            : `当前授权 · ${currentAuthorizationNames || "未配置"}`}</small>
        </span>
        <button className="ghost-action" type="button" onClick={() => setIsOpen(true)}>
          <ArrowRight size={15} />
          {activeRequest ? "查看申请" : "变更部门与 Owner"}
        </button>
      </div>
      {isOpen ? createPortal(
        <div className="employee-department-change-backdrop" role="presentation" onClick={() => setIsOpen(false)}>
          <aside
            className="employee-department-change-sheet"
            role="dialog"
            aria-modal="true"
            aria-labelledby="employee-department-change-title"
            onClick={(event) => event.stopPropagation()}
          >
            <header className="employee-department-change-head">
              <span>
                <small>Governed Department Change</small>
                <strong id="employee-department-change-title">归属变更与记录</strong>
                <b>{employee.name} · {employee.version}</b>
              </span>
              <button type="button" aria-label="关闭归属变更" title="关闭" onClick={() => setIsOpen(false)}><X size={17} /></button>
            </header>

            {loadState.status === "loading" && !context ? (
              <div className="employee-department-change-loading"><RefreshCw size={17} />正在读取治理上下文</div>
            ) : null}
            {loadState.error ? <p className="employee-department-change-message is-error">{loadState.error}</p> : null}

            {context ? (
              <>
                <section className="employee-department-current">
                  <div><span>当前授权部门</span><strong>{(context.employee.authorizedDepartmentNames || []).filter(Boolean).join(" / ") || "未配置"}</strong></div>
                  <ArrowRight size={18} />
                  <div><span>当前 Owner</span><strong>{context.employee.owner || "未指定"}</strong></div>
                </section>

                {activeRequest ? (
                  <DepartmentChangeRecord
                    request={activeRequest}
                  />
                ) : (
                  <>
                    {latestRequest ? <DepartmentChangeRecord request={latestRequest} /> : null}
                    <form className="employee-department-change-form" onSubmit={submitChange}>
                      <div className="employee-department-change-fields">
                      <label>
                        <span>目标部门</span>
                        <select value={form.primaryDepartmentId} onChange={(event) => updateDepartment(event.target.value)} required>
                          <option value="">选择主责部门</option>
                          {context.departmentOptions.map((item) => (
                            <option key={item.id} value={item.id}>{item.label || item.name}</option>
                          ))}
                        </select>
                      </label>
                      <label>
                        <span>新 Owner</span>
                        <select value={form.targetOwnerUserId} onChange={(event) => setForm((current) => ({ ...current, targetOwnerUserId: event.target.value }))} disabled={!form.primaryDepartmentId || !targetOwners.length} required>
                          <option value="">{form.primaryDepartmentId && !targetOwners.length ? "该部门暂无可选 Owner" : "选择主责部门 Owner"}</option>
                          {targetOwners.map((owner) => <option key={owner.id} value={owner.id}>{owner.name} · {owner.role}</option>)}
                        </select>
                        {form.primaryDepartmentId && !targetOwners.length ? (
                          <small className="is-error">请先在 Fortress 或人员治理中登记该部门负责人</small>
                        ) : null}
                      </label>
                      <fieldset className="employee-department-multi-select is-wide">
                        <legend>协作授权部门（可多选）</legend>
                        <label className="employee-department-search">
                          <Search size={15} />
                          <input value={departmentQuery} onChange={(event) => setDepartmentQuery(event.target.value)} placeholder="搜索部门" />
                        </label>
                        <div>
                          {visibleDepartmentOptions.map((department) => {
                            const isPrimary = department.id === form.primaryDepartmentId;
                            const isChecked = form.targetDepartmentIds.includes(department.id);
                            return (
                              <label key={department.id}>
                                <input
                                  type="checkbox"
                                  checked={isChecked}
                                  disabled={isPrimary}
                                  onChange={() => toggleTargetDepartment(department.id)}
                                />
                                <span>{department.label || department.name}</span>
                                {isPrimary ? <small>主责</small> : null}
                              </label>
                            );
                          })}
                        </div>
                      </fieldset>
                      <label>
                        <span>计划生效时间</span>
                        <input type="datetime-local" value={form.effectiveAt} onChange={(event) => setForm((current) => ({ ...current, effectiveAt: event.target.value }))} />
                        <small>留空则审批通过后立即生效</small>
                      </label>
                      <label className="is-wide">
                        <span>变更原因</span>
                        <textarea rows={3} value={form.reason} onChange={(event) => setForm((current) => ({ ...current, reason: event.target.value }))} placeholder="说明业务交接、职责调整或治理范围变化" required />
                      </label>
                      </div>

                      {primaryDepartment ? (
                        <DepartmentChangeImpact
                          employee={context.employee}
                          primaryDepartment={primaryDepartment}
                          targetDepartments={targetDepartments}
                          incompatibleSkills={incompatibleSkills}
                        />
                      ) : null}

                      <footer className="employee-department-change-actions">
                        <span>{submitBlockReason || "提交后，生效前继续使用当前部门配置"}</span>
                        <button className="primary-action" type="submit" disabled={!canSubmit || actionState.status === "loading"} title={submitBlockReason || "提交归属变更审批"}>
                          <ShieldCheck size={16} />
                          {actionState.status === "loading" ? "提交中" : "提交变更审批"}
                        </button>
                      </footer>
                    </form>
                  </>
                )}
              </>
            ) : null}
            {actionState.message ? <p className={`employee-department-change-message ${actionState.status === "error" ? "is-error" : ""}`}>{actionState.message}</p> : null}
          </aside>
        </div>,
        document.querySelector(".console-shell") || document.body,
      ) : null}
    </>
  );
}

function employeeProjectionChanged(employee = {}, projected = {}) {
  return ["version", "ownerDepartmentId", "ownerUserId", "owner", "department"].some((key) => String(employee[key] || "") !== String(projected[key] || ""));
}

function DepartmentChangeImpact({ employee, primaryDepartment, targetDepartments, incompatibleSkills }) {
  return (
    <section className="employee-department-change-impact" aria-label="归属变更影响预览">
      <header><AlertTriangle size={16} /><strong>影响预览</strong><span>{targetDepartments.map((item) => item.name).join(" / ")}</span></header>
      <div className="employee-department-impact-list">
        <span><ShieldCheck size={15} /><b>部门授权</b><small>{targetDepartments.length} 个归属部门将获得受控基础会话资格；移除的部门自动资格失效</small></span>
        <span><UserRound size={15} /><b>治理责任</b><small>{primaryDepartment.name} 作为主责部门，Owner 和审批责任保持单一</small></span>
        <span><RefreshCw size={15} /><b>员工版本</b><small>{employee.version || "当前版本"} 将升级，旧版本个人授权需重新审核</small></span>
        <span className={incompatibleSkills.length ? "is-warn" : ""}><AlertTriangle size={15} /><b>专项 Skill</b><small>{incompatibleSkills.length ? `${incompatibleSkills.map((skill) => skill.name).join("、")} 与目标部门不一致，生效前需复核` : "当前挂载未发现跨部门冲突"}</small></span>
        <span><CheckCircle2 size={15} /><b>Channels</b><small>保留现有绑定，不根据多部门归属自动增删</small></span>
      </div>
    </section>
  );
}

function DepartmentChangeRecord({ request }) {
  return (
    <section className="employee-department-pending">
      <header>
        <span><CalendarClock size={16} /><strong>{requestStatusLabels[request.status] || request.status}</strong></span>
        <small>{request.id}</small>
      </header>
      <div className="employee-department-pending-route">
        <span><Building2 size={15} />{request.current?.departmentName}</span>
        <ArrowRight size={16} />
        <span><Building2 size={15} />{requestDepartmentNames(request)}</span>
      </div>
      <dl>
        <div><dt>新 Owner</dt><dd>{request.target?.ownerName}</dd></div>
        <div><dt>变更原因</dt><dd>{request.reason}</dd></div>
        <div><dt>计划生效</dt><dd>{formatTime(request.effectiveAt)}</dd></div>
        <div><dt>提交人</dt><dd>{request.submittedBy?.name}</dd></div>
      </dl>
      <p><UserRound size={15} />{requestStatusDescription(request.status)}</p>
    </section>
  );
}

function requestDepartmentNames(request) {
  return (request?.target?.departmentNames || [request?.target?.departmentName]).filter(Boolean).join(" / ");
}

function requestStatusDescription(status) {
  if (status === "pending_review") return "申请已提交；请前往“质量审核 → 技能/员工评审 → 归属审批”处理。";
  if (status === "approved_scheduled") return "审批已通过，将在计划时间自动生效。";
  if (status === "approved") return "该变更已生效，智能体档案已使用新的归属信息。";
  if (status === "rejected") return "该变更已驳回，智能体档案继续使用原归属信息。";
  return "归属变更记录已保存。";
}

function formatTime(value) {
  if (!value) return "审批通过后立即生效";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString("zh-CN", { hour12: false });
}
