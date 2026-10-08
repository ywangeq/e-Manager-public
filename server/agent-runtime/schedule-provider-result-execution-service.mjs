import crypto from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { normalizeScheduleActivationSnapshotV2 } from "./schedule-activation-snapshot.mjs";
import {
  createProviderAttemptRequestId,
  normalizeProviderAttemptDescriptor,
} from "./provider-attempt-receipt-contract-v1.mjs";
import { normalizeProviderTimeoutPolicy } from "./provider-timeout-policy.mjs";
import { normalizeScheduleResultContract } from "./schedule-result-contract.mjs";
import {
  normalizeScheduleResultAlertContract,
  normalizeScheduleResultProcessingAuthority,
  normalizeScheduleResultRetentionDefinition,
} from "./schedule-result-processing-contract.mjs";
import {
  normalizeScheduleTaskExecutionDefinitionV2,
  scheduleTaskInputContractDigest,
} from "./schedule-task-execution-definition.mjs";
import { scheduleTaskInputRetentionDefinitionDigest } from "./schedule-task-input-retention-contract.mjs";
import { normalizeScheduleTaskInputSnapshotBinding } from
  "./sqlite-schedule-task-input-snapshot-repository.mjs";

const SERVICE_VERSION = "schedule-provider-result-execution-service.v1";
const CONTEXT_VERSION = "schedule-provider-result-execution-context.v1";
const REQUEST_FIELDS = new Set(["canonicalTaskId", "runId", "tenantScope"]);
const CONTEXT_FIELDS = new Set([
  "contractVersion", "execution", "inputSnapshotBinding", "intent", "processingResolution",
  "providerLease", "snapshot", "task", "taskDefinitionResolution",
]);
const PROVIDER_RESPONSE_FIELDS = new Set([
  "contractVersion", "envelope", "payloadBoundary", "providerRequestId", "providerResponseRef", "usage",
]);
const PROCESSING_RESOLUTION_FIELDS = new Set([
  "alertContract", "authority", "contractVersion", "resultContract", "retentionDefinition",
]);
const TOKEN = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,179}$/;
const DIGEST = /^[a-f0-9]{64}$/;
const SAFE_PROVIDER_FAILURE_CODES = new Set([
  "agent_turn_canceled", "execution_task_ownership_lost", "model_provider_unavailable",
  "model_request_invalid", "model_response_contract_invalid", "provider_connect_timeout",
  "provider_first_semantic_output_timeout", "provider_request_total_timeout",
  "provider_stream_idle_timeout", "task_execution_timeout",
]);

