import { createContextEngine as createFoundationEngine, normalizeCapability } from "./context-engine.mjs";
import { groupTranscriptEntries } from "./context-evidence-pruning.mjs";

// Runtime working-set policy composes the existing foundation. Keep capability
// validation and persisted checkpoint contracts byte-compatible for rollback.
function createContextEngine({ estimators = {} } = {}) {
  const foundation = createFoundationEngine({ estimators });
  function assemble(options = {}) {
    const capability = normalizeCapability(options.capability);
    const mandatory = foundation.assemble({ ...options, checkpoint: null, transcriptEntries: [],
      evidenceItems: [], providerContinuationItems: [] });
    if (mandatory.status === "degraded") return mandatory;
    const requested = options.historyBudgetTokens ?? 32_000;
    if (!Number.isSafeInteger(requested) || requested < 1) throw new TypeError("historyBudgetTokens_invalid");
    const { inputBudgetTokens, mandatoryTokens } = mandatory.budget;
    const historyBudgetTokens = Math.min(requested, inputBudgetTokens - mandatoryTokens);
    const reserves = Object.values(capability.reserve).reduce((sum, value) => sum + value, 0);
    const result = foundation.assemble({ ...options, capability: {
      ...capability, contextWindowTokens: reserves + mandatoryTokens + historyBudgetTokens,
    } });
    const budget = { ...result.budget, inputBudgetTokens, historyBudgetTokens,
      remainingTokens: Math.max(0, inputBudgetTokens - (result.budget.usedTokens || mandatoryTokens)) };
    // Foundation may report assembled after dropping post-checkpoint items.
    // None of that window can be used until every omission is summarized.
    if (result.status === "compact_required" || result.omittedItemCount > 0 ||
      result.reason === "context_checkpoint_budget_exceeded") {
      return { ...result, capability, budget, items: [], status: "compact_required",
        reason: "context_transcript_over_budget", compactRequest: {
          ...result.compactRequest, contractVersion: "context-compaction-request.v1",
          sourceEntryCount: options.transcriptEntries?.length || 0, historyBudgetTokens,
        } };
    }
    if (!/^assembled/.test(result.status)) return { ...result, capability, budget };
    const items = result.items;
    const fixed = items.filter((item) => ["fixed", "governance", "current_turn"].includes(item.source));
    const checkpoint = items.filter((item) => item.source === "checkpoint");
    const tail = items.filter((item) => !["fixed", "governance", "current_turn", "checkpoint"].includes(item.source));
    return { ...result, capability, budget, items: [...fixed, ...checkpoint, ...tail] };
  }

  async function compact(options = {}) {
    const { capability, historyBudgetTokens, policy, summarize } = options;
    if (!capability || !Number.isSafeInteger(historyBudgetTokens) || historyBudgetTokens <= 0) {
      return foundation.compact(options);
    }
    const normalized = normalizeCapability(capability);
    const estimate = typeof estimators.resolve === "function"
      ? estimators.resolve(normalized.estimatorId) : estimators[normalized.estimatorId];
    const degraded = (reason) => ({ contractVersion: "context-engine.v1", status: "degraded", reason, items: [] });
    if (typeof estimate !== "function") return degraded("context_token_estimator_unavailable");
    if (policy?.contractVersion !== "context-compaction-policy.v1" ||
      !Number.isInteger(policy.retainTailGroups) || policy.retainTailGroups < 1) {
      throw new TypeError("context_compaction_policy_invalid");
    }
    const groups = groupTranscriptEntries(options.transcriptEntries || []);
    const tailBudget = Math.floor(historyBudgetTokens / 2);
    let tailTokens = 0;
    let retainTailGroups = 0;
    for (const group of groups.slice(-policy.retainTailGroups).reverse()) {
      const tokens = estimate(group.entries.map((entry) => ({
        contextKey: `transcript:${entry.entryId}`, source: "transcript", value: entry,
      })));
      if (!Number.isSafeInteger(tokens) || tokens < 0) throw new TypeError("context_token_estimate_invalid");
      if (tailTokens + tokens > tailBudget) break;
      tailTokens += tokens;
      retainTailGroups++;
    }
    if (!retainTailGroups) return degraded("context_recent_group_over_budget");
    const summaryBudgetTokens = Math.max(1, Math.min(4096, Math.floor(historyBudgetTokens / 4)));
    return foundation.compact({ ...options, policy: { ...policy, retainTailGroups },
      summarize: typeof summarize === "function" ? (source) => summarize({ ...source, summaryBudgetTokens }) : summarize });
  }
  return { ...foundation, assemble, compact };
}

export { createContextEngine };
