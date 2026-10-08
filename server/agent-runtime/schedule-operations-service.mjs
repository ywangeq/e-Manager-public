import { projectScheduleActivationReadiness } from "./schedule-activation-readiness-projector.mjs";

const SCHEDULE_OPERATIONS_CONTRACT_VERSION = "digital-employee-schedule-operations.v1";
const SCHEDULE_RUNS_CONTRACT_VERSION = "digital-employee-schedule-runs.v1";
const PROVIDER_TRIAL_SOURCE_SYSTEM_ID = "digital-workforce-schedule-provider-trial";
const PROVIDER_TRIAL_CHANNEL_ID = "schedule";
const PROVIDER_TRIAL_TASK_TYPE = "schedule_provider_trial";
const CANCELLATION_STATUS_CONTRACT_VERSION = "digital-employee-schedule-cancellation.v1";
const EMERGENCY_STOP_COMMAND_CONTRACT_VERSION = "digital-employee-schedule-emergency-stop.v1";
const STALE_ACTIVATION_GOVERNANCE_CODES = new Set([
  "schedule_control_activation_owner_acceptance_v2_required",
  "schedule_control_activation_owner_acceptance_not_current",
  "schedule_control_activation_owner_acceptance_proof_mismatch",
  "schedule_control_activation_processing_authority_mismatch",
  "schedule_control_activation_snapshot_binding_mismatch",
]);
const CURRENT_ACTIVATION_CAPABILITY_MANIFEST = Object.freeze({
  runLedger: true,
  workerLifecycle: false,
  scannerCoordinator: false,
  resultParserAlerting: false,
  continuousStopDispatcher: false,
});

