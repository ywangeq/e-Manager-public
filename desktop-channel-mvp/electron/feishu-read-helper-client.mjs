import buildContract from "../shared/feishu-read-build.cjs";
import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { FEISHU_CALENDAR_READ_DESCRIPTOR } from "../shared/feishu-calendar-read-contract.mjs";

// executablePath/digest are supplied by the managed package, never renderer input.
export function createFeishuReadHelperClient({ executablePath, executableDigest, launch = spawn, descriptor = FEISHU_CALENDAR_READ_DESCRIPTOR } = {}) {
  if (!path.isAbsolute(executablePath || "") || !/^[a-f0-9]{64}$/.test(executableDigest || "")) throw new TypeError("feishu_read_helper_config_invalid");
  return async function read({ account, ...input }, { signal } = {}) {
    if (signal?.aborted) throw new Error("feishu_read_canceled");
    const normalized = descriptor.normalizeInput(input);
    if (!account || Object.keys(account).length !== 3 || ![account.appId, account.openId].every(identifier) ||
      !(account.unionId === "" || identifier(account.unionId))) throw new Error("feishu_read_identity_unavailable");
    verifyFeishuReadHelperIntegrity(executablePath, executableDigest);
    const request = { contractVersion: buildContract.FEISHU_READ_BUILD.contractVersion, ...account, operationId: descriptor.operationId, ...normalized };
    return await new Promise((resolve, reject) => {
      let child, timer, forceKill, closed = false, finished = false, count = 0, chunks = [];
      const fail = () => {
        if (finished) return;
        finish(new Error(signal?.aborted ? "feishu_read_canceled" : "feishu_read_unavailable"));
        if (child && !closed) {
          child.kill("SIGTERM");
          forceKill = setTimeout(() => { if (!closed) child.kill("SIGKILL"); }, 500); forceKill.unref?.();
        }
      };
      const finish = (error, value) => {
        if (finished) return;
        finished = true; clearTimeout(timer); signal?.removeEventListener("abort", fail);
        chunks = [];
        if (error) reject(error); else resolve(value);
      };
      try {
        child = launch(executablePath, [], { stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
        child.stdout.on("data", chunk => { count += chunk.length; if (count > 36 * 1024) fail(); else if (!finished) chunks.push(chunk); });
        child.stderr.on("data", () => {}); // Drain privately; never log vendor errors.
        child.on("error", fail);
        child.stdin.on("error", fail);
        child.on("close", code => {
          closed = true; clearTimeout(forceKill);
          if (finished) return;
          if (code !== 0 || signal?.aborted) return fail();
          try {
            const response = JSON.parse(Buffer.concat(chunks).toString("utf8"));
            if (!response || response.ok !== true || Object.keys(response).sort().join(",") !== "data,ok") throw new Error();
            finish(null, descriptor.normalizeResult(response.data));
          } catch { fail(); }
        });
        timer = setTimeout(fail, 30_000); timer.unref?.();
        signal?.addEventListener("abort", fail, { once: true });
        if (signal?.aborted) return fail();
        child.stdin.end(JSON.stringify(request));
      } catch { fail(); }
    });
  };
}
function identifier(value) { return typeof value === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(value); }

export function verifyFeishuReadHelperIntegrity(executablePath, executableDigest, { requireExecutable = false } = {}) {
  try {
    const stat = fs.lstatSync(executablePath);
    if (!stat.isFile() || stat.size > 100 * 1024 * 1024 || (requireExecutable && process.platform !== "win32" && !(stat.mode & 0o111))) throw new Error();
    if (crypto.createHash("sha256").update(fs.readFileSync(executablePath)).digest("hex") !== executableDigest) throw new Error();
  } catch { throw new Error("feishu_read_helper_integrity_invalid"); }
}
