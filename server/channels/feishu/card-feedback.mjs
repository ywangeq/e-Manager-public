import { cleanShortText, cleanText, digestValue } from "../../feishu-integration-support.mjs";
import { buildFeishuCardContentElements } from "./reply-presentation.mjs";

const CARD_FEEDBACK_CONTRACT_VERSION = "feishu-answer-feedback.v1";
const CARD_FEEDBACK_ACTION_KIND = "employee_answer_feedback";
const LEGACY_CARD_FEEDBACK_ACTION_KIND = "algorithm_answer_feedback";
const FEEDBACK_RATINGS = new Set(["helpful", "not_helpful"]);
const REASON_CODES = new Set(["not_resolved", "missing_context", "needs_human_review", "other"]);

function buildFeishuAnswerCard({
  answerText = "",
  connection = {},
  employee = {},
  sourceMessageId = "",
  runtimeTask = null,
} = {}) {
  const taskId = cleanShortText(runtimeTask?.id);
  const answerId = buildAnswerId({ sourceMessageId, taskId });
  const employeeId = cleanShortText(employee.id);
  if (!employeeId) throw new Error("feishu answer card requires employee.id");
  const employeeVersion = cleanShortText(employee.version || employee.employeeVersion);
  const promptVersion = cleanShortText(employee.promptVersion);
  const requestId = cleanShortText(connection.workerBinding?.capabilityRequestId || connection.capabilityRequestId);
  const skillId = cleanShortText(connection.workerBinding?.selectedSkillIds?.[0]);
  const feedbackValue = {
    kind: CARD_FEEDBACK_ACTION_KIND,
    contractVersion: CARD_FEEDBACK_CONTRACT_VERSION,
    answerId,
    employeeId,
    employeeVersion,
    promptVersion,
    taskId,
    requestId,
    skillId,
  };
  const metadata = [
    taskId ? `任务：${taskId}` : "本次回复",
    runtimeTask?.statusLabel ? `状态：${cleanShortText(runtimeTask.statusLabel)}` : "状态：已回复",
  ].join(" · ");
  const nextStep = cleanText(runtimeTask?.nextGate || "涉及执行、写回或客户承诺时，仍需走对应门禁和人工复核。").slice(0, 240);
  const answerElements = buildFeishuCardContentElements(answerText);

  return {
    answerId,
    taskId,
    requestId,
    skillId,
    card: {
      config: { wide_screen_mode: true },
      header: {
        title: { tag: "plain_text", content: cleanShortText(employee.name || "数字员工") },
        template: "blue",
      },
      elements: [
        ...answerElements,
        {
          tag: "note",
          elements: [{ tag: "plain_text", content: metadata }],
        },
        {
          tag: "note",
          elements: [{ tag: "plain_text", content: `下一步：${nextStep}` }],
        },
        {
          tag: "action",
          actions: [
            buildFeedbackButton("质量 OK", "helpful", feedbackValue),
            buildFeedbackButton("存在问题", "not_helpful", feedbackValue),
          ],
        },
      ],
    },
  };
}

function buildFeedbackButton(label, rating, baseValue) {
  return {
    tag: "button",
    text: { tag: "plain_text", content: label },
    type: rating === "not_helpful" ? "danger" : "default",
    value: { ...baseValue, rating },
  };
}

function buildAnswerId({ sourceMessageId = "", taskId = "" } = {}) {
  const seed = cleanShortText(sourceMessageId || taskId || "unbound-answer");
  return `FANS-${digestValue(seed).slice(0, 16).toUpperCase()}`;
}

function cardFeedbackSubscriptionReady(connection = {}) {
  const subscription = connection.eventSubscription || {};
  return Boolean(subscription.cardActionSubscribedAt || subscription.cardActionLastReceivedAt);
}

function parseFeishuCardFeedback(event = {}, now = new Date().toISOString(), expectedEmployeeId = "") {
  const payload = event.event && typeof event.event === "object" ? event.event : event;
  const value = parseActionValue(payload.action?.value);
  const actionKind = cleanShortText(value?.kind);
  if (!value || ![CARD_FEEDBACK_ACTION_KIND, LEGACY_CARD_FEEDBACK_ACTION_KIND].includes(actionKind)) {
    return { ok: false, error: "unsupported_card_action" };
  }

  const employeeId = cleanShortText(value.employeeId);
  const requiredEmployeeId = cleanShortText(expectedEmployeeId);
  const rating = cleanShortText(value.rating).toLowerCase();
  const answerId = cleanShortText(value.answerId);
  const operatorId = cleanShortText(payload.operator?.open_id || payload.operator?.user_id || payload.operator?.union_id);
  if (!requiredEmployeeId || employeeId !== requiredEmployeeId || !answerId || !operatorId || !FEEDBACK_RATINGS.has(rating)) {
    return { ok: false, error: "invalid_card_feedback_payload" };
  }

  const callbackEventId = cleanShortText(event.header?.event_id || payload.event_id || event.event_id);
  const sourceMessageId = cleanShortText(payload.context?.open_message_id || payload.open_message_id || payload.context?.message_id);
  const sourceChatId = cleanShortText(payload.context?.open_chat_id || payload.open_chat_id || payload.context?.chat_id);
  const operatorIdDigest = digestValue(operatorId);
  const reasonCode = cleanShortText(value.reasonCode).toLowerCase();
  return {
    ok: true,
    feedback: {
      id: `CFBK-${digestValue(`${answerId}:${operatorIdDigest}`).slice(0, 20).toUpperCase()}`,
      contractVersion: CARD_FEEDBACK_CONTRACT_VERSION,
      answerId,
      rating,
      employeeId,
      employeeVersion: cleanShortText(value.employeeVersion),
      promptVersion: cleanShortText(value.promptVersion),
      taskId: cleanShortText(value.taskId),
      requestId: cleanShortText(value.requestId),
      skillId: cleanShortText(value.skillId),
      sourceMessageIdDigest: digestValue(sourceMessageId),
      sourceChatIdDigest: digestValue(sourceChatId),
      operatorIdDigest,
      callbackEventIdDigest: callbackEventId ? digestValue(callbackEventId) : "",
      idempotencyKey: digestValue(`${answerId}:${operatorIdDigest}`),
      sourceChannel: "feishu_app_bot",
      reasonCode: REASON_CODES.has(reasonCode) ? reasonCode : "",
      receivedAt: now,
      updatedAt: now,
    },
  };
}

function findDuplicateCardFeedback(records = [], feedback = {}) {
  return records.find((record) => (
    feedback.callbackEventIdDigest && record.callbackEventIdDigest === feedback.callbackEventIdDigest
  ) || (
    feedback.answerId && record.answerId === feedback.answerId && record.operatorIdDigest === feedback.operatorIdDigest
  )) || null;
}

function cardFeedbackToast({ duplicate = false, rating = "" } = {}) {
  const content = duplicate
    ? "已收到这条回复的反馈。"
    : rating === "not_helpful"
      ? "已收到反馈，系统会进入质量复盘。"
      : "已收到反馈。";
  return { toast: { type: "success", content } };
}

function parseActionValue(value) {
  if (value && typeof value === "object") return value;
  if (typeof value !== "string") return null;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

export {
  CARD_FEEDBACK_ACTION_KIND,
  CARD_FEEDBACK_CONTRACT_VERSION,
  LEGACY_CARD_FEEDBACK_ACTION_KIND,
  buildFeishuAnswerCard,
  cardFeedbackSubscriptionReady,
  cardFeedbackToast,
  findDuplicateCardFeedback,
  parseFeishuCardFeedback,
};
