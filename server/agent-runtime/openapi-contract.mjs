import crypto from "node:crypto";
import { resolveToolAuthorizationPolicy } from "./tool-authorization-policy.mjs";

const HTTP_METHODS = ["get", "put", "post", "delete", "patch", "head", "options"];
const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);
const WRITE_OPERATION_POLICY_CONTRACT = "openapi-write-operation-policy.v1";
const CAPABILITY_WRITE_POLICY_CONTRACT = "openapi-capability-write-policy.v1";
const SENSITIVE_PARAMETER = /authorization|bearer|token|secret|password|cookie|api[-_]?key/i;
const SCHEMA_KEYS = new Set([
  "additionalProperties", "allOf", "anyOf", "const", "default", "description", "enum", "exclusiveMaximum",
  "exclusiveMinimum", "format", "items", "maxItems", "maxLength", "maxProperties", "maximum", "minItems",
  "minLength", "minProperties", "minimum", "multipleOf", "not", "oneOf", "pattern", "properties", "required",
  "title", "type", "uniqueItems", "x-agent-managed", "x-enum-labels",
]);

function compileOpenApiOperations({ document = {}, toolId = "", toolNamePrefix = "" } = {}) {
  assertOpenApiDocument(document);
  const operations = [];
  const operationIds = new Set();
  const toolNames = new Set();
  const contractDigest = openApiContractDigest(document);
  for (const [path, pathItem] of Object.entries(document.paths || {})) {
    if (!path.startsWith("/") || !isObject(pathItem)) continue;
    for (const methodKey of HTTP_METHODS) {
      const rawOperation = pathItem[methodKey];
      if (!isObject(rawOperation)) continue;
      const declaredOperationId = cleanOperationId(rawOperation.operationId);
      const operationId = declaredOperationId || methodPathOperationId(methodKey, path);
      if (operationIds.has(operationId)) throw new Error(`openapi_operation_id_duplicate:${operationId}`);
      operationIds.add(operationId);
      const method = methodKey.toUpperCase();
      const toolName = openApiToolName(toolNamePrefix || toolId, operationId);
      if (toolNames.has(toolName)) throw new Error(`openapi_tool_name_duplicate:${toolName}`);
      toolNames.add(toolName);
      const parameters = compileParameters(document, [...(pathItem.parameters || []), ...(rawOperation.parameters || [])]);
      const requestBody = compileRequestBody(document, rawOperation.requestBody);
      const policy = operationPolicy(rawOperation, { method, operationId, toolId });
      const operation = {
        action: policy.action,
        asyncResult: compileAsyncResult(rawOperation, operationId),
        capabilities: policy.capabilities,
        confirmationPolicy: policy.confirmationPolicy,
        contractDigest,
        method,
        operationId,
        operationIdSource: declaredOperationId ? "contract" : "method_path_fallback",
        parameters,
        path,
        requestBody,
        responseSelection: compileResponseSelection(rawOperation, operationId),
        resultPresentation: compileResultPresentation(rawOperation, operationId),
        risk: policy.risk,
        sideEffectFree: policy.sideEffectFree,
        scope: policy.scope,
        summary: cleanText(rawOperation.summary || rawOperation.description || operationId, 500),
        description: cleanText(rawOperation.description || rawOperation.summary || "", 2_000),
        executable: requestBody?.supported !== false,
        unavailableReason: requestBody?.supported === false ? "request_media_type_unsupported" : "",
        tags: cleanList(rawOperation.tags, 20),
        toolId,
        toolName,
        writebackBoundary: policy.writebackBoundary,
      };
      operation.writePolicyDigest = writeOpenApiOperationDigest(operation);
      operations.push(Object.freeze(operation));
    }
  }
  validateAsyncResultOperations(operations);
  return Object.freeze(operations.sort((left, right) => left.toolName.localeCompare(right.toolName)));
}

function openApiToolDefinition(operation = {}) {
  return {
    type: "function",
    name: operation.toolName,
    description: `${operation.summary}（OpenAPI operationId: ${operation.operationId}；${operation.method} ${operation.path}）。${operation.description}`.trim().slice(0, 4_000),
    strict: true,
    parameters: operationArgumentSchema(operation),
  };
}

function operationArgumentSchema(operation = {}, { materialInputIds = [] } = {}) {
  const properties = {};
  const required = [];
  for (const location of ["path", "query", "header"]) {
    const entries = operation.parameters.filter((parameter) => parameter.in === location);
    if (!entries.length) continue;
    const name = location === "header" ? "headers" : location;
    properties[name] = {
      type: "object",
      properties: Object.fromEntries(entries.map((parameter) => [parameter.name, parameter.schema])),
      required: entries.filter((parameter) => parameter.required).map((parameter) => parameter.name),
      additionalProperties: false,
      description: `OpenAPI ${location} parameters。`,
    };
    if (entries.some((parameter) => parameter.required)) required.push(name);
  }
  if (operation.requestBody) {
    properties.body = materialReferenceSchema(operation.requestBody, materialInputIds);
    if (operation.requestBody.required) required.push("body");
  }
  return { type: "object", properties, required, additionalProperties: false };
}

function normalizeOpenApiArguments(operation = {}, value = {}, options = {}) {
  const schema = operationArgumentSchema(operation, options);
  const result = validateJsonValue(schema, value, "arguments");
  if (!result.ok) return result;
  return { ok: true, value: structuredClone(value) };
}