export function createScheduleProviderResultExecutionService({
  executionTaskRepository,
  inputSnapshotRepository,
  now = () => new Date(),
  resolveCurrentContext,
  responsesAgentRunner,
  resultIngestRepository,
  resultSettlementService,
} = {}) {
  requireMethods(executionTaskRepository, "executionTaskRepository", [
    "beginProviderAttemptWithLease", "commitProviderAttemptWithLease",
    "readProviderAttemptReceiptExact",
  ]);
  requireMethods(inputSnapshotRepository, "inputSnapshotRepository", [
    "readInternalSnapshotByBinding",
  ]);
  requireMethods(resultIngestRepository, "resultIngestRepository", ["getEvidence", "recordEnvelope"]);
  requireMethods(responsesAgentRunner, "responsesAgentRunner", ["runStructuredResultOnly"]);
  requireMethods(resultSettlementService, "resultSettlementService", ["prepareCanonicalSettlement"]);
  if (typeof resolveCurrentContext !== "function") throw new TypeError("resolveCurrentContext must be a function");
  if (typeof now !== "function") throw new TypeError("now must be a function");
  const inFlight = new Map();

  function execute(value = {}, { signal = null } = {}) {
    return run(value, { recoveryOnly: false, signal });
  }

  function recover(value = {}, { signal = null } = {}) {
    return run(value, { recoveryOnly: true, signal });
  }

  function run(value, { recoveryOnly, signal }) {
    const request = normalizeRequest(value);
    const key = `${request.tenantScope}\0${request.canonicalTaskId}`;
    const existing = inFlight.get(key);
    if (existing) return existing;
    const operation = executeOnce(request, signal, recoveryOnly).finally(() => {
      if (inFlight.get(key) === operation) inFlight.delete(key);
    });
    inFlight.set(key, operation);
    return operation;
  }

  async function executeOnce(request, signal, forceRecoveryOnly) {
    let receipt = executionTaskRepository.readProviderAttemptReceiptExact({
      tenantScope: request.tenantScope,
      taskId: request.canonicalTaskId,
      executionScopeId: request.runId,
      purpose: "schedule_result",
    });
    if (forceRecoveryOnly && !receipt) {
      throw serviceError("schedule_provider_attempt_not_started");
    }
    if (receipt?.status === "response_recorded") return settle(resultSettlementService, request);
    if (receipt && receipt.status !== "dispatch_prepared") throw terminalAttemptError(receipt.status);
    const recoveryOnly = Boolean(receipt);
    const context = await currentContext(resolveCurrentContext, request, now, recoveryOnly);
    const internalInput = inputSnapshotRepository.readInternalSnapshotByBinding({
      tenantScope: request.tenantScope,
      runId: request.runId,
      expectedBinding: context.inputSnapshotBinding,
    });
    if (!internalInput || internalInput.contractVersion !== "schedule-task-input-snapshot-internal.v1" ||
      internalInput.payloadBoundary !== "internal_only") {
      throw serviceError("schedule_provider_input_snapshot_unavailable");
    }
    const descriptor = createAttemptDescriptor(context, internalInput.evidence);
    const identity = providerAttemptIdentity(context.task);
    if (receipt) requireSameDescriptor(receipt, descriptor);

    if (!receipt) {
      const dispatchAt = trustedNow(now);
      requireCurrentRun(
        request,
        context.intent,
        context.execution,
        context.task,
        context.snapshot,
        dispatchAt,
        false,
      );
      const begun = executionTaskRepository.beginProviderAttemptWithLease({
        ...descriptor,
        ...identity,
        now: dispatchAt,
      });
      if (!begun) throw serviceError("schedule_provider_attempt_fenced");
      receipt = begun.receipt;
      if (!begun.created) {
        if (receipt.status === "response_recorded") return settle(resultSettlementService, request);
        if (receipt.status !== "dispatch_prepared") throw terminalAttemptError(receipt.status);
        return recoverPreparedAttempt({ context, descriptor, identity, receipt, request });
      }
    } else {
      return recoverPreparedAttempt({ context, descriptor, identity, receipt, request });
    }

    let response;
    try {
      response = await responsesAgentRunner.runStructuredResultOnly({
        lease: context.providerLease,
        request: {
          contractVersion: "schedule-structured-provider-request.v1",
          inputSnapshot: internalInput.snapshot,
          providerRequestId: descriptor.providerRequestId,
          resultContract: context.resultContract,
          taskDefinition: context.taskDefinition,
        },
        runtimeTask: context.task,
        signal,
      });
    } catch (error) {
      commitUnknown(executionTaskRepository, descriptor, identity, now, safeProviderFailure(error));
      throw serviceError("schedule_provider_attempt_unknown");
    }
    try {
      response = normalizeProviderResponse(response, descriptor.providerRequestId);
    } catch {
      commitUnknown(executionTaskRepository, descriptor, identity, now,
        "schedule_provider_response_contract_invalid");
      throw serviceError("schedule_provider_attempt_unknown");
    }

    let ingest;
    try {
      ingest = resultIngestRepository.recordEnvelope({
        binding: context.ingestBinding,
        envelope: response.envelope,
        providerAttemptEvidenceDigest: receipt.attemptEvidenceDigest,
        providerResponseRef: response.providerResponseRef,
      }).evidence;
    } catch {
      ingest = recoverIngestAfterWriteUncertainty({
        context,
        receipt,
        request,
        resultIngestRepository,
      });
      if (!ingest) {
        commitUnknown(executionTaskRepository, descriptor, identity, now,
          "schedule_provider_response_ingest_failed");
        throw serviceError("schedule_provider_attempt_unknown");
      }
    }
    commitRecordedResponse(executionTaskRepository, descriptor, identity, ingest, now);
    return settle(resultSettlementService, request);
  }

  function recoverPreparedAttempt({ context, descriptor, identity, receipt, request }) {
    let ingest;
    try {
      ingest = resultIngestRepository.getEvidence({
        tenantScope: request.tenantScope,
        runId: request.runId,
        expectedBinding: context.ingestBinding,
        providerAttemptEvidenceDigest: receipt.attemptEvidenceDigest,
      });
    } catch {
      throw serviceError("schedule_provider_ingest_recovery_failed");
    }
    if (!ingest) {
      commitUnknown(executionTaskRepository, descriptor, identity, now,
        "schedule_provider_response_unavailable");
      throw serviceError("schedule_provider_attempt_unknown");
    }
    commitRecordedResponse(executionTaskRepository, descriptor, identity, ingest, now);
    return settle(resultSettlementService, request);
  }

  return Object.freeze({ contractVersion: SERVICE_VERSION, execute, recover });
}

