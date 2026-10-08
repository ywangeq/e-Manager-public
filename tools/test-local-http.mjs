import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import http from "node:http";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { initializeLocalInstallation } from "./local-install.mjs";

test("isolated Center login, authorization, empty catalogs and logout", async () => {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const data = fs.mkdtempSync(path.join(os.tmpdir(), "e-manager-http-"));
  initializeLocalInstallation(data, { password: "http-local-password-123" });
  const keys = JSON.parse(fs.readFileSync(path.join(data, "runtime-secrets.json"), "utf8"));
  const probe = net.createServer();
  await new Promise(resolve => probe.listen(0, "127.0.0.1", resolve));
  const port = probe.address().port;
  await new Promise(resolve => probe.close(resolve));
  const origin = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, ["server/auth-server.mjs"], { cwd: root, stdio: ["ignore", "pipe", "pipe"], env: {
    PATH: process.env.PATH, HOME: process.env.HOME,
    EMANAGER_LOCAL_MODE: "1", AUTH_SERVER_HOST: "127.0.0.1", AUTH_PUBLIC_HOST: "127.0.0.1",
    AUTH_SERVER_PORT: String(port), FRONTEND_ORIGIN: origin, DIGITAL_WORKFORCE_DATA_DIR: data,
    AUTH_SESSION_SECRET: keys.sessionSecret,
    SESSION_FOUNDATION_STORE_MODE: "sqlite", SESSION_FOUNDATION_CENTER_INSTANCE_ID: "local-http-test",
    SESSION_FOUNDATION_TENANT_SCOPE: "local-test", SESSION_FOUNDATION_ENCRYPTION_KEY: keys.encryptionKey,
    SESSION_ROUTE_DIGEST_KEY: keys.routeDigestKey,
    SESSION_FOUNDATION_POLICY_JSON: fs.readFileSync(path.join(root, "config/local-session-policy.json"), "utf8"),
  } });
  let output = "";
  child.stdout.on("data", bytes => { output += bytes; });
  child.stderr.on("data", bytes => { output += bytes; });
  try {
    let ready = false;
    for (let i = 0; i < 100; i++) {
      ready = await fetch(`${origin}/api/health`).then(r => r.ok).catch(() => false);
      if (ready) break;
      if (child.exitCode !== null) throw new Error(output);
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    assert.equal(ready, true, output);
    assert.equal((await fetch(origin)).status, 200);
    assert.equal((await fetch(`${origin}/api/me`)).status, 401);
    const login = (password, extra = {}) => fetch(`${origin}/api/auth/demo/login`, {
      method: "POST", headers: { "Content-Type": "application/json", ...extra },
      body: JSON.stringify({ email: "admin@localhost", password }),
    });
    assert.equal((await login("wrong-password")).status, 401);
    assert.equal((await login("http-local-password-123", { Origin: "https://other.example" })).status, 403);
    assert.equal(await new Promise((resolve, reject) => {
      const request = http.get(`${origin}/api/health`, { headers: { Host: "other.example" } }, response => { response.resume(); resolve(response.statusCode); });
      request.on("error", reject);
    }), 403);
    const response = await login("http-local-password-123", { Origin: origin });
    assert.equal(response.status, 200);
    const cookie = response.headers.get("set-cookie").split(";")[0];
    const current = await fetch(`${origin}/api/me`, { headers: { Cookie: cookie } });
    assert.equal(current.status, 200);
    assert.equal((await current.json()).session.email, "admin@localhost");
    assert.equal((await fetch(`${origin}/api/auth/session/revalidate`, { method: "POST", headers: { Cookie: cookie } })).status, 200);
    for (const [route, field] of [["digital-employees", "digitalEmployees"], ["basic-skills", "basicSkills"], ["business-skills", "businessSkills"]]) {
      const r = await fetch(`${origin}/api/${route}`, { headers: { Cookie: cookie } });
      assert.equal(r.status, 200, route);
      assert.deepEqual((await r.json())[field], [], route);
    }
    assert.equal((await fetch(`${origin}/api/auth/sso/start`)).status, 503);
    assert.equal((await fetch(`${origin}/api/auth/logout`, { method: "POST", headers: { Cookie: cookie } })).status, 200);
    assert.equal((await fetch(`${origin}/api/me`, { headers: { Cookie: cookie } })).status, 401);
  } finally {
    if (child.exitCode === null) { child.kill("SIGTERM"); await new Promise(resolve => child.once("exit", resolve)); }
    fs.rmSync(data, { recursive: true, force: true });
  }
});
