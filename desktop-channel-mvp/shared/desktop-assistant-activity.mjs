const ACTIVITY_STATUSES = new Set(["running", "done", "blocked"]);
const ACTIVITY_KINDS = new Set(["governance", "model", "runtime", "stream", "tool"]);
const TASK_STATUSES = new Set(["submitted", "queued", "waiting", "running"]);

export function createAssistantActivityStreamParser(onActivity = () => {}) {
  return createSseStreamParser((eventName, value) => {
    if (eventName !== "step") return;
    const activity = normalizeAssistantActivity(value);
    if (activity) onActivity(activity);
  });
}

export function createAssistantTaskStreamParser(onTask = () => {}) {
  return createSseStreamParser((eventName, value) => {
    if (eventName !== "meta") return;
    const taskId = cleanTaskId(value?.taskId);
    const status = TASK_STATUSES.has(value?.taskStatus) ? value.taskStatus : "queued";
    const sessionId = cleanTaskId(value?.conversationSession?.sessionId);
    if (taskId) onTask({ taskId, status, ...(sessionId ? { sessionId } : {}) });
  });
}

export function createDesktopSandboxBindingStreamParser(onBinding = () => {}) {
  return createSseStreamParser((eventName, value) => {
    if (eventName !== "device-sandbox-binding" || !plainObject(value)) return;
    const allowedFields = new Set(["contractVersion", "taskId", "taskInputDigest", "workspaceInputDigest"]);
    if (Object.keys(value).some((field) => !allowedFields.has(field)) ||
      value.contractVersion !== "device-sandbox-task-material-binding.v1") return;
    const taskId = cleanTaskId(value.taskId);
    const taskInputDigest = cleanSha256(value.taskInputDigest);
    const workspaceInputDigest = cleanSha256(value.workspaceInputDigest);
    if (taskId && taskInputDigest && workspaceInputDigest) {
      onBinding({ taskId, taskInputDigest, workspaceInputDigest });
    }
  });
}

// This event is consumed only by Electron main to bind a local authorized
// selection to a canonical task. It must never enter the renderer's SSE body.
export function stripDesktopSandboxBindingEvents(body = "") {
  return String(body || "").replace(/\r\n/g, "\n").split("\n\n")
    .filter((block) => !/(^|\n)event:\s*device-sandbox-binding\s*(\n|$)/.test(block))
    .join("\n\n");
}

export function claimAssistantStream(streams, employeeId, streamId) {
  const key = assistantStreamKey(employeeId, streamId);
  if (!(streams instanceof Map) || !key || streams.has(key)) return false;
  streams.set(key, true);
  return true;
}

export function isCurrentAssistantStream(streams, employeeId, streamId) {
  const key = assistantStreamKey(employeeId, streamId);
  return streams instanceof Map && Boolean(key) && streams.has(key);
}

export function releaseAssistantStream(streams, employeeId, streamId) {
  if (!isCurrentAssistantStream(streams, employeeId, streamId)) return false;
  streams.delete(assistantStreamKey(employeeId, streamId));
  return true;
}

export function hasAssistantStreamsForEmployee(streams, employeeId) {
  if (!(streams instanceof Map) || !employeeId) return false;
  const prefix = `${employeeId}\0`;
  return Array.from(streams.keys()).some((key) => String(key).startsWith(prefix));
}

function assistantStreamKey(employeeId, streamId) {
  const safeEmployeeId = String(employeeId || "").trim();
  const safeStreamId = String(streamId || "").trim();
  return safeEmployeeId && safeStreamId ? `${safeEmployeeId}\0${safeStreamId}` : "";
}

export function canApplyAssistantStreamMessageUpdate(message, streamId) {
  return Boolean(message && streamId && message.id === streamId && message.status === "streaming");
}

export function hasSuccessfulTerminalChatEvent(body = "") {
  return String(body || "").replace(/\r\n/g, "\n").split("\n\n").some((block) => {
    if (!/(^|\n)event:\s*done\s*(\n|$)/.test(block)) return false;
    const data = block.split("\n")
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trim())
      .join("\n");
    try {
      return JSON.parse(data)?.ok === true;
    } catch {
      return false;
    }
  });
}

export function shouldFollowSubmittedAssistantTask({ body = "", taskId = "" } = {}) {
  return Boolean(cleanTaskId(taskId) && !hasSuccessfulTerminalChatEvent(body));
}

function createSseStreamParser(onEvent) {
  let buffer = "";

  function parseBlock(block) {
    let eventName = "message";
    const dataLines = [];
    for (const line of block.split("\n")) {
      if (line.startsWith("event:")) eventName = line.slice(6).trim();
      if (line.startsWith("data:")) dataLines.push(line.slice(5).trim());
    }
    if (!dataLines.length) return;
    try {
      onEvent(eventName, JSON.parse(dataLines.join("\n")));
    } catch {
      // Ignore malformed SSE blocks at the desktop presentation boundary.
    }
  }

  return {
    push(chunk = "") {
      buffer = `${buffer}${String(chunk)}`.replace(/\r\n/g, "\n");
      let boundary = buffer.indexOf("\n\n");
      while (boundary !== -1) {
        parseBlock(buffer.slice(0, boundary));
        buffer = buffer.slice(boundary + 2);
        boundary = buffer.indexOf("\n\n");
      }
    },
    finish() {
      if (buffer.trim()) parseBlock(buffer);
      buffer = "";
    },
  };
}

export function normalizeAssistantActivity(value = {}) {
  const id = cleanToken(value.id, 96);
  const label = cleanLabel(value.label, 180);
  const status = ACTIVITY_STATUSES.has(value.status) ? value.status : "";
  if (!id || !label || !status) return null;
  return {
    id,
    status,
    label,
    kind: ACTIVITY_KINDS.has(value.kind) ? value.kind : "runtime",
  };
}

export function upsertAssistantActivity(activities = [], nextActivity = null) {
  const normalized = normalizeAssistantActivity(nextActivity);
  if (!normalized) return Array.isArray(activities) ? activities : [];
  const current = Array.isArray(activities) ? activities : [];
  const index = current.findIndex((activity) => activity.id === normalized.id);
  if (index === -1) {
    const startedAt = normalized.status === "running"
      ? safeStartedAt(nextActivity?.startedAt) || Date.now()
      : null;
    return [...current, { ...normalized, ...(startedAt ? { startedAt } : {}) }].slice(-24);
  }
  return current.map((activity, activityIndex) => (
    activityIndex === index ? { ...activity, ...normalized } : activity
  ));
}

function safeStartedAt(value) {
  const timestamp = Number(value);
  return Number.isFinite(timestamp) && timestamp > 0 ? timestamp : null;
}

function cleanToken(value, maxLength) {
  return String(value || "").trim().replace(/[^a-zA-Z0-9_.:-]+/g, "-").slice(0, maxLength);
}

function cleanTaskId(value) {
  const taskId = String(value || "").trim();
  return /^[a-zA-Z0-9_.:-]{1,128}$/.test(taskId) ? taskId : "";
}

function cleanSha256(value) {
  const digest = String(value || "").trim().toLowerCase();
  return /^[a-f0-9]{64}$/.test(digest) ? digest : "";
}

function plainObject(value) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value) &&
    (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null));
}

function cleanLabel(value, maxLength) {
  return String(value || "").replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim().slice(0, maxLength);
}
