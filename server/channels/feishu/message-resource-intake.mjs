import { randomUUID } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { canonicalInputDescriptor, normalizeMimeType, safeCanonicalFileName } from "../../agent-runtime/canonical-input-types.mjs";

const FEISHU_MESSAGE_RESOURCE_URL = "https://open.feishu.cn/open-apis/im/v1/messages";
const MAX_MESSAGE_RESOURCE_BYTES = 100 * 1024 * 1024;
const TEMP_FILE_TTL_MS = 15 * 60 * 1000;

async function downloadFeishuMessageResource({
  fetch = globalThis.fetch,
  fileKey = "",
  fileName = "",
  messageId = "",
  messageType = "file",
  tenantAccessToken = "",
  tempDir = path.join(os.tmpdir(), "digital-workforce-feishu-intake"),
} = {}) {
  if (!messageId || !fileKey || !tenantAccessToken) {
    return { ok: false, status: "download_context_missing" };
  }

  const resourceType = messageType === "image" ? "image" : "file";
  const requestUrl = new URL(
    `${FEISHU_MESSAGE_RESOURCE_URL}/${encodeURIComponent(messageId)}/resources/${encodeURIComponent(fileKey)}`,
  );
  requestUrl.searchParams.set("type", resourceType);

  let response;
  try {
    response = await fetch(requestUrl, {
      headers: { Authorization: `Bearer ${tenantAccessToken}` },
    });
  } catch {
    return { ok: false, status: "download_network_failed" };
  }
  if (!response.ok) {
    const errorCode = await readFeishuErrorCode(response);
    if (errorCode === 234037) {
      return {
        ok: false,
        status: "download_too_large",
        httpStatus: response.status,
        sizeLimitBytes: MAX_MESSAGE_RESOURCE_BYTES,
      };
    }
    return { ok: false, status: "download_request_failed", httpStatus: response.status };
  }

  const contentLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(contentLength) && contentLength > MAX_MESSAGE_RESOURCE_BYTES) {
    return { ok: false, status: "download_too_large", sizeBytes: contentLength };
  }

  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.byteLength > MAX_MESSAGE_RESOURCE_BYTES) {
    return { ok: false, status: "download_too_large", sizeBytes: bytes.byteLength };
  }

  const responseContentType = normalizeMimeType(response.headers.get("content-type"));
  const resolvedContentType = detectResourceContentType(bytes, fileName, responseContentType);
  const normalizedFileName = safeCanonicalFileName(fileName, resolvedContentType);
  await mkdir(tempDir, { recursive: true });
  const filePath = path.join(tempDir, `${randomUUID()}${safeExtension(normalizedFileName)}`);
  await writeFile(filePath, bytes);
  scheduleTemporaryFileRemoval(filePath);

  return {
    ok: true,
    status: "temporary_downloaded",
    sizeBytes: bytes.byteLength,
    contentType: resolvedContentType.slice(0, 120),
    fileName: normalizedFileName,
    temporaryFilePath: filePath,
  };
}

async function readFeishuErrorCode(response) {
  try {
    const payload = await response.json();
    const errorCode = Number(payload?.code);
    return Number.isInteger(errorCode) ? errorCode : 0;
  } catch {
    return 0;
  }
}

function safeExtension(fileName = "") {
  const extension = path.extname(String(fileName || "")).toLowerCase();
  return /^\.[a-z0-9]{1,12}$/.test(extension) ? extension : "";
}

function detectResourceContentType(bytes, fileName = "", declaredMimeType = "") {
  const namedDescriptor = canonicalInputDescriptor({ fileName });
  if (namedDescriptor) return namedDescriptor.mimeType;
  if (bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return "image/png";
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  if (bytes.subarray(0, 4).toString("ascii") === "GIF8") return "image/gif";
  if (bytes.subarray(0, 4).toString("ascii") === "RIFF" && bytes.subarray(8, 12).toString("ascii") === "WEBP") return "image/webp";
  if (bytes.subarray(0, 5).toString("ascii") === "%PDF-") return "application/pdf";
  if (bytes[0] === 0x50 && bytes[1] === 0x4b) return "application/zip";
  return canonicalInputDescriptor({ mimeType: declaredMimeType })?.mimeType || declaredMimeType;
}

function scheduleTemporaryFileRemoval(filePath) {
  const timer = setTimeout(() => {
    rm(filePath, { force: true }).catch(() => {});
  }, TEMP_FILE_TTL_MS);
  timer.unref?.();
}

export { downloadFeishuMessageResource };
