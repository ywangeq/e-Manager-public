const RESOLVER_CONTRACT_VERSION = "fxiaoke-sale-contract-task-reference-resolver.v1";

function createFxiaokeSaleContractTaskReferenceResolver({ locatorRepository, tenantScope } = {}) {
  if (typeof locatorRepository?.getByTask !== "function") {
    throw new TypeError("Fxiaoke sale-contract task reference resolver requires locatorRepository.getByTask");
  }
  const safeTenantScope = reference(tenantScope);

  function resolve({ task } = {}) {
    if (task?.trigger?.channel !== "trigger" || task?.sourceSystemId !== "fxiaoke-crm") return null;
    const match = locatorRepository.getByTask({
      tenantScope: safeTenantScope,
      taskId: reference(task.id || task.taskId),
    });
    if (!match?.contractNumber) return null;
    return Object.freeze({
      contractVersion: "runtime-task-business-reference.v1",
      label: "合同编号",
      sourceField: "data.name",
      type: "contract_number",
      value: match.contractNumber,
    });
  }

  return Object.freeze({ contractVersion: RESOLVER_CONTRACT_VERSION, resolve });
}

function reference(value) {
  if (typeof value !== "string" || value !== value.trim() || !value || value.length > 240 ||
    !/^[A-Za-z0-9][A-Za-z0-9._:@/-]*$/.test(value)) {
    const error = new Error("trigger_business_locator_reference_invalid");
    error.code = "trigger_business_locator_reference_invalid";
    throw error;
  }
  return value;
}

export { RESOLVER_CONTRACT_VERSION, createFxiaokeSaleContractTaskReferenceResolver };
