import { spawn } from "node:child_process";
import { copyFile, mkdir, mkdtemp, readdir, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { canonicalInputDescriptor, safeCanonicalFileName } from "./canonical-input-types.mjs";

const ARCHIVE_INTAKE_TOOL_ID = "safe-archive-intake";
const MAX_ARCHIVE_ENTRIES = 5_000;
const MAX_EXTRACTED_BYTES = 128 * 1024 * 1024;

async function runMaterialIntakeTools({ employee = {}, downloadedResources = [], workspaceRoot = "", channelMaterialIntakeAllowed = false } = {}) {
  if (!channelMaterialIntakeAllowed && !isToolEnabled(employee, ARCHIVE_INTAKE_TOOL_ID)) return { toolResults: [], preparedMaterials: [] };

  const toolResults = [];
  const preparedMaterials = [];
  for (const resource of downloadedResources) {
    if (!resource?.download?.ok || !resource.download.temporaryFilePath) continue;
    const fileName = resource.download.fileName || resource.fileName || resource.resource?.name || "";
    const prepared = path.extname(fileName).toLowerCase() === ".zip"
      ? await prepareZipMaterial({
        archivePath: resource.download.temporaryFilePath,
        fileName,
        workspaceRoot,
      })
      : await prepareFileMaterial({
        filePath: resource.download.temporaryFilePath,
        fileName,
        mimeType: resource.download.contentType,
        workspaceRoot,
      });
    toolResults.push(toSafeToolResult(prepared));
    if (prepared.workspace) preparedMaterials.push(prepared);
  }
  return { toolResults, preparedMaterials };
}

async function prepareFileMaterial({ filePath = "", fileName = "", mimeType = "", tempRoot = os.tmpdir(), workspaceRoot = "" } = {}) {
  if (!filePath) return toolFailure("material_file_missing", "附件下载结果不可用。");
  const managedWorkspace = Boolean(workspaceRoot);
  const workspace = managedWorkspace
    ? path.resolve(workspaceRoot)
    : await mkdtemp(path.join(tempRoot, "digital-workforce-material-intake-"));
  if (managedWorkspace) await mkdir(workspace, { recursive: true, mode: 0o700 });
  const safeFileName = safeCanonicalFileName(fileName, mimeType);
  const target = path.join(workspace, safeFileName || "attachment");
  try {
    await copyFile(filePath, target);
    const metadata = await stat(target);
    if (!metadata.isFile() || metadata.size <= 0 || metadata.size > MAX_EXTRACTED_BYTES) {
      return toolFailure("material_file_limit_exceeded", "附件为空或超过受控工作区大小限制。");
    }
    const descriptor = canonicalInputDescriptor({ fileName: safeFileName, mimeType });
    return {
      toolId: ARCHIVE_INTAKE_TOOL_ID,
      status: "temporary_material_ready",
      summary: descriptor
        ? "附件已进入受控临时工作区，并可作为本轮 Agent 的原生模型输入。"
        : "附件已进入受控临时工作区，等待已挂载 Tool 或 Skill 处理。",
      dataset: {
        fileCount: 1,
        imageCount: descriptor?.type === "image" ? 1 : 0,
      },
      nextGate: descriptor
        ? "由当前模型按其输入能力直接理解；不支持时由 Agent 选择已挂载 Tool 或 Skill。"
        : "由 Agent 选择已挂载且支持该格式的 Tool 或 Skill。",
      workspace,
      managedWorkspace,
      files: [target],
      fileName: safeFileName,
      mimeType: descriptor?.mimeType || mimeType,
      canonicalInputType: descriptor?.type || "",
    };
  } catch {
    return toolFailure("material_file_stage_failed", "附件未能写入受控临时工作区。");
  }
}

async function prepareZipMaterial({ archivePath = "", fileName = "", tempRoot = os.tmpdir(), workspaceRoot = "" } = {}) {
  if (!archivePath || path.extname(fileName || archivePath).toLowerCase() !== ".zip") {
    return toolFailure("unsupported_material", "只处理 ZIP 资料包。", "请传入 ZIP，或由其他已启用 Tool 处理该资料类型。");
  }

  const managedWorkspace = Boolean(workspaceRoot);
  const workspace = managedWorkspace
    ? path.resolve(workspaceRoot)
    : await mkdtemp(path.join(tempRoot, "digital-workforce-material-intake-"));
  if (managedWorkspace) await mkdir(workspace, { recursive: true, mode: 0o700 });
  try {
    const entries = await listArchiveEntries(archivePath);
    if (!entries.ok) return toolFailure(entries.status);
    if (entries.items.length > MAX_ARCHIVE_ENTRIES) return toolFailure("archive_entry_limit_exceeded");
    if (entries.items.some((entry) => !isSafeArchiveEntry(entry))) return toolFailure("archive_path_rejected");

    const extracted = await runCommand("unzip", ["-o", "-qq", archivePath, "-d", workspace]);
    if (!extracted.ok) return toolFailure("archive_extract_failed");

    const files = await collectRegularFiles(workspace);
    if (files.status) return toolFailure(files.status);
    if (files.totalBytes > MAX_EXTRACTED_BYTES) return toolFailure("archive_uncompressed_limit_exceeded");

    return {
      toolId: ARCHIVE_INTAKE_TOOL_ID,
      status: "temporary_material_ready",
      summary: "ZIP 资料已在受控临时工作区准备完成，等待已挂载 Skill 处理。",
      dataset: {
        fileCount: files.items.length,
        imageCount: files.items.filter((filePath) => /\.(png|jpe?g|bmp|webp)$/i.test(filePath)).length,
        annotationCount: files.items.filter((filePath) => path.extname(filePath).toLowerCase() === ".json").length,
      },
      nextGate: "由已挂载的业务 Skill 按其输入契约处理；原始 ZIP 和临时目录不会写入任务记录。",
      workspace,
      managedWorkspace,
      files: files.items,
    };
  } catch {
    return toolFailure("archive_intake_failed");
  }
}

async function cleanupPreparedMaterials(materials = []) {
  await Promise.all(materials.map((material) => material.workspace && !material.managedWorkspace
    ? rm(material.workspace, { recursive: true, force: true })
    : Promise.resolve()));
}

async function listArchiveEntries(archivePath) {
  const result = await runCommand("unzip", ["-Z1", archivePath]);
  if (!result.ok) return { ok: false, status: "archive_inspection_failed" };
  return {
    ok: true,
    items: result.stdout.split(/\r?\n/).map((entry) => entry.trim()).filter(Boolean),
  };
}

function isSafeArchiveEntry(entry = "") {
  const normalized = String(entry || "").replace(/\\/g, "/");
  return Boolean(normalized) &&
    !normalized.startsWith("/") &&
    !normalized.includes("\0") &&
    !normalized.split("/").includes("..");
}

async function collectRegularFiles(root) {
  const items = [];
  let totalBytes = 0;

  async function visit(directory) {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      const entryPath = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) return "archive_symlink_rejected";
      if (entry.isDirectory()) {
        const nestedStatus = await visit(entryPath);
        if (nestedStatus) return nestedStatus;
        continue;
      }
      if (!entry.isFile()) continue;
      const size = (await stat(entryPath)).size;
      totalBytes += size;
      if (totalBytes > MAX_EXTRACTED_BYTES) return "archive_uncompressed_limit_exceeded";
      items.push(entryPath);
    }
    return "";
  }

  const status = await visit(root);
  return { status, items, totalBytes };
}

function toSafeToolResult(result = {}) {
  return {
    toolId: result.toolId || ARCHIVE_INTAKE_TOOL_ID,
    status: result.status || "archive_intake_failed",
    summary: result.summary || "文件资料未能进入受控接入流程。",
    dataset: result.dataset || {},
    nextGate: result.nextGate || "检查文件完整性、大小和访问权限。",
  };
}

function toolFailure(status, summary = "文件资料未能进入受控接入流程。", nextGate = "检查文件完整性、大小和访问权限。") {
  return { toolId: ARCHIVE_INTAKE_TOOL_ID, status, summary, nextGate };
}

function isToolEnabled(employee = {}, toolId = "") {
  return Array.isArray(employee.toolBindings) && employee.toolBindings.some((tool) => tool.id === toolId && tool.enabled === true);
}

function runCommand(command, args) {
  return new Promise((resolve) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "ignore"] });
    let stdout = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.on("error", () => resolve({ ok: false, stdout: "" }));
    child.on("close", (code) => resolve({ ok: code === 0, stdout }));
  });
}

export { ARCHIVE_INTAKE_TOOL_ID, cleanupPreparedMaterials, isSafeArchiveEntry, prepareFileMaterial, prepareZipMaterial, runMaterialIntakeTools };
