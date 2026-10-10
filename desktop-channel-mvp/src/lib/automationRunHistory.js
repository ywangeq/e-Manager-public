// Read the existing actor-fenced detail projection; never derive runs from notifications.
export async function readAutomationRunHistory(automations, desktopApi, isCurrent = () => true) {
  const runs = {}, failedIds = [];
  for (let offset = 0; offset < automations.length && isCurrent(); offset += 4) {
    const batch = automations.slice(offset, offset + 4);
    const results = await Promise.allSettled(batch.map(async rule => {
      const value = await desktopApi.personalAutomations({action:"detail", automationId:rule.automationId});
      if (!value?.ok || value.automation?.automationId !== rule.automationId || value.automation?.employeeId !== rule.employeeId || !Array.isArray(value.runs)) throw new Error("history_unavailable");
      return value.runs.map(run => ({taskId:run.taskId, scheduledFor:run.scheduledFor, status:run.status}));
    }));
    if (!isCurrent()) return null;
    results.forEach((result,index) => {
      const id = batch[index].automationId;
      if (result.status === "fulfilled") runs[id] = result.value;
      else failedIds.push(id);
    });
  }
  return isCurrent() ? {runs, failedIds} : null;
}
