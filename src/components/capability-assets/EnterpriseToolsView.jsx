import ToolAssetRegistration from "./ToolAssetRegistration";
import { RotateCcw } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { departmentNameById } from "../../lib/consoleCatalog";
import { fetchToolBindingRequests, postToolBindingDecision, postToolBindingRequest } from "../../lib/controlPlane";
import { isPendingToolRequest, safeToolText, toolKindOptions, toolOwnerOptions } from "../../lib/enterpriseTools";
import MetricCard from "../MetricCard";
import EnterpriseToolApprovalQueue from "./EnterpriseToolApprovalQueue";
import EnterpriseToolDetail from "./EnterpriseToolDetail";
import EnterpriseToolTable from "./EnterpriseToolTable";

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

export default function EnterpriseToolsView({ tools = [], employees = [], query = "", onToolBindingChange = null, onToolCatalogChange = null }) {
  const [toolTypeFilter, setToolTypeFilter] = useState("all");
  const [ownerFilter, setOwnerFilter] = useState("all");
  const [selectedToolId, setSelectedToolId] = useState(() => tools[0]?.id || "");
  const [isToolDetailOpen, setIsToolDetailOpen] = useState(false);
  const [feedback, setFeedback] = useState("企业工具是执行手段和连接器资产；开关、凭证和权限必须走治理门禁。");
  const [toolRequests, setToolRequests] = useState([]);
  const [requestAccess, setRequestAccess] = useState({ canManage: false, status: "loading" });
  const [decisionState, setDecisionState] = useState({});

  const employeeNameById = useMemo(() => new Map(employees.map((employee) => [employee.id, employee.name || employee.id])), [employees]);
  const normalizedQuery = query.trim().toLowerCase();
  const filteredTools = useMemo(
    () =>
      tools.filter((tool) => {
        const matchesQuery = !normalizedQuery || safeToolText(tool).includes(normalizedQuery);
        const matchesType = toolTypeFilter === "all" || tool.toolType === toolTypeFilter;
        const matchesOwner = ownerFilter === "all" || tool.ownerDepartmentId === ownerFilter;
        return matchesQuery && matchesType && matchesOwner;
      }),
    [normalizedQuery, ownerFilter, toolTypeFilter, tools],
  );
  const selectedTool = filteredTools.find((tool) => tool.id === selectedToolId) || filteredTools[0] || tools[0];
  const highRiskCount = tools.filter((tool) => /高|生产|写回/i.test(tool.risk)).length;
  const pendingToolRequests = toolRequests.filter(isPendingToolRequest);
  const appliedToolRequests = toolRequests.filter((request) => request.status === "已生效");
  const connectedCount = tools.filter((tool) => ["启用", "在线", "可复用", "受限"].includes(tool.status)).length + appliedToolRequests.filter((request) => request.action === "enable").length;
  const hasActiveFilters = toolTypeFilter !== "all" || ownerFilter !== "all";

  useEffect(() => {
    refreshToolRequests();
  }, []);

  async function refreshToolRequests() {
    try {
      const data = await fetchToolBindingRequests();
      setToolRequests(data.toolBindingRequests || []);
      setRequestAccess({ canManage: Boolean(data.canManage), status: "ready" });
    } catch (error) {
      setRequestAccess({ canManage: false, status: "error" });
      setFeedback(error?.message || "工具审批记录加载失败");
    }
  }

  function resetFilters() {
    setToolTypeFilter("all");
    setOwnerFilter("all");
    setFeedback("已清空企业工具筛选。");
  }

  function openToolDetail(toolId) {
    setSelectedToolId(toolId);
    setIsToolDetailOpen(true);
  }

  async function copyCommand(tool) {
    const text = (tool.commandHints || []).join("\n") || tool.name;
    try {
      await copyText(text);
      setFeedback(`已复制 ${tool.displayName || tool.name} 的命令提示。`);
    } catch {
      setFeedback(`浏览器未授权剪贴板，可手动复制：${text}`);
    }
  }

  async function openRequest(tool) {
    const employeeId = tool.boundEmployeeIds?.[0] || "";
    if (!employeeId) {
      setFeedback(`${tool.displayName || tool.name} 尚未绑定员工；请先从数字员工工具页发起具体员工的 Tool 开通申请。`);
      return;
    }
    try {
      const employeeName = employeeNameById.get(employeeId) || employeeId;
      const result = await postToolBindingRequest({
        action: "enable",
        employeeId,
        toolId: tool.id,
        toolName: tool.displayName || tool.name,
        reason: `申请开启 ${employeeName} 的 ${tool.displayName || tool.name} Tool。`,
        permissionBoundary: tool.permissionBoundary,
        credentialBoundary: tool.credentialBoundary,
        runtimeBoundary: tool.runtimeBoundary,
      });
      await refreshToolRequests();
      if (result.status === "applied") await onToolBindingChange?.();
      setFeedback(
        result.toolBindingRequest?.requestMode === "admin_override"
          ? `${tool.displayName || tool.name} 已由 Tool 治理管理员直接开启并保留审计记录；真实联通和写回仍需独立验证。`
          : result.status === "applied" || result.toolBindingRequest?.requestMode === "default_enabled"
            ? `${tool.displayName || tool.name} 已按企业默认规则开启；真实联通和写回仍需治理确认。`
          : `${tool.displayName || tool.name} 的开通申请已进入工具审批队列。`,
      );
    } catch (error) {
      setFeedback(error?.message || `${tool.displayName || tool.name} 开通申请提交失败`);
    }
  }

  function openConnection(tool) {
    setFeedback(`${tool.displayName || tool.name} 的联通资料必须由凭证责任人在服务端 Secret 管理录入。`);
  }

  async function decideToolRequest(request, decision) {
    setDecisionState((current) => ({ ...current, [request.id]: "saving" }));
    try {
      await postToolBindingDecision(request.id, {
        decision,
        notes: decision === "approved"
          ? "确认工具来源、凭证边界、权限 scope、写回和真实联通门禁。"
          : "退回补齐工具来源、凭证边界、权限 scope、写回或 owner 确认。",
      });
      await refreshToolRequests();
      await onToolBindingChange?.();
      setFeedback(`${request.toolName || request.toolId} 已${decision === "approved" ? "通过" : "驳回"}工具审批。`);
    } catch (error) {
      setFeedback(error?.message || "工具审批写入失败");
    } finally {
      setDecisionState((current) => ({ ...current, [request.id]: "" }));
    }
  }

  return (
    <section className="view-stack enterprise-tools-view">
      <div className="metrics-grid enterprise-tool-metrics">
        <MetricCard label="企业工具" value={tools.length} detail="CLI / Connector / API" />
        <MetricCard label="受控启用" value={connectedCount} detail="仍需调用门禁" />
        <MetricCard label="待审批" value={pendingToolRequests.length} detail="Tool 开关变更" />
        <MetricCard label="高风险" value={highRiskCount} detail="凭证 / 写回需人审" />
      </div>

      <section className="panel enterprise-tool-panel">
        <div className="panel-head">
          <div>
            <p className="eyebrow">Enterprise Tools / Asset Ledger</p>
            <h2>企业工具管理</h2>
          </div>

        </div>

        <div className="identity-banner credential-plain-banner">
          <strong>Skill 与 Tool 分离</strong>
          <span>Skill 是能力模块；企业工具是 CLI、连接器、受控 API、webhook 或 runtime adapter。数字员工可绑定工具，但工具开通不等于 Skill 发布或生产可调用。</span>
          <b>{requestAccess.status === "loading" ? "正在读取工具审批记录" : "raw secret、token、执行 payload 和客户数据不进前端"}</b>
        </div>

        <ToolAssetRegistration onChanged={onToolCatalogChange} />

        <EnterpriseToolApprovalQueue
          requests={toolRequests}
          canManage={requestAccess.canManage}
          decisionState={decisionState}
          employeeNameById={employeeNameById}
          onDecision={decideToolRequest}
        />

        <div className="enterprise-tool-workbench">
          <div className="enterprise-tool-list">
            <div className="enterprise-tool-toolbar">
              <label>
                <span>工具类型</span>
                <select value={toolTypeFilter} onChange={(event) => setToolTypeFilter(event.target.value)}>
                  <option value="all">全部类型</option>
                  {toolKindOptions(tools).map((type) => (
                    <option value={type} key={type}>{type}</option>
                  ))}
                </select>
              </label>
              <label>
                <span>所属部门</span>
                <select value={ownerFilter} onChange={(event) => setOwnerFilter(event.target.value)}>
                  <option value="all">全部部门</option>
                  {toolOwnerOptions(tools).map((departmentId) => (
                    <option value={departmentId} key={departmentId}>{departmentNameById(departmentId)}</option>
                  ))}
                </select>
              </label>
              <button type="button" onClick={resetFilters} disabled={!hasActiveFilters} title="重置筛选" aria-label="重置企业工具筛选">
                <RotateCcw size={14} />
              </button>
              <small>{filteredTools.length} / {tools.length}</small>
            </div>

            <EnterpriseToolTable
              tools={filteredTools}
              selectedToolId={isToolDetailOpen ? selectedTool?.id : ""}
              employeeNameById={employeeNameById}
              toolRequests={toolRequests}
              onSelectTool={openToolDetail}
              onRequestTool={openRequest}
              onOpenConnection={openConnection}
              onCopyCommand={copyCommand}
            />
          </div>

          {selectedTool && isToolDetailOpen ? (
            <div className="enterprise-tool-detail-drawer-backdrop" role="presentation" onClick={() => setIsToolDetailOpen(false)}>
              <EnterpriseToolDetail tool={selectedTool} onClose={() => setIsToolDetailOpen(false)} />
            </div>
          ) : null}
        </div>

        <p className="key-ledger-feedback" role="status">{feedback}</p>
      </section>
    </section>
  );
}
