import crypto from "node:crypto";

const TOOL_PARAMETER_CARD_CONTRACT_VERSION = "tool-parameter-card.v2";
const TOOL_PARAMETER_CARD_SUBMISSION_VERSION = "tool-parameter-card-submission.v2";
const DEFAULT_TOOL_PARAMETER_CONTINUATION_TTL_MS = 5 * 60 * 1000;
const MAX_FIELDS = 24;
const MAX_DEPTH = 4;
const SENSITIVE_KEY = /authorization|bearer|token|secret|password|cookie|api[-_]?key|credential/i;

function createToolParameterCard({ argumentSchema = {}, inputSource = null, requestKind = null, minimumFieldCount = 2, operation = {}, resolveManagedReferenceLabel = null, suggestedArguments = {}, toolId = "" } = {}) {
  const profile = renderableSchemaProfile(argumentSchema);
  if (!profile.supported) return null;
  const normalizedToolId = cleanId(toolId || operation.toolId);
  const operationId = cleanId(operation.operationId);
  if (!normalizedToolId || !operationId) return null;
  const schema = structuredClone(argumentSchema);
  const initialArguments = mergeObjects(schemaDefaults(schema), projectValueToSchema(schema, suggestedArguments));
  if (!requiredAgentManagedFieldsReady(schema, initialArguments)) return null;
  const managedReferences = collectManagedReferences(schema, initialArguments, resolveManagedReferenceLabel);
  const normalizedInputSource = normalizeInputSource(inputSource);
  const minimumItems = Number.isSafeInteger(minimumFieldCount) ? Math.min(24, Math.max(1, minimumFieldCount)) : 2;
  if (profile.fieldCount < minimumItems && profile.fieldCount + managedReferences.length < minimumItems) return null;
  return {
    contractVersion: TOOL_PARAMETER_CARD_CONTRACT_VERSION,
    status: "draft",
    ...(["business_fields", "clarification"].includes(requestKind) ? { requestKind } : {}),
    toolId: normalizedToolId,
    operationId,
    schemaDigest: parameterCardSchemaDigest({ argumentSchema: schema, operationId, toolId: normalizedToolId }),
    title: cleanText(operation.summary || operationId, 160),
    description: cleanText(operation.description, 500),
    method: cleanText(operation.method, 12).toUpperCase(),
    path: cleanText(operation.path, 300),
    risk: cleanId(operation.risk),
    scope: cleanList(operation.scope, 20),
    writebackBoundary: cleanText(operation.writebackBoundary, 240),
    argumentSchema: schema,
    ...(normalizedInputSource ? { inputSource: normalizedInputSource } : {}),
    initialArguments,
    managedReferences,
    fieldCount: profile.fieldCount,
    minimumFieldCount: minimumItems,
  };
}

function normalizeToolParameterCardSubmission(value = null) {
  if (!plainObject(value) || value.contractVersion !== TOOL_PARAMETER_CARD_SUBMISSION_VERSION) return null;
  const cardId = cleanId(value.cardId);
  const schemaDigest = cleanDigest(value.schemaDigest);
  if (containsSensitiveShape(value.arguments)) return null;
  const argumentsValue = safeValue(value.arguments);
  if (!cardId || !schemaDigest || !plainObject(argumentsValue)) return null;
  return {
    contractVersion: TOOL_PARAMETER_CARD_SUBMISSION_VERSION,
    cardId,
    schemaDigest,
    arguments: argumentsValue,
  };
}

