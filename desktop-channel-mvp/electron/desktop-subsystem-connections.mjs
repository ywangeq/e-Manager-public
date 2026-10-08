import { subsystemConnectionsFromEmployees } from "../shared/desktop-subsystem-connections.mjs";

const CONTRACT = "desktop-subsystem-connections.v1";
const STATES = new Set(["connected", "authenticated", "disconnected", "expired", "checking", "verification_required", "account_blocked", "not_configured", "unavailable", "unknown", "on_demand"]);
const ACTIONS = new Set(["connect", "check", "disconnect"]);

export function createDesktopSubsystemConnections({ actorContext, isExpectedActor, adapters = new Map(), notify = () => {} }) {
  let catalog = [];
  let revision = 0;
  let timer = null;
  const pending = new Map();

  function clear() {
    revision++;
    catalog = [];
    clearInterval(timer);
    timer = null;
    for (const operation of pending.values()) operation.controller.abort();
    pending.clear();
  }

  function configure(employees) {
    clear();
    catalog = subsystemConnectionsFromEmployees(employees);
    timer = setInterval(() => { void checkAll(); }, 5 * 60_000);
    timer.unref?.();
  }

  async function list() {
    const actor = actorContext();
    const expectedRevision = revision;
    if (!actor?.key) return unavailable("authentication_required");
    const connections = await Promise.all(catalog.map(async connection => {
      const adapter = adapterFor(connection);
      let state;
      try { state = adapter ? await adapter.status(connection.id) : {}; }
      catch { state = { state: "unavailable" }; }
      const actions = adapter ? [...ACTIONS].filter(action => typeof adapter[action] === "function") : [];
      const safeState = pending.has(connection.id) ? "checking" : STATES.has(state.state) ? state.state
        : connection.credentialMode === "center_current_user_lease" ? "on_demand" : "unknown";
      return {
        id: connection.id,
        name: adapter?.name || connection.name,
        icon: ["database", "users", "identification"].includes(adapter?.icon) ? adapter.icon : "plugs",
        employees: connection.employees,
        state: safeState,
        renewal: adapter?.renewal || "unknown",
        actions: state.actionsEnabled === false ? [] : actions,
        authenticatedAt: safeDate(state.authenticatedAt),
        checkedAt: safeDate(state.checkedAt),
        verifiedAt: safeDate(state.verifiedAt),
        accessTokenExpiresAt: state.expiryKnown === true ? safeDate(state.expiresAt) : "",
      };
    }));
    if (expectedRevision !== revision || !isExpectedActor(actor.key, actor.version)) return unavailable("desktop_actor_changed");
    return { ok: true, contractVersion: CONTRACT, connections };
  }

  async function request(input = {}) {
    if (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input).some(key => !["action", "connectionId"].includes(key))) return unavailable("invalid_request");
    if (input.action === "list" && !input.connectionId) return list();
    if (!ACTIONS.has(input.action) || typeof input.connectionId !== "string") return unavailable("invalid_request");
    const actor = actorContext();
    const expectedRevision = revision;
    if (!actor?.key) return unavailable("authentication_required");
    const connection = catalog.find(item => item.id === input.connectionId);
    const adapter = connection && adapterFor(connection);
    if (!adapter || typeof adapter[input.action] !== "function") return unavailable("action_unavailable");
    let state;
    try { state = await adapter.status(connection.id); }
    catch { return unavailable("connection_unavailable"); }
    if (expectedRevision !== revision || !isExpectedActor(actor.key, actor.version)) return unavailable("desktop_actor_changed");
    if (state.actionsEnabled === false) return unavailable("action_unavailable");
    if (pending.has(connection.id)) return unavailable("connection_busy");
    const controller = new AbortController();
    const operation = { controller };
    pending.set(connection.id, operation);
    const deadline = setTimeout(() => controller.abort(), 10_000);
    try {
      if (!isExpectedActor(actor.key, actor.version)) return unavailable("desktop_actor_changed");
      await adapter[input.action](connection.id, { signal: controller.signal });
      if (controller.signal.aborted || expectedRevision !== revision || !isExpectedActor(actor.key, actor.version)) return unavailable("desktop_actor_changed");
    } catch {
      if (expectedRevision !== revision || !isExpectedActor(actor.key, actor.version)) return unavailable("desktop_actor_changed");
      return unavailable("connection_action_failed");
    } finally {
      clearTimeout(deadline);
      if (pending.get(connection.id) === operation) pending.delete(connection.id);
      notify();
    }
    return list();
  }

  async function checkAll() {
    const snapshot = await list();
    if (!snapshot.ok) return;
    await Promise.all(snapshot.connections.filter(item => item.actions.includes("check") && ["connected", "authenticated", "verification_required", "unavailable"].includes(item.state))
      .map(item => request({ action: "check", connectionId: item.id })));
  }

  function adapterFor(connection) {
    const adapter = adapters.get(connection.id);
    return adapter?.credentialMode === connection.credentialMode ? adapter : null;
  }
  return { clear, configure, list, request, checkAll };
}

export function registerDesktopSubsystemConnectionsIpc({ ipcMain, assertSender, service }) {
  ipcMain.handle("desktop:subsystem-connections", (event, input) => {
    assertSender(event);
    return service.request(input);
  });
}

function safeDate(value) {
  return typeof value === "string" && Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : "";
}
function unavailable(status) { return { ok: false, contractVersion: CONTRACT, status, connections: [] }; }
