export const agentPreReviewBlockingStatuses = new Set(["failed", "blocked"]);
export const agentPreReviewReadyStatuses = new Set(["completed", "completed_with_findings"]);
const maxRuntimeInstructionChars = 64 * 1024;
const maxRuntimeReferenceChars = 32 * 1024;
const maxRuntimeReferencesPerSkill = 8;

export function createSkillAgentPreReviewService({
  cleanList,
  cleanText,
  draftId,
  initialExecutions = {},
  initialQualityEvents = {},
  preReviewWorkers = [],
  getPreReviewWorkers = () => preReviewWorkers,
}) {
  const executions = new Map(Object.entries(initialExecutions || {}));
  const qualityEvents = new Map(Object.entries(initialQualityEvents || {}));

  function ensure(draft) {
    const existing = executions.get(agentPreReviewKey(draft));
    if (existing) {
      draft.agentPreReview = existing;
      return existing;
    }
    const execution = run(draft);
    draft.agentPreReview = execution;
    return execution;
  }

  function run(draft, { force = false, requestedBy = "" } = {}) {
    const key = agentPreReviewKey(draft);
    const existing = executions.get(key);
    if (existing && !force) return existing;
    const workers = getPreReviewWorkers();
    const workerById = new Map(workers.map((worker) => [worker.id, worker]));
    const workerByLane = new Map(workers.map((worker) => [worker.lane, worker]));
    const worker = workerById.get("external-agent-precheck") || workerByLane.get("external_agent_precheck") || workers[0];
    const startedAt = new Date().toISOString();
    const executionId = draftId("AGPRE", `${draft.jobId}-${draft.draftId}-${force ? "rerun" : "auto"}`);
    const risk = skillAgentRisk(draft);
    const status = risk.failure ? "failed" : risk.blocking ? "blocked" : risk.errorCode ? "completed_with_findings" : "completed";
    const reviewDraftTitle = cleanText(draft.name || draft.skillId || "");
    const execution = {
      executionId,
      contractVersion: "skill-agent-pre-review.v1",
      status,
      progressPercent: status === "failed" ? risk.failureProgress : 100,
      progressLabel: status === "failed" ? "执行失败" : status === "blocked" ? "阻断待复核" : status === "completed_with_findings" ? "完成但需复核" : "完成",
      progressSegments: agentPreReviewStages(risk),
      workerId: worker?.id || "external-agent-precheck",
      workerName: worker?.name || "外部 Agent 预审 Worker",
      workerEmployeeId: worker?.ownerEmployeeId || "external-agent-registry-agent",
      lane: worker?.lane || "external_agent_precheck",
      agentEmployeeId: worker?.ownerEmployeeId || "external-agent-registry-agent",
      provider: worker?.provider || "codex",
      model: worker?.model || "gpt-5.5",
      reasoningEffort: worker?.reasoningEffort || "high",
      credentialLease: {
        mode: "server_side_runtime_lease",
        provider: worker?.provider || "codex",
        leaseRef: `lease://ai/${worker?.provider || "codex"}/runtime/${executionId}`,
        credentialVisibleToBrowser: false,
      },
      startedAt,
      completedAt: status === "failed" ? "" : new Date().toISOString(),
      requestedBy,
      rerun: force,
      reviewDraftTitle,
      recommendation: risk.recommendation,
      confidence: risk.confidence,
      riskLevel: risk.riskLevel,
      errorCode: risk.errorCode,
      errorDomain: risk.errorDomain,
      rootCauseCategory: risk.rootCauseCategory,
      safeFindings: risk.findings,
      missingItems: risk.missingItems,
      nextGate: risk.nextGate,
      qualityRoute: risk.qualityRoute,
      qualityEvent: null,
      expectedOutputs: ["结构化评审稿", "包读取摘要", "输入输出与工具边界", "缺口清单", "推荐结论", "下一步审核门禁"],
      reviewDraft: buildReviewDraft(draft, risk, {
        executionId,
        reviewDraftTitle,
        status,
        progressLabel: status === "failed" ? "执行失败" : status === "blocked" ? "阻断待复核" : status === "completed_with_findings" ? "完成但需复核" : "完成",
      }),
      privacyBoundary: "Agent pre-review stores safe summary metadata only. Raw prompts, package payloads, generated outputs, model traces, provider keys, customer data, and employee PII are not stored.",
    };
    execution.qualityEvent = recordQualityEvent(draft, execution, risk);
    executions.set(key, execution);
    return execution;
  }

  function listQualityEvents() {
    return [...qualityEvents.values()].sort((left, right) =>
      String(right.updatedAt || right.createdAt).localeCompare(String(left.updatedAt || left.createdAt)),
    );
  }

  function summarizeForReview(agentPreReview) {
    if (!agentPreReview) return null;
    return {
      executionId: agentPreReview.executionId,
      status: agentPreReview.status,
      progressPercent: agentPreReview.progressPercent,
      workerId: agentPreReview.workerId,
      lane: agentPreReview.lane,
      provider: agentPreReview.provider,
      model: agentPreReview.model,
      leaseRef: agentPreReview.credentialLease?.leaseRef || "",
      recommendation: agentPreReview.recommendation,
      errorCode: agentPreReview.errorCode,
      qualityRoute: agentPreReview.qualityRoute || null,
      reviewDraft: agentPreReview.reviewDraft || null,
    };
  }

  function snapshot() {
    return {
      executions: Object.fromEntries(executions.entries()),
      qualityEvents: Object.fromEntries(qualityEvents.entries()),
    };
  }

  function restore(state = {}) {
    executions.clear();
    qualityEvents.clear();
    Object.entries(state.executions || {}).forEach(([key, execution]) => executions.set(key, execution));
    Object.entries(state.qualityEvents || {}).forEach(([key, event]) => qualityEvents.set(key, event));
  }

  function recordQualityEvent(draft, execution, risk) {
    const sourceEventId = `skill-agent-pre-review:${draft.jobId || "unknown-job"}:${draft.draftId || draft.skillId || "unknown-draft"}`;
    if (!execution?.qualityRoute || !execution.errorCode) {
      const existing = qualityEvents.get(sourceEventId);
      if (existing) return closeQualityEvent(existing, draft, execution);
      if (draft.promptGovernance?.promptMetadataAutoCompleted) {
        return recordAutoClosedPromptMetadataEvent(draft, execution, sourceEventId);
      }
      return null;
    }
    const event = {
      id: draftId("AQE", `${execution.errorCode}-${draft.skillId || draft.draftId || "skill"}`),
      contractVersion: "quality-event.safe-summary.v1",
      sourceSystemId: "digital-workforce",
      sourceSystemName: "数字员工管理系统",
      sourceEventId,
      eventType: execution.qualityRoute.eventType || "agent_pre_review_findings",
      departmentId: cleanText(draft.targetDepartmentId || "digital-office"),
      businessDomain: "skill_governance",
      entityType: "business_skill",
      entityId: cleanText(draft.skillApiId || draft.skillId || draft.draftId),
      entityName: cleanText(draft.name || draft.skillId || draft.draftId),
      entityVersion: cleanText(draft.versionIntent || "draft"),
      promptVersion: cleanText(draft.promptGovernance?.promptVersion || ""),
      severity: risk.failure || risk.blocking ? "P1" : "P2",
      status: risk.failure || risk.blocking ? "待质量复盘" : "待评审确认",
      errorDomain: risk.errorDomain || "quality",
      errorCode: execution.errorCode,
      rootCauseCategory: risk.rootCauseCategory || "pending_analysis",
      resolutionAction: risk.failure ? "rerun_agent_pre_review" : risk.blocking ? "complete_skill_contract" : "manual_quality_review",
      evidenceSummary: [
        `${execution.workerName || execution.workerId} 对外部 Skill 安全摘要完成 Agent 预审核。`,
        execution.progressLabel ? `进度：${execution.progressLabel} ${execution.progressPercent}%。` : "",
        (risk.findings || []).join("；"),
      ].filter(Boolean).join(" "),
      expectedSummary: "外部 Skill 发布前应具备 sourceSkillId、输入输出契约、工具声明、Prompt 指纹、运行约束和测评归口。",
      actualSummary: cleanList(risk.missingItems).length ? `缺口：${cleanList(risk.missingItems).join("；")}` : execution.progressLabel,
      evalCandidate: Boolean(execution.qualityRoute.evalCandidate),
      linkedExecutionId: execution.executionId,
      linkedReview: {
        jobId: draft.jobId,
        draftId: draft.draftId,
        skillId: draft.skillId,
        executionId: execution.executionId,
      },
      qualityRoute: execution.qualityRoute,
      createdAt: execution.startedAt,
      updatedAt: execution.completedAt || execution.startedAt,
      tags: ["platform-agent-pre-review", execution.status, execution.errorCode].filter(Boolean),
      privacyBoundary: "质量事件只保存 Agent 预审核安全摘要、错误码、缺口和归口；不保存 raw prompt、包内容、执行 payload、模型 trace、provider key、客户数据或员工 PII。",
    };
    qualityEvents.set(sourceEventId, event);
    return event;
  }

  function closeQualityEvent(existing, draft, execution) {
    const event = {
      ...existing,
      status: "已关闭",
      evalCandidate: true,
      linkedExecutionId: execution.executionId,
      linkedReview: {
        ...(existing.linkedReview || {}),
        jobId: draft.jobId,
        draftId: draft.draftId,
        skillId: draft.skillId,
        executionId: execution.executionId,
      },
      actualSummary: "最新 Agent 预审核已通过；原 P 问题关闭并作为测评回归样本保留。",
      evidenceSummary: [
        existing.evidenceSummary,
        `${execution.workerName || execution.workerId} 重跑预审核已通过，处理完毕状态记为已关闭。`,
      ].filter(Boolean).join(" "),
      updatedAt: execution.completedAt || execution.startedAt,
      tags: uniqueQualityTags([...(existing.tags || []), "resolved", "eval-candidate"]),
    };
    qualityEvents.set(existing.sourceEventId || `skill-agent-pre-review:${draft.jobId}:${draft.draftId}`, event);
    return event;
  }

  function recordAutoClosedPromptMetadataEvent(draft, execution, sourceEventId) {
    const errorCode = "PRE_SKILL_REVIEW_GAPS";
    const qualityRoute = qualityRouteForAgent(errorCode, false);
    const event = {
      id: draftId("AQE", `${errorCode}-${draft.skillId || draft.draftId || "skill"}`),
      contractVersion: "quality-event.safe-summary.v1",
      sourceSystemId: "digital-workforce",
      sourceSystemName: "数字员工管理系统",
      sourceEventId,
      eventType: "agent_pre_review_resolved",
      departmentId: cleanText(draft.targetDepartmentId || "digital-office"),
      businessDomain: "skill_governance",
      entityType: "business_skill",
      entityId: cleanText(draft.skillApiId || draft.skillId || draft.draftId),
      entityName: cleanText(draft.name || draft.skillId || draft.draftId),
      entityVersion: cleanText(draft.versionIntent || "draft"),
      promptVersion: cleanText(draft.promptGovernance?.promptVersion || ""),
      severity: "P2",
      status: "已关闭",
      errorDomain: "skill_contract",
      errorCode,
      rootCauseCategory: "missing_contract_metadata",
      resolutionAction: "manual_quality_review",
      evidenceSummary: [
        `${execution.workerName || execution.workerId} 已读取包内 ${draft.packageUnitPath || "SKILL.md"} 安全摘要。`,
        "包内未显式声明 Prompt 元数据，平台已生成安全 sha256 指纹；该 P2 处理完毕并保留为测评样本。",
      ].join(" "),
      expectedSummary: "外部 Skill 发布前应具备 Prompt 版本或指纹，并将补齐规则纳入回归测评。",
      actualSummary: `已生成 Prompt 版本 ${cleanText(draft.promptGovernance?.promptVersion || "")}，不保存 raw prompt 或包内容。`,
      evalCandidate: true,
      linkedExecutionId: execution.executionId,
      linkedReview: {
        jobId: draft.jobId,
        draftId: draft.draftId,
        skillId: draft.skillId,
        executionId: execution.executionId,
      },
      qualityRoute,
      createdAt: execution.startedAt,
      updatedAt: execution.completedAt || execution.startedAt,
      tags: ["platform-agent-pre-review", "completed", errorCode, "resolved", "eval-candidate"],
      privacyBoundary: "质量事件只保存 Agent 预审核安全摘要、错误码、缺口和归口；不保存 raw prompt、包内容、执行 payload、模型 trace、provider key、客户数据或员工 PII。",
    };
    qualityEvents.set(sourceEventId, event);
    return event;
  }

  function agentPreReviewStages(risk) {
    const failedAt = risk.failureProgress || 100;
    return [
      { id: "lease", label: "凭证租约", percent: 20, status: failedAt >= 20 ? "done" : "pending" },
      { id: "contract", label: "合同读取", percent: 40, status: failedAt >= 40 ? "done" : "pending" },
      { id: "boundary", label: "权限边界", percent: 65, status: risk.failure && failedAt <= 65 ? "failed" : failedAt >= 65 ? "done" : "pending" },
      { id: "evaluation", label: "测评归口", percent: 85, status: risk.failure && failedAt <= 85 ? "failed" : failedAt >= 85 ? "done" : "pending" },
      { id: "decision", label: "建议结论", percent: 100, status: risk.failure ? "pending" : risk.blocking ? "blocked" : "done" },
    ];
  }

  function skillAgentRisk(draft) {
    const missingItems = [];
    const packageIntake = draft.packageIntake || {};
    const packageRefWithoutManifest = packageIntake.mode === "package_reference_only" && !packageIntake.manifestParsed;
    const packageParsed = packageIntake.manifestParsed || draft.packageReadSummary?.source === "package_skill_markdown";
    if (packageRefWithoutManifest) missingItems.push("包内容未接收或未解析 SKILL.md");
    if (!draft.sourceSkillId) missingItems.push("sourceSkillId 未确认");
    if (!cleanList(draft.declaredInputs).length) missingItems.push("输入契约缺失");
    if (!cleanList(draft.declaredOutputs).length) missingItems.push("输出契约缺失");
    if (!cleanList(draft.tools).length) missingItems.push("工具声明缺失");
    if (!cleanList(draft.constraints).length) missingItems.push("运行约束缺失");
    const claimsWrite = cleanList(draft.tools).some((tool) => /write|delete|approve|publish|写入|删除|审批|发布/i.test(tool));
    const promptMissing = !draft.promptGovernance?.promptHash && !draft.promptGovernance?.promptVersion;
    if (promptMissing) missingItems.push("Prompt 指纹待确认");
    const businessGroupRecommendation = draft.businessGroupRecommendation || {};
    const businessGroupFinding = businessGroupRecommendation.label
      ? `已推荐业务组：${businessGroupRecommendation.label}（依据：${businessGroupRecommendation.rationale || businessGroupRecommendation.source || "导入解析"}，仍需人工确认）。`
      : "";

    const failure = /fail-agent|agent-fail|precheck-error/i.test(`${draft.sourceRef || ""} ${draft.name || ""}`);
    const blocking = packageRefWithoutManifest || claimsWrite || missingItems.length >= 3;
    if (failure) {
      return {
        failure: true,
        blocking: false,
        failureProgress: 65,
        errorCode: "PRE_AGENT_EXECUTION_FAILED",
        errorDomain: "agent_runtime",
        rootCauseCategory: "worker_execution_error",
        riskLevel: "高",
        confidence: 0,
        recommendation: "rerun_required",
        findings: ["Agent 预审核执行失败，需要重跑或检查 Worker/凭证租约。"],
        missingItems: ["Agent execution result"],
        nextGate: "修复 Worker/凭证或重跑 Agent 预审核后再进入人工确认。",
        qualityRoute: qualityRouteForAgent("PRE_AGENT_EXECUTION_FAILED", true),
      };
    }
    return {
      failure: false,
      blocking,
      errorCode: blocking ? "PRE_SKILL_CONTRACT_INCOMPLETE" : missingItems.length ? "PRE_SKILL_REVIEW_GAPS" : "",
      errorDomain: blocking || missingItems.length ? "skill_contract" : "",
      rootCauseCategory: blocking || missingItems.length ? "missing_contract_metadata" : "",
      riskLevel: blocking ? "高" : missingItems.length ? "中" : "低",
      confidence: blocking ? 0.68 : missingItems.length ? 0.82 : 0.93,
      recommendation: blocking ? "block_until_resolved" : missingItems.length ? "manual_review_with_findings" : "human_confirm",
      findings: [
        businessGroupFinding,
        packageParsed
          ? `已由系统级外部 Agent 预审 Worker 读取包内 ${draft.packageUnitPath || "SKILL.md"} 安全摘要，识别 Skill：${draft.name || draft.skillId}。`
          : "已由系统级外部 Agent 预审 Worker 读取安全摘要和 Skill 合同字段。",
        packageRefWithoutManifest ? "当前只有包引用或文件名，未读取到 SKILL.md；不能生成可人工通过的完整评审稿。" : "",
        claimsWrite ? "工具声明包含写入/删除/审批/发布风险，需拆分动作和回滚策略。" : "",
        missingItems.length ? "发现合同字段缺口，需人工确认或补齐后发布。" : "未发现阻断项，建议进入人工确认。",
      ].filter(Boolean),
      missingItems,
      nextGate: blocking
        ? "归入测评审核/质量复核；补齐阻断项后重跑 Agent 预审核。"
        : missingItems.length
        ? "管理员根据 Agent 发现项确认是否通过、驳回或纳入回归候选。"
        : "管理员可基于 Agent 预审核结果进行最终确认。",
      qualityRoute: missingItems.length || blocking ? qualityRouteForAgent(blocking ? "PRE_SKILL_CONTRACT_INCOMPLETE" : "PRE_SKILL_REVIEW_GAPS", blocking) : null,
    };
  }

  return {
    ensure,
    listQualityEvents,
    restore,
    run,
    snapshot,
    summarizeForReview,
  };
}

