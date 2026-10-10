import {
  agentPreReviewBlockingStatuses,
  agentPreReviewReadyStatuses,
} from "./skill-agent-pre-review.mjs";
import { defaultSkillReviewNote } from "./system-import-policy-helpers.mjs";
import {
  draftRefsForJob,
  statusForReviewedJob,
} from "./system-import-review-helpers.mjs";
import { createMountedSkillSummarizer } from "./skill-review-display-helpers.mjs";
import { resolveMvpSkillVersion, selectSkillPublicationHead } from "./skill-version-helpers.mjs";
import { projectRuntimeBusinessSkills } from "./runtime-business-skill-catalog.mjs";
import { employeeWithEffectiveMountedSkills } from "../src/lib/digitalEmployeePackage.js";
import { normalizeAgentRuntimeId, normalizeRuntimeAdapterId } from "./external-employee-runtime-declaration.mjs";
import { resolveSkillRuntimeExecutionProfile } from "./agent-runtime/skill-runtime-profile.mjs";
import { installHarnessArtifact, verifyHarnessInstallation } from "./skill-harness-artifact-store.mjs";
import { randomUUID } from "node:crypto";
import { taskBoundSkills } from "./skill-publication-task-bindings.mjs";
import { createSkillHarnessRunner } from "./skill-harness-runner.mjs";

const maxRuntimeReferenceChars = 32 * 1024;
const maxRuntimeReferencesPerSkill = 8;

