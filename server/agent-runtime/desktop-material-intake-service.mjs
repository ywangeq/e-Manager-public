import crypto from "node:crypto";
import { lstat, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { safeCanonicalFileName } from "./canonical-input-types.mjs";
import { createTaskWorkspaceManager } from "./task-workspace-manager.mjs";
import { resolveDigitalWorkforceDataDir } from "../local-data-root.mjs";

const DESKTOP_MATERIAL_WORKSPACE_TTL_MS = 60 * 60 * 1000;
const MAX_INTAKE_ITEMS = 8;
const MAX_INTAKE_ITEM_BYTES = 4 * 1024 * 1024;
const MAX_INTAKE_TOTAL_BYTES = 8 * 1024 * 1024;

function createDesktopMaterialIntakeService({
  now = () => Date.now(),
  ttlMs = DESKTOP_MATERIAL_WORKSPACE_TTL_MS,
  workspaceManager = createTaskWorkspaceManager({
    baseRoot: process.env.DIGITAL_WORKFORCE_DESKTOP_WORKSPACE_ROOT || path.join(resolveDigitalWorkforceDataDir(), "desktop-agent-workspaces"),
    ttlMs,
  }),
} = {}) {
  const records = new Map();
  const cleanupTimer = setInterval(() => { void cleanupExpired(); }, Math.min(15 * 60 * 1000, Math.max(60_000, Math.floor(ttlMs / 4))));
  cleanupTimer.unref?.();

  async function createIntake({ employeeId = "", manifestDigest = "", items = [], sessionKey = "" } = {}) {
    await cleanupExpired();
    const safeEmployeeId = cleanId(employeeId);
    const safeSessionKey = String(sessionKey || "");
    if (!safeEmployeeId || !safeSessionKey || !validDigest(manifestDigest)) throw intakeError("desktop_material_intake_scope_invalid");
    const normalizedItems = normalizeItems(items);
    if (!normalizedItems.length) throw intakeError("desktop_material_intake_empty");
    const totalBytes = normalizedItems.reduce((sum, item) => sum + item.bytes.length, 0);
    if (totalBytes > MAX_INTAKE_TOTAL_BYTES) throw intakeError("desktop_material_intake_too_large");

    const intakeId = crypto.randomUUID();
    const workspace = await workspaceManager.workspaceForStaging(intakeId, { create: true });
    const inputRoot = await workspaceManager.createStagingInputDirectory(intakeId, "staged-input");
    await mkdir(inputRoot, { recursive: true, mode: 0o700 });
    const storedItems = [];
    try {
      for (const [index, item] of normalizedItems.entries()) {
        const fileName = item.fileName;
        const filePath = path.join(inputRoot, fileName);
        await writeFile(filePath, item.bytes, { mode: 0o600, flag: "wx" });
        storedItems.push({
          contentDigest: item.contentDigest,
          inputId: `desktop-input-${index + 1}`,
          fileName,
          filePath,
          mimeType: item.mimeType,
          sizeBytes: item.bytes.length,
          sourceRef: `${item.contentDigest}:${index + 1}`,
          ...(item.materialContract ? { materialContract: item.materialContract } : {}),
        });
      }
    } catch (error) {
      await rm(workspace.root, { recursive: true, force: true });
      throw error;
    }

    const createdAt = now();
    const expiresAt = createdAt + ttlMs;
    records.set(intakeId, {
      employeeId: safeEmployeeId,
      expiresAt,
      inputRoot,
      items: storedItems,
      manifestDigest,
      stagingId: intakeId,
      sessionKey: safeSessionKey,
      workspaceRoot: workspace.root,
      claimed: false,
    });
    return {
      contractVersion: "desktop-material-intake.v1",
      intakeId,
      status: "ready",
      fileCount: storedItems.length,
      totalBytes,
      createdAt: new Date(createdAt).toISOString(),
      expiresAt: new Date(expiresAt).toISOString(),
      retention: "ephemeral_workspace_1h",
    };
  }

  async function claimIntake({ employeeId = "", intakeId = "", manifestDigest = "", sessionKey = "", taskId = "" } = {}) {
    await cleanupExpired();
    const record = records.get(cleanId(intakeId));
    const safeTaskId = cleanId(taskId);
    if (!safeTaskId || !record || record.expiresAt <= now() || record.claimed || !intakeMatches(record, { employeeId, manifestDigest, sessionKey })) return null;
    record.claimed = true;
    let workspace;
    try {
      workspace = await workspaceManager.adoptStagingWorkspaceForTask(record.stagingId, safeTaskId);
    } catch (error) {
      record.claimed = false;
      throw error;
    }
    if (!workspace) {
      record.claimed = false;
      return null;
    }
    const items = record.items.map((item) => ({
      ...item,
      filePath: path.join(workspace.root, path.relative(record.workspaceRoot, item.filePath)),
    }));
    record.items = items;
    record.taskId = safeTaskId;
    record.workspaceRoot = workspace.root;
    return {
      contractVersion: "desktop-material-intake-claim.v1",
      expiresAt: new Date(record.expiresAt).toISOString(),
      items: items.map((item) => ({ ...item })),
      workspace,
      workspaceManager,
      workspaceTaskId: safeTaskId,
    };
  }

  async function verifyIntake({ employeeId = "", intakeId = "", manifestDigest = "", sessionKey = "" } = {}) {
    await cleanupExpired();
    const record = records.get(cleanId(intakeId));
    return Boolean(record && record.expiresAt > now() && !record.claimed && intakeMatches(record, { employeeId, manifestDigest, sessionKey }));
  }

  async function materialBindingDescriptorForIntake({ employeeId = "", intakeId = "", manifestDigest = "", sessionKey = "" } = {}) {
    await cleanupExpired();
    const safeIntakeId = cleanId(intakeId);
    const record = records.get(safeIntakeId);
    if (!record || record.expiresAt <= now() || record.claimed || !intakeMatches(record, { employeeId, manifestDigest, sessionKey })) return null;
    return {
      contractVersion: "task-material-binding-descriptor.v1",
      adapterId: "desktop-material-intake.v1",
      sourceKind: "channel_resource",
      sourceIdentityDigest: desktopIntakeSourceDigest({ intakeId: safeIntakeId, manifestDigest }),
      expiresAt: new Date(record.expiresAt).toISOString(),
      payload: {
        contractVersion: "desktop-material-binding-payload.v1",
        intakeId: safeIntakeId,
        manifestDigest,
        items: record.items.map((item) => ({
          contentDigest: item.contentDigest,
          fileName: item.fileName,
          inputId: item.inputId,
          mimeType: item.mimeType,
          relativePath: portableRelativePath(record.workspaceRoot, item.filePath),
          sizeBytes: item.sizeBytes,
          sourceRef: item.sourceRef,
          ...(item.materialContract ? { materialContract: item.materialContract } : {}),
        })),
      },
    };
  }

  async function recoverBoundIntake({ binding, taskId = "" } = {}) {
    const safeTaskId = cleanId(taskId);
    const descriptor = normalizeDesktopMaterialBinding(binding);
    if (!safeTaskId || descriptor.taskId !== safeTaskId || descriptor.expiresAt <= new Date(now()).toISOString()) return null;
    const workspace = await workspaceManager.adoptStagingWorkspaceForTask(descriptor.intakeId, safeTaskId);
    if (!workspace) return null;
    const realWorkspaceRoot = await realpath(workspace.root).catch(() => "");
    if (!realWorkspaceRoot) throw intakeError("desktop_material_binding_path_invalid");
    const items = [];
    for (const item of descriptor.items) {
      const filePath = resolveBoundFilePath(workspace.root, item.relativePath);
      const metadata = await lstat(filePath).catch(() => null);
      const realFilePath = metadata?.isFile() && !metadata.isSymbolicLink() ? await realpath(filePath).catch(() => "") : "";
      if (!realFilePath.startsWith(`${realWorkspaceRoot}${path.sep}`) || metadata.size !== item.sizeBytes) {
        throw intakeError("desktop_material_binding_file_mismatch");
      }
      const bytes = await readFile(filePath);
      if (digest(bytes) !== item.contentDigest) throw intakeError("desktop_material_binding_digest_mismatch");
      items.push({
        contentDigest: item.contentDigest,
        inputId: item.inputId,
        fileName: item.fileName,
        filePath,
        mimeType: item.mimeType,
        sizeBytes: item.sizeBytes,
        sourceRef: item.sourceRef,
        ...(item.materialContract ? { materialContract: item.materialContract } : {}),
      });
    }
    return {
      contractVersion: "desktop-material-intake-claim.v1",
      expiresAt: descriptor.expiresAt,
      items,
      workspace,
      workspaceManager,
      workspaceTaskId: safeTaskId,
    };
  }

  async function cleanupExpired() {
    const currentTime = now();
    const expired = [...records.entries()].filter(([, record]) => record.expiresAt <= currentTime);
    await Promise.all(expired.map(async ([intakeId, record]) => {
      try {
        await rm(record.workspaceRoot, { recursive: true, force: true });
        records.delete(intakeId);
      } catch {
        // Keep the expired record so the next cleanup cycle retries transient Windows file-lock failures.
      }
    }));
    await workspaceManager.cleanupExpired();
  }

  function close() {
    clearInterval(cleanupTimer);
  }

  return {
    claimIntake,
    cleanupExpired,
    close,
    createIntake,
    materialBindingDescriptorForIntake,
    recoverBoundIntake,
    verifyIntake,
    workspaceManager,
  };
}

function normalizeDesktopMaterialBinding(value) {
  if (value?.contractVersion !== "task-material-binding.v1" || value.sourceKind !== "channel_resource" || value.adapterId !== "desktop-material-intake.v1") {
    throw intakeError("desktop_material_binding_invalid");
  }
  const payload = value.payload;
  if (!plainObjectWithFields(payload, ["contractVersion", "intakeId", "items", "manifestDigest"]) ||
    payload.contractVersion !== "desktop-material-binding-payload.v1" || !cleanId(payload.intakeId) ||
    !validDigest(payload.manifestDigest) || !Array.isArray(payload.items) || !payload.items.length || payload.items.length > MAX_INTAKE_ITEMS) {
    throw intakeError("desktop_material_binding_invalid");
  }
  if (value.sourceIdentityDigest !== desktopIntakeSourceDigest({ intakeId: payload.intakeId, manifestDigest: payload.manifestDigest })) {
    throw intakeError("desktop_material_binding_source_mismatch");
  }
  return {
    taskId: cleanId(value.taskId),
    expiresAt: new Date(value.expiresAt).toISOString(),
    intakeId: cleanId(payload.intakeId),
    items: payload.items.map(normalizeBoundItem),
  };
}

function normalizeBoundItem(item) {
  const allowedFields = ["contentDigest", "fileName", "inputId", "materialContract", "mimeType", "relativePath", "sizeBytes", "sourceRef"];
  if (!plainObjectWithFields(item, allowedFields) || !validDigest(item.contentDigest)) throw intakeError("desktop_material_binding_item_invalid");
  const fileName = safeCanonicalFileName(item.fileName, item.mimeType);
  const inputId = cleanId(item.inputId);
  const mimeType = cleanMimeType(item.mimeType);
  const relativePath = String(item.relativePath || "");
  const segments = relativePath.split("/");
  const sizeBytes = Number(item.sizeBytes);
  const materialContract = normalizeMaterialContractProvenance(item.materialContract);
  if (!fileName || fileName !== item.fileName || !inputId || !Number.isSafeInteger(sizeBytes) || sizeBytes < 1 || sizeBytes > MAX_INTAKE_ITEM_BYTES ||
    !/^[A-Za-z0-9._:-]{1,180}$/.test(String(item.sourceRef || "")) || segments.length < 3 || segments.some((segment) => !segment || segment === "." || segment === ".." || segment.includes("\\")) ||
    segments[0] !== "input" || segments.at(-1) !== fileName || (item.materialContract && !materialContract)) {
    throw intakeError("desktop_material_binding_item_invalid");
  }
  return {
    contentDigest: item.contentDigest,
    fileName,
    inputId,
    mimeType,
    relativePath,
    sizeBytes,
    sourceRef: item.sourceRef,
    ...(materialContract ? { materialContract } : {}),
  };
}

function desktopIntakeSourceDigest({ intakeId = "", manifestDigest = "" } = {}) {
  return crypto.createHash("sha256").update(JSON.stringify([
    "desktop-material-intake.v1",
    cleanId(intakeId),
    String(manifestDigest || ""),
  ])).digest("hex");
}

function portableRelativePath(root, filePath) {
  const relativePath = path.relative(root, filePath);
  if (!relativePath || relativePath.startsWith("..") || path.isAbsolute(relativePath)) throw intakeError("desktop_material_binding_path_invalid");
  return relativePath.split(path.sep).join("/");
}

function resolveBoundFilePath(workspaceRoot, relativePath) {
  const resolved = path.resolve(workspaceRoot, ...relativePath.split("/"));
  if (!resolved.startsWith(`${path.resolve(workspaceRoot)}${path.sep}`)) throw intakeError("desktop_material_binding_path_invalid");
  return resolved;
}

function plainObjectWithFields(value, allowedFields) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value) &&
    Object.keys(value).every((field) => allowedFields.includes(field)));
}

