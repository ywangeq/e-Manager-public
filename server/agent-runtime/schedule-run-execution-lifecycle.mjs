import { projectScheduleFromRunConfiguration } from "./schedule-run-configuration.mjs";
import { createScheduleAgentTerminalEvidenceResolver } from "./schedule-agent-terminal-evidence.mjs";
import { SCHEDULE_RUN_AGENT_ADAPTER_CONTRACT_VERSION } from "./schedule-run-agent-adapter.mjs";
import crypto from "node:crypto";
import { projectScheduleRunTerminalEvidence } from "./sqlite-schedule-control-repository.mjs";
import { assertScheduleTaskTriggerMatch } from "./schedule-task-input-resolver.mjs";
import { SCHEDULE_RUN_PROVIDER_RESULT_ADAPTER_CONTRACT_VERSION } from
  "./schedule-run-provider-result-adapter.mjs";
import { scheduleTriggerSlotDigest } from "./schedule-trigger-service.mjs";

const SCHEDULE_RUN_EXECUTION_LIFECYCLE_CONTRACT_VERSION = "schedule-run-execution-lifecycle.v1";
const SCHEDULE_RUN_EXECUTION_GUARD_CONTRACT_VERSION = "schedule-run-execution-guard.v1";
const SCHEDULE_RUN_FIXTURE_DELEGATE_CONTRACT_VERSION = "schedule-run-fixture-delegate.v1";
const SCHEDULE_RUN_ZERO_EFFECT_EVIDENCE_CONTRACT_VERSION = "schedule-run-zero-effect-evidence.v1";
const TERMINAL_TASK_STATUSES = new Set([
  "blocked",
  "canceled",
  "completed",
  "failed",
  "lost",
  "rejected",
  "timed_out",
]);

