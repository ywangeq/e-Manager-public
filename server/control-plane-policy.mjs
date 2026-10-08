import { aiModelLevels } from "../src/data/catalog.js";

export function evaluateInvocationRequest(policy, input, helpers = {}) {
  const cleanText = helpers.cleanText || defaultCleanText;
  const callerSystemId = cleanText(input.callerSystemId || input.sourceSystemId || input.systemId);
  const departmentId = cleanText(input.departmentId);
  const businessDomain = cleanText(input.businessDomain);
  const skillId = cleanText(input.skillId);
  const action = cleanText(input.action || "read");
  const requestedModelId = cleanText(input.modelId || input.requestedModelId);
  const requestedModelLevelId = cleanText(input.modelLevelId || input.requestedModelLevelId);
  const confidence = numberOr(input.confidence, undefined);
  const usage = { ...policy.currentSignals, ...(input.currentUsage || {}) };
  const quality = { ...policy.currentSignals, ...(input.qualitySignals || {}) };
  const triggeredThresholds = [];

  if (!policy.allowedCallers?.includes(callerSystemId)) {
    triggeredThresholds.push(invocationThreshold("callerSystemId", policy.allowedCallers, callerSystemId, "rejected"));
  }
  if (!policy.allowedDepartments?.includes(departmentId)) {
    triggeredThresholds.push(invocationThreshold("departmentId", policy.allowedDepartments, departmentId, "rejected"));
  }
  if (!policy.allowedBusinessDomains?.includes(businessDomain)) {
    triggeredThresholds.push(invocationThreshold("businessDomain", policy.allowedBusinessDomains, businessDomain, "rejected"));
  }
  if (policy.deniedActions?.includes(action)) {
    triggeredThresholds.push(invocationThreshold("deniedActions", "not in deniedActions", action, "rejected"));
  } else if (!policy.allowedActions?.includes(action)) {
    triggeredThresholds.push(invocationThreshold("allowedActions", policy.allowedActions, action, "rejected"));
  }

  if (requestedModelId && !policy.modelLimits.allowedModelIds?.includes(requestedModelId)) {
    triggeredThresholds.push(invocationThreshold("modelId", policy.modelLimits.allowedModelIds, requestedModelId, "blocked"));
  }
  if (requestedModelLevelId && compareModelLevel(requestedModelLevelId, policy.modelLimits.maxModelLevelId) > 0) {
    triggeredThresholds.push(invocationThreshold("modelLevelId", `<= ${policy.modelLimits.maxModelLevelId}`, requestedModelLevelId, "blocked"));
  }

  addMaxThreshold(triggeredThresholds, "maxDailyCalls", usage.callsToday, policy.resourceThresholds.maxDailyCalls, "queued");
  addMaxThreshold(triggeredThresholds, "maxHourlyCalls", usage.callsThisHour, policy.resourceThresholds.maxHourlyCalls, "queued");
  addMaxThreshold(triggeredThresholds, "maxConcurrentRuns", usage.concurrentRuns, policy.resourceThresholds.maxConcurrentRuns, "queued");
  addMaxThreshold(triggeredThresholds, "monthlyBudgetCny", usage.monthlySpendCny, policy.resourceThresholds.monthlyBudgetCny, "queued");

  addMinThreshold(triggeredThresholds, "minEvalPassRate", quality.evalPassRate, policy.qualityThresholds.minEvalPassRate, "blocked");
  addMaxThreshold(triggeredThresholds, "maxOpenP0P1Badcases", quality.openP0P1Badcases, policy.qualityThresholds.maxOpenP0P1Badcases, "blocked", true);
  addMaxThreshold(triggeredThresholds, "maxFailureRate7d", quality.failureRate7d, policy.qualityThresholds.maxFailureRate7d, "blocked");
  if (action.includes("writeback")) {
    addMinThreshold(
      triggeredThresholds,
      "minHumanReviewRateForWriteback",
      quality.humanReviewRateForWriteback,
      policy.qualityThresholds.minHumanReviewRateForWriteback,
      "human_review_required",
    );
  }

  if (confidence !== undefined && action === "draft" && confidence < policy.confidenceThresholds.minConfidenceForDraft) {
    triggeredThresholds.push(invocationThreshold("minConfidenceForDraft", policy.confidenceThresholds.minConfidenceForDraft, confidence, "human_review_required"));
  }
  if (confidence !== undefined && action.includes("writeback") && confidence < policy.confidenceThresholds.minConfidenceForWriteback) {
    triggeredThresholds.push(invocationThreshold("minConfidenceForWriteback", policy.confidenceThresholds.minConfidenceForWriteback, confidence, "human_review_required"));
  }

  const status = invocationStatus(triggeredThresholds);
  return {
    status,
    outcome: invocationOutcome(policy, status),
    reason: status === "allowed" ? "all_thresholds_passed" : "thresholds_triggered",
    requested: {
      callerSystemId,
      departmentId,
      businessDomain,
      skillId,
      action,
      modelId: requestedModelId,
      modelLevelId: requestedModelLevelId,
      confidence,
    },
    triggeredThresholds,
    nextGate: invocationNextGate(status),
  };
}

function invocationStatus(triggeredThresholds) {
  const outcomes = triggeredThresholds.map((item) => item.outcome);
  if (outcomes.includes("rejected")) return "rejected";
  if (outcomes.includes("blocked")) return "blocked";
  if (outcomes.includes("queued")) return "queued";
  if (outcomes.includes("human_review_required")) return "human_review_required";
  return "allowed";
}

function invocationOutcome(policy, status) {
  if (status === "allowed") return "execute_or_continue";
  if (status === "queued") return policy.fallback.quotaExceeded;
  if (status === "blocked") return policy.fallback.qualityGateFailed;
  if (status === "human_review_required") return policy.fallback.lowConfidence;
  return policy.fallback.unauthorizedCaller;
}

function invocationNextGate(status) {
  return {
    allowed: "runtime may execute within the approved model/resource lease",
    queued: "resource scheduler waits for quota or concurrency capacity",
    blocked: "quality owner must resolve badcase/eval/model gate before execution",
    human_review_required: "business owner must review before writeback or downstream action",
    rejected: "platform rejects the call and records a governance event",
  }[status];
}

function invocationThreshold(name, expected, actual, outcome) {
  return { name, expected, actual, outcome };
}

function addMaxThreshold(target, name, actualValue, maxValue, outcome, inclusive = false) {
  const actual = numberOr(actualValue, undefined);
  const max = numberOr(maxValue, undefined);
  if (actual === undefined || max === undefined) return;
  if (inclusive ? actual > max : actual >= max) {
    target.push(invocationThreshold(name, inclusive ? `<= ${max}` : `< ${max}`, actual, outcome));
  }
}

function addMinThreshold(target, name, actualValue, minValue, outcome) {
  const actual = numberOr(actualValue, undefined);
  const min = numberOr(minValue, undefined);
  if (actual === undefined || min === undefined) return;
  if (actual < min) target.push(invocationThreshold(name, `>= ${min}`, actual, outcome));
}

function compareModelLevel(actualLevelId, maxLevelId) {
  const order = aiModelLevels.map((level) => level.id);
  const actualIndex = order.indexOf(actualLevelId);
  const maxIndex = order.indexOf(maxLevelId);
  if (actualIndex === -1 || maxIndex === -1) return 1;
  return actualIndex - maxIndex;
}

function numberOr(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function defaultCleanText(value) {
  return String(value || "").replace(/\s+/g, " ").trim().slice(0, 800);
}
