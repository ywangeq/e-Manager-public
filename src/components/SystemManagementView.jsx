import { useEffect, useMemo, useState } from "react";
import { Clipboard, Edit3, Import, KeyRound, Plus, Power, RotateCcw, Trash2 } from "lucide-react";
import { statusClass } from "../lib/consoleCatalog";
import MetricCard from "./MetricCard";

const providerLabels = {
  codex: "Codex",
  minimax: "MiniMax",
  smoreai: "公司内部模型",
};

function providerLabel(provider) {
  return providerLabels[provider] || provider;
}

function connectionDepartmentId(connection) {
  return connection.departmentId || "digital-office";
}

function statusLabel(health) {
  if (health === "healthy") return "活跃";
  if (health === "disabled") return "禁用";
  if (health === "planned") return "待接入";
  if (health === "text_smoke_passed") return "文本连通已验证";
  return health;
}

function leaseStatusLabel(status) {
  if (status === "ready") return "服务端可租约";
  if (status === "missing_server_secret") return "缺少服务端凭证";
  if (status === "planned") return "待接入";
  return "待检查";
}

function connectionWorkerPool(connection) {
  return connection.workerPool || {};
}

function workerSlots(connection, field) {
  return Number(connectionWorkerPool(connection)[field] || 0);
}

async function copyText(text) {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text);
    return;
  }

  const textarea = document.createElement("textarea");
  textarea.value = text;
  textarea.setAttribute("readonly", "");
  textarea.style.position = "fixed";
  textarea.style.left = "-9999px";
  document.body.appendChild(textarea);
  textarea.select();
  const copied = document.execCommand("copy");
  document.body.removeChild(textarea);
  if (!copied) throw new Error("copy failed");
}

