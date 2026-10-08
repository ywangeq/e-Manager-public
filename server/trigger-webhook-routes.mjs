import crypto from "node:crypto";

const TRIGGER_WEBHOOK_ROUTE_VERSION = "trigger-webhook-route.v1";
const TRIGGER_WEBHOOK_PATH_PATTERN = /^\/api\/triggers\/webhooks\/([A-Za-z0-9][A-Za-z0-9._:@-]{0,159})$/;
const MAX_EVENT_AGE_MS = 10 * 60 * 1000;
const MAX_FUTURE_SKEW_MS = 2 * 60 * 1000;

function createTriggerWebhookHandlers({
  adapterRegistry,
  bindingRegistry,
  readJsonBody,
  resolveBindingSecret,
  sendJson,
  submissionService,
  now = () => new Date(),
} = {}) {
  assertDependencies({
    adapterRegistry,
    bindingRegistry,
    readJsonBody,
    resolveBindingSecret,
    sendJson,
    submissionService,
  });

  async function handle(req, res, url) {
    const match = url.pathname.match(TRIGGER_WEBHOOK_PATH_PATTERN);
    if (!match) return undefined;
    if (req.method !== "POST") return sendJson(res, 405, { ok: false, error: "method_not_allowed" });
    const bindingId = match[1];
    const binding = bindingRegistry.get(bindingId);
    if (!binding) return sendJson(res, 404, { ok: false, error: "trigger_binding_not_found" });
    const expectedSecret = resolveBindingSecret(binding);
    if (!validSecret(expectedSecret)) {
      return sendJson(res, 503, { ok: false, error: "trigger_binding_secret_unconfigured" });
    }
    if (!authorized(req.headers.authorization, expectedSecret)) {
      return sendJson(res, 401, { ok: false, error: "trigger_webhook_unauthorized" });
    }
    const adapter = adapterRegistry.get(binding.sourceAdapterId);
    if (!adapter || typeof adapter.adapt !== "function") {
      return sendJson(res, 503, { ok: false, error: "trigger_source_adapter_unavailable" });
    }
    try {
      const payload = await readJsonBody(req, 16 * 1024);
      const event = adapter.adapt(payload);
      assertFreshEvent(event.occurredAt, now());
      const result = submissionService.submit({
        bindingId,
        event,
        sourceAdapterId: adapter.adapterId,
      });
      const duplicate = result.triggerCreated === false;
      return sendJson(res, 202, {
        ok: true,
        contractVersion: "trigger-webhook-acceptance.v1",
        accepted: true,
        duplicate,
        status: duplicate ? "already_accepted" : "accepted",
        taskRef: result.task.taskId,
        triggerRef: result.triggerEvent.triggerEventId,
      });
    } catch (error) {
      const code = safeErrorCode(error);
      const status = code === "trigger_event_too_old" || code === "trigger_event_from_future"
        ? 409
        : code.includes("idempotency_conflict") ? 409 : 422;
      return sendJson(res, status, { ok: false, error: code });
    }
  }

  return Object.freeze({
    contractVersion: TRIGGER_WEBHOOK_ROUTE_VERSION,
    handle,
  });
}

function createTriggerSourceAdapterRegistry(adapters = []) {
  const byId = new Map();
  for (const adapter of adapters) {
    const id = String(adapter?.adapterId || "").trim();
    if (!id || typeof adapter?.adapt !== "function" || byId.has(id)) {
      throw new TypeError("trigger source adapters require unique adapterId and adapt");
    }
    byId.set(id, adapter);
  }
  return Object.freeze({ get: (adapterId) => byId.get(String(adapterId || "").trim()) || null });
}

function assertFreshEvent(occurredAt, currentTime) {
  const eventMs = Date.parse(occurredAt);
  const nowMs = currentTime instanceof Date ? currentTime.getTime() : Date.parse(currentTime);
  if (!Number.isFinite(eventMs) || !Number.isFinite(nowMs)) throw routeError("trigger_event_timestamp_invalid");
  if (eventMs < nowMs - MAX_EVENT_AGE_MS) throw routeError("trigger_event_too_old");
  if (eventMs > nowMs + MAX_FUTURE_SKEW_MS) throw routeError("trigger_event_from_future");
}

function authorized(headerValue, expectedSecret) {
  const header = String(headerValue || "");
  if (!header.startsWith("Bearer ")) return false;
  const supplied = header.slice("Bearer ".length).trim();
  if (!validSecret(supplied)) return false;
  const expected = Buffer.from(expectedSecret, "utf8");
  const actual = Buffer.from(supplied, "utf8");
  return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
}

function validSecret(value) {
  const text = String(value || "").trim();
  return text.length >= 32 && text.length <= 256 && !/[\s\u0000-\u001f\u007f]/.test(text);
}

function assertDependencies(value) {
  if (typeof value.adapterRegistry?.get !== "function") throw new TypeError("trigger webhook requires adapterRegistry.get");
  if (typeof value.bindingRegistry?.get !== "function") throw new TypeError("trigger webhook requires bindingRegistry.get");
  if (typeof value.bindingRegistry?.resolve !== "function") throw new TypeError("trigger webhook requires bindingRegistry.resolve");
  if (typeof value.readJsonBody !== "function") throw new TypeError("trigger webhook requires readJsonBody");
  if (typeof value.resolveBindingSecret !== "function") throw new TypeError("trigger webhook requires resolveBindingSecret");
  if (typeof value.sendJson !== "function") throw new TypeError("trigger webhook requires sendJson");
  if (typeof value.submissionService?.submit !== "function") throw new TypeError("trigger webhook requires submissionService.submit");
}

function safeErrorCode(error) {
  const code = String(error?.code || "");
  return /^[a-z][a-z0-9_]{1,119}$/.test(code) ? code : "trigger_webhook_payload_invalid";
}

function routeError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

export {
  MAX_EVENT_AGE_MS,
  MAX_FUTURE_SKEW_MS,
  TRIGGER_WEBHOOK_ROUTE_VERSION,
  createTriggerSourceAdapterRegistry,
  createTriggerWebhookHandlers,
};
