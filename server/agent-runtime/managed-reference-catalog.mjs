import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const CONTRACT_VERSION = "managed-reference-catalog.v1";
const MAX_CATALOGS = 200;
const MAX_ENTRIES = 200;

function createManagedReferenceCatalogStore({ filePath } = {}) {
  const safeFilePath = requiredAbsolutePath(filePath);

  function catalogFor({ catalogId = "", employeeId = "", toolId = "" } = {}) {
    const identity = normalizeIdentity({ catalogId, employeeId, toolId });
    const catalog = readState(safeFilePath).catalogs.find((item) => sameIdentity(item, identity));
    return catalog ? structuredClone(publicRuntimeCatalog(catalog)) : null;
  }

  function replaceCatalog(value = {}) {
    const catalog = normalizeCatalog(value);
    const state = readState(safeFilePath);
    const catalogs = state.catalogs.filter((item) => !sameIdentity(item, catalog));
    catalogs.push(catalog);
    writeState(safeFilePath, { contractVersion: CONTRACT_VERSION, catalogs: catalogs.slice(-MAX_CATALOGS) });
    return publicCatalogSummary(catalog);
  }

  function listCatalogs({ employeeId = "", toolId = "" } = {}) {
    const normalizedEmployeeId = cleanId(employeeId);
    const normalizedToolId = cleanId(toolId);
    return readState(safeFilePath).catalogs
      .filter((catalog) => (!normalizedEmployeeId || catalog.employeeId === normalizedEmployeeId) &&
        (!normalizedToolId || catalog.toolId === normalizedToolId))
      .map(publicToolResourceCatalog);
  }

  return Object.freeze({ catalogFor, contractVersion: CONTRACT_VERSION, listCatalogs, replaceCatalog });
}

function searchManagedReferences(catalog = null, { limit = 10, query = "" } = {}) {
  if (!catalog || catalog.contractVersion !== CONTRACT_VERSION) return [];
  const terms = cleanText(query, 240).toLowerCase().split(/\s+/).filter(Boolean);
  const safeLimit = Number.isSafeInteger(limit) ? Math.min(20, Math.max(1, limit)) : 10;
  return catalog.entries.filter((entry) => {
    if (!terms.length) return true;
    const haystack = [entry.ref, entry.label, ...entry.aliases].join(" ").toLowerCase();
    return terms.every((term) => haystack.includes(term));
  }).slice(0, safeLimit).map(publicReference);
}

function resolveManagedReference(catalog = null, { allowHiddenValue = false, argumentPath = "", operationId = "", ref = "" } = {}) {
  if (!catalog || catalog.contractVersion !== CONTRACT_VERSION) return null;
  const rawRef = cleanText(ref, 500);
  const normalizedRef = cleanId(ref);
  const normalizedOperationId = cleanId(operationId);
  const normalizedPath = normalizeArgumentPath(argumentPath);
  const entry = catalog.entries.find((candidate) => (
    candidate.ref === normalizedRef ||
    (allowHiddenValue === true && rawRef && candidate.hiddenValue === rawRef)
  ) && candidate.operationIds.includes(normalizedOperationId) && candidate.argumentPaths.includes(normalizedPath));
  return entry ? structuredClone(entry) : null;
}

function normalizeCatalog(value = {}) {
  const identity = normalizeIdentity(value);
  const version = requiredToken(value.version || "1", "version", 80);
  const entries = (Array.isArray(value.entries) ? value.entries : []).slice(0, MAX_ENTRIES).map(normalizeEntry);
  if (!entries.length || new Set(entries.map((entry) => entry.ref)).size !== entries.length) {
    throw new TypeError("managed reference catalog entries must be non-empty with unique refs");
  }
  const digest = catalogDigest({ ...identity, version, entries });
  return { contractVersion: CONTRACT_VERSION, ...identity, version, digest, entries };
}

function normalizeEntry(value = {}) {
  const ref = cleanId(value.ref);
  const label = requiredToken(value.label, "label", 120);
  const hiddenValue = requiredToken(value.hiddenValue, "hiddenValue", 500);
  const aliases = cleanList(value.aliases, 20, 120);
  const operationIds = cleanList(value.operationIds, 20, 180).map(cleanId).filter(Boolean);
  const argumentPaths = cleanList(value.argumentPaths, 20, 240).map(normalizeArgumentPath).filter(Boolean);
  if (!ref || !operationIds.length || !argumentPaths.length) throw new TypeError("managed reference catalog entry is incomplete");
  return { ref, label, aliases, hiddenValue, operationIds, argumentPaths };
}

