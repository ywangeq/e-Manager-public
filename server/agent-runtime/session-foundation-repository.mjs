import { normalizeAgentExecutionBudget } from "./agent-execution-budget.mjs";
import { normalizedOutputFormat } from "./agent-output-format.mjs";
import crypto from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { SESSION_ROUTE_CONTRACT, SESSION_ROUTE_ID_MAX_LENGTH } from "./session-route.mjs";
import { SESSION_FOUNDATION_STORE_CONTRACT } from "./session-foundation-store.mjs";

const SESSION_ROW_CONTRACT = "session-row.v1";
const TRANSCRIPT_ENTRY_CONTRACT = "transcript-entry.v1";
const SESSION_FOUNDATION_DELETION_EVIDENCE_CONTRACT = "session-foundation-deletion-evidence.v1";
const SESSION_STATUSES = new Set(["active", "ended", "archived"]);
const MESSAGE_ROLES = new Set(["user", "assistant"]);
const TRANSCRIPT_ENTRY_TYPES = new Set(["message", "toolCall", "toolResult"]);
// Protocol bound for replay-key parsing and abuse resistance, not a business access policy.
const IDEMPOTENCY_KEY_MAX_LENGTH = 240;
const TASK_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:@-]{0,127}$/;

function createSessionFoundationRepository({
  createId = (prefix) => `${prefix}-${crypto.randomUUID()}`,
  now = () => Date.now(),
  policy,
  routeVerifier,
  store,
} = {}) {
  assertStore(store);
  const effectivePolicy = normalizePolicy(policy);
  const verifyRoute = normalizeRouteVerifier(routeVerifier);
  const mutationTails = new Map();

  async function openSession({ at = now(), route } = {}) {
    const safeRoute = requireSessionRoute(route, verifyRoute);
    return serializeMutation(safeRoute.routeDigest, async () => mutateRouteState(safeRoute.routeDigest, async (state) => {
      const current = currentActiveRow(state);
      if (current) {
        const idleDecision = normalizeIdleDecision(await effectivePolicy.idle.evaluate({ at: timestamp(at), session: clone(current) }));
        if (!idleDecision.reset) return unchanged(current);
        if (!await effectivePolicy.reset.authorize({ at: timestamp(at), mode: "automatic", reason: idleDecision.reason, session: clone(current) })) {
          return unchanged(current);
        }
        const reset = resetInRouteState(state, { at, reason: idleDecision.reason, route: safeRoute, session: current });
        return changed(reset.result.session);
      }
      const session = createSessionRow({ at, route: safeRoute });
      state.sessionRows[session.sessionId] = session;
      state.headSessionId = session.sessionId;
      state.transcriptEntries[session.sessionId] = [];
      return changed(session);
    }));
  }

  async function appendTranscriptEntry({
    at = now(),
    commitGuard = null,
    entry,
    expectedRevision,
    extendsInteraction = false,
    idempotencyKey,
    route,
    sessionId = "",
  } = {}) {
    const safeRoute = requireSessionRoute(route, verifyRoute);
    const authorizeCommit = normalizeCommitGuard(commitGuard);
    const safeIdempotencyKey = requiredIdempotencyKey(idempotencyKey);
    const normalizedEntry = normalizeTranscriptPayload(entry);
    return serializeMutation(safeRoute.routeDigest, async () => mutateRouteState(safeRoute.routeDigest, (state) => {
      const session = currentActiveRow(state);
      if (!session) throw repositoryError("active_session_not_found");
      if (sessionId && session.sessionId !== sessionId) throw repositoryError("session_route_mismatch");
      const entries = state.transcriptEntries[session.sessionId] || [];
      validateTranscriptEntries(entries, session.sessionId);
      const replayedEntry = entries.find((item) => item.idempotencyKey === safeIdempotencyKey);
      if (replayedEntry) {
        if (!sameTranscriptPayload(replayedEntry, normalizedEntry)) {
          throw repositoryError("transcript_idempotency_conflict");
        }
        return unchanged({ entry: replayedEntry, session });
      }
      if (expectedRevision !== undefined && session.revision !== expectedRevision) throw repositoryError("session_revision_conflict");
      if (entries.length >= effectivePolicy.limits.maxEntriesPerSession) {
        throw repositoryError("session_transcript_entry_limit_reached");
      }
      const nextEntry = createTranscriptEntry({
        at,
        entry: normalizedEntry,
        entryId: createId("entry"),
        entries,
        idempotencyKey: safeIdempotencyKey,
        sessionId: session.sessionId,
      });
      const entryBytes = Buffer.byteLength(JSON.stringify(nextEntry), "utf8");
      if (entryBytes > effectivePolicy.limits.maxEntryBytes) throw repositoryError("session_transcript_entry_too_large");
      state.transcriptEntries[session.sessionId] = [...entries, nextEntry];
      const updatedAt = timestamp(at);
      state.sessionRows[session.sessionId] = {
        ...session,
        lastInteractionAt: extendsInteraction ? laterTimestamp(session.lastInteractionAt, updatedAt) : session.lastInteractionAt,
        updatedAt: laterTimestamp(session.updatedAt, updatedAt),
        revision: session.revision + 1,
        transcriptEntryCount: entries.length + 1,
      };
      return changed({ entry: nextEntry, session: state.sessionRows[session.sessionId] });
    }, { commitGuard: authorizeCommit }));
  }

  async function resetSession({ at = now(), expectedRevision, reason, route } = {}) {
    const safeRoute = requireSessionRoute(route, verifyRoute);
    const safeReason = requiredText(reason, "reset reason");
    return serializeMutation(safeRoute.routeDigest, async () => mutateRouteState(safeRoute.routeDigest, async (state) => {
      const session = currentActiveRow(state);
      if (!session) throw repositoryError("active_session_not_found");
      if (expectedRevision !== undefined && session.revision !== expectedRevision) throw repositoryError("session_revision_conflict");
      if (!await effectivePolicy.reset.authorize({ at: timestamp(at), mode: "explicit", reason: safeReason, session: clone(session) })) {
        throw repositoryError("session_reset_not_authorized_by_policy");
      }
      return resetInRouteState(state, { at, reason: safeReason, route: safeRoute, session });
    }));
  }

  async function endSession({ at = now(), expectedRevision, reason, route } = {}) {
    const safeRoute = requireSessionRoute(route, verifyRoute);
    const safeReason = requiredText(reason, "end reason");
    return serializeMutation(safeRoute.routeDigest, async () => mutateRouteState(safeRoute.routeDigest, (state) => {
      const session = currentActiveRow(state);
      if (!session) throw repositoryError("active_session_not_found");
      if (expectedRevision !== undefined && session.revision !== expectedRevision) throw repositoryError("session_revision_conflict");
      const ended = transitionSession(session, { at, reason: safeReason, status: "ended" });
      state.sessionRows[session.sessionId] = ended;
      state.headSessionId = "";
      return changed(ended);
    }));
  }

  async function archiveSession({ at = now(), expectedRevision, reason, sessionId } = {}) {
    const safeSessionId = requiredText(sessionId, "sessionId");
    const safeReason = requiredText(reason, "archive reason");
    const located = await store.readSessionState(safeSessionId);
    if (!located) throw repositoryError("session_not_found");
    return serializeMutation(located.routeDigest, async () => mutateRouteState(located.routeDigest, (state) => {
      const session = state.sessionRows[safeSessionId];
      if (!session) throw repositoryError("session_not_found");
      if (expectedRevision !== undefined && session.revision !== expectedRevision) throw repositoryError("session_revision_conflict");
      const archived = transitionSession(session, { at, reason: safeReason, status: "archived" });
      state.sessionRows[safeSessionId] = archived;
      if (state.headSessionId === safeSessionId) state.headSessionId = "";
      return changed(archived);
    }));
  }

  async function deleteSession({ at = now(), mode, reason, sessionId } = {}) {
    const safeSessionId = requiredText(sessionId, "sessionId");
    const safeReason = requiredText(reason, "delete reason");
    const located = await store.readSessionState(safeSessionId);
    if (!located) throw repositoryError("session_not_found");
    const deletion = await serializeMutation(located.routeDigest, async () => mutateRouteState(located.routeDigest, async (state) => {
      const session = state.sessionRows[safeSessionId];
      if (!session) throw repositoryError("session_not_found");
      if (!await effectivePolicy.retention.authorizeDelete({
        at: timestamp(at),
        mode: requiredText(mode, "delete mode"),
        reason: safeReason,
        session: clone(session),
      })) {
        throw repositoryError("session_delete_not_authorized_by_policy");
      }
      const transcriptDeletedCount = (state.transcriptEntries[safeSessionId] || []).length;
      const routeHeadDeleted = state.headSessionId === safeSessionId;
      delete state.sessionRows[safeSessionId];
      delete state.transcriptEntries[safeSessionId];
      if (routeHeadDeleted) state.headSessionId = "";
      return changed({
        routeDigest: state.routeDigest,
        sessionId: safeSessionId,
        sessionRowDeleted: true,
        transcriptDeletedCount,
        routeHeadDeleted,
      });
    }));
    const [sessionVerification, routeVerification] = await Promise.all([
      store.readSessionState(safeSessionId),
      store.readRouteState(deletion.routeDigest),
    ]);
    const sessionRowAbsent = !sessionVerification;
    const transcriptEntriesAbsent = !Object.hasOwn(routeVerification.transcriptEntries, safeSessionId);
    const routeHeadAbsent = routeVerification.headSessionId !== safeSessionId;
    const { routeDigest: _routeDigest, ...publicDeletion } = deletion;
    return {
      ...publicDeletion,
      deletionEvidence: {
        contractVersion: SESSION_FOUNDATION_DELETION_EVIDENCE_CONTRACT,
        scope: "session_foundation_store",
        sessionId: safeSessionId,
        verifiedAt: timestamp(now()),
        foundationStoreDeletionConfirmed: sessionRowAbsent && transcriptEntriesAbsent && routeHeadAbsent,
        routeHead: { deleted: deletion.routeHeadDeleted, confirmedAbsent: routeHeadAbsent },
        sessionRow: { deleted: deletion.sessionRowDeleted, confirmedAbsent: sessionRowAbsent },
        transcriptEntries: { deletedCount: deletion.transcriptDeletedCount, confirmedAbsent: transcriptEntriesAbsent },
        excludedScopes: ["external_indexes", "provider_state", "memory_systems"],
      },
    };
  }

  async function readCurrentSession(route) {
    const safeRoute = requireSessionRoute(route, verifyRoute);
    const state = await store.readRouteState(safeRoute.routeDigest);
    const row = currentActiveRow(state);
    return row ? clone(row) : null;
  }

  async function readSession(sessionId) {
    const located = await store.readSessionState(requiredText(sessionId, "sessionId"));
    const row = located?.sessionRow;
    if (!located || !row) return null;
    validateSessionRow(row);
    return clone(row);
  }

  async function readVerifiedRoute(sessionId) {
    const row = await readSession(sessionId);
    if (!row) return null;
    return requireSessionRoute({
      contractVersion: SESSION_ROUTE_CONTRACT,
      routeDigest: row.routeDigest,
      routeRef: row.routeRef,
      centerInstanceId: row.centerInstanceId,
      tenantScope: row.tenantScope,
      actorIssuer: row.actorIssuer,
      actorSubjectDigest: row.actorSubjectDigest,
      employeeId: row.employeeId,
      channelId: row.channelId,
      accountId: row.accountId,
      conversationType: row.conversationType,
      conversationDigest: row.conversationDigest,
      threadDigest: row.threadDigest,
      integrityMac: row.routeIntegrityMac,
    }, verifyRoute);
  }

  async function readTranscript(sessionId) {
    const safeSessionId = requiredText(sessionId, "sessionId");
    const located = await store.readSessionState(safeSessionId);
    if (!located) return null;
    const entries = located.transcriptEntries || [];
    validateTranscriptEntries(entries, safeSessionId);
    return clone(entries);
  }

  function createSessionRow({ at, route }) {
    const createdAt = timestamp(at);
    return {
      contractVersion: SESSION_ROW_CONTRACT,
      routeDigest: route.routeDigest,
      routeRef: route.routeRef,
      routeIntegrityMac: route.integrityMac,
      centerInstanceId: route.centerInstanceId,
      tenantScope: route.tenantScope,
      actorIssuer: route.actorIssuer,
      actorSubjectDigest: route.actorSubjectDigest,
      employeeId: route.employeeId,
      channelId: route.channelId,
      accountId: route.accountId,
      conversationType: route.conversationType,
      conversationDigest: route.conversationDigest,
      threadDigest: route.threadDigest,
      sessionId: requiredText(createId("session"), "issued sessionId"),
      sessionStartedAt: createdAt,
      lastInteractionAt: createdAt,
      updatedAt: createdAt,
      revision: 1,
      status: "active",
      statusReason: "",
      endedAt: "",
      archivedAt: "",
      transcriptEntryCount: 0,
    };
  }

  function resetInRouteState(state, { at, reason, route, session }) {
    const effectiveAt = laterTimestamp(session.updatedAt, timestamp(at));
    const ended = transitionSession(session, { at: effectiveAt, reason, status: "ended" });
    const replacement = createSessionRow({ at: effectiveAt, route });
    state.sessionRows[ended.sessionId] = ended;
    state.sessionRows[replacement.sessionId] = replacement;
    state.transcriptEntries[replacement.sessionId] = [];
    state.headSessionId = replacement.sessionId;
    return changed({ previousSession: ended, session: replacement });
  }

  async function mutateRouteState(routeDigest, transform, { commitGuard = null } = {}) {
    for (let attempt = 1; attempt <= effectivePolicy.limits.maxCasRetries; attempt += 1) {
      const state = await store.readRouteState(routeDigest);
      const outcome = await transform(state);
      if (!outcome.changed) return clone(outcome.result);
      if (commitGuard && commitGuard() !== true) throw repositoryError("session_mutation_commit_rejected");
      const compareAndSwap = store.compareAndSwapRouteState(routeDigest, state.revision, state);
      if (await compareAndSwap) return clone(outcome.result);
    }
    throw repositoryError("session_store_cas_exhausted");
  }

  function serializeMutation(routeDigest, run) {
    const previous = mutationTails.get(routeDigest) || Promise.resolve();
    const next = previous.catch(() => {}).then(run);
    mutationTails.set(routeDigest, next);
    return next.finally(() => {
      if (mutationTails.get(routeDigest) === next) mutationTails.delete(routeDigest);
    });
  }

  return {
    appendTranscriptEntry,
    archiveSession,
    deleteSession,
    endSession,
    openSession,
    readCurrentSession,
    readSession,
    readTranscript,
    readVerifiedRoute,
    resetSession,
  };
}

