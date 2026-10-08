import { authorizationDecision } from "./auth/authorization-session-service.mjs";

const DESKTOP_ASSISTANT_ID = "enterprise-ai-copilot";
const DEPARTMENT_ENTITLEMENT_SCOPES = new Set(["ownDepartment", "departmentSubtree"]);

export function evaluateDigitalEmployeeEntitlement({
  accessRequests = [],
  channelId = "desktop",
  employee = {},
  session = null,
} = {}) {
  const employeeId = cleanId(employee.id);
  const employeeVersion = cleanText(employee.version);
  const sessionAuthorization = authorizationDecision(session);
  const authenticated = sessionAuthorization.allowed;
  const isSystemEmployee = employee.level === "系统级";
  const isDefaultAssistant = employeeId === DESKTOP_ASSISTANT_ID;
  const desktopChannelAvailable = desktopChannelAvailableFor(employee, channelId);
  const employeeAvailable = desktopChannelAvailable && callableEmployeeStatus(employee.status, channelId);
  const explicitlyGranted = authenticated && hasExplicitGrant(session, employeeId);
  const departmentGrantScopeId = authenticated ? departmentGrantScope(session, employee) : "";
  const departmentGranted = Boolean(departmentGrantScopeId);
  const approvedRequest = authenticated
    ? accessRequests.find((request) => requestGrantsEmployee(request, session, employeeId, employeeVersion))
    : null;
  const entitled = authenticated && (isDefaultAssistant || explicitlyGranted || departmentGranted || Boolean(approvedRequest));
  const requestable = authenticated && !isSystemEmployee && !entitled && employeeAvailable;
  const selectable = entitled && employeeAvailable;

  return {
    contractVersion: "digital-employee-entitlement.v1",
    visible: authenticated && desktopChannelAvailable && (isDefaultAssistant || !isSystemEmployee),
    channelAvailable: desktopChannelAvailable,
    entitled,
    requestable,
    callable: selectable,
    selectable,
    allowedActions: selectable ? ["conversation"] : [],
    grantId: approvedRequest?.id || (
      isDefaultAssistant
        ? "enterprise-default"
        : explicitlyGranted
          ? "session-permission"
          : departmentGranted
            ? `department-scope:${cleanId(departmentGrantScopeId)}`
            : ""
    ),
    reasonCode: entitlementReason({
      authenticated,
      desktopChannelAvailable,
      employeeAvailable,
      entitled,
      isSystemEmployee,
      requestable,
      sessionAuthorization,
    }),
  };
}

export function sessionCanUseDigitalEmployee(input = {}) {
  return evaluateDigitalEmployeeEntitlement(input).callable;
}

export function accessRequestActorId(session = {}) {
  return cleanText(session.employeeId || session.feishuUserId || session.employeeNo || session.email);
}

function actorId(session = {}) {
  return accessRequestActorId(session);
}

function hasExplicitGrant(session = {}, employeeId = "") {
  const permissions = new Set(Array.isArray(session.permissions) ? session.permissions : []);
  return (
    session.role === "admin" ||
    permissions.has("system:*") ||
    permissions.has("digital-employees:*") ||
    permissions.has(`digital-employees:${employeeId}:use`)
  );
}

function departmentGrantScope(session = {}, employee = {}) {
  const permissionScope = cleanText(employee.permissionScope);
  if (
    employee.level === "系统级" ||
    cleanText(employee.status) !== "在线" ||
    !DEPARTMENT_ENTITLEMENT_SCOPES.has(permissionScope)
  ) return "";

  const configuredDepartmentIds = Array.isArray(employee.authorizedDepartmentIds)
    ? employee.authorizedDepartmentIds
    : [employee.ownerDepartmentId, employee.departmentId, ...(Array.isArray(employee.departmentIds) ? employee.departmentIds : [])];
  const employeeDepartmentIds = configuredDepartmentIds.map(cleanDepartmentId).filter(Boolean);
  const sessionDepartmentIds = [session.departmentId].map(cleanDepartmentId).filter(Boolean);
  return employeeDepartmentIds.find((scopeId) => sessionDepartmentIds.some((departmentId) =>
    permissionScope === "departmentSubtree"
      ? departmentIdWithinScope(departmentId, scopeId)
      : departmentId === scopeId,
  )) || "";
}

function departmentIdWithinScope(departmentId = "", scopeId = "") {
  return departmentId === scopeId || departmentId.startsWith(`${scopeId}/`);
}

function cleanDepartmentId(value) {
  return String(value || "").trim().replace(/^\/+|\/+$/g, "");
}

function requestGrantsEmployee(request = {}, session = {}, employeeId = "", employeeVersion = "") {
  if (request.status !== "approved") return false;
  if (cleanText(request.applicant?.id) !== actorId(session)) return false;
  if (cleanId(request.target?.employeeId) !== employeeId) return false;
  const grantedVersion = cleanText(request.target?.employeeVersion);
  return !grantedVersion || !employeeVersion || grantedVersion === employeeVersion;
}

function callableEmployeeStatus(status = "", channelId = "desktop") {
  const lifecycleStatus = cleanText(status);
  if (cleanId(channelId) === "desktop") return lifecycleStatus === "在线";
  return ["在线", "试运行"].includes(lifecycleStatus);
}

function desktopChannelAvailableFor(employee = {}, channelId = "desktop") {
  if (cleanId(channelId) !== "desktop") return true;
  return employee.desktopAvailable !== false && employee.channelConfig?.desktop?.enabled !== false;
}

function entitlementReason({ authenticated, desktopChannelAvailable, employeeAvailable, entitled, isSystemEmployee, requestable, sessionAuthorization }) {
  if (!authenticated) return sessionAuthorization.error || "authentication_required";
  if (!desktopChannelAvailable) return "desktop_channel_closed";
  if (!employeeAvailable) return "digital_employee_not_active";
  if (entitled) return "granted";
  if (requestable) return "access_request_required";
  if (isSystemEmployee) return "system_employee_not_requestable";
  return "employee_not_available";
}

function cleanId(value) {
  return String(value || "").trim().toLowerCase().replace(/[^a-z0-9._-]+/g, "-").slice(0, 120);
}

function cleanText(value) {
  return String(value || "").replace(/\s+/g, " ").trim().slice(0, 240);
}

export { DESKTOP_ASSISTANT_ID };
