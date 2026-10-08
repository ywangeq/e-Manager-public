import {
  FXIAOKE_CUSTOM_FIND_ONE_PATH,
  createFxiaokeCrmExactObjectReader,
} from "../../agent-runtime/fxiaoke-crm-exact-object-reader.mjs";

const ADAPTER_VERSION = "fxiaoke-trigger-object-material-adapter.v5";
const MATERIAL_VERSION = "trigger-material-reference.v2";
const CUSTOM_FIND_ONE_PATH = FXIAOKE_CUSTOM_FIND_ONE_PATH;
const FILE_PRESIGN_PATH = "/cgi/crm/v2/file/getPresignedUrl";
const OPAQUE_REFERENCE = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,239}$/;
const SUBJECT_MATERIAL_BINDING_VERSION = "subject-material-policy.v1";
const SUBJECT_MAX_ATTACHMENT_COUNT = 20;
const SUBJECT_MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;

function createFxiaokeTriggerObjectMaterialAdapter({
  isAllowedDownloadUrl = null,
  requestJson,
} = {}) {
  if (typeof requestJson !== "function") throw new TypeError("Fxiaoke material adapter requires requestJson");
  if (isAllowedDownloadUrl !== null && typeof isAllowedDownloadUrl !== "function") {
    throw new TypeError("isAllowedDownloadUrl must be a function");
  }
  const exactObjectReader = createFxiaokeCrmExactObjectReader({ requestJson });
  const subjectDownloadUrls = new WeakMap();

  async function acquireReferences({ binding, subject, signal = null } = {}) {
    const safeSubject = normalizeSubject(subject);
    assertBinding(binding, safeSubject);
    const objectData = await readMaterialObject(exactObjectReader, {
      action: "read_trigger_material_record",
      fieldProjection: binding.fieldProjection,
      mode: binding.recordReadMode,
      signal,
      subject: safeSubject,
    });
    const form = projectTransientForm(objectData, binding);
    const normalizedAttachments = [];
    let attachmentSchemaInvalid = false;
    for (const fieldApiName of binding.attachmentFields) {
      try {
        normalizedAttachments.push(...normalizeAttachments(
          objectData[fieldApiName],
          fieldApiName,
          binding,
        ));
      } catch (error) {
        if (error?.code !== "crm_material_attachment_schema_invalid") throw error;
        attachmentSchemaInvalid = true;
      }
    }
    const attachments = normalizedAttachments
      .map((attachment, attachmentIndex) => Object.freeze({ ...attachment, attachmentIndex }));
    if (attachments.length > binding.maxAttachmentCount) {
      throw materialError("crm_material_attachment_count_exceeded");
    }
    if (!Object.keys(form).length && !attachments.length) {
      if (attachmentSchemaInvalid) throw materialError("crm_material_attachment_schema_invalid");
      throw materialError("crm_material_content_missing");
    }
    const reference = Object.freeze({
      contractVersion: MATERIAL_VERSION,
      materialBindingId: binding.materialBindingId,
      bindingVersion: binding.bindingVersion,
      sourceSystemId: binding.sourceSystemId,
      sourceObjectApiName: binding.sourceObjectApiName,
      sourceObjectId: safeSubject.objectId,
      form,
      attachments: Object.freeze(attachments),
    });
    return reference;
  }

  async function acquireSubjectMaterial({ subject, signal = null } = {}) {
    const safeSubject = normalizeSubject(subject);
    const objectData = await readMaterialObject(exactObjectReader, {
      action: "read_trigger_subject_material",
      fieldProjection: [],
      mode: "auto",
      signal,
      subject: safeSubject,
    });
    const discovered = discoverSubjectMaterial(objectData);
    if (!Object.keys(discovered.form).length && !discovered.attachments.length) {
      throw materialError("crm_material_content_missing");
    }
    const reference = Object.freeze({
      contractVersion: MATERIAL_VERSION,
      materialBindingId: subjectMaterialBindingId(safeSubject.objectApiName),
      bindingVersion: SUBJECT_MATERIAL_BINDING_VERSION,
      sourceSystemId: "fxiaoke-crm",
      sourceObjectApiName: safeSubject.objectApiName,
      sourceObjectId: safeSubject.objectId,
      form: discovered.form,
      attachments: discovered.attachments,
    });
    subjectDownloadUrls.set(reference, discovered.downloadUrls);
    return reference;
  }

  async function resolveDownloadUrls({ binding, material, signal = null } = {}) {
    assertMaterial(binding, material);
    if (!material.attachments.length) return Object.freeze([]);
    if (typeof isAllowedDownloadUrl !== "function") {
      throw materialError("crm_material_download_url_policy_unavailable");
    }
    const resolved = await Promise.all(material.attachments.map(async (attachment) => {
      const response = await requestJson({
        action: "resolve_trigger_material_download_urls",
        pathname: FILE_PRESIGN_PATH,
        body: {
          includeNull: true,
          data: { paths: [attachment.path], expire: 1 },
        },
        signal,
      });
      const items = Array.isArray(response?.data) ? response.data : response?.data?.data;
      if (!Array.isArray(items) || items.length !== 1) {
        throw materialError("crm_material_presign_response_invalid");
      }
      const url = normalizeHttpsUrl(items[0]?.url);
      if (!url || !isAllowedDownloadUrl(url)) throw materialError("crm_material_download_url_forbidden");
      return Object.freeze({ attachmentIndex: attachment.attachmentIndex, url });
    }));
    return Object.freeze(resolved);
  }

  async function resolveSubjectDownloadUrls({ material, signal = null } = {}) {
    const directUrls = subjectDownloadUrls.get(material);
    if (Array.isArray(directUrls) && directUrls.length === material?.attachments?.length &&
      directUrls.every(Boolean)) {
      if (typeof isAllowedDownloadUrl !== "function") {
        throw materialError("crm_material_download_url_policy_unavailable");
      }
      return Object.freeze(directUrls.map((candidate, index) => {
        const url = normalizeHttpsUrl(candidate);
        if (!url || !isAllowedDownloadUrl(url)) {
          throw materialError("crm_material_download_url_forbidden");
        }
        return Object.freeze({
          attachmentIndex: material.attachments[index].attachmentIndex,
          url,
        });
      }));
    }
    const binding = subjectMaterialBinding(material?.sourceObjectApiName);
    return resolveDownloadUrls({ binding, material, signal });
  }

  return Object.freeze({
    adapterId: ADAPTER_VERSION,
    acquireReferences,
    acquireSubjectMaterial,
    resolveDownloadUrls,
    resolveSubjectDownloadUrls,
  });
}

