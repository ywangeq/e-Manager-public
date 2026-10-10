import { cockpitRecordTime, cockpitRecordTimeLabel, groupStepProgress } from "../src/lib/cockpitProgressPresentation.js";
import { cockpitStatusTone } from "../src/lib/cockpitStatusTone.js";
import { createAutomationRunReadCache } from "../src/lib/automationRunReadCache.js";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import { transformWithEsbuild } from "vite";
import { automationTaskTitle, upcomingAutomations } from "../src/lib/automationCalendar.js";
import { cockpitGoalStatus, cockpitGroupSteps, cockpitOverview, cockpitAttention, cockpitTaskTitle, cockpitWorkItems, cockpitFilterItems } from "../src/lib/personalCockpitModel.js";

const tasks = [
  { id: "running", status: "running", employeeName: "A" },
  { id: "queued", status: "queued", employeeName: "A" },
  { id: "done", status: "completed", finishedAt: "2026-09-25T02:00:00Z" },
  { id: "older", status: "completed", finishedAt: "2026-09-24T02:00:00Z" },
];
const goals = [
  { goalId: "awaiting", status: "run", projection: { status: "awaiting_review", executionUpdatedAt: "2026-09-29T08:00:00.000Z", steps: [{ status: "completed" }, { status: "completed" }] } },
  { goalId: "draft", status: "draft" },
  { goalId: "running", status: "run", projection: { status: "running" } },
];
const automations = [{ automationId: "needs-attention", state: "attention_required" }, { automationId: "scheduled", state: "active" }];
const view = cockpitOverview({ tasks, goals, automations });
assert.deepEqual(view.runningTasks.map((task) => task.id), ["running"]);
assert.deepEqual(view.queuedTasks.map((task) => task.id), ["queued"]);
assert.deepEqual(view.completedTasks.map((task) => task.id), ["done", "older"]);
assert.deepEqual(view.draftGoals.map((goal) => goal.goalId), ["draft"]);
assert.deepEqual(view.attentionAutomations.map((automation) => automation.automationId), ["needs-attention"]);
assert.deepEqual(view.goalWarnings.map((goal) => goal.goalId), ["awaiting"]);
assert.equal(cockpitGoalStatus(goals[0]), "awaiting_review");
assert.equal(cockpitOverview().completedTasks.length, 0);
assert.deepEqual(cockpitGroupSteps(goals).map(({ step }) => step.status), ["completed", "completed"]);

