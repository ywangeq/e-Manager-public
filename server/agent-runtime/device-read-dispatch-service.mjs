import { isDeepStrictEqual } from "node:util";
import { boundedDeviceReadResult, deviceReadAdapterDigest, deviceReadOperationDigest,
  DEVICE_READ_OPERATION_VERSION, normalizeDeviceReadClaim } from "../../desktop-channel-mvp/shared/device-read-operation-v1.mjs";

// The canonical repository is the sole attempt/claim authority. This process-only
// map transports a live invocation's private arguments/result; it is neither a
// recoverable queue nor a credential store. HTTP/session adapters must supply
// authenticated tenant/actor/Device identity, never request-body identity.
export function createDeviceReadDispatchService({ attempts, descriptors = [], validateLiveContext, now = () => Date.now() } = {}) {
  if (!attempts || typeof attempts.create !== "function" || typeof attempts.transition !== "function" || typeof attempts.isLive !== "function" ||
    typeof validateLiveContext !== "function") throw new TypeError("device_read_dispatch_authority_required");
  const registry = new Map();
  for (const descriptor of descriptors) {
    const key = `${descriptor.toolId}:${descriptor.operationId}`;
    if (registry.has(key)) throw new TypeError("device_read_dispatch_registration_conflict");
    registry.set(key, Object.freeze({ ...descriptor, inputSchema: freeze(structuredClone(descriptor.inputSchema)),
      resultSchema: freeze(structuredClone(descriptor.resultSchema)) }));
  }
  const pending = new Map();
  const keyFor = (tenantScope, attemptId) => JSON.stringify([tenantScope, attemptId]);
  const fail = reason => { throw new Error(`device_read_${reason}`); };
  const matches = (entry, identity) => entry.tenantScope === identity?.tenantScope &&
    entry.binding.actorDigest === identity.actorDigest && entry.binding.deviceSessionDigest === identity.deviceSessionDigest;
  function canonicalLive(entry) {
    return attempts.isLive({ tenantScope: entry.tenantScope, attemptId: entry.attemptId, ownership: entry.ownership,
      deviceSessionDigest: entry.binding.deviceSessionDigest, now: new Date(now()) });
  }
  async function live(entry) {
    return pending.get(entry.key) === entry && !entry.signal?.aborted && now() < Date.parse(entry.claim.expiresAt) && canonicalLive(entry) &&
      await validateLiveContext(entry.binding, { tenantScope: entry.tenantScope, ownership: entry.ownership }) === true &&
      pending.get(entry.key) === entry && !entry.signal?.aborted && now() < Date.parse(entry.claim.expiresAt) && canonicalLive(entry);
  }
  function move(entry, nextStatus) {
    return attempts.transition({ tenantScope: entry.tenantScope, attemptId: entry.attemptId, ownership: entry.ownership,
      deviceSessionDigest: entry.binding.deviceSessionDigest, nextStatus, now: new Date(now()) });
  }
  function settle(entry, error, value) {
    if (pending.get(entry.key) !== entry) return;
    pending.delete(entry.key); clearTimeout(entry.timer); entry.signal?.removeEventListener("abort", entry.abort);
    entry.input = null;
    if (error) entry.reject(error); else entry.resolve(value);
  }
  function abandon(entry, reason) {
    if (pending.get(entry.key) !== entry) return;
    try {
      const stored = attempts.read({ tenantScope: entry.tenantScope, attemptId: entry.attemptId });
      // A sent read may still be executing. Never represent lost contact as a
      // confirmed cancellation or a replayable failure.
      move(entry, stored.status === "prepared" && reason === "canceled" ? "canceled" : "unknown");
    } catch { /* A lost canonical lease cannot manufacture terminal authority. */ }
    settle(entry, new Error(`device_read_${reason}`));
  }
  async function dispatchRead({ tenantScope, ownership, binding, input }, { signal } = {}) {
    if (signal?.aborted) fail("canceled");
    // Snapshot caller-owned authority before the first asynchronous validation.
    binding = freeze(structuredClone(binding)); ownership = freeze(structuredClone(ownership));
    const descriptor = registry.get(`${binding?.toolId}:${binding?.operationId}`);
    if (!descriptor || binding.adapterDigest !== deviceReadAdapterDigest(descriptor)) fail("dispatch_operation_unavailable");
    const normalized = descriptor.normalizeInput(structuredClone(input));
    if (!isDeepStrictEqual(normalized, input) || binding.inputDigest !== deviceReadOperationDigest({ input: normalized })) fail("dispatch_input_invalid");
    const privateInput = freeze(structuredClone(normalized));
    const expiresAt = new Date(now() + 90_000).toISOString();
    const claimBody = { contractVersion: DEVICE_READ_OPERATION_VERSION, taskId: binding.taskId, toolCallId: binding.toolCallId,
      toolId: binding.toolId, operationId: binding.operationId, adapterDigest: binding.adapterDigest,
      taskInputDigest: binding.taskInputDigest, actorDigest: binding.actorDigest, deviceSessionDigest: binding.deviceSessionDigest,
      expiresAt, input: privateInput };
    const claim = normalizeDeviceReadClaim({ ...claimBody, operationDigest: deviceReadOperationDigest(claimBody) }, descriptor, now());
    if (!claim || await validateLiveContext(binding, { tenantScope, ownership }) !== true || signal?.aborted) fail("dispatch_authority_unavailable");
    const created = attempts.create({ tenantScope, ownership, binding, now: new Date(now()), expiresAt });
    if (!created.created) fail("attempt_not_replayable");
    const entry = { tenantScope, ownership: Object.freeze({ ...ownership }), binding: Object.freeze({ ...binding }),
      descriptor, claim, input: privateInput, signal, attemptId: created.attempt.attemptId };
    entry.key = keyFor(tenantScope, entry.attemptId);
    return await new Promise((resolve, reject) => {
      entry.resolve = resolve; entry.reject = reject;
      entry.abort = () => abandon(entry, "canceled");
      pending.set(entry.key, entry);
      entry.timer = setTimeout(() => abandon(entry, "timed_out"), Math.max(1, Date.parse(expiresAt) - now()));
      entry.timer.unref?.();
      signal?.addEventListener("abort", entry.abort, { once: true });
      if (signal?.aborted) entry.abort();
    });
  }
  async function claimNext(identity) {
    for (const entry of pending.values()) {
      if (!matches(entry, identity)) continue;
      if (!await live(entry)) { abandon(entry, "authority_changed"); continue; }
      const stored = attempts.read({ tenantScope: entry.tenantScope, attemptId: entry.attemptId });
      if (stored.status !== "prepared") continue;
      try { move(entry, "running"); } catch { continue; }
      // The CAS is synchronous after the last live check. Return one immutable
      // fixed-operation claim; repeated polls cannot dispatch it again.
      return Object.freeze({ attemptId: entry.attemptId, claim: entry.claim });
    }
    return null;
  }
  async function validateClaim(identity, attemptId, operationDigest) {
    const entry = pending.get(keyFor(identity?.tenantScope, attemptId));
    if (!entry || !matches(entry, identity) || operationDigest !== entry.claim.operationDigest || !await live(entry)) return false;
    return attempts.read({ tenantScope: entry.tenantScope, attemptId }).status === "running";
  }
  async function complete(identity, { attemptId, operationDigest, status, result } = {}) {
    const entry = pending.get(keyFor(identity?.tenantScope, attemptId));
    if (!entry || !matches(entry, identity) || operationDigest !== entry.claim.operationDigest) fail("result_binding_unavailable");
    if (!await validateClaim(identity, attemptId, operationDigest)) fail("result_authority_unavailable");
    if (!["completed", "failed", "canceled"].includes(status)) fail("result_status_invalid");
    let projected;
    try {
      if (status === "completed") projected = boundedDeviceReadResult(result, entry.descriptor);
      else if (result !== undefined) fail("failure_payload_invalid");
    } catch { fail("result_invalid"); }
    // Normalization is a private projection; recheck authority after it before
    // publishing facts to the waiting Agent. Never persist the calendar body.
    if (!await validateClaim(identity, attemptId, operationDigest)) fail("result_authority_unavailable");
    move(entry, status);
    if (status === "completed") settle(entry, null, { status, binding: entry.binding, result: projected });
    else settle(entry, new Error(`device_read_${status}`));
    return Object.freeze({ ok: true, status });
  }
  return Object.freeze({ dispatchRead, claimNext, validateClaim, complete,
    close() { for (const entry of [...pending.values()]) abandon(entry, "transport_closed"); } });
}
function freeze(value) {
  if (value && typeof value === "object") { Object.values(value).forEach(freeze); Object.freeze(value); }
  return value;
}
