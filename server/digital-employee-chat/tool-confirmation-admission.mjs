import crypto from "node:crypto";
import { conversationTaskId } from "../agent-runtime/runtime-task-submission-projector.mjs";

export function confirmationContext(route, sessionId, taskId = "") {
  return { tenantScope: route.tenantScope, sessionKey: `${route.routeDigest}:${sessionId}`, employeeId: route.employeeId, actorId: route.actorSubjectDigest, taskId };
}

export function findConfirmationTask({ runtimeTaskService, route, sessionId, requestId }) {
  const task = runtimeTaskService?.readCanonicalExecutionTask?.(conversationTaskId({ route, requestId }), { tenantScope: route.tenantScope });
  return task && task.actorIssuer === route.actorIssuer && task.actorSubjectDigest === route.actorSubjectDigest
    && task.employeeId === route.employeeId && task.sessionId === sessionId && task.submissionScope === `route:${route.routeDigest}` ? task : null;
}

export function createAcceptedExecutionVerifier(runtimeTaskService, now = () => Date.now()) {
  return ({ context, executionInputBinding, inputDigest, executeBeforeMs }) => {
    const task = runtimeTaskService?.readCanonicalExecutionTask?.(context.taskId, { tenantScope: context.tenantScope });
    if (!task || !["queued", "running", "waiting"].includes(task.status) || now() >= executeBeforeMs
      || task.employeeId !== context.employeeId || task.actorSubjectDigest !== context.actorId
      || `${String(task.submissionScope).replace(/^route:/, "")}:${task.sessionId}` !== context.sessionKey) return false;
    const contextBinding = digest(`${context.sessionKey}:${context.employeeId}:${context.actorId}`);
    return (!inputDigest || inputDigest === task.inputDigest)
      && executionInputBinding === digest(`${contextBinding}:${task.executionInputRef?.refId}`)
      && (!task.executionDeadlineAt || now() < Date.parse(task.executionDeadlineAt));
  };
}

// Canonical task lookup survives consumption of the encrypted confirmation.
export function confirmationSubmissionStatus({ service, runtimeTaskService, route, sessionId, confirmation, requestId }) {
  const task = findConfirmationTask({ runtimeTaskService, route, sessionId, requestId });
  if (task) return { status: "submitted", taskId: task.taskId, taskStatus: task.status };
  return service.admissionStatus({ confirmation, context: confirmationContext(route, sessionId), requestId }) || { status: "unavailable" };
}

function digest(value) { return crypto.createHash("sha256").update(value).digest("hex"); }