function createTranscriptEntry({ at, entry = {}, entryId, entries, idempotencyKey, sessionId }) {
  const type = requiredText(entry.type, "transcript entry type");
  if (!TRANSCRIPT_ENTRY_TYPES.has(type)) throw repositoryError("transcript_entry_type_invalid");
  const base = {
    contractVersion: TRANSCRIPT_ENTRY_CONTRACT,
    entryId: requiredText(entryId, "issued entryId"),
    idempotencyKey: requiredIdempotencyKey(idempotencyKey),
    sessionId,
    seq: entries.length + 1,
    type,
    createdAt: timestamp(at),
  };
  if (entries.some((item) => item.entryId === base.entryId)) throw repositoryError("transcript_entry_id_duplicate");
  if (type === "message") return { ...base, message: normalizeMessage(entry.message) };
  if (type === "toolCall") {
    const toolCall = normalizeToolCall(entry.toolCall);
    if (entries.some((item) => item.type === "toolCall" && item.toolCall.callId === toolCall.callId)) {
      throw repositoryError("transcript_tool_call_duplicate");
    }
    return { ...base, toolCall };
  }
  const toolResult = normalizeToolResult(entry.toolResult);
  const matchingCall = entries.find((item) => item.type === "toolCall" && item.toolCall.callId === toolResult.callId);
  const existingResult = entries.find((item) => item.type === "toolResult" && item.toolResult.callId === toolResult.callId);
  if (!matchingCall || matchingCall.toolCall.toolId !== toolResult.toolId) throw repositoryError("transcript_tool_result_without_matching_call");
  if (existingResult) throw repositoryError("transcript_tool_result_duplicate");
  return { ...base, toolResult };
}

