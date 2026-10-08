import crypto from "node:crypto";

export const GROUP_CONTRACT_VERSION = "group-studio.v1";
export const GROUP_TERMINAL_STATUSES = Object.freeze(["completed", "failed", "canceled"]);
export const GROUP_BLOCK_CODES = Object.freeze([
  "authorization_required", "dependency_failed", "budget_exhausted", "resume_required",
  "external_effect_unknown", "artifact_unavailable", "version_unavailable", "question_pending",
]);
export const GROUP_IDENTIFIER_PATTERN = "^[A-Za-z0-9][A-Za-z0-9._:@-]{0,159}$";
const ID_PATTERN = new RegExp(GROUP_IDENTIFIER_PATTERN);
const SCOPE_FIELDS = ["tenantScope", "actorIssuer", "actorSubjectDigest"];

export function groupContractError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

export function groupObject(value, fields, version) {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(value))) {
    throw groupContractError("group_object_invalid");
  }
  if (Object.keys(value).some(key => !fields.includes(key) && !(version && key === "contractVersion"))) {
    throw groupContractError("group_field_unsupported");
  }
  if (version && value.contractVersion !== version) throw groupContractError("group_contract_version_invalid");
  return value;
}

export function groupId(value) {
  if (typeof value !== "string" || !ID_PATTERN.test(value)) throw groupContractError("group_identifier_invalid");
  return value;
}

export function groupInteger(value, min = 0, max = Number.MAX_SAFE_INTEGER) {
  if (!Number.isSafeInteger(value) || value < min || value > max) throw groupContractError("group_integer_invalid");
  return value;
}

export function groupEnum(value, allowed) {
  if (!allowed.includes(value)) throw groupContractError("group_enum_invalid");
  return value;
}

export function groupDigest(value) {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value)) throw groupContractError("group_digest_invalid");
  return value;
}

export function groupScope(value) {
  return {
    tenantScope: groupId(value.tenantScope),
    actorIssuer: groupId(value.actorIssuer),
    actorSubjectDigest: groupDigest(value.actorSubjectDigest),
  };
}

export function assertGroupScope(record, actor) {
  const scope = groupScope(actor);
  if (SCOPE_FIELDS.some(field => record[field] !== scope[field])) throw groupContractError("group_actor_scope_denied");
}

export function groupFreeze(value) {
  if (value && typeof value === "object") {
    Object.values(value).forEach(groupFreeze);
    Object.freeze(value);
  }
  return value;
}

function array(value, max = 64, min = 0) {
  if (!Array.isArray(value) || value.length < min || value.length > max) throw groupContractError("group_array_invalid");
  return value;
}

function ids(value, max = 64, min = 0) {
  const result = array(value, max, min).map(groupId);
  if (new Set(result).size !== result.length) throw groupContractError("group_duplicate_identifier");
  return result;
}

function timestamp(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) ||
      !Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value) {
    throw groupContractError("group_timestamp_invalid");
  }
  return value;
}

// Prose stays behind existing authorized material/transcript references. These
// metadata contracts never try to turn raw text into safe text with a denylist.
export function normalizeGroupContentRef(value) {
  const v = groupObject(value, ["kind", "refId"]);
  return { kind: groupEnum(v.kind, ["artifact_ref", "transcript_entry"]), refId: groupId(v.refId) };
}

// A Group input carries only an opaque Center-owned reference.  The reference
// is intentionally metadata-only; material grants, paths and payloads stay in
// their existing authority and are resolved per canonical child task.
export function normalizeGroupInputReference(value) {
  const v = groupObject(value, ["refId", "version", "scope", "contractVersion"]);
  if (v.contractVersion !== undefined && v.contractVersion !== "group-input-reference.v1") throw groupContractError("group_contract_version_invalid");
  return {
    contractVersion: "group-input-reference.v1",
    refId: groupId(v.refId),
    version: groupId(v.version),
    scope: groupId(v.scope),
  };
}

