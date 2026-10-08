// The card deadline limits first acceptance; an accepted approval has a bounded execution deadline.
export function confirmationRetentionDeadline(record) {
  return record?.acceptance?.executeBeforeMs ?? record?.expiresAtMs ?? 0;
}

export function acceptedConfirmationMatches(record, { contextBinding, executionInputBinding, taskId } = {}) {
  return Boolean(record?.acceptance && contextBinding && executionInputBinding && taskId
    && record.contextBinding === contextBinding
    && record.executionInputBinding === executionInputBinding
    && record.acceptance.taskId === taskId);
}
