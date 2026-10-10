import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { transformWithEsbuild } from 'vite';
import * as automationCalendar from '../src/lib/automationCalendar.js';
import * as workbenchAutomationScope from '../src/lib/workbenchAutomationScope.js';
async function component(file,name,page=null){
 const source=await readFile(new URL(`../src/components/${file}`,import.meta.url),'utf8');
 const {code}=await transformWithEsbuild(source,file,{loader:'jsx',format:'cjs',jsx:'automatic'});
 const module={exports:{}};const jsx=(type,props)=>({type,props});
 vm.runInNewContext(code,{module,require: id => id==='../lib/automationCalendar.js'?automationCalendar:id==='../lib/workbenchAutomationScope.js'?workbenchAutomationScope:id==='react/jsx-runtime'?{jsx,jsxs:jsx}:id==='react'?{useEffect(){},useRef:v=>({current:v}),useState:v=>{const initial=typeof v==='function'?v():v;return [page && initial?.automations ? page : initial,()=>{}];},useMemo:fn=>fn()}:new Proxy({},{get:(_,key)=>key}),window:{}});
 return module.exports[name];
}
function nodes(node){if(!node || typeof node!=='object')return [];return [node,...[node.props?.children].flat(Infinity).flatMap(nodes)];}
const ConversationMessage=await component('conversation/ConversationMessage.jsx','ConversationMessage');
const record={automationId:'pa_one',sourceTaskId:'task_one',intervalSeconds:14400,state:'active'};
let opened=null;
const render=(message,automations)=>nodes(ConversationMessage({message,automations,onOpenAutomation:v=>opened=v}));
assert.equal(render({role:'assistant',taskId:'task_one',content:'已安排'},[]).filter(n=>n.props?.className==='personal-automation-card').length,0,'model text alone never creates a success card');
assert.equal(render({role:'assistant',taskId:'task_other',content:'x'},[record]).filter(n=>n.props?.className==='personal-automation-card').length,0);
const card=render({role:'assistant',taskId:'task_one',content:''},[record]).find(n=>n.props?.className==='personal-automation-card');assert.ok(card,'saved automation remains visible even if final model response is empty');card.props.onClick();assert.equal(opened,record);
function content(node){if(typeof node==='string'||typeof node==='number')return String(node);if(!node || typeof node!=='object')return '';return [node?.props?.children].flat(Infinity).map(content).join('');}
const Panel=await component('PersonalAutomationsPanel.jsx','PersonalAutomationsPanel',{notifications:[],automations:[60,90,3600].map((intervalSeconds,i)=>({...record,automationId:`pa_${i}`,employeeId:'employee',intervalSeconds,expiresAt:'2099-01-01T00:00:00.000Z',maxRuns:3,runCount:0,revision:1}))});
const panel=Panel({}), panelNodes=nodes(panel), text=content(panel);
assert.ok(!panelNodes.some(n=>['form','input','select','textarea'].includes(n.type)),'management has no manual creation inputs');
assert.ok(!panelNodes.some(n=>n.type==='button' && /创建|新建/.test(content(n))),'creation remains a conversation action');
for(const phrase of ['收起或隐藏时继续执行','退出或断连后停止新任务','不补跑错过的任务','每 1 分钟','每 90 秒','每 1 小时'])assert.ok(text.includes(phrase),phrase);
const selectedPanel=Panel({selectedAutomationId:'pa_1'});
const selectedRows=nodes(selectedPanel).filter(n=>n.type==='article' && n.props?.className?.includes('is-selected-automation'));
assert.equal(selectedRows.length,1,'the selected automation is visibly distinguished from sibling definitions');
assert.match(content(selectedRows[0]),/每 90 秒/,'selection identifies the exact definition, not merely the employee');
assert.ok(selectedRows[0].props.ref,'the selected row is the scroll target');
const workbenchRows=scope=>nodes(Panel({workbenchScope:scope})).filter(n=>n.type==='article');
assert.equal(workbenchRows({employeeIds:['employee'],taskIds:['task_one']}).length,3,'current task retains its own schedules');
assert.equal(workbenchRows({employeeIds:['employee'],taskIds:['task_other']}).length,0,'same employee schedules from another task stay hidden');
assert.equal(workbenchRows({employeeIds:['other_employee'],taskIds:['task_one']}).length,0,'same task reference cannot cross employee scope');
console.log('Conversation automation card: Center authority, navigation, no manual creation, presence copy and interval units passed (component logic, not visual acceptance).');
