import {
  ClassifiedOperationEffectError,
  classifiedOperationEffectOutcome,
} from "../../agent-runtime/classified-operation-effect-error.mjs";

const SERVICE_CODES = Object.freeze({
  fxiaoke_crm_service_authentication_failed: "crm_writeback_authentication_failed",
  fxiaoke_crm_service_credential_unavailable: "crm_writeback_credential_unavailable",
  fxiaoke_crm_service_forbidden: "crm_writeback_authorization_failed",
  fxiaoke_crm_service_rate_limited: "crm_writeback_rate_limited",
  fxiaoke_crm_service_request_invalid: "crm_writeback_request_invalid",
  fxiaoke_crm_service_unavailable: "crm_writeback_service_unavailable",
  fxiaoke_crm_service_upstream_rejected: "crm_writeback_upstream_rejected",
});

const DEFINITIVE_ADAPTER_CODES = new Set([
  "crm_review_writeback_binding_mismatch",
  "crm_review_writeback_comment_invalid",
  "crm_review_writeback_confirmation_mismatch",
  "crm_review_writeback_confirmation_missing",
  "crm_review_writeback_completion_invalid",
  "crm_review_writeback_event_invalid",
  "crm_review_writeback_event_order_conflict",
  "crm_review_writeback_idempotency_conflict",
  "crm_review_writeback_read_failed",
  "crm_review_writeback_receipt_invalid",
  "crm_review_writeback_record_unavailable",
  "crm_review_writeback_reference_invalid",
  "crm_review_writeback_subject_invalid",
]);

const UNKNOWN_ADAPTER_CODES = Object.freeze({
  crm_review_writeback_confirmation_response_invalid:
    "crm_writeback_confirmation_response_invalid",
});

function classifyFxiaokeTriggerWritebackError(error) {
  const classified = classifiedOperationEffectOutcome(error);
  if (classified) {
    return new ClassifiedOperationEffectError({
      status: classified.status,
      safeResultCode: stableServiceCode(classified),
    });
  }
  if (error?.code === "crm_review_writeback_failed") {
    return new ClassifiedOperationEffectError({
      status: "definitive_failed",
      safeResultCode: "crm_writeback_upstream_rejected",
    });
  }
  if (DEFINITIVE_ADAPTER_CODES.has(error?.code)) {
    return new ClassifiedOperationEffectError({
      status: "definitive_failed",
      safeResultCode: error.code,
    });
  }
  if (UNKNOWN_ADAPTER_CODES[error?.code]) {
    return new ClassifiedOperationEffectError({
      status: "unknown",
      safeResultCode: UNKNOWN_ADAPTER_CODES[error.code],
    });
  }
  return null;
}

function stableServiceCode({ safeResultCode, status }) {
  if (safeResultCode === "fxiaoke_crm_unlock_outcome_unknown") {
    return "crm_writeback_unlock_outcome_unknown";
  }
  if (safeResultCode === "fxiaoke_crm_relock_outcome_unknown") {
    return "crm_writeback_relock_outcome_unknown";
  }
  if (safeResultCode === "fxiaoke_crm_relock_after_unlock_unknown_outcome_unknown") {
    return "crm_writeback_relock_outcome_unknown";
  }
  if (SERVICE_CODES[safeResultCode]) return SERVICE_CODES[safeResultCode];
  const rejectedCode = /^fxiaoke_crm_service_upstream_rejected_([0-9]{1,20})$/.exec(safeResultCode);
  if (rejectedCode) {
    return status === "unknown"
      ? `crm_writeback_upstream_outcome_unknown_${rejectedCode[1]}`
      : `crm_writeback_upstream_rejected_${rejectedCode[1]}`;
  }
  if (safeResultCode === "fxiaoke_crm_service_writeback_confirmation_response_invalid") {
    return "crm_writeback_confirmation_response_invalid";
  }
  if (safeResultCode === "fxiaoke_crm_service_request_timeout") {
    return status === "unknown" ? "crm_writeback_timeout_after_dispatch" : "crm_writeback_read_timeout";
  }
  if (safeResultCode === "fxiaoke_crm_service_response_invalid") {
    return status === "unknown"
      ? "crm_writeback_response_invalid_after_dispatch"
      : "crm_writeback_read_response_invalid";
  }
  if (safeResultCode === "fxiaoke_crm_service_response_too_large") {
    return status === "unknown"
      ? "crm_writeback_response_too_large_after_dispatch"
      : "crm_writeback_read_response_too_large";
  }
  if (safeResultCode === "fxiaoke_crm_service_request_cancelled") {
    return status === "unknown" ? "crm_writeback_cancelled_after_dispatch" : "crm_writeback_read_cancelled";
  }
  if (safeResultCode === "fxiaoke_crm_service_upstream_error") {
    return status === "unknown" ? "crm_writeback_network_or_upstream_unknown" : "crm_writeback_read_failed";
  }
  return status === "unknown" ? "crm_writeback_outcome_unknown" : "crm_writeback_failed";
}

export { classifyFxiaokeTriggerWritebackError };
