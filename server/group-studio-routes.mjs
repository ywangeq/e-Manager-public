import { recoverLegacyGroupPlanningInput } from "./agent-runtime/group-planning-input-v1.mjs";
import { safeGroupRequestErrorCode } from "./agent-runtime/group-execution-errors.mjs";
import { assertGroupScope, groupContentDigest, groupObject, normalizeGroupBudget, groupContractError, groupDigest, groupId, normalizeGroupPlanDraft, normalizeGroupPlan, normalizeGroupRun, normalizeGroupQuestion, normalizeWorkGoal, normalizeGroupVersion } from "./agent-runtime/group-contracts-v1.mjs";
import { projectGroupRunSafe } from "./agent-runtime/group-safe-projection-v1.mjs";
import { bindGroupReviewerSkill } from "./agent-runtime/group-reviewer-skill-binding.mjs";

const CONTRACT_VERSION = "group-studio-http.v1";
const LEGACY_TURN_WARNING = "历史原话无法按轮次还原，未对累计目标作推测拆分。";

export function createGroupStudioHandlers({
  groups,
  runtimeTaskRepository,
  plannerAgent = null,
  resolveMessageMembers = null,
  resolveReviewerSkill = null,
  coordinator = null,
  reviewOpinionReader = null,
  deliveryAcceptance = null,
  requireSession,
  resolveActor,
  groupMaterialReferenceService = null,
  readJsonBody,
  sendJson,
  now = () => new Date().toISOString(),
  resolveGoalTitle = null,
  resolveGoalCreatedAt = null,
  workItemDisplayRepository = null,
  createObjectiveReference = null,
  readObjectiveReference = null,
  savePlannerInput = null,
  readPlannerInput = null,
  resolveGoalConversation = null,
  resolveStepObjectives = null,
  findPlannerTask = null,
  cancelPlannerTask = null,
  waitForPlanningCancellation = (milliseconds) => new Promise(resolve => setTimeout(resolve, milliseconds)),
} = {}) {
  if (!groups || typeof groups.readRun !== "function" || typeof requireSession !== "function" || typeof resolveActor !== "function" || typeof readJsonBody !== "function" || typeof sendJson !== "function") {
    throw new TypeError("group studio handlers require governed Center dependencies");
  }
  const actorFor = (session) => {
    const actor = resolveActor(session);
    if (!actor || !actor.tenantScope || !actor.actorIssuer || !actor.actorSubjectDigest) throw groupContractError("group_actor_route_invalid");
    return actor;
  };
  async function suggestPlan(input) {
    const assertCurrent = () => {
      const current = groups.readLatestGoal(input.actor, input.planContext.goalId);
      if (current?.revision !== input.planContext.goalRevision || groups.hasPlanOrRun(input.actor, current.goalId, current.revision)) throw groupContractError("group_goal_not_editable");
    };
    assertCurrent();
    if (typeof savePlannerInput === "function") await savePlannerInput(input);
    assertCurrent();
    const suggestion = await plannerAgent.suggest(input);
    assertCurrent();
    return suggestion;
  }
  async function handle(req, res, url) {
    if (!url.pathname.startsWith("/api/group-studio/")) return undefined;
    const session = requireSession(req, res);
    if (!session) return true;
    let actor;
    let persistedPlanningContext = null;
    try {
      actor = actorFor(session);
      const titleMatch = url.pathname.match(/^\/api\/group-studio\/goals\/([^/]+)\/title$/);
      if (req.method === "PATCH" && titleMatch) {
        const goalId = groupId(decodeURIComponent(titleMatch[1]));
        if (!groups.readLatestGoal(actor, goalId) || groups.isHistoryHidden?.(actor, goalId)) throw groupContractError("group_history_not_found");
        if (!workItemDisplayRepository) throw groupContractError("group_title_service_unavailable");
        const body = await readJsonBody(req, 4096);
        if (Object.keys(body).some(key => !["title", "expectedDisplayRevision"].includes(key))) throw groupContractError("group_title_invalid");
        const display = workItemDisplayRepository.rename(actor, "goal", goalId, body, now());
        return sendJson(res, 200, { ok: true, goalId, ...display });
      }
      const historyDelete = url.pathname.match(/^\/api\/group-studio\/history\/([^/]+)$/);
      if (req.method === "DELETE" && historyDelete) {
        const result = groups.deleteHistory(actor, groupId(decodeURIComponent(historyDelete[1])));
        return sendJson(res, 200, { ok: true, ...result });
      }
      if (req.method === "GET" && url.pathname === "/api/group-studio/history") {
        res.setHeader?.("Cache-Control", "private, no-store");
        const items = await Promise.all(groups.listHistory(actor).map(async ({ kind, value }) => {
          const goal = kind === "goal" ? value : groups.readGoal(actor, value.goalId, value.goalRevision);
          const customDisplay = workItemDisplayRepository?.read(actor, "goal", value.goalId);
          const title = customDisplay?.title || (resolveGoalTitle && goal ? await resolveGoalTitle({ session, goal }) : undefined);
          const createdAt = resolveGoalCreatedAt && goal ? await resolveGoalCreatedAt({ session, goal: groups.readGoal(actor, value.goalId, 1) || goal }) : null;
          const display = { displayRevision: customDisplay?.displayRevision || 0, ...(createdAt ? { createdAt } : {}) };
          if (kind === "goal") {
            const groupVersion = value.planningContext ? groups.readGroupVersion(actor, value.planningContext.groupId, value.planningContext.groupVersion) : null;
            const task = typeof findPlannerTask === "function" ? await findPlannerTask({ actor, session, goal: value, groupVersion }) : null;
            const taskStatus = task?.status || "unavailable";
            const pending = ["queued", "running", "waiting", "pending"].includes(taskStatus);
            const canceled = taskStatus === "canceled";
            const error = pending || canceled ? null : safeGroupRequestErrorCode(task?.lastErrorCode || "group_planner_attempt_unfinished");
            return { ...display, ...(title ? { title } : {}), goalId: value.goalId, status: pending ? "planning" : canceled ? "canceled" : "failed",
              ...(error ? { error } : {}), planning: { goal: value, groupVersion, planDraft: null, ...(task?.taskId ? { taskId: task.taskId } : {}) } };
          }
          if (kind === "run") {
            const plan = groups.readPlan(actor, value.planId, value.planRevision);
            const stepObjectives = resolveStepObjectives ? await resolveStepObjectives({ actor, session, run: value, plan }) : {};
            return { ...display, ...(title ? { title } : {}), goalId: value.goalId, runId: value.runId, goalRevision: value.goalRevision,
              groupId: value.groupId, groupVersion: value.groupVersion, status: "run",
              projection: projectGroupRunSafe({ run: value, plan, actor, taskRepository: runtimeTaskRepository, stepObjectives, now: now() }) };
          }
          return { ...display, ...(title ? { title } : {}), goalId: value.goalId, status: "draft", planning: {
            goal: groups.readGoal(actor, value.goalId, value.goalRevision),
            groupVersion: groups.readGroupVersion(actor, value.groupId, value.groupVersion), planDraft: value,
          } };
        }));
        return sendJson(res, 200, { ok: true, contractVersion: CONTRACT_VERSION, items });
      }
      const displayHistoryMatch = url.pathname.match(/^\/api\/group-studio\/goals\/([^/]+)\/display-history$/);
      if (req.method === "GET" && displayHistoryMatch) {
        res.setHeader?.("Cache-Control", "private, no-store");
        const goalId = groupId(decodeURIComponent(displayHistoryMatch[1]));
        const goal = groups.readLatestGoal?.(actor, goalId);
        if (!goal || groups.isHistoryHidden?.(actor, goalId)) throw groupContractError("group_history_not_found");
        if (typeof resolveGoalConversation !== "function") throw groupContractError("group_route_not_found");
        const conversation = normalizeGroupGoalDisplayHistory(await resolveGoalConversation({
          actor, session, goal, revisions: groups.readGoalRevisions?.(actor, goalId, { limit: 101 }) || [goal],
        }));
        return sendJson(res, 200, { ok: true, contractVersion: CONTRACT_VERSION, goalId, conversation });
      }
      const revisionDraftMatch = url.pathname.match(/^\/api\/group-studio\/goals\/([^/]+)\/revisions\/([^/]+)\/draft$/);
      if (req.method === "GET" && revisionDraftMatch) {
        res.setHeader?.("Cache-Control", "private, no-store");
        const goalId = groupId(decodeURIComponent(revisionDraftMatch[1]));
        const goalRevision = Number(revisionDraftMatch[2]);
        if (!Number.isSafeInteger(goalRevision) || goalRevision < 1) throw groupContractError("group_revision_invalid");
        if (!groups.readLatestGoal(actor, goalId) || groups.isHistoryHidden?.(actor, goalId)) throw groupContractError("group_history_not_found");
        const goal = groups.readGoal(actor, goalId, goalRevision);
        const draft = goal && groups.readDraftForGoal(actor, goalId, goalRevision);
        if (!draft || draft.goalId !== goalId || draft.goalRevision !== goalRevision) throw groupContractError("group_history_not_found");
        return sendJson(res, 200, { ok: true, contractVersion: CONTRACT_VERSION, goalId, goalRevision,
          draft: { goalRevision, steps: draft.steps.map(step => ({ stepId: step.stepId, employeeId: step.employeeId,
            kind: step.kind, dependsOn: step.dependsOn })) } });
      }

      if (req.method === "POST" && url.pathname === "/api/group-studio/planning-cancellations") {
        if (typeof findPlannerTask !== "function" || typeof cancelPlannerTask !== "function") throw groupContractError("group_planner_cancel_unavailable");
        const input = groupObject(await readJsonBody(req, 8 * 1024), ["clientRequestId", "goalId", "goalRevision", "groupId", "groupVersion"]);
        const clientRequestId = groupId(input.clientRequestId);
        const goalRevision = Number(input.goalRevision);
        const groupVersionNumber = Number(input.groupVersion);
        if (!Number.isSafeInteger(goalRevision) || goalRevision < 1 || !Number.isSafeInteger(groupVersionNumber) || groupVersionNumber < 1) throw groupContractError("group_revision_invalid");
        const derivedKey = groupContentDigest({ actor, requestKey: clientRequestId });
        const goalId = groupId(input.goalId || `group-goal-${derivedKey}`);
        const groupIdValue = groupId(input.groupId || `group-${derivedKey}`);
        for (let attempt = 0; attempt < 5; attempt += 1) {
          const goal = groups.readGoal(actor, goalId, goalRevision);
          const groupVersion = groups.readGroupVersion(actor, groupIdValue, groupVersionNumber);
          const context = goal?.planningContext;
          if (goal && groupVersion && context?.clientRequestId === clientRequestId && context.groupId === groupIdValue && context.groupVersion === groupVersionNumber) {
            if (groups.readLatestGoal(actor, goalId)?.revision !== goalRevision) {
              return sendJson(res, 409, { ok: false, contractVersion: CONTRACT_VERSION, error: "group_planner_cancel_stale" });
            }
            if (groups.readDraftForGoal(actor, goalId, goalRevision) || groups.hasPlanOrRun(actor, goalId, goalRevision)) {
              return sendJson(res, 200, { ok: true, contractVersion: CONTRACT_VERSION, cancellation: "completed", goalId, goalRevision });
            }
            const task = await findPlannerTask({ actor, session, goal, groupVersion });
            if (task?.taskId) {
              if (groups.readLatestGoal(actor, goalId)?.revision !== goalRevision || groups.readDraftForGoal(actor, goalId, goalRevision) || groups.hasPlanOrRun(actor, goalId, goalRevision)) {
                return sendJson(res, 409, { ok: false, contractVersion: CONTRACT_VERSION, error: "group_planner_cancel_stale" });
              }
              if (task.status === "canceled") return sendJson(res, 200, { ok: true, contractVersion: CONTRACT_VERSION, cancellation: "canceled", goalId, goalRevision });
              if (task.status === "completed") return sendJson(res, 200, { ok: true, contractVersion: CONTRACT_VERSION, cancellation: "completed", goalId, goalRevision });
              if (!["queued", "running", "waiting", "pending"].includes(task?.status)) {
                return sendJson(res, 409, { ok: false, contractVersion: CONTRACT_VERSION, error: "group_planner_not_cancelable" });
              }
              const result = await cancelPlannerTask({ actor, session, taskId: task.taskId });
              const status = result?.task?.status || result?.data?.task?.status;
              if (result?.ok === true && status === "canceled") return sendJson(res, 200, { ok: true, contractVersion: CONTRACT_VERSION, cancellation: "canceled", goalId, goalRevision });
              if (status === "completed") return sendJson(res, 200, { ok: true, contractVersion: CONTRACT_VERSION, cancellation: "completed", goalId, goalRevision });
              return sendJson(res, 409, { ok: false, contractVersion: CONTRACT_VERSION, error: "group_planner_cancel_unconfirmed" });
            }
          }
          if (attempt < 4) await waitForPlanningCancellation(40);
        }
        return sendJson(res, 202, { ok: true, contractVersion: CONTRACT_VERSION, cancellation: "pending", goalId, goalRevision });
      }

      if (req.method === "POST" && url.pathname === "/api/group-studio/material-intakes") {
        if (!groupMaterialReferenceService || typeof groupMaterialReferenceService.create !== "function") {
          throw groupContractError("group_material_reference_unavailable");
        }
        const input = await readJsonBody(req, 12 * 1024 * 1024);
        const inputRef = await groupMaterialReferenceService.create({
          actor,
          session,
          employeeId: input.employeeId,
          intakeId: input.intakeId,
          manifestDigest: input.manifestDigest,
        });
        return sendJson(res, 201, { ok: true, contractVersion: CONTRACT_VERSION, inputRef });
      }
      if (req.method === "POST" && url.pathname === "/api/group-studio/goals") {
        const input = await readJsonBody(req, 32 * 1024);
        if (input?.planningContext !== undefined) throw groupContractError("group_planning_context_server_owned");
        if (input?.reworkSource !== undefined) throw groupContractError("group_rework_source_invalid");
        const objective = typeof input.objectiveText === "string" ? input.objectiveText.trim() : "";
        if (objective) {
          if (typeof createObjectiveReference !== "function") throw groupContractError("group_objective_reference_unavailable");
          const reference = await createObjectiveReference({ actor, session, goalId: input.goalId, objective });
          input.objectiveRef = reference.objectiveRef;
          input.objectiveDigest = reference.objectiveDigest;
          delete input.objectiveText;
        }
        const goal = normalizeWorkGoal({...input, tenantScope:actor.tenantScope, actorIssuer:actor.actorIssuer, actorSubjectDigest:actor.actorSubjectDigest});
        return sendJson(res, 201, {ok:true, contractVersion:CONTRACT_VERSION, goal:groups.createGoal(actor, goal)});
      }
      if (req.method === "POST" && url.pathname === "/api/group-studio/group-versions") {
        const input = await readJsonBody(req, 32 * 1024);
        if (input?.reviewerSkillBinding !== undefined) throw groupContractError("group_reviewer_skill_binding_invalid");
        const existing = groups.readGroupVersion(actor, input?.groupId, input?.version);
        const reviewerSkillBinding = existing ? existing.reviewerSkillBinding : bindGroupReviewerSkill({ reviewerGroup: input?.reviewerGroup,
          skill: typeof resolveReviewerSkill === "function" ? await resolveReviewerSkill({ actor, session }) : null });
        const version = normalizeGroupVersion({...input, ...(reviewerSkillBinding ? { reviewerSkillBinding } : {}), tenantScope:actor.tenantScope, actorIssuer:actor.actorIssuer, actorSubjectDigest:actor.actorSubjectDigest});
        return sendJson(res, 201, {ok:true, contractVersion:CONTRACT_VERSION, groupVersion:groups.createGroupVersion(actor, version)});
      }
      if (req.method === "POST" && url.pathname === "/api/group-studio/messages") {
        const input = groupObject(await readJsonBody(req, 64 * 1024), [
          "objective", "members", "reviewerGroup", "planningHints", "inputRefs", "idempotencyKey", "budget", "completionConditions", "resourceScope", "continuation",
        ]);
        let objective = typeof input.objective === "string" ? input.objective.trim() : "";
        const retryRequested = input.continuation?.retry === true;
        if (!objective && !retryRequested) throw groupContractError("group_objective_required");
        if (!plannerAgent || typeof plannerAgent.suggest !== "function") throw groupContractError("task_planner_employee_unavailable");
        if (typeof createObjectiveReference !== "function") throw groupContractError("group_objective_reference_unavailable");
        if (typeof resolveMessageMembers !== "function") throw groupContractError("group_member_resolver_unavailable");
        const requestKey = groupId(input.idempotencyKey);
        if (input.continuation) {
          const continuation = groupObject(input.continuation, ["goalId", "expectedGoalRevision", "groupId", "expectedGroupVersion", "retry", "reworkRunId"]);
          const goalId = groupId(continuation.goalId);
          const expectedGoalRevision = Number(continuation.expectedGoalRevision);
          const groupIdValue = groupId(continuation.groupId);
          const expectedGroupVersion = Number(continuation.expectedGroupVersion);
          if (!Number.isSafeInteger(expectedGoalRevision) || expectedGoalRevision < 1 || !Number.isSafeInteger(expectedGroupVersion) || expectedGroupVersion < 1) {
            throw groupContractError("group_revision_invalid");
          }
          let currentGoal = groups.readGoal(actor, goalId, expectedGoalRevision);
          let currentGroupVersion = groups.readGroupVersion(actor, groupIdValue, expectedGroupVersion);
          let currentDraft = groups.readDraftForGoal(actor, goalId, expectedGoalRevision);
          if (!currentGoal || !currentGroupVersion || (groups.hasPlanOrRun(actor, goalId, expectedGoalRevision) && !continuation.reworkRunId)) throw groupContractError("group_goal_not_editable");
          if (continuation.reworkRunId && retryRequested) throw groupContractError("group_rework_source_invalid");
          const reworkSource = continuation.reworkRunId && groups.rejectedReviewSource?.(actor, groupId(continuation.reworkRunId));
          if (continuation.reworkRunId && (!reworkSource || reworkSource.runId !== continuation.reworkRunId)) throw groupContractError("group_rework_source_invalid");
          if (reworkSource) {
            if (!reviewOpinionReader) throw groupContractError("group_review_opinion_unavailable");
            const opinions = await reviewOpinionReader.read({ actor, session, runId: reworkSource.runId });
            if (!opinions.some(opinion => opinion.artifactId === reworkSource.opinionArtifactId && opinion.decision === "rejected")) {
              throw groupContractError("group_rework_source_invalid");
            }
            const sourceRun = groups.readRun(actor, reworkSource.runId);
            if (sourceRun.goalId !== goalId || sourceRun.goalRevision !== expectedGoalRevision ||
                sourceRun.groupId !== groupIdValue || sourceRun.groupVersion !== expectedGroupVersion ||
                groupContentDigest(groups.readPlan(actor, sourceRun.planId, sourceRun.planRevision)?.reviewerGroup || null) !==
                  groupContentDigest(currentGroupVersion.reviewerGroup || null)) throw groupContractError("group_rework_source_invalid");
          }
          if (retryRequested) {
            const latestGoal = groups.readLatestGoal(actor, goalId);
            if (latestGoal?.revision !== expectedGoalRevision && latestGoal?.planningContext?.clientRequestId === requestKey &&
              latestGoal.planningContext.baseGoalRevision === expectedGoalRevision && latestGoal.planningContext.baseGroupVersion === expectedGroupVersion) {
              currentGoal = latestGoal;
              currentGroupVersion = groups.readGroupVersion(actor, latestGoal.planningContext.groupId, latestGoal.planningContext.groupVersion);
              currentDraft = groups.readDraftForGoal(actor, goalId, latestGoal.revision);
            }
            if (!latestGoal?.planningContext || latestGoal.revision !== currentGoal.revision ||
              latestGoal.planningContext.groupId !== currentGroupVersion?.groupId || latestGoal.planningContext.groupVersion !== currentGroupVersion?.version ||
              typeof findPlannerTask !== "function") throw groupContractError("group_goal_not_editable");
            if (currentDraft) return sendJson(res, 201, { ok: true, contractVersion: CONTRACT_VERSION, goal: currentGoal, groupVersion: currentGroupVersion,
              planDraft: { ...currentDraft, planner: { planning: "agent_runtime" } }, execution: "not_started" });
            const task = await findPlannerTask({ actor, session, goal: latestGoal, groupVersion: currentGroupVersion });
            persistedPlanningContext = { goal: latestGoal, groupVersion: currentGroupVersion };
            if (["queued", "running", "waiting", "pending"].includes(task?.status)) {
              return sendJson(res, 202, { ok: true, contractVersion: CONTRACT_VERSION, planning: "pending", taskId: task.taskId, ...persistedPlanningContext, execution: "not_started" });
            }
            const attempt = task?.taskId ? task.plannerInput :
              (typeof readPlannerInput === "function" ? await readPlannerInput({ actor, session, goal: latestGoal, groupVersion: currentGroupVersion }) : null) ||
              recoverLegacyGroupPlanningInput({ goal: latestGoal, groupVersion: currentGroupVersion, input,
                objective: typeof readObjectiveReference === "function" ? await readObjectiveReference({ session, goal: latestGoal }) : "" });
            if (!attempt?.objective || !Array.isArray(attempt.inputRefs) || !Array.isArray(attempt.planningHints) || !Array.isArray(attempt.resourceScope)) {
              throw groupContractError("group_planner_attempt_unfinished");
            }
            let submittedObjective = attempt.objective;
            const baseRevision = latestGoal.planningContext.baseGoalRevision;
            if (baseRevision < latestGoal.revision && typeof readObjectiveReference === "function") {
              const baseGoal = groups.readGoal(actor, goalId, baseRevision);
              const baseObjective = baseGoal ? await readObjectiveReference({ session, goal: baseGoal }) : "";
              const prefix = baseObjective ? `${baseObjective}\n\n` : "";
              if (prefix && attempt.objective.startsWith(prefix)) submittedObjective = attempt.objective.slice(prefix.length);
            }
            assertPlannerRetryInput(input, attempt, submittedObjective);
            assertPlannerRetryEnvelope(input, latestGoal, currentGroupVersion);
            const employees = await resolveMessageMembers({ actor, session,
              members: currentGroupVersion.members.map(({ employeeId, employeeVersion }) => ({ employeeId, employeeVersion })) });
            if (!Array.isArray(employees) || employees.length !== currentGroupVersion.members.length ||
              employees.some((employee, index) => employee.id !== currentGroupVersion.members[index].employeeId || employee.version !== currentGroupVersion.members[index].employeeVersion)) throw groupContractError("group_member_version_invalid");
            if (!task?.taskId || task.status === "completed") {
              const suggestion = await suggestPlan({ actor, session, objective: attempt.objective, inputRefs: attempt.inputRefs, employees,
                constraints: attempt.planningHints, requestId: latestGoal.planningContext.plannerRequestId,
                planContext: plannerContext({ actor, goal: latestGoal, groupVersion: currentGroupVersion, resourceScope: attempt.resourceScope }) });
              if (!suggestion?.planDraft) throw groupContractError("task_planner_output_invalid");
              const draft = normalizeGroupPlanDraft({ ...suggestion.planDraft, ...actor, goalId, goalRevision: latestGoal.revision,
                groupId: groupIdValue, groupVersion: currentGroupVersion.version, planId: latestGoal.planningContext.plannerRequestId, revision: 0,
                idempotencyKey: `draft-recovered-${goalId}-${latestGoal.revision}`, plannerBinding: suggestion.plannerBinding });
              const planDraft = groups.createDraft(actor, draft);
              return sendJson(res, 201, { ok: true, contractVersion: CONTRACT_VERSION, goal: latestGoal, groupVersion: currentGroupVersion,
                planDraft: { ...planDraft, planner: { planning: "agent_runtime" } }, execution: "not_started" });
            }
            if (!["failed", "timed_out", "canceled", "lost"].includes(task.status)) {
              throw groupContractError(safeGroupRequestErrorCode(task.lastErrorCode || "group_planner_attempt_unfinished"));
            }
            // A terminal attempt cannot be reopened under its canonical id. Keep
            // its exact encrypted request, reserve one new immutable revision,
            // then let the shared Worker own the only new canonical attempt.
            const operationId = groupContentDigest({ requestKey, attempt });
            const nextGoal = normalizeWorkGoal({ contractVersion: "work-goal.v1", ...actor, goalId,
              revision: latestGoal.revision + 1, idempotencyKey: `goal-retry-${goalId}-${operationId}`,
              objectiveRef: latestGoal.objectiveRef, objectiveDigest: latestGoal.objectiveDigest,
              ...(latestGoal.turnInputRef ? { turnInputRef: latestGoal.turnInputRef } : {}),
              ...(latestGoal.transcriptSessionId ? { transcriptSessionId: latestGoal.transcriptSessionId } : {}), phase: latestGoal.phase,
              budget: latestGoal.budget, completionConditions: latestGoal.completionConditions, inputRefs: attempt.inputRefs,
              ...(latestGoal.reworkSource ? { reworkSource: latestGoal.reworkSource } : {}),
              planningContext: { groupId: groupIdValue, groupVersion: currentGroupVersion.version + 1, clientRequestId: requestKey,
                plannerRequestId: `group-plan-${groupContentDigest({ actor, goalId, goalRevision: latestGoal.revision + 1 })}`,
                baseGoalRevision: latestGoal.revision, baseGroupVersion: currentGroupVersion.version } });
            const nextGroupVersion = normalizeGroupVersion({ contractVersion: "group-version.v1", ...actor, groupId: groupIdValue,
              version: currentGroupVersion.version + 1, idempotencyKey: `group-retry-${groupIdValue}-${operationId}`,
              members: currentGroupVersion.members, reviewerGroup: currentGroupVersion.reviewerGroup,
              ...(currentGroupVersion.reviewerSkillBinding ? { reviewerSkillBinding: currentGroupVersion.reviewerSkillBinding } : {}) });
            const reservation = groups.reserveContinuation({ actor, expectedGoalRevision: latestGoal.revision, goal: nextGoal, groupVersion: nextGroupVersion });
            const goal = reservation.goal, groupVersion = reservation.groupVersion;
            persistedPlanningContext = { goal, groupVersion };
            const saved = groups.readDraft(actor, goal.planningContext.plannerRequestId, 0);
            if (saved) return sendJson(res, 201, { ok: true, contractVersion: CONTRACT_VERSION, goal, groupVersion, planDraft: { ...saved, planner: { planning: "agent_runtime" } }, execution: "not_started" });
            const suggestion = await suggestPlan({ actor, session, objective: attempt.objective, inputRefs: attempt.inputRefs, employees,
              constraints: attempt.planningHints, requestId: goal.planningContext.plannerRequestId,
              planContext: plannerContext({ actor, goal, groupVersion, resourceScope: attempt.resourceScope }) });
            if (!suggestion?.planDraft) throw groupContractError("task_planner_output_invalid");
            const draft = normalizeGroupPlanDraft({ ...suggestion.planDraft, ...actor, goalId, goalRevision: goal.revision,
              groupId: groupIdValue, groupVersion: groupVersion.version, planId: goal.planningContext.plannerRequestId, revision: 0,
              idempotencyKey: `draft-retry-${goalId}-${operationId}`, plannerBinding: suggestion.plannerBinding });
            const planDraft = groups.createDraft(actor, draft);
            return sendJson(res, 201, { ok: true, contractVersion: CONTRACT_VERSION, goal, groupVersion,
              planDraft: { ...planDraft, planner: { planning: "agent_runtime" } }, execution: "not_started" });
          }
          // A draft can be revised; a terminal planner attempt has no draft but remains the same Goal.
          // Only an explicit new message below reserves its next revision.
          if (!currentDraft && !reworkSource) {
            if (currentGoal.planningContext?.groupId !== currentGroupVersion.groupId || currentGoal.planningContext?.groupVersion !== currentGroupVersion.version) {
              throw groupContractError("group_goal_not_editable");
            }
            const task = typeof findPlannerTask === "function" ? await findPlannerTask({ actor, session, goal: currentGoal, groupVersion: currentGroupVersion }) : null;
            // A completed model turn can still fail draft validation. Only an
            // explicit new message may revise that unadopted, no-Draft Goal.
            if (!task?.taskId || !["completed", "failed", "timed_out", "canceled", "lost"].includes(task.status)) throw groupContractError("group_goal_not_editable");
          }
          if (currentDraft && (currentDraft.groupId !== groupIdValue || currentDraft.groupVersion !== expectedGroupVersion)) throw groupContractError("group_goal_not_editable");
          if (Array.isArray(input.members) && input.members.length && groupContentDigest(input.members) !== groupContentDigest(currentGroupVersion.members.map(({ employeeId, employeeVersion }) => ({ employeeId, employeeVersion })))) {
            throw groupContractError("group_member_version_invalid");
          }
          const inputRefs = Array.isArray(input.inputRefs) && input.inputRefs.length ? input.inputRefs : currentGoal.inputRefs;
          const planningHints = Array.isArray(input.planningHints) ? input.planningHints : [];
          const resourceScope = input.resourceScope || [];
          const effectiveReworkSource = reworkSource || currentGoal.reworkSource;
          const operationId = groupContentDigest({ requestKey, objective, inputRefs, planningHints, resourceScope, reworkSource: effectiveReworkSource });
          const employees = await resolveMessageMembers({ actor, session,
            members: currentGroupVersion.members.map(({ employeeId, employeeVersion }) => ({ employeeId, employeeVersion })) });
          if (!Array.isArray(employees) || employees.length !== currentGroupVersion.members.length ||
            employees.some((employee, index) => employee.id !== currentGroupVersion.members[index].employeeId || employee.version !== currentGroupVersion.members[index].employeeVersion)) throw groupContractError("group_member_version_invalid");
          const reference = await createObjectiveReference({ actor, session, goalId, objective,
            previousObjectiveRef: currentGoal.objectiveRef, previousTranscriptSessionId: currentGoal.transcriptSessionId || "", operationId });
          const nextGoal = normalizeWorkGoal({ contractVersion: "work-goal.v1", ...actor, goalId,
            revision: expectedGoalRevision + 1, idempotencyKey: `goal-continuation-${goalId}-${operationId}`,
            objectiveRef: reference.objectiveRef, objectiveDigest: reference.objectiveDigest,
            turnInputRef: reference.turnInputRef, transcriptSessionId: reference.transcriptSessionId, phase: currentGoal.phase,
            budget: currentGoal.budget, completionConditions: currentGoal.completionConditions, inputRefs,
            ...(effectiveReworkSource ? { reworkSource: effectiveReworkSource } : {}),
            planningContext: { groupId: groupIdValue, groupVersion: expectedGroupVersion + 1, clientRequestId: requestKey, plannerRequestId: `group-plan-${groupContentDigest({ actor, goalId, goalRevision: expectedGoalRevision + 1 })}`, baseGoalRevision: expectedGoalRevision, baseGroupVersion: expectedGroupVersion } });
          const nextGroupVersion = normalizeGroupVersion({ contractVersion: "group-version.v1", ...actor, groupId: groupIdValue,
            version: expectedGroupVersion + 1, idempotencyKey: `group-continuation-${groupIdValue}-${operationId}`,
            members: currentGroupVersion.members, reviewerGroup: currentGroupVersion.reviewerGroup,
            ...(currentGroupVersion.reviewerSkillBinding ? { reviewerSkillBinding: currentGroupVersion.reviewerSkillBinding } : {}) });
          const reservation = groups.reserveContinuation({ actor, expectedGoalRevision, goal: nextGoal, groupVersion: nextGroupVersion });
          const goal = reservation.goal;
          const groupVersion = reservation.groupVersion;
          persistedPlanningContext = { goal, groupVersion };
          const planId = `group-plan-${groupContentDigest({ actor, goalId, goalRevision: goal.revision })}`;
          const saved = groups.readDraft(actor, planId, 0);
          if (saved) return sendJson(res, 201, { ok: true, contractVersion: CONTRACT_VERSION, goal, groupVersion, planDraft: { ...saved, planner: { planning: "agent_runtime" } }, execution: "not_started" });
          const suggestion = await suggestPlan({ actor, session, objective: reference.objective, inputRefs, employees,
            constraints: planningHints, requestId: planId,
            planContext: { scope: actor, goalId, goalRevision: goal.revision, groupId: groupIdValue, groupVersion: groupVersion.version,
              members: groupVersion.members, reviewerGroup: groupVersion.reviewerGroup, objectiveRef: goal.objectiveRef,
              budget: goal.budget, completionConditions: goal.completionConditions, resourceScope } });
          if (!suggestion?.planDraft) throw groupContractError("task_planner_output_invalid");
          const draft = normalizeGroupPlanDraft({ ...suggestion.planDraft, ...actor, goalId, goalRevision: goal.revision,
            groupId: groupIdValue, groupVersion: groupVersion.version, planId, revision: 0,
            idempotencyKey: `draft-continuation-${goalId}-${operationId}`, plannerBinding: suggestion.plannerBinding });
          const planDraft = groups.createDraft(actor, draft);
          return sendJson(res, 201, { ok:true, contractVersion:CONTRACT_VERSION, goal, groupVersion,
            planDraft:{ ...planDraft, planner:{ planning:"agent_runtime" } }, execution:"not_started" });
        }
        const key = groupContentDigest({ actor, requestKey });
        const goalId = `group-goal-${key}`;
        const requestedGroupId = `group-${key}`;
        const planId = `group-plan-${key}`;
        const requestedMembers = input.members;
        if (!Array.isArray(requestedMembers) || !requestedMembers.length || requestedMembers.length > 12) throw groupContractError("group_callable_members_unavailable");
        requestedMembers.forEach(member => {
          groupObject(member, ["employeeId", "employeeVersion"]);
          groupId(member.employeeId); groupId(member.employeeVersion);
        });
        if (new Set(requestedMembers.map(member => member.employeeId)).size !== requestedMembers.length) throw groupContractError("group_duplicate_identifier");
        const employees = await resolveMessageMembers({ actor, session, members: requestedMembers });
        if (!Array.isArray(employees) || employees.length !== requestedMembers.length || employees.some((employee, index) => employee.id !== requestedMembers[index].employeeId || employee.version !== requestedMembers[index].employeeVersion)) throw groupContractError("group_member_version_invalid");
        const budget = normalizeGroupBudget(input.budget);
        const inputRefs = input.inputRefs || [];
        const planningHints = input.planningHints || [];
        const resourceScope = input.resourceScope || [];
        if (!Array.isArray(planningHints)) throw groupContractError("group_planning_hints_invalid");
        // Bind the full request to the existing Group Version idempotency field.
        // The Goal objective digest retains its execution-time text semantics.
        const requestDigest = groupContentDigest({ requestKey, objective, members: requestedMembers, budget, inputRefs, planningHints, resourceScope, completionConditions: input.completionConditions, reviewerGroup: input.reviewerGroup || null });
        const existingVersion = groups.readGroupVersion(actor, requestedGroupId, 1);
        const reviewerSkillBinding = existingVersion ? existingVersion.reviewerSkillBinding : bindGroupReviewerSkill({ reviewerGroup: input.reviewerGroup,
          skill: typeof resolveReviewerSkill === "function" ? await resolveReviewerSkill({ actor, session }) : null });
        const version = normalizeGroupVersion({
          contractVersion: "group-version.v1", ...actor, groupId: requestedGroupId, version: 1, idempotencyKey: `message-${requestDigest}`,
          members: employees.map((employee, index) => ({ employeeId: employee.id, employeeVersion: employee.version, roleRef: { kind: "artifact_ref", refId: `employee-role-${employee.id}` }, coordinator: index === 0 })),
          reviewerGroup: input.reviewerGroup,
          ...(reviewerSkillBinding ? { reviewerSkillBinding } : {}),
        });
        if (existingVersion && existingVersion.idempotencyKey !== version.idempotencyKey) throw groupContractError("group_idempotency_conflict");
        const existingGoal = groups.readGoal(actor, goalId, 1);
        if (existingGoal && existingGoal.objectiveDigest !== groupContentDigest({ objective })) throw groupContractError("group_idempotency_conflict");
        const reference = existingGoal || await createObjectiveReference({ actor, session, goalId, objective });
        const normalizedGoal = normalizeWorkGoal({ contractVersion: "work-goal.v1", ...actor, goalId, revision: 1, idempotencyKey: `goal-${key}`, objectiveRef: reference.objectiveRef, objectiveDigest: reference.objectiveDigest, phase: "adopted", budget, completionConditions: input.completionConditions, inputRefs,
          ...(reference.turnInputRef ? { turnInputRef: reference.turnInputRef } : {}), ...(reference.transcriptSessionId ? { transcriptSessionId: reference.transcriptSessionId } : {}),
          planningContext: { groupId: requestedGroupId, groupVersion: 1, clientRequestId: requestKey, plannerRequestId: planId, baseGoalRevision: 1, baseGroupVersion: 1 } });
        const goal = groups.createGoal(actor, normalizedGoal);
        const groupVersion = groups.createGroupVersion(actor, version);
        persistedPlanningContext = { goal, groupVersion };
        const saved = groups.readDraft(actor, planId, 0);
        if (saved) {
          if (groups.readLatestGoal(actor, goalId)?.revision !== goal.revision) throw groupContractError("group_goal_revision_stale");
          return sendJson(res, 201, { ok: true, contractVersion: CONTRACT_VERSION, goal, groupVersion, planDraft: { ...saved, planner: { planning: "agent_runtime" } }, execution: "not_started" });
        }
        const suggestion = await suggestPlan({
          actor, session, objective, inputRefs, employees, constraints: planningHints, requestId: planId,
          planContext: { scope: actor, goalId, goalRevision: goal.revision, groupId: requestedGroupId, groupVersion: groupVersion.version, members: groupVersion.members, reviewerGroup: groupVersion.reviewerGroup, objectiveRef: goal.objectiveRef, budget, completionConditions: goal.completionConditions, resourceScope },
        });
        if (!suggestion?.planDraft) throw groupContractError("task_planner_output_invalid");
        const draft = normalizeGroupPlanDraft({ ...suggestion.planDraft, ...actor, goalId, goalRevision: goal.revision, groupId: requestedGroupId, groupVersion: groupVersion.version, planId, revision: 0, idempotencyKey: `draft-${key}`, plannerBinding: suggestion.plannerBinding });
        const planDraft = groups.createDraft(actor, draft);
        return sendJson(res, 201, { ok:true, contractVersion:CONTRACT_VERSION, goal, groupVersion, planDraft:{ ...planDraft, planner:{ planning:"agent_runtime" } }, execution:"not_started" });
      }
      if (req.method === "POST" && url.pathname === "/api/group-studio/plan-drafts") {
        const input = await readJsonBody(req, 64 * 1024);
        if (input.requestedSteps || input.planning) throw groupContractError("task_planner_agent_required");
        const draft = normalizeGroupPlanDraft({ ...input, ...actor });
        return sendJson(res, 201, { ok:true, contractVersion:CONTRACT_VERSION, planDraft:groups.createDraft(actor, draft), execution:"not_started" });
      }
      if (req.method === "POST" && url.pathname === "/api/group-studio/plans/adopt") {
        const input = await readJsonBody(req, 64 * 1024);
        const plan = normalizeGroupPlan({...input, tenantScope:actor.tenantScope, actorIssuer:actor.actorIssuer, actorSubjectDigest:actor.actorSubjectDigest});
        const goal = groups.readGoal(actor, plan.goalId, plan.goalRevision);
        if (!goal || goal.phase !== "adopted") throw groupContractError("group_goal_not_adopted");
        const groupVersion = groups.readGroupVersion(actor, plan.groupId, plan.groupVersion);
        if (!groupVersion) throw groupContractError("group_version_not_found");
        return sendJson(res, 201, {ok:true, contractVersion:CONTRACT_VERSION, plan:groups.createPlan(actor, plan), execution:"not_started"});
      }
      const questionAnswerMatch = url.pathname.match(/^\/api\/group-studio\/questions\/([A-Za-z0-9][A-Za-z0-9._:@-]{0,159})\/answer$/);
      if (req.method === "POST" && questionAnswerMatch) {
        const input = await readJsonBody(req, 8 * 1024);
        const expectedRevision = Number(input.expectedRevision);
        if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) throw groupContractError("group_revision_invalid");
        const question = groups.answerQuestion({actor, questionId:questionAnswerMatch[1], expectedRevision, answerRef:input.answerRef, messageId:input.messageId});
        return sendJson(res, 200, {ok:true, contractVersion:CONTRACT_VERSION, question});
      }
      if (req.method === "POST" && url.pathname === "/api/group-studio/questions") {
        const input = await readJsonBody(req, 16 * 1024);
        const question = normalizeGroupQuestion({...input, tenantScope:actor.tenantScope, actorIssuer:actor.actorIssuer, actorSubjectDigest:actor.actorSubjectDigest});
        const run = groups.readRun(actor, question.runId);
        if (!run || run.planRevision !== question.planRevision) throw groupContractError("group_question_run_revision_invalid");
        return sendJson(res, 201, {ok:true, contractVersion:CONTRACT_VERSION, question:groups.createQuestion(actor, question), execution:"not_started"});
      }
      if (req.method === "POST" && url.pathname === "/api/group-studio/runs") {
        const input = await readJsonBody(req, 32 * 1024);
        const run = normalizeGroupRun({...input, tenantScope:actor.tenantScope, actorIssuer:actor.actorIssuer, actorSubjectDigest:actor.actorSubjectDigest});
        const goal = groups.readGoal(actor, run.goalId, run.goalRevision);
        if (!goal || goal.phase !== "adopted") throw groupContractError("group_goal_not_adopted");
        const plan = groups.readPlan(actor, run.planId, run.planRevision);
        if (!plan || plan.groupId !== run.groupId || plan.groupVersion !== run.groupVersion) throw groupContractError("group_plan_not_found");
        const groupVersion = groups.readGroupVersion(actor, run.groupId, run.groupVersion);
        if (!groupVersion) throw groupContractError("group_version_not_found");
        return sendJson(res, 201, {ok:true, contractVersion:CONTRACT_VERSION, run:groups.createRun(actor, run), execution:"not_started"});
      }
      const advanceMatch = url.pathname.match(/^\/api\/group-studio\/runs\/([A-Za-z0-9][A-Za-z0-9._:@-]{0,159})\/(advance|resume)$/);
      if (req.method === "POST" && advanceMatch) {
        if (!coordinator) throw groupContractError("group_coordinator_unavailable");
        const input = await readJsonBody(req, 8 * 1024);
        const expectedRevision = Number(input.expectedRevision);
        if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) throw groupContractError("group_revision_invalid");
        const action = advanceMatch[2];
        const run = await coordinator[action]({actor, session, runId:advanceMatch[1], expectedRevision});
        return sendJson(res, 200, {ok:true, contractVersion:CONTRACT_VERSION, run});
      }
      const opinionMatch = url.pathname.match(/^\/api\/group-studio\/runs\/([A-Za-z0-9][A-Za-z0-9._:@-]{0,159})\/review-opinions$/);
      if (req.method === "GET" && opinionMatch) {
        if (!reviewOpinionReader) throw groupContractError("group_review_opinion_unavailable");
        const reviewOpinions = await reviewOpinionReader.read({ actor, session, runId: opinionMatch[1] });
        res.setHeader?.("Cache-Control", "private, no-store");
        return sendJson(res, 200, { ok: true, contractVersion: CONTRACT_VERSION, reviewOpinions });
      }
      const acceptanceMatch = url.pathname.match(/^\/api\/group-studio\/runs\/([A-Za-z0-9][A-Za-z0-9._:@-]{0,159})\/acceptance$/);
      if (req.method === "POST" && acceptanceMatch) {
        if (!deliveryAcceptance) throw groupContractError("group_delivery_unavailable");
        const input = await readJsonBody(req, 8 * 1024);
        const run = await deliveryAcceptance.decide({ actor, session, runId: acceptanceMatch[1], input });
        const plan = groups.readPlan(actor, run.planId, run.planRevision);
        const stepObjectives = resolveStepObjectives ? await resolveStepObjectives({ actor, session, run, plan }) : {};
        res.setHeader?.("Cache-Control", "private, no-store");
        return sendJson(res, 200, { ok: true, contractVersion: CONTRACT_VERSION,
          projection: projectGroupRunSafe({ run, plan, actor, taskRepository: runtimeTaskRepository, stepObjectives, now: now() }) });
      }
      const runMatch = url.pathname.match(/^\/api\/group-studio\/runs\/([A-Za-z0-9][A-Za-z0-9._:@-]{0,159})(\/cancel)?$/);
      if (req.method === "GET" && runMatch && !runMatch[2]) {
        const run = groups.readRun(actor, runMatch[1]);
        if (!run) return sendJson(res, 404, {ok:false, contractVersion:CONTRACT_VERSION, error:"group_run_not_found"});
        const plan = groups.readPlan(actor, run.planId, run.planRevision);
        const stepObjectives = resolveStepObjectives ? await resolveStepObjectives({ actor, session, run, plan }) : {};
        const projection = projectGroupRunSafe({run, plan, actor, taskRepository:runtimeTaskRepository, stepObjectives, now:now()});
        return sendJson(res, 200, {ok:true, contractVersion:CONTRACT_VERSION, projection});
      }
      if (req.method === "POST" && runMatch?.[2] === "/cancel") {
        const input = await readJsonBody(req, 8 * 1024);
        const expectedRevision = Number(input.expectedRevision);
        if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) throw groupContractError("group_revision_invalid");
        const run = coordinator?.cancel
          ? await coordinator.cancel({ actor, runId: runMatch[1], expectedRevision })
          : groups.cancelRun({actor, runId:runMatch[1], expectedRevision});
        const plan = groups.readPlan(actor,run.planId,run.planRevision);
        const stepObjectives = resolveStepObjectives ? await resolveStepObjectives({ actor, session, run, plan }) : {};
        return sendJson(res, 200, {ok:true, contractVersion:CONTRACT_VERSION, run:projectGroupRunSafe({run,plan,actor,taskRepository:runtimeTaskRepository,stepObjectives,now:now()})});
      }
      return sendJson(res, 404, {ok:false, contractVersion:CONTRACT_VERSION, error:"group_route_not_found"});
    } catch (error) {
      if (error?.code === "agent_turn_pending") {
        // A handoff discloses only a canonical task owned by this actor.
        try {
          const taskId = groupId(error.taskId);
          const task = runtimeTaskRepository?.get(taskId, { tenantScope: actor?.tenantScope });
          if (!task || task.taskId !== taskId) throw new Error("unavailable");
          assertGroupScope(task, actor);
          return sendJson(res, 202, { ok: true, contractVersion: CONTRACT_VERSION, planning: "pending", taskId, ...(persistedPlanningContext || {}), execution: "not_started" });
        } catch {
          return sendJson(res, 422, { ok: false, contractVersion: CONTRACT_VERSION, error: "group_request_invalid" });
        }
      }
      const code = safeGroupRequestErrorCode(error?.code);
      const status = ["group_actor_scope_denied", "group_acceptance_denied"].includes(code) ? 403 : ["group_revision_conflict", "group_goal_revision_stale", "group_delivery_changed", "group_acceptance_conflict", "group_title_conflict"].includes(code) ? 409 : 422;
      return sendJson(res, status, {ok:false, contractVersion:CONTRACT_VERSION, error:code, ...(persistedPlanningContext || {})});
    }
  }
  return Object.freeze({contractVersion:CONTRACT_VERSION, handle});
}

