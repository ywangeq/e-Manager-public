export const TOOL_PARAMETER_CARD_SUBMISSION_VERSION = "tool-parameter-card-submission.v2";

export function parameterCardFields(schema = {}, value, path = []) {
  if (!plainObject(schema)) return [];
  if (Object.hasOwn(schema, "const")) return [];
  if (schema["x-agent-managed"] === true) return [];
  if (schemaType(schema) !== "object") return [{ path, schema, value }];
  const required = new Set(Array.isArray(schema.required) ? schema.required : []);
  return Object.entries(schema.properties || {}).flatMap(([key, child]) => (
    parameterCardFields(child, value?.[key], [...path, key]).map((field) => ({
      ...field,
      required: field.path.length === path.length + 1 ? required.has(key) : field.required,
    }))
  ));
}

export function buildToolParameterCardSubmission(card, argumentsValue) {
  return {
    contractVersion: TOOL_PARAMETER_CARD_SUBMISSION_VERSION,
    cardId: card.id,
    schemaDigest: card.schemaDigest,
    arguments: pruneEmpty(argumentsValue),
  };
}

export function validateParameterCard(schema = {}, value = {}, path = [], errors = {}) {
  if (schemaType(schema) === "object") {
    const required = new Set(Array.isArray(schema.required) ? schema.required : []);
    for (const [key, child] of Object.entries(schema.properties || {})) {
      const childPath = [...path, key];
      const childValue = value?.[key];
      if (required.has(key) && empty(childValue)) errors[childPath.join(".")] = "此项为必填";
      if (!empty(childValue)) validateParameterCard(child, childValue, childPath, errors);
    }
    return errors;
  }
  const key = path.join(".");
  if (schemaType(schema) === "string") {
    const text = String(value);
    if (Number.isSafeInteger(schema.minLength) && text.length < schema.minLength) errors[key] = `至少 ${schema.minLength} 个字符`;
    if (Number.isSafeInteger(schema.maxLength) && text.length > schema.maxLength) errors[key] = `最多 ${schema.maxLength} 个字符`;
    if (Array.isArray(schema.enum) && !schema.enum.includes(value)) errors[key] = "请选择有效选项";
    if (schema.pattern) {
      try { if (!new RegExp(schema.pattern).test(text)) errors[key] = schema.description || "格式不符合要求"; } catch { /* server remains authoritative */ }
    }
  }
  if (["integer", "number"].includes(schemaType(schema))) {
    if (!Number.isFinite(value) || (schemaType(schema) === "integer" && !Number.isInteger(value))) errors[key] = "请输入有效数字";
    else if (Number.isFinite(schema.minimum) && value < schema.minimum) errors[key] = `不能小于 ${schema.minimum}`;
    else if (Number.isFinite(schema.maximum) && value > schema.maximum) errors[key] = `不能大于 ${schema.maximum}`;
  }
  return errors;
}

export function setParameterValue(value = {}, path = [], nextValue) {
  const root = plainObject(value) ? structuredClone(value) : {};
  let cursor = root;
  path.forEach((key, index) => {
    if (index === path.length - 1) cursor[key] = nextValue;
    else {
      if (!plainObject(cursor[key])) cursor[key] = {};
      cursor = cursor[key];
    }
  });
  return root;
}

export function fieldLabel(field) {
  return String(field.schema?.title || field.path.at(-1) || "参数").replace(/[_-]+/g, " ");
}

export function enumOptionLabel(schema = {}, option, index) {
  const labels = Array.isArray(schema["x-enum-labels"]) ? schema["x-enum-labels"] : [];
  const values = Array.isArray(schema.enum) ? schema.enum : [];
  if (labels.length === values.length && typeof labels[index] === "string" && labels[index].trim()) return labels[index].trim();
  return String(option);
}

export function parameterGroup(field) {
  return ["path", "query", "headers", "body"].includes(field.path[0]) ? field.path[0] : "parameters";
}

function pruneEmpty(value) {
  if (!plainObject(value)) return value;
  return Object.fromEntries(Object.entries(value).flatMap(([key, item]) => {
    if (plainObject(item)) {
      const nested = pruneEmpty(item);
      return Object.keys(nested).length ? [[key, nested]] : [];
    }
    return empty(item) ? [] : [[key, item]];
  }));
}

function empty(value) { return value === undefined || value === null || value === ""; }
function schemaType(schema = {}) {
  const values = Array.isArray(schema.type) ? schema.type.filter((item) => item !== "null") : schema.type ? [schema.type] : [];
  return values[0] || (schema.properties ? "object" : "string");
}
function plainObject(value) { return Boolean(value) && typeof value === "object" && !Array.isArray(value); }