export function createSkillEmployeeReviewHandlers({
  basicSkills = [],
  businessSkills,
  catalogSkillReviewStates,
  cleanEntityId,
  cleanList,
  cleanText,
  departmentLabelForId,
  draftId,
  evaluationDatasetReviewHandlers,
  findUnsafePayloadKeys,
  getSkillMountRequests = () => [],
  importJobs,
  digitalEmployees = [],
  digitalEmployeeReviews,
  mvpSkillPublications,
  mvpDigitalEmployeeStates,
  normalizeReviewDecision,
  onPublishedBusinessSkillHead = null,
  persistSystemImportState,
  publishedBusinessSkills,
  runtimeSkillProjections,
  readJsonBody,
  recommendBusinessGroup,
  requirePermission,
  restoreSystemImportSnapshot,
  safeImportWarning,
  sendJson,
  skillAgentPreReview,
  skillById,
  skillEmployeeReviews,
  systemImportSnapshot,
  systemImportStoreFailure,
  systemImportStorePath,
  unsafePayload,
}) {
  const summarizeMountedSkillHints = createMountedSkillSummarizer({
    businessSkills,
    publishedBusinessSkills,
    mvpSkillPublications,
    importJobs,
    draftRefsForJob,
    cleanEntityId,
    cleanList,
    cleanText,
  });

  async function handle(req, res, url) {
    if (req.method === "GET" && url.pathname === "/api/quality-reviews/skill-employee") {
      listSkillEmployeeReviews(req, res, url);
      return true;
    }

    if (req.method === "POST" && url.pathname === "/api/quality-reviews/skill-employee") {
      await submitSkillEmployeeReview(req, res);
      return true;
    }

    if (req.method === "POST" && url.pathname === "/api/quality-reviews/skill-employee/pre-review") {
      await rerunSkillEmployeePreReview(req, res);
      return true;
    }

    return undefined;
  }

  function listSkillEmployeeReviews(req, res, url) {
    const session = requirePermission(req, res, "quality-reviews:read");
    if (!session) return undefined;
    const previousState = systemImportSnapshot();
    const status = cleanText(url.searchParams.get("status") || "");
    const jobId = cleanText(url.searchParams.get("jobId") || "");
    const skillId = cleanText(url.searchParams.get("skillId") || "");
    const pendingDrafts = skillReviewDrafts({ status, jobId, skillId });
    const pendingEmployeeDrafts = employeeReviewDrafts({ status, jobId });
    const completedEmployeeDrafts = completedEmployeeReviewDrafts({ status, jobId });
    pendingDrafts.forEach((draft) => skillAgentPreReview.ensure(draft));
    const persistResult = persistSystemImportState();
    if (!persistResult.ok) {
      restoreSystemImportSnapshot(previousState);
      return systemImportStoreFailure(res, persistResult);
    }
    const reviews = [...skillEmployeeReviews.values()]
      .filter((review) => !status || review.status === status)
      .filter((review) => !jobId || review.jobId === jobId)
      .filter((review) => !skillId || review.skillId === skillId)
      .sort((left, right) => String(right.decidedAt).localeCompare(String(left.decidedAt)));
    const employeeReviews = [...digitalEmployeeReviews.values()]
      .filter((review) => !status || review.status === status)
      .filter((review) => !jobId || review.jobId === jobId)
      .sort((left, right) => String(right.decidedAt).localeCompare(String(left.decidedAt)));
    const publications = [...mvpSkillPublications.values()]
      .filter((publication) => !status || publication.status === status)
      .filter((publication) => !jobId || publication.sourceJobId === jobId)
      .filter((publication) => !skillId || publication.skillId === skillId)
      .sort((left, right) => String(right.publishedAt).localeCompare(String(left.publishedAt)));

    return sendJson(res, 200, {
      ok: true,
      status: "ready",
      contractVersion: "skill-employee-review-list.v1",
      pendingDrafts,
      pendingEmployeeDrafts,
      completedEmployeeDrafts,
      reviews,
      employeeReviews,
      publications,
      agentPreReviews: pendingDrafts.map((draft) => draft.agentPreReview).filter(Boolean),
      qualityEvents: skillAgentPreReview.listQualityEvents(),
      evaluationDatasetDecisions: evaluationDatasetReviewHandlers.decisionMap(),
      persistence: {
        kind: systemImportStorePath ? "mvp-file-store" : "mvp-process-memory",
        productionReady: false,
        path: systemImportStorePath ? "data/local/system-import-state.json" : "",
        note: systemImportStorePath
          ? "当前 MVP 用 ignored data/local 文件保存 Skill/employee review、Agent 预审摘要、质量事件和 MVP 发布记录，可跨服务重启保留。"
          : "当前 MVP 用后端进程内存保存 Skill/employee review 和发布记录；重启服务会清空。",
      },
      privacyBoundary: "只返回 Skill 草案安全摘要、Agent 预审核摘要、审核结论和 MVP 发布元数据；不返回 raw prompt、私有 Skill payload、真实 provider key、执行 payload、凭证或客户/员工敏感数据。",
    });
  }

  function listRuntimeBusinessSkills({ status = "", departmentId = "", domain = "", risk = "", task = null } = {}) {
    return taskBoundSkills(projectRuntimeBusinessSkills({
      businessSkills,
      catalogSkillReviewStates,
      departmentId,
      domain,
      publishedBusinessSkills,
      runtimeSkillProjections,
      risk,
      skillById,
      status,
    }), task);
  }

  function listRuntimeDigitalEmployees({ status = "", departmentId = "", ownerDepartmentId = "", ownerUserId = "", permissionScope = "", level = "", owner = "" } = {}) {
    const skillMountRequests = getSkillMountRequests();
    const catalogEmployeeIds = new Set(digitalEmployees.map((employee) => employee.id));
    const catalogEmployees = digitalEmployees.map((employee) => {
      const state = resolvedMvpStateForCatalogEmployee(employee);
      const status = employeeLifecycleStatus(employee, state);
      const runtimeEmployee = state
        ? {
            ...employee,
            status,
            mvpPersonnelApproval: state.personnelApproval || null,
            mvpTrialActivation: state.trialActivation || null,
            reviewDecision: state.reviewDecision || null,
            updatedAt: state.updatedAt || employee.updatedAt,
          }
        : { ...employee, status };
      return employeeWithEffectiveMountedSkills(runtimeEmployee, skillMountRequests);
    });
    const importedEmployees = [...mvpDigitalEmployeeStates.values()]
      .filter((state) => state.employee && !catalogEmployeeIds.has(state.employeeId))
      .filter((state) => !catalogEmployeeForMvpState(state))
      .map((state) => {
        const status = employeeLifecycleStatus(state.employee, state);
        return employeeWithEffectiveMountedSkills({
          ...state.employee,
          mountedSkillHints: cleanList(state.employee.mountedSkillHints || state.employee.businessSkillIds),
          businessSkillIds: [],
          runtimeBinding: {
            ...(state.employee.runtimeBinding || {}),
            runtimeAdapter: normalizeRuntimeAdapterId(state.employee.runtimeBinding?.runtimeAdapter || "responses_api"),
            agentRuntimeId: normalizeAgentRuntimeId(state.employee.runtimeBinding?.agentRuntimeId),
          },
          status,
          mvpPersonnelApproval: state.personnelApproval || null,
          mvpTrialActivation: state.trialActivation || null,
          reviewDecision: state.reviewDecision || null,
          updatedAt: state.updatedAt || state.employee.updatedAt,
        }, skillMountRequests);
      });

    return [...catalogEmployees, ...importedEmployees]
      .filter((employee) => !status || employee.status === status)
      .filter((employee) => !departmentId || employee.departmentId === departmentId)
      .filter((employee) => !ownerDepartmentId || employee.ownerDepartmentId === ownerDepartmentId)
      .filter((employee) => !ownerUserId || employee.ownerUserId === ownerUserId)
      .filter((employee) => !permissionScope || employee.permissionScope === permissionScope)
      .filter((employee) => !level || employee.level === level)
      .filter((employee) => !owner || employee.owner === owner)
      .sort((left, right) => String(right.updatedAt || right.version || "").localeCompare(String(left.updatedAt || left.version || "")));
  }

  async function rerunSkillEmployeePreReview(req, res) {
    const session = requirePermission(req, res, "quality-reviews:edit");
    if (!session) return undefined;
    const previousState = systemImportSnapshot();
    const input = await readJsonBody(req);
    const unsafeKeys = findUnsafePayloadKeys(input);
    if (unsafeKeys.length) return unsafePayload(res, unsafeKeys);

    const jobId = cleanText(input.jobId || "");
    const draftIdValue = cleanText(input.draftId || input.requestId || "");
    if (!jobId || !draftIdValue) {
      return sendJson(res, 422, {
        ok: false,
        error: "skill_pre_review_target_required",
        contractVersion: "skill-agent-pre-review.v1",
        requiredFields: ["jobId", "draftId"],
      });
    }

    const target = findSkillReviewDraft(jobId, draftIdValue);
    if (!target || !["skillDrafts", "skillUpdateDrafts", "catalogBusinessSkill", "catalogBasicSkill"].includes(target.kind)) {
      return sendJson(res, 404, {
        ok: false,
        error: "skill_review_draft_not_found",
        contractVersion: "skill-agent-pre-review.v1",
      });
    }

    const summaryDraft = summarizeSkillReviewDraft(target.job, target.kind, target.draft);
    const execution = skillAgentPreReview.run(summaryDraft, { force: true, requestedBy: session.employeeId });
    attachAgentPreReview(target, execution);
    const persistResult = persistSystemImportState();
    if (!persistResult.ok) {
      restoreSystemImportSnapshot(previousState);
      return systemImportStoreFailure(res, persistResult);
    }
    return sendJson(res, 202, {
      ok: true,
      status: execution.status,
      contractVersion: "skill-agent-pre-review.v1",
      agentPreReview: execution,
      pendingDraft: summarizeSkillReviewDraft(target.job, target.kind, target.draft),
      warnings: [
        "Agent pre-review stores safe execution summaries only; real provider keys, raw prompts, package payloads, model traces, and generated payloads stay server-side.",
      ],
    });
  }

  async function submitSkillEmployeeReview(req, res) {
    const session = requirePermission(req, res, "quality-reviews:edit");
    if (!session) return undefined;
    const input = await readJsonBody(req);
    // No await between this snapshot and commit: the single Center writer serializes activation.
    const previousState = structuredClone(systemImportSnapshot());
    const unsafeKeys = findUnsafePayloadKeys(input);
    if (unsafeKeys.length) return unsafePayload(res, unsafeKeys);
    if (input.action === "rollback") return rollbackSkillPublication({ res, input, session, previousState });

    const jobId = cleanText(input.jobId || "");
    const draftIdValue = cleanText(input.draftId || input.requestId || "");
    if (!jobId || !draftIdValue) {
      return sendJson(res, 422, {
        ok: false,
        error: "review_target_required",
        contractVersion: "skill-employee-review-decision.v1",
        requiredFields: ["jobId", "draftId"],
      });
    }

    const employeeTarget = findEmployeeReviewDraft(jobId, draftIdValue);
    if (cleanText(input.reviewType || input.kind || "") === "employee" || employeeTarget) {
      return submitEmployeeReviewDecision({ res, input, session, previousState, target: employeeTarget, jobId, draftIdValue });
    }

    const decision = normalizeReviewDecision(input.decision);
    if (!decision) {
      return sendJson(res, 422, {
        ok: false,
        error: "review_decision_required",
        contractVersion: "skill-employee-review-decision.v1",
        allowedDecisions: ["approved", "rejected"],
      });
    }

    const target = findSkillReviewDraft(jobId, draftIdValue);
    if (!target) {
      return sendJson(res, 404, {
        ok: false,
        error: "skill_review_draft_not_found",
        contractVersion: "skill-employee-review-decision.v1",
      });
    }

    const { job, kind, draft, source } = target;
    if (kind !== "skillDrafts" && kind !== "skillUpdateDrafts" && kind !== "catalogBusinessSkill" && kind !== "catalogBasicSkill") {
      return sendJson(res, 422, {
        ok: false,
        error: "unsupported_skill_review_draft",
        contractVersion: "skill-employee-review-decision.v1",
        allowedDraftKinds: ["skillDrafts", "skillUpdateDrafts", "catalogBusinessSkill", "catalogBasicSkill"],
      });
    }
    if (!["待技能评审", "mvp_skill_published", "mvp_review_rejected", "approved_deployment_failed"].includes(draft.status)) {
      return sendJson(res, 409, {
        ok: false,
        error: "skill_review_not_ready",
        contractVersion: "skill-employee-review-decision.v1",
        status: draft.status,
        nextGate: "请先完成系统接入自动路由或异常来源处理，使 Skill 草案进入待技能评审。",
      });
    }
    if (decision === "approved" && draft.status === "mvp_skill_published") {
      return sendJson(res, 409, {
        ok: false,
        error: "skill_already_mvp_published",
        contractVersion: "skill-employee-review-decision.v1",
        publication: draft.mvpPublication,
      });
    }
    if (decision === "approved" && kind === "skillUpdateDrafts") {
      const currentSkill = publishedBusinessSkills.get(cleanEntityId(draft.skillId)) || skillById.get(cleanEntityId(draft.skillId));
      const currentVersion = cleanText(currentSkill?.version || "");
      if (!currentVersion || cleanText(draft.previousVersion || "") !== currentVersion) {
        return sendJson(res, 409, {
          ok: false,
          error: "skill_update_previous_version_mismatch",
          contractVersion: "skill-employee-review-decision.v1",
          currentVersion,
          nextGate: "当前 Skill 版本已变化；请基于当前版本重新创建更新草案。回滚必须走单独、显式的发布流程。",
        });
      }
    }
    const reviewDraftSummary = summarizeSkillReviewDraft(job, kind, draft);
    const agentPreReview = skillAgentPreReview.ensure(reviewDraftSummary);
    attachAgentPreReview(target, agentPreReview);
    if (decision === "approved" && agentPreReviewBlockingStatuses.has(agentPreReview.status)) {
      return sendJson(res, 409, {
        ok: false,
        error: agentPreReview.errorCode || "agent_pre_review_blocked",
        contractVersion: "skill-employee-review-decision.v1",
        agentPreReview,
        nextGate: "Agent 预审核失败或阻断，已归入测评审核/质量复核；请处理错误码或重跑预审核后再人工通过。",
      });
    }
    if (decision === "approved" && !agentPreReviewReadyStatuses.has(agentPreReview.status)) {
      return sendJson(res, 409, {
        ok: false,
        error: "agent_pre_review_required",
        contractVersion: "skill-employee-review-decision.v1",
        agentPreReview,
        nextGate: "外部 Skill 必须先完成系统级 Agent 预审核，再由管理员根据结果确认。",
      });
    }
    if (decision === "approved" && !resolveSkillRuntimeExecutionProfile(draft)) {
      return sendJson(res, 409, {
        ok: false,
        error: "skill_runtime_execution_profile_required",
        message: "Skill 缺少可发布的运行执行类型。",
        contractVersion: "skill-employee-review-decision.v1",
        nextGate: "请重新上传包含 skill-package.json executionMode 的完整 Skill 包，再进行 Agent 预审核和人工发布评审。",
      });
    }

    const decidedAt = new Date().toISOString();
    const reviewId = draftId("QSR", `${job.jobId}-${draft.draftId}`);
    const review = {
      reviewId,
      jobId: job.jobId,
      draftId: draft.draftId,
      draftKind: kind,
      sourceRef: job.sourceRef,
      skillId: draft.skillId,
      skillApiId: draft.skillApiId || draft.skillId,
      sourceSkillId: draft.sourceSkillId || "",
      skillPackageIdentity: draft.skillPackageIdentity || null,
      runtimeHarnessIdentity: draft.runtimeHarnessIdentity || null,
      name: draft.name || draft.skillId,
      decision,
      status: decision === "approved" ? "approved_for_mvp_publication" : "mvp_review_rejected",
      decidedAt,
      decidedBy: session.employeeId,
      safeNotes: cleanText(input.safeNotes || input.note || defaultSkillReviewNote(decision, draft)),
      checkedItems: cleanList(input.checkedItems || [
        "Agent 预审核结果",
        "Skill ID / sourceSkillId",
        "输入输出契约",
        "工具和权限声明",
        "Prompt 元数据",
        "挂载影响",
        "回归候选",
      ]),
      nextGate: decision === "approved"
        ? "MVP 发布记录已生成；生产仍需持久化、RBAC、审计、版本发布和分发审核。"
        : "退回补齐 Skill ID、输入输出、Prompt 元数据、回归候选或挂载影响后重新提交。",
      productionEffect: "none",
      privacyBoundary: "Skill/employee review 只记录脱敏结论；不保存 raw prompt、私有 Skill payload、执行记录、凭证、客户数据或员工 PII。",
      agentPreReview: skillAgentPreReview.summarizeForReview(agentPreReview),
    };
    skillEmployeeReviews.set(reviewId, review);

    let publication = null;
    if (decision === "approved") {
      publication = createMvpSkillPublication({ job, draft, review, session });
      const previousSkill = publishedBusinessSkills.get(draft.skillId) || skillById.get(draft.skillId);
      if (publication.runtimeExecutionProfile.mode === "deterministic_harness") {
        try {
          const sameVersion = [...mvpSkillPublications.values()].find((candidate) =>
            candidate.publicationId !== publication.publicationId && candidate.skillId === publication.skillId &&
            candidate.version === publication.version && candidate.status === "mvp_skill_published" &&
            candidate.runtimeHarnessArtifact?.digest !== draft.runtimeHarnessArtifact?.digest);
          if (sameVersion) throw new Error("skill_version_artifact_conflict");
          publication.deployment = installHarnessArtifact({ artifact: draft.runtimeHarnessArtifact,
            identity: draft.runtimeHarnessIdentity, version: publication.version });
        } catch (error) {
          publication.status = "approved_deployment_failed";
          publication.runtimeEligibility = { allowed: false, reason: "skill_harness_deployment_failed" };
          publication.deployment = { status: "failed", errorCode: /^skill_[a-z_]+$/.test(error.message)
            ? error.message : "skill_harness_installation_failed" };
          publication.nextGate = "审核已通过，但部署失败，尚未生效；修复制品或运行环境后重试。原有效版本保持不变。";
          review.status = "approved_deployment_failed";
          review.nextGate = publication.nextGate;
        }
      }
      if (publication.status === "mvp_skill_published") {
        publication.publishedAt = new Date().toISOString();
        publication.activationSequence = Math.max(0, ...[...mvpSkillPublications.values()].map((item) => item.activationSequence || 0)) + 1;
        publication.previousSkillSnapshot = previousSkill ? structuredClone(previousSkill) : null;
      }
      if (kind !== "catalogBasicSkill" && publication.status === "mvp_skill_published") {
        upsertPublishedBusinessSkill({ publication, draft, review, job });
        publication.skillSnapshot = structuredClone(publishedBusinessSkills.get(draft.skillId));
      }
      draft.status = publication.status;
      draft.mvpPublication = summarizePublication(publication);
    } else {
      draft.status = "mvp_review_rejected";
      draft.reviewDecision = {
        ...(draft.reviewDecision || {}),
        status: draft.status,
        decision,
        decidedAt,
        decidedBy: session.employeeId,
        note: review.safeNotes,
        nextGate: review.nextGate,
        workflowEffect: "skill_review_returned",
        productionEffect: "none",
      };
    }
    if (source === "catalog") {
      catalogSkillReviewStates.set(draft.skillId, {
        status: draft.status,
        reviewDecision: draft.reviewDecision || null,
        mvpPublication: draft.mvpPublication || null,
        updatedAt: decidedAt,
      });
      job.updatedAt = decidedAt;
      job.status = draft.status;
    } else {
      job.status = statusForReviewedJob(job);
      job.updatedAt = decidedAt;
    }
    const persistResult = persistSystemImportState();
    if (!persistResult.ok) {
      restoreSystemImportSnapshot(previousState);
      return systemImportStoreFailure(res, persistResult);
    }
    if (decision === "approved" && publication?.status === "mvp_skill_published" && kind !== "catalogBasicSkill" &&
      typeof onPublishedBusinessSkillHead === "function") {
      try {
        onPublishedBusinessSkillHead({ skillId: publication.skillId, version: publication.version });
      } catch {
        return sendJson(res, 503, {
          ok: false,
          error: "skill_published_trigger_promotion_pending",
          contractVersion: "skill-employee-review-decision.v1",
          nextGate: "Skill 已发布；Center 会在下一次启动时补做 Trigger 生效版本推进。",
        });
      }
    }

    return sendJson(res, decision === "approved" ? 201 : 200, {
      ok: true,
      status: review.status,
      contractVersion: "skill-employee-review-decision.v1",
      review,
      publication,
      importJob: job,
      warnings: [
        safeImportWarning,
        "Harness 仅在人工审核通过后安装验证；有效发布头只在验证成功后推进。发布不自动挂载员工或分发凭证。",
      ],
    });
  }

  async function rollbackSkillPublication({ res, input, session }) {
    const target = mvpSkillPublications.get(cleanText(input.publicationId));
    const current = target && publishedBusinessSkills.get(target.skillId);
    const targetSnapshot = target?.skillSnapshot || [...mvpSkillPublications.values()]
      .find((item) => item.previousSkillSnapshot?.mvpPublication?.publicationId === target?.publicationId)?.previousSkillSnapshot;
    if (!targetSnapshot || target.status !== "mvp_skill_published" ||
      !input.expectedHead || current?.mvpPublication?.publicationId !== input.expectedHead) {
      return sendJson(res, 409, { ok: false, error: "skill_rollback_head_conflict" });
    }
    try {
      if (targetSnapshot.runtimeExecutionProfile?.mode === "deterministic_harness") {
        if (targetSnapshot.runtimeHarnessArtifact) {
          verifyHarnessInstallation({ artifact: targetSnapshot.runtimeHarnessArtifact, identity: targetSnapshot.runtimeHarnessIdentity });
        } else {
          // Migration-only rollback of an already approved, hash-identified legacy installation.
          if (!targetSnapshot.runtimeHarnessIdentity?.manifestSha256 || !targetSnapshot.runtimeHarnessIdentity?.entrypointSha256) throw new Error();
          const readiness = await createSkillHarnessRunner({ getPublishedSkills: () => [targetSnapshot] }).inspectHarnessReadiness([target.skillId]);
          if (!readiness.verifiedSkillIds.includes(target.skillId)) throw new Error();
        }
      }
    } catch { return sendJson(res, 409, { ok: false, error: "skill_rollback_installation_unavailable" }); }
    if (publishedBusinessSkills.get(target.skillId)?.mvpPublication?.publicationId !== input.expectedHead) {
      return sendJson(res, 409, { ok: false, error: "skill_rollback_head_conflict" });
    }
    const previousState = structuredClone(systemImportSnapshot());
    const publication = { ...structuredClone(target), publicationId: `MPUB-${randomUUID()}`,
      publishedAt: new Date().toISOString(), publishedBy: session.employeeId,
      activationSequence: Math.max(0, ...[...mvpSkillPublications.values()].map((item) => item.activationSequence || 0)) + 1,
      rollbackOf: current.mvpPublication.publicationId, rollbackTarget: target.publicationId,
      previousSkillSnapshot: structuredClone(current) };
    const skill = { ...structuredClone(targetSnapshot), mvpPublication: summarizePublication(publication) };
    publication.skillSnapshot = structuredClone(skill);
    mvpSkillPublications.set(publication.publicationId, publication);
    publishedBusinessSkills.set(skill.id, skill);
    skillById.set(skill.id, skill);
    const saved = persistSystemImportState();
    if (!saved.ok) { restoreSystemImportSnapshot(previousState); return systemImportStoreFailure(res, saved); }
    onPublishedBusinessSkillHead?.({ skillId: skill.id, version: skill.version });
    return sendJson(res, 200, { ok: true, publication: summarizePublication(publication) });
  }

  function submitEmployeeReviewDecision({ res, input, session, previousState, target, jobId, draftIdValue }) {
    if (!target) {
      return sendJson(res, 404, {
        ok: false,
        error: "employee_review_draft_not_found",
        contractVersion: "employee-review-decision.v1",
      });
    }

    const action = normalizeEmployeeReviewAction(input);
    if (!action) {
      return sendJson(res, 422, {
        ok: false,
        error: "employee_review_action_required",
        contractVersion: "employee-review-decision.v1",
        allowedActions: ["approved", "rejected"],
      });
    }

    const { job, kind, draft, source } = target;
    if (!["externalEmployeeDrafts", "catalogBusinessEmployee"].includes(kind)) {
      return sendJson(res, 422, {
        ok: false,
        error: "unsupported_employee_review_draft",
        contractVersion: "employee-review-decision.v1",
        allowedDraftKinds: ["externalEmployeeDrafts", "catalogBusinessEmployee"],
      });
    }

    if (action === "approve_personnel" && !["待人员审批", "pending_review", "mvp_review_rejected"].includes(draft.status)) {
      return sendJson(res, 409, {
        ok: false,
        error: "personnel_review_not_ready",
        contractVersion: "employee-review-decision.v1",
        status: draft.status,
        nextGate: ["人员审批通过", "试运行", "在线"].includes(draft.status) ? "人员审批已通过，数字员工处于试运行或已按上线门禁收敛。" : "该员工当前不在待人员审批队列。",
      });
    }

    const decidedAt = new Date().toISOString();
    const reviewId = draftId("QER", `${jobId}-${draftIdValue}-${action}`);
    const nextStatus = statusForEmployeeReviewAction(action);
    const review = {
      reviewId,
      jobId: job.jobId,
      draftId: draft.draftId,
      draftKind: kind,
      sourceRef: draft.sourceRef || job.sourceRef,
      employeeId: draft.externalEmployeeId || draft.employeeId,
      name: draft.name || draft.externalEmployeeId || draft.employeeId,
      action,
      decision: action === "reject_personnel" ? "rejected" : "approved",
      status: statusForEmployeeReviewRecord(action),
      employeeStatus: nextStatus,
      decidedAt,
      decidedBy: session.employeeId,
      safeNotes: cleanText(input.safeNotes || input.note || defaultEmployeeReviewNote(action, draft)),
      checkedItems: cleanList(input.checkedItems || defaultEmployeeCheckedItems(action)),
      nextGate: nextGateForEmployeeReviewAction(action),
      productionEffect: "none",
      privacyBoundary: "员工评审只记录脱敏审批结论和 MVP 状态；不保存 raw prompt、执行 payload、凭证、客户数据或员工 PII。",
    };
    digitalEmployeeReviews.set(reviewId, review);

    draft.status = nextStatus;
    draft.reviewDecision = {
      ...(draft.reviewDecision || {}),
      status: nextStatus,
      decision: review.decision,
      action,
      decidedAt,
      decidedBy: session.employeeId,
      note: review.safeNotes,
      nextGate: review.nextGate,
      workflowEffect: action,
      productionEffect: "none",
    };

    const runtimeState = upsertMvpDigitalEmployeeState({ source, job, draft, review, action, decidedAt });
    if (source === "catalog") {
      job.updatedAt = decidedAt;
      job.status = nextStatus;
    } else {
      job.status = statusForReviewedJob(job);
      job.updatedAt = decidedAt;
    }

    const persistResult = persistSystemImportState();
    if (!persistResult.ok) {
      restoreSystemImportSnapshot(previousState);
      return systemImportStoreFailure(res, persistResult);
    }

    return sendJson(res, 200, {
      ok: true,
      status: review.status,
      contractVersion: "employee-review-decision.v1",
      review,
      pendingEmployeeDraft: summarizeEmployeeReviewDraft(job, kind, draft),
      digitalEmployee: runtimeState.employee || listRuntimeDigitalEmployees({}).find((employee) => employee.id === runtimeState.employeeId) || null,
      warnings: [
        safeImportWarning,
        "人员审批通过后员工进入试运行；只有员工声明的结构化上线门禁全部通过且没有阻塞项时，生命周期才会收敛为在线。",
      ],
    });
  }

  function skillReviewDrafts({ status = "", jobId = "", skillId = "" } = {}) {
    const importDrafts = [...importJobs.values()]
      .filter((job) => !jobId || job.jobId === jobId)
      .flatMap((job) => draftRefsForJob(job)
        .filter(({ kind }) => kind === "skillDrafts" || kind === "skillUpdateDrafts")
        .filter(({ draft }) => !status || draft.status === status)
        .filter(({ draft }) => !skillId || draft.skillId === skillId)
        .map(({ kind, draft }) => summarizeSkillReviewDraft(job, kind, draft)));

    const catalogDrafts = [...basicSkills, ...businessSkills]
      .map((skill) => summarizeCatalogSkillReviewDraft(skill))
      .filter(Boolean)
      .filter((draft) => !jobId || draft.jobId === jobId)
      .filter((draft) => !status || draft.status === status)
      .filter((draft) => !skillId || draft.skillId === skillId);

    return [...importDrafts, ...catalogDrafts]
      .sort((left, right) => String(right.updatedAt || right.createdAt).localeCompare(String(left.updatedAt || left.createdAt)));
  }

  function employeeReviewDrafts({ status = "", jobId = "" } = {}) {
    const importEmployeeDrafts = [...importJobs.values()]
      .filter((job) => !jobId || job.jobId === jobId)
      .flatMap((job) => draftRefsForJob(job)
        .filter(({ kind }) => kind === "externalEmployeeDrafts")
        .filter(({ draft }) => !isSourceRegistrationDraft(draft))
        .filter(({ draft }) => !catalogEmployeeForReviewDraft(draft))
        .map(({ kind, draft }) => summarizeEmployeeReviewDraft(job, kind, draft))
        .filter((draft) => isPendingEmployeeReviewDraft(draft))
        .filter((draft) => !status || draft.status === status));

    const catalogEmployeeDrafts = digitalEmployees
      .map((employee) => summarizeCatalogEmployeeReviewDraft(employee))
      .filter(Boolean)
      .filter((draft) => !jobId || draft.jobId === jobId)
      .filter((draft) => !status || draft.status === status);

    return [...importEmployeeDrafts, ...catalogEmployeeDrafts]
      .sort((left, right) => String(right.updatedAt || right.createdAt).localeCompare(String(left.updatedAt || left.createdAt)));
  }

  function completedEmployeeReviewDrafts({ status = "", jobId = "" } = {}) {
    const importEmployeeDrafts = [...importJobs.values()]
      .filter((job) => !jobId || job.jobId === jobId)
      .flatMap((job) => draftRefsForJob(job)
        .filter(({ kind }) => kind === "externalEmployeeDrafts")
        .filter(({ draft }) => !isSourceRegistrationDraft(draft))
        .filter(({ draft }) => !catalogEmployeeForReviewDraft(draft))
        .map(({ kind, draft }) => summarizeEmployeeReviewDraft(job, kind, draft))
        .filter((draft) => isApprovedEmployeeReviewDraft(draft))
        .filter((draft) => !status || draft.status === status));

    const catalogEmployeeDrafts = digitalEmployees
      .map((employee) => summarizeCatalogEmployeeReviewDraft(employee, { includeCompleted: true }))
      .filter(Boolean)
      .filter((draft) => !jobId || draft.jobId === jobId)
      .filter((draft) => !status || draft.status === status);

    return [...importEmployeeDrafts, ...catalogEmployeeDrafts]
      .sort((left, right) => String(right.updatedAt || right.createdAt).localeCompare(String(left.updatedAt || left.createdAt)));
  }

  function findSkillReviewDraft(jobId, draftIdValue) {
    const catalogTarget = findCatalogSkillReviewDraft(jobId, draftIdValue);
    if (catalogTarget) return catalogTarget;

    const job = importJobs.get(jobId);
    if (!job) return null;
    const target = draftRefsForJob(job).find(({ draft }) => draft.draftId === draftIdValue);
    return target ? { source: "importJob", job, ...target } : null;
  }

  function findEmployeeReviewDraft(jobId, draftIdValue) {
    const catalogTarget = findCatalogEmployeeReviewDraft(jobId, draftIdValue);
    if (catalogTarget) return catalogTarget;

    const job = importJobs.get(jobId);
    if (!job) return null;
    const target = draftRefsForJob(job)
      .filter(({ kind }) => kind === "externalEmployeeDrafts")
      .filter(({ draft }) => !isSourceRegistrationDraft(draft))
      .find(({ draft }) => draft.draftId === draftIdValue);
    if (!target) return null;
    const catalogEmployee = catalogEmployeeForReviewDraft(target.draft);
    if (catalogEmployee) {
      const state = resolvedMvpStateForCatalogEmployee(catalogEmployee) || {};
      return {
        source: "catalog",
        job: catalogEmployeeReviewJob(catalogEmployee, state),
        kind: "catalogBusinessEmployee",
        draft: catalogEmployeeReviewDraft(catalogEmployee, state),
      };
    }
    return { source: "importJob", job, ...target };
  }

  function attachAgentPreReview(target, execution) {
    if (!target?.draft || !execution) return;
    target.draft.agentPreReview = execution;
    if (target.source === "catalog") {
      const current = catalogSkillReviewStates.get(target.draft.skillId) || {};
      catalogSkillReviewStates.set(target.draft.skillId, {
        ...current,
        agentPreReview: execution,
        updatedAt: new Date().toISOString(),
      });
    } else if (target.job) {
      target.job.updatedAt = new Date().toISOString();
    }
  }

  function summarizeSkillReviewDraft(job, kind, draft) {
    return {
      jobId: job.jobId,
      draftId: draft.draftId,
      draftKind: kind,
      pipelineId: job.pipelineId,
      sourceRef: job.sourceRef,
      status: draft.status,
      skillId: draft.skillId,
      skillApiId: draft.skillApiId || draft.skillId,
      sourceSkillId: draft.sourceSkillId || "",
      skillPackageIdentity: draft.skillPackageIdentity || null,
      runtimeHarnessIdentity: draft.runtimeHarnessIdentity || null,
      deployment: draft.mvpPublication?.deployment || null,
      name: draft.name || draft.skillId,
      targetDepartmentId: draft.targetDepartmentId,
      businessGroupRecommendation: draft.businessGroupRecommendation || null,
      businessGroupId: draft.businessGroupId || draft.businessGroupRecommendation?.groupId || "",
      businessGroup: draft.businessGroup || draft.businessGroupRecommendation?.label || draft.domain || "",
      domain: draft.domain || draft.businessGroupRecommendation?.domainLabel || draft.businessGroupRecommendation?.label || "",
      versionIntent: draft.targetVersion || draft.skillPackageIdentity?.version || draft.versionIntent || "draft",
      previousVersion: draft.previousVersion || "",
      targetVersion: draft.targetVersion || draft.versionIntent || "",
      declaredChanges: cleanList(draft.declaredChanges),
      breakingChange: Boolean(draft.breakingChange),
      lineageKey: draft.lineageKey || "",
      reviewGate: draft.reviewGate,
      risk: draft.risk,
      manifestSummary: draft.manifestSummary,
      declaredInputs: cleanList(draft.declaredInputs),
      declaredOutputs: cleanList(draft.declaredOutputs),
      tools: cleanList(draft.tools),
      constraints: cleanList(draft.constraints),
      executionGuidance: cleanList(draft.executionGuidance),
      runtimeInstructions: safeRuntimeInstructions(draft.runtimeInstructions),
      runtimeReferences: safeRuntimeReferences(draft.runtimeReferences),
      runtimeExecutionProfile: resolveSkillRuntimeExecutionProfile(draft),
      packageIntake: draft.packageIntake || null,
      packageReadSummary: draft.packageReadSummary || null,
      packageUnitPath: draft.packageUnitPath || "",
      references: cleanList(draft.references),
      referenceManifest: Array.isArray(draft.referenceManifest) ? draft.referenceManifest : [],
      skillContentHash: draft.skillContentHash || "",
      contractDigest: draft.contractDigest || "",
      lineageRule: draft.lineageRule || "",
      promptGovernance: draft.promptGovernance || null,
      mountHints: cleanList(draft.mountHints),
      existingSkill: draft.existingSkill || null,
      mvpPublication: draft.mvpPublication || null,
      deployment: draft.mvpPublication?.deployment || null,
      agentPreReview: draft.agentPreReview || null,
      createdAt: job.createdAt,
      updatedAt: job.updatedAt,
      privacyBoundary: draft.privacyBoundary,
    };
  }

  function summarizeEmployeeReviewDraft(job, kind, draft) {
    const employeeDeclaration = draft.employeeDeclaration || {};
    const employeeId = cleanEntityId(draft.externalEmployeeId || draft.employeeId || draft.id || draft.name);
    const runtimeState = mvpDigitalEmployeeStates.get(employeeId) || null;
    const reviewRecord = {
      ...draft,
      reviewDecision: runtimeState?.reviewDecision || draft.reviewDecision || null,
      personnelApproval: runtimeState?.personnelApproval || draft.personnelApproval || null,
      trialActivation: runtimeState?.trialActivation || draft.trialActivation || null,
    };
    return {
      jobId: job.jobId,
      draftId: draft.draftId,
      draftKind: kind,
      pipelineId: job.pipelineId,
      sourceRef: draft.sourceRef || job.sourceRef,
      status: employeeLifecycleStatus(draft, runtimeState || reviewRecord),
      employeeId,
      name: draft.name || draft.externalEmployeeId || draft.employeeId,
      title: draft.title,
      level: draft.level || "业务级",
      departmentId: draft.departmentId || draft.targetDepartmentId,
      department: departmentLabelForId(draft.departmentId || draft.targetDepartmentId),
      departmentSource: draft.departmentSource,
      ownerHint: draft.ownerHint || "",
      responsibilityAssignments: employeeDeclaration.responsibilityAssignments || null,
      businessGroupRecommendation: draft.businessGroupRecommendation || null,
      businessGroupId: draft.businessGroupId || draft.businessGroupRecommendation?.groupId || "",
      businessGroup: draft.businessGroup || draft.businessGroupRecommendation?.label || "",
      domain: draft.domain || draft.businessGroupRecommendation?.domainLabel || "",
      versionIntent: draft.versionIntent || "draft",
      reviewGate: draft.reviewGate,
      nextGate: employeeApprovalPassed(reviewRecord) ? trialEmployeeNextGate() : reviewRecord.reviewDecision?.nextGate || "人员审批确认归属、权限范围、上线资格和停用边界。",
      objective: employeeDeclaration.objective || draft.externalEmployeeSummary || "",
      summary: draft.externalEmployeeSummary || employeeDeclaration.objective || "",
      permissionScope: draft.permissionScope || "",
      serviceScope: draft.serviceScope || employeeDeclaration.serviceScope || "",
      permissionSummary: draft.permissionSummary || "",
      permissionClaims: cleanList(draft.permissionClaims),
      toolClaims: cleanList(draft.toolClaims),
      mountedSkillHints: cleanList(draft.mountedSkillHints),
      mountedSkillSummaries: summarizeMountedSkillHints(draft.mountedSkillHints),
      rules: cleanList(draft.rules || employeeDeclaration.rules),
      tools: cleanList(draft.tools || employeeDeclaration.tools),
      outputContract: draft.outputContract || employeeDeclaration.outputContract || "",
      employeeDeclaration: employeeDeclaration.name || employeeDeclaration.objective ? employeeDeclaration : null,
      assignedAiWorker: draft.assignedAiWorker || null,
      packageBoundary: draft.packageBoundary || null,
      packageRecordBoundary: draft.packageRecordBoundary || draft.packageBoundary?.boundarySummary || "",
      packageIntake: draft.packageIntake || null,
      packageAnalysisSummary: draft.packageAnalysisSummary || "",
      reviewDecision: displayEmployeeReviewDecision(reviewRecord),
      personnelApproval: reviewRecord.personnelApproval,
      trialActivation: reviewRecord.trialActivation,
      createdAt: job.createdAt,
      updatedAt: job.updatedAt,
      privacyBoundary: draft.privacyBoundary || "人员审批只返回外部数字员工安全摘要；不返回 raw prompt、执行 payload、凭证、客户数据或员工 PII。",
    };
  }

  function summarizeCatalogEmployeeReviewDraft(employee, { includeCompleted = false } = {}) {
    if (!employee || employee.level === "系统级") return null;
    const state = resolvedMvpStateForCatalogEmployee(employee) || {};
    const job = catalogEmployeeReviewJob(employee, state);
    const draft = catalogEmployeeReviewDraft(employee, state);
    if (includeCompleted) {
      if (!isApprovedEmployeeReviewDraft(draft)) return null;
    } else if (!isPendingEmployeeReviewDraft(draft)) {
      return null;
    }
    return summarizeEmployeeReviewDraft(job, "catalogBusinessEmployee", draft);
  }

  function findCatalogEmployeeReviewDraft(jobId, draftIdValue) {
    if (!String(jobId || "").startsWith("CATALOG-BUSINESS-EMPLOYEE-")) return null;
    const employee = digitalEmployees.find((item) => catalogEmployeeReviewJobId(item) === jobId);
    if (!employee) return null;
    const state = resolvedMvpStateForCatalogEmployee(employee) || {};
    const draft = catalogEmployeeReviewDraft(employee, state);
    if (draft.draftId !== draftIdValue) return null;
    return {
      source: "catalog",
      job: catalogEmployeeReviewJob(employee, state),
      kind: "catalogBusinessEmployee",
      draft,
    };
  }

  function catalogEmployeeReviewJob(employee, state = {}) {
    const status = employeeLifecycleStatus(employee, state);
    return {
      jobId: catalogEmployeeReviewJobId(employee),
      pipelineId: "catalog-business-employee-review",
      sourceRef: employee.sourceTargets?.[0] || `catalog://digital-employees/${employee.id}`,
      status,
      createdAt: employee.version || "",
      updatedAt: state.updatedAt || employee.version || "",
      reviewGate: employee.reviewGate,
      drafts: {},
    };
  }

  function catalogEmployeeReviewDraft(employee, state = {}) {
    return {
      draftId: catalogEmployeeReviewDraftId(employee),
      externalEmployeeId: employee.id,
      employeeId: employee.id,
      name: employee.name,
      title: employee.title,
      sourceRef: employee.sourceTargets?.[0] || `catalog://digital-employees/${employee.id}`,
      level: employee.level || "业务级",
      departmentId: employee.departmentId,
      departmentSource: "catalog",
      ownerHint: employee.owner || "",
      status: employeeLifecycleStatus(employee, state),
      versionIntent: employee.version || "catalog",
      externalEmployeeSummary: employee.objective || "",
      permissionScope: employee.permissionScope || "",
      serviceScope: employee.serviceScope || "",
      permissionSummary: employee.permissionSummary || "",
      permissionClaims: cleanList(employee.constraints),
      toolClaims: cleanList(employee.tools),
      mountedSkillHints: cleanList(employee.businessSkillIds || employee.packageBundleSkillIds),
      rules: cleanList(employee.rules || employee.constraints),
      tools: cleanList(employee.tools),
      outputContract: employee.outputContract || employee.reviewOutputSpec?.contractVersion || "",
      businessGroupRecommendation: employee.businessGroup || employee.businessDomain || employee.capabilityLine ? {
        groupId: cleanEntityId(employee.businessGroup || employee.businessDomain || employee.departmentId || "catalog-business-employee"),
        label: cleanText(employee.businessGroup || employee.businessDomain || employee.department || "待确认业务组"),
        domainLabel: cleanText(employee.skillCluster || employee.businessDomain || ""),
        teamLabel: cleanText(employee.capabilityLine || ""),
        confidence: 1,
        source: "catalog",
        rationale: "目录态员工已有业务归属字段。",
      } : null,
      businessGroupId: cleanText(employee.businessGroupId || employee.businessDomain || ""),
      businessGroup: cleanText(employee.businessGroup || employee.businessDomain || ""),
      domain: cleanText(employee.skillCluster || employee.businessDomain || ""),
      assignedAiWorker: employee.runtimeBinding?.assignedAiWorker ? {
        workerId: employee.runtimeBinding.assignedAiWorker,
        lane: employee.runtimeBinding.workerLane,
        credentialLeasePolicy: employee.runtimeBinding.credentialLeasePolicy,
      } : null,
      packageBoundary: employee.packageBoundary || null,
      packageRecordBoundary: employee.packageRecordBoundary || employee.packageBoundary?.boundarySummary || "",
      reviewDecision: state.reviewDecision || null,
      personnelApproval: state.personnelApproval || null,
      trialActivation: state.trialActivation || null,
      reviewGate: employee.reviewGate || "人员审批确认员工归属、权限范围、运行链路、输出契约和停用策略。",
      privacyBoundary: "目录态业务员工审批只返回安全治理摘要；不返回 raw prompt、执行 payload、凭证、客户数据或员工 PII。",
    };
  }

  function catalogEmployeeReviewJobId(employee) {
    return `CATALOG-BUSINESS-EMPLOYEE-${cleanEntityId(employee.id)}`;
  }

  function catalogEmployeeReviewDraftId(employee) {
    return `CATALOG-EED-${cleanEntityId(employee.id)}`;
  }

  function resolvedMvpStateForCatalogEmployee(employee = {}) {
    const directState = mvpDigitalEmployeeStates.get(employee.id) || null;
    const aliasState = [...mvpDigitalEmployeeStates.values()]
      .filter((state) => state?.employeeId !== employee.id)
      .filter((state) => mvpStateMatchesCatalogEmployee(state, employee))
      .reduce((latest, state) => latestMvpState(latest, state), null);
    return latestMvpState(directState, aliasState);
  }

  function catalogEmployeeForMvpState(state = {}) {
    const employeeId = cleanEntityId(state.employeeId || state.employee?.id || "");
    const directEmployee = digitalEmployees.find((employee) => employee.id === employeeId);
    if (directEmployee) return directEmployee;
    return digitalEmployees.find((employee) => mvpStateMatchesCatalogEmployee(state, employee)) || null;
  }

  function catalogEmployeeForReviewDraft(draft = {}) {
    const employeeId = cleanEntityId(draft.externalEmployeeId || draft.employeeId || draft.id || "");
    const directEmployee = digitalEmployees.find((employee) => employee.id === employeeId);
    if (directEmployee) return directEmployee;
    const draftState = {
      employeeId,
      sourceRef: draft.sourceRef,
      employee: {
        sourceRef: draft.sourceRef,
        sourceTargets: cleanList([draft.sourceRef]),
      },
    };
    return digitalEmployees.find((employee) => mvpStateMatchesCatalogEmployee(draftState, employee)) || null;
  }

  function mvpStateMatchesCatalogEmployee(state = {}, employee = {}) {
    const stateSourceRefs = sourceRefKeys([
      state.sourceRef,
      state.employee?.sourceRef,
      ...(state.employee?.sourceTargets || []),
    ]);
    if (!stateSourceRefs.length) return false;
    const catalogSourceRefs = new Set(sourceRefKeys([
      employee.sourceRef,
      ...(employee.sourceTargets || []),
    ]));
    return stateSourceRefs.some((sourceRef) => catalogSourceRefs.has(sourceRef));
  }

  function sourceRefKeys(values = []) {
    return cleanList(values).map(sourceRefKey).filter(Boolean);
  }

  function sourceRefKey(value) {
    const text = cleanText(value).toLowerCase();
    if (!/^[a-z][a-z0-9+.-]*:\/\//.test(text)) return "";
    return text.replace(/\s+/g, "");
  }

  function latestMvpState(left, right) {
    if (!left) return right || null;
    if (!right) return left;
    const leftTime = cleanText(left.updatedAt || left.trialActivation?.activatedAt || left.personnelApproval?.approvedAt || "");
    const rightTime = cleanText(right.updatedAt || right.trialActivation?.activatedAt || right.personnelApproval?.approvedAt || "");
    return rightTime.localeCompare(leftTime) > 0 ? right : left;
  }

  function isSourceRegistrationDraft(draft = {}) {
    return draft.intakeKind === "skill_package_source_registration";
  }

  function employeeApprovalPassed(stateOrDraft = {}) {
    const record = stateOrDraft || {};
    return record.personnelApproval?.status === "personnel_approval_passed"
      || record.reviewDecision?.status === "在线"
      || (record.reviewDecision?.decision === "approved" && ["approve_personnel", "start_trial"].includes(record.reviewDecision?.action));
  }

  function employeeLifecycleStatus(employee = {}, state = {}) {
    const record = state || {};
    const catalogEmployee = employee || {};
    const status = cleanText(record.status || catalogEmployee.status || "");
    if (employeeApprovalPassed(record) && ["人员审批通过", "试运行", "在线"].includes(status)) return "试运行";
    if (status === "人员审批通过") return "试运行";
    return status;
  }

  function isPendingEmployeeReviewDraft(draft = {}) {
    return ["待人员审批", "pending_review", "mvp_review_rejected"].includes(draft.status);
  }

  function isApprovedEmployeeReviewDraft(draft = {}) {
    return employeeApprovalPassed(draft);
  }

  function trialEmployeeNextGate() {
    return "人员审批已通过，数字员工进入试运行；员工声明的上线门禁全部通过且没有阻塞项后，生命周期才会收敛为在线。";
  }

  function displayEmployeeReviewDecision(draft = {}) {
    if (!draft.reviewDecision) return null;
    if (!employeeApprovalPassed(draft)) return draft.reviewDecision;
    return {
      ...draft.reviewDecision,
      status: "试运行",
      nextGate: trialEmployeeNextGate(),
      workflowEffect: draft.reviewDecision.workflowEffect === "start_trial" ? "approve_personnel" : draft.reviewDecision.workflowEffect,
    };
  }

  function normalizeEmployeeReviewAction(input = {}) {
    const action = cleanText(input.action || "").toLowerCase();
    if (["start_trial", "enter_trial", "trial", "run_trial", "进入试运行", "试运行"].includes(action)) return "approve_personnel";
    const decision = normalizeReviewDecision(input.decision);
    if (decision === "approved") return "approve_personnel";
    if (decision === "rejected") return "reject_personnel";
    return "";
  }

  function statusForEmployeeReviewAction(action) {
    if (action === "approve_personnel") return "试运行";
    return "mvp_review_rejected";
  }

  function statusForEmployeeReviewRecord(action) {
    if (action === "approve_personnel") return "personnel_approval_passed";
    return "mvp_review_rejected";
  }

  function nextGateForEmployeeReviewAction(action) {
    if (action === "approve_personnel") return trialEmployeeNextGate();
    return "退回补齐归属、权限范围、运行链路、输出契约或停用策略后重新提交人员审批。";
  }

  function defaultEmployeeReviewNote(action, draft = {}) {
    const name = draft.name || draft.externalEmployeeId || draft.employeeId || "该数字员工";
    if (action === "approve_personnel") return `确认 ${name} 的归属、权限范围、输出契约和停用边界，人员审批通过并进入试运行。`;
    return `退回 ${name}，需补齐人员审批所需的归属、权限、运行链路或停用策略。`;
  }

  function defaultEmployeeCheckedItems(action) {
    return ["归属部门", "业务 owner", "权限范围", "运行链路", "输出契约", "挂载 Skill 状态", "停用策略"];
  }

  function upsertMvpDigitalEmployeeState({ source, job, draft, review, action, decidedAt }) {
    const employeeId = cleanEntityId(draft.externalEmployeeId || draft.employeeId || draft.id || draft.name);
    const current = mvpDigitalEmployeeStates.get(employeeId) || {};
    const next = {
      ...current,
      employeeId,
      status: draft.status,
      source: source === "catalog" ? "catalog" : "importJob",
      sourceJobId: job.jobId,
      sourceDraftId: draft.draftId,
      reviewDecision: draft.reviewDecision || null,
      updatedAt: decidedAt,
    };
    if (action === "approve_personnel") {
      next.personnelApproval = {
        reviewId: review.reviewId,
        status: "personnel_approval_passed",
        approvedAt: decidedAt,
        approvedBy: review.decidedBy,
        safeNotes: review.safeNotes,
      };
    }
    if (action === "reject_personnel") {
      next.personnelApproval = {
        reviewId: review.reviewId,
        status: "mvp_review_rejected",
        decidedAt,
        decidedBy: review.decidedBy,
        safeNotes: review.safeNotes,
      };
      next.trialActivation = null;
    }
    if (source !== "catalog") {
      next.employee = mvpDigitalEmployeeFromDraft(draft, next);
    }
    mvpDigitalEmployeeStates.set(employeeId, next);
    return next;
  }

  function mvpDigitalEmployeeFromDraft(draft, state = {}) {
    const employeeId = cleanEntityId(draft.externalEmployeeId || draft.employeeId || draft.id || draft.name);
    const departmentId = cleanText(draft.departmentId || draft.targetDepartmentId || "pending-owner-department");
    const declaration = draft.employeeDeclaration || {};
    return {
      id: employeeId,
      name: cleanText(declaration.name || draft.name || employeeId),
      title: cleanText(declaration.title || draft.title || "外部业务数字员工"),
      departmentId,
      department: departmentLabelForId(departmentId),
      level: draft.level || "业务级",
      status: state.status || draft.status,
      version: cleanText(draft.versionIntent || `mvp-${new Date().toISOString().slice(0, 10)}`),
      owner: cleanText(draft.ownerHint || "待业务 Owner 确认"),
      ownerDepartmentId: departmentId,
      responsibilityAssignments: declaration.responsibilityAssignments || null,
      permissionScope: cleanText(draft.permissionScope || "department_governed"),
      serviceScope: ["personal", "department", "enterprise"].includes(draft.serviceScope || declaration.serviceScope) ? (draft.serviceScope || declaration.serviceScope) : "",
      permissionSummary: cleanText(draft.permissionSummary || "人员审批确认后的部门受控在线资格。"),
      promptVersion: cleanText(declaration.promptMetadata?.version || "employee-import.v1"),
      promptScope: `employee:${employeeId}`,
      promptGovernance: {
        ...(declaration.promptMetadata || {}),
        rawPromptStored: false,
      },
      runtimeBinding: {
        runtimeAdapter: "responses_api",
        preferredProviderRouteId: "codex-digital-office-route",
        agentRuntimeId: `${employeeId}-runtime`,
        workerLane: `${employeeId}-runtime`,
        workerPoolMode: "runtime_allocated",
        credentialLeasePolicy: "server_managed_per_turn",
        consumesSharedWorkerQuota: true,
        ...(declaration.runtimeBinding || {}),
        runtimeAdapter: normalizeRuntimeAdapterId(declaration.runtimeBinding?.runtimeAdapter || "responses_api"),
        agentRuntimeId: normalizeAgentRuntimeId(declaration.runtimeBinding?.agentRuntimeId),
      },
      taskModelBindings: Array.isArray(declaration.taskModelBindings) ? declaration.taskModelBindings : [],
      configuredFunctions: Array.isArray(declaration.configuredFunctions) ? declaration.configuredFunctions : [],
      identityBoundaries: cleanList(declaration.identityBoundaries),
      identitySourceRefs: cleanList(declaration.identitySourceRefs),
      toolBindings: (Array.isArray(declaration.toolBindings) ? declaration.toolBindings : []).map((binding) => ({
        ...binding,
        id: binding.id || binding.toolId,
        enabled: false,
        status: "pending_action_review",
      })),
      scheduleBindings: (Array.isArray(declaration.scheduleBindings) ? declaration.scheduleBindings : []).map((binding) => ({
        ...binding,
        enabled: false,
        status: "pending_schedule_review",
      })),
      constraints: cleanList([...cleanList(draft.permissionClaims), ...cleanList(draft.rules)]),
      quality: { openBadcases: 0, rootCauseFocus: "在线调用质量反馈" },
      basicSkillIds: [],
      mountedSkillHints: cleanList(draft.mountedSkillHints),
      businessSkillIds: [],
      apiEndpoints: [],
      sourceTargets: cleanList([draft.sourceRef]),
      objective: cleanText(declaration.objective || draft.externalEmployeeSummary || ""),
      outputContract: cleanText(draft.outputContract || declaration.outputContract || ""),
      writebackBoundary: cleanText(declaration.writebackBoundary || "none_without_action_level_approval"),
      uiDisplayContract: {
        channelNeutral: true,
        primarySurface: "managed_employee_chat",
        channelRole: "input_output_transport",
        ...(declaration.uiDisplayContract || {}),
      },
      runtimeReadiness: {
        personnelApproval: state.personnelApproval?.status || "pending",
        modelBinding: "control_plane_required",
        toolBinding: "action_level_governed",
        skillMount: "approved_mounts_only",
      },
      reviewGate: cleanText(draft.reviewGate || "人员审批通过后进入试运行；全部声明上线门禁通过后才收敛为在线。"),
      mvpPersonnelApproval: state.personnelApproval || null,
      mvpTrialActivation: state.trialActivation || null,
      productionEffect: "none",
      privacyBoundary: "MVP 业务数字员工只保存安全治理摘要；不保存 raw prompt、执行 payload、凭证、客户数据或员工 PII。",
    };
  }

  function summarizeCatalogSkillReviewDraft(skill) {
    if (!skill || skill.status !== "待技能评审") return null;
    const state = catalogSkillReviewStates.get(skill.id) || {};
    if (state.status && state.status !== "待技能评审") return null;
    const job = catalogSkillReviewJob(skill, state);
    const draft = catalogSkillReviewDraft(skill, state);
    return summarizeSkillReviewDraft(job, catalogSkillReviewKind(skill), draft);
  }

  function findCatalogSkillReviewDraft(jobId, draftIdValue) {
    if (!/^CATALOG-(BASIC|BUSINESS)-SKILL-/.test(String(jobId || ""))) return null;
    const skill = [...basicSkills, ...businessSkills].find((item) => catalogSkillReviewJobId(item) === jobId);
    if (!skill) return null;
    const state = catalogSkillReviewStates.get(skill.id) || {};
    const draft = catalogSkillReviewDraft(skill, state);
    if (draft.draftId !== draftIdValue) return null;
    return {
      source: "catalog",
      job: catalogSkillReviewJob(skill, state),
      kind: catalogSkillReviewKind(skill),
      draft,
    };
  }

  function catalogSkillReviewJob(skill, state = {}) {
    const isBasicSkill = catalogSkillReviewKind(skill) === "catalogBasicSkill";
    return {
      jobId: catalogSkillReviewJobId(skill),
      pipelineId: isBasicSkill ? "catalog-basic-skill-review" : "catalog-business-skill-review",
      sourceRef: skill.sourceRef || `catalog://${isBasicSkill ? "basic-skills" : "business-skills"}/${skill.id}`,
      status: state.status || skill.status,
      createdAt: skill.version || "",
      updatedAt: state.updatedAt || skill.version || "",
      reviewGate: skill.reviewGate,
      drafts: {},
    };
  }

  function catalogSkillReviewDraft(skill, state = {}) {
    const isBasicSkill = catalogSkillReviewKind(skill) === "catalogBasicSkill";
    return {
      draftId: catalogSkillReviewDraftId(skill),
      kind: isBasicSkill ? "catalog_basic_skill_review" : "catalog_business_skill_review",
      skillId: skill.id,
      skillApiId: skill.skillApiId || skill.id,
      sourceSkillId: skill.sourceSkillId || "",
      name: skill.name || skill.id,
      sourceRef: skill.sourceRef || `catalog://${isBasicSkill ? "basic-skills" : "business-skills"}/${skill.id}`,
      targetDepartmentId: skill.departmentId,
      businessGroupRecommendation: skill.businessGroupRecommendation || {
        groupId: cleanEntityId(skill.businessGroupId || skill.domain || skill.category || skill.departmentId || skill.ownerDepartmentId || "catalog-skill-group"),
        label: cleanText(skill.businessGroup || skill.domain || skill.category || "待确认技能组"),
        confidence: 1,
        source: "catalog",
        rationale: isBasicSkill ? "目录内基础 Skill 已有分类字段。" : "目录内已有业务组/领域字段。",
        nextGate: isBasicSkill ? "目录态基础 Skill 沿用现有分类；变更需走技能评审。" : "目录态 Skill 沿用现有业务组；变更需走业务组显示名草案。",
      },
      businessGroupId: skill.businessGroupId || cleanEntityId(skill.domain || skill.category || skill.departmentId || skill.ownerDepartmentId || "catalog-skill-group"),
      businessGroup: skill.businessGroup || skill.domain || skill.category || "",
      domain: skill.domain || skill.category || "",
      ownerHint: skill.owner || "",
      status: state.status || skill.status,
      versionIntent: skill.version || "catalog",
      manifestSummary: skill.description || "",
      declaredInputs: cleanList(skill.inputs),
      declaredOutputs: cleanList(skill.outputs),
      tools: cleanList(skill.tools),
      constraints: cleanList(skill.constraints),
      executionGuidance: cleanList(skill.executionGuidance),
      runtimeInstructions: safeRuntimeInstructions(skill.runtimeInstructions),
      runtimeReferences: safeRuntimeReferences(skill.runtimeReferences),
      runtimeExecutionProfile: resolveSkillRuntimeExecutionProfile(skill),
      risk: skill.risk || "",
      reviewGate: skill.reviewGate || "",
      mountHints: cleanList(skill.mountedEmployeeIds || skill.mountedDigitalEmployees),
      promptGovernance: {
        rawPromptStored: false,
        promptVersion: skill.promptGovernance?.promptVersion || skill.promptVersion || "",
        promptHash: skill.promptGovernance?.promptHash || skill.promptHash || "",
        requiredBeforePublish: true,
      },
      existingSkill: {
        id: skill.id,
        version: skill.version || "",
        status: skill.status,
        source: isBasicSkill ? "basicSkills catalog" : "businessSkills catalog",
      },
      mvpPublication: state.mvpPublication || null,
      agentPreReview: state.agentPreReview || null,
      reviewDecision: state.reviewDecision || null,
      privacyBoundary: isBasicSkill
        ? "目录态基础 Skill 只返回安全治理摘要；不返回 raw prompt、私有 Skill payload、执行记录、凭证或客户/员工敏感数据。"
        : "目录态业务 Skill 只返回安全治理摘要；不返回 raw prompt、私有 Skill payload、执行记录、凭证或客户/员工敏感数据。",
    };
  }

  function catalogSkillReviewKind(skill = {}) {
    return basicSkills.some((item) => item.id === skill.id) ? "catalogBasicSkill" : "catalogBusinessSkill";
  }

  function catalogSkillReviewJobId(skill) {
    const kind = catalogSkillReviewKind(skill) === "catalogBasicSkill" ? "BASIC" : "BUSINESS";
    return `CATALOG-${kind}-SKILL-${cleanEntityId(skill.id)}`;
  }

  function catalogSkillReviewDraftId(skill) {
    return `CATALOG-SKD-${cleanEntityId(skill.id)}`;
  }

  function createMvpSkillPublication({ job, draft, review, session }) {
    const publicationId = draftId("MPUB", `${job.jobId}-${draft.skillId || draft.draftId}`);
    const publishedAt = new Date().toISOString();
    const runtimeExecutionProfile = requireSkillRuntimeExecutionProfile(
      draft.runtimeExecutionProfile ? { runtimeExecutionProfile: draft.runtimeExecutionProfile } : draft,
    );
    const publication = {
      publicationId,
      status: "mvp_skill_published",
      runtimeEligibility: { allowed: true, reason: "mvp_skill_review_approved" },
      runtimeExecutionProfile,
      runtimeHarnessIdentity: draft.runtimeHarnessIdentity || null,
      runtimeHarnessArtifact: draft.runtimeHarnessArtifact || null,
      contractVersion: "mvp_skill_publication.v1",
      skillId: draft.skillId,
      skillApiId: draft.skillApiId || draft.skillId,
      sourceSkillId: draft.sourceSkillId || "",
      name: draft.name || draft.skillId,
      version: cleanText(resolveMvpSkillVersion({
        versionIntent: draft.skillPackageIdentity?.version || draft.versionIntent,
        targetVersion: draft.targetVersion,
        publishedAt,
      })),
      sourceRef: job.sourceRef,
      sourceJobId: job.jobId,
      sourceDraftId: draft.draftId,
      reviewId: review.reviewId,
      publishedAt,
      publishedBy: session.employeeId,
      targetDepartmentId: draft.targetDepartmentId,
      businessGroupRecommendation: draft.businessGroupRecommendation || null,
      businessGroupId: cleanText(draft.businessGroupId || draft.businessGroupRecommendation?.groupId || ""),
      businessGroup: cleanText(draft.businessGroup || draft.businessGroupRecommendation?.label || ""),
      domain: cleanText(draft.domain || draft.businessGroupRecommendation?.domainLabel || draft.businessGroupRecommendation?.label || ""),
      packageFormat: draft.packageFormat || "",
      packageBoundary: draft.packageBoundary || null,
      installGranularity: draft.installGranularity || "",
      packageBundleSkillIds: cleanList(draft.packageBundleSkillIds),
      dependencySkillIds: cleanList(draft.dependencySkillIds),
      apiDependencySkillIds: cleanList(draft.apiDependencySkillIds),
      referenceSkillIds: cleanList(draft.referenceSkillIds),
      declaredInputs: cleanList(draft.declaredInputs),
      declaredOutputs: cleanList(draft.declaredOutputs),
      tools: cleanList(draft.tools),
      constraints: cleanList(draft.constraints),
      executionGuidance: cleanList(draft.executionGuidance),
      runtimeInstructions: safeRuntimeInstructions(draft.runtimeInstructions),
      runtimeReferences: safeRuntimeReferences(draft.runtimeReferences),
      promptGovernance: {
        rawPromptStored: false,
        promptVersion: draft.promptGovernance?.promptVersion || "",
        promptHash: draft.promptGovernance?.promptHash || "",
        requiredBeforeProductionPublish: true,
      },
      nextGate: "MVP 可见发布记录已生成；正式上线仍需持久化目录、版本发布、分发审核、RBAC 和审计日志。",
      productionEffect: "none",
      privacyBoundary: "MVP publication stores safe Skill contract metadata only. It does not store raw prompts, private payloads, execution records, credentials, customer data, or employee PII.",
    };
    mvpSkillPublications.set(publicationId, publication);
    return publication;
  }

  function upsertPublishedBusinessSkill({ publication, draft, review, job }) {
    if (!publication || !draft) return null;
    const skillId = cleanEntityId(draft.skillId || publication.skillId || draft.draftId);
    const existingSkill = skillById.get(skillId) || {};
    const departmentId = cleanText(draft.targetDepartmentId || publication.targetDepartmentId || existingSkill.departmentId || "pending-owner-department");
    const businessGroupRecommendation = draft.businessGroupRecommendation || publication.businessGroupRecommendation || recommendBusinessGroup({
      input: {
        businessGroup: existingSkill.businessGroup || existingSkill.domain || publication.businessGroup || publication.domain,
        skillName: publication.name || draft.name || existingSkill.name,
        sourceSkillId: publication.sourceSkillId || draft.sourceSkillId || existingSkill.sourceSkillId,
        manifestSummary: draft.manifestSummary || existingSkill.description,
      },
      sourceRef: publication.sourceRef || job.sourceRef || draft.sourceRef || existingSkill.sourceRef,
      departmentId,
      existingSkill,
    });
    const publishedSkill = {
      ...existingSkill,
      id: skillId,
      skillApiId: cleanText(publication.skillApiId || draft.skillApiId || existingSkill.skillApiId || skillId),
      sourceSkillId: cleanText(publication.sourceSkillId || draft.sourceSkillId || existingSkill.sourceSkillId || ""),
      skillPackageIdentity: draft.skillPackageIdentity || publication.skillPackageIdentity || existingSkill.skillPackageIdentity || null,
      runtimeHarnessIdentity: draft.runtimeHarnessIdentity || publication.runtimeHarnessIdentity || existingSkill.runtimeHarnessIdentity || null,
      runtimeHarnessArtifact: draft.runtimeHarnessArtifact || publication.runtimeHarnessArtifact || null,
      runtimeExecutionProfile: requireSkillRuntimeExecutionProfile({
        runtimeExecutionProfile: publication.runtimeExecutionProfile
          || draft.runtimeExecutionProfile
          || existingSkill.runtimeExecutionProfile,
      }),
      lineageKey: cleanText(draft.lineageKey || publication.sourceSkillId || publication.skillApiId || skillId),
      name: cleanText(publication.name || draft.name || existingSkill.name || skillId),
      originalName: cleanText(existingSkill.originalName || ""),
      businessGroupRecommendation,
      businessGroupId: cleanText(existingSkill.businessGroupId || draft.businessGroupId || publication.businessGroupId || businessGroupRecommendation.groupId),
      businessGroup: cleanText(existingSkill.businessGroup || draft.businessGroup || publication.businessGroup || businessGroupRecommendation.label),
      domain: cleanText(existingSkill.domain || draft.domain || publication.domain || businessGroupRecommendation.domainLabel || businessGroupRecommendation.label || "待确认业务组"),
      departmentId,
      department: cleanText(existingSkill.department || departmentLabelForId(departmentId)),
      owner: cleanText(existingSkill.owner || draft.ownerHint || "待业务 Owner 确认"),
      version: cleanText(resolveMvpSkillVersion({
        versionIntent: publication.version,
        targetVersion: existingSkill.version,
        publishedAt: publication.publishedAt,
      })),
      status: "mvp_skill_published",
      runtimeEligibility: publication.runtimeEligibility || { allowed: true, reason: "mvp_skill_review_approved" },
      risk: cleanText(draft.risk || existingSkill.risk || "待评估"),
      reviewGate: cleanText(draft.reviewGate || existingSkill.reviewGate || "技能/员工评审已通过；生产发布仍需 RBAC、审计和分发审核。"),
      promptVersion: cleanText(draft.promptGovernance?.promptVersion || existingSkill.promptVersion || ""),
      promptGovernance: {
        ...(existingSkill.promptGovernance || {}),
        rawPromptStored: false,
        promptScope: existingSkill.promptGovernance?.promptScope || `business-skill:${skillId}`,
        promptVersion: cleanText(draft.promptGovernance?.promptVersion || existingSkill.promptGovernance?.promptVersion || ""),
        promptHash: cleanText(draft.promptGovernance?.promptHash || existingSkill.promptGovernance?.promptHash || ""),
        requiredBeforeProductionPublish: true,
      },
      constraints: cleanList(draft.constraints || existingSkill.constraints),
      executionGuidance: cleanList(draft.executionGuidance || publication.executionGuidance || existingSkill.executionGuidance),
      runtimeInstructions: safeRuntimeInstructions(draft.runtimeInstructions || publication.runtimeInstructions || existingSkill.runtimeInstructions),
      runtimeReferences: safeRuntimeReferences(draft.runtimeReferences || publication.runtimeReferences || existingSkill.runtimeReferences),
      badcaseCount: existingSkill.badcaseCount || 0,
      rootCauseFocus: cleanText(existingSkill.rootCauseFocus || "MVP 发布后收集质量反馈"),
      mountedBasicSkills: cleanList(existingSkill.mountedBasicSkills),
      linkedSkillIds: cleanList(draft.linkedSkillIds || existingSkill.linkedSkillIds),
      dependencySkillIds: cleanList(draft.dependencySkillIds || publication.dependencySkillIds || existingSkill.dependencySkillIds),
      referenceSkillIds: cleanList(draft.referenceSkillIds || publication.referenceSkillIds || existingSkill.referenceSkillIds),
      skillPackage: cleanText(draft.skillPackage || existingSkill.skillPackage || ""),
      packageFormat: cleanText(publication.packageFormat || draft.packageFormat || existingSkill.packageFormat || ""),
      packageCompleteness: cleanText(draft.packageCompleteness || existingSkill.packageCompleteness || ""),
      packageIncludes: cleanList(draft.packageIncludes || existingSkill.packageIncludes),
      packageBoundary: publication.packageBoundary || draft.packageBoundary || existingSkill.packageBoundary || null,
      packageRecordBoundary: cleanText(draft.packageRecordBoundary || existingSkill.packageRecordBoundary || publication.packageBoundary?.boundarySummary || ""),
      downloadPolicy: draft.downloadPolicy || existingSkill.downloadPolicy || null,
      downloadUrl: cleanText(existingSkill.downloadUrl || ""),
      installGranularity: cleanText(draft.installGranularity || existingSkill.installGranularity || "package_skill_unit"),
      identityRule: cleanText(draft.identityRule || existingSkill.identityRule || "显示名可编辑；目录追溯使用 skillApiId/sourceSkillId/lineageKey。"),
      decompositionRule: cleanList(draft.decompositionRule || existingSkill.decompositionRule),
      dependencyPolicy: cleanList(draft.dependencyPolicy || existingSkill.dependencyPolicy),
      referencePolicy: cleanList(draft.referencePolicy || existingSkill.referencePolicy),
      unitCapabilityRule: cleanText(draft.unitCapabilityRule || existingSkill.unitCapabilityRule || "包内每个 SKILL.md 作为一个业务 Skill 单元评审。"),
      sourceRef: cleanText(publication.sourceRef || job.sourceRef || draft.sourceRef || existingSkill.sourceRef || ""),
      capabilities: cleanList(draft.capabilities || [draft.manifestSummary || existingSkill.description]).filter(Boolean),
      inputs: cleanList(draft.declaredInputs || existingSkill.inputs),
      outputs: cleanList(draft.declaredOutputs || existingSkill.outputs),
      tools: cleanList(draft.tools || existingSkill.tools),
      packageUnitPath: cleanText(draft.packageUnitPath || ""),
      references: cleanList([draft.packageUnitPath, ...(draft.references || [])]),
      referenceManifest: Array.isArray(draft.referenceManifest) ? draft.referenceManifest : existingSkill.referenceManifest || [],
      skillContentHash: cleanText(draft.skillContentHash || existingSkill.skillContentHash || ""),
      contractDigest: cleanText(draft.contractDigest || existingSkill.contractDigest || ""),
      description: cleanText(draft.manifestSummary || existingSkill.description || `${publication.name || skillId} 的外部 Skill 发布目录项。`),
      mvpPublication: summarizePublication(publication),
      reviewDecision: {
        reviewId: review.reviewId,
        decision: review.decision,
        decidedAt: review.decidedAt,
        decidedBy: review.decidedBy,
        safeNotes: review.safeNotes,
      },
      updatedAt: publication.publishedAt,
      productionEffect: "none",
      privacyBoundary: "运行期业务 Skill 目录项只保存评审后的安全 Skill 合同摘要和清洗后的 SKILL.md 指令体；不保存 raw prompt、私有 payload、执行记录、凭证、客户数据或员工 PII。",
    };
    publishedBusinessSkills.set(skillId, publishedSkill);
    skillById.set(skillId, publishedSkill);
    return publishedSkill;
  }

  function reconcilePublishedBusinessSkillHeads() {
    let changed = false;
    const publicationsBySkillId = new Map();
    for (const publication of mvpSkillPublications.values()) {
      const skillId = cleanEntityId(publication?.skillId || "");
      if (!skillId) continue;
      const publications = publicationsBySkillId.get(skillId) || [];
      publications.push(publication);
      publicationsBySkillId.set(skillId, publications);
    }

    for (const [skillId, publications] of publicationsBySkillId.entries()) {
      const activated = publications.filter((item) => item.status === "mvp_skill_published" && item.activationSequence && item.skillSnapshot)
        .sort((a, b) => b.activationSequence - a.activationSequence)[0];
      if (activated) {
        if (publishedBusinessSkills.get(skillId)?.mvpPublication?.publicationId !== activated.publicationId) {
          publishedBusinessSkills.set(skillId, structuredClone(activated.skillSnapshot));
          skillById.set(skillId, publishedBusinessSkills.get(skillId));
          changed = true;
        }
        continue;
      }
      const draftByPublicationId = new Map();
      const jobByPublicationId = new Map();
      for (const publication of publications) {
        const job = importJobs.get(publication.sourceJobId);
        const draft = job
          ? draftRefsForJob(job).find(({ draft: candidate }) => candidate.draftId === publication.sourceDraftId)?.draft
          : null;
        if (!job || !draft) continue;
        draftByPublicationId.set(publication.publicationId, draft);
        jobByPublicationId.set(publication.publicationId, job);
      }
      const staticSkill = businessSkills.find((skill) => cleanEntityId(skill.id) === skillId);
      const head = selectSkillPublicationHead({
        publications,
        resolveDraft: (publication) => draftByPublicationId.get(publication.publicationId) || null,
        baselineVersion: staticSkill?.version || "",
      });
      if (!head) continue;
      const currentSkill = publishedBusinessSkills.get(skillId);
      if (currentSkill?.mvpPublication?.publicationId
        && !draftByPublicationId.has(currentSkill.mvpPublication.publicationId)) continue;
      if (currentSkill?.mvpPublication?.publicationId === head.publication.publicationId) continue;
      const job = jobByPublicationId.get(head.publication.publicationId);
      const review = skillEmployeeReviews.get(head.publication.reviewId);
      if (!job || !review) continue;
      upsertPublishedBusinessSkill({
        publication: head.publication,
        draft: head.draft,
        review,
        job,
      });
      changed = true;
    }
    return { changed };
  }

  function requireSkillRuntimeExecutionProfile(skill = {}) {
    const profile = resolveSkillRuntimeExecutionProfile(skill);
    if (!profile) throw new Error("skill_runtime_execution_profile_required");
    return profile;
  }

  function safeRuntimeInstructions(value = null) {
    if (!value || typeof value !== "object" || value.contractVersion !== "skill-runtime-instructions.v1") return null;
    const content = cleanInstructionText(value.content).slice(0, 64 * 1024);
    if (!content) return null;
    return {
      contractVersion: value.contractVersion,
      source: cleanText(value.source),
      content,
      contentHash: cleanText(value.contentHash),
      sourceHash: cleanText(value.sourceHash),
      sectionHeadings: cleanList(value.sectionHeadings).slice(0, 16),
      truncated: value.truncated === true,
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
          source: cleanText(reference.source),
          path: cleanText(reference.path),
          content,
          contentHash: cleanText(reference.contentHash),
          sourceHash: cleanText(reference.sourceHash),
          sectionHeadings: cleanList(reference.sectionHeadings).slice(0, 16),
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

  function summarizePublication(publication) {
    if (!publication) return null;
    return {
      publicationId: publication.publicationId,
      status: publication.status,
      skillId: publication.skillId,
      skillApiId: publication.skillApiId,
      version: publication.version,
      publishedAt: publication.publishedAt,
      runtimeEligibility: publication.runtimeEligibility,
      runtimeExecutionProfile: publication.runtimeExecutionProfile,
      nextGate: publication.nextGate,
      deployment: publication.deployment || null,
    };
  }

  return {
    handle,
    listRuntimeBusinessSkills,
    listRuntimeDigitalEmployees,
    reconcilePublishedBusinessSkillHeads,
    summarizeSkillReviewDraft,
  };
}