const source = await readFile(new URL("../src/components/PersonalCockpit.jsx", import.meta.url), "utf8");
const { code } = await transformWithEsbuild(source, "PersonalCockpit.jsx", { loader: "jsx", format: "cjs", jsx: "automatic" });
const slots = [];
const effects = [];
let index = 0;
let dirty = false;
let pending = [];
let focusListener = null;
const react = {
  useState(value) {
    const slot = index++;
    if (!(slot in slots)) slots[slot] = typeof value === "function" ? value() : value;
    return [slots[slot], (next) => { slots[slot] = typeof next === "function" ? next(slots[slot]) : next; dirty = true; }];
  },
  useMemo: (compute) => compute(),
  useRef: (value) => {
    const slot = index++;
    if (!(slot in slots)) slots[slot] = { current: value };
    return slots[slot];
  },
  useEffect(effect, dependencies) {
    const slot = index++;
    const previous = effects[slot];
    if (previous && dependencies.every((value, offset) => Object.is(value, previous.dependencies[offset]))) return;
    pending.push({ slot, effect, dependencies });
  },
};
const module = { exports: {} };
const jsx = (type, props) => typeof type === "function" ? type(props) : ({ type, props });
const context = {
  module, exports: module.exports,
  window: {
    setInterval: () => 1, clearInterval() {},
    addEventListener: (event, listener) => { if (event === "focus") focusListener = listener; },
    removeEventListener: (event, listener) => { if (event === "focus" && focusListener === listener) focusListener = null; },
  },
  require: (name) => name === "react" ? react : name === "react/jsx-runtime" ? { jsx, jsxs: jsx }
    : name.includes("automationRunReadCache") ? { createAutomationRunReadCache }
    : name.includes("automationCalendar") ? {automationTaskTitle, upcomingAutomations}
    : name.includes("useSubsystemConnections") ? { useSubsystemConnections: () => ({phase: "ready", connections: []}) }
    : name.includes("SubsystemConnections") ? { SubsystemConnections: "SubsystemConnections" }
    : name.includes("useCockpitLayout") ? { useCockpitLayout: () => ({ rootRef: { current: null }, separator: () => ({}) }) }
    : name.includes("useCockpitMotion") ? {useCockpitMotion() {}}
    : name.includes("CockpitTaskWorkspace") ? { CockpitTaskWorkspace: "CockpitTaskWorkspace" }
    : name.includes("CockpitClock") ? { CockpitClock: "CockpitClock" }
    : name.includes("CockpitMetricCard") ? { CockpitMetricCard: props => ({ type: "button", props }) }
    : name.includes("useCockpitSentinelState") ? { useCockpitSentinelState: () => ({ activity: "idle", paused: false, setPaused() {}, wakeSession: { current: false } }) }
    : name.includes("CockpitSentinel") ? { CockpitSentinel: "CockpitSentinel" }
    : name.includes("CockpitContentWorkspace") ? { CockpitContentWorkspace: "CockpitContentWorkspace" }
    : name.includes("employeeCharacters") ? { employeeCharacterFor: () => null }
    : name.includes("personalCockpitModel") ? { cockpitGoalStatus, cockpitGroupSteps, cockpitOverview, cockpitAttention, cockpitTaskTitle, cockpitWorkItems, cockpitFilterItems }
      : name.includes("cockpitProgressPresentation") ? { cockpitRecordTime, cockpitRecordTimeLabel, groupStepProgress }
    : name.includes("cockpitStatusTone") ? { cockpitStatusTone }
    : name.includes("groupRunHistory") ? { runStatusLabel: (status) => status }
        : name.includes("ProjectGroupWorkspace.jsx") ? { ProjectGroupWorkspace: "ProjectGroupWorkspace" }
          : name === "@phosphor-icons/react" ? new Proxy({}, { get: (_target, key) => key }) : {},
  Date, Intl,
};
vm.runInNewContext(code, context);
function nodes(tree) {
  if (Array.isArray(tree)) return tree.flatMap(nodes);
  return tree && typeof tree === "object" ? [tree, ...nodes(tree.props?.children)] : [];
}
function text(tree) {
  if (Array.isArray(tree)) return tree.map(text).join("");
  if (typeof tree === "string" || typeof tree === "number") return String(tree);
  return tree && typeof tree === "object" ? text(tree.props?.children) : "";
}
const settled = async (authenticated = true) => { await new Promise((resolve) => setImmediate(resolve)); if (dirty) render(currentApi, authenticated); };
function render(api = currentApi, authenticated = true, enabled = true) {
  currentApi = api;
  index = 0;
  dirty = false;
  const value = module.exports.useCockpitSources(api, authenticated, enabled);
  for (const item of pending.splice(0)) {
    effects[item.slot]?.cleanup?.();
    effects[item.slot] = { dependencies: item.dependencies, cleanup: item.effect() };
  }
  return value;
}
function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

let currentApi;
const goalSlow = deferred();
const automationFast = deferred();
const api = {
  groupStudio: { history: () => goalSlow.promise },
  personalAutomations: () => automationFast.promise,
};
render(api);
automationFast.resolve({ ok: true, automations: [{ automationId: "schedule-1", state: "active" }] });
await settled();
assert.equal(render().automationPhase, "ready", "one source should be usable while the other remains pending");
assert.equal(render().goalPhase, "loading");
goalSlow.resolve({ ok: true, items: [{ goalId: "goal-1", status: "draft" }] });
await settled();
assert.equal(render().goals[0].goalId, "goal-1");

const pendingGoals = deferred();
const pendingAutomations = deferred();
let goalReads = 0, automationReads = 0;
api.groupStudio.history = () => { goalReads++; return pendingGoals.promise; };
api.personalAutomations = () => { automationReads++; return pendingAutomations.promise; };
focusListener();
focusListener();
render().refresh();
await settled();
assert.equal(goalReads, 1, "focus and manual refresh share the pending goal read");
assert.equal(automationReads, 1, "focus and manual refresh share the pending automation read");
assert.equal(render().goalPhase, "ready");
assert.equal(render().goals[0].goalId, "goal-1", "pending background refresh never blanks loaded goals");
pendingGoals.resolve({ ok: true, items: [{ goalId: "goal-2", status: "draft" }] });
pendingAutomations.resolve({ ok: true, automations: [{ automationId: "schedule-1", state: "active" }] });
await settled();
assert.equal(render().goals[0].goalId, "goal-2");

