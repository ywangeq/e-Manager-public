import path from "node:path";

const MIME_BY_EXTENSION = new Map([
  [".png", "image/png"],
  [".jpg", "image/jpeg"],
  [".jpeg", "image/jpeg"],
  [".webp", "image/webp"],
  [".gif", "image/gif"],
  [".pdf", "application/pdf"],
  [".doc", "application/msword"],
  [".docx", "application/vnd.openxmlformats-officedocument.wordprocessingml.document"],
  [".odt", "application/vnd.oasis.opendocument.text"],
  [".rtf", "application/rtf"],
  [".ppt", "application/vnd.ms-powerpoint"],
  [".pptx", "application/vnd.openxmlformats-officedocument.presentationml.presentation"],
  [".xls", "application/vnd.ms-excel"],
  [".xlsx", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"],
  [".csv", "text/csv"],
  [".tsv", "text/tsv"],
  [".txt", "text/plain"],
  [".md", "text/markdown"],
  [".markdown", "text/markdown"],
  [".json", "application/json"],
  [".jsonl", "application/x-ndjson"],
  [".html", "text/html"],
  [".htm", "text/html"],
  [".xml", "text/xml"],
  [".yaml", "application/yaml"],
  [".yml", "application/yaml"],
  [".toml", "application/toml"],
  [".js", "text/javascript"],
  [".mjs", "text/javascript"],
  [".ts", "application/typescript"],
  [".tsx", "text/tsx"],
  [".jsx", "text/jsx"],
  [".css", "text/css"],
  [".py", "text/x-python"],
  [".sql", "text/x-sql"],
  [".log", "text/plain"],
]);

const IMAGE_MIME_TYPES = new Set([
  "image/gif",
  "image/jpeg",
  "image/png",
  "image/webp",
]);

const FILE_MIME_TYPES = new Set([...MIME_BY_EXTENSION.values()].filter((mimeType) => !IMAGE_MIME_TYPES.has(mimeType)));

function canonicalInputDescriptor({ fileName = "", mimeType = "" } = {}) {
  const extension = path.extname(String(fileName || "")).toLowerCase();
  const declaredMimeType = normalizeMimeType(mimeType);
  const inferredMimeType = MIME_BY_EXTENSION.get(extension) || "";
  const resolvedMimeType = inferredMimeType || declaredMimeType;
  if (IMAGE_MIME_TYPES.has(resolvedMimeType)) return { type: "image", mimeType: resolvedMimeType };
  if (FILE_MIME_TYPES.has(resolvedMimeType)) return { type: "file", mimeType: resolvedMimeType };
  return null;
}

function safeCanonicalFileName(fileName = "", mimeType = "") {
  const original = path.basename(String(fileName || "").trim()).replace(/[^\p{L}\p{N}._ -]+/gu, "_").slice(0, 160);
  const descriptor = canonicalInputDescriptor({ fileName: original, mimeType });
  const extension = path.extname(original).toLowerCase();
  const inferredExtension = extensionForMimeType(descriptor?.mimeType || normalizeMimeType(mimeType));
  const baseName = original || "attachment";
  return extension || !inferredExtension ? baseName : `${baseName}${inferredExtension}`;
}

function extensionForMimeType(mimeType = "") {
  const normalized = normalizeMimeType(mimeType);
  return [...MIME_BY_EXTENSION.entries()].find(([, candidate]) => candidate === normalized)?.[0] || "";
}

function normalizeMimeType(value = "") {
  return String(value || "").split(";", 1)[0].trim().toLowerCase();
}

function isSupportedEphemeralMimeType(mimeType = "") {
  const normalized = normalizeMimeType(mimeType);
  return IMAGE_MIME_TYPES.has(normalized) || FILE_MIME_TYPES.has(normalized);
}

export {
  IMAGE_MIME_TYPES,
  canonicalInputDescriptor,
  extensionForMimeType,
  isSupportedEphemeralMimeType,
  normalizeMimeType,
  safeCanonicalFileName,
};
