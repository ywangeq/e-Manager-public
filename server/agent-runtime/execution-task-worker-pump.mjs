import { normalizeExecutionTaskSettlement } from "./runtime-task-contract-v1.mjs";

const TERMINAL_STATUSES = new Set([
  "blocked",
  "canceled",
  "completed",
  "failed",
  "lost",
  "rejected",
  "timed_out",
]);
const MAX_TRANSIENT_EVIDENCE_READ_RETRIES = 3;

function createExecutionTaskWorkerPump({
  repository,
  tenantScope,
  workerIdDigest,
  leaseDurationMs = 30_000,
  heartbeatIntervalMs = 10_000,
  pollIntervalMs = 20,
  maxGlobalLeases = Number.MAX_SAFE_INTEGER,
  maxActorLeases = Number.MAX_SAFE_INTEGER,
  maxEmployeeLeases = 1,
  resolveMaxEmployeeLeases = null,
  now = () => new Date(),
} = {}) {
  assertRepository(repository);
  const jobs = new Map();
  const activeDispatches = new Map();
  const activeAbortControllers = new Map();
  let closed = false;
  let dispatchLoopPromise = null;
  let executionLifecycleResolver = null;
  let executorResolver = null;
  let wakeDispatcher = null;

  function reconcileOnStartup() {
    return repository.reconcileExpiredLeases({ tenantScope, now: now() });
  }

  function execute(taskId, run) {
    if (closed) return Promise.reject(workerError("execution_task_worker_closed"));
    if (typeof run !== "function") return Promise.reject(workerError("execution_task_executor_required"));
    const existing = jobs.get(taskId);
    if (existing) return existing.promise;
    let resolveJob;
    let rejectJob;
    const promise = new Promise((resolve, reject) => {
      resolveJob = resolve;
      rejectJob = reject;
    });
    const job = { promise, reject: rejectJob, resolve: resolveJob, run, taskId };
    jobs.set(taskId, job);
    wake();
    void drive(job);
    return promise.finally(() => {
      if (jobs.get(taskId) === job) jobs.delete(taskId);
    });
  }

  async function drive(job) {
    try {
      while (!closed) {
        const current = repository.get(job.taskId, { tenantScope });
        if (!current) throw workerError("execution_task_not_found");
        if (TERMINAL_STATUSES.has(current.status)) {
          job.resolve({ settled: false, task: current, value: null });
          return;
        }
        if (current.status === "queued" && isEmployeeQueueHead(current)) {
          const claimed = repository.claimNext({
            tenantScope,
            workerIdDigest,
            employeeId: current.employeeId,
            leaseDurationMs,
            maxGlobalLeases,
            maxActorLeases,
            maxEmployeeLeases,
            resolveMaxEmployeeLeases,
            now: now(),
          });
          if (claimed?.taskId === current.taskId) {
            job.resolve(await runClaimed(claimed, job.run));
            return;
          }
        }
        await delay(pollIntervalMs);
      }
      throw workerError("execution_task_worker_closed");
    } catch (error) {
      job.reject(error);
    }
  }

  function start({ resolveExecutionLifecycle = null, resolveExecutor } = {}) {
    if (closed) throw workerError("execution_task_worker_closed");
    if (dispatchLoopPromise) throw workerError("execution_task_worker_already_started");
    if (typeof resolveExecutor !== "function") throw workerError("execution_task_executor_resolver_required");
    if (resolveExecutionLifecycle !== null && typeof resolveExecutionLifecycle !== "function") {
      throw workerError("execution_task_lifecycle_resolver_invalid");
    }
    executionLifecycleResolver = resolveExecutionLifecycle;
    executorResolver = resolveExecutor;
    const reconciliation = reconcileOnStartup();
    dispatchLoopPromise = dispatchLoop();
    wake();
    return Object.freeze({ reconciliation, started: true });
  }

  async function dispatchLoop() {
    while (!closed) {
      const claimed = repository.claimNext({
        tenantScope,
        workerIdDigest,
        leaseDurationMs,
        maxGlobalLeases,
        maxActorLeases,
        maxEmployeeLeases,
        resolveMaxEmployeeLeases,
        now: now(),
      });
      if (!claimed) {
        await waitForWake();
        continue;
      }
      launchPersistentDispatch(claimed);
    }
  }

  function launchPersistentDispatch(claimed) {
    const existing = activeDispatches.get(claimed.taskId);
    if (existing) return existing;
    const dispatch = (async () => {
      const compatibilityJob = jobs.get(claimed.taskId);
      let run = compatibilityJob?.run || null;
      if (!run) {
        try {
          run = executorResolver(claimed);
        } catch {
          run = null;
        }
      }
      if (typeof run !== "function") {
        run = async () => ({
          settlement: {
            status: "blocked",
            lastErrorCode: "execution_task_handler_unavailable",
            resultSummary: "No persistent Worker handler is registered for this task type and channel.",
          },
        });
      }
      const result = await runClaimed(claimed, run);
      compatibilityJob?.resolve(result);
      return result;
    })();
    activeDispatches.set(claimed.taskId, dispatch);
    void dispatch.catch((error) => {
      jobs.get(claimed.taskId)?.reject(error);
    }).finally(() => {
      if (activeDispatches.get(claimed.taskId) === dispatch) activeDispatches.delete(claimed.taskId);
      wake();
    });
    return dispatch;
  }

  function isEmployeeQueueHead(task) {
    const head = repository.peekNextQueued({ tenantScope, employeeId: task.employeeId });
    return head?.taskId === task.taskId;
  }

  async function runClaimed(claimed, run) {
    let heartbeat = null;
    let taskDeadlineTimer = null;
    let ownershipLost = false;
    let executionLifecycle = null;
    let executionGuard = null;
    let lifecycleConverged = true;
    let lifecycleErrorCode = null;
    const abortController = new AbortController();
    activeAbortControllers.set(claimed.taskId, abortController);
    const loseOwnership = () => {
      ownershipLost = true;
      if (!abortController.signal.aborted) abortController.abort(workerError("execution_task_ownership_lost"));
    };
    let currentLeaseTask = claimed;
    const refreshCurrentLease = () => {
      if (ownershipLost) throw workerError("execution_task_ownership_lost");
      if (abortController.signal.aborted) {
        throw abortController.signal.reason || workerError("agent_turn_canceled");
      }
      const currentTime = new Date(now());
      const currentTimeMs = currentTime.getTime();
      const deadlineMs = Date.parse(currentLeaseTask.executionDeadlineAt || "");
      if (!Number.isFinite(currentTimeMs) || !Number.isFinite(deadlineMs)) {
        throw workerError("execution_task_deadline_invalid");
      }
      const remainingMs = deadlineMs - currentTimeMs;
      if (remainingMs <= 0) {
        const timeout = workerError("task_execution_timeout");
        if (!abortController.signal.aborted) abortController.abort(timeout);
        throw timeout;
      }
      let renewed;
      try {
        renewed = repository.renewLease({
          tenantScope,
          taskId: claimed.taskId,
          leaseId: claimed.lease.leaseId,
          workerIdDigest,
          fencingToken: claimed.lease.fencingToken,
          leaseDurationMs: Math.min(leaseDurationMs, remainingMs),
          now: currentTime,
        });
      } catch (error) {
        loseOwnership();
        throw error;
      }
      if (!ownsCurrentLease(renewed, claimed) || renewed.executionDeadlineAt !== claimed.executionDeadlineAt ||
        renewed.lease.expiresAt > renewed.executionDeadlineAt || renewed.lease.expiresAt <= currentTime.toISOString()) {
        loseOwnership();
        throw workerError("execution_task_ownership_lost");
      }
      currentLeaseTask = renewed;
      return renewed;
    };
    if (heartbeatIntervalMs > 0) {
      heartbeat = setInterval(() => {
        try {
          refreshCurrentLease();
        } catch (error) {
          if (error?.code !== "task_execution_timeout") loseOwnership();
        }
      }, heartbeatIntervalMs);
      heartbeat.unref?.();
    }
    let value = null;
    let settlement;
    try {
      if (executionLifecycleResolver) {
        try {
          const resolvedLifecycle = await executionLifecycleResolver(claimed);
          validateExecutionLifecycle(resolvedLifecycle);
          executionLifecycle = resolvedLifecycle;
        } catch (error) {
          lifecycleConverged = false;
          lifecycleErrorCode = safeErrorCode(error?.code || "execution_task_lifecycle_resolution_failed");
          throw error;
        }
      }
      const taskDeadlineAtMs = Date.parse(claimed.executionDeadlineAt || "");
      const currentMs = new Date(now()).getTime();
      if (!Number.isFinite(taskDeadlineAtMs)) throw workerError("execution_task_deadline_invalid");
      if (taskDeadlineAtMs <= currentMs) {
        abortController.abort(workerError("task_execution_timeout"));
        settlement = timeoutSettlement("task_execution_timeout");
      } else {
        taskDeadlineTimer = setTimeout(() => {
          if (!abortController.signal.aborted) abortController.abort(workerError("task_execution_timeout"));
        }, taskDeadlineAtMs - currentMs);
        const isCancellationRequested = () => abortController.signal.aborted || ownershipLost || !ownsCurrentLease(repository.get(claimed.taskId, { tenantScope }), claimed);
        if (typeof executionLifecycle?.beforeExecute === "function") {
          executionGuard = await executionLifecycle.beforeExecute({
            task: claimed,
            lease: claimed.lease,
            signal: abortController.signal,
            abort: (reasonCode = "execution_task_lifecycle_aborted") => {
              if (!abortController.signal.aborted) abortController.abort(workerError(safeErrorCode(reasonCode)));
            },
            isCancellationRequested,
          });
        }
        if (isCancellationRequested()) {
          if (!abortController.signal.aborted) loseOwnership();
          throw abortController.signal.reason || workerError("agent_turn_canceled");
        }
        value = await run({
        artifactPublicationAuthority: Object.freeze({
          tenantScope,
          taskId: claimed.taskId,
          leaseId: claimed.lease.leaseId,
          workerIdDigest,
          fencingToken: claimed.lease.fencingToken,
        }),
        appendProgress: ({ eventKey, stage, status, code }) => repository.appendProgressWithLease({
          tenantScope,
          taskId: claimed.taskId,
          leaseId: claimed.lease.leaseId,
          workerIdDigest,
          fencingToken: claimed.lease.fencingToken,
          eventKey,
          stage,
          status,
          code,
          now: now(),
        }),
        appendResultAvailable: () => repository.appendResultAvailableWithLease({
          tenantScope,
          taskId: claimed.taskId,
          leaseId: claimed.lease.leaseId,
          workerIdDigest,
          fencingToken: claimed.lease.fencingToken,
          now: now(),
        }),
        task: claimed,
        lease: claimed.lease,
        signal: abortController.signal,
        executionGuard,
        isCancellationRequested,
        refreshCurrentLease,
        });
        const normalizedSettlement = normalizeSettlement(value);
        settlement = isTimeoutCode(abortController.signal.reason?.code)
          ? {
            ...timeoutSettlement(abortController.signal.reason.code),
            terminalEvidenceDigest: normalizedSettlement.terminalEvidenceDigest || null,
          }
          : normalizedSettlement;
      }
    } catch (error) {
      settlement = isTimeoutCode(error?.code) || isTimeoutCode(abortController.signal.reason?.code)
        ? timeoutSettlement(error?.code || abortController.signal.reason?.code)
        : {
        status: "failed",
        lastErrorCode: safeErrorCode(error?.code || "worker_execution_failed"),
        resultSummary: "Worker execution failed before a safe result was committed.",
        };
    } finally {
      if (heartbeat) clearInterval(heartbeat);
      if (taskDeadlineTimer) clearTimeout(taskDeadlineTimer);
      if (activeAbortControllers.get(claimed.taskId) === abortController) activeAbortControllers.delete(claimed.taskId);
    }
    let settled = null;
    let settlementErrorCode = null;
    try {
      settled = ownershipLost ? null : settlement.status === "waiting" ? repository.releaseToWaitingWithLease({
        tenantScope,
        taskId: claimed.taskId,
        leaseId: claimed.lease.leaseId,
        workerIdDigest,
        fencingToken: claimed.lease.fencingToken,
        waitReasonCode: settlement.waitReasonCode,
        lastErrorCode: settlement.lastErrorCode,
        resultSummary: settlement.resultSummary,
        now: now(),
      }) : repository.settleWithLease({
        tenantScope,
        taskId: claimed.taskId,
        leaseId: claimed.lease.leaseId,
        workerIdDigest,
        fencingToken: claimed.lease.fencingToken,
        ...settlement,
        now: now(),
      });
    } catch (error) {
      settlementErrorCode = safeErrorCode(error?.code || "execution_task_settlement_failed");
    }
    let task = settled;
    try {
      task ||= repository.get(claimed.taskId, { tenantScope });
    } catch (error) {
      settlementErrorCode ||= safeErrorCode(error?.code || "execution_task_outcome_unavailable");
      task = null;
    }
    if (executionLifecycle) {
      try {
        if (typeof executionLifecycle.afterCanonicalOutcome === "function") {
          await executionLifecycle.afterCanonicalOutcome({
            claimedTask: claimed,
            actualTask: task,
            canonicalTerminal: TERMINAL_STATUSES.has(task?.status),
            canonicalTransitionCommitted: Boolean(settled),
            workerOwnershipLost: ownershipLost,
            executionErrorCode: settlementErrorCode || settlement.lastErrorCode || null,
          });
        }
      } catch (error) {
        lifecycleConverged = false;
        lifecycleErrorCode = safeErrorCode(error?.code || "execution_task_lifecycle_convergence_failed");
      } finally {
        try {
          await executionLifecycle.dispose?.();
        } catch (error) {
          lifecycleConverged = false;
          lifecycleErrorCode ||= safeErrorCode(error?.code || "execution_task_lifecycle_dispose_failed");
        }
      }
    }
    return {
      lifecycleConverged,
      lifecycleErrorCode,
      ownershipLost: ownershipLost || !settled,
      settled: Boolean(settled),
      task,
      value: settled && settlement.status !== "timed_out" ? value : null,
    };
  }

  async function waitForTerminal(taskId, { onEvent = null, timeoutMs = 30_000 } = {}) {
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 0) throw workerError("execution_task_wait_timeout_invalid");
    if (onEvent !== null && typeof onEvent !== "function") throw workerError("execution_task_wait_event_handler_invalid");
    const deadline = timeoutMs ? Date.now() + timeoutMs : Number.POSITIVE_INFINITY;
    let afterSeq = 0;
    let transientEvidenceReadRetries = 0;
    while (true) {
      let task;
      try {
        task = repository.get(taskId, { tenantScope });
        transientEvidenceReadRetries = 0;
      } catch (error) {
        if (error?.code !== "runtime_evidence_activity_count_invalid" ||
          transientEvidenceReadRetries >= MAX_TRANSIENT_EVIDENCE_READ_RETRIES ||
          Date.now() >= deadline) {
          throw error;
        }
        transientEvidenceReadRetries += 1;
        await delay(Math.min(pollIntervalMs, Math.max(1, deadline - Date.now())));
        continue;
      }
      if (!task) throw workerError("execution_task_not_found");
      if (onEvent) {
        let page;
        do {
          page = repository.listEvents({ tenantScope, taskId, afterSeq, limit: 200 });
          for (const event of page.events) onEvent(event);
          afterSeq = page.nextAfterSeq;
        } while (page.hasMore);
      }
      if (TERMINAL_STATUSES.has(task.status)) return task;
      if (closed) throw workerError("execution_task_worker_closed");
      if (Date.now() >= deadline) throw workerError("execution_task_wait_timeout");
      await delay(Math.min(pollIntervalMs, Math.max(1, deadline - Date.now())));
    }
  }

  function wake() {
    if (wakeDispatcher) wakeDispatcher();
    return !closed;
  }

  function abortTask(taskId) {
    const controller = activeAbortControllers.get(taskId);
    if (!controller || controller.signal.aborted) return false;
    controller.abort(workerError("agent_turn_canceled"));
    return true;
  }

  function waitForWake() {
    return new Promise((resolve) => {
      let timer;
      const finish = () => {
        if (timer) clearTimeout(timer);
        if (wakeDispatcher === finish) wakeDispatcher = null;
        resolve();
      };
      wakeDispatcher = finish;
      timer = setTimeout(finish, pollIntervalMs);
      timer.unref?.();
    });
  }

  async function close() {
    closed = true;
    wake();
    return Promise.allSettled([
      ...(dispatchLoopPromise ? [dispatchLoopPromise] : []),
      ...[...activeDispatches.values()],
      ...[...jobs.values()].map((job) => job.promise),
    ]);
  }

  return Object.freeze({
    abortTask,
    close,
    execute,
    reconcileOnStartup,
    start,
    waitForTerminal,
    wake,
  });
}

