import { createProviderAdapterRegistry } from "./provider-adapter-registry.mjs";
import {
  createProviderRuntimeError,
  providerErrorFromMessage,
  providerErrorFromResponse,
} from "./provider-errors.mjs";
import { canonicalInputDescriptor, safeCanonicalFileName } from "./canonical-input-types.mjs";
import { resolveEphemeralMediaRef } from "./ephemeral-media-ref.mjs";
import { createOpenAiChatCompletionsProviderAdapter } from "./openai-chat-completions-provider-adapter.mjs";
import { parseJsonObject, readProviderResponse } from "./provider-sse-reader.mjs";

const MAX_CANONICAL_IMAGE_BYTES = 16_000_000;
const MAX_CANONICAL_FILE_BYTES = 50 * 1024 * 1024;

function createDefaultProviderAdapterRegistry({ fetch = globalThis.fetch } = {}) {
  return createProviderAdapterRegistry({
    adapters: [
      createOpenAiResponsesProviderAdapter({
        authMode: "codex_oauth",
        defaultCompat: { maxOutputTokens: "omit" },
        fetch,
        id: "codex-internal-responses",
        upstreamDialect: "chatgpt_codex_internal",
      }),
      createOpenAiResponsesProviderAdapter({
        authMode: "api_key",
        defaultCompat: { maxOutputTokens: "supported" },
        fetch,
        id: "openai-public-responses",
        upstreamDialect: "openai_public",
      }),
      createOpenAiChatCompletionsProviderAdapter({
        authMode: "api_key",
        fetch,
        id: "smoreai-chat-completions",
        upstreamDialect: "smore_openai_compatible",
      }),
    ],
  });
}

function createOpenAiResponsesProviderAdapter({
  authMode = "unspecified",
  defaultCompat = {},
  fetch = globalThis.fetch,
  id = "openai-responses",
  upstreamDialect = "unspecified",
} = {}) {
  async function post({ lease = {}, body = {}, canonicalContent = [], signal = null, timeoutController = null } = {}) {
    const requestBody = normalizeRequest(
      { ...defaultCompat, ...(lease.compat || {}) },
      await appendCanonicalContent(body, canonicalContent),
    );
    let response;
    try {
      response = await fetch(`${lease.baseUrl}/responses`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${lease.authSecret}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(requestBody),
        // Provider credentials are scoped to the leased endpoint. Never follow a
        // redirect that could move the Authorization header to another origin.
        redirect: "error",
        signal,
      });
    } catch {
      if (signal?.aborted) throw signal.reason;
      throw createProviderRuntimeError("model_provider_unavailable");
    }
    timeoutController?.markConnected?.();
    if (response.ok && response.body) return response;
    const errorText = await response.text().catch(() => "");
    throw providerErrorFromResponse(response, errorText);
  }

  async function requestPayload({ lease = {}, body = {}, canonicalContent = [], onTextDelta = null, signal = null, timeoutController = null } = {}) {
    const response = await post({ lease, body, canonicalContent, signal, timeoutController });
    let streamedText = "";
    const { events, json } = await readTimedProviderResponse(response, { signal, timeoutController,
      onEvent: async (event) => {
        if (isSemanticProviderEvent(event)) timeoutController?.markSemanticOutput?.();
        if (!isTextDeltaEvent(event)) return;
        const delta = String(event.delta || "");
        if (!delta) return;
        streamedText += delta;
        if (typeof onTextDelta === "function") await onTextDelta({ delta, text: streamedText });
      },
    });
    if (json) {
      if (hasCanonicalSemanticOutput(json)) timeoutController?.markSemanticOutput?.();
      return json;
    }
    throwForFailedEvent(events);
    const completed = [...events].reverse().find((event) => event?.type === "response.completed")?.response || {};
    const completedItems = events
      .filter((event) => event?.type === "response.output_item.done" && event.item)
      .map((event) => event.item);
    const deltaText = events
      .filter((event) => event?.type === "response.output_text.delta" || event?.type === "response.refusal.delta")
      .map((event) => event.delta || "")
      .join("");
    const output = Array.isArray(completed.output) && completed.output.length
      ? completed.output
      : completedItems.length
        ? completedItems
        : deltaText
          ? [{ type: "message", role: "assistant", content: [{ type: "output_text", text: deltaText }] }]
          : [];
    if (!output.length) throw createProviderRuntimeError("model_response_contract_invalid");
    return { ...completed, output, ...(deltaText ? { output_text: deltaText } : {}) };
  }

  async function requestText({ lease = {}, body = {}, canonicalContent = [], onTextDelta = null, signal = null, timeoutController = null } = {}) {
    const response = await post({ lease, body, canonicalContent, signal, timeoutController });
    let streamedText = "";
    const { events, json } = await readTimedProviderResponse(response, { signal, timeoutController,
      onEvent: async (event) => {
        if (isSemanticProviderEvent(event)) timeoutController?.markSemanticOutput?.();
        if (!isTextDeltaEvent(event)) return;
        const delta = String(event.delta || "");
        if (!delta) return;
        streamedText += delta;
        if (typeof onTextDelta === "function") await onTextDelta({ delta, text: streamedText });
      },
    });
    if (json) {
      const text = readOutputText(json);
      timeoutController?.markSemanticOutput?.();
      return text;
    }
    throwForFailedEvent(events);
    const deltaText = events
      .filter((event) => event?.type === "response.output_text.delta" || event?.type === "response.refusal.delta")
      .map((event) => event.delta || "")
      .join("");
    if (deltaText) return deltaText;
    const completedItems = events
      .filter((event) => event?.type === "response.output_item.done" && event.item)
      .map((event) => event.item);
    const completed = [...events].reverse().find((event) => event?.type === "response.completed")?.response || {};
    return readOutputText({ ...completed, output: completed.output?.length ? completed.output : completedItems });
  }

  return {
    apiProtocol: "openai_responses",
    authMode,
    id,
    matches: (lease = {}) => (
      lease.apiProtocol === "openai_responses" &&
      lease.authMode === authMode &&
      lease.upstreamDialect === upstreamDialect
    ),
    requestPayload,
    requestText,
    supportsFiles: true,
    supportsImages: true,
    upstreamDialect,
  };
}