async function currentContext(resolver, request, now, recoveryOnly) {
  let value;
  try { value = await resolver(request, { recoveryOnly }); }
  catch { throw serviceError("schedule_provider_execution_context_unavailable"); }
  const checkedAt = trustedNow(now);
  return normalizeContext(value, request, checkedAt, recoveryOnly);
}

function normalizeContext(value, request, checkedAt, recoveryOnly) {
  exactObject(value, CONTEXT_FIELDS, "schedule_provider_execution_context_invalid");
  if (value.contractVersion !== CONTEXT_VERSION) {
    throw serviceError("schedule_provider_execution_context_invalid");
  }
  const snapshot = normalizeScheduleActivationSnapshotV2(value.snapshot);
  const inputSnapshotBinding = normalizeScheduleTaskInputSnapshotBinding(value.inputSnapshotBinding);
  const taskDefinitionResolution = normalizeTaskResolution(value.taskDefinitionResolution);
  const processingResolution = normalizeProcessingResolution(value.processingResolution);
  const intent = value.intent;
  const execution = value.execution;
  const task = value.task;
  requireCurrentRun(request, intent, execution, task, snapshot, checkedAt, recoveryOnly);
  requireContextAuthorities({
    execution,
    inputSnapshotBinding,
    intent,
    processingResolution,
    snapshot,
    task,
    taskDefinitionResolution,
  });
  const providerLease = recoveryOnly ? null : normalizeProviderLease(
    value.providerLease,
    snapshot.taskModelBinding,
    snapshot.providerTimeoutPolicy,
  );
  return deepFreeze({
    execution,
    ingestBinding: createIngestBinding(intent, snapshot),
    inputSnapshotBinding,
    intent,
    processingResolution,
    providerLease,
    resultContract: processingResolution.resultContract,
    snapshot,
    task,
    taskDefinition: taskDefinitionResolution.definition,
    taskDefinitionResolution,
  });
}

