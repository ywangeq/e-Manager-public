import { hasPermission } from "../src/lib/permissions.js";

const PRIVACY_BOUNDARY =
  "仅返回数字员工、Skill、分发、调用门禁和历史申请的安全治理摘要；不返回 raw prompt、完整 Skill manifest、provider key、模型 trace、AI 执行记录、生成 payload、员工 PII、客户数据、原始子系统数据、raw 简历、OCR 文本或候选人联系方式。";

export function buildCapabilityCatalog({
  url,
  session,
  digitalEmployees,
  businessSkills,
  basicSkills,
  capabilityRequests,
  distributionPlans,
  invocationPolicies,
  subsystemRegistry,
}) {
  const query = readCapabilityCatalogQuery(url);
  const subsystem = query.sourceSystemId
    ? subsystemRegistry.find((item) => item.id === query.sourceSystemId)
    : null;
  const visibility = resolveCatalogVisibility({ session, subsystem, query });
  if (!visibility.allowed) {
    return {
      statusCode: 403,
      body: {
        ok: false,
        error: visibility.error,
        contractVersion: "capability-catalog.v1",
        privacyBoundary: PRIVACY_BOUNDARY,
      },
    };
  }

  const capabilityRows = digitalEmployees
    .map((employee) => buildDigitalEmployeeCapability({
      employee,
      query,
      visibility,
      businessSkills,
      basicSkills,
      capabilityRequests,
      distributionPlans,
      invocationPolicies,
    }))
    .filter(Boolean);
  const skillRows = [
    ...businessSkills.map((skill) => buildSkillCapability({ skill, skillKind: "business_skill", query, visibility, capabilityRequests })),
    ...basicSkills.map((skill) => buildSkillCapability({ skill, skillKind: "basic_skill", query, visibility, capabilityRequests })),
  ].filter(Boolean);

  return {
    statusCode: 200,
    body: {
      ok: true,
      status: "ready",
      contractVersion: "capability-catalog.v1",
      sourceSystemId: query.sourceSystemId,
      departmentId: query.departmentId,
      businessDomain: query.businessDomain,
      visibility: visibility.summary,
      capabilities: [...capabilityRows, ...skillRows],
      privacyBoundary: PRIVACY_BOUNDARY,
    },
  };
}

function readCapabilityCatalogQuery(url) {
  return {
    sourceSystemId: cleanText(url.searchParams.get("sourceSystemId")),
    departmentId: cleanText(url.searchParams.get("departmentId")),
    businessDomain: cleanText(url.searchParams.get("businessDomain")),
    status: cleanText(url.searchParams.get("status")),
    risk: cleanText(url.searchParams.get("risk")),
    include: new Set(
      String(url.searchParams.get("include") || "")
        .split(/[,\n;，；、]+/)
        .map(cleanText)
        .filter(Boolean),
    ),
    q: cleanText(url.searchParams.get("q")).toLowerCase(),
  };
}

function resolveCatalogVisibility({ session, subsystem, query }) {
  const isGovernanceSession = hasAnyPermission(session?.permissions, [
    "system:*",
    "control-plane:*",
    "subsystems:review",
    "quality-reviews:*",
    "digital-employees:*",
    "business-skills:*",
  ]);
  if (isGovernanceSession) {
    return {
      allowed: true,
      mode: "platform_governance",
      allowedDepartmentIds: ["*"],
      allowedSystemIds: ["*"],
      summary: {
        mode: "platform_governance",
        reason: "当前会话具有平台治理或系统管理员权限。",
      },
    };
  }

  if (session?.departmentId) {
    const allowedDepartmentIds = [session.departmentId];
    return {
      allowed: true,
      mode: "department_session",
      allowedDepartmentIds,
      allowedSystemIds: subsystem ? [subsystem.id] : [],
      summary: {
        mode: "department_session",
        reason: "当前企业会话仅可查看所属部门能力摘要。",
        departmentId: session.departmentId,
      },
    };
  }

  if (subsystem && query.departmentId && subsystem.departmentId === query.departmentId) {
    return {
      allowed: true,
      mode: "registered_subsystem",
      allowedDepartmentIds: [subsystem.departmentId],
      allowedSystemIds: [subsystem.id],
      summary: {
        mode: "registered_subsystem",
        reason: "登记子系统服务调用仅可查看自身部门和业务域可申请能力。",
        sourceSystemId: subsystem.id,
        departmentId: subsystem.departmentId,
        businessDomain: subsystem.businessDomain,
      },
    };
  }

  return {
    allowed: false,
    error: "capability_catalog_visibility_required",
  };
}