function normalizeItems(items = []) {
  if (!Array.isArray(items) || items.length > MAX_INTAKE_ITEMS) throw intakeError("desktop_material_intake_item_limit");
  const normalized = items.map((item) => {
    if (item?.contractVersion !== "desktop-material-bridge-item.v1") throw intakeError("desktop_material_intake_item_invalid");
    const bytes = decodeBase64(item.base64);
    const contentDigest = String(item.contentDigest || "");
    if (!bytes.length || bytes.length > MAX_INTAKE_ITEM_BYTES || Number(item.sizeBytes) !== bytes.length) {
      throw intakeError("desktop_material_intake_item_size_invalid");
    }
    if (!validDigest(contentDigest) || digest(bytes) !== contentDigest) throw intakeError("desktop_material_intake_digest_mismatch");
    const mimeType = cleanMimeType(item.mimeType);
    const fileName = safeCanonicalFileName(item.name, mimeType);
    if (!fileName) throw intakeError("desktop_material_intake_file_name_invalid");
    const materialContract = normalizeMaterialContractProvenance(item.materialContract);
    if (item.materialContract && !materialContract) throw intakeError("desktop_material_intake_contract_invalid");
    return { bytes, contentDigest, fileName, mimeType, materialContract };
  });
  const usedNames = new Set();
  return normalized.map((item) => ({ ...item, fileName: uniqueFileName(item.fileName, usedNames) }));
}

