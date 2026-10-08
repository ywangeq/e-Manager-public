import { useEffect, useId, useRef } from "react";
import { cockpitGroupParticipants } from "../lib/cockpitGroupParticipants.js";
import { employeeCharacterFor } from "../data/employeeCharacters.js";
import { runStatusLabel } from "../lib/groupRunHistory.js";
import "./cockpit-group-participants.css";

export function CockpitGroupParticipants({ goal, employees = [] }) {
  const { members, label } = cockpitGroupParticipants(goal, employees);
  const popoverId = useId();
  const popoverRef = useRef(null);
  const triggerRef = useRef(null);
  const source = goal?.runId ? goal.projection : goal?.planning?.planDraft;
  const identity = `${goal?.goalId}:${goal?.runId}:${source?.groupId}:${source?.groupVersion}:${source?.planId}:${source?.planRevision ?? source?.revision}:${members.map(member => `${member.id}:${member.versions.join(",")}:${member.name}`).join(";")}`;
  useEffect(() => { popoverRef.current?.hidePopover(); }, [identity]);
  if (!members.length) return <span className="cockpit-group-members-unavailable">{label}</span>;
  const shown = members.slice(0, 3);
  function toggle(event) {
    const popover = popoverRef.current;
    if (popover.matches(":popover-open")) return popover.hidePopover();
    const rect = event.currentTarget.getBoundingClientRect();
    const width = Math.min(240, window.innerWidth - 32);
    const height = Math.min(280, window.innerHeight - 32);
    popover.style.left = `${Math.max(16, Math.min(rect.left, window.innerWidth - width - 16))}px`;
    popover.style.top = `${Math.max(16, Math.min(rect.bottom + 6, window.innerHeight - height - 16))}px`;
    popover.showPopover();
  }
  return <div className="cockpit-group-members">
    <button ref={triggerRef} type="button" aria-expanded="false" aria-controls={popoverId} aria-label={`查看${label}`} title={`查看${label}`} onClick={toggle}>
      <span className="cockpit-group-avatar-stack" aria-hidden="true">{shown.map(member => {
        const portrait = member.employee ? employeeCharacterFor(member.employee)?.staticSrc : null;
        return <span className="cockpit-group-avatar" key={member.id}>{portrait ? <img src={portrait} alt="" draggable={false} /> : <span>{member.employee ? member.name.slice(0, 1) : "?"}</span>}</span>;
      })}{members.length > shown.length ? <span className="cockpit-group-avatar is-more">+{members.length - shown.length}</span> : null}</span>
      <span className="cockpit-group-member-count">{label}</span>
    </button>
    <div id={popoverId} ref={popoverRef} popover="auto" className="cockpit-group-member-popover" onToggle={event => triggerRef.current?.setAttribute("aria-expanded", String(event.newState === "open"))}>
      <header><strong>{label}</strong><button type="button" aria-label="收起成员名单" onClick={() => popoverRef.current.hidePopover()}>收起</button></header>
      <ul aria-label={label}>{members.map(member => <li key={member.id}><strong>{member.name}</strong><span>{member.assignments.map(item => `${item.role} · ${item.status === "planned" ? "待采纳" : runStatusLabel(item.status)}`).join("；")}</span></li>)}</ul>
    </div>
  </div>;
}
