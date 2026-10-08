export function createOpsUsageHandlers({
  hasPermission,
  readJsonBody,
  requireSession,
  sendJson,
  store,
}) {
  function listUsageSummary(req, res, url) {
    const session = requireSession(req, res);
    if (!session) return undefined;
    if (!canReadOps(session)) {
      return sendJson(res, 403, {
        ok: false,
        error: "ops_governance_required",
        contractVersion: "ops-usage-summary.v1",
      });
    }
    return sendJson(res, 200, store.buildSummary({
      days: url.searchParams.get("days") || 7,
      systemId: url.searchParams.get("systemId") || "",
    }));
  }

  async function recordUsageEvent(req, res) {
    const session = requireSession(req, res);
    if (!session) return undefined;
    const input = await readJsonBody(req, 8 * 1024);
    const event = store.recordEvent({
      ...input,
      systemId: "digital-workforce",
      source: "digital-workforce-ui",
    }, session);
    return sendJson(res, 202, {
      ok: true,
      status: event ? "recorded" : "ignored",
      contractVersion: "ops-usage-event.v1",
    });
  }

  function canReadOps(session) {
    return (
      session?.role === "admin" ||
      hasPermission(session?.permissions, "system:read") ||
      hasPermission(session?.permissions, "ops:read")
    );
  }

  return {
    listUsageSummary,
    recordUsageEvent,
  };
}
