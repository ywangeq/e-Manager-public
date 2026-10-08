import { Check, KeyRound, Loader2, RadioTower, ShieldCheck, X } from "lucide-react";
import { useEffect, useState } from "react";
import { createPortal } from "react-dom";

export default function FeishuAdapterRegistrationModal({ employee, isSystemAdmin = false, open, onClose }) {
  const [registration, setRegistration] = useState(null);
  const [state, setState] = useState("idle");
  const [message, setMessage] = useState("");
  const [form, setForm] = useState({ appId: "", appSecret: "" });
  const endpoint = `/api/feishu/integrations/${encodeURIComponent(employee.id)}/registration`;
  const canSubmit = isSystemAdmin && /^cli_[A-Za-z0-9]{6,}$/.test(form.appId.trim()) && form.appSecret.trim().length >= 12 && state !== "saving";

  useEffect(() => {
    if (!open) return undefined;
    let canceled = false;
    setState("loading");
    setMessage("");
    fetchJson(endpoint)
      .then((data) => {
        if (canceled) return;
        setRegistration(data);
        setState("ready");
      })
      .catch((error) => {
        if (canceled) return;
        setState("error");
        setMessage(error?.message || "飞书适配器状态读取失败");
      });
    return () => { canceled = true; };
  }, [endpoint, open]);

  if (!open) return null;

  async function registerAdapter() {
    if (!canSubmit) return;
    setState("saving");
    setMessage("");
    try {
      const data = await fetchJson(endpoint, {
        method: "POST",
        body: JSON.stringify({
          appId: form.appId.trim(),
          appSecret: form.appSecret.trim(),
          connectionMode: "websocket",
        }),
      });
      setRegistration(data);
      setForm({ appId: "", appSecret: "" });
      setState("saved");
      setMessage(data.registration?.nextGate || "飞书适配器已登记。重启对应 worker 后继续真实消息验证。");
    } catch (error) {
      setState("error");
      setMessage(error?.message || "飞书适配器注册失败");
    }
  }

  const registered = registration?.registration?.status === "registered";
  const appIdMasked = registration?.registration?.appIdMasked || "";

  return createPortal(
    <div className="feishu-application-backdrop" role="presentation">
      <section className="feishu-application-modal" role="dialog" aria-modal="true" aria-labelledby="feishu-adapter-registration-title">
        <div className="feishu-application-head">
          <span className="feishu-application-icon"><RadioTower size={20} /></span>
          <span>
            <strong id="feishu-adapter-registration-title">注册飞书适配器</strong>
            <small>{employee.name} · 使用该员工自己的 Robot App ID / App Secret</small>
          </span>
          <button className="feishu-application-close" type="button" aria-label="关闭飞书适配器注册窗口" onClick={onClose}>
            <X size={18} />
          </button>
        </div>

        <div className="feishu-application-summary">
          <span>
            <ShieldCheck size={16} />
            <strong>标准注册契约</strong>
            <small>员工 ID 是适配器、凭证和后续事件路由的唯一归属键</small>
          </span>
          <span>
            <strong>{registered ? "已登记" : state === "loading" ? "读取中" : "待登记"}</strong>
            <small>{appIdMasked || "尚未保存 Robot App ID"}</small>
          </span>
        </div>

        <div className="feishu-connection-panel">
          <div className="feishu-connection-head">
            <span>
              <KeyRound size={16} />
              <strong>Robot 凭证</strong>
              <small>默认使用飞书长连接；注册只需要 App ID 和 App Secret。</small>
            </span>
            <b className={registered ? "status-pill good" : "status-pill muted"}>{registered ? "已注册" : "未注册"}</b>
          </div>

          <label className="feishu-application-field">
            <span>App ID</span>
            <input
              value={form.appId}
              placeholder={appIdMasked || "cli_xxxxxxxxxx"}
              disabled={!isSystemAdmin || state === "saving"}
              autoComplete="off"
              onChange={(event) => setForm((current) => ({ ...current, appId: event.target.value }))}
            />
            <small>一个 App ID 只能绑定一个数字员工；系统会拒绝跨员工复用。</small>
          </label>

          <label className="feishu-application-field">
            <span>App Secret</span>
            <input
              type="password"
              value={form.appSecret}
              placeholder={registered ? "重新输入以更新凭证" : "输入飞书 Robot App Secret"}
              disabled={!isSystemAdmin || state === "saving"}
              autoComplete="new-password"
              onChange={(event) => setForm((current) => ({ ...current, appSecret: event.target.value }))}
            />
            <small>只提交到服务端加密凭证库，不回显、不写日志、不进入员工包。</small>
          </label>

          <div className="feishu-applicant-next-step">
            <span>
              {registered ? <Check size={15} /> : <ShieldCheck size={15} />}
              <strong>{registered ? "适配器已登记" : "登记后仍需联通验证"}</strong>
            </span>
            <small>{registration?.registration?.nextGate || "凭证校验通过后，启动该员工的飞书 worker，并完成事件订阅与真实消息回环。"}</small>
          </div>
        </div>

        {message ? <div className={state === "error" ? "feishu-application-error" : "feishu-connection-message"}>{message}</div> : null}

        <div className="feishu-application-actions">
          <button className="feishu-application-secondary" type="button" onClick={onClose}>关闭</button>
          <button className="feishu-application-primary" type="button" disabled={!canSubmit} onClick={registerAdapter}>
            {state === "saving" ? <Loader2 size={15} className="feishu-application-spin" /> : <KeyRound size={15} />}
            {state === "saving" ? "校验并登记中" : registered ? "更新适配器" : "校验并注册"}
          </button>
        </div>
      </section>
    </div>,
    document.querySelector(".console-shell") || document.body,
  );
}

async function fetchJson(url, options = {}) {
  const response = await fetch(url, {
    credentials: "include",
    headers: { "Content-Type": "application/json", ...(options.headers || {}) },
    ...options,
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || data.ok === false) throw new Error(data.message || data.error || "飞书适配器接口失败");
  return data;
}
