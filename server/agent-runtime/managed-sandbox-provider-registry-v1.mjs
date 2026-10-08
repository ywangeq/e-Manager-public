import { managedSandboxProfileRegistry } from "./managed-sandbox-profile-registry-v1.mjs";

const MANAGED_SANDBOX_PROVIDER_REGISTRY_CONTRACT_VERSION = "managed-sandbox-provider-registry.v1";
const REQUIRED_CAPABILITIES = Object.freeze([
  "cancellation_child_cleanup",
  "network_deny",
  "process_tree_containment",
  "resource_limits",
  "workspace_mount_isolation",
]);
const PROVIDER_FIELDS = new Set([
  "attestation", "availability", "capabilities", "implementationDigest", "platform", "providerId",
  "providerRevision", "supportedProfileDigests", "toolchainDigests",
]);
const ATTESTATION_FIELDS = new Set(["attestationDigest", "issuedAt", "witnessSuiteVersion"]);
const DIGEST = /^sha256:[a-f0-9]{64}$/;
const TOKEN = /^[a-z][a-z0-9._-]{0,79}$/;

function createManagedSandboxProviderRegistry({ providers = [], now = () => new Date().toISOString(), profiles = managedSandboxProfileRegistry() } = {}) {
  const profilesByDigest = new Map(profiles.map((profile) => [profile.profileDigest, profile]));
  const entries = normalizeProviders(providers, profilesByDigest, now);

  function resolveReadyProvider({ profileDigest = "" } = {}) {
    const profile = profilesByDigest.get(String(profileDigest || ""));
    if (!profile) return null;
    return profile.status === "enabled" ? entries.find((provider) => provider.availability === "ready" &&
      provider.supportedProfileDigests.includes(profile.profileDigest)) || null : null;
  }

  function safeProjection() {
    return Object.freeze(entries.map((provider) => Object.freeze({
      availability: provider.availability,
      platform: provider.platform,
      providerRevision: provider.providerRevision,
      supportedProfileDigests: provider.supportedProfileDigests,
    })));
  }

  return Object.freeze({ resolveReadyProvider, safeProjection });
}

function normalizeProviders(providers, profilesByDigest, now) {
  if (!Array.isArray(providers)) throw providerError("managed_sandbox_provider_registry_invalid");
  const ids = new Set();
  return Object.freeze(providers.map((provider) => {
    exactObject(provider, PROVIDER_FIELDS);
    if (!TOKEN.test(provider.providerId) || !TOKEN.test(provider.providerRevision) || ids.has(provider.providerId) ||
      !["center_managed", "device_managed"].includes(provider.platform) || !DIGEST.test(provider.implementationDigest) ||
      !["ready", "unavailable"].includes(provider.availability)) {
      throw providerError("managed_sandbox_provider_registry_invalid");
    }
    ids.add(provider.providerId);
    const supportedProfileDigests = normalizeDigests(provider.supportedProfileDigests);
    if (!supportedProfileDigests.length || supportedProfileDigests.some((digest) => !profilesByDigest.has(digest))) {
      throw providerError("managed_sandbox_provider_profile_invalid");
    }
    const toolchainDigests = normalizeDigests(provider.toolchainDigests);
    if (!toolchainDigests.length) throw providerError("managed_sandbox_provider_toolchain_invalid");
    const capabilities = normalizeCapabilities(provider.capabilities);
    const attestation = normalizeAttestation(provider.attestation, now);
    return Object.freeze({ ...provider, attestation, capabilities, supportedProfileDigests, toolchainDigests });
  }));
}

function normalizeAttestation(value, now) {
  exactObject(value, ATTESTATION_FIELDS);
  if (!DIGEST.test(value.attestationDigest) || !TOKEN.test(value.witnessSuiteVersion)) {
    throw providerError("managed_sandbox_provider_attestation_invalid");
  }
  const issuedAt = timestamp(value.issuedAt);
  if (issuedAt > now()) throw providerError("managed_sandbox_provider_attestation_invalid");
  return Object.freeze({ attestationDigest: value.attestationDigest, issuedAt, witnessSuiteVersion: value.witnessSuiteVersion });
}

function normalizeCapabilities(value) {
  if (!Array.isArray(value) || value.length !== REQUIRED_CAPABILITIES.length ||
    value.some((capability, index) => capability !== REQUIRED_CAPABILITIES[index])) {
    throw providerError("managed_sandbox_provider_capability_invalid");
  }
  return REQUIRED_CAPABILITIES;
}

function normalizeDigests(value) {
  if (!Array.isArray(value) || !value.length || value.length > 20 || value.some((digest) => !DIGEST.test(digest))) {
    throw providerError("managed_sandbox_provider_registry_invalid");
  }
  return Object.freeze([...new Set(value)].sort());
}

function timestamp(value) {
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime())) throw providerError("managed_sandbox_provider_attestation_invalid");
  return parsed.toISOString();
}

function exactObject(value, fields) {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).length !== fields.size ||
    Object.keys(value).some((field) => !fields.has(field))) throw providerError("managed_sandbox_provider_registry_invalid");
}

function providerError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

export { MANAGED_SANDBOX_PROVIDER_REGISTRY_CONTRACT_VERSION, REQUIRED_CAPABILITIES, createManagedSandboxProviderRegistry };
