import { isDeepStrictEqual } from "node:util";
import { sessionMatchesActorLocator } from "../auth/authorization-session-service.mjs";
import { runtimePermissionDigest } from "../digital-employee-chat/route-support.mjs";
import { normalizeExecutionTaskSubmission, EXECUTION_TASK_TERMINAL_STATUSES } from "./runtime-task-contract-v1.mjs";
import { normalizeExecutionAdmission, REFERENCE_EXECUTION_ADMISSION_CONTRACT_VERSION, DEFAULT_MAX_TTL_MS } from "./execution-admission-repository.mjs";

// Admission is saved before canonical submission (as with conversation tasks).
// A crash can leave only an encrypted TTL-bound orphan, never an executable task
// without revalidated admission. This service does not submit or queue work.
export function createReferenceTaskAdmissionService({ admissionRepository, taskRepository, resolveRecoverySession,
  resolveActor, resolveEmployee, canInvokeEmployee, now = () => new Date() } = {}) {
  if (!["get", "saveOrGet"].every(name => typeof admissionRepository?.[name] === "function") ||
    typeof taskRepository?.get !== "function" ||
    ![resolveRecoverySession, resolveActor, resolveEmployee, canInvokeEmployee].every(fn => typeof fn === "function")) {
    throw new TypeError("reference admission requires existing identity, task and admission services");
  }
  async function checkIdentity(session, task) {
    if (!session) throw failure("execution_task_identity_revalidation_failed");
    let actor, employee, allowed;
    try {
      actor = await resolveActor({ session, task });
      if (!["tenantScope", "actorIssuer", "actorSubjectDigest"].every(field => actor?.[field] === task[field])) {
        throw failure("execution_task_identity_route_mismatch");
      }
      employee = await resolveEmployee(task.employeeId);
      if (!employee || employee.id !== task.employeeId || String(employee.version || "") !== task.employeeVersion) {
        throw failure("execution_task_input_employee_version_changed");
      }
      allowed = await canInvokeEmployee({ session, employee, channelId: task.channelId });
    } catch (error) { throw safeFailure(error); }
    if (allowed !== true) throw failure("execution_task_entitlement_revoked");
    return { actor, employee, session };
  }
  const read = (taskId) => {
    try { return admissionRepository.get(taskId, { now: now() }); }
    catch { throw failure("execution_task_admission_unavailable"); }
  };
  const readTask = (task) => {
    try { return taskRepository.get(task.taskId, { tenantScope: task.tenantScope }); }
    catch { throw failure("execution_task_admission_unavailable"); }
  };
  return Object.freeze({
    async prepare({ task: input, session }) {
      const task = normalizedTask(input);
      await checkIdentity(session, task);
      const existing = read(task.taskId);
      if (existing) {
        requireMatch(existing, task);
        if (!sessionMatchesActorLocator(session, existing.actorLocator) || runtimePermissionDigest(session) !== existing.permissionDigest) {
          throw failure("execution_task_permission_changed");
        }
        return existing;
      }
      // Expired/missing admission cannot be renewed around an already submitted task.
      if (readTask(task)) throw failure("execution_task_admission_unavailable");
      const createdAt = new Date(now()).toISOString();
      const admission = normalizeExecutionAdmission({
        contractVersion: REFERENCE_EXECUTION_ADMISSION_CONTRACT_VERSION,
        taskId: task.taskId, taskBinding: binding(task), channelId: task.channelId, employeeVersion: task.employeeVersion,
        actorLocator: {
          identitySource: session.identitySource || session.authorization?.identitySource,
          subjectId: session.feishuUserId || session.employeeId || session.email,
          subjectIdType: session.feishuUserId ? "feishu_id" : session.employeeId ? "employee_id" : "email",
        },
        permissionDigest: runtimePermissionDigest(session), createdAt,
        expiresAt: new Date(Date.parse(createdAt) + DEFAULT_MAX_TTL_MS).toISOString(),
      });
      try { return admissionRepository.saveOrGet(admission, { now: now() }).admission; }
      catch { throw failure("execution_task_admission_unavailable"); }
    },
    async recover(input) {
      const task = normalizedTask(input);
      const stored = readTask(task);
      if (!stored || !isDeepStrictEqual(binding(stored), binding(task)) || stored.employeeVersion !== task.employeeVersion ||
        stored.channelId !== task.channelId || stored.sessionId !== null) throw failure("execution_task_admission_mismatch");
      if (EXECUTION_TASK_TERMINAL_STATUSES.includes(stored.status)) throw failure("execution_task_already_terminal");
      const admission = read(task.taskId);
      requireMatch(admission, task);
      let session;
      try { session = await resolveRecoverySession(admission.actorLocator); }
      catch { throw failure("execution_task_identity_revalidation_failed"); }
      if (!session || !sessionMatchesActorLocator(session, admission.actorLocator)) throw failure("execution_task_identity_revalidation_failed");
      if (runtimePermissionDigest(session) !== admission.permissionDigest) throw failure("execution_task_permission_changed");
      const current = await checkIdentity(session, task);
      const reloaded = read(task.taskId);
      if (!isDeepStrictEqual(admission, reloaded)) throw failure("execution_task_admission_unavailable");
      const latest = readTask(task);
      if (!latest || EXECUTION_TASK_TERMINAL_STATUSES.includes(latest.status)) throw failure("execution_task_already_terminal");
      return Object.freeze(current);
    },
  });
}
function binding(task) {
  const { tenantScope, actorIssuer, actorSubjectDigest, employeeId, sourceSystemId, taskType, submissionScope, idempotencyKey, inputDigest, executionInputRef } = task;
  return { tenantScope, actorIssuer, actorSubjectDigest, employeeId, sourceSystemId, taskType, submissionScope, idempotencyKey, inputDigest, executionInputRef };
}
function normalizedTask(value) {
  let task;
  try {
    if (typeof value?.taskId !== "string" || !value.taskId) throw new TypeError();
    task = normalizeExecutionTaskSubmission(value);
  }
  catch { throw failure("execution_task_admission_mismatch"); }
  if (task.sessionId !== null) throw failure("execution_task_admission_mismatch");
  return task;
}
function requireMatch(admission, task) {
  if (!admission || admission.contractVersion !== REFERENCE_EXECUTION_ADMISSION_CONTRACT_VERSION ||
    admission.taskId !== task.taskId || admission.employeeVersion !== task.employeeVersion ||
    admission.channelId !== task.channelId || !isDeepStrictEqual(admission.taskBinding, binding(task))) {
    throw failure("execution_task_admission_mismatch");
  }
}
function failure(code) { const error = new Error(code); error.code = code; return error; }
function safeFailure(error) {
  return failure(["execution_task_identity_route_mismatch", "execution_task_input_employee_version_changed"].includes(error?.code)
    ? error.code : "execution_task_identity_revalidation_failed");
}
