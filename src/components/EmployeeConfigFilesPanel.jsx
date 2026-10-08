import { BookOpen, CheckCircle2, Copy, FileText, PencilLine, RotateCcw, Save, ShieldCheck } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { basicSkills, businessSkills as catalogBusinessSkills } from "../data/catalog";
import { employeeChannels } from "../lib/digitalEmployeeOverview";

const CONFIG_FILE_DEFS = [
  { id: "agents", name: "AGENTS", fileName: "AGENTS.md", group: "角色与身份", summary: "主行为约束与协作边界", impact: "高影响" },
  { id: "soul", name: "SOUL", fileName: "SOUL.md", group: "角色与身份", summary: "人格、语气与判断方式", impact: "高影响" },
  { id: "identity", name: "IDENTITY", fileName: "IDENTITY.md", group: "角色与身份", summary: "名称、主键、归属和版本", impact: "中影响" },
  { id: "channels", name: "CHANNELS", fileName: "CHANNELS.md", group: "入口与分发", summary: "入口、回复策略和分发边界", impact: "高影响" },
  { id: "runtime", name: "RUNTIME", fileName: "RUNTIME.md", group: "运行与策略", summary: "模型、Worker、Key 和运行模式", impact: "高影响" },
  { id: "skills", name: "SKILLS", fileName: "SKILLS.md", group: "运行与策略", summary: "挂载技能、版本和审核门禁", impact: "高影响" },
  { id: "tools", name: "TOOLS", fileName: "TOOLS.md", group: "运行与策略", summary: "执行工具、连接器、API 与密钥边界", impact: "高影响" },
  { id: "schedule", name: "SCHEDULE", fileName: "SCHEDULE.md", group: "运行与策略", summary: "定时任务和触发门禁", impact: "中影响" },
  { id: "quality", name: "QUALITY", fileName: "QUALITY.md", group: "质量与发布", summary: "质量门禁、badcase 和 eval 边界", impact: "高影响" },
  { id: "distribution", name: "DISTRIBUTION", fileName: "DISTRIBUTION.md", group: "质量与发布", summary: "发布、包下载和业务系统调用", impact: "高影响" },
  { id: "user", name: "USER", fileName: "USER.md", group: "记忆与偏好", summary: "可服务对象和可见范围", impact: "中影响" },
  { id: "memory", name: "MEMORY", fileName: "MEMORY.md", group: "记忆与偏好", summary: "长期记忆事实和禁存边界", impact: "低影响" },
];

function listLines(items = [], fallback = "待补齐") {
  const normalized = items.filter(Boolean);
  return normalized.length ? normalized.map((item) => `- ${item}`).join("\n") : `- ${fallback}`;
}

function toolDisplayName(tool) {
  if (tool && typeof tool === "object") return tool.name || tool.label || tool.id || "";
  return String(tool || "").trim();
}

function toolConfigLine(tool, source = "工具") {
  if (tool && typeof tool === "object") {
    const name = toolDisplayName(tool);
    const status = tool.status || "已声明";
    const enabled = tool.enabled === false ? "开关关闭" : tool.enabled === true ? "开关打开" : "开关未声明";
    const kind = tool.kind || "执行工具";
    const credential = tool.credentialBoundary || "server_only";
    return `${source}: ${name} / ${kind} / ${status} / ${enabled} / ${credential}`;
  }
  return `${source}: ${toolDisplayName(tool)}`;
}

function statusForDoc(doc, employee = {}) {
  if (doc.id === "memory" && !employee.memoryPolicy) return "待补齐";
  if (doc.id === "skills" && !(employee.basicSkillIds?.length || employee.businessSkillIds?.length)) return "待挂载";
  if (doc.id === "tools" && !(employee.tools?.length || employee.toolBindings?.length)) return "待声明";
  if (doc.id === "runtime" && !(employee.runtimeBinding || employee.modelBinding)) return "待绑定";
  if (doc.id === "schedule" && !(employee.cronTasks?.length || employee.scheduledTasks?.length || employee.runtimeSchedules?.length)) return "待配置";
  if (doc.id === "distribution" && !(employee.apiEndpoints?.length || employee.downloadUrl || employee.packageIncludes?.length)) return "待分发";
  if (doc.id === "quality" && !(employee.outputContract || employee.reviewGate || employee.reviewOutputSpec)) return "待补齐";
  return "已生成";
}

