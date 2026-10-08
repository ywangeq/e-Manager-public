import { pipeline } from "node:stream/promises";

const DELIVERY_CONTRACT_VERSION = "digital-employee-task-artifact.v1";

export function createTaskArtifactRouteSupport({
  authorizeReferenceTaskArtifact = null,
  canInvokeDigitalEmployee,
  cleanEmployeeId,
  currentDigitalEmployees,
  requireSession,
  resolveSessionRoute,
  sendJson,
  sessionRepository,
  reusableArtifactMaterialService,
  taskArtifactService,
} = {}) {
  async function describe(req, res, requestedEmployeeId, encodedTaskId, encodedArtifactId) {
    const authorized = await authorize(req, res, requestedEmployeeId, encodedTaskId, encodedArtifactId, { allowReferenceTask: true });
    if (!authorized) return null;
    try {
      return sendJson(res, 200, {
        ok: true,
        contractVersion: DELIVERY_CONTRACT_VERSION,
        employeeId: authorized.employeeId,
        taskId: authorized.taskId,
        artifact: publicArtifact(authorized.artifact),
      });
    } finally {
      await authorized.handle.close().catch(() => {});
    }
  }

  async function stream(req, res, requestedEmployeeId, encodedTaskId, encodedArtifactId) {
    const authorized = await authorize(req, res, requestedEmployeeId, encodedTaskId, encodedArtifactId, { allowReferenceTask: true });
    if (!authorized) return null;
    const { artifact, handle } = authorized;
    res.writeHead(200, {
      "Cache-Control": "no-store",
      "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(artifact.fileName)}`,
      "Content-Length": String(artifact.sizeBytes),
      "Content-Type": artifact.mimeType,
      "X-Content-Type-Options": "nosniff",
      "X-Digital-Workforce-Artifact-Contract": DELIVERY_CONTRACT_VERSION,
      "X-Digital-Workforce-Artifact-Id": artifact.artifactId,
      "X-Digital-Workforce-Artifact-Sha256": artifact.sha256,
    });
    const input = handle.createReadStream({ autoClose: false, start: 0 });
    try {
      await pipeline(input, res);
    } catch {
      if (!res.destroyed) res.destroy();
    } finally {
      input.destroy();
      await handle.close().catch(() => {});
    }
    return null;
  }

  async function saveReusable(req, res, requestedEmployeeId, encodedTaskId, encodedArtifactId) {
    const authorized = await authorize(req, res, requestedEmployeeId, encodedTaskId, encodedArtifactId);
    if (!authorized) return null;
    await authorized.handle.close().catch(() => {});
    if (!reusableArtifactMaterialService?.savePersonal) {
      return sendJson(res, 501, { ok: false, error: "reusable_artifact_material_service_unavailable" });
    }
    try {
      const material = await reusableArtifactMaterialService.savePersonal({
        tenantScope: authorized.route.tenantScope,
        taskId: authorized.taskId,
        artifactId: authorized.artifact.artifactId,
        actorIssuer: authorized.route.actorIssuer,
        actorSubjectDigest: authorized.route.actorSubjectDigest,
        employeeId: authorized.employeeId,
      });
      return sendJson(res, 200, { ok: true, material });
    } catch (error) {
      const failure = publicReusableArtifactFailure(error);
      return sendJson(res, failure.statusCode, { ok: false, error: failure.error });
    }
  }

  async function listReusable(req, res, requestedEmployeeId, { includeSource = false } = {}) {
    const authorized = authorizeEmployee(req, res, requestedEmployeeId);
    if (!authorized) return null;
    if (!reusableArtifactMaterialService?.listPersonal) {
      return sendJson(res, 501, { ok: false, error: "reusable_artifact_material_service_unavailable" });
    }
    try {
      return sendJson(res, 200, {
        ok: true,
        contractVersion: includeSource ? "reusable-artifact-material-list.v2" : "reusable-artifact-material-list.v1",
        materials: reusableArtifactMaterialService.listPersonal({
          tenantScope: authorized.route.tenantScope,
          actorIssuer: authorized.route.actorIssuer,
          actorSubjectDigest: authorized.route.actorSubjectDigest,
          includeSource,
        }),
      });
    } catch (error) {
      const failure = publicReusableArtifactFailure(error);
      return sendJson(res, failure.statusCode, { ok: false, error: failure.error });
    }
  }

  async function authorize(req, res, requestedEmployeeId, encodedTaskId, encodedArtifactId, { allowReferenceTask = false } = {}) {
    const employeeAuthorization = authorizeEmployee(req, res, requestedEmployeeId);
    if (!employeeAuthorization) return null;
    if (!taskArtifactService?.resolveDownload) {
      sendJson(res, 501, { ok: false, error: "task_artifact_service_unavailable" });
      return null;
    }
    const { employeeId, route } = employeeAuthorization;
    const taskId = decodedToken(encodedTaskId);
    const artifactId = decodedToken(encodedArtifactId);
    if (!taskId || !artifactId) {
      sendJson(res, 400, { ok: false, error: "task_artifact_reference_invalid" });
      return null;
    }
    let resolved;
    try {
      resolved = await taskArtifactService.resolveDownload({
        tenantScope: route.tenantScope,
        taskId,
        artifactId,
        actorIssuer: route.actorIssuer,
        actorSubjectDigest: route.actorSubjectDigest,
        employeeId,
      });
    } catch (error) {
      const failure = publicArtifactFailure(error);
      sendJson(res, failure.statusCode, { ok: false, error: failure.error });
      return null;
    }
    const taskContext = resolved.taskContext;
    const storedRoute = taskContext?.sessionId
      ? await sessionRepository.readVerifiedRoute(taskContext.sessionId).catch(() => null)
      : null;
    const sessionRouteAuthorized = Boolean(storedRoute && taskContext.channelId === "desktop" &&
      storedRoute.routeDigest === route.routeDigest && storedRoute.channelId === "desktop" &&
      storedRoute.employeeId === employeeId && storedRoute.tenantScope === route.tenantScope &&
      storedRoute.actorIssuer === route.actorIssuer && storedRoute.actorSubjectDigest === route.actorSubjectDigest);
    let referenceTaskAuthorized = false;
    if (!sessionRouteAuthorized && allowReferenceTask && typeof authorizeReferenceTaskArtifact === "function") {
      try {
        referenceTaskAuthorized = await authorizeReferenceTaskArtifact({
          artifactId,
          employeeId,
          route,
          taskContext,
          taskId,
        }) === true;
      } catch { /* Fail closed without exposing canonical provenance details. */ }
    }
    if (!sessionRouteAuthorized && !referenceTaskAuthorized) {
      await resolved.handle.close().catch(() => {});
      sendJson(res, 404, { ok: false, error: "task_artifact_not_found" });
      return null;
    }
    return Object.freeze({ ...resolved, employeeId, route, taskId });
  }

  function authorizeEmployee(req, res, requestedEmployeeId) {
    const session = requireSession(req, res);
    if (!session) return null;
    const employeeId = cleanEmployeeId(requestedEmployeeId);
    const employee = currentDigitalEmployees().find((item) => cleanEmployeeId(item.id) === employeeId);
    if (!employee) {
      sendJson(res, 404, { ok: false, error: "digital_employee_not_found" });
      return null;
    }
    if (typeof canInvokeDigitalEmployee === "function" && !canInvokeDigitalEmployee({ channelId: "desktop", employee, session })) {
      sendJson(res, 403, { ok: false, error: "digital_employee_access_required" });
      return null;
    }
    return Object.freeze({
      employeeId,
      route: resolveSessionRoute({ channelId: "desktop", employeeId, session }),
    });
  }

  return Object.freeze({ describe, listReusable, saveReusable, stream });
}

