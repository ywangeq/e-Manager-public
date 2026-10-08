import crypto from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { copyFile, link, lstat, mkdir, open, readFile, readdir, rename, rm, stat, utimes } from "node:fs/promises";
import path from "node:path";
import { createZipArchive, extractZipEntry, inspectZipArchive } from "./workspace-zip-codec.mjs";

const DEFAULT_MAX_WORKSPACE_BYTES = 256 * 1024 * 1024;
const DEFAULT_ARCHIVE_LIMITS = Object.freeze({
  maxArchiveBytes: 128 * 1024 * 1024,
  maxEntries: 5_000,
  maxFileBytes: 64 * 1024 * 1024,
  maxTotalBytes: 128 * 1024 * 1024,
  maxCompressionRatio: 200,
});
const WORKSPACE_OPERATION_CONTRACT = createOperationContract(DEFAULT_ARCHIVE_LIMITS);
const WORKSPACE_MUTATION_TOOL_CONTRACTS = Object.freeze({
  copy_workspace_file: createMutationToolContract("copy", "复制工作区文件"),
  write_workspace_file: createMutationToolContract("write", "写入工作区文件"),
  replace_workspace_file: createMutationToolContract("replace", "更新工作区文件"),
  create_workspace_directory: createMutationToolContract("mkdir", "创建工作区目录"),
  delete_workspace_path: createMutationToolContract("delete", "删除工作区内容", {
    confirmationPolicy: "explicit_per_call",
    risk: "high",
  }),
  extract_workspace_archive: createMutationToolContract("extract", "解压工作区归档"),
  compress_workspace_output: createMutationToolContract("compress", "压缩任务输出"),
});
const mutationTails = new Map();

