import fs from "node:fs";
import path from "node:path";

export function createPersonnelGovernanceStore({
  projectRoot,
  storePath,
  storeVersion = "personnel-governance-drafts.v1",
  redactError = (error) => String(error?.message || error),
}) {
  function readForSession(session) {
    const store = readStore();
    if (isPlatformAdmin(session)) {
      return {
        addedPeople: mergeAddedPeople(store),
        userDrafts: mergeUserDrafts(store),
        departmentOwnerDrafts: mergeDepartmentOwnerDrafts(store),
        accessRequests: mergeAccessRequests(store),
        persistence: persistenceSummary(),
      };
    }
    const bucket = ensureBucket(store, sessionScopeKey(session));
    return {
      addedPeople: bucket.addedPeople,
      userDrafts: bucket.userDrafts,
      departmentOwnerDrafts: bucket.departmentOwnerDrafts,
      accessRequests: bucket.accessRequests,
      persistence: persistenceSummary(),
    };
  }

  function resolveAuthorizationAssignment(identity) {
    return resolvePersonnelAuthorizationAssignment(readStore(), identity);
  }

  function update(session, updater) {
    const store = readStore();
    const result = updater(store) || {};
    store.updatedAt = new Date().toISOString();
    writeStore(store);
    return result;
  }

  function readStore() {
    try {
      if (!fs.existsSync(storePath)) return emptyStore();
      const data = JSON.parse(fs.readFileSync(storePath, "utf8"));
      if (!data || typeof data !== "object") return emptyStore();
      return {
        version: storeVersion,
        buckets: data.buckets && typeof data.buckets === "object" ? data.buckets : {},
        updatedAt: data.updatedAt || "",
      };
    } catch (error) {
      console.warn("[personnel/governance-store] Failed to read store:", redactError(error));
      return emptyStore();
    }
  }

  function writeStore(store) {
    fs.mkdirSync(path.dirname(storePath), { recursive: true });
    fs.writeFileSync(storePath, `${JSON.stringify(store, null, 2)}\n`, "utf8");
  }

  function emptyStore() {
    return { version: storeVersion, buckets: {}, updatedAt: "" };
  }

  function ensureBucket(store, scope) {
    const current = store.buckets[scope] || {};
    const bucket = {
      addedPeople: Array.isArray(current.addedPeople)
        ? current.addedPeople.map(sanitizePerson).filter((person) => person.id || person.name || person.email)
        : [],
      userDrafts: current.userDrafts && typeof current.userDrafts === "object"
        ? Object.fromEntries(
            Object.entries(current.userDrafts)
              .map(([userId, draft]) => [userId, sanitizeDraft({ ...draft, userId })])
              .filter(([userId]) => userId),
          )
        : {},
      departmentOwnerDrafts: current.departmentOwnerDrafts && typeof current.departmentOwnerDrafts === "object"
        ? Object.fromEntries(
            Object.entries(current.departmentOwnerDrafts)
              .map(([departmentId, draft]) => [departmentId, sanitizeDepartmentOwnerDraft({ ...draft, departmentId })])
              .filter(([departmentId]) => departmentId),
          )
        : {},
      accessRequests: Array.isArray(current.accessRequests)
        ? current.accessRequests.map(sanitizeAccessRequest).filter((request) => request.id)
        : [],
    };
    store.buckets[scope] = bucket;
    return bucket;
  }

  function sessionScopeKey(session) {
    if (isPlatformAdmin(session)) return "platform-admin";
    return normalizeStoreKey(session.employeeId || session.feishuUserId || session.email || "anonymous");
  }

  function persistenceSummary() {
    return {
      kind: "mvp-file-store",
      version: storeVersion,
      path: path.relative(projectRoot, storePath),
      productionReady: false,
    };
  }

  function mergeAddedPeople(store) {
    const peopleById = new Map();
    const drafts = mergeUserDrafts(store);
    for (const bucket of Object.values(store.buckets || {})) {
      for (const person of Array.isArray(bucket.addedPeople) ? bucket.addedPeople : []) {
        const sanitized = sanitizePerson(person);
        const key = sanitized.id || sanitized.email || sanitized.name;
        if (!key) continue;
        const draft = drafts[key];
        peopleById.set(key, draft ? applyDraftToPerson(sanitized, draft) : sanitized);
      }
    }
    for (const [userId, draft] of Object.entries(drafts)) {
      const key = draft.userId || userId || draft.displayName;
      if (!shouldShowDraftOnlyPerson(draft) || !key || peopleById.has(key)) continue;
      peopleById.set(key, personFromDraft(userId, draft));
    }
    return [...peopleById.values()];
  }

  function mergeUserDrafts(store) {
    const drafts = {};
    for (const bucket of Object.values(store.buckets || {})) {
      for (const [userId, draft] of Object.entries(bucket.userDrafts || {})) {
        if (userId) drafts[userId] = sanitizeDraft({ ...draft, userId });
      }
    }
    return drafts;
  }

  function mergeDepartmentOwnerDrafts(store) {
    const drafts = {};
    for (const bucket of Object.values(store.buckets || {})) {
      for (const [departmentId, draft] of Object.entries(bucket.departmentOwnerDrafts || {})) {
        if (departmentId) drafts[departmentId] = sanitizeDepartmentOwnerDraft({ ...draft, departmentId });
      }
    }
    return drafts;
  }

  function mergeAccessRequests(store) {
    const requests = [];
    for (const bucket of Object.values(store.buckets || {})) {
      for (const request of bucket.accessRequests || []) {
        const sanitized = sanitizeAccessRequest(request);
        if (sanitized.id) requests.push(sanitized);
      }
    }
    return requests.sort((left, right) => String(right.updatedAt || right.createdAt).localeCompare(String(left.updatedAt || left.createdAt)));
  }

  return {
    ensureBucket,
    formatChinaTime,
    persistenceSummary,
    readForSession,
    resolveAuthorizationAssignment,
    safeActor,
    sanitizeAccessRequest,
    sanitizeDepartmentOwnerDraft,
    sanitizeDraft,
    sanitizePerson,
    sessionScopeKey,
    update,
  };
}

