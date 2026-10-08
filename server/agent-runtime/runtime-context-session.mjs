import crypto from "node:crypto";
import {
  TASK_OUTPUT_MANIFEST_CONTRACT,
  taskOutputManifestSummary,
} from "./task-output-manifest.mjs";
import {
  DEFAULT_TOOL_PARAMETER_CONTINUATION_TTL_MS,
} from "./tool-parameter-card.mjs";

const RUNTIME_CONTEXT_ASSEMBLY_CONTRACT = "runtime-context-assembly.v1";
const RUNTIME_CONTEXT_COMPACTION_POLICY_ENV = "SESSION_CONTEXT_COMPACTION_POLICY_JSON";
const RUNTIME_TOOL_SESSION_EVIDENCE_CONTRACT = "runtime-tool-session-evidence.v1";
const TOOL_PARAMETER_CONTINUATION_EVIDENCE_CONTRACT = "tool-parameter-continuation-evidence.v1";
const RUNTIME_SESSION_WORKFLOW_EVIDENCE_CONTRACT = "runtime-session-workflow-evidence.v1";
const DEFAULT_WORKFLOW_EVIDENCE_TTL_MS = DEFAULT_TOOL_PARAMETER_CONTINUATION_TTL_MS;
const SENSITIVE_PARAMETER_KEY = /authorization|bearer|token|secret|password|cookie|api[-_]?key|credential/i;

function createSessionTurnQueue() {
  const tails = new Map();
  function enqueueSessionTurn(routeKey, run) {
    const key = requiredText(routeKey, "routeKey");
    if (typeof run !== "function") throw runtimeContextError("session_turn_runner_required");
    const previous = tails.get(key) || Promise.resolve();
    const next = previous.catch(() => {}).then(run);
    tails.set(key, next);
    return next.finally(() => {
      if (tails.get(key) === next) tails.delete(key);
    });
  }
  return { enqueueSessionTurn };
}

function readRuntimeContextCompactionPolicyFromEnvironment(environment = process.env) {
  const raw = String(environment[RUNTIME_CONTEXT_COMPACTION_POLICY_ENV] || "").trim();
  if (!raw) return null;
  let policy;
  try {
    policy = JSON.parse(raw);
  } catch {
    throw new TypeError(`${RUNTIME_CONTEXT_COMPACTION_POLICY_ENV} must be valid JSON`);
  }
  if (policy?.contractVersion !== "context-compaction-policy.v1" ||
    !Number.isSafeInteger(policy.retainTailGroups) || policy.retainTailGroups < 1) {
    throw new TypeError(`${RUNTIME_CONTEXT_COMPACTION_POLICY_ENV} is invalid`);
  }
  return Object.freeze({
    contractVersion: policy.contractVersion,
    retainTailGroups: policy.retainTailGroups,
  });
}

async function prepareRuntimeContextSource({
  checkpointRepository = null,
  excludeEntryId = "",
  expectedSessionId = "",
  route = null,
  sessionRepository = null,
} = {}) {
  assertSessionRepository(sessionRepository);
  if (!route || typeof route !== "object") throw runtimeContextError("session_route_required");
  const session = expectedSessionId
    ? await sessionRepository.readSession(requiredText(expectedSessionId, "expectedSessionId"))
    : await sessionRepository.openSession({ route });
  if (!session?.sessionId) throw runtimeContextError("expected_session_not_found");
  if (expectedSessionId && (session.sessionId !== expectedSessionId || session.routeDigest !== route.routeDigest || session.status !== "active")) {
    throw runtimeContextError("expected_session_not_active");
  }
  const transcriptEntries = await sessionRepository.readTranscript(session.sessionId);
  const checkpoint = checkpointRepository ? await checkpointRepository.read(session.sessionId) : null;
  return {
    authority: "session_foundation",
    checkpoint,
    checkpointRepository,
    route,
    session,
    sessionRepository,
    transcriptEntries: (Array.isArray(transcriptEntries) ? transcriptEntries : [])
      .filter((entry) => !excludeEntryId || entry.entryId !== excludeEntryId),
  };
}

