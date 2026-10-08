import crypto from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { normalizeProviderTimeoutPolicy } from "./provider-timeout-policy.mjs";
import { SCHEDULE_PROVIDER_DRY_RUN_EVIDENCE_CONTRACT_VERSION } from "./sqlite-schedule-provider-dry-run-repository.mjs";

const SCHEDULE_PROVIDER_TRIAL_SERVICE_CONTRACT_VERSION = "schedule-provider-trial-service.v1";
const SCHEDULE_PROVIDER_TRIAL_GUARD_CONTRACT_VERSION = "schedule-provider-trial-guard.v1";
const TRIAL_SOURCE_SYSTEM_ID = "digital-workforce-schedule-provider-trial";
const TRIAL_CHANNEL_ID = "schedule";
const TRIAL_TASK_TYPE = "schedule_provider_trial";
const TRIAL_ACTOR_ISSUER = "digital-workforce-center";
const TERMINAL_TASK_STATUSES = new Set([
  "blocked",
  "canceled",
  "completed",
  "failed",
  "lost",
  "rejected",
  "timed_out",
]);

function createScheduleProviderTrialService({
  dryRunRepository,
  executionTaskRepository,
  assertProviderTrialAllowed,
  scheduleRegistry,
  resolveEmployee,
  resolveProviderLease,
  resolveProviderTimeoutPolicy,
  providerRunner,
  wakeWorker = () => {},
  now = () => new Date().toISOString(),
} = {}) {
  assertDependencies({
    dryRunRepository,
    executionTaskRepository,
    assertProviderTrialAllowed,
    now,
    providerRunner,
    resolveEmployee,
    resolveProviderLease,
    resolveProviderTimeoutPolicy,
    scheduleRegistry,
    wakeWorker,
  });

  async function submitTrial({ actorSubjectDigest, employeeId, scheduleId, tenantScope, workflowRequestDigest } = {}) {
    const actorDigest = digest(actorSubjectDigest, "actorSubjectDigest");
    const safeEmployeeId = token(employeeId, "employeeId");
    const safeScheduleId = token(scheduleId, "scheduleId");
    const safeTenant = token(tenantScope, "tenantScope");
    const preparedAt = timestamp(now(), "now");
    const workflowRunId = `provider_trial_${digest(workflowRequestDigest, "workflowRequestDigest")}`;
    const resolved = await resolveCurrentTrial({
      employeeId: safeEmployeeId,
      scheduleId: safeScheduleId,
      tenantScope: safeTenant,
    });
    await assertCurrentControlAllowsTrial(resolved.dispatch);
    const inputDigest = trialInputDigest(resolved.dispatch, resolved.timeoutPolicy);
    let dryRun = dryRunRepository.prepareOrGet({
      actorSubjectDigest: actorDigest,
      dispatch: resolved.dispatch,
      inputDigest,
      preparedAt,
      purpose: "provider_dry_run",
      workflowRunId,
    }).dryRun;
    const submission = projectCanonicalTask(dryRun, resolved.timeoutPolicy);
    let task;
    try {
      task = executionTaskRepository.submitOrGet(submission, { now: new Date(preparedAt) }).task;
    } catch (error) {
      safelyMarkSubmissionUnknown(dryRun, preparedAt);
      throw serviceError("schedule_provider_trial_submission_failed", error);
    }
    assertExactCanonicalTask(task, dryRun, resolved.timeoutPolicy);
    dryRun = convergeSubmitted(dryRun, task, preparedAt);
    wakeWorker();
    return deepFreeze({ dryRun, task });
  }

  async function reconcileOnce({ tenantScope } = {}) {
    const safeTenant = token(tenantScope, "tenantScope");
    const summary = { inspected: 0, submitted: 0, terminalObserved: 0, effectReconcileRequired: 0, blocked: 0 };
    for (let dryRun of dryRunRepository.listIncomplete({ tenantScope: safeTenant })) {
      summary.inspected += 1;
      try {
        let task = executionTaskRepository.get(dryRun.expectedExecutionTaskId, { tenantScope: safeTenant });
        if (["prepared", "reconcile_required"].includes(dryRun.submission.state)) {
          if (!task) {
            const resolved = await resolveCurrentTrial({
              employeeId: dryRun.employeeId,
              scheduleId: dryRun.scheduleId,
              tenantScope: dryRun.tenantScope,
            });
            assertCurrentSnapshot(dryRun, resolved.dispatch, resolved.timeoutPolicy);
            task = executionTaskRepository.submitOrGet(
              projectCanonicalTask(dryRun, resolved.timeoutPolicy),
              { now: new Date(dryRun.preparedAt) },
            ).task;
          }
          assertExactCanonicalTask(task, dryRun, task.providerTimeoutPolicy);
          dryRun = convergeSubmitted(dryRun, task, timestamp(now(), "now"));
          summary.submitted += 1;
        }
        if (!task) continue;
        assertExactCanonicalTask(task, dryRun, task.providerTimeoutPolicy);
        if (dryRun.evidence.state === "pending" && TERMINAL_TASK_STATUSES.has(task.status)) {
          if (dryRun.execution.phase === "provider_attempt_started") {
            dryRun = markAttemptUnknown(dryRun, timestamp(now(), "now"));
            summary.effectReconcileRequired += 1;
          } else if (task.status !== "completed") {
            dryRun = observeTerminalBeforeAttempt(dryRun, task, timestamp(now(), "now"));
            summary.terminalObserved += 1;
          }
        }
      } catch {
        summary.blocked += 1;
      }
    }
    return Object.freeze(summary);
  }

  function resolvePersistentTaskExecutor(task) {
    if (!isTrialTask(task)) return null;
    return async (ownership) => {
      const guard = ownership?.executionGuard;
      if (!guard || guard.contractVersion !== SCHEDULE_PROVIDER_TRIAL_GUARD_CONTRACT_VERSION ||
        guard.taskId !== task.taskId || typeof guard.execute !== "function") {
        return failedSettlement("schedule_provider_trial_guard_invalid");
      }
      return guard.execute(ownership);
    };
  }

  async function resolveExecutionLifecycle(claimedTask) {
    if (!isTrialTask(claimedTask)) return null;
    try {
      return await buildExecutionLifecycle(claimedTask);
    } catch (error) {
      return failedExecutionLifecycle(claimedTask, safeCode(
        error?.code || "schedule_provider_trial_lifecycle_initialization_failed",
      ));
    }
  }

  async function buildExecutionLifecycle(claimedTask) {
    let dryRun = dryRunRepository.get(claimedTask.executionInputRef.refId, {
      tenantScope: claimedTask.tenantScope,
    });
    if (!dryRun) throw serviceError("schedule_provider_trial_not_found");
    assertExactCanonicalTask(claimedTask, dryRun, claimedTask.providerTimeoutPolicy);
    if (["prepared", "reconcile_required"].includes(dryRun.submission.state)) {
      dryRun = convergeSubmitted(dryRun, claimedTask, timestamp(now(), "now"));
    }
    const state = {
      dryRun,
      mode: "ready",
      providerLease: null,
      task: claimedTask,
    };
    if (dryRun.evidence.state === "committed") {
      state.mode = dryRun.evidence.outcome === "passed" ? "committed_replay" : "blocked";
    } else if (dryRun.evidence.state === "reconcile_required") {
      state.mode = "reconcile_required";
    } else if (dryRun.execution.phase === "provider_attempt_started") {
      state.dryRun = markAttemptUnknown(dryRun, timestamp(now(), "now"));
      state.mode = "reconcile_required";
    } else {
      state.dryRun = claimOrTakeoverPreEffect(dryRun, claimedTask, timestamp(now(), "now"));
    }

    return Object.freeze({
      beforeExecute: async ({ isCancellationRequested }) => {
        if (state.mode === "ready") {
          try {
            if (isCancellationRequested()) throw serviceError("schedule_provider_trial_canceled_before_attempt");
            const resolved = await resolveCurrentTrial({
              employeeId: state.dryRun.employeeId,
              includeProviderLease: true,
              scheduleId: state.dryRun.scheduleId,
              tenantScope: state.dryRun.tenantScope,
            });
            assertCurrentSnapshot(state.dryRun, resolved.dispatch, resolved.timeoutPolicy);
            await assertCurrentControlAllowsTrial(resolved.dispatch);
            if (!isDeepStrictEqual(resolved.timeoutPolicy, claimedTask.providerTimeoutPolicy)) {
              throw serviceError("schedule_provider_trial_timeout_policy_changed");
            }
            state.providerLease = Object.freeze({
              ...resolved.providerLease,
              fallbackRouteId: "",
              retryCount: 0,
            });
          } catch (error) {
            state.mode = "blocked";
            state.blockedCode = safeCode(error?.code || "schedule_provider_trial_revalidation_failed");
          }
        }
        return Object.freeze({
          contractVersion: SCHEDULE_PROVIDER_TRIAL_GUARD_CONTRACT_VERSION,
          taskId: claimedTask.taskId,
          execute: (ownership) => executeGuardedTrial(state, ownership),
        });
      },
      afterCanonicalOutcome: ({ actualTask, canonicalTerminal, workerOwnershipLost }) => {
        state.dryRun = dryRunRepository.get(state.dryRun.dryRunId, { tenantScope: state.dryRun.tenantScope }) || state.dryRun;
        if (state.dryRun.evidence.state !== "pending") return;
        if (state.dryRun.execution.phase === "provider_attempt_started") {
          if (canonicalTerminal || workerOwnershipLost) {
            state.dryRun = markAttemptUnknown(state.dryRun, timestamp(now(), "now"));
          }
          return;
        }
        if (canonicalTerminal && actualTask?.status !== "completed") {
          state.dryRun = observeTerminalBeforeAttempt(state.dryRun, actualTask, timestamp(now(), "now"));
        }
      },
      dispose: () => {
        state.providerLease = null;
      },
    });
  }

  async function executeGuardedTrial(state, ownership) {
    if (state.mode === "committed_replay") return completedSettlement();
    if (state.mode === "reconcile_required") return failedSettlement("schedule_provider_trial_reconcile_required");
    if (state.mode === "blocked") return blockedSettlement(state.blockedCode || "schedule_provider_trial_blocked");
    if (state.mode !== "ready" || !state.providerLease) return failedSettlement("schedule_provider_trial_guard_invalid");
    if (ownership.isCancellationRequested()) return blockedSettlement("schedule_provider_trial_canceled_before_attempt");
    try {
      await assertCurrentControlAllowsTrial(state.dryRun);
    } catch {
      state.mode = "blocked";
      return blockedSettlement("schedule_provider_trial_control_blocked");
    }
    try {
      state.dryRun = dryRunRepository.beginProviderAttempt({
        tenantScope: state.dryRun.tenantScope,
        dryRunId: state.dryRun.dryRunId,
        expectedDryRunVersion: state.dryRun.dryRunVersion,
        ...dryLeaseIdentity(state.dryRun),
        preparedAt: timestamp(now(), "now"),
      });
      state.mode = "provider_attempt_started";
      if (ownership.isCancellationRequested()) {
        state.dryRun = markAttemptUnknown(state.dryRun, timestamp(now(), "now"));
        state.mode = "reconcile_required";
        return failedSettlement("schedule_provider_trial_reconcile_required");
      }
      try {
        await assertCurrentControlAllowsTrial(state.dryRun);
      } catch {
        state.dryRun = markAttemptUnknown(state.dryRun, timestamp(now(), "now"));
        state.mode = "reconcile_required";
        return failedSettlement("schedule_provider_trial_reconcile_required");
      }
      const result = await providerRunner.runProviderOnly({
        lease: state.providerLease,
        runtimeTask: Object.freeze({ ...ownership.task, id: ownership.task.taskId }),
        signal: ownership.signal,
      });
      if (ownership.isCancellationRequested()) {
        throw serviceError("schedule_provider_trial_ownership_lost_after_provider");
      }
      state.dryRun = dryRunRepository.commitEvidence({
        tenantScope: state.dryRun.tenantScope,
        dryRunId: state.dryRun.dryRunId,
        expectedDryRunVersion: state.dryRun.dryRunVersion,
        ...dryLeaseIdentity(state.dryRun),
        evidence: passingEvidence(result),
        committedAt: timestamp(now(), "now"),
      });
      state.mode = "committed_replay";
      return completedSettlement();
    } catch {
      if (state.dryRun.execution.phase === "provider_attempt_started" && state.dryRun.evidence.state === "pending") {
        try {
          state.dryRun = markAttemptUnknown(state.dryRun, timestamp(now(), "now"));
        } catch {
          // Startup reconciliation will observe the durable provider-attempt gate.
        }
      }
      state.mode = "reconcile_required";
      return failedSettlement("schedule_provider_trial_reconcile_required");
    }
  }

  function failedExecutionLifecycle(claimedTask, blockedCode) {
    const state = { blockedCode, mode: "blocked", providerLease: null };
    return Object.freeze({
      beforeExecute: async () => Object.freeze({
        contractVersion: SCHEDULE_PROVIDER_TRIAL_GUARD_CONTRACT_VERSION,
        taskId: claimedTask.taskId,
        execute: (ownership) => executeGuardedTrial(state, ownership),
      }),
      afterCanonicalOutcome: ({ actualTask, canonicalTerminal }) => {
        if (!canonicalTerminal || actualTask?.status === "completed") return;
        const dryRun = dryRunRepository.get(claimedTask.executionInputRef.refId, {
          tenantScope: claimedTask.tenantScope,
        });
        if (!dryRun || dryRun.evidence.state !== "pending") return;
        if (dryRun.execution.phase === "provider_attempt_started") {
          markAttemptUnknown(dryRun, timestamp(now(), "now"));
        } else {
          observeTerminalBeforeAttempt(dryRun, actualTask, timestamp(now(), "now"));
        }
      },
      dispose: () => {
        state.providerLease = null;
      },
    });
  }

  async function resolveCurrentTrial({ employeeId, includeProviderLease = false, scheduleId, tenantScope }) {
    const employee = await resolveEmployee(employeeId);
    if (!employee || employee.id !== employeeId) throw serviceError("schedule_provider_trial_employee_unavailable");
    const dispatch = await scheduleRegistry.resolveDispatchSchedule({
      employee,
      purpose: "provider_dry_run",
      scheduleId,
      tenantScope,
    });
    const timeoutPolicy = normalizeProviderTimeoutPolicy(await resolveProviderTimeoutPolicy({
      employee,
      providerBinding: dispatch.taskModelBinding,
    }));
    const providerLease = includeProviderLease
      ? await resolveProviderLease({ employee, providerBinding: dispatch.taskModelBinding })
      : null;
    if (includeProviderLease) {
      if (!providerLease) throw serviceError("schedule_provider_trial_provider_unavailable");
      assertLeaseMatchesDispatch(providerLease, dispatch);
      if (!isDeepStrictEqual(normalizeProviderTimeoutPolicy(providerLease.timeoutPolicy), timeoutPolicy)) {
        throw serviceError("schedule_provider_trial_timeout_policy_changed");
      }
    }
    return Object.freeze({ dispatch, employee, providerLease, timeoutPolicy });
  }

  async function assertCurrentControlAllowsTrial(snapshot) {
    const result = await assertProviderTrialAllowed({
      tenantScope: snapshot.tenantScope,
      employeeId: snapshot.employeeId,
      scheduleId: snapshot.scheduleId,
      expectedRegistrationVersion: snapshot.registrationVersion,
      expectedScheduleVersion: snapshot.scheduleVersion,
      expectedSchedulePolicyDigest: snapshot.schedulePolicyDigest,
      expectedExecutionContractDigest: snapshot.executionContractDigest,
      expectedTaskBindingDigest: snapshot.taskModelBinding?.bindingDigest,
    });
    if (result !== true && result?.registrationVersion !== snapshot.registrationVersion) {
      throw serviceError("schedule_provider_trial_control_blocked");
    }
  }

  function safelyMarkSubmissionUnknown(dryRun, reconciledAt) {
    try {
      return dryRunRepository.markSubmissionReconcileRequired({
        tenantScope: dryRun.tenantScope,
        dryRunId: dryRun.dryRunId,
        expectedDryRunVersion: dryRun.dryRunVersion,
        errorCode: "canonical_task_submission_unknown",
        reconciledAt,
      });
    } catch {
      return dryRun;
    }
  }

  function convergeSubmitted(dryRun, task, submittedAt) {
    if (dryRun.submission.state === "submitted") return dryRun;
    try {
      return dryRunRepository.markSubmitted({
        tenantScope: dryRun.tenantScope,
        dryRunId: dryRun.dryRunId,
        expectedDryRunVersion: dryRun.dryRunVersion,
        executionTaskId: task.taskId,
        submittedAt,
      });
    } catch {
      const current = dryRunRepository.get(dryRun.dryRunId, { tenantScope: dryRun.tenantScope });
      if (current?.submission.state === "submitted" && current.executionTaskId === task.taskId) return current;
      throw serviceError("schedule_provider_trial_submission_convergence_failed");
    }
  }

  function claimOrTakeoverPreEffect(dryRun, task, claimedAt) {
    const input = {
      tenantScope: dryRun.tenantScope,
      dryRunId: dryRun.dryRunId,
      expectedDryRunVersion: dryRun.dryRunVersion,
      taskLeaseId: task.lease.leaseId,
      taskOwnerDigest: task.lease.workerIdDigest,
      taskFencingToken: task.lease.fencingToken,
      taskLeaseExpiresAt: task.lease.expiresAt,
      executionOwnerDigest: task.lease.workerIdDigest,
      leaseDurationMs: Math.max(1, Date.parse(task.lease.expiresAt) - Date.parse(claimedAt)),
    };
    if (dryRun.execution.phase === null) {
      return dryRunRepository.claimPreEffect({ ...input, claimedAt });
    }
    if (dryRun.execution.phase === "pre_effect" &&
      dryRun.execution.taskLeaseId === task.lease.leaseId &&
      dryRun.execution.taskOwnerDigest === task.lease.workerIdDigest &&
      dryRun.execution.taskFencingToken === task.lease.fencingToken) return dryRun;
    return dryRunRepository.takeoverPreEffect({ ...input, takenOverAt: claimedAt });
  }

  function markAttemptUnknown(dryRun, reconciledAt) {
    return dryRunRepository.markEvidenceReconcileRequired({
      tenantScope: dryRun.tenantScope,
      dryRunId: dryRun.dryRunId,
      expectedDryRunVersion: dryRun.dryRunVersion,
      ...dryLeaseIdentity(dryRun),
      errorCode: "provider_only_outcome_unknown",
      reconciledAt,
    });
  }

  function observeTerminalBeforeAttempt(dryRun, task, observedAt) {
    return dryRunRepository.observeCanonicalTerminalBeforeAttempt({
      tenantScope: dryRun.tenantScope,
      dryRunId: dryRun.dryRunId,
      expectedDryRunVersion: dryRun.dryRunVersion,
      canonicalTaskId: task.taskId,
      canonicalTaskRevision: task.revision,
      canonicalTaskStatus: task.status,
      observedAt,
    });
  }

  return Object.freeze({
    contractVersion: SCHEDULE_PROVIDER_TRIAL_SERVICE_CONTRACT_VERSION,
    reconcileOnce,
    resolveExecutionLifecycle,
    resolvePersistentTaskExecutor,
    submitTrial,
  });
}

