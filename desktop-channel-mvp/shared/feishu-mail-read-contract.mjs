// Deterministic vendor projection. Business prioritization belongs to the Skill.
const messageId = /^[A-Za-z0-9_.=-]{1,256}$/;
const text = (value, max) => typeof value === "string" && value.length <= max && !value.includes("\0");
const object = value => value && Object.getPrototypeOf(value) === Object.prototype;
const exact = (value, keys) => object(value) && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
const stringSchema = maxLength => ({ type: "string", maxLength });
const base = { toolId: "feishu-personal-mail-read", credentialMode: "device_local_cli", adapterVersion: "1.0.0" };
export const FEISHU_MAIL_LIST_DESCRIPTOR = freeze({ ...base, operationId: "mail.messages.list",
  inputSchema: { type: "object", additionalProperties: false, required: ["pageSize", "pageToken"], properties: {
    pageSize: { type: "integer", minimum: 1, maximum: 20 }, pageToken: stringSchema(1024) } },
  resultSchema: { type: "object", additionalProperties: false, required: ["messageRefs", "hasMore", "pageToken"], properties: {
    messageRefs: { type: "array", maxItems: 20, items: { type: "string", pattern: messageId.source } },
    hasMore: { type: "boolean" }, pageToken: stringSchema(1024) } },
  normalizeInput(value) {
    if (!exact(value, ["pageSize", "pageToken"]) || !Number.isInteger(value.pageSize) || value.pageSize < 1 || value.pageSize > 20 || !text(value.pageToken, 1024) || /[\r\n]/.test(value.pageToken)) throw new Error("feishu_mail_input_invalid");
    return { pageSize: value.pageSize, pageToken: value.pageToken };
  },
  normalizeResult(value) {
    if (!exact(value, ["messageRefs", "hasMore", "pageToken"]) || !Array.isArray(value.messageRefs) || value.messageRefs.length > 20 || !value.messageRefs.every(id => typeof id === "string" && messageId.test(id)) || typeof value.hasMore !== "boolean" || !text(value.pageToken, 1024) || /[\r\n]/.test(value.pageToken) || (value.hasMore && !value.pageToken)) throw new Error("feishu_mail_result_invalid");
    return { messageRefs: [...value.messageRefs], hasMore: value.hasMore, pageToken: value.pageToken };
  },
});
export const FEISHU_MAIL_GET_DESCRIPTOR = freeze({ ...base, operationId: "mail.message.read",
  inputSchema: { type: "object", additionalProperties: false, required: ["messageRef"], properties: { messageRef: { type: "string", pattern: messageId.source } } },
  resultSchema: { type: "object", additionalProperties: false, required: ["messageRef", "subject", "sender", "date", "body", "bodyTruncated"], properties: {
    messageRef: { type: "string", pattern: messageId.source }, subject: stringSchema(1000), sender: stringSchema(500), date: stringSchema(128), body: stringSchema(8000), bodyTruncated: { type: "boolean" } } },
  normalizeInput(value) {
    if (!exact(value, ["messageRef"]) || typeof value.messageRef !== "string" || !messageId.test(value.messageRef)) throw new Error("feishu_mail_input_invalid");
    return { messageRef: value.messageRef };
  },
  normalizeResult(value) {
    if (!exact(value, ["messageRef", "subject", "sender", "date", "body", "bodyTruncated"]) || typeof value.messageRef !== "string" || !messageId.test(value.messageRef) || !text(value.subject, 1000) || !text(value.sender, 500) || !text(value.date, 128) || !text(value.body, 8000) || typeof value.bodyTruncated !== "boolean") throw new Error("feishu_mail_result_invalid");
    return { ...value };
  },
});
function freeze(value) { if (value && typeof value === "object") { Object.values(value).forEach(freeze); Object.freeze(value); } return value; }
