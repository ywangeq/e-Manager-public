import { resolveEffectiveSkillScope } from "./skill-scope-resolver.mjs";
import { GROUP_IDENTIFIER_PATTERN, groupContentDigest, normalizeGroupPlanDraft, normalizeGroupBudget } from "./group-contracts-v1.mjs";

const TASK_PLANNER_AGENT_CONTRACT = "task-planner-agent.v1";

// Channel-neutral Planner Agent adapter. It delegates task understanding and
// capability matching to the governed Agent Runtime; it never selects an
// employee from a hard-coded list and never writes Group contracts itself.
export function createTaskPlannerAgent({
  runAgentTurn = null,
  resolveEmployee,
  resolveSkills,
  createInstructionReference,
  resolveReviewerFeedback = null,
  now = () => new Date().toISOString(),
} = {}) {
  if (typeof runAgentTurn !== "function") {
    throw new TypeError("task planner requires the shared Agent session loop");
  }
  if (typeof resolveEmployee !== "function") {
    throw new TypeError("task planner requires a governed employee resolver");
  }
  if (typeof resolveSkills !== "function") throw new TypeError("task planner requires governed Skills");
  if (typeof createInstructionReference !== "function") throw new TypeError("task planner requires Center instruction persistence");
  return Object.freeze({
    contractVersion: TASK_PLANNER_AGENT_CONTRACT,
    async suggest({ actor, session, objective, employees = [], inputRefs = [], constraints = [], planContext = null, requestId, signal = null } = {}) {
      if (!requestId || !session || !objective?.trim()) throw failure("task_planner_input_invalid");
      if (signal?.aborted) throw failure("agent_turn_canceled");
      const planner = await resolveEmployee({ employeeId: "task-planner-agent", actor, session });
      if (!planner) throw failure("task_planner_employee_unavailable");
      const skills = await resolveSkills({ actor, session });
      const scope = resolveEffectiveSkillScope({ employee: planner, skills });
      if (!scope.callableSkillIds.includes("goal-driven-group-planning")) throw failure("task_planner_skill_unavailable");
      const budget = normalizeGroupBudget(planContext?.budget);
      let suggestion, planDraft;
      try {
        if (signal?.aborted) throw failure("agent_turn_canceled");
        // One canonical attempt per request. Validation never synthesizes steps
        // or starts a second model call. Business guidance comes from the Skill.
        // Group maxTokens governs adopted execution; pre-adoption planning uses
        // the shared canonical Runtime policy instead of repurposing that field.
        const feedbackInput = { actor, session, goalId: planContext?.goalId, goalRevision: planContext?.goalRevision };
        const reviewerFeedback = resolveReviewerFeedback ? await resolveReviewerFeedback(feedbackInput) : null;
        const assertFeedback = async () => {
          if (reviewerFeedback && groupContentDigest(await resolveReviewerFeedback(feedbackInput)) !== groupContentDigest(reviewerFeedback)) {
            throw failure("group_rework_source_invalid");
          }
        };
        if (signal?.aborted) throw failure("agent_turn_canceled");
        const message = { objective, constraints, memberCapabilityProjection: safeMembers(employees),
          reviewerGroup: planContext?.reviewerGroup || null, inputRefs: safeRefs(inputRefs),
          budget, completionConditions: planContext?.completionConditions,
          resourceScope: planContext?.resourceScope || [], ...(reviewerFeedback ? { reviewerFeedback } : {}) };
        const result = await runAgentTurn({ session, employeeId: planner.id, requestId,
          message: JSON.stringify(message), outputFormat: plannerOutputFormat({ reviewerRequired: Boolean(planContext?.reviewerGroup) }), signal,
          conversationScope: plannerConversationScope(planContext) });
        if (signal?.aborted) throw failure("agent_turn_canceled");
        await assertFeedback();
        if (signal?.aborted) throw failure("agent_turn_canceled");
        suggestion = parseSuggestion(result?.text);
        planDraft = await normalizeSuggestedDraft({ suggestion, planContext, inputRefs, actor, session, createInstructionReference, authorizeDraft: assertFeedback, signal, requestId });
        await assertFeedback();
        if (signal?.aborted) throw failure("agent_turn_canceled");
      } catch (error) {
        if (signal?.aborted) throw failure("agent_turn_canceled");
        throw error;
      }
      return Object.freeze({ contractVersion: TASK_PLANNER_AGENT_CONTRACT, suggestion: { ...suggestion, planDraft }, planDraft, planning: "agent_runtime", plannerBinding: { employeeId: planner.id, employeeVersion: planner.version }, generatedAt: now() });
    },
  });
}

