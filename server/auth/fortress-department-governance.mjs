export function createFortressDepartmentGovernanceHelpers({
  businessSkills,
  departments,
  digitalEmployees,
}) {
  function flattenFortressDepartments(root, path = []) {
    if (!root) return [];
    const currentPath = [...path, root.Name].filter(Boolean);
    const children = Array.isArray(root.Children) ? root.Children : [];
    return [
      {
        id: root.ID,
        parentId: root.ParentID === root.ID ? null : root.ParentID,
        name: root.Name,
        path: currentPath,
        memberCount: Array.isArray(root.Members) ? root.Members.length : 0,
        source: "fortress-v3",
      },
      ...children.flatMap((child) => flattenFortressDepartments(child, currentPath)),
    ];
  }

  function sanitizeFortressDepartmentTree(node, depth = 0) {
    if (!node) return null;
    const children = Array.isArray(node.Children) ? node.Children : [];
    const childTrees = children.map((child) => sanitizeFortressDepartmentTree(child, depth + 1));
    const assetSummary = depth > 0 ? summarizeGovernanceAssetsForDepartmentBranch(node) : null;
    return {
      id: node.ID,
      parentId: node.ParentID === node.ID ? null : node.ParentID,
      name: node.Name,
      depth,
      directChildCount: childTrees.length,
      memberCount: Array.isArray(node.Members) ? node.Members.length : 0,
      subtreeMemberCount: countFortressSubtreeMembers(node),
      departmentCount: countFortressSubtreeDepartments(node),
      governanceAssets: assetSummary,
      children: childTrees,
    };
  }

  function summarizeFortressDepartments(root, departmentItems) {
    const memberIds = new Set();
    collectFortressMemberIds(root, memberIds);

    return {
      departmentCount: departmentItems.length,
      memberCount: memberIds.size,
      maxDepth: departmentItems.reduce((max, department) => Math.max(max, department.path.length), 0),
      userKey: "FeishuUserID",
    };
  }

  function buildFortressDepartmentGovernanceRow(department, siblings, directory) {
    const members = uniqueFortressMembers([department]);
    const directMembers = uniqueFortressNodeMembers(department);
    const memberIds = members.map((member) => member.FeishuUserID).filter(Boolean);
    const directMemberIds = directMembers.map((member) => member.FeishuUserID).filter(Boolean);
    const memberDetails = memberIds.map((id) => directory.get(id)).filter(Boolean);
    const directMemberDetails = directMemberIds.map((id) => directory.get(id)).filter(Boolean);
    const directMemberIdSet = new Set(directMemberIds);
    const ownerCandidate = selectConservativeDepartmentOwner({
      memberDetails,
      directMemberDetails,
      directMemberIdSet,
      topDepartmentId: department.ID,
      directory,
    });
    const owner = ownerCandidate?.member || null;
    const assets = summarizeGovernanceAssetsForDepartmentBranch(department);
    const blockedDepartmentIds = siblings
      .filter((sibling) => sibling.ID && sibling.ID !== department.ID)
      .map((sibling) => sibling.ID);

    return {
      departmentId: department.ID,
      departmentName: department.Name,
      parentDepartmentId: department.ParentID === department.ID ? null : department.ParentID,
      ownerUserId: owner?.FeishuUserID || "",
      ownerName: owner?.FullName || "待确认负责人",
      ownerPosition: owner?.Position || "",
      ownerConfidence: owner ? "candidate" : "unresolved",
      ownerSource: "LeaderUserID",
      ownerEvidence: owner
        ? ownerEvidenceText(ownerCandidate)
        : "Fortress 部门树未提供负责人字段，且保守规则未能确认一级部门负责人候选",
      scope: "ownDepartment",
      editableDepartmentIds: [department.ID],
      reviewDepartmentIds: [department.ID],
      blockedDepartmentIds,
      blockedDepartmentNames: siblings
        .filter((sibling) => blockedDepartmentIds.includes(sibling.ID))
        .map((sibling) => sibling.Name),
      policy: "企业目录运行时同步；负责人只维护本部门数字员工、专项技能和评审范围，跨部门更新需要对应部门 owner 或平台管理员。",
      memberCount: memberIds.length,
      departmentCount: countFortressSubtreeDepartments(department),
      editableDigitalEmployees: assets.digitalEmployees,
      editableBusinessSkills: assets.businessSkills,
      digitalEmployeeCount: assets.digitalEmployeeCount,
      businessSkillCount: assets.businessSkillCount,
    };
  }

  function buildFortressTopDepartmentOwnerDirectory(root, directory) {
    const topDepartments = Array.isArray(root?.Children) ? root.Children : [];
    const departmentsByDirectoryId = new Map(
      buildFortressDepartmentDirectory(root).map((department) => [department.directoryId, department]),
    );
    return topDepartments
      .map((department) => {
        const governance = buildFortressDepartmentGovernanceRow(department, topDepartments, directory);
        const canonicalDepartment = departmentsByDirectoryId.get(cleanDirectoryId(department.ID));
        if (!canonicalDepartment || !governance.ownerUserId) return null;
        return {
          id: governance.ownerUserId,
          name: governance.ownerName,
          departmentId: canonicalDepartment.id,
          role: "Fortress 部门负责人候选",
          status: "启用",
          source: "fortress-v3-leader-aggregation",
          confidence: governance.ownerConfidence,
        };
      })
      .filter(Boolean);
  }

  function summarizeGovernanceAssetsForDepartmentBranch(node) {
    const branchDepartments = collectFortressDepartmentRefs(node);
    const employees = digitalEmployees
      .map((employee) => {
        const matchedDepartment = matchedFortressDepartmentForItem(employee, branchDepartments);
        if (!matchedDepartment) return null;
        return {
          id: employee.id,
          name: employee.name,
          status: employee.status,
          level: employee.level,
          ownerDepartmentId: employee.ownerDepartmentId,
          ownerUserId: employee.ownerUserId,
          permissionScope: employee.permissionScope,
          permissionSummary: employee.permissionSummary,
          departmentLabel: matchedDepartment.name || employee.department,
          departmentDepth: matchedDepartment.depth,
        };
      })
      .filter(Boolean);
    const skills = businessSkills
      .map((skill) => {
        const matchedDepartment = matchedFortressDepartmentForItem(skill, branchDepartments);
        if (!matchedDepartment) return null;
        return {
          id: skill.id,
          name: skill.name,
          status: skill.status,
          risk: skill.risk,
          departmentId: skill.departmentId,
          departmentLabel: matchedDepartment.name || skill.department,
        };
      })
      .filter(Boolean);
    const secondaryDepartments = summarizeSecondaryDepartmentBindings(employees);
    return {
      digitalEmployeeCount: employees.length,
      digitalEmployees: employees,
      secondaryDepartments,
      businessSkillCount: skills.length,
      businessSkills: skills,
    };
  }

  function matchedFortressDepartmentForItem(item, branchDepartments) {
    const departmentRefId = item.ownerDepartmentId || item.departmentId;
    const localDepartment = departments.find((entry) => entry.id === departmentRefId);
    if (!localDepartment) return null;
    const candidates = branchDepartments.filter(({ name }) => {
      return departmentNameMatches(localDepartment.name, name) || departmentNameMatches(item.department, name);
    });
    if (!candidates.length) return null;
    return candidates.sort((left, right) => right.depth - left.depth)[0];
  }

  function departmentPath(departmentId) {
    const departmentById = new Map(departments.map((department) => [department.id, department]));
    const path = [];
    let current = departmentById.get(departmentId);
    while (current) {
      path.unshift(current.name);
      current = current.parentId ? departmentById.get(current.parentId) : null;
    }
    return path;
  }

  return {
    buildFortressDepartmentGovernanceRow,
    buildFortressTopDepartmentOwnerDirectory,
    departmentPath,
    flattenFortressDepartments,
    fortressDirectoryUserKey,
    sanitizeFortressDepartmentTree,
    summarizeFortressDepartments,
    uniqueFortressMembers,
  };
}

