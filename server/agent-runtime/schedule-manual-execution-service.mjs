import crypto from "node:crypto";

// Admission is performed by the authenticated management route and rechecked by
// controlRepository.authorizeManualRun. This service owns request identity only;
// preparation and dispatch reuse the same durable ledgers as Cron.
export function createScheduleManualExecutionService({ controlRepository, dispatcher, requestHmacKey } = {}) {
  if (typeof controlRepository?.prepareManualIntent !== "function" || typeof dispatcher?.dispatchOne !== "function" ||
    !Buffer.isBuffer(requestHmacKey) || requestHmacKey.length !== 32) {
    throw new TypeError("Schedule manual execution requires control, dispatcher and a server identity key");
  }
  const key = Buffer.from(requestHmacKey);
  return Object.freeze({
    execute({ tenantScope, employeeId, scheduleId, expectedControlVersion, requestToken, actor } = {}) {
      if (typeof requestToken !== "string" || !/^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(requestToken) ||
        !actor?.principalId || actor.principalId === "unresolved-principal" || !actor.identitySource) {
        throw failure("schedule_manual_request_invalid");
      }
      const requestDigest = crypto.createHmac("sha256", key).update(JSON.stringify([
        "schedule-manual-request.v1", tenantScope, employeeId, scheduleId,
        actor.identitySource, actor.principalId, requestToken.toLowerCase(),
      ])).digest("hex");
      const intent = controlRepository.prepareManualIntent({ tenantScope, employeeId, scheduleId,
        expectedControlVersion, requestDigest, actor });
      if (["prepared", "reconcile_required", "submitted"].includes(intent.intentState)) {
        dispatcher.dispatchOne({ tenantScope, runId: intent.runId, expectedIntentVersion: intent.intentVersion });
      }
      const current = controlRepository.getIntent(intent.runId, { tenantScope });
      if (!current) throw failure("schedule_manual_result_unavailable");
      return Object.freeze({ contractVersion: "schedule-manual-execution.v1", runId: current.runId,
        scheduledFor: current.scheduledFor, state: current.intentState,
        executionTaskId: current.executionTaskId || current.expectedExecutionTaskId,
        source: "manual", observedTaskStatus: current.observedTaskStatus || null });
    },
  });
}

function failure(code) { return Object.assign(new Error(code), { code }); }
