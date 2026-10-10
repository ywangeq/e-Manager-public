import { isDesktopMyTaskActiveStatus } from "../../shared/desktop-my-tasks.mjs";

// Only explicit human review gates belong in the personal approval inbox.
export function cockpitNeedsAttention(status) {
  return ["draft", "awaiting_acceptance"].includes(status);
}

export function cockpitGoalStatus(item) {
  return item?.projection?.status || item?.status || "unavailable";
}

export function cockpitGroupSteps(goals = []) {
  return goals.flatMap((goal) => Array.isArray(goal?.projection?.steps)
    ? goal.projection.steps.map((step) => ({ goal, step })) : []);
}

export function cockpitOverview({ tasks = [], automations = [], goals = [] } = {}) {
  const groupTaskIds = new Set(cockpitGroupSteps(goals).map(({step}) => step.taskId).filter(Boolean));
  tasks = tasks.filter(task => !groupTaskIds.has(task.id) && task.sourceSystemId !== "group_studio" && task.taskType !== "group_step");
  const runningGoals = goals.filter(goal => ["running", "planning", "starting"].includes(cockpitGoalStatus(goal)));
  const acceptedGoals = goals.filter(goal => cockpitGoalStatus(goal) === "accepted").sort((a, b) => Date.parse(b.projection?.acceptance?.decidedAt || 0) - Date.parse(a.projection?.acceptance?.decidedAt || 0));
  const runningTasks = tasks.filter((task) => isDesktopMyTaskActiveStatus(task.status));
  const completedTasks = tasks.filter((task) => task.status === "completed");
  const queuedTasks = tasks.filter((task) => task.status === "queued");
  const attentionAutomations = automations.filter((item) => item.state === "attention_required");
  const draftGoals = goals.filter((item) => cockpitGoalStatus(item) === "draft");
  const goalWarnings = goals.filter((item) => ["awaiting_review", "awaiting_acceptance", "execution_completed", "blocked", "reconcile_required", "resume_required"].includes(cockpitGoalStatus(item)));
  return {
    runningTasks, runningGoals, acceptedGoals,
    completedTasks: [...completedTasks].sort((a, b) => Date.parse(b.finishedAt || b.updatedAt || 0) - Date.parse(a.finishedAt || a.updatedAt || 0)),
    queuedTasks,
    attentionAutomations,
    draftGoals,
    goalWarnings,
  };
}

export function cockpitTaskTitle(task) {
  return task.taskTitle?.trim() || "任务名称暂不可用";
}

export function cockpitInteractionItems(interactions = [], now = Date.now()) {
  return interactions.filter(item => item?.id && item.employeeId && ["parameter","confirmation"].includes(item.kind) && Date.parse(item.expiresAt) > now)
    .map(item => ({key:`interaction:${item.kind}:${item.employeeId}:${item.id}`,kind:"interaction",item,status:"draft",title:item.displayTitle || "待处理事项",
      action:item.kind === "confirmation" ? "审核操作" : "回答问题",reason:item.kind === "confirmation" ? "本次操作等待你的确认" : item.requestKind === "clarification" ? "员工需要你补充信息" : "请补充业务参数"}));
}

export function cockpitAttention({ tasks = [], goals = [], automations = [], interactions = [] } = {}) {
  const groupActions = {
    draft: ["确认计划", "计划草案待采纳"],
    awaiting_acceptance: ["验收交付", "交付物已就绪，等待你验收"],
  };
  const groupTaskIds = new Set(cockpitGroupSteps(goals).map(({step}) => step.taskId).filter(Boolean));
  return [
    ...cockpitInteractionItems(interactions),
    ...goals.filter((goal) => groupActions[cockpitGoalStatus(goal)]).map((goal) => {
      const [action, reason] = groupActions[cockpitGoalStatus(goal)];
      return { key: `goal:${goal.goalId}`, kind: "goal", item: goal, title: goal.title || "Group 目标", action, reason };
    }),
    ...tasks.filter((task) => !groupTaskIds.has(task.id) && task.sourceSystemId !== "group_studio" && task.taskType !== "group_step" && cockpitNeedsAttention(task.status)).map((task) => ({
      key: `task:${task.id}`, kind: "task", item: task, title: cockpitTaskTitle(task), action: "查看详情", reason: task.nextGate || task.statusLabel || "任务需要关注",
    })),
  ];
}

export function cockpitWorkItems({ tasks = [], goals = [], automations = [], interactions = [] } = {}) {
  const groupTaskIds = new Set(cockpitGroupSteps(goals).map(({step}) => step.taskId).filter(Boolean));
  return [
    ...cockpitInteractionItems(interactions),
    ...automations.filter((item) => item.state === "attention_required").map((item) => ({ key: `automation:${item.automationId}`, kind: "automation", item, title: "定时任务需要关注", status: "attention_required" })),
    ...goals.map((goal) => ({ key: `goal:${goal.goalId}`, kind: "goal", item: goal, title: goal.title || "Group 目标", status: cockpitGoalStatus(goal) })),
    ...tasks.filter((task) => !groupTaskIds.has(task.id) && task.sourceSystemId !== "group_studio" && task.taskType !== "group_step").map((task) => ({ key: `task:${task.id}`, kind: "task", item: task, title: cockpitTaskTitle(task), status: task.status })),
  ];
}

export function cockpitFilterItems(items, filter, query = "") {
  const search = query.trim().toLocaleLowerCase();
  return items.filter((row) => {
    const matches = filter === "all" || (filter === "recent" ? ["completed", "accepted", "canceled", "failed", "timeout", "timed_out", "lost", "rejected"].includes(row.status)
      : filter === "queued" ? ["queued", "pending"].includes(row.status)
      : filter === "attention" ? cockpitNeedsAttention(row.status)
      : isDesktopMyTaskActiveStatus(row.status) || ["planning", "starting"].includes(row.status));
    return matches && (!search || `${row.title} ${row.item.employeeName || ""}`.toLocaleLowerCase().includes(search));
  });
}
