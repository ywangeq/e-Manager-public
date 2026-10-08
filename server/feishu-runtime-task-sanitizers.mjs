import crypto from "node:crypto";
import { normalizeRuntimeSafeActivitySnapshot } from "./agent-runtime/runtime-safe-activity-contract-v1.mjs";
import { normalizeRuntimeSafeProvenance } from "./agent-runtime/runtime-safe-provenance-contract-v1.mjs";
import { normalizeRuntimeToolEfficiency } from "./agent-runtime/runtime-tool-efficiency-contract-v1.mjs";
import { SAFE_AGENT_RUNTIME_EVIDENCE_CONTRACT_VERSION } from "./agent-runtime/runtime-safe-activity-projector.mjs";
import { PROVIDER_RUNTIME_DIAGNOSTIC_VERSION } from "./agent-runtime/provider-errors.mjs";

const MATERIAL_MESSAGE_TYPES = ["file", "folder", "image", "media", "audio", "post"];

export function sanitizeRuntimeTaskFeedback(feedback = {}) {
  if (!feedback || typeof feedback !== "object") return {};
  const rating = cleanShortText(feedback.rating).toLowerCase();
  const autoArchiveAfterHours = safeNumber(feedback.autoArchiveAfterHours);
  return {
    contractVersion: cleanShortText(feedback.contractVersion || "feishu-answer-feedback.v1"),
    sourceChannel: cleanShortText(feedback.sourceChannel || "feishu_app_bot"),
    availability: cleanShortText(feedback.availability),
    status: cleanShortText(feedback.status),
    reason: cleanShortText(feedback.reason),
    answerId: cleanShortText(feedback.answerId),
    requestId: cleanShortText(feedback.requestId),
    skillId: cleanShortText(feedback.skillId),
    rating: ["helpful", "not_helpful"].includes(rating) ? rating : "",
    qualityStatus: cleanShortText(feedback.qualityStatus),
    qualityEventId: cleanShortText(feedback.qualityEventId),
    deliveredAt: cleanShortText(feedback.deliveredAt),
    archiveDueAt: cleanShortText(feedback.archiveDueAt),
    archivedAt: cleanShortText(feedback.archivedAt),
    receivedAt: cleanShortText(feedback.receivedAt),
    autoArchiveAfterHours: autoArchiveAfterHours || undefined,
    late: Boolean(feedback.late),
    updatedAt: cleanShortText(feedback.updatedAt || feedback.receivedAt || feedback.deliveredAt),
  };
}

export function sanitizeRuntimeTaskClosure(closure = {}) {
  if (!closure || typeof closure !== "object") return {};
  return {
    status: cleanShortText(closure.status),
    reason: cleanShortText(closure.reason),
    policyId: cleanShortText(closure.policyId),
    archivedAt: cleanShortText(closure.archivedAt),
    updatedAt: cleanShortText(closure.updatedAt || closure.archivedAt),
  };
}

export function sanitizeRuntimeMaterialProcessing(results = []) {
  return (Array.isArray(results) ? results : []).map((result) => ({
    toolId: cleanShortText(result.toolId),
    skillId: cleanShortText(result.skillId),
    status: cleanShortText(result.status),
    summary: cleanText(result.summary),
    groundTruthSource: cleanShortText(result.groundTruthSource),
    dataset: {
      fileCount: safeNumber(result.dataset?.fileCount) || 0,
      imageCount: safeNumber(result.dataset?.imageCount) || 0,
      annotationCount: safeNumber(result.dataset?.annotationCount) || 0,
      labeledAnnotationCount: safeNumber(result.dataset?.labeledAnnotationCount) || 0,
      listRowCount: safeNumber(result.dataset?.listRowCount) || 0,
    },
    labels: Array.isArray(result.labels)
      ? result.labels.slice(0, 20).map((item) => ({
        label: cleanShortText(item.label),
        count: Number(item.count) || 0,
        fileCount: Number(item.fileCount) || 0,
      }))
      : [],
    riskCounts: Object.fromEntries(Object.entries(result.riskCounts || {})
      .slice(0, 16)
      .map(([key, value]) => [cleanShortText(key), Number(value) || 0])
      .filter(([key]) => key)),
    risks: Array.isArray(result.risks) ? result.risks.slice(0, 8).map(cleanShortText).filter(Boolean) : [],
    visualReview: {
      status: cleanShortText(result.visualReview?.status),
      sampleCount: Number(result.visualReview?.sampleCount) || 0,
      labels: Array.isArray(result.visualReview?.labels) ? result.visualReview.labels.slice(0, 24).map(cleanShortText).filter(Boolean) : [],
      seed: Number(result.visualReview?.seed) || 0,
    },
    nextGate: cleanText(result.nextGate),
  })).filter((result) => result.status || result.summary || result.toolId || result.skillId).slice(0, 20);
}

