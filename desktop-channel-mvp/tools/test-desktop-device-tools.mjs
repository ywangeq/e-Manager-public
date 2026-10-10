import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import ts from "typescript";
import { createDesktopDeviceTools } from "../electron/desktop-device-tools.mjs";

let identity = { actorKey: "one", actorVersion: 1, center: "https://center.invalid", associationGeneration: 1 };
let enabled = true, starts = 0, stopped = 0;
const clients = [], displayed = [];
const tools = createDesktopDeviceTools({ context: () => ({ ...identity }), available: async () => enabled,
  createAdapters: () => [{}], request: () => {}, onCompleted: (context, value) => displayed.push([context, value]),
  createClient: options => {
    const id = ++starts;
    const client = { options, start: async () => {}, stop: async () => { stopped++; }, headers: () => ({ device: String(id) }) };
    clients.push(client); return client;
  },
});
await Promise.all([tools.ensure(), tools.ensure()]);
assert.equal(starts, 1);
assert.deepEqual(tools.headers(), { device: "1" });
clients[0].options.onCompleted("first");
assert.equal(displayed.length, 1);
identity.associationGeneration++;
assert.deepEqual(tools.headers(), {});
assert.equal(clients[0].options.isExpectedActor(), false);
clients[0].options.onCompleted("late");
assert.equal(displayed.length, 1);
await tools.ensure();
assert.equal(starts, 2);
assert.equal(stopped, 1);
identity.actorKey = "two"; identity.actorVersion++;
await tools.ensure();
assert.equal(starts, 3);
assert.equal(stopped, 2);
await tools.stop();
assert.deepEqual(tools.headers(), {});
assert.equal(clients[2].options.isExpectedActor(), false);
enabled = false;
assert.equal(await tools.ensure(), null);
assert.equal(starts, 3);

// Logout while availability is being verified must not create a stale client.
let release;
const held = new Promise(resolve => { release = resolve; });
const racing = createDesktopDeviceTools({ context: () => ({ ...identity }), available: async () => { await held; return true; },
  createAdapters: () => [{}], request: () => {}, createClient: () => { throw Error("stale client"); } });
const pending = racing.ensure();
await new Promise(resolve => setImmediate(resolve));
await racing.stop(); identity.actorKey = ""; release();
assert.equal(await pending, null);

// Exercise the actual main-process admission callback with an associated but
// stale proof, rather than assuming status() refreshes CLI identity itself.
const source = fs.readFileSync(new URL("../electron/main.mjs", import.meta.url), "utf8");
const ast = ts.createSourceFile("main.mjs", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
let availability;
function visit(node) {
  if (ts.isCallExpression(node) && node.expression.getText(ast) === "createDesktopDeviceTools") {
    availability = node.arguments[0].properties.find(property => property.name?.getText(ast) === "available")?.initializer.getText(ast);
  }
  ts.forEachChild(node, visit);
}
visit(ast); assert.ok(availability);
let state = "verification_required", checks = 0;
const admission = vm.createContext({ quitting: false, activeActorKey: "one", serverUrl: "https://center.invalid",
  isManagedHttpsCenterOrigin: () => true, feishuCliConnection: {
    check: async () => { checks++; state = "authenticated"; }, status: async () => ({ state }),
  } });
const available = vm.runInContext(`(${availability})`, admission);
assert.equal(await available(), true); assert.equal(checks, 1);
admission.feishuCliConnection.check = async () => { checks++; state = "disconnected"; };
assert.equal(await available(), false, "failed or absent association cannot expose the Tool");
admission.quitting = true;
assert.equal(await available(), false); assert.equal(checks, 2, "quit cannot access CLI");
const diagnosticNode = ast.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === "recordDeviceReadDiagnostic");
const saved = [];
const diagnosticContext = vm.createContext({ Date, JSON, deviceReadDiagnostics: [], deviceDiagnosticWrite: Promise.resolve(),
  path: { join: (...parts) => parts.join("/") }, app: { getPath: () => "/synthetic" },
  writeFile: async (file, data, options) => saved.push({file,data,options}) });
vm.runInContext(diagnosticNode.getText(ast), diagnosticContext);
diagnosticContext.recordDeviceReadDiagnostic({stage:"authority",code:"private-token-sentinel"});
for(let i=0;i<40;i++) diagnosticContext.recordDeviceReadDiagnostic({stage:"authority",code:"allowed",account:"private-account-sentinel"});
await diagnosticContext.deviceDiagnosticWrite;
const snapshot = JSON.parse(saved.at(-1).data);
assert.equal(snapshot.events.length,32);assert.equal(saved.at(-1).options.mode,0o600);
assert.equal(saved.at(-1).data.includes("sentinel"),false,"diagnostics never accept private or vendor content");
console.log("desktop Device Tool identity/lifecycle composition passed");