function requireCurrentRun(request, intent, execution, task, snapshot, checkedAt, recoveryOnly) {
  const current = intent?.tenantScope === request.tenantScope && intent.runId === request.runId &&
    intent.intentState === "submitted" && intent.executionTaskId === request.canonicalTaskId &&
    execution?.tenantScope === request.tenantScope && execution.runId === request.runId &&
    execution.executionTaskId === request.canonicalTaskId && execution.executionState === "active" &&
    execution.executionPhase === "effect_dispatch_prepared" && execution.admissionOutcome === "admitted" &&
    execution.resultReceiptRequirement === "required" && !execution.resultReceiptDigest &&
    task?.tenantScope === request.tenantScope && task.taskId === request.canonicalTaskId &&
    task.status === "running" && task.lease &&
    snapshot.tenantScope === request.tenantScope && snapshot.employeeId === intent.employeeId &&
    snapshot.scheduleId === intent.scheduleId && snapshot.activationVersion === intent.activationVersion &&
    snapshot.snapshotDigest === intent.activationSnapshotDigest &&
    `schedule_activation_snapshot_${snapshot.snapshotDigest}` === intent.activationSnapshotId;
  if (!current) throw serviceError("schedule_provider_execution_context_not_current");
  const taskLeaseMatches = execution.executionTaskId === task.taskId && task.inputDigest &&
    task.lease.leaseId && task.lease.workerIdDigest && task.lease.fencingToken;
  if (!taskLeaseMatches) throw serviceError("schedule_provider_execution_lease_mismatch");
  const checkedAtMs = Date.parse(checkedAt);
  const runLeaseExpiresAtMs = Date.parse(execution.leaseExpiresAt || "");
  const taskLeaseExpiresAtMs = Date.parse(task.lease.expiresAt || "");
  const recordedTaskLeaseExpiresAtMs = Date.parse(execution.taskLeaseExpiresAt || "");
  if (!Number.isFinite(taskLeaseExpiresAtMs) || taskLeaseExpiresAtMs <= checkedAtMs) {
    throw serviceError("schedule_provider_execution_lease_expired");
  }
  if (recoveryOnly) return;
  const dualLeaseMatches = execution.leaseId && execution.ownerDigest &&
    execution.taskLeaseId === task.lease.leaseId &&
    execution.taskOwnerDigest === task.lease.workerIdDigest &&
    execution.taskFencingToken === task.lease.fencingToken;
  if (!dualLeaseMatches) throw serviceError("schedule_provider_execution_lease_mismatch");
  if (!Number.isFinite(runLeaseExpiresAtMs) || !Number.isFinite(recordedTaskLeaseExpiresAtMs) ||
    runLeaseExpiresAtMs <= checkedAtMs || recordedTaskLeaseExpiresAtMs <= checkedAtMs ||
    runLeaseExpiresAtMs > taskLeaseExpiresAtMs || recordedTaskLeaseExpiresAtMs > taskLeaseExpiresAtMs) {
    throw serviceError("schedule_provider_execution_lease_expired");
  }
}

function normalizeTaskResolution(value) {
  if (!value || value.contractVersion !== "schedule-task-execution-definition-resolution.v1" ||
    value.payloadBoundary !== "internal_only") {
    throw serviceError("schedule_provider_task_definition_invalid");
  }
  return deepFreeze({
    contractVersion: value.contractVersion,
    definition: normalizeScheduleTaskExecutionDefinitionV2(value.definition),
    executionContractDigest: digest(value.executionContractDigest),
    payloadBoundary: "internal_only",
    publishedAt: timestamp(value.publishedAt),
  });
}

function normalizeProcessingResolution(value) {
  exactObject(value, PROCESSING_RESOLUTION_FIELDS, "schedule_provider_processing_authority_invalid");
  if (value.contractVersion !== "schedule-result-processing-resolution.v1") {
    throw serviceError("schedule_provider_processing_authority_invalid");
  }
  const resultContract = normalizeScheduleResultContract(value.resultContract);
  const alertContract = normalizeScheduleResultAlertContract(value.alertContract);
  const retentionDefinition = normalizeScheduleResultRetentionDefinition(value.retentionDefinition);
  const authority = normalizeScheduleResultProcessingAuthority(value.authority, {
    alertContract,
    resultContract,
    retentionDefinition,
  });
  return deepFreeze({
    alertContract,
    authority,
    contractVersion: value.contractVersion,
    resultContract,
    retentionDefinition,
  });
}

