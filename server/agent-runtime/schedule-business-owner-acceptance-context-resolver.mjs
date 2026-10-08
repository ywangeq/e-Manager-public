import { isDeepStrictEqual } from "node:util";
import {
  normalizeScheduleResultAlertContract,
  normalizeScheduleResultProcessingAuthority,
  normalizeScheduleResultRetentionDefinition,
} from "./schedule-result-processing-contract.mjs";
import { normalizeScheduleResultContract } from "./schedule-result-contract.mjs";
import { normalizeScheduleTaskExecutionDefinitionV2 } from "./schedule-task-execution-definition.mjs";
import { normalizeProviderTimeoutPolicy } from "./provider-timeout-policy.mjs";
import {
  SCHEDULE_PRE_OWNER_READINESS_EVIDENCE_CONTRACT_VERSION,
  createSchedulePreOwnerReadinessEvidence,
} from "./schedule-pre-owner-readiness.mjs";

const RESOLVER_VERSION = "schedule-business-owner-acceptance-context-resolver.v1";
const CONTEXT_VERSION = "schedule-business-owner-acceptance-context.v1";
const BINDING_VERSION = "schedule-business-owner-current-binding.v1";
const REQUEST_FIELDS = new Set(["employeeId", "evaluatedAt", "scheduleId", "tenantScope"]);
const BINDING_FIELDS = new Set([
  "acceptancePolicy", "contractVersion", "employeeId", "employeeVersion", "executionContractDigest",
  "ownerTarget", "providerTimeoutPolicy", "registrarSubjectDigest", "registrationVersion", "scheduleId",
  "schedulePolicyDigest", "scheduleVersion", "taskDefinitionId", "taskModelBinding", "tenantScope",
  "writebackContractDigest",
]);
const OWNER_TARGET_FIELDS = new Set(["targetId", "targetType"]);
const MODEL_BINDING_FIELDS = new Set([
  "assignmentAppliedVersion", "assignmentId", "assignmentSetDigest", "bindingDigest", "bindingVersion",
  "contractVersion", "model", "modelId", "modelLevelId", "provider", "providerName", "providerRouteId",
  "requiredCapabilityProfileVersion", "status", "taskId",
]);
const ACCEPTANCE_POLICY_FIELDS = new Set([
  "contractVersion", "maxValiditySeconds", "policyDigest", "policyVersion",
]);
const TOKEN = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,239}$/;
const DIGEST = /^[a-f0-9]{64}$/;

export function createScheduleBusinessOwnerAcceptanceContextResolver({
  getCanonicalTask,
  getLatestProviderTrial,
  resolveCurrentScheduleBinding,
  resolveProcessingAuthorityForTask,
  resolveTaskExecutionDefinition,
} = {}) {
  for (const [name, value] of Object.entries({
    getCanonicalTask,
    getLatestProviderTrial,
    resolveCurrentScheduleBinding,
    resolveProcessingAuthorityForTask,
    resolveTaskExecutionDefinition,
  })) {
    if (typeof value !== "function") throw new TypeError(`${name} must be a function`);
  }

  async function resolveCurrentAcceptanceContext(value = {}) {
    const request = normalizeRequest(value);
    const binding = await currentBinding(resolveCurrentScheduleBinding, request);
    const trial = currentProviderTrial({ getCanonicalTask, getLatestProviderTrial, binding, request });
    const taskResolution = await taskDefinition(resolveTaskExecutionDefinition, binding, request);
    const processing = await processingAuthority(
      resolveProcessingAuthorityForTask,
      binding,
      request,
      taskResolution.definition,
    );
    const readiness = createSchedulePreOwnerReadinessEvidence({
      contractVersion: "schedule-pre-owner-readiness-input.v1",
      tenantScope: binding.tenantScope,
      employeeId: binding.employeeId,
      employeeVersion: binding.employeeVersion,
      scheduleId: binding.scheduleId,
      scheduleVersion: binding.scheduleVersion,
      registrationVersion: binding.registrationVersion,
      taskDefinitionId: binding.taskDefinitionId,
      schedulePolicyDigest: binding.schedulePolicyDigest,
      executionContractDigest: binding.executionContractDigest,
      taskBindingDigest: binding.taskModelBinding.bindingDigest,
      providerTrialEvidenceDigest: trial.evidenceDigest,
      providerTimeoutPolicy: binding.providerTimeoutPolicy,
      resultContractDigest: processing.authority.resultContractDigest,
      alertContractDigest: processing.authority.alertContractDigest,
      retentionDefinitionDigest: processing.authority.retentionDefinitionDigest,
      processingAuthorityDigest: processing.authority.processingAuthorityDigest,
      writebackContractDigest: binding.writebackContractDigest,
      evaluatedAt: request.evaluatedAt,
    });
    return deepFreeze({
      contractVersion: CONTEXT_VERSION,
      tenantScope: binding.tenantScope,
      employeeId: binding.employeeId,
      employeeVersion: binding.employeeVersion,
      scheduleId: binding.scheduleId,
      scheduleVersion: binding.scheduleVersion,
      registrationVersion: binding.registrationVersion,
      registrarSubjectDigest: binding.registrarSubjectDigest,
      taskDefinitionId: binding.taskDefinitionId,
      schedulePolicyDigest: binding.schedulePolicyDigest,
      executionContractDigest: binding.executionContractDigest,
      taskBindingDigest: binding.taskModelBinding.bindingDigest,
      providerTrial: trial,
      providerTimeoutPolicy: binding.providerTimeoutPolicy,
      resultContractDigest: processing.authority.resultContractDigest,
      alertContractDigest: processing.authority.alertContractDigest,
      retentionDefinitionDigest: processing.authority.retentionDefinitionDigest,
      processingAuthorityDigest: processing.authority.processingAuthorityDigest,
      writebackContractDigest: binding.writebackContractDigest,
      acceptancePolicy: binding.acceptancePolicy,
      readiness: {
        contractVersion: "schedule-pre-owner-readiness.v1",
        readinessVersion: readiness.readinessVersion,
        readinessDigest: readiness.readinessDigest,
      },
      ownerTarget: binding.ownerTarget,
    });
  }

  return Object.freeze({ contractVersion: RESOLVER_VERSION, resolveCurrentAcceptanceContext });
}