function projectCanonicalTask(dryRun, providerTimeoutPolicy) {
  return Object.freeze({
    taskId: dryRun.expectedExecutionTaskId,
    tenantScope: dryRun.tenantScope,
    actorIssuer: TRIAL_ACTOR_ISSUER,
    actorSubjectDigest: dryRun.actorSubjectDigest,
    employeeId: dryRun.employeeId,
    employeeVersion: dryRun.employeeVersion,
    sessionId: null,
    sourceSystemId: TRIAL_SOURCE_SYSTEM_ID,
    channelId: TRIAL_CHANNEL_ID,
    taskType: TRIAL_TASK_TYPE,
    submissionScope: "schedule-provider-trial",
    idempotencyKey: dryRun.requestIdDigest,
    inputDigest: dryRun.requestIdDigest,
    executionInputRef: { kind: "artifact_ref", refId: dryRun.dryRunId },
    priority: 0,
    maxRecoveries: 2,
    providerTimeoutPolicy,
    createdAt: dryRun.preparedAt,
    availableAt: dryRun.preparedAt,
  });
}

function assertExactCanonicalTask(task, dryRun, timeoutPolicy) {
  const expected = projectCanonicalTask(dryRun, normalizeProviderTimeoutPolicy(timeoutPolicy));
  const matches = task?.taskId === expected.taskId && task.tenantScope === expected.tenantScope &&
    task.actorIssuer === expected.actorIssuer && task.actorSubjectDigest === expected.actorSubjectDigest &&
    task.employeeId === expected.employeeId && task.employeeVersion === expected.employeeVersion &&
    task.sessionId === null && task.sourceSystemId === expected.sourceSystemId &&
    task.channelId === expected.channelId && task.taskType === expected.taskType &&
    task.submissionScope === expected.submissionScope && task.idempotencyKey === expected.idempotencyKey &&
    task.inputDigest === expected.inputDigest && task.executionInputRef?.kind === "artifact_ref" &&
    task.executionInputRef.refId === expected.executionInputRef.refId && task.priority === 0 &&
    task.maxRecoveries === 2 && task.createdAt === expected.createdAt && task.availableAt === expected.availableAt &&
    isDeepStrictEqual(task.providerTimeoutPolicy, expected.providerTimeoutPolicy);
  if (!matches) throw serviceError("schedule_provider_trial_task_identity_mismatch");
}

