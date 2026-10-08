import { useState } from "react";
import { postToolBindingRequest } from "../../lib/controlPlane";

const risks = { controlled_write: "受控写入", high_impact_write: "高影响写入", destructive_write: "破坏性写入" };
export default function RegisteredToolPolicyPanel({ tool, employee, canManage, onChanged }) {
  const binding = (employee.toolBindings || employee.tools || []).find(item => (item.toolId || item.id) === tool.id) || {};
  const [selected, setSelected] = useState(binding.allowedCapabilities || []);
  const [allowedRisks, setAllowedRisks] = useState(binding.allowedRisks || []);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const policies = tool.capabilityPolicies || [];
  const availableRisks = [...new Set(policies.filter(policy => selected.includes(policy.capability))
    .flatMap(policy => policy.operations.map(operation => operation.risk)))].filter(risk => risks[risk]);
  function toggle(value, values, setter) { setter(values.includes(value) ? values.filter(item => item !== value) : [...values,value]); }
  async function save() {
    setBusy(true); setMessage("");
    try {
      await postToolBindingRequest({ action: "configure", employeeId: employee.id, toolId: tool.id, toolBindingId: tool.id,
        toolName: tool.displayName || tool.name, policyMode: "contract_capability", allowedOperations: [],
        allowedCapabilities: selected, allowedRisks: allowedRisks.filter(risk => availableRisks.includes(risk)),
        contractDigest: tool.contractDigest,
        approvedWritePolicyDigests: Object.fromEntries(policies.filter(policy => selected.includes(policy.capability)).map(policy => [policy.capability,policy.writePolicyDigest])),
        reason: "管理员按当前已发布合同配置员工能力与写入风险范围。",
        safeSummary: "合同摘要固定；目标系统权限、任务指令和逐次调用检查继续生效。",
        permissionBoundary: tool.permissionBoundary, credentialBoundary: tool.credentialBoundary, writebackBoundary: tool.writebackBoundary,
      });
      await onChanged?.(); setMessage("权限配置已保存并留痕；真实接口权限与调用结果仍需验收。");
    } catch (error) { setMessage(error.message || "权限保存失败"); }
    finally { setBusy(false); }
  }
  return <section className="employee-cockpit-section employee-tool-operation-policy">
    <div className="employee-config-section-head"><strong>{tool.displayName || tool.name} · 合同能力权限</strong></div>
    <p>选择可用能力；写操作另选风险范围。合同中的查询仍受目标权限检查，保存不会执行接口。</p>
    {policies.map(policy => <div key={policy.capability}>
      <label><input type="checkbox" checked={selected.includes(policy.capability)} disabled={!canManage || busy}
        onChange={() => toggle(policy.capability,selected,setSelected)} /> {policy.capability}</label>
      <ul>{policy.operations.map(operation => <li key={operation.operationId}>{operation.summary || operation.operationId} · {risks[operation.risk] || "只读"}</li>)}</ul>
    </div>)}
    <div className="employee-tool-operation-actions">{availableRisks.map(risk => <label key={risk}>
      <input type="checkbox" checked={allowedRisks.includes(risk)} disabled={!canManage || busy} onChange={() => toggle(risk,allowedRisks,setAllowedRisks)} />允许{risks[risk]}
    </label>)}</div>
    <p><small>合同摘要：{tool.contractDigest}</small></p>
    <button type="button" className="ghost-action" disabled={!canManage || busy || !selected.length} onClick={save}>保存能力权限</button>
    {message ? <p role="status">{message}</p> : null}
  </section>;
}
