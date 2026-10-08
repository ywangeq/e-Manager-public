import crypto from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import fs from "node:fs";
import { link, lstat, mkdir, open, readFile, realpath, rm } from "node:fs/promises";
import path from "node:path";

const SHA256 = /^(?:sha256:)?([a-f0-9]{64})$/;

// An adapter for the shared task-material-set recovery service. Group provenance
// is checked by the caller's canonical context resolver; this adapter checks the
// persistent source task/binding and mounts only the bound input bytes.
export function createTaskInputForkMaterialAdapter({ readTask, readBindings, authorizeSource, recoverSource, now = () => new Date() } = {}) {
  if (typeof readTask !== "function" || typeof readBindings !== "function" ||
      typeof authorizeSource !== "function" || typeof recoverSource !== "function") {
    throw new TypeError("task input fork requires canonical task, bindings, authorization and workspace manager");
  }
  return Object.freeze({
    adapterId: "task-input-fork.v1",
    mountOrder: 15,
    async recover({ binding, taskId }) {
      const target = binding;
      if (target?.contractVersion !== "task-material-binding.v1" || target?.taskId !== taskId ||
          target.sourceKind !== "predecessor_task_input" || target.adapterId !== "task-input-fork.v1" ||
          !target.sourceTaskId || target.sourceTaskId === taskId || !SHA256.test(target.sourceBindingDigest || "")) {
        throw fail("task_input_fork_binding_invalid");
      }
      const currentTime = new Date(now()).toISOString();
      if (target.expiresAt <= currentTime) throw fail("task_input_fork_expired");
      const actorFields = ["tenantScope", "actorIssuer", "actorSubjectDigest"];
      const currentTask = await readTask(taskId, { tenantScope: target.tenantScope });
      const sourceTask = await readTask(target.sourceTaskId, { tenantScope: target.tenantScope });
      const targetBindings = await readBindings(taskId, { tenantScope: target.tenantScope, now: new Date(now()) });
      if (!targetBindings?.some(item => isDeepStrictEqual(item, target))) throw fail("task_input_fork_binding_invalid");
      if (!currentTask || !sourceTask || currentTask.taskId !== taskId ||
          sourceTask.taskId !== target.sourceTaskId || sourceTask.status !== "completed" || sourceTask.cancelRequested ||
          currentTask.cancelRequested || !["queued", "running", "waiting"].includes(currentTask.status) ||
          ["employeeId", "employeeVersion", "channelId", "sessionId"].some(key => target[key] !== currentTask[key]) || actorFields.some(key => target[key] !== sourceTask[key] || target[key] !== currentTask[key])) {
        throw fail("task_input_fork_source_unavailable");
      }
      const sourceBindings = await readBindings(sourceTask.taskId, { tenantScope: target.tenantScope, now: new Date(now()) });
      const source = sourceBindings?.find(item => item.bindingDigest === target.sourceBindingDigest);
      if (!source || source.taskId !== sourceTask.taskId || source.sourceKind !== "channel_resource" ||
          source.expiresAt !== target.expiresAt ||
          source.expiresAt <= currentTime ||
          ["employeeId", "employeeVersion", "channelId", "sessionId"].some(key => source[key] !== sourceTask[key]) || actorFields.some(key => source[key] !== target[key]) ||
          crypto.createHash("sha256").update(JSON.stringify(["task-input-fork.v1", source.taskId, source.bindingDigest])).digest("hex") !== target.sourceIdentityDigest) {
        throw fail("task_input_fork_source_unavailable");
      }
      if (await authorizeSource({ sourceTask, sourceBinding: source, targetBinding: target, taskId }) !== true) {
        throw fail("task_input_fork_authorization_denied");
      }
      // The registered source adapter owns its payload, file validation and
      // limits. This common adapter only mounts the authorized claim's items.
      const claim = await recoverSource({ binding: source, taskId: sourceTask.taskId });
      const workspaceManager = claim?.workspaceManager;
      const originalWorkspace = claim?.workspace;
      if (claim?.workspaceTaskId !== sourceTask.taskId || !workspaceManager?.workspaceForTask || !claim.items?.length) {
        throw fail("task_input_fork_source_unavailable");
      }
      const originalItems = claim.items;
      if (!originalWorkspace) throw fail("task_input_fork_source_unavailable");
      const sourceRoot = await realpath(originalWorkspace.root).catch(() => "");
      if (!sourceRoot || await realpath(originalWorkspace.inputRoot).catch(() => "") !== path.join(sourceRoot, "input")) {
        throw fail("task_input_fork_source_unavailable");
      }
      const targetWorkspace = await workspaceManager.workspaceForTask(taskId, { create: true });
      if (path.resolve(originalWorkspace.root) === path.resolve(targetWorkspace.root)) {
        throw fail("task_input_fork_target_invalid");
      }
      const sourceKey = crypto.createHash("sha256").update(`${source.taskId}:${source.bindingDigest}`).digest("hex").slice(0, 24);
      const targetDirectory = path.join(targetWorkspace.inputRoot, `fork-${sourceKey}`);
      const realTargetInput = await realpath(targetWorkspace.inputRoot);
      if (realTargetInput !== path.join(await realpath(targetWorkspace.root), "input")) {
        throw fail("task_input_fork_target_invalid");
      }
      const existingDirectory = await lstat(targetDirectory).catch(() => null);
      if (existingDirectory && (!existingDirectory.isDirectory() || existingDirectory.isSymbolicLink())) {
        throw fail("task_input_fork_target_invalid");
      }
      if (!existingDirectory) await mkdir(targetDirectory, { mode: 0o700 }).catch(error => { if (error.code !== "EEXIST") throw error; });
      if (await realpath(targetDirectory) !== path.join(realTargetInput, `fork-${sourceKey}`)) {
        throw fail("task_input_fork_target_invalid");
      }
      const items = [];
      for (const [index, item] of originalItems.entries()) {
        const sourcePath = path.resolve(item.filePath);
        if (!sourcePath.startsWith(`${path.resolve(originalWorkspace.inputRoot)}${path.sep}`)) throw fail("task_input_fork_source_invalid");
        const sourceMeta = await lstat(sourcePath).catch(() => null);
        const realSourcePath = await realpath(sourcePath).catch(() => "");
        if (!sourceMeta?.isFile() || sourceMeta.isSymbolicLink() || sourceMeta.nlink !== 1 ||
            sourceMeta.size !== item.sizeBytes || !realSourcePath.startsWith(`${sourceRoot}${path.sep}input${path.sep}`)) {
          throw fail("task_input_fork_source_invalid");
        }
        const sourceHandle = await open(sourcePath, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
        const targetName = `${index + 1}-${item.fileName}`;
        const targetPath = path.join(targetDirectory, targetName);
        try {
          const bytes = await sourceHandle.readFile();
          const after = await sourceHandle.stat();
          if (bytes.length !== item.sizeBytes || after.dev !== sourceMeta.dev || after.ino !== sourceMeta.ino ||
              after.size !== sourceMeta.size || after.nlink !== sourceMeta.nlink ||
              crypto.createHash("sha256").update(bytes).digest("hex") !== item.contentDigest.replace(/^sha256:/, "")) {
            throw fail("task_input_fork_source_invalid");
          }
          // Existing mounts survive restart. A private temporary file is
          // verified and published with an exclusive link, never overwritten.
          const temporaryPath = path.join(targetDirectory, `.${targetName}.${crypto.randomUUID()}.tmp`);
          if (!await lstat(targetPath).catch(() => null)) {
            try {
              const handle = await open(temporaryPath,
                fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY | (fs.constants.O_NOFOLLOW || 0), 0o600);
              try {
                await handle.writeFile(bytes);
                await handle.sync();
              } finally { await handle.close(); }
              const temporary = await lstat(temporaryPath);
              if (!temporary.isFile() || temporary.isSymbolicLink() || temporary.nlink !== 1 ||
                  temporary.size !== item.sizeBytes ||
                  crypto.createHash("sha256").update(await readFile(temporaryPath)).digest("hex") !== item.contentDigest.replace(/^sha256:/, "")) {
                throw fail("task_input_fork_target_invalid");
              }
              // EEXIST is permitted only when another recovery mounted the
              // exact same frozen bytes. The target is verified below.
              await link(temporaryPath, targetPath).catch(error => {
                if (error.code !== "EEXIST") throw error;
              });
            } finally { await rm(temporaryPath, { force: true }); }
          }
          const targetMeta = await lstat(targetPath).catch(() => null);
          const targetHandle = targetMeta?.isFile() && !targetMeta.isSymbolicLink() && targetMeta.nlink === 1
            ? await open(targetPath, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0)) : null;
          if (!targetHandle) throw fail("task_input_fork_target_invalid");
          try {
            const targetBytes = await targetHandle.readFile();
            const targetAfter = await targetHandle.stat();
            if (!targetAfter.isFile() || targetAfter.dev !== targetMeta.dev || targetAfter.ino !== targetMeta.ino ||
                targetAfter.nlink !== 1 || targetAfter.size !== item.sizeBytes ||
                crypto.createHash("sha256").update(targetBytes).digest("hex") !== item.contentDigest.replace(/^sha256:/, "")) {
              throw fail("task_input_fork_target_invalid");
            }
          } finally { await targetHandle.close(); }
          items.push({
            contentDigest: item.contentDigest,
            inputId: `fork-${sourceKey}-${index + 1}`,
            fileName: item.fileName,
            filePath: targetPath,
            mimeType: item.mimeType,
            sizeBytes: item.sizeBytes,
            sourceRef: `fork-${sourceKey}-${index + 1}`,
            ...(item.materialContract ? { materialContract: item.materialContract } : {}),
          });
        } finally { await sourceHandle.close(); }
      }
      const latestBindings = await readBindings(taskId, { tenantScope: target.tenantScope, now: new Date(now()) });
      const latestSources = await readBindings(sourceTask.taskId, { tenantScope: target.tenantScope, now: new Date(now()) });
      if (!latestBindings?.some(item => isDeepStrictEqual(item, target)) || !latestSources?.some(item => isDeepStrictEqual(item, source))) {
        throw fail("task_input_fork_authorization_denied");
      }
      if (await authorizeSource({ sourceTask, sourceBinding: source, targetBinding: target, taskId }) !== true ||
          source.expiresAt <= new Date(now()).toISOString()) throw fail("task_input_fork_authorization_denied");
      return Object.freeze({
        contractVersion: "task-input-fork-claim.v1", expiresAt: source.expiresAt,
        items: Object.freeze(items), workspace: targetWorkspace, workspaceManager, workspaceTaskId: taskId,
      });
    },
  });
}

function fail(code) { const error = new Error(code); error.code = code; return error; }
