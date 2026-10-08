export async function applyDigitalEmployeeLifecycle(employeeId, enabled) {
  const response = await fetch(`/api/digital-employees/${encodeURIComponent(employeeId)}/lifecycle`, {
    method: "PUT",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ enabled }),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || !data.ok) throw new Error(data.message || data.error || "数字员工状态保存失败");
  return data.digitalEmployee;
}

export function digitalEmployeeProductionReadinessView(employee = {}) {
  const readiness = employee.productionReadiness || {};
  const blockingGates = Array.isArray(readiness.blockingGates) ? readiness.blockingGates : [];
  const managed = readiness.managed === true;
  const ready = managed && readiness.autoOnlineEligible === true;
  return {
    managed,
    ready,
    label: ready ? "上线门禁已通过" : managed ? `${blockingGates.length} 项上线门禁待处理` : "上线门禁待接入",
    blockingGates,
    nextGate: readiness.nextGate || blockingGates[0]?.detail || "上线门禁状态尚未接入。",
  };
}

export function digitalEmployeeReadinessGateTarget(gate = {}) {
  const gateId = String(gate.id || "").trim();
  if (gate.actionRoute === "#skill-employee-review" || gateId === "personnel_approval") {
    return { viewId: "skillEmployeeReview", tabId: "" };
  }
  if (gate.actionRoute === "#employee-responsibilities" || gateId.startsWith("responsibility:")) return { viewId: "", tabId: "identity" };
  if (gateId === "model_binding" || gateId === "agent_runtime") return { viewId: "", tabId: "runtime" };
  if (gateId === "accountable_owner") return { viewId: "", tabId: "identity" };
  if (gateId.startsWith("skill:")) return { viewId: "", tabId: "skills" };
  if (gateId.startsWith("tool:")) return { viewId: "", tabId: "tools" };
  if (gateId.startsWith("schedule:")) return { viewId: "", tabId: "schedule" };
  if (gateId.startsWith("channel:")) return { viewId: "", tabId: "channels" };
  return { viewId: "", tabId: "overview" };
}
