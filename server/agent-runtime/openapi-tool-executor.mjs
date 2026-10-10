import http from "node:http";
import https from "node:https";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {
  buildOpenApiRequest,
  capabilityWritePolicyDigests,
  compileOpenApiOperations,
  governedOpenApiToolCall,
  normalizeOpenApiArguments,
  operationArgumentSchema,
  operationAllowedByBinding,
  safeApiBaseUrl,
  sameGovernedOpenApiCall,
} from "./openapi-contract.mjs";
import { resolveToolAuthorizationPolicy } from "./tool-authorization-policy.mjs";
import { operationReceiptContextForExecutionOwnership } from "./operation-receipt-context.mjs";
import {
  createToolParameterCard,
  validateToolParameterCardSubmission,
} from "./tool-parameter-card.mjs";
import { createStructuredInputParameterCard } from "./structured-input-tool-executor.mjs";
import {
  resolveManagedReference,
  searchManagedReferences,
} from "./managed-reference-catalog.mjs";

const MAX_CONTRACT_BYTES = 8 * 1024 * 1024;
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const MAX_RESULT_BYTES = 1024 * 1024;
const MAX_COLLECTION_ITEMS = 5_000;
const MAX_PAYLOAD_DEPTH = 32;
const MAX_PAYLOAD_STRING_LENGTH = 100_000;
const MAX_MATERIAL_INPUT_BYTES = 4 * 1024 * 1024;
const MAX_MULTIPART_BODY_BYTES = 8 * 1024 * 1024;
const REDACTED_KEYS = /authorization|bearer|token|password|secret|credential|cookie|api[-_]?key/i;
const PROTECTED_RUNTIME_KEYS = new Set(["protectedSelectionEvidence"]);
const CHANNEL_LINK_PLACEHOLDER = "链接由 Channel 安全投影";
const UNSAFE_PRESENTATION_LINK_KEYS = /authorization|auth|bearer|token|password|secret|credential|cookie|api[-_]?key|state|code|callback|webhook/i;
const documentCache = new Map();

async function loadOpenApiDocument({ allowSelfSignedCertificate = false, cacheTtlMs = 5 * 60 * 1000, document = null, filePath = "", now = () => Date.now(), requestJson = defaultRequestJson, url = "" } = {}) {
  if (document) return structuredClone(document);
  if (filePath) {
    const resolvedPath = path.resolve(String(filePath));
    const stat = fs.statSync(resolvedPath);
    if (!stat.isFile() || stat.size > MAX_CONTRACT_BYTES) throw new Error("openapi_contract_file_invalid");
    const parsed = JSON.parse(fs.readFileSync(resolvedPath, "utf8"));
    if (!parsed?.openapi || !parsed?.paths) throw new Error("openapi_contract_file_invalid");
    return parsed;
  }
  const contractUrl = safeContractUrl(url);
  if (!contractUrl) throw new Error("openapi_contract_source_required");
  const cached = documentCache.get(contractUrl);
  if (cached && cached.expiresAt > now()) return structuredClone(cached.document);
  const response = await requestJson(contractUrl, { allowSelfSignedCertificate, headers: { Accept: "application/json" }, method: "GET", maxBytes: MAX_CONTRACT_BYTES });
  if (response.statusCode < 200 || response.statusCode >= 300 || !response.body?.openapi || !response.body?.paths) throw new Error("openapi_contract_unavailable");
  documentCache.set(contractUrl, { document: structuredClone(response.body), expiresAt: now() + cacheTtlMs });
  return structuredClone(response.body);
}

