import assert from "node:assert/strict";
import { DEVICE_READ_OPERATION_VERSION, deviceReadAdapterDigest, deviceReadOperationDigest } from "../shared/device-read-operation-v1.mjs";
import { createDeviceReadOperationExecutor } from "../electron/device-read-operation-executor.mjs";
import { createFeishuCalendarReadAdapter } from "../electron/feishu-calendar-read-adapter.mjs";
import { createDesktopFeishuCliConnection } from "../electron/desktop-feishu-cli-connection.mjs";

const clock = Date.parse("2026-10-09T01:00:00Z");
let actor = { key: "synthetic-a", version: 1, identitySource: "fortress-sso-v3", feishuUnionId: "synthetic-union-a" };
let info = { open_id: "synthetic-open-a", union_id: "synthetic-union-a" };
let data = [{ eventRef: "synthetic-event", title: "private-title-sentinel", start: "2026-10-09T01:00:00.000Z", end: "2026-10-09T02:00:00.000Z" }];
let appId = "synthetic-app-a";
let reads = 0;
let duringRead = () => {};
const calls = [];
const run = async (args, { signal } = {}) => {
  calls.push(args);
  if (signal?.aborted) throw new Error("private-abort");
  if (args[0] === "auth") return { appId, verified: true, identities: { user: { verified: true, status: "ready", tokenStatus: "valid", openId: info.open_id } } };
  if (args[0] === "api") return { ok: true, identity: "user", data: { ...info } };
  throw new Error("business read must use pinned helper");
};
const connection = createDesktopFeishuCliConnection({ run, now: () => clock, readActor: async () => ({ ...actor }),
  isExpectedActor: (key, version) => key === actor.key && version === actor.version });
const read = async ({ account, start, end }) => {
  reads++;
  assert.deepEqual(account, { appId, openId: info.open_id, unionId: info.union_id });
  assert.equal(start, "2026-10-09T00:00:00Z"); assert.equal(end, "2026-10-10T00:00:00Z");
  duringRead();
  return { events: structuredClone(data) };
};
const adapter = createFeishuCalendarReadAdapter({ connection, read });
let authority = true;
let authorityCalls = 0;
const executor = createDeviceReadOperationExecutor({ adapters: [adapter], now: () => clock,
  validateLiveClaim: async () => { authorityCalls++; return authority; } });
function claim(input = { start: "2026-10-09T00:00:00Z", end: "2026-10-10T00:00:00Z" }, overrides = {}) {
  const value = { contractVersion: DEVICE_READ_OPERATION_VERSION, taskId: "synthetic-task", toolCallId: "synthetic-call",
    toolId: adapter.toolId, operationId: adapter.operationId, adapterDigest: deviceReadAdapterDigest(adapter),
    taskInputDigest: "a".repeat(64), actorDigest: "b".repeat(64), deviceSessionDigest: "c".repeat(64),
    expiresAt: new Date(clock + 60_000).toISOString(), input, ...overrides };
  return { ...value, operationDigest: deviceReadOperationDigest(value) };
}
assert.throws(() => createDeviceReadOperationExecutor(), /live_authority_required/);
assert.throws(() => createDeviceReadOperationExecutor({ adapters: [adapter, adapter], validateLiveClaim: () => true }), /conflict/);
assert.equal((await executor.execute(claim())).status, "failed", "no silent CLI association");
assert.equal(calls.length, 0);
await connection.connect();
const good = await executor.execute(claim());
assert.equal(good.status, "completed");
assert.equal(reads, 1);
assert.ok(calls.every(args => args[0] !== "calendar"), "stock CLI is never a business read fallback");
assert.ok(calls.filter(args => args[0] === "auth").length >= 3, "read checks identity before and after, beyond the cached association");
const privateResult = executor.takePrivateResult(good);
assert.equal(privateResult.events[0].title, "private-title-sentinel");
assert.equal(privateResult.events[0].start, "2026-10-09T01:00:00.000Z");
assert.equal(executor.takePrivateResult(good), null, "private delivery consumed once");
for (const secret of ["private-title-sentinel", "private-token-sentinel", "synthetic-open-a", "synthetic-union-a"])
  assert.equal(JSON.stringify(good).includes(secret), false);
for (const secret of ["private-description-sentinel", "private-token-sentinel", "private-email-sentinel"])
  assert.equal(JSON.stringify(privateResult).includes(secret), false);
