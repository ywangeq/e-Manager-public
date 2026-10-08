export function capabilityRequestReviewHash(requestId = "") {
  return requestId ? `#business-system-review/request/${encodeURIComponent(requestId)}` : "#business-system-review";
}

export function focusedCapabilityRequestIdFromHash(hash = "") {
  const route = String(hash || "").replace(/^#\/?/, "");
  const match = route.match(/^business-system-review\/request\/(.+)$/);
  if (!match?.[1]) return "";
  try {
    return decodeURIComponent(match[1]).trim();
  } catch {
    return "";
  }
}

export function capabilityReviewDecisionResult(decision = null) {
  if (!decision?.decision) return null;
  return {
    decision: decision.decision,
    status: decision.status || (decision.decision === "approved" ? "已通过审核" : "已退回补充"),
    summary: decision.summary,
    nextGate: decision.nextGate,
    decidedAt: decision.decidedAt ? new Date(decision.decidedAt).toLocaleString("zh-CN", { hour12: false }) : "",
  };
}

export function capabilityReviewResultForRequest(request = {}, localResults = {}) {
  return localResults[request.id] || capabilityReviewDecisionResult(request.reviewDecision);
}

export function isTerminalCapabilityReviewDecision(result = null) {
  return ["approved", "rejected"].includes(result?.decision);
}

export function isPendingCapabilityReview(request = {}, localResults = {}) {
  if (isTerminalCapabilityReviewDecision(capabilityReviewResultForRequest(request, localResults))) return false;
  const status = String(request.status || "");
  return status.includes("待") || status.includes("AI 预审") || status.includes("评审") || status.includes("审核");
}
