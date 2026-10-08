import {
  accessRequestActorId,
  evaluateDigitalEmployeeEntitlement,
  sessionCanUseDigitalEmployee,
} from "./digital-employee-entitlement.mjs";
import { assembleDigitalEmployeeDependencyContext } from "./agent-runtime/dependency-context.mjs";
import { projectDesktopCharacter } from "./digital-employee-character-service.mjs";

export function createDigitalEmployeeAccessHandlers({
  getDigitalEmployees,
  getBusinessSkills,
  getConversationHistoryBootstrap,
  getCredentialBrokerBootstrap = () => null,
  getDesktopCharacter = projectDesktopCharacter,
  hasPermission,
  isManagedHttpsRequest = null,
  desktopSandboxDeviceSessionRegistry = null,
  registerDesktopPresenceDevice = () => {},
  desktopSandboxDispatchTransportHandlers = null,
  desktopTaskArtifactStagingTransportHandlers = null,
  readJsonBody,
  requireSession,
  sendJson,
  skillHarnessRunner,
  store,
} = {}) {
  if (typeof getConversationHistoryBootstrap !== "function") {
    throw new TypeError("digital employee access handlers require getConversationHistoryBootstrap");
  }
  if (desktopSandboxDeviceSessionRegistry !== null && typeof desktopSandboxDeviceSessionRegistry?.register !== "function") {
    throw new TypeError("digital employee access handlers desktop sandbox device session registry is invalid");
  }
  if (desktopSandboxDispatchTransportHandlers !== null && (!desktopSandboxDispatchTransportHandlers ||
    ["cancel", "claim", "settle"].some((method) => typeof desktopSandboxDispatchTransportHandlers[method] !== "function"))) {
    throw new TypeError("digital employee access handlers desktop sandbox dispatch transport is invalid");
  }
  if (desktopTaskArtifactStagingTransportHandlers !== null && typeof desktopTaskArtifactStagingTransportHandlers?.stage !== "function") {
    throw new TypeError("digital employee access handlers desktop task Artifact staging transport is invalid");
  }
  if ((desktopSandboxDispatchTransportHandlers !== null || desktopTaskArtifactStagingTransportHandlers !== null) &&
    typeof isManagedHttpsRequest !== "function") {
    throw new TypeError("digital employee access handlers managed HTTPS verifier is required");
  }
  return {
    async handle(req, res, url) {
      if (req.method === "GET" && url.pathname === "/api/channels/desktop/bootstrap") {
        return bootstrapDesktop(req, res);
      }
      const desktopSandboxDispatchMatch = desktopSandboxDispatchTransportHandlers &&
        url.pathname.match(/^\/api\/channels\/desktop\/sandbox-dispatch\/(claim|settle|cancel)$/);
      if (req.method === "POST" && desktopSandboxDispatchMatch) {
        return await handleDesktopSandboxDispatch(req, res, desktopSandboxDispatchMatch[1]);
      }
      if (req.method === "POST" && desktopTaskArtifactStagingTransportHandlers &&
        url.pathname === "/api/channels/desktop/task-artifact-staging") {
        return await handleDesktopTaskArtifactStaging(req, res);
      }
      if (url.pathname === "/api/digital-employee-access-requests") {
        if (req.method === "GET") return listAccessRequests(req, res, url);
        if (req.method === "POST") return await createAccessRequest(req, res);
      }
      const decisionMatch = url.pathname.match(/^\/api\/digital-employee-access-requests\/([^/]+)\/decision$/);
      if (req.method === "POST" && decisionMatch) {
        return await decideAccessRequest(req, res, decodeURIComponent(decisionMatch[1]));
      }
      const desktopAvailabilityMatch = url.pathname.match(/^\/api\/digital-employees\/([^/]+)\/desktop-availability$/);
      if (req.method === "PUT" && desktopAvailabilityMatch) {
        return await updateDesktopAvailability(req, res, decodeURIComponent(desktopAvailabilityMatch[1]));
      }
      return undefined;
    },
    canInvoke({ channelId = "desktop", employee = {}, session = null } = {}) {
      return sessionCanUseDigitalEmployee({
        accessRequests: store.readDigitalEmployeeAccessRequests(),
        channelId,
        employee: withDesktopChannelAvailability([employee])[0] || employee,
        session,
      });
    },
    withDesktopChannelAvailability,
  };

  async function bootstrapDesktop(req, res) {
    const session = requireSession(req, res);
    if (!session) return null;
    registerDesktopPresenceDevice({deviceSessionId:String(req.headers?.["x-digital-workforce-device-session"] || ""),session});
    const accessRequests = store.readDigitalEmployeeAccessRequests();
    const employees = (await Promise.all(currentEmployees()
      .map((employee) => projectDesktopEmployee(employee, session, accessRequests))))
      .filter((employee) => employee.access.visible);
    const conversationHistory = await getConversationHistoryBootstrap({ employees, session });
    if (!new Set(["desktop-conversation-history-bootstrap.v1", "desktop-conversation-history-bootstrap.v2"]).has(conversationHistory?.contractVersion) ||
      typeof conversationHistory.enabled !== "boolean") {
      throw new TypeError("desktop_conversation_history_bootstrap_contract_mismatch");
    }
    const credentialBrokerBootstrap = await getCredentialBrokerBootstrap({ employees, session });
    const sandboxDeviceSession = desktopSandboxDeviceSessionRegistry?.register({
      deviceSessionId: String(req.headers?.["x-digital-workforce-device-session"] || ""),
      session,
    }) || null;
    return sendJson(res, 200, {
      ok: true,
      contractVersion: "desktop-channel-bootstrap.v1",
      channelId: "desktop",
      actor: safeActor(session),
      employees,
      accessRequests: ownAccessRequests(accessRequests, session),
      conversationHistory,
      ...(credentialBrokerBootstrap ? { credentialBrokerBootstrap } : {}),
      ...(sandboxDeviceSession ? { sandboxDeviceSession } : {}),
      privacyBoundary:
        "只返回当前会话的安全身份摘要、桌面可见员工、服务端 entitlement、本人申请状态和 Electron 主进程私有 broker 配置；不返回凭证、raw Prompt、文件路径或执行 payload。broker 配置必须在 renderer bootstrap 前剥离。",
    });
  }

  async function handleDesktopSandboxDispatch(req, res, operation) {
    const session = requireSession(req, res);
    if (!session) return null;
    // Do not let the beta HTTP Desktop exception become a command transport.
    // Returning undefined leaves this path absent from the standard router.
    if (isManagedHttpsRequest({ requestContext: Object.freeze({ req }) }) !== true) return undefined;
    let body = null;
    try {
      body = await readJsonBody(req, 4 * 1024);
    } catch {}
    let result;
    try {
      result = await desktopSandboxDispatchTransportHandlers[dispatchTransportMethod(operation)]({
        body,
        requestContext: Object.freeze({ req, session }),
      });
    } catch {
      result = operation === "claim"
        ? { contractVersion: "desktop-sandbox-dispatch-claim.v1", status: "empty" }
        : { contractVersion: "desktop-sandbox-dispatch-transport-result.v1", status: "blocked" };
    }
    return sendJson(res, 200, result);
  }

  async function handleDesktopTaskArtifactStaging(req, res) {
    const session = requireSession(req, res);
    if (!session) return null;
    // This keeps the current private-LAN HTTP exception from becoming a Device
    // byte-transfer path. The request stream is consumed only by the trusted
    // transport after TLS and canonical attempt resolution.
    if (isManagedHttpsRequest({ requestContext: Object.freeze({ req }) }) !== true) return undefined;
    let result;
    try {
      result = await desktopTaskArtifactStagingTransportHandlers.stage({
        requestContext: Object.freeze({ req, session }),
      });
    } catch {
      result = { contractVersion: "device-task-artifact-staging.v1", status: "blocked" };
    }
    return sendJson(res, 200, result);
  }

  function listAccessRequests(req, res, url) {
    const session = requireSession(req, res);
    if (!session) return null;
    const requests = store.readDigitalEmployeeAccessRequests();
    const items = url.searchParams.get("scope") === "review"
      ? requests.filter((request) => canReviewRequest(session, request))
      : ownAccessRequests(requests, session);
    return sendJson(res, 200, {
      ok: true,
      contractVersion: "digital-employee-access-request.v1",
      accessRequests: items,
    });
  }

  async function createAccessRequest(req, res) {
    const session = requireSession(req, res);
    if (!session) return null;
    const input = await readJsonBody(req, 16 * 1024);
    const employeeId = cleanId(input.employeeId || input.targetEmployeeId);
    const employee = currentEmployees().find((item) => cleanId(item.id) === employeeId);
    if (!employee) {
      return sendJson(res, 404, {
        ok: false,
        error: "digital_employee_not_found",
        contractVersion: "digital-employee-access-request.v1",
      });
    }
    if (employee.level === "系统级") {
      return sendJson(res, 422, {
        ok: false,
        error: "system_digital_employee_not_requestable",
        contractVersion: "digital-employee-access-request.v1",
      });
    }

    const requests = store.readDigitalEmployeeAccessRequests();
    const entitlement = evaluateDigitalEmployeeEntitlement({ accessRequests: requests, channelId: "desktop", employee, session });
    if (entitlement.entitled) {
      return sendJson(res, 200, {
        ok: true,
        status: "access_already_granted",
        contractVersion: "digital-employee-access-request.v1",
        access: entitlement,
      });
    }
    if (!entitlement.requestable) {
      return sendJson(res, 409, {
        ok: false,
        error: "digital_employee_not_requestable",
        contractVersion: "digital-employee-access-request.v1",
      });
    }

    const actorId = accessRequestActorId(session);
    const duplicate = requests.find((request) => (
      request.applicant?.id === actorId &&
      request.target?.employeeId === employeeId &&
      request.target?.employeeVersion === cleanText(employee.version) &&
      ["pending_review", "approved"].includes(request.status)
    ));
    if (duplicate) {
      return sendJson(res, 200, {
        ok: true,
        status: duplicate.status,
        contractVersion: "digital-employee-access-request.v1",
        accessRequest: duplicate,
      });
    }

    const now = new Date().toISOString();
    const request = store.saveDigitalEmployeeAccessRequest({
      id: `DEAR-${Date.now()}-${actorId.toUpperCase().replace(/[^A-Z0-9]+/g, "-").slice(0, 40)}`,
      status: "pending_review",
      requestedActions: ["conversation"],
      requestedScope: "self",
      safeReason: cleanText(input.reason || input.safeReason || "申请在桌面 Channel 使用该数字员工。"),
      sourceChannelId: "desktop",
      createdAt: now,
      updatedAt: now,
      applicant: {
        id: actorId,
        name: session.name,
        departmentId: session.departmentId,
        departmentName: session.department,
        identitySource: session.identitySource,
      },
      target: {
        employeeId,
        employeeName: employee.name || employee.title,
        employeeVersion: employee.version,
        ownerDepartmentId: employee.ownerDepartmentId || employee.departmentId,
      },
    });
    return sendJson(res, 202, {
      ok: true,
      status: "pending_review",
      contractVersion: "digital-employee-access-request.v1",
      accessRequest: request,
      message: "申请已提交；审批通过前不会出现在桌面可切换员工列表。",
    });
  }

  async function decideAccessRequest(req, res, requestId) {
    const session = requireSession(req, res);
    if (!session) return null;
    const requests = store.readDigitalEmployeeAccessRequests();
    const request = requests.find((item) => item.id === requestId);
    if (!request) {
      return sendJson(res, 404, {
        ok: false,
        error: "digital_employee_access_request_not_found",
        contractVersion: "digital-employee-access-request.v1",
      });
    }
    if (!canReviewRequest(session, request)) {
      return sendJson(res, 403, {
        ok: false,
        error: "digital_employee_access_review_required",
        contractVersion: "digital-employee-access-request.v1",
      });
    }
    const input = await readJsonBody(req, 16 * 1024);
    const outcome = cleanText(input.decision || input.outcome);
    const nextStatus = {
      approve: "approved",
      approved: "approved",
      reject: "rejected",
      rejected: "rejected",
      revoke: "revoked",
      revoked: "revoked",
    }[outcome];
    if (!nextStatus) {
      return sendJson(res, 400, {
        ok: false,
        error: "digital_employee_access_decision_required",
        contractVersion: "digital-employee-access-request.v1",
      });
    }
    const now = new Date().toISOString();
    const saved = store.saveDigitalEmployeeAccessRequest({
      ...request,
      status: nextStatus,
      updatedAt: now,
      decision: {
        outcome: nextStatus,
        decidedAt: now,
        note: cleanText(input.note),
        decidedBy: session,
      },
    });
    return sendJson(res, 200, {
      ok: true,
      status: nextStatus,
      contractVersion: "digital-employee-access-request.v1",
      accessRequest: saved,
    });
  }

  async function updateDesktopAvailability(req, res, employeeId) {
    const session = requireSession(req, res);
    if (!session) return null;
    const employee = currentEmployees().find((item) => cleanId(item.id) === cleanId(employeeId));
    if (!employee) {
      return sendJson(res, 404, {
        ok: false,
        error: "digital_employee_not_found",
        contractVersion: "desktop-channel-availability.v1",
      });
    }
    if (!canReviewAll(session)) {
      return sendJson(res, 403, {
        ok: false,
        error: "desktop_channel_availability_admin_required",
        message: "只有平台治理角色可以调整数字员工的桌面端可用状态。",
        contractVersion: "desktop-channel-availability.v1",
      });
    }
    const input = await readJsonBody(req, 4 * 1024);
    if (typeof input.enabled !== "boolean") {
      return sendJson(res, 422, {
        ok: false,
        error: "desktop_channel_availability_enabled_required",
        message: "enabled 必须是布尔值。",
        contractVersion: "desktop-channel-availability.v1",
      });
    }
    const saved = store.saveDesktopChannelAvailability({
      employeeId: employee.id,
      enabled: input.enabled,
      updatedAt: new Date().toISOString(),
      updatedBy: safeActor(session),
    });
    return sendJson(res, 200, {
      ok: true,
      contractVersion: "desktop-channel-availability.v1",
      desktopAvailability: saved,
      digitalEmployee: withDesktopChannelAvailability([employee])[0],
      message: input.enabled ? "该数字员工已恢复桌面端可用。" : "该数字员工已关闭桌面端；不影响其他渠道或运行中的任务。",
    });
  }

  function currentEmployees() {
    const employees = typeof getDigitalEmployees === "function" ? getDigitalEmployees() : [];
    return withDesktopChannelAvailability(Array.isArray(employees) ? employees : []);
  }

  function withDesktopChannelAvailability(employees = []) {
    const availabilityByEmployeeId = new Map(store.readDesktopChannelAvailability()
      .map((item) => [cleanId(item.employeeId), item]));
    return (Array.isArray(employees) ? employees : []).map((employee) => {
      const availability = availabilityByEmployeeId.get(cleanId(employee.id));
      if (!availability) return employee;
      return {
        ...employee,
        desktopAvailable: availability.enabled,
        channelConfig: {
          ...(employee.channelConfig || {}),
          desktop: {
            ...(employee.channelConfig?.desktop || {}),
            enabled: availability.enabled,
          },
        },
      };
    });
  }

  async function projectDesktopEmployee(employee, session, accessRequests) {
    const access = evaluateDigitalEmployeeEntitlement({ accessRequests, channelId: "desktop", employee, session });
    const dependencyContext = access.callable ? assembleDigitalEmployeeDependencyContext({
      businessSkills: currentBusinessSkills(),
      channel: { channel: "desktop", sourceSystemId: "desktop-device-channel" },
      employee,
    }) : null;
    const materialInputContracts = dependencyContext && typeof skillHarnessRunner?.materialInputContracts === "function"
      ? await skillHarnessRunner.materialInputContracts(dependencyContext.skillScope.callableSkillIds)
      : [];
    const character = typeof getDesktopCharacter === "function" ? getDesktopCharacter(employee.id) : null;
    return projectDesktopEmployeeFields(employee, access, dependencyContext, materialInputContracts, character);
  }

  function currentBusinessSkills() {
    const skills = typeof getBusinessSkills === "function" ? getBusinessSkills() : [];
    return Array.isArray(skills) ? skills : [];
  }

  function ownAccessRequests(requests, session) {
    const actorId = accessRequestActorId(session);
    return requests.filter((request) => request.applicant?.id === actorId);
  }

  function canReviewAll(session) {
    const permissions = session.permissions || [];
    return session.role === "admin" || hasPermission(permissions, "system:*") || hasPermission(permissions, "digital-employees:*");
  }

  function canReviewRequest(session, request) {
    if (canReviewAll(session)) return true;
    const managed = new Set(Array.isArray(session.managedDepartmentIds) ? session.managedDepartmentIds : []);
    return managed.has("*") || managed.has(request.target?.ownerDepartmentId);
  }
}

