import crypto from "node:crypto";
import { configuredEmployeeProviderRouteId } from "./agent-runtime/employee-provider-route.mjs";

const DIGITAL_EMPLOYEE_MODEL_ASSIGNMENTS_CONTRACT_VERSION = "digital-employee-model-assignments.v1";
const MODEL_ASSIGNMENT_FIELDS = new Set([
  "assignmentId",
  "model",
  "modelId",
  "modelLevelId",
  "provider",
  "providerName",
  "providerRouteId",
  "requiredCapabilityProfileVersion",
  "roles",
  "status",
]);
const MODEL_ASSIGNMENT_REQUEST_FIELDS = new Set(["assignmentId", "modelId", "modelLevelId", "roles"]);
const MODEL_ASSIGNMENT_ROLE_FIELDS = new Set(["primary", "taskDefinitionIds"]);
const MODEL_ASSIGNMENT_SET_FIELDS = new Set([
  "appliedVersion",
  "assignmentDigest",
  "contractVersion",
  "items",
  "source",
]);
const INACTIVE_ROUTE_HEALTH = new Set(["disabled", "planned", "retired"]);

function createAppliedModelAssignments({
  aiModelCatalog = [],
  appliedVersion = 1,
  items = [],
  source = "canonical_runtime_config",
} = {}) {
  if (!Array.isArray(items)) throw assignmentError("digital_employee_model_assignments_items_invalid");
  const normalizedItems = items.map((item) => assignmentFromCatalog(item, aiModelCatalog));
  return finalizeAssignmentSet({ appliedVersion, items: normalizedItems, source });
}

function normalizeAppliedModelAssignments(value, { aiModelCatalog = [] } = {}) {
  requirePlainObject(value, "digital_employee_model_assignments_invalid");
  rejectUnknownFields(value, MODEL_ASSIGNMENT_SET_FIELDS, "digital_employee_model_assignments_unknown_field");
  if (value.contractVersion !== DIGITAL_EMPLOYEE_MODEL_ASSIGNMENTS_CONTRACT_VERSION) {
    throw assignmentError("digital_employee_model_assignments_contract_invalid");
  }
  if (!Array.isArray(value.items)) throw assignmentError("digital_employee_model_assignments_items_invalid");
  const items = value.items.map((item) => normalizePersistedAssignment(item, aiModelCatalog));
  const normalized = finalizeAssignmentSet({
    appliedVersion: value.appliedVersion,
    items,
    source: value.source,
  });
  if (value.assignmentDigest !== normalized.assignmentDigest) {
    throw assignmentError("digital_employee_model_assignments_digest_changed");
  }
  return normalized;
}

function modelAssignmentsForEmployee(employee = {}, { aiModelCatalog = [] } = {}) {
  if (employee.modelAssignments !== undefined && employee.modelAssignments !== null) {
    return normalizeAppliedModelAssignments(employee.modelAssignments, { aiModelCatalog });
  }
  const model = catalogModelForLegacyBinding(employee.modelBinding, aiModelCatalog);
  if (!model) {
    return finalizeAssignmentSet({
      appliedVersion: 0,
      items: [],
      source: "legacy_model_binding_projection",
    });
  }
  const modelLevelId = token(employee.modelBinding?.modelLevelId || model.defaultLevelId, "modelLevelId");
  if (!model.supportedLevelIds?.includes(modelLevelId) || modelLevelId === "none") {
    throw assignmentError("digital_employee_model_assignment_level_invalid");
  }
  const assignmentId = `legacy-primary-${digestCanonical({
    modelId: model.id,
    modelLevelId,
    providerRouteId: model.providerRouteId,
  }).slice(0, 16)}`;
  return finalizeAssignmentSet({
    appliedVersion: 0,
    items: [catalogAssignment({
      assignmentId,
      model,
      modelLevelId,
      roles: { primary: true, taskDefinitionIds: [] },
    })],
    source: "legacy_model_binding_projection",
  });
}

