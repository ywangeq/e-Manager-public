import crypto from "node:crypto";
import { ISSUED_CREDENTIAL_CONTRACT_VERSION } from "./current-user-tool-lease-service.mjs";

const BROKER_CONTRACT_VERSION = "current-user-tool-credential-challenge-broker.v1";
const CHALLENGE_CONTRACT_VERSION = "current-user-tool-credential-challenge.v1";
const POLL_CONTRACT_VERSION = "current-user-tool-credential-challenge-poll.v1";
const RESPONSE_CONTRACT_VERSION = "current-user-tool-credential-challenge-response.v1";
const DATAFLOW_EVIDENCE_CONTRACT_VERSION = "dataflow-device-session-evidence.v1";
const DIGEST = /^[a-f0-9]{64}$/;
const MAX_ISSUED_CREDENTIAL_TTL_MS = 24 * 60 * 60_000;

function createCurrentUserToolCredentialChallengeBroker({
  challengeTtlMs = 30_000,
  now = () => new Date(),
  tools = [],
} = {}) {
  if (typeof now !== "function" || !Number.isSafeInteger(challengeTtlMs) || challengeTtlMs < 5_000 || challengeTtlMs > 60_000) {
    throw new TypeError("current_user_tool_credential_challenge_broker_invalid");
  }
  const toolById = new Map((Array.isArray(tools) ? tools : []).map(normalizeTool));
  const pendingById = new Map();
  const pollWaitersByActor = new Map();

  async function requestCredential(grant = {}, { signal = null } = {}) {
    requireActorDigest(grant.actorSubjectDigest);
    const tool = toolById.get(String(grant.toolId || "").trim());
    if (!tool || grant.issuerAdapterId !== tool.issuerAdapterId || grant.audience !== tool.audience) {
      throw brokerError("current_user_tool_credential_challenge_tool_invalid");
    }
    if (signal?.aborted) throw brokerError("current_user_tool_credential_lease_canceled");
    const createdAt = trustedNow(now);
    const expiresAt = new Date(Math.min(
      createdAt.getTime() + challengeTtlMs,
      Date.parse(String(grant.validUntil || "")),
    ));
    if (!Number.isFinite(expiresAt.getTime()) || expiresAt.getTime() <= createdAt.getTime()) {
      throw brokerError("current_user_tool_credential_challenge_expired");
    }
    const challengeId = `tool-credential-challenge:${crypto.randomUUID()}`;
    const outcome = deferred();
    const record = {
      challengeId,
      actorSubjectDigest: grant.actorSubjectDigest,
      expiresAt: expiresAt.toISOString(),
      grant,
      outcome,
      tool,
      timeout: null,
      abortHandler: null,
      signal,
    };
    record.timeout = setTimeout(() => settle(record, {
      error: brokerError("current_user_tool_credential_challenge_timeout"),
    }), Math.max(1, expiresAt.getTime() - createdAt.getTime()));
    record.timeout.unref?.();
    if (signal) {
      record.abortHandler = () => settle(record, { error: brokerError("current_user_tool_credential_lease_canceled") });
      signal.addEventListener("abort", record.abortHandler, { once: true });
    }
    pendingById.set(challengeId, record);
    notifyActor(grant.actorSubjectDigest);
    return await outcome.promise;
  }

  async function pollPending({ actorSubjectDigest, signal = null, waitMs = 25_000 } = {}) {
    const actorDigest = requireActorDigest(actorSubjectDigest);
    const boundedWaitMs = Number.isSafeInteger(waitMs) ? Math.max(0, Math.min(25_000, waitMs)) : 25_000;
    const immediate = pendingChallenge(actorDigest);
    if (immediate || boundedWaitMs === 0 || signal?.aborted) return immediate;
    await waitForActor(actorDigest, boundedWaitMs, signal);
    return pendingChallenge(actorDigest);
  }

  function submitResponse({ actorSubjectDigest, challengeId, response } = {}) {
    const actorDigest = requireActorDigest(actorSubjectDigest);
    const record = pendingById.get(String(challengeId || "").trim());
    if (!record) throw brokerError("current_user_tool_credential_challenge_not_found");
    if (record.actorSubjectDigest !== actorDigest) throw brokerError("current_user_tool_credential_challenge_actor_mismatch");
    const checkedAt = trustedNow(now);
    if (Date.parse(record.expiresAt) <= checkedAt.getTime()) {
      const error = brokerError("current_user_tool_credential_challenge_expired");
      settle(record, { error });
      throw error;
    }
    const normalized = normalizeResponse(response, record, checkedAt);
    const issuedAt = trustedNow(now).toISOString();
    const expiresAt = new Date(Math.min(Date.parse(normalized.expiresAt), Date.parse(record.grant.validUntil))).toISOString();
    settle(record, {
      value: Object.freeze({
        contractVersion: ISSUED_CREDENTIAL_CONTRACT_VERSION,
        issuerAdapterId: record.grant.issuerAdapterId,
        audience: record.grant.audience,
        subjectId: record.grant.subjectId,
        scopes: [...record.grant.scopes],
        accessToken: normalized.authorization.slice("Bearer ".length),
        issuedAt,
        expiresAt,
      }),
    });
    return { accepted: true, challengeId: record.challengeId };
  }

  function revokeSubject(actorSubjectDigest) {
    const actorDigest = requireActorDigest(actorSubjectDigest);
    let revoked = 0;
    for (const record of [...pendingById.values()]) {
      if (record.actorSubjectDigest !== actorDigest) continue;
      settle(record, { error: brokerError("current_user_tool_credential_challenge_revoked") });
      revoked += 1;
    }
    return revoked;
  }

  function pendingChallenge(actorDigest) {
    const record = [...pendingById.values()]
      .find((candidate) => candidate.actorSubjectDigest === actorDigest && Date.parse(candidate.expiresAt) > trustedNow(now).getTime());
    if (!record) return null;
    return Object.freeze({
      contractVersion: CHALLENGE_CONTRACT_VERSION,
      challengeId: record.challengeId,
      toolId: record.grant.toolId,
      audience: record.grant.audience,
      scopes: [...record.grant.scopes],
      expiresAt: record.expiresAt,
    });
  }

  function settle(record, { error = null, value = null } = {}) {
    if (!pendingById.delete(record.challengeId)) return false;
    clearTimeout(record.timeout);
    if (record.signal && record.abortHandler) record.signal.removeEventListener("abort", record.abortHandler);
    if (error) record.outcome.reject(error);
    else record.outcome.resolve(value);
    return true;
  }

  function notifyActor(actorDigest) {
    const waiters = pollWaitersByActor.get(actorDigest) || [];
    pollWaitersByActor.delete(actorDigest);
    waiters.forEach((resolve) => resolve());
  }

  function waitForActor(actorDigest, waitMs, signal) {
    return new Promise((resolve) => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener?.("abort", finish);
        const remaining = (pollWaitersByActor.get(actorDigest) || []).filter((waiter) => waiter !== finish);
        if (remaining.length) pollWaitersByActor.set(actorDigest, remaining);
        else pollWaitersByActor.delete(actorDigest);
        resolve();
      };
      const timer = setTimeout(finish, waitMs);
      timer.unref?.();
      const waiters = pollWaitersByActor.get(actorDigest) || [];
      waiters.push(finish);
      pollWaitersByActor.set(actorDigest, waiters);
      signal?.addEventListener?.("abort", finish, { once: true });
    });
  }

  return Object.freeze({
    contractVersion: BROKER_CONTRACT_VERSION,
    pollPending,
    requestCredential,
    revokeSubject,
    submitResponse,
  });
}

