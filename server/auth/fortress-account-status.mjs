const ACTIVE_VALUES = new Set(["active", "enabled", "normal", "在职", "正常", "启用"]);
const DISABLED_VALUES = new Set(["disabled", "inactive", "suspended", "closed", "deactivated", "离职", "停用", "禁用", "关闭"]);
const BLOCKED_VALUES = new Set(["blocked", "blacklisted", "blacklist", "封禁", "黑名单"]);

const BLOCKED_BOOLEAN_FIELDS = ["IsBlacklisted", "Blacklisted", "IsBlocked", "Blocked"];
const DISABLED_BOOLEAN_FIELDS = ["IsDisabled", "Disabled"];
const ACTIVE_BOOLEAN_FIELDS = ["IsActive", "Active", "IsEnabled", "Enabled"];
const STATUS_FIELDS = ["AccountStatus", "UserStatus", "EmploymentStatus", "Status"];

export function projectFortressAccountStatus(member = {}) {
  const blockedField = firstBooleanField(member, BLOCKED_BOOLEAN_FIELDS, true);
  if (blockedField) return projection("blocked", blockedField, true);

  const disabledField = firstBooleanField(member, DISABLED_BOOLEAN_FIELDS, true);
  if (disabledField) return projection("disabled", disabledField, true);

  const activeField = firstBooleanField(member, ACTIVE_BOOLEAN_FIELDS, false);
  if (activeField) return projection("disabled", activeField, true);

  const explicitActiveField = firstBooleanField(member, ACTIVE_BOOLEAN_FIELDS, true);
  if (explicitActiveField) return projection("active", explicitActiveField, true);

  for (const field of STATUS_FIELDS) {
    const value = normalizedStatus(member[field]);
    if (!value) continue;
    if (BLOCKED_VALUES.has(value)) return projection("blocked", field, true);
    if (DISABLED_VALUES.has(value)) return projection("disabled", field, true);
    if (ACTIVE_VALUES.has(value)) return projection("active", field, true);
  }

  return projection("active", "member_resolved", false);
}

export function activeDemoAccountProjection() {
  return {
    accountStatus: "active",
    identitySource: "demo-directory",
    sourceField: "demo_account",
    explicitStatusEvidence: true,
  };
}

function projection(accountStatus, sourceField, explicitStatusEvidence) {
  return {
    accountStatus,
    identitySource: "fortress-sso-v3",
    sourceField,
    explicitStatusEvidence,
  };
}

function firstBooleanField(member, fields, expected) {
  return fields.find((field) => explicitBoolean(member[field]) === expected) || "";
}

function explicitBoolean(value) {
  if (value === true || value === false) return value;
  const normalized = String(value ?? "").trim().toLowerCase();
  if (["true", "1", "yes"].includes(normalized)) return true;
  if (["false", "0", "no"].includes(normalized)) return false;
  return null;
}

function normalizedStatus(value) {
  if (typeof value !== "string" && typeof value !== "number") return "";
  return String(value).replace(/\s+/g, "").trim().toLowerCase();
}
