const SAFE_CONTRACT = "group-run-safe-projection.v1";

export async function fetchGroupRunProjection({ runId, fetcher = globalThis.fetch, requester = null, signal } = {}) {
  if (typeof runId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:@-]{0,159}$/.test(runId)) {
    throw new Error("group_run_id_invalid");
  }
  if (typeof requester !== "function" && typeof fetcher !== "function") throw new Error("group_projection_fetcher_required");
  if (typeof requester === "function") {
    const body = await requester({ runId });
    if (!body || body.ok !== true) throw new Error(body?.error || "group_projection_unavailable");
    const projection = body.projection;
    if (!projection || projection.contractVersion !== SAFE_CONTRACT || projection.runId !== runId) throw new Error("group_projection_invalid");
    return Object.freeze(projection);
  }
  const response = await fetcher(`/api/group-studio/runs/${encodeURIComponent(runId)}`, {
    method: "GET", credentials: "same-origin", signal,
    headers: { Accept: "application/json" },
  });
  const body = await response.json();
  if (!response.ok || body?.ok !== true) throw new Error(body?.error || "group_projection_unavailable");
  const projection = body.projection;
  if (!projection || projection.contractVersion !== SAFE_CONTRACT || projection.runId !== runId) {
    throw new Error("group_projection_invalid");
  }
  return Object.freeze(projection);
}
