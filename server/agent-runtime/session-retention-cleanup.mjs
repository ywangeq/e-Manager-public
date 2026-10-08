import crypto from "node:crypto";

const RETENTION_POLICY_CONTRACT = "session-retention-policy.v1";
const RETENTION_CANDIDATE_SET_CONTRACT = "session-retention-candidate-set.v1";
const RETENTION_CANDIDATE_CONTRACT = "session-retention-candidate.v1";
const RETENTION_CLEANUP_CONTRACT = "session-retention-cleanup.v1";

const CANDIDATE_SET_FIELDS = new Set(["contractVersion", "policyVersion", "candidates"]);
const CANDIDATE_FIELDS = new Set([
  "contractVersion", "decisionId", "sessionId", "policyVersion", "expiredAt", "mode", "reason",
]);
const SCOPE_DEFINITIONS = Object.freeze([
  {
    adapterKey: "sessionFoundation",
    evidenceContract: "session-foundation-deletion-evidence.v1",
    scope: "session_foundation_store",
    confirmedField: "foundationStoreDeletionConfirmed",
  },
  {
    adapterKey: "compactionCheckpoint",
    evidenceContract: "compaction-checkpoint-deletion-evidence.v1",
    scope: "compaction_checkpoint_store",
    confirmedField: "confirmedAbsent",
  },
  {
    adapterKey: "providerContinuation",
    evidenceContract: "provider-continuation-deletion-evidence.v1",
    scope: "provider_continuation_store",
    confirmedField: "confirmedAbsent",
  },
  {
    adapterKey: "taskEvents",
    evidenceContract: "runtime-task-events-deletion-evidence.v1",
    scope: "runtime_task_event_store",
    confirmedField: "confirmedAbsent",
  },
  {
    adapterKey: "workspace",
    evidenceContract: "session-workspace-deletion-evidence.v1",
    scope: "session_workspace_store",
    confirmedField: "confirmedAbsent",
  },
].map(Object.freeze));

function createSessionRetentionCleanup({
  adapters = {},
  now = () => Date.now(),
  retentionPolicy,
} = {}) {
  if (retentionPolicy?.contractVersion !== RETENTION_POLICY_CONTRACT ||
    typeof retentionPolicy.listExpiredSessionCandidates !== "function") {
    throw new TypeError(`session retention cleanup requires a ${RETENTION_POLICY_CONTRACT} policy`);
  }
  if (!isPlainObject(adapters)) throw new TypeError("session retention cleanup adapters must be a plain object");

  async function run({ at = now() } = {}) {
    const startedAt = timestamp(at, "cleanup at");
    let candidateSet;
    try {
      candidateSet = normalizeCandidateSet(
        await retentionPolicy.listExpiredSessionCandidates({ at: startedAt }),
        startedAt,
      );
    } catch {
      return cleanupResult({
        complete: false,
        completedAt: timestamp(now(), "completion time"),
        policyVersion: "",
        sessions: [],
        startedAt,
        status: "policy_invalid",
      });
    }

    const sessions = [];
    for (const candidate of candidateSet.candidates) {
      sessions.push(await cleanCandidate(candidate, startedAt));
    }
    const complete = sessions.every((session) => session.complete);
    return cleanupResult({
      complete,
      completedAt: timestamp(now(), "completion time"),
      policyVersion: candidateSet.policyVersion,
      sessions,
      startedAt,
      status: sessions.length ? (complete ? "complete" : "incomplete") : "no_candidates",
    });
  }

  async function cleanCandidate(candidate, at) {
    const idempotencyKey = retentionIdempotencyKey(candidate);
    const scopes = [];
    for (const definition of SCOPE_DEFINITIONS) {
      scopes.push(await cleanScope({ at, candidate, definition, idempotencyKey }));
    }
    const complete = scopes.every((scope) => scope.status === "confirmed_absent");
    return {
      contractVersion: "session-retention-cleanup-session.v1",
      sessionId: candidate.sessionId,
      decisionId: candidate.decisionId,
      policyVersion: candidate.policyVersion,
      expiredAt: candidate.expiredAt,
      idempotencyKey,
      status: complete ? "complete" : "incomplete",
      complete,
      scopes,
    };
  }

  async function cleanScope({ at, candidate, definition, idempotencyKey }) {
    const adapter = adapters[definition.adapterKey];
    if (typeof adapter?.deleteForSession !== "function") {
      return scopeResult(definition.scope, "adapter_missing", false, null);
    }
    try {
      const rawEvidence = await adapter.deleteForSession({
        at,
        decisionId: candidate.decisionId,
        idempotencyKey,
        mode: candidate.mode,
        policyVersion: candidate.policyVersion,
        reason: candidate.reason,
        sessionId: candidate.sessionId,
      });
      const validation = validateScopeEvidence(rawEvidence, definition, candidate.sessionId);
      if (!validation.valid) return scopeResult(definition.scope, "evidence_invalid", true, null);
      return scopeResult(
        definition.scope,
        validation.confirmed ? "confirmed_absent" : "absence_unconfirmed",
        true,
        validation.evidence,
      );
    } catch {
      return scopeResult(definition.scope, "adapter_failed", true, null);
    }
  }

  return { run };
}

