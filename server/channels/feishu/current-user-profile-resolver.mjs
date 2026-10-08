const FEISHU_CONTACT_USER_URL = "https://open.feishu.cn/open-apis/contact/v3/users";
const FEISHU_CONTACT_DEPARTMENT_URL = "https://open.feishu.cn/open-apis/contact/v3/departments";

function createFeishuCurrentUserProfileResolver({
  fetch = globalThis.fetch,
  readSecret,
  timeoutMs = 8_000,
  validateFeishuCredentials,
} = {}) {
  if (typeof fetch !== "function" || typeof readSecret !== "function" ||
    typeof validateFeishuCredentials !== "function") {
    throw new TypeError("feishu_current_user_profile_resolver_invalid");
  }
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1_000 || timeoutMs > 30_000) {
    throw new TypeError("feishu_current_user_profile_resolver_invalid");
  }

  return async function resolveFeishuCurrentUserProfile({ employeeId = "", signal = null, subjectId = "" } = {}) {
    const scopedEmployeeId = boundedText(employeeId, 160);
    const expectedOpenId = boundedText(subjectId, 240);
    if (!scopedEmployeeId || !expectedOpenId) return null;
    const appId = boundedText(readSecret("appId", scopedEmployeeId), 240);
    const appSecret = boundedText(readSecret("appSecret", scopedEmployeeId), 8 * 1024);
    if (!appId || !appSecret) return null;
    let credentials;
    let user;
    try {
      credentials = await validateFeishuCredentials({ appId, appSecret });
      if (!credentials?.ok || !credentials.tenantAccessToken) return null;
      user = await requestFeishuJson({
        fetch,
        signal,
        timeoutMs,
        token: credentials.tenantAccessToken,
        url: `${FEISHU_CONTACT_USER_URL}/${encodeURIComponent(expectedOpenId)}?user_id_type=open_id&department_id_type=open_department_id`,
      });
    } catch {
      return null;
    }
    const value = user?.data?.user || user?.user || {};
    const actualOpenId = boundedText(value.open_id || value.openId, 240);
    const subjectDisplayName = boundedText(value.name, 120);
    const unionId = boundedText(value.union_id || value.unionId, 240);
    if (Number(user?.code) !== 0 || actualOpenId !== expectedOpenId || (!subjectDisplayName && !unionId)) return null;
    const departmentIds = uniqueTexts(value.department_ids || value.departmentIds, 8, 160);
    const departmentNames = [];
    for (const departmentId of departmentIds) {
      const department = await requestFeishuJson({
        fetch,
        signal,
        timeoutMs,
        token: credentials.tenantAccessToken,
        url: `${FEISHU_CONTACT_DEPARTMENT_URL}/${encodeURIComponent(departmentId)}?department_id_type=open_department_id&user_id_type=open_id`,
      }).catch(() => null);
      const name = boundedText(department?.data?.department?.name || department?.department?.name, 160);
      if (Number(department?.code) === 0 && name) departmentNames.push(name);
    }
    return Object.freeze({
      contractVersion: "feishu-current-user-profile.v1",
      subjectId: actualOpenId,
      subjectIdType: "feishu_sender_id",
      ...(subjectDisplayName ? { subjectDisplayName } : {}),
      ...(unionId ? {
        subjectAliases: Object.freeze([Object.freeze({
          subjectId: unionId,
          subjectIdType: "feishu_union_id",
        })]),
      } : {}),
      departmentRefs: Object.freeze([...new Set([...departmentIds, ...departmentNames])]),
    });
  };
}

async function requestFeishuJson({ fetch, signal = null, timeoutMs, token, url }) {
  const controller = new AbortController();
  const canceled = () => controller.abort();
  if (signal?.aborted) controller.abort();
  signal?.addEventListener?.("abort", canceled, { once: true });
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  timer.unref?.();
  try {
    const response = await fetch(url, {
      method: "GET",
      headers: { Authorization: `Bearer ${token}` },
      signal: controller.signal,
    });
    if (!response.ok) return null;
    const value = await response.json().catch(() => null);
    return value && typeof value === "object" && !Array.isArray(value) ? value : null;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener?.("abort", canceled);
  }
}

function uniqueTexts(value, maxItems, maxLength) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.slice(0, maxItems).map((item) => boundedText(item, maxLength)).filter(Boolean))];
}

function boundedText(value, maxLength) {
  const text = String(value || "").trim();
  return text && text.length <= maxLength && !/[\r\n\0]/.test(text) ? text : "";
}

export {
  FEISHU_CONTACT_DEPARTMENT_URL,
  FEISHU_CONTACT_USER_URL,
  createFeishuCurrentUserProfileResolver,
};
