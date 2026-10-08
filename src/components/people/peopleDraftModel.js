import { governanceAssetsForRule } from "../../lib/consoleCatalog";

export const pendingPersonnelStatuses = new Set(["待确认", "待补全", "待同步"]);

export function personDraftGovernance(person) {
  return {
    scope: person.scope || person.governance?.scope || "ownDepartment",
    editableDepartmentIds: person.editableDepartmentIds || person.governance?.editableDepartmentIds || (person.departmentId ? [person.departmentId] : []),
    reviewDepartmentIds: person.reviewDepartmentIds || person.governance?.reviewDepartmentIds || (person.departmentId ? [person.departmentId] : []),
  };
}

export function hydrateAddedPerson(person) {
  const governance = personDraftGovernance(person);
  return {
    ...person,
    governance,
    assets: governanceAssetsForRule(governance),
  };
}

function personStatusNote(status) {
  const notes = {
    待确认: "目录已补全，待管理员确认",
    待补全: "等待企业目录补全",
    待同步: "等待目录同步",
  };
  return notes[status] || "";
}

export function compactDepartmentName(name = "") {
  const parts = String(name).split("/").map((item) => item.trim()).filter(Boolean);
  return parts.length > 1 ? parts[1] : parts[0] || name || "未绑定部门";
}

export function departmentDetailName(name = "") {
  const normalized = String(name).split("/").map((item) => item.trim()).filter(Boolean).join(" / ");
  const compact = compactDepartmentName(name);
  return normalized && normalized !== compact ? normalized : "";
}

export function draftStatusNote(status, draft) {
  if (draft?.action === "confirm") return "已写入 MVP 后端草稿，待正式 RBAC 审批接入";
  if (draft?.status === "停用") return "已提交移除，保存在 MVP 后端草稿";
  return personStatusNote(status);
}