function normalizeMaterialContractProvenance(value = null) {
  if (!value) return null;
  const cleanId = (input) => {
    const id = String(input || "").trim();
    return /^[a-z0-9][a-z0-9_.:-]{0,159}$/i.test(id) ? id : "";
  };
  const skillId = cleanId(value.skillId);
  const contractId = cleanId(value.contractId);
  const selectorId = cleanId(value.selectorId);
  const contractDigest = String(value.contractDigest || "");
  if (value.contractVersion !== "desktop-material-contract-provenance.v1" || !skillId || !contractId || !selectorId || !/^sha256:[a-f0-9]{64}$/.test(contractDigest)) return null;
  return { contractVersion: value.contractVersion, skillId, contractId, selectorId, contractDigest };
}

function decodeBase64(value = "") {
  const text = String(value || "");
  if (!text || text.length > Math.ceil(MAX_INTAKE_ITEM_BYTES * 4 / 3) + 8 || !/^[A-Za-z0-9+/]+={0,2}$/.test(text)) {
    throw intakeError("desktop_material_intake_base64_invalid");
  }
  return Buffer.from(text, "base64");
}

function uniqueFileName(fileName = "", usedNames = new Set()) {
  const key = fileName.toLowerCase();
  if (!usedNames.has(key)) {
    usedNames.add(key);
    return fileName;
  }
  const parsed = path.parse(fileName);
  let index = 2;
  let candidate = "";
  do {
    candidate = `${parsed.name.slice(0, 130)}-${index}${parsed.ext}`;
    index += 1;
  } while (usedNames.has(candidate.toLowerCase()));
  usedNames.add(candidate.toLowerCase());
  return candidate;
}

function intakeMatches(record, { employeeId = "", manifestDigest = "", sessionKey = "" } = {}) {
  return record.employeeId === cleanId(employeeId) &&
    record.sessionKey === String(sessionKey || "") &&
    record.manifestDigest === manifestDigest;
}

function digest(bytes) {
  return `sha256:${crypto.createHash("sha256").update(bytes).digest("hex")}`;
}

function validDigest(value = "") {
  return /^sha256:[a-f0-9]{64}$/.test(String(value));
}

function cleanMimeType(value = "") {
  return String(value || "application/octet-stream").split(";", 1)[0].trim().toLowerCase().slice(0, 120);
}

function cleanId(value = "") {
  return String(value || "").trim().replace(/[^a-zA-Z0-9._:-]/g, "").slice(0, 160);
}

function intakeError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

export {
  DESKTOP_MATERIAL_WORKSPACE_TTL_MS,
  MAX_INTAKE_ITEM_BYTES,
  MAX_INTAKE_TOTAL_BYTES,
  createDesktopMaterialIntakeService,
};
