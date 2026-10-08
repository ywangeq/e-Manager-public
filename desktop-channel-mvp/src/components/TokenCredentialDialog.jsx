import { useEffect, useRef, useState } from "react";
import { Key, LockKey, X } from "@phosphor-icons/react";
import { normalizeManualBearerInput } from "../../shared/sensitive-text-guard.mjs";

const ERROR_MESSAGES = {
  authentication_required: "请先完成企业认证",
  bearer_not_found: "未识别到有效 Token",
  expired: "Token 已过期，请重新获取",
  tool_not_available: "当前 Tool 未开放",
  unavailable: "授权保存失败",
};

export function TokenCredentialDialog({ toolName, onClose, onSubmit }) {
  const inputRef = useRef(null);
  const pendingRef = useRef(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    inputRef.current?.focus();
    const handleKeyDown = (event) => {
      if (event.key === "Escape" && !pendingRef.current) onClose();
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.removeEventListener("keydown", handleKeyDown);
      if (inputRef.current) inputRef.current.value = "";
    };
  }, []);

  async function handleSubmit(event) {
    event.preventDefault();
    const credentialText = normalizeManualBearerInput(inputRef.current?.value);
    if (inputRef.current) inputRef.current.value = "";
    if (!credentialText) {
      setError("请粘贴 Token 或完整的 Authorization: Bearer ...");
      inputRef.current?.focus();
      return;
    }

    pendingRef.current = true;
    setPending(true);
    setError("");
    const result = await onSubmit(credentialText);
    pendingRef.current = false;
    setPending(false);
    if (result?.available) {
      onClose();
      return;
    }
    setError(ERROR_MESSAGES[result?.status] || "授权保存失败");
    inputRef.current?.focus();
  }

  function closeDialog() {
    if (pending) return;
    if (inputRef.current) inputRef.current.value = "";
    onClose();
  }

  return (
    <div className="token-dialog-layer" role="presentation" onMouseDown={(event) => {
      if (event.target === event.currentTarget) closeDialog();
    }}>
      <section className="token-dialog" role="dialog" aria-modal="true" aria-labelledby="token-dialog-title">
        <header>
          <span className="token-dialog-icon" aria-hidden="true"><Key size={17} weight="bold" /></span>
          <div>
            <strong id="token-dialog-title">添加临时 Token</strong>
            <span>{toolName || "DataFlow 授权"}</span>
          </div>
          <button type="button" title="关闭" aria-label="关闭 Token 输入框" disabled={pending} onClick={closeDialog}><X size={16} /></button>
        </header>
        <form onSubmit={handleSubmit}>
          <label htmlFor="temporary-tool-token">当前用户临时 Token</label>
          <input
            ref={inputRef}
            id="temporary-tool-token"
            name="temporary-tool-token"
            type="password"
            autoComplete="off"
            autoCapitalize="none"
            spellCheck="false"
            placeholder="粘贴 Token 或 Authorization: Bearer ..."
            disabled={pending}
          />
          {error ? <div className="token-dialog-error" role="alert">{error}</div> : null}
          <div className="token-dialog-security"><LockKey size={13} />仅交给本机安全存储，不进入对话</div>
          <div className="token-dialog-actions">
            <button type="button" className="is-secondary" disabled={pending} onClick={closeDialog}>取消</button>
            <button type="submit" className="is-primary" disabled={pending}><LockKey size={14} />{pending ? "正在保存…" : "安全保存"}</button>
          </div>
        </form>
      </section>
    </div>
  );
}
