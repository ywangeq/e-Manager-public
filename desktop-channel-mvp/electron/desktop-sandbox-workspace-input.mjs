import crypto from "node:crypto";

const MAX_INPUT_FILES = 20;
const SAFE_FILE_NAME_PATTERN = /^[^/\\\0\r\n]{1,180}$/u;
const RESERVED_WINDOWS_FILE_NAMES = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.[^.]*)?$/i;
const SHA256_DIGEST = /^sha256:[a-f0-9]{64}$/;

// Shared by Electron-main material preparation and trusted workspace copy.
// The result is private execution evidence and never renderer IPC.
function planDesktopSandboxWorkspaceInputs(files = []) {
  if (!Array.isArray(files) || files.length > MAX_INPUT_FILES) {
    throw inputError("desktop_sandbox_workspace_inputs_invalid");
  }
  const inputs = [];
  for (const [index, source] of files.entries()) {
    inputs.push(Object.freeze({
      contentDigest: requiredContentDigest(source?.contentDigest),
      fileName: uniqueWorkspaceFileName(requiredFileName(source?.fileName), inputs.map((item) => item.fileName)),
      inputId: `input-${index + 1}`,
      sizeBytes: requiredSize(source?.sizeBytes),
    }));
  }
  const totalInputBytes = inputs.reduce((total, input) => total + input.sizeBytes, 0);
  return Object.freeze({
    contractVersion: "device-sandbox-task-input.v1",
    inputCount: inputs.length,
    inputs: Object.freeze(inputs),
    totalInputBytes,
    workspaceInputDigest: workspaceInputDigestFromInputs(inputs),
  });
}

function workspaceInputDigest(summary = {}) {
  if (!summary || typeof summary !== "object" || Array.isArray(summary) || !Array.isArray(summary.inputs) ||
    !Number.isSafeInteger(summary.inputCount) || summary.inputCount !== summary.inputs.length ||
    !Number.isSafeInteger(summary.totalInputBytes) || summary.totalInputBytes < 0) {
    throw inputError("desktop_sandbox_workspace_summary_invalid");
  }
  const inputs = summary.inputs.map((input, index) => normalizeWorkspaceInput(input, index));
  if (inputs.reduce((total, input) => total + input.sizeBytes, 0) !== summary.totalInputBytes) {
    throw inputError("desktop_sandbox_workspace_input_bytes_invalid");
  }
  return workspaceInputDigestFromInputs(inputs);
}

function uniqueWorkspaceFileName(fileName, existingNames = []) {
  const names = new Set(existingNames.map((item) => String(item).toLowerCase()));
  if (!names.has(fileName.toLowerCase())) return fileName;
  const extensionIndex = fileName.lastIndexOf(".");
  const baseName = extensionIndex > 0 ? fileName.slice(0, extensionIndex) : fileName;
  const extension = extensionIndex > 0 ? fileName.slice(extensionIndex) : "";
  for (let index = 2; index <= 999; index += 1) {
    const candidate = `${baseName.slice(0, 140)}-${index}${extension}`;
    if (!names.has(candidate.toLowerCase())) return candidate;
  }
  throw inputError("desktop_sandbox_workspace_input_name_collision");
}

function normalizeWorkspaceInput(value, index) {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).length !== 4 ||
    !Object.hasOwn(value, "contentDigest") || !Object.hasOwn(value, "fileName") ||
    !Object.hasOwn(value, "inputId") || !Object.hasOwn(value, "sizeBytes") ||
    String(value.inputId || "").trim() !== `input-${index + 1}`) {
    throw inputError("desktop_sandbox_workspace_input_invalid");
  }
  return Object.freeze({
    contentDigest: requiredContentDigest(value.contentDigest),
    fileName: requiredFileName(value.fileName),
    inputId: `input-${index + 1}`,
    sizeBytes: requiredSize(value.sizeBytes),
  });
}

function workspaceInputDigestFromInputs(inputs) {
  return crypto.createHash("sha256").update(JSON.stringify({
    contractVersion: "device-sandbox-task-input-digest.v1",
    inputs,
  })).digest("hex");
}

function requiredFileName(value) {
  const fileName = String(value || "").normalize("NFC").trim();
  if (!SAFE_FILE_NAME_PATTERN.test(fileName) || fileName === "." || fileName === ".." ||
    fileName.endsWith(".") || fileName.endsWith(" ") || RESERVED_WINDOWS_FILE_NAMES.test(fileName)) {
    throw inputError("desktop_sandbox_workspace_input_name_invalid");
  }
  return fileName;
}

function requiredContentDigest(value) {
  const digest = String(value || "").trim().toLowerCase();
  if (!SHA256_DIGEST.test(digest)) throw inputError("desktop_sandbox_workspace_input_digest_invalid");
  return digest;
}

function requiredSize(value) {
  const sizeBytes = Number(value);
  if (!Number.isSafeInteger(sizeBytes) || sizeBytes <= 0) throw inputError("desktop_sandbox_workspace_input_size_invalid");
  return sizeBytes;
}

function inputError(code) {
  const error = new TypeError(code);
  error.code = code;
  return error;
}

export { planDesktopSandboxWorkspaceInputs, uniqueWorkspaceFileName, workspaceInputDigest };