const beforeInvalid = calls.length;
for (const value of [claim({ start: "2026-10-09", end: "2026-10-10" }), claim({ start: "2026-02-30T00:00:00Z", end: "2026-03-01T00:00:00Z" }),
  claim({ start: "2026-10-09T00:00:00Z", end: "2026-10-20T00:00:00Z" }), claim({ start: "2026-10-09T00:00:00Z", end: "2026-10-09T00:00:00Z" }),
  claim({ start: "2026-10-09T00:00:00Z", end: "2026-10-10T00:00:00Z", argv: ["im", "send"] }),
  claim(undefined, { adapterDigest: "d".repeat(64) }), claim(undefined, { expiresAt: new Date(clock).toISOString() }),
  claim(undefined, { expiresAt: new Date(clock + 121_000).toISOString() }), { ...claim(), shell: "whoami" },
  { ...claim(), actorDigest: "e".repeat(64) }]) assert.equal((await executor.execute(value)).status, "blocked");
assert.equal(calls.length, beforeInvalid, "invalid or tampered claims never reach CLI");
authority = false;
assert.equal((await executor.execute(claim())).code, "device_read_authority_unavailable");
assert.equal(calls.length, beforeInvalid);
authority = true;
duringRead = () => { authority = false; };
const revoked = await executor.execute(claim());
assert.equal(revoked.code, "device_read_authority_changed");
assert.equal(executor.takePrivateResult(revoked), null);
authority = true;
duringRead = () => { actor = { ...actor, key: "synthetic-b", version: 2 }; connection.clear(); };
assert.equal((await executor.execute(claim())).status, "failed");
actor = { ...actor, key: "synthetic-a", version: 1 };
duringRead = () => {};
await connection.connect();
duringRead = () => { info = { ...info, open_id: "synthetic-other-open" }; };
assert.equal((await executor.execute(claim())).status, "failed", "CLI login swap cannot publish result");
info.open_id = "synthetic-open-a";
duringRead = () => {};
await connection.connect();
duringRead = () => { appId = "synthetic-app-b"; };
assert.equal((await executor.execute(claim())).status, "failed", "app swap cannot publish a result");
appId = "synthetic-app-a";
duringRead = () => {};
await connection.connect();
const controller = new AbortController();
duringRead = () => controller.abort();
assert.equal((await executor.execute(claim(), { signal: controller.signal })).status, "canceled");
duringRead = () => {};
data = Array.from({ length: 101 }, () => data[0]);
assert.equal((await executor.execute(claim())).status, "failed");
data = Array.from({ length: 100 }, () => ({ eventRef: "synthetic-event", title: "文".repeat(400), start: "2026-10-09", end: "2026-10-10" }));
assert.equal((await executor.execute(claim())).status, "failed", "byte limit applies after privacy projection");
data = [{ eventRef: "synthetic-all-day", title: "synthetic all-day", start: "2026-10-09", end: "2026-10-10" }];
assert.equal((await executor.execute(claim())).status, "completed");
let advanced = clock;
const expiryExecutor = createDeviceReadOperationExecutor({ adapters: [adapter], now: () => advanced,
  validateLiveClaim: async () => { advanced += 60_001; return true; } });
const beforeExpiry = calls.length;
assert.equal((await expiryExecutor.execute(claim())).code, "device_read_claim_expired");
assert.equal(calls.length, beforeExpiry, "expiry during authority validation cannot start a read");
let release;
const waiting = new Promise(resolve => { release = resolve; });
const duplicateExecutor = createDeviceReadOperationExecutor({ adapters: [adapter], now: () => clock,
  validateLiveClaim: async () => { await waiting; return true; } });
const first = duplicateExecutor.execute(claim());
assert.equal((await duplicateExecutor.execute(claim())).code, "device_read_claim_in_flight");
release();
assert.equal((await first).status, "completed");
assert.equal(duplicateExecutor.takePrivateResult({ ...good }), null, "copies of safe status cannot access private output");
assert.ok(authorityCalls > 0);
assert.ok(calls.every(args => !args.includes("login") && !args.includes("logout") && !args.includes("--as bot")));
// A stalled read must observe expiry while executing, not only after returning.
let abortedAtDeadline = false;
const liveClaim = { ...claim(), expiresAt: new Date(Date.now() + 30).toISOString() };
liveClaim.operationDigest = deviceReadOperationDigest(liveClaim);
const stalled = createDeviceReadOperationExecutor({ adapters: [{ ...adapter, execute: async (_input, { signal }) =>
  new Promise((_resolve, reject) => signal.addEventListener("abort", () => {
    abortedAtDeadline = true; reject(new Error("private-error-sentinel"));
  }, { once: true })) }], validateLiveClaim: async () => true });
let guard;
try {
  const result = await Promise.race([stalled.execute(liveClaim), new Promise((_resolve, reject) => {
    guard = setTimeout(() => reject(new Error("deadline did not cancel stalled adapter")), 1000);
  })]);
  assert.equal(abortedAtDeadline, true); assert.equal(result.status, "canceled");
} finally { clearTimeout(guard); }
console.log("Device read contract and Feishu calendar identity/privacy/cancellation checks passed");
