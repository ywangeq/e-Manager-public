async function readProviderResponse(response, { onEvent = null, onProviderStreamActivity = null, isTerminalEvent = null } = {}) {
  const contentType = String(response?.headers?.get?.("content-type") || "").toLowerCase();
  if (!contentType.includes("text/event-stream") || !response?.body?.getReader) {
    const raw = await response.text().catch(() => "");
    return { events: [], json: parseJsonObject(raw), raw };
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const events = [];
  let buffer = "";
  let terminal = false;
  const acceptEvent = async event => {
    if (terminal) return;
    if (typeof onEvent === "function") await onEvent(event);
    terminal = typeof isTerminalEvent === "function" && isTerminalEvent(event) === true;
  };
  while (true) {
    const { done, value } = await reader.read();
    if (value?.byteLength && typeof onProviderStreamActivity === "function") onProviderStreamActivity();
    buffer += decoder.decode(value || new Uint8Array(), { stream: !done });
    buffer = await drainSseBlocks(buffer, events, acceptEvent, done, () => terminal);
    if (terminal) {
      // A protocol completion does not depend on the transport closing.
      void reader.cancel().catch(() => {});
      break;
    }
    if (done) break;
  }
  return { events, json: null, raw: "" };
}

async function drainSseBlocks(buffer, events, onEvent, final = false, shouldStop = () => false) {
  let remaining = buffer;
  while (true) {
    const boundary = remaining.match(/\r?\n\r?\n/);
    if (!boundary?.index && boundary?.index !== 0) break;
    const block = remaining.slice(0, boundary.index);
    remaining = remaining.slice(boundary.index + boundary[0].length);
    await acceptSseBlock(block, events, onEvent);
    if (shouldStop()) return "";
  }
  if (final && remaining.trim()) {
    await acceptSseBlock(remaining, events, onEvent);
    return "";
  }
  return remaining;
}

async function acceptSseBlock(block, events, onEvent) {
  const data = String(block || "").split(/\r?\n/)
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trim())
    .filter(Boolean);
  if (!data.length || data.includes("[DONE]")) return;
  const event = parseJsonObject(data.join("\n"));
  if (!event) return;
  events.push(event);
  if (typeof onEvent === "function") await onEvent(event);
}

function parseJsonObject(value = "") {
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export { parseJsonObject, readProviderResponse };
