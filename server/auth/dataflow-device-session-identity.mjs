const DATAFLOW_ENTERPRISE_USERNAME_TYPE = "verified_enterprise_username";

function dataFlowExpectedEnterpriseIdentity(session = {}) {
  const identitySource = String(session.authorization?.identitySource || session.identitySource || "").trim();
  if (identitySource !== "fortress-sso-v3") return null;
  const username = canonicalDataFlowEnterpriseUsername(session.nickName);
  if (!username) return null;
  return Object.freeze({ type: DATAFLOW_ENTERPRISE_USERNAME_TYPE, value: username });
}

function canonicalDataFlowEnterpriseUsername(value) {
  if (typeof value !== "string") return "";
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value)) return "";
  return value.toLowerCase();
}

export {
  DATAFLOW_ENTERPRISE_USERNAME_TYPE,
  canonicalDataFlowEnterpriseUsername,
  dataFlowExpectedEnterpriseIdentity,
};
