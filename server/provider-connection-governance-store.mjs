import fs from "node:fs";
import path from "node:path";

const CONTRACT_VERSION = "provider-connection-governance.v1";

export function createProviderConnectionGovernanceStore({ storePath, redactError = String } = {}) {
  const filePath = storePath || path.join(process.cwd(), "data", "local", "provider-connection-governance.json");

  function readState() {
    try {
      if (!fs.existsSync(filePath)) return emptyState();
      const parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
      if (!parsed || typeof parsed !== "object") return emptyState();
      return {
        contractVersion: CONTRACT_VERSION,
        routeOverrides: objectValue(parsed.routeOverrides),
        credentialOverrides: objectValue(parsed.credentialOverrides),
        updatedAt: String(parsed.updatedAt || ""),
      };
    } catch (error) {
      console.warn("[provider-connection-governance-store] failed to read store:", redactError(error));
      return emptyState();
    }
  }

  function setRouteEnabled(routeId, enabled, actor = {}) {
    return updateState((state, audit) => {
      state.routeOverrides[routeId] = { ...state.routeOverrides[routeId], enabled, ...audit };
    }, actor);
  }

  function setRouteExecutionLimits(routeId, limits, actor = {}) {
    return updateState((state, audit) => { state.routeOverrides[routeId] = { ...state.routeOverrides[routeId], ...limits, ...audit }; }, actor);
  }

  function setCredentialDepartment(credentialId, departmentId, actor = {}) {
    return updateState((state, audit) => {
      state.credentialOverrides[credentialId] = { departmentId, ...audit };
    }, actor);
  }

  function updateState(mutator, actor) {
    try {
      const state = readState();
      const updatedAt = new Date().toISOString();
      mutator(state, {
        updatedAt,
        updatedBy: actor.employeeId || actor.email || actor.name || "system-admin",
      });
      state.updatedAt = updatedAt;
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.writeFileSync(filePath, `${JSON.stringify(state, null, 2)}\n`);
      return { ok: true, state, updatedAt };
    } catch (error) {
      console.warn("[provider-connection-governance-store] failed to write store:", redactError(error));
      return { ok: false, error: "provider_connection_governance_store_unavailable" };
    }
  }

  return { filePath, readState, setCredentialDepartment, setRouteEnabled, setRouteExecutionLimits };
}

function emptyState() {
  return {
    contractVersion: CONTRACT_VERSION,
    routeOverrides: {},
    credentialOverrides: {},
    updatedAt: "",
  };
}

function objectValue(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}