function buildOpenApiRequest({ apiBaseUrl = "", argumentsValue = {}, operation = {} } = {}) {
  const root = safeApiBaseUrl(apiBaseUrl);
  if (!root) return { ok: false, message: "OpenAPI Tool 的 API Base URL 不安全或无效。" };
  let path = operation.path;
  const headers = {};
  for (const parameter of operation.parameters || []) {
    const group = parameter.in === "header" ? argumentsValue.headers : argumentsValue[parameter.in];
    const value = group?.[parameter.name];
    if (value === undefined || value === null) continue;
    if (parameter.in === "path") {
      path = path.replaceAll(`{${parameter.name}}`, encodeURIComponent(String(value)));
    } else if (parameter.in === "header") {
      headers[parameter.name] = serializePrimitive(value);
    }
  }
  if (/\{[^}]+\}/.test(path)) return { ok: false, message: "OpenAPI path 参数不完整。" };
  const base = new URL(root);
  const basePath = base.pathname.replace(/\/+$/, "");
  const operationAlreadyIncludesBase = basePath && basePath !== "/" && (path === basePath || path.startsWith(`${basePath}/`));
  const url = new URL(operationAlreadyIncludesBase ? `${base.origin}${path}` : `${root}${path}`);
  for (const parameter of operation.parameters || []) {
    if (parameter.in !== "query") continue;
    const value = argumentsValue.query?.[parameter.name];
    if (value === undefined || value === null) continue;
    appendQueryParameter(url.searchParams, parameter, value);
  }
  const body = operation.requestBody ? argumentsValue.body : undefined;
  if (body !== undefined && operation.requestBody.contentType !== "multipart/form-data") {
    headers["Content-Type"] = operation.requestBody.contentType;
  }
  return { ok: true, value: { body, headers, method: operation.method, url: url.toString() } };
}

function operationAllowedByBinding(binding = {}, operation = {}, allOperations = []) {
  const policy = resolveToolAuthorizationPolicy(binding);
  if (policy.valid === false || policy.mode === "invalid") return false;
  if (policy.mode === "contract_capability") {
    if (!isWriteOpenApiOperation(operation)) return true;
    const allowedCapabilities = new Set(policy.allowedCapabilities);
    const allowedRisks = new Set(policy.allowedRisks);
    const matchingCapabilities = operation.capabilities.filter((capability) => allowedCapabilities.has(capability));
    if (!matchingCapabilities.length || operation.operationIdSource !== "contract" || !allowedRisks.has(operation.risk)) return false;
    if (policy.contractVersion === "tool-authorization-policy.v1") {
      return Boolean(policy.policyContractDigest) && policy.policyContractDigest === operation.contractDigest;
    }
    const currentWritePolicyDigests = capabilityWritePolicyDigests(allOperations, policy.allowedCapabilities);
    return matchingCapabilities.some((capability) => policy.approvedWritePolicyDigests?.[capability] === currentWritePolicyDigests[capability]);
  }
  const allowed = policy.allowedOperations;
  if (allowed.includes(operation.operationId) || allowed.includes(operation.toolName)) return true;
  if (allowed.some((legacyName) => legacyOperationMatches(legacyName, operation, allOperations))) return true;
  return operation.risk === "read_only";
}

function legacyOperationMatches(value = "", operation = {}, allOperations = []) {
  const suffix = String(value).includes("__") ? String(value).split("__").pop() : "";
  if (!suffix || suffix === operation.operationId) return false;
  const matches = allOperations.filter((candidate) => candidate.operationId.startsWith(suffix));
  return matches.length === 1 && matches[0].operationId === operation.operationId;
}

function governedOpenApiToolCall(operation = {}, argumentsValue = {}) {
  return {
    name: operation.toolName,
    toolId: operation.toolId,
    operationId: operation.operationId,
    contractDigest: operation.contractDigest,
    action: operation.action,
    capabilities: [...operation.capabilities],
    risk: operation.risk,
    confirmationPolicy: operation.confirmationPolicy,
    scope: [...operation.scope],
    writebackBoundary: operation.writebackBoundary,
    writePolicyDigest: operation.writePolicyDigest,
    arguments: argumentsValue,
    displayName: operation.summary,
  };
}

function sameGovernedOpenApiCall(toolCall = {}, operation = {}) {
  const expected = governedOpenApiToolCall(operation);
  return toolCall.name === expected.name &&
    toolCall.toolId === expected.toolId &&
    toolCall.operationId === expected.operationId &&
    toolCall.contractDigest === expected.contractDigest &&
    toolCall.action === expected.action &&
    sameStringSet(toolCall.capabilities, expected.capabilities) &&
    toolCall.risk === expected.risk &&
    toolCall.confirmationPolicy === expected.confirmationPolicy &&
    toolCall.writebackBoundary === expected.writebackBoundary &&
    toolCall.writePolicyDigest === expected.writePolicyDigest &&
    sameStringSet(toolCall.scope, expected.scope);
}

function compileParameters(document, values = []) {
  const byLocationAndName = new Map();
  for (const raw of values) {
    const parameter = resolveReference(document, raw, []);
    if (!isObject(parameter) || !["path", "query", "header"].includes(parameter.in)) continue;
    const name = cleanText(parameter.name, 160);
    if (!name || (parameter.in === "header" && SENSITIVE_PARAMETER.test(name))) continue;
    const schema = canonicalSchema(document, parameter.schema || { type: "string" }, []);
    byLocationAndName.set(`${parameter.in}:${name.toLowerCase()}`, Object.freeze({
      description: cleanText(parameter.description, 1_000),
      explode: parameter.explode,
      in: parameter.in,
      name,
      required: parameter.in === "path" || parameter.required === true,
      schema,
      style: cleanText(parameter.style, 80),
    }));
  }
  return Object.freeze([...byLocationAndName.values()]);
}