function validateTranscriptEntries(entries = [], sessionId = "", { requireCompleteToolPairs = false } = {}) {
  const toolCalls = new Map();
  const toolResults = new Set();
  const entryIds = new Set();
  const idempotencyKeys = new Set();
  entries.forEach((entry, index) => {
    if (entry?.contractVersion !== TRANSCRIPT_ENTRY_CONTRACT || entry.sessionId !== sessionId || entry.seq !== index + 1) {
      throw repositoryError("transcript_sequence_invalid");
    }
    requiredText(entry.entryId, "transcript entryId");
    timestamp(entry.createdAt);
    if (entryIds.has(entry.entryId)) throw repositoryError("transcript_entry_id_duplicate");
    entryIds.add(entry.entryId);
    const idempotencyKey = requiredIdempotencyKey(entry.idempotencyKey);
    if (idempotencyKeys.has(idempotencyKey)) throw repositoryError("transcript_idempotency_key_duplicate");
    idempotencyKeys.add(idempotencyKey);
    if (entry.type === "message") {
      normalizeMessage(entry.message);
      return;
    }
    if (entry.type === "toolCall") {
      const call = normalizeToolCall(entry.toolCall);
      if (toolCalls.has(call.callId)) throw repositoryError("transcript_tool_call_duplicate");
      toolCalls.set(call.callId, call.toolId);
      return;
    }
    if (entry.type === "toolResult") {
      const result = normalizeToolResult(entry.toolResult);
      if (toolCalls.get(result.callId) !== result.toolId) throw repositoryError("transcript_tool_result_without_matching_call");
      if (toolResults.has(result.callId)) throw repositoryError("transcript_tool_result_duplicate");
      toolResults.add(result.callId);
      return;
    }
    throw repositoryError("transcript_entry_type_invalid");
  });
  if (requireCompleteToolPairs && [...toolCalls.keys()].some((callId) => !toolResults.has(callId))) {
    throw repositoryError("transcript_tool_call_without_result");
  }
  return true;
}

