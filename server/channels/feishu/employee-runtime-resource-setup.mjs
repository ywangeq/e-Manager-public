function resolveEmployeeRuntimeResourceSetup({ employee = {}, resourceMonitors = [] } = {}) {
  const requiredResourceIds = uniqueIds(employee.runtimeBinding?.requiredResourceIds);
  const monitorById = new Map((Array.isArray(resourceMonitors) ? resourceMonitors : []).map((resource) => [resource.id, resource]));
  const resources = requiredResourceIds.map((id) => monitorById.get(id) || { id, status: "not_configured" });
  const missingResources = resources.filter((resource) => resource.status !== "ready").map((resource) => ({
    id: resource.id,
    name: resource.name || resource.id,
    kind: resource.kind || "runtime_resource",
    status: resource.status || "not_configured",
    nextGate: resource.nextGate || "请完成该员工运行资源配置。",
  }));
  return {
    ready: missingResources.length === 0,
    requiredResourceIds,
    resources,
    missingResourceIds: missingResources.map((resource) => resource.id),
    missingResources,
  };
}

function uniqueIds(values = []) {
  return [...new Set((Array.isArray(values) ? values : [])
    .map((value) => String(value || "").trim())
    .filter((value) => /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/.test(value)))];
}

export { resolveEmployeeRuntimeResourceSetup };
