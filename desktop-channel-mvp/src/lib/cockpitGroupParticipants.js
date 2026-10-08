const roles = { delegate: "执行", consult: "咨询", review: "审校", summary: "汇总" };

export function cockpitGroupParticipants(goal, employees = []) {
  let source = null;
  let planned = false;
  if (goal?.runId) {
    const projection = goal.projection;
    if (projection?.contractVersion === "group-run-safe-projection.v1" && projection.goalId === goal.goalId && projection.runId === goal.runId &&
        projection.groupId === goal.groupId && projection.groupVersion === goal.groupVersion) source = projection;
  } else if (goal?.status === "draft") {
    const { goal: draftGoal, groupVersion, planDraft } = goal.planning || {};
    if (planDraft?.contractVersion === "group-plan-draft.v1" && draftGoal?.goalId === goal.goalId && planDraft.goalId === goal.goalId && planDraft.goalRevision === draftGoal?.revision &&
        planDraft.groupId === groupVersion?.groupId && planDraft.groupVersion === groupVersion?.version) {
      source = planDraft;
      planned = true;
    }
  }
  if (!Array.isArray(source?.steps) || !source.steps.length || source.steps.some(step =>
    !step.employeeId || !step.employeeVersion || !roles[step.kind])) {
    return { members: [], label: goal?.runId ? "成员待同步" : "成员待确认" };
  }
  const byEmployee = new Map();
  for (const step of source.steps) {
    let member = byEmployee.get(step.employeeId);
    if (!member) {
      member = { id: step.employeeId, versions: [], assignments: [] };
      byEmployee.set(step.employeeId, member);
    }
    if (!member.versions.includes(step.employeeVersion)) member.versions.push(step.employeeVersion);
    const role = roles[step.kind];
    const status = planned ? "planned" : step.status;
    if (!member.assignments.some(item => item.role === role && item.status === status)) member.assignments.push({ role, status });
  }
  const members = [...byEmployee.values()].map(member => {
    const employee = member.versions.length === 1
      ? employees.find(item => item.id === member.id && item.version === member.versions[0]) : null;
    return { ...member, employee, name: employee?.name || "员工资料待同步" };
  });
  return { members, label: `${members.length} 位${planned ? "计划成员" : "参与员工"}` };
}