function createWorkspaceOperations({
  archiveLimits = DEFAULT_ARCHIVE_LIMITS,
  workspace = null,
  maxWorkspaceBytes = DEFAULT_MAX_WORKSPACE_BYTES,
} = {}) {
  const capacityBytes = normalizeCapacity(maxWorkspaceBytes);
  const effectiveArchiveLimits = normalizeArchiveLimits(archiveLimits);
  const operationContract = createOperationContract(effectiveArchiveLimits);

  async function copy({ sourcePath = "", targetPath = "" } = {}) {
    return withMutationLock(workspace?.root, async () => {
      const source = await resolvePath(sourcePath, { writable: false, mustExist: true });
      const sourceMetadata = await lstat(source.absolutePath);
      if (!sourceMetadata.isFile()) throw operationError("workspace_operation_source_rejected");
      const target = await resolvePath(targetPath, { writable: true, mustExist: false });
      await assertMissingTarget(target.absolutePath);
      await assertCapacity(sourceMetadata.size);
      await stageAndPublish({
        target,
        publishMode: "create",
        stage: async (temporaryPath) => {
          await copyFile(source.absolutePath, temporaryPath, fsConstants.COPYFILE_EXCL);
          const handle = await open(temporaryPath, "r+");
          try {
            await handle.chmod(0o600);
            await handle.sync();
          } finally {
            await handle.close();
          }
        },
      });
      return operationResult("copy", target.normalizedPath, {
        sourcePath: source.normalizedPath,
        sizeBytes: sourceMetadata.size,
      });
    });
  }

  async function write({ relativePath = "", content = "" } = {}) {
    return withMutationLock(workspace?.root, () => writeLocked({
      relativePath,
      content,
      mode: "create",
    }));
  }

  async function replace({ relativePath = "", content = "" } = {}) {
    return withMutationLock(workspace?.root, () => writeLocked({
      relativePath,
      content,
      mode: "replace",
    }));
  }

  async function writeOrReplace({ relativePath = "", content = "" } = {}) {
    return withMutationLock(workspace?.root, async () => {
      const target = await resolvePath(relativePath, { writable: true, mustExist: false });
      const existing = await lstat(target.absolutePath).catch(missingAsNull);
      return writeLocked({
        relativePath,
        content,
        mode: existing ? "replace" : "create",
        resolvedTarget: target,
        existing,
      });
    });
  }

  async function mkdirOperation({ relativePath = "" } = {}) {
    return withMutationLock(workspace?.root, async () => {
      const target = await resolvePath(relativePath, { writable: true, mustExist: false });
      await ensureSafeParent(target);
      const existing = await lstat(target.absolutePath).catch(missingAsNull);
      if (existing?.isSymbolicLink()) throw operationError("workspace_operation_symlink_rejected");
      if (existing && !existing.isDirectory()) throw operationError("workspace_operation_target_exists");
      if (!existing) await mkdir(target.absolutePath, { mode: 0o700 });
      await touchWorkspace(workspace?.root);
      return operationResult("mkdir", target.normalizedPath);
    });
  }

  async function deleteOperation({ relativePath = "" } = {}) {
    return withMutationLock(workspace?.root, async () => {
      const target = await resolvePath(relativePath, { writable: true, mustExist: true });
      await ensureSafeParent(target);
      const temporaryPath = path.join(
        path.dirname(target.absolutePath),
        `.${path.basename(target.absolutePath)}.${crypto.randomUUID()}.delete`,
      );
      await rename(target.absolutePath, temporaryPath);
      await rm(temporaryPath, { recursive: true, force: true }).catch(() => {});
      await touchWorkspace(workspace?.root);
      return operationResult("delete", target.normalizedPath);
    });
  }

  async function extract({ sourcePath = "", targetPath = "" } = {}) {
    return withMutationLock(workspace?.root, async () => {
      const source = await resolvePath(sourcePath, { writable: false, mustExist: true });
      const sourceMetadata = await lstat(source.absolutePath);
      if (!sourceMetadata.isFile() || path.extname(source.normalizedPath).toLowerCase() !== ".zip") {
        throw operationError("workspace_archive_source_rejected");
      }
      if (sourceMetadata.size > effectiveArchiveLimits.maxArchiveBytes) {
        throw operationError("workspace_archive_source_size_exceeded");
      }
      const target = await resolvePath(targetPath, { writable: true, mustExist: false });
      await assertMissingTarget(target.absolutePath);
      const archiveBytes = await readFile(source.absolutePath);
      const sourceSha256 = sha256(archiveBytes);
      const inspected = inspectZipArchive(archiveBytes, effectiveArchiveLimits);
      await assertCapacity(inspected.totalBytes);
      await stageAndPublishDirectory({
        target,
        stage: async (temporaryRoot) => {
          for (const entry of inspected.entries) {
            const entryPath = path.join(temporaryRoot, ...entry.relativePath.split("/"));
            if (entry.isDirectory) {
              await mkdir(entryPath, { recursive: true, mode: 0o700 });
              continue;
            }
            await mkdir(path.dirname(entryPath), { recursive: true, mode: 0o700 });
            const content = extractZipEntry(archiveBytes, entry);
            const handle = await open(entryPath, "wx", 0o600);
            try {
              await handle.writeFile(content);
              await handle.sync();
            } finally {
              await handle.close();
            }
          }
          if (await workspaceSize(workspace?.root) > capacityBytes) {
            throw operationError("workspace_operation_capacity_exceeded");
          }
          if (sha256(await readFile(source.absolutePath)) !== sourceSha256) {
            throw operationError("workspace_archive_source_changed");
          }
        },
      });
      return operationResult("extract", target.normalizedPath, {
        archiveBytes: inspected.archiveBytes,
        directoryCount: inspected.directoryCount,
        extractedBytes: inspected.totalBytes,
        fileCount: inspected.fileCount,
        format: "zip",
        sourcePath: source.normalizedPath,
        sourceSha256,
      });
    });
  }

  async function compress({ sourcePath = "", targetPath = "" } = {}) {
    return withMutationLock(workspace?.root, async () => {
      const source = await resolvePath(sourcePath, { writable: false, mustExist: true });
      if (source.normalizedPath !== "output" && !source.normalizedPath.startsWith("output/")) {
        throw operationError("workspace_archive_compress_source_rejected");
      }
      const sourceMetadata = await lstat(source.absolutePath);
      if (!sourceMetadata.isDirectory()) throw operationError("workspace_archive_compress_source_rejected");
      const target = await resolvePath(targetPath, { writable: true, mustExist: false });
      if (!target.normalizedPath.startsWith("output/") || path.extname(target.normalizedPath).toLowerCase() !== ".zip") {
        throw operationError("workspace_archive_compress_target_rejected");
      }
      await assertMissingTarget(target.absolutePath);
      const collected = await collectArchiveSource(source.absolutePath, effectiveArchiveLimits);
      const archiveBytes = createZipArchive(collected.entries, effectiveArchiveLimits);
      if (archiveBytes.length > effectiveArchiveLimits.maxArchiveBytes) {
        throw operationError("workspace_archive_size_exceeded");
      }
      await assertCapacity(archiveBytes.length);
      await stageAndPublish({
        target,
        publishMode: "create",
        stage: async (temporaryPath) => {
          const handle = await open(temporaryPath, "wx", 0o600);
          try {
            await handle.writeFile(archiveBytes);
            await handle.sync();
          } finally {
            await handle.close();
          }
        },
      });
      return operationResult("compress", target.normalizedPath, {
        archiveBytes: archiveBytes.length,
        directoryCount: collected.directoryCount,
        fileCount: collected.fileCount,
        format: "zip",
        sha256: sha256(archiveBytes),
        sourcePath: source.normalizedPath,
        uncompressedBytes: collected.totalBytes,
      });
    });
  }

  async function resolveReadablePath(relativePath = ".") {
    return (await resolvePath(relativePath, { writable: false, mustExist: true })).absolutePath;
  }

  async function resolveWritablePath(relativePath = "") {
    return (await resolvePath(relativePath, { writable: true, mustExist: false })).absolutePath;
  }

  async function writeLocked({ relativePath, content, mode, resolvedTarget = null, existing = undefined }) {
    const bytes = contentBytes(content);
    const target = resolvedTarget || await resolvePath(relativePath, { writable: true, mustExist: mode === "replace" });
    const current = existing === undefined
      ? await lstat(target.absolutePath).catch(missingAsNull)
      : existing;
    if (current?.isSymbolicLink()) throw operationError("workspace_operation_symlink_rejected");
    if (current && !current.isFile()) throw operationError("workspace_operation_target_rejected");
    if (mode === "create" && current) throw operationError("workspace_operation_target_exists");
    if (mode === "replace" && !current) throw operationError("workspace_operation_target_missing");
    await assertCapacity(bytes.length - (current?.size || 0));
    await stageAndPublish({
      target,
      publishMode: mode,
      stage: async (temporaryPath) => {
        const handle = await open(temporaryPath, "wx", 0o600);
        try {
          await handle.writeFile(bytes);
          await handle.sync();
          if (current) await handle.chmod(current.mode & 0o777);
        } finally {
          await handle.close();
        }
      },
    });
    return operationResult(mode === "create" ? "write" : "replace", target.normalizedPath, {
      sizeBytes: bytes.length,
    });
  }

  async function stageAndPublish({ target, publishMode, stage }) {
    await ensureSafeParent(target);
    const stagingDirectory = path.join(
      path.dirname(target.absolutePath),
      `.${path.basename(target.absolutePath)}.${crypto.randomUUID()}.tmpdir`,
    );
    const temporaryPath = path.join(stagingDirectory, "payload.tmp");
    let committed = false;
    try {
      await mkdir(stagingDirectory, { mode: 0o700 });
      await stage(temporaryPath);
      const currentTarget = publishMode === "replace"
        ? await lstat(target.absolutePath).catch(missingAsNull)
        : null;
      const stagedWorkspaceBytes = await workspaceSize(workspace?.root);
      if (stagedWorkspaceBytes - (currentTarget?.size || 0) > capacityBytes) {
        throw operationError("workspace_operation_capacity_exceeded");
      }
      await ensureSafeParent(target);
      if (publishMode === "create") {
        try {
          await link(temporaryPath, target.absolutePath);
        } catch (error) {
          if (error?.code === "EEXIST") throw operationError("workspace_operation_target_exists");
          throw error;
        }
      } else {
        const current = await lstat(target.absolutePath).catch(missingAsNull);
        if (!current) throw operationError("workspace_operation_target_missing");
        if (current.isSymbolicLink()) throw operationError("workspace_operation_symlink_rejected");
        if (!current.isFile()) throw operationError("workspace_operation_target_rejected");
        await rename(temporaryPath, target.absolutePath);
      }
      committed = true;
    } finally {
      await rm(stagingDirectory, { recursive: true, force: true }).catch(() => {});
      if (committed) await touchWorkspace(workspace?.root);
    }
  }

  async function stageAndPublishDirectory({ target, stage }) {
    await ensureSafeParent(target);
    const stagingDirectory = path.join(
      path.dirname(target.absolutePath),
      `.${path.basename(target.absolutePath)}.${crypto.randomUUID()}.tmpdir`,
    );
    const temporaryRoot = path.join(stagingDirectory, "payload");
    let committed = false;
    try {
      await mkdir(temporaryRoot, { recursive: true, mode: 0o700 });
      await stage(temporaryRoot);
      await ensureSafeParent(target);
      await assertMissingTarget(target.absolutePath);
      await rename(temporaryRoot, target.absolutePath);
      committed = true;
    } finally {
      await rm(stagingDirectory, { recursive: true, force: true }).catch(() => {});
      if (committed) await touchWorkspace(workspace?.root);
    }
  }

  async function assertCapacity(deltaBytes) {
    const usedBytes = await workspaceSize(workspace?.root);
    if (usedBytes + Math.max(0, Number(deltaBytes) || 0) > capacityBytes) {
      throw operationError("workspace_operation_capacity_exceeded");
    }
  }

  async function resolvePath(relativePath, { writable, mustExist }) {
    const normalizedPath = normalizeRelativePath(relativePath);
    const segments = normalizedPath === "." ? [] : normalizedPath.split("/");
    const rootName = segments[0] || "";
    if (!WORKSPACE_OPERATION_CONTRACT.readableRoots.includes(rootName) && normalizedPath !== ".") {
      throw operationError("workspace_operation_path_rejected");
    }
    if (writable) {
      if (rootName === "input") throw operationError("workspace_operation_input_read_only");
      if (!WORKSPACE_OPERATION_CONTRACT.writableRoots.includes(rootName) || segments.length < 2) {
        throw operationError("workspace_operation_path_rejected");
      }
    }

    const workspaceRoot = await workspaceRealRoot(workspace?.root);
    const absolutePath = segments.length ? path.join(workspaceRoot, ...segments) : workspaceRoot;
    let current = workspaceRoot;
    for (let index = 0; index < segments.length; index += 1) {
      current = path.join(current, segments[index]);
      const metadata = await lstat(current).catch(missingAsNull);
      if (!metadata) {
        if (mustExist) throw operationError("workspace_operation_target_missing");
        break;
      }
      if (metadata.isSymbolicLink()) throw operationError("workspace_operation_symlink_rejected");
      if (index < segments.length - 1 && !metadata.isDirectory()) {
        throw operationError("workspace_operation_path_rejected");
      }
    }
    return { absolutePath, normalizedPath };
  }

  return {
    compress,
    copy,
    delete: deleteOperation,
    extract,
    mkdir: mkdirOperation,
    operationContract,
    replace,
    resolveReadablePath,
    resolveWritablePath,
    write,
    writeOrReplace,
  };
}

