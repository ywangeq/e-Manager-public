const CONTRACT_VERSION = "digital-employee-model-binding.v2";
const MODEL_ASSIGNMENT_REQUEST_FIELDS = new Set(["expectedAppliedVersion", "items"]);

export function createDigitalEmployeeModelBindingHandlers({
  aiModelCatalog = [],
  getDigitalEmployees = () => [],
  hasPermission,
  readJsonBody,
  requireSession,
  runtimeConfigService,
  sendJson,
  store,
}) {
  function handle(req, res, url) {
    const assignmentMatch = url.pathname.match(/^\/api\/digital-employees\/([^/]+)\/model-assignments$/);
    if (req.method === "GET" && assignmentMatch) {
      return getModelAssignments(req, res, decodeURIComponent(assignmentMatch[1])).then(() => true);
    }
    if (req.method === "PUT" && assignmentMatch) {
      return applyModelAssignments(req, res, decodeURIComponent(assignmentMatch[1])).then(() => true);
    }
    const match = url.pathname.match(/^\/api\/digital-employees\/([^/]+)\/(?:runtime-config|model-binding)$/);
    if (req.method === "PUT" && match) {
      return applyModelBinding(req, res, decodeURIComponent(match[1])).then(() => true);
    }
    return undefined;
  }

  async function getModelAssignments(req, res, employeeId) {
    const session = requireSession(req, res);
    if (!session) return null;
    const employee = getDigitalEmployees().find((item) => item.id === employeeId);
    if (!employee) return sendJson(res, 404, { ok: false, error: "digital_employee_not_found" });
    if (!canConfigureEmployee(session, employee)) return configurationRequired(res);
    const projected = runtimeConfigService.withAppliedProfiles([employee])[0];
    return sendJson(res, 200, {
      ok: true,
      contractVersion: projected.modelAssignments.contractVersion,
      expectedAppliedVersion: Number(projected.runtimeConfig?.appliedVersion || 0),
      modelAssignments: projected.modelAssignments,
    });
  }

  async function applyModelAssignments(req, res, employeeId) {
    const session = requireSession(req, res);
    if (!session) return null;
    const employee = getDigitalEmployees().find((item) => item.id === employeeId);
    if (!employee) return sendJson(res, 404, { ok: false, error: "digital_employee_not_found" });
    if (!canConfigureEmployee(session, employee)) return configurationRequired(res);
    const input = await readJsonBody(req, 16 * 1024);
    if (Object.keys(input || {}).some((field) => !MODEL_ASSIGNMENT_REQUEST_FIELDS.has(field))) {
      return invalid(res, "digital_employee_model_assignments_request_invalid", "模型分配请求包含不允许的字段。");
    }
    const taskDefinitionIds = new Set((Array.isArray(employee.scheduleBindings) ? employee.scheduleBindings : [])
      .map((item) => text(item?.taskDefinitionId || item?.taskId))
      .filter(Boolean));
    const requestedTaskIds = (Array.isArray(input.items) ? input.items : [])
      .flatMap((item) => Array.isArray(item?.roles?.taskDefinitionIds) ? item.roles.taskDefinitionIds.map(text) : []);
    if (requestedTaskIds.some((taskId) => !taskDefinitionIds.has(taskId))) {
      return invalid(res, "digital_employee_model_assignment_task_definition_invalid", "模型只能分配给该数字员工已声明的任务定义。");
    }
    const applyImmediately = isSystemAdmin(session);
    const result = runtimeConfigService.submitModelAssignments({
      employee,
      items: input.items,
      expectedAppliedVersion: input.expectedAppliedVersion,
      actor: safeActor(session),
      surface: "digital_employee_model_assignments",
      applyImmediately,
    });
    if (!result.ok) {
      return sendJson(res, result.statusCode || 503, {
        ok: false,
        error: result.error || "digital_employee_runtime_config_store_unavailable",
        message: result.message || "模型分配未能保存，请稍后重试。",
      });
    }
    const digitalEmployee = applyImmediately
      ? runtimeConfigService.withAppliedProfiles([employee])[0]
      : employee;
    return sendJson(res, applyImmediately ? 200 : 202, {
      ok: true,
      contractVersion: "digital-employee-model-assignments.v1",
      status: result.status,
      revision: result.revision,
      digitalEmployee,
      message: applyImmediately
        ? "模型分配已应用；任务仍需单独登记和通过运行门禁。"
        : "模型分配已提交审核；审核通过前继续使用当前生效集合。",
    });
  }

  async function applyModelBinding(req, res, employeeId) {
    const session = requireSession(req, res);
    if (!session) return null;
    const employee = getDigitalEmployees().find((item) => item.id === employeeId);
    if (!employee) return sendJson(res, 404, { ok: false, error: "digital_employee_not_found" });
    if (!canConfigureEmployee(session, employee)) {
      return configurationRequired(res);
    }

    const input = await readJsonBody(req, 8 * 1024);
    const model = aiModelCatalog.find((item) => item.id === text(input.modelId) && Number.isInteger(item.digitalEmployeeMenuOrder));
    if (!model) return invalid(res, "digital_employee_model_invalid", "请选择目录中可用于数字员工的模型。");
    const modelLevelId = text(input.modelLevelId);
    if (!model.supportedLevelIds?.includes(modelLevelId) || modelLevelId === "none") {
      return invalid(res, "digital_employee_reasoning_invalid", "请选择该模型支持的推理强度。");
    }
    const assignedRequestTypes = input.assignedRequestTypes === undefined
      ? undefined
      : uniqueTextList(input.assignedRequestTypes, 24, 60);
    if (input.assignedRequestTypes !== undefined && !assignedRequestTypes.length) {
      return invalid(res, "digital_employee_request_type_required", "至少保留一种 Request 类型。");
    }

    const applyImmediately = isSystemAdmin(session);
    const result = runtimeConfigService.submitRuntimeConfig({
      employee,
      modelId: model.id,
      modelLevelId,
      assignedRequestTypes,
      actor: safeActor(session),
      surface: "digital_employee_configuration",
      applyImmediately,
    });
    if (!result.ok) {
      return sendJson(res, 503, {
        ok: false,
        error: result.error || "digital_employee_runtime_config_store_unavailable",
        message: result.message || "运行配置未能保存，请稍后重试。",
      });
    }

    const digitalEmployee = applyImmediately
      ? runtimeConfigService.withAppliedProfiles(withModelBindings([employee]))[0]
      : employee;
    return sendJson(res, applyImmediately ? 200 : 202, {
      ok: true,
      contractVersion: "digital-employee-runtime-config.v1",
      status: result.status,
      revision: result.revision,
      digitalEmployee,
      message: applyImmediately
        ? "运行配置已立即应用；数字员工与 AI Worker 将读取同一模型和 Request 类型。"
        : "运行配置变更已提交审核；审核通过前继续使用当前生效版本。",
    });
  }

  function withModelBindings(employees = []) {
    // Legacy MVP bindings remain readable for migration diagnostics only;
    // canonical runtime config owns the applied model projection.
    return employees;
  }

  function canConfigureEmployee(session = {}, employee = {}) {
    const permissions = session.permissions || [];
    if (
      session.role === "admin" ||
      hasPermission(permissions, "digital-employees:*") ||
      hasPermission(permissions, "digital-employees:configure") ||
      hasPermission(permissions, "control-plane:*")
    ) {
      return true;
    }
    const managedDepartmentIds = Array.isArray(session.managedDepartmentIds) ? session.managedDepartmentIds : [];
    const employeeDepartmentIds = [...new Set([employee.ownerDepartmentId, employee.departmentId, ...(Array.isArray(employee.departmentIds) ? employee.departmentIds : [])].filter(Boolean))];
    const managesEmployeeDepartment = employeeDepartmentIds.some((departmentId) => managedDepartmentIds.includes("*") || managedDepartmentIds.includes(departmentId));
    if (managesEmployeeDepartment) return true;
    const actorIds = [session.employeeId, session.feishuUserId, session.employeeNo, session.email].filter(Boolean);
    return [employee.ownerUserId, employee.ownerEmail].filter(Boolean).some((ownerId) => actorIds.includes(ownerId));
  }

  function isSystemAdmin(session = {}) {
    const permissions = session.permissions || [];
    return session.role === "admin" || hasPermission(permissions, "system:*") || hasPermission(permissions, "system-workers:*");
  }

  function configurationRequired(res) {
    return sendJson(res, 403, {
      ok: false,
      error: "digital_employee_configuration_required",
      message: "当前账号没有该数字员工的模型配置权限。",
    });
  }

  function invalid(res, error, message) {
    return sendJson(res, 422, { ok: false, error, message });
  }

  function uniqueTextList(value, limit, itemLimit) {
    const source = Array.isArray(value) ? value : [];
    return [...new Set(source.map((item) => text(item).slice(0, itemLimit)).filter(Boolean))].slice(0, limit);
  }

  return { handle, withModelBindings };
}

function safeActor(session = {}) {
  return text(session.employeeId || session.email || session.name || "digital-employee-configurer").slice(0, 120);
}

function text(value) {
  return String(value || "").trim().replace(/[\u0000-\u001f]/g, "");
}
