const TOOL_AUTHORIZATION_POLICY_CONTRACT = "tool-authorization-policy.v2";
const LEGACY_TOOL_AUTHORIZATION_POLICY_CONTRACT = "tool-authorization-policy.v1";
const DIGEST_PATTERN = /^sha256:[a-f0-9]{64}$/;

function resolveToolAuthorizationPolicy(binding = {}) {
  const allowedCapabilities = [...new Set(cleanList(binding.allowedCapabilities, 100).map((value) => value.toLowerCase()))];
  const allowedRisks = cleanList(binding.allowedRisks, 10);
  const contractDigest = cleanText(binding.contractDigest, 96);
  const approvedWritePolicyDigests = cleanDigestMap(binding.approvedWritePolicyDigests);
  const policyContractDigest = cleanText(binding.policyContractDigest, 96);
  const declaredMode = cleanText(binding.policyMode, 80);
  const rawApprovedWritePolicyDigests = binding.approvedWritePolicyDigests && typeof binding.approvedWritePolicyDigests === "object" && !Array.isArray(binding.approvedWritePolicyDigests)
    ? binding.approvedWritePolicyDigests
    : {};
  const v2PolicyDeclared = Boolean(contractDigest) || Object.keys(rawApprovedWritePolicyDigests).length > 0;
  const capabilityPolicyDeclared = declaredMode === "contract_capability" || allowedCapabilities.length > 0 || allowedRisks.length > 0 || Boolean(policyContractDigest) || v2PolicyDeclared;

  if (declaredMode && !["contract_capability", "legacy_operation_allowlist"].includes(declaredMode)) {
    return {
      contractVersion: TOOL_AUTHORIZATION_POLICY_CONTRACT,
      mode: "invalid",
      valid: false,
      invalidReason: "tool_authorization_policy_mode_invalid",
    };
  }

  if (capabilityPolicyDeclared) {
    if (v2PolicyDeclared) {
      const approvedCapabilities = Object.keys(approvedWritePolicyDigests).sort();
      const expectedCapabilities = [...allowedCapabilities].sort();
      const rawApprovedDigestCount = Object.keys(rawApprovedWritePolicyDigests).length;
      const valid = allowedCapabilities.length > 0 && DIGEST_PATTERN.test(contractDigest) &&
        rawApprovedDigestCount === approvedCapabilities.length &&
        approvedCapabilities.length === expectedCapabilities.length &&
        approvedCapabilities.every((capability, index) => capability === expectedCapabilities[index]);
      return {
        contractVersion: TOOL_AUTHORIZATION_POLICY_CONTRACT,
        mode: "contract_capability",
        valid,
        allowedCapabilities,
        allowedRisks,
        contractDigest,
        approvedWritePolicyDigests,
        ...(valid ? {} : { invalidReason: allowedCapabilities.length ? "tool_policy_write_digests_invalid" : "tool_policy_capabilities_required" }),
        ...(cleanList(binding.allowedOperations, 500).length ? { legacyOperationsIgnored: true } : {}),
      };
    }
    const valid = allowedCapabilities.length > 0 && DIGEST_PATTERN.test(policyContractDigest);
    return {
      contractVersion: LEGACY_TOOL_AUTHORIZATION_POLICY_CONTRACT,
      mode: "contract_capability",
      valid,
      allowedCapabilities,
      allowedRisks,
      policyContractDigest,
      ...(valid ? {} : { invalidReason: allowedCapabilities.length ? "tool_policy_contract_digest_invalid" : "tool_policy_capabilities_required" }),
      ...(cleanList(binding.allowedOperations, 500).length ? { legacyOperationsIgnored: true } : {}),
    };
  }

  return {
    contractVersion: LEGACY_TOOL_AUTHORIZATION_POLICY_CONTRACT,
    mode: "legacy_operation_allowlist",
    valid: true,
    deprecated: true,
    allowedOperations: cleanList(binding.allowedOperations, 500),
  };
}

function cleanDigestMap(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.fromEntries(Object.entries(value)
    .slice(0, 100)
    .map(([capability, digest]) => [cleanText(capability, 180).toLowerCase(), cleanText(digest, 96)])
    .filter(([capability, digest]) => /^[a-z0-9_.:-]{1,180}$/.test(capability) && DIGEST_PATTERN.test(digest)));
}

function cleanList(value, max) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map((item) => cleanText(item, 240)).filter(Boolean))].slice(0, max);
}

function cleanText(value = "", max = 240) {
  return String(value || "").trim().slice(0, max);
}

export { LEGACY_TOOL_AUTHORIZATION_POLICY_CONTRACT, TOOL_AUTHORIZATION_POLICY_CONTRACT, resolveToolAuthorizationPolicy };