function plannerConversationScope(planContext = null) {
  const goalId = String(planContext?.goalId || "").trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._:@-]{0,159}$/.test(goalId)) throw failure("task_planner_context_invalid");
  // The Group route authorizes this opaque scope from its actor-owned Goal;
  // Runtime treats it as a transport-neutral server-owned conversation key.
  return `goal:${goalId}`;
}

async function normalizeSuggestedDraft({ suggestion, planContext, inputRefs = [], actor, session, createInstructionReference, authorizeDraft, signal, requestId } = {}) {
  if (!planContext?.goalId || !planContext?.groupId || !planContext?.groupVersion) throw failure("task_planner_context_invalid");
  const members = Array.isArray(planContext.members) ? planContext.members : [];
  const selected = Array.isArray(suggestion?.planDraft?.steps) ? suggestion.planDraft.steps : [];
  if (!selected.length) throw failure("task_planner_output_invalid");
  const refs = Array.isArray(inputRefs) ? inputRefs : [];
  const instructionRef = planContext.instructionRef || planContext.objectiveRef;
  const steps = selected.map((step) => {
    const member = members.find((candidate) => candidate.employeeId === step.employeeId && candidate.employeeVersion === step.employeeVersion);
    if (!member) throw failure("task_planner_member_recommendation_invalid");
    if (typeof step.instruction !== "string" || !step.instruction.trim() || step.instruction.length > 12000) throw failure("task_planner_instruction_invalid");
    return { contractVersion: "group-step.v1", stepId: step.stepId, employeeId: member.employeeId, employeeVersion: member.employeeVersion,
      kind: step.kind, instructionRef, dependsOn: step.dependsOn || [], optionalDependsOn: step.optionalDependsOn || [],
      inputArtifactIds: step.inputArtifactIds || [], inputRefIds: refs.map((ref) => ref.refId), required: step.required !== false,
      completionConditions: step.completionConditions || planContext.completionConditions || ["step-completed"], reworkOfStepId: step.reworkOfStepId || null,
      round: step.round || 0, outputScope: step.outputScope || "group" };
  });
  // Validate the whole graph before writing instruction entries. The objective
  // reference is provisional here; every executed step receives its own model
  // instruction reference below, with no objective-as-assignment fallback.
  const draft = normalizeGroupPlanDraft({ contractVersion: "group-plan-draft.v1", ...planContext.scope, goalId: planContext.goalId, goalRevision: planContext.goalRevision, groupId: planContext.groupId, groupVersion: planContext.groupVersion, planId: `draft_${planContext.goalId}_${planContext.groupVersion}`, revision: 0, instructionRevision: planContext.goalRevision, idempotencyKey: `draft_${planContext.goalId}_${planContext.groupVersion}`, steps, resourceScope: planContext.resourceScope || [], inputRefs: refs, budget: planContext.budget, completionConditions: planContext.completionConditions || ["summary-completed"], ...(planContext.reviewerGroup ? { reviewerGroup: planContext.reviewerGroup } : {}) });
  const referencedSteps = [];
  for (const [index, step] of draft.steps.entries()) {
    await authorizeDraft();
    if (signal?.aborted) throw failure("agent_turn_canceled");
    const reference = await createInstructionReference({ actor, session, goalId: draft.goalId, stepId: step.stepId, requestId, instruction: selected[index].instruction });
    referencedSteps.push({ ...step, instructionRef: reference });
  }
  if (signal?.aborted) throw failure("agent_turn_canceled");
  return normalizeGroupPlanDraft({ ...draft, steps: referencedSteps });
}

