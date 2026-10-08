import { useEffect, useState } from "react";

import { CaretDown, CaretRight, TrashSimple } from "@phosphor-icons/react";

import { runStatusLabel } from "../lib/groupRunHistory.js";
import { cockpitRecordTimeLabel } from "../lib/cockpitProgressPresentation.js";
import { automationRuleLabel } from "../lib/workbenchTaskHistory.js";
import { groupWorkbenchHistory } from "../lib/groupWorkbenchHistory.js";
import { automationRunFingerprint } from "../lib/automationRunReadCache.js";

function statusTone(status) {
  const value = String(status || "");
  return ["completed"].includes(value) ? "done" : ["failed", "blocked", "rejected", "canceled", "timed_out", "reconcile_required"].includes(value) ? "bad" : "active";
}

export function GroupHistoryCard({ item, selectedKey, busy, onSelect, onDelete }) {
  const automation = item.kind === "automation";
  const title = item.title || "目标文本暂不可用";
  const status = automation ? automationRuleLabel(item.state) : runStatusLabel(item.projection?.status || item.status);
  return <article className={`group-history-card is-${automation ? "neutral" : statusTone(item.projection?.status || item.status)}${item.key === selectedKey ? " is-selected" : ""}`}>
    <button type="button" className="group-history-select" aria-pressed={item.key === selectedKey} disabled={!automation && busy && item.key !== selectedKey} onClick={() => onSelect(item)}><i aria-hidden="true" /><strong title={title}>{title}</strong>
      <span>{automation ? `定时规则 · ${status} · 已运行 ${item.runCount ?? "—"} 次` : `${item.kind === "employee" ? `单员工 · ${item.employeeName || "数字员工"}` : "自动安排"} · ${status}`}{!automation && (item.goalRevision || item.planning?.goal?.revision) ? ` · 第 ${item.goalRevision || item.planning.goal.revision} 轮` : ""}{item.projection ? ` · ${item.projection.steps.filter(step => step.status === "completed").length}/${item.projection.steps.length}` : ""}</span>
      {automation ? <span>最近执行：{item.latestTaskStatus ? runStatusLabel(item.latestTaskStatus) : "待同步"} · 查看运行记录</span> : null}
    </button>
    <small className="group-history-time">{cockpitRecordTimeLabel(automation ? { kind: "task", item: item.latestTaskTime } : { kind: "goal", item })}</small>
    {item.kind === "group" ? <button type="button" className="group-history-delete" aria-label={`删除${title}`} title="删除历史" disabled={busy} onClick={() => onDelete?.(item)}><TrashSimple size={13} weight="bold" /></button> : null}
  </article>;
}

export function WorkHistoryGroup({ item, runDetails = {}, ensureRuns, selectedKey, ...cardProps }) {
  const [open, setOpen] = useState(false);
  const identity = item.rules.map(automationRunFingerprint).join("|");
  useEffect(() => {
    if (open) item.rules.forEach(rule => { void ensureRuns?.(rule.automationId); });
  }, [open, identity]);
  const failed = item.rules.some(rule => runDetails[rule.automationId]?.phase === "error");
  const pending = item.rules.some(rule => !runDetails[rule.automationId] || runDetails[rule.automationId].phase === "loading");
  const selected = item.children.some(child => child.key === selectedKey);
  return <section className={`group-history-cluster${open ? " is-open" : ""}${selected ? " is-selected" : ""}`} aria-label={`${item.source.title}运行记录`}>
    <button type="button" className="group-history-cluster-toggle" aria-expanded={open} onClick={() => setOpen(value => !value)}>
      {open ? <CaretDown size={13} aria-hidden="true" /> : <CaretRight size={13} aria-hidden="true" />}
      <strong>{item.source.title}</strong><span>运行记录 · {item.children.length} 条已加载</span>
    </button>
    {open ? <div className="group-history-cluster-runs">
      {pending && !failed ? <p role="status">正在读取关联记录…</p> : null}
      {failed ? <p role="status">部分关联暂不可用，原记录仍保留。<button type="button" onClick={() => item.rules.forEach(rule => { void ensureRuns?.(rule.automationId, { retry: true }); })}>重试</button></p> : null}
      <small>仅聚合已加载且明确关联的记录；最多读取最近100次运行。</small>
      {item.children.map(child => <GroupHistoryCard key={child.key} item={child} selectedKey={selectedKey} {...cardProps} />)}
    </div> : null}
  </section>;
}

export function GroupRunHistory({ items, automations = [], runDetails = {}, ensureRuns, selectedKey, onSelect, onRefresh, onDelete, error, loading, busy }) {
  const [clock, setClock] = useState(Date.now());
  const [expanded, setExpanded] = useState(false);
  useEffect(() => {
    if (!busy) return undefined;
    const timer = setInterval(() => setClock(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [busy]);
  const selected = items.find(item => item.key === selectedKey);
  const rows = groupWorkbenchHistory(items, automations, runDetails);
  return <section className="group-run-history" aria-label="任务历史">
    <header><strong>任务 <small>{items.length}</small></strong><span>最近50条</span><button type="button" className="group-history-toggle" onClick={() => setExpanded(value => !value)}>{expanded ? "收起" : "展开"}</button><button type="button" onClick={onRefresh} disabled={loading}>{loading ? "同步中…" : "刷新"}</button></header>
    {error ? <p role="alert">历史同步失败，当前记录可能不是最新状态。{error}</p> : null}
    {expanded ? <div className="group-run-history-list is-expanded">{rows.map(item => item.kind === "work-history"
      ? <WorkHistoryGroup key={item.key} item={item} runDetails={runDetails} ensureRuns={ensureRuns} selectedKey={selectedKey} busy={busy} onSelect={onSelect} onDelete={onDelete} />
      : <GroupHistoryCard key={item.key} item={item} selectedKey={selectedKey} busy={busy} onSelect={onSelect} onDelete={onDelete} />)}</div> : null}
    {expanded && !items.length ? <p>发送任务后，单员工任务和自动安排记录会显示在这里。</p> : null}
    {expanded && selected ? <div className="group-run-current" role="status" aria-live="polite"><strong>{runStatusLabel(selected.projection?.status || selected.status)}</strong>
      {selected.status === "planning" ? <span>正在等待规划结果 · 已等待 {Math.max(0, Math.floor((clock - selected.startedAt) / 1000))} 秒。草案生成前不会启动执行。</span> : null}
      {selected.status === "draft" ? <span>请查看上方分工草案，采纳后开始执行。</span> : null}
      {selected.error ? <span>{selected.error}</span> : null}
      {selected.projection ? <div className="group-run-step-list">{selected.projection.steps.map(step => <span key={step.stepId}>{step.stepId} · {runStatusLabel(step.status)}{step.errorCode ? ` · ${step.errorCode}` : ""}</span>)}</div> : null}
    </div> : null}
  </section>;
}