function primaryModelBindingFromAssignments(value, { aiModelCatalog = [] } = {}) {
  const assignments = normalizeOrUseAssignmentSet(value, aiModelCatalog);
  const primary = assignments.items.find((item) => item.roles.primary);
  if (!primary) return null;
  return deepFreeze({
    modelId: primary.modelId,
    provider: primary.provider,
    providerName: primary.providerName,
    providerRouteId: primary.providerRouteId,
    requiredCapabilityProfileVersion: primary.requiredCapabilityProfileVersion,
    model: primary.model,
    modelLevelId: primary.modelLevelId,
    status: "已应用",
  });
}

function resolveAppliedTaskModelAssignments({
  aiModelCatalog = [],
  employee,
  getProviderRoutes = () => [],
  modelAssignments,
  taskDefinitionId,
  selectionMode = "task",
  assignmentId,
} = {}) {
  if (typeof getProviderRoutes !== "function") {
    throw new TypeError("model assignment resolver requires getProviderRoutes");
  }
  const assignments = modelAssignments
    ? normalizeAppliedModelAssignments(modelAssignments, { aiModelCatalog })
    : modelAssignmentsForEmployee(employee, { aiModelCatalog });
  const safeTaskDefinitionId = token(taskDefinitionId, "taskDefinitionId");
  const providerRoutes = getProviderRoutes();
  if (!["task", "primary", "assignment"].includes(selectionMode)) {
    throw assignmentError("digital_employee_model_assignment_selection_invalid");
  }
  if (selectionMode !== "assignment" && assignmentId !== undefined) {
    throw assignmentError("digital_employee_model_assignment_selection_invalid");
  }
  if (selectionMode !== "task" && assignments.source === "legacy_model_binding_projection") {
    throw assignmentError("digital_employee_model_assignment_primary_not_applied");
  }
  const selectedAssignmentId = selectionMode === "assignment" ? token(assignmentId, "assignmentId") : null;
  const selected = assignments.items.filter((item) => item.status === "applied" && (
    selectionMode === "primary" ? item.roles.primary :
      selectionMode === "assignment" ? item.assignmentId === selectedAssignmentId :
        item.roles.taskDefinitionIds.includes(safeTaskDefinitionId)
  ));
  const items = selected.map((item) => {
    // A primary model may delegate route selection to the employee runtime.
    // Resolve that current configured route without rewriting applied assignments.
    if (selectionMode === "primary" && !item.providerRouteId) {
      const routeId = configuredEmployeeProviderRouteId(employee);
      const routes = providerRoutes.filter(route => route.id === routeId);
      if (!routeId || routes.length !== 1 || !routes[0].capabilityProfileVersion) {
        throw assignmentError("digital_employee_model_assignment_provider_route_unavailable");
      }
      item = { ...item, providerRouteId: routeId,
        requiredCapabilityProfileVersion: item.requiredCapabilityProfileVersion || routes[0].capabilityProfileVersion };
    }
    return validateCurrentProviderRoute(item, providerRoutes);
  });
  return deepFreeze({
    appliedVersion: assignments.appliedVersion,
    assignmentDigest: assignments.assignmentDigest,
    items,
  });
}

function assignmentFromCatalog(value, aiModelCatalog) {
  requirePlainObject(value, "digital_employee_model_assignment_invalid");
  rejectUnknownFields(value, MODEL_ASSIGNMENT_REQUEST_FIELDS, "digital_employee_model_assignment_unknown_field");
  const assignmentId = token(value.assignmentId, "assignmentId");
  const modelId = token(value.modelId, "modelId");
  const models = aiModelCatalog.filter((item) => item?.id === modelId);
  if (models.length !== 1) throw assignmentError("digital_employee_model_assignment_model_invalid");
  const model = models[0];
  const modelLevelId = token(value.modelLevelId || model.defaultLevelId, "modelLevelId");
  if (!model.supportedLevelIds?.includes(modelLevelId) || modelLevelId === "none") {
    throw assignmentError("digital_employee_model_assignment_level_invalid");
  }
  const roles = normalizeRoles(value.roles);
  if (roles.taskDefinitionIds.length && model.scheduleEligibility !== "approved") {
    throw assignmentError("digital_employee_model_assignment_schedule_not_approved");
  }
  return catalogAssignment({ assignmentId, model, modelLevelId, roles });
}

