import crypto from "node:crypto";

const RUNTIME_TURN_CONTEXT_CONTRACT = "agent-runtime-turn-context.v1";
const AGENT_SESSION_CONTRACT = "agent-session.v2";
const DEFAULT_SESSION_REFERENCE_TTL_MS = 24 * 60 * 60 * 1000;

function assembleRuntimeTurnContext({
  decision = {},
  dependencyContext = {},
  materialToolExecutor = null,
  toolExecutor = materialToolExecutor,
  priorConversationTurns = [],
  priorSessionReferences = [],
  resourceSetup = {},
  runtimeTask = null,
  session = {},
  turn = {},
} = {}) {
  const safeTask = runtimeTask ? safeRuntimeTask(runtimeTask) : null;
  return {
    contractVersion: RUNTIME_TURN_CONTEXT_CONTRACT,
    currentTurn: {
      correlationId: cleanId(turn.correlationId),
      messageType: cleanId(turn.messageType),
      hasMaterial: Boolean(turn.hasMaterial),
      text: normalizeModelInputText(turn.text),
    },
    conversationHistory: priorConversationTurns.map(safeConversationTurn).filter(Boolean).slice(-8),
    safeContext: {
      contractVersion: RUNTIME_TURN_CONTEXT_CONTRACT,
      turn: {
        correlationId: cleanId(turn.correlationId),
        sessionRef: sessionRef(turn.sessionKey),
        messageType: cleanId(turn.messageType),
        hasMaterial: Boolean(turn.hasMaterial),
        turnIntent: cleanId(decision.turnIntent),
      },
      responsePolicy: safeResponsePolicy(decision.responsePolicy),
      invocationCheck: safeInvocationCheck(decision.invocationCheck),
      dependencyContext,
      session: {
        contractVersion: AGENT_SESSION_CONTRACT,
        sessionId: cleanId(session.sessionId),
        startedAt: cleanId(session.startedAt),
        lastInteractionAt: cleanId(session.lastInteractionAt),
        continuityMode: session.persisted ? "durable_encrypted_transcript" : "bounded_process_memory",
        historyTurnCount: priorConversationTurns.length,
        transcriptTurnCount: Number(session.transcriptTurnCount || priorConversationTurns.length),
        persistence: session.persisted ? "encrypted_local_mvp_store" : "not_persisted",
      },
      priorSessionReferences: priorSessionReferences.map(safeSessionReference).filter(Boolean).slice(0, 5),
      task: safeTask,
      toolAccess: {
        mode: toolExecutor ? "agent_selected_governed_tools" : "no_available_tools",
        availableTools: toolExecutor?.safeToolCatalog?.() || [],
        inputIds: toolExecutor?.availableInputIds?.() || [],
      },
      resourceSetup: {
        ready: Boolean(resourceSetup.ready),
        status: cleanId(resourceSetup.status),
        nextGate: cleanText(resourceSetup.nextGate),
      },
    },
  };
}

function safeConversationTurn(turn = {}) {
  const userText = normalizeModelInputText(turn.userText);
  const assistantText = normalizeModelInputText(turn.assistantText);
  if (!userText && !assistantText) return null;
  return {
    userText,
    assistantText,
    turnIntent: cleanId(turn.turnIntent),
    taskId: cleanId(turn.taskId),
    recordedAt: cleanId(turn.recordedAt),
    toolCalls: (Array.isArray(turn.toolCalls) ? turn.toolCalls : []).slice(0, 20).map(safeConversationToolCall).filter(Boolean),
  };
}

function safeConversationToolCall(call = {}) {
  const name = cleanId(call.name);
  if (!name) return null;
  return {
    callId: cleanId(call.callId),
    name,
    arguments: {
      inputId: cleanId(call.arguments?.inputId),
      skillId: cleanId(call.arguments?.skillId),
    },
    result: {
      toolId: cleanId(call.result?.toolId),
      skillId: cleanId(call.result?.skillId),
      status: cleanId(call.result?.status || call.status),
      summary: String(call.result?.summary || call.summary || "").trim().slice(0, 1200),
      nextGate: String(call.result?.nextGate || "").trim().slice(0, 1200),
    },
  };
}

