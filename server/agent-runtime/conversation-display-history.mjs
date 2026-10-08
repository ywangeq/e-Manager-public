const DISPLAY_HISTORY_CONTRACT = "conversation-display-history.v1";
const HISTORY_SOURCE = "center_projection";
const HISTORY_POLICY_CONTRACT = "desktop-conversation-history-policy.v1";

function createConversationDisplayHistoryService({
  repository,
  resolveManagedPolicy,
  verifyRoute,
} = {}) {
  if (!repository || typeof repository.readSession !== "function" || typeof repository.readTranscript !== "function") {
    throw new TypeError("conversation display history requires a session foundation repository");
  }
  if (typeof resolveManagedPolicy !== "function") {
    throw new TypeError("conversation display history requires resolveManagedPolicy");
  }
  if (typeof verifyRoute !== "function") {
    throw new TypeError("conversation display history requires verifyRoute");
  }

  async function read({ beforeSeq = null, route, sessionId } = {}) {
    const safeSessionId = requiredIdentifier(sessionId, "sessionId");
    const safeRoute = verifiedRoute(route, verifyRoute);
    const session = await repository.readSession(safeSessionId);
    if (!session) throw displayHistoryError("display_history_session_not_found");
    assertSessionRouteBinding(session, safeRoute, safeSessionId);

    const policyResult = await resolveManagedPolicy({ route: clone(safeRoute), session: clone(session) });
    const policy = authorizedPolicy(policyResult, session);
    const cursor = normalizeBeforeSeq(beforeSeq);
    if (cursor !== null && !policy.projection.paging) {
      throw displayHistoryError("display_history_paging_disabled");
    }

    const transcript = await repository.readTranscript(safeSessionId);
    if (!Array.isArray(transcript)) throw displayHistoryError("display_history_transcript_unavailable");
    const visible = transcript.filter((entry) => (
      entry?.type === "message" &&
      Number.isSafeInteger(entry.seq) && entry.seq > 0 &&
      (cursor === null || entry.seq < cursor)
    ));
    const page = newestBoundedPage(visible, policy.offlineCache);
    if (page.hasMore && !policy.projection.paging) {
      throw displayHistoryError("display_history_paging_disabled");
    }

    return {
      contractVersion: DISPLAY_HISTORY_CONTRACT,
      historySource: HISTORY_SOURCE,
      centerInstanceId: session.centerInstanceId,
      tenantScope: session.tenantScope,
      employeeId: session.employeeId,
      sessionId: session.sessionId,
      revision: session.revision,
      status: session.status,
      sessionUpdatedAt: session.updatedAt,
      turns: page.entries.map(projectMessage),
      page: {
        beforeSeq: cursor,
        nextBeforeSeq: page.entries.length ? page.entries[0].seq : 0,
        hasMore: page.hasMore,
      },
      policyVersion: policy.policyVersion,
    };
  }

  return { read };
}

function newestBoundedPage(entries, limits) {
  const selected = [];
  let chars = 0;
  let index = entries.length - 1;
  for (; index >= 0; index -= 1) {
    const entry = entries[index];
    const content = String(entry?.message?.content ?? "");
    if (!content || !["user", "assistant"].includes(entry?.message?.role)) {
      throw displayHistoryError("display_history_transcript_invalid");
    }
    if (selected.length >= limits.maxTurns || chars + content.length > limits.maxChars) break;
    selected.push(entry);
    chars += content.length;
  }
  selected.reverse();
  if (!selected.length && entries.length) {
    throw displayHistoryError("display_history_projection_limit_exceeded");
  }
  return { entries: selected, hasMore: index >= 0 };
}

function projectMessage(entry) {
  return {
    seq: entry.seq,
    role: entry.message.role,
    text: entry.message.content,
    createdAt: validTimestamp(entry.createdAt, "turn createdAt"),
    ...(entry.message.taskId ? { taskId: entry.message.taskId } : {}),
  };
}

function authorizedPolicy(result, session) {
  const policy = result?.policy;
  if (result?.ok !== true || result?.enabled !== true || result?.status !== "enabled" ||
    !isPlainObject(policy) || policy.contractVersion !== HISTORY_POLICY_CONTRACT ||
    policy.historySource !== HISTORY_SOURCE || policy.centerInstanceId !== session.centerInstanceId ||
    policy.tenantScope !== session.tenantScope || !policy.projection?.messageGet || !policy.projection?.revision ||
    policy.offlineCache?.mode !== "encrypted_read_only") {
    throw displayHistoryError("display_history_policy_denied");
  }
  for (const field of ["maxTurns", "maxChars"]) {
    if (!Number.isSafeInteger(policy.offlineCache[field]) || policy.offlineCache[field] <= 0) {
      throw displayHistoryError("display_history_policy_invalid");
    }
  }
  requiredIdentifier(policy.policyVersion, "policyVersion");
  return policy;
}

function verifiedRoute(route, verifyRoute) {
  let verified = false;
  try {
    verified = verifyRoute(route) === true;
  } catch {
    verified = false;
  }
  if (!verified) throw displayHistoryError("display_history_route_invalid");
  return clone(route);
}

function assertSessionRouteBinding(session, route, sessionId) {
  const matches = session.sessionId === sessionId && session.routeDigest === route.routeDigest &&
    session.centerInstanceId === route.centerInstanceId && session.tenantScope === route.tenantScope &&
    session.actorIssuer === route.actorIssuer && session.actorSubjectDigest === route.actorSubjectDigest &&
    session.employeeId === route.employeeId && session.channelId === route.channelId &&
    session.accountId === route.accountId && session.conversationType === route.conversationType;
  if (!matches) throw displayHistoryError("display_history_access_denied");
}

function normalizeBeforeSeq(value) {
  if (value === null || value === undefined || value === "") return null;
  const number = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(number) || number <= 0) throw displayHistoryError("display_history_cursor_invalid");
  return number;
}

function requiredIdentifier(value, field) {
  const text = String(value ?? "").trim();
  if (!text || text.length > 512 || /[\u0000-\u001f\u007f]/.test(text)) {
    throw displayHistoryError(`display_history_${field}_invalid`);
  }
  return text;
}

function validTimestamp(value, field) {
  const timestamp = String(value || "");
  if (!Number.isFinite(Date.parse(timestamp))) throw displayHistoryError(`display_history_${field}_invalid`);
  return timestamp;
}

function displayHistoryError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

function isPlainObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function clone(value) {
  return structuredClone(value);
}

export {
  DISPLAY_HISTORY_CONTRACT,
  createConversationDisplayHistoryService,
};
