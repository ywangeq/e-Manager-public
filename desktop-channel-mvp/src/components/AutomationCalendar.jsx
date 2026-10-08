import { useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { CaretLeft, CaretRight } from "@phosphor-icons/react";
import { automationSourceTask, automationTaskTitle, automationWeek, calendarWeek } from "../lib/automationCalendar.js";
import { useCockpitMotion } from "../lib/useCockpitMotion.js";
import "./automation-calendar.css";

const clock = value => new Date(value).toLocaleTimeString([], {hour:"2-digit",minute:"2-digit",hour12:false});
const dateLabel = value => value.toLocaleDateString("zh-CN", {month:"numeric",day:"numeric"});
export function AutomationCalendar({automations, tasks = [], selectedId, onSelect, onShowHistory, now}) {
  const [offset,setOffset] = useState(0);
  const [tooltip,setTooltip] = useState(null);
  const tooltipId = useId();
  const hideTimer = useRef(null);
  const calendarRef = useRef(null);
  function hideDetails() {
    clearTimeout(hideTimer.current);
    setTooltip(null);
  }
  function leaveDetails() {
    clearTimeout(hideTimer.current);
    hideTimer.current = setTimeout(() => setTooltip(null), 150);
  }
  function showDetails(target, event, dayStart) {
    clearTimeout(hideTimer.current);
    const rect = target.getBoundingClientRect();
    const width = Math.min(280, window.innerWidth - 16);
    setTooltip({event, dayStart, width, left: Math.max(8, Math.min(rect.left, window.innerWidth - width - 8)), top: rect.bottom + 8, above: rect.bottom + 220 > window.innerHeight});
  }
  useEffect(() => {
    const hide = () => { clearTimeout(hideTimer.current); setTooltip(null); };
    window.addEventListener("resize", hide);
    window.addEventListener("scroll", hide, true);
    return () => { hide(); window.removeEventListener("resize", hide); window.removeEventListener("scroll", hide, true); };
  }, []);
  useCockpitMotion(calendarRef, offset, ".automation-week-grid");
  const days = automationWeek(automations, calendarWeek(new Date(now),offset),now);
  const tooltipEvent = tooltip && days.find(day => day.start === tooltip.dayStart)?.events.find(event => event.rule.automationId === tooltip.event.rule.automationId);
  return <section className="automation-calendar" ref={calendarRef} aria-label="定时任务周历">
    <header><strong>{dateLabel(days[0].date)} — {dateLabel(days[6].date)}</strong><div>{automations.length > 0 && onShowHistory ? <button type="button" onClick={() => {hideDetails();onShowHistory();}}>运行记录</button> : null}<button type="button" aria-label="上一周" title="上一周" onClick={() => {hideDetails();setOffset(n=>n-1);}}><CaretLeft size={16}/></button><button type="button" onClick={() => {hideDetails();setOffset(0);}}>本周</button><button type="button" aria-label="下一周" title="下一周" onClick={() => {hideDetails();setOffset(n=>n+1);}}><CaretRight size={16}/></button></div></header>
    <p className="automation-calendar-note">设备时区：{Intl.DateTimeFormat().resolvedOptions().timeZone} · 以下为周期推算，实际执行以运行记录为准；离线、任务未结束或规则变化时可能跳过。</p>
    <div className="automation-week-scroll"><div className="automation-week-grid">{days.map(day => <section key={day.start} className={day.start <= now && now < day.end ? "is-today" : ""}>
      <header><span>{day.date.toLocaleDateString("zh-CN",{weekday:"short"})}</span><strong>{day.date.getDate()}</strong>{day.start <= now && now < day.end ? <small>今天</small> : null}</header>
      {day.events.length ? <ul className="automation-day-list">{day.events.map(event => <li key={event.rule.automationId}><button type="button" className={`automation-calendar-event${selectedId === event.rule.automationId ? " is-selected" : ""}`} aria-pressed={selectedId === event.rule.automationId} aria-describedby={tooltip?.event.rule.automationId === event.rule.automationId && tooltip.dayStart === day.start ? tooltipId : undefined} onMouseEnter={e => showDetails(e.currentTarget,event,day.start)} onMouseLeave={leaveDetails} onFocus={e => showDetails(e.currentTarget,event,day.start)} onBlur={hideDetails} onKeyDown={e => {if (e.key === "Escape") hideDetails();}} onClick={() => {hideDetails();onSelect(event.rule.automationId);}}>
        <time dateTime={new Date(event.first).toISOString()}>{clock(event.first)}{event.count > 1 ? `—${clock(event.last)}` : ""}</time>
        <strong><span aria-hidden="true">•</span><span>{automationTaskTitle(event.rule, tasks)}</span></strong>
        <small>预计 {event.count} 次{automationSourceTask(event.rule, tasks)?.employeeName ? ` · ${automationSourceTask(event.rule, tasks).employeeName}` : ""}</small>
      </button></li>)}</ul> : null}
      {!day.events.length ? <p className="automation-day-empty">{day.end <= now ? "日期已过 · 不显示预计安排" : "暂无预计安排"}</p> : null}
    </section>)}</div></div>
    {tooltipEvent && createPortal(<div id={tooltipId} role="tooltip" className="automation-calendar-tooltip" onMouseEnter={() => clearTimeout(hideTimer.current)} onMouseLeave={leaveDetails} style={{left:tooltip.left, top:tooltip.above ? undefined : tooltip.top, bottom:tooltip.above ? window.innerHeight - tooltip.top + 16 : undefined, width:tooltip.width}}>
      <strong>{automationTaskTitle(tooltipEvent.rule,tasks)}</strong>
      <span>{automationSourceTask(tooltipEvent.rule,tasks)?.employeeName || "员工信息暂不可用"}</span>
      <span>{dateLabel(new Date(tooltip.dayStart))} · 预计 {clock(tooltipEvent.first)}{tooltipEvent.count > 1 ? `—${clock(tooltipEvent.last)} · ${tooltipEvent.count} 次` : ""}</span>
      <small>预计安排，非实际运行记录</small>
    </div>,document.body)}
  </section>;
}
