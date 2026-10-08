import { projectScheduleFromRunConfiguration } from "./schedule-run-configuration.mjs";
import { isDeepStrictEqual } from "node:util";
import {
  normalizeRunnableScheduleActivationSnapshot,
  projectRunnableGovernedScheduleFromActivationSnapshot,
} from "./schedule-activation-snapshot.mjs";
import { assertScheduleTaskTriggerMatch } from "./schedule-task-input-resolver.mjs";
import {
  createScheduleTriggerService,
  projectScheduleTrigger,
  scheduleTriggerSlotDigest,
} from "./schedule-trigger-service.mjs";

const SCHEDULE_RUN_INTENT_DISPATCHER_CONTRACT_VERSION = "schedule-run-intent-dispatcher.v1";
const DISPATCHABLE_INTENT_STATES = new Set(["prepared", "reconcile_required", "submitted"]);

function createScheduleRunIntentDispatcher({
  controlRepository,
  executionTaskRepository,
  now = () => new Date(),
  resolveActivatedScheduleSnapshot,
  scheduleTriggerRepository,
  verifyScheduledFor,
  wakeWorker = () => {},
} = {}) {
  assertDependencies({
    controlRepository,
    executionTaskRepository,
    now,
    resolveActivatedScheduleSnapshot,
    scheduleTriggerRepository,
    verifyScheduledFor,
    wakeWorker,
  });
  const triggerService = createScheduleTriggerService({
    executionTaskRepository,
    scheduleTriggerRepository,
    verifyScheduledFor,
  });

  function dispatchOne({ tenantScope, runId, expectedIntentVersion } = {}) {
    const identity = normalizeRequest({ tenantScope, runId, expectedIntentVersion });
    let intent = controlRepository.getIntent(identity.runId, { tenantScope: identity.tenantScope });
    if (!intent) throw dispatcherError("schedule_run_dispatch_intent_not_found");
    if (intent.intentVersion !== identity.expectedIntentVersion) {
      throw dispatcherError("schedule_run_dispatch_intent_version_conflict");
    }
    if (intent.intentState === "cancel_requested") return canceledResult(intent);
    if (!DISPATCHABLE_INTENT_STATES.has(intent.intentState)) {
      throw dispatcherError("schedule_run_dispatch_intent_state_invalid");
    }

    let schedule;
    let projection;
    try {
      const resolvedSnapshot = resolveActivatedScheduleSnapshot({
        tenantScope: intent.tenantScope,
        employeeId: intent.employeeId,
        scheduleId: intent.scheduleId,
        activationVersion: intent.activationVersion,
        runId: intent.runId,
        activationSnapshotId: intent.activationSnapshotId,
        activationSnapshotDigest: intent.activationSnapshotDigest,
      });
      schedule = requireExactActivationSnapshot({
        controlRepository,
        intent,
        resolvedSnapshot,
      });
      projection = projectScheduleTrigger({ schedule, scheduledFor: intent.scheduledFor, manualRequestDigest: intent.manualRequestDigest });
      requireIntentProjectionMatch(intent, projection);
    } catch (error) {
      return reconcileFailure(intent, safeFailureCode(error), controlRepository, now);
    }

    if (intent.intentState !== "submitted") {
      try {
        intent = controlRepository.markSubmitted({
          tenantScope: intent.tenantScope,
          runId: intent.runId,
          expectedIntentVersion: intent.intentVersion,
          executionTaskId: intent.expectedExecutionTaskId,
          submittedAt: now(),
        });
      } catch (error) {
        const current = controlRepository.getIntent(identity.runId, { tenantScope: identity.tenantScope });
        if (current?.intentState === "cancel_requested") return canceledResult(current);
        if (error?.code === "schedule_control_intent_governance_changed" &&
          current?.intentVersion === intent.intentVersion) {
          return reconcileFailure(intent, error.code, controlRepository, now);
        }
        throw dispatcherError(safeFailureCode(error));
      }
    } else {
      try {
        intent = controlRepository.revalidateSubmittedIntent({
          tenantScope: intent.tenantScope,
          runId: intent.runId,
          expectedIntentVersion: intent.intentVersion,
          executionTaskId: intent.executionTaskId,
        });
      } catch (error) {
        const current = controlRepository.getIntent(identity.runId, { tenantScope: identity.tenantScope });
        if (current?.intentState === "cancel_requested") return canceledResult(current);
        if (error?.code === "schedule_control_intent_governance_changed" &&
          current?.intentVersion === intent.intentVersion) {
          return reconcileFailure(intent, error.code, controlRepository, now);
        }
        throw dispatcherError(safeFailureCode(error));
      }
    }

    let submitted;
    try {
      submitted = triggerService.submit({ schedule, scheduledFor: intent.scheduledFor, manualRequestDigest: intent.manualRequestDigest });
      requireSubmittedMatch(intent, projection, submitted);
    } catch (error) {
      return reconcileFailure(intent, safeFailureCode(error), controlRepository, now, submitted);
    }

    try {
      intent = controlRepository.revalidateSubmittedIntent({
        tenantScope: intent.tenantScope,
        runId: intent.runId,
        expectedIntentVersion: intent.intentVersion,
        executionTaskId: intent.executionTaskId,
      });
    } catch (error) {
      const current = controlRepository.getIntent(identity.runId, { tenantScope: identity.tenantScope });
      if (submitted.task.status === "canceled") return canceledResult(current || intent, submitted);
      if (current?.intentState === "cancel_requested") return canceledResult(current, submitted);
      if (!current || current.intentVersion !== intent.intentVersion) {
        return conflictResult(current || intent, "schedule_run_dispatch_intent_changed", submitted);
      }
      return reconcileFailure(intent, safeFailureCode(error), controlRepository, now, submitted);
    }

    const current = controlRepository.getIntent(identity.runId, { tenantScope: identity.tenantScope });
    if (!current) return conflictResult(intent, "schedule_run_dispatch_intent_not_found", submitted);
    if (current.intentState === "cancel_requested" || submitted.task.status === "canceled") {
      return deepFreeze({
        contractVersion: SCHEDULE_RUN_INTENT_DISPATCHER_CONTRACT_VERSION,
        outcome: "canceled",
        runId: current.runId,
        taskCreated: submitted.created,
        triggerCreated: submitted.triggerCreated,
        wakeRequested: false,
        errorCode: current.lastErrorCode || submitted.task.lastErrorCode || "schedule_run_canceled",
      });
    }
    try {
      requireSameSubmittedIntent(intent, current);
    } catch (error) {
      return conflictResult(current, safeFailureCode(error), submitted);
    }
    let wakeRequested = false;
    try {
      wakeWorker();
      wakeRequested = true;
    } catch {
      // The canonical queue is durable; startup or a later one-shot pass can wake it again.
    }
    return deepFreeze({
      contractVersion: SCHEDULE_RUN_INTENT_DISPATCHER_CONTRACT_VERSION,
      outcome: submitted.created ? "submitted" : "already_submitted",
      runId: current.runId,
      taskCreated: submitted.created,
      triggerCreated: submitted.triggerCreated,
      wakeRequested,
      errorCode: null,
    });
  }

  function runOnce({ tenantScope, limit = 100 } = {}) {
    const safeTenantScope = token(tenantScope, "tenantScope");
    const safeLimit = boundedInteger(limit, 1, 500, "limit");
    const summary = {
      examined: 0,
      submitted: 0,
      alreadySubmitted: 0,
      canceled: 0,
      reconcileRequired: 0,
      conflicts: 0,
    };
    const intents = controlRepository.listIncompleteIntents({ tenantScope: safeTenantScope, limit: safeLimit });
    for (const intent of intents) {
      summary.examined += 1;
      try {
        const result = dispatchOne({
          tenantScope: intent.tenantScope,
          runId: intent.runId,
          expectedIntentVersion: intent.intentVersion,
        });
        if (result.outcome === "submitted") summary.submitted += 1;
        else if (result.outcome === "already_submitted") summary.alreadySubmitted += 1;
        else if (result.outcome === "canceled") summary.canceled += 1;
        else if (result.outcome === "conflict") summary.conflicts += 1;
        else summary.reconcileRequired += 1;
      } catch (error) {
        if (String(error?.code || "").includes("conflict")) summary.conflicts += 1;
        else summary.reconcileRequired += 1;
      }
    }
    return deepFreeze({ contractVersion: SCHEDULE_RUN_INTENT_DISPATCHER_CONTRACT_VERSION, ...summary });
  }

  return Object.freeze({
    contractVersion: SCHEDULE_RUN_INTENT_DISPATCHER_CONTRACT_VERSION,
    dispatchOne,
    runOnce,
  });
}

