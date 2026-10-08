import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { closeSqliteDatabase } from "./sqlite-lifecycle.mjs";

export function conciseWorkItemTitle(value) {
  if (typeof value === "string" && /^[\[{]/.test(value.trim())) {
    try {
      const input = JSON.parse(value);
      value = input && !Array.isArray(input) && typeof input.objective === "string" ? input.objective : "";
    } catch { return ""; }
  }
  const text = typeof value === "string" ? value.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim() : "";
  const first = text.split(/[。！？\n]/u)[0].replace(/^(?:请帮我|帮我|请)\s*/u, "");
  return Array.from(first).slice(0, 32).join("") || "";
}

// Display metadata is encrypted and actor-scoped; execution contracts stay immutable.
export function createWorkItemDisplayRepository({ databasePath, encryptionKey }) {
  if (!Buffer.isBuffer(encryptionKey) || encryptionKey.length !== 32) throw new TypeError("work item display encryption key required");
  if (databasePath !== ":memory:") fs.mkdirSync(path.dirname(databasePath), { recursive: true });
  const db = new DatabaseSync(databasePath);
  try {
    db.exec("BEGIN IMMEDIATE");
    const hasTitles = validateTable(db, "work_item_display", [["scope_key", "TEXT", 0, 1], ["revision", "INTEGER", 1, 0], ["ciphertext", "TEXT", 1, 0]]);
    const hasKey = validateTable(db, "work_item_display_key", [["singleton", "INTEGER", 0, 1], ["key_tag", "TEXT", 1, 0]]);
    if (hasKey && !hasTitles) throw failure("work_item_display_schema_invalid");
    const keyTag = crypto.createHmac("sha256", encryptionKey).update("work-item-display.key.v1").digest("hex");
    if (hasKey) {
      const rows = db.prepare("SELECT singleton,key_tag FROM work_item_display_key").all();
      if (rows.length !== 1 || rows[0].singleton !== 1 || rows[0].key_tag !== keyTag) throw failure("work_item_display_key_mismatch");
    } else if (hasTitles) {
      // Existing stores gain a key fence only after every retained title authenticates.
      for (const row of db.prepare("SELECT scope_key,revision,ciphertext FROM work_item_display").iterate()) {
        decodeTitle(row.scope_key, row, encryptionKey);
      }
    }
    if (!hasTitles) db.exec("CREATE TABLE work_item_display (scope_key TEXT PRIMARY KEY, revision INTEGER NOT NULL, ciphertext TEXT NOT NULL)");
    if (!hasKey) {
      db.exec("CREATE TABLE work_item_display_key (singleton INTEGER PRIMARY KEY CHECK(singleton=1), key_tag TEXT NOT NULL)");
      db.prepare("INSERT INTO work_item_display_key VALUES(1,?)").run(keyTag);
    }
    db.exec("COMMIT");
    db.exec("PRAGMA journal_mode=WAL");
  } catch (error) {
    if (db.isTransaction) db.exec("ROLLBACK");
    db.close();
    throw error;
  }
  const scopeKey = (actor, kind, id) => {
    if (![actor?.tenantScope, actor?.actorIssuer, actor?.actorSubjectDigest, kind, id].every(value => typeof value === "string" && value)) throw failure("group_actor_route_invalid");
    return crypto.createHmac("sha256", encryptionKey).update(JSON.stringify([actor.tenantScope, actor.actorIssuer, actor.actorSubjectDigest, kind, id])).digest("hex");
  };
  function read(actor, kind, id) {
    const key = scopeKey(actor, kind, id);
    const row = db.prepare("SELECT revision,ciphertext FROM work_item_display WHERE scope_key=?").get(key);
    if (!row) return null;
    return decodeTitle(key, row, encryptionKey);
  }
  function rename(actor, kind, id, { title, expectedDisplayRevision }, now = new Date().toISOString()) {
    if (typeof title !== "string" || !title.trim() || Array.from(title.trim()).length > 80 || /[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/.test(title) || !Number.isSafeInteger(expectedDisplayRevision) || expectedDisplayRevision < 0) throw failure("group_title_invalid");
    const key = scopeKey(actor, kind, id);
    db.exec("BEGIN IMMEDIATE");
    try {
      const old = read(actor, kind, id);
      if ((old?.displayRevision || 0) !== expectedDisplayRevision) throw failure("group_title_conflict");
      const value = { title: title.trim(), titleUpdatedAt: now };
      const revision = expectedDisplayRevision + 1;
      const iv = crypto.randomBytes(12);
      const cipher = crypto.createCipheriv("aes-256-gcm", encryptionKey, iv);
      cipher.setAAD(Buffer.from(`${key}:${revision}`));
      const data = Buffer.concat([cipher.update(JSON.stringify(value), "utf8"), cipher.final()]);
      const ciphertext = JSON.stringify({ iv: iv.toString("base64"), tag: cipher.getAuthTag().toString("base64"), data: data.toString("base64") });
      db.prepare("INSERT INTO work_item_display VALUES(?,?,?) ON CONFLICT(scope_key) DO UPDATE SET revision=excluded.revision,ciphertext=excluded.ciphertext").run(key, revision, ciphertext);
      db.exec("COMMIT");
      return { ...value, displayRevision: revision };
    } catch (error) { db.exec("ROLLBACK"); throw error; }
  }
  return Object.freeze({ read, rename, close: () => closeSqliteDatabase(db) });
}

function validateTable(db, name, expected) {
  const object = db.prepare("SELECT type FROM sqlite_schema WHERE name=?").get(name);
  if (!object) return false;
  const actual = db.prepare(`PRAGMA table_info(${name})`).all().map(row => [row.name, row.type, row.notnull, row.pk]);
  if (object.type !== "table" || JSON.stringify(actual) !== JSON.stringify(expected)) throw failure("work_item_display_schema_invalid");
  return true;
}

function decodeTitle(key, row, encryptionKey) {
  try {
    if (!/^[a-f0-9]{64}$/.test(key) || !Number.isSafeInteger(row.revision) || row.revision < 1) throw new Error();
    const sealed = JSON.parse(row.ciphertext);
    const decipher = crypto.createDecipheriv("aes-256-gcm", encryptionKey, Buffer.from(sealed.iv, "base64"));
    decipher.setAAD(Buffer.from(`${key}:${row.revision}`));
    decipher.setAuthTag(Buffer.from(sealed.tag, "base64"));
    const value = JSON.parse(Buffer.concat([decipher.update(Buffer.from(sealed.data, "base64")), decipher.final()]).toString("utf8"));
    if (typeof value?.title !== "string" || !value.title.trim() || Array.from(value.title).length > 80 || typeof value.titleUpdatedAt !== "string") throw new Error();
    return { ...value, displayRevision: row.revision };
  } catch { throw failure("work_item_display_integrity_invalid"); }
}
function failure(code) { return Object.assign(new Error(code), { code }); }
