import { Power } from "lucide-react";
import { useState } from "react";
import { digitalEmployeeProductionReadinessView } from "../../lib/digitalEmployeeLifecycle";

export default function EmployeeLifecycleToggle({ employee, onChange, onGateAction }) {
  const [state, setState] = useState({ status: "idle", message: "" });
  const enabled = employee.status === "在线" || employee.status === "试运行";
  const canToggle = enabled || employee.status === "停用";
  const readiness = digitalEmployeeProductionReadinessView(employee);

  async function toggleLifecycle() {
    if (!canToggle || state.status === "saving" || typeof onChange !== "function") return;
    const nextEnabled = !enabled;
    const action = nextEnabled ? "打开" : "关闭";
    const detail = nextEnabled
      ? "打开前会校验已保存的模型绑定，并恢复到关闭前的已审批状态。"
      : "关闭后会立即阻断新会话、桌面端选择和渠道调用。";
    if (!window.confirm(`${detail}\n\n确认${action} ${employee.name}？`)) return;
    setState({ status: "saving", message: "" });
    try {
      await onChange(employee.id, nextEnabled);
      setState({ status: "success", message: `已${action}` });
    } catch (error) {
      setState({ status: "error", message: error?.message || `${action}失败` });
    }
  }

  const actionLabel = enabled ? "关闭" : "打开";
  const disabled = !canToggle || state.status === "saving" || typeof onChange !== "function";
  return (
    <span className="employee-lifecycle-control">
      <button className={`employee-lifecycle-toggle ${enabled ? "is-enabled" : "is-disabled"}`} type="button" role="switch" aria-checked={enabled} aria-label={`${actionLabel}${employee.name}`} disabled={disabled} title={canToggle ? `${actionLabel}${employee.name}` : `当前状态为 ${employee.status}，不能直接打开或关闭`} onClick={toggleLifecycle}>
        <Power size={15} />
        {state.status === "saving" ? "处理中" : actionLabel}
      </button>
      {state.message ? <small className={`employee-lifecycle-feedback is-${state.status}`} role="status">{state.message}</small> : null}
      <details className={`employee-production-readiness ${readiness.ready ? "is-ready" : "is-blocked"}`}>
        <summary className={`status-pill ${readiness.ready ? "good" : "warn"}`} title={readiness.ready ? "查看上线门禁状态" : readiness.managed ? "展开并处理上线门禁" : "查看上线门禁接入状态"}>
          <span>{readiness.label}</span>
          <small>{readiness.ready ? "查看" : readiness.managed ? "处理" : "查看"}</small>
        </summary>
        {readiness.blockingGates.length ? (
          <div className="employee-production-readiness-list">
            {readiness.blockingGates.map((gate) => (
              <span key={gate.id}>
                <b>{gate.label}</b>
                <small>{gate.detail}</small>
                {gate.actionRoute ? <button type="button" onClick={(event) => { event.currentTarget.closest("details")?.removeAttribute("open"); onGateAction?.(gate); }}>{gate.actionLabel || "打开处理入口"}</button> : null}
              </span>
            ))}
          </div>
        ) : <small>{readiness.nextGate}</small>}
      </details>
    </span>
  );
}
