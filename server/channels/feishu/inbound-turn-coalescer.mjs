const DEFAULT_INBOUND_QUIET_WINDOW_MS = 800;
const DEFAULT_INBOUND_MAX_WINDOW_MS = 5_000;
const DEFAULT_MATERIAL_GRACE_MS = 10 * 60 * 1000;
const DEFAULT_MAX_FRAGMENTS = 20;

function createInboundTurnCoalescer({
  clearTimeoutFn = clearTimeout,
  materialGraceMs = DEFAULT_MATERIAL_GRACE_MS,
  maxFragments = DEFAULT_MAX_FRAGMENTS,
  maxWindowMs = DEFAULT_INBOUND_MAX_WINDOW_MS,
  now = () => Date.now(),
  quietWindowMs = DEFAULT_INBOUND_QUIET_WINDOW_MS,
  setTimeoutFn = setTimeout,
} = {}) {
  const pendingByKey = new Map();

  function accept({ key = "", fragment = {} } = {}) {
    const routeKey = String(key || "").trim();
    if (!routeKey) return Promise.resolve(dispatchSingle(fragment));
    let entry = pendingByKey.get(routeKey);
    if (!entry || entry.state !== "pending") {
      entry = newEntry(routeKey, now());
      pendingByKey.set(routeKey, entry);
    }
    entry.fragments.push({ ...fragment, receivedAtMs: Number(fragment.receivedAtMs) || now() });
    if (entry.fragments.length > maxFragments) entry.fragments = entry.fragments.slice(-maxFragments);

    if (!entry.fragments.some((item) => item.hasIntent)) {
      scheduleMaterialExpiry(entry);
      return Promise.resolve({
        action: "buffered",
        reason: "pending_turn_waiting_for_intent",
        pendingFragmentCount: entry.fragments.length,
      });
    }

    clearTimer(entry.materialTimer);
    entry.materialTimer = null;
    if (!entry.intentStartedAtMs) {
      entry.intentStartedAtMs = now();
      entry.maxTimer = schedule(() => flush(entry, "max_window_elapsed"), maxWindowMs);
    }
    clearTimer(entry.quietTimer);
    entry.quietTimer = schedule(() => flush(entry, "quiet_window_elapsed"), quietWindowMs);
    if (!fragment.hasIntent) {
      return Promise.resolve({
        action: "buffered",
        reason: "fragment_added_to_pending_turn",
        pendingFragmentCount: entry.fragments.length,
      });
    }
    return new Promise((resolve) => {
      entry.waiters.push({ fragmentId: fragment.id, resolve });
    });
  }

  function flush(entry, reason = "explicit_flush") {
    if (!entry || entry.state !== "pending") return;
    entry.state = "flushing";
    clearEntryTimers(entry);
    pendingByKey.delete(entry.key);
    const batch = {
      fragments: entry.fragments.slice(),
      reason,
      sealedAtMs: now(),
    };
    const dispatchWaiter = entry.waiters.at(-1);
    entry.waiters.slice(0, -1).forEach((waiter) => waiter.resolve({
      action: "absorbed",
      reason: "fragment_coalesced_into_later_turn",
    }));
    dispatchWaiter?.resolve({ action: "dispatch", batch });
    entry.state = "closed";
  }

  function flushNow(key = "") {
    const entry = pendingByKey.get(String(key || "").trim());
    if (!entry?.fragments.some((item) => item.hasIntent)) return false;
    flush(entry, "explicit_flush");
    return true;
  }

  function scheduleMaterialExpiry(entry) {
    if (entry.materialTimer) return;
    entry.materialTimer = schedule(() => {
      if (entry.state !== "pending" || entry.fragments.some((item) => item.hasIntent)) return;
      entry.state = "closed";
      pendingByKey.delete(entry.key);
    }, materialGraceMs);
  }

  function schedule(callback, delayMs) {
    const timer = setTimeoutFn(callback, Math.max(0, Number(delayMs) || 0));
    timer?.unref?.();
    return timer;
  }

  function clearTimer(timer) {
    if (timer) clearTimeoutFn(timer);
  }

  function clearEntryTimers(entry) {
    clearTimer(entry.materialTimer);
    clearTimer(entry.maxTimer);
    clearTimer(entry.quietTimer);
    entry.materialTimer = null;
    entry.maxTimer = null;
    entry.quietTimer = null;
  }

  return { accept, flushNow };
}

function newEntry(key, createdAtMs) {
  return {
    createdAtMs,
    fragments: [],
    intentStartedAtMs: 0,
    key,
    materialTimer: null,
    maxTimer: null,
    quietTimer: null,
    state: "pending",
    waiters: [],
  };
}

function dispatchSingle(fragment = {}) {
  return {
    action: "dispatch",
    batch: {
      fragments: [{ ...fragment }],
      reason: "route_key_unavailable",
      sealedAtMs: Date.now(),
    },
  };
}

export {
  DEFAULT_INBOUND_MAX_WINDOW_MS,
  DEFAULT_INBOUND_QUIET_WINDOW_MS,
  DEFAULT_MATERIAL_GRACE_MS,
  createInboundTurnCoalescer,
};
