import { Link2, Search, ShieldCheck } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { displaySkillStatus, displaySkillVersion, statusClass } from "../../lib/consoleCatalog";
import { fetchSkillMountRequests, postSkillMountRequest } from "../../lib/controlPlane";
import { employeeWithEffectiveMountedSkills } from "../../lib/digitalEmployeePackage";
import { SkillChips } from "../ConsolePrimitives";

const filterOptions = [
  { id: "recommended", label: "推荐" },
  { id: "all", label: "全部" },
  { id: "basic", label: "基础" },
  { id: "business", label: "专项" },
];

function normalizeText(value) {
  return String(value || "").trim().toLowerCase();
}

function skillKey(skill, kind) {
  return `${kind}:${skill.id}`;
}

function skillKindLabel(kind) {
  return kind === "platform_basic_skill" ? "基础 Skill" : "专项业务 Skill";
}

function skillSummary(skill = {}) {
  if (skill.description) return skill.description;
  if (skill.capabilities?.length) return `能力：${skill.capabilities.slice(0, 2).join("、")}`;
  if (skill.outputs?.length) return `输出：${skill.outputs.slice(0, 2).join("、")}`;
  return skill.reviewGate || "暂无摘要，提交前请确认 Skill 契约。";
}

function requestTone(status = "") {
  if (status.includes("驳回") || status.includes("失败")) return "bad";
  if (status.includes("生效") || status.includes("通过")) return "good";
  if (status.includes("待")) return "warn";
  return "muted";
}

function skillRiskTone(risk = "") {
  if (risk === "高") return "warn";
  if (risk === "中") return "info";
  if (risk === "低") return "good";
  return "muted";
}

function skillRiskLabel(skill = {}) {
  if (skill.risk) return `${skill.risk}风险`;
  if (skill.badcaseCount) return `${skill.badcaseCount} badcase`;
  return "常规";
}

function SkillSwitch({ checked }) {
  return (
    <span className={checked ? "channel-setting-switch is-on" : "channel-setting-switch"} aria-hidden="true">
      <i />
    </span>
  );
}

function directoryRefreshMessage(actionLabel) {
  return `${actionLabel}未提交：员工目录状态已变化，系统已刷新目录，请确认当前员工后重试。`;
}

function optionSearchText(option) {
  const skill = option.skill || {};
  return [
    skill.name,
    skill.id,
    displaySkillVersion(skill),
    skill.status,
    skill.domain,
    skill.department,
    skill.businessGroup,
    skill.sourceSkillId,
    ...(skill.capabilities || []),
    ...(skill.inputs || []),
    ...(skill.outputs || []),
  ].filter(Boolean).join(" ").toLowerCase();
}

function isRecommendedSkill(option, employee) {
  if (option.kind === "platform_basic_skill") return true;
  const skill = option.skill || {};
  const employeeDepartmentIds = [...new Set([employee.departmentId, employee.ownerDepartmentId, ...(Array.isArray(employee.departmentIds) ? employee.departmentIds : [])].filter(Boolean))];
  const employeeText = [
    employee.name,
    employee.title,
    employee.department,
    employee.objective,
    employee.skillPackage,
    ...(employee.capabilities || []),
    ...(employee.rules || []),
  ].filter(Boolean).join(" ").toLowerCase();
  return (
    employeeDepartmentIds.includes(skill.departmentId) ||
    employeeDepartmentIds.includes(skill.ownerDepartmentId) ||
    (skill.department && employeeText.includes(normalizeText(skill.department))) ||
    (skill.domain && employeeText.includes(normalizeText(skill.domain)))
  );
}

function buildOptions({ basicSkills = [], businessSkills = [], employee = {} }) {
  const mountedBasicIds = new Set(employee.basicSkillIds || []);
  const mountedBusinessIds = new Set(employee.businessSkillIds || []);
  const basic = basicSkills.map((skill) => ({
    kind: "platform_basic_skill",
    mounted: mountedBasicIds.has(skill.id),
    skill,
  }));
  const business = businessSkills.map((skill) => ({
    kind: "business_skill",
    mounted: mountedBusinessIds.has(skill.id),
    skill,
  }));
  return [...basic, ...business].map((option) => ({
    ...option,
    key: skillKey(option.skill, option.kind),
    recommended: isRecommendedSkill(option, employee),
  }));
}

