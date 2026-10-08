import crypto from "node:crypto";
import { ClassifiedOperationEffectError, classifiedOperationEffectOutcome } from
  "../../agent-runtime/classified-operation-effect-error.mjs";
import { FXIAOKE_CRM_LOCKED_OBJECT_ERROR_MESSAGE } from
  "../../agent-runtime/fxiaoke-crm-service-client.mjs";

const ADAPTER_VERSION = "fxiaoke-trigger-object-review-writeback-adapter.v4";
const RECEIPT_VERSION = "trigger-review-writeback-receipt.v1";
const CUSTOM_FIND_ONE_PATH = "/cgi/crm/custom/v2/data/findOne";
const CUSTOM_UPDATE_PATH = "/cgi/crm/custom/v2/data/update";
const PRESET_GET_PATH = "/cgi/crm/v2/data/get";
const PRESET_UPDATE_PATH = "/cgi/crm/v2/data/update";
const OBJECT_LOCK_PATH = "/cgi/crm/v2/object/lock";
const OBJECT_UNLOCK_PATH = "/cgi/crm/v2/object/unlock";
const OPAQUE_REFERENCE = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,239}$/;
const SAFE_CODE = /^[a-z][a-z0-9_]{1,159}$/;

function createFxiaokeTriggerObjectReviewWritebackAdapter({
  diagnosticLogger = null,
  now = () => Date.now(),
  requestJson,
} = {}) {
  if (typeof requestJson !== "function") throw new TypeError("Fxiaoke writeback adapter requires requestJson");
  if (diagnosticLogger !== null && typeof diagnosticLogger !== "function") {
    throw new TypeError("Fxiaoke writeback adapter diagnosticLogger must be a function");
  }
  if (typeof now !== "function") throw new TypeError("Fxiaoke writeback adapter now must be a function");

  async function writeReview({
    binding,
    completedAt,
    event,
    reviewComment,
    signal = null,
    subject,
    taskRef = "",
  } = {}) {
    const safeSubject = normalizeSubject(subject);
    assertBinding(binding, safeSubject);
    const candidate = normalizeCandidate({ binding, completedAt, event, reviewComment });
    const diagnosticContext = Object.freeze({
      eventRef: candidate.receipt.eventId,
      taskRef: optionalReference(taskRef),
      transportKind: binding.recordReadMode === "preset_get_by_id" ? "preset_object" : "custom_object",
    });
    const current = await observedReadCurrent({
      action: "read_trigger_review_writeback",
      binding,
      diagnosticContext,
      signal,
      stage: "pre_read",
      subject: safeSubject,
    });
    const disposition = compareCurrent(current, candidate);
    if (disposition) {
      emitDiagnostic(diagnosticContext, {
        outcome: disposition.status,
        stage: "pre_read_disposition",
      });
      return disposition;
    }

    let relockRequired = false;
    if ((binding.objectLockPolicy || "none") === "unlock_current_then_relock") {
      const lockStatus = await observedReadLockStatus({
        binding,
        diagnosticContext,
        signal,
        subject: safeSubject,
      });
      if (lockStatus === "1") {
        try {
          await mutateObjectLock({
            action: "unlock_trigger_review_subject",
            binding,
            diagnosticContext,
            pathname: OBJECT_UNLOCK_PATH,
            signal,
            stage: "unlock",
            subject: safeSubject,
            expectedLockStatus: "0",
          });
          relockRequired = true;
        } catch (error) {
          if (classifiedOperationEffectOutcome(error)?.status === "unknown") {
            await bestEffortRelock({ binding, diagnosticContext, signal, subject: safeSubject });
          }
          throw error;
        }
      } else if (lockStatus !== "0") {
        throw writebackError("crm_review_writeback_lock_status_unavailable");
      }
    }

    try {
      const presetObject = binding.updateMode === "preset_object_update_by_id";
    const updateStartedAt = timestamp(now);
    try {
      const response = await requestJson({
        action: "write_trigger_review_result",
        pathname: presetObject ? PRESET_UPDATE_PATH : CUSTOM_UPDATE_PATH,
        body: {
          triggerWorkFlow: false,
          data: {
            ...(presetObject ? { details: {} } : { skipDataStatusValidate: false }),
            object_data: {
              dataObjectApiName: binding.sourceObjectApiName,
              _id: safeSubject.objectId,
              [binding.commentFieldApiName]: candidate.reviewComment,
              [binding.receiptFieldApiName]: JSON.stringify(candidate.receipt),
            },
          },
        },
        signal,
      });
      assertSuccessfulResponse(response, "crm_review_writeback_failed");
      emitDiagnostic(diagnosticContext, {
        durationMs: elapsedMs(updateStartedAt, now),
        outcome: "accepted",
        stage: "update",
      });
    } catch (error) {
      const classified = classifiedOperationEffectOutcome(error);
      emitDiagnostic(diagnosticContext, {
        durationMs: elapsedMs(updateStartedAt, now),
        outcome: classified?.status || "failed",
        safeCode: safeErrorCode(error),
        stage: "update",
        upstream: safeUpstreamDiagnostic(error),
      });
      if (classified?.status !== "unknown") throw error;
      try {
        const recovered = await observedReadCurrent({
          action: "confirm_trigger_review_writeback",
          binding,
          diagnosticContext,
          signal,
          stage: "confirm_after_unknown",
          subject: safeSubject,
        });
        assertConfirmedWrite(recovered, candidate);
        emitDiagnostic(diagnosticContext, {
          outcome: "confirmed",
          stage: "confirm_after_unknown_match",
        });
        return confirmedDisposition(candidate);
      } catch (confirmationError) {
        emitConfirmationFailure(diagnosticContext, "confirm_after_unknown_match", confirmationError);
        throw error;
      }
    }
    const confirmed = await observedReadCurrent({
      action: "confirm_trigger_review_writeback",
      binding,
      diagnosticContext,
      signal,
      stage: "confirm_after_accept",
      subject: safeSubject,
    });
    try {
      assertConfirmedWrite(confirmed, candidate);
      emitDiagnostic(diagnosticContext, {
        outcome: "confirmed",
        stage: "confirm_after_accept_match",
      });
    } catch (error) {
      emitConfirmationFailure(diagnosticContext, "confirm_after_accept_match", error);
      throw error;
    }
    return confirmedDisposition(candidate);
    } finally {
      if (relockRequired) {
        try {
          await mutateObjectLock({
            action: "lock_trigger_review_subject",
            binding,
            diagnosticContext,
            pathname: OBJECT_LOCK_PATH,
            signal: null,
            stage: "relock",
            subject: safeSubject,
            expectedLockStatus: "1",
          });
        } catch {
          throw mutationOutcomeUnknown("relock");
        }
      }
    }
  }

  async function recoverReview({
    binding,
    completedAt,
    event,
    reviewComment,
    signal = null,
    subject,
    taskRef = "",
  } = {}) {
    const safeSubject = normalizeSubject(subject);
    assertBinding(binding, safeSubject);
    const candidate = normalizeCandidate({ binding, completedAt, event, reviewComment });
    const diagnosticContext = Object.freeze({
      eventRef: candidate.receipt.eventId,
      taskRef: optionalReference(taskRef),
      transportKind: binding.recordReadMode === "preset_get_by_id" ? "preset_object" : "custom_object",
    });
    const current = await observedReadCurrent({
      action: "confirm_trigger_review_writeback",
      binding,
      diagnosticContext,
      signal,
      stage: "recovery_read",
      subject: safeSubject,
    });
    let disposition = null;
    try {
      disposition = compareCurrent(current, candidate);
    } catch {
      disposition = null;
    }
    if ((binding.objectLockPolicy || "none") === "unlock_current_then_relock") {
      const lockStatus = await observedReadLockStatus({
        binding,
        diagnosticContext,
        signal,
        stage: "recovery_lock_status",
        subject: safeSubject,
      });
      if (lockStatus === "0") {
        await mutateObjectLock({
          action: "lock_trigger_review_subject",
          binding,
          diagnosticContext,
          expectedLockStatus: "1",
          pathname: OBJECT_LOCK_PATH,
          signal: null,
          stage: "recovery_relock",
          subject: safeSubject,
        });
      } else if (lockStatus !== "1") {
        throw mutationOutcomeUnknown("recovery_relock");
      }
    }
    if (disposition?.status === "duplicate") return disposition;
    throw mutationOutcomeUnknown("recovery");
  }

  async function observedReadLockStatus({ binding, diagnosticContext, signal, stage = "lock_status",
    subject }) {
    const startedAt = timestamp(now);
    try {
      const response = await requestJson({
        action: "read_trigger_review_lock_status",
        pathname: PRESET_GET_PATH,
        body: {
          includeNull: true,
          data: {
            dataObjectApiName: binding.sourceObjectApiName,
            objectDataId: subject.objectId,
          },
        },
        signal,
      });
      assertSuccessfulResponse(response, "crm_review_writeback_lock_status_read_failed");
      if (!isPlainObject(response.data) || response.data._id !== subject.objectId) {
        throw writebackError("crm_review_writeback_lock_status_unavailable");
      }
      const lockStatus = normalizeLockStatus(response.data.lock_status);
      emitDiagnostic(diagnosticContext, {
        durationMs: elapsedMs(startedAt, now),
        outcome: lockStatus === "1" ? "locked" : lockStatus === "0" ? "unlocked" : "unknown",
        stage,
      });
      return lockStatus;
    } catch (error) {
      emitDiagnostic(diagnosticContext, {
        durationMs: elapsedMs(startedAt, now),
        outcome: "read_failed",
        safeCode: safeErrorCode(error),
        stage,
      });
      throw error;
    }
  }

  async function mutateObjectLock({ action, binding, diagnosticContext, expectedLockStatus, pathname,
    signal, stage, subject }) {
    const startedAt = timestamp(now);
    let accepted = false;
    try {
      const response = await requestJson({
        action,
        pathname,
        body: {
          data: {
            dataObjectApiName: binding.sourceObjectApiName,
            dataIds: [subject.objectId],
            detailObjStrategy: 0,
          },
        },
        signal,
      });
      assertSuccessfulResponse(response, `crm_review_writeback_${stage}_failed`);
      accepted = true;
      emitDiagnostic(diagnosticContext, {
        durationMs: elapsedMs(startedAt, now),
        outcome: "accepted",
        stage,
      });
      const confirmedStatus = await observedReadLockStatus({
        binding,
        diagnosticContext,
        signal,
        stage: `${stage}_confirm`,
        subject,
      });
      if (confirmedStatus !== expectedLockStatus) throw mutationOutcomeUnknown(stage);
    } catch (error) {
      emitDiagnostic(diagnosticContext, {
        durationMs: elapsedMs(startedAt, now),
        outcome: classifiedOperationEffectOutcome(error)?.status || "failed",
        safeCode: safeErrorCode(error),
        stage,
        upstream: safeUpstreamDiagnostic(error),
      });
      throw accepted ? mutationOutcomeUnknown(stage) : error;
    }
  }

  async function bestEffortRelock({ binding, diagnosticContext, signal, subject }) {
    try {
      await mutateObjectLock({
        action: "lock_trigger_review_subject",
        binding,
        diagnosticContext,
        pathname: OBJECT_LOCK_PATH,
        signal: null,
        stage: "relock_after_unlock_unknown",
        subject,
        expectedLockStatus: "1",
      });
    } catch {
      // Preserve the original unknown unlock outcome.
    }
  }

  async function observedReadCurrent({ action, binding, diagnosticContext, signal, stage, subject }) {
    const startedAt = timestamp(now);
    try {
      const current = await readCurrent({ action, binding, signal, subject });
      emitDiagnostic(diagnosticContext, {
        durationMs: elapsedMs(startedAt, now),
        outcome: current ? "present" : "missing",
        stage,
      });
      return current;
    } catch (error) {
      emitDiagnostic(diagnosticContext, {
        durationMs: elapsedMs(startedAt, now),
        outcome: "read_failed",
        safeCode: safeErrorCode(error),
        stage,
      });
      throw error;
    }
  }

  function emitConfirmationFailure(context, stage, error) {
    const safeCode = safeErrorCode(error);
    const outcome = safeCode === "crm_review_writeback_confirmation_missing"
      ? "missing"
      : safeCode === "crm_review_writeback_confirmation_mismatch"
        ? "mismatch"
        : "failed";
    emitDiagnostic(context, { outcome, safeCode, stage });
  }

  function emitDiagnostic(context, detail) {
    if (!diagnosticLogger) return;
    const record = Object.freeze({
      contractVersion: "fxiaoke-writeback-diagnostic.v2",
      adapterId: ADAPTER_VERSION,
      eventRef: context.eventRef,
      taskRef: context.taskRef,
      transportKind: context.transportKind,
      stage: detail.stage,
      outcome: detail.outcome,
      ...(detail.safeCode ? { safeCode: detail.safeCode } : {}),
      ...(Number.isInteger(detail.durationMs) ? { durationMs: detail.durationMs } : {}),
      ...(detail.upstream || {}),
    });
    try {
      diagnosticLogger(record);
    } catch {
      // Diagnostics must never change writeback behavior.
    }
  }

  function safeUpstreamDiagnostic(error) {
    const upstream = error?.upstreamDiagnostic;
    if (!isPlainObject(upstream)) return null;
    const httpStatus = Number(upstream.httpStatus);
    const errorCode = String(upstream.errorCode || "");
    const errorMessage = String(upstream.errorMessage || "");
    if (!Number.isInteger(httpStatus) || httpStatus < 100 || httpStatus > 599 ||
      !/^[0-9]{1,20}$/.test(errorCode)) return null;
    return Object.freeze({
      httpStatus,
      upstreamErrorCode: errorCode,
      ...(errorCode === "50009" && errorMessage === FXIAOKE_CRM_LOCKED_OBJECT_ERROR_MESSAGE
        ? { upstreamErrorMessage: errorMessage }
        : {}),
    });
  }

  async function readCurrent({ action = "read_trigger_review_writeback", binding, signal, subject }) {
    const confirming = action === "confirm_trigger_review_writeback";
    const presetObject = binding.recordReadMode === "preset_get_by_id";
    const response = await requestJson({
      action,
      pathname: presetObject ? PRESET_GET_PATH : CUSTOM_FIND_ONE_PATH,
      body: presetObject ? {
        includeNull: true,
        data: {
          dataObjectApiName: binding.sourceObjectApiName,
          objectDataId: subject.objectId,
        },
      } : {
        includeNull: true,
        data: {
          dataObjectApiName: binding.sourceObjectApiName,
          search_query_info: {
            filters: [{
              field_name: "_id",
              field_values: [subject.objectId],
              operator: "EQ",
            }],
          },
          field_projection: ["_id", binding.commentFieldApiName, binding.receiptFieldApiName],
        },
      },
      signal,
    });
    assertSuccessfulResponse(response, confirming
      ? "crm_review_writeback_confirmation_response_invalid"
      : "crm_review_writeback_read_failed");
    const objectData = presetObject ? response.data : response.data?.objectData;
    if (!isPlainObject(objectData) || objectData._id !== subject.objectId) {
      throw writebackError(confirming
        ? "crm_review_writeback_confirmation_response_invalid"
        : "crm_review_writeback_record_unavailable");
    }
    const receiptValue = objectData[binding.receiptFieldApiName];
    if (receiptValue === null || receiptValue === undefined || receiptValue === "") return null;
    let receipt;
    try {
      receipt = parseReceipt(receiptValue);
    } catch (error) {
      if (confirming && error?.code === "crm_review_writeback_receipt_invalid") {
        throw writebackError("crm_review_writeback_confirmation_mismatch");
      }
      throw error;
    }
    const commentValue = objectData[binding.commentFieldApiName];
    if (confirming && (commentValue === null || commentValue === undefined || commentValue === "")) {
      throw writebackError("crm_review_writeback_confirmation_missing");
    }
    let currentComment;
    try {
      currentComment = normalizeStoredComment(commentValue, binding.maxCommentChars);
    } catch (error) {
      if (confirming && error?.code === "crm_review_writeback_receipt_invalid") {
        throw writebackError("crm_review_writeback_confirmation_mismatch");
      }
      throw error;
    }
    return Object.freeze({ receipt, currentComment });
  }

  return Object.freeze({ adapterId: ADAPTER_VERSION, recoverReview, writeReview });
}

