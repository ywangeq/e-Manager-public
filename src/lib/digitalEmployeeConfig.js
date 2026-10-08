import { aiModelCatalog, aiModelLevels, permissionScopeLabels } from "../data/catalog.js";
import { desktopChannelAvailable, feishuApplicationEnabled } from "./digitalEmployeeOverview.js";

export { aiModelCatalog, aiModelLevels };

export const modelCatalogById = new Map(aiModelCatalog.map((model) => [model.id, model]));
export const modelLevelById = new Map(aiModelLevels.map((level) => [level.id, level]));
export const digitalEmployeeModelCatalog = aiModelCatalog
  .filter((model) => Number.isInteger(model.digitalEmployeeMenuOrder))
  .sort((left, right) => left.digitalEmployeeMenuOrder - right.digitalEmployeeMenuOrder);

export function skillNameById(id, source) {
  return source.find((item) => item.id === id)?.name || id;
}

export function apiDocSummary(items = []) {
  return items.length ? [`${items.length} 个接口草案见 docs/api.md`] : [];
}

export function readableBoolean(value, trueLabel = "是", falseLabel = "否") {
  if (value === true) return trueLabel;
  if (value === false) return falseLabel;
  return "";
}

export function employeePermissionLabel(employee = {}) {
  return permissionScopeLabels[employee.permissionScope] || employee.permissionScope || "未配置范围";
}

export function employeeStatusDetail(status = "") {
  if (status === "在线") return "授权范围内可用";
  if (status === "试运行") return "限定场景试运行";
  if (status === "待人员审批") return "审批通过后可试运行";
  if (status === "规划中") return "配置规划中";
  return "按治理状态控制";
}

export function openBadcaseCount(employee = {}, badcases = []) {
  const explicitCount = Number(employee.quality?.openBadcases);
  const openCases = badcases.filter((item) => !["已关闭", "closed"].includes(item.status)).length;
  return Math.max(Number.isFinite(explicitCount) ? explicitCount : 0, openCases);
}

export function employeeQualityState(employee = {}, badcases = []) {
  const count = openBadcaseCount(employee, badcases);
  if (employee.status === "待人员审批") {
    return {
      label: "待审批",
      detail: employee.quality?.rootCauseFocus || "人员与权限边界待确认",
      tone: "warn",
    };
  }
  if (count > 0) {
    return {
      label: `${count} 个待闭环`,
      detail: employee.quality?.rootCauseFocus || "查看 badcase 和归因记录",
      tone: "warn",
    };
  }
  if (employee.status === "规划中") {
    return {
      label: "待配置",
      detail: employee.quality?.rootCauseFocus || "上线前补齐质量门禁",
      tone: "muted",
    };
  }
  return {
    label: "质量正常",
    detail: employee.quality?.rootCauseFocus || "暂无未关闭 badcase",
    tone: "good",
  };
}

export function previewItems(items = [], limit = 3) {
  return items.filter(Boolean).slice(0, limit);
}

export function supportedLevelsForModel(modelId) {
  const model = modelCatalogById.get(modelId) || aiModelCatalog[0];
  const supportedLevelIds = model?.supportedLevelIds?.length ? model.supportedLevelIds : aiModelLevels.map((level) => level.id);
  return aiModelLevels.filter((level) => level.id !== "none" && supportedLevelIds.includes(level.id));
}

export function normalizeModelBinding(binding = {}) {
  const {
    apiProtocol: _legacyApiProtocol,
    authMode: _legacyAuthMode,
    compat: _legacyCompat,
    upstreamDialect: _legacyUpstreamDialect,
    ...safeBinding
  } = binding;
  const model =
    modelCatalogById.get(binding.modelId) ||
    aiModelCatalog.find((catalogModel) => catalogModel.model === binding.model) ||
    {};
  const levelId = binding.modelLevelId || model.defaultLevelId || aiModelLevels[0]?.id;
  const level = modelLevelById.get(levelId) || aiModelLevels[0] || {};

  return {
    ...safeBinding,
    modelId: model.id,
    provider: model.provider,
    providerName: model.providerName,
    providerRouteId: binding.providerRouteId || model.providerRouteId || "",
    requiredCapabilityProfileVersion: binding.requiredCapabilityProfileVersion || model.requiredCapabilityProfileVersion || "",
    model: model.model,
    modelStatus: model.status,
    modelUsage: model.usage,
    modelLevelId: level.id,
    modelLevelLabel: level.label,
    modelLevelDescription: level.description,
  };
}

