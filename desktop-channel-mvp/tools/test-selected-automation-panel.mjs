import { sortedAutomations, automationNextLabel, automationTaskTitle } from "../src/lib/automationCalendar.js";
import { matchesWorkbenchAutomation, workbenchScheduledRules } from "../src/lib/workbenchAutomationScope.js";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import vm from "node:vm";
import { transformWithEsbuild } from "vite";

const source = await fs.readFile(new URL("../src/components/PersonalAutomationsPanel.jsx", import.meta.url), "utf8");
const { code } = await transformWithEsbuild(source, "panel.jsx", { loader: "jsx", format: "cjs", jsx: "automatic" });
let index = 0, slots = [], effects = [], calls = [], runStatus = "running", lateDetail, resolveTaskDetail;
const react = {
  useState(initial) { const n = index++; if (!(n in slots)) slots[n] = typeof initial === "function" ? initial() : initial; return [slots[n], value => { slots[n] = typeof value === "function" ? value(slots[n]) : value; }]; },
  useRef(initial) { const n = index++; if (!(n in slots)) slots[n] = { current: initial }; return slots[n]; },
  useEffect(fn) { effects.push(fn); },
};
const jsx = (type, props) => ({ type, props });
const sandbox = { module: { exports: {} }, Date, window: { setInterval: () => 1, clearInterval() {} }, document: { visibilityState: "visible" }, require(name) {
  if (name === "../lib/automationCalendar.js") return { sortedAutomations, automationNextLabel, automationTaskTitle };
  if (name === "react") return react;
  if (name === "react/jsx-runtime") return { jsx, jsxs: jsx };
  if (name === "@phosphor-icons/react") return new Proxy({}, { get: (_, key) => key });
  if (name === "../lib/workbenchAutomationScope.js") return { matchesWorkbenchAutomation };
  if (name === "./AutomationCalendar.jsx") return { AutomationCalendar: "Calendar" };
  throw new Error(name);
} };
vm.runInNewContext(code, sandbox);
const rules = [{ automationId: "selected", sourceTaskId: "task-a", lastTaskId: "run-a", employeeId: "worker", state: "active", runCount: 1, maxRuns: 3, intervalSeconds: 120, expiresAt: "2026-10-09T00:00:00Z" }, { automationId: "other", sourceTaskId: "task-b", lastTaskId: "run-b", employeeId: "worker", state: "active", runCount: 1, maxRuns: 3, intervalSeconds: 120, expiresAt: "2026-10-09T00:00:00Z" }];
const desktopApi = { async personalAutomations(request) {
  calls.push(request);
  if (request.action === "list") return { ok: true, automations: rules, notifications: [{ automationId: "selected", taskId: "selected-run", status: "failed" }, { automationId: "other", taskId: "other-run", status: "completed" }] };
  if (request.action === "detail") {
    const result = { ok: true, automation: rules.find(rule => rule.automationId === request.automationId), runs: [{ taskId: "selected-run", scheduledFor: "2026-10-08T01:00:00Z", status: runStatus }] };
    if (calls.filter(call => call.action === "detail").length === 1) return new Promise(resolve => { lateDetail = () => resolve({ ...result, runs: [{ ...result.runs[0], status: "obsolete-run" }] }); });
    return result;
  }
  throw new Error("read-only test unexpectedly dispatched a change");
}, getMyTaskDetail: async () => new Promise(resolve => { resolveTaskDetail = resolve; }) };
const props = { desktopApi, selectedOnly: true, selectedAutomationId: "selected", tasks: [], renderTaskDetail: () => jsx("TaskDetails", {}) };
const render = () => { index = 0; effects = []; return sandbox.module.exports.PersonalAutomationsPanel(props); };
const nodes = tree => tree == null || tree === false ? [] : Array.isArray(tree) ? tree.flatMap(nodes) : typeof tree === "object" ? [tree, ...nodes(tree.props?.children)] : [tree];
render();
const cleanups = effects.map(fn => fn()).filter(fn => typeof fn === "function");
await new Promise(setImmediate);
let tree = render();
let text = nodes(tree).filter(item => typeof item === "string").join(" ");
assert.ok(text.includes("执行失败"));
assert.ok(!text.includes("执行完成"));
assert.equal(nodes(tree).filter(item => item.type === "article").length, 1);
assert.equal(nodes(tree).some(item => item.type === "Calendar"), false);
assert.ok(text.includes("已启用"));
assert.ok(text.includes("running"));
lateDetail();
await new Promise(setImmediate);
text = nodes(render()).filter(item => typeof item === "string").join(" ");
assert.ok(!text.includes("obsolete-run"), "older same-rule response cannot overwrite a newer refresh");
const initialDetails = calls.filter(call => call.action === "detail").length;
runStatus = "completed";
await nodes(tree).find(item => item.props?.["aria-label"] === "刷新定时任务").props.onClick();
tree = render();
text = nodes(tree).filter(item => typeof item === "string").join(" ");
assert.ok(text.includes("completed"));
assert.ok(calls.filter(call => call.action === "detail").length > initialDetails, "refresh reads actual run records, not only rule definitions");
assert.ok(calls.every(call => call.action === "list" || (call.action === "detail" && call.automationId === "selected")));
// A late run-detail response cannot cross a rule change within the same workspace scope.
const pendingRunRead = nodes(tree).find(item => item.props?.className === "personal-automation-action is-run").props.onClick();
await new Promise(setImmediate);
props.selectedAutomationId = "other";
render(); effects[0](); render(); effects[2]();
await new Promise(setImmediate);
resolveTaskDetail({ok:true,detail:{}});
await pendingRunRead;
tree = render();
assert.ok(!nodes(tree).some(item => item.type === "TaskDetails"), "old rule task detail must not appear under newly selected rule");
// Closing a rule clears its local records, fences late reads, and refresh does not reopen it.
const historyButton = nodes(tree).find(item => item.props?.className === "personal-automation-action is-history");
assert.equal(historyButton.props["aria-expanded"], true);
historyButton.props.onClick();
render();
cleanups[2]?.();
effects[2]();
tree = render();
assert.ok(!nodes(tree).some(item => item.props?.["aria-label"] === "定时运行记录"));
const beforeClosedRefresh = calls.filter(call => call.action === "detail").length;
await nodes(tree).find(item => item.props?.["aria-label"] === "刷新定时任务").props.onClick();
assert.equal(calls.filter(call => call.action === "detail").length, beforeClosedRefresh, "refresh leaves collapsed records closed");
assert.ok(!nodes(render()).some(item => item.props?.["aria-label"] === "定时运行记录"));
props.selectedOnly = false;
props.workbenchScope = {employeeIds:["worker"],taskIds:["task-a"],employeeNames:{worker:"测试员工"}};
text = nodes(render()).filter(item => typeof item === "string").join(" ");
assert.equal(nodes(render()).filter(item => item.type === "article").length, 1, "same employee unrelated task rules stay hidden");
assert.ok(text.includes("执行失败") && !text.includes("执行完成"));
assert.ok(!text.includes("周历") && !text.includes("列表"));
props.workbenchScope = {...props.workbenchScope,taskIds:["run-a"]};
assert.equal(nodes(render()).filter(item => item.type === "article").length, 1, "exact canonical latest run links back to its rule");
props.workbenchScope = {...props.workbenchScope,taskIds:["unrelated"]};
text = nodes(render()).filter(item => typeof item === "string").join(" ");
assert.equal(nodes(render()).filter(item => item.type === "article").length, 0);
assert.ok(text.includes("暂未找到与当前任务明确关联"));
props.workbenchScope = {...props.workbenchScope,taskIds:[]};
assert.equal(nodes(render()).filter(item => item.type === "article").length, 0, "empty current task never falls back to all rules");
cleanups.forEach(fn => fn());
props.workbenchScope = null;
props.selectedOnly = false;
tree = render();
assert.equal(nodes(tree).find(item => item.type === "details").props.open, undefined, "results start collapsed");
nodes(tree).find(item => item.type === "button" && item.props.children === "周历").props.onClick();
assert.equal(nodes(render()).some(item => item.props?.className === "automation-results"), false, "week view must not stack unread results below the calendar");
nodes(render()).find(item => item.type === "button" && item.props.children === "列表").props.onClick();
assert.ok(nodes(render()).some(item => item.props?.className === "automation-results"), "returning to list preserves unread notifications");
console.log("Selected automation panel scopes rules/notifications, preserves read-only entry and refreshes actual runs");