function createScheduleOperationsService({
  activationCapabilityManifest = CURRENT_ACTIVATION_CAPABILITY_MANIFEST,
  controlRepository,
  dryRunRepository = null,
  getCanonicalTask = null,
  listTaskArtifacts = null,
  getRegisteredSchedule,
  resolveCurrentDispatch = null,
  wakeCancellation = null,
  now = () => new Date(),
} = {}) {
  if (typeof controlRepository?.getControl !== "function" ||
    typeof controlRepository?.initializeRegisteredControl !== "function" ||
    typeof controlRepository?.listRunIntents !== "function" ||
    typeof controlRepository?.summarizeRuns !== "function") {
    throw new TypeError("schedule operations service requires a Schedule control repository");
  }
  if (typeof getRegisteredSchedule !== "function") {
    throw new TypeError("schedule operations service requires getRegisteredSchedule");
  }
  if (wakeCancellation !== null && typeof wakeCancellation !== "function") {
    throw new TypeError("schedule operations service wakeCancellation must be a function");
  }

  function getOperations({ tenantScope, employeeId, scheduleId, currentActor } = {}) {
    const context = resolveContext({ tenantScope, employeeId, scheduleId });
    return projectOperations({ ...context, currentActor });
  }

  function assertProviderTrialAllowed({
    tenantScope,
    employeeId,
    scheduleId,
    expectedRegistrationVersion,
    expectedScheduleVersion = null,
    expectedSchedulePolicyDigest = null,
    expectedExecutionContractDigest = null,
    expectedTaskBindingDigest = null,
  } = {}) {
    const context = resolveContext({ tenantScope, employeeId, scheduleId });
    if (!context.bindingCurrent) throw serviceError("schedule_operations_control_binding_stale");
    if (context.control.activationState !== "registered" || context.control.emergencyStop.active) {
      throw serviceError("schedule_operations_provider_trial_blocked");
    }
    if (boundedInteger(expectedRegistrationVersion, 1, Number.MAX_SAFE_INTEGER, "expectedRegistrationVersion") !==
      context.schedule.registrationVersion) {
      throw serviceError("schedule_operations_registration_version_conflict");
    }
    let currentDispatch = null;
    try {
      currentDispatch = typeof resolveCurrentDispatch === "function"
        ? resolveCurrentDispatch(context.identity)
        : null;
    } catch {
      currentDispatch = null;
    }
    if (!dispatchMatchesSchedule(currentDispatch, context.schedule)) {
      throw serviceError("schedule_operations_provider_trial_binding_stale");
    }
    const expectedSnapshot = [
      [expectedScheduleVersion, currentDispatch.scheduleVersion],
      [expectedSchedulePolicyDigest, currentDispatch.schedulePolicyDigest],
      [expectedExecutionContractDigest, currentDispatch.executionContractDigest],
      [expectedTaskBindingDigest, currentDispatch.taskModelBinding?.bindingDigest],
    ];
    if (expectedSnapshot.some(([expected, current]) => expected !== null && expected !== current)) {
      throw serviceError("schedule_operations_provider_trial_binding_stale");
    }
    return Object.freeze({ registrationVersion: context.schedule.registrationVersion });
  }

  // Internal-only resolution after the route's system-Schedule admin check.
  function resolveRunTask({ tenantScope, employeeId, scheduleId, runId } = {}) {
    const { identity } = resolveContext({ tenantScope, employeeId, scheduleId });
    const intent = controlRepository.getIntent(runId, { tenantScope: identity.tenantScope });
    const execution = controlRepository.getRunExecution(runId, { tenantScope: identity.tenantScope });
    if (!intent || intent.employeeId !== identity.employeeId || intent.scheduleId !== identity.scheduleId ||
      !execution || execution.executionTaskId !== intent.expectedExecutionTaskId) return null;
    const task = getCanonicalTask?.(execution.executionTaskId, { tenantScope: identity.tenantScope });
    if (!task || task.taskId !== execution.executionTaskId || task.tenantScope !== identity.tenantScope ||
      task.employeeId !== identity.employeeId || task.channelId !== "schedule" || task.sessionId !== null ||
      task.sourceSystemId !== "digital-workforce-scheduler" || task.taskType !== "scheduled_employee_task") return null;
    return task;
  }

  function listRuns({ tenantScope, employeeId, scheduleId, beforeScheduledFor = null, limit = 20 } = {}) {
    const context = resolveContext({ tenantScope, employeeId, scheduleId });
    const safeLimit = boundedInteger(limit, 1, 50, "limit");
    const intents = controlRepository.listRunIntents({
      tenantScope: context.identity.tenantScope,
      employeeId: context.identity.employeeId,
      scheduleId: context.identity.scheduleId,
      beforeScheduledFor,
      limit: safeLimit,
    });
    const runs = intents.map((intent) => {
      const execution = controlRepository.getRunExecution(intent.runId, {
        tenantScope: context.identity.tenantScope,
      });
      return Object.freeze({
        runId: intent.runId,
        intentVersion: intent.intentVersion,
        scheduledFor: intent.scheduledFor,
        source: intent.manualRequestDigest ? "manual" : "cron",
        state: intent.intentState,
        observedTaskStatus: intent.observedTaskStatus,
        lastErrorCode: intent.lastErrorCode,
        preparedAt: intent.preparedAt,
        submittedAt: intent.submittedAt,
        reconciledAt: intent.reconciledAt,
        terminalAt: intent.terminalAt,
        artifacts: (() => {
          if (!listTaskArtifacts) return [];
          const task = resolveRunTask({ ...context.identity, runId: intent.runId });
          return task?.status === "completed" ? listTaskArtifacts({ tenantScope: task.tenantScope, taskId: task.taskId }) : [];
        })(),
        execution: execution ? Object.freeze({
          state: execution.executionState,
          admissionOutcome: execution.admissionOutcome,
          observedTaskStatus: execution.observedTaskStatus,
          executionTaskId: execution.executionTaskId,
          claimedAt: execution.claimedAt,
          reconcileBlockedAt: execution.reconcileBlockedAt,
          releasedAt: execution.releasedAt,
        }) : null,
      });
    });
    return deepFreeze({
      contractVersion: SCHEDULE_RUNS_CONTRACT_VERSION,
      schedule: scheduleReference(context.schedule),
      runs,
      nextBeforeScheduledFor: runs.length === safeLimit ? runs.at(-1).scheduledFor : null,
    });
  }

  function setEmergencyStop({
    tenantScope,
    employeeId,
    scheduleId,
    expectedControlVersion,
    engaged,
    reasonCode,
    safeReason,
    actor,
  } = {}) {
    if (typeof engaged !== "boolean") throw serviceError("schedule_operations_emergency_stop_value_invalid");
    const context = resolveEmergencyStopContext({ tenantScope, employeeId, scheduleId });
    const previousControl = context.control;
    const input = {
      ...context.identity,
      expectedControlVersion: boundedInteger(expectedControlVersion, 1, Number.MAX_SAFE_INTEGER, "expectedControlVersion"),
      reasonCode,
      safeReason,
      actor,
    };
    let committedControl;
    if (engaged) {
      const state = previousControl.activationState;
      const activeStopAvailable = state !== "active" || activationCapabilityManifest.continuousStopDispatcher === true;
      if (!["registered", "active", "paused"].includes(state) || !activeStopAvailable) {
        throw serviceError("schedule_operations_cancellation_dispatch_unavailable");
      }
      committedControl = controlRepository.emergencyStop({ ...input, stoppedAt: nowTimestamp() }).control;
      try {
        const wakeResult = wakeCancellation?.();
        if (wakeResult && typeof wakeResult.then === "function") {
          Promise.resolve(wakeResult).catch(() => {});
        }
      } catch {
        // The durable stop and outbox remain authoritative when the wake hint is unavailable.
      }
    } else {
      if (!context.bindingCurrent) throw serviceError("schedule_operations_control_binding_stale");
      if (previousControl.activationState !== "registered" && previousControl.activationState !== "paused") {
        throw serviceError("schedule_operations_cancellation_dispatch_unavailable");
      }
      const cancellation = projectCancellation(previousControl, context.identity);
      if (previousControl.emergencyStop.active && cancellation.state !== "settled") {
        throw serviceError("schedule_operations_cancellation_not_settled");
      }
      committedControl = controlRepository.clearEmergencyStop({ ...input, clearedAt: nowTimestamp() });
    }
    return projectEmergencyStopCommand({
      actor,
      committedControl,
      context,
      commandState: engaged
        ? previousControl.emergencyStop.active ? "stop_already_engaged" : "stop_committed"
        : previousControl.emergencyStop.active ? "clear_committed" : "clear_already_inactive",
    });
  }

  function resolveEmergencyStopContext({ tenantScope, employeeId, scheduleId }) {
    const identity = {
      tenantScope: identifier(tenantScope, "tenantScope"),
      employeeId: identifier(employeeId, "employeeId"),
      scheduleId: identifier(scheduleId, "scheduleId"),
    };
    let schedule = null;
    try {
      schedule = getRegisteredSchedule(identity);
    } catch {
      schedule = null;
    }
    const validSchedule = schedule && schedule.tenantScope === identity.tenantScope &&
      schedule.employeeId === identity.employeeId && schedule.id === identity.scheduleId &&
      schedule.registrationStatus === "applied" ? schedule : null;
    let control = controlRepository.getControl(identity);
    if (!control && validSchedule) {
      control = initializeControl(identity, validSchedule);
    }
    if (!control) throw serviceError("schedule_operations_schedule_not_found");
    return {
      bindingCurrent: Boolean(validSchedule && controlMatchesSchedule(control, validSchedule)),
      control,
      identity,
      schedule: validSchedule,
    };
  }

  function resolveContext({ tenantScope, employeeId, scheduleId }) {
    const identity = {
      tenantScope: identifier(tenantScope, "tenantScope"),
      employeeId: identifier(employeeId, "employeeId"),
      scheduleId: identifier(scheduleId, "scheduleId"),
    };
    const schedule = getRegisteredSchedule(identity);
    if (!schedule || schedule.tenantScope !== identity.tenantScope || schedule.employeeId !== identity.employeeId ||
      schedule.id !== identity.scheduleId || schedule.registrationStatus !== "applied") {
      throw serviceError("schedule_operations_schedule_not_found");
    }
    const control = initializeControl(identity, schedule);
    if (!control) throw serviceError("schedule_operations_control_unavailable");
    return {
      bindingCurrent: controlMatchesSchedule(control, schedule),
      control,
      identity,
      schedule,
    };
  }

  function initializeControl(identity, schedule) {
    let control = controlRepository.getControl(identity);
    if (control) return control;
    try {
      control = controlRepository.initializeRegisteredControl({
        ...identity,
        expectedControlVersion: 0,
        registrationVersion: schedule.registrationVersion,
        scheduleVersion: schedule.scheduleVersion,
        schedulePolicyDigest: schedule.schedulePolicyDigest,
        executionContractDigest: schedule.executionContractDigest,
        maxConcurrentRuns: schedule.maxConcurrentRuns,
        overlapWindowMinutes: schedule.overlapWindowMinutes,
        initializedAt: nowTimestamp(),
      });
    } catch (error) {
      if (error?.code !== "schedule_control_version_conflict") throw error;
      control = controlRepository.getControl(identity);
    }
    return control;
  }

  function projectOperations({ bindingCurrent, control, identity, schedule, currentActor }) {
    const events = controlRepository.listControlEvents({ ...identity, limit: 20 });
    const runSummary = controlRepository.summarizeRuns(identity);
    const engageEvent = control.emergencyStop.active
      ? events.find((event) => event.eventType === "emergency_stop_engaged") || null
      : null;
    const cursorState = control.activationState === "registered"
      ? "uninitialized"
      : control.activationState === "active" ? "active" : control.activationState;
    const executionBlocked = hasExecutionBlockersInSummary(runSummary);
    const scheduleLedgerBlocked = hasPendingScheduleLedgerInSummary(runSummary);
    const preActivationControlAvailable = bindingCurrent && control.activationState === "registered" && !executionBlocked;
    const activationGovernance = projectActivationGovernance({ bindingCurrent, control, identity });
    const agentMode = schedule.executionMode === "shared_agent_runtime";
    const runtimeWired = agentMode && ["runLedger", "workerLifecycle", "scannerCoordinator", "continuousStopDispatcher"]
      .every(key => activationCapabilityManifest[key] === true);
    const providerDryRun = agentMode ? null : projectProviderDryRun(identity, schedule);
    const providerTrialInFlightOrBlocked = providerDryRun?.gate.state === "blocked";
    const cancellation = projectCancellation(control, identity);
    const engageStateAvailable = control.activationState === "registered" || control.activationState === "paused" ||
      (control.activationState === "active" && activationCapabilityManifest.continuousStopDispatcher === true);
    const clearStateAvailable = control.activationState === "registered" || control.activationState === "paused";
    // Agent activation has no Provider trial/owner-acceptance/parser workflow.
    // Configuration admission is supplied by the management service separately.
    const activationReadiness = agentMode ? null : projectScheduleActivationReadiness({
      bindingCurrent,
      capabilityManifest: activationCapabilityManifest,
      control,
      evaluatedAt: nowTimestamp(),
      providerDryRun,
      runSummary,
      schedule,
    });
    return deepFreeze({
      contractVersion: SCHEDULE_OPERATIONS_CONTRACT_VERSION,
      schedule: scheduleReference(schedule),
      controlVersion: control.controlVersion,
      registrationBinding: {
        state: bindingCurrent ? "current" : "stale",
        controlRegistrationVersion: control.registrationVersion,
        currentRegistrationVersion: schedule.registrationVersion,
      },
      activation: {
        state: control.activationState,
        configuredActive: control.effectiveActive,
        governance: activationGovernance,
        effectiveActive: Boolean(control.effectiveActive && activationGovernance.state === "current" && runtimeWired),
        runtimeWired,
        canActivate: false,
      },
      cursor: {
        state: cursorState,
        policy: schedule.missedSlotPolicy,
        initializedAt: control.activatedAt,
        cursorAfter: control.cursorAfter,
        nextScanAt: control.nextScanAt,
        initializationRule: "initialize_at_activation_no_backfill",
      },
      emergencyStop: {
        active: control.emergencyStop.active,
        version: control.emergencyStop.version,
        reasonCode: control.emergencyStop.reasonCode,
        safeReason: engageEvent?.safeReason || null,
        stoppedAt: control.emergencyStop.stoppedAt,
        actor: engageEvent?.actor || null,
      },
      cancellation,
      runSummary,
      providerDryRun,
      activationReadiness,
      recentControlEvents: events.map(projectControlEvent),
      allowedActions: {
        canEngageEmergencyStop: engageStateAvailable && !control.emergencyStop.active,
        canClearEmergencyStop: bindingCurrent && clearStateAvailable && control.emergencyStop.active &&
          cancellation.state === "settled" && !scheduleLedgerBlocked,
        canActivate: false,
        canRunProviderDryRun: !agentMode && Boolean(dryRunRepository && getCanonicalTask) &&
          preActivationControlAvailable && !control.emergencyStop.active && !providerTrialInFlightOrBlocked,
      },
      currentActor: normalizePublicActor(currentActor),
    });
  }

  function projectCancellation(control, identity) {
    const emptyCounts = { pending: 0, awaitingTerminal: 0, reconcileRequired: 0, settled: 0 };
    if (!control.emergencyStop.active) {
      return Object.freeze({
        contractVersion: CANCELLATION_STATUS_CONTRACT_VERSION,
        state: "not_requested",
        reasonCode: null,
        counts: Object.freeze(emptyCounts),
      });
    }
    try {
      const pending = controlRepository.listCancelOutbox({
        ...identity,
        state: "pending",
        limit: 500,
      });
      const dispatched = controlRepository.listCancelOutbox({
        ...identity,
        state: "dispatched",
        limit: 500,
      });
      if (!Array.isArray(pending) || !Array.isArray(dispatched)) {
        throw serviceError("schedule_operations_cancellation_projection_unavailable");
      }
      const allRows = [...pending, ...dispatched];
      const rows = allRows.filter((row) => cancellationMatchesCurrentStop({
        control,
        identity,
        row,
      }));
      const historicalUnsettled = allRows.some((row) => cancellationMatchesSchedule(identity, row) &&
        row.emergencyStopVersion !== control.emergencyStop.version && row.reconcileState !== "settled");
      const counts = rows.reduce((summary, row) => {
        if (row.reconcileState === "reconcile_required") summary.reconcileRequired += 1;
        else if (row.reconcileState === "settled") summary.settled += 1;
        else if (row.reconcileState === "pending" && row.state === "pending") summary.pending += 1;
        else if (row.reconcileState === "pending" && row.state === "dispatched") summary.awaitingTerminal += 1;
        else summary.reconcileRequired += 1;
        return summary;
      }, { ...emptyCounts });
      const projectionTruncated = pending.length === 500 || dispatched.length === 500;
      const state = projectionTruncated || historicalUnsettled || counts.reconcileRequired > 0 ? "reconcile_required"
        : counts.pending > 0 ? "pending"
          : counts.awaitingTerminal > 0 ? "awaiting_terminal" : "settled";
      const reasonCode = projectionTruncated ? "cancellation_projection_limit_reached"
        : historicalUnsettled ? "historical_cancellation_reconciliation_required"
        : state === "reconcile_required" ? "cancellation_reconciliation_required"
          : state === "pending" ? "cancellation_dispatch_pending"
            : state === "awaiting_terminal" ? "cancellation_terminal_awaiting_observation" : null;
      return Object.freeze({
        contractVersion: CANCELLATION_STATUS_CONTRACT_VERSION,
        state,
        reasonCode,
        counts: Object.freeze(counts),
      });
    } catch {
      return Object.freeze({
        contractVersion: CANCELLATION_STATUS_CONTRACT_VERSION,
        state: "reconcile_required",
        reasonCode: "cancellation_projection_unavailable",
        counts: Object.freeze(emptyCounts),
      });
    }
  }

  function projectEmergencyStopCommand({ actor, committedControl, context, commandState }) {
    const cancellation = projectCancellation(committedControl, context.identity);
    let operations = null;
    if (context.schedule) {
      try {
        operations = projectOperations({
          ...context,
          control: committedControl,
          currentActor: actor,
        });
      } catch {
        operations = null;
      }
    }
    return deepFreeze({
      contractVersion: EMERGENCY_STOP_COMMAND_CONTRACT_VERSION,
      commandState,
      controlVersion: committedControl.controlVersion,
      activationState: committedControl.activationState,
      emergencyStop: {
        active: committedControl.emergencyStop.active,
        version: committedControl.emergencyStop.version,
        reasonCode: committedControl.emergencyStop.reasonCode,
        stoppedAt: committedControl.emergencyStop.stoppedAt,
      },
      cancellation,
      operations,
    });
  }

  function projectProviderDryRun(identity, schedule) {
    let currentDispatch = null;
    try {
      currentDispatch = typeof resolveCurrentDispatch === "function"
        ? resolveCurrentDispatch(identity)
        : null;
    } catch {
      currentDispatch = null;
    }
    const currentDispatchAvailable = dispatchMatchesSchedule(currentDispatch, schedule);
    const empty = {
      contractVersion: "digital-employee-schedule-provider-dry-run-status.v1",
      state: "not_run",
      gate: {
        state: currentDispatchAvailable ? "ready" : "blocked",
        reasonCode: currentDispatchAvailable ? null : "current_binding_unavailable",
      },
      currentBinding: {
        state: currentDispatchAvailable ? "current" : "stale",
        registrationVersion: schedule.registrationVersion,
      },
      outcome: null,
      evidenceCode: null,
      preparedAt: null,
      updatedAt: null,
      completedAt: null,
      durationMs: null,
      providerAttempts: null,
      safetyEvidence: null,
    };
    if (typeof dryRunRepository?.getLatestForSchedule !== "function" || typeof getCanonicalTask !== "function") {
      return Object.freeze(empty);
    }
    const dryRun = dryRunRepository.getLatestForSchedule(identity);
    if (!dryRun) return Object.freeze(empty);
    const current = currentDispatchAvailable && dryRunMatchesSchedule(dryRun, schedule, currentDispatch);
    let task = null;
    try {
      task = dryRun.executionTaskId
        ? getCanonicalTask(dryRun.executionTaskId, { tenantScope: identity.tenantScope })
        : null;
    } catch {
      task = null;
    }
    const canonicalTaskUnavailable = dryRun.submission.state === "submitted" && !task;
    const canonicalTaskIdentityMismatch = Boolean(task) && !canonicalTaskMatchesProviderTrial(task, dryRun, identity);
    const canonicalCompletionUnconfirmed = dryRun.evidence.state === "committed" &&
      dryRun.evidence.outcome === "passed" && !canonicalTaskIdentityMismatch &&
      isCanonicalTerminal(task?.status) && task.status !== "completed";
    const passed = current && dryRun.evidence.state === "committed" && dryRun.evidence.outcome === "passed" &&
      !canonicalTaskIdentityMismatch && task?.status === "completed";
    const internalBlocked = dryRun.evidence.state === "reconcile_required" ||
      dryRun.submission.state === "reconcile_required";
    const state = !current
      ? "stale"
      : passed
        ? "passed"
        : internalBlocked || canonicalTaskUnavailable || canonicalTaskIdentityMismatch || canonicalCompletionUnconfirmed
          ? "blocked"
          : dryRun.evidence.state === "committed"
            ? dryRun.evidence.outcome === "passed" ? "running"
              : dryRun.evidence.outcome === "canceled" ? "blocked" : dryRun.evidence.outcome
            : dryRun.execution.phase ? "running" : "queued";
    const completedAt = passed ? task.updatedAt : dryRun.evidence.state === "committed"
      ? dryRun.evidence.committedAt : null;
    return Object.freeze({
      contractVersion: "digital-employee-schedule-provider-dry-run-status.v1",
      state,
      gate: {
        state: ["queued", "running", "blocked", "stale"].includes(state) ? "blocked" : "ready",
        reasonCode: state === "stale" ? "current_binding_unavailable_or_changed"
          : internalBlocked ? "manual_reconciliation_required"
            : canonicalTaskUnavailable ? "canonical_task_unavailable"
              : canonicalTaskIdentityMismatch ? "canonical_task_identity_mismatch"
              : canonicalCompletionUnconfirmed ? "canonical_completion_unconfirmed"
          : ["queued", "running"].includes(state) ? "trial_in_progress" : null,
      },
      currentBinding: {
        state: current ? "current" : "stale",
        registrationVersion: schedule.registrationVersion,
      },
      outcome: dryRun.evidence.state === "committed" ? dryRun.evidence.outcome : null,
      evidenceCode: dryRun.evidence.state === "committed" ? dryRun.evidence.evidenceCode : null,
      preparedAt: dryRun.preparedAt,
      updatedAt: dryRun.updatedAt,
      completedAt,
      durationMs: passed ? elapsedMilliseconds(dryRun.preparedAt, task.updatedAt) : null,
      providerAttempts: passed ? dryRun.evidence.providerAttempts : null,
      safetyEvidence: passed ? { ...dryRun.evidence.safetyEvidence } : null,
    });
  }

  function projectActivationGovernance({ bindingCurrent, control, identity }) {
    if (control.activationState !== "active") {
      return Object.freeze({ state: "not_applicable", reasonCode: null });
    }
    if (!bindingCurrent) {
      return Object.freeze({ state: "stale", reasonCode: "registration_binding_stale" });
    }
    if (typeof controlRepository.resolveActiveActivationSnapshot !== "function") {
      return Object.freeze({ state: "unavailable", reasonCode: "activation_governance_unavailable" });
    }
    try {
      const resolved = controlRepository.resolveActiveActivationSnapshot({
        ...identity,
        activationVersion: control.activationVersion,
        activationSnapshotId: control.activationSnapshotId,
        activationSnapshotDigest: control.activationSnapshotDigest,
      });
      if (!activationResolutionMatchesControl(resolved, control, identity)) {
        return Object.freeze({ state: "unavailable", reasonCode: "activation_snapshot_unavailable" });
      }
      return Object.freeze({ state: "current", reasonCode: null });
    } catch (error) {
      return Object.freeze(projectActivationGovernanceFailure(error));
    }
  }

  function nowTimestamp() {
    const value = now();
    const date = value instanceof Date ? value : new Date(value);
    if (!Number.isFinite(date.getTime())) throw serviceError("schedule_operations_clock_invalid");
    return date.toISOString();
  }

  return Object.freeze({
    contractVersion: SCHEDULE_OPERATIONS_CONTRACT_VERSION,
    assertProviderTrialAllowed,
    getOperations,
    listRuns,
    resolveRunTask,
    setEmergencyStop,
  });
}

