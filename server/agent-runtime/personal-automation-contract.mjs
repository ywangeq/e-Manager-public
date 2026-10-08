import crypto from "node:crypto";

export const PERSONAL_AUTOMATION_CONTRACT = "personal-automation.v1";
export const TERMINAL_TASK_STATES = new Set(["completed", "failed", "blocked", "rejected", "canceled", "timed_out", "lost"]);
export function automationError(code) { return Object.assign(new Error(code), { code }); }
export function automationId(value) {
  if (typeof value !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,159}$/.test(value) || /^(bearer|sk-|eyJ)/i.test(value)) throw automationError("personal_automation_reference_invalid");
  return value;
}
export function automationDigest(value) { return crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex"); }
export function automationScope(value) {
  const tenantScope = automationId(value?.tenantScope), actorIssuer = automationId(value?.actorIssuer);
  if (!/^[a-f0-9]{64}$/.test(value?.actorSubjectDigest || "")) throw automationError("personal_automation_owner_invalid");
  return { tenantScope, actorIssuer, actorSubjectDigest: value.actorSubjectDigest };
}
export function automationTimestamp(value) {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value) throw automationError("personal_automation_time_invalid");
  return value;
}
export function automationInteger(value, min, max) {
  if (!Number.isSafeInteger(value) || value < min || value > max) throw automationError("personal_automation_limit_invalid");
  return value;
}
export function normalizeAutomationRequest(value, now) {
  const allowed = ["sourceTaskId", "employeeId", "idempotencyKey", "intervalSeconds", "startAt", "expiresAt", "maxRuns", "timezone"];
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).some(k => !allowed.includes(k))) throw automationError("personal_automation_request_invalid");
  const intervalSeconds = automationInteger(value.intervalSeconds, 60, 30 * 86400);
  const startAt = automationTimestamp(value.startAt), expiresAt = automationTimestamp(value.expiresAt);
  if (Date.parse(startAt) < Date.parse(now) - 90 * 86400000 || expiresAt <= startAt || Date.parse(expiresAt) - Date.parse(now) > 90 * 86400000) throw automationError("personal_automation_time_invalid");
  let timezone;
  try { timezone = new Intl.DateTimeFormat("en", { timeZone: value.timezone }).resolvedOptions().timeZone; } catch { throw automationError("personal_automation_timezone_invalid"); }
  if (typeof value.timezone !== "string" || timezone !== value.timezone) throw automationError("personal_automation_timezone_invalid");
  return { sourceTaskId: automationId(value.sourceTaskId), employeeId: automationId(value.employeeId), idempotencyKey: automationId(value.idempotencyKey), intervalSeconds, startAt, expiresAt, maxRuns: automationInteger(value.maxRuns, 1, 1000), timezone };
}
export function personalSlotIdentity(definition, scheduledFor) {
  return automationDigest([PERSONAL_AUTOMATION_CONTRACT, automationScope(definition), definition.automationId, definition.version, automationTimestamp(scheduledFor)]);
}
