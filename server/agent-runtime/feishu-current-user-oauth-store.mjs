import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const STORE_VERSION = "feishu-current-user-oauth-store.v2";
const MAX_PENDING = 100;
const MAX_GRANTS = 1_000;

function createFeishuCurrentUserOAuthStore({ encryptionKey, now = () => new Date(), storePath } = {}) {
  const key = normalizeKey(encryptionKey);
  const targetPath = String(storePath || "").trim();
  if (!path.isAbsolute(targetPath) || typeof now !== "function") {
    throw new TypeError("feishu_current_user_oauth_store_invalid");
  }

  function createPendingAuthorization({ actorSubjectDigest, appCredentialDigest, employeeId, requiredScopes = [], subjectId, subjectIdType } = {}) {
    const at = trustedNow(now);
    const store = prune(readStore(), at, key);
    const normalized = {
      actorSubjectDigest: requiredDigest(actorSubjectDigest),
      appCredentialDigest: requiredDigest(appCredentialDigest),
      employeeId: requiredText(employeeId, 160),
      subjectId: requiredText(subjectId, 240),
      subjectIdType: requiredText(subjectIdType, 80),
      requiredScopes: normalizeScopes(requiredScopes),
    };
    for (const [recordKey, encrypted] of Object.entries(store.pending)) {
      const value = decryptRecord(encrypted, key);
      if (value && sameAuthorizationSubject(value, normalized)) delete store.pending[recordKey];
    }
    const state = crypto.randomBytes(32).toString("base64url");
    const codeVerifier = crypto.randomBytes(48).toString("base64url");
    const value = {
      contractVersion: "feishu-current-user-oauth-pending.v1",
      ...normalized,
      state,
      codeVerifier,
      codeChallenge: crypto.createHash("sha256").update(codeVerifier).digest("base64url"),
      createdAt: at.toISOString(),
      expiresAt: new Date(at.getTime() + 10 * 60_000).toISOString(),
    };
    store.pending[digest(state)] = encryptRecord(value, key);
    trimEncryptedRecords(store.pending, MAX_PENDING);
    writeStore(store);
    return publicPending(value);
  }

  function consumePendingAuthorization(state) {
    const at = trustedNow(now);
    const store = prune(readStore(), at, key);
    const stateValue = requiredText(state, 180);
    const stateDigest = digest(stateValue);
    const value = decryptRecord(store.pending[stateDigest], key);
    delete store.pending[stateDigest];
    writeStore(store);
    if (!value || value.state !== stateValue || Date.parse(value.expiresAt) <= at.getTime()) return null;
    return Object.freeze(value);
  }

  function saveGrant(value = {}) {
    const at = trustedNow(now);
    const grant = normalizeGrant(value);
    const store = prune(readStore(), at, key);
    store.grants[grantKey(grant)] = encryptRecord(grant, key);
    trimEncryptedRecords(store.grants, MAX_GRANTS);
    writeStore(store);
    return safeGrantSummary(grant);
  }

  function readGrant({ actorSubjectDigest, employeeId, subjectId, subjectIdType } = {}) {
    const at = trustedNow(now);
    const store = prune(readStore(), at, key);
    const locator = {
      actorSubjectDigest: requiredDigest(actorSubjectDigest),
      employeeId: requiredText(employeeId, 160),
      subjectId: requiredText(subjectId, 240),
      subjectIdType: requiredText(subjectIdType, 80),
    };
    const grant = decryptRecord(store.grants[grantKey(locator)], key);
    if (!grant || grant.actorSubjectDigest !== locator.actorSubjectDigest ||
      grant.employeeId !== locator.employeeId || grant.subjectId !== locator.subjectId ||
      grant.subjectIdType !== locator.subjectIdType) return null;
    return Object.freeze(grant);
  }

  function deleteGrant(locator = {}) {
    const store = readStore();
    const keyValue = grantKey({
      actorSubjectDigest: requiredDigest(locator.actorSubjectDigest),
      employeeId: requiredText(locator.employeeId, 160),
      subjectId: requiredText(locator.subjectId, 240),
      subjectIdType: requiredText(locator.subjectIdType, 80),
    });
    const existed = Boolean(store.grants[keyValue]);
    delete store.grants[keyValue];
    if (existed) writeStore(store);
    return existed;
  }

  function readStore() {
    try {
      if (!fs.existsSync(targetPath)) return emptyStore();
      const value = JSON.parse(fs.readFileSync(targetPath, "utf8"));
      if (value?.version !== STORE_VERSION || !plainObject(value.pending) || !plainObject(value.grants)) return emptyStore();
      return { version: STORE_VERSION, pending: { ...value.pending }, grants: { ...value.grants } };
    } catch {
      return emptyStore();
    }
  }

  function writeStore(value) {
    fs.mkdirSync(path.dirname(targetPath), { recursive: true });
    const temporaryPath = `${targetPath}.${process.pid}.${crypto.randomUUID()}.tmp`;
    fs.writeFileSync(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    fs.renameSync(temporaryPath, targetPath);
  }

  return Object.freeze({
    contractVersion: STORE_VERSION,
    consumePendingAuthorization,
    createPendingAuthorization,
    deleteGrant,
    readGrant,
    saveGrant,
  });
}

function normalizeGrant(value = {}) {
  if (!plainObject(value) || value.contractVersion !== "feishu-current-user-oauth-grant.v1") {
    throw new TypeError("feishu_current_user_oauth_grant_invalid");
  }
  return Object.freeze({
    contractVersion: value.contractVersion,
    actorSubjectDigest: requiredDigest(value.actorSubjectDigest),
    appCredentialDigest: requiredDigest(value.appCredentialDigest),
    authorizedOpenId: requiredText(value.authorizedOpenId, 240),
    employeeId: requiredText(value.employeeId, 160),
    subjectId: requiredText(value.subjectId, 240),
    subjectIdType: requiredText(value.subjectIdType, 80),
    scopes: normalizeScopes(value.scopes),
    accessToken: requiredSecret(value.accessToken),
    refreshToken: optionalSecret(value.refreshToken),
    issuedAt: timestamp(value.issuedAt),
    expiresAt: timestamp(value.expiresAt),
    refreshExpiresAt: value.refreshToken ? timestamp(value.refreshExpiresAt) : "",
  });
}

function publicPending(value) {
  return Object.freeze({
    contractVersion: value.contractVersion,
    employeeId: value.employeeId,
    subjectId: value.subjectId,
    subjectIdType: value.subjectIdType,
    requiredScopes: Object.freeze([...value.requiredScopes]),
    state: value.state,
    codeChallenge: value.codeChallenge,
    expiresAt: value.expiresAt,
  });
}

function safeGrantSummary(value) {
  return Object.freeze({
    contractVersion: value.contractVersion,
    employeeId: value.employeeId,
    subjectIdType: value.subjectIdType,
    scopes: Object.freeze([...value.scopes]),
    issuedAt: value.issuedAt,
    expiresAt: value.expiresAt,
    refreshExpiresAt: value.refreshExpiresAt,
  });
}

function prune(store, at, encryptionKey) {
  for (const [recordKey, encrypted] of Object.entries(store.pending)) {
    const value = decryptRecord(encrypted, encryptionKey);
    if (!value || !Number.isFinite(Date.parse(value.expiresAt)) || Date.parse(value.expiresAt) <= at.getTime()) {
      delete store.pending[recordKey];
    }
  }
  for (const [recordKey, encrypted] of Object.entries(store.grants)) {
    const value = decryptRecord(encrypted, encryptionKey);
    const accessExpired = !value || !Number.isFinite(Date.parse(value.expiresAt)) || Date.parse(value.expiresAt) <= at.getTime();
    const refreshExpired = !value?.refreshToken || !Number.isFinite(Date.parse(value.refreshExpiresAt)) || Date.parse(value.refreshExpiresAt) <= at.getTime();
    if (accessExpired && refreshExpired) delete store.grants[recordKey];
  }
  return store;
}

function emptyStore() {
  return { version: STORE_VERSION, pending: {}, grants: {} };
}

function sameAuthorizationSubject(left, right) {
  return left.actorSubjectDigest === right.actorSubjectDigest && left.employeeId === right.employeeId &&
    left.subjectId === right.subjectId && left.subjectIdType === right.subjectIdType;
}

function grantKey(value) {
  return digest(JSON.stringify([value.actorSubjectDigest, value.employeeId, value.subjectIdType, value.subjectId]));
}

function trimEncryptedRecords(records, maximum) {
  const keys = Object.keys(records);
  while (keys.length > maximum) delete records[keys.shift()];
}

function encryptRecord(value, key) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const data = Buffer.concat([cipher.update(JSON.stringify(value), "utf8"), cipher.final()]);
  return { alg: "aes-256-gcm", iv: iv.toString("base64"), tag: cipher.getAuthTag().toString("base64"), data: data.toString("base64") };
}

