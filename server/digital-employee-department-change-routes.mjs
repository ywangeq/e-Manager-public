const CONTRACT_VERSION = "digital-employee-department-change.v1";
const ACTIVE_STATUSES = new Set(["pending_review", "approved_scheduled"]);

export function createDigitalEmployeeDepartmentChangeHandlers({
  businessSkills = [],
  getDirectory = async () => ({ departments: [], personnel: [], source: "unavailable" }),
  getDigitalEmployees = () => [],
  hasPermission,
  readJsonBody,
  requireSession,
  sendJson,
  store,
} = {}) {
  async function handle(req, res, url) {
    if (url.pathname === "/api/digital-employee-department-changes" && req.method === "GET") {
      return listRequests(req, res).then(() => true);
    }
    const employeeMatch = url.pathname.match(/^\/api\/digital-employees\/([^/]+)\/department-change$/);
    if (employeeMatch && req.method === "GET") {
      return getContext(req, res, decodeURIComponent(employeeMatch[1])).then(() => true);
    }
    if (employeeMatch && req.method === "POST") {
      return createRequest(req, res, decodeURIComponent(employeeMatch[1])).then(() => true);
    }
    const decisionMatch = url.pathname.match(/^\/api\/digital-employee-department-changes\/([^/]+)\/decision$/);
    if (decisionMatch && req.method === "POST") {
      return decideRequest(req, res, decodeURIComponent(decisionMatch[1])).then(() => true);
    }
    return undefined;
  }

  async function listRequests(req, res) {
    const session = requireSession(req, res);
    if (!session) return null;
    const requests = store.readState().requests
      .map(effectiveRequestStatus)
      .filter((request) => canReview(session, request))
      .map((request) => ({
        ...request,
        reviewPolicy: {
          canDecide: request.status === "pending_review",
        },
      }));
    return sendJson(res, 200, { ok: true, contractVersion: CONTRACT_VERSION, requests });
  }

  async function getContext(req, res, employeeId) {
    const session = requireSession(req, res);
    if (!session) return null;
    const employee = findEmployee(employeeId);
    if (!employee) return notFound(res);
    if (!canSubmit(session, employee)) return forbidden(res, "digital_employee_department_change_required", "当前账号没有该数字员工的归属变更权限。");
    const directory = await resolveDirectory(res, session);
    if (!directory) return null;
    return sendJson(res, 200, buildContext(employee, session, directory));
  }

  async function createRequest(req, res, employeeId) {
    const session = requireSession(req, res);
    if (!session) return null;
    const employee = findEmployee(employeeId);
    if (!employee) return notFound(res);
    if (!canSubmit(session, employee)) return forbidden(res, "digital_employee_department_change_required", "当前账号没有该数字员工的归属变更权限。");

    const directory = await resolveDirectory(res, session);
    if (!directory) return null;
    const departments = directory.departments;
    const personnel = directory.personnel;
    const input = await readJsonBody(req, 16 * 1024);
    const targetDepartmentIds = uniqueIds(input.targetDepartmentIds || input.departmentIds || [input.targetDepartmentId]);
    const primaryDepartmentId = cleanDepartmentId(input.primaryDepartmentId || input.targetDepartmentId || targetDepartmentIds[0]);
    const targetDepartments = targetDepartmentIds
      .map((departmentId) => departments.find((item) => item.id === departmentId && item.id !== "company"))
      .filter(Boolean);
    if (!targetDepartments.length || targetDepartments.length !== targetDepartmentIds.length || !targetDepartmentIds.includes(primaryDepartmentId)) {
      return invalid(res, "target_departments_required", "请选择有效的归属部门，并指定其中一个主责部门。");
    }
    const primaryDepartment = targetDepartments.find((item) => item.id === primaryDepartmentId);
    const currentDepartmentId = cleanDepartmentId(employee.ownerDepartmentId || employee.departmentId);
    const currentDepartmentIds = employeeDepartmentIds(employee);
    const targetOwnerUserId = cleanId(input.targetOwnerUserId);
    const targetOwner = personnel.find((item) =>
      cleanId(item.id) === targetOwnerUserId && cleanDepartmentId(item.departmentId) === primaryDepartmentId,
    );
    if (!targetOwner) {
      return invalid(res, "target_owner_invalid", "请选择主责部门中的业务 Owner。");
    }
    const ownershipUnchanged = primaryDepartmentId === currentDepartmentId
      && sameIds(targetDepartmentIds, currentDepartmentIds)
      && cleanId(targetOwner.id) === cleanId(employee.ownerUserId);
    if (ownershipUnchanged) return invalid(res, "target_departments_unchanged", "主责部门、协作归属部门和 Owner 均未发生变化。");
    const reason = cleanText(input.reason);
    if (reason.length < 4) return invalid(res, "change_reason_required", "请填写至少 4 个字的变更原因。");

    const requests = employeeRequests(employee.id);
    const activeRequest = requests.find(isActiveRequest);
    if (activeRequest) {
      return sendJson(res, 409, {
        ok: false,
        error: "department_change_already_pending",
        message: "该数字员工已有待处理的归属变更。",
        contractVersion: CONTRACT_VERSION,
        activeRequest: effectiveRequestStatus(activeRequest),
      });
    }

    const now = new Date().toISOString();
    const effectiveAt = normalizedEffectiveAt(input.effectiveAt, now);
    const request = {
      id: `DEDC-${Date.now()}-${cleanId(employee.id).toUpperCase()}`,
      employeeId: employee.id,
      employeeName: cleanText(employee.name || employee.id),
      employeeVersion: cleanText(employee.version),
      status: "pending_review",
      source: "employee_configuration_workbench",
      current: {
        departmentId: currentDepartmentId,
        departmentName: departmentName(currentDepartmentId, employee.department),
        ownerUserId: cleanId(employee.ownerUserId),
        ownerName: cleanText(employee.owner),
      },
      target: {
        departmentId: primaryDepartment.id,
        departmentName: primaryDepartment.name,
        departmentIds: targetDepartments.map((item) => item.id),
        departmentNames: targetDepartments.map((item) => item.name),
        ownerUserId: targetOwner.id,
        ownerName: targetOwner.name,
      },
      reason,
      effectiveAt,
      impact: buildImpact(employee, targetDepartmentIds),
      submittedAt: now,
      updatedAt: now,
      submittedBy: safeActor(session),
    };
    const saved = store.saveRequest(request);
    if (!saved.ok) return unavailable(res);
    return sendJson(res, 202, {
      ok: true,
      contractVersion: CONTRACT_VERSION,
      status: request.status,
      request,
      message: "归属变更已提交审批；生效前继续使用当前部门配置。",
    });
  }

  async function decideRequest(req, res, requestId) {
    const session = requireSession(req, res);
    if (!session) return null;
    const request = store.readState().requests.find((item) => item.id === requestId);
    if (!request) return sendJson(res, 404, { ok: false, error: "department_change_not_found", contractVersion: CONTRACT_VERSION });
    if (!canReview(session, request)) return forbidden(res, "department_change_review_required", "当前账号没有归属变更审批权限。");
    if (request.status !== "pending_review") return invalid(res, "department_change_already_decided", "该归属变更已经处理。");

    const input = await readJsonBody(req, 16 * 1024);
    const decision = cleanText(input.decision);
    if (!new Set(["approved", "rejected"]).has(decision)) return invalid(res, "department_change_decision_required", "请选择通过或驳回。");
    const employee = findEmployee(request.employeeId);
    if (!employee) return notFound(res);
    const now = new Date().toISOString();
    const isScheduled = decision === "approved" && Date.parse(request.effectiveAt) > Date.now();
    const nextStatus = decision === "rejected" ? "rejected" : isScheduled ? "approved_scheduled" : "approved";
    const nextVersion = decision === "approved" ? nextEmployeeVersion(employee.version, request.effectiveAt || now) : employee.version;
    const decidedRequest = {
      ...request,
      status: nextStatus,
      updatedAt: now,
      decision: {
        outcome: decision,
        note: cleanText(input.note),
        decidedAt: now,
        decidedBy: safeActor(session),
      },
      nextEmployeeVersion: nextVersion,
    };
    const appliedOverride = decision === "approved"
      ? {
        employeeId: employee.id,
        ownerDepartmentId: request.target.departmentId,
        departmentId: request.target.departmentId,
        department: request.target.departmentName,
        departmentIds: uniqueIds(request.target.departmentIds || [request.target.departmentId]),
        departmentNames: uniqueText(request.target.departmentNames || [request.target.departmentName]),
        authorizedDepartmentIds: uniqueIds(request.target.departmentIds || [request.target.departmentId]),
        authorizedDepartmentNames: uniqueText(request.target.departmentNames || [request.target.departmentName]),
        ownerUserId: request.target.ownerUserId,
        owner: request.target.ownerName,
        permissionScope: normalizedDepartmentPermissionScope(employee.permissionScope),
        version: nextVersion,
        effectiveAt: request.effectiveAt,
        requestId: request.id,
        approvedAt: now,
        approvedBy: safeActor(session),
        source: "approved_department_change",
      }
      : null;
    const savedDecision = store.saveDecision(decidedRequest, appliedOverride);
    if (!savedDecision.ok) return unavailable(res);

    return sendJson(res, 200, {
      ok: true,
      contractVersion: CONTRACT_VERSION,
      status: nextStatus,
      request: effectiveRequestStatus(decidedRequest),
      digitalEmployee: withDepartmentChanges([employee])[0],
      message: decision === "rejected"
        ? "归属变更已驳回，线上配置未改变。"
        : isScheduled
          ? "归属变更已批准，将在计划时间生效。"
          : "归属变更已批准并生效。",
    });
  }

  function buildContext(employee, session, directory) {
    const requests = employeeRequests(employee.id).map(effectiveRequestStatus);
    return {
      ok: true,
      contractVersion: CONTRACT_VERSION,
      employee: safeEmployee(employee),
      directory: {
        source: directory.source,
        generatedAt: directory.generatedAt || "",
        departmentIdContract: "fortress-department-path.v1",
      },
      departmentOptions: directory.departments.map((item) => ({
        id: cleanDepartmentId(item.id),
        directoryId: cleanDepartmentId(item.directoryId),
        name: cleanText(item.name),
        label: cleanText(item.label || item.name),
        parentId: cleanDepartmentId(item.parentId),
      })),
      ownerOptions: directory.personnel.filter((item) => item.id && item.departmentId && item.status !== "停用").map((item) => ({
        id: cleanId(item.id),
        name: cleanText(item.name),
        departmentId: cleanDepartmentId(item.departmentId),
        role: cleanText(item.governanceRole || item.role),
      })),
      mountedBusinessSkills: mountedBusinessSkills(employee),
      activeRequest: requests.find(isActiveRequest) || null,
      latestRequest: requests[0] || null,
      canReview: canReview(session, requests.find(isActiveRequest) || { target: { departmentId: employee.ownerDepartmentId || employee.departmentId } }),
      persistence: {
        kind: "mvp-file-store",
        productionReady: false,
        boundary: "归属变更草案与生效覆盖记录保存在后端；前端不直接改写数字员工目录。",
      },
    };
  }

  function buildImpact(employee, targetDepartmentIds) {
    const mountedSkills = mountedBusinessSkills(employee);
    const selectedDepartmentIds = new Set(targetDepartmentIds);
    const incompatibleSkills = mountedSkills.filter((skill) => skill.departmentId && !selectedDepartmentIds.has(skill.departmentId));
    return {
      nextEmployeeVersion: nextEmployeeVersion(employee.version, new Date().toISOString()),
      permissionScope: normalizedDepartmentPermissionScope(employee.permissionScope),
      departmentEntitlementChanges: ["目标部门成员的自动会话资格将按权限范围重新计算", "原部门成员不再获得该部门自动资格"],
      personalEntitlementReviewRequired: true,
      incompatibleSkills,
      channelBindingsPreserved: true,
    };
  }

  function mountedBusinessSkills(employee) {
    const mountedIds = new Set(Array.isArray(employee.businessSkillIds) ? employee.businessSkillIds : []);
    return businessSkills
      .filter((skill) => mountedIds.has(skill.id))
      .map((skill) => ({ id: skill.id, name: skill.name || skill.id, departmentId: cleanDepartmentId(skill.departmentId || skill.ownerDepartmentId), department: cleanText(skill.department) }));
  }

  function employeeRequests(employeeId) {
    return store.readState().requests
      .filter((request) => request.employeeId === employeeId)
      .sort((left, right) => String(right.submittedAt || "").localeCompare(String(left.submittedAt || "")));
  }

  function withDepartmentChanges(employees = []) {
    const overrides = store.readState().appliedOverrides;
    const now = Date.now();
    return employees.map((employee) => {
      const override = overrides[employee.id];
      if (!override || Date.parse(override.effectiveAt || override.approvedAt || 0) > now) return employee;
      return {
        ...employee,
        ownerDepartmentId: override.ownerDepartmentId,
        departmentId: override.departmentId,
        department: override.department,
        departmentIds: override.departmentIds,
        departmentNames: override.departmentNames,
        authorizedDepartmentIds: Array.isArray(override.authorizedDepartmentIds)
          ? override.authorizedDepartmentIds
          : override.departmentIds,
        authorizedDepartmentNames: Array.isArray(override.authorizedDepartmentNames)
          ? override.authorizedDepartmentNames
          : override.departmentNames,
        ownerUserId: override.ownerUserId,
        owner: override.owner,
        permissionScope: override.permissionScope || normalizedDepartmentPermissionScope(employee.permissionScope),
        version: newerEmployeeVersion(employee.version, override.version),
        departmentChange: {
          requestId: override.requestId,
          effectiveAt: override.effectiveAt,
          approvedAt: override.approvedAt,
          source: override.source,
        },
        directoryMigration: override.directoryMigration || employee.directoryMigration,
      };
    });
  }

  function findEmployee(employeeId) {
    return currentEmployees().find((item) => item.id === employeeId);
  }

  function currentEmployees() {
    const employees = typeof getDigitalEmployees === "function" ? getDigitalEmployees() : [];
    return Array.isArray(employees) ? employees : [];
  }

  function canSubmit(session = {}, employee = {}) {
    const permissions = session.permissions || [];
    if (session.role === "admin" || hasPermission(permissions, "system:*") || hasPermission(permissions, "digital-employees:*")) return true;
    const managed = new Set(Array.isArray(session.managedDepartmentIds) ? session.managedDepartmentIds : []);
    const currentDepartmentId = employee.ownerDepartmentId || employee.departmentId;
    if (managed.has("*") || [...managed].some((departmentId) => departmentIdsOverlap(departmentId, currentDepartmentId))) return true;
    const actorIds = new Set([session.employeeId, session.feishuUserId, session.employeeNo, session.email].filter(Boolean));
    return [employee.ownerUserId, employee.ownerEmail].filter(Boolean).some((ownerId) => actorIds.has(ownerId));
  }

  function canReview(session = {}, request = {}) {
    const permissions = session.permissions || [];
    if (session.role === "admin" || hasPermission(permissions, "system:*") || hasPermission(permissions, "quality-reviews:*")) return true;
    const managed = new Set(Array.isArray(session.managedDepartmentIds) ? session.managedDepartmentIds : []);
    return managed.has("*") || [...managed].some((departmentId) => departmentIdsOverlap(departmentId, request.target?.departmentId));
  }

  async function resolveDirectory(res, session) {
    try {
      const directory = await getDirectory(session);
      if (!Array.isArray(directory?.departments) || !directory.departments.length) {
        return unavailableDirectory(res);
      }
      return {
        source: cleanText(directory.source || "fortress-v3"),
        generatedAt: cleanText(directory.generatedAt),
        departments: directory.departments,
        personnel: Array.isArray(directory.personnel) ? directory.personnel : [],
      };
    } catch {
      return unavailableDirectory(res);
    }
  }

  function invalid(res, error, message) {
    return sendJson(res, 422, { ok: false, error, message, contractVersion: CONTRACT_VERSION });
  }

  function forbidden(res, error, message) {
    return sendJson(res, 403, { ok: false, error, message, contractVersion: CONTRACT_VERSION });
  }

  function notFound(res) {
    return sendJson(res, 404, { ok: false, error: "digital_employee_not_found", contractVersion: CONTRACT_VERSION });
  }

  function unavailable(res) {
    return sendJson(res, 503, { ok: false, error: "department_change_store_unavailable", message: "归属变更暂时无法保存，请稍后重试。", contractVersion: CONTRACT_VERSION });
  }

  function unavailableDirectory(res) {
    sendJson(res, 503, {
      ok: false,
      error: "fortress_department_directory_unavailable",
      message: "Fortress 部门目录暂时不可用，归属变更已停止以避免写入静态或过期部门。",
      contractVersion: CONTRACT_VERSION,
    });
    return null;
  }

  return { handle, withDepartmentChanges };
}

