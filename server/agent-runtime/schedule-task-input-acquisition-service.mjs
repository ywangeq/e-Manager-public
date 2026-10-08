import { isDeepStrictEqual } from "node:util";
import {
  normalizeScheduleTaskExecutionDefinitionV2,
  scheduleTaskInputContractDigest,
} from "./schedule-task-execution-definition.mjs";
import { scheduleTaskInputRetentionDefinitionDigest } from "./schedule-task-input-retention-contract.mjs";
import { normalizeScheduleTaskInputSnapshotBinding } from "./sqlite-schedule-task-input-snapshot-repository.mjs";
import {
  normalizeScheduleTaskSourceBinding,
  SCHEDULE_TASK_SOURCE_BINDING_RESOLUTION_CONTRACT_VERSION,
} from "./versioned-schedule-task-source-binding-catalog.mjs";

const SERVICE_VERSION = "schedule-task-input-acquisition-service.v1";
const CONTEXT_VERSION = "schedule-task-input-acquisition-context.v1";
const OWNERSHIP_VERSION = "schedule-task-input-acquisition-ownership.v1";
const ADAPTER_VERSION = "schedule-task-source-adapter.v1";
const ADAPTER_REQUEST_VERSION = "schedule-task-source-adapter-request.v1";
const AUTHORIZATION_VERSION = "schedule-task-source-authorization.v1";
const CAPTURE_VERSION = "schedule-task-source-capture.v1";
const RESULT_VERSION = "schedule-task-input-acquisition-result.v1";
const REQUEST_FIELDS = new Set(["canonicalTaskId", "runId", "tenantScope"]);
const CONTEXT_FIELDS = new Set([
  "binding", "contractVersion", "executionPhase", "executionVersion", "ownership",
  "sourceBindingResolution", "taskDefinitionResolution",
]);
const OWNERSHIP_FIELDS = new Set([
  "contractVersion", "runFencingToken", "runLeaseExpiresAt", "runLeaseId", "runOwnerDigest",
  "taskFencingToken", "taskLeaseExpiresAt", "taskLeaseId", "taskOwnerDigest",
]);
const TASK_RESOLUTION_FIELDS = new Set([
  "contractVersion", "definition", "executionContractDigest", "payloadBoundary", "publishedAt",
]);
const SOURCE_RESOLUTION_FIELDS = new Set([
  "binding", "contractVersion", "payloadBoundary", "sourceBindingDigest",
]);
const ADAPTER_FIELDS = new Set([
  "captureSnapshot", "contractVersion", "resolveCurrentAuthorization", "sourceAdapterId",
]);
const AUTHORIZATION_FIELDS = new Set([
  "authorizationEvidenceDigest", "contractVersion", "sourceAdapterId", "sourceBindingDigest",
  "validUntil",
]);
const CAPTURE_FIELDS = new Set([
  "authorizationEvidenceDigest", "contractVersion", "snapshot", "sourceSnapshotRef",
]);
const TOKEN = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,239}$/;
const DIGEST = /^[a-f0-9]{64}$/;