function discoverSubjectMaterial(objectData) {
  const attachmentFields = new Set();
  const attachments = [];
  for (const [fieldApiName, value] of Object.entries(objectData)) {
    let normalized;
    try {
      normalized = discoverAttachmentList(value, fieldApiName);
    } catch (error) {
      if (error?.code !== "crm_material_attachment_type_not_allowed") throw error;
      attachmentFields.add(fieldApiName);
      continue;
    }
    if (normalized === null) continue;
    attachmentFields.add(fieldApiName);
    attachments.push(...normalized.map((attachment, index) => ({
      ...attachment,
      downloadUrl: discoveredDownloadUrl(value[index]),
    })));
  }
  if (attachments.length > SUBJECT_MAX_ATTACHMENT_COUNT) {
    throw materialError("crm_material_attachment_count_exceeded");
  }
  const form = {};
  for (const [fieldApiName, value] of Object.entries(objectData)) {
    if (fieldApiName === "_id" || attachmentFields.has(fieldApiName) ||
      isSensitiveFormField(fieldApiName)) continue;
    const normalized = normalizeTransientValue(value);
    if (normalized.accepted) form[fieldApiName] = normalized.value;
  }
  const indexed = attachments.map((attachment, attachmentIndex) =>
    Object.freeze({ ...attachment, attachmentIndex }));
  return Object.freeze({
    form: Object.freeze(form),
    attachments: Object.freeze(indexed.map(({ downloadUrl: _downloadUrl, ...attachment }) =>
      Object.freeze(attachment))),
    downloadUrls: Object.freeze(indexed.map((attachment) => attachment.downloadUrl || "")),
  });
}

function discoveredDownloadUrl(value) {
  if (!isPlainObject(value)) return "";
  const candidate = aliasedAttachmentValue(value, ["signedUrl", "signedURL", "url", "Url"]);
  return normalizeHttpsUrl(candidate);
}