function buildDigitalEmployeeCapability({
  employee,
  query,
  visibility,
  businessSkills,
  basicSkills,
  capabilityRequests,
  distributionPlans,
  invocationPolicies,
}) {
  if (employee.level === "系统级") return null;
  const departmentId = employee.ownerDepartmentId || employee.departmentId;
  if (!departmentVisible(departmentId, visibility)) return null;
  if (query.departmentId && query.departmentId !== departmentId && visibility.mode !== "platform_governance") return null;
  if (query.status && employee.status !== query.status) return null;
  if (query.q && !employeeMatchesQuery(employee, query.q)) return null;

  const mountedBusinessSkills = businessSkills
    .filter((skill) => employee.businessSkillIds?.includes(skill.id))
    .filter((skill) => !query.businessDomain || domainMatches(skill, query.businessDomain))
    .filter((skill) => !query.risk || skill.risk === query.risk);
  if (query.businessDomain && !mountedBusinessSkills.length) return null;
  if (query.risk && !mountedBusinessSkills.length) return null;

  const mountedBasicSkills = basicSkills.filter((skill) => employee.basicSkillIds?.includes(skill.id));
  const relatedDistribution = findDistribution({ employee, query, distributionPlans, visibility });
  const relatedPolicy = findInvocationPolicy({ employee, query, invocationPolicies, visibility });
  const existingRequest = findExistingRequest({ employee, query, capabilityRequests, visibility });

  return {
    id: employee.id,
    type: "business_digital_employee",
    requestType: "business_digital_employee_application",
    name: employee.name,
    title: employee.title,
    status: employee.status,
    version: employee.version,
    departmentId,
    businessDomain:
      query.businessDomain ||
      relatedDistribution?.businessDomain ||
      existingRequest?.businessDomain ||
      relatedPolicy?.allowedBusinessDomains?.[0] ||
      capabilityBusinessDomain(employee, mountedBusinessSkills),
    owner: employee.owner,
    ownerDepartmentId: employee.ownerDepartmentId,
    permissionScope: employee.permissionScope,
    permissionSummary: employee.permissionSummary,
    risk: capabilityRisk(mountedBusinessSkills),
    reviewGate: employee.reviewGate || capabilityReviewGate(mountedBusinessSkills),
    requestedCapabilities: capabilityNames(employee, mountedBusinessSkills, mountedBasicSkills),
    businessSkills: mountedBusinessSkills.map(summarizeBusinessSkill),
    visibility: visibilityForCapability({ employee, visibility, relatedDistribution }),
    safeSummary: employee.objective || employee.title || employee.name,
    ...(query.include.has("distribution") || relatedDistribution
      ? { distribution: summarizeDistribution(relatedDistribution) }
      : {}),
    ...(query.include.has("invocationPolicy") || relatedPolicy
      ? { invocationPolicy: summarizeInvocationPolicy(relatedPolicy) }
      : {}),
    ...(query.include.has("existingRequest") || existingRequest
      ? { existingRequest: summarizeCapabilityRequest(existingRequest) }
      : {}),
  };
}

function buildSkillCapability({ skill, skillKind, query, visibility, capabilityRequests }) {
  const departmentId = skill.ownerDepartmentId || skill.departmentId || "digital-office";
  const reusableBasicSkill =
    skillKind === "basic_skill" &&
    departmentId === "digital-office" &&
    visibility.mode === "registered_subsystem";
  if (!departmentVisible(departmentId, visibility) && !reusableBasicSkill) return null;
  if (
    query.departmentId &&
    query.departmentId !== departmentId &&
    visibility.mode !== "platform_governance" &&
    !reusableBasicSkill
  ) return null;
  if (query.status && skill.status !== query.status) return null;
  if (query.risk && skill.risk !== query.risk) return null;
  if (query.businessDomain && skillKind !== "basic_skill" && !skillDomainMatches(skill, query.businessDomain)) return null;
  if (query.q && !skillMatchesQuery(skill, query.q)) return null;

  const relatedRequest = capabilityRequests.find((request) => {
    const systemMatches = query.sourceSystemId
      ? request.sourceSystemId === query.sourceSystemId
      : systemVisible(request.sourceSystemId, visibility);
    return systemMatches && request.targetSkillId === skill.id;
  });
  const version = skill.version;

  return {
    id: skill.id,
    type: skillKind === "business_skill" ? "platform_business_skill" : "platform_basic_skill",
    requestType: "platform_skill_application",
    name: skill.name,
    title: skill.category || skill.domain || "平台 Skill",
    status: skill.status,
    version,
    departmentId,
    businessDomain: skill.domain || skill.category || query.businessDomain || "platform-skill",
    owner: skill.owner,
    ownerDepartmentId: departmentId,
    permissionScope: skillKind === "business_skill" ? "departmentBusinessSkill" : "platformReusableSkill",
    permissionSummary: (skill.constraints || []).join("；"),
    risk: skill.risk || "中",
    reviewGate: skill.reviewGate,
    requestedCapabilities: [skill.name, ...(skill.tools || []), ...(skill.mountedBasicSkills || [])].filter(Boolean),
    businessSkills: skillKind === "business_skill" ? [summarizeBusinessSkill(skill)] : [],
    sourceAlignment: "update_existing_source",
    targetSourceRef: `platform.${skillKind}:${skill.id}@${version}`,
    visibility: visibilityForSkill({ skill, visibility }),
    safeSummary: skill.description || skill.name,
    ...(relatedRequest ? { existingRequest: summarizeCapabilityRequest(relatedRequest) } : {}),
  };
}

