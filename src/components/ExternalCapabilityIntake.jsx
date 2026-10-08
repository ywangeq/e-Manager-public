import { UploadCloud } from "lucide-react";
import { useEffect, useState } from "react";
import { departments, personnel } from "../data/catalog";
import {
  ACCEPTED_PACKAGE_EXTENSIONS,
  PACKAGE_INTAKE_NOTE,
  buildExternalCapabilityIntakePayload,
  buildSkillUpdateIntakePayload,
  buildOwnerHintOptions,
  departmentOptionLabel,
  resolveDefaultOwnerHint,
  resolveIntakeSourceRef,
  resolveUploaderDepartment,
} from "../lib/externalCapabilityIntake";
import { SkillChips } from "./ConsolePrimitives";

const MAX_INLINE_PACKAGE_BYTES = 10 * 1024 * 1024;

const intakeCopy = {
  employee: {
    eyebrow: "AI Worker Intake",
    title: "业务数字员工登记",
    closedLabel: "员工上传",
    openLabel: "收起登记",
    adminOnlyLabel: "仅管理员登记",
    note: "人只登记来源和安全补充；默认归属当前上传者部门，员工 ID 由登记 harness 去重生成。",
    typeLabel: "外部员工来源",
    sourceLabel: "Repo link / 员工包引用",
    sourcePlaceholder: "示例：repo://skills_group/yewu/simo-algorithm-assistant",
    fileLabel: "员工包文件",
    packageNote: "可选 .zip/.tar/.gz/.tgz；小型包会交给后端读取安全摘要，过大或未接收内容时只登记引用并阻断补材料。",
    summaryLabel: "补充安全说明",
    submitLabel: "提交员工预审",
    missingSource: "请填写 repo link / 外部数字员工包引用，或选择一个包文件用于登记。",
    failure: "业务数字员工登记失败",
    decomposition: ["归属部门：上传者会话部门", "员工 ID：部门内按来源去重生成", "权限/工具/依赖 Skill 线索", "待人员审批草案"],
    defaultForm: {
      sourceType: "repo_link",
      sourceRef: "",
      ownerHint: "",
      safeSummary: "业务级外部数字员工登记：由外部数字员工登记员和 AI Worker 拆解来源、权限、工具和挂载 Skill，生成待人员审批草案。",
    },
  },
  skill: {
    eyebrow: "AI Worker Intake",
    title: "专业技能登记",
    closedLabel: "技能上传",
    openLabel: "收起登记",
    adminOnlyLabel: "仅管理员上传",
    note: "人只登记 OpenAI Skill 来源；默认归属当前上传者部门，Skill ID 由登记 harness 在部门内去重生成。",
    typeLabel: "上传类型",
    sourceLabel: "Repo link / 包引用",
    sourcePlaceholder: "示例：repo://skills_group/yewu/simo-algorithm-assistant",
    fileLabel: "OpenAI 包文件",
    packageNote: "OpenAI Skill 包可以选择 .zip；小型包会交给后端读取 SKILL.md 安全摘要并生成 Agent 评审稿。",
    summaryLabel: "补充安全说明",
    submitLabel: "提交技能预审",
    missingSource: "请填写 repo link / OpenAI Skill 包引用，或选择一个包文件用于登记。",
    missingEmployeeName: "请填写要初始化的业务数字员工名称，或关闭同时初始化员工。",
    failure: "专业技能登记失败",
    decomposition: ["归属部门：上传者会话部门", "Skill ID：部门内按来源/目录去重生成", "SKILL.md / manifest 待安全校验", "待技能评审草案"],
    defaultForm: {
      sourceType: "repo_link",
      sourceRef: "",
      ownerHint: "",
      safeSummary: "外部业务 Skill 包登记：由外部数字员工登记员拆解 OpenAI Skill 包或 repo link，生成待技能评审草案。",
      declareDigitalEmployee: false,
      employeeName: "",
      employeeTitle: "",
      employeeObjective: "",
      employeeRules: "",
      employeeTools: "",
      employeeOutputContract: "",
    },
  },
};

