const CONTRACT_VERSION = "system-worker-config.v2";
const WORKER_STATUSES = new Set(["在线", "试运行", "设计中", "规划接入", "停用"]);
const TRIGGER_MODES = new Set([
  "事件触发",
  "事件触发 + 定时补扫",
  "事件触发 + 每小时补扫",
  "上游材料到达后异步触发",
  "手动触发",
  "暂停触发",
]);
const WORKER_POOL_MODES = new Set(["shared_worker_pool", "dedicated_reserved_worker", "runtime_allocated"]);
const SCHEDULE_PRESETS = new Set(["event-driven", "manual", "*/15 * * * *", "*/30 * * * *", "0 * * * *", "0 */6 * * *"]);
const FORBIDDEN_INPUT_KEYS = /(?:password|secret|private.?key|access.?token|api.?key|authorization)/i;
const SENSITIVE_TEXT = /(?:sk-[a-z0-9_-]{12,}|(?:api|app)[ _-]?(?:key|secret)\s*[:=])/i;
const AUTO_WORKER_EMPLOYEE_STATUSES = new Set(["在线", "试运行"]);
const RESOURCE_FIELDS = new Set(["maxWorkersPerEmployee", "maxParallelWorkers", "batchSize", "taskBufferQueueSize", "taskBufferMinutes", "taskExecutionTimeoutMinutes"]);

