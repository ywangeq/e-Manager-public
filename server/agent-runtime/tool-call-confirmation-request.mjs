const CONTRACT_VERSION = "tool-call-confirmation.v1";
const SENSITIVE_KEY = /authorization|bearer|token|password|secret|credential|cookie|api[-_]?key/i;

function toolConfirmationRequestsFromRuntime(runtime = {}) {
  const seen = new Set();
  return (Array.isArray(runtime.toolCalls) ? runtime.toolCalls : []).flatMap((call) => {
    const request = normalizeToolConfirmationRequest(call?.result?.confirmationRequest);
    if (!request || seen.has(request.id)) return [];
    seen.add(request.id);
    return [request];
  }).slice(0, 4);
}

function normalizeToolConfirmationRequest(value = null) {
  if (!plainObject(value) || value.contractVersion !== CONTRACT_VERSION) return null;
  const id = cleanText(value.id, 120);
  const toolId = cleanText(value.toolId, 120);
  const operationId = cleanText(value.operationId, 160);
  const expiresAt = validTimestamp(value.expiresAt);
  if (!id || !toolId || !operationId || !expiresAt) return null;
  return {
    contractVersion: CONTRACT_VERSION,
    id,
    status: "pending",
    displayName: cleanText(value.displayName || operationId, 120),
    toolId,
    operationId,
    action: cleanText(value.action, 120),
    risk: cleanText(value.risk, 80),
    scope: cleanList(value.scope, 20),
    writebackBoundary: cleanText(value.writebackBoundary, 240),
    argumentSummary: safeValue(value.argumentSummary),
    issuedAt: validTimestamp(value.issuedAt),
    expiresAt,
  };
}

function normalizeApprovedToolConfirmation(value = null) {
  if (!plainObject(value)) return null;
  const id = cleanText(value.id, 120);
  return value.contractVersion === CONTRACT_VERSION && value.decision === "approved" && id
    ? { contractVersion: CONTRACT_VERSION, id, decision: "approved" }
    : null;
}

function safeValue(value, depth = 0) {
  if (depth > 5) return "[truncated]";
  if (Array.isArray(value)) return value.slice(0, 20).map((item) => safeValue(item, depth + 1));
  if (!plainObject(value)) return typeof value === "string" ? cleanText(value, 500) : value;
  return Object.fromEntries(Object.entries(value).slice(0, 40).map(([key, item]) => [
    cleanText(key, 120),
    SENSITIVE_KEY.test(key) ? "[redacted]" : safeValue(item, depth + 1),
  ]));
}

function cleanList(value, maxItems) {
  return [...new Set((Array.isArray(value) ? value : []).map((item) => cleanText(item, 120)).filter(Boolean))].slice(0, maxItems);
}

function validTimestamp(value) {
  const text = cleanText(value, 40);
  return text && Number.isFinite(Date.parse(text)) ? new Date(text).toISOString() : "";
}

function cleanText(value = "", maxLength = 500) {
  return String(value || "").replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, maxLength);
}

function plainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export {
  CONTRACT_VERSION as TOOL_CALL_CONFIRMATION_REQUEST_CONTRACT_VERSION,
  normalizeApprovedToolConfirmation,
  normalizeToolConfirmationRequest,
  toolConfirmationRequestsFromRuntime,
};
