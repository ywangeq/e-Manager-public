import { ArrowRight, CheckCircle2, ClipboardCheck, ShieldCheck, UserRoundCheck, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  decideDigitalEmployeeResponsibilities,
  fetchDigitalEmployeeResponsibilities,
  saveDigitalEmployeeResponsibilities,
} from "../../lib/digitalEmployeeResponsibilities";

const roleDefinitions = [
  { id: "technicalOwner", label: "技术 Owner", help: "负责运行链路、集成和技术变更。" },
  { id: "qualityReviewer", label: "平台质量审核", help: "负责质量门禁、badcase 与上线审查。" },
  { id: "alertReceiver", label: "告警接收", help: "负责接收运行异常并推动闭环。" },
];

export default function EmployeeResponsibilityPanel({ employee, canConfigure = false, onEmployeeChange = null, openRequest = 0 }) {
  const [isOpen, setIsOpen] = useState(false);
  const [context, setContext] = useState(null);
  const [loadState, setLoadState] = useState({ status: "idle", error: "" });
  const [actionState, setActionState] = useState({ status: "idle", message: "" });
  const [form, setForm] = useState(emptyForm());
  const handledOpenRequest = useRef(0);
  const assignments = employee.responsibilityAssignments || {};
  const configuredCount = roleDefinitions.filter((role) => assignments[role.id]?.status === "assigned").length;

  const options = useMemo(() => context?.assigneeOptions || [], [context?.assigneeOptions]);

  useEffect(() => {
    if (!openRequest || !canConfigure || handledOpenRequest.current === openRequest) return;
    handledOpenRequest.current = openRequest;
    setIsOpen(true);
    void loadContext();
  }, [openRequest, canConfigure]);

  async function openPanel() {
    setIsOpen(true);
    await loadContext();
  }

  async function loadContext() {
    setLoadState({ status: "loading", error: "" });
    try {
      const data = await fetchDigitalEmployeeResponsibilities(employee.id);
      setContext(data);
      setForm(formFromAssignments(data.assignments));
      setLoadState({ status: "ready", error: "" });
    } catch (error) {
      setLoadState({ status: "error", error: error?.message || "责任分工上下文读取失败" });
    }
  }

  async function submit(event) {
    event.preventDefault();
    if (form.note.trim().length < 4) return;
    setActionState({ status: "loading", message: "" });
    try {
      const data = await saveDigitalEmployeeResponsibilities(employee.id, {
        assignments: Object.fromEntries(roleDefinitions.map((role) => [role.id, selectionPayload(form[role.id])])),
        note: form.note,
      });
      setActionState({ status: "ready", message: data.message });
      await loadContext();
      if (data.status === "applied") await onEmployeeChange?.(data.digitalEmployee);
    } catch (error) {
      setActionState({ status: "error", message: error?.message || "责任分工保存失败" });
    }
  }

  async function decide(decision) {
    setActionState({ status: "loading", message: "" });
    try {
      const data = await decideDigitalEmployeeResponsibilities(employee.id, { decision });
      setActionState({ status: "ready", message: data.message });
      await loadContext();
      if (decision === "approved") await onEmployeeChange?.(data.digitalEmployee);
    } catch (error) {
      setActionState({ status: "error", message: error?.message || "责任分工审核失败" });
    }
  }

  return (
    <>
      <div className="employee-responsibility-control">
        <span>
          <UserRoundCheck size={15} />
          <small>业务 Owner 已同步 · {configuredCount}/3 项平台责任已登记</small>
        </span>
        {canConfigure ? (
          <button className="ghost-action" type="button" onClick={openPanel}>
            <ArrowRight size={15} />
            配置责任分工
          </button>
        ) : null}
      </div>

      {isOpen ? createPortal(
        <div className="employee-department-change-backdrop" role="presentation" onClick={() => setIsOpen(false)}>
          <aside
            className="employee-department-change-sheet employee-responsibility-sheet"
            role="dialog"
            aria-modal="true"
            aria-labelledby="employee-responsibility-title"
            onClick={(event) => event.stopPropagation()}
          >
            <header className="employee-department-change-head">
              <span>
                <small>Governed Responsibility</small>
                <strong id="employee-responsibility-title">责任分工</strong>
                <b>{employee.name} · {employee.version}</b>
              </span>
              <button type="button" aria-label="关闭责任分工" title="关闭" onClick={() => setIsOpen(false)}><X size={17} /></button>
            </header>

            {loadState.status === "loading" && !context ? <div className="employee-department-change-loading">正在读取人员目录</div> : null}
            {loadState.error ? <p className="employee-department-change-message is-error">{loadState.error}</p> : null}

            {context ? (
              <>
                <section className="employee-responsibility-business-owner">
                  <ShieldCheck size={17} />
                  <span><small>业务 Owner（从资产归属同步）</small><strong>{assignmentLabel(context.assignments?.businessOwner)}</strong></span>
                  <em>权限唯一来源</em>
                </section>

                {context.pendingRevision ? (
                  <section className="employee-department-pending employee-responsibility-pending">
                    <header><ClipboardCheck size={16} /><strong>待审核变更</strong><small>{context.pendingRevision.submittedBy?.name || "已提交"}</small></header>
                    <ResponsibilitySummary assignments={context.pendingRevision.target} />
                    {context.canReview ? (
                      <div className="employee-department-review-actions">
                        <button className="ghost-action is-reject" type="button" disabled={actionState.status === "loading"} onClick={() => decide("rejected")}>驳回</button>
                        <button className="primary-action" type="button" disabled={actionState.status === "loading"} onClick={() => decide("approved")}><CheckCircle2 size={15} />通过并生效</button>
                      </div>
                    ) : <p>审核通过前继续使用当前责任分工。</p>}
                  </section>
                ) : (
                  <form className="employee-department-change-form" onSubmit={submit}>
                    <div className="employee-department-change-fields employee-responsibility-fields">
                      {roleDefinitions.map((role) => (
                        <label className="is-wide" key={role.id}>
                          <span>{role.label}</span>
                          <select value={form[role.id]} onChange={(event) => setForm((current) => ({ ...current, [role.id]: event.target.value }))}>
                            <option value="">待配置</option>
                            {options.map((person) => <option key={optionValue(person)} value={optionValue(person)}>{person.name} · {person.departmentName || person.departmentId} · {person.role}</option>)}
                          </select>
                          <small>{role.help}</small>
                        </label>
                      ))}
                      <label className="is-wide">
                        <span>变更说明</span>
                        <textarea rows={3} value={form.note} onChange={(event) => setForm((current) => ({ ...current, note: event.target.value }))} placeholder="说明责任人分工或交接原因" required />
                      </label>
                    </div>
                    <footer className="employee-department-change-actions">
                      <span>{form.note.trim().length < 4 ? "变更说明至少填写 4 个字" : context.appliesImmediately ? "平台管理员保存后直接生效" : "保存后提交平台审核"}</span>
                      <button className="primary-action" type="submit" disabled={form.note.trim().length < 4 || actionState.status === "loading"}>
                        <ShieldCheck size={16} />{actionState.status === "loading" ? "保存中" : context.appliesImmediately ? "保存并生效" : "提交审核"}
                      </button>
                    </footer>
                  </form>
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

function ResponsibilitySummary({ assignments = {} }) {
  return <dl>{roleDefinitions.map((role) => <div key={role.id}><dt>{role.label}</dt><dd>{assignmentLabel(assignments[role.id])}</dd></div>)}</dl>;
}

function assignmentLabel(assignment) {
  if (!assignment?.assigneeName) return "未登记";
  return `${assignment.assigneeName}（${assignment.departmentName || assignment.departmentId || "未登记部门"}）`;
}

function optionValue(person) {
  return JSON.stringify({ assigneeId: person.id, departmentId: person.departmentId });
}

function selectionPayload(value) {
  if (!value) return null;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function formFromAssignments(assignments = {}) {
  return {
    ...emptyForm(),
    ...Object.fromEntries(roleDefinitions.map((role) => [role.id, assignments[role.id]?.assigneeId ? optionValue({
      id: assignments[role.id].assigneeId,
      departmentId: assignments[role.id].departmentId,
    }) : ""])),
  };
}

function emptyForm() {
  return { technicalOwner: "", qualityReviewer: "", alertReceiver: "", note: "" };
}
