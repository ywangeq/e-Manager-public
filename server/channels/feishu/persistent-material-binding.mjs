import crypto from "node:crypto";
import { cleanShortText } from "../../feishu-integration-support.mjs";
import { extractFeishuMessageResources } from "./runtime-intake.mjs";

const FEISHU_MATERIAL_BINDING_ADAPTER_ID = "feishu-message-resource.v1";
const FEISHU_MATERIAL_BINDING_TTL_MS = 24 * 60 * 60 * 1000;

function createFeishuMaterialBindingDescriptor({ messages = [], now = new Date() } = {}) {
  const resources = normalizedMessageResources(messages);
  if (!resources.length) return null;
  const createdAt = normalizedDate(now);
  return Object.freeze({
    contractVersion: "task-material-binding-descriptor.v1",
    adapterId: FEISHU_MATERIAL_BINDING_ADAPTER_ID,
    sourceKind: "channel_resource",
    sourceIdentityDigest: resourceIdentityDigest(resources),
    expiresAt: new Date(createdAt.getTime() + FEISHU_MATERIAL_BINDING_TTL_MS).toISOString(),
    payload: Object.freeze({
      contractVersion: "feishu-material-binding-payload.v1",
      resources: Object.freeze(resources),
    }),
  });
}

function feishuResourcesFromTaskMaterialBinding(binding = {}) {
  if (binding.contractVersion !== "task-material-binding.v1" || binding.sourceKind !== "channel_resource" ||
    binding.adapterId !== FEISHU_MATERIAL_BINDING_ADAPTER_ID) {
    throw materialBindingError("feishu_material_binding_invalid");
  }
  const payload = binding.payload;
  if (!exactObject(payload, ["contractVersion", "resources"]) || payload.contractVersion !== "feishu-material-binding-payload.v1") {
    throw materialBindingError("feishu_material_binding_invalid");
  }
  const resources = normalizeResources(payload.resources);
  if (binding.sourceIdentityDigest !== resourceIdentityDigest(resources)) {
    throw materialBindingError("feishu_material_binding_source_mismatch");
  }
  return resources;
}

function normalizedMessageResources(messages) {
  const sourceMessages = Array.isArray(messages) ? messages : [];
  return normalizeResources(sourceMessages.flatMap((message) => {
    const messageId = cleanShortText(message?.message_id || message?.messageId);
    return extractFeishuMessageResources(message).map((resource) => ({
      fileKey: cleanShortText(resource.fileKey),
      messageId,
      messageType: cleanShortText(resource.messageType),
      name: cleanShortText(resource.name),
    }));
  }));
}

function normalizeResources(values) {
  if (!Array.isArray(values) || !values.length || values.length > 8) throw materialBindingError("feishu_material_binding_resource_invalid");
  return Object.freeze(values.map((value) => {
    if (!exactObject(value, ["fileKey", "messageId", "messageType", "name"])) throw materialBindingError("feishu_material_binding_resource_invalid");
    const resource = {
      fileKey: boundedToken(value.fileKey, 512),
      messageId: boundedToken(value.messageId, 256),
      messageType: boundedToken(value.messageType, 80),
      name: boundedName(value.name),
    };
    return Object.freeze(resource);
  }));
}

function resourceIdentityDigest(resources) {
  return crypto.createHash("sha256").update(JSON.stringify([
    FEISHU_MATERIAL_BINDING_ADAPTER_ID,
    ...resources.map((resource) => [resource.messageId, resource.fileKey, resource.messageType]),
  ])).digest("hex");
}

function boundedToken(value, maxLength) {
  const text = cleanShortText(value);
  if (!text || text.length > maxLength || /[\0\r\n]/.test(text)) throw materialBindingError("feishu_material_binding_resource_invalid");
  return text;
}

function boundedName(value) {
  const name = boundedToken(value, 180);
  if (name === "." || name === ".." || /[\\/]/.test(name)) throw materialBindingError("feishu_material_binding_resource_invalid");
  return name;
}

function exactObject(value, fields) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value) &&
    Object.keys(value).length === fields.length && Object.keys(value).every((field) => fields.includes(field)));
}

function normalizedDate(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) throw materialBindingError("feishu_material_binding_clock_invalid");
  return date;
}

function materialBindingError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

export {
  FEISHU_MATERIAL_BINDING_ADAPTER_ID,
  FEISHU_MATERIAL_BINDING_TTL_MS,
  createFeishuMaterialBindingDescriptor,
  feishuResourcesFromTaskMaterialBinding,
};
