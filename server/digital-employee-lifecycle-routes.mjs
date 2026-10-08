import { newerEmployeeVersion, nextEmployeeVersion } from "./digital-employee-department-change-routes.mjs";

const CONTRACT_VERSION = "digital-employee-lifecycle.v1";
const READINESS_CONTRACT_VERSION = "digital-employee-production-readiness.v1";
const ACTIVE_STATUSES = new Set(["在线", "试运行"]);
const DISABLED_STATUS = "停用";

export function createDigitalEmployeeLifecycleHandlers({
  getDigitalEmployees = () => [],
  hasPermission,
  readJsonBody,
  requireSession,
  sendJson,
  store,
}) {
  function handle(req, res, url) {
    const match = url.pathname.match(/^\/api\/digital-employees\/([^/]+)\/lifecycle$/);
    if (req.method === "PUT" && match) {
      return updateLifecycle(req, res, decodeURIComponent(match[1])).then(() => true);
    }
    return undefined;
  }

  async function updateLifecycle(req, res, employeeId) {
    const session = requireSession(req, res);
    if (!session) return null;
    const employee = getDigitalEmployees().find((item) => item.id === employeeId);
    if (!employee) return sendJson(res, 404, { ok: false, error: "digital_employee_not_found" });
    if (!canManageLifecycle(session)) {
      return sendJson(res, 403, {
        ok: false,
        error: "digital_employee_lifecycle_admin_required",
        message: "仅系统管理员可打开或关闭数字员工。",
      });
    }

    const input = await readJsonBody(req, 4 * 1024);
    if (typeof input.enabled !== "boolean") {
      return invalid(res, "digital_employee_lifecycle_enabled_required", "enabled 必须是布尔值。");
    }

    const enabled = input.enabled;
    const currentStatus = text(employee.status);
    const savedState = store.readState().lifecycleStates[employeeId] || {};
    if ((enabled && ACTIVE_STATUSES.has(currentStatus)) || (!enabled && currentStatus === DISABLED_STATUS)) {
      return sendJson(res, 200, {
        ok: true,
        contractVersion: CONTRACT_VERSION,
        digitalEmployee: employee,
        message: enabled ? "数字员工已处于打开状态。" : "数字员工已处于关闭状态。",
      });
    }

    let nextStatus;
    let resumeStatus;
    if (enabled) {
      resumeStatus = ACTIVE_STATUSES.has(savedState.resumeStatus) ? savedState.resumeStatus : "";
      if (currentStatus !== DISABLED_STATUS || !resumeStatus) {
        return invalid(res, "digital_employee_lifecycle_resume_not_allowed", "该员工没有可恢复的已审批运行状态。");
      }
      if (!hasConfiguredModelBinding(employee)) {
        return sendJson(res, 409, {
          ok: false,
          error: "digital_employee_model_binding_required",
          message: "请先在“更多 → 运行”中绑定并保存模型，再打开该数字员工。",
        });
      }
      nextStatus = resumeStatus;
    } else {
      if (!ACTIVE_STATUSES.has(currentStatus)) {
        return invalid(res, "digital_employee_lifecycle_stop_not_allowed", "只能关闭当前在线或试运行的数字员工。");
      }
      resumeStatus = currentStatus;
      nextStatus = DISABLED_STATUS;
    }

    const changedAt = new Date().toISOString();
    const saved = store.saveLifecycleState(employeeId, {
      employeeId,
      enabled,
      status: nextStatus,
      resumeStatus,
      baseVersion: text(employee.version),
      version: nextEmployeeVersion(employee.version, changedAt),
      changedAt,
      changedBy: safeActor(session),
      source: "admin_applied_lifecycle_control",
    });
    if (!saved.ok) {
      return sendJson(res, 503, {
        ok: false,
        error: "digital_employee_lifecycle_store_unavailable",
        message: "数字员工状态未能保存，请稍后重试。",
      });
    }

    const digitalEmployee = withLifecycleStates([employee])[0];
    return sendJson(res, 200, {
      ok: true,
      contractVersion: CONTRACT_VERSION,
      digitalEmployee,
      message: enabled ? "数字员工已打开。" : "数字员工已关闭，新会话和调用已停止。",
    });
  }

  function withLifecycleStates(employees = []) {
    const lifecycleStates = store.readState().lifecycleStates;
    return employees.map((employee) => {
      const state = lifecycleStates[employee.id];
      const baseStatus = text(state?.status || employee.status);
      const productionReadiness = buildDigitalEmployeeProductionReadiness(employee);
      const status = derivedLifecycleStatus(baseStatus, productionReadiness);
      if (!state?.status && !productionReadiness.managed) return employee;
      return {
        ...employee,
        status,
        version: newerEmployeeVersion(employee.version, state?.version),
        productionReadiness,
        ...(state?.status ? {
          lifecycleControl: {
            enabled: state.enabled === true,
            status,
            baseStatus,
            resumeStatus: state.resumeStatus,
            baseVersion: state.baseVersion,
            changedAt: state.changedAt,
            changedBy: state.changedBy,
            source: state.source,
          },
        } : {}),
      };
    });
  }

  function canManageLifecycle(session = {}) {
    const permissions = session.permissions || [];
    return session.role === "admin" || hasPermission(permissions, "system:*") || hasPermission(permissions, "digital-employees:lifecycle");
  }

  function invalid(res, error, message) {
    return sendJson(res, 422, { ok: false, error, message });
  }

  return { handle, withLifecycleStates };
}