export function createScheduleTaskInputAcquisitionService({
  inputSnapshotRepository,
  now = () => new Date(),
  resolveCurrentContext,
  resolveSourceAdapter,
} = {}) {
  assertDependencies({ inputSnapshotRepository, now, resolveCurrentContext, resolveSourceAdapter });

  async function acquire(value = {}, { signal = null } = {}) {
    const request = normalizeRequest(value);
    const operationSignal = normalizeSignal(signal);
    requireNotCanceled(operationSignal);
    const firstCheckedAt = trustedNow(now);
    const initial = await currentContext(resolveCurrentContext, request, firstCheckedAt);
    requireNotCanceled(operationSignal);
    const adapter = await sourceAdapter(resolveSourceAdapter, initial.sourceBinding.sourceAdapterId);
    const adapterRequest = projectAdapterRequest(initial);
    const initialAuthorization = await currentAuthorization(
      adapter,
      adapterRequest,
      firstCheckedAt,
      operationSignal,
    );

    const existing = inputSnapshotRepository.getEvidence({
      authorizationEvidenceDigest: initialAuthorization.authorizationEvidenceDigest,
      expectedBinding: initial.binding,
      runId: request.runId,
      tenantScope: request.tenantScope,
    });
    if (existing) {
      await revalidateBeforeCommit({
        adapter,
        adapterRequest,
        initial,
        initialAuthorization,
        now,
        request,
        resolveCurrentContext,
        signal: operationSignal,
      });
      return deepFreeze({
        contractVersion: RESULT_VERSION,
        evidence: existing,
        outcome: "reused",
      });
    }

    const capture = await captureSnapshot(
      adapter,
      adapterRequest,
      initialAuthorization,
      operationSignal,
    );
    await revalidateBeforeCommit({
      adapter,
      adapterRequest,
      initial,
      initialAuthorization,
      now,
      request,
      resolveCurrentContext,
      signal: operationSignal,
    });
    requireNotCanceled(operationSignal);
    const recorded = inputSnapshotRepository.recordSnapshot({
      authorizationEvidenceDigest: initialAuthorization.authorizationEvidenceDigest,
      binding: initial.binding,
      snapshot: capture.snapshot,
      sourceSnapshotRef: capture.sourceSnapshotRef,
    });
    return deepFreeze({
      contractVersion: RESULT_VERSION,
      evidence: recorded.evidence,
      outcome: recorded.created ? "captured" : "reused",
    });
  }

  return Object.freeze({ acquire, contractVersion: SERVICE_VERSION });
}

async function revalidateBeforeCommit({
  adapter,
  adapterRequest,
  initial,
  initialAuthorization,
  now,
  request,
  resolveCurrentContext,
  signal,
}) {
  requireNotCanceled(signal);
  const checkedAt = trustedNow(now);
  const current = await currentContext(resolveCurrentContext, request, checkedAt);
  requireSameContext(initial, current);
  const authorization = await currentAuthorization(adapter, adapterRequest, checkedAt, signal);
  requireSameAuthorization(initialAuthorization, authorization);
}

async function currentContext(resolver, request, checkedAt) {
  let value;
  try { value = await resolver(request); }
  catch { throw serviceError("schedule_task_input_context_unavailable"); }
  return normalizeContext(value, request, checkedAt);
}

function normalizeContext(value, request, checkedAt) {
  exactObject(value, CONTEXT_FIELDS, "schedule_task_input_context_invalid");
  if (value.contractVersion !== CONTEXT_VERSION || value.executionPhase !== "pre_effect") {
    throw serviceError("schedule_task_input_context_invalid");
  }
  const binding = normalizeScheduleTaskInputSnapshotBinding(value.binding);
  if (binding.tenantScope !== request.tenantScope || binding.runId !== request.runId ||
    binding.canonicalTaskId !== request.canonicalTaskId) {
    throw serviceError("schedule_task_input_context_mismatch");
  }
  const executionVersion = positiveInteger(value.executionVersion, "executionVersion");
  const ownership = normalizeOwnership(value.ownership, checkedAt);
  const taskDefinitionResolution = normalizeTaskDefinitionResolution(value.taskDefinitionResolution);
  const sourceBindingResolution = normalizeSourceBindingResolution(value.sourceBindingResolution);
  requireAuthorityBindings({ binding, sourceBindingResolution, taskDefinitionResolution });
  return deepFreeze({
    binding,
    contractVersion: CONTEXT_VERSION,
    executionPhase: "pre_effect",
    executionVersion,
    ownership,
    sourceBinding: sourceBindingResolution.binding,
    sourceBindingResolution,
    taskDefinition: taskDefinitionResolution.definition,
    taskDefinitionResolution,
  });
}

