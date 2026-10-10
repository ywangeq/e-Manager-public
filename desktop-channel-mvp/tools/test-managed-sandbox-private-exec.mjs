import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, symlink, stat, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { EventEmitter } from "node:events";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { EXEC_CONTRACT_VERSION, createDesktopManagedSandboxSupervisor } from "../electron/managed-sandbox-supervisor.mjs";

if (process.platform !== "darwin") throw new Error("macOS private exec witness requires Seatbelt");
const desktopRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const helperPath = process.env.MANAGED_SANDBOX_HELPER_PATH || path.join(desktopRoot, "native/managed-sandbox-helper/target/debug/managed-sandbox-helper");
const root = await mkdtemp(path.join(os.tmpdir(), "dw-private-exec-"));
const workspaceRoot = path.join(root, "workspace");
const outside = path.join(root, "private-canary");
const quote = (value) => `'${value.replaceAll("'", "'\\''")}'`;
const server = createServer((_request, response) => response.end("exec-network-ok"));
let homeCanary = "";
try {
  await mkdir(workspaceRoot);
  await writeFile(outside, "host-secret-canary");
  await symlink(outside, path.join(workspaceRoot, "escape"));
  await mkdir(path.join(workspaceRoot, ".git"));
  homeCanary = await mkdtemp(path.join(os.homedir(), ".dw-exec-canary-"));
  await writeFile(path.join(homeCanary, "credential"), "host-secret-canary");
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const supervisor = createDesktopManagedSandboxSupervisor({ helperPath });
  const run = (commandText, networkAccess = false, timeoutMs = 4_000) => supervisor.executePrivateRequest({ commandText, networkAccess, timeoutMs, workspaceRoot });
  const failed = await run("printf hello; printf diagnostic >&2; exit 7");
  assert.deepEqual(failed, { contractVersion: EXEC_CONTRACT_VERSION, status: "failed", stdout: "hello", stderr: "diagnostic", exitCode: 7, outputTruncated: false });
  for (const target of [outside, path.join(workspaceRoot, "escape"), path.join(homeCanary, "credential")]) {
    const denied = await run(`/bin/cat ${quote(target)}`, true);
    assert.equal(denied.status, "failed");
    assert.ok(!denied.stdout.includes("host-secret-canary"));
  }
  assert.equal((await run(`printf changed > ${quote(outside)}`, true)).status, "failed");
  assert.equal((await run("printf forbidden > .git/config")).status, "failed");
  assert.equal((await run("printf artifact > artifact.txt")).status, "completed");
  assert.equal((await stat(path.join(workspaceRoot, "artifact.txt"))).isFile(), true);
  const bulk = await run("/usr/bin/awk 'BEGIN {for(i=0;i<80000;i++){printf \"x\";printf \"y\" > \"/dev/stderr\"}}'");
  assert.equal(bulk.status, "completed");
  assert.ok(bulk.stdout.length <= 32 * 1024 + 64);
  assert.match(bulk.stdout, /bytes omitted/);
  assert.ok(bulk.stderr.length <= 32 * 1024 + 64);
  assert.match(bulk.stderr, /bytes omitted/);
  assert.equal(bulk.outputTruncated, true);
  const tail = await run("printf BEGIN; /usr/bin/awk 'BEGIN {for(i=0;i<80000;i++) printf \"x\"}'; printf END");
  assert.ok(tail.stdout.startsWith("BEGIN"));
  assert.ok(tail.stdout.endsWith("END"));
  assert.match(tail.stdout, /bytes omitted/);
  const escapedJson = await run("/usr/bin/awk 'BEGIN {for(i=0;i<40000;i++) printf \"%c\",0}'");
  assert.equal([...escapedJson.stdout].filter(char => char === "\0").length, 32 * 1024);
  assert.match(escapedJson.stdout, /bytes omitted/);
  assert.equal(escapedJson.outputTruncated, true);
  assert.equal((await run("printf '\\377'")).stdout, "\ufffd");
  const invalidBulk = await run("/usr/bin/awk 'BEGIN {for(i=0;i<40000;i++) printf \"%c\",255}'");
  assert.equal(invalidBulk.status, "completed");
  assert.match(invalidBulk.stdout, /bytes omitted/);
  assert.equal([...invalidBulk.stdout].filter(char => char === "\ufffd").length, 32 * 1024);
  const url = `http://127.0.0.1:${server.address().port}/`;
  assert.equal((await run(`/usr/bin/curl -fsS --max-time 1 ${quote(url)}`)).status, "failed");
  const network = await run(`/usr/bin/curl -fsS --max-time 1 ${quote(url)}`, true);
  assert.equal(network.stdout, "exec-network-ok");
  assert.equal(network.exitCode, 0);
  const timed = await run("/usr/bin/yes; sleep 10", false, 150);
  assert.equal(timed.status, "timed_out");
  assert.equal(timed.outputTruncated, true);
  const descendants = await run("(trap '' TERM; sleep 1; touch escaped.txt) & printf parent");
  assert.equal(descendants.stdout, "parent");
  await new Promise((resolve) => setTimeout(resolve, 1_100));
  await assert.rejects(stat(path.join(workspaceRoot, "escaped.txt")));
  const controller = new AbortController();
  const canceled = supervisor.executePrivateRequest({ commandText: "sleep 1; touch canceled.txt", networkAccess: false, timeoutMs: 4_000, workspaceRoot }, { signal: controller.signal });
  setTimeout(() => controller.abort(), 100);
  assert.equal((await canceled).status, "canceled");
  await new Promise((resolve) => setTimeout(resolve, 1_100));
  await assert.rejects(stat(path.join(workspaceRoot, "canceled.txt")));
  const legacy = new EventEmitter();
  legacy.stdout = new EventEmitter();
  legacy.stdout.setEncoding = () => {};
  legacy.stdin = { end() { queueMicrotask(() => {
    legacy.stdout.emit("data", JSON.stringify({ contractVersion: "managed-sandbox-helper.internal.v1", status: "completed" }));
    legacy.emit("close", 0);
  }); } };
  const oldHelper = createDesktopManagedSandboxSupervisor({ helperPath, spawnProcess: () => legacy });
  // The v2 caller must not interpret a status-only v1 result as private output.
  assert.equal((await oldHelper.executePrivateRequest({ commandText: "true", networkAccess: false, timeoutMs: 4_000, workspaceRoot })).status, "unavailable");
  assert.equal((await run("true", "yes")).status, "rejected");
  if (process.env.EXEC_PUBLIC_NETWORK_WITNESS === "1") {
    const https = await run("/usr/bin/curl -fsSI --max-time 5 https://example.com", true, 8_000);
    assert.equal(https.exitCode, 0);
    assert.match(https.stdout, /HTTP\/2 200|HTTP\/1.1 200/);
  }
  console.log("macOS private exec output, network and isolation witness passed");
} finally {
  await new Promise((resolve) => server.close(resolve));
  await rm(root, { recursive: true, force: true });
}