async function assembleRuntimeConversationHistory({
  capability = null,
  compactionPolicy = null,
  contextCompactor = null,
  contextEngine,
  currentTurnItems = [],
  fixedItems = [],
  governanceItems = [],
  now = Date.now(),
  source,
  toolDefinitions = [],
  workflowEvidenceTtlMs = DEFAULT_WORKFLOW_EVIDENCE_TTL_MS,
} = {}) {
  const safeSource = source || {};
  if (!capability) {
    return degradedSelection({
      history: [],
      reason: "provider_context_capability_unavailable",
      source: safeSource,
    });
  }
  if (!Number.isInteger(capability.reserve?.outputTokens) || capability.reserve.outputTokens < 1) {
    return degradedSelection({
      history: [],
      reason: "provider_context_output_reserve_unavailable",
      source: safeSource,
    });
  }
  if (safeSource.authority !== "session_foundation") {
    throw runtimeContextError("session_foundation_source_required");
  }
  if (typeof contextEngine?.assemble !== "function") {
    return degradedSelection({ history: [], reason: "context_engine_unavailable", source: safeSource });
  }
  let assembled = contextEngine.assemble({
    capability,
    checkpoint: safeSource.checkpoint,
    currentTurnItems,
    fixedItems,
    governanceItems,
    toolDefinitions,
    transcriptEntries: safeSource.transcriptEntries,
  });
  if (assembled.status === "compact_required") {
    if (!compactionPolicy) {
      return degradedSelection({ history: [], reason: "context_compaction_policy_unavailable", source: safeSource });
    }
    if (typeof contextCompactor !== "function") {
      return degradedSelection({ history: [], reason: "context_compactor_unavailable", source: safeSource });
    }
    if (typeof safeSource.checkpointRepository?.save !== "function") {
      return degradedSelection({ history: [], reason: "context_checkpoint_repository_unavailable", source: safeSource });
    }
    const compacted = await contextEngine.compact({
      capability,
      historyBudgetTokens: assembled.compactRequest?.historyBudgetTokens,
      policy: compactionPolicy,
      summarize: contextCompactor,
      transcriptEntries: safeSource.transcriptEntries,
    });
    if (compacted.status !== "compacted") {
      return degradedSelection({ history: [], reason: compacted.reason || "context_compaction_failed", source: safeSource });
    }
    // Verify the candidate window before persisting a checkpoint. A failed
    // summary must not replace the last valid checkpoint or hide recent history.
    const candidate = contextEngine.assemble({
      capability,
      checkpoint: { contractVersion: "compaction-checkpoint.v1", ...compacted.product },
      currentTurnItems, fixedItems, governanceItems, toolDefinitions,
      transcriptEntries: safeSource.transcriptEntries,
    });
    if (!/^assembled/.test(candidate.status)) {
      return degradedSelection({ history: [], reason: "context_compaction_budget_exceeded", source: safeSource });
    }
    let checkpoint;
    try {
      checkpoint = await safeSource.checkpointRepository.save({
        expectedCheckpointRevision: safeSource.checkpoint?.revision || 0,
        expectedSessionRevision: safeSource.session.revision,
        product: compacted.product,
        sessionId: safeSource.session.sessionId,
      });
    } catch (error) {
      return degradedSelection({
        history: [],
        reason: checkpointFailureReason(error),
        source: safeSource,
      });
    }
    assembled = contextEngine.assemble({
      capability,
      checkpoint,
      currentTurnItems,
      fixedItems,
      governanceItems,
      toolDefinitions,
      transcriptEntries: safeSource.transcriptEntries,
    });
  }
  const history = /^assembled/.test(assembled.status)
    ? projectContextItemsToMessages(assembled.items, { now, workflowEvidenceTtlMs })
    : [];
  return {
    conversationHistory: history,
    summary: assemblySummary({ assembled, history, source: safeSource }),
  };
}

