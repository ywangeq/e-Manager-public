import { useEffect, useMemo, useRef, useState } from "react";
import {
  CaretRight,
  CheckCircle,
  Clock,
  SpinnerGap,
  Stack,
  ShieldCheck,
  Stop,
  WarningCircle,
  Wrench,
} from "@phosphor-icons/react";
import { desktopTaskActivityStatusLabel, desktopTaskActivitySummary, normalizeDesktopTaskActivitySnapshot } from "../../../shared/desktop-task-activity.mjs";
import {
  desktopProvenanceExecutionStatusLabel,
  desktopSkillExecutionModeLabel,
  desktopTaskProvenanceSummary,
  normalizeDesktopTaskProvenance,
} from "../../../shared/desktop-task-provenance.mjs";
import {
  desktopTaskEventPresentation,
  desktopTaskTimelineItems,
  desktopTaskTimelineView,
} from "../../../shared/desktop-task-timeline.mjs";

export function DesktopTaskTimeline({ initiallyExpanded = null, activitySnapshot = null, canceling = false, connectionState = "", events = [], provenanceSnapshot = null, onCancel }) {
  const now = useTaskClock(events);
  const view = useMemo(
    () => desktopTaskTimelineView(events, { connectionState, now }),
    [connectionState, events, now],
  );
  const items = useMemo(() => desktopTaskTimelineItems(view.events), [view.events]);
  const safeActivitySnapshot = useMemo(() => normalizeDesktopTaskActivitySnapshot(activitySnapshot), [activitySnapshot]);
  const safeProvenanceSnapshot = useMemo(() => normalizeDesktopTaskProvenance(provenanceSnapshot), [provenanceSnapshot]);
  const [expanded, setExpanded] = useState(() => initiallyExpanded ?? !view.terminal);
  const wasTerminalRef = useRef(view.terminal);
  useEffect(() => {
    if (!wasTerminalRef.current && view.terminal) setExpanded(false);
    wasTerminalRef.current = view.terminal;
  }, [view.terminal]);
  const cancelable = !view.terminal && typeof onCancel === "function";
  return (
    <div className="desktop-task-timeline-wrap">
      <details className={`desktop-task-timeline is-${view.tone} ${view.terminal ? "is-terminal" : "is-active"}`} open={expanded} onToggle={(event) => setExpanded(event.currentTarget.open)}>
      <summary>
        <span className="desktop-task-status-icon" aria-hidden="true">
          {view.terminal ? <TerminalStatusIcon status={view.status} /> : <SpinnerGap className="spin" size={14} />}
        </span>
        <span className="desktop-task-summary-copy">
          <strong>{view.terminal ? `已处理 ${formatDuration(view.durationMs)}` : view.statusLabel}</strong>
          <small>{view.terminal
            ? `${view.statusLabel} · ${view.events.length} 条记录`
            : <><Clock size={11} />已持续 {formatDuration(view.durationMs)} · {view.phaseLabel}</>}</small>
        </span>
        {cancelable ? (
          <button type="button" className="desktop-task-cancel" title={canceling ? "正在停止" : "停止任务"} aria-label={canceling ? "正在停止任务" : "停止运行中任务"} disabled={canceling} onClick={(event) => {
            event.preventDefault();
            event.stopPropagation();
            onCancel();
          }}>
            {canceling ? <SpinnerGap className="spin" size={13} /> : <Stop size={13} weight="fill" />}
          </button>
        ) : null}
        <CaretRight className="desktop-task-caret" size={13} aria-hidden="true" />
      </summary>
      {connectionState === "reconnecting" ? (
        <div className="desktop-task-connection" role="status"><SpinnerGap className="spin" size={12} />{view.connectionLabel}</div>
      ) : null}
      {safeProvenanceSnapshot ? <TaskProvenanceGroup snapshot={safeProvenanceSnapshot} /> : null}
      {safeActivitySnapshot?.activities.length ? <TaskActivityGroup snapshot={safeActivitySnapshot} /> : null}
      <details className="desktop-task-audit" open={!safeActivitySnapshot?.activities.length}>
        <summary><Stack size={13} /><span>任务状态与审计</span><small>{view.events.length} 条</small><CaretRight className="desktop-task-event-caret" size={12} /></summary>
        <div className="desktop-task-event-list" aria-label="canonical 任务事件时间线">
          {items.map((item) => item.kind === "progress_batch"
            ? <TaskProgressBatch item={item} key={item.key} />
            : <TaskEventRow event={item.event} key={`${item.event.taskId}:${item.event.seq}`} />)}
        </div>
      </details>
      </details>
    </div>
  );
}

