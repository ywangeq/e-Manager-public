import {
  MAX_DUE_SCAN_WINDOW_MS,
  calculateLatestDueTime,
} from "./schedule-due-time-calculator.mjs";
import { normalizeRunnableScheduleActivationSnapshot } from "./schedule-activation-snapshot.mjs";

const SCHEDULE_ONE_SHOT_SCANNER_COORDINATOR_CONTRACT_VERSION =
  "schedule-one-shot-scanner-coordinator.v1";

function createScheduleOneShotScannerCoordinator({
  controlRepository,
  dueTimeCalculator = calculateLatestDueTime,
  listActiveSnapshotControls,
  runIntentDispatcher,
  scannerLeaseDurationMs = 30_000,
  scannerOwnerDigest,
  currentTime = () => new Date().toISOString(),
} = {}) {
  assertDependencies({
    controlRepository,
    dueTimeCalculator,
    listActiveSnapshotControls,
    runIntentDispatcher,
  });
  const ownerDigest = digest(scannerOwnerDigest, "scannerOwnerDigest");
  const leaseDurationMs = boundedInteger(scannerLeaseDurationMs, 1, 86_400_000, "scannerLeaseDurationMs");
  if (typeof currentTime !== "function") throw new TypeError("schedule scanner coordinator requires currentTime");

  function runOnce({ tenantScope, now, limit = 100 } = {}) {
    const tenant = token(tenantScope, "tenantScope");
    const throughInclusive = canonicalTimestamp(now, "now");
    const safeLimit = boundedInteger(limit, 1, 500, "limit");

    const reconciliation = runIntentDispatcher.runOnce({ tenantScope: tenant, limit: safeLimit });
    const controls = listActiveSnapshotControls({ tenantScope: tenant, limit: safeLimit });
    if (!Array.isArray(controls)) throw scannerError("schedule_scanner_control_list_invalid");

    const summary = {
      examined: 0,
      claimed: 0,
      cursorAdvanced: 0,
      noDue: 0,
      recoveryRequired: 0,
      intentsPrepared: 0,
      dispatched: 0,
      dispatchDeferred: 0,
      skippedInactive: 0,
      fenced: 0,
      invalidControls: 0,
      failed: 0,
    };
    const seen = new Set();

    for (const candidate of controls.slice(0, safeLimit)) {
      summary.examined += 1;
      let identity;
      try {
        identity = normalizeListedControl(candidate, tenant);
      } catch {
        summary.invalidControls += 1;
        continue;
      }
      const identityKey = `${identity.tenantScope}\0${identity.employeeId}\0${identity.scheduleId}`;
      if (seen.has(identityKey)) {
        summary.invalidControls += 1;
        continue;
      }
      seen.add(identityKey);

      let lease;
      try {
        const claimedAt = canonicalTimestamp(currentTime(), "currentTime");
        lease = controlRepository.claimScannerLease({
          ...identity,
          ownerDigest,
          leaseDurationMs,
          now: claimedAt,
        });
      } catch {
        summary.failed += 1;
        continue;
      }
      if (!lease) {
        summary.skippedInactive += 1;
        continue;
      }
      summary.claimed += 1;

      try {
        const current = requireCurrentLeaseControl({
          controlRepository,
          identity,
          lease,
        });
        const snapshot = requireCurrentSnapshot({ controlRepository, current });
        const expectedCursorAfter = canonicalTimestamp(lease.cursorAfter, "cursorAfter");
        if (expectedCursorAfter > throughInclusive) {
          throw scannerError("schedule_scanner_now_before_cursor");
        }
        if (exceedsScanWindow(expectedCursorAfter, throughInclusive)) {
          summary.recoveryRequired += 1;
          continue;
        }
        const scheduledFor = dueTimeCalculator({
          cronExpression: snapshot.cron,
          timezone: snapshot.timezone,
          afterExclusive: expectedCursorAfter,
          throughInclusive,
        });
        if (scheduledFor !== null) canonicalTimestamp(scheduledFor, "scheduledFor");

        const committedAt = canonicalTimestamp(currentTime(), "currentTime");
        const committed = controlRepository.commitCursorAndPrepareIntent({
          ...identity,
          leaseId: lease.leaseId,
          ownerDigest: lease.ownerDigest,
          fencingToken: lease.fencingToken,
          expectedCursorAfter,
          throughInclusive,
          scheduledFor,
          committedAt,
        });
        summary.cursorAdvanced += 1;
        if (!committed.intent) {
          summary.noDue += 1;
          continue;
        }
        summary.intentsPrepared += 1;
        try {
          runIntentDispatcher.dispatchOne({
            tenantScope: committed.intent.tenantScope,
            runId: committed.intent.runId,
            expectedIntentVersion: committed.intent.intentVersion,
          });
          summary.dispatched += 1;
        } catch {
          summary.dispatchDeferred += 1;
        }
      } catch (error) {
        if (isFenceError(error)) summary.fenced += 1;
        else summary.failed += 1;
      } finally {
        try {
          const releasedAt = canonicalTimestamp(currentTime(), "currentTime");
          controlRepository.releaseScannerLease({
            ...identity,
            leaseId: lease.leaseId,
            ownerDigest: lease.ownerDigest,
            fencingToken: lease.fencingToken,
            releasedAt,
          });
        } catch (error) {
          if (isFenceError(error)) summary.fenced += 1;
          else summary.failed += 1;
        }
      }
    }

    return deepFreeze({
      contractVersion: SCHEDULE_ONE_SHOT_SCANNER_COORDINATOR_CONTRACT_VERSION,
      reconciliation,
      ...summary,
    });
  }

  return Object.freeze({
    contractVersion: SCHEDULE_ONE_SHOT_SCANNER_COORDINATOR_CONTRACT_VERSION,
    runOnce,
  });
}

