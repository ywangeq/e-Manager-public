import crypto from "node:crypto";
import { createDeviceReadOperationExecutor } from "./device-read-operation-executor.mjs";
import { deviceReadAdapterDigest } from "../shared/device-read-operation-v1.mjs";

const BASE = "/api/channels/desktop/device-read";
const ATTEMPT = /^device_read_[a-f0-9]{64}$/;

// Main-only fixed-operation transport. No renderer IPC, credential delivery,
// durable queue, result cache, failed-claim retry, or implicit CLI association.
export function createDeviceReadClient({ request, adapters, actorContext, isExpectedActor,
  onCompleted = null, onFailed = null, onDiagnostic = () => {},
  setTimeoutFn = setTimeout, clearTimeoutFn = clearTimeout } = {}) {
  if (typeof request !== "function" || !Array.isArray(adapters) || !adapters.length ||
    typeof actorContext !== "function" || typeof isExpectedActor !== "function") throw new TypeError("device_read_client_dependencies_required");
  const actor = Object.freeze({ ...actorContext() });
  const deviceSessionId = `dwr_${crypto.randomBytes(16).toString("hex")}`;
  const capabilities = adapters.map(deviceReadAdapterDigest);
  let stopped = false, registered = false, timer, pending = null, failures = 0;
  const controller = new AbortController();
  const report = value => { try { onDiagnostic(value); } catch { /* Diagnostics never affect execution. */ } };
  const current = () => !stopped && Boolean(actor.key) && isExpectedActor(actor.key, actor.version);
  const headers = (extra = {}) => ({ ...extra, "x-digital-workforce-read-device": deviceSessionId });
  async function call(suffix, body, signal = controller.signal, method = "POST") {
    if (!current()) throw new Error("device_read_actor_changed");
    const response = await request(BASE + suffix, { method, headers: headers({ Accept: "application/json", "Content-Type": "application/json" }),
      ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.any([signal, AbortSignal.timeout(5000)]) });
    if (!current()) throw new Error("device_read_actor_changed");
    if (!response.ok) throw new Error("device_read_transport_unavailable");
    const data = await boundedJson(response);
    if (!current() || data.ok !== true) throw new Error("device_read_transport_unavailable");
    return data;
  }
  let activeClaim = null;
  const executor = createDeviceReadOperationExecutor({ adapters, validateLiveClaim: async (claim, { signal }) => {
    if (!activeClaim || activeClaim.claim.operationDigest !== claim.operationDigest || !current()) return false;
    try {
      const allowed = (await call(`/attempts/${activeClaim.attemptId}/validate`, { operationDigest: claim.operationDigest }, signal)).allowed === true;
      report({ stage: "authority", code: allowed ? "allowed" : "blocked" }); return allowed;
    } catch { report({ stage: "authority", code: "transport_failed" }); return false; }
  } });
  async function tick() {
    if (!current() || pending) return;
    pending = (async () => {
      try {
        // Presence renewal declares fixed local capabilities, not OAuth expiry.
        await call("/session", { capabilities, timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone }); registered = true;
        const next = (await call("/claim", undefined, controller.signal, "GET")).dispatch;
        if (!next) { failures = 0; return; }
        if (!ATTEMPT.test(next.attemptId || "") || !next.claim || Object.keys(next).sort().join(",") !== "attemptId,claim")
          throw new Error("device_read_claim_invalid");
        activeClaim = next;
        report({ stage: "execution_started" });
        const safe = await executor.execute(next.claim, { signal: controller.signal, onDiagnostic: report });
        report({ stage: "execution_finished", code: safe.code || safe.status });
        if (!current()) return;
        const body = { operationDigest: next.claim.operationDigest,
          status: safe.status === "completed" ? "completed" : safe.status === "canceled" ? "canceled" : "failed" };
        if (body.status === "completed") body.result = executor.takePrivateResult(safe);
        // Once only. A lost response is unknown on Center, never queued/replayed.
        report({ stage: "result_started" });
        const acknowledgement = await call(`/attempts/${next.attemptId}/result`, body);
        report({ stage: "result_finished", code: acknowledgement.status });
        if (current() && body.status === "completed" && acknowledgement.status === "completed") {
          // The presentation observer cannot alter execution or its private result.
          try { onCompleted?.(structuredClone({ claim: next.claim, result: body.result })); } catch { /* Presentation only. */ }
        } else if (current()) {
          try { onFailed?.(structuredClone(next.claim)); } catch { /* Presentation only. */ }
        }
        failures = 0;
      } catch {
        if (activeClaim) report({ stage: "transport_failed", code: "transport_failed" });
        failures++; // Only the canonical authority may settle loss/contact.
        if (current() && activeClaim) { try { onFailed?.(structuredClone(activeClaim.claim)); } catch { /* Presentation only. */ } }
      }
      finally { activeClaim = null; }
    })();
    await pending; pending = null;
    if (current()) { timer = setTimeoutFn(tick, Math.min(60_000, 3000 * 2 ** Math.min(failures, 5))); timer?.unref?.(); }
  }
  return Object.freeze({ start: tick, headers,
    async stop() {
      if (stopped) return;
      clearTimeoutFn(timer); stopped = true; controller.abort();
      await pending;
      if (registered && isExpectedActor(actor.key, actor.version)) {
        try { await request(BASE + "/session", { method: "DELETE", headers: headers(), signal: AbortSignal.timeout(1000) }); } catch { /* Presence expires. */ }
      }
    },
  });
}

async function boundedJson(response) {
  const reader = response.body?.getReader?.();
  if (!reader) throw new Error("device_read_transport_unavailable");
  const chunks = []; let count = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      count += value.byteLength;
      if (count > 40 * 1024) { await reader.cancel(); throw new Error(); }
      chunks.push(Buffer.from(value));
    }
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch { throw new Error("device_read_transport_unavailable"); }
  finally { reader.releaseLock(); }
}