function createOpenApiToolExecutor({
  apiBaseUrl = "",
  authorizeToolCall = null,
  binding = {},
  buildHeaders = () => ({}),
  defaultOperationReceiptContext = null,
  document = {},
  idempotentEffectService = null,
  materialInputs = [],
  managedRequestHeaders = [],
  managedArgumentResolver = null,
  managedArgumentAvailability = null,
  managedReferenceCatalog = null,
  onCredentialRejected = null,
  operationReceiptProjector = null,
  requestJson = defaultRequestJson,
  responseNormalizer = null,
  waitForAsyncResult = cancellableDelay,
  toolId = "",
  toolNamePrefix = "",
  allowSelfSignedCertificate = false,
} = {}) {
  const compiledOperations = binding?.enabled === false || !safeApiBaseUrl(apiBaseUrl)
    ? []
    : compileOpenApiOperations({ document, toolId, toolNamePrefix });
  const authorizationPolicy = resolveToolAuthorizationPolicy(binding);
  const currentWritePolicyDigests = capabilityWritePolicyDigests(compiledOperations, authorizationPolicy.allowedCapabilities);
  const operations = compiledOperations.filter((operation) => operationAllowedByBinding(binding, operation, compiledOperations));
  const operationById = new Map(operations.map((operation) => [operation.operationId, operation]));
  const materialInputById = new Map(normalizeMaterialInputs(materialInputs).map((item) => [item.inputId, item]));
  const materialInputIds = [...materialInputById.keys()];
  const managedHeaders = normalizeManagedRequestHeaders(managedRequestHeaders);
  const names = catalogToolNames(toolNamePrefix || toolId);
  const referenceEvidence = new Map();
  const sideEffectFreeResultCache = new Map();

  async function execute(call = {}, options = {}) { return invoke(call, options, false); }
  async function recoverRecordedResult(call = {}, options = {}) { return invoke(call, options, true); }

  async function invoke({ name = "", arguments: input = {}, callId = "" } = {}, {
    onControlledRetry = null,
    confirmedToolCall = false,
    operationReceiptContext = null,
    runtimeTask = null,
    signal = null,
  } = {}, receiptReadOnly = false) {
    if (onControlledRetry !== null && typeof onControlledRetry !== "function") {
      throw new TypeError("OpenAPI Tool onControlledRetry must be a function");
    }
    if (signal?.aborted) return toolFailure(toolId, "agent_turn_canceled", "任务已取消，OpenAPI Tool 未开始执行。");
    if (receiptReadOnly && name !== names.invoke) return toolFailure(toolId, "operation_receipt_recovery_unsupported", "该 Tool 不支持读取写操作回执。");
    if (name === names.search) return searchOperations(input);
    if (name === names.references && managedReferenceCatalog) return searchReferences(input);
    if (name === names.describe) return describeOperation(input);
    if (name !== names.invoke) return toolFailure(toolId, "tool_not_allowed", "该 OpenAPI Tool 未被当前数字员工声明。");
    const operationId = cleanText(input?.operationId, 180);
    const operation = operationById.get(operationId);
    if (!operation) return toolFailure(toolId, "tool_not_allowed", "该 OpenAPI operation 不在当前数字员工的已声明边界内。");
    if (operation.executable === false) return toolFailure(toolId, operation.unavailableReason, `该 operation 的请求媒体类型（${operation.requestBody?.contentTypes?.join(", ") || "未声明"}）尚未接入通用执行器。`);
    const invocationArguments = {
      ...(input.path === undefined ? {} : { path: input.path }),
      ...(input.query === undefined ? {} : { query: input.query }),
      ...(input.headers === undefined ? {} : { headers: omitManagedRequestHeaders(input.headers, managedHeaders.protectedNames) }),
      ...(input.body === undefined ? {} : { body: input.body }),
    };
    const confirmedManagedReferenceExecution = confirmedToolCall === true &&
      cleanText(callId, 180).startsWith("confirmation:");
    let managedArguments = resolveManagedReferenceArguments(operation, invocationArguments, managedReferenceCatalog, {
      allowHiddenValues: confirmedManagedReferenceExecution,
    });
    if (!managedArguments.ok) return toolFailure(toolId, managedArguments.error, managedArguments.message);
    let confirmationReviewArguments = managedArguments.confirmationReviewArguments || invocationArguments;
    if (typeof managedArgumentResolver === "function") {
      try {
        const resolved = await managedArgumentResolver({
          arguments: managedArguments.arguments,
          callId,
          confirmationReviewArguments,
          operation,
        });
        confirmationReviewArguments = resolved?.confirmationReviewArguments || confirmationReviewArguments;
        managedArguments = resolved?.ok === false
          ? resolved
          : { ok: true, arguments: resolved?.arguments || managedArguments.arguments };
      } catch {
        managedArguments = { ok: false, error: "managed_arguments_unavailable", message: "当前 Tool 无法解析受管参数。" };
      }
      if (!managedArguments.ok) return toolFailure(toolId, managedArguments.error, managedArguments.message);
    }
    const argumentsResult = normalizeOpenApiArguments(operation, managedArguments.arguments, { materialInputIds });
    if (!argumentsResult.ok) return toolFailure(toolId, "tool_arguments_invalid", argumentsResult.message);
    if (receiptReadOnly) {
      if (operation.risk === "read_only" || typeof idempotentEffectService?.readRecordedResult !== "function" ||
        !operationReceiptProjector || !cleanText(callId, 180)) {
        return toolFailure(toolId, "operation_receipt_recovery_unsupported", "当前操作缺少只读回执恢复能力。");
      }
      const context = receiptContextFor(operationReceiptContext, runtimeTask);
      if (!context?.repositoryContext) return toolFailure(toolId, "operation_receipt_task_identity_required", "当前回执缺少可验证的任务身份。");
      const recorded = await idempotentEffectService.readRecordedResult({
        request: receiptRequestFor(operation, argumentsResult.value, callId, context),
      });
      if (!recorded || ["prepared", "unknown"].includes(recorded.status)) {
        return toolFailure(toolId, "external_effect_unknown", "尚无确定的执行回执，已停止重放。");
      }
      const result = recorded.receipt.payload?.toolResult;
      if (!result || result.toolId !== toolId || result.operationId !== operation.operationId) {
        return toolFailure(toolId, "operation_receipt_result_unavailable", "回执结果不能与当前 Tool 合同匹配。");
      }
      const restored = boundedResult(structuredClone(result), toolId);
      if (recorded.status === "definitive_failed") return { ...restored, externalEffectStatus: "definitive_failed", turnDisposition: "target_rejected" };
      return restored.ok && operation.asyncResult ? {
        ...restored, status: "in_progress", externalEffectStatus: "succeeded",
        asyncResult: { contractVersion: operation.asyncResult.contractVersion, terminal: false, reason: "recorded_submission_only" },
      } : { ...restored, externalEffectStatus: "succeeded" };
    }
    if (typeof authorizeToolCall === "function") {
      const decision = await authorizeToolCall({
        ...governedOpenApiToolCall(operation, argumentsResult.value),
        confirmationReviewArguments,
        confirmationExecutionCall: {
          name: names.invoke,
          arguments: { operationId: operation.operationId, ...argumentsResult.value },
        },
      }, operation, compiledOperations);
      if (decision?.status !== "allowed") {
        return {
          ...toolFailure(toolId, "tool_invocation_blocked", decision?.nextGate || "该 OpenAPI Tool 调用未通过执行门禁。"),
          ...(decision?.confirmationRequest ? { confirmationRequest: decision.confirmationRequest } : {}),
        };
      }
    } else if (operation.risk !== "read_only") {
      return toolFailure(toolId, "tool_invocation_blocked", "OpenAPI 写操作缺少结构化授权门禁。");
    }
    const request = buildOpenApiRequest({ apiBaseUrl, argumentsValue: argumentsResult.value, operation });
    if (!request.ok) return toolFailure(toolId, "tool_arguments_invalid", request.message);
    const multipart = prepareMultipartRequest(operation, request.value.body, materialInputById);
    if (!multipart.ok) return toolFailure(toolId, multipart.error, multipart.message);
    const requestEffect = async ({ preserveReceivedResponse = false } = {}) => {
      const executeRequest = async (forceRefresh = false) => {
        const resolvedCredential = normalizeCredentialResolution(await buildHeaders({
          forceRefresh,
          operation,
          signal,
          toolCall: governedOpenApiToolCall(operation, argumentsResult.value),
        }));
        if (!resolvedCredential) return toolFailure(toolId, "tool_credential_required", "当前 OpenAPI Tool 缺少可用凭证。");
        if (resolvedCredential.credentialError) {
          return {
            ...toolFailure(toolId, "tool_credential_required", "当前 OpenAPI Tool 无法签发用户凭证租约。"),
            credentialReason: resolvedCredential.credentialError,
            ...(resolvedCredential.authorizationAction
              ? { authorizationAction: resolvedCredential.authorizationAction }
              : {}),
          };
        }
        const response = await requestJson(request.value.url, {
          allowSelfSignedCertificate,
          body: multipart.body,
          headers: { Accept: "application/json", ...request.value.headers, ...resolvedCredential.headers, ...multipart.headers, ...managedHeaders.headers },
          method: request.value.method,
          signal,
        });
        return { resolvedCredential, response };
      };
      let attempted = await executeRequest(false);
      if (attempted?.ok === false) return attempted;
      let { resolvedCredential, response } = attempted;
      let failureDiagnostics = safeFailureDiagnostics(response, operation.operationId);
      if (response.statusCode === 401 && targetAuthenticationConfigurationRequired(failureDiagnostics)) {
        return { ...toolFailure(toolId, "tool_target_authentication_required", "目标系统返回服务端 API Key 门禁，尚未接受当前用户凭证。"), ...failureDiagnostics };
      }
      if (response.statusCode === 401) {
        await rejectCredential(onCredentialRejected, {
          leaseRef: resolvedCredential.leaseRef,
          operation,
          toolCall: governedOpenApiToolCall(operation, argumentsResult.value),
        });
        if (operation.risk === "read_only") {
          await onControlledRetry?.({ reasonCode: "read_only_credential_refresh" });
          attempted = await executeRequest(true);
          if (attempted?.ok === false) return attempted;
          ({ resolvedCredential, response } = attempted);
          failureDiagnostics = safeFailureDiagnostics(response, operation.operationId);
          if (response.statusCode === 401 && targetAuthenticationConfigurationRequired(failureDiagnostics)) {
            return { ...toolFailure(toolId, "tool_target_authentication_required", "目标系统返回服务端 API Key 门禁，尚未接受当前用户凭证。"), ...failureDiagnostics };
          }
          if (response.statusCode === 401) {
            await rejectCredential(onCredentialRejected, {
              leaseRef: resolvedCredential.leaseRef,
              operation,
              toolCall: governedOpenApiToolCall(operation, argumentsResult.value),
            });
          }
        }
      }
      if (signal?.aborted && !preserveReceivedResponse) return toolFailure(toolId, "agent_turn_canceled", "任务已取消，OpenAPI Tool 已停止。");
      failureDiagnostics = safeFailureDiagnostics(response, operation.operationId);
      if (response.statusCode === 401) return credentialFailure(toolId, "tool_credential_rejected", "当前用户凭证已失效。", "rejected", failureDiagnostics);
      if (response.statusCode === 403) return credentialFailure(toolId, "tool_forbidden", "目标系统拒绝当前用户执行该 operation。", "forbidden", failureDiagnostics);
      if (response.statusCode < 200 || response.statusCode >= 300) {
        return { ...toolFailure(toolId, "tool_request_failed", `目标系统返回 HTTP ${response.statusCode}。`), ...failureDiagnostics };
      }
      let data;
      try {
        data = safePayload(response.body?.data ?? response.body);
        if (typeof responseNormalizer === "function") {
          data = safePayload(responseNormalizer({ arguments: argumentsResult.value, data, operation, toolId }) ?? data);
        }
      } catch (error) {
        if (isResponseLimitError(error)) return responseLimitFailure(toolId);
        throw error;
      }
      rememberReferenceEvidence(referenceEvidence, data, { operation });
      const channelPresentationEvidence = channelPresentationEvidenceForOpenApiResult(data, {
        apiBaseUrl,
        resultPresentation: operation.resultPresentation,
      });
      const selection = responseSelectionParameterCard({ apiBaseUrl, data, operation, toolId });
      if (selection?.error) {
        return boundedResult({
          ...toolFailure(toolId, selection.error, selection.message),
          operationId: operation.operationId,
          ...(channelPresentationEvidence ? { channelPresentationEvidence } : {}),
          parameterCardPresentation: selection.parameterCardPresentation,
          turnDisposition: "tool_parameter_card_unavailable",
        }, toolId);
      }
      const result = boundedResult({
        ok: true,
        status: "completed",
        toolId,
        operationId: operation.operationId,
        data,
        ...(channelPresentationEvidence ? { channelPresentationEvidence } : {}),
        ...(selection?.parameterCard ? { parameterCard: selection.parameterCard } : {}),
      }, toolId);
      if (!result.ok) return result;
      // Validate the final Agent envelope before recording a successful external effect.
      const agentResult = boundedResult(projectOpenApiResultForAgent(result), toolId);
      return agentResult.ok ? result : agentResult;
    };
    if (operation.risk !== "read_only") {
      if (!idempotentEffectService || !operationReceiptProjector) {
        return toolFailure(toolId, "operation_receipt_required", "当前写操作未接入受治理幂等回执服务。");
      }
      if (!cleanText(callId, 180)) {
        return toolFailure(toolId, "operation_receipt_call_id_required", "当前写操作缺少可验证的 Tool 调用身份。");
      }
      const effectiveOperationReceiptContext = receiptContextFor(operationReceiptContext, runtimeTask);
      if (!effectiveOperationReceiptContext?.repositoryContext) {
        return toolFailure(toolId, "operation_receipt_task_identity_required", "当前写操作缺少可验证的任务回执身份。");
      }
      const authorizationDigest = cleanText(operation.writePolicyDigest, 80);
      const receiptRequest = receiptRequestFor(operation, argumentsResult.value, callId, effectiveOperationReceiptContext);
      const receiptResult = await idempotentEffectService.execute({
        request: receiptRequest,
        repositoryContext: effectiveOperationReceiptContext.repositoryContext,
        authorizeCurrentOperation: async () => ({ status: "allowed", authorizationDigest }),
        effect: async () => {
          const toolResult = await requestEffect({ preserveReceivedResponse: true });
          if (toolResult.ok) return { status: "succeeded", safeResultCode: "external_write_succeeded", receiptPayload: { toolResult } };
          if (toolResult.error === "response_limit_exceeded") return {
            status: "succeeded", safeResultCode: "external_write_succeeded_response_unavailable",
            receiptPayload: { toolResult: { ...toolResult, externalEffectStatus: "succeeded",
              message: "目标系统已接受写操作，但响应超过安全结果上限；不得为获取结果重复写入，请通过只读操作核对。" } },
          };
          if (toolResult.error === "agent_turn_canceled") throw canceledRequestError();
          if (toolResult.error === "tool_unavailable" || Number(toolResult.httpStatus || 0) >= 500) {
            return { status: "unknown", safeResultCode: "external_effect_unknown", receiptPayload: null };
          }
          return { status: "definitive_failed", safeResultCode: "external_write_rejected", receiptPayload: { toolResult } };
        },
      });
      if (receiptResult.status === "unknown") return toolFailure(toolId, "external_effect_unknown", "外部写入结果未知，已停止自动重放并等待人工核对。");
      const toolResult = receiptResult.receipt.payload?.toolResult;
      if (!toolResult) return toolFailure(toolId, "operation_receipt_result_unavailable", "回执已存在，但缺少可验证的 Tool 结果。");
      const receivedResult = receiptResult.status === "definitive_failed"
        ? { ...toolResult, turnDisposition: "target_rejected" }
        : toolResult;
      return receivedResult.ok && operation.asyncResult
        ? await awaitDeclaredAsyncResult({ initialResult: receivedResult, operation, operationReceiptContext: effectiveOperationReceiptContext, signal })
        : receivedResult;
    }
    try {
      if (operation.sideEffectFree === true && operation.risk === "read_only") {
        const cacheKey = sideEffectFreeOperationCacheKey(operation, argumentsResult.value);
        const cached = sideEffectFreeResultCache.get(cacheKey);
        if (cached) return structuredClone(cached);
        const result = await requestEffect();
        if (result.ok && sideEffectFreeResultCache.size < 100) {
          sideEffectFreeResultCache.set(cacheKey, structuredClone(result));
        }
        return result;
      }
      return await requestEffect();
    } catch (error) {
      if (signal?.aborted) return toolFailure(toolId, "agent_turn_canceled", "任务已取消，OpenAPI Tool 已停止。");
      if (isResponseLimitError(error)) return responseLimitFailure(toolId);
      return toolFailure(toolId, "tool_unavailable", "OpenAPI 目标系统暂时不可达。");
    }
  }

  function receiptContextFor(context, runtimeTask) {
    return context?.repositoryContext ? context : defaultOperationReceiptContext?.repositoryContext
      ? defaultOperationReceiptContext : operationReceiptContextForExecutionOwnership({ task: runtimeTask, lease: runtimeTask?.lease });
  }

  function receiptRequestFor(operation, argumentsValue, callId, context) {
    return operationReceiptProjector.project({
      tenantScope: context.repositoryContext.tenantScope, taskId: context.repositoryContext.taskId,
      toolCallId: cleanText(callId, 180), effectKind: "external_write", adapterId: toolId,
      actionCode: operation.operationId, authorizationDigest: cleanText(operation.writePolicyDigest, 80), recoveryMode: "none",
      targetScope: { origin: new URL(apiBaseUrl).origin, scope: operation.scope },
      operation: { arguments: argumentsValue, contractDigest: operation.contractDigest, method: operation.method,
        operationId: operation.operationId, path: operation.path, writePolicyDigest: operation.writePolicyDigest },
    });
  }

  async function awaitDeclaredAsyncResult({ initialResult, operation, operationReceiptContext, signal }) {
    const contract = operation.asyncResult;
    const taskReference = valueAtPath(initialResult.data, contract.taskReference.responsePath);
    if (!["string", "number"].includes(typeof taskReference) || String(taskReference).trim() === "") {
      return {
        ...initialResult,
        status: "in_progress",
        asyncResult: { contractVersion: contract.contractVersion, terminal: false, reason: "task_reference_missing" },
      };
    }
    const [argumentLocation, argumentName] = contract.taskReference.argumentTarget.split(".");
    const maximumPolls = Math.max(1, Math.ceil(contract.timeoutMs / contract.pollIntervalMs));
    let latestResult = initialResult;
    for (let poll = 1; poll <= maximumPolls; poll += 1) {
      if (poll > 1) {
        try {
          await waitForAsyncResult(contract.pollIntervalMs, signal);
        } catch {
          return toolFailure(toolId, "agent_turn_canceled", "任务已取消，异步结果读取已停止。");
        }
      }
      latestResult = await execute({
        name: names.invoke,
        arguments: {
          operationId: contract.resultOperationId,
          [argumentLocation]: { [argumentName]: taskReference },
        },
      }, { operationReceiptContext, signal });
      if (!latestResult.ok) {
        return {
          ...latestResult,
          asyncResult: { contractVersion: contract.contractVersion, terminal: false, taskReference: String(taskReference) },
        };
      }
      const targetStatus = cleanText(valueAtPath(latestResult.data, contract.statusPath), 120).toLowerCase();
      if (contract.successStatuses.includes(targetStatus)) {
        return boundedResult({
          ...latestResult,
          status: "completed",
          sourceOperationId: operation.operationId,
          asyncResult: {
            contractVersion: contract.contractVersion,
            resultOperationId: contract.resultOperationId,
            targetStatus,
            taskReference: String(taskReference),
            terminal: true,
          },
        }, toolId);
      }
      if (contract.failureStatuses.includes(targetStatus)) {
        return boundedResult({
          ...latestResult,
          ok: false,
          status: "failed",
          error: "async_result_failed",
          sourceOperationId: operation.operationId,
          asyncResult: { contractVersion: contract.contractVersion, targetStatus, taskReference: String(taskReference), terminal: true },
        }, toolId);
      }
      if (!contract.pendingStatuses.includes(targetStatus)) {
        return boundedResult({
          ...latestResult,
          ok: false,
          status: "blocked",
          error: "async_result_status_unknown",
          sourceOperationId: operation.operationId,
          asyncResult: { contractVersion: contract.contractVersion, targetStatus, taskReference: String(taskReference), terminal: false },
        }, toolId);
      }
    }
    return boundedResult({
      ...latestResult,
      status: "in_progress",
      sourceOperationId: operation.operationId,
      asyncResult: {
        contractVersion: contract.contractVersion,
        resultOperationId: contract.resultOperationId,
        targetStatus: cleanText(valueAtPath(latestResult.data, contract.statusPath), 120).toLowerCase(),
        taskReference: String(taskReference),
        terminal: false,
        reason: "poll_timeout",
      },
    }, toolId);
  }

  function searchOperations(input = {}) {
    const query = cleanText(input.query, 240).toLowerCase();
    const queryTerms = query.split(/\s+/).filter(Boolean);
    const methods = new Set(Array.isArray(input.methods) ? input.methods.map((value) => cleanText(value, 10).toUpperCase()) : []);
    const limit = Number.isSafeInteger(input.limit) ? Math.min(20, Math.max(1, input.limit)) : 10;
    const filtered = operations.filter((operation) => {
      if (methods.size && !methods.has(operation.method)) return false;
      if (!query) return true;
      const text = [operation.operationId, operation.summary, operation.description, operation.path, ...operation.tags].join(" ").toLowerCase();
      return queryTerms.every((term) => text.includes(term));
    });
    let businessReferences = query ? discoverManagedReferences({ query, limit }) : [];
    if (!businessReferences.length && queryTerms.length > 1) {
      const referencesByRef = new Map();
      for (const term of queryTerms) {
        for (const reference of discoverManagedReferences({ query: term, limit })) {
          if (!referencesByRef.has(reference.ref)) referencesByRef.set(reference.ref, reference);
        }
      }
      businessReferences = [...referencesByRef.values()].slice(0, limit);
    }
    const matchedById = new Map(filtered.map((operation) => [operation.operationId, operation]));
    for (const operationId of businessReferences.flatMap((reference) => reference.bindings.map((binding) => binding.operationId))) {
      const operation = operationById.get(operationId);
      if (operation && (!methods.size || methods.has(operation.method))) matchedById.set(operationId, operation);
    }
    const matches = [...matchedById.values()].slice(0, limit).map(operationSummary);
    return {
      ok: true,
      status: "completed",
      toolId,
      totalMatched: matchedById.size,
      operations: matches,
      ...(businessReferences.length ? {
        businessReferenceTotalMatched: businessReferences.length,
        businessReferences,
      } : {}),
    };
  }

  function searchReferences(input = {}) {
    const operationId = cleanText(input.operationId, 180);
    const argumentPath = cleanText(input.argumentPath, 240);
    if (Boolean(operationId) !== Boolean(argumentPath)) {
      return toolFailure(toolId, "managed_reference_target_incomplete", "operationId 和 argumentPath 必须同时提供，或先只按业务名称搜索。");
    }
    if (!operationId) {
      return {
        ok: true,
        status: "completed",
        toolId,
        catalogId: managedReferenceCatalog.catalogId,
        catalogVersion: managedReferenceCatalog.version,
        catalogDigest: managedReferenceCatalog.digest,
        references: discoverManagedReferences({ query: input.query, limit: input.limit }),
      };
    }
    const references = searchManagedReferences(managedReferenceCatalog, { query: input.query, limit: input.limit })
      .filter((entry) => Boolean(resolveManagedReference(managedReferenceCatalog, {
        operationId,
        argumentPath,
        ref: entry.ref,
      })));
    return {
      ok: true,
      status: "completed",
      toolId,
      catalogId: managedReferenceCatalog.catalogId,
      catalogVersion: managedReferenceCatalog.version,
      catalogDigest: managedReferenceCatalog.digest,
      operationId,
      argumentPath,
      references,
    };
  }

  function discoverManagedReferences({ limit, query } = {}) {
    return searchManagedReferences(managedReferenceCatalog, { query, limit }).map((reference) => {
      const catalogEntry = managedReferenceCatalog.entries.find((entry) => entry.ref === reference.ref);
      const bindings = (catalogEntry?.operationIds || []).flatMap((operationId) => {
        const operation = operationById.get(operationId);
        if (!operation) return [];
        const argumentSchema = operationArgumentSchema(operation, { materialInputIds });
        const argumentPaths = (catalogEntry.argumentPaths || []).filter((argumentPath) => schemaHasPath(argumentSchema, argumentPath));
        return argumentPaths.length ? [{
          operationId,
          argumentPaths,
          confirmationPolicy: operation.confirmationPolicy,
          risk: operation.risk,
          sideEffectFree: operation.sideEffectFree === true,
        }] : [];
      });
      return { ...reference, bindings };
    }).filter((reference) => reference.bindings.length);
  }

  function describeOperation(input = {}) {
    const operation = operationById.get(cleanText(input.operationId, 180));
    if (!operation) return toolFailure(toolId, "tool_not_allowed", "该 OpenAPI operation 不在当前数字员工的已声明边界内。");
    const argumentSchema = operationArgumentSchema(operation, { materialInputIds });
    const runtimeManagedArguments = projectManagedArgumentAvailability(managedArgumentAvailability, operation);
    const managedOperationResources = projectManagedOperationResources({
      discoverManagedReferences,
      operation,
    });
    const parameterCard = input.presentation === "parameter_card"
      ? createToolParameterCard({
          argumentSchema,
          operation,
          resolveManagedReferenceLabel: ({ path, value }) => {
            const managed = resolveManagedReference(managedReferenceCatalog, {
              operationId: operation.operationId,
              argumentPath: path.join("."),
              ref: value,
            });
            return managed?.label || resolveReferenceLabel(referenceEvidence, path.at(-1), value);
          },
          suggestedArguments: input.suggestedArguments,
          toolId,
        })
      : null;
    return {
      ok: true,
      status: "completed",
      toolId,
      operation: {
        ...operationSummary(operation),
        argumentSchema,
        confirmationPolicy: operation.confirmationPolicy,
        operationIdSource: operation.operationIdSource,
        risk: operation.risk,
        scope: operation.scope,
        writebackBoundary: operation.writebackBoundary,
      },
      ...(runtimeManagedArguments ? { runtimeManagedArguments } : {}),
      ...(managedOperationResources ? { managedOperationResources } : {}),
      ...(parameterCard ? { parameterCard } : {}),
      ...(input.presentation === "parameter_card" ? {
        parameterCardPresentation: parameterCard
          ? { status: "ready" }
          : { status: "unavailable", reason: "parameter_card_requirements_not_ready_or_schema_unsupported" },
      } : {}),
    };
  }

  const toolDefinitions = () => operations.length
    ? catalogToolDefinitions(names, { hasManagedReferences: Boolean(managedReferenceCatalog) })
    : [];

  function safeActivityDescriptor(toolCall = {}, { result = null } = {}) {
    const actionCode = toolCall.name === names.search
      ? "enterprise.search"
      : toolCall.name === names.references
        ? "enterprise.resolve_reference"
      : toolCall.name === names.describe
        ? "enterprise.describe"
        : toolCall.name === names.invoke
          ? "enterprise.invoke"
          : "";
    if (!actionCode || !toolId) return null;
    const operationId = cleanText(toolCall.arguments?.operationId, 180);
    const operation = operationById.get(operationId);
    const operationDisplayAllowed = result?.ok === true && Boolean(operation) && (
      actionCode === "enterprise.invoke" && result.operationId === operationId ||
      actionCode === "enterprise.describe" && result.toolId === toolId && result.operation?.operationId === operationId
    );
    return {
      actionCode,
      kind: "tool",
      subjectId: toolId,
      ...(operationDisplayAllowed ? {
        operationCode: operation.operationId,
        operationDisplayAllowed: true,
      } : {}),
    };
  }

  return {
    agentResultFor: (value) => {
      try { return boundedResult(projectOpenApiResultForAgent(value), toolId); }
      catch (error) {
        if (isResponseLimitError(error)) return responseLimitFailure(toolId);
        throw error;
      }
    },
    availableAgentContent: () => managedReferenceCatalog ? [{
      type: "text",
      text: JSON.stringify({
        contractVersion: "governed-tool-resources.v1",
        toolId,
        catalogId: managedReferenceCatalog.catalogId,
        catalogVersion: managedReferenceCatalog.version,
        instruction: "Match the current business intent to one reviewed resource and use its stable resourceId. If several resources remain plausible, ask the user to choose by business name. Never invent or request a hidden target id.",
        resources: discoverManagedReferences({ limit: 20, query: "" }).map((reference) => ({
          resourceId: reference.ref,
          name: reference.label,
          aliases: reference.aliases,
          bindings: reference.bindings,
        })),
      }),
    }] : [],
    execute,
    recoverRecordedResult,
    safeActivityDescriptor,
    operationForId: (operationId) => operationById.get(operationId) || null,
    operations: () => [...operations],
    validateParameterCardSubmission(submission) {
      const operation = operationById.get(cleanText(submission?.operationId, 180));
      if (!operation) return cleanText(submission?.toolId, 180) === toolId
        ? { matched: true, ok: false, error: "tool_parameter_card_operation_not_allowed" }
        : { matched: false, ok: false, error: "tool_parameter_card_tool_mismatch" };
      const argumentSchema = operationArgumentSchema(operation, { materialInputIds });
      const result = validateToolParameterCardSubmission({
        materialInputIds,
        operation: { ...operation, argumentSchema },
        submission,
        toolId,
      });
      if (!result.ok) return result;
      const managedArguments = resolveManagedReferenceArguments(operation, result.value.arguments, managedReferenceCatalog);
      if (!managedArguments.ok) return { matched: true, ok: false, error: managedArguments.error, message: managedArguments.message };
      const argumentsResult = normalizeOpenApiArguments(operation, managedArguments.arguments, { materialInputIds });
      return argumentsResult.ok
        ? { ...result, value: { ...result.value, arguments: structuredClone(result.value.arguments) } }
        : { matched: true, ok: false, error: "tool_parameter_card_arguments_invalid", message: argumentsResult.message };
    },
    runtimeStatus: () => {
      const unsupportedOperationCount = operations.filter((operation) => operation.executable === false).length;
      const contractDigest = compiledOperations[0]?.contractDigest || "";
      const blockedReason = runtimePolicyBlockReason({ authorizationPolicy, operationCount: operations.length });
      const writePolicyDriftCapabilities = driftedWritePolicyCapabilities({ authorizationPolicy, contractDigest, currentWritePolicyDigests });
      const availableSideEffectFreeOperationIds = operations
        .filter((operation) => operation.sideEffectFree === true && operation.risk === "read_only")
        .map((operation) => operation.operationId)
        .sort();
      return {
        toolId,
        status: blockedReason ? "blocked" : writePolicyDriftCapabilities.length || unsupportedOperationCount ? "degraded" : "ready",
        policyMode: authorizationPolicy.mode,
        operationCount: operations.length,
        unsupportedOperationCount,
        contractDigest,
        availableSideEffectFreeOperationIds,
        writePolicyDriftCapabilities,
        ...(blockedReason ? { reason: blockedReason } : {}),
        ...(!blockedReason && writePolicyDriftCapabilities.length ? {
          reason: authorizationPolicy.contractVersion === "tool-authorization-policy.v1"
            ? "openapi_write_policy_contract_digest_mismatch"
            : "openapi_write_policy_capability_digest_mismatch",
        } : {}),
      };
    },
    safeToolCatalog: () => toolDefinitions().map(({ name, description }) => ({ name, description })),
    structuredInputSourcePolicies: () => operations.flatMap((operation) => structuredInputSourcePoliciesForOperation(operation, toolId)),
    toolDefinitions,
  };
}

