import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import { PassThrough, Writable } from "node:stream";
import { createFeishuReadHelperClient } from "../electron/feishu-read-helper-client.mjs";
import { FEISHU_CALENDAR_READ_DESCRIPTOR as descriptor } from "../shared/feishu-calendar-read-contract.mjs";

const temp = fs.mkdtempSync(path.join(os.tmpdir(), "synthetic-helper-"));
const binary = path.join(temp, "helper");
fs.writeFileSync(binary, "synthetic binary");
const digest = crypto.createHash("sha256").update(fs.readFileSync(binary)).digest("hex");
const input = { start: "2026-10-09T00:00:00Z", end: "2026-10-10T00:00:00Z",
  account: { appId: "synthetic_app", openId: "synthetic_open", unionId: "synthetic_union" } };
const data = { events: [{ eventRef: "synthetic_event", title: "private_title_sentinel", start: input.start, end: input.end }] };
let launches = 0, mode = "good", child, stdin;
const launch = (executable, args, options) => {
  launches++;
  assert.equal(executable, binary); assert.deepEqual(args, []);
  assert.deepEqual(options.stdio, ["pipe", "pipe", "pipe"]);
  child = new EventEmitter(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
  stdin = "";
  child.stdin = new Writable({ write(chunk, encoding, done) { stdin += chunk.toString(); done(); } });
  child.killedSignals = [];
  child.kill = signal => { child.killedSignals.push(signal); queueMicrotask(() => child.emit("close", null)); };
  child.stdin.on("finish", () => queueMicrotask(() => {
    assert.deepEqual(JSON.parse(stdin), { contractVersion: "group-feishu-read.v3", operationId: descriptor.operationId, ...input.account, start: input.start, end: input.end });
    child.stderr.write("private_vendor_error_sentinel");
    if (mode === "waiting") return;
    if (mode === "overflow") child.stdout.write(Buffer.alloc(36 * 1024 + 1));
    else if (mode === "error") child.emit("error", Error("private_path_sentinel"));
    else child.stdout.write(JSON.stringify(mode === "bad" ? { ok: true, data, access_token: "private_token" } : { ok: true, data }));
    child.emit("close", mode === "exit" ? 1 : 0);
  }));
  return child;
};
try {
  const read = createFeishuReadHelperClient({ executablePath: binary, executableDigest: digest, launch });
  assert.deepEqual(await read(input), data);
  assert.ok(Object.isFrozen(descriptor.resultSchema.properties.events.items.properties));
  assert.throws(() => descriptor.normalizeResult({ events: [{ ...data.events[0], end: "2026-10-10" }] }), /event_invalid/);
  for (mode of ["bad", "overflow", "error", "exit"]) await assert.rejects(read(input), { message: "feishu_read_unavailable" });
  mode = "waiting";
  const controller = new AbortController();
  const pending = read(input, { signal: controller.signal });
  controller.abort();
  await assert.rejects(pending, { message: "feishu_read_canceled" });
  assert.deepEqual(child.killedSignals, ["SIGTERM"]);
  const previous = launches;
  await assert.rejects(read(input, { signal: controller.signal }), /canceled/);
  for (const account of [{ ...input.account, access_token: "private_token" }, { ...input.account, appId: "../other" }])
    await assert.rejects(read({ ...input, account }), /identity_unavailable/);
  fs.writeFileSync(binary, "tampered");
  await assert.rejects(read(input), { message: "feishu_read_helper_integrity_invalid" });
  fs.unlinkSync(binary); fs.symlinkSync("/not-found-synthetic", binary);
  await assert.rejects(read(input), { message: "feishu_read_helper_integrity_invalid" });
  assert.equal(launches, previous, "invalid account/binary/cancellation never launches helper");
} finally { fs.rmSync(temp, { recursive: true, force: true }); }
console.log("Private helper fixed path/digest/stdin/result/privacy/cancellation checks passed");