function normalizeTool(value = {}) {
  const toolId = requiredText(value.toolId, "current_user_tool_credential_challenge_tool_invalid");
  return [toolId, Object.freeze({
    toolId,
    issuerAdapterId: requiredText(value.issuerAdapterId, "current_user_tool_credential_challenge_tool_invalid"),
    audience: requiredText(value.audience, "current_user_tool_credential_challenge_tool_invalid"),
    apiOrigin: safeOrigin(value.apiOrigin),
  })];
}

function normalizeResponse(value, record, checkedAt) {
  if (!plainObject(value) || value.contractVersion !== RESPONSE_CONTRACT_VERSION || value.challengeId !== record.challengeId ||
    value.toolId !== record.grant.toolId) throw brokerError("current_user_tool_credential_challenge_response_invalid");
  const authorization = String(value.authorization || "").trim();
  if (!/^Bearer [\x21-\x7e]+$/.test(authorization) || authorization.length > 8 * 1024) {
    throw brokerError("current_user_tool_credential_challenge_response_invalid");
  }
  const expiresAt = new Date(String(value.expiresAt || ""));
  if (!Number.isFinite(expiresAt.getTime()) || expiresAt.getTime() <= checkedAt.getTime() || expiresAt.getTime() > checkedAt.getTime() + MAX_ISSUED_CREDENTIAL_TTL_MS) {
    throw brokerError("current_user_tool_credential_challenge_response_invalid");
  }
  const evidence = value.subjectEvidence;
  if (!plainObject(evidence) || evidence.contractVersion !== DATAFLOW_EVIDENCE_CONTRACT_VERSION ||
    evidence.kind !== "current_browser_session" || safeOrigin(evidence.apiOrigin) !== record.tool.apiOrigin) {
    throw brokerError("current_user_tool_credential_challenge_response_invalid");
  }
  return { authorization, expiresAt: expiresAt.toISOString() };
}

function safeOrigin(value) {
  try {
    const url = new URL(String(value || ""));
    if (url.protocol !== "https:" || url.pathname !== "/" || url.search || url.hash || url.username || url.password) throw new Error("invalid");
    return url.origin;
  } catch {
    throw brokerError("current_user_tool_credential_challenge_tool_invalid");
  }
}

function requireActorDigest(value) {
  const digest = String(value || "").trim().toLowerCase();
  if (!DIGEST.test(digest)) throw brokerError("current_user_tool_credential_challenge_actor_invalid");
  return digest;
}

function requiredText(value, code) {
  const text = String(value || "").trim();
  if (!text || text.length > 240 || /[\r\n\0]/.test(text)) throw brokerError(code);
  return text;
}

function trustedNow(now) {
  const value = now();
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) throw new TypeError("current_user_tool_credential_challenge_clock_invalid");
  return date;
}

function plainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value) &&
    [Object.prototype, null].includes(Object.getPrototypeOf(value));
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((done, fail) => { resolve = done; reject = fail; });
  return { promise, reject, resolve };
}

function brokerError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

export {
  BROKER_CONTRACT_VERSION,
  CHALLENGE_CONTRACT_VERSION,
  DATAFLOW_EVIDENCE_CONTRACT_VERSION,
  POLL_CONTRACT_VERSION,
  RESPONSE_CONTRACT_VERSION,
  createCurrentUserToolCredentialChallengeBroker,
};