function normalizePersistedAssignment(value, aiModelCatalog) {
  requirePlainObject(value, "digital_employee_model_assignment_invalid");
  rejectUnknownFields(value, MODEL_ASSIGNMENT_FIELDS, "digital_employee_model_assignment_unknown_field");
  if (value.status !== "applied") throw assignmentError("digital_employee_model_assignment_not_applied");
  const modelId = token(value.modelId, "modelId");
  const models = aiModelCatalog.filter((item) => item?.id === modelId);
  if (models.length !== 1) throw assignmentError("digital_employee_model_assignment_model_invalid");
  const model = models[0];
  const expected = assignmentFromCatalog({
    assignmentId: value.assignmentId,
    modelId,
    modelLevelId: value.modelLevelId,
    roles: value.roles,
  }, aiModelCatalog);
  for (const field of ["model", "provider", "providerName", "providerRouteId", "requiredCapabilityProfileVersion"]) {
    if (String(value[field] || "") !== String(expected[field] || "")) {
      throw assignmentError("digital_employee_model_assignment_catalog_changed");
    }
  }
  if (model.scheduleEligibility !== "approved" && expected.roles.taskDefinitionIds.length) {
    throw assignmentError("digital_employee_model_assignment_schedule_not_approved");
  }
  return expected;
}

function catalogAssignment({ assignmentId, model, modelLevelId, roles }) {
  if (!model.model || !model.provider || (roles.taskDefinitionIds.length && (!model.providerRouteId || !model.requiredCapabilityProfileVersion))) {
    throw assignmentError("digital_employee_model_assignment_contract_incomplete");
  }
  return deepFreeze({
    assignmentId,
    status: "applied",
    modelId: token(model.id, "modelId"),
    provider: token(model.provider, "provider"),
    providerName: safeText(model.providerName, 120),
    model: safeText(model.model, 120),
    modelLevelId,
    providerRouteId: optionalToken(model.providerRouteId, "providerRouteId"),
    requiredCapabilityProfileVersion: optionalToken(model.requiredCapabilityProfileVersion, "requiredCapabilityProfileVersion"),
    roles,
  });
}

function normalizeRoles(value) {
  requirePlainObject(value, "digital_employee_model_assignment_roles_invalid");
  rejectUnknownFields(value, MODEL_ASSIGNMENT_ROLE_FIELDS, "digital_employee_model_assignment_role_unknown_field");
  if (typeof value.primary !== "boolean") throw assignmentError("digital_employee_model_assignment_primary_invalid");
  if (!Array.isArray(value.taskDefinitionIds)) {
    throw assignmentError("digital_employee_model_assignment_task_definitions_invalid");
  }
  const taskDefinitionIds = [...new Set(value.taskDefinitionIds.map((item) => token(item, "taskDefinitionId")))].sort();
  return deepFreeze({ primary: value.primary, taskDefinitionIds });
}

function finalizeAssignmentSet({ appliedVersion, items, source }) {
  const safeVersion = nonNegativeInteger(appliedVersion, "appliedVersion");
  const safeSource = enumValue(source, ["canonical_runtime_config", "legacy_model_binding_projection"], "digital_employee_model_assignments_source_invalid");
  const sortedItems = [...items].sort((left, right) => left.assignmentId.localeCompare(right.assignmentId));
  if (new Set(sortedItems.map((item) => item.assignmentId)).size !== sortedItems.length) {
    throw assignmentError("digital_employee_model_assignment_id_duplicate");
  }
  const primaryCount = sortedItems.filter((item) => item.roles.primary).length;
  if (sortedItems.length && primaryCount !== 1) {
    throw assignmentError("digital_employee_model_assignment_primary_required");
  }
  const semanticKeys = sortedItems.map((item) => `${item.modelId}\u0000${item.modelLevelId}\u0000${item.providerRouteId}`);
  if (new Set(semanticKeys).size !== semanticKeys.length) {
    throw assignmentError("digital_employee_model_assignment_duplicate");
  }
  const core = {
    contractVersion: DIGITAL_EMPLOYEE_MODEL_ASSIGNMENTS_CONTRACT_VERSION,
    appliedVersion: safeVersion,
    source: safeSource,
    items: sortedItems,
  };
  return deepFreeze({ ...core, assignmentDigest: digestCanonical(core) });
}

