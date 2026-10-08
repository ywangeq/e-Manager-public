import crypto from "node:crypto";
import { normalizeExecutionTaskSubmission } from "./runtime-task-contract-v1.mjs";
import { normalizeProviderTimeoutPolicy } from "./provider-timeout-policy.mjs";

const OPS_DIAGNOSIS_TASK_TYPE = "ops_incident_diagnosis";
const OPS_DIAGNOSIS_CHANNEL_ID = "ops_monitor";
const OPS_DIAGNOSIS_SOURCE_SYSTEM_ID = "digital-workforce-ops";
const OPS_DIAGNOSIS_EMPLOYEE_ID = "workforce-admin";

export function createOpsDiagnosisTaskService({
  repository,
  resolveEmployee,
  resolveProviderTimeoutPolicy,
  tenantScope,
  workerPump,
} = {}) {
  if (typeof repository?.submitOrGet !== "function" || typeof repository?.getOpsIncidentHead !== "function" || typeof repository?.createOpsIncidentDiagnosisRequest !== "function" ||
    typeof repository?.getOpsIncidentDiagnosisRequest !== "function" || typeof repository?.completeOpsIncidentDiagnosisRequest !== "function") {
    throw new TypeError("ops diagnosis task service requires canonical task and ops diagnosis repositories");
  }
  if (typeof resolveEmployee !== "function" || typeof resolveProviderTimeoutPolicy !== "function" || !safeToken(tenantScope)) {
    throw new TypeError("ops diagnosis task service requires governed employee and timeout resolution");
  }

  function request({ actorDigest, incidentId, now = new Date().toISOString() } = {}) {
    const employee = resolveEmployee(OPS_DIAGNOSIS_EMPLOYEE_ID);
    if (!employee || !["在线", "试运行"].includes(String(employee.status || "").trim())) {
      throw opsTaskError("ops_diagnosis_employee_unavailable");
    }
    const employeeVersion = requiredToken(employee.version, "employeeVersion");
    const incidentHead = repository.getOpsIncidentHead({ incidentId, tenantScope });
    if (!incidentHead) throw opsTaskError("ops_incident_not_found");
    const expectedRevision = incidentHead.revision;
    const digest = sha256(["ops-diagnosis-request.v1", tenantScope, incidentId, expectedRevision, actorDigest, employeeVersion]);
    const requestId = `ODR-${digest.slice(0, 24)}`;
    const createdAt = iso(now);
    const submission = normalizeExecutionTaskSubmission({
      taskId: `task_${sha256(["ops-diagnosis-task.v1", tenantScope, requestId])}`,
      tenantScope,
      actorIssuer: OPS_DIAGNOSIS_SOURCE_SYSTEM_ID,
      actorSubjectDigest: sha256(["ops-diagnosis-actor.v1", actorDigest]),
      employeeId: OPS_DIAGNOSIS_EMPLOYEE_ID,
      employeeVersion,
      sessionId: `ops-${requestId}`,
      sourceSystemId: OPS_DIAGNOSIS_SOURCE_SYSTEM_ID,
      channelId: OPS_DIAGNOSIS_CHANNEL_ID,
      taskType: OPS_DIAGNOSIS_TASK_TYPE,
      submissionScope: `ops-incident:${incidentId}`,
      idempotencyKey: `diagnosis:${digest}`,
      inputDigest: sha256(["ops-diagnosis-input.v1", tenantScope, incidentId, requestId]),
      executionInputRef: { kind: "artifact_ref", refId: requestId },
      createdAt,
      availableAt: createdAt,
      providerTimeoutPolicy: normalizeProviderTimeoutPolicy(resolveProviderTimeoutPolicy({ employee })),
    }, { now: new Date(createdAt) });
    const taskResult = repository.submitOrGet(submission, { now: new Date(createdAt) });
    const requestResult = repository.createOpsIncidentDiagnosisRequest({
      actorDigest,
      canonicalTaskId: submission.taskId,
      employeeVersion,
      expectedRevision,
      incidentId,
      now: createdAt,
      requestId,
      tenantScope,
    });
    workerPump?.wake?.();
    return Object.freeze({ created: taskResult.created && requestResult.created, requestId: requestResult.requestId, task: taskResult.task });
  }

  function resolvePersistentTaskExecutor(task) {
    if (task?.channelId !== OPS_DIAGNOSIS_CHANNEL_ID || task?.taskType !== OPS_DIAGNOSIS_TASK_TYPE) return null;
    return async (ownership) => {
      try {
        if (task.tenantScope !== tenantScope || task.employeeId !== OPS_DIAGNOSIS_EMPLOYEE_ID ||
          task.executionInputRef?.kind !== "artifact_ref") throw opsTaskError("ops_diagnosis_task_binding_invalid");
        const request = repository.getOpsIncidentDiagnosisRequest({ taskId: task.taskId, tenantScope });
        if (!request || task.executionInputRef.refId !== request.request_id) {
          throw opsTaskError("ops_diagnosis_task_binding_invalid");
        }
        const employee = resolveEmployee(OPS_DIAGNOSIS_EMPLOYEE_ID);
        if (!employee || employee.version !== task.employeeVersion || !["在线", "试运行"].includes(String(employee.status || "").trim())) {
          throw opsTaskError("ops_diagnosis_employee_unavailable");
        }
        if (ownership?.isCancellationRequested?.()) throw opsTaskError("agent_turn_canceled");
        const result = repository.completeOpsIncidentDiagnosisRequest({
          actorDigest: sha256(["ops-diagnosis-worker.v1", task.employeeId, task.employeeVersion]),
          now: new Date().toISOString(),
          taskId: task.taskId,
          tenantScope,
        });
        return { settlement: {
          status: "completed",
          resultSummary: `运营管理员已完成安全证据诊断，并生成 ${result.repairPlan.lifecycleState === "blocked" ? "受阻修复计划" : "修复计划"}。`,
          terminalEvidenceDigest: sha256(["ops-diagnosis-result.v1", result.incidentId, result.versionNo, result.repairPlan.planId]),
        } };
      } catch (cause) {
        return { settlement: {
          status: "blocked",
          lastErrorCode: safeErrorCode(cause),
          resultSummary: "运营管理员在受控证据或任务绑定门禁处停止；未修改原任务或执行外部修复。",
        } };
      }
    };
  }

  return Object.freeze({ request, resolvePersistentTaskExecutor });
}

function sha256(value) {
  return crypto.createHash("sha256").update(JSON.stringify(value), "utf8").digest("hex");
}

function safeToken(value) {
  return /^[A-Za-z0-9][A-Za-z0-9._:@-]{0,159}$/.test(String(value || ""));
}

function requiredToken(value, field) {
  const result = String(value || "").trim();
  if (!safeToken(result)) throw opsTaskError("ops_diagnosis_reference_invalid", field);
  return result;
}

function iso(value) {
  const result = new Date(value);
  if (!Number.isFinite(result.getTime())) throw opsTaskError("ops_diagnosis_clock_invalid");
  return result.toISOString();
}

function safeErrorCode(error) {
  const code = String(error?.code || "");
  return /^[a-z][a-z0-9_]{1,119}$/.test(code) ? code : "ops_diagnosis_execution_failed";
}

function opsTaskError(code, message = code) {
  const error = new Error(message);
  error.code = code;
  return error;
}

export { OPS_DIAGNOSIS_CHANNEL_ID, OPS_DIAGNOSIS_EMPLOYEE_ID, OPS_DIAGNOSIS_SOURCE_SYSTEM_ID, OPS_DIAGNOSIS_TASK_TYPE };