function normalizeOwnership(value, checkedAt) {
  exactObject(value, OWNERSHIP_FIELDS, "schedule_task_input_ownership_invalid");
  if (value.contractVersion !== OWNERSHIP_VERSION) {
    throw serviceError("schedule_task_input_ownership_invalid");
  }
  const ownership = {
    contractVersion: OWNERSHIP_VERSION,
    runFencingToken: positiveInteger(value.runFencingToken, "runFencingToken"),
    runLeaseExpiresAt: timestamp(value.runLeaseExpiresAt, "runLeaseExpiresAt"),
    runLeaseId: token(value.runLeaseId, "runLeaseId"),
    runOwnerDigest: digest(value.runOwnerDigest, "runOwnerDigest"),
    taskFencingToken: positiveInteger(value.taskFencingToken, "taskFencingToken"),
    taskLeaseExpiresAt: timestamp(value.taskLeaseExpiresAt, "taskLeaseExpiresAt"),
    taskLeaseId: token(value.taskLeaseId, "taskLeaseId"),
    taskOwnerDigest: digest(value.taskOwnerDigest, "taskOwnerDigest"),
  };
  const checked = new Date(checkedAt).getTime();
  if (new Date(ownership.runLeaseExpiresAt).getTime() <= checked ||
    new Date(ownership.taskLeaseExpiresAt).getTime() <= checked) {
    throw serviceError("schedule_task_input_ownership_expired");
  }
  return deepFreeze(ownership);
}

function normalizeTaskDefinitionResolution(value) {
  exactObject(value, TASK_RESOLUTION_FIELDS, "schedule_task_input_definition_invalid");
  if (value.contractVersion !== "schedule-task-execution-definition-resolution.v1" ||
    value.payloadBoundary !== "internal_only") {
    throw serviceError("schedule_task_input_definition_invalid");
  }
  return deepFreeze({
    contractVersion: value.contractVersion,
    definition: normalizeScheduleTaskExecutionDefinitionV2(value.definition),
    executionContractDigest: digest(value.executionContractDigest, "executionContractDigest"),
    payloadBoundary: "internal_only",
    publishedAt: timestamp(value.publishedAt, "definitionPublishedAt"),
  });
}

function normalizeSourceBindingResolution(value) {
  exactObject(value, SOURCE_RESOLUTION_FIELDS, "schedule_task_input_source_binding_invalid");
  if (value.contractVersion !== SCHEDULE_TASK_SOURCE_BINDING_RESOLUTION_CONTRACT_VERSION ||
    value.payloadBoundary !== "internal_only") {
    throw serviceError("schedule_task_input_source_binding_invalid");
  }
  return deepFreeze({
    binding: normalizeScheduleTaskSourceBinding(value.binding),
    contractVersion: value.contractVersion,
    payloadBoundary: "internal_only",
    sourceBindingDigest: digest(value.sourceBindingDigest, "sourceBindingDigest"),
  });
}

function requireAuthorityBindings({ binding, sourceBindingResolution, taskDefinitionResolution }) {
  const definition = taskDefinitionResolution.definition;
  const input = definition.inputContract;
  const source = sourceBindingResolution.binding;
  const matches = binding.executionContractDigest === taskDefinitionResolution.executionContractDigest &&
    binding.inputContractDigest === scheduleTaskInputContractDigest(input) &&
    binding.taskDefinitionId === definition.taskDefinitionId &&
    binding.taskDefinitionVersion === definition.taskDefinitionVersion &&
    binding.sourceAdapterId === input.sourceAdapterId &&
    binding.sourceBindingDigest === input.sourceBindingDigest &&
    binding.maxItems === input.maxItems && binding.maxPayloadBytes === input.maxPayloadBytes &&
    binding.retentionDefinitionDigest ===
      scheduleTaskInputRetentionDefinitionDigest(input.retentionDefinition) &&
    binding.snapshotRetentionSeconds === input.retentionDefinition.snapshotRetentionSeconds &&
    sourceBindingResolution.sourceBindingDigest === input.sourceBindingDigest &&
    source.sourceAdapterId === input.sourceAdapterId &&
    source.taskDefinitionId === definition.taskDefinitionId &&
    source.taskDefinitionVersion === definition.taskDefinitionVersion &&
    source.snapshotContractVersion === binding.snapshotContractVersion &&
    new Date(source.publishedAt).getTime() <= new Date(taskDefinitionResolution.publishedAt).getTime();
  if (!matches) throw serviceError("schedule_task_input_authority_mismatch");
}

