import {
  DESKTOP_UPDATE_POLICY_CONTRACT,
  normalizeDesktopUpdateSignal,
} from "./release-update-model.mjs";

const SIGNAL_EVENT = "desktop-release-update";
const MAX_PENDING_TEXT = 64 * 1024;

export function createDesktopUpdateSignalClient({
  acceptSignal,
  channel,
  clearTimeoutFn = clearTimeout,
  createAbortController = () => new AbortController(),
  now = () => Date.now(),
  onStateChange = () => {},
  policy,
  product,
  random = Math.random,
  request,
  setTimeoutFn = setTimeout,
} = {}) {
  const subscribers = new Set();
  const enabled = signalPolicyEnabled(policy)
    && typeof request === "function"
    && typeof acceptSignal === "function";
  let abortController = null;
  let activeConnection = null;
  let authenticationStopped = false;
  let failureCount = 0;
  let reconnectTimer = null;
  let started = false;
  let stopped = false;
  let state = {
    connectedAt: "",
    failureCount: 0,
    lastError: "",
    lastEventId: "",
    lastManifestRevision: "",
    retryAt: "",
    status: enabled ? "idle" : "disabled",
    updatedAt: "",
  };

  function start() {
    if (!enabled) return Promise.resolve({ status: "disabled" });
    if (stopped) return Promise.resolve({ status: "stopped" });
    if (authenticationStopped) return Promise.resolve({ status: "authentication_required" });
    started = true;
    cancelReconnect();
    return connect();
  }

  function connect() {
    if (activeConnection) return activeConnection;
    abortController = createAbortController();
    activeConnection = connectOnce(abortController.signal).finally(() => {
      activeConnection = null;
      abortController = null;
    });
    return activeConnection;
  }

  async function connectOnce(signal) {
    setState({ lastError: "", status: "connecting" });
    let response;
    try {
      response = await request({
        headers: { Accept: "text/event-stream" },
        signal,
      });
    } catch (error) {
      if (stopped || signal.aborted) return { status: "stopped" };
      const errorStatus = Number(error?.status || error?.statusCode || 0);
      if (errorStatus === 401 || errorStatus === 403) return stopForAuthentication(errorStatus);
      return handleDisconnect("signal_request_failed");
    }

    const status = Number(response?.status || response?.statusCode || 0);
    if (status === 401 || status === 403) return stopForAuthentication(status);
    if (status !== 200) return handleDisconnect(`signal_http_${status || "invalid"}`);
    if (contentType(response).split(";", 1)[0].trim() !== "text/event-stream" || !response?.body) {
      return handleDisconnect("signal_content_type_invalid");
    }

    setState({ connectedAt: new Date(now()).toISOString(), retryAt: "", status: "connected" });
    try {
      await readEventStream(response.body, consumeEvent, signal);
    } catch (error) {
      if (stopped || signal.aborted) return { status: "stopped" };
      return handleDisconnect(safeStreamError(error));
    }
    if (stopped || signal.aborted) return { status: "stopped" };
    return handleDisconnect("signal_stream_closed");
  }

  async function consumeEvent(eventName, data) {
    if (eventName !== SIGNAL_EVENT) return;
    let input;
    try {
      input = JSON.parse(data);
    } catch {
      setState({ lastError: "signal_json_invalid" });
      return;
    }
    const normalized = normalizeDesktopUpdateSignal(input, { channel, product, now: now() });
    if (!normalized) {
      setState({ lastError: "signal_payload_invalid" });
      return;
    }
    failureCount = 0;
    setState({
      failureCount: 0,
      lastError: "",
      lastEventId: normalized.eventId,
      lastManifestRevision: normalized.manifestRevision,
      retryAt: "",
      status: "connected",
    });
    try {
      await acceptSignal(normalized);
    } catch {
      // One failed signal consumer must not terminate the authenticated transport.
      setState({ lastError: "signal_consumer_failed" });
    }
  }

  function handleDisconnect(error) {
    if (!started || stopped || authenticationStopped) return { status: "stopped" };
    failureCount = Math.min(failureCount + 1, 31);
    if (!policy.retry) {
      started = false;
      setState({ failureCount, lastError: error, retryAt: "", status: "degraded" });
      return { status: "retry_disabled" };
    }
    const exponentialDelay = Math.min(policy.retry.maxMs, policy.retry.baseMs * (2 ** (failureCount - 1)));
    const boundedRandom = Math.min(1, Math.max(0, Number(random()) || 0));
    const jitter = 1 + (((boundedRandom * 2) - 1) * policy.retry.jitterRatio);
    const delayMs = Math.max(0, Math.round(exponentialDelay * jitter));
    const retryAt = new Date(now() + delayMs).toISOString();
    setState({ failureCount, lastError: error, retryAt, status: "reconnecting" });
    reconnectTimer = setTimeoutFn(async () => {
      reconnectTimer = null;
      if (!started || stopped || authenticationStopped) return { status: "stopped" };
      return connect();
    }, delayMs);
    reconnectTimer?.unref?.();
    return { delayMs, retryAt, status: "retry_scheduled" };
  }

  function stopForAuthentication(status) {
    authenticationStopped = true;
    started = false;
    cancelReconnect();
    setState({ lastError: `signal_http_${status}`, retryAt: "", status: "authentication_required" });
    return { status: "authentication_required" };
  }

  function cancelReconnect() {
    if (!reconnectTimer) return;
    clearTimeoutFn(reconnectTimer);
    reconnectTimer = null;
  }

  function stop() {
    stopped = true;
    started = false;
    cancelReconnect();
    abortController?.abort();
    setState({ retryAt: "", status: "stopped" });
  }

  function subscribe(listener) {
    if (typeof listener !== "function") return () => {};
    subscribers.add(listener);
    notifyObserver(listener, getState());
    return () => subscribers.delete(listener);
  }

  function setState(patch) {
    state = { ...state, ...patch, updatedAt: new Date(now()).toISOString() };
    const projection = getState();
    notifyObserver(onStateChange, projection);
    for (const listener of subscribers) notifyObserver(listener, projection);
  }

  function getState() {
    return { ...state };
  }

  return { getState, start, stop, subscribe };
}

