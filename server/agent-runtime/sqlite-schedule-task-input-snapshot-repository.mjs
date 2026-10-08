import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { isDeepStrictEqual } from "node:util";

const BINDING_VERSION_V1 = "schedule-task-input-snapshot-binding.v1";
const BINDING_VERSION_V2 = "schedule-task-input-snapshot-binding.v2";
const SNAPSHOT_VERSION = "schedule-task-input-snapshot.v1";
const EVIDENCE_VERSION_V1 = "schedule-task-input-snapshot-evidence.v1";
const EVIDENCE_VERSION_V2 = "schedule-task-input-snapshot-evidence.v2";
const INTERNAL_VERSION = "schedule-task-input-snapshot-internal.v1";
const MAX_JSON_DEPTH = 16;
const MAX_JSON_NODES = 8192;
const MAX_SNAPSHOT_BYTES = 1024 * 1024;
const TOKEN = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,239}$/;
const OPAQUE_REF = /^[A-Za-z0-9][A-Za-z0-9._:@-]{0,239}$/;
const DIGEST = /^[a-f0-9]{64}$/;
const SECRET = /^(?:bearer\s+|sk-|rk-|xox[baprs]-|gh[pousr]_|glpat-|ya29\.|eyJ)/i;
const BINDING_FIELDS = new Set([
  "activationSnapshotDigest", "activationSnapshotId", "activationVersion", "canonicalTaskId",
  "contractVersion", "employeeId", "executionContractDigest", "inputContractDigest", "maxItems",
  "maxPayloadBytes", "runId", "scheduleId", "scheduledFor", "snapshotContractVersion",
  "sourceAdapterId", "sourceBindingDigest", "taskDefinitionId", "taskDefinitionVersion",
  "tenantScope", "triggerId",
]);
const BINDING_V2_FIELDS = new Set([
  ...BINDING_FIELDS,
  "retentionDefinitionDigest",
  "snapshotRetentionSeconds",
]);
const SNAPSHOT_FIELDS = new Set(["contractVersion", "items", "snapshotContractVersion"]);
const RECORD_FIELDS = new Set([
  "authorizationEvidenceDigest", "binding", "snapshot", "sourceSnapshotRef",
]);
const READ_FIELDS = new Set([
  "authorizationEvidenceDigest", "expectedBinding", "runId", "tenantScope",
]);
const BINDING_READ_FIELDS = new Set(["expectedBinding", "runId", "tenantScope"]);
const PURGE_CANDIDATE_FIELDS = new Set(["runId", "tenantScope"]);
const LIST_PURGE_CANDIDATES_FIELDS = new Set(["limit", "tenantScope"]);
const PURGE_FIELDS = new Set([
  "authorizationEvidenceDigest", "convergenceEvidenceDigest", "expectedBinding",
  "expectedEvidenceDigest", "runId", "tenantScope",
]);

const SCHEMA_TABLE_V1_SQL = `CREATE TABLE schedule_task_input_snapshot_schema (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  version INTEGER NOT NULL CHECK (version = 1)
)`;
const SNAPSHOT_TABLE_V1_SQL = `CREATE TABLE schedule_task_input_snapshots (
  tenant_scope TEXT NOT NULL,
  snapshot_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  canonical_task_id TEXT NOT NULL,
  binding_json TEXT NOT NULL,
  authorization_evidence_digest TEXT NOT NULL,
  source_snapshot_ref_hmac TEXT NOT NULL,
  content_hmac_digest TEXT NOT NULL,
  evidence_digest TEXT NOT NULL,
  ciphertext TEXT NOT NULL,
  encryption_key_id TEXT NOT NULL,
  encryption_algorithm TEXT NOT NULL CHECK (encryption_algorithm = 'aes-256-gcm'),
  snapshot_state TEXT NOT NULL CHECK (snapshot_state = 'sealed'),
  sealed_at TEXT NOT NULL,
  PRIMARY KEY (tenant_scope, snapshot_id),
  UNIQUE (tenant_scope, run_id),
  UNIQUE (tenant_scope, canonical_task_id)
)`;
const SCHEMA_TABLE_V2_SQL = `CREATE TABLE schedule_task_input_snapshot_schema (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  version INTEGER NOT NULL CHECK (version = 2)
)`;
const SCHEMA_TABLE_SQL = `CREATE TABLE schedule_task_input_snapshot_schema (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  version INTEGER NOT NULL CHECK (version = 3)
)`;
const SNAPSHOT_TABLE_SQL = `CREATE TABLE schedule_task_input_snapshots (
  tenant_scope TEXT NOT NULL,
  snapshot_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  canonical_task_id TEXT NOT NULL,
  binding_json TEXT NOT NULL,
  authorization_evidence_digest TEXT NOT NULL,
  source_snapshot_ref_hmac TEXT NOT NULL,
  content_hmac_digest TEXT NOT NULL,
  evidence_digest TEXT NOT NULL,
  retention_definition_digest TEXT,
  retain_until TEXT,
  convergence_evidence_digest TEXT,
  purge_evidence_digest TEXT,
  ciphertext TEXT,
  encryption_key_id TEXT NOT NULL,
  encryption_algorithm TEXT NOT NULL CHECK (encryption_algorithm = 'aes-256-gcm'),
  snapshot_state TEXT NOT NULL CHECK (snapshot_state IN ('sealed','purged')),
  sealed_at TEXT NOT NULL,
  purged_at TEXT,
  PRIMARY KEY (tenant_scope, snapshot_id),
  UNIQUE (tenant_scope, run_id),
  UNIQUE (tenant_scope, canonical_task_id),
  CHECK (
    (snapshot_state = 'sealed' AND ciphertext IS NOT NULL AND convergence_evidence_digest IS NULL
      AND purge_evidence_digest IS NULL AND purged_at IS NULL)
    OR
    (snapshot_state = 'purged' AND ciphertext IS NULL AND retention_definition_digest IS NOT NULL
      AND retain_until IS NOT NULL AND convergence_evidence_digest IS NOT NULL
      AND purge_evidence_digest IS NOT NULL AND purged_at IS NOT NULL)
  )
)`;
const PURGE_INDEX_NAME = "schedule_task_input_snapshots_purge_due";
const PURGE_INDEX_SQL = `CREATE INDEX ${PURGE_INDEX_NAME}
  ON schedule_task_input_snapshots (tenant_scope,snapshot_state,retain_until,run_id)`;