function requireIntentProjectionMatch(intent, projection) {
  const slotDigest = scheduleTriggerSlotDigest({
    tenantScope: intent.tenantScope,
    employeeId: intent.employeeId,
    scheduleId: intent.scheduleId,
    scheduledFor: intent.scheduledFor, manualRequestDigest: intent.manualRequestDigest,
  });
  const trigger = projection.trigger;
  const matches = intent.runId === `schedule_run_${slotDigest}` &&
    intent.expectedTriggerId === `schedule_trigger_${slotDigest}` &&
    intent.expectedExecutionTaskId === `task_${slotDigest}` &&
    trigger.triggerId === intent.expectedTriggerId && trigger.executionTaskId === intent.expectedExecutionTaskId &&
    trigger.tenantScope === intent.tenantScope && trigger.employeeId === intent.employeeId &&
    trigger.scheduleId === intent.scheduleId && trigger.scheduleVersion === intent.scheduleVersion &&
    trigger.scheduledFor === intent.scheduledFor && trigger.manualRequestDigest === intent.manualRequestDigest &&
    trigger.schedulePolicyDigest === intent.schedulePolicyDigest &&
    trigger.executionContractDigest === intent.executionContractDigest;
  if (!matches) throw dispatcherError("schedule_run_dispatch_snapshot_identity_mismatch");
}