export function buildDigitalEmployeeProductionReadiness(employee = {}) {
  const managed = Boolean(
    employee.productionReadiness?.managed === true ||
    employee.productionEffect === "none" ||
    employee.mvpPersonnelApproval,
  );
  if (!managed) {
    return {
      contractVersion: READINESS_CONTRACT_VERSION,
      managed: false,
      status: "not_managed",
      autoOnlineEligible: false,
      gates: [],
      blockingGates: [],
    };
  }

  const employeeRoute = `#employees/${encodeURIComponent(text(employee.id))}`;
  const gates = [
    readinessGate({
      id: "personnel_approval",
      label: "人员审批",
      passed: employee.mvpPersonnelApproval?.status === "personnel_approval_passed",
      detail: "人员审批通过后先进入试运行。",
      actionLabel: "打开技能/员工评审",
      actionRoute: "#skill-employee-review",
    }),
    readinessGate({
      id: "accountable_owner",
      label: "责任归属",
      passed: hasAccountableOwner(employee),
      detail: "需要明确业务 Owner、技术 Owner 和告警责任。",
      actionLabel: "查看员工归属",
      actionRoute: employeeRoute,
    }),
    readinessGate({
      id: "model_binding",
      label: "模型绑定",
      passed: hasConfiguredModelBinding(employee),
      detail: "员工需要已应用的模型配置。",
      actionLabel: "打开运行配置",
      actionRoute: employeeRoute,
    }),
    readinessGate({
      id: "agent_runtime",
      label: "Agent Runtime",
      passed: hasAgentRuntimeBinding(employee),
      detail: "中心尚未为该数字员工分配运行实例。",
      actionLabel: "打开运行配置",
      actionRoute: employeeRoute,
    }),
    ...declaredResponsibilityGates(employee),
    ...declaredSkillGates(employee, employeeRoute),
    ...declaredToolGates(employee, employeeRoute),
    ...declaredScheduleGates(employee, employeeRoute),
    ...declaredChannelGates(employee, employeeRoute),
    ...explicitReadinessGates(employee.productionReadiness?.source === "derived" ? [] : employee.productionReadiness?.gates, employeeRoute),
  ];
  const dedupedGates = [];
  const seenGateIds = new Set();
  gates.forEach((gate) => {
    if (seenGateIds.has(gate.id)) return;
    seenGateIds.add(gate.id);
    dedupedGates.push(gate);
  });
  const blockingGates = dedupedGates.filter((gate) => gate.status !== "passed");
  return {
    contractVersion: READINESS_CONTRACT_VERSION,
    source: "derived",
    managed: true,
    status: blockingGates.length ? "blocked" : "ready_for_online",
    autoOnlineEligible: blockingGates.length === 0,
    gates: dedupedGates,
    blockingGates,
    nextGate: blockingGates[0]?.detail || "全部声明门禁已通过，生命周期可收敛为在线。",
  };
}

