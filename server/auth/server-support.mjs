import crypto from "node:crypto";
import fs from "node:fs";

export function loadEnvFile(filePath) {
  if (!fs.existsSync(filePath)) return;
  const lines = fs.readFileSync(filePath, "utf8").split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const splitIndex = trimmed.indexOf("=");
    if (splitIndex === -1) continue;
    const key = trimmed.slice(0, splitIndex).trim();
    const rawValue = trimmed.slice(splitIndex + 1).trim();
    if (!key || process.env[key] !== undefined) continue;
    process.env[key] = rawValue.replace(/^["']|["']$/g, "");
  }
}

export function resolveSsoCallbackBaseUri(req, configuredFrontendOrigin = "") {
  if (process.env.FORTRESS_SERVICE_URL && process.env.FORTRESS_SERVICE_URL_AUTO !== "1") {
    return process.env.FORTRESS_SERVICE_URL;
  }
  if (configuredFrontendOrigin) {
    return `${trimTrailingSlash(configuredFrontendOrigin)}/api/auth/sso/callback`;
  }
  const forwardedHost = req.headers["x-forwarded-host"];
  const host = Array.isArray(forwardedHost) ? forwardedHost[0] : forwardedHost || req.headers.host;
  const protocol = req.headers["x-forwarded-proto"] || "http";
  return `${protocol}://${host}/api/auth/sso/callback`;
}

export function resolveFrontendOrigin(req, configuredFrontendOrigin = "") {
  if (configuredFrontendOrigin) return configuredFrontendOrigin;
  const forwardedHost = req.headers["x-forwarded-host"];
  const host = Array.isArray(forwardedHost) ? forwardedHost[0] : forwardedHost || req.headers.host;
  const protocol = req.headers["x-forwarded-proto"] || "http";
  return `${protocol}://${host}`;
}

export function buildFortressLoginUrl({ appId, serviceUrl, loginUrl }) {
  const url = new URL(loginUrl);
  url.searchParams.set("appId", appId);
  url.searchParams.set("serviceUrl", serviceUrl);
  return url;
}

export function applyCatalogFilters(items, url, fields) {
  const query = String(url.searchParams.get("q") || "").trim().toLowerCase();
  return items.filter((item) => {
    const fieldMatches = fields.every((field) => {
      const expected = url.searchParams.get(field);
      if (!expected) return true;
      return String(valueAtPath(item, field) || "") === expected;
    });
    if (!fieldMatches) return false;
    if (!query) return true;
    return flattenSearchValues(item).join(" ").toLowerCase().includes(query);
  });
}

function valueAtPath(item, path) {
  return String(path || "")
    .split(".")
    .reduce((value, key) => (value && typeof value === "object" ? value[key] : undefined), item);
}

function flattenSearchValues(value) {
  if (Array.isArray(value)) return value.flatMap(flattenSearchValues);
  if (value && typeof value === "object") return Object.values(value).flatMap(flattenSearchValues);
  return [value ?? ""];
}

export function signState(payload, secret) {
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const signature = crypto.createHmac("sha256", secret).update(body).digest("base64url");
  return `${body}.${signature}`;
}

export function verifyState(state, secret) {
  const [body, signature] = String(state || "").split(".");
  if (!body || !signature) return null;
  const expected = crypto.createHmac("sha256", secret).update(body).digest("base64url");
  const actualBuffer = Buffer.from(signature);
  const expectedBuffer = Buffer.from(expected);
  if (actualBuffer.length !== expectedBuffer.length) return null;
  if (!crypto.timingSafeEqual(actualBuffer, expectedBuffer)) return null;
  const payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
  if (Date.now() - Number(payload.ts || 0) > 10 * 60 * 1000) return null;
  return payload;
}

export function safeRelativeRedirect(value) {
  if (!value || typeof value !== "string") return "/";
  if (!value.startsWith("/") || value.startsWith("//")) return "/";
  return value;
}

export function fortressCredentials() {
  return {
    appId: process.env.FORTRESS_APP_ID,
    appSecret: process.env.FORTRESS_APP_SECRET,
  };
}

export function envList(key) {
  return String(process.env[key] || "")
    .split(/[,\n;，；、]+/)
    .map((item) => item.trim())
    .filter(Boolean);
}

export function requestId(prefix) {
  return `${prefix}-${crypto.randomUUID()}`;
}

export function cleanText(value) {
  return String(value || "").replace(/\s+/g, " ").trim().slice(0, 800);
}

export function cleanList(value) {
  const items = Array.isArray(value) ? value : String(value || "").split(/[,\n;，；、]+/);
  return items.map(cleanText).filter(Boolean).slice(0, 20);
}

export function trimTrailingSlash(value) {
  return String(value || "").replace(/\/+$/, "");
}

export function clampNumber(value, min, max, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, number));
}

export function parseCookies(header = "") {
  return Object.fromEntries(
    header
      .split(";")
      .map((item) => item.trim())
      .filter(Boolean)
      .map((item) => {
        const index = item.indexOf("=");
        return [item.slice(0, index), decodeURIComponent(item.slice(index + 1))];
      }),
  );
}

export function cookie(name, value, options = {}) {
  const parts = [`${name}=${encodeURIComponent(value)}`, "Path=/", "SameSite=Lax"];
  if (options.httpOnly) parts.push("HttpOnly");
  if (Number.isFinite(options.maxAge)) parts.push(`Max-Age=${options.maxAge}`);
  return parts.join("; ");
}

export function sendJson(res, status, body) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
}

export function readJsonBody(req, maxBytes = 32 * 1024) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.setEncoding("utf8");
    req.on("data", (chunk) => {
      body += chunk;
      if (body.length > maxBytes) {
        reject(new Error("Request body too large"));
        req.destroy();
      }
    });
    req.on("end", () => {
      if (!body.trim()) return resolve({});
      try {
        resolve(JSON.parse(body));
      } catch (error) {
        reject(error);
      }
    });
    req.on("error", reject);
  });
}

export function redirectResponse(res, location) {
  res.writeHead(302, { Location: location });
  res.end();
}

export function redactError(error) {
  let text = String(error?.stack || error?.message || error);
  for (const value of [
    process.env.FORTRESS_APP_SECRET,
    process.env.AUTH_SESSION_SECRET,
    process.env.FXIAOKE_APPROVAL_TRIGGER_TOKEN,
  ].filter(Boolean)) {
    text = text.replace(new RegExp(escapeRegExp(value), "g"), "[redacted]");
  }
  return text;
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
