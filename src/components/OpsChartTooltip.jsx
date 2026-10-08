import { useState } from "react";
import { autoUpdate, flip, FloatingPortal, offset, safePolygon, shift, useDismiss, useFloating, useFocus, useHover, useInteractions, useRole } from "@floating-ui/react";

export default function OpsChartTooltip({ children, content, onOpenChange }) {
  const [open, setOpen] = useState(false);
  const { refs, floatingStyles, context } = useFloating({
    open, onOpenChange: (value) => { setOpen(value); onOpenChange?.(value); },
    placement: "top", strategy: "fixed",
    middleware: [offset(10), flip(), shift({ padding: 8 })], whileElementsMounted: autoUpdate,
  });
  const hover = useHover(context, { move: false, handleClose: safePolygon() });
  const focus = useFocus(context, { visibleOnly: false });
  const dismiss = useDismiss(context);
  const role = useRole(context, { role: "tooltip" });
  const { getReferenceProps, getFloatingProps } = useInteractions([hover, focus, dismiss, role]);
  const sourceStyle = open && context.elements.domReference ? getComputedStyle(context.elements.domReference) : null;
  const theme = sourceStyle ? Object.fromEntries(["--panel", "--text", "--muted", "--line"].map((key) => [key, sourceStyle.getPropertyValue(key)])) : {};
  return <>
    {children({ ref: refs.setReference, ...getReferenceProps() })}
    {open ? <FloatingPortal><div ref={refs.setFloating} style={{ ...floatingStyles, ...theme }} tabIndex={0} className="ops-chart-tooltip" {...getFloatingProps()}>{content}</div></FloatingPortal> : null}
  </>;
}
