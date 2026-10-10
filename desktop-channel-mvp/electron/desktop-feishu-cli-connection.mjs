import { execFile } from "node:child_process";
import { access } from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";
import os from "node:os";

const VALIDATION_TTL_MS = 60_000;

// Authentication adapter only. Business operations remain registered Runtime Tools.
export function createDesktopFeishuCliConnection({ readActor, isExpectedActor, actorContext = () => null, intentStore = null, run = runFeishuCli, now = () => Date.now(), onDisconnect = () => {} }) {
  let association = null;
  let generation = 0;
  let displayBinding = null;
  function clear() { generation++; association = null; displayBinding = null; }
  function rememberBinding(value) {
    if (displayBinding && (displayBinding.appId !== value.appId || displayBinding.openId !== value.openId)) generation++;
    displayBinding = value;
  }
  function wantsRestore() {
    const actor = actorContext();
    return Boolean(intentStore && actor?.key && isExpectedActor(actor.key, actor.version) && intentStore.has(actor.key));
  }
  async function status() {
    if (!association) return { state: wantsRestore() ? "verification_required" : "disconnected" };
    if (!isExpectedActor(association.key, association.version)) { clear(); return { state: "disconnected" }; }
    if (association.projection.state === "authenticated" && association.projection.expiryKnown &&
      Date.parse(association.projection.expiresAt) <= now()) return { ...association.projection, state: "verification_required" };
    return { ...association.projection, state: association.projection.state === "authenticated" &&
      now() - association.checkedAtMs >= VALIDATION_TTL_MS ? "verification_required" : association.projection.state };
  }
  async function verify(_id, { signal, explicit = false } = {}) {
    if (signal?.aborted) return;
    const revision = generation;
    const actor = await readActor({ signal });
    if (!actor || actor.identitySource !== "fortress-sso-v3" || !isExpectedActor(actor.key, actor.version)) {
      clear(); return;
    }
    const previous = association?.key === actor.key && association.version === actor.version ? association : null;
    let projection;
    let verifiedOpenId = "";
    let verifiedAppId = "", verifiedUnionId = "";
    try {
      let auth = await run(["auth", "status", "--json", "--verify"], { signal });
      const initial = auth.identities?.user;
      const initialAppId = auth.appId;
      const renewable = ["valid", "needs_refresh"].includes(initial?.tokenStatus) && ["ready", "needs_refresh"].includes(initial?.status);
      const needsRefresh = renewable && (initial.tokenStatus === "needs_refresh" || initial.status === "needs_refresh" ||
        validDate(initial.expiresAt) && Date.parse(initial.expiresAt) <= now());
      const usable = Boolean(initial?.openId) && (verifiedFeishuUser(auth, now()) || needsRefresh);
      if (!usable) {
        // Only an official expired/missing diagnosis requests reauthorization.
        projection = { state: ["expired", "missing"].includes(initial?.tokenStatus) || initial?.status === "missing"
          ? previous?.projection.authenticatedAt ? "expired" : "disconnected" : "unavailable" };
      } else {
        // The official CLI owns refresh and refresh-token storage. This identity
        // probe never calls login/logout or implements a second OAuth lifecycle.
        const info = await run(["api", "GET", "/open-apis/authen/v1/user_info", "--as", "user"], { signal });
        if (needsRefresh) auth = await run(["auth", "status", "--json", "--verify"], { signal });
        const user = auth.identities?.user;
        const sameLogin = Boolean(initial.openId) && user?.openId === initial.openId && auth.appId === initialAppId;
        const matchesLogin = sameLogin && info.ok === true && info.identity === "user" && info.data?.open_id === user.openId;
        if (!matchesLogin || !feishuIdentityMatches(actor, info.data)) projection = { state: "account_blocked" };
        else if (!verifiedFeishuUser(auth, now())) projection = { state: "verification_required" };
        else {
          verifiedOpenId = user.openId;
          verifiedAppId = typeof auth.appId === "string" ? auth.appId : "";
          verifiedUnionId = typeof info.data.union_id === "string" ? info.data.union_id : "";
          const checkedAt = new Date(now()).toISOString();
          projection = { state: "authenticated", authenticatedAt: explicit ? checkedAt : previous?.projection.authenticatedAt || checkedAt,
            checkedAt, verifiedAt: checkedAt, expiryKnown: Boolean(validDate(user.expiresAt)), expiresAt: validDate(user.expiresAt) };
        }
      }
    } catch (error) {
      projection = { state: error?.code === "feishu_cli_missing" ? "not_configured" : "unavailable" };
    }
    if (projection.state !== "authenticated") projection = { authenticatedAt: previous?.projection.authenticatedAt || "",
      verifiedAt: previous?.projection.verifiedAt || "", checkedAt: new Date(now()).toISOString(), ...projection };
    // Revalidate the server identity after CLI access; a stale local actor cannot attach a new account.
    const current = await readActor({ signal });
    if (signal?.aborted || revision !== generation) return;
    if (!current || current.key !== actor.key || current.version !== actor.version ||
      !sameActorIdentity(actor, current) || !isExpectedActor(actor.key, actor.version)) { clear(); return; }
    if (explicit && projection.state === "authenticated") intentStore?.set(actor.key, true);
    if (projection.state === "authenticated") rememberBinding({appId:verifiedAppId,openId:verifiedOpenId});
    association = { key: actor.key, version: actor.version, checkedAtMs: now(), projection, verifiedOpenId, verifiedAppId, verifiedUnionId, actorIdentity: { ...actor } };
  }
  // Private main-process extension point, never exposed by subsystem IPC.
  // A read needs an explicit association and fresh identity checks on both sides.
  async function executeAssociatedRead(read, { signal, onDiagnostic = () => {} } = {}) {
    const revision = generation;
    const original = association;
    const blocked = () => { throw new Error("feishu_read_identity_unavailable"); };
    if (signal?.aborted || !original || original.projection.state !== "authenticated" || typeof read !== "function") blocked();
    onDiagnostic({ stage: "pre_identity" });
    await verify(undefined, { signal });
    const current = association;
    if (signal?.aborted || revision !== generation || current?.projection.state !== "authenticated" ||
      current.key !== original.key || current.version !== original.version || current.verifiedOpenId !== original.verifiedOpenId ||
      !current.verifiedAppId || current.verifiedAppId !== original.verifiedAppId || current.verifiedUnionId !== original.verifiedUnionId ||
      !sameActorIdentity(current.actorIdentity, original.actorIdentity)) blocked();
    const account = Object.freeze({ appId: current.verifiedAppId, openId: current.verifiedOpenId, unionId: current.verifiedUnionId });
    onDiagnostic({ stage: "helper" });
    const value = await read({ signal, account });
    onDiagnostic({ stage: "post_identity" });
    await verify(undefined, { signal });
    if (signal?.aborted || revision !== generation || association?.projection.state !== "authenticated" ||
      association.key !== current.key || association.version !== current.version || association.verifiedOpenId !== current.verifiedOpenId ||
      association.verifiedAppId !== current.verifiedAppId || association.verifiedUnionId !== current.verifiedUnionId ||
      !sameActorIdentity(association.actorIdentity, current.actorIdentity)) blocked();
    onDiagnostic({ stage: "identity_completed" });
    return value;
  }
  return {
    name: "飞书", icon: "users", credentialMode: "device_local_cli", associationOnly: true, renewal: "automatic",
    status, connect: (id, options) => verify(id, { ...options, explicit: true }),
    check: async (id, options) => { if (association || wantsRestore()) await verify(id, options); },
    // Reading local login metadata permits historical display only; it never
    // authenticates this connection or bypasses the fresh Tool identity checks.
    cacheBinding: async () => {
      const actor = actorContext(), revision = generation;
      if (!actor?.key || !isExpectedActor(actor.key,actor.version) || !wantsRestore()) return null;
      try {
        const auth = await run(["auth","status","--json"]);
        if (revision !== generation || !isExpectedActor(actor.key,actor.version)) return null;
        const value = {appId:auth.appId,openId:auth.identities?.user?.openId};
        if (typeof value.appId !== "string" || !value.appId || typeof value.openId !== "string" || !value.openId) return null;
        rememberBinding(value); return {...value,generation};
      } catch { return null; }
    },
    verifiedCacheBinding: () => association?.projection.state === "authenticated" ?
      {appId:association.verifiedAppId,openId:association.verifiedOpenId} : null,
    disconnect: async () => {
      const actor = actorContext();
      clear();
      if (actor?.key && isExpectedActor(actor.key, actor.version)) { intentStore?.set(actor.key, false); onDisconnect(actor); }
    }, clear, executeAssociatedRead, associationGeneration: () => generation,
  };
}

