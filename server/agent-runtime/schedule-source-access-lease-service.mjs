import crypto from "node:crypto";

const SERVICE_VERSION = "schedule-source-access-lease-service.v1";
const REQUEST_VERSION = "schedule-source-access-request.v1";
const GRANT_REQUEST_VERSION = "schedule-source-access-grant-request.v1";
const GRANT_VERSION = "schedule-source-access-grant.v1";
const CREDENTIAL_REQUEST_VERSION = "schedule-source-credential-lease-request.v1";
const CREDENTIAL_LEASE_VERSION = "schedule-source-credential-lease.v1";
const LEASE_VERSION = "schedule-source-access-lease.v1";
const REQUEST_FIELDS = new Set([
  "canonicalTaskId",
  "contractVersion",
  "employeeId",
  "resourceKind",
  "runId",
  "scheduleId",
  "selectionMode",
  "sourceAdapterId",
  "sourceBindingDigest",
  "sourceBindingId",
  "sourceBindingVersion",
  "sourceSystemId",
  "taskDefinitionId",
  "taskDefinitionVersion",
  "tenantScope",
]);
const GRANT_FIELDS = new Set([
  "accessGrantId",
  "accessGrantVersion",
  "authorityDigest",
  "contractVersion",
  "credentialBindingId",
  "credentialBindingVersion",
  "employeeId",
  "permissionDigest",
  "resourceKind",
  "scheduleId",
  "selectionMode",
  "sourceAdapterId",
  "sourceBindingDigest",
  "sourceBindingId",
  "sourceBindingVersion",
  "sourceSystemId",
  "status",
  "taskDefinitionId",
  "taskDefinitionVersion",
  "tenantScope",
  "validUntil",
]);
const CREDENTIAL_FIELDS = new Set([
  "accessToken",
  "contractVersion",
  "credentialAuthorityDigest",
  "credentialBindingId",
  "credentialBindingVersion",
  "sourceAdapterId",
  "sourceSystemId",
  "validUntil",
]);
const TOKEN = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,239}$/;
const DIGEST = /^[a-f0-9]{64}$/;

