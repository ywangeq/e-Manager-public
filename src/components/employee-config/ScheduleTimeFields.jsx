import { parseSimpleSchedule, simpleScheduleExpression, scheduleDescription, scheduleTimezoneLabel } from "../../lib/schedulePresentation";

export default function ScheduleTimeFields({ expression, timezone, disabled, onChange }) {
  const simple = parseSimpleSchedule(expression);
  function update(patch) {
    const next = simpleScheduleExpression({ ...(simple || { frequency: "daily", time: "09:00", day: "1", weekday: "1" }), ...patch });
    if (next) onChange(next);
  }
  return <>
    <div className="employee-schedule-sheet-fields">
      <label className="employee-schedule-form-row"><span>重复频率</span><select disabled={disabled} value={simple?.frequency || "custom"} onChange={event => update({ frequency: event.target.value })}>
        {!simple && <option value="custom">自定义（高级设置）</option>}
        <option value="daily">每天</option><option value="weekly">每周</option><option value="monthly">每月</option>
      </select></label>
      {simple && <label className="employee-schedule-form-row"><span>执行时间</span><input type="time" required disabled={disabled} value={simple.time} onChange={event => update({ time: event.target.value })}/></label>}
      {simple?.frequency === "weekly" && <label className="employee-schedule-form-row"><span>星期</span><select disabled={disabled} value={simple.weekday} onChange={event => update({ weekday: event.target.value })}>
        {[1, 2, 3, 4, 5, 6, 0].map(day => <option key={day} value={day}>{["周日", "周一", "周二", "周三", "周四", "周五", "周六"][day]}</option>)}
      </select></label>}
      {simple?.frequency === "monthly" && <label className="employee-schedule-form-row"><span>日期</span><select disabled={disabled} value={simple.day} onChange={event => update({ day: event.target.value })}>
        {Array.from({ length: 31 }, (_, index) => <option key={index + 1} value={index + 1}>{index + 1}日</option>)}
      </select>{+simple.day > 28 && <small>没有该日期的月份不执行。</small>}</label>}
    </div>
    <small>{scheduleDescription(expression)} · {scheduleTimezoneLabel(timezone)}</small>
    <details open={simple ? undefined : true}>
      <summary>高级设置 · Cron 表达式</summary>
      <label className="employee-schedule-form-row"><span>Cron 表达式</span><input required value={expression} disabled={disabled} onChange={event => onChange(event.target.value)}/><small>依次为分钟、小时、日期、月份、星期；按所选时区执行。</small></label>
    </details>
  </>;
}