export function verifiedFeishuUser(auth, now = Date.now()) {
  const user = auth?.identities?.user;
  const expiry = validDate(user?.expiresAt);
  return auth?.verified === true && user?.verified === true && user.status === "ready" && user.tokenStatus === "valid" &&
    (!expiry || Date.parse(expiry) > now);
}

export function feishuIdentityMatches(actor, info = {}) {
  if (!info || typeof info !== "object") return false;
  if (actor.feishuUnionId) return Boolean(info.union_id) && actor.feishuUnionId === info.union_id &&
    (!actor.feishuUserId || !info.user_id || actor.feishuUserId === info.user_id);
  if (actor.feishuUserId) return Boolean(info.user_id) && actor.feishuUserId === info.user_id;
  const expected = canonicalEmail(actor.email);
  const actual = canonicalEmail(info.enterprise_email || info.email);
  return Boolean(expected && actual && expected === actual);
}
function sameActorIdentity(left, right) {
  return left.identitySource === right.identitySource && left.feishuUnionId === right.feishuUnionId &&
    left.feishuUserId === right.feishuUserId && canonicalEmail(left.email) === canonicalEmail(right.email);
}
function canonicalEmail(value) { return typeof value === "string" && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim()) ? value.trim().toLowerCase() : ""; }
function validDate(value) { return typeof value === "string" && Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : ""; }