function structuredInputSourcePoliciesForOperation(operation = {}, toolId = "") {
  const managedContextFields = operation.responseSelection?.managedContextFields || [];
  if (!Array.isArray(managedContextFields) || !managedContextFields.length) return [];
  return [{
    contractVersion: "structured-input-source-policy.v1",
    sourceToolId: toolId || operation.toolId,
    sourceOperationId: operation.operationId,
    blockedFields: managedContextFields.map((field) => ({
      fieldId: field.fieldId,
      aliases: Array.isArray(field.aliases) ? [...field.aliases] : [],
    })),
  }];
}

function projectManagedOperationResources({ discoverManagedReferences, operation } = {}) {
  if (typeof discoverManagedReferences !== "function" || !operation?.operationId) return null;
  const resources = discoverManagedReferences({ limit: 20, query: "" }).flatMap((reference) => {
    const binding = reference.bindings?.find((candidate) => candidate.operationId === operation.operationId);
    if (!binding?.argumentPaths?.length) return [];
    const suggestedArguments = {};
    for (const argumentPath of binding.argumentPaths) {
      setProjectedValueAtPath(suggestedArguments, argumentPath, reference.ref);
    }
    return [{
      resourceId: reference.ref,
      name: reference.label,
      aliases: reference.aliases,
      argumentPaths: binding.argumentPaths,
      suggestedArguments,
    }];
  });
  if (!resources.length) return null;
  return {
    contractVersion: "managed-openapi-operation-resources.v1",
    status: "ready",
    source: "reviewed_managed_reference_catalog",
    selectionPolicy: "business_name_match_catalog_first",
    resources,
  };
}

