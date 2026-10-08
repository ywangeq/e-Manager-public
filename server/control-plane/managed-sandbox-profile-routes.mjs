import {
  MANAGED_SANDBOX_PROFILE_REGISTRY_CONTRACT_VERSION,
  managedSandboxProfileRegistry,
  managedSandboxProfileSafeProjection,
} from "../agent-runtime/managed-sandbox-profile-registry-v1.mjs";

export function createManagedSandboxProfileHandlers({ canManage, optionalSession, sendJson }) {
  function listManagedSandboxProfiles(req, res) {
    const session = optionalSession(req);
    if (!session) {
      return sendJson(res, 401, { ok: false, error: "authentication_required", contractVersion: MANAGED_SANDBOX_PROFILE_REGISTRY_CONTRACT_VERSION });
    }
    if (!canManage(session)) {
      return sendJson(res, 403, { ok: false, error: "control_plane_governance_required", contractVersion: MANAGED_SANDBOX_PROFILE_REGISTRY_CONTRACT_VERSION });
    }
    return sendJson(res, 200, {
      ok: true,
      status: "ready",
      contractVersion: MANAGED_SANDBOX_PROFILE_REGISTRY_CONTRACT_VERSION,
      executionBoundary: "profile_definition_only_no_runner_execution",
      profiles: managedSandboxProfileRegistry().map(managedSandboxProfileSafeProjection),
    });
  }

  return { listManagedSandboxProfiles };
}
