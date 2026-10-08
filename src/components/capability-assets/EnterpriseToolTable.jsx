import { Clipboard, ExternalLink, KeyRound, PanelRightOpen, ShieldCheck } from "lucide-react";
import { statusClass } from "../../lib/consoleCatalog";
import { isPendingToolRequest, riskTone, toolRequestBelongsToTool, toolStatusLabel } from "../../lib/enterpriseTools";

export default function EnterpriseToolTable({
  tools = [],
  selectedToolId = "",
  employeeNameById,
  toolRequests = [],
  onSelectTool,
  onRequestTool,
  onOpenConnection,
  onCopyCommand,
}) {
  return (
    <div className="enterprise-tool-table-wrap">
      <table className="enterprise-tool-table">
        <thead>
          <tr>
            <th>工具资产</th>
            <th>类型 / 来源</th>
            <th>Owner / 风险</th>
            <th>权限与凭证边界</th>
            <th>绑定资产</th>
            <th>状态</th>
            <th>操作</th>
          </tr>
        </thead>
        <tbody>
          {tools.length === 0 ? (
            <tr>
              <td colSpan={7} className="enterprise-tool-empty">当前筛选下没有企业工具资产。</td>
            </tr>
          ) : null}
          {tools.map((tool) => (
            <tr key={tool.id} className={selectedToolId === tool.id ? "is-selected" : ""}>
              <td>
                <button className="enterprise-tool-name" type="button" onClick={() => onSelectTool(tool.id)}>
                  <span>
                    <strong>{tool.displayName || tool.name}</strong>
                    <small>{tool.id}</small>
                  </span>
                </button>
              </td>
              <td>
                <span className="enterprise-tool-stack">
                  <b>{tool.toolType}</b>
                  <small>{tool.source}</small>
                </span>
              </td>
              <td>
                <span className="enterprise-tool-stack">
                  <b>{tool.owner}</b>
                  <span className={`status-pill ${riskTone(tool.risk)}`}>风险：{tool.risk}</span>
                </span>
              </td>
              <td>
                <span className="enterprise-tool-boundary">
                  <span>{tool.permissionBoundary}</span>
                </span>
              </td>
              <td>
                <ToolAssetChips
                  employeeIds={tool.boundEmployeeIds}
                  skillIds={tool.boundSkillIds}
                  employeeNameById={employeeNameById}
                  defaultPolicy={tool.defaultEmployeeBindingPolicy}
                  defaultLabel={tool.defaultEmployeeBindingLabel}
                />
              </td>
              <td>
                <ToolStatusWithRequests tool={tool} requests={toolRequests} />
              </td>
              <td>
                <div className="enterprise-tool-actions">
                  <button type="button" onClick={() => onSelectTool(tool.id)} title="查看治理详情">
                    <PanelRightOpen size={14} />
                    详情
                  </button>
                  <button type="button" onClick={() => onRequestTool(tool)} title="申请开通">
                    <ShieldCheck size={14} />
                    申请
                  </button>
                  <button type="button" onClick={() => onOpenConnection(tool)} title="联通资料">
                    <KeyRound size={14} />
                    联通
                  </button>
                  <button type="button" onClick={() => onCopyCommand(tool)} title="复制命令">
                    <Clipboard size={14} />
                    命令
                  </button>
                  {tool.sourceUrl ? (
                    <a href={tool.sourceUrl} target="_blank" rel="noreferrer" title="打开来源">
                      <ExternalLink size={14} />
                      来源
                    </a>
                  ) : null}
                </div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function ToolAssetChips({ employeeIds = [], skillIds = [], employeeNameById, defaultPolicy = "", defaultLabel = "" }) {
  const employeeLabels = employeeIds.map((id) => employeeNameById.get(id) || id);
  return (
    <span className="enterprise-tool-chip-list">
      {defaultPolicy === "all_digital_employees" ? <b>{defaultLabel || "全部数字员工"}</b> : null}
      {employeeLabels.slice(0, 2).map((label) => (
        <b key={`employee-${label}`}>{label}</b>
      ))}
      {employeeLabels.length > 2 ? <b>+{employeeLabels.length - 2} 员工</b> : null}
      {skillIds.slice(0, 2).map((id) => (
        <code key={`skill-${id}`}>{id}</code>
      ))}
      {skillIds.length > 2 ? <code>+{skillIds.length - 2} Skill</code> : null}
    </span>
  );
}

function ToolStatusWithRequests({ tool, requests = [] }) {
  const relatedRequests = requests.filter((request) => toolRequestBelongsToTool(request, tool));
  const pendingCount = relatedRequests.filter(isPendingToolRequest).length;
  const latestApplied = relatedRequests.find((request) => request.status === "已生效");
  if (pendingCount) return <span className="status-pill warn">待审批 {pendingCount}</span>;
  if (latestApplied) return <span className={`status-pill ${latestApplied.action === "enable" ? "good" : "muted"}`}>{latestApplied.action === "enable" ? "已允许" : "已关闭"}</span>;
  return <span className={`status-pill ${statusClass(tool.status)}`}>{toolStatusLabel(tool.status)}</span>;
}
