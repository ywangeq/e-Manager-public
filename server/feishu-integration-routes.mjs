import {
  buildConnectionDraft,
  buildConnectionWorkerBinding,
  feishuAppConsoleUrl,
  feishuPermissionUrl,
  normalizeFeishuAppId,
  resolveCallbackPublicUrl,
  validateConnectionInput,
} from "./channels/feishu/connection-draft.mjs";
import { createFeishuConnectionTester } from "./channels/feishu/connection-test.mjs";
import { createFeishuCredentialValidator } from "./channels/feishu/tenant-token-validator.mjs";
import { createFeishuAdapterRegistrationService } from "./channels/feishu/adapter-registration.mjs";
import { createFeishuChannelExtensionService } from "./channels/feishu/channel-extension-routes.mjs";
import { createFeishuEventGateway } from "./channels/feishu/event-gateway.mjs";
import {
  buildFeishuEventPath,
  buildFeishuIntegrationPath,
  createFeishuIntegrationRouteRegistry,
} from "./channels/feishu/integration-route-registry.mjs";
import { createFeishuEmployeeAgentRuntime } from "./channels/feishu/algorithm-agent-runtime.mjs";
import { createFeishuTurnDispatcher } from "./channels/feishu/turn-dispatcher.mjs";
import { LEGACY_ALGORITHM_EMPLOYEE_ID } from "./digital-employee-identity-compatibility.mjs";
import { withFeishuRuntimeEvidence } from "./channels/feishu/runtime-evidence.mjs";
import { createFeishuEmployeeRuntimeRouteHandlers } from "./channels/feishu/runtime-routes.mjs";
import { createSkillHarnessRunner } from "./skill-harness-runner.mjs";
import {
  ALGORITHM_RUNTIME_RESOURCE_DEFS,
  BUSINESS_DOMAIN,
  CHANNEL_INTENT_OPTIONS,
  CONNECTION_AUTOMATION_STEPS,
  CONNECTION_REQUIRED_FIELDS,
  CONTRACT_VERSION,
  CONVERSATION_GATEWAY_BOUNDARY,
  DEFAULT_CAPABILITIES,
  DEPARTMENT_ID,
  EMPLOYEE_ID,
  FEISHU_EVENT_CALLBACK_PATH,
  LEGACY_FEISHU_EVENT_CALLBACK_PATH,
  FORBIDDEN_MESSAGE_FIELDS,
  HIGH_RISK_ACTIONS,
  MESSAGE_DELIVERY_OPTIONS,
  POST_APPROVAL_CHANNEL_ACTIONS,
  ROOT_SKILL_ID,
  SAFE_SUMMARY,
  SOURCE_SYSTEM_ID,
  SOURCE_SYSTEM_NAME,
  actorDigest,
  actorDisplay,
  actorSummary,
  algorithmRuntimeResourceSetup,
  buildFeishuMessagePreview,
  channelIntentLabelText,
  chinaDate,
  cleanShortText,
  cleanText,
  connectionForSession,
  createFeishuIntegrationStore,
  defaultCleanList,
  defaultCleanText,
  feishuWebhookUrl,
  hasPlatformGovernance,
  hasUnsafeText,
  isHttpsUrl,
  isCancelableApplicationStatus,
  isPendingStatus,
  isPersonalScope,
  maskIdentifier,
  normalizeAllowedChatRefs,
  normalizeConnectionMode,
  sanitizeApplication,
  sortUpdatedDesc,
  storePersistenceNote,
  summarizeRequestedSkill,
  uniqueList,
} from "./feishu-integration-support.mjs";

