import crypto from "node:crypto";
import {
  normalizeScheduleTaskInputContract,
  scheduleTaskInputContractDigest,
} from "./schedule-task-execution-definition.mjs";
import { scheduleTaskInputRetentionDefinitionDigest } from "./schedule-task-input-retention-contract.mjs";
import {
  SCHEDULE_SOURCE_ACCESS_LEASE_CONTRACT_VERSION,
  SCHEDULE_SOURCE_ACCESS_REQUEST_CONTRACT_VERSION,
} from "./schedule-source-access-lease-service.mjs";
import { normalizeScheduleTaskInputSnapshotBinding } from
  "./sqlite-schedule-task-input-snapshot-repository.mjs";
import { normalizeScheduleTaskSourceBinding } from
  "./versioned-schedule-task-source-binding-catalog.mjs";

const ADAPTER_VERSION = "schedule-task-source-adapter.v1";
const ADAPTER_REQUEST_VERSION = "schedule-task-source-adapter-request.v1";
const AUTHORIZATION_VERSION = "schedule-task-source-authorization.v1";
const CAPTURE_VERSION = "schedule-task-source-capture.v1";
const SOURCE_ADAPTER_ID = "feishu-approval-readonly-snapshot";
const SNAPSHOT_VERSION = "feishu-approval-snapshot.v1";
const FEISHU_API_ORIGIN = "https://open.feishu.cn";
const REQUEST_FIELDS = new Set(["binding", "contractVersion", "inputContract", "sourceBinding"]);
const CAPTURE_FIELDS = new Set([...REQUEST_FIELDS, "authorization"]);
const AUTHORIZATION_FIELDS = new Set([
  "authorizationEvidenceDigest", "contractVersion", "sourceAdapterId", "sourceBindingDigest",
  "validUntil",
]);
const ACCESS_LEASE_FIELDS = new Set([
  "accessAuthorityDigest", "accessToken", "canonicalTaskId", "contractVersion", "employeeId",
  "resourceKind", "runId", "scheduleId", "selectionMode", "sourceAdapterId",
  "sourceBindingDigest", "sourceBindingId", "sourceBindingVersion", "sourceSystemId",
  "taskDefinitionId", "taskDefinitionVersion", "tenantScope", "validUntil",
]);
const TOKEN = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,239}$/;
const DIGEST = /^[a-f0-9]{64}$/;

export function createFeishuApprovalScheduleSourceAdapter({
  fetch = globalThis.fetch,
  now = () => new Date(),
  requestTimeoutMs = 8_000,
  resolveAccessLease,
  stableAuthorizationHmacKey,
} = {}) {
  if (typeof fetch !== "function") throw new TypeError("Feishu approval source adapter requires fetch");
  if (typeof now !== "function") throw new TypeError("Feishu approval source adapter requires now");
  if (typeof resolveAccessLease !== "function") {
    throw new TypeError("Feishu approval source adapter requires resolveAccessLease");
  }
  if (!Number.isSafeInteger(requestTimeoutMs) || requestTimeoutMs < 100 || requestTimeoutMs > 30_000) {
    throw new TypeError("Feishu approval source adapter requestTimeoutMs is invalid");
  }
  const authorizationKey = exactKey(stableAuthorizationHmacKey);

  async function resolveCurrentAuthorization(value = {}, { signal = null } = {}) {
    const request = normalizeAdapterRequest(value);
    const operationSignal = normalizeSignal(signal);
    const lease = await currentAccessLease(resolveAccessLease, request, now, operationSignal);
    await queryInstances({
      fetch,
      lease,
      pageSize: 1,
      requestTimeoutMs,
      signal: operationSignal,
    });
    return projectAuthorization(authorizationKey, request, lease);
  }

  async function captureSnapshot(value = {}, { signal = null } = {}) {
    const request = normalizeAdapterRequest(value, true);
    const operationSignal = normalizeSignal(signal);
    const lease = await currentAccessLease(resolveAccessLease, request, now, operationSignal);
    const currentAuthorization = projectAuthorization(authorizationKey, request, lease);
    requireSameAuthorization(request.authorization, currentAuthorization);
    const detailLimit = request.inputContract.maxItems - 1;
    if (detailLimit < 1) throw adapterError("schedule_feishu_approval_source_budget_invalid");
    const query = await queryInstances({
      fetch,
      lease,
      pageSize: Math.min(detailLimit, 100),
      requestTimeoutMs,
      signal: operationSignal,
    });
    if (query.instanceCodes.length > detailLimit) {
      throw adapterError("schedule_feishu_approval_source_response_invalid");
    }
    const details = [];
    for (const instanceCode of query.instanceCodes) {
      requireNotCanceled(operationSignal);
      details.push(await getInstance({
        fetch,
        instanceCode,
        lease,
        requestTimeoutMs,
        signal: operationSignal,
      }));
    }
    const snapshot = deepFreeze({
      contractVersion: "schedule-task-input-snapshot.v1",
      items: [
        {
          hasMore: query.hasMore,
          kind: "scope_summary",
          selectedCount: details.length,
        },
        ...details,
      ],
      snapshotContractVersion: SNAPSHOT_VERSION,
    });
    if (Buffer.byteLength(canonicalJson(snapshot), "utf8") > request.inputContract.maxPayloadBytes) {
      throw adapterError("schedule_feishu_approval_source_payload_too_large");
    }
    const sourceSnapshotRef = `feishu_approval_snapshot_${keyedDigest(
      authorizationKey,
      "schedule-feishu-approval-source-snapshot.v1",
      [request.binding, currentAuthorization.authorizationEvidenceDigest, snapshot],
    )}`;
    return deepFreeze({
      authorizationEvidenceDigest: currentAuthorization.authorizationEvidenceDigest,
      contractVersion: CAPTURE_VERSION,
      snapshot,
      sourceSnapshotRef,
    });
  }

  return Object.freeze({
    captureSnapshot,
    contractVersion: ADAPTER_VERSION,
    resolveCurrentAuthorization,
    sourceAdapterId: SOURCE_ADAPTER_ID,
  });
}

