import { Bot, CheckCircle2, CircleSlash, KeyRound, ListChecks, LoaderCircle, MessageSquareText, Search, Send, ShieldCheck, Sparkles, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { aiProviderRoutes, digitalEmployees, permissionScopeLabels } from "../data/catalog";
import { reduceAssistantStreamEvent } from "../lib/enterpriseAssistantProgress.js";

const ASSISTANT_EMPLOYEE_ID = "enterprise-ai-copilot";

const quickActions = [
  { label: "索引", prompt: "请按我当前权限简要说明这个系统主要模块，以及我现在最可能要去哪里。", icon: Search },
  { label: "权限", prompt: "请检查我当前用户权限边界，列出可做、需要申请、禁止的动作。", icon: ShieldCheck },
  { label: "API", prompt: "请给我当前权限范围内可用的 API 使用建议，包含调用前门禁和不能提交的字段。", icon: KeyRound },
  { label: "任务", prompt: "请帮我把一个企业数字员工任务拆成权限检查、资料准备、API 草案和人工门禁。", icon: ListChecks },
];

function assistantEmployee() {
  return digitalEmployees.find((employee) => employee.id === ASSISTANT_EMPLOYEE_ID) || digitalEmployees.find((employee) => employee.id === "workforce-admin") || {};
}

function assistantProviderRoute(employee) {
  const routeId = employee.modelBinding?.providerRouteId || employee.runtimeBinding?.providerRouteId || employee.runtimeBinding?.preferredProviderRouteId || employee.modelBinding?.preferredProviderRouteId || "codex-digital-office-route";
  return aiProviderRoutes.find((route) => route.id === routeId) || { id: routeId, name: "数字化中心 Codex" };
}

function runtimeAdapterLabel(adapter) {
  if (adapter === "codex_cli") return "Codex CLI";
  if (adapter === "responses_api") return "Responses API";
  if (String(adapter || "").includes("codex_cli_fallback")) return "API + CLI fallback";
  return "Auto runtime";
}

function reasoningLevelLabel(binding = {}) {
  if (binding.modelLevelLabel) return binding.modelLevelLabel;
  return {
    low: "低",
    medium: "中",
    high: "高",
    xhigh: "极高",
    max: "最高",
  }[binding.modelLevelId] || "未配置";
}

function makeMessage(role, payload = {}) {
  return {
    id: `${role}-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    role,
    content: "",
    steps: [],
    thought: "",
    status: "idle",
    meta: null,
    error: "",
    ...payload,
  };
}

function compactHistory(messages) {
  return messages
    .filter((message) => message.content && ["user", "assistant"].includes(message.role))
    .slice(-8)
    .map((message) => ({ role: message.role, content: message.content.slice(0, 1800) }));
}

function parseSseEvents(buffer) {
  const parts = buffer.split("\n\n");
  const rest = parts.pop() || "";
  const events = parts
    .map((part) => {
      const lines = part.split("\n");
      const event = lines.find((line) => line.startsWith("event:"))?.slice(6).trim() || "message";
      const data = lines
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trim())
        .join("\n");
      if (!data) return null;
      try {
        return { event, data: JSON.parse(data) };
      } catch {
        return null;
      }
    })
    .filter(Boolean);
  return { events, rest };
}

function isSafeLink(url) {
  return /^(https?:|mailto:)/i.test(url);
}

function renderInlineMarkdown(text, baseKey = "inline") {
  const nodes = [];
  let cursor = 0;

  function pushText(value) {
    if (value) nodes.push(value);
  }

  while (cursor < text.length) {
    if (text[cursor] === "`") {
      const end = text.indexOf("`", cursor + 1);
      if (end > cursor + 1) {
        nodes.push(<code key={`${baseKey}-code-${cursor}`}>{text.slice(cursor + 1, end)}</code>);
        cursor = end + 1;
        continue;
      }
    }

    if (text.startsWith("**", cursor)) {
      const end = text.indexOf("**", cursor + 2);
      if (end > cursor + 2) {
        nodes.push(
          <strong key={`${baseKey}-strong-${cursor}`}>
            {renderInlineMarkdown(text.slice(cursor + 2, end), `${baseKey}-strong-${cursor}`)}
          </strong>,
        );
        cursor = end + 2;
        continue;
      }
    }

    if (text[cursor] === "*" && text[cursor + 1] !== "*") {
      const end = text.indexOf("*", cursor + 1);
      if (end > cursor + 1 && text[end + 1] !== "*") {
        nodes.push(
          <em key={`${baseKey}-em-${cursor}`}>
            {renderInlineMarkdown(text.slice(cursor + 1, end), `${baseKey}-em-${cursor}`)}
          </em>,
        );
        cursor = end + 1;
        continue;
      }
    }

    if (text[cursor] === "[") {
      const labelEnd = text.indexOf("]", cursor + 1);
      const hrefStart = labelEnd >= 0 ? text.indexOf("(", labelEnd) : -1;
      const hrefEnd = hrefStart >= 0 ? text.indexOf(")", hrefStart) : -1;
      if (labelEnd > cursor + 1 && hrefStart === labelEnd + 1 && hrefEnd > hrefStart + 1) {
        const label = text.slice(cursor + 1, labelEnd);
        const href = text.slice(hrefStart + 1, hrefEnd).trim();
        if (isSafeLink(href)) {
          nodes.push(
            <a key={`${baseKey}-link-${cursor}`} href={href} target="_blank" rel="noreferrer">
              {renderInlineMarkdown(label, `${baseKey}-link-${cursor}`)}
            </a>,
          );
          cursor = hrefEnd + 1;
          continue;
        }
      }
    }

    const nextSpecial = ["`", "*", "["]
      .map((token) => text.indexOf(token, cursor + 1))
      .filter((index) => index !== -1)
      .sort((a, b) => a - b)[0];
    const nextCursor = nextSpecial || text.length;
    pushText(text.slice(cursor, nextCursor));
    cursor = nextCursor;
  }

  return nodes;
}