render(api, true, false).refresh();
await new Promise(resolve => setImmediate(resolve));
assert.equal(goalReads, 1, "pausing cockpit polling for the Group workspace adds no history read");
assert.equal(render(api, true, false).goals[0].goalId, "goal-2", "paused polling retains the same actor snapshot");
render(api);
await settled();

api.groupStudio.history = async () => ({ groupIpcError: "desktop_group_actor_changed" });
focusListener();
await settled();
assert.equal(render().goalPhase, "error");
assert.equal(render().goals.length, 0, "failed refresh must not show another actor's old Goal");
assert.equal(render().automations.length, 1, "the independent automation source stays available");

const oldActor = deferred();
const slowAutomation = deferred();
api.groupStudio.history = () => oldActor.promise;
api.personalAutomations = () => slowAutomation.promise;
focusListener();
await settled();
assert.equal(render().goalPhase, "loading");
assert.equal(render().automations.length, 1, "background refresh preserves the current actor schedule while pending");
assert.equal(render().automationPhase, "ready");
assert.equal(render(api, false).goals.length, 0, "logout hides old actor data on the same render");
oldActor.resolve({ ok: true, items: [{ goalId: "old-actor", status: "draft" }] });
slowAutomation.resolve({ ok: true, automations: [{ automationId: "old-actor-schedule" }] });
await settled(false);
assert.equal(render(api, false).goals.length, 0, "late old-actor response cannot restore a logged-out Goal");
assert.equal(render(api, false).automations.length, 0, "late old-actor response cannot restore a logged-out schedule");

slots.length = 0;
effects.length = 0;
pending = [];
const cockpitApi = {
  groupStudio: { history: async () => ({ ok: true, items: [
    { goalId: "draft-goal", title: "待采纳目标", status: "draft" },
    { goalId: "accepted-goal", title: "已验收目标", status: "run", projection: { status: "accepted", acceptance: { decidedAt: "2026-09-29T01:00:00Z" }, steps: [] } },
    { goalId: "awaiting-goal", title: "待收尾目标", status: "run", projection: { status: "awaiting_review", executionUpdatedAt: "2026-09-29T08:00:00.000Z", steps: [{ status: "completed" }, { status: "completed" }] } },
  ] }) },
  personalAutomations: async () => ({ ok: true, automations: [
    { automationId: "attention-automation", employeeId: "employee-a", state: "attention_required", intervalSeconds: 3600 },
  ] }),
};
const myTasks = {
  phase: "ready", page: { tasks: [
    { id: "active-task", employeeName: "A", status: "running" },
    { id: "completed-task", employeeName: "A", status: "completed", finishedAt: "2026-09-25T02:00:00Z" },
  ] }, refresh: async () => {},
};
function renderCockpit(expanded = true, extraProps = {}) {
  index = 0;
  dirty = false;
  const tree = nodes(module.exports.PersonalCockpit({ expanded, authenticated: true, actor: { name: "测试用户" }, desktopApi: cockpitApi, myTasks, ...extraProps }));
  for (const item of pending.splice(0)) {
    effects[item.slot]?.cleanup?.();
    effects[item.slot] = { dependencies: item.dependencies, cleanup: item.effect() };
  }
  return tree;
}
function cockpitButton(className, phrase) {
  const button = renderCockpit().find((node) => node.type === "button" && node.props?.className === className && text(node).includes(phrase));
  assert.ok(button, `cockpit button: ${phrase}`);
  return button;
}
renderCockpit();
await new Promise((resolve) => setImmediate(resolve));
const cockpit = renderCockpit();
assert.equal(cockpit.filter(n => n.props?.className === "cockpit-stat-icon").length, 4);
const connectionPreview = cockpit.find(n => n.type === "SubsystemConnections");
assert.equal(connectionPreview.props.compact, true);
connectionPreview.props.onOpen("lark-cli-openapi");
let subsystemPage = renderCockpit();
assert.equal(subsystemPage.find(n => n.props?.["aria-label"] === "子系统").props["aria-current"], "page");
assert.equal(subsystemPage.find(n => n.props?.["aria-label"] === "我的内容").props["aria-current"], undefined);
assert.equal(subsystemPage.find(n => n.props?.["aria-label"] === "我的内容").props.className, "");
assert.equal(subsystemPage.filter(n => n.type === "SubsystemConnections").length, 1);
assert.equal(subsystemPage.find(n => n.type === "SubsystemConnections").props.initialSelectedId, "lark-cli-openapi");
assert.deepEqual(subsystemPage.find(n => n.type === "SubsystemConnections").props.source, connectionPreview.props.source);
subsystemPage.find(n => n.props?.["aria-label"] === "驾驶舱").props.onClick();
renderCockpit();

