async function readResponse(response) {
  const data = await response.json().catch(() => ({}));
  if (!response.ok || !data.ok) throw new Error(data.message || data.error || "展示名称保存失败");
  return data;
}

export async function updateDigitalEmployeeDisplayName(employeeId, displayName) {
  const response = await fetch(`/api/digital-employees/${encodeURIComponent(employeeId)}/profile`, {
    method: "PUT",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ displayName }),
  });
  return readResponse(response);
}
