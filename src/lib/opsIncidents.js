async function opsRequest(path, { body = null, method = "GET" } = {}) {
  const response = await fetch(path, {
    method,
    credentials: "include",
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || !data.ok) throw new Error(data.error || "运维数据读取失败");
  return data;
}

async function requestOpsIncidents({ days = 7 } = {}) {
  const params = new URLSearchParams({ days: String(days) });
  return opsRequest(`/api/ops/incidents?${params.toString()}`);
}

function requestOpsIncidentCandidates({ days = 7 } = {}) {
  return opsRequest(`/api/ops/incident-candidates?days=${encodeURIComponent(days)}`);
}

function requestOpsRuntimeTaskSummary({ days = 7 } = {}) {
  return opsRequest(`/api/ops/runtime-task-summary?days=${encodeURIComponent(days)}`);
}

function requestOpsRuntimeTaskPerformanceSummary({ days = 7, employeeId = "" } = {}) {
  const params = new URLSearchParams({ days: String(days) });
  if (employeeId) params.set("employeeId", employeeId);
  return opsRequest(`/api/ops/runtime-task-performance-summary?${params.toString()}`);
}

function requestOpsRuntimePerformanceSummary({ windowMinutes = 15 } = {}) {
  return opsRequest(`/api/ops/runtime-performance-summary?windowMinutes=${encodeURIComponent(windowMinutes)}`);
}

function backfillOpsIncidentDiagnoses({ days = 7 } = {}) {
  return opsRequest(`/api/ops/incidents/backfill?days=${encodeURIComponent(days)}`, { method: "POST" });
}

function diagnoseOpsIncidentsWithRuntimeEvidence({ days = 7 } = {}) {
  return opsRequest(`/api/ops/incidents/runtime-evidence-diagnose?days=${encodeURIComponent(days)}`, { method: "POST" });
}

function requestOpsIncidentDiagnosisTask(incidentId) {
  return opsRequest(`/api/ops/incidents/${encodeURIComponent(incidentId)}/diagnosis-tasks`, { method: "POST" });
}

function appendOpsIncidentDiagnosis(incidentId, payload) {
  return opsRequest(`/api/ops/incidents/${encodeURIComponent(incidentId)}/diagnoses`, { method: "POST", body: payload });
}

export { appendOpsIncidentDiagnosis, backfillOpsIncidentDiagnoses, diagnoseOpsIncidentsWithRuntimeEvidence, requestOpsIncidentCandidates, requestOpsIncidentDiagnosisTask, requestOpsIncidents, requestOpsRuntimePerformanceSummary, requestOpsRuntimeTaskPerformanceSummary, requestOpsRuntimeTaskSummary };

export function requestOpsRuntimeTaskAnalytics({ days = 7, endDate = "", employeeId = "" } = {}) {
  const params = new URLSearchParams({ days: String(days) });
  if (endDate) params.set("endDate", endDate);
  if (employeeId) params.set("employeeId", employeeId);
  return opsRequest(`/api/ops/runtime-task-analytics?${params}`);
}
