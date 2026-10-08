import crypto from "node:crypto";

const CONTRACT_VERSION = "runtime-infrastructure.v1";
const ADMIN_TEST_ONLY = "admin_test_only";
const KINDS = new Set(["remote", "cluster"]);
const CLI_ADAPTERS = new Set(["auto", "schedctl", "schedctl_object"]);
const EXECUTION_SCOPES = new Set(["sdk_smoke", "algorithm_inference", "gpu_training", "object_storage_mount"]);
const DISABLED_BY_EMPLOYEE = "disabled_by_employee";

export function createRuntimeInfrastructureHandlers({
  digitalEmployees = [],
  getDigitalEmployees,
  hasPermission,
  probe,
  readJsonBody,
  requireSession,
  sendJson,
  store,
}) {
  function handle(req, res, url) {
    if (req.method === "GET" && url.pathname === "/api/runtime-infrastructure") {
      listInfrastructures(req, res, url);
      return true;
    }
    if (req.method === "POST" && url.pathname === "/api/runtime-infrastructure") {
      return createInfrastructure(req, res).then(() => true);
    }

    const infrastructureMatch = url.pathname.match(/^\/api\/runtime-infrastructure\/([^/]+)$/);
    if (req.method === "PATCH" && infrastructureMatch) {
      return updateInfrastructure(req, res, decodeURIComponent(infrastructureMatch[1])).then(() => true);
    }

    const bindingMatch = url.pathname.match(/^\/api\/runtime-infrastructure\/([^/]+)\/bindings$/);
    if (req.method === "POST" && bindingMatch) {
      return createBinding(req, res, decodeURIComponent(bindingMatch[1])).then(() => true);
    }

    const bindingUpdateMatch = url.pathname.match(/^\/api\/runtime-infrastructure\/([^/]+)\/bindings\/([^/]+)$/);
    if (req.method === "PATCH" && bindingUpdateMatch) {
      return updateBinding(
        req,
        res,
        decodeURIComponent(bindingUpdateMatch[1]),
        decodeURIComponent(bindingUpdateMatch[2]),
      ).then(() => true);
    }

    const probeMatch = url.pathname.match(/^\/api\/runtime-infrastructure\/([^/]+)\/probe$/);
    if (req.method === "POST" && probeMatch) {
      return probeInfrastructure(req, res, decodeURIComponent(probeMatch[1])).then(() => true);
    }

    return undefined;
  }

  function listInfrastructures(req, res, url) {
    const session = requireSession(req, res);
    if (!session) return null;
    const employeeId = cleanText(url.searchParams.get("employeeId"));
    const canManage = canManageInfrastructure(session);
    if (!employeeId && !canManage) return deny(res, sendJson);
    const employees = currentDigitalEmployeesList();
    if (employeeId && !employees.some((employee) => employee.id === employeeId)) {
      return sendJson(res, 404, {
        ok: false,
        error: "digital_employee_not_found",
        message: "员工目录状态已变化，请返回员工列表确认后重试。",
      });
    }

    const infrastructures = store.listInfrastructures();
    const bindings = store.listBindings();
    const employeeBindings = employeeId ? bindings.filter((binding) => binding.employeeId === employeeId) : bindings;
    const visibleInfrastructureIds = new Set(employeeBindings.map((binding) => binding.infrastructureId));
    const visibleInfrastructures = employeeId && !canManage
      ? infrastructures.filter((infrastructure) => visibleInfrastructureIds.has(infrastructure.id))
      : infrastructures;

    return sendJson(res, 200, {
      ok: true,
      contractVersion: CONTRACT_VERSION,
      canManage,
      infrastructure: visibleInfrastructures.map((infrastructure) => safeInfrastructure(infrastructure, bindings, employees)),
      bindings: employeeBindings.map((binding) => safeBinding(binding, infrastructures, employees)),
      employeeOptions: canManage ? employees.map((employee) => ({ id: employee.id, name: employee.name || employee.id })) : [],
      employeeId,
      privacyBoundary: "只返回凭据引用状态、脱敏账号、GPU 容量、联通安全摘要和绑定门禁；不返回密码、私钥、SSH 配置、远程路径、命令输出或执行日志。",
      executionBoundary: "设施联通只代表基础设施可用。GPU 训练、SDK/DVC、文件读取和写回仍需任务级调用门禁与受控 runner；不生成逐条任务审批。",
    });
  }

  async function createInfrastructure(req, res) {
    const session = requireSession(req, res);
    if (!session) return null;
    if (!canManageInfrastructure(session)) return deny(res, sendJson);
    const input = await readJsonBody(req, 32 * 1024);
    if (hasRawCredentialInput(input)) {
      return sendJson(res, 422, {
        ok: false,
        error: "raw_credential_input_forbidden",
        message: "基础设施页面只接受服务端凭据引用，不能提交密码、私钥或任意命令。",
      });
    }

    const validation = validateInfrastructureInput(input);
    if (!validation.ok) return sendJson(res, 422, validation);
    const now = new Date().toISOString();
    const infrastructure = store.saveInfrastructure({
      id: `INF-${crypto.randomUUID().slice(0, 8).toUpperCase()}`,
      name: validation.name,
      kind: validation.kind,
      connectionRef: validation.connectionRef,
      cliAdapter: validation.cliAdapter,
      gpuTotal: validation.gpuTotal,
      gpuAvailable: validation.gpuAvailable,
      status: "pending_probe",
      statusLabel: "待联通测试",
      accountMasked: "",
      detectedGpuCount: 0,
      cliStatus: validation.kind === "cluster" ? "not_tested" : "not_applicable",
      cliAdapterDetected: "",
      probeMode: "",
      lastProbeAt: "",
      lastProbeSummary: "等待管理员发起只读联通测试。",
      createdAt: now,
      updatedAt: now,
      ownerLabel: session.name || session.email || "平台管理员",
    });

    return sendJson(res, 201, {
      ok: true,
      contractVersion: CONTRACT_VERSION,
      infrastructure: safeInfrastructure(infrastructure, store.listBindings(), currentDigitalEmployeesList()),
    });
  }

  async function createBinding(req, res, infrastructureId) {
    const session = requireSession(req, res);
    if (!session) return null;
    if (!canManageInfrastructure(session)) return deny(res, sendJson);
    const infrastructure = store.getInfrastructure(infrastructureId);
    if (!infrastructure) return sendJson(res, 404, { ok: false, error: "runtime_infrastructure_not_found" });
    const input = await readJsonBody(req, 32 * 1024);
    const employees = currentDigitalEmployeesList();
    const employee = employees.find((item) => item.id === cleanText(input.employeeId));
    if (!employee) return sendJson(res, 404, { ok: false, error: "digital_employee_not_found" });
    const existingBinding = store.listBindings().find(
      (binding) => binding.infrastructureId === infrastructureId && binding.employeeId === employee.id,
    );
    if (existingBinding) {
      return sendJson(res, 409, {
        ok: false,
        error: "runtime_infrastructure_binding_exists",
        binding: safeBinding(existingBinding, store.listInfrastructures(), employees),
      });
    }
    const scopes = uniqueList(input.executionScopes).filter((scope) => EXECUTION_SCOPES.has(scope));
    if (!scopes.length) {
      return sendJson(res, 422, { ok: false, error: "execution_scope_required", message: "至少选择一个员工运行用途。" });
    }

    const now = new Date().toISOString();
    const binding = store.saveBinding({
      id: `INFBIND-${crypto.randomUUID().slice(0, 8).toUpperCase()}`,
      infrastructureId,
      employeeId: employee.id,
      executionScopes: scopes,
      gpuLimit: clampNumber(input.gpuLimit, 0, 256),
      concurrencyLimit: clampNumber(input.concurrencyLimit, 1, 32, 1),
      enabled: input.enabled !== false,
      approvalRequired: false,
      connectionStatus: infrastructure.status === "available" ? "available" : "pending_probe",
      executionStatus: input.enabled === false ? DISABLED_BY_EMPLOYEE : ADMIN_TEST_ONLY,
      createdAt: now,
      updatedAt: now,
      createdBy: session.name || session.email || "平台管理员",
    });

    return sendJson(res, 201, {
      ok: true,
      contractVersion: CONTRACT_VERSION,
      binding: safeBinding(binding, store.listInfrastructures(), employees),
    });
  }

  async function updateBinding(req, res, infrastructureId, bindingId) {
    const session = requireSession(req, res);
    if (!session) return null;
    if (!canManageInfrastructure(session)) return deny(res, sendJson);
    const infrastructure = store.getInfrastructure(infrastructureId);
    if (!infrastructure) return sendJson(res, 404, { ok: false, error: "runtime_infrastructure_not_found" });
    const binding = store.getBinding(bindingId);
    if (!binding || binding.infrastructureId !== infrastructureId) {
      return sendJson(res, 404, { ok: false, error: "runtime_infrastructure_binding_not_found" });
    }
    const input = await readJsonBody(req, 32 * 1024);
    const validation = validateBindingUpdateInput(input, binding);
    if (!validation.ok) return sendJson(res, 422, validation);

    const now = new Date().toISOString();
    const updated = store.updateBinding(bindingId, {
      ...binding,
      executionScopes: validation.executionScopes,
      gpuLimit: validation.gpuLimit,
      concurrencyLimit: validation.concurrencyLimit,
      enabled: validation.enabled,
      executionStatus: validation.enabled ? ADMIN_TEST_ONLY : DISABLED_BY_EMPLOYEE,
      updatedAt: now,
    });

    return sendJson(res, 200, {
      ok: true,
      contractVersion: CONTRACT_VERSION,
      binding: safeBinding(updated, store.listInfrastructures(), currentDigitalEmployeesList()),
    });
  }

  async function updateInfrastructure(req, res, infrastructureId) {
    const session = requireSession(req, res);
    if (!session) return null;
    if (!canManageInfrastructure(session)) return deny(res, sendJson);
    const current = store.getInfrastructure(infrastructureId);
    if (!current) return sendJson(res, 404, { ok: false, error: "runtime_infrastructure_not_found" });
    const input = await readJsonBody(req, 32 * 1024);
    if (hasRawCredentialInput(input)) {
      return sendJson(res, 422, {
        ok: false,
        error: "raw_credential_input_forbidden",
        message: "基础设施页面只接受服务端凭据引用，不能提交密码、私钥或任意命令。",
      });
    }
    const validation = validateInfrastructureInput(input);
    if (!validation.ok) return sendJson(res, 422, validation);

    const now = new Date().toISOString();
    const updated = store.updateInfrastructure(infrastructureId, {
      ...current,
      name: validation.name,
      kind: validation.kind,
      connectionRef: validation.connectionRef,
      cliAdapter: validation.cliAdapter,
      gpuTotal: validation.gpuTotal,
      gpuAvailable: validation.gpuAvailable,
      status: "pending_probe",
      statusLabel: "待联通测试",
      accountMasked: "",
      detectedGpuCount: 0,
      cliStatus: validation.kind === "cluster" ? "not_tested" : "not_applicable",
      cliAdapterDetected: "",
      probeMode: "",
      lastProbeAt: "",
      lastProbeSummary: "连接设置已更新，等待管理员发起只读联通测试。",
      updatedAt: now,
    });
    store.updateBindingsForInfrastructure(infrastructureId, (binding) => ({
      ...binding,
      connectionStatus: "pending_probe",
      executionStatus: binding.enabled === false ? DISABLED_BY_EMPLOYEE : ADMIN_TEST_ONLY,
      updatedAt: now,
    }));

    return sendJson(res, 200, {
      ok: true,
      contractVersion: CONTRACT_VERSION,
      infrastructure: safeInfrastructure(updated, store.listBindings(), currentDigitalEmployeesList()),
    });
  }

  async function probeInfrastructure(req, res, infrastructureId) {
    const session = requireSession(req, res);
    if (!session) return null;
    if (!canManageInfrastructure(session)) return deny(res, sendJson);
    const infrastructure = store.getInfrastructure(infrastructureId);
    if (!infrastructure) return sendJson(res, 404, { ok: false, error: "runtime_infrastructure_not_found" });
    const result = await probe.probe(infrastructure);
    const now = new Date().toISOString();
    const updated = store.updateInfrastructure(infrastructureId, (current) => result.ok
      ? {
          ...current,
          status: "available",
          statusLabel: "设施可用",
          accountMasked: result.accountMasked || current.accountMasked,
          detectedGpuCount: Number(result.detectedGpuCount || 0),
          cliStatus: result.cliStatus || current.cliStatus,
          cliAdapterDetected: result.cliAdapter || current.cliAdapterDetected,
          probeMode: result.probeMode || "server_side_read_only_ssh",
          lastProbeAt: now,
          lastProbeSummary: result.summary || "只读联通探测通过。",
          updatedAt: now,
        }
      : {
          ...current,
          status: "blocked",
          statusLabel: "联通失败",
          cliStatus: current.kind === "cluster" ? "unavailable" : "not_applicable",
          lastProbeAt: now,
          lastProbeSummary: result.message || "只读联通探测失败。",
          updatedAt: now,
        });
    store.updateBindingsForInfrastructure(infrastructureId, (binding) => ({
      ...binding,
      connectionStatus: result.ok ? "available" : "blocked",
      executionStatus: binding.enabled === false ? DISABLED_BY_EMPLOYEE : ADMIN_TEST_ONLY,
      updatedAt: now,
    }));

    return sendJson(res, result.ok ? 200 : 422, {
      ok: result.ok,
      contractVersion: CONTRACT_VERSION,
      error: result.ok ? undefined : result.code,
      infrastructure: safeInfrastructure(updated, store.listBindings(), currentDigitalEmployeesList()),
      message: result.ok
        ? "基础设施只读联通测试通过；管理员可继续核对集群和运行条件。"
        : result.message || "基础设施只读联通测试失败。",
    });
  }

  function canManageInfrastructure(session) {
    const permissions = session?.permissions || [];
    return session?.role === "admin" || hasPermission(permissions, "system:*") || hasPermission(permissions, "runtime-infrastructure:*");
  }

  function currentDigitalEmployeesList() {
    const employees = typeof getDigitalEmployees === "function" ? getDigitalEmployees() : digitalEmployees;
    return Array.isArray(employees) ? employees : digitalEmployees;
  }

  return { handle };
}

