import { toolParameterCardDraftsFromRuntime } from "../agent-runtime/tool-parameter-card.mjs";

export function createToolParameterCardRouteSupport({ canInvokeDigitalEmployee, currentDigitalEmployees, repository, requireSession, resolveSessionRoute, sessionRepository, sendJson, cleanEmployeeId } = {}) {
  function persistDrafts({ employee = {}, route = null, sessionId = "", sourceTaskId = "", toolCalls = [] } = {}) {
    if (!repository || !route?.routeDigest || !sessionId || !sourceTaskId) return [];
    return toolParameterCardDraftsFromRuntime({ toolCalls }).flatMap((card) => {
      try {
        return [repository.saveDraft({ card, employeeId: employee.id, routeDigest: route.routeDigest, sessionId, sourceTaskId })];
      } catch {
        return [];
      }
    });
  }

  async function list(req, res, requestedEmployeeId = "") {
    const session = requireSession(req, res);
    if (!session) return null;
    if (!repository) return sendJson(res, 503, { ok: false, error: "tool_parameter_card_repository_unavailable" });
    const employeeId = cleanEmployeeId(requestedEmployeeId);
    const employee = currentDigitalEmployees().find((item) => cleanEmployeeId(item.id) === employeeId);
    if (!employee) return sendJson(res, 404, { ok: false, error: "digital_employee_not_found" });
    if (typeof canInvokeDigitalEmployee === "function" && !canInvokeDigitalEmployee({ channelId: "desktop", employee, session })) {
      return sendJson(res, 403, { ok: false, error: "digital_employee_access_required" });
    }
    const route = resolveSessionRoute({ channelId: "desktop", employeeId, session });
    const currentSession = await sessionRepository.readCurrentSession(route);
    if (!currentSession?.sessionId) return sendJson(res, 200, { ok: true, contractVersion: "tool-parameter-card-list.v1", cards: [] });
    return sendJson(res, 200, {
      ok: true,
      contractVersion: "tool-parameter-card-list.v1",
      employeeId,
      sessionId: currentSession.sessionId,
      cards: repository.listDrafts({ employeeId, routeDigest: route.routeDigest, sessionId: currentSession.sessionId }),
    });
  }

  return Object.freeze({ list, persistDrafts });
}
