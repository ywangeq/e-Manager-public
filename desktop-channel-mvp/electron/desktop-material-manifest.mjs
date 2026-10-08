import crypto from "node:crypto";
import { createReadStream } from "node:fs";
import { planDesktopSandboxWorkspaceInputs } from "./desktop-sandbox-workspace-input.mjs";

export const DESKTOP_MATERIAL_GRANT_TTL_MS = 60 * 60 * 1000;

export async function prepareDesktopMaterialManifest({
  files = [],
  now = Date.now(),
  onProgress = () => {},
  signal,
  targetEmployeeId = "",
} = {}) {
  const normalizedFiles = files.map(normalizeAuthorizedFile).filter(Boolean);
  if (!normalizedFiles.length) throw materialError("desktop_material_selection_empty");
  const authorizedEmployeeId = cleanEmployeeId(targetEmployeeId);
  if (!authorizedEmployeeId) throw materialError("desktop_material_employee_required");

  const totalBytes = normalizedFiles.reduce((sum, file) => sum + file.size, 0);
  const typeDistribution = {};
  const aggregateHash = crypto.createHash("sha256");
  const sandboxWorkspaceFiles = [];
  let processedBytes = 0;

  onProgress({ phase: "inventory", processedBytes, totalBytes, fileCount: normalizedFiles.length });
  for (const file of normalizedFiles) {
    throwIfAborted(signal);
    typeDistribution[file.kind] = (typeDistribution[file.kind] || 0) + 1;
    const fileHash = crypto.createHash("sha256");
    let fileBytes = 0;
    const stream = createReadStream(file.filePath, { highWaterMark: 1024 * 1024, signal });
    for await (const chunk of stream) {
      fileBytes += chunk.length;
      if (fileBytes > file.size) throw materialError("desktop_material_file_changed");
      fileHash.update(chunk);
      processedBytes += chunk.length;
      onProgress({ phase: "hashing", processedBytes, totalBytes, fileCount: normalizedFiles.length });
    }
    if (fileBytes !== file.size) throw materialError("desktop_material_file_changed");
    const fileDigest = fileHash.digest("hex");
    aggregateHash.update(`${file.size}:${file.kind}:${file.type}:${fileDigest}\n`);
    sandboxWorkspaceFiles.push({ contentDigest: `sha256:${fileDigest}`, fileName: file.fileName, sizeBytes: file.size });
  }

  const createdAt = new Date(now).toISOString();
  const expiresAt = new Date(now + DESKTOP_MATERIAL_GRANT_TTL_MS).toISOString();
  const grantId = crypto.randomUUID();
  const sandboxWorkspaceInput = planDesktopSandboxWorkspaceInputs(sandboxWorkspaceFiles);
  const manifest = {
    contractVersion: "material-manifest.v1",
    manifestId: crypto.randomUUID(),
    source: "desktop_local_selection",
    status: "prepared_local",
    fileCount: normalizedFiles.length,
    totalBytes,
    typeDistribution,
    contentDigest: `sha256:${aggregateHash.digest("hex")}`,
    createdAt,
  };

  onProgress({ phase: "ready", processedBytes: totalBytes, totalBytes, fileCount: normalizedFiles.length });
  return {
    grant: {
      contractVersion: "local-material-grant.v1",
      grantId,
      scope: "selected_employee_current_turn",
      authorizationStatus: "authorized",
      authorizedEmployeeId,
      fileCount: normalizedFiles.length,
      createdAt,
      expiresAt,
    },
    manifest,
    sandboxWorkspaceInput,
    safeContext: {
      contractVersion: "desktop-material-context.v1",
      status: "prepared_local",
      availability: "local_device_only",
      authorization: {
        status: "authorized",
        scope: "selected_employee_current_turn",
        employeeId: authorizedEmployeeId,
      },
      executionRequired: true,
      transferRequired: false,
      runtimeReadable: false,
      manifest,
    },
  };
}

function normalizeAuthorizedFile(file = {}) {
  const filePath = String(file.filePath || "");
  const size = Number(file.size);
  if (!filePath || !Number.isFinite(size) || size <= 0) return null;
  return {
    filePath,
    fileName: String(file.name || "").normalize("NFC").trim(),
    size,
    kind: cleanToken(file.kind) || "file",
    type: cleanToken(file.type) || "application/octet-stream",
  };
}

function cleanToken(value = "") {
  return String(value || "").trim().slice(0, 120);
}

function cleanEmployeeId(value = "") {
  return String(value || "").trim().replace(/[^a-zA-Z0-9._:-]/g, "").slice(0, 160);
}

function throwIfAborted(signal) {
  if (!signal?.aborted) return;
  throw materialError("desktop_material_preparation_canceled");
}

function materialError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}
