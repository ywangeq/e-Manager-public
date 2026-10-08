import {
  DEFAULT_CONNECTION_MODE,
} from "./integration-contract.mjs";
import { buildFeishuEventPath } from "./integration-route-registry.mjs";
import {
  cleanShortText,
  cleanText,
  defaultCleanList,
  digestValue,
  hasPlatformGovernance,
  inferFeishuChatRefType,
  isHttpsUrl,
  maskIdentifier,
  normalizeAllowedChatRefs,
  sanitizeActor,
} from "./integration-values.mjs";
import { normalizeFeishuChannelExtension } from "./channel-extension-policy.mjs";

function sanitizeConnection(connection = {}) {
  const employeeId = requireEmployeeId(connection.employeeId);
  const tokenCheck = sanitizeTokenCheck(connection.tokenCheck);
  const eventSubscription = sanitizeEventSubscription(connection.eventSubscription, employeeId);
  const connectionMode = normalizeConnectionMode(connection.connectionMode || connection.eventReceiveMode || eventSubscription.receiveMode);
  const isWebhookMode = connectionMode === "webhook";
  const publicCallbackUrl = cleanShortText(connection.callbackPublicUrl);
  const credentialOk = ["validated", "skipped_for_local_test"].includes(tokenCheck.status);
  const applicationEnabled = typeof connection.applicationEnabled === "boolean"
    ? connection.applicationEnabled
    : credentialOk;
  const callbackOk = isHttpsUrl(publicCallbackUrl) || eventSubscription.status === "challenge_verified" || eventSubscription.status === "message_roundtrip_tested";
  const eventOk = eventSubscription.status === "challenge_verified" || eventSubscription.status === "event_received" || eventSubscription.status === "message_roundtrip_tested";
  const roundtripOk = eventSubscription.status === "message_roundtrip_tested";
  const realEventReceived = eventSubscription.status === "event_received" || roundtripOk || Boolean(eventSubscription.lastEventAt);
  const manualMessageEventConfirmed = eventSubscription.status === "message_event_subscribed" || Boolean(eventSubscription.messageEventSubscribedAt);
  const manualLongConnectionConfirmed = eventSubscription.status === "long_connection_enabled" || manualMessageEventConfirmed || Boolean(eventSubscription.longConnectionConfirmedAt);
  const reactionPermissionStatus = cleanShortText(eventSubscription.reactionPermissionStatus);
  const reactionPermissionOk = roundtripOk || reactionPermissionStatus === "validated";
  const reactionPermissionMissing = reactionPermissionStatus === "missing_scope";
  const cardActionSubscribed = Boolean(eventSubscription.cardActionSubscribedAt);
  const cardActionReceived = Boolean(eventSubscription.cardActionLastReceivedAt);
  const allowedChatRefs = sanitizeAllowedChatRefs(connection.allowedChatRefs);
  const workerBinding = sanitizeWorkerBinding(connection.workerBinding, employeeId);
  const channelExtension = normalizeFeishuChannelExtension(connection.channelExtension || {});
  let status = "not_configured";
  if (credentialOk) {
    if (roundtripOk) {
      status = "connected";
    } else if (isWebhookMode) {
      status = callbackOk ? eventOk ? "callback_verified" : "ready_for_event_subscription" : "credentials_validated";
    } else {
      status = realEventReceived
        ? "event_received"
        : manualLongConnectionConfirmed
          ? "awaiting_message_roundtrip"
          : "ready_for_long_connection";
    }
  }
  const commonCredentialCheck = {
    id: "credentials",
    label: "飞书应用凭证",
    status: credentialOk ? "通过" : "待填写",
    detail: tokenCheck.message || "填写 App ID / App Secret 后系统自动校验。",
  };
  const readinessChecks = isWebhookMode ? [
    {
      ...commonCredentialCheck,
    },
    {
      id: "callback_url",
      label: "公网 HTTPS 回调",
      status: isHttpsUrl(publicCallbackUrl) ? "通过" : "待配置",
      detail: publicCallbackUrl ? "已保存回调地址。" : "飞书云端需要可访问的 HTTPS 回调地址。",
    },
    {
      id: "event_challenge",
      label: "飞书回调确认",
      status: eventOk ? "通过" : "等待飞书确认",
      detail: eventSubscription.lastChallengeAt
        ? `最近确认：${eventSubscription.lastChallengeAt}`
        : "在飞书开放平台保存事件订阅后，系统会自动接收 challenge。",
    },
    {
      id: "message_roundtrip",
      label: "消息与状态标记测试",
      status: eventSubscription.status === "message_roundtrip_tested" ? "通过" : "待真实消息",
      detail: eventSubscription.lastEventAt
        ? `最近事件：${eventSubscription.lastEventAt}`
        : "把机器人加入单聊或群后发送一条测试消息。",
    },
    {
      id: "card_feedback",
      label: "回答质量反馈回调",
      status: cardActionReceived ? "通过" : cardActionSubscribed ? "已人工确认" : "待订阅",
      detail: cardActionReceived
        ? `最近收到反馈：${eventSubscription.cardActionLastReceivedAt}`
        : "订阅 card.action.trigger，接收每次回答后的质量 OK / 存在问题反馈。",
    },
  ] : [
    {
      ...commonCredentialCheck,
    },
    {
      id: "long_connection",
      label: "长连接事件订阅",
      status: roundtripOk ? "通过" : realEventReceived ? "收到真实事件" : manualLongConnectionConfirmed ? "已人工确认" : "待飞书确认",
      detail: manualLongConnectionConfirmed
        ? "后台配置已记录；仍需服务端 worker 收到真实飞书消息。"
        : "在飞书开放平台事件订阅选择“使用长连接接收事件”。",
    },
    {
      id: "message_event",
      label: "消息事件权限",
      status: roundtripOk ? "通过" : realEventReceived ? "收到真实事件" : manualMessageEventConfirmed ? "已人工确认" : "待订阅",
      detail: eventSubscription.messageEventSubscribedAt
        ? `最近确认：${eventSubscription.messageEventSubscribedAt}`
        : "订阅 im.message.receive_v1，并把机器人安装到要测试的单聊或群。",
    },
    {
      id: "message_reaction",
      label: "消息下方状态标记权限",
      status: reactionPermissionOk ? "通过" : reactionPermissionMissing ? "缺权限" : realEventReceived ? "待开通" : "待验证",
      detail: reactionPermissionMissing
        ? "飞书返回缺少 im:message.reactions:write_only 或 im:message 应用身份权限；开通后重新发送消息测试。"
        : reactionPermissionOk
          ? "机器人已能在原消息下方添加状态标记。"
          : "用于显示 OpenClaw 类似的 emoji+员工名状态标记，不发送额外回复气泡。",
    },
    {
      id: "message_roundtrip",
      label: "消息与状态标记测试",
      status: eventSubscription.status === "message_roundtrip_tested" ? "通过" : "待真实消息",
      detail: eventSubscription.lastEventAt
        ? `最近事件：${eventSubscription.lastEventAt}`
        : "长连接 worker 启动后，在单聊或群里发送一条测试消息。",
    },
    {
      id: "card_feedback",
      label: "回答质量反馈回调",
      status: cardActionReceived ? "通过" : cardActionSubscribed ? "已人工确认" : "待订阅",
      detail: cardActionReceived
        ? `最近收到反馈：${eventSubscription.cardActionLastReceivedAt}`
        : "在飞书开放平台订阅 card.action.trigger，接收每次回答后的质量 OK / 存在问题反馈。",
    },
  ];
  const operatorNextStep = nextConnectionGate({ status, readinessChecks, workerBinding });
  const adminDiagnostics = buildAdminConnectionDiagnostics({
    status,
    readinessChecks,
    tokenCheck,
    eventSubscription,
    allowedChatRefs,
    workerBinding,
    channelExtension,
  });
  return {
    status,
    employeeId,
    applicationEnabled,
    applicationId: cleanShortText(connection.applicationId),
    capabilityRequestId: cleanShortText(connection.capabilityRequestId),
    credentialOwnerType: cleanShortText(connection.credentialOwnerType),
    credentialOwnerName: cleanShortText(connection.credentialOwnerName),
    connectionMode,
    eventReceiveMode: isWebhookMode ? "http_callback" : "websocket_long_connection",
    appIdMasked: cleanShortText(connection.appIdMasked),
    appIdDigest: cleanShortText(connection.appIdDigest),
    callbackPublicUrl: isWebhookMode ? publicCallbackUrl : "",
    callbackPath: isWebhookMode ? buildFeishuEventPath(employeeId) : "",
    allowedChatNames: defaultCleanList(connection.allowedChatNames).slice(0, 12),
    allowedChatRefs,
    channelIntentIds: defaultCleanList(connection.channelIntentIds),
    tokenCheck,
    eventSubscription,
    lastEventSummary: sanitizeEventSummary(connection.lastEventSummary),
    workerBinding,
    channelExtension,
    lastConnectionTest: sanitizeConnectionTestResult(connection.lastConnectionTest),
    readinessChecks,
    nextGate: operatorNextStep,
    operatorNextStep,
    userNextStep: nextUserConnectionGate({ status, readinessChecks }),
    adminNextStep: adminDiagnostics.summary,
    adminDiagnostics,
    lastUpdatedBy: sanitizeActor(connection.lastUpdatedBy),
    createdAt: cleanShortText(connection.createdAt),
    updatedAt: cleanShortText(connection.updatedAt),
  };
}