export function createScheduleSourceAccessLeaseService({
  issueCredentialLease,
  maxLeaseDurationMs = 5 * 60_000,
  now = () => new Date(),
  resolutionTimeoutMs = 5_000,
  resolveCurrentGrant,
  stableAccessHmacKey,
} = {}) {
  if (typeof resolveCurrentGrant !== "function") {
    throw new TypeError("Schedule source access lease service requires resolveCurrentGrant");
  }
  if (typeof issueCredentialLease !== "function") {
    throw new TypeError("Schedule source access lease service requires issueCredentialLease");
  }
  if (typeof now !== "function") {
    throw new TypeError("Schedule source access lease service requires now");
  }
  if (!Number.isSafeInteger(maxLeaseDurationMs) || maxLeaseDurationMs < 1_000 ||
    maxLeaseDurationMs > 60 * 60_000) {
    throw new TypeError("Schedule source access lease maxLeaseDurationMs is invalid");
  }
  if (!Number.isSafeInteger(resolutionTimeoutMs) || resolutionTimeoutMs < 100 ||
    resolutionTimeoutMs > 30_000) {
    throw new TypeError("Schedule source access lease resolutionTimeoutMs is invalid");
  }
  const accessKey = exactKey(stableAccessHmacKey);

  async function resolveAccessLease(value = {}, { signal = null } = {}) {
    const request = normalizeRequest(value);
    const parentSignal = normalizeSignal(signal);
    requireNotCanceled(parentSignal);
    const checkedAt = trustedNow(now);
    const operation = boundedSignal(parentSignal, resolutionTimeoutMs);
    try {
      const grant = await currentGrant({
        checkedAt,
        request,
        resolver: resolveCurrentGrant,
        signal: operation.signal,
      });
      const credential = await credentialLease({
        checkedAt,
        grant,
        issuer: issueCredentialLease,
        request,
        signal: operation.signal,
      });
      requireNotCanceled(operation.signal);
      const issuedAt = trustedNow(now);
      if (issuedAt.getTime() < checkedAt.getTime()) {
        throw leaseError("schedule_source_access_clock_invalid");
      }
      const validUntil = earliestTimestamp([
        grant.validUntil,
        credential.validUntil,
        new Date(issuedAt.getTime() + maxLeaseDurationMs).toISOString(),
      ]);
      if (Date.parse(validUntil) <= issuedAt.getTime()) {
        throw leaseError("schedule_source_access_lease_expired");
      }
      return deepFreeze({
        accessAuthorityDigest: keyedDigest(accessKey, {
          contractVersion: "schedule-source-access-authority.v1",
          tenantScope: request.tenantScope,
          employeeId: request.employeeId,
          scheduleId: request.scheduleId,
          taskDefinitionId: request.taskDefinitionId,
          taskDefinitionVersion: request.taskDefinitionVersion,
          sourceBindingId: request.sourceBindingId,
          sourceBindingVersion: request.sourceBindingVersion,
          sourceBindingDigest: request.sourceBindingDigest,
          sourceAdapterId: request.sourceAdapterId,
          sourceSystemId: request.sourceSystemId,
          resourceKind: request.resourceKind,
          selectionMode: request.selectionMode,
          accessGrantId: grant.accessGrantId,
          accessGrantVersion: grant.accessGrantVersion,
          authorityDigest: grant.authorityDigest,
          permissionDigest: grant.permissionDigest,
          credentialBindingId: grant.credentialBindingId,
          credentialBindingVersion: grant.credentialBindingVersion,
          credentialAuthorityDigest: credential.credentialAuthorityDigest,
        }),
        accessToken: credential.accessToken,
        canonicalTaskId: request.canonicalTaskId,
        contractVersion: LEASE_VERSION,
        employeeId: request.employeeId,
        resourceKind: request.resourceKind,
        runId: request.runId,
        scheduleId: request.scheduleId,
        selectionMode: request.selectionMode,
        sourceAdapterId: request.sourceAdapterId,
        sourceBindingDigest: request.sourceBindingDigest,
        sourceBindingId: request.sourceBindingId,
        sourceBindingVersion: request.sourceBindingVersion,
        sourceSystemId: request.sourceSystemId,
        taskDefinitionId: request.taskDefinitionId,
        taskDefinitionVersion: request.taskDefinitionVersion,
        tenantScope: request.tenantScope,
        validUntil,
      });
    } finally {
      operation.dispose();
    }
  }

  return Object.freeze({
    contractVersion: SERVICE_VERSION,
    resolveAccessLease,
  });
}

async function currentGrant({ checkedAt, request, resolver, signal }) {
  requireNotCanceled(signal);
  let value;
  try {
    value = await raceWithSignal(resolver(deepFreeze({
      ...request,
      contractVersion: GRANT_REQUEST_VERSION,
      evaluatedAt: checkedAt.toISOString(),
    }), { signal }), signal);
  } catch (error) {
    if (signal.aborted) throw signalError(signal);
    throw leaseError("schedule_source_access_grant_unavailable");
  }
  requireNotCanceled(signal);
  exactObject(value, GRANT_FIELDS, "schedule_source_access_grant_invalid");
  const grant = deepFreeze({
    accessGrantId: token(value.accessGrantId),
    accessGrantVersion: positiveInteger(value.accessGrantVersion),
    authorityDigest: digest(value.authorityDigest),
    contractVersion: value.contractVersion,
    credentialBindingId: token(value.credentialBindingId),
    credentialBindingVersion: positiveInteger(value.credentialBindingVersion),
    employeeId: token(value.employeeId),
    permissionDigest: digest(value.permissionDigest),
    resourceKind: token(value.resourceKind),
    scheduleId: token(value.scheduleId),
    selectionMode: token(value.selectionMode),
    sourceAdapterId: token(value.sourceAdapterId),
    sourceBindingDigest: digest(value.sourceBindingDigest),
    sourceBindingId: token(value.sourceBindingId),
    sourceBindingVersion: positiveInteger(value.sourceBindingVersion),
    sourceSystemId: token(value.sourceSystemId),
    status: value.status,
    taskDefinitionId: token(value.taskDefinitionId),
    taskDefinitionVersion: positiveInteger(value.taskDefinitionVersion),
    tenantScope: token(value.tenantScope),
    validUntil: timestamp(value.validUntil),
  });
  const matches = grant.contractVersion === GRANT_VERSION && grant.status === "active" &&
    grant.tenantScope === request.tenantScope && grant.employeeId === request.employeeId &&
    grant.scheduleId === request.scheduleId && grant.taskDefinitionId === request.taskDefinitionId &&
    grant.taskDefinitionVersion === request.taskDefinitionVersion &&
    grant.sourceBindingId === request.sourceBindingId &&
    grant.sourceBindingVersion === request.sourceBindingVersion &&
    grant.sourceAdapterId === request.sourceAdapterId &&
    grant.sourceSystemId === request.sourceSystemId && grant.resourceKind === request.resourceKind &&
    grant.selectionMode === request.selectionMode &&
    grant.sourceBindingDigest === request.sourceBindingDigest &&
    Date.parse(grant.validUntil) > checkedAt.getTime();
  if (!matches) throw leaseError("schedule_source_access_grant_invalid");
  return grant;
}