function setProjectedValueAtPath(value, dataPath = "", nextValue) {
  const parts = String(dataPath || "").split(".").filter(Boolean);
  let current = value;
  for (let index = 0; index < parts.length - 1; index += 1) {
    const part = parts[index];
    if (!current[part] || typeof current[part] !== "object" || Array.isArray(current[part])) current[part] = {};
    current = current[part];
  }
  if (parts.length) current[parts.at(-1)] = nextValue;
}

function projectManagedArgumentAvailability(projector, operation) {
  if (typeof projector !== "function") return null;
  try {
    const value = projector(operation) || {};
    const status = value.status === "ready" ? "ready" : "unavailable";
    const argumentPaths = [...new Set((Array.isArray(value.argumentPaths) ? value.argumentPaths : [])
      .map((path) => cleanText(path, 240))
      .filter((path) => /^(?:path|query|headers|body)(?:\.[A-Za-z0-9_-]{1,120})+$/.test(path)))]
      .slice(0, 20);
    return argumentPaths.length ? {
      contractVersion: "runtime-managed-openapi-arguments.v1",
      status,
      argumentPaths,
      source: "trusted_runtime_context",
    } : null;
  } catch {
    return null;
  }
}

function catalogToolDefinitions(names, { hasManagedReferences = false } = {}) {
  return [
    {
      type: "function",
      name: names.search,
      description: "搜索当前已授权 OpenAPI 合同中的 operation。先按用户目标搜索，不要猜 endpoint。",
      strict: true,
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", maxLength: 240, description: "按 operationId、摘要、描述、path 或 tag 搜索；留空可浏览。" },
          methods: { type: "array", items: { type: "string", enum: ["GET", "PUT", "POST", "DELETE", "PATCH", "HEAD", "OPTIONS"] }, maxItems: 7 },
          limit: { type: "integer", minimum: 1, maximum: 20 },
        },
        required: [],
        additionalProperties: false,
      },
    },
    ...(hasManagedReferences ? [{
      type: "function",
      name: names.references,
      description: "按业务名称搜索当前 Tool binding 已审核的业务引用；尚不知 operation 时只传 query，结果会返回可用 operation/argumentPath。已知目标时可同时传 operationId 和 argumentPath 精确筛选。隐藏值由 Runtime 在 outbound 前解析，绝不能要求用户填写内部 ID 或 Code。",
      strict: true,
      parameters: {
        type: "object",
        properties: {
          operationId: { type: "string", minLength: 1, maxLength: 180 },
          argumentPath: { type: "string", minLength: 1, maxLength: 240, description: "目标 operation 参数路径，例如 path.approvalCode。" },
          query: { type: "string", maxLength: 240 },
          limit: { type: "integer", minimum: 1, maximum: 20 },
        },
        required: [],
        additionalProperties: false,
      },
    }] : []),
    {
      type: "function",
      name: names.describe,
      description: "读取一个已授权 OpenAPI operation 的精确参数、请求体与治理合同。当用户需要查看、选择、调整或确认 schema 可表达的参数时，优先使用 parameter_card 展示模式；只有结果真实包含 parameterCard 才表示卡片已生成。",
      strict: false,
      parameters: {
        type: "object",
        properties: {
          operationId: { type: "string", minLength: 1, maxLength: 180 },
          presentation: { type: "string", enum: ["contract", "parameter_card"], description: "需要用户配置、预览或确认参数时优先选择 parameter_card。" },
          suggestedArguments: { type: "object", additionalProperties: true, description: "用于预填卡片的已验证引用、用户已给值和合同建议；不得猜测缺失引用。" },
        },
        required: ["operationId"],
        additionalProperties: false,
      },
    },
    {
      type: "function",
      name: names.invoke,
      description: "按已读取的 OpenAPI operationId 执行请求。参数会再次按当前合同验证；path/query/headers/body 必须与 describe 返回的 argumentSchema 一致。",
      strict: false,
      parameters: {
        type: "object",
        properties: {
          operationId: { type: "string", minLength: 1, maxLength: 180 },
          path: { type: "object", additionalProperties: true },
          query: { type: "object", additionalProperties: true },
          headers: { type: "object", additionalProperties: true },
          body: {},
        },
        required: ["operationId"],
        additionalProperties: false,
      },
    },
  ];
}

