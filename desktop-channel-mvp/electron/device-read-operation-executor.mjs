import { boundedDeviceReadResult, DEVICE_READ_RESULT_VERSION, normalizeDeviceReadClaim } from "../shared/device-read-operation-v1.mjs";

// Device-side registered-operation boundary only. No renderer IPC, queue,
// persistence or implicit task authorization. Missing live authority fails closed.
export function createDeviceReadOperationExecutor({ adapters = [], validateLiveClaim, now = () => Date.now() } = {}) {
  if (typeof validateLiveClaim !== "function") throw new TypeError("device_read_live_authority_required");
  const registry = new Map();
  for (const adapter of adapters) {
    const key = `${adapter.toolId}:${adapter.operationId}`;
    if (registry.has(key)) throw new TypeError("device_read_operation_conflict");
    registry.set(key, adapter);
  }
  const privateResults = new WeakMap();
  const inFlight = new Set();
  const safe = (status, code) => Object.freeze({ contractVersion: DEVICE_READ_RESULT_VERSION, status, code });
  async function execute(value, { signal, onDiagnostic = () => {} } = {}) {
    const adapter = registry.get(`${value?.toolId}:${value?.operationId}`);
    if (!adapter) return safe("blocked", "device_read_operation_unavailable");
    const claim = normalizeDeviceReadClaim(value, adapter, now());
    if (!claim) return safe("blocked", "device_read_claim_invalid");
    const key = `${claim.taskId}:${claim.toolCallId}`;
    if (signal?.aborted) return safe("canceled", "device_read_canceled");
    if (inFlight.has(key)) return safe("blocked", "device_read_claim_in_flight");
    const deadline = new AbortController();
    const timer = setTimeout(() => deadline.abort(), Math.max(1, Date.parse(claim.expiresAt) - now()));
    timer.unref?.();
    signal = signal ? AbortSignal.any([signal, deadline.signal]) : deadline.signal;
    inFlight.add(key);
    try {
      if (await validateLiveClaim(claim, { signal }) !== true) return safe("blocked", "device_read_authority_unavailable");
      if (signal?.aborted) return safe("canceled", "device_read_canceled");
      if (!normalizeDeviceReadClaim(claim, adapter, now())) return safe("blocked", "device_read_claim_expired");
      const result = boundedDeviceReadResult(await adapter.execute(claim.input, { signal, onDiagnostic }), adapter);
      if (signal?.aborted) return safe("canceled", "device_read_canceled");
      if (!normalizeDeviceReadClaim(claim, adapter, now()) || await validateLiveClaim(claim, { signal }) !== true)
        return safe("blocked", "device_read_authority_changed");
      if (signal?.aborted) return safe("canceled", "device_read_canceled");
      const projection = safe("completed", "");
      privateResults.set(projection, result);
      return projection;
    } catch (error) {
      const code = ["feishu_read_identity_unavailable", "feishu_read_unavailable", "feishu_read_helper_integrity_invalid"].includes(error?.message)
        ? error.message : "device_read_failed";
      onDiagnostic({ stage: "execution_failed", code });
      return signal?.aborted ? safe("canceled", "device_read_canceled") : safe("failed", "device_read_failed");
    } finally { clearTimeout(timer); inFlight.delete(key); }
  }
  return Object.freeze({ execute,
    takePrivateResult(result) { const value = privateResults.get(result) || null; privateResults.delete(result); return value; },
  });
}