async function credentialLease({ checkedAt, grant, issuer, request, signal }) {
  requireNotCanceled(signal);
  let value;
  try {
    value = await raceWithSignal(issuer(deepFreeze({
      accessGrantAuthorityDigest: grant.authorityDigest,
      contractVersion: CREDENTIAL_REQUEST_VERSION,
      credentialBindingId: grant.credentialBindingId,
      credentialBindingVersion: grant.credentialBindingVersion,
      evaluatedAt: checkedAt.toISOString(),
      resourceKind: request.resourceKind,
      sourceAdapterId: request.sourceAdapterId,
      sourceSystemId: request.sourceSystemId,
      tenantScope: request.tenantScope,
    }), { signal }), signal);
  } catch (error) {
    if (signal.aborted) throw signalError(signal);
    throw leaseError("schedule_source_credential_lease_unavailable");
  }
  requireNotCanceled(signal);
  exactObject(value, CREDENTIAL_FIELDS, "schedule_source_credential_lease_invalid");
  const lease = deepFreeze({
    accessToken: secret(value.accessToken),
    contractVersion: value.contractVersion,
    credentialAuthorityDigest: digest(value.credentialAuthorityDigest),
    credentialBindingId: token(value.credentialBindingId),
    credentialBindingVersion: positiveInteger(value.credentialBindingVersion),
    sourceAdapterId: token(value.sourceAdapterId),
    sourceSystemId: token(value.sourceSystemId),
    validUntil: timestamp(value.validUntil),
  });
  const matches = lease.contractVersion === CREDENTIAL_LEASE_VERSION &&
    lease.credentialBindingId === grant.credentialBindingId &&
    lease.credentialBindingVersion === grant.credentialBindingVersion &&
    lease.sourceAdapterId === request.sourceAdapterId &&
    lease.sourceSystemId === request.sourceSystemId &&
    Date.parse(lease.validUntil) > checkedAt.getTime();
  if (!matches) throw leaseError("schedule_source_credential_lease_invalid");
  return lease;
}

function normalizeRequest(value) {
  exactObject(value, REQUEST_FIELDS, "schedule_source_access_request_invalid");
  if (value.contractVersion !== REQUEST_VERSION) {
    throw leaseError("schedule_source_access_request_invalid");
  }
  return deepFreeze({
    canonicalTaskId: token(value.canonicalTaskId),
    contractVersion: REQUEST_VERSION,
    employeeId: token(value.employeeId),
    resourceKind: token(value.resourceKind),
    runId: token(value.runId),
    scheduleId: token(value.scheduleId),
    selectionMode: token(value.selectionMode),
    sourceAdapterId: token(value.sourceAdapterId),
    sourceBindingDigest: digest(value.sourceBindingDigest),
    sourceBindingId: token(value.sourceBindingId),
    sourceBindingVersion: positiveInteger(value.sourceBindingVersion),
    sourceSystemId: token(value.sourceSystemId),
    taskDefinitionId: token(value.taskDefinitionId),
    taskDefinitionVersion: positiveInteger(value.taskDefinitionVersion),
    tenantScope: token(value.tenantScope),
  });
}

