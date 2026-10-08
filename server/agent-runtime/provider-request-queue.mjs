function createProviderRequestQueue({ maxConcurrent = 1 } = {}) {
  const lanes = new Map();
  const concurrency = positiveInteger(maxConcurrent, 1);

  function run(providerRouteId = "default", task = async () => undefined, { signal = null } = {}) {
    if (signal?.aborted) return Promise.reject(signal.reason || cancellationError());
    const key = String(providerRouteId || "default");
    const lane = lanes.get(key) || createLane();
    lanes.set(key, lane);
    return new Promise((resolve, reject) => {
      const entry = { task, resolve, reject, signal, abort: null };
      entry.abort = () => {
        const index = lane.pending.indexOf(entry);
        if (index !== -1) lane.pending.splice(index, 1);
        reject(signal?.reason || cancellationError());
        if (!lane.running && !lane.pending.length) lanes.delete(key);
      };
      signal?.addEventListener?.("abort", entry.abort, { once: true });
      lane.pending.push(entry);
      drain(key, lane);
    });
  }

  function drain(key, lane) {
    while (lane.running < concurrency && lane.pending.length) {
      const entry = lane.pending.shift();
      entry.signal?.removeEventListener?.("abort", entry.abort);
      if (entry.signal?.aborted) {
        entry.reject(entry.signal.reason || cancellationError());
        continue;
      }
      lane.running += 1;
      Promise.resolve()
        .then(entry.task)
        .then(entry.resolve, entry.reject)
        .finally(() => {
          lane.running -= 1;
          drain(key, lane);
          if (!lane.running && !lane.pending.length) lanes.delete(key);
        });
    }
  }

  return { run };
}

function cancellationError() {
  const error = new Error("agent_turn_canceled");
  error.code = "agent_turn_canceled";
  return error;
}

function createLane() {
  return { pending: [], running: 0 };
}

function positiveInteger(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 1 ? Math.floor(number) : fallback;
}

export { createProviderRequestQueue };