function validateBindingUpdateInput(input = {}, current = {}) {
  const scopesFromInput = Object.prototype.hasOwnProperty.call(input, "executionScopes");
  const scopes = scopesFromInput
    ? uniqueList(input.executionScopes).filter((scope) => EXECUTION_SCOPES.has(scope))
    : uniqueList(current.executionScopes).filter((scope) => EXECUTION_SCOPES.has(scope));
  if (!scopes.length) {
    return { ok: false, error: "execution_scope_required", message: "至少保留一个员工运行用途。" };
  }
  return {
    ok: true,
    enabled: Object.prototype.hasOwnProperty.call(input, "enabled") ? Boolean(input.enabled) : current.enabled !== false,
    executionScopes: scopes,
    gpuLimit: Object.prototype.hasOwnProperty.call(input, "gpuLimit")
      ? clampNumber(input.gpuLimit, 0, 256)
      : clampNumber(current.gpuLimit, 0, 256),
    concurrencyLimit: Object.prototype.hasOwnProperty.call(input, "concurrencyLimit")
      ? clampNumber(input.concurrencyLimit, 1, 32, 1)
      : clampNumber(current.concurrencyLimit, 1, 32, 1),
  };
}

function validateInfrastructureInput(input = {}) {
  const kind = cleanText(input.kind);
  const name = cleanText(input.name);
  const connectionRef = cleanText(input.connectionRef);
  const cliAdapter = cleanText(input.cliAdapter || "auto");
  if (!KINDS.has(kind)) return { ok: false, error: "runtime_infrastructure_kind_invalid" };
  if (name.length < 2 || name.length > 80) return { ok: false, error: "runtime_infrastructure_name_invalid", message: "请填写 2-80 个字符的设施名称。" };
  if (!connectionRef || connectionRef.length > 120 || connectionRef.startsWith("-") || /[\s\u0000-\u001f]/.test(connectionRef)) {
    return { ok: false, error: "runtime_infrastructure_connection_ref_invalid", message: "请填写有效的服务端 SSH 凭据引用。" };
  }
  if (kind === "cluster" && !CLI_ADAPTERS.has(cliAdapter)) {
    return { ok: false, error: "runtime_infrastructure_cli_invalid" };
  }
  return {
    ok: true,
    kind,
    name,
    connectionRef,
    cliAdapter: kind === "cluster" ? cliAdapter : "",
    gpuTotal: clampNumber(input.gpuTotal, 0, 1_024),
    gpuAvailable: clampNumber(input.gpuAvailable, 0, 1_024),
  };
}

