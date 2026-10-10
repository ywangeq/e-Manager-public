import { providerTimeoutPolicyForRoute } from "./agent-runtime/provider-timeout-policy.mjs";
export function projectProviderRoutes(routes = [], governanceState = {}) {
  return routes.map((route) => {
    const override = governanceState.routeOverrides?.[route.id];
    const enabled = typeof override?.enabled === "boolean" ? override.enabled : route.enabled !== false;
    return {
      ...route,
      ...(override?.timeoutPolicy ? { timeoutPolicy: providerTimeoutPolicyForRoute({ timeoutPolicy: override.timeoutPolicy }) } : {}),
      ...(Number.isSafeInteger(override?.toolExecutionTimeoutMs) ? { toolExecutionTimeoutMs: override.toolExecutionTimeoutMs } : {}),
      ...(Number.isSafeInteger(override?.retryCount) ? { retryCount: override.retryCount } : {}),
      enabled,
      health: enabled ? route.health : "disabled",
      governanceUpdatedAt: override?.updatedAt || "",
      governanceUpdatedBy: override?.updatedBy || "",
    };
  });
}

export function projectProviderCredentials(credentials = [], governanceState = {}) {
  return credentials.map((credential) => {
    const override = governanceState.credentialOverrides?.[credential.id];
    return {
      ...credential,
      ...(override?.departmentId ? { departmentId: override.departmentId } : {}),
      governanceUpdatedAt: override?.updatedAt || "",
      governanceUpdatedBy: override?.updatedBy || "",
    };
  });
}

export function buildSafeProviderConnections({ credentials = [], governanceState = {}, routes = [], secretSummaries = {}, workerPools = [] } = {}) {
  const projectedCredentials = projectProviderCredentials(credentials, governanceState);
  const projectedRoutes = projectProviderRoutes(routes, governanceState);
  const credentialById = new Map(projectedCredentials.map((credential) => [credential.id, credential]));
  const workerPoolById = new Map(workerPools.map((workerPool) => [workerPool.id, workerPool]));
  return projectedRoutes.map((route) => {
    const credential = credentialById.get(route.credentialId) || {};
    const secret = secretSummaries[credential.id];
    const workerPool = workerPoolById.get(route.workerPoolId) || null;
    return {
      ...route,
      timeoutPolicy: providerTimeoutPolicyForRoute(route),
      toolExecutionTimeoutMs: route.toolExecutionTimeoutMs || 300_000,
      retryCount: route.retryCount ?? 2,
      credentialId: credential.id || route.credentialId || "",
      credentialName: credential.name || "未绑定凭证",
      credentialType: credential.credentialType || "",
      departmentId: credential.departmentId || workerPool?.ownerDepartmentId || "digital-office",
      maskedSecret: secret?.maskedSecret || credential.maskedSecret || "待接入",
      credentialStatus: credential.status || "missing_server_secret",
      leaseStatus: secret?.hasSecret ? "ready" : credential.status === "planned" ? "planned" : "missing_server_secret",
      credentialVisibility: "server_only",
      expiresAt: credential.expiresAt || "待配置",
      lastUsedAt: credential.lastUsedAt || route.lastCheckedAt || "暂未使用",
      updatedAt: route.governanceUpdatedAt || credential.governanceUpdatedAt || secret?.updatedAt || "",
      updatedBy: route.governanceUpdatedBy || credential.governanceUpdatedBy || secret?.updatedBy || "",
      workerPool,
    };
  });
}