export function nextEmployeeVersion(currentVersion = "", at = new Date().toISOString()) {
  const date = new Date(at);
  const day = Number.isNaN(date.getTime()) ? new Date() : date;
  const datePart = [day.getUTCFullYear(), String(day.getUTCMonth() + 1).padStart(2, "0"), String(day.getUTCDate()).padStart(2, "0")].join(".");
  const match = String(currentVersion || "").match(/^employee-(\d{4}\.\d{2}\.\d{2})-(\d{2})$/);
  const sequence = match?.[1] === datePart ? Number(match[2]) + 1 : 1;
  return `employee-${datePart}-${String(sequence).padStart(2, "0")}`;
}

export function newerEmployeeVersion(left = "", right = "") {
  if (!right) return left;
  if (!left) return right;
  return String(right).localeCompare(String(left)) > 0 ? right : left;
}

function effectiveRequestStatus(request) {
  if (request?.status === "approved_scheduled" && Date.parse(request.effectiveAt) <= Date.now()) return { ...request, status: "approved" };
  return request;
}

function isActiveRequest(request) {
  return ACTIVE_STATUSES.has(effectiveRequestStatus(request)?.status);
}

function normalizedEffectiveAt(value, fallback) {
  if (!value) return fallback;
  const time = Date.parse(value);
  if (!Number.isFinite(time)) return fallback;
  return new Date(Math.max(time, Date.parse(fallback))).toISOString();
}