function derivedLifecycleStatus(baseStatus, readiness = {}) {
  if (!readiness.managed || !ACTIVE_STATUSES.has(baseStatus)) return baseStatus;
  return readiness.autoOnlineEligible ? "在线" : "试运行";
}

function readinessGate({ id, label, passed, detail, actionLabel, actionRoute }) {
  return {
    id,
    label,
    status: passed ? "passed" : "pending",
    detail,
    actionLabel,
    actionRoute,
  };
}

function hasAccountableOwner(employee = {}) {
  const owner = text(employee.ownerUserId || employee.owner);
  const department = text(employee.ownerDepartmentId || employee.departmentId);
  return Boolean(owner && department && !/(待|未指定|pending|unknown)/i.test(`${owner} ${department}`));
}

function hasAgentRuntimeBinding(employee = {}) {
  return Boolean(text(employee.runtimeBinding?.runtimeAdapter) && text(employee.runtimeBinding?.agentRuntimeId));
}

function declaredResponsibilityGates(employee = {}) {
  const source = employee.responsibilityAssignments;
  if (!source) {
    return [readinessGate({
      id: "responsibility:contract",
      label: "责任人登记",
      passed: false,
      detail: "业务 Owner、技术 Owner、平台质量审核人和告警接收人尚未结构化登记。",
      actionLabel: "配置责任分工",
      actionRoute: "#employee-responsibilities",
    })];
  }
  const roleDefinitions = [
    ["businessOwner", "业务 Owner"],
    ["technicalOwner", "技术 Owner"],
    ["qualityReviewer", "平台质量审核人"],
    ["alertReceiver", "告警接收人"],
  ];
  const assignments = Array.isArray(source)
    ? source
    : roleDefinitions.map(([role, label]) => ({ role, label, ...(source[role] && typeof source[role] === "object" ? source[role] : {}) }));
  return assignments
    .filter((assignment) => assignment?.requiredBeforeOnline !== false)
    .map((assignment, index) => {
      const role = text(assignment.role || assignment.id || `responsibility-${index + 1}`);
      const label = text(assignment.label || assignment.roleLabel || role);
      const passed = assignment.status === "assigned";
      return readinessGate({
        id: `responsibility:${role}`,
        label,
        passed,
        detail: passed ? `${label} 已登记。` : `${label} 尚未登记正式负责人。`,
        actionLabel: "配置责任分工",
        actionRoute: "#employee-responsibilities",
      });
    });
}

function declaredSkillGates(employee = {}, actionRoute = "") {
  const declared = cleanList(employee.mountedSkillHints);
  if (!declared.length) return [];
  const mounted = new Set(cleanList([...(employee.basicSkillIds || []), ...(employee.businessSkillIds || [])]));
  return declared.map((skillId) => readinessGate({
    id: `skill:${skillId}`,
    label: `Skill：${skillId}`,
    passed: mounted.has(skillId),
    detail: mounted.has(skillId) ? "声明的 Skill 已挂载。" : "声明的 Skill 尚未完成挂载。",
    actionLabel: "打开 Skills",
    actionRoute,
  }));
}

function declaredToolGates(employee = {}, actionRoute = "") {
  const declared = Array.isArray(employee.catalogToolBindings) ? employee.catalogToolBindings : employee.toolBindings;
  if (!Array.isArray(declared) || !declared.length) return [];
  const effective = Array.isArray(employee.toolBindings) ? employee.toolBindings : [];
  return declared.filter((binding) => binding?.requiredForProduction === true).map((binding, index) => {
    const bindingId = text(binding.id || binding.toolId || binding.name || `tool-${index + 1}`);
    const passed = effective.some((candidate) => (
      toolBindingMatches(candidate, binding) &&
      candidate?.enabled === true &&
      /已生效|已启用|approved|applied|enabled|通过/i.test(text(candidate.status))
    ));
    return readinessGate({
      id: `tool:${bindingId}`,
      label: `Tool：${text(binding.name || bindingId)}`,
      passed,
      detail: passed ? "声明的 Tool 已通过动作级门禁。" : text(binding.reviewGate || "声明的 Tool 尚未完成动作级审批与联通门禁。"),
      actionLabel: "打开工具审批",
      actionRoute,
    });
  });
}

