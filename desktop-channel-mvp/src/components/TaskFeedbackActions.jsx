import { useEffect, useRef, useState } from "react";
import { SpinnerGap, ThumbsDown, ThumbsUp } from "@phosphor-icons/react";
import "./task-feedback-actions.css";

const FEEDBACK_REASONS = [
  { code: "not_resolved", label: "没解决问题" },
  { code: "missing_context", label: "缺少上下文" },
  { code: "needs_human_review", label: "需要人工处理" },
  { code: "other", label: "其他问题" },
];

export function TaskFeedbackActions({ onFeedback, state, task }) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef(null);
  const feedback = task?.feedback;
  const saving = state?.phase === "saving";
  const recorded = Boolean(feedback);

  useEffect(() => {
    if (!open) return undefined;
    function closeFromOutside(event) {
      if (!rootRef.current?.contains(event.target)) setOpen(false);
    }
    document.addEventListener("pointerdown", closeFromOutside);
    return () => document.removeEventListener("pointerdown", closeFromOutside);
  }, [open]);

  useEffect(() => {
    if (recorded) setOpen(false);
  }, [recorded]);

  async function submit(rating, reasonCode = "") {
    await onFeedback?.(task, rating, reasonCode);
    setOpen(false);
  }

  const positiveSelected = feedback?.rating === "helpful";
  const negativeSelected = feedback?.rating === "not_helpful";
  return (
    <div className="task-feedback-actions" ref={rootRef} onKeyDown={(event) => {
      if (event.key === "Escape" && open) {
        event.stopPropagation();
        setOpen(false);
      }
    }}>
      <button
        type="button"
        className={positiveSelected ? "is-selected is-helpful" : ""}
        title={positiveSelected ? "已记录：有帮助" : "这个结果有帮助"}
        aria-label={positiveSelected ? "已记录这个结果有帮助" : "反馈这个结果有帮助"}
        aria-pressed={positiveSelected}
        disabled={saving || recorded}
        onClick={() => void submit("helpful")}
      >
        {saving && state?.rating === "helpful" ? <SpinnerGap size={14} className="spin" /> : <ThumbsUp size={15} weight={positiveSelected ? "fill" : "regular"} />}
      </button>
      <button
        type="button"
        className={negativeSelected ? "is-selected is-not-helpful" : ""}
        title={negativeSelected ? "已记录：没帮助，等待质量复盘" : "这个结果没帮助"}
        aria-label={negativeSelected ? "已记录这个结果没帮助" : "反馈这个结果没帮助"}
        aria-pressed={negativeSelected}
        aria-haspopup="menu"
        aria-expanded={open}
        disabled={saving || recorded}
        onClick={() => setOpen((value) => !value)}
      >
        {saving && state?.rating === "not_helpful" ? <SpinnerGap size={14} className="spin" /> : <ThumbsDown size={15} weight={negativeSelected ? "fill" : "regular"} />}
      </button>
      {open ? <div className="task-feedback-popover" role="menu" aria-label="选择没帮助的原因">
        {FEEDBACK_REASONS.map((reason) => <button
          key={reason.code}
          type="button"
          role="menuitem"
          onClick={() => void submit("not_helpful", reason.code)}
        >{reason.label}</button>)}
      </div> : null}
      {state?.phase === "error" && state.error ? <div className="task-feedback-error" role="alert">{state.error}</div> : null}
    </div>
  );
}