function normalizeAdapterRequest(value, withAuthorization = false) {
  exactObject(value, withAuthorization ? CAPTURE_FIELDS : REQUEST_FIELDS,
    "schedule_feishu_approval_source_request_invalid");
  if (value.contractVersion !== ADAPTER_REQUEST_VERSION) {
    throw adapterError("schedule_feishu_approval_source_request_invalid");
  }
  const binding = normalizeScheduleTaskInputSnapshotBinding(value.binding);
  const inputContract = normalizeScheduleTaskInputContract(value.inputContract);
  const sourceBinding = normalizeScheduleTaskSourceBinding(value.sourceBinding);
  const matches = binding.contractVersion === "schedule-task-input-snapshot-binding.v2" &&
    inputContract.contractVersion === "schedule-task-input-contract.v2" &&
    binding.sourceAdapterId === SOURCE_ADAPTER_ID &&
    binding.snapshotContractVersion === SNAPSHOT_VERSION &&
    binding.inputContractDigest === scheduleTaskInputContractDigest(inputContract) &&
    binding.maxItems === inputContract.maxItems &&
    binding.maxPayloadBytes === inputContract.maxPayloadBytes &&
    binding.retentionDefinitionDigest ===
      scheduleTaskInputRetentionDefinitionDigest(inputContract.retentionDefinition) &&
    binding.snapshotRetentionSeconds === inputContract.retentionDefinition.snapshotRetentionSeconds &&
    binding.sourceBindingDigest === inputContract.sourceBindingDigest &&
    inputContract.sourceAdapterId === SOURCE_ADAPTER_ID &&
    sourceBinding.sourceAdapterId === SOURCE_ADAPTER_ID &&
    sourceBinding.sourceSystemId === "feishu" && sourceBinding.resourceKind === "approval_instances" &&
    sourceBinding.selectionMode === "current_authorized_scope" &&
    sourceBinding.snapshotContractVersion === SNAPSHOT_VERSION &&
    sourceBinding.taskDefinitionId === binding.taskDefinitionId &&
    sourceBinding.taskDefinitionVersion === binding.taskDefinitionVersion;
  if (!matches) throw adapterError("schedule_feishu_approval_source_binding_mismatch");
  const authorization = withAuthorization ? normalizeAuthorization(value.authorization) : null;
  return deepFreeze({
    authorization,
    binding,
    contractVersion: ADAPTER_REQUEST_VERSION,
    inputContract,
    sourceBinding,
  });
}

