const ISSUER_VERSION = "feishu-approval-source-credential-lease-issuer.v1";
const REQUEST_VERSION = "schedule-source-credential-lease-request.v1";
const BINDING_VERSION = "feishu-approval-source-credential-binding.v1";
const LEASE_VERSION = "schedule-source-credential-lease.v1";
const SOURCE_ADAPTER_ID = "feishu-approval-readonly-snapshot";
const TOKEN_URL = "https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal";
const REQUEST_FIELDS = new Set([
  "accessGrantAuthorityDigest", "contractVersion", "credentialBindingId",
  "credentialBindingVersion", "evaluatedAt", "resourceKind", "sourceAdapterId",
  "sourceSystemId", "tenantScope",
]);
const BINDING_FIELDS = new Set([
  "accessGrantAuthorityDigest", "appId", "appSecret", "contractVersion",
  "credentialAuthorityDigest", "credentialBindingId", "credentialBindingVersion",
  "resourceKind", "sourceAdapterId", "sourceSystemId", "status", "tenantScope",
  "validUntil",
]);
const TOKEN = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,239}$/;
const DIGEST = /^[a-f0-9]{64}$/;

export function createFeishuApprovalSourceCredentialLeaseIssuer({
  fetch = globalThis.fetch,
  now = () => new Date(),
  requestTimeoutMs = 8_000,
  resolveDedicatedCredentialBinding,
} = {}) {
  if (typeof fetch !== "function") {
    throw new TypeError("Feishu approval source Credential issuer requires fetch");
  }
  if (typeof now !== "function") {
    throw new TypeError("Feishu approval source Credential issuer requires now");
  }
  if (typeof resolveDedicatedCredentialBinding !== "function") {
    throw new TypeError(
      "Feishu approval source Credential issuer requires resolveDedicatedCredentialBinding",
    );
  }
  if (!Number.isSafeInteger(requestTimeoutMs) || requestTimeoutMs < 100 ||
    requestTimeoutMs > 30_000) {
    throw new TypeError("Feishu approval source Credential issuer timeout is invalid");
  }

  async function issueCredentialLease(value = {}, { signal = null } = {}) {
    const request = normalizeRequest(value);
    const parentSignal = normalizeSignal(signal);
    requireNotCanceled(parentSignal);
    const checkedAt = trustedNow(now);
    if (Date.parse(request.evaluatedAt) > checkedAt.getTime()) {
      throw issuerError("schedule_feishu_source_credential_request_invalid");
    }
    const operation = boundedSignal(parentSignal, requestTimeoutMs);
    try {
      const binding = await resolveBinding({
        checkedAt,
        request,
        resolver: resolveDedicatedCredentialBinding,
        signal: operation.signal,
      });
      const tokenResult = await requestTenantToken({
        binding,
        fetch,
        signal: operation.signal,
      });
      requireNotCanceled(operation.signal);
      const issuedAt = trustedNow(now);
      if (issuedAt.getTime() < checkedAt.getTime()) {
        throw issuerError("schedule_feishu_source_credential_clock_invalid");
      }
      const tokenValidUntil = new Date(
        issuedAt.getTime() + tokenResult.expireSeconds * 1_000,
      ).toISOString();
      const validUntil = new Date(Math.min(
        Date.parse(binding.validUntil),
        Date.parse(tokenValidUntil),
      )).toISOString();
      if (Date.parse(validUntil) <= issuedAt.getTime()) {
        throw issuerError("schedule_feishu_source_credential_expired");
      }
      return deepFreeze({
        accessToken: tokenResult.accessToken,
        contractVersion: LEASE_VERSION,
        credentialAuthorityDigest: binding.credentialAuthorityDigest,
        credentialBindingId: binding.credentialBindingId,
        credentialBindingVersion: binding.credentialBindingVersion,
        sourceAdapterId: SOURCE_ADAPTER_ID,
        sourceSystemId: "feishu",
        validUntil,
      });
    } finally {
      operation.dispose();
    }
  }

  return Object.freeze({
    contractVersion: ISSUER_VERSION,
    issueCredentialLease,
  });
}