function assertCurrentSnapshot(dryRun, dispatch, timeoutPolicy) {
  const currentInputDigest = trialInputDigest(dispatch, timeoutPolicy);
  const binding = dispatch.taskModelBinding;
  const stored = dryRun.taskModelBinding;
  const matches = dispatch.tenantScope === dryRun.tenantScope && dispatch.employeeId === dryRun.employeeId &&
    dispatch.employeeVersion === dryRun.employeeVersion && dispatch.scheduleId === dryRun.scheduleId &&
    dispatch.registrationVersion === dryRun.registrationVersion && dispatch.scheduleVersion === dryRun.scheduleVersion &&
    dispatch.taskId === dryRun.taskId && dispatch.schedulePolicyDigest === dryRun.schedulePolicyDigest &&
    dispatch.executionContractDigest === dryRun.executionContractDigest && currentInputDigest === dryRun.inputDigest &&
    binding.assignmentId === stored.assignmentId && binding.assignmentAppliedVersion === stored.assignmentAppliedVersion &&
    binding.assignmentSetDigest === stored.assignmentSetDigest && binding.bindingVersion === stored.bindingVersion &&
    binding.bindingDigest === stored.bindingDigest && binding.model === stored.model && binding.modelId === stored.modelId &&
    binding.modelLevelId === stored.modelLevelId && binding.provider === stored.provider &&
    binding.providerRouteId === stored.providerRouteId &&
    binding.requiredCapabilityProfileVersion === stored.requiredCapabilityProfileVersion;
  if (!matches) throw serviceError("schedule_provider_trial_governance_changed");
}

