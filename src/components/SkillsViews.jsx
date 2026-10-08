import {
  BadgeCheck,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  ClipboardList,
  Code2,
  Download,
  GitMerge,
  MoveRight,
  PencilLine,
  Settings2,
  Trash2,
} from "lucide-react";
import { useState } from "react";
import { basicSkills, businessSkills } from "../data/catalog";
import {
  badcasesForEntity,
  departmentNameById,
  displaySkillStatus,
  displaySkillVersion,
  mountedEmployeesForSkill,
  mountedEmployeeSummary,
  skillNameById,
  statusClass,
} from "../lib/consoleCatalog";
import { buildSkillPackageBundle } from "../lib/skillPackaging";
import { businessSkillPackageDownloadPath } from "../lib/digitalEmployeePackage";
import ApiAccessPanel from "./ApiAccessPanel";
import { DetailGrid, ExpandableList, ExpandableRow, GovernanceBlock, SkillChips } from "./ConsolePrimitives";
import ExternalCapabilityIntake from "./ExternalCapabilityIntake";
import { SkillCapabilityDetails, SkillEditDraftPanel, SkillPromptGovernancePanel } from "./skills/SkillGovernancePanels";
import SkillMountRequestPanel from "./skills/SkillMountRequestPanel";
import { businessSkillNames, listItems, sameItems } from "./skills/skillPanelModel";

const intakeSteps = [
  {
    title: "外部接入数字员工初分组",
    detail: "安装解析只生成业务组建议、安全摘要和权限声明，不直接发布技能。",
  },
  {
    title: "人员审批确认",
    detail: "负责人确认归属部门、owner、风险等级、可调用边界和试运行资格。",
  },
  {
    title: "质量门禁入目录",
    detail: "通过后进入专项业务技能目录；二级技能待治理模型确定后再接入。",
  },
];

function businessGroupMetaForSkill(skill) {
  const recommendation = skill.businessGroupRecommendation || {};
  return {
    id: recommendation.groupId || skill.businessGroupId || "",
    label: recommendation.label || skill.businessGroup || skill.domain || (skill.department ? `${skill.department}业务组` : "") || "待确认业务组",
    teamId: recommendation.teamId || "",
    teamLabel: recommendation.teamLabel || "",
    domainId: recommendation.domainId || "",
    domainLabel: recommendation.domainLabel || skill.domain || "",
    description: recommendation.rationale || "通过治理流程进入目录的专项业务 Skill。",
    order: 50,
  };
}

function businessGroupLabelForSkill(skill) {
  return businessGroupMetaForSkill(skill).label;
}

function businessGroupIdForSkill(skill, label) {
  return businessGroupMetaForSkill(skill).id || skill.businessGroupRecommendation?.groupId || skill.businessGroupId || label;
}

function normalizeBusinessGroupLabel(label) {
  return String(label || "").trim().toLowerCase();
}

function timestampLabel() {
  return new Date().toLocaleString("zh-CN", { hour12: false });
}

function groupBusinessSkills(skills) {
  const dynamicGroups = new Map();
  skills.forEach((skill) => {
    const meta = businessGroupMetaForSkill(skill);
    const label = meta.label;
    const key = meta.id || businessGroupIdForSkill(skill, label);
    const current = dynamicGroups.get(key) || {
      id: String(key).toLowerCase().replace(/[^a-z0-9\u4e00-\u9fa5]+/g, "-"),
      label,
      description: meta.description,
      order: meta.order || 50,
      skills: [],
    };
    current.skills.push(skill);
    dynamicGroups.set(key, current);
  });
  return [...dynamicGroups.values()].sort((left, right) => left.order - right.order || left.label.localeCompare(right.label));
}

function businessSkillHierarchy(skills) {
  const buckets = new Map();
  skills.forEach((skill) => {
    const meta = businessGroupMetaForSkill(skill);
    const teamLabel = meta.teamLabel || "未分能力线";
    const domainLabel = meta.domainLabel || skill.domain || "未分技能簇";
    const key = `${teamLabel}::${domainLabel}`;
    const current = buckets.get(key) || {
      key,
      teamLabel,
      domainLabel,
      skills: [],
    };
    current.skills.push(skill);
    buckets.set(key, current);
  });
  return [...buckets.values()].sort((left, right) =>
    left.teamLabel.localeCompare(right.teamLabel) ||
    left.domainLabel.localeCompare(right.domainLabel)
  );
}
function capabilityLineOverrideKey(groupId, bucketKey) {
  return `${groupId}::${bucketKey}`;
}

function applyBusinessSkillGroupDrafts(skills, skillGroupDrafts, groupNameDrafts) {
  const baseGroups = groupBusinessSkills(skills);
  const groupDefinitions = new Map(
    baseGroups.map((group) => [
      group.id,
      {
        ...group,
        label: groupNameDrafts[group.id] || group.label,
        skills: [],
      },
    ]),
  );
  const skillBaseGroupIds = new Map();

  baseGroups.forEach((group) => {
    group.skills.forEach((skill) => {
      skillBaseGroupIds.set(skill.id, group.id);
    });
  });

  skills.forEach((skill) => {
    const baseGroupId = skillBaseGroupIds.get(skill.id);
    const targetGroupId = skillGroupDrafts[skill.id] || baseGroupId;
    const baseGroup = groupDefinitions.get(targetGroupId) || groupDefinitions.get(baseGroupId);
    const targetGroup = groupDefinitions.get(targetGroupId) || {
      ...(baseGroup || {}),
      id: targetGroupId,
      label: groupNameDrafts[targetGroupId] || baseGroup?.label || "待确认业务域",
      description: baseGroup?.description || "管理员快速归类创建的业务域。",
      order: baseGroup?.order || 80,
      skills: [],
    };

    if (!groupDefinitions.has(targetGroupId)) {
      groupDefinitions.set(targetGroupId, targetGroup);
    }
    targetGroup.skills.push(skill);
  });

  return [...groupDefinitions.values()]
    .filter((group) => group.skills.length)
    .sort((left, right) => left.order - right.order || left.label.localeCompare(right.label));
}

