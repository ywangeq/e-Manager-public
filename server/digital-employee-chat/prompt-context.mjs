export function buildDigitalEmployeeSafeContext({
  access,
  activeViewLabel,
  cleanText,
  contextAssembly = null,
  dependencyContext,
  desktopMaterial,
  desktopMaterialRuntimeReady = false,
  employee,
  taskOutputEvidence = null,
  providerRoute,
  runtimeScopeInstruction,
  sanitizeDesktopMaterialContext,
  session,
}) {
  return {
    activeViewLabel: cleanText(activeViewLabel || ""),
    desktopMaterial: sanitizeDesktopMaterialContext(desktopMaterial, { expectedEmployeeId: employee.id, runtimeReadable: desktopMaterialRuntimeReady }),
    session: {
      employeeId: cleanText(session.employeeId || ""),
      name: cleanText(session.name || ""),
      role: cleanText(session.role || ""),
      departmentId: cleanText(session.departmentId || ""),
      department: cleanText(session.department || ""),
      identitySource: cleanText(session.identitySource || ""),
      permissions: Array.isArray(session.permissions) ? session.permissions.slice(0, 30) : [],
    },
    access,
    contextAssembly,
    dependencyContext,
    ...(taskOutputEvidence ? { taskOutputEvidence } : {}),
    runtimeScope: runtimeScopeInstruction(employee),
    runtimeRoute: {
      provider: employee.runtimeBinding?.provider || providerRoute.provider || "codex",
      providerRouteId: providerRoute.id || employee.runtimeBinding?.preferredProviderRouteId || "",
      credentialLeasePolicy: employee.runtimeBinding?.credentialLeasePolicy || "server_side_runtime_lease",
      keyVisibility: "server_only",
    },
  };
}

export function buildDigitalEmployeeReferenceContext({ basicSkills = [], businessSkills = [], digitalEmployees = [], employee = {} } = {}) {
  const common = {
    apiDirections: Array.isArray(employee.apiEndpoints) ? employee.apiEndpoints.slice(0, 20) : [],
    sourceTargets: Array.isArray(employee.sourceTargets) ? employee.sourceTargets.slice(0, 20) : [],
  };
  if (!employee.managementCapabilityPlan) return common;
  return {
    ...common,
    digitalEmployees: digitalEmployees.map((item) => ({
      id: item.id,
      name: item.name,
      level: item.level,
      status: item.status,
      departmentId: item.departmentId,
      businessDomain: item.businessDomain || item.domain,
      capabilityLine: item.capabilityLine,
      ownerDepartmentId: item.ownerDepartmentId,
      permissionScope: item.permissionScope,
      model: item.modelBinding?.model,
      modelLevelId: item.modelBinding?.modelLevelId,
      objective: item.objective,
    })),
    basicSkills: basicSkills.map((skill) => ({
      id: skill.id,
      name: skill.name,
      status: skill.status,
      category: skill.category,
      ownerDepartmentId: skill.ownerDepartmentId,
      constraints: skill.constraints || [],
    })),
    businessSkills: businessSkills.map((skill) => ({
      id: skill.id,
      name: skill.name,
      status: skill.status,
      departmentId: skill.departmentId,
      domain: skill.domain,
      risk: skill.risk,
      reviewGate: skill.reviewGate,
      constraints: skill.constraints || [],
    })),
  };
}
