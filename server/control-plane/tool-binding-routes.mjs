import { resolveToolAuthorizationPolicy } from "../agent-runtime/tool-authorization-policy.mjs";
import {
  canonicalEnterpriseToolId,
  DEFAULT_FEISHU_TOOL_ID,
  isDefaultFeishuToolIdentity,
  toolCanBindToEmployee,
} from "../../src/lib/enterpriseTools.js";

const CONTRACT_VERSION = "tool-binding-change-request.v1";

export function createToolBindingHandlers({
  applyCatalogFilters,
  cleanText,
  digitalEmployees,
  getDigitalEmployees,
  enterpriseTools = [],
  getEnterpriseTools = () => enterpriseTools,
  optionalSession,
  readJsonBody,
  sendJson,
  store,
}) {
  function listToolBindingRequests(req, res, url) {
    const session = optionalSession(req);
    if (!session) {
      return sendJson(res, 401, {
        ok: false,
        error: "authentication_required",
        contractVersion: CONTRACT_VERSION,
      });
    }
    const canReviewAll = hasToolGovernance(session);
    const actorKeys = new Set([session.employeeId, session.email, session.feishuUserId].filter(Boolean));
    const departmentId = cleanText(session.departmentId || "");
    const visibleItems = currentToolBindingRequestsList().filter((request) => {
      if (canReviewAll) return true;
      if (departmentId && request.departmentId === departmentId) return true;
      return actorKeys.has(request.requestedBy?.id);
    });
    const items = applyCatalogFilters(visibleItems, url, [
      "action",
      "status",
      "employeeId",
      "toolId",
      "toolBindingId",
      "departmentId",
      "requestMode",
    ]);
    return sendJson(res, 200, {
      ok: true,
      status: "ready",
      contractVersion: CONTRACT_VERSION,
      canManage: canReviewAll,
      toolBindingRequests: items,
      persistence: {
        kind: "mvp-file-store",
        productionReady: false,
        path: "data/local/control-plane-subsystems.json",
      },
    });
  }

  async function createToolBindingRequest(req, res) {
    const session = optionalSession(req);
    if (!session) {
      return sendJson(res, 401, {
        ok: false,
        error: "authentication_required",
        contractVersion: CONTRACT_VERSION,
      });
    }
    if (!store?.saveToolBindingRequest) {
      return sendJson(res, 503, {
        ok: false,
        error: "control_plane_store_required",
        contractVersion: CONTRACT_VERSION,
      });
    }
    const input = await readJsonBody(req);
    const action = cleanText(input.action || "enable");
    if (!["enable", "disable", "configure"].includes(action)) {
      return sendJson(res, 400, {
        ok: false,
        error: "unsupported_tool_binding_action",
        contractVersion: CONTRACT_VERSION,
      });
    }
    const employee = currentDigitalEmployeesList().find((item) => item.id === cleanText(input.employeeId));
    const toolMatch = findToolForBinding(input, employee);
    if (!employee || !toolMatch?.tool) {
      return sendJson(res, 404, {
        ok: false,
        error: employee ? "tool_not_found" : "digital_employee_not_found",
        contractVersion: CONTRACT_VERSION,
      });
    }
    if (action !== "disable" && !catalogToolForRequest(input)) {
      return sendJson(res, 404, {
        ok: false,
        error: "tool_asset_not_found",
        contractVersion: CONTRACT_VERSION,
      });
    }
    if (hasConflictingCatalogToolIds(input)) {
      return sendJson(res, 422, {
        ok: false,
        error: "conflicting_tool_identity",
        contractVersion: CONTRACT_VERSION,
      });
    }
    if (action !== "disable" && !toolCanBindToEmployee(toolMatch.tool, employee)) {
      return sendJson(res, 422, {
        ok: false,
        error: "tool_binding_not_allowed_for_employee",
        contractVersion: CONTRACT_VERSION,
      });
    }
    const operationPolicy = normalizeOperationPolicy(input, toolMatch.tool);
    if (action === "configure" && !operationPolicy.ok) {
      return sendJson(res, 422, {
        ok: false,
        error: "invalid_tool_operation_policy",
        contractVersion: CONTRACT_VERSION,
      });
    }
    const catalogWritebackBoundary = cleanText(toolMatch.tool.writebackBoundary || "");
    if (catalogWritebackBoundary && input.writebackBoundary !== undefined &&
      cleanText(input.writebackBoundary) !== catalogWritebackBoundary) {
      return sendJson(res, 422, {
        ok: false,
        error: "invalid_tool_writeback_boundary",
        contractVersion: CONTRACT_VERSION,
      });
    }
    const duplicateRequest = currentToolBindingRequestsList().find((request) => (
      request.employeeId === employee.id &&
      request.action === action &&
      isPendingToolRequestStatus(request.status) &&
      toolRequestMatchesInput(request, input, toolMatch.tool)
    ));
    if (duplicateRequest) {
      return sendJson(res, 409, {
        ok: false,
        error: "tool_binding_request_already_pending",
        contractVersion: CONTRACT_VERSION,
        toolBindingRequest: duplicateRequest,
      });
    }
    if (hasUnsafeText([input.reason, input.safeSummary, input.permissionBoundary, input.credentialBoundary, input.writebackBoundary])) {
      return sendJson(res, 422, {
        ok: false,
        error: "unsafe_tool_binding_request",
        contractVersion: CONTRACT_VERSION,
      });
    }

    const now = new Date().toISOString();
    const requestId = `TBR-${employee.id.toUpperCase().replace(/[^A-Z0-9]+/g, "-")}-${Date.now()}`;
    const applicationMode = hasToolGovernance(session) && ["enable", "configure"].includes(action)
      ? "admin_override"
      : action === "enable" && isDefaultFeishuToolRequest(toolMatch.tool, input)
        ? "default_enabled"
        : "approval_required";
    const appliedImmediately = applicationMode !== "approval_required";
    const request = store.saveToolBindingRequest(buildToolBindingRequest({
      id: requestId,
      action,
      employee,
      tool: toolMatch.tool,
      binding: toolMatch.binding,
      input,
      session,
      now,
      applicationMode,
      operationPolicy: operationPolicy.value,
    }));

    return sendJson(res, appliedImmediately ? 200 : 202, {
      ok: true,
      status: appliedImmediately ? "applied" : "pending_review",
      contractVersion: CONTRACT_VERSION,
      toolBindingRequest: request,
      warnings: request.warnings,
    });
  }

  async function decideToolBindingRequest(req, res, requestId) {
    const session = optionalSession(req);
    if (!hasToolGovernance(session)) {
      return sendJson(res, 403, {
        ok: false,
        error: "tool_governance_required",
        contractVersion: CONTRACT_VERSION,
      });
    }
    if (!store?.saveToolBindingRequest) {
      return sendJson(res, 503, {
        ok: false,
        error: "control_plane_store_required",
        contractVersion: CONTRACT_VERSION,
      });
    }
    const request = currentToolBindingRequestsList().find((item) => item.id === cleanText(requestId));
    if (!request) {
      return sendJson(res, 404, {
        ok: false,
        error: "tool_binding_request_not_found",
        contractVersion: CONTRACT_VERSION,
      });
    }
    const input = await readJsonBody(req);
    const decision = cleanText(input.decision || "");
    if (!["approved", "rejected"].includes(decision)) {
      return sendJson(res, 400, {
        ok: false,
        error: "tool_binding_decision_required",
        contractVersion: CONTRACT_VERSION,
      });
    }
    if (hasUnsafeText([input.notes, input.safeNotes])) {
      return sendJson(res, 422, {
        ok: false,
        error: "unsafe_tool_binding_decision",
        contractVersion: CONTRACT_VERSION,
      });
    }
    const employee = currentDigitalEmployeesList().find((item) => item.id === request.employeeId);
    const catalogTool = catalogToolForRequest(request);
    if (
      decision === "approved" &&
      request.action !== "disable" &&
      catalogTool &&
      !toolCanBindToEmployee(catalogTool, employee)
    ) {
      return sendJson(res, 422, {
        ok: false,
        error: "tool_binding_not_allowed_for_employee",
        contractVersion: CONTRACT_VERSION,
      });
    }

    const now = new Date().toISOString();
    const saved = store.saveToolBindingRequest({
      ...request,
      status: decision === "approved" ? "已生效" : "已驳回",
      decision: {
        decision,
        decidedAt: now,
        decidedBy: session,
        notes: cleanText(input.notes || input.safeNotes || ""),
      },
      reviewGate: decision === "approved"
        ? "工具 owner 已确认命令范围、凭证边界、权限 scope、写回和调用门禁；真实联通仍需单独测试。"
        : "已退回申请人补齐工具来源、凭证边界、权限 scope、写回或 owner 确认。",
      updatedAt: now,
    });
    return sendJson(res, 200, {
      ok: true,
      status: decision === "approved" ? "applied" : "rejected",
      contractVersion: CONTRACT_VERSION,
      toolBindingRequest: saved,
    });
  }

  function currentToolBindingRequestsList() {
    const requests = store?.readToolBindingRequests ? store.readToolBindingRequests() : [];
    return requests.map(applyDefaultToolBindingRules);
  }

  function withEffectiveToolBindings(employees = []) {
    const appliedRequests = currentToolBindingRequestsList()
      .filter((request) => request.status === "已生效")
      .filter((request) => ["approved", "admin_override_applied"].includes(request.decision?.decision))
      .filter((request) => ["enable", "disable", "configure"].includes(request.action))
      .filter((request) => !hasConflictingCatalogToolIds(request))
      .sort((left, right) => String(left.updatedAt || left.submittedAt || "").localeCompare(String(right.updatedAt || right.submittedAt || "")));
    const hasDefaultBindings = getEnterpriseTools().some((tool) => tool?.defaultEmployeeBindingPolicy === "all_digital_employees");
    if (!appliedRequests.length && !hasDefaultBindings) return employees;

    return employees.map((employee) => {
      const employeeRequests = appliedRequests
        .filter((request) => request.employeeId === employee.id)
        .filter((request) => {
          if (request.action === "disable") return true;
          const catalogTool = catalogToolForRequest(request);
          return Boolean(catalogTool && toolCanBindToEmployee(catalogTool, employee));
        });
      const bindings = defaultToolBindingsForEmployee(employee);
      if (!employeeRequests.length) {
        const baseBindings = employeeToolBindings(employee);
        if (bindings.length === baseBindings.length) return employee;
        return {
          ...employee,
          catalogToolBindings: Array.isArray(employee.toolBindings) ? employee.toolBindings : [],
          toolBindings: bindings,
          effectiveToolBindingChanges: [],
        };
      }
      const effectiveChanges = [];
      employeeRequests.forEach((request) => {
        const matchingIndex = bindings.findIndex((binding) => toolBindingMatchesRequest(binding, request));
        if (request.action === "disable") {
          if (matchingIndex >= 0) bindings.splice(matchingIndex, 1);
        } else {
          const nextBinding = toolBindingFromRequest(request, catalogToolForRequest(request));
          if (matchingIndex >= 0) bindings.splice(matchingIndex, 1, nextBinding);
          else bindings.push(nextBinding);
        }
        effectiveChanges.push({
          id: request.id,
          action: request.action,
          toolActionId: request.toolActionId,
          toolId: request.toolId,
          updatedAt: request.updatedAt || "",
        });
      });

      return {
        ...employee,
        catalogToolBindings: Array.isArray(employee.toolBindings) ? employee.toolBindings : [],
        toolBindings: bindings,
        effectiveToolBindingChanges: effectiveChanges,
      };
    });
  }

  function defaultToolBindingsForEmployee(employee = {}) {
    const bindings = employeeToolBindings(employee);
    const existingIds = new Set(bindings.map((binding) => normalizeToolLookup(canonicalEnterpriseToolId(binding.toolId || binding.id))));
    for (const tool of getEnterpriseTools()) {
      if (tool?.defaultEmployeeBindingPolicy !== "all_digital_employees" || !toolCanBindToEmployee(tool, employee)) continue;
      const identity = normalizeToolLookup(canonicalEnterpriseToolId(tool.id));
      if (!identity || existingIds.has(identity)) continue;
      bindings.push(defaultToolBindingFromCatalog(tool));
      existingIds.add(identity);
    }
    return bindings;
  }

  function applyDefaultToolBindingRules(request = {}) {
    if (!isDefaultFeishuEnableRequestRecord(request) || !isPendingToolRequestStatus(request.status)) return request;
    const now = request.updatedAt || new Date().toISOString();
    return {
      ...request,
      requestMode: "default_enabled",
      status: "已生效",
      decision: request.decision || defaultFeishuToolDecision(now),
      reviewGate: "Feishu 基础 Tool 企业默认开启；凭证、Scope、群/用户白名单、写回和真实消息回环仍需平台治理确认。",
      warnings: [
        "Feishu Tool 开启命中企业默认规则，不进入重复开通审批。",
        "默认开启只表示员工工具边界可见，不表示飞书渠道联通、provider key、真实消息回环或生产写回已通过。",
        ...(request.warnings || []),
      ],
      tags: [...new Set([...(request.tags || []), "default_feishu_tool"].filter(Boolean))],
    };
  }

  function hasToolGovernance(session) {
    const permissions = new Set(session?.permissions || []);
    return (
      session?.role === "admin" ||
      permissions.has("system:*") ||
      permissions.has("digital-employees:*") ||
      permissions.has("provider-connections:*") ||
      permissions.has("control-plane:*")
    );
  }

  function findToolForBinding(input = {}, employee = {}) {
    const requestedToolId = normalizeToolLookup(canonicalEnterpriseToolId(input.toolId || input.toolAssetId));
    const requestedBindingId = normalizeToolLookup(canonicalEnterpriseToolId(input.toolBindingId || input.bindingId));
    const requestedName = cleanText(input.toolName || input.name);
    const bindings = employeeToolBindings(employee);
    const binding = bindings.find((item) => {
      const ids = [item.toolId, item.id]
        .map(canonicalEnterpriseToolId)
        .map(normalizeToolLookup)
        .filter(Boolean);
      const name = normalizeToolLookup(item.name);
      return (
        (requestedBindingId && ids.includes(requestedBindingId)) ||
        (requestedToolId && ids.includes(requestedToolId)) ||
        (requestedName && name === normalizeToolLookup(requestedName))
      );
    }) || bindings.find((item) => requestedName && toolTextMatches(item.name, requestedName));
    const exactCatalogTool = getEnterpriseTools().find((tool) => normalizeToolLookup(canonicalEnterpriseToolId(tool.id)) === requestedToolId) ||
      getEnterpriseTools().find((tool) => normalizeToolLookup(canonicalEnterpriseToolId(tool.id)) === requestedBindingId) ||
      getEnterpriseTools().find((tool) => requestedName && [tool.name, tool.displayName]
        .map(normalizeToolLookup)
        .includes(normalizeToolLookup(requestedName)));
    const catalogTool = exactCatalogTool || getEnterpriseTools().find((tool) => {
      const employeeBound = (tool.boundEmployeeIds || []).includes(employee?.id);
      const searchableText = `${tool.id} ${tool.name} ${tool.displayName} ${tool.tags?.join(" ")}`;
      return (
        (requestedName && toolTextMatches(searchableText, requestedName)) ||
        (isDefaultFeishuTool(tool) && isDefaultFeishuBindingInput(input)) ||
        (employeeBound && binding && toolTextMatches(searchableText, binding.name))
      );
    });
    const fallbackTool = binding ? {
      id: input.toolId || binding.id || binding.name,
      name: binding.name,
      displayName: binding.name,
      toolType: binding.kind || "执行工具",
      vendor: "",
      source: "员工工具绑定",
      sourceUrl: "",
      risk: binding.risk || employee.risk || "待评估",
      owner: employee.owner || "",
      ownerDepartmentId: employee.ownerDepartmentId || employee.departmentId || "",
      credentialBoundary: binding.credentialBoundary || "server_only",
      credentialMode: cleanShortText(binding.credentialMode),
      permissionBoundary: binding.permissionScope || employee.permissionSummary || employee.permissionScope || "随员工权限",
      runtimeBoundary: binding.writebackBoundary || employee.writebackBoundary || "按员工输出契约",
      reviewGate: binding.reviewGate || "平台管理员 + 员工 owner 确认工具边界",
      readinessChecks: [],
      identityModes: [],
      scopeGroups: [],
      boundEmployeeIds: [employee.id].filter(Boolean),
      boundSkillIds: [],
      channelBindings: [],
    } : null;
    return {
      tool: catalogTool || fallbackTool,
      binding: binding || null,
    };
  }

  function catalogToolForRequest(request = {}) {
    const ids = [request.toolId, request.toolBindingId]
      .map(canonicalEnterpriseToolId)
      .map(normalizeToolLookup)
      .filter(Boolean);
    return getEnterpriseTools().find((tool) => ids.includes(normalizeToolLookup(canonicalEnterpriseToolId(tool.id)))) || null;
  }

  function hasConflictingCatalogToolIds(value = {}) {
    const resolvedIds = [value.toolId || value.toolAssetId, value.toolBindingId || value.bindingId]
      .map(canonicalEnterpriseToolId)
      .map(normalizeToolLookup)
      .filter(Boolean)
      .map((identity) => getEnterpriseTools().find((tool) => (
        normalizeToolLookup(canonicalEnterpriseToolId(tool.id)) === identity
      ))?.id)
      .filter(Boolean);
    return new Set(resolvedIds).size > 1;
  }

  function buildToolBindingRequest({ id, action, employee, tool, binding, input, session, now, applicationMode = "approval_required", operationPolicy = {} }) {
    const actionLabel = action === "disable" ? "关闭工具" : action === "configure" ? "配置操作权限" : "开启工具";
    const toolBindingId = cleanText(input.toolBindingId || binding?.id || tool.id);
    const appliedImmediately = applicationMode !== "approval_required";
    const adminApplied = applicationMode === "admin_override";
    const defaultApplied = applicationMode === "default_enabled";
    const missingItems = [];
    if (/高|生产|写回/i.test(tool.risk || binding?.risk || "") && !(tool.readinessChecks || []).length) {
      missingItems.push("高风险 Tool 需要补齐凭证、权限、写回和联通自检项。");
    }
    if (!tool.credentialBoundary && !binding?.credentialBoundary) missingItems.push("凭证边界待补齐");
    if (!tool.permissionBoundary && !binding?.permissionScope) missingItems.push("权限边界待补齐");
    return {
      id,
      action,
      actionLabel,
      toolActionId: `TOL-${employee.id.toUpperCase().replace(/[^A-Z0-9]+/g, "-")}-${Date.now()}`,
      requestMode: applicationMode,
      status: appliedImmediately ? "已生效" : "待工具审批",
      employeeId: employee.id,
      employeeName: employee.name,
      employeeVersion: employee.version,
      employeeLevel: employee.level,
      toolId: tool.id,
      toolBindingId,
      toolName: tool.displayName || tool.name || binding?.name || toolBindingId,
      toolType: tool.toolType || binding?.kind || "执行工具",
      toolVendor: tool.vendor || "",
      source: tool.source || "员工工具绑定",
      sourceUrl: tool.sourceUrl || "",
      departmentId: employee.ownerDepartmentId || employee.departmentId || tool.ownerDepartmentId || "",
      owner: tool.owner || employee.owner || "",
      ownerDepartmentId: tool.ownerDepartmentId || employee.ownerDepartmentId || employee.departmentId || "",
      requestedBy: session,
      requestedRole: adminApplied ? "Tool 治理管理员" : defaultApplied ? "默认规则命中" : "申请人",
      reason: cleanText(input.reason || `${actionLabel} ${employee.name} 的 ${tool.displayName || tool.name || binding?.name || "Tool"}`),
      riskLevel: cleanText(input.riskLevel || tool.risk || binding?.risk || "待评估"),
      safeSummary: cleanText(input.safeSummary || (adminApplied
        ? `${actionLabel} ${employee.name} 的 ${tool.displayName || tool.name || binding?.name || "Tool"}；管理员决定已记录，真实联通和调用门禁仍独立验证。`
        : `${actionLabel} ${employee.name} 的 ${tool.displayName || tool.name || binding?.name || "Tool"}；审批通过前不改变真实运行接入。`)),
      permissionBoundary: cleanText(input.permissionBoundary || tool.permissionBoundary || binding?.permissionScope || employee.permissionSummary || employee.permissionScope || "随员工权限"),
      credentialBoundary: cleanText(input.credentialBoundary || tool.credentialBoundary || binding?.credentialBoundary || "server_only"),
      credentialMode: normalizeCredentialMode(input.credentialMode || tool.credentialMode || binding?.credentialMode),
      writebackBoundary: cleanText(tool.writebackBoundary || input.writebackBoundary ||
        binding?.writebackBoundary || "按员工输出契约"),
      runtimeBoundary: cleanText(input.runtimeBoundary || tool.runtimeBoundary || binding?.writebackBoundary || "只记录工具边界，不表示真实联通。"),
      reviewGate: cleanText(input.reviewGate || (adminApplied
        ? action === "configure"
          ? "Tool 治理管理员已应用结构化授权策略；目标平台 RBAC 与每次调用门禁继续生效。"
          : "Tool 治理管理员已确认员工绑定边界；凭证、目标平台 RBAC、调用确认和真实联通门禁继续独立生效。"
        : defaultApplied
          ? "Feishu 基础 Tool 企业默认开启；凭证、Scope、群/用户白名单、写回和真实消息回环仍需平台治理确认。"
          : tool.reviewGate || binding?.reviewGate || "平台管理员 + 员工 owner + 工具 owner 复核后生效。")),
      readinessChecks: tool.readinessChecks || [],
      identityModes: tool.identityModes || [],
      scopeGroups: tool.scopeGroups || [],
      policyMode: action === "configure" ? operationPolicy.policyMode : cleanShortText(binding?.policyMode),
      allowedOperations: action === "configure" ? operationPolicy.allowedOperations : normalizeIdentifierList(binding?.allowedOperations),
      allowedCapabilities: action === "configure" ? operationPolicy.allowedCapabilities : normalizeIdentifierList(binding?.allowedCapabilities),
      allowedRisks: action === "configure" ? operationPolicy.allowedRisks : normalizeRiskList(binding?.allowedRisks),
      contractDigest: action === "configure" ? operationPolicy.contractDigest : cleanShortText(binding?.contractDigest),
      approvedWritePolicyDigests: action === "configure"
        ? operationPolicy.approvedWritePolicyDigests
        : normalizeApprovedWritePolicyDigests(binding?.approvedWritePolicyDigests),
      policyContractDigest: action === "configure" ? operationPolicy.policyContractDigest : cleanShortText(binding?.policyContractDigest),
      boundSkillIds: tool.boundSkillIds || [],
      channelBindings: tool.channelBindings || [],
      decision: adminApplied
        ? toolGovernanceDecision(session, now, action)
        : defaultApplied
          ? defaultFeishuToolDecision(now)
          : null,
      warnings: [
        adminApplied
          ? action === "configure"
            ? "Tool 治理管理员已直接应用操作级权限，并保留审计记录。"
            : "Tool 治理管理员已直接应用员工 Tool 绑定，并保留审计记录。"
          : defaultApplied
            ? "Feishu Tool 开启命中企业默认规则，不进入重复开通审批。"
          : "Tool 开关申请写入后端控制面文件存储；审批通过前不修改生产凭证、运行时、飞书联通或 provider lease。",
        "Tool 是执行手段，不等于 Skill 发布、飞书渠道联通或数字员工试运行通过。",
        ...missingItems,
      ],
      tags: ["mvp-tool-binding-change", adminApplied ? action === "configure" ? "admin_operation_policy" : "admin_tool_binding" : defaultApplied ? "default_feishu_tool" : "approval_required"],
      submittedAt: new Date(now).toLocaleString("zh-CN", { hour12: false, timeZone: "Asia/Shanghai" }),
      updatedAt: now,
    };
  }

  function currentDigitalEmployeesList() {
    return typeof getDigitalEmployees === "function" ? getDigitalEmployees() : digitalEmployees;
  }

  return {
    createToolBindingRequest,
    decideToolBindingRequest,
    listToolBindingRequests,
    withEffectiveToolBindings,
  };
}