function findGroupForSkill(groups, skillId) {
  return groups.find((group) => group.skills.some((skill) => skill.id === skillId));
}

function duplicateBusinessGroupLabels(groups) {
  const labels = new Map();
  groups.forEach((group) => {
    const normalized = normalizeBusinessGroupLabel(group.label);
    if (!normalized) return;
    labels.set(normalized, [...(labels.get(normalized) || []), group]);
  });
  return [...labels.values()].filter((items) => items.length > 1);
}

function withDisplayNames(skills, displayNameDrafts) {
  return skills.map((skill) => {
    const displayName = displayNameDrafts[skill.id];
    return displayName ? { ...skill, name: displayName, originalName: skill.originalName || skill.name } : skill;
  });
}

export function BasicSkills({ skills, isSystemAdmin = false }) {
  const [displayNameDrafts, setDisplayNameDrafts] = useState({});
  const displayedSkills = withDisplayNames(skills, displayNameDrafts);

  function saveDisplayNameDraft(skillId, displayName) {
    setDisplayNameDrafts((current) => ({ ...current, [skillId]: displayName }));
  }

  return (
    <section className="view-stack">
      <ExpandableList>
        {({ openRowId, setOpenRowId }) => displayedSkills.map((skill) => (
          <BasicSkillRow
            key={skill.id}
            skill={skill}
            openRowId={openRowId}
            setOpenRowId={setOpenRowId}
            isSystemAdmin={isSystemAdmin}
            onSaveDisplayName={saveDisplayNameDraft}
          />
        ))}
      </ExpandableList>
    </section>
  );
}

function BasicSkillRow({ skill, openRowId, setOpenRowId, isSystemAdmin, onSaveDisplayName }) {
  const [showApiAccess, setShowApiAccess] = useState(false);
  const [showEditPanel, setShowEditPanel] = useState(false);
  const mountedEmployees = mountedEmployeesForSkill(skill.id, "basicSkillIds");
  const ownerDepartment = departmentNameById(skill.ownerDepartmentId);
  const apiAccessVisible = openRowId === skill.id && showApiAccess;
  const editPanelVisible = openRowId === skill.id && showEditPanel;

  function toggleApiAccess() {
    setOpenRowId(skill.id);
    setShowApiAccess((current) => (openRowId === skill.id ? !current : true));
  }

  function toggleEditPanel() {
    setOpenRowId(skill.id);
    setShowEditPanel((current) => (openRowId === skill.id ? !current : true));
  }

  return (
    <ExpandableRow
      rowId={skill.id}
      listId="basic-skills"
      openRowId={openRowId}
      setOpenRowId={setOpenRowId}
      icon={<BadgeCheck size={18} />}
      title={skill.name}
      description={skill.description}
      status={<span className={`status-pill ${statusClass(skill.status)}`}>{displaySkillStatus(skill.status)}</span>}
      summary={[
        ownerDepartment,
        mountedEmployeeSummary(mountedEmployees),
        `${mountedEmployees.length} 个数字员工`,
        displaySkillVersion(skill),
        `${badcasesForEntity(skill.id).length} badcase`,
      ]}
      actions={(
        <>
          {isSystemAdmin ? (
            <button className="ghost-action entity-row-action entity-row-edit-action" type="button" onClick={toggleEditPanel}>
              <PencilLine size={15} />
              编辑
            </button>
          ) : null}
          <button className="ghost-action entity-row-action" type="button" onClick={toggleApiAccess}>
            <Code2 size={15} />
            API 接入
          </button>
        </>
      )}
    >
      <DetailGrid
        items={[
          ["分类", skill.category],
          ["归属部门", ownerDepartment],
          ["归属部门主键", skill.ownerDepartmentId],
          ["负责人", skill.owner],
          ["编辑门禁", skill.reviewGate],
          ["实体版本", displaySkillVersion(skill)],
          ["Prompt 版本", skill.promptVersion],
          ["根因焦点", skill.rootCauseFocus],
          ["Badcase 计数", `${badcasesForEntity(skill.id).length} 条`],
        ]}
      />
      <SkillEditDraftPanel
        skill={skill}
        kind="basic"
        ownerDepartment={ownerDepartment}
        mountedEmployees={mountedEmployees}
        isSystemAdmin={isSystemAdmin}
        onSaveDisplayName={onSaveDisplayName}
        isEditing={editPanelVisible}
        onEditingChange={setShowEditPanel}
      />
      {apiAccessVisible ? <ApiAccessPanel entity={skill} kind="basicSkill" runtimeEmployeeId={mountedEmployees[0]?.id || ""} /> : null}
      <GovernanceBlock constraints={skill.constraints} promptKeys={skill.promptKeys} badcases={badcasesForEntity(skill.id)} />
      <SkillCapabilityDetails skill={skill} />
      <SkillPromptGovernancePanel skill={skill} isSystemAdmin={isSystemAdmin} />
      <SkillChips title="挂载数字员工" items={mountedEmployees.length ? mountedEmployees.map((employee) => employee.name) : ["暂无挂载"]} />
      <SkillChips title="工具" items={skill.tools} />
    </ExpandableRow>
  );
}

