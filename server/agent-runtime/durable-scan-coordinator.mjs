// Timer state is only a wake hint. All work/progress must live in runOnce's repository.
export function createDurableScanCoordinator({ runOnce, intervalMs = 15000, onFailure = () => {}, setTimer = setTimeout, clearTimer = clearTimeout }) {
  let active = false, timer = null, flight = null;
  function tick() {
    if (!active) return Promise.resolve();
    if (flight) return flight;
    flight = Promise.resolve().then(runOnce).catch(() => onFailure()).finally(() => {
      flight = null;
      if (active) { timer = setTimer(tick,intervalMs); timer?.unref?.(); }
    });
    return flight;
  }
  return {start() { if (active) return flight; active=true; return tick(); },
    async close() { active=false; if (timer !== null) clearTimer(timer); if (flight) await flight; }};
}
