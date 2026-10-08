export function createPersonalAutomationRoutes({ service, requireSession, readJsonBody, sendJson }) {
  return { async handle(req,res,url) {
    const match = url.pathname.match(/^\/api\/me\/personal-automations(?:\/([^/]+)(?:\/(read))?)?$/);
    if (!match) return;
    const session = requireSession(req,res);
    if (!session) return;
    try {
      const id = match[1];
      if (req.method === "GET" && !id) return sendJson(res,200,{ok:true,...service.list(session)});
      if (req.method === "GET" && id && !match[2]) return sendJson(res,200,{ok:true,...service.detail(session,id)});
      if (req.method === "POST" && !id) return sendJson(res,201,{ok:true,automation:await service.create(session,await readJsonBody(req,8192))});
      if (req.method === "PATCH" && id && !match[2]) return sendJson(res,200,{ok:true,automation:await service.change(session,id,await readJsonBody(req,1024))});
      if (req.method === "POST" && match[2] === "read") {
        const body = await readJsonBody(req,1024);
        if (!body || Object.keys(body).some(k => k !== "taskId")) throw Object.assign(new Error(),{code:"personal_automation_request_invalid"});
        service.markRead(session,id,body.taskId);
        return sendJson(res,200,{ok:true});
      }
      return sendJson(res,405,{ok:false,error:"personal_automation_method_not_allowed"});
    } catch (error) {
      const code = /^personal_automation_[a-z_]+$/.test(error?.code || "") ? error.code : "personal_automation_unavailable";
      const status = /not_found|input_unavailable/.test(code) ? 404 : /authorization/.test(code) ? 403 : /conflict|terminal/.test(code) ? 409 : /invalid|limit/.test(code) ? 400 : 503;
      return sendJson(res,status,{ok:false,error:code});
    }
  }};
}
