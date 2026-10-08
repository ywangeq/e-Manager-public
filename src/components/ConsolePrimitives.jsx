import { ChevronDown, ChevronRight, ClipboardList, History, ShieldAlert } from "lucide-react";
import { useEffect, useState } from "react";

export function ExpandableList({ children, className = "", defaultOpenId = "" }) {
  const [openRowId, setOpenRowId] = useState(defaultOpenId);
  const classes = ["entity-list", className].filter(Boolean).join(" ");

  useEffect(() => {
    setOpenRowId(defaultOpenId || "");
  }, [defaultOpenId]);

  return <div className={classes}>{children({ openRowId, setOpenRowId })}</div>;
}

export function ExpandableRow({
  listId,
  rowId,
  openRowId,
  setOpenRowId,
  icon,
  title,
  description,
  draggable = false,
  onDragStart = null,
  onDragEnd = null,
  status,
  summary = [],
  actions = null,
  children,
}) {
  const isOpen = openRowId === rowId;
  const panelId = `${listId}-${rowId}-details`;
  const rowClassName = [
    "entity-row",
    isOpen ? "is-open" : "",
    actions ? "has-row-actions" : "",
    draggable ? "is-draggable" : "",
  ].filter(Boolean).join(" ");

  return (
    <article className={rowClassName} draggable={draggable} onDragStart={onDragStart || undefined} onDragEnd={onDragEnd || undefined}>
      <button
        className="entity-row-toggle"
        type="button"
        aria-expanded={isOpen}
        aria-controls={panelId}
        onClick={() => setOpenRowId((current) => (current === rowId ? "" : rowId))}
      >
        <span className="icon-chip">{icon}</span>
        <span className="entity-row-main">
          <span className="entity-title-line">
            <strong>{title}</strong>
            {status}
          </span>
          <span className="entity-description">{description}</span>
          <span className="entity-summary">
            {summary.filter(Boolean).map((item, index) => (
              <b key={`${item}-${index}`}>{item}</b>
            ))}
          </span>
        </span>
        <span className="entity-cue" aria-hidden="true">
          {isOpen ? <ChevronDown size={18} /> : <ChevronRight size={18} />}
        </span>
      </button>
      {actions ? <div className="entity-row-actions">{actions}</div> : null}
      {isOpen ? (
        <div className="entity-details" id={panelId}>
          {children}
        </div>
      ) : null}
    </article>
  );
}

export function DetailGrid({ items }) {
  return (
    <dl className="detail-grid">
      {items
        .filter(([, value]) => value)
        .map(([label, value], index) => (
          <div key={`${label}-${index}`}>
            <dt>{label}</dt>
            <dd>{value}</dd>
          </div>
        ))}
    </dl>
  );
}

export function GovernanceBlock({ constraints = [], promptKeys = [], badcases = [], compact = false }) {
  const openBadcases = badcases.filter((item) => !["已关闭", "closed"].includes(item.status));

  return (
    <div className={compact ? "governance-block compact" : "governance-block"}>
      <div className="governance-line">
        <History size={15} />
        <span>Prompt keys</span>
        {promptKeys.filter(Boolean).map((key) => (
          <b key={key}>{key}</b>
        ))}
      </div>
      <div className="governance-line">
        <ShieldAlert size={15} />
        <span>约束</span>
        {constraints.map((item) => (
          <b key={item}>{item}</b>
        ))}
      </div>
      <div className="governance-line">
        <ClipboardList size={15} />
        <span>Badcase</span>
        <b>{badcases.length} 条</b>
        <b>{openBadcases.length} 条未关闭</b>
      </div>
    </div>
  );
}

export function SkillChips({ title, items, compact = false }) {
  return (
    <div className={compact ? "chip-line compact" : "chip-line"}>
      <span>{title}</span>
      {items.map((item) => (
        <b key={item}>{item}</b>
      ))}
    </div>
  );
}
