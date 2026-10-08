import { cleanShortText } from "../../feishu-integration-support.mjs";

const FEISHU_BOT_INFO_URL = "https://open.feishu.cn/open-apis/bot/v3/info";

function createFeishuBotIdentityResolver({
  fetch = globalThis.fetch,
  readSecret,
  testBotOpenId = "",
  validateFeishuCredentials,
} = {}) {
  let resolvedIdentity = null;
  let pendingResolution = null;

  return async function resolveFeishuBotIdentity({ employeeId = "" } = {}) {
    const explicitTestOpenId = cleanShortText(testBotOpenId);
    const appId = explicitTestOpenId
      ? `test:${explicitTestOpenId}`
      : cleanShortText(typeof readSecret === "function" ? readSecret("appId", employeeId) : "");
    if (!appId) return null;
    if (resolvedIdentity?.appId === appId) return resolvedIdentity.value;
    if (pendingResolution?.appId === appId) return pendingResolution.promise;
    const promise = resolveIdentity({ appId, employeeId, explicitTestOpenId }).finally(() => {
      if (pendingResolution?.promise === promise) pendingResolution = null;
    });
    pendingResolution = { appId, promise };
    const identity = await promise;
    if (identity) resolvedIdentity = { appId, value: identity };
    return identity;

    async function resolveIdentity({ appId: currentAppId, employeeId: scopedEmployeeId, explicitTestOpenId = "" } = {}) {
      if (explicitTestOpenId) return { openId: explicitTestOpenId, name: "test bot", source: "test_override" };
      if (typeof readSecret !== "function" || typeof validateFeishuCredentials !== "function" || typeof fetch !== "function") return null;
      const appSecret = cleanShortText(readSecret("appSecret", scopedEmployeeId));
      if (!appSecret) return null;
      const credentials = await validateFeishuCredentials({ appId: currentAppId, appSecret });
      if (!credentials?.ok || !credentials.tenantAccessToken) return null;
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 8_000);
      timer.unref?.();
      try {
        const response = await fetch(FEISHU_BOT_INFO_URL, {
          method: "GET",
          headers: { Authorization: `Bearer ${credentials.tenantAccessToken}` },
          signal: controller.signal,
        });
        const payload = await response.json().catch(() => ({}));
        const bot = payload.bot || payload.data?.bot || {};
        const openId = cleanShortText(bot.open_id || bot.openId);
        const responseAppId = cleanShortText(bot.app_id || bot.appId || payload.app_id || payload.appId);
        if (!response.ok || Number(payload.code) !== 0 || !openId || (responseAppId && responseAppId !== currentAppId)) return null;
        return {
          openId,
          name: cleanShortText(bot.app_name || bot.appName || "bot"),
          source: "feishu_bot_info",
        };
      } catch {
        return null;
      } finally {
        clearTimeout(timer);
      }
    }
  };
}

export {
  FEISHU_BOT_INFO_URL,
  createFeishuBotIdentityResolver,
};