function assertLeaseMatchesDispatch(lease, dispatch) {
  const binding = dispatch.taskModelBinding;
  const matches = lease.model === binding.model && lease.modelId === binding.modelId &&
    lease.modelLevelId === binding.modelLevelId && lease.provider === binding.provider &&
    lease.providerRouteId === binding.providerRouteId &&
    lease.capabilityProfileVersion === binding.requiredCapabilityProfileVersion && !lease.fallbackRouteId;
  if (!matches) throw serviceError("schedule_provider_trial_provider_binding_changed");
}

function trialInputDigest(dispatch, timeoutPolicy) {
  return canonicalDigest({
    contractVersion: "schedule-provider-trial-input.v1",
    employeeId: dispatch.employeeId,
    executionContractDigest: dispatch.executionContractDigest,
    providerOnly: true,
    providerTimeoutPolicy: normalizeProviderTimeoutPolicy(timeoutPolicy),
    registrationVersion: dispatch.registrationVersion,
    scheduleId: dispatch.scheduleId,
    schedulePolicyDigest: dispatch.schedulePolicyDigest,
    scheduleVersion: dispatch.scheduleVersion,
    taskBindingDigest: dispatch.taskModelBinding.bindingDigest,
    tools: [],
    writeback: "none",
  });
}

function passingEvidence(result) {
  return {
    contractVersion: SCHEDULE_PROVIDER_DRY_RUN_EVIDENCE_CONTRACT_VERSION,
    outcome: "passed",
    evidenceCode: "provider_only_passed",
    providerAttempts: result?.providerAttempts,
    usage: {
      inputTokens: Number(result?.usage?.inputTokens || 0),
      outputTokens: Number(result?.usage?.outputTokens || 0),
      totalTokens: Number(result?.usage?.totalTokens || 0),
    },
    safetyEvidence: result?.safetyEvidence,
  };
}