export default function EmployeeSkillMountPanel({
  employee,
  basicSkills = [],
  businessSkills = [],
  isSystemAdmin = false,
  onMountChange = null,
}) {
  const [requests, setRequests] = useState([]);
  const [canManage, setCanManage] = useState(isSystemAdmin);
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState("recommended");
  const [reason, setReason] = useState("");
  const [expectedImpact, setExpectedImpact] = useState("");
  const [status, setStatus] = useState({ state: "idle", message: "" });
  const [pendingActionKey, setPendingActionKey] = useState("");

  const effectiveEmployee = useMemo(
    () => employeeWithEffectiveMountedSkills(employee, requests),
    [employee, requests],
  );
  const options = useMemo(
    () => buildOptions({ basicSkills, businessSkills, employee: effectiveEmployee }),
    [basicSkills, businessSkills, effectiveEmployee],
  );
  const mountedOptions = options.filter((option) => option.mounted);
  const candidateOptions = options.filter((option) => !option.mounted);
  const employeeRequests = requests
    .filter((request) => request.employeeId === employee.id)
    .slice(0, 4);
  const pendingCount = employeeRequests.filter((request) => request.status === "待管理员审核").length;

  const filteredCandidates = candidateOptions.filter((option) => {
    if (filter === "basic" && option.kind !== "platform_basic_skill") return false;
    if (filter === "business" && option.kind !== "business_skill") return false;
    if (filter === "recommended" && !option.recommended) return false;
    const text = normalizeText(query);
    return !text || optionSearchText(option).includes(text);
  });

  async function refreshRequests() {
    try {
      const data = await fetchSkillMountRequests();
      setRequests(Array.isArray(data.skillMountRequests) ? data.skillMountRequests : []);
      setCanManage(Boolean(data.canManage || isSystemAdmin));
    } catch (error) {
      setStatus({ state: "error", message: error?.message || "挂载变更读取失败" });
    }
  }

  useEffect(() => {
    refreshRequests();
  }, [employee.id]);

  function upsertRequest(nextRequest) {
    if (!nextRequest?.id) return;
    setRequests((current) => [nextRequest, ...current.filter((request) => request.id !== nextRequest.id)]);
  }

  function pendingRequestForOption(option, action) {
    return requests.find((request) => (
      request.employeeId === employee.id &&
      request.skillId === option.skill.id &&
      request.action === action &&
      request.status === "待管理员审核"
    ));
  }

  function requestPayload(action, option) {
    const actionLabel = action === "unmount" ? "取消挂载" : "挂载";
    return {
      action,
      employeeId: employee.id,
      skillId: option.skill.id,
      reason: reason.trim() || `${actionLabel} ${employee.name} 的 ${option.skill.name} 能力。`,
      impactSummary: `${employee.name} 的运行依赖、输出契约和调用门禁会随该能力变更复核。`,
      rollbackPlan: action === "unmount"
        ? "如质量指标下降或 owner 要求恢复，回到取消前的挂载关系。"
        : "如质量指标下降或 owner 要求回退，撤销本次新增挂载关系。",
      attributionPlan: {
        expectedImpact: expectedImpact.trim() || `观察 ${employee.name} 在该能力变更后的输出质量、人工退回率和 eval 结果。`,
      },
    };
  }

  async function submitMount(option) {
    const key = option.key;
    if (pendingRequestForOption(option, "mount")) return;
    setPendingActionKey(key);
    setStatus({ state: "saving", message: `正在提交开启能力：${option.skill.name}` });
    try {
      const data = await postSkillMountRequest(requestPayload("mount", option));
      upsertRequest(data.skillMountRequest);
      setReason("");
      setExpectedImpact("");
      setStatus({
        state: "ready",
        message: canManage ? "开启记录已写入后端并生效。" : "开启申请已提交到后端，等待管理员审核。",
      });
      await refreshRequests();
      await onMountChange?.();
    } catch (error) {
      if (error?.code === "digital_employee_not_found") {
        await onMountChange?.();
        setStatus({ state: "error", message: directoryRefreshMessage("开启") });
      } else {
        setStatus({ state: "error", message: error?.message || "挂载申请提交失败" });
      }
    } finally {
      setPendingActionKey("");
    }
  }

  async function submitUnmount(option) {
    const key = option.key;
    if (pendingRequestForOption(option, "unmount")) return;
    setPendingActionKey(key);
    setStatus({ state: "saving", message: `正在提交取消挂载：${option.skill.name}` });
    try {
      const data = await postSkillMountRequest(requestPayload("unmount", option));
      upsertRequest(data.skillMountRequest);
      setReason("");
      setExpectedImpact("");
      setStatus({
        state: "ready",
        message: canManage ? "关闭记录已写入后端并生效。" : "关闭申请已提交到后端，等待管理员审核。",
      });
      await refreshRequests();
      await onMountChange?.();
    } catch (error) {
      if (error?.code === "digital_employee_not_found") {
        await onMountChange?.();
        setStatus({ state: "error", message: directoryRefreshMessage("关闭") });
      } else {
        setStatus({ state: "error", message: error?.message || "取消挂载提交失败" });
      }
    } finally {
      setPendingActionKey("");
    }
  }

  return (
    <section className="model-binding-panel employee-skill-mount-panel">
      <div className="model-binding-head employee-skill-mount-head">
        <span className="model-binding-icon" aria-hidden="true">
          <ShieldCheck size={16} />
        </span>
        <div>
          <strong>技能开关</strong>
          <p>管理 {employee.name} 当前可用的基础能力和专项能力；飞书等普通对话入口默认继承这里的开关状态。</p>
        </div>
        <span className={`status-pill ${canManage ? "info" : "warn"}`}>
          {canManage ? "管理员直通" : "提交申请"}
        </span>
      </div>

      <div className="employee-skill-mount-summary">
        <span>
          <b>{mountedOptions.length}</b>
          已启用
        </span>
        <span>
          <b>{candidateOptions.length}</b>
          可开启
        </span>
        <span>
          <b>{pendingCount}</b>
          待审核
        </span>
      </div>

      <div className="employee-mounted-skills">
        <div className="employee-skill-block-title">
          <strong>当前开关</strong>
          <small>关闭能力会进入同一套审核和归因链路</small>
        </div>
        {mountedOptions.length ? (
          <div className="employee-mounted-skill-list">
            {mountedOptions.map((option) => {
              const pendingUnmountRequest = pendingRequestForOption(option, "unmount");
              const isSaving = pendingActionKey === option.key;
              return (
                <article className={pendingUnmountRequest ? "employee-mounted-skill is-pending" : "employee-mounted-skill"} key={option.key}>
                  <div className="employee-mounted-skill-copy">
                    <div className="employee-mounted-skill-title">
                      <strong>{option.skill.name}</strong>
                      <span className="employee-skill-enabled">
                        <SkillSwitch checked />
                        已启用
                      </span>
                    </div>
                    <div className="employee-skill-meta">
                      <span>{skillKindLabel(option.kind)}</span>
                      <span>{displaySkillVersion(option.skill)}</span>
                      <span className={`status-pill ${statusClass(option.skill.status)}`}>{displaySkillStatus(option.skill.status)}</span>
                      <span className={`employee-skill-risk is-${skillRiskTone(option.skill.risk)}`}>{skillRiskLabel(option.skill)}</span>
                    </div>
                    <p className="employee-skill-summary">{skillSummary(option.skill)}</p>
                  </div>
                  <button
                    className="tool-enable-toggle is-on employee-skill-switch-action"
                    type="button"
                    role="switch"
                    aria-checked="true"
                    aria-label={`${pendingUnmountRequest ? "等待关闭" : "关闭"} ${option.skill.name}`}
                    disabled={status.state === "saving" || Boolean(pendingUnmountRequest)}
                    onClick={() => submitUnmount(option)}
                    title={pendingUnmountRequest ? "关闭申请已提交，等待管理员审核" : "关闭 Skill 会提交挂载变更，并保留审核、回滚和归因记录"}
                  >
                    {isSaving ? "提交中" : pendingUnmountRequest ? "待关闭" : canManage ? "关闭" : "申请关闭"}
                  </button>
                </article>
              );
            })}
          </div>
        ) : (
          <p className="model-binding-note">当前后端目录没有显示已启用能力，可从下方直接开启推荐能力。</p>
        )}
      </div>

      <div className="employee-skill-add-panel">
        <div className="employee-skill-block-title">
          <strong>开启新能力</strong>
          <small>先搜索或筛选，再用单项开关提交当前 Skill</small>
        </div>
        <div className="employee-skill-toolbar">
          <label className="employee-skill-search">
            <Search size={15} />
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="搜索 Skill、能力、版本或来源"
            />
          </label>
          <div className="employee-skill-filter" role="group" aria-label="Skill 筛选">
            {filterOptions.map((item) => (
              <button
                key={item.id}
                className={filter === item.id ? "is-active" : ""}
                type="button"
                aria-pressed={filter === item.id}
                onClick={() => setFilter(item.id)}
              >
                {item.label}
              </button>
            ))}
          </div>
        </div>

        <div className="employee-skill-candidates">
          {filteredCandidates.length ? filteredCandidates.map((option) => {
            const pendingMountRequest = pendingRequestForOption(option, "mount");
            const isSaving = pendingActionKey === option.key;
            return (
              <article
                className={pendingMountRequest ? "employee-skill-candidate is-pending" : "employee-skill-candidate"}
                key={option.key}
              >
                <span className="employee-skill-candidate-copy">
                  <span className="employee-skill-candidate-title">
                    <strong>{option.skill.name}</strong>
                    {pendingMountRequest ? <em>待审批</em> : null}
                    {!pendingMountRequest && option.recommended ? <em>推荐</em> : null}
                  </span>
                  <span className="employee-skill-meta">
                    <span>{skillKindLabel(option.kind)}</span>
                    <span>{displaySkillVersion(option.skill)}</span>
                    <span className={`status-pill ${statusClass(option.skill.status)}`}>{displaySkillStatus(option.skill.status)}</span>
                    <span className={`employee-skill-risk is-${skillRiskTone(option.skill.risk)}`}>{skillRiskLabel(option.skill)}</span>
                  </span>
                  <p className="employee-skill-summary">{skillSummary(option.skill)}</p>
                </span>
                <button
                  className="tool-enable-toggle employee-skill-switch-action"
                  type="button"
                  role="switch"
                  aria-checked="false"
                  aria-label={`${pendingMountRequest ? "等待开启" : "开启"} ${option.skill.name}`}
                  disabled={status.state === "saving" || Boolean(pendingMountRequest)}
                  onClick={() => submitMount(option)}
                  title={pendingMountRequest ? "该能力开启申请已提交，等待管理员审核" : "开启当前 Skill"}
                >
                  {isSaving ? "提交中" : pendingMountRequest ? "待开启" : canManage ? "开启" : "申请开启"}
                </button>
              </article>
            );
          }) : (
            <p className="model-binding-note">没有匹配的可添加 Skill，换个搜索词或切到“全部”。</p>
          )}
        </div>

        <div className="employee-skill-mount-form">
          <label>
            变更说明
            <input value={reason} onChange={(event) => setReason(event.target.value)} placeholder="可选：会随下一次开启或关闭提交" />
          </label>
          <label>
            观察指标
            <input value={expectedImpact} onChange={(event) => setExpectedImpact(event.target.value)} placeholder="可选：预期改善、风险或观察窗口" />
          </label>
          <span className="employee-skill-inline-hint">
            <Link2 size={16} />
            每次开关只提交当前 Skill
          </span>
        </div>
      </div>

      {employeeRequests.length ? (
        <div className="employee-skill-request-strip">
          <div className="employee-skill-block-title">
            <strong>最近变更</strong>
            <small>只显示当前数字员工的挂载记录</small>
          </div>
          {employeeRequests.map((request) => (
            <div className="employee-skill-request" key={request.id}>
              <span className={`status-pill ${requestTone(request.status)}`}>{request.status}</span>
              <b>{request.actionLabel} / {request.skillName}</b>
              <small>{request.mountActionId || request.id}</small>
            </div>
          ))}
          <SkillChips title="归因指标" items={["P0/P1 未关闭数", "eval 通过率", "人工退回率"]} compact />
        </div>
      ) : null}

      <p className={`model-binding-note ${status.state === "error" ? "is-error" : ""}`} aria-live="polite">
        {status.message || (
          canManage
            ? "关闭和开启能力都在这里完成；管理员直通也会留下归因记录。"
            : "关闭和开启能力都在这里提交申请，管理员审核后才会生效。"
        )}
      </p>
    </section>
  );
}