function compileRequestBody(document, rawRequestBody) {
  if (!rawRequestBody) return null;
  const requestBody = resolveReference(document, rawRequestBody, []);
  const entries = Object.entries(requestBody?.content || {});
  const [contentType, media] = entries.find(([type]) => type === "application/json") ||
    entries.find(([type]) => type.endsWith("+json")) || [];
  if (!contentType || !media?.schema) {
    const [multipartContentType, multipartMedia] = entries.find(([type]) => type === "multipart/form-data") || [];
    if (multipartContentType && multipartMedia?.schema) {
      const schema = canonicalSchema(document, multipartMedia.schema, []);
      const binaryFields = multipartBinaryFields(schema);
      const supported = schema.type === "object" && schema.additionalProperties === false && binaryFields.length > 0 &&
        Object.values(schema.properties || {}).every((property) => multipartPropertySupported(property));
      return Object.freeze({
        binaryFields,
        contentType: multipartContentType,
        contentTypes: [multipartContentType],
        required: requestBody.required === true,
        schema,
        supported,
      });
    }
  }
  if (!contentType || !media?.schema) {
    return Object.freeze({
      contentType: "",
      contentTypes: cleanList(entries.map(([type]) => type), 20),
      required: requestBody?.required === true,
      schema: {},
      supported: false,
    });
  }
  return Object.freeze({ contentType, contentTypes: [contentType], required: requestBody.required === true, schema: canonicalSchema(document, media.schema, []), supported: true });
}

function materialReferenceSchema(requestBody = {}, materialInputIds = []) {
  const schema = structuredClone(requestBody.schema || {});
  if (requestBody.contentType !== "multipart/form-data" || !Array.isArray(requestBody.binaryFields)) return schema;
  const allowedInputIds = [...new Set((Array.isArray(materialInputIds) ? materialInputIds : []).map((value) => cleanText(value, 160)).filter(Boolean))];
  for (const field of requestBody.binaryFields) {
    if (!schema.properties?.[field]) continue;
    schema.properties[field] = {
      type: "string",
      ...(allowedInputIds.length ? { enum: allowedInputIds } : {}),
      ...(allowedInputIds.length ? { "x-enum-labels": allowedInputIds.map((_, index) => `当前材料 ${index + 1}`) } : {}),
      ...(cleanText(schema.properties[field].title, 160) ? { title: cleanText(schema.properties[field].title, 160) } : {}),
      description: "当前回合已授权材料的 inputId；不得传入本机路径、Base64 或文件内容。",
    };
  }
  return schema;
}

function multipartBinaryFields(schema = {}) {
  return Object.entries(schema.properties || {})
    .filter(([, property]) => property?.type === "string" && property?.format === "binary")
    .map(([name]) => name);
}

function multipartPropertySupported(property = {}) {
  if (property?.type === "string" && property?.format === "binary") return true;
  return ["string", "integer", "number", "boolean"].includes(property?.type) && !property?.format;
}

function canonicalSchema(document, rawSchema, referenceStack = []) {
  if (isObject(rawSchema) && rawSchema.$ref) {
    const reference = String(rawSchema.$ref);
    if (!reference.startsWith("#/")) throw new Error("openapi_external_reference_not_allowed");
    if (referenceStack.includes(reference)) return { type: "object", description: `Recursive OpenAPI reference ${reference}` };
    const target = reference.slice(2).split("/").reduce((current, part) => current?.[decodePointer(part)], document);
    if (!isObject(target)) throw new Error(`openapi_reference_missing:${reference}`);
    const merged = { ...target, ...Object.fromEntries(Object.entries(rawSchema).filter(([key]) => key !== "$ref")) };
    return canonicalSchema(document, merged, [...referenceStack, reference]);
  }
  const schema = rawSchema;
  if (!isObject(schema)) return {};
  const normalized = {};
  for (const [key, value] of Object.entries(schema)) {
    if (!SCHEMA_KEYS.has(key)) continue;
    if (key === "properties" && isObject(value)) {
      normalized.properties = Object.fromEntries(Object.entries(value).map(([name, child]) => [name, canonicalSchema(document, child, referenceStack)]));
    } else if (key === "items") normalized.items = canonicalSchema(document, value, referenceStack);
    else if (["allOf", "anyOf", "oneOf"].includes(key) && Array.isArray(value)) normalized[key] = value.map((child) => canonicalSchema(document, child, referenceStack));
    else if (key === "not") normalized.not = canonicalSchema(document, value, referenceStack);
    else if (key === "x-agent-managed" && value === true) normalized[key] = true;
    else if (key === "x-enum-labels" && Array.isArray(value)) normalized[key] = value.slice(0, 100).map((label) => cleanText(label, 160));
    else normalized[key] = structuredClone(value);
  }
  if (normalized["x-enum-labels"] && (
    !Array.isArray(normalized.enum) ||
    normalized["x-enum-labels"].length !== normalized.enum.length ||
    normalized["x-enum-labels"].some((label) => !label)
  )) delete normalized["x-enum-labels"];
  if (!normalized.type && normalized.properties) normalized.type = "object";
  if (schema.nullable === true) {
    if (normalized.type) normalized.type = [...new Set([...(Array.isArray(normalized.type) ? normalized.type : [normalized.type]), "null"])];
    else normalized.anyOf = [...(normalized.anyOf || []), { type: "null" }];
  }
  return normalized;
}

function resolveReference(document, value, referenceStack = []) {
  if (!isObject(value) || !value.$ref) return value;
  const reference = String(value.$ref);
  if (!reference.startsWith("#/")) throw new Error("openapi_external_reference_not_allowed");
  if (referenceStack.includes(reference)) return { type: "object", description: `Recursive OpenAPI reference ${reference}` };
  const target = reference.slice(2).split("/").reduce((current, part) => current?.[decodePointer(part)], document);
  if (!isObject(target)) throw new Error(`openapi_reference_missing:${reference}`);
  return resolveReference(document, { ...target, ...Object.fromEntries(Object.entries(value).filter(([key]) => key !== "$ref")) }, [...referenceStack, reference]);
}

