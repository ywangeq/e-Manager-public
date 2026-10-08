export function createFxiaokeReviewWritebackExecution({
  classifyError,
  currentAuthorization,
  authorizationDigest,
  effectService,
  writebackAdapter,
} = {}) {
  return async function execute(value) {
    const digest = authorizationDigest(value);
    const run = (mode) => async ({ evidence, reviewComment, signal, task, triggerEvent, writebackBinding }) => {
      try {
        const disposition = await writebackAdapter[mode]({
          binding: writebackBinding,
          completedAt: evidence.sealedAt,
          event: triggerEvent.event,
          reviewComment,
          signal,
          subject: triggerEvent.event.subject,
          taskRef: task.taskId,
        });
        return projectDisposition(disposition);
      } catch (error) {
        throw classifyError(error) || error;
      }
    };
    return effectService.execute({
      ...value,
      adapterIdentity: { adapterId: writebackAdapter.adapterId, actionCode: "write_trigger_review_result", authorizationDigest: digest },
      authorizeCurrentOperation: async () => currentAuthorization({ authorizationDigest: digest, triggerEvent: value.triggerEvent, writebackBinding: value.writebackBinding }),
      recover: run("recoverReview"),
      effect: run("writeReview"),
    });
  };
}

function projectDisposition(disposition) {
  const safeResultCode = {
    written_confirmed: "external_write_succeeded_confirmed",
    duplicate: "external_write_already_applied",
    stale_skipped: "external_write_stale_skipped",
  }[disposition?.status];
  return safeResultCode ? { status: "succeeded", safeResultCode } : { status: "unknown", safeResultCode: "external_write_outcome_unknown" };
}