assert.ok(cockpit.some(n => n.type === "time" && n.props.dateTime === "2026-09-29T08:00:00.000Z" && text(n).includes("执行更新")));
const employeeProps = { bootstrapReady: true, catalogPhase: "success", employees: [
  { id: "available", access: { selectable: true, callable: true } },
  { id: "available", access: { selectable: true, callable: true } },
  { id: "unavailable", access: { selectable: true, callable: false } },
  { id: "denied", access: { selectable: false, callable: true } },
  { id: "unknown" },
] };
const employeeCount = props => text(renderCockpit(true, props).find(node => node.props?.className === "cockpit-employee-count"));
assert.equal(employeeCount(employeeProps), "可用员工 1");
assert.equal(employeeCount({ ...employeeProps, employees: [] }), "可用员工 0");
assert.equal(employeeCount({ ...employeeProps, bootstrapReady: false, catalogPhase: "loading" }), "可用员工 —正在同步");
assert.equal(employeeCount({ ...employeeProps, bootstrapReady: false, catalogPhase: "error" }), "可用员工 —暂时无法获取");
assert.equal(employeeCount({ ...employeeProps, desktopApi: null }), "可用员工 —未连接");
let catalogRefreshes = 0;
renderCockpit(true, { onRefreshCatalog: () => { catalogRefreshes += 1; } }).find(node => node.props?.["aria-label"] === "刷新概览").props.onClick();
assert.equal(catalogRefreshes, 1);
await new Promise(resolve => setImmediate(resolve));
renderCockpit();
await new Promise(resolve => setImmediate(resolve));
renderCockpit();
assert.match(text(cockpit.find((node) => node.props?.className === "cockpit-activity-rail")), /待收尾目标.*awaiting_review/s);
assert.ok(cockpit.some(node => node.type === "CockpitContentWorkspace" && node.props.compact), "recent deliveries use the existing authorized content path");

cockpitButton("cockpit-attention-row", "待采纳目标").props.onClick();
let workspace = renderCockpit().find((node) => node.type === "ProjectGroupWorkspace");
assert.equal(workspace.props.initialGoalId, "draft-goal", "a selected draft opens its own Group Goal");
workspace.props.onBack();
renderCockpit().find(node => node.type === "button" && node.props?.["aria-label"] === "定时任务").props.onClick();
let taskView = renderCockpit();
await new Promise((resolve) => setImmediate(resolve));
taskView = renderCockpit();
let taskWorkspace = taskView.find((node) => node.type === "CockpitTaskWorkspace");
assert.equal(taskWorkspace.props.filter, "automations");
assert.equal(taskWorkspace.props.selectedAutomation, null);
assert.ok(!taskView.some((node) => node.type === "MyTasksSheet"));
renderCockpit().find((node) => node.type === "button" && text(node).includes("驾驶舱")).props.onClick();
const goalRows = renderCockpit().find(node => node.props?.className === "cockpit-activity-list");
nodes(goalRows).find(node => node.type === "button" && text(node).includes("待收尾目标")).props.onClick();
workspace = renderCockpit().find((node) => node.type === "ProjectGroupWorkspace");
assert.equal(workspace.props.initialGoalId, "awaiting-goal", "awaiting review is actionable, never a false empty inbox");
workspace.props.onBack();
const taskList = renderCockpit().find((node) => node.props?.className === "cockpit-activity-list");
assert.ok(taskList, "persistent task rail exists");
nodes(taskList).find(node => node.type === "button" && text(node).includes("running")).props.onClick();
taskWorkspace = renderCockpit().find((node) => node.type === "CockpitTaskWorkspace");
assert.equal(taskWorkspace.props.selectedTaskId, "active-task");
assert.equal(taskWorkspace.props.myTasks, myTasks, "reuse canonical details and actions");
renderCockpit().find((node) => node.type === "button" && text(node).includes("驾驶舱")).props.onClick();
renderCockpit();
await new Promise(resolve => setImmediate(resolve));
const completedList = renderCockpit().find((node) => node.type === "CockpitContentWorkspace" && node.props.compact);
completedList.props.onOpenTask("completed-task");
taskWorkspace = renderCockpit().find((node) => node.type === "CockpitTaskWorkspace");
assert.equal(taskWorkspace.props.filter, "recent");
assert.equal(taskWorkspace.props.selectedTaskId, "completed-task");
renderCockpit().find(node => node.type === "button" && text(node).includes("驾驶舱")).props.onClick();
renderCockpit();
await new Promise(resolve => setImmediate(resolve));
const acceptedList = renderCockpit().find(node => node.props?.className === "cockpit-activity-list");
nodes(acceptedList).find(node => node.type === "button" && text(node).includes("已验收目标")).props.onClick();
workspace = renderCockpit().find(node => node.type === "ProjectGroupWorkspace");
assert.equal(workspace.props.initialGoalId, "accepted-goal", "accepted delivery opens its exact Goal, never another task");
workspace.props.onBack();
console.log("personal cockpit projection, source fencing and native task-entry checks passed");

