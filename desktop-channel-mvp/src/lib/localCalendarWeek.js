import { allowedTime } from "../../shared/local-calendar-schedule.mjs";

// Forecast from the main-owned nextAt, not another schedule or execution store.
export function localCalendarWeek(rule, days, now) {
  const slots = new Map();
  if (!rule?.configured) return days.map(day => ({...day,localEvents:[]}));
  if (!rule.enabled) {
    const today = days.find(day => day.start <= now && now < day.end);
    if (today) slots.set(today.start,[now]);
  } else {
    let next = Date.parse(rule.nextAt);
    const interval = rule.intervalMinutes * 60_000;
    if (Number.isFinite(next) && interval >= 15*60_000 && interval <= 10080*60_000 &&
      [rule.windowStart,rule.windowEnd].every(value => Number.isInteger(value) && value >= 0 && value < 1440)) {
      // Bound work even when the saved timestamp is old; missed runs are omitted.
      for (let i=0; i<800 && next < days.at(-1).end; i++) {
        next = allowedTime(next,rule.windowStart,rule.windowEnd);
        const day = days.find(day => day.start <= next && next < day.end);
        if (day && next >= now) slots.set(day.start,[...(slots.get(day.start)||[]),next]);
        next += interval;
      }
    }
  }
  return days.map(day => {const times=slots.get(day.start)||[];return {...day,localEvents:times.length ? [{kind:"local",localRule:rule,first:times[0],last:times.at(-1),count:times.length}] : []};});
}
