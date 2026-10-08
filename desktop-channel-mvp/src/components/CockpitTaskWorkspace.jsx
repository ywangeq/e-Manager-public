import { useEffect, useMemo, useState } from "react";
import { ArrowRight, ArrowClockwise, X } from "@phosphor-icons/react";
import { TaskDetails } from "./MyTasksSheet.jsx";
import { PersonalAutomationsPanel } from "./PersonalAutomationsPanel.jsx";
import { cockpitWorkItems, cockpitFilterItems, cockpitTaskTitle } from "../lib/personalCockpitModel.js";
import { isDesktopMyTaskCancelableStatus } from "../../shared/desktop-my-tasks.mjs";
import { runStatusLabel } from "../lib/groupRunHistory.js";
import { cockpitStatusTone } from "../lib/cockpitStatusTone.js";
import { cockpitRecordTimeLabel } from "../lib/cockpitProgressPresentation.js";
import "./cockpit-task-workspace.css";

export function CockpitTaskWorkspace({ myTasks, sources, desktopApi, filter, onFilter, selectedTaskId, onSelectTask, selectedAutomation, onOpenGoal, onOpenAutomation }) {
  const [query, setQuery] = useState("");
  const items = useMemo(() => cockpitWorkItems({ tasks: myTasks.phase === "error" ? [] : myTasks.page.tasks, goals: sources.goalPhase === "ready" ? sources.goals : [], automations: sources.automationPhase === "ready" ? sources.automations : [] }), [myTasks.page, myTasks.phase, sources.goals, sources.goalPhase, sources.automations, sources.automationPhase]);
  const rows = cockpitFilterItems(items, filter, query);
  const selected = myTasks.phase !== "error" ? rows.find(row => row.kind === "task" && row.item.id === selectedTaskId)?.item : null;
  useEffect(() => {
    if (selected && myTasks.phase !== "error") void myTasks.loadDetail?.(selected);
  }, [selected?.id, selected?.revision, selected?.status, myTasks.phase, myTasks.loadDetail]);
  const queue = myTasks.page.queues?.find((item) => item.employee.id === selected?.employeeId);
  const position = queue?.queuedTaskIds.indexOf(selected?.id) ?? -1;
  function move(direction) {
    if (!queue?.reorderable || position < 0 || position + direction < 0 || position + direction >= queue.queuedTaskIds.length) return;
    const ids = [...queue.queuedTaskIds];
    [ids[position], ids[position + direction]] = [ids[position + direction], ids[position]];
    void myTasks.reorder(queue, ids);
  }
  const renderDetail = (task, state) => <TaskDetails task={task} state={state} feedbackState={myTasks.feedbackStates?.[task.id]} onFeedback={myTasks.submitFeedback} onInspectArtifact={myTasks.inspectArtifact} onDeliverArtifact={myTasks.deliverArtifact} />;
  if (filter === "automations") return <section className="cockpit-workspace"><h2>我的定时任务</h2>{desktopApi ? <PersonalAutomationsPanel cockpitMode desktopApi={desktopApi} tasks={myTasks.page.tasks} selectedAutomationId={selectedAutomation?.automationId} renderTaskDetail={renderDetail} /> : <p className="cockpit-empty">浏览器预览未连接定时任务。请在已登录的桌面端查看运行记录、暂停或恢复。</p>}</section>;
  return <section className="cockpit-workspace">
    <div className="cockpit-work-filters">
      <div role="group" aria-label="任务状态">{[["all", "全部"], ["attention", "待我处理"], ["active", "执行中"], ["queued", "排队中"], ["recent", "最近结束"]].map(([id, label]) => <button type="button" aria-pressed={filter === id} key={id} onClick={() => onFilter(id)}>{label}</button>)}</div>
      <input aria-label="搜索任务或执行者" placeholder="搜索任务或执行者" value={query} onChange={(event) => setQuery(event.target.value)} />
    </div>
    <p className="cockpit-source-note">当前已加载的任务与目标；Group 内部步骤在目标详情查看。</p>
    {myTasks.phase === "error" || sources.goalPhase === "error" || sources.automationPhase === "error" ? <p role="status" className="cockpit-source-error">部分来源暂不可用，列表仅显示已成功读取的来源。</p> : null}
    <div className={`cockpit-work-layout${selected ? " has-detail" : ""}`}><div className="cockpit-work-list-pane"><div className="cockpit-work-list">{rows.map((row) => {
      const steps = row.item.projection?.steps || [];
      const progress = steps.length ? `${steps.filter((step) => step.status === "completed").length}/${steps.length} 步已完成` : "";
      return <button type="button" key={row.key} className={selectedTaskId === row.item.id && row.kind === "task" ? "is-selected" : ""} aria-expanded={row.kind === "task" ? selectedTaskId === row.item.id : undefined} onClick={() => row.kind === "goal" ? onOpenGoal(row.item.goalId) : row.kind === "automation" ? onOpenAutomation(row.item) : onSelectTask(selectedTaskId === row.item.id ? "" : row.item.id)}>
        <span><strong title={row.title}>{row.title}</strong><small>{row.kind === "goal" ? "Group 协作" : row.kind === "automation" ? "定时规则异常" : row.item.employeeName || "数字员工"}{progress ? ` · ${progress}` : ""}{row.kind !== "goal" && row.item.nextGate ? ` · ${row.item.nextGate}` : ""}</small><small>{cockpitRecordTimeLabel(row)}</small></span>
        <em data-tone={cockpitStatusTone(row.status)}>{row.status === "attention_required" ? "需要处理" : (row.kind === "task" ? row.item.statusLabel : null) || runStatusLabel(row.status)}</em><ArrowRight size={15} />
      </button>;
    })}</div>
    {!rows.length ? <p className="cockpit-empty">{myTasks.phase === "loading" || sources.goalPhase === "loading" ? "正在同步工作事项…" : "当前范围没有匹配的工作事项。"}</p> : null}
    </div>
    {selected && myTasks.phase !== "error" ? <section className="cockpit-work-detail" aria-label="任务详情">
      <header><div><small>{selected.employeeName || "数字员工"}</small><h2>{cockpitTaskTitle(selected)}</h2></div><button type="button" aria-label="收起任务详情" title="收起详情" onClick={() => onSelectTask("")}><X size={18} /></button></header>
      <div className="cockpit-detail-actions">
        <button type="button" disabled={myTasks.busy} onClick={() => void myTasks.loadDetail?.(selected)}><ArrowClockwise size={14} />刷新详情</button>
        {selected.status === "queued" ? <><button type="button" disabled={myTasks.busy || !queue?.reorderable || position <= 0} onClick={() => move(-1)}>上移</button><button type="button" disabled={myTasks.busy || !queue?.reorderable || position < 0 || position >= queue.queuedTaskIds.length - 1} onClick={() => move(1)}>下移</button></> : null}
        {isDesktopMyTaskCancelableStatus(selected.status) ? <button type="button" disabled={myTasks.busy || myTasks.cancelingTaskIds?.has(selected.id)} onClick={() => void myTasks.cancel(selected)}>{selected.status === "queued" ? "移出队列" : "停止任务"}</button> : null}
      </div>
      {myTasks.error ? <p role="alert">{myTasks.error}</p> : null}
      {renderDetail(selected, myTasks.details?.[selected.id])}
    </section> : null}</div>
  </section>;
}
