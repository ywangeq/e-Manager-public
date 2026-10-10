import { useState } from "react";

export default function RouteExecutionLimits({ connection, onSaved }) {
  const policy = connection.timeoutPolicy;
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  async function save(event) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const executionLimits = Object.fromEntries([...form].map(([key, value]) => [key, Number(value)]));
    setBusy(true);
    try {
      const response = await fetch(`/api/provider-routes/${encodeURIComponent(connection.id)}`, { method: "PATCH", credentials: "include", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ executionLimits }) });
      const result = await response.json();
      if (!response.ok || !result.connection) throw new Error(result.message || "执行限制未保存");
      onSaved(result.connection);
      setMessage(result.message);
    } catch (error) { setMessage(error.message); }
    finally { setBusy(false); }
  }
  return <details className="route-execution-limits"><summary>执行时限与重试</summary>
    <form onSubmit={save} key={`${policy?.requestTotalMs}:${policy?.taskExecutionTotalMs}:${connection.toolExecutionTimeoutMs}:${connection.retryCount}`}>
      {[
        ["modelRequestSeconds", "单次模型调用（秒）", (policy?.requestTotalMs || 300000) / 1000, 1, 14400],
        ["toolCallSeconds", "单次 Tool 调用（秒）", (connection.toolExecutionTimeoutMs || 300000) / 1000, 1, 172800],
        ["modelRetryCount", "模型安全重试次数", connection.retryCount ?? 2, 0, 5],
        ["taskBudgetSeconds", "任务总预算（秒）", (policy?.taskExecutionTotalMs || 1800000) / 1000, 1, 172800],
      ].map(([name, label, value, min, max]) => <label key={name}><span>{label}</span><input name={name} type="number" step="1" min={min} max={max} required defaultValue={value} disabled={busy} /></label>)}
      <p>每次调用独立计时。总预算累计计算，重试不重置；已完成的 Tool 不重放，写入超时需查回执。模型产生输出后不自动重试。</p>
      <button type="submit" disabled={busy}>{busy ? "保存中…" : "保存限制"}</button>
      {message ? <p role="status">{message}</p> : null}
    </form>
  </details>;
}
