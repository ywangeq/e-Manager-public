import {
  FXIAOKE_CRM_SERVICE_ALLOWED_ORIGINS,
  createFxiaokeCrmServiceClient,
} from "./fxiaoke-crm-service-client.mjs";
import { createFxiaokeCrmExactObjectReader } from "./fxiaoke-crm-exact-object-reader.mjs";

const FXIAOKE_CRM_READONLY_ACTIONS = Object.freeze([
  "get_sale_contract_by_number",
  "get_contract_approval_process_by_contract_ref",
  "describe_current_object",
  "read_current_object",
]);

const CONTRACT_QUERY_FIELDS = Object.freeze([
  "_id",
  "name",
  "contract_name__c",
  "create_time",
  "last_modified_time",
  "approval_node__c",
  "life_status",
  "changed_status",
]);

const PROCESS_FIELDS = Object.freeze([
  "instanceId",
  "instanceName",
  "instanceStatus",
  "flowApiName",
  "flowName",
  "startTime",
  "endTime",
  "currentStagePosition",
  "totalStageCount",
  "probabilityViewOnInstance",
]);

const ERROR_MESSAGES = Object.freeze({
  crm_action_not_allowed: "该 CRM 动作不在当前只读边界内。",
  crm_arguments_invalid: "CRM 只读查询参数不合法。",
  crm_unavailable: "CRM 只读适配器尚未完成安全连接配置。",
  crm_credential_unavailable: "CRM 凭证不可用。",
  crm_authentication_failed: "CRM 认证失败。",
  crm_forbidden: "当前 CRM 用户无权读取该数据。",
  crm_rate_limited: "CRM 请求过于频繁，请稍后重试。",
  crm_request_cancelled: "CRM 只读查询已取消。",
  crm_request_timeout: "CRM 只读查询超时。",
  crm_response_too_large: "CRM 返回内容超过只读适配器限制。",
  crm_response_schema_mismatch: "CRM 返回结构与已审核合同不一致。",
  crm_record_ambiguous: "CRM 中存在多条同号合同，无法安全选择。",
  crm_record_unavailable: "CRM 中未找到该合同或当前用户无权访问。",
  crm_upstream_error: "CRM 只读查询失败。",
});

function createFxiaokeCrmReadonlyToolAdapter({
  baseUrl = "",
  credentialConfigured = false,
  credentialProvider,
  fetchImpl = globalThis.fetch,
  now = () => Date.now(),
  requestTimeoutMs = 10_000,
  serviceClient = null,
  tokenSafetyWindowSeconds = 300,
} = {}) {
  const injectedClient = validServiceClient(serviceClient) ? serviceClient : null;
  const defaultClientReady = isAllowedServiceOrigin(baseUrl) && credentialConfigured &&
    typeof fetchImpl === "function" && typeof credentialProvider === "function";
  const client = injectedClient || (defaultClientReady
    ? createFxiaokeCrmServiceClient({
        baseUrl,
        credentialProvider,
        fetchImpl,
        now,
        requestTimeoutMs,
        tokenSafetyWindowSeconds,
      })
    : null);
  const exactObjectReader = client
    ? createFxiaokeCrmExactObjectReader({ requestJson: client.requestJson })
    : null;

  async function execute({ action = "", arguments: input = {}, signal = null } = {}) {
    if (!FXIAOKE_CRM_READONLY_ACTIONS.includes(action)) return blocked("crm_action_not_allowed");
    const normalized = normalizeArguments(action, input);
    if (!normalized) return blocked("crm_arguments_invalid");
    if (!client) {
      return failed("crm_unavailable");
    }

    try {
      if (action === "read_current_object") {
        const objectData = await exactObjectReader.readExact({
          action: `readonly_${action}`,
          mode: "auto",
          objectApiName: normalized.objectApiName,
          objectId: normalized.objectId,
          signal,
        });
        return normalizeCurrentObjectResult(objectData, normalized);
      }
      const response = await client.requestJson({
        action: `readonly_${action}`,
        pathname: endpointFor(action),
        body: requestPayload(action, normalized),
        signal,
      });
      return normalizeResult(action, response, normalized);
    } catch (error) {
      return failed(mapServiceError(error));
    }
  }

  return {
    actions: () => [...FXIAOKE_CRM_READONLY_ACTIONS],
    execute,
    runtimeStatus: () => ({
      status: client ? "ready" : "unavailable",
      executionMode: "on_demand_readonly",
      scheduleMode: "disabled",
      writeback: "none",
    }),
  };
}