function dryLeaseIdentity(dryRun) {
  return {
    leaseId: dryRun.execution.leaseId,
    executionOwnerDigest: dryRun.execution.ownerDigest,
    executionFencingToken: dryRun.execution.fencingToken,
    taskLeaseId: dryRun.execution.taskLeaseId,
    taskOwnerDigest: dryRun.execution.taskOwnerDigest,
    taskFencingToken: dryRun.execution.taskFencingToken,
  };
}

function isTrialTask(task) {
  return Boolean(task && task.sourceSystemId === TRIAL_SOURCE_SYSTEM_ID &&
    task.channelId === TRIAL_CHANNEL_ID && task.taskType === TRIAL_TASK_TYPE && task.sessionId === null &&
    task.executionInputRef?.kind === "artifact_ref" &&
    /^schedule_provider_dry_run_[a-f0-9]{64}$/.test(task.executionInputRef.refId || ""));
}

function completedSettlement() {
  return {
    settlement: {
      status: "completed",
      resultSummary: "Provider-only Schedule trial completed without business output persistence.",
    },
  };
}

function failedSettlement(code) {
  return {
    settlement: {
      status: "failed",
      lastErrorCode: code,
      resultSummary: "Provider-only Schedule trial requires reconciliation; no request will be replayed.",
    },
  };
}

