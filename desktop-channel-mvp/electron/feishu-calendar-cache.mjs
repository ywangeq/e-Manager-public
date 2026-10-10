import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { FEISHU_CALENDAR_READ_DESCRIPTOR as contract } from "../shared/feishu-calendar-read-contract.mjs";

// A private display cache, never an identity proof, Tool grant or execution store.
// Version 1 has no plaintext fallback. Invalid/unreadable data is ignored.
export function createFeishuCalendarCache({ directory, encryption }) {
  const digest = value => crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");
  function location(scope) {
    if (!scope?.center || !scope.actorKey || !scope.appId || !scope.openId) throw new Error("calendar_cache_scope_invalid");
    const root = typeof directory === "function" ? directory() : directory;
    return { actor: path.join(root,digest([scope.center,scope.actorKey])),
      key: digest(["calendar-display.v1",scope.center,scope.actorKey,scope.appId,scope.openId]) };
  }
  function normalize(snapshots) {
    if (!Array.isArray(snapshots) || snapshots.length > 4) throw new Error("calendar_cache_invalid");
    return snapshots.map(snapshot => {
      if (!snapshot || Object.keys(snapshot).sort().join() !== "end,events,fetchedAt,start" ||
        typeof snapshot.fetchedAt !== "string" || !Number.isFinite(Date.parse(snapshot.fetchedAt))) throw new Error("calendar_cache_invalid");
      return {...contract.normalizeInput({start:snapshot.start,end:snapshot.end}), fetchedAt:snapshot.fetchedAt,
        ...contract.normalizeResult({events:snapshot.events})};
    });
  }
  return Object.freeze({
    read(scope) {
      try {
        if (!encryption.isAvailable()) return null;
        const {actor,key} = location(scope), file = path.join(actor,`${key}.json`);
        if (fs.statSync(file).size > 256 * 1024) return null;
        const envelope = JSON.parse(fs.readFileSync(file,"utf8"));
        if (envelope.version !== 1 || typeof envelope.ciphertext !== "string") return null;
        const value = JSON.parse(encryption.decrypt(envelope.ciphertext));
        if (value.version !== 1 || value.key !== key) return null;
        return normalize(value.snapshots);
      } catch { return null; }
    },
    write(scope, snapshots) {
      let temporary;
      try {
        if (!encryption.isAvailable()) return false;
        const {actor,key} = location(scope), data = normalize(snapshots);
        const ciphertext = encryption.encrypt(JSON.stringify({version:1,key,snapshots:data}));
        if (typeof ciphertext !== "string" || !ciphertext || ciphertext.length > 240 * 1024) return false;
        fs.mkdirSync(actor,{recursive:true,mode:0o700});
        temporary = path.join(actor,`${key}.${crypto.randomUUID()}.tmp`);
        fs.writeFileSync(temporary,JSON.stringify({version:1,ciphertext}),{mode:0o600,flag:"wx"});
        fs.renameSync(temporary,path.join(actor,`${key}.json`));
        return true;
      } catch { return false; }
      finally { if (temporary) fs.rmSync(temporary,{force:true}); }
    },
    removeActor({center,actorKey}) {
      const root = typeof directory === "function" ? directory() : directory;
      fs.rmSync(path.join(root,digest([center,actorKey])),{recursive:true,force:true});
    },
  });
}