const SCHEMA_SQL = `${SCHEMA_TABLE_SQL};
INSERT INTO schedule_task_input_snapshot_schema VALUES (1, 3);
${SNAPSHOT_TABLE_SQL};
${PURGE_INDEX_SQL};`;

export function createSqliteScheduleTaskInputSnapshotRepository({
  databasePath,
  encryptionKeys,
  currentEncryptionKeyId,
  stableSnapshotHmacKey,
  now = () => new Date(),
} = {}) {
  const dbPath = normalizeDatabasePath(databasePath);
  if (dbPath !== ":memory:") fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const keyring = normalizeKeyring(encryptionKeys);
  const currentKeyId = safeToken(currentEncryptionKeyId, "currentEncryptionKeyId");
  if (!keyring.has(currentKeyId)) throw failure("schedule_task_input_snapshot_current_key_unavailable");
  const hmacKey = exactKey(stableSnapshotHmacKey, "stableSnapshotHmacKey");
  if (typeof now !== "function") throw failure("schedule_task_input_snapshot_clock_invalid");
  const database = new DatabaseSync(dbPath);
  try { initialize(database); } catch (error) { database.close(); throw error; }

  function recordSnapshot(value = {}) {
    exactObject(value, RECORD_FIELDS, "schedule_task_input_snapshot_record_request_invalid");
    const binding = normalizeBinding(value.binding);
    if (binding.contractVersion !== BINDING_VERSION_V2) {
      throw failure("schedule_task_input_snapshot_retention_required");
    }
    const authorizationEvidenceDigest = digest(value.authorizationEvidenceDigest);
    const sourceSnapshotRef = opaqueRef(value.sourceSnapshotRef, "sourceSnapshotRef");
    const snapshot = normalizeSnapshot(value.snapshot, binding);
    const sealedAt = trustedNow(now);
    const retainUntil = addSeconds(sealedAt, binding.snapshotRetentionSeconds);
    const candidate = buildCandidate({
      authorizationEvidenceDigest,
      binding,
      hmacKey,
      snapshot,
      sourceSnapshotRef,
      retainUntil,
    });
    const aad = buildAad(candidate, currentKeyId, sealedAt);
    const ciphertext = encrypt(
      keyring.get(currentKeyId),
      canonicalJson({ snapshot, sourceSnapshotRef }),
      aad,
    );

    return transaction(database, () => {
      const existing = readRow(database, binding.tenantScope, binding.runId);
      if (existing) {
        const authenticated = authenticateRow(existing, keyring, hmacKey);
        const replayCandidate = buildCandidate({
          authorizationEvidenceDigest,
          binding,
          hmacKey,
          snapshot,
          sourceSnapshotRef,
          retainUntil: authenticated.retainUntil,
        });
        requireSame(authenticated, replayCandidate);
        return deepFreeze({ created: false, evidence: projectEvidence(existing) });
      }
      if (database.prepare(
        "SELECT 1 FROM schedule_task_input_snapshots WHERE tenant_scope=? AND canonical_task_id=?",
      ).get(binding.tenantScope, binding.canonicalTaskId)) {
        throw failure("schedule_task_input_snapshot_task_conflict");
      }
      database.prepare(`INSERT INTO schedule_task_input_snapshots (
        tenant_scope,snapshot_id,run_id,canonical_task_id,binding_json,
        authorization_evidence_digest,source_snapshot_ref_hmac,content_hmac_digest,
        evidence_digest,retention_definition_digest,retain_until,ciphertext,encryption_key_id,
        encryption_algorithm,snapshot_state,sealed_at
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,'aes-256-gcm','sealed',?)`).run(
        binding.tenantScope,
        candidate.snapshotId,
        binding.runId,
        binding.canonicalTaskId,
        canonicalJson(binding),
        authorizationEvidenceDigest,
        candidate.sourceSnapshotRefHmac,
        candidate.contentHmacDigest,
        candidate.evidenceDigest,
        binding.retentionDefinitionDigest,
        retainUntil,
        ciphertext,
        currentKeyId,
        sealedAt,
      );
      const stored = readRow(database, binding.tenantScope, binding.runId);
      authenticateRow(stored, keyring, hmacKey);
      return deepFreeze({ created: true, evidence: projectEvidence(stored) });
    });
  }

  function getEvidence(value = {}) {
    const request = normalizeReadRequest(value);
    const row = readRow(database, request.tenantScope, request.runId);
    if (!row) return null;
    const authenticated = row.snapshot_state === "purged"
      ? authenticatePurgedRow(row, hmacKey)
      : authenticateRow(row, keyring, hmacKey);
    requireReadIdentity(authenticated, request);
    return projectEvidence(row);
  }

  function readInternalSnapshot(value = {}) {
    const request = normalizeReadRequest(value);
    const row = readRow(database, request.tenantScope, request.runId);
    if (!row) return null;
    const authenticated = authenticateRow(row, keyring, hmacKey);
    requireReadIdentity(authenticated, request);
    return deepFreeze({
      contractVersion: INTERNAL_VERSION,
      evidence: projectEvidence(row),
      payloadBoundary: "internal_only",
      snapshot: authenticated.snapshot,
      sourceSnapshotRef: authenticated.sourceSnapshotRef,
    });
  }

  function readInternalSnapshotByBinding(value = {}) {
    const request = normalizeBindingReadRequest(value);
    const row = readRow(database, request.tenantScope, request.runId);
    if (!row) return null;
    const authenticated = authenticateRow(row, keyring, hmacKey);
    if (!isDeepStrictEqual(authenticated.binding, request.expectedBinding)) {
      throw failure("schedule_task_input_snapshot_binding_mismatch");
    }
    return deepFreeze({
      contractVersion: INTERNAL_VERSION,
      evidence: projectEvidence(row),
      payloadBoundary: "internal_only",
      snapshot: authenticated.snapshot,
      sourceSnapshotRef: authenticated.sourceSnapshotRef,
    });
  }

  function getPurgeCandidate(value = {}) {
    exactObject(value, PURGE_CANDIDATE_FIELDS,
      "schedule_task_input_snapshot_purge_candidate_request_invalid");
    const tenantScope = safeToken(value.tenantScope, "tenantScope");
    const runId = safeToken(value.runId, "runId");
    const row = readRow(database, tenantScope, runId);
    if (!row) return null;
    const authenticated = row.snapshot_state === "purged"
      ? authenticatePurgedRow(row, hmacKey)
      : authenticateRow(row, keyring, hmacKey);
    if (authenticated.binding.contractVersion !== BINDING_VERSION_V2) {
      throw failure("schedule_task_input_snapshot_retention_required");
    }
    return deepFreeze({
      authorizationEvidenceDigest: authenticated.authorizationEvidenceDigest,
      binding: authenticated.binding,
      contractVersion: "schedule-task-input-snapshot-purge-candidate.v1",
      evidence: projectEvidence(row),
      payloadBoundary: "internal_only",
      retainUntil: authenticated.retainUntil,
    });
  }

  function listPurgeCandidates(value = {}) {
    exactObject(value, LIST_PURGE_CANDIDATES_FIELDS,
      "schedule_task_input_snapshot_purge_list_request_invalid");
    const tenantScope = safeToken(value.tenantScope, "tenantScope");
    const limit = boundedInteger(value.limit, 1, 500);
    const checkedAt = trustedNow(now);
    const rows = database.prepare(`SELECT * FROM schedule_task_input_snapshots
      WHERE tenant_scope=? AND snapshot_state='sealed' AND retain_until IS NOT NULL
        AND retain_until<=?
      ORDER BY retain_until,run_id LIMIT ?`).all(tenantScope, checkedAt, limit);
    const candidates = rows.map((row) => {
      const authenticated = authenticateRow(row, keyring, hmacKey);
      if (authenticated.binding.contractVersion !== BINDING_VERSION_V2 ||
        authenticated.binding.tenantScope !== tenantScope) {
        throw failure("schedule_task_input_snapshot_integrity_invalid");
      }
      return deepFreeze({ runId: authenticated.binding.runId });
    });
    return deepFreeze({
      candidates,
      checkedAt,
      contractVersion: "schedule-task-input-snapshot-purge-candidate-list.v1",
    });
  }

  function purgeSnapshot(value = {}) {
    const request = normalizePurgeRequest(value);
    const purgedAt = trustedNow(now);
    return transaction(database, () => {
      const row = readRow(database, request.tenantScope, request.runId);
      if (!row) return null;
      const authenticated = row.snapshot_state === "purged"
        ? authenticatePurgedRow(row, hmacKey)
        : authenticateRow(row, keyring, hmacKey);
      requireReadIdentity(authenticated, request);
      if (authenticated.evidenceDigest !== request.expectedEvidenceDigest) {
        throw failure("schedule_task_input_snapshot_binding_mismatch");
      }
      if (row.snapshot_state === "purged") {
        if (row.convergence_evidence_digest !== request.convergenceEvidenceDigest) {
          throw failure("schedule_task_input_snapshot_purge_conflict");
        }
        return deepFreeze({ created: false, evidence: projectEvidence(row) });
      }
      if (authenticated.binding.contractVersion !== BINDING_VERSION_V2 ||
        !row.retention_definition_digest || !row.retain_until) {
        throw failure("schedule_task_input_snapshot_retention_required");
      }
      if (purgedAt < row.retain_until) {
        throw failure("schedule_task_input_snapshot_retention_active");
      }
      const purgeEvidenceDigest = buildPurgeEvidenceDigest(hmacKey, row, {
        convergenceEvidenceDigest: request.convergenceEvidenceDigest,
        purgedAt,
      });
      const updated = database.prepare(`UPDATE schedule_task_input_snapshots SET
        ciphertext=NULL,snapshot_state='purged',convergence_evidence_digest=?,
        purge_evidence_digest=?,purged_at=?
        WHERE tenant_scope=? AND run_id=? AND snapshot_state='sealed' AND evidence_digest=?`
      ).run(
        request.convergenceEvidenceDigest,
        purgeEvidenceDigest,
        purgedAt,
        request.tenantScope,
        request.runId,
        request.expectedEvidenceDigest,
      );
      if (updated.changes !== 1) throw failure("schedule_task_input_snapshot_purge_conflict");
      const stored = readRow(database, request.tenantScope, request.runId);
      authenticatePurgedRow(stored, hmacKey);
      return deepFreeze({ created: true, evidence: projectEvidence(stored) });
    });
  }

  return Object.freeze({
    close: () => database.close(),
    contractVersion: "schedule-task-input-snapshot-repository.v1",
    getEvidence,
    getPurgeCandidate,
    listPurgeCandidates,
    readInternalSnapshot,
    readInternalSnapshotByBinding,
    recordSnapshot,
    purgeSnapshot,
  });
}