async function resolveBinding({ checkedAt, request, resolver, signal }) {
  let value;
  try {
    value = await raceWithSignal(resolver(request, { signal }), signal);
  } catch {
    if (signal.aborted) throw signalError(signal);
    throw issuerError("schedule_feishu_source_credential_binding_unavailable");
  }
  requireNotCanceled(signal);
  exactObject(value, BINDING_FIELDS, "schedule_feishu_source_credential_binding_invalid");
  const binding = deepFreeze({
    accessGrantAuthorityDigest: digest(value.accessGrantAuthorityDigest),
    appId: appId(value.appId),
    appSecret: secret(value.appSecret),
    contractVersion: value.contractVersion,
    credentialAuthorityDigest: digest(value.credentialAuthorityDigest),
    credentialBindingId: token(value.credentialBindingId),
    credentialBindingVersion: positiveInteger(value.credentialBindingVersion),
    resourceKind: token(value.resourceKind),
    sourceAdapterId: token(value.sourceAdapterId),
    sourceSystemId: token(value.sourceSystemId),
    status: value.status,
    tenantScope: token(value.tenantScope),
    validUntil: timestamp(value.validUntil),
  });
  const matches = binding.contractVersion === BINDING_VERSION && binding.status === "active" &&
    binding.accessGrantAuthorityDigest === request.accessGrantAuthorityDigest &&
    binding.credentialBindingId === request.credentialBindingId &&
    binding.credentialBindingVersion === request.credentialBindingVersion &&
    binding.resourceKind === "approval_instances" &&
    binding.resourceKind === request.resourceKind &&
    binding.sourceAdapterId === SOURCE_ADAPTER_ID &&
    binding.sourceAdapterId === request.sourceAdapterId &&
    binding.sourceSystemId === "feishu" && binding.sourceSystemId === request.sourceSystemId &&
    binding.tenantScope === request.tenantScope &&
    Date.parse(binding.validUntil) > checkedAt.getTime();
  if (!matches) throw issuerError("schedule_feishu_source_credential_binding_invalid");
  return binding;
}

async function requestTenantToken({ binding, fetch, signal }) {
  let response;
  try {
    response = await raceWithSignal(fetch(TOKEN_URL, {
      body: JSON.stringify({ app_id: binding.appId, app_secret: binding.appSecret }),
      headers: { "Content-Type": "application/json; charset=utf-8" },
      method: "POST",
      signal,
    }), signal);
  } catch {
    if (signal.aborted) throw signalError(signal);
    throw issuerError("schedule_feishu_source_credential_token_unavailable");
  }
  let payload;
  try { payload = await raceWithSignal(response?.json?.(), signal); }
  catch {
    if (signal.aborted) throw signalError(signal);
    throw issuerError("schedule_feishu_source_credential_token_invalid");
  }
  if (!response?.ok || !plainObject(payload) || Number(payload.code) !== 0) {
    throw issuerError("schedule_feishu_source_credential_token_unavailable");
  }
  const accessToken = secret(payload.tenant_access_token);
  const expireSeconds = positiveInteger(Number(payload.expire));
  if (expireSeconds > 7_200) {
    throw issuerError("schedule_feishu_source_credential_token_invalid");
  }
  return { accessToken, expireSeconds };
}

function normalizeRequest(value) {
  exactObject(value, REQUEST_FIELDS, "schedule_feishu_source_credential_request_invalid");
  if (value.contractVersion !== REQUEST_VERSION) {
    throw issuerError("schedule_feishu_source_credential_request_invalid");
  }
  const request = deepFreeze({
    accessGrantAuthorityDigest: digest(value.accessGrantAuthorityDigest),
    contractVersion: REQUEST_VERSION,
    credentialBindingId: token(value.credentialBindingId),
    credentialBindingVersion: positiveInteger(value.credentialBindingVersion),
    evaluatedAt: timestamp(value.evaluatedAt),
    resourceKind: token(value.resourceKind),
    sourceAdapterId: token(value.sourceAdapterId),
    sourceSystemId: token(value.sourceSystemId),
    tenantScope: token(value.tenantScope),
  });
  if (request.resourceKind !== "approval_instances" ||
    request.sourceAdapterId !== SOURCE_ADAPTER_ID || request.sourceSystemId !== "feishu") {
    throw issuerError("schedule_feishu_source_credential_request_invalid");
  }
  return request;
}

