const MANAGED_SANDBOX_PROFILE_REGISTRY_CONTRACT_VERSION = "managed-sandbox-profile-registry.v1";
const MANAGED_SANDBOX_EXECUTION_ACTION_ID = "sandbox.exec";
const CURRENT_TASK_WORKSPACE_SCOPE = "current_task_workspace";
const LOCAL_DEVELOPMENT_PROFILE_ID = "local_development_standard";
const PROFILE_STATUS_DEFINED_NOT_ENABLED = "defined_not_enabled";
const PROFILE_STATUS_ENABLED = "enabled";
const PROFILE_FIELDS = new Set([
  "actionId", "credentialPolicy", "defaultEmployeeBindingPolicy", "displayName", "executionKind",
  "isolationPolicy", "networkPolicy", "outputPolicy", "profileDigest", "profileId", "profileRevision", "resourcePolicy",
  "scope", "status", "toolchain", "workspaceAccess", "writebackBoundary",
]);
const TOOLCHAIN_CAPABILITIES = Object.freeze(["shell", "python", "node", "git", "curl"]);

const LOCAL_DEVELOPMENT_PROFILE = {
  actionId: MANAGED_SANDBOX_EXECUTION_ACTION_ID,
  credentialPolicy: "none",
  defaultEmployeeBindingPolicy: "all_digital_employees",
  displayName: "本地开发环境",
  executionKind: "generic_command",
  isolationPolicy: "provider_attested",
  networkPolicy: "disabled",
  outputPolicy: "artifact_only",
  profileId: LOCAL_DEVELOPMENT_PROFILE_ID,
  profileRevision: "v1",
  resourcePolicy: "bounded",
  scope: CURRENT_TASK_WORKSPACE_SCOPE,
  status: PROFILE_STATUS_ENABLED,
  toolchain: TOOLCHAIN_CAPABILITIES,
  workspaceAccess: "read_write",
  writebackBoundary: "none",
};
const PROFILES = Object.freeze([Object.freeze({
  ...LOCAL_DEVELOPMENT_PROFILE,
  profileDigest: profileDigest(LOCAL_DEVELOPMENT_PROFILE),
})]);

function managedSandboxProfileRegistry() {
  return PROFILES;
}

function managedSandboxProfileDefinition(profileId = "") {
  return PROFILES.find((profile) => profile.profileId === String(profileId || "")) || null;
}

function managedSandboxProfileSafeProjection(profile = null) {
  if (!isManagedSandboxProfile(profile)) return null;
  return Object.freeze({
    credentialPolicy: profile.credentialPolicy,
    displayName: profile.displayName,
    executionKind: profile.executionKind,
    isolationPolicy: profile.isolationPolicy,
    networkPolicy: profile.networkPolicy,
    outputPolicy: profile.outputPolicy,
    profileDigest: profile.profileDigest,
    profileId: profile.profileId,
    profileRevision: profile.profileRevision,
    resourcePolicy: profile.resourcePolicy,
    scope: profile.scope,
    status: profile.status,
    toolchain: profile.toolchain,
    workspaceAccess: profile.workspaceAccess,
    writebackBoundary: profile.writebackBoundary,
  });
}

function isManagedSandboxProfile(value = null) {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).length !== PROFILE_FIELDS.size ||
    Object.keys(value).some((field) => !PROFILE_FIELDS.has(field))) return false;
  return value.actionId === MANAGED_SANDBOX_EXECUTION_ACTION_ID && value.credentialPolicy === "none" &&
    value.defaultEmployeeBindingPolicy === "all_digital_employees" && typeof value.displayName === "string" && value.displayName.length > 0 &&
    value.executionKind === "generic_command" && value.isolationPolicy === "provider_attested" && value.networkPolicy === "disabled" &&
    value.outputPolicy === "artifact_only" && value.profileId === LOCAL_DEVELOPMENT_PROFILE_ID && value.profileRevision === "v1" &&
    value.resourcePolicy === "bounded" && value.scope === CURRENT_TASK_WORKSPACE_SCOPE &&
    value.status === PROFILE_STATUS_ENABLED && value.workspaceAccess === "read_write" &&
    value.writebackBoundary === "none" && Array.isArray(value.toolchain) && value.toolchain.length === TOOLCHAIN_CAPABILITIES.length &&
    value.toolchain.every((capability, index) => capability === TOOLCHAIN_CAPABILITIES[index]) &&
    value.profileDigest === profileDigest(Object.fromEntries(Object.entries(value).filter(([field]) => field !== "profileDigest")));
}

function profileDigest(value) {
  return `sha256:${crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex")}`;
}

export {
  CURRENT_TASK_WORKSPACE_SCOPE,
  LOCAL_DEVELOPMENT_PROFILE_ID,
  MANAGED_SANDBOX_EXECUTION_ACTION_ID,
  MANAGED_SANDBOX_PROFILE_REGISTRY_CONTRACT_VERSION,
  PROFILE_STATUS_DEFINED_NOT_ENABLED,
  PROFILE_STATUS_ENABLED,
  managedSandboxProfileDefinition,
  managedSandboxProfileRegistry,
  managedSandboxProfileSafeProjection,
  isManagedSandboxProfile,
};
import crypto from "node:crypto";