function createScheduleRunExecutionLifecycle({
  controlRepository,
  executionTaskRepository,
  fixtureDelegate,
  productionAdapter,
  heartbeatIntervalMs = 10_000,
  now = () => new Date(),
  runLeaseDurationMs = 30_000,
  runOwnerDigest,
  scheduleTriggerRepository,
} = {}) {
  assertDependencies({
    controlRepository,
    executionTaskRepository,
    heartbeatIntervalMs,
    now,
    runLeaseDurationMs,
    runOwnerDigest,
    scheduleTriggerRepository,
  });
  const delegate = normalizeExecutionAdapter({ fixtureDelegate, productionAdapter });
  const guards = new WeakMap();

  function resolveExecutionLifecycle(task) {
    if (!isScheduleNamespaceTask(task)) return null;
    let binding = null;
    let initializationFailed = false;
    try {
      binding = resolveExactBinding(task, { controlRepository, scheduleTriggerRepository });
    } catch {
      initializationFailed = true;
    }
    let heartbeat = null;
    let state = null;

    return Object.freeze({
      beforeExecute({ task: currentTask, lease, abort, isCancellationRequested } = {}) {
        requireSameClaimedTask(task, currentTask, lease);
        if (initializationFailed) throw lifecycleError("schedule_run_initialization_failed");
        if (typeof abort !== "function" || typeof isCancellationRequested !== "function") {
          throw lifecycleError("schedule_run_worker_ownership_invalid");
        }
        const currentBinding = resolveExactBinding(currentTask, { controlRepository, scheduleTriggerRepository });
        requireSameBinding(binding, currentBinding);
        const snapshot = controlRepository.getActivationSnapshot?.(currentBinding.intent.activationSnapshotId, {
          tenantScope: currentTask.tenantScope,
        });
        if ((delegate.adapterKind === "shared_agent_runtime") !== (snapshot?.contractVersion === "schedule-activation-snapshot.v3")) {
          throw lifecycleError("schedule_run_adapter_profile_mismatch");
        }
        if (delegate.adapterKind === "shared_agent_runtime") {
          const configuration = controlRepository.getRunConfiguration?.({ tenantScope: currentTask.tenantScope, runId: currentBinding.runId });
          const projected = projectScheduleFromRunConfiguration(snapshot, configuration, currentBinding.intent);
          if (projected.employeeVersion !== currentTask.employeeVersion || projected.runConfigurationDigest !== currentBinding.trigger.runConfigurationDigest ||
            JSON.stringify(projected.providerTimeoutPolicy) !== JSON.stringify(currentTask.providerTimeoutPolicy)) throw lifecycleError("schedule_run_configuration_binding_mismatch");
        }
        state = claimOrResolveRunExecution({
          binding: currentBinding,
          controlRepository,
          now: now(),
          runLeaseDurationMs,
          runOwnerDigest,
          task: currentTask,
        });
        const guard = Object.freeze({
          contractVersion: SCHEDULE_RUN_EXECUTION_GUARD_CONTRACT_VERSION,
          mode: state.mode,
          runId: currentBinding.runId,
          taskId: currentTask.taskId,
        });
        guards.set(guard, state);
        if (state.mode === "ready") {
          heartbeat = startRunHeartbeat({
            abort,
            controlRepository,
            executionTaskRepository,
            heartbeatIntervalMs,
            isCancellationRequested,
            now,
            runLeaseDurationMs,
            state,
            task: currentTask,
          });
        }
        return guard;
      },
      afterCanonicalOutcome(outcome) {
        stopHeartbeat(heartbeat);
        heartbeat = null;
        if (!outcome?.canonicalTerminal || !outcome.actualTask) return null;
        let freshBinding;
        try {
          freshBinding = resolveExactBinding(outcome.actualTask, {
            controlRepository,
            scheduleTriggerRepository,
          });
          if (binding) requireSameBinding(binding, freshBinding);
        } catch {
          throw lifecycleError("schedule_run_terminal_reconciliation_deferred");
        }
        return delegate.adapterKind === "shared_agent_runtime" ? convergeAgentTerminal({
          binding: freshBinding, controlRepository, executionTaskRepository, scheduleTriggerRepository, now: now(), task: outcome.actualTask,
        }) : delegate.adapterKind === "provider_result" ? convergeProductionTerminal({
          binding: freshBinding,
          controlRepository,
          now: now(),
          task: outcome.actualTask,
        }) : convergeTerminal({
          binding: freshBinding,
          controlRepository,
          executionTaskRepository,
          fixtureDelegate: delegate,
          now: now(),
          task: outcome.actualTask,
        });
      },
      dispose() {
        stopHeartbeat(heartbeat);
        heartbeat = null;
      },
    });
  }

  function resolvePersistentTaskExecutor(task) {
    if (!isScheduleNamespaceTask(task)) return null;
    return async (ownership) => {
      const state = guards.get(ownership?.executionGuard);
      if (!state || ownership?.task?.taskId !== state.binding.task.taskId) {
        return blockedSettlement("schedule_run_execution_guard_invalid");
      }
      if (state.mode === "cancel_requested") {
        return blockedSettlement("schedule_run_cancel_requested");
      }
      if (state.mode === "skipped_max_concurrency") {
        return blockedSettlement("schedule_run_skipped_max_concurrency");
      }
      if (state.mode === "skipped_overlap_window") {
        return blockedSettlement("schedule_run_skipped_overlap_window");
      }
      if (state.mode === "reconcile_only") {
        if (delegate.adapterKind === "shared_agent_runtime") {
          return blockedSettlement("schedule_agent_interrupted_no_automatic_replay");
        }
        if (delegate.adapterKind === "provider_result") {
          return normalizeProductionSettlement(await delegate.recoverResult(
            productionRequest(state),
            { signal: ownership.signal },
          ));
        }
        return rebuildReconcileOnlySettlement({
          controlRepository,
          executionTaskRepository,
          fixtureDelegate: delegate,
          state,
          task: ownership.task,
        });
      }
      if (cancellationRequested(ownership)) {
        return delegate.adapterKind === "provider_result"
          ? productionPreEffectBlockedSettlement(state, ownership.task, "schedule_run_canceled_before_effect")
          : blockedSettlement("schedule_run_canceled_before_effect");
      }
      if (delegate.adapterKind === "provider_result") {
        try {
          requireInputAcquisitionResult(await delegate.acquireInput(
            productionRequest(state),
            { signal: ownership.signal },
          ));
        } catch {
          return productionPreEffectBlockedSettlement(
            state,
            ownership.task,
            "schedule_run_input_acquisition_failed",
          );
        }
        if (cancellationRequested(ownership)) {
          return productionPreEffectBlockedSettlement(
            state,
            ownership.task,
            "schedule_run_canceled_after_input_acquisition",
          );
        }
      }
      const execution = state.execution;
      try {
        state.execution = controlRepository.prepareRunExecutionEffectDispatch({
          tenantScope: state.binding.intent.tenantScope,
          runId: state.binding.runId,
          expectedExecutionVersion: execution.executionVersion,
          ...dualLeaseIdentity(execution),
          preparedAt: now(),
        });
      } catch (error) {
        if (delegate.adapterKind === "provider_result" && runRemainsPreEffect({
          controlRepository,
          state,
        })) {
          return productionPreEffectBlockedSettlement(
            state,
            ownership.task,
            "schedule_run_effect_barrier_rejected",
          );
        }
        throw error;
      }
      if (cancellationRequested(ownership)) return blockedSettlement("schedule_run_canceled_after_effect_barrier");
      if (typeof ownership.refreshCurrentLease !== "function") {
        throw lifecycleError("schedule_run_task_lease_refresh_unavailable");
      }
      const refreshedTask = ownership.refreshCurrentLease();
      requireSameCanonicalTaskLease(ownership.task, refreshedTask);
      assertScheduleTaskTriggerMatch(refreshedTask, state.binding.trigger);
      state.execution = controlRepository.renewRunExecution({
        tenantScope: state.binding.intent.tenantScope,
        runId: state.binding.runId,
        ...dualLeaseIdentity(state.execution),
        taskLeaseExpiresAt: refreshedTask.lease.expiresAt,
        leaseDurationMs: runLeaseDurationMs,
        now: now(),
      });
      if (!state.execution) throw lifecycleError("schedule_run_execution_ownership_lost");
      state.execution = controlRepository.guardRunExecutionEffectDispatch({
        tenantScope: state.binding.intent.tenantScope,
        runId: state.binding.runId,
        executionTaskId: refreshedTask.taskId,
        expectedIntentVersion: state.binding.intent.intentVersion,
        expectedExecutionVersion: state.execution.executionVersion,
        activationVersion: state.binding.intent.activationVersion,
        ...dualLeaseIdentity(state.execution),
        leaseExpiresAt: state.execution.leaseExpiresAt,
        taskLeaseExpiresAt: state.execution.taskLeaseExpiresAt,
      });
      if (cancellationRequested(ownership)) return blockedSettlement("schedule_run_canceled_before_delegate");
      requireCurrentCanonicalTaskLease(refreshedTask, state.binding.trigger, executionTaskRepository);
      if (delegate.adapterKind === "shared_agent_runtime") {
        const snapshot = controlRepository.getActivationSnapshot(state.binding.intent.activationSnapshotId, {
          tenantScope: refreshedTask.tenantScope,
        });
        if (snapshot?.contractVersion !== "schedule-activation-snapshot.v3" ||
          snapshot.snapshotDigest !== state.binding.intent.activationSnapshotDigest) {
          throw lifecycleError("schedule_run_adapter_profile_mismatch");
        }
        const runConfiguration = controlRepository.getRunConfiguration({ tenantScope: refreshedTask.tenantScope, runId: state.binding.runId });
        const schedule = projectScheduleFromRunConfiguration(snapshot, runConfiguration, state.binding.intent);
        if (schedule.employeeVersion !== refreshedTask.employeeVersion ||
          schedule.runConfigurationDigest !== state.binding.trigger.runConfigurationDigest ||
          JSON.stringify(schedule.providerTimeoutPolicy) !== JSON.stringify(refreshedTask.providerTimeoutPolicy)) {
          throw lifecycleError("schedule_run_configuration_binding_mismatch");
        }
        return delegate.execute({ ownership: { ...ownership, task: refreshedTask }, snapshot, trigger: state.binding.trigger, runConfiguration });
      }
      if (delegate.adapterKind === "provider_result") {
        return normalizeProductionSettlement(await delegate.executeResult(
          productionRequest(state),
          { signal: ownership.signal },
        ));
      }
      const delegateExecutor = delegate.resolvePersistentTaskExecutor(ownership.task);
      if (delegateExecutor !== null && typeof delegateExecutor !== "function") {
        throw lifecycleError("schedule_run_fixture_delegate_invalid");
      }
      if (typeof delegateExecutor !== "function") {
        return blockedSettlement("schedule_run_fixture_executor_unavailable");
      }
      let delegateFailed = false;
      try {
        await delegateExecutor(ownership);
      } catch {
        delegateFailed = true;
      }
      let receiptSummary;
      try {
        receiptSummary = executionTaskRepository.summarizeOperationReceipts({
          tenantScope: ownership.task.tenantScope,
          taskId: ownership.task.taskId,
        });
      } catch {
        return blockedSettlement(
          "schedule_run_receipt_summary_unavailable",
          fixtureEvidenceDigest({
            fixtureDelegate: delegate,
            receiptSummary: null,
            task: ownership.task,
            reasonCode: "receipt_summary_unavailable",
          }),
        );
      }
      if (!isSettledZeroEffectSummary(receiptSummary)) {
        return blockedSettlement(
          "schedule_run_fixture_effect_reconcile_required",
          fixtureEvidenceDigest({
            fixtureDelegate: delegate,
            receiptSummary,
            task: ownership.task,
            reasonCode: "effect_reconcile_required",
          }),
        );
      }
      const operationEvidenceDigest = fixtureEvidenceDigest({
        fixtureDelegate: delegate,
        receiptSummary,
        task: ownership.task,
        reasonCode: "zero_effect",
      });
      let recorded;
      let terminalEvidence;
      try {
        recorded = controlRepository.recordRunResultReceipt({
          tenantScope: state.binding.intent.tenantScope,
          runId: state.binding.runId,
          executionTaskId: ownership.task.taskId,
          expectedIntentVersion: state.binding.intent.intentVersion,
          expectedExecutionVersion: state.execution.executionVersion,
          ...dualLeaseIdentity(state.execution),
          activationSnapshotId: state.binding.intent.activationSnapshotId,
          activationSnapshotDigest: state.binding.intent.activationSnapshotDigest,
          operationReceiptEvidenceDigest: operationEvidenceDigest,
          receiptEffectState: "settled",
          outcome: "no_result_safe",
          resultEvidenceDigest: null,
          recordedAt: now(),
        });
        terminalEvidence = projectScheduleRunTerminalEvidence({
          receipt: recorded.receipt,
          canonicalTaskStatus: "blocked",
        });
      } catch {
        return blockedSettlement(
          "schedule_run_result_receipt_reconciliation_required",
          fixtureEvidenceDigest({
            fixtureDelegate: delegate,
            receiptSummary,
            task: ownership.task,
            reasonCode: "result_receipt_write_failed",
          }),
        );
      }
      state.execution = recorded.execution;
      return blockedSettlement(
        delegateFailed ? "schedule_run_fixture_delegate_failed" : "schedule_run_fixture_no_business_result",
        terminalEvidence.terminalEvidenceDigest,
      );
    };
  }

  function reconcileOnce({ tenantScope, limit = 100 } = {}) {
    const summary = { examined: 0, failed: 0, observed: 0, reconcileRequired: 0, settled: 0, skipped: 0 };
    const intents = controlRepository.listIncompleteIntents({ tenantScope, limit });
    for (const intent of intents) {
      summary.examined += 1;
      try {
        if (!intent.executionTaskId || intent.intentState === "cancel_requested") {
          summary.skipped += 1;
          continue;
        }
        const task = executionTaskRepository.get(intent.executionTaskId, { tenantScope: intent.tenantScope });
        if (!task || !TERMINAL_TASK_STATUSES.has(task.status)) {
          summary.skipped += 1;
          continue;
        }
        const binding = resolveExactBinding(task, { controlRepository, scheduleTriggerRepository });
        requireSameIntent(intent, binding.intent);
        const result = delegate.adapterKind === "shared_agent_runtime" ? convergeAgentTerminal({
          binding, controlRepository, executionTaskRepository, scheduleTriggerRepository, now: now(), task,
        }) : delegate.adapterKind === "provider_result" ? convergeProductionTerminal({
          binding,
          controlRepository,
          now: now(),
          task,
        }) : convergeTerminal({
          binding,
          controlRepository,
          executionTaskRepository,
          fixtureDelegate: delegate,
          now: now(),
          task,
        });
        if (result === "settled") summary.settled += 1;
        else if (result === "reconcile_required") summary.reconcileRequired += 1;
        else if (result === "observed") summary.observed += 1;
        else summary.skipped += 1;
      } catch {
        summary.failed += 1;
      }
    }
    return Object.freeze(summary);
  }

  return Object.freeze({
    contractVersion: SCHEDULE_RUN_EXECUTION_LIFECYCLE_CONTRACT_VERSION,
    reconcileOnce,
    resolveExecutionLifecycle,
    resolvePersistentTaskExecutor,
  });
}

