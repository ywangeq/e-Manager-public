import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const STORE_VERSION = "asset-package-download-events.v1";
const EVENT_VERSION = "asset-package-download-event.v1";
const MAX_EVENTS = 10000;
const ASSET_KINDS = new Set(["digital_employee", "business_skill"]);

export function createAssetPackageDownloadStore({
  projectRoot = process.cwd(),
  storePath,
  hashSalt = "digital-workforce-mvp-asset-package-downloads",
  redactError = (error) => String(error?.message || error),
} = {}) {
  function recordDownload(input = {}, session = null) {
    const event = sanitizeEvent(input, session);
    if (!event) return null;
    const store = readStore();
    store.events.push(event);
    store.events = store.events.slice(-MAX_EVENTS);
    store.updatedAt = event.occurredAt;
    writeStore(store);
    return event;
  }

  function readEvents() {
    return readStore().events;
  }

  function coveragePath() {
    return storePath ? path.relative(projectRoot, storePath) : "";
  }

  function readStore() {
    try {
      if (!storePath || !fs.existsSync(storePath)) return emptyStore();
      const raw = fs.readFileSync(storePath, "utf8");
      if (!raw.trim()) return emptyStore();
      const parsed = JSON.parse(raw);
      return {
        version: STORE_VERSION,
        createdAt: cleanShortText(parsed.createdAt),
        updatedAt: cleanShortText(parsed.updatedAt),
        events: Array.isArray(parsed.events) ? parsed.events.map(sanitizeStoredEvent).filter(Boolean).slice(-MAX_EVENTS) : [],
      };
    } catch (error) {
      console.warn("[asset-package-downloads] failed to read store:", redactError(error));
      return emptyStore();
    }
  }

  function writeStore(store) {
    if (!storePath) return;
    try {
      fs.mkdirSync(path.dirname(storePath), { recursive: true });
      fs.writeFileSync(storePath, `${JSON.stringify(store, null, 2)}\n`, "utf8");
    } catch (error) {
      console.warn("[asset-package-downloads] failed to write store:", redactError(error));
    }
  }

  function emptyStore() {
    const now = new Date().toISOString();
    return { version: STORE_VERSION, createdAt: now, updatedAt: "", events: [] };
  }

  function sanitizeEvent(input = {}, session = null) {
    const assetKind = cleanShortText(input.assetKind);
    const assetId = cleanStableId(input.assetId);
    const actorKey = actorHash(session);
    if (!ASSET_KINDS.has(assetKind) || !assetId || !actorKey) return null;
    return {
      id: `APD-${Date.now()}-${crypto.randomBytes(4).toString("hex")}`,
      contractVersion: EVENT_VERSION,
      assetKind,
      assetId,
      assetVersion: cleanShortText(input.assetVersion),
      occurredAt: new Date().toISOString(),
      actorKey,
      actorDepartmentId: cleanStableId(session?.departmentId),
      actorRole: cleanShortText(session?.role),
      source: cleanStableId(input.source || "management_console"),
    };
  }

  function sanitizeStoredEvent(event = {}) {
    const assetKind = cleanShortText(event.assetKind);
    const assetId = cleanStableId(event.assetId);
    const occurredAt = cleanShortText(event.occurredAt);
    const actorKey = cleanStableId(event.actorKey);
    if (!ASSET_KINDS.has(assetKind) || !assetId || !actorKey || Number.isNaN(new Date(occurredAt).getTime())) return null;
    return {
      id: cleanStableId(event.id || `${assetKind}-${assetId}-${occurredAt}`),
      contractVersion: EVENT_VERSION,
      assetKind,
      assetId,
      assetVersion: cleanShortText(event.assetVersion),
      occurredAt,
      actorKey,
      actorDepartmentId: cleanStableId(event.actorDepartmentId),
      actorRole: cleanShortText(event.actorRole),
      source: cleanStableId(event.source || "management_console"),
    };
  }

  function actorHash(session = null) {
    const raw = cleanShortText(session?.employeeId || session?.feishuUserId || session?.employeeNo || session?.email);
    if (!raw) return "";
    return crypto.createHash("sha256").update(`${hashSalt}:${raw}`).digest("hex").slice(0, 16);
  }

  return { coveragePath, readEvents, recordDownload };
}

function cleanShortText(value) {
  return String(value || "").replace(/\s+/g, " ").trim().slice(0, 160);
}

function cleanStableId(value) {
  return String(value || "").trim().replace(/[^a-zA-Z0-9._:@/-]/g, "").slice(0, 180);
}