export function sanitizeRuntimeTaskExecution(execution = {}) {
  if (!execution || typeof execution !== "object") return {};
  const skillProvenance = sanitizeRuntimeSafeProvenance(execution.skillProvenance);
  const toolLoopEfficiency = sanitizeRuntimeToolEfficiency(execution.toolLoopEfficiency);
  return {
    mode: cleanShortText(execution.mode),
    status: cleanShortText(execution.status),
    startedAt: cleanShortText(execution.startedAt),
    completedAt: cleanShortText(execution.completedAt),
    failedAt: cleanShortText(execution.failedAt),
    canceledAt: cleanShortText(execution.canceledAt),
    resultSummary: cleanText(execution.resultSummary),
    nextGate: cleanText(execution.nextGate),
    agentRuntime: sanitizeAgentRuntimeEvidence(execution.agentRuntime),
    ...(skillProvenance ? { skillProvenance } : {}),
    ...(toolLoopEfficiency ? { toolLoopEfficiency } : {}),
  };
}

export function sanitizeRuntimeSafeProvenance(value = null) {
  try {
    return normalizeRuntimeSafeProvenance(value || {}, {
      expectedTaskId: value?.taskId,
      expectedEmployeeId: value?.employeeProfile?.subjectId,
      expectedEmployeeVersion: value?.employeeProfile?.sourceVersion,
    });
  } catch {
    return null;
  }
}

export function sanitizeRuntimeToolEfficiency(value = null) {
  try {
    return normalizeRuntimeToolEfficiency(value || {}, { expectedTaskId: value?.taskId });
  } catch {
    return null;
  }
}

export function sanitizeRuntimeResponsePolicy(policy = {}) {
  if (!policy || typeof policy !== "object") return {};
  return {
    id: cleanShortText(policy.id),
    mode: cleanShortText(policy.mode),
    allowTask: Boolean(policy.allowTask),
    allowModel: Boolean(policy.allowModel),
    capabilityDisclosure: cleanShortText(policy.capabilityDisclosure),
  };
}

export function sanitizeAgentRuntimeEvidence(evidence = {}) {
  if (!evidence || typeof evidence !== "object" ||
    evidence.contractVersion !== SAFE_AGENT_RUNTIME_EVIDENCE_CONTRACT_VERSION) return {};
  let activitySnapshot;
  try {
    activitySnapshot = normalizeRuntimeSafeActivitySnapshot(evidence.activitySnapshot, {
      expectedTaskId: evidence.activitySnapshot?.taskId,
    });
  } catch {
    return {};
  }
  const requestCount = safeOptionalNumber(evidence.requestCount);
  const toolCallCount = safeOptionalNumber(evidence.toolCallCount);
  const sourceContractVersion = evidence.sourceContractVersion;
  if (!["agent-runtime-evidence.v1", "runtime-safe-activity.v1"].includes(sourceContractVersion)) return {};
  return {
    contractVersion: SAFE_AGENT_RUNTIME_EVIDENCE_CONTRACT_VERSION,
    sourceContractVersion,
    adapter: cleanShortText(evidence.adapter),
    status: cleanShortText(evidence.status),
    realModelRequested: Boolean(evidence.realModelRequested),
    provider: cleanShortText(evidence.provider),
    model: cleanShortText(evidence.model),
    reasoningEffort: cleanShortText(evidence.reasoningEffort),
    requestCount,
    requestMetrics: sanitizeRequestMetrics(evidence.requestMetrics),
    toolCallCount,
    blockedReason: cleanShortText(evidence.blockedReason),
    providerDiagnostic: sanitizeProviderDiagnostic(evidence.providerDiagnostic),
    activitySnapshot,
    usage: sanitizeModelUsage(evidence.usage),
    updatedAt: cleanShortText(evidence.updatedAt),
  };
}