function isPendingToolRequestStatus(status = "") {
  return /待|pending|review/i.test(String(status || ""));
}

function normalizeIdentifierList(value) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map(cleanShortText).filter(Boolean))].slice(0, 100);
}

function normalizeOperationPolicy(input = {}, tool = {}) {
  const requested = normalizeIdentifierList(input.allowedOperations);
  if (tool.operationCatalog?.kind === "runtime_openapi") {
    const allowedCapabilities = normalizeIdentifierList(input.allowedCapabilities).map((capability) => capability.toLowerCase());
    const capabilitiesAreSafe = allowedCapabilities.every((capability) => /^[a-z0-9_.:-]{1,180}$/.test(capability));
    const allowedRisks = normalizeRiskList(input.allowedRisks);
    const contractDigest = cleanShortText(input.contractDigest);
    const approvedWritePolicyDigests = normalizeApprovedWritePolicyDigests(input.approvedWritePolicyDigests);
    const policyContractDigest = cleanShortText(input.policyContractDigest);
    const policyMode = cleanShortText(input.policyMode || "contract_capability");
    const v2PolicyDeclared = Object.hasOwn(input, "contractDigest") || Object.hasOwn(input, "approvedWritePolicyDigests");
    const approvedCapabilities = Object.keys(approvedWritePolicyDigests).sort();
    const expectedCapabilities = [...allowedCapabilities].sort();
    const rawApprovedDigestCount = input.approvedWritePolicyDigests && typeof input.approvedWritePolicyDigests === "object" && !Array.isArray(input.approvedWritePolicyDigests)
      ? Object.keys(input.approvedWritePolicyDigests).length
      : -1;
    const v2PolicyValid = /^sha256:[a-f0-9]{64}$/.test(contractDigest) &&
      rawApprovedDigestCount === approvedCapabilities.length &&
      approvedCapabilities.length === expectedCapabilities.length &&
      approvedCapabilities.every((capability, index) => capability === expectedCapabilities[index]) &&
      !policyContractDigest;
    const legacyPolicyValid = !v2PolicyDeclared && /^sha256:[a-f0-9]{64}$/.test(policyContractDigest);
    const registeredPolicyMatches = tool.operationCatalog?.sourceOfTruth !== "backend_tool_asset_registry" ||
      (contractDigest === tool.contractDigest && allowedCapabilities.every(capability =>
        tool.capabilityPolicies?.some(policy => policy.capability === capability && policy.writePolicyDigest === approvedWritePolicyDigests[capability])));
    return {
      ok: registeredPolicyMatches && policyMode === "contract_capability" && requested.length === 0 &&
        Array.isArray(input.allowedCapabilities) && allowedCapabilities.length > 0 && allowedCapabilities.length === input.allowedCapabilities.length &&
        (!Object.hasOwn(input, "allowedRisks") || (Array.isArray(input.allowedRisks) && allowedRisks.length === input.allowedRisks.length)) &&
        (v2PolicyValid || legacyPolicyValid) && capabilitiesAreSafe,
      value: {
        policyMode,
        allowedOperations: [],
        allowedCapabilities,
        allowedRisks,
        contractDigest: v2PolicyDeclared ? contractDigest : "",
        approvedWritePolicyDigests: v2PolicyDeclared ? approvedWritePolicyDigests : {},
        policyContractDigest: v2PolicyDeclared ? "" : policyContractDigest,
      },
    };
  }
  const groups = tool.operationGroups || [];
  const declared = new Set(groups
    .flatMap((group) => group.operations || [])
    .map((operation) => cleanShortText(operation?.id))
    .filter(Boolean));
  const defaults = groups
    .filter((group) => group.defaultEnabled)
    .flatMap((group) => group.operations || [])
    .map((operation) => cleanShortText(operation?.id))
    .filter(Boolean);
  return {
    ok: Array.isArray(input.allowedOperations) && declared.size > 0 && requested.every((operation) => declared.has(operation)),
    value: {
      policyMode: "legacy_operation_allowlist",
      allowedOperations: [...new Set([...defaults, ...requested])],
      allowedCapabilities: [],
      allowedRisks: [],
      contractDigest: "",
      approvedWritePolicyDigests: {},
      policyContractDigest: "",
    },
  };
}