function canonicalTaskMatchesProviderTrial(task, dryRun, identity) {
  return task.taskId === dryRun.executionTaskId && task.tenantScope === identity.tenantScope &&
    task.employeeId === identity.employeeId && task.sourceSystemId === PROVIDER_TRIAL_SOURCE_SYSTEM_ID &&
    task.channelId === PROVIDER_TRIAL_CHANNEL_ID && task.taskType === PROVIDER_TRIAL_TASK_TYPE &&
    task.submissionScope === "schedule-provider-trial" && task.idempotencyKey === dryRun.requestIdDigest &&
    task.inputDigest === dryRun.requestIdDigest && task.executionInputRef?.kind === "artifact_ref" &&
    task.executionInputRef.refId === dryRun.dryRunId;
}

function hasExecutionBlockersInSummary(summary = {}) {
  return ["active", "cancel_requested", "reconcile_blocked"]
    .some((state) => Number(summary.executions?.[state] || 0) > 0);
}

function hasPendingScheduleLedgerInSummary(summary = {}) {
  return hasExecutionBlockersInSummary(summary) ||
    ["prepared", "submitted", "cancel_requested", "reconcile_required"]
      .some((state) => Number(summary.intents?.[state] || 0) > 0);
}

function cancellationMatchesSchedule(identity, row) {
  return Boolean(row && typeof row === "object" && !Array.isArray(row) &&
    row.tenantScope === identity.tenantScope && row.employeeId === identity.employeeId &&
    row.scheduleId === identity.scheduleId);
}

