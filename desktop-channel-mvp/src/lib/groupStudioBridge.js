// Keep safe failure data across both Electron boundaries; construct Errors only
// in the renderer, where custom fields will no longer be serialized away.
export function wrapGroupStudioApi(api) {
  if (!api) return null;
  return Object.fromEntries(Object.entries(api).filter(([, value]) => typeof value === "function").map(([name, invoke]) => [name, async (...args) => {
    let result;
    try { result = await invoke(...args); }
    catch { result = { groupIpcError: "desktop_group_request_failed" }; }
    if (result?.groupIpcError) {
      const code = typeof result.groupIpcError === "string" && /^[a-z][a-z0-9_]{1,159}$/.test(result.groupIpcError)
        ? result.groupIpcError : "desktop_group_request_failed";
      const error = new Error(code);
      error.code = code;
      const context = result.groupIpcContext;
      const validId = value => typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._:@-]{0,159}$/.test(value);
      if (context?.goal && context?.groupVersion && validId(context.goal.goalId) && Number.isSafeInteger(context.goal.revision) && context.goal.revision > 0 && validId(context.groupVersion.groupId) && Number.isSafeInteger(context.groupVersion.version) && context.groupVersion.version > 0) {
        error.goal = { goalId: context.goal.goalId, revision: context.goal.revision };
        error.groupVersion = { groupId: context.groupVersion.groupId, version: context.groupVersion.version };
      }
      throw error;
    }
    return result;
  }]));
}