function normalizeGroupInputReferences(value) {
  const refs = array(value === undefined ? [] : value, 16).map(normalizeGroupInputReference);
  if (new Set(refs.map((ref) => ref.refId)).size !== refs.length) throw groupContractError("group_duplicate_input_reference");
  return refs;
}

export function normalizeGroupBudget(value) {
  const fields = ["maxSteps", "maxParallel", "maxRepairRounds", "maxQuestions", "maxTokens", "maxDurationMs", "maxCostMicros"];
  const v = groupObject(value, fields);
  const budget = {
    maxSteps: groupInteger(v.maxSteps, 1, 64),
    maxParallel: groupInteger(v.maxParallel, 1, 2),
    maxRepairRounds: groupInteger(v.maxRepairRounds, 0, 1),
    maxQuestions: groupInteger(v.maxQuestions, 0, 16),
    maxTokens: groupInteger(v.maxTokens, 1, 2_000_000),
    maxDurationMs: groupInteger(v.maxDurationMs, 1, 86_400_000),
    maxCostMicros: groupInteger(v.maxCostMicros, 0, 1_000_000_000),
  };
  if (budget.maxParallel > budget.maxSteps) throw groupContractError("group_budget_invalid");
  return budget;
}

export function normalizeWorkGoal(value) {
  const version = "work-goal.v1";
  const v = groupObject(value, [...SCOPE_FIELDS, "goalId", "revision", "idempotencyKey", "objectiveRef", "objectiveDigest", "turnInputRef", "transcriptSessionId", "phase", "budget", "completionConditions", "inputRefs", "planningContext", "reworkSource"], version);
  const plannerBinding = v.plannerBinding === undefined ? undefined : (() => {
    const binding = groupObject(v.plannerBinding, ["employeeId", "employeeVersion"]);
    return { employeeId: groupId(binding.employeeId), employeeVersion: groupId(binding.employeeVersion) };
  })();
  const planningContext = v.planningContext === undefined ? undefined : (() => {
    const context = groupObject(v.planningContext, ["groupId", "groupVersion", "clientRequestId", "plannerRequestId", "baseGoalRevision", "baseGroupVersion"]);
    return { groupId: groupId(context.groupId), groupVersion: groupInteger(context.groupVersion, 1), clientRequestId: groupId(context.clientRequestId), plannerRequestId: groupId(context.plannerRequestId), baseGoalRevision: groupInteger(context.baseGoalRevision, 1), baseGroupVersion: groupInteger(context.baseGroupVersion, 1) };
  })();
  const reworkSource = v.reworkSource === undefined ? undefined : (() => {
    const source = groupObject(v.reworkSource, ["runId", "planId", "planRevision", "reviewTaskId", "opinionArtifactId"]);
    return { runId: groupId(source.runId), planId: groupId(source.planId), planRevision: groupInteger(source.planRevision, 1),
      reviewTaskId: groupId(source.reviewTaskId), opinionArtifactId: groupId(source.opinionArtifactId) };
  })();
  return groupFreeze({
    contractVersion: version, ...groupScope(v), goalId: groupId(v.goalId),
    revision: groupInteger(v.revision), idempotencyKey: groupId(v.idempotencyKey),
    objectiveRef: normalizeGroupContentRef(v.objectiveRef), objectiveDigest: groupDigest(v.objectiveDigest),
    ...(v.turnInputRef === undefined ? {} : { turnInputRef: normalizeGroupContentRef(v.turnInputRef) }),
    ...(v.transcriptSessionId === undefined ? {} : { transcriptSessionId: groupId(v.transcriptSessionId) }),
    phase: groupEnum(v.phase, ["draft", "adopted", "completed", "canceled"]),
    budget: normalizeGroupBudget(v.budget), completionConditions: ids(v.completionConditions, 16, 1), inputRefs: normalizeGroupInputReferences(v.inputRefs), ...(planningContext ? { planningContext } : {}), ...(reworkSource ? { reworkSource } : {}),
  });
}

