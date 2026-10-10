import assert from "node:assert/strict";
import { createDesktopFeishuCliConnection, feishuIdentityMatches } from "../electron/desktop-feishu-cli-connection.mjs";
import { createDesktopSubsystemConnections } from "../electron/desktop-subsystem-connections.mjs";
import { subsystemConnectionPresentation } from "../src/lib/subsystemConnectionPresentation.js";

let clock = Date.parse("2026-10-09T05:00:00Z");
let actor = { key: "synthetic-a", version: 1, identitySource: "fortress-sso-v3", feishuUnionId: "synthetic-union-a", email: "a@example.test" };
let auth = { verified: true, identities: { user: { verified: true, status: "ready", tokenStatus: "valid", openId: "synthetic-open-a", expiresAt: "2026-10-09T07:00:00Z" } } };
let info = { ok: true, identity: "user", data: { open_id: "synthetic-open-a", union_id: "synthetic-union-a", email: "a@example.test", privateValue: "private-sentinel" } };
let failure = null;
let gate = null;
let changeIdentity = false;
const calls = [];
const adapter = createDesktopFeishuCliConnection({ now: () => clock, readActor: async () => actor && { ...actor },
  isExpectedActor: (key, version) => actor?.key === key && actor?.version === version,
  run: async args => { calls.push(args); if (gate) await gate; if (failure) throw failure;
    if (args[0] !== "auth" && changeIdentity) actor = { ...actor, feishuUnionId: "synthetic-changed" };
    return args[0] === "auth" ? structuredClone(auth) : structuredClone(info); },
});
assert.equal((await adapter.status()).state, "disconnected");
await adapter.check();
assert.equal(calls.length, 0, "checking cannot silently associate a local account");
await adapter.connect();
let state = await adapter.status();
assert.equal(state.state, "authenticated");
assert.equal(state.expiresAt, "2026-10-09T07:00:00.000Z");
assert.deepEqual(calls[1], ["api", "GET", "/open-apis/authen/v1/user_info", "--as", "user"]);
for (const secret of ["private-sentinel", "synthetic-open-a", "synthetic-union-a", "a@example.test"]) assert.equal(JSON.stringify(state).includes(secret), false);
const authenticatedAt = state.authenticatedAt;
clock += 61_000;
assert.equal((await adapter.status()).state, "verification_required", "expired validation cache never proves readiness");
await adapter.check();
assert.equal((await adapter.status()).authenticatedAt, authenticatedAt, "background checks preserve explicit authentication time");
auth.identities.user.expiresAt = new Date(clock + 10_000).toISOString();
await adapter.check();
clock += 11_000;
assert.equal((await adapter.status()).state, "verification_required", "access expiry requires official recheck, never automatic logout");
await adapter.check();
assert.equal((await adapter.status()).state, "verification_required", "contradictory expiry stays unverified, not logged out");
auth.identities.user.expiresAt = "2026-10-09T07:00:00Z";
await adapter.check();
info.data.union_id = "synthetic-wrong";
await adapter.check();
assert.equal((await adapter.status()).state, "account_blocked", "matching email cannot override a mismatched strong identity");
info.data.union_id = "synthetic-union-a";
info.data.open_id = "synthetic-other-login";
await adapter.connect();
assert.equal((await adapter.status()).state, "account_blocked", "CLI account switching between commands fails closed");
info.data.open_id = "synthetic-open-a";
info.identity = "bot";
await adapter.connect();
assert.equal((await adapter.status()).state, "account_blocked");
info.identity = "user";
auth.identities.user.tokenStatus = "expired";
await adapter.connect();
assert.equal((await adapter.status()).state, "expired");
auth.identities.user.tokenStatus = "valid";
failure = Object.assign(new Error("private-cli-error"), { code: "feishu_cli_missing" });
await adapter.connect();
assert.equal((await adapter.status()).state, "not_configured");
failure = new Error("private-cli-error");
await adapter.connect();
assert.equal((await adapter.status()).state, "unavailable");
assert.equal(JSON.stringify(await adapter.status()).includes("private-cli-error"), false);
failure = null;
await adapter.connect();
changeIdentity = true;
await adapter.check();
assert.equal((await adapter.status()).state, "disconnected", "same actor key with changed server identity invalidates association");
changeIdentity = false;
actor = { ...actor, feishuUnionId: "synthetic-union-a" };
await adapter.connect();
await adapter.disconnect();
assert.equal((await adapter.status()).state, "disconnected");
assert.ok(calls.every(args => !args.includes("logout") && !args.includes("login")), "association never mutates CLI credentials");
let unblock;
gate = new Promise(resolve => { unblock = resolve; });
const pending = adapter.connect();
await new Promise(resolve => setImmediate(resolve));
actor = { ...actor, key: "synthetic-b", version: 2 };
adapter.clear();
unblock();
await pending;
assert.equal((await adapter.status()).state, "disconnected", "late CLI result cannot resurrect an old actor");
gate = null;
const controller = new AbortController();
controller.abort();
await adapter.connect(undefined, { signal: controller.signal });
assert.equal((await adapter.status()).state, "disconnected");
assert.equal(feishuIdentityMatches({ feishuUnionId: "a", email: "a@example.test" }, { email: "a@example.test" }), false);
assert.equal(feishuIdentityMatches({ feishuUserId: "a" }, { open_id: "a" }), false, "open ID is not user ID");
assert.equal(feishuIdentityMatches({ email: "A@example.test" }, { enterprise_email: "a@example.test" }), true);
assert.equal(feishuIdentityMatches({}, {}), false);
actor = { ...actor, identitySource: "demo" };
await adapter.connect();
assert.equal((await adapter.status()).state, "disconnected");