export function actorFromSession({session, tenantScope, resolveRoute}) {
  const route = resolveRoute({channelId:"desktop", employeeId:"group-studio", session});
  if (!route?.actorIssuer || !route.actorSubjectDigest) throw groupContractError("group_actor_route_invalid");
  return {tenantScope, actorIssuer:route.actorIssuer, actorSubjectDigest:route.actorSubjectDigest};
}

function normalizeGroupGoalDisplayHistory(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw groupContractError("group_history_unavailable");
  const allowed = new Set(["contractVersion", "transcriptSessionId", "sessionRevision", "sessionStatus", "sessionUpdatedAt", "turns", "status", "errorCode", "result", "warning", "truncated"]);
  if (Object.keys(value).some(key => !allowed.has(key)) || value.contractVersion !== "group-goal-display-history.v1" ||
    !Array.isArray(value.turns) || value.turns.length > 100 ||
    !["active", "ended", "archived"].includes(value.sessionStatus) ||
    !Number.isSafeInteger(value.sessionRevision) || value.sessionRevision < 1 || !Number.isFinite(Date.parse(value.sessionUpdatedAt))) {
    throw groupContractError("group_history_unavailable");
  }
  const status = groupPlanningStatus(value.status);
  const result = normalizeGroupGoalDisplayResult(value.result, status);
  const errorCode = status === "failed" && value.errorCode ? safeGroupRequestErrorCode(value.errorCode) : "";
  let previousRevision = 0;
  const turns = value.turns.map(turn => {
    if (!turn || typeof turn !== "object" || Array.isArray(turn)) throw groupContractError("group_history_unavailable");
    const fields = new Set(["revision", "text", "createdAt", "planningStatus", "errorCode", "result", "answer"]);
    if (Object.keys(turn).some(key => !fields.has(key)) || !Number.isSafeInteger(turn.revision) || turn.revision <= previousRevision ||
      typeof turn.text !== "string" || !turn.text.trim() || turn.text.length > 12_000 || !Number.isFinite(Date.parse(turn.createdAt))) {
      throw groupContractError("group_history_unavailable");
    }
    previousRevision = turn.revision;
    const planningStatus = groupPlanningStatus(turn.planningStatus);
    const turnResult = normalizeGroupGoalDisplayResult(turn.result, planningStatus);
    const answer = turn.answer === undefined ? null : normalizeGroupPlannerAnswer(turn.answer, planningStatus);
    const turnErrorCode = planningStatus === "failed" && turn.errorCode ? safeGroupRequestErrorCode(turn.errorCode) : "";
    return {
      revision: turn.revision, text: turn.text, createdAt: turn.createdAt, planningStatus,
      ...(turnErrorCode ? { errorCode: turnErrorCode } : {}),
      ...(turnResult ? { result: turnResult } : {}),
      ...(answer ? { answer } : {}),
    };
  });
  return {
    contractVersion: "group-goal-display-history.v1",
    transcriptSessionId: groupId(value.transcriptSessionId),
    sessionRevision: value.sessionRevision,
    sessionStatus: value.sessionStatus,
    sessionUpdatedAt: value.sessionUpdatedAt,
    turns,
    status,
    ...(errorCode ? { errorCode } : {}),
    ...(result ? { result } : {}),
    ...(value.warning === LEGACY_TURN_WARNING ? { warning: LEGACY_TURN_WARNING } : {}),
    ...(value.truncated === true ? { truncated: true } : {}),
  };
}

