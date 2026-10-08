import crypto from "node:crypto";
import { createReadStream, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { digitalEmployeeCharacterFor } from "../src/data/digitalEmployeeCharacters.js";

const CHARACTER_ASSET_ROOT = fileURLToPath(new URL("../src/assets/digital-employee-characters/", import.meta.url));
const CHARACTER_CONTRACT_VERSION = "digital-employee-character.v1";
const assetCache = new Map();
const variants = Object.freeze({
  animated: { contentType: "image/webp", suffix: "animated", extension: "webp" },
  static: { contentType: "image/png", suffix: "static", extension: "png" },
});

function projectDesktopCharacter(employeeId = "") {
  const id = cleanId(employeeId);
  const character = digitalEmployeeCharacterFor(id);
  if (!character || !safeAssetStem(character.assetStem)) return null;
  const staticAsset = resolveCharacterAsset(id, "static");
  if (!staticAsset) return null;
  const animatedAsset = resolveCharacterAsset(id, "animated");
  return {
    contractVersion: CHARACTER_CONTRACT_VERSION,
    assetRevision: [staticAsset.revision, animatedAsset?.revision || "static-only"].join("."),
    codename: cleanText(character.codename, 80),
    accent: safeAccent(character.accent),
    roleModule: cleanText(character.roleModule, 240),
    signatureMotion: cleanText(character.signatureMotion, 240),
    staticSrc: assetRoute(id, "static", staticAsset.revision),
    animatedSrc: animatedAsset ? assetRoute(id, "animated", animatedAsset.revision) : "",
  };
}

function createDigitalEmployeeCharacterHandlers({
  requireSession,
  sendAsset = defaultSendAsset,
  sendJson,
} = {}) {
  return {
    async handle(req, res, url) {
      const match = url.pathname.match(/^\/api\/digital-employee-characters\/([^/]+)\/(static|animated)$/);
      if (req.method !== "GET" || !match) return undefined;
      if (!requireSession(req, res)) return null;
      const asset = resolveCharacterAsset(match[1], match[2]);
      if (!asset) {
        return sendJson(res, 404, {
          ok: false,
          error: "digital_employee_character_asset_not_found",
          contractVersion: CHARACTER_CONTRACT_VERSION,
        });
      }
      await sendAsset(req, res, asset);
      return true;
    },
  };
}

function resolveCharacterAsset(employeeId = "", variant = "") {
  const id = cleanId(employeeId);
  const options = variants[variant];
  const character = digitalEmployeeCharacterFor(id);
  const stem = safeAssetStem(character?.assetStem);
  if (!id || !options || !stem) return null;
  const filePath = path.join(CHARACTER_ASSET_ROOT, `${stem}-${options.suffix}.${options.extension}`);
  if (path.dirname(filePath) !== path.resolve(CHARACTER_ASSET_ROOT)) return null;
  try {
    const stat = statSync(filePath);
    if (!stat.isFile()) return null;
    const cacheKey = `${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`;
    const cached = assetCache.get(filePath);
    if (cached?.cacheKey === cacheKey) return cached.asset;
    const revision = crypto.createHash("sha256").update(readFileSync(filePath)).digest("hex").slice(0, 16);
    const asset = { contentType: options.contentType, filePath, revision, size: stat.size };
    assetCache.set(filePath, { asset, cacheKey });
    return asset;
  } catch {
    return null;
  }
}

async function defaultSendAsset(req, res, asset) {
  const etag = `"sha256-${asset.revision}"`;
  if (String(req.headers?.["if-none-match"] || "") === etag) {
    res.writeHead(304, { ETag: etag });
    res.end();
    return;
  }
  res.writeHead(200, {
    "Cache-Control": "private, max-age=300, must-revalidate",
    "Content-Length": asset.size,
    "Content-Type": asset.contentType,
    ETag: etag,
    "X-Content-Type-Options": "nosniff",
  });
  createReadStream(asset.filePath).pipe(res);
}

function assetRoute(employeeId, variant, revision) {
  return `/api/digital-employee-characters/${encodeURIComponent(employeeId)}/${variant}?v=${revision}`;
}

function safeAssetStem(value) {
  const stem = String(value || "").trim().toLowerCase();
  return /^[a-z0-9._-]{1,120}$/.test(stem) ? stem : "";
}

function safeAccent(value) {
  const accent = String(value || "").trim();
  return /^#[0-9a-f]{6}$/i.test(accent) ? accent : "#27877b";
}

function cleanId(value) {
  return String(value || "").trim().toLowerCase().replace(/[^a-z0-9._-]+/g, "-").slice(0, 120);
}

function cleanText(value, maxLength) {
  return String(value || "").replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, maxLength);
}

export {
  CHARACTER_CONTRACT_VERSION,
  createDigitalEmployeeCharacterHandlers,
  projectDesktopCharacter,
  resolveCharacterAsset,
};