function validateCurrentProviderRoute(assignment, routes) {
  const matches = Array.isArray(routes) ? routes.filter((route) => route?.id === assignment.providerRouteId) : [];
  if (matches.length !== 1) throw assignmentError("digital_employee_model_assignment_provider_route_unavailable");
  const route = matches[0];
  if (route.enabled === false || INACTIVE_ROUTE_HEALTH.has(String(route.health || "").toLowerCase()) ||
    route.provider !== assignment.provider ||
    route.capabilityProfileVersion !== assignment.requiredCapabilityProfileVersion ||
    !route.credentialId || !route.apiProtocol || !route.authMode || !route.upstreamDialect) {
    throw assignmentError("digital_employee_model_assignment_provider_route_unavailable");
  }
  if (String(route.fallbackRouteId || "").trim()) {
    throw assignmentError("digital_employee_model_assignment_fallback_forbidden");
  }
  return assignment;
}

function catalogModelForLegacyBinding(binding, aiModelCatalog) {
  if (!binding || typeof binding !== "object" || Array.isArray(binding)) return null;
  const modelId = String(binding.modelId || "").trim();
  const modelName = String(binding.model || "").trim();
  const candidates = aiModelCatalog.filter((item) => (
    modelId ? item?.id === modelId : modelName && item?.model === modelName
  ));
  if (!candidates.length && !modelId && !modelName) return null;
  if (candidates.length !== 1) throw assignmentError("digital_employee_model_assignment_model_invalid");
  const model = candidates[0];
  if ((modelName && model.model !== modelName) ||
    (binding.providerRouteId && binding.providerRouteId !== model.providerRouteId) ||
    (binding.requiredCapabilityProfileVersion && binding.requiredCapabilityProfileVersion !== model.requiredCapabilityProfileVersion)) {
    throw assignmentError("digital_employee_model_assignment_catalog_changed");
  }
  return model;
}

function normalizeOrUseAssignmentSet(value, aiModelCatalog) {
  if (value?.contractVersion === DIGITAL_EMPLOYEE_MODEL_ASSIGNMENTS_CONTRACT_VERSION) {
    return normalizeAppliedModelAssignments(value, { aiModelCatalog });
  }
  throw assignmentError("digital_employee_model_assignments_invalid");
}

function rejectUnknownFields(value, allowed, code) {
  if (Object.keys(value).some((field) => !allowed.has(field))) throw assignmentError(code);
}

function requirePlainObject(value, code) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw assignmentError(code);
}

function token(value, field) {
  const result = String(value || "").trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,159}$/.test(result)) {
    throw assignmentError("digital_employee_model_assignment_reference_invalid", field);
  }
  return result;
}

function optionalToken(value, field) {
  return value === undefined || value === null || value === "" ? "" : token(value, field);
}

function safeText(value, limit) {
  const result = String(value || "").replace(/[\u0000-\u001f\u007f]/g, " ").trim();
  if (!result || result.length > limit) throw assignmentError("digital_employee_model_assignment_text_invalid");
  return result;
}

function nonNegativeInteger(value, field) {
  const result = Number(value);
  if (!Number.isSafeInteger(result) || result < 0) {
    throw assignmentError("digital_employee_model_assignments_version_invalid", field);
  }
  return result;
}

function enumValue(value, allowed, code) {
  if (!allowed.includes(value)) throw assignmentError(code);
  return value;
}

function digestCanonical(value) {
  return crypto.createHash("sha256").update(JSON.stringify(canonicalize(value))).digest("hex");
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]));
}

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  Object.freeze(value);
  Object.values(value).forEach(deepFreeze);
  return value;
}

function assignmentError(code, detail = "") {
  const error = new Error(detail ? `${code}: ${detail}` : code);
  error.code = code;
  return error;
}

export {
  DIGITAL_EMPLOYEE_MODEL_ASSIGNMENTS_CONTRACT_VERSION,
  createAppliedModelAssignments,
  modelAssignmentsForEmployee,
  normalizeAppliedModelAssignments,
  primaryModelBindingFromAssignments,
  resolveAppliedTaskModelAssignments,
};