export function createSystemWorkerConfigHandlers({
  aiModelCatalog = [],
  aiProviderRoutes = [],
  departments = [],
  digitalEmployees = [],
  getAiProviderRoutes = () => aiProviderRoutes,
  getDigitalEmployees = () => digitalEmployees,
  getDepartmentDirectory = async () => ({ departments: [], source: "unavailable", freshness: "unavailable" }),
  hasPermission,
  readJsonBody,
  requireSession,
  sendJson,
  store,
  runtimeConfigService,
  workers = [],
}) {
  function handle(req, res, url) {
    if (req.method === "GET" && url.pathname === "/api/system-workers") {
      return listWorkers(req, res).then(() => true);
    }

    const workerMatch = url.pathname.match(/^\/api\/system-workers\/([^/]+)$/);
    if (req.method === "PUT" && workerMatch) {
      return updateWorker(req, res, decodeURIComponent(workerMatch[1])).then(() => true);
    }

    const decisionMatch = url.pathname.match(/^\/api\/digital-employee-runtime-config-revisions\/([^/]+)\/decision$/);
    if (req.method === "POST" && decisionMatch) {
      return decideRuntimeConfigRevision(req, res, decodeURIComponent(decisionMatch[1])).then(() => true);
    }

    return undefined;
  }

  async function listWorkers(req, res) {
    const session = requireSession(req, res);
    if (!session) return true;
    if (!canViewWorkers(session)) return deny(res);
    const departmentDirectory = await resolveDepartmentDirectory(res, session, true);
    if (!departmentDirectory) return true;
    const state = store.readState();
    const visibleWorkers = resolvedWorkers(state, session, departmentDirectory);
    return sendJson(res, 200, {
      ok: true,
      contractVersion: CONTRACT_VERSION,
      workers: visibleWorkers,
      departmentDirectory,
      pendingRuntimeConfigRevisions: runtimeConfigService.revisionsForEmployee()
        .filter((revision) => revision.status === "pending_review")
        .filter((revision) => visibleWorkers.some((worker) => worker.ownerEmployeeId === revision.employeeId)),
      updatedAt: state.updatedAt,
      access: workerAccessSummary(session),
      persistence: {
        kind: "mvp-file-store",
        productionReady: false,
        path: "data/local/system-worker-config.json",
        note: "保存全局 Worker 调度治理草案；不分配真实凭据、运行实例或执行任务。",
      },
      privacyBoundary: "只保存 Worker 调度、模型路由和容量元数据；不接受或返回 API Key、密码、token、原始任务、模型 trace 或执行记录。",
    });
  }

  async function updateWorker(req, res, workerId) {
    const session = requireSession(req, res);
    if (!session) return null;
    const departmentDirectory = await resolveDepartmentDirectory(res, session, false);
    if (!departmentDirectory) return null;
    const worker = currentWorkerCatalog(departmentDirectory).find((item) => item.id === workerId);
    if (!worker) return sendJson(res, 404, { ok: false, error: "system_worker_not_found" });
    if (!canEditWorker(session, worker)) return deny(res);

    const input = await readJsonBody(req, 32 * 1024);
    if (hasForbiddenInput(input)) {
      return sendJson(res, 422, {
        ok: false,
        error: "raw_credential_input_forbidden",
        message: "全局 Worker 配置不接受密钥、密码、token 或私钥。",
      });
    }

    const stateBeforeSave = store.readState();
    if (!isSystemAdmin(session)) {
      const validation = validateDepartmentResourceConfig(input, {
        allocated: allocatedResourcePolicy(resolvedWorker(worker, stateBeforeSave.workerOverrides?.[workerId], null, session, departmentDirectory)),
        worker,
      });
      if (!validation.ok) return sendJson(res, 422, validation);
      const departmentId = ownerDepartmentId(worker);
      const saved = worker.generatedFromEmployee
        ? runtimeConfigService.applyPrimaryWorkerConfig({
            employee: currentEmployees().find((employee) => employee.id === worker.ownerEmployeeId),
            config: { ...worker, ...validation.config },
            actor: safeActor(session),
            surface: "department_worker_resource_adjustment",
          })
        : store.saveDepartmentResourceOverride(workerId, departmentId, {
            ...validation.config,
            updatedAt: new Date().toISOString(),
            updatedBy: safeActor(session),
          });
      if (!saved.ok) return storeUnavailable(res);
      const state = store.readState();
      return sendJson(res, 200, {
        ok: true,
        contractVersion: CONTRACT_VERSION,
        worker: resolvedWorkers(state, session, departmentDirectory).find((item) => item.id === workerId),
        workers: resolvedWorkers(state, session, departmentDirectory),
        updatedAt: saved.updatedAt || state.updatedAt,
        message: worker.generatedFromEmployee
          ? "部门资源调整已应用到统一员工运行配置；不能超过系统管理员分配的上限。"
          : "辅助 Lane 的部门资源调整已保存；不能超过系统管理员分配的 Worker、最大排队数、排队提醒和执行超时上限。",
      });
    }

    const departmentIds = new Set(departmentDirectory.departments.map((department) => department.id));
    const validation = validateWorkerConfig(input, {
      aiModelCatalog,
      aiProviderRoutes: currentProviderRoutes(),
      departmentIds,
      worker,
    });
    if (!validation.ok) return sendJson(res, 422, validation);

    const saved = worker.generatedFromEmployee
      ? runtimeConfigService.applyPrimaryWorkerConfig({
          employee: currentEmployees().find((employee) => employee.id === worker.ownerEmployeeId),
          config: { ...validation.config, lane: worker.lane },
          actor: safeActor(session),
        })
      : store.saveOverride(workerId, {
          ...validation.config,
          updatedAt: new Date().toISOString(),
          updatedBy: safeActor(session),
        });
    if (!saved.ok) {
      return sendJson(res, 503, {
        ok: false,
        error: "system_worker_config_store_unavailable",
        message: "Worker 配置未能保存，请稍后重试。",
      });
    }
    const state = store.readState();
    return sendJson(res, 200, {
      ok: true,
      contractVersion: CONTRACT_VERSION,
      worker: resolvedWorkers(state, session, departmentDirectory).find((item) => item.id === workerId),
      workers: resolvedWorkers(state, session, departmentDirectory),
      updatedAt: saved.updatedAt || state.updatedAt,
      message: worker.generatedFromEmployee
        ? "主 Worker 配置已写入统一员工运行配置；数字员工页和真实 Runtime 将读取同一生效版本。"
        : "辅助 Worker Lane 配置已保存；数字员工页将同步展示该 Lane，真实执行仍需服务端租约和调度门禁。",
    });
  }

  async function decideRuntimeConfigRevision(req, res, revisionId) {
    const session = requireSession(req, res);
    if (!session) return null;
    if (!isSystemAdmin(session)) return deny(res);
    const input = await readJsonBody(req, 16 * 1024);
    const result = runtimeConfigService.decideRevision({
      revisionId,
      decision: text(input.decision),
      expectedBaseVersion: input.baseAppliedVersion,
      actor: safeActor(session),
    });
    if (!result.ok) {
      return sendJson(res, result.statusCode || 422, {
        ok: false,
        error: result.error,
        message: result.message,
      });
    }
    return sendJson(res, 200, {
      ok: true,
      contractVersion: "digital-employee-runtime-config.v1",
      status: result.status,
      revision: result.revision,
      digitalEmployee: currentEmployees().find((employee) => employee.id === result.revision.employeeId) || null,
      message: result.status === "applied"
        ? "运行配置变更已审核通过并原子应用；数字员工与 AI Worker 将读取同一版本。"
        : "运行配置变更已驳回，当前生效版本未改变。",
    });
  }

  function resolvedWorkers(state = {}, session = {}, departmentDirectory = {}) {
    const employees = currentEmployees();
    const employeesById = new Map(employees.map((employee) => [employee.id, employee]));
    return currentWorkerCatalog(departmentDirectory, employees)
      .filter((worker) => canViewWorker(session, worker, employeesById))
      .map((worker) => {
        const departmentId = ownerDepartmentId(worker, employeesById);
        return resolvedWorker(
          worker,
          state.workerOverrides?.[worker.id],
          state.departmentResourceOverrides?.[worker.id]?.[departmentId],
          session,
          departmentDirectory,
          employeesById,
        );
      });
  }

  function resolvedWorker(worker, override = {}, departmentResourceOverride = null, session = {}, departmentDirectory = {}, employeesById = null) {
    const normalizedOverride = worker.generatedFromEmployee ? {} : { ...(override || {}) };
    if (!normalizedOverride.preferredProviderRouteId && normalizedOverride.preferredProviderKeyId) {
      normalizedOverride.preferredProviderRouteId = currentProviderRoutes().find(
        (route) => route.credentialId === normalizedOverride.preferredProviderKeyId && route.provider === (normalizedOverride.provider || worker.provider),
      )?.id || "";
    }
    delete normalizedOverride.preferredProviderKeyId;
    const systemWorker = {
      ...worker,
      ...normalizedOverride,
      departmentScope: worker.generatedFromEmployee
        ? derivedEmployeeDepartmentScope(worker, departmentDirectory)
        : normalizedDepartmentScope(normalizedOverride.departmentScope || worker.departmentScope, departmentDirectory),
    };
    const allocated = allocatedResourcePolicy(systemWorker);
    const adjustment = departmentResourceOverride ? clampDepartmentResourceConfig(departmentResourceOverride, allocated) : null;
    const effective = adjustment ? { ...systemWorker, ...adjustment } : systemWorker;
    const access = workerAccess(session, worker, employeesById);
    return {
      ...effective,
      access,
      resourcePolicy: {
        source: worker.generatedFromEmployee ? "auto_digital_employee" : "catalog",
        generatedFromEmployee: worker.generatedFromEmployee === true,
        ownerDepartmentId: ownerDepartmentId(worker, employeesById),
        ownerDepartmentName: ownerDepartmentName(worker, employeesById),
        limits: allocated,
        adjustment,
        editMode: access.editMode,
      },
    };
  }

  function canViewWorkers(session) {
    return isSystemAdmin(session) || managedDepartmentIds(session).length > 0 || hasPermission(session?.permissions || [], "system-workers:read");
  }

  function isSystemAdmin(session) {
    const permissions = session?.permissions || [];
    return session?.role === "admin" || hasPermission(permissions, "system:*") || hasPermission(permissions, "system-workers:*");
  }

  function canViewWorker(session, worker, employeesById = null) {
    if (isSystemAdmin(session)) return true;
    return canManageWorkerDepartment(session, worker, employeesById);
  }

  function canEditWorker(session, worker, employeesById = null) {
    return isSystemAdmin(session) || canManageWorkerDepartment(session, worker, employeesById);
  }

  function canManageWorkerDepartment(session, worker, employeesById = null) {
    const departmentId = ownerDepartmentId(worker, employeesById);
    if (!departmentId) return false;
    const departments = managedDepartmentIds(session);
    return departments.includes("*") || departments.includes(departmentId);
  }

  function workerAccess(session, worker, employeesById = null) {
    if (isSystemAdmin(session)) {
      return { canEdit: true, editMode: "system_admin", label: "系统管理员" };
    }
    const canEdit = canManageWorkerDepartment(session, worker, employeesById);
    return {
      canEdit,
      editMode: canEdit ? "department_resource" : "read_only",
      label: canEdit ? "部门资源调整" : "只读",
    };
  }

  function workerAccessSummary(session) {
    if (isSystemAdmin(session)) {
      return {
        role: "system_admin",
        canEditGlobalConfig: true,
        canEditDepartmentResources: true,
        message: "系统管理员可维护全局 Worker 路由、模型、触发、限额、排队提醒和执行超时配置。",
      };
    }
    return {
      role: "department_admin",
      canEditGlobalConfig: false,
      canEditDepartmentResources: true,
      managedDepartmentIds: managedDepartmentIds(session),
      message: "部门管理员只可调整自己治理范围内、且不超过系统分配上限的 Worker 资源。",
    };
  }

  function ownerDepartmentId(worker, employeesById = null) {
    const employee = employeesById?.get(worker.ownerEmployeeId) || currentEmployees().find((item) => item.id === worker.ownerEmployeeId);
    return worker.ownerDepartmentId || employee?.ownerDepartmentId || employee?.departmentId || "";
  }

  function ownerDepartmentName(worker, employeesById = null) {
    const employee = employeesById?.get(worker.ownerEmployeeId) || currentEmployees().find((item) => item.id === worker.ownerEmployeeId);
    return worker.ownerDepartment || employee?.department || ownerDepartmentId(worker, employeesById);
  }

  function currentEmployees() {
    const items = getDigitalEmployees();
    return Array.isArray(items) ? items : [];
  }

  function currentProviderRoutes() {
    const items = getAiProviderRoutes();
    return Array.isArray(items) ? items.filter((route) => route.enabled !== false && route.health !== "disabled") : [];
  }

  function currentWorkerCatalog(departmentDirectory = {}, employees = null) {
    return buildWorkerCatalog({ workers, digitalEmployees: employees || currentEmployees(), aiModelCatalog, departmentDirectory });
  }

  function derivedEmployeeDepartmentScope(worker, departmentDirectory = {}) {
    const topDepartments = Array.isArray(departmentDirectory.departments) ? departmentDirectory.departments : [];
    const sourceIds = Array.isArray(worker.ownerDepartmentIds) && worker.ownerDepartmentIds.length
      ? worker.ownerDepartmentIds
      : [worker.ownerDepartmentId];
    return [...new Set(sourceIds.map((departmentId) => {
      const value = text(departmentId);
      const canonical = topDepartments.find((department) => value === department.id || value.startsWith(`${department.id}/`));
      if (canonical) return canonical.id;
      const legacyName = departments.find((department) => department.id === value)?.name || worker.ownerDepartment;
      const matches = legacyName ? topDepartments.filter((department) => department.name === legacyName) : [];
      return matches.length === 1 ? matches[0].id : "";
    }).filter(Boolean))];
  }

  function normalizedDepartmentScope(scope = [], departmentDirectory = {}) {
    const topDepartments = Array.isArray(departmentDirectory.departments) ? departmentDirectory.departments : [];
    return [...new Set((Array.isArray(scope) ? scope : []).map((departmentId) => {
      const exact = topDepartments.find((department) => department.id === departmentId);
      if (exact) return exact.id;
      const legacyName = departments.find((department) => department.id === departmentId)?.name;
      const matches = legacyName ? topDepartments.filter((department) => department.name === legacyName) : [];
      return matches.length === 1 ? matches[0].id : "";
    }).filter(Boolean))];
  }

  function listRuntimeAuxiliaryWorkers() {
    const state = store.readState();
    return workers.map((worker) => {
      const employee = digitalEmployees.find((item) => item.id === worker.ownerEmployeeId);
      const departmentId = text(worker.ownerDepartmentId || employee?.ownerDepartmentId || employee?.departmentId);
      const configured = withResourceDefaults({
        ...worker,
        ...(state.workerOverrides?.[worker.id] || {}),
        workerRole: "auxiliary",
      });
      const adjustment = state.departmentResourceOverrides?.[worker.id]?.[departmentId];
      return adjustment
        ? { ...configured, ...clampDepartmentResourceConfig(adjustment, allocatedResourcePolicy(configured)) }
        : configured;
    });
  }

  function withRuntimeWorkers(employees = []) {
    const fixedWorkers = listRuntimeAuxiliaryWorkers();
    const fixedIds = new Set(fixedWorkers.map((worker) => worker.id));
    return employees.map((employee) => {
      const primary = AUTO_WORKER_EMPLOYEE_STATUSES.has(text(employee.status))
        ? autoWorkerForEmployee(employee, aiModelCatalog, fixedIds)
        : null;
      const employeeWorkers = [
        ...(primary ? [primary] : []),
        ...fixedWorkers.filter((worker) => worker.ownerEmployeeId === employee.id),
      ].map(safeRuntimeWorkerSummary);
      return { ...employee, runtimeWorkers: employeeWorkers };
    });
  }

  async function resolveDepartmentDirectory(res, session, allowStale) {
    try {
      return await getDepartmentDirectory(session, { allowStale });
    } catch {
      sendJson(res, 503, {
        ok: false,
        error: "fortress_department_directory_unavailable",
        message: "实时一级部门目录暂不可用，当前不能读取或保存 Worker 部门范围。",
      });
      return null;
    }
  }

  function deny(res) {
    return sendJson(res, 403, {
      ok: false,
      error: "system_worker_governance_required",
      message: "全局 Worker 调度仅限系统管理员或具备部门治理范围的管理员访问；全局路由配置只允许系统管理员维护。",
    });
  }

  function storeUnavailable(res) {
    return sendJson(res, 503, {
      ok: false,
      error: "system_worker_config_store_unavailable",
      message: "Worker 配置未能保存，请稍后重试。",
    });
  }

  return { handle, listRuntimeAuxiliaryWorkers, withRuntimeWorkers };
}

