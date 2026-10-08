import { promises as fs } from "node:fs";
import { request as httpsRequest } from "node:https";
import { isIP, BlockList } from "node:net";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { lookup as dnsLookup } from "node:dns/promises";
import mammoth from "mammoth";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";

const WORKSPACE_CONTRACT_VERSION = "trigger-material-workspace.v2";
const MATERIAL_REFERENCE_VERSION = "trigger-material-reference.v2";
const DEFAULT_MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;
const DEFAULT_MAX_TOTAL_BYTES = 25 * 1024 * 1024;
const DEFAULT_MAX_CONTRACT_TEXT_BYTES = 4 * 1024 * 1024;
const DEFAULT_MAX_FORM_BYTES = 256 * 1024;
const DEFAULT_DOWNLOAD_TIMEOUT_MS = 15_000;
const SUPPORTED_EXTENSIONS = Object.freeze(["txt", "pdf", "docx"]);
const MAX_REDIRECTS = 2;
const ERROR_CODES = Object.freeze([
  "trigger_attachment_cancelled",
  "trigger_attachment_dns_forbidden",
  "trigger_attachment_download_failed",
  "trigger_attachment_download_timeout",
  "trigger_attachment_download_url_forbidden",
  "trigger_attachment_empty",
  "trigger_attachment_form_invalid",
  "trigger_attachment_legacy_doc_unsupported",
  "trigger_attachment_parse_failed",
  "trigger_attachment_parse_timeout",
  "trigger_attachment_redirect_forbidden",
  "trigger_attachment_reference_invalid",
  "trigger_attachment_text_invalid",
  "trigger_attachment_text_too_large",
  "trigger_attachment_too_large",
  "trigger_attachment_type_unsupported",
  "trigger_material_empty",
  "trigger_material_text_too_large",
  "trigger_material_workspace_failed",
]);

const NON_PUBLIC_ADDRESSES = createNonPublicAddressBlockList();
const SENSITIVE_FORM_KEY = /(?:authorization|cookie|credential|password|passwd|presignedurl|secret|signedurl|token)/i;

