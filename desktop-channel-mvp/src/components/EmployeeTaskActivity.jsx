import { useEffect, useState } from "react";
import { DesktopTaskTimeline } from "./conversation/DesktopTaskTimeline.jsx";
import { MarkdownMessage } from "./MarkdownMessage.jsx";
import { runStatusLabel } from "../lib/groupRunHistory.js";
import { cockpitRecordTimeLabel } from "../lib/cockpitProgressPresentation.js";

export function EmployeeTaskActivity({ employeeId, taskId, taskIds = null, taskSetTitle, taskSetLoadState, onRetryTaskSet, onExitTaskSet, myTasks, onSelect, onOpenChat, onOpenLink }) {
  const [collapsedTaskId, setCollapsedTaskId] = useState("");
  const tasks = (myTasks?.page?.tasks || []).filter(task => task.employeeId === employeeId && (!taskIds || taskIds.includes(task.id)) &&
    ["desktop-device-channel", "personal-automation"].includes(task.sourceSystemId) && ["digital_employee_chat", "desktop_material_chat"].includes(task.taskType));
  const task = taskId ? tasks.find(item => item.id === taskId) : tasks[0];
  const state = task ? myTasks?.details?.[task.id] : null;
  useEffect(() => {
    if (task) void myTasks?.loadDetail?.(task);
  }, [task?.id, task?.revision, myTasks?.loadDetail]);
  const detail = state?.detail;
  const latest = detail?.activitySnapshot?.activities.at(-1);
  return <section className="group-entry-panel employee-task-activity" aria-label="员工活动记录">
    <div className="group-entry-heading"><div><span>{taskIds ? "任务集" : "活动"}</span><strong>{taskSetTitle || task?.employeeName || "数字员工"}</strong></div>{taskIds ? <button type="button" onClick={onExitTaskSet}>返回全部活动</button> : <button type="button" onClick={onOpenChat}>查看员工对话</button>}</div>
    {taskIds && taskSetLoadState === "loading" ? <p role="status">正在同步关联记录…</p> : null}
    {taskIds && taskSetLoadState === "error" ? <p role="status">部分关联记录暂不可用。<button type="button" onClick={onRetryTaskSet}>重试</button></p> : null}
    {myTasks?.error ? <p role="alert">任务历史同步失败，请刷新后重试。</p> : null}
    <div className="group-activity-groups">{tasks.map(item => <section className="group-activity-group" key={item.id}>
      <header><button type="button" aria-pressed={item.id === task?.id} aria-expanded={item.id === task?.id && collapsedTaskId !== item.id} onClick={() => {
        if (item.id === task?.id) setCollapsedTaskId(current => current === item.id ? "" : item.id);
        else { setCollapsedTaskId(""); onSelect(item.id); }
      }}><strong>{item.taskTitle || "员工任务"}</strong></button><span>{runStatusLabel(item.status)}</span><p>{cockpitRecordTimeLabel({ kind: "task", item })}</p></header>
      {item.id === task?.id && collapsedTaskId !== item.id ? <div className="employee-task-detail">
        {state?.phase === "loading" ? <p role="status">正在读取执行记录…</p> : null}
        {state?.error ? <p role="alert">{state.error}</p> : null}
        {state?.stale ? <p role="status">当前明细尚未同步到最新状态。</p> : null}
        <button type="button" disabled={state?.phase === "loading"} onClick={() => myTasks.loadDetail(item)}>刷新明细</button>
        {latest ? <p className="group-activity-latest">{latest.displayName} · {latest.operationCode || latest.actionCode}</p> : null}
        {detail?.events?.length ? <DesktopTaskTimeline key={item.id} initiallyExpanded events={detail.events} activitySnapshot={detail.activitySnapshot} provenanceSnapshot={detail.provenanceSnapshot} /> : state?.phase === "ready" ? <p>暂无执行事件记录。</p> : null}
        {state?.phase === "ready" && !detail?.activitySnapshot?.activities.length ? <p>该任务暂无可恢复的接口调用明细。</p> : null}
        {detail?.result?.text ? <div className="employee-task-result"><MarkdownMessage content={detail.result.text} onOpenLink={onOpenLink} /></div> : null}
      </div> : null}
    </section>)}</div>
    {taskId && !task && tasks.length ? <p>所选任务当前不可见，请刷新历史后重试。</p> : null}
    {!tasks.length ? <p>{myTasks?.busy ? "正在同步任务记录…" : "该员工暂无任务记录。"}</p> : null}
  </section>;
}
