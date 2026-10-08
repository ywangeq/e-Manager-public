import { useEffect, useMemo, useState } from "react";
import {
  ArrowClockwise,
  CaretRight,
  Check,
  HourglassMedium,
  LockKey,
  SpinnerGap,
  X,
} from "@phosphor-icons/react";
import { employeeCharacterFor } from "../data/employeeCharacters.js";
import { employeeRuntimeState } from "../lib/desktopChannelModel.js";

const FILTERS = [
  { id: "all", label: "全部" },
  { id: "available", label: "可用" },
  { id: "request", label: "可申请" },
];

export function EmployeeSwitcherSheet({
  employees,
  requests,
  selectedEmployeeId,
  onClose,
  onRefresh,
  onRequest,
  onSelect,
  syncState,
}) {
  const [filter, setFilter] = useState("all");
  const pendingEmployeeIds = useMemo(() => new Set(
    requests
      .filter((request) => request.status === "pending_review")
      .map((request) => request.target?.employeeId),
  ), [requests]);
  const visibleEmployees = useMemo(() => employees.filter((employee) => {
    if (filter === "available") return employee.access?.selectable === true && employee.access?.callable === true;
    if (filter === "request") return employee.access?.requestable === true || pendingEmployeeIds.has(employee.id);
    return true;
  }), [employees, filter, pendingEmployeeIds]);

  useEffect(() => {
    function handleKeyDown(event) {
      if (event.key === "Escape") onClose();
    }
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [onClose]);

  function activate(employee, pending) {
    if (pending) return;
    if (employee.access?.selectable && employee.access?.callable) {
      onSelect(employee.id);
      onClose();
      return;
    }
    if (employee.access?.requestable) onRequest(employee.id);
  }

  return (
    <div className="employee-sheet-layer" role="presentation" onMouseDown={(event) => {
      if (event.target === event.currentTarget) onClose();
    }}>
      <section className="employee-sheet" role="dialog" aria-modal="true" aria-label="切换数字员工">
        <header className="employee-sheet-header">
          <div className="employee-sheet-title">
            <span>员工状态台</span>
            <strong>切换数字员工</strong>
          </div>
          <div className="employee-sheet-header-actions">
            <span className={`employee-sheet-sync is-${syncState?.phase || "idle"}`} aria-live="polite">
              {syncLabel(syncState)}
            </span>
            <button type="button" className="icon-button" title="刷新员工列表" aria-label="刷新员工列表" disabled={syncState?.phase === "loading"} onClick={onRefresh}>
              {syncState?.phase === "loading" ? <SpinnerGap size={17} className="spin" /> : <ArrowClockwise size={17} />}
            </button>
            <button type="button" className="icon-button" title="关闭" aria-label="关闭员工切换" onClick={onClose}>
              <X size={17} />
            </button>
          </div>
        </header>

        <div className="employee-sheet-filters" role="tablist" aria-label="筛选数字员工">
          {FILTERS.map((item) => (
            <button
              type="button"
              role="tab"
              aria-selected={filter === item.id}
              className={filter === item.id ? "is-active" : ""}
              key={item.id}
              onClick={() => setFilter(item.id)}
            >
              {item.label}
            </button>
          ))}
        </div>

        <div className="employee-sheet-columns" aria-hidden="true"><span>数字员工</span><span>状态</span></div>
        <div className="employee-sheet-list">
          {visibleEmployees.map((employee) => {
            const selected = employee.id === selectedEmployeeId;
            const pending = pendingEmployeeIds.has(employee.id);
            const status = sheetStatus(employee, pending);
            const character = employeeCharacterFor(employee);
            const interactive = (employee.access?.selectable && employee.access?.callable)
              || (employee.access?.requestable && !pending);
            return (
              <button
                type="button"
                className={`employee-sheet-row ${selected ? "is-selected" : ""} ${interactive ? "is-interactive" : "is-readonly"}`}
                key={employee.id}
                aria-current={selected ? "true" : undefined}
                disabled={!interactive}
                onClick={() => activate(employee, pending)}
              >
                <span className={`employee-sheet-character ${character ? "" : "is-unregistered"}`} style={{ "--employee-accent": character?.accent }}>
                  {character
                    ? <img src={character.staticSrc} alt="" />
                    : <span className="employee-character-missing" aria-label="角色原型未登记">未登记</span>}
                </span>
                <span className="employee-sheet-identity">
                  <strong>{employee.name || employee.title || employee.id}</strong>
                  <small>{employee.title || employee.department || character?.codename || "角色原型未登记"}</small>
                </span>
                <span className={`employee-sheet-status is-${status.tone}`}>
                  {status.icon === "lock" ? <LockKey size={14} weight="bold" /> : null}
                  {status.icon === "pending" ? <HourglassMedium size={14} weight="bold" /> : null}
                  {status.label}
                </span>
                <span className="employee-sheet-action" aria-hidden="true">
                  {selected ? <Check size={19} weight="bold" /> : interactive ? <CaretRight size={16} weight="bold" /> : null}
                </span>
              </button>
            );
          })}
          {!visibleEmployees.length ? <div className="employee-sheet-empty">当前筛选下暂无数字员工</div> : null}
        </div>
      </section>
    </div>
  );
}

function syncLabel(syncState = {}) {
  if (syncState.phase === "loading") return "正在同步…";
  if (syncState.phase === "error") return syncState.message || "更新失败";
  if (syncState.message) return syncState.message;
  if (!syncState.updatedAt) return "打开时自动更新";
  return `${new Date(syncState.updatedAt).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" })} 更新`;
}

function sheetStatus(employee, pending) {
  if (pending) return { label: "待审批", tone: "pending", icon: "pending" };
  if (employee.access?.selectable) {
    const runtime = employeeRuntimeState(employee);
    return { label: runtime.label, tone: runtime.tone };
  }
  if (employee.access?.requestable) return { label: "无权限", tone: "request", icon: "lock" };
  return { label: "未上线", tone: "readonly" };
}
