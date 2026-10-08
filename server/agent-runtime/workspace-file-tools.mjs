import { execFile } from "node:child_process";
import { lstat, mkdir, readdir, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { createEphemeralMediaRef } from "./ephemeral-media-ref.mjs";
import { canonicalInputDescriptor } from "./canonical-input-types.mjs";
import { createWorkspaceOperations } from "./workspace-operations-v1.mjs";

const execFileAsync = promisify(execFile);
const IMAGE_MIME_TYPES = new Map([
  [".jpg", "image/jpeg"],
  [".jpeg", "image/jpeg"],
  [".png", "image/png"],
  [".webp", "image/webp"],
  [".gif", "image/gif"],
]);
const IMAGE_EXTENSIONS_BY_MIME = new Map([...IMAGE_MIME_TYPES.entries()].map(([extension, mimeType]) => [mimeType, extension]));
const TEXT_OUTPUT_EXTENSIONS = new Set([".csv", ".html", ".json", ".md", ".txt"]);
const MAX_TEXT_OUTPUT_BYTES = 4_000_000;
const MAX_REPORT_BUNDLE_ASSETS = 200;
const MAX_REPORT_BUNDLE_ASSET_BYTES = 64_000_000;

function createWorkspaceFileTools({ archiveLimits, workspace = null, maxWorkspaceBytes } = {}) {
  const operations = createWorkspaceOperations({ archiveLimits, workspace, maxWorkspaceBytes });

  async function list({ relativePath = ".", maxDepth = 2 } = {}) {
    const target = await resolveReadableWorkspacePath(relativePath);
    if (!(await stat(target)).isDirectory()) throw new Error("workspace_path_not_directory");
    const entries = [];
    await visit(target, "", Math.max(0, Math.min(Number(maxDepth) || 2, 4)), entries);
    return entries.slice(0, 500);
  }

  async function readText({ relativePath = "", offset = 0, maxChars = 20_000 } = {}) {
    const target = await resolveReadableWorkspacePath(relativePath);
    const metadata = await stat(target);
    if (!metadata.isFile() || metadata.size > 2_000_000) throw new Error("workspace_text_file_rejected");
    const bytes = await readFile(target);
    if (bytes.includes(0)) throw new Error("workspace_binary_file_rejected");
    const text = bytes.toString("utf8");
    const start = Math.max(0, Math.min(Number(offset) || 0, text.length));
    const limit = Math.max(1, Math.min(Number(maxChars) || 20_000, 40_000));
    return { content: text.slice(start, start + limit), offset: start, truncated: start + limit < text.length };
  }

  async function imageEvidence({ relativePath = "" } = {}) {
    const target = await resolveReadableWorkspacePath(relativePath);
    const mimeType = IMAGE_MIME_TYPES.get(path.extname(target).toLowerCase());
    if (!mimeType) throw new Error("workspace_image_type_rejected");
    const mediaRef = await createEphemeralMediaRef({ filePath: target, mimeType, root: workspace.root, maxBytes: 8_000_000 });
    return { mediaRef, mimeType, caption: `Workspace image: ${safeRelativePath(relativePath)}` };
  }

  async function modelInput({ relativePath = "" } = {}) {
    const target = await resolveReadableWorkspacePath(relativePath);
    const fileName = path.basename(target);
    const descriptor = canonicalInputDescriptor({ fileName });
    if (!descriptor) throw new Error("workspace_model_input_type_rejected");
    const mediaRef = await createEphemeralMediaRef({
      fileName,
      filePath: target,
      mimeType: descriptor.mimeType,
      root: workspace.root,
      maxBytes: 50 * 1024 * 1024,
    });
    return {
      type: descriptor.type,
      mediaRef,
      mimeType: descriptor.mimeType,
      fileName,
      detailHint: descriptor.mimeType === "application/pdf" ? "high" : "auto",
      caption: `Workspace ${descriptor.type}: ${safeRelativePath(relativePath)}`,
    };
  }

  async function writeText({ relativePath = "", content = "" } = {}) {
    const normalized = safeRelativePath(relativePath);
    if (!normalized || path.isAbsolute(relativePath) || normalized.split("/").includes("..")) throw new Error("workspace_output_path_rejected");
    const extension = path.extname(normalized).toLowerCase();
    if (!TEXT_OUTPUT_EXTENSIONS.has(extension)) throw new Error("workspace_output_type_rejected");
    const text = String(content || "");
    if (!text || Buffer.byteLength(text, "utf8") > MAX_TEXT_OUTPUT_BYTES || text.includes("\0")) throw new Error("workspace_output_content_rejected");
    if (extension === ".html" && hasUnsafeHtmlContent(text)) throw new Error("workspace_output_html_rejected");
    const workspacePath = `output/${normalized}`;
    const target = await operations.resolveWritablePath(workspacePath);
    await operations.writeOrReplace({ relativePath: workspacePath, content: text });
    return { fileName: path.basename(target), filePath: target, relativePath: normalized, format: path.extname(target).slice(1), sizeBytes: Buffer.byteLength(text) };
  }

  async function writeReportBundle({ relativePath = "", html = "", assets = [] } = {}) {
    const normalized = safeRelativePath(relativePath);
    if (!normalized || path.isAbsolute(relativePath) || normalized.split("/").includes("..")) throw new Error("workspace_report_bundle_path_rejected");
    if (path.extname(normalized).toLowerCase() !== ".zip") throw new Error("workspace_report_bundle_type_rejected");
    const content = String(html || "");
    if (!content || Buffer.byteLength(content, "utf8") > MAX_TEXT_OUTPUT_BYTES || content.includes("\0")) throw new Error("workspace_report_bundle_content_rejected");
    if (content.includes("visual-evidence://") || hasUnsafeHtmlContent(content)) throw new Error("workspace_report_bundle_html_rejected");

    const resolvedOutputRoot = await realpath(workspace?.outputRoot || "");
    const targetZip = path.resolve(resolvedOutputRoot, normalized);
    const relativeZip = path.relative(resolvedOutputRoot, targetZip);
    if (relativeZip === ".." || relativeZip.startsWith(`..${path.sep}`) || path.isAbsolute(relativeZip)) throw new Error("workspace_report_bundle_path_rejected");
    await mkdir(path.dirname(targetZip), { recursive: true, mode: 0o700 });
    const resolvedParent = await realpath(path.dirname(targetZip));
    if (resolvedParent !== resolvedOutputRoot && !resolvedParent.startsWith(`${resolvedOutputRoot}${path.sep}`)) throw new Error("workspace_report_bundle_path_rejected");
    const existingZip = await lstat(targetZip).catch(() => null);
    if (existingZip?.isSymbolicLink() || existingZip && !existingZip.isFile()) throw new Error("workspace_report_bundle_path_rejected");

    const bundleRoot = path.resolve(path.dirname(targetZip), path.basename(normalized, ".zip"));
    const relativeBundle = path.relative(resolvedOutputRoot, bundleRoot);
    if (relativeBundle === ".." || relativeBundle.startsWith(`..${path.sep}`) || path.isAbsolute(relativeBundle)) throw new Error("workspace_report_bundle_path_rejected");
    const existingBundle = await lstat(bundleRoot).catch(() => null);
    if (existingBundle?.isSymbolicLink() || existingBundle && !existingBundle.isDirectory()) throw new Error("workspace_report_bundle_path_rejected");

    await rm(bundleRoot, { recursive: true, force: true });
    await mkdir(bundleRoot, { recursive: true, mode: 0o700 });
    await mkdir(path.join(bundleRoot, "assets"), { recursive: true, mode: 0o700 });
    await writeFile(path.join(bundleRoot, "index.html"), content, { encoding: "utf8", mode: 0o600 });

    let totalAssetBytes = 0;
    let assetCount = 0;
    for (const asset of (Array.isArray(assets) ? assets : []).slice(0, MAX_REPORT_BUNDLE_ASSETS)) {
      const relativeAssetPath = safeBundleAssetPath(asset.relativePath || asset.path || "");
      const bytes = Buffer.isBuffer(asset.bytes) ? asset.bytes : Buffer.from(asset.bytes || []);
      const mimeType = String(asset.mimeType || "").trim().toLowerCase();
      if (!relativeAssetPath || !bytes.length || !IMAGE_EXTENSIONS_BY_MIME.has(mimeType)) throw new Error("workspace_report_bundle_asset_rejected");
      totalAssetBytes += bytes.length;
      if (totalAssetBytes > MAX_REPORT_BUNDLE_ASSET_BYTES) throw new Error("workspace_report_bundle_assets_too_large");
      const targetAsset = path.resolve(bundleRoot, relativeAssetPath);
      const relativeAsset = path.relative(bundleRoot, targetAsset);
      if (relativeAsset === ".." || relativeAsset.startsWith(`..${path.sep}`) || path.isAbsolute(relativeAsset)) throw new Error("workspace_report_bundle_asset_rejected");
      await mkdir(path.dirname(targetAsset), { recursive: true, mode: 0o700 });
      await writeFile(targetAsset, bytes, { mode: 0o600 });
      assetCount += 1;
    }

    await rm(targetZip, { force: true });
    await execFileAsync("zip", ["-qr", targetZip, "index.html", "assets"], { cwd: bundleRoot });
    const metadata = await stat(targetZip);
    return {
      assetCount,
      entrypoint: "index.html",
      fileName: path.basename(targetZip),
      filePath: targetZip,
      relativePath: normalized,
      format: "zip",
      sizeBytes: metadata.size,
    };
  }

  async function resolveReadableWorkspacePath(relativePath) {
    try {
      return await operations.resolveReadablePath(relativePath);
    } catch (error) {
      if (error?.code === "workspace_operation_path_rejected") throw new Error("workspace_path_rejected");
      throw error;
    }
  }

  return {
    compress: operations.compress,
    copy: operations.copy,
    delete: operations.delete,
    extract: operations.extract,
    imageEvidence,
    list,
    mkdir: operations.mkdir,
    modelInput,
    operationContract: operations.operationContract,
    readText,
    replace: operations.replace,
    write: operations.write,
    writeReportBundle,
    writeText,
  };
}

function hasUnsafeHtmlContent(value = "") {
  const html = String(value || "");
  return /<(?:script|iframe|object|embed|form|base|link)\b/i.test(html) ||
    /\son[a-z]+\s*=/i.test(html) ||
    /\b(?:href|src)\s*=\s*["']?\s*(?:javascript:|https?:|\/\/|file:)/i.test(html) ||
    /url\(\s*["']?\s*(?:javascript:|https?:|\/\/|file:)/i.test(html);
}

async function visit(directory, prefix, depth, output) {
  const entries = await readdir(directory, { withFileTypes: true });
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    if (entry.isSymbolicLink()) continue;
    const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      output.push({ path: relativePath, type: "directory" });
      if (depth > 0) await visit(entryPath, relativePath, depth - 1, output);
    } else if (entry.isFile()) {
      output.push({ path: relativePath, type: "file", sizeBytes: (await stat(entryPath)).size });
    }
    if (output.length >= 500) return;
  }
}

function safeRelativePath(value = "") {
  return String(value || "").replace(/\\/g, "/").replace(/^\/+/, "").slice(0, 500);
}

function safeBundleAssetPath(value = "") {
  const normalized = safeRelativePath(value);
  if (!normalized || path.isAbsolute(value) || normalized.split("/").includes("..")) return "";
  return normalized.startsWith("assets/") ? normalized : "";
}

export { createWorkspaceFileTools };
