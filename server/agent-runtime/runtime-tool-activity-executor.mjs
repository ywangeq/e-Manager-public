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
  operationReceiptContext = null,
  persistActivity = null,
  persistEfficiency = null,
  repeatThreshold = 3,
  runtimeTask = null,
  signal = null,
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
  if (snapshot.activities.length >= 50) {
    throw executorError("agent_tool_activity_limit_reached");
  }
  const sequence = snapshot.activities.length + 1;
  let activity = null;
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
    result = await toolExecutor.execute(toolCall, {
      confirmedToolCall: confirmedToolCall === true,
      onControlledRetry: () => {
        executorRetryCount += 1;
      },
      operationReceiptContext: effectiveOperationReceiptContext,
      safeActivity: lifecycle,
      signal,
      runtimeTask,
    });
  } catch (error) {
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
