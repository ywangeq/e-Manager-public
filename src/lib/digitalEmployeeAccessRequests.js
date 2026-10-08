async function accessRequest(url, options = {}) {
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
    throw new Error(data.message || data.error || "数字员工使用授权接口失败");
  }
  return data;
}

export function fetchDigitalEmployeeAccessRequests() {
  return accessRequest("/api/digital-employee-access-requests?scope=review");
}

export function pendingDigitalEmployeeAccessRequestCount(requests = []) {
  return (Array.isArray(requests) ? requests : []).filter((request) => request?.status === "pending_review").length;
}

export function decideDigitalEmployeeAccessRequest(requestId, decision) {
  return accessRequest(`/api/digital-employee-access-requests/${encodeURIComponent(requestId)}/decision`, {
    method: "POST",
    body: JSON.stringify(decision),
  });
}
