import { useEffect, useRef } from "react";
import { gsap } from "gsap";

export function CockpitMetricCard({ children, onClick, ...props }) {
  const card = useRef(null);
  const pointer = useRef(null);
  useEffect(() => { const node = card.current; return () => gsap.killTweensOf(node); }, []);
  function tilt(event) {
    const node = card.current;
    const rect = node.getBoundingClientRect();
    const x = Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width));
    const y = Math.max(0, Math.min(1, (event.clientY - rect.top) / rect.height));
    node.style.setProperty("--press-x", `${x * 100}%`);
    node.style.setProperty("--press-y", `${y * 100}%`);
    if (!window.matchMedia("(prefers-reduced-motion: reduce)").matches) gsap.to(node, {
      rotationX: (0.5 - y) * 9, rotationY: (x - 0.5) * 9, scale: 0.97,
      transformPerspective: 700, duration: 0.13, ease: "power2.out", overwrite: true,
    });
  }
  function release(event) {
    if (event?.pointerId !== undefined && pointer.current !== event.pointerId) return;
    const node = card.current;
    pointer.current = null;
    node.removeAttribute("data-pressed");
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    gsap.to(node, { rotationX: 0, rotationY: 0, scale: 1, duration: reduced ? 0 : 0.55, ease: "elastic.out(1,.55)", overwrite: true, clearProps: "transform" });
  }
  return <button {...props} ref={card} type="button" className="cockpit-metric-card" onClick={onClick}
    onPointerDown={event => { if (event.button !== 0 || pointer.current !== null) return; pointer.current = event.pointerId; event.currentTarget.setPointerCapture(event.pointerId); event.currentTarget.setAttribute("data-pressed", "true"); tilt(event); }}
    onPointerMove={event => { if (pointer.current === event.pointerId) tilt(event); }}
    onPointerUp={release} onPointerCancel={release} onLostPointerCapture={() => { if (pointer.current !== null) release(); }}
    onKeyDown={event => { if ([" ", "Enter"].includes(event.key) && !event.repeat) { event.currentTarget.setAttribute("data-pressed", "true"); event.currentTarget.style.setProperty("--press-x", "50%"); event.currentTarget.style.setProperty("--press-y", "50%"); } }}
    onKeyUp={event => { if ([" ", "Enter"].includes(event.key)) release(); }} onBlur={release}>
    {children}
  </button>;
}