function normalizeApprovedWritePolicyDigests(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.fromEntries(Object.entries(value)
    .slice(0, 100)
    .map(([capability, digest]) => [cleanShortText(capability).toLowerCase(), cleanShortText(digest)])
    .filter(([capability, digest]) => /^[a-z0-9_.:-]{1,180}$/.test(capability) && /^sha256:[a-f0-9]{64}$/.test(digest)));
}

function normalizeRiskList(value) {
  const allowed = new Set(["controlled_write", "high_impact_write", "destructive_write"]);
  return normalizeIdentifierList(value).filter((risk) => allowed.has(risk));
}

function toolGovernanceDecision(session = {}, now = "", action = "configure") {
  return {
    decision: "admin_override_applied",
    decidedAt: now,
    decidedBy: session,
    notes: action === "configure"
      ? "Tool 治理管理员已应用操作级权限配置；目标平台 RBAC 仍是业务权限权威。"
      : "Tool 治理管理员已应用员工 Tool 绑定；凭证、目标平台 RBAC 与真实调用门禁仍独立生效。",
  };
}

function isDefaultFeishuBindingInput(input = {}) {
  const identities = [input.toolId, input.toolAssetId, input.toolBindingId, input.bindingId, input.toolName, input.name]
    .map(cleanShortText)
    .filter(Boolean);
  return identities.length > 0 && identities.every(isDefaultFeishuToolIdentity);
}