async function currentBinding(resolver, request) {
  let value;
  try { value = await resolver(request); }
  catch { throw resolverError("schedule_owner_context_binding_unavailable"); }
  exactObject(value, BINDING_FIELDS, "schedule_owner_context_binding_invalid");
  if (value.contractVersion !== BINDING_VERSION || value.tenantScope !== request.tenantScope ||
    value.employeeId !== request.employeeId || value.scheduleId !== request.scheduleId) {
    throw resolverError("schedule_owner_context_binding_invalid");
  }
  exactObject(value.ownerTarget, OWNER_TARGET_FIELDS, "schedule_owner_context_owner_target_invalid");
  exactObject(value.taskModelBinding, MODEL_BINDING_FIELDS, "schedule_owner_context_model_binding_invalid");
  if (value.taskModelBinding.contractVersion !== "digital-employee-task-model-binding.v1" ||
    value.taskModelBinding.status !== "applied" || value.taskModelBinding.taskId !== value.taskDefinitionId) {
    throw resolverError("schedule_owner_context_model_binding_invalid");
  }
  exactObject(value.acceptancePolicy, ACCEPTANCE_POLICY_FIELDS, "schedule_owner_context_policy_invalid");
  if (value.acceptancePolicy.contractVersion !== "schedule-business-owner-acceptance-policy.v1") {
    throw resolverError("schedule_owner_context_policy_invalid");
  }
  return deepFreeze({
    contractVersion: BINDING_VERSION,
    tenantScope: token(value.tenantScope),
    employeeId: token(value.employeeId),
    employeeVersion: token(value.employeeVersion),
    scheduleId: token(value.scheduleId),
    scheduleVersion: token(value.scheduleVersion),
    registrationVersion: positiveInteger(value.registrationVersion),
    registrarSubjectDigest: digest(value.registrarSubjectDigest),
    taskDefinitionId: token(value.taskDefinitionId),
    schedulePolicyDigest: digest(value.schedulePolicyDigest),
    executionContractDigest: digest(value.executionContractDigest),
    taskModelBinding: normalizeModelBinding(value.taskModelBinding),
    providerTimeoutPolicy: normalizeProviderTimeoutPolicy(value.providerTimeoutPolicy),
    ownerTarget: deepFreeze({
      targetType: enumValue(value.ownerTarget.targetType, new Set(["department", "digital_employee"])),
      targetId: token(value.ownerTarget.targetId),
    }),
    writebackContractDigest: digest(value.writebackContractDigest),
    acceptancePolicy: deepFreeze({
      contractVersion: "schedule-business-owner-acceptance-policy.v1",
      policyVersion: token(value.acceptancePolicy.policyVersion),
      maxValiditySeconds: boundedInteger(value.acceptancePolicy.maxValiditySeconds, 1, 31_536_000),
      policyDigest: digest(value.acceptancePolicy.policyDigest),
    }),
  });
}