export function BusinessSkills({ skills, isSystemAdmin = false, session = null }) {
  const [displayNameDrafts, setDisplayNameDrafts] = useState({});
  const [groupNameDrafts, setGroupNameDrafts] = useState({});
  const [capabilityLineNames, setCapabilityLineNames] = useState({});
  const [skillGroupDrafts, setSkillGroupDrafts] = useState({});
  const [domainActionDrafts, setDomainActionDrafts] = useState([]);
  const [draggingSkillId, setDraggingSkillId] = useState("");
  const [dropTargetGroupId, setDropTargetGroupId] = useState("");
  const displayedSkills = withDisplayNames(skills, displayNameDrafts);
  const groups = applyBusinessSkillGroupDrafts(displayedSkills, skillGroupDrafts, groupNameDrafts);
  const duplicateGroups = duplicateBusinessGroupLabels(groups);

  function saveDisplayNameDraft(skillId, displayName) {
    setDisplayNameDrafts((current) => ({ ...current, [skillId]: displayName }));
  }

  function saveGroupDisplayNameDraft(groupId, displayName) {
    setGroupNameDrafts((current) => ({ ...current, [groupId]: displayName }));
    appendDomainActionDraft({
      type: "rename_group",
      title: "业务域名称调整",
      summary: `业务域显示名调整为 ${displayName}`,
    });
  }

  function saveCapabilityLineName(groupId, bucket, displayName) {
    const key = capabilityLineOverrideKey(groupId, bucket.key);
    const previousName = capabilityLineNames[key] || bucket.teamLabel;
    setCapabilityLineNames((current) => ({ ...current, [key]: displayName }));
    appendDomainActionDraft({
      type: "rename_capability_line",
      title: "能力线名称调整",
      summary: `${previousName} -> ${displayName}`,
      reason: `业务域：${findGroupForSkill(groups, bucket.skills[0]?.id)?.label || groupId}；技能簇：${bucket.domainLabel}`,
    });
  }

  function appendDomainActionDraft(action) {
    setDomainActionDrafts((current) => [
      {
        id: `${action.type}-${Date.now()}`,
        submittedAt: timestampLabel(),
        ...action,
      },
      ...current,
    ].slice(0, 6));
  }

  function moveSkillToGroup(skillId, targetGroupId, reason = "管理员调整业务域归属") {
    const skill = displayedSkills.find((item) => item.id === skillId);
    const sourceGroup = findGroupForSkill(groups, skillId);
    const targetGroup = groups.find((group) => group.id === targetGroupId);
    if (!skill || !targetGroup || sourceGroup?.id === targetGroup.id) {
      setDraggingSkillId("");
      setDropTargetGroupId("");
      return;
    }

    setSkillGroupDrafts((current) => ({ ...current, [skillId]: targetGroup.id }));
    appendDomainActionDraft({
      type: "move_skill",
      title: "Skill 归类调整",
      summary: `${skill.name}：${sourceGroup?.label || "原业务域"} -> ${targetGroup.label}`,
      reason,
    });
    setDraggingSkillId("");
    setDropTargetGroupId("");
  }

  function mergeGroupIntoGroup(sourceGroup, targetGroup, reason = "检测到同名业务域") {
    if (!sourceGroup || !targetGroup || sourceGroup.id === targetGroup.id) return;
    setSkillGroupDrafts((current) => {
      const next = { ...current };
      sourceGroup.skills.forEach((skill) => {
        next[skill.id] = targetGroup.id;
      });
      return next;
    });
    setGroupNameDrafts((current) => {
      const next = { ...current };
      delete next[sourceGroup.id];
      return next;
    });
    appendDomainActionDraft({
      type: "merge_group",
      title: "同名业务域合并",
      summary: `${sourceGroup.label} -> ${targetGroup.label}，影响 ${sourceGroup.skills.length} 个 Skill`,
      reason,
    });
  }

  function archiveGroupIntoGroup(sourceGroup, targetGroup, reason = "删除业务域前归并 Skill") {
    if (!sourceGroup || !targetGroup || sourceGroup.id === targetGroup.id) return;
    setSkillGroupDrafts((current) => {
      const next = { ...current };
      sourceGroup.skills.forEach((skill) => {
        next[skill.id] = targetGroup.id;
      });
      return next;
    });
    appendDomainActionDraft({
      type: "archive_group",
      title: "业务域归并记录",
      summary: `${sourceGroup.label} 归并到 ${targetGroup.label}，不删除 Skill`,
      reason,
    });
  }

  function startSkillDrag(skillId) {
    setDraggingSkillId(skillId);
  }

  function endSkillDrag() {
    setDraggingSkillId("");
    setDropTargetGroupId("");
  }

  return (
    <section className="view-stack">
      <section className="skill-intake-panel">
        <div className="skill-intake-head">
          <div>
            <span className="eyebrow">Install Governance</span>
            <strong>安装时先归类，再由人员审批确认</strong>
          </div>
          <span className="status-pill warn">二级技能暂未启用</span>
        </div>
        <div className="skill-intake-steps">
          {intakeSteps.map((step, index) => (
            <div className="skill-intake-step" key={step.title}>
              <span>{String(index + 1).padStart(2, "0")}</span>
              <strong>{step.title}</strong>
              <small>{step.detail}</small>
            </div>
          ))}
        </div>
      </section>

      <ExternalCapabilityIntake kind="skill" isSystemAdmin={isSystemAdmin} session={session} />

      {isSystemAdmin ? <SkillMountRequestPanel isSystemAdmin={isSystemAdmin} /> : null}

      {isSystemAdmin ? (
        <BusinessSkillDomainAdminPanel
          groups={groups}
          duplicateGroups={duplicateGroups}
          actionDrafts={domainActionDrafts}
        />
      ) : null}

      {groups.length ? (
        <div className="business-skill-groups">
          {groups.map((group) => (
            <BusinessSkillGroup
              key={group.id}
              group={group}
              businessSkillSource={displayedSkills}
              isSystemAdmin={isSystemAdmin}
              availableGroups={groups}
              draggingSkillId={draggingSkillId}
              dropTargetGroupId={dropTargetGroupId}
              capabilityLineNames={capabilityLineNames}
              onSaveDisplayName={saveDisplayNameDraft}
              onSaveGroupDisplayName={saveGroupDisplayNameDraft}
              onSaveCapabilityLineName={saveCapabilityLineName}
              onMoveSkillToGroup={moveSkillToGroup}
              onMergeGroup={mergeGroupIntoGroup}
              onArchiveGroup={archiveGroupIntoGroup}
              onDragSkillStart={startSkillDrag}
              onDragSkillEnd={endSkillDrag}
              onDragOverGroup={setDropTargetGroupId}
            />
          ))}
        </div>
      ) : (
        <section className="panel empty-panel">
          <div className="panel-head">
            <div>
              <span className="eyebrow">Business Skills</span>
              <h2>暂无匹配的专项业务技能</h2>
            </div>
            <span className="status-pill muted">未安装其他专项业务技能</span>
          </div>
        </section>
      )}
    </section>
  );
}