function buildCandidate({ authorizationEvidenceDigest, binding, hmacKey, snapshot, sourceSnapshotRef,
  retainUntil = null }) {
  const current = binding.contractVersion === BINDING_VERSION_V2;
  const sourceSnapshotRefHmac = keyedDigest(hmacKey, `schedule-task-input-source-ref.${current ? "v2" : "v1"}`, [
    binding.tenantScope,
    binding.sourceAdapterId,
    sourceSnapshotRef,
  ]);
  const contentParts = [
    binding,
    authorizationEvidenceDigest,
    sourceSnapshotRef,
    snapshot,
  ];
  if (current) contentParts.push(retainUntil);
  const contentHmacDigest = keyedDigest(hmacKey, `schedule-task-input-content.${current ? "v2" : "v1"}`,
    contentParts);
  const snapshotId = `schedule_task_input_snapshot_${keyedDigest(
    hmacKey,
    `schedule-task-input-snapshot-id.${current ? "v2" : "v1"}`,
    current
      ? [binding, authorizationEvidenceDigest, sourceSnapshotRefHmac, contentHmacDigest, retainUntil]
      : [binding, authorizationEvidenceDigest, sourceSnapshotRefHmac, contentHmacDigest],
  )}`;
  const evidenceParts = [
    binding,
    authorizationEvidenceDigest,
    contentHmacDigest,
    snapshotId,
    sourceSnapshotRefHmac,
  ];
  if (current) evidenceParts.push(retainUntil);
  const evidenceDigest = keyedDigest(hmacKey,
    `schedule-task-input-snapshot-evidence.${current ? "v2" : "v1"}`, evidenceParts);
  return {
    authorizationEvidenceDigest,
    binding,
    contentHmacDigest,
    evidenceDigest,
    snapshot,
    snapshotId,
    sourceSnapshotRef,
    sourceSnapshotRefHmac,
    retainUntil,
  };
}

