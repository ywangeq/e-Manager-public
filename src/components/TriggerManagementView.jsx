import { Activity, Cable, KeyRound, RefreshCw, Workflow } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { fetchTriggerManagement, triggerStatusLabel, triggerStatusTone } from "../lib/triggerManagement.js";
import MetricCard from "./MetricCard";

const sheets = [
  ["systems", "接入系统"],
  ["credentials", "连接与凭证"],
  ["bindings", "Trigger 绑定"],
  ["events", "事件与回执"],
];

export default function TriggerManagementView() {
  const [sheet, setSheet] = useState("systems");
  const [query, setQuery] = useState("");
  const [state, setState] = useState({ status: "loading", data: null, error: "" });

  function load() {
    setState((current) => ({ ...current, status: "loading", error: "" }));
    fetchTriggerManagement()
      .then((data) => setState({ status: "ready", data, error: "" }))
      .catch((error) => setState({ status: "error", data: null, error: error.message || "Trigger 管理数据读取失败" }));
  }

  useEffect(load, []);

  const config = state.data?.configuration || {};
  const systems = config.systems || [];
  const credentials = config.credentials || [];
  const bindings = config.bindings || [];
  const taskDefinitions = config.taskDefinitions || [];
  const materialBindings = config.materialBindings || [];
  const writebackBindings = config.writebackBindings || [];
  const events = state.data?.events || [];
  const employees = new Map((state.data?.employees || []).map((item) => [item.id, item]));
  const definitions = new Map(taskDefinitions.map((item) => [item.taskDefinitionId, item]));
  const normalizedQuery = query.trim().toLowerCase();
  const visible = useMemo(() => {
    const source = { systems, credentials, bindings, events }[sheet] || [];
    if (!normalizedQuery) return source;
    return source.filter((item) => JSON.stringify(item).toLowerCase().includes(normalizedQuery));
  }, [bindings, credentials, events, normalizedQuery, sheet, systems]);
  const configuredCredentials = credentials.filter((item) => item.configured).length;
  const enabledBindings = bindings.filter((item) => item.enabled && item.reviewStatus === "approved").length;
  const issueEvents = events.filter((item) => ["failed", "blocked", "timed_out"].includes(item.taskStatus)).length;

  return (
    <section className="view-stack trigger-management-view">
      <div className="metrics-grid">
        <MetricCard label="接入系统" value={systems.length} detail="当前管理已接入外部系统" />
        <MetricCard label="凭证已配置" value={`${configuredCredentials}/${credentials.length}`} detail="仅显示配置状态，不返回密钥" />
        <MetricCard label="已发布 Trigger" value={enabledBindings} detail="已启用且审核通过" />
        <MetricCard label="需关注事件" value={issueEvents} detail="失败、受阻或超时" />
      </div>
      <section className="panel trigger-management-workbench">
        <div className="panel-head">
          <div>
            <h2>Trigger 管理</h2>
            <p>统一管理外部系统、凭证引用、数字员工绑定和运行回执；Trigger 不编排 Agent 的业务步骤。</p>
          </div>
          <button className="ghost-action" type="button" onClick={load}><RefreshCw size={15} />刷新</button>
        </div>
        <div className="trigger-management-toolbar">
          <div className="trigger-management-tabs" role="tablist" aria-label="Trigger 管理分类">
            {sheets.map(([id, label]) => (
              <button key={id} className={sheet === id ? "is-active" : ""} type="button" role="tab" aria-selected={sheet === id} onClick={() => setSheet(id)}>{label}</button>
            ))}
          </div>
          <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="筛选当前列表" aria-label="筛选 Trigger 管理列表" />
        </div>
        {state.status === "loading" ? <p className="trigger-management-empty">正在读取 Trigger 权威配置…</p> : null}
        {state.status === "error" ? <p className="trigger-management-empty is-error">{state.error}</p> : null}
        {state.status === "ready" ? (
          <div className="trigger-management-table-wrap">
            {sheet === "systems" ? <SystemsTable rows={visible} bindings={bindings} credentials={credentials} /> : null}
            {sheet === "credentials" ? <CredentialsTable rows={visible} /> : null}
            {sheet === "bindings" ? <BindingsTable rows={visible} employees={employees} definitions={definitions} materialBindings={materialBindings} writebackBindings={writebackBindings} /> : null}
            {sheet === "events" ? <EventsTable rows={visible} /> : null}
          </div>
        ) : null}
      </section>
    </section>
  );
}

