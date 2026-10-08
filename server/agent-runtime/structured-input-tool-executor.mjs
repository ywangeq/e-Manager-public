import crypto from "node:crypto";
import {
  createToolParameterCard,
} from "./tool-parameter-card.mjs";

const TOOL_ID = "runtime-structured-input";
const TOOL_NAME = "runtime__requestStructuredInput";
const OPERATION_PREFIX = "collect_user_input";
const MAX_FIELDS = 8;

function createStructuredInputToolExecutor({ sourcePolicies = [] } = {}) {
  const policies = normalizeSourcePolicies(sourcePolicies);
  return Object.freeze({
    agentResultFor: (result) => result,
    availableAgentContent: () => [],
    execute: async (toolCall = {}) => executeStructuredInputRequest(toolCall, { sourcePolicies: policies }),
    runtimeStatus: () => ({ toolId: TOOL_ID, status: "ready", policyMode: "runtime_interaction_only" }),
    safeActivityDescriptor: (toolCall = {}) => toolCall.name === TOOL_NAME ? {
      actionCode: "conversation.collect_structured_input",
      kind: "tool",
      subjectId: TOOL_ID,
    } : null,
    safeToolCatalog: () => [{ name: TOOL_NAME, description: "根据当前已读取的权威业务字段，请用户在结构化卡片中补充或确认信息。" }],
    toolDefinitions: () => [structuredInputToolDefinition()],
    validateParameterCardSubmission: validateStructuredInputSubmission,
  });
}

function executeStructuredInputRequest({ name = "", arguments: input = {} } = {}, { sourcePolicies = [] } = {}) {
  if (name !== TOOL_NAME) return failure("tool_not_allowed", "该 Runtime 交互 Tool 不可用。");
  const request = normalizeRequest(input);
  if (!request) return failure("structured_input_invalid", "结构化问题不完整或包含不支持的字段。请重新读取权威数据后生成。");
  const policyViolation = managedContextPolicyViolation(request, sourcePolicies);
  if (policyViolation) {
    return failure(
      "structured_input_managed_context_field",
      `「${policyViolation.label}」已由权威业务上下文提供，不能再生成用户输入卡。请使用已选业务对象继续下一步。`,
    );
  }
  const parameterCard = createStructuredInputParameterCardFromRequest(request);
  return parameterCard
    ? { ok: true, status: "completed", toolId: TOOL_ID, operationId: parameterCard.operationId, parameterCard }
    : failure("structured_input_card_unavailable", "当前问题无法生成结构化卡片。");
}

function createStructuredInputParameterCard(input = {}) {
  const request = normalizeRequest(input);
  if (!request) return null;
  return createStructuredInputParameterCardFromRequest(request);
}

function createStructuredInputParameterCardFromRequest(request) {
  const argumentSchema = schemaFromRequest(request);
  const operationId = `${OPERATION_PREFIX}.${requestDigest(request).slice(0, 24)}`;
  return createToolParameterCard({
    argumentSchema,
    inputSource: {
      contractVersion: "tool-parameter-input-source.v1",
      toolId: request.sourceToolId,
      operationId: request.sourceOperationId,
    },
    minimumFieldCount: 1,
    operation: {
      operationId,
      summary: request.title,
      description: request.description,
      method: "INTERACT",
      path: "conversation://structured-input",
      risk: "read_only",
      scope: ["current_actor", "current_session"],
      writebackBoundary: "只把本卡答案带回当前 Agent 会话；不授权任何外部写操作。",
    },
    suggestedArguments: request.initialValues,
    toolId: TOOL_ID,
  });
}

function validateStructuredInputSubmission(submission = null) {
  if (String(submission?.toolId || "").trim() !== TOOL_ID) return { matched: false, ok: false, error: "tool_parameter_card_tool_mismatch" };
  const operationId = String(submission?.operationId || "").trim();
  if (!new RegExp(`^${OPERATION_PREFIX}\\.[a-f0-9]{24}$`).test(operationId) ||
    !/^(?:sha256:)?[a-f0-9]{64}$/.test(String(submission?.schemaDigest || "")) ||
    !plainObject(submission?.arguments)) {
    return { matched: true, ok: false, error: "tool_parameter_card_submission_invalid" };
  }
  const inputSource = normalizeInputSource(submission.inputSource);
  return {
    matched: true,
    ok: true,
    value: {
      contractVersion: "tool-parameter-continuation.v1",
      cardId: cleanToken(submission.cardId, 240),
      toolId: TOOL_ID,
      operationId,
      schemaDigest: submission.schemaDigest,
      arguments: structuredClone(submission.arguments),
      ...(plainObject(submission.selectionEvidence) ? { selectionEvidence: structuredClone(submission.selectionEvidence) } : {}),
      ...(inputSource ? { inputSource } : {}),
      materialInputIds: [],
    },
  };
}