export function normalizeGroupVersion(value) {
  const version = "group-version.v1";
  const v = groupObject(value, [...SCOPE_FIELDS, "groupId", "version", "idempotencyKey", "members", "reviewerGroup", "reviewerSkillBinding"], version);
  const members = array(v.members, 12, 1).map(member => {
    const m = groupObject(member, ["employeeId", "employeeVersion", "roleRef", "coordinator"]);
    if (typeof m.coordinator !== "boolean") throw groupContractError("group_boolean_invalid");
    return { employeeId: groupId(m.employeeId), employeeVersion: groupId(m.employeeVersion), roleRef: normalizeGroupContentRef(m.roleRef), coordinator: m.coordinator };
  });
  ids(members.map(member => member.employeeId), 12, 1);
  if (members.filter(member => member.coordinator).length !== 1) throw groupContractError("group_coordinator_required");
  const reviewerGroup = normalizeReviewerGroup(v.reviewerGroup, members);
  if (v.reviewerSkillBinding !== undefined && !reviewerGroup) throw groupContractError("group_reviewer_skill_binding_invalid");
  const reviewerSkillBinding = v.reviewerSkillBinding === undefined ? null : normalizeGroupReviewerSkillBinding(v.reviewerSkillBinding);
  return groupFreeze({ contractVersion: version, ...groupScope(v), groupId: groupId(v.groupId), version: groupInteger(v.version, 1), idempotencyKey: groupId(v.idempotencyKey), members, ...(reviewerGroup ? { reviewerGroup } : {}), ...(reviewerSkillBinding ? { reviewerSkillBinding } : {}) });
}

export function normalizeGroupReviewerSkillBinding(value) {
  const v = groupObject(value, ["skillId", "version", "contentDigest"]);
  return { skillId: groupId(v.skillId), version: groupId(v.version), contentDigest: groupDigest(v.contentDigest) };
}

export function normalizeReviewerGroup(value, groupMembers = []) {
  if (value === undefined || value === null) return null;
  const v = groupObject(value, ["reviewerGroupId", "displayName", "mode", "members", "finalReviewerEmployeeId"]);
  const mode = groupEnum(v.mode, ["single", "sequential", "parallel"]);
  const members = array(v.members, 12, 1).map((member, index) => {
    const m = groupObject(member, ["employeeId", "employeeVersion", "order"]);
    return { employeeId: groupId(m.employeeId), employeeVersion: groupId(m.employeeVersion), order: groupInteger(m.order === undefined ? index : m.order, 0, 11) };
  });
  if (new Set(members.map((member) => member.employeeId)).size !== members.length) throw groupContractError("group_reviewer_duplicate_member");
  if (mode === "single" && members.length !== 1) throw groupContractError("group_reviewer_single_invalid");
  if (mode !== "single" && members.length < 2) throw groupContractError("group_reviewer_members_invalid");
  const sorted = [...members].sort((a, b) => a.order - b.order);
  if (sorted.some((member, index) => member.order !== index)) throw groupContractError("group_reviewer_order_invalid");
  const allowed = new Map(groupMembers.map((member) => [member.employeeId, member.employeeVersion]));
  if (groupMembers.length && sorted.some((member) => allowed.get(member.employeeId) !== member.employeeVersion)) throw groupContractError("group_reviewer_member_not_in_group");
  const finalReviewerEmployeeId = groupId(v.finalReviewerEmployeeId || sorted.at(-1).employeeId);
  if (!sorted.some((member) => member.employeeId === finalReviewerEmployeeId)) throw groupContractError("group_reviewer_final_invalid");
  return {
    ...(v.reviewerGroupId === undefined ? {} : { reviewerGroupId: groupId(v.reviewerGroupId) }),
    ...(v.displayName === undefined ? {} : { displayName: String(v.displayName).trim().slice(0, 120) }),
    mode, members: sorted, finalReviewerEmployeeId,
  };
}

