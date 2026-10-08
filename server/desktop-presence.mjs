import { randomUUID } from "node:crypto";

// Ephemeral dispatch eligibility only. Definitions, slots and tasks stay in Center SQLite.
export function createDesktopPresence({ scopeFor, now = () => Date.now(), ttlMs = 30000 }) {
  const owners = new Map();
  const devices = new Map();
  const keyFor = scope => JSON.stringify([scope.tenantScope, scope.actorIssuer, scope.actorSubjectDigest]);
  function prune() {
    for (const [key, expiry] of devices) if (expiry <= now()) devices.delete(key);
    for (const [key, owner] of owners) {
      for (const [id, expiresAt] of owner.connections) if (expiresAt <= now()) owner.connections.delete(id);
      if (!owner.connections.size) owners.delete(key);
    }
  }
  const deviceKey = (session, id) => `${keyFor(scopeFor(session))}:${id}`;
  function registerDevice({session, deviceSessionId}) {
    prune();
    if (!/^dws_[a-f0-9]{32}$/.test(deviceSessionId || "")) return;
    const expiry = Math.min(...[session.expiresAt, session.authorization?.validUntil].map(Date.parse).filter(Number.isFinite));
    if (Number.isFinite(expiry) && expiry > now()) devices.set(deviceKey(session,deviceSessionId),expiry);
  }
  function hasDevice(session, id) { prune(); return /^dws_[a-f0-9]{32}$/.test(id || "") && devices.has(deviceKey(session,id)); }
  function renew(session, connectionId = null) {
    prune();
    const expiry = Math.min(...[session.expiresAt, session.authorization?.validUntil].map(Date.parse).filter(Number.isFinite));
    if (!Number.isFinite(expiry) || expiry <= now()) throw new Error("desktop_presence_authentication_required");
    const key = keyFor(scopeFor(session));
    let owner = owners.get(key);
    if (connectionId && !owner?.connections.has(connectionId)) return null;
    if (!owner) {
      owner = { generation: randomUUID(), connectedSince: new Date(now()).toISOString(), connections: new Map() };
      owners.set(key, owner);
    }
    if (!connectionId && owner.connections.size >= 16) throw new Error("desktop_presence_limit");
    const id = connectionId || randomUUID();
    owner.connections.set(id, Math.min(expiry, now() + ttlMs));
    return { connectionId: id, renewAfterMs: 10000 };
  }
  function revoke(session, id) {
    prune();
    const key = keyFor(scopeFor(session)), owner = owners.get(key);
    owner?.connections.delete(id);
    if (owner && !owner.connections.size) owners.delete(key);
  }
  function read(scope) {
    prune();
    const owner = owners.get(keyFor(scope));
    return owner ? { generation: owner.generation, connectedSince: owner.connectedSince } : null;
  }
  return { renew, revoke, read, registerDevice, hasDevice };
}

export function createDesktopPresenceRoutes({ presence, requireSession, readJsonBody, sendJson }) {
  return { async handle(req, res, url) {
    if (url.pathname !== "/api/channels/desktop/presence") return false;
    const session = requireSession(req, res);
    if (!session) return true;
    if (!presence.hasDevice(session,req.headers?.["x-digital-workforce-device-session"])) {
      sendJson(res,403,{ok:false,error:"desktop_presence_channel_required"});return true;
    }
    if (!["POST", "DELETE"].includes(req.method)) { sendJson(res, 405, { ok: false }); return true; }
    try {
      const body = await readJsonBody(req, 256);
      if (!body || typeof body !== "object" || Array.isArray(body) || Object.keys(body).some(k => k !== "connectionId") ||
          (body.connectionId != null && !/^[a-f0-9-]{36}$/.test(body.connectionId)) ||
          (req.method === "DELETE" && !body.connectionId)) throw new Error();
      if (req.method === "DELETE") { presence.revoke(session, body.connectionId); sendJson(res, 200, { ok: true }); }
      else {
        const lease = presence.renew(session, body.connectionId);
        sendJson(res, lease ? 200 : 409, lease ? { ok: true, ...lease } : { ok: false, error: "desktop_presence_expired" });
      }
    } catch { sendJson(res, 400, { ok: false, error: "desktop_presence_unavailable" }); }
    return true;
  }};
}
