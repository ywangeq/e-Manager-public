import { cockpitTaskTitle } from "./personalCockpitModel.js";

export function automationSourceTask(rule, tasks = []) {
  return rule.sourceTaskId ? tasks.find(task => task.id === rule.sourceTaskId && task.employeeId === rule.employeeId) || null : null;
}

export function automationTaskTitle(rule, tasks = []) {
  return cockpitTaskTitle(automationSourceTask(rule, tasks) || {});
}

// Presentation estimates only. Center remains authoritative for dispatch and actual runs.
export function nextAutomationTime(rule, now = Date.now()) {
  const start = Date.parse(rule.startAt), end = Date.parse(rule.expiresAt);
  const interval = Number(rule.intervalSeconds) * 1000;
  const remaining = Number(rule.maxRuns) - Number(rule.runCount);
  if (rule.state !== "active" || !Number.isFinite(start) || !Number.isFinite(end) || !Number.isFinite(interval) || interval < 60000 || !(remaining > 0)) return null;
  const next = start + Math.max(0, Math.ceil((now - start) / interval)) * interval;
  return next < end ? next : null;
}

export function calendarWeek(value = new Date(), offset = 0) {
  const start = new Date(value);
  start.setHours(0, 0, 0, 0);
  start.setDate(start.getDate() - (start.getDay() + 6) % 7 + offset * 7);
  return Array.from({length: 7}, (_, i) => {
    const date = new Date(start); date.setDate(start.getDate() + i);
    const end = new Date(date); end.setDate(date.getDate() + 1);
    return {date, start: +date, end: +end};
  });
}

export function automationWeek(automations, days, now = Date.now()) {
  return days.map(day => ({...day, events: automations.flatMap(rule => {
    const next = nextAutomationTime(rule, now);
    if (next === null) return [];
    const interval = rule.intervalSeconds * 1000;
    const firstIndex = Math.max(0, Math.ceil((day.start - next) / interval));
    const lastIndex = Math.min(rule.maxRuns - rule.runCount - 1, Math.ceil((Math.min(day.end, Date.parse(rule.expiresAt)) - next) / interval) - 1);
    if (lastIndex < firstIndex) return [];
    return [{rule, first: next + firstIndex * interval, last: next + lastIndex * interval, count: lastIndex - firstIndex + 1}];
  }).sort((a,b) => a.first - b.first)}));
}

export function upcomingAutomations(automations, now = Date.now()) {
  return automations.map(rule => ({rule, time: nextAutomationTime(rule, now)})).filter(item => item.time !== null).sort((a,b) => a.time - b.time);
}
