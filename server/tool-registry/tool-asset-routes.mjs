export function createToolAssetHandlers({ repository, requireSession, readJsonBody, sendJson, actorDigest, connectionOptions }) {
  async function handle(req, res, url) {
    const match = url.pathname.match(/^\/api\/tool-assets(?:\/([^/]+)(?:\/(decision))?)?$/);
    if (!match) return undefined;
    const session = requireSession(req, res); if (!session) return true;
    let id;
    try { id = match[1] ? decodeURIComponent(match[1]) : ""; }
    catch { sendJson(res, 400, { ok: false, error: "tool_asset_identifier_invalid" }); return true; }
    if (match[2] && req.method !== "POST") {
      sendJson(res, 405, { ok: false, error: "method_not_allowed" }); return true;
    }
    const canManage = session.role === "admin" || (session.permissions || []).some(permission =>
      ["system:*", "digital-employees:*", "provider-connections:*", "control-plane:*"].includes(permission));
    if (req.method === "GET" && id === "catalog") {
      sendJson(res, 200, { ok: true, tools: repository.catalog(), sourceOfTruth: "backend_tool_asset_registry", canManage }); return true;
    }
    if (!canManage) { sendJson(res, 403, { ok: false, error: "tool_asset_governance_required" }); return true; }
    try {
      if (req.method === "GET") {
        if (id === "connections") sendJson(res, 200, { ok: true, ...connectionOptions() });
        else if (id) {
          const asset = repository.review(id);
          sendJson(res, asset ? 200 : 404, { ok: Boolean(asset), ...(asset ? { asset } : { error: "tool_asset_not_found" }) });
        } else sendJson(res, 200, { ok: true, assets: repository.list(), canManage });
      } else if (req.method === "POST") {
        const input = await readJsonBody(req, 1100 * 1024);
        const fields = match[2] ? ["expectedVersion", "decision"] : ["expectedVersion", "asset"];
        if (!input || Array.isArray(input) || Object.keys(input).length !== fields.length || Object.keys(input).some(key => !fields.includes(key))) {
          throw Object.assign(new Error(), { code: "tool_asset_request_invalid" });
        }
        const principal = actorDigest(session);
        if (match[2]) sendJson(res, 200, { ok: true, asset: repository.decide({ ...input, toolId: id, actorDigest: principal }) });
        else if (!id) sendJson(res, 201, { ok: true, asset: repository.submit({ ...input, actorDigest: principal }) });
        else sendJson(res, 405, { ok: false, error: "method_not_allowed" });
      } else sendJson(res, 405, { ok: false, error: "method_not_allowed" });
    } catch (error) {
      const code = /^tool_asset_[a-z_]+$/.test(error?.code || "") ? error.code : "tool_asset_unavailable";
      sendJson(res, code === "tool_asset_version_conflict" ? 409 : code === "tool_asset_unavailable" ? 503 : 422, { ok: false, error: code });
    }
    return true;
  }
  return { handle };
}
