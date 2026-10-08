import { Cpu, Link2, Pencil, Plus, RefreshCw, ServerCog } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import MetricCard from "./MetricCard";
import { ALGORITHM_EMPLOYEE_ID } from "../data/digitalEmployeeIdentity.js";

const initialDraft = {
  kind: "remote",
  name: "",
  connectionRef: "",
  cliAdapter: "auto",
  gpuTotal: "",
  gpuAvailable: "",
  employeeId: ALGORITHM_EMPLOYEE_ID,
};

export default function RuntimeInfrastructureView() {
  const [sheet, setSheet] = useState("remote");
  const [state, setState] = useState({ status: "loading", data: null, error: "" });
  const [feedback, setFeedback] = useState("");
  const [probingId, setProbingId] = useState("");
  const [showAddForm, setShowAddForm] = useState(false);
  const [draft, setDraft] = useState(initialDraft);
  const [editingItem, setEditingItem] = useState(null);
  const [saving, setSaving] = useState(false);

  function load({ quiet = false } = {}) {
    if (!quiet) setState((current) => ({ ...current, status: "loading", error: "" }));
    fetch("/api/runtime-infrastructure", { credentials: "include" })
      .then(async (response) => {
        const data = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(data.message || data.error || "运行基础设施读取失败");
        setState({ status: "ready", data, error: "" });
      })
      .catch((error) => setState({ status: "error", data: null, error: error.message || "运行基础设施读取失败" }));
  }

  useEffect(() => {
    load();
    const refreshTimer = window.setInterval(() => load({ quiet: true }), 30_000);
    return () => window.clearInterval(refreshTimer);
  }, []);

  const infrastructure = Array.isArray(state.data?.infrastructure) ? state.data.infrastructure : [];
  const employeeOptions = Array.isArray(state.data?.employeeOptions) ? state.data.employeeOptions : [];
  const visible = useMemo(() => infrastructure.filter((item) => item.kind === sheet), [infrastructure, sheet]);
  const available = infrastructure.filter((item) => item.status === "available").length;
  const totalGpu = infrastructure.reduce((total, item) => total + Number(item.gpuTotal || 0), 0);
  const freeGpu = infrastructure.reduce((total, item) => total + Number(item.gpuAvailable || 0), 0);

  async function probe(item) {
    setProbingId(item.id);
    setFeedback("");
    try {
      const response = await fetch(`/api/runtime-infrastructure/${encodeURIComponent(item.id)}/probe`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      });
      const data = await response.json().catch(() => ({}));
      setFeedback(response.ok ? "管理员只读联通测试通过。" : data.message || "联通测试失败。");
      load();
    } catch (error) {
      setFeedback(error.message || "联通测试失败。");
    } finally {
      setProbingId("");
    }
  }

  function openAddForm() {
    setDraft(initialDraft);
    setEditingItem(null);
    setFeedback("");
    setShowAddForm(true);
  }

  function openEditForm(item) {
    setSheet(item.kind);
    setDraft({
      kind: item.kind,
      name: item.name,
      connectionRef: "",
      cliAdapter: item.cliAdapter || "auto",
      gpuTotal: item.gpuTotal ? String(item.gpuTotal) : "",
      gpuAvailable: item.gpuAvailable ? String(item.gpuAvailable) : "",
      employeeId: "",
    });
    setEditingItem(item);
    setFeedback("");
    setShowAddForm(true);
  }

  function closeForm() {
    setShowAddForm(false);
    setEditingItem(null);
  }

  async function saveInfrastructure() {
    setSaving(true);
    setFeedback("");
    try {
      const saved = editingItem
        ? await requestJson(`/api/runtime-infrastructure/${encodeURIComponent(editingItem.id)}`, "PATCH", draft)
        : await requestJson("/api/runtime-infrastructure", "POST", draft);
      const infrastructureId = saved.infrastructure?.id;
      if (!infrastructureId) throw new Error("资源登记失败，请重试。");
      if (!editingItem) {
        const employeeId = draft.employeeId || employeeOptions[0]?.id;
        if (!employeeId) throw new Error("请选择使用该资源的数字员工。");
        await requestJson(`/api/runtime-infrastructure/${encodeURIComponent(infrastructureId)}/bindings`, "POST", {
          employeeId,
          executionScopes: draft.kind === "cluster" ? ["gpu_training", "object_storage_mount"] : ["algorithm_inference"],
          gpuLimit: draft.kind === "cluster" ? 1 : 0,
          concurrencyLimit: 1,
        });
      }
      const response = await fetch(`/api/runtime-infrastructure/${encodeURIComponent(infrastructureId)}/probe`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      });
      const result = await response.json().catch(() => ({}));
      setFeedback(response.ok
        ? (editingItem ? "资源已更新并通过管理员联通测试。" : "资源已登记、绑定并通过管理员联通测试。")
        : result.message || (editingItem ? "资源已更新，但联通测试未通过。可修正连接名后重试。" : "资源已登记，但联通测试未通过。可稍后重新测试。"));
      closeForm();
      load();
    } catch (error) {
      setFeedback(error.message || (editingItem ? "资源更新失败。" : "资源登记失败。"));
    } finally {
      setSaving(false);
    }
  }

  const isEditing = Boolean(editingItem);

  return (
    <section className="view-stack runtime-infrastructure-view">
      <div className="metrics-grid">
        <MetricCard label="已登记资源" value={infrastructure.length} detail="管理员登记的 Remote / 集群台账" />
        <MetricCard label="连接可用" value={available} detail="只读联通测试通过" />
        <MetricCard label="GPU 总量" value={totalGpu} detail="已登记容量" />
        <MetricCard label="GPU 可用" value={freeGpu} detail="容量摘要，不代表已获执行许可" />
      </div>
      <section className="panel">
        <div className="panel-head">
          <div>
            <h2>运行基础设施</h2>
            <p>这里是总管理登记运行资源的地方；数字员工详情页只选择启用或关闭已登记设备。</p>
          </div>
          <div className="runtime-infrastructure-view-actions">
            <button className="ghost-action" type="button" onClick={openAddForm} disabled={saving}><Plus size={15} />新增资源</button>
            <button className="ghost-action" type="button" onClick={load}><RefreshCw size={15} />刷新</button>
          </div>
        </div>
        <div className="runtime-infrastructure-sheet-tabs" role="tablist" aria-label="运行基础设施分类">
          <button className={sheet === "remote" ? "is-active" : ""} type="button" role="tab" aria-selected={sheet === "remote"} onClick={() => setSheet("remote")}>Remote</button>
          <button className={sheet === "cluster" ? "is-active" : ""} type="button" role="tab" aria-selected={sheet === "cluster"} onClick={() => setSheet("cluster")}>集群</button>
        </div>
        {showAddForm ? (
          <section className="runtime-infrastructure-form runtime-infrastructure-ledger-form" aria-label={isEditing ? "编辑运行资源" : "新增运行资源"}>
            <div className="runtime-infrastructure-segmented" role="group" aria-label="资源类型">
              <button className={draft.kind === "remote" ? "is-active" : ""} type="button" disabled={isEditing} onClick={() => setDraft((current) => ({ ...current, kind: "remote" }))}>Remote</button>
              <button className={draft.kind === "cluster" ? "is-active" : ""} type="button" disabled={isEditing} onClick={() => setDraft((current) => ({ ...current, kind: "cluster" }))}>集群</button>
            </div>
            <label className="runtime-infrastructure-field"><span>资源名称</span><input value={draft.name} onChange={(event) => setDraft((current) => ({ ...current, name: event.target.value }))} placeholder={draft.kind === "cluster" ? "算法训练集群" : "算法 Remote"} /></label>
            <label className="runtime-infrastructure-field"><span>已配置连接名</span><input value={draft.connectionRef} onChange={(event) => setDraft((current) => ({ ...current, connectionRef: event.target.value }))} placeholder={isEditing ? "填写替换后的连接名" : "填写已配置的连接名"} /></label>
            {!isEditing ? (
              <label className="runtime-infrastructure-field"><span>供哪个数字员工使用</span><select value={draft.employeeId} onChange={(event) => setDraft((current) => ({ ...current, employeeId: event.target.value }))}>{employeeOptions.map((employee) => <option key={employee.id} value={employee.id}>{employee.name}</option>)}</select></label>
            ) : null}
            <label className="runtime-infrastructure-field"><span>GPU 总数</span><input type="number" min="0" value={draft.gpuTotal} onChange={(event) => setDraft((current) => ({ ...current, gpuTotal: event.target.value }))} /></label>
            <label className="runtime-infrastructure-field"><span>当前空闲 GPU</span><input type="number" min="0" value={draft.gpuAvailable} onChange={(event) => setDraft((current) => ({ ...current, gpuAvailable: event.target.value }))} /></label>
            {draft.kind === "cluster" ? (
              <label className="runtime-infrastructure-field"><span>集群 CLI</span><select value={draft.cliAdapter} onChange={(event) => setDraft((current) => ({ ...current, cliAdapter: event.target.value }))}><option value="auto">自动探测</option><option value="schedctl">schedctl</option><option value="schedctl_object">schedctl_object</option></select></label>
            ) : null}
            <div className="runtime-infrastructure-form-actions">
              <button className="ghost-action" type="button" onClick={closeForm} disabled={saving}>取消</button>
              <button className="ghost-action runtime-infrastructure-confirm-action" type="button" onClick={saveInfrastructure} disabled={saving}><Link2 size={15} />{saving ? "处理中" : isEditing ? "保存并测试" : "登记并测试"}</button>
            </div>
          </section>
        ) : null}
        {feedback ? <p className="runtime-infrastructure-feedback" role="status">{feedback}</p> : null}
        {state.status === "error" ? <p className="runtime-infrastructure-page-error">{state.error}</p> : null}
        <div className="runtime-infrastructure-ledger-wrap">
          <table className="runtime-infrastructure-ledger">
            <thead><tr><th>资源</th><th>账号</th><th>GPU</th><th>集群 CLI</th><th>绑定员工</th><th>连接状态</th><th>最近检测</th><th aria-label="操作" /></tr></thead>
            <tbody>
              {visible.map((item) => (
                <tr key={item.id}>
                  <td><strong>{item.name}</strong><small>{item.credentialStatus}</small></td>
                  <td>{item.accountMasked}</td>
                  <td><span className="runtime-infrastructure-gpu"><Cpu size={14} />{gpuCapacityLabel(item)}</span>{item.detectedGpuCount ? <small>探测 {item.detectedGpuCount}</small> : null}</td>
                  <td>{item.kind === "cluster" ? <><strong>{item.cliAdapterDetected || item.cliAdapter || "待探测"}</strong><small>{cliStatusLabel(item.cliStatus)}</small></> : "-"}</td>
                  <td>{item.boundEmployeeCount ? <><strong>{item.enabledBindingCount || 0} 启用 / {item.disabledBindingCount || 0} 关闭</strong><small>{item.boundEmployeeNames.join(" / ")}</small></> : "未绑定"}</td>
                  <td><span className={`status-pill ${statusTone(item.status)}`}>{item.statusLabel}</span><small>{item.lastProbeSummary}</small></td>
                  <td>{formatTime(item.lastProbeAt)}</td>
                  <td><div className="runtime-infrastructure-row-actions"><button className="icon-action" type="button" title="编辑资源" aria-label={`编辑 ${item.name}`} disabled={saving || probingId === item.id} onClick={() => openEditForm(item)}><Pencil size={15} /></button><button className="ghost-action runtime-infrastructure-test-action" type="button" disabled={probingId === item.id} onClick={() => probe(item)}><RefreshCw size={14} />{probingId === item.id ? "测试中" : "测试联通"}</button></div></td>
                </tr>
              ))}
              {!visible.length ? <tr><td className="runtime-infrastructure-table-empty" colSpan="8"><ServerCog size={17} />暂无{sheet === "cluster" ? "集群" : "Remote"}资源；可新增多条资源，再按员工使用场景绑定。</td></tr> : null}
            </tbody>
          </table>
        </div>
      </section>
    </section>
  );
}

async function requestJson(path, method, body) {
  const response = await fetch(path, {
    method,
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.message || data.error || "操作失败");
  return data;
}

function gpuCapacityLabel(item) {
  if (item.kind === "cluster" && item.cliStatus === "available" && !item.gpuTotal) return "按任务申请";
  return `${item.gpuAvailable}/${item.gpuTotal || "-"}`;
}

function formatTime(value) {
  if (!value) return "待检测";
  return new Date(value).toLocaleString("zh-CN", { hour12: false });
}

function cliStatusLabel(status) {
  return { available: "可用", unavailable: "不可用", not_tested: "待探测" }[status] || "待探测";
}

function statusTone(status) {
  if (status === "available") return "good";
  if (status === "blocked") return "warn";
  return "muted";
}
