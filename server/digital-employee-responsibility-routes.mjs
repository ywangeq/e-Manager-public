import { newerEmployeeVersion, nextEmployeeVersion } from "./digital-employee-department-change-routes.mjs";

const CONTRACT_VERSION = "digital-employee-responsibility.v1";
const SECONDARY_ROLES = ["technicalOwner", "qualityReviewer", "alertReceiver"];

export function createDigitalEmployeeResponsibilityHandlers({
  getDirectory = async () => ({ departments: [], personnel: [], source: "unavailable" }),
  getDigitalEmployees = () => [],
  hasPermission,
  readJsonBody,
  requireSession,
  sendJson,
  store,
} = {}) {
  async function handle(req, res, url) {
    const employeeMatch = url.pathname.match(/^\/api\/digital-employees\/([^/]+)\/responsibilities$/);
    if (employeeMatch && req.method === "GET") {
      return getContext(req, res, decodeURIComponent(employeeMatch[1])).then(() => true);
    }
    if (employeeMatch && req.method === "PUT") {
      return submitRevision(req, res, decodeURIComponent(employeeMatch[1])).then(() => true);
    }
    const decisionMatch = url.pathname.match(/^\/api\/digital-employees\/([^/]+)\/responsibilities\/decision$/);
    if (decisionMatch && req.method === "POST") {
      return decideRevision(req, res, decodeURIComponent(decisionMatch[1])).then(() => true);
    }
    return undefined;
  }

  async function getContext(req, res, employeeId) {
    const session = requireSession(req, res);
    if (!session) return null;
    const employee = findEmployee(employeeId);
    if (!employee) return notFound(res);
    if (!canConfigure(session, employee) && !canReview(session)) return forbidden(res);
    const directory = await resolveDirectory(res, session);
    if (!directory) return null;
    return sendJson(res, 200, buildContext(employee, session, directory));
  }

  async function submitRevision(req, res, employeeId) {
    const session = requireSession(req, res);
    if (!session) return null;
    const employee = findEmployee(employeeId);
    if (!employee) return notFound(res);
    if (!canConfigure(session, employee)) return forbidden(res);
    const directory = await resolveDirectory(res, session);
    if (!directory) return null;
    const input = await readJsonBody(req, 16 * 1024);
    const normalized = normalizeAssignments(input.assignments, directory.personnel, directory.departments);
    if (!normalized.ok) return invalid(res, normalized.error, normalized.message);
    const note = cleanText(input.note);
    if (note.length < 4) return invalid(res, "responsibility_note_required", "请填写至少 4 个字的变更说明。");
    const current = secondaryAssignments(employee.responsibilityAssignments);
    if (sameAssignments(current, normalized.assignments)) {
      return invalid(res, "responsibility_assignments_unchanged", "责任分工没有变化。");
    }
    const state = store.readState();
    if (state.pendingRevisions[employee.id]) {
      return sendJson(res, 409, {
        ok: false,
        error: "responsibility_revision_pending",
        message: "该数字员工已有待审核的责任分工变更。",
        contractVersion: CONTRACT_VERSION,
      });
    }
    const now = new Date().toISOString();
    const applyImmediately = isSystemAdmin(session);
    const nextVersion = nextEmployeeVersion(employee.version, now);
    const revision = {
      id: `DER-${Date.now()}-${cleanId(employee.id).toUpperCase()}`,
      employeeId: employee.id,
      employeeName: cleanText(employee.name || employee.id),
      employeeVersion: cleanText(employee.version),
      nextEmployeeVersion: nextVersion,
      status: applyImmediately ? "applied" : "pending_review",
      current,
      target: normalized.assignments,
      note,
      submittedAt: now,
      updatedAt: now,
      submittedBy: safeActor(session),
      decision: applyImmediately ? { outcome: "approved", decidedAt: now, decidedBy: safeActor(session) } : null,
    };
    const appliedRecord = applyImmediately ? appliedRecordFor(revision, session) : null;
    const saved = store.saveSubmission(revision, appliedRecord);
    if (!saved.ok) return unavailable(res);
    const digitalEmployee = withResponsibilities([employee])[0];
    return sendJson(res, applyImmediately ? 200 : 202, {
      ok: true,
      contractVersion: CONTRACT_VERSION,
      status: revision.status,
      revision,
      digitalEmployee,
      message: applyImmediately
        ? "责任分工已保存并生效。"
        : "责任分工变更已提交审核；审核通过前继续使用当前责任配置。",
    });
  }

  async function decideRevision(req, res, employeeId) {
    const session = requireSession(req, res);
    if (!session) return null;
    if (!canReview(session)) return forbidden(res, "responsibility_review_required", "当前账号没有责任分工审核权限。");
    const employee = findEmployee(employeeId);
    if (!employee) return notFound(res);
    const revision = store.readState().pendingRevisions[employee.id];
    if (!revision) return invalid(res, "responsibility_revision_not_found", "没有待审核的责任分工变更。");
    const input = await readJsonBody(req, 8 * 1024);
    const decision = cleanText(input.decision);
    if (!new Set(["approved", "rejected"]).has(decision)) {
      return invalid(res, "responsibility_decision_required", "请选择通过或驳回。");
    }
    const now = new Date().toISOString();
    const decided = {
      ...revision,
      status: decision === "approved" ? "applied" : "rejected",
      updatedAt: now,
      decision: {
        outcome: decision,
        note: cleanText(input.note),
        decidedAt: now,
        decidedBy: safeActor(session),
      },
    };
    const appliedRecord = decision === "approved" ? appliedRecordFor(decided, session) : null;
    const saved = store.saveDecision(decided, appliedRecord);
    if (!saved.ok) return unavailable(res);
    return sendJson(res, 200, {
      ok: true,
      contractVersion: CONTRACT_VERSION,
      status: decided.status,
      revision: decided,
      digitalEmployee: withResponsibilities([employee])[0],
      message: decision === "approved" ? "责任分工变更已通过并生效。" : "责任分工变更已驳回。",
    });
  }

  function buildContext(employee, session, directory) {
    const pendingRevision = store.readState().pendingRevisions[employee.id] || null;
    return {
      ok: true,
      contractVersion: CONTRACT_VERSION,
      employee: safeEmployee(employee),
      assignments: employee.responsibilityAssignments,
      pendingRevision,
      canConfigure: canConfigure(session, employee),
      canReview: canReview(session),
      appliesImmediately: isSystemAdmin(session),
      directory: {
        source: cleanText(directory.source),
        generatedAt: cleanText(directory.generatedAt),
      },
      assigneeOptions: directory.personnel.map((person) => safePerson(
        person,
        directory.departments?.find((department) => cleanDepartmentId(department.id) === cleanDepartmentId(person.departmentId))?.name,
      )),
      persistence: {
        kind: "mvp-file-store",
        productionReady: false,
        boundary: "业务 Owner 从资产归属自动投影；技术 Owner、质量审核和告警接收以独立责任修订记录保存。",
      },
    };
  }

  function withResponsibilities(employees = []) {
    const appliedAssignments = store.readState().appliedAssignments;
    return employees.map((employee) => {
      const applied = appliedAssignments[employee.id];
      const source = employee.responsibilityAssignments && typeof employee.responsibilityAssignments === "object"
        ? employee.responsibilityAssignments
        : {};
      const assignments = {
        contractVersion: CONTRACT_VERSION,
        businessOwner: businessOwnerAssignment(employee),
      };
      for (const role of SECONDARY_ROLES) {
        assignments[role] = applied && Object.hasOwn(applied.assignments || {}, role)
          ? applied.assignments[role]
          : source[role] || null;
      }
      return {
        ...employee,
        version: newerEmployeeVersion(employee.version, applied?.version),
        responsibilityAssignments: assignments,
        responsibilityRevision: applied ? {
          revisionId: applied.revisionId,
          appliedAt: applied.appliedAt,
          source: applied.source,
        } : employee.responsibilityRevision,
      };
    });
  }

  function findEmployee(employeeId) {
    const employees = typeof getDigitalEmployees === "function" ? getDigitalEmployees() : [];
    return (Array.isArray(employees) ? employees : []).find((item) => item.id === employeeId);
  }

  function canConfigure(session = {}, employee = {}) {
    const permissions = session.permissions || [];
    if (isSystemAdmin(session) || hasPermission(permissions, "digital-employees:configure")) return true;
    const managed = new Set(Array.isArray(session.managedDepartmentIds) ? session.managedDepartmentIds : []);
    const departmentIds = [employee.ownerDepartmentId, employee.departmentId, ...(employee.departmentIds || [])].filter(Boolean);
    if (managed.has("*") || departmentIds.some((departmentId) => managed.has(departmentId))) return true;
    const actorIds = new Set([session.employeeId, session.feishuUserId, session.employeeNo, session.email].filter(Boolean).map(cleanId));
    return [employee.ownerUserId, employee.ownerEmail].filter(Boolean).map(cleanId).some((ownerId) => actorIds.has(ownerId));
  }

  function canReview(session = {}) {
    return isSystemAdmin(session);
  }

  function isSystemAdmin(session = {}) {
    return session.role === "admin" || hasPermission(session.permissions || [], "system:*");
  }

  async function resolveDirectory(res, session) {
    try {
      const directory = await getDirectory(session);
      if (!Array.isArray(directory?.personnel)) return unavailableDirectory(res);
      return directory;
    } catch {
      return unavailableDirectory(res);
    }
  }

  function invalid(res, error, message) {
    return sendJson(res, 422, { ok: false, error, message, contractVersion: CONTRACT_VERSION });
  }

  function forbidden(res, error = "responsibility_configuration_required", message = "当前账号没有该数字员工的责任配置权限。") {
    return sendJson(res, 403, { ok: false, error, message, contractVersion: CONTRACT_VERSION });
  }

  function notFound(res) {
    return sendJson(res, 404, { ok: false, error: "digital_employee_not_found", contractVersion: CONTRACT_VERSION });
  }

  function unavailable(res) {
    return sendJson(res, 503, { ok: false, error: "responsibility_store_unavailable", message: "责任分工暂时无法保存，请稍后重试。", contractVersion: CONTRACT_VERSION });
  }

  function unavailableDirectory(res) {
    sendJson(res, 503, { ok: false, error: "responsibility_directory_unavailable", message: "人员目录暂时不可用，责任分工已停止写入。", contractVersion: CONTRACT_VERSION });
    return null;
  }

  return { handle, withResponsibilities };
}