function checkpointFailureReason(error) {
  const code = String(error?.code || error?.message || "");
  if (code === "checkpoint_source_revision_stale") return "context_checkpoint_source_revision_stale";
  if (code === "checkpoint_revision_conflict") return "context_checkpoint_revision_conflict";
  return "context_checkpoint_save_failed";
}

function assertRuntimeConversationContext(selection) {
  if (!/^assembled/.test(String(selection?.summary?.status || ""))) {
    throw runtimeContextError(selection?.summary?.reason || "context_assembly_unavailable");
  }
}

async function recordRuntimeConversationTurn({
  commitGuard = null,
  expectedSessionId = "",
  source,
  turn = {},
  turnId = "",
} = {}) {
  if (source?.authority !== "session_foundation") throw runtimeContextError("session_foundation_source_required");
  const repository = source.sessionRepository;
  assertSessionRepository(repository);
  const stableTurnId = requiredText(turnId || `turn-${crypto.randomUUID()}`, "turnId");
  let session = await repository.readCurrentSession(source.route);
  if (!session?.sessionId) session = await repository.openSession({ route: source.route });
  if (expectedSessionId && session.sessionId !== expectedSessionId) throw runtimeContextError("session_route_mismatch");
  const append = async (suffix, entry, extendsInteraction = false) => {
    const result = await repository.appendTranscriptEntry({
      commitGuard,
      entry,
      expectedRevision: session.revision,
      extendsInteraction,
      idempotencyKey: idempotencyKey(stableTurnId, suffix),
      route: source.route,
      sessionId: expectedSessionId || session.sessionId,
    });
    session = result.session;
  };
  const userText = String(turn.userText || "").trim();
  const assistantText = String(turn.assistantText || "").trim();
  if (userText) {
    const input = await recordRuntimeConversationInput({
      commitGuard,
      expectedSessionId: expectedSessionId || session.sessionId,
      source,
      turnId: stableTurnId,
      userText,
      outputFormat: turn.outputFormat,
      executionBudget: turn.executionBudget,
    });
    session = input.session;
  }
  for (const [index, call] of (Array.isArray(turn.toolCalls) ? turn.toolCalls : []).entries()) {
    const toolId = String(call?.name || call?.toolId || "").trim();
    if (!toolId) continue;
    const callId = String(call?.callId || `${stableTurnId}:tool:${index}`).trim();
    const result = call?.result || {};
    const safeSummary = runtimeToolSessionSafeSummary({ call, result, toolId });
    if (!safeSummary) continue;
    await append(`tool:${index}:call`, {
      type: "toolCall",
      toolCall: { callId, toolId, safeArguments: safeToolArguments(call?.arguments) },
    });
    await append(`tool:${index}:result`, {
      type: "toolResult",
      toolResult: {
        callId,
        toolId,
        status: String(result.status || call.status || "completed").trim() || "completed",
        safeSummary,
        evidenceRefIds: Array.isArray(result.evidenceRefIds) ? result.evidenceRefIds : [],
      },
    });
  }
  if (assistantText) await append("message:assistant", {
    type: "message",
    message: { role: "assistant", content: assistantText, ...(turn.taskId ? { taskId: turn.taskId } : {}) },
  });
  return session;
}

async function recordRuntimeConversationInput({
  commitGuard = null,
  expectedSessionId = "",
  source,
  turnId = "",
  userText = "",
  outputFormat = null,
  executionBudget = null,
} = {}) {
  if (source?.authority !== "session_foundation") throw runtimeContextError("session_foundation_source_required");
  const repository = source.sessionRepository;
  assertSessionRepository(repository);
  const stableTurnId = requiredText(turnId, "turnId");
  const text = String(userText || "").trim();
  if (!text) throw runtimeContextError("userText_required");
  let session = await repository.readCurrentSession(source.route);
  if (!session?.sessionId) session = await repository.openSession({ route: source.route });
  if (expectedSessionId && session.sessionId !== expectedSessionId) throw runtimeContextError("session_route_mismatch");
  return repository.appendTranscriptEntry({
    commitGuard,
    entry: { type: "message", message: { role: "user", content: text, ...(outputFormat ? { outputFormat } : {}), ...(executionBudget ? { executionBudget } : {}) } },
    expectedRevision: session.revision,
    extendsInteraction: true,
    idempotencyKey: idempotencyKey(stableTurnId, "message:user"),
    route: source.route,
    sessionId: expectedSessionId || session.sessionId,
  });
}