function BusinessSkillDomainAdminPanel({ groups, duplicateGroups, actionDrafts }) {
  const skillCount = groups.reduce((count, group) => count + group.skills.length, 0);
  const highRiskCount = groups.reduce((count, group) => count + group.skills.filter((skill) => skill.risk === "高").length, 0);

  return (
    <section className="skill-domain-admin-panel">
      <div className="skill-domain-admin-head">
        <div>
          <span className="eyebrow">Domain Governance</span>
          <strong>业务域归类治理</strong>
          <p>业务域和能力线只影响目录展示与归类；系统自动记录调整，Skill API ID、来源 Skill ID、版本和发布门禁保持独立。</p>
        </div>
        <span className="status-pill info">管理员</span>
      </div>
      <div className="skill-domain-metrics">
        <div>
          <span>业务域</span>
          <strong>{groups.length}</strong>
        </div>
        <div>
          <span>专项 Skill</span>
          <strong>{skillCount}</strong>
        </div>
        <div>
          <span>高风险 Skill</span>
          <strong>{highRiskCount}</strong>
        </div>
        <div>
          <span>变更记录</span>
          <strong>{actionDrafts.length}</strong>
        </div>
      </div>

      {duplicateGroups.length ? (
        <div className="skill-domain-duplicate-alert">
          <GitMerge size={16} />
          <span>检测到 {duplicateGroups.length} 组同名业务域候选，管理员可在对应域的编辑面板合并并自动记录。</span>
        </div>
      ) : null}

      {actionDrafts.length ? (
        <div className="skill-domain-action-trail">
          {actionDrafts.map((draft) => (
            <div className="skill-domain-action" key={draft.id}>
              <span>{draft.submittedAt}</span>
              <strong>{draft.title}</strong>
              <p>{draft.summary}</p>
              {draft.reason ? <small>{draft.reason}</small> : null}
            </div>
          ))}
        </div>
      ) : null}
    </section>
  );
}