function groupPlanningStatus(value) {
  if (!["draft_ready", "planning", "failed", "canceled", "unknown"].includes(value)) throw groupContractError("group_history_unavailable");
  return value;
}

function normalizeGroupPlannerAnswer(value, status) {
  if (status !== "draft_ready" || !value || typeof value !== "object" || Array.isArray(value) ||
    Object.keys(value).some(key => !["understanding", "recommendations"].includes(key)) ||
    typeof value.understanding !== "string" || !value.understanding.trim() || value.understanding.length > 600 ||
    /[\u0000-\u001f\u007f]/.test(value.understanding) || !Array.isArray(value.recommendations) || value.recommendations.length > 12) {
    throw groupContractError("group_history_unavailable");
  }
  const recommendations = value.recommendations.map(item => {
    if (!item || typeof item !== "object" || Array.isArray(item) ||
      Object.keys(item).some(key => !["employeeId", "assignment", "reason"].includes(key)) ||
      typeof item.employeeId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:@-]{0,159}$/.test(item.employeeId) ||
      [item.assignment, item.reason].some(text => typeof text !== "string" || !text.trim() || text.length > 240 || /[\u0000-\u001f\u007f]/.test(text))) {
      throw groupContractError("group_history_unavailable");
    }
    return { employeeId: item.employeeId, assignment: item.assignment, reason: item.reason };
  });
  if (new Set(recommendations.map(item => item.employeeId)).size !== recommendations.length) throw groupContractError("group_history_unavailable");
  return { understanding: value.understanding, recommendations };
}

