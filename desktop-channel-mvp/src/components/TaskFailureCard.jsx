import { useState } from "react";
import { ArrowClockwise, ClipboardText, WarningCircle } from "@phosphor-icons/react";

export function TaskFailureCard({ failure, onCopyTaskId, onRetry }) {
  const [copied, setCopied] = useState(false);
  if (failure?.contractVersion !== "desktop-task-failure.v1") return null;
  const canRetry = failure.retryable === true && typeof onRetry === "function";

  async function copyTaskId() {
    if (!failure.taskId || typeof onCopyTaskId !== "function") return;
    const succeeded = await onCopyTaskId(failure.taskId);
    if (!succeeded) return;
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1800);
  }

  return (
    <section className="task-failure-card" aria-label="任务执行失败" role="alert">
      <div className="task-failure-head">
        <span className="task-failure-icon" aria-hidden="true"><WarningCircle size={16} weight="fill" /></span>
        <span>
          <small>任务未完成</small>
          <strong>{failure.title}</strong>
        </span>
      </div>
      <p>{failure.message}</p>
      {failure.taskId ? (
        <div className="task-failure-reference">
          <span><small>Task ID</small><code>{failure.taskId}</code></span>
          <button type="button" onClick={copyTaskId}><ClipboardText size={13} />{copied ? "已复制" : "复制 ID"}</button>
        </div>
      ) : null}
      {canRetry ? (
        <button className="task-failure-retry" type="button" onClick={onRetry}>
          <ArrowClockwise size={14} />重新发起任务
        </button>
      ) : null}
    </section>
  );
}
