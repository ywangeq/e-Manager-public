import { useEffect, useRef } from "react";

export function cockpitPanelWidths(width, left = 52, right = width * .26) {
  const available = Math.max(0, width - 48);
  const sidebar = Math.max(52, Math.min(240, left, available - 420 - 240));
  return { left: sidebar, right: Math.max(240, Math.min(right, available - sidebar - 420)) };
}

export function useCockpitLayout(enabled) {
  const rootRef = useRef(null);
  const widths = useRef(null);
  const drag = useRef(null);
  const applyRef = useRef(() => {});
  useEffect(() => {
    const root = rootRef.current;
    if (!enabled || !root) return;
    function apply(next = widths.current) {
      if (root.clientWidth <= 1100) return;
      const value = cockpitPanelWidths(root.clientWidth, next?.left, next?.right);
      widths.current = value;
      root.style.setProperty("--cockpit-sidebar-width", `${value.left}px`);
      root.style.setProperty("--cockpit-rail-width", `${value.right}px`);
      root.dataset.wideNav = String(value.left >= 150);
      for (const side of ["left", "right"]) {
        const control = root.querySelector(`[data-resize-side="${side}"]`);
        control?.setAttribute("aria-valuenow", Math.round(value[side]));
        control?.setAttribute("aria-valuemax", side === "left" ? 240 : Math.round(root.clientWidth - 48 - value.left - 420));
      }
    }
    applyRef.current = apply;
    apply();
    const observer = new ResizeObserver(() => apply());
    observer.observe(root);
    return () => { observer.disconnect(); drag.current = null; applyRef.current = () => {}; };
  }, [enabled]);
  function end(event) {
    drag.current = null;
    if (event.currentTarget.hasPointerCapture?.(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
  }
  function separator(side) {
    return {
      role: "separator", tabIndex: 0, "data-resize-side": side,
      "aria-orientation": "vertical", "aria-label": side === "left" ? "调整导航宽度" : "调整任务动态宽度",
      "aria-valuemin": side === "left" ? 52 : 240,
      title: "拖动调整宽度；方向键微调；双击恢复默认",
      onPointerDown(event) {
        if (event.button !== 0) return;
        event.preventDefault();
        event.currentTarget.setAttribute("data-pointer-focus", "");
        event.currentTarget.focus();
        drag.current = { side, x: event.clientX, widths: { ...widths.current } };
        event.currentTarget.setPointerCapture(event.pointerId);
      },
      onPointerMove(event) {
        if (drag.current?.side !== side) return;
        const delta = (event.clientX - drag.current.x) * (side === "left" ? 1 : -1);
        applyRef.current({ ...drag.current.widths, [side]: drag.current.widths[side] + delta });
      },
      onPointerUp: end, onPointerCancel: end, onLostPointerCapture: end,
      onDoubleClick: () => applyRef.current(null),
      onBlur: event => event.currentTarget.removeAttribute("data-pointer-focus"),
      onKeyDown(event) {
        event.currentTarget.removeAttribute("data-pointer-focus");
        if (event.key === "Home") { event.preventDefault(); applyRef.current(null); return; }
        if (!["ArrowLeft", "ArrowRight"].includes(event.key)) return;
        event.preventDefault();
        const delta = (event.key === "ArrowRight" ? 16 : -16) * (side === "left" ? 1 : -1);
        applyRef.current({ ...widths.current, [side]: widths.current[side] + delta });
      },
    };
  }
  return { rootRef, separator };
}