function renderInlineWithBreaks(text, baseKey) {
  return text.split("\n").flatMap((line, index, lines) => {
    const content = renderInlineMarkdown(line, `${baseKey}-line-${index}`);
    if (index === lines.length - 1) return content;
    return [...content, <br key={`${baseKey}-br-${index}`} />];
  });
}

const structuredFieldLabels = {
  scopeSummary: "权限范围",
  allowedActions: "可以做",
  blockedActions: "当前不能做",
  nextSteps: "下一步",
  requiredInputs: "需要补充",
  missingInputs: "需要补充",
  reviewGates: "评审门禁",
  riskNotes: "风险提醒",
  apiDraft: "API 草案",
  taskDraft: "任务草案",
};

function structuredFieldLabel(key) {
  if (structuredFieldLabels[key]) return structuredFieldLabels[key];
  return key
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function stringifyStructuredValue(value) {
  if (value === null || value === undefined) return "";
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) return value.map(stringifyStructuredValue).filter(Boolean).join("；");
  if (typeof value === "object") {
    return Object.entries(value)
      .map(([key, childValue]) => {
        const text = stringifyStructuredValue(childValue);
        return text ? `${structuredFieldLabel(key)}：${text}` : "";
      })
      .filter(Boolean)
      .join("；");
  }
  return "";
}

function structuredItems(value) {
  if (Array.isArray(value)) return value.map(stringifyStructuredValue).filter(Boolean);
  if (value && typeof value === "object") {
    return Object.entries(value)
      .map(([key, childValue]) => {
        const text = stringifyStructuredValue(childValue);
        return text ? `${structuredFieldLabel(key)}：${text}` : "";
      })
      .filter(Boolean);
  }
  const text = stringifyStructuredValue(value);
  return text ? [text] : [];
}