async function ensureSafeParent(target) {
  const segments = target.normalizedPath.split("/");
  const root = path.resolve(target.absolutePath, ...segments.map(() => ".."));
  let current = root;
  for (const segment of segments.slice(0, -1)) {
    current = path.join(current, segment);
    const metadata = await lstat(current).catch(missingAsNull);
    if (metadata?.isSymbolicLink()) throw operationError("workspace_operation_symlink_rejected");
    if (metadata && !metadata.isDirectory()) throw operationError("workspace_operation_path_rejected");
    if (!metadata) {
      try {
        await mkdir(current, { mode: 0o700 });
      } catch (error) {
        if (error?.code !== "EEXIST") throw error;
      }
      const created = await lstat(current);
      if (created.isSymbolicLink()) throw operationError("workspace_operation_symlink_rejected");
      if (!created.isDirectory()) throw operationError("workspace_operation_path_rejected");
    }
  }
}

async function assertMissingTarget(target) {
  const existing = await lstat(target).catch(missingAsNull);
  if (existing?.isSymbolicLink()) throw operationError("workspace_operation_symlink_rejected");
  if (existing) throw operationError("workspace_operation_target_exists");
}

async function workspaceRealRoot(root) {
  if (!root) throw operationError("workspace_operation_path_rejected");
  const rootMetadata = await lstat(root).catch(missingAsNull);
  if (rootMetadata?.isSymbolicLink()) throw operationError("workspace_operation_symlink_rejected");
  if (!rootMetadata?.isDirectory()) throw operationError("workspace_operation_path_rejected");
  return path.resolve(root);
}

