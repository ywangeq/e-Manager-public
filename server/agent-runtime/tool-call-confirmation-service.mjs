import crypto from "node:crypto";
import { DEFAULT_PROVIDER_TIMEOUT_POLICY, normalizeProviderTimeoutPolicy } from "./provider-timeout-policy.mjs";
import { acceptedConfirmationMatches, confirmationRetentionDeadline, normalizeConfirmationInputSnapshot } from "./tool-call-confirmation-acceptance.mjs";

const CONTRACT_VERSION = "tool-call-confirmation.v1";
const DEFAULT_TTL_MS = 5 * 60 * 1000;
const MAX_PENDING_CONFIRMATIONS = 100;
const REDACTED_KEYS = /authorization|bearer|token|password|secret|credential/i;

function createToolCallConfirmationService({ now = () => Date.now(), repository = null, ttlMs = DEFAULT_TTL_MS, verifyAcceptedExecution = null } = {}) {
  const pending = new Map();
  const pendingByFingerprint = new Map();

  function authorizeOrRequest({ confirmation = null, context = {}, toolCall = {} } = {}) {
    pruneExpired();
    const normalized = normalizedCall(toolCall);
    const contextBinding = confirmationContextBinding(context);
    if (!normalized || !contextBinding) {
      return {
        status: "blocked",
        reason: "tool_confirmation_context_invalid",
        nextGate: "本次写操作缺少可验证的会话或 Tool 上下文。",
      };
    }

    const requestedId = cleanId(confirmation?.id);
    if (confirmation?.contractVersion === CONTRACT_VERSION && confirmation?.decision === "approved" && requestedId) {
      const expectedDigest = callDigest(normalized);
      const candidate = repository?.get ? repository.get(requestedId) : pending.get(requestedId);
      if (candidate?.acceptance && !acceptedExecutionValid(candidate, confirmation, context)) {
        return { status: "blocked", reason: "tool_confirmation_accepted_execution_invalid", nextGate: "已接收审批仅可由其绑定的有效任务执行。" };
      }
      const record = repository?.consume
        ? repository.consume({ id: requestedId, contextBinding, callDigest: expectedDigest, executionInputBinding: confirmation.executionInputBinding, taskId: context.taskId })
        : pending.get(requestedId);
      if (record && confirmationRetentionDeadline(record) > now() && record.contextBinding === contextBinding && record.callDigest === callDigest(normalized)) {
        if (!repository?.consume) {
          pending.delete(requestedId);
          pendingByFingerprint.delete(record.fingerprint);
        }
        return {
          status: "allowed",
          reason: "tool_call_confirmation_verified",
          nextGate: "本次 Tool 调用已通过一次性结构化确认。",
          confirmationId: requestedId,
        };
      }
    }

    const confirmationRequest = issueRequest({ contextBinding, normalized, sourceTaskId: cleanId(context.taskId) });
    return {
      status: "human_review_required",
      reason: requestedId ? "tool_call_confirmation_mismatch" : "tool_call_confirmation_required",
      nextGate: requestedId
        ? "原确认已失效、已使用或与本次 Tool 参数不一致，请审核新的结构化确认卡。"
        : "请审核结构化确认卡；确认只对当前会话中的本次准确 Tool 参数生效。",
      confirmationRequest,
    };
  }

  function approvedToolCall({ confirmation = null, context = {} } = {}) {
    pruneExpired();
    const requestedId = cleanId(confirmation?.id);
    const contextBinding = confirmationContextBinding(context);
    if (confirmation?.contractVersion !== CONTRACT_VERSION || confirmation?.decision !== "approved" || !requestedId || !contextBinding) return null;
    const record = repository?.get ? repository.get(requestedId) : pending.get(requestedId);
    if (!record || confirmationRetentionDeadline(record) <= now() || record.contextBinding !== contextBinding
      || (record.acceptance && !acceptedExecutionValid(record, confirmation, context))) return null;
    return { ...structuredClone(record.toolCall), callId: `confirmation:${requestedId}` };
  }

  // Private execution context: never expose this reference in the public card.
  function approvedSourceTaskId({ confirmation, context } = {}) {
    const contextBinding = confirmationContextBinding(context);
    if (confirmation?.contractVersion !== CONTRACT_VERSION || confirmation?.decision !== "approved" ||
      !cleanId(confirmation.id) || !contextBinding) return "";
    const record = repository?.get ? repository.get(confirmation.id) : pending.get(confirmation.id);
    if (!record || record.contextBinding !== contextBinding || confirmationRetentionDeadline(record) <= now() ||
      (context.taskId && record.acceptance && !acceptedExecutionValid(record, confirmation, context))) return "";
    return cleanId(record.sourceTaskId);
  }

  function issueRequest({ contextBinding, normalized, sourceTaskId = "" }) {
    const digest = callDigest(normalized);
    const fingerprint = digestValue(`${contextBinding}:${sourceTaskId}:${digest}`);
    const existingId = pendingByFingerprint.get(fingerprint);
    const existing = existingId ? pending.get(existingId) : null;
    if (existing && confirmationRetentionDeadline(existing) > now()) return publicRequest(existing);

    while (pending.size >= MAX_PENDING_CONFIRMATIONS) {
      const oldestId = pending.keys().next().value;
      const oldest = pending.get(oldestId);
      pending.delete(oldestId);
      if (oldest) pendingByFingerprint.delete(oldest.fingerprint);
    }

    const issuedAtMs = now();
    const expiresAtMs = issuedAtMs + normalized.confirmationTtlMs;
    const record = {
      id: crypto.randomUUID(),
      contextBinding,
      sourceTaskId,
      callDigest: digest,
      fingerprint,
      issuedAtMs,
      expiresAtMs,
      toolCall: structuredClone(normalized.confirmationExecutionCall),
      request: confirmationRequest({ id: "", normalized, issuedAtMs, expiresAtMs }),
    };
    record.request.id = record.id;
    if (repository?.saveOrGet) return publicRequest(repository.saveOrGet(record));
    pending.set(record.id, record);
    pendingByFingerprint.set(fingerprint, record.id);
    return publicRequest(record);
  }

  function publicRequest(record) {
    return {
      ...record.request,
      ...(record.acceptance ? { status: "accepted" } : {}),
      scope: [...record.request.scope],
      argumentSummary: safeReviewValue(record.request.argumentSummary),
    };
  }

  function confirmationRequest({ id, normalized: call, issuedAtMs, expiresAtMs }) {
    return {
      contractVersion: CONTRACT_VERSION,
      id,
      status: "pending",
      displayName: call.displayName,
      toolId: call.toolId,
      operationId: call.operationId,
      action: call.action,
      risk: call.risk,
      scope: [...call.scope],
      writebackBoundary: call.writebackBoundary,
      argumentSummary: safeReviewValue(call.reviewArguments),
      issuedAt: new Date(issuedAtMs).toISOString(),
      expiresAt: new Date(expiresAtMs).toISOString(),
    };
  }

  function pruneExpired() {
    const at = now();
    repository?.pruneExpired?.(at);
    for (const [id, record] of pending) {
      if (confirmationRetentionDeadline(record) > at) continue;
      pending.delete(id);
      pendingByFingerprint.delete(record.fingerprint);
    }
  }

  function pendingRequests(context = {}) {
    const contextBinding = confirmationContextBinding(context);
    if (!contextBinding) return [];
    pruneExpired();
    const records = repository?.listPending ? repository.listPending(contextBinding) : [...pending.values()];
    return records.filter(record => !record.acceptance && record.expiresAtMs > now() && record.contextBinding === contextBinding && (!context.taskId || record.sourceTaskId === context.taskId)).map(publicRequest);
  }

  function acceptApproval({ confirmation, context, requestId, inputSnapshot = null, providerTimeoutPolicy = DEFAULT_PROVIDER_TIMEOUT_POLICY } = {}) {
    const snapshot = inputSnapshot === null ? null : normalizeConfirmationInputSnapshot(inputSnapshot);
    if (inputSnapshot !== null && !snapshot) return null;
    const contextBinding = confirmationContextBinding(context);
    if (confirmation?.contractVersion !== CONTRACT_VERSION || confirmation?.decision !== "approved" || !cleanId(confirmation.id)
      || !contextBinding || !cleanText(requestId, 500)) return null;
    const requestBinding = digestValue(`${contextBinding}:${requestId}`);
    const acceptedAtMs = now();
    const executeBeforeMs = acceptedAtMs + normalizeProviderTimeoutPolicy(providerTimeoutPolicy).taskExecutionTotalMs;
    let record;
    if (repository?.accept) record = repository.accept({ id: confirmation.id, contextBinding, requestBinding, acceptedAtMs, executeBeforeMs, inputSnapshot: snapshot });
    else {
      record = pending.get(confirmation.id);
      if (!record || record.contextBinding !== contextBinding || confirmationRetentionDeadline(record) <= acceptedAtMs) return null;
      if (record.acceptance) {
        if (record.acceptance.requestBinding !== requestBinding) return null;
      } else {
        if (record.expiresAtMs <= acceptedAtMs || record.executionInputBinding) return null;
        record.acceptance = { requestBinding, acceptedAtMs, executeBeforeMs, ...(snapshot ? { inputSnapshot: snapshot } : {}) };
        record.expiresAtMs = 0;
      }
    }
    return record ? { contractVersion: "tool-confirmation-admission.v1", id: record.id, status: "accepted",
      acceptedAt: new Date(record.acceptance.acceptedAtMs).toISOString(), executeBefore: new Date(record.acceptance.executeBeforeMs).toISOString() } : null;
  }

  function acceptedInputSnapshot({ confirmation, context, requestId } = {}) {
    const contextBinding = confirmationContextBinding(context);
    if (!contextBinding || confirmation?.contractVersion !== CONTRACT_VERSION || confirmation?.decision !== "approved" ||
      !cleanId(confirmation.id) || !cleanText(requestId, 500)) return null;
    const record = repository?.get ? repository.get(confirmation.id) : pending.get(confirmation.id);
    if (!record?.acceptance || record.contextBinding !== contextBinding || confirmationRetentionDeadline(record) <= now() ||
      record.acceptance.requestBinding !== digestValue(`${contextBinding}:${requestId}`)) return null;
    return { snapshot: normalizeConfirmationInputSnapshot(record.acceptance.inputSnapshot) };
  }

  function admissionStatus({ confirmation, context, requestId } = {}) {
    const contextBinding = confirmationContextBinding(context);
    if (!contextBinding || !cleanId(confirmation?.id) || !cleanText(requestId, 500)) return null;
    const record = repository?.get ? repository.get(confirmation.id) : pending.get(confirmation.id);
    if (!record || record.contextBinding !== contextBinding || confirmationRetentionDeadline(record) <= now()) return null;
    if (!record.acceptance) return { status: "pending" };
    if (record.acceptance.requestBinding !== digestValue(`${contextBinding}:${requestId}`)) return null;
    return { status: "accepted", acceptedAt: new Date(record.acceptance.acceptedAtMs).toISOString(),
      executeBefore: new Date(record.acceptance.executeBeforeMs).toISOString() };
  }

  function bindApprovalToExecutionInput({ confirmation, context, executionInputId, requestId = "" } = {}) {
    const contextBinding = confirmationContextBinding(context);
    if (confirmation?.contractVersion !== CONTRACT_VERSION || confirmation?.decision !== "approved" || !cleanId(confirmation.id)
      || !contextBinding || !cleanText(executionInputId, 500)) return false;
    const record = repository?.get ? repository.get(confirmation.id) : pending.get(confirmation.id);
    const requestBinding = cleanText(requestId, 500) ? digestValue(`${contextBinding}:${requestId}`) : "";
    if (!record || record.contextBinding !== contextBinding || confirmationRetentionDeadline(record) <= now()
      || (record.acceptance && record.acceptance.requestBinding !== requestBinding)) return false;
    const executionInputBinding = digestValue(`${contextBinding}:${executionInputId}`);
    if (repository?.bindExecutionInput) return repository.bindExecutionInput({ id: confirmation.id, contextBinding, executionInputBinding, requestBinding });
    if (!record || (record.executionInputBinding && record.executionInputBinding !== executionInputBinding)) return false;
    record.executionInputBinding = executionInputBinding;
    return true;
  }

  function bindApprovalToTask({ confirmation, context, executionInputId, taskId, inputDigest = "" } = {}) {
    const contextBinding = confirmationContextBinding(context);
    if (!contextBinding || !cleanText(executionInputId, 500) || !cleanId(taskId) || !cleanId(confirmation?.id)) return false;
    const executionInputBinding = digestValue(`${contextBinding}:${executionInputId}`);
    if (repository?.bindExecutionTask) return repository.bindExecutionTask({ id: confirmation.id, contextBinding, executionInputBinding, taskId, inputDigest });
    const record = pending.get(confirmation.id);
    if (!record?.acceptance || record.contextBinding !== contextBinding || record.executionInputBinding !== executionInputBinding
      || confirmationRetentionDeadline(record) <= now() || (record.acceptance.taskId && record.acceptance.taskId !== taskId)
      || (record.acceptance.inputSnapshot && !/^[a-f0-9]{64}$/.test(inputDigest))
      || (record.acceptance.inputDigest && record.acceptance.inputDigest !== inputDigest)) return false;
    record.acceptance.taskId = taskId;
    if (inputDigest) record.acceptance.inputDigest = inputDigest;
    return true;
  }

  function acceptedExecutionValid(record, confirmation, context) {
    return confirmationRetentionDeadline(record) > now()
      && acceptedConfirmationMatches(record, { contextBinding: confirmationContextBinding(context), executionInputBinding: confirmation?.executionInputBinding, taskId: context.taskId })
      && typeof verifyAcceptedExecution === "function"
      && verifyAcceptedExecution({ context, executionInputBinding: record.executionInputBinding, inputDigest: record.acceptance.inputDigest, executeBeforeMs: record.acceptance.executeBeforeMs }) === true;
  }

  function approvalForExecutionInput({ context, executionInputId } = {}) {
    pruneExpired();
    const contextBinding = confirmationContextBinding(context);
    if (!contextBinding || !cleanText(executionInputId, 500)) return null;
    const executionInputBinding = digestValue(`${contextBinding}:${executionInputId}`);
    const records = repository?.listPending ? repository.listPending(contextBinding) : [...pending.values()];
    const record = records.find(item => item.contextBinding === contextBinding && confirmationRetentionDeadline(item) > now() && item.executionInputBinding === executionInputBinding);
    const confirmation = record ? { contractVersion: CONTRACT_VERSION, id: record.id, decision: "approved",
      ...(record.acceptance ? { executionInputBinding } : {}) } : null;
    return record?.acceptance && !acceptedExecutionValid(record, confirmation, context) ? null : confirmation;
  }

  return { acceptApproval, acceptedInputSnapshot, admissionStatus, approvalForExecutionInput, approvedSourceTaskId, approvedToolCall, authorizeOrRequest, bindApprovalToExecutionInput, bindApprovalToTask, pendingRequests };

  function normalizedCall(toolCall = {}) {
    const name = cleanId(toolCall.name);
    const toolId = cleanId(toolCall.toolId);
    const operationId = cleanId(toolCall.operationId);
    const action = cleanId(toolCall.action);
    const risk = cleanId(toolCall.risk);
    const writePolicyDigest = cleanDigest(toolCall.writePolicyDigest);
    const writebackBoundary = cleanText(toolCall.writebackBoundary, 240);
    const scope = cleanList(toolCall.scope);
    const argumentsValue = plainObject(toolCall.arguments) ? toolCall.arguments : null;
    const reviewArguments = plainObject(toolCall.confirmationReviewArguments)
      ? toolCall.confirmationReviewArguments
      : argumentsValue;
    const confirmationExecutionCall = normalizedExecutionCall(toolCall.confirmationExecutionCall) || (name && argumentsValue
      ? { name, arguments: structuredClone(argumentsValue) }
      : null);
    if (!name || !toolId || !operationId || !action || !risk || !writebackBoundary || !scope.length || !argumentsValue || !confirmationExecutionCall) return null;
    return {
      name,
      toolId,
      operationId,
      action,
      risk,
      writePolicyDigest,
      scope,
      writebackBoundary,
      arguments: argumentsValue,
      reviewArguments,
      confirmationExecutionCall,
      displayName: cleanText(toolCall.displayName, 120) || action,
      confirmationTtlMs: boundedTtl(toolCall.confirmationTtlMs, ttlMs),
    };
  }
}

