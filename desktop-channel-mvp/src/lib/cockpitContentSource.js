export function cockpitContentSource(reference, { tasks = [], goals = [], employees = [] } = {}) {
  if (!reference?.taskId || !reference.employeeId) return { employeeName: "来源员工暂无记录", taskName: "来源任务暂无记录" };
  const task = tasks.find(item => item.id === reference.taskId && item.employeeId === reference.employeeId);
  const employee = employees.find(item => item.id === reference.employeeId);
  for (const goal of goals) {
    const step = goal.projection?.steps?.find(item => item.taskId === reference.taskId && item.employeeId === reference.employeeId &&
      item.artifacts?.some(artifact => artifact.artifactId === reference.artifactId));
    if (!step) continue;
    return {
      employeeName: task?.employeeName || employee?.name || "员工名称暂不可用",
      taskName: step.objective || task?.taskTitle || "Group 工作步骤",
      context: `${goal.title || "Group 目标"}${Number.isSafeInteger(goal.goalRevision) ? ` · 第 ${goal.goalRevision} 轮` : ""}`,
      taskId: reference.taskId, goalId: goal.goalId, runId: goal.runId, stepId: step.stepId,
    };
  }
  return {
    employeeName: task?.employeeName || employee?.name || "员工名称暂不可用",
    taskName: task?.taskTitle || "来源任务名称未加载",
    taskId: reference.taskId,
    taskLoaded: Boolean(task),
  };
}
