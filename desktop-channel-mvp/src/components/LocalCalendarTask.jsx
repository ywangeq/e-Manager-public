import { AutomationTaskHeader } from "./AutomationTaskHeader.jsx";
import { AutomationScheduleSettings, time } from "./AutomationScheduleSettings.jsx";
import { AutomationSettingsDialog } from "./AutomationSettingsDialog.jsx";
import { useEffect, useState } from "react";

export function LocalCalendarTask({desktopApi,revision,employeeId="all",onPresence, children}) {
  const [editing,setEditing]=useState(false);
  const [rule,setRule]=useState(null),[busy,setBusy]=useState(false),[error,setError]=useState("");
  useEffect(()=>{
    let active=true,sequence=0;
    const refresh=async()=>{const current=++sequence;try{const value=await desktopApi.localCalendar({action:"read"});if(active && current===sequence)setRule(value?.ok?value:null);}catch{if(active && current===sequence)setRule(null);}};
    void refresh();const unsubscribe=desktopApi.onCalendarChanged?.(refresh);
    return()=>{active=false;sequence++;unsubscribe?.();};
  },[desktopApi,revision]);
  async function toggle(){
    setBusy(true);setError("");
    try{const value=await desktopApi.localCalendar({action:"configure",enabled:!rule.enabled});if(!value?.ok)throw new Error();setRule(value);}
    catch{setError("未能修改本机定时任务，请刷新重试。");}
    finally{setBusy(false);}
  }
  async function save(settings){
    setBusy(true);setError("");
    try{const value=await desktopApi.localCalendar({action:"configure",...settings});if(!value?.ok)throw new Error();setRule(value);setEditing(false);}
    catch{setError("设置未保存，请重试。");}finally{setBusy(false);}
  }
  const visible=Boolean(rule?.configured && (employeeId==="all" || employeeId===rule.employeeId));
  useEffect(()=>{onPresence?.(visible);return()=>onPresence?.(false);},[visible,onPresence]);
  const status=!rule?"正在读取任务状态":!rule.available?"本机读取暂不可用":!rule.configured?"等待飞书账号关联":!rule.enabled?"已暂停":rule.phase==="syncing"?"正在同步":rule.phase==="unavailable"?"读取失败，等待下次重试":rule.phase==="waiting_connection"?"等待飞书关联验证":rule.phase==="ready"?"已同步":"等待自动同步";
  const closeSettings=()=>{setEditing(false);setError("");};
  const settings=editing&&visible?<AutomationSettingsDialog title={`${rule.employeeName} · 定时任务设置`} busy={busy} onClose={closeSettings}>
    <AutomationTaskHeader employeeName={rule.employeeName} status={status} enabled={rule.enabled} disabled={busy || !rule.available} onToggle={toggle} label={`${rule.employeeName} · 同步本周会议`}/>
    <p>同步本周会议</p>
    <AutomationScheduleSettings minIntervalMinutes={15} maxIntervalMinutes={10080} intervalMinutes={rule.intervalMinutes} windowStart={rule.windowStart} windowEnd={rule.windowEnd} busy={busy} firstReadNote="关联、启动或恢复后的首读不受时段限制；" onSave={save} onCancel={closeSettings}/>
    {error?<p role="alert">{error}</p>:null}
  </AutomationSettingsDialog>:null;
  if(children)return <>{children({rule:visible?rule:null,openSettings:()=>{setEditing(true);setError("");}})}{visible?settings:null}</>;
  if(!visible)return null;
  return <article className={`my-task-lane automation-task-row ${rule.enabled?"is-enabled":"is-disabled"}`} aria-label={`${rule.employeeName}定时任务`}>
    <AutomationTaskHeader employeeName={rule.employeeName} status={status} enabled={rule.enabled} disabled={busy || !rule.available} onToggle={toggle} label={`${rule.employeeName} · 同步本周会议`} actions={<button type="button" disabled={busy} aria-expanded={editing} className="personal-automation-action" onClick={()=>{setEditing(true);setError("");}}>设置</button>}/>
    <p>同步本周会议</p>
    <p className="automation-next-time">每 {rule?.intervalMinutes ? (rule.intervalMinutes>=60?`${rule.intervalMinutes/60} 小时`:`${rule.intervalMinutes} 分钟`):"12 小时"} · {rule && rule.windowStart!==rule.windowEnd?`${time(rule.windowStart)}—${time(rule.windowEnd)}${rule.windowStart>rule.windowEnd?"（跨天）":""}`:"全天"} · {rule?.enabled && rule.nextAt ? `下次 ${new Date(rule.nextAt).toLocaleString([], {month:"numeric",day:"numeric",hour:"2-digit",minute:"2-digit"})} · `:""}本机执行，错过不补跑。</p>
    {settings}
    {error?<p role="alert">{error}</p>:null}
  </article>;
}
