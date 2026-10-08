import { useEffect, useState } from "react";
import "./cockpit-clock.css";

const clockText = (date) => [date.getHours(), date.getMinutes(), date.getSeconds()].map((n) => String(n).padStart(2, "0")).join(":");

function FlipDigit({ value, previous }) {
  return <span className="cockpit-flip-digit" aria-hidden="true">
    <span className="flip-half flip-top"><span>{value}</span></span>
    <span className="flip-half flip-bottom"><span>{previous}</span></span>
    <span key={`top-${value}`} className={`flip-half flip-top ${value !== previous ? "flip-out" : ""}`}><span>{previous}</span></span>
    <span key={`bottom-${value}`} className={`flip-half flip-bottom ${value !== previous ? "flip-in" : ""}`}><span>{value}</span></span>
  </span>;
}

export function CockpitClock({ compact = false }) {
  const [clock, setClock] = useState(() => { const now = new Date(); return { now, previous: now }; });
  useEffect(() => {
    let timer;
    const schedule = () => { if (document.hidden) return; timer = window.setTimeout(() => {
      if (!document.hidden) setClock((old) => ({ now: new Date(), previous: old.now }));
      schedule();
    }, 1000 - Date.now() % 1000); };
    const resume = () => { window.clearTimeout(timer); if (!document.hidden) { const now = new Date(); setClock({ now, previous: now }); schedule(); } };
    schedule(); document.addEventListener("visibilitychange", resume);
    return () => { window.clearTimeout(timer); document.removeEventListener("visibilitychange", resume); };
  }, []);
  const current = clockText(clock.now), previous = clockText(clock.previous);
  if (compact) return <div className="cockpit-datetime is-compact" aria-label="设备日期和时间"><time dateTime={clock.now.toISOString()}>{new Intl.DateTimeFormat("zh-CN", { year: "numeric", month: "long", day: "numeric", weekday: "long", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(clock.now)}</time></div>;
  return <div className="cockpit-datetime" aria-label="设备日期和时间">
    <div className="cockpit-clock-date">{new Intl.DateTimeFormat("zh-CN", { month: "long", day: "numeric", weekday: "long" }).format(clock.now)}</div>
    <time className="cockpit-flip-clock" dateTime={current} aria-label={`设备时间 ${current}`}>
      {[...current].map((value, index) => value === ":" ? <span className="flip-colon" aria-hidden="true" key={index}>:</span> : <FlipDigit key={index} value={value} previous={previous[index]} />)}
    </time>
  </div>;
}
