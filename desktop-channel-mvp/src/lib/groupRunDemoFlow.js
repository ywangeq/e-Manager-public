const json = (value) => ({
  method: "POST",
  credentials: "same-origin",
  headers: { "Content-Type": "application/json", Accept: "application/json" },
  body: JSON.stringify(value),
});

async function post(path, body, fetcher) {
  const response = await fetcher(path, json(body));
  const result = await response.json();
  if (!response.ok || result?.ok !== true) throw new Error(`${path}: ${result?.error || "group_request_failed"}`);
  return result;
}

const GROUP_IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:@-]{0,159}$/;

export const GROUP_STUDIO_ACCESS_GROUPS = Object.freeze([
  { id: "direct", label: "可直接使用" },
  { id: "request", label: "需要申请" },
  { id: "unavailable", label: "当前不可用" },
]);

export function groupStudioMemberAccessGroup(employee = {}) {
  if (employee?.access?.callable === true && employee?.access?.selectable === true) return "direct";
  if (employee?.access?.requestable === true) return "request";
  return "unavailable";
}

export function selectGroupStudioMembers(employees = []) {
  if (!Array.isArray(employees)) return [];
  const seen = new Set();
  return employees.filter((employee) => {
    const employeeId = String(employee?.id || "").trim();
    const employeeVersion = String(employee?.version || "").trim();
    if (!GROUP_IDENTIFIER.test(employeeId) || !GROUP_IDENTIFIER.test(employeeVersion)) return false;
    if (seen.has(employeeId)) return false;
    seen.add(employeeId);
    return true;
  });
}

export function selectGroupRunDemoMembers(employees = [], maxMembers = 12) {
  const members = selectGroupStudioMembers(employees).filter((employee) => groupStudioMemberAccessGroup(employee) === "direct");
  const limit = Number.isInteger(maxMembers) && maxMembers > 0 ? Math.min(maxMembers, 12) : 12;
  return members.slice(0, limit);
}

export function reviewerConfigurationIssue({ reviewerIds = [], mode = "single", finalReviewerEmployeeId = "" } = {}) {
  if (!Array.isArray(reviewerIds) || !reviewerIds.length) return null;
  if (new Set(reviewerIds).size !== reviewerIds.length) return "复核成员不能重复";
  if (mode === "single" && reviewerIds.length !== 1) return "单人复核只能保留一位成员；请选择顺序复核或并行复核";
  if (["sequential", "parallel"].includes(mode) && reviewerIds.length < 2) return "顺序复核或并行复核至少需要两位成员";
  if (!["single", "sequential", "parallel"].includes(mode)) return "请选择复核模式";
  if (!finalReviewerEmployeeId || !reviewerIds.includes(finalReviewerEmployeeId)) return "请选择最终汇总 Reviewer";
  return null;
}

export async function startGroupRunDemo({ objective, inputRefs = [], employees = [], selectedEmployeeIds = null, planningHints = [], reviewerGroup = null, continuation = null, retryOnly = false, fetcher = globalThis.fetch, now = Date.now, idempotencyKey = null } = {}) {
  if (typeof fetcher !== "function") throw new Error("group_fetcher_required");
  const candidates = selectGroupStudioMembers(employees).filter(employee => groupStudioMemberAccessGroup(employee) === "direct");
  const selectedEmployees = candidates.filter((employee) => selectedEmployeeIds === null || selectedEmployeeIds.includes(employee.id));
  if (!continuation && selectedEmployees.length > 12) throw new Error("group_member_limit_exceeded");
  if (!continuation && !selectedEmployees.length) throw new Error("group_callable_members_unavailable");
  const suffix = String(now());
  const body = retryOnly && continuation?.retry === true
    ? { continuation, idempotencyKey: idempotencyKey || `${suffix}` }
    : { objective, ...(!continuation ? { members: selectedEmployees.map(employee => ({ employeeId: employee.id, employeeVersion: employee.version })) } : {}),
      reviewerGroup, planningHints, inputRefs, ...(continuation ? { continuation } : {}), idempotencyKey: idempotencyKey || `${suffix}`,
      budget:{ maxSteps:16, maxParallel:2, maxRepairRounds:1, maxQuestions:2, maxTokens:2000, maxDurationMs:120000, maxCostMicros:10000 }, completionConditions:["group-summary-ready"], resourceScope:[] };
  const planning = await post("/api/group-studio/messages", body, fetcher);
  if (planning.planning === "pending") {
    const error = new Error("agent_turn_pending"); error.code = "agent_turn_pending";
    error.taskId = planning.taskId; error.idempotencyKey = idempotencyKey || suffix;
    error.goal = planning.goal; error.groupVersion = planning.groupVersion; throw error;
  }
  return groupPlanningReview(planning);
}

