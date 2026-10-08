import { createSessionTurnQueue } from "../../agent-runtime/runtime-context-session.mjs";
import { cleanShortText } from "../../feishu-integration-support.mjs";

function createFeishuConversationTurnCoordinator({
  accountId,
  employeeId,
  groupScope = "group_sender",
} = {}) {
  const normalizedAccountId = cleanShortText(accountId);
  const normalizedEmployeeId = cleanShortText(employeeId);
  if (!normalizedAccountId) throw new Error("feishu conversation coordinator requires accountId");
  if (!normalizedEmployeeId) throw new Error("feishu conversation coordinator requires employeeId");
  const turnQueue = createSessionTurnQueue();

  function conversationForMessage(messageEvent = {}) {
    const message = messageEvent.message || {};
    const chatId = cleanShortText(message.chat_id || message.chatId);
    const chatType = cleanShortText(message.chat_type || message.chatType).toLowerCase();
    const senderId = cleanShortText(
      messageEvent.sender?.sender_id?.open_id ||
      messageEvent.sender?.sender_id?.user_id ||
      messageEvent.sender?.sender_id?.union_id
    );
    const threadId = cleanShortText(
      message.thread_id ||
      message.threadId ||
      message.root_id ||
      message.rootId ||
      message.root_message_id ||
      message.rootMessageId
    );
    const groupChat = /group|chat|room/.test(chatType) && chatType !== "p2p";
    const scope = groupChat
      ? groupConversationScope({ chatId, groupScope, senderId, threadId })
      : `p2p:${chatId || senderId}`;
    return {
      groupChat,
      routeDimensions: {
        accountId: normalizedAccountId,
        actorIssuer: "feishu",
        actorSubjectId: senderId || chatId,
        channelId: "feishu",
        conversationId: chatId || senderId,
        conversationType: groupChat ? "group" : "direct",
        employeeId: normalizedEmployeeId,
        threadId,
      },
      sessionKey: `agent:${normalizedEmployeeId}:feishu:${normalizedAccountId}:${scope}`,
    };
  }

  return { ...turnQueue, conversationForMessage };
}

function groupConversationScope({ chatId = "", groupScope = "group_sender", senderId = "", threadId = "" } = {}) {
  if (groupScope === "group") return `group:${chatId}`;
  if (groupScope === "group_topic") return threadId ? `group:${chatId}:topic:${threadId}` : `group:${chatId}`;
  if (groupScope === "group_topic_sender") {
    return threadId ? `group:${chatId}:topic:${threadId}:sender:${senderId}` : `group:${chatId}:sender:${senderId}`;
  }
  return `group:${chatId}:sender:${senderId}`;
}

export {
  createFeishuConversationTurnCoordinator,
};