function rebuildReconcileOnlySettlement({
  controlRepository,
  executionTaskRepository,
  fixtureDelegate,
  state,
  task,
}) {
  let receiptSummary = null;
  try {
    receiptSummary = executionTaskRepository.summarizeOperationReceipts({
      tenantScope: task.tenantScope,
      taskId: task.taskId,
    });
  } catch {
    receiptSummary = null;
  }
  const zeroEffect = isSettledZeroEffectSummary(receiptSummary);
  const currentEvidenceDigest = fixtureEvidenceDigest({
    fixtureDelegate,
    receiptSummary,
    task,
    reasonCode: receiptSummary ? (zeroEffect ? "zero_effect" : "effect_reconcile_required") : "receipt_summary_unavailable",
  });
  const storedReceipt = controlRepository.getRunResultReceipt(state.binding.runId, {
    tenantScope: task.tenantScope,
  });
  const exactReceipt = storedReceipt && zeroEffect && storedReceipt.outcome === "no_result_safe" &&
    storedReceipt.receiptEffectState === "settled" && storedReceipt.resultEvidenceDigest === null &&
    storedReceipt.operationReceiptEvidenceDigest === currentEvidenceDigest;
  if (exactReceipt) {
    const terminalEvidence = projectScheduleRunTerminalEvidence({
      receipt: storedReceipt,
      canonicalTaskStatus: "blocked",
    });
    return blockedSettlement(
      "schedule_run_fixture_no_business_result",
      terminalEvidence.terminalEvidenceDigest,
    );
  }
  return blockedSettlement("schedule_run_effect_reconcile_required", currentEvidenceDigest);
}

