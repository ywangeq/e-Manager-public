export function canRequestGroupAdvance(projection) {
  return projection?.activation === "active" && !projection.cancellationRequested &&
    ["running", "blocked", "awaiting_review"].includes(projection.status) &&
    (projection.steps || []).some(step => step.status === "pending" || step.blockCode === "dependency_failed");
}

// Polling is presentation-driven. Only Center decides which steps can run,
// revalidates authorization and applies the canonical CAS/dependency gates.
export function createGroupRunFollower({ readProjection, advance }) {
  let stopped = false, refreshing = false, attemptedState = "";
  return Object.freeze({
    stop() { stopped = true; },
    async refresh() {
      if (stopped || refreshing) return null;
      refreshing = true;
      try {
        const projection = await readProjection();
        if (stopped) return null;
        const steps = projection.steps || [];
        const shouldAskCenter = canRequestGroupAdvance(projection);
        const state = JSON.stringify([projection.runId, projection.casRevision, steps.map(step => [step.stepId, step.status, step.taskRevision])]);
        if (shouldAskCenter && state !== attemptedState) {
          // One attempt per observed state; an ambiguous response is resolved by
          // the next read, never by optimistic local task updates or replay.
          attemptedState = state;
          await advance({ runId: projection.runId, expectedRevision: projection.casRevision });
          if (stopped) return null;
          const updated = await readProjection();
          return stopped ? null : updated;
        }
        return projection;
      } finally { refreshing = false; }
    },
  });
}