function requireSameContext(initial, current) {
  const sameAuthority = initial.executionVersion === current.executionVersion &&
    isDeepStrictEqual(initial.binding, current.binding) &&
    isDeepStrictEqual(initial.taskDefinitionResolution, current.taskDefinitionResolution) &&
    isDeepStrictEqual(initial.sourceBindingResolution, current.sourceBindingResolution);
  const firstOwnership = initial.ownership;
  const currentOwnership = current.ownership;
  const sameOwner = firstOwnership.runLeaseId === currentOwnership.runLeaseId &&
    firstOwnership.runOwnerDigest === currentOwnership.runOwnerDigest &&
    firstOwnership.runFencingToken === currentOwnership.runFencingToken &&
    firstOwnership.taskLeaseId === currentOwnership.taskLeaseId &&
    firstOwnership.taskOwnerDigest === currentOwnership.taskOwnerDigest &&
    firstOwnership.taskFencingToken === currentOwnership.taskFencingToken &&
    new Date(currentOwnership.runLeaseExpiresAt).getTime() >=
      new Date(firstOwnership.runLeaseExpiresAt).getTime() &&
    new Date(currentOwnership.taskLeaseExpiresAt).getTime() >=
      new Date(firstOwnership.taskLeaseExpiresAt).getTime();
  if (!sameAuthority || !sameOwner) throw serviceError("schedule_task_input_context_changed");
}

async function sourceAdapter(resolver, sourceAdapterId) {
  let value;
  try { value = await resolver({ sourceAdapterId }); }
  catch { throw serviceError("schedule_task_source_adapter_unavailable"); }
  exactObject(value, ADAPTER_FIELDS, "schedule_task_source_adapter_invalid");
  if (value.contractVersion !== ADAPTER_VERSION || value.sourceAdapterId !== sourceAdapterId ||
    typeof value.resolveCurrentAuthorization !== "function" ||
    typeof value.captureSnapshot !== "function") {
    throw serviceError("schedule_task_source_adapter_invalid");
  }
  return value;
}

function projectAdapterRequest(context) {
  return deepFreeze({
    binding: context.binding,
    contractVersion: ADAPTER_REQUEST_VERSION,
    inputContract: context.taskDefinition.inputContract,
    sourceBinding: context.sourceBinding,
  });
}

async function currentAuthorization(adapter, request, checkedAt, signal) {
  requireNotCanceled(signal);
  let value;
  try { value = await adapter.resolveCurrentAuthorization(request, { signal }); }
  catch { throw serviceError("schedule_task_source_authorization_unavailable"); }
  requireNotCanceled(signal);
  exactObject(value, AUTHORIZATION_FIELDS, "schedule_task_source_authorization_invalid");
  const authorization = deepFreeze({
    authorizationEvidenceDigest: digest(
      value.authorizationEvidenceDigest,
      "authorizationEvidenceDigest",
    ),
    contractVersion: AUTHORIZATION_VERSION,
    sourceAdapterId: token(value.sourceAdapterId, "sourceAdapterId"),
    sourceBindingDigest: digest(value.sourceBindingDigest, "sourceBindingDigest"),
    validUntil: timestamp(value.validUntil, "authorizationValidUntil"),
  });
  if (value.contractVersion !== AUTHORIZATION_VERSION ||
    authorization.sourceAdapterId !== request.sourceBinding.sourceAdapterId ||
    authorization.sourceBindingDigest !== request.binding.sourceBindingDigest) {
    throw serviceError("schedule_task_source_authorization_invalid");
  }
  if (new Date(authorization.validUntil).getTime() <= new Date(checkedAt).getTime()) {
    throw serviceError("schedule_task_source_authorization_expired");
  }
  return authorization;
}

async function captureSnapshot(adapter, request, authorization, signal) {
  requireNotCanceled(signal);
  let value;
  try { value = await adapter.captureSnapshot({ ...request, authorization }, { signal }); }
  catch { throw serviceError("schedule_task_source_capture_failed"); }
  requireNotCanceled(signal);
  exactObject(value, CAPTURE_FIELDS, "schedule_task_source_capture_invalid");
  if (value.contractVersion !== CAPTURE_VERSION ||
    digest(value.authorizationEvidenceDigest, "authorizationEvidenceDigest") !==
      authorization.authorizationEvidenceDigest) {
    throw serviceError("schedule_task_source_capture_invalid");
  }
  return value;
}

