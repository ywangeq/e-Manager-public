import path from "node:path";
import { createSessionRouteAuthority } from "./session-route.mjs";
import { createSessionFoundationRepository } from "./session-foundation-repository.mjs";
import { createSqliteSessionFoundationPersistence } from "./sqlite-session-foundation-store.mjs";
import { resolveDigitalWorkforceDataDir } from "../local-data-root.mjs";

const SQLITE_MODE = "sqlite";

function createRuntimeSessionPersistence({ env = process.env, projectRoot } = {}) {
  const mode = requiredEnvironmentValue(env.SESSION_FOUNDATION_STORE_MODE, "SESSION_FOUNDATION_STORE_MODE");
  if (mode !== SQLITE_MODE) throw new TypeError(`unsupported SESSION_FOUNDATION_STORE_MODE: ${mode}`);

  const encryptionKey = decodeKey(env.SESSION_FOUNDATION_ENCRYPTION_KEY, "SESSION_FOUNDATION_ENCRYPTION_KEY");
  const routeDigestKey = decodeKey(env.SESSION_ROUTE_DIGEST_KEY, "SESSION_ROUTE_DIGEST_KEY");
  const centerInstanceId = requiredEnvironmentValue(env.SESSION_FOUNDATION_CENTER_INSTANCE_ID, "SESSION_FOUNDATION_CENTER_INSTANCE_ID");
  const tenantScope = requiredEnvironmentValue(env.SESSION_FOUNDATION_TENANT_SCOPE, "SESSION_FOUNDATION_TENANT_SCOPE");
  const foundationPolicy = parseFoundationPolicy(env.SESSION_FOUNDATION_POLICY_JSON);
  const databasePath = String(env.SESSION_FOUNDATION_DATABASE_PATH || "").trim() ||
    path.join(resolveDigitalWorkforceDataDir({ env, projectRoot: requiredProjectRoot(projectRoot) }), "agent-session-foundation.sqlite");
  const persistence = createSqliteSessionFoundationPersistence({ databasePath, encryptionKey });
  const routeAuthority = createSessionRouteAuthority({ routeDigestKey });
  const createRoute = (dimensions = {}) => routeAuthority.create({ ...dimensions, centerInstanceId, tenantScope });
  const sessionRepository = createSessionFoundationRepository({
    policy: foundationPolicy,
    routeVerifier: routeAuthority.verify,
    store: persistence.foundationStore,
  });
  return {
    authority: Object.freeze({
      kind: "channel_neutral_session_foundation_database",
      adapterKind: persistence.foundationStore.adapterKind,
      deploymentScope: persistence.foundationStore.deploymentScope,
      productionReady: true,
      routeAuthorityContract: routeAuthority.contractVersion,
    }),
    close: persistence.close,
    checkpointStore: persistence.checkpointStore,
    instructionStore: persistence.instructionStore,
    createRoute,
    foundationStore: persistence.foundationStore,
    mode,
    productionReady: true,
    routeAuthority,
    sessionRepository,
  };
}

function decodeKey(value, environmentName) {
  const encoded = String(value || "").trim();
  if (!encoded) throw new TypeError(`sqlite session persistence requires ${environmentName}`);
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) {
    throw new TypeError(`${environmentName} must be base64`);
  }
  const key = Buffer.from(encoded, "base64");
  if (key.length !== 32) throw new TypeError(`${environmentName} must decode to exactly 32 bytes`);
  return key;
}

function requiredEnvironmentValue(value, name) {
  const text = String(value || "").trim();
  if (!text) throw new TypeError(`sqlite session persistence requires ${name}`);
  return text;
}

function parseFoundationPolicy(value) {
  const raw = String(value || "").trim();
  if (!raw) throw new TypeError("sqlite session persistence requires SESSION_FOUNDATION_POLICY_JSON");
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new TypeError("SESSION_FOUNDATION_POLICY_JSON must be valid JSON");
  }
  if (parsed?.contractVersion !== "session-foundation-policy.v1") {
    throw new TypeError("SESSION_FOUNDATION_POLICY_JSON contractVersion is invalid");
  }
  const resetAfterMs = positiveSafeInteger(parsed.idle?.resetAfterMs, "idle.resetAfterMs");
  const allowedResetModes = allowedModes(parsed.reset?.allowedModes, ["automatic", "explicit"], "reset.allowedModes");
  const allowedDeleteModes = allowedModes(parsed.retention?.allowedDeleteModes, ["explicit", "retention"], "retention.allowedDeleteModes");
  const limits = {};
  for (const field of ["maxEntriesPerSession", "maxEntryBytes", "maxCasRetries"]) {
    limits[field] = positiveSafeInteger(parsed.limits?.[field], `limits.${field}`);
  }
  return {
    contractVersion: parsed.contractVersion,
    idle: {
      evaluate: ({ at, session }) => Date.parse(at) - Date.parse(session.lastInteractionAt) >= resetAfterMs
        ? { reset: true, reason: "configured_idle_timeout" }
        : { reset: false },
    },
    reset: { authorize: ({ mode }) => allowedResetModes.includes(mode) },
    retention: { authorizeDelete: ({ mode }) => allowedDeleteModes.includes(mode) },
    limits,
  };
}

function positiveSafeInteger(value, field) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError(`SESSION_FOUNDATION_POLICY_JSON ${field} must be a positive safe integer`);
  }
  return value;
}

function allowedModes(value, supported, field) {
  if (!Array.isArray(value) || !value.length || value.some((item) => !supported.includes(item))) {
    throw new TypeError(`SESSION_FOUNDATION_POLICY_JSON ${field} is invalid`);
  }
  return [...new Set(value)];
}

function requiredProjectRoot(value) {
  const projectRoot = String(value || "").trim();
  if (!projectRoot) throw new TypeError("runtime session persistence requires projectRoot");
  return projectRoot;
}

export {
  SQLITE_MODE,
  createRuntimeSessionPersistence,
  parseFoundationPolicy,
};