function confirmedDisposition(candidate) {
  return Object.freeze({
    status: "written_confirmed",
    eventId: candidate.receipt.eventId,
    commentDigest: candidate.receipt.commentDigest,
    receiptVersion: RECEIPT_VERSION,
  });
}

function normalizeCandidate({ binding, completedAt, event, reviewComment }) {
  if (!isPlainObject(event) || event.contractVersion !== "trigger-event.v1") {
    throw writebackError("crm_review_writeback_event_invalid");
  }
  const eventId = reference(event.eventId);
  const occurredAt = isoTimestamp(event.occurredAt, "crm_review_writeback_event_invalid");
  const normalizedCompletedAt = isoTimestamp(completedAt, "crm_review_writeback_completion_invalid");
  if (Date.parse(normalizedCompletedAt) < Date.parse(occurredAt)) {
    throw writebackError("crm_review_writeback_completion_invalid");
  }
  const comment = boundedComment(reviewComment, binding.maxCommentChars);
  const commentDigest = sha256(comment);
  return Object.freeze({
    reviewComment: comment,
    receipt: Object.freeze({
      contractVersion: RECEIPT_VERSION,
      eventId,
      occurredAt,
      completedAt: normalizedCompletedAt,
      commentDigest,
    }),
  });
}

function compareCurrent(current, candidate) {
  if (!current) return null;
  const existing = current.receipt;
  const incoming = candidate.receipt;
  if (existing.eventId === incoming.eventId) {
    if (existing.commentDigest !== incoming.commentDigest || sha256(current.currentComment) !== incoming.commentDigest) {
      throw writebackError("crm_review_writeback_idempotency_conflict");
    }
    return Object.freeze({
      status: "duplicate",
      eventId: incoming.eventId,
      commentDigest: incoming.commentDigest,
      receiptVersion: RECEIPT_VERSION,
    });
  }
  const existingTime = Date.parse(existing.occurredAt);
  const incomingTime = Date.parse(incoming.occurredAt);
  if (existingTime > incomingTime) {
    return Object.freeze({
      status: "stale_skipped",
      eventId: incoming.eventId,
      commentDigest: incoming.commentDigest,
      receiptVersion: RECEIPT_VERSION,
    });
  }
  if (existingTime === incomingTime) {
    throw writebackError("crm_review_writeback_event_order_conflict");
  }
  return null;
}