function normalizeRequest(compat = {}, body = {}) {
  const normalized = { ...body };
  if (compat.maxOutputTokens !== "supported") delete normalized.max_output_tokens;
  if (Array.isArray(body.tools)) normalized.tools = body.tools.map(normalizeOpenAiTool);
  return normalized;
}

function normalizeOpenAiTool(tool = {}) {
  if (tool?.type !== "function" || tool.strict !== true || !tool.parameters) return tool;
  return { ...tool, parameters: normalizeStrictSchema(tool.parameters) };
}

function normalizeStrictSchema(schema = {}) {
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) return schema;
  const normalized = { ...schema };
  if (schema.items) normalized.items = normalizeStrictSchema(schema.items);
  if (Array.isArray(schema.anyOf)) normalized.anyOf = schema.anyOf.map(normalizeStrictSchema);
  const types = Array.isArray(schema.type) ? schema.type : [schema.type];
  if (!types.includes("object") || !schema.properties || typeof schema.properties !== "object") return normalized;

  const originallyRequired = new Set(Array.isArray(schema.required) ? schema.required : []);
  normalized.properties = Object.fromEntries(Object.entries(schema.properties).map(([name, propertySchema]) => {
    const strictProperty = normalizeStrictSchema(propertySchema);
    return [name, originallyRequired.has(name) ? strictProperty : nullableSchema(strictProperty)];
  }));
  normalized.required = Object.keys(normalized.properties);
  normalized.additionalProperties = false;
  return normalized;
}

function nullableSchema(schema = {}) {
  const normalized = { ...schema };
  if (Array.isArray(schema.type)) normalized.type = [...new Set([...schema.type, "null"])];
  else if (schema.type) normalized.type = [schema.type, "null"];
  else if (Array.isArray(schema.anyOf)) normalized.anyOf = [...schema.anyOf, { type: "null" }];
  if (Array.isArray(schema.enum) && !schema.enum.includes(null)) normalized.enum = [...schema.enum, null];
  return normalized;
}

