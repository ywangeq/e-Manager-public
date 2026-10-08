const weekdays = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];

// Only expose lossless simple schedules in the picker; retain all others as Cron.
export function parseSimpleSchedule(expression) {
  const fields = String(expression || "").trim().split(/\s+/);
  if (fields.length !== 5) return null;
  const [minute, hour, day, month, weekday] = fields;
  const integer = value => /^\d+$/.test(value);
  if (!integer(minute) || +minute > 59 || !integer(hour) || +hour > 23 || month !== "*") return null;
  const time = `${hour.padStart(2, "0")}:${minute.padStart(2, "0")}`;
  if (day === "*" && weekday === "*") return { frequency: "daily", time, day: "1", weekday: "1" };
  if (day === "*" && integer(weekday) && +weekday <= 6) return { frequency: "weekly", time, day: "1", weekday: String(+weekday) };
  if (weekday === "*" && integer(day) && +day >= 1 && +day <= 31) return { frequency: "monthly", time, day: String(+day), weekday: "1" };
  return null;
}

export function simpleScheduleExpression({ frequency, time, day, weekday }) {
  if (!/^\d{2}:\d{2}$/.test(time)) return null;
  const [hour, minute] = time.split(":").map(Number);
  if (hour > 23 || minute > 59) return null;
  if (frequency === "daily") return `${minute} ${hour} * * *`;
  if (frequency === "weekly" && /^[0-6]$/.test(String(weekday))) return `${minute} ${hour} * * ${weekday}`;
  if (frequency === "monthly" && Number.isInteger(+day) && +day >= 1 && +day <= 31) return `${minute} ${hour} ${+day} * *`;
  return null;
}

export function scheduleDescription(expression) {
  const value = parseSimpleSchedule(expression);
  if (!value) return "自定义时间";
  const prefix = value.frequency === "daily" ? "每天" : value.frequency === "weekly" ? `每${weekdays[+value.weekday]}` : `每月${value.day}日`;
  return `${prefix} ${value.time}`;
}

export function scheduleTimezoneLabel(timezone) {
  return timezone === "Asia/Shanghai" ? "北京时间" : timezone;
}
