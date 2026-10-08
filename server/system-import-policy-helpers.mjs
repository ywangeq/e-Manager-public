export function preReviewFindings(kind, draft) {
  if (kind === "system_employee_candidate") {
    return ["识别为系统级能力候选", "需要补齐 worker lane、触发策略、凭证租约和审计边界", "不得作为业务可申请能力直接上线"];
  }
  if (kind === "external_employee") {
    return ["识别为外部数字员工候选", "需要验证权限声明、工具边界、运行链路和停用策略", "不得保存外部密钥或执行记录"];
  }
  if (kind === "repo_skill_manifest") {
    return [`识别为 Repo Skill 草案：${draft.name}`, "需要确认输入输出、工具 claims、Skill ID 谱系和 owner", "不得执行仓库代码"];
  }
  if (kind === "skill_update") {
    return ["识别为 Skill 更新候选", "需要确认上一版本、兼容性、分发影响和回归候选"];
  }
  return ["识别为需求候选", "需要业务 owner 确认范围、风险、人审门禁和候选映射"];
}

export function reviewGateForPipeline(pipelineId) {
  return {
    "skill-manifest-import": "Skill owner 审核后入库",
    "external-skill-update-import": "技能/员工评审确认 Skill ID、升级谱系和分发范围",
    "external-digital-employee-import": "平台管理员确认权限和可用状态",
    "requirement-intake-import": "业务 owner 确认范围和风险",
  }[pipelineId] || "平台管理员确认安全摘要和治理边界";
}

export function permissionWarningsForEmployeeDraft(draft) {
  const warnings = [];
  if (!draft.permissionClaims.length) warnings.push("权限声明缺失，必须补齐后才能进入人工通过。");
  if (!draft.toolClaims.length) warnings.push("工具声明缺失，无法验证运行链路和停用边界。");
  if (draft.permissionClaims.some((claim) => /write|写入|删除|审批|发布/i.test(claim))) {
    warnings.push("权限声明包含写入/审批/发布能力，必须拆分动作并补齐回滚策略。");
  }
  return warnings;
}

export function defaultSkillReviewNote(decision, draft) {
  if (decision === "approved") {
    return `确认 ${draft.name || draft.skillId} 的 Skill ID、输入输出、权限工具、Prompt 元数据和挂载影响可进入 MVP 发布记录。`;
  }
  return `退回 ${draft.name || draft.skillId}，需补齐 Skill ID、输入输出、Prompt 元数据、回归候选或挂载影响。`;
}