export function normalizeGroupStep(value) {
  const version = "group-step.v1";
  const v = groupObject(value, ["stepId", "employeeId", "employeeVersion", "kind", "instructionRef", "dependsOn", "optionalDependsOn", "inputArtifactIds", "inputRefIds", "required", "completionConditions", "reworkOfStepId", "round", "outputScope"], version);
  if (typeof v.required !== "boolean") throw groupContractError("group_boolean_invalid");
  const round = groupInteger(v.round, 0, 1);
  const reworkOfStepId = v.reworkOfStepId === null ? null : groupId(v.reworkOfStepId);
  if ((round === 1) !== (reworkOfStepId !== null)) throw groupContractError("group_rework_reference_invalid");
  const dependsOn = ids(v.dependsOn), optionalDependsOn = ids(v.optionalDependsOn);
  if (dependsOn.some(id => optionalDependsOn.includes(id))) throw groupContractError("group_duplicate_dependency");
  return groupFreeze({
    contractVersion: version, stepId: groupId(v.stepId), employeeId: groupId(v.employeeId),
    employeeVersion: groupId(v.employeeVersion), kind: groupEnum(v.kind, ["delegate", "consult", "review", "summary"]),
    instructionRef: normalizeGroupContentRef(v.instructionRef), dependsOn, optionalDependsOn,
    inputArtifactIds: ids(v.inputArtifactIds), required: v.required,
    completionConditions: ids(v.completionConditions, 16, 1), inputRefIds: ids(v.inputRefIds), reworkOfStepId, round,
    ...(v.outputScope === undefined ? {} : { outputScope: groupEnum(v.outputScope, ["group", "task"]) }),
  });
}

export function assertAcyclic(steps) {
  const map = new Map();
  for (const step of array(steps, 64, 1)) {
    if (map.has(step.stepId)) throw groupContractError("group_duplicate_step");
    map.set(step.stepId, step);
  }
  const visiting = new Set(), visited = new Set();
  function visit(id) {
    if (visiting.has(id)) throw groupContractError("group_plan_dependency_cycle");
    if (visited.has(id)) return;
    const step = map.get(id);
    if (!step) throw groupContractError("group_plan_dependency_missing");
    visiting.add(id);
    for (const dependency of [...step.dependsOn, ...(step.optionalDependsOn || [])]) visit(dependency);
    visiting.delete(id);
    visited.add(id);
  }
  for (const id of map.keys()) visit(id);
  return true;
}

function normalizePlan(value, version) {
  const v = groupObject(value, [...SCOPE_FIELDS, "goalId", "goalRevision", "groupId", "groupVersion", "planId", "revision", "instructionRevision", "idempotencyKey", "steps", "resourceScope", "inputRefs", "budget", "completionConditions", "plannerBinding", "reviewerGroup"], version);
  const steps = array(v.steps, 64, 1).map(normalizeGroupStep);
  assertAcyclic(steps);
  const budget = normalizeGroupBudget(v.budget);
  if (steps.length > budget.maxSteps || steps.some(step => step.round > budget.maxRepairRounds)) throw groupContractError("group_budget_exceeded");
  const resourceScope = ids(v.resourceScope);
  const inputRefs = normalizeGroupInputReferences(v.inputRefs);
  const inputRefIds = new Set(inputRefs.map((ref) => ref.refId));
  if (steps.some((step) => step.inputRefIds.some((refId) => !inputRefIds.has(refId)))) {
    throw groupContractError("group_input_reference_scope_invalid");
  }
  for (const step of steps) {
    if (step.inputArtifactIds.some(id => !resourceScope.includes(id))) throw groupContractError("group_material_scope_invalid");
    if (step.reworkOfStepId && (!steps.some(s => s.stepId === step.reworkOfStepId && s.round === 0) || !step.dependsOn.includes(step.reworkOfStepId))) throw groupContractError("group_rework_reference_invalid");
  }
  const plannerBinding = v.plannerBinding === undefined ? undefined : (() => {
    const binding = groupObject(v.plannerBinding, ["employeeId", "employeeVersion"]);
    return { employeeId: groupId(binding.employeeId), employeeVersion: groupId(binding.employeeVersion) };
  })();
  const reviewerGroup = normalizeReviewerGroup(v.reviewerGroup);
  if (reviewerGroup) assertReviewerPlan(steps, reviewerGroup);
  return groupFreeze({
    contractVersion: version, ...groupScope(v), goalId: groupId(v.goalId), goalRevision: groupInteger(v.goalRevision),
    groupId: groupId(v.groupId), groupVersion: groupInteger(v.groupVersion, 1), planId: groupId(v.planId),
    revision: groupInteger(v.revision), instructionRevision: groupInteger(v.instructionRevision),
    idempotencyKey: groupId(v.idempotencyKey), steps, resourceScope, budget,
    completionConditions: ids(v.completionConditions, 16, 1), inputRefs,
    ...(plannerBinding ? { plannerBinding } : {}), ...(reviewerGroup ? { reviewerGroup } : {}),
  });
}

