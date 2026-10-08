import { projectTriggerExecutionTaskBinding } from "./triggers/trigger-event-submission-service.mjs";

function createTriggerManagementHandlers({
  businessLocatorRepository,
  configRepository,
  credentialStatus,
  getDigitalEmployees,
  hasPermission,
  readJsonBody,
  requireSession,
  runtimeTaskRepository,
  sendJson,
  tenantScope,
  triggerEventRepository,
} = {}) {
  if (typeof configRepository?.safeManagementSnapshot !== "function" ||
    typeof businessLocatorRepository?.locateExact !== "function" ||
    typeof readJsonBody !== "function" || typeof runtimeTaskRepository?.get !== "function" ||
    typeof triggerEventRepository?.get !== "function" || typeof triggerEventRepository?.list !== "function") {
    throw new TypeError("Trigger management repositories are required");
  }

  async function handle(req, res, url) {
    if (!["/api/trigger-management", "/api/trigger-management/locate"].includes(url.pathname)) return undefined;
    const expectedMethod = url.pathname.endsWith("/locate") ? "POST" : "GET";
    if (req.method !== expectedMethod) {
      return sendJson(res, 405, { ok: false, error: "method_not_allowed" });
    }
    const session = requireSession(req, res);
    if (!session) return undefined;
    if (!hasPermission(session.permissions, "system:*")) {
      return sendJson(res, 403, { ok: false, error: "forbidden" });
    }
    if (url.pathname.endsWith("/locate")) return locate(req, res);
    const configuration = configRepository.safeManagementSnapshot({ credentialStatus });
    const employees = new Map((getDigitalEmployees?.() || []).map((item) => [item.id, item]));
    const events = triggerEventRepository.list({ tenantScope, limit: 200 })
      .map((item) => projectManagementEvent(item, { employees, runtimeTaskRepository, tenantScope }));
    const referencedEmployeeIds = new Set([
      ...configuration.bindings.map((item) => item.targetEmployeeId),
      ...events.map((item) => item.targetEmployeeId),
    ]);
    return sendJson(res, 200, {
      ok: true,
      contractVersion: "trigger-management.v1",
      configuration,
      employees: [...referencedEmployeeIds].map((employeeId) => employees.get(employeeId) || { id: employeeId })
        .map((item) => ({ id: item.id, name: item.name || item.id, status: item.status || "unknown", version: item.version || "" })),
      events,
    });
  }

  async function locate(req, res) {
    let query;
    try {
      query = normalizeLocatorQuery(await readJsonBody(req, 4 * 1024));
    } catch {
      return sendJson(res, 422, { ok: false, error: "trigger_business_locator_query_invalid" });
    }
    let matches;
    try {
      matches = businessLocatorRepository.locateExact({
        tenantScope,
        locatorType: query.locatorType,
        locatorValue: query.exactValue,
        limit: 20,
      });
    } catch {
      return sendJson(res, 500, { ok: false, error: "trigger_business_locator_lookup_failed" });
    }
    const employees = new Map((getDigitalEmployees?.() || []).map((item) => [item.id, item]));
    const events = matches.flatMap((match) => {
      try {
        const triggerEvent = triggerEventRepository.get(match.triggerEventId, { tenantScope });
        if (!triggerEvent || triggerEvent.executionSnapshot.sourceSystemId !== match.sourceSystemId) return [];
        const expectedTask = projectTriggerExecutionTaskBinding(triggerEvent);
        if (expectedTask.taskId !== match.taskId) return [];
        return [Object.freeze({
          ...projectManagementEvent(triggerEvent, { employees, runtimeTaskRepository, tenantScope }),
          locatorObservedAt: match.observedAt,
        })];
      } catch {
        return [];
      }
    });
    return sendJson(res, 200, {
      ok: true,
      contractVersion: "trigger-business-locator-result.v1",
      locatorType: query.locatorType,
      matchCount: events.length,
      events,
    });
  }

  return Object.freeze({ handle });
}

function projectManagementEvent(item, { employees, runtimeTaskRepository, tenantScope }) {
  const expectedTask = projectTriggerExecutionTaskBinding(item);
  const task = runtimeTaskRepository.get(expectedTask.taskId, { tenantScope });
  return Object.freeze({
    triggerEventId: item.triggerEventId,
    bindingId: item.bindingId,
    occurredAt: item.event.occurredAt,
    eventType: item.event.eventType,
    sourceSystemId: item.executionSnapshot.sourceSystemId,
    targetEmployeeId: item.executionSnapshot.targetEmployeeId,
    targetEmployeeName: employees.get(item.executionSnapshot.targetEmployeeId)?.name || item.executionSnapshot.targetEmployeeId,
    taskId: task?.taskId || "",
    taskStatus: task?.status || "not_submitted",
    lastErrorCode: task?.lastErrorCode || "",
    resultSummary: task?.resultSummary || "",
  });
}

function normalizeLocatorQuery(value) {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
    Object.keys(value).length !== 3 || value.contractVersion !== "trigger-business-locator-query.v1" ||
    value.locatorType !== "contract_number" || typeof value.exactValue !== "string" ||
    value.exactValue !== value.exactValue.trim() || !value.exactValue || value.exactValue.length > 200 ||
    /[\u0000-\u001F\u007F]/.test(value.exactValue)) {
    throw new TypeError("Trigger business locator query invalid");
  }
  return Object.freeze({ locatorType: value.locatorType, exactValue: value.exactValue.normalize("NFC") });
}

export { createTriggerManagementHandlers };