function connectionForSession(connection = {}, session = {}) {
  const safeConnection = sanitizeConnection(connection);
  if (hasPlatformGovernance(session)) return safeConnection;
  const {
    adminDiagnostics,
    adminNextStep,
    operatorNextStep,
    ...applicantConnection
  } = safeConnection;
  return {
    ...applicantConnection,
    nextGate: safeConnection.userNextStep,
  };
}

function sanitizeTokenCheck(tokenCheck = {}) {
  return {
    status: cleanShortText(tokenCheck.status),
    checkedAt: cleanShortText(tokenCheck.checkedAt),
    appIdMasked: cleanShortText(tokenCheck.appIdMasked),
    expireSeconds: Number.isFinite(Number(tokenCheck.expireSeconds)) ? Number(tokenCheck.expireSeconds) : undefined,
    responseCode: Number.isFinite(Number(tokenCheck.responseCode)) ? Number(tokenCheck.responseCode) : undefined,
    message: cleanText(tokenCheck.message),
  };
}

function sanitizeEventSubscription(eventSubscription = {}, employeeId = "") {
  const targetEmployeeId = requireEmployeeId(employeeId);
  return {
    status: cleanShortText(eventSubscription.status || "not_configured"),
    receiveMode: cleanShortText(eventSubscription.receiveMode),
    requiredEvent: cleanShortText(eventSubscription.requiredEvent || "im.message.receive_v1"),
    callbackPath: eventSubscription.callbackPath === "" ? "" : buildFeishuEventPath(targetEmployeeId),
    lastChallengeAt: cleanShortText(eventSubscription.lastChallengeAt),
    lastEventAt: cleanShortText(eventSubscription.lastEventAt),
    lastReactionAt: cleanShortText(eventSubscription.lastReactionAt),
    lastReactionPermissionErrorAt: cleanShortText(eventSubscription.lastReactionPermissionErrorAt),
    reactionPermissionStatus: cleanShortText(eventSubscription.reactionPermissionStatus),
    reactionPermissionMessage: cleanText(eventSubscription.reactionPermissionMessage),
    longConnectionConfirmedAt: cleanShortText(eventSubscription.longConnectionConfirmedAt),
    messageEventSubscribedAt: cleanShortText(eventSubscription.messageEventSubscribedAt),
    cardActionSubscribedAt: cleanShortText(eventSubscription.cardActionSubscribedAt),
    cardActionLastReceivedAt: cleanShortText(eventSubscription.cardActionLastReceivedAt),
    cardActionReceiveMode: cleanShortText(eventSubscription.cardActionReceiveMode),
    confirmedBy: sanitizeActor(eventSubscription.confirmedBy),
  };
}