async function recordRuntimeConversationParameterContinuation({
  continuation,
  expectedSessionId = "",
  source,
  turnId = "",
} = {}) {
  if (source?.authority !== "session_foundation") throw runtimeContextError("session_foundation_source_required");
  const repository = source.sessionRepository;
  assertSessionRepository(repository);
  const stableTurnId = requiredText(turnId, "turnId");
  const evidence = normalizeToolParameterContinuationEvidence(continuation);
  let session = await repository.readCurrentSession(source.route);
  if (!session?.sessionId) throw runtimeContextError("active_session_not_found");
  if (expectedSessionId && session.sessionId !== expectedSessionId) throw runtimeContextError("session_route_mismatch");
  const callId = `parameter-continuation:${crypto.createHash("sha256").update(stableTurnId).digest("hex")}`;
  const append = async (suffix, entry) => {
    const result = await repository.appendTranscriptEntry({
      entry,
      expectedRevision: session.revision,
      extendsInteraction: false,
      idempotencyKey: idempotencyKey(stableTurnId, suffix),
      route: source.route,
      sessionId: expectedSessionId || session.sessionId,
    });
    session = result.session;
    return result.entry;
  };
  const toolCall = await append("parameter-continuation:call", {
    type: "toolCall",
    toolCall: { callId, toolId: evidence.toolId, safeArguments: {} },
  });
  const toolResult = await append("parameter-continuation:result", {
    type: "toolResult",
    toolResult: {
      callId,
      toolId: evidence.toolId,
      status: "submitted",
      safeSummary: JSON.stringify(evidence),
      evidenceRefIds: [],
    },
  });
  return { session, toolCall, toolResult };
}

async function submitRuntimeToolParameterContinuation({
  employeeId = "",
  executionInput = null,
  repository = null,
  source,
  submission = null,
} = {}) {
  if (!submission) return null;
  if (typeof repository?.submit !== "function") {
    throw runtimeContextError("tool_parameter_continuation_repository_unavailable");
  }
  const sessionId = requiredText(executionInput?.session?.sessionId, "executionInput.sessionId");
  const executionInputRefId = requiredText(executionInput?.entry?.entryId, "executionInput.entryId");
  const continuation = repository.submit({
    arguments: submission.arguments,
    cardId: submission.cardId,
    employeeId: requiredText(employeeId, "employeeId"),
    executionInputRefId,
    routeDigest: requiredText(source?.route?.routeDigest, "routeDigest"),
    schemaDigest: submission.schemaDigest,
    sessionId,
  });
  if (!continuation) throw runtimeContextError("tool_parameter_continuation_repository_unavailable");
  const record = await recordRuntimeConversationParameterContinuation({
    continuation,
    expectedSessionId: sessionId,
    source,
    turnId: executionInputRefId,
  });
  return {
    continuation,
    presentationEvidence: continuation.presentationEvidence || null,
    session: record.session,
  };
}

async function recordRuntimeConversationResult({
  assistantText = "",
  commitGuard = null,
  expectedSessionId = "",
  source,
  taskId = "",
} = {}) {
  if (source?.authority !== "session_foundation") throw runtimeContextError("session_foundation_source_required");
  const repository = source.sessionRepository;
  assertSessionRepository(repository);
  const stableTaskId = requiredText(taskId, "taskId");
  const text = String(assistantText || "").trim();
  if (!text) throw runtimeContextError("assistantText_required");
  let session = await repository.readCurrentSession(source.route);
  if (!session?.sessionId) throw runtimeContextError("active_session_not_found");
  if (expectedSessionId && session.sessionId !== expectedSessionId) throw runtimeContextError("session_route_mismatch");
  return repository.appendTranscriptEntry({
    commitGuard,
    entry: { type: "message", message: { role: "assistant", content: text, taskId: stableTaskId } },
    expectedRevision: session.revision,
    extendsInteraction: false,
    idempotencyKey: idempotencyKey(stableTaskId, "message:assistant"),
    route: source.route,
    sessionId: expectedSessionId || session.sessionId,
  });
}