function requireExactActivationSnapshot({ controlRepository, intent, resolvedSnapshot }) {
  if (!resolvedSnapshot || typeof resolvedSnapshot !== "object" || Array.isArray(resolvedSnapshot) ||
    !exactKeys(resolvedSnapshot, ["governedSchedule", "snapshot"])) {
    throw dispatcherError("schedule_run_dispatch_activation_snapshot_invalid");
  }
  const snapshot = normalizeRunnableScheduleActivationSnapshot(resolvedSnapshot.snapshot);
  const governedSchedule = projectRunnableGovernedScheduleFromActivationSnapshot(snapshot);
  if (!isDeepStrictEqual(governedSchedule, resolvedSnapshot.governedSchedule)) {
    throw dispatcherError("schedule_run_dispatch_activation_snapshot_projection_mismatch");
  }
  const snapshotId = `schedule_activation_snapshot_${snapshot.snapshotDigest}`;
  const control = controlRepository.getControl({
    tenantScope: intent.tenantScope,
    employeeId: intent.employeeId,
    scheduleId: intent.scheduleId,
  });
  const matches = control && intent.activationSnapshotId === snapshotId &&
    intent.activationSnapshotDigest === snapshot.snapshotDigest &&
    control.activationSnapshotId === intent.activationSnapshotId &&
    control.activationSnapshotDigest === intent.activationSnapshotDigest &&
    (control.activationState === "active" || (intent.manualRequestDigest && control.activationState === "paused")) && !control.emergencyStop.active &&
    snapshot.activationVersion === intent.activationVersion &&
    control.activationVersion === intent.activationVersion &&
    snapshot.registrationVersion === control.registrationVersion &&
    snapshot.tenantScope === intent.tenantScope && snapshot.employeeId === intent.employeeId &&
    snapshot.scheduleId === intent.scheduleId && snapshot.scheduleVersion === intent.scheduleVersion &&
    snapshot.schedulePolicyDigest === intent.schedulePolicyDigest &&
    snapshot.executionContractDigest === intent.executionContractDigest;
  if (!matches) throw dispatcherError("schedule_run_dispatch_activation_snapshot_mismatch");
  if (snapshot.contractVersion === "schedule-activation-snapshot.v3") {
    return projectScheduleFromRunConfiguration(snapshot,
      controlRepository.getRunConfiguration?.({ tenantScope: intent.tenantScope, runId: intent.runId }), intent);
  }
  return governedSchedule;
}

