export async function applyDigitalEmployeeRuntimeConfig(employeeId, binding) {
  const response = await fetch(`/api/digital-employees/${encodeURIComponent(employeeId)}/runtime-config`, {
    method: "PUT",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      modelId: binding.modelId,
      modelLevelId: binding.modelLevelId,
      assignedRequestTypes: binding.assignedRequestTypes,
    }),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || !data.ok) throw new Error(data.message || data.error || "模型配置保存失败");
  return data;
}

export const applyDigitalEmployeeModelBinding = applyDigitalEmployeeRuntimeConfig;