function parseStructuredAssistantContent(content) {
  const trimmed = content.trim();
  if (!trimmed.startsWith("{") || !trimmed.endsWith("}")) return null;
  try {
    const parsed = JSON.parse(trimmed);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    const sections = Object.entries(parsed)
      .map(([key, value]) => ({
        key,
        label: structuredFieldLabel(key),
        items: structuredItems(value),
      }))
      .filter((section) => section.items.length);
    return sections.length ? sections : null;
  } catch {
    return null;
  }
}

function parseMarkdownBlocks(content) {
  const lines = content.replace(/\r\n?/g, "\n").split("\n");
  const blocks = [];
  let index = 0;

  while (index < lines.length) {
    const line = lines[index];

    if (!line.trim()) {
      index += 1;
      continue;
    }

    const fenceMatch = line.match(/^```(\S*)\s*$/);
    if (fenceMatch) {
      const codeLines = [];
      index += 1;
      while (index < lines.length && !lines[index].startsWith("```")) {
        codeLines.push(lines[index]);
        index += 1;
      }
      if (index < lines.length) index += 1;
      blocks.push({ type: "code", language: fenceMatch[1] || "", text: codeLines.join("\n") });
      continue;
    }

    const headingMatch = line.match(/^(#{1,3})\s+(.+)$/);
    if (headingMatch) {
      blocks.push({ type: "heading", level: headingMatch[1].length, text: headingMatch[2].trim() });
      index += 1;
      continue;
    }

    if (/^\s*[-*]\s+/.test(line)) {
      const items = [];
      while (index < lines.length && /^\s*[-*]\s+/.test(lines[index])) {
        items.push(lines[index].replace(/^\s*[-*]\s+/, ""));
        index += 1;
      }
      blocks.push({ type: "list", ordered: false, items });
      continue;
    }

    if (/^\s*\d+[.)]\s+/.test(line)) {
      const items = [];
      while (index < lines.length && /^\s*\d+[.)]\s+/.test(lines[index])) {
        items.push(lines[index].replace(/^\s*\d+[.)]\s+/, ""));
        index += 1;
      }
      blocks.push({ type: "list", ordered: true, items });
      continue;
    }

    if (/^\s*>\s?/.test(line)) {
      const quoteLines = [];
      while (index < lines.length && /^\s*>\s?/.test(lines[index])) {
        quoteLines.push(lines[index].replace(/^\s*>\s?/, ""));
        index += 1;
      }
      blocks.push({ type: "quote", text: quoteLines.join("\n") });
      continue;
    }

    const paragraph = [line];
    index += 1;
    while (
      index < lines.length &&
      lines[index].trim() &&
      !lines[index].startsWith("```") &&
      !/^(#{1,3})\s+/.test(lines[index]) &&
      !/^\s*[-*]\s+/.test(lines[index]) &&
      !/^\s*\d+[.)]\s+/.test(lines[index]) &&
      !/^\s*>\s?/.test(lines[index])
    ) {
      paragraph.push(lines[index]);
      index += 1;
    }
    blocks.push({ type: "paragraph", text: paragraph.join("\n") });
  }

  return blocks;
}

function AssistantRichText({ content }) {
  const structuredSections = parseStructuredAssistantContent(content);
  if (structuredSections) {
    return (
      <div className="assistant-rich-text assistant-structured-reply">
        {structuredSections.map((section, sectionIndex) => (
          <section key={section.key} className={sectionIndex === 0 ? "assistant-structured-section is-summary" : "assistant-structured-section"}>
            <h4>{section.label}</h4>
            {section.items.length === 1 ? (
              <p>{renderInlineWithBreaks(section.items[0], `structured-${section.key}`)}</p>
            ) : (
              <ul>
                {section.items.map((item, itemIndex) => (
                  <li key={`${section.key}-${itemIndex}`}>{renderInlineMarkdown(item, `structured-${section.key}-${itemIndex}`)}</li>
                ))}
              </ul>
            )}
          </section>
        ))}
      </div>
    );
  }

  const blocks = parseMarkdownBlocks(content);

  return (
    <div className="assistant-rich-text">
      {blocks.map((block, index) => {
        const key = `assistant-rich-${index}`;
        if (block.type === "code") {
          return (
            <pre key={key}>
              <code>{block.text}</code>
            </pre>
          );
        }
        if (block.type === "heading") {
          const HeadingTag = block.level === 1 ? "h3" : block.level === 2 ? "h4" : "h5";
          return <HeadingTag key={key}>{renderInlineMarkdown(block.text, key)}</HeadingTag>;
        }
        if (block.type === "list") {
          const ListTag = block.ordered ? "ol" : "ul";
          return (
            <ListTag key={key}>
              {block.items.map((item, itemIndex) => (
                <li key={`${key}-item-${itemIndex}`}>{renderInlineMarkdown(item, `${key}-item-${itemIndex}`)}</li>
              ))}
            </ListTag>
          );
        }
        if (block.type === "quote") {
          return <blockquote key={key}>{renderInlineWithBreaks(block.text, key)}</blockquote>;
        }
        return <p key={key}>{renderInlineWithBreaks(block.text, key)}</p>;
      })}
    </div>
  );
}

