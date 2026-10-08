import { normalizeScheduleResultContract } from "./schedule-result-contract.mjs";
import {
  normalizeScheduleResultAlertContract,
  normalizeScheduleResultProcessingAuthority,
  normalizeScheduleResultRetentionDefinition,
} from "./schedule-result-processing-contract.mjs";
import { SCHEDULE_RUN_AUTHORITY_CONTEXT_CONTRACT_VERSION } from
  "./schedule-task-input-acquisition-context-resolver.mjs";

const RESOLVER_VERSION = "schedule-provider-result-execution-context-resolver.v1";
const CONTEXT_VERSION = "schedule-provider-result-execution-context.v1";
const REQUEST_FIELDS = new Set(["canonicalTaskId", "runId", "tenantScope"]);
const TOKEN = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,239}$/;

export function createScheduleProviderResultExecutionContextResolver({
  resolveProcessingAuthority,
  resolveProviderLease,
  resolveRunAuthorityContext,
} = {}) {
  for (const [name, value] of [
    ["resolveProcessingAuthority", resolveProcessingAuthority],
    ["resolveProviderLease", resolveProviderLease],
    ["resolveRunAuthorityContext", resolveRunAuthorityContext],
  ]) {
    if (typeof value !== "function") throw new TypeError(`${name} must be a function`);
  }

  async function resolve(value = {}, { recoveryOnly = false } = {}) {
    const request = normalizeRequest(value);
    if (typeof recoveryOnly !== "boolean") throw resolverError("schedule_provider_context_mode_invalid");
    const run = await currentRunContext(resolveRunAuthorityContext, request, recoveryOnly);
    const processingResolution = await processingAuthority(
      resolveProcessingAuthority,
      request.tenantScope,
      run.snapshot,
    );
    const providerLease = recoveryOnly ? null : await managedProviderLease(resolveProviderLease, {
      employeeId: run.intent.employeeId,
      providerBinding: run.snapshot.taskModelBinding,
      providerTimeoutPolicy: run.snapshot.providerTimeoutPolicy,
      scheduleId: run.intent.scheduleId,
      taskId: run.task.taskId,
      tenantScope: request.tenantScope,
    });
    return deepFreeze({
      contractVersion: CONTEXT_VERSION,
      execution: run.execution,
      inputSnapshotBinding: run.binding,
      intent: run.intent,
      processingResolution,
      providerLease,
      snapshot: run.snapshot,
      task: run.task,
      taskDefinitionResolution: run.taskDefinitionResolution,
    });
  }

  return Object.freeze({ contractVersion: RESOLVER_VERSION, resolve });
}

async function currentRunContext(resolver, request, recoveryOnly) {
  let value;
  try {
    value = await resolver(request, {
      executionPhase: "effect_dispatch_prepared",
      recoveryOnly,
    });
  } catch {
    throw resolverError("schedule_provider_context_run_authority_unavailable");
  }
  const matches = value?.contractVersion === SCHEDULE_RUN_AUTHORITY_CONTEXT_CONTRACT_VERSION &&
    value.binding?.tenantScope === request.tenantScope && value.binding.runId === request.runId &&
    value.binding.canonicalTaskId === request.canonicalTaskId &&
    value.intent?.runId === request.runId && value.execution?.runId === request.runId &&
    value.task?.taskId === request.canonicalTaskId && value.trigger;
  if (!matches) throw resolverError("schedule_provider_context_run_authority_invalid");
  return value;
}

async function processingAuthority(resolver, tenantScope, snapshot) {
  let value;
  try {
    value = await resolver({
      tenantScope,
      processingAuthorityDigest: snapshot.processingAuthorityDigest,
    });
  } catch {
    throw resolverError("schedule_provider_context_processing_unavailable");
  }
  if (!value || value.contractVersion !== "schedule-result-processing-resolution.v1") {
    throw resolverError("schedule_provider_context_processing_unavailable");
  }
  try {
    const resultContract = normalizeScheduleResultContract(value.resultContract);
    const alertContract = normalizeScheduleResultAlertContract(value.alertContract);
    const retentionDefinition = normalizeScheduleResultRetentionDefinition(value.retentionDefinition);
    const authority = normalizeScheduleResultProcessingAuthority(value.authority, {
      alertContract,
      resultContract,
      retentionDefinition,
    });
    if (authority.processingAuthorityDigest !== snapshot.processingAuthorityDigest ||
      authority.resultContractDigest !== snapshot.resultContractDigest ||
      authority.alertContractDigest !== snapshot.alertContractDigest ||
      authority.retentionDefinitionDigest !== snapshot.retentionDefinitionDigest) {
      throw resolverError("schedule_provider_context_processing_mismatch");
    }
    return deepFreeze({
      alertContract,
      authority,
      contractVersion: value.contractVersion,
      resultContract,
      retentionDefinition,
    });
  } catch (error) {
    if (error?.code === "schedule_provider_context_processing_mismatch") throw error;
    throw resolverError("schedule_provider_context_processing_invalid");
  }
}

async function managedProviderLease(resolver, request) {
  let value;
  try { value = await resolver(deepFreeze(request)); }
  catch { throw resolverError("schedule_provider_context_provider_unavailable"); }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw resolverError("schedule_provider_context_provider_unavailable");
  }
  return value;
}

function normalizeRequest(value) {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype) {
    throw resolverError("schedule_provider_context_request_invalid");
  }
  const keys = Object.keys(value);
  if (keys.length !== REQUEST_FIELDS.size || keys.some((key) => !REQUEST_FIELDS.has(key))) {
    throw resolverError("schedule_provider_context_request_invalid");
  }
  return deepFreeze({
    canonicalTaskId: token(value.canonicalTaskId),
    runId: token(value.runId),
    tenantScope: token(value.tenantScope),
  });
}

function token(value) {
  const result = String(value || "").trim();
  if (!TOKEN.test(result) || /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(result)) {
    throw resolverError("schedule_provider_context_reference_invalid");
  }
  return result;
}

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  Object.freeze(value);
  Object.values(value).forEach(deepFreeze);
  return value;
}

function resolverError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

export { RESOLVER_VERSION as SCHEDULE_PROVIDER_RESULT_EXECUTION_CONTEXT_RESOLVER_CONTRACT_VERSION };
