const ACTION_KIND = "tool_parameter_card_submit";
const SUBMIT_BUTTON_PREFIX = "tool_parameter_submit_";

function buildFeishuToolParameterCard(card = {}) {
  const fields = editableFields(card.argumentSchema, card.initialArguments);
  if (!card.id || !card.schemaDigest || (!fields.length && !card.managedReferences?.length)) return null;
  const formElements = fields.flatMap((field, index) => [
    ...(index ? [{ tag: "hr" }] : []),
    ...buildFieldElements(field, index),
  ]);
  formElements.push(
    { tag: "hr" },
    {
      tag: "button",
      name: `${SUBMIT_BUTTON_PREFIX}${card.id}`,
      value: {
        kind: ACTION_KIND,
        cardId: card.id,
        schemaDigest: card.schemaDigest,
        employeeId: card.employeeId || "",
      },
      text: { tag: "plain_text", content: plainText("确认参数", 40) },
      type: "primary",
      form_action_type: "submit",
    },
  );
  return {
    schema: "2.0",
    config: { wide_screen_mode: true, update_multi: true },
    header: {
      template: "blue",
      title: { tag: "plain_text", content: plainText(card.title || "确认任务参数", 80) },
      subtitle: { tag: "plain_text", content: plainText("请确认后继续当前任务", 80) },
    },
    body: {
      elements: [
        ...(card.description ? [{ tag: "markdown", content: String(card.description).slice(0, 500) }] : []),
        ...managedReferenceElements(card.managedReferences),
        {
          tag: "form",
          name: `tool_parameter_form_${shortCardId(card.id)}`,
          elements: formElements,
        },
      ],
    },
  };
}

function parseFeishuToolParameterAction(event = {}, expectedEmployeeId = "") {
  const payload = event.event && typeof event.event === "object" ? event.event : event;
  const value = parseActionValue(payload.action?.value);
  const actionName = String(payload.action?.name || "");
  const matched = value?.kind === ACTION_KIND || actionName.startsWith(SUBMIT_BUTTON_PREFIX);
  if (!matched) return { matched: false };
  const cardId = String(value?.cardId || actionName.slice(SUBMIT_BUTTON_PREFIX.length) || "").trim();
  const expectedEmployee = String(expectedEmployeeId || "").trim();
  const employeeId = String(value?.employeeId || expectedEmployee).trim();
  const operatorId = firstText(
    payload.operator?.open_id,
    payload.operator?.user_id,
    payload.operator?.operator_id?.open_id,
    payload.operator?.operator_id?.user_id,
    payload.operator?.user_id?.open_id,
    payload.operator?.user_id?.user_id,
  );
  const chatId = firstText(payload.context?.open_chat_id, payload.context?.chat_id, payload.open_chat_id, payload.chat_id);
  const messageId = firstText(
    payload.context?.open_message_id,
    payload.context?.message_id,
    payload.open_message_id,
    payload.message_id,
  );
  const schemaDigest = String(value?.schemaDigest || "").trim();
  const formValue = payload.action?.form_value || payload.action?.formValue;
  if (!cardId || !operatorId || !chatId || !messageId || employeeId !== expectedEmployee ||
    (schemaDigest && !/^(?:sha256:)?[a-f0-9]{64}$/.test(schemaDigest)) || !plainObject(formValue)) {
    return { matched: true, ok: false, error: "tool_parameter_card_callback_invalid" };
  }
  return { matched: true, ok: true, cardId, chatId, employeeId, formValue, messageId, operatorId, schemaDigest };
}

function parseFeishuToolParameterSubmission(card = {}, action = {}) {
  if (!action?.ok || card.id !== action.cardId || card.schemaDigest !== action.schemaDigest) {
    return { ok: false, error: "tool_parameter_card_stale" };
  }
  const fields = editableFields(card.argumentSchema, card.initialArguments);
  const argumentsValue = structuredClone(card.initialArguments || {});
  for (let index = 0; index < fields.length; index += 1) {
    const field = fields[index];
    const parsed = parseFieldValue(action.formValue[`field_${index}`], field);
    if (!parsed.ok) return parsed;
    setAtPath(argumentsValue, field.path, parsed.value);
  }
  return { ok: true, arguments: argumentsValue };
}