function projectDesktopEmployeeFields(employee, access, dependencyContext, materialInputContracts, character) {
  return {
    id: cleanId(employee.id),
    name: cleanText(employee.name || employee.title || employee.id),
    title: cleanText(employee.title),
    level: cleanText(employee.level),
    status: cleanText(employee.status),
    version: cleanText(employee.version),
    departmentId: cleanText(employee.departmentId),
    department: cleanText(employee.department),
    ownerDepartmentId: cleanText(employee.ownerDepartmentId || employee.departmentId),
    departmentIds: cleanList(employee.departmentIds || [employee.ownerDepartmentId, employee.departmentId]),
    departmentNames: cleanList(employee.departmentNames || [employee.department]),
    authorizedDepartmentIds: cleanList(employee.authorizedDepartmentIds || []),
    authorizedDepartmentNames: cleanList(employee.authorizedDepartmentNames || []),
    permissionSummary: cleanText(employee.permissionSummary),
    character,
    runtimeEvidence: safeRuntimeEvidence(employee.runtimeEvidence),
    tools: safeDesktopTools(employee.toolBindings || employee.tools),
    runtimeSkills: {
      contractVersion: "desktop-callable-skill-materials.v1",
      callableSkillIds: dependencyContext?.skillScope?.callableSkillIds || [],
      materialInputContracts,
    },
    access,
  };
}

