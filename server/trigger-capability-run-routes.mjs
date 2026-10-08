import crypto from "node:crypto";
import { HR_TRAINING_CAPABILITY_RUN_INPUT_CONTRACT_VERSION } from
  "./triggers/hr-training/capability-run-input-repository.mjs";

const ROUTE_VERSION = "trigger-capability-run-route.v1";
const PATH = "/api/triggers/capability-runs";
const SOURCE_ADAPTER_ID = "capability-run.v1";
const DEFAULT_CAPABILITY_BINDINGS = Object.freeze({
  "hr_training.content_evaluate.v1": "trg_hr_training_content_evaluate_v1",
  "hr_training.followup_answer_evaluate.v1": "trg_hr_training_followup_answer_evaluate_v1",
  "hr_training.followup_round_evaluate.v1": "trg_hr_training_followup_round_evaluate_v1",
  "hr_training.aggregate_feedback.v1": "trg_hr_training_aggregate_feedback_v1",
});
const PAYLOAD_FIELDS = new Set([
  "callbackUrl",
  "capability",
  "contextUrl",
  "idempotencyKey",
  "meetingRecordId",
  "sessionId",
]);
const TOKEN = /^[A-Za-z0-9][A-Za-z0-9._:@:-]{0,239}$/;
const SECRET_VALUE = /(?:bearer\s+|sk-|rk-|xox[baprs]-|gh[pousr]_|glpat-|ya29\.|eyJ)[A-Za-z0-9._~+/=-]{8,}|-----BEGIN [A-Z ]*PRIVATE KEY-----/i;

function createTriggerCapabilityRunHandlers({
  bindingRegistry,
  capabilityBindings = DEFAULT_CAPABILITY_BINDINGS,
  inputRepository,
  isAllowedCallbackUrl = defaultAllowedCallbackUrl,
  isAllowedContextUrl = defaultAllowedContextUrl,
  readJsonBody,
  resolveBindingSecret,
  sendJson,
  submissionService,
  tenantScope,
} = {}) {
  assertDependencies({
    bindingRegistry,
    inputRepository,
    readJsonBody,
    resolveBindingSecret,
    sendJson,
    submissionService,
    tenantScope,
  });
  const bindingsByCapability = normalizeCapabilityBindings(capabilityBindings);

  async function handle(req, res, url) {
    if (url.pathname !== PATH) return undefined;
    if (req.method !== "POST") return sendJson(res, 405, { error: "method_not_allowed" });
    let payload;
    try {
      payload = normalizePayload(await readJsonBody(req, 32 * 1024));
    } catch (error) {
      return sendJson(res, 422, { error: safeErrorCode(error, "trigger_capability_payload_invalid") });
    }
    const bindingId = bindingsByCapability.get(payload.capability);
    if (!bindingId) return sendJson(res, 422, { error: "trigger_capability_unsupported" });
    const binding = bindingRegistry.get(bindingId);
    if (!binding) return sendJson(res, 503, { error: "trigger_capability_not_enabled" });
    if (binding.sourceAdapterId !== SOURCE_ADAPTER_ID || binding.eventType !== payload.capability) {
      return sendJson(res, 503, { error: "trigger_capability_binding_mismatch" });
    }
    const expectedSecret = resolveBindingSecret(binding);
    if (!validSecret(expectedSecret)) {
      return sendJson(res, 503, { error: "trigger_capability_secret_unconfigured" });
    }
    if (!authorized(req.headers.authorization, expectedSecret)) {
      return sendJson(res, 401, { error: "trigger_capability_unauthorized" });
    }
    if (!isAllowedContextUrl(payload.contextUrl)) {
      return sendJson(res, 422, { error: "trigger_capability_context_url_not_allowed" });
    }
    if (!isAllowedCallbackUrl(payload.callbackUrl)) {
      return sendJson(res, 422, { error: "trigger_capability_callback_url_not_allowed" });
    }
    try {
      const storedResult = inputRepository.saveOrGet({
        contractVersion: HR_TRAINING_CAPABILITY_RUN_INPUT_CONTRACT_VERSION,
        tenantScope,
        capability: payload.capability,
        idempotencyKey: payload.idempotencyKey,
        sessionId: payload.sessionId,
        meetingRecordId: payload.meetingRecordId,
        contextUrl: payload.contextUrl,
        callbackUrl: payload.callbackUrl,
      });
      const stored = storedResult.input;
      // The run input's first persisted timestamp is part of its immutable TriggerEvent identity.
      const event = capabilityRunTriggerEvent({ input: stored });
      const result = submissionService.submit({
        bindingId,
        event,
        sourceAdapterId: SOURCE_ADAPTER_ID,
      });
      inputRepository.bindTask({
        tenantScope,
        runInputId: stored.runInputId,
        triggerEventId: result.triggerEvent.triggerEventId,
        taskId: result.task.taskId,
      });
      return sendJson(res, 202, {
        runId: result.task.taskId,
        status: "PENDING",
        subcode: result.created ? "trigger_capability_accepted" : "trigger_capability_idempotent_replay",
      });
    } catch (error) {
      const code = safeErrorCode(error, "trigger_capability_accept_failed");
      const status = code.includes("idempotency_conflict") ? 409
        : code.includes("not_runnable") || code.includes("unavailable") ? 503
          : 422;
      return sendJson(res, status, { error: code });
    }
  }

  return Object.freeze({
    contractVersion: ROUTE_VERSION,
    handle,
  });
}