function isDefaultFeishuTool(tool = {}) {
  return canonicalEnterpriseToolId(tool.id) === DEFAULT_FEISHU_TOOL_ID;
}

function isDefaultFeishuToolRequest(tool = {}, input = {}) {
  return isDefaultFeishuTool(tool) && isDefaultFeishuBindingInput(input);
}

function isDefaultFeishuEnableRequestRecord(request = {}) {
  if (request.action !== "enable") return false;
  const identities = [request.toolId, request.toolBindingId, request.toolName]
    .map(cleanShortText)
    .filter(Boolean);
  return identities.length > 0 && identities.every(isDefaultFeishuToolIdentity);
}

function defaultFeishuToolDecision(now) {
  return {
    decision: "approved",
    decidedAt: now,
    decidedBy: {
      id: "enterprise-default-feishu-tool",
      name: "企业默认 Feishu Tool 规则",
      role: "system-policy",
      identitySource: "control-plane-policy",
    },
    notes: "Feishu 基础 Tool 默认开启；真实联通、凭证、Scope、写回和消息回环仍需单独治理。",
  };
}

function employeeToolBindings(employee = {}) {
  const values = [
    ...(Array.isArray(employee.toolBindings) ? employee.toolBindings : []),
    ...(Array.isArray(employee.tools) ? employee.tools : []),
  ];
  const normalized = values.map((item) => {
    if (item && typeof item === "object") {
      const name = cleanShortText(item.name || item.label || item.id);
      return {
        ...item,
        id: cleanShortText(item.id || name),
        name,
        kind: cleanShortText(item.kind || item.toolType),
      };
    }
    const name = cleanShortText(item);
    return { id: name, name, kind: "执行工具" };
  }).filter((item) => item.name || item.id);
  const byIdentity = new Map();
  normalized.forEach((item) => {
    const identity = normalizeToolLookup(canonicalEnterpriseToolId(item.toolId || item.id || item.name));
    if (identity && !byIdentity.has(identity)) byIdentity.set(identity, item);
  });
  return [...byIdentity.values()];
}

