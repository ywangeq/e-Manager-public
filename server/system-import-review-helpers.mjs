export const skillAutoReviewStatus = "待技能评审";
export const personnelApprovalStatus = "待人员审批";
export const personnelApprovedStatus = "人员审批通过";
export const employeeOnlineStatus = "在线";

export function draftRefsForJob(job) {
  const drafts = job?.drafts || {};
  return [
    ...(drafts.skillDrafts || []).map((draft) => ({ kind: "skillDrafts", draft })),
    ...(drafts.skillUpdateDrafts || []).map((draft) => ({ kind: "skillUpdateDrafts", draft })),
    ...(drafts.externalEmployeeDrafts || []).map((draft) => ({ kind: "externalEmployeeDrafts", draft })),
    ...(drafts.requirementDrafts || []).map((draft) => ({ kind: "requirementDrafts", draft })),
  ];
}

export function statusForReviewedJob(job) {
  const statuses = draftRefsForJob(job).map(({ draft }) => draft.status);
  const neutralStatuses = new Set(["mvp_review_approved", "system_state_recorded"]);
  if (statuses.includes(employeeOnlineStatus) && statuses.every((status) => status === employeeOnlineStatus || status === "mvp_skill_published" || neutralStatuses.has(status))) return employeeOnlineStatus;
  if (statuses.includes("试运行") && statuses.every((status) => status === "试运行" || status === "mvp_skill_published" || neutralStatuses.has(status))) return "试运行";
  if (statuses.includes(personnelApprovedStatus) && statuses.every((status) => status === personnelApprovedStatus || status === "mvp_skill_published" || neutralStatuses.has(status))) return personnelApprovedStatus;
  if (statuses.includes(personnelApprovalStatus) && statuses.includes(skillAutoReviewStatus)) return "待分项评审";
  if (statuses.includes(personnelApprovalStatus) && statuses.includes("mvp_skill_published")) return personnelApprovalStatus;
  if (statuses.length && statuses.every((status) => status === personnelApprovalStatus)) return personnelApprovalStatus;
  if (statuses.length && statuses.every((status) => status === personnelApprovalStatus || neutralStatuses.has(status))) return personnelApprovalStatus;
  if (statuses.length && statuses.every((status) => status === skillAutoReviewStatus)) return skillAutoReviewStatus;
  if (statuses.includes(skillAutoReviewStatus) && statuses.every((status) => status === skillAutoReviewStatus || neutralStatuses.has(status))) return skillAutoReviewStatus;
  if (statuses.length && statuses.every((status) => status === "mvp_skill_published")) return "mvp_skill_published";
  if (statuses.includes("mvp_skill_published") && statuses.every((status) => status === "mvp_skill_published" || neutralStatuses.has(status))) return "mvp_skill_published";
  if (statuses.length && statuses.every((status) => neutralStatuses.has(status))) return "mvp_review_approved";
  if (statuses.some((status) => status === "mvp_review_rejected")) return "mvp_review_rejected";
  return "pending_review";
}

export function statusForReviewDecision(decision, draftKind, draft = {}) {
  if (decision === "rejected") return "mvp_review_rejected";
  if (draftKind === "externalEmployeeDrafts" && isSkillPackageSourceRegistrationDraft(draft)) return "mvp_review_approved";
  if (draftKind === "externalEmployeeDrafts") return personnelApprovalStatus;
  if (draftKind === "skillDrafts") return skillAutoReviewStatus;
  if (draftKind === "skillUpdateDrafts") return skillAutoReviewStatus;
  if (draftKind === "requirementDrafts") return "待 owner 评审";
  return "mvp_review_approved";
}

export function normalizeReviewDecision(value, cleanText) {
  const text = cleanText(value).toLowerCase();
  if (["approve", "approved", "pass", "passed", "通过"].includes(text)) return "approved";
  if (["reject", "rejected", "return", "returned", "驳回", "退回"].includes(text)) return "rejected";
  return "";
}

export function normalizeEvaluationDatasetDecision(value, cleanText) {
  const text = cleanText(value).toLowerCase();
  if (["approve", "approved", "pass", "passed", "archive", "archived", "通过", "入库", "确认入库"].includes(text)) return "approved";
  if (["reject", "rejected", "return", "returned", "defer", "deferred", "驳回", "退回", "暂缓", "取消入库"].includes(text)) return "rejected";
  return "";
}

export function defaultReviewNote(decision, reviewKind = "") {
  if (decision === "approved" && reviewKind === "skillPackageSourceRegistration") return "登记员确认外部 Skill 包来源可进入后续 Skill 草案评审。";
  if (decision === "approved" && reviewKind === "externalEmployeeDrafts") return "登记员确认外部数字员工安全摘要可进入人员审批。";
  if (decision === "approved" && reviewKind === "skillDrafts") return "登记员确认外部 Skill 安全摘要可进入技能/员工评审。";
  if (decision === "approved" && reviewKind === "mixedExternalInstall") return "登记员确认外部 link 拆解结果可分别进入人员审批和技能/员工评审。";
  return decision === "approved" ? "管理员确认 MVP 安全摘要可进入下一门禁。" : "管理员退回，需补充治理边界后再评审。";
}

export function nextGateForReviewDecision(decision, reviewKind) {
  if (decision !== "approved") return "退回补齐权限声明、工具边界、运行链路、凭证租约或审计边界后重新提交。";
  if (reviewKind === "skillPackageSourceRegistration") return "来源登记已通过；请继续审核同一 job 下拆解出的业务 Skill 草案。";
  if (reviewKind === "externalEmployeeDrafts") return "外部数字员工登记审核通过；下一步进入人员审批，确认归属人、部门、权限范围和上线资格。";
  if (reviewKind === "skillDrafts") return "外部 link 拆解出的 Skill 草案进入技能/员工评审，确认 Skill ID、输入输出、版本意图、Prompt 元数据、回归候选和挂载员工影响。";
  if (reviewKind === "mixedExternalInstall") return "外部 link 拆解审核通过；员工草案进入人员审批，Skill 草案进入技能/员工评审。";
  return "仅表示 MVP 人工评审通过；生产仍需持久化、RBAC、审计、受控发布和运行验证。";
}

export function workflowEffectForReviewDecision(decision, reviewKind) {
  if (decision !== "approved") return "none";
  if (reviewKind === "skillPackageSourceRegistration") return "source_registration_approved";
  if (reviewKind === "externalEmployeeDrafts") return "personnel_approval_required";
  if (reviewKind === "skillDrafts" || reviewKind === "skillUpdateDrafts") return "skill_employee_review_required";
  if (reviewKind === "requirementDrafts") return "owner_review_required";
  if (reviewKind === "mixedExternalInstall") return "personnel_and_skill_review_required";
  return "none";
}

export function reviewKindForDraftRef({ kind, draft }) {
  if (kind === "externalEmployeeDrafts" && isSkillPackageSourceRegistrationDraft(draft)) return "skillPackageSourceRegistration";
  return kind;
}

export function isSkillPackageSourceRegistrationDraft(draft = {}) {
  return draft.intakeKind === "skill_package_source_registration";
}

export function defaultEvaluationDatasetNote(decision) {
  if (decision === "approved") return "确认该安全摘要样本可作为测评集回归样本。";
  return "暂缓入库，等待补齐测评标准或修复证据。";
}