function createTriggerAttachmentWorkspaceService({
  docxTextExtractor = extractDocxText,
  downloadTimeoutMs = DEFAULT_DOWNLOAD_TIMEOUT_MS,
  lookupHost = dnsLookup,
  maxAttachmentBytes = DEFAULT_MAX_ATTACHMENT_BYTES,
  maxContractTextBytes = DEFAULT_MAX_CONTRACT_TEXT_BYTES,
  maxFormBytes = DEFAULT_MAX_FORM_BYTES,
  maxTotalBytes = DEFAULT_MAX_TOTAL_BYTES,
  pdfTextExtractor = extractPdfText,
  requestImpl = httpsRequest,
  temporaryRoot = tmpdir(),
} = {}) {
  const limits = Object.freeze({
    downloadTimeoutMs: boundedInteger(downloadTimeoutMs, 1, 120_000, DEFAULT_DOWNLOAD_TIMEOUT_MS),
    maxAttachmentBytes: boundedInteger(maxAttachmentBytes, 1, 100 * 1024 * 1024,
      DEFAULT_MAX_ATTACHMENT_BYTES),
    maxContractTextBytes: boundedInteger(maxContractTextBytes, 1, 20 * 1024 * 1024,
      DEFAULT_MAX_CONTRACT_TEXT_BYTES),
    maxFormBytes: boundedInteger(maxFormBytes, 2, 2 * 1024 * 1024, DEFAULT_MAX_FORM_BYTES),
    maxTotalBytes: boundedInteger(maxTotalBytes, 1, 250 * 1024 * 1024,
      DEFAULT_MAX_TOTAL_BYTES),
  });
  if (typeof docxTextExtractor !== "function" || typeof lookupHost !== "function" ||
    typeof pdfTextExtractor !== "function" || typeof requestImpl !== "function" ||
    typeof temporaryRoot !== "string" || !temporaryRoot.trim()) {
    throw new TypeError("Trigger attachment workspace dependencies are invalid");
  }
  const workspaceRoot = resolve(temporaryRoot);

  async function prepare({ downloadUrls, material, signal = null } = {}) {
    assertSignal(signal);
    assertNotAborted(signal);
    const normalizedMaterial = normalizeMaterial(material, limits.maxAttachmentBytes);
    const { attachments, form } = normalizedMaterial;
    validateJsonValue(form, 0, new Set());
    const resolvedDownloads = normalizeDownloadUrls(downloadUrls, attachments);
    let workspacePath = "";
    try {
      workspacePath = await fs.mkdtemp(join(workspaceRoot, "digital-workforce-trigger-"));
      await fs.chmod(workspacePath, 0o700);
      const extractedParts = [];
      const extractionFailures = [];
      const documentMaterials = [];
      let totalBytes = 0;
      for (const attachment of attachments) {
        assertNotAborted(signal);
        const buffer = await downloadBoundedHttps(resolvedDownloads.get(attachment.attachmentIndex), {
          lookupHost,
          maxBytes: limits.maxAttachmentBytes,
          requestImpl,
          signal,
          timeoutMs: limits.downloadTimeoutMs,
        });
        totalBytes += buffer.byteLength;
        if (totalBytes > limits.maxTotalBytes) throw workspaceError("trigger_attachment_too_large");
        assertPassiveFileBytes(buffer);
        const fileName = `${String(attachment.attachmentIndex).padStart(3, "0")}-${attachment.fileName}`;
        await fs.writeFile(join(workspacePath, fileName), buffer, { flag: "wx", mode: 0o600 });
        if (SUPPORTED_EXTENSIONS.includes(attachment.extension)) {
          try {
            const text = await parseAttachment(buffer, attachment.extension, {
              docxTextExtractor,
              pdfTextExtractor,
              signal,
              timeoutMs: limits.downloadTimeoutMs,
            });
            extractedParts.push(text);
            documentMaterials.push({
              documentId: `attachment-${attachment.attachmentIndex}`,
              textStatus: "completed",
              extractedText: text,
            });
          } catch (error) {
            extractionFailures.push(error);
            documentMaterials.push({
              documentId: `attachment-${attachment.attachmentIndex}`,
              textStatus: "failed",
              extractedText: "",
            });
          }
        } else {
          documentMaterials.push({
            documentId: `attachment-${attachment.attachmentIndex}`,
            textStatus: "failed",
            extractedText: "",
          });
        }
      }
      const contractText = extractedParts.join("\n\n").trim();
      if (!contractText && !Object.keys(form).length && attachments.length > 0 &&
        extractionFailures.length === attachments.length &&
        attachments.every((item) => SUPPORTED_EXTENSIONS.includes(item.extension))) {
        throw extractionFailures[0];
      }
      if (!contractText && !attachments.length && !Object.keys(form).length) {
        throw workspaceError("trigger_material_empty");
      }
      if (Buffer.byteLength(contractText, "utf8") > limits.maxContractTextBytes) {
        throw workspaceError("trigger_material_text_too_large");
      }
      assertNotAborted(signal);
      const legalApprovalMaterialPath = join(workspacePath, "legal-approval-material.json");
      await fs.writeFile(legalApprovalMaterialPath,
        serializeLegalApprovalMaterial(form, documentMaterials,
          limits.maxFormBytes + limits.maxContractTextBytes), {
          encoding: "utf8",
          flag: "wx",
          mode: 0o600,
        });
      let cleaned = false;
      const cleanup = async () => {
        if (cleaned) return;
        cleaned = true;
        await fs.rm(workspacePath, { force: true, recursive: true });
      };
      return Object.freeze({
        contractVersion: WORKSPACE_CONTRACT_VERSION,
        diagnosticSummary: Object.freeze({
          attachmentCount: attachments.length,
          contractTextAvailable: Boolean(contractText),
          extractedDocumentCount: documentMaterials.filter(
            (document) => document.textStatus === "completed",
          ).length,
          failedExtractionCount: documentMaterials.filter(
            (document) => document.textStatus === "failed",
          ).length,
          formFieldCount: Object.keys(form).length,
        }),
        legalApprovalMaterialPath,
        workspacePath,
        cleanup,
      });
    } catch (error) {
      if (workspacePath) await fs.rm(workspacePath, { force: true, recursive: true }).catch(() => {});
      if (ERROR_CODES.includes(error?.code)) throw error;
      throw workspaceError("trigger_material_workspace_failed", error);
    }
  }

  return Object.freeze({
    prepare,
    serviceVersion: WORKSPACE_CONTRACT_VERSION,
  });
}

