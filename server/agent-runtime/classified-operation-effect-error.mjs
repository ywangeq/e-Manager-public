const OUTCOME_STATUSES = new Set(["definitive_failed", "unknown"]);
const SAFE_CODE = /^[a-z][a-z0-9_]{1,159}$/;

class ClassifiedOperationEffectError extends Error {
  constructor({ status, safeResultCode } = {}) {
    if (!OUTCOME_STATUSES.has(status) || !SAFE_CODE.test(String(safeResultCode || ""))) {
      throw new TypeError("classified operation effect error requires a safe terminal outcome");
    }
    super(safeResultCode);
    this.name = "ClassifiedOperationEffectError";
    this.code = safeResultCode;
    this.outcomeStatus = status;
  }
}

function classifiedOperationEffectOutcome(error) {
  if (!(error instanceof ClassifiedOperationEffectError)) return null;
  return Object.freeze({
    status: error.outcomeStatus,
    safeResultCode: error.code,
    receiptPayload: null,
  });
}

export {
  ClassifiedOperationEffectError,
  classifiedOperationEffectOutcome,
};