function normalizeInputSource(value = null) {
  if (!plainObject(value) || value.contractVersion !== "tool-parameter-input-source.v1") return null;
  const toolId = cleanToken(value.toolId, 180);
  const operationId = cleanToken(value.operationId, 180);
  return toolId && operationId ? {
    contractVersion: "tool-parameter-input-source.v1",
    toolId,
    operationId,
  } : null;
}

function structuredInputToolDefinition() {
  return {
    type: "function",
    name: TOOL_NAME,
    description: "当且仅当你已从受治理 Tool 的实时结果中取得业务字段、必填状态和实时选项时，生成 Channel-neutral 结构化输入卡。字段标签与选项必须来自该结果；不要用它收集内部 ID、Token、审批 Code，也不要把本卡当作外部写操作确认。",
    strict: false,
    parameters: {
      type: "object",
      properties: {
        title: { type: "string", minLength: 1, maxLength: 120 },
        description: { type: "string", maxLength: 500 },
        sourceToolId: { type: "string", minLength: 1, maxLength: 180 },
        sourceOperationId: { type: "string", minLength: 1, maxLength: 180 },
        fields: {
          type: "array",
          minItems: 1,
          maxItems: MAX_FIELDS,
          items: {
            type: "object",
            properties: {
              id: { type: "string", minLength: 1, maxLength: 120 },
              label: { type: "string", minLength: 1, maxLength: 120 },
              description: { type: "string", maxLength: 240 },
              type: { type: "string", enum: ["text", "textarea", "single_select", "boolean", "integer", "number"] },
              required: { type: "boolean" },
              options: {
                type: "array",
                maxItems: 50,
                items: {
                  type: "object",
                  properties: {
                    label: { type: "string", minLength: 1, maxLength: 120 },
                    value: { type: "string", minLength: 1, maxLength: 240 },
                  },
                  required: ["label", "value"],
                  additionalProperties: false,
                },
              },
              initialValue: {},
            },
            required: ["id", "label", "type", "required"],
            additionalProperties: false,
          },
        },
      },
      required: ["title", "sourceToolId", "sourceOperationId", "fields"],
      additionalProperties: false,
    },
  };
}

function normalizeRequest(value = {}) {
  if (!plainObject(value)) return null;
  const title = cleanText(value.title, 120);
  const description = cleanText(value.description, 500);
  const sourceToolId = cleanToken(value.sourceToolId, 180);
  const sourceOperationId = cleanToken(value.sourceOperationId, 180);
  const rawFields = Array.isArray(value.fields) ? value.fields.slice(0, MAX_FIELDS) : [];
  if (!title || !sourceToolId || !sourceOperationId || !rawFields.length) return null;
  const fields = rawFields.map(normalizeField);
  if (fields.some((field) => !field) || new Set(fields.map((field) => field.id)).size !== fields.length) return null;
  const initialValues = Object.fromEntries(fields.flatMap((field) => field.initialValue === undefined ? [] : [[field.id, field.initialValue]]));
  return { title, description, sourceToolId, sourceOperationId, fields, initialValues };
}

function managedContextPolicyViolation(request = {}, sourcePolicies = []) {
  const policy = sourcePolicies.find((item) => item.sourceToolId === request.sourceToolId &&
    item.sourceOperationId === request.sourceOperationId);
  if (!policy) return null;
  for (const field of request.fields) {
    const candidateTexts = [
      request.title,
      request.description,
      field.id,
      field.label,
      field.description,
      ...field.options.flatMap((option) => [option.label, option.value]),
    ];
    const matched = policy.blockedFields.find((blockedField) => textMatchesAny(candidateTexts, blockedField.matchTerms));
    if (matched) return { fieldId: field.id, label: field.label || matched.fieldId };
  }
  return null;
}