function safeInfrastructure(infrastructure = {}, bindings = [], employees = []) {
  const matchingBindings = bindings.filter((binding) => binding.infrastructureId === infrastructure.id);
  const enabledBindings = matchingBindings.filter((binding) => binding.enabled !== false);
  const employeeById = new Map(employees.map((employee) => [employee.id, employee]));
  return {
    id: infrastructure.id,
    name: infrastructure.name,
    kind: infrastructure.kind,
    kindLabel: infrastructure.kind === "cluster" ? "集群" : "Remote",
    credentialStatus: infrastructure.connectionRef ? "服务端引用已登记" : "待登记",
    accountMasked: infrastructure.accountMasked || "待联通后回填",
    gpuTotal: Number(infrastructure.gpuTotal || 0),
    gpuAvailable: Number(infrastructure.gpuAvailable || 0),
    detectedGpuCount: Number(infrastructure.detectedGpuCount || 0),
    cliAdapter: infrastructure.cliAdapter || "",
    cliAdapterDetected: infrastructure.cliAdapterDetected || "",
    cliStatus: infrastructure.cliStatus || "not_applicable",
    status: infrastructure.status || "pending_probe",
    statusLabel: infrastructure.statusLabel || "待联通测试",
    lastProbeAt: infrastructure.lastProbeAt || "",
    lastProbeSummary: infrastructure.lastProbeSummary || "等待联通测试。",
    probeMode: infrastructure.probeMode || "",
    ownerLabel: infrastructure.ownerLabel || "",
    createdAt: infrastructure.createdAt || "",
    updatedAt: infrastructure.updatedAt || "",
    boundEmployeeCount: matchingBindings.length,
    enabledBindingCount: enabledBindings.length,
    disabledBindingCount: matchingBindings.length - enabledBindings.length,
    boundEmployeeNames: matchingBindings.map((binding) => {
      const name = employeeById.get(binding.employeeId)?.name || binding.employeeId;
      return binding.enabled === false ? `${name}（关闭）` : name;
    }).slice(0, 6),
  };
}

