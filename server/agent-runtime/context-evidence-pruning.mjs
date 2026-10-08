import crypto from "node:crypto";

const EVIDENCE_REF_CONTRACT = "evidence-ref.v1";

function pruneTranscriptForContext({
  entries = [],
  policy,
  sessionId = "",
} = {}) {
  const effectivePolicy = normalizePolicy(policy);
  const groups = groupTranscriptEntries(entries);
  const toolGroups = groups.filter((group) => group.type === "toolPair");
  const retainedToolGroupIds = new Set(
    effectivePolicy.retainRecentToolPairs > 0
      ? toolGroups.slice(-effectivePolicy.retainRecentToolPairs).map((group) => group.id)
      : [],
  );
  const contextEntries = [];
  const evidenceRefs = [];

  for (const group of groups) {
    if (group.type !== "toolPair" || retainedToolGroupIds.has(group.id)) {
      contextEntries.push(...group.entries.map(copy));
      continue;
    }
    evidenceRefs.push(toEvidenceRef(group, { sessionId }));
  }

  return {
    contractVersion: "context-pruning-result.v1",
    contextEntries,
    evidenceRefs,
    sourceEntryCount: entries.length,
    retainedEntryCount: contextEntries.length,
    prunedEntryCount: entries.length - contextEntries.length,
  };
}

function groupTranscriptEntries(entries = []) {
  if (!Array.isArray(entries)) throw contextError("transcript_entries_invalid");
  const groups = [];
  const toolCallGroups = new Map();
  for (const entry of entries) {
    const safe = copy(entry);
    if (safe?.type === "message") {
      groups.push({ id: `message:${safe.seq}`, type: "message", entries: [safe] });
      continue;
    }
    if (safe?.type === "toolCall") {
      const callId = requiredText(safe.toolCall?.callId, "tool callId");
      const group = { id: `tool:${callId}`, type: "toolPair", entries: [safe] };
      toolCallGroups.set(callId, group);
      groups.push(group);
      continue;
    }
    if (safe?.type === "toolResult") {
      const callId = requiredText(safe.toolResult?.callId, "tool result callId");
      const group = toolCallGroups.get(callId);
      if (!group) throw contextError("tool_result_without_call");
      if (group.entries.some((item) => item.type === "toolResult")) throw contextError("tool_result_duplicate");
      group.entries.push(safe);
      continue;
    }
    throw contextError("transcript_entry_type_invalid");
  }
  if (groups.some((group) => group.type === "toolPair" && group.entries.length !== 2)) {
    throw contextError("tool_pair_incomplete");
  }
  return groups;
}

function toEvidenceRef(group, { sessionId }) {
  const call = group.entries[0]?.toolCall || {};
  const result = group.entries[1]?.toolResult || {};
  const sourceEntryIds = group.entries.map((entry) => requiredText(entry.entryId, "entryId"));
  const sourceSeq = group.entries.map((entry) => requiredInteger(entry.seq, "entry seq"));
  const toolId = requiredText(call.toolId || result.toolId, "toolId");
  const digest = crypto.createHash("sha256").update(JSON.stringify({
    sessionId,
    sourceEntryIds,
    toolId,
    status: cleanText(result.status),
    summary: cleanText(result.safeSummary || result.summary),
  })).digest("hex");
  return {
    contractVersion: EVIDENCE_REF_CONTRACT,
    evidenceId: `evidence-${digest.slice(0, 24)}`,
    source: {
      sessionId: requiredText(sessionId, "sessionId"),
      entryIds: sourceEntryIds,
      fromSeq: Math.min(...sourceSeq),
      throughSeq: Math.max(...sourceSeq),
    },
    kind: "tool-result-summary",
    toolId,
    status: cleanText(result.status),
    summary: cleanText(result.safeSummary || result.summary),
    contentDigest: digest,
    authorization: "resolve_at_request_time",
  };
}

function normalizePolicy(value = {}) {
  if (value?.contractVersion !== "context-pruning-policy.v1") throw contextError("context_pruning_policy_invalid");
  const retainRecentToolPairs = Number(value.retainRecentToolPairs);
  if (!Number.isInteger(retainRecentToolPairs) || retainRecentToolPairs < 0) {
    throw contextError("context_pruning_policy_invalid");
  }
  return { retainRecentToolPairs };
}

function requiredInteger(value, label) {
  if (!Number.isInteger(value) || value < 1) throw contextError(`${label.replace(/\s+/g, "_")}_invalid`);
  return value;
}

function requiredText(value, label) {
  const result = String(value || "").trim();
  if (!result) throw contextError(`${label.replace(/\s+/g, "_")}_required`);
  return result.slice(0, 240);
}

function cleanText(value = "") {
  return String(value || "").replace(/\s+/g, " ").trim().slice(0, 1_200);
}

function copy(value) {
  return value === undefined ? undefined : structuredClone(value);
}

function contextError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

export {
  EVIDENCE_REF_CONTRACT,
  groupTranscriptEntries,
  pruneTranscriptForContext,
};