function operationPolicy(rawOperation = {}, { method = "GET", operationId = "", toolId = "" } = {}) {
  const extension = isObject(rawOperation["x-digital-workforce"]) ? rawOperation["x-digital-workforce"] : {};
  const defaults = defaultPolicyForMethod(method);
  const risks = ["read_only", "controlled_write", "high_impact_write", "destructive_write"];
  const confirmations = ["not_required", "operation_allowlist", "explicit_per_call"];
  const declaredRisk = cleanText(extension.risk, 80);
  const declaredConfirmation = cleanText(extension.confirmationPolicy, 80);
  const declaredWritebackBoundary = cleanText(extension.writebackBoundary, 240);
  const sideEffectFree = extension.sideEffectFree === true && declaredRisk === "read_only" &&
    declaredConfirmation === "not_required" && declaredWritebackBoundary === "none";
  let risk = declaredRisk && !risks.includes(declaredRisk) ? "destructive_write" : cleanPolicyValue(declaredRisk, risks, defaults.risk);
  if (!SAFE_METHODS.has(method) && risk === "read_only" && !sideEffectFree) risk = defaults.risk === "read_only" ? "controlled_write" : defaults.risk;
  let confirmationPolicy = declaredConfirmation && !confirmations.includes(declaredConfirmation)
    ? "explicit_per_call"
    : cleanPolicyValue(declaredConfirmation, confirmations, defaults.confirmationPolicy);
  if (["high_impact_write", "destructive_write"].includes(risk)) confirmationPolicy = "explicit_per_call";
  const capabilities = cleanCapabilityList(extension.capabilities).length
    ? cleanCapabilityList(extension.capabilities)
    : cleanCapabilityList(extension.capability ? [extension.capability] : rawOperation.tags);
  return {
    action: cleanText(extension.action || operationId, 160),
    capabilities,
    risk,
    sideEffectFree,
    confirmationPolicy,
    scope: cleanList(extension.scope, 20).length ? cleanList(extension.scope, 20) : [`${toolId}:${SAFE_METHODS.has(method) ? "read" : "write"}`],
    writebackBoundary: cleanText(declaredWritebackBoundary || (risk === "read_only" ? "none" : `${toolId}:${operationId}`), 240),
  };
}

function compileAsyncResult(rawOperation = {}, operationId = "") {
  const extension = isObject(rawOperation["x-digital-workforce"]) ? rawOperation["x-digital-workforce"] : {};
  if (!isObject(extension.asyncResult)) return null;
  const value = extension.asyncResult;
  const resultOperationId = cleanOperationId(value.resultOperationId);
  const responsePath = cleanDataPath(value.taskReference?.responsePath);
  const argumentTarget = cleanDataPath(value.taskReference?.argumentTarget);
  const pendingStatuses = cleanStatusList(value.pendingStatuses);
  const successStatuses = cleanStatusList(value.successStatuses);
  const failureStatuses = cleanStatusList(value.failureStatuses);
  const statusPath = cleanDataPath(value.statusPath);
  const pollIntervalMs = boundedInteger(value.pollIntervalMs, 5_000, 250, 30_000);
  const timeoutMs = boundedInteger(value.timeoutMs, 240_000, pollIntervalMs, 30 * 60 * 1000);
  const allStatuses = [...pendingStatuses, ...successStatuses, ...failureStatuses];
  if (!resultOperationId || !responsePath || !argumentTarget || !statusPath || !pendingStatuses.length || !successStatuses.length ||
      new Set(allStatuses).size !== allStatuses.length) {
    throw new Error(`openapi_async_result_contract_invalid:${operationId}`);
  }
  return Object.freeze({
    contractVersion: "openapi-async-result.v1",
    failureStatuses,
    pendingStatuses,
    pollIntervalMs,
    resultOperationId,
    statusPath,
    successStatuses,
    taskReference: Object.freeze({ argumentTarget, responsePath }),
    timeoutMs,
  });
}

function compileResponseSelection(rawOperation = {}, operationId = "") {
  const extension = isObject(rawOperation["x-digital-workforce"]) ? rawOperation["x-digital-workforce"] : {};
  const value = extension.responseSelection;
  if (!isObject(value)) return null;
  const sourcePaths = cleanSelectionPaths(value.sourcePaths || [value.sourcePath]);
  const labelPaths = cleanSelectionPaths(value.labelPaths || [value.labelPath || "label", "title", "name"]);
  const valueTemplate = cleanSelectionValueTemplate(value.valueTemplate);
  const optionalValueTemplate = cleanSelectionValueTemplate(value.optionalValueTemplate);
  const evidenceTemplate = cleanSelectionValueTemplate(value.evidenceTemplate);
  const presentationLinkTemplate = cleanSelectionValueTemplate(value.presentationLinkTemplate);
  const presentationLinkLabel = cleanText(value.presentationLinkLabel, 80);
  const managedContextFields = cleanSelectionManagedContextFields(value.managedContextFields);
  const fieldId = cleanFieldId(value.fieldId || "selection");
  const fieldLabel = cleanText(value.fieldLabel || "请选择", 120);
  const title = cleanText(value.title || rawOperation.summary || operationId, 120);
  if (!sourcePaths.length || !labelPaths.length || !Object.keys(valueTemplate).length || !fieldId || !fieldLabel || !title) {
    throw new Error(`openapi_response_selection_contract_invalid:${operationId}`);
  }
  const minItems = boundedInteger(value.minItems, 2, 1, 50);
  const maxItems = boundedInteger(value.maxItems, 8, minItems, 50);
  return Object.freeze({
    contractVersion: "openapi-response-selection.v1",
    description: cleanText(value.description, 500),
    fieldId,
    fieldLabel,
    labelPaths: Object.freeze(labelPaths),
    maxItems,
    minItems,
    sourcePaths: Object.freeze(sourcePaths),
    title,
    evidenceTemplate: Object.freeze(evidenceTemplate),
    managedContextFields,
    optionalValueTemplate: Object.freeze(optionalValueTemplate),
    presentationLinkLabel,
    presentationLinkTemplate: Object.freeze(presentationLinkTemplate),
    valueTemplate: Object.freeze(valueTemplate),
  });
}