function normalizeMessage(value = {}) {
  const role = requiredText(value.role, "message role");
  const content = requiredContent(value.content, "message content");
  if (!MESSAGE_ROLES.has(role)) throw repositoryError("transcript_message_role_invalid");
  const taskId = String(value.taskId || "");
  if (taskId && (role !== "assistant" || !TASK_ID_PATTERN.test(taskId))) {
    throw repositoryError("transcript_message_task_id_invalid");
  }
  if (value.outputFormat != null && role !== "user") throw repositoryError("transcript_message_output_format_invalid");
  if (value.executionBudget != null && role !== "user") throw repositoryError("transcript_message_execution_budget_invalid");
  const executionBudget = normalizeAgentExecutionBudget(value.executionBudget);
  const outputFormat = value.outputFormat == null ? null : normalizedOutputFormat(value.outputFormat);
  return { role, content, ...(taskId ? { taskId } : {}), ...(outputFormat ? { outputFormat } : {}), ...(executionBudget ? { executionBudget } : {}) };
}

function normalizeTranscriptPayload(entry = {}) {
  const type = requiredText(entry.type, "transcript entry type");
  if (!TRANSCRIPT_ENTRY_TYPES.has(type)) throw repositoryError("transcript_entry_type_invalid");
  if (type === "message") return { type, message: normalizeMessage(entry.message) };
  if (type === "toolCall") return { type, toolCall: normalizeToolCall(entry.toolCall) };
  return { type, toolResult: normalizeToolResult(entry.toolResult) };
}

