const PERMISSION_CHECK_COOLDOWN_SECONDS = 10;

const DEFAULT_SCOPE_OPTIONS = [
  {
    id: "personal",
    label: "本人试用",
    value: "本人先试用",
    requestScopeType: "personal",
    note: "普通用户只能申请本人范围。",
  },
];
const DEFAULT_CHANNEL_INTENT_OPTIONS = [
  {
    id: "personal_chat",
    label: "本人/单聊试用",
    description: "先验证个人申请和消息摘要。",
  },
  {
    id: "ops_group_smoke",
    label: "群内运维测试",
    description: "可填写希望开通的飞书群；真实白名单由管理员审批后配置。",
  },
];
const DEFAULT_DELIVERY_OPTIONS = [
  {
    id: "dry_run",
    label: "dry-run 校验",
    enabled: true,
    description: "不真实发送，只验证消息体和门禁。",
  },
];
const DEFAULT_PROCESS_CONFIRMATIONS = [
  {
    id: "personal",
    title: "普通用户申请流程",
    steps: ["本人范围", "提交场景说明/申请群", "管理员/负责人审核", "开通个人入口"],
  },
  {
    id: "admin",
    title: "管理员申请流程",
    steps: ["本人或管辖部门", "确认员工 Skill 开关", "审核群开通", "高风险写回单独审批", "部门/个人实例继承配置"],
  },
];
const DEFAULT_FORM = {
  problemSummary: "现场算法问题需要整理回归证据和待确认清单",
  requestScope: "本人先试用",
  requestScopeType: "personal",
  channelIntentIds: ["personal_chat"],
  deliveryMode: "dry_run",
  selectedSkillIds: [],
  requestedGroupNames: "",
  evidenceRef: "",
  expectedOutput: "安全摘要 + 待确认清单",
  writebackIntent: false,
};
const DEFAULT_CONNECTION_FORM = {
  credentialOwnerType: "platform_admin",
  credentialOwnerName: "",
  connectionMode: "websocket",
  appId: "",
  appSecret: "",
  verificationToken: "",
  encryptKey: "",
  callbackPublicUrl: "",
  allowedChatRefs: [
    { clientId: "group_chat-default", type: "group_chat", name: "", feishuId: "", feishuIdMasked: "" },
    { clientId: "single_user-default", type: "single_user", name: "", feishuId: "", feishuIdMasked: "" },
  ],
};
const CHAT_REF_GROUPS = [
  { type: "group_chat", label: "群聊", namePlaceholder: "算法运维群", idPlaceholder: "oc_xxx / chat_xxx" },
  { type: "single_user", label: "单聊", namePlaceholder: "示例用户", idPlaceholder: "ou_xxx / user_xxx" },
];

