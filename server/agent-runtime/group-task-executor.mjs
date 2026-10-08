import { safeGroupExecutionErrorCode } from "./group-execution-errors.mjs";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { assembleDigitalEmployeeDependencyContext } from "./dependency-context.mjs";
import { groupContentDigest } from "./group-contracts-v1.mjs";
import { resolveGroupReviewerSkill } from "./group-reviewer-skill-binding.mjs";
import { publishTaskOutputArtifacts } from "./task-artifact-publication.mjs";

const GROUP_TASK_EXECUTOR_CONTRACT = "group-task-executor.v1";


const REVIEW_OUTPUT_FORMAT = Object.freeze({
  type: "json_schema", name: "group_review_result", strict: true,
  schema: { type: "object", additionalProperties: false, required: ["decision", "opinionSummary"], properties: {
    decision: { type: "string", enum: ["approved", "rejected"] },
    opinionSummary: { type: "string", minLength: 1, maxLength: 4000 },
  } },
});

// An ingress adapter to the shared Agent service, never a second execution loop.
export function createGroupTaskExecutor({ contextResolver, agentExecutionService, getBusinessSkills,
  providerLeaseResolver, recoverAdmission, resolveInputs, createToolExecutor,
  taskArtifactService, workspaceManager, now = () => new Date(), maxOutputTokens = 1800 } = {}) {
  for (const [value, method] of [[contextResolver, "resolve"], [agentExecutionService, "buildPrompt"],
    [agentExecutionService, "execute"], [taskArtifactService, "publishOutputArtifact"], [workspaceManager, "workspaceForTask"]]) {
    if (typeof value?.[method] !== "function") throw new TypeError(`group executor requires ${method}`);
  }
  if (![getBusinessSkills, providerLeaseResolver, recoverAdmission, resolveInputs, now].every(fn => typeof fn === "function")) {
    throw new TypeError("group executor requires governed admission and input services");
  }
  async function authorize(task, ownership) {
    if (ownership?.isCancellationRequested?.() || ownership?.signal?.aborted) throw failure("agent_turn_canceled");
    ownership.refreshCurrentLease();
    const identity = await recoverAdmission(task);
    const context = await contextResolver.resolve({ task, actor: identity.actor, session: identity.session });
    if (!context || identity.employee?.id !== task.employeeId || String(identity.employee.version) !== task.employeeVersion) {
      throw failure("execution_task_input_employee_version_changed");
    }
    return { identity, context };
  }
  return Object.freeze({
    contractVersion: GROUP_TASK_EXECUTOR_CONTRACT,
    async execute(task, ownership) {
      let toolExecutor = null;
      try {
        const { identity, context } = await authorize(task, ownership);
        const inputs = await resolveInputs({ context, task, session: identity.session });
        if (!validText(inputs?.objectiveText)) throw failure("group_objective_reference_invalid");
        if (!validText(inputs?.instructionText)) throw failure("group_instruction_reference_invalid");
        if (groupContentDigest({ objective: inputs.objectiveText }) !== context.objectiveDigest) throw failure("group_objective_digest_mismatch");
        const employee = identity.employee;
        const skills = getBusinessSkills({ task });
        const organizationSkill = resolveGroupReviewerSkill({ binding: context.reviewerSkillBinding, skills });
        const dependencyContext = assembleDigitalEmployeeDependencyContext({
          businessSkills: context.reviewerSkillBinding && !organizationSkill
            ? skills.filter(skill => skill.id !== context.reviewerSkillBinding.skillId) : skills,
          employee,
          organizationSkillIds: context.reviewerSkillBinding ? [context.reviewerSkillBinding.skillId] : [],
          channel: { channel: task.channelId, sourceSystemId: task.sourceSystemId, status: "active", receiveMode: "group" },
        });
        toolExecutor = createToolExecutor ? await createToolExecutor({ employee, identity, context, task, ownership, dependencyContext }) : null;
        if (!toolExecutor && dependencyContext.declaredTools.length) throw failure("group_execution_tools_unavailable");
        const lease = await providerLeaseResolver({ employee, runtimeTask: task });
        if (!lease) throw failure("execution_task_provider_unavailable");
        const prepared = await authorize(task, ownership);
        if (groupContentDigest(context) !== groupContentDigest(prepared.context)) throw failure("group_execution_context_changed");
        const prompt = agentExecutionService.buildPrompt({
          conversationHistory: [], dependencyContext, employeeIdentity: dependencyContext.employee, lease,
          authorizeSkillRead: async ({ skillId, version }) => {
            const latest = await authorize(task, ownership);
            if (groupContentDigest(context) !== groupContentDigest(latest.context)) return false;
            if (context.reviewerSkillBinding?.skillId === skillId) {
              return Boolean(resolveGroupReviewerSkill({ binding: context.reviewerSkillBinding, skills: getBusinessSkills({ task }) }));
            }
            const current = assembleDigitalEmployeeDependencyContext({ employee: latest.identity.employee, getBusinessSkills, runtimeTask: task });
            return current.callableSkills.some(skill => skill.id === skillId && skill.version === version);
          },
          maxOutputTokens: Math.min(maxOutputTokens, context.budget.maxTokens),
          references: inputs.references || [],
          runtimeContext: { currentTurn: { text: `${inputs.objectiveText}\n\n${inputs.instructionText}` } },
          safeContext: { groupRunId: context.runId, groupPlanId: context.planId, groupStepId: context.stepId },
          stream: false, toolExecutor,
          ...(context.stepKind === "review" ? { outputFormat: REVIEW_OUTPUT_FORMAT } : {}),
        });
        const result = await agentExecutionService.execute({ lease, prompt, runtimeTask: task, signal: ownership.signal, toolExecutor });
        if (result?.reason === "agent_turn_canceled") throw failure("agent_turn_canceled");
        if (result?.partial) throw failure("execution_task_partial_result");
        if (!validText(result?.text)) throw failure("group_execution_output_invalid");
        let reviewDecision = null;
        if (context.stepKind === "review") {
          let verdict;
          try { verdict = JSON.parse(result.text); } catch { throw failure("group_review_result_invalid"); }
          if (!verdict || typeof verdict !== "object" || Array.isArray(verdict) ||
              Object.keys(verdict).some(key => !["decision", "opinionSummary"].includes(key)) ||
              !["approved", "rejected"].includes(verdict.decision) || typeof verdict.opinionSummary !== "string" ||
              !verdict.opinionSummary.trim() || verdict.opinionSummary.length > 4000) throw failure("group_review_result_invalid");
          reviewDecision = verdict.decision;
        }
        const latest = await authorize(task, ownership);
        if (groupContentDigest(context) !== groupContentDigest(latest.context)) throw failure("group_execution_context_changed");
        const workspace = await workspaceManager.workspaceForTask(task.taskId, { create: true });
        // The file is a deliverable, never an audit summary or Group metadata.
        await writeFile(path.join(workspace.outputRoot, "group-result.md"), result.text, { encoding: "utf8", flag: "wx", mode: 0o600 });
        const artifacts = await publishTaskOutputArtifacts({
          artifacts: [{ relativePath: "group-result.md" }], executionOwnership: ownership,
          taskArtifactService, now,
        });
        if (artifacts.length !== 1) throw failure("artifact_publication_unavailable");
        return { settlement: { status: reviewDecision === "rejected" ? "failed" : "completed",
          lastErrorCode: reviewDecision === "rejected" ? "group_review_rejected" : null,
          resultSummary: reviewDecision === "rejected" ? "Group review rejected; opinion Artifact published." : "Group step deliverable published.",
          terminalEvidenceDigest: groupContentDigest(artifacts) } };
      } catch (error) {
        const observedCode = /^[a-z][a-z0-9_]{0,100}$/.test(String(error?.code || "")) ? String(error.code) : "unknown";
        const safeCode = safeGroupExecutionErrorCode(observedCode);
        console.warn("[group-execution]", safeCode);
        throw failure(safeCode);
      } finally {
        try { await toolExecutor?.dispose?.(); }
        catch { console.warn("[group-execution]", "group_tool_cleanup_failed"); }
      }
    },
  });
}
function validText(text) { return typeof text === "string" && Boolean(text.trim()) && Buffer.byteLength(text, "utf8") <= 1024 * 1024; }
function failure(code) { const error = new Error(code); error.code = code; return error; }
export { GROUP_TASK_EXECUTOR_CONTRACT };
