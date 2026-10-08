import {
  ALGORITHM_EMPLOYEE_ID,
  ALGORITHM_EMPLOYEE_VERSION,
  DIGITAL_EMPLOYEE_IDENTITY_COMPATIBILITY,
  LEGACY_ALGORITHM_EMPLOYEE_ID,
  canonicalDigitalEmployeeId,
  digitalEmployeeReadIds,
  isSameDigitalEmployeeIdentity,
  resolveDigitalEmployeeByReadId,
  resolveDigitalEmployeeReadIdentity,
} from "../src/data/digitalEmployeeIdentity.js";

const READ_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

function resolveDigitalEmployeeRequestIdentity({ employeeId = "", method = "GET", allowLegacyMutation = false } = {}) {
  const identity = resolveDigitalEmployeeReadIdentity(employeeId);
  if (!identity) return Object.freeze({ ok: false, error: "digital_employee_id_invalid" });
  if (identity.isLegacyReadAlias && !allowLegacyMutation && !READ_METHODS.has(String(method || "GET").toUpperCase())) {
    return Object.freeze({
      ok: false,
      error: "digital_employee_identity_alias_read_only",
      canonicalEmployeeId: identity.canonicalEmployeeId,
    });
  }
  return Object.freeze({ ok: true, ...identity });
}

function projectCanonicalEmployeeId(value = "") {
  return canonicalDigitalEmployeeId(value) || String(value || "").trim();
}

export {
  ALGORITHM_EMPLOYEE_ID,
  ALGORITHM_EMPLOYEE_VERSION,
  DIGITAL_EMPLOYEE_IDENTITY_COMPATIBILITY,
  LEGACY_ALGORITHM_EMPLOYEE_ID,
  canonicalDigitalEmployeeId,
  digitalEmployeeReadIds,
  isSameDigitalEmployeeIdentity,
  projectCanonicalEmployeeId,
  resolveDigitalEmployeeByReadId,
  resolveDigitalEmployeeReadIdentity,
  resolveDigitalEmployeeRequestIdentity,
};