function declaredScheduleGates(employee = {}, actionRoute = "") {
  const schedules = Array.isArray(employee.catalogScheduleBindings)
    ? employee.catalogScheduleBindings
    : Array.isArray(employee.scheduleBindings)
      ? employee.scheduleBindings
      : [];
  const registered = Array.isArray(employee.runtimeSchedules) ? employee.runtimeSchedules : [];
  return schedules.filter((schedule) => schedule?.requiredForProduction === true).map((schedule, index) => {
    const scheduleId = text(schedule.id || schedule.taskId || `schedule-${index + 1}`);
    const matched = registered.find((candidate) => scheduleBindingMatches(candidate, schedule));
    const passed = matched?.enabled === true && matched?.reviewStatus === "approved" && matched?.registrationStatus === "applied" &&
      /已生效|approved|applied|enabled|通过/i.test(text(matched.status));
    return readinessGate({
      id: `schedule:${scheduleId}`,
      label: `Schedule：${scheduleId}`,
      passed,
      detail: passed
        ? "声明的 Schedule 已在权威登记库启用并通过运行门禁。"
        : text(schedule.reviewGate || "声明的 Schedule 尚未完成权威登记、lease、幂等、告警和停用门禁。"),
      actionLabel: "打开定时任务",
      actionRoute,
    });
  });
}

function scheduleBindingMatches(candidate = {}, declaration = {}) {
  const declaredId = text(declaration.id || declaration.scheduleId);
  const declaredTaskId = text(declaration.taskId || declaration.taskDefinitionId);
  return Boolean(
    declaredId && declaredTaskId &&
    text(candidate.id || candidate.scheduleId) === declaredId &&
    text(candidate.taskId || candidate.taskDefinitionId) === declaredTaskId,
  );
}

function declaredChannelGates(employee = {}, actionRoute = "") {
  const feishuDeclared = Boolean(
    employee.feishuApplicationEnabled ||
    employee.channelConfig?.feishu?.applicationEnabled ||
    employee.channelConfig?.feishu?.accessEnabled,
  );
  if (!feishuDeclared) return [];
  const evidence = employee.runtimeEvidence || {};
  const passed = evidence.statusSource === "real_conversation" && Boolean(text(evidence.lastSuccessfulConversationAt || evidence.testedAt));
  return [readinessGate({
    id: "channel:feishu_roundtrip",
    label: "飞书真实回环",
    passed,
    detail: passed ? "飞书已留下真实会话回环证据。" : "飞书注册、worker、事件订阅和真实消息回环需要全部通过。",
    actionLabel: "打开渠道配置",
    actionRoute,
  })];
}

function explicitReadinessGates(value, actionRoute = "") {
  if (!Array.isArray(value)) return [];
  return value.map((gate, index) => readinessGate({
    id: text(gate?.id || `declared-${index + 1}`),
    label: text(gate?.label || gate?.id || `声明门禁 ${index + 1}`),
    passed: gate?.status === "passed" || gate?.passed === true,
    detail: text(gate?.detail || gate?.nextGate || "员工声明的上线门禁尚未通过。"),
    actionLabel: text(gate?.actionLabel || "打开员工工作台"),
    actionRoute: text(gate?.actionRoute || actionRoute),
  })).filter((gate) => gate.id);
}

function toolBindingMatches(candidate = {}, declared = {}) {
  const candidateIds = new Set(cleanList([candidate.id, candidate.toolId, candidate.name]));
  return cleanList([declared.id, declared.toolId, declared.name]).some((id) => candidateIds.has(id));
}

function cleanList(value) {
  const list = Array.isArray(value) ? value : [value];
  return [...new Set(list.map(text).filter(Boolean))];
}

function hasConfiguredModelBinding(employee = {}) {
  return Boolean(text(employee.modelBinding?.modelId || employee.modelBinding?.model));
}

function safeActor(session = {}) {
  return {
    id: text(session.employeeId || session.feishuUserId || session.employeeNo || session.name || "system-admin").slice(0, 120),
    role: text(session.role || "admin").slice(0, 80),
  };
}

function text(value) {
  return String(value || "").trim().replace(/[\u0000-\u001f]/g, "");
}