function buildAad(candidate, encryptionKeyId, sealedAt) {
  return canonicalJson({
    authorizationEvidenceDigest: candidate.authorizationEvidenceDigest,
    binding: candidate.binding,
    contentHmacDigest: candidate.contentHmacDigest,
    contractVersion: candidate.binding.contractVersion === BINDING_VERSION_V2
      ? "schedule-task-input-snapshot-ciphertext.v2"
      : "schedule-task-input-snapshot-ciphertext.v1",
    encryptionAlgorithm: "aes-256-gcm",
    encryptionKeyId,
    evidenceDigest: candidate.evidenceDigest,
    ...(candidate.binding.contractVersion === BINDING_VERSION_V2
      ? { retainUntil: candidate.retainUntil }
      : {}),
    sealedAt,
    snapshotId: candidate.snapshotId,
    sourceSnapshotRefHmac: candidate.sourceSnapshotRefHmac,
  });
}

function authenticateRow(row, keyring, hmacKey) {
  validateStoredRow(row);
  if (row.snapshot_state !== "sealed") {
    throw failure("schedule_task_input_snapshot_purged");
  }
  let decodedBinding;
  try { decodedBinding = JSON.parse(row.binding_json); }
  catch { throw failure("schedule_task_input_snapshot_binding_invalid"); }
  const binding = normalizeBinding(decodedBinding);
  if (canonicalJson(binding) !== row.binding_json || binding.tenantScope !== row.tenant_scope ||
    binding.runId !== row.run_id || binding.canonicalTaskId !== row.canonical_task_id) {
    throw failure("schedule_task_input_snapshot_integrity_invalid");
  }
  requireStoredRetention(row, binding);
  const key = keyring.get(row.encryption_key_id);
  if (!key) throw failure("schedule_task_input_snapshot_encryption_key_unavailable");
  const storedCandidate = {
    authorizationEvidenceDigest: row.authorization_evidence_digest,
    binding,
    contentHmacDigest: row.content_hmac_digest,
    evidenceDigest: row.evidence_digest,
    snapshotId: row.snapshot_id,
    sourceSnapshotRefHmac: row.source_snapshot_ref_hmac,
    retainUntil: row.retain_until,
  };
  const plaintext = decrypt(
    key,
    row.ciphertext,
    buildAad(storedCandidate, row.encryption_key_id, row.sealed_at),
  );
  let decoded;
  try { decoded = JSON.parse(plaintext); }
  catch { throw failure("schedule_task_input_snapshot_plaintext_invalid"); }
  if (!isPlainObject(decoded) || !Object.hasOwn(decoded, "snapshot") ||
    !Object.hasOwn(decoded, "sourceSnapshotRef") || Object.keys(decoded).length !== 2) {
    throw failure("schedule_task_input_snapshot_plaintext_invalid");
  }
  const sourceSnapshotRef = opaqueRef(decoded.sourceSnapshotRef, "sourceSnapshotRef");
  const snapshot = normalizeSnapshot(decoded.snapshot, binding);
  const derived = buildCandidate({
    authorizationEvidenceDigest: row.authorization_evidence_digest,
    binding,
    hmacKey,
    snapshot,
    sourceSnapshotRef,
    retainUntil: row.retain_until,
  });
  for (const field of [
    "contentHmacDigest", "evidenceDigest", "snapshotId", "sourceSnapshotRefHmac",
  ]) {
    if (derived[field] !== storedCandidate[field]) {
      throw failure("schedule_task_input_snapshot_integrity_invalid");
    }
  }
  return derived;
}

