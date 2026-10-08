const CONTRACT_VERSION = "schedule-run-provider-result-adapter.v1";

export function createScheduleRunProviderResultAdapter({
  inputAcquisitionService,
  providerResultExecutionService,
} = {}) {
  requireMethod(inputAcquisitionService, "inputAcquisitionService", "acquire");
  requireMethod(providerResultExecutionService, "providerResultExecutionService", "execute");
  requireMethod(providerResultExecutionService, "providerResultExecutionService", "recover");

  return Object.freeze({
    adapterKind: "provider_result",
    contractVersion: CONTRACT_VERSION,
    network: "provider_only",
    productionEffect: "canonical_provider_attempt",
    providerAccess: "canonical_attempt_receipt",
    acquireInput: (request, options) => inputAcquisitionService.acquire(request, options),
    executeResult: (request, options) => providerResultExecutionService.execute(request, options),
    recoverResult: (request, options) => providerResultExecutionService.recover(request, options),
    skillAccess: "none",
    toolAccess: "none",
    writeback: "none",
  });
}

function requireMethod(value, name, method) {
  if (typeof value?.[method] !== "function") throw new TypeError(`${name}.${method} must be a function`);
}

export { CONTRACT_VERSION as SCHEDULE_RUN_PROVIDER_RESULT_ADAPTER_CONTRACT_VERSION };
