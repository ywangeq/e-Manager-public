const RESOLVER_CONTRACT_VERSION = "operation-receipt-task-reference-resolver.v1";

function createOperationReceiptTaskReferenceResolver({ repository, tenantScope } = {}) {
  if (typeof repository?.listOperationReceiptExternalReferences !== "function") {
    throw new TypeError("operation receipt task reference resolver requires repository.listOperationReceiptExternalReferences");
  }
  const safeTenantScope = reference(tenantScope);

  function resolve({ task } = {}) {
    const taskId = reference(task?.id || task?.taskId);
    const externalReferences = repository.listOperationReceiptExternalReferences({
      tenantScope: safeTenantScope,
      taskId,
    });
    const approvalInstance = externalReferences.find((item) => item.type === "feishu_approval_instance");
    if (!approvalInstance?.value) return null;
    return Object.freeze({
      contractVersion: "runtime-task-business-reference.v1",
      label: "审批实例",
      sourceField: approvalInstance.sourceField,
      type: "approval_instance",
      value: approvalInstance.value,
    });
  }

  return Object.freeze({ contractVersion: RESOLVER_CONTRACT_VERSION, resolve });
}

function reference(value) {
  if (typeof value !== "string" || value !== value.trim() || !value || value.length > 240 ||
    !/^[A-Za-z0-9][A-Za-z0-9._:@/-]*$/.test(value)) {
    const error = new Error("operation_receipt_task_reference_invalid");
    error.code = "operation_receipt_task_reference_invalid";
    throw error;
  }
  return value;
}

export { RESOLVER_CONTRACT_VERSION, createOperationReceiptTaskReferenceResolver };
