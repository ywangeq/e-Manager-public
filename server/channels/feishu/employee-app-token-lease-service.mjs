import { randomUUID } from "node:crypto";
import { FEISHU_TENANT_TOKEN_URL } from "./integration-contract.mjs";

function createFeishuEmployeeAppTokenLeaseService({
  fetch = globalThis.fetch,
  readEmployeeAppCredentials,
  timeoutMs = 8_000,
} = {}) {
  if (typeof fetch !== "function" || typeof readEmployeeAppCredentials !== "function") {
    throw new TypeError("feishu_employee_app_token_lease_service_invalid");
  }
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1_000 || timeoutMs > 30_000) {
    throw new TypeError("feishu_employee_app_token_lease_service_invalid");
  }

  return Object.freeze({
    async acquireForOperation({ employeeId = "", signal = null } = {}) {
      const scopedEmployeeId = boundedText(employeeId, 160);
      if (!scopedEmployeeId) throw codedError("feishu_employee_app_identity_invalid");
      const credentials = readEmployeeAppCredentials(scopedEmployeeId) || {};
      const appId = boundedText(credentials.appId, 240);
      const appSecret = boundedText(credentials.appSecret, 8 * 1024);
      if (!appId || !appSecret) throw codedError("feishu_employee_app_credentials_unavailable");
      const controller = new AbortController();
      const canceled = () => controller.abort();
      if (signal?.aborted) controller.abort();
      signal?.addEventListener?.("abort", canceled, { once: true });
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      timer.unref?.();
      try {
        const response = await fetch(FEISHU_TENANT_TOKEN_URL, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ app_id: appId, app_secret: appSecret }),
          signal: controller.signal,
        });
        const payload = await response.json().catch(() => ({}));
        const token = boundedText(payload?.tenant_access_token, 8 * 1024);
        if (!response.ok || Number(payload?.code) !== 0 || !token) {
          throw codedError("feishu_employee_app_credential_rejected");
        }
        return Object.freeze({
          authorization: `Bearer ${token}`,
          leaseRef: `feishu-employee-app:${scopedEmployeeId}:${randomUUID()}`,
        });
      } catch (error) {
        if (error?.code) throw error;
        if (controller.signal.aborted) throw codedError("feishu_employee_app_token_lease_canceled");
        throw codedError("feishu_employee_app_token_lease_unavailable");
      } finally {
        clearTimeout(timer);
        signal?.removeEventListener?.("abort", canceled);
      }
    },
    invalidate() {
      return true;
    },
  });
}

function codedError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

function boundedText(value, maxLength) {
  const text = String(value || "").trim();
  return text && text.length <= maxLength && !/[\r\n\0]/.test(text) ? text : "";
}

export { createFeishuEmployeeAppTokenLeaseService };