function assertConfirmedWrite(current, candidate) {
  if (!current) throw writebackError("crm_review_writeback_confirmation_missing");
  if (current.receipt.eventId !== candidate.receipt.eventId ||
    current.receipt.commentDigest !== candidate.receipt.commentDigest ||
    sha256(current.currentComment) !== candidate.receipt.commentDigest) {
    throw writebackError("crm_review_writeback_confirmation_mismatch");
  }
}

function parseReceipt(value) {
  if (typeof value !== "string" || value.length > 1_000) {
    throw writebackError("crm_review_writeback_receipt_invalid");
  }
  let parsed;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw writebackError("crm_review_writeback_receipt_invalid");
  }
  const fields = ["commentDigest", "completedAt", "contractVersion", "eventId", "occurredAt"];
  if (!isPlainObject(parsed) || Object.keys(parsed).length !== fields.length ||
    fields.some((field) => !Object.hasOwn(parsed, field)) || parsed.contractVersion !== RECEIPT_VERSION ||
    !/^[a-f0-9]{64}$/.test(String(parsed.commentDigest || ""))) {
    throw writebackError("crm_review_writeback_receipt_invalid");
  }
  const occurredAt = isoTimestamp(parsed.occurredAt, "crm_review_writeback_receipt_invalid");
  const completedAt = isoTimestamp(parsed.completedAt, "crm_review_writeback_receipt_invalid");
  if (Date.parse(completedAt) < Date.parse(occurredAt)) {
    throw writebackError("crm_review_writeback_receipt_invalid");
  }
  return Object.freeze({
    contractVersion: RECEIPT_VERSION,
    eventId: reference(parsed.eventId),
    occurredAt,
    completedAt,
    commentDigest: parsed.commentDigest,
  });
}

