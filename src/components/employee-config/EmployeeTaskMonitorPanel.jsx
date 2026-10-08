import { AlertTriangle, CheckCircle2, CircleStop, ClipboardList, Cpu, Eye, MessageSquare, RefreshCw, Search, ShieldCheck, ThumbsUp, X } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { RUNTIME_EVIDENCE_NOT_PROJECTED, runtimeModelEvidenceCopy, sortRuntimeTasksLatestFirst } from "../../lib/runtimeTasks";
import { useEmployeeRuntimeTasks } from "./EmployeeRuntimeTasksContext";

const statusFilters = [
  { value: "all", label: "全部状态" },
  { value: "active", label: "处理中" },
  { value: "success", label: "已完成" },
  { value: "not_executed", label: "未执行" },
  { value: "failed", label: "失败" },
];

const sourceFilters = [
  { value: "all", label: "全部来源" },
  { value: "desktop", label: "桌面端" },
  { value: "feishu", label: "飞书" },
  { value: "management_console", label: "管理台" },
  { value: "trigger", label: "Trigger" },
  { value: "schedule", label: "系统定时任务" },
  { value: "api", label: "API" },
  { value: "employee", label: "员工间调用" },
];

export default function EmployeeTaskMonitorPanel({ employee }) {
  const endpoint = employee.id ? `/api/digital-employees/${encodeURIComponent(employee.id)}/runtime-tasks` : "";
  const { state, refresh: loadTasks, loadMore, replaceTask } = useEmployeeRuntimeTasks();
  const [filters, setFilters] = useState({ query: "", status: "all", source: "all" });
  const [selectedTaskId, setSelectedTaskId] = useState("");
  const [isDetailOpen, setIsDetailOpen] = useState(false);
  const [detailTab, setDetailTab] = useState("summary");
  const [actionState, setActionState] = useState(null);
  const [cancelingTaskId, setCancelingTaskId] = useState("");
  const [submittingFeedbackKey, setSubmittingFeedbackKey] = useState("");

  async function submitTaskFeedback(task, rating) {
    if (!endpoint || !task?.id || !rating) return;
    const feedbackKey = `${task.id}:${rating}`;
    setSubmittingFeedbackKey(feedbackKey);
    setActionState({ taskId: task.id, status: "loading", message: "正在记录反馈。" });
    try {
      const response = await fetch(`${endpoint}/${encodeURIComponent(task.id)}/feedback`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          expectedRevision: task.revision,
          idempotencyKey: `runtime-task-feedback:${task.id}:${task.revision}:${rating}`,
          rating,
          reasonCode: rating === "not_helpful" ? "other" : "",
        }),
      });
      const result = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(result.message || result.error || "反馈记录失败");
      if (result.task) replaceTask(result.task);
      setActionState({
        taskId: task.id,
        status: "done",
        message: result.message || (rating === "not_helpful" ? "已记录问题反馈。" : "已记录质量 OK。"),
      });
    } catch (error) {
      setActionState({ taskId: task.id, status: "error", message: error.message || "反馈记录失败" });
    } finally {
      setSubmittingFeedbackKey("");
    }
  }

  async function cancelTask(task) {
    if (!endpoint || !task?.id || !task.canCancel) return;
    if (!window.confirm(`确认取消任务 ${task.id}？运行器会在最近的安全边界停止。`)) return;
    setCancelingTaskId(task.id);
    setActionState({ taskId: task.id, status: "loading", message: "正在取消任务。" });
    try {
      const response = await fetch(`${endpoint}/${encodeURIComponent(task.id)}/cancel`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reasonCode: "operator_requested" }),
      });
      const result = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(result.message || result.error || "任务取消失败");
      if (result.task) replaceTask(result.task);
      setActionState({ taskId: task.id, status: "done", message: result.message || "任务已取消。" });
    } catch (error) {
      setActionState({ taskId: task.id, status: "error", message: error.message || "任务取消失败" });
    } finally {
      setCancelingTaskId("");
    }
  }

  const data = state.data || {};
  const canCancelTasks = Boolean(data.runtime?.canCancelTasks);
  const taskRows = useMemo(() => {
    const tasks = Array.isArray(data.tasks) ? data.tasks : [];
    const canSubmitTaskFeedback = data.runtime?.canSubmitTaskFeedback !== false;
    return sortRuntimeTasksLatestFirst(tasks).map((task) => {
      const row = normalizeTaskRow(task);
      return { ...row, feedbackCanSubmit: row.feedbackCanSubmit && canSubmitTaskFeedback };
    });
  }, [data.runtime?.canSubmitTaskFeedback, data.tasks]);
  const filteredTasks = useMemo(() => filterTaskRows(taskRows, filters), [taskRows, filters]);
  const selectedTask = filteredTasks.find((task) => task.id === selectedTaskId) || filteredTasks[0] || null;
  const metrics = taskMonitorMetrics(taskRows, data.page);
  const isLoading = state.status === "loading";

  useEffect(() => {
    if (!filteredTasks.length) {
      setSelectedTaskId("");
      setIsDetailOpen(false);
      return;
    }
    if (!filteredTasks.some((task) => task.id === selectedTaskId)) {
      setSelectedTaskId(filteredTasks[0].id);
    }
  }, [filteredTasks, selectedTaskId]);

  function openTaskDetail(task, tab = "summary") {
    if (!task?.id) return;
    setSelectedTaskId(task.id);
    setDetailTab(tab);
    setIsDetailOpen(true);
  }

  if (!endpoint) {
    return (
      <section className="employee-task-monitor">
        <TaskMonitorHeader employee={employee} isLoading={false} onRefresh={loadTasks} />
        <div className="employee-task-monitor-empty">
          <ClipboardList size={18} />
          <span>
            <strong>任务记录待接入</strong>
            <small>接入任务记录来源后，这里会显示任务来源、状态、结果和闭环。</small>
          </span>
        </div>
      </section>
    );
  }

  return (
    <section className="employee-task-monitor">
      <TaskMonitorHeader employee={employee} isLoading={isLoading} onRefresh={loadTasks} />

      {state.status === "error" ? (
        <div className="employee-task-monitor-empty is-error">
          <AlertTriangle size={18} />
          <span>
            <strong>任务监控读取失败</strong>
            <small>{state.error}</small>
          </span>
        </div>
      ) : null}

      <div className="employee-task-monitor-metrics" aria-label={`${employee.name} 任务监控指标`}>
        {metrics.map((metric) => (
          <span key={metric.label}>
            <small>{metric.label}</small>
            <strong>{metric.value}</strong>
            <em>{metric.detail}</em>
          </span>
        ))}
      </div>

      <div className="employee-task-monitor-toolbar">
        <label className="employee-task-monitor-search">
          <Search size={15} />
          <input
            value={filters.query}
            placeholder="搜索任务、合同编号、安全摘要、提出人"
            onChange={(event) => setFilters((current) => ({ ...current, query: event.target.value }))}
          />
        </label>
        <select value={filters.status} onChange={(event) => setFilters((current) => ({ ...current, status: event.target.value }))}>
          {statusFilters.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
        </select>
        <select value={filters.source} onChange={(event) => setFilters((current) => ({ ...current, source: event.target.value }))}>
          {sourceFilters.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
        </select>
      </div>

      {!taskRows.length && state.status !== "error" ? (
        <div className="employee-task-monitor-empty">
          <ClipboardList size={18} />
          <span>
            <strong>暂无任务记录</strong>
            <small>收到飞书消息、系统调用或手动任务后，这里会生成安全摘要任务；不会保存用户原话。</small>
          </span>
        </div>
      ) : null}

      {taskRows.length ? (
        <div className="employee-task-monitor-workbench">
          <div
            className="employee-task-monitor-table-shell"
            role="region"
            tabIndex={0}
            aria-label={`${employee.name} 任务台账，可滚动查看更多任务`}
          >
            <div className="employee-task-monitor-section-title">
              <strong>任务台账</strong>
              <small>按任务、业务编号、状态、执行证据和反馈入口快速扫描。</small>
            </div>
            <table className="employee-task-monitor-grid-table">
              <thead>
                <tr>
                  <th>任务</th>
                  <th>状态</th>
                  <th>来源</th>
                  <th>业务编号</th>
                  <th>结果</th>
                  <th>Agent 证据</th>
                  <th>反馈</th>
                  <th>更新</th>
                  <th>详情</th>
                </tr>
              </thead>
              <tbody>
                {filteredTasks.map((task) => (
                  <tr
                    className={task.id === selectedTask?.id ? "employee-task-monitor-table-row is-active" : "employee-task-monitor-table-row"}
                    key={task.id}
                    tabIndex={0}
                    onClick={() => openTaskDetail(task)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter" || event.key === " ") {
                        event.preventDefault();
                        openTaskDetail(task);
                      }
                    }}
                  >
                    <td>
                      <span className="employee-task-monitor-primary">
                        <strong>{task.title}</strong>
                        <small>{task.id} · {task.typeLabel}</small>
                      </span>
                    </td>
                    <td><StatusCapsule tone={task.tone}>{task.statusLabel}</StatusCapsule></td>
                    <td>
                      <span className="employee-task-monitor-stack">
                        <strong>{task.sourceLabel}</strong>
                        <small>{task.requesterLabel}</small>
                      </span>
                    </td>
                    <td>
                      <span className="employee-task-monitor-stack">
                        <strong>{task.businessReferenceValue || "—"}</strong>
                        <small>{task.businessReferenceValue
                          ? `${task.businessReferenceLabel} · ${task.businessReferenceSource}`
                          : "本任务无业务编号"}</small>
                      </span>
                    </td>
                    <td>
                      <span className="employee-task-monitor-stack">
                        <strong>{task.resultLabel}</strong>
                        <small>{task.resultReason}</small>
                      </span>
                    </td>
                    <td>
                      <span className="employee-task-monitor-stack">
                        <EvidenceText tone={task.runtimeEvidence.tone}>{task.runtimeEvidence.statusLabel}</EvidenceText>
                        <small>{task.runtimeEvidence.requestLabel}</small>
                      </span>
                    </td>
                    <td>
                      <span className="employee-task-monitor-stack">
                        <StatusCapsule tone={task.feedbackTone}>{task.feedbackActionLabel}</StatusCapsule>
                        <small>{task.feedbackActionDetail || task.closureLabel}</small>
                      </span>
                    </td>
                    <td>
                      <span className="employee-task-monitor-stack">
                        <strong>{task.updatedAtLabel || "未记录"}</strong>
                        <small>{task.receivedAtLabel ? `收到 ${task.receivedAtLabel}` : "等待时间戳"}</small>
                      </span>
                    </td>
                    <td>
                      <button
                        className="employee-task-monitor-row-action"
                        type="button"
                        onClick={(event) => {
                          event.stopPropagation();
                          openTaskDetail(task);
                        }}
                      >
                        <Eye size={14} />
                        查看
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {!filteredTasks.length ? (
            <div className="employee-task-monitor-empty">
              <Search size={18} />
              <span>
                <strong>没有匹配任务</strong>
                <small>换一个状态、来源或搜索词再看。</small>
              </span>
            </div>
          ) : null}

          {data.page?.hasMore ? (
            <button className="ghost-action" type="button" onClick={loadMore} disabled={state.isLoadingMore}>
              <RefreshCw size={15} />
              {state.isLoadingMore ? "载入中" : "加载更多任务"}
            </button>
          ) : null}

          {selectedTask && isDetailOpen ? (
            <TaskDetailDrawer
              detailTab={detailTab}
              task={selectedTask}
              actionState={actionState?.taskId === selectedTask?.id ? actionState : null}
              canCancel={canCancelTasks && selectedTask.canCancel}
              isCanceling={cancelingTaskId === selectedTask.id}
              submittingFeedbackKey={submittingFeedbackKey}
              onChangeTab={setDetailTab}
              onClose={() => setIsDetailOpen(false)}
              onCancel={cancelTask}
              onFeedback={submitTaskFeedback}
            />
          ) : null}
        </div>
      ) : null}

      <p className="employee-task-monitor-boundary">
        监控只展示安全摘要、经身份目录解析的提出人、状态和闭环建议；仅 system:* 管理员可看到加密展示投影中的业务编号。用户原话、模型内部推理细节、执行明细、远程日志、合同正文和客户文件不进入这里。
      </p>
    </section>
  );
}

function TaskMonitorHeader({ employee, isLoading, onRefresh }) {
  return (
    <div className="employee-task-monitor-head">
      <span>
        <strong>任务监控</strong>
        <small>{employee.name} 的任务来源、状态、结果和质量闭环台账。</small>
      </span>
      <button className="ghost-action" type="button" onClick={onRefresh} disabled={isLoading}>
        <RefreshCw size={15} />
        {isLoading ? "刷新中" : "刷新"}
      </button>
    </div>
  );
}

const detailTabs = [
  { id: "summary", label: "对话摘要" },
  { id: "process", label: "执行过程" },
  { id: "resources", label: "资源工具" },
  { id: "feedback", label: "反馈闭环" },
];

function TaskDetailDrawer({ task, detailTab, actionState, canCancel, isCanceling, submittingFeedbackKey, onChangeTab, onClose, onCancel, onFeedback }) {
  if (!task) return null;
  return createPortal(
    <div className="employee-task-monitor-drawer-backdrop" role="presentation" onClick={onClose}>
      <aside
        className="employee-task-monitor-drawer"
        role="dialog"
        aria-modal="true"
        aria-label={`${task.title} 任务详情`}
        onClick={(event) => event.stopPropagation()}
      >
        <div className="employee-task-monitor-drawer-head">
          <span>
            <strong>{task.title}</strong>
            <small>{task.id} · {task.typeLabel}</small>
          </span>
          <div className="employee-task-monitor-drawer-actions">
            <StatusCapsule tone={task.tone}>{task.statusLabel}</StatusCapsule>
            {canCancel ? (
              <button
                className="is-warn"
                type="button"
                disabled={isCanceling}
                title="取消任务"
                aria-label="取消任务"
                onClick={() => onCancel?.(task)}
              >
                <CircleStop size={16} />
              </button>
            ) : null}
            <button type="button" onClick={onClose} aria-label="关闭任务详情">
              <X size={16} />
            </button>
          </div>
        </div>

        <div className="employee-task-monitor-drawer-tabs" role="tablist" aria-label="任务详情切换">
          {detailTabs.map((tab) => (
            <button
              className={detailTab === tab.id ? "is-active" : ""}
              key={tab.id}
              type="button"
              role="tab"
              aria-selected={detailTab === tab.id}
              onClick={() => onChangeTab(tab.id)}
            >
              {tab.label}
            </button>
          ))}
        </div>

        {detailTab === "summary" ? <TaskSummaryTab task={task} /> : null}
        {detailTab === "process" ? <TaskProcessTab task={task} /> : null}
        {detailTab === "resources" ? <TaskResourcesTab task={task} /> : null}
        {detailTab === "feedback" ? (
          <TaskFeedbackTab
            task={task}
            actionState={actionState}
            submittingFeedbackKey={submittingFeedbackKey}
            onFeedback={onFeedback}
          />
        ) : null}
      </aside>
    </div>,
    document.querySelector(".console-shell") || document.body,
  );
}

function TaskSummaryTab({ task }) {
  const rows = [
    { label: "本轮意图", value: task.turnIntentLabel },
    { label: "回复策略", value: task.responsePolicyLabel },
    { label: "来源", value: task.sourceLabel },
    { label: "提出人", value: task.requesterLabel },
    ...(task.businessReferenceValue ? [{ label: task.businessReferenceLabel, value: task.businessReferenceValue }] : []),
    { label: "结果", value: task.resultLabel, tone: task.tone },
    { label: "用户反馈", value: task.feedbackLabel, tone: task.feedbackTone },
    { label: "闭环", value: task.closureLabel, tone: task.feedbackTone || task.tone },
    { label: "未执行原因", value: task.notExecutedReason || "不适用", tone: task.notExecutedReason ? task.tone : "muted" },
    { label: "收到", value: task.receivedAtLabel },
    { label: "更新", value: task.updatedAtLabel },
  ];
  return (
    <div className="employee-task-monitor-drawer-panel">
      <div className="employee-task-monitor-summary">
        <strong>用户问题安全摘要</strong>
        <p>{task.summary || "等待任务摘要。"}</p>
      </div>
      <div className="employee-task-monitor-detail-grid">
        {rows.map((row) => <TaskDetailValue key={row.label} {...row} />)}
      </div>
    </div>
  );
}

function TaskProcessTab({ task }) {
  return (
    <div className="employee-task-monitor-drawer-panel">
      <RuntimeEvidence evidence={task.runtimeEvidence} />
      <div className="employee-task-monitor-timeline">
        {task.timeline.map((step) => (
          <span key={`${step.label}-${step.time}`}>
            <i />
            <b>{step.label}</b>
            <small>{step.time || "未记录"}</small>
            <em>{step.detail}</em>
          </span>
        ))}
      </div>
    </div>
  );
}

function TaskResourcesTab({ task }) {
  const rows = [
    { label: "资源", value: task.resourceLabel },
    { label: "材料", value: task.materialLabel },
    { label: "工具/Skill 结果", value: task.runtimeEvidence.processingLabel },
    { label: "工具调用", value: task.runtimeEvidence.toolLabel },
    { label: "模型/等级", value: task.runtimeEvidence.modelLabel },
    { label: "Runtime Adapter", value: task.runtimeEvidence.adapterLabel },
    { label: "用量", value: task.runtimeEvidence.usageLabel },
    {
      label: "阻断/说明",
      value: task.runtimeEvidence.blockedReason || task.runtimeEvidence.statusLabel,
      tone: task.runtimeEvidence.blockedReason ? "warn" : task.runtimeEvidence.tone,
      evidence: true,
    },
  ];
  return (
    <div className="employee-task-monitor-drawer-panel">
      <div className="employee-task-monitor-detail-grid">
        {rows.map((row) => <TaskDetailValue key={row.label} {...row} />)}
      </div>
      <div className="employee-task-monitor-next">
        <ShieldCheck size={16} />
        <span>
          <strong>下一步</strong>
          <small>{task.nextGate || task.closureLabel}</small>
        </span>
      </div>
    </div>
  );
}

function TaskFeedbackTab({ task, actionState, submittingFeedbackKey, onFeedback }) {
  return (
    <div className="employee-task-monitor-drawer-panel">
      <TaskFeedbackPanel
        task={task}
        actionState={actionState}
        submittingFeedbackKey={submittingFeedbackKey}
        onFeedback={onFeedback}
      />
      <div className="employee-task-monitor-next">
        <ShieldCheck size={16} />
        <span>
          <strong>闭环建议</strong>
          <small>{task.nextGate || task.closureLabel}</small>
        </span>
      </div>
    </div>
  );
}

function TaskFeedbackPanel({ task, actionState, submittingFeedbackKey, onFeedback }) {
  const disabled = !task.feedbackCanSubmit || Boolean(submittingFeedbackKey);
  const okKey = `${task.id}:helpful`;
  const issueKey = `${task.id}:not_helpful`;
  return (
    <div className="employee-task-monitor-feedback">
      <div className="employee-task-monitor-feedback-head">
        <MessageSquare size={16} />
        <span>
          <strong>回答质量反馈</strong>
          <small>{task.feedbackActionDetail || task.closureLabel}</small>
        </span>
      </div>
      <div className="employee-task-monitor-feedback-state">
        <span>
          <small>当前状态</small>
          <StatusCapsule tone={task.feedbackTone}>{task.feedbackLabel}</StatusCapsule>
        </span>
        <span>
          <small>入口</small>
          <StatusCapsule tone={task.feedbackTone}>{task.feedbackActionLabel}</StatusCapsule>
        </span>
      </div>
      <div className="employee-task-monitor-feedback-actions">
        <button
          className="ghost-action is-good"
          type="button"
          disabled={disabled}
          onClick={() => onFeedback?.(task, "helpful")}
        >
          <ThumbsUp size={15} />
          {submittingFeedbackKey === okKey ? "记录中" : "质量 OK"}
        </button>
        <button
          className="ghost-action is-warn"
          type="button"
          disabled={disabled}
          onClick={() => onFeedback?.(task, "not_helpful")}
        >
          <AlertTriangle size={15} />
          {submittingFeedbackKey === issueKey ? "记录中" : "存在问题"}
        </button>
      </div>
      {actionState?.message ? (
        <p className={`employee-task-monitor-feedback-note is-${actionState.status}`} role="status">
          {actionState.status === "done" ? <CheckCircle2 size={14} /> : null}
          {actionState.message}
        </p>
      ) : null}
      {!task.feedbackCanSubmit ? (
        <p className="employee-task-monitor-feedback-note">
          {task.feedbackSubmitted
            ? "该任务已记录反馈；如需继续处理，请在质量复盘里推进。"
            : task.statusGroup === "success"
              ? "该任务来源尚未接入质量反馈写回。"
              : "任务未完成前不开放回答质量反馈。"}
        </p>
      ) : null}
    </div>
  );
}

function RuntimeEvidence({ evidence }) {
  const rows = [
    { label: "执行摘要", value: evidence.primarySummary },
    { label: "工具/Skill 结果", value: evidence.processingLabel },
    { label: "模型请求", value: evidence.requestLabel, tone: evidence.tone, evidence: true },
    { label: "模型/等级", value: evidence.modelLabel },
    { label: "Runtime Adapter", value: evidence.adapterLabel },
    { label: "工具调用", value: evidence.toolLabel },
    { label: "用量", value: evidence.usageLabel },
    { label: "阻断/说明", value: evidence.blockedReason || evidence.statusLabel, tone: evidence.blockedReason ? "warn" : evidence.tone, evidence: true },
  ];
  return (
    <div className={evidence.hasEvidence ? "employee-task-monitor-runtime" : "employee-task-monitor-runtime is-empty"}>
      <div className="employee-task-monitor-runtime-head">
        <Cpu size={16} />
        <span>
          <strong>Agent Runtime 证据</strong>
          <EvidenceText tone={evidence.tone}>{evidence.hasEvidence ? evidence.statusLabel : "未记录执行、工具或模型证据"}</EvidenceText>
        </span>
      </div>
      <div className="employee-task-monitor-runtime-grid">
        {rows.map((row) => <TaskDetailValue key={row.label} {...row} />)}
      </div>
    </div>
  );
}

function TaskDetailValue({ label, value, tone, evidence = false }) {
  return (
    <span>
      <small>{label}</small>
      {evidence ? <EvidenceText tone={tone}>{value || "未记录"}</EvidenceText> : tone ? <StatusCapsule tone={tone}>{value || "未记录"}</StatusCapsule> : <b>{value || "未记录"}</b>}
    </span>
  );
}

function StatusCapsule({ tone = "muted", children }) {
  return <em className={`status-pill employee-task-monitor-status ${tone || "muted"}`}>{children || "未记录"}</em>;
}

function EvidenceText({ tone = "muted", children }) {
  return <strong className={`employee-task-monitor-evidence ${tone || "muted"}`}>{children || "未记录"}</strong>;
}

function normalizeTaskRow(task = {}) {
  const outcome = taskOutcome(task);
  const source = taskSource(task);
  const feedback = taskFeedbackSummary(task);
  const runtimeEvidence = taskRuntimeEvidence(task);
  const submittedAt = task.submittedAt || task.trigger?.receivedAt || "";
  const updatedAt = task.updatedAt || submittedAt;
  const resourceIds = Array.isArray(task.requiredResourceIds) ? task.requiredResourceIds : [];
  const materialRefs = Array.isArray(task.materialRefs) ? task.materialRefs : [];
  const notExecutedReason = outcome.key === "not_executed" ? outcome.reason : "";
  const turnIntentLabel = taskTurnIntentLabel(task.turnIntent, task);
  const responsePolicyLabel = taskResponsePolicyLabel(task.responsePolicy, task);
  const businessReferenceValue = String(task.businessReference?.value || "").trim();
  const businessReferenceLabel = String(task.businessReference?.label || "业务编号").trim() || "业务编号";
  const businessReferenceSource = String(task.businessReference?.sourceField || "").trim();
  return {
    id: String(task.id || "TASK-UNKNOWN"),
    revision: Number.isSafeInteger(Number(task.revision)) && Number(task.revision) > 0
      ? Number(task.revision)
      : null,
    title: task.taskTitle || task.title || "数字员工任务",
    typeLabel: taskTypeLabel(task.taskType),
    summary: task.problemSummary || "",
    turnIntentLabel,
    responsePolicyLabel,
    correlationId: task.correlationId || "",
    status: task.status || "received",
    canCancel: ["queued", "received", "running", "retrying", "pending_file_intake", "pending_remote_resource", "pending_invocation_check"].includes(task.status),
    statusLabel: task.statusLabel || outcome.statusLabel,
    statusGroup: outcome.group,
    tone: outcome.tone,
    sourceKey: source.key,
    sourceLabel: source.label,
    requesterLabel: source.requester,
    businessReferenceLabel,
    businessReferenceSource,
    businessReferenceValue,
    resultLabel: outcome.resultLabel,
    resultReason: runtimeEvidence.primarySummary || outcome.reason,
    feedbackLabel: feedback.label,
    feedbackTone: feedback.tone || "muted",
    feedbackActionLabel: feedback.actionLabel,
    feedbackActionDetail: feedback.actionDetail,
    feedbackCanSubmit: feedback.canSubmit && outcome.group === "success",
    feedbackSubmitted: feedback.submitted,
    notExecutedReason,
    resourceLabel: resourceIds.length ? resourceIds.map(resourceLabel).join(" / ") : "按任务自动判断",
    materialLabel: materialRefs.length ? materialRefs.map(materialLabel).join(" / ") : "无文件材料",
    runtimeEvidence,
    closureLabel: feedback.closureLabel || closureLabel(outcome.key),
    nextGate: task.nextGate || task.invocationCheck?.nextGate || "",
    receivedAtLabel: formatTime(task.trigger?.receivedAt || submittedAt),
    updatedAtLabel: formatTime(updatedAt),
    submittedAt,
    updatedAt,
    searchText: [
      task.id,
      task.taskTitle,
      task.problemSummary,
      task.statusLabel,
      task.status,
      task.turnIntent,
      task.responsePolicy?.id,
      task.responsePolicy?.mode,
      task.runtimeAdapter,
      source.label,
      source.requester,
      businessReferenceLabel,
      businessReferenceSource,
      businessReferenceValue,
      outcome.resultLabel,
      outcome.reason,
      feedback.label,
      feedback.closureLabel,
      feedback.actionLabel,
      feedback.actionDetail,
      runtimeEvidence.searchText,
      task.nextGate,
    ].filter(Boolean).join(" ").toLowerCase(),
    timeline: taskTimeline(task, outcome, source, feedback, runtimeEvidence),
  };
}

function filterTaskRows(tasks, filters) {
  const query = String(filters.query || "").trim().toLowerCase();
  return tasks.filter((task) => {
    if (filters.status !== "all" && task.statusGroup !== filters.status) return false;
    if (filters.source !== "all" && task.sourceKey !== filters.source) return false;
    if (query && !task.searchText.includes(query)) return false;
    return true;
  });
}

function taskMonitorMetrics(tasks, page = null) {
  const count = (group) => tasks.filter((task) => task.statusGroup === group).length;
  return [
    { label: "任务总数", value: tasks.length, detail: page?.hasMore ? "已载入最近任务，可继续加载" : "安全摘要台账" },
    { label: "处理中", value: count("active"), detail: "已接收/排队/运行" },
    { label: "已完成", value: count("success"), detail: "可进入反馈闭环" },
    { label: "未执行", value: count("not_executed"), detail: "原始消息未成任务或被阻断" },
    { label: "失败", value: count("failed"), detail: "可转 badcase" },
  ];
}

function taskOutcome(task = {}) {
  const status = String(task.status || "received");
  const reason = humanizeReason(task.invocationCheck?.nextGate || task.nextGate || task.invocationCheck?.reason || "");
  if (status === "completed") {
    const feedback = taskFeedbackSummary(task);
    return {
      key: "success",
      group: "success",
      tone: "good",
      statusLabel: "已完成",
      resultLabel: feedback.resultLabel || "任务成功",
      reason: feedback.resultReason || "等待用户反馈或归档。",
    };
  }
  if (status === "failed") {
    return { key: "failed", group: "failed", tone: "bad", statusLabel: "失败", resultLabel: "任务失败", reason: reason || "等待转 badcase 或复盘。" };
  }
  if (["blocked", "human_review_required", "canceled", "not_executed", "raw_unrecognized", "ignored_raw"].includes(status)) {
    return {
      key: "not_executed",
      group: "not_executed",
      tone: status === "canceled" ? "muted" : "warn",
      statusLabel: status === "canceled" ? "已取消" : "未执行",
      resultLabel: "未执行",
      reason: notExecutedReasonLabel(status, reason),
    };
  }
  if (status === "queue_full") {
    return { key: "not_executed", group: "not_executed", tone: "warn", statusLabel: "队列已满", resultLabel: "未接收", reason: reason || "并行 worker 和最大排队数已满，任务未进入处理队列。" };
  }
  if (status === "timeout") {
    return { key: "not_executed", group: "not_executed", tone: "warn", statusLabel: "已超时", resultLabel: "任务超时", reason: reason || "任务超过既有超时边界，等待复盘或重新提交。" };
  }
  if (status === "pending_remote_resource") {
    return { key: "active", group: "active", tone: "warn", statusLabel: "待资源", resultLabel: "未执行：等待资源", reason: reason || "运行资源未就绪。" };
  }
  if (status === "pending_file_intake") {
    return { key: "active", group: "active", tone: "warn", statusLabel: "待文件接入", resultLabel: "未执行：等待文件", reason: reason || "文件资料服务未完成接入。" };
  }
  if (["queued", "running", "pending_invocation_check", "received", "retrying"].includes(status)) {
    const label = { queued: "排队中", running: "处理中", retrying: "重试中", pending_invocation_check: "已接收", received: "已接收" }[status] || "已接收";
    return { key: "active", group: "active", tone: status === "running" ? "info" : "warn", statusLabel: label, resultLabel: "处理中", reason: reason || "任务仍在队列或自动处理链路中。" };
  }
  return { key: "active", group: "active", tone: "info", statusLabel: "已接收", resultLabel: "待处理", reason: reason || "等待下一步状态回写。" };
}

function taskFeedbackSummary(task = {}) {
  const feedback = task.feedback && typeof task.feedback === "object" ? task.feedback : {};
  const status = String(feedback.status || "").trim();
  if (status === "awaiting_user_feedback") {
    const dueLabel = formatTime(feedback.archiveDueAt);
    return {
      label: dueLabel ? `待用户反馈（${dueLabel} 自动归档）` : "待用户反馈",
      closureLabel: "待用户反馈",
      resultReason: "已发送质量反馈卡，等待用户反馈。",
      resultLabel: "任务成功",
      tone: "good",
      actionLabel: "飞书卡待反馈",
      actionDetail: dueLabel ? `${dueLabel} 前可在飞书卡片或管理台反馈` : "可在飞书卡片或管理台反馈",
      canSubmit: true,
      submitted: false,
    };
  }
  if (status === "auto_archived_no_feedback") {
    return {
      label: "用户未反馈",
      closureLabel: "已归档（用户未反馈）",
      resultReason: "超过 6 小时未收到用户反馈，已自动归档。",
      resultLabel: "任务成功",
      tone: "muted",
      actionLabel: "已自动归档",
      actionDetail: "用户未反馈；如需复盘请重新提质量事件",
      canSubmit: false,
      submitted: true,
    };
  }
  if (status === "quality_ok") {
    return {
      label: "质量 OK",
      closureLabel: "已确认",
      resultReason: "用户已确认质量 OK。",
      resultLabel: "任务成功",
      tone: "good",
      actionLabel: "已确认",
      actionDetail: "质量 OK 已记录",
      canSubmit: false,
      submitted: true,
    };
  }
  if (status === "pending_quality_review") {
    return {
      label: "存在问题",
      closureLabel: "待质量复盘",
      resultReason: "用户反馈存在问题，等待质量复盘。",
      resultLabel: "任务成功（待复盘）",
      tone: "warn",
      actionLabel: "待复盘",
      actionDetail: "问题反馈已进入质量复盘",
      canSubmit: false,
      submitted: true,
    };
  }
  if (status === "feedback_card_not_delivered") {
    return {
      label: "反馈卡未送达",
      closureLabel: "可归档（反馈未送达）",
      resultReason: "反馈卡未成功发送，本次可归档。",
      resultLabel: "任务成功",
      tone: "warn",
      actionLabel: "管理台可反馈",
      actionDetail: "飞书反馈卡未送达，可先在这里反馈",
      canSubmit: true,
      submitted: false,
    };
  }
  if (status === "feedback_not_open" || feedback.availability === "unavailable") {
    return {
      label: "反馈未开通",
      closureLabel: "可归档（反馈未开通）",
      resultReason: "回答质量反馈未开通，本次可归档。",
      resultLabel: "任务成功",
      tone: "muted",
      actionLabel: "管理台可反馈",
      actionDetail: "飞书卡未开通，可先在这里反馈",
      canSubmit: true,
      submitted: false,
    };
  }
  return {
    label: "未记录",
    closureLabel: "",
    resultReason: "",
    resultLabel: "",
    tone: "",
    actionLabel: "管理台可反馈",
    actionDetail: "反馈状态未回写，可先在这里反馈",
    canSubmit: true,
    submitted: false,
  };
}

function taskRuntimeEvidence(task = {}) {
  const execution = task.execution && typeof task.execution === "object" ? task.execution : {};
  const processing = Array.isArray(task.materialProcessing) ? task.materialProcessing : [];
  const evidence = task.execution?.agentRuntime && typeof task.execution.agentRuntime === "object"
    ? task.execution.agentRuntime
    : {};
  const processingSummaries = processing.map(processingEvidenceLabel).filter(Boolean);
  const completedProcessing = processing.find((item) => /completed$|_completed$|label_audit_completed/i.test(String(item.status || "")));
  const primarySummary = execution.resultSummary ||
    completedProcessing?.summary ||
    processing.find((item) => item.summary)?.summary ||
    "";
  const hasExecutionEvidence = Boolean(execution.status || execution.mode || execution.resultSummary || processing.length);
  const hasModelEvidence = Boolean(evidence.status || evidence.mode || evidence.adapter || evidence.model || evidence.realModelRequested);
  const hasEvidence = hasExecutionEvidence || hasModelEvidence;
  const requested = evidence.realModelRequested === true;
  const status = String(evidence.status || "").trim();
  const requestCount = Number(evidence.requestCount);
  const toolCallCount = Number(evidence.toolCallCount);
  const toolCalls = Array.isArray(evidence.toolCalls) ? evidence.toolCalls : [];
  const usage = evidence.usage && typeof evidence.usage === "object" ? evidence.usage : {};
  const tokenParts = [
    usage.inputTokens !== null && usage.inputTokens !== undefined && Number.isFinite(Number(usage.inputTokens)) ? `输入 ${usage.inputTokens}` : "",
    usage.outputTokens !== null && usage.outputTokens !== undefined && Number.isFinite(Number(usage.outputTokens)) ? `输出 ${usage.outputTokens}` : "",
    usage.totalTokens !== null && usage.totalTokens !== undefined && Number.isFinite(Number(usage.totalTokens)) ? `总计 ${usage.totalTokens}` : "",
  ].filter(Boolean);
  const toolNames = [...new Set(toolCalls.map((call) => call.name || call.skillId || call.status).filter(Boolean))];
  const { requestLabel, statusLabel } = runtimeModelEvidenceCopy({
    executionStatus: execution.status,
    hasEvidence,
    hasModelEvidence,
    processingRecorded: processingSummaries.length > 0,
    realModelRequested: evidence.realModelRequested,
    requestCount,
    status,
  });
  const toolLabel = Number.isFinite(toolCallCount) && toolCallCount > 0
    ? `${toolCallCount} 次${toolNames.length ? `：${toolNames.join(" / ")}` : ""}`
    : Number.isFinite(toolCallCount) && toolCallCount === 0
      ? "已记录：模型 Tool 调用 0 次"
      : RUNTIME_EVIDENCE_NOT_PROJECTED.tool;
  const modelLabel = [evidence.provider, evidence.model, evidence.reasoningEffort].filter(Boolean).join(" / ") || RUNTIME_EVIDENCE_NOT_PROJECTED.model;
  const adapterLabel = [...new Set([task.runtimeAdapter, evidence.adapter || evidence.mode].filter(Boolean))].join(" / ") || RUNTIME_EVIDENCE_NOT_PROJECTED.adapter;
  const tone = runtimeEvidenceTone({ hasEvidence, requested, status, processingSummaries, execution });
  return {
    hasEvidence,
    tone,
    statusLabel,
    requestLabel,
    modelLabel,
    adapterLabel,
    toolLabel,
    primarySummary,
    processingLabel: processingSummaries.length ? processingSummaries.join("；") : "未记录工具/Skill 结果",
    usageLabel: tokenParts.length ? tokenParts.join(" / ") : hasModelEvidence
      ? "Provider 未返回 token 用量"
      : RUNTIME_EVIDENCE_NOT_PROJECTED.usage,
    blockedReason: evidence.blockedReason || (!hasModelEvidence ? RUNTIME_EVIDENCE_NOT_PROJECTED.blocked : ""),
    searchText: [
      statusLabel,
      requestLabel,
      modelLabel,
      adapterLabel,
      toolLabel,
      primarySummary,
      processingSummaries.join(" "),
      evidence.blockedReason,
    ].filter(Boolean).join(" ").toLowerCase(),
  };
}

function runtimeEvidenceTone({ hasEvidence, requested, status, processingSummaries = [], execution = {} }) {
  if (!hasEvidence) return "muted";
  if (requested) return "good";
  const normalizedStatus = String(status || execution.status || "").toLowerCase();
  if (/failed|error/.test(normalizedStatus)) return "bad";
  if (/blocked|mock|no_model|unavailable|missing/.test(normalizedStatus)) return "warn";
  if (processingSummaries.length || execution.status) return "info";
  return "muted";
}

function processingEvidenceLabel(item = {}) {
  const parts = [
    item.skillId || item.toolId || item.status,
    item.summary,
    datasetEvidenceLabel(item.dataset),
    labelEvidenceLabel(item.labels),
    riskEvidenceLabel(item.riskCounts, item.risks),
  ].filter(Boolean);
  return parts.join("：");
}

function datasetEvidenceLabel(dataset = {}) {
  const imageCount = Number(dataset.imageCount);
  const annotationCount = Number(dataset.annotationCount);
  const labeledCount = Number(dataset.labeledAnnotationCount);
  const fileCount = Number(dataset.fileCount);
  const listCount = Number(dataset.listRowCount);
  const parts = [
    Number.isFinite(imageCount) && imageCount ? `图片 ${imageCount}` : "",
    Number.isFinite(annotationCount) && annotationCount ? `JSON ${annotationCount}` : "",
    Number.isFinite(labeledCount) && labeledCount ? `有标签 ${labeledCount}` : "",
    Number.isFinite(fileCount) && fileCount ? `文件 ${fileCount}` : "",
    Number.isFinite(listCount) && listCount ? `list ${listCount}` : "",
  ].filter(Boolean);
  return parts.length ? parts.join(" / ") : "";
}

function labelEvidenceLabel(labels = []) {
  const items = Array.isArray(labels) ? labels : [];
  if (!items.length) return "";
  return items.slice(0, 4).map((item) => `${item.label || "label"} ${Number(item.count) || 0}`).join(" / ");
}

function riskEvidenceLabel(riskCounts = {}, risks = []) {
  const nonZeroRisks = Object.entries(riskCounts || {})
    .filter(([, value]) => Number(value) > 0)
    .map(([key, value]) => `${key} ${value}`);
  const riskList = Array.isArray(risks) ? risks.filter(Boolean) : [];
  if (nonZeroRisks.length) return `风险：${nonZeroRisks.slice(0, 4).join(" / ")}`;
  if (riskList.length) return `风险：${riskList.slice(0, 4).join(" / ")}`;
  return "风险计数 0";
}

function humanizeReason(value = "") {
  const text = String(value || "").trim();
  if (!text) return "";
  if (/人员审批|待人员审批|真实算法员工执行仍需/.test(text)) {
    return "任务已记录，等待资源和运行器条件满足后自动处理；不需要逐条人工确认。";
  }
  const reasonMap = {
    algorithm_runtime_not_executed: "任务已记录，等待算法运行器接手；当前没有执行 SDK、DVC 或远程命令。",
    feishu_task_accepted: "飞书任务已接收。",
    employee_not_trial_ready: "数字员工还未满足试运行或上线门禁。",
  };
  return reasonMap[text] || text;
}

function notExecutedReasonLabel(status, reason) {
  if (reason) return reason;
  if (status === "raw_unrecognized" || status === "ignored_raw") return "原始消息未识别成可执行任务；只保留安全摘要。";
  if (status === "canceled") return "任务已取消，等待归档。";
  return "权限、范围、资源或质量门禁未通过。";
}

function taskSource(task = {}) {
  const channel = String(task.trigger?.channel || task.sourceSystemId || "").toLowerCase();
  const receiveMode = String(task.trigger?.receiveMode || "").toLowerCase();
  const submittedName = task.submittedBy?.displayName || task.submittedBy?.name || "";
  if (channel === "schedule" || task.sourceSystemId === "digital-workforce-scheduler") {
    return { key: "schedule", label: "系统定时任务", requester: "数字中心" };
  }
  if (channel === "trigger") {
    return { key: "trigger", label: "Trigger", requester: submittedName || "外部系统（Trigger）" };
  }
  if (channel.includes("desktop")) {
    return { key: "desktop", label: "桌面端", requester: submittedName || "姓名待解析" };
  }
  if (channel.includes("feishu")) {
    const chat = task.trigger?.chatType === "group_chat" ? "群聊" : task.trigger?.chatType === "single_user" ? "单聊" : "飞书";
    return {
      key: "feishu",
      label: `飞书${chat === "飞书" ? "" : ` · ${chat}`}`,
      requester: submittedName || "姓名待解析",
    };
  }
  if (channel.includes("management") || receiveMode.includes("manual")) {
    return { key: "management_console", label: "管理台", requester: submittedName || "平台用户" };
  }
  if (channel.includes("api")) return { key: "api", label: "API", requester: submittedName || "服务账号" };
  if (channel.includes("employee")) return { key: "employee", label: "员工间调用", requester: submittedName || "数字员工" };
  return { key: "api", label: "受控入口", requester: submittedName || "姓名待解析" };
}

function taskTimeline(task, outcome, source, feedback, runtimeEvidence) {
  const feedbackTime = task.feedback?.receivedAt || task.feedback?.archivedAt || task.feedback?.deliveredAt;
  const steps = [
    {
      label: "收到任务",
      time: formatTime(task.trigger?.receivedAt || task.submittedAt),
      detail: `${source.label} · ${source.requester}`,
    },
    {
      label: "意图与准入",
      time: formatTime(task.submittedAt),
      detail: `${taskTurnIntentLabel(task.turnIntent, task)} · ${taskResponsePolicyLabel(task.responsePolicy, task)}`,
    },
    {
      label: "进入监控",
      time: formatTime(task.submittedAt),
      detail: task.statusLabel || outcome.statusLabel,
    },
    {
      label: outcome.group === "success" ? "完成" : outcome.group === "failed" ? "失败" : outcome.group === "not_executed" ? "未执行" : "当前状态",
      time: formatTime(task.updatedAt || task.submittedAt),
      detail: task.nextGate || outcome.reason,
    },
  ];
  if (runtimeEvidence?.hasEvidence) {
    steps.splice(2, 0, {
      label: "Agent/模型",
      time: formatTime(task.startedAt || task.execution?.startedAt || task.updatedAt),
      detail: runtimeEvidence.requestLabel,
    });
  }
  if (feedback?.label && feedback.label !== "未记录") {
    steps.push({
      label: "用户反馈",
      time: formatTime(feedbackTime),
      detail: feedback.closureLabel || feedback.label,
    });
  }
  return steps;
}

function closureLabel(outcomeKey) {
  if (outcomeKey === "success") return "待用户确认 / 可归档";
  if (outcomeKey === "failed") return "建议转 badcase";
  if (outcomeKey === "not_executed") return "等待补充或归档";
  return "系统继续处理";
}

function taskTypeLabel(value = "") {
  if (value === "package_intake_analysis") return "文件/资料接入";
  if (value === "conversation_triage") return "对话任务";
  return value || "任务";
}

function taskTurnIntentLabel(value = "", task = {}) {
  if (!value && task.taskType === "digital_employee_chat") return "常规会话";
  if (!value && task.queueLane === "execution_task_v1") return "受控执行任务";
  return {
    social_ping: "社交问候",
    capability_inquiry: "能力咨询",
    task_request: "任务请求",
    material_followup: "材料跟进",
    feedback: "质量反馈",
    unsupported: "不支持的本轮请求",
  }[value] || value || "未记录";
}

function taskResponsePolicyLabel(policy = {}, task = {}) {
  const mode = typeof policy === "string" ? policy : policy?.mode;
  if (!mode && !policy?.id && task.queueLane === "execution_task_v1") return "共享 Agent Runtime";
  return {
    direct_presence: "直接在线回复（零模型）",
    governed_capability_summary: "治理能力摘要（零模型）",
    runtime: "受控 Runtime 回复",
    direct_feedback: "直接反馈确认（零模型）",
    direct_unsupported: "直接澄清（零模型）",
  }[mode] || policy?.id || mode || "未记录";
}

function resourceLabel(value = "") {
  if (value === "algorithm-remote-pool") return "执行设备";
  if (value === "algorithm-object-storage") return "文件资料服务";
  if (value === "algorithm-runner") return "算法运行器";
  return value || "运行资源";
}

function materialLabel(item = {}) {
  return item.name || item.type || item.refMasked || "材料引用";
}

function formatTime(value = "") {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString("zh-CN", { hour12: false });
}
