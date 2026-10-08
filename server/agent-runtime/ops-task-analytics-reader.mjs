import { durationBetween, nearestRank } from "./ops-incident-diagnosis-sqlite-store.mjs";

const DAY_MS = 86_400_000;
const OFFSET_MS = 8 * 3_600_000;
const FAILURE = new Set(["failed", "lost", "timed_out"]);
const TERMINAL = new Set(["completed", ...FAILURE, "blocked", "rejected", "canceled"]);
const BUCKETS = [
  [0, 5_000, "0–5秒"], [5_000, 15_000, "5–15秒"], [15_000, 30_000, "15–30秒"],
  [30_000, 60_000, "30–60秒"], [60_000, 180_000, "1–3分钟"], [180_000, null, "3分钟以上"],
];
const dateKey = (ms) => new Date(ms + OFFSET_MS).toISOString().slice(0, 10);

export function opsAnalyticsWindow({ days = 7, endDate = "", asOf = new Date().toISOString() } = {}) {
  const now = Date.parse(asOf);
  const count = Number(days);
  const end = endDate || dateKey(now);
  const endStart = Date.parse(`${end}T00:00:00+08:00`);
  if (!Number.isFinite(now) || ![7, 14, 30].includes(count) || !/^\d{4}-\d{2}-\d{2}$/.test(end) ||
    !Number.isFinite(endStart) || dateKey(endStart) !== end || end > dateKey(now)) {
    throw new Error("ops_analytics_window_invalid");
  }
  const start = endStart - (count - 1) * DAY_MS;
  return {
    days: count, endDate: end, startDate: dateKey(start), timeZone: "Asia/Shanghai", sourceAsOf: asOf,
    since: new Date(start).toISOString(), until: new Date(Math.min(now, endStart + DAY_MS - 1)).toISOString(),
    dates: Array.from({ length: count }, (_, i) => dateKey(start + i * DAY_MS)),
  };
}

function accumulator() {
  return { submitted: 0, completed: 0, failed: 0, blocked: 0, canceled: 0, terminal: 0,
    durations: [], missingCount: 0, invalidCount: 0, errors: new Map(), fallbackTimestampCount: 0 };
}

function finalize(source) {
  const { durations, errors, ...counts } = source;
  const values = durations.sort((a, b) => a - b);
  return {
    ...counts,
    failureRate: counts.terminal ? counts.failed / counts.terminal : null,
    errors: [...errors].map(([code, error]) => ({ code, count: error.count, employees: [...error.employees].map(([employeeId, count]) => ({ employeeId, count })).sort((a, b) => b.count - a.count || a.employeeId.localeCompare(b.employeeId)) })).sort((a, b) => b.count - a.count || a.code.localeCompare(b.code)),
    duration: {
      sampleCount: values.length, missingCount: counts.missingCount, invalidCount: counts.invalidCount,
      p50Ms: nearestRank(values, 0.5), p95Ms: nearestRank(values, 0.95),
      buckets: BUCKETS.map(([minMs, maxMs, label]) => ({ minMs, maxMs, label, count: 0 })),
    },
  };
}

function project(source) {
  const result = finalize(source);
  for (const ms of source.durations) {
    result.duration.buckets.find((bucket) => ms >= bucket.minMs && (bucket.maxMs === null || ms < bucket.maxMs)).count += 1;
  }
  return result;
}

// Read-only projection of canonical tasks; no new store, migration, task payload or candidate limit.
export function createOpsTaskAnalyticsReader(database) {
  return function summarize({ tenantScope, days = 7, endDate = "", employeeId = "", asOf } = {}) {
    const window = opsAnalyticsWindow({ days, endDate, asOf });
    const totals = accumulator();
    const daily = new Map(window.dates.map((date) => [date, accumulator()]));
    const employees = new Map();
    const sinceMs = Date.parse(window.since);
    const untilMs = Date.parse(window.until);
    const inWindow = (ms) => Number.isFinite(ms) && ms >= sinceMs && ms <= untilMs;
    const rows = database.prepare(`
      SELECT employee_id, status, created_at, finished_at, updated_at, last_error_code
      FROM execution_tasks
      WHERE tenant_scope = ? AND (? = '' OR employee_id = ?)
        AND ((created_at >= ? AND created_at <= ?)
          OR (finished_at >= ? AND finished_at <= ?)
          OR (updated_at >= ? AND updated_at <= ?))
    `).iterate(tenantScope, employeeId, employeeId, window.since, window.until, window.since, window.until, window.since, window.until);
    for (const row of rows) {
      const created = Date.parse(row.created_at || "");
      const finished = Date.parse(row.finished_at || "");
      const terminalAt = Number.isFinite(finished) ? finished : Date.parse(row.updated_at || "");
      const createdInWindow = inWindow(created);
      const terminalInWindow = TERMINAL.has(row.status) && inWindow(terminalAt);
      if (!createdInWindow && !terminalInWindow) continue;
      if (!employees.has(row.employee_id)) employees.set(row.employee_id, new Map(window.dates.map((date) => [date, { submitted: 0, completed: 0, failed: 0 }])));
      const employee = employees.get(row.employee_id);
      if (createdInWindow) {
        totals.submitted += 1;
        daily.get(dateKey(created)).submitted += 1;
        employee.get(dateKey(created)).submitted += 1;
      }
      if (!terminalInWindow) continue;
      const date = dateKey(terminalAt);
      const outcome = row.status === "completed" ? "completed" : FAILURE.has(row.status) ? "failed" : row.status === "canceled" ? "canceled" : "blocked";
      if (["completed", "failed"].includes(outcome)) employee.get(date)[outcome] += 1;
      for (const target of [totals, daily.get(date)]) {
        target.terminal += 1;
        target[outcome] += 1;
        if (!Number.isFinite(finished)) target.fallbackTimestampCount += 1;
        if (outcome === "failed") {
          const code = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,119}$/.test(row.last_error_code || "") ? row.last_error_code : "runtime_failure_unclassified";
          const error = target.errors.get(code) || { count: 0, employees: new Map() };
          error.count += 1;
          error.employees.set(row.employee_id, (error.employees.get(row.employee_id) || 0) + 1);
          target.errors.set(code, error);
        }
        const elapsed = durationBetween(row.created_at, row.finished_at);
        if (elapsed === null) target.missingCount += 1;
        else if (!Number.isFinite(elapsed) || elapsed < 0) target.invalidCount += 1;
        else target.durations.push(elapsed);
      }
    }
    return {
      contractVersion: "ops-runtime-task-analytics.v1",
      coverage: { ...window, taskAuthority: "canonical_execution_task", employeeId, truncated: false },
      summary: project(totals),
      daily: [...daily].map(([date, source]) => ({ date, ...project(source) })),
      employees: [...employees].sort(([a], [b]) => a.localeCompare(b)).map(([id, series]) => ({ employeeId: id, daily: [...series].map(([date, counts]) => ({ date, ...counts })) })),
    };
  };
}