function safeDesktopTools(tools = []) {
  if (!Array.isArray(tools)) return [];
  return tools
    .filter((tool) => tool?.enabled !== false)
    .map((tool) => {
      const credentialBoundary = cleanText(tool?.credentialBoundary);
      const identityModes = cleanList(tool?.identityModes).map((mode) => mode.toLowerCase());
      const declaredCredentialMode = cleanId(tool?.credentialMode).replaceAll("-", "_");
      const supportedCredentialModes = new Set(["current_user_bearer", "center_current_user_lease", "device_session_refresh"]);
      const structuredCurrentUserBearer = declaredCredentialMode === "current_user_bearer";
      // Compatibility for bindings created before identityModes was projected to Desktop.
      const legacyCurrentUserBearer = !declaredCredentialMode && (
        identityModes.includes("current-user short-lived bearer") ||
        identityModes.length === 0 && /bearer/i.test(credentialBoundary) && /临时|短期|current.*session|当前.*会话/i.test(credentialBoundary)
      );
      const currentUserBearer = structuredCurrentUserBearer || legacyCurrentUserBearer;
      const credentialMode = supportedCredentialModes.has(declaredCredentialMode)
        ? declaredCredentialMode
        : currentUserBearer ? "current_user_bearer" : "";
      return {
        id: cleanId(tool?.id || tool?.toolId),
        name: cleanText(tool?.name || tool?.displayName || tool?.id),
        credentialMode,
        temporaryCredentialRequired: credentialMode === "current_user_bearer",
      };
    })
    .filter((tool) => tool.id);
}