function catalogToolNames(prefix = "") {
  const normalized = String(prefix || "openapi").replace(/[^A-Za-z0-9_-]+/g, "_").slice(0, 40) || "openapi";
  return {
    search: `${normalized}__searchOperations`,
    references: `${normalized}__searchManagedReferences`,
    describe: `${normalized}__describeOperation`,
    invoke: `${normalized}__invokeOperation`,
  };
}

function resolveManagedReferenceArguments(operation = {}, argumentsValue = {}, catalog = null, { allowHiddenValues = false } = {}) {
  if (!catalog) return { ok: true, arguments: argumentsValue };
  const resolvedArguments = structuredClone(argumentsValue);
  const confirmationReviewArguments = structuredClone(argumentsValue);
  const operationId = cleanText(operation.operationId, 180).toLowerCase();
  const argumentPaths = [...new Set((catalog.entries || [])
    .filter((entry) => entry.operationIds?.includes(operationId))
    .flatMap((entry) => entry.argumentPaths || []))];
  for (const argumentPath of argumentPaths) {
    const currentValue = valueAtPath(resolvedArguments, argumentPath);
    if (currentValue === undefined) continue;
    const resolved = resolveManagedReference(catalog, {
      allowHiddenValue: allowHiddenValues,
      operationId,
      argumentPath,
      ref: currentValue,
    });
    if (!resolved) {
      return {
        ok: false,
        error: "managed_reference_not_allowed",
        message: "该业务引用不在当前 Tool binding 的已审核范围内，请重新搜索可用业务引用。",
      };
    }
    setValueAtPath(resolvedArguments, argumentPath, resolved.hiddenValue);
    setValueAtPath(confirmationReviewArguments, argumentPath, resolved.label);
  }
  return { ok: true, arguments: resolvedArguments, confirmationReviewArguments };
}

function setValueAtPath(value, dataPath = "", nextValue) {
  const parts = String(dataPath || "").split(".").filter(Boolean);
  let current = value;
  for (let index = 0; index < parts.length - 1; index += 1) {
    if (!current?.[parts[index]] || typeof current[parts[index]] !== "object" || Array.isArray(current[parts[index]])) return;
    current = current[parts[index]];
  }
  if (current && parts.length) current[parts.at(-1)] = nextValue;
}

function operationSummary(operation = {}) {
  return {
    capabilities: [...new Set((Array.isArray(operation.capabilities) ? operation.capabilities : []).map((value) => cleanText(value, 80)).filter(Boolean))].slice(0, 20),
    executable: operation.executable !== false,
    operationId: operation.operationId,
    operationIdSource: operation.operationIdSource,
    method: operation.method,
    path: operation.path,
    summary: operation.summary,
    tags: operation.tags,
    ...(operation.asyncResult ? {
      asyncResult: {
        contractVersion: operation.asyncResult.contractVersion,
        resultOperationId: operation.asyncResult.resultOperationId,
        timeoutMs: operation.asyncResult.timeoutMs,
      },
    } : {}),
    ...(operation.responseSelection ? {
      responseSelection: {
        contractVersion: operation.responseSelection.contractVersion,
        fieldLabel: operation.responseSelection.fieldLabel,
        maxItems: operation.responseSelection.maxItems,
        minItems: operation.responseSelection.minItems,
        title: operation.responseSelection.title,
      },
    } : {}),
    ...(operation.executable === false ? { unavailableReason: operation.unavailableReason, requestContentTypes: operation.requestBody?.contentTypes || [] } : {}),
  };
}

function responseSelectionParameterCard({ apiBaseUrl = "", data, operation = {}, toolId = "" } = {}) {
  const contract = operation.responseSelection;
  if (!contract || operation.risk !== "read_only") return null;
  const source = firstArrayAtPaths(data, contract.sourcePaths);
  if (!source || source.length < contract.minItems) return null;
  const options = selectionOptions(source, contract);
  if (options.length < contract.minItems) {
    return {
      error: "openapi_response_selection_card_unavailable",
      message: "目标系统返回了多个候选项，但当前 Tool 合同无法安全生成结构化选择卡。",
      parameterCardPresentation: {
        status: "unavailable",
        reason: "response_selection_value_unavailable",
      },
    };
  }
  const parameterCard = createStructuredInputParameterCard({
    title: contract.title,
    description: contract.description.replaceAll("{count}", String(options.length)),
    sourceToolId: toolId || operation.toolId,
    sourceOperationId: operation.operationId,
    fields: [{
      id: contract.fieldId,
      label: contract.fieldLabel,
      type: "single_select",
      required: true,
      options,
    }],
  });
  if (parameterCard) {
    const protectedSelectionEvidence = selectionEvidenceForOptions(source, options, contract, { apiBaseUrl });
    if (protectedSelectionEvidence) parameterCard.protectedSelectionEvidence = protectedSelectionEvidence;
  }
  return parameterCard
    ? { parameterCard, parameterCardPresentation: { status: "ready" } }
    : {
        error: "openapi_response_selection_card_unavailable",
        message: "目标系统返回了多个候选项，但当前 Tool 合同无法安全生成结构化选择卡。",
        parameterCardPresentation: {
          status: "unavailable",
          reason: "response_selection_card_unsupported",
        },
      };
}

function firstArrayAtPaths(value, dataPaths = []) {
  for (const dataPath of dataPaths || []) {
    const candidate = dataPath ? valueAtPath(value, dataPath) : value;
    if (Array.isArray(candidate)) return candidate;
  }
  return null;
}

