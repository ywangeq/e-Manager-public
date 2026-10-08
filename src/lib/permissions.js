export const SYSTEM_ADMIN_PERMISSIONS = [
  "system:*",
  "people:*",
  "departments:*",
  "digital-employees:*",
  "basic-skills:*",
  "business-skills:*",
  "quality-reviews:*",
  "system-imports:*",
  "provider-connections:*",
  "ops:*",
  "api-contracts:*",
  "badcases:*",
];

export function permissionsForRole(role) {
  return role === "admin" ? [...SYSTEM_ADMIN_PERMISSIONS] : [];
}

export function hasPermission(permissions = [], permission = "") {
  if (!permission) return false;
  const permissionSet = new Set(permissions || []);
  if (permissionSet.has("system:*") || permissionSet.has(permission)) return true;
  const [scope] = permission.split(":");
  return Boolean(scope && permissionSet.has(`${scope}:*`));
}

export function isSystemAdminSession(session) {
  return session?.role === "admin" || hasPermission(session?.permissions, "system:*");
}

export function hasControlPlaneReviewAccess(session) {
  return (
    isSystemAdminSession(session) ||
    hasPermission(session?.permissions, "control-plane:*") ||
    hasPermission(session?.permissions, "subsystems:review") ||
    hasPermission(session?.permissions, "quality-reviews:*") ||
    hasPermission(session?.permissions, "badcases:*")
  );
}

export function hasControlPlaneManageAccess(session) {
  return (
    isSystemAdminSession(session) ||
    hasPermission(session?.permissions, "control-plane:*") ||
    hasPermission(session?.permissions, "subsystems:review")
  );
}

function listIncludes(list = [], value = "") {
  const normalizedValue = String(value || "").trim();
  if (!normalizedValue) return false;
  const values = Array.isArray(list) ? list : [];
  return values.includes("*") || values.includes(normalizedValue);
}

function employeeDepartmentIds(employee = {}) {
  return [...new Set([employee.ownerDepartmentId, employee.departmentId, ...(Array.isArray(employee.departmentIds) ? employee.departmentIds : [])].filter(Boolean))];
}

function isDepartmentGovernanceSession(session = {}) {
  const managedDepartmentIds = Array.isArray(session.managedDepartmentIds) ? session.managedDepartmentIds : [];
  const governanceRole = String(session.governanceRole || session.role || "");
  return Boolean(
    managedDepartmentIds.length ||
      /部门负责人|部门管理员|业务管理员|平台管理员|department/i.test(governanceRole) ||
      hasPermission(session.permissions, "departments:*") ||
      hasPermission(session.permissions, "people:*"),
  );
}

export function canViewSystemWorkerScheduling(session = {}) {
  return Boolean(
    isSystemAdminSession(session) ||
      isDepartmentGovernanceSession(session) ||
      hasPermission(session.permissions, "system-workers:read")
  );
}

function canManageAnyEmployeeDepartment(session = {}, employee = {}) {
  if (isSystemAdminSession(session)) return true;
  const managedDepartmentIds = Array.isArray(session.managedDepartmentIds) ? session.managedDepartmentIds : [];
  const departmentIds = employeeDepartmentIds(employee);
  return isDepartmentGovernanceSession(session) && departmentIds.some((departmentId) => listIncludes(managedDepartmentIds, departmentId));
}

function ownsEmployee(session = {}, employee = {}) {
  const sessionUserIds = [session.employeeId, session.feishuUserId, session.employeeNo, session.email].filter(Boolean);
  const ownerUserIds = [employee.ownerUserId, employee.ownerEmail].filter(Boolean);
  return ownerUserIds.some((ownerUserId) => sessionUserIds.includes(ownerUserId));
}

export function digitalEmployeeScope(employee = {}) {
  return employee.level === "系统级" ? "enterprise" : "business";
}

export function canConfigureEnterpriseDigitalEmployee(session = {}, employee = {}) {
  return Boolean(
    isSystemAdminSession(session) ||
      hasPermission(session.permissions, "enterprise-digital-employees:configure") ||
      hasPermission(session.permissions, "digital-employees:configure-enterprise") ||
      hasPermission(session.permissions, "control-plane:*") ||
      canManageAnyEmployeeDepartment(session, employee) ||
      ownsEmployee(session, employee),
  );
}

export function canConfigureBusinessDigitalEmployee(session = {}, employee = {}) {
  return Boolean(
    isSystemAdminSession(session) ||
      hasPermission(session.permissions, "business-digital-employees:configure") ||
      hasPermission(session.permissions, "digital-employees:configure-business") ||
      hasPermission(session.permissions, "digital-employees:configure") ||
      canManageAnyEmployeeDepartment(session, employee) ||
      ownsEmployee(session, employee),
  );
}

export function digitalEmployeeAccess(session = {}, employee = {}) {
  const scope = digitalEmployeeScope(employee);
  const isEnterprise = scope === "enterprise";
  const canConfigure = isEnterprise
    ? canConfigureEnterpriseDigitalEmployee(session, employee)
    : canConfigureBusinessDigitalEmployee(session, employee);
  const canRequestUse = !isEnterprise;
  const blockedReason = isEnterprise
    ? "企业级数字员工配置需要系统管理员、控制面治理或所属治理部门管理员权限。"
    : "业务级数字员工配置需要系统管理员、所属部门管理员或资产 owner 权限。";

  return {
    scope,
    scopeLabel: isEnterprise ? "企业级" : "业务级",
    canViewSafeSummary: true,
    canConfigure,
    canRequestUse,
    canOpenWorkbench: canConfigure || canRequestUse,
    actionLabel: canConfigure ? "配置" : canRequestUse ? "申请" : "不可配置",
    actionTitle: canConfigure
      ? `${isEnterprise ? "配置企业级" : "配置业务级"}数字员工`
      : canRequestUse
        ? "可查看安全摘要并提交使用或变更申请；正式配置需管理员审核"
        : blockedReason,
    blockedReason,
  };
}