function sameTranscriptPayload(entry, normalizedEntry) {
  return isDeepStrictEqual(normalizeTranscriptPayload(entry), normalizedEntry);
}

function normalizeToolCall(value = {}) {
  return {
    callId: requiredText(value.callId, "tool callId"),
    toolId: requiredText(value.toolId, "tool toolId"),
    safeArguments: jsonValue(value.safeArguments || {}),
  };
}

function normalizeToolResult(value = {}) {
  return {
    callId: requiredText(value.callId, "tool result callId"),
    toolId: requiredText(value.toolId, "tool result toolId"),
    status: requiredText(value.status, "tool result status"),
    safeSummary: requiredContent(value.safeSummary, "tool result safeSummary"),
    evidenceRefIds: (Array.isArray(value.evidenceRefIds) ? value.evidenceRefIds : []).map((item) => requiredText(item, "evidenceRefId")),
  };
}

function transitionSession(session, { at, reason, status }) {
  if (!SESSION_STATUSES.has(status)) throw repositoryError("session_status_invalid");
  const changedAt = laterTimestamp(session.updatedAt, timestamp(at));
  return {
    ...session,
    status,
    statusReason: reason,
    endedAt: status === "ended" ? changedAt : session.endedAt,
    archivedAt: status === "archived" ? changedAt : session.archivedAt,
    updatedAt: changedAt,
    revision: session.revision + 1,
  };
}