function createSessionFoundationRetentionAdapter({ repository, now = () => Date.now() } = {}) {
  if (typeof repository?.deleteSession !== "function" || typeof repository.readSession !== "function" ||
    typeof repository.readTranscript !== "function") {
    throw new TypeError("session foundation retention adapter requires a session foundation repository");
  }
  return {
    async deleteForSession({ at, mode, reason, sessionId } = {}) {
      try {
        const deletion = await repository.deleteSession({ at, mode, reason, sessionId });
        return deletion?.deletionEvidence || deletion;
      } catch (error) {
        if (error?.code !== "session_not_found") throw error;
        const [session, transcript] = await Promise.all([
          repository.readSession(sessionId),
          repository.readTranscript(sessionId),
        ]);
        const confirmedAbsent = session === null && transcript === null;
        return {
          contractVersion: "session-foundation-deletion-evidence.v1",
          scope: "session_foundation_store",
          sessionId,
          verifiedAt: timestamp(now(), "foundation verification time"),
          foundationStoreDeletionConfirmed: confirmedAbsent,
          routeHead: { deleted: false, confirmedAbsent },
          sessionRow: { deleted: false, confirmedAbsent: session === null },
          transcriptEntries: { deletedCount: 0, confirmedAbsent: transcript === null },
          excludedScopes: ["external_indexes", "provider_state", "memory_systems"],
          verificationMode: "idempotent_repository_absence_read",
        };
      }
    },
  };
}

function createCompactionCheckpointRetentionAdapter({ repository } = {}) {
  if (typeof repository?.deleteForSession !== "function") {
    throw new TypeError("compaction checkpoint retention adapter requires a checkpoint repository");
  }
  return {
    deleteForSession: ({ sessionId } = {}) => repository.deleteForSession(sessionId),
  };
}

function normalizeCandidateSet(value, at) {
  if (!isPlainObject(value) || hasUnknownFields(value, CANDIDATE_SET_FIELDS) ||
    value.contractVersion !== RETENTION_CANDIDATE_SET_CONTRACT ||
    !Array.isArray(value.candidates)) throw retentionError("retention_candidate_set_invalid");
  const policyVersion = requiredIdentifier(value.policyVersion, "policyVersion");
  const candidates = value.candidates.map((candidate) => normalizeCandidate(candidate, policyVersion, at));
  const sessionIds = new Set();
  for (const candidate of candidates) {
    if (sessionIds.has(candidate.sessionId)) throw retentionError("retention_candidate_duplicate");
    sessionIds.add(candidate.sessionId);
  }
  return { contractVersion: RETENTION_CANDIDATE_SET_CONTRACT, policyVersion, candidates };
}

function normalizeCandidate(value, policyVersion, at) {
  if (!isPlainObject(value) || hasUnknownFields(value, CANDIDATE_FIELDS) ||
    value.contractVersion !== RETENTION_CANDIDATE_CONTRACT ||
    value.policyVersion !== policyVersion) throw retentionError("retention_candidate_invalid");
  const expiredAt = timestamp(value.expiredAt, "candidate expiredAt");
  if (Date.parse(expiredAt) > Date.parse(at)) throw retentionError("retention_candidate_not_expired");
  return {
    contractVersion: RETENTION_CANDIDATE_CONTRACT,
    decisionId: requiredIdentifier(value.decisionId, "decisionId"),
    sessionId: requiredIdentifier(value.sessionId, "sessionId"),
    policyVersion,
    expiredAt,
    mode: requiredIdentifier(value.mode, "mode"),
    reason: requiredText(value.reason, "reason"),
  };
}

function validateScopeEvidence(value, definition, sessionId) {
  const source = definition.scope === "session_foundation_store" && isPlainObject(value?.deletionEvidence)
    ? value.deletionEvidence
    : value;
  if (!isPlainObject(source) || source.contractVersion !== definition.evidenceContract ||
    source.scope !== definition.scope || source.sessionId !== sessionId ||
    !Number.isFinite(Date.parse(String(source.verifiedAt || ""))) ||
    typeof source[definition.confirmedField] !== "boolean") {
    return { valid: false, confirmed: false, evidence: null };
  }
  return {
    valid: true,
    confirmed: source[definition.confirmedField] === true,
    evidence: structuredClone(source),
  };
}

function cleanupResult({ complete, completedAt, policyVersion, sessions, startedAt, status }) {
  return {
    contractVersion: RETENTION_CLEANUP_CONTRACT,
    startedAt,
    completedAt,
    policyVersion,
    status,
    complete,
    sessions,
  };
}

function scopeResult(scope, status, attempted, evidence) {
  return { scope, status, attempted, evidence: evidence ? structuredClone(evidence) : null };
}

function retentionIdempotencyKey(candidate) {
  return crypto.createHash("sha256").update(JSON.stringify([
    RETENTION_CLEANUP_CONTRACT,
    candidate.policyVersion,
    candidate.decisionId,
    candidate.sessionId,
    candidate.expiredAt,
    candidate.mode,
    candidate.reason,
  ])).digest("hex");
}

function timestamp(value, label) {
  const time = value instanceof Date
    ? value.getTime()
    : typeof value === "number"
      ? value
      : Date.parse(String(value || ""));
  if (!Number.isFinite(time)) throw retentionError(`${label}_invalid`);
  return new Date(time).toISOString();
}

function requiredIdentifier(value, label) {
  const text = String(value ?? "").trim();
  if (!text || text.length > 512 || /[\u0000-\u001f\u007f]/.test(text)) throw retentionError(`${label}_invalid`);
  return text;
}

function requiredText(value, label) {
  const text = String(value ?? "").trim();
  if (!text || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(text)) throw retentionError(`${label}_invalid`);
  return text;
}

function isPlainObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function hasUnknownFields(value, allowed) {
  return Object.keys(value).some((key) => !allowed.has(key));
}

function retentionError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

export {
  RETENTION_CANDIDATE_CONTRACT,
  RETENTION_CANDIDATE_SET_CONTRACT,
  RETENTION_CLEANUP_CONTRACT,
  RETENTION_POLICY_CONTRACT,
  SCOPE_DEFINITIONS,
  createCompactionCheckpointRetentionAdapter,
  createSessionFoundationRetentionAdapter,
  createSessionRetentionCleanup,
};
