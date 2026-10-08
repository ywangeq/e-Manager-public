import {
  createOpenApiToolExecutor,
  loadOpenApiDocument,
  normalizeManagedRequestHeaders,
  openApiToolInvocationCheck,
} from "./openapi-tool-executor.mjs";
import { mergeOpenApiDocuments } from "./openapi-contract.mjs";

async function createManagedOpenApiToolExecutor({
  allowSelfSignedCertificate = false,
  authorizeToolCall = null,
  baseUrl = "",
  credential = "",
  currentUserToolCredentialLeaseService = null,
  defaultOperationReceiptContext = null,
  employee = {},
  executionIdentity = null,
  idempotentEffectService = null,
  managedRequestHeaders = [],
  managedCredentialHeader = "",
  managedArgumentAvailability = null,
  managedArgumentResolver = null,
  managedReferenceCatalog = null,
  managedReferenceCatalogId = "",
  managedReferenceCatalogStore = null,
  managedToolCredentialLeaseService = null,
  materialInputs = [],
  openApiDocument = null,
  openApiFile = "",
  openApiOverlayDocuments = [],
  openApiOverlayFiles = [],
  openApiRequestJson,
  openApiUrl = "",
  operationReceiptProjector = null,
  requestJson,
  responseNormalizer = null,
  toolId = "",
  toolNamePrefix = "",
  unavailableMessage = "当前 OpenAPI Tool 尚未载入机器可读合同。",
} = {}) {
  const binding = managedOpenApiBinding(employee, toolId);
  if (!binding) return unavailableExecutor(toolId, "tool_not_bound", "当前数字员工未授权该 OpenAPI Tool。");
  const currentUserCredentialBinding = currentUserToolCredentialLeaseService?.bindingFor?.(toolId) || null;
  const credentialHeader = String(managedCredentialHeader || "").trim().toLowerCase();
  const configuredHeaders = normalizeManagedRequestHeaders(managedRequestHeaders);
  let document;
  try {
    document = await loadOpenApiDocument({
      allowSelfSignedCertificate,
      document: openApiDocument,
      filePath: openApiFile,
      ...(openApiRequestJson ? { requestJson: openApiRequestJson } : {}),
      url: openApiUrl,
    });
    const overlayDocuments = [
      ...(Array.isArray(openApiOverlayDocuments) ? openApiOverlayDocuments : []),
      ...await Promise.all((Array.isArray(openApiOverlayFiles) ? openApiOverlayFiles : []).map((filePath) => loadOpenApiDocument({ filePath }))),
    ];
    if (overlayDocuments.length) document = mergeOpenApiDocuments(document, overlayDocuments);
  } catch {
    return unavailableExecutor(toolId, "openapi_contract_unavailable", unavailableMessage);
  }
  return createOpenApiToolExecutor({
    allowSelfSignedCertificate,
    apiBaseUrl: baseUrl,
    authorizeToolCall,
    binding,
    buildHeaders: async ({ forceRefresh = false, operation, signal }) => {
      if (credentialHeader) {
        // A trusted server descriptor selects this mode. Never fall back to a user
        // Bearer/cookie when a service API key is missing or configuration conflicts.
        if (currentUserCredentialBinding || managedToolCredentialLeaseService || credential ||
          !Object.entries(configuredHeaders.headers).some(([name, value]) =>
            name.toLowerCase() === credentialHeader && Boolean(value))) return null;
        return { headers: {} }; // The existing protected managed-header boundary injects the key.
      }
      if (currentUserCredentialBinding) {
        try {
          const lease = await currentUserToolCredentialLeaseService.acquireForOperation({
            employeeId: employee?.id,
            executionIdentity,
            forceRefresh,
            operation,
            signal,
            toolId,
          });
          const authorization = normalizeAuthorization(lease?.authorization);
          return authorization ? { headers: { Authorization: authorization }, leaseRef: lease.leaseRef } : null;
        } catch (error) {
          return {
            credentialError: safeCredentialLeaseReason(error),
            ...(error?.authorizationAction ? { authorizationAction: error.authorizationAction } : {}),
          };
        }
      }
      if (managedToolCredentialLeaseService) {
        try {
          const lease = await managedToolCredentialLeaseService.acquireForOperation({
            employeeId: employee?.id,
            executionIdentity,
            forceRefresh,
            operation,
            signal,
            toolId,
          });
          const authorization = normalizeAuthorization(lease?.authorization);
          return authorization ? { headers: { Authorization: authorization }, leaseRef: lease.leaseRef } : null;
        } catch (error) {
          return { credentialError: safeCredentialLeaseReason(error) };
        }
      }
      const authorization = normalizeAuthorization(credential);
      return authorization ? { Authorization: authorization } : null;
    },
    defaultOperationReceiptContext,
    document,
    idempotentEffectService,
    managedRequestHeaders,
    managedArgumentAvailability: typeof managedArgumentAvailability === "function"
      ? (operation) => managedArgumentAvailability({ employee, executionIdentity, operation, toolId })
      : null,
    managedArgumentResolver: typeof managedArgumentResolver === "function"
      ? ({ arguments: argumentsValue, callId, confirmationReviewArguments, operation }) => managedArgumentResolver({
          arguments: argumentsValue,
          callId,
          confirmationReviewArguments,
          employee,
          executionIdentity,
          operation,
          toolId,
        })
      : null,
    managedReferenceCatalog: managedReferenceCatalog || managedReferenceCatalogStore?.catalogFor?.({
      catalogId: managedReferenceCatalogId,
      employeeId: employee?.id,
      toolId,
    }) || null,
    materialInputs,
    ...(requestJson ? { requestJson } : {}),
    responseNormalizer: typeof responseNormalizer === "function"
      ? ({ arguments: argumentsValue, data, operation }) => responseNormalizer({ arguments: argumentsValue, data, employee, executionIdentity, operation, toolId })
      : null,
    toolId,
    toolNamePrefix,
    operationReceiptProjector,
    onCredentialRejected: currentUserCredentialBinding
      ? ({ leaseRef }) => currentUserToolCredentialLeaseService.invalidate(leaseRef)
      : managedToolCredentialLeaseService
        ? ({ leaseRef }) => managedToolCredentialLeaseService.invalidate?.(leaseRef)
        : null,
  });
}

