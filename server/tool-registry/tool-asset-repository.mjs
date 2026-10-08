import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";
import { compileOpenApiOperations, openApiContractDigest, capabilityWritePolicyDigests } from "../agent-runtime/openapi-contract.mjs";

const FIELDS = ["toolId", "displayName", "description", "ownerDepartmentId", "sourceSystemId", "risk", "permissionBoundary", "writebackBoundary", "baseUrl", "credentialRef", "openApiDocument"];

// Asset publication owns the executable contract. Employee binding and per-call
// authorization remain with the existing Tool governance and Runtime boundaries.
export function createToolAssetRepository({ databasePath, validateReferences, readOnly = false, now = () => new Date().toISOString() }) {
  if (typeof validateReferences !== "function") throw new TypeError("Tool reference authority required");
  if (!readOnly && databasePath !== ":memory:") fs.mkdirSync(path.dirname(databasePath), { recursive: true });
  const db = new DatabaseSync(databasePath, { readOnly });
  if (!readOnly) db.exec(`PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL;
    CREATE TABLE IF NOT EXISTS tool_asset_meta (id TEXT PRIMARY KEY);
    CREATE TABLE IF NOT EXISTS tool_assets (
      tool_id TEXT PRIMARY KEY, revision INTEGER NOT NULL, draft_json TEXT,
      published_json TEXT, published_revision INTEGER, disabled INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS tool_asset_versions (
      tool_id TEXT NOT NULL, revision INTEGER NOT NULL, asset_json TEXT NOT NULL,
      PRIMARY KEY(tool_id,revision)
    );
    CREATE TABLE IF NOT EXISTS tool_asset_events (
      sequence INTEGER PRIMARY KEY AUTOINCREMENT, tool_id TEXT NOT NULL,
      revision INTEGER NOT NULL, action TEXT NOT NULL, actor_digest TEXT NOT NULL,
      occurred_at TEXT NOT NULL
    );`);
  function transaction(fn) {
    db.exec("BEGIN IMMEDIATE");
    try { const result = fn(); db.exec("COMMIT"); return result; }
    catch (error) { if (db.isTransaction) db.exec("ROLLBACK"); throw error; }
  }
  function row(id) { return db.prepare("SELECT * FROM tool_assets WHERE tool_id=?").get(token(id)); }
  function event(id, revision, action, actorDigest) {
    if (!/^[a-f0-9]{64}$/.test(actorDigest || "")) throw failure("tool_asset_actor_required");
    db.prepare("INSERT INTO tool_asset_events(tool_id,revision,action,actor_digest,occurred_at) VALUES(?,?,?,?,?)")
      .run(id, revision, action, actorDigest, now());
  }
  function checkVersion(current, expectedVersion) {
    if (!Number.isSafeInteger(expectedVersion) || expectedVersion < 0 || (current?.revision || 0) !== expectedVersion) {
      throw failure("tool_asset_version_conflict");
    }
  }
  function seedBuiltins(items) {
    return transaction(() => {
      if (db.prepare("SELECT id FROM tool_asset_meta WHERE id='builtin-catalog.v1'").get()) return false;
      for (const item of items) {
        const id = token(item.id);
        if (row(id)) throw failure("tool_asset_seed_conflict");
        db.prepare("INSERT INTO tool_assets VALUES(?,1,NULL,?,1,0,?)")
          .run(id, JSON.stringify({ kind: "builtin", catalog: item }), now());
      }
      db.prepare("INSERT INTO tool_asset_meta VALUES('builtin-catalog.v1')").run();
      return true;
    });
  }
  function submit({ asset, expectedVersion, actorDigest }) {
    const normalized = normalizeAsset(asset);
    return transaction(() => {
      const current = row(normalized.toolId); checkVersion(current, expectedVersion);
      if (current?.published_json && JSON.parse(current.published_json).kind === "builtin") throw failure("tool_asset_builtin_not_editable");
      const revision = expectedVersion + 1;
      db.prepare(`INSERT INTO tool_assets(tool_id,revision,draft_json,updated_at) VALUES(?,?,?,?)
        ON CONFLICT(tool_id) DO UPDATE SET revision=excluded.revision,draft_json=excluded.draft_json,updated_at=excluded.updated_at`)
        .run(normalized.toolId, revision, JSON.stringify(normalized), now());
      db.prepare("INSERT INTO tool_asset_versions VALUES(?,?,?)").run(normalized.toolId, revision, JSON.stringify(normalized));
      event(normalized.toolId, revision, "submitted", actorDigest);
      return get(normalized.toolId);
    });
  }
  function decide({ toolId, expectedVersion, decision, actorDigest }) {
    if (!["publish", "reject", "disable"].includes(decision)) throw failure("tool_asset_decision_invalid");
    return transaction(() => {
      const current = row(toolId); checkVersion(current, expectedVersion);
      if (!current) throw failure("tool_asset_not_found");
      if (current.published_json && JSON.parse(current.published_json).kind === "builtin") throw failure("tool_asset_builtin_not_editable");
      const revision = expectedVersion + 1;
      if (decision === "publish") {
        if (!current.draft_json) throw failure("tool_asset_draft_required");
        const asset = normalizeStoredAsset(JSON.parse(current.draft_json));
        if (validateReferences(asset) !== true) throw failure("tool_asset_reference_unavailable");
        db.prepare("UPDATE tool_assets SET revision=?,published_json=draft_json,published_revision=?,draft_json=NULL,disabled=0,updated_at=? WHERE tool_id=?")
          .run(revision, revision, now(), toolId);
      } else if (decision === "reject") {
        if (!current.draft_json) throw failure("tool_asset_draft_required");
        db.prepare("UPDATE tool_assets SET revision=?,draft_json=NULL,updated_at=? WHERE tool_id=?").run(revision, now(), toolId);
      } else {
        db.prepare("UPDATE tool_assets SET revision=?,disabled=1,updated_at=? WHERE tool_id=?").run(revision, now(), toolId);
      }
      event(toolId, revision, decision, actorDigest);
      return get(toolId);
    });
  }
  function review(toolId) {
    const current = row(toolId);
    if (!current) return null;
    const asset = JSON.parse(current.draft_json || current.published_json || "null");
    return { ...get(toolId), asset };
  }
  function get(toolId) {
    const current = row(toolId); if (!current) return null;
    const draft = current.draft_json ? JSON.parse(current.draft_json) : null;
    const published = current.published_json ? JSON.parse(current.published_json) : null;
    return { toolId, editable: published?.kind !== "builtin", revision: current.revision, publishedRevision: current.published_revision,
      state: current.disabled ? "disabled" : published ? "published" : "unpublished",
      pendingReview: Boolean(draft), draft: draft ? project(draft) : null,
      published: published ? project(published) : null, updatedAt: current.updated_at };
  }
  function list() { return db.prepare("SELECT tool_id FROM tool_assets ORDER BY tool_id").all().map(item => get(item.tool_id)); }
  function publishedAssets() {
    return db.prepare("SELECT tool_id,published_json,published_revision FROM tool_assets WHERE disabled=0 AND published_json IS NOT NULL ORDER BY tool_id")
      .all().map(item => ({ ...JSON.parse(item.published_json), assetRevision: item.published_revision }));
  }
  function catalog() { return publishedAssets().map(asset => project(asset)); }
  function resolvePublished(toolId) {
    const current = row(toolId);
    if (!current || current.disabled || !current.published_json) return null;
    const asset = JSON.parse(current.published_json);
    if (asset.kind === "builtin") return { ...asset, assetRevision: current.published_revision };
    normalizeStoredAsset(asset);
    if (validateReferences(asset) !== true) return null;
    return { ...asset, assetRevision: current.published_revision };
  }
  if (readOnly) return Object.freeze({ get, review, list, catalog, publishedAssets, resolvePublished, close: () => db.close() });
  return Object.freeze({ seedBuiltins, submit, decide, get, review, list, catalog, publishedAssets, resolvePublished, close: () => db.close() });
}
function normalizeStoredAsset(asset) {
  const normalized = normalizeAsset(Object.fromEntries(FIELDS.map(key => [key, asset[key]])));
  if (asset.kind !== "managed_openapi" || asset.contractDigest !== normalized.contractDigest) throw failure("tool_asset_integrity_invalid");
  return normalized;
}
function normalizeAsset(value) {
  if (!value || Array.isArray(value) || Object.keys(value).length !== FIELDS.length || Object.keys(value).some(key => !FIELDS.includes(key))) throw failure("tool_asset_invalid");
  const asset = structuredClone(value);
  for (const key of ["toolId", "sourceSystemId", "credentialRef", "ownerDepartmentId"]) asset[key] = token(asset[key]);
  if (["catalog", "connections"].includes(asset.toolId)) throw failure("tool_asset_identifier_reserved");
  for (const [key, max] of [["displayName", 160], ["description", 2000], ["permissionBoundary", 2000], ["writebackBoundary", 2000]]) {
    if (typeof asset[key] !== "string" || !asset[key].trim() || asset[key].length > max) throw failure("tool_asset_invalid");
    asset[key] = asset[key].trim();
  }
  if (!["低", "中", "高"].includes(asset.risk)) throw failure("tool_asset_invalid");
  let url;
  try { url = new URL(asset.baseUrl); } catch { throw failure("tool_asset_endpoint_invalid"); }
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) throw failure("tool_asset_endpoint_invalid");
  asset.baseUrl = url.toString().replace(/\/+$/, "");
  if (Buffer.byteLength(JSON.stringify(asset.openApiDocument)) > 1024 * 1024) throw failure("tool_asset_contract_too_large");
  let operations;
  try { operations = compileOpenApiOperations({ document: asset.openApiDocument, toolId: asset.toolId }); }
  catch { throw failure("tool_asset_contract_invalid"); }
  if (!operations.length || operations.length > 1000) throw failure("tool_asset_contract_invalid");
  // Remote references/servers never choose the outbound target or credential.
  const visit = value => {
    if (!value || typeof value !== "object") return;
    for (const [key, child] of Object.entries(value)) {
      if (key === "$ref" && (typeof child !== "string" || !child.startsWith("#/"))) throw failure("tool_asset_external_ref_forbidden");
      visit(child);
    }
  };
  visit(asset.openApiDocument);
  const schemes = Object.values(asset.openApiDocument.components?.securitySchemes || {});
  if (schemes.length !== 1 || schemes[0].type !== "apiKey" || schemes[0].in !== "header" ||
    !/^[A-Za-z][A-Za-z0-9-]{0,79}$/.test(schemes[0].name || "") || /^(cookie|host|content-length|connection)$/i.test(schemes[0].name)) {
    throw failure("tool_asset_credential_contract_invalid");
  }
  return { ...asset, kind: "managed_openapi", contractDigest: openApiContractDigest(asset.openApiDocument),
    credentialHeader: schemes[0].name, operationCount: operations.length };
}
function project(asset) {
  if (asset.kind === "builtin") return structuredClone(asset.catalog);
  const operations = compileOpenApiOperations({ document: asset.openApiDocument, toolId: asset.toolId });
  const digests = capabilityWritePolicyDigests(operations);
  const capabilityPolicies = Object.entries(digests).map(([capability, writePolicyDigest]) => ({
    capability, writePolicyDigest,
    operations: operations.filter(operation => operation.capabilities.includes(capability))
      .map(({ operationId, method, risk, summary }) => ({ operationId, method, risk, summary })),
  }));
  return { capabilityPolicies, id: asset.toolId, name: asset.displayName, displayName: asset.displayName,
    description: asset.description, toolType: "Controlled REST API", executionKind: "managed_openapi",
    sourceSystemId: asset.sourceSystemId, ownerDepartmentId: asset.ownerDepartmentId, risk: asset.risk,
    status: "已登记", permissionBoundary: asset.permissionBoundary, writebackBoundary: asset.writebackBoundary,
    credentialBoundary: "服务端受管凭证引用；不向模型或前端提供密钥",
    contractDigest: asset.contractDigest, operationCount: asset.operationCount,
    operationCatalog: { kind: "runtime_openapi", sourceOfTruth: "backend_tool_asset_registry" },
    defaultEmployeeBindingPolicy: "administrator_enablement", assetRevision: asset.assetRevision };
}
function token(value) { if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/.test(value)) throw failure("tool_asset_identifier_invalid"); return value; }
function failure(code) { return Object.assign(new Error(code), { code }); }