export function buildFortressDepartmentDirectory(root) {
  return flattenFortressDepartmentDirectory(root);
}

function flattenFortressDepartmentDirectory(node, parent = null) {
  if (!node) return [];
  const directoryId = cleanDirectoryId(node.ID);
  const id = [parent?.id, directoryId].filter(Boolean).join("/");
  const path = [...(parent?.path || []), cleanDirectoryText(node.Name)].filter(Boolean);
  const current = {
    id,
    directoryId,
    parentId: parent?.id || "",
    name: cleanDirectoryText(node.Name),
    label: path.join(" / "),
    path,
    source: "fortress-v3",
  };
  return [
    current,
    ...(Array.isArray(node.Children)
      ? node.Children.flatMap((child) => flattenFortressDepartmentDirectory(child, current))
      : []),
  ];
}

function cleanDirectoryId(value) {
  return String(value || "").trim().replace(/^\/+|\/+$/g, "");
}

function cleanDirectoryText(value) {
  return String(value || "").replace(/\s+/g, " ").trim().slice(0, 240);
}

function collectFortressMemberIds(node, memberIds) {
  if (!node) return;
  for (const member of Array.isArray(node.Members) ? node.Members : []) {
    const id = member.FeishuUserID || member.FeishuUnionID || member.EmployeeNo || member.NickName;
    if (id) memberIds.add(id);
  }
  for (const child of Array.isArray(node.Children) ? node.Children : []) {
    collectFortressMemberIds(child, memberIds);
  }
}

function countFortressSubtreeMembers(node) {
  const memberIds = new Set();
  collectFortressMemberIds(node, memberIds);
  return memberIds.size;
}