function discoverAttachmentList(value, fieldApiName) {
  if (!Array.isArray(value) || !value.length) return null;
  const looksLikeFileList = value.every((item) => isPlainObject(item) &&
    hasAliasedValue(item, ["filename", "fileName", "name", "Name"]) &&
    hasAliasedValue(item, ["path", "Path"]));
  if (!looksLikeFileList) return null;
  return normalizeAttachments(value, fieldApiName, subjectMaterialBinding("dynamic_subject"));
}

function subjectMaterialBinding(objectApiName) {
  return Object.freeze({
    contractVersion: "trigger-material-binding.v2",
    materialBindingId: subjectMaterialBindingId(objectApiName),
    bindingVersion: SUBJECT_MATERIAL_BINDING_VERSION,
    sourceSystemId: "fxiaoke-crm",
    sourceObjectApiName: reference(objectApiName),
    taskDefinitionId: "managed-agent-review",
    recordReadMode: "custom_find_one_by_id",
    fieldProjection: Object.freeze([]),
    attachmentFields: Object.freeze([]),
    allowedExtensions: null,
    maxAttachmentCount: SUBJECT_MAX_ATTACHMENT_COUNT,
    maxAttachmentBytes: SUBJECT_MAX_ATTACHMENT_BYTES,
    enabled: true,
    reviewStatus: "approved",
  });
}

function subjectMaterialBindingId(objectApiName) {
  return `subject:${reference(objectApiName)}:material`;
}

async function readMaterialObject(reader, { action, fieldProjection, mode, signal, subject }) {
  try {
    return await reader.readExact({
      action,
      fieldProjection,
      mode,
      objectApiName: subject.objectApiName,
      objectId: subject.objectId,
      signal,
    });
  } catch (error) {
    if (error?.code === "fxiaoke_crm_object_record_unavailable") {
      throw materialError("crm_material_record_unavailable");
    }
    throw error;
  }
}

function normalizeAttachments(value, fieldApiName, binding) {
  if (value === null || value === undefined ||
    (typeof value === "string" && !value.trim()) ||
    (isPlainObject(value) && !Object.keys(value).length)) return [];
  if (!Array.isArray(value)) throw materialError("crm_material_attachment_schema_invalid");
  return value.map((attachment) => {
    if (!isPlainObject(attachment)) {
      throw materialError("crm_material_attachment_schema_invalid");
    }
    const name = aliasedAttachmentValue(attachment, ["filename", "fileName", "name", "Name"]);
    const path = aliasedAttachmentValue(attachment, ["path", "Path"]);
    const declaredSize = aliasedAttachmentValue(attachment, ["size", "Size"]);
    if (typeof name !== "string" || name !== name.trim() || !name || name.length > 240 ||
      typeof path !== "string" || !OPAQUE_REFERENCE.test(path)) {
      throw materialError("crm_material_attachment_schema_invalid");
    }
    const extension = extensionOf(name);
    if (Array.isArray(binding.allowedExtensions) && !binding.allowedExtensions.includes(extension)) {
      throw materialError("crm_material_attachment_type_not_allowed");
    }
    const sizeBytes = declaredSize === undefined ? null : declaredSize;
    if (sizeBytes !== null && (!Number.isInteger(sizeBytes) || sizeBytes < 0 ||
      sizeBytes > binding.maxAttachmentBytes)) {
      throw materialError("crm_material_attachment_size_invalid");
    }
    return {
      fieldApiName,
      name,
      path,
      extension,
      sizeBytes,
    };
  });
}

function aliasedAttachmentValue(value, fields) {
  const present = fields.filter((field) => Object.hasOwn(value, field));
  if (present.length > 1 && present.some((field) => value[field] !== value[present[0]])) {
    throw materialError("crm_material_attachment_schema_invalid");
  }
  return present.length ? value[present[0]] : undefined;
}

function hasAliasedValue(value, fields) {
  return fields.some((field) => Object.hasOwn(value, field));
}

function projectTransientForm(objectData, binding) {
  const attachmentFields = new Set(binding.attachmentFields);
  const form = {};
  for (const fieldApiName of binding.fieldProjection) {
    if (fieldApiName === "_id" || attachmentFields.has(fieldApiName) ||
      isSensitiveFormField(fieldApiName) || !Object.hasOwn(objectData, fieldApiName)) continue;
    const normalized = normalizeTransientValue(objectData[fieldApiName]);
    if (normalized.accepted) form[fieldApiName] = normalized.value;
  }
  return Object.freeze(form);
}

