import { assertGroupScope, groupContentDigest, groupContractError, groupId } from "./group-contracts-v1.mjs";
import { readGroupReworkSource } from "./group-rework-source.mjs";

const LIST_NAME = "list_group_artifacts";
const READ_NAME = "read_group_artifact";
const READ_INPUT_NAME = "read_group_input_artifact";
const MAX_LIST = 32;
const MAX_TEXT_BYTES = 256 * 1024;

// Group-published output is a governed capability of the active GroupRun. The
// executor derives every source task/employee from the canonical run+plan and
// uses the existing Artifact handle verifier; callers cannot supply a task,
// run, path, or source employee identity.
export function createGroupPublishedArtifactToolExecutor({
  contextResolver,
  taskArtifactService,
  taskRepository,
  authorizeSourceStep = null,
  actor,
  session = null,
  task,
  context,
} = {}) {
  if (typeof contextResolver?.resolve !== "function" ||
    typeof taskArtifactService?.resolveDownload !== "function" ||
    typeof taskRepository?.listArtifacts !== "function" ||
    typeof taskRepository?.get !== "function" ||
    typeof taskRepository?.groups?.readRun !== "function" || typeof taskRepository?.groups?.readPlan !== "function" ||
    typeof taskRepository?.groups?.readGoal !== "function" || !actor || !task || !context) return null;
  const privateAgentResults = new WeakMap();

  function definitions() {
    return [
      { type: "function", name: LIST_NAME, description: "列出当前 GroupRun 和明确返工来源中已发布给组内成员的文本产出物，以及当前步骤明确声明的可复用输入。来源、运行、计划和成员范围由 Center 校验。", strict: true,
        parameters: { type: "object", properties: {}, required: [], additionalProperties: false } },
      { type: "function", name: READ_INPUT_NAME, description: "读取当前步骤明确声明的可复用文本产物。使用 list_group_artifacts 返回的 reusableInputs.grantId；不接受旧任务或文件路径。", strict: true,
        parameters: { type: "object", properties: { grantId: { type: "string", minLength: 1, maxLength: 160 } }, required: ["grantId"], additionalProperties: false } },
      { type: "function", name: READ_NAME, description: "读取 list_group_artifacts 列出的组内已发布文本产出物，包括当前轮或明确返工来源。只能读取 Center 已验证的 Artifact。", strict: true,
        parameters: { type: "object", properties: { artifactId: { type: "string", minLength: 1, maxLength: 200 } }, required: ["artifactId"], additionalProperties: false } },
    ];
  }

  async function authorizeCurrent() {
    const current = await contextResolver.resolve({ task, actor, session });
    if (!current || current.runId !== context.runId || current.planId !== context.planId ||
      current.planRevision !== context.planRevision || current.stepId !== context.stepId) {
      throw groupContractError("group_execution_context_changed");
    }
    // The shared execution context intentionally contains pinned references,
    // not mutable Run bindings. Read those only from their canonical owner.
    const run = taskRepository.groups.readRun(actor, current.runId);
    const plan = taskRepository.groups.readPlan(actor, current.planId, current.planRevision);
    if (!run || !plan || run.runId !== current.runId || run.planId !== current.planId ||
        run.planRevision !== current.planRevision || plan.planId !== current.planId || plan.revision !== current.planRevision ||
        run.activation !== "active" || run.cancelRequested) throw groupContractError("group_execution_context_changed");
    return { ...current, run, plan };
  }

  async function sources(current) {
    let rework;
    try {
      rework = readGroupReworkSource({ groups: taskRepository.groups, actor,
        goalId: current.run.goalId, goalRevision: current.run.goalRevision });
    } catch (error) {
      if (error?.code !== "group_rework_source_invalid") throw error;
      // Retiring the old source removes cross-round access, not this Run's outputs.
    }
    const rounds = [{ run: current.run, plan: current.plan, rework: false },
      ...(rework ? [{ run: rework.run, plan: rework.plan, rework: true }] : [])];
    const result = [];
    for (const round of rounds) {
      const byStep = new Map(round.plan.steps.map((step) => [step.stepId, step]));
      for (const binding of round.run.stepBindings) {
        const sourceStep = byStep.get(binding.stepId);
        if (!sourceStep || sourceStep.outputScope !== "group") continue;
        const sourceTask = taskRepository.get(binding.taskId, { tenantScope: actor.tenantScope });
        if (!sourceTask || sourceTask.status !== "completed" || sourceTask.cancelRequested || sourceTask.employeeId !== sourceStep.employeeId ||
          String(sourceTask.employeeVersion) !== String(sourceStep.employeeVersion) || binding.round !== sourceStep.round) continue;
        if (round.rework) {
          if (["tenantScope", "actorIssuer", "actorSubjectDigest"].some(key => sourceTask[key] !== actor[key])) continue;
          const key = groupContentDigest({ tenantScope: actor.tenantScope, actorIssuer: actor.actorIssuer,
            actorSubjectDigest: actor.actorSubjectDigest, runId: round.run.runId, planId: round.plan.planId,
            planRevision: round.plan.revision, stepId: sourceStep.stepId, round: sourceStep.round });
          if (sourceTask.taskId !== `group_task_${key}` || sourceTask.idempotencyKey !== key || sourceTask.sessionId !== null ||
              sourceTask.taskType !== "group_step" || sourceTask.sourceSystemId !== "group_studio" ||
              sourceTask.submissionScope !== `group:${round.run.runId}` || sourceTask.inputDigest !== groupContentDigest(sourceStep) ||
              groupContentDigest(sourceTask.executionInputRef) !== groupContentDigest(sourceStep.instructionRef) ||
              typeof authorizeSourceStep !== "function" || await authorizeSourceStep({ actor, session, step: sourceStep, task: sourceTask }) !== true) {
            continue;
          }
        }
        result.push(...taskRepository.listArtifacts({ tenantScope: actor.tenantScope, taskId: sourceTask.taskId })
          .filter((artifact) => artifact?.expiresAt && Date.parse(artifact.expiresAt) > Date.now())
          .slice(0, MAX_LIST).map((artifact) => ({ artifact, sourceTask, sourceStep, binding, sourceRunId: round.run.runId })));
      }
    }
    return result;
  }

  function inputGrants(current) {
    const step = current.plan.steps.find(item => item.stepId === current.stepId);
    if (!step) throw groupContractError("group_execution_context_changed");
    return (step.inputArtifactIds || []).map(grantId => {
      groupId(grantId);
      if (!current.plan.resourceScope?.includes(grantId) || typeof taskRepository.readReusableArtifactGrant !== "function") throw groupContractError("group_artifact_not_available");
      const record = taskRepository.readReusableArtifactGrant({ ...actor, grantId, now: new Date() });
      if (!record?.grant || !record.artifact) throw groupContractError("group_artifact_not_available");
      assertGroupScope(record.grant, actor);
      if (record.grant.grantId !== grantId) throw groupContractError("group_artifact_not_available");
      return record;
    });
  }

  async function readInput(current, args, signal) {
    if (!args || Object.keys(args).some(key => key !== "grantId")) return blocked("group_artifact_not_available");
    const grantId = groupId(args.grantId);
    const source = inputGrants(current).find(item => item.grant.grantId === grantId);
    if (!source || typeof taskArtifactService.resolveReusableArtifact !== "function") return blocked("group_artifact_not_available");
    if (!["text/plain", "text/markdown"].includes(source.artifact.mimeType)) return blocked("group_artifact_type_unsupported");
    const lookup = { ...actor, grantId };
    const resolved = await taskArtifactService.resolveReusableArtifact(lookup);
    let content;
    try {
      if (signal?.aborted) return blocked("agent_turn_canceled");
      content = await readBoundedText(resolved.handle, MAX_TEXT_BYTES);
    } finally { await resolved.handle.close(); }
    const latest = await authorizeCurrent();
    if (!inputGrants(latest).some(item => item.grant.grantId === grantId && item.artifact.artifactId === resolved.artifact.artifactId)) return blocked("group_artifact_not_available");
    // Recheck the canonical grant and immutable object after asynchronous reads.
    const checked = await taskArtifactService.resolveReusableArtifact(lookup);
    try {
      if (checked.artifact.sha256 !== resolved.artifact.sha256) return blocked("group_artifact_not_available");
    } finally { await checked.handle.close(); }
    const final = await authorizeCurrent();
    if (!inputGrants(final).some(item => item.grant.grantId === grantId && item.artifact.artifactId === resolved.artifact.artifactId)) return blocked("group_artifact_not_available");
    if (signal?.aborted) return blocked("agent_turn_canceled");
    const safe = { ok: true, status: "group_artifact_read", toolId: "group-published-artifacts", grantId,
      bytes: Buffer.byteLength(content, "utf8"), truncated: Buffer.byteLength(content, "utf8") >= MAX_TEXT_BYTES };
    privateAgentResults.set(safe, { ...safe, content });
    return safe;
  }

  async function execute(toolCall = {}, { signal = null } = {}) {
    if (signal?.aborted) return blocked("agent_turn_canceled");
    if (toolCall.name !== LIST_NAME && toolCall.name !== READ_NAME && toolCall.name !== READ_INPUT_NAME) return blocked("tool_not_allowed");
    try {
      const current = await authorizeCurrent();
      if (signal?.aborted) return blocked("agent_turn_canceled");
      if (toolCall.name === READ_INPUT_NAME) return await readInput(current, toolCall.arguments, signal);
      let available = await sources(current);
      if (toolCall.name === LIST_NAME) {
        available = await sources(await authorizeCurrent());
        await authorizeCurrent();
        if (signal?.aborted) return blocked("agent_turn_canceled");
        const safe = { ok: true, status: "group_artifacts_listed", toolId: "group-published-artifacts", reusableInputs: inputGrants(current).map(({ grant, artifact }) => ({ grantId: grant.grantId, fileName: artifact.fileName, mimeType: artifact.mimeType, sizeBytes: artifact.sizeBytes, expiresAt: grant.expiresAt })), artifacts: available.map(({ artifact, sourceStep, sourceRunId }) => ({
          artifactId: artifact.artifactId, fileName: artifact.fileName, mimeType: artifact.mimeType,
          sizeBytes: artifact.sizeBytes, createdAt: artifact.createdAt, expiresAt: artifact.expiresAt,
          sourceStepId: sourceStep.stepId, sourceRunId,
        })) };
        return safe;
      }
      const artifactId = String(toolCall.arguments?.artifactId || "").trim();
      const source = available.find((item) => item.artifact.artifactId === artifactId);
      if (!source) return blocked("group_artifact_not_available");
      if (!["text/plain", "text/markdown"].includes(source.artifact.mimeType)) return blocked("group_artifact_type_unsupported");
      const resolved = await taskArtifactService.resolveDownload({
        tenantScope: actor.tenantScope, taskId: source.sourceTask.taskId, artifactId,
        actorIssuer: actor.actorIssuer, actorSubjectDigest: actor.actorSubjectDigest,
        employeeId: source.sourceStep.employeeId,
      });
      if (signal?.aborted) { await resolved.handle.close().catch(() => {}); return blocked("agent_turn_canceled"); }
      let content;
      try { content = await readBoundedText(resolved.handle, MAX_TEXT_BYTES); }
      finally { await resolved.handle.close(); }
      const latest = await authorizeCurrent();
      if (signal?.aborted) return blocked("agent_turn_canceled");
      const stillAvailable = (await sources(latest)).some((item) => item.artifact.artifactId === artifactId && item.sourceTask.taskId === source.sourceTask.taskId);
      if (!stillAvailable) return blocked("group_artifact_not_available");
      const checked = await taskArtifactService.resolveDownload({ ...actor, taskId: source.sourceTask.taskId,
        artifactId, employeeId: source.sourceStep.employeeId });
      await checked.handle.close();
      if (checked.artifact.artifactId !== resolved.artifact.artifactId || checked.artifact.taskId !== resolved.artifact.taskId ||
          checked.artifact.sha256 !== resolved.artifact.sha256) return blocked("group_artifact_not_available");
      if (!(await sources(await authorizeCurrent())).some(item => item.artifact.artifactId === artifactId &&
          item.sourceTask.taskId === source.sourceTask.taskId) || signal?.aborted) return blocked("group_artifact_not_available");
      const safe = { ok: true, status: "group_artifact_read", toolId: "group-published-artifacts", artifactId,
        bytes: Buffer.byteLength(content, "utf8"), truncated: Buffer.byteLength(content, "utf8") >= MAX_TEXT_BYTES };
      privateAgentResults.set(safe, { ...safe, content });
      return safe;
    } catch (error) {
      const code = ["group_execution_context_changed", "group_artifact_not_available", "artifact_not_found", "artifact_task_not_completed", "artifact_expired", "artifact_object_integrity_invalid", "agent_turn_canceled"].includes(error?.code)
        ? error.code : "group_artifact_unavailable";
      return blocked(code);
    }
  }

  return Object.freeze({
    toolDefinitions: definitions,
    execute,
    agentResultFor: (result) => privateAgentResults.get(result) || result,
    safeToolCatalog: () => definitions().map((definition) => ({ name: definition.name, toolId: "group-published-artifacts", displayName: definition.name === LIST_NAME ? "列出组内发布产出" : definition.name === READ_INPUT_NAME ? "读取已授权输入产物" : "读取组内发布产出" })),
    safeActivityDescriptor: (toolCall, { result = null } = {}) => {
      const actionCode = toolCall?.name === LIST_NAME ? "group.artifact.list" :
        toolCall?.name === READ_INPUT_NAME ? "group.input.read" : "group.artifact.read";
      const sourceId = toolCall?.name === READ_INPUT_NAME ? result?.grantId : result?.artifactId;
      const completedRead = toolCall?.name !== LIST_NAME && result?.ok === true &&
        result.status === "group_artifact_read" && result.truncated === false && sourceId &&
        sourceId === (toolCall?.name === READ_INPUT_NAME ? toolCall.arguments?.grantId : toolCall.arguments?.artifactId);
      return { actionCode, kind: "tool", subjectId: "group-published-artifacts",
        ...(completedRead ? { operationCode: `source.${groupContentDigest({ actionCode, sourceId })}`, operationDisplayAllowed: true } : {}) };
    },
  });
}

async function readBoundedText(handle, maxBytes) {
  const stat = await handle.stat();
  if (!stat.isFile() || stat.size <= 0) throw groupContractError("group_artifact_unavailable");
  const bytes = Math.min(stat.size, maxBytes);
  const buffer = Buffer.alloc(bytes);
  let offset = 0;
  while (offset < bytes) {
    const { bytesRead } = await handle.read(buffer, offset, bytes - offset, offset);
    if (!bytesRead) break;
    offset += bytesRead;
  }
  return buffer.subarray(0, offset).toString("utf8");
}

function blocked(code) {
  return { ok: false, status: "blocked", toolId: "group-published-artifacts", error: code };
}
