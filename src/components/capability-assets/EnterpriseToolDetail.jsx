import { statusClass } from "../../lib/consoleCatalog";
import { toolStatusLabel } from "../../lib/enterpriseTools";
import { X } from "lucide-react";

export default function EnterpriseToolDetail({ tool, onClose }) {
  if (!tool) return null;
  return (
    <aside
      className="enterprise-tool-detail enterprise-tool-detail-drawer"
      role="dialog"
      aria-modal="true"
      aria-label={`${tool.displayName || tool.name} 治理详情`}
      onClick={(event) => event.stopPropagation()}
    >
      <div className="enterprise-tool-detail-head">
        <span>
          <strong>{tool.displayName || tool.name}</strong>
        </span>
        <div className="enterprise-tool-detail-actions">
          <em className={`status-pill ${statusClass(tool.status)}`}>{toolStatusLabel(tool.status)}</em>
          <button type="button" onClick={onClose} title="关闭治理详情" aria-label="关闭治理详情">
            <X size={16} />
          </button>
        </div>
      </div>
      <dl className="enterprise-tool-detail-grid">
        <div>
          <dt>凭证边界</dt>
          <dd>{tool.credentialBoundary}</dd>
        </div>
        <div>
          <dt>运行边界</dt>
          <dd>{tool.runtimeBoundary}</dd>
        </div>
        <div>
          <dt>审核门禁</dt>
          <dd>{tool.reviewGate}</dd>
        </div>
        <div>
          <dt>身份模式</dt>
          <dd>{(tool.identityModes || []).join(" / ") || "待声明"}</dd>
        </div>
      </dl>
      <div className="enterprise-tool-checks">
        {(tool.readinessChecks || []).map((check) => (
          <span key={check.id}>
            <strong>{check.label}</strong>
            <em className={`status-pill ${statusClass(check.status)}`}>{check.status}</em>
          </span>
        ))}
      </div>
      <div className="enterprise-tool-command-list">
        <strong>命令提示</strong>
        {(tool.commandHints || []).map((command) => (
          <code key={command}>{command}</code>
        ))}
      </div>
      <div className="enterprise-tool-scope-list">
        <strong>Scope 组</strong>
        <span>{(tool.scopeGroups || []).join(" / ")}</span>
      </div>
    </aside>
  );
}
