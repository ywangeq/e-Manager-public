export function workbenchTaskHistory(groups = [], tasks = [], automations = []) {
  const direct = tasks.filter(task => ["desktop-device-channel", "personal-automation"].includes(task.sourceSystemId) &&
    ["digital_employee_chat", "desktop_material_chat"].includes(task.taskType))
    .map(task => ({ key: `employee-task:${task.id}`, kind: "employee", taskId: task.id,
      employeeId: task.employeeId, employeeName: task.employeeName, title: task.taskTitle || "员工任务",
      status: task.status, sourceSystemId: task.sourceSystemId, createdAt: task.submittedAt, updatedAt: task.updatedAt,
      startedAt: task.startedAt, finishedAt: task.finishedAt }));
  const rules = new Map();
  for (const rule of automations) {
    if (!rule.automationId || !rule.employeeId) continue;
    const previous = rules.get(rule.automationId);
    if (!previous || rule.revision > previous.revision) rules.set(rule.automationId, rule);
  }
  const scheduled = [...rules.values()].map(rule => {
    const source = tasks.find(task => task.id === rule.sourceTaskId && task.employeeId === rule.employeeId);
    const latest = tasks.find(task => task.id === rule.lastTaskId && task.employeeId === rule.employeeId);
    return { key: `automation:${rule.automationId}`, kind: "automation", automationId: rule.automationId,
      employeeId: rule.employeeId, title: source?.taskTitle || "个人定时任务", state: rule.state,
      runCount: rule.runCount, latestTaskStatus: latest?.status || "", latestTaskId: rule.lastTaskId,
      latestTaskTime: latest ? { updatedAt: latest.updatedAt, submittedAt: latest.submittedAt, startedAt: latest.startedAt, finishedAt: latest.finishedAt } : null };
  });
  const recent = [...groups.map(item => ({ ...item, kind: "group" })), ...direct]
    .sort((a, b) => timestamp(b) - timestamp(a)).slice(0, 50);
  return [...scheduled, ...recent];
}
export const automationRuleLabel = state => ({ active: "已启用", paused: "已暂停", disabled: "已禁用", exhausted: "已结束", attention_required: "需要处理" }[state] || "待同步");
function timestamp(item) {
  return Date.parse(item.updatedAt || item.createdAt || item.submittedAt || "") || 0;
}