function sanitizeAllowedChatRefs(value = []) {
  const refs = Array.isArray(value) ? value : normalizeAllowedChatRefs(value);
  return refs.map((item) => {
    const feishuId = cleanShortText(item.feishuId);
    const masked = cleanShortText(item.feishuIdMasked) || maskIdentifier(feishuId);
    const idStatus = cleanShortText(item.idStatus || (feishuId || masked ? "ready" : "missing_id"));
    return {
      type: cleanShortText(item.type || inferFeishuChatRefType(feishuId)),
      name: cleanShortText(item.name),
      feishuIdMasked: masked,
      feishuIdDigest: cleanShortText(item.feishuIdDigest) || digestValue(feishuId),
      idStatus,
    };
  }).filter((item) => item.name || item.feishuIdMasked).slice(0, 12);
}

function sanitizeEventSummary(summary = {}) {
  return {
    eventType: cleanShortText(summary.eventType),
    messageId: cleanShortText(summary.messageId),
    chatId: cleanShortText(summary.chatId),
    senderId: cleanShortText(summary.senderId),
    replyStatus: cleanShortText(summary.replyStatus),
    receivedAt: cleanShortText(summary.receivedAt),
  };
}

function sanitizeDelivery(delivery = {}) {
  return {
    mode: cleanShortText(delivery.mode || "dry_run"),
    sent: Boolean(delivery.sent),
    status: cleanShortText(delivery.status),
    streaming: Boolean(delivery.streaming),
    streamingFallbackStatus: cleanShortText(delivery.streamingFallbackStatus),
    messageContractOk: Boolean(delivery.messageContractOk),
    note: cleanText(delivery.note),
    httpStatus: Number.isFinite(Number(delivery.httpStatus)) ? Number(delivery.httpStatus) : undefined,
    responseSummary: cleanText(delivery.responseSummary),
  };
}

