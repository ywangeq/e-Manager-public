import { EXECUTION_TASK_CONTRACT_VERSION, normalizeExecutionTaskSubmission } from "./runtime-task-contract-v1.mjs";
import { TRANSCRIPT_ENTRY_CONTRACT } from "./session-foundation-repository.mjs";

const RUNTIME_TASK_EXECUTION_INPUT_RESOLVER_CONTRACT = "runtime-task-execution-input-resolver.v1";
const ROUTE_TASK_FIELDS = Object.freeze([
  "tenantScope",
  "actorIssuer",
  "actorSubjectDigest",
  "employeeId",
  "channelId",
]);

function createRuntimeTaskExecutionInputResolver({ sessionRepository, resolveEmployee, resolveByTaskType = null } = {}) {
  assertDependencies({ sessionRepository, resolveEmployee, resolveByTaskType });

  async function resolve(task = null) {
    if (resolveByTaskType && task?.taskType) {
      try {
        if (task.contractVersion !== EXECUTION_TASK_CONTRACT_VERSION) throw new TypeError();
        normalizeExecutionTaskSubmission(task);
      } catch {
        throw resolverError("execution_task_input_task_invalid");
      }
      const delegated = await resolveByTaskType(task);
      if (delegated !== null && delegated !== undefined) return delegated;
    }
    requireCanonicalTextTask(task);

    let session;
    let route;
    try {
      [session, route] = await Promise.all([
        sessionRepository.readSession(task.sessionId),
        sessionRepository.readVerifiedRoute(task.sessionId),
      ]);
    } catch {
      throw resolverError("execution_task_input_session_unavailable");
    }
    if (!session) throw resolverError("execution_task_input_session_not_found");
    if (!route) throw resolverError("execution_task_input_route_unavailable");
    requireTaskRouteMatch(task, session, route);

    let employee;
    try {
      employee = await resolveEmployee(task.employeeId);
    } catch {
      throw resolverError("execution_task_input_employee_unavailable");
    }
    if (!employee || employee.id !== task.employeeId) {
      throw resolverError("execution_task_input_employee_unavailable");
    }
    if (!task.employeeVersion || String(employee.version || "") !== task.employeeVersion) {
      throw resolverError("execution_task_input_employee_version_changed");
    }

    let transcript;
    try {
      transcript = await sessionRepository.readTranscript(task.sessionId);
    } catch {
      throw resolverError("execution_task_input_transcript_unavailable");
    }
    if (!Array.isArray(transcript)) throw resolverError("execution_task_input_transcript_unavailable");
    const entry = transcript.find((candidate) => candidate?.entryId === task.executionInputRef.refId);
    if (!entry) throw resolverError("execution_task_input_entry_not_found");
    if (entry.contractVersion !== TRANSCRIPT_ENTRY_CONTRACT || entry.sessionId !== task.sessionId ||
      entry.type !== "message" || entry.message?.role !== "user" ||
      typeof entry.message.content !== "string" || !entry.message.content.trim()) {
      throw resolverError("execution_task_input_entry_invalid");
    }

    return Object.freeze({
      route,
      session,
      entry,
      userText: entry.message.content,
      employee,
    });
  }

  return Object.freeze({
    contractVersion: RUNTIME_TASK_EXECUTION_INPUT_RESOLVER_CONTRACT,
    resolve,
  });
}

function requireCanonicalTextTask(task) {
  if (!task || typeof task !== "object" || Array.isArray(task) ||
    task.contractVersion !== EXECUTION_TASK_CONTRACT_VERSION) {
    throw resolverError("execution_task_input_task_invalid");
  }
  for (const field of [...ROUTE_TASK_FIELDS, "sessionId", "employeeVersion"]) {
    if (typeof task[field] !== "string" || !task[field]) {
      throw resolverError("execution_task_input_task_invalid");
    }
  }
  if (!task.executionInputRef || task.executionInputRef.kind !== "transcript_entry" ||
    typeof task.executionInputRef.refId !== "string" || !task.executionInputRef.refId) {
    throw resolverError("execution_task_input_ref_unsupported");
  }
}

function requireTaskRouteMatch(task, session, route) {
  if (session.sessionId !== task.sessionId || session.routeDigest !== route.routeDigest) {
    throw resolverError("execution_task_input_route_mismatch");
  }
  for (const field of ROUTE_TASK_FIELDS) {
    if (route[field] !== task[field] || session[field] !== task[field]) {
      throw resolverError("execution_task_input_route_mismatch");
    }
  }
}

function assertDependencies({ sessionRepository, resolveEmployee, resolveByTaskType }) {
  for (const method of ["readSession", "readVerifiedRoute", "readTranscript"]) {
    if (typeof sessionRepository?.[method] !== "function") {
      throw new TypeError(`runtime task execution input resolver requires sessionRepository.${method}`);
    }
  }
  if (typeof resolveEmployee !== "function") {
    throw new TypeError("runtime task execution input resolver requires resolveEmployee");
  }
  if (resolveByTaskType !== null && typeof resolveByTaskType !== "function") {
    throw new TypeError("runtime task execution input resolver resolveByTaskType must be a function");
  }
}

function resolverError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

export {
  RUNTIME_TASK_EXECUTION_INPUT_RESOLVER_CONTRACT,
  createRuntimeTaskExecutionInputResolver,
};