function selectionOptions(items = [], contract = {}) {
  const seenValues = new Set();
  return items.slice(0, contract.maxItems).flatMap((item) => {
    if (!isObject(item)) return [];
    const label = firstSelectionLabel(item, contract.labelPaths);
    const selectionValue = selectionValueForItem(item, contract.valueTemplate, contract.optionalValueTemplate);
    if (!label || !selectionValue) return [];
    if (seenValues.has(selectionValue)) return [];
    seenValues.add(selectionValue);
    return [{ label, value: selectionValue }];
  });
}

function selectionEvidenceForOptions(items = [], options = [], contract = {}, { apiBaseUrl = "" } = {}) {
  if (!Object.keys(contract.evidenceTemplate || {}).length) return null;
  const byValue = new Map(options.map((option) => [option.value, option]));
  const evidenceOptions = items.slice(0, contract.maxItems).flatMap((item) => {
    if (!isObject(item)) return [];
    const value = selectionValueForItem(item, contract.valueTemplate, contract.optionalValueTemplate);
    if (!byValue.has(value)) return [];
    const rawEvidence = selectionEvidenceValue(item, contract.evidenceTemplate);
    const safeContext = projectOpenApiResultForAgent(rawEvidence);
    const rawPresentationEvidence = Object.keys(contract.presentationLinkTemplate || {}).length
      ? selectionEvidenceValue(item, contract.presentationLinkTemplate)
      : rawEvidence;
    const presentationLinks = selectionPresentationLinks(rawPresentationEvidence, {
      apiBaseUrl,
      labelOverride: contract.presentationLinkLabel,
    });
    if (!Object.keys(safeContext || {}).length && !presentationLinks.length) return [];
    return [{ value, safeContext, presentationLinks }];
  });
  return evidenceOptions.length ? {
    contractVersion: "tool-parameter-protected-selection-evidence.v1",
    fieldId: contract.fieldId,
    options: evidenceOptions,
  } : null;
}

function selectionEvidenceValue(item = {}, evidenceTemplate = {}) {
  return Object.fromEntries(Object.entries(evidenceTemplate).flatMap(([key, dataPaths]) => {
    for (const dataPath of dataPaths || []) {
      const value = valueAtPath(item, dataPath);
      if (value !== undefined && value !== null && value !== "") return [[key, structuredClone(value)]];
    }
    return [];
  }));
}

function channelPresentationEvidenceForOpenApiResult(value = {}, { apiBaseUrl = "", resultPresentation = null } = {}) {
  if (resultPresentation?.linkMode === "none") return null;
  const rawPresentationEvidence = resultPresentation?.linkMode === "template"
    ? selectionEvidenceValue(value, resultPresentation.linkTemplate)
    : value;
  const links = selectionPresentationLinks(rawPresentationEvidence, {
    apiBaseUrl,
    labelOverride: resultPresentation?.linkLabel,
  });
  return links.length ? {
    contractVersion: "channel-presentation-evidence.v1",
    links,
  } : null;
}

function selectionPresentationLinks(value = {}, { apiBaseUrl = "", labelOverride = "" } = {}) {
  const links = [];
  const seen = new Set();
  const add = (label, target) => {
    const url = safePresentationUrl(target, { apiBaseUrl });
    const safeLabel = cleanText(labelOverride || label, 240);
    const key = `${safeLabel}\n${url}`;
    if (!safeLabel || !url || seen.has(key) || links.length >= 12) return;
    seen.add(key);
    links.push({ label: safeLabel, url });
  };
  const visit = (current, parent = null, key = "", depth = 0) => {
    if (depth > 10 || current === null || current === undefined) return;
    if (typeof current === "string") {
      for (const match of current.matchAll(/\[([^\]\n]+)\]\(([^)\s]+)\)/g)) add(match[1], match[2]);
      if (/(?:url|link|href|uri)$/i.test(key) && !UNSAFE_PRESENTATION_LINK_KEYS.test(key)) {
        const label = isObject(parent)
          ? ["courseTitle", "courseName", "trainingTitle", "trainingName", "meetingTitle", "fileName", "filename", "displayName", "topicTitle", "assessmentTitle", "title", "label", "name"].map((field) => parent[field]).find((item) => typeof item === "string")
          : "";
        add(label || "打开链接", current);
      }
      return;
    }
    if (Array.isArray(current)) {
      for (const item of current.slice(0, 50)) visit(item, null, "", depth + 1);
      return;
    }
    if (!isObject(current)) return;
    const entries = Object.entries(current)
      .filter(([childKey]) => !REDACTED_KEYS.test(childKey))
      .sort((left, right) => presentationLinkEntryRank(left[0]) - presentationLinkEntryRank(right[0]) || left[0].localeCompare(right[0]))
      .slice(0, 30);
    for (const [childKey, childValue] of entries) {
      if (REDACTED_KEYS.test(childKey)) continue;
      visit(childValue, current, childKey, depth + 1);
    }
  };
  visit(value);
  return links;
}

function presentationLinkEntryRank(key = "") {
  const normalized = String(key || "").trim();
  if (/^(?:courseUrl|courseLink|courseHref|trainingUrl|trainingLink|trainingHref|trainingVideoUrl|trainingVideoLink|courseVideoUrl|courseVideoLink|coursePageUrl|trainingPageUrl)$/i.test(normalized)) return 0;
  if (/^(?:course|trainingCourse|courseInfo|course_info|trainingInfo|training_info)$/i.test(normalized)) return 1;
  if (/^(?:url|link|href|uri)$/i.test(normalized) && !/(?:download|file|material)/i.test(normalized)) return 2;
  if (/^(?:downloadUrl|downloadLink|fileUrl|fileLink)$/i.test(normalized)) return 3;
  if (/^(?:materialFiles|courseMaterials|materials|learningMaterials|learning_materials)$/i.test(normalized)) return 4;
  return 5;
}

function safePresentationUrl(value = "", { apiBaseUrl = "" } = {}) {
  const text = String(value || "").trim();
  if (!text || text.length > 2_048) return "";
  try {
    const absolute = /^[A-Za-z][A-Za-z0-9+.-]*:/.test(text);
    const base = safeApiBaseUrl(apiBaseUrl);
    const url = absolute
      ? new URL(text)
      : base && /^(?:\/|\.{1,2}\/)/.test(text)
        ? new URL(text, `${base}/`)
        : null;
    if (!url || !["http:", "https:"].includes(url.protocol) || url.username || url.password || url.href.length > 2_048) return "";
    url.hash = "";
    if (!safeApiBaseUrl(url.origin)) return "";
    return url.href;
  } catch {
    return "";
  }
}

function firstSelectionLabel(item = {}, labelPaths = []) {
  for (const labelPath of labelPaths || []) {
    const value = labelPath ? valueAtPath(item, labelPath) : item;
    const label = cleanText(value, 120);
    if (label) return label;
  }
  return "";
}

function selectionValueForItem(item = {}, valueTemplate = {}, optionalValueTemplate = {}) {
  const value = {};
  for (const [key, dataPaths] of Object.entries(valueTemplate || {})) {
    const itemValue = firstScalarAtPaths(item, dataPaths);
    if (!["string", "number", "boolean"].includes(typeof itemValue) || itemValue === "") return "";
    value[key] = itemValue;
  }
  for (const [key, dataPaths] of Object.entries(optionalValueTemplate || {})) {
    if (Object.hasOwn(value, key)) continue;
    const itemValue = firstScalarAtPaths(item, dataPaths);
    if (!["string", "number", "boolean"].includes(typeof itemValue) || itemValue === "") continue;
    const nextValue = { ...value, [key]: itemValue };
    if (Buffer.byteLength(JSON.stringify(nextValue), "utf8") <= 240) value[key] = itemValue;
  }
  const serialized = JSON.stringify(value);
  return Buffer.byteLength(serialized, "utf8") <= 240 ? serialized : "";
}

function firstScalarAtPaths(item = {}, dataPaths = []) {
  for (const dataPath of dataPaths || []) {
    const value = valueAtPath(item, dataPath);
    if (["string", "number", "boolean"].includes(typeof value) && value !== "") return value;
  }
  return undefined;
}

function valueAtPath(value, dataPath = "") {
  return String(dataPath || "").split(".").filter(Boolean).reduce((current, key) => current?.[key], value);
}

function schemaHasPath(schema = {}, dataPath = "") {
  const parts = String(dataPath || "").split(".").filter(Boolean);
  let current = schema;
  for (const part of parts) {
    current = current?.properties?.[part];
    if (!current) return false;
  }
  return Boolean(parts.length);
}

function cancellableDelay(milliseconds, signal = null) {
  if (signal?.aborted) return Promise.reject(canceledRequestError());
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, milliseconds);
    signal?.addEventListener?.("abort", () => {
      clearTimeout(timer);
      reject(canceledRequestError());
    }, { once: true });
  });
}

function openApiToolInvocationCheck({
  allOperations = [],
  binding = {},
  confirmation = null,
  confirmationContext = {},
  confirmationService = null,
  operation = null,
  toolCall = {},
} = {}) {
  if (!operation || !sameGovernedOpenApiCall(toolCall, operation)) {
    return { status: "blocked", reason: "tool_invocation_not_allowed", nextGate: "OpenAPI Tool 调用与当前合同 operation 不一致。" };
  }
  if (!operationAllowedByBinding(binding, operation, allOperations)) {
    return { status: "blocked", reason: "openapi_operation_not_granted", nextGate: "该 operation 未进入当前 Tool 的结构化授权策略边界。" };
  }
  if (operation.confirmationPolicy === "explicit_per_call") {
    if (!confirmationService?.authorizeOrRequest) return { status: "human_review_required", reason: "tool_confirmation_service_unavailable", nextGate: "本次高影响 operation 缺少结构化确认服务。" };
    return confirmationService.authorizeOrRequest({ confirmation, context: confirmationContext, toolCall });
  }
  return {
    status: "allowed",
    reason: operation.confirmationPolicy === "operation_allowlist" ? "openapi_controlled_write_allowed" : "openapi_operation_allowed",
    nextGate: operation.confirmationPolicy === "operation_allowlist"
      ? "已通过结构化 Tool 授权策略；目标系统当前用户 RBAC 将执行最终业务授权。"
      : "已通过 OpenAPI operation、scope、risk 和 writeback boundary 门禁。",
  };
}

