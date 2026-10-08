const SESSION_FOUNDATION_STORE_CONTRACT = "session-foundation-store.v2";
const SESSION_FOUNDATION_ROUTE_STATE_CONTRACT = "session-foundation-route-state.v1";

function createMemorySessionFoundationStore({ initialRouteStates = [] } = {}) {
  if (!Array.isArray(initialRouteStates)) {
    throw new TypeError("session foundation store initialRouteStates must be an array");
  }
  const routeStates = new Map();
  for (const value of initialRouteStates) {
    const state = normalizeSessionFoundationRouteState(value);
    if (routeStates.has(state.routeDigest)) throw new TypeError("session foundation store routeDigest is duplicated");
    routeStates.set(state.routeDigest, state);
  }

  async function readRouteState(routeDigest) {
    const safeRouteDigest = requiredRouteDigest(routeDigest);
    return clone(routeStates.get(safeRouteDigest) || emptySessionFoundationRouteState(safeRouteDigest));
  }

  async function compareAndSwapRouteState(routeDigest, expectedRevision, nextState) {
    const safeRouteDigest = requiredRouteDigest(routeDigest);
    const current = routeStates.get(safeRouteDigest) || emptySessionFoundationRouteState(safeRouteDigest);
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0 || expectedRevision !== current.revision) return false;
    if (expectedRevision === Number.MAX_SAFE_INTEGER) {
      throw new TypeError("session foundation route state revision is exhausted");
    }
    const normalized = normalizeSessionFoundationRouteState(nextState, safeRouteDigest);
    if (normalized.revision !== expectedRevision) {
      throw new TypeError("session foundation route state revision must match expectedRevision");
    }
    normalized.revision = expectedRevision + 1;
    routeStates.set(safeRouteDigest, normalized);
    return true;
  }

  async function readSessionState(sessionId) {
    const safeSessionId = requiredText(sessionId, "sessionId");
    for (const state of routeStates.values()) {
      if (!Object.hasOwn(state.sessionRows, safeSessionId)) continue;
      return clone({
        routeDigest: state.routeDigest,
        routeRevision: state.revision,
        sessionRow: state.sessionRows[safeSessionId],
        transcriptEntries: state.transcriptEntries[safeSessionId] || [],
      });
    }
    return null;
  }

  return {
    // Test/local reference adapter only. It is not durable, approved, or a production database.
    adapterKind: "memory_reference_only",
    compareAndSwapRouteState,
    contractVersion: SESSION_FOUNDATION_STORE_CONTRACT,
    productionReady: false,
    readRouteState,
    readSessionState,
  };
}

function emptySessionFoundationRouteState(routeDigest) {
  return {
    contractVersion: SESSION_FOUNDATION_ROUTE_STATE_CONTRACT,
    routeDigest: requiredRouteDigest(routeDigest),
    revision: 0,
    headSessionId: "",
    sessionRows: {},
    transcriptEntries: {},
  };
}

function normalizeSessionFoundationRouteState(value, expectedRouteDigest = "") {
  if (!isPlainObject(value)) throw new TypeError("session foundation route state must be a plain object");
  if (value.contractVersion !== SESSION_FOUNDATION_ROUTE_STATE_CONTRACT) {
    throw new TypeError("session foundation route state contract is invalid");
  }
  const routeDigest = requiredRouteDigest(value.routeDigest);
  if (expectedRouteDigest && routeDigest !== expectedRouteDigest) {
    throw new TypeError("session foundation route state routeDigest mismatch");
  }
  const sessionRows = plainObjectRecord(value.sessionRows, "sessionRows");
  const transcriptEntries = plainObjectRecord(value.transcriptEntries, "transcriptEntries");
  const headSessionId = optionalText(value.headSessionId, "headSessionId");
  if (headSessionId && !Object.hasOwn(sessionRows, headSessionId)) {
    throw new TypeError("session foundation route state headSessionId is missing its session row");
  }
  return {
    contractVersion: SESSION_FOUNDATION_ROUTE_STATE_CONTRACT,
    routeDigest,
    revision: nonNegativeSafeInteger(value.revision, "revision"),
    headSessionId,
    sessionRows,
    transcriptEntries,
  };
}

function plainObjectRecord(value, field) {
  if (!isPlainObject(value)) throw new TypeError(`session foundation store ${field} must be a plain object`);
  return clone(value);
}

function nonNegativeSafeInteger(value, field) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`session foundation store ${field} must be a non-negative safe integer`);
  }
  return value;
}

function requiredRouteDigest(value) {
  const digest = String(value || "");
  if (!/^[a-f0-9]{64}$/.test(digest)) throw new TypeError("session foundation store requires a routeDigest");
  return digest;
}

function requiredText(value, field) {
  const text = optionalText(value, field);
  if (!text) throw new TypeError(`session foundation store requires ${field}`);
  return text;
}

function optionalText(value, field) {
  const text = String(value ?? "").trim();
  if (/[\u0000-\u001f\u007f]/.test(text)) throw new TypeError(`session foundation store ${field} contains control characters`);
  return text;
}

function isPlainObject(value) {
  if (value === null || typeof value !== "object") return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function clone(value) {
  return structuredClone(value);
}

export {
  SESSION_FOUNDATION_ROUTE_STATE_CONTRACT,
  SESSION_FOUNDATION_STORE_CONTRACT,
  createMemorySessionFoundationStore,
  emptySessionFoundationRouteState,
  normalizeSessionFoundationRouteState,
};
