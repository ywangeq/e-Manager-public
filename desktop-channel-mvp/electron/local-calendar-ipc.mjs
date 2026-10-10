export function registerLocalCalendarIpc({ipcMain,assertSender,actorContext,isExpectedActor,ensureService}) {
  ipcMain.handle("desktop:local-calendar",async (event,input)=>{
    assertSender(event);
    const actor=actorContext(), current=()=>actor?.key && isExpectedActor(actor.key,actor.version);
    if(!current() || !input || typeof input!=="object")return {ok:false};
    try{
      const service=await ensureService();
      if(!service || !current())return {ok:false};
      const keys=Object.keys(input).sort().join(",");
      let result;
      if(keys==="action" && input.action==="read")result=service.read();
      else if(keys==="action,enabled" && input.action==="configure")result=service.configure({enabled:input.enabled});
      else if(keys==="action,intervalMinutes,windowEnd,windowStart" && input.action==="configure")result=service.configure({intervalMinutes:input.intervalMinutes,windowStart:input.windowStart,windowEnd:input.windowEnd});
      else return {ok:false};
      return current()?result:{ok:false};
    }catch{return {ok:false,status:"local_calendar_unavailable"};}
  });
}