function compileResultPresentation(rawOperation = {}, operationId = "") {
  const extension = isObject(rawOperation["x-digital-workforce"]) ? rawOperation["x-digital-workforce"] : {};
  const value = extension.resultPresentation;
  if (!isObject(value)) return null;
  const linkTemplate = cleanSelectionValueTemplate(value.linkTemplate || value.presentationLinkTemplate);
  const linkLabel = cleanText(value.linkLabel || value.presentationLinkLabel, 80);
  const declaredLinks = typeof value.links === "boolean" ? value.links : cleanText(value.links, 40).toLowerCase();
  let linkMode = Object.keys(linkTemplate).length ? "template" : "auto";
  if (declaredLinks === false || declaredLinks === "none") linkMode = "none";
  else if (declaredLinks === "template") linkMode = "template";
  else if (declaredLinks === "auto") linkMode = "auto";
  if (linkMode === "template" && !Object.keys(linkTemplate).length) {
    throw new Error(`openapi_result_presentation_contract_invalid:${operationId}`);
  }
  return Object.freeze({
    contractVersion: "openapi-result-presentation.v1",
    linkLabel,
    linkMode,
    linkTemplate: Object.freeze(linkTemplate),
  });
}
function cleanSelectionPaths(value) {
  const values = Array.isArray(value) ? value : [value];
  return [...new Set(values.map((item) => cleanSelectionPath(item)).filter((item) => item !== null))].slice(0, 12);
}

function cleanSelectionPath(value = "") {
  const text = cleanText(value, 240);
  if (text === "") return "";
  if (!text.split(".").every((part) => /^[A-Za-z0-9_-]{1,80}$/.test(part) && !SENSITIVE_PARAMETER.test(part))) return null;
  return text;
}

function cleanSelectionValueTemplate(value = {}) {
  if (!isObject(value)) return {};
  return Object.fromEntries(Object.entries(value).slice(0, 12).flatMap(([key, path]) => {
    const normalizedKey = cleanFieldId(key);
    const normalizedPaths = cleanSelectionPaths(path);
    return normalizedKey && normalizedPaths.length ? [[normalizedKey, Object.freeze(normalizedPaths)]] : [];
  }));
}

function cleanSelectionManagedContextFields(value = {}) {
  const entries = Array.isArray(value)
    ? value
    : isObject(value)
      ? Object.entries(value).map(([fieldId, config]) => ({ fieldId, ...(isObject(config) ? config : { aliases: config }) }))
      : [];
  return Object.freeze(entries.slice(0, 20).flatMap((entry) => {
    const fieldId = cleanFieldId(entry.fieldId || entry.field || entry.id);
    if (!fieldId) return [];
    const aliases = cleanList(entry.aliases || entry.labels || entry.match || [], 30);
    return [Object.freeze({
      fieldId,
      aliases: Object.freeze([...new Set([fieldId, ...aliases].filter(Boolean))]),
    })];
  }));
}

function cleanFieldId(value = "") {
  return String(value || "").trim().replace(/[^A-Za-z0-9_.:-]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 120);
}

function validateAsyncResultOperations(operations = []) {
  const byId = new Map(operations.map((operation) => [operation.operationId, operation]));
  for (const operation of operations) {
    if (!operation.asyncResult) continue;
    const resultOperation = byId.get(operation.asyncResult.resultOperationId);
    const [location, parameterName, ...extra] = operation.asyncResult.taskReference.argumentTarget.split(".");
    const parameter = resultOperation?.parameters?.find((item) => item.in === location && item.name === parameterName);
    if (operation.risk === "read_only" || !resultOperation || resultOperation.risk !== "read_only" ||
        resultOperation.asyncResult || extra.length || !["path", "query"].includes(location) || !parameter) {
      throw new Error(`openapi_async_result_operation_invalid:${operation.operationId}`);
    }
  }
}

function defaultPolicyForMethod(method = "GET") {
  if (SAFE_METHODS.has(method)) return { risk: "read_only", confirmationPolicy: "not_required" };
  if (method === "POST" || method === "DELETE") return { risk: method === "DELETE" ? "destructive_write" : "high_impact_write", confirmationPolicy: "explicit_per_call" };
  return { risk: "controlled_write", confirmationPolicy: "operation_allowlist" };
}

function cleanCapabilityList(value, max = 20) {
  return [...new Set(cleanList(value, max).map((item) => item.toLowerCase()))];
}

function cleanDataPath(value = "") {
  const path = cleanText(value, 240);
  return path && path.split(".").every((part) => /^[A-Za-z0-9_-]{1,80}$/.test(part)) ? path : "";
}

function cleanStatusList(value) {
  return cleanList(value, 20).map((item) => item.toLowerCase());
}

function boundedInteger(value, fallback, minimum, maximum) {
  const number = Number(value);
  return Number.isSafeInteger(number) ? Math.min(maximum, Math.max(minimum, number)) : fallback;
}

function sortedStringSet(value) {
  return [...new Set((Array.isArray(value) ? value : []).map((item) => String(item)))].sort();
}

