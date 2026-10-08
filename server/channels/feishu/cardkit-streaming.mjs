import crypto from "node:crypto";
import { FEISHU_REPLY_MESSAGE_URL, cleanShortText } from "../../feishu-integration-support.mjs";
import { formatFeishuCardMarkdown } from "./reply-presentation.mjs";

const FEISHU_CARDKIT_URL = "https://open.feishu.cn/open-apis/cardkit/v1/cards";
const STREAM_UPDATE_INTERVAL_MS = 180;
const STREAM_UPDATE_MINIMUM_DELTA = 24;

async function startFeishuCardKitStream({
  employeeName = "数字员工",
  fetch = globalThis.fetch,
  groupReplyMention = null,
  messageId = "",
  tenantAccessToken = "",
} = {}) {
  const sourceMessageId = cleanShortText(messageId);
  const token = String(tenantAccessToken || "").trim();
  if (!sourceMessageId || !token) return unavailableStream("cardkit_stream_input_missing");
  const title = cleanShortText(employeeName || "数字员工") || "数字员工";
  const mention = feishuCardMention(groupReplyMention?.userId);
  const prefix = [mention, `**${escapeCardMarkdown(title)}**`].filter(Boolean).join("\n");
  const initialContent = `${prefix}\n\n`;
  const card = {
    schema: "2.0",
    config: {
      streaming_mode: true,
      summary: { content: `${title}正在回复` },
      streaming_config: {
        print_frequency_ms: { default: 50 },
        print_step: { default: 1 },
      },
    },
    body: {
      elements: [{ tag: "markdown", content: initialContent, element_id: "content" }],
    },
  };
  const created = await requestFeishuJson(fetch, FEISHU_CARDKIT_URL, {
    method: "POST",
    headers: authHeaders(token),
    body: JSON.stringify({ type: "card_json", data: JSON.stringify(card) }),
  });
  const cardId = cleanShortText(created?.data?.card_id);
  if (!created.ok || !cardId) return unavailableStream("cardkit_create_failed");
  const sent = await requestFeishuJson(fetch, `${FEISHU_REPLY_MESSAGE_URL}/${encodeURIComponent(sourceMessageId)}/reply`, {
    method: "POST",
    headers: authHeaders(token),
    body: JSON.stringify({
      msg_type: "interactive",
      content: JSON.stringify({ type: "card", data: { card_id: cardId } }),
    }),
  });
  const streamMessageId = cleanShortText(sent?.data?.message_id);
  if (!sent.ok || !streamMessageId) return unavailableStream("cardkit_send_failed");

  let sequence = 1;
  let acceptedText = "";
  let pendingText = "";
  let lastUpdateAt = 0;
  let closed = false;

  async function push({ text = "" } = {}) {
    if (closed) return false;
    pendingText = String(text || "");
    if (!pendingText || pendingText === acceptedText) return true;
    const now = Date.now();
    if (
      acceptedText &&
      pendingText.length - acceptedText.length < STREAM_UPDATE_MINIMUM_DELTA &&
      now - lastUpdateAt < STREAM_UPDATE_INTERVAL_MS
    ) return true;
    return updateContent(pendingText);
  }

  async function updateContent(text) {
    const content = `${prefix}\n\n${formatFeishuCardMarkdown(text)}`;
    sequence += 1;
    const updated = await requestFeishuJson(fetch, `${FEISHU_CARDKIT_URL}/${encodeURIComponent(cardId)}/elements/content/content`, {
      method: "PUT",
      headers: authHeaders(token),
      body: JSON.stringify({
        content,
        sequence,
        uuid: crypto.randomUUID(),
      }),
    });
    if (!updated.ok) return false;
    acceptedText = text;
    lastUpdateAt = Date.now();
    return true;
  }

  async function finish(finalText = "") {
    if (closed) return { sent: false, status: "stream_already_closed" };
    const finalValue = String(pendingText || finalText || acceptedText || "");
    const finalAccepted = finalValue === acceptedText || await updateContent(finalValue);
    if (!finalAccepted) {
      await discard();
      return { sent: false, status: "stream_final_update_failed" };
    }
    sequence += 1;
    const closedResult = await requestFeishuJson(fetch, `${FEISHU_CARDKIT_URL}/${encodeURIComponent(cardId)}/settings`, {
      method: "PATCH",
      headers: authHeaders(token, "application/json; charset=utf-8"),
      body: JSON.stringify({
        settings: JSON.stringify({
          config: {
            streaming_mode: false,
            summary: { content: shortSummary(finalValue) },
          },
        }),
        sequence,
        uuid: crypto.randomUUID(),
      }),
    });
    closed = true;
    return {
      sent: true,
      mode: "feishu_cardkit_streaming_reply",
      status: closedResult.ok ? "agent_streaming_reply_completed" : "agent_streaming_close_failed",
      messageContractOk: true,
      note: closedResult.ok ? "飞书 CardKit 流式回答已完成。" : "回答内容已显示，但 CardKit streaming mode 关闭失败。",
      streaming: true,
    };
  }

  async function discard() {
    if (closed) return;
    closed = true;
    await requestFeishuJson(fetch, `${FEISHU_REPLY_MESSAGE_URL}/${encodeURIComponent(streamMessageId)}`, {
      method: "DELETE",
      headers: authHeaders(token),
    });
  }

  return {
    discard,
    finish,
    push,
    started: true,
  };
}

function unavailableStream(status) {
  return {
    started: false,
    status: cleanShortText(status),
  };
}

async function requestFeishuJson(fetch, url, options) {
  try {
    const response = await fetch(url, options);
    const data = await response.json().catch(() => ({}));
    return {
      ...data,
      ok: response.ok && (!Object.prototype.hasOwnProperty.call(data, "code") || Number(data.code) === 0),
    };
  } catch {
    return { ok: false };
  }
}

function authHeaders(token, contentType = "application/json") {
  return {
    Authorization: `Bearer ${token}`,
    "Content-Type": contentType,
  };
}

function feishuCardMention(userId = "") {
  const value = String(userId || "").trim();
  return /^[A-Za-z0-9_-]{1,128}$/.test(value) ? `<at id=${value}></at>` : "";
}

function escapeCardMarkdown(value = "") {
  return String(value || "").replace(/([\\`*_{}\[\]()#+.!|>-])/g, "\\$1");
}

function shortSummary(value = "") {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  return text.length <= 50 ? text : `${text.slice(0, 47)}...`;
}

export { startFeishuCardKitStream };
