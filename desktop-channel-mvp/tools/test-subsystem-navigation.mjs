import assert from "node:assert/strict";
import vm from "node:vm";
import { readFile } from "node:fs/promises";
import { transformWithEsbuild } from "vite";
import { subsystemConnectionPresentation, connectionTime } from "../src/lib/subsystemConnectionPresentation.js";
const source = await readFile(new URL("../src/components/SubsystemConnections.jsx", import.meta.url), "utf8");
const { code } = await transformWithEsbuild(source, "SubsystemConnections.jsx", { loader: "jsx", format: "cjs", jsx: "automatic" });
const slots = []; let index = 0;
const react = { useId: () => "synthetic-details", useState: value => { const at = index++; if (!(at in slots)) slots[at] = value; return [slots[at], next => { slots[at] = next; }]; } };
const module = { exports: {} };
const jsx = (type, props) => ({ type, props });
vm.runInNewContext(code, { module, exports: module.exports, require: name => name === "react" ? react : name === "react/jsx-runtime" ? { jsx, jsxs: jsx }
  : name.includes("subsystemConnectionPresentation") ? { subsystemConnectionPresentation, connectionTime }
  : name.includes("FeishuAuthorization") ? { FeishuAuthorization: "FeishuAuthorization" }
  : name === "@phosphor-icons/react" ? new Proxy({}, { get: (_, key) => key }) : {} });
function nodes(tree) { return Array.isArray(tree) ? tree.flatMap(nodes) : tree && typeof tree === "object" ? [tree, ...nodes(tree.props?.children)] : []; }
const connectionSource = { phase: "ready", connections: Array.from({ length: 7 }, (_, index) => ({ id: `synthetic-${index}`, name: `系统${index}`, employees: [], state: "disconnected", actions: [] })) };
let opened;
function render(props) { index = 0; return nodes(module.exports.SubsystemConnections({ source: connectionSource, ...props })); }
let tree = render({ compact: true, onOpen: id => { opened = id; } });
const choices = tree.filter(node => node.props?.className === "subsystem-choice");
assert.equal(choices.length, 4);
choices[2].props.onClick(); assert.equal(opened, "synthetic-2");
tree.find(node => node.props?.className === "subsystem-more").props.onClick(); assert.equal(opened, undefined);
slots.length = 0;
tree = render({ initialSelectedId: "synthetic-6" });
assert.equal(tree.filter(node => node.props?.className === "subsystem-choice").length, 7);
assert.ok(tree.some(node => node.props?.className === "subsystem-details"), "overflow row can be selected on full page");
tree.find(node => node.props?.["aria-label"] === "搜索子系统").props.onChange({ target: { value: "系统6" } });
tree = render({ initialSelectedId: "synthetic-6" });
assert.equal(tree.filter(node => node.props?.className === "subsystem-choice").length, 1);
console.log("Subsystem preview limit, overflow navigation, detail selection and search passed");