function blockedSettlement(code) {
  return {
    settlement: {
      status: "blocked",
      lastErrorCode: code,
      resultSummary: "Provider-only Schedule trial was blocked before a Provider attempt.",
    },
  };
}

function assertDependencies(value) {
  for (const method of ["prepareOrGet", "markSubmitted", "markSubmissionReconcileRequired", "claimPreEffect",
    "takeoverPreEffect", "beginProviderAttempt", "commitEvidence", "markEvidenceReconcileRequired",
    "observeCanonicalTerminalBeforeAttempt", "get", "listIncomplete"]) {
    if (typeof value.dryRunRepository?.[method] !== "function") throw new TypeError(`trial service requires dryRunRepository.${method}`);
  }
  for (const method of ["get", "submitOrGet"]) {
    if (typeof value.executionTaskRepository?.[method] !== "function") throw new TypeError(`trial service requires executionTaskRepository.${method}`);
  }
  if (typeof value.scheduleRegistry?.resolveDispatchSchedule !== "function") throw new TypeError("trial service requires scheduleRegistry.resolveDispatchSchedule");
  if (typeof value.assertProviderTrialAllowed !== "function") {
    throw new TypeError("trial service requires assertProviderTrialAllowed");
  }
  if (typeof value.resolveEmployee !== "function" || typeof value.resolveProviderLease !== "function" ||
    typeof value.resolveProviderTimeoutPolicy !== "function") {
    throw new TypeError("trial service requires current employee, Provider and timeout-policy resolvers");
  }
  if (typeof value.providerRunner?.runProviderOnly !== "function") throw new TypeError("trial service requires providerRunner.runProviderOnly");
  for (const field of ["wakeWorker", "now"]) {
    if (typeof value[field] !== "function") throw new TypeError(`trial service requires ${field}`);
  }
}