function claimOrResolveRunExecution({
  binding,
  controlRepository,
  now,
  runLeaseDurationMs,
  runOwnerDigest,
  task,
}) {
  if (binding.intent.intentState === "cancel_requested") {
    return { binding, execution: controlRepository.getRunExecution(binding.runId, { tenantScope: task.tenantScope }), mode: "cancel_requested" };
  }
  const existing = controlRepository.getRunExecution(binding.runId, { tenantScope: task.tenantScope });
  let execution;
  if (!existing) {
    execution = controlRepository.claimRunExecution({
      ...runClaimIdentity(binding, task),
      ...canonicalTaskLease(task),
      runOwnerDigest,
      leaseDurationMs: runLeaseDurationMs,
      now,
    });
  } else if (existing.executionState === "skipped_admission") {
    requireCurrentControl(binding, controlRepository);
    execution = existing;
  } else if (existing.executionState === "active" && existing.executionPhase === "effect_dispatch_prepared") {
    execution = existing;
  } else if (sameCanonicalLease(existing, task)) {
    execution = controlRepository.claimRunExecution({
      ...runClaimIdentity(binding, task),
      ...canonicalTaskLease(task),
      runOwnerDigest,
      leaseDurationMs: runLeaseDurationMs,
      now,
    });
  } else if (canTakeOverPreEffect(existing, task, now)) {
    execution = controlRepository.rebindPreEffectRunExecution({
      ...runClaimIdentity(binding, task),
      expectedExecutionVersion: existing.executionVersion,
      ...canonicalTaskLease(task),
      runOwnerDigest,
      leaseDurationMs: runLeaseDurationMs,
      now,
    });
  } else {
    throw lifecycleError("schedule_run_execution_ownership_conflict");
  }
  const mode = execution.executionState === "skipped_admission"
    ? execution.admissionOutcome
    : execution.executionPhase === "effect_dispatch_prepared"
      ? "reconcile_only"
      : "ready";
  return { binding, execution, mode };
}

function convergeTerminal({ binding, controlRepository, executionTaskRepository, fixtureDelegate, now, task }) {
  const intent = controlRepository.getIntent(binding.runId, { tenantScope: task.tenantScope });
  if (!intent || intent.intentState === "cancel_requested" || intent.intentState === "terminal_observed") return "skipped";
  requireSameIntent(binding.intent, intent);
  const execution = controlRepository.getRunExecution(binding.runId, { tenantScope: task.tenantScope });
  if (!execution || execution.executionState === "skipped_admission") {
    controlRepository.observeExecutionTask({
      tenantScope: task.tenantScope,
      runId: binding.runId,
      expectedIntentVersion: intent.intentVersion,
      taskStatus: task.status,
      observedAt: now,
    });
    return "observed";
  }
  if (execution.executionState === "cancel_requested") return "skipped";
  if (execution.executionState !== "active") return "skipped";
  let receiptSummary = null;
  try {
    receiptSummary = executionTaskRepository.summarizeOperationReceipts({
      tenantScope: task.tenantScope,
      taskId: task.taskId,
    });
  } catch {
    receiptSummary = null;
  }
  const zeroEffect = isSettledZeroEffectSummary(receiptSummary);
  const currentEvidenceDigest = fixtureEvidenceDigest({
    fixtureDelegate,
    receiptSummary,
    task,
    reasonCode: receiptSummary ? (zeroEffect ? "zero_effect" : "effect_reconcile_required") : "receipt_summary_unavailable",
  });
  const storedReceipt = controlRepository.getRunResultReceipt(binding.runId, {
    tenantScope: task.tenantScope,
  });
  let releasableReceipt = null;
  if (storedReceipt && zeroEffect && storedReceipt.outcome === "no_result_safe" &&
    storedReceipt.receiptEffectState === "settled" && storedReceipt.resultEvidenceDigest === null &&
    storedReceipt.operationReceiptEvidenceDigest === currentEvidenceDigest) {
    try {
      const terminalEvidence = projectScheduleRunTerminalEvidence({
        receipt: storedReceipt,
        canonicalTaskStatus: task.status,
      });
      if (task.terminalEvidenceDigest === terminalEvidence.terminalEvidenceDigest) {
        releasableReceipt = storedReceipt;
      }
    } catch {
      releasableReceipt = null;
    }
  }
  const result = controlRepository.finalizeRunExecution({
    tenantScope: task.tenantScope,
    runId: binding.runId,
    expectedIntentVersion: intent.intentVersion,
    expectedExecutionVersion: execution.executionVersion,
    ...dualLeaseIdentity(execution),
    canonicalTaskRevision: task.revision,
    canonicalTaskStatus: task.status,
    receiptEffectState: releasableReceipt ? "settled" : "reconcile_required",
    receiptEvidenceDigest: releasableReceipt
      ? releasableReceipt.operationReceiptEvidenceDigest
      : currentEvidenceDigest,
    resultReceiptDigest: releasableReceipt?.resultReceiptDigest || null,
    canonicalTerminalEvidenceDigest: task.terminalEvidenceDigest || null,
    finalizedAt: now,
  });
  return result.execution.executionState === "released" ? "settled" : "reconcile_required";
}

function convergeAgentTerminal({ binding, controlRepository, executionTaskRepository, scheduleTriggerRepository, now, task }) {
  const intent = controlRepository.getIntent(binding.runId, { tenantScope: task.tenantScope });
  if (!intent || ["cancel_requested", "terminal_observed"].includes(intent.intentState)) return "skipped";
  requireSameIntent(binding.intent, intent);
  const execution = controlRepository.getRunExecution(binding.runId, { tenantScope: task.tenantScope });
  if (!execution || execution.executionState === "skipped_admission") {
    controlRepository.observeExecutionTask({ tenantScope: task.tenantScope, runId: binding.runId,
      expectedIntentVersion: intent.intentVersion, taskStatus: task.status, observedAt: now });
    return "observed";
  }
  if (execution.executionState !== "active") return "skipped";
  const resolveEvidence = createScheduleAgentTerminalEvidenceResolver({ executionTaskRepository, scheduleTriggerRepository });
  const evidence = resolveEvidence({ tenantScope: task.tenantScope, taskId: task.taskId,
    employeeId: task.employeeId, activationSnapshotDigest: intent.activationSnapshotDigest,
    runConfigurationDigest: controlRepository.getRunConfiguration({ tenantScope: task.tenantScope, runId: intent.runId })?.configurationDigest });
  const result = controlRepository.finalizeRunExecution({
    tenantScope: task.tenantScope, runId: binding.runId,
    expectedIntentVersion: intent.intentVersion, expectedExecutionVersion: execution.executionVersion,
    ...dualLeaseIdentity(execution), canonicalTaskRevision: evidence.taskRevision, canonicalTaskStatus: evidence.taskStatus,
    receiptEffectState: evidence.effectState, receiptEvidenceDigest: evidence.operationReceiptEvidenceDigest,
    canonicalTerminalEvidenceDigest: evidence.terminalEvidenceDigest, finalizedAt: now,
  });
  return result.execution.executionState === "released" ? "settled" : "reconcile_required";
}

