import crypto from "node:crypto";
import { GRANT_CONTRACT_VERSION, ISSUED_CREDENTIAL_CONTRACT_VERSION } from "./current-user-tool-lease-service.mjs";

const HR_DELEGATED_JWT_ISSUER_ADAPTER_ID = "hr-center-delegated-jwt.v1";
const HR_TRAINING_DELEGATED_JWT_ISSUER_ADAPTER_ID = "hr-training-center-delegated-jwt.v1";

function createHrCurrentUserJwtIssuer({
  adapterId = HR_DELEGATED_JWT_ISSUER_ADAPTER_ID,
  audience = "hr-talentos",
  authorizedParty = "digital-workforce-center",
  issuer,
  keyId,
  maxTokenTtlMs = 5 * 60_000,
  now = () => new Date(),
  overlapPublicJwks = [],
  privateKey,
} = {}) {
  const safeIssuer = requiredClaim(issuer);
  const safeAdapterId = requiredClaim(adapterId);
  const safeAudience = requiredClaim(audience);
  const safeAuthorizedParty = requiredClaim(authorizedParty);
  const safeKeyId = requiredClaim(keyId);
  if (typeof now !== "function" || !Number.isSafeInteger(maxTokenTtlMs) || maxTokenTtlMs < 30_000 || maxTokenTtlMs > 15 * 60_000) {
    throw new TypeError("hr_delegated_jwt_issuer_invalid");
  }
  const signingKey = rsaPrivateKey(privateKey);
  const publicKeys = publicJwks(signingKey, safeKeyId, overlapPublicJwks);

  async function issueCredentialLease(grant = {}, { signal = null } = {}) {
    if (signal?.aborted) throw issuerError("current_user_tool_credential_lease_canceled");
    if (grant.contractVersion !== GRANT_CONTRACT_VERSION || grant.issuerAdapterId !== safeAdapterId ||
      grant.audience !== safeAudience || !Array.isArray(grant.scopes) || !grant.scopes.length) {
      throw issuerError("hr_delegated_jwt_grant_invalid");
    }
    const issuedAtDate = trustedNow(now);
    const expiresAt = new Date(Math.min(
      Date.parse(grant.validUntil),
      issuedAtDate.getTime() + maxTokenTtlMs,
    ));
    if (!Number.isFinite(expiresAt.getTime()) || expiresAt.getTime() <= issuedAtDate.getTime()) {
      throw issuerError("hr_delegated_jwt_grant_expired");
    }
    const header = { alg: "RS256", kid: safeKeyId, typ: "at+jwt" };
    const payload = {
      iss: safeIssuer,
      aud: safeAudience,
      azp: safeAuthorizedParty,
      sub: String(grant.subjectId),
      iat: Math.floor(issuedAtDate.getTime() / 1_000),
      nbf: Math.floor(issuedAtDate.getTime() / 1_000),
      exp: Math.floor(expiresAt.getTime() / 1_000),
      jti: crypto.randomUUID(),
      scope: grant.scopes.join(" "),
      authorization_version: String(grant.permissionVersion),
      token_use: "delegated_access",
      subject_id_type: String(grant.subjectIdType),
      ...(grant.subjectDisplayName ? { name: String(grant.subjectDisplayName) } : {}),
      ...(Array.isArray(grant.departmentRefs) && grant.departmentRefs.length
        ? { department_refs: [...grant.departmentRefs] }
        : {}),
      ...(grant.subjectIdType === "verified_email_alias" ? { email: String(grant.subjectId) } : {}),
    };
    const signingInput = `${base64UrlJson(header)}.${base64UrlJson(payload)}`;
    const signature = crypto.sign("RSA-SHA256", Buffer.from(signingInput), signingKey).toString("base64url");
    if (signal?.aborted) throw issuerError("current_user_tool_credential_lease_canceled");
    return Object.freeze({
      contractVersion: ISSUED_CREDENTIAL_CONTRACT_VERSION,
      issuerAdapterId: safeAdapterId,
      audience: safeAudience,
      subjectId: grant.subjectId,
      scopes: [...grant.scopes],
      accessToken: `${signingInput}.${signature}`,
      issuedAt: issuedAtDate.toISOString(),
      expiresAt: expiresAt.toISOString(),
    });
  }

  return Object.freeze({
    adapterId: safeAdapterId,
    issueCredentialLease,
    publicJwks: () => structuredClone(publicKeys),
  });
}