function currentProviderTrial({ getCanonicalTask, getLatestProviderTrial, binding, request }) {
  let dryRun;
  try { dryRun = getLatestProviderTrial(request); }
  catch { throw resolverError("schedule_owner_context_provider_trial_unavailable"); }
  if (!dryRun || typeof dryRun !== "object") {
    throw resolverError("schedule_owner_context_provider_trial_unavailable");
  }
  let taskId;
  try { taskId = token(dryRun.executionTaskId); }
  catch { throw resolverError("schedule_owner_context_provider_trial_unavailable"); }
  let task;
  try { task = getCanonicalTask(taskId, { tenantScope: request.tenantScope }); }
  catch { throw resolverError("schedule_owner_context_provider_trial_task_unavailable"); }
  const exact = dryRun?.contractVersion === "schedule-provider-dry-run-repository.v1" &&
    dryRun.tenantScope === binding.tenantScope && dryRun.employeeId === binding.employeeId &&
    dryRun.employeeVersion === binding.employeeVersion && dryRun.scheduleId === binding.scheduleId &&
    dryRun.scheduleVersion === binding.scheduleVersion && dryRun.registrationVersion === binding.registrationVersion &&
    dryRun.taskId === binding.taskDefinitionId && dryRun.schedulePolicyDigest === binding.schedulePolicyDigest &&
    dryRun.executionContractDigest === binding.executionContractDigest &&
    dryRun.submission?.state === "submitted" && dryRun.evidence?.contractVersion === "schedule-provider-dry-run-evidence.v1" &&
    dryRun.evidence.state === "committed" && dryRun.evidence.outcome === "passed" &&
    dryRun.evidence.providerAttempts === 1 && safeZeroEffects(dryRun.evidence.safetyEvidence) &&
    dryRun.canonicalTerminal?.taskStatus === "completed" &&
    task?.taskId === taskId && task.tenantScope === binding.tenantScope && task.employeeId === binding.employeeId &&
    task.status === "completed" && task.revision === dryRun.canonicalTerminal.taskRevision &&
    task.sourceSystemId === "digital-workforce-schedule-provider-trial" && task.channelId === "schedule" &&
    task.taskType === "schedule_provider_trial" && task.executionInputRef?.kind === "artifact_ref" &&
    task.executionInputRef.refId === dryRun.dryRunId &&
    isDeepStrictEqual(task.providerTimeoutPolicy, binding.providerTimeoutPolicy) &&
    modelBindingMatchesDryRun(binding.taskModelBinding, dryRun.taskModelBinding);
  if (!exact) throw resolverError("schedule_owner_context_provider_trial_not_current");
  return deepFreeze({
    dryRunId: token(dryRun.dryRunId),
    attemptSequence: positiveInteger(dryRun.attemptSequence),
    dryRunVersion: positiveInteger(dryRun.dryRunVersion),
    registrationVersion: binding.registrationVersion,
    scheduleVersion: binding.scheduleVersion,
    employeeVersion: binding.employeeVersion,
    schedulePolicyDigest: binding.schedulePolicyDigest,
    executionContractDigest: binding.executionContractDigest,
    taskBindingDigest: binding.taskModelBinding.bindingDigest,
    outcome: "passed",
    evidenceDigest: digest(dryRun.evidence.evidenceDigest),
    canonicalTaskId: taskId,
    canonicalTaskRevision: positiveInteger(task.revision),
    canonicalTaskStatus: "completed",
    passedAt: timestamp(task.updatedAt),
  });
}

async function taskDefinition(resolver, binding, request) {
  let value;
  try {
    value = await resolver({
      tenantScope: request.tenantScope,
      taskDefinitionId: binding.taskDefinitionId,
      executionContractDigest: binding.executionContractDigest,
    });
  } catch {
    throw resolverError("schedule_owner_context_task_definition_unavailable");
  }
  if (value?.contractVersion !== "schedule-task-execution-definition-resolution.v1" ||
    value.payloadBoundary !== "internal_only" || value.executionContractDigest !== binding.executionContractDigest) {
    throw resolverError("schedule_owner_context_task_definition_invalid");
  }
  let definition;
  try { definition = normalizeScheduleTaskExecutionDefinitionV2(value.definition); }
  catch { throw resolverError("schedule_owner_context_task_definition_invalid"); }
  if (definition.taskDefinitionId !== binding.taskDefinitionId) {
    throw resolverError("schedule_owner_context_task_definition_invalid");
  }
  return { definition };
}