function normalizeToolLookup(value = "") {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fa5]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function toolTextMatches(left = "", right = "") {
  const leftText = normalizeToolLookup(left);
  const rightText = normalizeToolLookup(right);
  if (!leftText || !rightText) return false;
  return leftText.includes(rightText) || rightText.includes(leftText);
}

function toolRequestMatchesInput(request = {}, input = {}, tool = {}) {
  const requestToolId = normalizeToolLookup(canonicalEnterpriseToolId(request.toolId));
  const inputToolId = normalizeToolLookup(canonicalEnterpriseToolId(input.toolId || input.toolAssetId || tool.id));
  if (requestToolId && inputToolId) return requestToolId === inputToolId;
  const requestKeys = [request.toolBindingId, request.toolName]
    .map(canonicalEnterpriseToolId)
    .map(normalizeToolLookup)
    .filter(Boolean);
  const inputKeys = [input.toolBindingId, input.bindingId, input.toolName, input.name, tool.id, tool.name, tool.displayName]
    .map(canonicalEnterpriseToolId)
    .map(normalizeToolLookup)
    .filter(Boolean);
  return requestKeys.some((requestKey) => inputKeys.includes(requestKey));
}

function toolBindingMatchesRequest(binding = {}, request = {}) {
  const bindingKeys = [binding.id, binding.name]
    .map(canonicalEnterpriseToolId)
    .map(normalizeToolLookup)
    .filter(Boolean);
  const requestKeys = [request.toolBindingId, request.toolName]
    .map(canonicalEnterpriseToolId)
    .map(normalizeToolLookup)
    .filter(Boolean);
  if (bindingKeys.some((bindingKey) => requestKeys.includes(bindingKey))) return true;
  const bindingToolId = normalizeToolLookup(canonicalEnterpriseToolId(binding.toolId || binding.id));
  const requestToolId = normalizeToolLookup(canonicalEnterpriseToolId(request.toolId));
  return Boolean(bindingToolId && requestToolId && bindingToolId === requestToolId);
}