function convergeProductionTerminal({ binding, controlRepository, now, task }) {
  const intent = controlRepository.getIntent(binding.runId, { tenantScope: task.tenantScope });
  if (!intent || intent.intentState === "cancel_requested" || intent.intentState === "terminal_observed") {
    return "skipped";
  }
  requireSameIntent(binding.intent, intent);
  const execution = controlRepository.getRunExecution(binding.runId, { tenantScope: task.tenantScope });
  if (!execution || execution.executionState === "skipped_admission") {
    controlRepository.observeExecutionTask({
      tenantScope: task.tenantScope,
      runId: binding.runId,
      expectedIntentVersion: intent.intentVersion,
      taskStatus: task.status,
      observedAt: now,
    });
    return "observed";
  }
  if (execution.executionState === "cancel_requested" || execution.executionState !== "active") {
    return "skipped";
  }
  if (execution.executionPhase === "pre_effect") {
    const expectedEvidenceDigest = productionPreEffectEvidenceDigest({ binding, task });
    const releasable = task.status !== "completed" &&
      task.terminalEvidenceDigest === expectedEvidenceDigest;
    const result = controlRepository.finalizeRunExecution({
      tenantScope: task.tenantScope,
      runId: binding.runId,
      expectedIntentVersion: intent.intentVersion,
      expectedExecutionVersion: execution.executionVersion,
      ...dualLeaseIdentity(execution),
      canonicalTaskRevision: task.revision,
      canonicalTaskStatus: task.status,
      receiptEffectState: releasable ? "settled" : "reconcile_required",
      receiptEvidenceDigest: expectedEvidenceDigest,
      resultReceiptDigest: null,
      canonicalTerminalEvidenceDigest: task.terminalEvidenceDigest || null,
      finalizedAt: now,
    });
    return result.execution.executionState === "released" ? "settled" : "reconcile_required";
  }
  const receipt = controlRepository.getRunResultReceipt(binding.runId, {
    tenantScope: task.tenantScope,
  });
  let exactReceipt = null;
  if (receipt && task.terminalEvidenceDigest) {
    try {
      const projected = projectScheduleRunTerminalEvidence({
        receipt,
        canonicalTaskStatus: task.status,
      });
      if (projected.terminalEvidenceDigest === task.terminalEvidenceDigest) exactReceipt = receipt;
    } catch {
      exactReceipt = null;
    }
  }
  const reconcileEvidenceDigest = productionReconciliationDigest({ receipt, task });
  const result = controlRepository.finalizeRunExecution({
    tenantScope: task.tenantScope,
    runId: binding.runId,
    expectedIntentVersion: intent.intentVersion,
    expectedExecutionVersion: execution.executionVersion,
    ...dualLeaseIdentity(execution),
    canonicalTaskRevision: task.revision,
    canonicalTaskStatus: task.status,
    receiptEffectState: exactReceipt ? exactReceipt.receiptEffectState : "reconcile_required",
    receiptEvidenceDigest: exactReceipt
      ? exactReceipt.operationReceiptEvidenceDigest
      : reconcileEvidenceDigest,
    resultReceiptDigest: exactReceipt?.resultReceiptDigest || null,
    canonicalTerminalEvidenceDigest: task.terminalEvidenceDigest || null,
    finalizedAt: now,
  });
  return result.execution.executionState === "released" ? "settled" : "reconcile_required";
}

function resolveExactBinding(task, { controlRepository, scheduleTriggerRepository }) {
  if (!task?.executionInputRef || task.executionInputRef.kind !== "artifact_ref" ||
    typeof task.executionInputRef.refId !== "string" || !task.executionInputRef.refId) {
    throw lifecycleError("schedule_task_input_task_invalid");
  }
  const trigger = scheduleTriggerRepository.get(task.executionInputRef?.refId, { tenantScope: task.tenantScope });
  if (!trigger) throw lifecycleError("schedule_run_trigger_not_found");
  assertScheduleTaskTriggerMatch(task, trigger);
  const slotDigest = scheduleTriggerSlotDigest({
    tenantScope: trigger.tenantScope,
    employeeId: trigger.employeeId,
    scheduleId: trigger.scheduleId,
    scheduledFor: trigger.scheduledFor, manualRequestDigest: trigger.manualRequestDigest,
  });
  const runId = `schedule_run_${slotDigest}`;
  if (trigger.triggerId !== `schedule_trigger_${slotDigest}` || task.taskId !== `task_${slotDigest}`) {
    throw lifecycleError("schedule_run_deterministic_identity_mismatch");
  }
  const intent = controlRepository.getIntent(runId, { tenantScope: task.tenantScope });
  if (!intent) throw lifecycleError("schedule_run_intent_not_found");
  const binding = { intent, runId, task, trigger };
  requireIntentBinding(binding);
  return binding;
}

function requireIntentBinding({ intent, task, trigger, runId }) {
  const matches = typeof intent.activationSnapshotId === "string" && intent.activationSnapshotId.length > 0 &&
    /^[a-f0-9]{64}$/.test(intent.activationSnapshotDigest || "") &&
    intent.runId === runId && intent.tenantScope === trigger.tenantScope &&
    intent.employeeId === trigger.employeeId && intent.scheduleId === trigger.scheduleId &&
    intent.scheduleVersion === trigger.scheduleVersion && intent.schedulePolicyDigest === trigger.schedulePolicyDigest &&
    intent.executionContractDigest === trigger.executionContractDigest && intent.scheduledFor === trigger.scheduledFor && intent.manualRequestDigest === trigger.manualRequestDigest &&
    intent.expectedTriggerId === trigger.triggerId && intent.expectedExecutionTaskId === task.taskId &&
    intent.executionTaskId === task.taskId;
  if (!matches) throw lifecycleError("schedule_run_intent_binding_mismatch");
}

