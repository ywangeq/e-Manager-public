import {
  badcaseRecords,
  businessSkills,
  departmentGovernance,
  departments,
  digitalEmployees,
  externalAuditRequests,
  personnel,
} from "../data/catalog.js";

export function statusClass(status) {
  if (["在线", "已上线", "启用", "可复用", "可通过", "已生效", "completed", "healthy", "system_state_recorded", "mvp_review_approved", "mvp_skill_published"].includes(status)) return "good";
  if (["离线", "未连接", "模型异常", "运行异常", "不可用"].includes(status)) return "bad";
  if (["试运行", "受限", "待检测", "待真实测试", "设计中", "待管理员评审", "待工具审批", "待人员审批", "人员审批通过", "待技能评审", "待分项评审", "检查未通过", "待确认", "待补全", "待同步", "待质量复盘", "待平台质量复盘", "待子系统提交脱敏证据", "待平台确认根因", "待整改", "待回归验证", "待关闭", "待评审确认", "queued", "running", "planned", "pending_review", "pending_admin_review", "personnel_approval_passed", "system_worker_review_required", "mvp_review_rejected", "failed", "blocked", "completed_with_findings"].includes(status)) return "warn";
  return "muted";
}

export function displaySkillStatus(status) {
  if (status === "approved_deployment_failed") return "审核通过 · 部署失败（未生效）";
  if (status === "mvp_skill_published") return "MVP 已发布";
  return status || "状态未同步";
}

export function skillNameById(id, source) {
  return source.find((item) => item.id === id)?.name || id;
}

export function severityClass(severity) {
  if (severity === "P0" || severity === "P1") return "warn";
  if (severity === "P2") return "muted";
  return "good";
}

export function badcasesForEntity(entityId) {
  return badcaseRecords.filter((item) => item.entityId === entityId);
}

const qualityErrorCodeLabels = {
  ROLE_MATCH_APPLIED_RECOMMENDED_CONFLICT: "申请岗位与推荐岗位冲突",
  ROLE_MATCH_LOW_EVIDENCE: "岗位匹配证据不足",
  SUBSYSTEM_QUALITY_EVENT: "子系统质量事件",
  HR_BADCASE_ARCHIVE_REQUEST: "HR badcase 归档申请",
  BADCASE_ARCHIVE_REQUEST: "badcase 归档申请",
  PRE_AGENT_EXECUTION_FAILED: "Agent 预审核执行失败",
  PRE_SKILL_CONTRACT_INCOMPLETE: "Skill 合同字段阻断",
  PRE_SKILL_REVIEW_GAPS: "Skill 预审核缺口",
};

const qualityEnumLabels = {
  errorDomain: {
    role_match: "岗位匹配",
    quality: "质量治理",
    resume_parse: "简历解析",
    invocation_policy: "调用门禁",
    distribution_mapping: "分发映射",
    agent_runtime: "Agent 运行",
    skill_contract: "Skill 合同",
  },
  rootCauseCategory: {
    jd_taxonomy_gap: "JD/岗位分类缺口",
    prompt_gap: "Prompt 规则缺口",
    pending_analysis: "待平台复盘",
    pending_archive_dedupe: "待归档去重",
    worker_execution_error: "Worker 执行异常",
    missing_contract_metadata: "合同元数据缺失",
  },
  resolutionAction: {
    jd_taxonomy_update: "更新 JD/岗位分类规则",
    prompt_update: "更新 Prompt",
    pending_review: "待平台复盘",
    platform_quality_archive: "平台归档并去重",
    dedupe_and_manual_quality_review: "去重并进入人工质量复盘",
    rerun_agent_pre_review: "重跑 Agent 预审核",
    complete_skill_contract: "补齐 Skill 合同",
    manual_quality_review: "人工质量复核",
  },
};

export function qualityIssueName(errorCode) {
  if (!errorCode) return "";
  return qualityErrorCodeLabels[errorCode] || errorCode;
}

export function qualityCodeText(errorCode) {
  const label = qualityIssueName(errorCode);
  return label && errorCode && label !== errorCode ? `${label} / ${errorCode}` : label;
}

export function qualityEnumLabel(kind, value) {
  if (!value) return "";
  return qualityEnumLabels[kind]?.[value] || value;
}

export function qualityEnumText(kind, value) {
  const label = qualityEnumLabel(kind, value);
  return label && value && label !== value ? `${label} / ${value}` : label;
}

export function qualityEventTitle(event = {}) {
  const issueName = qualityIssueName(event.errorCode);
  if (issueName && issueName !== event.errorCode) return issueName;
  return event.entityName || event.entityId || issueName || "质量事件";
}

export function isOpenStatus(status) {
  return !["已关闭", "closed"].includes(status);
}

export function employeesByLevel(level) {
  return digitalEmployees.filter((employee) => employee.level === level);
}

export function departmentPath(departmentId) {
  const departmentById = new Map(departments.map((department) => [department.id, department]));
  const path = [];
  let current = departmentById.get(departmentId);
  while (current) {
    path.unshift(current.name);
    current = current.parentId ? departmentById.get(current.parentId) : null;
  }
  return path;
}

export function departmentSummaries() {
  return departments
    .filter((department) => department.id !== "company")
    .map((department) => {
      const people = personnel.filter((user) => user.departmentId === department.id);
      const employees = digitalEmployees.filter((employee) => employee.departmentId === department.id);
      const skills = businessSkills.filter((skill) => skill.departmentId === department.id);
      return {
        ...department,
        headcount: people.length,
        digitalEmployees: employees.length,
        businessSkills: skills.length,
        path: departmentPath(department.id).join(" / "),
      };
    });
}

