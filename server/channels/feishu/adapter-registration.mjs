import {
  buildConnectionDraft,
  feishuAppConsoleUrl,
  feishuPermissionUrl,
  normalizeFeishuAppId,
  validateConnectionInput,
} from "./connection-draft.mjs";
import { connectionForSession } from "./connection-projection.mjs";
import {
  resolveDigitalEmployeeByReadId,
  resolveDigitalEmployeeRequestIdentity,
} from "../../digital-employee-identity-compatibility.mjs";
import {
  actorDisplay,
  actorSummary,
  cleanShortText,
  digestValue,
  hasPlatformGovernance,
  hasUnsafeText,
  normalizeAllowedChatRefs,
} from "./integration-values.mjs";

const CONTRACT_VERSION = "feishu-adapter-registration.v1";
const REGISTRATION_ROUTE = /^\/api\/feishu\/integrations\/([^/]+)\/registration$/;

function createFeishuAdapterRegistrationService({
  getDigitalEmployees,
  readJsonBody,
  requireSession,
  sendJson,
  store,
  validateFeishuCredentials,
}) {
  async function handle(req, res, url) {
    const match = url.pathname.match(REGISTRATION_ROUTE);
    if (!match) return undefined;
    const employeeId = decodeEmployeeId(match[1]);
    const identity = resolveDigitalEmployeeRequestIdentity({ employeeId, method: req.method });
    if (!identity.ok) {
      return sendJson(res, identity.error === "digital_employee_identity_alias_read_only" ? 409 : 404, {
        ok: false,
        error: identity.error,
        ...(identity.canonicalEmployeeId ? { canonicalEmployeeId: identity.canonicalEmployeeId } : {}),
        contractVersion: CONTRACT_VERSION,
      });
    }
    const employee = resolveDigitalEmployeeByReadId(getDigitalEmployees() || [], identity.canonicalEmployeeId);
    if (!employee) {
      return sendJson(res, 404, {
        ok: false,
        error: "digital_employee_not_found",
        contractVersion: CONTRACT_VERSION,
      });
    }
    if (employee.level === "系统级") {
      return sendJson(res, 422, {
        ok: false,
        error: "system_digital_employee_channel_not_allowed",
        message: "系统级数字员工不进入业务飞书适配器注册流程。",
        contractVersion: CONTRACT_VERSION,
      });
    }
    if (req.method === "GET") return readRegistration(req, res, employee);
    if (req.method === "PUT") return updateApplicationState(req, res, employee);
    if (req.method === "POST") return registerAdapter(req, res, employee);
    return sendJson(res, 405, {
      ok: false,
      error: "method_not_allowed",
      contractVersion: CONTRACT_VERSION,
    });
  }

  async function updateApplicationState(req, res, employee) {
    const session = requireSession(req, res);
    if (!session) return undefined;
    if (!hasPlatformGovernance(session)) {
      return sendJson(res, 403, {
        ok: false,
        error: "feishu_adapter_registration_governance_required",
        message: "只有平台治理角色可以允许或关闭数字员工的飞书申请。",
        contractVersion: CONTRACT_VERSION,
      });
    }
    const input = await readJsonBody(req, 1024 * 64);
    if (typeof input.applicationEnabled !== "boolean") {
      return sendJson(res, 422, {
        ok: false,
        error: "feishu_application_enabled_required",
        message: "applicationEnabled 必须是布尔值。",
        contractVersion: CONTRACT_VERSION,
      });
    }
    const now = new Date().toISOString();
    const existingConnection = store.readConnection(employee.id);
    const connection = store.saveConnection({
      ...existingConnection,
      employeeId: employee.id,
      applicationEnabled: input.applicationEnabled,
      lastUpdatedBy: actorSummary(session),
      createdAt: existingConnection.createdAt || now,
      updatedAt: now,
    }, employee.id);
    return sendJson(res, 200, registrationResponse({ req, employee, connection, session }));
  }

  function readRegistration(req, res, employee) {
    const session = requireSession(req, res);
    if (!session) return undefined;
    const connection = connectionForSession(store.readConnection(employee.id), session);
    return sendJson(res, 200, registrationResponse({ req, employee, connection, session }));
  }

  async function registerAdapter(req, res, employee) {
    const session = requireSession(req, res);
    if (!session) return undefined;
    if (!hasPlatformGovernance(session)) {
      return sendJson(res, 403, {
        ok: false,
        error: "feishu_adapter_registration_governance_required",
        message: "只有平台治理角色可以登记或更新数字员工的飞书 Robot 凭证。",
        contractVersion: CONTRACT_VERSION,
      });
    }
    const input = await readJsonBody(req, 1024 * 64);
    const allowedChatRefs = normalizeAllowedChatRefs(input.allowedChatRefs || input.allowedChats || input.allowedChatNames);
    if (hasUnsafeText([
      input.credentialOwnerName,
      ...allowedChatRefs.map((item) => `${item.name} ${item.feishuId}`),
    ])) {
      return sendJson(res, 422, {
        ok: false,
        error: "unsafe_feishu_adapter_registration_payload",
        contractVersion: CONTRACT_VERSION,
      });
    }

    const existingConnection = store.readConnection(employee.id);
    if (!existingConnection.applicationEnabled) {
      return sendJson(res, 409, {
        ok: false,
        error: "feishu_application_not_enabled",
        message: "请先由平台管理员允许该数字员工发起飞书申请。",
        contractVersion: CONTRACT_VERSION,
      });
    }
    const inputAppId = cleanShortText(input.appId || input.feishuAppId);
    const savedAppId = normalizeFeishuAppId(store.readSecret("appId", employee.id));
    const appId = normalizeFeishuAppId(inputAppId) || savedAppId;
    const appSecret = String(input.appSecret || input.feishuAppSecret || store.readSecret("appSecret", employee.id) || "").trim();
    const validation = validateConnectionInput({
      appId,
      appSecret,
      connectionMode: "websocket",
      applicationEnabled: true,
      verificationToken: "",
      callbackPublicUrl: "",
    });
    if (!validation.ok) {
      return sendJson(res, 422, {
        ok: false,
        error: validation.error,
        message: validation.message,
        contractVersion: CONTRACT_VERSION,
      });
    }

    const appIdDigest = digestValue(appId);
    const duplicate = Object.entries(store.readConnections()).find(([otherEmployeeId, connection]) =>
      otherEmployeeId !== employee.id && connection.appIdDigest && connection.appIdDigest === appIdDigest
    );
    if (duplicate) {
      return sendJson(res, 409, {
        ok: false,
        error: "feishu_app_already_bound",
        message: "该飞书 Robot 已绑定其他数字员工；一个 App ID 只能归属一个员工适配器。",
        contractVersion: CONTRACT_VERSION,
        boundEmployeeId: duplicate[0],
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
    const connection = store.saveConnection({
      ...existingConnection,
      employeeId: employee.id,
      credentialOwnerType: cleanShortText(input.credentialOwnerType || "platform_admin"),
      credentialOwnerName: cleanShortText(input.credentialOwnerName || actorDisplay(session)),
      connectionMode: "websocket",
      eventReceiveMode: "websocket_long_connection",
      appId,
      appSecret,
      allowedChatRefs,
      allowedChatNames: allowedChatRefs.map((item) => item.name || item.feishuId).filter(Boolean).slice(0, 12),
      channelIntentIds: ["personal_chat", "ops_group_smoke"],
      tokenCheck: credentialCheck.safeSummary,
      eventSubscription: {
        ...(existingConnection.eventSubscription || {}),
        status: "waiting_for_long_connection",
        receiveMode: "websocket_long_connection",
        requiredEvent: "im.message.receive_v1",
        callbackPath: "",
      },
      workerBinding: {
        ...(existingConnection.workerBinding || {}),
        status: "adapter_registered",
        employeeId: employee.id,
        employeeName: employee.name,
        routeKey: `feishu:${employee.id}`,
        boundAt: existingConnection.workerBinding?.boundAt || now,
        updatedAt: now,
      },
      lastUpdatedBy: actorSummary(session),
      createdAt: existingConnection.createdAt || now,
      updatedAt: now,
    }, employee.id);

    return sendJson(res, 200, registrationResponse({ req, employee, connection, session }));
  }

  function registrationResponse({ req, employee, connection, session }) {
    const safeConnection = connectionForSession(connection, session);
    const registered = ["validated", "skipped_for_local_test"].includes(safeConnection.tokenCheck?.status);
    const savedAppId = normalizeFeishuAppId(store.readSecret("appId", employee.id));
    return {
      ok: true,
      status: registered ? "registered" : "not_registered",
      contractVersion: CONTRACT_VERSION,
      registration: {
        employeeId: employee.id,
        employeeName: employee.name,
        employeeVersion: employee.version,
        applicationEnabled: Boolean(safeConnection.applicationEnabled),
        status: registered ? "registered" : "not_registered",
        appIdMasked: safeConnection.appIdMasked || "",
        credentialStatus: safeConnection.tokenCheck?.status || "not_configured",
        connectionMode: "websocket",
        runtimeStatus: safeConnection.status || "not_configured",
        nextGate: registered
          ? "适配器和凭证已登记；启动该员工的飞书 worker，并完成事件订阅与真实消息回环后才可标记为已接入。"
          : "填写该数字员工自己的 Robot App ID 和 App Secret，系统校验后按 employeeId 注册适配器。",
      },
      connection: withAppLinks(safeConnection, savedAppId, session),
      registrationDraft: buildConnectionDraft({
        req,
        employee,
        connection: safeConnection,
        canEditConnection: hasPlatformGovernance(session),
        callbackPath: `/api/feishu/events/${encodeURIComponent(employee.id)}`,
      }),
      privacyBoundary: "App Secret 只进入服务端加密凭证库并按 employeeId 隔离；接口不回显明文，也不复用其他数字员工的 Robot。",
    };
  }

  return { handle };
}

function withAppLinks(connection, appId, session) {
  if (!hasPlatformGovernance(session) || !appId) return connection;
  return {
    ...connection,
    appConsoleUrl: feishuAppConsoleUrl(appId),
    permissionUrl: feishuPermissionUrl(appId),
  };
}

function decodeEmployeeId(value) {
  try {
    const decoded = decodeURIComponent(value);
    return /^[A-Za-z0-9][A-Za-z0-9._-]{1,159}$/.test(decoded) ? decoded : "";
  } catch {
    return "";
  }
}

export { CONTRACT_VERSION, createFeishuAdapterRegistrationService };