function assertBinding(binding, subject) {
  if (!isPlainObject(binding) ||
    !["trigger-writeback-binding.v1", "trigger-writeback-binding.v2"].includes(binding.contractVersion) ||
    binding.enabled !== true || binding.reviewStatus !== "approved" ||
    !((binding.recordReadMode === "custom_find_one_by_id" &&
      binding.updateMode === "custom_object_update_by_id") ||
      (binding.recordReadMode === "preset_get_by_id" &&
        binding.updateMode === "preset_object_update_by_id")) || binding.triggerWorkflow !== false ||
    !["none", "unlock_current_then_relock"].includes(binding.objectLockPolicy || "none") ||
    binding.sourceSystemId !== "fxiaoke-crm" || binding.sourceObjectApiName !== subject.objectApiName) {
    throw writebackError("crm_review_writeback_binding_mismatch");
  }
}

function normalizeLockStatus(value) {
  if (value === 0 || value === "0") return "0";
  if (value === 1 || value === "1") return "1";
  return null;
}

function mutationOutcomeUnknown(stage) {
  return new ClassifiedOperationEffectError({
    status: "unknown",
    safeResultCode: `fxiaoke_crm_${stage}_outcome_unknown`,
  });
}

function assertSuccessfulResponse(response, code) {
  if (!isPlainObject(response) || (response.errorCode !== 0 && response.errorCode !== "0")) {
    throw writebackError(code);
  }
}

