import { projectDesktopTaskActivitySnapshot } from "../shared/desktop-task-activity.mjs";
import { projectDesktopTaskProvenance } from "../shared/desktop-task-provenance.mjs";
import {
  desktopMyTaskFeedbackRequest,
  desktopMyTaskReference,
  desktopMyTasksReorderRequest,
  normalizeDesktopMyTaskFeedbackReceipt,
  normalizeDesktopMyTaskEventPage,
  normalizeDesktopMyTaskResult,
  normalizeDesktopMyTasksPage,
  projectDesktopMyTaskDetail,
} from "../shared/desktop-my-tasks.mjs";

export function createDesktopMyTasksService({
  desktopFetch,
  isExpectedActor,
  onListFailure = () => {},
  onListProjection = () => {},
} = {}) {
  if (typeof desktopFetch !== "function" || typeof isExpectedActor !== "function") {
    throw new TypeError("desktop My Tasks service dependencies are required");
  }

  async function list({ expectedActorContextVersion, expectedActorKey } = {}) {
    try {
      assertActor(expectedActorKey, expectedActorContextVersion);
      const response = await desktopFetch("/api/me/runtime-tasks", {
        headers: { Accept: "application/json" },
      });
      const data = await response.json().catch(() => ({}));
      assertActor(expectedActorKey, expectedActorContextVersion);
      if (!response.ok) throw serviceError(data?.error || "desktop_my_tasks_list_failed");
      const page = normalizeDesktopMyTasksPage(data);
      onListProjection(page);
      return page;
    } catch (error) {
      onListFailure();
      throw error;
    }
  }

  async function reorder({ expectedActorContextVersion, expectedActorKey, request } = {}) {
    assertActor(expectedActorKey, expectedActorContextVersion);
    const body = desktopMyTasksReorderRequest(request);
    const response = await desktopFetch("/api/me/runtime-tasks/queue", {
      method: "PATCH",
      headers: { Accept: "application/json", "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const data = await response.json().catch(() => ({}));
    assertActor(expectedActorKey, expectedActorContextVersion);
    if (!response.ok) throw serviceError(data?.error || "desktop_my_tasks_reorder_failed");
    return normalizeDesktopMyTasksPage(data);
  }

  async function cancel({ employeeId, taskId, expectedActorContextVersion, expectedActorKey } = {}) {
    assertActor(expectedActorKey, expectedActorContextVersion);
    const reference = desktopMyTaskReference({ employeeId, taskId });
    const response = await desktopFetch(
      `/api/digital-employees/${encodeURIComponent(reference.employeeId)}/runtime-tasks/${encodeURIComponent(reference.taskId)}/cancel`,
      {
        method: "POST",
        headers: { Accept: "application/json", "Content-Type": "application/json" },
        body: JSON.stringify({ reasonCode: "operator_requested" }),
      },
    );
    const data = await response.json().catch(() => ({}));
    assertActor(expectedActorKey, expectedActorContextVersion);
    if ([401, 403].includes(response.status)) throw serviceError("desktop_my_tasks_access_denied");
    if (!response.ok) throw serviceError(data?.error || "desktop_my_tasks_cancel_failed");
    if (data?.task?.id !== reference.taskId) throw serviceError("desktop_my_tasks_cancel_task_mismatch");
    return Object.freeze({
      ...reference,
      status: cleanStatus(data?.task?.status || "cancel_requested"),
    });
  }

  async function feedback({ expectedActorContextVersion, expectedActorKey, request } = {}) {
    assertActor(expectedActorKey, expectedActorContextVersion);
    const normalized = desktopMyTaskFeedbackRequest(request);
    const response = await desktopFetch(
      `/api/digital-employees/${encodeURIComponent(normalized.employeeId)}/runtime-tasks/${encodeURIComponent(normalized.taskId)}/feedback`,
      {
        method: "POST",
        headers: { Accept: "application/json", "Content-Type": "application/json" },
        body: JSON.stringify({
          expectedRevision: normalized.expectedRevision,
          idempotencyKey: normalized.idempotencyKey,
          rating: normalized.rating,
          reasonCode: normalized.reasonCode,
          channelId: normalized.channelId,
        }),
      },
    );
    const data = await response.json().catch(() => ({}));
    assertActor(expectedActorKey, expectedActorContextVersion);
    if ([401, 403].includes(response.status)) throw serviceError("desktop_my_tasks_access_denied");
    if (!response.ok) throw serviceError(data?.error || "desktop_my_task_feedback_failed");
    return normalizeDesktopMyTaskFeedbackReceipt(data, normalized);
  }

  async function detail({ employeeId, taskId, expectedActorContextVersion, expectedActorKey } = {}) {
    try {
      return await readDetail({ employeeId, taskId, expectedActorContextVersion, expectedActorKey });
    } catch (error) {
      if (/access_denied|actor_changed/.test(String(error?.code || error?.message || ""))) onListFailure();
      throw error;
    }
  }

  async function readDetail({ employeeId, taskId, expectedActorContextVersion, expectedActorKey } = {}) {
    assertActor(expectedActorKey, expectedActorContextVersion);
    const reference = desktopMyTaskReference({ employeeId, taskId });
    const events = [];
    let afterSeq = 0;
    let activitySnapshot = null;
    let provenanceSnapshot = null;
    let resultAvailable = false;
    let terminalStatus = "";
    for (let pageIndex = 0; pageIndex < 20; pageIndex += 1) {
      const response = await desktopFetch(
        `/api/digital-employees/${encodeURIComponent(reference.employeeId)}/runtime-tasks/${encodeURIComponent(reference.taskId)}/events?afterSeq=${afterSeq}&limit=200`,
        { headers: { Accept: "application/json" } },
      ).catch(() => { throw serviceError("desktop_my_task_detail_network_unavailable"); });
      const data = await response.json().catch(() => ({}));
      assertActor(expectedActorKey, expectedActorContextVersion);
      if ([401, 403].includes(response.status)) throw serviceError("desktop_my_tasks_access_denied");
      if (!response.ok) throw serviceError(data?.error || "desktop_my_task_detail_failed");
      const page = normalizeDesktopMyTaskEventPage(data, { ...reference, afterSeq });
      events.push(...page.events);
      activitySnapshot = projectDesktopTaskActivitySnapshot(data, { expectedTaskId: reference.taskId });
      provenanceSnapshot = projectDesktopTaskProvenance(data, { expectedTaskId: reference.taskId });
      resultAvailable ||= page.resultAvailable;
      terminalStatus = page.taskStatus;
      if (!page.hasMore) break;
      if (page.lastSeq <= afterSeq || pageIndex === 19) {
        throw serviceError("desktop_my_task_detail_timeline_too_large");
      }
      afterSeq = page.lastSeq;
    }
    let result = null;
    if (terminalStatus === "completed") {
      if (!resultAvailable) throw serviceError("desktop_my_task_result_marker_missing");
      const response = await desktopFetch(
        `/api/digital-employees/${encodeURIComponent(reference.employeeId)}/runtime-tasks/${encodeURIComponent(reference.taskId)}/result`,
        { headers: { Accept: "application/json" } },
      ).catch(() => { throw serviceError("desktop_my_task_detail_network_unavailable"); });
      const data = await response.json().catch(() => ({}));
      assertActor(expectedActorKey, expectedActorContextVersion);
      if ([401, 403].includes(response.status)) throw serviceError("desktop_my_tasks_access_denied");
      if (!response.ok) throw serviceError(data?.error || "desktop_my_task_result_unavailable");
      result = normalizeDesktopMyTaskResult(data, reference);
    }
    return projectDesktopMyTaskDetail({ ...reference, events, result, activitySnapshot, provenanceSnapshot });
  }

  function assertActor(key, version) {
    if (!isExpectedActor(key, version)) throw serviceError("desktop_my_tasks_actor_changed");
  }

  return Object.freeze({ cancel, detail, feedback, list, reorder });
}

export function registerDesktopMyTasksIpc({
  actorContext,
  assertSender,
  ipcMain,
  service,
} = {}) {
  if (typeof actorContext !== "function" || typeof assertSender !== "function" ||
    !ipcMain?.handle || !service?.cancel || !service?.detail || !service?.feedback || !service?.list || !service?.reorder) {
    throw new TypeError("desktop My Tasks IPC dependencies are required");
  }
  ipcMain.handle("desktop:list-my-tasks", async (event) => run("list", event));
  ipcMain.handle("desktop:reorder-my-tasks", async (event, request) => run("reorder", event, request));
  ipcMain.handle("desktop:get-my-task-detail", async (event, request) => run("detail", event, request));
  ipcMain.handle("desktop:cancel-assistant-task", async (event, request) => run("cancel", event, request));
  ipcMain.handle("desktop:submit-my-task-feedback", async (event, request) => run("feedback", event, request));

  async function run(action, event, request = null) {
    assertSender(event);
    const actor = actorContext();
    if (!actor?.key) return { ok: false, status: "authentication_required" };
    try {
      const page = await service[action]({
        expectedActorContextVersion: actor.version,
        expectedActorKey: actor.key,
        ...(["reorder", "feedback"].includes(action) ? (request ? { request } : {}) : request || {}),
      });
      return action === "detail"
        ? { ok: true, detail: page }
        : action === "cancel"
          ? { ok: true, task: page }
          : action === "feedback"
            ? { ok: true, receipt: page }
          : { ok: true, page };
    } catch (error) {
      return { ok: false, status: cleanStatus(error?.code || error?.message) };
    }
  }
}

function cleanStatus(value) {
  const status = String(value || "desktop_my_tasks_failed").trim();
  return /^[a-z0-9_]{1,120}$/.test(status) ? status : "desktop_my_tasks_failed";
}

function serviceError(code) {
  const error = new Error(String(code || "desktop_my_tasks_failed"));
  error.code = String(code || "desktop_my_tasks_failed");
  return error;
}
