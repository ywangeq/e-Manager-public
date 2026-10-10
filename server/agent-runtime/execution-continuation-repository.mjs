import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";

const VERSION = "execution-continuation-record.v1";
const MAX_STATE_BYTES = 16 * 1024 * 1024;
const MAX_FILE_BYTES = 24 * 1024 * 1024;
const FILE = /^f([1-9][0-9]*)-r([1-9][0-9]*)\.json$/;
const IDENTITY_FIELDS = ["tenantScope", "taskId", "actorIssuer", "actorSubjectDigest", "employeeId",
  "sessionId", "routeDigest", "inputDigest", "executionBindingDigest", "executionDeadlineAt"];

// Private continuation data, never an execution authority. Current canonical
// ownership and terminal state must be checked by the server-owned callbacks.
function createExecutionContinuationRepository({ rootDirectory, encryptionKey, assertOwnership, assertTerminal,
  now = () => Date.now() } = {}) {
  if (!path.isAbsolute(rootDirectory || "") || !Buffer.isBuffer(encryptionKey) || encryptionKey.length !== 32 ||
    typeof assertOwnership !== "function" || typeof assertTerminal !== "function") fail("configuration_invalid");
  fs.mkdirSync(rootDirectory, { recursive: true, mode: 0o700 });
  directory(rootDirectory);
  const root = fs.realpathSync(rootDirectory);
  const key = Buffer.from(encryptionKey);
  let cleanupCursor = "";

  function location(identity) {
    const name = crypto.createHash("sha256").update(JSON.stringify([identity.tenantScope, identity.taskId])).digest("hex");
    return path.join(root, name);
  }
  function check(identity, ownership) {
    if (Date.parse(identity.executionDeadlineAt) <= now()) fail("expired");
    if (assertOwnership({ identity, ownership }) !== true) fail("ownership_lost");
  }
  function latest(identity) {
    const dir = location(identity);
    if (!fs.existsSync(dir)) return null;
    directory(dir);
    const names = fs.readdirSync(dir);
    if (names.length > 256) fail("capacity_exceeded");
    for (const name of names) {
      const stat = fs.lstatSync(path.join(dir, name));
      if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o077) || stat.size > MAX_FILE_BYTES) fail("corrupt");
    }
    const candidates = names.filter(name => FILE.test(name)).map(name => {
      const [, fence, revision] = name.match(FILE);
      if (!Number.isSafeInteger(Number(fence)) || !Number.isSafeInteger(Number(revision))) fail("corrupt");
      return { name, fencingToken: Number(fence), revision: Number(revision) };
    });
    if (names.some(name => !FILE.test(name) && !/^\.tmp-[a-f0-9-]{36}$/.test(name))) fail("corrupt");
    if (!candidates.length) {
      // A partially prepared directory is not proof of a fresh task.
      if (names.length) fail("incomplete");
      return null;
    }
    candidates.sort((a, b) => b.fencingToken - a.fencingToken || b.revision - a.revision);
    const head = candidates[0];
    const record = read(path.join(dir, head.name), `${path.basename(dir)}/${head.name}`);
    if (record.contractVersion !== VERSION || record.fencingToken !== head.fencingToken || record.revision !== head.revision ||
      !isDeepStrictEqual(record.identity, identity) || !["active", "terminal"].includes(record.status) ||
      !record.ownership || record.ownership.fencingToken !== head.fencingToken ||
      record.status === "terminal" && record.state !== null || record.status === "active" &&
      (!record.state || typeof record.state !== "object" || Array.isArray(record.state))) fail("identity_or_record_invalid");
    return { ...head, record, candidates, dir };
  }
  function read(file, aad) {
    let fd;
    try {
      fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
      const stat = fs.fstatSync(fd);
      if (!stat.isFile() || stat.size > MAX_FILE_BYTES || (stat.mode & 0o077)) fail("corrupt");
      const envelope = JSON.parse(fs.readFileSync(fd, "utf8"));
      if (envelope.alg !== "aes-256-gcm") fail("corrupt");
      const decipher = crypto.createDecipheriv("aes-256-gcm", key, Buffer.from(envelope.iv, "base64"));
      decipher.setAAD(Buffer.from(`${VERSION}:${aad}`));
      decipher.setAuthTag(Buffer.from(envelope.tag, "base64"));
      return JSON.parse(Buffer.concat([decipher.update(Buffer.from(envelope.data, "base64")), decipher.final()]).toString("utf8"));
    } catch { fail("corrupt"); }
    finally { if (fd !== undefined) fs.closeSync(fd); }
  }
  function publish(identity, ownership, revision, state, status, beforePublish) {
    const dir = location(identity);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    directory(dir);
    const name = `f${ownership.fencingToken}-r${revision}.json`;
    const record = { contractVersion: VERSION, identity, ownership, fencingToken: ownership.fencingToken,
      revision, status, state };
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
    cipher.setAAD(Buffer.from(`${VERSION}:${path.basename(dir)}/${name}`));
    const data = Buffer.concat([cipher.update(JSON.stringify(record), "utf8"), cipher.final()]);
    const envelope = JSON.stringify({ alg: "aes-256-gcm", iv: iv.toString("base64"),
      tag: cipher.getAuthTag().toString("base64"), data: data.toString("base64") });
    if (Buffer.byteLength(envelope) > MAX_FILE_BYTES) fail("capacity_exceeded");
    const temp = path.join(dir, `.tmp-${crypto.randomUUID()}`);
    const target = path.join(dir, name);
    let fd, published;
    try {
      fd = fs.openSync(temp, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
      fs.writeFileSync(fd, envelope);
      fs.fsyncSync(fd);
      fs.closeSync(fd); fd = undefined;
      beforePublish();
      try { fs.linkSync(temp, target); published = fs.lstatSync(target); }
      catch (error) { if (error.code === "EEXIST") fail("revision_conflict"); throw error; }
      syncDirectory(dir);
      beforePublish();
      return { revision, fencingToken: ownership.fencingToken, state: structuredClone(state), status };
    } catch (error) {
      // Retract only our own link on a failed post-publication check. This is
      // not a transaction with the canonical lease; a recovering caller must
      // still verify canonical activities/receipts before any effect.
      if (published) {
        try {
          const current = fs.lstatSync(target);
          if (current.dev === published.dev && current.ino === published.ino) {
            fs.unlinkSync(target);
            syncDirectory(dir);
          }
        } catch (cleanupError) { if (cleanupError.code !== "ENOENT") throw cleanupError; }
      }
      throw error;
    } finally {
      if (fd !== undefined) fs.closeSync(fd);
      fs.rmSync(temp, { force: true });
    }
  }
  function prune(identity, head, terminal = false) {
    // Never remove a newer fence/revision published by another owner.
    const keep = terminal ? 1 : 2;
    const current = latest(identity);
    if (!current || current.fencingToken !== head.fencingToken || current.revision !== head.revision) return;
    for (const old of current.candidates.slice(keep)) fs.unlinkSync(path.join(current.dir, old.name));
    if (terminal) {
      for (const name of fs.readdirSync(current.dir).filter(name => /^\.tmp-[a-f0-9-]{36}$/.test(name))) {
        fs.unlinkSync(path.join(current.dir, name));
      }
    }
    syncDirectory(current.dir);
  }
  function load({ identity: value, ownership: owner, requireExisting = false } = {}) {
    const identity = normalizeIdentity(value), ownership = normalizeOwnership(owner);
    check(identity, ownership);
    const head = latest(identity);
    if (!head) { if (requireExisting) fail("required"); return null; }
    if (head.record.status === "terminal") fail("terminal");
    if (head.fencingToken > ownership.fencingToken || head.fencingToken === ownership.fencingToken &&
      !isDeepStrictEqual(head.record.ownership, ownership)) fail("ownership_lost");
    check(identity, ownership);
    return { revision: head.revision, fencingToken: head.fencingToken, state: structuredClone(head.record.state), status: "active" };
  }
  function adopt({ identity: value, ownership: owner, expected } = {}) {
    const identity = normalizeIdentity(value), ownership = normalizeOwnership(owner);
    check(identity, ownership);
    const head = latest(identity);
    if (!head || head.record.status !== "active" || !expected || expected.revision !== head.revision ||
      expected.fencingToken !== head.fencingToken || ownership.fencingToken <= head.fencingToken) fail("revision_conflict");
    const result = publish(identity, ownership, 1, head.record.state, "active", () => check(identity, ownership));
    prune(identity, result);
    return result;
  }
  function save({ identity: value, ownership: owner, expectedRevision, state } = {}) {
    const identity = normalizeIdentity(value), ownership = normalizeOwnership(owner);
    check(identity, ownership);
    if (!state || typeof state !== "object" || Array.isArray(state)) fail("state_invalid");
    const bytes = JSON.stringify(state);
    if (!bytes || Buffer.byteLength(bytes) > MAX_STATE_BYTES) fail("capacity_exceeded");
    const head = latest(identity);
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0 || head &&
      (head.record.status !== "active" || head.fencingToken !== ownership.fencingToken ||
        !isDeepStrictEqual(head.record.ownership, ownership))) fail("revision_conflict");
    if ((head?.revision || 0) !== expectedRevision) fail("revision_conflict");
    const result = publish(identity, ownership, expectedRevision + 1, JSON.parse(bytes), "active", () => check(identity, ownership));
    prune(identity, result);
    return result;
  }
  function clearTerminal({ identity: value } = {}) {
    const identity = normalizeIdentity(value);
    const checkTerminal = () => { if (assertTerminal(identity) !== true) fail("terminal_required"); };
    checkTerminal();
    const head = latest(identity);
    if (!head) return false;
    if (head.record.status === "terminal") { prune(identity, head, true); return true; }
    const result = publish(identity, head.record.ownership, head.revision + 1, null, "terminal", checkTerminal);
    prune(identity, result, true);
    return true;
  }
  function cleanupTerminalRecords({ limit = 100 } = {}) {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500) fail("cleanup_limit_invalid");
    // Payload work is bounded per pass; only hashed names are enumerated.
    const names = fs.readdirSync(root).filter(name => /^[a-f0-9]{64}$/.test(name)).sort();
    let remaining = names.filter(name => name > cleanupCursor);
    if (!remaining.length) { cleanupCursor = ""; remaining = names; }
    const batch = remaining.slice(0, limit);
    const summary = { examined: batch.length, cleared: 0, deferred: 0, failedSafe: 0, hasMore: remaining.length > limit };
    for (const name of batch) {
      cleanupCursor = name;
      try {
        const dir = path.join(root, name);
        directory(dir);
        const files = fs.readdirSync(dir);
        if (files.length > 256) fail("capacity_exceeded");
        const candidates = files.filter(file => FILE.test(file)).sort((a,b) => {
          const x = a.match(FILE), y = b.match(FILE);
          return Number(y[1]) - Number(x[1]) || Number(y[2]) - Number(x[2]);
        });
        if (!candidates.length) { summary.deferred += 1; continue; }
        const record = read(path.join(dir, candidates[0]), `${name}/${candidates[0]}`);
        const identity = normalizeIdentity(record.identity);
        if (location(identity) !== dir) fail("identity_or_record_invalid");
        // Reuse full envelope/file validation before consulting canonical state.
        const head = latest(identity);
        if (assertTerminal(identity) !== true) { summary.deferred += 1; continue; }
        clearTerminal({ identity });
        if (head.record.status === "active") summary.cleared += 1;
      } catch { summary.failedSafe += 1; }
    }
    return summary;
  }
  return Object.freeze({ load, adopt, save, clearTerminal, cleanupTerminalRecords });
}

