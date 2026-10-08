import { cleanShortText } from "../../feishu-integration-support.mjs";
import { extractTextMessageContent } from "./inbound-turn.mjs";
import { extractFeishuMessageResources } from "./runtime-intake.mjs";

const GROUP_MATERIAL_MESSAGE_TYPES = new Set(["file", "folder", "image", "media", "audio"]);

function evaluateFeishuGroupIngress({ allowedChatIds = [], botOpenId = "", messageEvent = {} } = {}) {
  const message = messageEvent.message || {};
  const chatType = cleanShortText(message.chat_type || message.chatType).toLowerCase();
  if (!isGroupChatType(chatType)) return { action: "allow", reason: "direct_message" };

  const chatId = cleanShortText(message.chat_id || message.chatId);
  const allowed = new Set((Array.isArray(allowedChatIds) ? allowedChatIds : []).map(cleanShortText).filter(Boolean));
  if (!chatId || !allowed.has(chatId)) return { action: "ignore", reason: "group_not_allowlisted" };
  const senderId = cleanShortText(
    messageEvent.sender?.sender_id?.open_id ||
    messageEvent.sender?.sender_id?.user_id ||
    messageEvent.sender?.sender_id?.union_id
  );
  if (!senderId) return { action: "ignore", reason: "group_sender_missing" };

  const hasIntent = Boolean(extractTextMessageContent(message.content));
  const messageType = cleanShortText(message.message_type || message.messageType).toLowerCase();
  const hasMaterial = GROUP_MATERIAL_MESSAGE_TYPES.has(messageType) || extractFeishuMessageResources(message).length > 0;
  if (!hasIntent && hasMaterial) {
    return { action: "buffer_material", reason: "allowlisted_group_material_fragment" };
  }

  const currentBotOpenId = cleanShortText(botOpenId);
  if (!currentBotOpenId) return { action: "ignore", reason: "bot_identity_unavailable" };
  if (!isCurrentFeishuBotMentioned(messageEvent, currentBotOpenId)) {
    return { action: "ignore", reason: "current_bot_not_mentioned" };
  }
  return { action: "allow", reason: "allowlisted_group_bot_mentioned" };
}

function isCurrentFeishuBotMentioned(messageEvent = {}, botOpenId = "") {
  const expectedOpenId = cleanShortText(botOpenId);
  if (!expectedOpenId) return false;
  const message = messageEvent.message || {};
  const mentionLists = [message.mentions, message.mention, messageEvent.mentions, messageEvent.mention]
    .filter(Array.isArray);
  const mentions = mentionLists.flat();
  if (mentions.length) {
    return mentions.some((mention) => !isBroadcastMention(mention) && mentionOpenId(mention) === expectedOpenId);
  }
  if (cleanShortText(message.message_type || message.messageType).toLowerCase() !== "post") return false;
  return postContentMentionsBot(parseObject(message.content), expectedOpenId);
}

function isGroupChatType(chatType = "") {
  return /group|chat|room/.test(chatType) && chatType !== "p2p";
}

function mentionOpenId(mention = {}) {
  const id = mention?.id && typeof mention.id === "object" ? mention.id : {};
  return cleanShortText(id.open_id || id.openId || mention.open_id || mention.openId);
}

function isBroadcastMention(mention = {}) {
  const token = cleanShortText(mention?.key || mention?.name).toLowerCase().replace(/\s+/g, "");
  return ["@_all", "_all", "@all", "all", "所有人", "全体成员", "@everyone", "everyone"].includes(token);
}

function postContentMentionsBot(value, expectedOpenId) {
  if (!value) return false;
  if (Array.isArray(value)) return value.some((item) => postContentMentionsBot(item, expectedOpenId));
  if (typeof value !== "object") return false;
  if (cleanShortText(value.tag).toLowerCase() === "at") {
    const candidate = cleanShortText(value.open_id || value.openId || value.user_id || value.userId);
    const token = cleanShortText(value.key || value.name || value.user_name).toLowerCase().replace(/\s+/g, "");
    return candidate === expectedOpenId && !["@_all", "_all", "@all", "all", "所有人", "全体成员"].includes(token);
  }
  return Object.values(value).some((item) => postContentMentionsBot(item, expectedOpenId));
}

function parseObject(value = "") {
  try {
    const parsed = JSON.parse(String(value || ""));
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

export {
  evaluateFeishuGroupIngress,
  isCurrentFeishuBotMentioned,
};