function signalPolicyEnabled(policy) {
  return Boolean(
    policy?.contractVersion === DESKTOP_UPDATE_POLICY_CONTRACT
    && policy.mode !== "disabled"
    && policy.triggers?.signal === true
    && policy.capabilities?.signalTransports?.includes("authenticated_sse"),
  );
}

async function readEventStream(body, onEvent, signal) {
  const parser = createEventParser(onEvent);
  const decoder = new TextDecoder();
  for await (const chunk of bodyChunks(body)) {
    if (signal.aborted) return;
    const bytes = typeof chunk === "string" ? new TextEncoder().encode(chunk) : chunk;
    await parser.feed(decoder.decode(bytes, { stream: true }));
  }
  await parser.feed(decoder.decode());
  await parser.finish();
}

async function* bodyChunks(body) {
  if (typeof body?.getReader === "function") {
    const reader = body.getReader();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) return;
        yield value;
      }
    } finally {
      reader.releaseLock?.();
    }
  }
  if (body?.[Symbol.asyncIterator]) {
    yield* body;
    return;
  }
  throw new Error("signal_body_unreadable");
}

function createEventParser(onEvent) {
  let dataLines = [];
  let dataSize = 0;
  let eventName = "";
  let pending = "";
  let firstLine = true;

  async function feed(text) {
    pending += text;
    while (true) {
      const lineEnd = pending.indexOf("\n");
      if (lineEnd < 0) break;
      let line = pending.slice(0, lineEnd);
      pending = pending.slice(lineEnd + 1);
      if (line.endsWith("\r")) line = line.slice(0, -1);
      if (firstLine) {
        line = line.replace(/^\uFEFF/, "");
        firstLine = false;
      }
      await consumeLine(line);
    }
    if (pending.length > MAX_PENDING_TEXT) throw new Error("signal_frame_too_large");
  }

  async function consumeLine(line) {
    if (!line) {
      if (dataLines.length) await onEvent(eventName, dataLines.join("\n"));
      dataLines = [];
      dataSize = 0;
      eventName = "";
      return;
    }
    if (line.startsWith(":")) return;
    const separator = line.indexOf(":");
    const field = separator < 0 ? line : line.slice(0, separator);
    let value = separator < 0 ? "" : line.slice(separator + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    if (field === "event") eventName = value;
    if (field === "data") {
      dataSize += value.length;
      if (dataSize > MAX_PENDING_TEXT) throw new Error("signal_frame_too_large");
      dataLines.push(value);
    }
  }

  async function finish() {
    if (pending) await consumeLine(pending.endsWith("\r") ? pending.slice(0, -1) : pending);
    if (dataLines.length) await onEvent(eventName, dataLines.join("\n"));
    pending = "";
    dataLines = [];
    dataSize = 0;
    eventName = "";
  }

  return { feed, finish };
}

function contentType(response) {
  if (typeof response?.headers?.get === "function") return String(response.headers.get("content-type") || "").toLowerCase();
  const headers = response?.headers || {};
  return String(headers["content-type"] || headers["Content-Type"] || "").toLowerCase();
}

function notifyObserver(observer, value) {
  try {
    observer(value);
  } catch {
    // Transport observers are presentation-only and must not alter update behavior.
  }
}

function safeStreamError(error) {
  const code = String(error?.message || "");
  return ["signal_body_unreadable", "signal_frame_too_large"].includes(code) ? code : "signal_stream_failed";
}