function driftedWritePolicyCapabilities({ authorizationPolicy = {}, contractDigest = "", currentWritePolicyDigests = {} } = {}) {
  if (authorizationPolicy.valid === false || authorizationPolicy.mode !== "contract_capability") return [];
  if (authorizationPolicy.contractVersion === "tool-authorization-policy.v1") {
    return authorizationPolicy.policyContractDigest === contractDigest ? [] : [...authorizationPolicy.allowedCapabilities].sort();
  }
  return authorizationPolicy.allowedCapabilities
    .filter((capability) => authorizationPolicy.approvedWritePolicyDigests?.[capability] !== currentWritePolicyDigests[capability])
    .sort();
}

function runtimePolicyBlockReason({ authorizationPolicy = {}, operationCount = 0 } = {}) {
  if (authorizationPolicy.valid === false) return authorizationPolicy.invalidReason || "tool_authorization_policy_invalid";
  if (!operationCount) return "openapi_authorized_operation_scope_empty";
  return "";
}

function safeContractUrl(value = "") {
  try {
    const url = new URL(String(value || "").trim());
    if (!safeApiBaseUrl(url.origin) || url.username || url.password) return "";
    url.hash = "";
    return url.toString();
  } catch { return ""; }
}

function defaultRequestJson(url, { allowSelfSignedCertificate = false, method = "GET", headers = {}, body, maxBytes = MAX_RESPONSE_BYTES, signal = null } = {}) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(canceledRequestError());
    const target = new URL(url);
    const transport = target.protocol === "https:" ? https : http;
    const request = transport.request(target, { method, headers, ...(signal ? { signal } : {}), ...(target.protocol === "https:" ? { rejectUnauthorized: !allowSelfSignedCertificate } : {}) }, (response) => {
      const chunks = [];
      let totalBytes = 0;
      response.on("data", (chunk) => {
        totalBytes += chunk.length;
        if (totalBytes > maxBytes) request.destroy(new Error("openapi_response_too_large"));
        else chunks.push(chunk);
      });
      response.on("end", () => {
        try {
          const text = Buffer.concat(chunks).toString("utf8");
          let responseBody = {};
          if (text) {
            const contentType = String(response.headers["content-type"] || "").toLowerCase();
            responseBody = /(?:application|text)\/(?:[^;]+\+)?json\b/.test(contentType)
              ? JSON.parse(text)
              : text;
          }
          resolve({ statusCode: Number(response.statusCode || 0), headers: response.headers, body: responseBody });
        } catch (error) { reject(error); }
      });
    });
    request.setTimeout(15_000, () => request.destroy(new Error("openapi_request_timeout")));
    request.on("error", reject);
    request.end(body === undefined ? undefined : Buffer.isBuffer(body) ? body : JSON.stringify(body));
  });
}

function canceledRequestError() {
  const error = new Error("agent_turn_canceled");
  error.code = "agent_turn_canceled";
  return error;
}