function normalizeIdentity(value) {
  if (!value || Object.keys(value).length !== IDENTITY_FIELDS.length) fail("identity_invalid");
  const result = Object.fromEntries(IDENTITY_FIELDS.map(name => {
    const token = value[name];
    if (typeof token !== "string" || !token || token !== token.trim() || token.length > 240) fail("identity_invalid");
    return [name, token];
  }));
  for (const name of ["actorSubjectDigest", "routeDigest", "inputDigest", "executionBindingDigest"]) {
    if (!/^[a-f0-9]{64}$/.test(result[name])) fail("identity_invalid");
  }
  if (!Number.isFinite(Date.parse(result.executionDeadlineAt)) || new Date(result.executionDeadlineAt).toISOString() !== result.executionDeadlineAt) fail("identity_invalid");
  return result;
}
function normalizeOwnership(value) {
  if (!value || Object.keys(value).length !== 3 || typeof value.leaseId !== "string" || !value.leaseId ||
    value.leaseId.length > 240 || value.leaseId !== value.leaseId.trim() ||
    typeof value.workerIdDigest !== "string" || !value.workerIdDigest || value.workerIdDigest.length > 240 ||
    value.workerIdDigest !== value.workerIdDigest.trim() || !Number.isSafeInteger(value.fencingToken) ||
    value.fencingToken < 1) fail("ownership_invalid");
  return { leaseId: value.leaseId, workerIdDigest: value.workerIdDigest, fencingToken: value.fencingToken };
}
function directory(dir) {
  const stat = fs.lstatSync(dir);
  if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o077)) fail("directory_invalid");
}
function syncDirectory(dir) {
  const fd = fs.openSync(dir, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}
function fail(suffix) {
  const code = `execution_continuation_${suffix}`;
  throw Object.assign(new Error(code), { code });
}

export { createExecutionContinuationRepository };