function validateWorkerConfig(input = {}, { aiModelCatalog, aiProviderRoutes, departmentIds, worker }) {
  const provider = text(input.provider);
  const model = aiModelCatalog.find((item) => item.provider === provider && item.model === text(input.model));
  if (!model) return invalid("system_worker_model_invalid", "请选择当前 Provider 支持的模型。");

  const reasoningEffort = text(input.reasoningEffort);
  if (!model.supportedLevelIds?.includes(reasoningEffort)) {
    return invalid("system_worker_reasoning_invalid", "请选择模型支持的推理强度。");
  }

  const preferredProviderRouteId = text(input.preferredProviderRouteId);
  if (preferredProviderRouteId) {
    const providerRoute = aiProviderRoutes.find((item) => item.id === preferredProviderRouteId && item.provider === provider);
    if (!providerRoute) return invalid("system_worker_provider_route_invalid", "路由偏好必须是当前 Provider 的已登记 Route。");
  }

  const status = text(input.status);
  const triggerMode = text(input.triggerMode);
  const workerPoolMode = text(input.workerPoolMode || "runtime_allocated");
  if (!WORKER_STATUSES.has(status)) return invalid("system_worker_status_invalid");
  if (!TRIGGER_MODES.has(triggerMode)) return invalid("system_worker_trigger_mode_invalid");
  if (!WORKER_POOL_MODES.has(workerPoolMode)) return invalid("system_worker_pool_mode_invalid");

  const schedule = text(input.schedule);
  if (!validSchedule(schedule)) return invalid("system_worker_schedule_invalid", "调度只支持预设方式或五段 Cron 表达式。");

  const textFields = ["credentialPolicy", "triggerPolicy", "dedupeKey", "outputContract", "governance"];
  const config = Object.fromEntries(textFields.map((field) => [field, safeText(input[field], 360)]));
  if (textFields.some((field) => config[field] === null)) {
    return invalid("system_worker_text_invalid", "配置说明不能包含密钥格式或超长内容。");
  }

  const departmentScope = uniqueTextList(input.departmentScope, 20, 60);
  if (!departmentScope.every((id) => departmentIds.has(id))) return invalid("system_worker_department_scope_invalid");
  const assignedRequestTypes = uniqueTextList(input.assignedRequestTypes, 24, 60);
  if (!assignedRequestTypes.length) return invalid("system_worker_request_type_required", "至少保留一种 Request 类型。");

  return {
    ok: true,
    config: {
      ...config,
      status,
      triggerMode,
      schedule,
      provider,
      model: model.model,
      reasoningEffort,
      preferredProviderRouteId,
      workerPoolMode,
      consumesSharedWorkerQuota: input.consumesSharedWorkerQuota !== false,
      maxWorkersPerEmployee: integerInRange(input.maxWorkersPerEmployee, 1, 16, worker.maxWorkersPerEmployee || 1),
      maxParallelWorkers: integerInRange(input.maxParallelWorkers, 1, 32, worker.maxParallelWorkers || 1),
      batchSize: integerInRange(input.batchSize, 1, 100, worker.batchSize || 1),
      taskBufferQueueSize: integerInRange(input.taskBufferQueueSize, 0, 100, worker.taskBufferQueueSize || 0),
      taskBufferMinutes: integerInRange(input.taskBufferMinutes, 1, 24 * 60, worker.taskBufferMinutes || 240),
      taskExecutionTimeoutMinutes: integerInRange(input.taskExecutionTimeoutMinutes, 1, 24 * 60, worker.taskExecutionTimeoutMinutes || 60),
      departmentScope,
      assignedRequestTypes,
    },
  };
}

