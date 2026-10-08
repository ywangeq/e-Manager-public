import crypto from "node:crypto";

export function createPersonnelGovernanceHandlers({
  canResolveFortressPersonnel,
  hasPermission,
  readJsonBody,
  requireSession,
  sendJson,
  store,
  tryFetchFortressUser,
}) {
  async function handle(req, res, url) {
    if (req.method === "POST" && url.pathname === "/api/personnel/resolve") {
      await resolvePersonnel(req, res);
      return true;
    }

    if (req.method === "GET" && url.pathname === "/api/personnel/governance-drafts") {
      listDrafts(req, res);
      return true;
    }

    if (url.pathname === "/api/personnel/access-requests") {
      if (req.method === "GET") {
        listAccessRequests(req, res);
        return true;
      }
      if (req.method === "POST") {
        await createAccessRequest(req, res);
        return true;
      }
    }

    if (req.method === "POST" && url.pathname.startsWith("/api/personnel/access-requests/") && url.pathname.endsWith("/decision")) {
      const requestId = decodeURIComponent(
        url.pathname
          .slice("/api/personnel/access-requests/".length)
          .replace(/\/decision$/, ""),
      );
      await decideAccessRequest(req, res, requestId);
      return true;
    }

    if (req.method === "POST" && url.pathname === "/api/personnel/governance-drafts/people") {
      await addPerson(req, res);
      return true;
    }

    if (req.method === "PATCH" && url.pathname.startsWith("/api/personnel/governance-drafts/users/")) {
      const userId = decodeURIComponent(url.pathname.slice("/api/personnel/governance-drafts/users/".length));
      await updateDraft(req, res, userId);
      return true;
    }

    if (req.method === "PATCH" && url.pathname.startsWith("/api/personnel/department-owner-drafts/")) {
      const departmentId = decodeURIComponent(url.pathname.slice("/api/personnel/department-owner-drafts/".length));
      await updateDepartmentOwnerDraft(req, res, departmentId);
      return true;
    }

    if (req.method === "DELETE" && url.pathname.startsWith("/api/personnel/governance-drafts/people/")) {
      const personId = decodeURIComponent(url.pathname.slice("/api/personnel/governance-drafts/people/".length));
      deletePerson(req, res, personId);
      return true;
    }

    return undefined;
  }

  async function resolvePersonnel(req, res) {
    const session = requirePeopleEditSession(req, res);
    if (!session) return undefined;

    const input = await readJsonBody(req);
    const displayName = String(input.name || "").trim();
    const email = String(input.email || "").trim().toLowerCase();
    const requestedDepartmentId = String(input.departmentId || "").trim();
    const requestedDepartmentName = String(input.departmentName || "").trim();
    const lookupCandidates = personnelLookupCandidates(input);
    let member = null;
    let lookupKey = "";

    if (canResolveFortressPersonnel(session)) {
      for (const candidate of lookupCandidates) {
        member = await tryFetchFortressUser(candidate.value, candidate.type);
        if (member) {
          lookupKey = candidate.type;
          break;
        }
      }
    }

    const mainDepartment = member
      ? (member.DepartmentRef || []).find((department) => department.IsMain) || member.DepartmentRef?.[0]
      : null;
    const departmentId = mainDepartment?.ID || requestedDepartmentId;
    const departmentName = mainDepartment?.Name || requestedDepartmentName;

    return sendJson(res, 200, {
      ok: true,
      source: member ? "fortress-v3" : "mvp-backend-draft",
      lookupKey,
      personnel: {
        id: member?.FeishuUserID || member?.FeishuUnionID || member?.EmployeeNo || email || displayName,
        name: member?.FullName || displayName || member?.NickName || email,
        email: member?.Mail || email,
        role: member?.Position || input.role || "待确认职位",
        departmentId,
        department: departmentName || "待选择部门",
        departmentPath: departmentName || "",
        governanceRole: input.governanceRole || "普通成员",
        scope: input.scope || "ownDepartment",
        status: member ? "待确认" : "待补全",
        identitySource: member ? "fortress-v3" : "mvp-backend-draft",
        feishuUserId: member?.FeishuUserID || "",
        employeeNo: member?.EmployeeNo || "",
        nickName: member?.NickName || "",
        editableDepartmentIds: departmentId ? [departmentId] : [],
        reviewDepartmentIds: departmentId ? [departmentId] : [],
      },
    });
  }

  function listDrafts(req, res) {
    const session = requirePeopleEditSession(req, res);
    if (!session) return undefined;
    return sendDrafts(res, session);
  }

  function listAccessRequests(req, res) {
    const session = requireSession(req, res);
    if (!session) return undefined;
    return sendJson(res, 200, {
      ok: true,
      contractVersion: "personnel-access-request.v1",
      ...store.readForSession(session),
    });
  }

  async function createAccessRequest(req, res) {
    const session = requireSession(req, res);
    if (!session) return undefined;

    const input = await readJsonBody(req);
    if (hasPermission(session.permissions, "people:edit")) {
      return sendJson(res, 200, {
        ok: true,
        status: "access_already_granted",
        contractVersion: "personnel-access-request.v1",
        message: "当前账号已具备人员治理权限，无需提交审核申请。",
        ...store.readForSession(session),
      });
    }

    const now = new Date().toISOString();
    const request = store.sanitizeAccessRequest({
      id: `PAR-${accessRequestActorId(session).toUpperCase().replace(/[^A-Z0-9]+/g, "-")}-${Date.now()}`,
      requestType: input.requestType || "department_admin_access",
      requestedRole: input.requestedRole || "部门管理员",
      status: "pending_review",
      reason: input.reason || "",
      sourceSystemId: input.sourceSystemId || "",
      sourceSystemName: input.sourceSystemName || "",
      createdAt: now,
      updatedAt: now,
      applicant: {
        id: accessRequestActorId(session),
        name: session.name,
        email: session.email,
        role: session.role,
        departmentId: session.departmentId,
        department: session.department,
        identitySource: session.identitySource,
      },
      target: {
        departmentId: input.departmentId || session.departmentId,
        departmentName: input.departmentName || session.department,
        scope: input.scope || "ownDepartment",
        systemId: input.systemId || input.sourceSystemId || "",
        systemName: input.systemName || input.sourceSystemName || "",
      },
    });

    if (!request.target.departmentId && !request.target.systemId) {
      return sendJson(res, 400, {
        ok: false,
        error: "access_request_target_required",
        contractVersion: "personnel-access-request.v1",
      });
    }

    const saved = store.update(session, (draftStore) => {
      const bucket = store.ensureBucket(draftStore, store.sessionScopeKey(session));
      bucket.accessRequests = [
        request,
        ...(bucket.accessRequests || []).filter((item) => item.id !== request.id),
      ];
      return { accessRequest: request };
    });

    return sendJson(res, 202, {
      ok: true,
      status: "access_request_pending",
      contractVersion: "personnel-access-request.v1",
      accessRequest: saved.accessRequest,
      message: "权限申请已提交，等待人员管理员或平台治理角色审核。",
      ...store.readForSession(session),
    });
  }

  async function decideAccessRequest(req, res, requestId) {
    const session = requirePeopleEditSession(req, res);
    if (!session) return undefined;
    if (!requestId) return sendJson(res, 400, { ok: false, error: "access_request_id_required" });

    const input = await readJsonBody(req);
    const decision = String(input.decision || input.outcome || "").trim();
    if (!["approve", "approved", "reject", "rejected"].includes(decision)) {
      return sendJson(res, 400, {
        ok: false,
        error: "access_request_decision_required",
        contractVersion: "personnel-access-request.v1",
      });
    }
    const isApproved = decision === "approve" || decision === "approved";
    const now = new Date().toISOString();
    const saved = store.update(session, (draftStore) => {
      let matched = null;
      for (const bucket of Object.values(draftStore.buckets || {})) {
        const requests = Array.isArray(bucket.accessRequests) ? bucket.accessRequests : [];
        const index = requests.findIndex((item) => item.id === requestId);
        if (index === -1) continue;
        const existing = store.sanitizeAccessRequest(requests[index]);
        matched = {
          ...existing,
          status: isApproved ? "approved" : "rejected",
          updatedAt: now,
          decision: {
            outcome: isApproved ? "approved" : "rejected",
            decidedAt: store.formatChinaTime(now),
            note: input.note || "",
            decidedBy: store.safeActor(session),
          },
        };
        bucket.accessRequests[index] = matched;
        if (isApproved) {
          const userId = matched.applicant.id || matched.applicant.email || matched.applicant.name || requestId;
          bucket.userDrafts = bucket.userDrafts || {};
          bucket.userDrafts[userId] = store.sanitizeDraft({
            ...(bucket.userDrafts[userId] || {}),
            userId,
            displayName: matched.applicant.name,
            role: matched.requestedRole,
            departmentId: matched.target.departmentId || matched.applicant.departmentId,
            departmentName: matched.target.departmentName || matched.applicant.department,
            governanceRole: matched.requestedRole,
            status: "启用",
            note: `权限申请 ${requestId} 已通过；${input.note || matched.reason || "管理员确认授权范围。"}`,
            source: "personnel-access-request",
            action: "access_request_approved",
            submittedAt: store.formatChinaTime(now),
            updatedAt: now,
            updatedBy: store.safeActor(session),
          });
        }
        break;
      }
      return { accessRequest: matched };
    });

    if (!saved.accessRequest) {
      return sendJson(res, 404, {
        ok: false,
        error: "access_request_not_found",
        contractVersion: "personnel-access-request.v1",
      });
    }

    return sendJson(res, 200, {
      ok: true,
      status: isApproved ? "approved" : "rejected",
      contractVersion: "personnel-access-request.v1",
      accessRequest: saved.accessRequest,
      ...store.readForSession(session),
    });
  }

  async function addPerson(req, res) {
    const session = requirePeopleEditSession(req, res);
    if (!session) return undefined;

    const input = await readJsonBody(req);
    const person = store.sanitizePerson(input.person || input);
    if (!person.name && !person.email) {
      return sendJson(res, 400, { ok: false, error: "person_name_or_email_required" });
    }

    const saved = store.update(session, (draftStore) => {
      const bucket = store.ensureBucket(draftStore, store.sessionScopeKey(session));
      const now = new Date().toISOString();
      const id = person.id || person.email || person.name || `person-${crypto.randomUUID()}`;
      const existing = bucket.addedPeople.find((item) => item.id === id) || {};
      const next = {
        ...existing,
        ...person,
        id,
        updatedAt: now,
        createdAt: existing.createdAt || now,
        updatedBy: store.safeActor(session),
      };
      bucket.addedPeople = [next, ...bucket.addedPeople.filter((item) => item.id !== id)];
      return { savedPerson: next };
    });

    return sendDrafts(res, session, { person: saved.savedPerson });
  }

  async function updateDraft(req, res, userId) {
    const session = requirePeopleEditSession(req, res);
    if (!session) return undefined;
    if (!userId) return sendJson(res, 400, { ok: false, error: "user_id_required" });

    const input = await readJsonBody(req);
    const draft = store.sanitizeDraft(input.draft || input);
    const saved = store.update(session, (draftStore) => {
      const bucket = store.ensureBucket(draftStore, store.sessionScopeKey(session));
      const now = new Date().toISOString();
      const existing = bucket.userDrafts[userId] || {};
      bucket.userDrafts[userId] = {
        ...existing,
        ...draft,
        userId,
        updatedAt: now,
        submittedAt: store.formatChinaTime(now),
        updatedBy: store.safeActor(session),
      };
      return { draft: bucket.userDrafts[userId] };
    });

    return sendDrafts(res, session, { draft: saved.draft });
  }

  async function updateDepartmentOwnerDraft(req, res, departmentId) {
    const session = requirePeopleEditSession(req, res);
    if (!session) return undefined;
    if (!departmentId) return sendJson(res, 400, { ok: false, error: "department_id_required" });

    const input = await readJsonBody(req);
    const draft = store.sanitizeDepartmentOwnerDraft(input.draft || input);
    const saved = store.update(session, (draftStore) => {
      const bucket = store.ensureBucket(draftStore, store.sessionScopeKey(session));
      const now = new Date().toISOString();
      bucket.departmentOwnerDrafts = bucket.departmentOwnerDrafts || {};
      bucket.departmentOwnerDrafts[departmentId] = {
        ...draft,
        departmentId,
        updatedAt: now,
        submittedAt: store.formatChinaTime(now),
        updatedBy: store.safeActor(session),
      };
      return { departmentOwnerDraft: bucket.departmentOwnerDrafts[departmentId] };
    });

    return sendDrafts(res, session, { departmentOwnerDraft: saved.departmentOwnerDraft });
  }

  function deletePerson(req, res, personId) {
    const session = requirePeopleEditSession(req, res);
    if (!session) return undefined;
    if (!personId) return sendJson(res, 400, { ok: false, error: "person_id_required" });

    store.update(session, (draftStore) => {
      for (const bucket of Object.values(draftStore.buckets || {})) {
        bucket.addedPeople = (bucket.addedPeople || []).filter((item) => item.id !== personId);
        delete bucket.userDrafts?.[personId];
      }
      return {};
    });

    return sendDrafts(res, session);
  }

  function requirePeopleEditSession(req, res) {
    const session = requireSession(req, res);
    if (!session) return null;
    if (!hasPermission(session.permissions, "people:edit")) {
      sendJson(res, 403, { ok: false, error: "people_edit_required" });
      return null;
    }
    return session;
  }

  function sendDrafts(res, session, extra = {}) {
    return sendJson(res, 200, {
      ok: true,
      ...store.readForSession(session),
      ...extra,
    });
  }

  return { handle };
}

function accessRequestActorId(session) {
  return String(session.employeeId || session.feishuUserId || session.email || "current-user").trim() || "current-user";
}

function personnelLookupCandidates(input) {
  const candidates = [];
  const email = String(input.email || "").trim().toLowerCase();
  const nickName = String(input.nickName || "").trim().toLowerCase();
  const feishuUserId = String(input.feishuUserId || "").trim();
  const employeeNo = String(input.employeeNo || "").trim();
  if (feishuUserId) candidates.push({ value: feishuUserId, type: "feishuID" });
  if (employeeNo) candidates.push({ value: employeeNo, type: "employeeNo" });
  if (nickName) candidates.push({ value: nickName, type: "nickName" });
  if (email && email.includes("@")) candidates.push({ value: email.split("@")[0], type: "nickName" });
  return dedupeLookupCandidates(candidates);
}

function dedupeLookupCandidates(candidates) {
  const seen = new Set();
  return candidates.filter((candidate) => {
    const key = `${candidate.type}:${candidate.value}`;
    if (!candidate.value || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
