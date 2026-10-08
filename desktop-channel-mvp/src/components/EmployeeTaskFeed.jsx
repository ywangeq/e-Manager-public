import { useEffect, useState } from "react";
import { CaretRight, ListChecks, ChatCircleDots, SpinnerGap, Wrench } from "@phosphor-icons/react";
import { ToolParameterCard } from "./ToolParameterCard.jsx";
import { ToolConfirmationCard } from "./conversation/ConversationMessage.jsx";
import { employeeFeedCards, employeeFeedConfirmations, employeeFeedStatus, employeeFeedProgress, employeeFeedTaskMessages } from "../lib/employeeTaskFeed.js";
import "./employee-task-feed.css";
import { toolConfirmationPresentation } from "../lib/toolConfirmationPresentation.js";

export function EmployeeTaskFeed({ employee, messages = [], busy, taskId = "", liveTaskId = "", task = null, taskDetailState = null, onLoadDetail, onSubmit, onDraftChange, onConfirm, onOpenChat, credentialLabel, renderMessage, progressOnly = false }) {
  messages = employeeFeedTaskMessages(messages, taskId, task, taskDetailState);
  if (taskId) busy = task ? ["queued", "running", "waiting"].includes(task.status) : Boolean(busy && liveTaskId === taskId);
  useEffect(() => {
    if (progressOnly && task && (!taskDetailState || (taskDetailState.phase === "ready" && taskDetailState.stale))) void onLoadDetail?.(task);
  }, [progressOnly, task?.id, task?.revision, taskDetailState?.phase, taskDetailState?.stale, onLoadDetail]);
  const [clock, setClock] = useState(Date.now);
  const [deferredIds, setDeferredIds] = useState([]);
  const cards = employeeFeedCards(messages);
  const latest = [...messages].reverse().find(message => message.role === "assistant" && !message.cardRecovery && !message.localNotice);
  const now = Math.max(clock, Date.now());
  const confirmations = employeeFeedConfirmations(messages, now);
  const status = employeeFeedStatus({ cards, busy, failed: Boolean(latest?.failure), now });
  const progress = employeeFeedProgress({ message: latest, busy, status, confirmations });
  const pendingCount = status.pendingCount + confirmations.filter(card => toolConfirmationPresentation(card, now).pending).length;
  const shownCards = cards.filter(card => !deferredIds.includes(card.id));
  useEffect(() => {
    const expiries = [...cards, ...confirmations].map(card => Date.parse(card.expiresAt)).filter(value => value > Date.now());
    if (!expiries.length) return undefined;
    const timer = window.setTimeout(() => setClock(Date.now()), Math.min(...expiries) - Date.now() + 20);
    return () => window.clearTimeout(timer);
  }, [messages, clock]);

  return <section className="employee-task-feed" aria-label={`${employee.name}任务信息流`}>
    {!progressOnly ? <>
    <div className="employee-feed-toolbar">
      <button type="button" className="employee-feed-pending" onClick={() => setDeferredIds([])} disabled={!cards.length && !confirmations.length}>
        <ListChecks size={14} />{pendingCount ? `待你确认 ${pendingCount}` : cards.length || confirmations.length ? "查看待处理卡片" : "暂无待确认事项"}
      </button>
      <button type="button" className="employee-feed-chat" onClick={onOpenChat}><ChatCircleDots size={14} />查看对话</button>
    </div>
    <div className="employee-feed-card-area">
      {shownCards.length || confirmations.length ? <div className="employee-feed-cards" aria-label="待处理卡片">
        {shownCards.map(card => <ToolParameterCard card={card} compact busy={busy} key={card.id} onDraftChange={onDraftChange} onSubmit={onSubmit}
          onDefer={() => setDeferredIds(current => [...current, card.id])}
          footer={credentialLabel ? <small className="employee-feed-credential">{credentialLabel}</small> : null} />)}
        {confirmations.map(confirmation => <ToolConfirmationCard confirmation={confirmation} key={confirmation.id} onConfirm={onConfirm} />)}
      </div> : null}
    </div>
    </> : null}
    {progressOnly && latest ? <details className="employee-feed-progress"><summary>
      {progress.active ? <SpinnerGap className="spin" size={14} aria-hidden="true" /> : <Wrench size={14} aria-hidden="true" />}
      <strong>最新进展</strong><span title={[progress.label, progress.detail].filter(Boolean).join(" · ")}>{progress.label}{progress.detail ? <small> · {progress.detail}</small> : null}</span><CaretRight size={14} />
    </summary>
      <div>{renderMessage?.({ ...latest, toolParameterCards: [], toolConfirmations: [], authorizationActions: [] })}</div>
    </details> : null}
  </section>;
}