function authenticatePurgedRow(row, hmacKey) {
  validateStoredRow(row);
  if (row.snapshot_state !== "purged") {
    throw failure("schedule_task_input_snapshot_integrity_invalid");
  }
  let decodedBinding;
  try { decodedBinding = JSON.parse(row.binding_json); }
  catch { throw failure("schedule_task_input_snapshot_binding_invalid"); }
  const binding = normalizeBinding(decodedBinding);
  if (binding.contractVersion !== BINDING_VERSION_V2 ||
    canonicalJson(binding) !== row.binding_json || binding.tenantScope !== row.tenant_scope ||
    binding.runId !== row.run_id || binding.canonicalTaskId !== row.canonical_task_id) {
    throw failure("schedule_task_input_snapshot_integrity_invalid");
  }
  requireStoredRetention(row, binding);
  const expectedPurgeDigest = buildPurgeEvidenceDigest(hmacKey, row, {
    convergenceEvidenceDigest: row.convergence_evidence_digest,
    purgedAt: row.purged_at,
  });
  if (expectedPurgeDigest !== row.purge_evidence_digest) {
    throw failure("schedule_task_input_snapshot_integrity_invalid");
  }
  return {
    authorizationEvidenceDigest: row.authorization_evidence_digest,
    binding,
    evidenceDigest: row.evidence_digest,
    retainUntil: row.retain_until,
    snapshotId: row.snapshot_id,
  };
}

function requireStoredRetention(row, binding) {
  if (binding.contractVersion === BINDING_VERSION_V1) {
    if (row.retention_definition_digest !== null || row.retain_until !== null) {
      throw failure("schedule_task_input_snapshot_integrity_invalid");
    }
    return;
  }
  const expectedRetainUntil = addSeconds(row.sealed_at, binding.snapshotRetentionSeconds);
  if (row.retention_definition_digest !== binding.retentionDefinitionDigest ||
    row.retain_until !== expectedRetainUntil) {
    throw failure("schedule_task_input_snapshot_integrity_invalid");
  }
}

function buildPurgeEvidenceDigest(hmacKey, row, { convergenceEvidenceDigest, purgedAt }) {
  return keyedDigest(hmacKey, "schedule-task-input-snapshot-purge-evidence.v1", [{
    authorizationEvidenceDigest: row.authorization_evidence_digest,
    bindingJson: row.binding_json,
    canonicalTaskId: row.canonical_task_id,
    contentHmacDigest: row.content_hmac_digest,
    convergenceEvidenceDigest: digest(convergenceEvidenceDigest),
    encryptionAlgorithm: row.encryption_algorithm,
    encryptionKeyId: row.encryption_key_id,
    evidenceDigest: row.evidence_digest,
    purgedAt: timestamp(purgedAt),
    retainUntil: timestamp(row.retain_until),
    retentionDefinitionDigest: digest(row.retention_definition_digest),
    runId: row.run_id,
    sealedAt: row.sealed_at,
    snapshotId: row.snapshot_id,
    sourceSnapshotRefHmac: row.source_snapshot_ref_hmac,
    tenantScope: row.tenant_scope,
  }]);
}

function requireSame(existing, candidate) {
  const fields = [
    "authorizationEvidenceDigest", "binding", "contentHmacDigest", "evidenceDigest", "snapshot",
    "snapshotId", "sourceSnapshotRef", "sourceSnapshotRefHmac", "retainUntil",
  ];
  if (fields.some((field) => !isDeepStrictEqual(existing[field], candidate[field]))) {
    throw failure("schedule_task_input_snapshot_conflict");
  }
}

function requireReadIdentity(authenticated, request) {
  if (!isDeepStrictEqual(authenticated.binding, request.expectedBinding) ||
    authenticated.authorizationEvidenceDigest !== request.authorizationEvidenceDigest) {
    throw failure("schedule_task_input_snapshot_binding_mismatch");
  }
}

function projectEvidence(row) {
  const contractVersion = row.retention_definition_digest === null
    ? EVIDENCE_VERSION_V1
    : EVIDENCE_VERSION_V2;
  return deepFreeze({
    contractVersion,
    evidenceDigest: row.evidence_digest,
    inputSnapshotRef: row.snapshot_id,
    sealedAt: row.sealed_at,
    state: row.snapshot_state,
  });
}

function normalizeReadRequest(value) {
  exactObject(value, READ_FIELDS, "schedule_task_input_snapshot_read_request_invalid");
  const tenantScope = safeToken(value.tenantScope, "tenantScope");
  const runId = safeToken(value.runId, "runId");
  const expectedBinding = normalizeBinding(value.expectedBinding);
  if (tenantScope !== expectedBinding.tenantScope || runId !== expectedBinding.runId) {
    throw failure("schedule_task_input_snapshot_binding_mismatch");
  }
  return {
    authorizationEvidenceDigest: digest(value.authorizationEvidenceDigest),
    expectedBinding,
    runId,
    tenantScope,
  };
}

function normalizeBindingReadRequest(value) {
  exactObject(value, BINDING_READ_FIELDS, "schedule_task_input_snapshot_read_request_invalid");
  const tenantScope = safeToken(value.tenantScope, "tenantScope");
  const runId = safeToken(value.runId, "runId");
  const expectedBinding = normalizeBinding(value.expectedBinding);
  if (tenantScope !== expectedBinding.tenantScope || runId !== expectedBinding.runId) {
    throw failure("schedule_task_input_snapshot_binding_mismatch");
  }
  return { expectedBinding, runId, tenantScope };
}

function normalizePurgeRequest(value) {
  exactObject(value, PURGE_FIELDS, "schedule_task_input_snapshot_purge_request_invalid");
  const tenantScope = safeToken(value.tenantScope, "tenantScope");
  const runId = safeToken(value.runId, "runId");
  const expectedBinding = normalizeBinding(value.expectedBinding);
  if (expectedBinding.contractVersion !== BINDING_VERSION_V2 ||
    tenantScope !== expectedBinding.tenantScope || runId !== expectedBinding.runId) {
    throw failure("schedule_task_input_snapshot_binding_mismatch");
  }
  return {
    authorizationEvidenceDigest: digest(value.authorizationEvidenceDigest),
    convergenceEvidenceDigest: digest(value.convergenceEvidenceDigest),
    expectedBinding,
    expectedEvidenceDigest: digest(value.expectedEvidenceDigest),
    runId,
    tenantScope,
  };
}

