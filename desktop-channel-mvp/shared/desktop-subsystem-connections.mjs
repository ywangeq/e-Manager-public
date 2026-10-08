const CONNECTION_MODES = new Set(["device_session_refresh", "current_user_bearer", "center_current_user_lease"]);

export function subsystemConnectionsFromEmployees(employees = []) {
  const byTool = new Map();
  for (const employee of employees) {
    if (employee.access?.selectable !== true || employee.access?.callable !== true) continue;
    for (const tool of employee.tools || []) {
      if (!tool.id || !CONNECTION_MODES.has(tool.credentialMode)) continue;
      let connection = byTool.get(tool.id);
      if (!connection) {
        connection = { id: tool.id, name: tool.name || tool.id, credentialMode: tool.credentialMode, employees: [] };
        byTool.set(tool.id, connection);
      }
      // Conflicting binding modes cannot select a credential adapter.
      if (connection.credentialMode !== tool.credentialMode) connection.credentialMode = "";
      if (!connection.employees.some(item => item.id === employee.id)) {
        connection.employees.push({ id: employee.id, name: employee.name || employee.id });
      }
    }
  }
  return [...byTool.values()];
}

export function projectDataflowCredentialStatus({ brokerStatus = {}, runtimeState = {}, configured = false, transportReady = false } = {}) {
  // Only the broker can prove readiness; a prior notification cannot resurrect an expired token.
  const status = !configured ? "not_configured"
    : ["checking", "blocked", "degraded"].includes(runtimeState.status) ? runtimeState.status
      : brokerStatus.status === "ready" ? "ready"
      : runtimeState.status === "ready" ? "refresh_required" : runtimeState.status || "refresh_required";
  return {
    toolId: "dataflow-rest-api", status, code: runtimeState.code || "", configured, transportReady,
    expiresAt: brokerStatus.status === "ready" ? brokerStatus.expiresAt || "" : "",
    expiryKnown: brokerStatus.expiryKnown === true,
    authenticatedAt: brokerStatus.authenticatedAt || "",
    checkedAt: brokerStatus.checkedAt || "",
    verifiedAt: brokerStatus.verifiedAt || "",
  };
}

export function subsystemAuthenticationState(value = {}) {
  if (value.configured === false || value.status === "not_configured") return "not_configured";
  if (value.transportReady === false) return "unavailable";
  if (value.status === "checking") return "checking";
  if (["dataflow_identity_mismatch", "dataflow_identity_probe_forbidden"].includes(value.code)) return "account_blocked";
  if (["dataflow_interactive_login_required", "dataflow_refreshed_token_rejected"].includes(value.code)) {
    return value.authenticatedAt || value.verifiedAt ? "expired" : "disconnected";
  }
  if (["dataflow_logged_out", "dataflow_local_session_cleared"].includes(value.code)) return "disconnected";
  if (["blocked", "degraded"].includes(value.status)) return "unavailable";
  if (value.status === "ready") return "authenticated";
  if (value.status === "refresh_required") return "verification_required";
  return "unknown";
}
