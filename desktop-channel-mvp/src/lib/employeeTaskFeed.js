import { normalizeDesktopTaskActivitySnapshot, desktopTaskActivityStatusLabel } from "../../shared/desktop-task-activity.mjs";
import { desktopTaskTimelineView, normalizeDesktopTaskEvent, isDesktopTaskTerminalStatus } from "../../shared/desktop-task-timeline.mjs";
import { toolConfirmationPresentation } from "./toolConfirmationPresentation.js";
import { runStatusLabel } from "./groupRunHistory.js";

export function employeeFeedTaskMessages(messages = [], taskId = "", task = null, state = null) {
  if (!taskId) return messages;
  const scoped = messages.filter(message => message.taskId === taskId);
  const latest = [...scoped].reverse().find(message => message.role === "assistant" && !message.cardRecovery && !message.localNotice);
  const detail = state?.phase === "ready" && !state.stale ? state.detail : null;
  const cachedView = desktopTaskTimelineView(detail?.events || latest?.taskEvents || []);
  const staleTerminal = Boolean(task?.status && cachedView.terminal && cachedView.status !== task.status);
  const projected = { ...(latest || {}), role: "assistant", taskId,
    canonicalTaskStatus: task?.status || latest?.canonicalTaskStatus || "",
    detailSyncPending: staleTerminal || (!detail && (!latest || Boolean(state?.stale))),
    ...(detail ? { content: detail.result?.text || "", taskEvents: detail.events,
      taskActivitySnapshot: detail.activitySnapshot, taskProvenanceSnapshot: detail.provenanceSnapshot } : {}),
    ...(staleTerminal ? { content: "", taskEvents: [], taskActivitySnapshot: null, taskProvenanceSnapshot: null } : {}),
  };
  return latest ? scoped.map(message => message === latest ? projected : message) : [...scoped, projected];
}

export function employeeFeedCards(messages = []) {
  const cards = new Map();
  for (const message of messages) {
    if (message?.role !== "assistant") continue;
    for (const card of message.toolParameterCards || []) {
      if (card?.id) cards.set(card.id, card);
    }
  }
  return [...cards.values()].filter(card => !["submitted", "superseded"].includes(card.status));
}

export function employeeFeedConfirmations(messages = [], now = Date.now()) {
  const confirmations = new Map();
  for (const message of messages) {
    if (message?.role !== "assistant") continue;
    for (const confirmation of message.toolConfirmations || []) {
      if (confirmation?.id) confirmations.set(confirmation.id, confirmation);
    }
  }
  return [...confirmations.values()].filter(item => {
    const presentation = toolConfirmationPresentation(item, now);
    return presentation.pending || presentation.tracking;
  });
}

export function employeeFeedProgress({ message = {}, busy = false, status = {}, confirmations = [] } = {}) {
  if (status.pendingCount) return { label: "等待参数确认", detail: "请确认上方卡片", active: false };
  if (confirmations.some(card => toolConfirmationPresentation(card).pending)) return { label: "等待操作确认", detail: "请审核上方操作卡片", active: false };
  if (["正在提交", "提交状态待同步"].includes(status.label)) return { label: status.label, detail: "参数确认", active: status.label === "正在提交" };
  if (message.canonicalTaskStatus && isDesktopTaskTerminalStatus(message.canonicalTaskStatus)) {
    return { label: `任务${runStatusLabel(message.canonicalTaskStatus)}`, detail: message.detailSyncPending ? "明细待同步" : "点击查看结果", active: false };
  }
  if (message.detailSyncPending) return { label: message.canonicalTaskStatus ? `任务${runStatusLabel(message.canonicalTaskStatus)}` : "所选任务待同步", detail: "明细待同步", active: false };
  const taskId = message.taskId || message.taskEvents?.[0]?.taskId || "";
  const events = (message.taskEvents || []).map(event => normalizeDesktopTaskEvent(event, { expectedTaskId: taskId })).filter(Boolean);
  const view = desktopTaskTimelineView(events);
  const latestEvent = view.events.at(-1);
  const snapshot = taskId ? normalizeDesktopTaskActivitySnapshot(message.taskActivitySnapshot, { expectedTaskId: taskId }) : null;
  const activity = snapshot?.activities.at(-1);
  if (message.failure) return { label: "任务受阻，请查看详情", detail: "", active: false };
  if (view.terminal) return message.canonicalTaskStatus
    ? { label: `任务${runStatusLabel(message.canonicalTaskStatus)}`, detail: "明细待同步", active: busy }
    : { label: view.statusLabel, detail: "点击查看结果", active: false };
  if (latestEvent && (latestEvent.eventType !== "task.progress" || !["tool", "skill"].includes(latestEvent.data.stage) || latestEvent.data.status !== activity?.status || latestEvent.data.stage !== activity?.kind)) {
    return { label: view.phaseLabel, detail: "", active: busy };
  }
  if (activity) {
    const running = busy && activity.status === "running";
    const label = `${running ? "正在执行" : activity.status === "running" ? "最后记录" : desktopTaskActivityStatusLabel(activity.status)}：${activity.displayName}${busy && activity.status === "completed" ? " · 等待后续响应" : ""}`;
    return { label, detail: activity.operationCode || activity.actionCode, active: running };
  }
  if (confirmations.some(card => card.status === "submitting")) return { label: "正在提交确认", detail: "", active: true };
  if (confirmations.some(card => card.status === "submission_unknown")) return { label: "提交状态待核对", detail: "请核对任务状态", active: false };
  return { label: busy ? view.phaseLabel : "本轮结果已送达", detail: "", active: busy };
}

export function employeeFeedStatus({ cards = [], busy = false, failed = false, now = Date.now() } = {}) {
  const pending = cards.filter(card => card.status === "draft" && Date.parse(card.expiresAt) > now);
  if (cards.some(card => card.status === "submitting")) return { label: "正在提交", tone: "working", pendingCount: 0 };
  if (cards.some(card => card.status === "submission_unknown")) return { label: "提交状态待同步", tone: "waiting", pendingCount: 0 };
  if (pending.length) return { label: "等待你确认", tone: "waiting", pendingCount: pending.length };
  if (cards.length) return { label: "参数卡已过期", tone: "expired", pendingCount: 0 };
  if (busy) return { label: "正在处理", tone: "working", pendingCount: 0 };
  return { label: failed ? "任务受阻" : "可对话", tone: failed ? "blocked" : "idle", pendingCount: 0 };
}