async function processingAuthority(resolver, binding, request, definition) {
  let value;
  try {
    value = await resolver({
      tenantScope: request.tenantScope,
      taskDefinitionId: binding.taskDefinitionId,
      taskDefinitionVersion: definition.taskDefinitionVersion,
      resultContractDigest: definition.resultContractDigest,
    });
  } catch {
    throw resolverError("schedule_owner_context_processing_unavailable");
  }
  if (value?.contractVersion !== "schedule-result-processing-resolution.v1") {
    throw resolverError("schedule_owner_context_processing_unavailable");
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
    if (authority.resultContractDigest !== definition.resultContractDigest) {
      throw resolverError("schedule_owner_context_processing_mismatch");
    }
    return { authority };
  } catch (error) {
    if (error?.code === "schedule_owner_context_processing_mismatch") throw error;
    throw resolverError("schedule_owner_context_processing_invalid");
  }
}

function normalizeRequest(value) {
  exactObject(value, REQUEST_FIELDS, "schedule_owner_context_request_invalid");
  return Object.freeze({
    tenantScope: token(value.tenantScope),
    employeeId: token(value.employeeId),
    scheduleId: token(value.scheduleId),
    evaluatedAt: timestamp(value.evaluatedAt),
  });
}

function normalizeModelBinding(value) {
  return deepFreeze({
    contractVersion: "digital-employee-task-model-binding.v1",
    taskId: token(value.taskId),
    assignmentId: token(value.assignmentId),
    assignmentAppliedVersion: nonNegativeInteger(value.assignmentAppliedVersion),
    assignmentSetDigest: digest(value.assignmentSetDigest),
    bindingVersion: token(value.bindingVersion),
    status: "applied",
    modelId: token(value.modelId),
    provider: token(value.provider),
    providerName: safeText(value.providerName, 120),
    model: safeText(value.model, 120),
    modelLevelId: token(value.modelLevelId),
    providerRouteId: token(value.providerRouteId),
    requiredCapabilityProfileVersion: token(value.requiredCapabilityProfileVersion),
    bindingDigest: digest(value.bindingDigest),
  });
}

function modelBindingMatchesDryRun(current, recorded) {
  return Boolean(recorded && [
    "assignmentId", "assignmentAppliedVersion", "assignmentSetDigest", "bindingVersion", "bindingDigest",
    "model", "modelId", "modelLevelId", "provider", "providerRouteId", "requiredCapabilityProfileVersion",
  ].every((field) => current[field] === recorded[field]));
}

function safeZeroEffects(value) {
  return value?.businessPayloadAttempts === 0 && value.outputPersisted === false && value.skillAttempts === 0 &&
    value.toolAttempts === 0 && value.writebackAttempts === 0;
}

function exactObject(value, fields, code) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw resolverError(code);
  const keys = Object.keys(value);
  if (keys.length !== fields.size || keys.some((key) => !fields.has(key))) throw resolverError(code);
}

function token(value) {
  const result = String(value || "").trim();
  if (!TOKEN.test(result)) throw resolverError("schedule_owner_context_token_invalid");
  return result;
}

function safeText(value, maximum) {
  const result = String(value || "").trim();
  if (!result || result.length > maximum || /[\u0000-\u001f\u007f]/.test(result)) {
    throw resolverError("schedule_owner_context_text_invalid");
  }
  return result;
}

function digest(value) {
  const result = String(value || "").trim().toLowerCase();
  if (!DIGEST.test(result)) throw resolverError("schedule_owner_context_digest_invalid");
  return result;
}

function timestamp(value) {
  const result = String(value || "").trim();
  const parsed = new Date(result);
  if (!result || !Number.isFinite(parsed.getTime()) || parsed.toISOString() !== result) {
    throw resolverError("schedule_owner_context_timestamp_invalid");
  }
  return result;
}

function positiveInteger(value) {
  if (!Number.isSafeInteger(value) || value < 1) throw resolverError("schedule_owner_context_number_invalid");
  return value;
}

function nonNegativeInteger(value) {
  if (!Number.isSafeInteger(value) || value < 0) throw resolverError("schedule_owner_context_number_invalid");
  return value;
}

function boundedInteger(value, minimum, maximum) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw resolverError("schedule_owner_context_number_invalid");
  }
  return value;
}

function enumValue(value, allowed) {
  if (!allowed.has(value)) throw resolverError("schedule_owner_context_enum_invalid");
  return value;
}

function deepFreeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    Object.values(value).forEach(deepFreeze);
  }
  return value;
}

function resolverError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

export {
  BINDING_VERSION as SCHEDULE_BUSINESS_OWNER_CURRENT_BINDING_CONTRACT_VERSION,
  CONTEXT_VERSION as SCHEDULE_BUSINESS_OWNER_ACCEPTANCE_CONTEXT_CONTRACT_VERSION,
  SCHEDULE_PRE_OWNER_READINESS_EVIDENCE_CONTRACT_VERSION,
  RESOLVER_VERSION as SCHEDULE_BUSINESS_OWNER_ACCEPTANCE_CONTEXT_RESOLVER_CONTRACT_VERSION,
};