async function downloadBoundedHttps(urlValue, {
  lookupHost = dnsLookup,
  maxBytes = DEFAULT_MAX_ATTACHMENT_BYTES,
  requestImpl = httpsRequest,
  signal = null,
  timeoutMs = DEFAULT_DOWNLOAD_TIMEOUT_MS,
  _redirectCount = 0,
} = {}) {
  assertSignal(signal);
  assertNotAborted(signal);
  const maximumBytes = boundedInteger(maxBytes, 1, 100 * 1024 * 1024,
    DEFAULT_MAX_ATTACHMENT_BYTES);
  const maximumDuration = boundedInteger(timeoutMs, 1, 120_000,
    DEFAULT_DOWNLOAD_TIMEOUT_MS);
  const url = normalizeDownloadUrl(urlValue);
  const endpoint = await resolvePublicEndpoint(url, lookupHost, {
    signal,
    timeoutMs: maximumDuration,
  });
  assertNotAborted(signal);
  return new Promise((resolvePromise, rejectPromise) => {
    let settled = false;
    let request;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener?.("abort", onAbort);
      if (error) rejectPromise(error);
      else resolvePromise(value);
    };
    const onAbort = () => {
      const error = workspaceError("trigger_attachment_cancelled");
      request?.destroy?.(error);
      finish(error);
    };
    try {
      request = requestImpl(url, {
        agent: false,
        family: endpoint.family,
        headers: {
          Accept: "application/octet-stream",
          "Accept-Encoding": "identity",
          "User-Agent": "DigitalWorkforceCenter/1.0",
        },
        lookup: (_hostname, _options, callback) =>
          callback(null, endpoint.address, endpoint.family),
        method: "GET",
      }, (response) => {
        const statusCode = Number(response?.statusCode || 0);
        if (statusCode >= 300 && statusCode < 400) {
          response.resume?.();
          if (_redirectCount >= MAX_REDIRECTS || typeof response?.headers?.location !== "string") {
            finish(workspaceError("trigger_attachment_redirect_forbidden"));
            return;
          }
          let target;
          try {
            target = normalizeDownloadUrl(new URL(response.headers.location, url).toString());
          } catch {
            finish(workspaceError("trigger_attachment_redirect_forbidden"));
            return;
          }
          downloadBoundedHttps(target.toString(), {
            lookupHost,
            maxBytes: maximumBytes,
            requestImpl,
            signal,
            timeoutMs: maximumDuration,
            _redirectCount: _redirectCount + 1,
          }).then((value) => finish(null, value), (error) => finish(error));
          return;
        }
        if (statusCode < 200 || statusCode >= 300) {
          response.resume?.();
          finish(workspaceError("trigger_attachment_download_failed"));
          return;
        }
        const contentLength = Number(response?.headers?.["content-length"]);
        if (Number.isFinite(contentLength) && contentLength > maximumBytes) {
          response.destroy?.();
          finish(workspaceError("trigger_attachment_too_large"));
          return;
        }
        const chunks = [];
        let received = 0;
        response.on("data", (chunk) => {
          if (settled) return;
          const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
          received += bytes.byteLength;
          if (received > maximumBytes) {
            response.destroy?.();
            request.destroy?.();
            finish(workspaceError("trigger_attachment_too_large"));
            return;
          }
          chunks.push(bytes);
        });
        response.once("end", () => finish(null, Buffer.concat(chunks, received)));
        response.once("aborted", () => finish(workspaceError("trigger_attachment_download_failed")));
        response.once("error", () => finish(workspaceError("trigger_attachment_download_failed")));
      });
      request.once("error", (error) => {
        finish(ERROR_CODES.includes(error?.code)
          ? error
          : workspaceError("trigger_attachment_download_failed"));
      });
      request.setTimeout(maximumDuration, () => {
        const error = workspaceError("trigger_attachment_download_timeout");
        request.destroy?.(error);
        finish(error);
      });
      signal?.addEventListener?.("abort", onAbort, { once: true });
      if (signal?.aborted) onAbort();
      else request.end();
    } catch {
      finish(workspaceError("trigger_attachment_download_failed"));
    }
  });
}

async function resolvePublicEndpoint(url, lookupHost, { signal, timeoutMs }) {
  const hostname = url.hostname;
  const literalFamily = isIP(hostname);
  if (literalFamily) {
    assertPublicAddress(hostname, literalFamily);
    return Object.freeze({ address: hostname, family: literalFamily });
  }
  let addresses;
  try {
    addresses = await runBoundedLookup(hostname, lookupHost, { signal, timeoutMs });
  } catch (error) {
    if (ERROR_CODES.includes(error?.code)) throw error;
    throw workspaceError("trigger_attachment_dns_forbidden");
  }
  if (!Array.isArray(addresses) || !addresses.length) {
    throw workspaceError("trigger_attachment_dns_forbidden");
  }
  const normalized = addresses.map((entry) => {
    const address = String(entry?.address || "");
    const family = Number(entry?.family || isIP(address));
    assertPublicAddress(address, family);
    return { address, family };
  });
  return Object.freeze(normalized[0]);
}

