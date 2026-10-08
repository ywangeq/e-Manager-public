import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { initializeLocalInstallation } from "./local-install.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const port = Number(process.env.EMANAGER_LOCAL_PORT || 14878);
if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error("invalid_local_port");
if (!fs.existsSync(path.join(root, "dist", "index.html"))) throw new Error("run_pnpm_build_before_start");
const dataDir = path.join(root, "data", "local");
const installed = initializeLocalInstallation(dataDir);
if (installed.passwordFile) console.log(`首次登录密码文件：${installed.passwordFile}`);
const secrets = JSON.parse(fs.readFileSync(path.join(dataDir, "runtime-secrets.json"), "utf8"));
if (secrets.version !== 1 || [secrets.encryptionKey, secrets.routeDigestKey].some(key =>
  typeof key !== "string" || !/^[A-Za-z0-9+/]{43}=$/.test(key) || Buffer.from(key, "base64").length !== 32)) {
  throw new Error("invalid_local_runtime_secrets_do_not_delete_existing_keys");
}
const sessionPolicy = JSON.parse(fs.readFileSync(path.join(root, "config", "local-session-policy.json"), "utf8"));
// Do not inherit another checkout's store paths, enterprise credentials or runtime configuration.
const environment = Object.fromEntries(Object.entries(process.env).filter(([key]) => ["PATH", "HOME", "USER", "TMPDIR", "LANG", "SYSTEMROOT", "WINDIR"].includes(key)));
const child = spawn(process.execPath, ["server/auth-server.mjs"], { cwd: root, stdio: "inherit", env: {
  ...environment,
  EMANAGER_LOCAL_MODE: "1",
  EMANAGER_REVIEWER_SKILL_ID: process.env.EMANAGER_REVIEWER_SKILL_ID || "",
  AUTH_SERVER_HOST: "127.0.0.1", AUTH_PUBLIC_HOST: "127.0.0.1", AUTH_SERVER_PORT: String(port),
  FRONTEND_ORIGIN: `http://127.0.0.1:${port}`,
  DIGITAL_WORKFORCE_DATA_DIR: dataDir,
  AUTH_SESSION_SECRET: secrets.sessionSecret,
  SESSION_FOUNDATION_STORE_MODE: "sqlite",
  SESSION_FOUNDATION_ENCRYPTION_KEY: secrets.encryptionKey,
  SESSION_ROUTE_DIGEST_KEY: secrets.routeDigestKey,
  SESSION_FOUNDATION_POLICY_JSON: JSON.stringify(sessionPolicy),
  SESSION_FOUNDATION_CENTER_INSTANCE_ID: "e-manager-local",
  SESSION_FOUNDATION_TENANT_SCOPE: "local",
} });
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => child.kill(signal));
child.on("error", error => { console.error(error.message); process.exitCode = 1; });
child.on("exit", code => { process.exitCode = code ?? 1; });
