const SCHEDULE_DRY_RUN_EXECUTOR_CONTRACT_VERSION = "schedule-dry-run-executor.v1";
const SCHEDULE_DRY_RUN_ADAPTER_CONTRACT_VERSION = "schedule-dry-run-adapter.v1";
const SCHEDULE_DRY_RUN_RESULT_CONTRACT_VERSION = "schedule-dry-run-result.v1";
const SCHEDULE_DRY_RUN_SAFETY_EVIDENCE_CONTRACT_VERSION = "schedule-dry-run-safety-evidence.v1";
const BLOCKED_RESOLUTION_CODES = new Set([
  "schedule_task_authorization_changed",
  "schedule_task_employee_not_runnable",
  "schedule_task_employee_version_changed",
  "schedule_task_execution_contract_changed",
  "schedule_task_governance_changed",
  "schedule_task_input_task_invalid",
  "schedule_task_schedule_invalid",
  "schedule_task_schedule_not_approved",
  "schedule_task_schedule_policy_changed",
  "schedule_task_trigger_binding_mismatch",
  "schedule_task_trigger_not_found",
]);
const UNAVAILABLE_RESOLUTION_CODES = new Set([
  "schedule_task_authorization_unavailable",
  "schedule_task_employee_state_unavailable",
  "schedule_task_employee_unavailable",
  "schedule_task_execution_contract_unavailable",
  "schedule_task_schedule_unavailable",
  "schedule_task_schedule_policy_unavailable",
]);

function createScheduleDryRunExecutor({ dryRunAdapter, inputResolver } = {}) {
  if (typeof inputResolver?.resolve !== "function") {
    throw new TypeError("schedule dry-run executor requires inputResolver.resolve");
  }
  const adapter = normalizeFixtureOnlyAdapter(dryRunAdapter);

  function resolvePersistentTaskExecutor(task) {
    if (!isScheduleTask(task)) return null;
    return (ownership) => execute({ dryRunAdapter: adapter, inputResolver, ownership });
  }

  return Object.freeze({
    contractVersion: SCHEDULE_DRY_RUN_EXECUTOR_CONTRACT_VERSION,
    resolvePersistentTaskExecutor,
  });
}

async function execute({ dryRunAdapter, inputResolver, ownership }) {
  if (cancellationRequested(ownership)) return canceledSettlement();
  let resolved;
  try {
    resolved = await inputResolver.resolve(ownership.task);
  } catch (error) {
    return resolutionFailure(error?.code);
  }
  if (cancellationRequested(ownership)) return canceledSettlement();

  let result;
  try {
    result = await dryRunAdapter.run({
      employee: resolved.employee,
      schedule: resolved.schedule,
      signal: ownership.signal,
      task: ownership.task,
      trigger: resolved.trigger,
    });
  } catch {
    if (cancellationRequested(ownership)) return canceledSettlement();
    return failedSettlement("schedule_dry_run_failed");
  }
  if (cancellationRequested(ownership)) return canceledSettlement();
  if (!isSuccessfulDryRunResult(result)) {
    return failedSettlement("schedule_dry_run_contract_failed");
  }
  return {
    dryRunOutcome: "passed",
    settlement: {
      status: "completed",
      resultSummary: "Governed Schedule dry-run completed with no business output persisted.",
    },
  };
}

function isScheduleTask(task) {
  return Boolean(task && typeof task === "object" && !Array.isArray(task) &&
    task.channelId === "schedule" &&
    task.sourceSystemId === "digital-workforce-scheduler" &&
    task.taskType === "scheduled_employee_task");
}

function isSuccessfulDryRunResult(value) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value) &&
    exactKeys(value, ["contractVersion", "outcome", "safetyEvidence"]) &&
    value.contractVersion === SCHEDULE_DRY_RUN_RESULT_CONTRACT_VERSION &&
    value.outcome === "passed" &&
    isZeroEffectSafetyEvidence(value.safetyEvidence));
}

function normalizeFixtureOnlyAdapter(value) {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
    !exactKeys(value, [
      "adapterKind",
      "contractVersion",
      "network",
      "productionEffect",
      "providerAccess",
      "run",
      "skillAccess",
      "toolAccess",
      "writeback",
    ]) ||
    value.contractVersion !== SCHEDULE_DRY_RUN_ADAPTER_CONTRACT_VERSION ||
    value.adapterKind !== "fixture_only" ||
    value.network !== "disabled" ||
    value.productionEffect !== "none" ||
    value.providerAccess !== "none" ||
    value.skillAccess !== "none" ||
    value.toolAccess !== "none" ||
    value.writeback !== "none" ||
    typeof value.run !== "function") {
    throw new TypeError("schedule dry-run executor requires a fixture-only zero-effect adapter");
  }
  return value;
}

function isZeroEffectSafetyEvidence(value) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value) &&
    exactKeys(value, [
      "contractVersion",
      "network",
      "productionEffect",
      "providerAttempts",
      "skillAttempts",
      "toolAttempts",
      "writebackAttempts",
    ]) &&
    value.contractVersion === SCHEDULE_DRY_RUN_SAFETY_EVIDENCE_CONTRACT_VERSION &&
    value.network === "disabled" &&
    value.productionEffect === "none" &&
    value.providerAttempts === 0 &&
    value.skillAttempts === 0 &&
    value.toolAttempts === 0 &&
    value.writebackAttempts === 0);
}

function exactKeys(value, fields) {
  const keys = Object.keys(value).sort();
  return keys.length === fields.length && keys.every((key, index) => key === [...fields].sort()[index]);
}

function cancellationRequested(ownership) {
  return ownership?.signal?.aborted === true || ownership?.isCancellationRequested?.() === true;
}

function resolutionFailure(code) {
  const safeCode = typeof code === "string" ? code : "schedule_task_resolution_failed";
  if (BLOCKED_RESOLUTION_CODES.has(safeCode)) {
    return {
      settlement: {
        status: "blocked",
        lastErrorCode: safeCode,
        resultSummary: "Schedule dry-run was blocked by current governance revalidation.",
      },
    };
  }
  if (UNAVAILABLE_RESOLUTION_CODES.has(safeCode)) return failedSettlement(safeCode);
  return failedSettlement("schedule_task_resolution_failed");
}

function canceledSettlement() {
  return {
    settlement: {
      status: "blocked",
      lastErrorCode: "schedule_task_canceled",
      resultSummary: "Schedule dry-run stopped after cancellation or Worker ownership loss.",
    },
  };
}

function failedSettlement(lastErrorCode) {
  return {
    settlement: {
      status: "failed",
      lastErrorCode,
      resultSummary: "Schedule dry-run failed without persisting business output.",
    },
  };
}

export {
  SCHEDULE_DRY_RUN_ADAPTER_CONTRACT_VERSION,
  SCHEDULE_DRY_RUN_EXECUTOR_CONTRACT_VERSION,
  SCHEDULE_DRY_RUN_RESULT_CONTRACT_VERSION,
  SCHEDULE_DRY_RUN_SAFETY_EVIDENCE_CONTRACT_VERSION,
  createScheduleDryRunExecutor,
};
