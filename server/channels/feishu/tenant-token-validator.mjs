import { FEISHU_TENANT_TOKEN_URL } from "./integration-contract.mjs";
import { cleanText, maskIdentifier } from "../../feishu-integration-support.mjs";

export function createFeishuCredentialValidator({ fetch = globalThis.fetch } = {}) {
  return async function validateFeishuCredentials({ appId, appSecret }) {
    if (process.env.FEISHU_CONNECTION_SKIP_REMOTE_VALIDATION === "1") {
      return {
        ok: true,
        safeSummary: {
          status: "skipped_for_local_test",
          checkedAt: new Date().toISOString(),
          appIdMasked: maskIdentifier(appId),
          message: "本地测试已跳过飞书远端凭证校验。",
        },
      };
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8000);
    try {
      const response = await fetch(FEISHU_TENANT_TOKEN_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ app_id: appId, app_secret: appSecret }),
        signal: controller.signal,
      });
      const data = await response.json().catch(() => ({}));
      const ok = response.ok && Number(data.code) === 0 && data.tenant_access_token;
      return {
        ok,
        message: ok ? "飞书应用凭证校验通过。" : cleanText(data.msg || data.message || "飞书应用凭证校验失败。"),
        safeSummary: {
          status: ok ? "validated" : "failed",
          checkedAt: new Date().toISOString(),
          appIdMasked: maskIdentifier(appId),
          expireSeconds: ok ? Number(data.expire) || undefined : undefined,
          responseCode: Number.isFinite(Number(data.code)) ? Number(data.code) : undefined,
          message: ok ? "tenant_access_token 校验通过。" : cleanText(data.msg || data.message || "飞书应用凭证校验失败。"),
        },
        tenantAccessToken: ok ? data.tenant_access_token : "",
      };
    } catch (error) {
      return {
        ok: false,
        message: error?.name === "AbortError" ? "飞书凭证校验超时。" : "无法连接飞书凭证校验接口。",
        safeSummary: {
          status: "failed",
          checkedAt: new Date().toISOString(),
          appIdMasked: maskIdentifier(appId),
          message: error?.name === "AbortError" ? "飞书凭证校验超时。" : "无法连接飞书凭证校验接口。",
        },
      };
    } finally {
      clearTimeout(timer);
    }
  };
}
