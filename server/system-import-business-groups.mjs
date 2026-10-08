export function createBusinessGroupResolver({ cleanEntityId, cleanText }) {
  function departmentLabelForId(departmentId) {
    if (departmentId === "rd") return "研发部";
    if (departmentId === "hr") return "人力资源部";
    if (departmentId === "digital-office") return "数字化管理办公室";
    if (departmentId === "delivery") return "交付与项目管理部";
    if (departmentId === "ops") return "运营中心";
    if (departmentId === "finance") return "财务与经营分析部";
    return departmentId || "待绑定部门";
  }

  function recommendBusinessGroup({
    input = {},
    sourceRef = "",
    departmentId = "",
    packageAnalysis = null,
    packageUnit = null,
    existingSkill = null,
    knownSkill = null,
    level = "",
  } = {}) {
    const explicitRecommendation = normalizeBusinessGroupRecommendation(
      input.businessGroupRecommendation ||
        packageUnit?.businessGroupRecommendation ||
        existingSkill?.businessGroupRecommendation ||
        knownSkill?.businessGroupRecommendation,
      "declared",
    );
    if (explicitRecommendation) return explicitRecommendation;

    const explicitLabel = firstBusinessGroupLabel([
      input.businessGroup,
      input.businessGroupName,
      input.groupName,
      input.recommendedBusinessGroup,
      input.domain,
      packageUnit?.businessGroup,
      packageUnit?.domain,
      existingSkill?.businessGroup,
      existingSkill?.domain,
      knownSkill?.businessGroup,
      knownSkill?.domain,
    ]);
    if (explicitLabel) {
      return businessGroupRecommendation({
        groupId: cleanEntityId(explicitLabel),
        label: explicitLabel,
        confidence: 0.95,
        source: "declared",
        rationale: "导入材料或既有目录字段已声明业务组；仍需人工门禁确认。",
      });
    }

    const text = businessGroupText([
      sourceRef,
      input.skillName,
      input.externalEmployeeName,
      input.name,
      input.sourceSkillId,
      input.externalEmployeeSummary,
      input.skillSummary,
      input.manifestSummary,
      input.safeSummary,
      packageUnit?.name,
      packageUnit?.sourceSkillId,
      packageUnit?.skillPath,
      packageUnit?.manifestSummary,
      ...(Array.isArray(packageUnit?.declaredInputs) ? packageUnit.declaredInputs : []),
      ...(Array.isArray(packageUnit?.declaredOutputs) ? packageUnit.declaredOutputs : []),
      ...(Array.isArray(packageUnit?.tools) ? packageUnit.tools : []),
      ...(Array.isArray(packageUnit?.constraints) ? packageUnit.constraints : []),
      ...(Array.isArray(packageAnalysis?.skillUnits)
        ? packageAnalysis.skillUnits.flatMap((unit) => [
            unit.name,
            unit.sourceSkillId,
            unit.skillPath,
            unit.manifestSummary,
          ])
        : []),
    ]);
    const matchedRule = businessGroupRules().find((rule) => rule.pattern.test(text));
    if (matchedRule) {
      return businessGroupRecommendation({
        groupId: matchedRule.groupId,
        label: matchedRule.label,
        teamId: matchedRule.teamId,
        teamLabel: matchedRule.teamLabel,
        domainId: matchedRule.domainId,
        domainLabel: matchedRule.domainLabel,
        confidence: matchedRule.confidence,
        source: "agent_parse",
        rationale: matchedRule.rationale,
      });
    }

    return businessGroupRecommendation(businessGroupForDepartment(departmentId, level));
  }

  function businessGroupRules() {
    return [
      {
        groupId: "rd-governance",
        label: "研发治理",
        teamId: "rd-software",
        teamLabel: "软件组",
        domainId: "smoss-solution-governance",
        domainLabel: "SMoss 方案治理",
        confidence: 0.91,
        pattern: /smoss|smg|basicentitymanager|实例\.json|存图管理|动作管理|entity-config|config-check|camera2d|camera3d|lightcontroller|plc|rpc|imagedirector|algodirector|方案配置/i,
        rationale: "包内名称、路径或摘要包含 SMoss/SMG 方案配置、实例、动作、存图或设备实体审计语义；归入研发治理下的软件组能力线。",
      },
      {
        groupId: "customer-support",
        label: "客户支持",
        confidence: 0.86,
        pattern: /客户|客服|工单|售后|回复建议|customer|support|ticket/i,
        rationale: "包内名称、摘要或输入输出包含客户支持/工单回复语义。",
      },
      {
        groupId: "legal-compliance",
        label: "法务与合规",
        teamId: "legal-ip",
        teamLabel: "法务与IP",
        domainId: "contract-approval-risk",
        domainLabel: "合同审批与风险管理",
        confidence: 0.92,
        pattern: /法务|法律意见|合同|违约|知识产权|legal|contract/i,
        rationale: "包内名称、摘要或输入输出包含法务、合同审批、违约或知识产权风险语义；归入法务与合规能力线。",
      },
      {
        groupId: "rd-project-management",
        label: "研发项目管理",
        confidence: 0.9,
        pattern: /edos|rnd|digital-pm|pm管理|项目经理|项目管理|飞书\s*base|巡检|周报|超期|delay|阻塞|里程碑|project/i,
        rationale: "包内名称、路径或摘要包含 EDOS/PM/项目进度管理语义。",
      },
      {
        groupId: "rd-governance",
        label: "研发治理",
        teamId: "rd-algorithm",
        teamLabel: "算法组",
        domainId: "algorithm-rd",
        domainLabel: "算法研发",
        confidence: 0.9,
        pattern: /算法|simo|kdl|smore|sdk|dvc|模型|训练|标签|缺陷|视觉|回归|dataset|cluster/i,
        rationale: "包内名称、路径或摘要包含算法研发、SDK、训练或回归语义；归入研发治理下的算法组能力线。",
      },
      {
        groupId: "human-resources",
        label: "人力资源",
        confidence: 0.84,
        pattern: /hr|简历|招聘|候选人|入职|人事|员工材料/i,
        rationale: "导入材料包含招聘、人事或候选人流程语义。",
      },
      {
        groupId: "project-delivery",
        label: "项目交付",
        confidence: 0.78,
        pattern: /交付|客户项目|实施|上线计划|验收|项目周报/i,
        rationale: "导入材料包含交付、实施或项目验收语义。",
      },
      {
        groupId: "rd-governance",
        label: "研发治理",
        confidence: 0.74,
        pattern: /研发|发布|代码|接口|api|release|merge|mr|gitlab/i,
        rationale: "导入材料包含研发发布、接口或代码治理语义。",
      },
      {
        groupId: "business-operations",
        label: "运营管理",
        confidence: 0.72,
        pattern: /运营|活动|投放|增长|用户|ops|operation/i,
        rationale: "导入材料包含运营流程语义。",
      },
      {
        groupId: "finance-analytics",
        label: "经营管理",
        confidence: 0.72,
        pattern: /财务|经营|预算|费用|报销|finance|revenue|成本/i,
        rationale: "导入材料包含财务、经营或成本分析语义。",
      },
    ];
  }

  function businessGroupForDepartment(departmentId, level = "") {
    const map = {
      rd: { groupId: "rd-governance", label: "研发治理", confidence: 0.58 },
      hr: { groupId: "human-resources", label: "人力资源", confidence: 0.58 },
      delivery: { groupId: "project-delivery", label: "项目交付", confidence: 0.58 },
      ops: { groupId: "business-operations", label: "运营管理", confidence: 0.58 },
      finance: { groupId: "finance-analytics", label: "经营管理", confidence: 0.58 },
    };
    const matched = map[departmentId];
    if (matched) {
      return {
        ...matched,
        source: "uploader_department",
        rationale: `未解析到明确业务组，按上传者部门 ${departmentLabelForId(departmentId)} 给出低置信建议。`,
      };
    }
    if (level === "系统级") {
      return {
        groupId: "platform-governance",
        label: "平台治理",
        confidence: 0.55,
        source: "system_level_default",
        rationale: "系统级候选默认进入平台治理组，由系统管理员确认。",
      };
    }
    return {
      groupId: "pending-business-group",
      label: "待确认业务组",
      confidence: 0.4,
      source: "fallback",
      rationale: "导入材料未提供足够业务语义；需要业务 owner 在评审时确认归属组。",
    };
  }

  function normalizeBusinessGroupRecommendation(value, source) {
    if (!value) return null;
    if (typeof value === "object") {
      const label = firstBusinessGroupLabel([value.label, value.businessGroup, value.groupName, value.domain]);
      if (!label) return null;
      return businessGroupRecommendation({
        groupId: cleanText(value.groupId || value.id || cleanEntityId(label)),
        label,
        teamId: value.teamId,
        teamLabel: value.teamLabel,
        domainId: value.domainId,
        domainLabel: value.domainLabel,
        confidence: Number(value.confidence) || 0.95,
        source: cleanText(value.source || source || "declared"),
        rationale: cleanText(value.rationale || "导入材料已声明业务组建议；仍需人工门禁确认。"),
        nextGate: cleanText(value.nextGate || ""),
      });
    }
    const label = firstBusinessGroupLabel([value]);
    if (!label) return null;
    return businessGroupRecommendation({
      groupId: cleanEntityId(label),
      label,
      confidence: 0.95,
      source: source || "declared",
      rationale: "导入材料已声明业务组建议；仍需人工门禁确认。",
    });
  }

  function businessGroupRecommendation({
    groupId,
    label,
    confidence,
    source,
    rationale,
    nextGate = "",
    teamId = "",
    teamLabel = "",
    domainId = "",
    domainLabel = "",
  }) {
    const safeLabel = cleanText(label || "待确认业务组") || "待确认业务组";
    const safeDomainLabel = cleanText(domainLabel || "");
    const safeTeamLabel = cleanText(teamLabel || "");
    return {
      groupId: cleanEntityId(groupId || safeLabel),
      label: safeLabel,
      domainId: cleanEntityId(domainId || safeDomainLabel || ""),
      domainLabel: safeDomainLabel,
      teamId: cleanEntityId(teamId || safeTeamLabel || ""),
      teamLabel: safeTeamLabel,
      confidence: Number.isFinite(Number(confidence)) ? Number(confidence) : 0.5,
      source: cleanText(source || "fallback"),
      rationale: cleanText(rationale || "需要业务 owner 在评审时确认归属组。"),
      nextGate: cleanText(nextGate || "技能/员工评审确认业务组、归属部门、owner、权限边界和发布门禁。"),
    };
  }

  function firstBusinessGroupLabel(values = []) {
    return values
      .map((value) => cleanText(value))
      .find((value) => value && !isExternalImportGroup(value)) || "";
  }

  function isExternalImportGroup(value) {
    return /^(外部导入|external import|external-import|external-source|source-ref|软件组\s*\/\s*smoss\s*方案治理)$/i.test(cleanText(value));
  }

  function businessGroupText(values = []) {
    return values
      .map((value) => cleanText(value))
      .filter(Boolean)
      .join(" ")
      .toLowerCase();
  }

  return {
    departmentLabelForId,
    firstBusinessGroupLabel,
    isExternalImportGroup,
    normalizeBusinessGroupRecommendation,
    recommendBusinessGroup,
  };
}
