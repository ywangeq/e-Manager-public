import { createDesktopTaskEventClient } from "./desktop-task-event-client.mjs";
import { projectDesktopTaskActivitySnapshot } from "../shared/desktop-task-activity.mjs";
import { projectDesktopTaskProvenance } from "../shared/desktop-task-provenance.mjs";
import { isDesktopTaskTerminalStatus } from "../shared/desktop-task-timeline.mjs";
import { normalizeDesktopMyTaskEventPage } from "../shared/desktop-my-tasks.mjs";

export function createDesktopTaskFollowService({ cleanMessage, desktopFetch, isExpectedActor, onTaskTerminal = null } = {}) {
  const subscriptions = new Map();
  const terminalNotifications = new Set();

  async function follow({
    afterSeq = 0,
    employeeId,
    sender,
    streamId,
    taskId,
    purpose = "conversation",
    expectedActorContextVersion,
    expectedActorKey,
  }) {
    if (!isExpectedActor(expectedActorKey, expectedActorContextVersion)) throw taskEventError("desktop_task_event_actor_changed");
    if (!Number.isSafeInteger(Number(afterSeq)) || Number(afterSeq) < 0) {
      throw taskEventError("desktop_task_event_sequence_invalid");
    }
    if (!new Set(["conversation", "my_tasks"]).has(purpose)) {
      throw taskEventError("desktop_task_event_purpose_invalid");
    }
    const subscriptionKey = `${expectedActorContextVersion}:${purpose}:${employeeId}:${taskId}:${streamId}`;
    const existing = subscriptions.get(subscriptionKey);
    if (existing) return existing.promise;
    const controller = new AbortController();
    const canSend = () => !controller.signal.aborted && isExpectedActor(expectedActorKey, expectedActorContextVersion);
    const notifyTerminal = (status) => {
      if (!isDesktopTaskTerminalStatus(status) || terminalNotifications.has(subscriptionKey)) return;
      terminalNotifications.add(subscriptionKey);
      try { onTaskTerminal?.({ employeeId, status, taskId }); } catch {}
    };
    let lastActivitySnapshot = "";
    let lastProvenanceSnapshot = "";
    const refreshActivitySnapshot = async () => {
      const response = await desktopFetch(
        `/api/digital-employees/${encodeURIComponent(employeeId)}/runtime-tasks/${encodeURIComponent(taskId)}/events?afterSeq=0&limit=1`,
        { headers: { Accept: "application/json" }, signal: controller.signal },
      );
      if (!response?.ok || typeof response.json !== "function") return;
      const page = await response.json().catch(() => null);
      const snapshot = projectDesktopTaskActivitySnapshot(page, { expectedTaskId: taskId });
      const provenance = projectDesktopTaskProvenance(page, { expectedTaskId: taskId });
      if (!canSend() || sender?.isDestroyed?.()) return;
      if (snapshot) {
        const signature = JSON.stringify(snapshot);
        if (signature !== lastActivitySnapshot) {
          lastActivitySnapshot = signature;
          sender.send("desktop:assistant-task-activity", { employeeId, streamId, taskId, snapshot });
        }
      }
      if (provenance) {
        const signature = JSON.stringify(provenance);
        if (signature !== lastProvenanceSnapshot) {
          lastProvenanceSnapshot = signature;
          sender.send("desktop:assistant-task-provenance", { employeeId, streamId, taskId, snapshot: provenance });
        }
      }
    };
    if (canSend()) {
      sendActivity(sender, { employeeId, streamId, activity: { id: "task-follow", status: "running", label: "正在恢复任务进度", kind: "runtime" } });
    }
    const client = createDesktopTaskEventClient({
      requestEvents: async ({ afterSeq, signal }) => {
        await refreshActivitySnapshot().catch(() => null);
        return desktopFetch(
          `/api/digital-employees/${encodeURIComponent(employeeId)}/runtime-tasks/${encodeURIComponent(taskId)}/events?afterSeq=${afterSeq}`,
          { headers: { Accept: "text/event-stream" }, signal },
        );
      },
      resolveConversationResult: async ({ status }) => {
        if (status !== "completed") return { text: "" };
        if (!isExpectedActor(expectedActorKey, expectedActorContextVersion)) throw taskEventError("desktop_task_event_actor_changed");
        const response = await desktopFetch(
          `/api/digital-employees/${encodeURIComponent(employeeId)}/runtime-tasks/${encodeURIComponent(taskId)}/result`,
          { headers: { Accept: "application/json" }, signal: controller.signal },
        );
        const data = await response.json().catch(() => ({}));
        if ([401, 403].includes(response.status)) throw taskEventError("desktop_task_event_access_denied");
        if (response.status === 404) throw taskEventError("desktop_task_event_result_not_found");
        if (!isExpectedActor(expectedActorKey, expectedActorContextVersion)) throw taskEventError("desktop_task_event_actor_changed");
        if (!response.ok || data?.ok !== true || data.taskId !== taskId || data.employeeId !== employeeId || data.result?.role !== "assistant" || !String(data.result?.text || "").trim()) {
          throw taskEventError(cleanMessage(data?.error || "desktop_task_event_result_unavailable"));
        }
        return {
          text: String(data.result.text),
          toolParameterCards: Array.isArray(data.toolParameterCards) ? data.toolParameterCards : [],
          toolConfirmations: Array.isArray(data.toolConfirmations) ? data.toolConfirmations : [],
        };
      },
      recoverCanonicalTaskState: async () => {
        const reference = { employeeId, taskId };
        let afterSeq = 0;
        let resultAvailable = false;
        let terminalEvent = null;
        for (let pageIndex = 0; pageIndex < 20; pageIndex += 1) {
          if (controller.signal.aborted) throw taskEventError("desktop_task_event_subscription_aborted");
          if (!isExpectedActor(expectedActorKey, expectedActorContextVersion)) throw taskEventError("desktop_task_event_actor_changed");
          const response = await desktopFetch(
            `/api/digital-employees/${encodeURIComponent(employeeId)}/runtime-tasks/${encodeURIComponent(taskId)}/events?afterSeq=${afterSeq}&limit=200`,
            { headers: { Accept: "application/json" }, signal: controller.signal },
          );
          const data = await response.json().catch(() => ({}));
          if (controller.signal.aborted) throw taskEventError("desktop_task_event_subscription_aborted");
          if ([401, 403].includes(response.status)) throw taskEventError("desktop_task_event_access_denied");
          if (response.status === 404) throw taskEventError("desktop_task_event_not_found");
          if (response.status === 409) throw taskEventError("desktop_task_event_cursor_ahead");
          if (response.status === 410) throw taskEventError("desktop_task_event_cursor_expired");
          if (!response.ok) {
            if (response.status === 429 || (response.status >= 500 && response.status <= 599)) {
              throw new Error("desktop_task_event_marker_recovery_transport_retry");
            }
            throw taskEventError("desktop_task_event_marker_recovery_unavailable");
          }
          if (!isExpectedActor(expectedActorKey, expectedActorContextVersion)) throw taskEventError("desktop_task_event_actor_changed");
          let page;
          try {
            page = normalizeDesktopMyTaskEventPage(data, { ...reference, afterSeq });
          } catch {
            throw taskEventError("desktop_task_event_marker_recovery_invalid");
          }
          resultAvailable ||= page.resultAvailable;
          for (const event of page.events) {
            if (event.eventType !== "task.state_changed" || !isDesktopTaskTerminalStatus(event.data?.status)) continue;
            if (terminalEvent) throw taskEventError("desktop_task_event_marker_recovery_terminal_duplicate");
            terminalEvent = event;
          }
          if (!page.hasMore) {
            if (page.terminal !== Boolean(terminalEvent) ||
              (terminalEvent && (terminalEvent.seq !== page.latestSeq || terminalEvent.data?.status !== page.taskStatus))) {
              throw taskEventError("desktop_task_event_marker_recovery_terminal_invalid");
            }
            return Object.freeze({
              errorCode: terminalEvent ? String(terminalEvent.data?.lastErrorCode || "") : "",
              latestSeq: page.latestSeq,
              resultAvailable,
              status: terminalEvent ? terminalEvent.data.status : "",
              terminal: page.terminal,
            });
          }
          if (page.lastSeq <= afterSeq || pageIndex === 19) {
            throw taskEventError("desktop_task_event_marker_recovery_timeline_too_large");
          }
          afterSeq = page.lastSeq;
        }
        throw taskEventError("desktop_task_event_marker_recovery_timeline_too_large");
      },
      onConnectionState: ({ status }) => {
        if (!canSend()) return;
        sendTaskConnection(sender, { connectionState: status, employeeId, streamId, taskId });
        const activity = {
          connecting: { status: "running", label: "正在恢复任务进度" },
          reconnecting: { status: "running", label: "正在续接任务进度" },
          connected: { status: "done", label: "已恢复任务进度" },
        }[status];
        if (activity) sendActivity(sender, { employeeId, streamId, activity: { id: "task-follow", kind: "runtime", ...activity } });
      },
      onEvent: ({ event }) => {
        if (event.eventType === "task.state_changed") notifyTerminal(cleanMessage(event.data?.status || "running").slice(0, 40));
        if (!canSend() || sender?.isDestroyed?.()) return;
        sender.send("desktop:assistant-task-event", { employeeId, streamId, taskId, event });
        if (event.eventType === "task.state_changed") {
          const taskStatus = cleanMessage(event.data?.status || "running").slice(0, 40);
          sender.send("desktop:assistant-task", { employeeId, streamId, taskId, status: taskStatus });
        }
        const activity = taskEventActivity(event, cleanMessage);
        if (activity) sendActivity(sender, { employeeId, streamId, activity });
      },
    });
    const promise = client.follow({ afterSeq: Number(afterSeq), employeeId, taskId, signal: controller.signal }).then(async (result) => {
      if (!isExpectedActor(expectedActorKey, expectedActorContextVersion)) throw taskEventError("desktop_task_event_actor_changed");
      notifyTerminal(result.status);
      await refreshActivitySnapshot().catch(() => null);
      if (result.status === "completed" && !result.text) throw taskEventError("desktop_task_event_result_unavailable");
      return {
        ok: result.status === "completed",
        status: 200,
        body: syntheticAssistantSseBody(result),
        credentialEvents: [],
        recoveredFromTaskEvents: true,
        taskId,
        lastSeq: result.lastSeq,
      };
    }).finally(() => {
      if (subscriptions.get(subscriptionKey)?.promise === promise) subscriptions.delete(subscriptionKey);
      terminalNotifications.delete(subscriptionKey);
    });
    subscriptions.set(subscriptionKey, { controller, employeeId, promise, purpose, taskId });
    return promise;
  }

  function retainMyTasks(references = []) {
    const retained = new Set((Array.isArray(references) ? references : [])
      .map((reference) => `${reference?.employeeId || ""}:${reference?.taskId || ""}`));
    for (const [key, subscription] of subscriptions) {
      if (subscription.purpose !== "my_tasks") continue;
      if (retained.has(`${subscription.employeeId}:${subscription.taskId}`)) continue;
      subscription.controller.abort();
      subscriptions.delete(key);
    }
  }

  function abortAll() {
    for (const subscription of subscriptions.values()) subscription.controller.abort();
    subscriptions.clear();
  }

  return Object.freeze({ abortAll, follow, retainMyTasks });
}