function requireSubmittedMatch(intent, projection, submitted) {
  if (!submitted?.task || !submitted?.trigger) {
    throw dispatcherError("schedule_run_dispatch_submission_unavailable");
  }
  assertScheduleTaskTriggerMatch(submitted.task, submitted.trigger);
  if (!isDeepStrictEqual(submitted.trigger, projection.trigger) ||
    submitted.task.taskId !== intent.expectedExecutionTaskId ||
    !taskMatchesSubmission(submitted.task, projection.submission)) {
    throw dispatcherError("schedule_run_dispatch_submission_identity_mismatch");
  }
}

function taskMatchesSubmission(task, submission) {
  return task.contractVersion === submission.contractVersion && task.tenantScope === submission.tenantScope &&
    task.actorIssuer === submission.actorIssuer && task.actorSubjectDigest === submission.actorSubjectDigest &&
    task.employeeId === submission.employeeId && task.employeeVersion === submission.employeeVersion &&
    task.sessionId === submission.sessionId && task.sourceSystemId === submission.sourceSystemId &&
    task.channelId === submission.channelId && task.taskType === submission.taskType &&
    task.submissionScope === submission.submissionScope && task.idempotencyKey === submission.idempotencyKey &&
    task.inputDigest === submission.inputDigest &&
    isDeepStrictEqual(task.executionInputRef, submission.executionInputRef) &&
    task.workspaceRef === submission.workspaceRef && task.priority === submission.priority &&
    task.maxRecoveries === submission.maxRecoveries && task.createdAt === submission.createdAt &&
    task.availableAt === submission.availableAt &&
    isDeepStrictEqual(task.providerTimeoutPolicy, submission.providerTimeoutPolicy);
}

function requireSameSubmittedIntent(expected, actual) {
  const matches = actual.intentState === "submitted" && actual.runId === expected.runId &&
    actual.tenantScope === expected.tenantScope && actual.employeeId === expected.employeeId &&
    actual.scheduleId === expected.scheduleId && actual.activationVersion === expected.activationVersion &&
    actual.activationSnapshotId === expected.activationSnapshotId &&
    actual.activationSnapshotDigest === expected.activationSnapshotDigest &&
    actual.scheduleVersion === expected.scheduleVersion &&
    actual.schedulePolicyDigest === expected.schedulePolicyDigest &&
    actual.executionContractDigest === expected.executionContractDigest &&
    actual.expectedTriggerId === expected.expectedTriggerId &&
    actual.expectedExecutionTaskId === expected.expectedExecutionTaskId &&
    actual.executionTaskId === expected.executionTaskId;
  if (!matches) throw dispatcherError("schedule_run_dispatch_intent_changed");
}

function reconcileFailure(intent, errorCode, controlRepository, now, submission = null) {
  const current = controlRepository.getIntent(intent.runId, { tenantScope: intent.tenantScope });
  if (current?.intentState === "cancel_requested") return canceledResult(current, submission);
  if (!current || !DISPATCHABLE_INTENT_STATES.has(current.intentState)) {
    if (submission) {
      return conflictResult(current || intent, "schedule_run_dispatch_intent_changed", submission);
    }
    throw dispatcherError("schedule_run_dispatch_intent_changed");
  }
  try {
    const reconciled = controlRepository.markReconcileRequired({
      tenantScope: current.tenantScope,
      runId: current.runId,
      expectedIntentVersion: current.intentVersion,
      errorCode,
      reconciledAt: now(),
    });
    return deepFreeze({
      contractVersion: SCHEDULE_RUN_INTENT_DISPATCHER_CONTRACT_VERSION,
      outcome: "reconcile_required",
      runId: reconciled.runId,
      taskCreated: submission?.created === true,
      triggerCreated: submission?.triggerCreated === true,
      wakeRequested: false,
      errorCode,
    });
  } catch (error) {
    const latest = controlRepository.getIntent(intent.runId, { tenantScope: intent.tenantScope });
    if (latest?.intentState === "cancel_requested") return canceledResult(latest, submission);
    if (submission) return conflictResult(latest || intent, safeFailureCode(error), submission);
    throw dispatcherError(safeFailureCode(error));
  }
}