function publicRuntimeCatalog(catalog = {}) {
  return {
    contractVersion: CONTRACT_VERSION,
    catalogId: catalog.catalogId,
    employeeId: catalog.employeeId,
    toolId: catalog.toolId,
    version: catalog.version,
    digest: catalog.digest,
    entries: catalog.entries.map((entry) => ({ ...entry, aliases: [...entry.aliases], operationIds: [...entry.operationIds], argumentPaths: [...entry.argumentPaths] })),
  };
}

function publicCatalogSummary(catalog = {}) {
  return {
    contractVersion: CONTRACT_VERSION,
    catalogId: catalog.catalogId,
    employeeId: catalog.employeeId,
    toolId: catalog.toolId,
    version: catalog.version,
    digest: catalog.digest,
    entryCount: catalog.entries.length,
  };
}

function publicToolResourceCatalog(catalog = {}) {
  return {
    contractVersion: "governed-tool-resource-catalog.v1",
    catalogId: catalog.catalogId,
    employeeId: catalog.employeeId,
    toolId: catalog.toolId,
    version: catalog.version,
    digest: catalog.digest,
    resources: catalog.entries.map((entry) => ({
      resourceId: entry.ref,
      name: entry.label,
      aliases: [...entry.aliases],
      status: "active",
      operationIds: [...entry.operationIds],
      argumentPaths: [...entry.argumentPaths],
    })),
  };
}

function publicReference(entry = {}) {
  return { ref: entry.ref, label: entry.label, aliases: [...entry.aliases] };
}

function readState(filePath) {
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
    if (parsed?.contractVersion !== CONTRACT_VERSION || !Array.isArray(parsed.catalogs)) return emptyState();
    return { contractVersion: CONTRACT_VERSION, catalogs: parsed.catalogs.slice(0, MAX_CATALOGS).map(normalizeStoredCatalog) };
  } catch (error) {
    if (error?.code === "ENOENT") return emptyState();
    throw error;
  }
}

function normalizeStoredCatalog(value = {}) {
  const normalized = normalizeCatalog(value);
  if (value.digest && value.digest !== normalized.digest) throw new TypeError("managed reference catalog digest mismatch");
  return normalized;
}

function writeState(filePath, state) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const temporaryPath = `${filePath}.${process.pid}.${crypto.randomUUID()}.tmp`;
  fs.writeFileSync(temporaryPath, `${JSON.stringify(state, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  fs.renameSync(temporaryPath, filePath);
}

function normalizeIdentity(value = {}) {
  return {
    catalogId: requiredToken(value.catalogId, "catalogId", 120),
    employeeId: requiredToken(value.employeeId, "employeeId", 180),
    toolId: requiredToken(value.toolId, "toolId", 180),
  };
}

function sameIdentity(left = {}, right = {}) {
  return left.catalogId === right.catalogId && left.employeeId === right.employeeId && left.toolId === right.toolId;
}

function catalogDigest(value = {}) {
  return `sha256:${crypto.createHash("sha256").update(canonicalJson(value)).digest("hex")}`;
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  return JSON.stringify(value);
}

function emptyState() { return { contractVersion: CONTRACT_VERSION, catalogs: [] }; }
function cleanId(value = "") { return String(value || "").trim().toLowerCase().replace(/[^a-z0-9._:-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 180); }
function cleanText(value = "", max = 500) { return String(value || "").replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, max); }
function cleanList(value, maxItems, maxLength) { return [...new Set((Array.isArray(value) ? value : []).map((item) => cleanText(item, maxLength)).filter(Boolean))].slice(0, maxItems); }
function normalizeArgumentPath(value = "") { return cleanText(value, 240).split(".").filter((part) => /^[A-Za-z0-9_-]{1,120}$/.test(part)).join("."); }
function requiredToken(value, field, max) { const token = cleanText(value, max); if (!token) throw new TypeError(`managed reference catalog ${field} is required`); return token; }
function requiredAbsolutePath(value) { const text = String(value || "").trim(); if (!path.isAbsolute(text)) throw new TypeError("managed reference catalog filePath must be absolute"); return path.normalize(text); }

export {
  CONTRACT_VERSION,
  createManagedReferenceCatalogStore,
  resolveManagedReference,
  searchManagedReferences,
};
