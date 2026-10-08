import {
  canonicalRuntimeSafeActivityId,
  normalizeRuntimeSafeActivity,
  normalizeRuntimeSafeActivitySnapshot,
  RUNTIME_SAFE_ACTIVITY_SNAPSHOT_CONTRACT_VERSION,
  runtimeSafeActivityDisplayName,
} from "./runtime-safe-activity-contract-v1.mjs";
import { normalizeAgentRuntimeEvidence } from "./runtime-task-evidence-contract-v1.mjs";
import {
  DEFAULT_PROVIDER_DIAGNOSTIC,
  normalizeProviderRuntimeDiagnostic,
} from "./provider-errors.mjs";

const SAFE_AGENT_RUNTIME_EVIDENCE_CONTRACT_VERSION = "agent-runtime-safe-evidence.v1";
const SAFE_TOKEN = /^[A-Za-z0-9][A-Za-z0-9._:@-]*$/;
const TERMINAL_STATUSES = new Set(["blocked", "completed", "failed", "rejected", "target_rejected"]);
const MANAGED_TOOL_DIRECTORY = Object.freeze({
  compress_workspace_output: ["compress_workspace_output", "workspace.compress"],
  copy_workspace_file: ["copy_workspace_file", "workspace.copy"],
  create_workspace_directory: ["create_workspace_directory", "workspace.mkdir"],
  delete_workspace_path: ["delete_workspace_path", "workspace.delete"],
  export_visual_evidence: ["export_visual_evidence", "workspace.visual_evidence"],
  extract_workspace_archive: ["extract_workspace_archive", "workspace.extract"],
  inspect_workspace_file: ["inspect_workspace_file", "workspace.inspect_file"],
  inspect_workspace_image: ["inspect_workspace_image", "workspace.inspect_image"],
  list_workspace_files: ["list_workspace_files", "workspace.list"],
  prepare_channel_input: ["prepare_channel_input", "material.prepare"],
  read_workspace_text: ["read_workspace_text", "workspace.read_text"],
  replace_workspace_file: ["replace_workspace_file", "workspace.replace"],
  write_report_bundle: ["write_report_bundle", "workspace.report_bundle"],
  write_workspace_file: ["write_workspace_file", "workspace.write"],
  write_workspace_text: ["write_workspace_text", "workspace.output"],
});
const SAFE_BLOCKED_REASONS = new Set([
  "agent_tool_loop_no_progress",
  "agent_tool_not_allowed",
  "agent_turn_blocked",
  "agent_turn_canceled",
  "execution_task_ownership_lost",
  "model_rate_limited",
  "model_request_invalid",
  "model_request_failed",
  "model_provider_rate_limited",
  "model_provider_unavailable",
  "model_response_contract_invalid",
  "provider_adapter_not_registered",
  "provider_connect_timeout",
  "provider_first_semantic_output_timeout",
  "provider_request_total_timeout",
  "provider_stream_idle_timeout",
  "task_execution_timeout",
]);

function createRuntimeSafeActivityProjector({ taskId, toolExecutor = null } = {}) {
  const safeTaskId = safeToken(taskId, 128);
  if (!safeTaskId) throw projectorError("runtime_safe_activity_task_invalid");

  function start({ descriptor = null, sequence, toolCall = {} } = {}) {
    const safeSequence = safeInteger(sequence, 1, 10_000);
    if (!safeSequence) throw projectorError("runtime_safe_activity_sequence_invalid");
    const resolved = descriptor
      ? normalizeDescriptor(descriptor, { strict: true })
      : normalizeDescriptor(toolExecutor?.safeActivityDescriptor?.(toolCall, { result: null }))
        || directoryDescriptor(toolCall.name)
        || genericToolDescriptor();
    const activity = {
      activityId: canonicalRuntimeSafeActivityId(safeTaskId, safeSequence),
      sequence: safeSequence,
      kind: resolved.kind,
      subjectId: resolved.subjectId,
      displayName: runtimeSafeActivityDisplayName(resolved.actionCode),
      actionCode: resolved.actionCode,
      status: "started",
    };
    return normalizeRuntimeSafeActivity(activity, { taskId: safeTaskId });
  }

  function finish({ activity, result = null, status, toolCall = {} } = {}) {
    const current = normalizeRuntimeSafeActivity(activity, { taskId: safeTaskId });
    if (current.status !== "started") throw projectorError("runtime_safe_activity_status_conflict");
    const terminalStatus = String(status || "").trim();
    if (!TERMINAL_STATUSES.has(terminalStatus)) throw projectorError("runtime_safe_activity_status_invalid");
    const terminalDescriptor = normalizeDescriptor(
      toolExecutor?.safeActivityDescriptor?.(toolCall, { result }),
    );
    const sameIdentity = terminalDescriptor &&
      terminalDescriptor.kind === current.kind &&
      terminalDescriptor.subjectId === current.subjectId &&
      terminalDescriptor.actionCode === current.actionCode;
    const operationCode = terminalStatus === "completed" && result?.ok === true && sameIdentity &&
      terminalDescriptor.operationDisplayAllowed === true
      ? terminalDescriptor.operationCode
      : "";
    return normalizeRuntimeSafeActivity({
      ...current,
      ...(operationCode ? { operationCode } : {}),
      status: terminalStatus,
    }, { taskId: safeTaskId });
  }

  function snapshot(activities = []) {
    return normalizeRuntimeSafeActivitySnapshot({
      contractVersion: RUNTIME_SAFE_ACTIVITY_SNAPSHOT_CONTRACT_VERSION,
      taskId: safeTaskId,
      activities,
    }, { expectedTaskId: safeTaskId });
  }

  return Object.freeze({ finish, snapshot, start });
}

