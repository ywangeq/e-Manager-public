import { DISPLAY_HISTORY_CONTRACT } from "./agent-runtime/conversation-display-history.mjs";

function createConversationDisplayHistoryHandlers({
  displayHistoryService,
  requireSession,
  resolveAuthenticatedRoute,
  sendJson,
} = {}) {
  if (typeof displayHistoryService?.read !== "function") throw new TypeError("display history routes require displayHistoryService");
  if (typeof requireSession !== "function") throw new TypeError("display history routes require requireSession");
  if (typeof resolveAuthenticatedRoute !== "function") throw new TypeError("display history routes require resolveAuthenticatedRoute");
  if (typeof sendJson !== "function") throw new TypeError("display history routes require sendJson");

  async function handle(req, res, url) {
    const match = url.pathname.match(/^\/api\/digital-employees\/([^/]+)\/conversations\/([^/]+)\/display-history$/);
    if (req.method !== "GET" || !match) return undefined;
    const session = requireSession(req, res);
    if (!session) return null;

    let employeeId;
    let sessionId;
    try {
      employeeId = decodeURIComponent(match[1]);
      sessionId = decodeURIComponent(match[2]);
    } catch {
      return sendError(res, 400, "display_history_path_invalid");
    }

    try {
      const route = await resolveAuthenticatedRoute({ employeeId, session: structuredClone(session), sessionId });
      if (!route || route.employeeId !== employeeId) return sendError(res, 403, "display_history_access_denied");
      const history = await displayHistoryService.read({
        beforeSeq: url.searchParams.get("beforeSeq"),
        route,
        sessionId,
      });
      return sendJson(res, 200, { ok: true, history });
    } catch (error) {
      const code = String(error?.code || error?.message || "display_history_unavailable");
      if (code === "display_history_session_not_found") return sendError(res, 404, code);
      if (code === "display_history_cursor_invalid" || code === "display_history_paging_disabled") {
        return sendError(res, 422, code);
      }
      if (["display_history_access_denied", "display_history_route_invalid", "display_history_policy_denied"].includes(code)) {
        return sendError(res, 403, "display_history_access_denied");
      }
      return sendError(res, 503, "display_history_unavailable");
    }
  }

  function sendError(res, statusCode, error) {
    return sendJson(res, statusCode, { ok: false, contractVersion: DISPLAY_HISTORY_CONTRACT, error });
  }

  return { handle };
}

export { createConversationDisplayHistoryHandlers };