export default function SystemManagement({ session }) {
  const [connections, setConnections] = useState([]);
  const [departmentDirectory, setDepartmentDirectory] = useState({ departments: [], source: "loading", freshness: "loading" });
  const [loadState, setLoadState] = useState("loading");
  const [busyAction, setBusyAction] = useState("");
  const [feedback, setFeedback] = useState("正在读取服务端 Provider 治理状态和一级部门目录……");
  const [editingConnectionId, setEditingConnectionId] = useState(null);
  const [editDepartmentId, setEditDepartmentId] = useState("");
  const [providerFilter, setProviderFilter] = useState("all");
  const [departmentFilter, setDepartmentFilter] = useState("all");
  const [secretDrafts, setSecretDrafts] = useState({});

  useEffect(() => {
    let isMounted = true;
    fetch("/api/model-provider-connections", { credentials: "include" })
      .then(async (response) => {
        const data = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(data.message || data.error || "Provider 治理状态读取失败");
        return data;
      })
      .then((data) => {
        if (!isMounted) return;
        setConnections(Array.isArray(data.connections) ? data.connections : []);
        setDepartmentDirectory(data.departmentDirectory || { departments: [], source: "unavailable", freshness: "unavailable" });
        setLoadState("ready");
        setFeedback("已读取服务端统一 Provider 治理状态；Runtime、数字员工与 AI Worker 使用同一实时投影。");
      })
      .catch((error) => {
        if (!isMounted) return;
        setConnections([]);
        setLoadState("error");
        setFeedback(error?.message || "服务端 Provider 治理状态暂不可用；页面不会用本地数据伪装成功状态。");
      });
    return () => {
      isMounted = false;
    };
  }, []);

  const departmentOptions = useMemo(
    () => Array.isArray(departmentDirectory.departments) ? departmentDirectory.departments : [],
    [departmentDirectory],
  );
  const departmentById = useMemo(
    () => new Map(departmentOptions.map((department) => [department.id, department])),
    [departmentOptions],
  );
  const departmentLabel = (departmentId) => {
    const department = departmentById.get(departmentId);
    return department?.label || department?.name || (departmentId ? `未映射（${departmentId}）` : "未归属");
  };

  const counts = useMemo(() => {
    const providers = new Set(connections.map((connection) => connection.provider)).size;
    const healthy = connections.filter((connection) => ["healthy", "text_smoke_passed"].includes(connection.health)).length;
    const planned = connections.filter((connection) => connection.health === "planned").length;
    const totalWorkerSlots = connections.reduce((total, connection) => total + workerSlots(connection, "totalWorkerSlots"), 0);
    const reservedWorkerSlots = connections.reduce((total, connection) => total + workerSlots(connection, "reservedWorkerSlots"), 0);
    return { providers, healthy, planned, totalWorkerSlots, reservedWorkerSlots };
  }, [connections]);

  const providerOptions = useMemo(() => Array.from(new Set(connections.map((connection) => connection.provider))).sort(), [connections]);
  const connectionDepartmentOptions = useMemo(() => {
    const connectionDepartmentIds = Array.from(new Set(connections.map((connection) => connectionDepartmentId(connection))));
    return connectionDepartmentIds.map((departmentId) => departmentById.get(departmentId) || {
      id: departmentId,
      name: `未映射（${departmentId}）`,
    });
  }, [connections, departmentById]);
  const filteredConnections = useMemo(
    () =>
      connections.filter((connection) => {
        const matchesProvider = providerFilter === "all" || connection.provider === providerFilter;
        const matchesDepartment = departmentFilter === "all" || connectionDepartmentId(connection) === departmentFilter;
        return matchesProvider && matchesDepartment;
      }),
    [connections, departmentFilter, providerFilter],
  );
  const hasActiveFilters = providerFilter !== "all" || departmentFilter !== "all";

  function resetFilters() {
    setProviderFilter("all");
    setDepartmentFilter("all");
    setFeedback("已清空筛选条件。");
  }

  function updateConnection(connectionId, updater) {
    setConnections((current) => current.map((connection) => (
      connection.id === connectionId ? { ...connection, ...updater(connection) } : connection
    )));
  }

  function mergeConnections(updatedConnections = []) {
    const updates = new Map(updatedConnections.map((connection) => [connection.id, connection]));
    setConnections((current) => current.map((connection) => updates.get(connection.id) || connection));
  }

  async function handleCopy(connection) {
    const value = connection.maskedSecret || connection.name;
    try {
      await copyText(value);
      setFeedback(`已复制 ${connection.name} 的脱敏凭证摘要。`);
    } catch {
      setFeedback(`浏览器未授权剪贴板，当前可手动复制：${value}`);
    }
  }

  async function handleSaveSecret(connection) {
    const secretValue = String(secretDrafts[connection.credentialId] || "").trim();
    if (!secretValue) {
      setFeedback(`请输入 ${connection.credentialName} 的服务端凭证。`);
      return;
    }

    const actionId = `secret:${connection.credentialId}`;
    setBusyAction(actionId);
    try {
      const response = await fetch(`/api/provider-credentials/${encodeURIComponent(connection.credentialId)}/secret`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ secretValue }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok || !data.connection) {
        throw new Error(data.message || data.error || "服务端凭证写入失败");
      }
      mergeConnections(data.connections || [data.connection]);
      setSecretDrafts((current) => ({ ...current, [connection.credentialId]: "" }));
      setFeedback(data.message || `${connection.credentialName} 已写入服务端 Secret Store。`);
    } catch (error) {
      setFeedback(error?.message || "服务端凭证写入失败。");
    } finally {
      setBusyAction("");
    }
  }

  async function handleToggle(connection) {
    const actionId = `route:${connection.id}`;
    setBusyAction(actionId);
    try {
      const response = await fetch(`/api/provider-routes/${encodeURIComponent(connection.id)}`, {
        method: "PATCH",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled: connection.health === "disabled" }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok || !data.connection) throw new Error(data.message || data.error || "Route 状态保存失败");
      updateConnection(connection.id, () => data.connection);
      setFeedback(data.message || "Provider Route 状态已保存。");
    } catch (error) {
      setFeedback(error?.message || "Provider Route 状态保存失败。");
    } finally {
      setBusyAction("");
    }
  }

  function startEdit(connection) {
    setEditingConnectionId(connection.id);
    setEditDepartmentId(connectionDepartmentId(connection));
    setFeedback(`正在为 ${connection.name} 选择治理部门；供应商由 Route 自动带出。`);
  }

  async function saveEdit(connection) {
    if (!editDepartmentId) {
      setFeedback("请选择一个部门。");
      return;
    }
    const actionId = `department:${connection.credentialId}`;
    setBusyAction(actionId);
    try {
      const response = await fetch(`/api/provider-credentials/${encodeURIComponent(connection.credentialId)}`, {
        method: "PATCH",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ departmentId: editDepartmentId }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok || !Array.isArray(data.connections)) throw new Error(data.message || data.error || "部门归属保存失败");
      mergeConnections(data.connections);
      setEditingConnectionId(null);
      setFeedback(data.message || `${connection.name} 已归属 ${departmentLabel(editDepartmentId)}。`);
    } catch (error) {
      setFeedback(error?.message || "部门归属保存失败。");
    } finally {
      setBusyAction("");
    }
  }

  function cancelEdit() {
    setEditingConnectionId(null);
    setEditDepartmentId("");
    setFeedback("已取消部门分配编辑。");
  }

  return (
    <section className="view-stack">
      <div className="metrics-grid">
        <MetricCard label="模型连接" value={connections.length} detail="Route 与凭证分离" />
        <MetricCard label="供应商" value={counts.providers} detail="Codex / 公司内部模型 / MiniMax" />
        <MetricCard label="已验证连接" value={counts.healthy} detail="Provider 能力检查" />
        <MetricCard label="Worker 总量" value={counts.totalWorkerSlots} detail="按 Worker Pool 分配" />
        <MetricCard label="专属保留" value={counts.reservedWorkerSlots} detail="不占共享额度" />
        <MetricCard label="待接入" value={counts.planned} detail="后续可新增连接" />
        <MetricCard label="当前权限" value="Admin" detail={session.name} />
      </div>

      <section className="panel">
        <div className="panel-head">
          <div>
            <p className="eyebrow">System Management / Provider Connections</p>
            <h2>模型供应商与连接</h2>
          </div>
          <button className="ghost-action" type="button" disabled title="待接入受控 Provider Route 登记流程">
            <Plus size={16} />
            新增连接（待接入）
          </button>
        </div>

        <div className="identity-banner credential-plain-banner">
          <strong>安全连接</strong>
          <span>这里聚合展示 Provider Route、服务端 Credential 引用和 Worker Pool；三者拥有独立 ID，真实凭证只进入服务端 Secret Manager。</span>
          <b>普通 Agent 占共享 Worker；专属系统员工绑定保留 Worker</b>
        </div>

        <p className="key-ledger-feedback" role="status">{feedback}</p>
        <ProviderConnectionTable
          departmentFilter={departmentFilter}
          departmentFilterOptions={connectionDepartmentOptions}
          departmentLabel={departmentLabel}
          departmentOptions={departmentOptions}
          editingConnectionId={editingConnectionId}
          editDepartmentId={editDepartmentId}
          hasActiveFilters={hasActiveFilters}
          connections={filteredConnections}
          busyAction={busyAction}
          loadState={loadState}
          providerFilter={providerFilter}
          providerOptions={providerOptions}
          secretDrafts={secretDrafts}
          totalConnectionCount={connections.length}
          onCopy={handleCopy}
          onCancelEdit={cancelEdit}
          onDepartmentChange={setEditDepartmentId}
          onDepartmentFilterChange={setDepartmentFilter}
          onResetFilters={resetFilters}
          onSaveSecret={handleSaveSecret}
          onSaveEdit={saveEdit}
          onProviderFilterChange={setProviderFilter}
          onSecretDraftChange={(credentialId, value) => setSecretDrafts((current) => ({ ...current, [credentialId]: value }))}
          onStartEdit={startEdit}
          onToggle={handleToggle}
        />
      </section>
    </section>
  );
}

