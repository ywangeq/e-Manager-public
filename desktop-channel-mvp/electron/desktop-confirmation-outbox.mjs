import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

const VERSION = "desktop-confirmation-outbox.v1";
const FIELDS = ["actorHash","centerOrigin","employeeId","sessionId","confirmationId","clickedAt"];
const MAX_AGE_MS = 7 * 86400000;
export const CONFIRMATION_DELIVERY_MESSAGE = "确认执行已审批的操作。";

// Delivery intent only. Center confirmation/task records remain authoritative.
export function createDesktopConfirmationOutbox({filePath,encryption,now=() => Date.now()}) {
  let tail = Promise.resolve();
  const serialized = work => {
    const result = tail.then(work); tail = result.catch(() => {}); return result;
  };
  const fail = () => {throw Error("tool_confirmation_outbox_unavailable");};
  function available() {
    if (!encryption?.isAvailable?.()) fail();
  }
  function actorHash(actorKey) {
    if (typeof actorKey !== "string" || !actorKey.trim()) fail();
    return crypto.createHash("sha256").update(actorKey.trim().toLowerCase()).digest("hex");
  }
  function valid(record) {
    if (!record || Object.keys(record).sort().join() !== FIELDS.slice().sort().join() ||
      !/^[a-f0-9]{64}$/.test(record.actorHash) || !Number.isSafeInteger(record.clickedAt) || record.clickedAt < 0) fail();
    for (const name of ["employeeId","sessionId","confirmationId"]) {
      if (typeof record[name] !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,239}$/.test(record[name])) fail();
    }
    try {if (new URL(record.centerOrigin).origin !== record.centerOrigin) fail();} catch {fail();}
    return record;
  }
  function key(record) {return JSON.stringify([record.actorHash,record.centerOrigin,record.confirmationId]);}
  async function load() {
    let text;
    try {
      const stat = await fs.lstat(filePath);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 256 * 1024) fail();
      text = await fs.readFile(filePath,"utf8");
    } catch (error) {if (error.code === "ENOENT") return [];throw error;}
    available();
    try {
      const envelope = JSON.parse(text);
      if (Object.keys(envelope).sort().join() !== "contractVersion,encryptedRecords" || envelope.contractVersion !== VERSION) fail();
      const records = JSON.parse(await encryption.decrypt(envelope.encryptedRecords));
      if (!Array.isArray(records) || records.length > 100) fail();
      records.forEach(valid);
      if (new Set(records.map(key)).size !== records.length) fail();
      return records;
    } catch {fail();}
  }
  async function save(records) {
    available();records.forEach(valid);
    const value = JSON.stringify({contractVersion:VERSION,encryptedRecords:await encryption.encrypt(JSON.stringify(records))});
    if (records.length > 100 || Buffer.byteLength(value) > 256 * 1024) fail();
    await fs.mkdir(path.dirname(filePath),{recursive:true,mode:0o700});
    const temporary = `${filePath}.tmp-${crypto.randomUUID()}`;
    try {
      const file = await fs.open(temporary,"wx",0o600);
      try {await file.writeFile(value);await file.sync();} finally {await file.close();}
      await fs.rename(temporary,filePath);
      // Windows cannot fsync a read-only directory handle. The encrypted file
      // is still flushed before the atomic rename; POSIX also flushes its parent.
      if (process.platform !== "win32") {
        const directory = await fs.open(path.dirname(filePath),"r");
        try {await directory.sync();} finally {await directory.close();}
      }
    } finally {await fs.unlink(temporary).catch(() => {});}
  }
  return Object.freeze({
    remember({actorKey,centerOrigin,employeeId,sessionId,confirmationId}) {
      return serialized(async () => {
        const records = await load();
        const record = valid({actorHash:actorHash(actorKey),centerOrigin,employeeId,sessionId,confirmationId,clickedAt:now()});
        const existing = records.find(item => key(item) === key(record));
        if (existing) {
          if (existing.employeeId !== employeeId || existing.sessionId !== sessionId) fail();
          return existing;
        }
        await save([...records.filter(item => now()-item.clickedAt <= MAX_AGE_MS),record]);
        return record;
      });
    },
    pending({actorKey,centerOrigin}) {
      return serialized(async () => {
        const records = await load();
        const hash = actorHash(actorKey);
        const retained = records.filter(item => now()-item.clickedAt <= MAX_AGE_MS && (item.actorHash !== hash || item.centerOrigin === centerOrigin));
        if (retained.length !== records.length) await save(retained);
        return retained.filter(item => item.actorHash === hash && item.centerOrigin === centerOrigin);
      });
    },
    forget({actorKey,centerOrigin,confirmationId}) {
      return serialized(async () => {
        const records = await load(), hash = actorHash(actorKey);
        const retained = records.filter(item => !(item.actorHash === hash && item.centerOrigin === centerOrigin && item.confirmationId === confirmationId));
        if (retained.length !== records.length) await save(retained);
      });
    },
    clearActor(actorKey) {
      return serialized(async () => {
        const records = await load(), hash = actorHash(actorKey);
        const retained = records.filter(item => item.actorHash !== hash);
        if (retained.length !== records.length) await save(retained);
      });
    },
  });
}