function validateDepartmentResourceConfig(input = {}, { allocated }) {
  const illegalField = Object.keys(input || {}).find((field) => !RESOURCE_FIELDS.has(field));
  if (illegalField) {
    return invalid(
      "system_worker_department_resource_only",
      "部门管理员只能调整已分配 Worker 资源、最大排队数、排队提醒和执行超时，不能修改模型、路由、触发或部门范围。",
    );
  }

  const config = {};
  const resourceFields = [
    ["maxWorkersPerEmployee", 1],
    ["maxParallelWorkers", 1],
    ["batchSize", 1],
    ["taskBufferQueueSize", 0],
    ["taskBufferMinutes", 1],
    ["taskExecutionTimeoutMinutes", 1],
  ];
  for (const [field, minimum] of resourceFields) {
    const value = input[field] === undefined ? allocated[field] : input[field];
    const checked = integerWithinLimit(value, minimum, allocated[field], field);
    if (!checked.ok) return checked;
    config[field] = checked.value;
  }
  return { ok: true, config };
}

function buildWorkerCatalog({ workers = [], digitalEmployees = [], aiModelCatalog = [] } = {}) {
  const fixedWorkerIds = new Set(workers.map((worker) => worker.id).filter(Boolean));
  const autoWorkers = digitalEmployees
    .filter((employee) => AUTO_WORKER_EMPLOYEE_STATUSES.has(text(employee.status)))
    .filter((employee) => employee.id)
    .map((employee) => autoWorkerForEmployee(employee, aiModelCatalog, fixedWorkerIds))
    .filter(Boolean);
  return [
    ...workers.map((worker) => withResourceDefaults({ ...worker, workerRole: "auxiliary" })),
    ...autoWorkers,
  ];
}