function runBoundedLookup(hostname, lookupHost, { signal, timeoutMs }) {
  return new Promise((resolvePromise, rejectPromise) => {
    let settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutId);
      signal?.removeEventListener?.("abort", onAbort);
      if (error) rejectPromise(error);
      else resolvePromise(value);
    };
    const onAbort = () => finish(workspaceError("trigger_attachment_cancelled"));
    const timeoutId = setTimeout(() =>
      finish(workspaceError("trigger_attachment_download_timeout")), timeoutMs);
    signal?.addEventListener?.("abort", onAbort, { once: true });
    if (signal?.aborted) {
      onAbort();
      return;
    }
    Promise.resolve()
      .then(() => lookupHost(hostname, { all: true, verbatim: true }))
      .then((value) => finish(null, value), (error) => finish(error));
  });
}

function normalizeDownloadUrl(value) {
  try {
    const url = new URL(String(value || ""));
    if (url.protocol !== "https:" || url.username || url.password || url.hash ||
      (url.port && url.port !== "443") || !url.hostname ||
      url.hostname === "localhost" || url.hostname.endsWith(".localhost")) {
      throw new Error("forbidden");
    }
    return url;
  } catch {
    throw workspaceError("trigger_attachment_download_url_forbidden");
  }
}

function normalizeMaterial(material, maximumBytes) {
  if (!isPlainObject(material) || material.contractVersion !== MATERIAL_REFERENCE_VERSION ||
    !isPlainObject(material.form) || !Array.isArray(material.attachments) ||
    material.attachments.length > 20) {
    throw workspaceError("trigger_attachment_reference_invalid");
  }
  if (!Object.keys(material.form).length && !material.attachments.length) {
    throw workspaceError("trigger_material_empty");
  }
  const indexes = new Set();
  const attachments = material.attachments.map((attachment) => {
    if (!isPlainObject(attachment) || !Number.isInteger(attachment.attachmentIndex) ||
      attachment.attachmentIndex < 0 || indexes.has(attachment.attachmentIndex)) {
      throw workspaceError("trigger_attachment_reference_invalid");
    }
    indexes.add(attachment.attachmentIndex);
    const extension = String(attachment.extension || "").toLowerCase();
    if (!/^[a-z0-9]{1,12}$/.test(extension)) {
      throw workspaceError("trigger_attachment_reference_invalid");
    }
    if (attachment.sizeBytes !== null && attachment.sizeBytes !== undefined &&
      (!Number.isInteger(attachment.sizeBytes) || attachment.sizeBytes < 0 ||
        attachment.sizeBytes > maximumBytes)) {
      throw workspaceError("trigger_attachment_too_large");
    }
      const sourceName = basename(String(attachment.name || `attachment.${extension}`));
      const fileName = sourceName.replace(/[^\p{L}\p{N}._ -]+/gu, "_").slice(0, 160);
    if (!fileName || fileName === "." || fileName === "..") {
      throw workspaceError("trigger_attachment_reference_invalid");
    }
    const normalizedFileName = fileName.toLowerCase().endsWith(`.${extension}`)
      ? fileName
      : `${fileName}.${extension}`;
    return Object.freeze({
      attachmentIndex: attachment.attachmentIndex,
      extension,
      fileName: normalizedFileName,
      sizeBytes: attachment.sizeBytes ?? null,
    });
  });
  return Object.freeze({ attachments: Object.freeze(attachments), form: material.form });
}

function normalizeDownloadUrls(values, attachments) {
  if (!Array.isArray(values) || values.length !== attachments.length) {
    throw workspaceError("trigger_attachment_reference_invalid");
  }
  const expected = new Set(attachments.map((attachment) => attachment.attachmentIndex));
  const result = new Map();
  for (const item of values) {
    if (!isPlainObject(item) || !Number.isInteger(item.attachmentIndex) ||
      !expected.has(item.attachmentIndex) || result.has(item.attachmentIndex) ||
      typeof item.url !== "string") {
      throw workspaceError("trigger_attachment_reference_invalid");
    }
    result.set(item.attachmentIndex, item.url);
  }
  return result;
}