function projectSafeAgentRuntimeEvidence(evidence = null, {
  activitySnapshot: canonicalActivitySnapshot = null,
  activityUpdatedAt = "",
  taskId = "",
} = {}) {
  const safeTaskId = safeToken(taskId, 128);
  if (!safeTaskId) return null;
  let canonicalSnapshot = null;
  if (canonicalActivitySnapshot) {
    try {
      canonicalSnapshot = normalizeRuntimeSafeActivitySnapshot(canonicalActivitySnapshot, {
        expectedTaskId: safeTaskId,
      });
    } catch {
      return null;
    }
  }
  if (!evidence || typeof evidence !== "object" || Array.isArray(evidence)) {
    if (!canonicalSnapshot?.activities.length) return null;
    return safeEvidenceProjection({
      activitySnapshot: canonicalSnapshot,
      adapter: "governed_tool_execution",
      blockedReason: "",
      model: "",
      provider: "",
      providerDiagnostic: DEFAULT_PROVIDER_DIAGNOSTIC,
      reasoningEffort: "",
      realModelRequested: false,
      requestCount: 0,
      requestMetrics: [],
      sourceContractVersion: "runtime-safe-activity.v1",
      status: canonicalSnapshot.activities.at(-1)?.status === "started"
        ? "tool_call_started"
        : "tool_call_completed",
      toolCallCount: canonicalSnapshot.activities.length,
      updatedAt: activityUpdatedAt,
      usage: {},
    });
  }
  let normalizedEvidence;
  try {
    const evidenceFields = Object.fromEntries(
      Object.entries(evidence).filter(([field]) => field !== "updatedAt"),
    );
    normalizedEvidence = normalizeAgentRuntimeEvidence(evidenceFields, { expectedTaskId: safeTaskId });
  } catch {
    return null;
  }
  let activitySnapshot;
  try {
    activitySnapshot = canonicalSnapshot || (normalizedEvidence.activitySnapshot
      ? normalizeRuntimeSafeActivitySnapshot(normalizedEvidence.activitySnapshot, { expectedTaskId: safeTaskId })
      : projectLegacyActivitySnapshot({ taskId: safeTaskId, toolCalls: normalizedEvidence.toolCalls }));
  } catch {
    return null;
  }
  const usage = normalizedEvidence.usage;
  return safeEvidenceProjection({
    activitySnapshot,
    adapter: safeToken(normalizedEvidence.adapter, 120),
    blockedReason: safeBlockedReason(normalizedEvidence.blockedReason),
    model: safeToken(normalizedEvidence.model, 160),
    provider: safeToken(normalizedEvidence.provider, 120),
    providerDiagnostic: normalizedEvidence.providerDiagnostic,
    reasoningEffort: safeToken(normalizedEvidence.reasoningEffort, 80),
    realModelRequested: normalizedEvidence.realModelRequested === true,
    requestCount: safeInteger(normalizedEvidence.requestCount, 0, 10_000) ?? 0,
    requestMetrics: normalizedEvidence.requestMetrics || [],
    sourceContractVersion: "agent-runtime-evidence.v1",
    status: safeToken(normalizedEvidence.status, 120) || "runtime_evidence_unknown",
    toolCallCount: safeInteger(normalizedEvidence.toolCallCount, 0, 10_000) ?? activitySnapshot.activities.length,
    updatedAt: activityUpdatedAt || evidence.updatedAt,
    usage: {
      inputTokens: safeOptionalInteger(usage.inputTokens),
      outputTokens: safeOptionalInteger(usage.outputTokens),
      totalTokens: safeOptionalInteger(usage.totalTokens),
    },
  });
}

function safeEvidenceProjection(value) {
  return Object.freeze({
    contractVersion: SAFE_AGENT_RUNTIME_EVIDENCE_CONTRACT_VERSION,
    sourceContractVersion: value.sourceContractVersion,
    status: value.status,
    realModelRequested: value.realModelRequested,
    provider: value.provider,
    model: value.model,
    reasoningEffort: value.reasoningEffort,
    adapter: value.adapter,
    requestCount: value.requestCount,
    requestMetrics: Object.freeze(safeRequestMetrics(value.requestMetrics)),
    toolCallCount: value.toolCallCount,
    activitySnapshot: value.activitySnapshot,
    usage: Object.freeze({
      inputTokens: safeOptionalInteger(value.usage?.inputTokens),
      outputTokens: safeOptionalInteger(value.usage?.outputTokens),
      totalTokens: safeOptionalInteger(value.usage?.totalTokens),
    }),
    blockedReason: value.blockedReason,
    providerDiagnostic: safeProviderDiagnostic(value.providerDiagnostic),
    updatedAt: safeTimestamp(value.updatedAt),
  });
}

