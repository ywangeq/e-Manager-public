import { GripVertical } from "lucide-react";
import { useState } from "react";

export default function MoreTabRail({ tabs = [], selectedTab, onTabChange, onReorder, ariaLabel }) {
  const [draggingId, setDraggingId] = useState("");

  function handleDragStart(event, tabId) {
    setDraggingId(tabId);
    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData("text/plain", tabId);
  }

  function handleDrop(event, targetId) {
    event.preventDefault();
    const sourceId = event.dataTransfer.getData("text/plain") || draggingId;
    setDraggingId("");
    if (!sourceId || sourceId === targetId) return;
    onReorder?.(sourceId, targetId);
  }

  return (
    <div className="employee-more-tabs is-configurable" role="tablist" aria-label={ariaLabel}>
      {tabs.map((tab) => (
        <button
          className={`${selectedTab === tab.id ? "is-active" : ""}${draggingId === tab.id ? " is-dragging" : ""}`}
          type="button"
          role="tab"
          aria-selected={selectedTab === tab.id}
          draggable
          key={tab.id}
          onClick={() => onTabChange(tab.id)}
          onDragStart={(event) => handleDragStart(event, tab.id)}
          onDragOver={(event) => {
            if (draggingId && draggingId !== tab.id) event.preventDefault();
          }}
          onDrop={(event) => handleDrop(event, tab.id)}
          onDragEnd={() => setDraggingId("")}
        >
          {tab.icon}
          <span>{tab.label}</span>
          <GripVertical className="employee-more-tab-grip" size={13} aria-hidden="true" />
        </button>
      ))}
    </div>
  );
}
