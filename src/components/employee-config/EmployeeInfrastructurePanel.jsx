import { CheckCircle2, Cpu, RefreshCw, ServerCog, ShieldAlert } from "lucide-react";
import { useEffect, useState } from "react";

const scopeOptions = [
  { id: "sdk_smoke", label: "SDK 冒烟" },
  { id: "algorithm_inference", label: "算法推理" },
  { id: "gpu_training", label: "GPU 训练" },
  { id: "object_storage_mount", label: "对象存储挂载" },
];

const scopeLabelById = new Map(scopeOptions.map((option) => [option.id, option.label]));
const infrastructureErrorMessages = {
  digital_employee_not_found: "员工目录状态已变化，请返回员工列表确认后重试。",
};

export default function EmployeeInfrastructurePanel({ employee }) {
  const [state, setState] = useState({ status: "loading", data: null, error: "" });
  const [saving, setSaving] = useState(false);
  const [feedback, setFeedback] = useState({ type: "", message: "" });

  function load() {
    setState((current) => ({ ...current, status: "loading", error: "" }));
    fetch(`/api/runtime-infrastructure?employeeId=${encodeURIComponent(employee.id)}`, { credentials: "include" })
      .then(async (response) => {
        const data = await response.json().catch(() => ({}));
        if (!response.ok) throw infrastructureRequestError(data, "运行基础设施读取失败");
        setState({ status: "ready", data, error: "" });
      })
      .catch((error) => setState({ status: "error", data: null, error: error.message || "运行基础设施读取失败" }));
  }

  useEffect(() => {
    load();
  }, [employee.id]);

  const data = state.data || {};
  const canManage = Boolean(data.canManage);
  const bindings = Array.isArray(data.bindings) ? data.bindings : [];
  const infrastructure = Array.isArray(data.infrastructure) ? data.infrastructure : [];
  const bindingByInfrastructureId = new Map(bindings.map((binding) => [binding.infrastructureId, binding]));
  const resourceRows = canManage
    ? infrastructure.map((item) => ({ infrastructure: item, binding: bindingByInfrastructureId.get(item.id) || null }))
    : bindings.map((binding) => ({
        infrastructure: {
          id: binding.infrastructureId,
          name: binding.infrastructureName,
          kind: binding.infrastructureKind,
          status: binding.infrastructureStatus,
          accountMasked: binding.accountMasked,
          gpuTotal: binding.gpuTotal,
          gpuAvailable: binding.gpuAvailable,
        },
        binding,
      }));

  async function toggleBinding(row) {
    if (!canManage || !row.infrastructure?.id) return;
    setSaving(true);
    setFeedback({ type: "", message: "" });
    try {
      const binding = row.binding;
      const nextEnabled = !binding || binding.enabled === false;
      if (binding) {
        await requestJson(
          `/api/runtime-infrastructure/${encodeURIComponent(row.infrastructure.id)}/bindings/${encodeURIComponent(binding.id)}`,
          "PATCH",
          { enabled: nextEnabled },
        );
      } else {
        await requestJson(`/api/runtime-infrastructure/${encodeURIComponent(row.infrastructure.id)}/bindings`, "POST", {
          employeeId: employee.id,
          enabled: true,
          executionScopes: defaultScopesForKind(row.infrastructure.kind),
          gpuLimit: row.infrastructure.kind === "cluster" ? 1 : 0,
          concurrencyLimit: 1,
        });
      }
      setFeedback({
        type: "success",
        message: nextEnabled ? "已为该数字员工启用这台已登记设备。" : "已关闭该数字员工对这台设备的使用。",
      });
      load();
    } catch (error) {
      setFeedback({ type: "error", message: error.message || "设备开关更新失败。" });
    } finally {
      setSaving(false);
    }
  }

  async function reprobe(binding) {
    setSaving(true);
    setFeedback({ type: "", message: "" });
    try {
      const result = await postJson(`/api/runtime-infrastructure/${encodeURIComponent(binding.infrastructureId)}/probe`, {}, { allowFailure: true });
      setFeedback({
        type: result.ok ? "success" : "error",
        message: result.ok ? "管理员只读联通测试通过。" : result.message || "联通测试失败。",
      });
      load();
    } catch (error) {
      setFeedback({ type: "error", message: error.message || "联通测试失败。" });
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className="runtime-infrastructure-panel">
      <div className="runtime-infrastructure-head">
        <span>
          <strong>已登记设备</strong>
          <small>这里不登记新资源，只为该数字员工启用或关闭总管理已登记的 Remote / 集群。</small>
        </span>
        <span className="status-pill info">{canManage ? "管理员可配置" : "只读"}</span>
      </div>

      {state.status === "error" ? (
        <div className="runtime-infrastructure-empty is-error">
          <ShieldAlert size={18} />
          <span><strong>基础设施读取失败</strong><small>{state.error}</small></span>
        </div>
      ) : null}

      {state.status !== "error" && !resourceRows.length ? (
        <div className="runtime-infrastructure-empty">
          <ServerCog size={18} />
          <span>
            <strong>还没有可选设备</strong>
            <small>{canManage ? "请先在总管理的运行基础设施页登记 Remote 或集群，再回到这里为员工开启。" : "当前员工没有可查看的 Remote 或集群绑定。"}</small>
          </span>
        </div>
      ) : null}

      {resourceRows.length ? (
        <div className="runtime-infrastructure-binding-list">
          <div className="runtime-infrastructure-binding-list-head">
            <strong>可用设备开关</strong>
            <small>{bindings.filter((binding) => binding.enabled !== false).length} 项已启用</small>
          </div>
          {resourceRows.map((row) => {
            const binding = row.binding;
            const item = row.infrastructure;
            const enabled = Boolean(binding && binding.enabled !== false);
            return (
            <article className={enabled ? "runtime-infrastructure-binding is-enabled" : "runtime-infrastructure-binding is-disabled"} key={binding?.id || item.id}>
              <div className="runtime-infrastructure-binding-main">
                <span className="runtime-infrastructure-type"><Cpu size={15} />{item.kind === "cluster" ? "集群" : "Remote"}</span>
                <strong>{item.name}</strong>
                <small>{binding?.accountMasked || item.accountMasked || "待联通后回填"} · GPU {bindingGpuCapacityLabel(binding || item)}</small>
              </div>
              <div className="runtime-infrastructure-binding-state">
                <span className={`status-pill ${enabled ? "good" : "muted"}`}>{enabled ? "已启用" : "已关闭"}</span>
                <small>连接：{infrastructureStatusLabel(binding?.infrastructureStatus || item.status)}</small>
              </div>
              <div className="runtime-infrastructure-binding-detail">
                <span>{binding ? (binding.executionScopes || []).map((scope) => scopeLabelById.get(scope) || scope).join(" / ") : defaultScopesForKind(item.kind).map((scope) => scopeLabelById.get(scope) || scope).join(" / ")}</span>
                <small>{binding ? `${bindingExecutionLimitLabel(binding)} · 并发 ${binding.concurrencyLimit || 1}` : "未绑定到该员工"}</small>
              </div>
              {canManage ? (
                <div className="runtime-infrastructure-binding-actions">
                  <button
                    className={enabled ? "runtime-infrastructure-switch is-on" : "runtime-infrastructure-switch"}
                    type="button"
                    role="switch"
                    aria-checked={enabled}
                    onClick={() => toggleBinding(row)}
                    disabled={saving}
                  >
                    <i />
                    <span>{enabled ? "开" : "关"}</span>
                  </button>
                  <button className="icon-action" type="button" title="重新联通测试" aria-label={`重新测试 ${item.name}`} onClick={() => reprobe({ infrastructureId: item.id })} disabled={saving || !binding}>
                    <RefreshCw size={15} />
                  </button>
                </div>
              ) : null}
            </article>
            );
          })}
        </div>
      ) : null}

      {feedback.message ? (
        <p
          className={`runtime-infrastructure-feedback ${feedback.type === "error" ? "is-error" : ""}`}
          role={feedback.type === "error" ? "alert" : "status"}
        >
          {feedback.type === "error" ? <ShieldAlert size={15} /> : <CheckCircle2 size={15} />}
          {feedback.message}
        </p>
      ) : null}
    </section>
  );
}

async function requestJson(path, method, body, { allowFailure = false } = {}) {
  const response = await fetch(path, {
    method,
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok && !allowFailure) throw infrastructureRequestError(data, "操作失败");
  return { ...data, ok: response.ok && data.ok !== false };
}

function infrastructureRequestError(data, fallback) {
  const error = new Error(data.message || infrastructureErrorMessages[data.error] || data.error || fallback);
  error.code = data.error || "runtime_infrastructure_request_failed";
  return error;
}

async function postJson(path, body, options) {
  return requestJson(path, "POST", body, options);
}

function infrastructureStatusLabel(status) {
  return { available: "设施可用", blocked: "联通失败", pending_probe: "待联通测试" }[status] || "待联通测试";
}

function bindingGpuCapacityLabel(binding) {
  const kind = binding.infrastructureKind || binding.kind;
  const status = binding.infrastructureStatus || binding.status;
  if (kind === "cluster" && status === "available" && !binding.gpuTotal) return "按任务申请";
  return `${binding.gpuAvailable}/${binding.gpuTotal || "-"}`;
}

function bindingExecutionLimitLabel(binding) {
  const gpuLimit = Number(binding.gpuLimit || 0);
  if (gpuLimit > 0) return `最多 ${gpuLimit} GPU`;
  return "GPU 按任务申请";
}

function defaultScopesForKind(kind) {
  return kind === "cluster" ? ["gpu_training", "object_storage_mount"] : ["sdk_smoke", "algorithm_inference"];
}