function sanitizeWorkerBinding(binding = null, employeeId = "") {
  if (!binding || typeof binding !== "object") return null;
  if (!Object.keys(binding).length) return null;
  const allowedChatCount = Number(binding.allowedChatCount);
  return {
    status: cleanShortText(binding.status),
    employeeId: requireEmployeeId(binding.employeeId || employeeId),
    employeeName: cleanShortText(binding.employeeName),
    applicationId: cleanShortText(binding.applicationId),
    capabilityRequestId: cleanShortText(binding.capabilityRequestId),
    targetUserId: cleanShortText(binding.targetUserId),
    targetUserName: cleanShortText(binding.targetUserName),
    targetDepartmentId: cleanShortText(binding.targetDepartmentId),
    targetDepartmentName: cleanShortText(binding.targetDepartmentName),
    channelIntentIds: defaultCleanList(binding.channelIntentIds),
    skillScopeMode: cleanShortText(binding.skillScopeMode),
    selectedSkillIds: defaultCleanList(binding.selectedSkillIds),
    allowedChatCount: Number.isFinite(allowedChatCount) ? allowedChatCount : 0,
    routeKey: cleanShortText(binding.routeKey),
    boundAt: cleanShortText(binding.boundAt),
    updatedAt: cleanShortText(binding.updatedAt),
  };
}

function requireEmployeeId(value = "") {
  const employeeId = cleanShortText(value);
  if (!employeeId) throw new Error("feishu connection employeeId required");
  return employeeId;
}

function sanitizeConnectionTestResult(result = null) {
  if (!result || typeof result !== "object") return null;
  if (!result.checkedAt && !result.status) return null;
  return {
    status: cleanShortText(result.status),
    checkedAt: cleanShortText(result.checkedAt),
    credential: result.credential && typeof result.credential === "object" ? {
      status: cleanShortText(result.credential.status),
      checkedAt: cleanShortText(result.credential.checkedAt),
      appIdMasked: cleanShortText(result.credential.appIdMasked),
      message: cleanText(result.credential.message),
    } : null,
    worker: result.worker && typeof result.worker === "object" ? {
      status: cleanShortText(result.worker.status),
      message: cleanText(result.worker.message),
    } : null,
    target: result.target && typeof result.target === "object" ? {
      status: cleanShortText(result.target.status),
      type: cleanShortText(result.target.type),
      name: cleanShortText(result.target.name),
      feishuIdMasked: cleanShortText(result.target.feishuIdMasked),
      idStatus: cleanShortText(result.target.idStatus),
      receiveIdType: cleanShortText(result.target.receiveIdType),
    } : null,
    delivery: result.delivery ? sanitizeDelivery(result.delivery) : null,
    roundtrip: result.roundtrip && typeof result.roundtrip === "object" ? {
      status: cleanShortText(result.roundtrip.status),
      lastEventAt: cleanShortText(result.roundtrip.lastEventAt),
      message: cleanText(result.roundtrip.message),
    } : null,
    nextGate: cleanText(result.nextGate),
  };
}