function normalizeSourcePolicies(value = []) {
  return (Array.isArray(value) ? value : []).slice(0, 100).flatMap((item) => {
    if (!plainObject(item)) return [];
    const sourceToolId = cleanToken(item.sourceToolId, 180);
    const sourceOperationId = cleanToken(item.sourceOperationId, 180);
    const blockedFields = (Array.isArray(item.blockedFields) ? item.blockedFields : []).slice(0, 50).flatMap((field) => {
      if (!plainObject(field)) return [];
      const fieldId = cleanFieldId(field.fieldId || field.id);
      if (!fieldId) return [];
      const aliases = (Array.isArray(field.aliases) ? field.aliases : []).map((alias) => cleanText(alias, 120)).filter(Boolean);
      const matchTerms = [...new Set([fieldId, ...aliases].map(normalizeMatchText).filter(Boolean))];
      return matchTerms.length ? [{ fieldId, matchTerms }] : [];
    });
    return sourceToolId && sourceOperationId && blockedFields.length
      ? [{ sourceToolId, sourceOperationId, blockedFields }]
      : [];
  });
}

function textMatchesAny(values = [], terms = []) {
  const normalizedValues = values.map(normalizeMatchText).filter(Boolean);
  return normalizedValues.some((value) => terms.some((term) => value.includes(term) || term.includes(value)));
}

function normalizeField(value = {}) {
  if (!plainObject(value)) return null;
  const id = cleanFieldId(value.id);
  const label = cleanText(value.label, 120);
  const description = cleanText(value.description, 240);
  const type = ["text", "textarea", "single_select", "boolean", "integer", "number"].includes(value.type) ? value.type : "";
  const options = (Array.isArray(value.options) ? value.options : []).slice(0, 50).map((option) => ({
    label: cleanText(option?.label, 120),
    value: cleanText(option?.value, 240),
  })).filter((option) => option.label && option.value);
  if (!id || !label || !type || (type === "single_select" && !options.length) || (type !== "single_select" && options.length)) return null;
  const initialValue = normalizeInitialValue(value.initialValue, type, options);
  return { id, label, description, type, required: value.required === true, options, ...(initialValue === undefined ? {} : { initialValue }) };
}

function schemaFromRequest(request) {
  return {
    type: "object",
    additionalProperties: false,
    required: request.fields.filter((field) => field.required).map((field) => field.id),
    properties: Object.fromEntries(request.fields.map((field) => [field.id, fieldSchema(field)])),
  };
}

function fieldSchema(field) {
  const common = { title: field.label, ...(field.description ? { description: field.description } : {}) };
  if (field.type === "boolean") return { ...common, type: "boolean" };
  if (field.type === "integer" || field.type === "number") return { ...common, type: field.type };
  if (field.type === "single_select") return {
    ...common,
    type: "string",
    enum: field.options.map((option) => option.value),
    "x-enum-labels": field.options.map((option) => option.label),
  };
  return { ...common, type: "string", minLength: field.required ? 1 : 0, maxLength: field.type === "textarea" ? 4_000 : 1_000, ...(field.type === "textarea" ? { "x-ui-control": "textarea" } : {}) };
}

function normalizeInitialValue(value, type, options) {
  if (value === undefined || value === null || value === "") return undefined;
  if (type === "boolean") return typeof value === "boolean" ? value : undefined;
  if (type === "integer") return Number.isInteger(value) ? value : undefined;
  if (type === "number") return Number.isFinite(value) ? value : undefined;
  const text = cleanText(value, type === "textarea" ? 4_000 : 1_000);
  if (!text) return undefined;
  return type === "single_select" && !options.some((option) => option.value === text) ? undefined : text;
}

function requestDigest(request) {
  return crypto.createHash("sha256").update(JSON.stringify(request)).digest("hex");
}

function normalizeMatchText(value = "") {
  return String(value || "").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
}

function failure(error, message) { return { ok: false, status: "blocked", toolId: TOOL_ID, error, message }; }
function cleanFieldId(value = "") { return String(value || "").trim().replace(/[^A-Za-z0-9_.:-]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 120); }
function cleanToken(value = "", max = 180) { return String(value || "").replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, max); }
function cleanText(value = "", max = 500) { return String(value || "").replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, max); }
function plainObject(value) { return Boolean(value) && typeof value === "object" && !Array.isArray(value); }

export {
  TOOL_ID,
  TOOL_NAME,
  createStructuredInputParameterCard,
  createStructuredInputToolExecutor,
};
