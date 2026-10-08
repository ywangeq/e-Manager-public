import { isDesktopTaskTerminalStatus, normalizeDesktopTaskEvent } from "../shared/desktop-task-timeline.mjs";

export function createDesktopTaskEventClient({
  requestEvents,
  resolveConversationResult,
  recoverCanonicalTaskState = async () => null,
  onConnectionState = () => {},
  onEvent = () => {},
  waitForRetry = defaultRetryWait,
} = {}) {
  if (typeof requestEvents !== "function") throw new TypeError("desktop task event client requires requestEvents");
  if (typeof resolveConversationResult !== "function") throw new TypeError("desktop task event client requires resolveConversationResult");

  async function follow({ employeeId, taskId, afterSeq = 0, signal } = {}) {
    let cursor = normalizeSequence(afterSeq);
    let resultAvailable = false;
    let terminalStatus = "";
    let terminalErrorCode = "";
    let connectionState = "";
    const updateConnectionState = (status) => {
      if (signal?.aborted) return;
      if (connectionState === status) return;
      connectionState = status;
      onConnectionState({ employeeId, taskId, status });
    };
    const settleTerminal = async ({ resultMarkerVerified = false } = {}) => {
      if (terminalStatus === "completed" && !resultAvailable) {
        if (!resultMarkerVerified) {
          const recovered = await recoverCanonicalTaskStateWithRetry({ employeeId, recoverCanonicalTaskState, signal, taskId, waitForRetry });
          resultAvailable = recovered?.resultAvailable === true;
        }
        if (!resultAvailable) throw clientError("desktop_task_event_result_marker_missing");
      }
      const result = terminalStatus === "completed"
        ? await resolveResultWithRetry({ employeeId, resolveConversationResult, signal, status: terminalStatus, taskId, waitForRetry })
        : null;
      return Object.freeze({
        employeeId,
        taskId,
        lastSeq: cursor,
        status: terminalStatus,
        errorCode: terminalErrorCode,
        text: terminalStatus === "completed" ? String(result?.text || "") : "",
        toolParameterCards: terminalStatus === "completed" && Array.isArray(result?.toolParameterCards)
          ? result.toolParameterCards
          : [],
        toolConfirmations: terminalStatus === "completed" && Array.isArray(result?.toolConfirmations)
          ? result.toolConfirmations
          : [],
      });
    };
    if (cursor > 0) {
      const recovered = await recoverCanonicalTaskStateWithRetry({ employeeId, recoverCanonicalTaskState, signal, taskId, waitForRetry });
      if (!recovered || !Number.isSafeInteger(recovered.latestSeq) || recovered.latestSeq < cursor ||
        typeof recovered.resultAvailable !== "boolean" || typeof recovered.terminal !== "boolean") {
        throw clientError("desktop_task_event_recovery_invalid");
      }
      resultAvailable = recovered.resultAvailable;
      if (recovered.terminal && cursor >= recovered.latestSeq && isDesktopTaskTerminalStatus(recovered.status)) {
        terminalStatus = recovered.status;
        terminalErrorCode = String(recovered.errorCode || "");
        return settleTerminal({ resultMarkerVerified: true });
      }
    }
    updateConnectionState("connecting");
    while (!signal?.aborted) {
      let response;
      try {
        response = await requestEvents({ afterSeq: cursor, employeeId, signal, taskId });
      } catch (error) {
        if (signal?.aborted) throw clientError("desktop_task_event_subscription_aborted");
        updateConnectionState("reconnecting");
        await waitForRetry({ signal });
        continue;
      }
      if (signal?.aborted) throw clientError("desktop_task_event_subscription_aborted");
      if ([401, 403].includes(response?.status)) throw clientError("desktop_task_event_access_denied");
      if (response?.status === 404) throw clientError("desktop_task_event_not_found");
      if (response?.status === 409) throw clientError("desktop_task_event_cursor_ahead");
      if (response?.status === 410) throw clientError("desktop_task_event_cursor_expired");
      if (!response?.ok) {
        updateConnectionState("reconnecting");
        await waitForRetry({ signal });
        continue;
      }
      updateConnectionState("connected");
      const parser = createTaskEventParser({
        afterSeq: cursor,
        onTaskEvent(event) {
          cursor = event.seq;
          if (event.eventType === "task.result_available") resultAvailable = true;
          if (event.eventType === "task.state_changed" && isDesktopTaskTerminalStatus(event.data?.status)) {
            terminalStatus = event.data.status;
            terminalErrorCode = String(event.data?.lastErrorCode || "");
          }
          onEvent({ employeeId, taskId, seq: event.seq, event });
        },
        taskId,
      });
      try {
        await readResponseBody(response, parser, signal);
        if (signal?.aborted) throw clientError("desktop_task_event_subscription_aborted");
        parser.finish();
      } catch (error) {
        if (signal?.aborted || error?.code === "desktop_task_event_subscription_aborted") throw error;
        if (String(error?.code || "").startsWith("desktop_task_event_")) throw error;
        updateConnectionState("reconnecting");
        await waitForRetry({ signal });
        continue;
      }
      if (terminalStatus) {
        return settleTerminal();
      }
      updateConnectionState("reconnecting");
      await waitForRetry({ signal });
    }
    throw clientError("desktop_task_event_subscription_aborted");
  }

  return Object.freeze({ follow });
}