function BusinessSkillGroup({
  group,
  businessSkillSource,
  isSystemAdmin,
  availableGroups,
  draggingSkillId,
  dropTargetGroupId,
  capabilityLineNames = {},
  onSaveDisplayName,
  onSaveGroupDisplayName,
  onSaveCapabilityLineName,
  onMoveSkillToGroup,
  onMergeGroup,
  onArchiveGroup,
  onDragSkillStart,
  onDragSkillEnd,
  onDragOverGroup,
}) {
  const [isOpen, setIsOpen] = useState(false);
  const [isEditingGroupName, setIsEditingGroupName] = useState(false);
  const domains = [...new Set(group.skills.map((skill) => skill.domain).filter(Boolean))];
  const departments = [...new Set(group.skills.map((skill) => skill.department).filter(Boolean))];
  const highRiskCount = group.skills.filter((skill) => skill.risk === "高").length;
  const detailsId = `business-skill-group-${group.id}`;
  const canAcceptDrop = Boolean(isSystemAdmin && draggingSkillId);
  const isDropTarget = canAcceptDrop && dropTargetGroupId === group.id;
  const hierarchyBuckets = businessSkillHierarchy(group.skills);

  function toggleGroupNameEditor() {
    setIsOpen(true);
    setIsEditingGroupName((current) => !current);
  }

  return (
    <section
      className={[
        "business-skill-group",
        isOpen ? "is-open" : "",
        isDropTarget ? "is-drop-target" : "",
      ].filter(Boolean).join(" ")}
      onDragOver={(event) => {
        if (!canAcceptDrop) return;
        event.preventDefault();
        event.dataTransfer.dropEffect = "move";
        onDragOverGroup?.(group.id);
      }}
      onDragLeave={(event) => {
        const nextTarget = event.relatedTarget;
        if (!nextTarget || !event.currentTarget.contains(nextTarget)) {
          onDragOverGroup?.("");
        }
      }}
      onDrop={(event) => {
        if (!canAcceptDrop) return;
        event.preventDefault();
        const skillId = event.dataTransfer.getData("text/plain") || draggingSkillId;
        onMoveSkillToGroup?.(skillId, group.id, "拖动 Skill 到业务域");
      }}
    >
      <div className="business-skill-group-head">
        <button
          className="business-skill-group-toggle"
          type="button"
          aria-expanded={isOpen}
          aria-controls={detailsId}
          onClick={() => setIsOpen((current) => !current)}
        >
          <div>
            <span className="eyebrow">Business Group</span>
            <strong>{group.label}</strong>
            <p>{group.description}</p>
          </div>
          <div className="business-skill-group-metrics">
            <b>{group.skills.length} 个专项技能</b>
            <b>{domains.length} 个业务域</b>
            <b>{departments.length} 个归属部门</b>
            {highRiskCount ? <b>{highRiskCount} 个高风险</b> : null}
          </div>
          <span className="entity-cue" aria-hidden="true">
            {isOpen ? <ChevronDown size={18} /> : <ChevronRight size={18} />}
          </span>
        </button>
        {isSystemAdmin ? (
          <button className="ghost-action business-skill-group-edit-action" type="button" onClick={toggleGroupNameEditor}>
            <Settings2 size={15} />
            {isEditingGroupName ? "收起编辑" : "改业务域"}
          </button>
        ) : null}
      </div>
      {isOpen ? (
        <div className="business-skill-group-body" id={detailsId}>
          {isEditingGroupName && isSystemAdmin ? (
            <BusinessSkillGroupEditDraftPanel
              group={group}
              availableGroups={availableGroups}
              onSaveDisplayName={onSaveGroupDisplayName}
              onMergeGroup={onMergeGroup}
              onArchiveGroup={onArchiveGroup}
            />
          ) : null}
          <div className="business-skill-subgroup-note">
            <CheckCircle2 size={15} />
            <span>当前展示已进入目录的专项业务 Skill；MVP 发布项可见但仍需正式持久化、分发和运行审批。</span>
          </div>
          <ExpandableList className="business-skill-list">
            {({ openRowId, setOpenRowId }) => hierarchyBuckets.map((bucket) => (
              <BusinessSkillHierarchyBucket
                key={bucket.key}
                bucket={bucket}
                group={group}
                displayTeamLabel={capabilityLineNames[capabilityLineOverrideKey(group.id, bucket.key)] || bucket.teamLabel}
                availableGroups={availableGroups}
                openRowId={openRowId}
                setOpenRowId={setOpenRowId}
                isSystemAdmin={isSystemAdmin}
                businessSkillSource={businessSkillSource}
                onSaveDisplayName={onSaveDisplayName}
                onSaveCapabilityLineName={onSaveCapabilityLineName}
                onMoveSkillToGroup={onMoveSkillToGroup}
                onDragSkillStart={onDragSkillStart}
                onDragSkillEnd={onDragSkillEnd}
              />
            ))}
          </ExpandableList>
        </div>
      ) : null}
    </section>
  );
}

function BusinessSkillHierarchyBucket({
  bucket,
  group,
  displayTeamLabel,
  availableGroups,
  openRowId,
  setOpenRowId,
  isSystemAdmin,
  businessSkillSource,
  onSaveDisplayName,
  onSaveCapabilityLineName,
  onMoveSkillToGroup,
  onDragSkillStart,
  onDragSkillEnd,
}) {
  const [isOpen, setIsOpen] = useState(true);
  const [isEditingName, setIsEditingName] = useState(false);
  const [lineName, setLineName] = useState(displayTeamLabel);
  const [feedback, setFeedback] = useState("");
  const bucketId = String(bucket.key || "").toLowerCase().replace(/[^a-z0-9\u4e00-\u9fa5]+/g, "-");
  const detailsId = `business-skill-line-${group.id}-${bucketId}`;
  const nextName = lineName.trim() || bucket.teamLabel || "未分能力线";
  const hasNameChange = nextName !== displayTeamLabel;

  function startEditName() {
    setLineName(displayTeamLabel);
    setFeedback("");
    setIsEditingName(true);
  }

  function submitLineName(event) {
    event.preventDefault();
    if (!hasNameChange) {
      setFeedback("名称没有变化。");
      return;
    }
    onSaveCapabilityLineName?.(group.id, bucket, nextName);
    setIsEditingName(false);
    setFeedback("已保存，变更已自动记录。");
  }

  return (
    <section className={isOpen ? "business-skill-hierarchy-bucket is-open" : "business-skill-hierarchy-bucket"}>
      <div className="business-skill-hierarchy-head">
        <button
          className="business-skill-hierarchy-toggle"
          type="button"
          aria-expanded={isOpen}
          aria-controls={detailsId}
          onClick={() => setIsOpen((current) => !current)}
        >
          <div>
            <span className="eyebrow">Capability Line</span>
            <strong>{displayTeamLabel}</strong>
            <p>{bucket.domainLabel}</p>
          </div>
          <span className="status-pill muted">{bucket.skills.length} 个 Skill</span>
          <span className="entity-cue" aria-hidden="true">
            {isOpen ? <ChevronDown size={17} /> : <ChevronRight size={17} />}
          </span>
        </button>
        {isSystemAdmin ? (
          <button className="ghost-action business-skill-line-edit-action" type="button" onClick={startEditName}>
            <PencilLine size={14} />
            改名
          </button>
        ) : null}
      </div>
      {isEditingName && isSystemAdmin ? (
        <form className="business-skill-line-edit-form" onSubmit={submitLineName}>
          <label>
            <span>能力线名称</span>
            <input value={lineName} onChange={(event) => setLineName(event.target.value)} autoFocus />
          </label>
          <button className="primary-action" type="submit" disabled={!hasNameChange}>保存</button>
          <button className="ghost-action" type="button" onClick={() => setIsEditingName(false)}>取消</button>
        </form>
      ) : null}
      {feedback ? <p className="model-binding-note business-skill-line-feedback" role="status">{feedback}</p> : null}
      {isOpen ? (
        <div className="business-skill-hierarchy-body" id={detailsId}>
          {bucket.skills.map((skill) => (
            <BusinessSkillRow
              key={skill.id}
              skill={skill}
              groupId={group.id}
              groupLabel={group.label}
              availableGroups={availableGroups}
              openRowId={openRowId}
              setOpenRowId={setOpenRowId}
              isSystemAdmin={isSystemAdmin}
              businessSkillSource={businessSkillSource}
              onSaveDisplayName={onSaveDisplayName}
              onMoveSkillToGroup={onMoveSkillToGroup}
              onDragSkillStart={onDragSkillStart}
              onDragSkillEnd={onDragSkillEnd}
            />
          ))}
        </div>
      ) : null}
    </section>
  );
}

