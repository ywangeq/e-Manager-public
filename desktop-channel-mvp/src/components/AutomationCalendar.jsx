import { useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { CaretLeft, CaretRight } from "@phosphor-icons/react";
import { automationSourceTask, automationTaskTitle, automationWeek, calendarWeek, automationRunSummary } from "../lib/automationCalendar.js";
import { readAutomationRunHistory } from "../lib/automationRunHistory.js";
import { localCalendarWeek } from "../lib/localCalendarWeek.js";
import { meetingWeek } from "../lib/calendarMeetings.js";
import { useCalendarMeetings } from "../hooks/useCalendarMeetings.js";
import { useCockpitMotion } from "../lib/useCockpitMotion.js";
import { AutomationSettingsDialog } from "./AutomationSettingsDialog.jsx";
import { LocalCalendarTask } from "./LocalCalendarTask.jsx";
import "./automation-calendar.css";

const clock = value => new Date(value).toLocaleTimeString([], {hour:"2-digit",minute:"2-digit",hour12:false});
const dateLabel = value => value.toLocaleDateString("zh-CN", {month:"numeric",day:"numeric"});
export function AutomationCalendar(props) {
  return props.desktopApi?.localCalendar ? <LocalCalendarTask desktopApi={props.desktopApi} revision={props.now} employeeId={props.employeeId}>
    {({rule,openSettings}) => <AutomationCalendarView {...props} localRule={rule} onLocalSettings={openSettings}/>}
  </LocalCalendarTask> : <AutomationCalendarView {...props}/>;
}

export function AutomationCalendarView({localRule = null, onLocalSettings, automations, tasks = [], selectedId, onSelect, now, desktopApi, employeeId = "all"}) {
  const calendar = useCalendarMeetings(desktopApi, now);
  const [offset,setOffset] = useState(0);
  const [tooltip,setTooltip] = useState(null);
  const [meetingRef,setMeetingRef] = useState(null);
  const [linkError,setLinkError] = useState("");
  const tooltipId = useId();
  const calendarRef = useRef(null);
  const [history,setHistory] = useState({key:"",phase:"loading",runs:{},failedIds:[]});
  const historyKey = JSON.stringify(automations.map(rule => [rule.automationId,rule.employeeId,rule.revision,rule.runCount]).sort());
  useEffect(() => {
    let current = true;
    setHistory({key:historyKey,phase:"loading",runs:{},failedIds:[]});
    if (desktopApi?.personalAutomations) {
      readAutomationRunHistory(automations, desktopApi, () => current).then(value => {
        if (current && value) setHistory({key:historyKey,phase:"ready",...value});
      });
    } else setHistory({key:historyKey,phase:"ready",runs:{},failedIds:automations.map(rule => rule.automationId)});
    return () => {current = false;};
  },[historyKey,desktopApi,now]);
  const visibleHistory = history.key === historyKey ? history : {phase:"loading",runs:{},failedIds:[]};
  function hideDetails() {
    setTooltip(null);
  }
  function showDetails(target, event, dayStart) {
    const rect = target.getBoundingClientRect();
    const width = Math.min(280, window.innerWidth - 16);
    setTooltip({event, dayStart, width, left: Math.max(8, Math.min(rect.left, window.innerWidth - width - 8)), top: rect.bottom + 8, above: rect.bottom + 220 > window.innerHeight});
  }
  useEffect(() => {
    const hide = () => setTooltip(null);
    window.addEventListener("resize", hide);
    window.addEventListener("scroll", hide, true);
    return () => { hide(); window.removeEventListener("resize", hide); window.removeEventListener("scroll", hide, true); };
  }, []);
  useCockpitMotion(calendarRef, offset, ".automation-week-grid");
  const days = localCalendarWeek(localRule, meetingWeek(calendar.snapshots, automationWeek(automations, calendarWeek(new Date(now),offset),now,visibleHistory.runs)),now).map(day => ({...day,events:[...day.events,...day.meetings,...day.localEvents].sort((a,b)=>a.first-b.first)}));
  const tooltipEvent = tooltip && days.find(day => day.start === tooltip.dayStart)?.events.find(event => eventKey(event) === eventKey(tooltip.event));
  const selectedMeeting = days.flatMap(day => day.meetings).find(event => event.eventRef === meetingRef);
  async function openMeetingLink(kind) {
    setLinkError("");
    try { if (!(await desktopApi?.calendarOpenLink?.({eventRef:selectedMeeting.eventRef,kind}))?.ok) throw new Error(); }
    catch { setLinkError("链接暂时无法打开，请稍后重试。"); }
  }
  return <section className="automation-calendar" ref={calendarRef} aria-label="个人周历">
    <header><strong>{dateLabel(days[0].date)} — {dateLabel(days[6].date)}</strong><div><button type="button" aria-label="上一周" title="上一周" onClick={() => {hideDetails();setOffset(n=>n-1);}}><CaretLeft size={16}/></button><button type="button" onClick={() => {hideDetails();setOffset(0);}}>本周</button><button type="button" aria-label="下一周" title="下一周" onClick={() => {hideDetails();setOffset(n=>n+1);}}><CaretRight size={16}/></button></div></header>
    <p className="automation-calendar-note" role="status">{calendar.snapshots?.length ? `更新于 ${clock(calendar.snapshots.at(-1).fetchedAt)}${calendar.cached ? " · 已保存" : ""}${calendar.phase === "stale" || calendar.phase === "unavailable" ? " · 等待更新" : ""}` : "日程尚未同步"}</p>
    {visibleHistory.phase === "loading" ? <p role="status">正在加载…</p> : null}
    {visibleHistory.failedIds.length > 0 ? <p role="alert">部分历史记录暂时无法读取，请刷新重试。</p> : null}
    {Object.values(visibleHistory.runs).some(runs => runs.length >= 100) ? <p className="automation-calendar-note">仅显示最近 100 次执行。</p> : null}
    <div className="automation-week-scroll"><div className="automation-week-grid">{days.map(day => <section key={day.start} className={day.start <= now && now < day.end ? "is-today" : ""}>
      <header><span>{day.date.toLocaleDateString("zh-CN",{weekday:"short"})}</span><strong>{day.date.getDate()}</strong>{day.start <= now && now < day.end ? <small>今天</small> : null}</header>
      {day.events.length ? <ul className="automation-day-list">{day.events.map(event => <li key={eventKey(event)}><button type="button" className={`automation-calendar-event${event.kind === "meeting" ? " is-meeting" : ` is-automation ${eventEnabled(event) ? "is-enabled" : "is-disabled"}${event.kind !== "local" && selectedId === event.rule.automationId ? " is-selected" : ""}`}`} aria-pressed={event.kind === "meeting" || event.kind === "local" ? undefined : event.kind !== "local" && selectedId === event.rule.automationId} aria-describedby={tooltip && eventKey(tooltip.event) === eventKey(event) && tooltip.dayStart === day.start ? tooltipId : undefined} onMouseEnter={e => showDetails(e.currentTarget,event,day.start)} onMouseLeave={hideDetails} onFocus={e => showDetails(e.currentTarget,event,day.start)} onBlur={hideDetails} onKeyDown={e => {if (e.key === "Escape") hideDetails();}} onClick={e => {if(event.kind === "meeting") {hideDetails();setLinkError("");setMeetingRef(event.eventRef);}else {hideDetails();if(event.kind === "local") onLocalSettings();else onSelect(event.rule.automationId);}}}>
        <time dateTime={new Date(event.first).toISOString()}>{event.kind === "local" && !event.localRule.enabled ? "已暂停" : event.kind === "meeting" ? event.allDay ? "全天" : `${clock(event.first)}—${clock(event.last)}` : <>{clock(event.first)}{event.count > 1 ? `—${clock(event.last)}` : ""}</>}</time>
        <strong><span aria-hidden="true">•</span><span>{event.kind === "meeting" ? event.title || "未命名会议" : event.kind === "local" ? event.localRule.employeeName : automationTaskTitle(event.rule, tasks)}</span></strong>
        <small>{event.kind === "meeting" ? "飞书会议" : event.kind === "local" ? `同步本周会议 · ${event.localRule.enabled ? `预计 ${event.count} 次` : "已关闭"}` : <>{<>{eventEnabled(event) ? "已开启" : "已关闭"} · {event.kind === "history" ? automationRunSummary(event.runs) : `预计 ${event.count} 次`}</>}{automationSourceTask(event.rule, tasks)?.employeeName ? ` · ${automationSourceTask(event.rule, tasks).employeeName}` : ""}</>}</small>
      </button></li>)}</ul> : null}
      {!day.events.length ? <p className="automation-day-empty">{day.end <= now ? visibleHistory.phase === "loading" ? "正在读取记录…" : visibleHistory.failedIds.length ? "记录暂不可用" : "暂无安排" : "暂无安排"}</p> : null}
    </section>)}</div></div>
    {tooltipEvent && createPortal(<div id={tooltipId} role="tooltip" className="automation-calendar-tooltip" style={{left:tooltip.left, top:tooltip.above ? undefined : tooltip.top, bottom:tooltip.above ? window.innerHeight - tooltip.top + 16 : undefined, width:tooltip.width}}>
      <strong>{tooltipEvent.kind === "meeting" ? tooltipEvent.title || "未命名会议" : tooltipEvent.kind === "local" ? tooltipEvent.localRule.employeeName : automationTaskTitle(tooltipEvent.rule,tasks)}</strong>
      <span>{tooltipEvent.kind === "meeting" ? "飞书会议" : tooltipEvent.kind === "local" ? "同步本周会议" : automationSourceTask(tooltipEvent.rule,tasks)?.employeeName || "员工信息暂不可用"}</span>
      <span>{tooltipEvent.kind === "local" && !tooltipEvent.localRule.enabled ? "已暂停" : tooltipEvent.kind === "meeting" ? tooltipEvent.allDay ? `${tooltipEvent.start} — ${tooltipEvent.end} · 全天，结束日期不包含在内` : `${new Date(tooltipEvent.start).toLocaleString()} — ${new Date(tooltipEvent.end).toLocaleString()}` : <>{dateLabel(new Date(tooltip.dayStart))} · {tooltipEvent.kind === "history" ? "运行" : "预计"} {clock(tooltipEvent.first)}{tooltipEvent.count > 1 ? `—${clock(tooltipEvent.last)} · ${tooltipEvent.count} 次` : ""}</>}</span>
      <small>{tooltipEvent.kind === "meeting" ? `更新于 ${clock(tooltipEvent.fetchedAt)}` : tooltipEvent.kind === "local" && !tooltipEvent.localRule.enabled ? "已暂停" : tooltipEvent.kind === "history" ? automationRunSummary(tooltipEvent.runs) : "预计执行"}</small>
    </div>,document.body)}
    {selectedMeeting ? <AutomationSettingsDialog title={selectedMeeting.title || "未命名会议"} onClose={() => {setMeetingRef(null);setLinkError("");}}>
      <p className="calendar-meeting-time">{selectedMeeting.allDay ? `${selectedMeeting.start} — ${selectedMeeting.end} · 全天` : `${new Date(selectedMeeting.start).toLocaleString()} — ${new Date(selectedMeeting.end).toLocaleString()}`}</p>
      <div className="calendar-meeting-links">
        {selectedMeeting.calendarUrl ? <button type="button" className="personal-automation-action" onClick={() => openMeetingLink("calendarUrl")}>打开飞书日程</button> : null}
        {selectedMeeting.meetingUrl ? <button type="button" className="personal-automation-action" onClick={() => openMeetingLink("meetingUrl")}>加入会议</button> : null}
        {!selectedMeeting.calendarUrl && !selectedMeeting.meetingUrl ? <p>暂无会议链接</p> : null}
      </div>
      {linkError ? <p role="alert">{linkError}</p> : null}
      <div className="automation-settings-footer"><button type="button" className="personal-automation-action" onClick={() => setMeetingRef(null)}>关闭</button></div>
    </AutomationSettingsDialog> : null}
  </section>;
}

function eventEnabled(event) { return event.kind === "local" ? event.localRule.enabled : event.rule.state === "active"; }
function eventKey(event) { return event.kind === "local" ? "local-calendar" : event.kind === "meeting" ? `meeting:${event.eventRef}` : `${event.rule.automationId}:${event.kind}`; }