function hrTrainingCurrentUserJwtIssuerFromEnvironment(environment = process.env) {
  const issuer = String(environment.HR_TRAINING_DELEGATED_JWT_ISSUER || "").trim();
  const audience = String(environment.HR_TRAINING_DELEGATED_JWT_AUDIENCE || "hr-training-assessment").trim();
  const authorizedParty = String(environment.HR_TRAINING_DELEGATED_JWT_AUTHORIZED_PARTY || "digital-workforce-center").trim();
  const keyId = String(environment.HR_TRAINING_DELEGATED_JWT_KEY_ID || "").trim();
  const privateKey = String(environment.HR_TRAINING_DELEGATED_JWT_PRIVATE_KEY || "").replace(/\\n/g, "\n").trim();
  const overlapPublicJwks = parseOverlapPublicJwks(environment.HR_TRAINING_DELEGATED_JWT_OVERLAP_JWKS_JSON);
  if (!issuer || !keyId || !privateKey) return null;
  return createHrCurrentUserJwtIssuer({
    adapterId: HR_TRAINING_DELEGATED_JWT_ISSUER_ADAPTER_ID,
    audience,
    authorizedParty,
    issuer,
    keyId,
    overlapPublicJwks,
    privateKey,
  });
}

function hrCurrentUserJwtIssuerFromEnvironment(environment = process.env) {
  const issuer = String(environment.HR_TALENTOS_DELEGATED_JWT_ISSUER || "").trim();
  const audience = String(environment.HR_TALENTOS_DELEGATED_JWT_AUDIENCE || "hr-talentos").trim();
  const authorizedParty = String(environment.HR_TALENTOS_DELEGATED_JWT_AUTHORIZED_PARTY || "digital-workforce-center").trim();
  const keyId = String(environment.HR_TALENTOS_DELEGATED_JWT_KEY_ID || "").trim();
  const privateKey = String(environment.HR_TALENTOS_DELEGATED_JWT_PRIVATE_KEY || "").replace(/\\n/g, "\n").trim();
  const overlapPublicJwks = parseOverlapPublicJwks(environment.HR_TALENTOS_DELEGATED_JWT_OVERLAP_JWKS_JSON);
  if (!issuer || !keyId || !privateKey) return null;
  return createHrCurrentUserJwtIssuer({ audience, authorizedParty, issuer, keyId, overlapPublicJwks, privateKey });
}

function publicJwks(signingKey, keyId, overlapPublicJwks = []) {
  const publicJwk = crypto.createPublicKey(signingKey).export({ format: "jwk" });
  const current = {
      kty: publicJwk.kty,
      n: publicJwk.n,
      e: publicJwk.e,
      alg: "RS256",
      kid: keyId,
      use: "sig",
  };
  const overlap = (Array.isArray(overlapPublicJwks) ? overlapPublicJwks : []).map(normalizePublicJwk);
  const kids = [current, ...overlap].map((key) => key.kid);
  if (new Set(kids).size !== kids.length || overlap.length > 2) throw new TypeError("hr_delegated_jwt_overlap_jwks_invalid");
  return Object.freeze({ keys: Object.freeze([Object.freeze(current), ...overlap.map(Object.freeze)]) });
}

function parseOverlapPublicJwks(value) {
  const text = String(value || "").trim();
  if (!text) return [];
  try {
    const parsed = JSON.parse(text);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed) || Object.keys(parsed).some((key) => key !== "keys") || !Array.isArray(parsed.keys)) {
      throw new Error("invalid");
    }
    return parsed.keys;
  } catch {
    throw new TypeError("hr_delegated_jwt_overlap_jwks_invalid");
  }
}

function normalizePublicJwk(value) {
  const allowed = new Set(["alg", "e", "kid", "kty", "n", "use"]);
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).some((key) => !allowed.has(key)) ||
    value.kty !== "RSA" || value.alg !== "RS256" || value.use !== "sig" ||
    !/^[A-Za-z0-9_-]{1,240}$/.test(String(value.kid || "")) ||
    !/^[A-Za-z0-9_-]{32,2048}$/.test(String(value.n || "")) || !/^[A-Za-z0-9_-]{1,16}$/.test(String(value.e || ""))) {
    throw new TypeError("hr_delegated_jwt_overlap_jwks_invalid");
  }
  return { alg: "RS256", e: value.e, kid: value.kid, kty: "RSA", n: value.n, use: "sig" };
}

function rsaPrivateKey(value) {
  try {
    const key = value?.type === "private" ? value : crypto.createPrivateKey(value || "");
    if (key.type !== "private" || key.asymmetricKeyType !== "rsa") throw new Error("not rsa");
    return key;
  } catch {
    throw new TypeError("hr_delegated_jwt_private_key_invalid");
  }
}

function base64UrlJson(value) {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

function requiredClaim(value) {
  const text = String(value || "").trim();
  if (!text || text.length > 240 || /[\r\n\0]/.test(text)) throw new TypeError("hr_delegated_jwt_issuer_invalid");
  return text;
}

function trustedNow(now) {
  const value = now();
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) throw new TypeError("hr_delegated_jwt_clock_invalid");
  return date;
}

function issuerError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

export {
  HR_DELEGATED_JWT_ISSUER_ADAPTER_ID,
  HR_TRAINING_DELEGATED_JWT_ISSUER_ADAPTER_ID,
  createHrCurrentUserJwtIssuer,
  hrCurrentUserJwtIssuerFromEnvironment,
  hrTrainingCurrentUserJwtIssuerFromEnvironment,
};
