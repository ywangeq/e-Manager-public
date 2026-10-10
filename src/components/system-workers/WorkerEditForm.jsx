import {
  batchSizeOptions,
  limitedOptions,
  maxParallelWorkersLimit,
  maxWorkersPerEmployeeLimit,
  positiveWorkerNumber,
  providerRouteLabel,
  providerLabel,
  queueWaitNoticeMinuteOptions,
  schedulePresets,
  taskBufferQueueOptions,
  taskTimeoutMinuteOptions,
} from "../../lib/systemWorkers";

export default function WorkerEditForm({
  canEditGlobalConfig = true,
  credentialPolicies,
  departmentScopeInherited = false,
  departmentOptions,
  draft,
  levelOptions,
  modelOptions,
  onChangeModel,
  onChangeProvider,
  onDraftChange,
  onListToggle,
  providerRouteOptions,
  providerOptions,
  requestTypeOptions,
  resourceLimits,
  schedulePreset,
  statusOptions,
  triggerModeOptions,
  workerPoolModeOptions,
}) {
  const showBatchControl = draft.workerRole !== "primary";
  const maxWorkerLimit = canEditGlobalConfig ? maxWorkersPerEmployeeLimit : resourceLimits?.maxWorkersPerEmployee ?? maxWorkersPerEmployeeLimit;
  const maxParallelLimit = canEditGlobalConfig ? maxParallelWorkersLimit : resourceLimits?.maxParallelWorkers ?? maxParallelWorkersLimit;
  const batchSizeLimit = canEditGlobalConfig ? 20 : resourceLimits?.batchSize ?? 20;
  const bufferQueueLimit = canEditGlobalConfig ? 100 : resourceLimits?.taskBufferQueueSize ?? 100;
  const bufferMinuteLimit = canEditGlobalConfig ? 720 : resourceLimits?.taskBufferMinutes ?? 720;
  const executionMinuteLimit = canEditGlobalConfig ? 240 : resourceLimits?.taskExecutionTimeoutMinutes ?? 240;
  const batchOptions = limitedOptions(batchSizeOptions, batchSizeLimit, positiveWorkerNumber(draft.batchSize, 1));
  const bufferQueueOptions = limitedOptions(taskBufferQueueOptions, bufferQueueLimit, positiveWorkerNumber(draft.taskBufferQueueSize, 0, 0));
  const bufferMinuteOptions = limitedOptions(queueWaitNoticeMinuteOptions, bufferMinuteLimit, positiveWorkerNumber(draft.taskBufferMinutes, 240));
  const executionMinuteOptions = limitedOptions(taskTimeoutMinuteOptions, executionMinuteLimit, positiveWorkerNumber(draft.taskExecutionTimeoutMinutes, 60));

  return (
    <div className="worker-edit-panel">
      <div className="worker-edit-grid">
        {canEditGlobalConfig ? (
          <>
            {!departmentScopeInherited ? (
              <label>
                <span>状态</span>
                <select aria-label="状态" value={draft.status} onChange={(event) => onDraftChange({ status: event.target.value })}>
                  {statusOptions.map((status) => (
                    <option key={status} value={status}>{status}</option>
                  ))}
                </select>
              </label>
            ) : null}
            <label>
              <span>触发方式</span>
              <select aria-label="触发方式" value={draft.triggerMode} onChange={(event) => onDraftChange({ triggerMode: event.target.value })}>
                {triggerModeOptions.map((mode) => (
                  <option key={mode} value={mode}>{mode}</option>
                ))}
              </select>
            </label>
            <label>
              <span>调度</span>
              <select
                aria-label="调度"
                value={schedulePreset}
                onChange={(event) => {
                  const value = event.target.value;
                  onDraftChange({ schedule: value === "custom" ? "" : value });
                }}
              >
                {schedulePresets.map((preset) => (
                  <option key={preset.value} value={preset.value}>{preset.label}</option>
                ))}
              </select>
            </label>
            {schedulePreset === "custom" ? (
              <label>
                <span>Cron</span>
                <input
                  aria-label="Cron"
                  value={draft.schedule}
                  onChange={(event) => onDraftChange({ schedule: event.target.value })}
                  placeholder="例如 */15 * * * *"
                />
              </label>
            ) : null}
            <label>
              <span>Provider</span>
              <select aria-label="Provider" value={draft.provider} onChange={(event) => onChangeProvider(event.target.value)}>
                {providerOptions.map((provider) => (
                  <option key={provider} value={provider}>{providerLabel(provider)}</option>
                ))}
              </select>
            </label>
            <label>
              <span>模型</span>
              <select aria-label="模型" value={draft.model} onChange={(event) => onChangeModel(event.target.value)}>
                {modelOptions.map((model) => (
                  <option key={model.id} value={model.model}>{model.model}</option>
                ))}
              </select>
            </label>
            <label>
              <span>Reasoning</span>
              <select aria-label="Reasoning" value={draft.reasoningEffort} onChange={(event) => onDraftChange({ reasoningEffort: event.target.value })}>
                {levelOptions.map((level) => (
                  <option key={level.id} value={level.id}>{level.label}</option>
                ))}
              </select>
            </label>
            <label>
              <span>路由偏好</span>
              <select
                aria-label="路由偏好"
                value={draft.preferredProviderRouteId}
                onChange={(event) => onDraftChange({ preferredProviderRouteId: event.target.value })}
              >
                <option value="">按服务端可用性分配</option>
                {providerRouteOptions.map((route) => (
                  <option key={route.id} value={route.id}>{providerRouteLabel(route)}</option>
                ))}
              </select>
            </label>
            <label>
              <span>资源模式</span>
              <select
                aria-label="资源模式"
                value={draft.workerPoolMode || "runtime_allocated"}
                onChange={(event) => onDraftChange({ workerPoolMode: event.target.value })}
              >
                {workerPoolModeOptions.map((option) => (
                  <option key={option.value} value={option.value}>{option.label}</option>
                ))}
              </select>
            </label>
            <label>
              <span>共享额度</span>
              <select
                aria-label="共享额度"
                value={draft.consumesSharedWorkerQuota === false ? "reserved" : "shared"}
                onChange={(event) => onDraftChange({ consumesSharedWorkerQuota: event.target.value !== "reserved" })}
              >
                <option value="shared">占用共享额度</option>
                <option value="reserved">不占共享额度</option>
              </select>
            </label>
          </>
        ) : null}
        <label>
          <span>Lane 并发</span>
          <input
            aria-label="Lane 并发"
            inputMode="numeric"
            max={maxParallelLimit}
            min="1"
            step="1"
            type="number"
            value={resourceInputValue(draft.maxParallelWorkers, 1, 1, maxParallelLimit)}
            onBlur={(event) => {
              if (event.target.value === "") onDraftChange({ maxParallelWorkers: 1 });
            }}
            onChange={(event) => onDraftChange({ maxParallelWorkers: resourceInputDraftValue(event.target.value, 1, maxParallelLimit) })}
          />
        </label>
        <label>
          <span>员工 Worker 上限</span>
          <input
            aria-label="员工 Worker 上限"
            inputMode="numeric"
            max={maxWorkerLimit}
            min="1"
            step="1"
            type="number"
            value={resourceInputValue(draft.maxWorkersPerEmployee, 1, 1, maxWorkerLimit)}
            onBlur={(event) => {
              if (event.target.value === "") onDraftChange({ maxWorkersPerEmployee: 1 });
            }}
            onChange={(event) => onDraftChange({ maxWorkersPerEmployee: resourceInputDraftValue(event.target.value, 1, maxWorkerLimit) })}
          />
        </label>
        {showBatchControl ? (
          <label>
            <span>单轮取件</span>
            <select aria-label="单轮取件" value={draft.batchSize} onChange={(event) => onDraftChange({ batchSize: Number(event.target.value) })}>
              {batchOptions.map((value) => (
                <option key={value} value={value}>{value} 条</option>
              ))}
            </select>
          </label>
        ) : null}
        <label>
          <span>最大排队数</span>
          <select aria-label="最大排队数" value={draft.taskBufferQueueSize || 0} onChange={(event) => onDraftChange({ taskBufferQueueSize: Number(event.target.value) })}>
            {bufferQueueOptions.map((value) => (
              <option key={value} value={value}>{value} 个任务</option>
            ))}
          </select>
        </label>
        <label>
          <span>排队提醒</span>
          <select aria-label="排队提醒" value={draft.taskBufferMinutes || 240} onChange={(event) => onDraftChange({ taskBufferMinutes: Number(event.target.value) })}>
            {bufferMinuteOptions.map((value) => (
              <option key={value} value={value}>{value} 分钟</option>
            ))}
          </select>
        </label>
        <label>
          <span>Worker 执行预算声明</span>
          <select aria-label="Worker 执行预算声明" value={draft.taskExecutionTimeoutMinutes || 60} onChange={(event) => onDraftChange({ taskExecutionTimeoutMinutes: Number(event.target.value) })}>
            {executionMinuteOptions.map((value) => (
              <option key={value} value={value}>{value} 分钟</option>
            ))}
          </select>
          <small>实际模型、Tool 调用时限及任务总预算在“模型供应商与连接”配置。</small>
        </label>
        {canEditGlobalConfig ? (
          <>
            <label className="worker-edit-wide">
              <span>凭证策略</span>
              <select aria-label="凭证策略" value={draft.credentialPolicy} onChange={(event) => onDraftChange({ credentialPolicy: event.target.value })}>
                {credentialPolicies.map((policy) => (
                  <option key={policy} value={policy}>{policy}</option>
                ))}
              </select>
            </label>
            <label className="worker-edit-wide">
              <span>触发说明</span>
              <textarea aria-label="触发说明" value={draft.triggerPolicy} onChange={(event) => onDraftChange({ triggerPolicy: event.target.value })} rows={2} />
            </label>
            <label className="worker-edit-wide">
              <span>去重签名</span>
              <input aria-label="去重签名" value={draft.dedupeKey} onChange={(event) => onDraftChange({ dedupeKey: event.target.value })} />
            </label>
            <label className="worker-edit-wide">
              <span>输出契约</span>
              <input aria-label="输出契约" value={draft.outputContract} onChange={(event) => onDraftChange({ outputContract: event.target.value })} />
            </label>
            <label className="worker-edit-wide">
              <span>治理说明</span>
              <textarea aria-label="治理说明" value={draft.governance} onChange={(event) => onDraftChange({ governance: event.target.value })} rows={2} />
            </label>
          </>
        ) : null}
      </div>
      {canEditGlobalConfig ? (
        <>
          {departmentScopeInherited ? (
            <div className="gate-line">主 Worker 的状态和部门由数字员工生效配置自动投影；Request 类型在这里保存后会回写同一份数字员工运行配置。</div>
          ) : null}
          <fieldset className="worker-edit-checks">
            <legend>Request 类型</legend>
            {requestTypeOptions.map((type) => (
              <label key={type}>
                <input
                  checked={(draft.assignedRequestTypes || []).includes(type)}
                  onChange={() => onListToggle("assignedRequestTypes", type)}
                  type="checkbox"
                />
                <span>{type}</span>
              </label>
            ))}
          </fieldset>
          {!departmentScopeInherited ? (
            <>
              <fieldset className="worker-edit-checks">
                <legend>可接收 Request 部门</legend>
                {departmentOptions.map((department) => (
                  <label key={department.id}>
                    <input
                      checked={(draft.departmentScope || []).includes(department.id)}
                      onChange={() => onListToggle("departmentScope", department.id)}
                      type="checkbox"
                    />
                    <span>{department.name}</span>
                  </label>
                ))}
              </fieldset>
            </>
          ) : null}
        </>
      ) : null}
    </div>
  );
}

function resourceInputValue(value, fallback, minimum, maximum) {
  if (value === "") return "";
  return Math.min(maximum, positiveWorkerNumber(value, fallback, minimum));
}

function resourceInputDraftValue(value, minimum, maximum) {
  if (value === "") return "";
  const number = Number(value);
  if (!Number.isFinite(number)) return "";
  return Math.min(maximum, Math.max(minimum, Math.floor(number)));
}
