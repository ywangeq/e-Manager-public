import {
  DEFAULT_RESOURCE_MONITOR_STATUS,
  DEFAULT_RUNTIME_TASK_STATUS,
  FORBIDDEN_MESSAGE_FIELDS,
  RUNTIME_TASK_CONTRACT_VERSION,
  cleanShortText,
  cleanText,
  hasPlatformGovernance,
  hasUnsafeText,
  sanitizeResourceMonitor,
  sortUpdatedDesc,
} from "../../feishu-integration-support.mjs";
import {
  expireRuntimeQueueTasks,
  runtimeQueuePolicyForEmployee,
  summarizeRuntimeTaskCapacity,
} from "./task-queue-policy.mjs";
import { buildFeishuIntegrationPath } from "./integration-route-registry.mjs";

function createFeishuEmployeeRuntimeRouteHandlers({
  employeeId,
  findEmployee,
  readJsonBody,
  requireSession,
  runtimeInfrastructureStore,
  runtimeTaskService = null,
  sendJson,
  store,
  resourceDefinitions = [],
  resolveResourceSetup = defaultResourceSetup,
} = {}) {
  const targetEmployeeId = requireEmployeeId(employeeId);
  const runtimeResourcesPath = buildFeishuIntegrationPath(targetEmployeeId, "runtime-resources");
  async function handle(req, res, url) {
    if (req.method === "POST" && url.pathname === runtimeResourcesPath) {
      await upsertRuntimeResource(req, res);
      return true;
    }

    return false;
  }

  async function upsertRuntimeResource(req, res) {
    const session = requireSession(req, res);
    if (!session) return undefined;
    if (!hasPlatformGovernance(session)) {
      return sendJson(res, 403, {
        ok: false,
        error: "employee_runtime_resource_governance_required",
        message: "只有平台治理角色才能登记该数字员工的运行资源监控摘要。",
        contractVersion: RUNTIME_TASK_CONTRACT_VERSION,
      });
    }
    const input = await readJsonBody(req, 1024 * 64);
    if (hasUnsafeText([
      input.name,
      input.boundary,
      input.nextGate,
      input.health?.message,
      input.healthMessage,
      input.capacity?.total,
      input.capacity?.available,
    ])) {
      return sendJson(res, 422, {
        ok: false,
        error: "unsafe_employee_runtime_resource_payload",
        contractVersion: RUNTIME_TASK_CONTRACT_VERSION,
        forbiddenFields: FORBIDDEN_MESSAGE_FIELDS,
      });
    }
    const now = new Date().toISOString();
    const savedResource = store.saveResourceMonitor({
      employeeId: targetEmployeeId,
      id: cleanShortText(input.id || input.resourceId),
      name: cleanShortText(input.name),
      kind: cleanShortText(input.kind),
      status: cleanShortText(input.status || DEFAULT_RESOURCE_MONITOR_STATUS),
      boundary: cleanText(input.boundary),
      capacity: input.capacity || {},
      health: input.health || { status: input.healthStatus, message: input.healthMessage, checkedAt: input.checkedAt || now },
      nextGate: cleanText(input.nextGate),
      updatedAt: now,
    });
    return sendJson(res, 200, {
      ok: true,
      status: savedResource.status,
      contractVersion: RUNTIME_TASK_CONTRACT_VERSION,
      resource: savedResource,
      resourceMonitors: employeeResourceMonitors(),
    });
  }

  function buildRuntimeSummary({ employee, session, tasks = employeeRuntimeTasks(null, session), resourceMonitors = employeeResourceMonitors() } = {}) {
    const connection = store.readConnection(targetEmployeeId);
    const queueRefresh = runtimeTaskService
      ? { tasks, expiredTasks: [], policy: runtimeQueuePolicyForEmployee(employee) }
      : expireRuntimeQueueTasks({ store, employee, tasks });
    const runtimeTasks = queueRefresh.tasks;
    const queuePolicy = queueRefresh.policy;
    const queueState = summarizeRuntimeTaskCapacity(runtimeTasks, queuePolicy);
    const employeeReady = employee?.status === "在线" || employee?.status === "试运行";
    const feishuReady = connection.status === "connected";
    const canConfigureResources = hasPlatformGovernance(session);
    const resourceSetup = resolveResourceSetup({ employee, resourceMonitors });
    const resourcesReady = resourceSetup.ready !== false;
    const resourceChecks = resourceDefinitions.map((definition) => {
      const resource = resourceMonitors.find((item) => item.id === definition.id) || definition;
      const ready = resource.status === "ready";
      return {
        id: `runtime_resource:${definition.id}`,
        label: resource.name || definition.name || definition.id,
        status: ready ? "通过" : "待配置",
        detail: ready
          ? resource.health?.message || "运行资源已就绪。"
          : resource.nextGate || "请完成该员工运行资源配置。",
      };
    });
    const readinessChecks = [
      {
        id: "employee_status",
        label: "数字员工状态",
        status: employeeReady ? "已启用" : "未启用",
        detail: employeeReady ? "员工已启用，常规任务自动进入处理队列。" : "请先启用数字员工后再接收任务。",
      },
      {
        id: "feishu_roundtrip",
        label: "飞书真实消息回环",
        status: feishuReady ? "通过" : connection.status || "待联通",
        detail: feishuReady ? "飞书通道已完成真实消息收发。" : connection.nextGate || "等待飞书长连接 worker 和真实消息测试。",
      },
      {
        id: "task_queue",
        label: "员工任务队列",
        status: queueState.availableTaskSlots > 0 ? "已接入" : "队列已满",
        detail: `当前 ${queueState.acceptedTaskCount}/${queueState.totalTaskCapacity} 个任务占用中（${queuePolicy.maxParallelWorkers} worker + ${queuePolicy.taskBufferQueueSize} 排队位）。`,
      },
      ...resourceChecks,
    ];
    const blockingCheck = readinessChecks.find((check) => !["通过", "已启用", "已接入"].includes(check.status));
    const status = !employeeReady
      ? "review_only"
      : feishuReady && resourcesReady
        ? "ready_for_auto_execution"
        : "setup_required";
    return {
      status,
      statusLabel: runtimeSummaryStatusLabel(status),
      employeeId: targetEmployeeId,
      employeeName: employee?.name || "数字员工",
      queueLane: `feishu_${targetEmployeeId}_intake`,
      canCreateTask: true,
      canConfigureResources,
      canCancelTasks: false,
      resourceSetup,
      setupInteraction: resourceSetup.ready ? {
        status: "resource_ready",
        prompt: "运行资源摘要已就绪；收到任务会自动进入处理队列。",
      } : {
        status: "needs_resource_configuration",
        prompt: canConfigureResources
          ? "检测到运行资源未配置，可在员工运行页补齐该员工声明的运行资源。"
          : "检测到运行资源未配置；Agent 会在飞书里提示等待运行资源，请联系管理员补齐。",
      },
      readinessChecks,
      queuePolicy,
      queueSummary: summarizeRuntimeQueue(runtimeTasks, employee),
      nextGate: blockingCheck?.detail || "数字员工已启用，任务进入统一运行队列；Tool 调用在执行时独立授权。",
      privacyBoundary: "查看任务和资源状态；真实文件、远程日志和运行结果保留在执行环境。",
    };
  }

  function summarizeRuntimeQueue(tasks = [], employee = findEmployee()) {
    const counts = tasks.reduce((acc, task) => {
      const status = cleanShortText(task.status || DEFAULT_RUNTIME_TASK_STATUS);
      acc[status] = (acc[status] || 0) + 1;
      return acc;
    }, {});
    const queuePolicy = runtimeQueuePolicyForEmployee(employee);
    const queueState = summarizeRuntimeTaskCapacity(tasks, queuePolicy);
    return {
      total: tasks.length,
      active: queueState.acceptedTaskCount,
      running: queueState.runningTaskCount,
      waiting: queueState.waitingTaskCount,
      capacity: queueState.totalTaskCapacity,
      available: queueState.availableTaskSlots,
      maxParallelWorkers: queuePolicy.maxParallelWorkers,
      taskBufferQueueSize: queuePolicy.taskBufferQueueSize,
      taskBufferMinutes: queuePolicy.taskBufferMinutes,
      byStatus: counts,
      latestUpdatedAt: tasks[0]?.updatedAt || tasks[0]?.submittedAt || "",
    };
  }

  function employeeRuntimeTasks(tasks = null, actor = null) {
    const source = Array.isArray(tasks)
      ? tasks
      : runtimeTaskService?.listTasks?.(targetEmployeeId, { actor, includeAll: true }) ||
        (typeof store?.readRuntimeTasks === "function" ? store.readRuntimeTasks() : []);
    return source.filter((task) => cleanShortText(task.employeeId) === targetEmployeeId);
  }

  function employeeResourceMonitors() {
    const savedResources = typeof store.readResourceMonitors === "function" ? store.readResourceMonitors(targetEmployeeId) : [];
    const savedById = new Map(savedResources.map((item) => [item.id, item]));
    const defaults = resourceDefinitions.map((resource) => sanitizeResourceMonitor({
      ...resource,
      employeeId: targetEmployeeId,
      ...(savedById.get(resource.id) || {}),
    }));
    const deviceBase = defaults.find((item) => item.kind === "remote_cluster");
    const deviceMonitor = deviceBase ? runtimeDeviceResourceMonitor(deviceBase) : null;
    const mergedDefaults = deviceMonitor
      ? defaults.map((item) => item.id === deviceBase.id ? deviceMonitor : item)
      : defaults;
    const defaultIds = new Set(mergedDefaults.map((item) => item.id));
    const extras = savedResources.filter((item) => !defaultIds.has(item.id));
    return [...mergedDefaults, ...extras].sort(sortUpdatedDesc);
  }

  function runtimeDeviceResourceMonitor(base = {}) {
    if (!runtimeInfrastructureStore) return null;
    const allBindings = typeof runtimeInfrastructureStore.listBindings === "function" ? runtimeInfrastructureStore.listBindings() : [];
    const bindings = allBindings.filter((binding) => binding.employeeId === targetEmployeeId);
    if (!bindings.length) return null;
    const infrastructures = typeof runtimeInfrastructureStore.listInfrastructures === "function"
      ? runtimeInfrastructureStore.listInfrastructures()
      : [];
    const infrastructureById = new Map(infrastructures.map((item) => [item.id, item]));
    const enabledRows = bindings
      .filter((binding) => binding.enabled !== false)
      .map((binding) => ({ binding, infrastructure: infrastructureById.get(binding.infrastructureId) || null }))
      .filter((row) => row.infrastructure?.id);
    const availableRows = enabledRows.filter((row) => row.infrastructure.status === "available");
    const availableRemoteRows = availableRows.filter((row) => row.infrastructure.kind === "remote");
    const availableClusterRows = availableRows.filter((row) => row.infrastructure.kind === "cluster");
    const status = availableRemoteRows.length ? "ready" : availableRows.length ? "degraded" : enabledRows.length ? "blocked" : "not_configured";
    const remoteNames = availableRemoteRows.map((row) => row.infrastructure.name).slice(0, 3).join(" / ");
    const clusterCount = availableClusterRows.length;
    const message = availableRemoteRows.length
      ? `已启用 ${availableRemoteRows.length} 个 Remote：${remoteNames}${clusterCount ? `；另有 ${clusterCount} 个集群仅在明确需要时使用。` : "。"}`
      : availableRows.length
        ? `当前仅启用 ${availableRows.length} 个集群；默认任务会优先等待 Remote 或要求用户明确集群需求。`
        : enabledRows.length
          ? "已选择设备，但还没有通过联通测试。"
          : "该数字员工没有启用任何已登记 Remote 或集群。";
    return sanitizeResourceMonitor({
      ...base,
      status,
      capacity: {
        total: `${enabledRows.length} 个已启用设备`,
        available: `${availableRows.length} 个可用设备`,
        queueDepth: base.capacity?.queueDepth || "0",
      },
      health: {
        status,
        message,
        checkedAt: new Date().toISOString(),
      },
      nextGate: status === "ready"
        ? "默认使用已启用 Remote；集群只在任务明确需要时进入候选。"
        : "请在员工运行页启用已登记 Remote，或补做联通测试。",
    });
  }

  return { handle, buildRuntimeSummary };
}

function runtimeSummaryStatusLabel(status = "") {
  if (status === "ready_for_auto_execution") return "已启用";
  if (status === "setup_required") return "待运行配置";
  return "仅接入草案";
}

function defaultResourceSetup({ employee = {}, resourceMonitors = [] } = {}) {
  const requiredResourceIds = Array.isArray(employee.runtimeBinding?.requiredResourceIds)
    ? employee.runtimeBinding.requiredResourceIds.map(cleanShortText).filter(Boolean)
    : [];
  const missingResources = requiredResourceIds.filter((id) => !resourceMonitors.some((resource) => resource.id === id && resource.status === "ready"));
  return { ready: missingResources.length === 0, requiredResourceIds, missingResources };
}

function requireEmployeeId(value = "") {
  const employeeId = cleanShortText(value);
  if (!employeeId) throw new Error("feishu runtime routes employeeId required");
  return employeeId;
}

export { createFeishuEmployeeRuntimeRouteHandlers };
