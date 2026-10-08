const DEFAULT_UPLOADER_DEPARTMENT = "当前登录人员部门";
export const ACCEPTED_PACKAGE_EXTENSIONS = [".zip", ".tar", ".gz", ".tgz"];
export const PACKAGE_INTAKE_MODE = "package_reference_only";
export const PACKAGE_INTAKE_NOTE = "小型包会交给后端读取安全摘要并丢弃临时文件；未收到包内容时只登记 sourceRef 并阻断补材料。";

export function ownerHintText(name, department) {
  return [name, department].map((item) => String(item || "").trim()).filter(Boolean).join(" · ");
}

export function resolveUploaderDepartment(session = null) {
  return session?.departmentPath || session?.department || session?.departmentId || DEFAULT_UPLOADER_DEPARTMENT;
}

export function buildOwnerHintOptions({ session = null, uploaderDepartment = DEFAULT_UPLOADER_DEPARTMENT, departments = [], personnel = [] } = {}) {
  const currentUploader = ownerHintText(session?.name || session?.email || "当前上传者", uploaderDepartment);
  const currentDepartment = departments.find((department) => department.id === session?.departmentId);
  const currentDepartmentOwner = currentDepartment ? ownerHintText(currentDepartment.leader, currentDepartment.name) : "";

  return {
    automatic: uniqueOwnerOptions([
      { label: `当前上传者：${currentUploader}`, value: currentUploader },
      currentDepartmentOwner ? { label: `当前部门负责人：${currentDepartmentOwner}`, value: currentDepartmentOwner } : null,
    ]),
    directory: uniqueOwnerOptions(
      personnel.map((person) => ({
        label: `${person.name} · ${person.department}`,
        value: ownerHintText(person.name, person.department),
      })),
    ),
  };
}

export function resolveDefaultOwnerHint(ownerHintOptions = {}, uploaderDepartment = DEFAULT_UPLOADER_DEPARTMENT) {
  return ownerHintOptions.automatic?.[0]?.value || uploaderDepartment;
}

export function departmentOptionLabel(department = {}) {
  if (department.id === "rd") return `${department.name}（软件组）`;
  return department.name || department.id || "";
}

export function resolveIntakeSourceRef({ sourceRef = "", packageFileName = "", isSkill = true } = {}) {
  const typedRef = String(sourceRef || "").trim();
  if (typedRef) return typedRef;
  if (!packageFileName) return "";
  return `${isSkill ? "openai-skill-package" : "external-agent-package"}://${packageFileName}`;
}

export function splitDraftLines(value) {
  const list = Array.isArray(value) ? value : String(value || "").split(/[\n,，;；、]+/);
  return list.map((item) => String(item || "").trim()).filter(Boolean);
}

export function buildExternalCapabilityIntakePayload({
  sourceRef,
  sourceType,
  isSkill,
  ownerHint,
  targetDepartmentId,
  safeSummary,
  packageFile,
  declareDigitalEmployee = false,
  employeeDeclaration = {},
} = {}) {
  const shouldDeclareEmployee = Boolean(isSkill && declareDigitalEmployee);
  const employeeName = String(employeeDeclaration.name || "").trim();
  const employeeTitle = String(employeeDeclaration.title || "").trim();
  const employeeObjective = String(employeeDeclaration.objective || "").trim();
  const employeeRules = splitDraftLines(employeeDeclaration.rules);
  const employeeTools = splitDraftLines(employeeDeclaration.tools);
  const employeeOutputContract = String(employeeDeclaration.outputContract || "").trim();
  const defaultToolClaims = [
    sourceType === "repo_link" ? "repo link" : isSkill ? "OpenAI Skill 安装包引用" : "外部数字员工包引用",
    isSkill ? "SKILL.md / manifest 安装解析" : "agent manifest / capability 安装解析",
    "external-agent-precheck 基本安装预审",
  ];

  return {
    sourceRef,
    sourceType,
    repoUrl: sourceType === "repo_link" ? sourceRef : undefined,
    targetDepartmentId: String(targetDepartmentId || "").trim() || undefined,
    intakeMode: shouldDeclareEmployee ? "employee_upload_harness" : isSkill ? "skill_upload_harness" : "employee_upload_harness",
    title: shouldDeclareEmployee ? employeeTitle || "业务数字员工初始化登记" : isSkill ? "外部业务 Skill 包登记" : "业务数字员工上传登记",
    level: "业务级",
    ownerHint,
    externalEmployeeName: shouldDeclareEmployee ? employeeName : undefined,
    externalEmployeeSummary: shouldDeclareEmployee ? employeeObjective || String(safeSummary || "").trim() : String(safeSummary || "").trim(),
    declareDigitalEmployee: shouldDeclareEmployee || undefined,
    employeeDeclaration: shouldDeclareEmployee
      ? {
          name: employeeName,
          title: employeeTitle,
          objective: employeeObjective,
          rules: employeeRules,
          tools: employeeTools,
          outputContract: employeeOutputContract,
          source: "skill_upload_employee_declaration",
        }
      : undefined,
    permissionClaims: shouldDeclareEmployee
      ? ["人员审批通过前不得试运行", "每个 SKILL.md 仍需技能评审通过后才能挂载", "权限声明需由业务 owner 和平台管理员确认"]
      : isSkill
      ? ["部门成员可下载使用", "人员/技能审批通过前不得直接安装或试运行"]
      : ["人员审批通过前不得试运行", "权限声明需由业务 owner 和平台管理员确认"],
    toolClaims: [...defaultToolClaims, ...employeeTools],
    packageIntake: sourceType === "repo_link"
      ? undefined
      : {
          mode: packageFile ? "inline_package_safe_summary" : PACKAGE_INTAKE_MODE,
          acceptedExtensions: ACCEPTED_PACKAGE_EXTENSIONS,
          note: PACKAGE_INTAKE_NOTE,
        },
    packageFile,
    riskHint: "待评估",
  };
}

export function buildSkillUpdateIntakePayload({
  skill = {},
  sourceRef,
  sourceType,
  targetVersion,
  declaredChanges,
  packageFile,
} = {}) {
  const skillId = String(skill.id || skill.skillApiId || "").trim();
  const sourceSkillId = String(skill.sourceSkillId || skill.skillApiId || skillId).trim();
  return {
    sourceRef: String(sourceRef || "").trim(),
    sourceType: String(sourceType || "").trim(),
    skillId,
    sourceSkillId,
    namespace: String(skill.namespace || "").trim(),
    previousVersion: String(skill.version || "").trim(),
    targetVersion: String(targetVersion || "").trim(),
    declaredChanges: splitDraftLines(declaredChanges),
    breakingChange: false,
    packageFile,
  };
}

function uniqueOwnerOptions(options) {
  const seen = new Set();
  return options.filter((option) => {
    if (!option?.value || seen.has(option.value)) return false;
    seen.add(option.value);
    return true;
  });
}