function currentActiveRow(state) {
  const sessionId = state.headSessionId;
  const row = sessionId ? state.sessionRows[sessionId] : null;
  if (row) validateSessionRow(row);
  return row?.status === "active" && row.routeDigest === state.routeDigest ? row : null;
}

function validateSessionRow(row) {
  if (row?.contractVersion !== SESSION_ROW_CONTRACT || !/^[a-f0-9]{64}$/.test(row.routeDigest || "") ||
    row.routeRef !== `session-route://${row.routeDigest}` || !/^[a-f0-9]{64}$/.test(row.routeIntegrityMac || "")) {
    throw repositoryError("session_row_invalid");
  }
  for (const field of ["centerInstanceId", "tenantScope", "actorIssuer", "employeeId", "channelId", "accountId", "conversationType"]) {
    requiredRouteId(row[field], field);
  }
  requiredText(row.sessionId, "session row sessionId");
  timestamp(row.sessionStartedAt);
  timestamp(row.lastInteractionAt);
  timestamp(row.updatedAt);
  if (!Number.isInteger(row.revision) || row.revision <= 0 || !SESSION_STATUSES.has(row.status)) {
    throw repositoryError("session_row_invalid");
  }
  if (!Number.isInteger(row.transcriptEntryCount) || row.transcriptEntryCount < 0) {
    throw repositoryError("session_row_invalid");
  }
  return true;
}

function requireSessionRoute(route, verifyRoute) {
  if (!route || route.contractVersion !== SESSION_ROUTE_CONTRACT || !/^[a-f0-9]{64}$/.test(route.routeDigest || "") ||
    route.routeRef !== `session-route://${route.routeDigest}`) {
    throw repositoryError("session_route_invalid");
  }
  for (const field of ["centerInstanceId", "tenantScope", "actorIssuer", "employeeId", "channelId", "accountId", "conversationType"]) {
    requiredRouteId(route[field], field);
  }
  let verified = false;
  try {
    verified = verifyRoute(route) === true;
  } catch {
    verified = false;
  }
  if (!verified) throw repositoryError("session_route_integrity_invalid");
  return clone(route);
}