const FEISHU_APP_CONSOLE_URL = "https://open.feishu.cn/app";
const FEISHU_SCOPE_DOC_URL = "https://open.feishu.cn/document/server-docs/application-scope/introduction";
const FEISHU_REVIEW_DOC_URL = "https://open.feishu.cn/document/best-practices/intro-to-custom-app-review";
const FEISHU_EVENT_DOC_URL = "https://open.feishu.cn/document/home/index";
const FEISHU_BOT_PERMISSION_SCOPES = [
  {
    id: "im:message.p2p_msg:readonly",
    label: "读取机器人单聊消息",
    reason: "让用户能在单聊里给数字员工入口发消息。",
  },
  {
    id: "im:message.group_at_msg:readonly",
    label: "读取群聊 @ 机器人消息",
    reason: "让测试群可以通过 @机器人 触发真实消息事件。",
  },
  {
    id: "im:message:readonly",
    label: "受控下载消息附件",
    reason: "用于下载机器人所在会话的文件或图片；只进入临时文件区，不自动解压或执行。",
  },
  {
    id: "im:message:send_as_bot",
    label: "以机器人身份发送测试消息",
    reason: "用于管理员主动发送联通测试消息；默认对话状态不再发灰色回复气泡。",
  },
  {
    id: "im:message.reactions:write_only",
    label: "消息下方状态标记",
    reason: "让系统收到消息后在原消息下方显示 emoji + 机器人身份状态。",
  },
];
const FEISHU_BOT_EVENT_REQUIREMENTS = [
  "启用机器人能力",
  "事件订阅选择使用长连接接收事件",
  "订阅 im.message.receive_v1",
  "订阅 card.action.trigger，接收每次回答的质量反馈",
  "开通 im:message.reactions:write_only 或 im:message",
  "发布应用版本并通过企业管理员审核",
  "把机器人安装到测试单聊或测试群",
];
const DEFAULT_CONNECTION_MODE_OPTIONS = [
  {
    id: "websocket",
    label: "飞书机器人长连接（推荐）",
    description: "只需要 App ID 和 App Secret；飞书开放平台事件订阅选择使用长连接接收事件。",
  },
  {
    id: "webhook",
    label: "HTTPS 回调（高级）",
    description: "需要公网 HTTPS 回调地址和 Verification Token；仅在不用长连接时选择。",
  },
];
const CONNECTION_FIELD_HELP = {
  credentialOwnerType: {
    text: "选择谁负责保管这套飞书应用凭证。企业级应用通常是平台管理员或运维；业务自建应用可以由业务 Owner 补充材料。",
  },
  credentialOwnerName: {
    text: "填写负责人的真实姓名或团队名，方便后续审核和凭证到期追责。",
  },
  connectionMode: {
    text: "默认按飞书机器人长连接方式接入：系统用 App ID/App Secret 启动服务端长连接 worker，不需要 Verification Token、Encrypt Key 或公网回调地址。只有你明确选择 HTTPS 回调时，才需要那些字段。",
    links: [
      { label: "打开飞书开发者后台", href: FEISHU_APP_CONSOLE_URL },
      { label: "查看事件订阅文档", href: FEISHU_EVENT_DOC_URL },
    ],
  },
  appId: {
    text: "飞书开放平台 -> 开发者后台 -> 选择企业自建应用 -> 凭证与基础信息 -> App ID，通常以 cli_ 开头。",
    links: [{ label: "打开飞书开发者后台", href: FEISHU_APP_CONSOLE_URL }],
  },
  appSecret: {
    text: "飞书开放平台 -> 开发者后台 -> 选择企业自建应用 -> 凭证与基础信息 -> App Secret。这里只提交到服务端加密保存，不会回显。",
    links: [{ label: "打开飞书开发者后台", href: FEISHU_APP_CONSOLE_URL }],
  },
  verificationToken: {
    text: "只有选择 HTTPS 回调高级模式才需要。飞书开放平台 -> 应用详情 -> 事件与回调/事件订阅 -> Verification Token。长连接模式不需要填写。",
    links: [
      { label: "打开飞书开发者后台", href: FEISHU_APP_CONSOLE_URL },
      { label: "查看事件订阅文档", href: FEISHU_EVENT_DOC_URL },
    ],
  },
  encryptKey: {
    text: "只有选择 HTTPS 回调高级模式并开启事件加密时才需要。长连接模式不需要填写。",
    links: [
      { label: "打开飞书开发者后台", href: FEISHU_APP_CONSOLE_URL },
      { label: "查看事件订阅文档", href: FEISHU_EVENT_DOC_URL },
    ],
  },
  callbackPublicUrl: {
    text: "只有选择 HTTPS 回调高级模式才需要。这个地址不是去飞书里找，而是由本系统部署或 tunnel 生成；长连接模式不需要公网回调地址。",
    links: [{ label: "查看事件订阅文档", href: FEISHU_EVENT_DOC_URL }],
  },
  allowedChatNames: {
    text: "按群聊和单聊分别新增测试对象。名称用于展示和审计，飞书稳定 ID 用于自动白名单、单聊/群聊路由和真实消息测试；只写名称也会作为申请材料保存。",
  },
};

