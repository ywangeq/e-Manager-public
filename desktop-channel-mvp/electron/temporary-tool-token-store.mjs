import crypto from "node:crypto";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";

const CONTRACT_VERSION = "desktop-tool-credentials.v1";
const DEFAULT_TTL_MS = 72 * 60 * 60 * 1000;
const MAX_SECRET_LENGTH = 8 * 1024;

function createTemporaryToolCredentialStore({
  encryption = null,
  now = () => Date.now(),
  persistence = null,
  ttlMs = DEFAULT_TTL_MS,
} = {}) {
  const credentials = new Map();
  let initialized = false;
  let persistQueue = Promise.resolve();

  async function initialize() {
    if (initialized) return;
    initialized = true;
    if (!canPersist()) return;
    const records = await persistence.load().catch(() => []);
    let changed = false;
    for (const record of Array.isArray(records) ? records : []) {
      const item = normalizePersistedRecord(record);
      if (!item || item.expiresAt <= now()) {
        changed = true;
        continue;
      }
      credentials.set(credentialKey(item.actorKeyHash, item.toolId), item);
    }
    if (changed) await persist();
  }

  async function storeBearer({ actorKey = "", clipboardText = "", toolId = "" } = {}) {
    await initialize();
    const actorKeyHash = hashActorKey(actorKey);
    const safeToolId = cleanKey(toolId);
    const token = bearerTokenFromClipboard(clipboardText);
    if (!actorKeyHash) return safeStatus(safeToolId, "authentication_required");
    if (!safeToolId) return safeStatus("", "tool_required");
    if (!token) return safeStatus(safeToolId, "bearer_not_found");
    const expiresAt = tokenExpiry(token, now(), ttlMs);
    if (expiresAt <= now()) return safeStatus(safeToolId, "expired");

    const item = canPersist()
      ? {
          actorKeyHash,
          toolId: safeToolId,
          encryptedToken: await encryption.encrypt(token),
          expiresAt,
          storage: "encrypted_local",
        }
      : {
          actorKeyHash,
          toolId: safeToolId,
          token,
          expiresAt,
          storage: "memory_only",
        };
    credentials.set(credentialKey(actorKeyHash, safeToolId), item);
    await persist();
    return safeStatus(safeToolId, "ready", expiresAt, item.storage);
  }

  async function status({ actorKey = "", toolId = "" } = {}) {
    await initialize();
    const actorKeyHash = hashActorKey(actorKey);
    const safeToolId = cleanKey(toolId);
    const key = credentialKey(actorKeyHash, safeToolId);
    const item = credentials.get(key);
    if (!item) return safeStatus(safeToolId, "missing");
    if (item.expiresAt <= now()) {
      credentials.delete(key);
      await persist();
      return safeStatus(safeToolId, "expired");
    }
    return safeStatus(safeToolId, "ready", item.expiresAt, item.storage);
  }

  async function authorizationFor({ actorKey = "", toolId = "" } = {}) {
    const state = await status({ actorKey, toolId });
    if (state.status !== "ready") return "";
    const key = credentialKey(hashActorKey(actorKey), cleanKey(toolId));
    const item = credentials.get(key);
    try {
      const token = item.storage === "encrypted_local"
        ? await encryption.decrypt(item.encryptedToken)
        : item.token;
      return bearerTokenFromClipboard(`Bearer ${token}`) ? `Bearer ${token}` : "";
    } catch {
      credentials.delete(key);
      await persist();
      return "";
    }
  }

  async function clear({ actorKey = "", toolId = "" } = {}) {
    await initialize();
    const safeToolId = cleanKey(toolId);
    credentials.delete(credentialKey(hashActorKey(actorKey), safeToolId));
    await persist();
    return safeStatus(safeToolId, "cleared");
  }

  async function clearAll() {
    await initialize();
    credentials.clear();
    await persist();
  }

  function canPersist() {
    return Boolean(persistence && encryption?.isAvailable?.());
  }

  async function persist() {
    if (!canPersist()) return;
    const records = [...credentials.values()]
      .filter((item) => item.storage === "encrypted_local")
      .map(({ actorKeyHash, toolId, encryptedToken, expiresAt }) => ({ actorKeyHash, toolId, encryptedToken, expiresAt }));
    persistQueue = persistQueue.then(() => persistence.save(records));
    await persistQueue;
  }

  return { authorizationFor, clear, clearAll, initialize, status, storeBearer };
}

