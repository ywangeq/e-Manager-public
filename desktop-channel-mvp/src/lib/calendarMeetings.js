import { FEISHU_CALENDAR_READ_DESCRIPTOR as contract } from "../../shared/feishu-calendar-read-contract.mjs";

export function meetingWeek(snapshots, days) {
  if (Array.isArray(snapshots)) {
    const windows = snapshots.slice(-4).map(snapshot => meetingWeek(snapshot,days));
    return days.map((day,index) => {
      let coveredUntil = day.start;
      for (const range of windows.map(window => window[index].readWindow).filter(Boolean).sort((a,b)=>a.start-b.start)) {
        if (range.start <= coveredUntil) coveredUntil = Math.max(coveredUntil,range.end);
      }
      return {...day, meetingsCovered: coveredUntil >= day.end,
        meetings: [...new Map(windows.flatMap(window => window[index].meetings).map(event => [event.eventRef,event])).values()].sort((a,b)=>a.first-b.first)};
    });
  }
  const snapshot = snapshots;
  if (!snapshot) return days.map(day => ({ ...day, meetings: [], meetingsCovered: false }));
  let range, events;
  try {
    range = contract.normalizeInput({ start: snapshot.start, end: snapshot.end });
    events = contract.normalizeResult({ events: snapshot.events }).events;
    if (!Number.isFinite(Date.parse(snapshot.fetchedAt))) throw new Error();
  } catch { return days.map(day => ({ ...day, meetings: [], meetingsCovered: false })); }
  const begin = Date.parse(range.start), finish = Date.parse(range.end);
  const unique = [...new Map(events.map(event => [event.eventRef, event])).values()];
  return days.map(day => ({ ...day, readWindow: {start:begin,end:finish}, meetingsCovered: begin <= day.start && finish >= day.end,
    meetings: unique.flatMap(event => {
      const allDay = event.start.length === 10;
      const start = allDay ? localDate(event.start) : Date.parse(event.start);
      const end = allDay ? localDate(event.end) : Date.parse(event.end);
      const windowStart = Math.max(begin, day.start), windowEnd = Math.min(finish, day.end);
      if (windowStart >= windowEnd || start >= windowEnd || end < windowStart || (end === windowStart && start !== end)) return [];
      return [{ ...event, fetchedAt: snapshot.fetchedAt, kind: "meeting", allDay, first: Math.max(start, day.start), last: Math.min(end, day.end) }];
    }).sort((a,b) => a.first - b.first || a.eventRef.localeCompare(b.eventRef)) }));
}

function localDate(value) {
  const [year, month, day] = value.split("-").map(Number);
  const date = new Date(0); date.setFullYear(year, month - 1, day); date.setHours(0,0,0,0);
  return +date;
}
