import { useEffect, useId, useState } from "react";
import { createPortal } from "react-dom";
import { employeeCharacterFor } from "../data/employeeCharacters.js";

export function CockpitEmployeeStack({ employees }) {
  const [expanded, setExpanded] = useState(false);
  const [tooltip, setTooltip] = useState(null);
  const tooltipId = useId();
  const previewCount = Math.min(3, employees.length);
  const hiddenCount = employees.length - previewCount;
  useEffect(() => {
    const hide = () => setTooltip(null);
    window.addEventListener("resize", hide);
    window.addEventListener("scroll", hide, true);
    return () => {
      window.removeEventListener("resize", hide);
      window.removeEventListener("scroll", hide, true);
    };
  }, []);
  function showName(target, selection) {
    const rect = target.getBoundingClientRect();
    const width = Math.min(240, window.innerWidth - 16);
    setTooltip({ selection, width, left: Math.max(8, Math.min(rect.x + rect.width / 2 - width / 2, window.innerWidth - width - 8)), top: rect.bottom + 8 });
  }
  const names = tooltip?.selection === "all" ? employees : tooltip?.selection === "more" ? employees.slice(previewCount) : employees.filter(employee => employee.id === tooltip?.selection);
  const label = names.map(employee => employee.name || "员工").join("、");
  if (!employees.length) return null;
  return <><button type="button" className={`cockpit-employee-stack${expanded ? " is-expanded" : ""}`} aria-expanded={expanded} aria-describedby={label ? tooltipId : undefined} aria-label={`${expanded ? "收起" : "展开"}${employees.length}位可用员工`} onClick={() => { setTooltip(null); setExpanded(value => !value); }} onFocus={event => showName(event.currentTarget, "all")} onBlur={() => setTooltip(null)} onMouseLeave={() => setTooltip(null)} onKeyDown={event => { if (event.key === "Escape") setTooltip(null); }}>
    {employees.map((employee, index) => <span key={employee.id} className="cockpit-stack-person" onMouseEnter={event => showName(event.currentTarget, employee.id)} style={{ "--stack-index": index, "--stack-position": expanded ? index : Math.min(index, previewCount), "--stack-delay": `${(expanded ? index : employees.length - index - 1) * 45}ms`, zIndex: index + 1, opacity: !expanded && index >= previewCount ? 0 : 1, pointerEvents: !expanded && index >= previewCount ? "none" : "auto" }}>
      {employeeCharacterFor(employee)?.staticSrc ? <img src={employeeCharacterFor(employee).staticSrc} alt="" draggable={false} /> : <span>{(employee.name || "员工").slice(0, 1)}</span>}
    </span>)}
    {hiddenCount > 0 ? <span className="cockpit-stack-more" onMouseEnter={event => showName(event.currentTarget, "more")} style={{ "--stack-position": previewCount, opacity: expanded ? 0 : 1, pointerEvents: expanded ? "none" : "auto" }}>+{hiddenCount}</span> : null}
    <span className="cockpit-stack-spacer" style={{ width: expanded ? 40 + (employees.length - 1) * 48 : 40 + (previewCount - 1 + (hiddenCount > 0 ? 1 : 0)) * 21 }} />
  </button>{label && createPortal(<div id={tooltipId} role="tooltip" className="cockpit-stack-tooltip" style={{ left: tooltip.left, top: tooltip.top, width: tooltip.width }}><span>{label}</span></div>, document.body)}</>;
}
