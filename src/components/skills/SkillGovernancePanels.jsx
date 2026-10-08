import {
  History,
  Link2,
  PencilLine,
  Settings2,
} from "lucide-react";
import { useState } from "react";
import { businessSkills } from "../../data/catalog";
import { displaySkillStatus, nextDraftVersion, statusClass } from "../../lib/consoleCatalog";
import { buildSkillPackageBundle, packageBundleChips } from "../../lib/skillPackaging";
import { DetailGrid, SkillChips } from "../ConsolePrimitives";
import {
  businessSkillLinks,
  businessSkillNames,
  changedDraftFields,
  downloadPolicyItems,
  joinedList,
  listItems,
  promptGovernanceForSkill,
  referenceItems,
  splitDraftText,
} from "./skillPanelModel";

export function SkillCapabilityDetails({ skill, businessSkillSource = businessSkills, onOpenSkill = null }) {
  const capabilities = listItems(skill.capabilities, skill.description ? [skill.description] : []);
  const inputs = listItems(skill.inputs);
  const outputs = listItems(skill.outputs);
  const tools = listItems(skill.tools);
  const references = referenceItems(skill.references);
  const referenceManifest = Array.isArray(skill.referenceManifest) ? skill.referenceManifest : [];
  const downloadPolicy = downloadPolicyItems(skill.downloadPolicy);
  const dependencies = businessSkillNames(skill.dependencySkillIds, businessSkillSource);
  const referenceSkills = businessSkillLinks(skill.referenceSkillIds, businessSkillSource);
  const decompositionRule = listItems(skill.decompositionRule);
  const dependencyPolicy = listItems(skill.dependencyPolicy);
  const referencePolicy = listItems(skill.referencePolicy);
  const identityPolicy = listItems(skill.identityRule ? [skill.identityRule] : []);
  const apiDependencies = businessSkillNames([
    ...listItems(skill.apiDependencySkillIds),
    ...listItems(skill.apiCalledSkillIds),
    ...listItems(skill.runtimeSkillIds),
  ], businessSkillSource);
  const packageBundle = buildSkillPackageBundle([skill.id], businessSkillSource);
  const packageBundleItems = packageBundleChips(packageBundle);
  const packageIncludes = listItems(skill.packageIncludes);
  const packagePortableContents = listItems(skill.packageBoundary?.portableContents);
  const platformRecords = listItems(skill.packageBoundary?.platformRecords);
  const showPackageBundle = packageBundleItems.length && (packageBundle.includedSkillIds.length > 1 || packageIncludes.length || skill.downloadUrl);

  return (
    <section className="skill-draft-panel">
      <div className="skill-draft-head">
        <div>
          <span className="eyebrow">Skill Contract</span>
          <strong>能力、输入输出和 Reference</strong>
          <p>安装目录只保存安全摘要和引用路径，不保存私有 Skill payload。</p>
        </div>
      </div>
      <DetailGrid
        items={[
          ["Skill API ID", skill.skillApiId || skill.id],
          ["来源 Skill ID", skill.sourceSkillId],
          ["当前显示名", skill.name],
          ["原始显示名", skill.originalName],
          ["技能包", skill.skillPackage],
          ["安装包格式", skill.packageFormat],
          ["完整性确认", skill.packageCompleteness],
          ["包/平台边界", skill.packageRecordBoundary || skill.packageBoundary?.boundarySummary],
          ["拆分粒度", skill.installGranularity],
          ["单位能力口径", skill.unitCapabilityRule],
          ["来源", skill.sourceRef],
          ["合同摘要", skill.contractDigest],
          ["Prompt Scope", skill.promptScope || skill.promptGovernance?.promptScope],
        ]}
      />
      {downloadPolicy.length ? <SkillChips title="下载使用权" items={downloadPolicy} compact /> : null}
      {identityPolicy.length ? <SkillChips title="唯一 ID 追溯" items={identityPolicy} compact /> : null}
      {showPackageBundle ? <SkillChips title="下载包包含 Skill" items={packageBundleItems} compact /> : null}
      {dependencies.length ? <SkillChips title="声明依赖" items={dependencies} compact /> : null}
      {apiDependencies.length ? <SkillChips title="API 调用依赖" items={apiDependencies} compact /> : null}
      {referenceSkills.length ? <ReferenceSkillLinks skills={referenceSkills} onOpenSkill={onOpenSkill} /> : null}
      <SkillChips title="能做什么" items={capabilities.length ? capabilities : ["待补充能力说明"]} />
      <SkillChips title="输入" items={inputs.length ? inputs : ["待补充输入契约"]} compact />
      <SkillChips title="输出" items={outputs.length ? outputs : ["待补充输出契约"]} compact />
      <SkillChips title="工具" items={tools.length ? tools : ["待补充工具声明"]} compact />
      <SkillPolicyDisclosure
        sections={[
          ["完整包内容", packageIncludes],
          ["包内能力声明", packagePortableContents],
          ["平台闭环记录", platformRecords],
          ["安装拆分规则", decompositionRule],
          ["依赖安装策略", dependencyPolicy],
          ["Reference 安装策略", referencePolicy],
        ]}
      />
      <ReferenceSourceDisclosure references={references} referenceManifest={referenceManifest} />
    </section>
  );
}

