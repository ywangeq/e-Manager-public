import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { inspectFeishuSetup, installFeishuCli, createFeishuApp } from "./desktop-feishu-setup.mjs";
import { FEISHU_READ_PERMISSIONS } from "../shared/feishu-authorization-scopes.mjs";
import { feishuCliExecutable, runFeishuCliResult } from "./desktop-feishu-cli-connection.mjs";

export function validFeishuVerificationUrl(value) {
  try {
    const url = new URL(value);
    return url.origin === "https://accounts.feishu.cn" && !url.username && !url.password && !url.hash
      && url.pathname.startsWith("/") && value.length <= 4096;
  } catch { return false; }
}

export function validFeishuSetupUrl(value) {
  try { const url = new URL(value); return url.origin === "https://open.feishu.cn" && url.pathname === "/page/cli" && !url.username && !url.password && !url.hash && value.length <= 4096; } catch { return false; }
}

export function feishuMissingScopes(result, requested) {
  const value = result?.value;
  if (Array.isArray(value?.missing) && value.missing.length > 0) {
    return value.missing.every(scope => typeof scope === "string" && requested.includes(scope)) ? value.missing : null;
  }
  // Go nil slice is serialized as null by installed CLI1.0.70.
  if (!result?.failed && value?.ok === true && (value.missing === null || Array.isArray(value.missing) && value.missing.length === 0) && Array.isArray(value.granted)
    && requested.every(scope => value.granted.includes(scope))) return [];
  return null;
}