function normalizeListedControl(value, tenantScope) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw scannerError("schedule_scanner_control_invalid");
  }
  const identity = {
    tenantScope: token(value.tenantScope, "tenantScope"),
    employeeId: token(value.employeeId, "employeeId"),
    scheduleId: token(value.scheduleId, "scheduleId"),
  };
  if (identity.tenantScope !== tenantScope) throw scannerError("schedule_scanner_tenant_mismatch");
  if (value.activationState !== "active" || value.effectiveActive !== true ||
    typeof value.activationSnapshotId !== "string" || typeof value.activationSnapshotDigest !== "string") {
    throw scannerError("schedule_scanner_control_inactive");
  }
  return identity;
}

function requireCurrentLeaseControl({ controlRepository, identity, lease }) {
  const control = controlRepository.getControl(identity);
  const matches = control && control.activationState === "active" && control.effectiveActive === true &&
    control.scanner?.leaseId === lease.leaseId && control.scanner?.ownerDigest === lease.ownerDigest &&
    control.scanner?.fencingToken === lease.fencingToken && control.activationVersion === lease.activationVersion &&
    control.cursorAfter === lease.cursorAfter;
  if (!matches) throw scannerError("schedule_scanner_lease_fenced");
  return control;
}

function requireCurrentSnapshot({ controlRepository, current }) {
  const resolved = controlRepository.resolveActiveActivationSnapshot({
    tenantScope: current.tenantScope,
    employeeId: current.employeeId,
    scheduleId: current.scheduleId,
    activationVersion: current.activationVersion,
    activationSnapshotId: current.activationSnapshotId,
    activationSnapshotDigest: current.activationSnapshotDigest,
  });
  const snapshot = normalizeRunnableScheduleActivationSnapshot(resolved?.snapshot);
  const snapshotId = `schedule_activation_snapshot_${snapshot.snapshotDigest}`;
  const matches = snapshotId === current.activationSnapshotId &&
    snapshot.snapshotDigest === current.activationSnapshotDigest &&
    snapshot.activationVersion === current.activationVersion &&
    snapshot.registrationVersion === current.registrationVersion &&
    snapshot.tenantScope === current.tenantScope && snapshot.employeeId === current.employeeId &&
    snapshot.scheduleId === current.scheduleId && snapshot.scheduleVersion === current.scheduleVersion &&
    snapshot.schedulePolicyDigest === current.schedulePolicyDigest &&
    snapshot.executionContractDigest === current.executionContractDigest &&
    snapshot.missedSlotPolicy === "latest_only";
  if (!matches) throw scannerError("schedule_scanner_activation_snapshot_mismatch");
  return snapshot;
}

function exceedsScanWindow(afterExclusive, throughInclusive) {
  const afterMs = Date.parse(afterExclusive);
  const throughMs = Date.parse(throughInclusive);
  return throughMs - afterMs > MAX_DUE_SCAN_WINDOW_MS;
}

function isFenceError(error) {
  const code = String(error?.code || "");
  return code === "schedule_scanner_lease_fenced" ||
    code === "schedule_control_scanner_fenced" ||
    code === "schedule_control_scanner_lease_expired" ||
    code === "schedule_control_activation_snapshot_not_active" ||
    code === "schedule_control_cursor_conflict";
}

function assertDependencies({ controlRepository, dueTimeCalculator, listActiveSnapshotControls, runIntentDispatcher }) {
  for (const method of [
    "claimScannerLease",
    "commitCursorAndPrepareIntent",
    "getControl",
    "releaseScannerLease",
    "resolveActiveActivationSnapshot",
  ]) {
    if (typeof controlRepository?.[method] !== "function") {
      throw new TypeError(`schedule scanner coordinator requires controlRepository.${method}`);
    }
  }
  if (typeof dueTimeCalculator !== "function") {
    throw new TypeError("schedule scanner coordinator requires dueTimeCalculator");
  }
  if (typeof listActiveSnapshotControls !== "function") {
    throw new TypeError("schedule scanner coordinator requires listActiveSnapshotControls");
  }
  for (const method of ["dispatchOne", "runOnce"]) {
    if (typeof runIntentDispatcher?.[method] !== "function") {
      throw new TypeError(`schedule scanner coordinator requires runIntentDispatcher.${method}`);
    }
  }
}

function canonicalTimestamp(value, field) {
  if (typeof value !== "string") throw scannerError(`schedule_scanner_${field}_invalid`);
  const timestamp = new Date(value);
  if (!Number.isFinite(timestamp.getTime()) || timestamp.toISOString() !== value) {
    throw scannerError(`schedule_scanner_${field}_invalid`);
  }
  return value;
}

function token(value, field) {
  const text = String(value || "").trim();
  if (!text || text.length > 240 || !/^[A-Za-z0-9][A-Za-z0-9._:@-]*$/.test(text)) {
    throw scannerError(`schedule_scanner_${field}_invalid`);
  }
  return text;
}

function digest(value, field) {
  const text = String(value || "").trim().toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(text)) throw scannerError(`schedule_scanner_${field}_invalid`);
  return text;
}

function boundedInteger(value, minimum, maximum, field) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw scannerError(`schedule_scanner_${field}_invalid`);
  }
  return value;
}

function scannerError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value)) deepFreeze(child);
  return value;
}

export {
  SCHEDULE_ONE_SHOT_SCANNER_COORDINATOR_CONTRACT_VERSION,
  createScheduleOneShotScannerCoordinator,
};
