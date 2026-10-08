import crypto from "node:crypto";
import { EXECUTION_TASK_TERMINAL_STATUSES } from "./runtime-task-contract-v1.mjs";
import { normalizeScheduleTaskInputSnapshotBinding } from
  "./sqlite-schedule-task-input-snapshot-repository.mjs";

const SERVICE_VERSION = "schedule-task-input-snapshot-purge-service.v1";
const CONVERGENCE_VERSION = "schedule-task-input-snapshot-convergence-evidence.v1";
const RESULT_VERSION = "schedule-task-input-snapshot-purge-result.v1";
const REQUEST_FIELDS = new Set(["runId", "tenantScope"]);
const TOKEN = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,239}$/;
const DIGEST = /^[a-f0-9]{64}$/;
const TERMINAL_STATUSES = new Set(EXECUTION_TASK_TERMINAL_STATUSES);

function createScheduleTaskInputSnapshotPurgeService({
  controlRepository,
  executionTaskRepository,
  inputSnapshotRepository,
} = {}) {
  if (typeof inputSnapshotRepository?.getPurgeCandidate !== "function" ||
    typeof inputSnapshotRepository?.purgeSnapshot !== "function") {
    throw new TypeError("Schedule input purge requires the input snapshot repository");
  }
  if (typeof controlRepository?.getRunExecution !== "function") {
    throw new TypeError("Schedule input purge requires the control repository");
  }
  if (typeof executionTaskRepository?.get !== "function") {
    throw new TypeError("Schedule input purge requires the canonical task repository");
  }

  function purge(value = {}) {
    const request = normalizeRequest(value);
    const candidate = requireCandidate(inputSnapshotRepository.getPurgeCandidate(request), request);
    if (!candidate) return Object.freeze({ contractVersion: RESULT_VERSION, outcome: "not_found" });
    let task;
    let execution;
    try {
      task = executionTaskRepository.get(candidate.binding.canonicalTaskId, {
        tenantScope: request.tenantScope,
      });
      execution = controlRepository.getRunExecution(request.runId, {
        tenantScope: request.tenantScope,
      });
    } catch {
      throw purgeError("schedule_task_input_purge_convergence_unavailable");
    }
    const canonicalTask = normalizeCanonicalTask(task, candidate.binding);
    const runExecution = normalizeRunExecution(execution, candidate.binding);
    const convergenceEvidenceDigest = digestCanonical({
      contractVersion: CONVERGENCE_VERSION,
      binding: candidate.binding,
      canonicalTask,
      inputSnapshotEvidenceDigest: candidate.evidence.evidenceDigest,
      runExecution,
    });
    const purged = inputSnapshotRepository.purgeSnapshot({
      authorizationEvidenceDigest: candidate.authorizationEvidenceDigest,
      convergenceEvidenceDigest,
      expectedBinding: candidate.binding,
      expectedEvidenceDigest: candidate.evidence.evidenceDigest,
      runId: request.runId,
      tenantScope: request.tenantScope,
    });
    if (!purged) return Object.freeze({ contractVersion: RESULT_VERSION, outcome: "not_found" });
    return deepFreeze({
      contractVersion: RESULT_VERSION,
      evidence: purged.evidence,
      outcome: purged.created ? "purged" : "already_purged",
    });
  }

  return Object.freeze({ contractVersion: SERVICE_VERSION, purge });
}

function normalizeRequest(value) {
  exactObject(value, REQUEST_FIELDS, "schedule_task_input_purge_request_invalid");
  return Object.freeze({
    runId: token(value.runId),
    tenantScope: token(value.tenantScope),
  });
}