async function currentAccessLease(resolver, request, now, signal) {
  requireNotCanceled(signal);
  let value;
  try {
    value = await resolver(deepFreeze({
      canonicalTaskId: request.binding.canonicalTaskId,
      contractVersion: SCHEDULE_SOURCE_ACCESS_REQUEST_CONTRACT_VERSION,
      employeeId: request.binding.employeeId,
      resourceKind: request.sourceBinding.resourceKind,
      runId: request.binding.runId,
      scheduleId: request.binding.scheduleId,
      selectionMode: request.sourceBinding.selectionMode,
      sourceAdapterId: SOURCE_ADAPTER_ID,
      sourceBindingDigest: request.binding.sourceBindingDigest,
      sourceBindingId: request.sourceBinding.sourceBindingId,
      sourceBindingVersion: request.sourceBinding.sourceBindingVersion,
      sourceSystemId: request.sourceBinding.sourceSystemId,
      taskDefinitionId: request.binding.taskDefinitionId,
      taskDefinitionVersion: request.binding.taskDefinitionVersion,
      tenantScope: request.binding.tenantScope,
    }), { signal });
  } catch {
    throw adapterError("schedule_feishu_approval_source_access_unavailable");
  }
  requireNotCanceled(signal);
  exactObject(value, ACCESS_LEASE_FIELDS, "schedule_feishu_approval_source_access_invalid");
  const lease = deepFreeze({
    accessAuthorityDigest: digest(value.accessAuthorityDigest),
    accessToken: secret(value.accessToken),
    canonicalTaskId: token(value.canonicalTaskId),
    contractVersion: value.contractVersion,
    employeeId: token(value.employeeId),
    resourceKind: token(value.resourceKind),
    runId: token(value.runId),
    scheduleId: token(value.scheduleId),
    selectionMode: token(value.selectionMode),
    sourceAdapterId: token(value.sourceAdapterId),
    sourceBindingDigest: digest(value.sourceBindingDigest),
    sourceBindingId: token(value.sourceBindingId),
    sourceBindingVersion: positiveInteger(value.sourceBindingVersion),
    sourceSystemId: token(value.sourceSystemId),
    taskDefinitionId: token(value.taskDefinitionId),
    taskDefinitionVersion: positiveInteger(value.taskDefinitionVersion),
    tenantScope: token(value.tenantScope),
    validUntil: timestamp(value.validUntil),
  });
  if (lease.contractVersion !== SCHEDULE_SOURCE_ACCESS_LEASE_CONTRACT_VERSION ||
    lease.canonicalTaskId !== request.binding.canonicalTaskId ||
    lease.employeeId !== request.binding.employeeId || lease.runId !== request.binding.runId ||
    lease.scheduleId !== request.binding.scheduleId ||
    lease.resourceKind !== request.sourceBinding.resourceKind ||
    lease.selectionMode !== request.sourceBinding.selectionMode ||
    lease.sourceAdapterId !== SOURCE_ADAPTER_ID ||
    lease.sourceBindingDigest !== request.binding.sourceBindingDigest ||
    lease.sourceBindingId !== request.sourceBinding.sourceBindingId ||
    lease.sourceBindingVersion !== request.sourceBinding.sourceBindingVersion ||
    lease.sourceSystemId !== request.sourceBinding.sourceSystemId ||
    lease.taskDefinitionId !== request.binding.taskDefinitionId ||
    lease.taskDefinitionVersion !== request.binding.taskDefinitionVersion ||
    lease.tenantScope !== request.binding.tenantScope ||
    new Date(lease.validUntil).getTime() <= trustedNow(now).getTime()) {
    throw adapterError("schedule_feishu_approval_source_access_invalid");
  }
  return lease;
}

function projectAuthorization(key, request, lease) {
  return deepFreeze({
    authorizationEvidenceDigest: keyedDigest(
      key,
      "schedule-feishu-approval-source-authorization.v1",
      [
        request.binding.tenantScope,
        request.binding.employeeId,
        request.binding.scheduleId,
        request.binding.sourceBindingDigest,
        lease.accessAuthorityDigest,
      ],
    ),
    contractVersion: AUTHORIZATION_VERSION,
    sourceAdapterId: SOURCE_ADAPTER_ID,
    sourceBindingDigest: request.binding.sourceBindingDigest,
    validUntil: lease.validUntil,
  });
}

function normalizeAuthorization(value) {
  exactObject(value, AUTHORIZATION_FIELDS, "schedule_feishu_approval_source_authorization_invalid");
  const result = deepFreeze({
    authorizationEvidenceDigest: digest(value.authorizationEvidenceDigest),
    contractVersion: value.contractVersion,
    sourceAdapterId: token(value.sourceAdapterId),
    sourceBindingDigest: digest(value.sourceBindingDigest),
    validUntil: timestamp(value.validUntil),
  });
  if (result.contractVersion !== AUTHORIZATION_VERSION || result.sourceAdapterId !== SOURCE_ADAPTER_ID) {
    throw adapterError("schedule_feishu_approval_source_authorization_invalid");
  }
  return result;
}

