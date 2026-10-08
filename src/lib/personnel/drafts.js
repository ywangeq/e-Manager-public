async function personnelDraftRequest(url, options = {}) {
  const response = await fetch(url, {
    credentials: "include",
    ...options,
    headers: {
      ...(options.body ? { "Content-Type": "application/json" } : {}),
      ...(options.headers || {}),
    },
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || !data.ok) {
    throw new Error(data.error || "人员草稿接口失败");
  }
  return data;
}

export function fetchPersonnelDrafts() {
  return personnelDraftRequest("/api/personnel/governance-drafts");
}

export function resolvePersonnel(input) {
  return personnelDraftRequest("/api/personnel/resolve", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export function createPersonnelDraftPerson(person) {
  return personnelDraftRequest("/api/personnel/governance-drafts/people", {
    method: "POST",
    body: JSON.stringify({ person }),
  });
}

export function updatePersonnelDraft(userId, draft) {
  return personnelDraftRequest(`/api/personnel/governance-drafts/users/${encodeURIComponent(userId)}`, {
    method: "PATCH",
    body: JSON.stringify({ draft }),
  });
}

export function updateDepartmentOwnerDraft(departmentId, draft) {
  return personnelDraftRequest(`/api/personnel/department-owner-drafts/${encodeURIComponent(departmentId)}`, {
    method: "PATCH",
    body: JSON.stringify({ draft }),
  });
}

export function deletePersonnelDraftPerson(personId) {
  return personnelDraftRequest(`/api/personnel/governance-drafts/people/${encodeURIComponent(personId)}`, {
    method: "DELETE",
  });
}

export function fetchPersonnelAccessRequests() {
  return personnelDraftRequest("/api/personnel/access-requests");
}

export function createPersonnelAccessRequest(accessRequest) {
  return personnelDraftRequest("/api/personnel/access-requests", {
    method: "POST",
    body: JSON.stringify(accessRequest),
  });
}

export function decidePersonnelAccessRequest(requestId, decision) {
  return personnelDraftRequest(`/api/personnel/access-requests/${encodeURIComponent(requestId)}/decision`, {
    method: "POST",
    body: JSON.stringify(decision),
  });
}