async function recordRuntimeConversationTaskOutput({
  commitGuard = null,
  expectedSessionId = "",
  source,
  taskId = "",
  taskOutputManifest = null,
} = {}) {
  if (source?.authority !== "session_foundation") throw runtimeContextError("session_foundation_source_required");
  const repository = source.sessionRepository;
  assertSessionRepository(repository);
  const stableTaskId = requiredText(taskId, "taskId");
  const evidence = runtimeTaskOutputEvidence(taskOutputManifest, stableTaskId);
  if (!evidence) return null;
  let session = await repository.readCurrentSession(source.route);
  if (!session?.sessionId) throw runtimeContextError("active_session_not_found");
  if (expectedSessionId && session.sessionId !== expectedSessionId) throw runtimeContextError("session_route_mismatch");
  const call = await repository.appendTranscriptEntry({
    commitGuard,
    entry: evidence.call,
    expectedRevision: session.revision,
    extendsInteraction: false,
    idempotencyKey: idempotencyKey(stableTaskId, "tool:task-output-manifest:call"),
    route: source.route,
    sessionId: expectedSessionId || session.sessionId,
  });
  session = call.session;
  return repository.appendTranscriptEntry({
    commitGuard,
    entry: evidence.result,
    expectedRevision: session.revision,
    extendsInteraction: false,
    idempotencyKey: idempotencyKey(stableTaskId, "tool:task-output-manifest:result"),
    route: source.route,
    sessionId: expectedSessionId || session.sessionId,
  });
}

async function readRuntimeConversationResult({ expectedSessionId = "", source, taskId = "" } = {}) {
  if (source?.authority !== "session_foundation") throw runtimeContextError("session_foundation_source_required");
  const repository = source.sessionRepository;
  assertSessionRepository(repository);
  const stableTaskId = requiredText(taskId, "taskId");
  const session = expectedSessionId
    ? await repository.readSession(requiredText(expectedSessionId, "expectedSessionId"))
    : await repository.readCurrentSession(source.route);
  if (!session?.sessionId || (expectedSessionId && session.routeDigest !== source.route.routeDigest)) return null;
  const transcript = await repository.readTranscript(expectedSessionId || session.sessionId);
  return transcript?.find((entry) => entry.idempotencyKey === idempotencyKey(stableTaskId, "message:assistant")) || null;
}

function projectContextItemsToMessages(items = [], { now = Date.now(), workflowEvidenceTtlMs = DEFAULT_WORKFLOW_EVIDENCE_TTL_MS } = {}) {
  const history = [];
  const pendingToolCalls = new Map();
  const nowMs = normalizeNowMs(now);
  const ttlMs = positiveSafeInteger(workflowEvidenceTtlMs, DEFAULT_WORKFLOW_EVIDENCE_TTL_MS);
  for (const item of Array.isArray(items) ? items : []) {
    if (item?.source === "checkpoint" && item.value?.type === "compaction_summary") {
      const content = String(item.value.content || "").trim();
      if (content) history.push({ role: "assistant", content: `[受管会话摘要]\n${content}` });
      continue;
    }
    if (item?.source !== "transcript") continue;
    if (item.value?.type === "message" && ["user", "assistant"].includes(item.value.message?.role)) {
      const content = projectConversationTextForModel(item.value.message.content);
      if (content) history.push({
        role: item.value.message.role,
        content,
      });
      continue;
    }
    if (item.value?.type === "toolCall") {
      const value = item.value.toolCall || {};
      const callId = String(value.callId || "").trim();
      const name = String(value.toolId || "").trim();
      if (callId && name) pendingToolCalls.set(callId, {
        callId,
        name,
        arguments: safeToolArguments(value.safeArguments),
      });
      continue;
    }
    if (item.value?.type === "toolResult") {
      const value = item.value.toolResult || {};
      const callId = String(value.callId || "").trim();
      const summary = String(value.safeSummary || "").trim();
      const call = pendingToolCalls.get(callId);
      if (!call || !summary) continue;
      pendingToolCalls.delete(callId);
      const safeSummary = parseSafeToolSummary(summary);
      if (isExpiredToolParameterContinuationEvidence(safeSummary, item.value.createdAt, nowMs, ttlMs)) {
        continue;
      }
      history.push({
        toolCalls: [{
          ...call,
          result: {
            toolId: String(value.toolId || "").trim(),
            status: String(value.status || "completed").trim() || "completed",
            safeSummary,
          },
        }],
      });
    }
  }
  return history;
}