function requireSameIntent(expected, actual) {
  if (!actual || expected.runId !== actual.runId || expected.tenantScope !== actual.tenantScope ||
    expected.employeeId !== actual.employeeId || expected.scheduleId !== actual.scheduleId ||
    expected.activationVersion !== actual.activationVersion ||
    expected.activationSnapshotId !== actual.activationSnapshotId ||
    expected.activationSnapshotDigest !== actual.activationSnapshotDigest ||
    expected.scheduleVersion !== actual.scheduleVersion ||
    expected.schedulePolicyDigest !== actual.schedulePolicyDigest ||
    expected.executionContractDigest !== actual.executionContractDigest ||
    expected.expectedTriggerId !== actual.expectedTriggerId ||
    expected.expectedExecutionTaskId !== actual.expectedExecutionTaskId ||
    expected.executionTaskId !== actual.executionTaskId || expected.scheduledFor !== actual.scheduledFor) {
    throw lifecycleError("schedule_run_intent_binding_mismatch");
  }
}

function requireSameBinding(expected, actual) {
  requireSameIntent(expected.intent, actual.intent);
  if (expected.runId !== actual.runId || expected.task.taskId !== actual.task.taskId ||
    expected.trigger.triggerId !== actual.trigger.triggerId) {
    throw lifecycleError("schedule_run_binding_changed");
  }
}

function requireCurrentControl(binding, controlRepository) {
  const control = controlRepository.getControl({
    tenantScope: binding.intent.tenantScope,
    employeeId: binding.intent.employeeId,
    scheduleId: binding.intent.scheduleId,
  });
  const current = control && (control.activationState === "active" || (binding.intent.manualRequestDigest && control.activationState === "paused")) && !control.emergencyStop.active &&
    control.activationVersion === binding.intent.activationVersion &&
    control.activationSnapshotId === binding.intent.activationSnapshotId &&
    control.activationSnapshotDigest === binding.intent.activationSnapshotDigest &&
    control.scheduleVersion === binding.intent.scheduleVersion &&
    control.schedulePolicyDigest === binding.intent.schedulePolicyDigest &&
    control.executionContractDigest === binding.intent.executionContractDigest;
  if (!current) throw lifecycleError("schedule_run_control_not_active");
}

function requireSameCanonicalTaskLease(expected, actual) {
  const same = actual?.status === "running" && actual.taskId === expected.taskId &&
    actual.tenantScope === expected.tenantScope && actual.employeeId === expected.employeeId &&
    actual.executionDeadlineAt === expected.executionDeadlineAt && actual.lease && expected.lease &&
    actual.lease.leaseId === expected.lease.leaseId &&
    actual.lease.workerIdDigest === expected.lease.workerIdDigest &&
    actual.lease.fencingToken === expected.lease.fencingToken;
  if (!same) throw lifecycleError("schedule_run_task_lease_lost");
}

function requireCurrentCanonicalTaskLease(expected, trigger, executionTaskRepository) {
  const current = executionTaskRepository.get(expected.taskId, { tenantScope: expected.tenantScope });
  requireSameCanonicalTaskLease(expected, current);
  assertScheduleTaskTriggerMatch(current, trigger);
  if (current.lease.expiresAt !== expected.lease.expiresAt || current.revision !== expected.revision) {
    throw lifecycleError("schedule_run_task_lease_lost");
  }
}

function startRunHeartbeat({
  abort,
  controlRepository,
  executionTaskRepository,
  heartbeatIntervalMs,
  isCancellationRequested,
  now,
  runLeaseDurationMs,
  state,
  task,
}) {
  if (heartbeatIntervalMs === 0) return null;
  const timer = setInterval(() => {
    if (isCancellationRequested()) {
      stopHeartbeat(timer);
      abort("schedule_run_canceled");
      return;
    }
    try {
      const currentTask = executionTaskRepository.get(task.taskId, { tenantScope: task.tenantScope });
      if (!sameCanonicalLease(state.execution, currentTask)) throw lifecycleError("schedule_run_task_lease_lost");
      const renewed = controlRepository.renewRunExecution({
        tenantScope: task.tenantScope,
        runId: state.binding.runId,
        ...dualLeaseIdentity(state.execution),
        taskLeaseExpiresAt: currentTask.lease.expiresAt,
        leaseDurationMs: runLeaseDurationMs,
        now: now(),
      });
      if (!renewed) throw lifecycleError("schedule_run_lease_lost");
      state.execution = renewed;
    } catch {
      stopHeartbeat(timer);
      abort("schedule_run_ownership_lost");
    }
  }, heartbeatIntervalMs);
  timer.unref?.();
  return timer;
}

function runClaimIdentity(binding, task) {
  return {
    tenantScope: task.tenantScope,
    employeeId: task.employeeId,
    scheduleId: binding.intent.scheduleId,
    runId: binding.runId,
    executionTaskId: task.taskId,
    expectedIntentVersion: binding.intent.intentVersion,
    activationVersion: binding.intent.activationVersion,
  };
}

function canonicalTaskLease(task) {
  if (task?.status !== "running" || !task.lease) throw lifecycleError("schedule_run_task_lease_required");
  return {
    taskLeaseId: task.lease.leaseId,
    taskOwnerDigest: task.lease.workerIdDigest,
    taskFencingToken: task.lease.fencingToken,
    taskLeaseExpiresAt: task.lease.expiresAt,
  };
}

function dualLeaseIdentity(execution) {
  return {
    leaseId: execution.leaseId,
    ownerDigest: execution.ownerDigest,
    fencingToken: execution.fencingToken,
    taskLeaseId: execution.taskLeaseId,
    taskOwnerDigest: execution.taskOwnerDigest,
    taskFencingToken: execution.taskFencingToken,
  };
}

