// A presentation-only mapping of canonical task, Group and automation states.
export function cockpitStatusTone(status) {
  if (["accepted", "completed"].includes(status)) return "success";
  if (["blocked", "failed", "rejected", "timeout", "timed_out", "lost"].includes(status)) return "danger";
  if (["attention_required", "awaiting_review", "awaiting_acceptance", "execution_completed", "draft", "resume_required", "reconcile_required", "waiting", "pending_file_intake", "pending_remote_resource", "pending_invocation_check"].includes(status)) return "attention";
  if (["running", "planning", "starting"].includes(status)) return "active";
  return "neutral";
}