function validateToolParameterCardSubmission({ materialInputIds = [], operation = {}, submission = null, toolId = "" } = {}) {
  if (!plainObject(submission)) return { matched: false, ok: false, error: "tool_parameter_card_submission_invalid" };
  const normalizedToolId = cleanId(toolId || operation.toolId);
  if (cleanId(submission.toolId) !== normalizedToolId) return { matched: false, ok: false, error: "tool_parameter_card_tool_mismatch" };
  if (cleanId(submission.operationId) !== cleanId(operation.operationId)) {
    return { matched: true, ok: false, error: "tool_parameter_card_operation_mismatch" };
  }
  const argumentSchema = operation.argumentSchema || operation.argumentSchemaForCard;
  if (!plainObject(argumentSchema)) return { matched: true, ok: false, error: "tool_parameter_card_schema_unavailable" };
  const expectedDigest = parameterCardSchemaDigest({ argumentSchema, operationId: operation.operationId, toolId: normalizedToolId });
  if (submission.schemaDigest !== expectedDigest) return { matched: true, ok: false, error: "tool_parameter_card_schema_stale" };
  return {
    matched: true,
    ok: true,
    value: {
      contractVersion: "tool-parameter-continuation.v1",
      cardId: cleanId(submission.cardId),
      toolId: normalizedToolId,
      operationId: cleanId(operation.operationId),
      schemaDigest: expectedDigest,
      arguments: structuredClone(submission.arguments),
      materialInputIds: [...new Set(materialInputIds.map(cleanId).filter(Boolean))],
    },
  };
}

function toolParameterCardsFromRuntime(runtime = {}) {
  const seen = new Set();
  return (Array.isArray(runtime.toolCalls) ? runtime.toolCalls : []).flatMap((call) => {
    const card = publicToolParameterCard(call?.result?.parameterCard);
    if (!card || seen.has(card.id)) return [];
    seen.add(card.id);
    return [card];
  }).slice(0, 4);
}

function toolParameterCardDraftsFromRuntime(runtime = {}) {
  const seen = new Set();
  return (Array.isArray(runtime.toolCalls) ? runtime.toolCalls : []).flatMap((call) => {
    const draft = toolParameterCardDraftForPersistence(call?.result?.parameterCard);
    const key = draft ? `${draft.toolId}\0${draft.operationId}\0${draft.schemaDigest}` : "";
    if (!draft || seen.has(key)) return [];
    seen.add(key);
    return [draft];
  }).slice(0, 4);
}

function toolParameterCardDraftForPersistence(value = null) {
  return normalizeToolParameterCard(value, { includeProtectedEvidence: true, requireId: false });
}

function publicToolParameterCard(value = null) {
  return normalizeToolParameterCard(value, { requireId: true });
}

function normalizeToolParameterCard(value = null, { includeProtectedEvidence = false, requireId = true } = {}) {
  if (!plainObject(value) || value.contractVersion !== TOOL_PARAMETER_CARD_CONTRACT_VERSION) return null;
  const profile = renderableSchemaProfile(value.argumentSchema);
  const managedReferences = normalizeManagedReferences(value.argumentSchema, value.initialArguments, value.managedReferences);
  const inputSource = normalizeInputSource(value.inputSource);
  const cardId = cleanId(value.id);
  const schemaDigest = cleanDigest(value.schemaDigest);
  const protectedSelectionEvidence = includeProtectedEvidence
    ? normalizeProtectedSelectionEvidence(value.protectedSelectionEvidence)
    : null;
  const minimumItems = value.minimumFieldCount === 1 ? 1 : 2;
  if ((requireId && !cardId) || !schemaDigest || !profile.supported || (profile.fieldCount < minimumItems && profile.fieldCount + managedReferences.length < minimumItems)) return null;
  return {
    contractVersion: TOOL_PARAMETER_CARD_CONTRACT_VERSION,
    ...(cardId ? { id: cardId } : {}),
    status: ["draft", "submitted"].includes(value.status) ? value.status : "draft",
    toolId: cleanId(value.toolId),
    operationId: cleanId(value.operationId),
    schemaDigest,
    ...(["business_fields", "clarification"].includes(value.requestKind) ? { requestKind: value.requestKind } : {}),
    title: cleanText(value.title || value.operationId, 160),
    description: cleanText(value.description, 500),
    method: cleanText(value.method, 12).toUpperCase(),
    path: cleanText(value.path, 300),
    risk: cleanId(value.risk),
    scope: cleanList(value.scope, 20),
    writebackBoundary: cleanText(value.writebackBoundary, 240),
    argumentSchema: structuredClone(value.argumentSchema),
    ...(inputSource ? { inputSource } : {}),
    createdAt: validTimestamp(value.createdAt),
    initialArguments: plainObject(value.initialArguments) ? structuredClone(value.initialArguments) : {},
    managedReferences,
    fieldCount: profile.fieldCount,
    minimumFieldCount: minimumItems,
    expiresAt: validTimestamp(value.expiresAt),
    ...(protectedSelectionEvidence ? { protectedSelectionEvidence } : {}),
  };
}