// Device code and CLI completion identities never leave this main-process service.
export function createDesktopFeishuAuthorization({ actorContext, isExpectedActor, connection,
  run = runFeishuCliResult, install = installFeishuCli, configure = createFeishuApp, qr = createFeishuQr, openExternal, now = () => Date.now() }) {
  let session = null;
  let sequence = 0;
  let inspecting = null;
  let setup = { cli: "unknown", app: "unknown" };
  let permissions = { phase: "unknown", items: [] };
  function cancel() {
    sequence++;
    session?.controller.abort();
    session = null;
  }
  function clear() { cancel(); setup = { cli: "unknown", app: "unknown" }; permissions = { phase: "unknown", items: [] }; inspecting = null; }
  function current(item) {
    return session === item && !item.controller.signal.aborted &&
      isExpectedActor(item.actor.key, item.actor.version);
  }
  function snapshot() {
    if (session && !isExpectedActor(session.actor.key, session.actor.version)) clear();
    if (session?.phase === "waiting" && now() >= session.expiresAt) {
      session.controller.abort(); session.phase = "expired"; session.deviceCode = ""; session.url = ""; session.qr = "";
    }
    return { ok: true, phase: session?.phase || "idle", expiresAt: session?.phase === "waiting" ? session.expiresAt : null,
      verificationUrl: ["waiting", "configuring_browser"].includes(session?.phase) ? session.url : "", qrImage: session?.phase === "waiting" ? session.qr : "",
      setup, permissions, retainedScopeCount: session?.retainedScopeCount || 0, requested: session?.requested || [] };
  }
  async function inspect() {
    if (inspecting) return inspecting;
    const actor = actorContext(), revision = sequence;
    const pending = (async () => {
      try {
        const detected = await inspectFeishuSetup(run);
        if (revision !== sequence || !isExpectedActor(actor.key, actor.version)) return;
        setup = detected;
        if (setup.cli === "missing") { permissions = { phase: "cli_missing", items: [] }; return; }
        await connection.check?.();
        if (revision !== sequence || !isExpectedActor(actor.key, actor.version)) return;
        const [auth, app] = await Promise.all([
          run(["auth", "status", "--json", "--verify"]), run(["auth", "scopes", "--json"]),
        ]);
        if (revision !== sequence || !isExpectedActor(actor.key, actor.version)) return;
        const granted = new Set(String(auth.value.identities?.user?.scope || "").split(/\s+/));
        const available = !app.failed && Array.isArray(app.value.userScopes) ? new Set(app.value.userScopes) : null;
        const associated = (await connection.status()).state === "authenticated";
        permissions = { phase: app.failed || !available ? "unavailable" : "ready", items: FEISHU_READ_PERMISSIONS.map(item => ({
          ...item, state: auth.value.verified === true && auth.value.identities?.user?.verified === true && auth.value.identities?.user?.tokenStatus === "valid"
            && (!auth.value.identities.user.expiresAt || Date.parse(auth.value.identities.user.expiresAt) > now()) && (item.scopes || [item.scope]).every(scope => granted.has(scope))
            ? associated ? "granted" : "cli_granted" : available ? (item.scopes || [item.scope]).every(scope => available.has(scope)) ? "needs_authorization" : "needs_app_permission" : "unknown",
        })) };
      } catch (error) {
        if (revision === sequence && isExpectedActor(actor.key, actor.version)) permissions = {
          phase: error.code === "feishu_cli_missing" ? "cli_missing" : "unavailable", items: [],
        };
      }
    })().finally(() => { if (inspecting === pending) inspecting = null; });
    inspecting = pending;
    await pending;
  }
  async function begin(ids, frozenScopes = null) {
    cancel();
    const actor = actorContext();
    const requested = FEISHU_READ_PERMISSIONS.filter(item => ids.includes(item.id));
    const item = { actor, requested: requested.map(entry => entry.id), controller: new AbortController(), phase: "starting" };
    session = item;
    try {
      // CLI 1.0.70 replaces stored scope on login. Preserve only online-verified
      // grants of an already associated current account, never another profile user.
      await connection.check?.(undefined, { signal: item.controller.signal });
      if (!current(item)) return;
      const auth = await run(["auth", "status", "--json", "--verify"], { signal: item.controller.signal });
      if (!current(item)) return;
      const user = auth.value.identities?.user;
      const previousScopes = typeof user?.scope === "string" ? user.scope.split(/\s+/).filter(Boolean) : [];
      const hasLogin = Boolean(user?.openId);
      if (hasLogin) {
        await connection.check?.(undefined, { signal: item.controller.signal });
        if (!current(item)) return;
        if (auth.failed || auth.value.verified !== true || user.verified !== true || user.tokenStatus !== "valid"
          || (await connection.status()).state !== "authenticated") {
          item.phase = "existing_login_unverified"; return;
        }
      }
      if (previousScopes.length > 300 || previousScopes.some(scope => !/^[a-zA-Z0-9_:.-]{1,150}$/.test(scope))) {
        item.phase = "failed"; return;
      }
      const scopes = [...new Set([...previousScopes, ...requested.flatMap(entry => entry.scopes || [entry.scope])])];
      if (frozenScopes && (scopes.length !== frozenScopes.length || scopes.some(scope => !frozenScopes.includes(scope)))) {
        item.phase = "existing_login_unverified"; return;
      }
      item.scopeSet = scopes;
      item.previousScopes = previousScopes;
      item.retainedScopeCount = previousScopes.length;
      // Initialization is a short request; only token polling gets a longer deadline.
      const result = await run(["auth", "login", "--scope", scopes.join(" "), "--no-wait", "--json"], { signal: item.controller.signal, timeout: 30_000 });
      if (!current(item)) return;
      const value = result.value;
      if (result.failed || !validFeishuVerificationUrl(value.verification_url) || typeof value.device_code !== "string" || !value.device_code
        || value.device_code.length > 4096 || !Number.isFinite(value.expires_in) || value.expires_in <= 0 || value.expires_in > 900) {
        item.phase = "failed"; return;
      }
      item.deviceCode = value.device_code;
      item.url = value.verification_url;
      item.expiresAt = now() + value.expires_in * 1000;
      item.qr = await qr(item.url, { signal: item.controller.signal });
      if (!current(item)) return;
      if (now() >= item.expiresAt) { item.phase = "expired"; return; }
      item.phase = "waiting";
      void finish(item);
    } catch (error) {
      if (current(item)) item.phase = error.code === "feishu_cli_missing" ? "cli_missing" : "failed";
    } finally {
      if (item.phase !== "waiting") { item.deviceCode = ""; item.url = ""; item.qr = ""; }
    }
  }
  async function finish(item) {
    const deadline = setTimeout(() => { if (current(item)) { item.phase = "expired"; item.controller.abort(); } }, Math.max(1, item.expiresAt - now()));
    deadline.unref?.();
    try {
      const result = await run(["auth", "login", "--device-code", item.deviceCode, "--json"], { signal: item.controller.signal, timeout: Math.min(600_000, item.expiresAt - now()) });
      if (!current(item) || now() >= item.expiresAt) return;
      if (result.value.event !== "authorization_complete" || result.failed &&
        !(result.value.warning?.type === "missing_scope" && Array.isArray(result.value.missing) && result.value.missing.length > 0)) { item.phase = "failed"; return; }
      item.phase = "verifying";
      await connection.connect(undefined, { signal: item.controller.signal });
      if (!current(item)) return;
      const state = await connection.status();
      const scopeCheck = await run(["auth", "check", "--scope", item.scopeSet.join(" "), "--json"], { signal: item.controller.signal });
      if (!current(item)) return;
      const missing = feishuMissingScopes(scopeCheck, item.scopeSet);
      const lostPrevious = missing && item.previousScopes.some(scope => missing.includes(scope));
      await inspect();
      if (!current(item)) return;
      item.phase = state.state !== "authenticated" ? "account_blocked"
        : lostPrevious ? "permissions_changed"
        : !missing || scopeCheck.failed && scopeCheck.value.ok !== false ? "permissions_unavailable"
        : permissions.phase !== "ready" ? "permissions_unavailable"
        : item.requested.every(id => permissions.items.find(entry => entry.id === id)?.state === "granted")
          && !(result.value.missing?.length) && !missing.length ? "complete" : "partial";
    } catch {
      if (current(item)) item.phase = "failed";
    } finally {
      clearTimeout(deadline);
      item.deviceCode = "";
      if (item.phase !== "waiting") { item.url = ""; item.qr = ""; }
    }
  }
  async function startSetup(action) {
    cancel();
    const item = { actor: actorContext(), controller: new AbortController(), phase: action === "install" ? "installing" : "configuring" };
    session = item;
    void (async () => {
      try {
        const detected = await inspectFeishuSetup(run);
        if (!current(item)) return;
        setup = detected;
        if (action === "install") {
          if (detected.cli === "missing") await install({ signal: item.controller.signal });
        } else {
          // Refuse existing profiles at admission; CLI has no cross-process config lock.
          if (detected.cli !== "installed" || detected.app !== "missing") { item.phase = "configuration_blocked"; return; }
          await configure({ signal: item.controller.signal, onUrl: url => {
            if (current(item) && validFeishuSetupUrl(url)) { item.url = url; item.expiresAt = now() + 600_000; item.phase = "configuring_browser"; }
          } });
        }
        if (!current(item)) return;
        item.phase = "idle"; item.url = "";
        await inspect();
      } catch (error) { if (current(item)) item.phase = error.message === "node_missing" ? "node_missing" : "setup_failed"; }
      finally { if (item.phase !== "configuring_browser") item.url = ""; }
    })();
  }
  async function request(input = {}) {
    if (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input).some(key => !["action", "permissions"].includes(key))) return { ok: false };
    const actor = actorContext();
    if (!actor?.key || !isExpectedActor(actor.key, actor.version)) { clear(); return { ok: false }; }
    if (input.action === "status") return snapshot();
    if (["install", "configure"].includes(input.action)) {
      if (["starting", "waiting", "verifying", "installing", "configuring", "configuring_browser"].includes(snapshot().phase)) return { ok: false };
      await startSetup(input.action); return snapshot();
    }
    if (input.action === "inspect") { await inspect(); return snapshot(); }
    if (input.action === "refresh" && snapshot().phase === "expired") {
      const ids = session.requested, scopes = session.scopeSet;
      await begin(ids, scopes); return snapshot();
    }
    if (input.action === "cancel") { cancel(); return snapshot(); }
    if (input.action === "open" && ["waiting", "configuring_browser"].includes(session?.phase) && (session.phase === "configuring_browser" ? validFeishuSetupUrl(session.url) : validFeishuVerificationUrl(session.url)) && now() < session.expiresAt) {
      await openExternal?.(session.url); return snapshot();
    }
    if (input.action === "begin" && Array.isArray(input.permissions) && input.permissions.length > 0 && input.permissions.length <= FEISHU_READ_PERMISSIONS.length
      && new Set(input.permissions).size === input.permissions.length && input.permissions.every(id => FEISHU_READ_PERMISSIONS.some(item => item.id === id))) {
      if (["starting", "waiting", "verifying", "installing", "configuring", "configuring_browser"].includes(snapshot().phase)) return { ok: false };
      await begin(input.permissions); return snapshot();
    }
    return { ok: false };
  }
  return { request, clear };
}

async function createFeishuQr(url, { signal }) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "group-feishu-qr-"));
  try {
    const executable = await feishuCliExecutable();
    await new Promise((resolve, reject) => execFile(executable, ["auth", "qrcode", url, "--output", "authorization.png"],
      { cwd: directory, signal, timeout: 4_000, maxBuffer: 32 * 1024, windowsHide: true }, error => error ? reject(new Error("qr_unavailable")) : resolve()));
    const bytes = await readFile(path.join(directory, "authorization.png"));
    if (bytes.length > 128 * 1024 || bytes.subarray(0, 8).toString("hex") !== "89504e470d0a1a0a") throw new Error("qr_invalid");
    return `data:image/png;base64,${bytes.toString("base64")}`;
  } finally { await rm(directory, { recursive: true, force: true }); }
}