export async function runFeishuCli(args, options = {}) {
  const { value, failed } = await runFeishuCliResult(args, options);
  if (failed || value.ok === false) throw new Error("feishu_cli_unavailable");
  return value;
}

export async function feishuCliExecutable() {
  const filename = process.platform === "win32" ? "lark-cli.exe" : "lark-cli";
  const owned = path.join(os.homedir(), ".local", "share", "group-studio-feishu", "node_modules", "@larksuite", "cli", "bin");
  const directories = [...(process.env.PATH || "").split(path.delimiter),
    path.join(os.homedir(), "Library", "pnpm", "bin"), path.join(os.homedir(), ".local", "bin"), "/opt/homebrew/bin", "/usr/local/bin", owned];
  for (const directory of directories.filter(value => path.isAbsolute(value))) {
    const candidate = path.join(directory, filename);
    try { await access(candidate, constants.X_OK); return candidate; } catch { /* next installed location */ }
  }
  throw Object.assign(new Error("feishu_cli_missing"), { code: "feishu_cli_missing" });
}

export async function runFeishuCliResult(args, { signal, timeout = 4_000 } = {}) {
  const executable = await feishuCliExecutable();
  return await new Promise((resolve, reject) => {
    execFile(executable, args, { signal, timeout, maxBuffer: 256 * 1024, windowsHide: true,
      env: { ...process.env, LARKSUITE_CLI_NO_UPDATE_NOTIFIER: "1", LARKSUITE_CLI_NO_SKILLS_NOTIFIER: "1" } }, (error, stdout, stderr) => {
      if (signal?.aborted) return reject(new Error("feishu_cli_cancelled"));
      // Some CLI authorization completions carry missing scopes and exit nonzero.
      // Read that structured result privately without exposing stdout/stderr.
      try {
        const value = JSON.parse(stdout || stderr);
        if (!value || typeof value !== "object") throw new Error();
        resolve({ value, failed: Boolean(error) });
      } catch { reject(new Error("feishu_cli_unavailable")); }
    });
  });
}
