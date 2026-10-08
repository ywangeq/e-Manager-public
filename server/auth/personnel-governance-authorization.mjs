import { permissionsForRole } from "../../src/lib/permissions.js";

export function applyPersonnelGovernanceAuthorization(session = {}, assignment = null) {
  if (!assignment || assignment.contractVersion !== "personnel-authorization-assignment.v1") return session;
  if (session.role === "admin" || (session.permissions || []).includes("system:*")) return session;

  const governanceAssignment = {
    contractVersion: assignment.contractVersion,
    matchedIdentityField: assignment.matchedIdentityField,
    source: assignment.source,
  };

  if (assignment.kind === "system") {
    return {
      ...session,
      role: "admin",
      permissions: permissionsForRole("admin"),
      governanceRole: "系统管理员",
      managedDepartmentIds: ["*"],
      reviewDepartmentIds: ["*"],
      governanceAssignment,
    };
  }

  if (assignment.kind !== "department" || !assignment.departmentId) return session;
  return {
    ...session,
    governanceRole: assignment.governanceRole,
    managedDepartmentIds: uniqueIds(session.managedDepartmentIds, assignment.departmentId),
    reviewDepartmentIds: uniqueIds(session.reviewDepartmentIds, assignment.departmentId),
    governanceAssignment,
  };
}

function uniqueIds(current, added) {
  return [...new Set([...(Array.isArray(current) ? current : []), added].filter(Boolean))];
}
