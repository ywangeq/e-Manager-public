function uniqueList(items = []) {
  return [...new Set(items.map((item) => String(item || "").trim()).filter(Boolean))];
}

export const DEFAULT_FEISHU_TOOL_ID = "lark-cli-openapi";
export const DEFAULT_FEISHU_TOOL_DISPLAY_NAME = "飞书官方 CLI / OpenAPI 连接器";
export const DEFAULT_FEISHU_TOOL_LEGACY_IDS = Object.freeze(["feishu-plugin-connector"]);

const DEFAULT_FEISHU_TOOL_IDENTITIES = new Set([
  DEFAULT_FEISHU_TOOL_ID,
  ...DEFAULT_FEISHU_TOOL_LEGACY_IDS,
  "lark-cli 飞书 OpenAPI CLI",
  "lark-cli 飞书 OpenAPI CLI / 连接器",
  DEFAULT_FEISHU_TOOL_DISPLAY_NAME,
].map(normalizeToolIdentity));

export function isDefaultFeishuToolIdentity(value = "") {
  return DEFAULT_FEISHU_TOOL_IDENTITIES.has(normalizeToolIdentity(value));
}

export function canonicalEnterpriseToolId(value = "") {
  const identity = String(value || "").trim();
  return isDefaultFeishuToolIdentity(identity) ? DEFAULT_FEISHU_TOOL_ID : identity;
}

export function employeeToolIdentity(tool = {}, fallbackId = "") {
  const name = String(tool?.name || tool?.label || tool?.id || fallbackId || "").trim();
  const sourceIds = uniqueList([tool?.toolId, tool?.id, fallbackId]);
  const isDefaultFeishu = [...sourceIds, name].some(isDefaultFeishuToolIdentity);
  const id = isDefaultFeishu
    ? DEFAULT_FEISHU_TOOL_ID
    : String(tool?.toolId || tool?.id || fallbackId || name).trim();
  return {
    id,
    key: normalizeToolIdentity(id),
    name: isDefaultFeishu ? DEFAULT_FEISHU_TOOL_DISPLAY_NAME : name,
    toolBindingIds: uniqueList([
      ...sourceIds,
      ...(isDefaultFeishu ? [DEFAULT_FEISHU_TOOL_ID] : []),
    ]),
  };
}

export function safeToolText(tool = {}) {
  return [
    tool.id,
    tool.name,
    tool.displayName,
    tool.vendor,
    tool.toolType,
    tool.source,
    tool.status,
    tool.risk,
    tool.owner,
    tool.ownerDepartmentId,
    tool.credentialBoundary,
    tool.permissionBoundary,
    tool.runtimeBoundary,
    tool.reviewGate,
    ...(tool.identityModes || []),
    ...(tool.commandHints || []),
    ...(tool.scopeGroups || []),
    tool.defaultEmployeeBindingPolicy,
    tool.defaultEmployeeBindingLabel,
    ...(tool.boundEmployeeIds || []),
    ...(tool.boundSkillIds || []),
    ...(tool.channelBindings || []),
    ...(tool.tags || []),
  ]
    .join(" ")
    .toLowerCase();
}

export function toolStatusLabel(status = "") {
  if (status === "待联通") return "待联通";
  if (status === "治理草案") return "治理草案";
  if (status === "受限") return "受限";
  return status || "待登记";
}

export function riskTone(risk = "") {
  if (/高|生产|写回/i.test(risk)) return "warn";
  if (/低|标准/i.test(risk)) return "good";
  return "muted";
}

export function toolKindOptions(tools = []) {
  return uniqueList(tools.map((tool) => tool.toolType)).sort();
}

export function toolOwnerOptions(tools = []) {
  return uniqueList(tools.map((tool) => tool.ownerDepartmentId)).sort();
}

export function toolCanBindToEmployee(tool = {}, employee = {}) {
  if (tool.defaultEmployeeBindingPolicy !== "explicit_employee_enablement") return true;
  if ((tool.boundEmployeeIds || []).includes(employee.id)) return true;
  const mountedSkillIds = new Set([
    ...(employee.basicSkillIds || []),
    ...(employee.businessSkillIds || []),
  ]);
  return (tool.boundSkillIds || []).some((skillId) => mountedSkillIds.has(skillId));
}

export function isPendingToolRequest(request = {}) {
  return /待|pending|review/i.test(String(request.status || ""));
}

export function toolRequestBelongsToTool(request = {}, tool = {}) {
  const toolId = normalizeToolIdentity(canonicalEnterpriseToolId(tool.id));
  const requestToolId = normalizeToolIdentity(canonicalEnterpriseToolId(request.toolId));
  if (requestToolId && toolId) return requestToolId === toolId;

  const requestBindingId = normalizeToolIdentity(canonicalEnterpriseToolId(request.toolBindingId));
  if (requestBindingId && toolId && requestBindingId === toolId) return true;

  const requestName = normalizeToolIdentity(canonicalEnterpriseToolId(request.toolName));
  const toolNames = [tool.name, tool.displayName]
    .map(canonicalEnterpriseToolId)
    .map(normalizeToolIdentity)
    .filter(Boolean);
  return Boolean(requestName && toolNames.includes(requestName));
}

function normalizeToolText(value = "") {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fa5]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function normalizeToolIdentity(value = "") {
  return normalizeToolText(value);
}
