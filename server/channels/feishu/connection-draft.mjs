import {
  CONNECTION_AUTOMATION_STEPS,
  CONNECTION_MODE_OPTIONS,
  CONNECTION_REQUIRED_FIELDS,
  DEFAULT_CONNECTION_MODE,
  FEISHU_EVENT_CALLBACK_PATH,
  SOURCE_SYSTEM_ID,
  cleanShortText,
  defaultCleanList,
  isHttpsUrl,
  isLocalCallbackUrl,
  normalizeConnectionMode,
} from "../../feishu-integration-support.mjs";

const FEISHU_APP_CONSOLE_URL = "https://open.feishu.cn/app";
const FEISHU_BOT_PERMISSION_SCOPES = [
  "im:message.p2p_msg:readonly",
  "im:message.group_at_msg:readonly",
  "im:message.group_msg",
  "im:message:readonly",
  "im:message:send_as_bot",
  "im:resource",
  "im:message.reactions:write_only",
];

function normalizeFeishuAppId(appId = "") {
  const normalized = cleanShortText(appId);
  return /^cli_[A-Za-z0-9]{6,}$/.test(normalized) ? normalized : "";
}

function feishuAppConsoleUrl(appId = "") {
  const normalized = normalizeFeishuAppId(appId);
  return normalized ? `${FEISHU_APP_CONSOLE_URL}/${encodeURIComponent(normalized)}` : FEISHU_APP_CONSOLE_URL;
}

function feishuPermissionUrl(appId = "") {
  const normalized = normalizeFeishuAppId(appId);
  if (!normalized) return "";
  const params = new URLSearchParams({
    q: FEISHU_BOT_PERMISSION_SCOPES.join(","),
    op_from: "openapi",
    token_type: "tenant",
  });
  return `${feishuAppConsoleUrl(normalized)}/auth?${params.toString()}`;
}

function buildConnectionDraft({ req, employee = {}, connection = {}, canEditConnection = false, callbackPath = FEISHU_EVENT_CALLBACK_PATH } = {}) {
  const employeeId = requireEmployeeId(employee.id);
  const connectionMode = normalizeConnectionMode(connection.connectionMode || connection.eventReceiveMode);
  const callbackPublicUrl = connection.callbackPublicUrl || resolveCallbackPublicUrl(req, "", callbackPath);
  return {
    targetEmployeeId: employeeId,
    targetEmployeeName: cleanShortText(employee.name || "数字员工"),
    requiredFields: canEditConnection ? CONNECTION_REQUIRED_FIELDS : [],
    automationSteps: canEditConnection ? CONNECTION_AUTOMATION_STEPS : [],
    defaultConnectionMode: DEFAULT_CONNECTION_MODE,
    connectionModeOptions: CONNECTION_MODE_OPTIONS,
    credentialOwnerOptions: canEditConnection ? [
      { id: "platform_admin", label: "平台管理员/运维" },
      { id: "business_owner", label: "业务 Owner" },
      { id: "applicant", label: "申请人本人" },
    ] : [],
    callbackPath,
    callbackPublicUrl,
    callbackReady: isHttpsUrl(callbackPublicUrl),
    canEditConnection,
    openPlatformManualSteps: canEditConnection ? [
      "在飞书开放平台启用机器人能力",
      connectionMode === "webhook" ? "把公网 HTTPS 回调地址粘贴到事件订阅请求地址" : "在事件订阅选择“使用长连接接收事件”",
      "订阅 im.message.receive_v1 消息接收事件",
      "群内需要先发材料、再 @机器人下指令时，开通 im:message.group_msg；系统仍只缓存精确白名单群的材料，普通群消息不会进入会话或任务",
      "开通 im:message.reactions:write_only 或 im:message，用于原消息下方状态标记",
      "开通 im:resource，用于上传并回传报告文件",
      "把 App ID 和 App Secret 配进本系统服务端凭证区",
      "把机器人安装到需要测试的单聊或群",
    ] : [],
    hiddenTechnicalFields: ["App Secret", "tenant_access_token", "raw message content", "HTTP 回调模式下的 verification token / encrypt key"],
    privacyBoundary: "飞书机器人长连接默认只需要 App ID 和 App Secret；App Secret 只在服务端加密保存。Verification Token、Encrypt Key 和公网回调地址仅在 HTTPS 回调高级模式下填写。",
  };
}