function projectRuntimeSessionWorkflowEvidence(
  source = {},
  { now = Date.now(), workflowEvidenceTtlMs = DEFAULT_WORKFLOW_EVIDENCE_TTL_MS } = {},
) {
  let selectionContinuation = null;
  let completedOperations = [];
  let selectionCreatedAt = "";
  const nowMs = normalizeNowMs(now);
  const ttlMs = positiveSafeInteger(workflowEvidenceTtlMs, DEFAULT_WORKFLOW_EVIDENCE_TTL_MS);
  for (const entry of Array.isArray(source?.transcriptEntries) ? source.transcriptEntries : []) {
    if (entry?.type !== "toolResult") continue;
    const summary = parseSafeToolSummary(entry.toolResult?.safeSummary);
    if (summary?.contractVersion === TOOL_PARAMETER_CONTINUATION_EVIDENCE_CONTRACT) {
      if (isExpiredToolParameterContinuationEvidence(summary, entry.createdAt, nowMs, ttlMs)) {
        selectionContinuation = null;
        selectionCreatedAt = "";
        completedOperations = [];
        continue;
      }
      selectionContinuation = structuredClone(summary);
      selectionCreatedAt = entry.createdAt;
      completedOperations = [];
      continue;
    }
    if (selectionContinuation && isExpiredToolParameterContinuationEvidence(selectionContinuation, selectionCreatedAt, nowMs, ttlMs)) {
      selectionContinuation = null;
      selectionCreatedAt = "";
      completedOperations = [];
      continue;
    }
    if (selectionContinuation && summary?.contractVersion === RUNTIME_TOOL_SESSION_EVIDENCE_CONTRACT && summary.status === "completed") {
      completedOperations.push({
        toolId: String(summary.toolId || "").trim(),
        operationId: String(summary.operationId || "").trim(),
        status: "completed",
      });
    }
  }
  if (!selectionContinuation || isExpiredToolParameterContinuationEvidence(selectionContinuation, selectionCreatedAt, nowMs, ttlMs)) return null;
  return {
    contractVersion: RUNTIME_SESSION_WORKFLOW_EVIDENCE_CONTRACT,
    selectionContinuation,
    completedOperations: completedOperations.filter((item) => item.toolId && item.operationId).slice(-20),
  };
}

function isExpiredToolParameterContinuationEvidence(summary = {}, createdAt = "", nowMs = Date.now(), ttlMs = DEFAULT_WORKFLOW_EVIDENCE_TTL_MS) {
  if (summary?.contractVersion !== TOOL_PARAMETER_CONTINUATION_EVIDENCE_CONTRACT) return false;
  const createdAtMs = Date.parse(String(createdAt || ""));
  if (!Number.isFinite(createdAtMs)) return true;
  return nowMs - createdAtMs >= ttlMs;
}

function normalizeNowMs(value) {
  const raw = typeof value === "function" ? value() : value;
  const ms = raw instanceof Date ? raw.getTime() : typeof raw === "number" ? raw : Date.parse(String(raw || ""));
  return Number.isFinite(ms) ? ms : Date.now();
}

function positiveSafeInteger(value, fallback) {
  return Number.isSafeInteger(value) && value > 0 ? value : fallback;
}

