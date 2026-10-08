import crypto from "node:crypto";

function actorSummary(session = {}) {
  return {
    id: actorDigest(session),
    name: cleanShortText(session.name || session.role || "平台用户"),
    departmentId: cleanShortText(session.departmentId || ""),
    role: cleanShortText(session.role || ""),
  };
}

function sanitizeActor(actor = {}) {
  return {
    id: cleanShortText(actor.id),
    name: cleanShortText(actor.name),
    departmentId: cleanShortText(actor.departmentId),
    role: cleanShortText(actor.role),
  };
}

function actorDisplay(session = {}) {
  return cleanShortText(session.name || session.email || session.employeeId || "飞书入口用户");
}

function actorDigest(session = {}) {
  const source = [session.employeeId, session.email, session.feishuUserId, session.name].filter(Boolean).join(":");
  if (!source) return "anonymous";
  return crypto.createHash("sha256").update(source).digest("hex").slice(0, 10);
}

function chinaDate(now = new Date().toISOString()) {
  return new Date(now).toLocaleDateString("zh-CN", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).replace(/\//g, "");
}

function hasPlatformGovernance(session = {}) {
  const permissions = new Set(session.permissions || []);
  return session.role === "admin" || permissions.has("system:*") || permissions.has("control-plane:*") || permissions.has("digital-employees:*");
}

function isHttpsUrl(value = "") {
  return /^https:\/\/[^/]+/i.test(String(value || "").trim());
}

function isLocalCallbackUrl(value = "") {
  return /^http:\/\/(127\.0\.0\.1|localhost|\[::1\]|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/i.test(String(value || "").trim());
}

function normalizeAllowedChatRefs(value = []) {
  const items = Array.isArray(value) ? value : String(value || "").split(/[,\n;，；、]+/);
  return [...new Map(items.map(parseAllowedChatRef).filter(Boolean).map((item) => [
    `${item.name}|${item.feishuId}`,
    item,
  ])).values()].slice(0, 12);
}

function parseAllowedChatRef(value = "") {
  if (value && typeof value === "object") {
    const feishuId = cleanShortText(value.feishuId || value.chatId || value.openChatId || value.openId || value.userId || "");
    const masked = cleanShortText(value.feishuIdMasked);
    const name = cleanShortText(value.name || value.chatName || value.displayName || "");
    if (!name && !feishuId && !masked) return null;
    return {
      type: cleanShortText(value.type || inferFeishuChatRefType(feishuId)),
      name,
      feishuId,
      feishuIdMasked: masked,
      idStatus: cleanShortText(value.idStatus || (feishuId || masked ? "ready" : "missing_id")),
    };
  }
  const text = cleanShortText(value);
  if (!text) return null;
  const parts = text.split(/\s*[|｜]\s*/).map(cleanShortText).filter(Boolean);
  const explicitId = parts.length > 1 ? parts[parts.length - 1] : "";
  const idMatch = explicitId || text.match(/\b(?:oc|ou|on|om|chat|user)[_-][A-Za-z0-9_-]{4,}\b/i)?.[0] || "";
  const name = parts.length > 1
    ? parts.slice(0, -1).join(" | ")
    : cleanShortText(text.replace(idMatch, "").replace(/[()（）\[\]【】]/g, " "));
  return {
    type: inferFeishuChatRefType(idMatch),
    name: name || text,
    feishuId: cleanShortText(idMatch),
    idStatus: idMatch ? "ready" : "missing_id",
  };
}

function inferFeishuChatRefType(feishuId = "") {
  const text = String(feishuId || "").trim().toLowerCase();
  if (text.startsWith("oc_") || text.startsWith("chat_")) return "group_chat";
  if (text.startsWith("ou_") || text.startsWith("on_") || text.startsWith("om_") || text.startsWith("user_")) return "single_user";
  return "unknown";
}

function maskIdentifier(value = "") {
  const text = cleanShortText(value);
  if (!text) return "";
  if (text.length <= 8) return `${text.slice(0, 2)}***${text.slice(-2)}`;
  return `${text.slice(0, 6)}***${text.slice(-4)}`;
}

function digestValue(value = "") {
  const text = String(value || "");
  return text ? crypto.createHash("sha256").update(text).digest("hex").slice(0, 16) : "";
}

function isPersonalScope(value) {
  const text = String(value || "").trim().toLowerCase();
  return !text || /^(personal|self)$/.test(text) || /本人|个人|自己/.test(text);
}

function feishuWebhookUrl() {
  return process.env.FEISHU_ALGORITHM_BOT_WEBHOOK_URL || process.env.FEISHU_BOT_WEBHOOK_URL || "";
}

function hasUnsafeText(values = []) {
  return values.some((value) => {
    const text = String(value || "");
    return /(token=|ticket=|password=|secret=|api[_-]?key=|cookie=|authorization:|bearer\s+[a-z0-9._-]+)/i.test(text);
  });
}

function cleanText(value) {
  return String(value || "").replace(/\s+/g, " ").trim().slice(0, 800);
}

function cleanShortText(value) {
  return String(value || "").replace(/\s+/g, " ").trim().slice(0, 240);
}

function defaultCleanText(value) {
  return cleanText(value);
}

function defaultCleanList(value) {
  const items = Array.isArray(value) ? value : String(value || "").split(/[,\n;，；、]+/);
  return [...new Set(items.map(cleanShortText).filter(Boolean))].slice(0, 30);
}

function uniqueList(items = []) {
  return [...new Set((Array.isArray(items) ? items : [items]).map(cleanShortText).filter(Boolean))];
}

export {
  actorSummary,
  sanitizeActor,
  actorDisplay,
  actorDigest,
  chinaDate,
  hasPlatformGovernance,
  isHttpsUrl,
  isLocalCallbackUrl,
  normalizeAllowedChatRefs,
  parseAllowedChatRef,
  inferFeishuChatRefType,
  maskIdentifier,
  digestValue,
  isPersonalScope,
  feishuWebhookUrl,
  hasUnsafeText,
  cleanText,
  cleanShortText,
  defaultCleanText,
  defaultCleanList,
  uniqueList,
};