function autoWorkerForEmployee(employee = {}, aiModelCatalog = [], fixedWorkerIds = new Set()) {
  const binding = { ...(employee.modelBinding || {}), ...(employee.runtimeBinding || {}) };
  const model = aiModelCatalog.find((item) => item.id === binding.modelId || item.model === binding.model) || aiModelCatalog[0] || {};
  const provider = text(binding.provider || model.provider || "codex");
  const workerId = uniqueWorkerId(`${employee.id}-runtime-worker`, fixedWorkerIds);
  const lane = text(binding.workerLane || binding.agentRuntimeId || `${employee.id}-runtime`).replace(/[^a-zA-Z0-9_-]+/g, "_");
  const departmentId = text(employee.ownerDepartmentId || employee.departmentId);
  const department = text(employee.department || departmentId);
  return withResourceDefaults({
    id: workerId,
    name: `${employee.name || employee.id} Worker`,
    lane,
    status: text(employee.status) === "在线" ? "在线" : "试运行",
    triggerMode: text(binding.triggerMode || "事件触发"),
    triggerPolicy: text(binding.triggerPolicy || "数字员工在线或试运行时，按已授权渠道事件进入服务端队列。"),
    credentialPolicy: text(binding.credentialLeasePolicy || `按需从 ${provider} 供应商 Key 获取服务端租约；不向浏览器暴露密钥。`),
    schedule: text(binding.schedule || "event-driven"),
    ownerEmployeeId: employee.id,
    ownerDepartmentId: departmentId,
    ownerDepartmentIds: [...new Set([employee.ownerDepartmentId, employee.departmentId, ...(employee.departmentIds || [])].map(text).filter(Boolean))],
    ownerDepartment: department,
    generatedFromEmployee: true,
    workerRole: "primary",
    provider,
    preferredProviderRouteId: text(binding.providerRouteId || binding.preferredProviderRouteId),
    workerPoolMode: text(binding.workerPoolMode || "runtime_allocated"),
    consumesSharedWorkerQuota: binding.consumesSharedWorkerQuota !== false,
    model: text(binding.model || model.model || "gpt-5.5"),
    reasoningEffort: text(binding.reasoningEffort || binding.modelLevelId || model.defaultLevelId || "medium"),
    maxWorkersPerEmployee: integerInRange(binding.maxWorkersPerEmployee, 1, 16, 1),
    maxParallelWorkers: integerInRange(binding.maxParallelWorkers ?? binding.reservedWorkerSlots, 1, 32, 1),
    batchSize: integerInRange(binding.batchSize, 1, 100, 1),
    taskBufferQueueSize: integerInRange(binding.taskBufferQueueSize ?? binding.maxBufferedTasks ?? binding.bufferQueueSize, 0, 100, 0),
    taskBufferMinutes: integerInRange(binding.taskBufferMinutes ?? binding.taskTimeoutMinutes, 1, 24 * 60, 240),
    taskExecutionTimeoutMinutes: integerInRange(binding.taskExecutionTimeoutMinutes ?? binding.executionTimeoutMinutes, 1, 24 * 60, 60),
    departmentScope: departmentId ? [departmentId] : [],
    assignedRequestTypes: Array.isArray(binding.assignedRequestTypes) && binding.assignedRequestTypes.length
      ? binding.assignedRequestTypes.map(text).filter(Boolean).slice(0, 24)
      : autoRequestTypesForEmployee(employee),
    dedupeKey: "employeeId + channel + sourceEventId + submittedAt",
    outputContract: text(employee.outputContract || "employeeTaskResult{summary, evidence, nextGate}"),
    governance: `随 ${employee.name || employee.id} 的在线/试运行状态自动进入 AI Worker 调度；正式执行仍受服务端租约、审计和人工门禁约束。`,
  });
}