export default function EnterpriseAssistant({ session, activeViewLabel, onRuntimeVerified, employee: configuredEmployee = null }) {
  const fallbackEmployee = useMemo(() => assistantEmployee(), []);
  const employee = configuredEmployee || fallbackEmployee;
  const overlayRoot = typeof document === "undefined" ? null : document.querySelector(".console-shell");
  const providerRoute = useMemo(() => assistantProviderRoute(employee), [employee]);
  const listRef = useRef(null);
  const runtimeMetaRef = useRef(null);
  const [isOpen, setIsOpen] = useState(false);
  const [inputText, setInputText] = useState("");
  const [messages, setMessages] = useState(() => [
    makeMessage("assistant", {
      content: "我在。直接告诉我任务，我会先确认权限和资源池，再用模型流式回复。",
      status: "done",
    }),
  ]);

  useEffect(() => {
    const node = listRef.current;
    if (node) node.scrollTop = node.scrollHeight;
  }, [messages, isOpen]);

  async function sendPrompt(promptText) {
    const text = promptText.trim();
    if (!text) return;
    const userMessage = makeMessage("user", { content: text, status: "done" });
    const assistantMessage = makeMessage("assistant", {
      status: "streaming",
      steps: [{ id: "queued", status: "running", label: "提交到企业 AI 入口" }],
    });

    setMessages((current) => [...current, userMessage, assistantMessage]);
    setInputText("");
    setIsOpen(true);

    const history = compactHistory(messages);

    try {
      const employeeId = encodeURIComponent(employee.id || ASSISTANT_EMPLOYEE_ID);
      const response = await fetch(`/api/digital-employees/${employeeId}/chat`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          message: text,
          requestId: assistantMessage.id,
          activeViewLabel,
          messages: history,
        }),
      });

      if (!response.ok || !response.body) {
        const data = await response.json().catch(() => ({}));
        throw new Error(data.message || data.error || "企业 AI 助理服务不可用");
      }

      applyStreamEvent(assistantMessage.id, "accepted", {});
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const parsed = parseSseEvents(buffer);
        buffer = parsed.rest;
        for (const item of parsed.events) {
          applyStreamEvent(assistantMessage.id, item.event, item.data);
        }
      }
      applyStreamEvent(assistantMessage.id, "end", {});
    } catch (error) {
      applyStreamEvent(assistantMessage.id, "error", {
        message: error?.message || "企业 AI 助理服务不可用",
      });
    }
  }

  function applyStreamEvent(messageId, event, data) {
    if (event === "meta") {
      runtimeMetaRef.current = data;
    }
    if (event === "done" && data.ok !== false && typeof onRuntimeVerified === "function") {
      const meta = runtimeMetaRef.current || {};
      onRuntimeVerified({
        employeeId: employee.id || ASSISTANT_EMPLOYEE_ID,
        healthStatus: "passed",
        modelStatus: "passed",
        runtimeStatus: "passed",
        statusSource: "real_conversation",
        evidenceType: "management_console_chat",
        evidenceLabel: "管理台主对话已成功",
        testedAt: new Date().toISOString(),
        model: meta.model || employee.modelBinding?.model,
        reasoningEffort: meta.reasoningEffort || employee.modelBinding?.modelLevelLabel,
        runtimeAdapter: meta.runtimeAdapter || employee.runtimeBinding?.runtimeAdapter,
        ...(data.runtimeEvent ? { runtimeEvent: data.runtimeEvent } : {}),
        ...(data.runtimeUsage ? { runtimeUsage: data.runtimeUsage } : {}),
      });
    }
    setMessages((current) =>
      current.map((message) => {
        if (message.id !== messageId) return message;
        return reduceAssistantStreamEvent(message, event, data);
      }),
    );
  }

  function submitMessage(event) {
    event.preventDefault();
    sendPrompt(inputText);
  }

  if (!employee?.id) return null;

  return (
    <>
      <button
        className={isOpen ? "enterprise-assistant-toggle is-open" : "enterprise-assistant-toggle"}
        type="button"
        aria-label={isOpen ? "关闭企业协同 AI 助理" : "打开企业协同 AI 助理"}
        aria-controls="enterprise-assistant-panel"
        aria-expanded={isOpen}
        onClick={() => setIsOpen((current) => !current)}
      >
        <span className="assistant-toggle-icon" aria-hidden="true">
          <Bot size={19} />
        </span>
        <span>
          <strong>AI 助理</strong>
          <small>{employee.modelBinding?.model || "gpt-5.5"} · {reasoningLevelLabel(employee.modelBinding)}</small>
        </span>
      </button>

      {isOpen && overlayRoot
        ? createPortal(
            <section className="enterprise-assistant-panel" id="enterprise-assistant-panel" aria-label="企业协同 AI 助理">
              <header className="assistant-panel-head">
            <span className="assistant-panel-mark" aria-hidden="true">
              <Sparkles size={18} />
            </span>
            <div>
              <p className="eyebrow">Enterprise AI Worker</p>
              <h2>{employee.name || "企业协同 AI 助理"}</h2>
              <small>
                {session?.name || "未登录"} · {activeViewLabel} · {permissionScopeLabels[employee.permissionScope] || "权限感知"}
              </small>
            </div>
            <button className="assistant-close" type="button" aria-label="关闭 AI 助理" onClick={() => setIsOpen(false)}>
              <X size={17} />
            </button>
              </header>

              <div className="assistant-governance-strip" aria-label="AI 助理治理边界">
            <span><ShieldCheck size={13} />系统级数字员工</span>
            <span><KeyRound size={13} />{providerRoute.name || providerRoute.id}</span>
            <span><Bot size={13} />{runtimeAdapterLabel(employee.runtimeBinding?.runtimeAdapter)}</span>
            <span><CircleSlash size={13} />只读 + 草案</span>
              </div>

              <div className="assistant-quick-actions compact" aria-label="AI 助理快捷动作">
            {quickActions.map((action) => {
              const Icon = action.icon;
              return (
                <button key={action.label} type="button" onClick={() => sendPrompt(action.prompt)}>
                  <Icon size={14} />
                  {action.label}
                </button>
              );
            })}
              </div>

              <div className="assistant-message-list is-primary" ref={listRef}>
            {messages.map((message) => (
              <AssistantMessage key={message.id} message={message} />
            ))}
              </div>

              <form className="assistant-input-row primary" onSubmit={submitMessage}>
            <label>
              <span>主对话</span>
              <textarea
                value={inputText}
                onChange={(event) => setInputText(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key !== "Enter" || event.shiftKey) return;
                  if (event.nativeEvent?.isComposing || event.isComposing || event.keyCode === 229) return;
                  event.preventDefault();
                  if (event.repeat) return;
                  sendPrompt(inputText);
                }}
                placeholder="说出你要做的任务，例如：帮我申请 HR 能力调用并说明门禁"
              />
            </label>
            <button type="submit" aria-label="发送给 AI 助理">
              <Send size={16} />
            </button>
              </form>
            </section>,
          overlayRoot,
        )
        : null}
    </>
  );
}