function buildFeishuToolParameterProcessingCard(card = {}) {
  return {
    schema: "2.0",
    config: { wide_screen_mode: true, update_multi: true },
    header: {
      template: "turquoise",
      title: { tag: "plain_text", content: plainText(card.title || "任务参数已提交", 80) },
      subtitle: { tag: "plain_text", content: plainText("正在继续执行", 80) },
    },
    body: {
      elements: [
        { tag: "markdown", content: "参数已收到，系统正在按同一会话和 Tool 合同继续处理。" },
        ...managedReferenceElements(card.managedReferences),
      ],
    },
  };
}

function editableFields(schema = {}, values = {}, path = [], required = false) {
  if (!plainObject(schema) || schema["x-agent-managed"] === true || Object.hasOwn(schema, "const")) return [];
  const type = schemaType(schema);
  if (type !== "object") {
    return [{
      path,
      label: plainText(schema.title || path.at(-1) || "参数", 80) || "参数",
      description: String(schema.description || "").slice(0, 160),
      required,
      schema,
      value: valueAtPath(values, path),
    }];
  }
  const requiredKeys = new Set(Array.isArray(schema.required) ? schema.required : []);
  return Object.entries(schema.properties || {}).flatMap(([key, child]) => (
    editableFields(child, values, [...path, key], requiredKeys.has(key))
  ));
}

function buildFieldElements(field, index) {
  const label = { tag: "markdown", content: `**${plainText(field.label, 80) || "参数"}**${field.required ? " *" : ""}` };
  const control = buildFieldControl(field, index);
  return [
    ...(field.description ? [{ tag: "markdown", content: field.description, text_size: "notation" }] : []),
    {
      tag: "column_set",
      flex_mode: "stretch",
      horizontal_spacing: "8px",
      columns: [
        { tag: "column", width: "weighted", weight: 1, vertical_align: "center", elements: [label] },
        { tag: "column", width: "weighted", weight: 3, vertical_align: "center", elements: [control] },
      ],
    },
  ];
}

function buildFieldControl(field, index) {
  const name = `field_${index}`;
  const type = schemaType(field.schema);
  if (Array.isArray(field.schema.enum) || type === "boolean") {
    const values = type === "boolean" ? [true, false] : field.schema.enum;
    const labels = Array.isArray(field.schema["x-enum-labels"]) ? field.schema["x-enum-labels"] : [];
    return {
      tag: "select_static",
      name,
      required: field.required,
      placeholder: { tag: "plain_text", content: plainText("请选择", 40) },
      options: values.map((value, optionIndex) => ({
        text: { tag: "plain_text", content: plainText(labels[optionIndex] ?? booleanLabel(value) ?? value, 80) },
        value: String(value),
      })),
    };
  }
  return {
    tag: "input",
    name,
    required: field.required,
    placeholder: { tag: "plain_text", content: plainText(type === "integer" || type === "number" ? "请输入数值" : "请输入", 40) },
    default_value: field.value === undefined || field.value === null ? "" : String(field.value),
    max_length: Math.min(1_000, Number(field.schema.maxLength) || 1_000),
  };
}

