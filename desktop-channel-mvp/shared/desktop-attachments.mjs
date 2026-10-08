export const DESKTOP_ATTACHMENT_LIMITS = Object.freeze({
  maxFiles: 20,
  maxBytes: 2 * 1024 * 1024 * 1024,
  maxPreviewBytes: 8 * 1024 * 1024,
});

const ATTACHMENT_BY_EXTENSION = new Map([
  [".jpg", { kind: "image", type: "image/jpeg" }],
  [".jpeg", { kind: "image", type: "image/jpeg" }],
  [".png", { kind: "image", type: "image/png" }],
  [".webp", { kind: "image", type: "image/webp" }],
  [".gif", { kind: "image", type: "image/gif" }],
  [".bmp", { kind: "image", type: "image/bmp" }],
  [".heic", { kind: "image", type: "image/heic" }],
  [".pdf", { kind: "document", type: "application/pdf" }],
  [".txt", { kind: "document", type: "text/plain" }],
  [".md", { kind: "document", type: "text/markdown" }],
  [".csv", { kind: "document", type: "text/csv" }],
  [".json", { kind: "document", type: "application/json" }],
  [".doc", { kind: "document", type: "application/msword" }],
  [".docx", { kind: "document", type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" }],
  [".xls", { kind: "document", type: "application/vnd.ms-excel" }],
  [".xlsx", { kind: "document", type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" }],
  [".ppt", { kind: "document", type: "application/vnd.ms-powerpoint" }],
  [".pptx", { kind: "document", type: "application/vnd.openxmlformats-officedocument.presentationml.presentation" }],
  [".zip", { kind: "archive", type: "application/zip" }],
  [".7z", { kind: "archive", type: "application/x-7z-compressed" }],
  [".tar", { kind: "archive", type: "application/x-tar" }],
  [".gz", { kind: "archive", type: "application/gzip" }],
]);

export function attachmentDescriptorForName(name = "") {
  return ATTACHMENT_BY_EXTENSION.get(fileExtension(name)) || { kind: "file", type: "application/octet-stream" };
}

export function attachmentMimeTypeForName(name = "") {
  return attachmentDescriptorForName(name).type;
}

export function extractHttpLinks(text = "") {
  return [...new Set(String(text).split(/\s+/).filter((item) => /^https?:\/\/[^\s]+$/i.test(item)))];
}

export function normalizeLocalAttachments(candidates = [], existingFiles = []) {
  const accepted = [];
  const rejected = [];
  const seen = new Set(Array.from(existingFiles || []).map(attachmentIdentity));

  for (const file of Array.from(candidates || [])) {
    if (!Number.isFinite(Number(file?.size)) || Number(file.size) <= 0) {
      rejected.push({ file, reason: "empty_file" });
      continue;
    }
    if (Number(file.size) > DESKTOP_ATTACHMENT_LIMITS.maxBytes) {
      rejected.push({ file, reason: "file_too_large" });
      continue;
    }
    const identity = attachmentIdentity(file);
    if (seen.has(identity)) {
      rejected.push({ file, reason: "duplicate" });
      continue;
    }
    if (seen.size >= DESKTOP_ATTACHMENT_LIMITS.maxFiles) {
      rejected.push({ file, reason: "file_limit" });
      continue;
    }
    seen.add(identity);
    accepted.push(file);
  }

  return { accepted, rejected };
}

function attachmentIdentity(file = {}) {
  return [String(file.name || "").trim().toLowerCase(), Number(file.size) || 0].join(":");
}

function fileExtension(name = "") {
  const normalized = String(name).trim().toLowerCase();
  const index = normalized.lastIndexOf(".");
  return index >= 0 ? normalized.slice(index) : "";
}