function publicArtifact(artifact) {
  return Object.freeze({
    artifactId: artifact.artifactId,
    fileName: artifact.fileName,
    mimeType: artifact.mimeType,
    sizeBytes: artifact.sizeBytes,
    deliveryStatus: "available",
  });
}

function decodedToken(value) {
  try {
    const decoded = decodeURIComponent(String(value || ""));
    return /^[A-Za-z0-9][A-Za-z0-9._:@-]{0,159}$/.test(decoded) ? decoded : "";
  } catch {
    return "";
  }
}

function publicArtifactFailure(error) {
  if (error?.code === "artifact_task_not_completed") return { statusCode: 409, error: "task_artifact_not_completed" };
  if (error?.code === "artifact_expired") return { statusCode: 410, error: "task_artifact_expired" };
  if (error?.code === "artifact_object_integrity_invalid") return { statusCode: 422, error: "task_artifact_integrity_failed" };
  return { statusCode: 404, error: "task_artifact_not_found" };
}

function publicReusableArtifactFailure(error) {
  if (["artifact_task_not_completed", "reusable_artifact_source_unavailable"].includes(error?.code)) {
    return { statusCode: 409, error: "reusable_artifact_source_not_completed" };
  }
  if (["artifact_expired", "reusable_artifact_not_found"].includes(error?.code)) {
    return { statusCode: 410, error: "reusable_artifact_unavailable" };
  }
  if (["artifact_object_integrity_invalid", "reusable_artifact_integrity_invalid"].includes(error?.code)) {
    return { statusCode: 422, error: "reusable_artifact_integrity_failed" };
  }
  return { statusCode: 404, error: "reusable_artifact_not_found" };
}

export { DELIVERY_CONTRACT_VERSION };