export function normalizeScheduleTaskInputSnapshotBinding(value) {
  const version = value?.contractVersion;
  const fields = version === BINDING_VERSION_V2 ? BINDING_V2_FIELDS : BINDING_FIELDS;
  exactObject(value, fields, "schedule_task_input_snapshot_binding_invalid");
  if (![BINDING_VERSION_V1, BINDING_VERSION_V2].includes(version)) {
    throw failure("schedule_task_input_snapshot_binding_version_invalid");
  }
  const binding = {
    activationSnapshotDigest: digest(value.activationSnapshotDigest),
    activationSnapshotId: safeToken(value.activationSnapshotId, "activationSnapshotId"),
    activationVersion: positiveInteger(value.activationVersion),
    canonicalTaskId: safeToken(value.canonicalTaskId, "canonicalTaskId"),
    contractVersion: version,
    employeeId: safeToken(value.employeeId, "employeeId"),
    executionContractDigest: digest(value.executionContractDigest),
    inputContractDigest: digest(value.inputContractDigest),
    maxItems: boundedInteger(value.maxItems, 1, 1000),
    maxPayloadBytes: boundedInteger(value.maxPayloadBytes, 1, MAX_SNAPSHOT_BYTES),
    runId: safeToken(value.runId, "runId"),
    scheduleId: safeToken(value.scheduleId, "scheduleId"),
    scheduledFor: timestamp(value.scheduledFor),
    snapshotContractVersion: safeToken(value.snapshotContractVersion, "snapshotContractVersion"),
    sourceAdapterId: safeToken(value.sourceAdapterId, "sourceAdapterId"),
    sourceBindingDigest: digest(value.sourceBindingDigest),
    taskDefinitionId: safeToken(value.taskDefinitionId, "taskDefinitionId"),
    taskDefinitionVersion: positiveInteger(value.taskDefinitionVersion),
    tenantScope: safeToken(value.tenantScope, "tenantScope"),
    triggerId: safeToken(value.triggerId, "triggerId"),
  };
  if (version === BINDING_VERSION_V2) {
    binding.retentionDefinitionDigest = digest(value.retentionDefinitionDigest);
    binding.snapshotRetentionSeconds = boundedInteger(
      value.snapshotRetentionSeconds,
      60,
      365 * 24 * 60 * 60,
    );
  }
  return deepFreeze(binding);
}

const normalizeBinding = normalizeScheduleTaskInputSnapshotBinding;

function normalizeSnapshot(value, binding) {
  exactObject(value, SNAPSHOT_FIELDS, "schedule_task_input_snapshot_invalid");
  if (value.contractVersion !== SNAPSHOT_VERSION ||
    value.snapshotContractVersion !== binding.snapshotContractVersion ||
    !Array.isArray(value.items) || value.items.length > binding.maxItems) {
    throw failure("schedule_task_input_snapshot_invalid");
  }
  const budget = { nodes: 0 };
  const items = value.items.map((item) => {
    const normalized = normalizeJsonValue(item, 0, budget);
    if (!isPlainObject(normalized)) throw failure("schedule_task_input_snapshot_invalid");
    return normalized;
  });
  const snapshot = deepFreeze({
    contractVersion: SNAPSHOT_VERSION,
    items,
    snapshotContractVersion: binding.snapshotContractVersion,
  });
  if (Buffer.byteLength(canonicalJson(snapshot), "utf8") > binding.maxPayloadBytes) {
    throw failure("schedule_task_input_snapshot_too_large");
  }
  return snapshot;
}

function normalizeJsonValue(value, depth, budget) {
  budget.nodes += 1;
  if (budget.nodes > MAX_JSON_NODES || depth > MAX_JSON_DEPTH) {
    throw failure("schedule_task_input_snapshot_invalid");
  }
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw failure("schedule_task_input_snapshot_invalid");
    return Object.is(value, -0) ? 0 : value;
  }
  if (Array.isArray(value)) return value.map((item) => normalizeJsonValue(item, depth + 1, budget));
  if (!isPlainObject(value)) throw failure("schedule_task_input_snapshot_invalid");
  const result = {};
  for (const key of Object.keys(value).sort()) {
    const item = value[key];
    if (typeof item === "undefined" || typeof item === "function" || typeof item === "symbol") {
      throw failure("schedule_task_input_snapshot_invalid");
    }
    Object.defineProperty(result, key, {
      configurable: false,
      enumerable: true,
      value: normalizeJsonValue(item, depth + 1, budget),
      writable: false,
    });
  }
  return result;
}

function readRow(database, tenantScope, runId) {
  return database.prepare(
    "SELECT * FROM schedule_task_input_snapshots WHERE tenant_scope=? AND run_id=?",
  ).get(tenantScope, runId) || null;
}

function validateStoredRow(row) {
  if (!row || row.encryption_algorithm !== "aes-256-gcm" ||
    !["sealed", "purged"].includes(row.snapshot_state)) {
    throw failure("schedule_task_input_snapshot_integrity_invalid");
  }
  for (const value of [
    row.authorization_evidence_digest,
    row.source_snapshot_ref_hmac,
    row.content_hmac_digest,
    row.evidence_digest,
  ]) digest(value);
  if (!/^schedule_task_input_snapshot_[a-f0-9]{64}$/.test(row.snapshot_id)) {
    throw failure("schedule_task_input_snapshot_integrity_invalid");
  }
  timestamp(row.sealed_at);
  if (row.retention_definition_digest !== null) digest(row.retention_definition_digest);
  if (row.retain_until !== null) timestamp(row.retain_until);
  if (row.snapshot_state === "sealed") {
    if (typeof row.ciphertext !== "string" || !row.ciphertext || row.purged_at !== null ||
      row.convergence_evidence_digest !== null || row.purge_evidence_digest !== null) {
      throw failure("schedule_task_input_snapshot_integrity_invalid");
    }
  } else {
    if (row.ciphertext !== null || row.retention_definition_digest === null || row.retain_until === null) {
      throw failure("schedule_task_input_snapshot_integrity_invalid");
    }
    digest(row.convergence_evidence_digest);
    digest(row.purge_evidence_digest);
    timestamp(row.purged_at);
  }
}