function sanitizeInvocationCheck(check = {}) {
  return {
    status: cleanShortText(check.status),
    outcome: cleanShortText(check.outcome),
    reason: cleanShortText(check.reason),
    requested: check.requested && typeof check.requested === "object" ? {
      callerSystemId: cleanShortText(check.requested.callerSystemId),
      departmentId: cleanShortText(check.requested.departmentId),
      businessDomain: cleanShortText(check.requested.businessDomain),
      action: cleanShortText(check.requested.action),
      modelId: cleanShortText(check.requested.modelId),
      modelLevelId: cleanShortText(check.requested.modelLevelId),
    } : null,
    triggeredThresholds: Array.isArray(check.triggeredThresholds)
      ? check.triggeredThresholds.slice(0, 12).map((item) => ({
          name: cleanShortText(item.name),
          outcome: cleanShortText(item.outcome),
          expected: cleanShortText(item.expected),
          actual: cleanShortText(item.actual),
        }))
      : [],
    nextGate: cleanText(check.nextGate),
  };
}

function normalizeConnectionMode(value = "") {
  const raw = String(value || "").trim().toLowerCase();
  if (raw === "webhook" || raw === "http_callback" || raw === "https_callback" || raw.includes("callback")) {
    return "webhook";
  }
  return DEFAULT_CONNECTION_MODE;
}

function nextConnectionGate({ status, readinessChecks = [], workerBinding = null }) {
  if (status === "connected") return "飞书消息状态标记已完成联通测试；下一步接入真实算法运行器和正式审批台账。";
  if (status === "event_received") return "已收到真实飞书事件；请完成原消息下方状态标记测试，成功后才算联通完成。";
  if (status === "awaiting_message_roundtrip") {
    return workerBinding?.status === "worker_online"
      ? "飞书长连接 worker 已启动；请在飞书单聊机器人，或在测试群 @机器人 发送真实消息。"
      : "飞书后台配置已人工确认；请启动服务端长连接 worker，并在测试单聊或群发送真实消息。";
  }
  const firstPending = readinessChecks.find((check) => check.status !== "通过");
  if (firstPending?.id === "credentials") return "请先填写 App ID 和 App Secret，系统会自动校验。";
  if (firstPending?.status === "已人工确认") return "后台配置已人工确认；请启动服务端长连接 worker，并发送真实消息做状态标记验证。";
  if (firstPending?.status === "收到真实事件") return "已收到真实事件；请完成原消息下方状态标记测试。";
  if (firstPending?.id === "long_connection") return "请在飞书开放平台事件订阅选择“使用长连接接收事件”，再启动服务端长连接 worker。";
  if (firstPending?.id === "message_event") return "请在飞书开放平台订阅 im.message.receive_v1，并把机器人安装到测试单聊或群。";
  if (firstPending?.id === "message_reaction") return "请在飞书开放平台开通消息表情回复/状态标记权限 im:message.reactions:write_only（或 im:message），让机器人能在原消息下方挂状态标记。";
  if (firstPending?.id === "callback_url") return "请提供公网 HTTPS 回调地址；本机 LAN 地址无法被飞书云端回调。";
  if (firstPending?.id === "event_challenge") return "请在飞书开放平台保存事件订阅，系统会自动接收 challenge。";
  if (firstPending?.id === "message_roundtrip") return "请把机器人安装到单聊或测试群，并发送一条消息做状态标记验证。";
  return "连接资料已准备，等待飞书事件订阅确认。";
}

function nextUserConnectionGate({ status, readinessChecks = [] }) {
  if (status === "connected") return "飞书消息状态标记测试已通过；你可以在已开通的单聊或群里试用，正式执行仍受平台门禁控制。";
  if (status === "event_received") return "平台已经收到你的真实飞书消息，正在完成状态标记验证；你不用处理后台配置。";
  if (status === "awaiting_message_roundtrip") return "你的申请已进入平台联通处理；不需要配置工具、权限或事件订阅，等待平台完成真实消息测试。";
  const firstPending = readinessChecks.find((check) => check.status !== "通过");
  if (firstPending?.id === "credentials") return "申请已通过，等待凭证责任人录入飞书应用凭证；你不用处理 App Secret。";
  if (["long_connection", "message_event", "callback_url", "event_challenge"].includes(firstPending?.id)) {
    return "等待平台完成飞书应用联通和机器人开通；需要补充测试群或单聊时，系统会提示你。";
  }
  if (firstPending?.id === "message_roundtrip") return "等待平台完成真实消息和状态标记测试；平台确认后，你就可以在飞书里试用。";
  return "当前由平台继续处理飞书联通；你只需要关注申请状态。";
}

