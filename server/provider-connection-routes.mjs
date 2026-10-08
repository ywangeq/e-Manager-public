import { buildSafeProviderConnections } from "./provider-connection-service.mjs";

export function createProviderConnectionHandlers({
  credentials = [],
  getDepartmentDirectory = async () => ({ departments: [], source: "unavailable", freshness: "unavailable" }),
  governanceStore,
  hasPermission,
  readJsonBody,
  requireSession,
  routes = [],
  sendJson,
  store,
  workerPools = [],
}) {
  return {
    async handle(req, res, url) {
      if (req.method === "GET" && url.pathname === "/api/model-provider-connections") {
        return await listConnections(req, res);
      }

      const routeMatch = url.pathname.match(/^\/api\/provider-routes\/([^/]+)$/);
      if (req.method === "PATCH" && routeMatch) {
        return await updateRoute(req, res, decodeURIComponent(routeMatch[1]));
      }

      const credentialMatch = url.pathname.match(/^\/api\/provider-credentials\/([^/]+)$/);
      if (req.method === "PATCH" && credentialMatch) {
        return await updateCredential(req, res, decodeURIComponent(credentialMatch[1]));
      }

      const secretMatch = url.pathname.match(/^\/api\/provider-credentials\/([^/]+)\/secret$/);
      if (req.method === "POST" && secretMatch) {
        return await upsertCredentialSecret(req, res, decodeURIComponent(secretMatch[1]));
      }

      return undefined;
    },
  };

  async function listConnections(req, res) {
    const session = requireSession(req, res);
    if (!session) return null;
    if (!canManageProviderConnections(session)) {
      sendJson(res, 403, { ok: false, error: "provider_connection_admin_required" });
      return null;
    }

    const departmentDirectory = await resolveDepartmentDirectory(res, session, true);
    if (!departmentDirectory) return null;
    sendJson(res, 200, {
      ok: true,
      contractVersion: "model-provider-connections.v1",
      connections: safeConnections(),
      departmentDirectory,
      privacyBoundary:
        "只返回 Provider Route、Credential 安全摘要、能力状态和 Worker Pool 摘要；不返回 raw secret、模型 trace、执行 payload、客户数据或员工 PII。",
    });
    return null;
  }

  async function updateRoute(req, res, routeId) {
    const session = requireManager(req, res);
    if (!session) return null;
    if (!routes.some((route) => route.id === routeId)) {
      return sendJson(res, 404, { ok: false, error: "provider_route_not_found" });
    }
    const input = await readJsonBody(req, 8 * 1024);
    if (typeof input.enabled !== "boolean") {
      return sendJson(res, 422, { ok: false, error: "provider_route_enabled_required", message: "enabled 必须是布尔值。" });
    }
    const saved = governanceStore?.setRouteEnabled?.(routeId, input.enabled, session);
    if (!saved?.ok) return storeUnavailable(res);
    const connection = safeConnections().find((item) => item.id === routeId) || null;
    return sendJson(res, 200, {
      ok: true,
      contractVersion: "provider-route-governance-update.v1",
      connection,
      message: input.enabled ? "Provider Route 已启用，Runtime 将实时读取该状态。" : "Provider Route 已停用，新的 Runtime 租约将被阻断。",
    });
  }

  async function updateCredential(req, res, credentialId) {
    const session = requireManager(req, res);
    if (!session) return null;
    if (!credentials.some((credential) => credential.id === credentialId)) {
      return sendJson(res, 404, { ok: false, error: "provider_credential_not_found" });
    }
    const input = await readJsonBody(req, 8 * 1024);
    const departmentDirectory = await resolveDepartmentDirectory(res, session, false);
    if (!departmentDirectory) return null;
    const departmentId = String(input.departmentId || "").trim();
    if (!departmentDirectory.departments.some((department) => department.id === departmentId)) {
      return sendJson(res, 422, { ok: false, error: "provider_credential_department_invalid", message: "请选择当前组织目录中的一级部门。" });
    }
    const saved = governanceStore?.setCredentialDepartment?.(credentialId, departmentId, session);
    if (!saved?.ok) return storeUnavailable(res);
    const connections = safeConnections().filter((item) => item.credentialId === credentialId);
    return sendJson(res, 200, {
      ok: true,
      contractVersion: "provider-credential-governance-update.v1",
      connection: connections[0] || null,
      connections,
      message: "Provider Credential 的一级部门归属已保存并同步到统一连接投影。",
    });
  }

  async function upsertCredentialSecret(req, res, credentialId) {
    const session = requireSession(req, res);
    if (!session) return null;
    if (!canManageProviderConnections(session)) {
      sendJson(res, 403, { ok: false, error: "provider_connection_admin_required" });
      return null;
    }
    if (!credentials.some((credential) => credential.id === credentialId)) {
      sendJson(res, 404, { ok: false, error: "provider_credential_not_found" });
      return null;
    }

    const input = await readJsonBody(req, 32 * 1024);
    const result = store.upsertSecret(credentialId, input, session);
    if (!result.ok) {
      sendJson(res, 422, result);
      return null;
    }

    const connections = safeConnections().filter((connection) => connection.credentialId === credentialId);
    sendJson(res, 200, {
      ok: true,
      contractVersion: "provider-credential-secret-upsert.v1",
      connection: connections[0] || null,
      connections,
      message: `${credentials.find((credential) => credential.id === credentialId)?.name || credentialId} 已写入服务端 Secret Store。`,
    });
    return null;
  }

  function safeConnections() {
    return buildSafeProviderConnections({
      credentials,
      governanceState: governanceStore?.readState?.() || {},
      routes,
      secretSummaries: store.listSecretSummaries(),
      workerPools,
    });
  }

  function requireManager(req, res) {
    const session = requireSession(req, res);
    if (!session) return null;
    if (!canManageProviderConnections(session)) {
      sendJson(res, 403, { ok: false, error: "provider_connection_admin_required" });
      return null;
    }
    return session;
  }

  async function resolveDepartmentDirectory(res, session, allowStale) {
    try {
      const directory = await getDepartmentDirectory(session, { allowStale });
      if (Array.isArray(directory?.departments) && directory.departments.length > 0) return directory;
    } catch {
      // Fail closed: department governance writes must not fall back to a second authority.
    }
    sendJson(res, 503, {
      ok: false,
      error: "provider_department_directory_unavailable",
      message: "一级部门目录暂不可用，请稍后重试。",
    });
    return null;
  }

  function storeUnavailable(res) {
    return sendJson(res, 503, {
      ok: false,
      error: "provider_connection_governance_store_unavailable",
      message: "Provider 治理状态未能保存，请稍后重试。",
    });
  }

  function canManageProviderConnections(session) {
    const permissions = session?.permissions || [];
    return session?.role === "admin" || hasPermission(permissions, "system:*") || hasPermission(permissions, "provider-connections:*");
  }
}
