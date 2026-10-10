import { randomUUID } from "node:crypto";
import { execFile, spawn } from "node:child_process";
import { access } from "node:fs/promises";
import { constants } from "node:fs";
import os from "node:os";
import path from "node:path";
import { feishuCliExecutable, runFeishuCliResult } from "./desktop-feishu-cli-connection.mjs";

export const feishuInstallDirectory = () => path.join(os.homedir(), ".local", "share", "group-studio-feishu");
export async function inspectFeishuSetup(run = runFeishuCliResult) {
  try {
    const result = await run(["profile", "list"]);
    if (result.failed || !Array.isArray(result.value)) return { cli: "installed", app: "unknown" };
    return { cli: "installed", app: result.value.length ? "configured" : "missing" };
  } catch (error) { return { cli: error.code === "feishu_cli_missing" ? "missing" : "installed", app: "unknown" }; }
}
async function findNodeNpm() {
  const directories = [...(process.env.PATH || "").split(path.delimiter), "/opt/homebrew/bin", "/usr/local/bin", path.join(process.env.ProgramFiles || "C:\\Program Files", "nodejs")];
  for (const directory of directories.filter(path.isAbsolute)) {
    const node = path.join(directory, process.platform === "win32" ? "node.exe" : "node");
    const npm = path.join(directory, process.platform === "win32" ? "node_modules/npm/bin/npm-cli.js" : "../lib/node_modules/npm/bin/npm-cli.js");
    try { await access(node, constants.X_OK); await access(npm); return { node, npm }; } catch { /* next location */ }
  }
  throw new Error("node_missing");
}
export async function installFeishuCli({ signal }) {
  // User-local, pinned CLI only: no sudo, global Skills, shell or install wizard.
  const { node, npm } = await findNodeNpm();
  await new Promise((resolve, reject) => execFile(node, [npm, "install", "--prefix", feishuInstallDirectory(), "--no-audit", "--no-fund", "@larksuite/cli@1.0.70"],
    { signal, timeout: 180_000, maxBuffer: 256 * 1024, windowsHide: true,
      env: { ...process.env, PATH: `${path.dirname(node)}${path.delimiter}${process.env.PATH || ""}` } }, error => error ? reject(new Error("install_failed")) : resolve()));
  await feishuCliExecutable();
}
export async function createFeishuApp({ signal, onUrl }) {
  const executable = await feishuCliExecutable();
  return await new Promise((resolve, reject) => {
    const child = spawn(executable, ["config", "init", "--new", "--name", `group-studio-${randomUUID()}`, "--brand", "feishu", "--lang", "zh_cn"], {
      signal, windowsHide: true, stdio: ["ignore", "ignore", "pipe"],
      env: { ...process.env, LARKSUITE_CLI_NO_UPDATE_NOTIFIER: "1", LARKSUITE_CLI_NO_SKILLS_NOTIFIER: "1" },
    });
    let tail = "", delivered = false;
    const timeout = setTimeout(() => { child.kill(); reject(new Error("setup_expired")); }, 600_000);
    timeout.unref?.();
    child.stderr.on("data", chunk => {
      tail = (tail + chunk.toString()).slice(-8192);
      if (!delivered) for (const match of tail.matchAll(/https:\/\/[^\s<>"']+/g)) {
        try { const url = new URL(match[0]); if (url.origin === "https://open.feishu.cn" && url.pathname === "/page/cli" && !url.username && !url.password && !url.hash) { delivered = true; onUrl(url.toString()); break; } } catch { /* no raw output */ }
      }
    });
    child.once("error", () => { clearTimeout(timeout); reject(new Error("setup_failed")); });
    child.once("close", code => { clearTimeout(timeout); tail = ""; code === 0 ? resolve() : reject(new Error("setup_failed")); });
  });
}