function normalizePolicy(policy = {}) {
  const limits = policy.limits || {};
  if (typeof policy.idle?.evaluate !== "function") throw new TypeError("session policy requires idle.evaluate");
  if (typeof policy.reset?.authorize !== "function") throw new TypeError("session policy requires reset.authorize");
  if (typeof policy.retention?.authorizeDelete !== "function") throw new TypeError("session policy requires retention.authorizeDelete");
  for (const field of ["maxEntriesPerSession", "maxEntryBytes", "maxCasRetries"]) {
    if (!Number.isInteger(limits[field]) || limits[field] <= 0) throw new TypeError(`session policy requires positive limits.${field}`);
  }
  return policy;
}

function assertStore(store) {
  if (store?.contractVersion !== SESSION_FOUNDATION_STORE_CONTRACT ||
    typeof store.readRouteState !== "function" || typeof store.compareAndSwapRouteState !== "function" ||
    typeof store.readSessionState !== "function") {
    throw new TypeError(`session repository requires a ${SESSION_FOUNDATION_STORE_CONTRACT} store`);
  }
}

function normalizeRouteVerifier(value) {
  if (typeof value !== "function") throw new TypeError("session repository requires routeVerifier");
  return value;
}

function normalizeIdleDecision(value) {
  if (value === false || value == null) return { reset: false, reason: "" };
  if (value === true) throw new TypeError("idle.evaluate must provide a reset reason");
  return {
    reset: Boolean(value.reset),
    reason: value.reset ? requiredText(value.reason, "automatic reset reason") : "",
  };
}

function normalizeCommitGuard(value) {
  if (value == null) return null;
  if (typeof value !== "function") throw new TypeError("session mutation commitGuard must be a function");
  return () => {
    try {
      return value() === true;
    } catch {
      return false;
    }
  };
}

function changed(result) {
  return { changed: true, result };
}

function unchanged(result) {
  return { changed: false, result };
}

function timestamp(value) {
  const time = value instanceof Date
    ? value.getTime()
    : typeof value === "number"
      ? value
      : Date.parse(String(value || ""));
  if (!Number.isFinite(time)) throw new TypeError("session mutation requires a valid timestamp");
  return new Date(time).toISOString();
}

function laterTimestamp(left, right) {
  return Date.parse(left) >= Date.parse(right) ? left : right;
}

function requiredText(value, field) {
  const text = String(value ?? "").trim();
  if (!text) throw new TypeError(`session foundation requires ${field}`);
  if (/[\u0000-\u001f\u007f]/.test(text)) throw new TypeError(`session foundation ${field} contains control characters`);
  return text;
}

function requiredContent(value, field) {
  const text = String(value ?? "").trim();
  if (!text) throw new TypeError(`session foundation requires ${field}`);
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(text)) {
    throw new TypeError(`session foundation ${field} contains unsafe control characters`);
  }
  return text;
}

function requiredIdempotencyKey(value) {
  const key = String(value ?? "").trim();
  if (!key || key.length > IDEMPOTENCY_KEY_MAX_LENGTH || !/^[A-Za-z0-9][A-Za-z0-9._:/-]*$/.test(key)) {
    throw repositoryError("transcript_idempotency_key_invalid");
  }
  return key;
}

function requiredRouteId(value, field) {
  const id = requiredText(value, `session route ${field}`);
  if (id.length > SESSION_ROUTE_ID_MAX_LENGTH) throw repositoryError("session_route_invalid");
  return id;
}

function jsonValue(value) {
  try {
    return JSON.parse(JSON.stringify(value));
  } catch {
    throw repositoryError("transcript_json_value_invalid");
  }
}

function repositoryError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

function clone(value) {
  return structuredClone(value);
}

export {
  IDEMPOTENCY_KEY_MAX_LENGTH,
  SESSION_FOUNDATION_DELETION_EVIDENCE_CONTRACT,
  SESSION_ROW_CONTRACT,
  TRANSCRIPT_ENTRY_CONTRACT,
  createSessionFoundationRepository,
  validateTranscriptEntries,
};
