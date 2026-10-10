export async function readConfirmationDeliveryResponse({ response, read, hasTask }) {
  if ([502, 503, 504].includes(response.status)) throw Error("tool_confirmation_transport_unavailable");
  const body = await read();
  if (!hasTask() && ![400, 401, 403, 404, 410, 422].includes(response.status)) throw Error("tool_confirmation_delivery_unresolved");
  return body;
}

// Retry delivery of one approval, never the business operation or an entire model task.
export async function deliverToolConfirmation({ send, lookup, recovered, signal, canContinue = () => true,
  wait = abortableDelay, maxAttempts = 4, lookupFirst = false } = {}) {
  let lastError;
  let maySend = !lookupFirst;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    if (signal?.aborted || !canContinue()) throw signal?.reason || Error("desktop_assistant_actor_changed");
    if (maySend) {
      try { return await send(); } catch (error) { lastError = error; }
    }
    if (signal?.aborted || !canContinue()) throw signal?.reason || Error("desktop_assistant_actor_changed");
    maySend = false;
    try {
      const state = await lookup();
      if (signal?.aborted || !canContinue()) throw signal?.reason || Error("desktop_assistant_actor_changed");
      if (state?.status === "submitted" && /^task_[a-f0-9]{64}$/.test(state.taskId || "")) return recovered(state);
      if (state?.status === "pending" || state?.status === "accepted") maySend = true;
      else throw Object.assign(Error("tool_confirmation_unavailable"), { terminal: true });
    } catch (error) {
      if (error.terminal) throw error;
      // An unavailable/legacy status endpoint is not proof that resubmission is safe.
      lastError = error;
    }
    if (attempt + 1 < maxAttempts) await wait(Math.min(1000 * 2 ** attempt, 4000), signal);
  }
  throw lastError || Error("tool_confirmation_delivery_unresolved");
}

function abortableDelay(ms, signal) {
  return new Promise((resolve, reject) => {
    const finish = () => { signal?.removeEventListener("abort", abort); resolve(); };
    const timer = setTimeout(finish, ms);
    const abort = () => { clearTimeout(timer); signal?.removeEventListener("abort", abort); reject(signal.reason); };
    if (signal?.aborted) abort(); else signal?.addEventListener("abort", abort, { once: true });
  });
}