function validateJsonValue(schema = {}, value, path = "value") {
  if (Array.isArray(schema.anyOf)) {
    return schema.anyOf.some((candidate) => validateJsonValue(candidate, value, path).ok) ? { ok: true } : { ok: false, message: `${path} 不符合 anyOf 合同。` };
  }
  if (Array.isArray(schema.oneOf)) {
    return schema.oneOf.filter((candidate) => validateJsonValue(candidate, value, path).ok).length === 1 ? { ok: true } : { ok: false, message: `${path} 不符合 oneOf 合同。` };
  }
  if (Array.isArray(schema.allOf)) {
    const failure = schema.allOf.map((candidate) => validateJsonValue(candidate, value, path)).find((result) => !result.ok);
    return failure || { ok: true };
  }
  if (schema.not && validateJsonValue(schema.not, value, path).ok) return { ok: false, message: `${path} 命中了 OpenAPI not 合同。` };
  if (Object.hasOwn(schema, "const") && JSON.stringify(schema.const) !== JSON.stringify(value)) return { ok: false, message: `${path} 不等于 OpenAPI const。` };
  if (Array.isArray(schema.enum) && !schema.enum.some((candidate) => JSON.stringify(candidate) === JSON.stringify(value))) return { ok: false, message: `${path} 不在 enum 合同中。` };
  const types = Array.isArray(schema.type) ? schema.type : schema.type ? [schema.type] : [];
  if (types.length && !types.some((type) => jsonTypeMatches(type, value))) return { ok: false, message: `${path} 类型不符合 OpenAPI 合同。` };
  if (value === null || value === undefined) return { ok: true };
  if (typeof value === "number") {
    if (Number.isFinite(schema.minimum) && value < schema.minimum) return { ok: false, message: `${path} 小于 minimum。` };
    if (Number.isFinite(schema.maximum) && value > schema.maximum) return { ok: false, message: `${path} 大于 maximum。` };
    if (Number.isFinite(schema.exclusiveMinimum) && value <= schema.exclusiveMinimum) return { ok: false, message: `${path} 不满足 exclusiveMinimum。` };
    if (Number.isFinite(schema.exclusiveMaximum) && value >= schema.exclusiveMaximum) return { ok: false, message: `${path} 不满足 exclusiveMaximum。` };
    if (Number.isFinite(schema.multipleOf) && schema.multipleOf > 0 && Math.abs(value / schema.multipleOf - Math.round(value / schema.multipleOf)) > Number.EPSILON) return { ok: false, message: `${path} 不满足 multipleOf。` };
  }
  if (typeof value === "string") {
    if (Number.isInteger(schema.minLength) && value.length < schema.minLength) return { ok: false, message: `${path} 短于 minLength。` };
    if (Number.isInteger(schema.maxLength) && value.length > schema.maxLength) return { ok: false, message: `${path} 长于 maxLength。` };
    if (schema.pattern) {
      try {
        if (!new RegExp(schema.pattern, "u").test(value)) return { ok: false, message: `${path} 不符合 pattern。` };
      } catch {
        return { ok: false, message: `${path} 的 OpenAPI pattern 无效。` };
      }
    }
  }
  if ((types.includes("object") || schema.properties) && isObject(value)) {
    const required = new Set(schema.required || []);
    const missing = [...required].find((name) => value[name] === undefined);
    if (missing) return { ok: false, message: `${path}.${missing} 是必填字段。` };
    if (schema.additionalProperties === false) {
      const unexpected = Object.keys(value).find((name) => !Object.hasOwn(schema.properties || {}, name));
      if (unexpected) return { ok: false, message: `${path}.${unexpected} 未在 OpenAPI 合同中声明。` };
    }
    if (Number.isInteger(schema.minProperties) && Object.keys(value).length < schema.minProperties) return { ok: false, message: `${path} 少于 minProperties。` };
    if (Number.isInteger(schema.maxProperties) && Object.keys(value).length > schema.maxProperties) return { ok: false, message: `${path} 多于 maxProperties。` };
    for (const [name, child] of Object.entries(value)) {
      const childSchema = schema.properties?.[name];
      const fallbackSchema = isObject(schema.additionalProperties) ? schema.additionalProperties : null;
      if (!childSchema && !fallbackSchema) continue;
      const result = validateJsonValue(childSchema || fallbackSchema, child, `${path}.${name}`);
      if (!result.ok) return result;
    }
  }
  if (types.includes("array") && Array.isArray(value)) {
    if (Number.isInteger(schema.minItems) && value.length < schema.minItems) return { ok: false, message: `${path} 少于 minItems。` };
    if (Number.isInteger(schema.maxItems) && value.length > schema.maxItems) return { ok: false, message: `${path} 多于 maxItems。` };
    if (schema.uniqueItems === true && new Set(value.map((item) => stableJson(item))).size !== value.length) return { ok: false, message: `${path} 不满足 uniqueItems。` };
    for (let index = 0; index < value.length; index += 1) {
      const result = validateJsonValue(schema.items || {}, value[index], `${path}[${index}]`);
      if (!result.ok) return result;
    }
  }
  return { ok: true };
}

function appendQueryParameter(searchParams, parameter, value) {
  if (parameter.style === "deepObject" && isObject(value)) {
    Object.entries(value).forEach(([key, item]) => searchParams.append(`${parameter.name}[${key}]`, serializePrimitive(item)));
  } else if (Array.isArray(value) && parameter.explode !== false) value.forEach((item) => searchParams.append(parameter.name, serializePrimitive(item)));
  else if (isObject(value) && parameter.explode !== false) Object.entries(value).forEach(([key, item]) => searchParams.append(key, serializePrimitive(item)));
  else searchParams.append(parameter.name, Array.isArray(value) ? value.map(serializePrimitive).join(",") : isObject(value) ? Object.entries(value).flat().map(serializePrimitive).join(",") : serializePrimitive(value));
}

