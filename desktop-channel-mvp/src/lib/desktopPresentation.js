import { attachmentDescriptorForName, DESKTOP_ATTACHMENT_LIMITS, extractHttpLinks } from "../../shared/desktop-attachments.mjs";
import { removeCredentialText } from "../../shared/sensitive-text-guard.mjs";

export function attachmentIntakeFeedback(acceptedCount, rejected = []) {
  const reasonCounts = rejected.reduce((counts, item) => {
    const reason = item?.reason || "unreadable";
    counts[reason] = (counts[reason] || 0) + 1;
    return counts;
  }, {});
  const details = [];
  if (reasonCounts.file_too_large) details.push(`单个文件不能超过 ${DESKTOP_ATTACHMENT_LIMITS.maxBytes / 1024 / 1024 / 1024} GB`);
  if (reasonCounts.empty_file || reasonCounts.unreadable) details.push("存在空文件或无法读取的文件");
  if (reasonCounts.duplicate) details.push(`已忽略 ${reasonCounts.duplicate} 个重复文件`);
  if (reasonCounts.file_limit) details.push(`单次最多添加 ${DESKTOP_ATTACHMENT_LIMITS.maxFiles} 个文件`);
  if (!details.length) return acceptedCount
    ? { tone: "success", text: `已授权 ${acceptedCount} 个文件，发送时在本机生成安全材料清单。` }
    : { tone: "error", text: "未添加：没有可读取的文件。" };
  return { tone: acceptedCount ? "warning" : "error", text: `${acceptedCount ? `已添加 ${acceptedCount} 张；` : "未添加："}${details.join("；")}。` };
}

export async function browserFileRecords(files) {
  return Promise.all(files.map(async (file) => {
    const descriptor = attachmentDescriptorForName(file.name);
    const canPreview = descriptor.kind === "image" && file.size <= DESKTOP_ATTACHMENT_LIMITS.maxPreviewBytes;
    const previewDataUrl = canPreview ? await fileToDataUrl(file) : "";
    return {
      id: `${file.name}-${file.lastModified}-${Math.random().toString(16).slice(2)}`,
      name: file.name,
      size: file.size,
      type: descriptor.type,
      kind: descriptor.kind,
      previewDataUrl,
      previewAvailable: Boolean(previewDataUrl),
    };
  }));
}

export function httpLinksFromDrop(dataTransfer) {
  const raw = [dataTransfer?.getData("text/uri-list"), dataTransfer?.getData("text/plain")].filter(Boolean).join("\n");
  return extractHttpLinks(raw);
}

export function attachmentKindLabel(file = {}) {
  const kind = file.kind || attachmentDescriptorForName(file.name).kind;
  if (kind === "image") return "图片";
  if (kind === "archive") return "压缩包";
  if (kind === "document") return "文档";
  return "文件";
}

export function formatFileSize(bytes = 0) {
  const size = Number(bytes) || 0;
  if (size >= 1024 * 1024 * 1024) return `${(size / 1024 / 1024 / 1024).toFixed(1)} GB`;
  if (size >= 1024 * 1024) return `${(size / 1024 / 1024).toFixed(1)} MB`;
  if (size >= 1024) return `${Math.round(size / 1024)} KB`;
  return `${size} B`;
}

export function cleanCredentialFreeText(value = "") {
  return removeCredentialText(value).replace(/\s{2,}/g, " ").trim();
}

export function formatCredentialExpiry(value = "") {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "";
  return ` · 有效至 ${new Intl.DateTimeFormat("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false }).format(date)}`;
}

export function materialProgressPercent(progress = {}) {
  if (progress.phase === "ready") return 100;
  const total = Number(progress.totalBytes) || 0;
  if (!total) return 0;
  return Math.min(99, Math.max(0, Math.round(((Number(progress.processedBytes) || 0) / total) * 100)));
}

function fileToDataUrl(file) {
  return new Promise((resolve) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ""));
    reader.onerror = () => resolve("");
    reader.readAsDataURL(file);
  });
}

export function isMaterialDrag(dataTransfer) {
  const types = Array.from(dataTransfer?.types || []);
  return !types.some(type => ["application/x-group-employee", "application/x-group-reviewer"].includes(type))
    && types.some(type => ["Files", "text/uri-list", "text/plain"].includes(type));
}