function safeRuntimeWorkerSummary(worker = {}) {
  return {
    id: text(worker.id),
    name: text(worker.name),
    lane: text(worker.lane),
    workerRole: text(worker.workerRole || (worker.generatedFromEmployee ? "primary" : "auxiliary")),
    status: text(worker.status),
    provider: text(worker.provider),
    model: text(worker.model),
    reasoningEffort: text(worker.reasoningEffort),
    triggerMode: text(worker.triggerMode),
    schedule: text(worker.schedule),
    maxParallelWorkers: Number(worker.maxParallelWorkers || 0),
    taskBufferQueueSize: Number(worker.taskBufferQueueSize || 0),
    taskBufferMinutes: Number(worker.taskBufferMinutes || 0),
    assignedRequestTypes: Array.isArray(worker.assignedRequestTypes) ? worker.assignedRequestTypes.map(text).filter(Boolean) : [],
  };
}

function autoRequestTypesForEmployee(employee = {}) {
  return [...new Set([
    "数字员工运行",
    employee.businessDomain,
    employee.skillCluster,
    ...(Array.isArray(employee.sourceTargets) ? employee.sourceTargets.slice(0, 2) : []),
  ].map(text).filter(Boolean))].slice(0, 6);
}

function withResourceDefaults(worker = {}) {
  return {
    ...worker,
    preferredProviderRouteId: text(worker.preferredProviderRouteId),
    workerPoolMode: worker.workerPoolMode === "shared_key_pool" ? "shared_worker_pool" : worker.workerPoolMode || "runtime_allocated",
    consumesSharedWorkerQuota: worker.consumesSharedWorkerQuota !== false,
    maxWorkersPerEmployee: integerInRange(worker.maxWorkersPerEmployee, 1, 16, 1),
    maxParallelWorkers: integerInRange(worker.maxParallelWorkers, 1, 32, 1),
    batchSize: integerInRange(worker.batchSize, 1, 100, 1),
    taskBufferQueueSize: integerInRange(worker.taskBufferQueueSize, 0, 100, 0),
    taskBufferMinutes: integerInRange(worker.taskBufferMinutes, 1, 24 * 60, 240),
    taskExecutionTimeoutMinutes: integerInRange(worker.taskExecutionTimeoutMinutes, 1, 24 * 60, 60),
  };
}