function cancellationMatchesCurrentStop({ control, identity, row }) {
  return cancellationMatchesSchedule(identity, row) &&
    row.emergencyStopVersion === control.emergencyStop.version;
}

function activationResolutionMatchesControl(resolved, control, identity) {
  const snapshot = resolved?.snapshot;
  return Boolean(snapshot && typeof snapshot === "object" && !Array.isArray(snapshot) &&
    snapshot.tenantScope === identity.tenantScope && snapshot.employeeId === identity.employeeId &&
    snapshot.scheduleId === identity.scheduleId && snapshot.activationVersion === control.activationVersion &&
    snapshot.snapshotDigest === control.activationSnapshotDigest &&
    snapshot.registrationVersion === control.registrationVersion && snapshot.scheduleVersion === control.scheduleVersion &&
    snapshot.schedulePolicyDigest === control.schedulePolicyDigest &&
    snapshot.executionContractDigest === control.executionContractDigest);
}

function projectActivationGovernanceFailure(error) {
  const code = String(error?.code || "");
  if (STALE_ACTIVATION_GOVERNANCE_CODES.has(code)) {
    return {
      state: "stale",
      reasonCode: code.includes("processing_authority")
        ? "processing_authority_stale"
        : code.includes("snapshot_binding") ? "activation_snapshot_stale" : "business_owner_acceptance_stale",
    };
  }
  if (code === "schedule_control_activation_owner_acceptance_required") {
    return { state: "unavailable", reasonCode: "business_owner_acceptance_unavailable" };
  }
  if (code.includes("processing_authority")) {
    return { state: "unavailable", reasonCode: "processing_authority_unavailable" };
  }
  if (code.includes("activation_snapshot")) {
    return { state: "unavailable", reasonCode: "activation_snapshot_unavailable" };
  }
  return { state: "unavailable", reasonCode: "activation_governance_unavailable" };
}