export function modelBindingSummary(binding) {
  const normalized = normalizeModelBinding(binding);
  if (!normalized.model) return "未绑定模型";
  return `${normalized.model} · ${normalized.modelLevelLabel || "未分级"}`;
}

export function normalizeTaskModelBindings(employee = {}) {
  const source = employee.taskModelBindings;
  const items = Array.isArray(source)
    ? source
    : source && typeof source === "object"
      ? Object.entries(source).map(([taskId, binding]) => ({ taskId, ...(binding || {}) }))
      : [];
  return items.map((binding) => ({
    ...normalizeModelBinding(binding),
    taskId: String(binding.taskId || "").trim(),
    taskType: String(binding.taskType || "task").trim(),
  })).filter((binding) => binding.taskId);
}

export function effectiveModelBindingForTask(employee = {}, taskId = "") {
  const normalizedTaskId = String(taskId || "").trim();
  const override = normalizeTaskModelBindings(employee).find((binding) => binding.taskId === normalizedTaskId);
  return override || normalizeModelBinding(employee.modelBinding || {});
}

export function taskModelBindingSummaries(employee = {}) {
  const items = Array.isArray(employee.modelAssignments?.items) ? employee.modelAssignments.items : [];
  return items.flatMap((assignment) => (
    Array.isArray(assignment.roles?.taskDefinitionIds)
      ? assignment.roles.taskDefinitionIds.map((taskId) => `${taskId}：${modelBindingSummary(assignment)}`)
      : []
  ));
}

export function normalizePromptGovernance(employee = {}, draft = null) {
  const governance = employee.promptGovernance || {};
  const merged = {
    promptVersion: employee.promptVersion || "",
    promptScope: employee.promptScope || (employee.id ? `employee:${employee.id}` : "global_config"),
    promptHash: governance.promptHash || "",
    promptKeys: governance.promptKeys || [],
    promptChangeSummary: governance.promptChangeSummary || "",
    promptReviewGate: governance.promptReviewGate || "负责人确认 Prompt 元数据、约束和人审门禁；不保存 raw prompt。",
    rawPromptStored: governance.rawPromptStored === true,
    source: governance.source || "digital-employee-prompt-config",
    ...(draft || {}),
  };
  return {
    ...merged,
    promptKeys: normalizePromptKeys(merged.promptKeys),
  };
}

export function normalizePromptKeys(value) {
  const list = Array.isArray(value) ? value : String(value || "").split(/[\n,，、]+/);
  return list.map((item) => String(item || "").trim()).filter(Boolean);
}

export function promptKeysText(value) {
  return normalizePromptKeys(value).join(", ");
}

export function employeeWithFeishuApplication(employee = {}, enabled = feishuApplicationEnabled(employee)) {
  const channels = Array.isArray(employee.channels) ? employee.channels : [];
  const nextChannels = channels.filter((channel) => !/飞书|IM|Slack|Telegram|WebChat|消息/i.test(String(channel || "")));
  return {
    ...employee,
    feishuApplicationEnabled: enabled,
    feishuAccessEnabled: enabled,
    channels: nextChannels,
    channelConfig: {
      ...(employee.channelConfig || {}),
      feishu: {
        ...(employee.channelConfig?.feishu || {}),
        applicationEnabled: enabled,
        accessEnabled: enabled,
      },
    },
  };
}

export function employeeWithDesktopAvailability(employee = {}, enabled = desktopChannelAvailable(employee)) {
  return {
    ...employee,
    desktopAvailable: enabled,
    channelConfig: {
      ...(employee.channelConfig || {}),
      desktop: {
        ...(employee.channelConfig?.desktop || {}),
        enabled,
      },
    },
  };
}
