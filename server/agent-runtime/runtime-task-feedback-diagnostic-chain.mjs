const CONTRACT_VERSION = "runtime-task-feedback-diagnostic-chain.v1";
const EVENT_TYPES = new Set([
  "task.artifact_available",
  "task.progress",
  "task.result_available",
  "task.state_changed",
]);
const TASK_STATUSES = new Set([
  "blocked", "canceled", "completed", "failed", "lost", "rejected", "timeout", "timed_out",
]);

function createRuntimeTaskFeedbackDiagnosticChain({
  artifacts = [],
  eventsPage = null,
  operationReceiptSummary = null,
  task = null,
} = {}) {
  if (task?.contractVersion !== "digital-employee-runtime-task.v2") {
    throw diagnosticError("runtime_task_feedback_diagnostic_task_invalid");
  }
  const events = Array.isArray(eventsPage?.events) ? eventsPage.events : [];
  const runtime = task.execution || {};
  const agentRuntime = runtime.agentRuntime || null;
  const activitySnapshot = agentRuntime?.activitySnapshot || null;
  const provenance = runtime.skillProvenance || null;
  const efficiency = runtime.toolLoopEfficiency || null;
  return sanitizeRuntimeTaskFeedbackDiagnosticChain({
    contractVersion: CONTRACT_VERSION,
    task: {
      taskId: task.id,
      revision: task.revision,
      employeeId: task.employeeId,
      employeeVersion: task.employeeVersion,
      status: task.status,
      sourceSystemId: task.sourceSystemId,
      taskType: task.taskType,
      updatedAt: task.updatedAt,
    },
    events: {
      authority: "execution-task-events.v1",
      latestSeq: eventsPage?.latestSeq || 0,
      minAvailableSeq: eventsPage?.minAvailableSeq || 0,
      complete: eventsPage?.hasMore !== true && eventsPage?.resetRequired !== true &&
        Number(eventsPage?.minAvailableSeq || 0) <= 1,
      refs: events.map((event) => ({
        seq: event.seq,
        taskRevision: event.taskRevision,
        eventType: event.eventType,
        occurredAt: event.occurredAt,
      })),
    },
    activities: {
      authority: activitySnapshot?.contractVersion || "runtime-safe-activity.v1",
      refs: (activitySnapshot?.activities || []).map((activity) => ({
        activityId: activity.activityId,
        sequence: activity.sequence,
        kind: activity.kind,
        subjectId: activity.subjectId,
        actionCode: activity.actionCode,
        status: activity.status,
      })),
    },
    provenance: {
      authority: provenance?.contractVersion || "runtime-safe-provenance.v1",
      available: Boolean(provenance),
      employeeProfileVersion: provenance?.employeeProfile?.sourceVersion || "",
      callableSkillCount: provenance?.callableSkills?.length || 0,
      executedSkillRefs: (provenance?.executedSkills || []).map((skill) => ({
        activityId: skill.activityId,
        subjectId: skill.subjectId,
        sourceVersion: skill.sourceVersion,
        status: skill.status,
      })),
    },
    efficiency: {
      authority: efficiency?.contractVersion || "runtime-tool-efficiency.v1",
      available: Boolean(efficiency),
      evidenceStatus: efficiency?.evidenceStatus || "unavailable",
      totalCallCount: efficiency?.totalCallCount || 0,
      retries: efficiency?.retries || {},
      circuitBreaker: efficiency?.circuitBreaker || {},
      redundancyCandidateCount: efficiency?.redundancyCandidates?.length || 0,
    },
    artifacts: {
      authority: "artifact-ref.v1",
      refs: (Array.isArray(artifacts) ? artifacts : []).map((artifact) => ({
        artifactId: artifact.artifactId,
        contractVersion: artifact.contractVersion,
        createdAt: artifact.createdAt,
        expiresAt: artifact.expiresAt,
      })),
    },
    receipts: {
      authority: "operation-receipt.v1",
      available: Boolean(operationReceiptSummary),
      total: operationReceiptSummary?.total || 0,
      prepared: operationReceiptSummary?.prepared || 0,
      succeeded: operationReceiptSummary?.succeeded || 0,
      definitiveFailed: operationReceiptSummary?.definitiveFailed || 0,
      unknown: operationReceiptSummary?.unknown || 0,
      effectState: operationReceiptSummary?.effectState || "unavailable",
    },
  });
}