function validateConnectionInput({ appId, appSecret, verificationToken, callbackPublicUrl, connectionMode = DEFAULT_CONNECTION_MODE }) {
  if (!/^cli_[A-Za-z0-9]{6,}$/.test(appId)) {
    return { ok: false, error: "feishu_app_id_required", message: "请填写飞书应用 App ID，通常以 cli_ 开头。" };
  }
  if (appSecret.length < 12) {
    return { ok: false, error: "feishu_app_secret_required", message: "请填写飞书应用 App Secret。" };
  }
  if (connectionMode !== "webhook") {
    return { ok: true };
  }
  if (verificationToken.length < 6) {
    return { ok: false, error: "feishu_verification_token_required", message: "HTTPS 回调模式才需要填写事件订阅 Verification Token；长连接模式不需要。" };
  }
  const url = cleanShortText(callbackPublicUrl || process.env.FEISHU_ALGORITHM_CALLBACK_PUBLIC_URL || process.env.FEISHU_PUBLIC_CALLBACK_URL || "");
  if (!url) {
    return { ok: false, error: "feishu_public_callback_required", message: "HTTPS 回调模式需要公网回调地址；长连接模式不需要。" };
  }
  if (!/^https:\/\//i.test(url) && !isLocalCallbackUrl(url)) {
    return { ok: false, error: "feishu_public_callback_https_required", message: "飞书事件回调需要公网 HTTPS 地址；本机 http 只能做页面联调，不能被飞书云端回调。" };
  }
  return { ok: true };
}

function resolveCallbackPublicUrl(req, inputUrl = "", callbackPath = FEISHU_EVENT_CALLBACK_PATH) {
  const explicit = cleanShortText(inputUrl || process.env.FEISHU_PUBLIC_CALLBACK_URL || "");
  if (explicit) {
    const normalized = explicit.replace(/\/$/, "");
    try {
      const parsed = new URL(normalized);
      return parsed.pathname && parsed.pathname !== "/" ? normalized : `${normalized}${callbackPath}`;
    } catch {
      return normalized;
    }
  }
  const proto = cleanShortText(req.headers["x-forwarded-proto"] || "").split(",")[0] || "http";
  const host = cleanShortText(req.headers["x-forwarded-host"] || req.headers.host || "");
  return host ? `${proto}://${host}${callbackPath}` : callbackPath;
}

function buildConnectionWorkerBinding({ application = {}, connection = {}, status = "waiting_for_worker", now = "" } = {}) {
  const employeeId = requireEmployeeId(application.targetEmployeeId || connection.employeeId || connection.workerBinding?.employeeId);
  const employeeName = cleanShortText(application.targetEmployeeName || connection.employeeName || connection.workerBinding?.employeeName || "数字员工");
  const channelIntentIds = defaultCleanList(connection.channelIntentIds || application.channelIntentIds || application.channelIntent);
  const allowedChatRefs = Array.isArray(connection.allowedChatRefs) ? connection.allowedChatRefs : [];
  const skillScopeMode = cleanShortText(application.skillScopeMode) === "restricted"
    ? "restricted"
    : "employee_mount_default";
  return {
    status,
    employeeId,
    employeeName,
    applicationId: cleanShortText(application.id || connection.applicationId),
    capabilityRequestId: cleanShortText(application.capabilityRequestId || connection.capabilityRequestId),
    targetUserId: cleanShortText(application.targetUserId),
    targetUserName: cleanShortText(application.targetUserName),
    targetDepartmentId: cleanShortText(application.targetDepartmentId),
    targetDepartmentName: cleanShortText(application.targetDepartmentName),
    channelIntentIds,
    skillScopeMode,
    selectedSkillIds: skillScopeMode === "restricted" ? defaultCleanList(application.selectedSkillIds) : [],
    allowedChatCount: allowedChatRefs.filter((item) => item.idStatus === "ready" || item.feishuId || item.feishuIdMasked).length,
    routeKey: `${SOURCE_SYSTEM_ID}:${employeeId}:${application.targetUserId || application.capabilityRequestId || application.id || "unbound"}`,
    boundAt: connection.workerBinding?.boundAt || now,
    updatedAt: now,
  };
}

function requireEmployeeId(value = "") {
  const employeeId = cleanShortText(value);
  if (!employeeId) throw new Error("feishu connection draft employeeId required");
  return employeeId;
}

export {
  buildConnectionDraft,
  buildConnectionWorkerBinding,
  feishuAppConsoleUrl,
  feishuPermissionUrl,
  normalizeFeishuAppId,
  resolveCallbackPublicUrl,
  validateConnectionInput,
};