const badgeScope = {employeeIds:["worker"],taskIds:["task-a"]};
const badgeNow = Date.parse("2026-10-08T00:00:00Z");
assert.deepEqual(workbenchScheduledRules(rules, badgeScope, badgeNow).map(rule => rule.automationId), ["selected"]);
assert.equal(workbenchScheduledRules(rules, {...badgeScope, taskIds:[]}, badgeNow).length, 0);
for (const state of ["disabled", "exhausted"]) assert.equal(workbenchScheduledRules([{...rules[0],state}], badgeScope, badgeNow).length, 0);
for (const state of ["paused", "attention_required"]) assert.equal(workbenchScheduledRules([{...rules[0],state}], badgeScope, badgeNow).length, 1);
assert.equal(workbenchScheduledRules(rules, badgeScope, Date.parse("2026-10-10T00:00:00Z")).length, 0);

// Returning to the cockpit uses its existing actor-scoped snapshot while list refresh is pending.
slots = []; index = 0;
props.selectedOnly = false; props.workbenchScope = null; props.selectedAutomationId = "";
props.initialAutomations = rules;
let resolveRefresh;
props.desktopApi = { personalAutomations: () => new Promise(resolve => {resolveRefresh = resolve;}) };
tree = render();
assert.equal(nodes(tree).filter(n => n.type === "article").length, 2);
assert.ok(!nodes(tree).some(n => n.props?.role === "status"), "known list does not flash initial loading");
const cachedCleanup = effects[1]();
resolveRefresh({ok:false});
await new Promise(setImmediate);
tree = render();
assert.equal(nodes(tree).filter(n => n.type === "article").length, 2, "refresh failure preserves known rules");
assert.ok(nodes(tree).some(n => n.props?.role === "alert"));
assert.ok(nodes(tree).filter(n => n.props?.className === "personal-automation-action is-danger").every(n => n.props.disabled));
cachedCleanup();
slots = []; props.initialAutomations = [];
tree = render();
assert.ok(nodes(tree).includes("还没有个人定时任务。"), "known empty list is loaded");
console.log("Cockpit schedule snapshot prevents reentry loading and retains failed-refresh rows safely");
