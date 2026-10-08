import RegisteredToolPolicyPanel from "./RegisteredToolPolicyPanel";
import { Code2, KeyRound, Layers3, Link2, RadioTower, Search, ShieldCheck } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { DetailGrid, SkillChips } from "../ConsolePrimitives";
import { fetchToolBindingRequests, postToolBindingRequest } from "../../lib/controlPlane";
import {
  canonicalEnterpriseToolId,
  DEFAULT_FEISHU_TOOL_DISPLAY_NAME,
  DEFAULT_FEISHU_TOOL_ID,
  employeeToolIdentity as resolveEmployeeToolIdentity,
  toolCanBindToEmployee,
} from "../../lib/enterpriseTools";

function normalizeList(value) {
  if (Array.isArray(value)) return value.map((item) => String(item || "").trim()).filter(Boolean);
  return String(value || "")
    .split(/[\n,，、/]+/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function uniqueList(items = []) {
  return [...new Set(items.map((item) => String(item || "").trim()).filter(Boolean))];
}

function toolName(tool) {
  if (tool && typeof tool === "object") return tool.name || tool.label || tool.id || "";
  return String(tool || "").trim();
}

function normalizeToolItems(value, detail = {}) {
  if (Array.isArray(value)) {
    return value.flatMap((item) => {
      if (item && typeof item === "object") {
        const name = toolName(item);
        return name ? [{ ...detail, ...item, id: item.id || name, name }] : [];
      }
      return normalizeList(item).map((name) => ({ ...detail, id: name, name }));
    });
  }
  return normalizeList(value).map((name) => ({ ...detail, id: name, name }));
}

function inferToolKind(name = "") {
  if (/feishu.*cli|lark.*cli|飞书.*cli|cli|命令|ssh|dvc|gitlab|git\b|rclone|deepseactl|schedctl|codex cli/i.test(name)) return "CLI";
  if (/feishu|lark|飞书|机器人|connector|连接器|插件/i.test(name)) return "连接器";
  if (/api|openapi|rpc|webhook|http|invocation|capability/i.test(name)) return "受控 API";
  if (/ocr|抽取|解析|schema|json|yaml|检查|校验/i.test(name)) return "解析/校验器";
  if (/队列|审批|流程|调度|重试/i.test(name)) return "编排器";
  return "执行工具";
}

function isFeishuConnectorTool(row = {}) {
  return [row.name, ...(row.kinds || []), ...(row.sources || [])].some((value) => /feishu|lark|飞书|机器人/i.test(String(value || "")));
}

const defaultFeishuTool = {
  id: DEFAULT_FEISHU_TOOL_ID,
  name: DEFAULT_FEISHU_TOOL_DISPLAY_NAME,
  kind: "连接器",
  status: "默认开启",
  enabled: true,
  risk: "高",
  defaultEnabled: true,
  permissionScope: "飞书入口、OpenAPI、机器人事件订阅和消息 API 仅允许安全摘要、申请编号和受控回复。",
  credentialBoundary: "server_only_secret_lease",
  writebackBoundary: "默认 dry-run；真实消息回复、文档写回或群操作必须人审。",
  reviewGate: "企业默认开启；飞书 App 凭证、API Scope、群/用户白名单、写回和真实消息回环仍需平台治理确认。",
};

const toolFilterOptions = [
  { id: "recommended", label: "推荐" },
  { id: "all", label: "全部" },
  { id: "cli", label: "CLI" },
  { id: "connector", label: "连接器" },
  { id: "api", label: "API" },
];

function toolCatalogRow(tool = {}) {
  return {
    name: tool.displayName || tool.name || tool.id,
    sources: [tool.source || "企业工具目录"].filter(Boolean),
    sourceKinds: ["企业目录"],
    kinds: [tool.toolType || "执行工具"],
    risks: [tool.risk || "待评估"],
    reviewGates: [tool.reviewGate || "平台管理员 + 员工 owner + 工具 owner 复核"],
    statuses: [tool.status || "待评审"],
    enableds: [false],
    permissionScopes: [tool.permissionBoundary || "随员工权限"],
    credentialBoundaries: [tool.credentialBoundary || "server_only"],
    writebackBoundaries: [tool.writebackBoundary || "按员工输出契约"],
    toolBindingIds: [tool.id || tool.name].filter(Boolean),
    defaultEnabled: tool.defaultEmployeeBindingPolicy === "all_digital_employees" || tool.id === defaultFeishuTool.id,
    catalogTool: tool,
  };
}

function rowMatchesCatalogTool(row = {}, tool = {}) {
  const rowKeys = [row.name, ...(row.toolBindingIds || [])]
    .map(canonicalEnterpriseToolId)
    .map(normalizeToolKey)
    .filter(Boolean);
  const toolKeys = [tool.id, tool.name, tool.displayName]
    .map(canonicalEnterpriseToolId)
    .map(normalizeToolKey)
    .filter(Boolean);
  return rowKeys.some((rowKey) => toolKeys.includes(rowKey));
}

function normalizeToolKey(value = "") {
  return String(value || "").trim().toLowerCase().replace(/[^a-z0-9\u4e00-\u9fa5]+/g, "-").replace(/^-+|-+$/g, "");
}

function toolSummary(row = {}) {
  const tool = row.catalogTool || {};
  return tool.runtimeBoundary || tool.permissionBoundary || row.writebackBoundaries?.[0] || row.permissionScopes?.[0] || "提交前请确认权限、凭证和写回边界。";
}

function isRecommendedTool(row = {}, employee = {}) {
  if (row.defaultEnabled) return true;
  const tool = row.catalogTool || {};
  const employeeDepartmentIds = new Set([employee.ownerDepartmentId, employee.departmentId, ...(employee.departmentIds || [])].filter(Boolean));
  const mountedSkillIds = new Set([...(employee.basicSkillIds || []), ...(employee.businessSkillIds || [])]);
  return (
    (tool.boundEmployeeIds || []).includes(employee.id) ||
    employeeDepartmentIds.has(tool.ownerDepartmentId) ||
    (tool.boundSkillIds || []).some((skillId) => mountedSkillIds.has(skillId))
  );
}

function toolRowSearchText(row = {}) {
  const tool = row.catalogTool || {};
  return [
    row.name,
    ...(row.toolBindingIds || []),
    ...(row.kinds || []),
    ...(row.sources || []),
    ...(row.risks || []),
    tool.vendor,
    tool.owner,
    tool.status,
    ...(tool.tags || []),
    ...(tool.scopeGroups || []),
  ].filter(Boolean).join(" ").toLowerCase();
}

function mountedSkillRecords(employee = {}, basicSkills = [], businessSkills = []) {
  const basicById = new Map(basicSkills.map((skill) => [skill.id, skill]));
  const businessById = new Map(businessSkills.map((skill) => [skill.id, skill]));
  return [
    ...(employee.basicSkillIds || []).map((skillId) => ({ kind: "基础 Skill", skill: basicById.get(skillId), skillId })),
    ...(employee.businessSkillIds || []).map((skillId) => ({ kind: "业务 Skill", skill: businessById.get(skillId), skillId })),
  ].map(({ kind, skill, skillId }) => ({
    kind,
    id: skill?.id || skillId,
    name: skill?.name || skillId,
    risk: skill?.risk || (kind === "业务 Skill" ? "中" : "标准"),
    reviewGate: skill?.reviewGate || "Skill owner 审核",
  }));
}

function employeeToolRows(employee = {}) {
  const rowsByIdentity = new Map();

  function addTool(tool, source, detail = {}) {
    const identity = resolveEmployeeToolIdentity(tool, detail.id);
    if (!identity.key) return;
    const current = rowsByIdentity.get(identity.key) || {
      name: identity.name,
      sources: [],
      sourceKinds: [],
      kinds: [],
      risks: [],
      reviewGates: [],
      statuses: [],
      enableds: [],
      permissionScopes: [],
      credentialBoundaries: [],
      writebackBoundaries: [],
      toolBindingIds: [],
      defaultEnabled: false,
    };
    const kind = tool.kind || detail.kind || inferToolKind(identity.name);
    current.sources.push(source);
    current.sourceKinds.push(tool.sourceKind || detail.sourceKind);
    current.kinds.push(kind);
    current.risks.push(tool.risk || detail.risk);
    current.reviewGates.push(tool.reviewGate || detail.reviewGate);
    current.statuses.push(tool.status || detail.status);
    current.enableds.push(tool.enabled);
    current.permissionScopes.push(tool.permissionScope || detail.permissionScope);
    current.credentialBoundaries.push(tool.credentialBoundary || detail.credentialBoundary);
    current.writebackBoundaries.push(tool.writebackBoundary || detail.writebackBoundary);
    current.toolBindingIds.push(...identity.toolBindingIds);
    current.defaultEnabled = current.defaultEnabled || Boolean(tool.defaultEnabled || detail.defaultEnabled);
    rowsByIdentity.set(identity.key, current);
  }

  normalizeToolItems(employee.toolBindings, { sourceKind: "员工工具绑定" }).forEach((tool) =>
    addTool(tool, "员工工具绑定", {
      sourceKind: "员工",
      risk: employee.risk || "按员工权限范围",
      reviewGate: employee.reviewGate || "负责人确认工具边界",
      status: employee.status,
      permissionScope: employee.permissionSummary || employee.permissionScope,
      credentialBoundary: "server_only",
      writebackBoundary: employee.writebackBoundary || "按员工输出契约",
    }),
  );

  normalizeToolItems(employee.tools).forEach((tool) =>
    addTool(tool, "员工工具声明", {
      sourceKind: "员工",
      risk: employee.risk || "按员工权限范围",
      reviewGate: employee.reviewGate || "负责人确认工具边界",
      status: employee.status,
      permissionScope: employee.permissionSummary || employee.permissionScope,
      credentialBoundary: "server_only",
      writebackBoundary: employee.writebackBoundary || "按员工输出契约",
    }),
  );

  addTool(defaultFeishuTool, "企业默认工具", {
    sourceKind: "平台默认",
    id: defaultFeishuTool.id,
    defaultEnabled: true,
  });

  return [...rowsByIdentity.values()].map((row) => ({
    ...row,
    sources: uniqueList(row.sources),
    sourceKinds: uniqueList(row.sourceKinds),
    kinds: uniqueList(row.kinds),
    risks: uniqueList(row.risks),
    reviewGates: uniqueList(row.reviewGates),
    statuses: uniqueList(row.statuses),
    permissionScopes: uniqueList(row.permissionScopes),
    credentialBoundaries: uniqueList(row.credentialBoundaries),
    writebackBoundaries: uniqueList(row.writebackBoundaries),
    toolBindingIds: uniqueList(row.toolBindingIds),
    defaultEnabled: Boolean(row.defaultEnabled),
  }));
}

function defaultToolEnabled(row = {}) {
  if (row.defaultEnabled) return true;
  if (row.enableds.some((enabled) => enabled === true)) return true;
  if (row.enableds.some((enabled) => enabled === false)) return false;
  if (row.statuses.some((status) => /待|规划|草案|pending/i.test(status))) return false;
  return true;
}

function toolRequestMatchesRow(request = {}, row = {}, employee = {}) {
  if (request.employeeId && employee.id && request.employeeId !== employee.id) return false;
  const rowCatalogId = normalizeToolKey(canonicalEnterpriseToolId(row.catalogTool?.id));
  const requestToolId = normalizeToolKey(canonicalEnterpriseToolId(request.toolId));
  if (requestToolId && rowCatalogId) return requestToolId === rowCatalogId;

  const requestIds = [request.toolBindingId, request.toolName]
    .map(canonicalEnterpriseToolId)
    .map(normalizeToolKey)
    .filter(Boolean);
  const rowIds = [row.name, ...(row.toolBindingIds || [])]
    .map(canonicalEnterpriseToolId)
    .map(normalizeToolKey)
    .filter(Boolean);
  return requestIds.some((requestId) => rowIds.includes(requestId));
}

function latestToolRequest(row = {}, requests = [], employee = {}, predicate = () => true) {
  return requests
    .filter((request) => toolRequestMatchesRow(request, row, employee))
    .filter(predicate)
    .sort((left, right) => String(right.updatedAt || right.submittedAt || right.id).localeCompare(String(left.updatedAt || left.submittedAt || left.id)))[0] || null;
}

function isPendingToolRequest(request = {}) {
  return /待|pending|review/i.test(String(request.status || ""));
}

function isObsoleteDefaultEnableRequest(row = {}, request = {}) {
  return row.defaultEnabled && isFeishuConnectorTool(row) && request.action === "enable";
}

function isAppliedToolRequest(request = {}) {
  return request.decision?.decision === "approved" && /已生效|applied/i.test(String(request.status || ""));
}

function effectiveToolEnabled(row = {}, requests = [], employee = {}) {
  const applied = latestToolRequest(row, requests, employee, isAppliedToolRequest);
  if (applied?.action === "enable") return true;
  if (applied?.action === "disable") return false;
  return defaultToolEnabled(row);
}

function operationGroupsForRow(row = {}) {
  return Array.isArray(row.catalogTool?.operationGroups) ? row.catalogTool.operationGroups : [];
}

function defaultAllowedOperations(row = {}) {
  return operationGroupsForRow(row)
    .filter((group) => group.defaultEnabled)
    .flatMap((group) => group.operations || [])
    .map((operation) => operation.id);
}

function effectiveAllowedOperations(row = {}, requests = [], employee = {}) {
  const defaults = defaultAllowedOperations(row);
  const applied = latestToolRequest(row, requests, employee, (request) => isAppliedToolRequest(request) && request.action === "configure");
  if (Array.isArray(applied?.allowedOperations)) return [...new Set([...defaults, ...applied.allowedOperations])];
  const rowIds = new Set(row.toolBindingIds || []);
  const binding = (employee.toolBindings || []).find((item) => rowIds.has(item?.id) || rowIds.has(item?.toolId) || rowIds.has(item?.name));
  return Array.isArray(binding?.allowedOperations) ? [...new Set([...defaults, ...binding.allowedOperations])] : defaults;
}

function toolStatusLabel(row = {}, enabled = defaultToolEnabled(row), pendingRequest = null) {
  if (pendingRequest) return "待审批";
  if (!enabled) return "未启用";
  if (row.defaultEnabled && isFeishuConnectorTool(row)) return "默认开启";
  if (row.statuses.some((status) => /待|规划|草案|pending/i.test(status))) return "需评审";
  if (row.risks.some((risk) => /高|生产|写回/i.test(risk))) return "高门禁";
  return "已允许";
}

function toolStatusTone(label = "") {
  if (label === "已允许" || label === "默认开启") return "good";
  if (label === "高门禁" || label === "需评审" || label === "待审批") return "warn";
  return "muted";
}

function ToolSwitch({ checked }) {
  return (
    <span className={checked ? "channel-setting-switch is-on" : "channel-setting-switch"} aria-hidden="true">
      <i />
    </span>
  );
}

export default function EmployeeToolsPanel({
  employee,
  basicSkills = [],
  businessSkills = [],
  enterpriseTools = [],
  onOpenFeishuApplication = null,
  onToolChange = null,
}) {
  const [toolRequests, setToolRequests] = useState([]);
  const [canManage, setCanManage] = useState(false);
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState("recommended");
  const [reason, setReason] = useState("");
  const [expectedImpact, setExpectedImpact] = useState("");
  const [requestState, setRequestState] = useState({ state: "idle", message: "" });
  const [operationDrafts, setOperationDrafts] = useState({});
  const skillRecords = mountedSkillRecords(employee, basicSkills, businessSkills);
  const declaredToolRows = useMemo(() => employeeToolRows(employee).flatMap((row) => {
    const catalogTool = enterpriseTools.find((tool) => rowMatchesCatalogTool(row, tool)) || null;
    return catalogTool && !toolCanBindToEmployee(catalogTool, employee)
      ? []
      : [{
        ...row,
        name: catalogTool?.displayName || catalogTool?.name || row.name,
        risks: uniqueList([catalogTool?.risk, ...row.risks]),
        reviewGates: uniqueList([catalogTool?.reviewGate, ...row.reviewGates]),
        permissionScopes: uniqueList([catalogTool?.permissionBoundary, ...row.permissionScopes]),
        credentialBoundaries: uniqueList([catalogTool?.credentialBoundary, ...row.credentialBoundaries]),
        writebackBoundaries: uniqueList([catalogTool?.writebackBoundary || catalogTool?.runtimeBoundary, ...row.writebackBoundaries]),
        catalogTool,
      }];
  }), [employee, enterpriseTools]);
  const catalogCandidateRows = useMemo(
    () => enterpriseTools
      .filter((tool) => toolCanBindToEmployee(tool, employee))
      .filter((tool) => !declaredToolRows.some((row) => rowMatchesCatalogTool(row, tool)))
      .map(toolCatalogRow),
    [declaredToolRows, employee, enterpriseTools],
  );
  const allToolRows = [...declaredToolRows, ...catalogCandidateRows];
  const enabledToolRows = allToolRows.filter((row) => effectiveToolEnabled(row, toolRequests, employee));
  const candidateToolRows = allToolRows.filter((row) => !effectiveToolEnabled(row, toolRequests, employee));
  const filteredCandidates = candidateToolRows.filter((row) => {
    if (filter === "recommended" && !isRecommendedTool(row, employee)) return false;
    if (filter === "cli" && !row.kinds.some((kind) => /cli/i.test(kind))) return false;
    if (filter === "connector" && !row.kinds.some((kind) => /connector|连接器/i.test(kind))) return false;
    if (filter === "api" && !row.kinds.some((kind) => /api/i.test(kind))) return false;
    const text = query.trim().toLowerCase();
    return !text || toolRowSearchText(row).includes(text);
  });
  const enabledToolCount = enabledToolRows.length;
  const cliToolCount = enabledToolRows.filter((row) => row.kinds.some((kind) => /cli/i.test(kind))).length;
  const connectorToolCount = enabledToolRows.filter((row) => row.kinds.some((kind) => /connector|连接器/i.test(kind))).length;
  const feishuToolCount = enabledToolRows.filter(isFeishuConnectorTool).length;
  const apiDocCount = employee.apiEndpoints?.length || 0;
  const employeeRequests = toolRequests.filter((request) => request.employeeId === employee.id).slice(0, 4);
  const pendingCount = employeeRequests.filter((request) => isPendingToolRequest(request)).length;

  useEffect(() => {
    let canceled = false;
    refreshToolRequests();
    async function refreshToolRequests() {
      try {
        const data = await fetchToolBindingRequests({ employeeId: employee.id });
        if (!canceled) {
          setToolRequests(data.toolBindingRequests || []);
          setCanManage(Boolean(data.canManage));
          setOperationDrafts(Object.fromEntries(allToolRows
            .filter((row) => operationGroupsForRow(row).length)
            .map((row) => [row.toolBindingIds[0] || row.name, effectiveAllowedOperations(row, data.toolBindingRequests || [], employee)])));
        }
      } catch (error) {
        if (!canceled) setRequestState({ state: "error", message: error?.message || "工具审批记录加载失败" });
      }
    }
    return () => {
      canceled = true;
    };
  }, [employee.id]);

  function currentEnabled(row) {
    return Boolean(effectiveToolEnabled(row, toolRequests, employee));
  }

  function pendingRequestFor(row) {
    return latestToolRequest(row, toolRequests, employee, (request) => isPendingToolRequest(request) && !isObsoleteDefaultEnableRequest(row, request));
  }

  async function refreshRequestsAfterChange() {
    const data = await fetchToolBindingRequests({ employeeId: employee.id });
    setToolRequests(data.toolBindingRequests || []);
    setCanManage(Boolean(data.canManage));
  }

  async function toggleTool(row) {
    const pendingRequest = pendingRequestFor(row);
    if (pendingRequest || requestState.state === "saving") return;
    const action = currentEnabled(row) ? "disable" : "enable";
    setRequestState({ state: "saving", message: action === "enable" ? "正在提交工具开启审批..." : "正在提交工具关闭审批..." });
    try {
      const data = await postToolBindingRequest({
        action,
        employeeId: employee.id,
        toolBindingId: row.toolBindingIds[0] || row.name,
        toolId: row.catalogTool?.id || row.toolBindingIds[0] || row.name,
        toolName: row.name,
        reason: reason.trim() || `${action === "enable" ? "开启" : "关闭"} ${employee.name || employee.id} 的 ${row.name} Tool。`,
        safeSummary: expectedImpact.trim() || `${employee.name || employee.id} 的运行依赖和调用门禁会随该 Tool 变更复核。`,
        permissionBoundary: row.permissionScopes[0] || "随员工权限",
        credentialBoundary: row.credentialBoundaries[0] || "server_only",
        writebackBoundary: row.writebackBoundaries[0] || "按输出契约",
      });
      await refreshRequestsAfterChange();
      setReason("");
      setExpectedImpact("");
      setRequestState({
        state: "saved",
        message: data.status === "applied"
          ? data.toolBindingRequest?.requestMode === "admin_override"
            ? "管理员工具治理决定已生效，并已保留审计记录。"
            : "工具绑定已按企业默认规则生效。"
          : "工具开关申请已提交，等待企业工具管理审批。",
      });
      if (data.status === "applied") await onToolChange?.();
    } catch (error) {
      setRequestState({ state: "error", message: error?.message || "工具开关申请提交失败" });
    }
  }

  function toggleOperationGroup(row, group) {
    const key = row.toolBindingIds[0] || row.name;
    const operationIds = (group.operations || []).map((operation) => operation.id);
    setOperationDrafts((current) => {
      const selected = new Set(current[key] || effectiveAllowedOperations(row, toolRequests, employee));
      const enabled = operationIds.every((operationId) => selected.has(operationId));
      operationIds.forEach((operationId) => enabled ? selected.delete(operationId) : selected.add(operationId));
      return { ...current, [key]: [...selected] };
    });
  }

  async function saveOperationPolicy(row) {
    const key = row.toolBindingIds[0] || row.name;
    const allowedOperations = operationDrafts[key] || effectiveAllowedOperations(row, toolRequests, employee);
    setRequestState({ state: "saving", message: "正在保存操作权限..." });
    try {
      const data = await postToolBindingRequest({
        action: "configure",
        allowedOperations,
        employeeId: employee.id,
        toolBindingId: key,
        toolId: row.catalogTool?.id || key,
        toolName: row.name,
        reason: reason.trim() || `配置 ${employee.name || employee.id} 的 ${row.name} operation allowlist。`,
        safeSummary: expectedImpact.trim() || "只开放管理员明确选择的 API operation；目标平台 RBAC 继续负责业务权限判定。",
        permissionBoundary: `仅允许 operation allowlist 中的 ${allowedOperations.length} 项操作；业务权限由当前用户的目标平台 RBAC 判定。`,
        credentialBoundary: row.credentialBoundaries[0] || "current-user credential",
        writebackBoundary: allowedOperations.length
          ? `仅允许当前受管合同中已选择的 ${allowedOperations.length} 个写 operation；未登记 operation 禁止执行。`
          : "未开放写 operation；合同中的安全 HTTP method 仍按只读策略执行。",
      });
      await refreshRequestsAfterChange();
      setRequestState({ state: "saved", message: data.status === "applied" ? "操作权限已生效。" : "操作权限申请已提交审批。" });
      if (data.status === "applied") await onToolChange?.();
    } catch (error) {
      setRequestState({ state: "error", message: error?.message || "操作权限保存失败" });
    }
  }

  return (
    <div className="employee-config-tab-panel">
      <section className="employee-cockpit-section">
        <div className="employee-config-section-head">
          <Code2 size={16} />
          <span>
            <strong>工具</strong>
            <small>Tool 治理管理员开启和配置可直接生效；关闭及其他申请进入审批，所有变更均保留审计记录。</small>
          </span>
        </div>
        <DetailGrid
          items={[
            ["已确认工具", `${enabledToolCount}`],
            ["可添加工具", `${candidateToolRows.length}`],
            ["待审批", `${pendingCount} 条`],
            ["连接器工具", connectorToolCount ? `${connectorToolCount} 个` : "未声明"],
            ["CLI 工具", cliToolCount ? `${cliToolCount} 个` : "未声明"],
            ["挂载 Skill", `${skillRecords.length} 个，仅作能力依赖`],
            ["员工级工具", employee.tools?.length || employee.toolBindings?.length ? `${(employee.tools?.length || 0) + (employee.toolBindings?.length || 0)} 个` : "未单独声明"],
            ["API 文档", apiDocCount ? `${apiDocCount} 个接口草案，仅作边界说明` : "未声明"],
          ]}
        />
      </section>

      <section className="employee-product-panels">
        <article className="employee-product-panel">
          <div className="employee-product-panel-title">
            <Layers3 size={16} />
            <strong>Skill 与 Tool 边界</strong>
          </div>
          <ul>
            <li>Skill 表示可复用能力、Prompt 元数据、输入输出和审核门禁。</li>
            <li>Tool 表示执行手段、连接器、CLI、解析器、队列或受控 API。</li>
            <li>CLI 类命令行能力必须先确认来源和边界，确认后归入 Tool，不归入 Channel。</li>
          </ul>
        </article>
        <article className="employee-product-panel">
          <div className="employee-product-panel-title">
            <ShieldCheck size={16} />
            <strong>权限边界</strong>
          </div>
          <ul>
            <li>工具绑定决定不代表后端凭证、连接测试或调用门禁已通过。</li>
            <li>生产写回、远程执行、客户承诺或代码发布必须进入人工门禁。</li>
            <li>Provider key、token、raw prompt、执行 payload 和客户数据不得进入前端。</li>
          </ul>
        </article>
        <article className="employee-product-panel employee-tool-plugin-panel">
          <div className="employee-product-panel-title">
            <RadioTower size={16} />
            <strong>lark-cli 接入</strong>
          </div>
          <ul>
            <li>lark-cli 归入企业默认 Tool/Connector，每个数字员工默认展示为已开启。</li>
            <li>默认开启不代表飞书 App 凭证、Scope、白名单、写回或真实消息回环已通过。</li>
            <li>Channel 只负责入口范围、群白名单、单聊/群聊和回复策略。</li>
          </ul>
          <button
            className="ghost-action employee-tool-plugin-action"
            type="button"
            onClick={onOpenFeishuApplication || undefined}
            disabled={!onOpenFeishuApplication}
            title={feishuToolCount ? "打开飞书申请与联通资料" : "当前数字员工未声明 lark-cli 或飞书连接器工具"}
          >
            <RadioTower size={15} />
            打开飞书联通
          </button>
        </article>
      </section>

      {enabledToolRows.length ? (
        <section className="employee-cockpit-section">
          <div className="employee-config-section-head">
            <KeyRound size={16} />
            <span>
              <strong>已声明工具</strong>
            <small>展示员工显式声明和企业默认 Tool；管理员开启可直接生效，关闭仍提交后端审批</small>
          </span>
        </div>
          <div className="employee-tool-list" role="table" aria-label={`${employee.name || "数字员工"} 工具清单`}>
            <div className="employee-tool-row employee-tool-row-head" role="row">
              <span role="columnheader">工具</span>
              <span role="columnheader">来源</span>
              <span role="columnheader">权限边界</span>
              <span role="columnheader">凭证 / 写回</span>
              <span role="columnheader">审核</span>
              <span role="columnheader">开关 / 接入</span>
            </div>
            {enabledToolRows.map((row) => {
              const pendingRequest = pendingRequestFor(row);
              const enabled = currentEnabled(row);
              const switchChecked = pendingRequest ? pendingRequest.action === "enable" : enabled;
              return (
              <article className="employee-tool-row" key={row.name} role="row">
                <div className="employee-tool-cell employee-tool-name-cell" role="cell">
                  <div className="employee-tool-name">
                    <Code2 size={15} />
                    <strong>{row.name}</strong>
                    <span className={`status-pill ${toolStatusTone(toolStatusLabel(row, enabled, pendingRequest))}`}>{toolStatusLabel(row, enabled, pendingRequest)}</span>
                  </div>
                  <small>{pendingRequest ? `申请 ${pendingRequest.id}` : row.defaultEnabled ? `${row.kinds.join(" / ")} · 企业默认` : row.kinds.join(" / ")}</small>
                </div>
                <div className="employee-tool-cell" role="cell">
                  <b>来源</b>
                  <span>{row.sources.join(" / ")}</span>
                  <small>{row.sourceKinds.join(" / ")}</small>
                </div>
                <div className="employee-tool-cell" role="cell">
                  <b>权限</b>
                  <span>{row.permissionScopes[0] || "随员工权限"}</span>
                  <small>风险：{row.risks.join(" / ") || "标准"}</small>
                </div>
                <div className="employee-tool-cell" role="cell">
                  <b>凭证</b>
                  <span>{row.credentialBoundaries[0] || "server_only"}</span>
                  <small>{row.writebackBoundaries[0] || "按输出契约"}</small>
                </div>
                <div className="employee-tool-cell" role="cell">
                  <b>审核</b>
                  <span>{row.reviewGates[0] || "负责人确认工具边界"}</span>
                </div>
                <div className="employee-tool-cell employee-tool-action-cell" role="cell">
                  {isFeishuConnectorTool(row) && onOpenFeishuApplication ? (
                    <button className="tool-open-connector-action" type="button" onClick={onOpenFeishuApplication}>
                      <RadioTower size={14} />
                      打开联通
                    </button>
                  ) : null}
                  <button
                    className={switchChecked ? "tool-enable-toggle is-on" : "tool-enable-toggle"}
                    type="button"
                    role="switch"
                    aria-checked={switchChecked}
                    onClick={() => toggleTool(row)}
                    disabled={Boolean(pendingRequest) || requestState.state === "saving"}
                    title={pendingRequest
                      ? "该工具开关申请正在等待企业工具管理审批"
                      : enabled
                        ? "关闭 Tool 仍需提交后端审批"
                        : canManage
                          ? "Tool 治理管理员开启后直接生效，并保留审计记录"
                          : "提交后端工具开启审批；审批通过后才生效"}
                  >
                    <ToolSwitch checked={switchChecked} />
                    <span>{pendingRequest ? "待审批" : enabled ? "允许" : "关闭"}</span>
                  </button>
                </div>
              </article>
              );
            })}
          </div>
        </section>
      ) : (
        <section className="employee-cockpit-section">
          <div className="employee-config-section-head">
            <KeyRound size={16} />
            <span>
              <strong>暂无工具声明</strong>
              <small>请先确认真实可调用 Tool，再写入员工工具绑定或声明。</small>
            </span>
          </div>
          <SkillChips title="接入字段" items={["employee.toolBindings", "employee.tools", "tool.kind=connector", "invocation policy"]} compact />
        </section>
      )}


      {enabledToolRows.filter(row => row.catalogTool?.capabilityPolicies?.length).map(row => (
        <RegisteredToolPolicyPanel key={`${employee.id}:${row.catalogTool.id}:${row.catalogTool.contractDigest}`}
          tool={row.catalogTool} employee={employee} canManage={canManage} onChanged={async () => { await refreshRequestsAfterChange(); await onToolChange?.(); }} />
      ))}

      {enabledToolRows.filter((row) => operationGroupsForRow(row).length).map((row) => {
        const key = row.toolBindingIds[0] || row.name;
        const selected = new Set(operationDrafts[key] || effectiveAllowedOperations(row, toolRequests, employee));
        const saved = new Set(effectiveAllowedOperations(row, toolRequests, employee));
        const dirty = [...new Set([...selected, ...saved])].some((operationId) => selected.has(operationId) !== saved.has(operationId));
        return (
          <section className="employee-cockpit-section employee-tool-operation-policy" key={`${key}-operations`}>
            <div className="employee-config-section-head">
              <ShieldCheck size={16} />
              <span>
                <strong>{row.name} 操作权限</strong>
                <small>默认只读；Tool 治理管理员按 operation 配置可用范围，DataFlow RBAC 与本次用户指令仍独立校验。</small>
              </span>
            </div>
            <div className="employee-tool-operation-list">
              {operationGroupsForRow(row).map((group) => {
                const operationIds = (group.operations || []).map((operation) => operation.id);
                const checked = operationIds.every((operationId) => selected.has(operationId));
                return (
                  <button
                    className={checked ? "employee-tool-operation-row is-on" : "employee-tool-operation-row"}
                    key={group.id}
                    type="button"
                    role="switch"
                    aria-checked={checked}
                    onClick={() => toggleOperationGroup(row, group)}
                    disabled={group.defaultEnabled || !canManage || requestState.state === "saving"}
                    title={group.defaultEnabled ? "默认查询基线不可关闭" : "切换该 operation 组"}
                  >
                    <span>
                      <strong>{group.label}</strong>
                      <small>{(group.operations || []).map((operation) => operation.label).join(" / ")}</small>
                    </span>
                    <span className={`status-pill ${group.defaultEnabled ? "good" : "warn"}`}>{group.risk}</span>
                    <ToolSwitch checked={checked} />
                  </button>
                );
              })}
            </div>
            <div className="employee-tool-operation-actions">
              <small>{canManage ? "保存后进入员工运行时 allowlist 并保留审计记录；写操作仍需本次明确指令。" : "需要 Tool 治理管理员权限。"}</small>
              <button className="ghost-action" type="button" disabled={!canManage || !dirty || requestState.state === "saving"} onClick={() => saveOperationPolicy(row)}>
                <ShieldCheck size={15} />
                保存操作权限
              </button>
            </div>
          </section>
        );
      })}

      <section className="employee-cockpit-section employee-tool-catalog-panel">
        <div className="employee-skill-block-title">
          <strong>开启新工具</strong>
          <small>{canManage ? "从企业 Tool 目录选择；管理员开启后直接生效并保留审计记录" : "从企业 Tool 目录选择；每次只提交当前 Tool 的绑定审批"}</small>
        </div>
        <div className="employee-skill-toolbar">
          <label className="employee-skill-search">
            <Search size={15} />
            <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索 Tool、类型、Owner 或能力范围" />
          </label>
          <div className="employee-skill-filter" role="group" aria-label="Tool 筛选">
            {toolFilterOptions.map((item) => (
              <button
                key={item.id}
                className={filter === item.id ? "is-active" : ""}
                type="button"
                aria-pressed={filter === item.id}
                onClick={() => setFilter(item.id)}
              >
                {item.label}
              </button>
            ))}
          </div>
        </div>

        <div className="employee-skill-candidates employee-tool-candidates">
          {filteredCandidates.length ? filteredCandidates.map((row) => {
            const pendingRequest = pendingRequestFor(row);
            const recommended = isRecommendedTool(row, employee);
            return (
              <article className={pendingRequest ? "employee-skill-candidate is-pending" : "employee-skill-candidate"} key={row.toolBindingIds[0] || row.name}>
                <span className="employee-skill-candidate-copy">
                  <span className="employee-skill-candidate-title">
                    <strong>{row.name}</strong>
                    {pendingRequest ? <em>待审批</em> : recommended ? <em>推荐</em> : null}
                  </span>
                  <span className="employee-skill-meta">
                    <span>{row.kinds.join(" / ")}</span>
                    <span>{row.catalogTool?.vendor || row.sources[0] || "企业工具目录"}</span>
                    <span className={`status-pill ${toolStatusTone(row.statuses[0])}`}>{row.statuses[0] || "待评审"}</span>
                    <span className="employee-skill-risk is-warn">{row.risks[0] || "待评估"}风险</span>
                  </span>
                  <p className="employee-skill-summary">{toolSummary(row)}</p>
                </span>
                <button
                  className="tool-enable-toggle employee-skill-switch-action"
                  type="button"
                  role="switch"
                  aria-checked="false"
                  aria-label={`${pendingRequest ? "等待开启" : "开启"} ${row.name}`}
                  disabled={requestState.state === "saving" || Boolean(pendingRequest)}
                  onClick={() => toggleTool(row)}
                  title={pendingRequest
                    ? "工具绑定申请已提交，等待企业工具管理审批"
                    : canManage
                      ? "管理员开启后直接生效，并保留审计记录"
                      : "提交当前 Tool 的绑定审批"}
                >
                  <ToolSwitch checked={false} />
                  <span>{pendingRequest ? "待开启" : canManage ? "管理员开启" : "申请开启"}</span>
                </button>
              </article>
            );
          }) : (
            <p className="model-binding-note">没有匹配的可添加 Tool，换个搜索词或切到“全部”。</p>
          )}
        </div>

        <div className="employee-skill-mount-form">
          <label>
            变更说明
            <input value={reason} onChange={(event) => setReason(event.target.value)} placeholder="可选：会随下一次开启或关闭提交" />
          </label>
          <label>
            影响说明
            <input value={expectedImpact} onChange={(event) => setExpectedImpact(event.target.value)} placeholder="可选：权限、凭证、写回或观察范围" />
          </label>
          <span className="employee-skill-inline-hint">
            <Link2 size={16} />
            Tool 绑定不等于真实联通
          </span>
        </div>
      </section>

      {employeeRequests.length ? (
        <section className="employee-skill-request-strip">
          <div className="employee-skill-block-title">
            <strong>最近变更</strong>
            <small>管理员开启/配置可直接生效；其他申请审批通过后进入有效 Tool 绑定</small>
          </div>
          {employeeRequests.map((request) => (
            <div className="employee-skill-request" key={request.id}>
              <span className={`status-pill ${toolStatusTone(request.status)}`}>{request.status}</span>
              <b>{request.actionLabel} / {request.toolName}</b>
              <small>{request.toolActionId || request.id}</small>
            </div>
          ))}
          <SkillChips title="独立门禁" items={["Credential", "Scope", "写回", "真实联通"]} compact />
        </section>
      ) : null}

      <p className={`model-binding-note ${requestState.state === "error" ? "is-error" : ""}`} aria-live="polite">
        {requestState.message || (canManage
          ? "管理员开启/配置会直接生效并留痕；关闭仍需审批，任何决定都不会自动放开凭证或写回。"
          : "开启和关闭都会提交企业工具审批；批准后才更新员工的有效 Tool 绑定。")}
      </p>

    </div>
  );
}
