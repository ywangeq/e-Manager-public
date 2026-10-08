export function createSystemImportDraftFactory({
  algorithmClusterSkillIds,
  cleanEntityId,
  cleanList,
  cleanText,
  knownAlgorithmSkillMeta,
  packageIntakeBoundary,
  recommendBusinessGroup,
  skillById,
}) {
  function skillDraftForKnownSkill({
    skillId,
    input,
    sourceRef,
    sourceType,
    targetDepartmentId,
    kind,
    name = "",
    ownerHint = "",
    risk = "",
    reviewGate = "",
    mountHints = null,
    packageUnit = null,
  }) {
    const existingSkill = skillById.get(skillId);
    const knownSkill = knownAlgorithmSkillMeta(skillId);
    const isHarnessSkill = /-skill$/.test(skillId) && /upload_harness/i.test(cleanText(input.intakeMode || ""));
    const resolvedTargetDepartmentId = targetDepartmentId || "pending-owner-department";
    const resolvedSourceSkillId = cleanText(packageUnit?.sourceSkillId || knownSkill.sourceSkillId || existingSkill?.sourceSkillId || input.sourceSkillId || "");
    const resolvedName = cleanText(name || packageUnit?.name || knownSkill.name || existingSkill?.name || input.skillName || skillId);
    const businessGroupRecommendation = recommendBusinessGroup({
      input: {
        ...input,
        skillName: resolvedName,
        sourceSkillId: resolvedSourceSkillId,
      },
      sourceRef,
      departmentId: resolvedTargetDepartmentId,
      packageAnalysis: packageUnit?.packageAnalysis,
      packageUnit,
      existingSkill,
      knownSkill,
    });
    return {
      draftId: draftId("SKD", `${sourceType}-${skillId}`),
      kind: kind || (existingSkill ? "business_skill_mount_review" : "business_skill_candidate"),
      skillId,
      skillApiId: packageUnit?.skillApiId || knownSkill.skillApiId || existingSkill?.skillApiId || skillId,
      sourceSkillId: resolvedSourceSkillId,
      skillPackageIdentity: packageUnit?.skillPackageIdentity || existingSkill?.skillPackageIdentity || null,
      runtimeHarnessIdentity: packageUnit?.runtimeHarnessIdentity || existingSkill?.runtimeHarnessIdentity || null,
      runtimeHarnessArtifact: packageUnit?.runtimeHarnessArtifact || null,
      runtimeExecutionProfile: packageUnit?.runtimeExecutionProfile || existingSkill?.runtimeExecutionProfile || null,
      name: resolvedName,
      namespace: cleanText(input.namespace || "external.business"),
      sourceRef,
      sourceType,
      targetDepartmentId: resolvedTargetDepartmentId,
      businessGroupRecommendation,
      businessGroupId: businessGroupRecommendation.groupId,
      businessGroup: businessGroupRecommendation.label,
      domain: cleanText(existingSkill?.domain || knownSkill.domain || businessGroupRecommendation.domainLabel || businessGroupRecommendation.label),
      ownerHint,
      status: "pending_review",
      versionIntent: cleanText(input.skillVersion || input.version || input.declaredVersion || "draft"),
      manifestSummary: cleanText(packageUnit?.manifestSummary || knownSkill.manifestSummary || input.skillSummary || input.manifestSummary || input.safeSummary || input.externalEmployeeSummary || ""),
      declaredInputs: packageUnit?.declaredInputs || knownSkill.declaredInputs || cleanList(input.declaredInputs || input.inputs),
      declaredOutputs: packageUnit?.declaredOutputs || knownSkill.declaredOutputs || cleanList(input.declaredOutputs || input.outputs),
      tools: packageUnit?.tools || knownSkill.tools || cleanList(input.skillTools || input.toolClaims || input.tools),
      constraints: packageUnit?.constraints || knownSkill.constraints || cleanList(input.skillConstraints || input.constraints),
      executionGuidance: packageUnit?.executionGuidance || knownSkill.executionGuidance || cleanList(input.executionGuidance),
      runtimeInstructions: packageUnit?.runtimeInstructions || existingSkill?.runtimeInstructions || input.runtimeInstructions || null,
      runtimeReferences: packageUnit?.runtimeReferences || existingSkill?.runtimeReferences || input.runtimeReferences || [],
      packageFormat: cleanText(knownSkill.packageFormat || ""),
      packageCompleteness: cleanText(knownSkill.packageCompleteness || ""),
      packageIncludes: cleanList(knownSkill.packageIncludes),
      packageBoundary: knownSkill.packageBoundary || null,
      packageRecordBoundary: cleanText(knownSkill.packageRecordBoundary || ""),
      packageIntake: packageIntakeBoundary(input, sourceRef, packageUnit?.packageAnalysis),
      packageUnitPath: cleanText(packageUnit?.skillPath || ""),
      packageReadSummary: packageUnit?.readSummary || null,
      downloadPolicy: knownSkill.downloadPolicy || null,
      installGranularity: cleanText(knownSkill.installGranularity || ""),
      identityRule: cleanText(
        knownSkill.identityRule ||
          (isHarnessSkill
            ? "Harness generated Skill ID from uploader department and source/package path for department-level duplicate review; final sourceSkillId is confirmed in Skill review."
            : ""),
      ),
      decompositionRule: cleanList(knownSkill.decompositionRule),
      packageBundleSkillIds: cleanList(knownSkill.packageBundleSkillIds),
      dependencySkillIds: cleanList(knownSkill.dependencySkillIds),
      apiDependencySkillIds: cleanList(knownSkill.apiDependencySkillIds),
      referenceSkillIds: cleanList(knownSkill.referenceSkillIds),
      unitCapabilityRule: cleanText(knownSkill.unitCapabilityRule || ""),
      dependencyPolicy: cleanList(knownSkill.dependencyPolicy),
      referencePolicy: cleanList(knownSkill.referencePolicy),
      lineageKey: cleanText(packageUnit?.sourceSkillId || knownSkill.sourceSkillId || existingSkill?.sourceSkillId || input.sourceSkillId || skillId),
      lineageRule: packageUnit
        ? "Agent package reader derived this unit from a package SKILL.md; final lineage is anchored by sourceSkillId plus package path."
        : isHarnessSkill
        ? "Harness draft IDs support department-level duplicate review; final lineage is anchored after SKILL.md/sourceSkillId verification."
        : "Display name may change; lineage and distribution are anchored by skillId/sourceSkillId.",
      risk: risk || cleanText(input.riskHint || input.risk || "待评估"),
      existingSkill: existingSkill ? { id: existingSkill.id, version: existingSkill.version, status: existingSkill.status } : null,
      reviewGate: reviewGate || "Skill owner + 平台质量审核确认 Skill ID、输入输出、版本意图、Prompt 元数据、回归候选和挂载员工影响。",
      mountHints: mountHints || cleanList(input.mountEmployeeIds || input.mountedDigitalEmployees || input.candidateEmployeeIds),
      promptGovernance: {
        rawPromptStored: false,
        promptVersion: cleanText(packageUnit?.promptVersion || input.promptVersion || ""),
        promptHash: cleanText(packageUnit?.promptHash || input.promptHash || ""),
        promptMetadataAutoCompleted: Boolean(packageUnit?.promptMetadataAutoCompleted),
        promptMetadataSource: cleanText(packageUnit?.promptMetadataSource || ""),
        requiredBeforePublish: true,
      },
      privacyBoundary: "仅保存外部 Skill 安全摘要、清洗后的 SKILL.md 指令体、运行 reference、输入输出、工具 claims、版本意图和挂载提示；不保存 raw prompt 或私有 payload。",
    };
  }

  function linkedSkillDraftsForExternalEmployee(input, employeeDraft, sourceRef, packageAnalysis = null) {
    const packageSkills = Array.isArray(packageAnalysis?.skillUnits) ? packageAnalysis.skillUnits : [];
    if (packageSkills.length) {
      return packageSkills.map((unit) => skillDraftForKnownSkill({
        skillId: unit.skillId,
        input: {
          ...input,
          sourceSkillId: unit.sourceSkillId,
          skillName: unit.name,
          skillSummary: unit.manifestSummary,
          declaredInputs: unit.declaredInputs,
          declaredOutputs: unit.declaredOutputs,
          skillTools: unit.tools,
          skillConstraints: unit.constraints,
          executionGuidance: unit.executionGuidance,
          runtimeInstructions: unit.runtimeInstructions,
          runtimeReferences: unit.runtimeReferences,
          promptVersion: unit.promptVersion,
          promptHash: unit.promptHash,
        },
        sourceRef,
        sourceType: "package_skill_unit",
        targetDepartmentId: employeeDraft.departmentId || "pending-owner-department",
        kind: skillById.has(unit.skillId) ? "business_skill_mount_review" : "business_skill_candidate",
        name: unit.name,
        ownerHint: employeeDraft.ownerHint,
        risk: unit.risk || employeeDraft.risk,
        reviewGate: "Agent 已读取包内 SKILL.md 安全摘要；Skill owner + 平台质量审核确认 Skill ID、输入输出、权限工具、Prompt 元数据和挂载影响。",
        mountHints: [employeeDraft.externalEmployeeId],
        packageUnit: unit,
      }));
    }

    return (employeeDraft.mountedSkillHints || []).map((skillHint) => {
      const skillId = cleanEntityId(skillHint);
      return skillDraftForKnownSkill({
        skillId,
        input,
        sourceRef,
        sourceType: "external_employee_repo_link",
        targetDepartmentId: employeeDraft.departmentId || "pending-owner-department",
        kind: skillById.has(skillId) ? "business_skill_mount_review" : "business_skill_candidate",
        ownerHint: employeeDraft.ownerHint,
        risk: employeeDraft.risk,
        reviewGate: "Skill owner + 平台质量审核确认 Skill ID、输入输出、版本意图、Prompt 元数据、回归候选和挂载员工影响。",
        mountHints: [employeeDraft.externalEmployeeId],
      });
    });
  }

  function expandMountedSkillHints(input, sourceRef, departmentId = "", packageAnalysis = null) {
    const packageSkillIds = cleanList((packageAnalysis?.skillUnits || []).map((unit) => unit.skillId));
    if (packageSkillIds.length) return packageSkillIds;
    const explicitHints = cleanList(input.mountedSkillIds || input.businessSkillIds || input.skillIds);
    if (!explicitHints.length && /skill_upload_harness/i.test(cleanText(input.intakeMode || ""))) {
      return [harnessSkillId(sourceRef, departmentId)];
    }
    return explicitHints;
  }

  function uniqueCleanList(values) {
    const seen = new Set();
    return values
      .map((value) => normalizeSkillHintId(value))
      .filter((value) => {
        if (!value || seen.has(value)) return false;
        seen.add(value);
        return true;
      });
  }

  function normalizeSkillHintId(value) {
    const text = cleanText(value);
    return cleanEntityId(text);
  }

  function harnessSkillId(sourceRef, departmentId = "") {
    return cleanEntityId(`${departmentId || "unknown-department"}-${harnessSourceKey(sourceRef)}-skill`);
  }

  function harnessSourceKey(sourceRef) {
    const text = cleanText(sourceRef).slice(0, 300).replace(/^[a-z][a-z0-9+.-]*:\/\//i, "");
    const sourcePath = text.split(/[?#]/)[0];
    const tail = sourcePath.split("/").filter(Boolean).pop();
    return cleanEntityId(tail || text || "external-source");
  }

  function sessionDepartmentId(session, isSystemLevel = false) {
    if (isSystemLevel) return "digital-office";
    return cleanEntityId(session?.departmentId || "pending-owner-department");
  }

  function draftId(prefix, value) {
    return `${prefix}-${cleanEntityId(value)}-${Date.now()}`;
  }

  return {
    expandMountedSkillHints,
    harnessSourceKey,
    linkedSkillDraftsForExternalEmployee,
    sessionDepartmentId,
    skillDraftForKnownSkill,
  };
}
