import { useId, useState } from "react";
import { ArrowClockwise, CaretDown, CaretUp, Link, PlugsConnected, Database, UsersThree, IdentificationCard, SignOut, SpinnerGap, ArrowRight } from "@phosphor-icons/react";
import { FeishuAuthorization } from "./FeishuAuthorization.jsx";
import { connectionTime, subsystemConnectionPresentation } from "../lib/subsystemConnectionPresentation.js";
import "./subsystem-connections.css";

export function SubsystemConnections({ source, desktopApi, compact = false, onOpen, initialSelectedId = "" }) {
  const [selectedId, setSelectedId] = useState(initialSelectedId);
  const [query, setQuery] = useState("");
  const [confirmDisconnectId, setConfirmDisconnectId] = useState("");
  const detailsId = useId();
  const selected = !compact && source.connections.find(item => item.id === selectedId);
  const view = subsystemConnectionPresentation(selected);
  const busy = Boolean(source.busyId);

  const emptyMessage = {
    loading: "正在同步子系统连接…", error: "子系统连接暂不可用，请刷新驾驶舱后重试。",
    unsupported: "当前客户端暂不支持连接状态检测，请更新后重试。", preview: "登录 Group Studio 后查看当前账号的子系统连接。",
    ready: "当前可用员工没有需要单独认证的子系统。",
  }[source.phase];
  return <section className={`subsystem-connections${compact ? "" : " is-subsystem-page"}`} aria-label="子系统连接">
    <header className="subsystem-heading"><Link size={20} aria-hidden="true" /><h2>子系统连接</h2><p>管理工作空间的账号关联</p>{compact ? <button type="button" className="subsystem-more" onClick={() => onOpen?.()}>更多 <ArrowRight size={14} /></button> : <input aria-label="搜索子系统" placeholder="搜索子系统" value={query} onChange={event => setQuery(event.target.value)} />}</header>
    {!source.connections.length ? <p className="subsystem-empty" role="status">{emptyMessage}</p> : <div className="subsystem-grid">
      {(compact ? source.connections.slice(0, 4) : source.connections.filter(item => item.name.toLowerCase().includes(query.trim().toLowerCase()))).map(connection => {
        const state = subsystemConnectionPresentation(connection);
        const expanded = selected?.id === connection.id;
        const Icon = { database: Database, users: UsersThree, identification: IdentificationCard }[connection.icon] || PlugsConnected;
        return <button key={connection.id} className="subsystem-choice" type="button" aria-expanded={expanded} aria-controls={expanded ? detailsId : undefined}
          onClick={() => { if (compact) { onOpen?.(connection.id); return; } setSelectedId(expanded ? "" : connection.id); setConfirmDisconnectId(""); }}>
          <Icon size={32} aria-hidden="true" /><strong>{connection.name}</strong>
          <span className="subsystem-state" data-tone={state.tone}>{state.label}</span>
          <CaretDown size={15} className="subsystem-choice-chevron" aria-hidden="true" />
        </button>;
      })}
    </div>}
    {selected ? <div className="subsystem-details" id={detailsId}>
      <header><h3>{selected.name} {selected.associationOnly ? "账号关联" : "认证详情"}</h3><button type="button" onClick={() => { setSelectedId(""); setConfirmDisconnectId(""); }}>收起 <CaretUp size={15} aria-hidden="true" /></button></header>
      <p className="subsystem-detail-status subsystem-state" data-tone={view.tone} role="status">{view.message}</p>
      {selected.associationOnly ? <div className="subsystem-personal-setup">
        <FeishuAuthorization desktopApi={desktopApi} associationEnabled={view.actionable} associationState={selected.state} associationBusy={busy} associationLabel={view.actionLabel} onAssociate={() => source.act(view.action, selected.id)} />
        <div className="subsystem-personal-capabilities" aria-label="飞书功能接入状态"><span>日程</span><span>文档</span><span>会议</span><small>功能待接入</small></div>
        <p className="subsystem-note">本版先提供账号关联，暂不能查询上述内容。凭证由本机 CLI 保管；断开关联不会注销飞书登录。</p>
      </div> : null}
      <dl className="subsystem-detail-grid">
        <div><dt title="最近一次由用户发起的连接验证时间；自动检查不更新">{selected.associationOnly ? "关联时间" : "认证时间"}</dt><dd>{connectionTime(selected.authenticatedAt)}</dd></div>
        <div><dt>最近检查</dt><dd>{connectionTime(selected.checkedAt)}</dd></div>
        <div><dt>{selected.associationOnly ? "续期" : "有效期"}</dt><dd title={selected.associationOnly && selected.accessTokenExpiresAt ? `当前访问凭证至 ${connectionTime(selected.accessTokenExpiresAt)}；不表示飞书授权到期。` : undefined}>{selected.associationOnly ? "由飞书 CLI 按官方规则自动续期" : selected.accessTokenExpiresAt ? `访问凭证至 ${connectionTime(selected.accessTokenExpiresAt)}` : selected.renewal === "automatic" ? "自动续期 · 会话有效期待系统确认" : "暂不可获取"}</dd></div>
        <div><dt>关联员工</dt><dd>{selected.employees.map(employee => employee.name).join("、") || (selected.associationOnly ? "尚无员工绑定 · 不影响账号关联" : "暂不可获取")}</dd></div>
      </dl>
      {selected.verifiedAt && selected.state !== "connected" ? <p className="subsystem-note">上次验证通过：{connectionTime(selected.verifiedAt)}</p> : null}
      {selected.authenticatedAt && !selected.associationOnly ? <p className="subsystem-note">认证时间记录本次连接验证，自动续期不更新。</p> : null}
      {selected.state === "connected" && !selected.authenticatedAt ? <p className="subsystem-note">已复用登录会话，历史认证时间暂不可获取。</p> : null}
      {source.actionError ? <p className="subsystem-action-error" role="alert">{source.actionError}</p> : null}
      <footer className="subsystem-detail-footer">
        {view.canDisconnect ? <div className="subsystem-disconnect">{confirmDisconnectId === selected.id ? <><span>{selected.associationOnly ? "断开驾驶舱关联，保留本机飞书登录。" : "退出后，关联员工需要重新认证。"}</span><button type="button" disabled={busy} onClick={() => { void source.act("disconnect", selected.id); setConfirmDisconnectId(""); }}>{selected.associationOnly ? "确认断开" : "确认退出"}</button><button type="button" onClick={() => setConfirmDisconnectId("")}>取消</button></> : <button type="button" disabled={busy} onClick={() => setConfirmDisconnectId(selected.id)}><SignOut size={15} aria-hidden="true" />{selected.associationOnly ? "断开关联" : "退出连接"}</button>}</div> : null}
        {view.actionable && !selected.associationOnly ? <button className="subsystem-action" type="button" disabled={busy} onClick={() => { void source.act(view.action, selected.id); }}>
          {busy && source.busyId === selected.id ? <SpinnerGap size={17} className="subsystem-spinner" aria-hidden="true" /> : view.action === "connect" ? <Link size={17} aria-hidden="true" /> : <ArrowClockwise size={17} aria-hidden="true" />}
          {busy && source.busyId === selected.id ? "正在处理…" : view.actionLabel}
        </button> : null}
      </footer>
    </div> : null}
  </section>;
}
