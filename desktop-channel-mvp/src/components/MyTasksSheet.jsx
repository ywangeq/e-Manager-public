import { PersonalAutomationsPanel } from "./PersonalAutomationsPanel.jsx";
import { ArtifactDeliveryEntry } from "./ArtifactDeliveryEntry.jsx";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowClockwise,
  CaretDown,
  CaretRight,
  CaretUp,
  CheckCircle,
  DownloadSimple,
  DotsSixVertical,
  HourglassMedium,
  SpinnerGap,
  Stop,
  WarningCircle,
  X,
} from "@phosphor-icons/react";
import { desktopTaskEventPresentation } from "../../shared/desktop-task-timeline.mjs";
import { isDesktopMyTaskActiveStatus, isDesktopMyTaskCancelableStatus } from "../../shared/desktop-my-tasks.mjs";
import { TaskFeedbackActions } from "./TaskFeedbackActions.jsx";
import { cockpitTaskTitle } from "../lib/personalCockpitModel.js";
import { cockpitRecordTimeLabel } from "../lib/cockpitProgressPresentation.js";
import "./my-tasks-sheet.css";

const FILTERS = [
  { id: "active", label: "进行中" },
  { id: "queued", label: "待执行" },
  { id: "recent", label: "最近" },
  { id: "automations", label: "定时" },
];
export function MyTasksSheet({
  automationSelection = null,
  initialFilter = "active",
  initialTaskId = "",
  busy,
  cancelingTaskIds,
  details,
  error,
  expandedTaskId,
  feedbackStates,
  onCancel,
  onClose,
  onDeliverArtifact,
  onInspectArtifact,
  onFeedback,
  onRefresh,
  onReorder,
  onToggleTask,
  page,
}) {
  const [filter, setFilter] = useState(automationSelection ? "automations" : initialFilter);
  const [employeeId, setEmployeeId] = useState(automationSelection?.employeeId || "all");
  const [dragging, setDragging] = useState(null);
  const [focusedTaskId, setFocusedTaskId] = useState(initialTaskId);
  const targetRowRef = useRef(null);
  const tasksById = useMemo(() => new Map((page?.tasks || []).map((task) => [task.id, task])), [page]);
  const queues = useMemo(() => (page?.queues || []).filter((queue) =>
    employeeId === "all" || queue.employee.id === employeeId
  ), [employeeId, page]);
  const recent = useMemo(() => (page?.tasks || []).filter((task) =>
    !isDesktopMyTaskCancelableStatus(task.status) &&
    (employeeId === "all" || task.employeeId === employeeId)
  ).slice(0, 20), [employeeId, page]);

  useEffect(() => {
    if (!focusedTaskId || filter === "automations") return;
    const task = tasksById.get(focusedTaskId);
    if (!task) return;
    if (employeeId !== "all" && employeeId !== task.employeeId) { setEmployeeId("all"); return; }
    const desiredFilter = task.status === "queued" ? "queued" : isDesktopMyTaskActiveStatus(task.status) ? "active" : "recent";
    if (filter !== desiredFilter) { setFilter(desiredFilter); return; }
    if (filter === "recent" && !recent.some((item) => item.id === task.id)) return;
    if (expandedTaskId !== task.id && filter !== "queued") onToggleTask?.(task);
    setFocusedTaskId("");
  }, [employeeId, expandedTaskId, filter, focusedTaskId, onToggleTask, recent, tasksById]);

  useEffect(() => {
    if (!initialTaskId || filter === "automations" ||
      !page?.tasks?.some((task) => task.id === initialTaskId) || !targetRowRef.current) return;
    const frame = window.requestAnimationFrame(() => {
      targetRowRef.current?.scrollIntoView({ block: "center" });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [employeeId, filter, initialTaskId, page]);

  useEffect(() => {
    function handleKeyDown(event) {
      if (event.key === "Escape") onClose();
    }
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [onClose]);

  function move(queue, taskId, direction) {
    const from = queue.queuedTaskIds.indexOf(taskId);
    const to = from + direction;
    if (from < 0 || to < 0 || to >= queue.queuedTaskIds.length) return;
    const next = [...queue.queuedTaskIds];
    [next[from], next[to]] = [next[to], next[from]];
    onReorder(queue, next);
  }

  function drop(queue, targetTaskId) {
    if (!dragging || dragging.employeeId !== queue.employee.id || dragging.taskId === targetTaskId) return;
    const next = [...queue.queuedTaskIds];
    const from = next.indexOf(dragging.taskId);
    const to = next.indexOf(targetTaskId);
    if (from < 0 || to < 0) return;
    next.splice(to, 0, next.splice(from, 1)[0]);
    setDragging(null);
    onReorder(queue, next);
  }

  return (
    <div className="my-tasks-layer" role="presentation" onMouseDown={(event) => {
      if (event.target === event.currentTarget) onClose();
    }}>
      <section className="my-tasks-sheet" role="dialog" aria-modal="true" aria-label="我的任务">
        <header className="my-tasks-header">
          <div><span>任务执行顺序</span><strong>我的任务</strong></div>
          <div className="my-tasks-header-actions">
            <button type="button" className="icon-button" title="刷新任务" aria-label="刷新任务" disabled={busy} onClick={onRefresh}>
              {busy ? <SpinnerGap size={17} className="spin" /> : <ArrowClockwise size={17} />}
            </button>
            <button type="button" className="icon-button" title="关闭" aria-label="关闭我的任务" onClick={onClose}><X size={17} /></button>
          </div>
        </header>

        <div className="my-tasks-controls">
          <div className="my-tasks-tabs" role="tablist" aria-label="筛选任务状态">
            {FILTERS.map((item) => <button key={item.id} type="button" role="tab" aria-selected={filter === item.id} className={filter === item.id ? "is-active" : ""} onClick={() => setFilter(item.id)}>{item.label}</button>)}
          </div>
          <select aria-label="筛选数字员工" value={employeeId} onChange={(event) => setEmployeeId(event.target.value)}>
            <option value="all">全部员工</option>
            {(page?.queues || []).map((queue) => <option key={queue.employee.id} value={queue.employee.id}>{queue.employee.name}</option>)}
          </select>
        </div>

        {error ? <div className="my-tasks-error" role="status">{error}</div> : null}
        <div className="my-tasks-content" aria-live="polite">
          {filter === "automations" ? <PersonalAutomationsPanel selectedAutomationId={automationSelection?.automationId} employeeId={employeeId} tasks={page?.tasks || []} renderTaskDetail={(task,state) => <TaskDetails task={task} state={state} onDeliverArtifact={onDeliverArtifact} onInspectArtifact={onInspectArtifact} />} /> : null}
          {filter !== "recent" && filter !== "automations" ? queues.map((queue) => {
            const running = queue.runningTaskIds.map((id) => tasksById.get(id)).filter(Boolean);
            const queued = queue.queuedTaskIds.map((id) => tasksById.get(id)).filter(Boolean);
            const showRunning = filter === "active";
            return (
              <section className="my-task-lane" key={queue.employee.id} aria-label={`${queue.employee.name}任务队列`}>
                <header><strong>{queue.employee.name}</strong><span>{running.length ? `${running.length} 执行中` : "当前空闲"} · {queued.length} 排队</span></header>
                {showRunning && running.map((task) => <TaskRow
                  key={task.id}
                  task={task}
                  kind="running"
                  targeted={initialTaskId === task.id}
                  targetRowRef={initialTaskId === task.id ? targetRowRef : null}
                  busy={busy}
                  canceling={cancelingTaskIds?.has(task.id)}
                  detailState={details?.[task.id]}
                  feedbackState={feedbackStates?.[task.id]}
                  expanded={expandedTaskId === task.id}
                  onCancel={onCancel}
                  onDeliverArtifact={onDeliverArtifact}
                  onInspectArtifact={onInspectArtifact}
                  onFeedback={onFeedback}
                  onToggle={() => onToggleTask?.(task)}
                />)}
                {queued.map((task, index) => <TaskRow
                  key={task.id}
                  task={task}
                  kind="queued"
                  targeted={initialTaskId === task.id}
                  targetRowRef={initialTaskId === task.id ? targetRowRef : null}
                  position={index + 1}
                  busy={busy}
                  canceling={cancelingTaskIds?.has(task.id)}
                  draggable={queue.reorderable}
                  onCancel={onCancel}
                  onDragStart={() => setDragging({ employeeId: queue.employee.id, taskId: task.id })}
                  onDrop={() => drop(queue, task.id)}
                  onMoveUp={() => move(queue, task.id, -1)}
                  onMoveDown={() => move(queue, task.id, 1)}
                  canMoveUp={queue.reorderable && index > 0}
                  canMoveDown={queue.reorderable && index < queued.length - 1}
                />)}
                {!running.length && !queued.length ? <div className="my-task-empty">暂无进行中的任务</div> : null}
                {!queue.reorderable && queued.length > 1 ? <div className="my-task-note">队列正在刷新，暂不可调整顺序</div> : null}
              </section>
            );
          }) : filter === "recent" ? recent.map((task) => <TaskRow
            key={task.id}
            task={task}
            kind="recent"
            targeted={initialTaskId === task.id}
            targetRowRef={initialTaskId === task.id ? targetRowRef : null}
            busy={busy}
            canceling={cancelingTaskIds?.has(task.id)}
            detailState={details?.[task.id]}
            feedbackState={feedbackStates?.[task.id]}
            expanded={expandedTaskId === task.id}
            onDeliverArtifact={onDeliverArtifact}
            onInspectArtifact={onInspectArtifact}
            onFeedback={onFeedback}
            onToggle={() => onToggleTask?.(task)}
          />) : null}
          {filter === "recent" && !recent.length ? <div className="my-task-empty is-page">暂无最近任务</div> : null}
          {filter !== "recent" && filter !== "automations" && !queues.length ? <div className="my-task-empty is-page">当前筛选下暂无任务</div> : null}
        </div>
      </section>
    </div>
  );
}

function TaskRow({
  busy,
  canMoveDown,
  canMoveUp,
  canceling,
  draggable,
  detailState,
  expanded,
  feedbackState,
  kind,
  onCancel,
  onDeliverArtifact,
  onDragStart,
  onDrop,
  onInspectArtifact,
  onFeedback,
  onMoveDown,
  onMoveUp,
  position,
  task,
  targeted,
  targetRowRef,
  onToggle,
}) {
  return (
    <article
      className={`my-task-row is-${kind}${targeted ? " is-target" : ""}`}
      ref={targetRowRef}
      draggable={draggable === true}
      onDragStart={onDragStart}
      onDragOver={(event) => draggable && event.preventDefault()}
      onDrop={onDrop}
    >
      {kind === "queued" ? <span className="my-task-drag" title="拖动调整顺序"><DotsSixVertical size={17} /></span> : <span className="my-task-state-icon">{kind === "running" ? <SpinnerGap size={16} className="spin" /> : <HourglassMedium size={16} />}</span>}
      <div className="my-task-copy">
        <strong title={cockpitTaskTitle(task)}>{cockpitTaskTitle(task)}</strong>
        <span>{kind === "queued" ? `排队中 · 第 ${position} 位` : task.statusLabel}</span>
        <span>{task.nextGate || "等待 Center 更新安全状态"}</span>
        <small>{cockpitRecordTimeLabel({ kind: "task", item: task })}</small>
      </div>
      <div className="my-task-actions">
        {kind === "queued" ? <>
          <button type="button" title="上移" aria-label={`将第 ${position} 个任务上移`} disabled={busy || !canMoveUp} onClick={onMoveUp}><CaretUp size={14} /></button>
          <button type="button" title="下移" aria-label={`将第 ${position} 个任务下移`} disabled={busy || !canMoveDown} onClick={onMoveDown}><CaretDown size={14} /></button>
        </> : null}
        {kind !== "queued" ? <button type="button" title={expanded ? "收起详情" : "查看详情"} aria-label={expanded ? "收起任务详情" : "查看任务详情"} onClick={onToggle}>
          {expanded ? <CaretDown size={14} /> : <CaretRight size={14} />}
        </button> : null}
        {onCancel && isDesktopMyTaskCancelableStatus(task.status) ? <button type="button" className="is-danger" title={canceling ? "正在停止" : kind === "queued" ? "移出队列" : "停止任务"} aria-label={canceling ? "正在停止任务" : kind === "queued" ? "移出待执行队列" : "停止运行中任务"} disabled={busy || canceling} onClick={() => onCancel(task)}>
          {canceling ? <SpinnerGap size={14} className="spin" /> : <Stop size={14} weight="fill" />}
        </button> : null}
      </div>
      {expanded ? <TaskDetails
        task={task}
        state={detailState}
        feedbackState={feedbackState}
        onDeliverArtifact={onDeliverArtifact}
        onFeedback={onFeedback}
        onInspectArtifact={onInspectArtifact}
      /> : null}
    </article>
  );
}

export function TaskDetails({ feedbackState, onDeliverArtifact, onFeedback, onInspectArtifact, state, task }) {
  if (!state || state.phase === "loading") return <div className="my-task-details is-loading"><SpinnerGap size={14} className="spin" />正在读取 Center 安全详情</div>;
  if (state.phase === "error") return <div className="my-task-details is-error">{state.error || "任务详情暂时不可用"}</div>;
  const detail = state.detail;
  if (!detail) return <div className="my-task-details is-loading">等待 canonical 任务详情</div>;
  const events = detail.events.slice(-6);
  return (
    <div className="my-task-details">
      <div className="my-task-detail-heading">
        <strong>任务时间线</strong>
        <span>已同步至 #{detail.lastSeq || 0}{state.connectionState ? ` · ${connectionLabel(state.connectionState)}` : ""}</span>
      </div>
      {detail.outputManifest ? <div className="my-task-output-summary">
        <DownloadSimple size={12} />
        <span>{detail.outputManifest.summaryLabel}</span>
      </div> : null}
      <ol className="my-task-timeline">
        {events.map((event) => {
          const presentation = desktopTaskEventPresentation(event);
          return <li key={event.seq}>
            {presentation.status === "completed" || presentation.status === "done" ? <CheckCircle size={12} /> : presentation.status === "running" ? <SpinnerGap size={12} className="spin" /> : <WarningCircle size={12} />}
            <span>{presentation.label}</span><small>#{event.seq}</small>
          </li>;
        })}
      </ol>
      {detail.result ? <section className="my-task-result">
        <div className="my-task-result-heading">
          <strong>安全结果</strong>
          {task?.status === "completed" && onFeedback ? <TaskFeedbackActions
            state={feedbackState}
            onFeedback={onFeedback}
            task={task}
          /> : null}
        </div>
        <p>{detail.result.text}</p>
      </section> : null}
      {detail.artifacts.map((reference) => <ArtifactDeliveryEntry
        key={reference.artifactId}
        gate={{ ...reference, ready: true }}
        onDeliverArtifact={onDeliverArtifact}
        onInspectArtifact={onInspectArtifact}
      />)}
    </div>
  );
}

function connectionLabel(value) {
  return ({ connected: "已同步", connecting: "同步中", reconnecting: "进度同步中" })[value] || "等待状态";
}