function boundedSignal(parent, timeoutMs) {
  const controller = new AbortController();
  const abortFromParent = () => controller.abort(leaseError("schedule_source_access_lease_canceled"));
  if (parent) parent.addEventListener("abort", abortFromParent, { once: true });
  if (parent?.aborted) abortFromParent();
  const timer = setTimeout(() => controller.abort(leaseError("schedule_source_access_lease_timeout")), timeoutMs);
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
    throw new TypeError("Schedule source access lease signal must be an AbortSignal");
  }
  return value;
}

function requireNotCanceled(signal) {
  if (signal?.aborted) throw signalError(signal);
}

function signalError(signal) {
  if (signal?.reason?.code === "schedule_source_access_lease_timeout") return signal.reason;
  return leaseError("schedule_source_access_lease_canceled");
}

function earliestTimestamp(values) {
  return new Date(Math.min(...values.map((value) => Date.parse(timestamp(value))))).toISOString();
}

function exactObject(value, fields, code) {
  if (!plainObject(value)) throw leaseError(code);
  const keys = Object.keys(value);
  if (keys.length !== fields.size || keys.some((key) => !fields.has(key))) throw leaseError(code);
}

function plainObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function token(value) {
  const result = String(value || "").trim();
  if (!TOKEN.test(result) || /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(result)) {
    throw leaseError("schedule_source_access_reference_invalid");
  }
  return result;
}

function digest(value) {
  const result = String(value || "").trim().toLowerCase();
  if (!DIGEST.test(result)) throw leaseError("schedule_source_access_digest_invalid");
  return result;
}

function secret(value) {
  const result = String(value || "").trim();
  if (result.length < 16 || result.length > 4096 || /\s/.test(result)) {
    throw leaseError("schedule_source_credential_lease_invalid");
  }
  return result;
}

function positiveInteger(value) {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw leaseError("schedule_source_access_number_invalid");
  }
  return value;
}

function timestamp(value) {
  const result = value instanceof Date ? value.toISOString() : String(value || "").trim();
  const parsed = new Date(result);
  if (!result || !Number.isFinite(parsed.getTime()) || parsed.toISOString() !== result) {
    throw leaseError("schedule_source_access_timestamp_invalid");
  }
  return result;
}

function trustedNow(now) {
  let value;
  try { value = now(); }
  catch { throw leaseError("schedule_source_access_clock_invalid"); }
  const result = value instanceof Date ? new Date(value.getTime()) : new Date(value);
  if (!Number.isFinite(result.getTime())) throw leaseError("schedule_source_access_clock_invalid");
  return result;
}

function exactKey(value) {
  const key = Buffer.isBuffer(value) ? Buffer.from(value) : Buffer.from(value || []);
  if (key.length !== 32) throw new TypeError("Schedule source access HMAC key must be 32 bytes");
  return key;
}

function keyedDigest(key, value) {
  return crypto.createHmac("sha256", key).update(canonicalJson(value)).digest("hex");
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) =>
      `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  const result = JSON.stringify(Object.is(value, -0) ? 0 : value);
  if (result === undefined) throw leaseError("schedule_source_access_value_invalid");
  return result;
}

function deepFreeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    Object.values(value).forEach(deepFreeze);
  }
  return value;
}

function leaseError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

export {
  CREDENTIAL_LEASE_VERSION as SCHEDULE_SOURCE_CREDENTIAL_LEASE_CONTRACT_VERSION,
  CREDENTIAL_REQUEST_VERSION as SCHEDULE_SOURCE_CREDENTIAL_LEASE_REQUEST_CONTRACT_VERSION,
  GRANT_REQUEST_VERSION as SCHEDULE_SOURCE_ACCESS_GRANT_REQUEST_CONTRACT_VERSION,
  GRANT_VERSION as SCHEDULE_SOURCE_ACCESS_GRANT_CONTRACT_VERSION,
  LEASE_VERSION as SCHEDULE_SOURCE_ACCESS_LEASE_CONTRACT_VERSION,
  REQUEST_VERSION as SCHEDULE_SOURCE_ACCESS_REQUEST_CONTRACT_VERSION,
  SERVICE_VERSION as SCHEDULE_SOURCE_ACCESS_LEASE_SERVICE_CONTRACT_VERSION,
};