function safeBinding(binding = {}, infrastructures = [], employees = []) {
  const infrastructureById = new Map(infrastructures.map((infrastructure) => [infrastructure.id, infrastructure]));
  const employeeById = new Map(employees.map((employee) => [employee.id, employee]));
  const infrastructure = infrastructureById.get(binding.infrastructureId) || {};
  const employee = employeeById.get(binding.employeeId) || {};
  return {
    id: binding.id,
    infrastructureId: binding.infrastructureId,
    infrastructureName: infrastructure.name || binding.infrastructureId,
    infrastructureKind: infrastructure.kind || "",
    infrastructureStatus: infrastructure.status || binding.connectionStatus || "pending_probe",
    accountMasked: infrastructure.accountMasked || "待联通后回填",
    gpuTotal: Number(infrastructure.gpuTotal || 0),
    gpuAvailable: Number(infrastructure.gpuAvailable || 0),
    employeeId: binding.employeeId,
    employeeName: employee.name || binding.employeeId,
    executionScopes: uniqueList(binding.executionScopes),
    gpuLimit: Number(binding.gpuLimit || 0),
    concurrencyLimit: Number(binding.concurrencyLimit || 1),
    enabled: binding.enabled !== false,
    approvalRequired: false,
    connectionStatus: binding.connectionStatus || "pending_probe",
    executionStatus: binding.enabled === false ? DISABLED_BY_EMPLOYEE : normalizeExecutionStatus(binding.executionStatus),
    useStatusLabel: binding.enabled === false ? "已关闭" : "已启用",
    updatedAt: binding.updatedAt || binding.createdAt || "",
  };
}

function normalizeExecutionStatus(value) {
  const status = cleanText(value);
  if (status === DISABLED_BY_EMPLOYEE) return DISABLED_BY_EMPLOYEE;
  return status === "pending_human_review" || !status ? ADMIN_TEST_ONLY : status;
}

function hasRawCredentialInput(input = {}) {
  return ["password", "privateKey", "secret", "command", "remoteCommand", "sshConfig"].some((field) => Object.prototype.hasOwnProperty.call(input, field));
}

function cleanText(value) {
  return String(value || "").trim().slice(0, 240);
}

function uniqueList(value) {
  const seen = new Set();
  return (Array.isArray(value) ? value : []).map((item) => cleanText(item)).filter((item) => {
    if (!item || seen.has(item)) return false;
    seen.add(item);
    return true;
  });
}

function clampNumber(value, min, max, fallback = 0) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(number)));
}

function deny(res, sendJson) {
  return sendJson(res, 403, {
    ok: false,
    error: "runtime_infrastructure_admin_required",
    message: "运行基础设施登记、绑定和联通测试仅限平台管理员。",
  });
}