function openApiContractDigest(document = {}) {
  return `sha256:${crypto.createHash("sha256").update(stableJson(document)).digest("hex")}`;
}

function isWriteOpenApiOperation(operation = {}) {
  const method = cleanText(operation.method, 10).toUpperCase();
  if (operation.sideEffectFree === true && cleanText(operation.risk, 80) === "read_only") return false;
  return !SAFE_METHODS.has(method) || cleanText(operation.risk, 80) !== "read_only";
}

function capabilityWritePolicyDigests(operations = [], capabilities = []) {
  const compiled = Array.isArray(operations) ? operations : [];
  const requestedCapabilities = cleanCapabilityList(capabilities, 100);
  const capabilityIds = (requestedCapabilities.length
    ? requestedCapabilities
    : cleanCapabilityList(compiled.flatMap((operation) => operation?.capabilities || []), 100))
    .sort();
  return Object.fromEntries(capabilityIds.map((capability) => {
    const operationDigests = compiled
      .filter((operation) => isWriteOpenApiOperation(operation) && cleanCapabilityList(operation.capabilities).includes(capability))
      .map((operation) => operation.writePolicyDigest || writeOpenApiOperationDigest(operation))
      .filter(Boolean)
      .sort();
    return [capability, digestPolicyValue({
      contractVersion: CAPABILITY_WRITE_POLICY_CONTRACT,
      capability,
      operationDigests,
    })];
  }));
}

function writeOpenApiOperationDigest(operation = {}) {
  if (!isWriteOpenApiOperation(operation)) return "";
  const parameters = (Array.isArray(operation.parameters) ? operation.parameters : [])
    .map(writePolicyParameter)
    .sort((left, right) => `${left.in}:${left.name}`.localeCompare(`${right.in}:${right.name}`));
  return digestPolicyValue({
    contractVersion: WRITE_OPERATION_POLICY_CONTRACT,
    operation: {
      action: cleanText(operation.action, 160),
      capabilities: sortedStringSet(operation.capabilities),
      confirmationPolicy: cleanText(operation.confirmationPolicy, 80),
      executable: operation.executable !== false,
      method: cleanText(operation.method, 10).toUpperCase(),
      operationId: cleanOperationId(operation.operationId),
      operationIdSource: cleanText(operation.operationIdSource, 80),
      parameters,
      path: cleanText(operation.path, 2_000),
      requestBody: writePolicyRequestBody(operation.requestBody),
      risk: cleanText(operation.risk, 80),
      scope: sortedStringSet(operation.scope),
      toolId: cleanText(operation.toolId, 240),
      writebackBoundary: cleanText(operation.writebackBoundary, 240),
    },
  });
}

function writePolicyParameter(parameter = {}) {
  const location = cleanText(parameter.in, 20);
  return {
    ...(typeof parameter.explode === "boolean" ? { explode: parameter.explode } : {}),
    in: location,
    name: location === "header" ? cleanText(parameter.name, 160).toLowerCase() : cleanText(parameter.name, 160),
    required: parameter.required === true,
    schema: writePolicySchema(parameter.schema),
    ...(cleanText(parameter.style, 80) ? { style: cleanText(parameter.style, 80) } : {}),
  };
}

function writePolicyRequestBody(requestBody) {
  if (!requestBody) return null;
  return {
    contentType: cleanText(requestBody.contentType, 240),
    contentTypes: sortedStringSet(requestBody.contentTypes),
    required: requestBody.required === true,
    schema: writePolicySchema(requestBody.schema),
    supported: requestBody.supported !== false,
  };
}

function writePolicySchema(schema) {
  if (!isObject(schema)) return {};
  const normalized = {};
  for (const [key, value] of Object.entries(schema)) {
    if (["description", "title", "x-agent-managed", "x-enum-labels"].includes(key)) continue;
    if (key === "properties" && isObject(value)) {
      normalized.properties = Object.fromEntries(Object.entries(value).map(([name, child]) => [name, writePolicySchema(child)]));
    } else if (["additionalProperties", "items", "not"].includes(key) && isObject(value)) {
      normalized[key] = writePolicySchema(value);
    } else if (["allOf", "anyOf", "oneOf"].includes(key) && Array.isArray(value)) {
      normalized[key] = value.map(writePolicySchema).sort((left, right) => stableJson(left).localeCompare(stableJson(right)));
    } else if (["required", "type"].includes(key) && Array.isArray(value)) {
      normalized[key] = sortedStringSet(value);
    } else if (key === "enum" && Array.isArray(value)) {
      normalized.enum = [...value].map((item) => structuredClone(item)).sort((left, right) => stableJson(left).localeCompare(stableJson(right)));
    } else {
      normalized[key] = structuredClone(value);
    }
  }
  return normalized;
}

function digestPolicyValue(value) {
  return `sha256:${crypto.createHash("sha256").update(stableJson(value)).digest("hex")}`;
}

function mergeOpenApiDocuments(baseDocument = {}, overlayDocuments = []) {
  assertOpenApiDocument(baseDocument);
  const merged = structuredClone(baseDocument);
  const overlays = Array.isArray(overlayDocuments) ? overlayDocuments : [];
  for (const overlayDocument of overlays) {
    assertOpenApiDocument(overlayDocument);
    const basePath = documentServerBasePath(merged);
    for (const [rawPath, pathItem] of Object.entries(overlayDocument.paths)) {
      const relativePath = basePath && (rawPath === basePath || rawPath.startsWith(`${basePath}/`)) ? rawPath.slice(basePath.length) || "/" : rawPath;
      const normalizedPath = relativePath !== rawPath && (merged.paths[relativePath] || !merged.paths[rawPath]) ? relativePath : rawPath;
      merged.paths[normalizedPath] = mergePathItems(merged.paths[normalizedPath], pathItem);
    }
    merged.components = mergeComponentMaps(merged.components, overlayDocument.components);
    merged.tags = mergeNamedEntries(merged.tags, overlayDocument.tags);
  }
  compileOpenApiOperations({ document: merged, toolId: "openapi-contract-validation", toolNamePrefix: "openapi" });
  return merged;
}