function normalizeGroupGoalDisplayResult(value, status) {
  if (value === undefined) return null;
  if (status !== "draft_ready" || !value || typeof value !== "object" || Array.isArray(value) ||
    Object.keys(value).some(key => !["kind", "goalRevision", "adopted"].includes(key)) ||
    value.kind !== "plan_draft" || !Number.isSafeInteger(value.goalRevision) || value.goalRevision < 1 ||
    (value.adopted !== undefined && value.adopted !== true)) {
    throw groupContractError("group_history_unavailable");
  }
  return { kind: "plan_draft", goalRevision: value.goalRevision, ...(value.adopted ? { adopted: true } : {}) };
}

function plannerContext({ actor, goal, groupVersion, resourceScope }) {
  return {
    scope: actor, goalId: goal.goalId, goalRevision: goal.revision,
    groupId: groupVersion.groupId, groupVersion: groupVersion.version,
    members: groupVersion.members, reviewerGroup: groupVersion.reviewerGroup,
    objectiveRef: goal.objectiveRef, budget: goal.budget,
    completionConditions: goal.completionConditions, resourceScope,
  };
}

function assertPlannerRetryInput(input, attempt, submittedObjective) {
  const fields = [
    ["objective", submittedObjective], ["inputRefs", attempt.inputRefs],
    ["planningHints", attempt.planningHints], ["resourceScope", attempt.resourceScope],
  ];
  for (const [field, expected] of fields) {
    if (input[field] !== undefined && groupContentDigest(input[field]) !== groupContentDigest(expected)) {
      throw groupContractError("group_idempotency_conflict");
    }
  }
}

function assertPlannerRetryEnvelope(input, goal, groupVersion) {
  if (Array.isArray(input.members) && input.members.length && groupContentDigest(input.members) !== groupContentDigest(groupVersion.members.map(({ employeeId, employeeVersion }) => ({ employeeId, employeeVersion })))) {
    throw groupContractError("group_member_version_invalid");
  }
  const expected = [["reviewerGroup", groupVersion.reviewerGroup || null], ["budget", goal.budget], ["completionConditions", goal.completionConditions]];
  for (const [field, value] of expected) {
    if (input[field] !== undefined && groupContentDigest(input[field]) !== groupContentDigest(value)) throw groupContractError("group_idempotency_conflict");
  }
}