const STEP_DEFS = [
  {
    id: "draft",
    title: "生成接入草案",
    detail: "读取企业身份、飞书入口字段、隐私边界和门禁清单。",
  },
  {
    id: "review",
    title: "提交待审申请",
    detail: "生成平台 capability request，进入管理员和研发负责人待审队列。",
  },
  {
    id: "message",
    title: "生成申请回执",
    detail: "系统自动校验飞书回执和调用门禁，不执行算法员工。",
  },
  {
    id: "connect",
    title: "审核通过后开通",
    detail: "审批通过后确认凭证责任人，再安全录入机器人凭证并开通连接。",
  },
];

function createSteps() {
  return STEP_DEFS.map((step, index) => ({
    ...step,
    status: index === 0 ? "ready" : "idle",
    meta: "",
    elapsed: "",
  }));
}

function elapsedSeconds(startedAt) {
  const elapsed = Math.max(1, Math.round((performance.now() - startedAt) / 1000));
  return `${elapsed} s`;
}

function normalizeList(value) {
  const items = Array.isArray(value) ? value : String(value || "").split(/[,\n;，；、/]+/);
  return items.map((item) => String(item || "").trim()).filter(Boolean);
}

function uniqueList(items = []) {
  return [...new Set(items.map((item) => String(item || "").trim()).filter(Boolean))];
}

function optionValue(option = {}) {
  return option.value || option.label || option.id || "本人先试用";
}

function deliveryOptionLabel(option = {}) {
  if (option.id === "dry_run") return "不发飞书通知";
  if (option.id === "webhook") return "发一条测试通知到运维群";
  return option.label || option.id;
}

function deliveryOptionNote(option = {}) {
  if (option.id === "dry_run") return "只在系统里检查申请内容，不往飞书群发消息。";
  if (option.id === "webhook") return option.status || "向已配置的运维群机器人发送一条安全摘要。";
  return option.description || option.status || "";
}

function normalizeFeishuAppId(value = "") {
  const appId = String(value || "").trim();
  return /^cli_[A-Za-z0-9]{6,}$/.test(appId) ? appId : "";
}

function feishuAppConsoleUrl(appId = "") {
  const normalized = normalizeFeishuAppId(appId);
  return normalized ? `${FEISHU_APP_CONSOLE_URL}/${encodeURIComponent(normalized)}` : FEISHU_APP_CONSOLE_URL;
}

function feishuPermissionScopeQuery() {
  return FEISHU_BOT_PERMISSION_SCOPES.map((scope) => scope.id).join(",");
}

function feishuPermissionUrl(appId = "") {
  const normalized = normalizeFeishuAppId(appId);
  if (!normalized) return "";
  const params = new URLSearchParams({
    q: feishuPermissionScopeQuery(),
    op_from: "openapi",
    token_type: "tenant",
  });
  return `${FEISHU_APP_CONSOLE_URL}/${encodeURIComponent(normalized)}/auth?${params.toString()}`;
}

function buildPermissionRequestPayload({ appId = "", appIdDisplay = "", permissionUrl = "" } = {}) {
  const normalized = normalizeFeishuAppId(appId);
  return JSON.stringify({
    appId: normalized || appIdDisplay || "保存飞书应用 App ID 后可直达该应用权限页",
    permissionUrl: permissionUrl || (normalized ? feishuPermissionUrl(normalized) : ""),
    requiredScopes: FEISHU_BOT_PERMISSION_SCOPES.map((scope) => scope.id),
    requiredEvent: "im.message.receive_v1 + card.action.trigger",
    manualChecklist: FEISHU_BOT_EVENT_REQUIREMENTS,
    note: "该清单用于飞书开放平台权限申请/发布审核；附件下载需要 im:message:readonly；事件订阅 im.message.receive_v1 与 card.action.trigger 仍需在事件订阅页配置；状态标记需要 im:message.reactions:write_only 或更高范围 im:message；App Secret、tenant_access_token 和用户原话不得复制到工单或飞书消息。",
  }, null, 2);
}

