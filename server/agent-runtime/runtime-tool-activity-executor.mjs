import {
  normalizeRuntimeSafeActivitySnapshot,
} from "./runtime-safe-activity-contract-v1.mjs";
import {
  createRuntimeSafeActivityProjector,
  runtimeSafeActivityStatusForResult,
} from "./runtime-safe-activity-projector.mjs";
import { operationReceiptContextForExecutionOwnership } from "./operation-receipt-context.mjs";

async function executeRuntimeToolActivity({
  activitySnapshot = null,
  onActivity = null,
  confirmedToolCall = false,
  recoverRecordedResult = false,
  recoverySequence = null,
  operationReceiptContext = null,
  persistActivity = null,
  persistEfficiency = null,
  repeatThreshold = 3,
  runtimeTask = null,
  signal = null,
  timeoutMs = 300_000,
  toolCall = {},
  toolExecutor = null,
} = {}) {
  const taskId = requiredToken(runtimeTask?.taskId || runtimeTask?.id, "taskId", 128);
  if (typeof toolExecutor?.execute !== "function") {
    throw executorError("runtime_tool_activity_executor_invalid");
  }
  if (onActivity !== null && typeof onActivity !== "function") {
    throw executorError("runtime_tool_activity_callback_invalid");
  }
  if (persistActivity !== null && typeof persistActivity !== "function") {
    throw executorError("runtime_tool_activity_recorder_invalid");
  }
  if (persistEfficiency !== null && typeof persistEfficiency !== "function") {
    throw executorError("runtime_tool_efficiency_recorder_invalid");
  }
  const projector = createRuntimeSafeActivityProjector({ taskId, toolExecutor });
  const effectiveOperationReceiptContext = operationReceiptContext || operationReceiptContextForExecutionOwnership({
    task: runtimeTask,
    lease: runtimeTask?.lease,
  });
  let snapshot = activitySnapshot
    ? normalizeRuntimeSafeActivitySnapshot(activitySnapshot, { expectedTaskId: taskId })
    : projector.snapshot([]);
  if (snapshot.activities.length >= 50 && !recoverRecordedResult) {
    throw executorError("agent_tool_activity_limit_reached");
  }
  const sequence = recoverRecordedResult ? recoverySequence : snapshot.activities.length + 1;
  if (recoverRecordedResult && (!Number.isSafeInteger(sequence) || sequence < 1 ||
    sequence > 50 || (sequence < snapshot.activities.length && !confirmedToolCall) || sequence > snapshot.activities.length + 1 ||
    typeof toolExecutor.recoverRecordedResult !== "function")) throw executorError("agent_loop_continuation_effect_reconciliation_required");
  let activity = recoverRecordedResult ? snapshot.activities.find(item => item.sequence === sequence) || null : null;
  const existingTerminal = activity && activity.status !== "started";
  if (activity) {
    const expected = projector.start({sequence,toolCall});
    if (["activityId","sequence","kind","subjectId","actionCode"].some(field => expected[field] !== activity[field])) {
      throw executorError("runtime_safe_activity_identity_conflict");
    }
  }
  if (recoverRecordedResult && (!existingTerminal ||
    !runtimeTask?.toolEfficiencySource?.calls?.some(item => item.activityId === activity.activityId && item.sequence === sequence))) {
    throw executorError("agent_loop_continuation_effect_reconciliation_required");
  }
  let executorRetryCount = 0;

  async function publish(nextActivity, phase) {
    const existingIndex = snapshot.activities.findIndex((item) => item.sequence === sequence);
    snapshot = projector.snapshot(existingIndex === -1
      ? [...snapshot.activities, nextActivity]
      : snapshot.activities.map((item, index) => index === existingIndex ? nextActivity : item));
    if (persistActivity) {
      const stored = await persistActivity({ activitySnapshot: snapshot, phase });
      if (stored?.activitySnapshot) {
        const storedSnapshot = normalizeRuntimeSafeActivitySnapshot(stored.activitySnapshot, {
          expectedTaskId: taskId,
        });
        const storedActivity = storedSnapshot.activities.find((item) => item.sequence === sequence);
        if (!storedActivity || storedActivity.activityId !== nextActivity.activityId ||
          storedActivity.status !== nextActivity.status) {
          throw executorError("runtime_safe_activity_persistence_conflict");
        }
        snapshot = storedSnapshot;
      }
    }
    onActivity?.({
      activityId: nextActivity.activityId,
      sequence: nextActivity.sequence,
      status: phase === "started"
        ? "running"
        : nextActivity.status === "target_rejected"
          ? "target_rejected"
          : ["blocked", "failed", "rejected"].includes(nextActivity.status) ? "blocked" : "done",
    });
  }

  const lifecycle = Object.freeze({
    async start(descriptor = null) {
      if (activity) {
        if (descriptor) throw executorError("runtime_safe_activity_identity_conflict");
        return activity;
      }
      activity = projector.start({
        ...(descriptor ? { descriptor } : {}),
        sequence,
        toolCall,
      });
      await publish(activity, "started");
      return activity;
    },
  });

  if (toolCall.name !== "run_mounted_skill") await lifecycle.start();
  let result;
  try {
    result = await executeWithTimeout(signal, timeoutMs, toolSignal => toolExecutor[recoverRecordedResult ? "recoverRecordedResult" : "execute"](toolCall, {
      confirmedToolCall: confirmedToolCall === true,
      onControlledRetry: () => {
        executorRetryCount += 1;
      },
      operationReceiptContext: effectiveOperationReceiptContext,
      safeActivity: lifecycle,
      signal: toolSignal,
      runtimeTask,
    }));
  } catch (error) {
    if (recoverRecordedResult) throw error;
    if (!activity) await lifecycle.start();
    activity = projector.finish({ activity, status: "failed", toolCall });
    await publish(activity, "terminal");
    await persistEfficiency?.({
      activity,
      executorRetryCount,
      repeatThreshold,
      result: undefined,
      toolCall,
    });
    throw error;
  }
  if (recoverRecordedResult && (!["succeeded","definitive_failed"].includes(result?.externalEffectStatus) ||
    result?.status === "in_progress" || result?.asyncResult?.terminal === false)) {
    throw executorError("agent_loop_continuation_effect_reconciliation_required");
  }
  if (existingTerminal) {
    if (activity.status !== runtimeSafeActivityStatusForResult(result)) throw executorError("runtime_safe_activity_persistence_conflict");
    const entry = runtimeTask.toolEfficiencySource.calls.find(item => item.activityId === activity.activityId);
    return Object.freeze({activity,activitySnapshot:snapshot,
      efficiency:{analysis:{breakerTriggered:runtimeTask.toolEfficiencySource.breaker.status === "triggered"}},
      executorRetryCount:entry.executorRetryCount,result});
  }
  if (!activity) await lifecycle.start();
  activity = projector.finish({
    activity,
    result,
    status: runtimeSafeActivityStatusForResult(result),
    toolCall,
  });
  await publish(activity, "terminal");
  const efficiency = await persistEfficiency?.({
    activity,
    executorRetryCount,
    repeatThreshold,
    result,
    toolCall,
  }) || null;
  return Object.freeze({ activity, activitySnapshot: snapshot, efficiency, executorRetryCount, result });
}

function requiredToken(value, field, maxLength) {
  const token = String(value || "").trim();
  if (!token || token.length > maxLength || !/^[A-Za-z0-9][A-Za-z0-9._:@-]*$/.test(token)) {
    throw executorError(`runtime_tool_activity_${field}_invalid`);
  }
  return token;
}

function executorError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

export { executeRuntimeToolActivity };

async function executeWithTimeout(parent, timeoutMs, execute) {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 172_800_000) throw executorError("tool_execution_timeout_invalid");
  const controller = new AbortController();
  let timer, abort;
  const interrupted = new Promise((_, reject) => {
    abort = () => { const reason = parent?.reason || executorError("agent_turn_canceled"); controller.abort(reason); reject(reason); };
    parent?.addEventListener("abort", abort, { once: true });
    timer = setTimeout(() => { const error = executorError("tool_execution_timeout"); controller.abort(error); reject(error); }, timeoutMs);
    if (parent?.aborted) abort();
  });
  try {
    return await Promise.race([Promise.resolve().then(() => {
      if (controller.signal.aborted) throw controller.signal.reason;
      return execute(controller.signal);
    }), interrupted]);
  } finally { clearTimeout(timer); parent?.removeEventListener("abort", abort); }
}