function boundedSignal(parent, timeoutMs) {
  const controller = new AbortController();
  const abortFromParent = () => controller.abort(
    issuerError("schedule_feishu_source_credential_canceled"),
  );
  if (parent) parent.addEventListener("abort", abortFromParent, { once: true });
  if (parent?.aborted) abortFromParent();
  const timer = setTimeout(() => controller.abort(
    issuerError("schedule_feishu_source_credential_timeout"),
  ), timeoutMs);
  return {
    signal: controller.signal,
    dispose() {
      clearTimeout(timer);
      parent?.removeEventListener?.("abort", abortFromParent);
    },
  };
}

function raceWithSignal(value, signal) {
  if (signal.aborted) return Promise.reject(signalError(signal));
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(signalError(signal));
    signal.addEventListener("abort", onAbort, { once: true });
    Promise.resolve(value).then(resolve, reject).finally(() => {
      signal.removeEventListener("abort", onAbort);
    });
  });
}

function normalizeSignal(value) {
  if (value === null || value === undefined) return null;
  if (typeof value !== "object" || typeof value.aborted !== "boolean" ||
    typeof value.addEventListener !== "function") {
    throw new TypeError("Feishu approval source Credential signal must be an AbortSignal");
  }
  return value;
}

function requireNotCanceled(signal) {
  if (signal?.aborted) throw signalError(signal);
}

function signalError(signal) {
  if (signal?.reason?.code === "schedule_feishu_source_credential_timeout") return signal.reason;
  return issuerError("schedule_feishu_source_credential_canceled");
}

function exactObject(value, fields, code) {
  if (!plainObject(value)) throw issuerError(code);
  const keys = Object.keys(value);
  if (keys.length !== fields.size || keys.some((key) => !fields.has(key))) {
    throw issuerError(code);
  }
}

function plainObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function token(value) {
  const result = String(value || "").trim();
  if (!TOKEN.test(result) || /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(result)) {
    throw issuerError("schedule_feishu_source_credential_reference_invalid");
  }
  return result;
}

function appId(value) {
  const result = String(value || "").trim();
  if (!/^cli_[A-Za-z0-9]{8,120}$/.test(result)) {
    throw issuerError("schedule_feishu_source_credential_binding_invalid");
  }
  return result;
}

function secret(value) {
  const result = String(value || "").trim();
  if (result.length < 16 || result.length > 4_096 || /\s/.test(result)) {
    throw issuerError("schedule_feishu_source_credential_secret_invalid");
  }
  return result;
}

function digest(value) {
  const result = String(value || "").trim().toLowerCase();
  if (!DIGEST.test(result)) throw issuerError("schedule_feishu_source_credential_digest_invalid");
  return result;
}

function positiveInteger(value) {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw issuerError("schedule_feishu_source_credential_number_invalid");
  }
  return value;
}

function timestamp(value) {
  const result = value instanceof Date ? value.toISOString() : String(value || "").trim();
  const parsed = new Date(result);
  if (!result || !Number.isFinite(parsed.getTime()) || parsed.toISOString() !== result) {
    throw issuerError("schedule_feishu_source_credential_timestamp_invalid");
  }
  return result;
}

function trustedNow(now) {
  let value;
  try { value = now(); }
  catch { throw issuerError("schedule_feishu_source_credential_clock_invalid"); }
  const result = value instanceof Date ? new Date(value.getTime()) : new Date(value);
  if (!Number.isFinite(result.getTime())) {
    throw issuerError("schedule_feishu_source_credential_clock_invalid");
  }
  return result;
}

function deepFreeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    Object.values(value).forEach(deepFreeze);
  }
  return value;
}

function issuerError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

export {
  BINDING_VERSION as FEISHU_APPROVAL_SOURCE_CREDENTIAL_BINDING_CONTRACT_VERSION,
  ISSUER_VERSION as FEISHU_APPROVAL_SOURCE_CREDENTIAL_LEASE_ISSUER_CONTRACT_VERSION,
};