function parseSafeToolSummary(value = "") {
  const summary = String(value || "").trim();
  if (!summary.startsWith("{") && !summary.startsWith("[")) return summary;
  try {
    return JSON.parse(summary);
  } catch {
    return summary;
  }
}

function projectConversationTextForModel(value = "") {
  return String(value || "")
    .replace(/\[([^\]\n]+)\]\((https?:\/\/[^)\s]+)\)/gi, "$1（链接已通过 Channel 发送）")
    .replace(/https?:\/\/[^\s<>()\[\]{}"'，。！？；]+/gi, "链接已通过 Channel 发送")
    .trim();
}

function degradedSelection({ history = [], reason, source }) {
  const conversationHistory = Array.isArray(history) ? structuredClone(history) : [];
  return {
    conversationHistory,
    summary: {
      contractVersion: RUNTIME_CONTEXT_ASSEMBLY_CONTRACT,
      status: "degraded",
      reason,
      authority: String(source?.authority || "unavailable"),
      historyMode: "current_turn_only",
      selectedMessageCount: conversationHistory.length,
    },
  };
}

function assemblySummary({ assembled = {}, history = [], source = {} }) {
  return {
    contractVersion: RUNTIME_CONTEXT_ASSEMBLY_CONTRACT,
    status: String(assembled.status || "degraded"),
    reason: String(assembled.reason || "context_assembly_unknown"),
    authority: String(source.authority || "unavailable"),
    historyMode: "provider_token_budget",
    capabilityProfileVersion: String(assembled.capability?.profileVersion || ""),
    budget: structuredClone(assembled.budget || {}),
    omittedItemCount: Number(assembled.omittedItemCount || 0),
    selectedMessageCount: history.length,
  };
}

function safeToolArguments(value = {}) {
  return Object.fromEntries(["inputId", "operationId", "skillId"].flatMap((key) => {
    const text = String(value?.[key] || "").trim();
    return text ? [[key, text]] : [];
  }));
}

function runtimeToolSessionSafeSummary({ call = {}, result = {}, toolId = "" } = {}) {
  const operationId = String(result.operationId || call.arguments?.operationId || "").trim();
  const status = String(result.status || call.status || "completed").trim() || "completed";
  if (operationId) {
    return JSON.stringify({
      contractVersion: RUNTIME_TOOL_SESSION_EVIDENCE_CONTRACT,
      toolId: requiredText(result.toolId || toolId, "toolId"),
      operationId: requiredText(operationId, "operationId"),
      status: requiredText(status, "status"),
    });
  }
  return String(result.safeSummary || result.summary || result.nextGate || status).trim();
}

function normalizeToolParameterContinuationEvidence(value = {}) {
  if (value?.contractVersion !== "tool-parameter-continuation.v1") {
    throw runtimeContextError("tool_parameter_continuation_invalid");
  }
  const argumentsValue = normalizeContinuationArguments(value.arguments);
  const sourceToolId = String(value.inputSource?.toolId || "").trim();
  const sourceOperationId = String(value.inputSource?.operationId || "").trim();
  const inputSource = value.inputSource?.contractVersion === "tool-parameter-input-source.v1" && sourceToolId && sourceOperationId
    ? {
        contractVersion: "tool-parameter-input-source.v1",
        toolId: requiredText(sourceToolId, "inputSource.toolId"),
        operationId: requiredText(sourceOperationId, "inputSource.operationId"),
      }
    : null;
  return {
    contractVersion: TOOL_PARAMETER_CONTINUATION_EVIDENCE_CONTRACT,
    toolId: requiredText(value.toolId, "toolId"),
    operationId: requiredText(value.operationId, "operationId"),
    ...(inputSource ? { inputSource } : {}),
    arguments: argumentsValue,
    ...(normalizeContinuationSelectionEvidence(value.selectionEvidence)
      ? { selectionEvidence: normalizeContinuationSelectionEvidence(value.selectionEvidence) }
      : {}),
  };
}

function normalizeContinuationSelectionEvidence(value = null) {
  if (!value || value.contractVersion !== "tool-parameter-selection-evidence.v1") return null;
  const fields = normalizeContinuationArguments(value.fields);
  return { contractVersion: value.contractVersion, fields };
}

function normalizeContinuationArguments(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw runtimeContextError("tool_parameter_continuation_arguments_invalid");
  }
  let cloned;
  try {
    cloned = JSON.parse(JSON.stringify(value));
  } catch {
    throw runtimeContextError("tool_parameter_continuation_arguments_invalid");
  }
  if (Buffer.byteLength(JSON.stringify(cloned), "utf8") > 16 * 1024 || containsSensitiveParameter(cloned)) {
    throw runtimeContextError("tool_parameter_continuation_arguments_unsafe");
  }
  return cloned;
}

