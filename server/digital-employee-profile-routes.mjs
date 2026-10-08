const CONTRACT_VERSION = "digital-employee-profile.v1";

export function createDigitalEmployeeProfileHandlers({
  getDigitalEmployees = () => [],
  hasPermission,
  readJsonBody,
  requireSession,
  sendJson,
  store,
} = {}) {
  function handle(req, res, url) {
    const match = url.pathname.match(/^\/api\/digital-employees\/([^/]+)\/profile$/);
    if (req.method === "PUT" && match) {
      return updateProfile(req, res, decodeURIComponent(match[1])).then(() => true);
    }
    return undefined;
  }

  async function updateProfile(req, res, employeeId) {
    const session = requireSession(req, res);
    if (!session) return null;
    const employee = getDigitalEmployees().find((item) => item.id === employeeId);
    if (!employee) return sendJson(res, 404, { ok: false, error: "digital_employee_not_found", contractVersion: CONTRACT_VERSION });
    if (!canManageProfile(session)) {
      return sendJson(res, 403, {
        ok: false,
        error: "digital_employee_profile_admin_required",
        message: "仅系统管理员可修改数字员工展示名称。",
        contractVersion: CONTRACT_VERSION,
      });
    }

    const input = await readJsonBody(req, 4 * 1024);
    const displayName = cleanDisplayName(input.displayName);
    if (displayName.length < 2) return invalid(res, "digital_employee_display_name_too_short", "展示名称至少需要 2 个字符。");
    if (displayName.length > 80) return invalid(res, "digital_employee_display_name_too_long", "展示名称不能超过 80 个字符。");
    if (displayName === cleanDisplayName(employee.name)) {
      return invalid(res, "digital_employee_display_name_unchanged", "展示名称没有变化。");
    }

    const changedAt = new Date().toISOString();
    const profile = {
      contractVersion: CONTRACT_VERSION,
      revisionId: `DEP-${Date.now()}-${cleanId(employee.id).toUpperCase()}`,
      employeeId: employee.id,
      displayName,
      previousDisplayName: cleanDisplayName(employee.name),
      employeeVersion: cleanText(employee.version),
      changedAt,
      changedBy: safeActor(session),
      source: "administrator_applied_profile",
    };
    const saved = store.saveProfile(profile);
    if (!saved.ok) {
      return sendJson(res, 503, {
        ok: false,
        error: "digital_employee_profile_store_unavailable",
        message: "数字员工名称未能保存，请稍后重试。",
        contractVersion: CONTRACT_VERSION,
      });
    }

    return sendJson(res, 200, {
      ok: true,
      contractVersion: CONTRACT_VERSION,
      digitalEmployee: withProfiles([employee])[0],
      message: "展示名称已保存；管理台、桌面端及其他入口下次刷新员工目录后将同步。",
    });
  }

  function withProfiles(employees = []) {
    const appliedProfiles = store.readState().appliedProfiles;
    return employees.map((employee) => {
      const profile = appliedProfiles[employee.id];
      if (!profile?.displayName) return employee;
      return {
        ...employee,
        name: cleanDisplayName(profile.displayName),
        displayNameProfile: {
          contractVersion: CONTRACT_VERSION,
          revisionId: profile.revisionId,
          appliedAt: profile.changedAt,
          source: profile.source,
        },
      };
    });
  }

  function canManageProfile(session = {}) {
    const permissions = session.permissions || [];
    return session.role === "admin" || hasPermission(permissions, "system:*");
  }

  function invalid(res, error, message) {
    return sendJson(res, 422, { ok: false, error, message, contractVersion: CONTRACT_VERSION });
  }

  return { handle, withProfiles };
}

function safeActor(session = {}) {
  return {
    id: cleanId(session.employeeId || session.email || session.name),
    name: cleanText(session.name || session.employeeId || "系统管理员"),
    role: cleanText(session.governanceRole || session.role),
  };
}

function cleanDisplayName(value) {
  return cleanText(value);
}

function cleanId(value) {
  return String(value || "").trim().toLowerCase().replace(/[^a-z0-9._-]+/g, "-").slice(0, 120);
}

function cleanText(value) {
  return String(value || "").replace(/[\u0000-\u001f]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 800);
}
