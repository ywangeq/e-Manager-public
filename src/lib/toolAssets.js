const fields = ["toolId", "displayName", "description", "ownerDepartmentId", "sourceSystemId", "risk", "permissionBoundary", "writebackBoundary", "baseUrl", "credentialRef", "openApiDocument"];
export function toolAssetInput(value) {
  const result = Object.fromEntries(fields.map(key => [key, value[key]]));
  if (typeof result.openApiDocument === "string") {
    try { result.openApiDocument = JSON.parse(result.openApiDocument); }
    catch { throw new Error("OpenAPI 必须是有效 JSON。"); }
  }
  return result;
}
export async function toolAssetRequest(path = "", body) {
  const response = await fetch(`/api/tool-assets${path}`, {
    credentials: "include",
    ...(body ? { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) } : {}),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || !data.ok) {
    const messages = { tool_asset_version_conflict: "记录已变化，请重新打开后核对。",
      tool_asset_reference_unavailable: "系统或凭证引用不可用，或接口地址与系统来源不一致。",
      tool_asset_credential_contract_invalid: "当前适配器需要一个 header API key 鉴权声明。",
      tool_asset_contract_invalid: "OpenAPI 合同无效或没有可用操作。",
      tool_asset_governance_required: "需要 Tool 治理管理员权限。" };
    throw new Error(messages[data.error] || `Tool 操作失败（${data.error || response.status}）`);
  }
  return data;
}
