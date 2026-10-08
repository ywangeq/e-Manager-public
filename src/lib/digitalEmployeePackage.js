function cleanList(items = []) {
  return (Array.isArray(items) ? items : [items])
    .map((item) => String(item || "").trim())
    .filter(Boolean);
}

function uniqueItems(items = []) {
  return Array.from(new Set(cleanList(items)));
}

export function hasExportableEmployeePackage(employee = {}) {
  if (!employee || employee.level === "系统级") return false;
  return Boolean(
    cleanList(employee.packageBundleSkillIds).length ||
      cleanList(employee.effectivePackageBundleSkillIds).length ||
      cleanList(employee.packageIncludes).length ||
      employee.skillPackage ||
      employee.downloadPolicy,
  );
}

export function digitalEmployeePackageExportPath(employee = {}) {
  if (!employee?.id || !hasExportableEmployeePackage(employee)) return "";
  return `/api/digital-employees/${encodeURIComponent(employee.id)}/package.zip`;
}

export function hasExportableBusinessSkillPackage(skill = {}) {
  if (!skill?.id) return false;
  return Boolean(skill.downloadUrl || skill.status === "mvp_skill_published");
}

export function businessSkillPackageDownloadPath(skill = {}) {
  if (!hasExportableBusinessSkillPackage(skill)) return "";
  return `/api/business-skills/${encodeURIComponent(skill.id)}/package`;
}

export function businessSkillPackageFileName(skill = {}) {
  const id = String(skill.id || "business-skill").replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  return `${id || "business-skill"}-governed-package.zip`;
}

export function digitalEmployeePackageFileName(employee = {}) {
  const id = String(employee.id || "digital-employee").replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  return `${id || "digital-employee"}-package.zip`;
}

export function appliedSkillMountRequestsForEmployee(employeeId, requests = []) {
  const id = String(employeeId || "").trim();
  if (!id) return [];
  return (Array.isArray(requests) ? requests : [])
    .filter((request) => String(request?.employeeId || "").trim() === id)
    .filter((request) => request.status === "已生效")
    .filter((request) => ["mount", "unmount"].includes(request.action))
    .sort((left, right) => String(left.updatedAt || left.submittedAt || "").localeCompare(String(right.updatedAt || right.submittedAt || "")));
}

export function employeeWithEffectiveMountedSkills(employee = {}, requests = []) {
  const appliedRequests = appliedSkillMountRequestsForEmployee(employee.id, requests);
  if (!appliedRequests.length) return employee;

  const basicSkillIds = new Set(cleanList(employee.basicSkillIds));
  const businessSkillIds = new Set(cleanList(employee.businessSkillIds));
  const effectiveChanges = [];

  appliedRequests.forEach((request) => {
    const skillId = String(request.skillId || "").trim();
    if (!skillId) return;
    const target = request.skillKind === "platform_basic_skill" ? basicSkillIds : businessSkillIds;
    if (request.action === "mount") target.add(skillId);
    if (request.action === "unmount") target.delete(skillId);
    effectiveChanges.push({
      id: request.id,
      action: request.action,
      mountActionId: request.mountActionId,
      skillId,
      skillKind: request.skillKind || "business_skill",
      updatedAt: request.updatedAt || "",
    });
  });

  const nextBasicSkillIds = Array.from(basicSkillIds);
  const nextBusinessSkillIds = Array.from(businessSkillIds);
  return {
    ...employee,
    catalogBasicSkillIds: cleanList(employee.basicSkillIds),
    catalogBusinessSkillIds: cleanList(employee.businessSkillIds),
    catalogPackageBundleSkillIds: cleanList(employee.packageBundleSkillIds),
    basicSkillIds: nextBasicSkillIds,
    businessSkillIds: nextBusinessSkillIds,
    packageBundleSkillIds: cleanList(employee.packageBundleSkillIds),
    effectivePackageBundleSkillIds: nextBusinessSkillIds,
    effectiveMountChanges: effectiveChanges,
    packageCompositionUpdatedByMounts: true,
  };
}

export function employeePackageRootSkillIds(employee = {}) {
  return uniqueItems([
    ...cleanList(employee.basicSkillIds),
    ...cleanList(
      employee.effectivePackageBundleSkillIds?.length
        ? employee.effectivePackageBundleSkillIds
        : employee.packageBundleSkillIds?.length
        ? employee.packageBundleSkillIds
        : employee.businessSkillIds,
    ),
  ]);
}