function BusinessSkillGroupEditDraftPanel({ group, availableGroups, onSaveDisplayName, onMergeGroup, onArchiveGroup }) {
  const [draft, setDraft] = useState(null);
  const [feedback, setFeedback] = useState("");
  const [form, setForm] = useState(() => ({
    label: group.label,
    changeSummary: "",
  }));
  const [archiveTargetGroupId, setArchiveTargetGroupId] = useState("");
  const displayName = form.label.trim() || group.label;
  const matchingGroup = availableGroups.find(
    (item) => item.id !== group.id && normalizeBusinessGroupLabel(item.label) === normalizeBusinessGroupLabel(displayName),
  );
  const archiveTargets = availableGroups.filter((item) => item.id !== group.id);
  const selectedArchiveTargetId = archiveTargets.some((item) => item.id === archiveTargetGroupId)
    ? archiveTargetGroupId
    : archiveTargets[0]?.id || "";
  const hasChanges = displayName !== group.label;

  function updateField(field, value) {
    setForm((current) => ({ ...current, [field]: value }));
    setFeedback("");
  }

  function submitDraft(event) {
    event.preventDefault();
    if (!hasChanges) {
      setFeedback("业务组显示名还没有变化，保存前请先编辑名称。");
      return;
    }
    const nextDraft = {
      ...form,
      label: displayName,
      draftId: `${group.id}-group-name-draft-${Date.now()}`,
      submittedAt: timestampLabel(),
      affectedSkills: group.skills.map((skill) => skill.name),
      mergeTarget: matchingGroup?.label || "",
    };
    setDraft(nextDraft);
      setForm((current) => ({ ...current, label: displayName }));
    if (matchingGroup) {
      onMergeGroup?.(group, matchingGroup, form.changeSummary.trim() || "重命名后与现有业务域同名");
      setFeedback("检测到同名业务域，已合并并自动记录。");
      return;
    }
    onSaveDisplayName?.(group.id, displayName);
    setFeedback("业务域名称已保存，变更已自动记录。");
  }

  function submitArchiveDraft(event) {
    event.preventDefault();
    const targetGroup = archiveTargets.find((item) => item.id === selectedArchiveTargetId);
    if (!targetGroup) {
      setFeedback("没有可归并的目标业务域，暂不能删除当前域。");
      return;
    }
    const nextDraft = {
      label: group.label,
      draftId: `${group.id}-archive-draft-${Date.now()}`,
      submittedAt: timestampLabel(),
      affectedSkills: group.skills.map((skill) => skill.name),
      archiveTarget: targetGroup.label,
      changeSummary: form.changeSummary.trim(),
    };
    setDraft(nextDraft);
    onArchiveGroup?.(group, targetGroup, form.changeSummary.trim() || "删除业务域前归并域内 Skill");
    setFeedback("域内 Skill 已归并到目标域，变更已自动记录。");
  }

  return (
    <section className="skill-draft-panel business-skill-group-draft-panel">
      <div className="skill-draft-head">
        <div>
          <span className="eyebrow">Group Edit</span>
          <strong>业务域快速编辑</strong>
          <p>这里只改目录展示名或归类关系；系统自动记录调整，分发、安装回传和版本追溯仍使用 Skill API ID / 来源 Skill ID。</p>
        </div>
      </div>
      <form className="skill-draft-form" onSubmit={submitDraft}>
        <label className="wide">
          <span>业务域显示名</span>
          <input value={form.label} onChange={(event) => updateField("label", event.target.value)} />
        </label>
        <label className="wide">
          <span>变更摘要</span>
          <textarea
            value={form.changeSummary}
            onChange={(event) => updateField("changeSummary", event.target.value)}
            placeholder="说明为什么调整业务组展示名，不填写私有 Skill payload。"
          />
        </label>
        <div className="skill-draft-actions">
          <span>
            {matchingGroup
              ? `将与 ${matchingGroup.label} 合并并记录`
              : hasChanges
                ? `${group.skills.length} 个专项 Skill 的业务域展示会同步更新`
                : "修改业务域显示名后会自动记录"}
          </span>
          <button className="primary-action" type="submit" disabled={!hasChanges}>{matchingGroup ? "合并并保存" : "保存域名"}</button>
        </div>
      </form>

      <form className="skill-domain-archive-form" onSubmit={submitArchiveDraft}>
        <div>
          <span className="eyebrow">Domain Removal</span>
          <strong>删除域前归并 Skill</strong>
        </div>
        <label>
          <span>归并到</span>
          <select value={selectedArchiveTargetId} onChange={(event) => setArchiveTargetGroupId(event.target.value)} disabled={!archiveTargets.length}>
            {archiveTargets.map((item) => (
              <option key={item.id} value={item.id}>{item.label}</option>
            ))}
          </select>
        </label>
        <button className="ghost-action danger-action" type="submit" disabled={!archiveTargets.length}>
          <Trash2 size={15} />
          归并并删除域
        </button>
      </form>

      {feedback ? <p className="model-binding-note" role="status">{feedback}</p> : null}
      {draft ? (
        <div className="skill-draft-result">
          <strong>{draft.mergeTarget ? "业务域合并" : draft.archiveTarget ? "业务域归并" : "业务域显示名"}已记录：{draft.label}</strong>
          <span>{draft.submittedAt}</span>
          <p>{draft.changeSummary || "仅更新业务域展示与归类记录；能力追溯 ID 不变。"}</p>
          {draft.mergeTarget || draft.archiveTarget ? (
            <div className="chip-line compact">
              <span>目标域</span>
              <b>{draft.mergeTarget || draft.archiveTarget}</b>
            </div>
          ) : null}
          <div className="chip-line compact">
            <span>影响 Skill</span>
            {draft.affectedSkills.map((item) => (
              <b key={item}>{item}</b>
            ))}
          </div>
        </div>
      ) : null}
    </section>
  );
}