function requireCandidate(value, request) {
  if (value === null) return null;
  const binding = normalizeScheduleTaskInputSnapshotBinding(value?.binding);
  if (binding.contractVersion !== "schedule-task-input-snapshot-binding.v2" ||
    value?.contractVersion !== "schedule-task-input-snapshot-purge-candidate.v1" ||
    value?.payloadBoundary !== "internal_only" ||
    binding.tenantScope !== request.tenantScope || binding.runId !== request.runId ||
    value?.evidence?.inputSnapshotRef === undefined) {
    throw purgeError("schedule_task_input_purge_context_mismatch");
  }
  return deepFreeze({
    authorizationEvidenceDigest: digest(value.authorizationEvidenceDigest),
    binding,
    evidence: {
      contractVersion: value.evidence.contractVersion,
      evidenceDigest: digest(value.evidence.evidenceDigest),
      inputSnapshotRef: token(value.evidence.inputSnapshotRef),
      sealedAt: timestamp(value.evidence.sealedAt),
      state: token(value.evidence.state),
    },
  });
}

function normalizeCanonicalTask(value, binding) {
  const status = token(value?.status);
  if (!TERMINAL_STATUSES.has(status) || token(value?.taskId) !== binding.canonicalTaskId ||
    token(value?.tenantScope) !== binding.tenantScope || token(value?.employeeId) !== binding.employeeId) {
    throw purgeError("schedule_task_input_purge_not_converged");
  }
  return Object.freeze({
    canonicalTaskId: binding.canonicalTaskId,
    status,
    taskRevision: positiveInteger(value.revision),
    terminalEvidenceDigest: nullableDigest(value.terminalEvidenceDigest),
  });
}

function normalizeRunExecution(value, binding) {
  if (value?.executionState !== "released" || token(value?.executionTaskId) !== binding.canonicalTaskId ||
    token(value?.tenantScope) !== binding.tenantScope || token(value?.employeeId) !== binding.employeeId ||
    token(value?.scheduleId) !== binding.scheduleId || value?.activationVersion !== binding.activationVersion) {
    throw purgeError("schedule_task_input_purge_not_converged");
  }
  return Object.freeze({
    canonicalTaskId: binding.canonicalTaskId,
    executionState: "released",
    executionVersion: positiveInteger(value.executionVersion),
    releasedAt: timestamp(value.releasedAt),
    resultReceiptDigest: nullableDigest(value.resultReceiptDigest),
  });
}

function exactObject(value, fields, code) {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype) throw purgeError(code);
  const keys = Object.keys(value);
  if (keys.length !== fields.size || keys.some((key) => !fields.has(key))) throw purgeError(code);
}

function token(value) {
  const result = String(value || "").trim();
  if (!TOKEN.test(result) || /@[^/]+\.[A-Za-z]{2,}$/.test(result)) {
    throw purgeError("schedule_task_input_purge_reference_invalid");
  }
  return result;
}

function digest(value) {
  const result = String(value || "").trim().toLowerCase();
  if (!DIGEST.test(result)) throw purgeError("schedule_task_input_purge_digest_invalid");
  return result;
}

function nullableDigest(value) {
  return value === null ? null : digest(value);
}

function positiveInteger(value) {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw purgeError("schedule_task_input_purge_number_invalid");
  }
  return value;
}

function timestamp(value) {
  const result = String(value || "").trim();
  const parsed = new Date(result);
  if (!result || !Number.isFinite(parsed.getTime()) || parsed.toISOString() !== result) {
    throw purgeError("schedule_task_input_purge_timestamp_invalid");
  }
  return result;
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
  const result = JSON.stringify(Object.is(value, -0) ? 0 : value);
  if (result === undefined) throw purgeError("schedule_task_input_purge_value_invalid");
  return result;
}

function deepFreeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    Object.values(value).forEach(deepFreeze);
  }
  return value;
}

function purgeError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

export {
  CONVERGENCE_VERSION as SCHEDULE_TASK_INPUT_SNAPSHOT_CONVERGENCE_EVIDENCE_CONTRACT_VERSION,
  SERVICE_VERSION as SCHEDULE_TASK_INPUT_SNAPSHOT_PURGE_SERVICE_CONTRACT_VERSION,
  createScheduleTaskInputSnapshotPurgeService,
};
