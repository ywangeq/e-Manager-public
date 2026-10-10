import assert from "node:assert/strict";
import fs from "node:fs";
import crypto from "node:crypto";
import os from "node:os";
import path from "node:path";
import { createManagedFeishuReadAdapter } from "../electron/managed-feishu-read-adapter.mjs";
const resourcesPath = fs.mkdtempSync(path.join(os.tmpdir(), "synthetic-resources-"));
const dir = path.join(resourcesPath, "feishu-read"), binaryDigest = crypto.createHash("sha256").update("synthetic helper").digest("hex");
const binaryFilename = `${binaryDigest}-group-studio-feishu-read`;
const manifest = { schemaVersion: 1, contractVersion: "group-feishu-read.v3", upstreamVersion: "1.0.70",
  upstreamCommit: "80b36453621b6b5cb205ba4013244a87b340fed7", archiveDigest: "ead170a5b065e7db5e9183c754b227de9b41f633e6c3c34e5e7c7798a9d7147d",
  sourceHashes: { "main.go": "a".repeat(64), "main_test.go": "b".repeat(64), LICENSE: crypto.createHash("sha256").update("synthetic notice").digest("hex") },
  compiler: "go version go1.27.2 darwin/arm64", platform: "darwin", arch: "arm64", binaryFilename, binaryDigest };
const connection = { executeAssociatedRead: async () => {} };
const load = () => createManagedFeishuReadAdapter({ resourcesPath, connection, platform: "darwin", arch: "arm64" });
const save = value => fs.writeFileSync(path.join(dir, "manifest.json"), JSON.stringify(value));
try {
  assert.equal(load(), null);
  fs.mkdirSync(dir); fs.writeFileSync(path.join(dir, "LICENSE"), "synthetic notice"); save(manifest);
  assert.equal(load(), null, "missing binary must not advertise capability");
  fs.writeFileSync(path.join(dir, binaryFilename), "synthetic helper", { mode: 0o644 });
  assert.equal(load(), null, "nonexecutable binary must not advertise capability");
  fs.chmodSync(path.join(dir, binaryFilename), 0o555);
  assert.equal(load().toolId, "feishu-personal-read");
  for (const delta of [{ upstreamCommit: "d".repeat(40) }, { arch: "x64" }, { binaryFilename: "../helper" },
    { contractVersion: "group-feishu-read.v1" }, { sourceHashes: {} }, { arbitraryExecutable: "/bin/sh" }]) {
    save({ ...manifest, ...delta }); assert.equal(load(), null);
  }
  save(manifest); fs.chmodSync(path.join(dir, binaryFilename), 0o755); fs.writeFileSync(path.join(dir, binaryFilename), "tampered");
  assert.equal(load(), null, "tampered binary must not advertise capability");
  fs.unlinkSync(path.join(dir, binaryFilename)); fs.symlinkSync("/bin/sh", path.join(dir, binaryFilename));
  assert.equal(load(), null, "symlink is not a sealed helper");
} finally { fs.rmSync(resourcesPath, { recursive: true, force: true }); }
console.log("Managed helper missing/tamper/path/version/architecture/executable capability gates passed");