function requireSameAuthorization(expected, current) {
  if (expected.authorizationEvidenceDigest !== current.authorizationEvidenceDigest ||
    expected.sourceBindingDigest !== current.sourceBindingDigest ||
    new Date(current.validUntil).getTime() < new Date(expected.validUntil).getTime()) {
    throw adapterError("schedule_feishu_approval_source_authorization_changed");
  }
}

async function queryInstances({ fetch, lease, pageSize, requestTimeoutMs, signal }) {
  const response = await requestJson({
    body: {
      instance_status: "PENDING",
      locale: "zh-CN",
      with_revoked_instance: false,
    },
    fetch,
    lease,
    method: "POST",
    path: `/open-apis/approval/v4/instances/query?page_size=${pageSize}&user_id_type=open_id`,
    requestTimeoutMs,
    signal,
  });
  const list = response.data?.instance_list;
  if (list !== undefined && !Array.isArray(list)) {
    throw adapterError("schedule_feishu_approval_source_response_invalid");
  }
  const instanceCodes = [];
  const seen = new Set();
  for (const item of list || []) {
    const code = token(item?.instance?.code);
    if (seen.has(code)) throw adapterError("schedule_feishu_approval_source_response_invalid");
    seen.add(code);
    instanceCodes.push(code);
  }
  return {
    hasMore: response.data?.has_more === true,
    instanceCodes,
  };
}

async function getInstance({ fetch, instanceCode, lease, requestTimeoutMs, signal }) {
  const response = await requestJson({
    fetch,
    lease,
    method: "GET",
    path: `/open-apis/approval/v4/instances/${encodeURIComponent(instanceCode)}`,
    requestTimeoutMs,
    signal,
  });
  const data = response.data;
  if (!plainObject(data) || token(data.instance_code) !== instanceCode) {
    throw adapterError("schedule_feishu_approval_source_response_invalid");
  }
  let form;
  try { form = data.form ? JSON.parse(data.form) : []; }
  catch { throw adapterError("schedule_feishu_approval_source_response_invalid"); }
  const result = {
    approvalCode: token(data.approval_code),
    form: normalizeJson(form),
    instanceCode,
    kind: "approval_instance",
    serialNumber: token(data.serial_number),
    status: approvalStatus(data.status),
  };
  if (data.start_time) result.startedAt = timestampFromEpoch(data.start_time);
  if (data.end_time) result.endedAt = timestampFromEpoch(data.end_time);
  return deepFreeze(result);
}

async function requestJson({ body, fetch, lease, method, path, requestTimeoutMs, signal }) {
  requireNotCanceled(signal);
  const requestSignal = boundedSignal(signal, requestTimeoutMs);
  try {
    const response = await fetch(`${FEISHU_API_ORIGIN}${path}`, {
      body: body === undefined ? undefined : JSON.stringify(body),
      headers: {
        Authorization: `Bearer ${lease.accessToken}`,
        "Content-Type": "application/json; charset=utf-8",
      },
      method,
      signal: requestSignal.signal,
    });
    const payload = await response?.json?.().catch(() => null);
    if (!response?.ok || !plainObject(payload) || Number(payload.code) !== 0 ||
      !plainObject(payload.data)) {
      throw adapterError("schedule_feishu_approval_source_request_failed");
    }
    return payload;
  } catch (error) {
    if (error?.code?.startsWith("schedule_feishu_approval_source_")) throw error;
    if (signal?.aborted) throw adapterError("schedule_feishu_approval_source_canceled");
    throw adapterError("schedule_feishu_approval_source_request_failed");
  } finally {
    requestSignal.dispose();
  }
}

function boundedSignal(parent, timeoutMs) {
  const controller = new AbortController();
  const abortFromParent = () => controller.abort(parent?.reason);
  if (parent) parent.addEventListener("abort", abortFromParent, { once: true });
  if (parent?.aborted) abortFromParent();
  const timer = setTimeout(() => controller.abort(adapterError("schedule_feishu_approval_source_timeout")), timeoutMs);
  return {
    signal: controller.signal,
    dispose() {
      clearTimeout(timer);
      parent?.removeEventListener?.("abort", abortFromParent);
    },
  };
}

