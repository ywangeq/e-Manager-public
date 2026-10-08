import { ChevronDown, Code2 } from "lucide-react";
import { useState } from "react";

function jsonBlock(value) {
  return JSON.stringify(value, null, 2);
}

function skillSourceRef(skill) {
  if (skill.sourceSkillId) return skill.sourceSkillId;
  const kind = skill.domain ? "businessSkill" : "basicSkill";
  return `platform.${kind}:${skill.id}@${skill.version}`;
}

function requestPayloadFor(entity, kind) {
  const isEmployee = kind === "businessEmployee";
  return {
    sourceSystemId: "your-subsystem-id",
    sourceRequestId: `${isEmployee ? "EMP" : "SKILL"}-REQ-001`,
    requestType: isEmployee ? "business_digital_employee_application" : "platform_skill_application",
    departmentId: entity.departmentId || entity.ownerDepartmentId || "rd",
    businessDomain: entity.domain || "algorithm",
    capabilityName: entity.name,
    capabilityKind: isEmployee ? "业务数字员工" : entity.domain ? "主系统业务 Skill" : "主系统基础 Skill",
    ...(isEmployee
      ? { targetEmployeeId: entity.id }
      : {
          targetSkillId: entity.id,
          targetSourceRef: skillSourceRef(entity),
        }),
    requestedCapabilities: entity.capabilities?.length ? entity.capabilities.slice(0, 3) : [entity.description || entity.objective || "safe capability summary"],
    safeSummary: "只传脱敏能力申请摘要；不要传 raw prompt、私有 Skill payload、模型 trace、客户数据或凭证。",
  };
}

function invocationPayloadFor(entity, kind, runtimeEmployeeId = "") {
  const isEmployee = kind === "businessEmployee";
  return {
    callerSystemId: "your-subsystem-id",
    employeeId: isEmployee ? entity.id : runtimeEmployeeId || "approved-business-employee-id",
    ...(isEmployee ? {} : { skillId: entity.id }),
    departmentId: entity.departmentId || entity.ownerDepartmentId || "rd",
    businessDomain: entity.domain || "algorithm",
    action: "draft",
    modelId: "gpt-5.5",
    modelLevelId: "medium",
    confidence: 0.86,
    currentUsage: {
      callsToday: 0,
      callsThisHour: 0,
      concurrentRuns: 0,
    },
  };
}

function curlExample(endpoint, payload) {
  return `curl -X POST "$DW_API_BASE${endpoint}" \\
  -H "Content-Type: application/json" \\
  -H "Authorization: Bearer $DW_SERVICE_TOKEN" \\
  --data @- <<'JSON'
${JSON.stringify(payload, null, 2)}
JSON`;
}

function fetchExample(endpoint, payload) {
  return `const response = await fetch(\`\${DW_API_BASE}${endpoint}\`, {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    Authorization: \`Bearer \${DW_SERVICE_TOKEN}\`,
  },
  body: JSON.stringify(${jsonBlock(payload)}),
});

const result = await response.json();`;
}

function safePanelId(entity, kind) {
  return `api-access-${kind}-${String(entity.id || entity.name || "entity").replace(/[^a-zA-Z0-9_-]+/g, "-")}`;
}

export default function ApiAccessPanel({ entity, kind, runtimeEmployeeId = "", defaultOpen = false }) {
  const [isOpen, setIsOpen] = useState(defaultOpen);
  const requestPayload = requestPayloadFor(entity, kind);
  const invocationPayload = invocationPayloadFor(entity, kind, runtimeEmployeeId);
  const isEmployee = kind === "businessEmployee";
  const panelBodyId = safePanelId(entity, kind);

  return (
    <section className={isOpen ? "api-access-panel is-open" : "api-access-panel is-collapsed"} aria-label={`${entity.name} API 接入示例`}>
      <button
        className="api-access-head api-access-toggle"
        type="button"
        aria-expanded={isOpen}
        aria-controls={panelBodyId}
        onClick={() => setIsOpen((current) => !current)}
      >
        <span className="model-binding-icon" aria-hidden="true">
          <Code2 size={16} />
        </span>
        <div>
          <span className="eyebrow">API Access</span>
          <strong>{entity.name} 接入代码示例</strong>
          <p>
            子系统先创建治理申请；审批和分发完成后，运行前只调用门禁检查。这里不直接执行模型或工具。
          </p>
        </div>
        <span className="api-access-head-actions">
          <span className="status-pill muted">{isEmployee ? "业务数字员工" : "Skill"}</span>
          <span className="api-access-toggle-label">
            {isOpen ? "收起" : "展开"}
            <ChevronDown size={15} />
          </span>
        </span>
      </button>

      {isOpen ? (
        <div className="api-access-body" id={panelBodyId}>
          <div className="api-access-grid">
            <div>
              <strong>1. 创建能力申请</strong>
              <span>后端服务调用，生成待平台评审草案。</span>
              <pre><code>{curlExample("/api/control-plane/capability-requests", requestPayload)}</code></pre>
            </div>
            <div>
              <strong>2. 调用前门禁检查</strong>
              <span>审批通过并配置调用策略后，执行前检查 caller、动作、模型、额度和质量阈值。</span>
              <pre><code>{fetchExample("/api/control-plane/invocation-checks", invocationPayload)}</code></pre>
            </div>
          </div>
        </div>
      ) : null}
    </section>
  );
}
