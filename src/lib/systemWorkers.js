import { aiModelCatalog, aiModelLevels, aiProviderRoutes, preReviewWorkers } from "../data/catalog";
import { departmentNameById } from "./consoleCatalog";

const providerLabels = {
  codex: "Codex",
  minimax: "MiniMax",
  smoreai: "公司内部模型",
};

const providerRouteById = new Map(aiProviderRoutes.map((route) => [route.id, route]));

export const workerStatusOptions = ["在线", "试运行", "设计中", "规划接入", "停用"];

export const triggerModeOptions = [
  "事件触发",
  "事件触发 + 定时补扫",
  "事件触发 + 每小时补扫",
  "上游材料到达后异步触发",
  "手动触发",
  "暂停触发",
];

export const schedulePresets = [
  { value: "event-driven", label: "事件触发" },
  { value: "*/15 * * * *", label: "每 15 分钟" },
  { value: "*/30 * * * *", label: "每 30 分钟" },
  { value: "0 * * * *", label: "每小时" },
  { value: "0 */6 * * *", label: "每 6 小时" },
  { value: "manual", label: "手动触发" },
  { value: "custom", label: "自定义 Cron" },
];

export const maxParallelWorkersLimit = 32;
export const maxWorkersPerEmployeeLimit = 16;
export const batchSizeOptions = [1, 3, 5, 10, 20];
export const taskBufferQueueOptions = [0, 1, 2, 3, 5, 8, 10, 20, 30, 50, 100];
export const queueWaitNoticeMinuteOptions = [5, 10, 15, 30, 60, 120, 240, 360, 720];
export const taskTimeoutMinuteOptions = [5, 10, 15, 30, 60, 120, 240];

export const fallbackRequestTypes = ["Skill 更新", "基础技能分发", "需求候选", "外部员工", "Repo Skill 草案"];
export const workerRequestTypeOptions = Array.from(new Set([
  ...fallbackRequestTypes,
  ...preReviewWorkers.flatMap((worker) => worker.assignedRequestTypes || []),
]));

export const workerPoolModeOptions = [
  { value: "shared_worker_pool", label: "共享 Worker Pool" },
  { value: "dedicated_reserved_worker", label: "专属保留 Worker" },
  { value: "runtime_allocated", label: "服务端运行时分配" },
];

export function providerLabel(provider) {
  return providerLabels[provider] || provider;
}

export function providerRouteLabel(providerRoute) {
  if (!providerRoute) return "";
  return `${providerLabel(providerRoute.provider)} / ${providerRoute.name}`;
}

export function routingLabel(worker) {
  const routingTarget = providerRouteById.get(worker.preferredProviderRouteId);
  return routingTarget ? providerRouteLabel(routingTarget) : "无，按服务端可用性分配";
}

export function workerPoolLabel(worker) {
  if (worker.workerPoolMode === "dedicated_reserved_worker") return "专属保留 Worker";
  if (worker.workerPoolMode === "shared_worker_pool") return "共享 Worker Pool";
  return "服务端运行时分配";
}

export function workerQuotaLabel(worker) {
  return worker.consumesSharedWorkerQuota === false ? "不占共享额度" : "占用共享额度";
}

export function maxWorkersPerEmployee(worker) {
  const value = Number(worker.maxWorkersPerEmployee);
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : 1;
}

export function positiveWorkerNumber(value, fallback, minimum = 1) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(minimum, Math.floor(number));
}

export function resourcePayloadFromDraft(draft) {
  return {
    maxWorkersPerEmployee: positiveWorkerNumber(draft.maxWorkersPerEmployee, 1),
    maxParallelWorkers: positiveWorkerNumber(draft.maxParallelWorkers, 1),
    batchSize: positiveWorkerNumber(draft.batchSize, 1),
    taskBufferQueueSize: positiveWorkerNumber(draft.taskBufferQueueSize, 0, 0),
    taskBufferMinutes: positiveWorkerNumber(draft.taskBufferMinutes, 240),
    taskExecutionTimeoutMinutes: positiveWorkerNumber(draft.taskExecutionTimeoutMinutes, 60),
  };
}

export function copyWorker(worker) {
  return {
    ...worker,
    assignedRequestTypes: [...(worker.assignedRequestTypes || [])],
    departmentScope: [...(worker.departmentScope || [])],
  };
}

export function schedulePresetValue(schedule) {
  if (!schedule) return "custom";
  return schedulePresets.some((preset) => preset.value === schedule) ? schedule : "custom";
}

export function modelOptionsForProvider(provider) {
  return aiModelCatalog.filter((model) => model.provider === provider);
}

export function levelOptionsForModel(modelName) {
  const model = aiModelCatalog.find((item) => item.model === modelName);
  if (!model) return aiModelLevels;
  return aiModelLevels.filter((level) => model.supportedLevelIds.includes(level.id));
}

export function credentialPolicyOptions(provider) {
  const label = providerLabel(provider);
  return [
    `按需从 ${label} 供应商 Key 获取服务端租约；未配置固定 Worker 或固定 Key。`,
    `按需从 ${label} 供应商 Key 获取服务端租约；仅高风险阻断任务可固定后端路由偏好。`,
    `按需从 ${label} 供应商 Key 获取服务端租约；长文档任务可配置后端路由偏好。`,
    "暂停运行；等待后端调度、凭证或模型配置完成后再启用。",
  ];
}

export function toggleListValue(list, value) {
  return list.includes(value) ? list.filter((item) => item !== value) : [...list, value];
}

export function limitedOptions(options, limit, current) {
  const safeLimit = Number.isFinite(Number(limit)) ? Math.floor(Number(limit)) : Number.POSITIVE_INFINITY;
  return Array.from(new Set([...options.filter((value) => value <= safeLimit), current]))
    .filter((value) => Number.isFinite(Number(value)) && value <= safeLimit)
    .sort((left, right) => left - right);
}

export function formatUpdatedAt(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "刚刚";
  return date.toLocaleString("zh-CN", { hour12: false, hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

export async function fetchSystemWorkers() {
  const response = await fetch("/api/system-workers", { credentials: "include" });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || !data.ok) throw new Error(data.message || data.error || "全局 Worker 配置读取失败");
  return data;
}

export async function updateSystemWorkerConfig(workerId, payload) {
  const response = await fetch(`/api/system-workers/${encodeURIComponent(workerId)}`, {
    method: "PUT",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || !data.ok) throw new Error(data.message || data.error || "全局 Worker 配置保存失败");
  return data;
}

export async function decideRuntimeConfigRevision(revisionId, decision, baseAppliedVersion) {
  const response = await fetch(`/api/digital-employee-runtime-config-revisions/${encodeURIComponent(revisionId)}/decision`, {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ decision, baseAppliedVersion }),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || !data.ok) throw new Error(data.message || data.error || "运行配置审核失败");
  return data;
}
