import { groupTranscriptEntries } from "./context-evidence-pruning.mjs";

const CONTEXT_ENGINE_CONTRACT = "context-engine.v1";
const PROVIDER_CONTEXT_CAPABILITY_CONTRACT = "provider-context-capability.v1";

function createContextEngine({ estimators = {} } = {}) {
  function ingest({ transcriptEntries = [] } = {}) {
    const groups = groupTranscriptEntries(transcriptEntries);
    return {
      contractVersion: CONTEXT_ENGINE_CONTRACT,
      status: "ingested",
      sourceEntryCount: transcriptEntries.length,
      groups,
    };
  }

  function assemble({
    capability,
    checkpoint = null,
    currentTurnItems = [],
    evidenceItems = [],
    fixedItems = [],
    governanceItems = [],
    providerContinuationItems = [],
    toolDefinitions = [],
    transcriptEntries = [],
  } = {}) {
    const safeCapability = normalizeCapability(capability);
    const estimate = resolveEstimator(estimators, safeCapability.estimatorId);
    if (typeof estimate !== "function") return degraded("context_token_estimator_unavailable", safeCapability);
    const reserves = Object.values(safeCapability.reserve).reduce((total, value) => total + value, 0);
    const inputBudgetTokens = safeCapability.contextWindowTokens - reserves;
    if (inputBudgetTokens <= 0) return degraded("context_reserve_exhausts_window", safeCapability);

    const mandatory = [
      ...normalizeItems(fixedItems, "fixed"),
      ...normalizeItems(governanceItems, "governance"),
      ...normalizeItems(currentTurnItems, "current_turn"),
    ];
    const mandatoryTokens = estimateTokens(estimate, { items: mandatory, tools: toolDefinitions });
    if (mandatoryTokens > inputBudgetTokens) {
      return degraded("context_fixed_budget_exceeded", safeCapability, { inputBudgetTokens, mandatoryTokens });
    }

    const groups = contextGroups({ checkpoint, evidenceItems, providerContinuationItems, transcriptEntries });
    const selected = [];
    let usedTokens = mandatoryTokens;
    const checkpointGroup = groups.find((group) => group.kind === "checkpoint");
    if (checkpointGroup) {
      const checkpointTokens = estimateTokens(estimate, checkpointGroup.items);
      if (usedTokens + checkpointTokens > inputBudgetTokens) {
        return degraded("context_checkpoint_budget_exceeded", safeCapability, { inputBudgetTokens, mandatoryTokens });
      }
      selected.push(...checkpointGroup.items);
      usedTokens += checkpointTokens;
    }
    const optionalGroups = groups.filter((group) => group !== checkpointGroup);
    for (let index = optionalGroups.length - 1; index >= 0; index -= 1) {
      const group = optionalGroups[index];
      const tokens = estimateTokens(estimate, group.items);
      if (usedTokens + tokens > inputBudgetTokens) continue;
      selected.unshift(...group.items);
      usedTokens += tokens;
    }
    const selectedKeys = new Set(selected.map((item) => item.contextKey));
    const omitted = groups.flatMap((group) => group.items).filter((item) => !selectedKeys.has(item.contextKey));
    if (omitted.length && !checkpoint) {
      return {
        contractVersion: CONTEXT_ENGINE_CONTRACT,
        status: "compact_required",
        reason: "context_transcript_over_budget",
        capability: safeCapability,
        budget: budgetSummary({ inputBudgetTokens, mandatoryTokens, usedTokens }),
        compactRequest: {
          contractVersion: "context-compaction-request.v1",
          sourceEntryCount: transcriptEntries.length,
          omittedContextKeys: omitted.map((item) => item.contextKey),
        },
      };
    }
    return {
      contractVersion: CONTEXT_ENGINE_CONTRACT,
      status: omitted.length ? "assembled_with_checkpoint" : "assembled",
      reason: omitted.length ? "older_context_covered_or_pruned" : "within_budget",
      capability: safeCapability,
      budget: budgetSummary({ inputBudgetTokens, mandatoryTokens, usedTokens }),
      items: [...mandatory, ...selected].map(stripContextKey),
      omittedItemCount: omitted.length,
    };
  }

  async function compact({ policy, summarize, transcriptEntries = [] } = {}) {
    const groups = groupTranscriptEntries(transcriptEntries);
    const retainTailGroups = normalizeCompactionPolicy(policy).retainTailGroups;
    if (groups.length <= retainTailGroups) return degraded("context_compaction_tail_not_reached", null);
    const coveredGroups = groups.slice(0, groups.length - retainTailGroups);
    const coveredEntries = coveredGroups.flatMap((group) => group.entries);
    const retainedEntries = groups.slice(groups.length - retainTailGroups).flatMap((group) => group.entries);
    if (!coveredEntries.length || !retainedEntries.length) return degraded("context_compaction_tail_not_reached", null);
    if (typeof summarize !== "function") return degraded("context_compactor_unavailable", null);
    let product;
    try {
      product = await summarize({
        contractVersion: "context-compaction-source.v1",
        entries: structuredClone(coveredEntries),
        coveredFromSeq: coveredEntries[0].seq,
        coveredThroughSeq: coveredEntries.at(-1).seq,
      });
    } catch {
      return degraded("context_compaction_failed", null);
    }
    const summary = String(product?.summary || "").trim();
    if (!summary) return degraded("context_compaction_empty", null);
    return {
      contractVersion: CONTEXT_ENGINE_CONTRACT,
      status: "compacted",
      product: {
        coveredThroughSeq: coveredEntries.at(-1).seq,
        retainTailFromSeq: retainedEntries[0].seq,
        summary,
        evidenceRefs: Array.isArray(product?.evidenceRefs) ? structuredClone(product.evidenceRefs) : [],
      },
    };
  }

  function afterTurn({ assembled = {}, usage = {} } = {}) {
    return {
      contractVersion: CONTEXT_ENGINE_CONTRACT,
      status: "turn_recorded",
      contextStatus: String(assembled.status || ""),
      budget: structuredClone(assembled.budget || {}),
      usage: normalizeUsage(usage),
    };
  }

  return { afterTurn, assemble, compact, ingest };
}

