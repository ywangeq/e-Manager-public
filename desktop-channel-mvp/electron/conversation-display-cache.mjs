import crypto from "node:crypto";
import { chmod, mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";

const DISPLAY_HISTORY_CONTRACT = "conversation-display-history.v1";
const CACHE_FILE_CONTRACT = "desktop-conversation-display-cache-file.v1";
const CACHE_RECORD_CONTRACT = "desktop-conversation-display-cache-record.v1";
const HISTORY_POLICY_CONTRACT = "desktop-conversation-history-policy.v1";
const HISTORY_SOURCE = "center_projection";
const PROJECTION_FIELDS = new Set([
  "contractVersion", "historySource", "centerInstanceId", "tenantScope", "employeeId", "sessionId",
  "revision", "status", "sessionUpdatedAt", "turns", "page", "policyVersion",
]);
const TURN_FIELDS = new Set(["seq", "role", "text", "createdAt", "taskId", "goalRevision", "plannerAnswer"]);
const PAGE_FIELDS = new Set(["beforeSeq", "nextBeforeSeq", "hasMore"]);
const FILE_FIELDS = new Set(["contractVersion", "records"]);
const FILE_RECORD_FIELDS = new Set([
  "cacheKeyHash", "namespaceActorHash", "encryptedPayload", "expiresAt", "savedAt", "policyVersion",
]);
const RECORD_FIELDS = new Set(["contractVersion", "actorSubjectDigest", "projection"]);
const SESSION_STATUSES = new Set(["active", "ended", "archived"]);

function createConversationDisplayCache({
  encryption,
  now = () => Date.now(),
  persistence,
  resolveEffectivePolicy,
} = {}) {
  if (!persistence || typeof persistence.load !== "function" || typeof persistence.save !== "function") {
    throw new TypeError("conversation display cache requires persistence");
  }
  if (!encryption || typeof encryption.isAvailable !== "function" ||
    typeof encryption.encrypt !== "function" || typeof encryption.decrypt !== "function") {
    throw new TypeError("conversation display cache requires encryption");
  }
  if (typeof resolveEffectivePolicy !== "function") {
    throw new TypeError("conversation display cache requires resolveEffectivePolicy");
  }

  const records = new Map();
  let initialized = false;
  let initializePromise = null;
  let blockedReason = "";
  let degradedReason = "";
  let mutationTail = Promise.resolve();

  async function initialize() {
    if (initialized) return readiness();
    if (initializePromise) return initializePromise;
    initializePromise = initializeOnce().finally(() => { initializePromise = null; });
    return initializePromise;
  }

  async function initializeOnce() {
    if (!encryption.isAvailable()) {
      blockedReason = "encryption_unavailable";
      return readiness();
    }
    try {
      const stored = await persistence.load();
      const nowMs = validNow(now());
      let changed = false;
      for (const rawRecord of normalizeFileRecords(stored)) {
        if (rawRecord.expiresAt <= nowMs) {
          changed = true;
          continue;
        }
        try {
          const envelope = await decryptEnvelope(rawRecord.encryptedPayload);
          assertRecordIntegrity(rawRecord, envelope);
          records.set(rawRecord.cacheKeyHash, { ...rawRecord, envelope });
        } catch {
          changed = true;
          degradedReason = "encrypted_record_invalid";
        }
      }
      initialized = true;
      blockedReason = "";
      if (changed) await persistRecords();
    } catch {
      blockedReason = "cache_file_invalid";
    }
    return readiness();
  }

  async function storeProjection({ actorSubjectDigest, projection } = {}) {
    return serialize(async () => {
      const ready = await initialize();
      if (!ready.available) return cacheStatus(ready.status);
      const actorDigest = requiredDigest(actorSubjectDigest, "actorSubjectDigest");
      const policy = await effectivePolicy({ actorSubjectDigest: actorDigest, projection });
      if (!policy.ok) return cacheStatus(policy.reason);
      const incoming = normalizeProjection(projection, policy.policy.offlineCache);
      assertProjectionNamespace(incoming, policy.policy);

      const hashes = identityHashes(actorDigest, incoming);
      const existing = records.get(hashes.cacheKeyHash);
      let aggregate = incoming;
      if (existing) {
        if (existing.namespaceActorHash !== hashes.namespaceActorHash) throw cacheError("cache_identity_collision");
        aggregate = mergeProjections(existing.envelope.projection, incoming, policy.policy.offlineCache);
      }
      const savedAt = validNow(now());
      const envelope = { contractVersion: CACHE_RECORD_CONTRACT, actorSubjectDigest: actorDigest, projection: aggregate };
      const encryptedPayload = await encryptEnvelope(envelope);
      if (!existing) ensureCapacityForNew(hashes.namespaceActorHash, policy.policy.offlineCache.maxSessions);
      records.set(hashes.cacheKeyHash, {
        cacheKeyHash: hashes.cacheKeyHash,
        namespaceActorHash: hashes.namespaceActorHash,
        encryptedPayload,
        expiresAt: savedAt + policy.policy.offlineCache.maxTtlSeconds * 1000,
        savedAt,
        policyVersion: policy.policy.policyVersion,
        envelope,
      });
      await persistRecords();
      return cacheStatus("stored", aggregate);
    }).catch((error) => safeFailure(error));
  }

  async function loadProjection({ actorSubjectDigest, employeeId, sessionId } = {}) {
    return serialize(async () => {
      const ready = await initialize();
      if (!ready.available) return cacheStatus(ready.status);
      const actorDigest = requiredDigest(actorSubjectDigest, "actorSubjectDigest");
      const safeEmployeeId = requiredIdentifier(employeeId, "employeeId");
      const safeSessionId = requiredIdentifier(sessionId, "sessionId");
      const policy = await effectivePolicy({ actorSubjectDigest: actorDigest, employeeId: safeEmployeeId, sessionId: safeSessionId });
      if (!policy.ok) return cacheStatus(policy.reason);
      const identity = {
        centerInstanceId: policy.policy.centerInstanceId,
        tenantScope: policy.policy.tenantScope,
        employeeId: safeEmployeeId,
        sessionId: safeSessionId,
      };
      const hashes = identityHashes(actorDigest, identity);
      const record = records.get(hashes.cacheKeyHash);
      if (!record) return cacheStatus("missing");
      const nowMs = validNow(now());
      if (record.expiresAt <= nowMs || record.policyVersion !== policy.policy.policyVersion) {
        records.delete(hashes.cacheKeyHash);
        await persistRecords();
        return cacheStatus(record.expiresAt <= nowMs ? "expired" : "policy_changed");
      }
      assertRecordIntegrity(record, record.envelope);
      assertProjectionNamespace(record.envelope.projection, policy.policy);
      const bounded = boundProjection(record.envelope.projection, policy.policy.offlineCache);
      if (!sameProjection(bounded, record.envelope.projection)) {
        record.envelope = { ...record.envelope, projection: bounded };
        record.encryptedPayload = await encryptEnvelope(record.envelope);
        await persistRecords();
      }
      return cacheStatus("ready", bounded, record.expiresAt);
    }).catch((error) => safeFailure(error));
  }

  async function clearSession({ actorSubjectDigest, centerInstanceId, employeeId, sessionId, tenantScope } = {}) {
    return serialize(async () => {
      const ready = await initialize();
      if (!ready.available) return cacheStatus(ready.status);
      const actorDigest = requiredDigest(actorSubjectDigest, "actorSubjectDigest");
      const identity = {
        centerInstanceId: requiredIdentifier(centerInstanceId, "centerInstanceId"),
        tenantScope: requiredIdentifier(tenantScope, "tenantScope"),
        employeeId: requiredIdentifier(employeeId, "employeeId"),
        sessionId: requiredIdentifier(sessionId, "sessionId"),
      };
      records.delete(identityHashes(actorDigest, identity).cacheKeyHash);
      await persistRecords();
      return cacheStatus("cleared");
    }).catch((error) => safeFailure(error));
  }

  async function clearActor({ actorSubjectDigest, centerInstanceId, tenantScope } = {}) {
    return serialize(async () => {
      const ready = await initialize();
      if (!ready.available) return cacheStatus(ready.status);
      const namespaceActorHash = hashValue([
        requiredIdentifier(centerInstanceId, "centerInstanceId"),
        requiredIdentifier(tenantScope, "tenantScope"),
        requiredDigest(actorSubjectDigest, "actorSubjectDigest"),
      ]);
      for (const [key, record] of records) {
        if (record.namespaceActorHash === namespaceActorHash) records.delete(key);
      }
      await persistRecords();
      return cacheStatus("cleared");
    }).catch((error) => safeFailure(error));
  }

  async function clearActorEverywhere({ actorSubjectDigest } = {}) {
    return serialize(async () => {
      const actorDigest = requiredDigest(actorSubjectDigest, "actorSubjectDigest");
      const ready = await initialize();
      if (!ready.available) {
        // Without decryption there is no safe way to select one actor, so logout clears the cache file.
        records.clear();
        await persistence.save([]);
        initialized = false;
        blockedReason = "";
        degradedReason = "";
        return cacheStatus("cleared");
      }
      for (const [key, record] of records) {
        if (record.envelope.actorSubjectDigest === actorDigest) records.delete(key);
      }
      await persistRecords();
      return cacheStatus("cleared");
    }).catch((error) => safeFailure(error));
  }

  async function clearAll() {
    return serialize(async () => {
      records.clear();
      await persistence.save([]);
      initialized = false;
      blockedReason = "";
      degradedReason = "";
      return cacheStatus("cleared");
    }).catch((error) => safeFailure(error));
  }

  async function health() {
    await initialize();
    return readiness();
  }

  async function effectivePolicy(context) {
    let result;
    try {
      result = await resolveEffectivePolicy(context);
    } catch {
      return { ok: false, reason: "policy_unavailable" };
    }
    const policy = result?.policy;
    if (result?.ok !== true || result?.enabled !== true || result?.status !== "enabled" ||
      !isPlainObject(policy) || policy.contractVersion !== HISTORY_POLICY_CONTRACT ||
      policy.historySource !== HISTORY_SOURCE || policy.offlineCache?.mode !== "encrypted_read_only" ||
      policy.offlineCache?.clearOnLogout !== true || !policy.projection?.revision || !policy.projection?.messageGet) {
      return { ok: false, reason: "disabled_by_policy" };
    }
    for (const field of ["maxTtlSeconds", "maxSessions", "maxTurns", "maxChars"]) {
      if (!Number.isSafeInteger(policy.offlineCache[field]) || policy.offlineCache[field] <= 0) {
        return { ok: false, reason: "policy_invalid" };
      }
    }
    requiredIdentifier(policy.centerInstanceId, "centerInstanceId");
    requiredIdentifier(policy.tenantScope, "tenantScope");
    requiredIdentifier(policy.policyVersion, "policyVersion");
    return { ok: true, policy };
  }

  function ensureCapacityForNew(namespaceActorHash, maxSessions) {
    const actorRecords = [...records.values()]
      .filter((record) => record.namespaceActorHash === namespaceActorHash)
      .sort((left, right) => left.savedAt - right.savedAt || left.cacheKeyHash.localeCompare(right.cacheKeyHash));
    const removalCount = Math.max(0, actorRecords.length - maxSessions + 1);
    for (const record of actorRecords.slice(0, removalCount)) records.delete(record.cacheKeyHash);
  }

  async function persistRecords() {
    await persistence.save([...records.values()].map(publicFileRecord));
  }

  async function encryptEnvelope(envelope) {
    if (!encryption.isAvailable()) throw cacheError("encryption_unavailable");
    const encrypted = await encryption.encrypt(JSON.stringify(envelope));
    if (typeof encrypted !== "string" || !encrypted) throw cacheError("encryption_failed");
    return encrypted;
  }

  async function decryptEnvelope(encryptedPayload) {
    if (!encryption.isAvailable()) throw cacheError("encryption_unavailable");
    const decrypted = await encryption.decrypt(encryptedPayload);
    if (typeof decrypted !== "string" || !decrypted) throw cacheError("decryption_failed");
    const parsed = JSON.parse(decrypted);
    if (!isPlainObject(parsed) || hasUnknownFields(parsed, RECORD_FIELDS) ||
      parsed.contractVersion !== CACHE_RECORD_CONTRACT) throw cacheError("cache_record_invalid");
    return {
      contractVersion: CACHE_RECORD_CONTRACT,
      actorSubjectDigest: requiredDigest(parsed.actorSubjectDigest, "actorSubjectDigest"),
      projection: normalizeProjection(parsed.projection),
    };
  }

  function readiness() {
    const status = blockedReason || (degradedReason ? "degraded" : "ready");
    return {
      ok: !blockedReason,
      available: initialized && !blockedReason,
      status,
      degradedReason,
      recordCount: records.size,
    };
  }

  function serialize(run) {
    const next = mutationTail.catch(() => {}).then(run);
    mutationTail = next;
    return next;
  }

  return {
    clearActor,
    clearActorEverywhere,
    clearAll,
    clearSession,
    health,
    initialize,
    loadProjection,
    storeProjection,
  };
}

function createEncryptedConversationDisplayCacheFilePersistence({ filePath } = {}) {
  const value = String(filePath || "").trim();
  if (!value) throw new TypeError("conversation display cache persistence requires filePath");
  const targetPath = path.resolve(value);
  return {
    async load() {
      try {
        const payload = JSON.parse(await readFile(targetPath, "utf8"));
        if (!isPlainObject(payload) || hasUnknownFields(payload, FILE_FIELDS) ||
          payload.contractVersion !== CACHE_FILE_CONTRACT || !Array.isArray(payload.records)) {
          throw cacheError("cache_file_invalid");
        }
        return payload.records;
      } catch (error) {
        if (error?.code === "ENOENT") return [];
        throw error;
      }
    },
    async save(records = []) {
      if (!Array.isArray(records)) throw new TypeError("conversation display cache records must be an array");
      await mkdir(path.dirname(targetPath), { recursive: true, mode: 0o700 });
      const temporaryPath = `${targetPath}.tmp`;
      const payload = JSON.stringify({ contractVersion: CACHE_FILE_CONTRACT, records }, null, 2);
      await writeFile(temporaryPath, payload, { encoding: "utf8", mode: 0o600 });
      await chmod(temporaryPath, 0o600);
      await rename(temporaryPath, targetPath);
      if (!records.length) await unlink(targetPath).catch((error) => {
        if (error?.code !== "ENOENT") throw error;
      });
    },
  };
}

function normalizeProjection(value, limits = null) {
  if (!isPlainObject(value) || hasUnknownFields(value, PROJECTION_FIELDS) ||
    value.contractVersion !== DISPLAY_HISTORY_CONTRACT || value.historySource !== HISTORY_SOURCE) {
    throw cacheError("projection_contract_invalid");
  }
  const projection = {
    contractVersion: DISPLAY_HISTORY_CONTRACT,
    historySource: HISTORY_SOURCE,
    centerInstanceId: requiredIdentifier(value.centerInstanceId, "centerInstanceId"),
    tenantScope: requiredIdentifier(value.tenantScope, "tenantScope"),
    employeeId: requiredIdentifier(value.employeeId, "employeeId"),
    sessionId: requiredIdentifier(value.sessionId, "sessionId"),
    revision: positiveSafeInteger(value.revision, "revision"),
    status: SESSION_STATUSES.has(value.status) ? value.status : invalid("status"),
    sessionUpdatedAt: requiredTimestamp(value.sessionUpdatedAt, "sessionUpdatedAt"),
    turns: normalizeTurns(value.turns, value.employeeId),
    page: normalizePage(value.page),
    policyVersion: requiredIdentifier(value.policyVersion, "policyVersion"),
  };
  assertPageConsistency(projection);
  if (limits) assertWithinLimits(projection, limits);
  return projection;
}

function normalizeTurns(value, employeeId) {
  if (!Array.isArray(value)) throw cacheError("projection_turns_invalid");
  let previousSeq = 0;
  const turns = value.map((turn) => {
    if (!isPlainObject(turn) || hasUnknownFields(turn, TURN_FIELDS)) throw cacheError("projection_turn_invalid");
    const normalized = {
      seq: positiveSafeInteger(turn.seq, "turn_seq"),
      role: ["user", "assistant"].includes(turn.role) ? turn.role : invalid("turn_role"),
      text: requiredText(turn.text, "turn_text"),
      createdAt: requiredTimestamp(turn.createdAt, "turn_createdAt"),
      ...(turn.taskId ? { taskId: runtimeTaskId(turn.taskId, turn.role) } : {}),
      ...(turn.goalRevision === undefined ? {} : { goalRevision: positiveSafeInteger(turn.goalRevision, "goalRevision") }),
      ...(turn.plannerAnswer === undefined ? {} : { plannerAnswer: groupPlannerAnswer(turn.plannerAnswer, turn.role, employeeId) }),
    };
    if (normalized.seq <= previousSeq) throw cacheError("projection_sequence_invalid");
    previousSeq = normalized.seq;
    return normalized;
  });
  return turns;
}

function groupPlannerAnswer(value, role, employeeId) {
  if (role !== "user" || employeeId !== "group-orchestrator" || typeof value !== "string" ||
    !value.trim() || value.length > 3600 || /[\u0000-\u0008\u000b-\u001f\u007f]/.test(value)) {
    throw cacheError("projection_turn_invalid");
  }
  return value;
}

function runtimeTaskId(value, role) {
  const taskId = String(value || "");
  if (role !== "assistant" || !/^[A-Za-z0-9][A-Za-z0-9._:@-]{0,127}$/.test(taskId)) {
    throw cacheError("projection_task_id_invalid");
  }
  return taskId;
}

function normalizePage(value) {
  if (!isPlainObject(value) || hasUnknownFields(value, PAGE_FIELDS) || typeof value.hasMore !== "boolean") {
    throw cacheError("projection_page_invalid");
  }
  return {
    beforeSeq: value.beforeSeq === null ? null : positiveSafeInteger(value.beforeSeq, "beforeSeq"),
    nextBeforeSeq: nonNegativeSafeInteger(value.nextBeforeSeq, "nextBeforeSeq"),
    hasMore: value.hasMore,
  };
}

function assertPageConsistency(projection) {
  const { beforeSeq, nextBeforeSeq } = projection.page;
  if (beforeSeq !== null && projection.turns.some((turn) => turn.seq >= beforeSeq)) {
    throw cacheError("projection_cursor_mismatch");
  }
  const expectedNext = projection.turns.length ? projection.turns[0].seq : 0;
  if (nextBeforeSeq !== expectedNext) throw cacheError("projection_cursor_mismatch");
}

function assertWithinLimits(projection, limits) {
  if (projection.turns.length > limits.maxTurns || characterCount(projection.turns) > limits.maxChars) {
    throw cacheError("projection_policy_limit_exceeded");
  }
}

function mergeProjections(existing, incoming, limits) {
  assertSameProjectionIdentity(existing, incoming);
  if (incoming.policyVersion !== existing.policyVersion) throw cacheError("projection_policy_changed");
  if (incoming.revision < existing.revision) throw cacheError("projection_revision_stale");
  if (incoming.revision === existing.revision &&
    (incoming.status !== existing.status || incoming.sessionUpdatedAt !== existing.sessionUpdatedAt)) {
    throw cacheError("projection_revision_conflict");
  }
  const turnsBySeq = new Map(existing.turns.map((turn) => [turn.seq, turn]));
  for (const turn of incoming.turns) {
    const previous = turnsBySeq.get(turn.seq);
    if (previous && JSON.stringify(previous) !== JSON.stringify(turn)) {
      const { goalRevision: oldRevision, plannerAnswer: oldAnswer, ...oldBase } = previous;
      const { goalRevision: newRevision, plannerAnswer: newAnswer, ...newBase } = turn;
      if (existing.employeeId !== "group-orchestrator" || JSON.stringify(oldBase) !== JSON.stringify(newBase) ||
        (oldRevision !== undefined && oldRevision !== newRevision) ||
        (oldAnswer !== undefined && oldAnswer !== newAnswer) ||
        (newAnswer !== undefined && newRevision === undefined)) throw cacheError("projection_turn_conflict");
    }
    turnsBySeq.set(turn.seq, turn);
  }
  const combined = [...turnsBySeq.values()].sort((left, right) => left.seq - right.seq);
  const boundedTurns = newestBoundedTurns(combined, limits);
  const wasTrimmed = boundedTurns.length < combined.length;
  const oldestSource = oldestPageSource(existing, incoming);
  return {
    ...incoming,
    turns: boundedTurns,
    page: {
      beforeSeq: null,
      nextBeforeSeq: boundedTurns.length ? boundedTurns[0].seq : 0,
      hasMore: wasTrimmed || oldestSource.page.hasMore,
    },
  };
}

function boundProjection(projection, limits) {
  const turns = newestBoundedTurns(projection.turns, limits);
  if (turns.length === projection.turns.length) return projection;
  return {
    ...projection,
    turns,
    page: { beforeSeq: null, nextBeforeSeq: turns.length ? turns[0].seq : 0, hasMore: true },
  };
}

function newestBoundedTurns(turns, limits) {
  const selected = [];
  let chars = 0;
  for (let index = turns.length - 1; index >= 0; index -= 1) {
    const turn = turns[index];
    if (selected.length >= limits.maxTurns || chars + turn.text.length + (turn.plannerAnswer?.length || 0) > limits.maxChars) break;
    selected.push(turn);
    chars += turn.text.length + (turn.plannerAnswer?.length || 0);
  }
  return selected.reverse();
}

function oldestPageSource(left, right) {
  const leftSeq = left.turns[0]?.seq ?? Number.MAX_SAFE_INTEGER;
  const rightSeq = right.turns[0]?.seq ?? Number.MAX_SAFE_INTEGER;
  return rightSeq < leftSeq ? right : left;
}

function assertSameProjectionIdentity(left, right) {
  for (const field of ["centerInstanceId", "tenantScope", "employeeId", "sessionId"]) {
    if (left[field] !== right[field]) throw cacheError("projection_identity_mismatch");
  }
}

function assertProjectionNamespace(projection, policy) {
  if (projection.centerInstanceId !== policy.centerInstanceId || projection.tenantScope !== policy.tenantScope ||
    projection.policyVersion !== policy.policyVersion) throw cacheError("projection_namespace_mismatch");
}

function assertRecordIntegrity(record, envelope) {
  const hashes = identityHashes(envelope.actorSubjectDigest, envelope.projection);
  if (record.cacheKeyHash !== hashes.cacheKeyHash || record.namespaceActorHash !== hashes.namespaceActorHash ||
    record.policyVersion !== envelope.projection.policyVersion) throw cacheError("cache_record_integrity_invalid");
}

function normalizeFileRecords(value) {
  if (!Array.isArray(value)) throw cacheError("cache_file_invalid");
  const seen = new Set();
  return value.map((record) => {
    if (!isPlainObject(record) || hasUnknownFields(record, FILE_RECORD_FIELDS)) throw cacheError("cache_file_invalid");
    const normalized = {
      cacheKeyHash: requiredDigest(record.cacheKeyHash, "cacheKeyHash"),
      namespaceActorHash: requiredDigest(record.namespaceActorHash, "namespaceActorHash"),
      encryptedPayload: requiredText(record.encryptedPayload, "encryptedPayload"),
      expiresAt: nonNegativeSafeInteger(record.expiresAt, "expiresAt"),
      savedAt: nonNegativeSafeInteger(record.savedAt, "savedAt"),
      policyVersion: requiredIdentifier(record.policyVersion, "policyVersion"),
    };
    if (seen.has(normalized.cacheKeyHash)) throw cacheError("cache_file_invalid");
    seen.add(normalized.cacheKeyHash);
    return normalized;
  });
}

function identityHashes(actorSubjectDigest, projection) {
  const namespaceActorHash = hashValue([
    projection.centerInstanceId,
    projection.tenantScope,
    actorSubjectDigest,
  ]);
  return {
    namespaceActorHash,
    cacheKeyHash: hashValue([
      projection.centerInstanceId,
      projection.tenantScope,
      actorSubjectDigest,
      projection.employeeId,
      projection.sessionId,
    ]),
  };
}

function publicFileRecord(record) {
  return {
    cacheKeyHash: record.cacheKeyHash,
    namespaceActorHash: record.namespaceActorHash,
    encryptedPayload: record.encryptedPayload,
    expiresAt: record.expiresAt,
    savedAt: record.savedAt,
    policyVersion: record.policyVersion,
  };
}

function cacheStatus(status, projection = null, expiresAt = 0) {
  return {
    ok: ["stored", "ready", "cleared"].includes(status),
    status,
    source: status === "ready" ? "encrypted_local_cache" : "",
    projection: projection ? structuredClone(projection) : null,
    expiresAt: expiresAt ? new Date(expiresAt).toISOString() : "",
  };
}

function safeFailure(error) {
  const code = String(error?.code || error?.message || "cache_unavailable");
  const safeCodes = new Set([
    "encryption_unavailable", "encryption_failed", "decryption_failed", "cache_file_invalid",
    "cache_record_invalid", "cache_record_integrity_invalid", "cache_identity_collision",
    "projection_contract_invalid", "projection_turns_invalid", "projection_turn_invalid",
    "projection_sequence_invalid", "projection_page_invalid", "projection_cursor_mismatch",
    "projection_policy_limit_exceeded", "projection_policy_changed", "projection_revision_stale",
    "projection_revision_conflict", "projection_turn_conflict", "projection_identity_mismatch",
    "projection_namespace_mismatch",
  ]);
  return cacheStatus(safeCodes.has(code) ? code : "cache_input_invalid");
}

function requiredDigest(value, field) {
  const digest = String(value || "");
  if (!/^[a-f0-9]{64}$/.test(digest)) throw cacheError(`${field}_invalid`);
  return digest;
}

function requiredIdentifier(value, field) {
  const text = String(value ?? "").trim();
  if (!text || text.length > 512 || /[\u0000-\u001f\u007f]/.test(text)) throw cacheError(`${field}_invalid`);
  return text;
}

function requiredText(value, field) {
  const text = String(value ?? "");
  if (!text) throw cacheError(`${field}_invalid`);
  return text;
}

function requiredTimestamp(value, field) {
  const text = String(value || "");
  if (!Number.isFinite(Date.parse(text))) throw cacheError(`${field}_invalid`);
  return text;
}

function positiveSafeInteger(value, field) {
  if (!Number.isSafeInteger(value) || value <= 0) throw cacheError(`${field}_invalid`);
  return value;
}

function nonNegativeSafeInteger(value, field) {
  if (!Number.isSafeInteger(value) || value < 0) throw cacheError(`${field}_invalid`);
  return value;
}

function invalid(field) {
  throw cacheError(`${field}_invalid`);
}

function validNow(value) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 0) throw cacheError("clock_invalid");
  return number;
}

function characterCount(turns) {
  return turns.reduce((sum, turn) => sum + turn.text.length + (turn.plannerAnswer?.length || 0), 0);
}

function hashValue(value) {
  return crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function sameProjection(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function hasUnknownFields(value, allowed) {
  return Object.keys(value).some((key) => !allowed.has(key));
}

function isPlainObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function cacheError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

export {
  CACHE_FILE_CONTRACT,
  CACHE_RECORD_CONTRACT,
  createConversationDisplayCache,
  createEncryptedConversationDisplayCacheFilePersistence,
};