function normalizePayload(value) {
  requirePlainObject(value, "trigger capability payload");
  for (const field of Object.keys(value)) {
    if (!PAYLOAD_FIELDS.has(field)) throw routeError("trigger_capability_payload_field_not_allowed");
  }
  for (const field of ["callbackUrl", "capability", "idempotencyKey", "meetingRecordId", "sessionId"]) {
    if (!Object.hasOwn(value, field)) throw routeError("trigger_capability_payload_missing_field");
  }
  const contextUrl = normalizeContextUrl(value);
  return Object.freeze({
    capability: requiredToken(value.capability, "capability", 120),
    idempotencyKey: requiredToken(value.idempotencyKey, "idempotencyKey", 240),
    sessionId: requiredToken(value.sessionId, "sessionId", 160),
    meetingRecordId: requiredToken(value.meetingRecordId, "meetingRecordId", 160),
    contextUrl,
    callbackUrl: requiredUrl(value.callbackUrl, "callbackUrl", { scanSecretValue: false }),
  });
}

function normalizeContextUrl(value) {
  if (value.contextUrl === undefined || value.contextUrl === null) {
    throw routeError("trigger_capability_context_url_missing");
  }
  return requiredUrl(value.contextUrl, "contextUrl", { rejectCredentialQuery: true });
}

function capabilityRunTriggerEvent({ input }) {
  const timestamp = normalizedNow(input.createdAt);
  return Object.freeze({
    contractVersion: "trigger-event.v1",
    eventId: input.runInputId,
    eventType: input.capability,
    occurredAt: timestamp,
    sourceTenantId: "hr-train",
    subject: Object.freeze({
      objectApiName: "HrTrainingEvaluation",
      objectId: input.runInputId,
      approvalInstanceId: null,
      nodeApiName: null,
    }),
  });
}

function normalizeCapabilityBindings(value) {
  if (value instanceof Map) return new Map([...value.entries()].map(([capability, bindingId]) => [
    requiredToken(capability, "capability", 120),
    requiredToken(bindingId, "bindingId", 160),
  ]));
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("trigger capability route requires capabilityBindings");
  }
  return new Map(Object.entries(value).map(([capability, bindingId]) => [
    requiredToken(capability, "capability", 120),
    requiredToken(bindingId, "bindingId", 160),
  ]));
}

function defaultAllowedContextUrl(value) {
  return defaultAllowedUrl(value);
}

function defaultAllowedCallbackUrl(value) {
  return defaultAllowedUrl(value);
}

function defaultAllowedUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password && !url.hash;
  } catch {
    return false;
  }
}

function requiredUrl(value, field, { rejectCredentialQuery = false, scanSecretValue = true } = {}) {
  if (typeof value !== "string" || value !== value.trim() || !value || value.length > 4096 ||
    (scanSecretValue && SECRET_VALUE.test(value))) {
    throw routeError(`trigger_capability_${field}_invalid`);
  }
  let url;
  try {
    url = new URL(value);
  } catch {
    throw routeError(`trigger_capability_${field}_invalid`);
  }
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.hash) {
    throw routeError(`trigger_capability_${field}_invalid`);
  }
  if (rejectCredentialQuery) {
    for (const key of url.searchParams.keys()) {
      if (/(?:^|[-_])(api[-_]?key|access[-_]?token|authorization|bearer|credential|password|secret|token)(?:$|[-_])/i.test(key)) {
        throw routeError("trigger_capability_context_url_contains_credential");
      }
    }
  }
  return url.toString();
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

function normalizedNow(value) {
  const timestamp = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(timestamp.getTime())) throw routeError("trigger_capability_clock_invalid");
  return timestamp.toISOString();
}

function requirePlainObject(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(value))) {
    throw routeError("trigger_capability_payload_invalid", `${label} must be a plain object`);
  }
}

function requiredToken(value, field, maximum) {
  if (typeof value !== "string" || value !== value.trim() || !value ||
    value.length > maximum || !TOKEN.test(value) || SECRET_VALUE.test(value)) {
    throw routeError("trigger_capability_reference_invalid", field);
  }
  return value;
}

function assertDependencies(value) {
  if (typeof value.bindingRegistry?.get !== "function") throw new TypeError("trigger capability route requires bindingRegistry.get");
  if (typeof value.inputRepository?.saveOrGet !== "function") throw new TypeError("trigger capability route requires inputRepository.saveOrGet");
  if (typeof value.inputRepository?.bindTask !== "function") throw new TypeError("trigger capability route requires inputRepository.bindTask");
  if (typeof value.readJsonBody !== "function") throw new TypeError("trigger capability route requires readJsonBody");
  if (typeof value.resolveBindingSecret !== "function") throw new TypeError("trigger capability route requires resolveBindingSecret");
  if (typeof value.sendJson !== "function") throw new TypeError("trigger capability route requires sendJson");
  if (typeof value.submissionService?.submit !== "function") throw new TypeError("trigger capability route requires submissionService.submit");
  requiredToken(value.tenantScope, "tenantScope", 160);
}

function safeErrorCode(error, fallback) {
  const code = String(error?.code || "");
  return /^[a-z][a-z0-9_]{1,119}$/.test(code) ? code : fallback;
}

function routeError(code, message = code) {
  const error = new Error(message);
  error.code = code;
  return error;
}

export {
  DEFAULT_CAPABILITY_BINDINGS,
  ROUTE_VERSION as TRIGGER_CAPABILITY_RUN_ROUTE_VERSION,
  SOURCE_ADAPTER_ID as TRIGGER_CAPABILITY_RUN_SOURCE_ADAPTER_ID,
  createTriggerCapabilityRunHandlers,
};
