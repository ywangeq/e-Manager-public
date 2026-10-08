import { useEffect, useRef, useState } from "react";
import { cockpitSentinelActivity, completionSnapshot, hasNewCompletion } from "../lib/cockpitSentinelState.js";

export function useCockpitSentinelState({ authenticated, taskPhase, tasks, sources, enabled = true }) {
  const previous = useRef(new Map());
  const timer = useRef(null);
  const wakeSession = useRef(false);
  const [completed, setCompleted] = useState(false);
  const [paused, setPaused] = useState(false);
  const activity = cockpitSentinelActivity({ authenticated, taskPhase, tasks, ...sources });

  useEffect(() => {
    if (!enabled) return;
    if (!authenticated) {
      previous.current.clear();
      clearTimeout(timer.current);
      setCompleted(false);
      setPaused(false);
      wakeSession.current = false;
      return;
    }
    if (taskPhase !== "ready" || sources.goalPhase !== "ready") return;
    const next = completionSnapshot(tasks, sources.goals);
    if (hasNewCompletion(previous.current, next)) {
      setCompleted(true);
      clearTimeout(timer.current);
      timer.current = setTimeout(() => setCompleted(false), 4000);
    }
    previous.current = next;
  }, [enabled, authenticated, taskPhase, tasks, sources.goalPhase, sources.goals]);
  useEffect(() => () => clearTimeout(timer.current), []);

  return { activity: activity === "idle" && completed ? "success" : activity, paused, setPaused, wakeSession };
}