function sanitizeRequestMetrics(value) {
  if (!Array.isArray(value)) return [];
  return value.slice(-32).flatMap((metric) => {
    const sequence = safeNullableNumber(metric?.sequence);
    const inputItemCount = safeNullableNumber(metric?.inputItemCount);
    const inputCharacterCount = safeNullableNumber(metric?.inputCharacterCount);
    const durationMs = safeNullableNumber(metric?.durationMs);
    if (sequence === null || inputItemCount === null || inputCharacterCount === null || durationMs === null) return [];
    return [{
      sequence,
      status: metric?.status === "failed" ? "failed" : "received",
      inputItemCount,
      inputCharacterCount,
      inputTokens: safeNullableNumber(metric?.inputTokens),
      cachedInputTokens: safeNullableNumber(metric?.cachedInputTokens),
      outputTokens: safeNullableNumber(metric?.outputTokens),
      totalTokens: safeNullableNumber(metric?.totalTokens),
      durationMs,
    }];
  });
}

function safeNullableNumber(value) {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function sanitizeProviderDiagnostic(value = {}) {
  if (!value || typeof value !== "object" ||
    value.contractVersion !== PROVIDER_RUNTIME_DIAGNOSTIC_VERSION) return {};
  const httpStatus = Number(value.httpStatus);
  return {
    contractVersion: PROVIDER_RUNTIME_DIAGNOSTIC_VERSION,
    category: cleanDiagnosticToken(value.category) || "none",
    httpStatus: Number.isSafeInteger(httpStatus) && httpStatus >= 100 && httpStatus <= 599
      ? httpStatus
      : null,
    safeReasonCode: cleanDiagnosticToken(value.safeReasonCode) || "none",
    retryable: value.retryable === true,
  };
}

function sanitizeModelUsage(usage = {}) {
  if (!usage || typeof usage !== "object") return {};
  return {
    inputTokens: safeOptionalNumber(usage.inputTokens),
    outputTokens: safeOptionalNumber(usage.outputTokens),
    totalTokens: safeOptionalNumber(usage.totalTokens),
  };
}

export function sanitizeRuntimeQueuePolicy(policy = {}) {
  if (!policy || typeof policy !== "object") return {};
  const maxParallelWorkers = Number(policy.maxParallelWorkers);
  const taskBufferQueueSize = Number(policy.taskBufferQueueSize);
  const taskBufferMinutes = Number(policy.taskBufferMinutes);
  const totalTaskCapacity = Number(policy.totalTaskCapacity);
  return {
    maxParallelWorkers: Number.isFinite(maxParallelWorkers) ? maxParallelWorkers : undefined,
    taskBufferQueueSize: Number.isFinite(taskBufferQueueSize) ? taskBufferQueueSize : undefined,
    taskBufferMinutes: Number.isFinite(taskBufferMinutes) ? taskBufferMinutes : undefined,
    totalTaskCapacity: Number.isFinite(totalTaskCapacity) ? totalTaskCapacity : undefined,
  };
}

export function sanitizeRuntimeQueueState(state = {}) {
  if (!state || typeof state !== "object") return {};
  return {
    runningTaskCount: safeOptionalNumber(state.runningTaskCount),
    waitingTaskCount: safeOptionalNumber(state.waitingTaskCount),
    acceptedTaskCount: safeOptionalNumber(state.acceptedTaskCount),
    availableTaskSlots: safeOptionalNumber(state.availableTaskSlots),
  };
}

export function sanitizeTaskTrigger(trigger = {}) {
  return {
    channel: cleanShortText(trigger.channel || "feishu"),
    receiveMode: cleanShortText(trigger.receiveMode),
    eventType: cleanShortText(trigger.eventType),
    messageType: cleanShortText(trigger.messageType),
    messageId: cleanShortText(trigger.messageId),
    chatId: cleanShortText(trigger.chatId),
    senderId: cleanShortText(trigger.senderId),
    chatType: cleanShortText(trigger.chatType),
    routeKey: cleanShortText(trigger.routeKey),
    receivedAt: cleanShortText(trigger.receivedAt),
  };
}

export function sanitizeMaterialRefs(value = []) {
  return (Array.isArray(value) ? value : defaultCleanList(value)).map((item) => {
    if (item && typeof item === "object") {
      const rawRef = cleanShortText(item.ref || item.fileKey || item.file_key || item.imageKey || item.image_key || item.mediaKey || item.media_key || item.key);
      return {
        type: cleanShortText(item.type || item.messageType || "file"),
        name: cleanShortText(item.name || item.fileName || item.file_name || item.title),
        refMasked: cleanShortText(item.refMasked) || maskIdentifier(rawRef),
        refDigest: cleanShortText(item.refDigest) || digestValue(rawRef),
        mimeType: cleanShortText(item.mimeType || item.mime_type),
        sizeLabel: cleanShortText(item.sizeLabel || item.size),
        source: cleanShortText(item.source || "feishu_event"),
        intakeStatus: cleanShortText(item.intakeStatus || "metadata_only"),
      };
    }
    const text = cleanShortText(item);
    return {
      type: inferMaterialRefType(text),
      name: text,
      refMasked: "",
      refDigest: digestValue(text),
      mimeType: "",
      sizeLabel: "",
      source: "manual_evidence_ref",
      intakeStatus: "metadata_only",
    };
  }).filter((item) => item.name || item.refMasked || item.refDigest).slice(0, 12);
}

export function inferRuntimeTaskType({ messageType = "", materialRefs = [] } = {}) {
  const text = cleanShortText(messageType).toLowerCase();
  if (materialRefs.length || MATERIAL_MESSAGE_TYPES.includes(text)) return "package_intake_analysis";
  return "conversation_triage";
}

export function inferMaterialRefType(value = "") {
  const text = cleanShortText(value).toLowerCase();
  if (/\.zip$|\.tar$|\.tgz$|\.gz$|包|压缩/.test(text)) return "package";
  if (/image|png|jpg|jpeg|bmp|图/.test(text)) return "image";
  return "evidence_ref";
}

function safeNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(0, Math.floor(number)) : 0;
}

function safeOptionalNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : undefined;
}

function defaultCleanList(value) {
  const items = Array.isArray(value) ? value : String(value || "").split(/[,\n;，；、]+/);
  return [...new Set(items.map(cleanShortText).filter(Boolean))].slice(0, 30);
}

function maskIdentifier(value = "") {
  const text = cleanShortText(value);
  if (!text) return "";
  if (text.length <= 8) return `${text.slice(0, 2)}***${text.slice(-2)}`;
  return `${text.slice(0, 6)}***${text.slice(-4)}`;
}

function digestValue(value = "") {
  const text = String(value || "");
  return text ? crypto.createHash("sha256").update(text).digest("hex").slice(0, 16) : "";
}

function cleanText(value) {
  return String(value || "").replace(/\s+/g, " ").trim().slice(0, 800);
}

function cleanShortText(value) {
  return String(value || "").replace(/\s+/g, " ").trim().slice(0, 240);
}

function cleanDiagnosticToken(value) {
  const token = cleanShortText(value).toLowerCase();
  return /^[a-z][a-z0-9_]{1,119}$/.test(token) ? token : "";
}