function normalizeSignal(value) {
  if (value === null || value === undefined) return null;
  if (typeof value !== "object" || typeof value.aborted !== "boolean" ||
    typeof value.addEventListener !== "function") {
    throw new TypeError("Feishu approval source adapter signal must be an AbortSignal");
  }
  return value;
}

function requireNotCanceled(signal) {
  if (signal?.aborted) throw adapterError("schedule_feishu_approval_source_canceled");
}

function approvalStatus(value) {
  const result = String(value || "").trim().toLowerCase();
  if (!new Set(["pending", "approved", "rejected", "canceled", "deleted"]).has(result)) {
    throw adapterError("schedule_feishu_approval_source_response_invalid");
  }
  return result;
}

function timestampFromEpoch(value) {
  const text = String(value || "").trim();
  if (!/^\d{10,13}$/.test(text)) throw adapterError("schedule_feishu_approval_source_response_invalid");
  const numeric = Number(text);
  const date = new Date(text.length === 10 ? numeric * 1000 : numeric);
  if (!Number.isFinite(date.getTime())) throw adapterError("schedule_feishu_approval_source_response_invalid");
  return date.toISOString();
}

function normalizeJson(value, depth = 0, budget = { nodes: 0 }) {
  budget.nodes += 1;
  if (budget.nodes > 20_000 || depth > 24) {
    throw adapterError("schedule_feishu_approval_source_response_invalid");
  }
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw adapterError("schedule_feishu_approval_source_response_invalid");
    return Object.is(value, -0) ? 0 : value;
  }
  if (Array.isArray(value)) return value.map((item) => normalizeJson(item, depth + 1, budget));
  if (!plainObject(value)) throw adapterError("schedule_feishu_approval_source_response_invalid");
  const result = {};
  for (const key of Object.keys(value).sort()) {
    Object.defineProperty(result, key, {
      enumerable: true,
      value: normalizeJson(value[key], depth + 1, budget),
    });
  }
  return result;
}

function exactObject(value, fields, code) {
  if (!plainObject(value)) throw adapterError(code);
  const keys = Object.keys(value);
  if (keys.length !== fields.size || keys.some((key) => !fields.has(key))) throw adapterError(code);
}

function plainObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function token(value) {
  const result = String(value || "").trim();
  if (!TOKEN.test(result) || /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(result)) {
    throw adapterError("schedule_feishu_approval_source_reference_invalid");
  }
  return result;
}

function digest(value) {
  const result = String(value || "").trim().toLowerCase();
  if (!DIGEST.test(result)) throw adapterError("schedule_feishu_approval_source_digest_invalid");
  return result;
}

function secret(value) {
  const result = String(value || "").trim();
  if (result.length < 16 || result.length > 4096 || /\s/.test(result)) {
    throw adapterError("schedule_feishu_approval_source_access_invalid");
  }
  return result;
}

function positiveInteger(value) {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw adapterError("schedule_feishu_approval_source_access_invalid");
  }
  return value;
}

function timestamp(value) {
  const result = value instanceof Date ? value.toISOString() : String(value || "").trim();
  const parsed = new Date(result);
  if (!result || !Number.isFinite(parsed.getTime()) || parsed.toISOString() !== result) {
    throw adapterError("schedule_feishu_approval_source_timestamp_invalid");
  }
  return result;
}

function trustedNow(now) {
  const value = now();
  const result = value instanceof Date ? new Date(value.getTime()) : new Date(value);
  if (!Number.isFinite(result.getTime())) throw adapterError("schedule_feishu_approval_source_clock_invalid");
  return result;
}

function exactKey(value) {
  const key = Buffer.isBuffer(value) ? Buffer.from(value) : Buffer.from(value || []);
  if (key.length !== 32) throw new TypeError("Feishu approval source adapter HMAC key must be 32 bytes");
  return key;
}

function keyedDigest(key, domain, values) {
  return crypto.createHmac("sha256", key).update(canonicalJson([domain, ...values])).digest("hex");
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) =>
      `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  const result = JSON.stringify(Object.is(value, -0) ? 0 : value);
  if (result === undefined) throw adapterError("schedule_feishu_approval_source_value_invalid");
  return result;
}

function deepFreeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    Object.values(value).forEach(deepFreeze);
  }
  return value;
}

function adapterError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

export {
  SOURCE_ADAPTER_ID as FEISHU_APPROVAL_SCHEDULE_SOURCE_ADAPTER_ID,
};
