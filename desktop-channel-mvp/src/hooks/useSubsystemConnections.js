import { useCallback, useEffect, useRef, useState } from "react";

export function useSubsystemConnections(desktopApi, enabled) {
  const [snapshot, setSnapshot] = useState({ phase: "loading", connections: [] });
  const [busyId, setBusyId] = useState("");
  const [actionError, setActionError] = useState("");
  const requestRef = useRef(null);
  useEffect(() => {
    let current = true;
    let reading = null;
    const publish = result => {
      if (!current) return;
      setSnapshot(result?.ok === true ? { phase: "ready", connections: result.connections || [] } : { phase: "error", connections: [] });
    };
    setBusyId("");
    setActionError("");
    if (!enabled || !desktopApi?.subsystemConnections) {
      setSnapshot({ phase: desktopApi ? enabled ? "unsupported" : "loading" : "preview", connections: [] });
      requestRef.current = null;
      return () => { current = false; };
    }
    setSnapshot({ phase: "loading", connections: [] });
    const read = () => {
      if (reading) return reading;
      reading = Promise.resolve().then(() => desktopApi.subsystemConnections({ action: "list" }))
        .then(publish, () => publish(null)).finally(() => { reading = null; });
      return reading;
    };
    requestRef.current = async (action, connectionId) => {
      setBusyId(connectionId);
      setActionError("");
      try {
        const result = await desktopApi.subsystemConnections({ action, connectionId });
        if (!current) return;
        if (result?.ok) publish(result);
        else setActionError("操作暂未完成，请检查连接后重试。");
      } catch {
        if (current) setActionError("连接服务暂不可用，请稍后重试。");
      } finally {
        if (current) { setBusyId(""); await read(); }
      }
    };
    void read();
    const removeListener = desktopApi.onSubsystemConnectionsChanged?.(read);
    const foregroundRead = () => { if (document.visibilityState !== "hidden") void read(); };
    window.addEventListener("focus", foregroundRead);
    window.addEventListener("online", foregroundRead);
    document.addEventListener("visibilitychange", foregroundRead);
    const timer = window.setInterval(foregroundRead, 30_000);
    return () => {
      current = false;
      requestRef.current = null;
      removeListener?.();
      window.clearInterval(timer);
      window.removeEventListener("focus", foregroundRead);
      window.removeEventListener("online", foregroundRead);
      document.removeEventListener("visibilitychange", foregroundRead);
    };
  }, [desktopApi, enabled]);
  const act = useCallback((action, id) => requestRef.current?.(action, id), []);
  return { ...snapshot, busyId, actionError, act };
}