export default function ExternalCapabilityIntake({ kind = "skill", isSystemAdmin = false, session = null }) {
  const copy = intakeCopy[kind] || intakeCopy.skill;
  const [isOpen, setIsOpen] = useState(false);
  const [packageFileName, setPackageFileName] = useState("");
  const [packageFile, setPackageFile] = useState(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [result, setResult] = useState(null);
  const [error, setError] = useState("");
  const [form, setForm] = useState(copy.defaultForm);
  const [targetDepartmentId, setTargetDepartmentId] = useState("");
  const [intakeMode, setIntakeMode] = useState("new");
  const [publishedSkills, setPublishedSkills] = useState([]);
  const [publishedSkillsError, setPublishedSkillsError] = useState("");
  const [selectedSkillId, setSelectedSkillId] = useState("");
  const [targetVersion, setTargetVersion] = useState("");
  const isSkill = kind === "skill";
  const isUpdate = isSkill && intakeMode === "update";
  const uploaderDepartment = resolveUploaderDepartment(session);
  const ownerHintOptions = buildOwnerHintOptions({ session, uploaderDepartment, departments, personnel });
  const defaultOwnerHint = resolveDefaultOwnerHint(ownerHintOptions, uploaderDepartment);
  const selectedOwnerHint = form.ownerHint || defaultOwnerHint;
  const targetDepartments = departments.filter((department) => department.id && department.id !== "company");
  const targetDepartmentLabel = targetDepartmentId
    ? departmentOptionLabel(targetDepartments.find((department) => department.id === targetDepartmentId) || { id: targetDepartmentId, name: targetDepartmentId })
    : uploaderDepartment;
  const selectedSkill = publishedSkills.find((skill) => skill.id === selectedSkillId) || null;

  useEffect(() => {
    if (!isOpen || !isUpdate) return undefined;
    let cancelled = false;
    setPublishedSkillsError("");
    fetch("/api/business-skills?status=mvp_skill_published", { credentials: "include" })
      .then(async (response) => {
        const body = await response.json().catch(() => ({}));
        if (!response.ok || !body.ok) throw new Error(body.error || "已发布 Skill 目录读取失败");
        return Array.isArray(body.businessSkills) ? body.businessSkills.filter((skill) => skill.status === "mvp_skill_published") : [];
      })
      .then((skills) => {
        if (cancelled) return;
        setPublishedSkills(skills);
        setSelectedSkillId((current) => current || skills[0]?.id || "");
      })
      .catch((loadError) => {
        if (!cancelled) setPublishedSkillsError(loadError instanceof Error ? loadError.message : "已发布 Skill 目录读取失败");
      });
    return () => {
      cancelled = true;
    };
  }, [isOpen, isUpdate]);

  function updateField(field, value) {
    setForm((current) => ({ ...current, [field]: value }));
  }

  function updateSourceType(sourceType) {
    setPackageFileName("");
    setPackageFile(null);
    setForm((current) => ({
      ...current,
      sourceType,
      sourceRef: "",
    }));
  }

  function updateIntakeMode(nextMode) {
    setIntakeMode(nextMode);
    if (nextMode === "update") {
      setForm((current) => ({ ...current, safeSummary: "" }));
    }
    setError("");
    setResult(null);
  }

  function resolvedSourceRef() {
    return resolveIntakeSourceRef({ sourceRef: form.sourceRef, packageFileName, isSkill });
  }

  async function submitIntake(event) {
    event.preventDefault();
    if (!isSystemAdmin || isSubmitting) return;

    const sourceRef = resolvedSourceRef();
    if (!sourceRef) {
      setError(copy.missingSource);
      return;
    }
    if (isUpdate && (!selectedSkill || !targetVersion.trim())) {
      setError(!selectedSkill ? "请选择要升级的已发布 Skill。" : "请填写与包内 sidecar 完全一致的目标版本。");
      return;
    }
    if (isUpdate && packageFile && packageFile.size > MAX_INLINE_PACKAGE_BYTES) {
      setError("升级包超过 10 MiB 上传上限；请先减小压缩包体积后重试。");
      return;
    }
    if (!isUpdate && isSkill && form.declareDigitalEmployee && !form.employeeName.trim()) {
      setError(copy.missingEmployeeName);
      return;
    }

    setIsSubmitting(true);
    setError("");
    setResult(null);

    try {
      const packageFilePayload = await readPackageFile(packageFile);
      const payload = isUpdate
        ? buildSkillUpdateIntakePayload({
          skill: selectedSkill,
          sourceRef,
          sourceType: form.sourceType,
          targetVersion,
          declaredChanges: form.safeSummary,
          packageFile: packageFilePayload,
        })
        : buildExternalCapabilityIntakePayload({
        sourceRef,
        sourceType: form.sourceType,
        isSkill,
        ownerHint: selectedOwnerHint,
        targetDepartmentId,
        safeSummary: form.safeSummary,
        packageFile: packageFilePayload,
        declareDigitalEmployee: isSkill && form.declareDigitalEmployee,
        employeeDeclaration: {
          name: form.employeeName,
          title: form.employeeTitle,
          objective: form.employeeObjective,
          rules: form.employeeRules,
          tools: form.employeeTools,
          outputContract: form.employeeOutputContract,
        },
        });
      const response = await fetch(isUpdate ? "/api/system-imports/skill-updates" : "/api/system-imports/external-digital-employees", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify(payload),
      });
      const body = await response.json();
      if (!response.ok) {
        throw new Error(body.message || body.error || copy.failure);
      }
      setResult(body);
    } catch (intakeError) {
      setError(intakeError instanceof Error ? intakeError.message : isUpdate ? "Skill 升级登记失败" : copy.failure);
    } finally {
      setIsSubmitting(false);
    }
  }

  const employeeDraftCount = result?.externalEmployeeDrafts?.length || 0;
  const skillDraftCount = result?.skillDrafts?.length || 0;
  const agentPreReviewCount = result?.autoWorkflow?.agentPreReviewCount || result?.importJob?.autoWorkflow?.agentPreReviewCount || 0;
  const preReviewWorker = result?.preReview?.workerId || result?.preReview?.workerName || result?.importJob?.preReview?.workerId || "external-agent-precheck";
  const decompositionItems = isSkill && form.declareDigitalEmployee
    ? [...copy.decomposition, "员工草案：按显式声明进入待人员审批"]
    : isUpdate
      ? ["精确匹配已发布 Skill ID / 来源 Skill ID", "当前版本必须与已发布头一致", "目标版本必须与包内 sidecar 一致", "只生成待技能评审升级草案"]
      : copy.decomposition;

  return (
    <section className={`capability-intake ${isOpen ? "is-open" : ""}`}>
      <div className="capability-intake-bar">
        <div>
          <span className="eyebrow">{copy.eyebrow}</span>
          <strong>{copy.title}</strong>
          <p>{copy.note}</p>
        </div>
        {isSystemAdmin ? (
          <button className="ghost-action" type="button" onClick={() => setIsOpen((current) => !current)}>
            <UploadCloud size={16} />
            {isOpen ? copy.openLabel : copy.closedLabel}
          </button>
        ) : (
          <button className="ghost-action" type="button" disabled>
            <UploadCloud size={16} />
            {copy.adminOnlyLabel}
          </button>
        )}
      </div>

      {!isSystemAdmin ? <p className="model-binding-note">当前账号可查看目录；登记、安装预审和草案创建需要系统管理员权限。</p> : null}

      {isOpen && isSystemAdmin ? (
        <form className="skill-draft-form skill-upload-form" onSubmit={submitIntake}>
          {isSkill ? (
            <label>
              <span>登记动作</span>
              <select value={intakeMode} onChange={(event) => updateIntakeMode(event.target.value)}>
                <option value="new">登记新 Skill</option>
                <option value="update">升级已发布 Skill</option>
              </select>
            </label>
          ) : null}
          <div className="skill-upload-guidance">
            <strong>{isUpdate ? "精确升级已发布版本，再交预审" : "只交来源，登记预审交给 harness"}</strong>
            <p>{isUpdate ? "升级沿用已发布 Skill 的身份和归属；不创建新资产，也不直接覆盖运行版本。" : `当前治理归属：${targetDepartmentLabel}。名称、ID、部门内去重、能力清单和依赖关系都不在这里手填。`}</p>
            <SkillChips title="登记规则" items={decompositionItems} compact />
          </div>
          {isUpdate ? (
            <>
              <label className="wide">
                <span>已发布 Skill</span>
                <select value={selectedSkillId} onChange={(event) => setSelectedSkillId(event.target.value)}>
                  <option value="">请选择</option>
                  {publishedSkills.map((skill) => (
                    <option key={skill.id} value={skill.id}>{skill.name || skill.id} · {skill.version}</option>
                  ))}
                </select>
                {publishedSkillsError ? <small>{publishedSkillsError}</small> : null}
                {selectedSkill ? <small>Skill ID：{selectedSkill.id}；来源 Skill ID：{selectedSkill.sourceSkillId || selectedSkill.skillApiId || selectedSkill.id}；当前版本：{selectedSkill.version}</small> : null}
              </label>
              <label>
                <span>目标版本</span>
                <input value={targetVersion} onChange={(event) => setTargetVersion(event.target.value)} placeholder="例如：skill-2026.08.25-03" />
              </label>
            </>
          ) : null}
          <label>
            <span>{copy.typeLabel}</span>
            <select value={form.sourceType} onChange={(event) => updateSourceType(event.target.value)}>
              <option value="repo_link">Repo link</option>
              <option value="openai_package">{isSkill ? "OpenAI Skill 包" : "外部员工包"}</option>
            </select>
          </label>
          {form.sourceType === "repo_link" ? (
            <label className="wide">
              <span>{copy.sourceLabel}</span>
              <input value={form.sourceRef} onChange={(event) => updateField("sourceRef", event.target.value)} placeholder={copy.sourcePlaceholder} />
            </label>
          ) : (
            <>
              <label className="wide">
                <span>{copy.fileLabel}</span>
                <input
                  type="file"
                  accept={ACCEPTED_PACKAGE_EXTENSIONS.join(",")}
                  onChange={(event) => {
                    const nextFile = event.target.files?.[0] || null;
                    setPackageFile(nextFile);
                    setPackageFileName(nextFile?.name || "");
                  }}
                />
                <small>{copy.packageNote}</small>
              </label>
              <label className="wide">
                <span>不可变 Git sourceRef（可选）</span>
                <input
                  value={form.sourceRef}
                  onChange={(event) => updateField("sourceRef", event.target.value)}
                  placeholder="git+https://git.example.invalid/组织/仓库.git@commit#Skill 路径"
                />
                <small>填写后将与包内容一起写入导入、审核、发布和挂载审计记录。</small>
              </label>
            </>
          )}
          {!isUpdate ? <label>
            <span>治理归属</span>
            <select value={targetDepartmentId} onChange={(event) => setTargetDepartmentId(event.target.value)}>
              <option value="">当前上传者部门</option>
              {targetDepartments.map((department) => (
                <option key={department.id} value={department.id}>{departmentOptionLabel(department)}</option>
              ))}
            </select>
          </label> : null}
          {!isUpdate ? <label>
            <span>归属线索</span>
            <select value={selectedOwnerHint} onChange={(event) => updateField("ownerHint", event.target.value)}>
              <optgroup label="自动带入">
                {ownerHintOptions.automatic.map((option) => (
                  <option key={option.value} value={option.value}>{option.label}</option>
                ))}
              </optgroup>
              <optgroup label="目录人员">
                {ownerHintOptions.directory.map((option) => (
                  <option key={option.value} value={option.value}>{option.label}</option>
                ))}
              </optgroup>
            </select>
          </label> : null}
          <label className="wide">
            <span>{isUpdate ? "升级说明（每行一项）" : copy.summaryLabel}</span>
            <textarea value={form.safeSummary} onChange={(event) => updateField("safeSummary", event.target.value)} placeholder={isUpdate ? "例如：评分输出组织由 Skill 统一约束；保留 Handler 的动态评分量表投影" : "可选：补充安全边界、用途或不得执行的动作"} />
          </label>
          {isSkill && !isUpdate ? (
            <>
              <label className="wide checkbox-label">
                <input
                  type="checkbox"
                  checked={Boolean(form.declareDigitalEmployee)}
                  onChange={(event) => updateField("declareDigitalEmployee", event.target.checked)}
                />
                <span>同时初始化业务数字员工草案</span>
              </label>
              {form.declareDigitalEmployee ? (
                <>
                  <label>
                    <span>员工名称</span>
                    <input value={form.employeeName} onChange={(event) => updateField("employeeName", event.target.value)} placeholder="例如：SMoss 方案完备性检查专员" />
                  </label>
                  <label>
                    <span>岗位 / 用途</span>
                    <input value={form.employeeTitle} onChange={(event) => updateField("employeeTitle", event.target.value)} placeholder="例如：软件组方案配置检查" />
                  </label>
                  <label className="wide">
                    <span>员工目标</span>
                    <textarea value={form.employeeObjective} onChange={(event) => updateField("employeeObjective", event.target.value)} placeholder="说明这个员工如何组合本包 Skill，以及人员审批前只能输出什么草案。" />
                  </label>
                  <label className="wide">
                    <span>运行规则</span>
                    <textarea value={form.employeeRules} onChange={(event) => updateField("employeeRules", event.target.value)} placeholder="每行一条：只读边界、检查顺序、人工复核规则、不得执行的生产动作。" />
                  </label>
                  <label className="wide">
                    <span>工具边界</span>
                    <textarea value={form.employeeTools} onChange={(event) => updateField("employeeTools", event.target.value)} placeholder="每行一条：允许使用的工具、Skill 组合、API 门禁或 Agent 预审链路。" />
                  </label>
                  <label className="wide">
                    <span>输出契约</span>
                    <input value={form.employeeOutputContract} onChange={(event) => updateField("employeeOutputContract", event.target.value)} placeholder="例如：solutionCheckReport{missingItems, risks, nextGate}" />
                  </label>
                </>
              ) : null}
            </>
          ) : null}
          <div className="skill-draft-actions">
            <span>{isUpdate ? "升级包只解析安全摘要；当前版本不会被直接覆盖。" : `只登记 sourceRef、归属线索和安全摘要；${PACKAGE_INTAKE_NOTE}`}</span>
            <button className="primary-action" type="submit" disabled={isSubmitting}>
              {isSubmitting ? "提交中..." : isUpdate ? "提交升级预审" : copy.submitLabel}
            </button>
          </div>
        </form>
      ) : null}

      {error ? <p className="model-binding-note error-note">{error}</p> : null}
      {result ? (
          <div className="skill-draft-result">
          <strong>接入状态已创建：{result.jobId}</strong>
          <span>{result.contractVersion} · {result.status}</span>
          <p>
            已交给 {preReviewWorker} 自动预审核；{agentPreReviewCount} 个 Skill 评审稿已生成或阻断，{employeeDraftCount} 个员工状态、{skillDraftCount || result?.skillUpdateDrafts?.length || 0} 个 Skill 状态已进入后续门禁。
          </p>
          <div className="approval-action-buttons" role="group" aria-label="接入后续动作">
            <button className="ghost-action table-action" type="button" onClick={() => window.location.hash = "#skill-employee-review"}>
              查看技能/员工评审
            </button>
          </div>
          <SkillChips title="下一步" items={result.importJob?.installDecomposition?.nextGates || ["人员审批确认", "技能/员工评审确认"]} compact />
        </div>
      ) : null}
    </section>
  );
}

async function readPackageFile(file) {
  if (!file) return undefined;
  if (file.size > MAX_INLINE_PACKAGE_BYTES) {
    return {
      fileName: file.name,
      skipped: true,
      reason: "文件超过 10 MiB，本次只登记 sourceRef。",
    };
  }
  const base64 = await fileToBase64(file);
  return {
    fileName: file.name,
    mimeType: file.type || "application/octet-stream",
    size: file.size,
    base64,
  };
}

function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || "").replace(/^data:[^,]+,/, ""));
    reader.onerror = () => reject(reader.error || new Error("包文件读取失败"));
    reader.readAsDataURL(file);
  });
}