function buildAdminConnectionDiagnostics({ status, readinessChecks = [], tokenCheck = {}, eventSubscription = {}, allowedChatRefs = [], workerBinding = null }) {
  const credentialOk = ["validated", "skipped_for_local_test"].includes(tokenCheck.status);
  const readyChatRefs = allowedChatRefs.filter((item) => item.idStatus === "ready");
  const hasTarget = readyChatRefs.length > 0;
  const roundtripOk = eventSubscription.status === "message_roundtrip_tested";
  const eventSeen = ["event_received", "message_roundtrip_tested"].includes(eventSubscription.status) || Boolean(eventSubscription.lastEventAt);
  const workerOnline = ["worker_online", "worker_starting", "worker_reconnecting"].includes(workerBinding?.status);
  const manuallyConfirmed = ["long_connection_enabled", "message_event_subscribed"].includes(eventSubscription.status) ||
    Boolean(eventSubscription.longConnectionConfirmedAt || eventSubscription.messageEventSubscribedAt);
  const eventCheck = readinessChecks.find((check) => check.id === "message_event");
  const cardFeedbackCheck = readinessChecks.find((check) => check.id === "card_feedback");
  const reactionCheck = readinessChecks.find((check) => check.id === "message_reaction");
  const connectionConfigStatus = roundtripOk ? "通过" : workerOnline ? "已启动" : "待默认自检";
  const workerStatus = roundtripOk
    ? "通过"
    : eventSeen
      ? "收到真实事件"
      : workerOnline
        ? workerBinding?.status === "worker_online" ? "运行中" : "启动中"
        : manuallyConfirmed
        ? "待启动"
        : credentialOk
          ? "待事件订阅"
          : "待应用凭证";
  const sendPreviewStatus = roundtripOk
    ? "通过"
    : credentialOk && hasTarget
      ? "待测试"
      : "待准备";
  const checks = [
    {
      id: "connection_config",
      label: "长连接 worker 配置",
      status: connectionConfigStatus,
      detail: roundtripOk
        ? "真实消息和状态标记已通过，不再要求人工判断长连接 worker 状态。"
        : workerOnline
          ? "服务端长连接 worker 已启动；等待真实飞书消息进入平台。"
          : "默认应由平台执行飞书机器人长连接配置、worker 启动和日志自检；当前不能把这一步交给申请人。",
    },
    {
      id: "app_credentials",
      label: "应用凭证",
      status: credentialOk ? "通过" : "待校验",
      detail: credentialOk ? tokenCheck.message || "App ID / App Secret 已完成服务端校验。" : "先保存并校验 App ID / App Secret。",
    },
    {
      id: "target_chat",
      label: "测试对象",
      status: hasTarget ? "通过" : "待填写",
      detail: hasTarget ? `已保存 ${readyChatRefs.length} 个带稳定 ID 的测试对象。` : "需要群 chat_id/open_chat_id 或用户 open_id/user_id。",
    },
    {
      id: "message_event",
      label: "消息事件订阅",
      status: eventCheck?.status || "待订阅",
      detail: eventCheck?.detail || "订阅 im.message.receive_v1，并安装机器人到测试单聊或群。",
    },
    {
      id: "message_reaction",
      label: "消息下方状态标记权限",
      status: reactionCheck?.status || "待验证",
      detail: reactionCheck?.detail || "开通 im:message.reactions:write_only 或 im:message，让机器人能在原消息下方挂状态标记。",
    },
    {
      id: "card_feedback",
      label: "回答质量反馈",
      status: cardFeedbackCheck?.status || "待订阅",
      detail: cardFeedbackCheck?.detail || "订阅 card.action.trigger，接收每次回答后的质量 OK / 存在问题反馈。",
    },
    {
      id: "event_worker",
      label: "长连接 worker",
      status: workerStatus,
      detail: eventSeen
        ? eventSubscription.lastEventAt ? `最近真实事件：${eventSubscription.lastEventAt}` : "已经收到真实飞书事件。"
        : workerOnline
          ? "长连接 worker 已启动；请在飞书单聊机器人，或在测试群 @机器人 发送真实消息。"
          : "默认测试应启动或重启服务端飞书长连接 worker，并等待一条真实用户消息。",
    },
    {
      id: "send_preview",
      label: "消息发送预检",
      status: sendPreviewStatus,
      detail: "仅用于管理员主动测试消息；默认对话状态通过原消息下方标记呈现，不能把 dry-run 当作真实可聊天。",
    },
  ];
  return {
    summary: nextAdminConnectionGate({ status, checks }),
    checks,
    defaultConnectionTests: [
      {
        id: "save_credentials",
        label: "保存应用凭证",
        command: "保存 App ID / App Secret 到服务端凭证区",
      },
      {
        id: "event_subscription",
        label: "启用长连接事件",
        command: "在飞书开放平台启用长连接并订阅 im.message.receive_v1",
      },
      {
        id: "card_feedback_subscription",
        label: "启用回答质量反馈",
        command: "订阅 card.action.trigger，验证质量 OK / 存在问题按钮回调",
      },
      {
        id: "message_reaction_scope",
        label: "开通状态标记权限",
        command: "开通 im:message.reactions:write_only 或 im:message",
      },
      {
        id: "worker_restart",
        label: "启动/重启 worker",
        command: "启动或重启服务端飞书长连接 worker",
      },
      {
        id: "pairing_scope",
        label: "配对/白名单",
        command: "发送配对消息或配置允许访问的 chat id",
      },
      {
        id: "roundtrip",
        label: "真实消息回环",
        command: "发送真实飞书消息并检查 worker 状态标记和日志",
      },
    ],
  };
}

