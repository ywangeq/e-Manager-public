import { isDesktopMyTaskActiveStatus } from "../../shared/desktop-my-tasks.mjs";

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
  const goalWarnings = goals.filter((item) => ["awaiting_review", "awaiting_acceptance", "execution_completed", "rejected", "blocked", "reconcile_required", "resume_required", "failed"].includes(cockpitGoalStatus(item)));
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

export function cockpitAttention({ tasks = [], goals = [], automations = [] } = {}) {
  const groupActions = {
    draft: ["确认计划", "计划草案待采纳"],
    awaiting_review: ["查看审核", "等待审核完成"],
    awaiting_acceptance: ["验收交付", "交付物已就绪，等待你验收"],
    execution_completed: ["查看交付", "执行结束，交付物尚未就绪"],
    rejected: ["查看验收结果", "交付验收未通过"],
    blocked: ["查看阻塞", "目标执行受阻"], failed: ["查看失败原因", "目标执行失败"],
    reconcile_required: ["核对执行状态", "需要核对执行结果"], resume_required: ["查看并恢复", "目标等待恢复"],
  };
  const groupTaskIds = new Set(cockpitGroupSteps(goals).map(({step}) => step.taskId).filter(Boolean));
  return [
    ...goals.filter((goal) => groupActions[cockpitGoalStatus(goal)]).map((goal) => {
      const [action, reason] = groupActions[cockpitGoalStatus(goal)];
      return { key: `goal:${goal.goalId}`, kind: "goal", item: goal, title: goal.title || "Group 目标", action, reason };
    }),
    ...tasks.filter((task) => !groupTaskIds.has(task.id) && task.sourceSystemId !== "group_studio" && task.taskType !== "group_step" && ["blocked", "failed", "timeout", "lost", "rejected", "waiting", "pending_file_intake", "pending_remote_resource"].includes(task.status)).map((task) => ({
      key: `task:${task.id}`, kind: "task", item: task, title: cockpitTaskTitle(task), action: "查看详情", reason: task.nextGate || task.statusLabel || "任务需要关注",
    })),
    ...automations.filter((item) => item.state === "attention_required").map((item) => ({
      key: `automation:${item.automationId}`, kind: "automation", item, title: "定时任务需要关注", action: "查看原因与处理", reason: "查看运行记录及可执行操作",
    })),
  ];
}

export function cockpitWorkItems({ tasks = [], goals = [], automations = [] } = {}) {
  const groupTaskIds = new Set(cockpitGroupSteps(goals).map(({step}) => step.taskId).filter(Boolean));
  return [
    ...automations.filter((item) => item.state === "attention_required").map((item) => ({ key: `automation:${item.automationId}`, kind: "automation", item, title: "定时任务需要关注", status: "attention_required" })),
    ...goals.map((goal) => ({ key: `goal:${goal.goalId}`, kind: "goal", item: goal, title: goal.title || "Group 目标", status: cockpitGoalStatus(goal) })),
    ...tasks.filter((task) => !groupTaskIds.has(task.id) && task.sourceSystemId !== "group_studio" && task.taskType !== "group_step").map((task) => ({ key: `task:${task.id}`, kind: "task", item: task, title: cockpitTaskTitle(task), status: task.status })),
  ];
}

export function cockpitFilterItems(items, filter, query = "") {
  const search = query.trim().toLocaleLowerCase();
  return items.filter((row) => {
    const matches = filter === "all" || (filter === "recent" ? ["completed", "accepted"].includes(row.status)
      : filter === "queued" ? ["queued", "pending"].includes(row.status)
      : filter === "attention" ? ["attention_required", "draft", "awaiting_review", "awaiting_acceptance", "execution_completed", "blocked", "failed", "timeout", "lost", "rejected", "reconcile_required", "resume_required", "waiting", "pending_file_intake", "pending_remote_resource"].includes(row.status)
      : isDesktopMyTaskActiveStatus(row.status) || ["planning", "starting"].includes(row.status));
    return matches && (!search || `${row.title} ${row.item.employeeName || ""}`.toLocaleLowerCase().includes(search));
  });
}
