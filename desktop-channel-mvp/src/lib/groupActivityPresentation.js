import { desktopTaskActivityStatusLabel } from "../../shared/desktop-task-activity.mjs";

const SAFE_CODE = /^[A-Za-z0-9][A-Za-z0-9._:@-]{0,159}$/;
const safeCode = value => typeof value === "string" && SAFE_CODE.test(value) ? value : "";

export function groupActivityDetails(activities = []) {
  return activities.filter(item => item && ["skill", "tool"].includes(item.kind))
    .slice().sort((a, b) => (a.sequence || 0) - (b.sequence || 0))
    .map(item => ({
      activityId: item.activityId,
      sequence: item.sequence,
      displayName: item.displayName,
      statusLabel: desktopTaskActivityStatusLabel(item.status === "started" ? "running" : item.status),
      subjectId: safeCode(item.subjectId),
      actionCode: safeCode(item.actionCode),
      operationCode: item.status === "completed" ? safeCode(item.operationCode) : "",
    }));
}