function decryptRecord(value, key) {
  if (!value || !key) return null;
  try {
    const decipher = crypto.createDecipheriv("aes-256-gcm", key, Buffer.from(value.iv, "base64"));
    decipher.setAuthTag(Buffer.from(value.tag, "base64"));
    return JSON.parse(Buffer.concat([decipher.update(Buffer.from(value.data, "base64")), decipher.final()]).toString("utf8"));
  } catch {
    return null;
  }
}

function normalizeKey(value) {
  const key = Buffer.from(value || []);
  if (key.length !== 32) throw new TypeError("feishu_current_user_oauth_store_invalid");
  return key;
}

function normalizeScopes(value) {
  if (!Array.isArray(value) || value.length > 50) throw new TypeError("feishu_current_user_oauth_scope_invalid");
  const scopes = [...new Set(value.map((item) => requiredText(item, 180)))].sort();
  if (!scopes.length) throw new TypeError("feishu_current_user_oauth_scope_invalid");
  return Object.freeze(scopes);
}

function requiredText(value, maximum) {
  const text = String(value || "").trim();
  if (!text || text.length > maximum || /[\r\n\0]/.test(text)) throw new TypeError("feishu_current_user_oauth_value_invalid");
  return text;
}

function requiredDigest(value) {
  const result = String(value || "").trim().toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(result)) throw new TypeError("feishu_current_user_oauth_digest_invalid");
  return result;
}

function requiredSecret(value) {
  const text = String(value || "").trim();
  if (!text || text.length > 8 * 1024 || /\s/.test(text)) throw new TypeError("feishu_current_user_oauth_grant_invalid");
  return text;
}

function optionalSecret(value) {
  return value ? requiredSecret(value) : "";
}

function timestamp(value) {
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime())) throw new TypeError("feishu_current_user_oauth_time_invalid");
  return parsed.toISOString();
}

function trustedNow(now) {
  const value = now();
  const at = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(at.getTime())) throw new TypeError("feishu_current_user_oauth_clock_invalid");
  return at;
}

function digest(value) {
  return crypto.createHash("sha256").update(String(value)).digest("hex");
}

function plainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export { createFeishuCurrentUserOAuthStore };
