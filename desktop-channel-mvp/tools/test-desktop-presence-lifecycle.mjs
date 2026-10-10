import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import ts from "typescript";

// Execute the actual main-process handlers with inert Electron surfaces. This
// verifies wiring without launching a second Desktop or copying its lifecycle.
const source = fs.readFileSync(new URL("../electron/main.mjs", import.meta.url), "utf8");
const ast = ts.createSourceFile("main.mjs", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
function callback(receiver, event) {
  const found = [];
  function visit(node) {
    if (ts.isCallExpression(node) && node.expression.getText(ast) === receiver &&
      ts.isStringLiteral(node.arguments[0]) && node.arguments[0].text === event) found.push(node.arguments[1].getText(ast));
    ts.forEachChild(node, visit);
  }
  visit(ast); assert.equal(found.length, 1, `exact ${receiver} ${event} binding`); return found[0];
}
const setExpanded = ast.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === "setExpanded");
assert.ok(setExpanded);
let releaseStop, stopCalls = 0, cleanupCalls = 0, quitCalls = 0, hidden = 0;
const stopped = new Promise(resolve => { releaseStop = resolve; });
const client = { stop: () => { stopCalls++; return stopped; } };
let releaseCalendarStop, calendarStopCalls = 0;
const calendarStopped = new Promise(resolve => { releaseCalendarStop = resolve; });
const calendar = { close: () => { calendarStopCalls++; return calendarStopped; } };
let releaseDeviceStop, deviceStopCalls = 0;
const deviceStopped = new Promise(resolve => { releaseDeviceStop = resolve; });
const deviceTools = { stop: () => { deviceStopCalls++; return deviceStopped; } };
const noop = () => {};
let preferenceFlushes = 0;
const context = vm.createContext({
  quitting: false, expanded: true, desktopPresenceClient: client, sessionRevalidateTimer: null,
  localCalendarService: calendar, desktopDeviceTools: deviceTools,
  releaseUpdateService: null, releaseUpdateSignalClient: null, desktopSandboxMainDispatch: null,
  desktopArtifactDeliveryService: null, clearInterval: noop, assertMainSender: noop,
  removeManagedCenterCertificateTrust: () => { cleanupCalls++; }, disposeDataflowCredentialRuntime: noop,
  desktopTaskFollowService: { abortAll: noop }, abortDesktopAssistantRequests: noop,
  windowSizePreferences: { flush: () => { preferenceFlushes++; } }, rememberExpandedWindowSize: noop, windowAlwaysOnTopForState: () => true,
  applyWindowResizePolicy: noop, anchorWindow: noop, setTimeout: fn => { fn(); },
  mainWindow: { hide: () => { hidden++; }, isVisible: () => true, isDestroyed: () => false,
    setAlwaysOnTop: noop, showInactive: noop, webContents: {send:noop,invalidate:noop} },
});
vm.runInContext(setExpanded.getText(ast), context);
const beforeQuit = vm.runInContext(`(${callback("app.on", "before-quit")})`, context);
const close = vm.runInContext(`(${callback("mainWindow.on", "close")})`, context);
const hide = vm.runInContext(`(${callback("ipcMain.handle", "desktop:hide")})`, context);
const collapse = vm.runInContext(`(${callback("ipcMain.handle", "desktop:set-expanded")})`, context);
context.app = { quit: () => { quitCalls++; beforeQuit({preventDefault:()=>assert.fail("second quit must complete")}); } };
let prevented = 0;
collapse({}, false); hide({}); close({preventDefault:()=>{prevented++;}});
assert.ok(hidden >= 3); assert.equal(prevented, 1);
assert.equal(stopCalls, 0, "collapse/hide/window close must preserve presence");
assert.equal(calendarStopCalls, 0, "collapse/hide/window close must preserve local schedule");
assert.equal(deviceStopCalls, 0, "collapse/hide/window close must preserve Device Tool client");
assert.equal(preferenceFlushes, 1, "window close flushes pending size");
assert.equal(context.desktopPresenceClient, client);
beforeQuit({preventDefault:()=>{prevented++;}});
assert.equal(stopCalls, 1); assert.equal(prevented, 2); assert.equal(context.quitting, true);
assert.equal(context.desktopPresenceClient, null);
assert.equal(context.localCalendarService, null);
assert.equal(calendarStopCalls, 1);
assert.equal(deviceStopCalls, 1);
assert.equal(quitCalls, 0, "quit must wait for presence revocation");
assert.equal(preferenceFlushes, 2, "quit flushes size before async presence cleanup");
assert.equal(cleanupCalls, 0, "session cleanup must not race revocation");
releaseStop(); await new Promise(resolve => setImmediate(resolve));
assert.equal(quitCalls, 0, "quit must also wait for local calendar shutdown");
releaseCalendarStop(); await new Promise(resolve => setImmediate(resolve));
assert.equal(quitCalls, 0, "quit must also wait for Device Tool shutdown");
releaseDeviceStop(); await new Promise(resolve => setImmediate(resolve));
assert.equal(quitCalls, 1); assert.equal(cleanupCalls, 1); assert.equal(stopCalls, 1);
close({preventDefault:()=>assert.fail("real quit must not hide instead")});
console.log("Desktop lifecycle: actual collapse/hide/close preserve presence, quit waits for revocation before cleanup");
