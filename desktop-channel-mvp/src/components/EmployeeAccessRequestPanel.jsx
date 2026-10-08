import { CheckCircle, PaperPlaneTilt, ShieldCheck, SpinnerGap, X } from "@phosphor-icons/react";
import { useMemo, useState } from "react";

export function EmployeeAccessRequestPanel({ employees, requests, onClose, onSubmit }) {
  const [employeeId, setEmployeeId] = useState(employees[0]?.id || "");
  const [reason, setReason] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [result, setResult] = useState(null);
  const employee = useMemo(() => employees.find((item) => item.id === employeeId), [employeeId, employees]);
  const existing = requests.find((request) => request.target?.employeeId === employeeId && request.status === "pending_review");

  async function submit(event) {
    event.preventDefault();
    if (!employeeId || existing || submitting) return;
    setSubmitting(true);
    const next = await onSubmit({ employeeId, reason });
    setResult(next);
    setSubmitting(false);
  }

  return (
    <section className="access-request-panel" aria-label="申请数字员工">
      <header>
        <div><strong>申请数字员工</strong><span>审批通过后才会进入可切换列表</span></div>
        <button type="button" className="icon-button" title="关闭申请" onClick={onClose}><X size={17} /></button>
      </header>
      <form onSubmit={submit}>
        <label htmlFor="request-employee">数字员工</label>
        <select id="request-employee" value={employeeId} onChange={(event) => { setEmployeeId(event.target.value); setResult(null); }}>
          {employees.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
        </select>
        <p>{employee?.title || "业务数字员工"}</p>
        <label htmlFor="request-reason">申请原因</label>
        <textarea id="request-reason" rows={2} maxLength={240} value={reason} onChange={(event) => setReason(event.target.value)} placeholder="说明需要使用的业务场景" />
        {existing || result?.status === "pending_review" ? (
          <div className="access-request-result"><CheckCircle size={17} /><span>已提交，等待员工 Owner 或平台管理员审核</span></div>
        ) : (
          <button type="submit" className="request-submit" disabled={!employeeId || submitting}>
            {submitting ? <SpinnerGap size={17} className="spin" /> : <PaperPlaneTilt size={17} />}
            提交申请
          </button>
        )}
      </form>
      <small><ShieldCheck size={13} />申请不会自动授权，也不会启动数字员工</small>
    </section>
  );
}