function requireContextAuthorities({ execution, inputSnapshotBinding, intent, processingResolution, snapshot,
  task, taskDefinitionResolution }) {
  const definition = taskDefinitionResolution.definition;
  const matches = taskDefinitionResolution.executionContractDigest === snapshot.executionContractDigest &&
    definition.taskDefinitionId === snapshot.taskDefinitionId &&
    definition.resultContractDigest === snapshot.resultContractDigest &&
    processingResolution.authority.processingAuthorityDigest === snapshot.processingAuthorityDigest &&
    processingResolution.authority.alertContractDigest === snapshot.alertContractDigest &&
    processingResolution.authority.retentionDefinitionDigest === snapshot.retentionDefinitionDigest &&
    processingResolution.resultContract.contractDigest === snapshot.resultContractDigest &&
    inputSnapshotBinding.activationSnapshotDigest === snapshot.snapshotDigest &&
    inputSnapshotBinding.activationSnapshotId === `schedule_activation_snapshot_${snapshot.snapshotDigest}` &&
    inputSnapshotBinding.activationVersion === snapshot.activationVersion &&
    inputSnapshotBinding.tenantScope === snapshot.tenantScope &&
    inputSnapshotBinding.employeeId === snapshot.employeeId &&
    inputSnapshotBinding.scheduleId === snapshot.scheduleId &&
    inputSnapshotBinding.runId === intent.runId &&
    inputSnapshotBinding.canonicalTaskId === task.taskId &&
    inputSnapshotBinding.triggerId === intent.expectedTriggerId &&
    inputSnapshotBinding.scheduledFor === intent.scheduledFor &&
    inputSnapshotBinding.executionContractDigest === snapshot.executionContractDigest &&
    inputSnapshotBinding.taskDefinitionId === definition.taskDefinitionId &&
    inputSnapshotBinding.taskDefinitionVersion === definition.taskDefinitionVersion &&
    inputSnapshotBinding.inputContractDigest === scheduleTaskInputContractDigest(definition.inputContract) &&
    inputSnapshotBinding.maxItems === definition.inputContract.maxItems &&
    inputSnapshotBinding.maxPayloadBytes === definition.inputContract.maxPayloadBytes &&
    inputSnapshotBinding.retentionDefinitionDigest ===
      scheduleTaskInputRetentionDefinitionDigest(definition.inputContract.retentionDefinition) &&
    inputSnapshotBinding.snapshotRetentionSeconds ===
      definition.inputContract.retentionDefinition.snapshotRetentionSeconds &&
    inputSnapshotBinding.sourceAdapterId === definition.inputContract.sourceAdapterId &&
    inputSnapshotBinding.sourceBindingDigest === definition.inputContract.sourceBindingDigest &&
    execution.employeeId === intent.employeeId && execution.scheduleId === intent.scheduleId &&
    execution.activationVersion === intent.activationVersion;
  if (!matches) throw serviceError("schedule_provider_execution_authority_mismatch");
}

function normalizeProviderLease(value, binding, expectedTimeoutPolicy) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw serviceError("schedule_provider_lease_unavailable");
  }
  const matches = value.model === binding.model && value.modelId === binding.modelId &&
    value.modelLevelId === binding.modelLevelId && value.provider === binding.provider &&
    value.providerRouteId === binding.providerRouteId &&
    value.capabilityProfileVersion === binding.requiredCapabilityProfileVersion &&
    !String(value.fallbackRouteId || "").trim() && value.authSecret && value.baseUrl;
  let timeoutPolicy;
  try { timeoutPolicy = normalizeProviderTimeoutPolicy(value.timeoutPolicy); }
  catch { throw serviceError("schedule_provider_lease_mismatch"); }
  if (!matches || !isDeepStrictEqual(timeoutPolicy, normalizeProviderTimeoutPolicy(expectedTimeoutPolicy))) {
    throw serviceError("schedule_provider_lease_mismatch");
  }
  return {
    ...value,
    fallbackRouteId: "",
    retryCount: 0,
    timeoutPolicy,
  };
}