export function groupPlanningReview(planning) {
  const { goal, groupVersion, planDraft: draft } = planning;
  // The Center owns canonical identifiers; use its returned records for the
  // review/adoption envelope instead of reconstructing ids in Desktop.
  const canonicalGoalId = goal.goalId;
  const canonicalGroupId = groupVersion.groupId;
  const canonicalPlanId = draft.planId;
  const { contractVersion: draftContract, planner: plannerProjection, ...draftFields } = draft;
  const review = {
    reviewRequired: true, goal, groupVersion, draft,
    plan: { ...draftFields, contractVersion: "group-plan.v1", revision: 1, idempotencyKey: `adopt-${canonicalPlanId}` },
    run: { contractVersion: "group-run.v1", runId: `run-${canonicalPlanId}`, goalId: canonicalGoalId, goalRevision: goal.revision, groupId: canonicalGroupId, groupVersion: groupVersion.version, planId: canonicalPlanId, planRevision: 1, idempotencyKey: `run-${canonicalPlanId}`, casRevision: 0, activation: "active", cancelRequested: false, parentTaskId: null, stepBindings: [] },
  };
  return review;
}


export async function advanceGroupRun({ runId, expectedRevision, fetcher = globalThis.fetch } = {}) {
  const result = await post(`/api/group-studio/runs/${encodeURIComponent(runId)}/advance`, { expectedRevision }, fetcher);
  return result.run;
}

export async function adoptGroupRunDemo({ review, fetcher = globalThis.fetch } = {}) {
  await post("/api/group-studio/plans/adopt", review.plan, fetcher);
  return (await post("/api/group-studio/runs", review.run, fetcher)).run;
}

export async function resumeGroupRun({ runId, expectedRevision, fetcher = globalThis.fetch } = {}) {
  return (await post(`/api/group-studio/runs/${encodeURIComponent(runId)}/resume`, { expectedRevision }, fetcher)).run;
}
export async function cancelGroupRun({ runId, expectedRevision, fetcher = globalThis.fetch } = {}) {
  return (await post(`/api/group-studio/runs/${encodeURIComponent(runId)}/cancel`, { expectedRevision }, fetcher)).run;
}

export async function cancelGroupPlanning({ cancellation, fetcher = globalThis.fetch } = {}) {
  if (!cancellation || typeof cancellation !== "object") throw new Error("group_planner_cancel_input_invalid");
  return post("/api/group-studio/planning-cancellations", cancellation, fetcher);
}

export function groupPlanningCancellationHandle({ idempotencyKey, continuation = null, retryOnly = false, currentPlanningContext = null, historyStatus = "" } = {}) {
  if (!continuation) return { clientRequestId: idempotencyKey, goalRevision: 1, groupVersion: 1 };
  const reattachingPending = retryOnly && historyStatus === "planning" && currentPlanningContext?.clientRequestId;
  return {
    clientRequestId: reattachingPending ? currentPlanningContext.clientRequestId : idempotencyKey,
    goalId: continuation.goalId,
    goalRevision: Number(continuation.expectedGoalRevision) + (reattachingPending ? 0 : 1),
    groupId: continuation.groupId,
    groupVersion: Number(continuation.expectedGroupVersion) + (reattachingPending ? 0 : 1),
  };
}