function findDistribution({ employee, query, distributionPlans, visibility }) {
  return distributionPlans.find((plan) => {
    const targetSystemMatches = query.sourceSystemId
      ? plan.targetSystemId === query.sourceSystemId || plan.sourceSystemId === query.sourceSystemId
      : systemVisible(plan.targetSystemId || plan.sourceSystemId, visibility);
    return (
      plan.sourceEmployeeId === employee.id &&
      targetSystemMatches &&
      (!query.departmentId || plan.departmentId === query.departmentId) &&
      (!query.businessDomain || plan.businessDomain === query.businessDomain)
    );
  });
}

function findInvocationPolicy({ employee, query, invocationPolicies, visibility }) {
  return invocationPolicies.find((policy) => {
    const callerMatches = query.sourceSystemId
      ? policy.allowedCallers?.includes(query.sourceSystemId)
      : (policy.allowedCallers || []).some((systemId) => systemVisible(systemId, visibility));
    return (
      policy.employeeId === employee.id &&
      callerMatches &&
      (!query.departmentId || policy.allowedDepartments?.includes(query.departmentId)) &&
      (!query.businessDomain || policy.allowedBusinessDomains?.includes(query.businessDomain))
    );
  });
}

function findExistingRequest({ employee, query, capabilityRequests, visibility }) {
  return capabilityRequests.find((request) => {
    const systemMatches = query.sourceSystemId
      ? request.sourceSystemId === query.sourceSystemId
      : systemVisible(request.sourceSystemId, visibility);
    return (
      request.targetEmployeeId === employee.id &&
      systemMatches &&
      (!query.departmentId || request.departmentId === query.departmentId) &&
      (!query.businessDomain || request.businessDomain === query.businessDomain)
    );
  });
}

function summarizeBusinessSkill(skill) {
  return {
    id: skill.id,
    type: "business_skill",
    name: skill.name,
    status: skill.status,
    version: skill.version,
    departmentId: skill.departmentId,
    businessDomain: skill.domain,
    risk: skill.risk,
    reviewGate: skill.reviewGate,
    permissionSummary: skill.constraints?.join("；") || "",
    safeSummary: skill.description,
  };
}

function summarizeDistribution(plan) {
  if (!plan) return null;
  return {
    id: plan.id,
    sourceSystemId: plan.sourceSystemId,
    targetSystemId: plan.targetSystemId,
    departmentId: plan.departmentId,
    businessDomain: plan.businessDomain,
    sourceEmployeeId: plan.sourceEmployeeId,
    sourceEmployeeVersion: plan.sourceEmployeeVersion,
    targetEmployeeIds: plan.targetEmployeeIds,
    targetSkillIds: plan.targetSkillIds,
    status: plan.status,
    rolloutPolicy: plan.rolloutPolicy,
    rollbackPolicy: plan.rollbackPolicy,
    reviewGate: plan.reviewGate,
    safeSummary: plan.safeSummary,
  };
}

function summarizeInvocationPolicy(policy) {
  if (!policy) return null;
  return {
    id: policy.id,
    employeeId: policy.employeeId,
    skillId: policy.skillId,
    allowedCallers: policy.allowedCallers,
    allowedDepartments: policy.allowedDepartments,
    allowedBusinessDomains: policy.allowedBusinessDomains,
    allowedActions: policy.allowedActions,
    deniedActions: policy.deniedActions,
    modelLimits: policy.modelLimits,
    resourceThresholds: policy.resourceThresholds,
    qualityThresholds: policy.qualityThresholds,
    confidenceThresholds: policy.confidenceThresholds,
    status: policy.status,
    reviewGate: policy.reviewGate,
    privacyBoundary: policy.privacyBoundary,
  };
}

