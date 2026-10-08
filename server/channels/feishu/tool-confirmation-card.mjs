const ACTION_KIND = "tool_call_confirmation_decision";
const ACTION_PREFIX = "tool_confirmation_";

function buildFeishuToolConfirmationCard(request = {}, employeeId = "") {
  if (request.contractVersion !== "tool-call-confirmation.v1" || !request.id || !employeeId) return null;
  return {
    schema: "2.0",
    config: { wide_screen_mode: true, update_multi: true },
    header: {
      template: "orange",
      title: { tag: "plain_text", content: "确认提交" },
      subtitle: { tag: "plain_text", content: "请确认本次业务信息" },
    },
    body: {
      elements: [
        { tag: "markdown", content: confirmationSummary(request) },
        { tag: "hr" },
        {
          tag: "button",
          name: `${ACTION_PREFIX}approve_${shortId(request.id)}`,
          value: actionValue(request, employeeId, "approved"),
          text: { tag: "plain_text", content: "确认提交" },
          type: "primary",
        },
        {
          tag: "button",
          name: `${ACTION_PREFIX}decline_${shortId(request.id)}`,
          value: actionValue(request, employeeId, "declined"),
          text: { tag: "plain_text", content: "取消" },
          type: "default",
        },
      ],
    },
  };
}

function parseFeishuToolConfirmationAction(event = {}, expectedEmployeeId = "") {
  const payload = event.event && typeof event.event === "object" ? event.event : event;
  const value = parseActionValue(payload.action?.value);
  const actionName = String(payload.action?.name || "");
  const matched = value?.kind === ACTION_KIND || actionName.startsWith(ACTION_PREFIX);
  if (!matched) return { matched: false };
  const confirmationId = String(value?.confirmationId || "").trim();
  const employeeId = String(value?.employeeId || "").trim();
  const decision = value?.decision === "approved" ? "approved" : value?.decision === "declined" ? "declined" : "";
  const operatorId = String(payload.operator?.open_id || payload.operator?.user_id || "").trim();
  const chatId = String(payload.context?.open_chat_id || payload.open_chat_id || "").trim();
  const messageId = String(payload.context?.open_message_id || payload.open_message_id || "").trim();
  if (!confirmationId || !decision || !operatorId || !chatId || !messageId || employeeId !== String(expectedEmployeeId || "").trim()) {
    return { matched: true, ok: false, error: "tool_confirmation_callback_invalid" };
  }
  return { matched: true, ok: true, chatId, confirmationId, decision, employeeId, messageId, operatorId };
}

function buildFeishuToolConfirmationDecisionCard(request = {}, decision = "approved") {
  const approved = decision === "approved";
  return {
    schema: "2.0",
    config: { wide_screen_mode: true, update_multi: true },
    header: {
      template: approved ? "turquoise" : "grey",
      title: { tag: "plain_text", content: approved ? "已确认，正在执行" : "本次操作已取消" },
      subtitle: { tag: "plain_text", content: approved ? "系统只会执行本卡绑定的准确参数" : "未执行外部写操作" },
    },
    body: { elements: [{ tag: "markdown", content: `**操作：** ${escapeMarkdown(request.displayName || request.operationId || "受治理 Tool 操作")}` }] },
  };
}

function confirmationSummary(request) {
  const businessSummary = request.argumentSummary?.businessSummary;
  if (businessSummary && Array.isArray(businessSummary.items)) {
    const rows = businessSummary.items.slice(0, 8).map((item) => (
      `**${escapeMarkdown(item?.label || "信息")}：** ${escapeMarkdown(item?.value || "-")}`
    ));
    if (businessSummary.effect) rows.push(`**确认后：** ${escapeMarkdown(businessSummary.effect)}`);
    if (request.expiresAt) rows.push(`**有效期至：** ${escapeMarkdown(localTimestamp(request.expiresAt))}`);
    return rows.filter(Boolean).join("\n\n").slice(0, 4_000);
  }
  const rows = [
    `**操作：** ${escapeMarkdown(request.displayName || request.operationId)}`,
    request.writebackBoundary ? `**写回边界：** ${escapeMarkdown(request.writebackBoundary)}` : "",
    request.expiresAt ? `**确认有效期至：** ${escapeMarkdown(localTimestamp(request.expiresAt))}` : "",
    `**参数摘要：**\n\`\`\`json\n${safeJson(request.argumentSummary)}\n\`\`\``,
  ].filter(Boolean);
  return rows.join("\n\n").slice(0, 4_000);
}

function actionValue(request, employeeId, decision) {
  return { kind: ACTION_KIND, confirmationId: request.id, employeeId, decision };
}

function safeJson(value) {
  try { return JSON.stringify(value ?? {}, null, 2).slice(0, 2_500); } catch { return "{}"; }
}

function localTimestamp(value) {
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toLocaleString("zh-CN", { hour12: false, timeZone: "Asia/Shanghai" }) : "";
}

function escapeMarkdown(value = "") { return String(value || "").replace(/[\r\n\0]/g, " ").replace(/([*_`])/g, "\\$1").slice(0, 500); }
function shortId(value = "") { return String(value || "").replace(/[^A-Za-z0-9_-]/g, "").slice(-24) || "request"; }
function parseActionValue(value) {
  if (value && typeof value === "object" && !Array.isArray(value)) return value;
  if (typeof value !== "string") return null;
  try { const parsed = JSON.parse(value); return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null; } catch { return null; }
}

export {
  ACTION_KIND,
  buildFeishuToolConfirmationCard,
  buildFeishuToolConfirmationDecisionCard,
  parseFeishuToolConfirmationAction,
};
