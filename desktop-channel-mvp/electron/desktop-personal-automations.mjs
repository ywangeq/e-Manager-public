const ID = /^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,159}$/;
export function registerDesktopPersonalAutomationsIpc({ipcMain,assertSender,actorContext,isExpectedActor,desktopFetch}) {
  ipcMain.handle("desktop:personal-automations",async (event,request = {}) => {
    assertSender(event);
    const actor = actorContext();
    if (!actor?.key) return {ok:false,status:"authentication_required"};
    try {
      if (!request || Object.keys(request).some(k => !["action","automationId","input"].includes(k))) throw new Error();
      const {action,automationId,input} = request;
      if (!["list","create","detail","change","read"].includes(action) || (["detail","change","read"].includes(action) && !ID.test(automationId || ""))) throw new Error();
      const fields = {create:["sourceTaskId","employeeId","idempotencyKey","intervalSeconds","startAt","expiresAt","maxRuns","timezone"],change:["action","expectedRevision"],read:["taskId"]}[action];
      if (fields && (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input).some(k => !fields.includes(k)))) throw new Error();
      if (JSON.stringify(input || {}).length > 4096) throw new Error();
      if (!isExpectedActor(actor.key,actor.version)) throw new Error();
      const suffix = ["detail","change","read"].includes(action) ? `/${encodeURIComponent(automationId)}${action === "read" ? "/read" : ""}` : "";
      const response = await desktopFetch(`/api/me/personal-automations${suffix}`,{
        method:action === "change" ? "PATCH" : fields ? "POST" : "GET",
        headers:{Accept:"application/json",...(fields ? {"Content-Type":"application/json"} : {})},
        ...(fields ? {body:JSON.stringify(input)} : {}),
      });
      const data = await response.json();
      if (!isExpectedActor(actor.key,actor.version)) return {ok:false,status:"desktop_actor_changed"};
      if (!response.ok) return {ok:false,status:/^personal_automation_[a-z_]+$/.test(data?.error || "") ? data.error : "personal_automation_unavailable"};
      // Explicit safe projection, even if a newer server adds private fields.
      const project = v => {
        if (!v || !ID.test(v.automationId || "") || !ID.test(v.employeeId || "")) throw new Error();
        const keys = ["automationId","employeeId","sourceTaskId","intervalSeconds","startAt","expiresAt","timezone","maxRuns","runCount","state","revision","reasonCode","lastTaskId"];
        return Object.fromEntries(keys.map(k => [k,v[k]]));
      };
      return {ok:true,...(data.automations ? {automations:data.automations.map(project)} : {}),...(data.automation ? {automation:project(data.automation)} : {}),
        ...(data.runs ? {runs:data.runs.map(v => ({taskId:v.taskId,scheduledFor:v.scheduledFor,status:v.status}))} : {}),
        ...(data.notifications ? {notifications:data.notifications.map(v => ({automationId:v.automationId,taskId:v.taskId,status:v.status,createdAt:v.createdAt,readAt:v.readAt}))} : {})};
    } catch { return {ok:false,status:"personal_automation_unavailable"}; }
  });
}