function SystemsTable({ rows, bindings, credentials }) {
  return <table className="trigger-management-table"><thead><tr><th>系统</th><th>类型</th><th>适配器</th><th>网址</th><th>Owner</th><th>连接资产</th><th>状态</th></tr></thead><tbody>
    {rows.map((item) => <tr key={item.sourceSystemId}><td><strong>{item.displayName}</strong><small>{item.sourceSystemId}</small></td><td>{item.systemType.toUpperCase()}</td><td>{item.adapterFamily}</td><td><SystemUrl url={item.homepageUrl} /></td><td>{item.ownerLabel}</td><td>{credentials.filter((credential) => credential.sourceSystemId === item.sourceSystemId).length} 个凭证 / {bindings.filter((binding) => binding.sourceSystemId === item.sourceSystemId).length} 个 Trigger</td><td><Status status={item.status} /></td></tr>)}
    {!rows.length ? <Empty colSpan="7" icon={Cable} text="暂无接入系统" /> : null}
  </tbody></table>;
}

function CredentialsTable({ rows }) {
  return <table className="trigger-management-table"><thead><tr><th>凭证</th><th>用途</th><th>所属系统</th><th>密钥权威</th><th>配置状态</th><th>边界</th></tr></thead><tbody>
    {rows.map((item) => <tr key={item.credentialRef}><td><strong>{item.displayName}</strong><small>{item.credentialRef}</small></td><td>{credentialTypeLabel(item.credentialType)}</td><td>{item.sourceSystemId}</td><td>{secretAuthorityLabel(item.secretAuthority)}</td><td><span className={`status-pill ${item.configured ? "good" : "warn"}`}>{item.configured ? "已配置" : "未配置"}</span></td><td>不显示明文</td></tr>)}
    {!rows.length ? <Empty colSpan="6" icon={KeyRound} text="暂无凭证引用" /> : null}
  </tbody></table>;
}

function BindingsTable({ rows, employees, definitions, materialBindings, writebackBindings }) {
  return <table className="trigger-management-table"><thead><tr><th>Trigger</th><th>来源事件</th><th>数字员工</th><th>任务定义</th><th>材料 / 回写</th><th>凭证引用</th><th>状态</th></tr></thead><tbody>
    {rows.map((item) => { const employee = employees.get(item.targetEmployeeId); const definition = definitions.get(item.taskDefinitionId); const material = materialBindings.find((candidate) => candidate.taskDefinitionId === item.taskDefinitionId); const writeback = writebackBindings.find((candidate) => candidate.taskDefinitionId === item.taskDefinitionId && definition?.writebackPolicyRef?.includes(candidate.writebackBindingId)); return <tr key={item.bindingId}><td><strong>{item.bindingId}</strong><small>{item.bindingVersion}</small></td><td>{item.sourceSystemId}<small>{item.eventType}</small></td><td>{employee?.name || item.targetEmployeeId}<small>{employee?.status || "目录未解析"}</small></td><td>{item.taskDefinitionId}<small>{definition?.taskDefinitionVersion || "版本未解析"}</small></td><td>{material?.materialBindingId || "按任务读取"}<small>{material?.bindingVersion || "无独立材料版本"}</small>{writeback ? <small>{writeback.writebackBindingId} · {writeback.bindingVersion}</small> : <small>无已发布回写</small>}</td><td>{item.credentialRef}</td><td><Status status={item.enabled && item.reviewStatus === "approved" ? "active" : item.reviewStatus} /></td></tr>; })}
    {!rows.length ? <Empty colSpan="7" icon={Workflow} text="暂无 Trigger 绑定" /> : null}
  </tbody></table>;
}

function EventsTable({ rows }) {
  return <table className="trigger-management-table"><thead><tr><th>发生时间</th><th>来源事件</th><th>数字员工</th><th>任务</th><th>运行状态</th><th>安全诊断</th></tr></thead><tbody>
    {rows.map((item) => <tr key={item.triggerEventId}><td>{formatTime(item.occurredAt)}</td><td>{item.sourceSystemId}<small>{item.eventType}</small></td><td>{item.targetEmployeeName}</td><td>{item.taskId || "未生成"}<small>{item.triggerEventId}</small></td><td><Status status={item.taskStatus} /></td><td>{item.lastErrorCode || item.resultSummary || "暂无异常"}</td></tr>)}
    {!rows.length ? <Empty colSpan="6" icon={Activity} text="暂无 Trigger 事件；系统不会生成示例运行记录" /> : null}
  </tbody></table>;
}

function Status({ status }) { return <span className={`status-pill ${triggerStatusTone(status)}`}>{triggerStatusLabel(status)}</span>; }
function SystemUrl({ url }) {
  if (!url) return <span className="trigger-management-muted">未登记</span>;
  return <a href={url} target="_blank" rel="noreferrer">{new URL(url).host}</a>;
}
function Empty({ colSpan, icon: Icon, text }) { return <tr><td colSpan={colSpan}><span className="trigger-management-empty"><Icon size={17} />{text}</span></td></tr>; }
function credentialTypeLabel(value) { return { webhook_bearer: "入站 Webhook Token", service_account: "出站服务账号" }[value] || value; }
function secretAuthorityLabel(value) { return { server_environment: "服务端环境", fxiaoke_crm_credential_vault: "CRM 加密凭证库" }[value] || value; }
function formatTime(value) { return value ? new Date(value).toLocaleString("zh-CN", { hour12: false }) : "暂无"; }