function AssistantMessage({ message }) {
  const isAssistant = message.role === "assistant";
  return (
    <article className={`assistant-message ${message.role} ${message.status === "streaming" ? "is-streaming" : ""}`}>
      <div className="assistant-message-title">
        {isAssistant ? <Bot size={15} /> : <MessageSquareText size={15} />}
        <strong>{isAssistant ? "企业协同 AI 助理" : "你"}</strong>
        {message.status === "streaming" ? <LoaderCircle className="assistant-spin" size={14} /> : null}
      </div>
      {message.steps?.length ? <AssistantSteps steps={message.steps} thought={message.thought} /> : null}
      {message.content ? <AssistantRichText content={message.content} /> : null}
      {message.error ? <p className="assistant-error">{message.error}</p> : null}
      {message.meta ? <AssistantMeta meta={message.meta} /> : null}
    </article>
  );
}

function lastStepWithStatus(steps, status) {
  for (let index = steps.length - 1; index >= 0; index -= 1) {
    if (steps[index].status === status) return steps[index];
  }
  return null;
}

function selectedAssistantStep(steps) {
  return lastStepWithStatus(steps, "blocked") || lastStepWithStatus(steps, "running") || lastStepWithStatus(steps, "done") || steps[steps.length - 1] || {};
}

function stepStatusIcon(status, size = 13) {
  if (status === "done") return <CheckCircle2 size={size} />;
  if (status === "blocked") return <CircleSlash size={size} />;
  return <LoaderCircle size={size} />;
}