function sameCanonicalLease(execution, task) {
  return Boolean(execution && task?.status === "running" && task.lease &&
    execution.taskLeaseId === task.lease.leaseId &&
    execution.taskOwnerDigest === task.lease.workerIdDigest &&
    execution.taskFencingToken === task.lease.fencingToken);
}

function canTakeOverPreEffect(execution, task, now) {
  const current = new Date(now).toISOString();
  return Boolean(execution?.executionState === "active" && execution.executionPhase === "pre_effect" &&
    execution.leaseExpiresAt && execution.leaseExpiresAt <= current && task?.lease &&
    task.lease.fencingToken > execution.taskFencingToken);
}

function requireSameClaimedTask(expected, actual, lease) {
  if (!actual || actual.taskId !== expected.taskId || actual.tenantScope !== expected.tenantScope ||
    actual.employeeId !== expected.employeeId || !actual.lease || lease?.leaseId !== actual.lease.leaseId ||
    lease?.workerIdDigest !== actual.lease.workerIdDigest || lease?.fencingToken !== actual.lease.fencingToken) {
    throw lifecycleError("schedule_run_worker_ownership_invalid");
  }
}

function normalizeExecutionAdapter({ fixtureDelegate, productionAdapter }) {
  if (Boolean(fixtureDelegate) === Boolean(productionAdapter)) {
    throw new TypeError("schedule run lifecycle requires exactly one execution adapter");
  }
  return fixtureDelegate
    ? normalizeFixtureDelegate(fixtureDelegate)
    : normalizeProductionAdapter(productionAdapter);
}

function normalizeFixtureDelegate(value) {
  const fields = [
    "adapterKind",
    "contractVersion",
    "network",
    "productionEffect",
    "providerAccess",
    "resolvePersistentTaskExecutor",
    "skillAccess",
    "toolAccess",
    "writeback",
  ];
  if (!value || typeof value !== "object" || Array.isArray(value) || !exactKeys(value, fields) ||
    value.contractVersion !== SCHEDULE_RUN_FIXTURE_DELEGATE_CONTRACT_VERSION ||
    value.adapterKind !== "fixture_only" || value.network !== "disabled" ||
    value.productionEffect !== "none" || value.providerAccess !== "none" ||
    value.skillAccess !== "none" || value.toolAccess !== "none" || value.writeback !== "none" ||
    typeof value.resolvePersistentTaskExecutor !== "function") {
    throw new TypeError("schedule run lifecycle requires a fixture-only zero-effect delegate");
  }
  return Object.freeze({ ...value });
}

function normalizeProductionAdapter(value) {
  if (value?.adapterKind === "shared_agent_runtime") {
    if (!exactKeys(value, ["contractVersion", "adapterKind", "execute"]) ||
      value.contractVersion !== SCHEDULE_RUN_AGENT_ADAPTER_CONTRACT_VERSION || typeof value.execute !== "function") {
      throw new TypeError("schedule run lifecycle requires a shared Agent adapter");
    }
    return Object.freeze({ ...value });
  }
  const fields = [
    "acquireInput",
    "adapterKind",
    "contractVersion",
    "executeResult",
    "network",
    "productionEffect",
    "providerAccess",
    "recoverResult",
    "skillAccess",
    "toolAccess",
    "writeback",
  ];
  if (!value || typeof value !== "object" || Array.isArray(value) || !exactKeys(value, fields) ||
    value.contractVersion !== SCHEDULE_RUN_PROVIDER_RESULT_ADAPTER_CONTRACT_VERSION ||
    value.adapterKind !== "provider_result" || value.network !== "provider_only" ||
    value.productionEffect !== "canonical_provider_attempt" ||
    value.providerAccess !== "canonical_attempt_receipt" || value.skillAccess !== "none" ||
    value.toolAccess !== "none" || value.writeback !== "none" ||
    typeof value.acquireInput !== "function" || typeof value.executeResult !== "function" ||
    typeof value.recoverResult !== "function") {
    throw new TypeError("schedule run lifecycle requires a governed Provider-result adapter");
  }
  return Object.freeze({ ...value });
}

function productionRequest(state) {
  return Object.freeze({
    canonicalTaskId: state.binding.task.taskId,
    runId: state.binding.runId,
    tenantScope: state.binding.intent.tenantScope,
  });
}

function requireInputAcquisitionResult(value) {
  const fields = ["contractVersion", "evidence", "outcome"];
  const evidenceFields = ["contractVersion", "evidenceDigest", "inputSnapshotRef", "sealedAt", "state"];
  const evidence = value?.evidence;
  const valid = value && typeof value === "object" && !Array.isArray(value) && exactKeys(value, fields) &&
    value.contractVersion === "schedule-task-input-acquisition-result.v1" &&
    new Set(["captured", "reused"]).has(value.outcome) && evidence &&
    typeof evidence === "object" && !Array.isArray(evidence) && exactKeys(evidence, evidenceFields) &&
    evidence.contractVersion === "schedule-task-input-snapshot-evidence.v2" &&
    evidence.state === "sealed" && /^[a-f0-9]{64}$/.test(evidence.evidenceDigest || "") &&
    /^schedule_task_input_snapshot_[a-f0-9]{64}$/.test(evidence.inputSnapshotRef || "") &&
    Number.isFinite(Date.parse(evidence.sealedAt || ""));
  if (!valid) throw lifecycleError("schedule_run_input_acquisition_invalid");
}

function normalizeProductionSettlement(value) {
  const requested = value?.settlement;
  const status = requested?.status;
  const terminalEvidenceDigest = requested?.terminalEvidenceDigest;
  const valid = requested && typeof requested === "object" && !Array.isArray(requested) &&
    new Set(["blocked", "completed", "failed"]).has(status) &&
    /^[a-f0-9]{64}$/.test(terminalEvidenceDigest || "") &&
    (requested.lastErrorCode === null || requested.lastErrorCode === undefined ||
      /^[a-z0-9][a-z0-9._:-]{0,119}$/.test(requested.lastErrorCode)) &&
    typeof requested.resultSummary === "string" && requested.resultSummary.length > 0 &&
    requested.resultSummary.length <= 500;
  if (!valid) throw lifecycleError("schedule_run_provider_result_settlement_invalid");
  return Object.freeze({
    settlement: Object.freeze({
      status,
      lastErrorCode: requested.lastErrorCode ?? null,
      resultSummary: requested.resultSummary,
      terminalEvidenceDigest,
    }),
  });
}

