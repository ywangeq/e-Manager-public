import crypto from "node:crypto";

const SESSION_ROUTE_CONTRACT = "session-route.v1";
const SESSION_ROUTE_AUTHORITY_CONTRACT = "session-route-authority.v1";
// Protocol bound for canonicalization and abuse resistance, not a business access policy.
const SESSION_ROUTE_ID_MAX_LENGTH = 512;
const SESSION_ROUTE_DIGEST_KEY_MIN_BYTES = 32;

function createSessionRouteAuthority({ routeDigestKey } = {}) {
  const digestKey = normalizedDigestKey(routeDigestKey);
  return Object.freeze({
    contractVersion: SESSION_ROUTE_AUTHORITY_CONTRACT,
    create: (input) => createSessionRouteWithKey(input, digestKey),
    verify: (route) => verifySessionRouteIntegrity(route, digestKey),
  });
}

function createSessionRoute({
  accountId,
  actorIssuer,
  actorSubjectId,
  centerInstanceId,
  channelId,
  conversationId,
  conversationType,
  employeeId,
  routeDigestKey,
  tenantScope,
  threadId = "",
} = {}) {
  return createSessionRouteWithKey({
    accountId,
    actorIssuer,
    actorSubjectId,
    centerInstanceId,
    channelId,
    conversationId,
    conversationType,
    employeeId,
    tenantScope,
    threadId,
  }, normalizedDigestKey(routeDigestKey));
}

function createSessionRouteWithKey({
  accountId,
  actorIssuer,
  actorSubjectId,
  centerInstanceId,
  channelId,
  conversationId,
  conversationType,
  employeeId,
  tenantScope,
  threadId = "",
} = {}, digestKey) {
  const dimensions = {
    centerInstanceId: stableId(centerInstanceId, "centerInstanceId"),
    tenantScope: stableId(tenantScope, "tenantScope"),
    actorIssuer: stableId(actorIssuer, "actorIssuer"),
    actorSubjectId: stableId(actorSubjectId, "actorSubjectId"),
    employeeId: stableId(employeeId, "employeeId"),
    channelId: stableId(channelId, "channelId"),
    accountId: stableId(accountId, "accountId"),
    conversationType: stableId(conversationType, "conversationType"),
    conversationId: stableId(conversationId, "conversationId"),
    threadId: optionalStableId(threadId, "threadId"),
  };
  const routeDigest = hmacDigest(digestKey, "route", canonicalRouteInput(dimensions));
  const route = {
    contractVersion: SESSION_ROUTE_CONTRACT,
    routeDigest,
    routeRef: `session-route://${routeDigest}`,
    centerInstanceId: dimensions.centerInstanceId,
    tenantScope: dimensions.tenantScope,
    actorIssuer: dimensions.actorIssuer,
    actorSubjectDigest: hmacDigest(digestKey, "actor", JSON.stringify([dimensions.actorIssuer, dimensions.actorSubjectId])),
    employeeId: dimensions.employeeId,
    channelId: dimensions.channelId,
    accountId: dimensions.accountId,
    conversationType: dimensions.conversationType,
    conversationDigest: hmacDigest(digestKey, "conversation", dimensions.conversationId),
    threadDigest: dimensions.threadId ? hmacDigest(digestKey, "thread", dimensions.threadId) : "",
  };
  return {
    ...route,
    integrityMac: hmacDigest(digestKey, "integrity", canonicalRouteIntegrityInput(route)),
  };
}

function canonicalRouteInput(dimensions) {
  return JSON.stringify([
    SESSION_ROUTE_CONTRACT,
    dimensions.centerInstanceId,
    dimensions.tenantScope,
    dimensions.actorIssuer,
    dimensions.actorSubjectId,
    dimensions.employeeId,
    dimensions.channelId,
    dimensions.accountId,
    dimensions.conversationType,
    dimensions.conversationId,
    dimensions.threadId,
  ]);
}

function normalizedDigestKey(value) {
  if (!Buffer.isBuffer(value)) throw new TypeError("session route routeDigestKey must be a server-managed Buffer");
  if (value.length < SESSION_ROUTE_DIGEST_KEY_MIN_BYTES) {
    throw new TypeError(`session route routeDigestKey must be at least ${SESSION_ROUTE_DIGEST_KEY_MIN_BYTES} bytes`);
  }
  return Buffer.from(value);
}

function hmacDigest(key, domain, value) {
  return crypto.createHmac("sha256", key).update(`${SESSION_ROUTE_CONTRACT}\0${domain}\0${value}`).digest("hex");
}

function verifySessionRouteIntegrity(route, key) {
  try {
    if (route?.contractVersion !== SESSION_ROUTE_CONTRACT || !hexDigest(route.routeDigest) ||
      route.routeRef !== `session-route://${route.routeDigest}` || !hexDigest(route.integrityMac)) return false;
    for (const field of ["centerInstanceId", "tenantScope", "actorIssuer", "employeeId", "channelId", "accountId", "conversationType"]) {
      stableId(route[field], field);
    }
    for (const field of ["actorSubjectDigest", "conversationDigest"]) {
      if (!hexDigest(route[field])) return false;
    }
    if (route.threadDigest && !hexDigest(route.threadDigest)) return false;
    const expected = hmacDigest(key, "integrity", canonicalRouteIntegrityInput(route));
    return crypto.timingSafeEqual(Buffer.from(route.integrityMac, "hex"), Buffer.from(expected, "hex"));
  } catch {
    return false;
  }
}

function canonicalRouteIntegrityInput(route) {
  return JSON.stringify([
    SESSION_ROUTE_CONTRACT,
    route.routeDigest,
    route.routeRef,
    route.centerInstanceId,
    route.tenantScope,
    route.actorIssuer,
    route.actorSubjectDigest,
    route.employeeId,
    route.channelId,
    route.accountId,
    route.conversationType,
    route.conversationDigest,
    route.threadDigest,
  ]);
}

function hexDigest(value) {
  return /^[a-f0-9]{64}$/.test(String(value || ""));
}

function stableId(value, field) {
  const normalized = optionalStableId(value, field);
  if (!normalized) throw new TypeError(`session route requires ${field}`);
  return normalized;
}

function optionalStableId(value, field) {
  const normalized = String(value ?? "").trim();
  if (/[\u0000-\u001f\u007f]/.test(normalized)) throw new TypeError(`session route ${field} contains control characters`);
  if (normalized.length > SESSION_ROUTE_ID_MAX_LENGTH) throw new TypeError(`session route ${field} exceeds protocol length limit`);
  return normalized;
}

export {
  SESSION_ROUTE_AUTHORITY_CONTRACT,
  SESSION_ROUTE_CONTRACT,
  SESSION_ROUTE_DIGEST_KEY_MIN_BYTES,
  SESSION_ROUTE_ID_MAX_LENGTH,
  createSessionRoute,
  createSessionRouteAuthority,
};