function allocatedResourcePolicy(worker = {}) {
  const base = withResourceDefaults(worker);
  return {
    maxWorkersPerEmployee: base.maxWorkersPerEmployee,
    maxParallelWorkers: base.maxParallelWorkers,
    batchSize: base.batchSize,
    taskBufferQueueSize: base.taskBufferQueueSize,
    taskBufferMinutes: base.taskBufferMinutes,
    taskExecutionTimeoutMinutes: base.taskExecutionTimeoutMinutes,
  };
}

function clampDepartmentResourceConfig(override = {}, allocated = {}) {
  return Object.fromEntries(
    Object.entries(allocatedResourcePolicy(allocated)).map(([field, fallback]) => {
      const minimum = field === "taskBufferQueueSize" ? 0 : 1;
      return [field, integerInRange(override[field], minimum, fallback, fallback)];
    }),
  );
}

function uniqueWorkerId(baseId, fixedWorkerIds) {
  const base = cleanId(baseId);
  if (!fixedWorkerIds.has(base)) {
    fixedWorkerIds.add(base);
    return base;
  }
  let counter = 2;
  while (fixedWorkerIds.has(`${base}-${counter}`)) counter += 1;
  const next = `${base}-${counter}`;
  fixedWorkerIds.add(next);
  return next;
}

