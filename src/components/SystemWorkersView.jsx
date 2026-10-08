import { Edit3, RotateCcw, Save, Settings2, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { aiModelLevels, aiProviderRoutes, digitalEmployees as catalogDigitalEmployees, preReviewWorkers } from "../data/catalog";
import { statusClass } from "../lib/consoleCatalog";
import {
  copyWorker,
  credentialPolicyOptions,
  decideRuntimeConfigRevision,
  workerRequestTypeOptions,
  fetchSystemWorkers,
  formatUpdatedAt,
  levelOptionsForModel,
  maxWorkersPerEmployee,
  modelOptionsForProvider,
  providerLabel,
  resourcePayloadFromDraft,
  routingLabel,
  schedulePresetValue,
  toggleListValue,
  triggerModeOptions,
  updateSystemWorkerConfig,
  workerPoolLabel,
  workerPoolModeOptions,
  workerQuotaLabel,
  workerStatusOptions,
} from "../lib/systemWorkers";
import { SkillChips } from "./ConsolePrimitives";
import MetricCard from "./MetricCard";
import ReviewOutputSpec from "./system-workers/ReviewOutputSpec";
import WorkerDrawerDetailGrid from "./system-workers/WorkerDrawerDetailGrid";
import WorkerEditForm from "./system-workers/WorkerEditForm";

export default function SystemWorkersView({
  employees = catalogDigitalEmployees,
  onRuntimeConfigChange = null,
  session = null,
  workers = preReviewWorkers,
}) {
  const workerKey = workers.map((worker) => worker.id).join("|");
  const [workerDrafts, setWorkerDrafts] = useState(() => workers.map(copyWorker));
  const [providerFilter, setProviderFilter] = useState("all");
  const [statusFilter, setStatusFilter] = useState("all");
  const [employeeFilter, setEmployeeFilter] = useState("all");
  const [selectedWorkerId, setSelectedWorkerId] = useState("");
  const [isSheetOpen, setIsSheetOpen] = useState(false);
  const [editingWorkerId, setEditingWorkerId] = useState(null);
  const [draft, setDraft] = useState(null);
  const [feedback, setFeedback] = useState("正在读取全局 Worker 调度配置。");
  const [runtimeState, setRuntimeState] = useState({ status: "loading", updatedAt: "" });
  const [isSaving, setIsSaving] = useState(false);

  const refreshWorkers = useCallback(async ({ silent = false } = {}) => {
    if (!silent) setRuntimeState((current) => ({ ...current, status: "loading" }));
    try {
      const data = await fetchSystemWorkers();
      if (!editingWorkerId) setWorkerDrafts((data.workers || []).map(copyWorker));
      setRuntimeState({
        status: "ready",
        updatedAt: data.updatedAt || new Date().toISOString(),
        access: data.access || null,
        departmentDirectory: data.departmentDirectory || null,
        pendingRuntimeConfigRevisions: data.pendingRuntimeConfigRevisions || [],
      });
      if (!silent) setFeedback(data.access?.message || "已同步服务端全局 Worker 配置。");
    } catch (error) {
      if (!editingWorkerId) setWorkerDrafts(workers.map(copyWorker));
      setRuntimeState((current) => ({ ...current, status: "error" }));
      if (!silent) setFeedback(error?.message || "全局 Worker 配置读取失败");
    }
  }, [editingWorkerId, workerKey, workers]);

  useEffect(() => {
    refreshWorkers();
    const timer = window.setInterval(() => refreshWorkers({ silent: true }), 15_000);
    return () => window.clearInterval(timer);
  }, [refreshWorkers]);

  useEffect(() => {
    setSelectedWorkerId((current) => current || workerDrafts[0]?.id || "");
  }, [workerDrafts]);

  const employeeById = useMemo(() => new Map(employees.map((employee) => [employee.id, employee])), [employees]);
  const employeeOptions = useMemo(
    () => workerDrafts
      .map((worker) => employeeById.get(worker.ownerEmployeeId))
      .filter(Boolean)
      .filter((employee, index, source) => source.findIndex((item) => item.id === employee.id) === index),
    [employeeById, workerDrafts],
  );
  const providerOptions = useMemo(() => Array.from(new Set(workerDrafts.map((worker) => worker.provider))).sort(), [workerDrafts]);
  const statusOptions = useMemo(() => Array.from(new Set([...workerStatusOptions, ...workerDrafts.map((worker) => worker.status)])).sort(), [workerDrafts]);
  const requestTypeOptions = useMemo(
    () => Array.from(new Set([...workerRequestTypeOptions, ...workerDrafts.flatMap((worker) => worker.assignedRequestTypes || [])])),
    [workerDrafts],
  );
  const filteredWorkers = useMemo(
    () =>
      workerDrafts.filter((worker) => {
        const matchesProvider = providerFilter === "all" || worker.provider === providerFilter;
        const matchesStatus = statusFilter === "all" || worker.status === statusFilter;
        const matchesEmployee = employeeFilter === "all" || worker.ownerEmployeeId === employeeFilter;
        return matchesProvider && matchesStatus && matchesEmployee;
      }),
    [employeeFilter, providerFilter, statusFilter, workerDrafts],
  );
  const selectedWorker = filteredWorkers.find((worker) => worker.id === selectedWorkerId) || filteredWorkers[0] || null;
  const departmentOptions = runtimeState.departmentDirectory?.departments || [];
  const departmentNameById = (departmentId) => departmentOptions.find((department) => department.id === departmentId)?.name || departmentId || "未绑定部门";
  const selectedRuntimeRevision = selectedWorker?.workerRole === "primary"
    ? (runtimeState.pendingRuntimeConfigRevisions || []).find((revision) => revision.employeeId === selectedWorker.ownerEmployeeId)
    : null;

  const scheduledCount = workerDrafts.filter((worker) => worker.schedule && !["event-driven", "manual"].includes(worker.schedule)).length;
  const eventDrivenCount = workerDrafts.filter((worker) => String(worker.schedule || "").includes("event")).length;
  const maxParallelWorkers = workerDrafts.reduce((total, worker) => total + Number(worker.maxParallelWorkers || 0), 0);
  const singleWorkerEmployeeCount = workerDrafts.filter((worker) => maxWorkersPerEmployee(worker) === 1).length;
  const autoWorkerCount = workerDrafts.filter((worker) => worker.resourcePolicy?.generatedFromEmployee || worker.generatedFromEmployee).length;
  const hasActiveFilters = providerFilter !== "all" || statusFilter !== "all" || employeeFilter !== "all";
  const isDepartmentResourceMode = runtimeState.access?.role === "department_admin";
  const sessionScopeLabel = session?.department || session?.governanceRole || "当前会话";

  function resetFilters() {
    setProviderFilter("all");
    setStatusFilter("all");
    setEmployeeFilter("all");
  }

  function openWorkerSheet(worker) {
    setSelectedWorkerId(worker.id);
    setIsSheetOpen(true);
  }

  function closeWorkerSheet() {
    setIsSheetOpen(false);
    setEditingWorkerId(null);
    setDraft(null);
  }

  function startEdit(worker) {
    if (worker.access?.canEdit === false) {
      setFeedback("当前账号只能查看这条 Worker 配置。");
      return;
    }
    setSelectedWorkerId(worker.id);
    setIsSheetOpen(true);
    setEditingWorkerId(worker.id);
    setDraft(copyWorker(worker));
    setFeedback(worker.access?.editMode === "department_resource"
      ? `正在调整 ${worker.name} 的部门资源，保存时不能超过系统分配上限。`
      : `正在编辑 ${worker.name}，保存后会写入服务端 MVP 治理草案。`);
  }

  function updateDraft(patch) {
    setDraft((current) => ({ ...current, ...patch }));
  }

  function updateDraftList(field, value) {
    setDraft((current) => ({ ...current, [field]: toggleListValue(current[field] || [], value) }));
  }

  function changeProvider(provider) {
    const nextModel = modelOptionsForProvider(provider)[0];
    const nextLevels = nextModel ? levelOptionsForModel(nextModel.model) : aiModelLevels;
    updateDraft({
      provider,
      preferredProviderRouteId: "",
      model: nextModel?.model || "",
      reasoningEffort: nextModel?.defaultLevelId || nextLevels[0]?.id || "",
      credentialPolicy: credentialPolicyOptions(provider)[0],
    });
  }

  function changeModel(modelName) {
    const levels = levelOptionsForModel(modelName);
    updateDraft({ model: modelName, reasoningEffort: levels[0]?.id || "" });
  }

  async function saveDraft() {
    if (!draft) return;
    const payload = draft.access?.editMode === "department_resource" ? resourcePayloadFromDraft(draft) : draft;
    setIsSaving(true);
    try {
      const data = await updateSystemWorkerConfig(draft.id, payload);
      setWorkerDrafts((data.workers || []).map(copyWorker));
      setRuntimeState((current) => ({ ...current, status: "ready", updatedAt: data.updatedAt || new Date().toISOString() }));
      setEditingWorkerId(null);
      setDraft(null);
      setFeedback(data.message || `${draft.name} 的全局 Worker 配置已保存。`);
      if (typeof onRuntimeConfigChange === "function") await onRuntimeConfigChange();
    } catch (error) {
      setFeedback(error?.message || "全局 Worker 配置保存失败");
    } finally {
      setIsSaving(false);
    }
  }

  async function decideRuntimeRevision(decision) {
    if (!selectedRuntimeRevision) return;
    setIsSaving(true);
    try {
      const data = await decideRuntimeConfigRevision(
        selectedRuntimeRevision.id,
        decision,
        selectedRuntimeRevision.baseAppliedVersion,
      );
      setFeedback(data.message || "运行配置审核已完成。");
      if (typeof onRuntimeConfigChange === "function") await onRuntimeConfigChange();
      await refreshWorkers({ silent: true });
    } catch (error) {
      setFeedback(error?.message || "运行配置审核失败");
    } finally {
      setIsSaving(false);
    }
  }

  function cancelEdit() {
    setEditingWorkerId(null);
    setDraft(null);
    setFeedback("已取消本次配置修改。");
  }

  return (
    <section className="view-stack">
      <div className="metrics-grid">
        <MetricCard label="Worker Lane" value={workerDrafts.length} detail="按数字员工归属" />
        <MetricCard label="定时补扫" value={scheduledCount} detail="Cron / backfill" />
        <MetricCard label="事件触发" value={eventDrivenCount} detail="request / material arrival" />
        <MetricCard label="最大并行" value={maxParallelWorkers} detail="服务端容量配置" />
        <MetricCard label="自动 Lane" value={autoWorkerCount} detail="在线/试运行员工" />
        <MetricCard label="单 Worker 员工" value={singleWorkerEmployeeCount} detail="按员工上限 1 个" />
      </div>

      <section className="panel">
        <div className="panel-head">
          <div>
            <p className="eyebrow">System Runtime / AI Workers</p>
            <h2>全局 AI Worker 调度</h2>
          </div>
          <span className={`status-pill ${runtimeState.status === "error" ? "warn" : "good"}`}>
            {runtimeState.status === "error" ? "同步失败" : "自动更新 15 秒"}
          </span>
        </div>

        <div className="identity-banner worker-runtime-banner">
          <strong>{isDepartmentResourceMode ? "部门资源边界" : "全局配置边界"}</strong>
          <span>
            {isDepartmentResourceMode
              ? `${sessionScopeLabel} 只能调整本部门已分配 Worker 的并行、缓冲和超时，不能修改模型、路由或触发策略。`
              : "这里是所有 Worker Lane 的总览；主 Worker 与数字员工共用同一份生效运行配置，任一侧已审核变更都会同步。"}
          </span>
          <b>在线/试运行数字员工会自动出现在这里；真实执行、队列和凭证租约仍必须在服务端完成</b>
          <small>
            一级部门：{runtimeState.departmentDirectory?.source === "fortress-v3" ? "Fortress 实时投影" : "Demo 降级目录"}
            {runtimeState.departmentDirectory?.freshness === "stale" ? "（缓存已过期，只读）" : ""}
          </small>
        </div>

        <div className="worker-toolbar" aria-label="AI Worker 筛选">
          <label>
            <span>供应商</span>
            <select value={providerFilter} onChange={(event) => setProviderFilter(event.target.value)}>
              <option value="all">全部供应商</option>
              {providerOptions.map((provider) => (
                <option key={provider} value={provider}>
                  {providerLabel(provider)}
                </option>
              ))}
            </select>
          </label>
          <label>
            <span>状态</span>
            <select value={statusFilter} onChange={(event) => setStatusFilter(event.target.value)}>
              <option value="all">全部状态</option>
              {statusOptions.map((status) => (
                <option key={status} value={status}>
                  {status}
                </option>
              ))}
            </select>
          </label>
          <label>
            <span>数字员工</span>
            <select value={employeeFilter} onChange={(event) => setEmployeeFilter(event.target.value)}>
              <option value="all">全部数字员工</option>
              {employeeOptions.map((employee) => (
                <option key={employee.id} value={employee.id}>{employee.name}</option>
              ))}
            </select>
          </label>
          <button type="button" onClick={resetFilters} disabled={!hasActiveFilters} title="重置筛选" aria-label="重置 Worker 筛选">
            <RotateCcw size={15} />
            重置
          </button>
          <small>{filteredWorkers.length} / {workerDrafts.length}</small>
        </div>

        <p className="worker-edit-feedback" role="status">
          {feedback}{runtimeState.updatedAt ? ` 最近同步：${formatUpdatedAt(runtimeState.updatedAt)}` : ""}
        </p>
        <div className="worker-schedule-workbench">
          <div className="worker-schedule-list" aria-label="全局 Worker 列表">
            <table className="worker-schedule-table">
              <thead>
                <tr>
                  <th>Worker / Lane</th>
                  <th>数字员工</th>
                  <th>来源</th>
                  <th>状态</th>
                  <th>资源 / 超时</th>
                  <th>模型路由</th>
                  <th>权限 / 范围</th>
                  <th>配置</th>
                </tr>
              </thead>
              <tbody>
                {filteredWorkers.map((worker) => {
                  const owner = employeeById.get(worker.ownerEmployeeId);
                  const isActive = selectedWorker?.id === worker.id;
                  const sourceLabel = worker.resourcePolicy?.generatedFromEmployee ? "自动 Lane" : "手动治理";
                  const actionLabel = worker.access?.canEdit === false
                    ? "查看"
                    : worker.access?.editMode === "department_resource" ? "调整" : "配置";
                  return (
                    <tr
                      className={isActive ? "worker-schedule-table-row is-active" : "worker-schedule-table-row"}
                      key={worker.id}
                      onClick={() => setSelectedWorkerId(worker.id)}
                    >
                      <td>
                        <span className="worker-table-primary">
                          <strong>{worker.name}</strong>
                          <small>{worker.lane}</small>
                        </span>
                      </td>
                      <td>
                        <span className="worker-table-primary">
                          <strong>{owner?.name || "待绑定数字员工"}</strong>
                          <small>{owner?.title || worker.ownerEmployeeId || "未配置 owner"}</small>
                        </span>
                      </td>
                      <td>
                        <span className={`worker-source-pill ${worker.resourcePolicy?.generatedFromEmployee ? "auto" : "manual"}`}>
                          {sourceLabel}
                        </span>
                      </td>
                      <td>
                        <span className="worker-status-stack">
                          <span className={`status-pill ${statusClass(worker.status)}`}>{worker.status || "待配置"}</span>
                          <small>{worker.triggerMode || "未配置触发"}</small>
                        </span>
                      </td>
                      <td>
                        <span className="worker-status-stack">
                          <strong>员工 Worker 上限 {maxWorkersPerEmployee(worker)} · Lane 并发 {worker.maxParallelWorkers || 1}</strong>
                          <small>排队 {worker.taskBufferQueueSize || 0} / 提醒 {worker.taskBufferMinutes || 240} 分 / 执行 {worker.taskExecutionTimeoutMinutes || 60} 分</small>
                        </span>
                      </td>
                      <td>
                        <span className="worker-status-stack">
                          <strong>{providerLabel(worker.provider)} · {worker.model || "待模型"}</strong>
                          <small>{worker.reasoningEffort || "未配置"} · {routingLabel(worker)}</small>
                        </span>
                      </td>
                      <td>
                        <span className="worker-status-stack">
                          <strong>{worker.access?.label || "系统管理员"}</strong>
                          <small>{(worker.departmentScope || []).map(departmentNameById).join(" / ") || departmentNameById(worker.resourcePolicy?.ownerDepartmentId)}</small>
                        </span>
                      </td>
                      <td>
                        <button
                          className="worker-row-action"
                          type="button"
                          onClick={(event) => {
                            event.stopPropagation();
                            openWorkerSheet(worker);
                          }}
                        >
                          <Settings2 size={14} />
                          {actionLabel}
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            {!filteredWorkers.length ? <div className="worker-schedule-empty">没有匹配的 Worker。</div> : null}
          </div>

          {selectedWorker && isSheetOpen ? (
            <div className="worker-config-drawer-backdrop" role="presentation" onClick={closeWorkerSheet}>
              <section
                className="worker-config-sheet worker-config-drawer"
                role="dialog"
                aria-modal="true"
                aria-label={`${selectedWorker.name} 配置`}
                onClick={(event) => event.stopPropagation()}
              >
              <div className="worker-config-sheet-head">
                <span>
                  <strong>{selectedWorker.name}</strong>
                  <small>{employeeById.get(selectedWorker.ownerEmployeeId)?.name || "待绑定数字员工"} · {selectedWorker.lane}</small>
                </span>
                <div className="worker-card-actions">
                  {editingWorkerId === selectedWorker.id ? (
                    <>
                      <button type="button" onClick={saveDraft} disabled={isSaving}>
                        <Save size={15} />
                        {isSaving ? "保存中" : "保存配置"}
                      </button>
                      <button type="button" onClick={cancelEdit} disabled={isSaving}>
                        <X size={15} />
                        取消
                      </button>
                    </>
                  ) : (
                    <>
                    <button
                      type="button"
                      onClick={() => startEdit(selectedWorker)}
                      disabled={Boolean(editingWorkerId) || runtimeState.status === "loading" || selectedWorker.access?.canEdit === false}
                    >
                      <Edit3 size={15} />
                      {selectedWorker.access?.editMode === "department_resource" ? "调整资源" : "编辑配置"}
                    </button>
                    <button type="button" onClick={closeWorkerSheet}>
                      <X size={15} />
                      关闭
                    </button>
                    </>
                  )}
                </div>
              </div>
              <WorkerDrawerDetailGrid
                items={[
                  ["数字员工", employeeById.get(selectedWorker.ownerEmployeeId)?.name || selectedWorker.ownerEmployeeId || "待绑定"],
                  ["Lane", selectedWorker.lane],
                  ["触发", selectedWorker.triggerMode],
                  ["Cron", selectedWorker.schedule],
                  ["来源", selectedWorker.resourcePolicy?.generatedFromEmployee ? "在线/试运行数字员工自动生成" : "系统治理配置"],
                  ["Provider", providerLabel(selectedWorker.provider)],
                  ["模型配置", [selectedWorker.model, selectedWorker.reasoningEffort].filter(Boolean).join(" / ")],
                  ["路由偏好", routingLabel(selectedWorker)],
                  ["资源模式", workerPoolLabel(selectedWorker)],
                  ["共享额度", workerQuotaLabel(selectedWorker)],
                  ["员工 Worker 上限", `${maxWorkersPerEmployee(selectedWorker)} 个`],
                  selectedWorker.workerRole === "primary"
                    ? ["Lane 并发", `${selectedWorker.maxParallelWorkers} workers`]
                    : ["Lane 并发 / 单轮取件", `${selectedWorker.maxParallelWorkers} workers / ${selectedWorker.batchSize} 条`],
                  ["最大排队数 / 排队提醒", `${selectedWorker.taskBufferQueueSize || 0} 个任务 / ${selectedWorker.taskBufferMinutes || 240} 分钟`],
                  ["单任务执行超时", `${selectedWorker.taskExecutionTimeoutMinutes || 60} 分钟`],
                  ["编辑权限", selectedWorker.access?.label || "系统管理员"],
                  ["去重签名", selectedWorker.dedupeKey],
                  ["输出契约", selectedWorker.outputContract],
                ]}
              />
              <SkillChips title="Request 类型" items={selectedWorker.assignedRequestTypes} compact />
              <SkillChips
                title={selectedWorker.workerRole === "primary" ? "归属一级部门（自动）" : "可接收 Request 部门"}
                items={(selectedWorker.departmentScope || []).map(departmentNameById)}
                compact
              />
              {selectedRuntimeRevision ? (
                <div className="gate-line">
                  <Settings2 size={16} />
                  <span>{selectedRuntimeRevision.changeSummary || "数字员工运行配置待审核"}</span>
                  {runtimeState.access?.role === "system_admin" ? (
                    <>
                      <button type="button" onClick={() => decideRuntimeRevision("approved")} disabled={isSaving}>通过并应用</button>
                      <button type="button" onClick={() => decideRuntimeRevision("rejected")} disabled={isSaving}>驳回</button>
                    </>
                  ) : <small>待系统管理员审核</small>}
                </div>
              ) : null}
              {selectedWorker.reviewOutputSpec ? <ReviewOutputSpec spec={selectedWorker.reviewOutputSpec} /> : null}
              <div className="gate-line">
                <Settings2 size={16} />
                {selectedWorker.governance}
              </div>
              {editingWorkerId === selectedWorker.id && draft ? (
                <WorkerEditForm
                  canEditGlobalConfig={draft.access?.editMode !== "department_resource"}
                  departmentScopeInherited={draft.workerRole === "primary"}
                  credentialPolicies={credentialPolicyOptions(draft.provider)}
                  departmentOptions={departmentOptions}
                  draft={draft}
                  levelOptions={levelOptionsForModel(draft.model)}
                  modelOptions={modelOptionsForProvider(draft.provider)}
                  providerRouteOptions={aiProviderRoutes.filter((route) => route.provider === draft.provider)}
                  providerOptions={providerOptions}
                  requestTypeOptions={requestTypeOptions}
                  resourceLimits={draft.resourcePolicy?.limits || null}
                  schedulePreset={schedulePresetValue(draft.schedule)}
                  statusOptions={statusOptions}
                  triggerModeOptions={triggerModeOptions}
                  workerPoolModeOptions={workerPoolModeOptions}
                  onChangeModel={changeModel}
                  onChangeProvider={changeProvider}
                  onDraftChange={updateDraft}
                  onListToggle={updateDraftList}
                />
              ) : null}
              </section>
            </div>
          ) : null}
        </div>
      </section>
    </section>
  );
}
