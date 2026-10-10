import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createFeishuAssociationIntentStore } from "../electron/feishu-association-intent-store.mjs";
import { createDesktopFeishuCliConnection } from "../electron/desktop-feishu-cli-connection.mjs";
import { createDesktopSubsystemConnections } from "../electron/desktop-subsystem-connections.mjs";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "feishu-intent-"));
try {
  const file = path.join(root, "intent.json");
  const store = () => createFeishuAssociationIntentStore({ filePath: file, centerOrigin: "https://synthetic.example.test" });
  let actor = { key: "synthetic-a", version: 1, identitySource: "fortress-sso-v3", feishuUnionId: "synthetic-union" };
  let mismatch = false, failure = false, gate = null;
  const calls = [];
  const create = () => createDesktopFeishuCliConnection({ intentStore: store(), actorContext: () => actor,
    readActor: async () => ({ ...actor }), isExpectedActor: (key, version) => key === actor.key && version === actor.version,
    run: async args => {
      calls.push(args);
      if (gate) await gate;
      if (failure) throw new Error("private-network-error");
      return args[0] === "auth" ? { verified: true, identities: { user: { verified: true, status: "ready", tokenStatus: "valid", openId: "synthetic-open" } } }
        : { ok: true, identity: "user", data: { open_id: "synthetic-open", union_id: mismatch ? "another-person" : actor.feishuUnionId } };
    } });
  let adapter = create();
  await adapter.check();
  assert.equal(calls.length, 0, "first use never automatically associates");
  await adapter.connect();
  assert.equal((await adapter.status()).state, "authenticated");
  const disk = fs.readFileSync(file, "utf8");
  for (const privateValue of [actor.key, actor.feishuUnionId, "synthetic-open", "authenticated", "token"]) assert.equal(disk.includes(privateValue), false);
  if (process.platform !== "win32") assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  adapter = create();
  assert.equal((await adapter.status()).state, "verification_required", "disk intent is not authentication");
  const service = createDesktopSubsystemConnections({ actorContext: () => actor, isExpectedActor: () => true,
    adapters: new Map([["lark-cli-openapi", adapter]]), personalConnectionIds: ["lark-cli-openapi"] });
  service.configure([]);
  await service.checkAll();
  assert.equal((await adapter.status()).state, "authenticated", "startup check restores only after CLI and current actor verification");
  service.clear();
  adapter.clear();
  assert.equal((await adapter.status()).state, "verification_required", "ordinary logout/clear retains preference, not authentication");
  mismatch = true;
  await adapter.check();
  assert.equal((await adapter.status()).state, "account_blocked");
  mismatch = false; failure = true;
  await adapter.check();
  assert.equal((await adapter.status()).state, "unavailable");
  assert.equal(store().has(actor.key), true, "offline check retains preference");
  failure = false;
  await adapter.disconnect();
  adapter = create();
  calls.length = 0;
  await adapter.check();
  assert.equal((await adapter.status()).state, "disconnected");
  assert.equal(calls.length, 0, "explicit disconnect persists across restart");
  let finish;
  gate = new Promise(resolve => { finish = resolve; });
  const pending = adapter.connect();
  await new Promise(resolve => setImmediate(resolve));
  await adapter.disconnect();
  finish(); await pending; gate = null;
  assert.equal(store().has(actor.key), false, "late connect cannot revive disconnected intent");
  await adapter.connect();
  actor = { ...actor, key: "synthetic-b", version: 2 };
  adapter.clear();
  calls.length = 0;
  await adapter.check();
  assert.equal(calls.length, 0, "a different actor cannot inherit the preference");
  actor = { ...actor, key: "synthetic-a", version: 3 };
  adapter = create();
  const controller = new AbortController(); controller.abort();
  await adapter.check(undefined, { signal: controller.signal });
  assert.equal((await adapter.status()).state, "verification_required", "aborted restore never authenticates");
  assert.equal(createFeishuAssociationIntentStore({ filePath: file, centerOrigin: "https://another.example.test" }).has(actor.key), false);
  fs.writeFileSync(file, '{"version":2,"actors":[]}');
  assert.throws(() => store().has(actor.key), /preference_unavailable/);
  assert.ok(calls.every(args => !args.includes("login") && !args.includes("logout")));
  console.log("Feishu restart revalidation, local preference privacy, disconnect, actor and cancellation checks passed");
} finally { fs.rmSync(root, { recursive: true, force: true }); }
