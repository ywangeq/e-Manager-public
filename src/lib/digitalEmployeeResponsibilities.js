async function readResponse(response, fallback) {
  const data = await response.json().catch(() => ({}));
  if (!response.ok || !data.ok) throw new Error(data.message || data.error || fallback);
  return data;
}

export async function fetchDigitalEmployeeResponsibilities(employeeId) {
  const response = await fetch(`/api/digital-employees/${encodeURIComponent(employeeId)}/responsibilities`, {
    credentials: "include",
  });
  return readResponse(response, "责任分工上下文读取失败");
}

export async function saveDigitalEmployeeResponsibilities(employeeId, payload) {
  const response = await fetch(`/api/digital-employees/${encodeURIComponent(employeeId)}/responsibilities`, {
    method: "PUT",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  return readResponse(response, "责任分工保存失败");
}

export async function decideDigitalEmployeeResponsibilities(employeeId, payload) {
  const response = await fetch(`/api/digital-employees/${encodeURIComponent(employeeId)}/responsibilities/decision`, {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  return readResponse(response, "责任分工审核失败");
}
