import { useCallback, useEffect, useState } from "react";

export function useToolAssetCatalog() {
  const [catalog, setCatalog] = useState({ tools: [], status: "loading" });
  const [revision, setRevision] = useState(0);
  const reload = useCallback(() => setRevision(value => value + 1), []);
  useEffect(() => {
    const controller = new AbortController();
    setCatalog({ tools: [], status: "loading" });
    fetch("/api/tool-assets/catalog", { credentials: "include", signal: controller.signal })
      .then(async response => {
        const data = await response.json();
        if (!response.ok || !data.ok || !Array.isArray(data.tools)) throw new Error("tool_catalog_unavailable");
        if (!controller.signal.aborted) setCatalog({ tools: data.tools, status: "ready" });
      })
      .catch(() => { if (!controller.signal.aborted) setCatalog({ tools: [], status: "unavailable" }); });
    return () => controller.abort();
  }, [revision]);
  return { ...catalog, reload };
}