function normalizedExecutionCall(value = null) {
  if (!plainObject(value) || !plainObject(value.arguments)) return null;
  const name = cleanId(value.name);
  return name ? { name, arguments: structuredClone(value.arguments) } : null;
}

function confirmationContextBinding(context = {}) {
  const sessionKey = cleanText(context.sessionKey, 500);
  const employeeId = cleanId(context.employeeId);
  const actorId = cleanText(context.actorId, 500);
  if (!sessionKey || !employeeId) return "";
  return digestValue(`${sessionKey}:${employeeId}:${actorId}`);
}

function callDigest(call = {}) {
  return digestValue(canonicalJson({
    name: call.name,
    toolId: call.toolId,
    operationId: call.operationId,
    action: call.action,
    risk: call.risk,
    writePolicyDigest: call.writePolicyDigest,
    scope: call.scope,
    writebackBoundary: call.writebackBoundary,
    arguments: call.arguments,
  }));
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (plainObject(value)) {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function safeReviewValue(value, depth = 0) {
  if (depth > 5) return "[truncated]";
  if (Array.isArray(value)) return value.slice(0, 20).map((item) => safeReviewValue(item, depth + 1));
  if (!plainObject(value)) return typeof value === "string" ? value.slice(0, 500) : value;
  return Object.fromEntries(Object.entries(value).slice(0, 40).map(([key, item]) => [
    key,
    REDACTED_KEYS.test(key) ? "[redacted]" : safeReviewValue(item, depth + 1),
  ]));
}

function digestValue(value = "") {
  return crypto.createHash("sha256").update(String(value)).digest("hex");
}

function cleanDigest(value = "") {
  const digest = String(value || "").trim();
  return /^sha256:[a-f0-9]{64}$/.test(digest) ? digest : "";
}

function boundedTtl(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.min(15 * 60 * 1000, Math.max(30_000, Math.round(number))) : fallback;
}

function cleanList(value) {
  return [...new Set((Array.isArray(value) ? value : []).map(cleanId).filter(Boolean))].sort();
}

function cleanId(value = "") {
  return String(value || "").replace(/[^a-zA-Z0-9_.:/-]/g, "").slice(0, 160);
}

function cleanText(value = "", maxLength = 500) {
  return String(value || "").replace(/[\r\n\0]/g, " ").trim().slice(0, maxLength);
}

function plainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export { CONTRACT_VERSION as TOOL_CALL_CONFIRMATION_CONTRACT_VERSION, createToolCallConfirmationService };
