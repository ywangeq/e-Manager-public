import { pipeline } from "node:stream/promises";

const EMERGENCY_STOP_REQUEST_FIELDS = new Set(["engaged", "expectedControlVersion", "reasonCode", "safeReason"]);

function createDigitalEmployeeScheduleHandlers({
  getDigitalEmployees = () => [],
  hasPermission,
  readJsonBody,
  requireSession,
  registry,
  operationsService = null,
  sendJson,
  tenantScope,
  taskArtifactService = null,
  manualExecutionService = null,
  configurationService = null,
} = {}) {
  function handle(req, res, url) {
    const listMatch = url.pathname.match(/^\/api\/digital-employees\/([^/]+)\/runtime-schedules$/);
    if (req.method === "GET" && listMatch) {
      const employeeId = decodeURIComponent(listMatch[1]);
      if (!requireOperationsContext(req, res, employeeId)) return Promise.resolve(true);
      try {
        if (!configurationService) sendJson(res, 503, { ok: false, error: "schedule_configuration_unavailable" });
        else sendJson(res, 200, { ok: true, schedules: configurationService.list({ employeeId }) });
      } catch (error) { operationsError(res, error, sendJson); }
      return Promise.resolve(true);
    }
    const configMatch = url.pathname.match(/^\/api\/digital-employees\/([^/]+)\/runtime-schedules\/([^/]+)\/(configuration|activate|pause)$/);
    if (configMatch && ((configMatch[3] === "configuration" && ["GET", "PUT"].includes(req.method)) ||
      (["activate", "pause"].includes(configMatch[3]) && req.method === "POST"))) {
      return configure(req, res, decodeURIComponent(configMatch[1]), decodeURIComponent(configMatch[2]), configMatch[3]).then(() => true);
    }
    const manualMatch = url.pathname.match(/^\/api\/digital-employees\/([^/]+)\/runtime-schedules\/([^/]+)\/run-now$/);
    if (req.method === "POST" && manualMatch) {
      return executeNow(req, res, ...manualMatch.slice(1).map(decodeURIComponent)).then(() => true);
    }
    const artifactMatch = url.pathname.match(/^\/api\/digital-employees\/([^/]+)\/runtime-schedules\/([^/]+)\/runs\/([^/]+)\/artifacts\/([^/]+)$/);
    if (req.method === "GET" && artifactMatch) {
      return downloadRunArtifact(req, res, ...artifactMatch.slice(1).map(decodeURIComponent)).then(() => true);
    }
    const providerDryRunMatch = url.pathname.match(/^\/api\/digital-employees\/([^/]+)\/runtime-schedules\/([^/]+)\/provider-dry-run$/);
    if (req.method === "POST" && providerDryRunMatch) {
      return retiredEndpoint(req, res).then(() => true);
    }
    const operationsMatch = url.pathname.match(/^\/api\/digital-employees\/([^/]+)\/runtime-schedules\/([^/]+)\/operations$/);
    if (req.method === "GET" && operationsMatch) {
      return getOperations(req, res, decodeURIComponent(operationsMatch[1]), decodeURIComponent(operationsMatch[2])).then(() => true);
    }
    const runsMatch = url.pathname.match(/^\/api\/digital-employees\/([^/]+)\/runtime-schedules\/([^/]+)\/runs$/);
    if (req.method === "GET" && runsMatch) {
      return getRuns(req, res, url, decodeURIComponent(runsMatch[1]), decodeURIComponent(runsMatch[2])).then(() => true);
    }
    const stopMatch = url.pathname.match(/^\/api\/digital-employees\/([^/]+)\/runtime-schedules\/([^/]+)\/emergency-stop$/);
    if (req.method === "PUT" && stopMatch) {
      return setEmergencyStop(req, res, decodeURIComponent(stopMatch[1]), decodeURIComponent(stopMatch[2])).then(() => true);
    }
    const match = url.pathname.match(/^\/api\/digital-employees\/([^/]+)\/runtime-schedules\/([^/]+)$/);
    if (req.method === "PUT" && match) {
      return retiredEndpoint(req, res).then(() => true);
    }
    if (req.method === "GET" && match) {
      return retiredEndpoint(req, res).then(() => true);
    }
    return undefined;
  }

  async function configure(req, res, employeeId, scheduleId, action) {
    const context = requireOperationsContext(req, res, employeeId);
    if (!context) return null;
    if (!configurationService) return sendJson(res, 503, { ok: false, error: "schedule_configuration_unavailable" });
    try {
      if (req.method === "GET") return sendJson(res, 200, { ok: true, ...configurationService.read({ employeeId, scheduleId }) });
      const input = await readJsonBody(req, 24 * 1024);
      const fields = action === "configuration"
        ? ["expectedRegistrationVersion", "expectedControlVersion", "configuration", "modelAssignmentId"] : ["expectedControlVersion"];
      if (!input || Array.isArray(input) || Object.keys(input).some(key => !fields.includes(key))) {
        return sendJson(res, 422, { ok: false, error: "schedule_configuration_invalid" });
      }
      const actor = publicActor(context.session);
      if (actor.principalId === "unresolved-principal") return actorRequired(res, sendJson);
      const result = action === "configuration" ? configurationService.save({ ...input, employeeId, scheduleId, actor })
        : configurationService[action]({ employeeId, scheduleId, expectedControlVersion: input.expectedControlVersion });
      return sendJson(res, 200, { ok: true, ...result,
        digitalEmployee: registry.withRegisteredSchedules([context.employee], { tenantScope })[0] });
    } catch (error) { return operationsError(res, error, sendJson); }
  }

  async function executeNow(req, res, employeeId, scheduleId) {
    const context = requireOperationsContext(req, res, employeeId);
    if (!context) return null;
    if (!manualExecutionService) return sendJson(res, 503, { ok: false, error: "schedule_manual_service_unavailable" });
    const input = await readJsonBody(req, 8 * 1024);
    if (!input || Array.isArray(input) || Object.keys(input).length !== 2 ||
      Object.keys(input).some(key => !["requestToken", "expectedControlVersion"].includes(key)) ||
      !Number.isSafeInteger(input.expectedControlVersion) || input.expectedControlVersion < 1) {
      return sendJson(res, 422, { ok: false, error: "schedule_manual_request_invalid" });
    }
    const actor = publicActor(context.session);
    if (actor.principalId === "unresolved-principal") return actorRequired(res, sendJson);
    try {
      const result = manualExecutionService.execute({ tenantScope, employeeId, scheduleId, actor,
        requestToken: input.requestToken, expectedControlVersion: input.expectedControlVersion }, { session: context.session });
      return sendJson(res, ["prepared", "submitted", "reconcile_required"].includes(result.state) ? 202 : 200,
        { ok: true, ...result });
    } catch (error) { return operationsError(res, error, sendJson); }
  }

  async function downloadRunArtifact(req, res, employeeId, scheduleId, runId, artifactId) {
    if (!requireOperationsContext(req, res, employeeId)) return null;
    if (!taskArtifactService?.resolveDownload || !operationsService?.resolveRunTask) {
      return sendJson(res, 503, { ok: false, error: "schedule_artifact_service_unavailable" });
    }
    let resolved;
    try {
      const task = operationsService.resolveRunTask({ tenantScope, employeeId, scheduleId, runId });
      if (!task || task.status !== "completed") return sendJson(res, 404, { ok: false, error: "schedule_artifact_not_found" });
      // Admin authority is scoped above to this Schedule/run. The stored task
      // identity is used only for canonical artifact ownership/integrity lookup.
      resolved = await taskArtifactService.resolveDownload({ tenantScope, employeeId, taskId: task.taskId,
        artifactId, actorIssuer: task.actorIssuer, actorSubjectDigest: task.actorSubjectDigest });
      if (resolved.taskContext?.channelId !== "schedule" || resolved.taskContext?.sessionId !== null) {
        await resolved.handle.close();
        return sendJson(res, 404, { ok: false, error: "schedule_artifact_not_found" });
      }
    } catch (error) {
      return sendJson(res, error?.code === "artifact_expired" ? 410 : 404,
        { ok: false, error: error?.code === "artifact_expired" ? "schedule_artifact_expired" : "schedule_artifact_not_found" });
    }
    const { artifact, handle } = resolved;
    try {
      res.writeHead(200, { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff",
        "Content-Type": artifact.mimeType, "Content-Length": String(artifact.sizeBytes),
        "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(artifact.fileName)}` });
      await pipeline(handle.createReadStream({ autoClose: false, start: 0 }), res);
    } catch { if (!res.destroyed) res.destroy(); }
    finally { await handle.close().catch(() => {}); }
    return null;
  }

  async function retiredEndpoint(req, res) {
    const session = requireSession(req, res);
    if (!session) return null;
    if (!isSystemAdmin(session, hasPermission)) return adminRequired(res, sendJson);
    return sendJson(res, 410, { ok: false, error: "schedule_legacy_endpoint_retired",
      message: "旧登记和 Provider 试跑入口已移除，请使用定时任务配置。" });
  }

  async function getOperations(req, res, employeeId, scheduleId) {
    const context = requireOperationsContext(req, res, employeeId);
    if (!context) return null;
    try {
      return sendJson(res, 200, {
        ok: true,
        ...operationsService.getOperations({
          tenantScope,
          employeeId,
          scheduleId,
          currentActor: publicActor(context.session),
        }),
      });
    } catch (error) {
      return operationsError(res, error, sendJson);
    }
  }

  async function getRuns(req, res, url, employeeId, scheduleId) {
    const context = requireOperationsContext(req, res, employeeId);
    if (!context) return null;
    try {
      return sendJson(res, 200, {
        ok: true,
        ...operationsService.listRuns({
          tenantScope,
          employeeId,
          scheduleId,
          beforeScheduledFor: url.searchParams.get("beforeScheduledFor") || null,
          limit: url.searchParams.get("limit") || 20,
        }),
      });
    } catch (error) {
      return operationsError(res, error, sendJson);
    }
  }

  async function setEmergencyStop(req, res, employeeId, scheduleId) {
    const context = requireOperationsContext(req, res, employeeId);
    if (!context) return null;
    const input = await readJsonBody(req, 8 * 1024);
    const unknownField = Object.keys(input || {}).find((field) => !EMERGENCY_STOP_REQUEST_FIELDS.has(field));
    if (unknownField) {
      return sendJson(res, 422, {
        ok: false,
        error: "digital_employee_schedule_emergency_stop_request_unknown_field",
        message: "Schedule 急停请求包含不允许的字段。",
      });
    }
    const actor = publicActor(context.session);
    if (actor.principalId === "unresolved-principal") return actorRequired(res, sendJson);
    try {
      const result = operationsService.setEmergencyStop({
        tenantScope,
        employeeId,
        scheduleId,
        expectedControlVersion: input.expectedControlVersion,
        engaged: input.engaged,
        reasonCode: input.reasonCode,
        safeReason: input.safeReason,
        actor,
      });
      const cancellationPending = input.engaged &&
        ["pending", "awaiting_terminal", "reconcile_required"].includes(result.cancellation?.state);
      return sendJson(res, cancellationPending ? 202 : 200, {
        ok: true,
        ...result,
      });
    } catch (error) {
      return operationsError(res, error, sendJson);
    }
  }

  function requireOperationsContext(req, res, employeeId) {
    const session = requireSession(req, res);
    if (!session) return null;
    if (!isSystemAdmin(session, hasPermission)) {
      adminRequired(res, sendJson);
      return null;
    }
    if (!operationsService) {
      sendJson(res, 503, {
        ok: false,
        error: "schedule_operations_unavailable",
        message: "Schedule 运行控制服务尚不可用。",
      });
      return null;
    }
    const employee = getDigitalEmployees().find((item) => item.id === employeeId);
    if (!employee) {
      sendJson(res, 404, { ok: false, error: "digital_employee_not_found" });
      return null;
    }
    return { employee, session };
  }

  return Object.freeze({ handle });
}

function adminRequired(res, sendJson) {
  return sendJson(res, 403, {
    ok: false,
    error: "digital_employee_schedule_admin_required",
    message: "只有系统管理员可以查看或登记企业 Schedule。",
  });
}

function actorRequired(res, sendJson) {
  return sendJson(res, 422, {
    ok: false,
    error: "digital_employee_schedule_actor_unavailable",
    message: "Schedule 管理操作需要稳定的企业用户主体。",
  });
}

function operationsError(res, error, sendJson) {
  const code = String(error?.code || "schedule_operations_unavailable");
  const statusCode = [
    "schedule_control_version_conflict",
    "schedule_control_cancellation_reconcile_pending",
    "schedule_operations_cancellation_not_settled",
    "governed_schedule_version_conflict",
    "schedule_configuration_pause_required",
    "schedule_configuration_runs_pending",
  ].includes(code)
    ? 409
    : ["schedule_operations_schedule_not_found", "schedule_configuration_not_found"].includes(code) ? 404
      : code.endsWith("_unavailable") ? 503 : 422;
  return sendJson(res, statusCode, {
    ok: false,
    error: code,
    message: code === "schedule_control_version_conflict"
      ? "Schedule 控制版本已经变化，请刷新后重试。"
      : code === "schedule_operations_schedule_not_found"
        ? "未找到该员工已登记的 Schedule。"
        : "Schedule 运行控制请求未通过校验。",
  });
}

function isSystemAdmin(session = {}, hasPermission = () => false) {
  const permissions = Array.isArray(session.permissions) ? session.permissions : [];
  return session.role === "admin" || hasPermission(permissions, "system:*") ||
    permissions.includes("digital-employees:schedules:*");
}

function safeActor(session = {}) {
  const stablePrincipal = [session.feishuUserId, session.employeeNo, session.subjectId, session.userId, session.employeeId]
    .map((value) => String(value || "").trim())
    .find((value) => value && !value.includes("@"));
  if (stablePrincipal) return stablePrincipal
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .trim()
    .slice(0, 120);
  return "unresolved-principal";
}

function publicActor(session = {}) {
  const displayName = String(session.displayName || session.name || "")
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .trim()
    .slice(0, 120);
  const identitySource = String(session.identitySource || "unverified-session").trim().slice(0, 120);
  const verified = Boolean(displayName) && identitySource === "fortress-sso-v3";
  return {
    principalId: safeActor(session),
    displayName: displayName || "目录姓名待解析",
    nameStatus: verified ? "verified" : "unresolved",
    identitySource,
    resolvedAt: verified ? new Date().toISOString() : null,
  };
}

export { createDigitalEmployeeScheduleHandlers,
  isSystemAdmin as isScheduleSystemAdmin, publicActor as scheduleManagementActor };
