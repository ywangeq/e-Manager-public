function operationReceiptContextForExecutionOwnership(ownership = null) {
  const task = ownership?.task;
  const lease = ownership?.lease;
  if (!task?.tenantScope || !task?.taskId || !lease?.leaseId || !lease?.workerIdDigest ||
    !Number.isSafeInteger(lease?.fencingToken) || lease.fencingToken <= 0) return null;
  return Object.freeze({
    repositoryContext: Object.freeze({
      tenantScope: task.tenantScope,
      taskId: task.taskId,
      leaseId: lease.leaseId,
      workerIdDigest: lease.workerIdDigest,
      fencingToken: lease.fencingToken,
    }),
  });
}

export { operationReceiptContextForExecutionOwnership };