function buildReviewDraft(draft, risk, executionSummary = {}) {
  const packageIntake = draft.packageIntake || {};
  const packageReadSummary = draft.packageReadSummary || {};
  const subjectName = cleanFallback(executionSummary.reviewDraftTitle, draft.name, draft.skillId, draft.draftId);
  const subject = {
    name: subjectName,
    skillId: cleanFallback(draft.skillId, draft.skillApiId, draft.draftId),
    skillApiId: cleanFallback(draft.skillApiId, draft.skillId),
    sourceSkillId: cleanFallback(draft.sourceSkillId),
    sourceRef: cleanFallback(draft.sourceRef),
    packagePath: cleanFallback(draft.packageUnitPath),
    versionIntent: cleanFallback(draft.versionIntent),
    targetDepartmentId: cleanFallback(draft.targetDepartmentId),
    businessGroup: cleanFallback(draft.businessGroup, draft.domain, draft.businessGroupRecommendation?.label),
    businessGroupRecommendation: draft.businessGroupRecommendation || null,
  };
  const packageSummary = {
    mode: cleanFallback(packageIntake.mode),
    contentReceived: Boolean(packageIntake.contentReceived),
    unpacked: Boolean(packageIntake.unpacked),
    manifestParsed: Boolean(packageIntake.manifestParsed),
    skillUnitCount: Number(packageIntake.skillUnitCount || 0),
    skillPath: cleanFallback(draft.packageUnitPath),
    source: cleanFallback(packageReadSummary.source),
    rawContentStored: packageReadSummary.rawContentStored === true ? true : false,
    summaryText: packageIntake.manifestParsed
      ? `已读取 ${draft.packageUnitPath || "SKILL.md"} 安全摘要。`
      : packageIntake.mode === "package_reference_only"
      ? "仅收到包引用，未读取到 SKILL.md。"
      : "基于安全摘要和 Skill 合同字段生成评审稿。",
  };
  const contractFields = {
    inputs: cleanArray(draft.declaredInputs),
    outputs: cleanArray(draft.declaredOutputs),
    tools: cleanArray(draft.tools),
    constraints: cleanArray(draft.constraints),
    executionGuidance: cleanArray(draft.executionGuidance),
    runtimeInstructions: safeRuntimeInstructions(draft.runtimeInstructions),
    runtimeReferences: safeRuntimeReferences(draft.runtimeReferences),
    promptVersion: cleanFallback(draft.promptGovernance?.promptVersion),
    promptHash: cleanFallback(draft.promptGovernance?.promptHash),
    lineageRule: cleanFallback(draft.lineageRule),
  };
  const governanceFields = {
    targetDepartmentId: cleanFallback(draft.targetDepartmentId),
    businessGroup: cleanFallback(draft.businessGroup, draft.domain, draft.businessGroupRecommendation?.label),
    businessGroupRecommendation: draft.businessGroupRecommendation || null,
    ownerHint: cleanFallback(draft.ownerHint),
    reviewGate: cleanFallback(draft.reviewGate),
  };
  const agentConclusion = {
    status: cleanFallback(executionSummary.status),
    progressLabel: cleanFallback(executionSummary.progressLabel),
    recommendation: cleanFallback(risk.recommendation),
    confidence: risk.confidence || 0,
    riskLevel: cleanFallback(risk.riskLevel),
    errorCode: cleanFallback(risk.errorCode),
    nextGate: cleanFallback(risk.nextGate),
    qualityRoute: risk.qualityRoute || null,
  };
  const findings = cleanArray(risk.findings);
  const missingItems = cleanArray(risk.missingItems);
  return {
    contractVersion: "agent-skill-review-draft.v1",
    title: subjectName ? `${subjectName} 预审核评审稿` : "Skill 预审核评审稿",
    subject,
    packageReadSummary: packageSummary,
    contractFields,
    governanceFields,
    sections: [
      {
        id: "identity",
        title: "对象身份",
        items: [
          subject.name ? `Skill：${subject.name}` : "",
          subject.sourceSkillId ? `sourceSkillId：${subject.sourceSkillId}` : "sourceSkillId 待确认",
          subject.sourceRef ? `来源：${subject.sourceRef}` : "",
          governanceFields.businessGroup ? `推荐业务组：${governanceFields.businessGroup}` : "推荐业务组待确认",
        ].filter(Boolean),
      },
      {
        id: "governance",
        title: "归属建议",
        items: [
          governanceFields.targetDepartmentId ? `归属部门：${governanceFields.targetDepartmentId}` : "归属部门待确认",
          governanceFields.businessGroupRecommendation?.confidence
            ? `推荐置信度：${governanceFields.businessGroupRecommendation.confidence}`
            : "",
          governanceFields.businessGroupRecommendation?.rationale
            ? `推荐依据：${governanceFields.businessGroupRecommendation.rationale}`
            : "",
          governanceFields.reviewGate ? `确认门禁：${governanceFields.reviewGate}` : "",
        ].filter(Boolean),
      },
      {
        id: "package",
        title: "包读取摘要",
        items: [
          packageSummary.summaryText,
          packageSummary.skillPath ? `SKILL.md：${packageSummary.skillPath}` : "",
          `原始内容保存：${packageSummary.rawContentStored ? "是" : "否"}`,
        ].filter(Boolean),
      },
      {
        id: "contract",
        title: "输入输出与工具边界",
        items: [
          `输入：${contractFields.inputs.length ? contractFields.inputs.join("；") : "待补充"}`,
          `输出：${contractFields.outputs.length ? contractFields.outputs.join("；") : "待补充"}`,
          `工具：${contractFields.tools.length ? contractFields.tools.join("；") : "待补充"}`,
          `约束：${contractFields.constraints.length ? contractFields.constraints.join("；") : "待补充"}`,
          contractFields.executionGuidance.length ? `执行指引：${contractFields.executionGuidance.join("；")}` : "",
        ].filter(Boolean),
      },
      {
        id: "decision",
        title: "Agent 建议与门禁",
        items: [
          `建议：${agentConclusion.recommendation || "human_confirm"}`,
          agentConclusion.errorCode ? `错误码：${agentConclusion.errorCode}` : "",
          agentConclusion.nextGate ? `下一步：${agentConclusion.nextGate}` : "",
        ].filter(Boolean),
      },
    ],
    safeFindings: findings,
    missingItems,
    agentConclusion,
    writebackPlan: {
      target: "quality.skillEmployeeReviewDraft.agentPreReview.reviewDraft",
      fields: ["subject", "packageReadSummary", "contractFields", "governanceFields", "safeFindings", "missingItems", "agentConclusion"],
      humanReviewPage: "技能/员工评审",
      productionEffect: "none",
    },
    uiDisplay: {
      primaryTitle: subjectName,
      statusLabel: cleanFallback(executionSummary.progressLabel),
      sectionOrder: ["identity", "governance", "package", "contract", "decision"],
    },
    privacyBoundary: "只展示安全摘要和治理字段；不展示原始包、raw prompt、模型 trace、执行 payload、provider key、客户数据或员工 PII。",
  };
}

