function createRuntimeTaskEvidenceRecorder({ repository, now = () => new Date() } = {}) {
  if (typeof repository?.recordRuntimeEvidenceWithLease !== "function" ||
    typeof repository?.recordRuntimeActivityWithLease !== "function" ||
    typeof repository?.recordRuntimeEfficiencyWithLease !== "function" ||
    typeof repository?.recordRuntimeProvenanceWithLease !== "function") {
    throw new TypeError("runtime task evidence recorder requires canonical task repository");
  }
  if (typeof now !== "function") throw new TypeError("runtime task evidence recorder requires clock");

  function record({ evidence, runtimeTask } = {}) {
    const lease = runtimeTask?.lease;
    if (!runtimeTask?.taskId || !runtimeTask?.tenantScope || !lease) {
      throw recorderError("runtime_evidence_task_lease_missing");
    }
    const stored = repository.recordRuntimeEvidenceWithLease({
      tenantScope: runtimeTask.tenantScope,
      taskId: runtimeTask.taskId,
      leaseId: lease.leaseId,
      workerIdDigest: lease.workerIdDigest,
      fencingToken: lease.fencingToken,
      evidence,
      now: now(),
    });
    if (!stored) throw recorderError("execution_task_ownership_lost");
    return stored;
  }

  function recordActivity({ activitySnapshot, runtimeTask } = {}) {
    const lease = runtimeTask?.lease;
    if (!runtimeTask?.taskId || !runtimeTask?.tenantScope || !lease) {
      throw recorderError("runtime_evidence_task_lease_missing");
    }
    const stored = repository.recordRuntimeActivityWithLease({
      tenantScope: runtimeTask.tenantScope,
      taskId: runtimeTask.taskId,
      leaseId: lease.leaseId,
      workerIdDigest: lease.workerIdDigest,
      fencingToken: lease.fencingToken,
      activitySnapshot,
      now: now(),
    });
    if (!stored) throw recorderError("execution_task_ownership_lost");
    return stored;
  }

  function recordProvenance({ sourceSnapshot, runtimeTask } = {}) {
    const lease = runtimeTask?.lease;
    if (!runtimeTask?.taskId || !runtimeTask?.tenantScope || !lease) {
      throw recorderError("runtime_evidence_task_lease_missing");
    }
    const stored = repository.recordRuntimeProvenanceWithLease({
      tenantScope: runtimeTask.tenantScope,
      taskId: runtimeTask.taskId,
      leaseId: lease.leaseId,
      workerIdDigest: lease.workerIdDigest,
      fencingToken: lease.fencingToken,
      sourceSnapshot,
      now: now(),
    });
    if (!stored) throw recorderError("execution_task_ownership_lost");
    return stored;
  }

  function recordEfficiency({ mutation, runtimeTask } = {}) {
    const lease = runtimeTask?.lease;
    if (!runtimeTask?.taskId || !runtimeTask?.tenantScope || !lease) {
      throw recorderError("runtime_evidence_task_lease_missing");
    }
    const stored = repository.recordRuntimeEfficiencyWithLease({
      tenantScope: runtimeTask.tenantScope,
      taskId: runtimeTask.taskId,
      leaseId: lease.leaseId,
      workerIdDigest: lease.workerIdDigest,
      fencingToken: lease.fencingToken,
      mutation,
      now: now(),
    });
    if (!stored) throw recorderError("execution_task_ownership_lost");
    return stored;
  }

  return Object.freeze({
    contractVersion: "runtime-task-evidence-recorder.v1",
    record,
    recordActivity,
    recordEfficiency,
    recordProvenance,
  });
}

function recorderError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

export { createRuntimeTaskEvidenceRecorder };
