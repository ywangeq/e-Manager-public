import { Check, Pencil, X } from "lucide-react";
import { useEffect, useState } from "react";
import { updateDigitalEmployeeDisplayName } from "../../lib/digitalEmployeeProfile";

export default function EmployeeDisplayNameEditor({ employee, canRename = false, onEmployeeChange = null }) {
  const [editing, setEditing] = useState(false);
  const [displayName, setDisplayName] = useState(employee.name || "");
  const [actionState, setActionState] = useState({ status: "idle", message: "" });

  useEffect(() => {
    if (!editing) setDisplayName(employee.name || "");
  }, [editing, employee.name]);

  async function save(event) {
    event.preventDefault();
    const nextName = displayName.replace(/\s+/g, " ").trim();
    if (nextName.length < 2 || nextName === employee.name) return;
    setActionState({ status: "saving", message: "" });
    try {
      const data = await updateDigitalEmployeeDisplayName(employee.id, nextName);
      setActionState({ status: "saved", message: data.message });
      setEditing(false);
      await onEmployeeChange?.(data.digitalEmployee);
    } catch (error) {
      setActionState({ status: "error", message: error?.message || "展示名称保存失败" });
    }
  }

  function cancel() {
    setDisplayName(employee.name || "");
    setEditing(false);
    setActionState({ status: "idle", message: "" });
  }

  return (
    <div className="employee-display-name-editor">
      <div className="employee-display-name-summary">
        <span>
          <small>展示名称</small>
          <strong>{employee.name}</strong>
          <em>技术 ID 保持为 {employee.id}</em>
        </span>
        {canRename && !editing ? (
          <button className="ghost-action" type="button" onClick={() => setEditing(true)}>
            <Pencil size={14} />修改名称
          </button>
        ) : null}
      </div>

      {editing ? (
        <form className="employee-display-name-form" onSubmit={save}>
          <label>
            <span>新展示名称</span>
            <input
              autoFocus
              maxLength={80}
              value={displayName}
              onChange={(event) => setDisplayName(event.target.value)}
              placeholder="例如：SMoss开发助手"
            />
          </label>
          <div>
            <button className="ghost-action" type="button" onClick={cancel}><X size={14} />取消</button>
            <button className="primary-action" type="submit" disabled={actionState.status === "saving" || displayName.trim().length < 2 || displayName.trim() === employee.name}>
              <Check size={14} />{actionState.status === "saving" ? "保存中…" : "保存并同步"}
            </button>
          </div>
        </form>
      ) : null}

      <small className="employee-display-name-boundary">
        中心目录是名称权威；管理台立即刷新，桌面端和其他入口在下次目录刷新时同步。历史任务保留当时名称。
      </small>
      {actionState.message ? <small className={`employee-display-name-message ${actionState.status === "error" ? "is-error" : ""}`}>{actionState.message}</small> : null}
    </div>
  );
}
