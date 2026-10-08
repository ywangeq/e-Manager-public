import { cleanShortText } from "../../feishu-integration-support.mjs";
import { normalizeModelInputText } from "../../agent-runtime/context-assembler.mjs";
import { extractFeishuMessageResources } from "./runtime-intake.mjs";

const MATERIAL_MESSAGE_TYPES = new Set(["file", "folder", "image", "media", "audio"]);

function normalizeFeishuInboundTurn({
  conversation = {},
  eventType = "",
  materialMessage = null,
  materialMessages = [],
  messageEvent = {},
  messageIdDigest = "",
  receiveMode = "",
} = {}) {
  const message = messageEvent.message || {};
  const materialSources = Array.isArray(materialMessages) && materialMessages.length
    ? materialMessages
    : materialMessage && typeof materialMessage === "object"
      ? [materialMessage]
      : [message];
  const text = extractTextMessageContent(message.content);
  const chatType = cleanShortText(message.chat_type || message.chatType).toLowerCase();
  const resources = materialSources.flatMap(extractFeishuMessageResources);
  const materialMessageType = materialSources.some((source) => MATERIAL_MESSAGE_TYPES.has(cleanShortText(source.message_type).toLowerCase()));
  const messageType = cleanShortText(materialSources.find((source) => source.message_type)?.message_type || message.message_type).toLowerCase();
  return {
    channel: "feishu",
    chatType,
    correlationId: messageIdDigest ? `feishu:${messageIdDigest.slice(0, 24)}` : "",
    eventType: cleanShortText(eventType),
    hasMaterial: resources.length > 0 || materialMessageType,
    materialResources: resources,
    messageType,
    receiveMode: cleanShortText(receiveMode),
    sessionKey: cleanShortText(conversation.sessionKey),
    text,
  };
}

function parseFeishuSessionCommand(content = "") {
  const text = extractTextMessageContent(content);
  if (!text) return null;
  const [command, ...rest] = text.trim().split(/\s+/);
  const normalizedCommand = String(command || "").toLowerCase();
  if (normalizedCommand !== "/new" && normalizedCommand !== "/reset") return null;
  return {
    argumentsText: rest.join(" ").trim(),
    command: normalizedCommand,
    kind: "session_reset",
    text,
  };
}

function isFeishuGroupBroadcastMention(messageEvent = {}) {
  const message = messageEvent.message || {};
  const chatType = cleanShortText(message.chat_type || message.chatType).toLowerCase();
  if (!/group|chat|room/.test(chatType) || chatType === "p2p") return false;
  const mentionLists = [
    message.mentions,
    message.mention,
    messageEvent.mentions,
    messageEvent.mention,
  ].filter(Array.isArray);
  if (mentionLists.flat().some(isBroadcastMentionObject)) return true;
  return contentHasBroadcastMention(message.content);
}

function extractTextMessageContent(content = "") {
  if (!content || typeof content !== "string") return "";
  try {
    const parsed = JSON.parse(content);
    if (typeof parsed?.text === "string") return normalizeModelInputText(parsed.text);
    if (typeof parsed?.content === "string") return normalizeModelInputText(parsed.content);
    return normalizeModelInputText(extractRichTextParts(parsed).join(" "));
  } catch {
    return normalizeModelInputText(content);
  }
}

function extractRichTextParts(value, parts = []) {
  if (!value) return parts;
  if (Array.isArray(value)) {
    value.forEach((item) => extractRichTextParts(item, parts));
    return parts;
  }
  if (typeof value !== "object") return parts;
  if (typeof value.title === "string") parts.push(value.title);
  if (typeof value.text === "string") parts.push(value.text);
  for (const [key, child] of Object.entries(value)) {
    if (key === "title" || key === "text") continue;
    if (child && typeof child === "object") extractRichTextParts(child, parts);
  }
  return parts;
}

function isBroadcastMentionObject(mention = {}) {
  if (!mention || typeof mention !== "object") return false;
  const id = mention.id || mention.user_id || mention.userId || {};
  return [
    mention.key,
    mention.name,
    mention.mention_name,
    mention.mentionName,
    mention.text,
    id.open_id,
    id.openId,
    id.user_id,
    id.userId,
    id.union_id,
    id.unionId,
    mention.open_id,
    mention.openId,
    mention.user_id,
    mention.userId,
    mention.union_id,
    mention.unionId,
  ].some(isBroadcastMentionToken);
}

function contentHasBroadcastMention(content = "") {
  const raw = String(content || "");
  if (broadcastMentionText(raw)) return true;
  return containsBroadcastMention(parseJsonObject(raw));
}

function containsBroadcastMention(value) {
  if (!value) return false;
  if (typeof value === "string") return broadcastMentionText(value);
  if (Array.isArray(value)) return value.some(containsBroadcastMention);
  if (typeof value !== "object") return false;
  if (cleanShortText(value.tag).toLowerCase() === "at") {
    return [value.user_id, value.userId, value.open_id, value.openId, value.union_id, value.unionId, value.name, value.text]
      .some(isBroadcastMentionToken);
  }
  return Object.values(value).some(containsBroadcastMention);
}

function broadcastMentionText(value = "") {
  const text = String(value || "");
  return /@所有人|@(?:_?all|everyone)\b/i.test(text) ||
    /<at\b[^>]*(?:user_id|open_id|union_id)=["']?(?:@?all|_?all|everyone|all_members|all_users)["']?[^>]*>/i.test(text) ||
    /<at\b[^>]*>(?:\s|&nbsp;)*(?:所有人|all|everyone)(?:\s|&nbsp;)*<\/at>/i.test(text);
}

function isBroadcastMentionToken(value = "") {
  const token = cleanShortText(value).toLowerCase().replace(/\s+/g, "");
  return ["所有人", "全体成员", "all", "@all", "_all", "everyone", "@everyone", "all_members", "all_users"].includes(token);
}

function parseJsonObject(value = "") {
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

export {
  extractTextMessageContent,
  isFeishuGroupBroadcastMention,
  normalizeFeishuInboundTurn,
  parseFeishuSessionCommand,
};