function managedOpenApiToolInvocationCheck({
  allOperations = [],
  confirmation = null,
  confirmationContext = {},
  confirmationService = null,
  employee = {},
  operation = null,
  toolCall = {},
} = {}) {
  const toolId = String(operation?.toolId || "").trim();
  const binding = managedOpenApiBinding(employee, toolId);
  if (!binding || !toolId) {
    return { status: "blocked", reason: "tool_invocation_not_allowed", nextGate: "当前数字员工未授权该 OpenAPI operation。" };
  }
  return openApiToolInvocationCheck({
    allOperations,
    binding,
    confirmation,
    confirmationContext,
    confirmationService,
    operation,
    toolCall,
  });
}

function managedOpenApiBinding(employee = {}, toolId = "") {
  const normalizedToolId = String(toolId || "").trim();
  if (!normalizedToolId) return null;
  return (Array.isArray(employee.toolBindings) ? employee.toolBindings : employee.tools || [])
    .find((binding) => [binding?.id, binding?.toolId]
      .some((value) => String(value || "").trim() === normalizedToolId) && binding?.enabled !== false) || null;
}

function unavailableExecutor(toolId, reason, message) {
  return {
    agentResultFor: (result) => result,
    availableAgentContent: () => [],
    execute: async () => ({ ok: false, status: "blocked", toolId, error: reason, message }),
    operations: () => [],
    runtimeStatus: () => ({ toolId, status: "unavailable", reason, message }),
    safeToolCatalog: () => [],
    toolDefinitions: () => [],
  };
}

function normalizeAuthorization(value = "") {
  const match = String(value || "").trim().match(/^Bearer\s+([^\s]+)$/i);
  return match?.[1] && match[1].length <= 8 * 1024 ? `Bearer ${match[1]}` : "";
}

function safeCredentialLeaseReason(error) {
  const code = String(error?.code || "").trim();
  return new Set([
    "current_user_tool_credential_binding_unavailable",
    "current_user_tool_authorization_required",
    "current_user_tool_credential_issuer_unavailable",
    "current_user_tool_credential_issuer_unconfigured",
    "current_user_tool_credential_lease_canceled",
    "current_user_tool_execution_identity_expired",
    "current_user_tool_execution_identity_invalid",
    "current_user_tool_operation_invalid",
    "current_user_tool_operation_scope_invalid",
    "current_user_tool_employee_invalid",
    "feishu_employee_app_identity_invalid",
    "feishu_employee_app_credentials_unavailable",
    "feishu_employee_app_credential_rejected",
    "feishu_employee_app_token_lease_canceled",
    "feishu_employee_app_token_lease_unavailable",
  ]).has(code) ? code : "current_user_tool_credential_lease_unavailable";
}

export {
  createManagedOpenApiToolExecutor,
  managedOpenApiBinding,
  managedOpenApiToolInvocationCheck,
};
