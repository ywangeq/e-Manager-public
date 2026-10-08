import "./group-reviewer-configurator.css";
import { CaretDown, UsersThree, X } from "@phosphor-icons/react";
import { useState } from "react";
import { reviewerConfigurationIssue } from "../lib/groupRunDemoFlow.js";

const MODES = [
  ["single", "单人"],
  ["sequential", "顺序"],
  ["parallel", "并行"],
];

export function GroupReviewerConfigurator({ cardRef, members, reviewerIds, reviewerMode,
  finalReviewerId, reviewerTeam, disabled = false, onAdd, onRemove, onModeChange, onFinalChange, onMove } = {}) {
  const [expanded, setExpanded] = useState(false);
  const issue = reviewerConfigurationIssue({ reviewerIds, mode: reviewerMode, finalReviewerEmployeeId: finalReviewerId });
  const memberName = id => members.find(member => member.id === id)?.name || id;
  const drop = event => {
    const id = event.dataTransfer?.getData("application/x-group-employee");
    if (!id) return;
    event.preventDefault();
    if (!disabled) onAdd?.(id);
  };
  const dragOver = event => {
    if (disabled || !event.dataTransfer?.types.includes("application/x-group-employee")) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "copy";
  };
  return <div ref={cardRef} className={`group-reviewer-team-card${reviewerIds.length ? " is-active" : " group-reviewer-team-card-empty"}`} aria-label={reviewerIds.length ? "Reviewer Group" : "创建 Reviewer Group"} onDragOver={dragOver} onDrop={drop}>
    <div className="group-reviewer-team-heading"><UsersThree size={16} /><span><strong>{reviewerTeam?.displayName || "Reviewer Group"}</strong><small>{reviewerIds.length ? issue || `${reviewerIds.length} 位成员 · ${reviewerTeam?.status || "未开始"}` : "暂无复核成员"}</small></span>{reviewerIds.length ? <button type="button" className="group-reviewer-config-toggle" aria-label={expanded ? "收起 Reviewer 配置" : "配置 Reviewer Group"} aria-expanded={expanded} disabled={disabled} onClick={() => setExpanded(value => !value)}><CaretDown size={14} /></button> : null}</div>
    {reviewerIds.length ? <div className="group-reviewer-team-avatars">{reviewerIds.map(id => { const member = members.find(item => item.id === id); return <span key={id} draggable={!disabled} title={`${memberName(id)}：拖出 Reviewer Group 可移除`} onDragStart={event => { event.dataTransfer.setData("application/x-group-reviewer", id); event.dataTransfer.effectAllowed = "move"; }}>{member?.avatar ? <img src={member.avatar} alt="" draggable={false} /> : memberName(id).slice(0, 1)}</span>; })}</div> : null}
    {expanded && reviewerIds.length > 0 ? <div className="group-reviewer-config">
      <fieldset disabled={disabled}><legend>复核模式</legend><div className="group-reviewer-mode">{MODES.map(([value, label]) => <button type="button" key={value} aria-pressed={reviewerMode === value} disabled={value === "single" ? reviewerIds.length !== 1 : reviewerIds.length < 2} onClick={() => onModeChange?.(value)}>{label}</button>)}</div></fieldset>
      {reviewerIds.length ? <fieldset disabled={disabled}><legend>成员与最终汇总 Reviewer</legend><div className="group-reviewer-member-config">{reviewerIds.map((id, index) => <div key={id}>
        <label><input type="radio" name="group-final-reviewer" checked={finalReviewerId === id} onChange={() => onFinalChange?.(id)} /><span>{memberName(id)}</span></label>
        {reviewerMode === "sequential" ? <span className="group-reviewer-order"><button type="button" aria-label={`上移 ${memberName(id)}`} disabled={disabled || index === 0} onClick={() => onMove?.(index, index - 1)}>↑</button><button type="button" aria-label={`下移 ${memberName(id)}`} disabled={disabled || index === reviewerIds.length - 1} onClick={() => onMove?.(index, index + 1)}>↓</button></span> : null}
        <button type="button" className="group-reviewer-remove" aria-label={`移除 Reviewer ${memberName(id)}`} disabled={disabled} onClick={() => onRemove?.(id)}><X size={11} /></button>
      </div>)}</div></fieldset> : null}
      {issue ? <p className="group-reviewer-config-error" role="alert">{issue}</p> : <small>复核配置只会随下一次计划草案提交。</small>}
    </div> : null}
    <div className="group-reviewer-drop-hint">拖入员工可加入复核小组</div>
  </div>;
}