function nextAdminConnectionGate({ status, checks = [] }) {
  if (status === "connected") return "真实消息状态标记测试已通过；可以继续接入正式算法运行器和运行台账。";
  if (status === "event_received") return "平台已收到真实飞书事件；下一步确认原消息下方状态标记是否成功。";
  const firstPending = checks.find((check) => !["通过", "收到真实事件"].includes(check.status));
  if (status === "awaiting_message_roundtrip") {
    return "当前不是审核卡住，而是飞书机器人长连接自检未完成：完成应用凭证、长连接事件订阅、worker 启动，再在测试单聊或群发送真实消息。";
  }
  if (firstPending?.id === "app_credentials") return "先补齐并校验飞书 App ID / App Secret；长连接 worker 不能替代应用凭证。";
  if (firstPending?.id === "target_chat") return "请先补充测试单聊或群的稳定 ID，否则无法做真实消息和状态标记验证。";
  if (firstPending?.id === "message_event") return "请确认飞书开放平台已订阅 im.message.receive_v1，并把机器人安装到测试对象。";
  if (firstPending?.id === "card_feedback") return "请在飞书开放平台订阅 card.action.trigger，才能收集每次回答的质量 OK / 存在问题反馈。";
  if (firstPending?.id === "message_reaction") return "请在飞书开放平台开通 im:message.reactions:write_only 或 im:message；否则机器人收得到消息，但不能在原消息下方挂状态标记。";
  if (firstPending?.id === "event_worker") return "请启动服务端长连接 worker，等待真实飞书消息进入平台。";
  return "请按飞书机器人长连接自检顺序完成凭证、事件订阅、worker 日志、配对/白名单和真实消息回环。";
}

export {
  sanitizeConnection,
  connectionForSession,
  sanitizeTokenCheck,
  sanitizeEventSubscription,
  sanitizeAllowedChatRefs,
  sanitizeEventSummary,
  sanitizeDelivery,
  sanitizeWorkerBinding,
  sanitizeConnectionTestResult,
  sanitizeInvocationCheck,
  nextConnectionGate,
  nextUserConnectionGate,
  buildAdminConnectionDiagnostics,
  nextAdminConnectionGate,
  normalizeConnectionMode,
};