function endpointFor(action) {
  if (action === "describe_current_object") return "/cgi/crm/v2/object/describe";
  return action === "get_sale_contract_by_number"
    ? "/cgi/crm/v2/data/query"
    : "/cgi/crm/v2/special/getInstanceInfoByObjectId";
}

function requestPayload(action, input) {
  if (action === "describe_current_object") {
    return { includeNull: true, includeDetail: true, data: { apiName: input.objectApiName } };
  }
  if (action === "read_current_object") {
    return {
      includeNull: true,
      data: {
        dataObjectApiName: input.objectApiName,
        search_query_info: {
          filters: [{ field_name: "_id", field_values: [input.objectId], operator: "EQ" }],
        },
        field_projection: [],
      },
    };
  }
  if (action === "get_contract_approval_process_by_contract_ref") {
    return { includeNull: false, data: { entityId: "SaleContractObj", objectId: input.contractRef } };
  }
  return {
    data: {
      dataObjectApiName: "SaleContractObj",
      search_query_info: {
        offset: 0,
        limit: 2,
        fieldProjection: [...CONTRACT_QUERY_FIELDS],
        filters: [{ field_name: "name", field_values: [input.contractNumber], operator: "EQ" }],
      },
    },
  };
}

function normalizeArguments(action, input) {
  if (!isPlainObject(input)) return null;
  if (action === "describe_current_object") {
    if (!exactKeys(input, ["objectApiName"])) return null;
    const objectApiName = cleanReference(input.objectApiName);
    return objectApiName ? { objectApiName } : null;
  }
  if (action === "read_current_object") {
    if (!exactKeys(input, ["objectApiName", "objectId"])) return null;
    const objectApiName = cleanReference(input.objectApiName);
    const objectId = cleanReference(input.objectId);
    return objectApiName && objectId ? { objectApiName, objectId } : null;
  }
  const key = action === "get_sale_contract_by_number" ? "contractNumber" : "contractRef";
  if (Object.keys(input).length !== 1 || !Object.prototype.hasOwnProperty.call(input, key)) return null;
  const value = cleanText(input[key], 200);
  return value ? { [key]: value } : null;
}

function normalizeResult(action, response, input) {
  if (action === "describe_current_object") {
    const description = response.data?.describe;
    if (!isPlainObject(description)) throw codedError("crm_response_schema_mismatch");
    const describedApiName = cleanText(description.api_name || description.apiName, 240);
    if (describedApiName && describedApiName !== input.objectApiName) {
      throw codedError("crm_response_schema_mismatch");
    }
    return {
      ok: true,
      status: "completed",
      action,
      objectApiName: input.objectApiName,
      description: projectSafeValue(description),
    };
  }
  if (action === "get_sale_contract_by_number") {
    const items = extractItems(response);
    if (!items) throw codedError("crm_response_schema_mismatch");
    if (!items.length) throw codedError("crm_record_unavailable");
    if (items.length > 1) throw codedError("crm_record_ambiguous");
    const contractRef = cleanText(items[0]?._id, 200);
    const contractNumber = cleanText(items[0]?.name, 200);
    if (!contractRef || !contractNumber || contractNumber !== input.contractNumber) throw codedError("crm_response_schema_mismatch");
    return {
      ok: true,
      status: "completed",
      action,
      contract: { contractRef, ...projectScalarFields(items[0], CONTRACT_QUERY_FIELDS.filter((field) => field !== "_id")) },
    };
  }
  const source = isPlainObject(response.data?.instanceInfo) ? response.data.instanceInfo : response.data;
  if (!isPlainObject(source)) throw codedError("crm_response_schema_mismatch");
  const process = projectScalarFields(source, PROCESS_FIELDS);
  const hasInstanceStatus = Boolean(cleanText(process.instanceId, 200) && cleanText(process.instanceStatus, 200));
  const hasStageSummary = Number.isInteger(process.currentStagePosition) && Number.isInteger(process.totalStageCount);
  if (!hasInstanceStatus && !hasStageSummary) throw codedError("crm_response_schema_mismatch");
  return { ok: true, status: "completed", action, process };
}