// A Group owns its projected Runtime tasks; show one goal and retain unrelated tasks.
const inboxGoals = ["draft", "awaiting_review", "blocked", "failed", "reconcile_required", "resume_required"].map((status) => ({ goalId: status, projection: { status, steps: status === "blocked" ? [{taskId: "group-step", status: "blocked"}] : [] } }));
const inboxTasks = [{id: "group-step", status: "blocked"}, {id: "independent", status: "failed", taskTitle: "季度报告", employeeName: "分析员"}, {id: "done", status: "completed"}];
const inbox = cockpitAttention({goals: inboxGoals, tasks: inboxTasks, automations});
assert.equal(inbox.length, 1);
assert.ok(!inbox.some(row => row.item.id === "group-step"));
const work = cockpitWorkItems({goals: inboxGoals, tasks: inboxTasks, automations});
assert.equal(work.length, 9);
assert.deepEqual(new Set(cockpitFilterItems(work, "attention").map(row => row.key)), new Set(inbox.map(row => row.key)));
assert.equal(cockpitFilterItems(work, "all", "季度")[0].item.id, "independent");
assert.equal(cockpitFilterItems(work, "all", "分析员")[0].title, "季度报告");
assert.deepEqual(cockpitFilterItems(work, "recent").map(row => row.item.id || row.item.goalId), ["failed", "independent", "done"]);
for (const status of ["failed", "timeout", "timed_out", "lost", "rejected", "canceled", "completed"]) {
  const history = { tasks: [{id: status, status}], goals: [{goalId: status, projection: {status}}] };
  assert.equal(cockpitAttention(history).length, 0, `${status} has no pending gate`);
  const records = cockpitWorkItems(history);
  assert.equal(cockpitFilterItems(records, "attention").length, 0);
  assert.equal(cockpitFilterItems(records, "recent").length, 2, "ended records remain accessible");
}
assert.equal(cockpitTaskTitle({id: "abcdefghijk", employeeName: "分析员"}), "任务名称暂不可用");

for (const status of ["awaiting_review", "blocked", "waiting", "pending_file_intake", "pending_remote_resource", "pending_invocation_check", "execution_completed", "reconcile_required", "resume_required"]) {
  assert.equal(cockpitAttention({tasks:[{id:status,status}],goals:[{goalId:status,status}]}).length,0, "execution conditions are not human approvals");
}
assert.equal(cockpitAttention({automations}).length,0,"schedule failures belong in schedule details");

