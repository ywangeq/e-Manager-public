import { buildCapabilityCatalog } from "./control-plane-capability-catalog.mjs";
import { evaluateInvocationRequest } from "./control-plane-policy.mjs";
import { createManagedSandboxProfileHandlers } from "./control-plane/managed-sandbox-profile-routes.mjs";
import { createToolBindingHandlers } from "./control-plane/tool-binding-routes.mjs";

export function createControlPlaneHandlers({
  basicSkills,
  businessSkills,
  getBusinessSkills,
  capabilityRequests,
  cleanList,
  cleanText,
  digitalEmployees,
  getDigitalEmployees,
  distributionPlans,
  enterpriseTools = [],
  getEnterpriseTools = () => enterpriseTools,
  invocationPolicies,
  optionalSession,
  preReviewWorkers,
  qualityEvents,
  readJsonBody,
  sendJson,
  store,
  subsystemRegistry,
  toolResourceCatalogStore = null,
  applyCatalogFilters,
}) {
  const toolBindingHandlers = createToolBindingHandlers({
    applyCatalogFilters,
    cleanText,
    digitalEmployees,
    getDigitalEmployees,
    getEnterpriseTools,
    optionalSession,
    readJsonBody,
    sendJson,
    store,
  });
  const managedSandboxProfileHandlers = createManagedSandboxProfileHandlers({
    canManage: hasControlPlaneGovernance,
    optionalSession,
    sendJson,
  });

  function listToolResources(req, res, url) {
    const session = optionalSession(req);
    if (!session) {
      return sendJson(res, 401, {
        ok: false,
        error: "authentication_required",
        contractVersion: "governed-tool-resource-list.v1",
      });
    }
    const toolId = cleanText(url.searchParams.get("toolId") || "");
    const employeeId = cleanText(url.searchParams.get("employeeId") || "");
    if (!toolId || !getEnterpriseTools().some((tool) => tool.id === toolId)) {
      return sendJson(res, 404, {
        ok: false,
        error: "tool_asset_not_found",
        contractVersion: "governed-tool-resource-list.v1",
      });
    }
    const catalogs = toolResourceCatalogStore?.listCatalogs?.({ employeeId, toolId }) || [];
    return sendJson(res, 200, {
      ok: true,
      status: "ready",
      contractVersion: "governed-tool-resource-list.v1",
      toolId,
      catalogs,
      resourceCount: catalogs.reduce((total, catalog) => total + (catalog.resources?.length || 0), 0),
      sourceOfTruth: "backend_tool_resource_registry",
      canManage: hasControlPlaneGovernance(session),
      persistence: { kind: "server-managed-local-state", productionReady: false },
    });
  }

  function listSubsystems(res, url) {
    const items = applyCatalogFilters(currentSubsystems(), url, ["id", "departmentId", "businessDomain", "status"]);
    return sendJson(res, 200, {
      ok: true,
      status: "ready",
      contractVersion: "control-plane.v1",
      subsystems: items,
    });
  }

  async function registerSubsystem(req, res) {
    const session = optionalSession(req);
    if (!hasControlPlaneGovernance(session)) {
      return sendJson(res, 403, {
        ok: false,
        error: "control_plane_governance_required",
        contractVersion: "subsystem-registration.v1",
      });
    }
    const input = await readJsonBody(req);
    try {
      const subsystem = store.registerSubsystem(input, session);
      return sendJson(res, 201, {
        ok: true,
        status: "registered",
        contractVersion: "subsystem-registration.v1",
        subsystem,
      });
    } catch (error) {
      return sendJson(res, error.code === "unsafe_subsystem_payload" ? 422 : 400, {
        ok: false,
        error: error.code || error.message || "invalid_subsystem_registration",
        contractVersion: "subsystem-registration.v1",
      });
    }
  }

  async function updateSubsystemAssignment(req, res, subsystemId) {
    const session = optionalSession(req);
    if (!hasControlPlaneGovernance(session)) {
      return sendJson(res, 403, {
        ok: false,
        error: "control_plane_governance_required",
        contractVersion: "subsystem-assignment.v1",
      });
    }
    if (!store?.updateSubsystemAssignment) {
      return sendJson(res, 503, {
        ok: false,
        error: "control_plane_store_required",
        contractVersion: "subsystem-assignment.v1",
      });
    }
    const input = await readJsonBody(req);
    const result = store.updateSubsystemAssignment(subsystemId, input, session);
    return sendJson(res, result.statusCode, result.body);
  }

  async function startSubsystemHandshake(req, res, subsystemId) {
    const session = optionalSession(req);
    if (!hasControlPlaneGovernance(session)) {
      return sendJson(res, 403, {
        ok: false,
        error: "control_plane_governance_required",
        contractVersion: "subsystem-handshake.v1",
      });
    }
    const input = await readJsonBody(req);
    const result = await store.startHandshake(subsystemId, input, session, {
      distributionPlans,
      invocationPolicies,
      ownerConfirmed: Boolean(input.ownerConfirmed),
    });
    return sendJson(res, result.statusCode, result.body);
  }

  async function confirmSubsystemHandshake(req, res, subsystemId, handshakeId) {
    const session = optionalSession(req);
    if (!hasControlPlaneGovernance(session)) {
      return sendJson(res, 403, {
        ok: false,
        error: "control_plane_governance_required",
        contractVersion: "subsystem-handshake.v1",
      });
    }
    const input = await readJsonBody(req);
    const result = store.confirmHandshake(subsystemId, handshakeId, input, session);
    return sendJson(res, result.statusCode, result.body);
  }

  function listCapabilityCatalog(req, res, url) {
    const currentCapabilityRequests = currentCapabilityRequestsList();
    const result = buildCapabilityCatalog({
      url,
      session: optionalSession(req),
      digitalEmployees: currentDigitalEmployeesList(),
      businessSkills: currentBusinessSkillsList(),
      basicSkills,
      capabilityRequests: currentCapabilityRequests,
      distributionPlans,
      invocationPolicies,
      subsystemRegistry: currentSubsystems(),
    });
    return sendJson(res, result.statusCode, result.body);
  }

  function listCapabilityRequests(res, url) {
    const items = applyCatalogFilters(currentCapabilityRequestsList(), url, [
      "sourceSystemId",
      "departmentId",
      "businessDomain",
      "status",
      "risk",
      "requestType",
    ]);
    return sendJson(res, 200, {
      ok: true,
      status: "ready",
      contractVersion: "capability-request.v1",
      capabilityRequests: items,
    });
  }

  async function createCapabilityRequest(req, res) {
    const input = await readJsonBody(req);
    const sourceSystemId = cleanText(input.sourceSystemId || input.systemId || "unknown-subsystem");
    const sourceRequestId = cleanText(input.sourceRequestId || "");
    if (isTestSourceRef(sourceRequestId)) {
      return sendJson(res, 422, {
        ok: false,
        error: "test_payload_not_accepted",
        contractVersion: "capability-request.v1",
        message: "测试、smoke、demo 请求不要写入控制面治理草案。",
      });
    }
    const departmentId = cleanText(input.departmentId || "unknown");
    const businessDomain = cleanText(input.businessDomain || "general");
    const requestedCapabilities = cleanList(input.requestedCapabilities || input.capabilities);
    const requestType = normalizeCapabilityRequestType(input.requestType || "business_digital_employee_application");
    const targetEmployeeId = requestType === "business_digital_employee_application"
      ? cleanText(input.targetEmployeeId || "pending-platform-match")
      : cleanText(input.targetEmployeeId || "");
    const targetSkillId = cleanText(input.targetSkillId || input.skillId || "");
    const targetSourceRef = cleanText(input.targetSourceRef || "");
    const customCapability = sanitizeCustomCapability(input.customCapability || input.capability || {});
    const draftId = `CPR-${sourceSystemId.toUpperCase().replace(/[^A-Z0-9]+/g, "-")}-${Date.now()}`;
    const targetEmployee = targetEmployeeId
      ? currentDigitalEmployeesList().find((employee) => employee.id === targetEmployeeId)
      : null;
    const targetSkill = targetSkillId
      ? [...basicSkills, ...currentBusinessSkillsList()].find((skill) => skill.id === targetSkillId)
      : null;
    const capabilityDisplay = capabilityDisplayForRequest({ requestType, targetEmployee, targetSkill, customCapability, input });

    if (targetEmployee?.level === "系统级") {
      return sendJson(res, 422, {
        ok: false,
        error: "system_digital_employee_not_requestable",
        contractVersion: "capability-request.v1",
        message: "系统级数字员工只承担平台治理、预审核和归档职责，不能被子系统申请调度。",
      });
    }

    if (requestType === "platform_skill_application" && !targetSkillId) {
      return sendJson(res, 422, {
        ok: false,
        error: "target_skill_required",
        contractVersion: "capability-request.v1",
      });
    }

    const now = new Date().toISOString();
    const capabilityRequest = store.saveCapabilityRequest({
      id: draftId,
      sourceSystemId,
      sourceRequestId: sourceRequestId || draftId,
      requestType,
      requestTypeLabel: capabilityRequestTypeLabel(requestType),
      departmentId,
      businessDomain,
      requester: cleanText(input.requester || sourceSystemId),
      ownerHint: cleanText(input.ownerHint || ""),
      capabilityName: capabilityDisplay.name,
      capabilityKind: capabilityDisplay.kind,
      targetEmployeeId: requestType === "business_digital_employee_application" ? targetEmployeeId : "",
      targetEmployeeName: targetEmployee?.name || "",
      targetSkillId,
      targetSkillName: targetSkill?.name || cleanText(input.targetSkillName || ""),
      targetSourceRef: targetSourceRef || sourceRefForCapability({ requestType, targetEmployee, targetSkill, customCapability }),
      sourceAlignment: requestType === "custom_capability_ingestion" ? "create_new_source" : "update_existing_source",
      requestedCapabilities,
      safeSummary: cleanText(input.safeSummary || "子系统提交的数字员工能力申请，等待平台治理评审。"),
      risk: cleanText(input.riskHint || input.risk || "待评估"),
      status: "待平台评审",
      submittedAt: new Date(now).toLocaleString("zh-CN", { hour12: false, timeZone: "Asia/Shanghai" }),
      updatedAt: now,
      reviewGate: reviewGateForCapabilityRequest(requestType),
      preReview: buildPreReviewDraft(requestType),
      customCapability,
      warnings: [
        "MVP endpoint writes a local backend review draft only.",
        "Raw prompts, AI payloads, execution records, credentials, customer data, and employee PII are not accepted.",
        "System-level digital employees are platform governance workers and are not requestable by subsystems.",
      ],
      tags: ["mvp-control-plane-draft"],
    });

    return sendJson(res, 202, {
      ok: true,
      status: "pending_review",
      contractVersion: "capability-request.v1",
      capabilityRequest,
    });
  }

  function listDistributions(res, url) {
    const items = applyCatalogFilters(distributionPlans, url, [
      "sourceSystemId",
      "targetSystemId",
      "departmentId",
      "businessDomain",
      "sourceEmployeeId",
      "status",
    ]);
    return sendJson(res, 200, {
      ok: true,
      status: "ready",
      contractVersion: "distribution.v1",
      distributions: items,
    });
  }

  function listSkillMountRequests(req, res, url) {
    const session = optionalSession(req);
    if (!session) {
      return sendJson(res, 401, {
        ok: false,
        error: "authentication_required",
        contractVersion: "skill-mount-change-request.v1",
      });
    }
    const canReviewAll = hasBusinessSystemReviewAccess(session) || hasSkillMountGovernance(session);
    const actorKeys = new Set([session.employeeId, session.email, session.feishuUserId].filter(Boolean));
    const departmentId = cleanText(session.departmentId || "");
    const visibleItems = currentSkillMountRequestsList().filter((request) => {
      if (canReviewAll) return true;
      if (departmentId && request.departmentId === departmentId) return true;
      return actorKeys.has(request.requestedBy?.id);
    });
    const items = applyCatalogFilters(visibleItems, url, [
      "action",
      "status",
      "employeeId",
      "skillId",
      "departmentId",
      "requestMode",
    ]);
    return sendJson(res, 200, {
      ok: true,
      status: "ready",
      contractVersion: "skill-mount-change-request.v1",
      canManage: hasSkillMountGovernance(session),
      skillMountRequests: items,
    });
  }

  async function createSkillMountRequest(req, res) {
    const session = optionalSession(req);
    if (!session) {
      return sendJson(res, 401, {
        ok: false,
        error: "authentication_required",
        contractVersion: "skill-mount-change-request.v1",
      });
    }
    const input = await readJsonBody(req);
    const action = cleanText(input.action || "mount");
    if (!["mount", "unmount"].includes(action)) {
      return sendJson(res, 400, {
        ok: false,
        error: "unsupported_skill_mount_action",
        contractVersion: "skill-mount-change-request.v1",
      });
    }
    const employee = currentDigitalEmployeesList().find((item) => item.id === cleanText(input.employeeId));
    const skillMatch = findSkillForMount(input.skillId);
    if (!employee || !skillMatch?.skill) {
      return sendJson(res, 404, {
        ok: false,
        error: employee ? "skill_not_found" : "digital_employee_not_found",
        contractVersion: "skill-mount-change-request.v1",
      });
    }
    if (employee.level === "系统级" && !hasSkillMountGovernance(session)) {
      return sendJson(res, 403, {
        ok: false,
        error: "system_employee_mount_governance_required",
        contractVersion: "skill-mount-change-request.v1",
      });
    }
    if (hasUnsafeText([input.reason, input.impactSummary, input.rollbackPlan])) {
      return sendJson(res, 422, {
        ok: false,
        error: "unsafe_skill_mount_request",
        contractVersion: "skill-mount-change-request.v1",
      });
    }

    const isAdminOverride = hasSkillMountGovernance(session);
    const now = new Date().toISOString();
    const requestId = `SMR-${employee.id.toUpperCase().replace(/[^A-Z0-9]+/g, "-")}-${Date.now()}`;
    const request = store.saveSkillMountRequest(buildSkillMountRequest({
      id: requestId,
      action,
      employee,
      skill: skillMatch.skill,
      skillKind: skillMatch.kind,
      input,
      isAdminOverride,
      session,
      now,
    }));

    return sendJson(res, isAdminOverride ? 200 : 202, {
      ok: true,
      status: isAdminOverride ? "applied" : "pending_review",
      contractVersion: "skill-mount-change-request.v1",
      skillMountRequest: request,
      warnings: request.warnings,
    });
  }

  async function decideSkillMountRequest(req, res, requestId) {
    const session = optionalSession(req);
    if (!hasSkillMountGovernance(session)) {
      return sendJson(res, 403, {
        ok: false,
        error: "skill_mount_governance_required",
        contractVersion: "skill-mount-change-request.v1",
      });
    }
    const request = currentSkillMountRequestsList().find((item) => item.id === cleanText(requestId));
    if (!request) {
      return sendJson(res, 404, {
        ok: false,
        error: "skill_mount_request_not_found",
        contractVersion: "skill-mount-change-request.v1",
      });
    }
    const input = await readJsonBody(req);
    const decision = cleanText(input.decision || "");
    if (!["approved", "rejected"].includes(decision)) {
      return sendJson(res, 400, {
        ok: false,
        error: "skill_mount_decision_required",
        contractVersion: "skill-mount-change-request.v1",
      });
    }
    const now = new Date().toISOString();
    const saved = store.saveSkillMountRequest({
      ...request,
      status: decision === "approved" ? "已生效" : "已驳回",
      decision: {
        decision,
        decidedAt: now,
        decidedBy: session,
        notes: cleanText(input.notes || input.safeNotes || ""),
      },
      reviewGate: decision === "approved"
        ? "管理员已确认挂载变更；后续 badcase/eval 通过 mountActionId 归因。"
        : "已退回申请人补齐 owner、回滚、依赖或归因测试材料。",
      updatedAt: now,
    });
    return sendJson(res, 200, {
      ok: true,
      status: decision === "approved" ? "applied" : "rejected",
      contractVersion: "skill-mount-change-request.v1",
      skillMountRequest: saved,
    });
  }

  function currentSubsystems() {
    return store ? store.readSubsystems() : subsystemRegistry;
  }

  function currentCapabilityRequestsList() {
    return store ? store.readCapabilityRequests() : capabilityRequests;
  }

  function currentBusinessSkillsList() {
    return typeof getBusinessSkills === "function" ? getBusinessSkills() : businessSkills;
  }

  function currentDigitalEmployeesList() {
    return typeof getDigitalEmployees === "function" ? getDigitalEmployees() : digitalEmployees;
  }

  function currentQualityEventsList() {
    return store ? store.readQualityEvents() : qualityEvents;
  }

  function currentSkillMountRequestsList() {
    return store?.readSkillMountRequests ? store.readSkillMountRequests() : [];
  }

  function hasControlPlaneGovernance(session) {
    const permissions = new Set(session?.permissions || []);
    return (
      session?.role === "admin" ||
      permissions.has("system:*") ||
      permissions.has("control-plane:*") ||
      permissions.has("subsystems:review")
    );
  }

  function hasQualityGovernance(session) {
    const permissions = new Set(session?.permissions || []);
    return (
      session?.role === "admin" ||
      permissions.has("system:*") ||
      permissions.has("quality-reviews:*") ||
      permissions.has("badcases:*") ||
      permissions.has("control-plane:*")
    );
  }

  function hasBusinessSystemReviewAccess(session) {
    return hasControlPlaneGovernance(session) || hasQualityGovernance(session);
  }

  function hasSkillMountGovernance(session) {
    const permissions = new Set(session?.permissions || []);
    return (
      session?.role === "admin" ||
      permissions.has("system:*") ||
      permissions.has("digital-employees:*") ||
      permissions.has("business-skills:*") ||
      permissions.has("control-plane:*")
    );
  }

  function normalizeCapabilityRequestType(value) {
    const requestType = cleanText(value || "business_digital_employee_application");
    const aliases = {
      digital_employee_application: "business_digital_employee_application",
      skill_application: "platform_skill_application",
      custom_capability: "custom_capability_ingestion",
    };
    return aliases[requestType] || requestType;
  }

  function capabilityRequestTypeLabel(requestType) {
    return {
      business_digital_employee_application: "业务数字员工申请",
      platform_skill_application: "主系统 Skill 申请",
      custom_capability_ingestion: "子系统自定义能力归纳",
    }[requestType] || requestType;
  }

  function reviewGateForCapabilityRequest(requestType) {
    return {
      business_digital_employee_application: "平台管理员 + 业务 owner 确认员工版本、调用动作、隐私边界和回滚策略",
      platform_skill_application: "Skill owner + 平台质量审核确认版本 pin、调用动作、证据边界和回滚策略",
      custom_capability_ingestion: "系统级预审核 AI worker 检查 source 对齐、隐私边界、版本意图和 eval 候选后，等待平台人工确认",
    }[requestType] || "平台管理员 + 业务 owner 确认能力范围、版本、隐私边界和回滚策略";
  }

  function capabilityDisplayForRequest({ requestType, targetEmployee, targetSkill, customCapability, input }) {
    if (requestType === "business_digital_employee_application") {
      return {
        name: cleanText(input.capabilityName || targetEmployee?.name || input.targetEmployeeName || input.targetEmployeeId || "待匹配业务数字员工"),
        kind: "业务数字员工",
      };
    }
    if (requestType === "platform_skill_application") {
      const skillKind = targetSkill?.domain ? "主系统业务 Skill" : "主系统基础 Skill";
      return {
        name: cleanText(input.capabilityName || targetSkill?.name || input.targetSkillName || input.targetSkillId || "待匹配 Skill"),
        kind: skillKind,
      };
    }
    if (requestType === "custom_capability_ingestion") {
      return {
        name: cleanText(input.capabilityName || customCapability.name || customCapability.id || "待归纳自定义能力"),
        kind: customCapabilityKindLabel(customCapability.capabilityType),
      };
    }
    return {
      name: cleanText(input.capabilityName || input.targetEmployeeName || input.targetSkillName || input.targetEmployeeId || input.targetSkillId || "待匹配能力"),
      kind: capabilityRequestTypeLabel(requestType),
    };
  }

  function customCapabilityKindLabel(value) {
    return {
      business_digital_employee_candidate: "候选业务数字员工",
      business_skill_candidate: "候选业务 Skill",
      platform_basic_skill_candidate: "候选基础 Skill",
    }[value] || "候选自定义能力";
  }

  function sourceRefForCapability({ requestType, targetEmployee, targetSkill, customCapability }) {
    if (requestType === "business_digital_employee_application" && targetEmployee) {
      return `platform.businessEmployee:${targetEmployee.id}@${targetEmployee.version}`;
    }
    if (requestType === "platform_skill_application" && targetSkill) {
      const kind = targetSkill.domain ? "businessSkill" : "basicSkill";
      return `platform.${kind}:${targetSkill.id}@${targetSkill.version}`;
    }
    if (requestType === "custom_capability_ingestion") {
      return customCapability.sourceRef || `subsystem.customCapability:${customCapability.id || "pending"}`;
    }
    return "";
  }

  function findSkillForMount(skillId) {
    const id = cleanText(skillId);
    const basicSkill = basicSkills.find((skill) => skill.id === id);
    if (basicSkill) return { skill: basicSkill, kind: "platform_basic_skill" };
    const businessSkill = currentBusinessSkillsList().find((skill) => skill.id === id);
    if (businessSkill) return { skill: businessSkill, kind: "business_skill" };
    return null;
  }

  function buildSkillMountRequest({ id, action, employee, skill, skillKind, input, isAdminOverride, session, now }) {
    const mountedBefore = isSkillMountedForEmployee(employee, skill, skillKind);
    const actionLabel = action === "unmount" ? "取消挂载" : "挂载";
    const dependencyClosure = dependencyClosureForSkill(skill);
    const affectedDistributions = distributionPlans
      .filter((plan) =>
        plan.sourceEmployeeId === employee.id ||
        (plan.targetEmployeeIds || []).includes(employee.id) ||
        (plan.targetSkillIds || []).includes(skill.id),
      )
      .map((plan) => ({ id: plan.id, targetSystemId: plan.targetSystemId, status: plan.status }));
    const missingItems = [];
    if (action === "unmount" && !mountedBefore) missingItems.push("当前目录未显示该 Skill 已挂载，需确认是否为下游分发或运行时覆盖关系。");
    if (action === "mount" && mountedBefore) missingItems.push("当前目录已显示该 Skill 已挂载，需确认是否为版本 pin 或重复申请。");
    if (!input.rollbackPlan) missingItems.push("回滚策略待补齐");
    if (!input.impactSummary) missingItems.push("影响范围待补齐");
    const status = isAdminOverride ? "已生效" : "待管理员审核";
    const requestMode = isAdminOverride ? "admin_override" : "approval_required";
    const riskLevel = cleanText(input.riskLevel || skill.risk || (skillKind === "business_skill" ? "中" : "低"));

    return {
      id,
      action,
      actionLabel,
      mountActionId: `MNT-${employee.id.toUpperCase().replace(/[^A-Z0-9]+/g, "-")}-${Date.now()}`,
      requestMode,
      status,
      employeeId: employee.id,
      employeeName: employee.name,
      employeeVersion: employee.version,
      employeeLevel: employee.level,
      skillId: skill.id,
      skillApiId: skill.skillApiId || skill.id,
      sourceSkillId: skill.sourceSkillId || `catalog:${skill.id}`,
      skillName: skill.name,
      skillVersion: skill.version,
      skillKind,
      departmentId: employee.ownerDepartmentId || employee.departmentId || skill.departmentId || "",
      requestedBy: session,
      requestedRole: isAdminOverride ? "管理员直通" : "申请人",
      reason: cleanText(input.reason || `${actionLabel} ${employee.name} / ${skill.name}`),
      riskLevel,
      safeSummary: `${actionLabel} ${employee.name} 的 ${skill.name} Skill 依赖；当前仅写入控制面 MVP 台账，不写生产目录。`,
      impactSummary: cleanText(input.impactSummary || `${employee.name} 的运行依赖、输出契约和调用门禁可能受影响。`),
      rollbackPlan: cleanText(input.rollbackPlan || "回退到上一组已生效挂载关系，并用 mountActionId 关联 badcase/eval 复盘。"),
      reviewGate: isAdminOverride
        ? "管理员直通已记录；后续 badcase/eval 仍需通过 mountActionId 归因。"
        : "平台管理员 + 员工 owner + Skill owner 复核后生效；不得绕过质量门禁。",
      precheck: {
        status: missingItems.length ? "completed_with_findings" : "completed",
        checkedAt: now,
        mountedBefore,
        skillReviewStatus: skill.status,
        employeeStatus: employee.status,
        ownerAlignment: ownerAlignmentForMount(employee, skill, skillKind),
        dependencyStatus: dependencyClosure.length ? `${dependencyClosure.length} 个依赖/引用需随同确认` : "无显式依赖闭包",
        attributionRequired: true,
        findings: [
          `${skillKind === "platform_basic_skill" ? "基础 Skill" : "专项业务 Skill"} ${skill.name} / ${skill.version}`,
          mountedBefore ? "目录显示当前已挂载" : "目录显示当前未挂载",
          affectedDistributions.length ? `影响 ${affectedDistributions.length} 个分发映射` : "暂无已登记分发映射",
        ],
        missingItems,
      },
      attributionPlan: {
        ...(input.attributionPlan || {}),
        expectedImpact: cleanText(input.expectedImpact || input.attributionPlan?.expectedImpact || ""),
        regressionCandidates: cleanList(input.regressionCandidates || input.attributionPlan?.regressionCandidates),
      },
      dependencyClosure,
      affectedDistributions,
      decision: isAdminOverride
        ? {
            decision: "admin_override_applied",
            decidedAt: now,
            decidedBy: session,
            notes: cleanText(input.notes || "管理员直通挂载变更，保留归因记录。"),
          }
        : null,
      warnings: [
        "MVP 仅写入本地控制面治理台账，不修改生产目录、运行时或 provider lease。",
        "挂载/取消挂载改变数字员工运行依赖，后续质量事件必须携带 mountActionId 或关联该记录。",
        ...missingItems,
      ],
      tags: ["mvp-skill-mount-change", requestMode],
      submittedAt: new Date(now).toLocaleString("zh-CN", { hour12: false, timeZone: "Asia/Shanghai" }),
      updatedAt: now,
    };
  }

  function isSkillMountedForEmployee(employee, skill, skillKind) {
    const ids = skillKind === "platform_basic_skill" ? employee.basicSkillIds : employee.businessSkillIds;
    return (ids || []).includes(skill.id);
  }

  function dependencyClosureForSkill(skill) {
    return cleanList([
      ...(skill.mountedBasicSkills || []),
      ...(skill.linkedSkillIds || []),
      ...(skill.dependencySkillIds || []),
      ...(skill.apiDependencySkillIds || []),
      ...(skill.referenceSkillIds || []),
      ...(skill.packageBundleSkillIds || []),
    ]);
  }

  function ownerAlignmentForMount(employee, skill, skillKind) {
    if (skillKind === "platform_basic_skill") return "平台基础 Skill 可复用，仍需确认员工 owner 和调用门禁。";
    if (skill.departmentId && employee.departmentId && skill.departmentId === employee.departmentId) return "同部门 owner 范围";
    if (skill.ownerDepartmentId && employee.ownerDepartmentId && skill.ownerDepartmentId === employee.ownerDepartmentId) return "同 ownerDepartmentId 范围";
    return "跨部门/跨 owner，需要人工复核";
  }

  async function runCapabilityPreReview(req, res) {
    if (!hasBusinessSystemReviewAccess(optionalSession(req))) {
      return sendJson(res, 403, {
        ok: false,
        error: "control_plane_governance_required",
        contractVersion: "capability-pre-review.v1",
      });
    }
    const input = await readJsonBody(req);
    const requestId = cleanText(input.requestId);
    const request = currentCapabilityRequestsList().find((item) => item.id === requestId);

    if (!request) {
      return sendJson(res, 404, {
        ok: false,
        error: "capability_request_not_found",
        contractVersion: "capability-pre-review.v1",
      });
    }

    return sendJson(res, 200, {
      ok: true,
      status: "completed",
      contractVersion: "capability-pre-review.v1",
      preReview: store.saveCapabilityRequest({
        ...request,
        preReview: buildCapabilityPreReviewResult(request),
        status: "AI 预审完成",
        updatedAt: new Date().toISOString(),
      }).preReview,
      warnings: [
        "LAN demo uses scrubbed request metadata only and does not call a real model provider.",
        "Production execution must run server-side with RBAC, credential lease, audit log, and persisted result.",
      ],
    });
  }

  async function decideCapabilityRequest(req, res, requestId) {
    const session = optionalSession(req);
    if (!hasControlPlaneGovernance(session)) {
      return sendJson(res, 403, {
        ok: false,
        error: "control_plane_governance_required",
        contractVersion: "capability-request-decision.v1",
      });
    }
    if (!store?.saveCapabilityRequest) {
      return sendJson(res, 503, {
        ok: false,
        error: "control_plane_store_required",
        contractVersion: "capability-request-decision.v1",
      });
    }

    const request = currentCapabilityRequestsList().find((item) => item.id === cleanText(requestId));
    if (!request) {
      return sendJson(res, 404, {
        ok: false,
        error: "capability_request_not_found",
        contractVersion: "capability-request-decision.v1",
      });
    }

    const input = await readJsonBody(req);
    const decision = cleanText(input.decision || "");
    if (!["approved", "rejected"].includes(decision)) {
      return sendJson(res, 400, {
        ok: false,
        error: "capability_request_decision_required",
        contractVersion: "capability-request-decision.v1",
      });
    }
    if (hasUnsafeText([input.notes, input.safeNotes])) {
      return sendJson(res, 422, {
        ok: false,
        error: "unsafe_capability_request_decision",
        contractVersion: "capability-request-decision.v1",
      });
    }

    const now = new Date().toISOString();
    const title = request.capabilityName || request.targetEmployeeName || request.targetSkillName || request.id;
    const isApproved = decision === "approved";
    const reviewDecision = {
      decision,
      status: isApproved ? "已通过审核" : "已退回补充",
      summary: isApproved
        ? `${title} 已通过平台人工审核，进入分发映射与调用策略确认。`
        : `${title} 已退回申请方补充隐私边界、回滚策略或 owner 确认。`,
      nextGate: isApproved ? "进入分发映射与调用策略确认" : "回到申请方或业务 owner 补充材料",
      decidedAt: now,
      decidedBy: session,
      notes: cleanText(input.notes || input.safeNotes || ""),
    };
    const saved = store.saveCapabilityRequest({
      ...request,
      status: reviewDecision.status,
      reviewDecision,
      updatedAt: now,
    });

    return sendJson(res, 200, {
      ok: true,
      status: isApproved ? "approved" : "rejected",
      contractVersion: "capability-request-decision.v1",
      capabilityRequest: saved,
      reviewDecision: saved.reviewDecision,
    });
  }

  function buildCapabilityPreReviewResult(request) {
    const worker = preReviewWorkers.find((item) => item.id === "capability-ingestion-precheck");
    const isCustom = request.requestType === "custom_capability_ingestion";
    const isSkill = request.requestType === "platform_skill_application";
    const findings = isCustom
      ? [
          "识别为子系统自定义候选能力，需要绑定 sourceRef、版本意图和 owner。",
          "输入/输出边界已提交安全摘要，但仍需补充 eval 样本和回滚策略。",
          "不得把 HR 本地 raw 简历、候选人标识、raw prompt 或完整 AI payload 回传主系统。",
        ]
      : isSkill
        ? [
            "识别为复用主系统 Skill 申请，需要确认版本 pin 和调用动作。",
            "证据来源只能走安全摘要，真实检索内容仍留在业务系统。",
            "需要 Skill owner 确认调用门禁、资源预算和回滚策略。",
          ]
        : [
            "识别为复用主系统业务数字员工申请，需要确认员工版本和业务动作边界。",
            "候选执行员工与候选 Skill 已进入映射复核。",
            "需要业务 owner 确认隐私边界、调用阈值和回滚策略。",
          ];
    const missingItems = isCustom
      ? ["eval 样本最小集", "输出字段 schema", "回滚策略", "owner 双确认"]
      : isSkill
        ? ["调用动作白名单", "Skill 版本 pin", "证据边界", "质量回流策略"]
        : ["员工版本 pin", "目标执行员工映射", "调用门禁阈值", "HR owner 确认"];
    const riskLevel = isCustom ? "medium" : "low_to_medium";

    return {
      status: "completed",
      executionMode: "demo_safe_summary",
      executedAt: new Date().toISOString(),
      executionId: `PRE-${request.id}-${Date.now()}`,
      workerId: worker?.id || "capability-ingestion-precheck",
      workerName: worker?.name || "能力归纳预审核员",
      workerEmployeeId: worker?.workerEmployeeId || "system-ingestion-agent",
      lane: worker?.lane || "capability_precheck",
      provider: worker?.provider || "codex",
      model: worker?.model || "gpt-5.5",
      recommendation: isCustom ? "manual_review_required" : "approve_after_owner_review",
      confidence: isCustom ? 0.76 : 0.84,
      riskLevel,
      efficiencyGain: "系统数字员工已完成安全摘要初筛，提交人只需补齐缺口项，平台审核人可直接按门禁复核。",
      fallbackSummary: `${request.capabilityName || request.id} 预审完成：${findings[0]}`,
      safeFindings: findings,
      missingItems,
      nextGate: isCustom ? "补齐 eval 样本和输出 schema 后进入平台人工确认" : "进入 owner 确认和调用/分发门禁复核",
      qualityRoute: {
        target: "质量管理",
        eventType: "pre_review_quality_signal",
        evalCandidate: isCustom,
        trackingKey: `quality.pre-review:${request.id}`,
        feedbackPolicy: "误放行、误阻断、缺口遗漏和高风险建议进入质量复盘，并作为 eval 回测候选。",
      },
      privacyBoundary: "仅使用 capabilityName、requestType、safeSummary、sourceRef、candidate ids 等安全摘要字段；不读取 raw 简历、raw prompt、模型 trace 或完整执行记录。",
    };
  }

  function buildPreReviewDraft(requestType) {
    if (!["custom_capability_ingestion", "platform_skill_application", "business_digital_employee_application"].includes(requestType)) {
      return null;
    }
    const worker = preReviewWorkers.find((item) => item.id === "capability-ingestion-precheck");
    return {
      status: requestType === "custom_capability_ingestion" ? "queued" : "not_required_for_existing_source",
      workerId: worker?.id || "capability-ingestion-precheck",
      workerName: worker?.name || "能力归纳预审核员",
      workerEmployeeId: worker?.workerEmployeeId || "system-ingestion-agent",
      lane: worker?.lane || "capability_precheck",
      autoEval: worker?.autoEvalPolicy || "planned",
      recommendation: requestType === "custom_capability_ingestion" ? "manual_review_after_precheck" : "source_alignment_review",
      safeFindings: requestType === "custom_capability_ingestion"
        ? ["新增类能力需要 sourceRef、版本意图、输入输出边界和 eval 候选", "预审核只生成建议，不自动上线"]
        : ["复用主系统已有源，后续更新必须绑定原始 sourceRef 和版本 pin"],
    };
  }

  function sanitizeCustomCapability(value) {
    const source = value && typeof value === "object" ? value : {};
    return {
      id: cleanText(source.id || source.capabilityId || ""),
      name: cleanText(source.name || ""),
      capabilityType: cleanText(source.capabilityType || "business_skill_candidate"),
      sourceRef: cleanText(source.sourceRef || ""),
      version: cleanText(source.version || ""),
      ownerHint: cleanText(source.ownerHint || ""),
      inputSummary: cleanText(source.inputSummary || ""),
      outputSummary: cleanText(source.outputSummary || ""),
      toolSummary: cleanText(source.toolSummary || ""),
      privacySummary: cleanText(source.privacySummary || "只提交脱敏能力说明，不提交 raw 数据。"),
    };
  }

  function listQualityEvents(res, url) {
    const items = applyCatalogFilters(currentQualityEventsList(), url, [
      "sourceSystemId",
      "departmentId",
      "businessDomain",
      "eventType",
      "entityId",
      "severity",
      "status",
      "errorCode",
      "rootCauseCategory",
    ]);
    return sendJson(res, 200, {
      ok: true,
      status: "ready",
      contractVersion: "quality-event.v1",
      qualityEvents: items,
    });
  }

  async function updateQualityReviewTask(req, res, eventId) {
    const input = await readJsonBody(req);
    const action = cleanText(input.action || "");
    const event = currentQualityEventsList().find((item) => item.id === cleanText(eventId));
    if (!event) {
      return sendJson(res, 404, {
        ok: false,
        error: "quality_event_not_found",
        contractVersion: "quality-review-task.v1",
      });
    }

    if (action !== "submit_evidence" && !hasQualityGovernance(optionalSession(req))) {
      return sendJson(res, 403, {
        ok: false,
        error: "quality_governance_required",
        contractVersion: "quality-review-task.v1",
      });
    }

    const result = applyQualityReviewAction(event, action, input, optionalSession(req));
    if (!result.ok) {
      return sendJson(res, result.statusCode || 400, {
        ok: false,
        error: result.error,
        contractVersion: "quality-review-task.v1",
      });
    }

    const qualityEvent = store.saveQualityEvent(result.qualityEvent);
    return sendJson(res, 200, {
      ok: true,
      status: qualityEvent.status,
      contractVersion: "quality-review-task.v1",
      qualityEvent,
      reviewTask: qualityEvent.reviewTask,
    });
  }

  function listInvocationPolicies(res, url) {
    const callerSystemId = url.searchParams.get("callerSystemId");
    const departmentId = url.searchParams.get("departmentId");
    const businessDomain = url.searchParams.get("businessDomain");
    const action = url.searchParams.get("action");
    const items = applyCatalogFilters(invocationPolicies, url, [
      "id",
      "employeeId",
      "skillId",
      "sourceSystemId",
      "status",
    ]).filter((policy) => {
      if (callerSystemId && !policy.allowedCallers?.includes(callerSystemId)) return false;
      if (departmentId && !policy.allowedDepartments?.includes(departmentId)) return false;
      if (businessDomain && !policy.allowedBusinessDomains?.includes(businessDomain)) return false;
      if (action && !policy.allowedActions?.includes(action)) return false;
      return true;
    });

    return sendJson(res, 200, {
      ok: true,
      status: "ready",
      contractVersion: "invocation-policy.v1",
      invocationPolicies: items,
    });
  }

  async function checkInvocationPolicy(req, res) {
    const input = await readJsonBody(req);
    const employeeId = cleanText(input.employeeId);
    const skillId = cleanText(input.skillId);
    const policy = invocationPolicies.find((item) =>
      item.employeeId === employeeId && (!skillId || item.skillId === skillId),
    );

    if (!policy) {
      return sendJson(res, 200, {
        ok: true,
        status: "rejected",
        contractVersion: "invocation-check.v1",
        decision: {
          outcome: "reject_and_log",
          reason: "no_invocation_policy",
          triggeredThresholds: [{
            name: "policy",
            expected: "registered employee/skill invocation policy",
            actual: { employeeId, skillId },
            outcome: "rejected",
          }],
        },
        warnings: ["No AI/model execution was started. This endpoint only evaluates the call gate."],
      });
    }

    const decision = evaluateInvocationRequest(policy, input, { cleanText });
    return sendJson(res, 200, {
      ok: true,
      status: decision.status,
      contractVersion: "invocation-check.v1",
      policyId: policy.id,
      employeeId: policy.employeeId,
      skillId: policy.skillId,
      decision,
      policySummary: {
        allowedCallers: policy.allowedCallers,
        allowedDepartments: policy.allowedDepartments,
        allowedBusinessDomains: policy.allowedBusinessDomains,
        allowedActions: policy.allowedActions,
        modelLimits: policy.modelLimits,
        fallback: policy.fallback,
        privacyBoundary: policy.privacyBoundary,
      },
      warnings: ["No AI/model execution was started. This endpoint only evaluates the call gate."],
    });
  }

  async function createQualityEvent(req, res) {
    const input = await readJsonBody(req);
    const sourceSystemId = cleanText(input.sourceSystemId || input.systemId || "unknown-subsystem");
    const sourceEventId = cleanText(input.sourceEventId || "");
    if (isTestSourceRef(sourceEventId)) {
      return sendJson(res, 422, {
        ok: false,
        error: "test_payload_not_accepted",
        contractVersion: "quality-event.v1",
        message: "测试、smoke、demo 质量事件不要写入控制面治理草案。",
      });
    }
    if (hasUnstableSourceRef(sourceEventId)) {
      return sendJson(res, 422, {
        ok: false,
        error: "stable_source_event_id_required",
        contractVersion: "quality-event.v1",
        message: "质量事件 sourceEventId 需要是稳定业务键或归档窗口键，不能只用当前时间戳。",
      });
    }
    const entityId = cleanText(input.entityId || "unknown-entity");
    const eventType = cleanText(input.eventType || "badcase_summary");
    const now = new Date().toISOString();
    const draftId = `QE-${sourceSystemId.toUpperCase().replace(/[^A-Z0-9]+/g, "-")}-${Date.now()}`;
    const qualityEvent = store.saveQualityEvent({
      id: draftId,
      sourceSystemId,
      sourceEventId: sourceEventId || draftId,
      eventType,
      occurredAt: cleanText(input.occurredAt || input.eventAt || input.createdAt || input.submittedAt || ""),
      reportedAt: cleanText(input.reportedAt || input.submittedAt || now),
      departmentId: cleanText(input.departmentId || "unknown"),
      businessDomain: cleanText(input.businessDomain || "general"),
      executionMode: cleanText(input.executionMode || "platform_hosted"),
      platformPolicyId: cleanText(input.platformPolicyId || ""),
      entityType: cleanText(input.entityType || "数字员工"),
      entityId,
      entityVersion: cleanText(input.entityVersion || ""),
      capabilityVersion: cleanText(input.capabilityVersion || ""),
      modelId: cleanText(input.modelId || ""),
      modelVersion: cleanText(input.modelVersion || ""),
      promptVersion: cleanText(input.promptVersion || ""),
      severity: cleanText(input.severity || "P2"),
      status: "待平台质量复盘",
      errorDomain: cleanText(input.errorDomain || "quality"),
      errorCode: cleanText(input.errorCode || "SUBSYSTEM_QUALITY_EVENT"),
      rootCauseCategory: cleanText(input.rootCauseCategory || "pending_analysis"),
      resolutionAction: cleanText(input.resolutionAction || "pending_review"),
      evidenceSummary: cleanText(input.evidenceSummary || "子系统提交的质量事件安全摘要。"),
      expectedSummary: cleanText(input.expectedSummary || ""),
      actualSummary: cleanText(input.actualSummary || ""),
      evalCandidate: Boolean(input.evalCandidate),
      archiveMode: eventType === "badcase_archive_request" ? cleanText(input.archiveMode || "subsystem_push") : "",
      archiveWindow: eventType === "badcase_archive_request" ? cleanText(input.archiveWindow || "latest_open_badcases") : "",
      preReview: eventType === "badcase_archive_request" ? buildBadcaseArchivePreReview() : null,
      reviewTask: null,
      reviewGate: "质量审核确认错误码、根因、处理动作和回归候选后入库",
      warnings: [
        "MVP endpoint writes a local backend review draft only.",
        "Evidence must remain scrubbed; raw resumes, prompts, payloads, traces, and execution records are rejected by contract.",
      ],
      tags: ["mvp-control-plane-draft"],
      updatedAt: now,
    });

    return sendJson(res, 202, {
      ok: true,
      status: "pending_quality_review",
      contractVersion: "quality-event.v1",
      qualityEvent,
    });
  }

  function applyQualityReviewAction(event, action, input = {}, session = null) {
    if (!action) return { ok: false, error: "review_action_required" };
    const actor = cleanText(input.actor || session?.name || session?.email || "平台质量负责人");
    const now = new Date().toISOString();
    const task = event.reviewTask || buildInitialReviewTask(event, actor, now);
    const next = {
      ...event,
      reviewTask: {
        ...task,
        history: [...(task.history || [])],
      },
      updatedAt: now,
    };

    if (action === "start_review") {
      next.status = "待子系统提交脱敏证据";
      next.reviewTask.status = "待子系统提交脱敏证据";
      next.reviewTask.currentGate = "平台已发起复盘，等待子系统按模板提交脱敏证据包。";
      next.reviewTask.evidenceRequest = buildEvidenceRequest(event, input, actor, now);
      addReviewHistory(next.reviewTask, actor, "start_review", next.status, "平台发起复盘并请求脱敏证据。", now);
      return { ok: true, qualityEvent: next };
    }

    if (action === "submit_evidence") {
      const pkg = sanitizeEvidencePackageInput(input.evidencePackage || input, event, actor, now);
      if (pkg.sourceSystemId && pkg.sourceSystemId !== event.sourceSystemId) {
        return { ok: false, statusCode: 409, error: "evidence_source_system_mismatch" };
      }
      next.status = "待平台确认根因";
      next.reviewTask.status = "待平台确认根因";
      next.reviewTask.currentGate = "子系统已提交脱敏证据包，等待平台确认根因和处理动作。";
      next.reviewTask.evidencePackage = pkg;
      if (next.reviewTask.evidenceRequest) {
        next.reviewTask.evidenceRequest = {
          ...next.reviewTask.evidenceRequest,
          status: "已提交脱敏证据",
        };
      }
      next.evidenceSummary = pkg.conflictSummary || next.evidenceSummary;
      next.expectedSummary = pkg.expectedOutcome || next.expectedSummary;
      next.actualSummary = pkg.actualOutcome || next.actualSummary;
      if (pkg.suggestedRootCause) next.rootCauseCategory = pkg.suggestedRootCause;
      if (pkg.suggestedAction) next.resolutionAction = pkg.suggestedAction;
      next.evalCandidate = Boolean(next.evalCandidate || pkg.evalCandidate);
      addReviewHistory(next.reviewTask, pkg.submittedBy || actor, "submit_evidence", next.status, "子系统提交脱敏证据包。", now);
      return { ok: true, qualityEvent: next };
    }

    if (action === "confirm_root_cause") {
      const rootCauseCategory = cleanText(input.rootCauseCategory || next.rootCauseCategory || "pending_analysis");
      const resolutionAction = cleanText(input.resolutionAction || next.resolutionAction || "pending_review");
      next.status = "待整改";
      next.rootCauseCategory = rootCauseCategory;
      next.resolutionAction = resolutionAction;
      next.reviewTask.status = "待整改";
      next.reviewTask.currentGate = "平台已确认根因和整改动作，等待 owner 完成修复。";
      next.reviewTask.rootCauseDecision = {
        status: "已确认",
        decidedAt: now,
        decidedBy: actor,
        rootCauseCategory,
        resolutionAction,
        summary: cleanText(input.summary || "平台质量复盘已确认根因和处理动作。"),
      };
      addReviewHistory(next.reviewTask, actor, "confirm_root_cause", next.status, next.reviewTask.rootCauseDecision.summary, now);
      return { ok: true, qualityEvent: next };
    }

    if (action === "set_remediation") {
      next.status = "待回归验证";
      next.reviewTask.status = "待回归验证";
      next.reviewTask.currentGate = "整改计划已记录，等待回归验证结果。";
      next.reviewTask.remediationPlan = {
        status: "整改完成待回归",
        decidedAt: now,
        decidedBy: actor,
        owner: cleanText(input.owner || event.departmentId || "质量 owner"),
        dueAt: cleanText(input.dueAt || ""),
        summary: cleanText(input.summary || "已更新规则/Prompt/Skill 策略，等待回归验证。"),
        resolutionAction: cleanText(input.resolutionAction || next.resolutionAction),
      };
      addReviewHistory(next.reviewTask, actor, "set_remediation", next.status, next.reviewTask.remediationPlan.summary, now);
      return { ok: true, qualityEvent: next };
    }

    if (action === "mark_regression") {
      next.status = "待关闭";
      next.evalCandidate = true;
      next.reviewTask.status = "待关闭";
      next.reviewTask.currentGate = "回归样本已登记并通过验证，等待平台关闭。";
      next.reviewTask.regressionPlan = {
        status: cleanText(input.regressionStatus || "passed"),
        decidedAt: now,
        decidedBy: actor,
        regressionCaseId: cleanText(input.regressionCaseId || `REG-${event.id}`),
        regressionStatus: cleanText(input.regressionStatus || "passed"),
        summary: cleanText(input.summary || "已加入回归样本并通过验证。"),
      };
      addReviewHistory(next.reviewTask, actor, "mark_regression", next.status, next.reviewTask.regressionPlan.summary, now);
      return { ok: true, qualityEvent: next };
    }

    if (action === "close_review") {
      next.status = "已关闭";
      next.reviewTask.status = "已关闭";
      next.reviewTask.currentGate = "质量复盘已关闭，记录保留为回归和治理证据。";
      next.reviewTask.closure = {
        status: "已关闭",
        decidedAt: now,
        decidedBy: actor,
        closeReason: cleanText(input.closeReason || input.summary || "根因、整改和回归验证已完成。"),
      };
      addReviewHistory(next.reviewTask, actor, "close_review", next.status, next.reviewTask.closure.closeReason, now);
      return { ok: true, qualityEvent: next };
    }

    return { ok: false, error: "unsupported_quality_review_action" };
  }

  function buildInitialReviewTask(event, actor, now) {
    return {
      id: `QRT-${event.id}`,
      status: "复盘已发起",
      startedAt: now,
      startedBy: actor,
      currentGate: "平台质量复盘任务已创建。",
      evidenceRequest: null,
      evidencePackage: null,
      rootCauseDecision: null,
      remediationPlan: null,
      regressionPlan: null,
      closure: null,
      history: [],
    };
  }

  function buildEvidenceRequest(event, input, actor, now) {
    return {
      id: `EVR-${event.id}`,
      status: "待子系统提交脱敏证据",
      requestedAt: now,
      requestedBy: actor,
      evidenceTemplate: cleanText(input.evidenceTemplate || "role_match_conflict_v1"),
      dueAt: cleanText(input.dueAt || ""),
      requiredFields: cleanList(input.requiredFields || [
        "申请岗位分类",
        "推荐岗位分类",
        "岗位分类版本",
        "冲突原因摘要",
        "匹配规则命中摘要",
        "人工期望结果",
        "系统实际结果",
        "是否重复出现",
      ]),
      forbiddenFields: cleanList(input.forbiddenFields || [
        "原始简历",
        "候选人姓名",
        "联系方式",
        "raw prompt",
        "模型完整输入输出",
        "OCR 原文",
        "执行 trace",
      ]),
      requestNote: cleanText(input.requestNote || "请在 HR 系统本地生成并审核脱敏证据包后回传平台。"),
      targetEndpoint: `/api/control-plane/platform/quality-events/${event.id}/review-actions`,
    };
  }

  function sanitizeEvidencePackageInput(source, event, actor, now) {
    const pkg = source && typeof source === "object" ? source : {};
    return {
      id: cleanText(pkg.id || `EVP-${event.id}`),
      status: "已提交",
      submittedAt: now,
      submittedBy: cleanText(pkg.submittedBy || actor || "HR owner"),
      sourceSystemId: cleanText(pkg.sourceSystemId || event.sourceSystemId),
      sourceEventId: cleanText(pkg.sourceEventId || event.sourceEventId),
      evidenceTemplate: cleanText(pkg.evidenceTemplate || "role_match_conflict_v1"),
      applicationRoleClass: cleanText(pkg.applicationRoleClass || "申请岗位分类待确认"),
      recommendedRoleClass: cleanText(pkg.recommendedRoleClass || "推荐岗位分类待确认"),
      jdTaxonomyVersion: cleanText(pkg.jdTaxonomyVersion || ""),
      conflictSummary: cleanText(pkg.conflictSummary || pkg.evidenceSummary || "HR 系统已提交岗位分类冲突脱敏证据。"),
      matchedRuleSummary: cleanText(pkg.matchedRuleSummary || ""),
      expectedOutcome: cleanText(pkg.expectedOutcome || pkg.expectedSummary || ""),
      actualOutcome: cleanText(pkg.actualOutcome || pkg.actualSummary || ""),
      recurrenceSummary: cleanText(pkg.recurrenceSummary || ""),
      suggestedRootCause: cleanText(pkg.suggestedRootCause || event.rootCauseCategory),
      suggestedAction: cleanText(pkg.suggestedAction || event.resolutionAction),
      evalCandidate: Boolean(pkg.evalCandidate ?? event.evalCandidate),
      privacyReview: cleanText(pkg.privacyReview || "HR owner 已确认只包含脱敏摘要。"),
      privacyBoundary: cleanText(pkg.privacyBoundary || "不含原始简历、候选人标识、联系方式、raw prompt、模型 trace 或完整执行记录。"),
    };
  }

  function addReviewHistory(task, actor, action, status, note, now = new Date().toISOString()) {
    task.history = [
      ...(Array.isArray(task.history) ? task.history : []),
      {
        at: now,
        actor,
        action,
        status,
        note,
      },
    ].slice(-30);
  }

  function buildBadcaseArchivePreReview() {
    const worker = preReviewWorkers.find((item) => item.id === "badcase-archive-precheck");
    return {
      status: "queued",
      workerId: worker?.id || "badcase-archive-precheck",
      workerName: worker?.name || "Badcase 归档预审核员",
      workerEmployeeId: worker?.workerEmployeeId || "requirement-intake-agent",
      lane: worker?.lane || "quality_archive_precheck",
      schedule: worker?.schedule || "0 */6 * * *",
      autoEval: worker?.autoEvalPolicy || "planned",
      recommendation: "dedupe_and_manual_quality_review",
      safeFindings: ["归档请求只接收安全摘要", "重复 P0/P1 和 evalCandidate 后续进入 auto eval 预审"],
    };
  }

  function isTestSourceRef(value = "") {
    return /(^|[._:-])(smoke|demo|test|mock|sample|control-plane-link|link-test)([._:-]|$)/i.test(String(value || ""));
  }

  function hasUnstableSourceRef(value = "") {
    return /[:._-](\d{13}|\d{14})$/i.test(String(value || ""));
  }

  function hasUnsafeText(values = []) {
    return values.some((value) => /(token=|ticket=|password=|secret=|api[_-]?key=|cookie=)/i.test(String(value || "")));
  }

  return {
    checkInvocationPolicy,
    createCapabilityRequest,
    createQualityEvent,
    createSkillMountRequest,
    createToolBindingRequest: toolBindingHandlers.createToolBindingRequest,
    confirmSubsystemHandshake,
    decideCapabilityRequest,
    decideSkillMountRequest,
    decideToolBindingRequest: toolBindingHandlers.decideToolBindingRequest,
    listCapabilityCatalog,
    listCapabilityRequests,
    listDistributions,
    listInvocationPolicies,
    listManagedSandboxProfiles: managedSandboxProfileHandlers.listManagedSandboxProfiles,
    listQualityEvents,
    listSkillMountRequests,
    listSubsystems,
    listToolBindingRequests: toolBindingHandlers.listToolBindingRequests,
    listToolResources,
    registerSubsystem,
    runCapabilityPreReview,
    startSubsystemHandshake,
    updateSubsystemAssignment,
    updateQualityReviewTask,
    withEffectiveToolBindings: toolBindingHandlers.withEffectiveToolBindings,
  };
}
