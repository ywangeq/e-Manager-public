import { useEffect, useState } from "react";

export function useCalendarMeetings(api, revision) {
  const [state, setState] = useState({ phase: "not_synced", snapshots: [] });
  useEffect(() => {
    let alive = true, sequence = 0;
    const refresh = async () => {
      const current = ++sequence;
      try {
        const value = await api?.calendarSnapshot?.();
        if (alive && current === sequence) setState(value?.ok ? value : { phase: "unavailable", snapshots: [] });
      } catch { if (alive && current === sequence) setState({ phase: "unavailable", snapshots: [] }); }
    };
    void refresh();
    const unsubscribe = api?.onCalendarChanged?.(refresh);
    window.addEventListener("focus", refresh);
    return () => { alive = false; sequence++; unsubscribe?.(); window.removeEventListener("focus", refresh); };
  }, [api, revision]);
  return state;
}