function mergePathItems(baseItem = {}, overlayItem = {}) {
  if (!isObject(baseItem)) return structuredClone(overlayItem);
  return { ...structuredClone(baseItem), ...structuredClone(overlayItem) };
}

function mergeComponentMaps(baseComponents = {}, overlayComponents = {}) {
  const merged = isObject(baseComponents) ? structuredClone(baseComponents) : {};
  if (!isObject(overlayComponents)) return merged;
  for (const [group, values] of Object.entries(overlayComponents)) {
    merged[group] = isObject(values)
      ? { ...(isObject(merged[group]) ? merged[group] : {}), ...structuredClone(values) }
      : structuredClone(values);
  }
  return merged;
}

function mergeNamedEntries(baseEntries = [], overlayEntries = []) {
  const entries = [...(Array.isArray(baseEntries) ? baseEntries : []), ...(Array.isArray(overlayEntries) ? overlayEntries : [])];
  return [...new Map(entries.filter(isObject).map((entry) => [cleanText(entry.name, 240), structuredClone(entry)])).values()];
}

function documentServerBasePath(document = {}) {
  const serverUrl = cleanText(document.servers?.[0]?.url, 2_000);
  if (!serverUrl || !serverUrl.startsWith("/")) return "";
  return serverUrl.replace(/\/+$/, "") || "/";
}

function openApiToolName(prefix = "", operationId = "") {
  const base = `${cleanToolPart(prefix) || "openapi"}__${cleanToolPart(operationId) || "operation"}`;
  if (base.length <= 64) return base;
  const digest = crypto.createHash("sha256").update(base).digest("hex").slice(0, 10);
  return `${base.slice(0, 53)}_${digest}`;
}

function methodPathOperationId(method = "get", path = "/") {
  const segments = String(path || "/").split("/").filter(Boolean).map((segment) => {
    const parameter = segment.match(/^\{([^}]+)\}$/)?.[1];
    return parameter ? `by_${cleanToolPart(parameter) || "parameter"}` : cleanToolPart(segment);
  }).filter(Boolean);
  const base = `${String(method || "get").toLowerCase()}_${segments.join("_") || "root"}`;
  if (base.length <= 180) return base;
  const digest = crypto.createHash("sha256").update(`${method}:${path}`).digest("hex").slice(0, 12);
  return `${base.slice(0, 167)}_${digest}`;
}

function safeApiBaseUrl(value = "") {
  try {
    const url = new URL(String(value || "").trim());
    if (!safeOrigin(url) || url.username || url.password) return "";
    url.pathname = url.pathname.replace(/\/+$/, "");
    url.search = "";
    url.hash = "";
    return url.toString().replace(/\/$/, "");
  } catch { return ""; }
}

function safeOrigin(url) {
  return url.protocol === "https:" || (url.protocol === "http:" && ["localhost", "127.0.0.1", "::1", "[::1]"].includes(url.hostname));
}

function assertOpenApiDocument(document) {
  if (!isObject(document) || !/^3\.[01](?:\.|$)/.test(String(document.openapi || "")) || !isObject(document.paths)) throw new Error("openapi_document_invalid");
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (isObject(value)) return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
  return JSON.stringify(value);
}

function jsonTypeMatches(type, value) {
  if (type === "null") return value === null;
  if (type === "array") return Array.isArray(value);
  if (type === "object") return isObject(value);
  if (type === "integer") return Number.isInteger(value);
  if (type === "number") return typeof value === "number" && Number.isFinite(value);
  return typeof value === type;
}

function serializePrimitive(value) { return typeof value === "string" ? value : JSON.stringify(value); }
function decodePointer(value) { return value.replaceAll("~1", "/").replaceAll("~0", "~"); }
function cleanOperationId(value = "") { return String(value || "").trim().replace(/[^A-Za-z0-9_.-]+/g, "_").slice(0, 180); }
function cleanToolPart(value = "") { return String(value || "").trim().replace(/[^A-Za-z0-9_-]+/g, "_").replace(/^_+|_+$/g, ""); }
function cleanText(value = "", max = 4_000) { return String(value || "").trim().slice(0, max); }
function cleanList(value, max = 100) { return Array.isArray(value) ? [...new Set(value.map((item) => cleanText(item, 240)).filter(Boolean))].slice(0, max) : []; }
function cleanPolicyValue(value, allowed, fallback) { const clean = cleanText(value, 80); return allowed.includes(clean) ? clean : fallback; }
function isObject(value) { return Boolean(value) && typeof value === "object" && !Array.isArray(value); }
function sameStringSet(left, right) { if (!Array.isArray(left) || !Array.isArray(right)) return false; const l = [...left].sort(), r = [...right].sort(); return l.length === r.length && l.every((value, index) => value === r[index]); }

export {
  buildOpenApiRequest,
  capabilityWritePolicyDigests,
  compileOpenApiOperations,
  governedOpenApiToolCall,
  isWriteOpenApiOperation,
  normalizeOpenApiArguments,
  openApiContractDigest,
  openApiToolDefinition,
  operationArgumentSchema,
  operationAllowedByBinding,
  mergeOpenApiDocuments,
  safeApiBaseUrl,
  sameGovernedOpenApiCall,
  validateJsonValue,
};
