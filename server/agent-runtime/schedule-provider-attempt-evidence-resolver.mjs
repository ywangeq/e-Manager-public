const REQUEST_FIELDS = new Set(["canonicalTaskId", "runId", "tenantScope"]);
const TOKEN = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,179}$/;

export function createScheduleProviderAttemptEvidenceResolver({ executionTaskRepository } = {}) {
  if (!executionTaskRepository ||
    typeof executionTaskRepository.readProviderAttemptReceiptExact !== "function") {
    throw new TypeError("executionTaskRepository.readProviderAttemptReceiptExact must be a function");
  }

  return function resolveScheduleProviderAttemptEvidence(value = {}) {
    exactObject(value, REQUEST_FIELDS);
    const request = {
      tenantScope: token(value.tenantScope),
      runId: token(value.runId),
      canonicalTaskId: token(value.canonicalTaskId),
    };
    const receipt = executionTaskRepository.readProviderAttemptReceiptExact({
      tenantScope: request.tenantScope,
      taskId: request.canonicalTaskId,
      executionScopeId: request.runId,
      purpose: "schedule_result",
    });
    if (!receipt || receipt.status !== "response_recorded") return null;
    return Object.freeze({
      contractVersion: "schedule-provider-attempt-evidence.v1",
      tenantScope: request.tenantScope,
      runId: request.runId,
      canonicalTaskId: request.canonicalTaskId,
      providerAttemptEvidenceDigest: receipt.attemptEvidenceDigest,
      ingestRef: receipt.ingestRef,
      ingestEvidenceDigest: receipt.ingestEvidenceDigest,
      state: "response_recorded",
    });
  };
}

function exactObject(value, fields) {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype) {
    throw resolverError("schedule_provider_attempt_request_invalid");
  }
  const keys = Object.keys(value);
  if (keys.length !== fields.size || keys.some((key) => !fields.has(key))) {
    throw resolverError("schedule_provider_attempt_request_invalid");
  }
}

function token(value) {
  const result = String(value || "").trim();
  if (!TOKEN.test(result)) throw resolverError("schedule_provider_attempt_request_invalid");
  return result;
}

function resolverError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}
