import {
  createProviderRuntimeError,
  providerErrorFromResponse,
} from "./provider-errors.mjs";
import { parseJsonObject, readProviderResponse } from "./provider-sse-reader.mjs";

function createOpenAiChatCompletionsProviderAdapter({
  authMode = "api_key",
  fetch = globalThis.fetch,
  id = "openai-chat-completions",
  upstreamDialect = "openai_compatible_chat",
} = {}) {
  async function requestPayload({ lease = {}, body = {}, canonicalContent = [], onTextDelta = null, signal = null, timeoutController = null } = {}) {
    const requestBody = normalizeChatCompletionsRequest(body, canonicalContent, lease.compat);
    const streamText = typeof onTextDelta === "function" && !requestBody.tools?.length;
    requestBody.stream = streamText;
    let response;
    try {
      response = await fetch(`${lease.baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${lease.authSecret}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(requestBody),
        signal,
      });
    } catch {
      if (signal?.aborted) throw signal.reason;
      throw createProviderRuntimeError("model_provider_unavailable");
    }
    timeoutController?.markConnected?.();
    if (!response.ok) {
      const raw = await response.text().catch(() => "");
      throw providerErrorFromResponse(response, raw);
    }
    if (!streamText) {
      const { json } = await readTimedProviderResponse(response, { signal, timeoutController });
      if (!json) throw createProviderRuntimeError("model_response_contract_invalid");
      const payload = chatPayloadAsCanonicalResponse(json);
      timeoutController?.markSemanticOutput?.();
      return payload;
    }
    let text = "";
    let id = "";
    let model = "";
    let usage = {};
    const { events } = await readTimedProviderResponse(response, { signal, timeoutController,
      onEvent: async (event) => {
        id ||= cleanText(event.id);
        model ||= cleanText(event.model);
        if (event.usage && typeof event.usage === "object") usage = event.usage;
        const delta = chatTextDelta(event);
        if (!delta) return;
        timeoutController?.markSemanticOutput?.();
        text += delta;
        await onTextDelta({ delta, text });
      },
    });
    if (!events.length || !text) throw createProviderRuntimeError("model_response_contract_invalid");
    return {
      id,
      model,
      output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text }] }],
      usage,
    };
  }

  async function requestText(args = {}) {
    const payload = await requestPayload(args);
    const text = payload.output.flatMap((item) => (
      item?.type === "message" ? (item.content || []).map((content) => content?.text || "") : []
    )).filter(Boolean).join("\n");
    if (!text) throw createProviderRuntimeError("model_response_contract_invalid");
    return text;
  }

  return {
    apiProtocol: "openai_chat_completions",
    authMode,
    id,
    matches: (lease = {}) => (
      lease.apiProtocol === "openai_chat_completions" &&
      lease.authMode === authMode &&
      lease.upstreamDialect === upstreamDialect
    ),
    requestPayload,
    requestText,
    supportsFiles: false,
    supportsImages: false,
    upstreamDialect,
  };
}

function normalizeChatCompletionsRequest(body = {}, canonicalContent = [], compat = {}) {
  const content = Array.isArray(canonicalContent) ? canonicalContent : [];
  if (content.some((item) => item?.type === "image" || item?.type === "file")) {
    throw createProviderRuntimeError("model_request_invalid");
  }
  const messages = chatMessagesFromInput(body.input);
  const instructions = cleanText(body.instructions);
  if (instructions) messages.unshift({ role: "system", content: instructions });
  const evidenceText = content
    .filter((item) => item?.type === "text")
    .map((item) => cleanText(item.text))
    .filter(Boolean)
    .join("\n");
  if (evidenceText) messages.push({ role: "user", content: evidenceText });
  if (!messages.length) throw createProviderRuntimeError("model_request_invalid");

  const request = {
    model: cleanText(body.model),
    messages,
    stream: false,
  };
  if (!request.model) delete request.model;
  if (Number.isFinite(Number(body.temperature))) request.temperature = Number(body.temperature);
  if (Number.isFinite(Number(body.top_p))) request.top_p = Number(body.top_p);
  if (Number.isFinite(Number(body.max_output_tokens))) request.max_tokens = Number(body.max_output_tokens);
  if (Array.isArray(body.tools) && body.tools.length) {
    if (compat?.tools !== "supported") throw createProviderRuntimeError("model_request_invalid");
    request.tools = body.tools.map((tool) => chatToolFromCanonical(tool, compat));
    request.tool_choice = body.tool_choice || "auto";
  }
  return request;
}

function chatMessagesFromInput(input = []) {
  const messages = [];
  for (const item of Array.isArray(input) ? input : []) {
    if (["system", "user", "assistant"].includes(item?.role)) {
      const content = textContent(item.content);
      if (content) messages.push({ role: item.role, content });
      continue;
    }
    if (item?.type === "function_call") {
      const call = {
        id: cleanText(item.call_id),
        type: "function",
        function: {
          name: cleanText(item.name),
          arguments: typeof item.arguments === "string" ? item.arguments : JSON.stringify(item.arguments || {}),
        },
      };
      const previous = messages[messages.length - 1];
      if (previous?.role === "assistant" && Array.isArray(previous.tool_calls) && previous.content === null) {
        previous.tool_calls.push(call);
      } else {
        messages.push({ role: "assistant", content: null, tool_calls: [call] });
      }
      continue;
    }
    if (item?.type === "function_call_output") {
      messages.push({
        role: "tool",
        tool_call_id: cleanText(item.call_id),
        content: typeof item.output === "string" ? item.output : JSON.stringify(item.output || {}),
      });
    }
  }
  return messages;
}

function chatToolFromCanonical(tool = {}, compat = {}) {
  if (tool.type === "function" && tool.function) return tool;
  if (tool.type !== "function" || !tool.name || !tool.parameters) {
    throw createProviderRuntimeError("model_request_invalid");
  }
  if (tool.strict === true && !["supported", "non_strict"].includes(compat?.strictTools)) {
    throw createProviderRuntimeError("model_request_invalid");
  }
  return {
    type: "function",
    function: {
      name: cleanText(tool.name),
      ...(tool.description ? { description: cleanText(tool.description) } : {}),
      parameters: tool.parameters,
      ...(tool.strict === true && compat.strictTools === "supported" ? { strict: true } : {}),
    },
  };
}

function chatPayloadAsCanonicalResponse(payload = {}) {
  const choice = Array.isArray(payload.choices) ? payload.choices[0] : null;
  const message = choice?.message;
  if (!message || typeof message !== "object") {
    throw createProviderRuntimeError("model_response_contract_invalid");
  }
  const output = [];
  const text = cleanText(message.content);
  if (text) output.push({ type: "message", role: "assistant", content: [{ type: "output_text", text }] });
  for (const call of Array.isArray(message.tool_calls) ? message.tool_calls : []) {
    if (call?.type !== "function" || !call.id || !call.function?.name) continue;
    output.push({
      type: "function_call",
      call_id: cleanText(call.id),
      name: cleanText(call.function.name),
      arguments: typeof call.function.arguments === "string" ? call.function.arguments : JSON.stringify(call.function.arguments || {}),
    });
  }
  if (!output.length) throw createProviderRuntimeError("model_response_contract_invalid");
  return {
    id: cleanText(payload.id),
    model: cleanText(payload.model),
    output,
    usage: payload.usage && typeof payload.usage === "object" ? payload.usage : {},
  };
}

function textContent(value) {
  if (typeof value === "string") return cleanText(value);
  if (!Array.isArray(value)) return "";
  return value.map((item) => cleanText(item?.text || item?.value)).filter(Boolean).join("\n");
}

function chatTextDelta(event = {}) {
  const content = event?.choices?.[0]?.delta?.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map((item) => cleanText(item?.text || item?.value)).join("");
}

async function readTimedProviderResponse(response, { onEvent = null, signal = null, timeoutController = null } = {}) {
  try {
    return await readProviderResponse(response, {
      onEvent,
      onProviderStreamActivity: () => timeoutController?.markProviderStreamActivity?.(),
    });
  } catch (error) {
    if (signal?.aborted) throw signal.reason || error;
    throw error;
  }
}

function cleanText(value) {
  return String(value || "").trim();
}

export {
  chatPayloadAsCanonicalResponse,
  createOpenAiChatCompletionsProviderAdapter,
  normalizeChatCompletionsRequest,
};
