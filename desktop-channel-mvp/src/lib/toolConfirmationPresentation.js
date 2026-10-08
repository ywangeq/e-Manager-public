export function toolConfirmationPresentation(confirmation, now = Date.now()) {
  const status = confirmation?.status;
  if (status === "submitting") return { label: "正在提交", pending: false, tracking: true };
  if (status === "submission_unknown") return { label: "提交状态待核对", pending: false, tracking: true };
  if (status === "submitted") return { label: "确认已提交", pending: false, tracking: false };
  const expired = !Number.isFinite(Date.parse(confirmation?.expiresAt)) || Date.parse(confirmation.expiresAt) <= now;
  if (expired) return { label: "确认已过期", pending: false, tracking: false };
  if (status !== "pending") return { label: "确认已结束", pending: false, tracking: false };
  return { label: "确认本次执行", pending: true, tracking: false };
}

export function claimToolConfirmationSubmission(claims, employeeId, confirmation, now = Date.now()) {
  if (!employeeId || !confirmation?.id || !toolConfirmationPresentation(confirmation, now).pending) return false;
  const key = JSON.stringify([employeeId, confirmation.id]);
  if (claims.has(key)) return false;
  claims.add(key);
  return true;
}