function departmentName(departmentId, fallback = "") {
  return cleanText(fallback || departmentId || "未绑定部门");
}

function safeEmployee(employee = {}) {
  return {
    id: cleanId(employee.id),
    name: cleanText(employee.name),
    level: cleanText(employee.level),
    status: cleanText(employee.status),
    version: cleanText(employee.version),
    departmentId: cleanDepartmentId(employee.departmentId),
    ownerDepartmentId: cleanDepartmentId(employee.ownerDepartmentId || employee.departmentId),
    departmentIds: employeeDepartmentIds(employee),
    departmentNames: uniqueText(employee.departmentNames || [employee.department]),
    authorizedDepartmentIds: uniqueIds(employee.authorizedDepartmentIds || []),
    authorizedDepartmentNames: uniqueText(employee.authorizedDepartmentNames || []),
    department: cleanText(employee.department),
    ownerUserId: cleanId(employee.ownerUserId),
    owner: cleanText(employee.owner),
    permissionScope: cleanText(employee.permissionScope),
  };
}

function safeActor(session = {}) {
  return {
    id: cleanId(session.employeeId || session.email || session.name),
    name: cleanText(session.name || session.email || session.employeeId),
    departmentId: cleanDepartmentId(session.departmentId),
    department: cleanText(session.department),
    role: cleanText(session.governanceRole || session.role),
  };
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

function employeeDepartmentIds(employee = {}) {
  return uniqueIds([employee.ownerDepartmentId, employee.departmentId, ...(Array.isArray(employee.departmentIds) ? employee.departmentIds : [])]);
}

function uniqueIds(values = []) {
  return [...new Set((Array.isArray(values) ? values : [values]).map(cleanDepartmentId).filter(Boolean))];
}

function uniqueText(values = []) {
  return [...new Set((Array.isArray(values) ? values : [values]).map(cleanText).filter(Boolean))];
}

function sameIds(left = [], right = []) {
  const leftIds = [...uniqueIds(left)].sort();
  const rightIds = [...uniqueIds(right)].sort();
  return leftIds.length === rightIds.length && leftIds.every((value, index) => value === rightIds[index]);
}

function normalizedDepartmentPermissionScope(value) {
  return value === "ownDepartment" ? "ownDepartment" : "departmentSubtree";
}

function departmentIdsOverlap(left, right) {
  const leftId = cleanDepartmentId(left);
  const rightId = cleanDepartmentId(right);
  if (!leftId || !rightId) return false;
  if (leftId === rightId || leftId.startsWith(`${rightId}/`) || rightId.startsWith(`${leftId}/`)) return true;
  const leftParts = leftId.split("/").filter(Boolean);
  const rightParts = rightId.split("/").filter(Boolean);
  return leftParts.length === 1 && rightParts.includes(leftId)
    || rightParts.length === 1 && leftParts.includes(rightId);
}