function normalizeProviderResponse(value, providerRequestId) {
  exactObject(value, PROVIDER_RESPONSE_FIELDS, "schedule_provider_response_invalid");
  if (value.contractVersion !== "schedule-structured-provider-response.v1" ||
    value.payloadBoundary !== "internal_only" || value.providerRequestId !== providerRequestId ||
    !value.envelope || typeof value.envelope !== "object" || Array.isArray(value.envelope)) {
    throw serviceError("schedule_provider_response_invalid");
  }
  return {
    contractVersion: value.contractVersion,
    envelope: value.envelope,
    payloadBoundary: "internal_only",
    providerRequestId,
    providerResponseRef: token(value.providerResponseRef),
    usage: value.usage,
  };
}

function recoverIngestAfterWriteUncertainty({ context, receipt, request, resultIngestRepository }) {
  try {
    return resultIngestRepository.getEvidence({
      tenantScope: request.tenantScope,
      runId: request.runId,
      expectedBinding: context.ingestBinding,
      providerAttemptEvidenceDigest: receipt.attemptEvidenceDigest,
    });
  } catch {
    throw serviceError("schedule_provider_ingest_recovery_failed");
  }
}

function createAttemptDescriptor(context, inputEvidence) {
  if (inputEvidence?.contractVersion !== "schedule-task-input-snapshot-evidence.v2" ||
    inputEvidence.state !== "sealed") {
    throw serviceError("schedule_provider_input_snapshot_invalid");
  }
  const identity = {
    tenantScope: context.intent.tenantScope,
    taskId: context.task.taskId,
    executionScopeId: context.intent.runId,
    purpose: "schedule_result",
    requestDigest: digestCanonical({
      contractVersion: "schedule-provider-structured-request-digest.v1",
      executionContractDigest: context.snapshot.executionContractDigest,
      inputSnapshotEvidenceDigest: digest(inputEvidence.evidenceDigest),
      inputSnapshotRef: token(inputEvidence.inputSnapshotRef),
      processingAuthorityDigest: context.snapshot.processingAuthorityDigest,
      providerBindingDigest: context.snapshot.taskModelBinding.bindingDigest,
      resultContractDigest: context.snapshot.resultContractDigest,
    }),
    providerBindingDigest: context.snapshot.taskModelBinding.bindingDigest,
    inputDigest: context.task.inputDigest,
    recoveryMode: "none",
  };
  return normalizeProviderAttemptDescriptor({
    contractVersion: "provider-attempt-receipt.v1",
    ...identity,
    providerRequestId: createProviderAttemptRequestId(identity),
  });
}

function createIngestBinding(intent, snapshot) {
  return deepFreeze({
    contractVersion: "schedule-result-ingest-binding.v1",
    tenantScope: intent.tenantScope,
    employeeId: intent.employeeId,
    scheduleId: intent.scheduleId,
    runId: intent.runId,
    canonicalTaskId: intent.executionTaskId,
    triggerId: intent.expectedTriggerId,
    scheduledFor: intent.scheduledFor,
    activationVersion: intent.activationVersion,
    activationSnapshotId: intent.activationSnapshotId,
    activationSnapshotDigest: intent.activationSnapshotDigest,
    resultContractDigest: snapshot.resultContractDigest,
    alertContractDigest: snapshot.alertContractDigest,
  });
}

function providerAttemptIdentity(task) {
  return {
    tenantScope: task.tenantScope,
    taskId: task.taskId,
    leaseId: task.lease.leaseId,
    workerIdDigest: task.lease.workerIdDigest,
    fencingToken: task.lease.fencingToken,
  };
}