export function resolvePersonnelAuthorizationAssignment(store = {}, identity = {}) {
  const candidates = authorizationIdentityCandidates(identity);
  if (!candidates.length) return null;

  const matches = [];
  for (const bucket of Object.values(store.buckets || {})) {
    for (const [userId, value] of Object.entries(bucket?.userDrafts || {})) {
      const draft = sanitizeDraft({ ...value, userId });
      const identityMatch = matchAuthorizationIdentity(draft.userId, candidates);
      if (!identityMatch || draft.status !== "启用") continue;
      const role = normalizeAuthorizationGovernanceRole(draft.governanceRole);
      if (!role || (role.kind === "department" && !draft.departmentId)) continue;
      matches.push({
        departmentId: draft.departmentId,
        governanceRole: role.label,
        identityMatch,
        kind: role.kind,
        updatedAt: draft.updatedAt,
      });
    }

    for (const [departmentId, value] of Object.entries(bucket?.departmentOwnerDrafts || {})) {
      const draft = sanitizeDepartmentOwnerDraft({ ...value, departmentId });
      const identityMatch = matchAuthorizationIdentity(draft.ownerUserId, candidates);
      if (!identityMatch || draft.status !== "confirmed" || !draft.departmentId) continue;
      matches.push({
        departmentId: draft.departmentId,
        governanceRole: "部门负责人",
        identityMatch,
        kind: "department",
        updatedAt: draft.updatedAt,
      });
    }
  }

  const selected = matches.sort(compareAuthorizationAssignments)[0];
  if (!selected) return null;
  return {
    contractVersion: "personnel-authorization-assignment.v1",
    departmentId: selected.departmentId,
    governanceRole: selected.governanceRole,
    kind: selected.kind,
    matchedIdentityField: selected.identityMatch.field,
    source: "personnel-governance-mvp",
  };
}

function authorizationIdentityCandidates(identity) {
  const fields = [
    ["feishuUserId", identity.feishuUserId, 600],
    ["feishuUnionId", identity.feishuUnionId, 500],
    ["employeeNo", identity.employeeNo, 400],
    ["employeeId", identity.employeeId, 300],
    ["email", identity.email, 200],
  ];
  const seen = new Set();
  return fields.flatMap(([field, value, score]) => {
    const normalized = normalizeAuthorizationIdentity(value);
    if (!normalized || seen.has(normalized)) return [];
    seen.add(normalized);
    return [{ field, normalized, score }];
  });
}

function matchAuthorizationIdentity(value, candidates) {
  const normalized = normalizeAuthorizationIdentity(value);
  return normalized ? candidates.find((candidate) => candidate.normalized === normalized) || null : null;
}

function normalizeAuthorizationIdentity(value) {
  return String(value || "").trim().toLowerCase();
}

