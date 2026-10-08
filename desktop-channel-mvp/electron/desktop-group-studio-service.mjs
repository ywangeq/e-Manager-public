// Only this boundary may label a rejection as a Center-safe service error.
const serviceErrors = new WeakSet();
const GROUP_MATERIAL_SAFE_ERROR_CODES = new Set([
  "desktop_group_actor_changed",
  "desktop_material_authentication_required",
  "desktop_material_bridge_contract_invalid",
  "desktop_material_bridge_empty",
  "desktop_material_employee_required",
  "desktop_material_intake_failed",
  "desktop_material_selection_expired",
  "desktop_material_skill_contract_stale",
  "group_material_employee_authorization_denied",
  "group_material_intake_unavailable",
  "group_material_manifest_invalid",
  "group_material_reference_unavailable",
]);
function safePlanningContext(value = null) {
  const goal = value?.goal; const groupVersion = value?.groupVersion;
  const id = value => typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._:@-]{0,159}$/.test(value);
  if (!goal || !groupVersion || !id(goal.goalId) || !Number.isSafeInteger(goal.revision) || goal.revision < 1 || !id(groupVersion.groupId) || !Number.isSafeInteger(groupVersion.version) || groupVersion.version < 1) return null;
  return { goal: { goalId: goal.goalId, revision: goal.revision }, groupVersion: { groupId: groupVersion.groupId, version: groupVersion.version } };
}
function serviceError(code, context = null) {
  const error = new Error(code);
  error.code = code;
  error.groupIpcContext = safePlanningContext(context);
  serviceErrors.add(error);
  return error;
}
const RUN_ID = /^[A-Za-z0-9][A-Za-z0-9._:@-]{0,159}$/;