// Exercise the integrated task controls against the canonical callbacks.
const taskSource = await readFile(new URL("../src/components/CockpitTaskWorkspace.jsx", import.meta.url), "utf8");
const taskCode = await transformWithEsbuild(taskSource, "CockpitTaskWorkspace.jsx", { loader: "jsx", format: "cjs", jsx: "automatic" });
const taskModule = {exports: {}};
const actions = [];
vm.runInNewContext(taskCode.code, {
  module: taskModule, exports: taskModule.exports,
  require: name => name === "react" ? {useState: v => [v, () => {}], useMemo: fn => fn(), useRef: v => ({current: v}), useEffect: fn => fn()}
    : name === "react/jsx-runtime" ? {jsx, jsxs: jsx}
    : name.includes("personalCockpitModel") ? {cockpitWorkItems, cockpitFilterItems, cockpitTaskTitle}
    : name.includes("MyTasksSheet") ? {TaskDetails: "TaskDetails"}
    : name.includes("PersonalAutomationsPanel") ? {PersonalAutomationsPanel: "PersonalAutomationsPanel"}
    : name.includes("desktop-my-tasks") ? {isDesktopMyTaskCancelableStatus: s => s === "queued"}
    : name.includes("cockpitProgressPresentation") ? { cockpitRecordTime, cockpitRecordTimeLabel, groupStepProgress }
    : name.includes("cockpitStatusTone") ? { cockpitStatusTone }
    : name.includes("groupRunHistory") ? {runStatusLabel: s => s}
    : {},
});
const queued = {id: "q2", employeeId: "worker", taskTitle: "第二项", status: "queued"};
const taskQueue = {employee: {id: "worker"}, queuedTaskIds: ["q1", "q2"], reorderable: true, revision: "rev"};
const taskState = {phase: "ready", page: {tasks: [queued], queues: [taskQueue]}, details: {q2: {phase: "ready"}}, loadDetail: t => actions.push(["detail", t]), reorder: (q, ids) => actions.push(["reorder", q, ids]), cancel: t => actions.push(["cancel", t]), submitFeedback() {}, inspectArtifact() {}, deliverArtifact() {}};
const taskProps = {myTasks: taskState, sources: {goalPhase: "ready", goals: [], automationPhase: "ready", automations: []}, filter: "queued", selectedTaskId: "q2"};
const rendered = nodes(taskModule.exports.CockpitTaskWorkspace(taskProps));
assert.equal(actions[0][1], queued);
rendered.find(n => n.type === "button" && text(n) === "上移").props.onClick();
assert.equal(actions[1][1], taskQueue, "pass canonical queue including revision");
assert.equal(actions[1][2].join(","), "q2,q1");
assert.equal(rendered.find(n => n.type === "button" && text(n) === "下移").props.disabled, true);
rendered.find(n => n.type === "button" && text(n) === "移出队列").props.onClick();
assert.equal(actions[2][1], queued);
const detailNode = rendered.find(n => n.type === "TaskDetails");
assert.equal(detailNode.props.onFeedback, taskState.submitFeedback);
assert.equal(detailNode.props.onInspectArtifact, taskState.inspectArtifact);
assert.equal(detailNode.props.onDeliverArtifact, taskState.deliverArtifact);
assert(rendered.some(n => n.props?.className === "cockpit-work-layout has-detail"));
assert(!nodes(taskModule.exports.CockpitTaskWorkspace({...taskProps, filter: "recent"})).some(n => n.type === "TaskDetails"), "filtered-away task must not retain an unrelated detail pane");
assert(!nodes(taskModule.exports.CockpitTaskWorkspace({...taskProps, myTasks:{...taskState,phase:"error"}})).some(n => n.type === "TaskDetails"), "failed source cannot retain selected detail");
const nativeApi = {personalAutomations() {}};
const automationNode = nodes(taskModule.exports.CockpitTaskWorkspace({...taskProps, filter: "automations", desktopApi: nativeApi, selectedAutomation: {automationId: "rule"}})).find(n => n.type === "PersonalAutomationsPanel");
assert.equal(automationNode.props.desktopApi, nativeApi);
assert.equal(automationNode.props.selectedAutomationId, "rule");
console.log("cockpit workbench deduplication, attention and action routing checks passed");

let restored = false;
cockpitApi.setExpanded = value => {restored = value;};
const compactCockpit = renderCockpit(false);
assert.ok(compactCockpit.some(n => n.props?.className === "cockpit-desktop-sentinel"));
assert.ok(!compactCockpit.some(n => n.props?.className === "cockpit-main"));
compactCockpit.find(n => n.type === "CockpitSentinel").props.onOpen();
assert.equal(restored, true, "clicking desktop sentinel restores the main window");
assert.ok(renderCockpit().some(n => n.type === "button" && n.props?.["aria-label"] === "收起到桌面值守"));
assert.ok(!renderCockpit().some(n => n.props?.className === "cockpit-workbench-entry"));
console.log("cockpit collapse/restore and consolidated entry checks passed");

