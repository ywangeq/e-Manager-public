import { readFile } from "node:fs/promises";
import {
  FEISHU_MESSAGE_REACTION_URL,
  FEISHU_REPLY_MESSAGE_URL,
  cleanShortText,
  cleanText,
  maskIdentifier,
} from "../../feishu-integration-support.mjs";
import { buildFeishuAnswerCard, cardFeedbackSubscriptionReady } from "./card-feedback.mjs";
import { startFeishuCardKitStream } from "./cardkit-streaming.mjs";
import { buildFeishuReplyMessage } from "./reply-presentation.mjs";
import { buildFeishuToolParameterCard } from "./parameter-card.mjs";
import { buildFeishuToolConfirmationCard } from "./tool-confirmation-card.mjs";

function createFeishuOutboundDelivery({
  employeeId,
  employeeName = "数字员工",
  fetch = globalThis.fetch,
  store,
  validateFeishuCredentials,
} = {}) {
  const targetEmployeeId = cleanShortText(employeeId);
  const targetEmployeeName = cleanShortText(employeeName || "数字员工");
  if (!targetEmployeeId) throw new Error("feishu outbound delivery requires employeeId");
  if (!store) throw new Error("feishu outbound delivery requires a store");
  if (typeof validateFeishuCredentials !== "function") {
    throw new Error("feishu outbound delivery requires validateFeishuCredentials");
  }

  async function addFeishuProcessingReactionIfPossible({ messageId = "", statusLabel = "" } = {}) {
    const safeStatusLabel = cleanShortText(statusLabel);
    const emojiType = cleanShortText(process.env.FEISHU_PROCESSING_REACTION_EMOJI || process.env.FEISHU_ALGORITHM_PROCESSING_REACTION_EMOJI || "Typing");
    if (!messageId) {
      return { sent: false, mode: "reaction", status: "message_id_missing", statusLabel: safeStatusLabel, messageContractOk: true };
    }
    const appId = store.readSecret("appId", targetEmployeeId);
    const appSecret = store.readSecret("appSecret", targetEmployeeId);
    if (!appId || !appSecret) {
      return { sent: false, mode: "reaction", status: "credentials_missing", statusLabel: safeStatusLabel, messageContractOk: true };
    }
    const tokenCheck = await validateFeishuCredentials({ appId, appSecret });
    if (!tokenCheck.ok || !tokenCheck.tenantAccessToken) {
      return {
        sent: false,
        status: "tenant_token_failed",
        mode: "reaction",
        statusLabel: safeStatusLabel,
        messageContractOk: true,
        responseSummary: tokenCheck.message,
      };
    }
    try {
      const response = await fetch(`${FEISHU_MESSAGE_REACTION_URL}/${encodeURIComponent(messageId)}/reactions`, {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${tokenCheck.tenantAccessToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ reaction_type: { emoji_type: emojiType } }),
      });
      const responseText = await response.text().catch(() => "");
      const responseData = parseJsonObject(responseText);
      const reactionId = cleanShortText(responseData?.data?.reaction_id || responseData?.data?.reaction?.reaction_id);
      return {
        sent: response.ok,
        status: response.ok ? "reaction_sent" : "reaction_failed",
        mode: "reaction",
        statusLabel: safeStatusLabel,
        emojiType,
        messageContractOk: true,
        reactionId,
        httpStatus: response.status,
        responseSummary: redactFeishuResponseSummary(responseText, [appId, appSecret, tokenCheck.tenantAccessToken, reactionId]),
      };
    } catch {
      return {
        sent: false,
        status: "reaction_failed",
        mode: "reaction",
        statusLabel: safeStatusLabel,
        emojiType,
        messageContractOk: true,
        responseSummary: "飞书消息 reaction 接口调用失败。",
      };
    }
  }

  async function removeProcessingReactionAfterReply({ messageId = "", marker = {}, textReply = null } = {}) {
    if (!textReply || !marker?.sent) {
      return {
        attempted: false,
        status: "not_needed",
        messageContractOk: true,
        note: "未发送处理中状态，或尚未完成文本回复。",
      };
    }
    if (!textReply.sent) {
      return {
        attempted: false,
        status: "reply_not_sent",
        messageContractOk: true,
        note: "文本回复未成功发送，保留处理中状态供排障。",
      };
    }
    return removeFeishuProcessingReactionIfPossible({ messageId, reactionId: marker.reactionId });
  }

  async function removeFeishuProcessingReactionIfPossible({ messageId = "", reactionId = "" } = {}) {
    if (!messageId || !reactionId) {
      return {
        attempted: false,
        status: "reaction_id_missing",
        messageContractOk: true,
        note: "缺少 reaction id，无法自动撤销处理中状态。",
      };
    }
    const appId = store.readSecret("appId", targetEmployeeId);
    const appSecret = store.readSecret("appSecret", targetEmployeeId);
    if (!appId || !appSecret) {
      return {
        attempted: false,
        status: "credentials_missing",
        messageContractOk: true,
        note: "服务端尚未保存 App ID/App Secret，无法撤销处理中状态。",
      };
    }
    const tokenCheck = await validateFeishuCredentials({ appId, appSecret });
    if (!tokenCheck.ok || !tokenCheck.tenantAccessToken) {
      return {
        attempted: false,
        status: "tenant_token_failed",
        messageContractOk: true,
        note: tokenCheck.message || "飞书应用凭证校验失败，无法撤销处理中状态。",
      };
    }
    try {
      const response = await fetch(`${FEISHU_MESSAGE_REACTION_URL}/${encodeURIComponent(messageId)}/reactions/${encodeURIComponent(reactionId)}`, {
        method: "DELETE",
        headers: {
          "Authorization": `Bearer ${tokenCheck.tenantAccessToken}`,
          "Content-Type": "application/json",
        },
      });
      const responseText = await response.text().catch(() => "");
      return {
        attempted: true,
        sent: response.ok,
        status: response.ok ? "reaction_removed" : "reaction_remove_failed",
        messageContractOk: true,
        note: response.ok ? "回复完成后已撤销处理中状态。" : "回复完成后撤销处理中状态失败。",
        httpStatus: response.status,
        responseSummary: redactFeishuResponseSummary(responseText, [appId, appSecret, tokenCheck.tenantAccessToken, reactionId]),
      };
    } catch {
      return {
        attempted: true,
        sent: false,
        status: "reaction_remove_failed",
        messageContractOk: true,
        note: "飞书 reaction 删除接口调用失败。",
      };
    }
  }

  async function sendAgentTurnReplyIfPossible({
    connection = {},
    messageId = "",
    agentTurn = null,
    runtimeTask = null,
    groupReplyMention = null,
    reportArtifacts = [],
    streamingSession = null,
  } = {}) {
    const ok = Boolean(agentTurn?.ok);
    let delivery;
    const confirmationCard = ok
      ? buildFeishuToolConfirmationCard(agentTurn?.toolConfirmationRequests?.[0], targetEmployeeId)
      : null;
    const parameterCard = ok ? buildFeishuToolParameterCard({ ...(agentTurn?.toolParameterCards?.[0] || {}), employeeId: targetEmployeeId }) : null;
    if (streamingSession?.started) {
      if (confirmationCard || parameterCard) {
        await streamingSession.discard?.();
      } else {
        const streamed = await streamingSession.finish(agentTurn?.text || "");
        if (streamed.sent) delivery = streamed;
      }
    }
    if (!delivery && confirmationCard) {
      delivery = await sendFeishuTextReplyIfPossible({ messageId, content: JSON.stringify(confirmationCard), msgType: "interactive",
        mode: "feishu_tool_confirmation_card", successStatus: "tool_confirmation_card_sent", failureStatus: "tool_confirmation_card_failed",
        note: `${targetEmployeeName}已发送标准一次性 Tool 确认卡。` });
    } else if (!delivery && parameterCard) {
      delivery = await sendFeishuTextReplyIfPossible({ messageId, content: JSON.stringify(parameterCard), msgType: "interactive",
        mode: "feishu_tool_parameter_card", successStatus: "tool_parameter_card_sent", failureStatus: "tool_parameter_card_failed",
        note: `${targetEmployeeName}已发送标准任务参数卡。` });
    } else if (!delivery && ok && runtimeTask && cardFeedbackSubscriptionReady(connection)) {
      const answer = buildFeishuAnswerCard({
        answerText: agentTurn.text,
        connection,
        employee: agentTurn.safeSummary?.employee || { id: targetEmployeeId, name: targetEmployeeName },
        sourceMessageId: messageId,
        runtimeTask,
      });
      delivery = await sendFeishuTextReplyIfPossible({
        messageId,
        content: JSON.stringify(answer.card),
        msgType: "interactive",
        mode: "feishu_ai_agent_feedback_reply",
        successStatus: "agent_feedback_reply_sent",
        failureStatus: "agent_feedback_reply_failed",
        note: `${targetEmployeeName}已发送带质量反馈动作的飞书回答。`,
      });
      delivery = {
        ...delivery,
        answerId: answer.answerId,
        taskId: answer.taskId,
        requestId: answer.requestId,
        skillId: answer.skillId,
        feedbackContractVersion: "feishu-answer-feedback.v1",
        feedbackActions: ["quality_ok", "issue_reported"],
      };
    } else if (!delivery) {
      const noticeText = agentTurn?.text || `${targetEmployeeName} AI agent runtime 未返回可展示文本。`;
      const isQueueWaitNotice = agentTurn?.status === "task_queue_wait_notice";
      const isQueueNotice = agentTurn?.status === "task_queue_full" || isQueueWaitNotice;
      const replyMessage = buildFeishuReplyMessage({
        text: noticeText,
        employeeName: targetEmployeeName,
        groupReplyMention,
        preferInteractiveCard: ok,
      });
      delivery = await sendFeishuTextReplyIfPossible({
        messageId,
        text: replyMessage.text,
        content: replyMessage.content,
        msgType: replyMessage.msgType,
        mode: isQueueNotice
          ? "feishu_task_queue_notice"
          : ok ? "feishu_ai_agent_reply" : "feishu_agent_runtime_notice",
        successStatus: isQueueWaitNotice
          ? "task_queue_wait_notice_sent"
          : agentTurn?.status === "task_queue_full"
            ? "task_queue_notice_sent"
            : ok ? "agent_reply_sent" : "agent_runtime_notice_sent",
        failureStatus: isQueueWaitNotice
          ? "task_queue_wait_notice_failed"
          : agentTurn?.status === "task_queue_full"
            ? "task_queue_notice_failed"
            : ok ? "agent_reply_failed" : "agent_runtime_notice_failed",
        note: isQueueWaitNotice
          ? `${targetEmployeeName}任务排队提醒。`
          : agentTurn?.status === "task_queue_full"
            ? `${targetEmployeeName}任务队列已满通知。`
            : ok ? `${targetEmployeeName} AI agent 回复。` : `${targetEmployeeName} AI agent runtime 未就绪通知。`,
      });
    }
    if (!streamingSession?.started && streamingSession?.status) {
      delivery = {
        ...delivery,
        streaming: false,
        streamingFallbackStatus: streamingSession.status,
      };
    }
    const reportFileDeliveries = ok
      ? await sendFeishuReportArtifactsIfPossible({ messageId, reportArtifacts })
      : [];
    return { ...delivery, reportFileDeliveries };
  }

  async function startAgentReplyStreamIfPossible({ connection = {}, messageId = "", groupReplyMention = null } = {}) {
    if (!cardKitStreamingEligible(connection)) return null;
    try {
      const appId = store.readSecret("appId", targetEmployeeId);
      const appSecret = store.readSecret("appSecret", targetEmployeeId);
      if (!appId || !appSecret) return { started: false, status: "cardkit_credentials_missing" };
      const tokenCheck = await validateFeishuCredentials({ appId, appSecret });
      if (!tokenCheck?.ok || !tokenCheck.tenantAccessToken) return { started: false, status: "cardkit_credentials_invalid" };
      return startFeishuCardKitStream({
        employeeName: targetEmployeeName,
        fetch,
        groupReplyMention,
        messageId,
        tenantAccessToken: tokenCheck.tenantAccessToken,
      });
    } catch {
      return { started: false, status: "cardkit_start_failed" };
    }
  }

  async function sendFeishuReportArtifactsIfPossible({ messageId = "", reportArtifacts = [] } = {}) {
    if (!messageId || !reportArtifacts.length) return [];
    const appId = store.readSecret("appId", targetEmployeeId);
    const appSecret = store.readSecret("appSecret", targetEmployeeId);
    const tokenCheck = appId && appSecret ? await validateFeishuCredentials({ appId, appSecret }) : null;
    if (!tokenCheck?.ok || !tokenCheck.tenantAccessToken) {
      return reportArtifacts.map((artifact) => ({ sent: false, fileName: artifact.fileName, status: "report_file_credentials_unavailable" }));
    }
    const deliveries = [];
    for (const artifact of reportArtifacts.slice(0, 3)) {
      try {
        const form = new FormData();
        form.append("file_type", artifact.fileType || "stream");
        form.append("file_name", artifact.fileName);
        form.append("file", new Blob([await readFile(artifact.filePath)]), artifact.fileName);
        const upload = await fetch("https://open.feishu.cn/open-apis/im/v1/files", {
          method: "POST",
          headers: { "Authorization": `Bearer ${tokenCheck.tenantAccessToken}` },
          body: form,
        });
        const payload = await upload.json().catch(() => ({}));
        const fileKey = cleanShortText(payload?.data?.file_key);
        if (!upload.ok || !fileKey) {
          deliveries.push({ sent: false, fileName: artifact.fileName, status: "report_file_upload_failed", httpStatus: upload.status });
          continue;
        }
        const reply = await sendFeishuTextReplyIfPossible({
          messageId,
          content: JSON.stringify({ file_key: fileKey }),
          msgType: "file",
          mode: "feishu_report_file_reply",
          successStatus: "report_file_reply_sent",
          failureStatus: "report_file_reply_failed",
          note: `report Skill 报告文件已回传：${artifact.fileName}`,
        });
        deliveries.push({ ...reply, fileName: artifact.fileName, format: artifact.format });
      } catch {
        deliveries.push({ sent: false, fileName: artifact.fileName, status: "report_file_upload_failed" });
      }
    }
    return deliveries;
  }

  async function sendFeishuTextReplyIfPossible({
    content = "",
    messageId = "",
    msgType = "text",
    text = "",
    mode = "feishu_text_reply",
    successStatus = "reply_sent",
    failureStatus = "reply_failed",
    note = "飞书文本回复。",
  } = {}) {
    if (!messageId) {
      return { sent: false, mode, status: "message_id_missing", messageContractOk: true, note: "缺少原消息 id，无法回发飞书消息。" };
    }
    const appId = store.readSecret("appId", targetEmployeeId);
    const appSecret = store.readSecret("appSecret", targetEmployeeId);
    if (!appId || !appSecret) {
      return { sent: false, mode, status: "credentials_missing", messageContractOk: true, note: "服务端尚未保存 App ID/App Secret，无法回发飞书消息。" };
    }
    const tokenCheck = await validateFeishuCredentials({ appId, appSecret });
    if (!tokenCheck.ok) {
      return { sent: false, mode, status: "tenant_token_failed", messageContractOk: true, note: tokenCheck.message || "飞书应用凭证校验失败，无法回发消息。" };
    }
    if (!tokenCheck.tenantAccessToken) {
      return { sent: false, mode, status: "send_skipped_for_local_test", messageContractOk: true, note: "本地测试已识别飞书回复；真实环境会用飞书消息 API 回发。" };
    }
    try {
      const response = await fetch(`${FEISHU_REPLY_MESSAGE_URL}/${encodeURIComponent(messageId)}/reply`, {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${tokenCheck.tenantAccessToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ msg_type: msgType, content: content || JSON.stringify({ text }) }),
      });
      const responseText = await response.text().catch(() => "");
      return {
        sent: response.ok,
        mode,
        status: response.ok ? successStatus : failureStatus,
        messageContractOk: true,
        note,
        httpStatus: response.status,
        responseSummary: redactFeishuResponseSummary(responseText, [appId, appSecret, tokenCheck.tenantAccessToken]),
      };
    } catch {
      return { sent: false, mode, status: failureStatus, messageContractOk: true, note: "飞书消息回复接口调用失败。" };
    }
  }

  return {
    addFeishuProcessingReactionIfPossible,
    publicReaction,
    reactionCleanupPatch,
    reactionPermissionPatch,
    removeProcessingReactionAfterReply,
    sendAgentTurnReplyIfPossible,
    startAgentReplyStreamIfPossible,
  };
}