function sendActivity(sender, { employeeId, streamId, activity }) {
  if (!streamId || sender?.isDestroyed?.()) return;
  sender.send("desktop:assistant-activity", { employeeId, streamId, activity });
}

function sendTaskConnection(sender, payload) {
  if (!payload.streamId || sender?.isDestroyed?.()) return;
  sender.send("desktop:assistant-task", payload);
}

function taskEventActivity(event = {}, cleanMessage) {
  if (event.eventType === "task.result_available") return { id: "result", status: "done", label: "任务结果已安全保存", kind: "runtime" };
  if (event.eventType === "task.artifact_available") return { id: `artifact-${event.seq}`, status: "done", label: "任务产物已登记", kind: "runtime" };
  const code = cleanMessage(event.data?.code || "");
  const byCode = {
    task_submitted: { id: "task-queue", status: "running", label: "任务已接收，等待运行资源", kind: "runtime" },
    worker_claimed: { id: "task-queue", status: "done", label: "运行资源已就绪", kind: "runtime" },
    provider_started: { id: "model", status: "running", label: "模型正在生成", kind: "model" },
    skill_started: { id: `task-skill-${event.seq}`, status: "running", label: "已挂载 Skill 正在执行", kind: "runtime" },
    skill_completed: { id: `task-skill-${event.seq}`, status: "done", label: "已完成 Skill 执行", kind: "runtime" },
    skill_blocked: { id: `task-skill-${event.seq}`, status: "blocked", label: "Skill 执行已被运行门禁阻断", kind: "runtime" },
    tool_started: { id: "task-tool", status: "running", label: "正在调用已声明 Tool", kind: "tool" },
    tool_completed: { id: "task-tool", status: "done", label: "已完成 Tool 调用", kind: "tool" },
    tool_blocked: { id: "task-tool", status: "blocked", label: "Tool 调用已被运行门禁阻断", kind: "tool" },
    tool_target_rejected: { id: "task-tool", status: "blocked", label: "目标系统未接受本次 Tool 操作", kind: "tool" },
    provider_completed: { id: "model", status: "done", label: "模型生成完成", kind: "model" },
    worker_settled: { id: "task-runtime", status: "done", label: "后台任务执行已结束", kind: "runtime" },
  };
  const status = cleanMessage(event.data?.status || "");
  if (code === "worker_settled" && ["blocked", "failed", "lost", "rejected", "timed_out"].includes(status)) return { id: "task-runtime", status: "blocked", label: "任务执行未完成", kind: "runtime" };
  if (byCode[code]) return byCode[code];
  if (event.eventType !== "task.state_changed") return null;
  if (status === "waiting") return { id: "task-queue", status: "running", label: "任务正在等待可用资源", kind: "runtime" };
  if (status === "running") return { id: "task-runtime", status: "running", label: "后台任务正在执行", kind: "runtime" };
  return null;
}

function taskEventError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

function syntheticAssistantSseBody(result = {}) {
  const task = { id: result.taskId, status: result.status };
  if (result.status === "completed") {
    return `event: delta\ndata: ${JSON.stringify({ text: result.text })}\n\nevent: done\ndata: ${JSON.stringify({ ok: true, runtimeTask: task, toolParameterCards: result.toolParameterCards || [], toolConfirmations: result.toolConfirmations || [] })}\n\n`;
  }
  return `event: error\ndata: ${JSON.stringify({ code: result.errorCode || `runtime_task_${result.status}` })}\n\nevent: done\ndata: ${JSON.stringify({ ok: false, runtimeTask: task })}\n\n`;
}