function controlMatchesSchedule(control, schedule) {
  return control.registrationVersion === schedule.registrationVersion &&
    control.scheduleVersion === schedule.scheduleVersion &&
    control.schedulePolicyDigest === schedule.schedulePolicyDigest &&
    control.executionContractDigest === schedule.executionContractDigest &&
    control.maxConcurrentRuns === schedule.maxConcurrentRuns &&
    control.overlapWindowMinutes === schedule.overlapWindowMinutes;
}

function dryRunMatchesSchedule(dryRun, schedule, dispatch) {
  return dryRun.registrationVersion === schedule.registrationVersion &&
    dryRun.scheduleVersion === schedule.scheduleVersion &&
    dryRun.schedulePolicyDigest === schedule.schedulePolicyDigest &&
    dryRun.executionContractDigest === schedule.executionContractDigest &&
    dryRun.taskModelBinding?.bindingDigest === schedule.taskModelBinding?.bindingDigest &&
    dryRun.employeeVersion === dispatch.employeeVersion &&
    dryRun.taskModelBinding?.bindingDigest === dispatch.taskModelBinding?.bindingDigest;
}

function dispatchMatchesSchedule(dispatch, schedule) {
  return Boolean(dispatch && dispatch.registrationVersion === schedule.registrationVersion &&
    dispatch.scheduleVersion === schedule.scheduleVersion &&
    dispatch.schedulePolicyDigest === schedule.schedulePolicyDigest &&
    dispatch.executionContractDigest === schedule.executionContractDigest &&
    dispatch.taskModelBinding?.bindingDigest === schedule.taskModelBinding?.bindingDigest);
}