function countFortressSubtreeDepartments(node) {
  if (!node) return 0;
  return 1 + (Array.isArray(node.Children) ? node.Children : []).reduce(
    (sum, child) => sum + countFortressSubtreeDepartments(child),
    0,
  );
}

function selectConservativeDepartmentOwner({
  memberDetails,
  directMemberDetails,
  directMemberIdSet,
  topDepartmentId,
  directory,
}) {
  const directLeaderCandidate = rankedLeaderCandidates(directMemberDetails, directory).find((candidate) =>
    candidateBelongsToTopNode(candidate.member, topDepartmentId, directMemberIdSet),
  );
  if (directLeaderCandidate) {
    return { ...directLeaderCandidate, evidenceSource: "direct-member-leader" };
  }

  const topNodeMemberCandidate = rankedLeaderCandidates(memberDetails, directory).find((candidate) =>
    directMemberIdSet.has(fortressDirectoryUserKey(candidate.member)),
  );
  if (topNodeMemberCandidate) {
    return { ...topNodeMemberCandidate, evidenceSource: "top-node-member-leader" };
  }

  return null;
}

function ownerEvidenceText(candidate) {
  if (!candidate) return "";
  if (candidate.evidenceSource === "direct-member-leader") {
    return `${candidate.directReportCount} 个一级部门直属成员的 LeaderUserID 指向该人员`;
  }
  return `${candidate.directReportCount} 个目录成员的 LeaderUserID 指向该一级部门直属成员`;
}

function candidateBelongsToTopNode(member, topDepartmentId, directMemberIdSet) {
  const memberKey = fortressDirectoryUserKey(member);
  if (memberKey && directMemberIdSet.has(memberKey)) return true;
  return (Array.isArray(member?.DepartmentRef) ? member.DepartmentRef : []).some((department) =>
    departmentRefMatchesTopNode(department.ID, topDepartmentId),
  );
}

function departmentRefMatchesTopNode(departmentRefId, topDepartmentId) {
  const id = String(departmentRefId || "");
  const topId = String(topDepartmentId || "");
  if (!id || !topId) return false;
  if (id === topId) return true;
  const parts = id.split("/").filter(Boolean);
  return parts[parts.length - 1] === topId;
}

function rankedLeaderCandidates(members, directory) {
  const counts = new Map();
  for (const member of members) {
    if (!member?.LeaderUserID) continue;
    counts.set(member.LeaderUserID, (counts.get(member.LeaderUserID) || 0) + 1);
  }
  return [...counts.entries()]
    .map(([leaderId, directReportCount]) => ({
      member: directory.get(leaderId) || { FeishuUserID: leaderId },
      directReportCount,
    }))
    .sort((left, right) => right.directReportCount - left.directReportCount);
}

function uniqueFortressMembers(nodes) {
  const seen = new Set();
  const members = [];
  for (const node of nodes) {
    collectFortressMembers(node, (member) => {
      const key = fortressDirectoryUserKey(member);
      if (!key || seen.has(key)) return;
      seen.add(key);
      members.push(member);
    });
  }
  return members;
}

function uniqueFortressNodeMembers(node) {
  const seen = new Set();
  const members = [];
  for (const member of Array.isArray(node?.Members) ? node.Members : []) {
    const key = fortressDirectoryUserKey(member);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    members.push(member);
  }
  return members;
}

function collectFortressMembers(node, visitor) {
  if (!node) return;
  for (const member of Array.isArray(node.Members) ? node.Members : []) {
    visitor(member);
  }
  for (const child of Array.isArray(node.Children) ? node.Children : []) {
    collectFortressMembers(child, visitor);
  }
}

function fortressDirectoryUserKey(member) {
  return member?.FeishuUserID || member?.FeishuUnionID || member?.EmployeeNo || member?.NickName || "";
}

function summarizeSecondaryDepartmentBindings(employees) {
  const departmentsByName = new Map();
  for (const employee of employees) {
    const label = employee.departmentLabel || "未标注下级";
    const current = departmentsByName.get(label) || { name: label, digitalEmployeeCount: 0 };
    current.digitalEmployeeCount += 1;
    departmentsByName.set(label, current);
  }
  return [...departmentsByName.values()].sort((left, right) => right.digitalEmployeeCount - left.digitalEmployeeCount);
}

function departmentNameMatches(localName, fortressName) {
  const local = String(localName || "").trim();
  const remote = String(fortressName || "").trim();
  if (!local || !remote) return false;
  return local === remote || local.includes(remote) || remote.includes(local);
}

function collectFortressDepartmentRefs(node, depth = 0) {
  if (!node) return [];
  return [
    { id: node.ID, name: node.Name, depth },
    ...(Array.isArray(node.Children) ? node.Children : []).flatMap((child) => collectFortressDepartmentRefs(child, depth + 1)),
  ].filter((department) => department.name);
}