function safeRequestMetrics(value) {
  if (!Array.isArray(value)) return [];
  return value.slice(-32).map((metric) => Object.freeze({
    sequence: safeInteger(metric?.sequence, 1, 10_000) ?? 0,
    status: metric?.status === "failed" ? "failed" : "received",
    inputItemCount: safeInteger(metric?.inputItemCount, 0, 10_000) ?? 0,
    inputCharacterCount: safeInteger(metric?.inputCharacterCount, 0, 2_000_000) ?? 0,
    inputTokens: safeOptionalInteger(metric?.inputTokens),
    cachedInputTokens: safeOptionalInteger(metric?.cachedInputTokens),
    outputTokens: safeOptionalInteger(metric?.outputTokens),
    totalTokens: safeOptionalInteger(metric?.totalTokens),
    durationMs: safeInteger(metric?.durationMs, 0, 24 * 60 * 60 * 1000) ?? 0,
  }));
}

function projectLegacyActivitySnapshot({ taskId, toolCalls } = {}) {
  const projector = createRuntimeSafeActivityProjector({ taskId });
  const source = Array.isArray(toolCalls) ? toolCalls : [];
  const activities = source.map((call) => {
    const started = projector.start({ sequence: call.sequence, toolCall: {} });
    const status = call.status === "running" ? "started" : TERMINAL_STATUSES.has(call.status) ? call.status : "failed";
    return status === "started" ? started : projector.finish({ activity: started, status, toolCall: {} });
  });
  return projector.snapshot(activities);
}

function runtimeSafeActivityStatusForResult(result = {}) {
  if (result?.turnDisposition === "target_rejected") return "target_rejected";
  const status = safeToken(result?.status, 120);
  if (status === "target_rejected") return "target_rejected";
  if (["blocked", "failed", "rejected"].includes(status)) return status;
  if (/failed|timed_out/.test(status)) return "failed";
  if (/blocked|canceled|invalid|mismatch|missing|not_allowed|not_ready|requires|unavailable|unsupported/.test(status)) return "blocked";
  return "completed";
}

function directoryDescriptor(name) {
  const managed = MANAGED_TOOL_DIRECTORY[String(name || "").trim()];
  return managed ? { kind: "tool", subjectId: managed[0], actionCode: managed[1] } : null;
}

function genericToolDescriptor() {
  return { kind: "tool", subjectId: "declared-tool", actionCode: "tool.execute" };
}

function normalizeDescriptor(value, { strict = false } = {}) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    if (strict) throw projectorError("runtime_safe_activity_descriptor_invalid");
    return null;
  }
  const allowed = new Set(["actionCode", "kind", "operationCode", "operationDisplayAllowed", "subjectId"]);
  if (Object.keys(value).some((field) => !allowed.has(field))) {
    if (strict) throw projectorError("runtime_safe_activity_descriptor_invalid");
    return null;
  }
  const kind = ["skill", "tool"].includes(value.kind) ? value.kind : "";
  const subjectId = safeToken(value.subjectId, 160);
  const actionCode = safeToken(value.actionCode, 80);
  if (!kind || !subjectId || !runtimeSafeActivityDisplayName(actionCode) ||
    ((kind === "skill") !== (actionCode === "skill.run"))) {
    if (strict) throw projectorError("runtime_safe_activity_descriptor_invalid");
    return null;
  }
  const operationCode = safeToken(value.operationCode, 160);
  return Object.freeze({
    kind,
    subjectId,
    actionCode,
    ...(operationCode ? { operationCode } : {}),
    operationDisplayAllowed: value.operationDisplayAllowed === true,
  });
}

function safeBlockedReason(value) {
  const supplied = String(value || "").trim();
  if (!supplied) return "";
  const reason = safeToken(value, 120);
  return reason && SAFE_BLOCKED_REASONS.has(reason) ? reason : "model_request_failed";
}

function safeProviderDiagnostic(value) {
  return normalizeProviderRuntimeDiagnostic(value, {
    fallbackCategory: "none",
    fallbackReasonCode: "none",
    retryable: false,
  });
}

function safeToken(value, maxLength) {
  const token = String(value || "").trim();
  return token && token.length <= maxLength && SAFE_TOKEN.test(token) ? token : "";
}

function safeInteger(value, minimum, maximum) {
  const number = Number(value);
  return Number.isSafeInteger(number) && number >= minimum && number <= maximum ? number : null;
}

function safeOptionalInteger(value) {
  if (value === undefined || value === null) return null;
  return safeInteger(value, 0, Number.MAX_SAFE_INTEGER);
}

function safeTimestamp(value) {
  const timestamp = Date.parse(String(value || ""));
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : "";
}

function projectorError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

export {
  SAFE_AGENT_RUNTIME_EVIDENCE_CONTRACT_VERSION,
  createRuntimeSafeActivityProjector,
  projectSafeAgentRuntimeEvidence,
  runtimeSafeActivityStatusForResult,
};