function contextGroups({ checkpoint, evidenceItems, providerContinuationItems, transcriptEntries }) {
  const checkpointSeq = checkpoint?.contractVersion === "compaction-checkpoint.v1"
    ? Number(checkpoint.coveredThroughSeq || 0)
    : 0;
  const groups = [];
  if (checkpointSeq > 0 && String(checkpoint.summary || "").trim()) {
    groups.push({ kind: "checkpoint", items: [contextItem("checkpoint", checkpoint.checkpointId, {
      type: "compaction_summary",
      content: checkpoint.summary,
      source: { fromSeq: checkpoint.coveredFromSeq, throughSeq: checkpoint.coveredThroughSeq },
    })] });
  }
  for (const group of groupTranscriptEntries(transcriptEntries).filter((item) => Math.max(...item.entries.map((entry) => entry.seq)) > checkpointSeq)) {
    groups.push({ items: group.entries.map((entry) => contextItem("transcript", entry.entryId, entry)) });
  }
  const evidence = normalizeItems(evidenceItems, "evidence");
  if (evidence.length) groups.push({ items: evidence });
  const continuation = normalizeItems(providerContinuationItems, "provider_continuation");
  if (continuation.length) groups.push({ items: continuation });
  return groups;
}

function normalizeCapability(value = {}) {
  if (value?.contractVersion !== PROVIDER_CONTEXT_CAPABILITY_CONTRACT) {
    throw contextError("provider_context_capability_invalid");
  }
  const contextWindowTokens = positiveInteger(value.contextWindowTokens, "contextWindowTokens");
  const reserve = value.reserve || {};
  const normalizedReserve = Object.fromEntries([
    "instructionsTokens",
    "toolSchemaTokens",
    "reasoningTokens",
    "toolLoopTokens",
    "outputTokens",
  ].map((key) => [key, nonNegativeInteger(reserve[key], key)]));
  return {
    contractVersion: PROVIDER_CONTEXT_CAPABILITY_CONTRACT,
    profileVersion: requiredText(value.profileVersion, "profileVersion"),
    estimatorId: requiredText(value.estimatorId, "estimatorId"),
    contextWindowTokens,
    reserve: normalizedReserve,
  };
}

function normalizeCompactionPolicy(value = {}) {
  if (value?.contractVersion !== "context-compaction-policy.v1") throw contextError("context_compaction_policy_invalid");
  if (!Number.isInteger(value.retainTailGroups) || value.retainTailGroups < 1) {
    throw contextError("context_compaction_policy_invalid");
  }
  return { retainTailGroups: value.retainTailGroups };
}

function normalizeUsage(value = {}) {
  return Object.fromEntries(["inputTokens", "outputTokens", "totalTokens"].flatMap((key) => {
    const number = Number(value[key]);
    return Number.isFinite(number) && number >= 0 ? [[key, number]] : [];
  }));
}

function resolveEstimator(registry, estimatorId) {
  if (typeof registry?.resolve === "function") return registry.resolve(estimatorId);
  return registry?.[estimatorId];
}

function normalizeItems(value = [], source) {
  if (!Array.isArray(value)) throw contextError("context_items_invalid");
  return value.map((item, index) => contextItem(source, item?.contextKey || item?.id || index, item));
}

function contextItem(source, id, value) {
  return {
    contextKey: `${source}:${String(id)}`,
    source,
    value: structuredClone(value),
  };
}

function estimateTokens(estimator, value) {
  const tokens = Number(estimator(value));
  if (!Number.isInteger(tokens) || tokens < 0) throw contextError("context_token_estimate_invalid");
  return tokens;
}

function degraded(reason, capability, budget = {}) {
  return {
    contractVersion: CONTEXT_ENGINE_CONTRACT,
    status: "degraded",
    reason,
    capability,
    budget,
    items: [],
  };
}

function budgetSummary({ inputBudgetTokens, mandatoryTokens, usedTokens }) {
  return {
    inputBudgetTokens,
    mandatoryTokens,
    usedTokens,
    remainingTokens: Math.max(0, inputBudgetTokens - usedTokens),
  };
}

function stripContextKey(item) {
  const { contextKey: _contextKey, ...rest } = item;
  return rest;
}

function positiveInteger(value, label) {
  if (!Number.isInteger(value) || value < 1) throw contextError(`${label}_invalid`);
  return value;
}

function nonNegativeInteger(value, label) {
  if (!Number.isInteger(value) || value < 0) throw contextError(`${label}_invalid`);
  return value;
}

function requiredText(value, label) {
  const result = String(value || "").trim();
  if (!result) throw contextError(`${label}_required`);
  return result.slice(0, 240);
}

function contextError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

export {
  CONTEXT_ENGINE_CONTRACT,
  PROVIDER_CONTEXT_CAPABILITY_CONTRACT,
  createContextEngine,
  normalizeCapability,
};
