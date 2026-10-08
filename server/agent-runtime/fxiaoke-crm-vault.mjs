import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const CONTRACT_VERSION = "fxiaoke-crm-credential-vault.v1";

function createFxiaokeCrmCredentialStore({
  keyMaterial = process.env.FXIAOKE_CRM_SECRET_KEY || "",
  keyPath = "",
  now = () => new Date().toISOString(),
  storePath = "",
} = {}) {
  if (!storePath) throw new TypeError("fxiaoke CRM credential store path is required");
  const effectiveKeyPath = keyPath || path.join(path.dirname(storePath), ".fxiaoke-crm-secret-key");

  function isConfigured() {
    return Boolean(readEncryptedRecord());
  }

  function getCredentials() {
    const record = readEncryptedRecord();
    if (!record) return null;
    try {
      const parsed = JSON.parse(decrypt(record.encrypted, resolveKey(false)));
      return normalizeCredentials(parsed);
    } catch {
      return null;
    }
  }

  function safeSummary() {
    const record = readEncryptedRecord();
    return {
      contractVersion: CONTRACT_VERSION,
      configured: Boolean(record),
      updatedAt: record?.updatedAt || "",
      updatedBy: record?.updatedBy || "",
    };
  }

  function upsertCredentials(input = {}, actor = {}) {
    const credentials = normalizeCredentials(input);
    if (!credentials) {
      return { ok: false, error: "fxiaoke_crm_credentials_invalid", message: "CRM 凭证字段不完整。" };
    }
    const state = {
      contractVersion: CONTRACT_VERSION,
      credential: {
        encrypted: encrypt(JSON.stringify(credentials), resolveKey(true)),
        updatedAt: now(),
        updatedBy: cleanText(actor.id || actor.employeeId || actor.name, 240) || "system-admin",
      },
    };
    fs.mkdirSync(path.dirname(storePath), { recursive: true, mode: 0o700 });
    fs.writeFileSync(storePath, `${JSON.stringify(state, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    fs.chmodSync(storePath, 0o600);
    return { ok: true, summary: safeSummary() };
  }

  function readEncryptedRecord() {
    try {
      if (!fs.existsSync(storePath)) return null;
      const state = JSON.parse(fs.readFileSync(storePath, "utf8"));
      if (state?.contractVersion !== CONTRACT_VERSION || !state?.credential?.encrypted?.data) return null;
      return state.credential;
    } catch {
      return null;
    }
  }

  function resolveKey(createIfMissing) {
    if (keyMaterial) return crypto.createHash("sha256").update(keyMaterial).digest();
    if (fs.existsSync(effectiveKeyPath)) {
      const material = fs.readFileSync(effectiveKeyPath, "utf8").trim();
      if (!material) throw new Error("fxiaoke CRM credential key is empty");
      return crypto.createHash("sha256").update(material).digest();
    }
    if (!createIfMissing) throw new Error("fxiaoke CRM credential key is unavailable");
    fs.mkdirSync(path.dirname(effectiveKeyPath), { recursive: true, mode: 0o700 });
    const material = crypto.randomBytes(32).toString("base64");
    fs.writeFileSync(effectiveKeyPath, `${material}\n`, { encoding: "utf8", mode: 0o600 });
    fs.chmodSync(effectiveKeyPath, 0o600);
    return crypto.createHash("sha256").update(material).digest();
  }

  return { getCredentials, isConfigured, safeSummary, upsertCredentials };
}

function encrypt(value, key) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const data = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  return {
    alg: "aes-256-gcm",
    iv: iv.toString("base64"),
    tag: cipher.getAuthTag().toString("base64"),
    data: data.toString("base64"),
  };
}

function decrypt(encrypted = {}, key) {
  if (encrypted.alg !== "aes-256-gcm" || !encrypted.iv || !encrypted.tag || !encrypted.data) {
    throw new Error("unsupported fxiaoke CRM credential cipher");
  }
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, Buffer.from(encrypted.iv, "base64"));
  decipher.setAuthTag(Buffer.from(encrypted.tag, "base64"));
  return Buffer.concat([
    decipher.update(Buffer.from(encrypted.data, "base64")),
    decipher.final(),
  ]).toString("utf8");
}

function normalizeCredentials(value = {}) {
  const credentials = {
    appId: cleanText(value.appId, 1_000),
    appSecret: cleanText(value.appSecret, 8 * 1024),
    permanentCode: cleanText(value.permanentCode, 8 * 1024),
    userId: cleanText(value.userId, 1_000),
    revision: cleanText(value.revision, 1_000),
  };
  return Object.values(credentials).every(Boolean) ? credentials : null;
}

function cleanText(value = "", maximum = 240) {
  return typeof value === "string" ? value.trim().slice(0, maximum) : "";
}

export { CONTRACT_VERSION, createFxiaokeCrmCredentialStore };