// Group completion belongs to the accepted Run, never to its completed steps.
const deliveryGoals = ["awaiting_review", "awaiting_acceptance", "execution_completed", "accepted", "rejected", "canceled", "running"].map(status => ({ goalId: `goal-${status}`, projection: { status, steps: [{ taskId: `step-${status}` }] } }));
const deliveryTasks = deliveryGoals.map(goal => ({ id: goal.projection.steps[0].taskId, status: "completed", sourceSystemId: "group_studio" }));
const deliveryOverview = cockpitOverview({ goals: deliveryGoals, tasks: deliveryTasks });
assert.deepEqual(deliveryOverview.acceptedGoals.map(g => g.goalId), ["goal-accepted"]);
assert.deepEqual(deliveryOverview.runningGoals.map(g => g.goalId), ["goal-running"]);
assert.equal(deliveryOverview.completedTasks.length, 0);
assert.equal(cockpitOverview({tasks: deliveryTasks}).completedTasks.length, 0, "loading or failed Group history must not expose completed steps as delivered Goals");
assert.deepEqual(cockpitFilterItems(cockpitWorkItems({goals:deliveryGoals,tasks:deliveryTasks}), "recent").map(x=>x.item.goalId), ["goal-accepted", "goal-rejected", "goal-canceled"]);
assert(cockpitAttention({goals:deliveryGoals}).some(x=>x.item.goalId === "goal-awaiting_acceptance" && x.action === "验收交付"));

// Failed or in-flight Group reads must not turn into a false empty task report.
renderCockpit().find(node => node.type === "button" && text(node).includes("驾驶舱")).props.onClick();
let failGoals = false;
let resolveGoals;
const sourceApi = { ...cockpitApi, groupStudio: { history: () => failGoals
  ? Promise.resolve({ ok: false }) : new Promise(resolve => { resolveGoals = resolve; }) } };
const emptyTasks = { ...myTasks, page: { tasks: [] } };
renderCockpit(true, { desktopApi: sourceApi, myTasks: emptyTasks });
let pendingTree = renderCockpit(true, { desktopApi: sourceApi, myTasks: emptyTasks });
assert.ok(text(pendingTree).includes("正在同步任务状态"));
assert.ok(!text(pendingTree).includes("当前没有进行中的任务"));
assert.ok(!text(pendingTree).includes("当前页尚无已完成任务"));
await new Promise(resolve => setImmediate(resolve));
resolveGoals({ ok: true, items: [] });
await new Promise(resolve => setImmediate(resolve));
let emptyTree = renderCockpit(true, { desktopApi: sourceApi, myTasks: emptyTasks });
emptyTree.find(node => node.type === "button" && text(node) === "进行中").props.onClick();
emptyTree = renderCockpit(true, { desktopApi: sourceApi, myTasks: emptyTasks });
assert.ok(text(emptyTree).includes("当前没有进行中的任务"));
failGoals = true;
emptyTree.find(node => node.props?.["aria-label"] === "刷新概览").props.onClick();
renderCockpit(true, { desktopApi: sourceApi, myTasks: emptyTasks });
await new Promise(resolve => setImmediate(resolve));
const failedTree = renderCockpit(true, { desktopApi: sourceApi, myTasks: emptyTasks });
assert.ok(text(failedTree).includes("任务状态暂时无法完整获取"));
assert.ok(text(failedTree).includes("部分来源暂不可用，仅显示已读取记录"));
assert.ok(!text(failedTree).includes("当前没有进行中的任务"));
assert.ok(!text(failedTree).includes("当前页尚无已完成任务"));
console.log("cockpit shared-source loading and failure checks passed");

