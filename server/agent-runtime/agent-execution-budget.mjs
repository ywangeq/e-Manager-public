// Server-owned per-turn limits, persisted with the canonical encrypted input.
// This bounds continuation using reported usage, not Provider billing itself.
export function normalizeAgentExecutionBudget(value) {
  if (value == null) return null;
  if (typeof value !== "object" || Array.isArray(value) ||
      Object.keys(value).some(key => key !== "maxTotalTokens") ||
      !Number.isSafeInteger(value.maxTotalTokens) || value.maxTotalTokens < 1 || value.maxTotalTokens > 2_000_000) {
    const error = new Error("agent_execution_budget_invalid"); error.code = error.message; throw error;
  }
  return Object.freeze({ maxTotalTokens: value.maxTotalTokens });
}