const service = createDesktopSubsystemConnections({ actorContext: () => actor && ({ key: actor.key, version: actor.version }),
  isExpectedActor: () => true, adapters: new Map([["lark-cli-openapi", adapter]]) });
service.configure([{ id: "synthetic-employee", access: { selectable: true, callable: true },
  tools: [{ id: "lark-cli-openapi", name: "飞书", credentialMode: "" }] }]);
const row = (await service.list()).connections[0];
assert.equal(row.associationOnly, true);
assert.equal(row.name, "飞书");
assert.equal(subsystemConnectionPresentation(row).actionLabel, "关联已有登录");
assert.equal(subsystemConnectionPresentation({ ...row, state: "authenticated" }).label, "已关联");
assert.equal(subsystemConnectionPresentation({ ...row, state: "not_configured" }).action, "connect");
assert.equal(subsystemConnectionPresentation({ ...row, state: "expired", authenticatedAt: "2026-10-09T05:00:00Z" }).canDisconnect, true);
service.configure([{ id: "synthetic-employee", access: { selectable: true, callable: true },
  tools: [{ id: "lark-cli-openapi", credentialMode: "employee_app_lease" }] }]);
assert.deepEqual((await service.list()).connections, [], "unsupported explicit modes never inherit the local adapter mode");
service.clear();
const personalService = createDesktopSubsystemConnections({ actorContext: () => actor && ({ key: actor.key, version: actor.version }),
  isExpectedActor: () => true, adapters: new Map([["lark-cli-openapi", adapter], ["not-personal", { credentialMode: "current_user_bearer" }]]),
  personalConnectionIds: ["lark-cli-openapi", "not-personal", "not-installed"] });
personalService.configure([]);
const personalRows = (await personalService.list()).connections;
assert.equal(personalRows.length, 1, "only installed association-only adapters are discoverable without Tool grants");
assert.deepEqual(personalRows[0].employees, [], "account association does not fabricate employee Tool binding");
personalService.configure([{ id: "synthetic-employee", access: { selectable: true, callable: true },
  tools: [{ id: "lark-cli-openapi", credentialMode: "device_local_cli" }] }]);
assert.equal((await personalService.list()).connections.length, 1, "employee binding enriches the same account row, never duplicates it");
personalService.clear();
actor = null;
personalService.configure([]);
assert.equal((await personalService.list()).status, "authentication_required");
personalService.clear();
console.log("Feishu CLI current-user association, privacy, expiry, cancellation and account isolation passed");

// Official status can report pre-refresh fields despite a successful probe.
const renewalActor = { key: "renewal-synthetic", version: 1, identitySource: "fortress-sso-v3", feishuUnionId: "renewal-union" };
let renewalPhase = "valid", renewalFailure = false, switchedDuringRefresh = false;
const renewalCalls = [];
const renewalAdapter = createDesktopFeishuCliConnection({ now: () => clock, readActor: async () => renewalActor,
  isExpectedActor: () => true, run: async args => {
    renewalCalls.push(args);
    if (renewalFailure) throw new Error("synthetic-network");
    if (args[0] === "api") {
      renewalPhase = "valid";
      return { ok: true, identity: "user", data: { open_id: "renewal-open", union_id: "renewal-union" } };
    }
    return { verified: true, identities: { user: { verified: true, status: renewalPhase === "expired" ? "missing" : renewalPhase === "refresh" ? "needs_refresh" : "ready",
      tokenStatus: renewalPhase === "refresh" ? "needs_refresh" : renewalPhase, openId: switchedDuringRefresh && renewalPhase === "valid" ? "another-open" : "renewal-open",
      expiresAt: new Date(clock + (renewalPhase === "valid" ? 7200000 : -1000)).toISOString() } } };
  } });
await renewalAdapter.connect();
const renewalTime = (await renewalAdapter.status()).authenticatedAt;
renewalPhase = "refresh";
renewalCalls.length = 0;
await renewalAdapter.check();
assert.equal((await renewalAdapter.status()).state, "authenticated");
assert.equal((await renewalAdapter.status()).authenticatedAt, renewalTime);
assert.deepEqual(renewalCalls.map(args => args[0]), ["auth", "api", "auth"], "renewal rereads official state after identity probe");
renewalFailure = true;
await renewalAdapter.check();
assert.equal((await renewalAdapter.status()).state, "unavailable");
assert.equal((await renewalAdapter.status()).authenticatedAt, renewalTime, "network failure retains association history");
renewalFailure = false;
renewalPhase = "refresh";
switchedDuringRefresh = true;
await renewalAdapter.check();
assert.equal((await renewalAdapter.status()).state, "account_blocked", "account switch during renewal fails closed");
switchedDuringRefresh = false;
renewalPhase = "expired";
renewalCalls.length = 0;
await renewalAdapter.check();
assert.equal((await renewalAdapter.status()).state, "expired");
assert.deepEqual(renewalCalls.map(args => args[0]), ["auth"], "official expired diagnosis must not be treated as refreshable");
assert.ok(renewalCalls.every(args => !args.includes("login") && !args.includes("logout")));
console.log("Official CLI refresh, refreshed state reread, retained association, account fence and real expiry passed");