assert.equal(cockpitStatusTone('accepted'), 'success');
assert.equal(cockpitStatusTone('completed'), 'success');
for (const status of ['execution_completed', 'awaiting_review', 'awaiting_acceptance', 'draft', 'resume_required', 'reconcile_required', 'waiting', 'pending_file_intake', 'pending_remote_resource', 'pending_invocation_check', 'attention_required']) assert.equal(cockpitStatusTone(status), 'attention', `${status} is not accepted delivery`);
for (const status of ['running', 'planning', 'starting']) assert.equal(cockpitStatusTone(status), 'active');
for (const status of ['blocked', 'failed', 'rejected', 'lost', 'timeout', 'timed_out']) assert.equal(cockpitStatusTone(status), 'danger');
for (const status of ['queued', 'pending', 'canceled', 'unknown', undefined]) assert.equal(cockpitStatusTone(status), 'neutral');
console.log('Cockpit status tones distinguish execution, review, acceptance and failure');
assert.equal(cockpitRecordTime({kind:'goal',item:{projection:{sourceAsOf:'2026-09-30T00:00:00Z'}}}), null, 'polling time cannot become record time');
assert.deepEqual(cockpitRecordTime({kind:'goal',item:{projection:{executionUpdatedAt:'2026-09-29T10:00:00Z'}}}), {label:'执行更新',value:'2026-09-29T10:00:00Z'});
assert.deepEqual(cockpitRecordTime({kind:'task',item:{updatedAt:'invalid',submittedAt:'2026-09-29T10:00:00Z'}}), {label:'提交于',value:'2026-09-29T10:00:00Z'});
assert.equal(groupStepProgress({steps:[{status:'completed'},{status:'failed'},{status:'running'}]}).completed, 1);
assert.equal(groupStepProgress({steps:[]}), null);
console.log('Cockpit record-time provenance and completed-step counts passed');

// Exercise the actual App catalog refresh boundary while its IPC read is pending.
const appSource = await readFile(new URL("../src/App.jsx", import.meta.url), "utf8");
const catalogFunction = appSource.slice(appSource.indexOf("  async function refreshCatalog("), appSource.indexOf("  async function checkForUpdates("));
let catalogState = { phase: "success", updatedAt: 1 };
let catalogRead = deferred();
let catalogReads = 0;
const catalogContext = {
  desktopApi: { bootstrap: () => { catalogReads++; return catalogRead.promise; } },
  catalogRefreshPromiseRef: { current: null }, catalogEmployeesRef: { current: [] }, Date,
  setCatalogSync: next => { catalogState = typeof next === "function" ? next(catalogState) : next; },
  setEmployees() {}, setRequestableEmployees() {}, setAccessRequests() {}, setHistoryBootstrapRevision() {}, setSelectedEmployeeId() {},
};
vm.runInNewContext(`${catalogFunction}\nthis.refreshCatalog = refreshCatalog;`, catalogContext);
const catalogRequests = [catalogContext.refreshCatalog(), catalogContext.refreshCatalog()];
assert.equal(catalogReads, 1, "catalog refresh bursts share one bootstrap request");
assert.equal(catalogState.phase, "success", "loaded employee counts stay available during a pending bootstrap");
catalogRead.resolve({ ok: true, employees: [] });
await Promise.all(catalogRequests);
assert.equal(catalogState.phase, "success");
catalogRead = deferred();
catalogState = { phase: "idle", updatedAt: 0 };
const firstCatalogRead = catalogContext.refreshCatalog();
assert.equal(catalogState.phase, "loading", "first bootstrap still has an explicit loading state");
catalogRead.resolve({ ok: false });
await firstCatalogRead;
assert.equal(catalogState.phase, "error", "failed bootstrap must not claim current employee availability");
console.log("Cockpit catalog background retention, first-load/error and single-flight checks passed");

const pendingItems=Array.from({length:5},(_,i)=>({id:`pending-${i}`,kind:i===0?'confirmation':'parameter',requestKind:'clarification',employeeId:'employee',displayTitle:`Question ${i}`,expiresAt:new Date(Date.now()+60000).toISOString()}));
assert.equal(cockpitAttention({interactions:pendingItems}).length,5);
assert.equal(cockpitFilterItems(cockpitWorkItems({interactions:pendingItems}),'attention').length,5,'all pending interactions remain reachable beyond the first three');
assert.equal(cockpitAttention({interactions:[{...pendingItems[0],expiresAt:'2000-01-01T00:00:00Z'}]}).length,0);
console.log('all pending interactions, including 4+ cards, remain in the full attention list');
