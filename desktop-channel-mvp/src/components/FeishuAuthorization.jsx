import { useEffect, useRef, useState } from "react";
import { FEISHU_READ_PERMISSIONS } from "../../shared/feishu-authorization-scopes.mjs";

const phaseText = {
  idle: "默认申请日程、文档、会议、纪要四项只读权限。",
  starting: "正在申请授权二维码…", waiting: "请用飞书扫码，并在飞书页面确认本次权限。",
  verifying: "授权已返回，正在匹配企业账号并检查权限…",
  complete: "扫码授权和账号匹配已通过。业务功能仍待接入。",
  permissions_changed: "登录已完成，但已有权限发生缺失，请在飞书授权页确认并重新授权；不视为全部权限保留成功。",
  permissions_unavailable: "账号已关联，但权限暂无法核验，请刷新权限检查。",
  partial: "账号已关联，部分申请权限未授予，请查看下面的权限状态。",
  account_blocked: "授权账号未通过企业身份校验，请确认使用同一账号。",
  expired: "二维码已过期，请重新申请。", failed: "授权未完成，可能被取消、拒绝或网络中断，可重新申请。",
  existing_login_unverified: "检测到本机已有登录，请先点击下方关联/检查按钮核验账号。登录失效或账号不同，请在本机 CLI 完成处理后再申请，避免覆盖其他账号权限。",
  installing: "正在安装官方 CLI，完成后自动重新检测…",
  configuring: "正在生成应用创建入口…",
  configuring_browser: "请在浏览器完成应用创建，完成后自动重新检测。配置期间请勿同时修改本机 CLI 配置。",
  configuration_blocked: "已有应用或无法确认配置状态，请使用已有配置并重新检测。",
  node_missing: "未检测到 Node.js，请从官方入口安装后重新检测。",
  setup_failed: "安装或配置未完成，请检查网络并重新检测后重试。取消不会撤销已完成的本机安装或应用创建。",
  cli_missing: "未安装官方飞书 CLI，请先完成本机安装和应用配置。",
};
const permissionText = { cli_granted: "待确认账号", granted: "已授权", needs_authorization: "待扫码授权", needs_app_permission: "应用未开通 · 需后台申请", unknown: "暂无法确认" };

