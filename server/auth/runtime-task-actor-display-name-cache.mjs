const DEFAULT_SUCCESS_TTL_MS = 10 * 60_000;
const DEFAULT_UNRESOLVED_TTL_MS = 60_000;
const DEFAULT_MAX_ENTRIES = 2_000;

export function createRuntimeTaskActorDisplayNameCache({
  now = () => Date.now(),
  resolve,
  successTtlMs = DEFAULT_SUCCESS_TTL_MS,
  unresolvedTtlMs = DEFAULT_UNRESOLVED_TTL_MS,
  maxEntries = DEFAULT_MAX_ENTRIES,
  onResolution = null,
  snapshotRepository = null,
} = {}) {
  if (typeof resolve !== "function") throw new TypeError("runtime task actor display-name cache requires a resolver");
  const safeSuccessTtlMs = boundedInteger(successTtlMs, "successTtlMs", 1_000, 60 * 60_000);
  const safeUnresolvedTtlMs = boundedInteger(unresolvedTtlMs, "unresolvedTtlMs", 1_000, 10 * 60_000);
  const safeMaxEntries = boundedInteger(maxEntries, "maxEntries", 1, 10_000);
  const entries = new Map();
  const metrics = {
    cacheHits: 0,
    cacheMisses: 0,
    errors: 0,
    externalResolutions: 0,
    persistentSnapshotHits: 0,
    persistentSnapshotWrites: 0,
    singleFlightHits: 0,
  };

  async function resolveDisplayName(request = {}) {
    const key = actorCacheKey(request);
    if (!key) return resolve(request);
    const timestamp = now();
    const existing = entries.get(key);
    if (existing?.pending) {
      metrics.singleFlightHits += 1;
      return existing.pending;
    }
    if (existing && existing.expiresAt > timestamp) {
      metrics.cacheHits += 1;
      return existing.value;
    }
    entries.delete(key);
    const snapshot = readSnapshot(snapshotRepository, request);
    if (snapshot?.displayName) {
      metrics.persistentSnapshotHits += 1;
      entries.set(key, { expiresAt: timestamp + safeSuccessTtlMs, value: snapshot });
      return snapshot;
    }
    metrics.cacheMisses += 1;
    trimEntries(entries, safeMaxEntries);
    metrics.externalResolutions += 1;
    const startedAt = now();
    const pending = Promise.resolve()
      .then(() => resolve(request))
      .then((value) => {
        const resolved = value?.displayName ? value : null;
        entries.set(key, {
          expiresAt: now() + (resolved ? safeSuccessTtlMs : safeUnresolvedTtlMs),
          value: resolved,
        });
        if (resolved && writeSnapshot(snapshotRepository, request, resolved)) metrics.persistentSnapshotWrites += 1;
        notifyResolution(onResolution, { durationMs: Math.max(0, now() - startedAt), outcome: resolved ? "ok" : "empty" });
        return resolved;
      })
      .catch((error) => {
        entries.delete(key);
        metrics.errors += 1;
        notifyResolution(onResolution, { durationMs: Math.max(0, now() - startedAt), outcome: "error" });
        throw error;
      });
    entries.set(key, { pending });
    return pending;
  }

  function summary() {
    const requests = metrics.cacheHits + metrics.cacheMisses + metrics.persistentSnapshotHits + metrics.singleFlightHits;
    return Object.freeze({
      cacheEntries: [...entries.values()].filter((entry) => !entry.pending && entry.expiresAt > now()).length,
      cacheHitRate: requests ? (metrics.cacheHits + metrics.persistentSnapshotHits + metrics.singleFlightHits) / requests : null,
      cacheHits: metrics.cacheHits,
      cacheMisses: metrics.cacheMisses,
      errors: metrics.errors,
      externalResolutions: metrics.externalResolutions,
      persistentSnapshotHits: metrics.persistentSnapshotHits,
      persistentSnapshotWrites: metrics.persistentSnapshotWrites,
      singleFlightHits: metrics.singleFlightHits,
    });
  }

  return Object.freeze({ resolveDisplayName, summary });
}

function readSnapshot(repository, { actorLocator, task } = {}) {
  try {
    return repository?.get?.({ actorLocator, employeeId: task?.employeeId || task?.employee?.id || "" }) || null;
  } catch {
    return null;
  }
}

function writeSnapshot(repository, { actorLocator, task } = {}, value = null) {
  try {
    return repository?.save?.({
      actorLocator,
      displayName: value?.displayName,
      employeeId: task?.employeeId || task?.employee?.id || "",
      source: value?.source || "",
    }) === true;
  } catch {
    return false;
  }
}

function actorCacheKey({ actorLocator = null, task = null } = {}) {
  const values = [
    task?.employeeId || task?.employee?.id,
    actorLocator?.identitySource,
    actorLocator?.subjectIdType,
    actorLocator?.subjectId,
  ].map((value) => String(value || "").trim());
  return values.every(Boolean) ? values.join("\0") : "";
}

function trimEntries(entries, maximum) {
  while (entries.size >= maximum) {
    const oldest = entries.keys().next().value;
    if (!oldest) return;
    entries.delete(oldest);
  }
}

function boundedInteger(value, field, minimum, maximum) {
  const normalized = Number(value);
  if (!Number.isSafeInteger(normalized) || normalized < minimum || normalized > maximum) {
    throw new TypeError(`${field} must be an integer between ${minimum} and ${maximum}`);
  }
  return normalized;
}

function notifyResolution(listener, sample) {
  try {
    listener?.(sample);
  } catch {
    // Performance observation must never change display-name availability.
  }
}