function safeRuntimeInstructions(value = null) {
  if (!value || typeof value !== "object" || value.contractVersion !== "skill-runtime-instructions.v1") return null;
  const cleaned = cleanInstructionText(value.content);
  const content = cleaned.slice(0, maxRuntimeInstructionChars);
  if (!content) return null;
  return {
    contractVersion: value.contractVersion,
    source: cleanFallback(value.source),
    content,
    contentHash: cleanFallback(value.contentHash),
    sourceHash: cleanFallback(value.sourceHash),
    sectionHeadings: cleanArray(value.sectionHeadings).slice(0, 16),
    truncated: value.truncated === true || cleaned.length > maxRuntimeInstructionChars,
  };
}

function safeRuntimeReferences(value = []) {
  if (!Array.isArray(value)) return [];
  return value
    .slice(0, maxRuntimeReferencesPerSkill)
    .map((reference) => {
      if (!reference || typeof reference !== "object" || reference.contractVersion !== "skill-runtime-reference.v1") return null;
      const cleaned = cleanInstructionText(reference.content);
      const content = cleaned.slice(0, maxRuntimeReferenceChars);
      if (!content) return null;
      return {
        contractVersion: reference.contractVersion,
        source: cleanFallback(reference.source),
        path: cleanFallback(reference.path),
        content,
        contentHash: cleanFallback(reference.contentHash),
        sourceHash: cleanFallback(reference.sourceHash),
        sectionHeadings: cleanArray(reference.sectionHeadings).slice(0, 16),
        truncated: reference.truncated === true || cleaned.length > maxRuntimeReferenceChars,
      };
    })
    .filter(Boolean);
}