function normalizeTransientValue(value, depth = 0) {
  if (depth > 8) return { accepted: false };
  if (typeof value === "boolean" || (typeof value === "number" && Number.isFinite(value))) {
    return { accepted: true, value };
  }
  if (typeof value === "string") {
    return !value.trim() || containsUrl(value)
      ? { accepted: false }
      : { accepted: true, value };
  }
  if (Array.isArray(value) && value.length > 0 && value.length <= 1_000) {
    const items = value.map((item) => normalizeTransientValue(item, depth + 1));
    return items.every((item) => item.accepted)
      ? { accepted: true, value: Object.freeze(items.map((item) => item.value)) }
      : { accepted: false };
  }
  if (isPlainObject(value) && Object.keys(value).length > 0 && Object.keys(value).length <= 1_000) {
    const projected = {};
    for (const [key, item] of Object.entries(value)) {
      if (isSensitiveFormField(key)) return { accepted: false };
      const normalized = normalizeTransientValue(item, depth + 1);
      if (!normalized.accepted) return { accepted: false };
      projected[key] = normalized.value;
    }
    return { accepted: true, value: Object.freeze(projected) };
  }
  return { accepted: false };
}

function isSensitiveFormField(value) {
  const tokenized = String(value || "").replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase();
  return /(?:^|_)(?:authorization|cookie|credential|link|password|passwd|path|secret|token|uri|url)(?:_|$)/
    .test(tokenized);
}

function containsUrl(value) {
  return /(?:https?|ftp):\/\/|(?:^|[\s(])www\./i.test(value);
}

function assertBinding(binding, subject) {
  if (!isPlainObject(binding) || binding.contractVersion !== "trigger-material-binding.v2" ||
    binding.enabled !== true || binding.reviewStatus !== "approved" ||
    binding.recordReadMode !== "custom_find_one_by_id" ||
    binding.sourceSystemId !== "fxiaoke-crm" ||
    binding.sourceObjectApiName !== subject.objectApiName) {
    throw materialError("crm_material_binding_mismatch");
  }
}

function assertMaterial(binding, material) {
  if (!isPlainObject(binding) || !isPlainObject(material) ||
    material.contractVersion !== MATERIAL_VERSION ||
    material.materialBindingId !== binding.materialBindingId ||
    material.bindingVersion !== binding.bindingVersion ||
    !isPlainObject(material.form) ||
    !Array.isArray(material.attachments) ||
    material.attachments.length > binding.maxAttachmentCount ||
    (!Object.keys(material.form).length && !material.attachments.length)) {
    throw materialError("crm_material_reference_invalid");
  }
}

function normalizeSubject(value) {
  if (!isPlainObject(value) || Object.keys(value).some((field) =>
    !["approvalInstanceId", "nodeApiName", "objectApiName", "objectId"].includes(field))) {
    throw materialError("crm_material_subject_invalid");
  }
  const objectApiName = reference(value.objectApiName);
  const objectId = reference(value.objectId);
  return Object.freeze({ objectApiName, objectId });
}

function extensionOf(name) {
  const index = name.lastIndexOf(".");
  return index > -1 && index < name.length - 1 ? name.slice(index + 1).toLowerCase() : "";
}

function normalizeHttpsUrl(value) {
  try {
    const url = new URL(String(value || ""));
    return url.protocol === "https:" && !url.username && !url.password ? url.toString() : "";
  } catch {
    return "";
  }
}

function reference(value) {
  const text = String(value || "").trim();
  if (!OPAQUE_REFERENCE.test(text)) throw materialError("crm_material_reference_invalid");
  return text;
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value) &&
    [Object.prototype, null].includes(Object.getPrototypeOf(value));
}

function materialError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

export {
  ADAPTER_VERSION as FXIAOKE_TRIGGER_OBJECT_MATERIAL_ADAPTER_VERSION,
  CUSTOM_FIND_ONE_PATH,
  FILE_PRESIGN_PATH,
  MATERIAL_VERSION as TRIGGER_MATERIAL_REFERENCE_VERSION,
  createFxiaokeTriggerObjectMaterialAdapter,
};