async function appendCanonicalContent(body = {}, canonicalContent = []) {
  const items = Array.isArray(canonicalContent) ? canonicalContent.slice(0, 64) : [];
  const content = [];
  let totalImageBytes = 0;
  let totalFileBytes = 0;
  for (const item of items) {
    if (item?.type === "text") {
      const text = String(item.text || "").trim().slice(0, 8_000);
      if (text) content.push({ type: "input_text", text });
      continue;
    }
    if (!["file", "image"].includes(item?.type) || !item.mediaRef) continue;
    const resolved = await resolveEphemeralMediaRef(item.mediaRef);
    const descriptor = canonicalInputDescriptor({ fileName: item.fileName || resolved.fileName, mimeType: resolved.mimeType });
    if (item.type === "image" && descriptor?.type === "image") {
      totalImageBytes += resolved.bytes.length;
      if (totalImageBytes > MAX_CANONICAL_IMAGE_BYTES) throw createProviderRuntimeError("provider_media_limit_exceeded");
      content.push({
        type: "input_image",
        image_url: `data:${descriptor.mimeType};base64,${resolved.bytes.toString("base64")}`,
        detail: normalizeImageDetail(item.detailHint),
      });
      continue;
    }
    if (item.type === "file" && descriptor?.type === "file") {
      totalFileBytes += resolved.bytes.length;
      if (totalFileBytes > MAX_CANONICAL_FILE_BYTES) throw createProviderRuntimeError("provider_file_limit_exceeded");
      content.push({
        type: "input_file",
        filename: safeCanonicalFileName(item.fileName || resolved.fileName, descriptor.mimeType),
        file_data: `data:${descriptor.mimeType};base64,${resolved.bytes.toString("base64")}`,
        ...(descriptor.mimeType === "application/pdf" ? { detail: normalizeFileDetail(item.detailHint) } : {}),
      });
    }
  }
  if (!content.length) return body;
  return {
    ...body,
    input: [...(Array.isArray(body.input) ? body.input : []), { role: "user", content }],
  };
}

function normalizeImageDetail(value = "auto") {
  return ["auto", "low", "high", "original"].includes(value) ? value : "auto";
}

function normalizeFileDetail(value = "auto") {
  return ["auto", "low", "high"].includes(value) ? value : "auto";
}

function isTextDeltaEvent(event = {}) {
  return event?.type === "response.output_text.delta" || event?.type === "response.refusal.delta";
}

function isSemanticProviderEvent(event = {}) {
  if (isTextDeltaEvent(event)) return Boolean(String(event.delta || ""));
  if (event?.type === "response.output_item.done") {
    return ["function_call", "message"].includes(event.item?.type);
  }
  return event?.type === "response.completed" && hasCanonicalSemanticOutput(event.response);
}

function hasCanonicalSemanticOutput(payload = {}) {
  return Boolean(String(payload?.output_text || "").trim()) ||
    (Array.isArray(payload?.output) && payload.output.some((item) => (
      item?.type === "function_call" || item?.type === "message"
    )));
}

async function readTimedProviderResponse(response, { onEvent = null, signal = null, timeoutController = null } = {}) {
  try {
    return await readProviderResponse(response, {
      onEvent,
      isTerminalEvent: event => ["response.completed", "response.failed", "error"].includes(event?.type),
      onProviderStreamActivity: () => timeoutController?.markProviderStreamActivity?.(),
    });
  } catch (error) {
    if (signal?.aborted) throw signal.reason || error;
    throw error;
  }
}

function throwForFailedEvent(events = []) {
  const failed = events.find((event) => event?.type === "response.failed" || event?.type === "error");
  if (failed) {
    throw providerErrorFromMessage(failed.response?.error?.message || failed.error?.message || "model_response_contract_invalid");
  }
}

function readOutputText(payload = {}) {
  if (typeof payload.output_text === "string") return payload.output_text;
  const text = (payload.output || []).flatMap((item) => {
    if (item?.type !== "message") return [];
    return (item.content || []).map((content) => content?.text || content?.value || "");
  }).filter(Boolean).join("\n");
  if (!text) throw createProviderRuntimeError("model_response_contract_invalid");
  return text;
}

export {
  createDefaultProviderAdapterRegistry,
  createOpenAiResponsesProviderAdapter,
  normalizeStrictSchema,
};
