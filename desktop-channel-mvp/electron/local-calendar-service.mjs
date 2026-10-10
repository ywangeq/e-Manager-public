import { allowedTime } from "../shared/local-calendar-schedule.mjs";
export { allowedTime } from "../shared/local-calendar-schedule.mjs";
import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { FEISHU_CALENDAR_READ_DESCRIPTOR as contract } from "../shared/feishu-calendar-read-contract.mjs";

// Main-owned local rule, not a mirror of Center's employee automation records.
// This SQLite store contains only anonymous rules; the separate encrypted
// display cache owns historical calendar bodies and never restores executions.
export function createLocalCalendarService({ databasePath, createHost, employee, adapter, connection, context, projection,
  notify = () => {}, now = () => Date.now(), intervalMs = 12*60*60_000 }) {
  fs.mkdirSync(path.dirname(databasePath),{recursive:true,mode:0o700});
  const db = new DatabaseSync(databasePath);
  fs.chmodSync(databasePath,0o600);
  db.exec("CREATE TABLE IF NOT EXISTS local_calendar_rule_v1 (actor_digest TEXT PRIMARY KEY, enabled INTEGER NOT NULL, next_due INTEGER NOT NULL)");
  const columns=new Set(db.prepare("PRAGMA table_info(local_calendar_rule_v1)").all().map(column=>column.name));
  const migrating=!columns.has("interval_minutes");
  db.exec("BEGIN");
  for(const [name,value] of [["interval_minutes",intervalMs/60_000],["window_start",0],["window_end",0]]){
    if(!columns.has(name))db.exec(`ALTER TABLE local_calendar_rule_v1 ADD COLUMN ${name} INTEGER NOT NULL DEFAULT ${value}`);
  }
  if(migrating)db.prepare("UPDATE local_calendar_rule_v1 SET next_due=?").run(now()+intervalMs);
  db.exec("COMMIT");
  const getRule=key=>key && db.prepare("SELECT * FROM local_calendar_rule_v1 WHERE actor_digest=?").get(key);
  const nextDue=(timestamp,row={interval_minutes:intervalMs/60_000,window_start:0,window_end:0})=>allowedTime(timestamp+row.interval_minutes*60_000,row.window_start,row.window_end);
  let suspended = false, closed = false, busy = false, lastPhase = "not_synced", phaseActor = "", timer = null, scanning = false, firstReadPending = true, generation = 0;
  const actor = () => {const value=context();return value?.actorKey ? {key:crypto.createHash("sha256").update(JSON.stringify([value.center,value.actorKey])).digest("hex"),version:value.actorVersion} : null;};
  const host = createHost({employee,adapter,actorContext:actor,authorize:async ({actor:expected,toolId,operationId,action,writebackBoundary}) => {
    if(closed || suspended || actor()?.key!==expected.key || actor()?.version!==expected.version || toolId!==contract.toolId || operationId!==contract.operationId || action!=="read" || writebackBoundary!=="none") return false;
    await connection.check();
    return !closed && !suspended && actor()?.key===expected.key && actor()?.version===expected.version && (await connection.status()).state==="authenticated";
  }});
  const same = original => JSON.stringify(context())===JSON.stringify(original);
  const scope = () => actor()?.key;
  const clearPhase = () => {if(phaseActor!==scope()){phaseActor=scope();lastPhase="not_synced";firstReadPending=true;if(phaseActor)db.prepare("UPDATE local_calendar_rule_v1 SET next_due=? WHERE actor_digest=? AND enabled=1").run(nextDue(now(),getRule(phaseActor)),phaseActor);}};
  function read() {
    clearPhase();const key=scope();const row=getRule(key);
    return {ok:Boolean(key),source:"local",employeeId:employee.id,employeeName:employee.name,configured:Boolean(row),enabled:Boolean(row?.enabled),intervalMinutes:row?.interval_minutes ?? intervalMs/60_000,windowStart:row?.window_start ?? 0,windowEnd:row?.window_end ?? 0,nextAt:row?.enabled?new Date(row.next_due).toISOString():null,
      phase:busy?"syncing":lastPhase,available:Boolean(adapter),policy:"app_running_no_catchup"};
  }
  async function sync(input = weekWindow(now())) {
    if(!scope() || !adapter || closed || suspended) throw new Error("local_calendar_unavailable");
    if(busy) throw new Error("local_calendar_busy");
    const windows=splitWindow(input), original=context(), revision=generation;
    busy=true;phaseActor=scope();lastPhase="syncing";notify();
    try {
      for(const window of windows){
        if(revision!==generation || closed || suspended)throw new Error("local_calendar_canceled");
        const completed=await host.execute(window);
        if(!same(original) || revision!==generation || closed || suspended) throw new Error("local_calendar_actor_changed");
        projection.setContext(original);
        if(!projection.acceptLocal(original,completed)) throw new Error("local_calendar_projection_rejected");
      }
      lastPhase="ready";
      return {ok:true,source:"local"};
    } catch {
      if(same(original) && revision===generation){lastPhase="unavailable";projection.failed(original,{toolId:contract.toolId,operationId:contract.operationId});}
      throw new Error("local_calendar_sync_failed");
    } finally {busy=false;notify();}
  }
  return Object.freeze({read,
    configure(input) {
      const keys=input && Object.keys(input).sort().join(",");
      const toggling=keys==="enabled" && typeof input.enabled==="boolean";
      const setting=keys==="intervalMinutes,windowEnd,windowStart" && Number.isInteger(input.intervalMinutes) && input.intervalMinutes>=15 && input.intervalMinutes<=10080
        && [input.windowStart,input.windowEnd].every(value=>Number.isInteger(value)&&value>=0&&value<1440);
      const row=getRule(scope());
      if((!toggling && !setting) || !row || closed)throw new Error("local_calendar_rule_invalid");
      const updated=setting?{...row,interval_minutes:input.intervalMinutes,window_start:input.windowStart,window_end:input.windowEnd}:{...row,enabled:Number(input.enabled)};
      db.prepare("UPDATE local_calendar_rule_v1 SET enabled=?,next_due=?,interval_minutes=?,window_start=?,window_end=? WHERE actor_digest=?")
        .run(updated.enabled,nextDue(now(),updated),updated.interval_minutes,updated.window_start,updated.window_end,scope());
      generation++;host.cancel();if(busy)lastPhase="not_synced";if(toggling && input.enabled)firstReadPending=true;
      notify();return read();
    },
    async tick() {
      if(closed || scanning || suspended || busy || !adapter)return;
      clearPhase();const key=scope();if(!key)return;
      const original=context(), revision=generation, timestamp=now();
      scanning=true;
      try {
        let row=db.prepare("SELECT * FROM local_calendar_rule_v1 WHERE actor_digest=?").get(key);
        if(row && !row.enabled)return;
        if(!row || firstReadPending){
          // Provision only after an existing account association is verified.
          // This never launches OAuth or grants missing calendar permissions.
          await connection.check();const status=await connection.status();
          if(closed || suspended || revision!==generation || !same(original))return;
          if(status.state!=="authenticated") {lastPhase="waiting_connection";notify();return;}
          db.prepare("INSERT INTO local_calendar_rule_v1 (actor_digest,enabled,next_due) VALUES(?,1,?) ON CONFLICT(actor_digest) DO NOTHING").run(key,timestamp+intervalMs);
          row=db.prepare("SELECT * FROM local_calendar_rule_v1 WHERE actor_digest=?").get(key);
          if(!row.enabled)return;
        }
        const startup=firstReadPending;
        if(!startup && timestamp<row.next_due)return;
        if(!startup && allowedTime(timestamp,row.window_start,row.window_end)!==timestamp){
          db.prepare("UPDATE local_calendar_rule_v1 SET next_due=? WHERE actor_digest=?").run(allowedTime(timestamp,row.window_start,row.window_end),key);notify();return;
        }
        firstReadPending=false;
        db.prepare("UPDATE local_calendar_rule_v1 SET next_due=? WHERE actor_digest=?").run(nextDue(timestamp,row),key);
        // Startup/resume is a fresh current-week read, never an old slot replay.
        if(!startup && timestamp-row.next_due>60_000){notify();return;}
        try{await sync();}catch{/* Phase only; no private vendor error logging. */}
      } finally {scanning=false;}
    },
    start(){
      if(timer || closed)return;
      const key=scope();if(key)db.prepare("UPDATE local_calendar_rule_v1 SET next_due=? WHERE actor_digest=? AND enabled=1").run(nextDue(now(),getRule(key)),key);
      timer=setInterval(()=>void this.tick().catch(()=>{}),15_000);timer.unref?.();
      void this.tick().catch(()=>{});
    },
    invalidate(){generation++;host.cancel();projection.setContext(null);phaseActor="";firstReadPending=true;lastPhase="not_synced";notify();},
    suspend(){suspended=true;this.invalidate();},
    resume(){suspended=false;firstReadPending=true;const key=scope();if(key)db.prepare("UPDATE local_calendar_rule_v1 SET next_due=? WHERE actor_digest=? AND enabled=1").run(nextDue(now(),getRule(key)),key);notify();},
    async close(){if(closed)return;closed=true;clearInterval(timer);await host.close();db.close();},
  });
}
export function weekWindow(timestamp) {
  const start=new Date(timestamp);start.setHours(0,0,0,0);start.setDate(start.getDate()-(start.getDay()+6)%7);
  const end=new Date(start);end.setDate(end.getDate()+7);
  return {start:start.toISOString(),end:end.toISOString()};
}
function splitWindow(input) {
  if(!input || Object.keys(input).sort().join(",")!=="end,start")throw new Error("local_calendar_window_invalid");
  const start=Date.parse(input.start),end=Date.parse(input.end);
  if(!Number.isFinite(start) || !Number.isFinite(end) || end<=start || end-start>8*86400_000 || new Date(start).toISOString()!==input.start || new Date(end).toISOString()!==input.end)throw new Error("local_calendar_window_invalid");
  const middle=Math.min(start+7*86400_000,end);
  return [{start:input.start,end:new Date(middle).toISOString()},...(middle<end?[{start:new Date(middle).toISOString(),end:input.end}]:[])].map(contract.normalizeInput);
}
