import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

// A local preference, never identity evidence, credential storage or Tool grant.
export function createFeishuAssociationIntentStore({ filePath, centerOrigin }) {
  function filename() { return typeof filePath === "function" ? filePath() : filePath; }
  function digest(actorKey) {
    if (typeof actorKey !== "string" || !actorKey || actorKey.length > 512) throw new Error("feishu_association_actor_invalid");
    const center = typeof centerOrigin === "function" ? centerOrigin() : centerOrigin;
    if (typeof center !== "string" || !center) throw new Error("feishu_association_center_invalid");
    return crypto.createHash("sha256").update(JSON.stringify(["feishu-association-intent.v1", center, "fortress-sso-v3", actorKey])).digest("hex");
  }
  function load() {
    const target = filename();
    let content;
    try {
      if (fs.statSync(target).size > 8192) throw new Error("invalid");
      content = fs.readFileSync(target, "utf8");
    } catch (error) {
      if (error.code === "ENOENT") return [];
      throw new Error("feishu_association_preference_unavailable");
    }
    try {
      const value = JSON.parse(content);
      if (value.version !== 1 || Object.keys(value).length !== 2 || !Array.isArray(value.actors) || value.actors.length > 100 ||
        value.actors.some(item => typeof item !== "string" || !/^[a-f0-9]{64}$/.test(item)) || new Set(value.actors).size !== value.actors.length) throw new Error("invalid");
      return value.actors;
    } catch { throw new Error("feishu_association_preference_unavailable"); }
  }
  function set(actorKey, enabled) {
    const key = digest(actorKey), actors = load().filter(item => item !== key);
    if (enabled) actors.push(key);
    if (actors.length > 100) throw new Error("feishu_association_preference_limit");
    const target = filename(), temporary = `${target}.${crypto.randomUUID()}.tmp`;
    fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
    try {
      fs.writeFileSync(temporary, JSON.stringify({ version: 1, actors }), { mode: 0o600, flag: "wx" });
      fs.renameSync(temporary, target);
    } finally { fs.rmSync(temporary, { force: true }); }
  }
  return Object.freeze({ has: actorKey => load().includes(digest(actorKey)), set });
}