export function createFeishuIntegrationHandlers({
  aiProviderCredentials = [],
  aiProviderRoutes = [],
  businessSkills = [],
  checkpointRepository,
  cleanList = defaultCleanList,
  cleanText = defaultCleanText,
  controlPlaneStore,
  contextCompactionPolicy,
  createSessionRoute,
  digitalEmployees = [],
  getAiProviderCredentials = () => aiProviderCredentials,
  getAiProviderRoutes = () => aiProviderRoutes,
  getDigitalEmployees = () => digitalEmployees,
  getBusinessSkills,
  fetch = globalThis.fetch,
  providerRequestQueue,
  providerCredentialSecretStore,
  readJsonBody,
  requireSession,
  runtimeInfrastructureStore,
  runtimeEvidenceRecorder = null,
  runtimeEfficiencyRecorder = null,
  runtimeProvenanceRecorder = null,
  sendJson,
  store: injectedStore = null,
  storePath,
  runtimeTaskService = null,
  persistentTaskExecution = false,
  sessionRepository,
}) {
  if (typeof createSessionRoute !== "function" || !sessionRepository || !checkpointRepository) {
    throw new TypeError("Feishu integration requires Session Foundation route, repository, and checkpoint repository");
  }
  const store = injectedStore || createFeishuIntegrationStore({ storePath });
  const routeRegistry = createFeishuIntegrationRouteRegistry([
    {
      employeeId: EMPLOYEE_ID,
      legacyIntegrationBase: "/api/feishu/integration/algorithm-worker",
      legacyEventPath: LEGACY_FEISHU_EVENT_CALLBACK_PATH,
      legacyEmployeeIds: [],
    },
  ]);
  const algorithmIntegrationBase = buildFeishuIntegrationPath(EMPLOYEE_ID);
  const algorithmEventPath = buildFeishuEventPath(EMPLOYEE_ID);
  let generatedIdSequence = 0;
  let eventGateway = null;
  const skillHarnessRunner = createSkillHarnessRunner({
    getPublishedSkills: (options = {}) => typeof getBusinessSkills === "function" ? getBusinessSkills(options) : businessSkills,
  });
  const agentRuntime = createFeishuEmployeeAgentRuntime({
    employeeId: EMPLOYEE_ID,
    aiProviderCredentials,
    aiProviderRoutes,
    businessSkills,
    contextCompactionPolicy,
    digitalEmployees,
    getAiProviderCredentials,
    getAiProviderRoutes,
    getDigitalEmployees,
    fetch,
    getBusinessSkills,
    isTaskCancellationRequested: (task) => runtimeTaskService?.isCancellationRequested?.(task) ?? store.readRuntimeTasks().some((item) => item.id === task.id && item.status === "canceled"),
    ...(providerRequestQueue ? { providerRequestQueue } : {}),
    providerCredentialSecretStore,
    recordRuntimeEvidence: runtimeEvidenceRecorder,
    recordRuntimeEfficiency: runtimeEfficiencyRecorder,
    recordRuntimeProvenance: runtimeProvenanceRecorder,
  });
  const turnDispatcher = createFeishuTurnDispatcher({
    agentRuntime,
    businessSkills,
    getBusinessSkills,
  });
  const validateFeishuCredentials = createFeishuCredentialValidator({ fetch });
  const adapterRegistrationService = createFeishuAdapterRegistrationService({
    getDigitalEmployees,
    readJsonBody,
    requireSession,
    sendJson,
    store,
    validateFeishuCredentials,
  });
  const channelExtensionService = createFeishuChannelExtensionService({
    getDigitalEmployees,
    readJsonBody,
    requireSession,
    sendJson,
    store,
  });
  const connectionTester = createFeishuConnectionTester({
    employeeId: EMPLOYEE_ID,
    employeeName: "算法数字员工",
    fetch,
    store,
    validateFeishuCredentials,
  });
  const runtimeRoutes = createFeishuEmployeeRuntimeRouteHandlers({
    employeeId: EMPLOYEE_ID,
    findEmployee: findAlgorithmEmployee,
    readJsonBody,
    requireSession,
    runtimeInfrastructureStore,
    runtimeTaskService,
    sendJson,
    store,
    resourceDefinitions: ALGORITHM_RUNTIME_RESOURCE_DEFS,
    resolveResourceSetup: ({ resourceMonitors }) => algorithmRuntimeResourceSetup(resourceMonitors),
  });

  async function handle(req, res, url) {
    const registrationResult = await adapterRegistrationService.handle(req, res, url);
    if (registrationResult !== undefined || res.headersSent) return registrationResult;
    const channelExtensionResult = await channelExtensionService.handle(req, res, url);
    if (channelExtensionResult !== undefined || res.headersSent) return channelExtensionResult;
    const integrationRoute = routeRegistry.resolve(url.pathname);
    if (integrationRoute?.matched && !integrationRoute.registered) {
      sendJson(res, 404, {
        ok: false,
        error: "feishu_employee_integration_not_registered",
        employeeId: integrationRoute.employeeId,
        message: "该数字员工尚未注册飞书 Channel/Runtime 适配器。",
      });
      return true;
    }
    if (integrationRoute?.legacy && integrationRoute.kind === "integration" && !["GET", "HEAD", "OPTIONS"].includes(req.method)) {
      sendJson(res, 409, {
        ok: false,
        error: "digital_employee_identity_alias_read_only",
        canonicalEmployeeId: integrationRoute.employeeId,
        message: "旧算法员工标识只用于读取兼容；请刷新目录后使用新的 employeeId。",
      });
      return true;
    }
    const routedUrl = integrationRoute ? withPathname(url, integrationRoute.internalPath) : url;

    if (req.method === "GET" && routedUrl.pathname === `${algorithmIntegrationBase}/draft`) {
      await getAlgorithmDraft(req, res);
      return true;
    }

    if (req.method === "POST" && routedUrl.pathname === `${algorithmIntegrationBase}/apply`) {
      await applyAlgorithmAccess(req, res);
      return true;
    }

    if (req.method === "POST" && routedUrl.pathname === `${algorithmIntegrationBase}/cancel`) {
      await cancelAlgorithmAccess(req, res);
      return true;
    }

    if (req.method === "GET" && routedUrl.pathname === `${algorithmIntegrationBase}/connection`) {
      await getAlgorithmConnection(req, res, integrationRoute);
      return true;
    }

    if (req.method === "POST" && routedUrl.pathname === `${algorithmIntegrationBase}/connect`) {
      await connectAlgorithmWorker(req, res);
      return true;
    }

    if (req.method === "POST" && routedUrl.pathname === `${algorithmIntegrationBase}/connection/event-subscription`) {
      await confirmAlgorithmEventSubscription(req, res);
      return true;
    }

    if (req.method === "POST" && routedUrl.pathname === `${algorithmIntegrationBase}/connection/test`) {
      await testAlgorithmConnection(req, res);
      return true;
    }

    if (req.method === "POST" && routedUrl.pathname === `${algorithmIntegrationBase}/message-test`) {
      await testAlgorithmMessage(req, res);
      return true;
    }

    if (await runtimeRoutes.handle(req, res, routedUrl)) {
      return true;
    }

    if (req.method === "POST" && routedUrl.pathname === algorithmEventPath) {
      await handleAlgorithmEvent(req, res);
      return true;
    }

    return undefined;
  }

  function getAlgorithmDraft(req, res) {
    const session = requireSession(req, res);
    if (!session) return undefined;
    const employee = findAlgorithmEmployee();
    if (!employee) {
      return sendJson(res, 404, {
        ok: false,
        error: "algorithm_employee_not_found",
        contractVersion: CONTRACT_VERSION,
      });
    }

    return sendJson(res, 200, {
      ok: true,
      status: "ready",
      contractVersion: CONTRACT_VERSION,
      draft: buildAccessDraft({ employee, session }),
      recentApplications: readApplicationsWithCapabilityState().slice(0, 5),
      recentMessageTests: store.readMessageTests().slice(0, 5),
      runtime: runtimeRoutes.buildRuntimeSummary({ employee, session }),
      persistence: storePersistenceNote(),
    });
  }

  async function applyAlgorithmAccess(req, res) {
    const session = requireSession(req, res);
    if (!session) return undefined;
    const employee = findAlgorithmEmployee();
    if (!employee) {
      return sendJson(res, 404, {
        ok: false,
        error: "algorithm_employee_not_found",
        contractVersion: CONTRACT_VERSION,
      });
    }

    const input = await readJsonBody(req);
    if (hasUnsafeText([input.problemSummary, input.expectedOutput, input.requestScope, ...cleanList(input.evidenceRefs || input.evidenceRef), ...requestedGroupNames(input)])) {
      return sendJson(res, 422, {
        ok: false,
        error: "unsafe_feishu_access_payload",
        contractVersion: CONTRACT_VERSION,
        forbiddenFields: FORBIDDEN_MESSAGE_FIELDS,
      });
    }

    const scopeDecision = resolveApplicationScope({ employee, input, session });
    if (!scopeDecision.ok) {
      return sendJson(res, scopeDecision.statusCode || 403, {
        ok: false,
        error: scopeDecision.error,
        message: scopeDecision.message,
        contractVersion: CONTRACT_VERSION,
        allowedScopes: scopeDecision.allowedScopes,
        postApprovalChannelActions: scopeDecision.postApprovalChannelActions,
      });
    }
    const skillSelection = resolveSelectedSkills({ employee, input });
    if (skillSelection.invalidSkillIds.length) {
      return sendJson(res, 422, {
        ok: false,
        error: "feishu_skill_scope_not_allowed",
        message: "只能申请该数字员工已声明的 Skill 功能。",
        contractVersion: CONTRACT_VERSION,
        invalidSkillIds: skillSelection.invalidSkillIds,
      });
    }

    const now = new Date().toISOString();
    const application = buildApplicationDraft({ employee, input, session, now, scopeDecision, skillSelection });
    const capabilityRequest = controlPlaneStore.saveCapabilityRequest(application.capabilityRequest);
    const savedApplication = store.saveApplication({
      ...application,
      capabilityRequestId: capabilityRequest.id,
      status: capabilityRequest.status,
      updatedAt: now,
    });

    return sendJson(res, 202, {
      ok: true,
      status: "pending_review",
      contractVersion: CONTRACT_VERSION,
      application: savedApplication,
      capabilityRequest,
      messagePreview: buildFeishuMessagePreview({
        employee,
        requestId: capabilityRequest.id,
        status: "pending_review",
        sceneType: savedApplication.sceneType,
        requestScope: savedApplication.requestScope,
        channelIntent: savedApplication.channelIntentLabels?.length
          ? savedApplication.channelIntentLabels
          : { id: savedApplication.channelIntent, label: savedApplication.channelIntentLabel },
        requestedGroupNames: savedApplication.requestedGroupNames,
        selectedSkills: savedApplication.selectedSkills,
        highRisk: savedApplication.writebackIntent,
      }),
      nextGate: savedApplication.writebackIntent
        ? "平台管理员、研发负责人和写回/远程执行负责人确认后才能开放。"
        : "平台管理员和研发负责人审核飞书入口、员工启用状态、Channel 范围和质量回流。",
    });
  }

  async function cancelAlgorithmAccess(req, res) {
    const session = requireSession(req, res);
    if (!session) return undefined;
    const input = await readJsonBody(req);
    if (hasUnsafeText([input.reason])) {
      return sendJson(res, 422, {
        ok: false,
        error: "unsafe_feishu_cancel_payload",
        contractVersion: CONTRACT_VERSION,
        forbiddenFields: FORBIDDEN_MESSAGE_FIELDS,
      });
    }

    const target = findApplication(input);
    if (!target) {
      return sendJson(res, 404, {
        ok: false,
        error: "feishu_application_not_found",
        message: "未找到可撤销的飞书申请。",
        contractVersion: CONTRACT_VERSION,
      });
    }
    if (!isCancelableApplicationStatus(target.status)) {
      return sendJson(res, 409, {
        ok: false,
        error: "feishu_application_not_pending",
        message: "只有待审或已通过但未完成真实消息联通的申请可以撤销。",
        contractVersion: CONTRACT_VERSION,
        application: target,
      });
    }
    const currentConnection = store.readConnection(EMPLOYEE_ID);
    const connectionMatchesTarget = currentConnection.applicationId === target.id ||
      (target.capabilityRequestId && currentConnection.capabilityRequestId === target.capabilityRequestId);
    if (connectionMatchesTarget && currentConnection.status === "connected") {
      return sendJson(res, 409, {
        ok: false,
        error: "feishu_connection_already_completed",
        message: "飞书真实消息联通已完成，不能用测试撤销入口清理；请走停用或变更流程。",
        contractVersion: CONTRACT_VERSION,
        application: target,
        connection: currentConnection,
      });
    }

    const now = new Date().toISOString();
    const actor = actorSummary(session);
    const reason = cleanText(input.reason || "申请人主动撤销");
    const relatedApplications = relatedCancelableApplications(target);
    const canceledApplications = relatedApplications.map((application) => store.saveApplication({
      ...application,
      status: "已撤销",
      cancellationReason: reason,
      canceledAt: now,
      canceledBy: actor,
      updatedAt: now,
    }));
    const canceledApplication = canceledApplications.find((application) => application.id === target.id) || canceledApplications[0] || target;
    const existingCapabilityRequest = canceledApplication.capabilityRequestId && typeof controlPlaneStore.readCapabilityRequests === "function"
      ? controlPlaneStore.readCapabilityRequests().find((request) => request.id === canceledApplication.capabilityRequestId)
      : null;
    const canceledCapabilityRequest = canceledApplication.capabilityRequestId
      ? controlPlaneStore.saveCapabilityRequest({
          ...existingCapabilityRequest,
          id: canceledApplication.capabilityRequestId,
          status: "已撤销",
          updatedAt: now,
          safeSummary: [existingCapabilityRequest?.safeSummary, `申请已撤销：${reason}`].filter(Boolean).join(" "),
        })
      : null;

    return sendJson(res, 200, {
      ok: true,
      status: "canceled",
      contractVersion: CONTRACT_VERSION,
      application: canceledApplication,
      canceledApplications,
      capabilityRequest: canceledCapabilityRequest,
      message: "飞书申请已撤销；可重新提交测试申请。",
    });
  }

  async function getAlgorithmConnection(req, res, integrationRoute = null) {
    const session = requireSession(req, res);
    if (!session) return undefined;
    const connection = withFeishuAdminAppLinks(connectionForSession(store.readConnection(EMPLOYEE_ID), session), session);
    return sendJson(res, 200, {
      ok: true,
      status: connection.status || "not_configured",
      contractVersion: CONTRACT_VERSION,
      connection,
      connectDraft: buildConnectionDraft({
        req,
        employee: findAlgorithmEmployee() || { id: EMPLOYEE_ID, name: "算法数字员工" },
        connection,
        canEditConnection: hasPlatformGovernance(session),
        callbackPath: integrationRoute?.publicEventPath || FEISHU_EVENT_CALLBACK_PATH,
      }),
      recentApplications: readApplicationsWithCapabilityState().slice(0, 5),
      persistence: {
        ...storePersistenceNote(),
        note: "连接摘要保存到 ignored MVP 文件；App Secret 只以服务端加密密文保存，接口不会回显。Verification token 和 encrypt key 仅在 HTTPS 回调高级模式下保存。",
      },
    });
  }

  function nextRecordId(prefix = "FEISHU") {
    generatedIdSequence = (generatedIdSequence + 1) % 100000;
    return `${prefix}-${Date.now()}-${String(generatedIdSequence).padStart(5, "0")}`;
  }

  function feishuEventGateway() {
    if (!eventGateway) {
      eventGateway = createFeishuEventGateway({
        checkpointRepository,
        createSessionRoute,
        employeeId: EMPLOYEE_ID,
        controlPlaneStore,
        fetch,
        resolveEmployee: findAlgorithmEmployee,
        resolveRuntimeResourceSetup: ({ resourceMonitors }) => algorithmRuntimeResourceSetup(resourceMonitors),
        runtimeTaskService,
        persistentTaskExecution,
        skillHarnessRunner,
        sessionRepository,
        nextRecordId,
        store,
        turnDispatcher,
        validateFeishuCredentials,
      });
    }
    return eventGateway;
  }

  function resolvePersistentTaskExecutor(task) {
    return feishuEventGateway().resolvePersistentTaskExecutor(task);
  }

  function withFeishuAdminAppLinks(connection = {}, session = {}) {
    if (!hasPlatformGovernance(session)) return connection;
    const savedAppId = normalizeFeishuAppId(store.readSecret("appId", EMPLOYEE_ID));
    if (!savedAppId) return connection;
    return {
      ...connection,
      appConsoleUrl: feishuAppConsoleUrl(savedAppId),
      permissionUrl: feishuPermissionUrl(savedAppId),
    };
  }

  async function connectAlgorithmWorker(req, res) {
    const session = requireSession(req, res);
    if (!session) return undefined;
    const input = await readJsonBody(req, 1024 * 128);
    const currentConnection = store.readConnection(EMPLOYEE_ID);
    const application = findApplication(input) || latestOwnApplication(session);
    if (!canManageConnection(session, application)) {
      return sendJson(res, 403, {
        ok: false,
        error: "feishu_connection_governance_required",
        message: "只有平台治理角色才能补充飞书联通资料。",
        contractVersion: CONTRACT_VERSION,
      });
    }
    const allowedChatRefs = normalizeAllowedChatRefs(input.allowedChatRefs || input.allowedChats || input.allowedChatNames || input.allowedGroups || input.requestedGroupNames);
    if (hasUnsafeText([
      input.credentialOwnerName,
      input.callbackPublicUrl,
      ...allowedChatRefs.map((item) => `${item.name} ${item.feishuId}`),
    ])) {
      return sendJson(res, 422, {
        ok: false,
        error: "unsafe_feishu_connection_payload",
        contractVersion: CONTRACT_VERSION,
        forbiddenFields: FORBIDDEN_MESSAGE_FIELDS,
      });
    }

    const inputAppId = cleanShortText(input.appId || input.feishuAppId);
    const savedAppId = normalizeFeishuAppId(store.readSecret("appId", EMPLOYEE_ID));
    const appId = normalizeFeishuAppId(inputAppId) || (!inputAppId || inputAppId === maskIdentifier(savedAppId) ? savedAppId : inputAppId);
    const appSecret = String(input.appSecret || input.feishuAppSecret || store.readSecret("appSecret", EMPLOYEE_ID) || "").trim();
    const verificationToken = String(input.verificationToken || input.eventVerificationToken || store.readSecret("verificationToken", EMPLOYEE_ID) || "").trim();
    const encryptKey = String(input.encryptKey || input.eventEncryptKey || store.readSecret("encryptKey", EMPLOYEE_ID) || "").trim();
    const connectionMode = normalizeConnectionMode(input.connectionMode || input.eventReceiveMode || input.receiveMode);
    const callbackPublicUrl = input.callbackPublicUrl || currentConnection.callbackPublicUrl || "";
    const validation = validateConnectionInput({
      appId,
      appSecret,
      verificationToken,
      callbackPublicUrl,
      connectionMode,
    });
    if (!validation.ok) {
      return sendJson(res, 422, {
        ok: false,
        error: validation.error,
        message: validation.message,
        contractVersion: CONTRACT_VERSION,
        requiredFields: CONNECTION_REQUIRED_FIELDS,
      });
    }

    const credentialCheck = await validateFeishuCredentials({ appId, appSecret });
    if (!credentialCheck.ok) {
      return sendJson(res, 422, {
        ok: false,
        error: "feishu_credential_validation_failed",
        message: credentialCheck.message,
        contractVersion: CONTRACT_VERSION,
        tokenCheck: credentialCheck.safeSummary,
      });
    }

    const now = new Date().toISOString();
    const publicCallbackUrl = connectionMode === "webhook"
      ? resolveCallbackPublicUrl(req, callbackPublicUrl || process.env.FEISHU_ALGORITHM_CALLBACK_PUBLIC_URL || "", algorithmEventPath)
      : "";
    const channelIntentIds = cleanList(input.channelIntentIds || input.channelIntents).length
      ? cleanList(input.channelIntentIds || input.channelIntents)
      : ["personal_chat", "ops_group_smoke"];
    const savedConnection = store.saveConnection({
      applicationId: application?.id || cleanShortText(input.applicationId),
      applicationEnabled: true,
      capabilityRequestId: application?.capabilityRequestId || cleanShortText(input.capabilityRequestId || input.requestId),
      credentialOwnerType: cleanShortText(input.credentialOwnerType || "platform_admin"),
      credentialOwnerName: cleanShortText(input.credentialOwnerName || actorDisplay(session)),
      connectionMode,
      eventReceiveMode: connectionMode === "webhook" ? "http_callback" : "websocket_long_connection",
      appId,
      appSecret,
      verificationToken,
      encryptKey,
      callbackPublicUrl: publicCallbackUrl,
      allowedChatRefs,
      allowedChatNames: allowedChatRefs.map((item) => item.name || item.feishuId).filter(Boolean).slice(0, 12),
      channelIntentIds,
      workerBinding: buildConnectionWorkerBinding({
        application,
        connection: { employeeId: EMPLOYEE_ID, allowedChatRefs, channelIntentIds },
        status: "waiting_for_worker",
        now,
      }),
      tokenCheck: credentialCheck.safeSummary,
      eventSubscription: {
        ...(currentConnection.eventSubscription || {}),
        status: connectionMode === "webhook"
          ? isHttpsUrl(publicCallbackUrl) ? "waiting_for_feishu_challenge" : "needs_public_https_url"
          : "waiting_for_long_connection",
        receiveMode: connectionMode === "webhook" ? "http_callback" : "websocket_long_connection",
        requiredEvent: "im.message.receive_v1",
        callbackPath: connectionMode === "webhook" ? algorithmEventPath : "",
        lastChallengeAt: "",
        lastEventAt: "",
        longConnectionConfirmedAt: "",
        messageEventSubscribedAt: "",
        confirmedBy: {},
      },
      lastUpdatedBy: actorSummary(session),
      updatedAt: now,
      createdAt: now,
    }, EMPLOYEE_ID);
    const connection = withFeishuAdminAppLinks(connectionForSession(savedConnection, session), session);

    return sendJson(res, 200, {
      ok: true,
      status: connection.status,
      contractVersion: CONTRACT_VERSION,
      connection,
      automation: CONNECTION_AUTOMATION_STEPS,
      nextGate: connection.nextGate,
    });
  }

  async function confirmAlgorithmEventSubscription(req, res) {
    const session = requireSession(req, res);
    if (!session) return undefined;
    const input = await readJsonBody(req);
    const currentConnection = store.readConnection(EMPLOYEE_ID);
    const application = findApplication(input) || findApplication({
      applicationId: currentConnection.applicationId,
      capabilityRequestId: currentConnection.capabilityRequestId,
    }) || latestOwnApplication(session);
    if (!canManageConnection(session, application)) {
      return sendJson(res, 403, {
        ok: false,
        error: "feishu_connection_governance_required",
        message: "只有平台治理角色才能确认飞书事件订阅。",
        contractVersion: CONTRACT_VERSION,
      });
    }
    if (!["validated", "skipped_for_local_test"].includes(currentConnection.tokenCheck?.status)) {
      return sendJson(res, 409, {
        ok: false,
        error: "feishu_credentials_required",
        message: "请先保存并校验 App ID / App Secret，再触发事件订阅自动校验。",
        contractVersion: CONTRACT_VERSION,
      });
    }
    const connectionMode = normalizeConnectionMode(currentConnection.connectionMode || currentConnection.eventReceiveMode);
    const confirmedItems = uniqueList(input.confirmedItems || input.items || ["long_connection", "message_event", "card_action"]);
    const confirmsMessageEvent = confirmedItems.some((item) => /message|im\.message|receive/i.test(item));
    const confirmsCardAction = confirmedItems.some((item) => /card.*action|action.*trigger/i.test(item));
    if (connectionMode === "webhook" && !confirmsCardAction) {
      return sendJson(res, 409, {
        ok: false,
        error: "feishu_webhook_challenge_required",
        message: "HTTPS 回调模式需要通过飞书 challenge 自动确认；回答质量反馈回调只能单独由管理员确认。",
        contractVersion: CONTRACT_VERSION,
      });
    }

    const now = new Date().toISOString();
    const eventSubscription = currentConnection.eventSubscription || {};
    const savedConnection = store.saveConnection({
      ...currentConnection,
      eventSubscription: {
        ...eventSubscription,
        status: connectionMode === "webhook"
          ? eventSubscription.status
          : (confirmsMessageEvent || eventSubscription.messageEventSubscribedAt) ? "message_event_subscribed" : "long_connection_enabled",
        receiveMode: connectionMode === "webhook" ? "http_callback" : "websocket_long_connection",
        requiredEvent: "im.message.receive_v1",
        callbackPath: connectionMode === "webhook" ? algorithmEventPath : "",
        longConnectionConfirmedAt: connectionMode === "webhook" ? eventSubscription.longConnectionConfirmedAt : (eventSubscription.longConnectionConfirmedAt || now),
        messageEventSubscribedAt: confirmsMessageEvent ? now : eventSubscription.messageEventSubscribedAt,
        cardActionSubscribedAt: confirmsCardAction ? now : eventSubscription.cardActionSubscribedAt,
        confirmedBy: actorSummary(session),
      },
      lastUpdatedBy: actorSummary(session),
      updatedAt: now,
    }, EMPLOYEE_ID);
    const connection = withFeishuAdminAppLinks(connectionForSession(savedConnection, session), session);

    return sendJson(res, 200, {
      ok: true,
      status: connection.status,
      contractVersion: CONTRACT_VERSION,
      connection,
      nextGate: connection.nextGate,
    });
  }

  async function testAlgorithmConnection(req, res) {
    const session = requireSession(req, res);
    if (!session) return undefined;
    const input = await readJsonBody(req);
    const currentConnection = store.readConnection(EMPLOYEE_ID);
    const application = findApplication(input) || findApplication({
      applicationId: currentConnection.applicationId,
      capabilityRequestId: currentConnection.capabilityRequestId,
    }) || latestOwnApplication(session);
    if (!canManageConnection(session, application)) {
      return sendJson(res, 403, {
        ok: false,
        error: "feishu_connection_governance_required",
        message: "只有平台治理角色才能触发飞书真实联通测试。",
        contractVersion: CONTRACT_VERSION,
      });
    }
    if (!application || !isApprovedApplicationStatus(application.status)) {
      return sendJson(res, 409, {
        ok: false,
        error: "feishu_application_review_required",
        message: "飞书入口申请通过后才能进入长连接 worker 绑定和真实联通测试。",
        contractVersion: CONTRACT_VERSION,
        application,
      });
    }
    if (!["validated", "skipped_for_local_test"].includes(currentConnection.tokenCheck?.status)) {
      return sendJson(res, 409, {
        ok: false,
        error: "feishu_credentials_required",
        message: "请先保存并校验 App ID / App Secret，再启动联通测试。",
        contractVersion: CONTRACT_VERSION,
      });
    }

    const now = new Date().toISOString();
    const cooldown = connectionTester.connectionTestCooldown({ application, connection: currentConnection, now });
    if (cooldown && currentConnection.eventSubscription?.status !== "message_roundtrip_tested") {
      const connection = withFeishuAdminAppLinks(connectionForSession(currentConnection, session), session);
      const testResult = {
        ...(currentConnection.lastConnectionTest || {}),
        status: "test_click_rate_limited",
        checkedAt: currentConnection.lastConnectionTest?.checkedAt || now,
        retryAfterSeconds: cooldown.retryAfterSeconds,
        nextGate: `刚刚已经触发过飞书联通检查，请 ${cooldown.retryAfterSeconds} 秒后再点；如果已经在飞书里发了消息，等待 worker 回执即可。`,
      };
      return sendJson(res, 200, {
        ok: true,
        status: connection.status,
        contractVersion: CONTRACT_VERSION,
        connection,
        testResult,
        throttled: true,
        retryAfterSeconds: cooldown.retryAfterSeconds,
        nextGate: testResult.nextGate,
      });
    }
    connectionTester.markConnectionTestClick({ application, connection: currentConnection, now });
    const testResult = await connectionTester.runFeishuConnectionTest({ connection: currentConnection, application, now });
    const savedConnection = store.saveConnection({
      ...currentConnection,
      workerBinding: buildConnectionWorkerBinding({
        application,
        connection: currentConnection,
        status: testResult.worker?.status || "self_test_checked",
        now,
      }),
      lastConnectionTest: testResult,
      lastUpdatedBy: actorSummary(session),
      updatedAt: now,
    }, EMPLOYEE_ID);
    const connection = withFeishuAdminAppLinks(connectionForSession(savedConnection, session), session);
    store.saveMessageTest({
      id: nextRecordId("FCONN"),
      contractVersion: CONTRACT_VERSION,
      employeeId: EMPLOYEE_ID,
      employeeName: application.targetEmployeeName || "算法数字员工",
      sourceSystemId: SOURCE_SYSTEM_ID,
      sceneType: "飞书长连接联通测试",
      requestScope: application.requestScope || "本人先试用",
      requestScopeType: application.requestScopeType || "personal",
      channelIntent: application.channelIntent || "personal_chat",
      channelIntentLabel: application.channelIntentLabel || "本人/单聊试用",
      channelIntentIds: application.channelIntentIds,
      channelIntentLabels: application.channelIntentLabels,
      requestedGroupNames: application.requestedGroupNames,
      selectedSkillIds: application.selectedSkillIds,
      selectedSkills: application.selectedSkills,
      status: testResult.status,
      messageContractOk: true,
      delivery: testResult.delivery,
      invocationCheck: {
        status: "allowed",
        outcome: "connection_test_only",
        reason: "algorithm_runtime_not_executed",
        nextGate: "本步骤只验证飞书连接和机器人事件入口；任务执行由已启用运行器自动处理。",
      },
      submittedBy: actorSummary(session),
      submittedAt: now,
      updatedAt: now,
      warnings: ["联通测试不保存用户原话、raw prompt、token、App Secret、模型 trace 或客户原始数据。"],
    });

    return sendJson(res, 200, {
      ok: true,
      status: connection.status,
      contractVersion: CONTRACT_VERSION,
      connection,
      testResult,
      nextGate: testResult.nextGate || connection.nextGate,
    });
  }

  async function testAlgorithmMessage(req, res) {
    const session = requireSession(req, res);
    if (!session) return undefined;
    const employee = findAlgorithmEmployee();
    if (!employee) {
      return sendJson(res, 404, {
        ok: false,
        error: "algorithm_employee_not_found",
        contractVersion: CONTRACT_VERSION,
      });
    }

    const input = await readJsonBody(req);
    if (hasUnsafeText([input.problemSummary, input.expectedOutput, input.messageText, input.requestScope, ...cleanList(input.evidenceRefs || input.evidenceRef), ...requestedGroupNames(input)])) {
      return sendJson(res, 422, {
        ok: false,
        error: "unsafe_feishu_message_payload",
        contractVersion: CONTRACT_VERSION,
        forbiddenFields: FORBIDDEN_MESSAGE_FIELDS,
      });
    }

    const scopeDecision = resolveApplicationScope({ employee, input, session });
    if (!scopeDecision.ok) {
      return sendJson(res, scopeDecision.statusCode || 403, {
        ok: false,
        error: scopeDecision.error,
        message: scopeDecision.message,
        contractVersion: CONTRACT_VERSION,
        allowedScopes: scopeDecision.allowedScopes,
        postApprovalChannelActions: scopeDecision.postApprovalChannelActions,
      });
    }
    const skillSelection = resolveSelectedSkills({ employee, input });
    if (skillSelection.invalidSkillIds.length) {
      return sendJson(res, 422, {
        ok: false,
        error: "feishu_skill_scope_not_allowed",
        message: "只能测试该数字员工已声明的 Skill 功能。",
        contractVersion: CONTRACT_VERSION,
        invalidSkillIds: skillSelection.invalidSkillIds,
      });
    }

    const highRisk = Boolean(input.writebackIntent) || HIGH_RISK_ACTIONS.includes(cleanText(input.action));
    const sceneType = cleanText(input.sceneType || "飞书入口申请");
    const requestScope = scopeDecision.value;
    const channelIntents = resolveChannelIntents(input);
    const primaryChannelIntent = channelIntents[0];
    const requestedGroups = requestedGroupNames(input, channelIntents);
    const deliveryMode = resolveDeliveryMode(input);
    if (deliveryMode === "webhook" && !hasPlatformGovernance(session)) {
      return sendJson(res, 403, {
        ok: false,
        error: "feishu_webhook_test_governance_required",
        message: "真实 webhook 冒烟只能由管理员或治理角色触发；普通用户请使用 dry-run。",
        contractVersion: CONTRACT_VERSION,
        messageDeliveryOptions: buildMessageDeliveryOptions(session),
      });
    }
    const message = buildFeishuMessagePreview({
      employee,
      requestId: cleanText(input.requestId || "RD-FEISHU-ALG-DRYRUN"),
      status: highRisk ? "blocked" : "dry_run_passed",
      sceneType,
      requestScope,
      channelIntent: channelIntents,
      requestedGroupNames: requestedGroups,
      selectedSkills: skillSelection.selectedSkills,
      highRisk,
    });
    const invocationCheck = buildInvocationCheck({ employee, input, highRisk });
    const delivery = await deliverMessageIfRequested({ input, message });
    const now = new Date().toISOString();
    const messageTest = store.saveMessageTest({
      id: nextRecordId("FMSG"),
      contractVersion: CONTRACT_VERSION,
      employeeId: employee.id,
      employeeName: employee.name,
      sourceSystemId: SOURCE_SYSTEM_ID,
      sceneType,
      requestScope,
      requestScopeType: scopeDecision.requestScopeType,
      channelIntent: primaryChannelIntent.id,
      channelIntentLabel: primaryChannelIntent.label,
      channelIntentIds: channelIntents.map((intent) => intent.id),
      channelIntentLabels: channelIntents.map((intent) => intent.label),
      requestedGroupNames: requestedGroups,
      selectedSkillIds: skillSelection.selectedSkillIds,
      selectedSkills: skillSelection.selectedSkills,
      status: highRisk ? "blocked" : "dry_run_passed",
      messageContractOk: true,
      delivery,
      invocationCheck,
      submittedBy: actorSummary(session),
      submittedAt: now,
      updatedAt: now,
      warnings: [
        "默认 dry-run 只验证飞书消息安全摘要，不执行数字员工。",
        "飞书 Channel 不选择模型或审批普通会话；真实 Tool 调用仍按声明契约、目标系统 RBAC、风险和逐次确认授权。",
      ],
    });

    return sendJson(res, 200, {
      ok: true,
      status: messageTest.status,
      contractVersion: CONTRACT_VERSION,
      message,
      messageTest,
      delivery,
      invocationCheck,
    });
  }

  async function handleAlgorithmEvent(req, res) {
    const connection = store.readConnection(EMPLOYEE_ID);
    const rawInput = await readJsonBody(req, 1024 * 512);
    const gateway = feishuEventGateway();
    const eventInput = gateway.unwrapEncryptedEvent(rawInput, connection);
    if (!eventInput.ok) {
      return sendJson(res, 400, {
        ok: false,
        error: eventInput.error,
        message: eventInput.message,
        contractVersion: CONTRACT_VERSION,
      });
    }

    const event = eventInput.event;
    const tokenCheck = gateway.verifyEventToken(event, connection);
    if (!tokenCheck.ok) {
      return sendJson(res, 401, {
        ok: false,
        error: "feishu_event_token_mismatch",
        message: "飞书事件 token 校验失败。",
        contractVersion: CONTRACT_VERSION,
      });
    }

    const result = await gateway.recordFeishuEvent({
      callbackPath: algorithmEventPath,
      connection,
      event,
      receiveMode: "http_callback",
      submittedBy: { id: "feishu-event", name: "飞书事件回调", departmentId: "", role: "service" },
    });
    if (result.challenge) {
      return sendJson(res, 200, {
        challenge: result.challenge,
        ok: true,
        status: result.status,
      });
    }
    return sendJson(res, 200, result);
  }

  function findAlgorithmEmployee() {
    return getDigitalEmployees().find((employee) => employee.id === EMPLOYEE_ID);
  }

  function withRuntimeEvidence(employees = []) {
    return withFeishuRuntimeEvidence(employees, { store });
  }

  function readApplicationsWithCapabilityState() {
    const applications = store.readApplications();
    const capabilityRequests = typeof controlPlaneStore?.readCapabilityRequests === "function"
      ? controlPlaneStore.readCapabilityRequests()
      : [];
    const requestById = new Map(capabilityRequests.map((request) => [request.id, request]));
    return applications.map((application) => {
      const request = requestById.get(application.capabilityRequestId);
      if (!request) return application;
      return sanitizeApplication({
        ...application,
        status: request.status || application.status,
        reviewDecision: request.reviewDecision || application.reviewDecision,
        updatedAt: request.updatedAt || application.updatedAt,
      });
    }).sort(sortUpdatedDesc);
  }

  function findApplication(input = {}) {
    const applicationId = cleanShortText(input.applicationId || input.id);
    const capabilityRequestId = cleanShortText(input.capabilityRequestId || input.requestId);
    const sourceRequestId = cleanShortText(input.sourceRequestId);
    const applications = readApplicationsWithCapabilityState();
    if (applicationId) {
      return applications.find((application) => application.id === applicationId);
    }
    if (capabilityRequestId) {
      return applications.find((application) =>
        application.capabilityRequestId === capabilityRequestId && isPendingStatus(application.status)
      ) || applications.find((application) => application.capabilityRequestId === capabilityRequestId);
    }
    if (sourceRequestId) {
      return applications.find((application) =>
        application.sourceRequestId === sourceRequestId && isPendingStatus(application.status)
      ) || applications.find((application) => application.sourceRequestId === sourceRequestId);
    }
    return null;
  }

  function relatedCancelableApplications(target = {}) {
    const targetCapabilityRequestId = cleanText(target.capabilityRequestId);
    const targetSourceRequestId = cleanText(target.sourceRequestId);
    return readApplicationsWithCapabilityState().filter((application) => {
      if (application.targetEmployeeId !== target.targetEmployeeId) return false;
      if (!isCancelableApplicationStatus(application.status)) return false;
      if (targetCapabilityRequestId && application.capabilityRequestId === targetCapabilityRequestId) return true;
      if (targetSourceRequestId && application.sourceRequestId === targetSourceRequestId) return true;
      return application.id === target.id;
    });
  }

  function latestOwnApplication(session = {}) {
    const actorId = actorDigest(session);
    return readApplicationsWithCapabilityState().find((application) => application.submittedBy?.id === actorId) || null;
  }

  function canManageConnection(session = {}, application = null) {
    return hasPlatformGovernance(session);
  }

  function isApprovedApplicationStatus(status = "") {
    const text = cleanShortText(status);
    if (/撤销|取消|退回|拒绝|canceled|cancelled|rejected/i.test(text)) return false;
    return /已通过|通过审核|approved/i.test(text);
  }

  function buildAccessDraft({ employee, session }) {
    const canReview = hasPlatformGovernance(session);
    const scopeOptions = buildScopeOptions({ employee, session });
    const skillOptions = buildSkillOptions(employee);
    const defaultSelectedSkills = skillOptions.filter((skill) => skill.defaultSelected);
    const defaultSkillSelection = {
      selectedSkillIds: defaultSelectedSkills.map((skill) => skill.id),
      selectedSkills: defaultSelectedSkills,
    };
    const defaultScope = scopeOptions[0] || {};
    return {
      sourceSystemId: SOURCE_SYSTEM_ID,
      sourceSystemName: SOURCE_SYSTEM_NAME,
      targetEmployeeId: EMPLOYEE_ID,
      targetEmployeeName: employee.name,
      targetEmployeeStatus: employee.status,
      targetEmployeeVersion: employee.version,
      targetSkillId: ROOT_SKILL_ID,
      departmentId: DEPARTMENT_ID,
      businessDomain: BUSINESS_DOMAIN,
      userEntryActions: ["新建算法问题", "查我的申请", "补充材料", "反馈问题"],
      userRequiredFields: ["申请范围", "一句话说明", "申请群（群内测试时可选）", "材料链接（可选）"],
      hiddenTechnicalFields: ["employeeId", "skillApiId", "sourceSkillId", "Feishu App ID", "Feishu App Secret", "HTTP 回调 verification token / encrypt key", "webhook URL", "provider key"],
      adminApprovalActions: ["允许试运行入口", "确认凭证责任人", "要求补材料", "暂缓接入"],
      applicantMode: canReview ? "admin" : "personal",
      scopePolicy: canReview
        ? "管理员可为本人或其管辖部门提交初始化申请；飞书群由申请人提出需求，审批通过后再确认凭证责任人和开通方式。"
        : "普通用户只能申请本人范围；选择群内测试时可填写希望开通的群，审批通过后再确认凭证责任人和开通方式。",
      scopeOptions,
      channelIntentOptions: CHANNEL_INTENT_OPTIONS,
      messageDeliveryOptions: buildMessageDeliveryOptions(session),
      conversationGatewayBoundary: CONVERSATION_GATEWAY_BOUNDARY,
      defaultRequestScope: scopeOptions[0]?.value || "本人先试用",
      defaultRequestScopeType: scopeOptions[0]?.requestScopeType || "personal",
      defaultChannelIntent: CHANNEL_INTENT_OPTIONS[0].id,
      defaultChannelIntentIds: [CHANNEL_INTENT_OPTIONS[0].id],
      defaultMessageDeliveryMode: "dry_run",
      skillOptions,
      defaultSelectedSkillIds: defaultSkillSelection.selectedSkillIds,
      postApprovalChannelActions: POST_APPROVAL_CHANNEL_ACTIONS,
      processConfirmations: [
        {
          id: "personal",
          title: "普通用户申请流程",
          steps: ["本人范围", "提交场景说明/申请群", "管理员/负责人审核", "确认凭证责任人", "开通个人入口"],
        },
        {
          id: "admin",
          title: "管理员申请流程",
          steps: ["本人或管辖部门", "确认员工 Skill 开关", "审核群开通", "确认凭证责任人", "部门/个人实例继承配置"],
        },
      ],
      defaultCapabilities: DEFAULT_CAPABILITIES,
      deniedActions: HIGH_RISK_ACTIONS,
      capabilityRequestPayload: buildCapabilityRequestPayload({
        employee,
        scopeDecision: defaultScope,
        skillSelection: defaultSkillSelection,
      }),
      messageTemplate: buildFeishuMessagePreview({
        employee,
        requestId: "RD-FEISHU-ALG-ACCESS",
        status: "pending_review",
        sceneType: "飞书入口申请",
        requestScope: "本人先试用",
        channelIntent: [CHANNEL_INTENT_OPTIONS[0]],
        selectedSkills: defaultSelectedSkills,
        highRisk: false,
      }),
      readinessChecks: [
        { id: "session_mapped", label: "当前用户已映射平台会话", status: "通过" },
        { id: "employee_declared", label: "算法数字员工已登记", status: employee.id ? "通过" : "阻断" },
        { id: "personnel_review", label: "人员审批", status: employee.status === "在线" || employee.status === "试运行" ? "通过" : "待审核" },
        { id: "feishu_secret", label: "飞书连接凭证", status: feishuWebhookUrl() ? "可发送测试通知" : "待确认凭证责任人/服务端配置" },
        { id: "quality_feedback", label: "质量回流", status: "待接入" },
      ],
      canApply: true,
      canReview,
      privacyBoundary: "只交换飞书用户指令安全摘要、申请编号、门禁状态和 evidenceRef；默认长连接只录入 App Secret，HTTP 回调模式才录入 verification token / encrypt key，前端不保存这些凭证、raw prompt、客户原始数据或模型 trace。",
    };
  }

  function buildApplicationDraft({ employee, input, session, now, scopeDecision, skillSelection }) {
    const sceneType = cleanText(input.sceneType || "飞书入口申请");
    const requestScope = scopeDecision.value;
    const channelIntents = resolveChannelIntents(input);
    const primaryChannelIntent = channelIntents[0];
    const channelIntentLabels = channelIntents.map((intent) => intent.label);
    const requestedGroups = requestedGroupNames(input, channelIntents);
    const requestsGroupAccess = channelIntents.some((intent) => intent.id === "ops_group_smoke");
    const problemSummary = cleanText(input.problemSummary || "飞书入口接入算法数字员工，先开放只读分析和待确认清单。");
    const evidenceRefs = cleanList(input.evidenceRefs || input.evidenceRef);
    const writebackIntent = Boolean(input.writebackIntent);
    const sourceRequestId = cleanText(input.sourceRequestId || `${nextRecordId(`RD-FEISHU-ALG-ACCESS-${chinaDate(now)}-${actorDigest(session)}`)}`);
    const capabilityRequest = {
      ...buildCapabilityRequestPayload({ employee, session, scopeDecision, skillSelection }),
      id: nextRecordId("CPR-FEISHU-ALGORITHM"),
      sourceRequestId,
      requester: actorDisplay(session),
      ownerHint: employee.owner || "研发负责人",
      risk: writebackIntent ? "高" : "中",
      requestedCapabilities: uniqueList(skillSelection.selectedSkills.flatMap((skill) => skill.capabilities?.length ? skill.capabilities.slice(0, 2) : [skill.name])),
      safeSummary: [
        SAFE_SUMMARY,
        `用户问题：${problemSummary}`,
        `申请范围：${requestScope}`,
        `对话场景：${channelIntentLabels.join(" / ")}`,
        `初始化对象：${scopeDecision.targetLabel}`,
        skillSelection.selectionMode === "channel_explicit"
          ? `受限 Skill 范围：${skillSelection.selectedSkills.map((skill) => skill.name).join(" / ")}`
          : "Skill 范围：继承数字员工当前启用状态",
        requestsGroupAccess
          ? requestedGroups.length
            ? `希望开通飞书群：${requestedGroups.join(" / ")}`
            : "希望开通飞书群：待补充或由管理员确认"
          : "",
        `系统归档场景：${sceneType}`,
        evidenceRefs.length ? `证据引用：${evidenceRefs.join(" / ")}` : "证据引用：待补充",
        writebackIntent ? "用户声明涉及写回/远程执行，必须人审。" : "用户未声明写回/远程执行。",
      ].filter(Boolean).join(" "),
      warnings: [
        "Feishu entry only creates a governed capability request.",
        "No raw prompt, provider key, model trace, customer data, employee PII, or original algorithm payload is stored.",
        "Algorithm employee remains gated by personnel approval and Skill review.",
      ],
    };

    return {
      id: nextRecordId("FAPP"),
      sourceSystemId: SOURCE_SYSTEM_ID,
      sourceRequestId,
      targetEmployeeId: EMPLOYEE_ID,
      targetEmployeeName: employee.name,
      targetSkillId: ROOT_SKILL_ID,
      departmentId: DEPARTMENT_ID,
      businessDomain: BUSINESS_DOMAIN,
      sceneType,
      requestScope,
      requestScopeType: scopeDecision.requestScopeType,
      channelIntent: primaryChannelIntent.id,
      channelIntentLabel: primaryChannelIntent.label,
      channelIntentIds: channelIntents.map((intent) => intent.id),
      channelIntentLabels,
      requestedGroupNames: requestedGroups,
      targetUserId: scopeDecision.targetUserId,
      targetUserName: scopeDecision.targetUserName,
      targetDepartmentId: scopeDecision.targetDepartmentId,
      targetDepartmentName: scopeDecision.targetDepartmentName,
      problemSummary,
      evidenceRefs,
      selectedSkillIds: skillSelection.selectedSkillIds,
      selectedSkills: skillSelection.selectedSkills,
      skillScopeMode: skillSelection.selectionMode === "channel_explicit" ? "restricted" : "employee_mount_default",
      writebackIntent,
      expectedOutput: cleanText(input.expectedOutput || "安全摘要 + 待确认清单"),
      status: "待平台评审",
      submittedBy: actorSummary(session),
      submittedAt: now,
      capabilityRequest,
    };
  }

  function buildCapabilityRequestPayload({ employee, scopeDecision = {}, skillSelection = {} }) {
    const selectedSkills = skillSelection.selectedSkills || [];
    return {
      sourceSystemId: SOURCE_SYSTEM_ID,
      requestType: "business_digital_employee_application",
      departmentId: DEPARTMENT_ID,
      businessDomain: BUSINESS_DOMAIN,
      capabilityName: employee.name,
      capabilityKind: "业务数字员工",
      targetEmployeeId: EMPLOYEE_ID,
      targetEmployeeName: employee.name,
      targetSkillId: ROOT_SKILL_ID,
      targetSkillName: "算法外挂",
      targetSkillIds: selectedSkills.length ? selectedSkills.map((skill) => skill.id) : [],
      requestedSkillIds: selectedSkills.map((skill) => skill.id),
      requestedSkills: selectedSkills.map(summarizeRequestedSkill),
      applicationScope: scopeDecision.requestScopeType || "personal",
      applicationTarget: scopeDecision.targetLabel || "申请人本人",
      targetSourceRef: `platform.businessEmployee:${employee.id}@${employee.version}`,
      sourceAlignment: "update_existing_source",
      reviewGate: "平台管理员 + 研发负责人确认飞书入口、人员审批、调用动作、隐私边界和回滚策略。",
      preReview: {
        workerId: "capability-ingestion-precheck",
        workerName: "能力归纳预审核员",
        workerEmployeeId: "system-ingestion-agent",
        lane: "capability_precheck",
        status: "待执行",
        provider: "codex",
        executionMode: "demo_safe_summary_queue",
        recommendation: "algorithm_feishu_entry_review",
        safeFindings: ["待确认飞书入口灰度范围", "待确认算法员工人员审批", "待确认高风险动作继续人审"],
        expectedOutputs: ["接入评估", "缺口清单", "下一步审核门禁"],
      },
      tags: ["feishu-mvp", "algorithm-worker"],
    };
  }

  function currentBusinessSkills() {
    return typeof getBusinessSkills === "function" ? getBusinessSkills() : businessSkills;
  }

  function buildSkillOptions(employee = {}) {
    const businessSkillById = new Map((currentBusinessSkills() || []).map((skill) => [skill.id, skill]));
    const skillIds = uniqueList([
      ...(employee.basicSkillIds || []),
      ...(employee.businessSkillIds || []),
    ]);
    return skillIds.map((skillId) => {
      const skill = businessSkillById.get(skillId) || {};
      const capabilities = cleanList(skill.capabilities || []).slice(0, 4);
      return {
        id: cleanShortText(skill.id || skillId),
        skillApiId: cleanShortText(skill.skillApiId || skillId),
        sourceSkillId: cleanShortText(skill.sourceSkillId || ""),
        name: cleanShortText(skill.name || skillId),
        status: cleanShortText(skill.status || "待评审"),
        risk: cleanShortText(skill.risk || "中"),
        reviewGate: cleanText(skill.reviewGate || "负责人审核"),
        summary: cleanText(skill.description || capabilities.join(" / ") || "按 Skill 声明能力初始化个人开关。"),
        capabilities,
        defaultSelected: false,
      };
    });
  }

  function resolveSelectedSkills({ employee, input }) {
    const options = buildSkillOptions(employee);
    const optionById = new Map(options.map((option) => [option.id, option]));
    const selectionField = ["selectedSkillIds", "skillIds", "selectedSkills"]
      .find((field) => Object.prototype.hasOwnProperty.call(input, field));
    const requestedIds = uniqueList(cleanList(selectionField ? input[selectionField] : []));
    const candidateIds = selectionField ? requestedIds : [];
    const selectedSkillIds = candidateIds.filter((skillId) => optionById.has(skillId));
    const invalidSkillIds = candidateIds.filter((skillId) => !optionById.has(skillId));
    return {
      selectionMode: selectionField ? "channel_explicit" : "employee_mount_default",
      selectedSkillIds,
      selectedSkills: selectedSkillIds.map((skillId) => optionById.get(skillId)).filter(Boolean),
      invalidSkillIds,
    };
  }

  function buildScopeOptions({ employee, session }) {
    const actorName = actorDisplay(session);
    const personalScope = {
      id: "personal",
      label: "本人试用",
      value: "本人先试用",
      requestScopeType: "personal",
      targetLabel: `${actorName} 本人`,
      targetUserId: actorDigest(session),
      targetUserName: actorName,
      targetDepartmentId: cleanShortText(session.departmentId || ""),
      targetDepartmentName: cleanShortText(session.department || ""),
      requiresAdmin: false,
      note: "普通用户和管理员个人申请都走本人范围。",
    };
    if (!hasPlatformGovernance(session)) return [personalScope];

    const departmentName = employee.department || "所属部门";
    return [
      personalScope,
      {
        id: "department",
        label: `${departmentName}灰度`,
        value: `${departmentName}灰度`,
        requestScopeType: "department",
        targetLabel: `${departmentName}成员`,
        targetDepartmentId: cleanShortText(employee.departmentId || DEPARTMENT_ID),
        targetDepartmentName: cleanShortText(departmentName),
        requiresAdmin: true,
        note: "仅管理员或对应部门治理角色可申请部门默认配置。",
      },
    ];
  }

  function buildMessageDeliveryOptions(session = {}) {
    const canWebhook = hasPlatformGovernance(session);
    return MESSAGE_DELIVERY_OPTIONS.map((option) => ({
      ...option,
      enabled: option.id === "dry_run" || canWebhook,
      status: option.id === "webhook"
        ? feishuWebhookUrl()
          ? "服务端 webhook 已配置"
          : "待配置服务端 webhook"
        : "可用",
    }));
  }

  function resolveApplicationScope({ employee, input, session }) {
    const rawScope = cleanShortText(input.requestScope || "");
    const rawScopeType = cleanShortText(input.requestScopeType || input.applicationScope || input.scopeType || "");
    const allowedScopes = buildScopeOptions({ employee, session });
    if (isFeishuGroupScope(rawScope, rawScopeType)) {
      return {
        ok: false,
        statusCode: 409,
        error: "feishu_group_scope_deferred",
        message: "飞书群不是申请范围；请选择“群内运维测试”，并在“希望开通的飞书群”里填写。",
        allowedScopes,
        postApprovalChannelActions: POST_APPROVAL_CHANNEL_ACTIONS,
      };
    }
    let selected = allowedScopes.find((scope) =>
      [scope.id, scope.requestScopeType, scope.value, scope.label].includes(rawScopeType) ||
      [scope.id, scope.requestScopeType, scope.value, scope.label].includes(rawScope)
    );
    if (!selected && hasPlatformGovernance(session) && /(部门|灰度|研发)/.test(rawScope)) {
      selected = allowedScopes.find((scope) => scope.id === "department");
    }
    if (!selected && rawScope && !isPersonalScope(rawScope)) {
      return {
        ok: false,
        statusCode: 403,
        error: "feishu_scope_not_allowed",
        message: "普通用户只能申请本人范围；部门范围需要管理员/治理角色确认。",
        allowedScopes,
      };
    }
    selected = selected || allowedScopes[0];
    if (selected.requiresAdmin && !hasPlatformGovernance(session)) {
      return {
        ok: false,
        statusCode: 403,
        error: "feishu_scope_not_allowed",
        message: "部门范围需要管理员/治理角色确认。",
        allowedScopes,
      };
    }
    return { ok: true, ...selected, allowedScopes };
  }

  function isFeishuGroupScope(rawScope = "", rawScopeType = "") {
    return /feishu_group|group|群/i.test(`${rawScope} ${rawScopeType}`);
  }

  function resolveChannelIntents(input = {}) {
    const rawIntents = channelIntentInputs(input);
    const matchedIntents = rawIntents.map(matchChannelIntent).filter(Boolean);
    const uniqueIntents = CHANNEL_INTENT_OPTIONS.filter((option) =>
      matchedIntents.some((intent) => intent.id === option.id)
    );
    return uniqueIntents.length ? uniqueIntents : [CHANNEL_INTENT_OPTIONS[0]];
  }

  function channelIntentInputs(input = {}) {
    const values = [
      ...channelIntentInputList(input.channelIntentIds),
      ...channelIntentInputList(input.channelIntents),
      ...channelIntentInputList(input.channelIntentList),
      ...channelIntentInputList(input.channelIntent),
      ...channelIntentInputList(input.interactionMode),
      ...channelIntentInputList(input.testChannel),
    ];
    return uniqueList(values);
  }

  function channelIntentInputList(value) {
    if (Array.isArray(value)) return value.map(cleanShortText).filter(Boolean);
    return String(value || "").split(/[,\n;，；、]+/).map(cleanShortText).filter(Boolean);
  }

  function requestedGroupNames(input = {}, channelIntents = null) {
    const rawNames = cleanList(
      input.requestedGroupNames ||
      input.requestedFeishuGroups ||
      input.groupAllowlistRequest ||
      input.groupNames
    ).slice(0, 8);
    if (!Array.isArray(channelIntents)) return rawNames;
    const requestsGroupAccess = channelIntents.some((intent) => intent.id === "ops_group_smoke");
    return requestsGroupAccess ? rawNames : [];
  }

  function matchChannelIntent(rawIntent = "") {
    const text = cleanShortText(rawIntent);
    const matched = CHANNEL_INTENT_OPTIONS.find((option) =>
      [option.id, option.value, option.label].includes(text)
    );
    if (matched) return matched;
    if (/ops|运维|群|group/i.test(text)) {
      return CHANNEL_INTENT_OPTIONS.find((option) => option.id === "ops_group_smoke") || CHANNEL_INTENT_OPTIONS[0];
    }
    if (/personal|self|本人|单聊|个人/i.test(text)) {
      return CHANNEL_INTENT_OPTIONS.find((option) => option.id === "personal_chat") || CHANNEL_INTENT_OPTIONS[0];
    }
    return null;
  }

  function resolveDeliveryMode(input = {}) {
    const mode = cleanShortText(input.deliveryMode || input.messageDeliveryMode || "").toLowerCase();
    return mode === "webhook" ? "webhook" : "dry_run";
  }

  function buildInvocationCheck({ employee, input, highRisk }) {
    if (employee.status !== "在线" && employee.status !== "试运行") {
      return {
        status: "blocked",
        outcome: "employee_not_enabled",
        reason: "algorithm_employee_not_enabled",
        nextGate: "算法数字员工尚未启用；请完成员工配置后再接收任务。",
      };
    }
    if (highRisk) {
      return {
        status: "human_review_required",
        outcome: "runtime_tool_authorization_required",
        reason: "high_risk_action_requires_runtime_tool_authorization",
        requested: { action: cleanText(input.action || "writeback") },
        nextGate: "该页面只做 Channel dry-run；实际高风险 Tool 必须在统一 Runtime 中通过目标 RBAC 和逐次确认。",
      };
    }
    return {
      status: "allowed",
      outcome: "channel_preview_admitted",
      reason: "feishu_channel_preview_passed",
      requested: { action: cleanText(input.action || "draft") },
      nextGate: "Channel 预览已通过；真实消息由员工 Worker 的当前 Provider Route 和运行租约处理。",
    };
  }

  async function deliverMessageIfRequested({ input, message }) {
    const deliveryMode = cleanText(input.deliveryMode || "dry_run");
    if (deliveryMode !== "webhook") {
      return {
        mode: "dry_run",
        sent: false,
        status: "dry_run_passed",
        messageContractOk: true,
        note: "消息体已通过安全摘要校验；未请求真实发送。",
      };
    }

    const webhookUrl = feishuWebhookUrl();
    if (!webhookUrl) {
      return {
        mode: "webhook",
        sent: false,
        status: "webhook_not_configured",
        messageContractOk: true,
        note: "未配置 FEISHU_ALGORITHM_BOT_WEBHOOK_URL / FEISHU_BOT_WEBHOOK_URL，保持 dry-run 边界。",
      };
    }

    const response = await fetch(webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        msg_type: "text",
        content: { text: message.text },
      }),
    });
    const responseText = await response.text().catch(() => "");
    return {
      mode: "webhook",
      sent: response.ok,
      status: response.ok ? "sent" : "send_failed",
      messageContractOk: true,
      httpStatus: response.status,
      responseSummary: cleanText(responseText).slice(0, 200),
    };
  }

  return { handle, resolvePersistentTaskExecutor, withRuntimeEvidence };
}

function withPathname(url, pathname) {
  if (!url || url.pathname === pathname) return url;
  const routedUrl = new URL(url.toString());
  routedUrl.pathname = pathname;
  return routedUrl;
}
