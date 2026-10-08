const READER_VERSION = "fxiaoke-crm-exact-object-reader.v1";
const CUSTOM_FIND_ONE_PATH = "/cgi/crm/custom/v2/data/findOne";
const PRESET_GET_PATH = "/cgi/crm/v2/data/get";
const CUSTOM_UNSUPPORTED_CODE = "fxiaoke_crm_service_upstream_rejected_10006";

function createFxiaokeCrmExactObjectReader({ requestJson } = {}) {
  if (typeof requestJson !== "function") {
    throw new TypeError("Fxiaoke exact object reader requires requestJson");
  }
  const negotiatedModes = new Map();

  async function readExact({
    action,
    fieldProjection = [],
    mode = "auto",
    objectApiName,
    objectId,
    signal = null,
  } = {}) {
    const subject = normalizeSubject({ objectApiName, objectId });
    const projection = normalizeProjection(fieldProjection);
    const selectedMode = mode === "auto"
      ? negotiatedModes.get(subject.objectApiName) || "custom_find_one_by_id"
      : normalizeMode(mode);
    try {
      const objectData = await requestObject({
        action,
        mode: selectedMode,
        projection,
        signal,
        subject,
      });
      if (mode === "auto") negotiatedModes.set(subject.objectApiName, selectedMode);
      return objectData;
    } catch (error) {
      if (mode !== "auto" || selectedMode !== "custom_find_one_by_id" ||
        error?.code !== CUSTOM_UNSUPPORTED_CODE) throw error;
      const objectData = await requestObject({
        action,
        mode: "preset_get_by_id",
        projection,
        signal,
        subject,
      });
      negotiatedModes.set(subject.objectApiName, "preset_get_by_id");
      return objectData;
    }
  }

  async function requestObject({ action, mode, projection, signal, subject }) {
    const preset = mode === "preset_get_by_id";
    const response = await requestJson({
      action,
      pathname: preset ? PRESET_GET_PATH : CUSTOM_FIND_ONE_PATH,
      body: preset ? {
        includeNull: true,
        data: {
          dataObjectApiName: subject.objectApiName,
          objectDataId: subject.objectId,
        },
      } : {
        includeNull: true,
        data: {
          dataObjectApiName: subject.objectApiName,
          search_query_info: {
            filters: [{
              field_name: "_id",
              field_values: [subject.objectId],
              operator: "EQ",
            }],
          },
          field_projection: projection,
        },
      },
      signal,
    });
    const objectData = preset ? response?.data : response?.data?.objectData;
    if (!isPlainObject(objectData) || objectData._id !== subject.objectId) {
      throw readerError("fxiaoke_crm_object_record_unavailable");
    }
    return objectData;
  }

  return Object.freeze({ readerVersion: READER_VERSION, readExact });
}

function normalizeMode(value) {
  if (!["custom_find_one_by_id", "preset_get_by_id"].includes(value)) {
    throw readerError("fxiaoke_crm_object_read_mode_invalid");
  }
  return value;
}

function normalizeProjection(value) {
  if (!Array.isArray(value) || value.length > 2_000 || value.some((item) =>
    typeof item !== "string" || !/^[A-Za-z0-9_][A-Za-z0-9._:@/-]{0,239}$/.test(item))) {
    throw readerError("fxiaoke_crm_object_projection_invalid");
  }
  return Object.freeze([...value]);
}

function normalizeSubject(value) {
  return Object.freeze({
    objectApiName: reference(value?.objectApiName),
    objectId: reference(value?.objectId),
  });
}

function reference(value) {
  if (typeof value !== "string" || value !== value.trim() || !value || value.length > 240 ||
    !/^[A-Za-z0-9][A-Za-z0-9._:@/-]*$/.test(value)) {
    throw readerError("fxiaoke_crm_object_reference_invalid");
  }
  return value;
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value) &&
    [Object.prototype, null].includes(Object.getPrototypeOf(value));
}

function readerError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

export {
  CUSTOM_FIND_ONE_PATH as FXIAOKE_CUSTOM_FIND_ONE_PATH,
  PRESET_GET_PATH as FXIAOKE_PRESET_GET_PATH,
  READER_VERSION as FXIAOKE_CRM_EXACT_OBJECT_READER_VERSION,
  createFxiaokeCrmExactObjectReader,
};
