import {
  algorithmClusterSkillIds,
  knownAlgorithmSkillMeta,
  normalizeSystemImportSkillId,
  portablePackageBoundary,
} from "./system-import-skill-catalog.mjs";
import {
  createSkillAgentPreReviewService,
} from "./skill-agent-pre-review.mjs";
import { analyzePackageInput, packageIntakeBoundary } from "./skill-package-intake.mjs";
import { createBusinessGroupResolver } from "./system-import-business-groups.mjs";
import { createSystemImportDraftFactory } from "./system-import-draft-factory.mjs";
import { createEvaluationDatasetReviewHandlers } from "./evaluation-dataset-review-routes.mjs";
import { createSkillEmployeeReviewHandlers } from "./skill-employee-review-routes.mjs";
import { createAssetPackageDownloadHandlers } from "./asset-package-download-routes.mjs";
import {
  permissionWarningsForEmployeeDraft,
  preReviewFindings,
  reviewGateForPipeline,
} from "./system-import-policy-helpers.mjs";
import {
  defaultReviewNote,
  draftRefsForJob,
  isSkillPackageSourceRegistrationDraft,
  nextGateForReviewDecision,
  normalizeReviewDecision as normalizeReviewDecisionValue,
  personnelApprovalStatus,
  reviewKindForDraftRef,
  skillAutoReviewStatus,
  statusForReviewDecision,
  statusForReviewedJob,
  workflowEffectForReviewDecision,
} from "./system-import-review-helpers.mjs";
import {
  loadSystemImportStore,
  persistSystemImportStore,
  restoreSystemImportSnapshot as restorePersistedSystemImportSnapshot,
  systemImportSnapshot as createSystemImportSnapshot,
} from "./system-import-state-store.mjs";
import { isDraftSkillVersion, resolveMvpSkillVersion } from "./skill-version-helpers.mjs";
import { normalizeExternalEmployeeDeclaration } from "./external-employee-runtime-declaration.mjs";
import {
  createSkillRuntimeExecutionProfile,
  normalizeSkillRuntimeExecutionProfile,
} from "./agent-runtime/skill-runtime-profile.mjs";

const forbiddenPayloadKeys = new Set([
  "apikey",
  "api_key",
  "secret",
  "token",
  "password",
  "rawprompt",
  "raw_prompt",
  "rawpayload",
  "raw_payload",
  "modeltrace",
  "model_trace",
  "executionrecord",
  "execution_record",
  "privatepayload",
  "private_payload",
  "rawresume",
  "raw_resume",
  "ocrtext",
  "ocr_text",
  "customerdata",
  "customer_data",
  "employeepii",
  "employee_pii",
  "contactdetails",
  "contact_details",
]);

const safeImportWarning =
  "MVP endpoint returns a review draft in the current backend process; production still needs durable persistence and audit.";
const forbiddenDataWarning =
  "Raw prompts, AI payloads, execution records, credentials, customer data, employee PII, and private Skill payloads are not accepted.";
const packageReferenceOnlyWarning =
  "No package content was received; only sourceRef was recorded, so Agent pre-review will block until SKILL.md or manifest material is available.";
