import { useEffect, useRef } from "react";
import { createCockpitCore } from "../lib/cockpitCore.js";
import { createCockpitParticleRenderer } from "../lib/cockpitParticleRenderer.js";
import { activityStates } from "../lib/cockpitSentinelState.js";
import { useCockpitSentinelState } from "../hooks/useCockpitSentinelState.js";
import "./cockpit-sentinel.css";

export function CockpitSentinel({ authenticated, taskPhase, tasks, sources, onOpen, desktopApi, compact = false, blue = false, presentation }) {
  const canvas = useRef(null);
  const engine = useRef(null);
  const localPresentation = useCockpitSentinelState({ authenticated, taskPhase, tasks, sources, enabled: !presentation });
  const { activity: visualActivity, paused, setPaused } = presentation ?? localPresentation;
  const drag = useRef(null);
  const suppressClick = useRef(false);
  const hasWoken = (presentation ?? localPresentation).wakeSession;
  const state = activityStates[visualActivity];

  useEffect(() => {
    engine.current = createCockpitCore(canvas.current, report => {
      if (report.renderer && canvas.current) canvas.current.dataset.particleRenderer=report.renderer;
      if (report.waking !== undefined && canvas.current) canvas.current.dataset.waking=String(report.waking);
    }, createCockpitParticleRenderer);
    return () => {
      engine.current.destroy();
      engine.current = null;
      if (drag.current) desktopApi?.endWindowDrag?.();
    };
  }, []);
  useEffect(() => {
    engine.current.configure({ activity: visualActivity, voice: "off", audioLevel: 0, paused, palette: "blue", material: "gpu", stateColors: true, orbitThickness: .1, orbitExpansion: true, radiusLimit: 202.8 });
    const ready = !["waiting","loading","unavailable"].includes(visualActivity);
    if (!authenticated) hasWoken.current=false;
    if (ready && !paused && !hasWoken.current) {
      const currentEngine = engine.current;
      currentEngine.wake();
      queueMicrotask(() => { if (engine.current === currentEngine) hasWoken.current=true; });
    }
  }, [visualActivity, paused, blue, authenticated, hasWoken]);

  function wake() {
    if (paused) return;
    if (!["waiting","loading","unavailable"].includes(visualActivity)) engine.current.wake();
  }

  function beginDrag(event) {
    event.currentTarget.setAttribute?.("data-pointer-focus", "");
    suppressClick.current = false;
    if (!desktopApi?.beginWindowDrag || event.button !== 0) return;
    drag.current = { pointerId: event.pointerId, x: event.screenX, y: event.screenY, moved: false };
    event.currentTarget.setPointerCapture?.(event.pointerId);
    desktopApi.beginWindowDrag({ x: event.screenX, y: event.screenY });
  }
  function moveDrag(event) {
    const current = drag.current;
    if (!current || current.pointerId !== event.pointerId) return;
    if (!current.moved && Math.hypot(event.screenX - current.x, event.screenY - current.y) < 4) return;
    current.moved = true;
    desktopApi.moveWindowDrag?.({ x: event.screenX, y: event.screenY });
  }
  function endDrag(event) {
    if (drag.current?.pointerId !== event.pointerId) return;
    suppressClick.current = drag.current.moved || event.type === "pointercancel";
    drag.current = null;
    desktopApi.endWindowDrag?.();
    if (event.currentTarget.hasPointerCapture?.(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
  }
  function activate(event) {
    if (suppressClick.current && event.detail !== 0) { suppressClick.current = false; return; }
    if (onOpen && event.detail === 0) { onOpen(); return; }
    if (!onOpen && event.detail <= 1) wake();
  }

  return <section className="cockpit-sentinel" aria-label="驾驶舱动态核心" style={{ "--sentinel-color": state.color.join(",") }}>
    <button type="button" className={`cockpit-sentinel-stage${desktopApi ? " is-draggable" : ""}`} onClick={activate} onDoubleClick={() => { if (!suppressClick.current) onOpen?.(); }} onPointerDown={beginDrag} onPointerMove={moveDrag} onPointerUp={endDrag} onPointerCancel={endDrag} onLostPointerCapture={endDrag} onBlur={event => event.currentTarget.removeAttribute("data-pointer-focus")} onKeyDown={event => event.currentTarget.removeAttribute("data-pointer-focus")} aria-label={onOpen ? "桌面值守，双击打开驾驶舱" : "值守"} disabled={paused && !onOpen}>
      <canvas ref={canvas} aria-hidden="true" />
    </button>
    {!compact && <div className="cockpit-sentinel-caption">
      <span role="status">{state.label}</span>
      <button type="button" onClick={() => setPaused(!paused)} aria-label={paused ? "继续动画" : "暂停动画"} title={paused ? "继续动画" : "暂停动画"} aria-pressed={paused}>{paused ? "▷" : "Ⅱ"}</button>
    </div>}
  </section>;
}
