function formatFeishuChannelText(value = "") {
  const sourceLines = String(value || "")
    .replace(/\r\n?/g, "\n")
    .replace(/[\u200B-\u200D\uFEFF]/g, "")
    .split("\n")
    .map((line) => line.trim());
  const lines = [];

  for (let index = 0; index < sourceLines.length; index += 1) {
    const line = sourceLines[index];
    const headers = markdownTableCells(line);
    const separator = markdownTableCells(sourceLines[index + 1]);
    if (headers.length >= 2 && isMarkdownTableSeparator(separator)) {
      index += 2;
      while (index < sourceLines.length) {
        const cells = markdownTableCells(sourceLines[index]);
        if (!cells.length) break;
        lines.push(formatMarkdownTableRecord(headers, cells));
        index += 1;
      }
      index -= 1;
      appendBlankLine(lines);
      continue;
    }
    if (/^(?:-{3,}|\*{3,}|_{3,})$/.test(line)) {
      appendBlankLine(lines);
      continue;
    }
    if (!line) {
      appendBlankLine(lines);
      continue;
    }
    lines.push(line
      .replace(/^\s{0,3}#{1,6}\s*/, "")
      .replace(/\*\*([^*\n]+)\*\*/g, "$1")
      .replace(/__([^_\n]+)__/g, "$1")
      .replace(/^\s*[-*]\s+/, "- "));
  }

  while (lines[0] === "") lines.shift();
  while (lines[lines.length - 1] === "") lines.pop();
  return lines.join("\n").trim() || "我已收到消息，但本次没有生成可展示的回复。";
}

function buildFeishuReplyMessage({
  text = "",
  employeeName = "数字员工",
  groupReplyMention = null,
  preferInteractiveCard = true,
} = {}) {
  const displayText = formatFeishuChannelText(text);
  if (!groupReplyMention?.userId && !isStructuredReply(displayText)) {
    return { msgType: "text", content: "", text: displayText };
  }

  if (preferInteractiveCard) {
    return {
      msgType: "interactive",
      text: displayText,
      content: JSON.stringify(buildFeishuMarkdownCard({ employeeName, groupReplyMention, text })),
    };
  }

  const paragraphs = formatFeishuCardMarkdown(text)
    .split("\n")
    .filter(Boolean)
    .map(postLineNodes);
  if (groupReplyMention?.userId) {
    const [first, ...rest] = paragraphs[0];
    paragraphs[0] = [
      { tag: "at", user_id: groupReplyMention.userId },
      first?.tag === "text" ? { ...first, text: ` ${first.text}` } : { tag: "text", text: " " },
      ...(first?.tag === "text" ? rest : paragraphs[0]),
    ];
  }

  return {
    msgType: "post",
    text: displayText,
    content: JSON.stringify({
      zh_cn: {
        title: String(employeeName || "数字员工").trim(),
        content: paragraphs,
      },
    }),
  };
}

function buildFeishuMarkdownCard({ text = "", employeeName = "数字员工", groupReplyMention = null } = {}) {
  const mention = feishuCardMention(groupReplyMention?.userId);
  const title = String(employeeName || "数字员工").trim() || "数字员工";
  const elements = buildFeishuCardContentElements(text);
  const heading = [`**${escapeCardMarkdown(title)}**`, mention].filter(Boolean).join("\n");
  if (elements[0]?.tag === "div") {
    elements[0].text.content = `${heading}\n\n${elements[0].text.content}`;
  } else {
    elements.unshift({ tag: "div", text: { tag: "lark_md", content: heading } });
  }
  return {
    config: { wide_screen_mode: true },
    elements,
  };
}

function buildFeishuCardContentElements(value = "") {
  const sourceLines = String(value || "")
    .replace(/\r\n?/g, "\n")
    .replace(/[\u200B-\u200D\uFEFF]/g, "")
    .split("\n");
  const elements = [];
  let textLines = [];
  let tableCount = 0;
  const flushText = () => {
    if (!textLines.some((line) => String(line || "").trim())) {
      textLines = [];
      return;
    }
    elements.push(...splitFeishuCardMarkdown(textLines.join("\n")).map((content) => ({
      tag: "div",
      text: { tag: "lark_md", content },
    })));
    textLines = [];
  };

  for (let index = 0; index < sourceLines.length;) {
    const headers = markdownTableCells(sourceLines[index]);
    const separator = markdownTableCells(sourceLines[index + 1]);
    if (headers.length >= 2 && headers.length === separator.length && isMarkdownTableSeparator(separator)) {
      const rows = [];
      let rowIndex = index + 2;
      while (rowIndex < sourceLines.length) {
        const cells = markdownTableCells(sourceLines[rowIndex]);
        if (!cells.length) break;
        rows.push(cells);
        rowIndex += 1;
      }
      const nativeTable = rows.length && tableCount < 5 && headers.length <= 50 && rows.length <= 100 &&
        rows.every((cells) => cells.length <= headers.length && cells.every((cell) => String(cell).length <= 1_000));
      if (nativeTable) {
        flushText();
        elements.push(buildFeishuNativeTable(headers, rows));
        tableCount += 1;
      } else {
        textLines.push(...sourceLines.slice(index, rowIndex));
      }
      index = rowIndex;
      continue;
    }
    textLines.push(sourceLines[index]);
    index += 1;
  }
  flushText();
  return elements.length ? elements : [{
    tag: "div",
    text: { tag: "lark_md", content: "本次未生成可展示的回复。" },
  }];
}

function buildFeishuNativeTable(headers = [], rows = []) {
  const columns = headers.map((header, index) => ({
    name: `column_${index + 1}`,
    display_name: cleanInlineMarkdown(header).slice(0, 100) || `列 ${index + 1}`,
    data_type: "lark_md",
    width: "auto",
    vertical_align: "top",
    horizontal_align: "left",
  }));
  return {
    tag: "table",
    page_size: Math.min(10, Math.max(1, rows.length)),
    row_height: "124px",
    freeze_first_column: columns.length > 2,
    header_style: {
      text_align: "left",
      text_size: "normal",
      background_style: "grey",
      text_color: "default",
      bold: true,
      lines: 2,
    },
    columns,
    rows: rows.map((cells) => Object.fromEntries(columns.map((column, index) => [
      column.name,
      sanitizeFeishuMarkdownLinks(String(cells[index] || "").trim()),
    ]))),
  };
}

function formatFeishuCardMarkdown(value = "") {
  const sourceLines = String(value || "")
    .replace(/\r\n?/g, "\n")
    .replace(/[\u200B-\u200D\uFEFF]/g, "")
    .split("\n");
  const implicitHeadingIndexes = findImplicitSectionHeadingIndexes(sourceLines);
  const lines = [];

  for (let index = 0; index < sourceLines.length; index += 1) {
    const line = sourceLines[index].trim();
    const headers = markdownTableCells(line);
    const separator = markdownTableCells(sourceLines[index + 1]);
    if (headers.length >= 2 && isMarkdownTableSeparator(separator)) {
      index += 2;
      while (index < sourceLines.length) {
        const cells = markdownTableCells(sourceLines[index]);
        if (!cells.length) break;
        lines.push(...formatMarkdownTableMatrix(headers, cells));
        appendBlankLine(lines);
        index += 1;
      }
      index -= 1;
      appendBlankLine(lines);
      continue;
    }
    if (/^(?:-{3,}|\*{3,}|_{3,})$/.test(line)) {
      appendBlankLine(lines);
      continue;
    }
    if (!line) {
      appendBlankLine(lines);
      continue;
    }
    const heading = line.match(/^\s{0,3}#{1,6}\s+(.+)$/);
    lines.push(heading
      ? `**${sanitizeFeishuMarkdownLinks(heading[1].trim())}**`
      : implicitHeadingIndexes.has(index)
        ? `**${sanitizeFeishuMarkdownLinks(line)}**`
        : sanitizeFeishuMarkdownLinks(line));
  }

  while (lines[0] === "") lines.shift();
  while (lines[lines.length - 1] === "") lines.pop();
  return lines.join("\n").trim() || "我已收到消息，但本次没有生成可展示的回复。";
}

function findImplicitSectionHeadingIndexes(sourceLines = []) {
  const candidates = sourceLines.reduce((indexes, sourceLine, index) => {
    const line = String(sourceLine || "").trim();
    const previous = String(sourceLines[index - 1] || "").trim();
    const next = String(sourceLines[index + 1] || "").trim();
    if (
      line &&
      line.length <= 24 &&
      !previous &&
      next &&
      !/^(?:#{1,6}\s+|[-*+•]\s+|\d+[.、)]\s*|\*\*|__|>|`)/.test(line) &&
      !/[，。！？；：,.!?;:]$/.test(line)
    ) indexes.push(index);
    return indexes;
  }, []);
  return new Set(candidates.length >= 2 ? candidates : []);
}

function splitFeishuCardMarkdown(value = "", maximumLength = 1800) {
  const text = formatFeishuCardMarkdown(value);
  const chunks = [];
  let current = "";

  for (const line of text.split("\n")) {
    const candidate = current ? `${current}\n${line}` : line;
    if (candidate.length <= maximumLength) {
      current = candidate;
      continue;
    }
    if (current) chunks.push(current);
    current = "";
    let remaining = line;
    while (remaining.length > maximumLength) {
      chunks.push(remaining.slice(0, maximumLength));
      remaining = remaining.slice(maximumLength);
    }
    current = remaining;
  }
  if (current) chunks.push(current);
  return chunks.length ? chunks : ["本次未生成可展示的回复。"];
}

function markdownTableCells(line = "") {
  const trimmed = String(line || "").trim();
  if (!trimmed.includes("|")) return [];
  const content = trimmed.replace(/^\|/, "").replace(/\|$/, "");
  const cells = content.split("|").map((cell) => cell.trim());
  return cells.length >= 2 ? cells : [];
}

function isMarkdownTableSeparator(cells = []) {
  return cells.length >= 2 && cells.every((cell) => /^:?-{3,}:?$/.test(cell));
}

function formatMarkdownTableRecord(headers = [], cells = []) {
  const values = cells.map((cell, index) => cleanInlineMarkdown(cell || headers[index] || "")).filter(Boolean);
  if (!values.length) return "";
  const parts = [values[0]];
  for (let index = 1; index < Math.min(headers.length, cells.length); index += 1) {
    const value = cleanInlineMarkdown(cells[index]);
    if (!value) continue;
    const label = cleanInlineMarkdown(headers[index]);
    parts.push(label ? `${label}：${value}` : value);
  }
  return `• ${parts.join("｜")}`;
}

function formatMarkdownTableMatrix(headers = [], cells = []) {
  return headers.slice(0, cells.length).flatMap((header, index) => {
    const label = cleanInlineMarkdown(header);
    const value = sanitizeFeishuMarkdownLinks(cleanInlineMarkdown(cells[index]));
    return label && value ? [`**${label}**：${value}`] : [];
  });
}

function cleanInlineMarkdown(value = "") {
  return String(value || "")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/__([^_]+)__/g, "$1")
    .replace(/`([^`]+)`/g, "$1")
    .trim();
}

function appendBlankLine(lines = []) {
  if (lines.length && lines[lines.length - 1] !== "") lines.push("");
}

function isStructuredReply(text = "") {
  return text.includes("\n") ||
    /^\s*(?:[-*•]|\d+[.、])\s+/m.test(text) ||
    /\[[^\]\n]+\]\([^)]+\)/.test(text);
}

function isSectionHeading(line = "") {
  return /^(?:\d+[.、]|[一二三四五六七八九十]+[、.])\s*\S.{0,36}$/.test(line) || /^\S.{0,30}[：:]$/.test(line);
}

function postLineText(line = "") {
  return String(line || "").replace(/^\s*[-*]\s+/, "• ");
}

function postLineNodes(line = "") {
  const source = String(line || "");
  const heading = source.match(/^\*\*([^*]+)\*\*$/);
  const normalized = postLineText(heading ? heading[1] : source);
  return postInlineNodes(normalized, heading || isSectionHeading(normalized) ? ["bold"] : []);
}

function postInlineNodes(value = "", inheritedStyle = []) {
  const text = String(value || "");
  const pattern = /(\*\*|__)(.+?)\1|\[([^\]\n]+)\]\(([^)\s]+)\)/g;
  const nodes = [];
  let cursor = 0;
  for (const match of text.matchAll(pattern)) {
    if (match.index > cursor) nodes.push(postTextNode(text.slice(cursor, match.index), inheritedStyle));
    if (match[2] !== undefined) {
      nodes.push(...postInlineNodes(match[2], [...new Set([...inheritedStyle, "bold"])]));
    } else {
      const href = safeFeishuLinkUrl(match[4]);
      nodes.push(href
        ? { tag: "a", text: match[3], href }
        : postTextNode(match[3], inheritedStyle));
    }
    cursor = match.index + match[0].length;
  }
  if (cursor < text.length) nodes.push(postTextNode(text.slice(cursor), inheritedStyle));
  return nodes.filter((node) => node.text);
}

function postTextNode(text, style = []) {
  return { tag: "text", text, ...(style.length ? { style } : {}) };
}

function sanitizeFeishuMarkdownLinks(value = "") {
  return String(value || "").replace(/\[([^\]\n]+)\]\(([^)\s]+)\)/g, (_match, label, target) => {
    const href = safeFeishuLinkUrl(target);
    return href ? `[${label}](${href})` : label;
  });
}

function safeFeishuLinkUrl(value = "") {
  try {
    const url = new URL(String(value || "").trim());
    if (!new Set(["http:", "https:"]).has(url.protocol) || url.username || url.password || url.href.length > 2_048) return "";
    return url.href;
  } catch {
    return "";
  }
}

function enrichFeishuReplyWithToolPresentation(text = "", toolCalls = []) {
  let result = String(text || "");
  const links = collectToolPresentationLinks(toolCalls);
  for (const { label, url } of links) {
    const renderedLink = visiblePresentationLink(label, url);
    const markdownPattern = new RegExp(`\\[${escapeRegExp(label)}\\]\\([^)]+\\)`);
    if (markdownPattern.test(result)) {
      result = result.replace(markdownPattern, renderedLink);
      continue;
    }
    const placeholderPattern = new RegExp(`${escapeRegExp(label)}\\s*[：:]\\s*(?:${escapeRegExp(label)}|链接由 Channel 安全投影)`);
    if (placeholderPattern.test(result)) {
      result = result.replace(placeholderPattern, renderedLink);
      continue;
    }
    const labelPattern = new RegExp(escapeRegExp(label));
    if (labelPattern.test(result)) {
      result = result.replace(labelPattern, renderedLink);
    }
  }
  result = normalizeTrainingVideoPresentation(result, links);
  return result
    .replace(/（\s*链接由 Channel 安全投影\s*）/g, "")
    .trim();
}

function normalizeTrainingVideoPresentation(text = "", links = []) {
  const video = links.find((link) => cleanInlineMarkdown(link?.label) === "培训视频" && safeFeishuLinkUrl(link?.url));
  if (!video) return text;
  const line = visiblePresentationLink(video.label, video.url);
  let result = String(text || "");
  const lines = result.replace(/\r\n?/g, "\n").split("\n");
  const insertAfter = lines.findIndex((item) => /^(?:#{1,6}\s*)?考核说明\s*$/.test(cleanInlineMarkdown(item).replace(/^#+\s*/, "")));
  if (insertAfter < 0) return result;
  result = removeTrainingVideoRelatedLinks(result, video.url);
  if (new RegExp(`培训视频\\s*[：:]\\s*${escapeRegExp(video.url)}`).test(result)) return result;
  const normalizedLines = result.replace(/\r\n?/g, "\n").split("\n");
  const normalizedInsertAfter = normalizedLines.findIndex((item) => /^(?:#{1,6}\s*)?考核说明\s*$/.test(cleanInlineMarkdown(item).replace(/^#+\s*/, "")));
  normalizedLines.splice(normalizedInsertAfter + 1, 0, line);
  return normalizedLines.join("\n");
}

function removeTrainingVideoRelatedLinks(text = "", url = "") {
  const lines = String(text || "").replace(/\r\n?/g, "\n").split("\n");
  const output = [];
  for (let index = 0; index < lines.length; index += 1) {
    const normalized = cleanInlineMarkdown(lines[index]).replace(/^#+\s*/, "").trim();
    if (normalized !== "相关链接") {
      output.push(lines[index]);
      continue;
    }
    const block = [];
    let cursor = index + 1;
    while (cursor < lines.length && String(lines[cursor] || "").trim()) {
      block.push(lines[cursor]);
      cursor += 1;
    }
    const remaining = block.filter((item) => !isTrainingVideoLinkLine(item, url));
    if (remaining.length) {
      output.push(lines[index], ...remaining);
    }
    index = cursor - 1;
  }
  return output.join("\n").replace(/\n{3,}/g, "\n\n");
}

function isTrainingVideoLinkLine(line = "", url = "") {
  const text = cleanInlineMarkdown(line).replace(/^\s*[-*]\s+/, "").trim();
  if (!/^培训视频(?:\s*[：:]|$)/.test(text)) return false;
  return !url || text.includes(url) || text === "培训视频";
}

function collectToolPresentationLinks(toolCalls = []) {
  const links = [];
  const seen = new Set();
  const add = (label, target) => {
    const url = safeFeishuLinkUrl(target);
    const safeLabel = cleanInlineMarkdown(label).slice(0, 240);
    const key = `${safeLabel}\n${url}`;
    if (!safeLabel || !url || seen.has(key) || links.length >= 12) return;
    seen.add(key);
    links.push({ label: safeLabel, url });
  };
  const visit = (value, parent = null, key = "", depth = 0) => {
    if (depth > 12 || value === null || value === undefined) return;
    if (typeof value === "string") {
      for (const match of value.matchAll(/\[([^\]\n]+)\]\(([^)\s]+)\)/g)) add(match[1], match[2]);
      if (/(?:url|link|href|uri)$/i.test(key) && !/(?:auth|token|secret|credential|state|code|callback|webhook)/i.test(key)) {
        const label = parent && typeof parent === "object"
          ? ["courseTitle", "meetingTitle", "title", "label", "name"].map((field) => parent[field]).find((item) => typeof item === "string")
          : "";
        add(label || "打开链接", value);
      }
      return;
    }
    if (Array.isArray(value)) {
      for (const item of value.slice(0, 200)) visit(item, null, "", depth + 1);
      return;
    }
    if (typeof value !== "object") return;
    if (value.contractVersion === "channel-presentation-evidence.v1" && Array.isArray(value.links)) {
      for (const link of value.links.slice(0, 12)) add(link?.label, link?.url);
      return;
    }
    if ((typeof value.toolId === "string" || typeof value.operationId === "string") &&
        (Object.hasOwn(value, "data") || Object.hasOwn(value, "status"))) {
      if (value.channelPresentationEvidence) visit(value.channelPresentationEvidence, value, "channelPresentationEvidence", depth + 1);
      return;
    }
    for (const [childKey, childValue] of Object.entries(value)) {
      if (/(?:authorization|bearer|token|secret|password|cookie|api[-_]?key|credential)/i.test(childKey)) continue;
      visit(childValue, value, childKey, depth + 1);
    }
  };
  for (const call of Array.isArray(toolCalls) ? toolCalls : []) visit(call?.result, null, "", 0);
  return links;
}

function escapeRegExp(value = "") {
  return String(value || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function visiblePresentationLink(label = "", url = "") {
  if (cleanInlineMarkdown(label) === "培训视频") return `培训视频：${url}`;
  return `[${label}](${url})（${url}）`;
}

function feishuCardMention(userId = "") {
  const value = String(userId || "").trim();
  return /^[A-Za-z0-9_-]{1,128}$/.test(value) ? `<at id=${value}></at>` : "";
}

function escapeCardMarkdown(value = "") {
  return String(value || "").replace(/([\\`*_{}\[\]()#+.!|>-])/g, "\\$1");
}

export {
  buildFeishuCardContentElements,
  buildFeishuMarkdownCard,
  buildFeishuReplyMessage,
  enrichFeishuReplyWithToolPresentation,
  formatFeishuCardMarkdown,
  formatFeishuChannelText,
  splitFeishuCardMarkdown,
};