function normalizeSubject(value) {
  if (!isPlainObject(value) || Object.keys(value).some((field) =>
    !["approvalInstanceId", "nodeApiName", "objectApiName", "objectId"].includes(field))) {
    throw writebackError("crm_review_writeback_subject_invalid");
  }
  return Object.freeze({
    objectApiName: reference(value.objectApiName),
    objectId: reference(value.objectId),
  });
}

function boundedComment(value, maximum) {
  if (typeof value !== "string" || value !== value.trim() || !value || value.length > maximum ||
    /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/.test(value)) {
    throw writebackError("crm_review_writeback_comment_invalid");
  }
  return value;
}

function normalizeStoredComment(value, maximum) {
  if (typeof value !== "string" || !value || value.length > maximum) {
    throw writebackError("crm_review_writeback_receipt_invalid");
  }
  return value;
}

function isoTimestamp(value, code) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) ||
    !Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value) {
    throw writebackError(code);
  }
  return value;
}

function reference(value) {
  const text = String(value || "").trim();
  if (!OPAQUE_REFERENCE.test(text)) throw writebackError("crm_review_writeback_reference_invalid");
  return text;
}

function optionalReference(value) {
  if (value === "" || value === null || value === undefined) return "";
  return reference(value);
}

function safeErrorCode(error) {
  const code = String(error?.code || "");
  return SAFE_CODE.test(code) ? code : "fxiaoke_writeback_unclassified_error";
}

function timestamp(now) {
  const value = Number(now());
  return Number.isFinite(value) ? value : Date.now();
}

function elapsedMs(startedAt, now) {
  return Math.max(0, Math.round(timestamp(now) - startedAt));
}

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value) &&
    [Object.prototype, null].includes(Object.getPrototypeOf(value));
}

function writebackError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

export {
  ADAPTER_VERSION as FXIAOKE_TRIGGER_OBJECT_REVIEW_WRITEBACK_ADAPTER_VERSION,
  CUSTOM_FIND_ONE_PATH,
  CUSTOM_UPDATE_PATH,
  PRESET_GET_PATH,
  PRESET_UPDATE_PATH,
  RECEIPT_VERSION as TRIGGER_REVIEW_WRITEBACK_RECEIPT_VERSION,
  createFxiaokeTriggerObjectReviewWritebackAdapter,
};