function elapsedMilliseconds(start, end) {
  const value = Date.parse(end) - Date.parse(start);
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function isCanonicalTerminal(status) {
  return ["blocked", "canceled", "completed", "failed", "lost", "rejected", "timed_out"].includes(status);
}

function projectControlEvent(event) {
  return Object.freeze({
    eventId: event.eventId,
    controlVersion: event.controlVersion,
    eventType: event.eventType,
    reasonCode: event.reasonCode,
    safeReason: event.safeReason,
    actor: event.actor,
    eventAt: event.eventAt,
  });
}

function scheduleReference(schedule) {
  return Object.freeze({
    scheduleId: schedule.id,
    scheduleVersion: schedule.scheduleVersion,
    registrationVersion: schedule.registrationVersion,
  });
}

function normalizePublicActor(actor) {
  if (!actor || typeof actor !== "object" || Array.isArray(actor)) {
    throw serviceError("schedule_operations_actor_invalid");
  }
  return Object.freeze({
    principalId: identifier(actor.principalId, "actor.principalId"),
    displayName: safeLine(actor.displayName, "actor.displayName", 120),
    nameStatus: actor.nameStatus === "verified" ? "verified" : "unresolved",
    identitySource: identifier(actor.identitySource, "actor.identitySource"),
    resolvedAt: actor.resolvedAt || null,
  });
}

function identifier(value, field) {
  const result = String(value || "").trim();
  if (!result || result.length > 160 || !/^[A-Za-z0-9][A-Za-z0-9._:@/-]*$/.test(result)) {
    throw serviceError("schedule_operations_reference_invalid", field);
  }
  return result;
}

function safeLine(value, field, maxLength) {
  const result = String(value || "").replace(/[\u0000-\u001f\u007f]/g, " ").trim();
  if (!result || result.length > maxLength) throw serviceError("schedule_operations_safe_text_invalid", field);
  return result;
}

function boundedInteger(value, minimum, maximum, field) {
  const result = Number(value);
  if (!Number.isSafeInteger(result) || result < minimum || result > maximum) {
    throw serviceError("schedule_operations_number_invalid", field);
  }
  return result;
}

function deepFreeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    Object.values(value).forEach(deepFreeze);
  }
  return value;
}

function serviceError(code, detail = "") {
  const error = new Error(detail ? `${code}: ${detail}` : code);
  error.code = code;
  return error;
}

export {
  EMERGENCY_STOP_COMMAND_CONTRACT_VERSION,
  SCHEDULE_OPERATIONS_CONTRACT_VERSION,
  SCHEDULE_RUNS_CONTRACT_VERSION,
  createScheduleOperationsService,
};