function statusTone(status = "") {
  if (status === "已生成") return "good";
  if (status.startsWith("待") || status === "草案") return "warn";
  return "muted";
}

function markdownTitle(employee = {}, doc) {
  return `# ${employee.name || "数字员工"} / ${doc.fileName}`;
}

function skillLookup() {
  return new Map([...basicSkills, ...catalogBusinessSkills].map((skill) => [skill.id, skill]));
}

function mountedSkillDetails(employee = {}) {
  const skillsById = skillLookup();
  return [
    ...(employee.basicSkillIds || []).map((skillId) => ({ kind: "基础 Skill", skillId })),
    ...(employee.businessSkillIds || []).map((skillId) => ({ kind: "业务 Skill", skillId })),
  ].map(({ kind, skillId }) => {
    const skill = skillsById.get(skillId) || {};
    return {
      kind,
      id: skill.id || skillId,
      name: skill.name || skillId,
      status: skill.status || "待确认",
      version: skill.version || "待确认",
      reviewGate: skill.reviewGate || "Skill owner 审核",
    };
  });
}

function buildConfigDocuments({ employee = {}, basicSkillNames = [], businessSkillNames = [], promptConfig = {}, modelBinding = {} }) {
  const channels = employeeChannels(employee);
  const mountedSkills = mountedSkillDetails(employee);
  const toolLines = [
    ...(employee.toolBindings || []).map((tool) => toolConfigLine(tool, "员工工具绑定")),
    ...(employee.tools || []).map((tool) => toolConfigLine(tool, "员工工具声明")),
  ];
  const runtimeBinding = employee.runtimeBinding || {};
  const scheduleItems = [
    ...(employee.cronTasks || []),
    ...(employee.scheduledTasks || []),
    ...(employee.runtimeSchedules || []),
  ];
  const scheduleLines = scheduleItems.length
    ? scheduleItems.map((item) => item.name || item.title || item.id || String(item))
    : ["目录未声明定时任务；生产调度需补 RBAC、审计、回滚和质量门禁。"];
  const distributionLines = [
    employee.permissionSummary || employee.permissionScope,
    employee.apiEndpoints?.length ? "业务系统调用前必须经过 capability request 与 invocation check。" : "暂未声明外部 API 调用入口。",
    employee.downloadUrl || employee.packageIncludes?.length ? "能力包只携带声明与安装材料；治理记录留在平台。" : "暂未发布可下载能力包。",
    employee.level === "系统级" ? "系统级员工不进入业务系统可申请目录。" : "业务级员工可在权限范围内被业务系统申请。",
  ].filter(Boolean);

  return CONFIG_FILE_DEFS.map((doc) => {
    const status = statusForDoc(doc, employee);
    const context = {
      title: markdownTitle(employee, doc),
      identity: [
        `- employeeId: ${employee.id || "待配置"}`,
        `- 名称: ${employee.name || "待命名"}`,
        `- 岗位: ${employee.title || "待配置"}`,
        `- 部门: ${employee.department || "待配置"}`,
        `- owner: ${employee.owner || "待指定"}`,
        `- permissionScope: ${employee.permissionScope || "待配置"}`,
        `- status: ${employee.status || "待配置"}`,
        `- entityVersion: ${employee.version || "待配置"}`,
        `- promptVersion: ${promptConfig.promptVersion || employee.promptVersion || "待配置"}`,
      ].join("\n"),
      skills: [
        ...mountedSkills.map((skill) => `- ${skill.kind}: ${skill.name} / ${skill.version} / ${skill.status} / ${skill.reviewGate}`),
        ...(!mountedSkills.length ? [...basicSkillNames.map((name) => `- 基础 Skill: ${name}`), ...businessSkillNames.map((name) => `- 专项 Skill: ${name}`)] : []),
      ].join("\n") || "- 待挂载 Skill",
      tools: listLines(toolLines, "待声明真实工具"),
      constraints: listLines(employee.constraints || [], "按部门权限、人工复核和质量门禁执行"),
      capabilities: listLines(employee.capabilities?.length ? employee.capabilities : [employee.objective], "待补齐能力声明"),
      unsupported: listLines(employee.unsupportedActions || [], "不得绕过 RBAC、人审、审计和质量门禁"),
      api: listLines(employee.apiEndpoints || [], "暂无对外 API"),
      prompt: [
        `- scope: ${promptConfig.promptScope || employee.promptScope || "待配置"}`,
        `- hash: ${promptConfig.promptHash || "待生成"}`,
        `- keys: ${(promptConfig.promptKeys || []).join(", ") || "待配置"}`,
        `- rawPromptStored: ${promptConfig.rawPromptStored ? "true" : "false"}`,
      ].join("\n"),
      runtime: [
        `- model: ${modelBinding.model || "未绑定"}`,
        `- reasoning: ${modelBinding.modelLevelLabel || "未配置"}`,
        `- runtimeAdapter: ${runtimeBinding.runtimeAdapter || modelBinding.runtimeAdapter || "由控制面分配"}`,
        `- workerLane: ${runtimeBinding.workerLane || modelBinding.workerLane || runtimeBinding.assignedAiWorker || "由控制面分配"}`,
        `- maxParallelWorkers: ${runtimeBinding.maxParallelWorkers || modelBinding.maxParallelWorkers || runtimeBinding.reservedWorkerSlots || "1"}`,
        `- taskBufferQueueSize: ${runtimeBinding.taskBufferQueueSize || modelBinding.taskBufferQueueSize || runtimeBinding.maxBufferedTasks || "0"}`,
        `- taskBufferMinutes: ${runtimeBinding.taskBufferMinutes || modelBinding.taskBufferMinutes || "240"}`,
        `- providerRoute: ${modelBinding.providerRouteId || runtimeBinding.providerRouteId || runtimeBinding.preferredProviderRouteId || modelBinding.preferredProviderRouteId || "server-side lease"}`,
        `- keyVisibility: ${runtimeBinding.keyVisibility || "server_only"}`,
        `- defaultMode: ${runtimeBinding.defaultMode || modelBinding.defaultMode || "review_or_controlled_execution"}`,
      ].join("\n"),
      channels: listLines(channels, "管理台"),
      schedule: listLines(scheduleLines, "目录未声明定时任务"),
      distribution: listLines(distributionLines, "待声明分发边界"),
      quality: [
        `- openBadcases: ${employee.quality?.openBadcases ?? 0}`,
        `- rootCauseFocus: ${employee.quality?.rootCauseFocus || "待补齐"}`,
        `- outputContract: ${employee.outputContract || "待声明输出契约"}`,
        `- reviewGate: ${employee.reviewGate || promptConfig.promptReviewGate || "负责人确认后生效"}`,
        `- reviewOutputSpec: ${employee.reviewOutputSpec?.contractVersion || "待声明"}`,
      ].join("\n"),
    };

    const contentById = {
      agents: `${context.title}\n\n## 使命\n${employee.objective || "待补齐员工使命。"}\n\n## 行为边界\n${context.constraints}\n\n## 不支持动作\n${context.unsupported}\n\n## 输出契约\n- ${employee.outputContract || "待声明输出契约"}\n\n## 审核门禁\n- ${employee.reviewGate || promptConfig.promptReviewGate || "负责人确认后生效"}`,
      soul: `${context.title}\n\n## 角色核心\n- 面向岗位和部门目标服务，不替代负责人决策。\n- 先解释权限范围，再输出建议或草案。\n- 不保存 raw prompt、模型 trace、执行 payload、客户数据或员工 PII。\n\n## 可处理工作\n${context.capabilities}\n\n## 语言风格\n- 清晰、克制、可追溯。\n- 结论先行，证据和门禁随后。\n- 对不确定信息标记待确认。`,
      identity: `${context.title}\n\n## 身份字段\n${context.identity}\n\n## Prompt 元数据\n${context.prompt}\n\n## 权限说明\n- ${employee.permissionSummary || "待配置权限说明"}`,
      channels: `${context.title}\n\n## 配置来源\n- Channel 是结构化入口配置，CHANNELS.md 是面向人审、交接和导出包的可读说明。\n- 真实调用必须读取 channelBindings / distribution / invocation policy 等结构化字段，而不是解析 Markdown。\n\n## 入口范围\n${context.channels}\n\n## 回复与调用策略\n- 管理台配置和审核优先走 L2 控制面。\n- 飞书、IM 或业务系统入口只能作为 L1 触发，不替代权限、质量和版本门禁。\n- 群聊、单聊、API、业务系统分发都必须声明可见范围、调用人、输出契约和人工复核点。\n\n## 分发边界\n${context.distribution}`,
      runtime: `${context.title}\n\n## Runtime Binding\n${context.runtime}\n\n## 运行依赖上下文\n- digital-employee-runtime-dependency-context.v2\n- 注入身份、Prompt 元数据、显式 Skill 作用域、可调用 Skills、工具、输出契约、审核门禁和不支持动作。\n- 不注入 raw prompt、provider key、模型 trace、执行 payload、客户数据或员工 PII。`,
      skills: `${context.title}\n\n## 已挂载 Skills\n${context.skills}\n\n## Skill 与 Tool 边界\n- Skill 是能力模块，承载 Prompt 元数据、输入输出、版本、owner 和审核门禁。\n- Tool 是执行手段，不等同于 Skill；工具明细进入 TOOLS.md。\n- 挂载或取消挂载 Skill 必须走 mountActionId、依赖闭包、回滚和质量归因。`,
      tools: `${context.title}\n\n## 执行工具\n${context.tools}\n\n## API 边界\n${context.api}\n\n## Runtime / Key\n${context.runtime}\n\n## Tool 与其他对象边界\n- API 文档、下载包、来源系统和可申请开关不是工具本身。\n- Skill.tools 不会因为 Skill 挂载而自动成为员工 Tool。\n- 工具调用必须受 employee 权限、Skill 审核状态和 invocation check 约束。\n- 生产写回、远程执行、代码发布和客户承诺必须进入人工门禁。`,
      schedule: `${context.title}\n\n## 触发与定时任务\n${context.schedule}\n\n## 任务门禁\n- 定时任务必须声明触发人或服务账号、可见范围、输出契约、失败回滚和质量观察指标。\n- 生产调度不得绕过 L2 invocation check、L5 本地 RBAC 和人工复核。\n- 未声明 schedule 的员工只允许手动治理或评审草案模式。`,
      quality: `${context.title}\n\n## 质量状态\n${context.quality}\n\n## Badcase 边界\n- 只保存安全摘要、错误码、影响范围、root cause 和复盘动作。\n- 不保存 raw prompt、完整 AI payload、模型 trace、客户数据、员工 PII 或生产执行记录。\n\n## Eval / 回归\n- Prompt、Skill、Runtime 或渠道变更后，应以 mountActionId、employeeVersion、promptVersion 关联质量观察。`,
      distribution: `${context.title}\n\n## 分发目标\n${context.distribution}\n\n## 包与平台记录边界\n- 下载包只携带能力声明、安装说明和可选验收步骤。\n- 治理审批、eval、badcase、分发历史、运行审计和 ops 历史由平台闭环保存。\n- 正式上线、扩权、回滚和停用必须形成可审查记录。`,
      user: `${context.title}\n\n## 可服务对象\n- 部门: ${employee.department || "待配置"}\n- 负责人: ${employee.owner || "待指定"}\n- 可用范围: ${employee.permissionSummary || employee.permissionScope || "待配置"}\n\n## 用户请求处理\n- 先判断请求人是否在可用范围。\n- 跨部门、生产写回、下载分发和高风险动作进入人审。\n- 输出只包含安全摘要和下一步门禁。`,
      memory: `${context.title}\n\n## 可记忆事实\n- 员工使命、owner、版本、权限范围、已审核 Skill 和质量状态。\n- badcase 只保存安全摘要、错误码、影响范围和复盘结论。\n\n## 禁止写入\n- raw prompt\n- provider key / token\n- 模型 trace 或完整执行 payload\n- 客户数据、员工 PII、业务系统原文\n\n## 当前长期记忆\n${listLines(employee.memoryPolicy?.safeFacts || [], "待创建长期记忆策略")}`,
    };

    return {
      ...doc,
      status,
      content: contentById[doc.id],
    };
  });
}

