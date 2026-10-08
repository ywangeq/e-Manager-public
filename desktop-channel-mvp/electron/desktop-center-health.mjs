const DEFAULT_HEALTH_TIMEOUT_MS = 1_200;

function createDesktopCenterHealthCheck({ browserSession, timeoutMs = DEFAULT_HEALTH_TIMEOUT_MS } = {}) {
  if (typeof browserSession?.fetch !== "function") throw new Error("desktop_center_session_unavailable");
  const boundedTimeoutMs = Number.isFinite(Number(timeoutMs)) && Number(timeoutMs) > 0
    ? Math.min(Math.round(Number(timeoutMs)), 10_000)
    : DEFAULT_HEALTH_TIMEOUT_MS;

  return async function serverIsHealthy(candidate) {
    if (!candidate) return false;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), boundedTimeoutMs);
    try {
      const response = await browserSession.fetch(new URL("/api/health", `${candidate}/`).toString(), {
        signal: controller.signal,
      });
      const contentType = response.headers.get("content-type") || "";
      if (!response.ok || !contentType.includes("application/json")) return false;
      const data = await response.json().catch(() => ({}));
      return data.ok === true && data.service === "digital-workforce-auth";
    } catch {
      return false;
    } finally {
      clearTimeout(timeout);
    }
  };
}

export { createDesktopCenterHealthCheck };
