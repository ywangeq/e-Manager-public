function normalizeExternalEmployeeDeclaration(value = {}) {
  const declaration = {
    name: text(value.name),
    title: text(value.title),
    objective: text(value.objective),
    configuredFunctions: structuredList(value.configuredFunctions, normalizeConfiguredFunction),
    responsibilityAssignments: normalizeResponsibilityAssignments(value.responsibilityAssignments),
    identityBoundaries: list(value.identityBoundaries),
    identitySourceRefs: list(value.identitySourceRefs),
    rules: list(value.rules),
    tools: list(value.tools),
    promptMetadata: normalizePromptMetadata(value.promptMetadata),
    outputContract: text(value.outputContract),
    writebackBoundary: text(value.writebackBoundary),
    uiDisplayContract: normalizeUiDisplayContract(value.uiDisplayContract),
    runtimeBinding: normalizeRuntimeBinding(value.runtimeBinding),
    taskModelBindings: structuredList(value.taskModelBindings, normalizeTaskModelBinding),
    toolBindings: structuredList(value.toolBindings, normalizeToolBinding),
    scheduleBindings: structuredList(value.scheduleBindings, normalizeScheduleBinding),
    source: text(value.source || "external_employee_declaration"),
  };
  const hasDeclaration = Object.entries(declaration).some(([key, item]) => (
    key !== "source" && (Array.isArray(item) ? item.length > 0 : item && typeof item === "object" ? Object.keys(item).length > 0 : Boolean(item))
  ));
  return hasDeclaration ? declaration : null;
}

function normalizeResponsibilityAssignments(value = {}) {
  if (!value || typeof value !== "object") return {};
  const assignments = {
    contractVersion: value.contractVersion === "digital-employee-responsibility.v1"
      ? value.contractVersion
      : "digital-employee-responsibility.v1",
    businessOwner: normalizeResponsibilityAssignment(value.businessOwner),
    technicalOwner: normalizeResponsibilityAssignment(value.technicalOwner),
    qualityReviewer: normalizeResponsibilityAssignment(value.qualityReviewer),
    alertReceiver: normalizeResponsibilityAssignment(value.alertReceiver),
  };
  if (![assignments.businessOwner, assignments.technicalOwner, assignments.qualityReviewer, assignments.alertReceiver].some(Boolean)) {
    return {};
  }
  return compact(assignments);
}

function normalizeResponsibilityAssignment(value = {}) {
  if (!value || typeof value !== "object") return null;
  const departmentId = identifier(value.departmentId);
  const departmentName = text(value.departmentName);
  const assigneeType = ["user", "group"].includes(identifier(value.assigneeType)) ? identifier(value.assigneeType) : "";
  const assigneeId = identifier(value.assigneeId);
  const assigneeName = text(value.assigneeName);
  if (!departmentId && !departmentName) return null;
  const assigned = Boolean(assigneeType && assigneeId && assigneeName);
  return compact({
    departmentId,
    departmentName,
    assigneeType: assigned ? assigneeType : "",
    assigneeId: assigned ? assigneeId : "",
    assigneeName: assigned ? assigneeName : "",
    status: assigned ? "assigned" : "pending_human_assignment",
    requiredBeforeOnline: value.requiredBeforeOnline !== false,
  });
}

function normalizeConfiguredFunction(value = {}) {
  const id = identifier(value.id || value.functionId || value.name);
  if (!id) return null;
  return { id, name: text(value.name || id), description: text(value.description) };
}

function normalizePromptMetadata(value = {}) {
  if (!value || typeof value !== "object") return {};
  if (!Object.keys(value).length) return {};
  const result = {
    version: text(value.version || value.promptVersion),
    digest: digest(value.digest || value.promptDigest || value.promptHash),
    owner: text(value.owner),
    rollbackVersion: text(value.rollbackVersion),
    rawPromptStored: false,
  };
  return compact(result);
}

function normalizeUiDisplayContract(value = {}) {
  if (!value || typeof value !== "object") return {};
  if (!Object.keys(value).length) return {};
  return compact({
    channelNeutral: value.channelNeutral !== false,
    primarySurface: text(value.primarySurface),
    channelRole: text(value.channelRole),
  });
}

function normalizeRuntimeBinding(value = {}) {
  if (!value || typeof value !== "object") return {};
  return compact({
    runtimeAdapter: normalizeRuntimeAdapterId(value.runtimeAdapter),
    agentRuntimeId: normalizeAgentRuntimeId(value.agentRuntimeId),
    workerLane: identifier(value.workerLane),
    credentialLeasePolicy: identifier(value.credentialLeasePolicy),
    requiredResourceIds: list(value.requiredResourceIds).map(identifier).filter(Boolean),
  });
}