function toolBindingFromRequest(request = {}, catalogTool = {}) {
  const authorizationPolicy = resolveToolAuthorizationPolicy(request);
  return {
    id: cleanShortText(request.toolId || request.toolBindingId || request.toolName),
    toolId: cleanShortText(request.toolId || catalogTool?.id),
    name: cleanShortText(request.toolName || request.toolId || request.toolBindingId),
    kind: cleanShortText(request.toolType || "执行工具"),
    enabled: true,
    status: "已生效",
    risk: cleanShortText(request.riskLevel || "待评估"),
    permissionScope: cleanShortText(request.permissionBoundary || "随员工权限"),
    credentialBoundary: cleanShortText(request.credentialBoundary || "server_only"),
    // Legacy applied requests predate the structured credential mode. The
    // current Tool catalog owns that technical boundary when the stored
    // request has no explicit value; persisted approval/policy fields remain
    // authoritative for the rest of the binding.
    credentialMode: normalizeCredentialMode(request.credentialMode || catalogTool?.credentialMode),
    writebackBoundary: cleanShortText(request.writebackBoundary || request.runtimeBoundary || "按员工输出契约"),
    reviewGate: cleanShortText(request.reviewGate || "平台管理员 + 员工 owner + 工具 owner 复核后生效。"),
    source: cleanShortText(request.source || "企业工具目录"),
    identityModes: normalizeIdentifierList(request.identityModes),
    policyMode: authorizationPolicy.mode,
    allowedOperations: normalizeIdentifierList(request.allowedOperations),
    allowedCapabilities: normalizeIdentifierList(request.allowedCapabilities),
    allowedRisks: normalizeRiskList(request.allowedRisks),
    contractDigest: cleanShortText(request.contractDigest),
    approvedWritePolicyDigests: normalizeApprovedWritePolicyDigests(request.approvedWritePolicyDigests),
    policyContractDigest: cleanShortText(request.policyContractDigest),
  };
}

