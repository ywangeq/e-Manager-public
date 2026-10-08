import crypto from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FEISHU_APPROVAL_OPENAPI_FILE = path.join(__dirname, "..", "..", "contracts", "feishu-approval.openapi.json");
const FEISHU_VC_MINUTES_OPENAPI_FILE = path.join(__dirname, "..", "..", "contracts", "feishu-vc-minutes.openapi.json");

function createFeishuManagedOpenApiTools({ feishuEmployeeAppTokenLeaseService = null, managedReferenceCatalogStore = null } = {}) {
  const approvalDefinitionCache = new Map();
  return [{
    baseUrl: "https://open.feishu.cn",
    managedArgumentAvailability: feishuApprovalManagedArgumentAvailability,
    managedArgumentResolver: (input) => resolveFeishuApprovalManagedArguments(input, { approvalDefinitionCache }),
    managedToolCredentialLeaseService: feishuEmployeeAppTokenLeaseService,
    responseNormalizer: (input) => normalizeFeishuApprovalResponse(input, { approvalDefinitionCache }),
    managedReferenceCatalogId: "reviewed_it_approval_definitions",
    managedReferenceCatalogStore,
    openApiFile: FEISHU_APPROVAL_OPENAPI_FILE,
    toolId: "feishu-approval-openapi",
    toolNamePrefix: "feishu_approval",
    unavailableMessage: "飞书审批 Tool 尚未载入受管合同或员工应用凭证。",
  }, {
    baseUrl: "https://open.feishu.cn",
    openApiFile: FEISHU_VC_MINUTES_OPENAPI_FILE,
    toolId: "feishu-vc-minutes-openapi",
    toolNamePrefix: "feishu_training",
    unavailableMessage: "飞书会议与妙记 Tool 尚未载入受管合同。",
  }];
}

function feishuApprovalManagedArgumentAvailability({ executionIdentity = null, operation = {} } = {}) {
  const subjectReady = /^ou_[A-Za-z0-9_-]{8,200}$/.test(String(executionIdentity?.subjectId || "").trim());
  if (operation.operationId === "approval.instances.preview") {
    return {
      status: subjectReady ? "ready" : "unavailable",
      argumentPaths: ["query.user_id_type", "body.user_id"],
    };
  }
  if (operation.operationId === "approval.instances.create") {
    return {
      status: subjectReady ? "ready" : "unavailable",
      argumentPaths: ["body.open_id", "body.uuid"],
    };
  }
  return null;
}

function normalizeFeishuApprovalResponse({ arguments: argumentsValue = {}, data = {}, operation = {} } = {}, { approvalDefinitionCache = null } = {}) {
  if (operation.operationId !== "approval.definitions.get" || typeof data.form !== "string") return data;
  const fields = parseApprovalFormFields(data.form);
  if (!fields) return data;
  rememberApprovalDefinitionFields(approvalDefinitionCache, argumentsValue.path?.approvalCode, fields);
  const { form, ...rest } = data;
  return { ...rest, fields };
}

