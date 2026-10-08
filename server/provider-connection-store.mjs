import fs from "node:fs";
import path from "node:path";

export function createProviderCredentialSecretStore({ storePath, redactError = String } = {}) {
  const filePath = storePath || path.join(process.cwd(), "data", "local", "provider-key-secrets.json");

  function readState() {
    try {
      if (!fs.existsSync(filePath)) return { credentials: {} };
      const parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
      if (!parsed || typeof parsed !== "object") return { credentials: {} };
      if (parsed.credentials && typeof parsed.credentials === "object") return { credentials: parsed.credentials };
      if (parsed.keys && typeof parsed.keys === "object") return { credentials: parsed.keys };
      return { credentials: {} };
    } catch (error) {
      console.warn("[provider-credential-store] failed to read store:", redactError(error));
      return { credentials: {} };
    }
  }

  function writeState(state) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, `${JSON.stringify({ credentials: state.credentials || {} }, null, 2)}\n`);
  }

  function getSecret(credentialId) {
    const record = readState().credentials[credentialId];
    const authSecret = record?.secretValue || record?.apiKey || "";
    if (!authSecret) return null;
    return {
      credentialId,
      authSecret,
      legacyBaseUrl: record?.baseUrl || "",
      updatedAt: record?.updatedAt,
      updatedBy: record?.updatedBy,
    };
  }

  function listSecretSummaries() {
    const state = readState();
    return Object.fromEntries(
      Object.entries(state.credentials).map(([id, record]) => {
        const authSecret = record?.secretValue || record?.apiKey || "";
        return [
          id,
          {
            credentialId: id,
            hasSecret: Boolean(authSecret),
            maskedSecret: maskSecret(authSecret),
            updatedAt: record?.updatedAt || "",
            updatedBy: record?.updatedBy || "",
          },
        ];
      }),
    );
  }

  function upsertSecret(credentialId, input = {}, actor = {}) {
    const secretValue = String(input.secretValue || "").trim();
    if (!credentialId) {
      return { ok: false, error: "provider_credential_id_required", message: "缺少 Provider Credential id。" };
    }
    if (!secretValue || secretValue.length < 12) {
      return { ok: false, error: "provider_credential_secret_required", message: "请输入有效的服务端凭证。" };
    }

    const state = readState();
    const existing = state.credentials[credentialId] || {};
    state.credentials[credentialId] = {
      secretValue,
      ...(existing.baseUrl ? { baseUrl: existing.baseUrl } : {}),
      updatedAt: new Date().toISOString(),
      updatedBy: actor.employeeId || actor.email || actor.name || "system-admin",
    };
    writeState(state);
    return { ok: true, secret: listSecretSummaries()[credentialId] };
  }

  return {
    filePath,
    getSecret,
    listSecretSummaries,
    upsertSecret,
  };
}

function maskSecret(value) {
  const text = String(value || "").trim();
  if (!text) return "";
  if (text.length <= 8) return "****";
  return `${text.slice(0, 3)}-...${text.slice(-4)}`;
}