function requireSameAuthorization(initial, current) {
  const sameAuthority = initial.authorizationEvidenceDigest === current.authorizationEvidenceDigest &&
    initial.sourceAdapterId === current.sourceAdapterId &&
    initial.sourceBindingDigest === current.sourceBindingDigest;
  const validityDidNotRegress = new Date(current.validUntil).getTime() >=
    new Date(initial.validUntil).getTime();
  if (!sameAuthority || !validityDidNotRegress) {
    throw serviceError("schedule_task_source_authorization_changed");
  }
}

function normalizeSignal(value) {
  if (value === null || value === undefined) return null;
  if (typeof value !== "object" || typeof value.aborted !== "boolean" ||
    typeof value.addEventListener !== "function") {
    throw new TypeError("schedule task input acquisition signal must be an AbortSignal");
  }
  return value;
}

function requireNotCanceled(signal) {
  if (signal?.aborted) throw serviceError("schedule_task_source_operation_canceled");
}

function normalizeRequest(value) {
  exactObject(value, REQUEST_FIELDS, "schedule_task_input_acquisition_request_invalid");
  return deepFreeze({
    canonicalTaskId: token(value.canonicalTaskId, "canonicalTaskId"),
    runId: token(value.runId, "runId"),
    tenantScope: token(value.tenantScope, "tenantScope"),
  });
}

function assertDependencies({ inputSnapshotRepository, now, resolveCurrentContext, resolveSourceAdapter }) {
  if (typeof inputSnapshotRepository?.getEvidence !== "function" ||
    typeof inputSnapshotRepository?.recordSnapshot !== "function") {
    throw new TypeError("schedule task input acquisition requires inputSnapshotRepository");
  }
  if (typeof now !== "function") throw new TypeError("schedule task input acquisition requires now");
  if (typeof resolveCurrentContext !== "function") {
    throw new TypeError("schedule task input acquisition requires resolveCurrentContext");
  }
  if (typeof resolveSourceAdapter !== "function") {
    throw new TypeError("schedule task input acquisition requires resolveSourceAdapter");
  }
}

function exactObject(value, fields, code) {
  if (!plainObject(value) || Object.keys(value).some((key) => !fields.has(key)) ||
    [...fields].some((key) => !Object.hasOwn(value, key))) throw serviceError(code);
}

function plainObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function token(value, field) {
  const result = String(value || "").trim();
  if (!TOKEN.test(result) || /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(result)) {
    throw serviceError("schedule_task_input_reference_invalid", field);
  }
  return result;
}

function digest(value, field) {
  const result = String(value || "").trim().toLowerCase();
  if (!DIGEST.test(result)) throw serviceError("schedule_task_input_digest_invalid", field);
  return result;
}

function positiveInteger(value, field) {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw serviceError("schedule_task_input_number_invalid", field);
  }
  return value;
}

function timestamp(value, field) {
  const input = value instanceof Date ? value.toISOString() : String(value || "").trim();
  const parsed = new Date(input);
  if (!input || !Number.isFinite(parsed.getTime()) || parsed.toISOString() !== input) {
    throw serviceError("schedule_task_input_timestamp_invalid", field);
  }
  return input;
}

function trustedNow(now) {
  try { return timestamp(now(), "now"); }
  catch (error) {
    if (error?.code) throw error;
    throw serviceError("schedule_task_input_clock_invalid");
  }
}

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  Object.freeze(value);
  Object.values(value).forEach(deepFreeze);
  return value;
}

function serviceError(code, detail = "") {
  const error = new Error(detail ? `${code}: ${detail}` : code);
  error.code = code;
  return error;
}

export {
  AUTHORIZATION_VERSION as SCHEDULE_TASK_SOURCE_AUTHORIZATION_CONTRACT_VERSION,
  CAPTURE_VERSION as SCHEDULE_TASK_SOURCE_CAPTURE_CONTRACT_VERSION,
  CONTEXT_VERSION as SCHEDULE_TASK_INPUT_ACQUISITION_CONTEXT_CONTRACT_VERSION,
  OWNERSHIP_VERSION as SCHEDULE_TASK_INPUT_ACQUISITION_OWNERSHIP_CONTRACT_VERSION,
  SERVICE_VERSION as SCHEDULE_TASK_INPUT_ACQUISITION_SERVICE_CONTRACT_VERSION,
};