function normalizeAuthorizationGovernanceRole(value) {
  const role = cleanShortText(value);
  if (["系统管理员", "平台管理员"].includes(role)) return { kind: "system", label: "系统管理员" };
  if (["部门负责人", "部门管理员", "业务管理员"].includes(role)) return { kind: "department", label: role };
  return null;
}

function compareAuthorizationAssignments(left, right) {
  if (left.identityMatch.score !== right.identityMatch.score) return right.identityMatch.score - left.identityMatch.score;
  if (left.kind !== right.kind) return left.kind === "system" ? -1 : 1;
  return String(right.updatedAt || "").localeCompare(String(left.updatedAt || ""));
}

function applyDraftToPerson(person, draft) {
  const departmentId = draft.departmentId || person.departmentId;
  return {
    ...person,
    name: draft.displayName || person.name,
    role: draft.role || person.role,
    departmentId,
    department: draft.departmentName || person.department,
    departmentPath: draft.departmentName || person.departmentPath,
    governanceRole: draft.governanceRole || person.governanceRole,
    status: draft.status || person.status,
    editableDepartmentIds: departmentId ? [departmentId] : person.editableDepartmentIds,
    reviewDepartmentIds: departmentId ? [departmentId] : person.reviewDepartmentIds,
  };
}

function personFromDraft(userId, draft) {
  return sanitizePerson({
    id: draft.userId || userId || draft.displayName,
    name: draft.displayName || draft.userId || userId,
    role: draft.role || draft.governanceRole || "待确认职位",
    departmentId: draft.departmentId,
    department: draft.departmentName,
    departmentPath: draft.departmentName,
    governanceRole: draft.governanceRole,
    status: draft.status,
    identitySource: draft.source || "mvp-backend-draft",
    editableDepartmentIds: draft.departmentId ? [draft.departmentId] : [],
    reviewDepartmentIds: draft.departmentId ? [draft.departmentId] : [],
    updatedAt: draft.updatedAt,
    updatedBy: draft.updatedBy,
  });
}

function shouldShowDraftOnlyPerson(draft) {
  if (!draft?.displayName || draft.status === "停用") return false;
  const roleText = [draft.governanceRole, draft.role, draft.displayName].filter(Boolean).join(" ");
  return !/部门负责人候选|待确认负责人/.test(roleText);
}

function isPlatformAdmin(session) {
  const permissions = new Set(session?.permissions || []);
  return session?.role === "admin" || permissions.has("system:*") || permissions.has("people:*");
}

function sanitizePerson(person = {}) {
  const departmentId = cleanShortText(person.departmentId);
  const editableDepartmentIds = cleanIdList(person.editableDepartmentIds || (departmentId ? [departmentId] : []));
  const reviewDepartmentIds = cleanIdList(person.reviewDepartmentIds || (departmentId ? [departmentId] : []));
  return {
    id: cleanShortText(person.id || person.email || person.name),
    name: cleanShortText(person.name),
    email: cleanShortText(person.email).toLowerCase(),
    role: cleanShortText(person.role || "待确认职位"),
    departmentId,
    department: cleanShortText(person.department || person.departmentName || "待选择部门"),
    departmentPath: cleanShortText(person.departmentPath || person.department || person.departmentName),
    governanceRole: cleanShortText(person.governanceRole || "普通成员"),
    scope: cleanShortText(person.scope || person.governance?.scope || "ownDepartment"),
    status: normalizePersonnelStatus(person.status || "待确认"),
    identitySource: cleanShortText(person.identitySource || "mvp-backend-draft"),
    editableDepartmentIds,
    reviewDepartmentIds,
    createdAt: cleanShortText(person.createdAt),
    updatedAt: cleanShortText(person.updatedAt),
    updatedBy: sanitizeActor(person.updatedBy),
  };
}

function sanitizeDraft(draft = {}) {
  return {
    userId: cleanShortText(draft.userId),
    displayName: cleanShortText(draft.displayName),
    role: cleanShortText(draft.role),
    departmentId: cleanShortText(draft.departmentId),
    departmentName: cleanShortText(draft.departmentName),
    governanceRole: cleanShortText(draft.governanceRole || "普通成员"),
    status: normalizePersonnelStatus(draft.status || "待确认"),
    note: cleanText(draft.note),
    source: cleanShortText(draft.source || "mvp-backend-draft"),
    action: cleanShortText(draft.action),
    submittedAt: cleanShortText(draft.submittedAt),
    updatedAt: cleanShortText(draft.updatedAt),
    updatedBy: sanitizeActor(draft.updatedBy),
  };
}

