import { useEffect, useState } from "react";
import { ArrowsInSimple, ArrowsOutSimple } from "@phosphor-icons/react";

export function MaximizeButton({ desktopApi, className = "" }) {
  const [maximized, setMaximized] = useState(false);
  useEffect(() => {
    if (!desktopApi?.getMaximized) return undefined;
    let mounted = true;
    let receivedState = false;
    const unsubscribe = desktopApi.onMaximizedState?.((next) => { receivedState = true; if (mounted) setMaximized(next === true); });
    Promise.resolve().then(() => desktopApi.getMaximized()).then((next) => {
      if (mounted && !receivedState) setMaximized(next === true);
    }).catch(() => {});
    return () => { mounted = false; unsubscribe?.(); };
  }, [desktopApi]);
  if (!desktopApi?.toggleMaximized) return null;
  const label = maximized ? "还原窗口" : "最大化窗口";
  const Icon = maximized ? ArrowsInSimple : ArrowsOutSimple;
  return <button type="button" className={className} aria-label={label} title={label} onClick={() => void desktopApi.toggleMaximized()}><Icon size={17} /></button>;
}
