const RECORDER_CONTRACT_VERSION = "fxiaoke-sale-contract-locator-recorder.v1";
const SALE_CONTRACT_OBJECT_API_NAME = "SaleContractObj";
const CONTRACT_NUMBER_FIELD_API_NAME = "name";

function createFxiaokeSaleContractLocatorRecorder({ locatorRepository, tenantScope } = {}) {
  if (typeof locatorRepository?.record !== "function") {
    throw new TypeError("Fxiaoke sale-contract locator recorder requires locatorRepository.record");
  }
  const safeTenantScope = reference(tenantScope);

  function record({ record: sourceRecord, subject, taskId, triggerEventId } = {}) {
    const safeSubject = normalizeSubject(subject);
    if (safeSubject.objectApiName !== SALE_CONTRACT_OBJECT_API_NAME) {
      return Object.freeze({ contractVersion: RECORDER_CONTRACT_VERSION, status: "not_applicable" });
    }
    const contractNumber = locatorValue(sourceRecord?.[CONTRACT_NUMBER_FIELD_API_NAME]);
    if (!contractNumber) {
      return Object.freeze({ contractVersion: RECORDER_CONTRACT_VERSION, status: "unavailable" });
    }
    const stored = locatorRepository.record({
      tenantScope: safeTenantScope,
      locatorType: "contract_number",
      locatorValue: contractNumber,
      triggerEventId: reference(triggerEventId),
      taskId: reference(taskId),
      sourceSystemId: "fxiaoke-crm",
      subject: safeSubject,
    });
    return Object.freeze({
      contractVersion: RECORDER_CONTRACT_VERSION,
      status: stored.created ? "recorded" : "already_recorded",
    });
  }

  return Object.freeze({ contractVersion: RECORDER_CONTRACT_VERSION, record });
}

function normalizeSubject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
    Object.keys(value).length !== 2 || !Object.hasOwn(value, "objectApiName") ||
    !Object.hasOwn(value, "objectId")) {
    throw recorderError("trigger_business_locator_subject_invalid");
  }
  return Object.freeze({
    objectApiName: reference(value.objectApiName),
    objectId: reference(value.objectId),
  });
}

function reference(value) {
  if (typeof value !== "string" || value !== value.trim() || !value || value.length > 240 ||
    !/^[A-Za-z0-9][A-Za-z0-9._:@/-]*$/.test(value)) {
    throw recorderError("trigger_business_locator_reference_invalid");
  }
  return value;
}

function locatorValue(value) {
  if (typeof value !== "string" || value !== value.trim() || !value || value.length > 200 ||
    /[\u0000-\u001F\u007F]/.test(value)) return "";
  return value.normalize("NFC");
}

function recorderError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

export {
  CONTRACT_NUMBER_FIELD_API_NAME,
  RECORDER_CONTRACT_VERSION,
  SALE_CONTRACT_OBJECT_API_NAME,
  createFxiaokeSaleContractLocatorRecorder,
};
