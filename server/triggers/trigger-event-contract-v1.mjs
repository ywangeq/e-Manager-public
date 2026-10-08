const TRIGGER_EVENT_CONTRACT_VERSION = "trigger-event.v1";

const TRIGGER_EVENT_ERROR_CODES = Object.freeze({
  CONTRACT_VERSION_INVALID: "trigger_event_contract_version_invalid",
  FIELD_NOT_ALLOWED: "trigger_event_field_not_allowed",
  REFERENCE_INVALID: "trigger_event_reference_invalid",
  SENSITIVE_FIELD_FORBIDDEN: "trigger_event_sensitive_field_forbidden",
  SENSITIVE_VALUE_FORBIDDEN: "trigger_event_sensitive_value_forbidden",
  SUBJECT_INVALID: "trigger_event_subject_invalid",
  TIMESTAMP_INVALID: "trigger_event_timestamp_invalid",
  VALUE_INVALID: "trigger_event_value_invalid",
});

const EVENT_FIELDS = new Set([
  "contractVersion",
  "eventId",
  "eventType",
  "occurredAt",
  "sourceTenantId",
  "subject",
]);
const REQUIRED_EVENT_FIELDS = EVENT_FIELDS;
const SUBJECT_FIELDS = new Set([
  "approvalInstanceId",
  "nodeApiName",
  "objectApiName",
  "objectId",
]);
const REQUIRED_SUBJECT_FIELDS = new Set(["objectApiName", "objectId"]);
const SENSITIVE_FIELD_PATTERN = /(?:authorization|bearer|body|credential|employeeid|message|password|path|prompt|raw|secret|skillid|tasktype|text|token|tool)/i;
const SAFE_OPAQUE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:@-]*$/;
const EMAIL_VALUE_PATTERN = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const PHONE_VALUE_PATTERN = /^(?:\+?86[- ]?)?1[3-9]\d{9}$/;
const NATIONAL_ID_VALUE_PATTERN = /^\d{17}[\dXx]$/;
const HOST_PATH_VALUE_PATTERN = /^(?:\/|~[\\/]|[A-Za-z]:[\\/]|\\\\)|[\\/]/;
const SECRET_VALUE_PATTERN = /^(?:bearer[\s._:-]*|sk-|rk-|xox[baprs]-|gh[pousr]_|glpat-|ya29\.|eyJ)[A-Za-z0-9._~+/=-]{8,}$/i;

class TriggerEventContractError extends Error {
  constructor(code, message = code, field = null) {
    super(message);
    this.name = "TriggerEventContractError";
    this.code = code;
    this.field = field;
  }
}

function normalizeTriggerEventV1(value) {
  requirePlainObject(value, "trigger event");
  requireExactFields(value, EVENT_FIELDS, REQUIRED_EVENT_FIELDS, "trigger event");
  if (value.contractVersion !== TRIGGER_EVENT_CONTRACT_VERSION) {
    throw triggerEventError(
      TRIGGER_EVENT_ERROR_CODES.CONTRACT_VERSION_INVALID,
      `contractVersion must equal ${TRIGGER_EVENT_CONTRACT_VERSION}`,
      "contractVersion",
    );
  }

  return deepFreeze({
    contractVersion: TRIGGER_EVENT_CONTRACT_VERSION,
    eventId: requiredOpaqueId(value.eventId, "eventId", 180),
    eventType: requiredOpaqueId(value.eventType, "eventType", 120),
    occurredAt: requiredTimestamp(value.occurredAt),
    sourceTenantId: requiredOpaqueId(value.sourceTenantId, "sourceTenantId", 160),
    subject: normalizeSubject(value.subject),
  });
}

const normalizeTriggerEvent = normalizeTriggerEventV1;

function normalizeSubject(value) {
  requirePlainObject(value, "subject", TRIGGER_EVENT_ERROR_CODES.SUBJECT_INVALID);
  requireExactFields(value, SUBJECT_FIELDS, REQUIRED_SUBJECT_FIELDS, "subject");
  return {
    objectApiName: requiredOpaqueId(value.objectApiName, "subject.objectApiName", 120),
    objectId: requiredOpaqueId(value.objectId, "subject.objectId", 180),
    approvalInstanceId: optionalOpaqueId(value.approvalInstanceId, "subject.approvalInstanceId", 180),
    nodeApiName: optionalOpaqueId(value.nodeApiName, "subject.nodeApiName", 120),
  };
}

