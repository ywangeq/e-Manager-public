function validTime(value) {
  return typeof value === "string" && value.trim() && Number.isFinite(Date.parse(value)) ? value : null;
}

export function cockpitRecordTime(entry) {
  const item = entry?.item;
  if (!item) return null;
  if (entry.kind === "task") {
    const finished = validTime(item.finishedAt);
    if (finished) return { label: "结束于", value: finished };
    const started = validTime(item.startedAt);
    if (started) return { label: "开始于", value: started };
    const value = validTime(item.updatedAt);
    if (value) return { label: "最近更新", value };
    const submitted = validTime(item.submittedAt);
    return submitted ? { label: "提交于", value: submitted } : null;
  }
  if (entry.kind === "goal") {
    const decision = validTime(item.projection?.acceptance?.decidedAt);
    if (decision) return { label: item.projection.acceptance.decision === "accepted" ? "验收通过于" : "验收决定于", value: decision };
    const value = validTime(item.projection?.executionUpdatedAt);
    if (value) return { label: "执行更新", value };
    const created = validTime(item.createdAt);
    return created ? { label: "创建于", value: created } : null;
  }
  if (entry.kind === "automation") {
    const updated = validTime(item.updatedAt);
    return updated ? { label: "最近更新", value: updated } : null;
  }
  return null;
}

export function cockpitRecordTimeLabel(entry) {
  const time = cockpitRecordTime(entry);
  return time ? `${time.label} ${new Intl.DateTimeFormat("zh-CN", { year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(new Date(time.value))}` : "记录时间暂不可用";
}

export function groupStepProgress(projection) {
  const steps = projection?.steps;
  if (!Array.isArray(steps) || !steps.length) return null;
  const completed = steps.filter(step => step?.status === "completed").length;
  return { completed, total: steps.length, percent: 100 * completed / steps.length, label: `步骤进度 ${completed}/${steps.length} 步已完成` };
}