// Deterministic checks of the user-selected review policy, never plan synthesis.
// Distinct safe codes diagnose shape failures without returning instructions.
function assertReviewerPlan(steps, policy) {
  const byId = new Map(steps.map(step => [step.stepId, step]));
  function dependsOn(step, targetId, seen = new Set()) {
    if (seen.has(step.stepId)) return false;
    seen.add(step.stepId);
    return step.dependsOn.some(id => id === targetId || dependsOn(byId.get(id), targetId, seen));
  }
  const summaries = steps.filter(step => step.kind === "summary");
  if (!summaries.length) throw groupContractError("group_reviewer_summary_missing");
  if (summaries.length !== 1) throw groupContractError("group_reviewer_summary_count_invalid");
  const summary = summaries[0];
  const finalReviewer = policy.members.find(member => member.employeeId === policy.finalReviewerEmployeeId);
  if (summary.employeeId !== finalReviewer.employeeId || summary.employeeVersion !== finalReviewer.employeeVersion) {
    throw groupContractError("group_reviewer_final_member_mismatch");
  }
  if (!summary.required) throw groupContractError("group_reviewer_summary_required");
  const reviews = policy.members.map(member => {
    const matches = steps.filter(step => step.kind === "review" && step.employeeId === member.employeeId && step.employeeVersion === member.employeeVersion);
    if (matches.length !== 1 || !matches[0].required) throw groupContractError("group_reviewer_required_step_invalid");
    return matches[0];
  });
  if (steps.filter(step => step.kind === "review").length !== reviews.length) throw groupContractError("group_reviewer_member_mismatch");
  if (reviews.some(review => !dependsOn(summary, review.stepId))) throw groupContractError("group_reviewer_summary_dependency_missing");
  if (policy.mode === "sequential" && reviews.some((review, index) => index && !dependsOn(review, reviews[index - 1].stepId))) {
    throw groupContractError("group_reviewer_order_invalid");
  }
  if (policy.mode === "parallel" && reviews.some(review => reviews.some(other => other !== review && dependsOn(review, other.stepId)))) {
    throw groupContractError("group_reviewer_parallel_dependency_invalid");
  }
}

export const normalizeGroupPlan = value => normalizePlan(value, "group-plan.v1");
export const normalizeGroupPlanDraft = value => normalizePlan(value, "group-plan-draft.v1");

// A required step also makes each transitive hard dependency required for the
// run to succeed. optionalDependsOn affects readiness only and never enters
// this failure boundary.
export function requiredGroupExecutionStepIds(value) {
  const plan = normalizeGroupPlan(value);
  const byId = new Map(plan.steps.map(step => [step.stepId, step]));
  const required = new Set();
  function include(stepId) {
    if (required.has(stepId)) return;
    required.add(stepId);
    for (const dependencyId of byId.get(stepId)?.dependsOn || []) include(dependencyId);
  }
  for (const step of plan.steps) if (step.required) include(step.stepId);
  return groupFreeze([...required]);
}

