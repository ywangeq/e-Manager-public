import { businessSkills as catalogBusinessSkills } from "../data/catalog.js";

export const levelOptions = [
  { id: "all", label: "全部" },
  { id: "enterprise", label: "企业级" },
  { id: "business", label: "业务级" },
];

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

const FEISHU_CHANNEL_PATTERN = /飞书|Feishu|IM|Slack|Telegram|WebChat|消息/i;
const REAL_FEISHU_CONFIG_PATTERN = /configured|connected|online|enabled|healthy|已接入|已连接|已启用|正常/i;
const REAL_FEISHU_TEST_PATTERN = /ok|pass|passed|sent|fail|failed|error|timeout|connected|healthy|online|通过|发送|失败|异常|已连接|正常/i;
const FEISHU_DRAFT_PATTERN = /draft|dry.?run|pending|申请|待|未配置|not_configured|mvp/i;

export function feishuApplicationEnabled(employee = {}) {
  const config = employee.channelConfig?.feishu || {};
  if (
    employee.feishuApplicationEnabled === false ||
    employee.feishuAccessEnabled === false ||
    config.applicationEnabled === false ||
    config.accessEnabled === false
  ) {
    return false;
  }
  if (
    employee.feishuApplicationEnabled === true ||
    employee.feishuAccessEnabled === true ||
    config.applicationEnabled === true ||
    config.accessEnabled === true
  ) {
    return true;
  }
  return Boolean(config.sourceSystemId);
}

export function desktopChannelAvailable(employee = {}) {
  return employee.desktopAvailable !== false && employee.channelConfig?.desktop?.enabled !== false;
}

export function feishuChannelConfigured(employee = {}) {
  const config = employee.channelConfig?.feishu || {};
  const realConfigStatus = [config.status, config.connectionStatus].some((value) => {
    const status = String(value || "").trim();
    return status && REAL_FEISHU_CONFIG_PATTERN.test(status) && !FEISHU_DRAFT_PATTERN.test(status);
  });
  const realTestEvidence = [
    config.lastRealTestStatus,
    config.lastWebhookTestStatus,
    config.lastConnectionTestStatus,
    config.lastRealTestAt,
    config.lastWebhookTestAt,
    config.lastConnectionTestAt,
    config.connectionCheckedAt,
  ].some((value) => {
    const status = String(value || "").trim();
    return status && REAL_FEISHU_TEST_PATTERN.test(status) && !FEISHU_DRAFT_PATTERN.test(status);
  });
  return Boolean(
    realConfigStatus ||
      realTestEvidence,
  );
}

export function normalizeDigitalEmployeeFilters(filters = {}) {
  return {
    level: levelOptions.some((item) => item.id === filters.level) ? filters.level : "all",
    channel: String(filters.channel || "all"),
  };
}

export function digitalEmployeeLevel(employee = {}) {
  return employee.level === "系统级" ? "enterprise" : "business";
}

export function digitalEmployeeLevelLabel(employee = {}) {
  return digitalEmployeeLevel(employee) === "enterprise" ? "企业级" : "业务级";
}

export function digitalEmployeeRuntimeTier(employee = {}) {
  if (employee.status === "待人员审批") return "受限 / 待审批";
  if (employee.permissionScope === "platformGovernance") return "管理层 / 专属治理";
  if (employee.departmentId === "rd" || employee.ownerDepartmentId === "rd") return "工程 / 沙箱";
  if (employee.permissionScope === "crossDepartment") return "跨部门 / 高门禁";
  return "部门 / 标准";
}

export function employeeChannels(employee = {}) {
  const feishuCanApply = feishuApplicationEnabled(employee);
  const feishuConfigured = feishuChannelConfigured(employee);
  const channels = normalizeList(employee.channels || employee.channelTags || employee.runtimeChannels).filter((channel) => !FEISHU_CHANNEL_PATTERN.test(channel));
  if (feishuCanApply && feishuConfigured) channels.push("飞书");
  if (employee.level === "系统级") channels.push("控制面");
  if (!channels.length) channels.push("管理台");
  return uniqueList(channels);
}

function businessSkillTags(employee = {}, businessSkills = []) {
  const businessSkillById = new Map((businessSkills || catalogBusinessSkills).map((skill) => [skill.id, skill]));
  return (employee.businessSkillIds || [])
    .flatMap((skillId) => {
      const skill = businessSkillById.get(skillId);
      return skill ? [skill.name, skill.domain, skill.capabilityLine, skill.skillCluster] : [skillId];
    })
    .filter(Boolean);
}

function employeeSearchTags(employee = {}, businessSkills = []) {
  return uniqueList([
    employee.department,
    employee.businessDomain,
    employee.capabilityLine,
    employee.skillCluster,
    employee.status,
    employee.permissionScope === "platformGovernance" ? "平台治理" : "",
    employee.permissionScope === "crossDepartment" ? "跨部门" : "",
    digitalEmployeeRuntimeTier(employee),
    employee.modelBinding?.workerLane,
    employee.modelBinding?.runtimeAdapter,
    employee.runtimeBinding?.workerLane,
    employee.runtimeBinding?.runtimeAdapter,
    employee.outputContract,
    employee.promptVersion ? "SOUL 已配置" : "",
    ...businessSkillTags(employee, businessSkills),
    ...(employee.capabilities || []).slice(0, 3),
    ...(employee.sourceTargets || []).slice(0, 4),
  ]);
}

export function digitalEmployeeFacets(employee = {}, businessSkills = catalogBusinessSkills) {
  const channels = employeeChannels(employee);
  return {
    channels,
    tags: employeeSearchTags(employee, businessSkills),
  };
}

export function employeeMatchesDigitalEmployeeFilters(employee = {}, filters = {}, businessSkills = catalogBusinessSkills) {
  const normalizedFilters = normalizeDigitalEmployeeFilters(filters);
  if (normalizedFilters.level !== "all" && digitalEmployeeLevel(employee) !== normalizedFilters.level) return false;

  const facets = digitalEmployeeFacets(employee, businessSkills);
  if (normalizedFilters.channel !== "all" && !facets.channels.includes(normalizedFilters.channel)) return false;
  return true;
}

export function filterDigitalEmployees(employees = [], filters = {}, businessSkills = catalogBusinessSkills) {
  return employees.filter((employee) => employeeMatchesDigitalEmployeeFilters(employee, filters, businessSkills));
}
