import crypto from "node:crypto";
import { normalizeRuntimeToolEfficiencySource } from "./runtime-tool-efficiency-contract-v1.mjs";
import { normalizeRuntimeSafeActivitySnapshot, MAX_RUNTIME_SAFE_ACTIVITIES } from "./runtime-safe-activity-contract-v1.mjs";

const VERSION = "agent-loop-continuation.v1";
const MAX_BYTES = 16 * 1024 * 1024;

// Private execution state only. The caller owns encrypted storage, identity,
// live canonical lease validation and retention; this is never public evidence.
function createAgentLoopContinuation({ binding, continuation = null, persist = null } = {}) {
  if (persist !== null && typeof persist !== "function") fail();
  if (continuation !== null && !persist) fail();
  const digest = crypto.createHash("sha256").update(JSON.stringify(binding)).digest("hex");
  const restored = continuation === null ? null : validate(continuation, digest);
  return Object.freeze({
    restored,
    async save(state) {
      if (!persist) return;
      const snapshot = validate({ ...structuredClone(state), contractVersion: VERSION, bindingDigest: digest }, digest);
      await persist(snapshot);
    },
  });
}

function validate(value, digest) {
  if (!value || value.contractVersion !== VERSION || value.bindingDigest !== digest ||
    !Array.isArray(value.input) || !Array.isArray(value.pendingCalls) ||
    !Array.isArray(value.toolCalls) || value.pendingCalls.length > MAX_RUNTIME_SAFE_ACTIVITIES ||
    value.toolCalls.length > MAX_RUNTIME_SAFE_ACTIVITIES ||
    !Number.isSafeInteger(value.startedAtMs) || value.startedAtMs < 0 ||
    !Number.isSafeInteger(value.nextCallIndex) || value.nextCallIndex < 0 || value.nextCallIndex > value.pendingCalls.length ||
    typeof value.callPrepared !== "boolean" || typeof value.providerPending !== "boolean" ||
    !value.usage || typeof value.usage !== "object") fail();
  for (const name of ["requestCount", "toolCallCount", "fileInputCount", "visionInputCount"]) {
    if (!Number.isSafeInteger(value[name]) || value[name] < 0) fail();
  }
  if (value.toolCallCount > MAX_RUNTIME_SAFE_ACTIVITIES ||
    value.toolCallCount !== value.toolCalls.length + Number(value.callPrepared)) fail();
  for (const name of ["inputTokens", "outputTokens", "totalTokens"]) {
    if (value.usage[name] !== undefined && (!Number.isSafeInteger(value.usage[name]) || value.usage[name] < 0)) fail();
  }
  if (!/^[a-f0-9]{64}$/.test(value.efficiencyKey || "")) fail();
  normalizeRuntimeToolEfficiencySource(value.efficiencySource);
  normalizeRuntimeSafeActivitySnapshot(value.activitySnapshot);
  const ids = new Set();
  for (const call of value.pendingCalls) {
    if (!call || call.type !== "function_call" || typeof call.call_id !== "string" || !call.call_id.trim() || call.call_id !== call.call_id.trim().slice(0, 160) ||
      typeof call.name !== "string" || !call.name.trim() || typeof call.arguments !== "string" || ids.has(call.call_id)) fail();
    ids.add(call.call_id);
    try { JSON.parse(call.arguments); } catch { fail(); }
  }
  if (value.callPrepared && value.nextCallIndex === value.pendingCalls.length) fail();
  if (Buffer.byteLength(JSON.stringify(value)) > MAX_BYTES) fail();
  return structuredClone(value);
}

function fail() {
  throw Object.assign(new Error("agent_loop_continuation_invalid"), { code: "agent_loop_continuation_invalid" });
}

export { createAgentLoopContinuation };
