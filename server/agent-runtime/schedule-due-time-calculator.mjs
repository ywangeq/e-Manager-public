import { CronExpressionParser } from "cron-parser";

const SCHEDULE_DUE_TIME_CALCULATOR_CONTRACT_VERSION = "schedule-due-time-calculator.v1";
const MAX_DUE_SCAN_WINDOW_MS = 7 * 24 * 60 * 60 * 1_000;
const BASIC_CRON_FIELD_PATTERN = /^[0-9*,\/-]+$/;

function calculateLatestDueTime({
  cronExpression,
  timezone,
  afterExclusive,
  throughInclusive,
} = {}) {
  const expression = normalizeCronExpression(cronExpression);
  const zone = normalizeTimezone(timezone);
  const after = canonicalTimestamp(afterExclusive, "afterExclusive");
  const through = canonicalTimestamp(throughInclusive, "throughInclusive");
  if (through.getTime() < after.getTime()) {
    throw dueTimeError("schedule_due_time_range_invalid");
  }
  if (through.getTime() - after.getTime() > MAX_DUE_SCAN_WINDOW_MS) {
    throw dueTimeError("schedule_due_time_scan_window_exceeded");
  }

  let interval;
  try {
    interval = CronExpressionParser.parse(`0 ${expression}`, {
      currentDate: after,
      strict: true,
      tz: zone,
    });
  } catch {
    throw dueTimeError("schedule_due_time_cron_invalid");
  }

  let latest = null;
  while (true) {
    let candidate;
    try {
      candidate = new Date(interval.next().toISOString());
    } catch {
      return latest;
    }
    if (candidate.getTime() > through.getTime()) return latest;
    latest = candidate.toISOString();
  }
}

function normalizeCronExpression(value) {
  if (typeof value !== "string") throw dueTimeError("schedule_due_time_cron_invalid");
  const fields = value.trim().split(/\s+/);
  if (fields.length !== 5 || fields.some((field) => !BASIC_CRON_FIELD_PATTERN.test(field))) {
    throw dueTimeError("schedule_due_time_cron_invalid");
  }
  return fields.join(" ");
}

function normalizeTimezone(value) {
  const timezone = typeof value === "string" ? value.trim() : "";
  if (!timezone || timezone.length > 120) throw dueTimeError("schedule_due_time_timezone_invalid");
  try {
    const canonical = new Intl.DateTimeFormat("en-US", { timeZone: timezone })
      .resolvedOptions().timeZone;
    if (canonical !== timezone) throw new Error("timezone alias is not canonical");
    return timezone;
  } catch {
    throw dueTimeError("schedule_due_time_timezone_invalid");
  }
}

function canonicalTimestamp(value, field) {
  if (typeof value !== "string") throw dueTimeError("schedule_due_time_timestamp_invalid");
  const timestamp = new Date(value);
  if (!Number.isFinite(timestamp.getTime()) || timestamp.toISOString() !== value) {
    throw dueTimeError("schedule_due_time_timestamp_invalid", `${field} must be a canonical UTC ISO timestamp`);
  }
  return timestamp;
}

function dueTimeError(code, message = code) {
  const error = new Error(message);
  error.code = code;
  return error;
}

export {
  MAX_DUE_SCAN_WINDOW_MS,
  SCHEDULE_DUE_TIME_CALCULATOR_CONTRACT_VERSION,
  calculateLatestDueTime,
};
