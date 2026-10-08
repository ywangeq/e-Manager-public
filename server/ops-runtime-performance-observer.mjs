const CONTRACT_VERSION = "ops-runtime-performance-summary.v1";
const DEFAULT_RETENTION_MS = 60 * 60_000;
const DEFAULT_MAX_SAMPLES = 10_000;

export function createOpsRuntimePerformanceObserver({
  now = () => Date.now(),
  retentionMs = DEFAULT_RETENTION_MS,
  maxSamples = DEFAULT_MAX_SAMPLES,
} = {}) {
  const safeRetentionMs = boundedInteger(retentionMs, "retentionMs", 60_000, 24 * 60 * 60_000);
  const safeMaxSamples = boundedInteger(maxSamples, "maxSamples", 100, 100_000);
  const startedAt = now();
  const samples = [];

  function record({ durationMs, metricId, outcome = "ok" } = {}) {
    const safeDurationMs = Number(durationMs);
    if (!METRIC_IDS.has(metricId) || !Number.isFinite(safeDurationMs) || safeDurationMs < 0 || safeDurationMs > 60_000) return;
    if (!OUTCOMES.has(outcome)) return;
    const recordedAt = now();
    samples.push({ durationMs: Math.round(safeDurationMs * 10) / 10, metricId, outcome, recordedAt });
    trimSamples(samples, recordedAt - safeRetentionMs, safeMaxSamples);
  }

  function summarize({ windowMinutes = 15 } = {}) {
    const safeWindowMinutes = boundedInteger(windowMinutes, "windowMinutes", 1, 60);
    const asOf = now();
    const windowStart = asOf - safeWindowMinutes * 60_000;
    trimSamples(samples, asOf - safeRetentionMs, safeMaxSamples);
    return Object.freeze({
      contractVersion: CONTRACT_VERSION,
      metrics: [...METRIC_IDS].map((metricId) => metricSummary(samples, metricId, windowStart)),
      coverage: {
        collection: "process_memory",
        maxSamples: safeMaxSamples,
        processStartedAt: new Date(startedAt).toISOString(),
        retentionMinutes: Math.floor(safeRetentionMs / 60_000),
        sourceAsOf: new Date(asOf).toISOString(),
        windowMinutes: safeWindowMinutes,
      },
    });
  }

  return Object.freeze({ record, summarize });
}

const METRIC_IDS = new Set([
  "digital_employee_runtime_task_list",
  "runtime_task_actor_directory_resolution",
]);
const OUTCOMES = new Set(["ok", "empty", "error", "timeout"]);

function metricSummary(samples, metricId, windowStart) {
  const rows = samples.filter((sample) => sample.metricId === metricId && sample.recordedAt >= windowStart);
  const durations = rows.map((sample) => sample.durationMs).sort((left, right) => left - right);
  return Object.freeze({
    errorCount: rows.filter((sample) => sample.outcome === "error" || sample.outcome === "timeout").length,
    metricId,
    p50Ms: percentile(durations, 0.5),
    p95Ms: percentile(durations, 0.95),
    p99Ms: percentile(durations, 0.99),
    sampleCount: rows.length,
  });
}

function percentile(values, percentileValue) {
  if (!values.length) return null;
  return values[Math.max(0, Math.ceil(values.length * percentileValue) - 1)];
}

function trimSamples(samples, minimumTimestamp, maximum) {
  while (samples.length && (samples[0].recordedAt < minimumTimestamp || samples.length > maximum)) samples.shift();
}

function boundedInteger(value, field, minimum, maximum) {
  const normalized = Number(value);
  if (!Number.isSafeInteger(normalized) || normalized < minimum || normalized > maximum) {
    throw new TypeError(`${field} must be an integer between ${minimum} and ${maximum}`);
  }
  return normalized;
}