export function departmentNameById(departmentId) {
  return departments.find((department) => department.id === departmentId)?.name || departmentId || "未绑定部门";
}

export function mountedEmployeesForSkill(skillId, field) {
  return digitalEmployees.filter((employee) => (employee[field] || []).includes(skillId));
}

export function mountedEmployeeSummary(employees) {
  if (!employees.length) return "未挂载数字员工";
  const names = employees.slice(0, 2).map((employee) => employee.name).join("、");
  return employees.length > 2 ? `${names} +${employees.length - 2}` : names;
}

export function nextDraftVersion(version) {
  const match = String(version || "").match(/^(.*-)(\d+)$/);
  if (!match) return `${version || "skill"}-draft`;
  return `${match[1]}${String(Number(match[2]) + 1).padStart(match[2].length, "0")}-draft`;
}

function isDraftVersion(version) {
  const normalized = String(version || "").trim().toLowerCase();
  return !normalized || normalized === "draft";
}

function mvpVersionFromDate(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, "0");
  const day = String(date.getUTCDate()).padStart(2, "0");
  return `mvp-${year}.${month}.${day}-01`;
}

export function displaySkillVersion(skill = {}) {
  const version = String(skill.version || "").trim();
  if (!isDraftVersion(version)) return version;
  const publicationVersion = String(skill.mvpPublication?.version || "").trim();
  if (!isDraftVersion(publicationVersion)) return publicationVersion;
  return mvpVersionFromDate(skill.mvpPublication?.publishedAt || skill.updatedAt) || version || "draft";
}

export function scopeIncludes(scope = [], departmentId) {
  return scope.includes("*") || scope.includes(departmentId);
}

export function flattenOrgDepartments(node, path = []) {
  if (!node) return [];
  const currentPath = [...path, node.name].filter(Boolean);
  const children = node.children || [];
  return [
    {
      id: node.id,
      name: node.name,
      path: currentPath,
      depth: node.depth || 0,
    },
    ...children.flatMap((child) => flattenOrgDepartments(child, currentPath)),
  ];
}

export function governanceForUser(user) {
  return departmentGovernance.find((rule) => rule.ownerUserId === user.id || (rule.adminUserIds || []).includes(user.id));
}

export function governanceAssetsForRule(rule, catalogs = {}) {
  const employeeCatalog = catalogs.digitalEmployees || digitalEmployees;
  const businessSkillCatalog = catalogs.businessSkills || businessSkills;
  const auditRequests = catalogs.externalAuditRequests || externalAuditRequests;
  if (!rule) {
    return {
      editableEmployees: [],
      editableBusinessSkills: [],
      reviewRequests: [],
      blockedDepartments: [],
    };
  }
  const editableScope = rule.editableDepartmentIds || [];
  const reviewScope = rule.reviewDepartmentIds || [];
  const blockedDepartments = (rule.blockedDepartmentIds || []).map((departmentId) => departmentNameById(departmentId));
  return {
    editableEmployees: employeeCatalog.filter((employee) => scopeIncludes(editableScope, employee.ownerDepartmentId || employee.departmentId)),
    editableBusinessSkills: businessSkillCatalog.filter((skill) => scopeIncludes(editableScope, skill.departmentId)),
    reviewRequests: auditRequests.filter((request) => scopeIncludes(reviewScope, request.reviewDepartmentId || "digital-office")),
    blockedDepartments,
  };
}

export function mountedSubsystemsByDepartmentId(subsystems = [], orgDepartments = []) {
  const grouped = new Map();
  for (const subsystem of subsystems) {
    const departmentId = subsystem?.assignmentDraft?.departmentId || subsystem?.departmentId;
    const subsystemId = subsystem?.id;
    if (!departmentId || !subsystemId) continue;
    const mountedSubsystem = {
      id: subsystemId,
      name: subsystem.name || subsystemId,
      status: subsystem.assignmentDraft?.status || subsystem.status || "",
      businessDomain: subsystem.assignmentDraft?.businessDomain || subsystem.businessDomain || "",
      link: subsystem.baseUrl || "",
    };
    addMountedSubsystem(grouped, departmentId, mountedSubsystem);

    const localDepartment = departments.find((department) => department.id === departmentId);
    if (!localDepartment || !orgDepartments.length) continue;
    const matchedBranches = orgDepartments.filter((department) => departmentNodeMatchesLocalDepartment(department, localDepartment));
    for (const department of orgDepartments) {
      if (matchedBranches.some((branch) => departmentPathIncludes(branch.path, department.path))) {
        addMountedSubsystem(grouped, department.id, mountedSubsystem);
      }
    }
  }
  return grouped;
}

function addMountedSubsystem(grouped, departmentId, subsystem) {
  if (!departmentId || !subsystem?.id) return;
  const bucket = grouped.get(departmentId) || [];
  if (!bucket.some((item) => item.id === subsystem.id)) bucket.push(subsystem);
  grouped.set(departmentId, bucket);
}

function departmentNodeMatchesLocalDepartment(department, localDepartment) {
  return department?.id === localDepartment.id || departmentNameMatches(localDepartment.name, department?.name);
}

function departmentPathIncludes(branchPath = [], parentPath = []) {
  if (!Array.isArray(branchPath) || !Array.isArray(parentPath) || !parentPath.length) return false;
  if (parentPath.length > branchPath.length) return false;
  return parentPath.every((part, index) => part === branchPath[index]);
}

function departmentNameMatches(localName, orgName) {
  const local = String(localName || "").trim();
  const remote = String(orgName || "").trim();
  if (!local || !remote) return false;
  return local === remote || local.includes(remote) || remote.includes(local);
}
