const CONTRACT_VERSION = "current-user-tool-authorization-action.v1";
const AUTHORIZE_ORIGIN = "https://accounts.feishu.cn";
const AUTHORIZE_PATH = "/open-apis/authen/v1/authorize";

function normalizeCurrentUserAuthorizationAction(value = null) {
  if (!value || value.contractVersion !== CONTRACT_VERSION || value.kind !== "open_url") return null;
  try {
    const url = new URL(String(value.url || ""));
    const expiresAt = new Date(value.expiresAt);
    const label = cleanText(value.label, 80);
    if (url.origin !== AUTHORIZE_ORIGIN || url.pathname !== AUTHORIZE_PATH || url.hash ||
      url.searchParams.get("response_type") !== "code" || url.searchParams.get("code_challenge_method") !== "S256" ||
      !/^[A-Za-z0-9_-]{32,180}$/.test(url.searchParams.get("state") || "") ||
      !/^[A-Za-z0-9_-]{32,180}$/.test(url.searchParams.get("code_challenge") || "") ||
      !label || !Number.isFinite(expiresAt.getTime())) return null;
    return Object.freeze({
      contractVersion: CONTRACT_VERSION,
      kind: "open_url",
      label,
      url: url.toString(),
      expiresAt: expiresAt.toISOString(),
    });
  } catch {
    return null;
  }
}

function currentUserAuthorizationEventsFromSse(body = "") {
  const events = [];
  const blocks = String(body || "").replace(/\r\n/g, "\n").split("\n\n");
  for (const block of blocks) {
    const lines = block.split("\n");
    if (!lines.some((line) => line.trim() === "event: credential")) continue;
    const dataText = lines.filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trim()).join("\n");
    try {
      const value = JSON.parse(dataText);
      const toolId = cleanToken(value?.toolId, 120);
      if (!toolId) continue;
      const authorizationAction = normalizeCurrentUserAuthorizationAction(value.authorizationAction);
      events.push(Object.freeze({
        toolId,
        status: cleanToken(value.status, 120),
        clear: value.clear === true,
        ...(authorizationAction ? { authorizationAction } : {}),
      }));
    } catch {
      // Ignore malformed or unsafe transient action events.
    }
  }
  return Object.freeze(events);
}

function cleanText(value, maximum) {
  return String(value || "").replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, maximum);
}

function cleanToken(value, maximum) {
  const token = cleanText(value, maximum).toLowerCase();
  return /^[a-z0-9._-]+$/.test(token) ? token : "";
}

export {
  currentUserAuthorizationEventsFromSse,
  normalizeCurrentUserAuthorizationAction,
};