function normalizeCurrentObjectResult(objectData, input) {
  return {
    ok: true,
    status: "completed",
    action: "read_current_object",
    subject: { objectApiName: input.objectApiName, objectId: input.objectId },
    record: projectSafeValue(objectData),
  };
}

function projectSafeValue(value, depth = 0) {
  if (depth > 8) return "[depth-limited]";
  if (value === null || typeof value === "boolean" || Number.isFinite(value)) return value;
  if (typeof value === "string") return value.slice(0, 40_000);
  if (Array.isArray(value)) return value.slice(0, 1_000).map((item) => projectSafeValue(item, depth + 1));
  if (!isPlainObject(value)) return null;
  return Object.fromEntries(Object.entries(value).slice(0, 2_000).flatMap(([key, item]) =>
    isSensitiveKey(key) ? [] : [[key, projectSafeValue(item, depth + 1)]]));
}

function isSensitiveKey(value) {
  const key = String(value || "").replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase();
  return /(?:^|_)(?:authorization|cookie|credential|password|passwd|secret|signed_url|token)(?:_|$)/
    .test(key);
}

function exactKeys(value, expected) {
  const keys = Object.keys(value);
  return keys.length === expected.length && expected.every((key) => Object.hasOwn(value, key));
}

function cleanReference(value) {
  const text = cleanText(value, 240);
  return /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,239}$/.test(text) ? text : "";
}

function extractItems(response) {
  const candidates = [response.data?.dataList, response.data?.records, response.data?.list, response.data];
  return candidates.find(Array.isArray) || null;
}

function projectScalarFields(value, fields) {
  if (!isPlainObject(value)) return {};
  return Object.fromEntries(fields.flatMap((field) => {
    if (!Object.prototype.hasOwnProperty.call(value, field)) return [];
    const scalar = safeScalar(value[field]);
    return scalar === undefined ? [] : [[field, scalar]];
  }));
}

function safeScalar(value) {
  if (value === null || typeof value === "boolean" || Number.isFinite(value)) return value;
  if (typeof value === "string") return value.slice(0, 4_000);
  return undefined;
}

function isAllowedServiceOrigin(value) {
  try {
    const url = new URL(String(value || ""));
    return url.protocol === "https:" && !url.username && !url.password &&
      url.pathname === "/" && !url.search && !url.hash &&
      FXIAOKE_CRM_SERVICE_ALLOWED_ORIGINS.includes(url.origin);
  } catch {
    return false;
  }
}

function validServiceClient(value) {
  return Boolean(value) && typeof value === "object" &&
    typeof value.requestJson === "function";
}

function mapServiceError(error) {
  const mapping = {
    fxiaoke_crm_service_authentication_failed: "crm_authentication_failed",
    fxiaoke_crm_service_credential_unavailable: "crm_credential_unavailable",
    fxiaoke_crm_service_forbidden: "crm_forbidden",
    fxiaoke_crm_service_rate_limited: "crm_rate_limited",
    fxiaoke_crm_service_request_cancelled: "crm_request_cancelled",
    fxiaoke_crm_service_request_timeout: "crm_request_timeout",
    fxiaoke_crm_service_response_invalid: "crm_response_schema_mismatch",
    fxiaoke_crm_service_response_too_large: "crm_response_too_large",
    fxiaoke_crm_service_unavailable: "crm_unavailable",
    fxiaoke_crm_object_record_unavailable: "crm_record_unavailable",
  };
  return mapping[error?.code] || (ERROR_MESSAGES[error?.code]
    ? error.code
    : "crm_upstream_error");
}

function cleanText(value, maximum) {
  const text = typeof value === "string" ? value.trim() : "";
  return text && text.length <= maximum ? text : "";
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function blocked(errorCode) {
  return { ok: false, status: "blocked", errorCode, message: ERROR_MESSAGES[errorCode] };
}

function failed(errorCode) {
  return { ok: false, status: "failed", errorCode, message: ERROR_MESSAGES[errorCode] };
}

function codedError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

export {
  CONTRACT_QUERY_FIELDS,
  FXIAOKE_CRM_READONLY_ACTIONS,
  createFxiaokeCrmReadonlyToolAdapter,
};
