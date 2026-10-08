import { matchesWorkbenchAutomation } from "../lib/workbenchAutomationScope.js";
import { useEffect, useRef, useState } from "react";
import { ArrowClockwise, ArrowRight, Check, ClockCounterClockwise, Pause, Play, Stop } from "@phosphor-icons/react";

import { AutomationCalendar } from "./AutomationCalendar.jsx";

const STATES = {active:"已启用",paused:"已暂停",disabled:"已禁用",exhausted:"已结束",attention_required:"需要处理"};
export function PersonalAutomationsPanel({tasks = [], selectedAutomationId = "", employeeId = "all", renderTaskDetail, desktopApi = window.desktopChannel, cockpitMode = false, selectedOnly = false, workbenchScope = null}) {
  const [page,setPage] = useState({automations:[],notifications:[]});
  const [busy,setBusy] = useState(false), [error,setError] = useState(""), [detail,setDetail] = useState(null);
  const [taskView,setTaskView] = useState(null);
  const [loaded,setLoaded] = useState(false);
  const [view,setView] = useState("list");
  const [activeId,setActiveId] = useState(selectedAutomationId);
  const [refreshing,setRefreshing] = useState(false);
  const [now,setNow] = useState(Date.now);
  const refreshPending = useRef(false);
  const detailSequenceRef = useRef(0);
  const activeIdRef = useRef(activeId);
  activeIdRef.current = activeId;
  useEffect(() => setActiveId(selectedAutomationId), [selectedAutomationId]);
  const alive = useRef(true);
  const selectedRow = useRef(null);
  useEffect(() => { alive.current=true; refresh(); const timer=window.setInterval(() => {if(document.visibilityState === "visible") refresh();},60000); return () => {alive.current=false;window.clearInterval(timer);}; },[]);
  async function call(request) {
    const result = await desktopApi?.personalAutomations?.(request);
    if (!result?.ok) throw new Error(result?.status || "personal_automation_unavailable");
    return result;
  }
  async function loadDetail(id) {
    const sequence = ++detailSequenceRef.current;
    const value = await call({action:"detail",automationId:id});
    if (alive.current && activeIdRef.current === id && sequence === detailSequenceRef.current) setDetail(value);
  }
  async function refresh() { if (refreshPending.current) return; refreshPending.current=true;setRefreshing(true); try { const value = await call({action:"list"}); if (alive.current) {setPage(value);setError("");setLoaded(true);setNow(Date.now()); const id = activeIdRef.current; if (id) await loadDetail(id);} } catch { if (alive.current) {setLoaded(false);setPage({automations:[],notifications:[]});setDetail(null);setTaskView(null);setError("暂时无法读取个人定时任务，请重新登录或稍后刷新。");} } finally {refreshPending.current=false;if(alive.current)setRefreshing(false);} }
  async function act(fn) {
    setBusy(true);setError("");
    try { await fn(); if (alive.current) await refresh(); }
    catch (e) { if (alive.current) setError(e.message === "personal_automation_input_unavailable" ? "请选择当前账号的纯文本对话任务；原指令需仍可读取。" : "操作未完成。请刷新后重试；权限或原指令变化时请重新创建。"); }
    finally { if (alive.current) setBusy(false); }
  }
  useEffect(() => {
    let current = true;
    setDetail(null);
    setTaskView(null);
    if (activeId) loadDetail(activeId)
      .catch(() => {if (current) setError("暂时无法读取这项定时任务，请刷新。");});
    return () => {current = false; ++detailSequenceRef.current;};
  },[activeId]);
  useEffect(() => {
    if (activeId && page.automations.some(a => a.automationId === activeId)) {
      selectedRow.current?.scrollIntoView({block:"nearest"});
    }
  },[loaded,activeId]);
  const scopedRules = page.automations.filter(a => (employeeId === "all" || a.employeeId === employeeId) && matchesWorkbenchAutomation(a, workbenchScope));
  const scopedIds = new Set(scopedRules.map(a => a.automationId));
  const ruleSource = a => tasks.find(t => t.id === a.sourceTaskId && t.employeeId === a.employeeId);
  const scopedDetail = detail && scopedIds.has(detail.automation.automationId) ? detail : null;
  return <section aria-label="个人定时任务" className={`personal-automations-panel${cockpitMode ? " is-cockpit" : ""}`}>
    {cockpitMode ? <p>暂停只阻止后续执行，不会终止已开始的任务。</p> : <p>在对话中告诉数字员工何时执行、执行什么以及何时结束。收起或隐藏时继续执行；退出或断连后停止新任务，重新连接后等待下一次，不补跑错过的任务。</p>}
    <div className="automation-panel-toolbar"><div className="automation-view-toggle" aria-label="定时任务视图">{(selectedOnly || workbenchScope ? [] : [["list","列表"],["week","周历"]]).map(([id,label]) => <button type="button" key={id} aria-pressed={view === id} onClick={() => {setView(id);setNow(Date.now());}}>{label}</button>)}</div><button type="button" className={`automation-refresh${refreshing ? " is-refreshing" : ""}`} disabled={busy || refreshing} aria-label="刷新定时任务" title="刷新" onClick={refresh}><ArrowClockwise size={17} aria-hidden="true" /></button></div>
    {!workbenchScope && view === "week" && loaded ? <AutomationCalendar automations={scopedRules} tasks={tasks} now={now} selectedId={activeId} onSelect={setActiveId} onShowHistory={() => setView("list")} /> : null}
    {error && <p role="alert">{error}</p>}
    {!loaded && !error && <p role="status">正在读取个人定时任务…</p>}
    {loaded && !error && scopedRules.length === 0 && <p>{workbenchScope ? workbenchScope.taskIds.length ? "暂未找到与当前任务明确关联的定时规则。" : "请先选择工作台任务，再查看它的定时任务。" : "还没有个人定时任务。"}</p>}
    {workbenchScope && loaded && !error ? <div className="automation-member-summary" aria-label="当前任务定时规则数量">{[...new Set(scopedRules.map(rule => rule.employeeId))].map(id => <span key={id}>{workbenchScope.employeeNames?.[id] || tasks.find(t => t.employeeId === id)?.employeeName || "数字员工"} · {scopedRules.filter(a => a.employeeId === id && a.state === "active").length} 项已启用 / {scopedRules.filter(a => a.employeeId === id).length} 项规则</span>)}</div> : null}
    {scopedRules.filter(a => (!selectedOnly || a.automationId === activeId) && (view === "list" || a.automationId === activeId)).map((a, index) => <article key={a.automationId} ref={a.automationId === activeId ? selectedRow : null} className={`my-task-lane${a.automationId === activeId ? " is-selected-automation" : ""}`}>
      <header><strong>{workbenchScope?.employeeNames?.[a.employeeId] || tasks.find(t => t.employeeId === a.employeeId)?.employeeName || a.employeeId}</strong><span>{STATES[a.state] || "未知状态"}</span>{cockpitMode && <button type="button" role="switch" className="personal-automation-switch" aria-label={`${tasks.find(t => t.employeeId === a.employeeId)?.employeeName || "数字员工"} · 每 ${a.intervalSeconds % 3600 === 0 ? `${a.intervalSeconds/3600} 小时` : a.intervalSeconds % 60 === 0 ? `${a.intervalSeconds/60} 分钟` : `${a.intervalSeconds} 秒`} · 第 ${index + 1} 项定时任务`} aria-checked={a.state === "active"} disabled={busy || !["active","paused","attention_required"].includes(a.state)} onClick={() => act(() => call({action:"change",automationId:a.automationId,input:{action:a.state === "active" ? "pause" : "resume",expectedRevision:a.revision}}))}><span aria-hidden="true" /></button>}</header>
      {workbenchScope ? <p className="automation-source-task">来源任务：{ruleSource(a)?.taskTitle || "来源任务暂未加载"}{workbenchScope.taskIds.some(id => [a.sourceTaskId, a.lastTaskId].includes(id)) ? " · 关联当前任务" : ""}</p> : null}
      <p>每 {a.intervalSeconds % 3600 === 0 ? `${a.intervalSeconds/3600} 小时` : a.intervalSeconds % 60 === 0 ? `${a.intervalSeconds/60} 分钟` : `${a.intervalSeconds} 秒`} · 已运行 {a.runCount}/{a.maxRuns} 次 · 至 {new Date(a.expiresAt).toLocaleString()}</p>
      {a.reasonCode && <p>需要处理：{({input_unavailable:"原指令不可用",authorization_changed:"调用权限已变化",execution_unavailable:"任务暂时无法提交",limit_reached:"达到运行边界"})[a.reasonCode] || "请检查任务"}</p>}
      <div className="personal-automation-actions">
        <button type="button" className="personal-automation-action is-history" aria-expanded={activeId === a.automationId} disabled={busy} onClick={() => { setActiveId(current => current === a.automationId ? "" : a.automationId); }}><ClockCounterClockwise size={14} aria-hidden="true" />{activeId === a.automationId ? "收起记录" : "运行记录"}</button>
        {!["disabled","exhausted"].includes(a.state) && <>
          {!cockpitMode && <button type="button" className="personal-automation-action" disabled={busy} onClick={() => act(() => call({action:"change",automationId:a.automationId,input:{action:a.state === "active" ? "pause" : "resume",expectedRevision:a.revision}}))}>{a.state === "active" ? <Pause size={14} aria-hidden="true" /> : <Play size={14} aria-hidden="true" />}{a.state === "active" ? "暂停" : "恢复"}</button>}
          <button type="button" className="personal-automation-action is-danger" disabled={busy} onClick={() => act(() => call({action:"change",automationId:a.automationId,input:{action:"disable",expectedRevision:a.revision}}))}><Stop size={14} aria-hidden="true" />禁用</button>
        </>}
      </div>
    </article>)}
    {scopedDetail && <section aria-label="定时运行记录"><h3>实际运行记录 · {tasks.find(t => t.employeeId === detail.automation.employeeId)?.employeeName || detail.automation.employeeId}</h3>{detail.runs.map(run => <p key={run.taskId}><button type="button" className="personal-automation-action is-run" disabled={busy} onClick={() => act(async () => {
        const automationId = scopedDetail.automation.automationId;
        const sequence = detailSequenceRef.current;
        const task={id:run.taskId,employeeId:scopedDetail.automation.employeeId,status:run.status};
        const value=await desktopApi.getMyTaskDetail({taskId:task.id,employeeId:task.employeeId});
        if(!value?.ok) throw new Error();
        if(alive.current && activeIdRef.current === automationId && detailSequenceRef.current === sequence)setTaskView({automationId,task,state:{phase:"ready",detail:value.detail}});
      })}><ClockCounterClockwise size={14} aria-hidden="true" /><span>{new Date(run.scheduledFor).toLocaleString()} · {run.status}</span><span>查看任务</span><ArrowRight size={14} aria-hidden="true" /></button></p>)}</section>}
    {scopedDetail && taskView?.automationId === scopedDetail.automation.automationId && renderTaskDetail?.(taskView.task,taskView.state)}
    {page.notifications.filter(n => !n.readAt && scopedIds.has(n.automationId) && (!selectedOnly || n.automationId === activeId)).map(n => <p key={n.taskId} role="status">定时任务状态：{n.status} <button type="button" className="personal-automation-action" disabled={busy} onClick={() => act(() => call({action:"read",automationId:n.automationId,input:{taskId:n.taskId}}))}><Check size={14} aria-hidden="true" />已读</button></p>)}
  </section>;
}
