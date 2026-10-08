export async function fetchTriggerManagement() {
  const response = await fetch("/api/trigger-management", { credentials: "include" });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.message || data.error || "Trigger 管理数据读取失败");
  return data;
}

export function triggerStatusLabel(status) {
  return {
    active: "已启用",
    approved: "已审核",
    pending_review: "待审核",
    completed: "已完成",
    succeeded: "已完成",
    failed: "失败",
    blocked: "受阻",
    timed_out: "超时",
    canceled: "已取消",
    queued: "排队中",
    running: "运行中",
    waiting: "等待中",
    not_submitted: "未提交",
  }[status] || status || "未知";
}

export function triggerStatusTone(status) {
  if (["active", "approved", "completed", "succeeded"].includes(status)) return "good";
  if (["pending_review", "queued", "running", "waiting"].includes(status)) return "info";
  if (["blocked", "timed_out"].includes(status)) return "warn";
  if (["failed", "canceled"].includes(status)) return "bad";
  return "muted";
}
