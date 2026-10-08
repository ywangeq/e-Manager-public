async function opsUsageRequest(url, options = {}) {
  const response = await fetch(url, {
    credentials: "include",
    ...options,
    headers: {
      "Content-Type": "application/json",
      ...(options.headers || {}),
    },
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || !data.ok) {
    throw new Error(data.error || "运维统计接口失败");
  }
  return data;
}

export async function fetchOpsUsageSummary({ days = 7, systemId = "" } = {}) {
  const params = new URLSearchParams({ days: String(days) });
  if (systemId) params.set("systemId", systemId);
  return opsUsageRequest(`/api/ops/usage-summary?${params.toString()}`);
}

export async function recordOpsUsageEvent({ eventType = "view", viewId = "" } = {}) {
  try {
    await opsUsageRequest("/api/ops/usage-events", {
      method: "POST",
      body: JSON.stringify({ eventType, viewId }),
    });
  } catch {
    // Usage metrics should never break the operator's primary workflow.
  }
}
