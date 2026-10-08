import { LinkSimple } from "@phosphor-icons/react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkCjkFriendly from "remark-cjk-friendly";

function safeExternalUrl(url) {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "http:" || parsed.protocol === "https:" ? parsed.href : "";
  } catch {
    return "";
  }
}

export function MarkdownMessage({ content, onOpenLink }) {
  return (
    <div className="message-copy message-markdown">
      <ReactMarkdown
        remarkPlugins={[remarkGfm, remarkCjkFriendly]}
        skipHtml
        urlTransform={safeExternalUrl}
        components={{
          a: ({ href, children }) => href ? (
            <button type="button" className="inline-link" onClick={() => onOpenLink(href)}>
              <LinkSimple size={13} aria-hidden="true" />
              <span>{children}</span>
            </button>
          ) : <span>{children}</span>,
          table: ({ children }) => (
            <div className="message-table-scroll">
              <table>{children}</table>
            </div>
          ),
          img: ({ alt }) => alt ? <span className="message-image-label">[图片：{alt}]</span> : null,
        }}
      >
        {String(content || "")}
      </ReactMarkdown>
    </div>
  );
}