function BusinessSkillDomainMoveDraftPanel({ skill, currentGroupId, currentGroupLabel, availableGroups, onMoveSkillToGroup }) {
  const targetGroups = availableGroups.filter((group) => group.id !== currentGroupId);
  const [targetGroupId, setTargetGroupId] = useState(targetGroups[0]?.id || "");
  const [feedback, setFeedback] = useState("");
  const selectedTargetGroupId = targetGroups.some((group) => group.id === targetGroupId)
    ? targetGroupId
    : targetGroups[0]?.id || "";

  function submitMoveDraft(event) {
    event.preventDefault();
    const targetGroup = targetGroups.find((group) => group.id === selectedTargetGroupId);
    if (!targetGroup) {
      setFeedback("没有可移动的目标业务域。");
      return;
    }
    onMoveSkillToGroup?.(skill.id, targetGroup.id, "管理员在 Skill 详情中调整业务域归属");
    setFeedback(`已移动并自动记录：${skill.name} -> ${targetGroup.label}`);
  }

  if (!targetGroups.length) return null;

  return (
    <section className="skill-domain-move-panel">
      <div>
        <span className="eyebrow">Domain Move</span>
        <strong>业务域归属</strong>
      </div>
      <form className="skill-domain-move-form" onSubmit={submitMoveDraft}>
        <label>
          <span>当前域</span>
          <input value={currentGroupLabel} readOnly />
        </label>
        <label>
          <span>移动到</span>
          <select value={selectedTargetGroupId} onChange={(event) => setTargetGroupId(event.target.value)}>
            {targetGroups.map((group) => (
              <option key={group.id} value={group.id}>{group.label}</option>
            ))}
          </select>
        </label>
        <button className="ghost-action" type="submit">
          <MoveRight size={15} />
          移动 Skill
        </button>
      </form>
      {feedback ? <p className="model-binding-note" role="status">{feedback}</p> : null}
    </section>
  );
}