function findRecentSessionReferences({ sessionKey = "", tasks = [], now = new Date().toISOString(), ttlMs = DEFAULT_SESSION_REFERENCE_TTL_MS } = {}) {
  const routeKey = digest(sessionKey);
  if (!routeKey) return [];
  const nowMs = Date.parse(now);
  return (tasks || [])
    .filter((task) => task?.trigger?.routeKey === routeKey)
    .filter((task) => (task.materialRefs || []).length || (task.materialProcessing || []).length)
    .filter((task) => {
      const updatedAtMs = Date.parse(task.updatedAt || task.submittedAt);
      return !Number.isFinite(nowMs) || !Number.isFinite(updatedAtMs) || nowMs - updatedAtMs <= ttlMs;
    })
    .sort((left, right) => Date.parse(right.updatedAt || right.submittedAt) - Date.parse(left.updatedAt || left.submittedAt))
    .slice(0, 5)
    .map(safeSessionReference)
    .filter(Boolean);
}

function safeSessionReference(task = {}) {
  const taskId = cleanId(task?.id || task?.taskId);
  if (!taskId) return null;
  return {
    taskId,
    status: cleanId(task.status),
    taskType: cleanId(task.taskType),
    updatedAt: cleanId(task.updatedAt || task.submittedAt),
    materialHandles: (task.materialRefs || task.materialHandles || []).slice(0, 12).map((item) => ({
      refDigest: cleanId(item.refDigest),
      type: cleanId(item.type),
      name: cleanText(item.name),
      intakeStatus: cleanId(item.intakeStatus),
    })),
    materialProcessing: (task.materialProcessing || []).slice(0, 12).map(safeMaterialProcessing),
  };
}

function safeRuntimeTask(task = {}) {
  return {
    id: cleanId(task.id),
    taskType: cleanId(task.taskType),
    status: cleanId(task.status),
    statusLabel: cleanText(task.statusLabel),
    nextGate: cleanText(task.nextGate),
    materialIntake: (task.materialRefs || []).map((item) => ({
      refDigest: cleanId(item.refDigest),
      type: cleanId(item.type),
      intakeStatus: cleanId(item.intakeStatus),
    })),
    materialProcessing: (task.materialProcessing || []).map(safeMaterialProcessing),
  };
}

function safeMaterialProcessing(item = {}) {
  return {
    toolId: cleanId(item.toolId),
    skillId: cleanId(item.skillId),
    status: cleanId(item.status),
    summary: cleanText(item.summary),
    groundTruthSource: cleanId(item.groundTruthSource),
    dataset: item.dataset || {},
    labels: Array.isArray(item.labels) ? item.labels.slice(0, 20) : [],
    riskCounts: item.riskCounts || {},
    risks: Array.isArray(item.risks) ? item.risks.slice(0, 8) : [],
    nextGate: cleanText(item.nextGate),
  };
}

function safeResponsePolicy(policy = {}) {
  return {
    id: cleanId(policy.id),
    mode: cleanId(policy.mode),
    allowTask: Boolean(policy.allowTask),
    allowModel: Boolean(policy.allowModel),
    capabilityDisclosure: cleanId(policy.capabilityDisclosure),
  };
}

function safeInvocationCheck(check = {}) {
  return {
    status: cleanId(check.status),
    outcome: cleanId(check.outcome),
    reason: cleanId(check.reason),
    nextGate: cleanText(check.nextGate),
  };
}

function sessionRef(sessionKey = "") {
  const value = digest(sessionKey);
  return value ? `session://${value.slice(0, 20)}` : "";
}

function digest(value = "") {
  const text = String(value || "").trim();
  return text ? crypto.createHash("sha256").update(text).digest("hex").slice(0, 16) : "";
}

function cleanId(value = "") {
  return String(value || "").trim().slice(0, 160);
}

function cleanText(value = "") {
  return String(value || "").replace(/\s+/g, " ").trim().slice(0, 800);
}

function normalizeModelInputText(value = "") {
  return String(value || "").replace(/\r\n?/g, "\n").trim();
}

export {
  DEFAULT_SESSION_REFERENCE_TTL_MS,
  RUNTIME_TURN_CONTEXT_CONTRACT,
  assembleRuntimeTurnContext,
  findRecentSessionReferences,
  normalizeModelInputText,
};