function normalizeAssignments(value, personnel = [], departments = []) {
  const input = value && typeof value === "object" ? value : {};
  const assignments = {};
  for (const role of SECONDARY_ROLES) {
    const requested = input[role];
    if (!requested?.assigneeId) {
      assignments[role] = null;
      continue;
    }
    const assigneeId = cleanId(requested.assigneeId);
    const departmentId = cleanDepartmentId(requested.departmentId);
    const person = personnel.find((item) => cleanId(item.id) === assigneeId && cleanDepartmentId(item.departmentId) === departmentId);
    if (!person) {
      return { ok: false, error: "responsibility_assignee_invalid", message: "请选择人员目录中的有效责任人。" };
    }
    const departmentName = departments.find((department) => cleanDepartmentId(department.id) === departmentId)?.name;
    assignments[role] = assignmentFromPerson(person, departmentName);
  }
  return { ok: true, assignments };
}

function businessOwnerAssignment(employee = {}) {
  const assigneeId = cleanId(employee.ownerUserId);
  const assigneeName = cleanText(employee.owner);
  const departmentId = cleanDepartmentId(employee.ownerDepartmentId || employee.departmentId);
  const departmentName = cleanText(employee.department);
  const assigned = Boolean(assigneeId && assigneeName && departmentId);
  return {
    departmentId,
    departmentName,
    assigneeType: assigned ? "user" : "",
    assigneeId: assigned ? assigneeId : "",
    assigneeName: assigned ? assigneeName : "",
    status: assigned ? "assigned" : "pending_human_assignment",
    requiredBeforeOnline: true,
    source: "asset_ownership_projection",
  };
}

