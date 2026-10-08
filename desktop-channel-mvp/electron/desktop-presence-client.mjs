// Main-process connection lease, never a renderer timer or schedule authority.
export function createDesktopPresenceClient({ request, setTimeoutFn = setTimeout, clearTimeoutFn = clearTimeout }) {
  let stopped = false, authenticationRequired = false, connectionId = null, timer = null, pending = null, failures = 0;
  async function tick() {
    if (stopped || authenticationRequired || pending) return;
    let delay = Math.min(60000,10000 * 2 ** Math.min(failures,3));
    pending = (async () => {
      try {
        const response = await request("/api/channels/desktop/presence", {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ connectionId }), signal: AbortSignal.timeout(5000),
        });
        if (response.status === 403) {
          const error = await response.json().catch(() => ({}));
          if (error.error === "desktop_presence_channel_required") {
            // Center restart loses ephemeral device registration. Re-bootstrap in main,
            // including while the window is hidden; never depend on renderer activity.
            const bootstrap = await request("/api/channels/desktop/bootstrap", {method:"GET",signal:AbortSignal.timeout(5000)});
            if (bootstrap.ok) { connectionId = null; failures = 0; return; }
            if (![401,403].includes(bootstrap.status)) { failures++; return; }
          }
          authenticationRequired = true; return;
        }
        if (response.status === 401) { authenticationRequired = true; return; }
        if (response.status === 409) connectionId = null;
        if (response.ok) {
          const data = await response.json();
          if (data.ok && /^[a-f0-9-]{36}$/.test(data.connectionId) && Number.isSafeInteger(data.renewAfterMs) && data.renewAfterMs >= 1000 && data.renewAfterMs <= 10000) {
            connectionId = data.connectionId; delay = data.renewAfterMs; failures = 0; return;
          }
        }
        failures++;
      } catch { failures++; /* Missing transport means the Center lease expires, never offline dispatch. */ }
    })();
    await pending;
    pending = null;
    if (!stopped && !authenticationRequired) { timer = setTimeoutFn(tick, delay); timer?.unref?.(); }
  }
  async function stop() {
    stopped = true;
    if (timer) clearTimeoutFn(timer);
    await pending;
    const id = connectionId; connectionId = null;
    if (id) try {
      await request("/api/channels/desktop/presence", { method: "DELETE", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ connectionId: id }), signal: AbortSignal.timeout(1000) });
    } catch { /* Abrupt exit/network loss is bounded by the server lease expiry. */ }
  }
  return { start: tick, stop, needsAuthentication: () => authenticationRequired };
}