function productionReconciliationDigest({ receipt, task }) {
  return crypto.createHash("sha256").update(JSON.stringify([
    "schedule-run-provider-result-reconciliation.v1",
    task.tenantScope,
    task.taskId,
    task.revision,
    task.status,
    task.terminalEvidenceDigest || null,
    receipt?.resultReceiptDigest || null,
    receipt?.receiptEffectState || null,
    receipt?.operationReceiptEvidenceDigest || null,
    receipt?.outcome || null,
  ])).digest("hex");
}

function productionPreEffectEvidenceDigest({ binding, task }) {
  return crypto.createHash("sha256").update(JSON.stringify([
    "schedule-run-production-pre-effect-evidence.v1",
    binding.intent.tenantScope,
    binding.runId,
    binding.intent.activationSnapshotId,
    binding.intent.activationSnapshotDigest,
    task.taskId,
    "provider_effect_not_prepared",
  ])).digest("hex");
}

function productionPreEffectBlockedSettlement(state, task, lastErrorCode) {
  return blockedSettlement(lastErrorCode, productionPreEffectEvidenceDigest({
    binding: state.binding,
    task,
  }));
}

function runRemainsPreEffect({ controlRepository, state }) {
  try {
    const current = controlRepository.getRunExecution(state.binding.runId, {
      tenantScope: state.binding.intent.tenantScope,
    });
    return current?.executionState === "active" && current.executionPhase === "pre_effect" &&
      current.executionTaskId === state.binding.task.taskId;
  } catch {
    return false;
  }
}

function isSettledZeroEffectSummary(value) {
  return Boolean(value && value.effectState === "settled" && value.total === 0 &&
    value.prepared === 0 && value.succeeded === 0 && value.definitiveFailed === 0 && value.unknown === 0 &&
    /^[a-f0-9]{64}$/.test(value.evidenceDigest || ""));
}

function fixtureEvidenceDigest({ fixtureDelegate, receiptSummary, task, reasonCode }) {
  return crypto.createHash("sha256").update(JSON.stringify([
    SCHEDULE_RUN_ZERO_EFFECT_EVIDENCE_CONTRACT_VERSION,
    fixtureDelegate.contractVersion,
    fixtureDelegate.adapterKind,
    fixtureDelegate.network,
    fixtureDelegate.productionEffect,
    fixtureDelegate.providerAccess,
    fixtureDelegate.skillAccess,
    fixtureDelegate.toolAccess,
    fixtureDelegate.writeback,
    task.tenantScope,
    task.taskId,
    reasonCode,
    receiptSummary?.total ?? null,
    receiptSummary?.prepared ?? null,
    receiptSummary?.succeeded ?? null,
    receiptSummary?.definitiveFailed ?? null,
    receiptSummary?.unknown ?? null,
    receiptSummary?.effectState ?? null,
    receiptSummary?.evidenceDigest ?? null,
  ])).digest("hex");
}

function cancellationRequested(ownership) {
  return ownership?.signal?.aborted === true || ownership?.isCancellationRequested?.() === true;
}

function blockedSettlement(lastErrorCode, terminalEvidenceDigest = null) {
  const settlement = {
    status: "blocked",
    lastErrorCode,
    resultSummary: "Schedule run stopped at a governed execution boundary.",
  };
  if (terminalEvidenceDigest) settlement.terminalEvidenceDigest = terminalEvidenceDigest;
  return {
    settlement: {
      ...settlement,
    },
  };
}

function isScheduleNamespaceTask(task) {
  return Boolean(task && typeof task === "object" && !Array.isArray(task) &&
    task.channelId === "schedule" && task.sourceSystemId === "digital-workforce-scheduler" &&
    task.taskType === "scheduled_employee_task");
}

function stopHeartbeat(timer) {
  if (timer) clearInterval(timer);
}

function exactKeys(value, fields) {
  const expected = [...fields].sort();
  const actual = Object.keys(value).sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function assertDependencies({
  controlRepository,
  executionTaskRepository,
  heartbeatIntervalMs,
  now,
  runLeaseDurationMs,
  runOwnerDigest,
  scheduleTriggerRepository,
}) {
  for (const method of [
    "claimRunExecution",
    "finalizeRunExecution",
    "getControl",
    "getIntent",
    "getRunExecution",
    "getRunResultReceipt",
    "guardRunExecutionEffectDispatch",
    "listIncompleteIntents",
    "observeExecutionTask",
    "prepareRunExecutionEffectDispatch",
    "recordRunResultReceipt",
    "rebindPreEffectRunExecution",
    "renewRunExecution",
  ]) {
    if (typeof controlRepository?.[method] !== "function") throw new TypeError(`schedule run lifecycle requires controlRepository.${method}`);
  }
  for (const method of ["get", "summarizeOperationReceipts"]) {
    if (typeof executionTaskRepository?.[method] !== "function") throw new TypeError(`schedule run lifecycle requires executionTaskRepository.${method}`);
  }
  if (typeof scheduleTriggerRepository?.get !== "function") throw new TypeError("schedule run lifecycle requires scheduleTriggerRepository.get");
  if (typeof now !== "function") throw new TypeError("schedule run lifecycle requires now");
  if (!Number.isSafeInteger(heartbeatIntervalMs) || heartbeatIntervalMs < 0) throw new TypeError("schedule run heartbeatIntervalMs is invalid");
  if (!Number.isSafeInteger(runLeaseDurationMs) || runLeaseDurationMs < 1) throw new TypeError("schedule run runLeaseDurationMs is invalid");
  if (!/^[a-f0-9]{64}$/.test(String(runOwnerDigest || ""))) throw new TypeError("schedule run runOwnerDigest is invalid");
}

function lifecycleError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

export {
  SCHEDULE_RUN_EXECUTION_GUARD_CONTRACT_VERSION,
  SCHEDULE_RUN_EXECUTION_LIFECYCLE_CONTRACT_VERSION,
  SCHEDULE_RUN_FIXTURE_DELEGATE_CONTRACT_VERSION,
  SCHEDULE_RUN_ZERO_EFFECT_EVIDENCE_CONTRACT_VERSION,
  createScheduleRunExecutionLifecycle,
};