function summarizeCapabilityRequest(request) {
  if (!request) return null;
  return {
    id: request.id,
    sourceSystemId: request.sourceSystemId,
    sourceRequestId: request.sourceRequestId,
    requestType: request.requestType,
    departmentId: request.departmentId,
    businessDomain: request.businessDomain,
    status: request.status,
    risk: request.risk,
    capabilityName: request.capabilityName,
    capabilityKind: request.capabilityKind,
    targetEmployeeId: request.targetEmployeeId,
    targetEmployeeName: request.targetEmployeeName,
    targetSkillId: request.targetSkillId,
    targetSkillName: request.targetSkillName,
    sourceAlignment: request.sourceAlignment,
    targetSourceRef: request.targetSourceRef,
    requestedCapabilities: request.requestedCapabilities,
    safeSummary: request.safeSummary,
    reviewGate: request.reviewGate,
  };
}

function visibilityForCapability({ employee, visibility, relatedDistribution }) {
  if (visibility.mode === "platform_governance") {
    return {
      mode: "platform_governance",
      reason: "平台治理权限可查看跨部门治理能力摘要。",
    };
  }
  if (relatedDistribution) {
    return {
      mode: "business_system_distribution",
      reason: "能力已有登记子系统分发映射或可申请记录。",
    };
  }
  if ((employee.ownerDepartmentId || employee.departmentId) === visibility.summary.departmentId) {
    return {
      mode: "department_ownership",
      reason: "能力归属部门与当前可见部门一致。",
    };
  }
  return {
    mode: visibility.mode,
    reason: visibility.summary.reason,
  };
}

function visibilityForSkill({ skill, visibility }) {
  if (visibility.mode === "platform_governance") {
    return {
      mode: "platform_governance",
      reason: "平台治理权限可查看跨部门 Skill 治理摘要。",
    };
  }
  if ((skill.ownerDepartmentId || skill.departmentId) === visibility.summary.departmentId) {
    return {
      mode: "department_skill_ownership",
      reason: "Skill 归属部门与当前可见部门一致。",
    };
  }
  return {
    mode: visibility.mode,
    reason: visibility.summary.reason,
  };
}

function capabilityNames(employee, mountedBusinessSkills, mountedBasicSkills) {
  return [
    employee.title,
    ...mountedBusinessSkills.map((skill) => skill.name),
    ...mountedBasicSkills.map((skill) => skill.name),
  ].filter(Boolean);
}

function capabilityBusinessDomain(employee, mountedBusinessSkills) {
  if (mountedBusinessSkills.length) return mountedBusinessSkills.map((skill) => skill.domain).join(" / ");
  return employee.level === "系统级" ? "platform-governance" : employee.department;
}

function capabilityRisk(mountedBusinessSkills) {
  const risks = mountedBusinessSkills.map((skill) => skill.risk).filter(Boolean);
  if (risks.includes("高")) return "高";
  if (risks.includes("中")) return "中";
  if (risks.includes("低")) return "低";
  return "待评估";
}

function capabilityReviewGate(mountedBusinessSkills) {
  return mountedBusinessSkills.map((skill) => skill.reviewGate).filter(Boolean).join("；") || "平台治理审核";
}

function domainMatches(skill, businessDomain) {
  return skill.domain === businessDomain || businessDomainAliases(skill.domain).includes(businessDomain);
}

function skillDomainMatches(skill, businessDomain) {
  return (
    skill.domain === businessDomain ||
    skill.category === businessDomain ||
    businessDomainAliases(skill.domain).includes(businessDomain) ||
    businessDomainAliases(skill.category).includes(businessDomain)
  );
}

function businessDomainAliases(domain) {
  const aliases = {
    人力资源: ["hr", "recruiting", "talent"],
    人事共享: ["hr", "employee-services"],
    项目交付: ["delivery", "project-delivery"],
    研发治理: ["rd", "engineering"],
    经营管理: ["finance", "business-operations"],
  };
  return aliases[domain] || [];
}

function departmentVisible(departmentId, visibility) {
  return visibility.allowedDepartmentIds.includes("*") || visibility.allowedDepartmentIds.includes(departmentId);
}

function systemVisible(systemId, visibility) {
  return visibility.allowedSystemIds.includes("*") || visibility.allowedSystemIds.includes(systemId);
}

function employeeMatchesQuery(employee, query) {
  return [employee.id, employee.name, employee.title, employee.owner, employee.objective]
    .join(" ")
    .toLowerCase()
    .includes(query);
}

function skillMatchesQuery(skill, query) {
  return [skill.id, skill.name, skill.category, skill.domain, skill.owner, skill.description]
    .join(" ")
    .toLowerCase()
    .includes(query);
}

function hasAnyPermission(permissions = [], permissionCandidates = []) {
  return permissionCandidates.some((permission) => hasPermission(permissions, permission));
}

function cleanText(value) {
  return String(value || "").replace(/\s+/g, " ").trim().slice(0, 800);
}
