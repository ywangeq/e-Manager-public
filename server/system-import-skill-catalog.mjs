export const algorithmClusterSkillIds = [];
export const portablePackageBoundary = {
  portableContents: ["manifest.json/目录索引", "agent.md 或 SKILL.md", "runtime-harness.json（可执行入口声明）", "rules.md", "tools.md", "skills.md/依赖声明", "prompt metadata 指纹", "install.md", "acceptance.md（可选冒烟标准）"],
  platformRecords: ["governance approvals", "eval runs", "badcases", "root cause notes", "distribution records", "runtime audit logs", "operation history"],
  boundarySummary: "下载包只携带能力声明和安装说明；治理、eval、badcase、审计和运维闭环由平台生成和保存，不作为默认包内容。",
};
export function normalizeSystemImportSkillId(input, _sourceRef, { cleanEntityId }) { return cleanEntityId(input); }
export function knownAlgorithmSkillMeta() { return {}; }