function requireExactFields(value, allowedFields, requiredFields, label) {
  for (const field of Object.keys(value)) {
    if (!allowedFields.has(field)) {
      const code = SENSITIVE_FIELD_PATTERN.test(field)
        ? TRIGGER_EVENT_ERROR_CODES.SENSITIVE_FIELD_FORBIDDEN
        : TRIGGER_EVENT_ERROR_CODES.FIELD_NOT_ALLOWED;
      throw triggerEventError(code, `${label} contains an unsupported field`, field);
    }
  }
  const missing = [...requiredFields].find((field) => !Object.hasOwn(value, field));
  if (missing) {
    const code = label === "subject"
      ? TRIGGER_EVENT_ERROR_CODES.SUBJECT_INVALID
      : TRIGGER_EVENT_ERROR_CODES.VALUE_INVALID;
    throw triggerEventError(code, `${label} is missing a required field`, missing);
  }
}

function requiredOpaqueId(value, field, maxLength) {
  if (typeof value !== "string" || value !== value.trim() || !value || value.length > maxLength) {
    throw triggerEventError(
      TRIGGER_EVENT_ERROR_CODES.REFERENCE_INVALID,
      `${field} must be a bounded opaque identifier`,
      field,
    );
  }
  rejectSensitiveValue(value, field);
  if (!SAFE_OPAQUE_ID_PATTERN.test(value)) {
    throw triggerEventError(
      TRIGGER_EVENT_ERROR_CODES.REFERENCE_INVALID,
      `${field} must be a bounded opaque identifier`,
      field,
    );
  }
  return value;
}

function optionalOpaqueId(value, field, maxLength) {
  if (value === undefined || value === null || value === "") return null;
  return requiredOpaqueId(value, field, maxLength);
}

function rejectSensitiveValue(value, field) {
  if (EMAIL_VALUE_PATTERN.test(value) || PHONE_VALUE_PATTERN.test(value) ||
    NATIONAL_ID_VALUE_PATTERN.test(value) || HOST_PATH_VALUE_PATTERN.test(value) ||
    SECRET_VALUE_PATTERN.test(value)) {
    throw triggerEventError(
      TRIGGER_EVENT_ERROR_CODES.SENSITIVE_VALUE_FORBIDDEN,
      `${field} must be an opaque identifier, not PII, a credential, or a path`,
      field,
    );
  }
}

function requiredTimestamp(value) {
  if (typeof value !== "string" || value !== value.trim() || !value) {
    throw triggerEventError(
      TRIGGER_EVENT_ERROR_CODES.TIMESTAMP_INVALID,
      "occurredAt must be an ISO timestamp",
      "occurredAt",
    );
  }
  const timestamp = new Date(value);
  if (!Number.isFinite(timestamp.getTime()) || timestamp.toISOString() !== value) {
    throw triggerEventError(
      TRIGGER_EVENT_ERROR_CODES.TIMESTAMP_INVALID,
      "occurredAt must be a canonical ISO timestamp",
      "occurredAt",
    );
  }
  return value;
}

function requirePlainObject(value, label, code = TRIGGER_EVENT_ERROR_CODES.VALUE_INVALID) {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(value))) {
    throw triggerEventError(code, `${label} must be a plain object`);
  }
}

function deepFreeze(value) {
  Object.freeze(value);
  for (const item of Object.values(value)) {
    if (item && typeof item === "object" && !Object.isFrozen(item)) deepFreeze(item);
  }
  return value;
}

function triggerEventError(code, message, field = null) {
  return new TriggerEventContractError(code, message, field);
}

export {
  TRIGGER_EVENT_CONTRACT_VERSION,
  TRIGGER_EVENT_ERROR_CODES,
  TriggerEventContractError,
  normalizeTriggerEvent,
  normalizeTriggerEventV1,
};
