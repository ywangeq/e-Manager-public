import { groupPlanningReview } from "./groupRunDemoFlow.js";

export function mergeGroupHistory(current, items) {
  const byGoal = new Map();
  const incoming = [];
  items.forEach((item, index) => {
    const key = item.goalId || item.key;
    if (!key) return;
    const normalized = { ...item, key: item.runId || key, review: item.planning?.planDraft ? groupPlanningReview(item.planning) : null, order: index };
    // Every Run remains inspectable; only draft/planning records collapse per Goal.
    if (item.runId) incoming.push(normalized);
    else if (!byGoal.has(key)) byGoal.set(key, normalized);
  });
  incoming.push(...byGoal.values());
  incoming.sort((a, b) => a.order - b.order);
  const keys = new Set(incoming.map(item => item.key));
  // Unsaved submissions are transient UI feedback, never recovered as task truth.
  const local = current.filter(item => !item.goalId && !keys.has(item.key) && ["planning", "starting", "failed"].includes(item.status));
  return [...local, ...incoming.map(({ order, ...item }) => {
    const previous = current.find(old => old.key === item.key);
    return { ...previous, ...item, ...(previous?.displayRevision > (item.displayRevision || 0) ? { title: previous.title, displayRevision: previous.displayRevision } : {}) };
  })];
}

export const runStatusLabel = (status) => ({ planning: "正在生成计划", draft: "待采纳", starting: "正在启动", running: "执行中", queued: "排队中", pending: "等待执行", waiting: "等待中", completed: "已完成", failed: "失败", blocked: "受阻", resume_required: "需要恢复", awaiting_review: "等待审核", execution_completed: "执行结束，交付待就绪", awaiting_acceptance: "等待用户验收", accepted: "已验收", canceled: "已取消", rejected: "已拒绝", timed_out: "已超时", reconcile_required: "需要核对" }[status] || status || "待同步");
