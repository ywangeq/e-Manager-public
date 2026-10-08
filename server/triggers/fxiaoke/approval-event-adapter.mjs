const FXIAOKE_APPROVAL_EVENT_CONTRACT_VERSION = "fxiaoke-approval-event.v1";
const FXIAOKE_APPROVAL_EVENT_ADAPTER_ID = "fxiaoke-approval-event.v1";
const ALLOWED_FIELDS = new Set([
  "contractVersion",
  "eventId",
  "eventType",
  "occurredAt",
  "sourceTenantId",
  "subject",
]);

function createFxiaokeApprovalEventAdapter({ normalizeTriggerEvent } = {}) {
  if (typeof normalizeTriggerEvent !== "function") {
    throw new TypeError("fxiaoke approval adapter requires normalizeTriggerEvent");
  }

  function adapt(payload = {}) {
    requirePlainObject(payload);
    const unknown = Object.keys(payload).find((field) => !ALLOWED_FIELDS.has(field));
    if (unknown) throw adapterError("fxiaoke_approval_event_unknown_field");
    if (payload.contractVersion !== FXIAOKE_APPROVAL_EVENT_CONTRACT_VERSION) {
      throw adapterError("fxiaoke_approval_event_contract_invalid");
    }
    return normalizeTriggerEvent({
      contractVersion: "trigger-event.v1",
      eventId: payload.eventId,
      eventType: payload.eventType,
      occurredAt: normalizeOccurredAt(payload.occurredAt),
      sourceTenantId: payload.sourceTenantId,
      subject: payload.subject,
    });
  }

  return Object.freeze({
    adapterId: FXIAOKE_APPROVAL_EVENT_ADAPTER_ID,
    adapt,
  });
}

function normalizeOccurredAt(value) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw adapterError("fxiaoke_approval_event_timestamp_invalid");
  }
  const timestamp = new Date(value);
  if (!Number.isFinite(timestamp.getTime())) {
    throw adapterError("fxiaoke_approval_event_timestamp_invalid");
  }
  return timestamp.toISOString();
}

function requirePlainObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
    (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)) {
    throw adapterError("fxiaoke_approval_event_invalid");
  }
}

function adapterError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

export {
  FXIAOKE_APPROVAL_EVENT_ADAPTER_ID,
  FXIAOKE_APPROVAL_EVENT_CONTRACT_VERSION,
  createFxiaokeApprovalEventAdapter,
};