function hasForbiddenInput(input = {}) {
  return Object.entries(input || {}).some(([key, value]) => {
    if (FORBIDDEN_INPUT_KEYS.test(key)) return true;
    return typeof value === "string" && SENSITIVE_TEXT.test(value);
  });
}

function validSchedule(value) {
  if (SCHEDULE_PRESETS.has(value)) return true;
  const parts = value.split(/\s+/).filter(Boolean);
  return parts.length === 5 && value.length <= 64 && /^[\d*/,\-\s]+$/.test(value);
}

function uniqueTextList(value, limit, itemLimit) {
  const source = Array.isArray(value) ? value : [];
  return [...new Set(source.map((item) => safeText(item, itemLimit)).filter(Boolean))].slice(0, limit);
}

function safeText(value, limit) {
  const normalized = text(value);
  if (normalized.length > limit || SENSITIVE_TEXT.test(normalized)) return null;
  return normalized;
}

function text(value) {
  return String(value || "").trim().replace(/[\u0000-\u001f]/g, "");
}

function integerInRange(value, minimum, maximum, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(maximum, Math.max(minimum, Math.floor(number)));
}

function integerWithinLimit(value, minimum, maximum, field) {
  const number = Number(value);
  if (!Number.isFinite(number)) {
    return invalid("system_worker_resource_invalid", "Worker 资源配置必须是数字。");
  }
  const integer = Math.floor(number);
  if (integer < minimum || integer > maximum) {
    return invalid(
      "system_worker_resource_limit_exceeded",
      `${field} 不能超过系统管理员分配的上限 ${maximum}，且不能低于 ${minimum}。`,
    );
  }
  return { ok: true, value: integer };
}

function managedDepartmentIds(session = {}) {
  return Array.isArray(session.managedDepartmentIds) ? session.managedDepartmentIds.map(text).filter(Boolean) : [];
}

function cleanId(value) {
  return text(value).toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "") || "digital-employee-worker";
}

function safeActor(session = {}) {
  return text(session.employeeId || session.email || session.name || "platform-admin").slice(0, 120);
}

function invalid(error, message) {
  return { ok: false, error, ...(message ? { message } : {}) };
}