function normalizeProtectedSelectionEvidence(value = null) {
  if (!plainObject(value) || value.contractVersion !== "tool-parameter-protected-selection-evidence.v1") return null;
  const fieldId = cleanKey(value.fieldId);
  const options = Array.isArray(value.options) ? value.options.slice(0, 50).flatMap((option) => {
    const selectedValue = cleanText(option?.value, 500);
    const safeContext = safeEvidenceValue(option?.safeContext);
    const presentationLinks = Array.isArray(option?.presentationLinks) ? option.presentationLinks.slice(0, 12).flatMap((link) => {
      const label = cleanText(link?.label, 240);
      const url = safeHttpUrl(link?.url);
      return label && url ? [{ label, url }] : [];
    }) : [];
    const boundedSafeContext = boundedEvidenceObject(safeContext, 12 * 1024);
    return selectedValue && boundedSafeContext ? [{ value: selectedValue, safeContext: boundedSafeContext, presentationLinks }] : [];
  }) : [];
  return fieldId && options.length ? {
    contractVersion: value.contractVersion,
    fieldId,
    options,
  } : null;
}

function boundedEvidenceObject(value, maxBytes) {
  if (!plainObject(value)) return null;
  try {
    return Buffer.byteLength(JSON.stringify(value), "utf8") <= maxBytes ? value : null;
  } catch {
    return null;
  }
}

function safeEvidenceValue(value, depth = 0, count = { value: 0 }) {
  count.value += 1;
  if (depth > 6 || count.value > 256 || value === undefined) return undefined;
  if (Array.isArray(value)) return value.slice(0, 50).map((item) => safeEvidenceValue(item, depth + 1, count)).filter((item) => item !== undefined);
  if (plainObject(value)) {
    const entries = Object.entries(value).slice(0, 30).flatMap(([key, item]) => {
      const normalizedKey = cleanKey(key);
      const normalizedValue = SENSITIVE_KEY.test(normalizedKey) ? undefined : safeEvidenceValue(item, depth + 1, count);
      return normalizedKey && normalizedValue !== undefined ? [[normalizedKey, normalizedValue]] : [];
    });
    return Object.fromEntries(entries);
  }
  if (typeof value === "string") return value.slice(0, 4_000);
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "boolean" || value === null) return value;
  return undefined;
}

function safeHttpUrl(value = "") {
  try {
    const url = new URL(String(value || "").trim());
    return ["http:", "https:"].includes(url.protocol) && !url.username && !url.password && url.href.length <= 2_048 ? url.href : "";
  } catch {
    return "";
  }
}

function normalizeInputSource(value = null) {
  if (!plainObject(value) || value.contractVersion !== "tool-parameter-input-source.v1") return null;
  const toolId = cleanId(value.toolId);
  const operationId = cleanId(value.operationId);
  return toolId && operationId ? {
    contractVersion: "tool-parameter-input-source.v1",
    toolId,
    operationId,
  } : null;
}

function collectManagedReferences(schema = {}, value, resolveLabel, path = []) {
  if (!plainObject(schema)) return [];
  if (schema["x-agent-managed"] === true) {
    const displayValue = typeof resolveLabel === "function" ? cleanText(resolveLabel({ path, schema, value }), 160) : "";
    return displayValue ? [{ path: [...path], label: managedReferenceLabel(schema, path), displayValue }] : [];
  }
  if (schemaType(schema) !== "object") return [];
  return Object.entries(schema.properties || {}).flatMap(([key, child]) => (
    collectManagedReferences(child, value?.[key], resolveLabel, [...path, key])
  )).slice(0, 12);
}

