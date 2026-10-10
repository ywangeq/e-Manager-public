import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import { transformWithEsbuild } from "vite";
import { localCalendarWeek } from "../src/lib/localCalendarWeek.js";
import { meetingWeek } from "../src/lib/calendarMeetings.js";
import * as calendar from "../src/lib/automationCalendar.js";

process.env.TZ = "Asia/Shanghai";
const source = await readFile(new URL("../src/components/AutomationCalendar.jsx", import.meta.url), "utf8");
const { code } = await transformWithEsbuild(source, "AutomationCalendar.jsx", {loader:"jsx",format:"cjs",jsx:"automatic"});
const slots = [], listeners = new Map(), timers = new Map();
let cursor = 0, cleanups = [], timerId = 0;
let calendarState={phase:"not_synced",snapshots:[]};
const jsx = (type, props) => ({type,props});
const module = {exports:{}};
vm.runInNewContext(code, {
  module, exports:module.exports, document:{body:{}},
  setTimeout: callback => {timers.set(++timerId,callback);return timerId;}, clearTimeout: id => timers.delete(id),
  window:{innerWidth:320,innerHeight:600,addEventListener:(name,fn)=>listeners.set(name,fn),removeEventListener:name=>listeners.delete(name)},
  require: name => name === "react" ? {
    useState(initial) {const i=cursor++;if (!(i in slots)) slots[i]=initial;return [slots[i],next=>{slots[i]=typeof next === "function" ? next(slots[i]) : next;}];},
    useRef(initial) {const i=cursor++;return slots[i] ||= {current:initial};}, useId:()=>"calendar-details",
    useEffect(effect) {const i=cursor++;if (!(i in slots)) {slots[i]=true;const cleanup=effect();if(cleanup)cleanups.push(cleanup);}},
  } : name === "react-dom" ? {createPortal:value=>value}
    : name === "react/jsx-runtime" ? {jsx,jsxs:jsx}
      : name.includes("automationCalendar.js") ? calendar : name.includes("localCalendarWeek.js") ? {localCalendarWeek} : name.includes("calendarMeetings.js") ? {meetingWeek} : name.includes("useCalendarMeetings.js") ? {useCalendarMeetings:()=>calendarState} : name.includes("AutomationSettingsDialog.jsx") ? {AutomationSettingsDialog:"meeting-dialog"} : {useCockpitMotion:()=>{}},
});
const now = Date.parse("2026-09-30T00:00:00Z");
const rule = {automationId:"daily",employeeId:"employee-a",sourceTaskId:"source-a",state:"active",startAt:"2026-09-30T01:00:00Z",expiresAt:"2026-10-03T00:00:00Z",intervalSeconds:86400,runCount:0,maxRuns:1};
const tasks = [{id:"source-a",employeeId:"employee-a",employeeName:"Report assistant",taskTitle:"Daily report"}];
const selected = [];
let localRule=null,localSettingsOpened=0;
let historyOpens = 0;
function nodes(tree) {return Array.isArray(tree) ? tree.flatMap(nodes) : tree && typeof tree === "object" ? [tree,...nodes(tree.props?.children)] : [];}
function render(automations=[rule],visibleTasks=tasks) {cursor=0;return nodes(module.exports.AutomationCalendarView({automations,tasks:visibleTasks,now,selectedId:"",onSelect:id=>selected.push(id),localRule,onLocalSettings:()=>localSettingsOpened++,onShowHistory:()=>historyOpens++}));}
const eventButton = tree => tree.find(node=>node.props?.className?.includes("is-automation"));
const tooltip = tree => tree.find(node=>node.props?.role === "tooltip");
const target = {getBoundingClientRect:()=>({left:290,bottom:550})};
assert.equal(source.includes("历史记录在任务详情查看"),false,"past empty days must not imply existing history");
const historyButton = tree => tree.find(node=>node.type === "button" && node.props.children === "运行记录");
assert.equal(historyButton(render()),undefined,"calendar toolbar remains minimal");
assert.equal(historyButton(render([])),undefined,"no rules must not advertise unavailable history");
eventButton(render()).props.onFocus({currentTarget:target});
let tree = render();
assert.equal(eventButton(tree).props["aria-describedby"],"calendar-details");
assert.equal(tooltip(tree).props.style.left,32);
assert.ok(tooltip(tree).props.style.bottom > 0,"near bottom opens above");
assert.equal(tooltip(tree).props.children[0].props.children,"Daily report");
assert.equal(tooltip(render([],tasks)),undefined,"removed rule hides stale details");
assert.equal(tooltip(render([rule],[])).props.children[0].props.children,"任务名称暂不可用","unavailable source cannot leak cached title");
eventButton(render()).props.onKeyDown({key:"Escape"});
assert.equal(tooltip(render()),undefined);
eventButton(render()).props.onMouseEnter({currentTarget:target});
eventButton(render()).props.onMouseLeave();
assert.equal(tooltip(render()),undefined,"leaving the source immediately dismisses passive tooltip");
assert.equal(timers.size,0);
for (const callback of timers.values()) callback();
assert.equal(tooltip(render()),undefined);
eventButton(render()).props.onFocus({currentTarget:target});
listeners.get("scroll")();
assert.equal(tooltip(render()),undefined);
eventButton(render()).props.onFocus({currentTarget:target});
eventButton(render()).props.onClick({currentTarget:target});
assert.deepEqual(selected,["daily"]);
assert.equal(tooltip(render()),undefined);
calendarState={phase:"ready",snapshots:[{start:"2026-09-29T16:00:00Z",end:"2026-09-30T16:00:00Z",fetchedAt:"2026-09-30T00:00:00Z",events:[{eventRef:"synthetic-meeting",title:"Synthetic meeting",start:"2026-09-30T02:00:00Z",end:"2026-09-30T03:00:00Z",calendarUrl:"https://applink.feishu.cn/client/calendar/event/detail?key=synthetic"}]}]};
const meetingButton=tree=>tree.find(node=>node.props?.className==="automation-calendar-event is-meeting");
assert.ok(meetingButton(render()),"successful real-read projection appears alongside task cards");
meetingButton(render()).props.onFocus({currentTarget:target});
assert.equal(tooltip(render()).props.children[0].props.children,"Synthetic meeting");
meetingButton(render()).props.onClick({currentTarget:target});assert.deepEqual(selected,["daily"],"meeting never selects a fake automation rule");
assert.ok(render().find(node=>node.type==="meeting-dialog"),"meeting click opens an actionable dialog");
assert.equal(tooltip(render()),undefined);
calendarState={phase:"not_synced",snapshots:[]};assert.equal(render().find(node=>node.type==="meeting-dialog"),undefined,"actor removal closes private meeting dialog");assert.equal(tooltip(render()),undefined,"actor/disconnect removes private meeting detail");
localRule={configured:true,enabled:true,employeeName:"个人工作助理",nextAt:"2026-09-30T01:00:00Z",intervalMinutes:720,windowStart:0,windowEnd:0};
const localButton=tree=>tree.find(node=>node.props?.className?.includes("is-automation")&&node.props?.children?.[1]?.props?.children?.[1]?.props?.children==="个人工作助理");
assert.ok(localButton(render()),"local assistant schedule is a dated calendar card");
localButton(render()).props.onClick();assert.equal(localSettingsOpened,1);assert.deepEqual(selected,["daily"],"local card opens own shared dialog, never a fabricated Center automation");
localRule={...localRule,enabled:false,nextAt:null};assert.ok(localButton(render()).props.className.includes("is-disabled"));
localButton(render()).props.onFocus({currentTarget:target});assert.equal(tooltip(render()).props.children[2].props.children,"已暂停");
localRule=null;assert.equal(localButton(render()),undefined,"lost local actor projection hides old private rule");
cleanups.forEach(fn=>fn());assert.equal(listeners.size,0);
console.log("Calendar detail hover/focus, Escape, bounds, exact source, stale removal and click destination passed");