async function resolveResultWithRetry({ employeeId, resolveConversationResult, signal, status, taskId, waitForRetry }) {
  while (!signal?.aborted) {
    try {
      return await resolveConversationResult({ employeeId, status, taskId });
    } catch (error) {
      if (signal?.aborted) throw clientError("desktop_task_event_subscription_aborted");
      if ([
        "desktop_task_event_access_denied",
        "desktop_task_event_actor_changed",
        "desktop_task_event_result_not_found",
      ].includes(error?.code)) throw error;
      await waitForRetry({ signal });
    }
  }
  throw clientError("desktop_task_event_subscription_aborted");
}

async function recoverCanonicalTaskStateWithRetry({ employeeId, recoverCanonicalTaskState, signal, taskId, waitForRetry }) {
  while (!signal?.aborted) {
    try {
      const recovered = await recoverCanonicalTaskState({ employeeId, signal, taskId });
      if (signal?.aborted) throw clientError("desktop_task_event_subscription_aborted");
      return recovered;
    } catch (error) {
      if (signal?.aborted) throw clientError("desktop_task_event_subscription_aborted");
      if (String(error?.code || "").startsWith("desktop_task_event_")) throw error;
      await waitForRetry({ signal });
    }
  }
  throw clientError("desktop_task_event_subscription_aborted");
}

export function createTaskEventParser({ afterSeq = 0, onTaskEvent = () => {}, taskId = "" } = {}) {
  let buffer = "";
  let cursor = normalizeSequence(afterSeq);

  function parseBlock(block) {
    let eventName = "message";
    let eventId = null;
    const dataLines = [];
    for (const line of block.split("\n")) {
      if (line.startsWith(":")) continue;
      if (line.startsWith("event:")) eventName = line.slice(6).trim();
      if (line.startsWith("id:")) eventId = normalizeSequence(line.slice(3).trim());
      if (line.startsWith("data:")) dataLines.push(line.slice(5).trim());
    }
    if (eventName !== "task-event" || eventId === null || !dataLines.length) return;
    let event;
    try {
      event = JSON.parse(dataLines.join("\n"));
    } catch {
      throw clientError("desktop_task_event_payload_invalid");
    }
    if (event?.taskId !== taskId || event?.seq !== eventId) throw clientError("desktop_task_event_identity_mismatch");
    const normalizedEvent = normalizeDesktopTaskEvent(event, { expectedTaskId: taskId, expectedSeq: eventId });
    if (!normalizedEvent) throw clientError("desktop_task_event_payload_invalid");
    if (eventId <= cursor) return;
    if (eventId !== cursor + 1) throw clientError("desktop_task_event_sequence_gap");
    cursor = eventId;
    onTaskEvent(normalizedEvent);
  }

  return Object.freeze({
    finish() {
      if (buffer.trim()) parseBlock(buffer);
      buffer = "";
    },
    push(chunk = "") {
      buffer = `${buffer}${String(chunk)}`.replace(/\r\n/g, "\n");
      let boundary = buffer.indexOf("\n\n");
      while (boundary !== -1) {
        parseBlock(buffer.slice(0, boundary));
        buffer = buffer.slice(boundary + 2);
        boundary = buffer.indexOf("\n\n");
      }
    },
  });
}

async function readResponseBody(response, parser, signal) {
  if (!response.body?.getReader) {
    const body = await response.text();
    if (signal?.aborted) throw clientError("desktop_task_event_subscription_aborted");
    parser.push(body);
    return;
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  while (!signal?.aborted) {
    const { done, value } = await reader.read();
    if (signal?.aborted) {
      await reader.cancel().catch(() => {});
      throw clientError("desktop_task_event_subscription_aborted");
    }
    if (done) break;
    parser.push(decoder.decode(value, { stream: true }));
  }
  if (signal?.aborted) {
    await reader.cancel().catch(() => {});
    throw clientError("desktop_task_event_subscription_aborted");
  }
  const tail = decoder.decode();
  if (tail) parser.push(tail);
}

function normalizeSequence(value) {
  const sequence = Number(value);
  if (!Number.isSafeInteger(sequence) || sequence < 0) throw clientError("desktop_task_event_sequence_invalid");
  return sequence;
}

function defaultRetryWait({ signal } = {}) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(clientError("desktop_task_event_subscription_aborted"));
    const finish = () => {
      signal?.removeEventListener?.("abort", abort);
      resolve();
    };
    const abort = () => {
      clearTimeout(timer);
      reject(clientError("desktop_task_event_subscription_aborted"));
    };
    const timer = setTimeout(finish, 750);
    timer.unref?.();
    signal?.addEventListener?.("abort", abort, { once: true });
  });
}

function clientError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}