async function fetchJson(pathname, options = {}) {
  const response = await fetch(pathname, {
    credentials: "include",
    headers: { "Content-Type": "application/json", ...(options.headers || {}) },
    ...options,
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || data.ok === false) {
    throw new Error(data.message || data.error || "飞书申请接口失败");
  }
  return data;
}

function inferChatRefType(feishuId = "") {
  const text = String(feishuId || "").trim().toLowerCase();
  if (text.startsWith("oc_") || text.startsWith("chat_")) return "group_chat";
  if (text.startsWith("ou_") || text.startsWith("on_") || text.startsWith("om_") || text.startsWith("user_")) return "single_user";
  return "";
}

function chatRefType(type = "", feishuId = "") {
  return ["group_chat", "single_user"].includes(type) ? type : inferChatRefType(feishuId) || "group_chat";
}

function createChatRefRow(type = "group_chat", source = {}, index = 0) {
  const feishuId = String(source.feishuId || source.chatId || source.openChatId || source.openId || source.userId || "").trim();
  const normalizedType = chatRefType(source.type || type, feishuId);
  return {
    clientId: source.clientId || `${normalizedType}-${index}-${source.name || source.feishuIdMasked || feishuId || "new"}`,
    type: normalizedType,
    name: source.name || source.chatName || source.displayName || "",
    feishuId,
    feishuIdMasked: source.feishuIdMasked || "",
  };
}

function parseLegacyChatRefLine(line = "", index = 0) {
  const text = String(line || "").trim();
  if (!text) return null;
  const parts = text.split(/\s*[|｜]\s*/).map((item) => item.trim()).filter(Boolean);
  const explicitId = parts.length > 1 ? parts[parts.length - 1] : "";
  const idMatch = explicitId || text.match(/\b(?:oc|ou|on|om|chat|user)[_-][A-Za-z0-9_-]{4,}\b/i)?.[0] || "";
  const name = parts.length > 1
    ? parts.slice(0, -1).join(" | ")
    : text.replace(idMatch, "").replace(/[()（）\[\]【】]/g, " ").trim();
  return createChatRefRow(chatRefType("", idMatch), { name: name || text, feishuId: idMatch }, index);
}

function withDefaultChatRefRows(rows = []) {
  const normalized = rows.filter(Boolean);
  const hasGroup = normalized.some((row) => row.type === "group_chat");
  const hasSingle = normalized.some((row) => row.type === "single_user");
  return [
    ...normalized,
    ...(hasGroup ? [] : [createChatRefRow("group_chat", {}, normalized.length)]),
    ...(hasSingle ? [] : [createChatRefRow("single_user", {}, normalized.length + 1)]),
  ];
}

function allowedChatRefsFromValue(value = []) {
  if (Array.isArray(value) && value.length) {
    return withDefaultChatRefRows(value.map((item, index) =>
      typeof item === "string" ? parseLegacyChatRefLine(item, index) : createChatRefRow(item.type, item, index)
    ).filter(Boolean));
  }
  if (typeof value === "string" && value.trim()) {
    return withDefaultChatRefRows(value.split(/\n+/).map(parseLegacyChatRefLine).filter(Boolean));
  }
  return withDefaultChatRefRows([]);
}

function allowedChatRefsFromConnection(connection = {}) {
  if (connection.allowedChatRefs?.length) return allowedChatRefsFromValue(connection.allowedChatRefs);
  return allowedChatRefsFromValue(connection.allowedChatNames || []);
}

function allowedChatRefsForSubmit(rows = []) {
  return (Array.isArray(rows) ? rows : []).map((row) => ({
    type: row.type,
    name: row.name?.trim() || "",
    feishuId: row.feishuId?.trim() || "",
    feishuIdMasked: row.feishuIdMasked || "",
  })).filter((row) => row.name || row.feishuId || row.feishuIdMasked);
}

function isApprovedApplication(application = {}) {
  const decision = String(application.reviewDecision?.decision || "").trim();
  const status = String(application.status || "").trim();
  return decision === "approved" || /approved|已通过|通过/.test(status);
}

function isTerminalApplication(application = {}) {
  const decision = String(application.reviewDecision?.decision || "").trim();
  const status = String(application.status || "").trim();
  return ["approved", "rejected"].includes(decision) || /approved|rejected|canceled|cancelled|已通过|通过|已退回|退回|拒绝|已撤销|撤销/i.test(status);
}

function isPendingApplication(application = {}) {
  const status = String(application.status || "").trim();
  return Boolean(status) && !isTerminalApplication(application) && /pending|待|评审|审核|review/i.test(status);
}

function latestActiveApplication(applications = [], employee = {}) {
  return (applications || []).find((application) =>
    application.targetEmployeeId === employee.id && !/已撤销|撤销|canceled|cancelled|已退回|退回|拒绝|rejected/i.test(String(application.status || ""))
  );
}

function applicationSteps(application = {}) {
  const requestId = application.capabilityRequestId || application.sourceRequestId || application.id || "";
  const approved = isApprovedApplication(application);
  return STEP_DEFS.map((step) => {
    if (step.id === "draft") {
      return {
        ...step,
        status: "done",
        detail: "已读取企业身份、飞书入口字段、隐私边界和门禁清单。",
        meta: "只交换安全摘要、申请编号、门禁状态和 evidenceRef。",
      };
    }
    if (step.id === "review") {
      return {
        ...step,
        status: "done",
        detail: requestId
          ? `${requestId} ${approved ? "已通过平台审核。" : "已提交到平台治理待审队列。"}`
          : approved ? "飞书入口申请已通过平台审核。" : "飞书入口申请已提交到平台治理待审队列。",
        meta: approved ? "可继续补齐飞书联通资料。" : "这一步不是自动审批；管理员和研发负责人会在治理队列里确认。",
      };
    }
    if (step.id === "message") {
      return {
        ...step,
        status: "done",
        detail: "申请回执已生成，真实执行仍需人员审批。",
        meta: "算法员工真实执行仍需人员审批、调用门禁和运行确认。",
      };
    }
    return {
      ...step,
      status: approved ? "ready" : "waiting",
      detail: approved ? "审核已通过；平台治理角色继续完成飞书联通配置。" : "当前弹窗只提交申请；审批通过后由平台继续开通。",
      meta: "App ID/App Secret 只由平台治理角色录入到服务端 Secret 管理；申请人只看申请和真实消息测试状态。",
    };
  });
}

function connectionStatusLabel(status = "") {
  const labels = {
    not_configured: "待平台联通",
    credentials_validated: "凭证已校验",
    ready_for_long_connection: "等待长连接自检",
    long_connection_ready: "待真实消息验证",
    awaiting_message_roundtrip: "待真实消息验证",
    event_received: "收到真实事件，待状态标记",
    ready_for_event_subscription: "等待飞书回调确认",
    callback_verified: "回调已确认",
    connected: "已完成状态标记测试",
  };
  return labels[status] || status || "待平台联通";
}

function readinessTone(status = "") {
  if (status === "通过") return "good";
  if (status === "已人工确认") return "info";
  if (/等待|待/.test(status)) return "muted";
  return "warn";
}

function permissionTestView({ connection = {}, readinessChecks = [], connectionMode = "websocket", checkState = "idle" } = {}) {
  if (checkState === "checking") {
    return { label: "检查中", tone: "checking", icon: "loading", disabled: true };
  }
  if (connection?.status === "connected" || readinessChecks.find((check) => check.id === "message_roundtrip")?.status === "通过") {
    return { label: "已通过", tone: "passed", icon: "check", disabled: true };
  }
  const reactionCheck = readinessChecks.find((check) => check.id === "message_reaction");
  if (reactionCheck?.status === "缺权限") {
    return { label: "缺状态标记权限", tone: "error", icon: "alert", disabled: false };
  }
  if (connection?.status === "event_received" || readinessChecks.some((check) => check.status === "收到真实事件")) {
    return { label: "待状态标记", tone: "event", icon: "shield", disabled: false };
  }
  if (connection?.status === "awaiting_message_roundtrip" || readinessChecks.some((check) => check.status === "已人工确认")) {
    return { label: "待真实测试", tone: "waiting-test", icon: "shield", disabled: false };
  }
  if (checkState === "error") {
    return { label: "重试检查", tone: "error", icon: "alert", disabled: false };
  }
  const credentialsReady = readinessChecks.find((check) => check.id === "credentials")?.status === "通过";
  if (!credentialsReady) {
    return { label: "等待凭证", tone: "waiting", icon: "shield", disabled: true };
  }
  if (connectionMode === "webhook") {
    return { label: "检查结果", tone: "ready", icon: "shield", disabled: false };
  }
  return { label: "检查结果", tone: "ready", icon: "shield", disabled: false };
}

function connectionTestMessage({ connection = {}, testResult = {}, fallback = "" } = {}) {
  if (connection?.status === "connected") return "飞书真实消息状态标记测试已通过。";
  if (testResult?.status === "test_click_rate_limited") return testResult.nextGate || "刚刚已经触发过检查，请稍等几秒再点。";
  if (testResult?.delivery?.sent) return "后端已向测试对象发送安全测试消息；请在飞书里回复机器人，或在群里 @机器人，收到事件并挂上状态标记后才会变绿。";
  if (testResult?.target?.status === "missing_target") return "后端已校验凭证，但还缺测试对象 ID。请先补充单聊 open_id/user_id 或群 chat_id/open_chat_id。";
  if (testResult?.delivery?.status === "send_skipped_for_local_test") return "本地测试已完成绑定预检；真实环境还需要启动长连接 worker 后，再发送飞书消息做回环。";
  if (testResult?.worker?.status === "awaiting_real_message") return "后端联通预检已完成；请在飞书单聊机器人，或在测试群 @机器人 发送一条测试消息。";
  return testResult?.nextGate || connection?.nextGate || fallback || "还没有收到真实消息回环；请在飞书单聊机器人，或在测试群 @机器人 发送一条测试消息后再检查。";
}

export {
  CHAT_REF_GROUPS,
  CONNECTION_FIELD_HELP,
  DEFAULT_CHANNEL_INTENT_OPTIONS,
  DEFAULT_CONNECTION_FORM,
  DEFAULT_CONNECTION_MODE_OPTIONS,
  DEFAULT_DELIVERY_OPTIONS,
  DEFAULT_FORM,
  DEFAULT_PROCESS_CONFIRMATIONS,
  DEFAULT_SCOPE_OPTIONS,
  FEISHU_APP_CONSOLE_URL,
  FEISHU_BOT_PERMISSION_SCOPES,
  FEISHU_REVIEW_DOC_URL,
  FEISHU_SCOPE_DOC_URL,
  PERMISSION_CHECK_COOLDOWN_SECONDS,
  allowedChatRefsForSubmit,
  allowedChatRefsFromConnection,
  allowedChatRefsFromValue,
  applicationSteps,
  buildPermissionRequestPayload,
  connectionStatusLabel,
  connectionTestMessage,
  createChatRefRow,
  createSteps,
  deliveryOptionLabel,
  deliveryOptionNote,
  elapsedSeconds,
  fetchJson,
  feishuAppConsoleUrl,
  feishuPermissionUrl,
  isApprovedApplication,
  isPendingApplication,
  latestActiveApplication,
  normalizeFeishuAppId,
  optionValue,
  permissionTestView,
  readinessTone,
  uniqueList,
};