function createEncryptedCredentialFilePersistence({ filePath = "" } = {}) {
  const targetPath = path.resolve(String(filePath || ""));
  return {
    async load() {
      try {
        const payload = JSON.parse(await readFile(targetPath, "utf8"));
        return payload?.contractVersion === CONTRACT_VERSION && Array.isArray(payload.credentials)
          ? payload.credentials
          : [];
      } catch (error) {
        if (error?.code === "ENOENT") return [];
        throw error;
      }
    },
    async save(credentials = []) {
      await mkdir(path.dirname(targetPath), { recursive: true, mode: 0o700 });
      const temporaryPath = `${targetPath}.tmp`;
      const payload = JSON.stringify({ contractVersion: CONTRACT_VERSION, credentials }, null, 2);
      await writeFile(temporaryPath, payload, { encoding: "utf8", mode: 0o600 });
      await rename(temporaryPath, targetPath);
      if (!credentials.length) await unlink(targetPath).catch((error) => {
        if (error?.code !== "ENOENT") throw error;
      });
    },
  };
}

function bearerTokenFromClipboard(value = "") {
  const text = String(value || "").trim();
  const match = text.match(/(?:^|authorization\s*:\s*)bearer\s+([a-z0-9._~+/=-]+)/i);
  const token = String(match?.[1] || "").trim();
  if (!token || token.length > MAX_SECRET_LENGTH || /[\r\n\0]/.test(token)) return "";
  return token;
}

function isSecureCredentialTransport(value = "", { allowPrivateLanHttp = false } = {}) {
  try {
    const url = new URL(String(value || ""));
    return url.protocol === "https:" || (
      url.protocol === "http:" && ["localhost", "127.0.0.1", "::1", "[::1]"].includes(url.hostname)
    ) || (
      allowPrivateLanHttp && url.protocol === "http:" && isPrivateLanIpv4(url.hostname)
    );
  } catch {
    return false;
  }
}

function isPrivateLanIpv4(hostname = "") {
  const parts = String(hostname || "").split(".").map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return false;
  return parts[0] === 10
    || (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31)
    || (parts[0] === 192 && parts[1] === 168);
}

function tokenExpiry(token, currentTime, ttlMs) {
  const fallback = currentTime + Math.max(60_000, Number(ttlMs) || DEFAULT_TTL_MS);
  const parts = String(token).split(".");
  if (parts.length < 2) return fallback;
  try {
    const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
    const jwtExpiry = Number(payload.exp) * 1000;
    return Number.isFinite(jwtExpiry) ? jwtExpiry : fallback;
  } catch {
    return fallback;
  }
}

function normalizePersistedRecord(record = {}) {
  const actorKeyHash = /^[a-f0-9]{64}$/.test(String(record.actorKeyHash || "")) ? record.actorKeyHash : "";
  const toolId = cleanKey(record.toolId);
  const encryptedToken = String(record.encryptedToken || "");
  const expiresAt = Number(record.expiresAt);
  if (!actorKeyHash || !toolId || !encryptedToken || !Number.isFinite(expiresAt)) return null;
  return { actorKeyHash, toolId, encryptedToken, expiresAt, storage: "encrypted_local" };
}

function safeStatus(toolId, status, expiresAt = 0, storage = "") {
  return {
    ok: status === "ready" || status === "cleared",
    toolId,
    status,
    available: status === "ready",
    storage,
    persisted: status === "ready" && storage === "encrypted_local",
    expiresAt: expiresAt ? new Date(expiresAt).toISOString() : "",
  };
}

function credentialKey(actorKeyHash, toolId) {
  return `${actorKeyHash}\u0000${toolId}`;
}

function hashActorKey(value) {
  const key = cleanKey(value);
  return key ? crypto.createHash("sha256").update(key).digest("hex") : "";
}

function cleanKey(value) {
  return String(value || "").trim().toLowerCase().slice(0, 160);
}

export {
  bearerTokenFromClipboard,
  createEncryptedCredentialFilePersistence,
  createTemporaryToolCredentialStore,
  isSecureCredentialTransport,
  tokenExpiry,
};
