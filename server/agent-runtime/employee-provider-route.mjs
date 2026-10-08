// Shared configured-route precedence. Consumers decide whether their ingress
// permits a platform default; durable task bindings require a real catalog route.
export function configuredEmployeeProviderRouteId(employee = {}) {
  return employee.modelBinding?.providerRouteId || employee.runtimeBinding?.providerRouteId ||
    employee.runtimeBinding?.preferredProviderRouteId || employee.modelBinding?.preferredProviderRouteId || "";
}
