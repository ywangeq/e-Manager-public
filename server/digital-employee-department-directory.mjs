const PLATFORM_VIRTUAL_DEPARTMENT_IDS = new Set(["digital-office"]);
const OWNER_ROLES = new Set(["系统管理员", "平台管理员", "部门负责人", "部门管理员", "业务管理员"]);

export function buildPlatformVirtualDepartmentDirectory({ departments = [], personnel = [] } = {}) {
  const virtualDepartments = departments
    .filter((department) => PLATFORM_VIRTUAL_DEPARTMENT_IDS.has(cleanText(department.id)))
    .map((department) => ({
      id: cleanText(department.id),
      directoryId: cleanText(department.id),
      parentId: "",
      name: cleanText(department.name),
      label: cleanText(department.name),
      source: "platform-virtual",
    }));
  const virtualDepartmentIds = new Set(virtualDepartments.map((department) => department.id));
  const virtualOwners = personnel
    .filter((person) => virtualDepartmentIds.has(cleanText(person.departmentId)))
    .filter((person) => OWNER_ROLES.has(cleanText(person.governanceRole || person.role)) && cleanText(person.status || "启用") !== "停用")
    .map((person) => ({
      id: cleanText(person.id || person.employeeId || person.feishuUserId),
      name: cleanText(person.name || person.displayName),
      departmentId: cleanText(person.departmentId),
      role: cleanText(person.governanceRole || person.role),
      status: cleanText(person.status || "启用"),
      source: "platform-virtual-directory",
    }))
    .filter((person) => person.id && person.name);
  return { departments: virtualDepartments, personnel: virtualOwners };
}

export function mergeDepartmentDirectoryEntries(...entryLists) {
  const entries = [];
  const seen = new Set();
  for (const entry of entryLists.flat()) {
    const id = cleanText(entry?.id);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    entries.push(entry);
  }
  return entries;
}

export function mergeDepartmentOwnerEntries(...entryLists) {
  const entries = [];
  const seen = new Set();
  for (const entry of entryLists.flat()) {
    const id = cleanText(entry?.id);
    const departmentId = cleanText(entry?.departmentId);
    const key = `${departmentId}\u0000${id}`;
    if (!id || !departmentId || seen.has(key)) continue;
    seen.add(key);
    entries.push(entry);
  }
  return entries;
}

function cleanText(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}