export function createSystemImportHandlers({
  assetPackageDownloadStore,
  basicSkills,
  businessSkills,
  cleanList,
  cleanText,
  digitalEmployees,
  externalAuditRequests,
  hasPermission,
  getSkillMountRequests = () => [],
  onPublishedBusinessSkillHead = null,
  preReviewWorkers = [],
  getPreReviewWorkers = () => preReviewWorkers,
  readJsonBody,
  requireSession,
  sendJson,
  systemImportStorePath = "",
  evaluationDatasetStorePath = "",
}) {
  const systemImportState = loadSystemImportStore(systemImportStorePath);
  const importJobs = new Map(Object.entries(systemImportState.importJobs || {}));
  const skillEmployeeReviews = new Map(Object.entries(systemImportState.skillEmployeeReviews || {}));
  const mvpSkillPublications = new Map(Object.entries(systemImportState.mvpSkillPublications || {}));
  const publishedBusinessSkills = new Map(Object.entries(systemImportState.publishedBusinessSkills || {}));
  const runtimeSkillProjections = new Map(Object.entries(systemImportState.runtimeSkillProjections || {}));
  const digitalEmployeeReviews = new Map(Object.entries(systemImportState.digitalEmployeeReviews || {}));
  const mvpDigitalEmployeeStates = new Map(Object.entries(systemImportState.mvpDigitalEmployeeStates || {}));
  const catalogSkillReviewStates = new Map(Object.entries(systemImportState.catalogSkillReviewStates || {}));
  const governedSkillById = new Map([...basicSkills, ...businessSkills].map((skill) => [skill.id, skill]));
  publishedBusinessSkills.forEach((skill, skillId) => governedSkillById.set(skillId, skill));
  const currentPreReviewWorkers = () => {
    const items = getPreReviewWorkers();
    return Array.isArray(items) ? items : preReviewWorkers;
  };
  const workerById = () => new Map(currentPreReviewWorkers().map((worker) => [worker.id, worker]));
  const workerByLane = () => new Map(currentPreReviewWorkers().map((worker) => [worker.lane, worker]));
  const {
    departmentLabelForId,
    firstBusinessGroupLabel,
    isExternalImportGroup,
    normalizeBusinessGroupRecommendation,
    recommendBusinessGroup,
  } = createBusinessGroupResolver({ cleanEntityId, cleanText });
  const {
    expandMountedSkillHints,
    harnessSourceKey,
    linkedSkillDraftsForExternalEmployee,
    sessionDepartmentId,
    skillDraftForKnownSkill,
  } = createSystemImportDraftFactory({
    algorithmClusterSkillIds,
    cleanEntityId,
    cleanList,
    cleanText,
    knownAlgorithmSkillMeta,
    packageIntakeBoundary,
    recommendBusinessGroup,
    skillById: governedSkillById,
  });
  const evaluationDatasetReviewHandlers = createEvaluationDatasetReviewHandlers({
    storePath: evaluationDatasetStorePath,
    cleanList,
    cleanText,
    draftId,
    findUnsafePayloadKeys,
    forbiddenDataWarning,
    readJsonBody,
    requirePermission,
    sendJson,
    unsafePayload,
  });
  const skillAgentPreReview = createSkillAgentPreReviewService({
    cleanList,
    cleanText,
    draftId,
    initialExecutions: systemImportState.agentPreReviewExecutions || {},
    initialQualityEvents: systemImportState.agentPreReviewQualityEvents || {},
    getPreReviewWorkers: currentPreReviewWorkers,
  });
  const skillEmployeeReviewHandlers = createSkillEmployeeReviewHandlers({
    basicSkills,
    businessSkills,
    catalogSkillReviewStates,
    cleanEntityId,
    cleanList,
    cleanText,
    departmentLabelForId,
    draftId,
    evaluationDatasetReviewHandlers,
    findUnsafePayloadKeys,
    importJobs,
    getSkillMountRequests,
    digitalEmployees,
    digitalEmployeeReviews,
    mvpSkillPublications,
    mvpDigitalEmployeeStates,
    normalizeReviewDecision,
    onPublishedBusinessSkillHead,
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
    skillById: governedSkillById,
    skillEmployeeReviews,
    systemImportSnapshot,
    systemImportStoreFailure,
    systemImportStorePath,
    unsafePayload,
  });
  const assetPackageDownloadHandlers = createAssetPackageDownloadHandlers({
    assetPackageDownloadStore,
    cleanList,
    cleanText,
    getBasicSkills: () => basicSkills,
    getBusinessSkills: skillEmployeeReviewHandlers.listRuntimeBusinessSkills,
    getDigitalEmployees: skillEmployeeReviewHandlers.listRuntimeDigitalEmployees,
    hasPermission,
    requireSession,
    sendJson,
  });
  const loadedStateMigration = migrateLoadedSystemImportState();
  const publishedSkillReconciliation = skillEmployeeReviewHandlers.reconcilePublishedBusinessSkillHeads();
  if (loadedStateMigration.changed || publishedSkillReconciliation.changed) {
    const persistResult = persistSystemImportState();
    if (!persistResult.ok) {
      console.warn(`[system-import] failed to persist loaded state migration: ${persistResult.error || "unknown_error"}`);
    }
  }
  async function handle(req, res, url) {
    if (req.method === "POST" && url.pathname === "/api/system-imports/skill-manifests") {
      await createSkillManifestImport(req, res);
      return true;
    }

    if (req.method === "POST" && url.pathname === "/api/system-imports/skill-updates") {
      await createSkillUpdateImport(req, res);
      return true;
    }

    if (req.method === "POST" && url.pathname === "/api/system-imports/external-digital-employees") {
      await createExternalDigitalEmployeeImport(req, res);
      return true;
    }

    if (req.method === "POST" && url.pathname === "/api/system-imports/requirements") {
      await createRequirementImport(req, res);
      return true;
    }

    if (req.method === "GET" && url.pathname === "/api/system-imports/jobs") {
      listImportJobs(req, res, url);
      return true;
    }

    const importJobMatch = url.pathname.match(/^\/api\/system-imports\/jobs\/([^/]+)$/);
    if (req.method === "GET" && importJobMatch) {
      getImportJob(req, res, importJobMatch[1]);
      return true;
    }

    const importJobReviewMatch = url.pathname.match(/^\/api\/system-imports\/jobs\/([^/]+)\/review$/);
    if (req.method === "POST" && importJobReviewMatch) {
      await reviewImportJob(req, res, importJobReviewMatch[1]);
      return true;
    }

    if (await skillEmployeeReviewHandlers.handle(req, res, url)) {
      return true;
    }

    if (await evaluationDatasetReviewHandlers.handle(req, res, url)) {
      return true;
    }

    if (assetPackageDownloadHandlers.handle(req, res, url)) {
      return true;
    }

    if (req.method === "GET" && url.pathname === "/api/ai-workers/pre-review") {
      listPreReviewWorkers(req, res, url);
      return true;
    }

    if (req.method === "POST" && url.pathname === "/api/ai-workers/pre-review/install-drafts") {
      await createPreReviewWorkerInstallDraft(req, res);
      return true;
    }

    const preReviewMatch = url.pathname.match(/^\/api\/external-audit-requests\/([^/]+)\/pre-review$/);
    if (req.method === "POST" && preReviewMatch) {
      await triggerExternalAuditPreReview(req, res, preReviewMatch[1]);
      return true;
    }

    return undefined;
  }

  async function createSkillManifestImport(req, res) {
    const session = requirePermission(req, res, "system-imports:edit");
    if (!session) return undefined;
    const previousState = systemImportSnapshot();
    const input = await readJsonBody(req);
    const unsafeKeys = findUnsafePayloadKeys(input);
    if (unsafeKeys.length) return unsafePayload(res, unsafeKeys);

    const sourceRef = cleanSourceRef(input.sourceRef || input.repoUrl || "repo://unknown/skill");
    if (hasUnsafeUrlSecret(sourceRef)) return unsafeSourceRef(res);

    const skillId = normalizeSkillManifestId(input, sourceRef);
    const knownSkill = knownAlgorithmSkillMeta(skillId);
    const name = cleanText(input.skillName || input.name || input.capabilityName || knownSkill.name || "待命名业务技能");
    const departmentId = cleanText(input.departmentId || input.ownerDepartmentId || "");
    const skillKind = inferSkillKind(input, departmentId);
    const draft = skillDraftForKnownSkill({
      skillId,
      input,
      sourceRef,
      sourceType: "repo_skill_manifest",
      targetDepartmentId: departmentId || (skillKind === "business_skill_candidate" ? "pending-owner-department" : "digital-office"),
      kind: skillKind,
      name,
      ownerHint: cleanText(input.ownerHint || ""),
      risk: cleanText(input.riskHint || input.risk || (skillKind === "business_skill_candidate" ? "中" : "待评估")),
      reviewGate: cleanText(input.reviewGate || "Skill owner + 平台质量审核确认输入输出、权限声明、版本意图和回滚边界"),
    });
    const referenceSkillDrafts = cleanList(draft.referenceSkillIds)
      .filter((referenceSkillId) => referenceSkillId !== draft.skillId)
      .map((referenceSkillId) => skillDraftForKnownSkill({
        skillId: referenceSkillId,
        input,
        sourceRef,
        sourceType: "repo_skill_reference",
        targetDepartmentId: draft.targetDepartmentId,
        kind: "business_skill_reference_review",
        ownerHint: draft.ownerHint,
        risk: draft.risk,
        reviewGate: "Reference Skill 进入同一安装拆解评审；确认 Skill ID、输入输出、依赖关系和挂载影响后才可安装。",
        mountHints: cleanList(input.mountEmployeeIds || input.mountedDigitalEmployees || input.candidateEmployeeIds),
      }));
    const skillDrafts = [draft, ...referenceSkillDrafts];
    const warnings = [
      safeImportWarning,
      forbiddenDataWarning,
      governedSkillById.get(skillId)
        ? "Skill ID already exists in the governed catalog; route this draft to lineage and duplicate review."
        : "New Skill IDs remain pending until owner and Skill ID review pass.",
      "Skill display name is editable and is not used for lineage; API/import matching must use skillId or sourceSkillId.",
      referenceSkillDrafts.length
        ? "Reference Skill drafts were created from referenceSkillIds and must pass Skill review before installation or mounting."
        : "No Reference Skill draft was declared for this manifest.",
    ];
    const job = createImportJob({
      pipelineId: "skill-manifest-import",
      sourceRef,
      createdBy: session.employeeId,
      drafts: { skillDrafts },
      duplicateKeys: skillDrafts.filter((skillDraft) => governedSkillById.has(skillDraft.skillId)).map((skillDraft) => skillDraft.skillId),
      preReview: buildImportPreReview("repo_skill_manifest", draft),
      warnings,
    });
    const persistResult = persistSystemImportState();
    if (!persistResult.ok) {
      restoreSystemImportSnapshot(previousState);
      return systemImportStoreFailure(res, persistResult);
    }

    return sendJson(res, 202, {
      ok: true,
      status: "pending_review",
      contractVersion: "system-import-job.v1",
      jobId: job.jobId,
      skillDrafts,
      duplicateKeys: job.duplicateKeys,
      preReview: job.preReview,
      warnings,
      importJob: job,
    });
  }

  async function createSkillUpdateImport(req, res) {
    const session = requirePermission(req, res, "system-imports:edit");
    if (!session) return undefined;
    const previousState = systemImportSnapshot();
    const input = await readJsonBody(req);
    const unsafeKeys = findUnsafePayloadKeys(input);
    if (unsafeKeys.length) return unsafePayload(res, unsafeKeys);

    const sourceRef = cleanSourceRef(input.sourceRef || input.repoUrl || "repo://unknown/skill-update");
    if (hasUnsafeUrlSecret(sourceRef)) return unsafeSourceRef(res);

    const skillId = normalizeSkillManifestId(input, sourceRef);
    const existingSkill = governedSkillById.get(skillId);
    if (!existingSkill) {
      return sendJson(res, 409, {
        ok: false,
        error: "skill_update_lineage_not_found",
        contractVersion: "system-import-job.v1",
        message: "当前治理 Skill 目录中不存在该 skillId；新能力应走 Skill manifest/import 评审，不能伪装成升级。",
      });
    }
    const existingSourceSkillId = cleanText(existingSkill.sourceSkillId || existingSkill.skillApiId || existingSkill.id || skillId);
    const requestedSourceSkillId = cleanText(input.sourceSkillId || "");
    if (requestedSourceSkillId && requestedSourceSkillId !== existingSourceSkillId) {
      return sendJson(res, 409, {
        ok: false,
        error: "skill_update_identity_conflict",
        contractVersion: "system-import-job.v1",
        message: "sourceSkillId 与已发布 Skill 谱系不一致。",
      });
    }
    const previousVersion = cleanText(input.previousVersion || "");
    if (!previousVersion) {
      return sendJson(res, 422, {
        ok: false,
        error: "skill_update_previous_version_required",
        contractVersion: "system-import-job.v1",
      });
    }
    if (previousVersion !== cleanText(existingSkill.version || "")) {
      return sendJson(res, 409, {
        ok: false,
        error: "skill_update_previous_version_mismatch",
        contractVersion: "system-import-job.v1",
        currentVersion: cleanText(existingSkill.version || ""),
      });
    }
    const targetVersion = cleanText(input.targetVersion || input.version || "");
    if (!targetVersion || isDraftSkillVersion(targetVersion) || targetVersion === previousVersion) {
      return sendJson(res, 422, {
        ok: false,
        error: "skill_update_target_version_invalid",
        contractVersion: "system-import-job.v1",
      });
    }
    const packageAnalysis = analyzePackageInput(input, sourceRef);
    const packageIntake = packageIntakeBoundary(input, sourceRef, packageAnalysis);
    if (!packageAnalysis.received || !packageAnalysis.unpacked || !packageAnalysis.manifestParsed) {
      return sendJson(res, 422, {
        ok: false,
        error: "skill_update_package_invalid",
        contractVersion: "system-import-job.v1",
        warnings: packageAnalysis.warnings,
      });
    }
    const matchingPackageUnits = packageAnalysis.skillUnits.filter((unit) =>
      unit.skillApiId === existingSkill.skillApiId && unit.sourceSkillId === existingSourceSkillId,
    );
    if (matchingPackageUnits.length !== 1) {
      return sendJson(res, 409, {
        ok: false,
        error: matchingPackageUnits.length ? "skill_update_package_unit_ambiguous" : "skill_update_package_unit_mismatch",
        contractVersion: "system-import-job.v1",
        message: "更新包必须包含且只包含一个与已发布 skillApiId/sourceSkillId 精确一致的 SKILL.md 单元。",
      });
    }
    const packageUnit = matchingPackageUnits[0];
    const skillPackageVersion = cleanText(packageUnit.skillPackageIdentity?.version || "");
    const runtimeHarnessVersion = cleanText(packageUnit.runtimeHarnessIdentity?.version || "");
    const runtimeExecutionMode = cleanText(packageUnit.runtimeExecutionProfile?.mode || "");
    const deterministicHarness = runtimeExecutionMode === "deterministic_harness";
    if (!packageUnit.skillPackageIdentity || !skillPackageVersion || !runtimeExecutionMode || (deterministicHarness && (!packageUnit.runtimeHarnessIdentity || !runtimeHarnessVersion))) {
      return sendJson(res, 422, {
        ok: false,
        error: "skill_update_package_version_identity_required",
        contractVersion: "system-import-job.v1",
        message: deterministicHarness
          ? "确定性 Harness Skill 更新包必须同时包含带版本的 digital-workforce-skill-package.v1 sidecar 和 runtime-harness manifest。"
          : "Skill 更新包必须包含带版本的 digital-workforce-skill-package.v1 sidecar 和有效运行画像。",
      });
    }
    if (skillPackageVersion !== targetVersion || (deterministicHarness && runtimeHarnessVersion !== targetVersion)) {
      return sendJson(res, 409, {
        ok: false,
        error: "skill_update_package_version_mismatch",
        contractVersion: "system-import-job.v1",
        targetVersion,
        skillPackageVersion,
        runtimeHarnessVersion,
        message: "targetVersion、Skill package sidecar version 与 runtime harness version 必须完全一致。",
      });
    }
    const declaredChanges = cleanList(input.declaredChanges || input.changes);
    const idVerification = {
      verificationId: draftId("SID", skillId),
      decision: "pending_review",
      duplicateKeys: [skillId],
      lineageSummary: "已按 skillApiId/sourceSkillId 确认为同一 Skill 的升级候选，仍需 owner 确认破坏性变更、回归候选和分发影响。",
    };
    const draft = {
      draftId: draftId("SKU", skillId),
      skillId: existingSkill.id || skillId,
      skillApiId: existingSkill.skillApiId || skillId,
      sourceSkillId: existingSourceSkillId,
      skillPackageIdentity: packageUnit.skillPackageIdentity,
      runtimeHarnessIdentity: packageUnit.runtimeHarnessIdentity,
      runtimeHarnessArtifact: packageUnit.runtimeHarnessArtifact || null,
      runtimeExecutionProfile: packageUnit.runtimeExecutionProfile,
      name: packageUnit.name,
      namespace: cleanText(existingSkill.namespace || input.namespace || ""),
      previousVersion,
      targetVersion,
      sourceRef,
      status: skillAutoReviewStatus,
      manifestSummary: packageUnit.manifestSummary,
      declaredInputs: packageUnit.declaredInputs,
      declaredOutputs: packageUnit.declaredOutputs,
      tools: packageUnit.tools,
      constraints: packageUnit.constraints,
      executionGuidance: packageUnit.executionGuidance,
      runtimeInstructions: packageUnit.runtimeInstructions,
      runtimeReferences: packageUnit.runtimeReferences,
      references: packageUnit.references,
      referenceManifest: packageUnit.referenceManifest,
      skillContentHash: packageUnit.skillContentHash,
      contractDigest: packageUnit.contractDigest,
      packageIntake,
      packageUnitPath: packageUnit.skillPath,
      packageReadSummary: packageUnit.readSummary,
      promptGovernance: {
        rawPromptStored: false,
        promptVersion: packageUnit.promptVersion,
        promptHash: packageUnit.promptHash,
        promptMetadataAutoCompleted: packageUnit.promptMetadataAutoCompleted,
        promptMetadataSource: packageUnit.promptMetadataSource,
        requiredBeforePublish: true,
      },
      declaredChanges,
      breakingChange: Boolean(input.breakingChange),
      risk: packageUnit.risk,
      reviewGate: "Skill owner 确认 Skill ID 谱系、兼容性、回归候选和分发影响后才能发布。",
      lineageKey: cleanText(existingSkill.lineageKey || existingSourceSkillId),
      lineageRule: "Display name may change; upgrade lineage is anchored by skillId/sourceSkillId plus previousVersion.",
      privacyBoundary: "仅保存包内 SKILL.md 与运行 reference 的安全合同摘要、已链接 reference 路径、指纹和升级意图；不保存原始包、raw prompt、私有 payload、执行记录或凭证。",
    };
    const warnings = [
      safeImportWarning,
      forbiddenDataWarning,
      "Existing Skill update must pass lineage review before publication.",
      "Skill display name is editable and is not used for update lineage.",
      ...packageAnalysis.warnings,
    ];
    const job = createImportJob({
      pipelineId: "external-skill-update-import",
      sourceRef,
      createdBy: session.employeeId,
      drafts: { skillUpdateDrafts: [draft] },
      duplicateKeys: idVerification.duplicateKeys,
      idVerification,
      preReview: buildImportPreReview("skill_update", draft),
      warnings,
    });
    const persistResult = persistSystemImportState();
    if (!persistResult.ok) {
      restoreSystemImportSnapshot(previousState);
      return systemImportStoreFailure(res, persistResult);
    }

    return sendJson(res, 202, {
      ok: true,
      status: "pending_review",
      contractVersion: "system-import-job.v1",
      jobId: job.jobId,
      skillUpdateDrafts: [draft],
      idVerification,
      warnings,
      importJob: job,
    });
  }

  async function createExternalDigitalEmployeeImport(req, res) {
    const session = requirePermission(req, res, "system-imports:edit");
    if (!session) return undefined;
    const previousState = systemImportSnapshot();
    const input = await readJsonBody(req);
    const unsafeKeys = findUnsafePayloadKeys(input);
    if (unsafeKeys.length) return unsafePayload(res, unsafeKeys);

    const sourceRef = cleanSourceRef(input.sourceRef || input.repoUrl || "external-agent://unknown");
    if (hasUnsafeUrlSecret(sourceRef)) return unsafeSourceRef(res);

    const intakeMode = cleanText(input.intakeMode || "");
    const level = normalizeEmployeeLevel(input.level || input.levelHint || input.declaredLevel || "业务级");
    const isSystemLevel = level === "系统级";
    const isHarnessUpload = /upload_harness/i.test(intakeMode);
    const isSkillUploadHarness = /skill_upload_harness/i.test(intakeMode);
    const packageAnalysis = analyzePackageInput(input, sourceRef);
    const packageIntake = packageIntakeBoundary(input, sourceRef, packageAnalysis);
    const employeeDeclaration = normalizeExternalEmployeeDeclaration(input.employeeDeclaration || {});
    const requestedDepartmentId = normalizeDepartmentId(
      input.targetDepartmentId ||
        input.departmentId ||
        input.ownerDepartmentId ||
        input.businessDepartmentId ||
        input.departmentName ||
        "",
    );
    const sessionResolvedDepartmentId = sessionDepartmentId(session, isSystemLevel);
    const canOverrideHarnessDepartment = isHarnessUpload && !isSystemLevel && requestedDepartmentId && hasPermission(session.permissions, "system:*");
    const uploaderDepartmentId = isHarnessUpload && !isSystemLevel
      ? canOverrideHarnessDepartment
        ? requestedDepartmentId
        : sessionResolvedDepartmentId
      : requestedDepartmentId || sessionResolvedDepartmentId;
    const businessGroupRecommendation = recommendBusinessGroup({
      input,
      sourceRef,
      departmentId: uploaderDepartmentId,
      packageAnalysis,
      level,
    });
    const harnessKey = harnessSourceKey(sourceRef);
    const externalEmployeeId = isSystemLevel
      ? cleanEntityId(input.externalEmployeeId || input.employeeId || input.id || harnessKey)
      : isHarnessUpload
      ? cleanEntityId(`${uploaderDepartmentId}-${harnessKey}-employee`)
      : cleanEntityId(input.externalEmployeeId || input.employeeId || input.id || input.name || `${uploaderDepartmentId}-${harnessKey}-employee`);
    const fixedAiWorker = fixedWorkerAssignment(isSystemLevel ? "system_employee_candidate" : "external_employee");
    const mountedSkillHints = expandMountedSkillHints(input, sourceRef, uploaderDepartmentId, packageAnalysis);
    const draft = {
      draftId: draftId("EED", externalEmployeeId),
      externalEmployeeId,
      name: cleanText(input.externalEmployeeName || input.name || employeeDeclaration?.name || (isSkillUploadHarness ? "外部业务 Skill 包登记" : "待拆解外部数字员工")),
      title: cleanText(input.title || employeeDeclaration?.title || "外部能力接入候选"),
      sourceRef,
      level,
      intakeKind: isSkillUploadHarness ? "skill_package_source_registration" : isSystemLevel ? "system_worker_candidate" : "external_employee_candidate",
      departmentId: uploaderDepartmentId,
      businessGroupRecommendation,
      businessGroupId: businessGroupRecommendation.groupId,
      businessGroup: businessGroupRecommendation.label,
      domain: businessGroupRecommendation.domainLabel || businessGroupRecommendation.label,
      ownerHint: cleanText(input.ownerHint || ""),
      identitySource: isSystemLevel ? "declared_system_worker" : isHarnessUpload ? "harness_generated_from_source_ref" : "declared_external_employee",
      identityRule: isHarnessUpload
        ? "Business upload intake does not accept manually typed employee or Skill IDs; harness derives draft IDs from the governed target department plus source/package decomposition."
        : "External employee drafts must pass registry review; display names are not used for lineage.",
      departmentSource: isSystemLevel
        ? "system_level_default"
        : isHarnessUpload && canOverrideHarnessDepartment
        ? "admin_declared_target_department"
        : isHarnessUpload
        ? "uploader_session"
        : requestedDepartmentId
        ? "request_payload"
        : "uploader_session_fallback",
      status: isSystemLevel ? "system_worker_review_required" : "pending_review",
      versionIntent: cleanText(input.version || input.declaredVersion || "draft"),
      externalEmployeeSummary: cleanText(input.externalEmployeeSummary || employeeDeclaration?.objective || input.safeSummary || ""),
      permissionClaims: cleanList(input.permissionClaims),
      toolClaims: cleanList([...cleanList(input.toolClaims || input.tools), ...(employeeDeclaration?.tools || [])]),
      mountedSkillHints,
      employeeDeclaration: employeeDeclaration || undefined,
      assignedAiWorker: fixedAiWorker,
      risk: cleanText(input.riskHint || input.risk || (isSystemLevel ? "高" : "待评估")),
      reviewGate: isSystemLevel
        ? "系统管理员确认 worker lane、触发策略、凭证租约和审计边界后才能进入系统级调度。"
        : "平台管理员 + 业务 owner 确认权限声明、工具边界、运行链路和停用策略。",
      packageBoundary: portablePackageBoundary,
      packageRecordBoundary: portablePackageBoundary.boundarySummary,
      packageIntake,
      packageAnalysisSummary: packageAnalysis.summary,
      outputContract: employeeDeclaration?.outputContract || "",
      rules: employeeDeclaration?.rules || [],
      tools: employeeDeclaration?.tools || [],
      privacyBoundary: "仅保存外部数字员工安全摘要、权限 claims、工具 claims、版本意图和审核门禁；不保存外部密钥或执行记录。",
    };
    const linkedSkillDrafts = isSystemLevel ? [] : linkedSkillDraftsForExternalEmployee(input, draft, sourceRef, packageAnalysis);
    const warnings = [
      safeImportWarning,
      forbiddenDataWarning,
      isSystemLevel
        ? "System-level workers must also create an AI worker install draft before they can be scheduled."
        : "Business-level external employees must pass registry review first, then personnel approval before any trial-run state.",
      linkedSkillDrafts.length
        ? "Registry decomposition created linked Skill drafts; Skill owner and quality review are required before mounting."
        : "No linked Skill draft was declared; personnel review must confirm whether a Skill review is still required.",
      packageIntake.mode === "package_reference_only" ? packageReferenceOnlyWarning : "",
      ...packageAnalysis.warnings,
    ].filter(Boolean);
    const job = createImportJob({
      pipelineId: "external-digital-employee-import",
      sourceRef,
      createdBy: session.employeeId,
      drafts: { externalEmployeeDrafts: [draft], skillDrafts: linkedSkillDrafts },
      duplicateKeys: linkedSkillDrafts.filter((skillDraft) => skillDraft.existingSkill).map((skillDraft) => skillDraft.skillId),
      installDecomposition: {
        sourceRef,
        uploaderDepartmentId,
        identityRule: draft.identityRule,
        packageIntake,
        registryEmployeeId: "external-agent-registry-agent",
        externalEmployeeDraftIds: [draft.draftId],
        skillDraftIds: linkedSkillDrafts.map((skillDraft) => skillDraft.draftId),
        nextGates: [
          "外部员工草案登记审核通过后进入人员审批。",
          linkedSkillDrafts.length ? "拆解出的 Skill 草案进入技能/员工评审。" : "未声明 Skill 草案时由人员审批确认是否补充 Skill 评审。",
        ],
      },
      permissionWarnings: permissionWarningsForEmployeeDraft(draft),
      preReview: buildImportPreReview(isSystemLevel ? "system_employee_candidate" : "external_employee", draft, fixedAiWorker),
      warnings,
    });
    autoRouteExternalCapabilityJob(job, {
      skillUploadHarness: isSkillUploadHarness,
      employeeUploadHarness: isHarnessUpload && !isSkillUploadHarness && !isSystemLevel,
      actor: session.employeeId,
    });
    const persistResult = persistSystemImportState();
    if (!persistResult.ok) {
      restoreSystemImportSnapshot(previousState);
      return systemImportStoreFailure(res, persistResult);
    }

    return sendJson(res, 202, {
      ok: true,
      status: job.status,
      contractVersion: "system-import-job.v1",
      jobId: job.jobId,
      externalEmployeeDrafts: [draft],
      skillDrafts: linkedSkillDrafts,
      autoWorkflow: job.autoWorkflow || null,
      permissionWarnings: job.permissionWarnings,
      preReview: job.preReview,
      warnings,
      importJob: job,
    });
  }

  async function createRequirementImport(req, res) {
    const session = requirePermission(req, res, "system-imports:edit");
    if (!session) return undefined;
    const previousState = systemImportSnapshot();
    const input = await readJsonBody(req);
    const unsafeKeys = findUnsafePayloadKeys(input);
    if (unsafeKeys.length) return unsafePayload(res, unsafeKeys);

    const sourceRef = cleanSourceRef(input.sourceRef || input.requirementId || "requirement://unknown");
    if (hasUnsafeUrlSecret(sourceRef)) return unsafeSourceRef(res);

    const department = cleanText(input.department || input.departmentId || "");
    const draft = {
      draftId: draftId("REQ", sourceRef),
      sourceRef,
      requirementSummary: cleanText(input.requirementSummary || input.safeSummary || ""),
      department,
      ownerHint: cleanText(input.ownerHint || ""),
      riskHint: cleanText(input.riskHint || input.risk || "待评估"),
      status: "pending_owner_review",
      candidateEmployees: cleanList(input.candidateEmployees || input.candidateEmployeeIds),
      candidateBusinessSkills: cleanList(input.candidateBusinessSkills || input.candidateSkillIds),
      reviewGate: "业务 owner 确认范围、风险、人审门禁和候选员工/Skill 映射后才能进入实现队列。",
    };
    const warnings = [safeImportWarning, forbiddenDataWarning, "Requirement import is a candidate only and does not commit implementation scope."];
    const job = createImportJob({
      pipelineId: "requirement-intake-import",
      sourceRef,
      createdBy: session.employeeId,
      drafts: { requirementDrafts: [draft] },
      preReview: buildImportPreReview("requirement_candidate", draft),
      warnings,
    });
    const persistResult = persistSystemImportState();
    if (!persistResult.ok) {
      restoreSystemImportSnapshot(previousState);
      return systemImportStoreFailure(res, persistResult);
    }

    return sendJson(res, 202, {
      ok: true,
      status: "pending_review",
      contractVersion: "system-import-job.v1",
      jobId: job.jobId,
      requirementDrafts: [draft],
      candidateEmployees: draft.candidateEmployees,
      candidateBusinessSkills: draft.candidateBusinessSkills,
      warnings,
      importJob: job,
    });
  }

  function getImportJob(req, res, jobId) {
    const session = requirePermission(req, res, "system-imports:read");
    if (!session) return undefined;
    const normalizedJobId = cleanText(decodeURIComponent(jobId));
    const job = importJobs.get(normalizedJobId);
    if (!job) {
      return sendJson(res, 404, {
        ok: false,
        error: "import_job_not_found",
        contractVersion: "system-import-job.v1",
      });
    }
    return sendJson(res, 200, {
      ok: true,
      status: job.status,
      contractVersion: "system-import-job.v1",
      importJob: job,
    });
  }

  function listImportJobs(req, res, url) {
    const session = requirePermission(req, res, "system-imports:read");
    if (!session) return undefined;
    const status = cleanText(url.searchParams.get("status") || "");
    const pipelineId = cleanText(url.searchParams.get("pipelineId") || "");
    const query = cleanText(url.searchParams.get("q") || "").toLowerCase();
    const jobs = [...importJobs.values()]
      .filter((job) => !status || job.status === status)
      .filter((job) => !pipelineId || job.pipelineId === pipelineId)
      .filter((job) => !query || JSON.stringify(job).toLowerCase().includes(query))
      .sort((left, right) => String(right.createdAt).localeCompare(String(left.createdAt)));

    return sendJson(res, 200, {
      ok: true,
      status: "ready",
      contractVersion: "system-import-job-list.v1",
      importJobs: jobs,
      persistence: {
        kind: systemImportStorePath ? "mvp-file-store" : "mvp-process-memory",
        productionReady: false,
        path: systemImportStorePath ? "data/local/system-import-state.json" : "",
        note: systemImportStorePath
          ? "当前 MVP 用 ignored data/local 文件保存系统接入草案、Agent 预审摘要和 Skill 评审状态，可跨服务重启保留。"
          : "当前 MVP 用后端进程内存保存安装草案；重启服务会清空列表。",
      },
    });
  }

  async function reviewImportJob(req, res, jobId) {
    const session = requirePermission(req, res, "system-imports:edit");
    if (!session) return undefined;
    const previousState = systemImportSnapshot();
    const input = await readJsonBody(req);
    const unsafeKeys = findUnsafePayloadKeys(input);
    if (unsafeKeys.length) return unsafePayload(res, unsafeKeys);

    const normalizedJobId = cleanText(decodeURIComponent(jobId));
    const job = importJobs.get(normalizedJobId);
    if (!job) {
      return sendJson(res, 404, {
        ok: false,
        error: "import_job_not_found",
        contractVersion: "system-import-review-decision.v1",
      });
    }

    const decision = normalizeReviewDecision(input.decision);
    if (!decision) {
      return sendJson(res, 422, {
        ok: false,
        error: "review_decision_required",
        contractVersion: "system-import-review-decision.v1",
        allowedDecisions: ["approved", "rejected"],
      });
    }

    const requestedDraftId = cleanText(input.draftId || "");
    const draftRefs = draftRefsForJob(job);
    const targetRefs = requestedDraftId ? draftRefs.filter((item) => item.draft.draftId === requestedDraftId) : draftRefs;
    if (!targetRefs.length) {
      return sendJson(res, 404, {
        ok: false,
        error: "import_draft_not_found",
        contractVersion: "system-import-review-decision.v1",
      });
    }

    const decidedAt = new Date().toISOString();
    const hasExternalEmployeeDraft = targetRefs.some(({ kind }) => kind === "externalEmployeeDrafts");
    const hasSkillDraft = targetRefs.some(({ kind }) => kind === "skillDrafts");
    const hasSkillPackageSourceRegistration = targetRefs.some(({ kind, draft }) => kind === "externalEmployeeDrafts" && isSkillPackageSourceRegistrationDraft(draft));
    const reviewKind = targetRefs.length === 1 ? reviewKindForDraftRef(targetRefs[0]) : hasExternalEmployeeDraft && hasSkillDraft ? "mixedExternalInstall" : "mixed";
    const reviewDecision = {
      decision,
      decidedAt,
      decidedBy: session.employeeId,
      note: cleanText(input.note || defaultReviewNote(decision, reviewKind)),
      nextGate: nextGateForReviewDecision(decision, reviewKind),
      productionEffect: "none",
      workflowEffect: workflowEffectForReviewDecision(decision, reviewKind),
      privacyBoundary: "评审动作只记录安全结论和意见；业务级外部数字员工登记审核后进入人员审批，Skill 草案进入技能/员工评审；不进入试运行、不调度 worker、不分配真实 provider key。",
    };

    targetRefs.forEach(({ kind, draft }) => {
      const draftStatus = statusForReviewDecision(decision, kind, draft);
      draft.status = draftStatus;
      draft.reviewDecision = {
        ...reviewDecision,
        status: draftStatus,
        nextGate: nextGateForReviewDecision(decision, reviewKindForDraftRef({ kind, draft })),
        workflowEffect: workflowEffectForReviewDecision(decision, reviewKindForDraftRef({ kind, draft })),
      };
    });
    job.status = statusForReviewedJob(job);
    job.updatedAt = decidedAt;
    job.reviewDecision = {
      ...reviewDecision,
      status: job.status,
      draftIds: targetRefs.map(({ draft }) => draft.draftId),
    };
    const persistResult = persistSystemImportState();
    if (!persistResult.ok) {
      restoreSystemImportSnapshot(previousState);
      return systemImportStoreFailure(res, persistResult);
    }

    return sendJson(res, 200, {
      ok: true,
      status: job.status,
      contractVersion: "system-import-review-decision.v1",
      reviewDecision: job.reviewDecision,
      importJob: job,
      warnings: [
        safeImportWarning,
        hasSkillPackageSourceRegistration
          ? "Approved Skill package source registration only confirms the intake source; linked Skill drafts still require Skill/employee review before publication or mounting."
          : hasExternalEmployeeDraft
          ? "Approved business-level external digital employee drafts must proceed to personnel approval before trial."
          : hasSkillDraft
          ? "Approved linked Skill drafts must proceed to Skill/employee review before publication or mounting."
          : "MVP review decisions do not install capabilities, publish Skills, schedule workers, or allocate credentials.",
      ],
    });
  }

  function listPreReviewWorkers(req, res, url) {
    const session = requirePermission(req, res, "system:read");
    if (!session) return undefined;
    const lane = url.searchParams.get("lane");
    const provider = url.searchParams.get("provider");
    const departmentId = url.searchParams.get("departmentId");
    const status = url.searchParams.get("status");
    const query = String(url.searchParams.get("q") || "").trim().toLowerCase();
    const items = currentPreReviewWorkers().filter((worker) => {
      if (lane && worker.lane !== lane) return false;
      if (provider && worker.provider !== provider) return false;
      if (status && worker.status !== status) return false;
      if (departmentId && !worker.departmentScope?.includes(departmentId)) return false;
      if (!query) return true;
      return Object.values(worker)
        .flatMap((value) => (Array.isArray(value) ? value : [value]))
        .join(" ")
        .toLowerCase()
        .includes(query);
    });
    return sendJson(res, 200, {
      ok: true,
      status: "ready",
      contractVersion: "ai-worker-pre-review.v1",
      preReviewWorkers: items,
      governance: "System-level AI workers are admin-governed runtime lanes. They are not requestable business capabilities.",
    });
  }

  async function createPreReviewWorkerInstallDraft(req, res) {
    const session = requirePermission(req, res, "system:edit");
    if (!session) return undefined;
    const input = await readJsonBody(req);
    const unsafeKeys = findUnsafePayloadKeys(input);
    if (unsafeKeys.length) return unsafePayload(res, unsafeKeys);

    const declaredLevel = normalizeEmployeeLevel(input.declaredLevel || input.level || input.levelHint || "系统级");
    const installTargetType = cleanText(input.installTargetType || "ai_pre_review_worker");
    if (declaredLevel === "业务级" || /business/i.test(installTargetType)) {
      return sendJson(res, 422, {
        ok: false,
        error: "business_capability_not_ai_worker",
        contractVersion: "ai-worker-install-draft.v1",
        message: "业务技能或业务级数字员工应通过 system-imports 进入待审草案，不能直接安装为系统级 AI Worker。",
        recommendedEndpoints: [
          "POST /api/system-imports/skill-manifests",
          "POST /api/system-imports/external-digital-employees",
        ],
      });
    }

    const lane = cleanIdentifier(input.lane || input.workerLane || "");
    if (!lane) {
      return sendJson(res, 422, {
        ok: false,
        error: "worker_lane_required",
        contractVersion: "ai-worker-install-draft.v1",
      });
    }

    const existingWorker = workerByLane().get(lane);
    const sourceRef = cleanSourceRef(input.sourceRef || `ai-worker://${lane}`);
    if (hasUnsafeUrlSecret(sourceRef)) return unsafeSourceRef(res);

    const draft = {
      id: draftId("WRK", lane),
      status: "pending_admin_review",
      installTargetType: "ai_pre_review_worker",
      sourceRef,
      name: cleanText(input.name || input.workerName || "待命名预审 Worker"),
      lane,
      workerEmployeeId: cleanText(input.workerEmployeeId || "system-ingestion-agent"),
      triggerMode: cleanText(input.triggerMode || "事件触发 + 定时补扫"),
      triggerPolicy: cleanText(input.triggerPolicy || "外部 request 创建后进入系统级预审队列。"),
      schedule: cleanText(input.schedule || "event-driven"),
      provider: cleanText(input.provider || "codex"),
      model: cleanText(input.model || "gpt-5.5"),
      modelLevelId: cleanText(input.modelLevelId || input.reasoningEffort || "high"),
      credentialLeasePolicy: cleanText(input.credentialLeasePolicy || "server_side_runtime_lease"),
      maxParallelWorkers: boundedNumber(input.maxParallelWorkers, 1, 10, 1),
      batchSize: boundedNumber(input.batchSize, 1, 50, 3),
      assignedRequestTypes: cleanList(input.assignedRequestTypes || input.requestTypes),
      departmentScope: cleanList(input.departmentScope || input.departmentIds),
      dedupeKey: cleanText(input.dedupeKey || "sourceRef + requestType + declaredVersion"),
      outputContract: cleanText(input.outputContract || "safeFindings、missingItems、recommendedDecision、nextGate"),
      governance: cleanText(input.governance || "只生成预审建议；管理员通过前不得写入正式能力目录。"),
      duplicateLane: existingWorker
        ? { id: existingWorker.id, name: existingWorker.name, status: existingWorker.status }
        : null,
      reviewGate: "系统管理员确认 lane 唯一性、触发策略、凭证租约、输出契约、容量和审计边界。",
      privacyBoundary: "Worker draft only stores safe routing and governance metadata; provider keys and execution payloads stay server-side.",
    };
    const warnings = [
      safeImportWarning,
      forbiddenDataWarning,
      existingWorker ? "A pre-review worker with the same lane already exists; this must be reviewed as an update or duplicate." : "New worker lanes require admin approval before scheduling.",
    ];
    return sendJson(res, 202, {
      ok: true,
      status: "pending_admin_review",
      contractVersion: "ai-worker-install-draft.v1",
      workerInstallDraft: draft,
      warnings,
    });
  }

  async function triggerExternalAuditPreReview(req, res, requestId) {
    const session = requirePermission(req, res, "quality-reviews:edit");
    if (!session) return undefined;
    const input = await readJsonBody(req);
    const request = externalAuditRequests.find((item) => item.id === cleanText(requestId));
    if (!request) {
      return sendJson(res, 404, {
        ok: false,
        error: "external_audit_request_not_found",
        contractVersion: "external-audit-pre-review.v1",
      });
    }

    const workers = currentPreReviewWorkers();
    const worker = workerById().get(request.preReview?.workerId) || workerByLane().get(request.preReview?.lane) || workers[0];
    const execution = {
      preReviewExecutionId: `PRE-${request.id}-${Date.now()}`,
      status: "queued",
      workerLane: worker?.lane || request.preReview?.lane || "audit_precheck",
      workerId: worker?.id || request.preReview?.workerId || "",
      triggerReason: cleanText(input.reason || "admin_rerun"),
      forceRerun: Boolean(input.forceRerun),
      credentialLease: {
        mode: "server_lease",
        provider: worker?.provider || request.preReview?.provider || "codex",
        leaseRef: "allocated-at-runtime",
      },
      dedupeKey: request.preReview?.inputSignature || worker?.dedupeKey || "requestType + targetEntityId + targetVersion + sourceFingerprint",
      queuePolicy: "Active duplicates with the same dedupe key should merge into the running execution.",
    };
    return sendJson(res, 202, {
      ok: true,
      status: "queued",
      contractVersion: "external-audit-pre-review.v1",
      ...execution,
      warnings: [
        "LAN demo queues a safe pre-review draft only; it does not call a real model provider.",
        "Production must persist execution state, RBAC, idempotency, credential lease, and audit logs server-side.",
      ],
    });
  }

  function createImportJob({ pipelineId, sourceRef, createdBy, drafts, warnings, ...extra }) {
    const jobId = `IMP-${pipelineId.toUpperCase().replace(/[^A-Z0-9]+/g, "-")}-${Date.now()}`;
    const job = {
      jobId,
      pipelineId,
      sourceRef,
      status: "pending_review",
      createdAt: new Date().toISOString(),
      createdBy,
      reviewGate: reviewGateForPipeline(pipelineId),
      drafts,
      warnings,
      privacyBoundary: "Import jobs store safe summaries and draft metadata only. Raw files, prompts, payloads, traces, credentials, and private Skill payloads are not stored.",
      ...extra,
    };
    importJobs.set(jobId, job);
    return job;
  }

  function persistSystemImportState() {
    return persistSystemImportStore({
      storePath: systemImportStorePath,
      importJobs,
      skillEmployeeReviews,
      mvpSkillPublications,
      publishedBusinessSkills,
      runtimeSkillProjections,
      digitalEmployeeReviews,
      mvpDigitalEmployeeStates,
      catalogSkillReviewStates,
      skillAgentPreReview,
      cleanText,
    });
  }

  function systemImportSnapshot() {
    return {
      ...createSystemImportSnapshot({
        importJobs,
        skillEmployeeReviews,
        mvpSkillPublications,
        publishedBusinessSkills,
        runtimeSkillProjections,
        digitalEmployeeReviews,
        mvpDigitalEmployeeStates,
        catalogSkillReviewStates,
        skillAgentPreReview,
      }),
      governedSkills: Object.fromEntries(governedSkillById.entries()),
    };
  }

  function restoreSystemImportSnapshot(snapshot = {}) {
    restorePersistedSystemImportSnapshot({
      snapshot,
      importJobs,
      skillEmployeeReviews,
      mvpSkillPublications,
      publishedBusinessSkills,
      runtimeSkillProjections,
      digitalEmployeeReviews,
      mvpDigitalEmployeeStates,
      catalogSkillReviewStates,
      skillAgentPreReview,
    });
    governedSkillById.clear();
    Object.entries(snapshot.governedSkills || {}).forEach(([skillId, skill]) => governedSkillById.set(skillId, skill));
  }

  function migrateLoadedSystemImportState() {
    let changed = false;
    for (const job of importJobs.values()) {
      let jobChanged = false;
      for (const { kind, draft } of draftRefsForJob(job)) {
        if (kind === "skillUpdateDrafts" && draft.status === "pending_review") {
          draft.status = skillAutoReviewStatus;
          changed = true;
          jobChanged = true;
        }
        const publication = matchingSkillPublication(job, draft);
        if ((kind === "skillDrafts" || kind === "skillUpdateDrafts") && publication && draft.status !== "mvp_skill_published") {
          draft.status = "mvp_skill_published";
          draft.mvpPublication = draft.mvpPublication || {
            publicationId: publication.publicationId,
            status: publication.status,
            skillId: publication.skillId,
            skillApiId: publication.skillApiId,
            version: publication.version,
            publishedAt: publication.publishedAt,
            runtimeEligibility: publication.runtimeEligibility,
            nextGate: publication.nextGate,
          };
          changed = true;
          jobChanged = true;
        }
        if (kind === "externalEmployeeDrafts" && shouldMigrateApprovedOnlineEmployee(draft)) {
          migrateApprovedEmployeeToTrial(draft);
          changed = true;
          jobChanged = true;
        }
        if (kind === "externalEmployeeDrafts" && backfillResponsibilityAssignments(draft)) {
          changed = true;
        }
        if ((kind === "skillDrafts" || kind === "skillUpdateDrafts") && migrateRuntimeExecutionProfile(draft)) {
          changed = true;
        }
        if (migrateBusinessGroupFields(draft, {
          sourceRef: draft.sourceRef || job.sourceRef,
          departmentId: draft.targetDepartmentId || draft.departmentId || job.installDecomposition?.uploaderDepartmentId,
          level: draft.level,
          existingSkill: governedSkillById.get(draft.skillId) || null,
        })) {
          changed = true;
        }
      }
      if (jobChanged) {
        const status = statusForReviewedJob(job);
        if (job.status !== status) {
          job.status = status;
          changed = true;
        }
      }
    }

    for (const review of digitalEmployeeReviews.values()) {
      if (review.action !== "approve_personnel" || review.productionEffect !== "none" || review.employeeStatus !== "在线") continue;
      review.employeeStatus = "试运行";
      review.nextGate = approvedEmployeeTrialNextGate();
      changed = true;
    }

    for (const state of mvpDigitalEmployeeStates.values()) {
      if (!shouldMigrateApprovedOnlineEmployee(state)) continue;
      migrateApprovedEmployeeToTrial(state);
      if (state.employee && typeof state.employee === "object") {
        state.employee.status = "试运行";
        state.employee.reviewGate = state.employee.reviewGate || approvedEmployeeTrialNextGate();
      }
      changed = true;
    }
    for (const state of mvpDigitalEmployeeStates.values()) {
      if (ensureRuntimeEmployeePromptMetadata(state)) {
        changed = true;
      }
    }

    for (const publication of mvpSkillPublications.values()) {
      const publishedSkill = publishedBusinessSkills.get(publication.skillId);
      if (migrateRuntimeExecutionProfile(publication, publishedSkill)) {
        changed = true;
      }
      if (migratePublicationPackageVersion(publication, publishedSkill)) {
        changed = true;
      }
      if (migratePublishedVersion(publication, publication.publishedAt)) {
        changed = true;
      }
      if (migrateBusinessGroupFields(publication, {
        sourceRef: publication.sourceRef,
        departmentId: publication.targetDepartmentId || publishedSkill?.departmentId,
        existingSkill: governedSkillById.get(publication.skillId) || publishedSkill || null,
      })) {
        changed = true;
      }
    }

    for (const skill of publishedBusinessSkills.values()) {
      if (migrateRuntimeExecutionProfile(skill)) {
        changed = true;
      }
      if (skill.mvpPublication && migrateRuntimeExecutionProfile(skill.mvpPublication, skill)) {
        changed = true;
      }
      if (migratePublishedVersion(skill, skill.mvpPublication?.publishedAt || skill.updatedAt)) {
        changed = true;
      }
      if (migratePublishedReferenceManifest(skill)) {
        changed = true;
      }
      if (skill.mvpPublication && isDraftSkillVersion(skill.mvpPublication.version)) {
        skill.mvpPublication.version = skill.version;
        changed = true;
      }
      if (migrateBusinessGroupFields(skill, {
        sourceRef: skill.sourceRef,
        departmentId: skill.departmentId,
        existingSkill: skill,
      })) {
        changed = true;
      }
    }
    return { changed };
  }

  function migrateRuntimeExecutionProfile(target = {}, source = null) {
    if (!target || typeof target !== "object") return false;
    if (normalizeSkillRuntimeExecutionProfile(target.runtimeExecutionProfile)) return false;
    if (target.runtimeExecutionProfile != null) return false;
    const sourceProfile = normalizeSkillRuntimeExecutionProfile(source?.runtimeExecutionProfile);
    target.runtimeExecutionProfile = sourceProfile || createSkillRuntimeExecutionProfile(
      target.runtimeHarnessIdentity || target.runtimeHarness || source?.runtimeHarnessIdentity || source?.runtimeHarness
        ? "deterministic_harness"
        : "guidance",
    );
    return true;
  }

  function matchingSkillPublication(job = {}, draft = {}) {
    const publicationId = cleanText(draft.mvpPublication?.publicationId || "");
    const publication = publicationId
      ? mvpSkillPublications.get(publicationId)
      : [...mvpSkillPublications.values()].find((candidate) => (
          candidate.sourceJobId === job.jobId &&
          candidate.sourceDraftId === draft.draftId &&
          candidate.skillId === draft.skillId
        ));
    if (!publication || publication.status !== "mvp_skill_published") return null;
    if (publication.sourceJobId !== job.jobId || publication.sourceDraftId !== draft.draftId) return null;
    if (publication.skillId !== draft.skillId) return null;
    return publication;
  }

  function shouldMigrateApprovedOnlineEmployee(record = {}) {
    const personnelApproved = record.personnelApproval?.status === "personnel_approval_passed"
      || (record.reviewDecision?.decision === "approved" && ["approve_personnel", "start_trial"].includes(record.reviewDecision?.action));
    const productionEffect = record.productionEffect || record.employee?.productionEffect || record.reviewDecision?.productionEffect;
    return personnelApproved && record.status === "在线" && productionEffect === "none";
  }

  function migrateApprovedEmployeeToTrial(record = {}) {
    record.status = "试运行";
    if (record.reviewDecision && typeof record.reviewDecision === "object") {
      record.reviewDecision.status = "试运行";
      record.reviewDecision.nextGate = approvedEmployeeTrialNextGate();
    }
  }

  function approvedEmployeeTrialNextGate() {
    return "人员审批已通过，数字员工进入试运行；员工声明的结构化上线门禁全部通过且没有阻塞项后，生命周期才会收敛为在线。";
  }

  function backfillResponsibilityAssignments(draft = {}) {
    const assignments = draft.employeeDeclaration?.responsibilityAssignments;
    const employeeId = cleanEntityId(draft.externalEmployeeId || draft.employeeId || draft.id || draft.name);
    const state = employeeId ? mvpDigitalEmployeeStates.get(employeeId) : null;
    if (!assignments || !state?.employee || state.employee.responsibilityAssignments) return false;
    state.employee.responsibilityAssignments = assignments;
    return true;
  }

  function ensureRuntimeEmployeePromptMetadata(state = {}) {
    if (!state?.employee || typeof state.employee !== "object") return false;
    const employee = state.employee;
    const promptGovernance = employee.promptGovernance && typeof employee.promptGovernance === "object"
      ? employee.promptGovernance
      : {};
    const currentVersion = cleanText(employee.promptVersion || promptGovernance.promptVersion);
    const sourceDraft = employeeDraftForState(state);
    const declarationPrompt = sourceDraft?.employeeDeclaration?.promptMetadata || {};
    const nextVersion = currentVersion || cleanText(
      declarationPrompt.version || declarationPrompt.promptVersion || "employee-import.v1",
    );
    if (!nextVersion) return false;
    const employeeId = cleanEntityId(employee.id || state.employeeId || sourceDraft?.externalEmployeeId);
    const nextScope = cleanText(employee.promptScope || promptGovernance.promptScope || (employeeId ? `employee:${employeeId}` : ""));
    const nextHash = cleanText(employee.promptHash || promptGovernance.promptHash || declarationPrompt.hash || declarationPrompt.promptHash);
    let changed = false;
    if (employee.promptVersion !== nextVersion) {
      employee.promptVersion = nextVersion;
      changed = true;
    }
    if (nextScope && employee.promptScope !== nextScope) {
      employee.promptScope = nextScope;
      changed = true;
    }
    if (nextHash && employee.promptHash !== nextHash) {
      employee.promptHash = nextHash;
      changed = true;
    }
    const nextGovernance = {
      ...promptGovernance,
      ...(nextScope ? { promptScope: nextScope } : {}),
      promptVersion: nextVersion,
      ...(nextHash ? { promptHash: nextHash } : {}),
      rawPromptStored: false,
    };
    if (JSON.stringify(employee.promptGovernance || {}) !== JSON.stringify(nextGovernance)) {
      employee.promptGovernance = nextGovernance;
      changed = true;
    }
    return changed;
  }

  function employeeDraftForState(state = {}) {
    const jobId = cleanText(state.sourceJobId || state.reviewDecision?.sourceJobId);
    const draftId = cleanText(state.sourceDraftId || state.reviewDecision?.sourceDraftId);
    if (!jobId || !draftId) return null;
    const job = importJobs.get(jobId);
    if (!job) return null;
    return draftRefsForJob(job)
      .find(({ kind, draft }) => kind === "externalEmployeeDrafts" && draft?.draftId === draftId)
      ?.draft || null;
  }

  function migratePublishedReferenceManifest(skill = {}) {
    if (!Array.isArray(skill.referenceManifest) || !skill.referenceManifest.length) return false;
    const currentReferences = cleanList(skill.references);
    const packageUnitPath = cleanText(skill.packageUnitPath || currentReferences.find((item) => /(^|\/)SKILL\.md$/i.test(item)) || "");
    const normalizedReferences = [...new Set(cleanList([
      packageUnitPath,
      ...skill.referenceManifest.map((item) => item?.path),
    ]))];
    if (JSON.stringify(currentReferences) === JSON.stringify(normalizedReferences) && skill.packageUnitPath === packageUnitPath) return false;
    skill.packageUnitPath = packageUnitPath;
    skill.references = normalizedReferences;
    return true;
  }

  function migratePublishedVersion(target = {}, publishedAt = "") {
    if (!target || typeof target !== "object" || !isDraftSkillVersion(target.version)) return false;
    target.version = resolveMvpSkillVersion({
      versionIntent: target.version,
      publishedAt,
    });
    return true;
  }

  function migratePublicationPackageVersion(publication = {}, publishedSkill = null) {
    const job = importJobs.get(publication.sourceJobId);
    const draft = job
      ? draftRefsForJob(job).find(({ draft: candidate }) => candidate.draftId === publication.sourceDraftId)?.draft
      : null;
    const packageVersion = cleanText(draft?.skillPackageIdentity?.version || "");
    const fallbackVersion = resolveMvpSkillVersion({ publishedAt: publication.publishedAt });
    if (!draft || isDraftSkillVersion(packageVersion) || !isDraftSkillVersion(draft.versionIntent) ||
      !isDraftSkillVersion(draft.targetVersion) || publication.version !== fallbackVersion || packageVersion === publication.version) {
      return false;
    }
    const previousVersion = publication.version;
    publication.version = packageVersion;
    if (draft.mvpPublication?.publicationId === publication.publicationId && draft.mvpPublication.version === previousVersion) {
      draft.mvpPublication.version = packageVersion;
    }
    if (publishedSkill?.mvpPublication?.publicationId === publication.publicationId && publishedSkill.version === previousVersion) {
      publishedSkill.version = packageVersion;
      publishedSkill.mvpPublication.version = packageVersion;
    }
    return true;
  }

  function migrateBusinessGroupFields(target = {}, { sourceRef = "", departmentId = "", level = "", existingSkill = null } = {}) {
    if (!target || typeof target !== "object") return false;
    const currentRecommendation = normalizeBusinessGroupRecommendation(target.businessGroupRecommendation, "migration");
    const recommendation = currentRecommendation && !isExternalImportGroup(currentRecommendation.label)
      ? currentRecommendation
      : recommendBusinessGroup({
          input: {
            businessGroup: target.businessGroup,
            businessGroupName: target.businessGroupName,
            groupName: target.groupName,
            recommendedBusinessGroup: target.recommendedBusinessGroup,
            domain: target.domain,
            skillName: target.name || target.skillName,
            externalEmployeeName: target.externalEmployeeName,
            sourceSkillId: target.sourceSkillId,
            externalEmployeeSummary: target.externalEmployeeSummary,
            skillSummary: target.skillSummary,
            manifestSummary: target.manifestSummary || target.description,
            safeSummary: target.safeSummary,
          },
          sourceRef,
          departmentId,
          existingSkill,
          level,
        });
    const nextBusinessGroup = firstBusinessGroupLabel([target.businessGroup]) || recommendation.label;
    const nextDomain = firstBusinessGroupLabel([target.domain]) || recommendation.domainLabel || recommendation.label;
    const nextBusinessGroupId = target.businessGroupId && !isExternalImportGroup(target.businessGroupId) ? target.businessGroupId : recommendation.groupId;
    let changed = false;
    if (!currentRecommendation || isExternalImportGroup(currentRecommendation.label)) {
      target.businessGroupRecommendation = recommendation;
      changed = true;
    }
    if (target.businessGroupId !== nextBusinessGroupId) {
      target.businessGroupId = nextBusinessGroupId;
      changed = true;
    }
    if (target.businessGroup !== nextBusinessGroup) {
      target.businessGroup = nextBusinessGroup;
      changed = true;
    }
    if (target.domain !== nextDomain) {
      target.domain = nextDomain;
      changed = true;
    }
    return changed;
  }

  function systemImportStoreFailure(res, persistResult) {
    return sendJson(res, 500, {
      ok: false,
      error: "system_import_store_write_failed",
      contractVersion: "system-import-state.v1",
      message: "系统接入/技能评审状态未能写入 MVP 文件存储，已回滚本次内存状态。",
      detail: persistResult.error,
    });
  }

  function normalizeReviewDecision(value) {
    return normalizeReviewDecisionValue(value, cleanText);
  }

  function autoRouteExternalCapabilityJob(job, { skillUploadHarness = false, employeeUploadHarness = false, actor = "" } = {}) {
    const decidedAt = new Date().toISOString();
    const refs = draftRefsForJob(job);
    const skillRefs = refs.filter(({ kind }) => kind === "skillDrafts" || kind === "skillUpdateDrafts");
    const sourceRegistrationRefs = refs.filter(({ kind, draft }) => kind === "externalEmployeeDrafts" && isSkillPackageSourceRegistrationDraft(draft));
    const employeeRefs = refs.filter(({ kind, draft }) => kind === "externalEmployeeDrafts" && !isSkillPackageSourceRegistrationDraft(draft));
    if (!skillUploadHarness && !employeeUploadHarness) return;

    sourceRegistrationRefs.forEach(({ draft }) => {
      draft.status = "system_state_recorded";
      draft.reviewDecision = {
        decision: "auto_recorded",
        status: draft.status,
        decidedAt,
        decidedBy: actor || "system",
        note: "上传来源已作为后台系统状态记录；不再要求人工阅读来源草案。",
        nextGate: skillRefs.length ? "已自动触发 Agent 预审核，生成 Skill/员工评审稿。" : "等待后端安全解包或补充 Skill 声明。",
        workflowEffect: "background_source_state_recorded",
        productionEffect: "none",
      };
    });

    if (skillUploadHarness || skillRefs.length) {
      skillRefs.forEach(({ draft }) => {
        draft.status = skillAutoReviewStatus;
        draft.reviewDecision = {
          decision: "auto_routed",
          status: draft.status,
          decidedAt,
          decidedBy: actor || "system",
          note: "上传后自动进入 Agent 预审核；人工只消费整理后的 Skill 评审稿。",
          nextGate: "技能/员工评审读取 Agent 预审核结果后人工确认。",
          workflowEffect: "skill_employee_review_required",
          productionEffect: "none",
        };
        const summaryDraft = skillEmployeeReviewHandlers.summarizeSkillReviewDraft(job, "skillDrafts", draft);
        const execution = skillAgentPreReview.ensure(summaryDraft);
        draft.agentPreReview = execution;
      });
    }

    if (employeeUploadHarness) {
      employeeRefs.forEach(({ draft }) => {
        draft.status = personnelApprovalStatus;
        draft.reviewDecision = {
          decision: "auto_routed",
          status: draft.status,
          decidedAt,
          decidedBy: actor || "system",
          note: "上传后自动进入人员审批；人工确认归属、权限范围和试运行资格。",
          nextGate: "人员审批",
          workflowEffect: "personnel_approval_required",
          productionEffect: "none",
        };
      });
    }

    job.status = statusForReviewedJob(job);
    job.updatedAt = decidedAt;
    job.autoWorkflow = {
      status: job.status,
      routedAt: decidedAt,
      routedBy: actor || "system",
      mode: skillUploadHarness ? "skill_upload_auto_agent_pre_review" : "employee_upload_auto_route",
      sourceState: sourceRegistrationRefs.length ? "background_only" : "none",
      skillDraftCount: skillRefs.length,
      employeeDraftCount: employeeRefs.length,
      agentPreReviewCount: skillRefs.filter(({ draft }) => draft.agentPreReview).length,
      nextGate: skillRefs.length ? "技能/员工评审" : employeeRefs.length ? "人员审批" : "待补充材料",
      note: "系统接入草案只保留为后台状态；前台人工评审以 Agent 预审核后的评审稿为准。",
    };
    job.reviewDecision = {
      decision: "auto_routed",
      status: job.status,
      decidedAt,
      decidedBy: actor || "system",
      note: job.autoWorkflow.note,
      nextGate: job.autoWorkflow.nextGate,
      workflowEffect: job.autoWorkflow.mode,
      productionEffect: "none",
      draftIds: refs.map(({ draft }) => draft.draftId),
    };
  }

  function normalizeSkillManifestId(input, sourceRef) {
    return normalizeSystemImportSkillId(input, sourceRef, { cleanText, cleanEntityId });
  }

  function fixedWorkerAssignment(kind) {
    const worker =
      kind === "external_employee" || kind === "repo_skill_manifest" || kind === "system_employee_candidate"
        ? workerById().get("external-agent-precheck")
        : workerById().get("audit-precheck-main") || currentPreReviewWorkers()[0];
    return {
      mode: "fixed_pre_review_worker",
      status: "assigned_for_review",
      workerId: worker?.id || "audit-precheck-main",
      workerName: worker?.name || "审计预审 Worker",
      workerEmployeeId: worker?.ownerEmployeeId || "system-ingestion-agent",
      lane: worker?.lane || "audit_precheck",
      provider: worker?.provider || "codex",
      model: worker?.model || "gpt-5.5",
      reasoningEffort: worker?.reasoningEffort || "high",
      credentialLeasePolicy: "server_side_runtime_lease",
      assignmentScope: "install_pre_review",
      privacyBoundary: "固定 worker 只表示安装预审责任归属；真实 provider key 和执行 payload 必须在服务端按需租约。",
    };
  }

  function buildImportPreReview(kind, draft, assignedWorker = fixedWorkerAssignment(kind)) {
    return {
      status: "queued",
      executionMode: "demo_safe_summary_queue",
      workerId: assignedWorker.workerId,
      workerName: assignedWorker.workerName,
      workerEmployeeId: assignedWorker.workerEmployeeId,
      lane: assignedWorker.lane,
      provider: assignedWorker.provider,
      model: assignedWorker.model,
      reasoningEffort: assignedWorker.reasoningEffort,
      assignmentMode: assignedWorker.mode,
      recommendation: kind === "system_employee_candidate" ? "manual_admin_review_required" : "manual_review",
      safeFindings: preReviewFindings(kind, draft),
      expectedOutputs: ["评估结论", "风险点", "缺口清单", "下一步审核门禁"],
    };
  }

  function requirePermission(req, res, permission) {
    const session = requireSession(req, res);
    if (!session) return null;
    if (!hasPermission(session.permissions, permission)) {
      sendJson(res, 403, {
        ok: false,
        error: "system_governance_required",
        requiredPermission: permission,
      });
      return null;
    }
    return session;
  }

  function unsafePayload(res, unsafeKeys) {
    return sendJson(res, 422, {
      ok: false,
      error: "unsafe_import_payload",
      contractVersion: "system-import-job.v1",
      unsafeKeys,
      message: forbiddenDataWarning,
    });
  }

  function unsafeSourceRef(res) {
    return sendJson(res, 422, {
      ok: false,
      error: "unsafe_source_ref",
      contractVersion: "system-import-job.v1",
      message: "sourceRef must not include tokens, tickets, keys, passwords, or other secret-bearing query parameters.",
    });
  }

  function cleanSourceRef(value) {
    return cleanText(value).slice(0, 300);
  }

  function inferSkillKind(input, departmentId) {
    const rawKind = cleanText(input.skillKind || input.capabilityType || input.kind).toLowerCase();
    if (rawKind.includes("basic") || rawKind.includes("基础")) return "basic_skill_candidate";
    if (rawKind.includes("business") || rawKind.includes("业务")) return "business_skill_candidate";
    return departmentId && departmentId !== "digital-office" ? "business_skill_candidate" : "basic_skill_candidate";
  }

  function normalizeEmployeeLevel(value) {
    const text = cleanText(value);
    if (/worker|system|系统|平台|ai/i.test(text)) return "系统级";
    return "业务级";
  }

  function normalizeDepartmentId(value) {
    const text = cleanText(value);
    if (!text) return "";
    if (/^(rd|研发|研发部|软件|软件组|软件部|software|software-group)$/i.test(text)) return "rd";
    if (/^(hr|人力|人力资源|人力资源部)$/i.test(text)) return "hr";
    if (/^(ops|运营|运营中心)$/i.test(text)) return "ops";
    if (/^(delivery|交付|交付与项目管理部|项目交付)$/i.test(text)) return "delivery";
    if (/^(finance|财务|经营|财务与经营分析部)$/i.test(text)) return "finance";
    if (/^(digital-office|数字化|数字化管理办公室|平台)$/i.test(text)) return "digital-office";
    return cleanEntityId(text);
  }

  function cleanEntityId(value) {
    const text = cleanText(value)
      .toLowerCase()
      .replace(/[^a-z0-9\u4e00-\u9fa5]+/g, "-")
      .replace(/^-+|-+$/g, "");
    return text.slice(0, 80) || "unknown";
  }

  function cleanIdentifier(value) {
    const text = cleanText(value)
      .toLowerCase()
      .replace(/[^a-z0-9_\-\u4e00-\u9fa5]+/g, "-")
      .replace(/^-+|-+$/g, "");
    return text.slice(0, 80) || "";
  }

  function draftId(prefix, value) {
    return `${prefix}-${cleanEntityId(value)}-${Date.now()}`;
  }

  function boundedNumber(value, min, max, fallback) {
    const number = Number(value);
    if (!Number.isFinite(number)) return fallback;
    return Math.min(max, Math.max(min, number));
  }

  function hasUnsafeUrlSecret(value) {
    return /[?&](token|ticket|secret|key|password|credential)=/i.test(String(value || ""));
  }

  function findUnsafePayloadKeys(value, path = []) {
    if (!value || typeof value !== "object") return [];
    const unsafe = [];
    for (const [key, child] of Object.entries(value)) {
      const normalizedKey = key.replace(/[-\s]/g, "").toLowerCase();
      const childPath = [...path, key];
      if (forbiddenPayloadKeys.has(normalizedKey)) {
        unsafe.push(childPath.join("."));
      }
      if (child && typeof child === "object") {
        unsafe.push(...findUnsafePayloadKeys(child, childPath));
      }
    }
    return unsafe;
  }

  return {
    handle,
    listRuntimeBusinessSkills: skillEmployeeReviewHandlers.listRuntimeBusinessSkills,
    listRuntimeDigitalEmployees: skillEmployeeReviewHandlers.listRuntimeDigitalEmployees,
    listEvaluationDatasetReviews: evaluationDatasetReviewHandlers.listReviews,
  };
}