function ownsCurrentLease(current, claimed) {
  return current?.status === "running" &&
    current.lease?.leaseId === claimed.lease?.leaseId &&
    current.lease?.fencingToken === claimed.lease?.fencingToken;
}

function validateExecutionLifecycle(value) {
  if (value === null || value === undefined) return;
  if (typeof value !== "object" || Array.isArray(value)) throw workerError("execution_task_lifecycle_invalid");
  for (const hook of ["beforeExecute", "afterCanonicalOutcome", "dispose"]) {
    if (value[hook] !== undefined && typeof value[hook] !== "function") {
      throw workerError("execution_task_lifecycle_invalid");
    }
  }
}

function normalizeSettlement(value) {
  const requested = value?.settlement && typeof value.settlement === "object"
    ? value.settlement
    : {};
  if (requested.status === "waiting") {
    if (requested.terminalEvidenceDigest !== undefined && requested.terminalEvidenceDigest !== null &&
      requested.terminalEvidenceDigest !== "") {
      throw workerError("execution_task_waiting_terminal_evidence_invalid");
    }
    return {
      status: "waiting",
      waitReasonCode: safeErrorCode(requested.waitReasonCode || "prerequisite_pending"),
      lastErrorCode: requested.lastErrorCode ? safeErrorCode(requested.lastErrorCode) : null,
      resultSummary: requested.resultSummary || "Worker execution completed.",
    };
  }
  const normalized = normalizeExecutionTaskSettlement({
    status: ["blocked", "completed", "failed", "timed_out"].includes(requested.status) ? requested.status : "completed",
    lastErrorCode: requested.lastErrorCode ? safeErrorCode(requested.lastErrorCode) : null,
    resultSummary: requested.resultSummary || "Worker execution completed.",
    terminalEvidenceDigest: requested.terminalEvidenceDigest ?? null,
  });
  return { ...normalized, waitReasonCode: null };
}

function isTimeoutCode(value) {
  return [
    "provider_connect_timeout",
    "provider_first_semantic_output_timeout",
    "provider_request_total_timeout",
    "provider_stream_idle_timeout",
    "task_execution_timeout",
    "tool_execution_timeout",
  ].includes(String(value || ""));
}

function timeoutSettlement(code) {
  return {
    status: "timed_out",
    lastErrorCode: safeErrorCode(code || "task_execution_timeout"),
    resultSummary: "Execution stopped at a governed timeout boundary.",
  };
}

function safeErrorCode(value) {
  const normalized = String(value || "worker_execution_failed")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._:-]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 120);
  return normalized || "worker_execution_failed";
}

function assertRepository(repository) {
  for (const method of ["appendProgressWithLease", "appendResultAvailableWithLease", "claimNext", "get", "peekNextQueued", "reconcileExpiredLeases", "releaseToWaitingWithLease", "renewLease", "settleWithLease"]) {
    if (typeof repository?.[method] !== "function") throw new TypeError(`execution task worker requires repository.${method}`);
  }
}

function workerError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export { createExecutionTaskWorkerPump };