function cleanInstructionText(value = "") {
  return String(value || "")
    .replace(/<!--[\s\S]*?-->/g, "")
    .split(/\r?\n/)
    .map((line) => line.replace(/\s+$/g, ""))
    .filter((line) => !/(api[-_ ]?key|secret|password|access[-_ ]?token|refresh[-_ ]?token|authorization|bearer|jwt|oauth[_ -]?state|authorization code)\s*[:=]\s*\S+/i.test(line))
    .join("\n")
    .replace(/\n{4,}/g, "\n\n\n")
    .trim();
}

function cleanArray(value) {
  return Array.isArray(value) ? value.map((item) => cleanFallback(item)).filter(Boolean) : [];
}

function cleanFallback(...values) {
  return values.map((value) => String(value || "").trim()).find(Boolean) || "";
}

function uniqueQualityTags(tags = []) {
  return Array.from(new Set(tags.map((tag) => String(tag || "").trim()).filter(Boolean)));
}

function agentPreReviewKey(draft) {
  return `${draft.jobId || "unknown-job"}::${draft.draftId || draft.skillId || "unknown-draft"}`;
}

function qualityRouteForAgent(errorCode, blocking = false) {
  return {
    target: "evaluation_review",
    targetLabel: "测评审核",
    eventType: blocking ? "agent_pre_review_blocked" : "agent_pre_review_findings",
    errorCode,
    evalCandidate: true,
    feedbackPolicy: "AI 预审核失败、阻断或发现缺口时，进入测评审核/质量复核队列，由人确认修复、回归候选和再次预审。",
  };
}