function normalizeMaterialInputs(values = []) {
  if (!Array.isArray(values)) return [];
  return values.slice(0, 8).map((item) => {
    const inputId = cleanText(item?.inputId, 160);
    const filePath = String(item?.filePath || "");
    const fileName = path.basename(String(item?.fileName || "attachment")).replace(/["\r\n]/g, "_").slice(0, 160);
    const mimeType = cleanText(item?.mimeType || "application/octet-stream", 120).split(";", 1)[0];
    const sizeBytes = Number(item?.sizeBytes || 0);
    return inputId && filePath && fileName && Number.isSafeInteger(sizeBytes) && sizeBytes > 0
      ? { inputId, filePath, fileName, mimeType, sizeBytes }
      : null;
  }).filter(Boolean);
}

function prepareMultipartRequest(operation = {}, body, materialInputById = new Map()) {
  if (operation.requestBody?.contentType !== "multipart/form-data") {
    return { ok: true, body, headers: {} };
  }
  const boundary = `digital-workforce-${crypto.randomBytes(18).toString("hex")}`;
  const chunks = [];
  let totalBytes = 0;
  for (const [field, value] of Object.entries(body || {})) {
    if (!/^[A-Za-z0-9_.-]{1,120}$/.test(field)) {
      return { ok: false, error: "multipart_field_invalid", message: "multipart 字段名不安全或超出长度限制。" };
    }
    if (operation.requestBody.binaryFields.includes(field)) {
      const material = materialInputById.get(String(value || ""));
      if (!material) return { ok: false, error: "material_input_not_found", message: "当前回合没有对应的已授权材料 inputId。" };
      let metadata;
      try { metadata = fs.statSync(material.filePath); } catch { return { ok: false, error: "material_input_unavailable", message: "当前材料已过期或不可读取。" }; }
      if (!metadata.isFile() || metadata.size !== material.sizeBytes || metadata.size > MAX_MATERIAL_INPUT_BYTES) {
        return { ok: false, error: "material_input_size_invalid", message: "当前材料为空、已变化或超过单文件限制。" };
      }
      const bytes = fs.readFileSync(material.filePath);
      if (bytes.length !== material.sizeBytes) {
        return { ok: false, error: "material_input_size_invalid", message: "当前材料在读取期间发生变化。" };
      }
      chunks.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${field}"; filename="${material.fileName}"\r\nContent-Type: ${material.mimeType}\r\n\r\n`, "utf8"), bytes, Buffer.from("\r\n"));
    } else {
      chunks.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${field}"\r\n\r\n${String(value)}\r\n`, "utf8"));
    }
    totalBytes = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
    if (totalBytes > MAX_MULTIPART_BODY_BYTES) return { ok: false, error: "multipart_body_too_large", message: "本次 multipart 请求超过受控材料大小限制。" };
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`, "utf8"));
  const multipartBody = Buffer.concat(chunks);
  if (multipartBody.length > MAX_MULTIPART_BODY_BYTES) return { ok: false, error: "multipart_body_too_large", message: "本次 multipart 请求超过受控材料大小限制。" };
  return {
    ok: true,
    body: multipartBody,
    headers: {
      "Content-Length": String(multipartBody.length),
      "Content-Type": `multipart/form-data; boundary=${boundary}`,
    },
  };
}

function safePayload(value) {
  // Reserve envelope depth for { ok, data, ... } in the subsequent Agent projection.
  return projectBoundedPayload(value, "", 2, false);
}

function isResponseLimitError(error) {
  return error instanceof RangeError && error.message === "openapi_response_limit_exceeded";
}

function responseLimitFailure(toolId) {
  return toolFailure(toolId, "response_limit_exceeded", "OpenAPI Tool 响应超过安全结果上限，未返回部分数据；不能用不完整结果构造写入。");
}

function projectBoundedPayload(value, key, depth, forAgent) {
  if (depth > MAX_PAYLOAD_DEPTH || (Array.isArray(value) && value.length > MAX_COLLECTION_ITEMS)
    || (typeof value === "string" && value.length > MAX_PAYLOAD_STRING_LENGTH)) {
    throw new RangeError("openapi_response_limit_exceeded");
  }
  if (value === null || value === undefined) return value;
  if (typeof value === "string") return forAgent ? projectOpenApiStringForAgent(value, key) : value;
  if (["number", "boolean"].includes(typeof value)) return value;
  if (Array.isArray(value)) return value.map((item) => projectBoundedPayload(item, "", depth + 1, forAgent));
  if (typeof value !== "object") return String(value);
  return Object.fromEntries(Object.entries(value).flatMap(([childKey, childValue]) => {
    if (REDACTED_KEYS.test(childKey) || (forAgent && PROTECTED_RUNTIME_KEYS.has(childKey))) return [];
    return [[childKey, projectBoundedPayload(childValue, childKey, depth + 1, forAgent)]];
  }));
}

function rememberReferenceEvidence(evidence, value, { depth = 0, operation = {} } = {}) {
  if (depth > 8 || !value) return;
  if (Array.isArray(value)) {
    value.slice(0, MAX_COLLECTION_ITEMS).forEach((item) => rememberReferenceEvidence(evidence, item, { depth: depth + 1, operation }));
    return;
  }
  if (!isObject(value)) return;
  const scalarEntries = Object.entries(value).filter(([, item]) => ["string", "number"].includes(typeof item) && String(item).trim());
  const idEntries = scalarEntries.filter(([key]) => /(?:^id$|id$)/i.test(key));
  const operationKind = referenceKindFromOperationPath(operation.path);
  for (const [key, item] of idEntries) {
    const label = referenceLabelFromObject(scalarEntries, key, idEntries.length);
    if (label) {
      const evidenceKey = referenceEvidenceKey(item);
      const records = evidence.get(evidenceKey) || [];
      const kind = normalizedReferenceKind(key) || operationKind;
      if (!records.some((record) => record.key === key && record.kind === kind && record.label === label)) records.push({ key, kind, label });
      evidence.set(evidenceKey, records.slice(0, 12));
    }
  }
  Object.values(value).forEach((item) => rememberReferenceEvidence(evidence, item, { depth: depth + 1, operation }));
}

function referenceLabelFromObject(entries = [], referenceKey = "", referenceCount = 0) {
  const normalizedKey = referenceKey.toLowerCase();
  const stem = normalizedKey.replace(/id$/, "");
  const pairedKeys = [
    `${stem}displayname`, `${stem}name`, `${stem}title`, `${stem}label`, `${stem}role`,
    normalizedKey === "appliedjobid" ? "appliedrole" : "",
    normalizedKey === "recommendedjobid" ? "recommendedrole" : "",
  ].filter(Boolean);
  const allowedKeys = referenceCount === 1
    ? [...pairedKeys, "displayname", "name", "label", "title", "role"]
    : pairedKeys;
  for (const expected of allowedKeys) {
    const match = entries.find(([key]) => key.toLowerCase() === expected);
    if (match) return cleanText(match[1], 160);
  }
  return "";
}

function resolveReferenceLabel(evidence, fieldKey = "", value) {
  const records = evidence.get(referenceEvidenceKey(value)) || [];
  const fieldKind = normalizedReferenceKind(fieldKey);
  const exact = records.filter((record) => record.kind && record.kind === fieldKind);
  const candidates = exact.length ? exact : records;
  const labels = [...new Set(candidates.map((record) => record.label).filter(Boolean))];
  return labels.length === 1 ? labels[0] : "";
}

function normalizedReferenceKind(key = "") {
  return String(key).toLowerCase()
    .replace(/[^a-z0-9]/g, "")
    .replace(/^(?:applied|recommended|target|source)/, "")
    .replace(/id$/, "");
}

function referenceKindFromOperationPath(operationPath = "") {
  const literalSegments = String(operationPath).split("/").filter((segment) => segment && !/^\{[^}]+\}$/.test(segment));
  const segment = normalizedReferenceKind(literalSegments.at(-1) || "");
  if (segment.endsWith("ies") && segment.length > 3) return `${segment.slice(0, -3)}y`;
  if (segment.endsWith("s") && !segment.endsWith("ss") && segment.length > 3) return segment.slice(0, -1);
  return segment;
}

function referenceEvidenceKey(value) {
  return `${typeof value}:${String(value)}`;
}

function boundedResult(result, toolId) {
  return Buffer.byteLength(JSON.stringify(result), "utf8") <= MAX_RESULT_BYTES ? result : toolFailure(toolId, "response_limit_exceeded", "OpenAPI Tool 结果超过单次 Agent 结果上限。");
}

function projectOpenApiResultForAgent(value, key = "", depth = 0) {
  return projectBoundedPayload(value, key, depth, true);
}

function projectOpenApiStringForAgent(value = "", key = "") {
  const text = String(value || "");
  if (/(?:url|link|href|uri)$/i.test(key) && safeHttpUrl(text)) return CHANNEL_LINK_PLACEHOLDER;
  return text
    .replace(/\[([^\]\n]+)\]\((https?:\/\/[^)\s]+)\)/gi, `$1（${CHANNEL_LINK_PLACEHOLDER}）`)
    .replace(/https?:\/\/[^\s<>()\[\]{}"'，。！？；]+/gi, CHANNEL_LINK_PLACEHOLDER);
}

function safeHttpUrl(value = "") {
  try {
    const url = new URL(String(value || "").trim());
    return ["http:", "https:"].includes(url.protocol) && !url.username && !url.password;
  } catch {
    return false;
  }
}

function safeFailureDiagnostics(response = {}, operationId = "") {
  const body = isObject(response.body) ? response.body : {};
  const xErrorCode = safeDiagnosticText(responseHeader(response.headers, "x-error-code"), 180);
  const code = safeDiagnosticText(body.code ?? body.error?.code ?? body.error, 180);
  const msg = safeDiagnosticText(body.msg ?? body.message ?? body.error?.message, 1_000);
  return {
    operationId: cleanText(operationId, 180),
    httpStatus: Number(response.statusCode || 0),
    ...(xErrorCode ? { xErrorCode } : {}),
    ...(code ? { code } : {}),
    ...(msg ? { msg } : {}),
  };
}

function targetAuthenticationConfigurationRequired(diagnostics = {}) {
  return [diagnostics.code, diagnostics.xErrorCode]
    .map((value) => String(value || "").trim().toUpperCase())
    .includes("API_KEY_REQUIRED");
}

function responseHeader(headers, expectedName) {
  if (typeof headers?.get === "function") return headers.get(expectedName) || "";
  if (!isObject(headers)) return "";
  const match = Object.entries(headers).find(([name]) => name.toLowerCase() === expectedName);
  const value = match?.[1];
  return Array.isArray(value) ? value[0] : value;
}

function safeDiagnosticText(value, max) {
  if (!["string", "number", "boolean"].includes(typeof value)) return "";
  return String(value)
    .trim()
    .slice(0, max)
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [REDACTED]")
    .replace(/(["']?)(authorization|token|password|secret|credential|cookie|api[-_ ]?key)\1\s*(?:[:=]|\bis\b)\s*(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi, "$1$2$1=[REDACTED]")
    .slice(0, max);
}

function credentialFailure(toolId, error, message, credentialStatus, diagnostics = {}) {
  return { ...toolFailure(toolId, error, message), ...diagnostics, credentialStatus, clearCredential: credentialStatus === "rejected" };
}

function normalizeCredentialResolution(value) {
  if (!isObject(value)) return null;
  if (cleanText(value.credentialError, 180)) {
    return {
      credentialError: cleanText(value.credentialError, 180),
      headers: {},
      leaseRef: "",
      ...(safeAuthorizationAction(value.authorizationAction)
        ? { authorizationAction: safeAuthorizationAction(value.authorizationAction) }
        : {}),
    };
  }
  if (isObject(value.headers)) {
    return { headers: value.headers, leaseRef: cleanText(value.leaseRef, 240) };
  }
  return { headers: value, leaseRef: "" };
}

function normalizeManagedRequestHeaders(value = []) {
  const entries = Array.isArray(value)
    ? value
    : isObject(value) ? Object.entries(value).map(([name, headerValue]) => ({ name, value: headerValue })) : [];
  const headers = {};
  const protectedNames = new Set();
  for (const entry of entries) {
    const name = cleanManagedHeaderName(entry?.name);
    if (!name) continue;
    protectedNames.add(name.toLowerCase());
    const headerValue = cleanManagedHeaderValue(entry?.value);
    if (headerValue) headers[name] = headerValue;
  }
  return Object.freeze({ headers: Object.freeze(headers), protectedNames });
}

function omitManagedRequestHeaders(headers = {}, protectedNames = new Set()) {
  if (!isObject(headers) || !protectedNames.size) return headers;
  const safe = {};
  for (const [name, value] of Object.entries(headers)) {
    if (protectedNames.has(String(name || "").trim().toLowerCase())) continue;
    safe[name] = value;
  }
  return safe;
}

function cleanManagedHeaderName(value = "") {
  const name = String(value || "").trim();
  if (!/^[!#$%&'*+\-.^_`|~0-9A-Za-z]{1,120}$/.test(name)) return "";
  if (new Set(["accept", "authorization", "content-length", "content-type", "cookie", "host", "set-cookie"])
    .has(name.toLowerCase())) return "";
  return name;
}

function cleanManagedHeaderValue(value = "") {
  const text = String(value || "").trim();
  return text && text.length <= 8 * 1024 && !/[\r\n]/.test(text) ? text : "";
}

function safeAuthorizationAction(value) {
  if (!isObject(value) || value.contractVersion !== "current-user-tool-authorization-action.v1" || value.kind !== "open_url") return null;
  try {
    const url = new URL(cleanText(value.url, 4_000));
    const expiresAt = new Date(value.expiresAt);
    if (url.protocol !== "https:" || url.hostname !== "accounts.feishu.cn" ||
      url.pathname !== "/open-apis/authen/v1/authorize" || !Number.isFinite(expiresAt.getTime())) return null;
    return {
      contractVersion: value.contractVersion,
      kind: value.kind,
      label: cleanText(value.label, 80),
      url: url.toString(),
      expiresAt: expiresAt.toISOString(),
    };
  } catch {
    return null;
  }
}

async function rejectCredential(handler, context) {
  if (typeof handler !== "function") return;
  try {
    await handler(context);
  } catch {
    // Credential invalidation is best-effort; the rejected result remains authoritative.
  }
}

function toolFailure(toolId, error, message, status = "blocked") { return { ok: false, status, toolId, error, message }; }
function cleanText(value = "", max = 4_000) { return String(value || "").trim().slice(0, max); }

function sideEffectFreeOperationCacheKey(operation = {}, argumentsValue = {}) {
  return crypto.createHash("sha256").update(JSON.stringify({
    operationId: cleanText(operation.operationId, 180),
    arguments: canonicalCacheValue(argumentsValue),
  })).digest("hex");
}

function canonicalCacheValue(value) {
  if (Array.isArray(value)) return value.map(canonicalCacheValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalCacheValue(value[key])]));
}
function isObject(value) { return Boolean(value) && typeof value === "object" && !Array.isArray(value); }

export {
  createOpenApiToolExecutor,
  defaultRequestJson,
  loadOpenApiDocument,
  normalizeManagedRequestHeaders,
  openApiToolInvocationCheck,
};