function ProviderConnectionTable({
  busyAction,
  connections,
  departmentLabel,
  departmentFilter,
  departmentFilterOptions,
  departmentOptions,
  editingConnectionId,
  editDepartmentId,
  hasActiveFilters,
  loadState,
  onCancelEdit,
  onCopy,
  onDepartmentChange,
  onDepartmentFilterChange,
  onResetFilters,
  onSaveSecret,
  onSaveEdit,
  onProviderFilterChange,
  onSecretDraftChange,
  onStartEdit,
  onToggle,
  providerFilter,
  providerOptions,
  secretDrafts,
  totalConnectionCount,
}) {
  return (
    <div className="key-ledger-wrap">
      <table className="key-ledger-table">
        <thead>
          <tr>
            <th>模型连接 / 凭证</th>
            <th>
              <div className="key-ledger-column-filter" aria-label="供应商筛选">
                <span className="key-ledger-column-title">供应商</span>
                <div className="key-ledger-column-controls">
                  <select value={providerFilter} onChange={(event) => onProviderFilterChange(event.target.value)} aria-label="按供应商筛选">
                    <option value="all">全部供应商</option>
                    {providerOptions.map((provider) => (
                      <option key={provider} value={provider}>
                        {providerLabel(provider)}
                      </option>
                    ))}
                  </select>
                </div>
              </div>
            </th>
            <th>
              <div className="key-ledger-column-filter" aria-label="部门筛选">
                <span className="key-ledger-column-title">部门</span>
                <div className="key-ledger-column-controls">
                  <select value={departmentFilter} onChange={(event) => onDepartmentFilterChange(event.target.value)} aria-label="按部门筛选">
                    <option value="all">全部部门</option>
                    {departmentFilterOptions.map((department) => (
                      <option key={department.id} value={department.id}>
                        {department.name}
                      </option>
                    ))}
                  </select>
                  <button type="button" onClick={onResetFilters} disabled={!hasActiveFilters} title="重置筛选" aria-label="重置供应商和部门筛选">
                    <RotateCcw size={13} />
                  </button>
                  <small>{connections.length} / {totalConnectionCount}</small>
                </div>
              </div>
            </th>
            <th>Agent 资源</th>
            <th>状态</th>
            <th>过期时间</th>
            <th>上次使用时间</th>
            <th>操作</th>
          </tr>
        </thead>
        <tbody>
          {connections.length === 0 ? (
            <tr>
              <td colSpan={8} className="key-ledger-empty">
                {loadState === "loading" ? "正在读取服务端 Provider 治理状态……" : loadState === "error" ? "服务端治理状态不可用，未展示本地替代数据。" : "当前筛选下没有匹配的模型连接。"}
              </td>
            </tr>
          ) : null}
          {connections.map((connection) => (
            <tr key={connection.id}>
              <td>
                <span className="key-ledger-secret">
                  <span className="key-ledger-secret-summary">
                    <strong>{connection.name}</strong>
                    <span>
                      <code>{connection.maskedSecret || "待接入"}</code>
                      <small>{leaseStatusLabel(connection.leaseStatus)}</small>
                    </span>
                  </span>
                  <button type="button" title="复制脱敏摘要" aria-label="复制脱敏摘要" onClick={() => onCopy(connection)}>
                    <Clipboard size={14} />
                  </button>
                </span>
              </td>
              <td>
                <span className="key-provider-cell">
                  <KeyRound size={14} />
                  <span>{providerLabel(connection.provider)}</span>
                </span>
              </td>
              <td>
                {editingConnectionId === connection.id ? (
                  <span className="key-department-editor">
                    <select value={editDepartmentId} onChange={(event) => onDepartmentChange(event.target.value)} aria-label="选择部门">
                      {editDepartmentId && !departmentOptions.some((department) => department.id === editDepartmentId) ? (
                        <option value={editDepartmentId} disabled>未映射：{editDepartmentId}</option>
                      ) : null}
                      {departmentOptions.map((department) => (
                        <option key={department.id} value={department.id}>
                          {department.name}
                        </option>
                      ))}
                    </select>
                    <button type="button" disabled={busyAction === `department:${connection.credentialId}`} onClick={() => onSaveEdit(connection)}>保存</button>
                    <button type="button" disabled={Boolean(busyAction)} onClick={onCancelEdit}>取消</button>
                  </span>
                ) : (
                  <span className="key-department-chip">
                    <span>{departmentLabel(connectionDepartmentId(connection))}</span>
                    <code>{connectionDepartmentId(connection)}</code>
                  </span>
                )}
              </td>
              <td>
                <ConnectionWorkerPool connection={connection} />
              </td>
              <td>
                <span className={`status-pill ${statusClass(connection.health)}`}>{statusLabel(connection.health)}</span>
              </td>
              <td>{connection.expiresAt || "永久有效"}</td>
              <td>{connection.lastUsedAt || "暂未使用"}</td>
              <td>
                <div className="key-ledger-actions">
                  <span className="key-secret-editor">
                    <input
                      type="password"
                      value={secretDrafts[connection.credentialId] || ""}
                      placeholder="服务端凭证"
                      aria-label={`${connection.credentialName} 服务端凭证`}
                      onChange={(event) => onSecretDraftChange(connection.credentialId, event.target.value)}
                    />
                    <button type="button" disabled={busyAction === `secret:${connection.credentialId}`} onClick={() => onSaveSecret(connection)}>
                      {busyAction === `secret:${connection.credentialId}` ? "保存中" : "保存服务端凭证"}
                    </button>
                  </span>
                  <button type="button" disabled title="待接入受控 CCS 导入任务" aria-label="导入到 CCS（待接入）">
                    <Import size={15} />
                    <span>导入（待接入）</span>
                  </button>
                  <button type="button" disabled={busyAction === `route:${connection.id}`} title={connection.health === "disabled" ? "启用" : "禁用"} aria-label={connection.health === "disabled" ? "启用" : "禁用"} onClick={() => onToggle(connection)}>
                    <Power size={15} />
                    <span>{busyAction === `route:${connection.id}` ? "保存中" : connection.health === "disabled" ? "启用" : "禁用"}</span>
                  </button>
                  <button type="button" disabled={!departmentOptions.length || Boolean(busyAction)} title="分配一级部门" aria-label="分配一级部门" onClick={() => onStartEdit(connection)}>
                    <Edit3 size={15} />
                    <span>分配部门</span>
                  </button>
                  <button className="danger" type="button" disabled title="待接入受控退役与审计流程" aria-label="退役连接（待接入）">
                    <Trash2 size={15} />
                    <span>退役（待接入）</span>
                  </button>
                </div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function ConnectionWorkerPool({ connection }) {
  const resource = connectionWorkerPool(connection);
  const total = workerSlots(connection, "totalWorkerSlots");
  const shared = workerSlots(connection, "sharedWorkerSlots");
  const reserved = workerSlots(connection, "reservedWorkerSlots");
  const bindingCount = Array.isArray(resource.specialBindings) ? resource.specialBindings.length : 0;

  return (
    <span className="key-department-chip">
      <span>{total} Worker</span>
      <code>{shared} 共享 / {reserved} 专属</code>
      {bindingCount ? <code>{bindingCount} 个专属绑定</code> : null}
    </span>
  );
}