function normalizeManagedReferences(schema = {}, initialArguments = {}, references = []) {
  if (!Array.isArray(references)) return [];
  const seen = new Set();
  return references.flatMap((reference) => {
    const path = Array.isArray(reference?.path) ? reference.path.map(cleanKey).filter(Boolean).slice(0, MAX_DEPTH + 1) : [];
    const targetSchema = schemaAtPath(schema, path);
    const targetValue = valueAtPath(initialArguments, path);
    const key = path.join(".");
    const displayValue = cleanText(reference?.displayValue, 160);
    if (!key || seen.has(key) || targetSchema?.["x-agent-managed"] !== true || targetValue === undefined || targetValue === null || targetValue === "" || !displayValue) return [];
    seen.add(key);
    return [{ path, label: cleanText(reference?.label || managedReferenceLabel(targetSchema, path), 80), displayValue }];
  }).slice(0, 12);
}

function managedReferenceLabel(schema = {}, path = []) {
  const title = cleanText(schema.title || path.at(-1) || "已选对象", 80);
  return title.replace(/(?:编号|ID)$/i, "").trim() || "已选对象";
}

function schemaAtPath(schema = {}, path = []) {
  return path.reduce((current, key) => current?.properties?.[key], schema);
}

function valueAtPath(value, path = []) {
  return path.reduce((current, key) => current?.[key], value);
}

function renderableSchemaProfile(schema = {}, depth = 0) {
  if (!plainObject(schema) || depth > MAX_DEPTH || schema.oneOf || schema.anyOf || schema.allOf || schema.not) {
    return { supported: false, fieldCount: 0 };
  }
  if (Object.hasOwn(schema, "const")) return { supported: true, fieldCount: 0 };
  if (schema["x-agent-managed"] === true) return { supported: true, fieldCount: 0 };
  const type = schemaType(schema);
  if (type === "array" || !["object", "string", "integer", "number", "boolean"].includes(type)) {
    return { supported: false, fieldCount: 0 };
  }
  if (type !== "object") return { supported: true, fieldCount: 1 };
  if (schema.additionalProperties !== false || !plainObject(schema.properties)) return { supported: false, fieldCount: 0 };
  let fieldCount = 0;
  for (const [key, child] of Object.entries(schema.properties)) {
    if (SENSITIVE_KEY.test(key)) return { supported: false, fieldCount: 0 };
    const childProfile = renderableSchemaProfile(child, depth + 1);
    if (!childProfile.supported) return childProfile;
    fieldCount += childProfile.fieldCount;
    if (fieldCount > MAX_FIELDS) return { supported: false, fieldCount };
  }
  return { supported: true, fieldCount };
}

function requiredAgentManagedFieldsReady(schema = {}, value, required = false) {
  if (!plainObject(schema)) return true;
  if (schema["x-agent-managed"] === true) return !required || (value !== undefined && value !== null && value !== "");
  if (schemaType(schema) !== "object") return true;
  if (!required && value === undefined) return true;
  const requiredKeys = new Set(Array.isArray(schema.required) ? schema.required : []);
  return Object.entries(schema.properties || {}).every(([key, child]) => (
    requiredAgentManagedFieldsReady(child, value?.[key], requiredKeys.has(key))
  ));
}

function parameterCardSchemaDigest({ argumentSchema = {}, operationId = "", toolId = "" } = {}) {
  const payload = canonicalJson({ argumentSchema, operationId: cleanId(operationId), toolId: cleanId(toolId) });
  return `sha256:${crypto.createHash("sha256").update(payload).digest("hex")}`;
}

function schemaDefaults(schema = {}) {
  if (Object.hasOwn(schema, "default")) return structuredClone(schema.default);
  if (schemaType(schema) !== "object") return undefined;
  const value = {};
  for (const [key, child] of Object.entries(schema.properties || {})) {
    const childDefault = schemaDefaults(child);
    if (childDefault !== undefined) value[key] = childDefault;
    else if (Object.hasOwn(child, "const")) value[key] = structuredClone(child.const);
  }
  return value;
}