function safeRuntimeEvidence(evidence = {}) {
  return {
    healthStatus: cleanText(evidence.healthStatus),
    modelStatus: cleanText(evidence.modelStatus),
    runtimeStatus: cleanText(evidence.runtimeStatus),
    evidenceLabel: cleanText(evidence.evidenceLabel),
  };
}

function dispatchTransportMethod(operation = "") {
  return {
    cancel: "cancel",
    claim: "claim",
    settle: "settle",
  }[operation] || "";
}

function safeActor(session = {}) {
  return {
    name: cleanText(session.name),
    department: cleanText(session.department),
    departmentId: cleanText(session.departmentId),
    role: cleanText(session.role),
    identitySource: cleanText(session.identitySource),
    authorization: {
      accountStatus: cleanText(session.authorization?.accountStatus),
      permissionVersion: cleanText(session.authorization?.permissionVersion),
      lastVerifiedAt: cleanText(session.authorization?.lastVerifiedAt),
      validUntil: cleanText(session.authorization?.validUntil),
    },
  };
}

function cleanId(value) {
  return String(value || "").trim().toLowerCase().replace(/[^a-z0-9._-]+/g, "-").slice(0, 120);
}

function cleanText(value) {
  return String(value || "").replace(/\s+/g, " ").trim().slice(0, 800);
}

function cleanList(values = []) {
  return [...new Set((Array.isArray(values) ? values : [values]).map(cleanText).filter(Boolean))];
}