function TaskProvenanceGroup({ snapshot }) {
  const callableById = new Map(snapshot.callableSkills.map((skill) => [skill.subjectId, skill]));
  return (
    <details className="desktop-task-provenance-group">
      <summary>
        <ShieldCheck size={13} />
        <strong>{desktopTaskProvenanceSummary(snapshot)}</strong>
        <CaretRight className="desktop-task-event-caret" size={12} />
      </summary>
      <div className="desktop-task-provenance-list" aria-label="canonical 安全职业设定与 Skill 来源">
        <div className="desktop-task-provenance-row is-applied">
          <span className="desktop-task-provenance-fact">已应用</span>
          <span className="desktop-task-event-copy">
            <strong>{snapshot.employeeProfile.displayName}</strong>
            <small>员工版本 {snapshot.employeeProfile.sourceVersion} · Prompt {snapshot.employeeProfile.promptVersion}</small>
          </span>
        </div>
        {snapshot.callableSkills.map((skill) => (
          <div className="desktop-task-provenance-row is-callable" key={`callable:${skill.subjectId}`}>
            <span className="desktop-task-provenance-fact">可调用</span>
            <span className="desktop-task-event-copy">
              <strong>{skill.displayName}</strong>
              <small>{desktopSkillExecutionModeLabel(skill.executionMode)} · {skill.sourceVersion}</small>
            </span>
          </div>
        ))}
        {snapshot.executedSkills.map((skill) => (
          <div className={`desktop-task-provenance-row is-executed is-${skill.status}`} key={skill.activityId}>
            <span className="desktop-task-provenance-fact">实际执行</span>
            <span className="desktop-task-event-copy">
              <strong>{callableById.get(skill.subjectId)?.displayName}<span>#{skill.sequence} {desktopProvenanceExecutionStatusLabel(skill.status)}</span></strong>
              <small>{skill.sourceVersion}</small>
            </span>
          </div>
        ))}
      </div>
    </details>
  );
}

function TaskActivityGroup({ snapshot }) {
  return (
    <details className="desktop-task-activity-group">
      <summary>
        <Wrench size={13} />
        <strong>{desktopTaskActivitySummary(snapshot)}</strong>
        <CaretRight className="desktop-task-event-caret" size={12} />
      </summary>
      <div className="desktop-task-activity-list" aria-label="canonical 安全活动调用明细">
        {snapshot.activities.map((activity) => (
          <div className={`desktop-task-activity-row is-${activity.status}`} key={activity.activityId}>
            <EventStatusIcon status={activity.status} />
            <span className="desktop-task-event-copy">
              <strong><em>#{activity.sequence}</em>{activity.displayName}<span>{desktopTaskActivityStatusLabel(activity.status)}</span></strong>
              <small>{activity.kind === "skill" ? "Skill" : "Tool"} · {activity.subjectId}</small>
              <small className="desktop-task-activity-code">{activity.actionCode}{activity.operationCode ? ` · ${activity.operationCode}` : ""}</small>
            </span>
          </div>
        ))}
      </div>
    </details>
  );
}

function TaskProgressBatch({ item }) {
  return (
    <details className="desktop-task-event-batch">
      <summary>
        <Stack size={13} aria-hidden="true" />
        <span className="desktop-task-event-copy">
          <strong>{item.label}</strong>
          <small>#{item.seqStart}–#{item.seqEnd} · 展开核验完整顺序</small>
        </span>
        <CaretRight className="desktop-task-event-caret" size={12} aria-hidden="true" />
      </summary>
      <div className="desktop-task-event-batch-list">
        {item.events.map((event) => <TaskEventRow event={event} key={`${event.taskId}:${event.seq}`} />)}
      </div>
    </details>
  );
}

function TaskEventRow({ event }) {
  const presentation = desktopTaskEventPresentation(event);
  const foldable = ["skill", "tool"].includes(presentation.kind);
  const row = (
    <>
      <EventStatusIcon status={presentation.status} />
      <span className="desktop-task-event-copy is-inline">
        <small>#{event.seq}</small>
        <strong>{presentation.label}</strong>
      </span>
      {foldable ? <CaretRight className="desktop-task-event-caret" size={12} aria-hidden="true" /> : null}
    </>
  );
  if (foldable) {
    return (
      <details className={`desktop-task-event is-${presentation.status} is-foldable`}>
        <summary>{row}</summary>
        <p>仅展示后端登记的安全活动摘要；参数、结果、Prompt 与命令输出不进入时间线。</p>
      </details>
    );
  }
  return (
    <div className={`desktop-task-event is-${presentation.status}`}>
      {row}
    </div>
  );
}

function TerminalStatusIcon({ status }) {
  return status === "completed"
    ? <CheckCircle size={14} weight="fill" />
    : <WarningCircle size={14} weight="fill" />;
}

function EventStatusIcon({ status }) {
  if (["running", "queued", "waiting"].includes(status)) return <SpinnerGap className="spin" size={13} />;
  if (["blocked", "canceled", "failed", "lost", "rejected", "target_rejected", "timed_out"].includes(status)) return <WarningCircle size={13} weight="fill" />;
  if (status === "completed") return <CheckCircle size={13} />;
  return <Wrench size={13} />;
}

function useTaskClock(events) {
  const [now, setNow] = useState(() => Date.now());
  const terminal = desktopTaskTimelineView(events, { now }).terminal;
  useEffect(() => {
    if (terminal) return undefined;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [terminal]);
  return now;
}

function formatDuration(milliseconds) {
  const seconds = Math.max(0, Math.floor(Number(milliseconds || 0) / 1000));
  if (seconds < 60) return `${seconds} 秒`;
  const minutes = Math.floor(seconds / 60);
  const remainder = seconds % 60;
  return remainder ? `${minutes} 分 ${remainder} 秒` : `${minutes} 分`;
}