function initialize(database) {
  database.exec("PRAGMA busy_timeout = 5000; PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL; PRAGMA foreign_keys = ON");
  const objects = database.prepare(
    "SELECT type,name FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name",
  ).all();
  if (objects.length === 0) {
    transaction(database, () => database.exec(SCHEMA_SQL));
  } else {
    const version = readSchemaVersion(database);
    if (version === 1) {
      validateSchema(database, 1);
      migrateV1ToV2(database);
    }
    if (readSchemaVersion(database) === 2) {
      validateSchema(database, 2);
      migrateV2ToV3(database);
    }
  }
  validateSchema(database);
}

function readSchemaVersion(database) {
  try {
    const rows = database.prepare(
      "SELECT singleton,version FROM schedule_task_input_snapshot_schema",
    ).all();
    if (rows.length !== 1 || rows[0].singleton !== 1 || ![1, 2, 3].includes(rows[0].version)) {
      throw invalidSchema();
    }
    return rows[0].version;
  } catch (error) {
    if (error?.message === invalidSchema().message) throw error;
    throw invalidSchema();
  }
}

function migrateV1ToV2(database) {
  transaction(database, () => {
    database.exec(`
      ALTER TABLE schedule_task_input_snapshots RENAME TO schedule_task_input_snapshots_v1;
      DROP TABLE schedule_task_input_snapshot_schema;
      ${SCHEMA_TABLE_V2_SQL};
      INSERT INTO schedule_task_input_snapshot_schema VALUES (1, 2);
      ${SNAPSHOT_TABLE_SQL};
      INSERT INTO schedule_task_input_snapshots (
        tenant_scope,snapshot_id,run_id,canonical_task_id,binding_json,
        authorization_evidence_digest,source_snapshot_ref_hmac,content_hmac_digest,
        evidence_digest,retention_definition_digest,retain_until,convergence_evidence_digest,
        purge_evidence_digest,ciphertext,encryption_key_id,encryption_algorithm,snapshot_state,
        sealed_at,purged_at
      ) SELECT
        tenant_scope,snapshot_id,run_id,canonical_task_id,binding_json,
        authorization_evidence_digest,source_snapshot_ref_hmac,content_hmac_digest,
        evidence_digest,NULL,NULL,NULL,NULL,ciphertext,encryption_key_id,encryption_algorithm,
        snapshot_state,sealed_at,NULL
      FROM schedule_task_input_snapshots_v1;
      DROP TABLE schedule_task_input_snapshots_v1;
    `);
  });
}

function migrateV2ToV3(database) {
  transaction(database, () => {
    database.exec(`
      DROP TABLE schedule_task_input_snapshot_schema;
      ${SCHEMA_TABLE_SQL};
      INSERT INTO schedule_task_input_snapshot_schema VALUES (1, 3);
      ${PURGE_INDEX_SQL};
    `);
  });
}

function validateSchema(database, version = 3) {
  const objects = database.prepare(
    "SELECT type,name,tbl_name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name",
  ).all();
  if (objects.some((item) => !["index", "table"].includes(item.type))) throw invalidSchema();
  const tables = objects.filter((item) => item.type === "table");
  if (!isDeepStrictEqual(tables.map((item) => item.name), [
    "schedule_task_input_snapshot_schema",
    "schedule_task_input_snapshots",
  ])) throw invalidSchema();
  const rows = database.prepare(
    "SELECT singleton,version FROM schedule_task_input_snapshot_schema",
  ).all();
  if (rows.length !== 1 || rows[0].singleton !== 1 || rows[0].version !== version) throw invalidSchema();
  const expectedSql = new Map([
    ["schedule_task_input_snapshot_schema", normalizeSql(
      version === 1 ? SCHEMA_TABLE_V1_SQL : version === 2 ? SCHEMA_TABLE_V2_SQL : SCHEMA_TABLE_SQL,
    )],
    ["schedule_task_input_snapshots", normalizeSql(
      version === 1 ? SNAPSHOT_TABLE_V1_SQL : SNAPSHOT_TABLE_SQL,
    )],
  ]);
  for (const table of tables) {
    if (normalizeSql(table.sql) !== expectedSql.get(table.name)) throw invalidSchema();
  }
  const indexes = objects.filter((item) => item.type === "index");
  if (version === 3) {
    if (indexes.length !== 1 || indexes[0].name !== PURGE_INDEX_NAME ||
      indexes[0].tbl_name !== "schedule_task_input_snapshots" ||
      normalizeSql(indexes[0].sql) !== normalizeSql(PURGE_INDEX_SQL)) throw invalidSchema();
  } else if (indexes.length !== 0) throw invalidSchema();
  requireIndexes(database, "schedule_task_input_snapshot_schema", []);
  requireIndexes(database, "schedule_task_input_snapshots", [
    ["pk", 1, ["tenant_scope", "snapshot_id"], false],
    ["u", 1, ["tenant_scope", "run_id"], false],
    ["u", 1, ["tenant_scope", "canonical_task_id"], false],
    ...(version === 3
      ? [["c", 0, ["tenant_scope", "snapshot_state", "retain_until", "run_id"], false]]
      : []),
  ]);
}