async function parseAttachment(buffer, extension, {
  docxTextExtractor,
  pdfTextExtractor,
  signal,
  timeoutMs,
}) {
  assertNotAborted(signal);
  try {
    let value;
    if (extension === "txt") {
      value = new TextDecoder("utf-8", { fatal: true }).decode(buffer);
    } else if (extension === "pdf") {
      if (!buffer.subarray(0, 5).equals(Buffer.from("%PDF-"))) {
        throw workspaceError("trigger_attachment_parse_failed");
      }
      value = await runBoundedExtractor(pdfTextExtractor, buffer, { signal, timeoutMs });
    } else {
      if (buffer[0] !== 0x50 || buffer[1] !== 0x4b) {
        throw workspaceError("trigger_attachment_parse_failed");
      }
      value = await runBoundedExtractor(docxTextExtractor, buffer, { signal, timeoutMs });
    }
    assertNotAborted(signal);
    return normalizeExtractedText(value);
  } catch (error) {
    if (ERROR_CODES.includes(error?.code)) throw error;
    throw workspaceError(extension === "txt"
      ? "trigger_attachment_text_invalid"
      : "trigger_attachment_parse_failed");
  }
}

function runBoundedExtractor(extractor, buffer, { signal, timeoutMs }) {
  return new Promise((resolvePromise, rejectPromise) => {
    let settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutId);
      signal?.removeEventListener?.("abort", onAbort);
      if (error) rejectPromise(error);
      else resolvePromise(value);
    };
    const onAbort = () => finish(workspaceError("trigger_attachment_cancelled"));
    const timeoutId = setTimeout(() =>
      finish(workspaceError("trigger_attachment_parse_timeout")), timeoutMs);
    signal?.addEventListener?.("abort", onAbort, { once: true });
    if (signal?.aborted) {
      onAbort();
      return;
    }
    Promise.resolve()
      .then(() => extractor(buffer, { signal }))
      .then((value) => finish(null, value), (error) => finish(error));
  });
}

async function extractPdfText(buffer) {
  const loadingTask = getDocument({ data: new Uint8Array(buffer), disableWorker: true });
  let document;
  try {
    document = await loadingTask.promise;
    const pages = [];
    for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber += 1) {
      const page = await document.getPage(pageNumber);
      const content = await page.getTextContent();
      pages.push(content.items.map((item) => typeof item?.str === "string" ? item.str : "").join(" "));
      page.cleanup?.();
    }
    return pages.join("\n");
  } finally {
    await document?.destroy?.();
    await loadingTask.destroy?.();
  }
}

async function extractDocxText(buffer) {
  const result = await mammoth.extractRawText({ buffer });
  return result.value;
}

function normalizeExtractedText(value) {
  if (typeof value !== "string") throw workspaceError("trigger_attachment_parse_failed");
  const text = value.replace(/\r\n?/g, "\n").replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "").trim();
  if (!text) throw workspaceError("trigger_attachment_empty");
  return text;
}

function serializeLegalApprovalMaterial(form, documents, maximumBytes) {
  if (!isPlainObject(form)) throw workspaceError("trigger_attachment_form_invalid");
  validateJsonValue(form, 0, new Set());
  const formFields = Object.entries(form).flatMap(([label, value]) =>
    isSkillScalar(value) ? [{ label, value, valueType: typeof value }] : []);
  const documentStatuses = documents.map((document) => document.textStatus);
  const json = `${JSON.stringify({
    contractVersion: "smore-legal-approval-material.v2",
    formFields,
    semanticFacts: {},
    documents,
    materialStatus: {
      form: formFields.length ? "available" : "not_provided",
      documents: !documents.length
        ? "not_provided"
        : documentStatuses.every((status) => status === "completed")
          ? "complete"
          : documentStatuses.some((status) => status === "completed")
            ? "partial"
            : "opaque",
    },
  }, null, 2)}\n`;
  if (Buffer.byteLength(json, "utf8") > maximumBytes) {
    throw workspaceError("trigger_attachment_form_invalid");
  }
  return json;
}

function isSkillScalar(value) {
  if (typeof value === "string" || typeof value === "boolean" ||
    (typeof value === "number" && Number.isFinite(value))) return true;
  return Array.isArray(value) && value.length <= 50 && value.every((item) =>
    typeof item === "string" || typeof item === "boolean" ||
    (typeof item === "number" && Number.isFinite(item)));
}