function sanitizeRuntimeTaskFeedbackDiagnosticChain(value = null) {
  if (!value || typeof value !== "object" || Array.isArray(value) || value.contractVersion !== CONTRACT_VERSION) {
    return null;
  }
  try {
    const task = value.task || {};
    const events = value.events || {};
    const activities = value.activities || {};
    const provenance = value.provenance || {};
    const efficiency = value.efficiency || {};
    const artifacts = value.artifacts || {};
    const receipts = value.receipts || {};
    return Object.freeze({
      contractVersion: CONTRACT_VERSION,
      task: Object.freeze({
        taskId: token(task.taskId, 128),
        revision: positiveInteger(task.revision, "taskRevision"),
        employeeId: token(task.employeeId, 160),
        employeeVersion: token(task.employeeVersion, 120),
        status: enumValue(task.status, TASK_STATUSES, "taskStatus"),
        sourceSystemId: token(task.sourceSystemId, 120),
        taskType: token(task.taskType, 120),
        updatedAt: timestamp(task.updatedAt),
      }),
      events: Object.freeze({
        authority: token(events.authority, 120),
        latestSeq: nonNegativeInteger(events.latestSeq, "latestSeq"),
        minAvailableSeq: nonNegativeInteger(events.minAvailableSeq, "minAvailableSeq"),
        complete: events.complete === true,
        refs: Object.freeze(boundedArray(events.refs, 200).map((event) => Object.freeze({
          seq: positiveInteger(event?.seq, "eventSeq"),
          taskRevision: positiveInteger(event?.taskRevision, "eventTaskRevision"),
          eventType: enumValue(event?.eventType, EVENT_TYPES, "eventType"),
          occurredAt: timestamp(event?.occurredAt),
        }))),
      }),
      activities: Object.freeze({
        authority: token(activities.authority, 120),
        refs: Object.freeze(boundedArray(activities.refs, 100).map((activity) => Object.freeze({
          activityId: token(activity?.activityId, 180),
          sequence: positiveInteger(activity?.sequence, "activitySequence"),
          kind: token(activity?.kind, 40),
          subjectId: token(activity?.subjectId, 180),
          actionCode: token(activity?.actionCode, 120),
          status: token(activity?.status, 40),
        }))),
      }),
      provenance: Object.freeze({
        authority: token(provenance.authority, 120),
        available: provenance.available === true,
        employeeProfileVersion: optionalToken(provenance.employeeProfileVersion, 180),
        callableSkillCount: nonNegativeInteger(provenance.callableSkillCount, "callableSkillCount"),
        executedSkillRefs: Object.freeze(boundedArray(provenance.executedSkillRefs, 50).map((skill) => Object.freeze({
          activityId: token(skill?.activityId, 180),
          subjectId: token(skill?.subjectId, 180),
          sourceVersion: token(skill?.sourceVersion, 180),
          status: token(skill?.status, 40),
        }))),
      }),
      efficiency: Object.freeze({
        authority: token(efficiency.authority, 120),
        available: efficiency.available === true,
        evidenceStatus: token(efficiency.evidenceStatus, 80),
        totalCallCount: nonNegativeInteger(efficiency.totalCallCount, "totalCallCount"),
        retries: Object.freeze({
          provider: nonNegativeInteger(efficiency.retries?.provider || 0, "providerRetries"),
          executor: nonNegativeInteger(efficiency.retries?.executor || 0, "executorRetries"),
        }),
        circuitBreaker: Object.freeze({
          status: optionalToken(efficiency.circuitBreaker?.status, 80),
          reasonCode: optionalToken(efficiency.circuitBreaker?.reasonCode, 120),
        }),
        redundancyCandidateCount: nonNegativeInteger(
          efficiency.redundancyCandidateCount,
          "redundancyCandidateCount",
        ),
      }),
      artifacts: Object.freeze({
        authority: token(artifacts.authority, 120),
        refs: Object.freeze(boundedArray(artifacts.refs, 50).map((artifact) => Object.freeze({
          artifactId: token(artifact?.artifactId, 180),
          contractVersion: token(artifact?.contractVersion, 120),
          createdAt: timestamp(artifact?.createdAt),
          expiresAt: timestamp(artifact?.expiresAt),
        }))),
      }),
      receipts: Object.freeze({
        authority: token(receipts.authority, 120),
        available: receipts.available === true,
        total: nonNegativeInteger(receipts.total, "receiptTotal"),
        prepared: nonNegativeInteger(receipts.prepared, "receiptPrepared"),
        succeeded: nonNegativeInteger(receipts.succeeded, "receiptSucceeded"),
        definitiveFailed: nonNegativeInteger(receipts.definitiveFailed, "receiptDefinitiveFailed"),
        unknown: nonNegativeInteger(receipts.unknown, "receiptUnknown"),
        effectState: token(receipts.effectState, 80),
      }),
    });
  } catch {
    return null;
  }
}

function boundedArray(value, max) {
  if (!Array.isArray(value) || value.length > max) throw diagnosticError("runtime_task_feedback_diagnostic_array_invalid");
  return value;
}

function token(value, max) {
  const normalized = String(value || "").trim();
  if (!normalized || normalized.length > max || /[\r\n\0]/.test(normalized)) {
    throw diagnosticError("runtime_task_feedback_diagnostic_token_invalid");
  }
  return normalized;
}

function optionalToken(value, max) {
  const normalized = String(value || "").trim();
  return normalized ? token(normalized, max) : "";
}

function enumValue(value, allowed, field) {
  const normalized = token(value, 120);
  if (!allowed.has(normalized)) throw diagnosticError(`runtime_task_feedback_diagnostic_${field}_invalid`);
  return normalized;
}

function timestamp(value) {
  const normalized = String(value || "").trim();
  if (!normalized || !Number.isFinite(Date.parse(normalized))) {
    throw diagnosticError("runtime_task_feedback_diagnostic_timestamp_invalid");
  }
  return new Date(Date.parse(normalized)).toISOString();
}

function positiveInteger(value, field) {
  const normalized = Number(value);
  if (!Number.isSafeInteger(normalized) || normalized <= 0) {
    throw diagnosticError(`runtime_task_feedback_diagnostic_${field}_invalid`);
  }
  return normalized;
}

function nonNegativeInteger(value, field) {
  const normalized = Number(value);
  if (!Number.isSafeInteger(normalized) || normalized < 0) {
    throw diagnosticError(`runtime_task_feedback_diagnostic_${field}_invalid`);
  }
  return normalized;
}

function diagnosticError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

export {
  CONTRACT_VERSION as RUNTIME_TASK_FEEDBACK_DIAGNOSTIC_CHAIN_CONTRACT_VERSION,
  createRuntimeTaskFeedbackDiagnosticChain,
  sanitizeRuntimeTaskFeedbackDiagnosticChain,
};