function validationRows(employee = {}, basicSkillNames = [], businessSkillNames = [], promptConfig = {}) {
  return [
    ["身份", Boolean(employee.id && employee.name && employee.owner)],
    ["权限", Boolean(employee.permissionScope && employee.permissionSummary)],
    ["技能", basicSkillNames.length + businessSkillNames.length > 0],
    ["工具", Boolean(employee.tools?.length || employee.toolBindings?.length)],
    ["渠道", employeeChannels(employee).length > 0],
    ["运行", Boolean(employee.modelBinding || employee.runtimeBinding)],
    ["Prompt", Boolean(promptConfig.promptVersion && promptConfig.promptScope)],
    ["边界", Boolean(employee.constraints?.length || employee.unsupportedActions?.length)],
    ["输出契约", Boolean(employee.outputContract || employee.reviewOutputSpec)],
    ["质量", Boolean(employee.quality || employee.reviewGate || employee.reviewOutputSpec)],
  ];
}

export default function EmployeeConfigFilesPanel({
  employee,
  basicSkillNames = [],
  businessSkillNames = [],
  promptConfig = {},
  modelBinding = {},
  isSystemAdmin = false,
}) {
  const documents = useMemo(
    () => buildConfigDocuments({ employee, basicSkillNames, businessSkillNames, promptConfig, modelBinding }),
    [employee, basicSkillNames, businessSkillNames, promptConfig, modelBinding],
  );
  const [activeId, setActiveId] = useState("soul");
  const [drafts, setDrafts] = useState({});
  const [editorText, setEditorText] = useState("");
  const [changeNote, setChangeNote] = useState("");
  const [isEditing, setIsEditing] = useState(isSystemAdmin);
  const [statusMessage, setStatusMessage] = useState("");
  const activeDoc = documents.find((doc) => doc.id === activeId) || documents[0];
  const draft = drafts[activeId];
  const displayedContent = draft?.content || activeDoc.content;
  const groupedDocuments = documents.reduce((groups, doc) => {
    groups[doc.group] = groups[doc.group] || [];
    groups[doc.group].push(doc);
    return groups;
  }, {});
  const validations = validationRows(employee, basicSkillNames, businessSkillNames, promptConfig);

  useEffect(() => {
    setEditorText(draft?.content || activeDoc.content);
    setChangeNote(draft?.note || "");
    setStatusMessage("");
  }, [activeDoc.id, activeDoc.content, draft?.content, draft?.note]);

  function saveDraft() {
    if (!isSystemAdmin) return;
    setDrafts((current) => ({
      ...current,
      [activeId]: {
        content: editorText,
        note: changeNote.trim(),
        updatedAt: new Date().toLocaleString("zh-CN", { hour12: false }),
      },
    }));
    setStatusMessage(`${activeDoc.fileName} 草案已保存`);
  }

  function resetDraft() {
    setDrafts((current) => {
      const next = { ...current };
      delete next[activeId];
      return next;
    });
    setEditorText(activeDoc.content);
    setChangeNote("");
    setStatusMessage(`${activeDoc.fileName} 已恢复目录配置`);
  }

  async function copyDocument() {
    try {
      await navigator.clipboard?.writeText(editorText || displayedContent);
      setStatusMessage(`${activeDoc.fileName} 已复制`);
    } catch {
      setStatusMessage("当前浏览器不支持自动复制");
    }
  }

  return (
    <section className="employee-config-files-panel">
      <div className="config-workbench-head">
        <span className="model-binding-icon" aria-hidden="true">
          <BookOpen size={16} />
        </span>
        <div>
          <strong>配置文件工作台</strong>
          <p>{employee.name} 的 11 个治理文档对象，覆盖身份、入口、运行、质量、分发与记忆。</p>
        </div>
        <span className={`status-pill ${Object.keys(drafts).length ? "warn" : "info"}`}>
          {Object.keys(drafts).length ? `${Object.keys(drafts).length} 个草案` : "目录配置"}
        </span>
      </div>

      <div className="config-workbench-grid">
        <aside className="config-doc-list" aria-label="配置文件目录">
          {Object.entries(groupedDocuments).map(([group, items]) => (
            <div className="config-doc-group" key={group}>
              <span>{group}</span>
              {items.map((doc) => (
                <button
                  className={activeId === doc.id ? "config-doc-item is-active" : "config-doc-item"}
                  type="button"
                  key={doc.id}
                  onClick={() => setActiveId(doc.id)}
                >
                  <span>
                    <strong>{doc.name}</strong>
                    <small>{doc.fileName}</small>
                    <em>{doc.summary}</em>
                  </span>
                  <b className={`status-pill ${statusTone(drafts[doc.id] ? "草案" : doc.status)}`}>
                    {drafts[doc.id] ? "草案" : doc.status}
                  </b>
                </button>
              ))}
            </div>
          ))}
        </aside>

        <section className="config-doc-editor">
          <div className="config-doc-editor-head">
            <span className="config-doc-title">
              <FileText size={16} />
              <strong>{activeDoc.fileName}</strong>
              <small>{activeDoc.impact}</small>
            </span>
            <span className="config-doc-actions-inline">
              <button
                className={isEditing ? "table-action config-doc-pill-action config-doc-pill-blue is-active" : "table-action config-doc-pill-action config-doc-pill-blue"}
                type="button"
                disabled={!isSystemAdmin}
                onClick={() => setIsEditing((current) => !current)}
              >
                <PencilLine size={14} />
                {isEditing ? "编辑中" : "编辑"}
              </button>
              <button className="table-action config-doc-pill-action config-doc-pill-yellow" type="button" onClick={copyDocument}>
                <Copy size={14} />
                复制
              </button>
            </span>
          </div>

          <div className="config-doc-meta" aria-label="当前配置文件元信息">
            <span>
              <b>分组</b>
              {activeDoc.group}
            </span>
            <span>
              <b>摘要</b>
              {activeDoc.summary}
            </span>
            <span>
              <b>草案</b>
              {draft?.updatedAt || "未保存"}
            </span>
          </div>

          {isEditing ? (
            <textarea
              className="config-doc-textarea"
              value={editorText}
              disabled={!isSystemAdmin}
              onChange={(event) => setEditorText(event.target.value)}
            />
          ) : (
            <pre className="config-doc-preview">{displayedContent}</pre>
          )}

          <label className="config-change-note">
            变更说明
            <input
              value={changeNote}
              disabled={!isSystemAdmin}
              onChange={(event) => setChangeNote(event.target.value)}
              placeholder="例如：补齐 HR 复核边界、收敛工具权限、更新 SOUL 语气"
            />
          </label>

          <div className="config-doc-actions">
            <span>{statusMessage || (isSystemAdmin ? "保存后形成会话治理草案，正式发布仍需后端审计与审批。" : "当前账号仅可查看配置文件。")}</span>
            <button className="table-action config-doc-pill-action config-doc-pill-red" type="button" disabled={!isSystemAdmin} onClick={resetDraft}>
              <RotateCcw size={14} />
              重置
            </button>
            <button className="table-action config-doc-pill-action config-doc-pill-green" type="button" disabled={!isSystemAdmin} onClick={saveDraft}>
              <Save size={15} />
              保存草案
            </button>
          </div>
        </section>
      </div>

      <div className="config-validation-strip">
        {validations.map(([label, ok]) => (
          <span className={ok ? "is-ok" : "is-missing"} key={label}>
            {ok ? <CheckCircle2 size={14} /> : <ShieldCheck size={14} />}
            {label}
          </span>
        ))}
      </div>
    </section>
  );
}
