import crypto from "node:crypto";
import { groupTranscriptEntries } from "./context-evidence-pruning.mjs";

const COMPACTION_CHECKPOINT_CONTRACT = "compaction-checkpoint.v1";

function createCompactionCheckpointRepository({
  createId = () => `checkpoint-${crypto.randomUUID()}`,
  now = () => Date.now(),
  sessionRepository,
  store,
} = {}) {
  assertDependencies({ sessionRepository, store });

  async function read(sessionId) {
    const value = await store.readCheckpoint(requiredText(sessionId, "sessionId"));
    return value ? validateCheckpoint(value) : null;
  }

  async function save({
    expectedCheckpointRevision = 0,
    expectedSessionRevision,
    product,
    sessionId,
  } = {}) {
    const safeSessionId = requiredText(sessionId, "sessionId");
    const [session, entries, current] = await Promise.all([
      sessionRepository.readSession(safeSessionId),
      sessionRepository.readTranscript(safeSessionId),
      store.readCheckpoint(safeSessionId),
    ]);
    if (!session || !entries) throw checkpointError("checkpoint_session_not_found");
    if (!Number.isInteger(expectedSessionRevision) || session.revision !== expectedSessionRevision) {
      throw checkpointError("checkpoint_source_revision_stale");
    }
    const currentRevision = current ? validateCheckpoint(current).revision : 0;
    if (currentRevision !== expectedCheckpointRevision) throw checkpointError("checkpoint_revision_conflict");
    const next = buildCheckpoint({
      checkpointId: createId(),
      entries,
      now,
      product,
      revision: currentRevision + 1,
      session,
    });
    const saved = await store.compareAndSwapCheckpoint(safeSessionId, currentRevision, next);
    if (!saved) throw checkpointError("checkpoint_revision_conflict");
    return validateCheckpoint(next);
  }

  async function deleteForSession(sessionId) {
    const safeSessionId = requiredText(sessionId, "sessionId");
    const deleted = await store.deleteCheckpoint(safeSessionId);
    const confirmedAbsent = !(await store.readCheckpoint(safeSessionId));
    return {
      contractVersion: "compaction-checkpoint-deletion-evidence.v1",
      sessionId: safeSessionId,
      scope: "compaction_checkpoint_store",
      deleted: Boolean(deleted),
      confirmedAbsent,
      verifiedAt: new Date(now()).toISOString(),
    };
  }

  return { deleteForSession, read, save };
}

function createMemoryCompactionCheckpointStore() {
  const values = new Map();
  return {
    contractVersion: "compaction-checkpoint-store.v1",
    productionReady: false,
    async compareAndSwapCheckpoint(sessionId, expectedRevision, next) {
      const currentRevision = values.get(sessionId)?.revision || 0;
      if (currentRevision !== expectedRevision) return false;
      values.set(sessionId, structuredClone(next));
      return true;
    },
    async deleteCheckpoint(sessionId) {
      return values.delete(sessionId);
    },
    async readCheckpoint(sessionId) {
      const value = values.get(sessionId);
      return value ? structuredClone(value) : null;
    },
  };
}

function buildCheckpoint({ checkpointId, entries, now, product = {}, revision, session }) {
  const summary = String(product.summary || "").trim();
  if (!summary) throw checkpointError("checkpoint_product_empty");
  const coveredThroughSeq = positiveInteger(product.coveredThroughSeq, "coveredThroughSeq");
  const retainTailFromSeq = positiveInteger(product.retainTailFromSeq, "retainTailFromSeq");
  if (retainTailFromSeq !== coveredThroughSeq + 1) throw checkpointError("checkpoint_coverage_not_contiguous");
  if (coveredThroughSeq >= entries.length) throw checkpointError("checkpoint_tail_required");
  const groups = groupTranscriptEntries(entries);
  if (groups.some((group) => {
    const seqs = group.entries.map((entry) => entry.seq);
    return Math.min(...seqs) <= coveredThroughSeq && Math.max(...seqs) > coveredThroughSeq;
  })) throw checkpointError("checkpoint_splits_tool_pair");
  return {
    contractVersion: COMPACTION_CHECKPOINT_CONTRACT,
    checkpointId: requiredText(checkpointId, "checkpointId"),
    sessionId: session.sessionId,
    routeDigest: session.routeDigest,
    revision,
    sourceSessionRevision: session.revision,
    coveredFromSeq: 1,
    coveredThroughSeq,
    retainTailFromSeq,
    summary: summary.slice(0, 24_000),
    evidenceRefs: normalizeEvidenceRefs(product.evidenceRefs),
    createdAt: new Date(now()).toISOString(),
  };
}

function validateCheckpoint(value = {}) {
  if (value.contractVersion !== COMPACTION_CHECKPOINT_CONTRACT) throw checkpointError("checkpoint_contract_invalid");
  requiredText(value.checkpointId, "checkpointId");
  requiredText(value.sessionId, "sessionId");
  requiredText(value.routeDigest, "routeDigest");
  positiveInteger(value.revision, "revision");
  positiveInteger(value.sourceSessionRevision, "sourceSessionRevision");
  if (value.coveredFromSeq !== 1) throw checkpointError("checkpoint_coverage_not_contiguous");
  const coveredThroughSeq = positiveInteger(value.coveredThroughSeq, "coveredThroughSeq");
  if (value.retainTailFromSeq !== coveredThroughSeq + 1) throw checkpointError("checkpoint_coverage_not_contiguous");
  if (!String(value.summary || "").trim()) throw checkpointError("checkpoint_product_empty");
  return structuredClone(value);
}

function normalizeEvidenceRefs(value = []) {
  if (!Array.isArray(value)) throw checkpointError("checkpoint_evidence_refs_invalid");
  return value.slice(0, 128).map((item) => {
    if (item?.contractVersion !== "evidence-ref.v1") throw checkpointError("checkpoint_evidence_ref_invalid");
    return structuredClone(item);
  });
}

function assertDependencies({ sessionRepository, store }) {
  if (typeof sessionRepository?.readSession !== "function" || typeof sessionRepository?.readTranscript !== "function") {
    throw checkpointError("checkpoint_session_repository_invalid");
  }
  if (store?.contractVersion !== "compaction-checkpoint-store.v1" ||
    typeof store.readCheckpoint !== "function" ||
    typeof store.compareAndSwapCheckpoint !== "function" ||
    typeof store.deleteCheckpoint !== "function") {
    throw checkpointError("checkpoint_store_invalid");
  }
}

function positiveInteger(value, label) {
  if (!Number.isInteger(value) || value < 1) throw checkpointError(`${label}_invalid`);
  return value;
}

function requiredText(value, label) {
  const result = String(value || "").trim();
  if (!result) throw checkpointError(`${label}_required`);
  return result.slice(0, 240);
}

function checkpointError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

export {
  COMPACTION_CHECKPOINT_CONTRACT,
  createCompactionCheckpointRepository,
  createMemoryCompactionCheckpointStore,
};
