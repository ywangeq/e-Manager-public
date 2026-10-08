const controlPlaneErrorMessages = {
  digital_employee_not_found: "员工目录已更新，请返回员工列表刷新后重试。",
  tool_binding_request_already_pending: "该 Tool 已有同方向申请在审批中。",
};

function controlPlaneError(data, fallback) {
  const error = new Error(controlPlaneErrorMessages[data.error] || data.error || fallback);
  error.code = data.error || "control_plane_request_failed";
  return error;
}

async function controlPlaneRequest(url) {
  const response = await fetch(url, { credentials: "include" });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || !data.ok) {
    throw controlPlaneError(data, "控制面接口失败");
  }
  return data;
}

async function controlPlaneJsonRequest(url, body) {
  const response = await fetch(url, {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || !data.ok) {
    throw controlPlaneError(data, "控制面操作失败");
  }
  return data;
}

export async function fetchControlPlaneState() {
  const [
    subsystems,
    capabilityRequests,
    distributions,
    qualityEvents,
    invocationPolicies,
  ] = await Promise.all([
    controlPlaneRequest("/api/control-plane/subsystems"),
    controlPlaneRequest("/api/control-plane/capability-requests"),
    controlPlaneRequest("/api/control-plane/distributions"),
    controlPlaneRequest("/api/control-plane/quality-events"),
    controlPlaneRequest("/api/control-plane/invocation-policies"),
  ]);

  return {
    subsystems: subsystems.subsystems || [],
    capabilityRequests: capabilityRequests.capabilityRequests || [],
    distributions: distributions.distributions || [],
    qualityEvents: qualityEvents.qualityEvents || [],
    invocationPolicies: invocationPolicies.invocationPolicies || [],
  };
}

export async function postQualityReviewAction(eventId, payload) {
  return controlPlaneJsonRequest(`/api/control-plane/quality-events/${encodeURIComponent(eventId)}/review-actions`, payload);
}

export async function postSubsystemAssignmentDraft(subsystemId, payload) {
  return controlPlaneJsonRequest(`/api/control-plane/subsystems/${encodeURIComponent(subsystemId)}/assignment-draft`, payload);
}

export async function postCapabilityRequestDecision(requestId, payload) {
  return controlPlaneJsonRequest(`/api/control-plane/capability-requests/${encodeURIComponent(requestId)}/decision`, payload);
}

export async function fetchSkillMountRequests() {
  return controlPlaneRequest("/api/control-plane/skill-mount-requests");
}

export async function postSkillMountRequest(payload) {
  return controlPlaneJsonRequest("/api/control-plane/skill-mount-requests", payload);
}

export async function postSkillMountDecision(requestId, payload) {
  return controlPlaneJsonRequest(`/api/control-plane/skill-mount-requests/${encodeURIComponent(requestId)}/decision`, payload);
}

export async function fetchToolBindingRequests(params = {}) {
  const search = new URLSearchParams();
  Object.entries(params).forEach(([key, value]) => {
    if (value) search.set(key, value);
  });
  const suffix = search.toString() ? `?${search.toString()}` : "";
  return controlPlaneRequest(`/api/control-plane/tool-binding-requests${suffix}`);
}

export async function postToolBindingRequest(payload) {
  return controlPlaneJsonRequest("/api/control-plane/tool-binding-requests", payload);
}

export async function postToolBindingDecision(requestId, payload) {
  return controlPlaneJsonRequest(`/api/control-plane/tool-binding-requests/${encodeURIComponent(requestId)}/decision`, payload);
}

export async function fetchManagedSandboxProfiles() {
  return controlPlaneRequest("/api/control-plane/managed-sandbox-profiles");
}