export function createDesktopGroupStudioService({ desktopFetch, isExpectedActor, loadDisplayHistory = null, onHistoryDeleted = null, onGoalSession = null } = {}) {
  if (typeof desktopFetch !== "function" || typeof isExpectedActor !== "function") {
    throw new TypeError("desktop Group Studio service dependencies are required");
  }
  async function request(path, { method = "GET", body, expectedActorKey, expectedActorContextVersion } = {}) {
    if (!isExpectedActor(expectedActorKey, expectedActorContextVersion)) throw serviceError("desktop_group_actor_changed");
    const response = await desktopFetch(path, {
      method,
      headers: { Accept: "application/json", ...(body ? { "Content-Type": "application/json" } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    const data = await response.json().catch(() => ({}));
    if (!isExpectedActor(expectedActorKey, expectedActorContextVersion)) throw serviceError("desktop_group_actor_changed");
    if (!response.ok || data?.ok !== true) throw serviceError(/^(?:group|desktop_group|task_planner|agent_turn|agent_run|model|provider|digital_employee)_[a-z0-9_]{1,100}$/.test(data?.error || "") ? data.error : "desktop_group_request_failed", data);
    return data;
  }
  return Object.freeze({
    renameGoal: (input = {}) => {
      if (!RUN_ID.test(String(input.goalId || ""))) throw serviceError("desktop_group_goal_id_invalid");
      return request(`/api/group-studio/goals/${encodeURIComponent(input.goalId)}/title`, { ...input, method: "PATCH", body: { title: input.title, expectedDisplayRevision: input.expectedDisplayRevision } });
    },
    acceptance: (input = {}) => {
      if (!RUN_ID.test(String(input.runId || ""))) throw serviceError("desktop_group_run_id_invalid");
      return request(`/api/group-studio/runs/${encodeURIComponent(input.runId)}/acceptance`, { ...input, method: "POST", body: input.body });
    },
    reviewOpinions: (input = {}) => {
      if (!RUN_ID.test(String(input.runId || ""))) throw serviceError("desktop_group_opinion_input_invalid");
      return request(`/api/group-studio/runs/${encodeURIComponent(input.runId)}/review-opinions`, { ...input, method: "GET", body: undefined });
    },
    deleteHistory: (input = {}) => {
      if (!RUN_ID.test(String(input.goalId || ""))) throw serviceError("desktop_group_goal_id_invalid");
      return request(`/api/group-studio/history/${encodeURIComponent(input.goalId)}`, { ...input, method: "DELETE", body: undefined })
        .then(async (result) => { await onHistoryDeleted?.({ goalId: input.goalId }); return result; });
    },
    history: (input = {}) => request("/api/group-studio/history", { expectedActorKey: input.expectedActorKey, expectedActorContextVersion: input.expectedActorContextVersion }),
    displayHistory: (input = {}) => {
      if (!RUN_ID.test(String(input.goalId || ""))) throw serviceError("desktop_group_goal_id_invalid");
      if (typeof loadDisplayHistory === "function") return loadDisplayHistory(input);
      return request(`/api/group-studio/goals/${encodeURIComponent(input.goalId)}/display-history`, { ...input, method: "GET", body: undefined });
    },
    revisionDraft: (input = {}) => {
      if (!RUN_ID.test(String(input.goalId || "")) || !Number.isSafeInteger(input.goalRevision) || input.goalRevision < 1) {
        throw serviceError("desktop_group_goal_id_invalid");
      }
      return request(`/api/group-studio/goals/${encodeURIComponent(input.goalId)}/revisions/${input.goalRevision}/draft`,
        { ...input, method: "GET", body: undefined });
    },
    message: async (input = {}) => {
      const result = await request("/api/group-studio/messages", { ...input, method: "POST", body: input.body });
      if (result?.goal?.goalId && result.goal.transcriptSessionId) {
        await onGoalSession?.({ goalId: result.goal.goalId, transcriptSessionId: result.goal.transcriptSessionId });
      }
      return result;
    },
    cancelPlanning: (input = {}) => {
      if (!input.body || typeof input.body !== "object" || Array.isArray(input.body)) throw serviceError("desktop_group_planning_cancel_input_invalid");
      return request("/api/group-studio/planning-cancellations", { ...input, method: "POST", body: input.body });
    },
    goal: async (input = {}) => {
      const result = await request("/api/group-studio/goals", { ...input, method: "POST", body: input.body });
      if (result?.goal?.goalId && result.goal.transcriptSessionId) {
        await onGoalSession?.({ goalId: result.goal.goalId, transcriptSessionId: result.goal.transcriptSessionId });
      }
      return result;
    },
    groupVersion: (input = {}) => request("/api/group-studio/group-versions", { ...input, method: "POST", body: input.body }),
    planDraft: (input = {}) => request("/api/group-studio/plan-drafts", { ...input, method: "POST", body: input.body }),
    material: (input = {}) => request("/api/group-studio/material-intakes", { ...input, method: "POST", body: input.body }),
    adopt: (input = {}) => request("/api/group-studio/plans/adopt", { ...input, method: "POST", body: input.body }),
    run: (input = {}) => request("/api/group-studio/runs", { ...input, method: "POST", body: input.body }),
    projection: (input = {}) => {
      if (!RUN_ID.test(String(input.runId || ""))) throw serviceError("desktop_group_run_id_invalid");
      return request(`/api/group-studio/runs/${encodeURIComponent(String(input.runId))}`, { ...input, method: "GET", body: undefined });
    },
    start: (input = {}) => {
      if (!input.body || typeof input.body !== "object" || Array.isArray(input.body)) throw serviceError("desktop_group_start_body_invalid");
      return request("/api/group-studio/runs", { ...input, method: "POST", body: input.body });
    },
    resume: (input = {}) => {
      if (!RUN_ID.test(String(input.runId || "")) || !Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 0) throw serviceError("desktop_group_resume_input_invalid");
      return request(`/api/group-studio/runs/${encodeURIComponent(input.runId)}/resume`, { ...input, method: "POST", body: { expectedRevision: input.expectedRevision } });
    },
    cancel: (input = {}) => {
      if (!RUN_ID.test(String(input.runId || "")) || !Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 0) throw serviceError("desktop_group_cancel_input_invalid");
      return request(`/api/group-studio/runs/${encodeURIComponent(input.runId)}/cancel`, { ...input, method: "POST", body: { expectedRevision: input.expectedRevision } });
    },
    advance: (input = {}) => {
      if (!RUN_ID.test(String(input.runId || "")) || !Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 0) throw serviceError("desktop_group_advance_input_invalid");
      return request(`/api/group-studio/runs/${encodeURIComponent(String(input.runId))}/advance`, { ...input, method: "POST", body: { expectedRevision: input.expectedRevision } });
    },
  });
}

export function registerDesktopGroupStudioIpc({ ipcMain, assertSender, service, actorContext } = {}) {
  if (!ipcMain || typeof assertSender !== "function" || !service || typeof actorContext !== "function") throw new TypeError("desktop Group Studio IPC dependencies are required");
  const invoke = (channel, handler) => ipcMain.handle(channel, async (event, input = {}) => {
    try { assertSender(event); return await handler(input, actorContext()); }
    catch (error) {
      // Electron serializes thrown Errors without custom code fields. Carry only
      // our safe code as data; never copy arbitrary dependency messages/stacks.
      return { groupIpcError: serviceErrors.has(error) ? error.code : "desktop_group_request_failed", ...(serviceErrors.has(error) && error.groupIpcContext ? { groupIpcContext: error.groupIpcContext } : {}) };
    }
  });
  invoke("desktop:group-acceptance", (input, actor) => service.acceptance({ ...input, ...actor }));
  invoke("desktop:group-review-opinions", (input, actor) => service.reviewOpinions({ ...input, ...actor }));
  invoke("desktop:group-history-delete", (input, actor) => service.deleteHistory({ ...input, ...actor }));
  invoke("desktop:group-history", (input, actor) => service.history({ ...input, ...actor }));
  invoke("desktop:group-title", (input, actor) => service.renameGoal({ ...input, ...actor }));
  invoke("desktop:group-display-history", (input, actor) => service.displayHistory({ ...input, ...actor }));
  invoke("desktop:group-revision-draft", (input, actor) => service.revisionDraft({ ...input, ...actor }));
  invoke("desktop:group-projection", (input, actor) => service.projection({ ...input, ...actor }));
  invoke("desktop:group-message", (input, actor) => service.message({ ...input, ...actor }));
  invoke("desktop:group-planning-cancel", (input, actor) => service.cancelPlanning({ ...input, ...actor }));
  invoke("desktop:group-goal", (input, actor) => service.goal({ ...input, ...actor }));
  invoke("desktop:group-version", (input, actor) => service.groupVersion({ ...input, ...actor }));
  invoke("desktop:group-plan-draft", (input, actor) => service.planDraft({ ...input, ...actor }));
  invoke("desktop:group-adopt", (input, actor) => service.adopt({ ...input, ...actor }));
  invoke("desktop:group-run", (input, actor) => service.run({ ...input, ...actor }));
  invoke("desktop:group-start", (input, actor) => service.start({ ...input, ...actor }));
  invoke("desktop:group-resume", (input, actor) => service.resume({ ...input, ...actor }));
  invoke("desktop:group-cancel", (input, actor) => service.cancel({ ...input, ...actor }));
  invoke("desktop:group-advance", (input, actor) => service.advance({ ...input, ...actor }));
}

export function createDesktopGroupMaterialHandler({
  actorContext,
  cleanEmployeeId,
  desktopFetch,
  groupStudioService,
  isExpectedActor,
  materialInputContractsFor = () => [],
  materialPreparationJobs,
  prepareMaterialSelection,
  resolveAuthorizedMaterialFiles,
  now = Date.now,
} = {}) {
  if (![actorContext, cleanEmployeeId, desktopFetch, isExpectedActor, materialInputContractsFor,
    prepareMaterialSelection, resolveAuthorizedMaterialFiles, now].every(value => typeof value === "function") ||
    typeof groupStudioService?.material !== "function" || !(materialPreparationJobs instanceof Map)) {
    throw new TypeError("desktop Group material handler dependencies are required");
  }
  return async function handleGroupMaterial(body = {}) {
    const actor = actorContext();
    const employeeId = cleanEmployeeId(body?.employeeId);
    const files = resolveAuthorizedMaterialFiles(body?.files);
    if (!employeeId) throw new Error("desktop_material_employee_required");
    if (!actor.actorKey) throw new Error("desktop_material_authentication_required");
    if (!files.length) throw new Error("desktop_material_selection_expired");
    const controller = new AbortController();
    const jobId = cleanToken(body?.jobId || `group-material-${now()}`, 120);
    materialPreparationJobs.set(jobId, controller);
    try {
      const { prepared, bridge } = await prepareMaterialSelection({
        files,
        employeeId,
        signal: controller.signal,
        materialInputContracts: materialInputContractsFor(employeeId),
      });
      if (!isExpectedActor(actor.actorKey, actor.actorContextVersion)) throw new Error("desktop_group_actor_changed");
      if (!bridge.items.length) throw new Error("desktop_material_bridge_empty");
      const intakeResponse = await desktopFetch(`/api/digital-employees/${encodeURIComponent(employeeId)}/desktop-material-intakes`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ contractVersion: "desktop-material-bridge.v1", manifestDigest: prepared.safeContext?.manifest?.contentDigest, items: bridge.items }),
      });
      const intake = await intakeResponse.json().catch(() => ({}));
      if (!intakeResponse.ok || !intake?.intakeId) throw new Error(safeCenterCode(intake?.error) || `desktop_material_intake_http_${intakeResponse.status}`);
      const result = await groupStudioService.material({
        expectedActorKey: actor.actorKey,
        expectedActorContextVersion: actor.actorContextVersion,
        body: { employeeId, intakeId: intake.intakeId, manifestDigest: prepared.safeContext?.manifest?.contentDigest },
      });
      return { ok: true, jobId, inputRef: result.inputRef };
    } catch (error) {
      if (controller.signal.aborted || error?.name === "AbortError") return { ok: false, jobId, status: "canceled" };
      throw error;
    } finally {
      materialPreparationJobs.delete(jobId);
    }
  };
}

export function registerDesktopGroupMaterialIpc({ ipcMain, assertSender, handler } = {}) {
  if (!ipcMain || typeof assertSender !== "function" || typeof handler !== "function") {
    throw new TypeError("desktop Group material IPC dependencies are required");
  }
  ipcMain.handle("desktop:group-material", async (event, input = {}) => {
    try {
      assertSender(event);
      return await handler(input?.body);
    } catch (error) {
      const code = safeCenterCode(error?.code) || safeCenterCode(error?.message);
      return { groupIpcError: code || "desktop_group_request_failed" };
    }
  });
}

function safeCenterCode(value) {
  const code = String(value || "").trim();
  return GROUP_MATERIAL_SAFE_ERROR_CODES.has(code) ? code : "";
}

function cleanToken(value, maxLength) {
  const text = String(value || "").trim();
  return /^[A-Za-z0-9][A-Za-z0-9._:@-]*$/.test(text) ? text.slice(0, maxLength) : "";
}