function parseApprovalFormFields(value = "") {
  if (Buffer.byteLength(value, "utf8") > 200_000) return null;
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function resolveFeishuApprovalManagedArguments({
  arguments: input = {},
  callId = "",
  confirmationReviewArguments = {},
  executionIdentity = null,
  operation = {},
} = {}, { approvalDefinitionCache = null } = {}) {
  const argumentsValue = structuredClone(input);
  const subjectId = String(executionIdentity?.subjectId || "").trim();
  if (["approval.instances.preview", "approval.instances.create"].includes(operation.operationId) && !/^ou_[A-Za-z0-9_-]{8,200}$/.test(subjectId)) {
    return { ok: false, error: "current_user_identity_required", message: "当前会话缺少可验证的飞书用户身份，不能准备审批。" };
  }
  if (operation.operationId === "approval.instances.preview") {
    argumentsValue.query = { ...(argumentsValue.query || {}), user_id_type: "open_id" };
    argumentsValue.body = { ...(argumentsValue.body || {}), user_id: subjectId };
    normalizeFeishuApprovalFormBody(argumentsValue, {
      definitionFields: approvalDefinitionFieldsFor(approvalDefinitionCache, argumentsValue.body?.approval_code),
    });
  }
  if (operation.operationId === "approval.instances.create") {
    argumentsValue.body = {
      ...(argumentsValue.body || {}),
      open_id: subjectId,
      uuid: String(callId).startsWith("confirmation:") && validUuid(argumentsValue.body?.uuid)
        ? argumentsValue.body.uuid
        : crypto.randomUUID(),
    };
    normalizeFeishuApprovalFormBody(argumentsValue, {
      definitionFields: approvalDefinitionFieldsFor(approvalDefinitionCache, argumentsValue.body?.approval_code),
    });
  }
  return {
    ok: true,
    arguments: argumentsValue,
    ...(operation.operationId === "approval.instances.create"
      ? { confirmationReviewArguments: approvalCreateBusinessSummary(confirmationReviewArguments) }
      : {}),
  };
}

function approvalCreateBusinessSummary(value = {}) {
  const approvalType = String(value.body?.approval_code || "IT 审批申请").trim().slice(0, 120);
  const fields = parseApprovalFormFields(String(value.body?.form || "")) || [];
  const requirement = fields.map((field) => String(field?.value || "").trim()).find(Boolean) || "";
  return {
    businessSummary: {
      effect: "确认后将创建 1 条审批申请",
      items: [
        { label: "申请类型", value: approvalType },
        ...(requirement ? [{ label: "需求说明", value: requirement }] : []),
      ],
    },
  };
}

function normalizeFeishuApprovalFormBody(argumentsValue = {}, { definitionFields = [] } = {}) {
  const form = argumentsValue.body?.form;
  const normalizedForm = Array.isArray(form)
    ? form
    : normalizeFeishuApprovalFormObject(form);
  if (!normalizedForm) return;
  argumentsValue.body = {
    ...argumentsValue.body,
    form: JSON.stringify(enrichApprovalFormWithDefinitionFields(normalizedForm, definitionFields)),
  };
}

function normalizeFeishuApprovalFormObject(form) {
  if (!form || typeof form !== "object" || Array.isArray(form)) return null;
  if (typeof form.id === "string" && Object.hasOwn(form, "value")) return [form];
  const entries = Object.entries(form);
  if (!entries.length || entries.some(([, value]) => value !== null && typeof value === "object")) return null;
  return entries.map(([id, value]) => ({ id, value }));
}

function enrichApprovalFormWithDefinitionFields(form = [], definitionFields = []) {
  const fieldsById = new Map((Array.isArray(definitionFields) ? definitionFields : [])
    .flatMap((field) => {
      const id = String(field?.id || "").trim();
      const type = String(field?.type || "").trim();
      return id && type ? [[id, { type }]] : [];
    }));
  if (!fieldsById.size) return form;
  return form.map((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return item;
    const id = String(item.id || "").trim();
    const field = fieldsById.get(id);
    if (!field || String(item.type || "").trim()) return item;
    return { ...item, type: field.type };
  });
}

function rememberApprovalDefinitionFields(cache, approvalCode = "", fields = []) {
  if (!(cache instanceof Map)) return;
  const key = String(approvalCode || "").trim();
  if (!key) return;
  const safeFields = (Array.isArray(fields) ? fields : []).slice(0, 200).flatMap((field) => {
    const id = String(field?.id || "").trim().slice(0, 160);
    const type = String(field?.type || "").trim().slice(0, 80);
    const name = String(field?.name || "").trim().slice(0, 160);
    return id && type ? [{ id, type, ...(name ? { name } : {}) }] : [];
  });
  if (safeFields.length) cache.set(key, safeFields);
}

function approvalDefinitionFieldsFor(cache, approvalCode = "") {
  if (!(cache instanceof Map)) return [];
  return structuredClone(cache.get(String(approvalCode || "").trim()) || []);
}

function validUuid(value) {
  return /^[A-Za-z0-9-]{16,64}$/.test(String(value || "").trim());
}

export {
  createFeishuManagedOpenApiTools,
  feishuApprovalManagedArgumentAvailability,
  normalizeFeishuApprovalResponse,
  resolveFeishuApprovalManagedArguments,
};