export function FeishuAuthorization({ desktopApi, onAssociate, associationBusy = false, associationEnabled = false, associationState = "", associationLabel = "确认账号" }) {
  const [snapshot, setSnapshot] = useState({ phase: "idle", permissions: { phase: "unknown", items: [] } });
  const selected = FEISHU_READ_PERMISSIONS.map(item => item.id);
  const [busy, setBusy] = useState(false);
  const [clock, setClock] = useState(Date.now());
  const [autoRefresh, setAutoRefresh] = useState(true);
  const [error, setError] = useState("");
  const actionRef = useRef(null);
  const pending = useRef(false);
  const snapshotRef = useRef(snapshot);
  snapshotRef.current = snapshot;
  const refreshRef = useRef(autoRefresh);
  refreshRef.current = autoRefresh;
  const enabled = Boolean(desktopApi?.feishuAuthorization);
  const active = ["starting", "waiting", "verifying", "installing", "configuring", "configuring_browser"].includes(snapshot.phase);
  useEffect(() => {
    if (!enabled) return;
    let current = true;
    const send = async input => {
      if (pending.current) return;
      pending.current = true;
      setBusy(true); setError("");
      try {
        const result = await desktopApi.feishuAuthorization(input);
        if (current) { if (result?.ok) setSnapshot(result); else setError("操作暂未完成，请重试。"); }
      } catch { if (current) setError("连接服务暂不可用。"); }
      finally { pending.current = false; if (current) setBusy(false); }
    };
    actionRef.current = send;
    void send({ action: "inspect" });
    let refreshes = 0;
    const timer = window.setInterval(() => {
      if (document.visibilityState === "hidden") return;
      setClock(Date.now());
      if (["starting", "waiting", "verifying", "installing", "configuring", "configuring_browser"].includes(snapshotRef.current.phase)) void send({ action: "status" });
      // Bound automatic refresh while this panel is open; no background endless flow.
      else if (snapshotRef.current.phase === "expired" && refreshRef.current && refreshes < 3) {
        refreshes++; void send({ action: "refresh" });
      }
    }, 1000);
    return () => {
      current = false; actionRef.current = null; window.clearInterval(timer);
      void desktopApi.feishuAuthorization({ action: "cancel" }).catch(() => {});
    };
  }, [desktopApi, enabled]);
  useEffect(() => { void actionRef.current?.({ action: "inspect" }); }, [associationState]);
  const act = (action) => actionRef.current?.(action === "begin" ? { action, permissions: selected } : { action });
  const items = FEISHU_READ_PERMISSIONS.map(item => {
    const state = snapshot.permissions?.items?.find(value => value.id === item.id)?.state || "unknown";
    return { ...item, state: state === "granted" && associationState !== "authenticated" ? "cli_granted" : state };
  });
  const step = snapshot.setup?.cli !== "installed" ? 1 : snapshot.setup?.app !== "configured" ? 2 : 3;
  const complete = items.every(item => item.state === "granted");
  const associate = async () => { await onAssociate?.(); void act("inspect"); };
  return <div className="feishu-authorization">
    <h4>连接你的飞书</h4>
    <ol className="feishu-step-progress" aria-label="飞书配置进度">{["检查与安装", "配置应用", "确认账号与授权"].map((label, index) => {
      const number = index + 1;
      const state = number < step || number === 3 && complete ? "done" : number === step ? "current" : "pending";
      const text = { done: "已完成", current: "当前步骤", pending: "待完成" }[state];
      return <li key={label} aria-current={number === step ? "step" : undefined}><i className="feishu-status-light" data-state={state} role="img" title={text} aria-label={text} /><strong>{number} · {label}</strong></li>;
    })}</ol>
    <div className="feishu-current-step">
      {step === 1 ? <>
        <p className="subsystem-note">自动检查本机环境；缺少飞书 CLI 时，点击开始配置即可安装。</p>
        {snapshot.setup?.cli === "missing" ? <button type="button" disabled={!enabled || busy || active} onClick={() => act("install")}>开始配置 · 安装 CLI</button> : null}
        <button type="button" disabled={!enabled || busy || active} onClick={() => act("inspect")}>重新检测</button>
        {snapshot.phase === "node_missing" ? <a href="https://nodejs.org/zh-cn/download" target="_blank" rel="noreferrer">安装 Node.js</a> : null}
      </> : step === 2 ? <>
        <p className="subsystem-note">创建你自己的飞书应用，完成后自动进入账号授权。</p>
        {snapshot.setup?.app === "missing" ? <button type="button" disabled={busy || active} onClick={() => act("configure")}>浏览器创建并配置应用</button> : null}
        {snapshot.phase === "configuring_browser" ? <button type="button" disabled={busy} onClick={() => act("open")}>打开应用创建引导</button> : null}
        <a href="https://open.feishu.cn/app" target="_blank" rel="noreferrer">飞书应用管理 / 创建应用</a>
        <details><summary>已有应用，如何配置？</summary><p>使用自己的 App ID 和 App Secret 在本机执行 <code>lark-cli config init</code>，然后重新检测。密钥由本机 CLI 保管。</p></details>
        <button type="button" disabled={busy || active} onClick={() => act("inspect")}>重新检测配置</button>
      </> : <>
        <p className="subsystem-note">先确认飞书账号与当前企业账号匹配，再申请日程、文档、会议、纪要四项只读权限。</p>
        <div className="feishu-permission-list" aria-label="飞书只读权限">{items.map(item => <label key={item.id}><span><strong>{item.label}</strong></span><i className="feishu-status-light" data-state={item.state === "granted" ? "done" : ["cli_granted", "needs_authorization", "needs_app_permission"].includes(item.state) ? "current" : "pending"} role="img" title={permissionText[item.state]} aria-label={`${item.label}：${permissionText[item.state]}`} /></label>)}</div>
        {snapshot.permissions?.phase === "unavailable" ? <p className="subsystem-note">权限暂无法查询，请重新检测；查询失败不代表管理员未审批。</p> : null}
        {items.some(item => item.state === "needs_app_permission") ? <p className="subsystem-note">应用权限尚未开通，请在飞书后台开通并发布。企业要求审批时需管理员批准，扫码不能替代。<a href="https://open.feishu.cn/app" target="_blank" rel="noreferrer">打开应用权限管理</a></p> : null}
        {snapshot.retainedScopeCount > 0 ? <p className="subsystem-note">保留已有 {snapshot.retainedScopeCount} 项授权，申请上述四项只读权限。</p> : null}
        {snapshot.phase === "waiting" && snapshot.qrImage ? <div className="feishu-qr"><img src={snapshot.qrImage} alt="飞书登录授权二维码" /><div><strong>等待扫码确认</strong><p>剩余 {Math.max(0, Math.ceil((snapshot.expiresAt - clock) / 1000))} 秒</p><button type="button" disabled={busy} onClick={() => act("open")}>浏览器打开授权页</button></div></div> : null}
        <div className="feishu-auth-actions">
          <button type="button" disabled={!enabled || !associationEnabled || busy || active || associationBusy} onClick={() => void associate()}>{associationBusy ? "正在确认…" : associationLabel}</button>
          <button type="button" disabled={!enabled || busy || active || associationBusy} onClick={() => act("begin")}>{snapshot.phase === "expired" ? "重新生成二维码" : "生成二维码 / 授权四项权限"}</button>
          <button type="button" disabled={!enabled || busy || active} onClick={() => act("inspect")}>检查权限</button>
          <label><input type="checkbox" checked={autoRefresh} onChange={event => setAutoRefresh(event.target.checked)} />二维码到期自动刷新</label>
        </div>
      </>}
      {snapshot.phase !== "idle" ? <p className="subsystem-note" role="status">{phaseText[snapshot.phase]}</p> : null}
      {active ? <button type="button" disabled={busy} onClick={() => { setAutoRefresh(false); void act("cancel"); }}>取消当前操作</button> : null}
      {error ? <p className="subsystem-action-error" role="alert">{error}</p> : null}
    </div>
  </div>;
}