function cardKitStreamingEligible(connection = {}) {
  if (connection.replyPresentation?.cardKitStreamingEnabled === false) return false;
  if (cardFeedbackSubscriptionReady(connection)) return false;
  return connection.eventSubscription?.receiveMode === "websocket_long_connection";
}

function reactionPermissionPatch(marker = {}, now = new Date().toISOString()) {
  if (marker.sent) {
    return { reactionPermissionStatus: "validated", reactionPermissionMessage: "消息下方状态标记已发送。", lastReactionAt: now };
  }
  if (isReactionScopeMissing(marker.responseSummary)) {
    return {
      reactionPermissionStatus: "missing_scope",
      reactionPermissionMessage: "缺少 im:message.reactions:write_only 或 im:message 应用身份权限。",
      lastReactionPermissionErrorAt: now,
    };
  }
  if (marker.status === "reaction_failed") {
    return {
      reactionPermissionStatus: "failed",
      reactionPermissionMessage: cleanText(marker.responseSummary || "消息下方状态标记发送失败。"),
      lastReactionPermissionErrorAt: now,
    };
  }
  return {};
}

function reactionCleanupPatch(cleanup = {}, now = new Date().toISOString()) {
  if (cleanup.status === "reaction_removed") {
    return { processingReactionStatus: "removed_after_reply", processingReactionRemovedAt: now };
  }
  if (cleanup.status === "reaction_remove_failed") {
    return { processingReactionStatus: "remove_failed", processingReactionRemoveErrorAt: now };
  }
  return {};
}

function isReactionScopeMissing(responseSummary = "") {
  return /im:message\.reactions:write_only|Access denied|应用身份权限|99991672/i.test(String(responseSummary || ""));
}

function publicReaction(marker = {}) {
  if (!marker || typeof marker !== "object") return marker;
  const { reactionId, ...safeMarker } = marker;
  return safeMarker;
}

function redactFeishuResponseSummary(value = "", redactionValues = []) {
  let text = cleanText(value).slice(0, 200);
  redactionValues.filter(Boolean).forEach((secret) => {
    text = text.split(String(secret)).join(maskIdentifier(secret));
  });
  return text;
}

function parseJsonObject(value = "") {
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

export { createFeishuOutboundDelivery };
