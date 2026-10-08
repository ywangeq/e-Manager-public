import { useEffect, useId, useRef, useState } from "react";
import { CaretDown, Check, MagnifyingGlass, Sparkle, X } from "@phosphor-icons/react";
import { employeeCharacterFor } from "../data/employeeCharacters.js";
import { groupStudioMemberAccessGroup, selectGroupStudioMembers } from "../lib/groupRunDemoFlow.js";
import { hasSeenAssignmentGuidance, markAssignmentGuidanceSeen } from "../lib/groupAssignmentGuidance.js";
import "./group-assignment-capsule.css";

export function GroupAssignmentCapsule({ employees, memberIds, fixedMembers, locked, lockReason, onChoose }) {
  const choices = selectGroupStudioMembers(employees).filter(item => groupStudioMemberAccessGroup(item) === "direct");
  const ids = memberIds ? [...memberIds] : [];
  const fixed = fixedMembers?.filter(item => item.employeeId === ids[0]) || [];
  const employee = ids.length === 1 ? choices.find(item => item.id === ids[0] && fixed.every(member => member.employeeVersion === item.version)) : null;
  const [query, setQuery] = useState("");
  const [guidanceSeen, setGuidanceSeen] = useState(hasSeenAssignmentGuidance);
  const guidanceId = useId();
  const popupId = useId();
  const popupRef = useRef(null);
  const triggerRef = useRef(null);
  const searchRef = useRef(null);
  const identity = choices.map(item => `${item.id}:${item.version}`).join(";");
  useEffect(() => { popupRef.current?.hidePopover(); }, [locked, identity]);
  const label = employee?.name || (ids.length === 1 ? "员工待同步" : "自动安排");
  const automatic = ids.length !== 1;
  const showGuidance = automatic && !locked && !guidanceSeen;
  function dismissGuidance() {
    markAssignmentGuidanceSeen();
    setGuidanceSeen(true);
  }
  function open(event) {
    if (popupRef.current.matches(":popover-open")) return popupRef.current.hidePopover();
    setQuery("");
    const rect = event.currentTarget.getBoundingClientRect();
    const width = Math.min(304, window.innerWidth - 32);
    const height = Math.min(340, window.innerHeight - 32);
    popupRef.current.style.left = `${Math.max(16, Math.min(rect.left, window.innerWidth - width - 16))}px`;
    popupRef.current.style.top = `${Math.max(16, Math.min(rect.top - height - 8, window.innerHeight - height - 16))}px`;
    popupRef.current.showPopover();
    dismissGuidance();
    searchRef.current?.focus();
  }
  function choose(id) {
    onChoose(id);
    popupRef.current.hidePopover();
    triggerRef.current.focus();
  }
  return <div className="group-assignment">
    <button type="button" ref={triggerRef} className={`group-assignment-trigger${automatic ? " is-automatic" : ""}`} disabled={locked} title={locked ? lockReason : `${label} · 点击选择员工`} aria-describedby={showGuidance ? guidanceId : undefined} aria-label={`任务安排方式：${label}`} aria-expanded="false" aria-controls={popupId} onClick={open}>
      {automatic ? <Sparkle size={18} aria-hidden="true" /> : <><span>{label}</span><CaretDown size={14} aria-hidden="true" /></>}
    </button>
    {showGuidance ? <div id={guidanceId} className="group-assignment-guidance" role="note"><span>选择员工，或让系统自动安排</span><button type="button" aria-label="关闭任务安排引导" onClick={() => { dismissGuidance(); triggerRef.current.focus(); }}><X size={14} aria-hidden="true" /></button></div> : null}
    <div id={popupId} ref={popupRef} popover="auto" className="group-assignment-popover" onToggle={event => triggerRef.current?.setAttribute("aria-expanded", String(event.newState === "open"))}>
      <header><strong>任务安排方式</strong><button type="button" aria-label="关闭员工选择" onClick={() => { popupRef.current.hidePopover(); triggerRef.current.focus(); }}><X size={16} /></button></header>
      <label className="group-assignment-search"><MagnifyingGlass size={16} aria-hidden="true" /><input ref={searchRef} aria-label="搜索安排员工" placeholder="搜索员工" value={query} onChange={event => setQuery(event.target.value)} /></label>
      <button type="button" className="group-assignment-option" aria-pressed={ids.length !== 1} onClick={() => choose(null)}><Sparkle size={22} aria-hidden="true" /><span><strong>自动安排</strong><small>按目标推荐合适员工</small></span>{ids.length !== 1 ? <Check size={16} aria-hidden="true" /> : null}</button>
      <div className="group-assignment-options">{choices.filter(item => `${item.name} ${item.title || ""}`.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase())).map(item => {
        const src = employeeCharacterFor(item)?.staticSrc;
        return <button type="button" key={item.id} className="group-assignment-option" aria-pressed={employee?.id === item.id} onClick={() => choose(item.id)}>{src ? <img src={src} alt="" draggable={false} /> : <span className="group-assignment-initial" aria-hidden="true">{item.name?.slice(0, 1) || "?"}</span>}<span><strong>{item.name}</strong><small>{item.title || item.department || "可用员工"}</small></span>{employee?.id === item.id ? <Check size={16} aria-hidden="true" /> : null}</button>;
      })}</div>
      {!choices.length ? <p role="status">暂无可安排的员工。</p> : query && !choices.some(item => `${item.name} ${item.title || ""}`.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase())) ? <p role="status">没有匹配的员工。</p> : null}
    </div>
  </div>;
}
