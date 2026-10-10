import { useState } from "react";

export function AutomationScheduleSettings({intervalMinutes,windowStart=0,windowEnd=0,busy=false,onSave,onCancel,firstReadNote="",readOnly=false,readOnlyNote="",minIntervalMinutes=1,maxIntervalMinutes=43200}) {
  const [draft,setDraft]=useState({interval:String(intervalMinutes%60===0?intervalMinutes/60:intervalMinutes),unit:intervalMinutes%60===0?"hours":"minutes",allDay:windowStart===windowEnd,start:time(windowStart),end:time(windowEnd)});
  const [error,setError]=useState("");
  async function save(event){
    event.preventDefault();if(readOnly || busy)return;const minutes=Number(draft.interval)*(draft.unit==="hours"?60:1);
    if(!Number.isInteger(minutes)||minutes<minIntervalMinutes||minutes>maxIntervalMinutes||(!draft.allDay&&draft.start===draft.end)){setError("请检查执行间隔范围；指定时段的开始与结束不能相同。");return;}
    setError("");await onSave({intervalMinutes:minutes,windowStart:draft.allDay?0:minute(draft.start),windowEnd:draft.allDay?0:minute(draft.end)});
  }
  return <form className="automation-schedule-settings" onSubmit={save}>
      <label>执行间隔<span className="automation-interval-input"><input aria-label="执行间隔数值" type="number" min={draft.unit==="hours"?minIntervalMinutes/60:minIntervalMinutes} max={draft.unit==="hours"?maxIntervalMinutes/60:maxIntervalMinutes} step="any" value={draft.interval} onChange={event=>setDraft({...draft,interval:event.target.value})} required disabled={busy||readOnly}/><select aria-label="执行间隔单位" value={draft.unit} onChange={event=>setDraft({...draft,interval:String(Number(draft.interval)*(event.target.value==="hours"?1/60:60)),unit:event.target.value})} disabled={busy||readOnly}><option value="hours">小时</option><option value="minutes">分钟</option></select></span></label>
      <label>执行时段<select value={draft.allDay?"all":"window"} onChange={event=>setDraft({...draft,allDay:event.target.value==="all",start:draft.start==="00:00"?"09:00":draft.start,end:draft.end==="00:00"?"18:00":draft.end})} disabled={busy||readOnly}><option value="all">全天</option><option value="window">指定每日时段</option></select></label>
      {!draft.allDay?<><label>开始<input type="time" value={draft.start} onChange={event=>setDraft({...draft,start:event.target.value})} required disabled={busy||readOnly}/></label><label>结束<input type="time" value={draft.end} onChange={event=>setDraft({...draft,end:event.target.value})} required disabled={busy||readOnly}/></label></>:null}
      <small>{readOnly?readOnlyNote:<>按本机时区执行；跨午夜时段可用。{firstReadNote}周期同步在指定时段内进行。保存从当前时间重新计算下次同步，不改变开关。</>}</small>
      <div className="automation-settings-footer"><button type="button" className="personal-automation-action" disabled={busy} onClick={onCancel}>{readOnly?"关闭":"取消"}</button>{!readOnly?<button type="submit" className="personal-automation-action is-primary" disabled={busy}>{busy?"保存中…":"保存"}</button>:null}</div>
    {error?<p role="alert">{error}</p>:null}
    </form>;
}

export function time(value){return `${String(Math.floor(value/60)).padStart(2,"0")}:${String(value%60).padStart(2,"0")}`;}
function minute(value){const [hours,minutes]=value.split(":").map(Number);return hours*60+minutes;}
