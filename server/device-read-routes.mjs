const BASE = "/api/channels/desktop/device-read";
export function createDeviceReadRoutes({ transport, requireSession, readJsonBody, sendJson } = {}) {
  return Object.freeze({ async handle(req, res, url) {
    if (url.pathname !== BASE + "/session" && url.pathname !== BASE + "/claim" && !url.pathname.startsWith(BASE + "/attempts/")) return false;
    const session = requireSession(req, res);
    if (!session) return true;
    res.setHeader("Cache-Control", "no-store");
    if (!transport) { sendJson(res, 503, { ok: false, error: "device_read_unavailable" }); return true; }
    const requestContext = { req, session };
    const attempt = url.pathname.match(/^\/api\/channels\/desktop\/device-read\/attempts\/(device_read_[a-f0-9]{64})\/(validate|result)$/);
    try {
      let response;
      if (url.pathname === BASE + "/session" && req.method === "POST") response = transport.register({ body: await readJsonBody(req, 2048), requestContext });
      else if (url.pathname === BASE + "/session" && req.method === "DELETE") response = transport.revoke({ requestContext });
      else if (url.pathname === BASE + "/claim" && req.method === "GET") response = await transport.claim({ requestContext });
      else if (attempt && req.method === "POST") response = await transport[attempt[2] === "validate" ? "validate" : "complete"]({
        attemptId: attempt[1], body: await readJsonBody(req, attempt[2] === "validate" ? 256 : 40 * 1024), requestContext });
      else { sendJson(res, 405, { ok: false, error: "device_read_method_invalid" }); return true; }
      sendJson(res, response.ok ? 200 : 403, response);
    } catch { sendJson(res, 400, { ok: false, error: "device_read_request_invalid" }); }
    return true;
  } });
}