function validateJsonValue(value, depth, seen) {
  if (depth > 10) throw workspaceError("trigger_attachment_form_invalid");
  if (value === null || typeof value === "string" || typeof value === "boolean") return;
  if (typeof value === "number" && Number.isFinite(value)) return;
  if (typeof value !== "object" || seen.has(value)) {
    throw workspaceError("trigger_attachment_form_invalid");
  }
  seen.add(value);
  if (Array.isArray(value)) {
    if (value.length > 1_000) throw workspaceError("trigger_attachment_form_invalid");
    for (const item of value) validateJsonValue(item, depth + 1, seen);
  } else {
    if (!isPlainObject(value)) throw workspaceError("trigger_attachment_form_invalid");
    const entries = Object.entries(value);
    if (entries.length > 1_000) throw workspaceError("trigger_attachment_form_invalid");
    for (const [key, item] of entries) {
      if (!key || key.length > 200 || SENSITIVE_FORM_KEY.test(key)) {
        throw workspaceError("trigger_attachment_form_invalid");
      }
      validateJsonValue(item, depth + 1, seen);
    }
  }
  seen.delete(value);
}

function assertPublicAddress(address, family) {
  if (![4, 6].includes(family) || isIP(address) !== family ||
    (family === 6 && address.toLowerCase().startsWith("::ffff:")) ||
    NON_PUBLIC_ADDRESSES.check(address, family === 4 ? "ipv4" : "ipv6")) {
    throw workspaceError("trigger_attachment_dns_forbidden");
  }
}

function assertPassiveFileBytes(buffer) {
  const executableMagic = buffer.subarray(0, 4);
  if (buffer.subarray(0, 2).equals(Buffer.from("MZ")) ||
    executableMagic.equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46])) ||
    ["feedface", "feedfacf", "cefaedfe", "cffaedfe", "cafebabe"]
      .includes(executableMagic.toString("hex"))) {
    throw workspaceError("trigger_attachment_type_unsupported");
  }
}

function createNonPublicAddressBlockList() {
  const list = new BlockList();
  for (const [network, prefix] of [
    ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8],
    ["169.254.0.0", 16], ["172.16.0.0", 12], ["192.0.0.0", 24], ["192.0.2.0", 24],
    ["192.168.0.0", 16], ["198.18.0.0", 15], ["198.51.100.0", 24], ["203.0.113.0", 24],
    ["224.0.0.0", 4], ["240.0.0.0", 4],
  ]) list.addSubnet(network, prefix, "ipv4");
  for (const [network, prefix] of [
    ["::", 128], ["::1", 128], ["100::", 64], ["2001:db8::", 32],
    ["fc00::", 7], ["fe80::", 10], ["ff00::", 8],
  ]) list.addSubnet(network, prefix, "ipv6");
  return list;
}

function assertSignal(signal) {
  if (signal !== null && !(typeof signal === "object" &&
    typeof signal.addEventListener === "function" && typeof signal.aborted === "boolean")) {
    throw workspaceError("trigger_attachment_reference_invalid");
  }
}

function assertNotAborted(signal) {
  if (signal?.aborted) throw workspaceError("trigger_attachment_cancelled");
}

function boundedInteger(value, minimum, maximum, fallback) {
  return Number.isInteger(value) && value >= minimum && value <= maximum ? value : fallback;
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value) &&
    [Object.prototype, null].includes(Object.getPrototypeOf(value));
}

function workspaceError(code, cause = undefined) {
  const error = new Error(code, cause === undefined ? undefined : { cause });
  error.code = code;
  return error;
}

export {
  DEFAULT_DOWNLOAD_TIMEOUT_MS as TRIGGER_ATTACHMENT_DEFAULT_DOWNLOAD_TIMEOUT_MS,
  DEFAULT_MAX_ATTACHMENT_BYTES as TRIGGER_ATTACHMENT_DEFAULT_MAX_BYTES,
  ERROR_CODES as TRIGGER_ATTACHMENT_WORKSPACE_ERROR_CODES,
  SUPPORTED_EXTENSIONS as TRIGGER_ATTACHMENT_SUPPORTED_EXTENSIONS,
  WORKSPACE_CONTRACT_VERSION as TRIGGER_ATTACHMENT_WORKSPACE_VERSION,
  createTriggerAttachmentWorkspaceService,
  downloadBoundedHttps,
};