function plannerOutputFormat({ reviewerRequired = false } = {}) {
  const identifier = { type: "string", pattern: GROUP_IDENTIFIER_PATTERN };
  const stepProperties = {
    stepId: identifier, employeeId: identifier, employeeVersion: identifier,
    instruction: { type: "string", minLength: 1, maxLength: 12000, description: "The specific assignment and expected deliverable for this step, including how relevant predecessor outputs should be used." },
    kind: { type: "string", enum: ["delegate", "consult", "review", "summary"] },
    dependsOn: { type: "array", items: identifier }, required: { type: "boolean" },
  };
  const stepSchema = reviewerRequired ? {
    anyOf: [
      { type: "object", additionalProperties: false,
        required: ["stepId", "employeeId", "employeeVersion", "kind", "dependsOn", "required", "instruction"],
        properties: { ...stepProperties, kind: { type: "string", enum: ["review", "summary"] }, required: { type: "boolean", const: true } } },
      { type: "object", additionalProperties: false,
        required: ["stepId", "employeeId", "employeeVersion", "kind", "dependsOn", "required", "instruction"],
        properties: { ...stepProperties, kind: { type: "string", enum: ["delegate", "consult"] } } },
    ],
  } : {
    type: "object", additionalProperties: false,
    required: ["stepId", "employeeId", "employeeVersion", "kind", "dependsOn", "required", "instruction"],
    properties: stepProperties,
  };
  return {
    type: "json_schema", name: "task_planner_suggestion", strict: true,
    schema: {
      type: "object", additionalProperties: false,
      required: ["goalUnderstanding", "memberRecommendations", "executionShape", "reviewerRecommendation", "capabilityGapSuggestions", "planDraft"],
      properties: {
        goalUnderstanding: { type: "string" },
        memberRecommendations: { type: "array", items: { type: "object", additionalProperties: false, required: ["employeeId", "assignment", "reason"], properties: { employeeId: { type: "string" }, assignment: { type: "string" }, reason: { type: "string" } } } },
        executionShape: { type: "string", enum: ["sequential", "parallel_join"] },
        reviewerRecommendation: { type: "array", items: { type: "string" } },
        capabilityGapSuggestions: { type: "array", items: { type: "string" } },
        planDraft: {
          type: "object", additionalProperties: false, required: ["steps"],
          properties: {
            steps: { type: "array", items: stepSchema },
          },
        },
      },
    },
  };
}

function parseSuggestion(text) {
  if (text && typeof text === "object" && !Array.isArray(text)) return text;
  try {
    const parsed = JSON.parse(String(text || ""));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("invalid");
    return parsed;
  } catch {
    throw failure("task_planner_output_invalid");
  }
}

function safeMembers(members) {
  return (Array.isArray(members) ? members : []).map((member) => ({
    employeeId: String(member?.employeeId || member?.id || "").slice(0, 160),
    employeeVersion: String(member?.employeeVersion || member?.version || "").slice(0, 160),
    name: String(member?.name || "").slice(0, 160),
    title: String(member?.title || "").slice(0, 240),
    objective: String(member?.objective || "").slice(0, 600),
    capabilities: Array.isArray(member?.capabilities) ? member.capabilities.slice(0, 12) : [],
    skills: Array.isArray(member?.skills) ? member.skills.slice(0, 12) : [],
    tools: Array.isArray(member?.tools) ? member.tools.slice(0, 12) : [],
  })).filter((member) => member.employeeId && member.employeeVersion);
}

function safeRefs(refs) {
  return (Array.isArray(refs) ? refs : []).map((ref) => ({ kind: String(ref?.kind || "input_ref").slice(0, 80), refId: String(ref?.refId || "").slice(0, 160) })).filter((ref) => ref.refId);
}

function failure(code) { const error = new Error(code); error.code = code; return error; }

export { TASK_PLANNER_AGENT_CONTRACT };