function containsSensitiveParameter(value, depth = 0, count = { value: 0 }) {
  count.value += 1;
  if (depth > 6 || count.value > 256) return true;
  if (Array.isArray(value)) return value.some((item) => containsSensitiveParameter(item, depth + 1, count));
  if (!value || typeof value !== "object") return false;
  return Object.entries(value).some(([key, item]) => (
    SENSITIVE_PARAMETER_KEY.test(key) || containsSensitiveParameter(item, depth + 1, count)
  ));
}

function runtimeTaskOutputEvidence(value = null, stableTaskId = "") {
  if (!value || value.contractVersion !== TASK_OUTPUT_MANIFEST_CONTRACT || value.taskId !== stableTaskId) {
    return null;
  }
  const artifacts = (Array.isArray(value.artifacts) ? value.artifacts : [])
    .flatMap((artifact) => {
      const artifactId = optionalSafeEvidenceRefId(artifact?.artifactId);
      return artifactId ? [artifactId] : [];
    })
    .slice(0, 3);
  if (!artifacts.length) return null;
  const resultAvailable = value.result?.available === true;
  const callId = `${stableTaskId}:task-output-manifest`;
  return {
    call: {
      type: "toolCall",
      toolCall: {
        callId,
        toolId: "task-output-manifest",
        safeArguments: { taskId: stableTaskId },
      },
    },
    result: {
      type: "toolResult",
      toolResult: {
        callId,
        toolId: "task-output-manifest",
        status: "completed",
        safeSummary: taskOutputManifestSummary({ artifactCount: artifacts.length, resultAvailable }),
        evidenceRefIds: artifacts,
      },
    },
  };
}

function optionalSafeEvidenceRefId(value) {
  const text = String(value || "").trim();
  return /^[A-Za-z0-9][A-Za-z0-9._:@-]{0,159}$/.test(text) ? text : "";
}

function idempotencyKey(turnId, suffix) {
  const digest = crypto.createHash("sha256").update(`${turnId}:${suffix}`).digest("hex");
  return `runtime-turn:${digest}`;
}

function assertSessionRepository(value) {
  for (const method of ["appendTranscriptEntry", "openSession", "readCurrentSession", "readTranscript"]) {
    if (typeof value?.[method] !== "function") throw runtimeContextError("session_foundation_repository_invalid");
  }
}

function requiredText(value, field) {
  const text = String(value || "").trim();
  if (!text) throw runtimeContextError(`${field}_required`);
  return text.slice(0, 240);
}

function runtimeContextError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

export {
  RUNTIME_CONTEXT_ASSEMBLY_CONTRACT,
  RUNTIME_CONTEXT_COMPACTION_POLICY_ENV,
  DEFAULT_WORKFLOW_EVIDENCE_TTL_MS,
  assembleRuntimeConversationHistory,
  assertRuntimeConversationContext,
  createSessionTurnQueue,
  prepareRuntimeContextSource,
  projectContextItemsToMessages,
  projectRuntimeSessionWorkflowEvidence,
  readRuntimeContextCompactionPolicyFromEnvironment,
  recordRuntimeConversationInput,
  recordRuntimeConversationParameterContinuation,
  recordRuntimeConversationResult,
  recordRuntimeConversationTaskOutput,
  recordRuntimeConversationTurn,
  readRuntimeConversationResult,
  submitRuntimeToolParameterContinuation,
};
