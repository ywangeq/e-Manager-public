import {
  cleanShortText,
  hasUnsafeText,
  isHttpsUrl,
} from "./integration-values.mjs";

const CHANNEL_EXTENSION_CONTRACT_VERSION = "feishu-channel-extension.v1";
const DEFAULT_FIXED_ENTRY = Object.freeze({
  label: "业务入口",
  url: "",
  description: "",
});

function cleanMultilineText(value) {
  return String(value || "").replace(/\r\n?/g, "\n").trim();
}

function normalizeFeishuChannelExtension(value = {}, { strict = false } = {}) {
  const source = value && typeof value === "object" ? value : {};
  const requestedMode = cleanShortText(
    source.responseMode || (source.entryLock?.enabled ? "fixed_entry_reply" : "agent_runtime"),
  );
  const fixedEntrySource = source.fixedEntry || source.entryLock?.fixedReply || source.entryLock || {};
  const fixedEntry = {
    label: cleanShortText(fixedEntrySource.label || DEFAULT_FIXED_ENTRY.label).slice(0, 80),
    url: cleanShortText(fixedEntrySource.url).slice(0, 2_000),
    description: cleanMultilineText(fixedEntrySource.description).slice(0, 320),
  };
  const wantsFixedReply = requestedMode === "fixed_entry_reply";
  const unsafeFixedReply = hasUnsafeText([fixedEntry.label, fixedEntry.url, fixedEntry.description]);
  const invalidFixedReply = wantsFixedReply && (!fixedEntry.url || !isHttpsUrl(fixedEntry.url) || !fixedEntry.description || unsafeFixedReply);

  if (strict && (invalidFixedReply || unsafeFixedReply)) {
    const error = new Error("fixed_entry_reply_requires_safe_https_entry");
    error.code = "fixed_entry_reply_requires_safe_https_entry";
    throw error;
  }

  return {
    responseMode: wantsFixedReply && !invalidFixedReply ? "fixed_entry_reply" : "agent_runtime",
    fixedEntry,
  };
}

function extensionForSession(connection = {}) {
  const normalized = normalizeFeishuChannelExtension(connection.channelExtension || {});
  return {
    contractVersion: CHANNEL_EXTENSION_CONTRACT_VERSION,
    entryLock: {
      enabled: normalized.responseMode === "fixed_entry_reply",
      fixedReply: normalized.fixedEntry,
    },
  };
}

function responsePolicyForFeishuChannelExtension({ connection = {}, defaultResponsePolicy = {}, turnIntent = "unsupported" } = {}) {
  if (!["conversation", "task_request"].includes(turnIntent)) return defaultResponsePolicy;
  const extension = normalizeFeishuChannelExtension(connection.channelExtension || {});
  if (extension.responseMode !== "fixed_entry_reply") return defaultResponsePolicy;

  return {
    id: "feishu-fixed-entry-reply.v1",
    mode: "direct_fixed_reply",
    allowTask: false,
    allowModel: false,
    capabilityDisclosure: "never",
    fixedReplyText: [extension.fixedEntry.label, extension.fixedEntry.description, extension.fixedEntry.url]
      .filter(Boolean)
      .join("\n"),
  };
}

export {
  CHANNEL_EXTENSION_CONTRACT_VERSION,
  extensionForSession,
  normalizeFeishuChannelExtension,
  responsePolicyForFeishuChannelExtension,
};
