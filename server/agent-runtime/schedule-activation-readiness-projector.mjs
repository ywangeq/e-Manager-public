const SCHEDULE_ACTIVATION_READINESS_CONTRACT_VERSION = "digital-employee-schedule-activation-readiness.v1";

const GATE_CODES = Object.freeze([
  "registration_binding",
  "task_model_binding",
  "provider_binding",
  "provider_trial",
  "business_owner_acceptance",
  "run_ledger_worker_fencing",
  "scanner_coordinator",
  "result_parser_alerting",
  "active_stop_convergence",
]);

function projectScheduleActivationReadiness({
  bindingCurrent,
  capabilityManifest,
  control,
  evaluatedAt,
  providerDryRun,
  runSummary,
  schedule,
} = {}) {
  const capabilities = normalizeCapabilities(capabilityManifest);
  const providerBindingCurrent = providerDryRun?.currentBinding?.state === "current";
  const executionBlocked = hasExecutionBlockers(runSummary);
  const gates = [
    gate("registration_binding", bindingCurrent ? "passed" : "stale", bindingCurrent ? null : "registration_binding_stale"),
    gate("task_model_binding", providerBindingCurrent ? "passed" : "stale", providerBindingCurrent ? null : "task_model_binding_stale"),
    gate("provider_binding", providerBindingCurrent ? "passed" : "stale", providerBindingCurrent ? null : "provider_binding_stale"),
    providerTrialGate(providerDryRun),
    gate("business_owner_acceptance", "pending", "business_owner_acceptance_not_recorded"),
    gate(
      "run_ledger_worker_fencing",
      capabilities.runLedger && capabilities.workerLifecycle ? "passed" : "blocked",
      !capabilities.runLedger ? "run_ledger_unwired" : !capabilities.workerLifecycle ? "schedule_worker_lifecycle_unwired" : null,
    ),
    gate("scanner_coordinator", capabilities.scannerCoordinator ? "passed" : "blocked", capabilities.scannerCoordinator ? null : "scanner_coordinator_unwired"),
    gate("result_parser_alerting", capabilities.resultParserAlerting ? "passed" : "blocked", capabilities.resultParserAlerting ? null : "result_parser_alerting_unwired"),
    gate(
      "active_stop_convergence",
      control?.emergencyStop?.active || executionBlocked || !capabilities.continuousStopDispatcher ? "blocked" : "passed",
      control?.emergencyStop?.active ? "emergency_stop_engaged"
        : executionBlocked ? "execution_reconciliation_required"
          : !capabilities.continuousStopDispatcher ? "continuous_stop_dispatcher_unwired" : null,
    ),
  ];
  const summary = gates.reduce((counts, item) => {
    counts[item.state] += 1;
    return counts;
  }, { passed: 0, pending: 0, blocked: 0, stale: 0 });
  const state = summary.stale > 0 ? "stale"
    : summary.blocked > 0 ? "blocked"
      : summary.pending > 0 ? "pending" : "ready_for_review";
  return deepFreeze({
    contractVersion: SCHEDULE_ACTIVATION_READINESS_CONTRACT_VERSION,
    state,
    evaluatedAt: timestampOrNull(evaluatedAt),
    registrationVersion: positiveIntegerOrNull(schedule?.registrationVersion),
    controlVersion: positiveIntegerOrNull(control?.controlVersion),
    summary,
    gates,
    ownerAcceptance: {
      state: "not_recorded",
      owner: null,
      acceptedAt: null,
      acceptedRegistrationVersion: null,
    },
  });
}

function providerTrialGate(providerDryRun) {
  const state = providerDryRun?.state;
  if (state === "passed" && providerDryRun?.gate?.state === "ready" && providerDryRun?.currentBinding?.state === "current") {
    return gate("provider_trial", "passed", null, providerDryRun.completedAt || providerDryRun.updatedAt);
  }
  if (state === "stale" || providerDryRun?.currentBinding?.state !== "current") {
    return gate("provider_trial", "stale", "provider_trial_stale", providerDryRun?.updatedAt);
  }
  if (state === "not_run" || state === "queued" || state === "running" || state === "failed") {
    return gate("provider_trial", "pending", `provider_trial_${state}`, providerDryRun?.updatedAt);
  }
  return gate("provider_trial", "blocked", "provider_trial_blocked", providerDryRun?.updatedAt);
}

function gate(code, state, reasonCode, evidenceAt = null) {
  return Object.freeze({
    code,
    state,
    reasonCode,
    evidenceAt: timestampOrNull(evidenceAt),
  });
}

function normalizeCapabilities(value) {
  const source = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  return {
    runLedger: source.runLedger === true,
    workerLifecycle: source.workerLifecycle === true,
    scannerCoordinator: source.scannerCoordinator === true,
    resultParserAlerting: source.resultParserAlerting === true,
    continuousStopDispatcher: source.continuousStopDispatcher === true,
  };
}

function hasExecutionBlockers(summary = {}) {
  return ["active", "cancel_requested", "reconcile_blocked"]
    .some((state) => Number(summary.executions?.[state] || 0) > 0);
}

function positiveIntegerOrNull(value) {
  return Number.isSafeInteger(value) && value > 0 ? value : null;
}

function timestampOrNull(value) {
  if (!value) return null;
  const timestamp = new Date(value);
  return Number.isFinite(timestamp.getTime()) ? timestamp.toISOString() : null;
}

function deepFreeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    Object.values(value).forEach(deepFreeze);
  }
  return value;
}

export {
  GATE_CODES as SCHEDULE_ACTIVATION_READINESS_GATE_CODES,
  SCHEDULE_ACTIVATION_READINESS_CONTRACT_VERSION,
  projectScheduleActivationReadiness,
};