function canonicalDigest(value) {
  return crypto.createHash("sha256").update(JSON.stringify(sortCanonical(value))).digest("hex");
}

function sortCanonical(value) {
  if (Array.isArray(value)) return value.map(sortCanonical);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, sortCanonical(value[key])]));
}

function digest(value, field) {
  const safe = String(value || "").trim().toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(safe)) throw new TypeError(`${field} must be a SHA-256 digest`);
  return safe;
}

function token(value, field) {
  const safe = String(value || "").trim();
  if (!safe || safe.length > 200 || !/^[A-Za-z0-9._:@/-]+$/.test(safe)) throw new TypeError(`${field} is invalid`);
  return safe;
}

function timestamp(value, field) {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) throw new TypeError(`${field} is invalid`);
  return date.toISOString();
}

function safeCode(value) {
  const safe = String(value || "schedule_provider_trial_failed").trim();
  return /^[A-Za-z0-9._:-]{1,120}$/.test(safe) ? safe : "schedule_provider_trial_failed";
}

function serviceError(code, cause = null) {
  const error = new Error(code, cause ? { cause } : undefined);
  error.code = code;
  return error;
}

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const nested of Object.values(value)) deepFreeze(nested);
  return value;
}

export {
  SCHEDULE_PROVIDER_TRIAL_SERVICE_CONTRACT_VERSION,
  createScheduleProviderTrialService,
};