function normalizeRuntimeAdapterId(value = "") {
  const runtimeAdapter = identifier(value);
  if (["openclaw-shared", "responses-api"].includes(runtimeAdapter)) return "responses_api";
  return runtimeAdapter;
}

function normalizeAgentRuntimeId(value = "") {
  const agentRuntimeId = identifier(value);
  return agentRuntimeId === "shared-openclaw-runtime" ? "shared-agent-runtime" : agentRuntimeId;
}

function normalizeTaskModelBinding(value = {}) {
  const taskId = identifier(value.taskId);
  if (!taskId) return null;
  return compact({
    taskId,
    modelId: identifier(value.modelId),
    providerRouteId: identifier(value.providerRouteId),
    model: text(value.model),
    modelLevelId: identifier(value.modelLevelId),
    requiredCapabilityProfileVersion: identifier(value.requiredCapabilityProfileVersion),
  });
}

function normalizeToolBinding(value = {}) {
  const toolId = identifier(value.toolId);
  if (!toolId) return null;
  return compact({
    id: identifier(value.id || value.bindingId || toolId),
    toolId,
    operationIds: list(value.operationIds).map(identifier).filter(Boolean),
    actions: list(value.actions).map(identifier).filter(Boolean),
    risks: list(value.risks).map(identifier).filter(Boolean),
    policyMode: value.policyMode === "contract_capability" ? value.policyMode : "",
    allowedCapabilities: list(value.allowedCapabilities).map(identifier).filter(Boolean),
    allowedRisks: list(value.allowedRisks)
      .map(identifier)
      .filter((risk) => ["controlled_write", "high_impact_write", "destructive_write"].includes(risk)),
    contractDigest: digest(value.contractDigest),
    approvedWritePolicyDigests: normalizeApprovedWritePolicyDigests(value.approvedWritePolicyDigests),
    scope: list(value.scope),
    writebackBoundary: text(value.writebackBoundary),
    reviewGate: text(value.reviewGate),
    requiredForProduction: optionalBoolean(value.requiredForProduction),
    enabled: false,
    status: "pending_action_review",
  });
}

function normalizeApprovedWritePolicyDigests(value = {}) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.fromEntries(Object.entries(value).map(([capability, valueDigest]) => [
    identifier(capability),
    digest(valueDigest),
  ]).filter(([capability, valueDigest]) => capability && valueDigest));
}

function normalizeScheduleBinding(value = {}) {
  const id = identifier(value.id || value.scheduleId);
  if (!id) return null;
  return compact({
    id,
    triggerMode: identifier(value.triggerMode),
    schedule: text(value.schedule),
    timezone: text(value.timezone),
    taskId: identifier(value.taskId),
    taskDefinitionVersion: boundedNumber(value.taskDefinitionVersion, 1, Number.MAX_SAFE_INTEGER),
    timeoutSeconds: boundedNumber(value.timeoutSeconds, 1, 86400),
    maxConcurrentRuns: boundedNumber(value.maxConcurrentRuns, 1, 100),
    overlapWindowMinutes: boundedNumber(value.overlapWindowMinutes, 0, 1440),
    idempotencyKeyContract: text(value.idempotencyKeyContract),
    resultContract: text(value.resultContract),
    reviewGate: text(value.reviewGate),
    requiredForProduction: optionalBoolean(value.requiredForProduction),
    enabled: false,
    status: "pending_schedule_review",
  });
}

function structuredList(value, normalize) {
  return (Array.isArray(value) ? value : []).map(normalize).filter(Boolean).slice(0, 100);
}

function list(value) {
  const items = Array.isArray(value) ? value : value ? [value] : [];
  return [...new Set(items.map(text).filter(Boolean))].slice(0, 100);
}

function identifier(value = "") {
  const result = String(value || "").trim();
  return /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,159}$/.test(result) ? result : "";
}

function digest(value = "") {
  const result = text(value);
  return /^(sha256:)?[a-f0-9]{64}$/i.test(result) ? result : "";
}

function text(value = "") {
  return String(value || "").replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, 2000);
}

function boundedNumber(value, minimum, maximum) {
  if (value === "" || value === null || value === undefined) return undefined;
  const number = Number(value);
  if (!Number.isFinite(number)) return undefined;
  return Math.min(maximum, Math.max(minimum, Math.round(number)));
}

function optionalBoolean(value) {
  return typeof value === "boolean" ? value : undefined;
}

function compact(value) {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => (
    Array.isArray(item) ? item.length > 0 : item !== "" && item !== undefined && item !== null
  )));
}

export { normalizeAgentRuntimeId, normalizeExternalEmployeeDeclaration, normalizeRuntimeAdapterId };