function requireIndexes(database, table, expected) {
  const actual = database.prepare(`PRAGMA index_list(${table})`).all().map((item) => [
    item.origin,
    item.unique,
    database.prepare(`PRAGMA index_info(${item.name})`).all()
      .sort((left, right) => left.seqno - right.seqno).map((part) => part.name),
    item.partial === 1,
  ]);
  const sort = (items) => items.toSorted((left, right) =>
    canonicalJson(left).localeCompare(canonicalJson(right)));
  if (!isDeepStrictEqual(sort(actual), sort(expected))) throw invalidSchema();
}

function encrypt(key, plaintext, aad) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(Buffer.from(aad));
  const body = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return [iv, cipher.getAuthTag(), body].map((part) => part.toString("base64")).join(".");
}

function decrypt(key, value, aad) {
  try {
    const encoded = String(value).split(".");
    if (encoded.length !== 3 || encoded.some((part) => !/^[A-Za-z0-9+/]+={0,2}$/.test(part))) {
      throw new Error();
    }
    const [iv, tag, body] = encoded.map((part) => Buffer.from(part, "base64"));
    if (iv.length !== 12 || tag.length !== 16 || body.length === 0) throw new Error();
    const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
    decipher.setAAD(Buffer.from(aad));
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(body), decipher.final()]).toString("utf8");
  } catch {
    throw failure("schedule_task_input_snapshot_decryption_failed");
  }
}

function normalizeKeyring(value) {
  const entries = value instanceof Map ? [...value] : Object.entries(value || {});
  if (!entries.length || entries.length > 32) throw failure("schedule_task_input_snapshot_keyring_invalid");
  return new Map(entries.map(([id, key]) => [
    safeToken(id, "encryptionKeyId"),
    exactKey(key, "encryptionKey"),
  ]));
}

function exactKey(value, field) {
  const key = Buffer.isBuffer(value) ? Buffer.from(value) : Buffer.from(value || []);
  if (key.length !== 32) throw failure("schedule_task_input_snapshot_key_invalid", field);
  return key;
}

function normalizeDatabasePath(value) {
  const result = String(value || "").trim();
  if (result === ":memory:") return result;
  if (!result || !path.isAbsolute(result)) {
    throw new TypeError("schedule task input snapshot databasePath must be absolute or :memory:");
  }
  return path.normalize(result);
}

function transaction(database, run) {
  database.exec("BEGIN IMMEDIATE");
  try {
    const result = run();
    database.exec("COMMIT");
    return result;
  } catch (error) {
    if (database.isTransaction) database.exec("ROLLBACK");
    throw error;
  }
}

function exactObject(value, fields, code) {
  if (!isPlainObject(value) || Object.keys(value).some((key) => !fields.has(key)) ||
    [...fields].some((key) => !Object.hasOwn(value, key))) throw failure(code);
}

function safeToken(value, field = "token") {
  const result = String(value || "").trim();
  if (!TOKEN.test(result) || /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(result) || SECRET.test(result)) {
    throw failure("schedule_task_input_snapshot_token_invalid", field);
  }
  return result;
}

function opaqueRef(value, field) {
  const result = String(value || "").trim();
  if (!OPAQUE_REF.test(result) || /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(result) || SECRET.test(result)) {
    throw failure("schedule_task_input_snapshot_reference_invalid", field);
  }
  return result;
}

function digest(value) {
  const result = String(value || "").trim().toLowerCase();
  if (!DIGEST.test(result)) throw failure("schedule_task_input_snapshot_digest_invalid");
  return result;
}

function timestamp(value) {
  const input = value instanceof Date ? value.toISOString() : String(value || "").trim();
  const parsed = new Date(input);
  if (!input || !Number.isFinite(parsed.getTime()) || parsed.toISOString() !== input) {
    throw failure("schedule_task_input_snapshot_timestamp_invalid");
  }
  return input;
}

function trustedNow(now) {
  try { return timestamp(now()); }
  catch (error) {
    if (error?.code) throw error;
    throw failure("schedule_task_input_snapshot_clock_invalid");
  }
}

function addSeconds(value, seconds) {
  const result = new Date(timestamp(value)).getTime() + boundedInteger(
    seconds,
    60,
    365 * 24 * 60 * 60,
  ) * 1000;
  return new Date(result).toISOString();
}

function positiveInteger(value) {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw failure("schedule_task_input_snapshot_integer_invalid");
  }
  return value;
}

function boundedInteger(value, minimum, maximum) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw failure("schedule_task_input_snapshot_integer_invalid");
  }
  return value;
}

function keyedDigest(key, domain, parts) {
  return crypto.createHmac("sha256", key).update(canonicalJson([domain, ...parts])).digest("hex");
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) =>
      `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  const result = JSON.stringify(value);
  if (result === undefined) throw failure("schedule_task_input_snapshot_value_invalid");
  return result;
}

function normalizeSql(value) { return String(value || "").replace(/\s+/g, " ").trim(); }
function isPlainObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  Object.freeze(value);
  Object.values(value).forEach(deepFreeze);
  return value;
}
function invalidSchema() { return new TypeError("invalid schedule task input snapshot SQLite schema v3"); }
function failure(code, detail = "") {
  const error = new Error(detail ? `${code}: ${detail}` : code);
  error.code = code;
  return error;
}

export {
  BINDING_VERSION_V1 as SCHEDULE_TASK_INPUT_SNAPSHOT_BINDING_CONTRACT_VERSION,
  BINDING_VERSION_V2 as SCHEDULE_TASK_INPUT_SNAPSHOT_BINDING_V2_CONTRACT_VERSION,
  EVIDENCE_VERSION_V1 as SCHEDULE_TASK_INPUT_SNAPSHOT_EVIDENCE_CONTRACT_VERSION,
  EVIDENCE_VERSION_V2 as SCHEDULE_TASK_INPUT_SNAPSHOT_EVIDENCE_V2_CONTRACT_VERSION,
  SNAPSHOT_VERSION as SCHEDULE_TASK_INPUT_SNAPSHOT_CONTRACT_VERSION,
};
