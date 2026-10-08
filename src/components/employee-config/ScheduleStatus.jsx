import { scheduleStateLabel } from "../../lib/digitalEmployeeSchedules";

export default function ScheduleStatus({ state, emergencyStopped = false, controlSyncRequired = false }) {
  const tone = emergencyStopped || ["failed", "timed_out", "lost", "rejected"].includes(state) ? "red"
    : controlSyncRequired || ["registered", "paused", "prepared", "queued", "reconcile_required", "cancel_requested", "blocked", "skipped_max_concurrency"].includes(state) ? "yellow"
    : ["completed", "succeeded"].includes(state) ? "green"
    : ["active", "running", "submitted"].includes(state) ? "blue" : "neutral";
  return <span className="employee-schedule-status" data-tone={tone}>
    {emergencyStopped ? "已急停" : controlSyncRequired ? "配置待同步" : scheduleStateLabel(state)}
  </span>;
}