function assistantStepSummary(steps) {
  const doneCount = steps.filter((step) => step.status === "done").length;
  const blockedCount = steps.filter((step) => step.status === "blocked").length;
  const runningCount = steps.filter((step) => step.status === "running").length;
  if (blockedCount) return `${blockedCount} 项阻断`;
  if (runningCount) return `${doneCount}/${steps.length} 完成`;
  return `${doneCount}/${steps.length} 完成`;
}

function AssistantSteps({ steps, thought }) {
  const currentStep = selectedAssistantStep(steps);
  const summary = assistantStepSummary(steps);

  return (
    <div className={`assistant-thinking is-${currentStep.status || "idle"}`}>
      <div className="assistant-thinking-current">
        <span className={`assistant-step-mark ${currentStep.status || "idle"}`} aria-hidden="true">
          {stepStatusIcon(currentStep.status, 14)}
        </span>
        <span className="assistant-thinking-copy">
          <strong>{currentStep.label || "企业 AI 助理处理中"}</strong>
          {thought ? <small>{thought}</small> : null}
        </span>
        <span className="assistant-step-count">{summary}</span>
      </div>
      {steps.length > 1 ? (
        <details className="assistant-step-details">
          <summary>执行记录</summary>
          <div className="assistant-step-list">
            {steps.map((step) => (
              <span key={step.id} className={`assistant-step-row ${step.status}`}>
                {stepStatusIcon(step.status)}
                {step.label}
              </span>
            ))}
          </div>
        </details>
      ) : (
        <span className={`assistant-step-row ${currentStep.status || "idle"}`}>
          {stepStatusIcon(currentStep.status)}
          {currentStep.label}
        </span>
      )}
    </div>
  );
}

function AssistantMeta({ meta }) {
  const providerConnection = meta.providerConnection || {};
  const leaseLabel = meta.credentialVisibleToBrowser ? "credential visible" : meta.leaseRef ? "server-side lease" : "lease pending";
  const metaParts = [
    meta.model || "model",
    meta.reasoningEffort || "medium",
    providerConnection.name || providerConnection.providerRouteId || "model route",
    runtimeAdapterLabel(meta.runtimeAdapter),
    leaseLabel,
  ];

  return (
    <div className="assistant-meta" aria-label="AI 助理运行摘要">
      <span className="assistant-meta-label">运行</span>
      <span className="assistant-meta-text">{metaParts.join(" · ")}</span>
    </div>
  );
}