function conflictResult(intent, errorCode, submission) {
  return deepFreeze({
    contractVersion: SCHEDULE_RUN_INTENT_DISPATCHER_CONTRACT_VERSION,
    outcome: "conflict",
    runId: intent.runId,
    taskCreated: submission?.created === true,
    triggerCreated: submission?.triggerCreated === true,
    wakeRequested: false,
    errorCode,
  });
}

function canceledResult(intent, submission = null) {
  return deepFreeze({
    contractVersion: SCHEDULE_RUN_INTENT_DISPATCHER_CONTRACT_VERSION,
    outcome: "canceled",
    runId: intent.runId,
    taskCreated: submission?.created === true,
    triggerCreated: submission?.triggerCreated === true,
    wakeRequested: false,
    errorCode: intent.lastErrorCode || "schedule_run_canceled",
  });
}

function normalizeRequest({ tenantScope, runId, expectedIntentVersion }) {
  return {
    tenantScope: token(tenantScope, "tenantScope"),
    runId: token(runId, "runId"),
    expectedIntentVersion: boundedInteger(expectedIntentVersion, 1, Number.MAX_SAFE_INTEGER, "expectedIntentVersion"),
  };
}

function safeFailureCode(error) {
  const code = String(error?.code || "");
  if (/^(?:schedule_activation|schedule_trigger|schedule_task|schedule_control|execution_task|schedule_run_dispatch|schedule_run_configuration)_[a-z0-9_]{1,100}$/.test(code)) {
    return code;
  }
  return "schedule_run_submission_failed";
}

function token(value, field) {
  const text = String(value || "").trim();
  if (!text || text.length > 240 || !/^[A-Za-z0-9][A-Za-z0-9._:@-]*$/.test(text)) {
    throw dispatcherError(`schedule_run_dispatch_${field}_invalid`);
  }
  return text;
}

function exactKeys(value, fields) {
  const expected = [...fields].sort();
  const actual = Object.keys(value).sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function boundedInteger(value, minimum, maximum, field) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw dispatcherError(`schedule_run_dispatch_${field}_invalid`);
  }
  return value;
}

function assertDependencies({
  controlRepository,
  executionTaskRepository,
  now,
  resolveActivatedScheduleSnapshot,
  scheduleTriggerRepository,
  verifyScheduledFor,
  wakeWorker,
}) {
  for (const method of [
    "getControl",
    "getIntent",
    "listIncompleteIntents",
    "markReconcileRequired",
    "markSubmitted",
    "revalidateSubmittedIntent",
  ]) {
    if (typeof controlRepository?.[method] !== "function") {
      throw new TypeError(`schedule run intent dispatcher requires controlRepository.${method}`);
    }
  }
  if (typeof executionTaskRepository?.submitOrGet !== "function") {
    throw new TypeError("schedule run intent dispatcher requires executionTaskRepository.submitOrGet");
  }
  if (typeof scheduleTriggerRepository?.saveOrGet !== "function") {
    throw new TypeError("schedule run intent dispatcher requires scheduleTriggerRepository.saveOrGet");
  }
  for (const [name, value] of Object.entries({ now, resolveActivatedScheduleSnapshot, verifyScheduledFor, wakeWorker })) {
    if (typeof value !== "function") throw new TypeError(`schedule run intent dispatcher requires ${name}`);
  }
}

function dispatcherError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value)) deepFreeze(child);
  return value;
}

export {
  SCHEDULE_RUN_INTENT_DISPATCHER_CONTRACT_VERSION,
  createScheduleRunIntentDispatcher,
};