async function workspaceSize(root) {
  const workspaceRoot = await workspaceRealRoot(root);
  let total = 0;
  const pending = [workspaceRoot];
  while (pending.length) {
    const directory = pending.pop();
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      const entryPath = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) pending.push(entryPath);
      else if (entry.isFile()) total += (await stat(entryPath)).size;
    }
  }
  return total;
}

async function collectArchiveSource(root, limits) {
  const entries = [];
  let directoryCount = 0;
  let fileCount = 0;
  let totalBytes = 0;

  async function visit(directory, prefix = "") {
    const children = await readdir(directory, { withFileTypes: true });
    for (const child of children.sort((left, right) => left.name.localeCompare(right.name))) {
      const childPath = path.join(directory, child.name);
      const relativePath = prefix ? `${prefix}/${child.name}` : child.name;
      const metadata = await lstat(childPath);
      if (metadata.isSymbolicLink()) throw operationError("workspace_archive_link_rejected");
      if (metadata.isDirectory()) {
        directoryCount += 1;
        assertArchiveEntryCount(fileCount + directoryCount, limits.maxEntries);
        entries.push({ isDirectory: true, relativePath });
        await visit(childPath, relativePath);
        continue;
      }
      if (!metadata.isFile()) throw operationError("workspace_archive_link_rejected");
      if (metadata.size > limits.maxFileBytes) throw operationError("workspace_archive_file_size_exceeded");
      totalBytes += metadata.size;
      if (totalBytes > limits.maxTotalBytes) throw operationError("workspace_archive_total_size_exceeded");
      fileCount += 1;
      assertArchiveEntryCount(fileCount + directoryCount, limits.maxEntries);
      const handle = await open(childPath, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW || 0));
      let content;
      try {
        const openedMetadata = await handle.stat();
        if (!openedMetadata.isFile() || openedMetadata.size !== metadata.size) {
          throw operationError("workspace_archive_source_changed");
        }
        content = await handle.readFile();
      } finally {
        await handle.close();
      }
      if (content.length !== metadata.size) throw operationError("workspace_archive_source_changed");
      entries.push({ content, isDirectory: false, relativePath });
    }
  }

  await visit(root);
  return { directoryCount, entries, fileCount, totalBytes };
}

