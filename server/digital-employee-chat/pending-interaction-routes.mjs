import { confirmationContext } from "./tool-confirmation-admission.mjs";

// Repositories remain authoritative. The overview must never carry card schema,
// arguments or an execution capability; the conversation re-reads current cards.
export function createPendingInteractionRoutes({ requireSession, sendJson, currentDigitalEmployees, canInvokeDigitalEmployee,
  resolveSessionRoute, sessionRepository, parameterRepository, confirmationService, cleanEmployeeId } = {}) {
  async function read(employee, session) {
    if (!parameterRepository?.listDrafts || !confirmationService?.pendingRequests) throw new Error("pending_interaction_repository_unavailable");
    const route = resolveSessionRoute({channelId:"desktop",employeeId:employee.id,session});
    const current = await sessionRepository.readCurrentSession(route);
    if (!current) return {cards:[],confirmations:[]};
    if (current.routeDigest !== route.routeDigest || current.status !== "active") throw new Error("pending_interaction_session_unavailable");
    return {
      cards:await parameterRepository.listDrafts({employeeId:employee.id,routeDigest:route.routeDigest,sessionId:current.sessionId}),
      confirmations:await confirmationService.pendingRequests(confirmationContext(route,current.sessionId)),
    };
  }
  const allowed = (employee, session) => typeof canInvokeDigitalEmployee === "function" && canInvokeDigitalEmployee({channelId:"desktop",employee,session});
  async function list(req,res,requestedEmployeeId = "") {
    const session = requireSession(req,res);
    if (!session) return null;
    const employeeId = requestedEmployeeId ? cleanEmployeeId(requestedEmployeeId) : "";
    const employees = currentDigitalEmployees();
    if (requestedEmployeeId) {
      const employee = employees.find(item => item.id === employeeId);
      if (!employee) return sendJson(res,404,{ok:false,error:"digital_employee_not_found"});
      if (!allowed(employee,session)) return sendJson(res,403,{ok:false,error:"digital_employee_access_required"});
      try { return sendJson(res,200,{ok:true,contractVersion:"employee-pending-interactions.v1",employeeId,...await read(employee,session)}); }
      catch { return sendJson(res,503,{ok:false,error:"pending_interactions_unavailable"}); }
    }
    try {
      const interactions = [];
      for (const employee of employees.filter(item => allowed(item,session))) {
        const {cards,confirmations} = await read(employee,session);
        for (const [kind, items] of [["parameter",cards],["confirmation",confirmations]]) {
          for (const item of items) {
            if (!item?.id || !Number.isFinite(Date.parse(item.expiresAt)) || Date.parse(item.expiresAt) <= Date.now() || !["draft","pending"].includes(item.status)) continue;
            interactions.push({id:item.id,kind,employeeId:employee.id,displayTitle:String(item.title || item.displayName || "待处理事项").slice(0,160),
              createdAt:item.createdAt || item.issuedAt,expiresAt:item.expiresAt,...(kind === "parameter" ? {requestKind:item.requestKind || "business_fields"} : {})});
          }
        }
      }
      return sendJson(res,200,{ok:true,contractVersion:"pending-interactions.v1",interactions,count:interactions.length});
    } catch { return sendJson(res,503,{ok:false,error:"pending_interactions_unavailable"}); }
  }
  return Object.freeze({list});
}
