import assert from "node:assert/strict";
import { matchesWorkbenchAutomation } from "../src/lib/workbenchAutomationScope.js";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import { transformWithEsbuild } from "vite";

const source = await readFile(new URL("../src/components/PersonalAutomationsPanel.jsx", import.meta.url), "utf8");
const { code } = await transformWithEsbuild(source, "PersonalAutomationsPanel.jsx", { loader: "jsx", format: "cjs", jsx: "automatic" });
const jsx = (type, props) => ({ type, props });
const state = { page: { automations: [], notifications: [] }, busy: false, error: "", detail: null, taskView: null, loaded: true, view: "list", activeId: "", refreshing: false, now: Date.now() };
const calls = [];
const noop = () => {};
const module = { exports: {} };
vm.runInNewContext(code, {
  module, exports: module.exports,
  require: (name) => name === "../lib/workbenchAutomationScope.js" ? { matchesWorkbenchAutomation } : name === "react/jsx-runtime" ? { jsx, jsxs: jsx } : name === "react" ? {
    useState: (initial) => {
      const key = Object.keys(state)[calls.length];
      calls.push(key);
      return [state[key] ?? (typeof initial === "function" ? initial() : initial), noop];
    }, useRef: (value) => ({ current: value }), useEffect: noop,
  } : new Proxy({}, { get: (_, key) => key }),
  window: { setInterval: noop, clearInterval: noop }, document: { visibilityState: "visible" },
});
function nodes(node) { if (!node || typeof node !== "object") return []; return [node, ...[node.props?.children].flat(Infinity).flatMap(nodes)]; }
function render(mode) { calls.length = 0; return nodes(module.exports.PersonalAutomationsPanel({ cockpitMode: mode, desktopApi: { personalAutomations: async (input) => { requests.push(input); return { ok: true, automations: state.page.automations, notifications: [] }; } } })); }
const requests = [];
state.page.automations = ["active", "paused", "disabled", "exhausted", "attention_required"].map((status, index) => ({ automationId: `rule${index}`, employeeId: "worker", intervalSeconds: 60, expiresAt: "2099-01-01T00:00:00Z", runCount: 0, maxRuns: 5, revision: index + 1, state: status }));
let switches = render(true).filter((node) => node.props?.role === "switch");
assert.equal(switches.length, 5);
assert.deepEqual(switches.map((node) => [node.props["aria-checked"], node.props.disabled]), [[true, false], [false, false], [false, true], [false, true], [false, false]]);
assert.ok(switches.every((node) => !/rule[0-9]/.test(node.props["aria-label"])), "technical rule IDs stay out of accessible labels");
assert.equal(new Set(switches.map((node) => node.props["aria-label"])).size, 5, "identical employee and cadence remain distinguishable");
switches[0].props.onClick(); switches[1].props.onClick(); switches[4].props.onClick();
await new Promise((resolve) => setImmediate(resolve));
assert.deepEqual(JSON.parse(JSON.stringify(requests.slice(0, 3))), [
  { action: "change", automationId: "rule0", input: { action: "pause", expectedRevision: 1 } },
  { action: "change", automationId: "rule1", input: { action: "resume", expectedRevision: 2 } },
  { action: "change", automationId: "rule4", input: { action: "resume", expectedRevision: 5 } },
]);
assert.equal(state.page.automations[0].state, "active", "state remains Center-owned until list refresh");
assert.equal(state.page.automations[4].revision, 5, "revision remains Center-owned until list refresh");
assert.equal(render(false).filter((node) => node.props?.role === "switch").length, 0);
assert.equal(render(false).filter((node) => node.props?.className === "personal-automation-action" && node.props?.onClick).length, 3, "ordinary Desktop retains pause/resume buttons for nonterminal rules");
console.log("Cockpit automation switch: per-rule CAS, terminal controls, unchanged ordinary Desktop passed");