function assignmentFromPerson(person = {}, departmentName = "") {
  return {
    departmentId: cleanDepartmentId(person.departmentId),
    departmentName: cleanText(person.departmentName || person.department || departmentName || person.departmentId),
    assigneeType: "user",
    assigneeId: cleanId(person.id),
    assigneeName: cleanText(person.name || person.id),
    status: "assigned",
    requiredBeforeOnline: true,
  };
}

function secondaryAssignments(source = {}) {
  return Object.fromEntries(SECONDARY_ROLES.map((role) => [role, source?.[role] || null]));
}

function appliedRecordFor(revision, session) {
  return {
    employeeId: revision.employeeId,
    version: revision.nextEmployeeVersion,
    assignments: revision.target,
    revisionId: revision.id,
    appliedAt: revision.decision?.decidedAt || revision.updatedAt,
    appliedBy: safeActor(session),
    source: "approved_responsibility_revision",
  };
}

function safeEmployee(employee = {}) {
  return {
    id: cleanId(employee.id),
    name: cleanText(employee.name),
    version: cleanText(employee.version),
    ownerDepartmentId: cleanDepartmentId(employee.ownerDepartmentId || employee.departmentId),
    ownerUserId: cleanId(employee.ownerUserId),
    owner: cleanText(employee.owner),
    department: cleanText(employee.department),
  };
}

function safePerson(person = {}, departmentName = "") {
  return {
    id: cleanId(person.id),
    name: cleanText(person.name || person.id),
    departmentId: cleanDepartmentId(person.departmentId),
    departmentName: cleanText(person.departmentName || person.department || departmentName || person.departmentId),
    role: cleanText(person.governanceRole || person.role),
  };
}

function safeActor(session = {}) {
  return {
    id: cleanId(session.employeeId || session.email || session.name),
    name: cleanText(session.name || session.email || session.employeeId),
    departmentId: cleanDepartmentId(session.departmentId),
    role: cleanText(session.governanceRole || session.role),
  };
}

function sameAssignments(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function cleanId(value) {
  return String(value || "").trim().toLowerCase().replace(/[^a-z0-9._-]+/g, "-").slice(0, 120);
}

function cleanDepartmentId(value) {
  return String(value || "").trim().replace(/^\/+|\/+$/g, "").slice(0, 800);
}

function cleanText(value) {
  return String(value || "").replace(/[\u0000-\u001f]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 800);
}