export function normalizeGroupRun(value) {
  const version = "group-run.v1";
  const v = groupObject(value, [...SCOPE_FIELDS, "runId", "goalId", "goalRevision", "groupId", "groupVersion", "planId", "planRevision", "idempotencyKey", "casRevision", "activation", "cancelRequested", "stepBindings", "parentTaskId", "acceptance"], version);
  if (typeof v.cancelRequested !== "boolean") throw groupContractError("group_boolean_invalid");
  const stepBindings = array(v.stepBindings, 64).map(binding => {
    const b = groupObject(binding, ["stepId", "taskId", "round"]);
    return { stepId: groupId(b.stepId), taskId: groupId(b.taskId), round: groupInteger(b.round, 0, 1) };
  });
  ids(stepBindings.map(b => b.stepId));
  ids(stepBindings.map(b => b.taskId));
  return groupFreeze({
    contractVersion: version, ...groupScope(v), runId: groupId(v.runId), goalId: groupId(v.goalId), goalRevision: groupInteger(v.goalRevision),
    groupId: groupId(v.groupId), groupVersion: groupInteger(v.groupVersion, 1),
    planId: groupId(v.planId), planRevision: groupInteger(v.planRevision),
    idempotencyKey: groupId(v.idempotencyKey), casRevision: groupInteger(v.casRevision),
    activation: groupEnum(v.activation, ["paused", "active", "resume_required", "closed"]),
    ...(v.acceptance ? { acceptance: normalizeGroupAcceptance(v.acceptance) } : {}),
    cancelRequested: v.cancelRequested, parentTaskId: v.parentTaskId === null ? null : groupId(v.parentTaskId), stepBindings,
  });
}

export function normalizeGroupAcceptance(value) {
  const v = groupObject(value, ["decision", "deliveryDigest", "decidedAt"]);
  return groupFreeze({ decision: groupEnum(v.decision, ["accepted", "rejected"]),
    deliveryDigest: groupDigest(v.deliveryDigest), decidedAt: timestamp(v.decidedAt) });
}

export function normalizeGroupQuestion(value) {
  const version = "group-question.v1";
  const v = groupObject(value, [...SCOPE_FIELDS, "questionId", "runId", "planRevision", "instructionRevision", "senderStepId", "recipientKind", "recipientEmployeeId", "messageId", "replyTo", "bodyRef", "answerRef", "contextArtifactIds", "required", "deadline", "status", "casRevision"], version);
  const recipientKind = groupEnum(v.recipientKind, ["user", "employee"]);
  const recipientEmployeeId = v.recipientEmployeeId === null ? null : groupId(v.recipientEmployeeId);
  if ((recipientKind === "employee") !== (recipientEmployeeId !== null)) throw groupContractError("group_question_recipient_invalid");
  if (typeof v.required !== "boolean") throw groupContractError("group_boolean_invalid");
  const status = groupEnum(v.status, ["open", "answered", "processed", "skipped", "expired", "canceled", "invalidated"]);
  const replyTo = v.replyTo === null ? null : groupId(v.replyTo);
  const answerRef = v.answerRef === null ? null : normalizeGroupContentRef(v.answerRef);
  if (answerRef && replyTo !== v.questionId) throw groupContractError("group_question_reply_invalid");
  if (["answered", "processed"].includes(status) !== Boolean(answerRef)) throw groupContractError("group_question_answer_invalid");
  return groupFreeze({
    contractVersion: version, ...groupScope(v), questionId: groupId(v.questionId), runId: groupId(v.runId),
    planRevision: groupInteger(v.planRevision), instructionRevision: groupInteger(v.instructionRevision), senderStepId: groupId(v.senderStepId),
    recipientKind, recipientEmployeeId, messageId: groupId(v.messageId), replyTo,
    bodyRef: normalizeGroupContentRef(v.bodyRef), answerRef, contextArtifactIds: ids(v.contextArtifactIds),
    required: v.required, deadline: timestamp(v.deadline), status, casRevision: groupInteger(v.casRevision),
  });
}

export function groupContentDigest(value) {
  function canonical(v) {
    if (Array.isArray(v)) return v.map(canonical);
    if (v && typeof v === "object") return Object.fromEntries(Object.keys(v).sort().map(key => [key, canonical(v[key])]));
    return v;
  }
  return crypto.createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex");
}