function sanitizeDepartmentOwnerDraft(draft = {}) {
  return {
    departmentId: cleanShortText(draft.departmentId),
    departmentName: cleanShortText(draft.departmentName),
    ownerUserId: cleanShortText(draft.ownerUserId),
    ownerName: cleanShortText(draft.ownerName),
    ownerRole: cleanShortText(draft.ownerRole),
    ownerDepartmentId: cleanShortText(draft.ownerDepartmentId),
    ownerDepartmentName: cleanShortText(draft.ownerDepartmentName),
    status: normalizeDepartmentOwnerDraftStatus(draft.status || "draft"),
    source: cleanShortText(draft.source || "mvp-backend-draft"),
    note: cleanText(draft.note),
    submittedAt: cleanShortText(draft.submittedAt),
    updatedAt: cleanShortText(draft.updatedAt),
    updatedBy: sanitizeActor(draft.updatedBy),
  };
}

function sanitizeAccessRequest(request = {}) {
  const applicant = request.applicant && typeof request.applicant === "object" ? request.applicant : {};
  const target = request.target && typeof request.target === "object" ? request.target : {};
  const decision = request.decision && typeof request.decision === "object" ? request.decision : {};
  return {
    id: cleanShortText(request.id),
    requestType: cleanShortText(request.requestType || "department_admin_access"),
    requestedRole: normalizeAccessRole(request.requestedRole || "部门管理员"),
    status: normalizeAccessStatus(request.status || "pending_review"),
    reason: cleanText(request.reason),
    sourceSystemId: cleanShortText(request.sourceSystemId),
    sourceSystemName: cleanShortText(request.sourceSystemName),
    createdAt: cleanShortText(request.createdAt),
    updatedAt: cleanShortText(request.updatedAt),
    applicant: {
      id: cleanShortText(applicant.id),
      name: cleanShortText(applicant.name),
      email: cleanShortText(applicant.email).toLowerCase(),
      role: cleanShortText(applicant.role),
      departmentId: cleanShortText(applicant.departmentId),
      department: cleanShortText(applicant.department),
      identitySource: cleanShortText(applicant.identitySource),
    },
    target: {
      departmentId: cleanShortText(target.departmentId || request.departmentId),
      departmentName: cleanShortText(target.departmentName || request.departmentName),
      scope: cleanShortText(target.scope || request.scope || "ownDepartment"),
      systemId: cleanShortText(target.systemId),
      systemName: cleanShortText(target.systemName),
    },
    decision: {
      outcome: cleanShortText(decision.outcome),
      decidedAt: cleanShortText(decision.decidedAt),
      note: cleanText(decision.note),
      decidedBy: sanitizeActor(decision.decidedBy),
    },
  };
}

function normalizeAccessRole(role) {
  const allowed = new Set(["部门管理员", "业务系统 owner", "控制面治理角色", "质量治理角色"]);
  return allowed.has(role) ? role : "部门管理员";
}

function normalizeAccessStatus(status) {
  const allowed = new Set(["pending_review", "approved", "rejected"]);
  return allowed.has(status) ? status : "pending_review";
}

function normalizePersonnelStatus(status) {
  const allowed = new Set(["启用", "待确认", "待补全", "待同步", "停用"]);
  return allowed.has(status) ? status : "待确认";
}

function normalizeDepartmentOwnerDraftStatus(status) {
  const allowed = new Set(["draft", "confirmed", "cleared"]);
  return allowed.has(status) ? status : "draft";
}

function cleanText(value) {
  return String(value || "").replace(/\s+/g, " ").trim().slice(0, 800);
}

function cleanShortText(value) {
  return String(value || "").replace(/\s+/g, " ").trim().slice(0, 160);
}

function cleanIdList(value) {
  const items = Array.isArray(value) ? value : [value];
  return [...new Set(items.map(cleanShortText).filter(Boolean))].slice(0, 40);
}

function safeActor(session) {
  return sanitizeActor({
    id: session.employeeId || session.feishuUserId || session.email,
    name: session.name,
    role: session.role,
    identitySource: session.identitySource,
  });
}

function sanitizeActor(actor) {
  if (!actor || typeof actor !== "object") return null;
  return {
    id: cleanShortText(actor.id),
    name: cleanShortText(actor.name),
    role: cleanShortText(actor.role),
    identitySource: cleanShortText(actor.identitySource),
  };
}

function formatChinaTime(value) {
  return new Date(value).toLocaleString("zh-CN", { hour12: false, timeZone: "Asia/Shanghai" });
}

function normalizeStoreKey(value) {
  return String(value || "anonymous")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9@._-]+/g, "-")
    .slice(0, 120) || "anonymous";
}