function assertArchiveEntryCount(value, maximum) {
  if (value > maximum) throw operationError("workspace_archive_entry_limit_exceeded");
}

function normalizeRelativePath(value) {
  const raw = String(value ?? "").trim();
  if (!raw) throw operationError("workspace_operation_path_rejected");
  if (raw.includes("\\") || path.isAbsolute(raw) || raw.includes("\0")) {
    throw operationError("workspace_operation_path_rejected");
  }
  const segments = raw.split("/");
  if (segments.includes("..")) throw operationError("workspace_operation_path_rejected");
  const normalized = path.posix.normalize(raw).replace(/^\.\//, "");
  if (!normalized || normalized.startsWith("/")) throw operationError("workspace_operation_path_rejected");
  return normalized;
}

function contentBytes(content) {
  if (typeof content === "string") return Buffer.from(content, "utf8");
  if (Buffer.isBuffer(content)) return content;
  if (content instanceof Uint8Array) return Buffer.from(content);
  throw operationError("workspace_operation_content_rejected");
}

function operationResult(operation, relativePath, extra = {}) {
  return {
    contractVersion: WORKSPACE_OPERATION_CONTRACT.contractVersion,
    operation,
    path: relativePath,
    ...extra,
  };
}

function operationError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

function missingAsNull(error) {
  if (error?.code === "ENOENT" || error?.code === "ENOTDIR") return null;
  throw error;
}

function normalizeCapacity(value) {
  const normalized = Number(value);
  if (!Number.isSafeInteger(normalized) || normalized <= 0) {
    throw operationError("workspace_operation_capacity_invalid");
  }
  return normalized;
}

function normalizeArchiveLimits(value = {}) {
  const limits = {
    maxArchiveBytes: normalizePositiveInteger(value.maxArchiveBytes, "workspace_archive_limits_invalid"),
    maxEntries: normalizePositiveInteger(value.maxEntries, "workspace_archive_limits_invalid"),
    maxFileBytes: normalizePositiveInteger(value.maxFileBytes, "workspace_archive_limits_invalid"),
    maxTotalBytes: normalizePositiveInteger(value.maxTotalBytes, "workspace_archive_limits_invalid"),
    maxCompressionRatio: Number(value.maxCompressionRatio),
  };
  if (!Number.isFinite(limits.maxCompressionRatio) || limits.maxCompressionRatio < 1) {
    throw operationError("workspace_archive_limits_invalid");
  }
  return Object.freeze(limits);
}

function normalizePositiveInteger(value, code) {
  const normalized = Number(value);
  if (!Number.isSafeInteger(normalized) || normalized <= 0) throw operationError(code);
  return normalized;
}

function createOperationContract(archiveLimits) {
  return Object.freeze({
    contractVersion: "workspace-operation.v1",
    readableRoots: Object.freeze(["input", "work", "output"]),
    writableRoots: Object.freeze(["work", "output"]),
    operations: Object.freeze(["copy", "write", "replace", "mkdir", "delete", "extract", "compress"]),
    pathPolicy: "workspace_relative_no_symlinks",
    capacityPolicy: "whole_workspace_bytes",
    archivePolicy: Object.freeze({
      compressSourceRoot: "output",
      extractTargetRoots: Object.freeze(["work", "output"]),
      format: "zip",
      linkPolicy: "reject_all_links",
      publishPolicy: "atomic_no_partial_target",
      sourceArchiveIntegrity: "sha256_before_after",
      limits: Object.freeze({ ...archiveLimits }),
    }),
  });
}

function createMutationToolContract(action, displayName, {
  confirmationPolicy = "not_required",
  risk = "medium",
} = {}) {
  return Object.freeze({
    contractVersion: "workspace-operation.v1",
    toolId: "workspace-files-v1",
    operationId: `workspace.${action}`,
    action,
    policyAction: "draft",
    capabilities: Object.freeze(["filesystem.read", "filesystem.write"]),
    confirmationPolicy,
    displayName,
    risk,
    scope: Object.freeze(["current_agent_session_workspace"]),
    writebackBoundary: "workspace_only",
  });
}

function workspaceMutationToolContract(toolName = "") {
  return WORKSPACE_MUTATION_TOOL_CONTRACTS[String(toolName || "").trim()] || null;
}

function authorizeWorkspaceMutationApproval({
  confirmation = null,
  confirmationContext = {},
  confirmationService = null,
  toolCall = {},
} = {}) {
  const contract = workspaceMutationToolContract(toolCall.name);
  if (!contract) {
    return {
      status: "rejected",
      reason: "workspace_tool_not_declared",
      nextGate: "该 Tool 未在 workspace 操作合同中声明。",
    };
  }
  const requiresExplicitConfirmation = contract.risk === "high" || contract.confirmationPolicy === "explicit_per_call";
  if (!requiresExplicitConfirmation) {
    return {
      status: "allowed",
      reason: "workspace_operation_contract_allowed",
      nextGate: "本次 workspace 操作可在当前任务边界内执行。",
      toolContract: contract,
    };
  }
  if (typeof confirmationService?.authorizeOrRequest !== "function") {
    return {
      status: "human_review_required",
      reason: "tool_confirmation_service_unavailable",
      nextGate: "该高风险 workspace 操作必须由当前用户通过一次性结构化审批确认。",
      toolContract: contract,
    };
  }
  const decision = confirmationService.authorizeOrRequest({
    confirmation,
    context: confirmationContext,
    toolCall: {
      name: String(toolCall.name || "").trim(),
      arguments: toolCall.arguments && typeof toolCall.arguments === "object" && !Array.isArray(toolCall.arguments)
        ? toolCall.arguments
        : {},
      ...contract,
    },
  });
  return { ...decision, toolContract: contract };
}

function sha256(bytes) {
  return crypto.createHash("sha256").update(bytes).digest("hex");
}

function withMutationLock(root, operation) {
  const key = path.resolve(String(root || ""));
  const previous = mutationTails.get(key) || Promise.resolve();
  const current = previous.catch(() => {}).then(operation);
  mutationTails.set(key, current);
  return current.finally(() => {
    if (mutationTails.get(key) === current) mutationTails.delete(key);
  });
}

async function touchWorkspace(root) {
  if (!root) return;
  const time = new Date();
  await utimes(root, time, time).catch(() => {});
}

export {
  DEFAULT_MAX_WORKSPACE_BYTES,
  WORKSPACE_MUTATION_TOOL_CONTRACTS,
  WORKSPACE_OPERATION_CONTRACT,
  authorizeWorkspaceMutationApproval,
  createWorkspaceOperations,
  workspaceMutationToolContract,
};
