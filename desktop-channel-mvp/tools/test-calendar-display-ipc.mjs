import assert from 'node:assert/strict';
import fs from 'node:fs';
import {validFeishuCalendarUrl} from '../shared/feishu-calendar-read-contract.mjs';
const source=fs.readFileSync(new URL('../electron/main.mjs',import.meta.url),'utf8');
const section=source.slice(source.indexOf('  ipcMain.handle("desktop:calendar-snapshot"'),source.indexOf('  registerLocalCalendarIpc('));
const handlers=new Map();
let context={actorKey:'synthetic',actorVersion:1,center:'https://synthetic.invalid',associationGeneration:1},gate=null,opened=[],senderAllowed=true;
const snapshot={ok:true,snapshots:[{events:[{eventRef:'same-ref',calendarUrl:'https://applink.feishu.cn/client/calendar/event/detail?key=synthetic'}]}]};
new Function('ipcMain','assertMainSender','GROUP_STUDIO','calendarProjectionContext','restoreCalendarDisplay','feishuCalendarProjection','validFeishuCalendarUrl','shell','getActor',`let activeActorKey=getActor();${section}`)(
 {handle:(id,fn)=>handlers.set(id,fn)},()=>{if(!senderAllowed)throw new Error('sender_rejected');},true,()=>({...context}),async()=>{if(gate)await gate;}, {read:()=>snapshot},validFeishuCalendarUrl,{openExternal:async url=>opened.push(url)},()=>context.actorKey);
const read=handlers.get('desktop:calendar-snapshot'),open=handlers.get('desktop:calendar-open-link');
assert.deepEqual(await read({},undefined),snapshot);
for(const field of ['actorKey','actorVersion','center','associationGeneration']) {
 let release;gate=new Promise(resolve=>release=resolve);
 const pending=read({},undefined);context={...context,[field]:field==='actorVersion'||field==='associationGeneration'?context[field]+1:context[field]+'other'};release();assert.equal((await pending).ok,false,`${field} race cannot return the next actor projection`);gate=null;
}
let release;gate=new Promise(resolve=>release=resolve);const pending=open({},{eventRef:'same-ref',kind:'calendarUrl'});context={...context,associationGeneration:context.associationGeneration+1};release();assert.equal((await pending).ok,false);assert.equal(opened.length,0);gate=null;
for(const input of [{eventRef:'same-ref',kind:'calendarUrl',url:'https://evil.test'},{eventRef:'same-ref',kind:'url'},{eventRef:'missing',kind:'calendarUrl'}])assert.equal((await open({},input)).ok,false);
assert.equal((await open({},{eventRef:'same-ref',kind:'calendarUrl'})).ok,true);assert.equal(opened.length,1);
senderAllowed=false;await assert.rejects(read({},undefined),/sender_rejected/);
console.log('Calendar snapshot actor/binding IPC races, exact link input, official lookup and sender boundary passed');