function defaultToolBindingFromCatalog(tool = {}) {
  return {
    id: cleanShortText(tool.id),
    toolId: cleanShortText(tool.id),
    name: cleanShortText(tool.displayName || tool.name || tool.id),
    kind: cleanShortText(tool.toolType || "执行工具"),
    enabled: true,
    status: "已生效",
    risk: cleanShortText(tool.risk || "待评估"),
    permissionScope: cleanShortText(tool.permissionBoundary || "随员工权限"),
    credentialBoundary: cleanShortText(tool.credentialBoundary || "server_only"),
    credentialMode: normalizeCredentialMode(tool.credentialMode),
    writebackBoundary: cleanShortText(tool.writebackBoundary || tool.runtimeBoundary || "按员工输出契约"),
    reviewGate: cleanShortText(tool.reviewGate || "企业默认 Tool 策略已生效；真实联通仍需独立验证。"),
    source: cleanShortText(tool.source || "企业工具目录"),
    identityModes: normalizeIdentifierList(tool.identityModes),
  };
}

function cleanShortText(value = "") {
  return String(value || "").trim();
}

function normalizeCredentialMode(value = "") {
  const mode = cleanShortText(value).replaceAll("-", "_");
  return ["current_user_bearer", "center_current_user_lease", "device_session_refresh", "employee_app_lease"].includes(mode) ? mode : "";
}

function hasUnsafeText(values = []) {
  return values.some((value) => /(token=|ticket=|password=|secret=|api[_-]?key=|cookie=)/i.test(String(value || "")));
}