function parseFieldValue(raw, field) {
  const type = schemaType(field.schema);
  const text = typeof raw === "string" ? raw.trim() : raw === undefined || raw === null ? "" : String(raw).trim();
  if (!text && field.required) return fieldError(field, "不能为空");
  if (!text) return { ok: true, value: field.value === undefined ? "" : field.value };
  if (Array.isArray(field.schema.enum)) {
    const match = field.schema.enum.find((value) => String(value) === text);
    return match === undefined ? fieldError(field, "选项已失效，请重新生成参数卡") : { ok: true, value: match };
  }
  if (type === "boolean") {
    if (!["true", "false"].includes(text)) return fieldError(field, "布尔值无效");
    return { ok: true, value: text === "true" };
  }
  if (type === "integer" || type === "number") {
    const value = Number(text);
    if (!Number.isFinite(value) || (type === "integer" && !Number.isInteger(value))) return fieldError(field, "请输入有效数值");
    if (Number.isFinite(field.schema.minimum) && value < field.schema.minimum) return fieldError(field, `不能小于 ${field.schema.minimum}`);
    if (Number.isFinite(field.schema.maximum) && value > field.schema.maximum) return fieldError(field, `不能大于 ${field.schema.maximum}`);
    return { ok: true, value };
  }
  if (Number.isFinite(field.schema.minLength) && text.length < field.schema.minLength) return fieldError(field, `至少 ${field.schema.minLength} 个字符`);
  if (Number.isFinite(field.schema.maxLength) && text.length > field.schema.maxLength) return fieldError(field, `最多 ${field.schema.maxLength} 个字符`);
  if (field.schema.pattern) {
    try { if (!new RegExp(field.schema.pattern).test(text)) return fieldError(field, "格式不正确"); } catch { return fieldError(field, "字段规则无效"); }
  }
  return { ok: true, value: text };
}

function managedReferenceElements(references = []) {
  if (!Array.isArray(references) || !references.length) return [];
  return references.slice(0, 12).map((reference) => ({
    tag: "column_set",
    flex_mode: "stretch",
    columns: [
      { tag: "column", width: "weighted", weight: 1, elements: [{ tag: "markdown", content: `**${plainText(reference.label || "已选对象", 80)}**` }] },
      { tag: "column", width: "weighted", weight: 3, elements: [{ tag: "markdown", content: plainText(reference.displayValue || "", 160) }] },
    ],
  }));
}

function fieldError(field, detail) {
  return { ok: false, error: "tool_parameter_card_field_invalid", message: `${field.label}：${detail}` };
}

function setAtPath(target, path, value) {
  let current = target;
  for (let index = 0; index < path.length - 1; index += 1) {
    const key = path[index];
    if (!plainObject(current[key])) current[key] = {};
    current = current[key];
  }
  current[path.at(-1)] = value;
}

function valueAtPath(value, path = []) { return path.reduce((current, key) => current?.[key], value); }
function schemaType(schema = {}) { return Array.isArray(schema.type) ? schema.type.find((item) => item !== "null") : schema.type || (schema.properties ? "object" : ""); }
function booleanLabel(value) { return value === true ? "是" : value === false ? "否" : ""; }
function shortCardId(value) { return String(value || "").replace(/[^A-Za-z0-9_-]/g, "").slice(-24) || "card"; }
function plainObject(value) { return Boolean(value) && typeof value === "object" && !Array.isArray(value); }
function firstText(...values) {
  return String(values.find((value) => typeof value === "string" && value.trim()) || "").trim();
}
function plainText(value = "", max = 80) {
  return stripMarkdown(String(value || "").replace(/[\u0000-\u001f\u007f]/g, " ").trim()).slice(0, max);
}
function stripMarkdown(value = "") {
  return String(value || "")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/__([^_]+)__/g, "$1")
    .replace(/\*([^*]+)\*/g, "$1")
    .replace(/_([^_]+)_/g, "$1")
    .replace(/^[#>\s-]+/g, "")
    .trim();
}
function parseActionValue(value) {
  if (plainObject(value)) return value;
  if (typeof value !== "string") return null;
  try { const parsed = JSON.parse(value); return plainObject(parsed) ? parsed : null; } catch { return null; }
}

export {
  ACTION_KIND,
  buildFeishuToolParameterCard,
  buildFeishuToolParameterProcessingCard,
  parseFeishuToolParameterAction,
  parseFeishuToolParameterSubmission,
};
