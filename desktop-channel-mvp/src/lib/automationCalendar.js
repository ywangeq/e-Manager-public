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

export function automationWeek(automations, days, now = Date.now(), runHistory = {}) {
  return days.map(day => ({...day, events: automations.flatMap(rule => {
    const seen = new Set();
    const savedRuns = Object.hasOwn(runHistory, rule.automationId) ? runHistory[rule.automationId] : [];
    const runs = savedRuns.filter(run => {
      const time = Date.parse(run.scheduledFor);
      if (!run.taskId || seen.has(run.taskId) || !Number.isFinite(time) || time < day.start || time >= day.end || time > now) return false;
      seen.add(run.taskId);
      return true;
    }).sort((a,b) => Date.parse(a.scheduledFor) - Date.parse(b.scheduledFor));
    const history = runs.length ? [{rule, kind:"history", runs, first:Date.parse(runs[0].scheduledFor), last:Date.parse(runs.at(-1).scheduledFor), count:runs.length}] : [];
    const next = nextAutomationTime(rule, now);
    if (next === null) return history;
    const interval = rule.intervalSeconds * 1000;
    const firstIndex = Math.max(0, Math.ceil((day.start - next) / interval));
    const lastIndex = Math.min(rule.maxRuns - rule.runCount - 1, Math.ceil((Math.min(day.end, Date.parse(rule.expiresAt)) - next) / interval) - 1);
    if (lastIndex < firstIndex) return history;
    return [...history, {rule, kind:"forecast", first: next + firstIndex * interval, last: next + lastIndex * interval, count: lastIndex - firstIndex + 1}];
  }).sort((a,b) => a.first - b.first)}));
}

const RUN_LABELS = {completed:"已完成",failed:"失败",canceled:"已取消",cancelled:"已取消",blocked:"受阻",interrupted:"已中断",running:"执行中",queued:"排队中",lost:"记录不可用"};
export function automationRunSummary(runs) {
  const counts = new Map();
  for (const run of runs) { const label = RUN_LABELS[run.status] || "状态待确认"; counts.set(label, (counts.get(label) || 0) + 1); }
  return [...counts].map(([label,count]) => `${label} ${count} 次`).join(" · ");
}

export function upcomingAutomations(automations, now = Date.now()) {
  return automations.map(rule => ({rule, time: nextAutomationTime(rule, now)})).filter(item => item.time !== null).sort((a,b) => a.time - b.time);
}

export function sortedAutomations(automations, now = Date.now()) {
  return [...automations].sort((a, b) => {
    const at = nextAutomationTime(a, now), bt = nextAutomationTime(b, now);
    if (at !== null || bt !== null) return (at ?? Infinity) - (bt ?? Infinity) || String(a.automationId).localeCompare(String(b.automationId));
    const order = { attention_required: 0, paused: 1, disabled: 2, exhausted: 3 };
    return (order[a.state] ?? 4) - (order[b.state] ?? 4) || String(a.automationId).localeCompare(String(b.automationId));
  });
}

export function automationNextLabel(rule, now = Date.now()) {
  const time = nextAutomationTime(rule, now);
  return time === null ? ({ paused: "已暂停，暂无下次执行", attention_required: "需处理后才能继续执行", disabled: "已禁用", exhausted: "已结束" })[rule.state] || "下次执行时间暂不可用"
    : `下次预计 ${new Date(time).toLocaleString("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" })}`;
}
