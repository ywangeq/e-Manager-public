import { projectScheduleFromRunConfiguration } from "./schedule-run-configuration.mjs";
import { isDeepStrictEqual } from "node:util";
import {
  normalizeRunnableScheduleActivationSnapshot,
  projectRunnableGovernedScheduleFromActivationSnapshot,
} from "./schedule-activation-snapshot.mjs";
import { calculateLatestDueTime } from "./schedule-due-time-calculator.mjs";
import {
  SCHEDULE_SLOT_VERIFICATION_CONTRACT_VERSION,
  normalizeGovernedSchedule,
  scheduleTriggerSlotDigest,
} from "./schedule-trigger-service.mjs";

const SCHEDULE_CURRENT_SLOT_VERIFIER_CONTRACT_VERSION = "schedule-current-slot-verifier.v1";
const ONE_MINUTE_MS = 60_000;

function createScheduleCurrentSlotVerifier({
  controlRepository,
  dueTimeCalculator = calculateLatestDueTime,
} = {}) {
  if (typeof controlRepository?.getControl !== "function" ||
    typeof controlRepository?.resolveActiveActivationSnapshot !== "function") {
    throw new TypeError("schedule current slot verifier requires the Schedule control repository");
  }
  if (typeof dueTimeCalculator !== "function") {
    throw new TypeError("schedule current slot verifier requires dueTimeCalculator");
  }

  function verifyScheduledFor(request = {}) {
    exactObject(request, new Set(["schedule", "scheduledFor", ...(request.manualRequestDigest !== undefined ? ["manualRequestDigest"] : [])]));
    const schedule = normalizeGovernedSchedule(request.schedule);
    const scheduledFor = canonicalTimestamp(request.scheduledFor);
    const control = controlRepository.getControl({
      tenantScope: schedule.tenantScope,
      employeeId: schedule.employeeId,
      scheduleId: schedule.scheduleId,
    });
    const runId = `schedule_run_${scheduleTriggerSlotDigest({ ...schedule, scheduledFor, manualRequestDigest: request.manualRequestDigest })}`;
    const intent = typeof controlRepository.getIntent === "function" ? controlRepository.getIntent(runId, { tenantScope: schedule.tenantScope }) : null;
    const manual = request.manualRequestDigest !== undefined;
    if (manual && (!intent || intent.manualRequestDigest !== request.manualRequestDigest || intent.scheduledFor !== scheduledFor ||
      intent.employeeId !== schedule.employeeId || intent.scheduleId !== schedule.scheduleId || !["prepared", "submitted", "reconcile_required"].includes(intent.intentState))) {
      throw verifierError("schedule_manual_intent_unavailable");
    }
    if (!control || !(control.activationState === "active" || (manual && control.activationState === "paused")) || (!manual && control.effectiveActive !== true) || control.emergencyStop?.active ||
      !control.activationSnapshotId || !control.activationSnapshotDigest) {
      throw verifierError("schedule_current_slot_activation_not_active");
    }

    const resolved = controlRepository.resolveActiveActivationSnapshot({
      tenantScope: control.tenantScope,
      employeeId: control.employeeId,
      scheduleId: control.scheduleId,
      activationVersion: control.activationVersion,
      ...(manual ? { runId } : {}),
      activationSnapshotId: control.activationSnapshotId,
      activationSnapshotDigest: control.activationSnapshotDigest,
    });
    const snapshot = normalizeRunnableScheduleActivationSnapshot(resolved?.snapshot);
    const governedSchedule = normalizeGovernedSchedule(resolved?.governedSchedule);
    const projectedSchedule = projectRunnableGovernedScheduleFromActivationSnapshot(snapshot);
    const snapshotId = `schedule_activation_snapshot_${snapshot.snapshotDigest}`;
    const effectiveSchedule = snapshot.contractVersion === "schedule-activation-snapshot.v3"
      ? projectScheduleFromRunConfiguration(snapshot, controlRepository.getRunConfiguration?.({ tenantScope: schedule.tenantScope, runId }), intent)
      : projectedSchedule;
    if (snapshotId !== control.activationSnapshotId || snapshot.snapshotDigest !== control.activationSnapshotDigest ||
      snapshot.activationVersion !== control.activationVersion ||
      !isDeepStrictEqual(governedSchedule, projectedSchedule) ||
      !isDeepStrictEqual(schedule, effectiveSchedule)) {
      throw verifierError("schedule_current_slot_governance_changed");
    }

    const dueAt = manual ? scheduledFor : dueTimeCalculator({
      cronExpression: snapshot.cron,
      timezone: snapshot.timezone,
      afterExclusive: new Date(Date.parse(scheduledFor) - ONE_MINUTE_MS).toISOString(),
      throughInclusive: scheduledFor,
    });
    if (dueAt !== null) canonicalTimestamp(dueAt);
    return Object.freeze({
      contractVersion: SCHEDULE_SLOT_VERIFICATION_CONTRACT_VERSION,
      due: dueAt === scheduledFor,
      schedulePolicyDigest: snapshot.schedulePolicyDigest,
    });
  }

  return Object.freeze({
    contractVersion: SCHEDULE_CURRENT_SLOT_VERIFIER_CONTRACT_VERSION,
    verifyScheduledFor,
  });
}

function exactObject(value, fields) {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
    Object.keys(value).length !== fields.size ||
    Object.keys(value).some((field) => !fields.has(field))) {
    throw verifierError("schedule_current_slot_request_invalid");
  }
}

function canonicalTimestamp(value) {
  if (typeof value !== "string") throw verifierError("schedule_current_slot_timestamp_invalid");
  const timestamp = new Date(value);
  if (!Number.isFinite(timestamp.getTime()) || timestamp.toISOString() !== value) {
    throw verifierError("schedule_current_slot_timestamp_invalid");
  }
  return value;
}

function verifierError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

export {
  SCHEDULE_CURRENT_SLOT_VERIFIER_CONTRACT_VERSION,
  createScheduleCurrentSlotVerifier,
};
