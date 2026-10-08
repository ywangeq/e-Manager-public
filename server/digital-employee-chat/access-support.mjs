export function digitalEmployeeSessionAccess(session = {}, hasPermission = () => false) {
  const permissions = session?.permissions || [];
  const isAdmin = session?.role === "admin" || hasPermission(permissions, "system:*");
  return {
    isAdmin,
    canGovernControlPlane: isAdmin || hasPermission(permissions, "control-plane:*") || hasPermission(permissions, "subsystems:review"),
    canReviewQuality: isAdmin || hasPermission(permissions, "quality-reviews:*") || hasPermission(permissions, "badcases:*") || hasPermission(permissions, "control-plane:*"),
    canManagePeople: isAdmin || hasPermission(permissions, "people:*") || hasPermission(permissions, "people:edit"),
    canManageProviderConnections: isAdmin || hasPermission(permissions, "provider-connections:*"),
  };
}

export function canManageDigitalEmployeeRuntimeTasks({ employee = {}, hasPermission = () => false, session = {}, cleanEmployeeId } = {}) {
  const permissions = session.permissions || [];
  const governed = session.role === "admin" || hasPermission(permissions, "system:*") || hasPermission(permissions, "digital-employees:lifecycle");
  return Boolean(governed || (cleanEmployeeId(employee.ownerUserId) && cleanEmployeeId(employee.ownerUserId) === cleanEmployeeId(session.employeeId)));
}

export function recordDigitalEmployeeRuntimeCall({ channelId = "management_console", employee = {}, outcome = "completed", reasonCode = "", session = {}, lease = {}, runtimeEventStore, employeeDisplayName, resolveRuntimeAdapter } = {}) {
  if (typeof runtimeEventStore?.recordTaskCallEvent !== "function") return null;
  return runtimeEventStore.recordTaskCallEvent({
    employeeId: employee.id,
    employeeName: employeeDisplayName(employee),
    sourceSystemId: "digital-workforce-management",
    channelId,
    entrypoint: channelId === "desktop" ? "desktop-digital-employee-chat" : "management-console-digital-employee-chat",
    taskType: "digital_employee_chat",
    outcome,
    reasonCode,
    model: lease.model,
    reasoningEffort: lease.reasoningEffort,
    runtimeAdapter: resolveRuntimeAdapter(employee),
  }, session);
}