function BusinessSkillRow({
  skill,
  groupId,
  groupLabel,
  availableGroups,
  openRowId,
  setOpenRowId,
  isSystemAdmin,
  businessSkillSource,
  onSaveDisplayName,
  onMoveSkillToGroup,
  onDragSkillStart,
  onDragSkillEnd,
}) {
  const [showApiAccess, setShowApiAccess] = useState(false);
  const [showEditPanel, setShowEditPanel] = useState(false);
  const mountedEmployees = mountedEmployeesForSkill(skill.id, "businessSkillIds");
  const apiAccessVisible = openRowId === skill.id && showApiAccess;
  const editPanelVisible = openRowId === skill.id && showEditPanel;
  const linkedSkillNames = businessSkillNames(skill.linkedSkillIds, businessSkillSource);
  const dependencySkillNames = businessSkillNames(skill.dependencySkillIds, businessSkillSource);
  const showLinkedSkills = linkedSkillNames.length && !sameItems(skill.linkedSkillIds, skill.referenceSkillIds);
  const packageBundle = buildSkillPackageBundle([skill.id], businessSkillSource);
  const packageBundleSummary = packageBundle.includedSkillIds.length > 1 ? `随包 ${packageBundle.includedSkillIds.length} 个 Skill` : "";
  const needsReview = skill.status === "待技能评审";
  const hasReviewRecord = Boolean(skill.mvpPublication);

  function toggleApiAccess() {
    setOpenRowId(skill.id);
    setShowApiAccess((current) => (openRowId === skill.id ? !current : true));
  }

  function toggleEditPanel() {
    setOpenRowId(skill.id);
    setShowEditPanel((current) => (openRowId === skill.id ? !current : true));
  }

  function openDomainMovePanel() {
    setOpenRowId(skill.id);
  }

  function openReferencedSkill(skillId) {
    setOpenRowId(skillId);
    requestAnimationFrame(() => {
      document.getElementById(`business-skills-${skillId}-details`)?.scrollIntoView({ behavior: "smooth", block: "start" });
    });
  }

  return (
    <ExpandableRow
      rowId={skill.id}
      listId="business-skills"
      openRowId={openRowId}
      setOpenRowId={setOpenRowId}
      icon={<ClipboardList size={18} />}
      title={skill.name}
      description={skill.description}
      draggable={isSystemAdmin}
      onDragStart={(event) => {
        event.dataTransfer.effectAllowed = "move";
        event.dataTransfer.setData("text/plain", skill.id);
        onDragSkillStart?.(skill.id);
      }}
      onDragEnd={onDragSkillEnd}
      status={<span className={`status-pill ${statusClass(skill.status)}`}>{displaySkillStatus(skill.status)}</span>}
      summary={[
        groupLabel,
        skill.department,
        mountedEmployeeSummary(mountedEmployees),
        packageBundleSummary,
        `风险 ${skill.risk}`,
        skill.reviewGate,
        displaySkillVersion(skill),
      ]}
      actions={(
        <>
          {isSystemAdmin ? (
            <button className="ghost-action entity-row-action" type="button" onClick={openDomainMovePanel} title="调整 Skill 所属业务域">
              <MoveRight size={15} />
              调整归属
            </button>
          ) : null}
          {isSystemAdmin ? (
            needsReview || hasReviewRecord ? (
              <a className="ghost-action entity-row-action entity-row-link-action" href="#skill-employee-review/skills">
                <BadgeCheck size={15} />
                {needsReview ? "去评审" : "评审记录"}
              </a>
            ) : (
              <button className="ghost-action entity-row-action" type="button" disabled title="该 Skill 尚无平台评审记录">
                <BadgeCheck size={15} />
                暂无记录
              </button>
            )
          ) : null}
          {isSystemAdmin ? (
            <button className="ghost-action entity-row-action entity-row-edit-action" type="button" onClick={toggleEditPanel}>
              <PencilLine size={15} />
              编辑
            </button>
          ) : null}
          {businessSkillPackageDownloadPath(skill) ? (
            <a
              className="ghost-action entity-row-action entity-row-link-action entity-row-download-action"
              href={businessSkillPackageDownloadPath(skill)}
              target="_blank"
              rel="noreferrer"
              title={skill.downloadUrl ? "下载 Skill 声明的完整外部包" : "导出已发布 Skill 的规范化治理包（不含原始上传件和可执行载荷）"}
            >
              <Download size={15} />
              {skill.downloadUrl ? "下载完整包" : "下载治理包"}
            </a>
          ) : (
            <button className="ghost-action entity-row-action entity-row-download-action" type="button" disabled title="该业务 Skill 还没有发布可下载包">
              <Download size={15} />
              下载待发布
            </button>
          )}
          <button className="ghost-action entity-row-action" type="button" onClick={toggleApiAccess}>
            <Code2 size={15} />
            API 接入
          </button>
        </>
      )}
    >
      <div className="gate-line">
        <CheckCircle2 size={16} />
        {skill.reviewGate}
      </div>
      <DetailGrid
        items={[
          ["业务组", groupLabel],
          ["领域", skill.domain],
          ["业务组推荐依据", skill.businessGroupRecommendation?.rationale],
          ["业务组推荐置信度", skill.businessGroupRecommendation?.confidence],
          ["归属部门", skill.department],
          ["归属部门主键", skill.departmentId],
          ["绑定数字员工", mountedEmployeeSummary(mountedEmployees)],
          ["风险等级", skill.risk],
          ["实体版本", displaySkillVersion(skill)],
          ["Prompt 版本", skill.promptVersion],
          ["根因焦点", skill.rootCauseFocus],
        ]}
      />
      {isSystemAdmin ? (
        <BusinessSkillDomainMoveDraftPanel
          skill={skill}
          currentGroupId={groupId}
          currentGroupLabel={groupLabel}
          availableGroups={availableGroups}
          onMoveSkillToGroup={onMoveSkillToGroup}
        />
      ) : null}
      <SkillEditDraftPanel
        skill={skill}
        kind="business"
        ownerDepartment={skill.department}
        mountedEmployees={mountedEmployees}
        isSystemAdmin={isSystemAdmin}
        onSaveDisplayName={onSaveDisplayName}
        isEditing={editPanelVisible}
        onEditingChange={setShowEditPanel}
      />
      {apiAccessVisible ? <ApiAccessPanel entity={skill} kind="businessSkill" runtimeEmployeeId={mountedEmployees[0]?.id || ""} /> : null}
      <GovernanceBlock constraints={skill.constraints} promptKeys={skill.promptKeys} badcases={badcasesForEntity(skill.id)} />
      <SkillCapabilityDetails skill={skill} businessSkillSource={businessSkillSource} onOpenSkill={openReferencedSkill} />
      <SkillPromptGovernancePanel skill={skill} isSystemAdmin={isSystemAdmin} />
      <SkillChips title="绑定数字员工" items={mountedEmployees.length ? mountedEmployees.map((employee) => employee.name) : ["暂无挂载"]} />
      <SkillChips title="挂载基础技能" items={skill.mountedBasicSkills.map((id) => skillNameById(id, basicSkills))} />
      {showLinkedSkills ? <SkillChips title="关联 Skill" items={linkedSkillNames} compact /> : null}
      {dependencySkillNames.length ? <SkillChips title="依赖 Skill" items={dependencySkillNames} compact /> : null}
      <SkillChips title="二级技能" items={["暂未启用二级技能目录"]} compact />
    </ExpandableRow>
  );
}