function ReferenceSkillLinks({ skills, onOpenSkill }) {
  return (
    <div className="skill-reference-links">
      <div className="skill-reference-links-head">
        <span>Reference Skill</span>
        <b>已链接到 {skills.length} 个技能</b>
      </div>
      <div className="skill-reference-link-grid">
        {skills.map((skill) => {
          const className = ["skill-reference-link", statusClass(skill.status), onOpenSkill ? "is-linked" : ""].filter(Boolean).join(" ");
          return (
            <button
              key={skill.id}
              className={className}
              type="button"
              onClick={() => onOpenSkill?.(skill.id)}
              disabled={!onOpenSkill}
              title={onOpenSkill ? `打开 ${skill.name} 技能详情` : skill.name}
            >
              <Link2 size={15} />
              <span className="skill-reference-link-text">
                <strong>{skill.name}</strong>
                <small>{skill.skillApiId || skill.id}</small>
              </span>
              <span className="skill-reference-link-status">{displaySkillStatus(skill.status || "已链接")}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

function SkillPolicyDisclosure({ sections }) {
  const visibleSections = sections
    .map(([title, items]) => ({ title, items: listItems(items) }))
    .filter((section) => section.items.length);
  const itemCount = visibleSections.reduce((count, section) => count + section.items.length, 0);

  if (!visibleSections.length) return null;

  return (
    <details className="skill-policy-disclosure">
      <summary>
        <span>安装与治理细则</span>
        <b>{visibleSections.length} 组 / {itemCount} 条</b>
      </summary>
      <div className="skill-policy-disclosure-body">
        {visibleSections.map((section) => (
          <SkillChips key={section.title} title={section.title} items={section.items} compact />
        ))}
      </div>
    </details>
  );
}

function ReferenceSourceDisclosure({ references, referenceManifest = [] }) {
  if (!references.length) {
    return <SkillChips title="Reference" items={["待补充 reference"]} compact />;
  }
  const manifestByPath = new Map(referenceManifest.map((item) => [item.path, item]));

  return (
    <details className="skill-reference-sources">
      <summary>
        <span>Reference 文件与路径</span>
        <b>{references.length} 项</b>
      </summary>
      <div className="chip-line compact">
        <span>路径</span>
        {references.map((item) => {
          const metadata = manifestByPath.get(item);
          const fingerprint = metadata?.sha256 ? ` · ${metadata.sha256.slice(0, 19)}… · ${metadata.bytes} B` : "";
          return <b key={item}>{item}{fingerprint}</b>;
        })}
      </div>
    </details>
  );
}

export function SkillPromptGovernancePanel({ skill, isSystemAdmin }) {
  const [isEditing, setIsEditing] = useState(false);
  const [draft, setDraft] = useState(null);
  const governance = promptGovernanceForSkill(skill, draft);
  const [form, setForm] = useState(() => ({
    promptVersion: governance.promptVersion,
    promptScope: governance.promptScope,
    promptHash: governance.promptHash,
    promptKeys: joinedList(governance.promptKeys),
    promptChangeSummary: governance.promptChangeSummary,
    promptReviewGate: governance.promptReviewGate,
  }));

  function updateField(field, value) {
    setForm((current) => ({ ...current, [field]: value }));
  }

  function submitDraft(event) {
    event.preventDefault();
    setDraft({
      ...form,
      promptKeys: form.promptKeys.split(/\n|,/).map((item) => item.trim()).filter(Boolean),
      rawPromptStored: false,
      draftId: `${skill.id}-prompt-draft-${Date.now()}`,
      submittedAt: new Date().toLocaleString("zh-CN", { hour12: false }),
    });
    setIsEditing(false);
  }

  return (
    <section className="model-binding-panel prompt-governance-panel">
      <div className="model-binding-head">
        <span className="model-binding-icon"><History size={16} /></span>
        <div>
          <span className="eyebrow">Prompt Governance</span>
          <strong>Prompt 元配置</strong>
          <p>这里只维护 scope、版本、hash、keys 和变更摘要；raw Prompt 不进入目录。</p>
        </div>
        {isSystemAdmin ? (
          <button className="ghost-action" type="button" onClick={() => setIsEditing((current) => !current)}>
            <Settings2 size={16} />
            {isEditing ? "收起" : "编辑元配置"}
          </button>
        ) : (
          <span className="status-pill muted">仅管理员编辑</span>
        )}
      </div>
      <DetailGrid
        items={[
          ["Prompt Scope", governance.promptScope],
          ["Prompt 版本", governance.promptVersion],
          ["Prompt Hash", governance.promptHash],
          ["Raw Prompt", governance.rawPromptStored ? "已保存" : "不保存"],
          ["来源", governance.source],
          ["审核门禁", governance.promptReviewGate],
          ["变更摘要", governance.promptChangeSummary],
        ]}
      />
      <SkillChips title="Prompt keys" items={listItems(governance.promptKeys).length ? listItems(governance.promptKeys) : ["待补充"]} compact />

      {isEditing && isSystemAdmin ? (
        <form className="model-binding-form" onSubmit={submitDraft}>
          <label>
            <span>Prompt 版本</span>
            <input value={form.promptVersion} onChange={(event) => updateField("promptVersion", event.target.value)} />
          </label>
          <label>
            <span>Scope</span>
            <input value={form.promptScope} onChange={(event) => updateField("promptScope", event.target.value)} />
          </label>
          <label>
            <span>Hash</span>
            <input value={form.promptHash} onChange={(event) => updateField("promptHash", event.target.value)} />
          </label>
          <label className="model-binding-wide">
            <span>Prompt keys</span>
            <textarea value={form.promptKeys} onChange={(event) => updateField("promptKeys", event.target.value)} />
          </label>
          <label className="model-binding-wide">
            <span>变更摘要</span>
            <textarea value={form.promptChangeSummary} onChange={(event) => updateField("promptChangeSummary", event.target.value)} placeholder="只写元数据变更摘要，不填写 raw Prompt。" />
          </label>
          <label className="model-binding-wide">
            <span>审核门禁</span>
            <textarea value={form.promptReviewGate} onChange={(event) => updateField("promptReviewGate", event.target.value)} />
          </label>
          <div className="model-binding-actions model-binding-wide">
            <span>保存后仅生成本页治理草案；生产仍需后端 RBAC 和审计。</span>
            <button className="primary-action" type="submit">保存 Prompt 配置</button>
          </div>
        </form>
      ) : null}

      {draft ? (
        <div className="skill-draft-result">
          <strong>Prompt 草案已生成：{draft.promptVersion || "未命名版本"}</strong>
          <span>{draft.submittedAt}</span>
          <p>{draft.promptChangeSummary || "待补充 Prompt 元配置变更摘要"}</p>
          <div className="chip-line compact">
            <span>keys</span>
            {(draft.promptKeys.length ? draft.promptKeys : ["待补充"]).map((item) => (
              <b key={item}>{item}</b>
            ))}
          </div>
        </div>
      ) : null}

      {!isSystemAdmin ? <p className="model-binding-note">当前账号可查看 Prompt 元配置；编辑需要系统管理员权限。</p> : null}
    </section>
  );
}

export function SkillEditDraftPanel({
  skill,
  kind,
  ownerDepartment,
  mountedEmployees,
  isSystemAdmin,
  onSaveDisplayName,
  isEditing = false,
  onEditingChange,
}) {
  const [draft, setDraft] = useState(null);
  const [feedback, setFeedback] = useState("");
  const [form, setForm] = useState(() => ({
    name: skill.name,
    owner: skill.owner || ownerDepartment,
    department: ownerDepartment,
    risk: skill.risk || "中",
    reviewGate: skill.reviewGate || "负责人审核后生成版本草案",
    capabilities: joinedList(skill.capabilities),
    references: joinedList(skill.references),
    changeSummary: "",
  }));
  const isBusiness = kind === "business";
  const baseline = {
    name: skill.name,
    owner: skill.owner || ownerDepartment,
    department: ownerDepartment,
    risk: skill.risk || "中",
    reviewGate: skill.reviewGate || "负责人审核后生成版本草案",
    capabilities: listItems(skill.capabilities),
    references: listItems(skill.references),
  };
  const preparedForm = {
    ...form,
    name: form.name.trim() || skill.name,
    owner: form.owner.trim(),
    department: form.department.trim(),
    reviewGate: form.reviewGate.trim(),
    capabilities: splitDraftText(form.capabilities),
    references: splitDraftText(form.references),
  };
  const changedFields = changedDraftFields(preparedForm, baseline, {
    name: "显示名",
    owner: "负责人",
    department: "归属部门",
    risk: "风险",
    reviewGate: "审核门禁",
    capabilities: "能力说明",
    references: "Reference",
  });
  const hasChanges = changedFields.length > 0;

  function toggleEditing() {
    const nextEditing = !isEditing;
    onEditingChange?.(nextEditing);
    setFeedback(nextEditing ? "" : feedback);
  }

  function updateField(field, value) {
    setForm((current) => ({ ...current, [field]: value }));
    setFeedback("");
  }

  function submitDraft(event) {
    event.preventDefault();
    if (!hasChanges) {
      setFeedback("还没有修改字段，保存前请先调整需要变更的内容。");
      return;
    }
    const displayName = preparedForm.name;
    const nextDraft = {
      ...preparedForm,
      name: displayName,
      draftId: `${skill.id}-draft-${Date.now()}`,
      targetVersion: nextDraftVersion(skill.version),
      changedFields,
      changeSummary: form.changeSummary.trim(),
      affectedEmployees: mountedEmployees.map((employee) => employee.name),
      submittedAt: new Date().toLocaleString("zh-CN", { hour12: false }),
      lineageKeys: [skill.skillApiId || skill.id, skill.sourceSkillId].filter(Boolean),
    };
    setDraft(nextDraft);
    onSaveDisplayName?.(skill.id, displayName);
    setForm((current) => ({ ...current, name: displayName }));
    onEditingChange?.(false);
    setFeedback("编辑已保存为待审核草案。");
  }

  return (
    <section className="skill-draft-panel">
      <div className="skill-draft-head">
        <div>
          <span className="eyebrow">Edit Draft</span>
          <strong>{isBusiness ? "专项技能编辑草案" : "基础技能编辑草案"}</strong>
          <p>编辑只生成待审核草案，不直接覆盖当前版本。</p>
        </div>
        {isSystemAdmin ? (
          <button className="ghost-action" type="button" onClick={toggleEditing}>
            <PencilLine size={16} />
            {isEditing ? "收起编辑" : "编辑"}
          </button>
        ) : (
          <span className="status-pill muted">仅管理员编辑</span>
        )}
      </div>

      {isEditing && isSystemAdmin ? (
        <form className="skill-draft-form" onSubmit={submitDraft}>
          <label>
            <span>显示名</span>
            <input value={form.name} onChange={(event) => updateField("name", event.target.value)} />
          </label>
          <label>
            <span>归属部门</span>
            <input value={form.department} onChange={(event) => updateField("department", event.target.value)} />
          </label>
          <label>
            <span>负责人</span>
            <input value={form.owner} onChange={(event) => updateField("owner", event.target.value)} />
          </label>
          <label>
            <span>风险</span>
            <select value={form.risk} onChange={(event) => updateField("risk", event.target.value)}>
              <option value="低">低</option>
              <option value="中">中</option>
              <option value="高">高</option>
            </select>
          </label>
          <label className="wide">
            <span>审核门禁</span>
            <input value={form.reviewGate} onChange={(event) => updateField("reviewGate", event.target.value)} />
          </label>
          <label className="wide">
            <span>能力说明</span>
            <textarea
              value={form.capabilities}
              onChange={(event) => updateField("capabilities", event.target.value)}
              placeholder="一行一个能力点。"
            />
          </label>
          <label className="wide">
            <span>Reference</span>
            <textarea
              value={form.references}
              onChange={(event) => updateField("references", event.target.value)}
              placeholder="一行一个来源路径或文档引用。"
            />
          </label>
          <label className="wide">
            <span>变更摘要</span>
            <textarea
              value={form.changeSummary}
              onChange={(event) => updateField("changeSummary", event.target.value)}
              placeholder="描述本次要改的范围、原因和影响，不填写 raw Prompt。"
            />
          </label>
          <div className="skill-draft-actions">
            <span>{hasChanges ? `将保存 ${changedFields.join("、")} 变更，影响 ${mountedEmployees.length} 个挂载数字员工` : "修改字段后会生成待审核草案"}</span>
            <button className="primary-action" type="submit" disabled={!hasChanges}>保存编辑</button>
          </div>
        </form>
      ) : null}

      {feedback ? <p className="model-binding-note" role="status">{feedback}</p> : null}
      {draft ? (
        <div className="skill-draft-result">
          <strong>编辑草案已生成：{draft.name}</strong>
          <span>{draft.submittedAt}</span>
          <p>{draft.changeSummary || "已记录字段变更；版本追溯仍使用 Skill API ID / 来源 Skill ID。"}</p>
          <div className="chip-line compact">
            <span>变更字段</span>
            {draft.changedFields.map((item) => (
              <b key={item}>{item}</b>
            ))}
          </div>
          <div className="chip-line compact">
            <span>追溯 ID</span>
            {draft.lineageKeys.map((item) => (
              <b key={item}>{item}</b>
            ))}
          </div>
          <div className="chip-line compact">
            <span>影响员工</span>
            {(draft.affectedEmployees.length ? draft.affectedEmployees : ["暂无挂载"]).map((item) => (
              <b key={item}>{item}</b>
            ))}
          </div>
        </div>
      ) : null}
      {!isSystemAdmin ? <p className="model-binding-note">当前账号可查看 Skill 详情；创建 Skill/Prompt 治理草案需要系统管理员权限。</p> : null}
    </section>
  );
}