function requireSameDescriptor(receipt, descriptor) {
  const fields = [
    "contractVersion", "tenantScope", "taskId", "executionScopeId", "purpose",
    "providerRequestId", "requestDigest", "providerBindingDigest", "inputDigest", "recoveryMode",
  ];
  if (fields.some((field) => !isDeepStrictEqual(receipt[field], descriptor[field]))) {
    throw serviceError("schedule_provider_attempt_conflict");
  }
}

function commitRecordedResponse(repository, descriptor, identity, ingest, now) {
  const receipt = repository.commitProviderAttemptWithLease({
    ...descriptor,
    ...identity,
    status: "response_recorded",
    safeResultCode: "provider_response_recorded",
    ingestRef: ingest.ingestRef,
    ingestEvidenceDigest: ingest.evidenceDigest,
    now: trustedNow(now),
  });
  if (!receipt || receipt.status !== "response_recorded") {
    throw serviceError("schedule_provider_response_receipt_unavailable");
  }
  return receipt;
}

function commitUnknown(repository, descriptor, identity, now, safeResultCode) {
  try {
    repository.commitProviderAttemptWithLease({
      ...descriptor,
      ...identity,
      status: "unknown",
      safeResultCode: token(safeResultCode),
      ingestRef: null,
      ingestEvidenceDigest: null,
      now: trustedNow(now),
    });
  } catch {
    // The prepared attempt remains a durable no-retry blocker when this best-effort transition loses ownership.
  }
}

async function settle(service, request) {
  try { return await service.prepareCanonicalSettlement(request); }
  catch { throw serviceError("schedule_provider_result_settlement_unavailable"); }
}

function terminalAttemptError(status) {
  return serviceError(status === "unknown"
    ? "schedule_provider_attempt_unknown"
    : "schedule_provider_attempt_definitive_failure");
}

function safeProviderFailure(error) {
  const code = String(error?.code || "");
  return SAFE_PROVIDER_FAILURE_CODES.has(code) ? code : "schedule_provider_request_uncertain";
}

function normalizeRequest(value) {
  exactObject(value, REQUEST_FIELDS, "schedule_provider_execution_request_invalid");
  return deepFreeze({
    canonicalTaskId: token(value.canonicalTaskId),
    runId: token(value.runId),
    tenantScope: token(value.tenantScope),
  });
}

function exactObject(value, fields, code) {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype) throw serviceError(code);
  const keys = Object.keys(value);
  if (keys.length !== fields.size || keys.some((key) => !fields.has(key))) throw serviceError(code);
}

function requireMethods(value, name, methods) {
  for (const method of methods) {
    if (typeof value?.[method] !== "function") throw new TypeError(`${name}.${method} must be a function`);
  }
}

function trustedNow(now) {
  try { return timestamp(now()); }
  catch (error) { if (error?.code) throw error; throw serviceError("schedule_provider_clock_invalid"); }
}

function token(value) {
  const result = String(value || "").trim();
  if (!TOKEN.test(result) || /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(result)) {
    throw serviceError("schedule_provider_reference_invalid");
  }
  return result;
}

function digest(value) {
  const result = String(value || "").trim().toLowerCase();
  if (!DIGEST.test(result)) throw serviceError("schedule_provider_digest_invalid");
  return result;
}

function timestamp(value) {
  const input = value instanceof Date ? value.toISOString() : String(value || "").trim();
  const parsed = new Date(input);
  if (!input || !Number.isFinite(parsed.getTime()) || parsed.toISOString() !== input) {
    throw serviceError("schedule_provider_timestamp_invalid");
  }
  return input;
}

function digestCanonical(value) {
  return crypto.createHash("sha256").update(canonicalJson(value)).digest("hex");
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) =>
      `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  Object.freeze(value);
  Object.values(value).forEach(deepFreeze);
  return value;
}

function serviceError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}