function projectValueToSchema(schema = {}, value) {
  if (value === undefined) return undefined;
  if (schemaType(schema) === "object") {
    if (!plainObject(value)) return undefined;
    const projected = {};
    for (const [key, child] of Object.entries(schema.properties || {})) {
      if (!Object.hasOwn(value, key) || SENSITIVE_KEY.test(key)) continue;
      const childValue = projectValueToSchema(child, value[key]);
      if (childValue !== undefined) projected[key] = childValue;
    }
    return projected;
  }
  return ["string", "number", "boolean"].includes(typeof value) ? value : undefined;
}

function mergeObjects(left, right) {
  if (!plainObject(left)) return plainObject(right) ? structuredClone(right) : {};
  if (!plainObject(right)) return structuredClone(left);
  const result = structuredClone(left);
  for (const [key, value] of Object.entries(right)) {
    result[key] = plainObject(value) && plainObject(result[key]) ? mergeObjects(result[key], value) : structuredClone(value);
  }
  return result;
}

function safeValue(value, depth = 0) {
  if (depth > MAX_DEPTH + 1) return undefined;
  if (Array.isArray(value)) return undefined;
  if (plainObject(value)) {
    return Object.fromEntries(Object.entries(value).slice(0, MAX_FIELDS).flatMap(([key, item]) => {
      const normalizedKey = cleanKey(key);
      const normalizedValue = SENSITIVE_KEY.test(normalizedKey) ? undefined : safeValue(item, depth + 1);
      return normalizedKey && normalizedValue !== undefined ? [[normalizedKey, normalizedValue]] : [];
    }));
  }
  if (typeof value === "string") return value.slice(0, 2_000);
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "boolean" || value === null) return value;
  return undefined;
}

function containsSensitiveShape(value, depth = 0) {
  if (depth > MAX_DEPTH + 1) return true;
  if (Array.isArray(value)) return true;
  if (!plainObject(value)) return false;
  return Object.entries(value).some(([key, item]) => SENSITIVE_KEY.test(key) || containsSensitiveShape(item, depth + 1));
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (plainObject(value)) return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  return JSON.stringify(value);
}

function schemaType(schema) {
  const values = Array.isArray(schema.type) ? schema.type.filter((item) => item !== "null") : schema.type ? [schema.type] : [];
  return values[0] || (schema.properties ? "object" : "");
}

function validTimestamp(value) { return Number.isFinite(Date.parse(String(value || ""))) ? new Date(value).toISOString() : ""; }
function cleanDigest(value = "") { const digest = String(value || "").trim(); return /^sha256:[a-f0-9]{64}$/.test(digest) ? digest : ""; }
function cleanId(value = "") { return String(value || "").replace(/[^a-zA-Z0-9_.:/-]/g, "").slice(0, 240); }
function cleanKey(value = "") { return String(value || "").replace(/[^a-zA-Z0-9_.-]/g, "").slice(0, 160); }
function cleanList(value, max = 20) { return Array.isArray(value) ? [...new Set(value.map((item) => cleanText(item, 160)).filter(Boolean))].slice(0, max) : []; }
function cleanText(value = "", max = 500) { return String(value || "").replace(/[\r\n\0]/g, " ").trim().slice(0, max); }
function plainObject(value) { return Boolean(value) && typeof value === "object" && !Array.isArray(value); }

export {
  DEFAULT_TOOL_PARAMETER_CONTINUATION_TTL_MS,
  TOOL_PARAMETER_CARD_CONTRACT_VERSION,
  TOOL_PARAMETER_CARD_SUBMISSION_VERSION,
  createToolParameterCard,
  normalizeToolParameterCardSubmission,
  parameterCardSchemaDigest,
  publicToolParameterCard,
  toolParameterCardDraftForPersistence,
  toolParameterCardsFromRuntime,
  toolParameterCardDraftsFromRuntime,
  validateToolParameterCardSubmission,
};
