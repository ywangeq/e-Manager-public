import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import ts from "typescript";
import { CONFIRMATION_DELIVERY_MESSAGE } from "../electron/desktop-confirmation-outbox.mjs";
import { deliverToolConfirmation, readConfirmationDeliveryResponse } from "../electron/desktop-confirmation-delivery.mjs";
import { createAssistantActivityStreamParser, createAssistantTaskStreamParser,
  createDesktopSandboxBindingStreamParser, stripDesktopSandboxBindingEvents } from "../shared/desktop-assistant-activity.mjs";

// Execute the production IPC function and restart drain with inert Electron and
// material surfaces. File encryption/reopen is covered by the outbox test.
const source = fs.readFileSync(new URL("../electron/main.mjs", import.meta.url), "utf8");
const ast = ts.createSourceFile("main.mjs", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
const functions = ["sendDesktopAssistant", "recoverPendingConfirmations", "readDesktopAssistantStream",
  "isExpectedDesktopActor", "normalizeToolConfirmationInput"].map(name => {
  const node = ast.statements.find(item => ts.isFunctionDeclaration(item) && item.name?.text === name);
  assert.ok(node, name); return node.getText(ast);
});
let binding;
function visit(node) {
  if (ts.isCallExpression(node) && node.expression.getText(ast) === "ipcMain.handle" &&
    node.arguments[0]?.text === "desktop:send-assistant") binding = node.arguments[1].getText(ast);
  ts.forEachChild(node, visit);
}
visit(ast); assert.equal(binding, "sendDesktopAssistant");
const taskId = `task_${"a".repeat(64)}`;
const reference = {actorKey:"actor-a",centerOrigin:"https://center.invalid",employeeId:"employee-a",
  sessionId:"session-a",confirmationId:"confirmation-a"};
let persisted = null, failure = false, status = "accepted", network = [], followCount = 0;
let releaseCalendar, calendarReady = false, deviceEnsureCalls = 0;
const calendarInitialized = new Promise(resolve => { releaseCalendar = resolve; });
const sender = {isDestroyed:()=>false,send:()=>{}};
const context = vm.createContext({
  URL, AbortController, TextDecoder, queueMicrotask, CONFIRMATION_DELIVERY_MESSAGE,
  activeActorKey:reference.actorKey, activeActorContextVersion:1, serverUrl:reference.centerOrigin,
  conversationHistoryBootstrap:{sessions:{[reference.employeeId]:{sessionId:reference.sessionId}}},
  mainWindow:{isDestroyed:()=>false,webContents:sender}, confirmationRecoveryPromise:null,
  confirmationOutbox:{
    remember:async item => {if (failure) throw Error("tool_confirmation_outbox_unavailable");persisted={...item};},
    pending:async () => persisted ? [persisted] : [], forget:async () => {persisted=null;},
  },
  assertMainSender:event=>assert.equal(event.sender,sender),
  cleanEmployeeId:String, cleanMessage:String, cleanReusableArtifactGrantId:()=>"",
  containsCredentialText:()=>false, redactCredentialText:String, isCredentialOnlyText:()=>false,
  preparedMaterialGrant:()=>null, preparedMaterialGrants:new Map(), deviceWorkspaceSelections:new Map(),
  desktopSandboxDeviceSession:null, desktopAssistantRequestControllers:new Set(),
  ensureLocalCalendar:async()=>{await calendarInitialized;calendarReady=true;},
  desktopDeviceTools:{ensure:async()=>{assert.equal(calendarReady,true,"Device registration waits for adapter initialization");deviceEnsureCalls++;},headers:()=>({})},
  normalizeToolParameterCardInput:()=>null, toolCredentialsForEmployee:async()=>({}),
  createAssistantActivityStreamParser, createAssistantTaskStreamParser, createDesktopSandboxBindingStreamParser,
  stripDesktopSandboxBindingEvents, readConfirmationDeliveryResponse,
  deliverToolConfirmation:options=>deliverToolConfirmation({...options,wait:async()=>{}}),
  desktopTaskFollowService:{follow:async()=>{followCount++;return {ok:true,taskId};}},
  credentialEventsFromSse:()=>[], conversationSessionFromSse:()=>null,
  isDesktopCenterUnavailableError:()=>false,
  desktopFetch:async (url,options={}) => {
    network.push({url,method:options.method || "GET"});
    if (options.method === "POST") {
      assert.ok(persisted,"durable intent must precede the first network submission");
      const body=JSON.parse(options.body);
      assert.equal(body.message,CONFIRMATION_DELIVERY_MESSAGE);
      assert.equal(body.requestId,`tool-confirmation:${reference.confirmationId}`);
      assert.equal(body.toolConfirmation.id,reference.confirmationId);
      return {ok:true,status:200,text:async()=>`event: meta\ndata: ${JSON.stringify({taskId,taskStatus:"queued"})}\n\n`};
    }
    if (status === "unknown") throw Error("network_lost");
    return {ok:true,status:200,json:async()=>({ok:true,contractVersion:"tool-confirmation-submission.v1",status,
      ...(status === "submitted" ? {taskId,taskStatus:"completed"} : {})})};
  },
});
vm.runInContext(functions.join("\n"),context);
const input={employeeId:reference.employeeId,message:"display text must not be persisted",
  toolConfirmation:{contractVersion:"tool-call-confirmation.v1",id:reference.confirmationId,decision:"approved"}};
const firstSend = context.sendDesktopAssistant({sender},input);
await new Promise(resolve => setImmediate(resolve));
assert.equal(deviceEnsureCalls,0);assert.equal(network.length,0,"first chat waits for local adapter initialization");
releaseCalendar();await firstSend;assert.equal(deviceEnsureCalls,1);
assert.equal(followCount,1); assert.equal(persisted,null);
assert.equal(network.filter(item=>item.method === "POST").length,1);
failure=true;network=[];
await assert.rejects(context.sendDesktopAssistant({sender},input),/outbox_unavailable/);
assert.equal(network.length,0,"unavailable encrypted persistence blocks submission");failure=false;

for (const state of ["unknown","accepted","submitted"]) {
  status=state;persisted={...reference};network=[];followCount=0;
  await context.recoverPendingConfirmations();
  assert.equal(network[0]?.method,"GET","restart must query authority before submission");
  assert.equal(network.filter(item=>item.method === "POST").length,state === "accepted" ? 1 : 0);
  assert.equal(followCount,0,"restart delivery never enters an interactive follow or cancels a task");
  assert.equal(Boolean(persisted),state === "unknown","unknown outcome remains recoverable");
}
persisted={...reference,sessionId:"old-session"};network=[];
await context.recoverPendingConfirmations();
assert.equal(network.length,0);assert.equal(persisted,null,"changed session discards stale intent");
persisted={...reference};network=[];
context.confirmationOutbox.pending=async()=>{context.activeActorContextVersion++;return [persisted];};
await context.recoverPendingConfirmations();
assert.equal(network.length,0,"actor change during loading cannot submit or query");
assert.equal(context.desktopAssistantRequestControllers.size,0);
context.confirmationOutbox.pending=async()=>[persisted];
network=[];
context.toolCredentialsForEmployee=async()=>{context.serverUrl="https://other-center.invalid";return {};};
await assert.rejects(context.sendDesktopAssistant({sender},input),/(actor|context)_changed/);
assert.equal(network.length,0,"Center change during credential resolution cannot send to a different Center");
console.log("Desktop main confirmation: persist-before-send, actual IPC binding, status-first restart, original-task handoff and actor/session fences passed");
